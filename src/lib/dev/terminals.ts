import { terminalEnv } from "./environment.ts";
export { terminalEnv } from "./environment.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import type { Terminal as Headless } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import {
  workDb,
  requireDesktop,
  DevError,
  emitDev,
  claimLease,
  leaseOwner,
  releaseLease,
  subscribeDev,
} from "./runtime.ts";
import { projectOf, projectPath } from "./projects.ts";
import type { SessionView, PermissionMode, TerminalKind } from "./types.ts";

const require = createRequire(import.meta.url);
const MAX_HISTORY = 1024 * 1024;
type Row = {
  id: string;
  user_id: number;
  project: string;
  kind: TerminalKind;
  mode: PermissionMode;
  next_mode: PermissionMode | null;
  agent_input: number;
  shell: string;
  title: string;
  state: SessionView["state"];
  exit_code: number | null;
  snapshot: string;
  task: string;
  assignment: string;
  task_state: SessionView["taskState"];
  review: string;
  cols: number;
  rows: number;
  sequence: number;
};
interface Live {
  pty: IPty;
  term: Headless;
  serializer: SerializeAddon;
  sequence: number;
  chunks: { sequence: number; data: string; bytes: number }[];
  head: number;
  bytes: number;
  pending: string[];
  pendingBytes: number;
  queuedBytes: number;
  paused: boolean;
  closing?: boolean;
  outputTimer?: ReturnType<typeof setTimeout>;
  flush?: ReturnType<typeof setTimeout>;
  user: number;
  id: string;
}
const live = new Map<string, Live>();
function stopPty(s: Live) {
  if (s.closing) return;
  s.closing = true;
  s.pty.kill();
}
const ownerKey = (id: string) => `terminal:${id}`;
export function executable(name: string): string | null {
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  const dirs = terminalEnv().PATH.split(path.delimiter);
  dirs.push(
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".cargo", "bin"),
  );
  if (process.platform === "darwin")
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const dir of dirs)
    for (const ext of ["", ...extensions]) {
      const candidate = path.isAbsolute(name)
        ? name
        : path.join(dir, name + ext.toLowerCase());
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  return null;
}
export function terminalCapabilities() {
  requireDesktop();
  return {
    platform: process.platform,
    agents: { codex: !!executable("codex"), claude: !!executable("claude") },
    shells:
      process.platform === "win32"
        ? ["pwsh", "powershell", "cmd", "wsl"].filter((n) => executable(n))
        : [
            process.env.SHELL || os.userInfo().shell || "/bin/sh",
            ...["bash", "zsh", "fish"].filter((n) => executable(n)),
          ],
  };
}
export function cliArgs(
  kind: TerminalKind,
  mode: PermissionMode,
  task = "",
): string[] {
  if (kind === "shell") return [];
  if (kind === "codex")
    return [
      ...(mode === "yolo"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["--ask-for-approval", "on-request", "--sandbox", "workspace-write"]),
      ...(task ? [task] : []),
    ];
  return [
    ...(mode === "yolo"
      ? ["--dangerously-skip-permissions"]
      : ["--permission-mode", "default"]),
    ...(task ? [task] : []),
  ];
}
function rowOf(user: number, id: string): Row {
  const row = workDb()
    .prepare("SELECT * FROM terminal_sessions WHERE id=? AND user_id=?")
    .get(id, user) as Row | undefined;
  if (!row) throw new DevError("Terminal not found.", 404);
  return row;
}
function view(r: Row, inspect = false): SessionView {
  const receipt = inspect ? workDb().prepare("SELECT json FROM task_receipts WHERE session=?").get(r.id) as { json: string } | undefined : undefined;
  const evidence = receipt ? JSON.parse(receipt.json) as NonNullable<SessionView['evidence']> : undefined;
  if (evidence && inspect) evidence.stale = evidence.files.some(file => {
    try {
      const target = projectPath(r.user_id, r.project, file.path, true);
      if (!fs.lstatSync(target, { throwIfNoEntry: false })) return file.hash !== null;
      return fs.statSync(target).size > 5 * 1024 * 1024 || file.hash !== crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    }
    catch { return true; }
  });
  return {
    id: r.id,
    project: r.project,
    kind: r.kind,
    mode: r.mode,
    nextMode: r.next_mode ?? r.mode,
    agentInput: !!r.agent_input,
    title: r.title,
    state: r.state,
    exitCode: r.exit_code,
    owner: leaseOwner(ownerKey(r.id)),
    cols: live.get(r.id)?.term.cols ?? r.cols,
    rows: live.get(r.id)?.term.rows ?? r.rows,
    sequence: live.get(r.id)?.sequence ?? r.sequence,
    task: r.task,
    assignment: r.assignment,
    taskState: r.task_state,
    ...(inspect ? { review: r.review } : {}),
    ...(evidence ? { evidence } : {}),
  };
}
export function listSessions(user: number, project?: string): SessionView[] {
  if (project) projectOf(user, project);
  return (
    workDb()
      .prepare(
        "SELECT * FROM terminal_sessions WHERE user_id=? AND (? IS NULL OR project=?) ORDER BY rowid DESC",
      )
      .all(user, project ?? null, project ?? null) as Row[]
  ).map(r => view(r));
}
function persist(s: Live) {
  clearTimeout(s.flush);
  s.flush = undefined;
  workDb()
    .prepare(
      "UPDATE terminal_sessions SET snapshot=?,sequence=?,cols=?,rows=? WHERE id=? AND user_id=?",
    )
    .run(
      s.serializer.serialize({ scrollback: 10000 }),
      s.sequence,
      s.term.cols,
      s.term.rows,
      s.id,
      s.user,
    );
}
function checkpoint(s: Live) {
  if (s.flush) return;
  s.flush = setTimeout(() => persist(s), 5000);
  s.flush.unref();
}
function flushOutput(s: Live) {
  clearTimeout(s.outputTimer);
  s.outputTimer = undefined;
  if (!s.pending.length) return;
  const data = s.pending.join(""), bytes = s.pendingBytes;
  s.pending = [];
  s.pendingBytes = 0;
  s.term.write(data, () => {
    const sequence = ++s.sequence;
    s.chunks.push({ sequence, data, bytes });
    s.bytes += bytes;
    // Cap metadata too: slow, single-character output must not retain millions of objects.
    while ((s.bytes > MAX_HISTORY || s.chunks.length - s.head > 4096) && s.head < s.chunks.length - 1)
      s.bytes -= s.chunks[s.head++]?.bytes ?? 0;
    if (s.head > 128) { s.chunks = s.chunks.slice(s.head); s.head = 0; }
    emitDev(s.user, "output", s.id, { sequence, data });
    checkpoint(s);
    s.queuedBytes -= bytes;
    if (s.paused && s.queuedBytes < 64 * 1024) {
      s.paused = false;
      s.pty.resume();
    }
  });
}
let cleanupInstalled = false;
export async function startSession(
  user: number,
  opts: {
    project: string;
    kind?: TerminalKind;
    mode?: PermissionMode;
    agentInput?: boolean;
    cols?: number;
    rows?: number;
    shell?: string;
    task?: string;
    assignment?: string;
    title?: string;
  },
): Promise<SessionView> {
  requireDesktop();
  const p = projectOf(user, opts.project),
    kind = opts.kind ?? "shell",
    mode = opts.mode ?? "human";
  if (
    !["shell", "codex", "claude"].includes(kind) ||
    !["human", "rimeward", "yolo"].includes(mode) ||
    (opts.agentInput !== undefined && typeof opts.agentInput !== "boolean")
  )
    throw new DevError("Invalid terminal configuration.");
  if (listSessions(user).filter((s) => s.state === "running").length >= 24)
    throw new DevError(
      "Close a terminal before starting another (24 running).",
      429,
    );
  const shell =
    opts.shell ||
    (process.platform === "win32"
      ? executable("pwsh") || executable("powershell") || "cmd.exe"
      : process.env.SHELL || os.userInfo().shell || "/bin/sh");
  const command = executable(kind === "shell" ? shell : kind);
  if (!command)
    throw new DevError(
      `${kind === "shell" ? shell : kind} is not installed. Install it and sign in locally, then try again.`,
      409,
    );
  const { spawn } = require("node-pty") as typeof import("node-pty");
  const { Terminal } =
    require("@xterm/headless") as typeof import("@xterm/headless");
  const { SerializeAddon } =
    require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");
  const id = crypto.randomUUID();
  const { cols, rows } = dimensions(opts.cols ?? 100, opts.rows ?? 30);
  const term = new Terminal({
    cols,
    rows,
    scrollback: 10000,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  const { Unicode11Addon } = require("@xterm/addon-unicode11") as typeof import("@xterm/addon-unicode11");
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  const task = (opts.task ?? "").slice(0, 8000),
    assignment = (opts.assignment ?? "").slice(0, 2000);
  // argv is passed directly to the executable, never concatenated into a shell command.
  let program = command,
    args = cliArgs(kind, mode, task);
  if (kind === "shell" && process.platform !== "win32") args = ["-l"];
  if (kind !== "shell" && process.platform !== "win32") {
    const script = fs.realpathSync(command);
    if (/\.[cm]?js$/.test(script)) {
      program = process.execPath;
      args = [script, ...args];
    }
  }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const packageFile =
      kind === "codex"
        ? "@openai/codex/bin/codex.js"
        : kind === "claude"
          ? "@anthropic-ai/claude-code/cli.js"
          : "";
    const script =
      packageFile &&
      path.join(path.dirname(command), "node_modules", packageFile);
    if (!script || !fs.existsSync(script))
      throw new DevError(
        "Choose a native executable or the standard npm-installed CLI. This command shim cannot safely accept task arguments.",
        409,
      );
    program = process.execPath;
    args = [script, ...args];
  }
  let pty: IPty;
  try {
    pty = spawn(program, args, {
      name: "xterm-256color",
      cwd: projectPath(user, p.id),
      cols,
      rows,
      env: terminalEnv(),
    });
  } catch (error) { term.dispose(); throw error; }
  try {
    workDb()
      .prepare(
        "INSERT INTO terminal_sessions(id,user_id,project,kind,mode,title,state,task,assignment,shell,agent_input,cols,rows) VALUES(?,?,?,?,?,?,'running',?,?,?,?,?,?)",
      )
      .run(
        id,
        user,
        p.id,
        kind,
        mode,
        (opts.title || kind).slice(0, 100),
        task,
        assignment,
        kind === "shell" ? shell : "",
        Number(opts.agentInput ?? mode !== "human"),
        cols,
        rows,
      );
  } catch (error) {
    pty.kill();
    term.dispose();
    throw error;
  }
  const s: Live = {
    pty,
    term,
    serializer,
    sequence: 0,
    chunks: [],
    head: 0,
    bytes: 0,
    pending: [],
    pendingBytes: 0,
    queuedBytes: 0,
    paused: false,
    user,
    id,
  };
  live.set(id, s);
  pty.onData((data) => {
    const bytes = Buffer.byteLength(data);
    s.pending.push(data);
    s.pendingBytes += bytes;
    s.queuedBytes += bytes;
    if (!s.paused && s.queuedBytes >= 256 * 1024) { s.paused = true; pty.pause(); }
    if (s.pendingBytes >= 64 * 1024) flushOutput(s);
    else s.outputTimer ??= setTimeout(() => flushOutput(s), 8);
  });
  pty.onExit(({ exitCode }) => {
    flushOutput(s);
    term.write("", () => {
      persist(s);
      workDb()
        .prepare(
          "UPDATE terminal_sessions SET state='exited',exit_code=?,task_state=CASE WHEN task_state='active' THEN 'needs-attention' ELSE task_state END WHERE id=?",
        )
        .run(exitCode, id);
      live.delete(id);
      releaseLease(ownerKey(id), leaseOwner(ownerKey(id)) ?? "");
      emitDev(user, "session", id, view(rowOf(user, id)));
      term.dispose();
      // ConPTY's worker can outlive a naturally exited shell; release its handles too.
      if (process.platform === "win32") try { stopPty(s); } catch { /* already closed */ }
    });
  });
  if (!cleanupInstalled) {
    cleanupInstalled = true;
    process.once("SIGTERM", shutdownTerminals);
    process.once("SIGINT", shutdownTerminals);
  }
  emitDev(user, "session", id, view(rowOf(user, id)));
  return view(rowOf(user, id));
}
export function readSession(user: number, id: string, after?: number, review = true) {
  const row = rowOf(user, id),
    s = live.get(id);
  const screen = s
    ? Array.from(
        { length: s.term.rows },
        (_, i) =>
          s.term.buffer.active
            .getLine(s.term.buffer.active.baseY + i)
            ?.translateToString(true) ?? "",
      ).join("\n")
    : "";
  const incremental =
    s &&
    after !== undefined &&
    Number.isInteger(after) &&
    after >= (s.chunks[s.head]?.sequence ?? 1) - 1 &&
    after <= s.sequence;
  return {
    session: view(row, review),
    screen,
    reset: !incremental,
    data: incremental
      ? s.chunks.slice(s.head)
          .filter((c) => c.sequence > (after ?? -1))
          .map((c) => c.data)
          .join("")
      : s
        ? s.serializer.serialize({ scrollback: 10000 })
        : row.snapshot,
  };
}
export function controlSession(
  user: number,
  id: string,
  owner: string,
  takeover = false,
) {
  running(user, id);
  const row = rowOf(user, id);
  claimInput(row, owner, takeover);
  return view(row);
}
// Viewing never claims input. Human ownership survives idle time and reconnects;
// another client can explicitly take it, and agents can never take it from a human.
function claimInput(row: Row, owner: string, takeover = false, interrupt = false) {
  if (owner.startsWith("agent:") && (!row.agent_input && !interrupt))
    throw new DevError("Rime input is off. Enable it in this terminal's session settings.", 409);
  const before = leaseOwner(ownerKey(row.id));
  claimLease(ownerKey(row.id), owner, takeover && owner.startsWith("client:"), owner.startsWith("client:") ? Infinity : 30_000);
  if (before !== owner) emitDev(row.user_id, "session", row.id, view(row));
}
function running(user: number, id: string): Live {
  rowOf(user, id);
  const s = live.get(id);
  if (!s)
    throw new DevError("This process has ended. Start a new session.", 409);
  return s;
}
export function writeSession(
  user: number,
  id: string,
  owner: string,
  data: string,
  binary = false,
) {
  const s = running(user, id),
    row = rowOf(user, id);
  if (Buffer.byteLength(data) > 64 * 1024)
    throw new DevError("Input is too large.");
  claimInput(row, owner);
  s.pty.write(binary ? Buffer.from(data, "latin1") : data);
}
function dimensions(cols: number, rows: number) {
  if (!Number.isFinite(cols) || !Number.isFinite(rows))
    throw new DevError("Invalid terminal dimensions.");
  return { cols: Math.max(20, Math.min(400, Math.floor(cols))), rows: Math.max(5, Math.min(150, Math.floor(rows))) };
}
export function resizeSession(
  user: number,
  id: string,
  owner: string,
  cols: number,
  rows: number,
) {
  const s = running(user, id);
  ({ cols, rows } = dimensions(cols, rows));
  claimInput(rowOf(user, id), owner);
  if (s.term.cols === cols && s.term.rows === rows) return;
  s.pty.resize(cols, rows);
  s.term.resize(cols, rows);
  checkpoint(s);
  emitDev(user, "session", id, view(rowOf(user, id)));
}
export function interruptSession(user: number, id: string, owner: string) {
  const s = running(user, id);
  claimInput(rowOf(user, id), owner, false, true);
  s.pty.write("\x03");
}
export function closeSession(user: number, id: string) {
  const s = running(user, id);
  persist(s);
  stopPty(s);
}
export function configureSession(
  user: number,
  id: string,
  opts: {
    mode?: PermissionMode;
    agentInput?: boolean;
    title?: string;
    taskState?: SessionView["taskState"];
    assignment?: string;
    review?: string;
  },
) {
  rowOf(user, id);
  if (opts.mode && !["human", "rimeward", "yolo"].includes(opts.mode)) throw new DevError("Invalid permission mode.");
  if (opts.taskState && !["active", "needs-attention", "done", "cancelled"].includes(opts.taskState)) throw new DevError("Invalid task state.");
  if (opts.title !== undefined && (typeof opts.title !== "string" || !opts.title.trim() || opts.title.length > 100)) throw new DevError("Enter a session name (up to 100 characters).");
  if (opts.assignment !== undefined && typeof opts.assignment !== "string") throw new DevError("Invalid assignment.");
  if (opts.review !== undefined && typeof opts.review !== "string") throw new DevError("Invalid review.");
  if (opts.agentInput !== undefined) {
    if (typeof opts.agentInput !== "boolean") throw new DevError("Invalid Rime input setting.");
    workDb().prepare("UPDATE terminal_sessions SET agent_input=? WHERE id=?").run(Number(opts.agentInput), id);
    const current = leaseOwner(ownerKey(id));
    if (!opts.agentInput && current?.startsWith("agent:")) releaseLease(ownerKey(id), current);
  }
  if (opts.title !== undefined) {
    workDb().prepare("UPDATE terminal_sessions SET title=? WHERE id=?").run(opts.title.trim(), id);
  }
  if (opts.mode) {
    workDb()
      .prepare("UPDATE terminal_sessions SET next_mode=? WHERE id=?")
      .run(opts.mode, id);
  }
  if (opts.taskState) {
    workDb()
      .prepare("UPDATE terminal_sessions SET task_state=? WHERE id=?")
      .run(opts.taskState, id);
  }
  if (opts.assignment !== undefined)
    workDb()
      .prepare("UPDATE terminal_sessions SET assignment=? WHERE id=?")
      .run(opts.assignment.slice(0, 2000), id);
  if (opts.review)
    workDb()
      .prepare("UPDATE terminal_sessions SET review=? WHERE id=?")
      .run(opts.review.slice(0, 8000), id);
  emitDev(user, "session", id, view(rowOf(user, id)));
  return view(rowOf(user, id));
}
export async function waitSession(
  user: number,
  id: string,
  after: number,
  ms = 20_000,
  review = true,
) {
  rowOf(user, id);
  if (live.get(id)?.sequence === after) await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); stop(); resolve(); };
    const timer = setTimeout(done, Math.min(30_000, Math.max(0, ms)));
    const stop = subscribeDev(user, event => { if (event.id === id) done(); });
  });
  return readSession(user, id, after, review);
}
let stopping: Promise<void> | undefined;
export function shutdownTerminals(): Promise<void> {
  stopping ??= Promise.all([...live.values()].map(s => new Promise<void>(resolve => {
    flushOutput(s);
    // xterm parses asynchronously: snapshot only after every queued write.
    s.term.write("", () => {
      try { persist(s); }
      catch (error) { console.error("[terminal] Failed to save shutdown snapshot", error); }
      finally {
        try { stopPty(s); } catch { /* already exited */ }
        resolve();
      }
    });
  }))).then(() => {});
  return stopping;
}

export function releaseControl(user: number, id: string, owner: string) {
  rowOf(user, id);
  if (leaseOwner(ownerKey(id)) !== owner)
    throw new DevError("Take control before releasing it.", 409);
  releaseLease(ownerKey(id), owner);
  const result = view(rowOf(user, id));
  emitDev(user, "session", id, result);
  return result;
}

export function restartSession(user: number, id: string) {
  const row = rowOf(user, id);
  if (row.state === "running")
    throw new DevError(
      "Terminate this process before starting another with its saved settings.",
      409,
    );
  // A new interface, not a replay of an old task or approval response.
  return startSession(user, {
    project: row.project,
    kind: row.kind,
    mode: row.next_mode ?? row.mode,
    agentInput: !!row.agent_input,
    cols: row.cols,
    rows: row.rows,
    shell: row.shell || undefined,
    title: row.title,
  });
}
