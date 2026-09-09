import fs from "node:fs";
import os from 'node:os';
import path from 'node:path';
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { workDb } from "./runtime.ts";
import type { ToolDef, ToolCtx } from "../agent/tools.ts";
import { requireDesktop } from "./runtime.ts";
import {
  listProjects,
  addProject,
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
  executable,
} from "./terminals.ts";
import { fitOutput } from "../agent/shell.ts";
import { applyProjectPatch } from './apply-patch.ts';
import { deviceTool, agentDevices } from './tool-routing.ts';
import { computerStatus, computerScreenshot, computerInput } from './computer.ts';
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
export const LOCAL_DEV_TOOLS: Record<string, ToolDef> = {
  desktop_files: wrap('read', 'Browse folders on the selected computer to locate a project. Defaults to its home folder. Returns at most 100 entries; use next as cursor. Open the chosen folder with desktop_open_project before reading/editing files or running commands.',
    schema({ runtime: context.runtime, path: str('Absolute directory, or omit for the home folder'), cursor: { type: 'integer', minimum: 0 } }, ['runtime']),
    (a) => {
      const folder = a.path ?? os.homedir();
      if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw Error('Use an absolute directory.');
      const cursor = a.cursor ?? 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error('Invalid cursor.');
      const entries = fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      const page = entries.slice(cursor, cursor + 100).map(e => ({ name: e.name, directory: e.isDirectory(), symlink: e.isSymbolicLink() }));
      while (JSON.stringify({ path: folder, entries: page }).length > 9000) {
        if (page.length <= 1) throw Error('Directory entry exceeds the tool page size.');
        page.pop();
      }
      return { path: folder, entries: page, ...(cursor + page.length < entries.length ? { next: cursor + page.length } : {}) };
    }),
  desktop_open_project: wrap('confirm', 'Open an existing absolute folder as a project on the selected computer. This grants project tools access to that folder; no files are copied. Returns a project ID for subsequent reads, edits and native commands.',
    schema({ runtime: context.runtime, path: str('Absolute project folder') }, ['runtime', 'path']), (a, c) => addProject(c.userId, a.path)),
  computer_status: wrap('read', 'Inspect screen-control availability, displays and the current controller on the selected computer. This does not capture the screen or enable control. The user enables control locally in Rimeward connections; the tray can stop it.',
    schema({ runtime: context.runtime }, ['runtime']), (_, c) => computerStatus(c.userId)),
  computer_screenshot: wrap('read', 'Capture one display on the selected computer. The image is shown to you as a visual observation. It may contain private information and joins this conversation. Call computer_status first. Input coordinates are pixels in the returned imageWidth by imageHeight image, not the display width/height or desktop x/y offsets; input must include its observation ID.',
    schema({ runtime: context.runtime, display: { type: 'integer', minimum: 0 } }, ['runtime']),
    (a, c) => computerScreenshot(c.userId, a, owner(c), c.signal)),
  computer_input: wrap('confirm', 'Control the selected computer: click, move, drag, scroll, type text, or press a key chord. Requires local control permission and a screenshot observation from this agent in the last 60 seconds. Use screenshot pixels: 0 <= x/toX < imageWidth and 0 <= y/toY < imageHeight. Do not use display width/height or desktop offsets. Each call is atomic; never replay uncertain input. Do not change permissions, send messages, or perform purchases unless authorized by the user.',
    schema({ runtime: context.runtime, observation: str('Observation ID from computer_screenshot'),
      action: { type: 'string', enum: ['click', 'move', 'drag', 'scroll', 'text', 'key'] },
      x: { type: 'number' }, y: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      clicks: { type: 'integer', minimum: 1, maximum: 2 },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer', minimum: 1, maximum: 20 },
      text: str('Literal text, at most 4000 characters'),
      keys: { type: 'array', minItems: 1, maxItems: 5, items: str('Control, Alt, Shift, Meta, Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown, F1–F12, or one character') },
    }, ['runtime', 'observation', 'action']),
    (a, c) => computerInput(c.userId, a, owner(c), c.signal)),
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
        includeIgnored: { type: "boolean", description: "search: explicitly include ignored files and nested checkouts under path; default false" },
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
            : searchPage(c.userId, a.project, a.query ?? "", a.path ?? "", a.cursor, a.includeIgnored === true),
  ),
  apply_patch: wrap(
    'confirm',
    'Apply targeted diffs directly to disk in a desktop project. Use *** Begin Patch / *** End Patch with *** Add File: (+ lines), *** Update File: (@@ context hunks), *** Delete File:, optional *** Move to:, and *** End of File. Exact context only; ambiguous/missing context, dirty or other-owned buffers abort preflight for every file. No shell/git syntax. Up to 20 operations and 1 MiB of patch text. Recovery copies precede destructive writes; I/O failure may be partial. Returns saved/revision receipts, not contents.',
    schema({ ...context, patch: str('Codex-style patch text, including Begin/End Patch markers'),
      expected_revisions: { type: 'object', description: 'Optional project-relative path to project_read buffer revision map; 0 for an unread/new path. Disk hashes are always rechecked.', additionalProperties: { type: 'integer', minimum: 0 } },
    }, ['runtime', 'project', 'patch']),
    (a, c) => applyProjectPatch(c.userId, a.project, owner(c), a.patch, a.expected_revisions),
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
    "Open a visible Terminal tab for an intentional interactive shell, Codex, or Claude Code session in a project. Use terminal_exec for routine commands instead of creating tabs. New sessions always use Human mode. The user can start sessions with delegated control through the Terminal ward. Never install CLIs or guess credentials. The session outlives views. Review output and changes before declaring completion.",
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
  terminal_exec: {
    ...wrap(
      "confirm",
      "Run a native shell command in a desktop project without opening a Terminal tab. Output and Stop controls are in chat Tasks; users can open its retained screen through Terminal's Rime commands menu. Returns exit_code for normal exits; signal/cancellation/termination returns null with exit_signal, cancelled and termination_reason. Commands can change files and access this computer/network; the ward approval policy applies. Use background:true for long work; task_output reads live logs. Stop terminates this command's process, not a user's existing terminal. Prefer this tool for routine commands; terminal_start is for intentional interactive shells or terminal agents. Never assume an exit code proves a requested change is correct.",
      schema({ ...context, command: str("Exact shell command; /bin/sh on macOS/Linux, PowerShell on Windows"), title: str("Short task label") }, ["runtime", "project", "command"]),
      async (a, c) => {
        c.signal?.throwIfAborted();
        const shell = process.platform === 'win32' ? executable('pwsh') || executable('powershell') : '/bin/sh';
        if (!shell) throw Error('PowerShell is not installed.');
        const session = await startSession(c.userId, { project: a.project, kind: 'shell', mode: 'human', shell,
          command: a.command, task: a.command, title: a.title || 'Rime command' });
        const stop = () => { if (listSessions(c.userId).some(s => s.id === session.id && s.state === 'running')) closeSession(c.userId, session.id, 'cancelled'); };
        c.signal?.addEventListener('abort', stop, { once: true });
        let after = 0, output = '', truncated = false;
        try {
          if (c.signal?.aborted) stop();
          for (;;) {
            const read = await waitSession(c.userId, session.id, after, 1000, false);
            // The exit snapshot contains the complete screen, so don't append it to live chunks again.
            const text = stripVTControlCharacters(read.data);
            if (read.reset) { output = text; c.progress?.(`\n[Terminal snapshot]\n${text}`); }
            else { output += text; c.progress?.(text); }
            if (output.length > 64_000) { output = output.slice(-64_000); truncated = true; }
            after = read.session.sequence;
            if (read.session.state !== 'running') {
              const fitted = fitOutput(output, '');
              return { session: session.id, exit_code: read.session.exitCode, exit_signal: read.session.exitSignal ?? null,
                cancelled: read.session.terminationReason === 'cancelled', termination_reason: read.session.terminationReason ?? null,
                ...fitted, truncated: truncated || fitted.truncated };
            }
          }
        } finally { c.signal?.removeEventListener('abort', stop); }
      },
    ),
    backgroundable: true,
    cancellable: true,
  },
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
  terminal_wait: { ...wrap(
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
    (a, c) => waitSession(c.userId, a.session, a.after, a.milliseconds, false, c.signal),
  ), backgroundable: true, cancellable: true },
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

export const DEV_TOOLS: Record<string, ToolDef> = {
  list_devices: { kind: 'read', description: 'List computers paired to this Rimeward account with their IDs, names, platforms and live connection state. Use an explicit device ID on native tools to choose a computer. local means the desktop hosting this chat; it is unavailable on a server. Keep project/session IDs paired with their device. Never substitute another computer when the intended one is offline.', parameters: schema({}), run: (_, c) => agentDevices(c.userId) },
  ...Object.fromEntries(Object.entries(LOCAL_DEV_TOOLS).map(([name, def]) => {
    const parameters = def.parameters as { properties: Record<string, unknown> };
    return [name, { ...def, parameters: { ...parameters, properties: { ...parameters.properties,
      device: str('Computer ID from list_devices. Omit or local for the desktop hosting this chat; required on the server.') } },
      run: (args: Record<string, unknown>, ctx: ToolCtx) => deviceTool(name, args, ctx, def.run) }];
  })),
};
