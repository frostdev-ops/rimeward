import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createUser } from "../src/lib/users.ts";
import { getDb } from "../src/lib/db.ts";
import { workDir, historyDir } from "../src/lib/agent/history.ts";
import {
  acceptRecord,
  captureRime,
  syncRecord,
  syncManifest,
  validateRecord,
  preserveConflict,
  sharedChats,
  continueSharedChat,
  type SyncRecord,
} from "../src/lib/agent/sync-store.ts";
import {
  activeConversation,
  addMessage,
  appendItems,
  transcript,
} from "../src/lib/agent/conversations.ts";
import {
  storeAttachment,
  getAttachment,
} from "../src/lib/agent/attachments.ts";
import { enroll, claimEnrollment, revoke } from "../src/lib/dev/devices.ts";
import { ALL } from "../src/pages/api/devices/harness/[...action].ts";
import { storeAgentAccount } from "../src/lib/agent/accounts.ts";
import { codexProvider } from "../src/lib/agent/codex.ts";

const record = (key: string, value: unknown): SyncRecord => {
  const payload = JSON.stringify(value);
  return {
    key,
    payload,
    hash: createHash("sha256").update(payload).digest("hex"),
  };
};
test("agent files use compare-and-swap, idempotent retries, tombstones and recoverable conflicts", () => {
  const u = createUser("sync-files@x.dev", null),
    other = createUser("sync-other@x.dev", null);
  const first = record(
    "work/memory/shared.md",
    Buffer.from("server").toString("base64"),
  );
  assert.equal(acceptRecord(u, first, null).ok, true);
  assert.equal(
    acceptRecord(u, first, null).ok,
    true,
    "lost acknowledgement can be retried",
  );
  assert.equal(syncRecord(other, first.key), undefined);
  fs.writeFileSync(path.join(workDir(u), "memory/shared.md"), "server edited");
  const offline = record(
    first.key,
    Buffer.from("offline edited").toString("base64"),
  );
  const conflict = acceptRecord(u, offline, first.hash);
  assert.equal(conflict.ok, false);
  assert.equal(
    fs.readFileSync(path.join(workDir(u), "memory/shared.md"), "utf8"),
    "server edited",
  );
  preserveConflict(u, offline);
  assert.equal(
    (
      getDb()
        .prepare("SELECT payload FROM agent_sync_conflicts WHERE user_id=?")
        .get(u) as { payload: string }
    ).payload,
    offline.payload,
  );
  const removed = record(first.key, null);
  assert.ok(conflict.record);
  assert.equal(acceptRecord(u, removed, conflict.record.hash).ok, true);
  assert.equal(fs.existsSync(path.join(workDir(u), "memory/shared.md")), false);
  assert.equal(syncRecord(u, first.key)?.payload, "null");
});
test("sync never traverses project roots, symlinks or hardlinks, and validates payloads", () => {
  const u = createUser("sync-paths@x.dev", null),
    outside = path.join(workDir(u), "../outside.txt");
  fs.writeFileSync(outside, "outside-only");
  fs.symlinkSync(outside, path.join(workDir(u), "alias"));
  captureRime(u);
  assert.equal(syncRecord(u, "work/alias"), undefined);
  for (const key of [
    "project/root.txt",
    "work/../outside.txt",
    "work/a/../../b",
    "work/C:\\file",
    "work/alias",
  ]) {
    assert.throws(() =>
      acceptRecord(
        u,
        record(key, Buffer.from("overwrite").toString("base64")),
        null,
      ),
    );
  }
  fs.linkSync(outside, path.join(workDir(u), "hardlink"));
  assert.throws(() => captureRime(u));
  assert.equal(fs.readFileSync(outside, "utf8"), "outside-only");
  assert.throws(() => validateRecord({ ...record("work/a", ""), hash: "bad" }));
});
test("history keeps raw items and attachments while continuing a copy without approvals or scheduled actions", async () => {
  const source = createUser("sync-chat@x.dev", null),
    target = createUser("sync-chat-target@x.dev", null);
  const conv = activeConversation(source, "original", "codex");
  const file = await storeAttachment({
    userId: source,
    name: "notes.txt",
    mime: "text/plain",
    bytes: Buffer.from("agent attachment"),
    conversationId: conv.id,
  });
  addMessage(conv, {
    role: "user",
    text: `read file_id ${file.id}`,
    source: "agent",
  });
  getDb()
    .prepare("UPDATE agent_messages SET at=? WHERE conversation_id=?")
    .run("2026-01-02 03:04:05", conv.id);
  appendItems(conv.id, [
    { type: "reasoning", encrypted_content: "retained-reasoning" },
    {
      type: "function_call",
      call_id: "waiting",
      name: "read_document",
      arguments: JSON.stringify({ file_id: file.id }),
    },
  ]);
  getDb()
    .prepare("UPDATE agent_conversations SET pending_confirm_id=? WHERE id=?")
    .run("do-not-replay", conv.id);
  const manifest = syncManifest(source);
  for (const entry of manifest) {
    if (entry.key === 'instance/dashboard') continue; // This scenario imports a chat, not another account's dashboard.
    const saved = syncRecord(source, entry.key);
    assert.ok(saved);
    assert.equal(acceptRecord(target, saved, null).ok, true);
  }
  const chat = sharedChats(target).find((c) => c.ward === "original");
  assert.ok(chat);
  assert.ok(
    fs.readdirSync(historyDir(target)).some((f) => f.startsWith("shared-")),
  );
  const resumed = await continueSharedChat(target, "target", chat.key);
  assert.equal(resumed.pending_confirm_id, null);
  assert.notEqual(resumed.id, conv.id);
  assert.match(transcript(resumed.id)[0]?.text ?? "", /read file_id/);
  const attachment = getDb()
    .prepare("SELECT id FROM agent_files WHERE user_id=? AND conversation_id=?")
    .get(target, resumed.id) as { id: number };
  assert.equal(
    transcript(resumed.id)[0]?.text,
    `read file_id ${attachment.id}`,
  );
  assert.equal(transcript(resumed.id)[0]?.source, "agent");
  assert.equal(transcript(resumed.id)[0]?.at, "2026-01-02 03:04:05");
  assert.match(
    getAttachment(target, attachment.id)?.text ?? "",
    /agent attachment/,
  );
  const raw = (
    getDb()
      .prepare(
        "SELECT json FROM agent_items WHERE conversation_id=? AND json LIKE '%function_call%'",
      )
      .get(resumed.id) as { json: string }
  ).json;
  assert.equal(JSON.parse(JSON.parse(raw).arguments).file_id, attachment.id);
  assert.match(
    JSON.stringify(
      getDb()
        .prepare("SELECT json FROM agent_items WHERE conversation_id=?")
        .all(resumed.id),
    ),
    /retained-reasoning/,
  );
  assert.equal(
    (
      getDb()
        .prepare("SELECT count(*) AS n FROM agent_tasks WHERE user_id=?")
        .get(target) as { n: number }
    ).n,
    0,
  );
});
test("paired harness authorization scopes both sync and model credentials to the server account", async () => {
  const user = createUser("sync-auth@x.dev", null),
    other = createUser("sync-auth-other@x.dev", null);
  const pair = claimEnrollment(enroll(user).code, "Mac", "darwin", 1);
  storeAgentAccount({
    userId: user,
    provider: "codex",
    token: "test-only-secret",
  });
  fs.writeFileSync(path.join(workDir(user), "AGENTS.md"), "owner-only");
  fs.writeFileSync(path.join(workDir(other), "AGENTS.md"), "other-account");
  const invoke = (action = "", body?: unknown, origin?: string) =>
    ALL({
      params: { action: action || undefined },
      locals: {},
      request: new Request(
        "https://example.com/api/devices/harness" +
          (action ? `/${action}` : ""),
        {
          method: body ? "POST" : "GET",
          headers: {
            authorization: `Bearer ${pair.token}`,
            ...(origin ? { origin } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      ),
      url: new URL("https://example.com/api/devices/harness"),
    } as unknown as Parameters<typeof ALL>[0]);
  const info = await invoke();
  assert.equal(info.status, 200);
  const metadata = await info.json();
  assert.equal(metadata.providers.codex, true);
  assert.doesNotMatch(
    JSON.stringify(metadata),
    /test-only-secret|other-account/,
  );
  const original = codexProvider.run;
  let called = 0;
  try {
    codexProvider.run = async (call) => {
      called++;
      assert.equal(call.userId, user);
      return { text: "server credential used", calls: [], items: [] };
    };
    const response = await invoke("model", {
      userId: other,
      provider: "codex",
      model: "test",
      instructions: "test",
      items: [],
      tools: [],
    });
    assert.equal((await response.json()).text, "server credential used");
    assert.equal(called, 1);
    let finish: (result: { text: string; calls: []; items: [] }) => void = () => {};
    codexProvider.run = () => new Promise(resolve => { finish = resolve; });
    const waiting = await invoke("model", { provider: "codex", model: "test", instructions: "test", items: [], tools: [] });
    const reader = waiting.body!.getReader();
    try {
      assert.equal(new TextDecoder().decode((await reader.read()).value), "\n", "long requests send a heartbeat before the model finishes");
    } finally { finish({ text: "completed", calls: [], items: [] }); }
    const result = await reader.read();
    assert.equal(JSON.parse(new TextDecoder().decode(result.value)).text, "completed");
    assert.equal((await reader.read()).done, true);
    codexProvider.run = async () => { throw Object.assign(Error("fixture provider error"), { status: 422 }); };
    const failed = await invoke("model", { provider: "codex", model: "test", instructions: "test", items: [], tools: [] });
    const failure = await failed.json();
    assert.equal(failure.status, 422);
    assert.equal(failure.category, 'request-rejected');
    assert.match(failure.error, new RegExp(failure.requestId));
    for (const [status, category] of [[503, 'provider-unavailable'], [429, 'request-rejected']] as const) {
      codexProvider.run = async () => { throw Object.assign(Error('private response body'), { status }); };
      const response = await invoke('model', { provider: 'codex', requestId: '11111111-1111-1111-1111-111111111111', model: 'test', instructions: 'test', items: [], tools: [] });
      const error = await response.json();
      assert.equal(error.category, category);
      assert.equal(error.status, status);
      assert.equal(error.requestId, '11111111-1111-1111-1111-111111111111');
      assert.doesNotMatch(JSON.stringify(error), /private response body/);
    }
    codexProvider.run = async (call) => new Promise((_, reject) => {
      call.signal!.addEventListener('abort', () => reject(call.signal!.reason), { once: true });
    });
    const cancelled = await invoke('model', { provider: 'codex', model: 'test', instructions: 'test', items: [], tools: [] });
    await cancelled.body!.cancel();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(
      (await invoke("", undefined, "https://example.com")).status,
      403,
    );
    revoke(user, pair.id);
    assert.equal((await invoke()).status, 401);
  } finally {
    codexProvider.run = original;
  }
});
