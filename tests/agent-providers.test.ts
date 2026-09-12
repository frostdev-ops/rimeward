import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInput, readItems, repairResponsesItems } from '../src/lib/agent/codex.ts';
import { chatStream, markLast, readChatResponse, repairChatItems } from '../src/lib/agent/openrouter.ts';
import { sseParser } from '../src/lib/agent/stream.ts';
import { usageLine } from '../src/lib/agent/provider.ts';

// Pure wire-shape mappers. The two repairItems dialects are the one place a
// bug silently corrupts threads (an unpaired call kills every later request),
// so both get direct coverage.

test('normalizeInput coerces strings to typed Responses items', () => {
  const out = normalizeInput('hi') as any[];
  assert.deepEqual(out, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  const roles = normalizeInput([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
  ]) as any[];
  assert.equal(roles[0].content[0].type, 'input_text');
  assert.equal(roles[1].content[0].type, 'output_text');
});

test('normalizeInput strips numeric file_id bookkeeping from input_image', () => {
  const out = normalizeInput([
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:x', file_id: 7 }] },
  ]) as any[];
  assert.equal(out[0].content[0].file_id, undefined);
  // A real string handle is left alone.
  const kept = normalizeInput([{ role: 'user', content: [{ type: 'input_image', image_url: 'data:x', file_id: 'file-abc' }] }]) as any[];
  assert.equal(kept[0].content[0].file_id, 'file-abc');
});

test('readItems splits Responses output into text + calls', () => {
  const { text, calls } = readItems([
    { type: 'message', content: [{ type: 'output_text', text: 'ok ' }, { type: 'output_text', text: 'done' }] },
    { type: 'function_call', name: 'get_layout', call_id: 'c1', arguments: '{}' },
  ]);
  assert.equal(text, 'ok done');
  assert.deepEqual(calls, [{ call_id: 'c1', name: 'get_layout', arguments: '{}' }]);
});

test('repairResponsesItems synthesizes outputs and drops orphans', () => {
  const items = [
    { type: 'function_call_output', call_id: 'orphan', output: '{}' }, // call truncated away
    { type: 'function_call', call_id: 'open', name: 'x', arguments: '{}' }, // never answered
    { type: 'function_call', call_id: 'parked', name: 'y', arguments: '{}' }, // deliberately open
  ];
  const out = repairResponsesItems(items, new Set(['parked'])) as any[];
  assert.ok(!out.some((it) => it.call_id === 'orphan' && it.type === 'function_call_output'));
  const synth = out.find((it) => it.type === 'function_call_output' && it.call_id === 'open');
  assert.ok(synth, 'unanswered call got a synthetic output');
  assert.match(String(synth.output), /interrupted/);
  assert.ok(!out.some((it) => it.type === 'function_call_output' && it.call_id === 'parked'), 'keepOpen call stays open');
});

test('readChatResponse maps toolCalls to the shared call shape', () => {
  const { text, calls } = readChatResponse({
    role: 'assistant',
    content: 'thinking…',
    toolCalls: [{ id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{"a":1}' } }],
  });
  assert.equal(text, 'thinking…');
  assert.deepEqual(calls, [{ call_id: 't1', name: 'get_weather', arguments: '{"a":1}' }]);
});

test('repairChatItems pairs assistant toolCalls with tool messages', () => {
  const items = [
    { role: 'tool', toolCallId: 'orphan', content: '{}' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'open', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'assistant', content: '', toolCalls: [{ id: 'parked', type: 'function', function: { name: 'y', arguments: '{}' } }] },
  ];
  const out = repairChatItems(items, new Set(['parked'])) as any[];
  assert.ok(!out.some((m) => m.role === 'tool' && m.toolCallId === 'orphan'));
  const synth = out.find((m) => m.role === 'tool' && m.toolCallId === 'open');
  assert.ok(synth);
  assert.match(String(synth.content), /interrupted/);
  assert.ok(!out.some((m) => m.role === 'tool' && m.toolCallId === 'parked'));
  // The synthetic answer lands directly after its assistant message.
  assert.equal(out.indexOf(synth) , out.findIndex((m) => m.toolCalls?.[0]?.id === 'open') + 1);
});

test('normalizeInput drops bare reasoning items that would 400 the request', () => {
  // Threads written before the `include` existed hold reasoning items with an
  // rs_ id and no payload; replaying one poisons every later turn.
  const out = normalizeInput([
    { type: 'reasoning', id: 'rs_bare' },
    { type: 'reasoning', id: 'rs_ok', encrypted_content: 'gAAAA…' },
    { role: 'user', content: 'hi' },
  ]) as any[];
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'rs_ok', 'the item WITH encrypted content rides along verbatim');
  assert.equal(out[1].role, 'user');
});

test('markLast puts a cache breakpoint on the newest message without touching the stored items', () => {
  const user = { role: 'user', content: 'hi' };
  const tool = { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' };
  const parts = { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', imageUrl: { url: 'data:,' } }] };
  const calls = { role: 'assistant', content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] };

  // A string body becomes one marked text part — user and tool messages alike.
  for (const last of [user, tool]) {
    const out = markLast([calls, last]) as any[];
    assert.deepEqual(out[1].content, [{ type: 'text', text: last.content, cacheControl: { type: 'ephemeral' } }]);
    assert.equal(out[1].role, last.role);
    assert.equal(out[0], calls, 'earlier items pass through by reference');
  }
  // Parts: the marker sits on the last TEXT part, never on an image.
  const marked = (markLast([parts]) as any[])[0];
  assert.deepEqual(marked.content[0], { type: 'text', text: 'see', cacheControl: { type: 'ephemeral' } });
  assert.deepEqual(marked.content[1], parts.content[1]);
  // A tool-calls-only assistant turn has nothing to mark.
  assert.deepEqual(markLast([user, calls]), [user, calls]);
  assert.deepEqual(markLast([]), []);
  // The originals — the stored replay — are untouched.
  assert.equal(typeof user.content, 'string');
  assert.equal(typeof tool.content, 'string');
  assert.equal('cacheControl' in parts.content[0]!, false);
});

test('usageLine reports the cache hit rate, or plain ok without usage', () => {
  assert.equal(usageLine(undefined), 'ok');
  assert.equal(usageLine({ input: 0, cached: 0 }), 'ok');
  assert.equal(usageLine({ input: 15_100, cached: 12_300 }), 'ok · 15.1k in, 12.3k cached (81%)');
  assert.equal(usageLine({ input: 900, cached: 0 }), 'ok · 900 in, 0 cached (0%)');
});

test('sseParser frames across chunk boundaries, joins multi-line data, skips comments, flushes on finish', () => {
  const got: string[] = [];
  const p = sseParser((d) => got.push(d));
  p.push('data: {"a":1}\r');
  p.push('\n\r\ndata: x\ndata: y\n\n: keepalive\n\ndata: [DONE]\n\n');
  assert.deepEqual(got, ['{"a":1}', 'x\ny', '[DONE]']);
  p.push('data: tail');
  p.finish();
  assert.deepEqual(got.at(-1), 'tail');
});

test('chatStream rebuilds a streamed tool call and refuses an unfinished stream', () => {
  const seen: string[] = [];
  const s = chatStream((d) => seen.push(d));
  s.push({ choices: [{ delta: { content: 'Hel' } }] });
  s.push({ choices: [{ delta: { content: 'lo', tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_layout', arguments: '{"wa' } }] } }] });
  // Some servers repeat the whole name on every chunk; only the arguments accumulate.
  s.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'get_layout', arguments: 'rd":"w1"}' } }] } }] });
  assert.throws(() => s.result(), /ended before completion/);
  s.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { promptTokens: 3 } });
  const r = s.result();
  assert.deepEqual(seen, ['Hel', 'lo']);
  assert.equal(r.choices[0]!.message.content, 'Hello');
  assert.deepEqual(r.choices[0]!.message.toolCalls, [{ id: 'c1', type: 'function', function: { name: 'get_layout', arguments: '{"ward":"w1"}' } }]);
  assert.equal(r.usage.promptTokens, 3);
  const cut = chatStream();
  assert.throws(() => cut.push({ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] }), /Incomplete response/);
});
