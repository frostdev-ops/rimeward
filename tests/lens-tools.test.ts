import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

// The lens tools are desktop tools: `wrap` refuses them anywhere else.
process.env.RIMEWARD_DESKTOP = '1';
process.env.RIMEWARD_NATIVE_TOKEN = 'test-only';

import { createUser } from '../src/lib/users.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { activeConversation } from '../src/lib/agent/conversations.ts';
import { LOCAL_DEV_TOOLS, DEV_TOOLS } from '../src/lib/dev/tools.ts';
import { LENS_TOOLS, LENS_TOOL_NAMES } from '../src/lib/lens/tools.ts';
import { consumerOf, lensToolRun } from '../src/lib/lens/agent.ts';
import { captionsFor } from '../src/lib/lens/captions.ts';
import { SOURCES, lens, releaseLens, systemClock } from '../src/lib/lens/core.ts';
import type { Feed, LensSettings, Source } from '../src/lib/lens/core.ts';
import { terminalSource } from '../src/lib/lens/terminal.ts';
import { screenOffline } from '../src/lib/lens/types.ts';
import { lensSettings } from '../src/lib/lens/settings.ts';
import { setLensPaused } from '../src/lib/lens/runtime.ts';
import { OBSERVATION_BANNER } from '../src/lib/lens/types.ts';
import type { ToolCtx } from '../src/lib/agent/tools.ts';
import { terminalFixture } from './lens-replay.ts';

const CONSUMER_ID = /^[a-z0-9-]{1,40}$/;

test('every lens tool is a local dev tool and a device tool, at its own kind', () => {
  for (const name of LENS_TOOL_NAMES) {
    const local = LOCAL_DEV_TOOLS[name];
    assert.ok(local, `${name} is missing from LOCAL_DEV_TOOLS`);
    assert.equal(local.kind, LENS_TOOLS[name].kind, `${name} kind`);
    const properties = (local.parameters as { properties: Record<string, unknown>; required: string[] });
    assert.ok(properties.properties.runtime, `${name} takes a runtime`);
    assert.ok(properties.properties.source, `${name} takes a source`);
    assert.ok(properties.required.includes('runtime'), `${name} requires a runtime`);

    const device = DEV_TOOLS[name];
    assert.ok(device, `${name} is missing from DEV_TOOLS`);
    assert.equal(device.kind, LENS_TOOLS[name].kind);
    assert.ok((device.parameters as { properties: Record<string, unknown> }).properties.device, `${name} takes a device`);
  }
  assert.deepEqual(LENS_TOOL_NAMES.filter(n => n.startsWith('lens_') && LENS_TOOLS[n].kind !== 'read'), ['lens_captions']);
  assert.deepEqual(LENS_TOOL_NAMES.filter(n => LENS_TOOLS[n].kind === 'write'), ['lens_captions', 'overlay_show', 'overlay_clear']);
  // A wait parks for minutes: the turn must be able to take it back.
  assert.equal(LOCAL_DEV_TOOLS.lens_wait.cancellable, true);
});

test('a consumer is the conversation, or the relayed caller when there is none', () => {
  const conv = consumerOf({ userId: 1, ward: 'agent:ag1', conv: 42 } as ToolCtx);
  assert.equal(conv, 'conv-42');
  assert.match(conv, CONSUMER_ID);

  const caller = 'a1b2c3d4'.repeat(8); // the 64-hex caller hash serveDeviceTool signs a ward with
  const remote = consumerOf({ userId: 1, ward: `remote:${caller}`, conv: 0 } as ToolCtx);
  assert.equal(remote, `remote-${caller.slice(0, 32)}`);
  assert.match(remote, CONSUMER_ID);
  assert.equal(remote.length, 39);

  // Anything else has no identity of its own: sharing one cursor between
  // unrelated callers would hand each of them the other's deliveries.
  assert.throws(() => consumerOf({ userId: 1, ward: 'agent:ag1', conv: 0 } as ToolCtx), /conversation or a relayed caller/);
});

test('an unknown source type is refused before any core is made', async () => {
  const user = createUser('lens-tools-unknown@example.com', 'pw-lens-tools-1');
  await assert.rejects(
    () => lensToolRun('lens_look', { source: 'nope:1' }, { userId: user, ward: 'agent:ag1', conv: 1 } as ToolCtx),
    /No lens for source "nope:1"/
  );
  // The screen lens is not bundled yet, so its default source has no core either.
  await assert.rejects(
    () => lensToolRun('lens_look', {}, { userId: user, ward: 'agent:ag1', conv: 1 } as ToolCtx),
    /No lens for source "screen:local"/
  );
});

test('the screen-only tools read a screen lens, and refuse anything else by name', async (t) => {
  const user = createUser('lens-tools-screen@example.com', 'pw-lens-tools-2');
  const source = 'screen:local';
  // A screen source that never feeds: enough for `lens()` to build a core.
  const real = SOURCES.screen;
  SOURCES.screen = (): Source => ({ async connect(_u: number, _t: string, _f: Feed) { return () => {}; } });
  t.after(() => {
    releaseLens(user, source);
    if (real) SOURCES.screen = real; else delete SOURCES.screen;
  });

  const ctx = { userId: user, ward: 'agent:ag1', conv: 5 } as ToolCtx;
  const args = { rect: [0, 0, 10, 10], id: 'x', kind: 'card', anchor: { corner: 'tl' }, on: true };
  // The three reads are live: with no frame ever captured there is nothing to
  // crop or describe, and the empty document has no text to page.
  await assert.rejects(() => lensToolRun('lens_crop', { source, ...args }, ctx), /^Error: frame-evicted$/);
  await assert.rejects(() => lensToolRun('lens_describe', { source, ...args }, ctx), /^Error: frame-evicted$/);
  const read = await lensToolRun('lens_text', { source }, ctx) as Record<string, unknown>;
  // The receipt is counts and ids; the body is in `text`, once.
  assert.equal(read.lines, 0);
  assert.equal(read.ref, null);
  assert.match(String(read.text), /^\[lens observation: /, 'observed text always carries the banner');
  assert.deepEqual((JSON.parse(String(read.text).split('\n')[1]!) as { lines: unknown[] }).lines, []);

  // A source it could never read, screen lens or not, is refused by name.
  const realTerminal = SOURCES.terminal;
  SOURCES.terminal = (): Source => ({ async connect(_u: number, _t: string, _f: Feed) { return () => {}; } });
  t.after(() => {
    releaseLens(user, 'terminal:s1');
    SOURCES.terminal = realTerminal;
  });
  for (const name of ['lens_crop', 'lens_text', 'lens_describe', 'lens_captions', 'overlay_show', 'overlay_clear'] as const) {
    await assert.rejects(
      () => lensToolRun(name, { source: 'terminal:s1', ...args }, ctx),
      new RegExp(`^Error: ${name} reads a screen lens; terminal:s1 is not a screen source$`),
      name
    );
  }
});

test('the overlay and caption tools draw through the native side, and the ward knob turns them off', async (t) => {
  const user = createUser('lens-tools-overlay@example.com', 'pw-lens-tools-5');
  const source = 'screen:local';
  const real = SOURCES.screen;
  SOURCES.screen = (): Source => ({ async connect(_u: number, _t: string, _f: Feed) { return () => {}; } });
  t.after(() => {
    releaseLens(user, source);
    if (real) SOURCES.screen = real; else delete SOURCES.screen;
  });

  const calls: { op: string; value: Record<string, unknown> }[] = [];
  const refuse = new Map<string, string>();
  const core = lens(user, source)!;
  captionsFor(core, {
    clock: systemClock,
    settings: () => ({ caption_from: 'en', caption_to: 'es' }),
    desktop: async (op, value) => {
      calls.push({ op, value: (value ?? {}) as Record<string, unknown> });
      const refused = refuse.get(op);
      if (refused !== undefined) throw new Error(refused);
      return op === 'overlay-show' ? { id: (value as { id: string }).id } : true;
    },
  });
  const ctx = { userId: user, ward: 'agent:ag1', conv: 7 } as ToolCtx;
  const of = (op: string): Record<string, unknown>[] => calls.filter((c) => c.op === op).map((c) => c.value);
  const epoch = core.doc().epoch;

  const shown = await lensToolRun('overlay_show', { source, id: 'card-1', kind: 'card', text: 'hi', anchor: { corner: 'tl' } }, ctx);
  assert.deepEqual(shown, { id: 'card-1', ttl_s: 20, text: JSON.stringify({ id: 'card-1', ttl_s: 20 }) });
  assert.equal(of('overlay-show')[0]?.ttlMs, 20_000, 'ttl_s crosses as ttlMs');
  assert.equal(of('overlay-show')[0]?.epoch, epoch);

  // A frame from a window the user has left, and one that was never a frame
  // ref at all, are both refused before anything is drawn.
  await assert.rejects(
    () => lensToolRun('overlay_show', { source, id: 'card-1', kind: 'card', anchor: { rect: [0, 0, 10, 10], ref: `f-${epoch + 9}-3` } }, ctx),
    /^Error: stale-epoch$/
  );
  await assert.rejects(
    () => lensToolRun('overlay_show', { source, id: 'card-1', kind: 'card', anchor: { rect: [0, 0, 10, 10], ref: 'nope' } }, ctx),
    /^Error: frame-evicted$/
  );
  await assert.rejects(() => lensToolRun('overlay_show', { source, id: 'CARD', kind: 'card', anchor: { corner: 'tl' } }, ctx), /id of 1 to 32/);
  await assert.rejects(() => lensToolRun('overlay_show', { source, id: 'c', kind: 'toast', anchor: { corner: 'tl' } }, ctx), /card, caption or highlight/);
  assert.equal(of('overlay-show').length, 1, 'nothing malformed reached the app');

  const cleared = await lensToolRun('overlay_clear', { source, id: 'card-1' }, ctx) as Record<string, unknown>;
  assert.equal(cleared.cleared, 'card-1');
  assert.deepEqual(of('overlay-clear').at(-1), { id: 'card-1' });
  await lensToolRun('overlay_clear', { source }, ctx);
  assert.deepEqual(of('overlay-clear').at(-1), {}, 'no id clears every window');

  const on = await lensToolRun('lens_captions', { source, on: true }, ctx) as Record<string, unknown>;
  assert.equal(on.on, true);
  assert.equal(on.from, 'en');
  assert.equal(on.to, 'es');
  assert.equal(on.state, 'on');

  // A refusal from the native side reaches the tool as an error.
  refuse.set('overlay-show', 'frame-evicted');
  await assert.rejects(
    () => lensToolRun('overlay_show', { source, id: 'card-2', kind: 'card', anchor: { corner: 'tl' } }, ctx),
    /^Error: frame-evicted$/
  );
  refuse.clear();

  // The ward's `overlay` knob: nothing is drawn, and captions are drawn on the
  // overlay too — but taking something down early is always allowed.
  saveDashboard(user, validateLayout([{ i: 'ln1', type: 'lens', size: '3x2', config: { overlay: false } }])!);
  await assert.rejects(
    () => lensToolRun('overlay_show', { source, id: 'card-3', kind: 'card', anchor: { corner: 'tl' } }, ctx),
    /overlay_show is off: the Screen lens ward has the overlay turned off/
  );
  await assert.rejects(
    () => lensToolRun('lens_captions', { source, on: true }, ctx),
    /lens_captions is off: the Screen lens ward has the overlay turned off/
  );
  const off = await lensToolRun('lens_captions', { source, on: false }, ctx) as Record<string, unknown>;
  assert.equal(off.on, false, 'turning captions off is never refused by the knob');
  assert.equal((await lensToolRun('overlay_clear', { source }, ctx) as Record<string, unknown>).cleared, 'all');
});

test('lens_look, lens_wait and lens_history acknowledge one delivery at a time', async (t) => {
  const user = createUser('lens-tools-ack@example.com', 'pw-lens-tools-3');
  saveDashboard(user, validateLayout([{ i: 'ag1', type: 'agent', size: '2x2', config: { provider: 'codex' } }])!);
  const conversation = activeConversation(user, 'ag1', 'codex');
  const ctx = { userId: user, ward: 'agent:ag1', conv: conversation.id } as ToolCtx;
  const consumer = consumerOf(ctx);

  const fixture = terminalFixture(() => Date.now());
  const real = SOURCES.terminal;
  SOURCES.terminal = (): Source => terminalSource(fixture.deps);
  const source = 'terminal:s1';
  t.after(() => {
    releaseLens(user, source);
    SOURCES.terminal = real;
  });
  fixture.inject({ rows: ['ready', 'building…'], seq: 1 });
  // Settles instantly, so the test never waits on the 750 ms window; `lensToolRun`
  // reuses this core (one per user and source).
  const core = lens(user, source, (): LensSettings => ({ settleMs: 0, minLines: 1 }));
  assert.ok(core);

  const run = (name: 'lens_look' | 'lens_wait' | 'lens_history', args: Record<string, unknown> = {}) =>
    lensToolRun(name, { source, ...args }, ctx) as Promise<Record<string, any>>;

  // The first read attaches the consumer and connects the source.
  await run('lens_look');
  const key = await run('lens_wait', { timeout_s: 5 });
  assert.equal(key.kind, 'key');
  assert.equal(key.since, null);
  assert.ok(String(key.text).startsWith(OBSERVATION_BANNER), 'a delivery carries the lens banner');
  assert.ok(String(key.text).includes('building…'));
  assert.match(String(key.delivery), new RegExp(`^${consumer}:\\d+$`));
  assert.equal(core.status().consumers[0]?.delivered, key.delivery);
  assert.equal(core.status().consumers[0]?.cursor, null);

  // Unacknowledged: lens_look hands the same version over again, re-rendered
  // from the unchanged cursor under a fresh delivery id.
  const again = await run('lens_look');
  assert.equal(again.v, key.v);
  assert.equal(again.kind, 'key');
  assert.notEqual(again.delivery, key.delivery);
  assert.ok(String(again.text).includes(`d=${again.delivery}`));

  // The superseded id is not the outstanding one any more, so acking it does nothing.
  await run('lens_history', { ack: key.delivery, limit: 10 });
  assert.equal(core.status().consumers[0]?.delivered, again.delivery);

  // lens_history acknowledges the outstanding one in the same call, and lists
  // every delivery already rendered for this consumer.
  const history = await run('lens_history', { ack: again.delivery, limit: 10 });
  assert.equal(history.events, 2, 'the receipt counts, the body lists');
  const listed = (JSON.parse(String(history.text)) as { events: { delivery: string }[] }).events;
  assert.deepEqual(listed.map((e) => e.delivery), [key.delivery, again.delivery]);
  assert.equal(core.status().consumers[0]?.delivered, null);
  assert.equal(core.status().consumers[0]?.cursor, key.v);

  // A later change is a delta from that cursor, not the whole document again.
  const waiting = run('lens_wait', { timeout_s: 5 });
  setTimeout(() => fixture.inject({ rows: ['ready', 'building…', 'error: build failed'], seq: 2 }), 10);
  const delta = await waiting;
  assert.equal(delta.kind, 'delta');
  assert.equal(delta.since, key.v);
  assert.match(String(delta.text), /\n\+ [\d,]+ pty "error: build failed"/, delta.text);
  assert.notEqual(delta.delivery, key.delivery);

  // A quiet wait is a normal result, and an ack of the outstanding delivery.
  const quiet = await run('lens_wait', { ack: delta.delivery, timeout_s: 1 });
  assert.equal(quiet.timeout, true);
  assert.equal(core.status().consumers[0]?.delivered, null);
  assert.equal(core.status().consumers[0]?.cursor, delta.v);
});

test('an image result becomes a conversation-local file through the device tool path', async (t) => {
  const user = createUser('lens-tools-image@example.com', 'pw-lens-tools-4');
  saveDashboard(user, validateLayout([{ i: 'ag1', type: 'agent', size: '2x2', config: { provider: 'codex' } }])!);
  const conversation = activeConversation(user, 'ag1', 'codex');
  const source = 'screen:local';

  const realSource = SOURCES.screen;
  SOURCES.screen = (): Source => ({ async connect(_u: number, _t: string, _f: Feed) { return () => {}; } });
  const realCall = LENS_TOOLS.lens_crop.call;
  // Stands in for the B2 body: the shape `storeImage` in dev/tool-routing.ts consumes.
  LENS_TOOLS.lens_crop.call = () => ({
    text: '{"ref":"f-1-2"}',
    receipt: { ref: 'f-1-2', v: 3 },
    // A frame-sized JPEG: ~40 KB of base64, far over the tool output cap. The
    // bytes are swapped for a file id before the model sees them, so they are
    // never what the result is measured as.
    image: { data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(30_000, 0x7f)]).toString('base64'), mime: 'image/jpeg' },
  });
  t.after(() => {
    LENS_TOOLS.lens_crop.call = realCall;
    releaseLens(user, source);
    if (realSource) SOURCES.screen = realSource; else delete SOURCES.screen;
  });

  const out = await DEV_TOOLS.lens_crop.run(
    { runtime: 'desktop', device: 'local', source, rect: [0, 0, 8, 8] },
    { userId: user, ward: 'agent:ag1', conv: conversation.id } as ToolCtx
  ) as Record<string, unknown>;
  assert.equal(out.ref, 'f-1-2');
  assert.equal(typeof out.file_id, 'number');
  assert.equal(out.image_sha256 !== undefined, true);
  assert.ok(!('image' in out), 'the bytes never reach the model as base64');
  assert.equal(out.device, 'local');
});

test('a full document fits the agent output cap, page by page, and never livelocks', async (t) => {
  const user = createUser('lens-tools-cap@example.com', 'pw-lens-tools-5');
  saveDashboard(user, validateLayout([{ i: 'ag1', type: 'agent', size: '2x2', config: { provider: 'codex' } }])!);
  const conversation = activeConversation(user, 'ag1', 'codex');
  const ctx = { userId: user, ward: 'agent:ag1', conv: conversation.id } as ToolCtx;

  const fixture = terminalFixture(() => Date.now());
  const real = SOURCES.terminal;
  SOURCES.terminal = (): Source => terminalSource(fixture.deps);
  // The fixture announces output for its own session id, so the source must name it.
  const source = 'terminal:s1';
  t.after(() => {
    releaseLens(user, source);
    SOURCES.terminal = real;
  });
  // Far more text than one delivery can carry, and as hostile to JSON as real
  // output gets: every row is quotes or Windows backslashes, each of which is
  // two characters once the result is serialised for the model.
  const rows = Array.from({ length: 400 }, (_, i) =>
    i % 2 === 0
      ? `r${i} "${'"'.repeat(30)}" said "the thing" "${i}"`
      : `r${i} C:\\Users\\rime\\${'\\'.repeat(30)}build\\out${i}`
  );
  fixture.inject({ rows, seq: 1 });
  lens(user, source, (): LensSettings => ({ settleMs: 0, minLines: 1 }));

  const run = (name: 'lens_look' | 'lens_wait', args: Record<string, unknown> = {}) =>
    lensToolRun(name, { source, ...args }, ctx) as Promise<Record<string, any>>;
  // What core.ts measures before it drops a whole result (OUTPUT_CAP).
  const serialized = (out: unknown) => JSON.stringify(out).length;

  // lensToolRun's assertion throws rather than cut an already-claimed delivery,
  // so every call below reaching its receipt at all is the proof that the
  // escaped-length budget held.
  const look = await run('lens_look');
  assert.ok(serialized(look) <= 12_000, `lens_look serialised to ${serialized(look)}`);


  const page1 = await run('lens_wait', { timeout_s: 5 });
  assert.ok(serialized(page1) <= 12_000, `page 1 serialised to ${serialized(page1)}`);
  assert.equal(page1.kind, 'key');
  assert.match(String(page1.page), /^1\/[2-9]\d*$/, 'a document this size is paged');
  assert.equal(page1.truncated, undefined);

  // The pending page is handed over again inside a look, which must also fit.
  const pending = await run('lens_look');
  assert.ok(serialized(pending) <= 12_000, `look with a pending page serialised to ${serialized(pending)}`);
  // A look wraps the pending page in its own header, so the page's tail can
  // fall to lens_look's own cut — but never to core.ts's.
  assert.ok(String(pending.text).includes(`d=${pending.delivery} key`), 'the pending page is handed over whole-headed');

  // Acknowledging a page moves to the next one rather than rendering it again,
  // and walking the whole keyframe hands over every row exactly once: no line
  // is lost at a page boundary, and no page is over the cap.
  const seen: string[] = [];
  const collect = (out: Record<string, any>): void => {
    assert.ok(serialized(out) <= 12_000, `${String(out.page)} serialised to ${serialized(out)}`);
    assert.equal(out.truncated, undefined, `${String(out.page)} was truncated`);
    for (const line of String(out.text).split('\n')) {
      const row = /^[=+] [\d,]+ pty "(.*)"$/.exec(line);
      if (row) seen.push(JSON.parse(`"${row[1]}"`) as string);
    }
  };
  collect(page1);
  const pages = Number(String(page1.page).split('/')[1]);
  assert.ok(pages >= 2, 'a document this size is paged');
  // The look above re-rendered page 1 under a new id, so that is what is
  // outstanding; every page after it comes back through lens_wait, whose text
  // is the delivery itself and is never wrapped or cut.
  let ack = String(pending.delivery);
  for (let n = 2; n <= pages; n++) {
    const page = await run('lens_wait', { ack, timeout_s: 5 });
    assert.equal(String(page.page).split('/')[0], String(n), 'each ack moves one page on');
    collect(page);
    ack = String(page.delivery);
  }
  assert.deepEqual(seen, rows, 'every row arrives exactly once, in order, across the pages');

  // The same page read two ways carries the same rows: a delivery re-offered
  // inside lens_look is handed over verbatim, never re-cut against the look's
  // own header.
  const rowsOf = (out: Record<string, any>): string[] => {
    const found: string[] = [];
    for (const line of String(out.text).split('\n')) {
      const row = /^[=+] [\d,]+ pty "(.*)"$/.exec(line);
      if (row) found.push(JSON.parse(`"${row[1]}"`) as string);
    }
    return found;
  };
  assert.deepEqual(rowsOf(pending), rowsOf(page1), 'the look re-offer carries page 1 whole');

  // A history of pages this size fits too: the JSON body is the result once,
  // and the receipt beside it is a count, not the same events again.
  const listed = await lensToolRun('lens_history', { source, limit: 50 }, ctx) as Record<string, any>;
  assert.ok(serialized(listed) <= 12_000, `lens_history serialised to ${serialized(listed)}`);
  assert.equal(typeof listed.events, 'number');
  assert.ok(listed.events >= 1);

  // A delta big enough to need cutting is budgeted the same way, and the wait
  // after it proceeds instead of throwing the same result over and over.
  const more = Array.from({ length: 200 }, (_, i) => `n${i} "${'"'.repeat(30)}" fresh "${i}"`);
  const waiting = run('lens_wait', { ack, timeout_s: 5 });
  setTimeout(() => fixture.inject({ rows: [...rows, ...more], seq: 2 }), 10);
  const delta = await waiting;
  assert.equal(delta.kind, 'delta');
  assert.equal(delta.truncated, true, 'a delta this size is cut');
  assert.ok(serialized(delta) <= 12_000, `the truncated delta serialised to ${serialized(delta)}`);
  // Acknowledging it moves on: the next delivery is a fresh keyframe, not the
  // same delta refused again.
  const after = await run('lens_wait', { ack: delta.delivery, timeout_s: 5 });
  assert.ok(serialized(after) <= 12_000, `the delivery after it serialised to ${serialized(after)}`);
  assert.notEqual(after.delivery, delta.delivery);
});

test('short rows pay for their newlines: a look beside a truncated delta still fits', async (t) => {
  const user = createUser('lens-tools-newline@example.com', 'pw-lens-tools-6');
  saveDashboard(user, validateLayout([{ i: 'ag1', type: 'agent', size: '2x2', config: { provider: 'codex' } }])!);
  const conversation = activeConversation(user, 'ag1', 'codex');
  const ctx = { userId: user, ward: 'agent:ag1', conv: conversation.id } as ToolCtx;

  const fixture = terminalFixture(() => Date.now());
  const real = SOURCES.terminal;
  SOURCES.terminal = (): Source => terminalSource(fixture.deps);
  const source = 'terminal:s1';
  t.after(() => {
    releaseLens(user, source);
    SOURCES.terminal = real;
  });
  // The shortest rows that still have distinct identities: the more lines a
  // result holds, the more newlines it carries, and a newline is two characters
  // inside the JSON string the model reads it as.
  const rows = Array.from({ length: 400 }, (_, i) => `a${i}`);
  fixture.inject({ rows, seq: 1 });
  lens(user, source, (): LensSettings => ({ settleMs: 0, minLines: 1 }));

  const run = (name: 'lens_look' | 'lens_wait', args: Record<string, unknown> = {}) =>
    lensToolRun(name, { source, ...args }, ctx) as Promise<Record<string, any>>;
  const serialized = (out: unknown) => JSON.stringify(out).length;

  const key = await run('lens_wait', { timeout_s: 5 });
  let ack = String(key.delivery);
  for (let n = 2; n <= Number(String(key.page ?? '1/1').split('/')[1]); n++) {
    ack = String((await run('lens_wait', { ack, timeout_s: 5 })).delivery);
  }
  // A change big enough to cut, left unacknowledged.
  const waiting = run('lens_wait', { ack, timeout_s: 5 });
  setTimeout(() => fixture.inject({ rows: [...rows, ...Array.from({ length: 400 }, (_, i) => `b${i}`)], seq: 2 }), 10);
  const delta = await waiting;
  assert.equal(delta.kind, 'delta');
  assert.equal(delta.truncated, true);
  assert.ok(serialized(delta) <= 12_000, `the delta serialised to ${serialized(delta)}`);

  // The look that re-offers it also carries the header and as much of the
  // document as fits — every line of it charged for its newline.
  const look = await run('lens_look');
  assert.ok(serialized(look) <= 12_000, `the look serialised to ${serialized(look)}`);
});

test('an offline screen source answers every tool with the reason, never the symptom', async (t) => {
  const user = createUser('lens-tools-offline@example.com', 'pw-lens-tools-6');
  const source = 'screen:local';
  const real = SOURCES.screen;
  let feed: Feed | null = null;
  SOURCES.screen = (): Source => ({
    async connect(_u: number, _t: string, f: Feed) {
      feed = f;
      return () => {};
    },
  });
  t.after(() => {
    releaseLens(user, source);
    if (real) SOURCES.screen = real;
    else delete SOURCES.screen;
  });

  const ctx = { userId: user, ward: 'agent:ag1', conv: 9 } as ToolCtx;
  const core = lens(user, source)!;
  const run = (name: Parameters<typeof lensToolRun>[0], args: Record<string, unknown> = {}) =>
    lensToolRun(name, { source, ...args }, ctx) as Promise<Record<string, any>>;

  // The first read connects the source, which is what hands the feed over.
  await run('lens_look');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(feed, 'the source connected');
  // What the screen source itself would say after `lens-start` answered
  // `not-consented` — the ONE place those words are written (screen.ts).
  const REASON = screenOffline('not-consented');
  assert.equal(REASON, 'the Screen lens is turned off for this Mac');
  (feed as Feed).offline(REASON);

  // The three document reads still answer — the last document stands — but the
  // receipt says why there is nothing in it.
  for (const name of ['lens_look', 'lens_text', 'lens_history'] as const) {
    assert.equal((await run(name)).offline, REASON, name);
  }
  // A frame nobody captured is not `frame-evicted`, it is a lens that is off.
  assert.equal((await run('lens_look', { frame: true })).frameError, REASON);
  // A quiet wait on a deaf source says so rather than returning a bare timeout.
  const quiet = await run('lens_wait', { timeout_s: 1 });
  assert.equal(quiet.timeout, true);
  assert.equal(quiet.offline, REASON);

  // Everything that needs the source to be READING refuses with the reason,
  // never with `frame-evicted` or `no-target`.
  const args = { rect: [0, 0, 10, 10], id: 'x', kind: 'card', anchor: { corner: 'tl' }, on: true };
  for (const name of ['lens_crop', 'lens_describe', 'overlay_show', 'lens_captions'] as const) {
    await assert.rejects(() => run(name, args), new RegExp(`^Error: ${name} is unavailable: ${REASON}$`), name);
  }
  // overlay_clear is the exception: stopping the lens leaves the overlay pool
  // alone, so a card drawn before consent was withdrawn is still on screen and
  // refusing here would strand it there for its whole ttl.
  captionsFor(core, { clock: systemClock, settings: () => ({ caption_from: null, caption_to: null }), desktop: async () => true });
  assert.equal((await run('overlay_clear')).cleared, 'all');
  // A refused `lens_captions {on:true}` stores nothing: the pair would otherwise
  // outlive a call that never drew anything.
  await assert.rejects(() => run('lens_captions', { on: true, from: 'en', to: 'es' }), /lens_captions is unavailable/);
  assert.equal(lensSettings().caption_from, null);
  assert.equal(lensSettings().caption_to, null);
  // Turning captions OFF is never refused: a lens that went down mid-caption
  // still has to be able to take them down.
  assert.equal((await run('lens_captions', { on: false })).on, false);

  // Consent given back brings the same core live, and the tools stop saying it.
  (feed as Feed).online();
  assert.equal((await run('lens_look')).offline, undefined);
});

test('a paused lens says so in every receipt, and a wait returns at once instead of parking', async (t) => {
  const user = createUser('lens-tools-paused@example.com', 'pw-lens-tools-7');
  const source = 'screen:local';
  const real = SOURCES.screen;
  const realTerminal = SOURCES.terminal;
  const idle = (): Source => ({ async connect(_u: number, _t: string, _f: Feed) { return () => {}; } });
  SOURCES.screen = idle;
  SOURCES.terminal = idle;
  t.after(() => {
    setLensPaused(user, false);
    releaseLens(user, source);
    releaseLens(user, 'terminal:s9');
    if (real) SOURCES.screen = real; else delete SOURCES.screen;
    if (realTerminal) SOURCES.terminal = realTerminal; else delete SOURCES.terminal;
  });

  const ctx = { userId: user, ward: 'agent:ag1', conv: 11 } as ToolCtx;
  const run = (name: Parameters<typeof lensToolRun>[0], args: Record<string, unknown> = {}) =>
    lensToolRun(name, { source, ...args }, ctx) as Promise<Record<string, any>>;

  assert.equal((await run('lens_look')).paused, undefined, 'a running lens says nothing about pause');
  setLensPaused(user, true);
  for (const name of ['lens_look', 'lens_text', 'lens_history'] as const) {
    assert.equal((await run(name)).paused, true, name);
  }

  // Nothing will arrive until the user resumes, so the wait says so now rather
  // than five minutes from now.
  const started = Date.now();
  const quiet = await run('lens_wait', { timeout_s: 300 });
  assert.equal(quiet.timeout, true);
  assert.equal(quiet.paused, true);
  assert.ok(Date.now() - started < 2000, 'a paused wait does not park');
  // Paused is not offline: the lens is consented to, granted and still bound.
  assert.equal(quiet.offline, undefined);

  // Pause is the SCREEN's, not every source's: a terminal on this runtime is
  // unaffected by it.
  const terminal = await lensToolRun('lens_look', { source: 'terminal:s9' }, ctx) as Record<string, any>;
  assert.equal(terminal.paused, undefined);

  setLensPaused(user, false);
  assert.equal((await run('lens_wait', { timeout_s: 1 })).paused, undefined);
});
