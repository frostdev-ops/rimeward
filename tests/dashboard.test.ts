import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, DEFAULT_LAYOUT, DEFAULT_PAGES, MAX_H, MAX_PAGES, MAX_W, MAX_WARDS, MAX_WARDS_PER_PAGE, pageOf, pageSlug, shownServiceIds, sizeParts, validateLayout, validatePages, nextUp, timerSteps, wardTitle, monthCells, dateSpan, calendarChips, type CalEventLite, type WardInstance, groupTitle } from '../src/lib/wards.ts';
import { GROUPS, TARGETS } from '../src/lib/targets.ts';
import { getDashboard, getPages, saveDashboard } from '../src/lib/dashboard.ts';
import { getDb } from '../src/lib/db.ts';

test('DEFAULT_LAYOUT validates against its own rules', () => {
  const out = validateLayout(DEFAULT_LAYOUT);
  assert.ok(out);
  assert.equal(out.length, DEFAULT_LAYOUT.length);
  for (const w of out) assert.ok(CATALOG[w.type], `unknown type ${w.type}`);
});

test('validateLayout accepts any WxH inside the grid', () => {
  const one = (size: unknown) => validateLayout([{ i: 'a', type: 'weather', size }]);
  for (const ok of ['1x1', '2x1', '2x2', '3x2', '6x12', '1x12', '6x1']) assert.ok(one(ok), ok);
  for (const bad of ['0x1', '1x0', '7x1', '1x13', '2', '2x', 'x2', 'axb', '01x1', '2x2 ', ' 2x2', '2X2', 2, null])
    assert.equal(one(bad), null, String(bad));
  assert.deepEqual(sizeParts(`${MAX_W}x${MAX_H}`), [MAX_W, MAX_H]);
  assert.deepEqual(sizeParts('nope'), [2, 1]);
});

test('validateLayout: a ward theme is cleaned, never rejected', () => {
  const one = (extra: Record<string, unknown>) => validateLayout([{ i: 'a', type: 'weather', size: '2x1', ...extra }])![0]!;
  assert.deepEqual(one({ theme: { accent: '#00FF00', radius: 99 } }).theme, { accent: '#00ff00', radius: 1.25 });
  // Junk drops the knob, not the layout.
  assert.equal(one({ theme: { accent: 'chartreuse' } }).theme, undefined);
  assert.equal(one({ theme: 'nope' }).theme, undefined);
  assert.equal(one({}).theme, undefined);

  // A ward font used to be its own field; a stored one folds into the theme.
  assert.deepEqual(one({ font: 'lora' }).theme, { font: 'lora' });
  assert.ok(!('font' in one({ font: 'lora' })));
  assert.deepEqual(one({ font: 'lora', theme: { accent: '#000000' } }).theme, { font: 'lora', accent: '#000000' });
  // …and the theme's own font wins over the legacy field.
  assert.equal(one({ font: 'lora', theme: { font: 'comic' } }).theme!.font, 'comic');
});

test('validateLayout rejects garbage shapes', () => {
  assert.equal(validateLayout(null), null);
  assert.equal(validateLayout({}), null);
  assert.equal(validateLayout([]), null);
  assert.equal(validateLayout([{ i: 'a', type: 'nope', size: '1x1' }]), null);
  assert.equal(validateLayout([{ i: 'a', type: 'weather', size: '9x9' }]), null);
  assert.equal(validateLayout([{ i: 'BAD ID', type: 'weather', size: '2x1' }]), null);
  // duplicate instance ids
  assert.equal(
    validateLayout([
      { i: 'a', type: 'weather', size: '2x1' },
      { i: 'a', type: 'incidents', size: '1x1' },
    ]),
    null
  );
  // duplicate non-multi type (weather is multi now: one ward per place)
  assert.equal(
    validateLayout([
      { i: 'a', type: 'calendar', size: '2x2' },
      { i: 'b', type: 'calendar', size: '2x2' },
    ]),
    null
  );
  // over the cap
  const many = Array.from({ length: 41 }, (_, n) => ({ i: `w${n}`, type: 'applink', size: '1x1', config: { url: 'https://x.dev' } }));
  assert.equal(validateLayout(many), null);
});

test('applink/embed config: http(s) only, junk stripped', () => {
  const mk = (config: unknown, type = 'applink') => validateLayout([{ i: 'a', type, size: '1x1', config }]);
  assert.equal(mk({ url: 'javascript:alert(1)' }), null);
  assert.equal(mk({ url: 'file:///etc/passwd' }), null);
  assert.equal(mk({}), null);
  assert.equal(mk({ url: 'javascript:alert(1)' }, 'embed'), null);

  // a legacy single link normalizes to links:[…]
  const ok = mk({ url: 'https://grafana.example.com', icon: '📊', statusService: TARGETS[0]!.id, evil: 'x' });
  assert.ok(ok);
  assert.deepEqual(ok[0]!.config, { links: [{ url: 'https://grafana.example.com/', icon: '📊', statusService: TARGETS[0]!.id }] });

  assert.equal(mk({ url: 'https://x.dev', statusService: '../not-a-target' }), null);
  // a launcher holds 1..12 links; one bad link or a non-object entry rejects the layout
  const link = (n: number) => ({ url: `https://x${n}.dev` });
  assert.equal((mk({ links: Array.from({ length: 12 }, (_, n) => link(n)) })![0]!.config!.links as unknown[]).length, 12);
  assert.equal(mk({ links: Array.from({ length: 13 }, (_, n) => link(n)) }), null);
  assert.equal(mk({ links: [] }), null);
  assert.equal(mk({ links: [link(1), { url: 'javascript:alert(1)' }] }), null);
  assert.equal(mk({ links: [link(1), 'nope'] }), null);
  assert.equal(mk({ links: [link(1), { url: 'https://x.dev', statusService: 'host:disk' }] }), null); // host rows are not launcher dots
});

test('service references accept remote IDs and reject malformed values', () => {
  const one = (type: string, config: unknown) => validateLayout([{ i: 'a', type, size: '1x1', config }]);
  assert.ok(one('service-group', { group: GROUPS[0] }));
  assert.equal(one('service-group', { group: 'x'.repeat(81) }), null);
  assert.ok(one('service-group', { services: [TARGETS[0]!.id, TARGETS[1]!.id] }));
  assert.equal(one('service-group', { services: [TARGETS[0]!.id, '../nope'] }), null);
  assert.deepEqual(one('service-group', {})![0]!.config, {}); // no group, no list = every monitor
  // host metrics are members too; the dots view is stored, the default wards view is not
  assert.deepEqual(one('service-group', { services: ['host:disk', TARGETS[0]!.id], view: 'dots' })![0]!.config, { services: ['host:disk', TARGETS[0]!.id], view: 'dots' });
  assert.deepEqual(one('service-group', { group: GROUPS[0], view: 'wards' })![0]!.config, { group: GROUPS[0] });
  assert.equal(one('service-group', { services: ['host:gpu'] }), null);
  // the stock host ward is a Services ward of the host rows
  assert.deepEqual(DEFAULT_LAYOUT[0], { i: 'host', type: 'service-group', size: '2x1', title: 'Host', config: { services: ['host:cpu', 'host:mem', 'host:disk'] } });
});

test('mail and button config: never null, bad values degrade', () => {
  const one = (type: string, config: unknown) => validateLayout([{ i: 'a', type, size: '1x1', config }])![0]!.config;
  assert.deepEqual(one('mail', {}), { account: 'all' });
  assert.deepEqual(one('mail', { account: 'yahoo', unreadOnly: 'yes' }), { account: 'all' });
  assert.deepEqual(one('mail', { account: 'microsoft', unreadOnly: true }), { account: 'microsoft', unreadOnly: true });
  assert.deepEqual(one('button', {}), {});
  assert.deepEqual(one('button', { icon: '☕' }), { icon: '☕' });
  assert.deepEqual(one('button', { icon: 'coffee' }), { icon: 'coffee' });
  assert.deepEqual(one('button', { icon: '../'.repeat(5) }), {}); // neither an emoji-length string nor an icon name
  assert.equal(validateLayout([{ i: 'a', type: 'incidents', size: '1x1', config: { hours: 48 } }])![0]!.config, undefined);
});

test('wardTitle: override > group title > sole member label > catalog', () => {
  const t = (w: Partial<WardInstance> & { type: string }) => wardTitle({ i: 'a', size: '1x1', ...w });
  const g = GROUPS[0]!;
  assert.equal(t({ type: 'service-group', title: 'Mine', config: { group: g } }), 'Mine');
  assert.equal(t({ type: 'service-group', config: { group: g } }), groupTitle(g));
  assert.equal(t({ type: 'service-group', config: { services: [TARGETS[0]!.id] } }), TARGETS[0]!.label);
  assert.equal(t({ type: 'service-group', config: { services: ['host:disk'] } }), 'Disk');
  assert.equal(t({ type: 'service-group', config: { services: [TARGETS[0]!.id, TARGETS[1]!.id] } }), 'Services');
  assert.equal(t({ type: 'chart', config: { service: TARGETS[0]!.id } }), 'Chart'); // only status wards derive from a service
});

test('chart config: per-source rules, hours clamped', () => {
  const one = (config: unknown) => validateLayout([{ i: 'a', type: 'chart', size: '2x2', config }]);
  const ok = one({ source: 'status', service: TARGETS[0]!.id, metric: 'latency', chart: 'line', hours: 9999 });
  assert.ok(ok);
  assert.equal((ok[0]!.config as { hours: number }).hours, 168);
  assert.equal(one({ source: 'status', metric: 'latency', chart: 'line', hours: 24 }), null); // no service
  assert.equal(one({ source: 'host', service: 'gpu', metric: 'pct', chart: 'line', hours: 24 }), null);
  assert.ok(one({ source: 'host', service: 'cpu', metric: 'pct', chart: 'area', hours: 24 }));
  assert.equal(one({ source: 'weather', metric: 'temp', chart: 'line', hours: 24 })![0]!.config!.hours, undefined); // fixed forecast: no lookback
  assert.equal(one({ source: 'nope', metric: 'x', chart: 'line', hours: 24 }), null);
});

test('timer/checklist/flow config: clamp, notion-id normalization, none', () => {
  const one = (type: string, config: unknown) => validateLayout([{ i: 'a', type, size: '1x1', config }]);
  assert.equal((one('timer', { duration: 999999 })![0]!.config as { duration: number }).duration, 86400);
  assert.equal((one('timer', { duration: 0 })![0]!.config as { duration: number }).duration, 300); // falsy → default
  assert.deepEqual(one('timer', {})![0]!.config, { duration: 300 }); // no rounds = a plain timer, nothing else stored
  // a routine: rounds clamp to 12, defaults fill the step lengths, loop is a strict boolean
  assert.deepEqual(one('timer', { rounds: 99, loop: 'yes' })![0]!.config, { duration: 300, rounds: 12, work: 25, rest: 5, long: 15, loop: false });
  assert.deepEqual(one('timer', { rounds: 0, work: 50 })![0]!.config, { duration: 300 });
  assert.deepEqual(timerSteps({ rounds: 2, work: 25, rest: 5, long: 0 }), [
    { label: 'Focus', min: 25 },
    { label: 'Break', min: 5 },
    { label: 'Focus', min: 25 },
  ]);
  assert.deepEqual(timerSteps({ rounds: 1, work: 25, rest: 5, long: 15 }), [
    { label: 'Focus', min: 25 },
    { label: 'Long break', min: 15 },
  ]);
  assert.deepEqual(timerSteps({ duration: 300 }), []);
  const hex = 'deadbeefdeadbeefdeadbeefdeadbeef';
  const cl = one('checklist', { db: `https://www.notion.so/me/List-${hex}?v=1` });
  assert.equal((cl![0]!.config as { db: string }).db, 'deadbeef-dead-beef-dead-beefdeadbeef');
  // db is optional now (a fresh ward shows its picker); junk is still fatal.
  assert.deepEqual(one('checklist', {})![0]!.config, {});
  assert.equal(one('checklist', { db: 'not-an-id' }), null);
  // notion-tasks shares the whole contract with checklist.
  assert.equal((one('notion-tasks', { db: hex })![0]!.config as { db: string }).db, 'deadbeef-dead-beef-dead-beefdeadbeef');
  const view = one('notion-tasks', { show: 'all', sort: 'title', limit: 999, props: ['Status', 'P', '', 'c', 'd', 'e'] })![0]!.config!;
  assert.deepEqual(view, { show: 'all', sort: 'title', props: ['Status', 'P', 'c', 'd', 'e'] }); // limit ≥ page size dropped
  assert.deepEqual(one('checklist', { show: 'junk', sort: 'junk', limit: -1, props: 'nope' })![0]!.config, {});
  const fl = one('flow', { junk: 1 });
  assert.ok(fl);
  assert.equal(fl![0]!.config, undefined); // flow keeps no config
});

test('notion page wards: page optional, show/depth/props clamped', () => {
  const one = (type: string, config: unknown) => validateLayout([{ i: 'a', type, size: '2x2', config }]);
  const hex = 'deadbeefdeadbeefdeadbeefdeadbeef';
  const dashed = 'deadbeef-dead-beef-dead-beefdeadbeef';

  // A fresh ward shows its picker rather than poisoning the whole layout.
  assert.deepEqual(one('notion-page', {})![0]!.config, { depth: 2 });
  assert.equal(one('notion-page', { page: 'not-an-id' }), null);

  const page = one('notion-page', {
    page: `https://www.notion.so/me/Plan-${hex}`,
    show: ['blocks', 'blocks', 'junk'],
    depth: 9,
    props: ['Status'],
  })![0]!.config!;
  assert.deepEqual(page, { page: dashed, props: ['Status'], show: ['blocks'], depth: 2 }); // deduped, junk dropped, depth>4 → default

  // A page ward takes the capture line and the head knob; no page + add is the bare capture ward.
  assert.deepEqual(one('notion-page', { page: hex, show: ['add', 'props'], head: false })![0]!.config, { page: dashed, head: false, show: ['add', 'props'], depth: 2 });
  assert.deepEqual(one('notion-page', { show: ['add'] })![0]!.config, { show: ['add'], depth: 2 });
  assert.deepEqual(one('notion-page', { head: true })![0]!.config, { depth: 2 });

  // Both task wards accept a data-source id alongside the database id.
  const list = one('notion-tasks', { db: hex, ds: hex })![0]!.config!;
  assert.deepEqual(list, { db: dashed, ds: dashed });
  assert.equal(one('checklist', { db: hex, ds: 'nope' }), null);
});

test('titles: trimmed, capped at 60, junk dropped', () => {
  const mk = (title: unknown) => validateLayout([{ i: 'a', type: 'weather', size: '2x1', title }]);
  assert.equal(mk('  hi  ')![0]!.title, 'hi');
  assert.equal(mk('x'.repeat(61))![0]!.title, undefined); // over-long → dropped, not fatal
  assert.equal(mk(42)![0]!.title, undefined);
});

test('save/get roundtrip; missing row and corrupt row fall back to default', () => {
  getDb()
    .prepare(`INSERT INTO users (email, password_hash, role) VALUES ('t@t.dev', 'x', 'admin')`)
    .run();
  const userId = (getDb().prepare(`SELECT id FROM users WHERE email = 't@t.dev'`).get() as { id: number }).id;

  assert.deepEqual(getDashboard(userId), DEFAULT_LAYOUT);

  const layout = validateLayout([
    { i: 'w1', type: 'weather', size: '2x2' },
    { i: 'w2', type: 'applink', size: '1x1', title: 'Grafana', config: { url: 'https://g.frostdev.io' } },
  ])!;
  saveDashboard(userId, layout);
  assert.deepEqual(getDashboard(userId), layout);

  getDb().prepare('UPDATE dashboards SET layout_json = ? WHERE user_id = ?').run('{corrupt', userId);
  assert.deepEqual(getDashboard(userId), DEFAULT_LAYOUT);
});

test('shownServiceIds: only what a ward actually puts on screen', () => {
  const w = (type: string, config?: Record<string, unknown>) => ({ i: `x${type}`, type, size: '1x1' as const, config });

  // The bug this exists for: a dashboard with no service ward must not
  // surface service alerts, even though the snapshot still monitors everything.
  assert.equal(shownServiceIds([]).size, 0);
  assert.equal(shownServiceIds([w('weather'), w('incidents'), w('agent')]).size, 0);

  const one = TARGETS[0]!;
  assert.deepEqual([...shownServiceIds([w('service-group', { services: [one.id] })])], [one.id]);

  // A custom set lists its members; a group ward expands through TARGETS.
  const custom = shownServiceIds([w('service-group', { services: ['a', 'b'] })]);
  assert.deepEqual([...custom].sort(), ['a', 'b']);

  const group = shownServiceIds([w('service-group', { group: one.group })]);
  const expected = TARGETS.filter((t) => t.group === one.group).map((t) => t.id);
  assert.deepEqual([...group].sort(), expected.sort());
  const outsider = TARGETS.find((t) => t.group !== one.group);
  if (outsider) assert.equal(group.has(outsider.id), false);

  // A launcher counts every link's dot; a link without one adds nothing; a hidden ward adds nothing.
  assert.deepEqual([...shownServiceIds([w('applink', { links: [{ url: 'https://a.dev', statusService: 'a' }, { url: 'https://b.dev', statusService: 'b' }, { url: 'https://c.dev' }] })])].sort(), ['a', 'b']);
  assert.equal(shownServiceIds([{ ...w('applink', { links: [{ url: 'https://a.dev', statusService: 'a' }] }), hidden: true }]).size, 0);

  // No config = every monitor; malformed config never lands an undefined in the set.
  assert.equal(shownServiceIds([w('service-group')]).size, TARGETS.length);
  assert.equal(shownServiceIds([w('service-group', { services: [1, null] } as never)]).size, 0);

  // The stock dashboard does show services — the banner still works there.
  assert.ok(shownServiceIds(DEFAULT_LAYOUT).size > 0);
});

// ------------------------------------------------------- notion-db ward

test('notion-db config: view, id fields, and the 8-column cap', () => {
  const one = (config: Record<string, unknown>) => validateLayout([{ i: 'a', type: 'notion-db', size: '3x2', config }]);
  // empty config is a fresh ward showing its picker
  assert.deepEqual(one({})![0]!.config, {});
  // 'table' is the default — only 'list' is stored; garbage views are dropped
  assert.deepEqual(one({ view: 'list' })![0]!.config, { view: 'list' });
  assert.deepEqual(one({ view: 'table' })![0]!.config, {});
  assert.deepEqual(one({ view: 'board' })![0]!.config, {});
  // db accepts a pasted notion.so URL, rejects garbage
  const cfg = one({ db: 'https://notion.so/x-deadbeefdeadbeefdeadbeefdeadbeef' })![0]!.config!;
  assert.equal(cfg.db, 'deadbeef-dead-beef-dead-beefdeadbeef');
  assert.equal(one({ db: 'not-an-id' }), null);
  // every task ward keeps up to 8 columns
  const names = Array.from({ length: 10 }, (_, i) => `col${i}`);
  assert.equal((one({ props: names })![0]!.config!.props as string[]).length, 8);
  const legacy = validateLayout([{ i: 'a', type: 'checklist', size: '2x2', config: { props: names } }]);
  assert.equal((legacy![0]!.config!.props as string[]).length, 8);
  // show/sort are list knobs: the table view drops them, the list view and legacy list types keep them
  assert.deepEqual(one({ show: 'all', sort: 'title' })![0]!.config, {});
  assert.deepEqual(one({ view: 'list', show: 'all', sort: 'title' })![0]!.config, { view: 'list', show: 'all', sort: 'title' });
  // the calendar view keeps its date column and drops the list knobs; other views drop `date`
  assert.deepEqual(one({ view: 'calendar', date: ' Work On ', show: 'all' })![0]!.config, { view: 'calendar', date: 'Work On' });
  assert.deepEqual(one({ view: 'calendar' })![0]!.config, { view: 'calendar' });
  assert.deepEqual(one({ view: 'list', date: 'Dates' })![0]!.config, { view: 'list' });
  assert.deepEqual(one({ view: 'calendar', date: 'x'.repeat(101) })![0]!.config, { view: 'calendar' });
  const legacyCal = validateLayout([{ i: 'a', type: 'checklist', size: '2x2', config: { view: 'calendar', date: 'Dates' } }]);
  assert.deepEqual(legacyCal![0]!.config, {});
});

test('monthCells: 42 Sunday-first local days padding the month, across a DST change', () => {
  const sep = monthCells(2026, 8); // September 2026 starts on a Tuesday
  assert.equal(sep.length, 42);
  assert.equal(sep[0], '2026-08-30');
  assert.equal(sep[2], '2026-09-01');
  assert.equal(sep[41], '2026-10-10');
  const mar = monthCells(2026, 2); // US DST starts inside March
  assert.equal(mar[0], '2026-03-01');
  assert.equal(new Set(mar).size, 42);
  assert.equal(mar[41], '2026-04-11');
});

test('calendarChips: picked columns win, else the tag-like ones, never title or date', () => {
  const props = [{ name: 'Name', type: 'title' }, { name: 'Due', type: 'date' }, { name: 'Course', type: 'multi_select' }, { name: 'Status', type: 'status' }, { name: 'Notes', type: 'rich_text' }, { name: 'Kind', type: 'select' }, { name: 'Tier', type: 'select' }];
  assert.deepEqual(calendarChips(props, undefined, 'Name', 'Due'), ['Course', 'Status', 'Kind']);
  assert.deepEqual(calendarChips(props, ['Notes', 'Name', 'Gone'], 'Name', 'Due'), ['Notes']);
  assert.deepEqual(calendarChips(props, ['Gone'], 'Name', 'Due'), ['Course', 'Status', 'Kind']);
});

test('dateSpan: a day, a range, a datetime, and an end before the start', () => {
  assert.deepEqual(dateSpan({ start: '2026-09-02' }), ['2026-09-02', '2026-09-02']);
  assert.deepEqual(dateSpan({ start: '2026-11-30', end: '2026-12-12' }), ['2026-11-30', '2026-12-12']);
  assert.equal(dateSpan({ start: '2026-12-12T23:59:00.000-05:00' })![0].length, 10);
  assert.deepEqual(dateSpan({ start: '2026-09-05', end: '2026-09-01' }), ['2026-09-05', '2026-09-05']);
  assert.equal(dateSpan({ start: '' }), null);
  assert.equal(dateSpan(undefined), null);
});

test('pageSlug: lowercase dashes, numbered past a taken id, junk falls back to "page"', () => {
  assert.equal(pageSlug('Ops & Alerts!', []), 'ops-alerts');
  assert.equal(pageSlug('Ops & Alerts!', [{ id: 'ops-alerts', title: 'a' }]), 'ops-alerts-2');
  assert.equal(pageSlug('Ops & Alerts!', [{ id: 'ops-alerts', title: 'a' }, { id: 'ops-alerts-2', title: 'b' }]), 'ops-alerts-3');
  assert.equal(pageSlug('!!!', []), 'page');
  const long = pageSlug('x'.repeat(40) + ' y', []);
  assert.ok(long.length <= 24, long);
  assert.ok(validatePages([{ id: long, title: 'Long' }]), 'a slug is always a valid page id');
});

test('shared wards and shared pages: the share id is the config, never a first page, junk refused', () => {
  assert.deepEqual(validateLayout([{ i: 'a', type: 'shared', size: '2x2', config: { share: 'abc123def456' } }])?.[0]?.config, { share: 'abc123def456' });
  assert.equal(validateLayout([{ i: 'a', type: 'shared', size: '2x2', config: { share: '../x' } }]), null);
  assert.equal(validateLayout([{ i: 'a', type: 'shared', size: '2x2' }]), null);
  assert.equal(validatePages([{ id: 'home', title: 'Home' }, { id: 'x', title: 'Theirs', share: 'abc123def456' }])?.[1]?.share, 'abc123def456');
  assert.equal(validatePages([{ id: 'x', title: 'Theirs', share: 'abc123def456' }])?.[0]?.share, undefined, 'a shared page is never the first page');
  assert.equal(validatePages([{ id: 'home', title: 'Home' }, { id: 'x', title: 'T', share: 'nope' }])?.[1]?.share, undefined);
  assert.ok(CATALOG.shared!.legacy, 'placed from the Shared-with-me list, never the picker');
});

test('legacy notion ward types still validate but are hidden from the catalog', () => {
  const out = validateLayout([
    { i: 'a', type: 'notion-tasks', size: '2x2' },
    { i: 'b', type: 'checklist', size: '2x2' },
    { i: 'c', type: 'embed', size: '2x2', config: { url: 'https://x.dev' } },
  ]);
  assert.ok(out);
  // The exact legacy set: stored layouts and saved graphs may name these, the add dialog never
  // offers them. `shared` rides the flag for the second reason only: it is placed from the
  // dialog's Shared-with-me list, never picked as a type.
  assert.deepEqual(
    Object.entries(CATALOG)
      .filter(([, c]) => c.legacy)
      .map(([t]) => t)
      .sort(),
    ['checklist', 'embed', 'notion-tasks', 'shared']
  );
  assert.equal(CATALOG['notion-db']!.legacy, undefined);
  // The stock dashboard validates and never spends a slot on a legacy type.
  const stock = validateLayout(DEFAULT_LAYOUT);
  assert.ok(stock);
  for (const w of stock) assert.equal(CATALOG[w.type]!.legacy, undefined, w.type);
});

test('nextUp: timed events only, the in-progress one lands in now, next capped at 3, joinUrl rides through', () => {
  const at = (h: number, m = 0) => new Date(2026, 8, 2, h, m).toISOString();
  const now = new Date(2026, 8, 2, 12).getTime();
  const ev = (start: string, end: string, extra: Partial<CalEventLite> = {}): CalEventLite => ({ title: 't', start, end, allDay: false, location: '', source: 'google', ...extra });
  const events = [
    ev(at(9), at(10)), // over
    ev(at(11, 30), at(12, 30), { title: 'current', joinUrl: 'https://meet.example/x' }),
    ev(at(13), at(14), { title: 'n1' }),
    ev(at(14), at(15), { title: 'n2' }),
    ev(at(15), at(16), { title: 'n3' }),
    ev(at(16), at(17), { title: 'n4' }),
    ev('2026-09-02T00:00:00', '2026-09-03T00:00:00', { title: 'all day', allDay: true }),
    ev('nope', at(18), { title: 'unparsable' }),
  ];
  const r = nextUp(events, now);
  assert.equal(r.now?.title, 'current');
  assert.equal(r.now?.joinUrl, 'https://meet.example/x');
  assert.deepEqual(r.next.map((e) => e.title), ['n1', 'n2', 'n3']);
  assert.equal(nextUp([events[0]!, events[6]!], now).now, undefined);
  assert.deepEqual(nextUp([events[0]!, events[6]!], now).next, []);
  // one per layout
  assert.equal(validateLayout([{ i: 'a', type: 'next-up', size: '1x1' }, { i: 'b', type: 'next-up', size: '1x1' }]), null);
});

test('hidden is a boolean-true passthrough, and hidden wards do not drive alerts', () => {
  const out = validateLayout([
    { i: 'n1', type: 'note', size: '2x1', hidden: true, config: { text: 'anchor' } },
    { i: 's1', type: 'service-group', size: '1x1', hidden: true, config: { services: [TARGETS[0]!.id] } },
    { i: 's2', type: 'service-group', size: '1x1', config: { services: [TARGETS[1]!.id] } },
  ]);
  assert.ok(out);
  assert.equal(out[0]!.hidden, true);
  assert.equal(out[0]!.config!.text, 'anchor'); // the pre-store note text rides along as the document seed
  // Anything but literal true is dropped — no truthy strings sneaking in.
  for (const bad of ['true', 1, {}, 'yes'])
    assert.equal(validateLayout([{ i: 'a', type: 'note', size: '2x1', hidden: bad }])![0]!.hidden, undefined, String(bad));
  // A hidden service ward puts nothing on screen, so it earns no alert.
  assert.deepEqual([...shownServiceIds(out)], [TARGETS[1]!.id]);
});

test('note config: the notepad knobs, plus the legacy text as a seed, nothing else', () => {
  const cfg = (text: unknown) => validateLayout([{ i: 'n', type: 'note', size: '2x1', config: { text, junk: 1 } }])![0]!.config!;
  const knobs = { paper: 'plain', ink: true, transcribe: 'manual', keepInk: false, provider: 'openrouter' };
  assert.deepEqual(cfg('hi'), { ...knobs, text: 'hi' });
  assert.deepEqual(cfg(''), knobs);
  assert.deepEqual(cfg(42), knobs);
  assert.equal(String((cfg('x'.repeat(5000)) as { text: string }).text).length, 2000);
});

test('browser config: backend defaults to local, home URL optional but http(s) only', () => {
  const mk = (config: unknown) => validateLayout([{ i: 'b', type: 'browser', size: '3x2', config }])?.[0]?.config;
  assert.deepEqual(mk({}), { backend: 'local' });
  assert.deepEqual(mk({ url: '  ', backend: 'nope' }), { backend: 'local' });
  assert.deepEqual(mk({ url: 'https://app.example.com/x', backend: 'browserbase', evil: 1 }), { backend: 'browserbase', url: 'https://app.example.com/x' });
  assert.deepEqual(mk({ sound: true }), { backend: 'local', sound: true }, 'sound is a boolean knob');
  assert.deepEqual(mk({ sound: 'yes' }), { backend: 'local' }, 'anything but true is off, and off is absent');
  assert.equal(mk({ url: 'javascript:alert(1)' }), undefined);
  assert.equal(mk({ url: 'file:///etc/passwd' }), undefined);
  assert.deepEqual(mk({ route: 'home' }), { backend: 'local', route: 'home' });
  assert.deepEqual(mk({ backend: 'app', route: 'home' }), { backend: 'app', route: 'home' });
  assert.deepEqual(mk({ route: 'office' }), { backend: 'local' });
  assert.ok(validateLayout([{ i: 'e', type: 'embed', size: '2x2', config: { url: 'https://x.dev' } }]), 'legacy embed layouts still validate');
});

test('spacer config: effect enum, scene id only with the scene effect, the rule knob', () => {
  const one = (type: string, config: unknown) => validateLayout([{ i: 'a', type, size: '2x1', config }])![0]!.config;
  assert.deepEqual(one('spacer', {}), { effect: 'none' });
  assert.deepEqual(one('spacer', { effect: 'nope' }), { effect: 'none' });
  // the rule (the old separator) is stored only when asked
  assert.deepEqual(one('spacer', { effect: 'glass', scene: 'nebula', rule: true }), { effect: 'glass', rule: true });
  assert.deepEqual(one('spacer', { effect: 'scene', scene: 'nebula' }), { effect: 'scene', scene: 'nebula' });
  assert.deepEqual(one('spacer', { effect: 'none', rule: true }), { effect: 'none', rule: true });
  assert.deepEqual(one('spacer', { effect: 'none', rule: 'yes' }), { effect: 'none' });
  assert.deepEqual(one('spacer', { effect: 'scene', scene: 'bogus' }), { effect: 'scene', scene: 'aurora' });
  // a group has no knobs — its config is always {} — but keeps the ⚙: that is how it is renamed
  assert.deepEqual(validateLayout([{ i: 'a', type: 'container', size: '2x1', config: { open: true } }])![0]!.config, {});
  assert.equal(CATALOG.container!.configurable, true);
  assert.equal(CATALOG.embed!.configurable, true);
  assert.equal(CATALOG.incidents!.configurable, undefined);
});

test('groups: `in` names a container, one level deep, and self-heals instead of failing', () => {
  const out = validateLayout([
    { i: 'g', type: 'container', size: '2x1' },
    { i: 'a', type: 'weather', size: '2x1', in: 'g' },
    { i: 'b', type: 'note', size: '2x1', in: 'gone' },
    { i: 'c', type: 'note', size: '2x1', in: 'a' },
    { i: 'h', type: 'container', size: '2x1', in: 'g' },
    { i: 'd', type: 'note', size: '2x1', in: 42 },
  ]);
  assert.ok(out);
  assert.equal(out[1]!.in, 'g');
  assert.equal(out[2]!.in, undefined, 'a removed container lifts the ward out');
  assert.equal(out[3]!.in, undefined, 'a plain ward is not a container');
  assert.equal(out[4]!.in, undefined, 'containers do not nest');
  assert.equal(out[5]!.in, undefined);
  assert.equal(validateLayout([{ i: 'a', type: 'note', size: '2x1', in: 'Not Valid' }])![0]!.in, undefined);
});

test('shownServiceIds: a hidden group hides the services inside it', () => {
  const out = validateLayout([
    { i: 'g', type: 'container', size: '2x1', hidden: true },
    { i: 's1', type: 'service-group', size: '1x1', in: 'g', config: { services: [TARGETS[0]!.id] } },
    { i: 'g2', type: 'container', size: '2x1' },
    { i: 's2', type: 'service-group', size: '1x1', in: 'g2', config: { services: [TARGETS[1]!.id] } },
  ])!;
  assert.deepEqual([...shownServiceIds(out)], [TARGETS[1]!.id]);
});

test('validatePages: ids, titles, icons, caps', () => {
  assert.deepEqual(validatePages([]), DEFAULT_PAGES);
  assert.deepEqual(validatePages([{ id: 'ops', title: '  Ops ', icon: 'weather' }]), [{ id: 'ops', title: 'Ops', icon: 'weather' }]);
  assert.deepEqual(validatePages([{ id: 'ops', title: 'Ops', icon: 'nope' }]), [{ id: 'ops', title: 'Ops' }]); // unknown icon dropped
  for (const bad of [
    'x',
    [null],
    [{ id: 'Ops', title: 'Ops' }],
    [{ id: 'a', title: '' }],
    [{ id: 'a', title: 'x'.repeat(41) }],
    [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }],
    Array.from({ length: MAX_PAGES + 1 }, (_, i) => ({ id: `p${i}`, title: 'P' })),
  ])
    assert.equal(validatePages(bad), null, JSON.stringify(bad));
});

test('validateLayout: page pointers heal, nested wards follow their group, caps are per page', () => {
  const pages = [{ id: 'home', title: 'Home' }, { id: 'ops', title: 'Ops' }];
  const out = validateLayout(
    [
      { i: 'a', type: 'weather', size: '2x2', page: 'ops' },
      { i: 'b', type: 'button', size: '1x1', page: 'gone' },
      { i: 'c', type: 'container', size: '2x1', page: 'ops' },
      { i: 'd', type: 'applink', size: '1x1', page: 'home', in: 'c', config: { url: 'https://x.dev' } },
      { i: 'e', type: 'timer', size: '1x1', page: 'home' },
      { i: 'f', type: 'note', size: '2x2', page: 'Bad Id' },
    ],
    pages
  )!;
  assert.ok(out);
  const by = Object.fromEntries(out.map((w) => [w.i, w]));
  assert.equal(by.a!.page, 'ops');
  assert.equal(by.b!.page, undefined); // vanished page → first page
  assert.equal(by.d!.page, undefined); // nested: the group's page
  assert.equal(pageOf(by.d!, pages, out), 'ops');
  assert.equal(by.e!.page, undefined); // the first page is always written as absent
  assert.equal(by.f!.page, undefined);
  assert.equal(pageOf(by.b!, pages), 'home');

  // No page list: a well-formed pointer is kept as-is (the agent, the boot rewrite).
  assert.equal(validateLayout([{ i: 'a', type: 'weather', size: '2x2', page: 'ops' }])![0]!.page, 'ops');

  const fill = (n: number, page?: string) => Array.from({ length: n }, (_, i) => ({ i: `w${i}${page ?? ''}`, type: 'spacer', size: '1x1', ...(page ? { page } : {}) }));
  assert.equal(validateLayout(fill(MAX_WARDS_PER_PAGE + 1), pages), null);
  assert.ok(validateLayout([...fill(MAX_WARDS_PER_PAGE), ...fill(MAX_WARDS_PER_PAGE, 'ops')], pages));
  const many = Array.from({ length: MAX_PAGES }, (_, i) => ({ id: `p${i}`, title: 'P' }));
  assert.equal(validateLayout(many.flatMap((p) => fill(MAX_WARDS_PER_PAGE, p.id)).slice(0, MAX_WARDS + 1), many), null);
});

test('saveDashboard: the page list is kept unless one is given; wards heal against it on read', () => {
  getDb()
    .prepare(`INSERT INTO users (email, password_hash, role) VALUES ('p@t.dev', 'x', 'admin')`)
    .run();
  const userId = (getDb().prepare(`SELECT id FROM users WHERE email = 'p@t.dev'`).get() as { id: number }).id;
  assert.deepEqual(getPages(userId), DEFAULT_PAGES);
  const pages = [{ id: 'home', title: 'Home' }, { id: 'ops', title: 'Ops' }];
  const layout: WardInstance[] = [{ i: 'w1', type: 'weather', size: '2x2', page: 'ops' }];
  saveDashboard(userId, layout, pages);
  assert.deepEqual(getPages(userId), pages);
  assert.equal(getDashboard(userId)[0]!.page, 'ops');
  saveDashboard(userId, [{ i: 'w1', type: 'weather', size: '2x2', page: 'ops' }, { i: 'w2', type: 'button', size: '1x1' }]);
  assert.deepEqual(getPages(userId), pages); // untouched by a layout-only save
  saveDashboard(userId, layout, [{ id: 'home', title: 'Home' }]);
  assert.equal(getDashboard(userId)[0]!.page, undefined); // its page went away → first page
});

test('weather config: a place is both coordinates in range plus an optional name; anything else is no place', () => {
  const one = (config: unknown) => validateLayout([{ i: 'w', type: 'weather', size: '2x1', config }])?.[0]?.config;
  assert.deepEqual(one({ lat: '40.7', lon: '-74', name: ' Home ' }), { lat: 40.7, lon: -74, name: 'Home' });
  assert.deepEqual(one({ lat: 0, lon: 0 }), { lat: 0, lon: 0 }); // the equator is a place
  assert.deepEqual(one({ lat: 91, lon: 0 }), {});
  assert.deepEqual(one({ lat: 40.7 }), {});
  assert.deepEqual(one({ lat: '', lon: '' }), {});
  assert.deepEqual(one(undefined), {});
  assert.equal(wardTitle({ i: 'w', type: 'weather', size: '2x1', config: { lat: 1, lon: 2, name: 'Cabin' } }), 'Weather · Cabin');
});
