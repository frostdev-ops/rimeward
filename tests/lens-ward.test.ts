import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, validateLayout, type WardInstance } from '../src/lib/wards.ts';
import { shareCeiling } from '../src/lib/shares.ts';
import { requestWard } from '../src/lib/dev/instance-routing.ts';
import { lensPaused, setLensPaused } from '../src/lib/lens/runtime.ts';

const cfg = (config: Record<string, unknown>): Record<string, unknown> =>
  validateLayout([{ i: 'l', type: 'lens', size: '3x2', config }])![0]!.config!;

test('the catalog entry carries its vocabulary and is configurable', () => {
  const c = CATALOG.lens!;
  assert.equal(c.category, 'rime');
  assert.equal(c.icon, 'eye');
  assert.equal(c.defaultSize, '3x2');
  assert.equal(c.configurable, true);
  assert.equal(c.multi, undefined); // one screen per computer
  assert.ok(c.concepts.length >= 5);
  assert.ok(c.does.length >= 3);
});

test('validateLayout rebuilds the config with clamps and defaults', () => {
  assert.deepEqual(cfg({}), { settleMs: 400, minLines: 2, pixels: true, overlay: true });
  assert.deepEqual(cfg({ settleMs: 1200.4, minLines: 7, pixels: false, overlay: false }), {
    settleMs: 1200,
    minLines: 7,
    pixels: false,
    overlay: false,
  });
  assert.equal(cfg({ settleMs: 1 }).settleMs, 100);
  assert.equal(cfg({ settleMs: 99_999 }).settleMs, 5000);
  assert.equal(cfg({ settleMs: 'nonsense' }).settleMs, 400);
  assert.equal(cfg({ minLines: 0 }).minLines, 1);
  assert.equal(cfg({ minLines: 500 }).minLines, 50);
  // Junk knobs never take the layout down, and nothing else is stored.
  assert.deepEqual(Object.keys(cfg({ note: 'x' })).sort(), ['minLines', 'overlay', 'pixels', 'settleMs']);
});

test('a lens ward is never shareable', () => {
  assert.equal(CATALOG.lens!.share, undefined);
  assert.ok(!shareCeiling({ i: 'l', type: 'lens', size: '3x2' } as WardInstance));
});

test('the route is ward-scoped, so a device-placed lens relays', () => {
  assert.equal(requestWard('/api/lens/x'), 'x');
  assert.equal(requestWard('/api/lens/x?action=pause'), 'x');
});

test('pause is a settings row, not layout config', () => {
  assert.equal(lensPaused(7), false);
  setLensPaused(7, true);
  assert.equal(lensPaused(7), true);
  assert.equal(lensPaused(8), false); // per user
  setLensPaused(7, false);
  assert.equal(lensPaused(7), false);
});

test("the card's captions switch honours the ward's overlay knob like the tool does", async () => {
  const { OVERLAY_OFF } = await import('../src/lib/lens/tools.ts');
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/pages/api/lens/[ward].ts', import.meta.url), 'utf8'));
  // The route refuses `captions {on:true}` with the tool's own message when the
  // Screen lens ward has the overlay turned off — one knob, every door.
  assert.match(src, /overlay === false\)\s*\n\s*return Response\.json\(\{ error: OVERLAY_OFF \}, \{ status: 409 \}\)/);
  assert.equal(OVERLAY_OFF, 'the Screen lens ward has the overlay turned off');
});

test('the card refuses captions when the lens is not reading, and stores no pair', async (t) => {
  const { POST } = await import('../src/pages/api/lens/[ward].ts');
  const { SOURCES, lens, releaseLens } = await import('../src/lib/lens/core.ts');
  const { screenOffline } = await import('../src/lib/lens/screen.ts');
  const { lensSettings } = await import('../src/lib/lens/settings.ts');
  const { createUser } = await import('../src/lib/users.ts');
  const { saveDashboard } = await import('../src/lib/dashboard.ts');

  const user = createUser('lens-ward-captions@example.com', 'pw-lens-ward-1');
  saveDashboard(user, validateLayout([{ i: 'ln1', type: 'lens', size: '3x2' }])!);
  const real = SOURCES.screen;
  SOURCES.screen = () => ({ async connect() { return () => {}; } });
  t.after(() => {
    releaseLens(user, 'screen:local');
    if (real) SOURCES.screen = real;
    else delete SOURCES.screen;
  });

  const core = lens(user, 'screen:local')!;
  core.feed.offline(screenOffline('not-consented'));
  const post = (body: unknown): Promise<Response> =>
    POST({
      params: { ward: 'ln1' },
      locals: { user: { userId: user } },
      request: new Request('https://rimeward.invalid/api/lens/ln1', { method: 'POST', body: JSON.stringify(body) }),
    } as never) as Promise<Response>;

  const res = await post({ action: 'captions', on: true, from: 'en', to: 'es' });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, 'the Screen lens is turned off for this Mac');
  // The pair is stored by the call that works, never by the one that refused.
  assert.equal(lensSettings().caption_from, null);
  assert.equal(lensSettings().caption_to, null);
});
