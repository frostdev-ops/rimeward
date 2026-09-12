import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/lib/db.ts';
import { NOTES_CAP, NOTES_FILE, ensureNotes, workDir } from '../src/lib/agent/history.ts';
import { getDashboard, saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { getSetting, setSetting } from '../src/lib/settings.ts';
import { subscribeLogic } from '../src/lib/logic-engine.ts';
import {
  activeConversation,
  addMessage,
  appendItems,
  getConversation,
  loadItems,
  transcript,
} from '../src/lib/agent/conversations.ts';
import {
  bankFailure,
  specSheet,
  agentWardConfig,
  buildInstructions,
  detailedInstructions,
  claimConfirm,
  parkConfirm,
  resolveConfirmTurn,
  runCommand,
  runLoop,
  summarize,
  type AgentEvent,
  type LoopCfg,
} from '../src/lib/agent/core.ts';
import { TOOLS } from '../src/lib/agent/tools.ts';
import { completeCommand, parseCommand } from '../src/lib/agent/commands.ts';
import { agentRounds, parseRounds, ROUND_DEFAULT } from '../src/lib/agent/provider.ts';
import type { AgentProvider, ProviderResult } from '../src/lib/agent/provider.ts';
import { repairResponsesItems } from '../src/lib/agent/codex.ts';
import { getProvider } from '../src/lib/agent/provider.ts';
import { storeAttachment } from '../src/lib/agent/attachments.ts';

function seedUser(email: string, approvals: 'outbound' | 'all' | 'off' = 'outbound'): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  const id = (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
  saveDashboard(
    id,
    validateLayout([
      { i: 'ag1', type: 'agent', size: '2x2', config: { provider: 'codex', approvals } },
      { i: 'w1', type: 'weather', size: '2x1' },
    ])!
  );
  return id;
}

/** A scripted provider: each run() shifts the next canned result. */
function fakeProvider(script: ProviderResult[]): AgentProvider {
  return {
    id: 'codex',
    run: async request => {
      const missing = script[0]?.calls.filter(c => TOOLS[c.name] && !request.tools.some(t => t.name === c.name)) ?? [];
      if (missing.length) {
        const calls = [...new Set(missing.map(c => c.name))].map(name => call(`discover-${name}`,'search_tools',{ query:name,limit:10,reason:'Load the capability used by this fixture' }));
        return { text:'',calls,items:calls.map(c => ({ type:'function_call',...c })) };
      }
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      return next;
    },
    userItem: (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }),
    toolOutputItem: (callId, json) => ({ type: 'function_call_output', call_id: callId, output: json }),
    repairItems: repairResponsesItems,
  };
}

const call = (call_id: string, name: string, args: Record<string, unknown>) => ({
  call_id,
  name,
  arguments: JSON.stringify(args),
});

test('computer observations follow every tool reply in both dialects, including a declined pending approval', async () => {
  const original = TOOLS.computer_screenshot;
  try {
    TOOLS.computer_screenshot = { ...original!, run: async (_args, ctx) => {
      const image = await storeAttachment({ userId: ctx.userId, conversationId: ctx.conv, name: 'generated-observation.png', mime: 'image/png',
        bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
      return { file_id: image.id, device: 'test-device', observation: 'single-use-test' };
    } };
    for (const id of ['codex', 'openrouter'] as const) for (const pending of [false, true]) {
      const user = seedUser(`observation-${id}-${pending}@test`), provider = await getProvider(id);
      saveDashboard(user, [{ i: 'ag1', type: 'agent', size: '2x2', config: { provider: id, approvals: 'outbound' } }, { i: 'w1', type: 'weather', size: '2x1' }]);
      const conv = activeConversation(user, 'ag1', id), previousRun = provider.run, previousContext = provider.context;
      const calls = [call('screen', 'computer_screenshot', { reason: 'Observe generated fixture' }), call('other', pending ? 'remove_ward' : 'get_layout', { ward: 'w1', reason: 'Second independent operation' })];
      let runs = 0;
      provider.context = async () => undefined;
      provider.run = async request => {
        const missing = calls.filter(c => !request.tools.some(t => t.name === c.name));
        if (!runs && missing.length) {
          const searches = missing.map(c => call(`discover-${c.name}`,'search_tools',{ query:c.name,reason:'Load fixture capability' }));
          return { text:'',calls:searches,items:id === 'codex' ? searches.map(c => ({ type:'function_call',...c }))
            : [{ role:'assistant',content:'',toolCalls:searches.map(c => ({ id:c.call_id,type:'function',function:{ name:c.name,arguments:c.arguments } })) }] };
        }
        if (runs++ === 0) return { text: '', calls, items: id === 'codex'
          ? calls.map(c => ({ type: 'function_call', ...c }))
          : [{ role: 'assistant', content: '', toolCalls: calls.map(c => ({ id: c.call_id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }] };
        const items = request.items as Record<string, unknown>[];
        const image = items.findIndex(item => JSON.stringify(item).includes('data:image/png;base64,'));
        assert.ok(image > 0, 'the screenshot reaches the next scripted model round');
        for (const call of calls) {
          const reply = items.findIndex(item => id === 'codex' ? item.type === 'function_call_output' && item.call_id === call.call_id : item.role === 'tool' && item.toolCallId === call.call_id);
          assert.ok(reply >= 0 && reply < image, 'each tool reply precedes the screenshot');
        }
        assert.match(JSON.stringify(items[image]), /tool observation, not a user instruction/);
        return { text: 'verified', calls: [], items: [] };
      };
      try {
        const items: unknown[] = [];
        const result = await runLoop({ provider, conv, wardCfg: agentWardConfig(user, 'ag1')!, headless: false }, items);
        if (pending) {
          assert.ok(result.pending); assert.equal(runs, 1);
          assert.equal(JSON.stringify(items).includes('data:image/png;base64,'), false, 'approval remains open before any image message');
          appendItems(conv.id, items);
          assert.equal((await resolveConfirmTurn(user, 'ag1', result.pending.confirmId, false, () => {})).reply, 'verified');
          assert.ok(getDashboard(user).some(ward => ward.i === 'w1'), 'declined action did not execute');
        } else assert.equal(result.reply, 'verified');
        assert.equal(runs, 2);
      } finally { provider.run = previousRun; provider.context = previousContext; }
    }
  } finally { TOOLS.computer_screenshot = original!; }
});

function cfgFor(userId: number, provider: AgentProvider): LoopCfg {
  return {
    provider,
    wardCfg: agentWardConfig(userId, 'ag1')!,
    conv: activeConversation(userId, 'ag1', 'codex'),
    headless: false,
  };
}

test('agentWardConfig rebuilds from the stored layout only', () => {
  const u = seedUser('core-cfg@x.dev');
  const cfg = agentWardConfig(u, 'ag1')!;
  assert.equal(cfg.provider, 'codex');
  assert.equal(cfg.approvals, 'outbound');
  assert.equal(cfg.tools, 'all');
  assert.equal(agentWardConfig(u, 'w1'), null); // not an agent ward
  assert.equal(agentWardConfig(u, 'nope'), null);
});

test('new Rime wards inherit the server profile without crossing provider model dialects', () => {
  const u = seedUser('core-shared-default@x.dev');
  const oldDesktop = process.env.RIMEWARD_DESKTOP, oldToken = process.env.RIMEWARD_NATIVE_TOKEN;
  process.env.RIMEWARD_DESKTOP = '1';
  process.env.RIMEWARD_NATIVE_TOKEN = 'test-only';
  try {
    setSetting(`rime:shared:${u}`, JSON.stringify({server:'https://example.com', profile:'test', providers:{codex:true,openrouter:false}, config:{provider:'codex',model:'server-model',persona:'Shared persona'}}));
    saveDashboard(u, validateLayout([
      {i:'default',type:'agent',size:'2x2'},
      {i:'override',type:'agent',size:'2x2',config:{provider:'openrouter'}},
    ])!);
    assert.equal(agentWardConfig(u,'default')?.provider,'codex');
    assert.equal(agentWardConfig(u,'default')?.model,'server-model');
    assert.equal(agentWardConfig(u,'default')?.persona,'Shared persona');
    assert.equal(agentWardConfig(u,'override')?.provider,'openrouter');
    assert.notEqual(agentWardConfig(u,'override')?.model,'server-model');
  } finally {
    if(oldDesktop===undefined)delete process.env.RIMEWARD_DESKTOP;else process.env.RIMEWARD_DESKTOP=oldDesktop;
    if(oldToken===undefined)delete process.env.RIMEWARD_NATIVE_TOKEN;else process.env.RIMEWARD_NATIVE_TOKEN=oldToken;
  }
});

test('runLoop: missing reason is rejected and the model is told to retry', async () => {
  const u = seedUser('core-reason@x.dev');
  const provider = fakeProvider([
    { text: '', calls: [call('c1', 'get_layout', {})], items: [{ type: 'function_call', call_id: 'c1', name: 'get_layout', arguments: '{}' }] },
    { text: 'done', calls: [], items: [] },
  ]);
  const items: unknown[] = [];
  const turn = await runLoop(cfgFor(u, provider), items);
  assert.equal(turn.reply, 'done');
  const output = items.find((it: any) => it.type === 'function_call_output' && it.call_id === 'c1') as any;
  assert.match(String(output.output), /requires a `reason`/);
});

test('runLoop: unknown tool and throwing tool are model-visible, never fatal', async () => {
  const u = seedUser('core-err@x.dev');
  const provider = fakeProvider([
    {
      text: '',
      calls: [call('c1', 'no_such_tool', { reason: 'r' }), call('c2', 'list_packets', { reason: 'r', ward: 'nope' })],
      items: [],
    },
    { text: 'ok', calls: [], items: [] },
  ]);
  const items: unknown[] = [];
  const turn = await runLoop(cfgFor(u, provider), items);
  assert.equal(turn.reply, 'ok');
  const o1 = items.find((it: any) => it.call_id === 'c1') as any;
  assert.match(String(o1.output), /no such tool/);
  const o2 = items.find((it: any) => it.call_id === 'c2') as any;
  assert.match(String(o2.output), /no flow ward/);
});

test('runLoop: a confirm-gated call parks after its batch ran; a second gated call is answered', async () => {
  const u = seedUser('core-confirm@x.dev');
  const provider = fakeProvider([
    {
      text: 'removing',
      calls: [
        call('c1', 'remove_ward', { reason: 'r', ward: 'w1' }),
        call('c2', 'get_layout', { reason: 'r' }),
        call('c3', 'remove_ward', { reason: 'r', ward: 'ag1' }),
      ],
      items: [],
    },
  ]);
  const items: unknown[] = [];
  const events: AgentEvent[] = [];
  const turn = await runLoop(cfgFor(u, provider), items, (e) => events.push(e));
  assert.ok(turn.pending, 'turn parked');
  assert.match(turn.pending!.summary, /Remove the “Weather” ward/);
  // The read beside it still ran — the batch settles before the pause.
  const read = items.find((it: any) => it.call_id === 'c2') as any;
  assert.ok(JSON.parse(String(read.output)).layout, 'the independent read ran');
  // The other gated call got a synthetic answer; only c1 stays open.
  const behind = items.find((it: any) => it.call_id === 'c3') as any;
  assert.match(String(behind.output), /waiting on the user to confirm remove_ward/);
  assert.ok(!items.some((it: any) => it.call_id === 'c1'), 'the parked call is unanswered on purpose');
  assert.equal(getDashboard(u).length, 2, 'nothing removed yet');
  // And the row round-trips through the KV claim.
  const conv = getConversation(activeConversation(u, 'ag1', 'codex').id)!;
  const parked = claimConfirm(u, conv, turn.pending!.confirmId);
  assert.equal(parked.name, 'remove_ward');
});

test("runLoop runs a round's calls concurrently, streams every start first, and answers in call order", async () => {
  const u = seedUser('core-par@x.dev');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const params = { type: 'object', properties: {}, required: [] };
  // slow_probe cannot finish until fast_probe has RUN: one-after-another
  // execution deadlocks here, and the race below turns that into a failure.
  TOOLS.slow_probe = { kind: 'read', description: 't', parameters: params, run: async () => (await gate, { slow: true }) };
  TOOLS.fast_probe = { kind: 'read', description: 't', parameters: params, run: () => (release(), { fast: true }) };
  try {
    const provider = fakeProvider([
      { text: '', calls: [call('c1', 'slow_probe', { reason: 'slow' }), call('c2', 'fast_probe', { reason: 'fast' })], items: [] },
      { text: 'fin', calls: [], items: [] },
    ]);
    const items: unknown[] = [];
    const events: AgentEvent[] = [];
    const turn = await Promise.race([
      runLoop(cfgFor(u, provider), items, (e) => events.push(e)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the calls ran one after another')), 3000).unref()),
    ]);
    assert.equal(turn.reply, 'fin');
    // Both starts stream before either finish, and the finishes stream as they land.
    const flow = events.filter((e) => e.type === 'step_start' && e.tool !== 'search_tools' || e.type === 'step' && e.step.tool !== 'search_tools');
    assert.deepEqual(flow.map((e) => e.type), ['step_start', 'step_start', 'step', 'step']);
    assert.equal((flow[2] as { step: { tool: string } }).step.tool, 'fast_probe');
    // The record and the replay are in CALL order, tagged with the round.
    assert.deepEqual(turn.steps.filter(s => s.tool !== 'search_tools').map((s) => [s.id, s.round, s.tool]), [['c1', 1, 'slow_probe'], ['c2', 1, 'fast_probe']]);
    const outs = items.filter((it: any) => it.type === 'function_call_output' && !it.call_id.startsWith('discover-')).map((it: any) => it.call_id);
    assert.deepEqual(outs, ['c1', 'c2']);
  } finally {
    delete TOOLS.slow_probe;
    delete TOOLS.fast_probe;
  }
});

test('approvals policy: off runs confirm tools inline; all pauses writes', async () => {
  const uOff = seedUser('core-off@x.dev', 'off');
  const off = await runLoop(
    cfgFor(uOff, fakeProvider([
      { text: '', calls: [call('c1', 'remove_ward', { reason: 'r', ward: 'w1' })], items: [] },
      { text: 'gone', calls: [], items: [] },
    ])),
    []
  );
  assert.equal(off.pending, undefined);
  assert.equal(getDashboard(uOff).length, 1, 'ward actually removed with approvals off');

  const uAll = seedUser('core-all@x.dev', 'all');
  const all = await runLoop(
    cfgFor(uAll, fakeProvider([
      { text: '', calls: [call('c1', 'resize_ward', { reason: 'r', ward: 'w1', size: '2x2' })], items: [] },
    ])),
    []
  );
  assert.ok(all.pending, 'plain write paused under approvals=all');
});

test('headless runs auto-decline what the policy would park', async () => {
  const u = seedUser('core-headless@x.dev');
  const cfg = { ...cfgFor(u, fakeProvider([
    { text: '', calls: [call('c1', 'remove_ward', { reason: 'r', ward: 'w1' })], items: [] },
    { text: 'skipped it', calls: [], items: [] },
  ])), headless: true };
  const items: unknown[] = [];
  const turn = await runLoop(cfg, items);
  assert.equal(turn.pending, undefined);
  assert.equal(getDashboard(u).length, 2, 'nothing removed');
  const declined = items.find((it: any) => it.call_id === 'c1') as any;
  assert.match(String(declined.output), /declined/);
  assert.equal(turn.reply, 'skipped it');
});

test('oversized tool output is omitted without implying failure or encouraging repeated writes', async () => {
  const u = seedUser('core-big@x.dev');
  // The exec registry is the seam (same pattern as tests/logic-engine.test.ts).
  TOOLS.huge_probe = {
    kind: 'read',
    description: 'test probe',
    parameters: { type: 'object', properties: {}, required: [] },
    run: () => ({ blob: 'x'.repeat(30_000) }),
  };
  try {
    const provider = fakeProvider([
      { text: '', calls: [call('c1', 'huge_probe', { reason: 'r' })], items: [] },
      { text: 'fin', calls: [], items: [] },
    ]);
    const items: unknown[] = [];
    await runLoop(cfgFor(u, provider), items);
    const out = items.find((it: any) => it.call_id === 'c1') as any;
    // Not a slice: the model must get well-formed JSON that says what happened.
    const parsed = JSON.parse(String(out.output));
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.resultOmitted, true);
    assert.match(parsed.note, /do not repeat an operation/);
    assert.ok(String(out.output).length < 12_000);
  } finally {
    delete TOOLS.huge_probe;
  }
});

test('the agent ward\'s conversation rides on the tool ctx, not a module global', async () => {
  const u = seedUser('core-ctx@x.dev');
  let sawCtx: any = null;
  TOOLS.ctx_probe = {
    kind: 'read',
    description: 'test probe',
    parameters: { type: 'object', properties: {}, required: [] },
    run: (_a, ctx) => {
      sawCtx = ctx;
      return { ok: true };
    },
  };
  try {
    const conv = activeConversation(u, 'ag1', 'codex');
    const provider = fakeProvider([
      { text: '', calls: [call('c1', 'ctx_probe', { reason: 'r' })], items: [] },
      { text: 'fin', calls: [], items: [] },
    ]);
    await runLoop(cfgFor(u, provider), []);
    assert.equal(sawCtx.userId, u);
    assert.equal(sawCtx.ward, 'ag1');
    assert.equal(sawCtx.conv, conv.id, 'conversation id came from the ctx');
  } finally {
    delete TOOLS.ctx_probe;
  }
});

test('a confirm whose call fell out of the replay is refused, not run', async () => {
  const u = seedUser('core-orphan@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  const pending = parkConfirm(conv, { call_id: 'gone', name: 'remove_ward', args: { ward: 'w1' } });
  // The conversation never held that function_call (compaction/truncation).
  const turn = await resolveConfirmTurn(u, 'ag1', pending.confirmId, true, () => {});
  assert.match(turn.reply, /aged out/);
  assert.equal(getDashboard(u).length, 2, 'the side effect did NOT run');
});

test('a resumed confirm files each interjection\'s steps once and keeps the approved step', async () => {
  const u = seedUser('core-resume-file@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  const provider = await getProvider('codex'), previousRun = provider.run;
  const fake = fakeProvider([
    { text: '', calls: [call('p1', 'remove_ward', { ward: 'w1', reason: 'r' })], items: [{ type: 'function_call', ...call('p1', 'remove_ward', { ward: 'w1', reason: 'r' }) }] },
    { text: 'one', calls: [call('c1', 'get_layout', { reason: 'r' })], items: [{ type: 'function_call', ...call('c1', 'get_layout', { reason: 'r' }) }] },
    { text: 'two', calls: [call('c2', 'get_layout', { reason: 'r' })], items: [{ type: 'function_call', ...call('c2', 'get_layout', { reason: 'r' }) }] },
    { text: 'done', calls: [], items: [] },
  ]);
  provider.run = fake.run;
  try {
    const items: unknown[] = [];
    const first = await runLoop(cfgFor(u, fake), items);
    assert.ok(first.pending, 'remove_ward waits for approval');
    appendItems(conv.id, items);
    const turn = await resolveConfirmTurn(u, 'ag1', first.pending.confirmId, true, () => {});
    assert.equal(turn.reply, 'done');
    const said = transcript(conv.id).filter((m) => m.role === 'assistant').slice(-3);
    assert.deepEqual(said.map((m) => m.text), ['one', 'two', 'done']);
    // The fixture's search_tools detour is filed under "one" too; only the scripted ids matter here.
    const scripted = said.map((m) => (m.steps ?? []).map((s) => s.id).filter((id) => ['p1', 'c1', 'c2'].includes(String(id))));
    assert.deepEqual(scripted, [[], ['c1'], ['p1', 'c2']], 'no step is filed twice and the approved step is kept');
  } finally { provider.run = previousRun; }
});

test('confirm KV: consume-once, echo mismatch, cross-user probe burns the row', () => {
  const u1 = seedUser('core-kv1@x.dev');
  const u2 = seedUser('core-kv2@x.dev');
  const conv = activeConversation(u1, 'ag1', 'codex');
  const pending = parkConfirm(conv, { call_id: 'k1', name: 'send_mail', args: { to: ['a@b.c'], subject: 's', body: 'hey' } });
  assert.match(pending.summary, /Email a@b.c/);

  const fresh = getConversation(conv.id)!;
  // Wrong echo id rejected without consuming.
  assert.throws(() => claimConfirm(u1, fresh, 'A'.repeat(24)), /no longer current/);
  // Cross-user probe: consumed FIRST, then rejected — the row burns.
  assert.throws(() => claimConfirm(u2, fresh, pending.confirmId), /not your confirmation/);
  assert.equal(getSetting(`agent_confirm:${pending.confirmId}`), null, 'row burned');
  // The rightful owner now finds it gone.
  const again = getConversation(conv.id)!;
  assert.throws(() => claimConfirm(u1, { ...again, pending_confirm_id: pending.confirmId }, pending.confirmId), /expired or already decided/);
});

test('summarize is DB-derived for confirm tools and generic otherwise', () => {
  const u = seedUser('core-sum@x.dev');
  assert.match(summarize('remove_ward', { ward: 'w1' }, u), /Weather/);
  assert.match(summarize('mystery_tool', { reason: 'do the thing' }, u), /do the thing — go ahead\?/);
});

// The ward's context indicator: every round says how full the thread is
// against the fold threshold, and what the provider billed.
test('runLoop emits full-request token estimates anchored to usage, without invented capacity', async () => {
  const u = seedUser('core-usage@x.dev');
  const provider = fakeProvider([
    { text: '', calls: [call('c1', 'get_layout', { reason: 'r' })], items: [{ type: 'message', role: 'assistant', content: 'x'.repeat(1000) }], usage: { input: 50_000, cached: 40_000 } },
    { text: 'done', calls: [], items: [] },
  ]);
  const usage: Extract<AgentEvent, { type: 'usage' }>[] = [];
  await runLoop(cfgFor(u, provider), [], (e) => { if (e.type === 'usage') usage.push(e); });
  assert.equal(usage.length, 3, 'one per model round, including discovery');
  assert.equal(usage[1]!.input, 50_000);
  assert.equal(usage[1]!.cached, 40_000);
  assert.equal(usage[0]!.compactAt, null);
  assert.equal(usage[0]!.source, 'unknown');
  assert.ok(usage[1]!.tokens > 50_000, 'includes measured instructions/tools and the new reply');
  assert.ok(usage[2]!.tokens > usage[1]!.tokens, 'grows with the tool result');
  assert.equal(usage[2]!.input, 50_000, 'keeps the last measured input when billing is absent');
});

test('runLoop banks work every round, not only at the end of the turn', async () => {
  const u = seedUser('core-flush@x.dev');
  let flushes = 0;
  const provider = fakeProvider([
    { text: '', calls: [call('c1', 'get_layout', { reason: 'r' })], items: [] },
    { text: '', calls: [call('c2', 'get_layout', { reason: 'r' })], items: [] },
    { text: 'done', calls: [], items: [] },
  ]);
  // Without the per-round flush a pm2 reload mid-turn loses the outputs of
  // tools that already ran, and the next load tells the model "nothing was done".
  await runLoop(cfgFor(u, provider), [], undefined, () => void flushes++);
  assert.equal(flushes, 3, 'one bank per round that executed tools, including discovery');
});

// A turn that threw (the relay dropped mid-request) used to leave nothing in the
// transcript: a dozen tool calls' work vanished from the UI on reload, /history
// never saw them, and the next compaction folded the items into a brief that
// pointed at a "verbatim transcript" missing the whole turn.
test('bankFailure records what a thrown turn said and did', () => {
  const u = seedUser('core-bank@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  bankFailure(
    conv,
    [
      { type: 'thinking', round: 0 },
      { type: 'step', step: { tool: 'get_layout', kind: 'read', args: {}, reason: 'r' } },
      { type: 'says', text: 'Half way: two findings so far.' },
      { type: 'step', step: { tool: 'bash', kind: 'write', args: { command: 'ls' }, reason: 'r' } },
    ],
    new Error('The Rime server disconnected during the model request. Retry when ready.')
  );
  const last = transcript(conv.id).at(-1)!;
  assert.equal(last.role, 'assistant');
  assert.match(last.text, /Half way: two findings so far\./);
  assert.match(last.text, /Failed: The Rime server disconnected/);
  assert.deepEqual(last.steps?.map((s) => s.tool), ['get_layout', 'bash']);
  const mirror = fs.readFileSync(path.join(workDir(u), '..', 'history', `${conv.id}.md`), 'utf8');
  assert.match(mirror, /tool bash\(\{"command":"ls"\}\)/, 'the disk mirror carries the steps too');
});

// The other half of the prod failure: the agent was told `notify.flash [global]
// (text*)` and had no way to know 60 was the ceiling. Every capped param must
// state its cap, or the only way to find one is to trip over it.
test('specSheet states every param length cap', () => {
  const sheet = specSheet();
  assert.match(sheet, /notify\.flash \[global\] \(text\*≤60\)/);
  assert.match(sheet, /speak\.say \[global\] \(text\*≤200\)/);
  // Options and caps coexist on one param list.
  assert.match(sheet, /account\*∈\{google\|microsoft\|zoho\|mailbox\}/);
  // Nothing capped may be printed bare.
  for (const line of sheet.split('\n')) {
    assert.ok(!/\(text\*?\)/.test(line), `uncapped text param in: ${line}`);
  }
});

// ------------------------------------------------------------------- rounds

test('agentRounds: unset is the default, 0 is unlimited, garbage never uncaps', () => {
  assert.equal(agentRounds(7777), ROUND_DEFAULT);
  for (const [stored, want] of [['1', 1], ['0', 0], ['500', 500], ['12.9', 12]] as const) {
    setSetting('agent_rounds:7777', stored);
    assert.equal(agentRounds(7777), want, stored);
  }
  // A bad value must fall back to the default, never to 0. '' is the one that
  // matters: Number('') is 0, so a cleared field would otherwise uncap the agent.
  for (const bad of ['', '   ', 'lots', '-1', 'NaN', 'Infinity']) {
    setSetting('agent_rounds:7777', bad);
    assert.equal(agentRounds(7777), ROUND_DEFAULT, JSON.stringify(bad));
    assert.equal(parseRounds(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseRounds(null), null);
  assert.equal(parseRounds(0), 0);
});

// ------------------------------------------------------------------- notes

test('ensureNotes seeds a template once, then never overwrites the agent', () => {
  const file = path.join(workDir(4242), NOTES_FILE);
  fs.rmSync(file, { force: true });
  // First read writes the template and returns it.
  const seeded = ensureNotes(4242);
  assert.match(seeded, /^# Rime's notes/);
  assert.ok(fs.existsSync(file));
  // The agent's own rewrite survives — a seed on every turn would erase it.
  fs.writeFileSync(file, '\n  user prefers terse answers  \n');
  assert.equal(ensureNotes(4242), 'user prefers terse answers');
  // Emptied on purpose stays empty; it is not a missing file.
  fs.writeFileSync(file, '');
  assert.equal(ensureNotes(4242), '');
  // A runaway notes file must not eat the context window.
  fs.writeFileSync(file, 'x'.repeat(20_000));
  assert.equal(ensureNotes(4242).length, NOTES_CAP);
  // Per user: 4243 gets its own /work and its own fresh template.
  assert.match(ensureNotes(4243), /^# Rime's notes/);
  fs.rmSync(file, { force: true });
  fs.rmSync(path.join(workDir(4243), NOTES_FILE), { force: true });
});

test('every ward prompt carries /work/AGENTS.md verbatim, whatever the ward config', () => {
  const file = path.join(workDir(4244), NOTES_FILE);
  fs.writeFileSync(file, '# notes\nuser likes tabs, never spaces\n');
  const base = { provider: 'codex' as const, model: 'm', tools: 'all' as const, effort: 'medium' as const, headlessCap: 6 };
  for (const cfg of [
    { ...base, persona: '', approvals: 'outbound' as const },
    { ...base, persona: 'be a pirate', approvals: 'off' as const, tools: 'read-only' as const },
  ]) {
    const prompt = buildInstructions(cfg, 4244, 'agent-x');
    assert.match(prompt, /Your notes, verbatim:\n# notes\nuser likes tabs, never spaces/);
    assert.ok(prompt.includes(`/work/${NOTES_FILE}`));
  }
  fs.rmSync(file, { force: true });
});

test('the instructions are a stable, cacheable prefix: no clock, static bulk first, notes last', () => {
  const u = seedUser('core-cache@x.dev');
  const cfg = agentWardConfig(u, 'ag1')!;
  const a = buildInstructions(cfg, u, 'ag1');
  const b = buildInstructions(cfg, u, 'ag1');
  // Byte-identical across calls — a timestamp in here would miss the cache every turn.
  assert.equal(a, b);
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  // Detailed catalogs are discovered; standing notes remain after stable rules.
  assert.doesNotMatch(a,/Logic system spec|Current wards:/);
  assert.ok(a.indexOf('Your notes, verbatim:') > a.indexOf('search_tools'));
});

test('Rime inherits its own desktop project, including when nested, without adding desktop context on the server', () => {
  const u = seedUser('core-project@x.dev');
  const pages = [{ id: 'home', title: 'Home' }, { id: 'code', title: 'Project', project: 'project-one' }];
  saveDashboard(u, validateLayout([
    { i: 'group', type: 'container', size: '2x2', page: 'code' },
    { i: 'ag1', type: 'agent', size: '2x4', in: 'group' },
  ], pages)!, pages);
  const cfg = agentWardConfig(u, 'ag1')!;
  const desktop = process.env.RIMEWARD_DESKTOP, token = process.env.RIMEWARD_NATIVE_TOKEN;
  try {
    process.env.RIMEWARD_DESKTOP = '1'; process.env.RIMEWARD_NATIVE_TOKEN = 'test-only';
    assert.match(buildInstructions(cfg, u, 'ag1'), /Current desktop project:.*"project":"project-one"/);
    saveDashboard(u, getDashboard(u), [{ id: 'home', title: 'Home' }, { id: 'code', title: 'Project', project: 'project-two' }]);
    assert.match(buildInstructions(cfg, u, 'ag1'), /Current desktop project:.*"project":"project-two"/);
    process.env.RIMEWARD_DESKTOP = '0';
    assert.doesNotMatch(buildInstructions(cfg, u, 'ag1'), /Current desktop project:/);
  } finally {
    if (desktop === undefined) delete process.env.RIMEWARD_DESKTOP; else process.env.RIMEWARD_DESKTOP = desktop;
    if (token === undefined) delete process.env.RIMEWARD_NATIVE_TOKEN; else process.env.RIMEWARD_NATIVE_TOKEN = token;
  }
});

// ------------------------------------------------------------ slash commands

test('parseCommand matches known commands and aliases, never paths or prose', () => {
  assert.deepEqual(parseCommand('/clear'), { name: 'clear', args: '' });
  assert.deepEqual(parseCommand('  /CLEAR  '), { name: 'clear', args: '' });
  assert.deepEqual(parseCommand('/new'), { name: 'clear', args: '' });
  assert.deepEqual(parseCommand('/summarize'), { name: 'compact', args: '' });
  assert.deepEqual(parseCommand('/?'), { name: 'help', args: '' });
  // Everything after the command is the focus hint, kept verbatim.
  assert.deepEqual(parseCommand('/compact keep the notion work'), { name: 'compact', args: 'keep the notion work' });
  // Everything else is ordinary text for the model. A path or a typo that
  // errored here would be a worse failure than just answering it.
  for (const text of ['/usr/bin/x', '/opt is full', '/compct', 'clear', '', '/', 'tell me about /clear']) {
    assert.equal(parseCommand(text), null, `should be text: ${JSON.stringify(text)}`);
  }
});

test('/clear retires the thread and tells every other client', async () => {
  const u = seedUser('cmd-clear@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  addMessage(conv, { role: 'user', text: 'hello' });
  assert.equal(transcript(conv.id).length, 1);

  const seen: { event: string; data: any }[] = [];
  const off = subscribeLogic(u, (event, data) => seen.push({ event, data }));
  const res = await runCommand(u, 'ag1', 'clear');
  off();

  assert.equal(res.command, 'clear');
  assert.equal(getConversation(conv.id)!.active, 0, 'the old thread is archived, not deleted');
  assert.equal(transcript(conv.id).length, 1, 'its messages survive on disk');
  // A fresh thread starts empty — and the other clients are told to repaint.
  assert.notEqual(activeConversation(u, 'ag1', 'codex').id, conv.id);
  assert.ok(seen.some((s) => s.event === 'agent' && s.data.ward === 'ag1'));
});

test('/size and /compact report the thread, and /compact refuses mid-turn', async () => {
  const u = seedUser('cmd-size@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  const size = await runCommand(u, 'ag1', 'size');
  assert.match(size.text, /0 items/);

  appendItems(conv.id, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }]);
  // Under the 4-item floor there is no older half worth folding, and the
  // command says so rather than reporting a fold that did nothing.
  const short = await runCommand(u, 'ag1', 'compact');
  assert.match(short.text, /Nothing worth folding/);
});

test('completeCommand drives the popup: opens on "/", filters, closes on a space', () => {
  const names = (t: string) => completeCommand(t)?.map((c) => c.name) ?? null;
  // A bare slash offers everything, in catalog order.
  assert.deepEqual(names('/'), ['background', 'tasks', 'clear', 'compact', 'size', 'help']);
  assert.deepEqual(names('/c'), ['clear', 'compact']);
  assert.deepEqual(names('/co'), ['compact']);
  assert.deepEqual(names('/CL'), ['clear']);
  // Aliases are a typing shortcut, not menu rows — they must not silently pull
  // a command into a list where nothing explains the match.
  assert.equal(names('/sum'), null);
  assert.deepEqual(parseCommand('/summarize'), { name: 'compact', args: '' }, 'but it still runs');
  // Closed: not at the start, already typing arguments, or nothing matches.
  for (const text of ['', 'hi', 'tell me about /clear', '/compact now', '/ ', '/zzz']) {
    assert.equal(names(text), null, `menu must be closed for ${JSON.stringify(text)}`);
  }
});

test('every command the popup offers is one the server will actually run', () => {
  // The popup and the parser read one catalog; this is the guard that they stay
  // the same one. A command listed but unparsed would be a dead menu row.
  for (const c of completeCommand('/')!) {
    assert.deepEqual(parseCommand(`/${c.name}`), { name: c.name, args: '' }, `/${c.name} must parse`);
  }
});

// ------------------------------------------------------------ agent ↔ agent

test('peerAgents is the discovery registry: every OTHER agent ward, from the stored layout', async () => {
  const u = seedUser('core-peers@x.dev');
  const { peerAgents } = await import('../src/lib/agent/core.ts');
  const { askAgent } = await import('../src/lib/agent/inbox.ts');
  assert.deepEqual(peerAgents(u, 'ag1'), []);
  assert.doesNotMatch(buildInstructions(agentWardConfig(u, 'ag1')!, u, 'ag1'), /Other Rime agents/);

  saveDashboard(
    u,
    validateLayout([
      ...getDashboard(u),
      { i: 'ag2', type: 'agent', size: '2x2', title: 'Researcher', config: { provider: 'openrouter', persona: 'You dig up sources.\nCite them.' } },
    ])!
  );
  const peers = peerAgents(u, 'ag1');
  assert.equal(peers.length, 1);
  assert.equal(peers[0]!.ward, 'ag2');
  assert.equal(peers[0]!.title, 'Researcher');
  assert.equal(peers[0]!.busy, false);
  // The list_agents tool is that registry; ag2 sees ag1 and not itself.
  const seen = (await TOOLS.list_agents!.run({}, { userId: u, ward: 'ag2', conv: 0 })) as { agents: { ward: string }[] };
  assert.deepEqual(seen.agents.map((a) => a.ward), ['ag1']);
  // Discoverable guidance names the peer by title and first persona line.
  const prompt = detailedInstructions(agentWardConfig(u, 'ag1')!, u, 'ag1');
  assert.match(prompt, /ag2 \("Researcher": You dig up sources\.\)/);
  assert.ok(prompt.indexOf('Other Rime agents') > prompt.indexOf('Current wards:'));

  // askAgent's guards, cheapest first: self, unknown, the sync cycle, then credentials.
  const ctx = { userId: u, ward: 'ag1' };
  await assert.rejects(askAgent(ctx, 'ag1', 'hi'), /that is you/);
  await assert.rejects(askAgent(ctx, 'nope', 'hi'), /no agent ward "nope"/);
  await assert.rejects(askAgent({ ...ctx, via: ['ag2'] }, 'ag2', 'hi'), /waiting on YOUR answer/);
  await assert.rejects(askAgent(ctx, 'ag2', '   '), /say something/);
  // No provider is linked in tests, so the last gate is the one that fires —
  // for both the sync and the fire-and-forget path.
  await assert.rejects(askAgent(ctx, 'ag2', 'hi'), /openrouter is not configured/);
  await assert.rejects(askAgent({ ...ctx, via: ['ag2'] }, 'ag2', 'hi', { wait: false }), /openrouter is not configured/);
});

test('steer: a message queued mid-turn is the next round\'s user message, and one during the final call forces another round', async () => {
  const u = seedUser('core-steer@x.dev');
  const { steerTurn } = await import('../src/lib/agent/core.ts');
  const seen: unknown[][] = [];
  let receipt = '';
  const provider: AgentProvider = {
    ...fakeProvider([]),
    run: async (c) => {
      seen.push([...c.items]);
      if (seen.length === 1) {
        // A steer lands while the model is answering — with no calls pending.
        steerTurn(u, 'ag1', { text: 'also check the weather', from: 'user' });
        return { text: 'first answer', calls: [], items: [{ type: 'message', role: 'assistant', content: 'first answer' }] };
      }
      if (seen.length === 2) {
        steerTurn(u, 'ag1', { id: 7, text: 'and hurry', from: 'ag2', done: (r) => (receipt = r) });
        return { text: '', calls: [call('c1', 'get_layout', { reason: 'looking' })], items: [] };
      }
      return { text: 'final', calls: [], items: [] };
    },
  };
  const events: AgentEvent[] = [];
  const turn = await runLoop(cfgFor(u, provider), [provider.userItem('hi')], (e) => events.push(e));
  assert.equal(turn.reply, 'final');
  assert.equal(seen.length, 3);
  // Round 2 saw the user's steer after the first answer; round 3 saw the peer's.
  const text = (it: unknown) => JSON.stringify(it);
  assert.match(text(seen[1]!.at(-1)), /Sent while you were working[\s\S]*also check the weather/);
  assert.match(text(seen[2]!.at(-1)), /from \\"ag2\\" \(ward ag2\)[\s\S]*and hurry/);
  const users = events.filter((e) => e.type === 'user') as { text: string; source?: string }[];
  assert.deepEqual(users.map((e) => [e.text, e.source]), [['also check the weather', 'chat'], ['ag2 (mid-turn): and hurry', 'agent']]);
  assert.ok(events.some((e) => e.type === 'says' && e.text === 'first answer'));
  assert.equal(receipt, 'final', 'the absorbing turn closes the steer\'s receipt');
  // Both steers are in the transcript as user messages, stamped by origin.
  const t = transcript(activeConversation(u, 'ag1', 'codex').id).filter((m) => m.role === 'user');
  assert.deepEqual(t.map((m) => [m.text, m.source]), [['also check the weather', 'chat'], ['ag2 (mid-turn): and hurry', 'agent']]);
});

test('interrupt: aborts the call in flight, else ends the turn after the round it is in', async () => {
  const u = seedUser('core-interrupt@x.dev');
  const { interruptTurn, steerTurn } = await import('../src/lib/agent/core.ts');
  // Nothing running: nothing to stop.
  assert.equal(interruptTurn(u, 'ag1', 'the user'), false);

  // runLoop is not on the chain here, so the flag is set from inside the fake
  // provider — the same moment a Stop click would reach a running turn.
  const { setBusyForTest } = await import('../src/lib/agent/core.ts');
  setBusyForTest(u, 'ag1', true);
  let rounds = 0;
  const provider: AgentProvider = {
    ...fakeProvider([]),
    run: async (c) => {
      rounds++;
      if (rounds === 1) {
        assert.equal(interruptTurn(u, 'ag1', 'the user'), true);
        // The abort reached the in-flight call.
        assert.equal(c.signal?.aborted, true);
        throw new Error('codex: interrupted');
      }
      return { text: 'unreachable', calls: [], items: [] };
    },
  };
  const events: AgentEvent[] = [];
  const t1 = await runLoop(cfgFor(u, provider), [provider.userItem('go')], (e) => events.push(e));
  assert.equal(t1.reply, 'Interrupted by the user.');
  assert.equal(rounds, 1);

  // Round boundary: the batch's calls are answered first, then the turn ends.
  rounds = 0;
  const p2: AgentProvider = {
    ...fakeProvider([]),
    run: async () => {
      rounds++;
      if (rounds === 1) {
        assert.equal(interruptTurn(u, 'ag1', 'agent "Ops"'), true);
        return { text: '', calls: [call('c1', 'get_layout', { reason: 'looking' })], items: [{ type: 'function_call', call_id: 'c1', name: 'get_layout', arguments: '{}' }] };
      }
      return { text: 'unreachable', calls: [], items: [] };
    },
  };
  const items: unknown[] = [p2.userItem('go')];
  const t2 = await runLoop(cfgFor(u, p2), items);
  assert.equal(t2.reply, 'Interrupted by agent "Ops".');
  assert.equal(rounds, 1);
  assert.equal(t2.steps.length, 1, 'the call in the batch still ran and was answered');
  assert.ok(items.some((it) => (it as { call_id?: string }).call_id === 'c1' && (it as { type?: string }).type === 'function_call_output'));
  // A stale interrupt does not kill the next turn; a stale steer opens it.
  assert.equal(interruptTurn(u, 'ag1', 'the user'), true);
  setBusyForTest(u, 'ag1', false);
  steerTurn(u, 'ag1', { text: 'late note', from: 'user' });
  const seen: unknown[][] = [];
  const p3: AgentProvider = { ...fakeProvider([]), run: async (c) => (seen.push([...c.items]), { text: 'ok', calls: [], items: [] }) };
  const t3 = await runLoop(cfgFor(u, p3), [p3.userItem('next')]);
  assert.equal(t3.reply, 'ok');
  assert.match(JSON.stringify(seen[0]!.at(-1)), /late note/);
});


test('model usage triggers mid-turn compaction and persistence resumes without duplicated or missing items', async () => {
  const u = seedUser('core-dynamic-context@x.dev');
  const provider = fakeProvider([]);
  provider.context = async () => ({ window: 1_000_000, inputLimit: 950_000, compactAt: 900_000, source: 'catalog' });
  let rounds = 0, folds = 0;
  provider.run = async (request) => {
    if (request.instructions.startsWith('You are compacting')) {
      folds++;
      return { text: 'Earlier task details preserved in this brief.', calls: [], items: [] };
    }
    if (++rounds === 1) return { text: '', calls: [call('check', 'get_layout', { reason: 'Inspect layout' })],
      items: [{ type: 'function_call', call_id: 'check', name: 'get_layout', arguments: '{}' }], usage: { input: 910_000, cached: 0 } };
    assert.ok(request.items.some((it: any) => it.call_id === 'check' && it.type === 'function_call_output'));
    return { text: 'Finished', calls: [], items: [{ type: 'message', role: 'assistant', content: 'Finished' }] };
  };
  const cfg = cfgFor(u, provider);
  const items = Array.from({ length: 10 }, () => provider.userItem('Earlier instructions '.repeat(200)));
  appendItems(cfg.conv.id, items);
  let persisted = items.length;
  const flush = (reset = false) => {
    if (!reset) appendItems(cfg.conv.id, items.slice(persisted));
    persisted = items.length;
  };
  await runLoop(cfg, items, undefined, flush);
  flush();
  assert.equal(folds, 1);
  assert.equal(rounds, 2);
  assert.deepEqual(loadItems(cfg.conv, provider, new Set()), items);
});
