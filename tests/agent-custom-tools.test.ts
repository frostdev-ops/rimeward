import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readItems, repairResponsesItems, responseTools, unsupportedCustomTool, openaiProvider, codexProvider } from '../src/lib/agent/codex.ts';
import { storeAgentAccount } from '../src/lib/agent/accounts.ts';
import { createUser } from '../src/lib/users.ts';
import type { ProviderCall } from '../src/lib/agent/provider.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { activeConversation, retireConversation, retainConversationTools, appendItems } from '../src/lib/agent/conversations.ts';
import { runLoop, agentWardConfig, resolveConfirmTurn } from '../src/lib/agent/core.ts';
import { TOOLS, aiTools } from '../src/lib/agent/tools.ts';
import { localOwner } from '../src/lib/dev/native.ts';

const patch = '*** Begin Patch\n*** Add File: x.txt\n+hello\n*** End Patch';
const spec = { name: 'apply_patch', description: 'Patch', parameters: { type: 'object', properties: { patch: { type: 'string' }, reason: { type: 'string' } }, required: ['patch', 'reason'] }, inputFormat: 'text' as const };
const userId = createUser('custom-tools@example.com', null);
const call = (model: string): ProviderCall => ({ userId, model, instructions: '', items: [], tools: [spec] });
const completed = (output: unknown[]) => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
storeAgentAccount({ userId, provider: 'openai', token: 'test-only' });

test('raw tool encoding and completed calls preserve exact patch input', () => {
  assert.equal(responseTools([spec], true)[0]!.type, 'custom');
  assert.equal(responseTools([spec], false)[0]!.type, 'function');
  assert.deepEqual(readItems([{ type: 'custom_tool_call', name: 'apply_patch', call_id: 'p', input: patch }]).calls,
    [{ name: 'apply_patch', call_id: 'p', arguments: patch, type: 'custom' }]);
  assert.deepEqual(openaiProvider.toolOutputItem('p', '{"ok":true}', 'custom'), { type: 'custom_tool_call_output', call_id: 'p', output: '{"ok":true}' });
});

test('mixed call repair retains raw pairs, drops wrong-kind results and keeps approvals open', () => {
  const items = [
    { type: 'custom_tool_call_output', call_id: 'orphan', output: '{}' },
    { type: 'custom_tool_call', name: 'apply_patch', call_id: 'raw', input: patch },
    { type: 'function_call_output', call_id: 'raw', output: '{}' },
    { type: 'custom_tool_call', name: 'apply_patch', call_id: 'parked', input: patch },
    { type: 'function_call', name: 'read', call_id: 'json', arguments: '{}' },
    { type: 'function_call_output', call_id: 'json', output: '{}' },
  ];
  const repaired = repairResponsesItems(items, new Set(['parked'])) as { type: string; call_id?: string }[];
  assert.equal(repaired.filter(i => i.call_id === 'raw' && i.type === 'custom_tool_call_output').length, 1);
  assert.ok(!repaired.some(i => i.call_id === 'orphan' || i.call_id === 'raw' && i.type === 'function_call_output'));
  assert.ok(!repaired.some(i => i.call_id === 'parked' && i.type.endsWith('_output')));
  assert.deepEqual(repairResponsesItems(repaired, new Set(['parked'])), repaired);
});

test('fallback classification requires exact offered custom type and structured error', () => {
  const rejection = (code: string, param: string) => JSON.stringify({ error: { code, param } });
  assert.equal(unsupportedCustomTool(rejection('unsupported_value', 'tools[0].type'), [{ type: 'custom' }]), true);
  for (const [code, param] of [['invalid_value', 'tools[0].type'], ['unsupported_value', 'tools[0].parameters'], ['unsupported_value', 'model']])
    assert.equal(unsupportedCustomTool(rejection(code!, param!), [{ type: 'custom' }]), false);
  assert.equal(unsupportedCustomTool(rejection('unsupported_value', 'tools[0].type'), [{ type: 'function' }]), false);
  assert.equal(unsupportedCustomTool('custom tools are unsupported', [{ type: 'custom' }]), false);
});

test('OpenAI fallback stays on the model and caches only an explicit type rejection', async () => {
  const original = globalThis.fetch, requests: any[] = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)));
    return requests.length === 1
      ? new Response(JSON.stringify({ error: { code: 'unsupported_value', param: 'tools[0].type' } }), { status: 400 })
      : completed([{ type: 'function_call', call_id: 'p', name: 'apply_patch', arguments: JSON.stringify({ reason: 'Apply patch', patch }) }]);
  };
  try {
    await openaiProvider.run(call('custom-fallback-fixture'));
    await openaiProvider.run(call('custom-fallback-fixture'));
    assert.deepEqual(requests.map(r => r.tools[0].type), ['custom', 'function', 'function']);
    assert.ok(requests.every(r => r.model === 'custom-fallback-fixture'));
  } finally { globalThis.fetch = original; }
});

test('network loss, tool-only incomplete streams and server errors never retry inference', async () => {
  const original = globalThis.fetch;
  try {
    for (const fixture of ['network', 'stream', 'server']) {
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        if (fixture === 'network') throw Error('ECONNRESET');
        if (fixture === 'server') return new Response('server failed', { status: 500 });
        return new Response(`data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'custom_tool_call', call_id: 'p', name: 'apply_patch', input: patch } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      };
      await assert.rejects(openaiProvider.run(call(`custom-${fixture}-fixture`)));
      assert.equal(requests, 1);
    }
  } finally { globalThis.fetch = original; }
});

test('workspace bash parks under outbound approvals while knowledge retains its write policy', async () => {
  const environment = { RIMEWARD_DESKTOP: process.env.RIMEWARD_DESKTOP, RIMEWARD_NATIVE_TOKEN: process.env.RIMEWARD_NATIVE_TOKEN, RIMEWARD_DOCUMENTS_DIR: process.env.RIMEWARD_DOCUMENTS_DIR };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-bash-policy-'));
  const globals = globalThis as typeof globalThis & { __nativeVault?: () => Promise<string> }, vault = globals.__nativeVault;
  const original = TOOLS.bash!, priorRun = codexProvider.run, priorContext = codexProvider.context;
  Object.assign(process.env, { RIMEWARD_DESKTOP: '1', RIMEWARD_NATIVE_TOKEN: 'test-only', RIMEWARD_DOCUMENTS_DIR: folder });
  globals.__nativeVault = async () => '[]';
  try {
    const user = localOwner(), ward = 'bash-policy';
    saveDashboard(user, [{ i: ward, type: 'agent', size: '2x2', config: { provider: 'codex', approvals: 'outbound' } }]);
    codexProvider.context = async () => undefined;
    assert.ok(!aiTools('read-only').some(t => t.name === 'bash'), 'read-only/monitor policy cannot call bash');
    for (const scope of [undefined, 'workspace', 'knowledge'] as const) {
      retireConversation(user, ward);
      const conv = activeConversation(user, ward, 'codex'); retainConversationTools(conv, ['bash']);
      let executions = 0, rounds = 0;
      TOOLS.bash = { ...original, backgroundable: false, run: () => { executions++; return { exit_code: 0 }; } };
      codexProvider.run = async request => {
        if (rounds++ === 0) {
          assert.ok(request.tools.some(t => t.name === 'bash'));
          const call = { call_id: 'scope-call', name: 'bash', arguments: JSON.stringify({ reason: 'Inspect the fixture', command: 'pwd', ...(scope ? { scope } : {}) }) };
          return { text: '', calls: [call], items: [{ type: 'function_call', ...call }] };
        }
        return { text: 'done', calls: [], items: [] };
      };
      const items: unknown[] = [];
      const first = await runLoop({ provider: codexProvider, conv, wardCfg: agentWardConfig(user, ward)!, headless: false }, items);
      if (scope === 'knowledge') { assert.equal(first.pending, undefined); assert.equal(first.steps[0]?.kind, 'write'); }
      else {
        assert.ok(first.pending); assert.equal(executions, 0); appendItems(conv.id, items);
        const approved = await resolveConfirmTurn(user, ward, first.pending.confirmId, true, () => {});
        assert.equal(approved.steps[0]?.kind, 'confirm');
      }
      assert.equal(executions, 1); assert.equal(rounds, 2);
    }
  } finally {
    TOOLS.bash = original; codexProvider.run = priorRun; codexProvider.context = priorContext;
    if (vault) globals.__nativeVault = vault; else Reflect.deleteProperty(globals, '__nativeVault');
    for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
