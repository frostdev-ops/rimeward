import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLayout } from '../src/lib/wards.ts';
import { getDb } from '../src/lib/db.ts';
import { getDashboard, getPages, saveDashboard } from '../src/lib/dashboard.ts';
import { subscribeLogic } from '../src/lib/logic-engine.ts';
import { TOOLS, dirtiesNotion } from '../src/lib/agent/tools.ts';

function seedUser(email: string): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  return (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
}

// The agent ward's config is REBUILT by validateLayout — bad values fall back
// to defaults rather than rejecting the layout (the ward always renders).

test('agent config rebuilds with defaults', () => {
  const out = validateLayout([{ i: 'a', type: 'agent', size: '2x2', config: {} }]);
  assert.ok(out);
  assert.deepEqual(out[0]!.config, { provider: 'default', tools: 'all', approvals: 'outbound' });
});

test('agent config keeps valid values and drops garbage', () => {
  const out = validateLayout([
    {
      i: 'a',
      type: 'agent',
      size: '2x2',
      config: {
        provider: 'codex',
        model: '  gpt-5.6-sol  ',
        persona: 'be terse',
        tools: 'read-only',
        approvals: 'off',
        effort: 'xhigh',
        sneaky: 'dropped',
      },
    },
  ]);
  assert.ok(out);
  const cfg = out[0]!.config!;
  assert.equal(cfg.provider, 'codex');
  assert.equal(cfg.model, 'gpt-5.6-sol');
  assert.equal(cfg.persona, 'be terse');
  assert.equal(cfg.tools, 'read-only');
  assert.equal(cfg.approvals, 'off');
  assert.equal(cfg.effort, 'xhigh');
  assert.equal('sneaky' in cfg, false, 'stray keys never pass through');
});

test('agent config clamps oversize and unknown enum values', () => {
  const out = validateLayout([
    {
      i: 'a',
      type: 'agent',
      size: '2x2',
      config: { provider: 'skynet', model: 'x'.repeat(200), persona: 'p'.repeat(3000), tools: 'sudo', approvals: 'yolo', effort: 'ludicrous' },
    },
  ]);
  assert.ok(out);
  const cfg = out[0]!.config!;
  assert.equal(cfg.provider, 'default');
  assert.equal(cfg.tools, 'all');
  assert.equal(cfg.approvals, 'outbound');
  assert.ok(!cfg.model || String(cfg.model).length <= 100);
  assert.ok(!cfg.persona || String(cfg.persona).length <= 2000);
});

test('agent wards are multi', () => {
  const out = validateLayout([
    { i: 'a', type: 'agent', size: '2x2', config: {} },
    { i: 'b', type: 'agent', size: '2x2', config: {} },
  ]);
  assert.ok(out);
  assert.equal(out.length, 2);
});

test('dirtiesNotion covers every Notion-mutating tool and no reads', () => {
  // The confirm-kind ones matter most: they ONLY run through the second
  // dispatch in core.ts, so missing them leaves archive/delete silently stale.
  for (const name of [
    'notion_set_props',
    'notion_create_page',
    'notion_add_blocks',
    'notion_edit_block',
    'notion_add_comment',
    'notion_create_list',
    'notion_edit_schema',
    'notion_delete_block',
    'notion_archive_page',
    'notion_trash_list',
    'notion_capture',
    'add_checklist_item',
    'check_checklist_item',
  ]) {
    assert.ok(TOOLS[name], `tool ${name} vanished — update this list`);
    assert.ok(dirtiesNotion(name), `${name} should dirty Notion`);
  }
  // Reads never dirty, even Notion ones; non-Notion writes never dirty.
  for (const name of ['notion_page', 'notion_query', 'list_checklist', 'notion_tasks', 'set_theme', 'timer_op', 'add_ward'])
    assert.equal(dirtiesNotion(name), false, `${name} should not dirty Notion`);
  assert.equal(dirtiesNotion('no_such_tool'), false);
});

// The browser animates a pushed layout instead of reloading, so the broadcast
// has to actually carry one. An empty payload silently degrades every agent
// edit back to a full page reload — the exact thing this replaced.
test('layout tools broadcast the new layout, and set_theme broadcasts a theme', async () => {
  const u = seedUser('agent-bcast@x.dev');
  saveDashboard(u, validateLayout([{ i: 'w1', type: 'weather', size: '2x1' }])!);

  const seen: { event: string; data: any }[] = [];
  const stop = subscribeLogic(u, (event, data) => seen.push({ event, data }));
  try {
    const ctx = { userId: u, ward: 'ag1', conversationId: 0 } as any;
    await TOOLS.add_ward!.run({ type: 'calendar', reason: 'r' }, ctx);
    await TOOLS.set_theme!.run({ theme: { accent: '#ff0000' }, reason: 'r' }, ctx);
  } finally {
    stop();
  }

  const layoutEv = seen.filter((e) => e.event === 'layout');
  assert.equal(layoutEv.length, 1);
  const pushed = validateLayout(layoutEv[0]!.data.layout);
  assert.ok(pushed, 'the pushed layout must survive the same validator the browser runs');
  assert.deepEqual(pushed.map((w) => w.type), ['weather', 'calendar']);
  assert.deepEqual(pushed, getDashboard(u));

  const themeEv = seen.filter((e) => e.event === 'theme');
  assert.equal(themeEv.length, 1);
  assert.equal(themeEv[0]!.data.accent, '#ff0000');
});

test('page tools: add/rename/delete pages, wards land on pages and survive a deletion', async () => {
  const u = seedUser('agent-pages@x.dev');
  saveDashboard(u, validateLayout([{ i: 'w1', type: 'weather', size: '2x1' }])!);
  const ctx = { userId: u, ward: 'ag1', conversationId: 0 } as any;
  const seen: { event: string; data: any }[] = [];
  const stop = subscribeLogic(u, (event, data) => seen.push({ event, data }));
  try {
    const added = (await TOOLS.add_page!.run({ title: 'Ops Board', reason: 'r' }, ctx)) as any;
    assert.deepEqual(added.pages.map((p: any) => p.id), ['home', 'ops-board']);
    await TOOLS.add_ward!.run({ type: 'timer', page: 'ops-board', reason: 'r' }, ctx);
    assert.throws(() => TOOLS.add_ward!.run({ type: 'button', page: 'nope', reason: 'r' }, ctx), /no page "nope"/);
    const view = (await TOOLS.get_layout!.run({}, ctx)) as any;
    assert.deepEqual(view.layout.map((w: any) => [w.type, w.page]), [['weather', 'home'], ['timer', 'ops-board']]);
    assert.equal(view.pages.length, 2);
    await TOOLS.rename_page!.run({ page: 'ops-board', title: 'Ops', reason: 'r' }, ctx);
    assert.equal(getPages(u)[1]!.title, 'Ops');
    // The id did not change with the title.
    assert.throws(() => TOOLS.move_ward!.run({ ward: 'w1', index: 1, page: 'ops', reason: 'r' }, ctx), /no page "ops"/);
    await TOOLS.move_ward!.run({ ward: 'w1', index: 1, page: 'ops-board', reason: 'r' }, ctx);
    assert.deepEqual(getDashboard(u).map((w) => [w.type, w.page]), [['timer', 'ops-board'], ['weather', 'ops-board']]);
    await TOOLS.delete_page!.run({ page: 'ops-board', reason: 'r' }, ctx);
    assert.deepEqual(getPages(u).map((p) => p.id), ['home']);
    assert.deepEqual(getDashboard(u).map((w) => w.page), [undefined, undefined]); // wards survive, on the first page
    assert.throws(() => TOOLS.delete_page!.run({ page: 'home', reason: 'r' }, ctx), /last page/);
  } finally {
    stop();
  }
  const withPages = seen.filter((e) => e.event === 'layout' && Array.isArray(e.data.pages));
  assert.ok(withPages.length >= 4, 'every page/layout write broadcasts the page list beside the layout');
});

// A real dashboard's ward configs together overrun the agent's 12k tool-output
// cap (core.ts OUTPUT_CAP), and the whole result is dropped — leaving the model
// with no ward ids at all. The list carries no config; one ward does.
test('get_layout fits a big dashboard and reads one ward with its config', async () => {
  const u = seedUser('agent-layout-cap@x.dev');
  const links = Array.from({ length: 12 }, (_, i) => ({ url: `https://service-${i}.internal.example.com/dashboards/overview?panel=${i}` }));
  const pages = [{ id: 'home', title: 'Home' }, { id: 'extra', title: 'Extra' }];
  // 60 wards is two pages' worth — MAX_WARDS_PER_PAGE is 40.
  const layout = validateLayout(Array.from({ length: 60 }, (_, i) => ({ i: `w${i}`, type: 'applink', size: '1x1', title: `Launcher ${i}`, page: i < 30 ? 'home' : 'extra', config: { links } })), pages);
  assert.ok(layout);
  saveDashboard(u, layout, pages);
  const ctx = { userId: u, ward: 'ag1', conversationId: 0 } as any;
  const all = (await TOOLS.get_layout!.run({}, ctx)) as any;
  assert.equal(all.layout.length, 60);
  assert.ok(all.layout.every((w: any) => w.config === undefined), 'the whole list carries no config');
  const size = JSON.stringify(all).length;
  assert.ok(size < 12_000, `serialized layout is ${size} chars, over the tool output cap`);
  const one = (await TOOLS.get_layout!.run({ ward: 'w7' }, ctx)) as any;
  assert.deepEqual(one.layout.map((w: any) => w.ward), ['w7']);
  assert.equal((one.layout[0].config.links as unknown[]).length, 12);
  assert.throws(() => TOOLS.get_layout!.run({ ward: 'nope' }, ctx), /no ward "nope"/);
});
