import "./_setup.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEV_TOOLS } from "../src/lib/dev/tools.ts";
import {
  addProject,
  projectPath,
  readBuffer,
  readPage,
  gitView,
  DIFF_CAP,
  editBuffer,
  bufferCopies,
  renameFile,
  createProject,
  worktreeOp,
  git,
} from "../src/lib/dev/projects.ts";
import {
  terminalEnv,
  cliArgs,
  startSession,
  writeSession,
  waitSession,
  readSession,
  closeSession,
  controlSession,
  releaseControl,
  configureSession,
  resizeSession,
  restartSession,
} from "../src/lib/dev/terminals.ts";
import { subscribeDev } from "../src/lib/dev/runtime.ts";
process.env.RIMEWARD_DESKTOP = "1";
process.env.RIMEWARD_NATIVE_TOKEN = "test-only";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rimeward-project-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
test("approved roots, independent user ownership, versioned recovery, conflicts and encoding", () => {
  const p = addProject(1, root);
  const file = path.join(root, "a.txt");
  fs.writeFileSync(file, Buffer.from("\ufeffone\r\ntwo\r\n"));
  assert.throws(() => projectPath(2, p.id, "a.txt"));
  assert.throws(() => projectPath(1, p.id, "../escape"));
  fs.symlinkSync(os.tmpdir(), path.join(root, "outside"), "dir");
  assert.throws(() => projectPath(1, p.id, "outside"));
  const initial = readBuffer(1, p.id, "a.txt");
  assert.equal(initial.text, "one\ntwo\n");
  const dirty = editBuffer(1, p.id, "a.txt", "client:one", {
    text: "edited\n",
    revision: initial.revision,
  });
  assert.equal(fs.readFileSync(file, "utf8"), "\ufeffone\r\ntwo\r\n");
  assert.throws(() =>
    editBuffer(1, p.id, "a.txt", "client:two", { text: "lost" }),
  );
  assert.throws(() =>
    editBuffer(1, p.id, "a.txt", "client:one", {
      text: "stale",
      revision: initial.revision,
    }),
  );
  fs.writeFileSync(file, "external\r\n");
  assert.equal(readBuffer(1, p.id, "a.txt").conflict, true);
  assert.throws(() =>
    editBuffer(1, p.id, "a.txt", "client:one", {
      save: true,
      revision: dirty.revision,
    }),
  );
  editBuffer(1, p.id, "a.txt", "client:one", {
    resolve: "mine",
    revision: dirty.revision,
  });
  assert.equal(fs.readFileSync(file, "utf8"), "\ufeffedited\r\n");
  assert.equal((bufferCopies(1, p.id, "a.txt")[0] as any).text, "external\n");
  editBuffer(1, p.id, "a.txt", "client:one", {
    text: "recover deleted",
    revision: readBuffer(1, p.id, "a.txt").revision,
  });
  fs.unlinkSync(file);
  assert.equal(readBuffer(1, p.id, "a.txt").text, "recover deleted");
  editBuffer(1, p.id, "a.txt", "client:one", { resolve: "mine" });
  assert.equal(fs.readFileSync(file, "utf8"), "\ufeffrecover deleted");
});
test("PTY environment excludes backend credentials and permission flags are explicit", () => {
  const env = terminalEnv({
    PATH: "/bin",
    HOME: "/tmp",
    TOKEN_ENC_KEY: "secret",
    OPENAI_API_KEY: "secret",
    RIMEWARD_NATIVE_TOKEN: "secret",
    SECRET_BACKEND_KEY: "secret",
  });
  assert.equal(env.TOKEN_ENC_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.SECRET_BACKEND_KEY, undefined);
  assert.deepEqual(cliArgs("codex", "human"), [
    "--ask-for-approval",
    "on-request",
    "--sandbox",
    "workspace-write",
  ]);
  assert.ok(
    cliArgs("codex", "yolo").includes(
      "--dangerously-bypass-approvals-and-sandbox",
    ),
  );
  assert.ok(
    cliArgs("claude", "yolo").includes("--dangerously-skip-permissions"),
  );
});
test("real terminal attachment, no replay, human control and explicit termination", async () => {
  const p = addProject(1, root);
  const s = await startSession(1, {
    project: p.id,
    kind: "shell",
    mode: "rimeward",
  });
  try {
    controlSession(1, s.id, "client:one", true);
    writeSession(1, s.id, "client:one", "echo RIMEWARD_PTY_TEST\r");
    const until = Date.now() + 5000;
    while (
      Date.now() < until &&
      !readSession(1, s.id).screen.includes("RIMEWARD_PTY_TEST")
    )
      await waitSession(1, s.id, readSession(1, s.id).session.sequence, 500);
    const result = readSession(1, s.id);
    assert.match(result.screen, /RIMEWARD_PTY_TEST/);
    assert.equal(readSession(1, s.id, result.session.sequence).data, "");
    assert.throws(() => writeSession(1, s.id, "agent:rime", "echo denied\r"));
    releaseControl(1, s.id, "client:one");
    writeSession(1, s.id, "agent:rime", "echo resumed\r");
    assert.throws(() => readSession(2, s.id));
  } finally {
    closeSession(1, s.id);
  }
});

test("terminal permissions change live, denied input cannot claim ownership, and human control survives idle time", async t => {
  const p = addProject(1, root);
  const s = await startSession(1, { project: p.id, kind: "shell", shell: process.platform === "win32" ? undefined : "/bin/sh" });
  try {
    assert.throws(() => writeSession(1, s.id, "agent:rime", "denied\r"), /Rime input is off/);
    assert.equal(readSession(1, s.id).session.owner, null);
    configureSession(1, s.id, { agentInput: true });
    assert.equal(readSession(1, s.id).session.mode, "human", "native CLI launch permissions are independent");
    writeSession(1, s.id, "agent:rime", "");
    controlSession(1, s.id, "client:one", true);
    t.mock.timers.enable({ apis: ["Date"] });
    t.mock.timers.tick(60_000);
    assert.equal(readSession(1, s.id).session.owner, "client:one");
    assert.throws(() => writeSession(1, s.id, "agent:rime", "denied\r"));
    assert.throws(() => controlSession(1, s.id, "agent:rime", true));
    assert.throws(() => resizeSession(1, s.id, "client:two", 90, 25));
    resizeSession(1, s.id, "client:one", 91, 26);
    assert.equal(readSession(1, s.id).session.cols, 91);
    t.mock.timers.reset();
    releaseControl(1, s.id, "client:one");
    writeSession(1, s.id, "agent:rime", "");
    configureSession(1, s.id, { agentInput: false });
    assert.equal(readSession(1, s.id).session.owner, null);
    assert.throws(() => writeSession(1, s.id, "agent:rime", "denied\r"));
    assert.throws(() => configureSession(1, s.id, { agentInput: true, mode: "invalid" as never }));
    assert.equal(readSession(1, s.id).session.agentInput, false);
  } finally { t.mock.timers.reset(); closeSession(1, s.id); }
});

test("streamed terminal output is ordered, bounded and drains before exit; restart keeps settings without replaying tasks", async () => {
  const p = addProject(1, root);
  const s = await startSession(1, { project: p.id, shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh", agentInput: true, task: "do not replay", cols: 100, rows: 30 });
  let bytes = 0, sequence = 0;
  const stop = subscribeDev(1, event => {
    if (event.type !== "output" || event.id !== s.id) return;
    const chunk = event.data as { sequence: number; data: string };
    assert.equal(chunk.sequence, ++sequence);
    bytes += Buffer.byteLength(chunk.data);
  });
  try {
    const producer = path.join(root, "terminal-output.cjs");
    fs.writeFileSync(producer, 'process.stdout.write("0123456789abcdef".repeat(131072) + "\\r\\nSTREAM_DONE\\r\\n")');
    const command = `"${process.execPath}" "${producer}"\r`;
    writeSession(1, s.id, "agent:rime", command);
    const deadline = Date.now() + 30000; // Poll incrementally; serializing all scrollback per chunk starves slower CI runners.
    while (Date.now() < deadline && !readSession(1, s.id, sequence).screen.includes("STREAM_DONE"))
      await waitSession(1, s.id, sequence, 1000);
    const result = readSession(1, s.id);
    assert.match(result.screen, /STREAM_DONE/);
    assert.ok(bytes >= 2 * 1024 * 1024);
    assert.equal(readSession(1, s.id, 0).reset, true, "old output recovers from a snapshot after history rolls over");
    assert.equal(readSession(1, s.id, result.session.sequence).data, "");
    writeSession(1, s.id, "agent:rime", "exit\r");
    while (Date.now() < deadline && readSession(1, s.id, sequence).session.state === "running")
      await waitSession(1, s.id, sequence, 1000);
    const ended = readSession(1, s.id);
    assert.equal(ended.session.state, "exited");
    assert.match(ended.data, /STREAM_DONE/);
    const next = await restartSession(1, s.id);
    assert.equal(next.agentInput, true);
    assert.equal(next.task, "");
    closeSession(1, next.id);
  } finally { stop(); if (readSession(1, s.id, sequence).session.state === "running") closeSession(1, s.id); }
});

test("worktrees preserve disk changes, dirty recovery buffers, and unrelated shared-tree changes", async () => {
  const p = addProject(1, root);
  await git(1, p.id, ["init", "-b", "main"]);
  await git(1, p.id, ["add", "a.txt"]);
  await git(1, p.id, [
    "-c",
    "user.name=Rimeward Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  const w = await worktreeOp(1, p.id, "add", "safe-removal");
  assert.ok("root" in w);
  if (!("root" in w)) return;
  const text = readBuffer(1, w.id, "a.txt");
  editBuffer(1, w.id, "a.txt", "client:worktree", {
    text: "unsaved",
    revision: text.revision,
  });
  await assert.rejects(() => worktreeOp(1, p.id, "remove", "safe-removal"));
  assert.ok(fs.existsSync(w.root));
  editBuffer(1, w.id, "a.txt", "client:worktree", { resolve: "disk" });
  fs.writeFileSync(path.join(w.root, "untracked"), "keep");
  await assert.rejects(() => worktreeOp(1, p.id, "remove", "safe-removal"));
  assert.equal(fs.readFileSync(path.join(w.root, "untracked"), "utf8"), "keep");
  fs.unlinkSync(path.join(w.root, "untracked"));
  await worktreeOp(1, p.id, "remove", "safe-removal");
});

test("legacy newlines and large external replacements retain recoverable text", () => {
  const p = addProject(1, root);
  fs.writeFileSync(path.join(root, "cr.txt"), "one\rtwo\r");
  const cr = readBuffer(1, p.id, "cr.txt");
  editBuffer(1, p.id, "cr.txt", "client:encoding", {
    text: "changed\n",
    revision: cr.revision,
    save: true,
  });
  assert.equal(fs.readFileSync(path.join(root, "cr.txt"), "utf8"), "changed\r");
  fs.writeFileSync(path.join(root, "odd.txt"), Buffer.from([255, 254, 65]));
  assert.equal(readBuffer(1, p.id, "odd.txt").readonly, true);
  fs.writeFileSync(path.join(root, "growing.txt"), "small");
  const v = readBuffer(1, p.id, "growing.txt");
  editBuffer(1, p.id, "growing.txt", "client:encoding", {
    text: "keep my draft",
    revision: v.revision,
  });
  fs.writeFileSync(
    path.join(root, "growing.txt"),
    Buffer.alloc(5 * 1024 * 1024 + 1, 65),
  );
  const conflict = readBuffer(1, p.id, "growing.txt");
  assert.equal(conflict.text, "keep my draft");
  assert.equal(conflict.readonly, true);
  assert.equal(conflict.conflict, true);
});

test("symlink aliases share buffers and renaming a link preserves its target", () => {
  const p = addProject(1, root);
  fs.writeFileSync(path.join(root, "target.txt"), "target");
  fs.symlinkSync(
    path.join(root, "target.txt"),
    path.join(root, "alias.txt"),
    "file",
  );
  const alias = readBuffer(1, p.id, "alias.txt");
  assert.equal(alias.path, "target.txt");
  renameFile(1, p.id, "alias.txt", "renamed-link.txt");
  assert.equal(
    fs.readFileSync(path.join(root, "target.txt"), "utf8"),
    "target",
  );
  assert.ok(fs.lstatSync(path.join(root, "renamed-link.txt")).isSymbolicLink());
  fs.mkdirSync(path.join(root, "removed-dir"));
  fs.writeFileSync(path.join(root, "removed-dir", "file.txt"), "old");
  const v = readBuffer(1, p.id, "removed-dir/file.txt");
  editBuffer(1, p.id, "removed-dir/file.txt", "client:recovery", {
    text: "recover directory",
    revision: v.revision,
  });
  fs.rmSync(path.join(root, "removed-dir"), { recursive: true });
  assert.equal(
    readBuffer(1, p.id, "removed-dir/file.txt").text,
    "recover directory",
  );
});

test("new projects create a folder without replacing existing or private data", () => {
  const p = createProject(1, root, "new-project");
  assert.equal(fs.statSync(p.root).isDirectory(), true);
  assert.throws(() => createProject(1, root, "new-project"));
  assert.throws(() => createProject(1, root, "../escape"));
  assert.throws(() =>
    createProject(1, process.env.HOMEPAGE_DATA_DIR!, "private"),
  );
  assert.equal(
    fs.existsSync(path.join(process.env.HOMEPAGE_DATA_DIR!, "private")),
    false,
  );
});

// Firsthand friction from the agent's own review of this repo: README, AGENTS.md
// and the git diff all came back "result too large" — file and git reads had no
// way to ask for less. A read is a page now, and a diff can be scoped.
test("file reads page under the tool cap and the diff scopes to a path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rimeward-pages-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = addProject(1, dir);
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`);
  fs.writeFileSync(path.join(dir, "big.txt"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "small.txt"), "hello\n");
  const first = readPage(1, p.id, "big.txt");
  assert.equal(first.from, 1);
  assert.equal(first.lines, 3001);
  assert.ok(first.to < 3001 && first.next === first.to + 1);
  assert.ok(first.text.length <= 10_000);
  assert.ok(first.text.startsWith("line 1 "));
  const second = readPage(1, p.id, "big.txt", first.next, 5);
  assert.equal(second.from, first.next);
  assert.equal(second.to, first.next! + 4);
  assert.equal(second.text.split("\n").length, 5);
  assert.equal(second.revision, first.revision, "a page carries the buffer's revision for the edit that follows");
  assert.equal(readPage(1, p.id, "small.txt").next, undefined);
  const edit = (file: string, revision: number) => DEV_TOOLS.project_edit!.run({ runtime: 'desktop', project: p.id, path: file, text: 'created by Rime\n', revision, save: true }, { userId: 1, ward: 'rime', conv: 0 });
  await edit('created.txt', 0);
  assert.equal(fs.readFileSync(path.join(dir, 'created.txt'), 'utf8'), 'created by Rime\n');
  assert.throws(() => edit('small.txt', 0), { status: 409 });
  assert.equal(fs.readFileSync(path.join(dir, 'small.txt'), 'utf8'), 'hello\n');
  const text = 'Large write receipt\n'.repeat(2000);
  const receipt = await DEV_TOOLS.project_edit!.run({ runtime: 'desktop', project: p.id, path: 'large-edit.txt', text, revision: 0, save: true }, { userId: 1, ward: 'rime', conv: 0 });
  assert.equal((receipt as { saved: boolean }).saved, true);
  assert.ok(JSON.stringify(receipt).length < 1000, 'successful writes acknowledge the revision without echoing the whole file');
  assert.equal(fs.readFileSync(path.join(dir, 'large-edit.txt'), 'utf8'), text);
  const recovery = await DEV_TOOLS.project_edit!.run({ runtime: 'desktop', project: p.id, path: 'large-edit.txt', text: text + 'unsaved', revision: (receipt as { revision: number }).revision, save: false }, { userId: 1, ward: 'rime', conv: 0 }) as { revision: number; saved: boolean; dirty: boolean };
  assert.equal(recovery.saved, false);
  assert.equal(recovery.dirty, true);
  assert.ok(JSON.stringify(recovery).length < 1000);
  fs.writeFileSync(path.join(dir, 'large-edit.txt'), 'external change');
  assert.throws(() => DEV_TOOLS.project_edit!.run({ runtime: 'desktop', project: p.id, path: 'large-edit.txt', text, revision: recovery.revision, save: true }, { userId: 1, ward: 'rime', conv: 0 }), { status: 409 });
  assert.equal(readPage(1, p.id, 'large-edit.txt').conflict, true);
  assert.equal(fs.readFileSync(path.join(dir, 'large-edit.txt'), 'utf8'), 'external change');

  const longLine = '\u0000'.repeat(5000) + 'tail';
  fs.writeFileSync(path.join(dir, "long.json"), JSON.stringify(longLine));
  let cursor: number | undefined, column = 0, recovered = '';
  do {
    const page = readPage(1, p.id, "long.json", cursor, undefined, column);
    assert.ok(JSON.stringify(page).length < 12_000);
    recovered += page.text;
    cursor = page.next; column = page.nextColumn ?? 0;
  } while (cursor !== undefined);
  assert.equal(recovered, JSON.stringify(longLine), "a long escaped line remains fully readable");


  await git(1, p.id, ["init", "-q", "-b", "main"]);
  await git(1, p.id, ["add", "big.txt"]);
  await git(1, p.id, ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "big"]);
  fs.writeFileSync(path.join(dir, "big.txt"), lines.map((l) => l + "!").join("\n") + "\n");
  await git(1, p.id, ["add", "small.txt"]);
  assert.ok((await gitView(1, p.id)).diff.length > DIFF_CAP, "the Changes ward still receives the full diff");
  const all = await gitView(1, p.id, undefined, DIFF_CAP);
  assert.equal(all.truncated, true);
  assert.ok(all.diff.length <= DIFF_CAP);
  assert.ok(JSON.stringify(all).length < 12_000);
  assert.match(all.status, /big\.txt/);
  const scoped = await gitView(1, p.id, "small.txt");
  assert.equal(scoped.truncated, undefined);
  assert.match(scoped.diff, /\+hello/);
  assert.doesNotMatch(scoped.diff, /big\.txt/);
  await assert.rejects(gitView(1, p.id, "../escape"));
});

test('model-facing search and Git pages exhaust results without overflow or gaps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-search-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = addProject(1, dir);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'large.ts'), Array.from({ length: 600 }, (_, i) => `const value${i} = ${JSON.stringify('x'.repeat(180))};`).join('\n'));
  const read = (operation: string, cursor?: number, scope = 'src') => DEV_TOOLS.project_read!.run({ runtime: 'desktop', project: project.id, operation, path: scope, query: 'const', cursor }, { userId: 1, ward: 'rime', conv: 0 }) as Promise<any>;
  const matches: any[] = [];
  let cursor: number | undefined;
  do {
    const page = await read('search', cursor);
    assert.ok(JSON.stringify(page).length < 12000);
    matches.push(...page.matches);
    assert.equal(page.complete, page.next === undefined);
    cursor = page.next;
  } while (cursor !== undefined);
  assert.equal(matches.length, 600);
  assert.deepEqual(matches.map(m => m.line), Array.from({ length: 600 }, (_, i) => i + 1));
  await git(1, project.id, ['init', '-q']);
  await git(1, project.id, ['add', '.']);
  await git(1, project.id, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base']);
  fs.appendFileSync(path.join(dir, 'src', 'large.ts'), '\n' + 'const changed = true;\n'.repeat(2000));
  const full = await gitView(1, project.id);
  const recovered = { status: '', diff: '', worktrees: '' };
  do {
    const page = await read('git', cursor, '');
    assert.ok(JSON.stringify(page).length < 12000);
    assert.equal(page.snapshot, full.snapshot);
    for (const key of ['status', 'diff', 'worktrees'] as const) recovered[key] += page[key];
    cursor = page.next;
  } while (cursor !== undefined);
  assert.deepEqual(recovered, { status: full.status, diff: full.diff, worktrees: full.worktrees });
  fs.unlinkSync(path.join(dir, 'src', 'large.ts'));
  assert.match((await gitView(1, project.id, 'src/large.ts')).diff, /deleted file/);
  await assert.rejects(read('search', undefined, '../outside'));
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(dir, 'src', `${i}-${'x'.repeat(80)}`), '');
  const entries: string[] = [];
  do {
    const page = await read('files', cursor);
    assert.ok(JSON.stringify(page).length < 12000);
    entries.push(...page.entries.map((entry: { path: string }) => entry.path));
    cursor = page.next;
  } while (cursor !== undefined);
  assert.equal(entries.length, 200);
  assert.equal(new Set(entries).size, 200);
});

test('task receipts survive reads and mark changed evidence stale', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-evidence-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'reviewed.txt'), 'reviewed');
  const project = addProject(1, dir);
  await git(1, project.id, ['init', '-q']);
  const session = await startSession(1, { project: project.id, kind: 'shell', mode: 'human' });
  try {
    const receipt = await DEV_TOOLS.terminal_task!.run({ runtime: 'desktop', session: session.id, state: 'done', review: 'Inspected saved file; checks not run.' + '"'.repeat(7000), files: ['reviewed.txt'], checks: [] }, { userId: 1, ward: 'reviewer', conv: 0 });
    assert.ok(JSON.stringify(receipt).length < 1000);
    let cursor: number | undefined, text = '';
    do {
      const page = await DEV_TOOLS.terminal_read!.run({ runtime: 'desktop', session: session.id, review: true, cursor }, { userId: 1, ward: 'reviewer', conv: 0 }) as { text: string; next?: number };
      assert.ok(JSON.stringify(page).length < 12000);
      text += page.text; cursor = page.next;
    } while (cursor !== undefined);
    assert.equal(JSON.parse(text).evidence.reviewer, 'agent:reviewer');
    let saved = readSession(1, session.id).session;
    assert.match(saved.review!, /checks not run/);
    assert.equal(saved.evidence!.reviewer, 'agent:reviewer');
    assert.deepEqual(saved.evidence!.checks, []);
    assert.equal(saved.evidence!.stale, false);
    fs.writeFileSync(path.join(dir, 'reviewed.txt'), 'changed later');
    saved = readSession(1, session.id).session;
    assert.equal(saved.evidence!.stale, true);
  } finally { closeSession(1, session.id); }
});
