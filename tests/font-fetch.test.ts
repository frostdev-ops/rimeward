import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, createServer } from 'vite';
import { fontFetchRetry, retryFontFetch } from '../ops/font-fetch.mjs';

// Exercise the installed Astro implementation that emitted CannotFetchFontFile.
const { CachedFontFetcher } = await import(new URL(
  '../node_modules/astro/dist/assets/fonts/infra/cached-font-fetcher.js', import.meta.url,
).href);
const fontUrl = 'https://fonts.gstatic.com/l/font?kit=preview&skey=existing&v=v24';
const fontBytes = Buffer.from('wOF2-controlled-font-bytes');
function fontFetcher(fetch: typeof globalThis.fetch) {
  const cache = new Map<string, Buffer>();
  return new CachedFontFetcher({
    fetch, readFile: () => assert.fail('remote fonts must use fetch'),
    storage: { getItemRaw: (id: string) => cache.get(id), setItemRaw: (id: string, value: Buffer) => cache.set(id, value) },
  });
}

test('Astro binary font fetch retries a transient failure and preserves cache bytes and request', async () => {
  let calls = 0;
  const init = { headers: { 'x-font-header': 'same' } };
  const response = new Response(fontBytes, { headers: { 'content-type': 'font/woff2' } });
  const original: typeof fetch = async (input, options) => {
    assert.equal(input, fontUrl); assert.equal(options, init);
    if (++calls === 1) throw new TypeError('fetch failed');
    return response;
  };
  // The unmodified CachedFontFetcher reproduces the actual CI failure in one attempt.
  await assert.rejects(fontFetcher(original).fetch({ id: 'same.woff2', url: fontUrl, init }), { name: 'CannotFetchFontFile' });
  assert.equal(calls, 1);
  calls = 0;
  const cached = fontFetcher(retryFontFetch(original));
  assert.deepEqual(await cached.fetch({ id: 'same.woff2', url: fontUrl, init }), fontBytes);
  assert.equal(calls, 2);
  assert.deepEqual(await cached.fetch({ id: 'same.woff2', url: fontUrl, init }), fontBytes);
  assert.equal(calls, 2);
});

test('font retries preserve the native Response and cover HTTP and incomplete body failures', async () => {
  let calls = 0;
  const response = new Response(fontBytes, { status: 200, headers: { 'content-type': 'font/woff2' } });
  const wrapped = retryFontFetch(async () => {
    calls++;
    if (calls === 1) return new Response('busy', { status: 503 });
    if (calls === 2) return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')); } }));
    return response;
  });
  assert.equal(await wrapped(fontUrl), response);
  assert.equal(calls, 3);
  assert.equal(response.bodyUsed, false);
  assert.equal(response.headers.get('content-type'), 'font/woff2');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fontBytes);
});

test('font retries remain bounded and expose network, HTTP and nontransient failures', async () => {
  let calls = 0;
  const failure = new TypeError('fetch failed');
  await assert.rejects(retryFontFetch(async () => { calls++; throw failure; })(fontUrl), error => error === failure);
  assert.equal(calls, 3);
  calls = 0;
  const cached = fontFetcher(retryFontFetch(async () => { calls++; return new Response('busy', { status: 429 }); }));
  await assert.rejects(cached.fetch({ id: 'uncached.woff2', url: fontUrl }), { name: 'CannotFetchFontFile' });
  assert.equal(calls, 3);
  for (const status of [400, 403, 404]) {
    calls = 0;
    const response = await retryFontFetch(async () => { calls++; return new Response('denied', { status }); })(fontUrl);
    assert.equal(response.status, status); assert.equal(calls, 1);
  }
  calls = 0;
  const invalid = new TypeError('invalid request');
  await assert.rejects(retryFontFetch(async () => { calls++; throw invalid; })(fontUrl), error => error === invalid);
  assert.equal(calls, 1);
  calls = 0;
  const certificate = new TypeError('fetch failed', { cause: Object.assign(new Error('bad certificate'), { code: 'CERT_HAS_EXPIRED' }) });
  await assert.rejects(retryFontFetch(async () => { calls++; throw certificate; })(fontUrl), error => error === certificate);
  assert.equal(calls, 1);
});

test('font retries respect abort before fetching and while waiting or reading a body', async () => {
  for (const stage of ['before', 'wait', 'response', 'body']) {
    const controller = new AbortController();
    const reason = new Error(`abort ${stage}`);
    let calls = 0;
    if (stage === 'before') controller.abort(reason);
    const wrapped = retryFontFetch(async () => {
      calls++;
      if (stage === 'response') { controller.abort(reason); return new Response('busy', { status: 503 }); }
      if (stage === 'body') return new Response(new ReadableStream({ start(stream) {
        controller.abort(reason); stream.error(reason);
      } }));
      setTimeout(() => controller.abort(reason), 10);
      throw new TypeError('fetch failed');
    });
    await assert.rejects(wrapped(fontUrl, { signal: controller.signal }), error => error === reason);
    assert.equal(calls, stage === 'before' ? 0 : 1);
  }
});

test('font retry leaves unrelated fetches and request methods untouched', async () => {
  const request = new Request(fontUrl, { headers: { 'x-request': 'same' } });
  for (const [input, init] of [
    ['https://example.com/font.woff2', undefined], ['http://fonts.gstatic.com/font.woff2', undefined],
    ['https://fonts.gstatic.com:444/font.woff2', undefined], [fontUrl, { method: 'POST' }],
    [request, { method: 'POST' }],
  ] as const) {
    let calls = 0;
    const response = new Response(fontBytes);
    assert.equal(await retryFontFetch(async (actual, options) => {
      calls++; assert.equal(actual, input); assert.equal(options, init); return response;
    })(input, init), response);
    assert.equal(calls, 1); assert.equal(response.bodyUsed, false);
  }
  const response = new Response(fontBytes);
  assert.equal(await retryFontFetch(async input => { assert.equal(input, request); return response; })(request), response);
  assert.equal(request.headers.get('x-request'), 'same');
});

test('Vite installs before Astro captures fetch and restores on successive builds and failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rimeward-font-build-'));
  const realFetch = globalThis.fetch;
  const plugin = fontFetchRetry();
  assert.equal(plugin.apply, 'build');
  await writeFile(join(root, 'entry.js'), 'export const value = 1;');
  try {
    const dev = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [plugin] });
    try {
      assert.equal(globalThis.fetch, realFetch);
      assert.equal(dev.config.plugins.some(p => p.name === plugin.name), false);
    } finally { await dev.close(); }
    for (const failure of [undefined, undefined, 'start', 'end']) {
      let calls = 0;
      const original: typeof fetch = async () => {
        if (++calls === 1) throw new TypeError('fetch failed');
        return new Response(fontBytes);
      };
      globalThis.fetch = original;
      let cached: ReturnType<typeof fontFetcher>;
      const run = build({ root, configFile: false, logLevel: 'silent',
        build: { write: false, rolldownOptions: { input: join(root, 'entry.js') } },
        plugins: [plugin, { name: 'actual-astro-font-fetcher',
          buildStart() {
            assert.notEqual(globalThis.fetch, original);
            cached = fontFetcher(globalThis.fetch);
            if (failure === 'start') throw new Error('controlled start failure');
          },
          async buildEnd(error) {
            if (error) return;
            assert.deepEqual(await cached.fetch({ id: 'same.woff2', url: fontUrl }), fontBytes);
            if (failure === 'end') throw new Error('controlled end failure');
          },
        }],
      });
      if (failure) await assert.rejects(run, new RegExp(`controlled ${failure} failure`));
      else await run;
      assert.equal(globalThis.fetch, original, `restore after ${failure ?? 'success'}`);
      assert.equal(calls, failure === 'start' ? 0 : 2);
    }
  } finally { globalThis.fetch = realFetch; await rm(root, { recursive: true, force: true }); }
});
