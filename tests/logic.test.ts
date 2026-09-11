import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS } from '../src/lib/targets.ts';
import type { WardInstance } from '../src/lib/wards.ts';
import { edgeMatches, renderTemplate, validateGraph } from '../src/lib/logic.ts';

const LAYOUT: WardInstance[] = [
  { i: 't1', type: 'timer', size: '1x1' },
  { i: 't2', type: 'timer', size: '1x1' },
  { i: 'f1', type: 'flow', size: '2x2' },
  { i: 'w1', type: 'weather', size: '2x1' },
  { i: 'sv1', type: 'service-group', size: '1x1', config: { services: [TARGETS[0]!.id] } },
  { i: 'sg1', type: 'service-group', size: '1x1', config: { services: [TARGETS[0]!.id] } },
  { i: 'h1', type: 'service-group', size: '2x1', config: { services: ['host:cpu', 'host:mem', 'host:disk'] } },
  { i: 'nu1', type: 'next-up', size: '1x1' },
  { i: 'c1', type: 'calendar', size: '2x2' },
  { i: 'b1', type: 'button', size: '1x1' },
  { i: 'np1', type: 'notion-page', size: '2x1', config: { show: ['add'] } },
  { i: 'nc1', type: 'notion-page', size: '2x1', title: 'Capture', config: { show: ['add'] } },
  { i: 'm1', type: 'mail', size: '2x2', config: { account: 'all' } },
  { i: 'g1', type: 'mail', size: '2x2', config: { account: 'google' } },
  { i: 'cl1', type: 'checklist', size: '2x2', config: { db: 'deadbeef-dead-beef-dead-beefdeadbeef' } },
  { i: 'nt1', type: 'notion-tasks', size: '2x2' },
];

const edge = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'e1',
  source: { ward: 't1', trigger: 'timer-finished', params: {} },
  conditions: [],
  action: { type: 'flow.emit', ward: 'f1', params: { channel: 'inbox', text: 'ping {{now}}' } },
  enabled: true,
  ...over,
});

const graph = (edges: unknown[], isAdmin = false) => validateGraph({ edges }, LAYOUT, { isAdmin });

test('validateGraph: valid graph round-trips, empty graph is valid', () => {
  const g = graph([edge()]);
  assert.ok(g);
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0]!.action.params, { channel: 'inbox', text: 'ping {{now}}' });
  assert.ok(validateGraph({ edges: [] }, LAYOUT, { isAdmin: false }));
});

test('validateGraph: garbage shapes and caps', () => {
  assert.equal(validateGraph(null, LAYOUT, { isAdmin: false }), null);
  assert.equal(validateGraph([], LAYOUT, { isAdmin: false }), null); // must be {edges}
  assert.equal(graph([{ nope: 1 }]), null);
  assert.equal(graph([edge({ id: 'BAD ID' })]), null);
  assert.equal(graph([edge(), edge()]), null); // dup ids
  const many = Array.from({ length: 65 }, (_, n) => edge({ id: `e${n}` }));
  assert.equal(graph(many), null);
});

test('validateGraph: source ward/trigger rules', () => {
  assert.equal(graph([edge({ source: { ward: 't1', trigger: 'nope', params: {} } })]), null);
  assert.equal(graph([edge({ source: { ward: 'gone', trigger: 'timer-finished', params: {} } })]), null);
  // wrong ward type for the trigger
  assert.equal(graph([edge({ source: { ward: 'w1', trigger: 'timer-finished', params: {} } })]), null);
  // packet-arrived channel filter validated as a channel
  assert.ok(graph([edge({ source: { ward: 'f1', trigger: 'packet-arrived', params: { channel: 'inbox' } } })]));
  assert.equal(graph([edge({ source: { ward: 'f1', trigger: 'packet-arrived', params: { channel: 'NOT OK' } } })]), null);
});

test('validateGraph: conditions', () => {
  const cond = (type: string, params: Record<string, unknown>) => graph([edge({ conditions: [{ type, params }] })]);
  assert.equal(cond('nope', {}), null);
  assert.equal(cond('packet-text-matches', {}), null); // pattern required
  assert.ok(cond('packet-text-matches', { pattern: 'urgent' }));
  assert.equal(cond('packet-text-matches', { pattern: 'x'.repeat(101) }), null);
  const six = Array.from({ length: 6 }, () => ({ type: 'packet-text-matches', params: { pattern: 'x' } }));
  assert.equal(graph([edge({ conditions: six })]), null);
  // notion-id: raw hex, dashed, or pasted URL all normalize to dashed
  const hex = 'deadbeefdeadbeefdeadbeefdeadbeef';
  const dashed = 'deadbeef-dead-beef-dead-beefdeadbeef';
  for (const v of [hex, dashed, `https://www.notion.so/me/Task-${hex}?pvs=4`]) {
    const g = cond('notion-task-done', { pageId: v });
    assert.ok(g);
    assert.equal(g.edges[0]!.conditions[0]!.params.pageId, dashed);
  }
  assert.equal(cond('notion-task-done', { pageId: 'deadbeef' }), null);
});

test('validateGraph: action rules', () => {
  assert.equal(graph([edge({ action: { type: 'nope', params: {} } })]), null);
  // wardType-bound action must name a ward of that type
  assert.equal(graph([edge({ action: { type: 'flow.emit', params: { channel: 'a', text: 'x' } } })]), null);
  assert.equal(graph([edge({ action: { type: 'flow.emit', ward: 't1', params: { channel: 'a', text: 'x' } } })]), null);
  assert.equal(graph([edge({ action: { type: 'flow.emit', ward: 'f1', params: { text: 'x' } } })]), null); // channel required
  assert.ok(graph([edge({ action: { type: 'timer.start', ward: 't2', params: { durationSec: 300 } } })]));
  assert.equal(graph([edge({ action: { type: 'timer.start', ward: 't2', params: { durationSec: 0 } } })]), null);
  assert.equal(graph([edge({ action: { type: 'timer.start', ward: 't2', params: { durationSec: 90000 } } })]), null);
  // unknown raw params are dropped, not fatal
  const g = graph([edge({ action: { type: 'timer.reset', ward: 't2', params: { evil: 'x' } } })]);
  assert.deepEqual(g!.edges[0]!.action.params, {});
  // enabled defaults to true unless explicitly false
  assert.equal(graph([edge({ enabled: undefined })])!.edges[0]!.enabled, true);
  assert.equal(graph([edge({ enabled: false })])!.edges[0]!.enabled, false);
});

test('validateGraph: mail, youtube, webhook param rules + admin gate', () => {
  const mail = (params: Record<string, unknown>) => graph([edge({ action: { type: 'mail.send', params } })]);
  assert.ok(mail({ account: 'google', to: ['a@b.co'], body: 'hi' }));
  assert.equal(mail({ account: 'yahoo', to: ['a@b.co'], body: 'hi' }), null);
  assert.equal(mail({ account: 'google', to: ['not-an-email'], body: 'hi' }), null);
  assert.equal(mail({ account: 'google', to: [], body: 'hi' }), null);
  assert.equal(mail({ account: 'google', to: Array.from({ length: 6 }, (_, i) => `a${i}@b.co`), body: 'hi' }), null);

  const yt = (videoId: string) => graph([edge({ action: { type: 'youtube.play', params: { videoId } } })]);
  assert.ok(yt('dQw4w9WgXcQ'));
  assert.equal(yt('short'), null);
  assert.equal(yt('bad chars!!!'), null);

  const hook = (isAdmin: boolean, url = 'https://agent.frostdev.io/hook') =>
    graph([edge({ action: { type: 'webhook.post', params: { url } } })], isAdmin);
  assert.equal(hook(false), null); // adminOnly
  assert.ok(hook(true));
  assert.equal(hook(true, 'ftp://x'), null);
});

test('edgeMatches: trigger/ward/channel filter + enabled', () => {
  const g = graph([edge({ source: { ward: 'f1', trigger: 'packet-arrived', params: { channel: 'inbox' } } })])!;
  const e = g.edges[0]!;
  assert.ok(edgeMatches(e, { type: 'packet-arrived', ward: 'f1', channel: 'inbox' }));
  assert.ok(!edgeMatches(e, { type: 'packet-arrived', ward: 'f1', channel: 'other' }));
  assert.ok(!edgeMatches(e, { type: 'packet-passed', ward: 'f1', channel: 'inbox' }));
  assert.ok(!edgeMatches(e, { type: 'packet-arrived', ward: 't1', channel: 'inbox' }));
  assert.ok(!edgeMatches({ ...e, enabled: false }, { type: 'packet-arrived', ward: 'f1', channel: 'inbox' }));
  // no channel filter → matches any channel
  const any = graph([edge({ source: { ward: 'f1', trigger: 'packet-arrived', params: {} } })])!.edges[0]!;
  assert.ok(edgeMatches(any, { type: 'packet-arrived', ward: 'f1', channel: 'whatever' }));
});

test('watcher triggers: filter params, minutes/percent kinds', () => {
  // service-status `to` is a filtered select
  const svc = (params: Record<string, unknown>) =>
    graph([edge({ source: { ward: 'sv1', trigger: 'service-status', params }, action: { type: 'notion.capture-append', params: { text: 'x' } } })]);
  assert.ok(svc({}));
  assert.ok(svc({ to: 'down' }));
  assert.equal(svc({ to: 'sideways' }), null);
  // weather-turned lives on weather wards only
  assert.ok(graph([edge({ source: { ward: 'w1', trigger: 'weather-turned', params: { to: 'rain' } }, action: { type: 'notion.capture-append', params: { text: 'x' } } })]));
  assert.equal(graph([edge({ source: { ward: 't1', trigger: 'weather-turned', params: {} }, action: { type: 'notion.capture-append', params: { text: 'x' } } })]), null);
  // every: minutes kind 1..1440, required
  const every = (params: Record<string, unknown>) =>
    graph([edge({ source: { ward: 't1', trigger: 'every', params }, action: { type: 'notion.capture-append', params: { text: 'x' } } })]);
  assert.ok(every({ minutes: 15 }));
  assert.equal(every({}), null);
  assert.equal(every({ minutes: 0 }), null);
  assert.equal(every({ minutes: 2000 }), null);
  // host-above percent kind; service-is select from TARGETS
  const cond = (type: string, params: Record<string, unknown>) => graph([edge({ conditions: [{ type, params }] })]);
  assert.ok(cond('host-above', { metric: 'mem', pct: 90 }));
  assert.equal(cond('host-above', { metric: 'gpu', pct: 90 }), null);
  assert.equal(cond('host-above', { metric: 'mem', pct: 0 }), null);
  assert.ok(cond('service-is', { service: TARGETS[0]!.id, state: 'down' }));
  assert.equal(cond('service-is', { service: 'not-a-target', state: 'down' }), null);
});

test('multi-anchor triggers: notion-item on checklist AND notion-tasks, nowhere else', () => {
  const mk = (ward: string) =>
    graph([edge({ source: { ward, trigger: 'notion-item', params: { what: 'added' } }, action: { type: 'notion.capture-append', params: { text: '{{item.title}}' } } })]);
  assert.ok(mk('cl1'));
  assert.ok(mk('nt1'));
  assert.equal(mk('w1'), null);
  assert.equal(mk('t1'), null);
});

test('service-restarted and deploy-landed anchor on Services wards only', () => {
  const on = (ward: string, trigger: string) =>
    graph([edge({ source: { ward, trigger, params: {} }, action: { type: 'notion.capture-append', params: { text: '{{service.label}} {{build.stamp}}' } } })]);
  assert.ok(on('sv1', 'service-restarted'));
  assert.ok(on('sg1', 'service-restarted'));
  assert.ok(on('h1', 'service-restarted')); // a multi-member group validates; the watcher reports "needs a single-service ward" at runtime
  assert.equal(on('t1', 'service-restarted'), null);
  assert.ok(on('h1', 'deploy-landed'));
  assert.ok(on('sv1', 'deploy-landed'));
  assert.equal(on('w1', 'deploy-landed'), null);
  assert.equal(on('t1', 'deploy-landed'), null);
  assert.ok(on('sv1', 'update-available'));
  assert.equal(on('t1', 'update-available'), null);
});

test('service-group anchors the service and host triggers; next-up the event triggers', () => {
  const on = (ward: string, trigger: string, params: Record<string, unknown>) =>
    graph([edge({ source: { ward, trigger, params }, action: { type: 'notion.capture-append', params: { text: 'x' } } })]);
  assert.ok(on('sg1', 'service-slow', { ms: 500 }));
  assert.ok(on('sg1', 'service-status', {}));
  assert.ok(on('sg1', 'host-crossed', { metric: 'cpu', pct: 80 }));
  assert.equal(on('w1', 'service-slow', { ms: 500 }), null);
  assert.equal(on('w1', 'host-crossed', { metric: 'cpu', pct: 80 }), null);
  assert.ok(on('nu1', 'event-starting-soon', { withinMinutes: 5 }));
  assert.ok(on('c1', 'event-added', {}));
  assert.equal(on('w1', 'event-starting-soon', { withinMinutes: 5 }), null);
});

test('mail-arrived anchors on mail wards with an optional account filter; button-pressed on buttons', () => {
  const on = (ward: string, trigger: string, params: Record<string, unknown> = {}) =>
    graph([edge({ source: { ward, trigger, params }, action: { type: 'notion.capture-append', params: { text: '{{mail.account}}' } } })]);
  assert.ok(on('m1', 'mail-arrived'));
  assert.ok(on('g1', 'mail-arrived'));
  assert.ok(on('m1', 'mail-arrived', { account: 'zoho' }));
  assert.equal(on('m1', 'mail-arrived', { account: 'yahoo' }), null);
  assert.equal(on('w1', 'mail-arrived'), null);
  assert.ok(on('b1', 'button-pressed'));
  assert.equal(on('t1', 'button-pressed'), null);
  // an edge with no account param matches every account's firing
  const any = on('g1', 'mail-arrived')!.edges[0]!;
  assert.ok(edgeMatches(any, { type: 'mail-arrived', ward: 'g1', match: { account: 'google' } }));
  const zoho = on('m1', 'mail-arrived', { account: 'zoho' })!.edges[0]!;
  assert.ok(!edgeMatches(zoho, { type: 'mail-arrived', ward: 'm1', match: { account: 'google' } }));
});

test('notion-capture-appended anchors on page wards', () => {
  const on = (ward: string) => graph([edge({ source: { ward, trigger: 'notion-capture-appended', params: {} }, action: { type: 'notion.capture-append', params: { text: '{{capture.text}}' } } })]);
  assert.ok(on('np1'));
  assert.ok(on('nc1'));
  assert.equal(on('w1'), null);
});

test('timer-finished: a step filter matches a routine step and never a plain timer', () => {
  const mk = (params: Record<string, unknown>) =>
    graph([edge({ source: { ward: 't1', trigger: 'timer-finished', params }, action: { type: 'notion.capture-append', params: { text: '{{routine.step}}' } } })])!.edges[0]!;
  const focus = mk({ step: 'Focus' });
  assert.ok(edgeMatches(focus, { type: 'timer-finished', ward: 't1', match: { step: 'Focus' } }));
  assert.ok(!edgeMatches(focus, { type: 'timer-finished', ward: 't1', match: { step: 'Break' } }));
  assert.ok(!edgeMatches(focus, { type: 'timer-finished', ward: 't1' })); // a plain timer fires bare
  assert.ok(edgeMatches(mk({}), { type: 'timer-finished', ward: 't1' })); // existing edges: wildcard
  assert.equal(graph([edge({ source: { ward: 't1', trigger: 'timer-finished', params: { step: 'Nap' } } })]), null);
  assert.ok(graph([edge({ source: { ward: 't1', trigger: 'routine-finished', params: {} } })]));
});

test('degrees kind allows sub-zero temperatures; count does not', () => {
  const temp = (tempF: unknown) =>
    graph([edge({ source: { ward: 'w1', trigger: 'temp-crossed', params: { tempF } }, action: { type: 'notion.capture-append', params: { text: 'x' } } })]);
  assert.ok(temp(-10));
  assert.ok(temp(95));
  assert.equal(temp(-200), null);
  assert.equal(temp(200), null);
});

test('edgeMatches: filter params, wildcards, onlyEdge, non-filter config ignored', () => {
  const mk = (params: Record<string, unknown>) =>
    graph([edge({ source: { ward: 'sv1', trigger: 'service-status', params }, action: { type: 'notion.capture-append', params: { text: 'x' } } })])!.edges[0]!;
  const down = mk({ to: 'down' });
  assert.ok(edgeMatches(down, { type: 'service-status', ward: 'sv1', match: { to: 'down' } }));
  assert.ok(!edgeMatches(down, { type: 'service-status', ward: 'sv1', match: { to: 'up' } }));
  assert.ok(!edgeMatches(down, { type: 'service-status', ward: 'sv1' })); // filter set, event silent → no match
  const any = mk({});
  assert.ok(edgeMatches(any, { type: 'service-status', ward: 'sv1', match: { to: 'up' } })); // wildcard
  // onlyEdge targets a single edge
  assert.ok(edgeMatches(any, { type: 'service-status', ward: 'sv1', match: { to: 'up' }, onlyEdge: any.id }));
  assert.ok(!edgeMatches(any, { type: 'service-status', ward: 'sv1', match: { to: 'up' }, onlyEdge: 'someone-else' }));
  // non-filter params (every.minutes) are watcher config, never event filters
  const ev = graph([edge({ source: { ward: 't1', trigger: 'every', params: { minutes: 5 } }, action: { type: 'notion.capture-append', params: { text: 'x' } } })])!.edges[0]!;
  assert.ok(edgeMatches(ev, { type: 'every', ward: 't1' }));
});

test('renderTemplate: substitution, unknown keys, single pass, prototype safety', () => {
  assert.equal(renderTemplate('hi {{packet.text}} at {{now.time}}', { 'packet.text': 'x', 'now.time': '09:00' }), 'hi x at 09:00');
  assert.equal(renderTemplate('{{ packet.text }}', { 'packet.text': 'spaced' }), 'spaced');
  assert.equal(renderTemplate('{{missing}}!', {}), '!');
  assert.equal(renderTemplate('{{constructor}}{{__proto__}}', {}), ''); // own keys only
  // single pass: a substituted value containing {{...}} is never re-expanded
  assert.equal(renderTemplate('{{a}}', { a: '{{b}}', b: 'evil' }), '{{b}}');
  assert.equal(renderTemplate('x'.repeat(9000), {}).length, 8000);
});

test('lenient mode drops only the bad edges; strict mode nulls the graph', () => {
  const edges = [
    edge(), // targets f1
    edge({ id: 'e2', source: { ward: 't2', trigger: 'timer-finished', params: {} }, action: { type: 'notion.capture-append', params: { text: 'done' } } }),
  ];
  const withoutFlow = LAYOUT.filter((w) => w.i !== 'f1');
  // strict: one stale edge rejects everything (the write-time trust boundary)
  assert.equal(validateGraph({ edges }, withoutFlow, { isAdmin: false }), null);
  // lenient: the healthy edge survives a removed ward (the read-side self-heal)
  const healed = validateGraph({ edges }, withoutFlow, { isAdmin: false, lenient: true });
  assert.deepEqual(healed!.edges.map((e) => e.id), ['e2']);
  // lenient still rejects structural garbage outright
  assert.equal(validateGraph({ edges: 'nope' }, LAYOUT, { isAdmin: false, lenient: true }), null);
  // lenient drops a non-admin's adminOnly edge instead of nuking the graph
  const withHook = [edges[1]!, { ...edge({ id: 'hook' }), action: { type: 'webhook.post', params: { url: 'https://x.dev/h' } } }];
  assert.deepEqual(validateGraph({ edges: withHook }, LAYOUT, { isAdmin: false, lenient: true })!.edges.map((e) => e.id), ['e2']);
});

test('notion-db wards anchor the notion triggers and checklist actions', () => {
  const withDb = [...LAYOUT, { i: 'db1', type: 'notion-db', size: '3x2', config: { db: 'deadbeef-dead-beef-dead-beefdeadbeef' } } as WardInstance];
  const on = (over: Record<string, unknown>) => validateGraph({ edges: [edge(over)] }, withDb, { isAdmin: false });
  // trigger source
  assert.ok(on({ source: { ward: 'db1', trigger: 'notion-item', params: {} } }));
  // action target — array wardType accepts any of the three task ward types
  assert.ok(on({ action: { type: 'checklist.add', ward: 'db1', params: { title: 'x' } } }));
  assert.ok(on({ action: { type: 'checklist.add', ward: 'cl1', params: { title: 'x' } } }));
  assert.ok(on({ action: { type: 'checklist.add', ward: 'nt1', params: { title: 'x' } } }));
  // a non-task ward is still refused
  assert.equal(on({ action: { type: 'checklist.add', ward: 'w1', params: { title: 'x' } } }), null);
});
