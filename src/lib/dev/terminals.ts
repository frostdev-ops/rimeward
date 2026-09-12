import { terminalEnv } from "./environment.ts";
export { terminalEnv } from "./environment.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import type { Socket } from "node:net";
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
import { processUsage } from './process-usage.ts';
import { terminalIsLog } from './types.ts';
import type { SessionView, SessionResourceView, PermissionMode, TerminalKind } from "./types.ts";

const require = createRequire(import.meta.url);
const MAX_HISTORY = 1024 * 1024;
type Row = {
  id: string;
  user_id: number;
  project: string;
  kind: TerminalKind;
  is_command: number;
  mode: PermissionMode;
  next_mode: PermissionMode | null;
  agent_input: number;
  shell: string;
  title: string;
  state: SessionView["state"];
  exit_code: number | null;
  exit_signal: number | null;
  termination_reason: string | null;
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
  input?: Socket;
  exited: Promise<void>;
  term: Headless;
  serializer: SerializeAddon;
  sequence: number;
  /** Main-buffer rows scrolled off the viewport so far (xterm onScroll, one per row). */
  scrolled: number;
  chunks: { sequence: number; data: string; bytes: number }[];
  head: number;
  bytes: number;
  pending: string[];
  pendingBytes: number;
  queuedBytes: number;
  paused: boolean;
  closing?: boolean;
  terminationReason?: 'cancelled' | 'closed' | 'runtime-shutdown' | 'input-error';
  outputTimer?: ReturnType<typeof setTimeout>;
  flush?: ReturnType<typeof setTimeout>;
  user: number;
  id: string;
}
const live = new Map<string, Live>();
function stopPty(s: Live, reason?: Live['terminationReason']) {
  if (s.closing) return s.exited;
  if (reason) {
    workDb().prepare('UPDATE terminal_sessions SET termination_reason=? WHERE id=?').run(reason, s.id);
    s.terminationReason = reason;
  }
  s.closing = true;
  // Cancel queued Windows input before tearing down its ConPTY pipe.
  s.input?.destroy();
  s.pty.kill();
  // A process that traps SIGHUP would otherwise hold its slot (and its row at "running") forever.
  setTimeout(() => { if (live.get(s.id) === s) try { s.pty.kill("SIGKILL"); } catch {} }, 5000).unref();
  return s.exited;
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
  resume = false,
): string[] {
  if (kind === "shell") return [];
  // The task is the CLI's positional prompt: a leading dash would be parsed as an option and could
  // re-add the bypass flags this mode omits.
  if (/^\s*-/.test(task)) throw new DevError("A task cannot start with '-'.");
  if (kind === "codex")
    return [
      ...(resume ? ["resume"] : []),
      ...(mode === "yolo"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["--ask-for-approval", "on-request", "--sandbox", "workspace-write"]),
      ...(task ? [task] : []),
    ];
  return [
    ...(resume ? ["--resume"] : []),
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
    command: !!r.is_command,
    mode: r.mode,
    nextMode: r.next_mode ?? r.mode,
    agentInput: !!r.agent_input,
    title: r.title,
    state: r.state,
    exitCode: r.exit_code,
    exitSignal: r.exit_signal ?? null,
    terminationReason: r.termination_reason ?? null,
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
  // Retain completed command logs only: interactive sessions are resumable workspaces.
  const expired = workDb().prepare(`SELECT id FROM terminal_sessions WHERE user_id=? AND is_command=1 AND state!='running'
    AND (finished_at < ? OR id NOT IN (SELECT id FROM terminal_sessions WHERE user_id=? AND is_command=1 AND state!='running' ORDER BY finished_at DESC,rowid DESC LIMIT 100))`)
    .all(user, Date.now() - 30 * 86400_000, user) as { id: string }[];
  if (expired.length) {
    workDb().transaction(() => {
      const receipt = workDb().prepare('DELETE FROM task_receipts WHERE session=?');
      const session = workDb().prepare('DELETE FROM terminal_sessions WHERE id=? AND user_id=?');
      for (const { id } of expired) { receipt.run(id); session.run(id, user); }
    })();
    emitDev(user, 'session', '');
  }
  return (
    workDb()
      .prepare(
        // Everything but the snapshot (multi-MB per session): the list never shows it.
        "SELECT id,user_id,project,kind,mode,title,shell,next_mode,human_control,review,state,exit_code,exit_signal,termination_reason,task,assignment,task_state,cols,rows,sequence,agent_input,is_command FROM terminal_sessions WHERE user_id=? AND (? IS NULL OR project=?) ORDER BY rowid DESC",
      )
      .all(user, project ?? null, project ?? null) as Row[]
  ).map(r => view(r));
}
export async function sessionResources(user: number, project?: string, history = false): Promise<{ sessions: SessionResourceView[]; error?: string }> {
  const sessions = listSessions(user, project).filter(s => history || !terminalIsLog(s));
  const pids = sessions.flatMap(s => { const pid = live.get(s.id)?.pty.pid; return pid ? [pid] : []; });
  let error: string | undefined;
  const usage = pids.length ? await processUsage(pids).catch(() => { error = 'Resource usage is temporarily unavailable.'; return new Map(); }) : new Map();
  return { sessions: sessions.map(s => {
    const pid = live.get(s.id)?.pty.pid ?? null;
    return { ...s, pid, cpuPercent: pid ? usage.get(pid)?.cpuPercent ?? null : null, memoryBytes: pid ? usage.get(pid)?.memoryBytes ?? null : null };
  }), ...(error ? { error } : {}) };
}
function persist(s: Live) {
  clearTimeout(s.flush);
  s.flush = undefined;
  // Runs from a timer and from the exit callback: a throw here (disk full, busy database) would
  // be uncaught and take the whole desktop runtime down.
  try {
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
  } catch (e) {
    console.error(`[terminal] snapshot not saved: ${e instanceof Error ? e.message : String(e)}`);
  }
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
    /** A one-shot shell command, only used by the approval-gated terminal_exec tool. */
    command?: string;
    assignment?: string;
    title?: string;
  },
  saved?: Row,
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
  if (opts.command !== undefined && (kind !== "shell" || typeof opts.command !== "string" || !opts.command.trim() || opts.command.length > 16_000))
    throw new DevError("Provide a shell command of at most 16000 characters.");
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
  const id = saved?.id ?? crypto.randomUUID();
  const { cols, rows } = dimensions(opts.cols ?? 100, opts.rows ?? 30);
  const term = new Terminal({
    cols,
    rows,
    scrollback: 10000,
    allowProposedApi: true,
    // Tracks the program's kitty keyboard pushes so a full snapshot can restore them.
    vtExtensions: { kittyKeyboard: true },
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
    args = cliArgs(kind, mode, task, !!saved);
  if (kind === "shell" && process.platform !== "win32") args = ["-l"];
  if (opts.command !== undefined) {
    args = process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-Command", opts.command]
      : ["-lc", opts.command];
  }
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
    if (saved) workDb().prepare("UPDATE terminal_sessions SET state='running',finished_at=NULL,mode=?,next_mode=NULL,exit_code=NULL,exit_signal=NULL,termination_reason=NULL,task='',task_state='active' WHERE id=? AND user_id=?").run(mode, id, user);
    else workDb()
      .prepare(
        "INSERT INTO terminal_sessions(id,user_id,project,kind,mode,title,state,task,assignment,shell,agent_input,cols,rows,is_command) VALUES(?,?,?,?,?,?,'running',?,?,?,?,?,?,?)",
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
        Number(opts.agentInput ?? true),
        cols,
        rows,
        Number(opts.command !== undefined),
      );
  } catch (error) {
    pty.kill();
    term.dispose();
    throw error;
  }
  const restored = saved ? `\x1bc${saved.snapshot}\r\n\x1b[0m\x1b[2m${kind === "shell" ? "Shell restored. Previous commands were not rerun." : "Choose your saved conversation to continue."}\x1b[0m\r\n` : "";
  const restoredBytes = Buffer.byteLength(restored);
  const exited = Promise.withResolvers<void>();
  const s: Live = {
    pty,
    exited: exited.promise,
    term,
    serializer,
    sequence: saved?.sequence ?? 0,
    scrolled: 0,
    chunks: [],
    head: 0,
    bytes: 0,
    pending: restored ? [restored] : [],
    pendingBytes: restoredBytes,
    queuedBytes: restoredBytes,
    paused: false,
    user,
    id,
  };
  live.set(id, s);
  // Main buffer only: the alternate screen keeps no scrollback (its viewport is the content) and fires per line feed.
  term.onScroll(() => { if (term.buffer.active.type === 'normal') s.scrolled++; });
  // node-pty 1.1 exposes errors only from conout; conin otherwise crashes the host.
  // ponytail: pinned private handle; remove when node-pty exposes input errors publicly.
  if (process.platform === "win32") {
    s.input = (pty as IPty & { _agent?: { inSocket?: Socket } })._agent?.inSocket;
    s.input?.on("error", error => {
      console.error("[terminal] Input pipe failed", error);
      if (!s.closing && live.get(id) === s) stopPty(s, 'input-error');
    });
  }
  if (restored) flushOutput(s);
  pty.onData((data) => {
    const bytes = Buffer.byteLength(data);
    s.pending.push(data);
    s.pendingBytes += bytes;
    s.queuedBytes += bytes;
    if (!s.paused && s.queuedBytes >= 256 * 1024) { s.paused = true; pty.pause(); }
    // Leading edge: the first chunk after a quiet gap (a typed echo) goes out
    // at once; whatever follows within 4 ms batches behind it.
    if (s.pendingBytes >= 64 * 1024) flushOutput(s);
    else if (!s.outputTimer) { flushOutput(s); s.outputTimer = setTimeout(() => flushOutput(s), 4); }
  });
  pty.onExit(({ exitCode, signal }) => {
    const exitSignal = typeof signal === 'number' && signal > 0 ? signal : null;
    flushOutput(s);
    term.write("", () => {
      // A cancellation can arrive while xterm drains the final output.
      const reason = s.terminationReason ?? (exitSignal ? 'signal' : null);
      persist(s);
      workDb()
        .prepare(
          "UPDATE terminal_sessions SET state='exited',exit_code=?,exit_signal=?,termination_reason=?,finished_at=?,task_state=CASE WHEN ?='cancelled' THEN 'cancelled' WHEN task_state='active' THEN 'needs-attention' ELSE task_state END WHERE id=?",
        )
        .run(reason ? null : exitCode, exitSignal, reason, Date.now(), reason, id);
      live.delete(id);
      releaseLease(ownerKey(id), leaseOwner(ownerKey(id)) ?? "");
      emitDev(user, "session", id, view(rowOf(user, id)));
      term.dispose();
      // ConPTY's worker can outlive a naturally exited shell; release its handles too.
      if (process.platform === "win32") try { stopPty(s); } catch { /* already closed */ }
      exited.resolve();
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
/** The kitty keyboard stacks the program pushed, as the sequences that rebuild
 *  them: the serialize addon does not carry this mode, and a viewer restored
 *  from a snapshot must keep answering Claude Code / Codex in the encoding they
 *  asked for. Main-screen pushes go before the snapshot, alt-screen ones after
 *  it (by then the snapshot has switched the viewer to the alt screen).
 *  ponytail: pinned private handle; degrades to no prefix if a beta renames it. */
function kittyStacks(term: Headless): { before: string; after: string } {
  const k = (term as Headless & { _core?: { coreService?: { kittyKeyboard?: { flags: number; mainFlags: number; altFlags: number; mainStack: number[]; altStack: number[] } } } })._core?.coreService?.kittyKeyboard;
  if (!k) return { before: "", after: "" };
  // The stack holds the values a push saved (base first); the live flags sit beside it.
  const rebuild = (stack: number[], current: number) => {
    const out = stack.slice(1).map(f => `\x1b[>${f}u`);
    if (stack.length) out.push(`\x1b[>${current}u`); else if (current) out.push(`\x1b[=${current};1u`);
    return out.join("");
  };
  const alt = term.buffer.active.type === "alternate";
  return { before: rebuild(k.mainStack, alt ? k.mainFlags : k.flags), after: alt ? rebuild(k.altStack, k.flags) : "" };
}
/** Rendered rows of the active buffer as plain text: the viewport plus the rows scrolled
 *  above it since `since` (a previous `scrolled` count). `lost` counts main-buffer rows that
 *  scrolled past the 10000 retained; the alternate screen keeps none and is not counted. */
export function renderedLines(user: number, id: string, since?: number): { lines: string[]; scrolled: number; lost: number } {
  rowOf(user, id);
  const s = live.get(id);
  if (!s) return { lines: [], scrolled: 0, lost: 0 };
  const b = s.term.buffer.active, wanted = since === undefined ? 0 : Math.max(0, s.scrolled - since), above = Math.min(b.baseY, wanted);
  return { scrolled: s.scrolled, lost: wanted - above, lines: Array.from({ length: above + s.term.rows }, (_, i) => b.getLine(b.baseY - above + i)?.translateToString(true) ?? "") };
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
        ? kittyStacks(s.term).before + s.serializer.serialize({ scrollback: 10000 }) + kittyStacks(s.term).after
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
// Human clients share their existing lease; Rime may also type when the toggle is on.
function claimInput(row: Row, owner: string, takeover = false) {
  if (!/^(client|agent):[\w:-]{1,113}$/.test(owner)) throw new DevError("Invalid input owner.");
  if (owner.startsWith("agent:") && !row.agent_input)
    throw new DevError('Rime control is off. Turn on "Let Rime control" in this terminal.', 409);
  if (owner.startsWith("agent:")) return;
  const before = leaseOwner(ownerKey(row.id));
  claimLease(ownerKey(row.id), owner, takeover, Infinity);
  if (before !== owner) emitDev(row.user_id, "session", row.id, view(row));
}
function running(user: number, id: string): Live {
  rowOf(user, id);
  const s = live.get(id);
  if (!s || s.closing)
    throw new DevError("This process has ended. Resume the session to continue.", 409);
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
  claimInput(rowOf(user, id), owner);
  s.pty.write("\x03");
}
export function closeSession(user: number, id: string, reason: 'cancelled' | 'closed' = 'closed') {
  rowOf(user, id);
  const s = live.get(id);
  if (!s) return Promise.resolve();
  persist(s);
  return stopPty(s, reason);
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
    if (typeof opts.agentInput !== "boolean") throw new DevError("Invalid Rime control setting.");
    workDb().prepare("UPDATE terminal_sessions SET agent_input=? WHERE id=?").run(Number(opts.agentInput), id);
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
  signal?: AbortSignal,
) {
  rowOf(user, id);
  signal?.throwIfAborted();
  if (live.get(id)?.sequence === after) await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); stop(); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, Math.min(30_000, Math.max(0, ms)));
    const stop = subscribeDev(user, event => { if (event.id === id) done(); });
    signal?.addEventListener('abort', done, { once: true });
  });
  signal?.throwIfAborted();
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
        try { void stopPty(s, 'runtime-shutdown').then(resolve); }
        catch (error) { console.error("[terminal] Failed to stop session during shutdown", error); resolve(); }
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
  if (live.has(id)) return Promise.resolve(view(row));
  if (row.is_command) throw new DevError("Completed commands stay in task history. Open a shell to continue.", 409);
  // Keep the tab and saved screen. Native CLIs choose a saved conversation; never replay a task.
  return startSession(user, {
    project: row.project,
    kind: row.kind,
    mode: row.next_mode ?? row.mode,
    agentInput: !!row.agent_input,
    cols: row.cols,
    rows: row.rows,
    shell: row.shell || undefined,
    title: row.title,
    assignment: row.assignment,
  }, row);
}

export function deleteSession(user: number, id: string) {
  rowOf(user, id);
  if (live.has(id)) throw new DevError("End this session before deleting its saved history.", 409);
  workDb().transaction(() => {
    workDb().prepare("DELETE FROM task_receipts WHERE session=?").run(id);
    workDb().prepare("DELETE FROM terminal_sessions WHERE id=? AND user_id=?").run(id, user);
  })();
  releaseLease(ownerKey(id), leaseOwner(ownerKey(id)) ?? "");
  emitDev(user, "session", id);
}
