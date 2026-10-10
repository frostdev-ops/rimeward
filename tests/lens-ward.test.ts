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

test('actual runtime sends off/on before a chooser settles and ignores superseded native results and abort failures', async (t) => {
  const { screenDemand, SCREEN_SOURCE } = await import('../src/lib/lens/runtime.ts');
  const { SOURCES, lens, releaseLens } = await import('../src/lib/lens/core.ts');
  const { localOwner } = await import('../src/lib/dev/native.ts');
  const { setLensSettings } = await import('../src/lib/lens/settings.ts');
  const native = globalThis as typeof globalThis & { __nativeDesktop?: (op: string, value?: unknown, deadline?: number, signal?: AbortSignal) => Promise<unknown> };
  const original = native.__nativeDesktop;
  const source = SOURCES.screen;
  const desktop = process.env.RIMEWARD_DESKTOP;
  const token = process.env.RIMEWARD_NATIVE_TOKEN;
  process.env.RIMEWARD_DESKTOP = '1';
  process.env.RIMEWARD_NATIVE_TOKEN = 'test-only';
  SOURCES.screen = () => ({ async connect() { return () => {}; } });
  setLensSettings({ consented: true });
  const owner = localOwner();
  const core = lens(owner, SCREEN_SOURCE)!;
  t.after(() => {
    releaseLens(owner, SCREEN_SOURCE);
    if (source) SOURCES.screen = source; else delete SOURCES.screen;
    if (original) native.__nativeDesktop = original; else Reflect.deleteProperty(native, '__nativeDesktop');
    if (desktop === undefined) delete process.env.RIMEWARD_DESKTOP; else process.env.RIMEWARD_DESKTOP = desktop;
    if (token === undefined) delete process.env.RIMEWARD_NATIVE_TOKEN; else process.env.RIMEWARD_NATIVE_TOKEN = token;
  });
  const status = { state: 'running', permissions: { screen: true, ax: false }, capabilities: { embed: false } };
  for (const failure of [false, true]) {
    const calls: { active: boolean; signal: AbortSignal; resolve(value: unknown): void; reject(error: Error): void }[] = [];
    native.__nativeDesktop = (op, value, _deadline, signal) => {
      assert.equal(op, 'lens-start');
      assert.ok(signal);
      return new Promise((resolve, reject) => calls.push({ active: (value as { active: boolean }).active, signal, resolve, reject }));
    };
    const old = screenDemand(true).then(() => null, error => error);
    const off = screenDemand(false).catch(() => {});
    const replacement = screenDemand(true);
    assert.deepEqual(calls.map(c => c.active), [true, false, true], 'all controls reach the native transport while old start is unresolved');
    assert.equal(calls[0]!.signal.aborted, true);
    assert.equal(calls[1]!.signal.aborted, true);
    calls[2]!.resolve(status);
    await replacement;
    assert.equal(core.status().state, 'live');
    const embedder = core.embedderId;
    calls[1]!.resolve({ ...status, state: 'stopped', reason: 'old-off' });
    await off;
    if (failure) calls[0]!.reject(new Error('late native abort failure'));
    else calls[0]!.resolve({ ...status, state: 'stopped', reason: 'permission', capabilities: { embed: true } });
    assert.equal(await old, null, 'runtime demand follows the current control; Source/Core own obsolete-reader refusal');
    assert.equal(core.status().state, 'live', 'obsolete errors/status cannot stop replacement');
    assert.equal(core.embedderId, embedder, 'obsolete helper grant cannot replace the current decider');
    const stopped = screenDemand(false);
    if (failure) calls[3]!.reject(new Error('native-cleanup-refused'));
    else calls[3]!.resolve({ ...status, state: 'stopped', reason: 'idle' });
    await stopped;
    if (failure) {
      assert.equal(core.status().state, 'offline', 'current native failure is still reported');
      assert.match(core.status().error ?? '', /native-cleanup-refused/);
    }
  }
});

for (const oldFailsBeforeReplacement of [false, true]) {
  test(`actual Core/screen reader follows a runtime refresh after ${oldFailsBeforeReplacement ? 'early native abort failure' : 'late ignored-abort success'}`, async (t) => {
    const { screenDemand, startLens, screenStartup, SCREEN_SOURCE } = await import('../src/lib/lens/runtime.ts');
    const { screenSource } = await import('../src/lib/lens/screen.ts');
    const { SOURCES, lens, releaseLens } = await import('../src/lib/lens/core.ts');
    const { localOwner } = await import('../src/lib/dev/native.ts');
    const { setLensSettings } = await import('../src/lib/lens/settings.ts');
    const native = globalThis as typeof globalThis & { __nativeDesktop?: (op: string, value?: unknown, deadline?: number, signal?: AbortSignal) => Promise<unknown> };
    const original = native.__nativeDesktop;
    const source = SOURCES.screen;
    const desktop = process.env.RIMEWARD_DESKTOP;
    const token = process.env.RIMEWARD_NATIVE_TOKEN;
    process.env.RIMEWARD_DESKTOP = '1'; process.env.RIMEWARD_NATIVE_TOKEN = 'test-only';
    setLensSettings({ consented: true });
    const handlers = new Set<(signal: Record<string, unknown>) => void>();
    const starts: { active: boolean; signal: AbortSignal; resolve(value: unknown): void; reject(error: Error): void }[] = [];
    const reads: string[] = [];
    let heldRead: { op: string; value: Promise<unknown>; signal?: AbortSignal } | null = null;
    const running = { state: 'running', permissions: { screen: true, ax: false }, capabilities: { capture: true, embed: false, overlay: false } };
    let epoch = 2;
    native.__nativeDesktop = (op, value, _deadline, signal) => {
      if (op === 'lens-start') {
        assert.ok(signal);
        return new Promise((resolve, reject) => starts.push({ active: (value as { active: boolean }).active, signal, resolve, reject }));
      }
      reads.push(op);
      if (heldRead && heldRead.op === op) {
        const held = heldRead;
        heldRead = null;
        if (signal) held.signal = signal;
        return held.value;
      }
      return Promise.resolve(op === 'lens-status' ? running : {
        epoch, seq: epoch * 10, ocr: [{ text: `current ${epoch}`, bbox: [0, 0, 20, 18] }], latest: { ref: `current-${epoch}` },
        window: { id: epoch, title: `Current ${epoch}`, bounds: [0, 0, 20, 20], display: { id: 0, w: 20, h: 20, scale: 1 } },
        capabilities: running.capabilities,
      });
    };
    SOURCES.screen = () => screenSource({ desktop: (...args) => native.__nativeDesktop!(...args), demand: screenDemand, startup: screenStartup,
      attach: fn => { handlers.add(fn); return () => { handlers.delete(fn); }; } });
    const owner = localOwner();
    const core = lens(owner, SCREEN_SOURCE)!;
    t.after(() => {
      releaseLens(owner, SCREEN_SOURCE);
      for (const call of starts) call.resolve(running);
      if (source) SOURCES.screen = source; else delete SOURCES.screen;
      if (original) native.__nativeDesktop = original; else Reflect.deleteProperty(native, '__nativeDesktop');
      if (desktop === undefined) delete process.env.RIMEWARD_DESKTOP; else process.env.RIMEWARD_DESKTOP = desktop;
      if (token === undefined) delete process.env.RIMEWARD_NATIVE_TOKEN; else process.env.RIMEWARD_NATIVE_TOKEN = token;
    });
    const tick = () => new Promise<void>(done => setImmediate(done));
    const frame = () => { for (const fn of [...handlers]) fn({ kind: 'frame', epoch, seq: epoch * 10, ref: `current-${epoch}` }); };
    assert.equal(await core.ready(), true, 'the real source is already connected');
    reads.length = 0;
    const reader = core.acquire();
    let ready: boolean | null = null;
    const settled = core.ready().then(value => { ready = value; });
    const refresh = startLens();
    assert.equal(starts[0]!.signal.aborted, true);
    assert.deepEqual(starts.map(call => call.active), [true, true], 'refresh does not add a reader');
    if (oldFailsBeforeReplacement) starts[0]!.reject(new Error('obsolete native abort failure'));
    await tick();
    assert.equal(ready, null, 'readiness follows the still-pending replacement');
    assert.deepEqual(reads, [], 'no status/recovery read before current startup');
    starts[1]!.resolve(running);
    await refresh;
    await tick(); frame();
    await reader.ready;
    await settled;
    assert.equal(ready, true);
    assert.equal(core.status().state, 'live');
    assert.equal(core.status().error, null);
    assert.equal(core.doc().lines[0]!.text, 'current 2');
    const embedder = core.embedderId;
    if (!oldFailsBeforeReplacement) starts[0]!.resolve({ ...running, state: 'stopped', reason: 'permission', capabilities: { embed: true } });
    await tick();
    assert.equal(core.status().state, 'live', 'late old native completion cannot mark the same reader offline');
    assert.equal(core.embedderId, embedder);

    for (const op of ['lens-status', 'lens-snapshot']) {
      let resolve!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      const held = { op, value: new Promise<unknown>((yes, no) => { resolve = yes; reject = no; }), signal: undefined as AbortSignal | undefined };
      heldRead = held;
      core.deleteConsumer('disconnect-fixture');
      let recovered: boolean | null = null;
      const recovery = core.ready().then(value => { recovered = value; });
      await tick();
      assert.equal(heldRead, null, `actual reconnect is waiting on ${op}`);
      const at = starts.length;
      const replacement = startLens();
      assert.equal(held.signal?.aborted, true, 'runtime refresh cancels the actual downstream read');
      if (oldFailsBeforeReplacement) {
        reject(new Error('obsolete downstream native abort failure'));
        await tick();
        assert.equal(recovered, null, 'recovery waits for current native startup');
      }
      epoch += 1;
      starts[at]!.resolve(running);
      await replacement;
      if (!oldFailsBeforeReplacement) resolve(op === 'lens-status'
        ? { state: 'stopped', reason: 'permission', capabilities: { capture: false, embed: true } }
        : { epoch: 99, seq: 999, ocr: [{ text: 'obsolete', bbox: [0, 0, 20, 18] }], latest: { ref: 'obsolete' }, capabilities: { capture: false, embed: true } });
      await recovery;
      assert.equal(recovered, true);
      assert.equal(core.status().state, 'live');
      assert.equal(core.status().error, null);
      assert.equal(core.doc().epoch, epoch);
      assert.equal(core.doc().lines[0]!.text, `current ${epoch}`);
      assert.equal(core.doc().ref, `current-${epoch}`);
      assert.equal(core.capabilities()?.capture, true, 'obsolete metadata cannot revoke current capture');
      assert.equal(core.embedderId, embedder);
    }

    const prior = starts.map(call => call.active);
    const at = starts.length;
    const pendingRefresh = startLens();
    reader.release();
    assert.deepEqual(starts.map(call => call.active), [...prior, true, false], 'last release sends off while refresh is unresolved');
    const next = core.acquire();
    epoch += 1;
    starts[at + 2]!.resolve(running);
    await tick(); frame();
    await next.ready;
    starts[at]!.reject(new Error('obsolete refresh failure'));
    starts[at + 1]!.resolve({ ...running, state: 'stopped', reason: 'obsolete off' });
    await pendingRefresh;
    await tick();
    assert.equal(core.status().state, 'live');
    assert.equal(core.doc().lines[0]!.text, `current ${epoch}`, 'replacement retains current recovery');
    next.release();
    starts[at + 3]!.resolve({ ...running, state: 'stopped', reason: 'idle' });
    await tick();
    assert.deepEqual(starts.map(call => call.active), [...prior, true, false, true, false], 'reader counts remain balanced');
    releaseLens(owner, SCREEN_SOURCE);
    assert.equal(handlers.size, 0);
  });
}

test('runtime status started before a replacement cannot publish into the new core', async (t) => {
  const { startLens, lensNativeStatus, SCREEN_SOURCE } = await import('../src/lib/lens/runtime.ts');
  const { SOURCES, lens, releaseLens } = await import('../src/lib/lens/core.ts');
  const { localOwner } = await import('../src/lib/dev/native.ts');
  const native = globalThis as typeof globalThis & { __nativeDesktop?: (op: string) => Promise<unknown> };
  const original = native.__nativeDesktop;
  const source = SOURCES.screen;
  const desktop = process.env.RIMEWARD_DESKTOP;
  const token = process.env.RIMEWARD_NATIVE_TOKEN;
  process.env.RIMEWARD_DESKTOP = '1'; process.env.RIMEWARD_NATIVE_TOKEN = 'test-only';
  SOURCES.screen = () => ({ async connect() { return () => {}; } });
  const owner = localOwner();
  const oldCore = lens(owner, SCREEN_SOURCE)!;
  let finish!: (value: unknown) => void;
  native.__nativeDesktop = op => op === 'lens-status' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ state: 'running', capabilities: { embed: false } });
  t.after(() => {
    releaseLens(owner, SCREEN_SOURCE);
    if (source) SOURCES.screen = source; else delete SOURCES.screen;
    if (original) native.__nativeDesktop = original; else Reflect.deleteProperty(native, '__nativeDesktop');
    if (desktop === undefined) delete process.env.RIMEWARD_DESKTOP; else process.env.RIMEWARD_DESKTOP = desktop;
    if (token === undefined) delete process.env.RIMEWARD_NATIVE_TOKEN; else process.env.RIMEWARD_NATIVE_TOKEN = token;
  });
  const pending = lensNativeStatus();
  releaseLens(owner, SCREEN_SOURCE);
  const replacement = lens(owner, SCREEN_SOURCE)!;
  await startLens();
  finish({ state: 'stopped', reason: 'permission' });
  assert.equal(await pending, null);
  assert.equal(replacement.status().state, 'live');
  assert.equal(oldCore.status().state, 'live');
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
  const { screenOffline } = await import('../src/lib/lens/types.ts');
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
