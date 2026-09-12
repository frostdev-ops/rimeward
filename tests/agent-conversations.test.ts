import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { historyDir } from '../src/lib/agent/history.ts';
import { getDb } from '../src/lib/db.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import {
  activeConversation,
  addMessage,
  appendItems,
  compactIfNeeded,
  conversationSize,
  loadItems,
  transcript,
} from '../src/lib/agent/conversations.ts';
import { codexProvider } from '../src/lib/agent/codex.ts';

function seedUser(email: string): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  const id = (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
  saveDashboard(id, validateLayout([{ i: 'ag1', type: 'agent', size: '2x2', config: {} }])!);
  return id;
}

const userMsg = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const asstMsg = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

test('activeConversation pins the provider and retires on a provider change', () => {
  const u = seedUser('conv-pin@x.dev');
  const a = activeConversation(u, 'ag1', 'codex');
  assert.equal(activeConversation(u, 'ag1', 'codex').id, a.id, 'stable while provider matches');
  const b = activeConversation(u, 'ag1', 'openrouter');
  assert.notEqual(b.id, a.id, 'provider change starts a fresh thread');
  assert.equal(b.provider, 'openrouter');
  const old = getDb().prepare('SELECT active FROM agent_conversations WHERE id = ?').get(a.id) as { active: number };
  assert.equal(old.active, 0, 'old thread retired, not deleted');
});

test('conversations are per (user, ward)', () => {
  const u = seedUser('conv-ward@x.dev');
  saveDashboard(
    u,
    validateLayout([
      { i: 'ag1', type: 'agent', size: '2x2', config: {} },
      { i: 'ag2', type: 'agent', size: '2x2', config: {} },
    ])!
  );
  assert.notEqual(activeConversation(u, 'ag1', 'codex').id, activeConversation(u, 'ag2', 'codex').id);
});

test('loadItems preserves oversized history for budgeted compaction and repairs pairs', () => {
  const u = seedUser('conv-budget@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  // Loading alone must not delete the original request from model context.
  const big = userMsg('x'.repeat(500_000));
  appendItems(conv.id, [
    big,
    asstMsg('old reply'),
    userMsg('recent question'),
    { type: 'function_call', call_id: 'c1', name: 'get_layout', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: '{}' },
    asstMsg('recent reply'),
  ]);
  const items = loadItems(conv, codexProvider, new Set()) as any[];
  // Oversized instructions survive loading; runLoop handles the model budget.
  assert.ok(items.length >= 4);
  assert.equal(items[0].role, 'user');
  assert.equal(items[0].content[0].text.length, 500_000);
  // The pair survived intact.
  assert.ok(items.some((it) => it.type === 'function_call' && it.call_id === 'c1'));
  assert.ok(items.some((it) => it.type === 'function_call_output' && it.call_id === 'c1'));
});

test('loadItems synthesizes an answer for an interrupted call, keepOpen exempt', () => {
  const u = seedUser('conv-repair@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  appendItems(conv.id, [
    userMsg('do it'),
    { type: 'function_call', call_id: 'open', name: 'x', arguments: '{}' },
    { type: 'function_call', call_id: 'parked', name: 'y', arguments: '{}' },
  ]);
  const items = loadItems(conv, codexProvider, new Set(['parked'])) as any[];
  const openAnswer = items.find((it) => it.type === 'function_call_output' && it.call_id === 'open');
  assert.ok(openAnswer, 'interrupted call answered');
  assert.ok(!items.some((it) => it.type === 'function_call_output' && it.call_id === 'parked'), 'parked stays open');
});

test('transcript survives malformed steps json', () => {
  const u = seedUser('conv-transcript@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  addMessage(conv, { role: 'user', text: 'hello' });
  addMessage(conv, { role: 'assistant', text: 'hi', steps: [{ tool: 'get_layout', kind: 'read', args: {} }] });
  getDb().prepare('UPDATE agent_messages SET steps_json = ? WHERE conversation_id = ? AND role = ?').run('{broken', conv.id, 'assistant');
  const msgs = transcript(conv.id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1]!.text, 'hi');
  assert.equal(msgs[1]!.steps, undefined);
});

test('a turn remembers what produced it, across a reload', () => {
  const u = seedUser('conv-source@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  addMessage(conv, { role: 'user', text: 'hi' }); // default
  addMessage(conv, { role: 'assistant', text: 'hello', source: 'chat' });
  addMessage(conv, { role: 'user', text: 'Automation: check the deploy', source: 'automation' });
  addMessage(conv, { role: 'assistant', text: 'all green', source: 'automation' });
  addMessage(conv, { role: 'assistant', text: 'woke up', source: 'wake' });
  // The ward renders automation output differently from what the user typed,
  // and must still do so after a refetch — hence a column, not a runtime flag.
  assert.deepEqual(
    transcript(conv.id).map((m) => m.source),
    ['chat', 'chat', 'automation', 'automation', 'wake']
  );
});

// ---------------------------------------------------------------- compaction
//
// The fold deletes the older items for good — SQLite is the only copy of the
// wire format — so these pin the cases where it must NOT, and the cross-dialect
// ones the codex-only suite above could never see.

/** A provider whose summariser returns whatever it is told to, and records the
 *  text it was asked to summarise. */
function summarizer(text: string, dialect: 'codex' | 'openrouter' = 'codex') {
  const seen: string[] = [];
  const provider: any = {
    id: dialect,
    run: async (call: any) => {
      seen.push(String((call.items[0] as any)?.content?.[0]?.text ?? (call.items[0] as any)?.content ?? ''));
      return { text, items: [], calls: [] };
    },
    userItem:
      dialect === 'codex'
        ? (t: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] })
        : (t: string) => ({ role: 'user', content: t }),
    toolOutputItem:
      dialect === 'codex'
        ? (id: string, json: string) => ({ type: 'function_call_output', call_id: id, output: json })
        : (id: string, json: string) => ({ role: 'tool', toolCallId: id, content: json }),
    repairItems: (items: unknown[]) => items,
  };
  return { provider, seen };
}

const filler = (n: number) => 'x'.repeat(n);

test('without model capacity automatic compaction does not invent a limit', async () => {
  const conv = activeConversation(seedUser('compact-budget@x.dev'), 'ag1', 'codex');
  appendItems(conv.id, Array.from({ length: 10 }, (_, i) => (i % 2 ? asstMsg(filler(60_000)) : userMsg(filler(60_000)))));
  const { provider, seen } = summarizer('BRIEF');
  assert.equal(await compactIfNeeded(conv, provider, 'unknown'), false);
  assert.equal(seen.length, 0);
});

test('compaction never leaves a tool result in neither the summary nor the tail', async () => {
  const u = seedUser('compact-pair@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  // No user message after the boundary — a long final tool loop, the ordinary
  // shape for codex. The fraction has to land inside the pair.
  appendItems(conv.id, [
    userMsg(filler(4000)),
    asstMsg(filler(4000)),
    { type: 'function_call', call_id: 'c1', name: 'get_layout', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: filler(400) },
    asstMsg('done'),
  ]);
  const { provider } = summarizer('BRIEF');
  assert.equal(await compactIfNeeded(conv, provider, 'm', true), true);
  const archive = fs.readFileSync(path.join(historyDir(u), `${conv.id}.compacted.jsonl`), 'utf8');
  assert.ok(archive.split('\n').filter(Boolean).every(line => JSON.parse(line).item));

  const kept = (getDb().prepare('SELECT json FROM agent_items WHERE conversation_id = ? ORDER BY id').all(conv.id) as { json: string }[])
    .map((r) => JSON.parse(r.json));
  const calls = kept.filter((it: any) => it.type === 'function_call');
  const outs = kept.filter((it: any) => it.type === 'function_call_output');
  // Every surviving output still has its call: an orphan would be deleted by
  // repairItems on the next load, losing the result entirely.
  assert.equal(calls.length, outs.length, 'no half-pair survived the fold');
});

test('compaction preserves original rows if its archive cannot be written', async () => {
  const u = seedUser('compact-archive@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  appendItems(conv.id, Array.from({ length: 8 }, () => userMsg(filler(4000))));
  const before = conversationSize(conv.id);
  const archive = path.join(historyDir(u), `${conv.id}.compacted.jsonl`);
  fs.mkdirSync(archive);
  const { provider } = summarizer('BRIEF');
  await assert.rejects(compactIfNeeded(conv, provider, 'm', true));
  assert.deepEqual(conversationSize(conv.id), before);
});

test('compaction refuses to replace real context with an empty summary', async () => {
  const u = seedUser('compact-empty@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  appendItems(conv.id, [userMsg(filler(3000)), asstMsg(filler(3000)), userMsg('next'), asstMsg('ok')]);
  const before = conversationSize(conv.id);
  const { provider } = summarizer('   '); // a refusal, or a model that said nothing
  assert.equal(await compactIfNeeded(conv, provider, 'm', true), false);
  assert.deepEqual(conversationSize(conv.id), before, 'the items are untouched');
});

test('compaction refuses a fold that would not shrink the thread', async () => {
  const u = seedUser('compact-grow@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  appendItems(conv.id, [userMsg('a'), asstMsg('b'), userMsg('c'), asstMsg('d')]);
  const before = conversationSize(conv.id);
  // Summarising four tiny items into a long brief makes the thread bigger —
  // and on the auto path would re-run every turn, forever.
  const { provider } = summarizer(filler(5000));
  assert.equal(await compactIfNeeded(conv, provider, 'm', true), false);
  assert.deepEqual(conversationSize(conv.id), before);
});

test('a single dominant item can still be folded', async () => {
  const u = seedUser('compact-one@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  // One inlined document is most of the conversation. Refusing here told the
  // user "too short to fold" about the very item they wanted gone.
  appendItems(conv.id, [userMsg(filler(60_000)), asstMsg('ok'), userMsg('and now?'), asstMsg('sure')]);
  const { provider } = summarizer('BRIEF of the document');
  assert.equal(await compactIfNeeded(conv, provider, 'm', true), true);
  assert.ok(conversationSize(conv.id).chars < 20_000, 'the fold actually freed the space');
});

test('the brief keeps tool calls the openrouter dialect bundles with prose', async () => {
  const u = seedUser('compact-or@x.dev');
  const conv = activeConversation(u, 'ag1', 'openrouter');
  // The chat dialect's assistant message both speaks AND calls tools. Reading
  // only `content` reported what the agent said and lost everything it did.
  // Sized so the 60% mark lands inside the tool loop and the boundary extends
  // to the 'thanks' turn — putting all three items above it into the fold.
  appendItems(conv.id, [
    { role: 'user', content: filler(1000) },
    {
      role: 'assistant',
      content: `Let me check the layout. ${filler(1000)}`,
      toolCalls: [{ id: 't1', type: 'function', function: { name: 'add_ward', arguments: '{"type":"weather"}' } }],
    },
    { role: 'tool', toolCallId: 't1', content: `{"ok":true,"ward":"w9","note":"${filler(1000)}"}` },
    { role: 'user', content: 'thanks' },
    { role: 'assistant', content: filler(1000) },
  ]);
  const { provider, seen } = summarizer('BRIEF', 'openrouter');
  assert.equal(await compactIfNeeded(conv, provider, 'm', true), true);

  const sent = seen.join('\n');
  assert.match(sent, /Let me check the layout/, 'the prose is in the brief');
  assert.match(sent, /add_ward/, 'and so is the call it was bundled with');
  assert.match(sent, /w9/, 'and the result the call returned');
});

test('the /compact focus hint reaches the summariser', async () => {
  const u = seedUser('compact-focus@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  appendItems(conv.id, [userMsg(filler(4000)), asstMsg(filler(4000)), userMsg('next'), asstMsg('ok')]);
  let instructions = '';
  const { provider } = summarizer('BRIEF');
  const spy = { ...provider, run: async (c: any) => ((instructions = c.instructions), { text: 'BRIEF', items: [], calls: [] }) };
  await compactIfNeeded(conv, spy as any, 'm', true, 'the notion database ids');
  assert.match(instructions, /the notion database ids/);
});
