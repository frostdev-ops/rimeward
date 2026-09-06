import fs from "node:fs";
import { createHash } from "node:crypto";
import { workDb } from "./runtime.ts";
import type { ToolDef, ToolCtx } from "../agent/tools.ts";
import { requireDesktop } from "./runtime.ts";
import {
  listProjects,
  projectPath,
  treePage,
  readBuffer,
  readPage,
  DIFF_CAP,
  createFile,
  editBuffer,
  searchPage,
  gitView,
  worktreeOp,
} from "./projects.ts";
import {
  startSession,
  listSessions,
  readSession,
  writeSession,
  waitSession,
  interruptSession,
  closeSession,
  configureSession,
} from "./terminals.ts";
const str = (description: string) => ({ type: "string", description });
const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
const owner = (ctx: ToolCtx) => `agent:${ctx.ward}`;
const wrap = (
  kind: ToolDef["kind"],
  description: string,
  parameters: Record<string, unknown>,
  run: ToolDef["run"],
): ToolDef => ({
  kind,
  description,
  parameters,
  run: (a, c) => {
    requireDesktop();
    if (a.runtime !== "desktop")
      throw new Error(
        "Select runtime desktop explicitly. These tools never operate on the remote server.",
      );
    return run(a, c);
  },
});
const context = {
  runtime: { type: "string", enum: ["desktop"] },
  project: str("Desktop project ID from desktop_projects"),
};
const session = {
  runtime: context.runtime,
  session: str("Local terminal session ID"),
};
export const DEV_TOOLS: Record<string, ToolDef> = {
  desktop_projects: wrap(
    "read",
    "List projects on this desktop. Project folders are not replicated to the server. Selected file excerpts and tool results enter model requests and may sync with conversation history.",
    schema({ runtime: context.runtime }, ["runtime"]),
    (_, c) => listProjects(c.userId),
  ),
  project_read: wrap(
    "read",
    "Read project files, directories, search results, or Git changes. A result is capped at 12k chars: a file comes back one page at a time (`from`/`lines`, follow `next` and `nextColumn` with `from` and `column`), search/directories/Git use `cursor` from `next` until complete; restart Git reads if snapshot changes. Inspect existing modifications before assigning shared-tree tasks.",
    schema(
      {
        ...context,
        operation: { type: "string", enum: ["files", "file", "search", "git"] },
        path: str("Project-relative path (file: the file; files: the directory; search/git: scope to this file or directory)"),
        query: str("Search text"),
        cursor: { type: "number", description: "files/search/git: continuation offset from next; keep other arguments unchanged" },
        from: { type: "number", description: "file: first line to return, 1-based (default 1)" },
        lines: { type: "number", description: "file: how many lines (default: as many as fit the page)" },
        column: { type: "number", description: "file: zero-based character offset on the first line, from nextColumn" },
        version: { type: "string", enum: ["buffer", "disk"], description: "file: inspect the recovery buffer or conflicting on-disk version" },
      },
      ["runtime", "project", "operation"],
    ),
    (a, c) =>
      a.operation === "files"
        ? treePage(c.userId, a.project, a.path ?? "", a.cursor)
        : a.operation === "file"
          ? readPage(c.userId, a.project, a.path, a.from, a.lines, a.column, a.version)
          : a.operation === "git"
            ? gitView(c.userId, a.project, a.path || undefined, DIFF_CAP, a.cursor)
            : searchPage(c.userId, a.project, a.query ?? "", a.path ?? "", a.cursor),
  ),
  project_edit: wrap(
    "write",
    "Edit a versioned recovery buffer. Explicit save writes the file. `text` is the WHOLE file — read every page first. revision 0 on a path that does not exist creates the file. On conflict inspect both versions and ask the user; never take over a human buffer.",
    schema(
      {
        ...context,
        path: str("Project-relative file"),
        text: str("Complete new file text"),
        revision: { type: "number", description: "The buffer revision project_read returned; 0 to create a new file" },
        save: { type: "boolean" },
      },
      ["runtime", "project", "path", "text", "revision"],
    ),
    (a, c) => {
      let revision = a.revision;
      if (revision === 0) {
        try {
          readBuffer(c.userId, a.project, a.path);
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          createFile(c.userId, a.project, a.path);
          revision = readBuffer(c.userId, a.project, a.path).revision;
        }
      }
      const result = editBuffer(c.userId, a.project, a.path, owner(c), {
        text: a.text,
        revision,
        save: a.save === true,
      });
      return { project: result.project, path: result.path, revision: result.revision,
        saved: a.save === true && !result.dirty && !result.conflict,
        dirty: result.dirty, conflict: result.conflict, readonly: result.readonly };
    },
  ),
  terminal_list: wrap(
    "read",
    "List terminal sessions, delegated tasks, assignments and permission modes. Check overlapping assignments before delegating; coordination cannot isolate external CLI writes.",
    schema({ ...context }, ["runtime"]),
    (a, c) => listSessions(c.userId, a.project),
  ),
  terminal_start: wrap(
    "write",
    "Start a native shell, interactive Codex, or Claude Code with a task in a project. New sessions always use Human mode. The user can start sessions with delegated control through the Terminal ward. Never install CLIs or guess credentials. The session outlives views. Review output and changes before declaring completion.",
    schema(
      {
        ...context,
        kind: { type: "string", enum: ["shell", "codex", "claude"] },
        task: str("Task instructions"),
        assignment: str("Assigned files or area; disclose overlapping work"),
      },
      ["runtime", "project", "kind", "task", "assignment"],
    ),
    async (a, c) => {
      return startSession(c.userId, {
        project: a.project,
        kind: a.kind,
        task: a.task,
        assignment: a.assignment,
        mode: "human",
      });
    },
  ),
  terminal_read: wrap(
    "read",
    "Inspect current terminal screen and ordered output. Empty output or an idle screen does not prove a task completed. Unknown permission screens require attention.",
    schema({ ...session, after: { type: "number" }, review: { type: "boolean", description: "Read the durable task review and evidence as paginated JSON text instead of terminal output" }, cursor: { type: "number", description: "Review continuation from next" } }, ["runtime", "session"]),
    (a, c) => {
      const result = readSession(c.userId, a.session, a.after, a.review === true);
      if (!a.review) return result;
      const all = JSON.stringify({ review: result.session.review, evidence: result.session.evidence });
      const cursor = Math.max(0, Math.floor(Number(a.cursor)) || 0);
      let text = all.slice(cursor, cursor + 9000);
      while (JSON.stringify(text).length > 9000) text = text.slice(0, Math.floor(text.length * 0.8));
      const next = cursor + text.length;
      return { text, snapshot: createHash('sha256').update(all).digest('hex'), complete: next >= all.length, ...(next < all.length ? { next } : {}) };
    },
  ),
  terminal_wait: wrap(
    "read",
    "Wait up to 30 seconds for output, then return a screen snapshot. For longer waits use the existing schedule_wake tool; coalesce activity instead of polling the model for every chunk.",
    schema(
      {
        ...session,
        after: { type: "number" },
        milliseconds: { type: "number" },
      },
      ["runtime", "session", "after"],
    ),
    (a, c) => waitSession(c.userId, a.session, a.after, a.milliseconds, false),
  ),
  terminal_input: wrap(
    "write",
    "Send exact input to a session with agentInput enabled. The user can enable Rime input in Session settings without restarting, then release human control. Read the latest screen first. Never blindly replay uncertain input or guess approval keys; user takeover pauses agent input.",
    schema(
      {
        ...session,
        data: str("Exact text / control characters; Enter is carriage return"),
      },
      ["runtime", "session", "data"],
    ),
    (a, c) => {
      writeSession(c.userId, a.session, owner(c), a.data);
      return { sent: true };
    },
  ),
  terminal_interrupt: wrap(
    "write",
    "Interrupt work using Ctrl-C. This does not terminate the terminal or prove task completion.",
    schema(session, ["runtime", "session"]),
    (a, c) => {
      interruptSession(c.userId, a.session, owner(c));
      return { interrupted: true };
    },
  ),
  terminal_close: wrap(
    "confirm",
    "Terminate a native process. Removing its ward only detaches the view; this explicitly ends work.",
    schema(session, ["runtime", "session"]),
    (a, c) => {
      closeSession(c.userId, a.session);
      return { closing: true };
    },
  ),
  terminal_task: wrap(
    "write",
    "Record delegated task state after inspecting resulting files, diffs, and relevant checks. A CLI prompt alone is not completion evidence. Captures current file hashes and Git identity; checks are reviewer-reported observations, not independently executed by this tool. Use needs-attention for unknown states.",
    schema(
      {
        ...session,
        state: {
          type: "string",
          enum: ["needs-attention", "done", "cancelled"],
        },
        files: { type: "array", maxItems: 100, items: str("Reviewed project-relative path; current disk hash is captured") },
        checks: { type: "array", maxItems: 30, items: schema({ command: str("Validation command actually observed; never invent a check"), exitCode: { type: ["number", "null"], description: "Observed exit status, or null if not run/unknown" } }, ["command", "exitCode"]) },
        review: str(
          "Concrete review of resulting changes and validation, or the reason attention is required",
        ),
      },
      ["runtime", "session", "state", "review", "files", "checks"],
    ),
    async (a, c) => {
      if (!a.review?.trim()) throw new Error("Review evidence is required.");
      if (!["needs-attention", "done", "cancelled"].includes(a.state)) throw new Error("Invalid task state.");
      const session = listSessions(c.userId).find(s => s.id === a.session);
      if (!session) throw new Error("Terminal not found.");
      if (!Array.isArray(a.files) || a.files.length > 100 || a.files.some((f: unknown) => typeof f !== 'string')) throw new Error("List the reviewed files (up to 100).");
      if (!Array.isArray(a.checks) || a.checks.length > 30 || a.checks.some((check: { command?: unknown; exitCode?: unknown }) => !check || typeof check.command !== 'string' || check.command.length > 1000 || !(check.exitCode === null || Number.isInteger(check.exitCode)))) throw new Error("Provide observed checks; use an empty list if none ran.");
      const files = a.files.map((file: string) => {
        const target = projectPath(c.userId, session.project, file, true);
        if (fs.existsSync(target) && fs.statSync(target).size > 5 * 1024 * 1024) throw new Error("Review files must be at most 5 MiB.");
        return { path: file, hash: fs.existsSync(target) ? createHash('sha256').update(fs.readFileSync(target)).digest('hex') : null };
      });
      const changes = await gitView(c.userId, session.project).catch(() => null);
      const evidence = { reviewer: owner(c), at: new Date().toISOString(), sequence: session.sequence, diff: changes?.snapshot ?? null, files,
        checks: a.checks.map((check: { command: string; exitCode: number | null }) => ({ command: check.command, exitCode: check.exitCode })) };
      workDb().prepare("INSERT INTO task_receipts VALUES(?,?) ON CONFLICT(session) DO UPDATE SET json=excluded.json").run(a.session, JSON.stringify(evidence));
      configureSession(c.userId, a.session, { taskState: a.state, review: a.review });
      return { session: a.session, taskState: a.state, reviewSaved: true, reviewer: evidence.reviewer,
        at: evidence.at, sequence: evidence.sequence, diff: evidence.diff, files: files.length, checks: a.checks.length };
    },
  ),
  project_worktree: wrap(
    "write",
    "Create or remove a Rimeward Git worktree. Git operations are serialized per repository. Dirty worktrees are never force-removed. Shared working trees remain the default.",
    schema(
      {
        ...context,
        operation: { type: "string", enum: ["add", "remove"] },
        name: str("Simple worktree name"),
      },
      ["runtime", "project", "operation", "name"],
    ),
    (a, c) => worktreeOp(c.userId, a.project, a.operation, a.name),
  ),
};
