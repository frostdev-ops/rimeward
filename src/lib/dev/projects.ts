import { terminalEnv } from "./environment.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATA_DIR } from "../db.ts";
import {
  workDb,
  DevError,
  emitDev,
  leaseOwner,
  claimLease,
} from "./runtime.ts";
import type { Project, BufferView } from "./types.ts";

const exec = promisify(execFile);
export const MAX_FILE = 5 * 1024 * 1024;
export const hash = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const inside = (root: string, file: string) =>
  file === root ||
  (!path.relative(root, file).startsWith(`..${path.sep}`) &&
    path.relative(root, file) !== ".." &&
    !path.isAbsolute(path.relative(root, file)));
export function projectOf(user: number, id: string): Project {
  const p = workDb()
    .prepare("SELECT id,name,root FROM projects WHERE id=? AND user_id=?")
    .get(id, user) as Project | undefined;
  if (!p) throw new DevError("Project not found.", 404);
  return p;
}
export const listProjects = (user: number): Project[] =>
  workDb()
    .prepare(
      "SELECT id,name,root FROM projects WHERE user_id=? AND archived=0 ORDER BY name",
    )
    .all(user) as Project[];
export const defaultProjectParent = () => path.join(os.homedir(), "Projects");
export function createProject(
  user: number,
  parent: string,
  name: string,
): Project {
  workDb(); // Enforce desktop execution before creating anything on disk.
  name = name.trim();
  if (
    !name ||
    name.length > 100 ||
    /[<>:"/\\|?*]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(name) ||
    name === "." ||
    name === ".."
  )
    throw new DevError(
      "Use a project name without path separators or reserved characters.",
    );
  if (!path.isAbsolute(parent))
    throw new DevError("Choose an absolute parent folder.");
  if (parent === defaultProjectParent() && !fs.existsSync(parent))
    fs.mkdirSync(parent);
  let real: string;
  try {
    real = fs.realpathSync(parent);
  } catch {
    throw new DevError(
      "The parent folder does not exist. Choose another folder.",
    );
  }
  const root = path.join(real, name);
  if (!fs.statSync(real).isDirectory() || inside(fs.realpathSync(DATA_DIR), root))
    throw new DevError("Choose a folder outside Rimeward application data.");
  if (fs.existsSync(root))
    throw new DevError(
      "That folder already exists. Open it as an existing project instead.",
      409,
    );
  fs.mkdirSync(root);
  return addProject(user, root, name);
}
export function addProject(user: number, root: string, name?: string): Project {
  if (!path.isAbsolute(root))
    throw new DevError("Choose an absolute project folder.");
  const real = fs.realpathSync(root);
  if (!fs.statSync(real).isDirectory() || inside(fs.realpathSync(DATA_DIR), real))
    throw new DevError("Choose a project outside Rimeward application data.");
  const db = workDb();
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT OR IGNORE INTO projects(id,user_id,name,root) VALUES(?,?,?,?)",
  ).run(id, user, (name?.trim() || path.basename(real)).slice(0, 100), real);
  const p = db
    .prepare("SELECT id,name,root FROM projects WHERE user_id=? AND root=?")
    .get(user, real) as Project;
  db.prepare("UPDATE projects SET archived=0 WHERE id=?").run(p.id);
  emitDev(user, "project", p.id);
  return p;
}
export function projectPath(
  user: number,
  id: string,
  relative = "",
  create = false,
): string {
  const p = projectOf(user, id);
  if (
    relative.includes("\0") ||
    relative.includes("\\") ||
    (process.platform === "win32" && relative.includes(":")) || // drive-relative and stream aliases
    path.isAbsolute(relative) ||
    // .git is never a project file: its config and hooks execute on the next status/diff/worktree call.
    relative.split("/").some((s) => s === ".." || s.toLowerCase() === ".git")
  )
    throw new DevError("Path is outside the project.", 403);
  const target = path.resolve(p.root, relative);
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch (err) {
    if (!create || (err as NodeJS.ErrnoException).code !== "ENOENT")
      throw new DevError("File not found.", 404);
    let ancestor = path.dirname(target);
    while (!fs.existsSync(ancestor)) {
      if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink())
        throw new DevError("Unresolvable project symlink.", 403);
      const next = path.dirname(ancestor);
      if (next === ancestor) throw new DevError("File not found.", 404);
      ancestor = next;
    }
    real = path.resolve(
      fs.realpathSync(ancestor),
      path.relative(ancestor, target),
    );
  }
  if (!inside(p.root, real) || inside(fs.realpathSync(DATA_DIR), real) ||
      path.relative(p.root, real).split(path.sep).some(s => s.toLowerCase() === ".git"))
    throw new DevError("Path is outside the approved project.", 403);
  return real;
}
export function tree(user: number, project: string, dir = "") {
  const base = projectPath(user, project, dir);
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.name !== ".git")
    .map((e) => {
      const relative = path.posix.join(dir, e.name);
      try {
        const file = projectPath(user, project, relative);
        const st = fs.statSync(file);
        return {
          name: e.name,
          path: relative,
          directory: st.isDirectory(),
          bytes: st.size,
        };
      } catch {
        return null;
      }
    })
    .filter((e) => e !== null)
    .sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name),
    );
}
export function createFile(
  user: number,
  project: string,
  file: string,
  directory = false,
): void {
  const target = projectPath(user, project, file, true);
  if (directory) fs.mkdirSync(target);
  else fs.writeFileSync(target, "", { flag: "wx" });
  emitDev(user, "project", project);
}
export function renameFile(
  user: number,
  project: string,
  from: string,
  to: string,
): void {
  const source = projectPath(user, project, from);
  const lexical = path.resolve(projectOf(user, project).root, from);
  const link = fs.lstatSync(lexical).isSymbolicLink();
  const sourceKey = path
    .relative(projectOf(user, project).root, source)
    .split(path.sep)
    .join("/");
  const dest = projectPath(user, project, to, true);
  if (source === projectOf(user, project).root || fs.existsSync(dest))
    throw new DevError("Destination exists or source is the project root.");
  const dirty = workDb()
    .prepare(
      "SELECT path FROM buffers WHERE user_id=? AND project=? AND dirty=1",
    )
    .all(user, project) as { path: string }[];
  if (
    !link &&
    dirty.some(
      (b) => b.path === sourceKey || b.path.startsWith(`${sourceKey}/`),
    )
  )
    throw new DevError("Save open changes before renaming.", 409);
  fs.renameSync(link ? lexical : source, dest);
  const rows = workDb()
    .prepare("SELECT path FROM buffers WHERE user_id=? AND project=?")
    .all(user, project) as { path: string }[];
  for (const row of rows)
    if (
      !link &&
      (row.path === sourceKey || row.path.startsWith(`${sourceKey}/`))
    )
      workDb()
        .prepare("DELETE FROM buffers WHERE user_id=? AND project=? AND path=?")
        .run(user, project, row.path);
  emitDev(user, "project", project);
}
/** ponytail: offset continuation rescans earlier entries; use an index if large-repo latency matters. */
export async function searchPage(user: number, project: string, query: string, scope = "", cursor = 0, includeIgnored = false) {
  const matches: { path: string; line: number; text: string }[] = [];
  if (!query.trim() || query.length > 200) return { matches, complete: true, scanned: 0 };
  cursor = Math.max(0, Math.floor(Number(cursor)) || 0);
  const root = projectPath(user, project, scope);
  const indexed = !includeIgnored && fs.statSync(root).isDirectory() &&
    (await git(user, project, ['rev-parse', '--is-inside-work-tree']).catch(() => '')).trim() === 'true';
  const pending = indexed ? [...new Set((await git(user, project,
    ['--literal-pathspecs', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', scope || '.']))
    .split('\0').filter(Boolean))].reverse() : [scope];
  const seen = new Set<string>();
  let position = 0, scanned = 0, size = 0;
  const needle = query.toLowerCase();
  const searchScope = { path: scope || '.', source: indexed ? 'git-working-tree' : 'filesystem', includeIgnored };
  const hint = "Continue with cursor until complete; coverage assumes unchanged files. Content search excludes binary files and files over 5 MiB. " +
    (indexed ? "Git-tracked and non-ignored untracked files only; nested checkouts are not traversed. Use includeIgnored:true with an explicit path to inspect excluded files." :
      includeIgnored ? "Ignored files and nested checkouts are included under the selected path." : "Hidden, dependency/build directories and nested checkouts are excluded; an explicit path or includeIgnored:true opts in.");
  while (pending.length) {
    const relative = pending.pop();
    if (relative === undefined) break;
    let real: string;
    try { real = projectPath(user, project, relative); }
    catch (error) { if (indexed && error instanceof DevError && [403, 404].includes(error.status)) continue; throw error; }
    if (seen.has(real)) continue;
    seen.add(real);
    const st = fs.statSync(real);
    if (st.isDirectory()) {
      if (indexed || (!includeIgnored && relative !== scope && fs.existsSync(path.join(real, '.git')))) continue;
      if (position++ >= cursor && scanned++ >= 10_000)
        return { matches, complete: false, next: position - 1, scanned, hint, scope: searchScope };
      const entries = tree(user, project, relative);
      for (const entry of entries.reverse())
        if (!entry.directory || includeIgnored || (!entry.name.startsWith('.') && !["node_modules", "dist", "target"].includes(entry.name))) pending.push(entry.path);
      await new Promise<void>(resolve => setImmediate(resolve));
      continue;
    }
    if (!st.isFile()) continue;
    const lines = st.size <= MAX_FILE ? decode(fs.readFileSync(real)) : null;
    const candidates = [path.basename(relative), ...(lines && !lines.readonly ? lines.text.split("\n") : [])];
    for (let i = 0; i < candidates.length; i++) {
      if (position++ < cursor) continue;
      const text = candidates[i] ?? "";
      const hit = (i === 0 ? relative : text).toLowerCase().includes(needle);
      const match = { path: relative, line: Math.max(1, i), text: text.slice(0, 300) };
      const bytes = hit ? JSON.stringify(match).length + 1 : 0;
      if (scanned >= 10_000 || size + bytes > 9000)
        return { matches, complete: false, next: position - 1, scanned, hint, scope: searchScope };
      scanned++; size += bytes;
      if (hit) matches.push(match);
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { matches, complete: true, scanned, hint, scope: searchScope };
}
export async function searchFiles(user: number, project: string, query: string) {
  const matches: Awaited<ReturnType<typeof searchPage>>["matches"] = [];
  let cursor: number | undefined = 0;
  do {
    const page = await searchPage(user, project, query, "", cursor);
    matches.push(...page.matches);
    cursor = page.next;
  } while (cursor !== undefined && matches.length < 200);
  return matches.slice(0, 200);
}
export function treePage(user: number, project: string, dir = "", cursor = 0) {
  const all = tree(user, project, dir);
  const entries: ReturnType<typeof tree> = [];
  let next = Math.max(0, Math.floor(Number(cursor)) || 0), size = 0;
  while (next < all.length) {
    const entry = all[next];
    if (!entry) break;
    const bytes = JSON.stringify(entry).length + 1;
    if (size + bytes > 9000) {
      if (!entries.length) throw new DevError("Directory entry exceeds the tool page size.");
      break;
    }
    entries.push(entry); size += bytes; next++;
  }
  return { entries, snapshot: hash(Buffer.from(JSON.stringify(all))), total: all.length, complete: next >= all.length, ...(next < all.length ? { next } : {}) };
}

export function decode(raw: Buffer) {
  let encoding = "utf8",
    bytes = raw;
  if (raw.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) {
    encoding = "utf8-bom";
    bytes = raw.subarray(3);
  } else if (raw.subarray(0, 2).equals(Buffer.from([255, 254]))) {
    encoding = "utf16le";
    bytes = raw.subarray(2);
  } else if (raw.subarray(0, 2).equals(Buffer.from([254, 255]))) {
    encoding = "utf16be";
    bytes = Buffer.from(raw.subarray(2));
    if (bytes.length % 2)
      return {
        text: "Unsupported encoding.",
        encoding,
        newline: "\n",
        readonly: true,
      };
    bytes.swap16();
  }
  if (encoding.startsWith("utf16") && bytes.length % 2)
    return {
      text: "Unsupported encoding.",
      encoding,
      newline: "\n",
      readonly: true,
    };
  let text = bytes.toString(encoding.startsWith("utf16") ? "utf16le" : "utf8");
  const readonly =
    raw.length > MAX_FILE || text.includes("\0") || text.includes("\ufffd");
  const crlf = text.includes("\r\n"),
    lf = /(?<!\r)\n/.test(text),
    cr = /\r(?!\n)/.test(text);
  const mixed = Number(crlf) + Number(lf) + Number(cr) > 1;
  const newline = crlf ? "\r\n" : cr ? "\r" : "\n";
  text = readonly
    ? "Binary, unsupported encoding, or file larger than 5 MiB. Open it with an external tool."
    : text.replace(/\r\n?|\n/g, "\n");
  return { text, encoding, newline, readonly: readonly || mixed };
}
export function encode(text: string, encoding: string, newline: string): Buffer {
  const normalized = text.replace(/\r\n?|\n/g, "\n").replace(/\n/g, newline);
  if (encoding.startsWith("utf16")) {
    const b = Buffer.from(normalized, "utf16le");
    return Buffer.concat([
      Buffer.from(encoding === "utf16be" ? [254, 255] : [255, 254]),
      encoding === "utf16be" ? b.swap16() : b,
    ]);
  }
  return Buffer.concat([
    encoding === "utf8-bom" ? Buffer.from([239, 187, 191]) : Buffer.alloc(0),
    Buffer.from(normalized),
  ]);
}
export interface BufferRow {
  text: string;
  base_hash: string;
  revision: number;
  dirty: number;
  encoding: string;
  newline: string;
  readonly: number;
}
export const bufferKey = (u: number, p: string, f: string) => `buffer:${u}:${p}:${f}`;
export function readBuffer(
  user: number,
  project: string,
  file: string,
): BufferView {
  const target = projectPath(user, project, file, true);
  file = path
    .relative(projectOf(user, project).root, target)
    .split(path.sep)
    .join("/");
  if (!fs.existsSync(target)) {
    const recovery = workDb()
      .prepare("SELECT * FROM buffers WHERE user_id=? AND project=? AND path=?")
      .get(user, project, file) as BufferRow | undefined;
    if (!recovery) throw new DevError("File not found.", 404);
    return {
      project,
      path: file,
      text: recovery.text,
      revision: recovery.revision,
      dirty: !!recovery.dirty,
      readonly: !recovery.dirty,
      conflict: !!recovery.dirty,
      diskText: "",
      owner: leaseOwner(bufferKey(user, project, file)),
    };
  }
  if (!fs.statSync(target).isFile()) throw new DevError("Not a file.");
  const db = workDb();
  const size = fs.statSync(target).size;
  if (size > MAX_FILE) {
    const recovery = db
      .prepare(
        "SELECT * FROM buffers WHERE user_id=? AND project=? AND path=? AND dirty=1",
      )
      .get(user, project, file) as BufferRow | undefined;
    return {
      project,
      path: file,
      text:
        recovery?.text ??
        "File larger than 5 MiB. Open it with an external tool.",
      revision: recovery?.revision ?? 0,
      dirty: !!recovery,
      readonly: true,
      conflict: !!recovery,
      ...(recovery
        ? {
            diskText:
              "The disk file now exceeds 5 MiB. Your unsaved version is retained; use an external tool to compare the disk file.",
          }
        : {}),
      owner: null,
    };
  }
  const raw = fs.readFileSync(target),
    digest = hash(raw),
    d = decode(raw);
  let row = db
    .prepare("SELECT * FROM buffers WHERE user_id=? AND project=? AND path=?")
    .get(user, project, file) as BufferRow | undefined;
  if (!row) {
    db.prepare(
      "INSERT INTO buffers(user_id,project,path,text,base_hash,encoding,newline,readonly) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      user,
      project,
      file,
      d.text,
      digest,
      d.encoding,
      d.newline,
      Number(d.readonly),
    );
  } else if (!row.dirty && row.base_hash !== digest) {
    db.prepare(
      "UPDATE buffers SET text=?,base_hash=?,encoding=?,newline=?,readonly=?,revision=revision+1 WHERE user_id=? AND project=? AND path=?",
    ).run(
      d.text,
      digest,
      d.encoding,
      d.newline,
      Number(d.readonly),
      user,
      project,
      file,
    );
    emitDev(user, "buffer", project, { path: file });
  }
  row = db
    .prepare("SELECT * FROM buffers WHERE user_id=? AND project=? AND path=?")
    .get(user, project, file) as BufferRow;
  const conflict = !!row.dirty && row.base_hash !== digest;
  return {
    project,
    path: file,
    text: row.text,
    revision: row.revision,
    encoding: row.encoding,
    newline: row.newline,
    dirty: !!row.dirty,
    readonly: !!row.readonly || d.readonly,
    conflict,
    ...(conflict ? { diskText: d.text } : {}),
    owner: leaseOwner(bufferKey(user, project, file)),
  };
}
/** A tool result is capped at 12k chars (core.ts OUTPUT_CAP): a whole file
 *  over that is an error the model can do nothing with. So a read is a page —
 *  `from` (1-based line) and `lines`, defaulting to as many lines as fit — and
 *  says where the next page starts. */
export const FILE_PAGE_CHARS = 9_000;
export function readPage(
  user: number,
  project: string,
  file: string,
  from?: unknown,
  lines?: unknown,
  column?: unknown,
  version: unknown = "buffer",
): BufferView & { from: number; to: number; lines: number; next?: number; nextColumn?: number; version: string } {
  const { diskText, ...view } = readBuffer(user, project, file);
  const all = (version === "disk" ? diskText ?? view.text : view.text).split("\n");
  const start = Math.min(all.length, Math.max(1, Math.floor(Number(from)) || 1));
  const offset = Math.min((all[start - 1]?.length ?? 0), Math.max(0, Math.floor(Number(column)) || 0));
  const want = Math.floor(Number(lines)) > 0 ? Math.floor(Number(lines)) : all.length;
  const out: string[] = [];
  let nextColumn: number | undefined;
  for (let i = start - 1; i < all.length && out.length < want; i++) {
    const line = (all[i] ?? "").slice(i === start - 1 ? offset : 0);
    if (JSON.stringify([...out, line].join("\n")).length > FILE_PAGE_CHARS) {
      if (out.length) break;
      let part = line;
      while (JSON.stringify(part).length > FILE_PAGE_CHARS)
        part = part.slice(0, Math.max(1, Math.floor(part.length * FILE_PAGE_CHARS / JSON.stringify(part).length) - 16));
      out.push(part);
      nextColumn = offset + part.length;
      break;
    }
    out.push(line);
  }
  const to = start - 1 + out.length;
  return { ...view, text: out.join("\n"), from: start, to, lines: all.length,
    version: version === "disk" ? "disk" : "buffer",
    ...(nextColumn !== undefined ? { next: start, nextColumn } : to < all.length ? { next: to + 1 } : {}),
  };
}
export function editBuffer(
  user: number,
  project: string,
  file: string,
  owner: string,
  opts: {
    text?: string;
    revision?: number;
    takeover?: boolean;
    save?: boolean;
    resolve?: "disk" | "mine";
  },
): BufferView {
  if (
    opts.resolve !== undefined &&
    !(["disk", "mine"] as unknown[]).includes(opts.resolve)
  )
    throw new DevError("Invalid conflict resolution.");
  if (
    opts.text !== undefined &&
    (typeof opts.text !== "string" || !Number.isInteger(opts.revision))
  )
    throw new DevError("Editing requires the current buffer revision.", 409);
  const view = readBuffer(user, project, file);
  file = view.path;
  if (view.readonly) throw new DevError("This file is read-only.");
  // Revision first: a stale takeover must not steal the lease and then fail.
  if (opts.revision !== undefined && opts.revision !== view.revision)
    throw new DevError("The buffer changed. Reload before editing.", 409);
  claimLease(bufferKey(user, project, file), owner, opts.takeover);
  const db = workDb();
  if (opts.text !== undefined) {
    if (Buffer.byteLength(opts.text) > MAX_FILE)
      throw new DevError("Buffer exceeds 5 MiB.");
    db.prepare(
      "UPDATE buffers SET text=?,dirty=1,revision=revision+1 WHERE user_id=? AND project=? AND path=?",
    ).run(opts.text, user, project, file);
  }
  if (opts.save || opts.resolve) {
    const current = readBuffer(user, project, file);
    if (current.conflict && !opts.resolve)
      throw new DevError(
        "The file changed on disk. Compare and resolve before saving.",
        409,
      );
    const row = db
      .prepare("SELECT * FROM buffers WHERE user_id=? AND project=? AND path=?")
      .get(user, project, file) as BufferRow;
    if (opts.resolve)
      db.prepare(
        "INSERT INTO buffer_copies(user_id,project,path,text) VALUES(?,?,?,?)",
      ).run(
        user,
        project,
        file,
        opts.resolve === "disk" ? row.text : (current.diskText ?? ""),
      );
    const target = projectPath(user, project, file, true);
    if (opts.resolve === "disk") {
      const raw = fs.existsSync(target)
          ? fs.readFileSync(target)
          : Buffer.alloc(0),
        d = decode(raw);
      db.prepare(
        "UPDATE buffers SET text=?,base_hash=?,dirty=0,revision=revision+1,encoding=?,newline=?,readonly=? WHERE user_id=? AND project=? AND path=?",
      ).run(
        d.text,
        hash(raw),
        d.encoding,
        d.newline,
        Number(d.readonly),
        user,
        project,
        file,
      );
    } else {
      if (fs.existsSync(target))
        db.prepare(
          "INSERT INTO buffer_copies(user_id,project,path,text) VALUES(?,?,?,?)",
        ).run(user, project, file, decode(fs.readFileSync(target)).text);
      const bytes = encode(row.text, row.encoding, row.newline);
      const tmp = `${target}.rimeward-${crypto.randomBytes(6).toString("hex")}`;
      try {
        fs.writeFileSync(tmp, bytes, {
          flag: "wx",
          mode: fs.existsSync(target) ? fs.statSync(target).mode : 0o600,
        });
        fs.renameSync(tmp, target);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      db.prepare(
        "UPDATE buffers SET base_hash=?,dirty=0,revision=revision+1 WHERE user_id=? AND project=? AND path=?",
      ).run(hash(bytes), user, project, file);
    }
  }
  emitDev(user, "buffer", project, { path: file });
  return readBuffer(user, project, file);
}
export function bufferCopies(user: number, project: string, file: string) {
  projectOf(user, project);
  return workDb()
    .prepare(
      "SELECT id,text,saved_at FROM buffer_copies WHERE user_id=? AND project=? AND path=? ORDER BY id DESC LIMIT 20",
    )
    .all(user, project, file) as { id: number; text: string; saved_at: string }[];
}
export function keepBufferCopy(user: number, project: string, file: string, text: unknown) {
  const current = readBuffer(user, project, file);
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_FILE)
    throw new DevError("Recovery copy exceeds 5 MiB.");
  workDb().prepare("INSERT INTO buffer_copies(user_id,project,path,text) VALUES(?,?,?,?)")
    .run(user, project, current.path, text);
  return { ok: true };
}
const gitQueues = new Map<string, Promise<unknown>>();
export async function git(
  user: number,
  project: string,
  args: string[],
): Promise<string> {
  // Managed Git operations disable repository hooks and fsmonitor.
  const { stdout } = await exec("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: projectPath(user, project),
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...terminalEnv(), GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}
/** Tool reads have a serialized budget; the Changes ward receives the full diff. */
export const DIFF_CAP = 9_000;
export async function gitView(user: number, project: string, file?: string, limit = Number.POSITIVE_INFINITY, cursor = 0) {
  // Validated like every other path, then handed to git relative and after
  // `--`, so it can neither leave the tree nor read as an option.
  const scope = file
    ? [
        path
          .relative(projectOf(user, project).root, projectPath(user, project, file, true))
          .split(path.sep)
          .join("/"),
      ]
    : [];
  const base = await git(user, project, ["rev-parse", "--verify", "HEAD"]).then(() => "HEAD", () => "--cached");
  // Only an unborn HEAD uses the staged diff. Output limits/errors must not silently drop working changes.
  const diff = await git(user, project, ["--literal-pathspecs", "diff", "--no-ext-diff", base, "--", ...scope]);
  const result = {
    status: await git(user, project, ["status", "--short"]),
    diff,
    worktrees: await git(user, project, ["worktree", "list", "--porcelain"]),
  };
  const offsets = { diff: 0, status: 0, worktrees: 0 };
  const full = { ...result };
  let skip = Math.max(0, Math.floor(Number(cursor)) || 0);
  // A single offset walks status, diff, then worktrees; every character remains retrievable.
  let remaining = Math.max(512, limit) - 256;
  for (const field of ["status", "diff", "worktrees"] as const) {
    const start = Math.min(skip, full[field].length);
    skip -= start;
    let part = full[field].slice(start);
    while (JSON.stringify(part).length > remaining && part.length)
      part = part.slice(0, Math.max(0, Math.floor(part.length * Math.max(0, remaining) / JSON.stringify(part).length) - 1));
    result[field] = part;
    offsets[field] = start;
    remaining -= JSON.stringify(part).length;
    if (start + part.length < full[field].length) remaining = 0;
  }
  const consumed = Object.values(result).reduce((n, text) => n + text.length, 0);
  const total = Object.values(full).reduce((n, text) => n + text.length, 0);
  const next = Math.max(0, Math.floor(Number(cursor)) || 0) + consumed;
  const truncated = next < total;
  return { ...result, offsets, snapshot: hash(Buffer.from(JSON.stringify(full))), complete: !truncated,
    ...(truncated ? { truncated: true, next, hint: "Continue with cursor. Restart if snapshot changes; status is complete only after all pages." } : {}) };

}
export async function worktreeOp(
  user: number,
  project: string,
  op: "add" | "remove",
  name: string,
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,70}$/.test(name))
    throw new DevError("Use a simple worktree name.");
  const p = projectOf(user, project),
    key = (
      await git(user, project, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).trim();
  const run = (gitQueues.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const dir = path.join(
        path.dirname(p.root),
        ".rimeward-worktrees",
        path.basename(p.root),
        name,
      );
      if (op === "add") {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await git(user, project, [
          "worktree",
          "add",
          "-b",
          `rimeward/${name}`,
          dir,
        ]);
        return addProject(user, dir, name);
      }
      const saved = workDb()
        .prepare("SELECT id FROM projects WHERE user_id=? AND root=?")
        .get(user, dir) as { id: string } | undefined;
      if (
        saved &&
        (workDb()
          .prepare("SELECT 1 FROM buffers WHERE project=? AND dirty=1")
          .get(saved.id) ||
          workDb()
            .prepare(
              "SELECT 1 FROM terminal_sessions WHERE project=? AND state='running'",
            )
            .get(saved.id))
      )
        throw new DevError(
          "Save recovery buffers and stop running sessions before removing this worktree.",
          409,
        );
      await git(user, project, ["worktree", "remove", dir]);
      if (saved)
        workDb()
          .prepare("UPDATE projects SET archived=1 WHERE id=?")
          .run(saved.id); // no --force: dirty worktrees remain recoverable
      return { removed: true };
    });
  gitQueues.set(key, run);
  try {
    return await run;
  } finally {
    if (gitQueues.get(key) === run) gitQueues.delete(key);
  }
}
