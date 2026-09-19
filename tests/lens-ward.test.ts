import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, validateLayout, type WardInstance } from '../src/lib/wards.ts';
import { shareCeiling } from '../src/lib/shares.ts';
import { requestWard } from '../src/lib/dev/instance-routing.ts';
import { lensPaused, setLensPaused } from '../src/pages/api/lens/[ward].ts';

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
