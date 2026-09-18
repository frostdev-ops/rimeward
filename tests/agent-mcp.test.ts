import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getDb } from '../src/lib/db.ts';
import { getDashboard, saveDashboard } from '../src/lib/dashboard.ts';
import { MAX_LONG_WAIT_MS, validateLayout, type WardInstance } from '../src/lib/wards.ts';
import { validateGraph } from '../src/lib/logic.ts';
import { loopbackVettedFetch, runShell, vettedFetch } from '../src/lib/agent/shell.ts';
import { getAttachment } from '../src/lib/agent/attachments.ts';
import { aiTools, invokeReadTool } from '../src/lib/agent/tools.ts';
import { MCP_PROTOCOL, callTool, clampLongWait, dropSession, mcpStatus, mcpToolDefs, mcpToolDefsSync, parseRpcBody, safeToolName, setMcpToken, storeImageParts, toolText } from '../src/lib/agent/mcp.ts';

/** A real 1x1 png — base64 with a '/' and padding, so the guard's charset is exercised. */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const listen = async (server: http.Server): Promise<string> => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
};
const shut = async (server: http.Server): Promise<void> => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
};

const user = (email: string): number => {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  return (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
};

test('parseRpcBody: one JSON message, a batch, or an SSE stream', () => {
  const msg = { jsonrpc: '2.0', id: 7, result: { ok: 1 } };
  assert.deepEqual(parseRpcBody('application/json', JSON.stringify(msg), 7), msg);
  assert.deepEqual(parseRpcBody('application/json', JSON.stringify([{ jsonrpc: '2.0', id: 6, result: 0 }, msg]), 7), msg);
  assert.equal(parseRpcBody('application/json', JSON.stringify(msg), 8), null);
  const sse = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n: keepalive\n\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`;
  assert.deepEqual(parseRpcBody('text/event-stream; charset=utf-8', sse, 7), msg);
  assert.equal(parseRpcBody('text/event-stream', '', 7), null);
});

test('safeToolName + toolText', () => {
  assert.equal(safeToolName('search.issues/v2'), 'search_issues_v2');
  assert.equal(toolText({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: 'x' }], structuredContent: { n: 1 } }), 'a\n[image image/png omitted]\n{"n":1}');
  assert.equal(toolText({ isError: true, content: [{ type: 'text', text: 'boom' }] }), 'ERROR: boom');
  assert.equal(toolText(null), '');
});

test('mcp ward: the config normalizes, the tools splice in under the trust level, the token rides the header', async () => {
  const u = user('mcp@t.dev');
  const layout = validateLayout([
    { i: 'gh', type: 'mcp', size: '2x1', config: { name: 'GitHub Stuff!', url: 'https://mcp.example.com/mcp', header: 'x-api-key', trust: 'read' } },
    { i: 'bare', type: 'mcp', size: '2x1', config: { name: '', url: 'not a url', trust: 'nope' } },
  ]);
  assert.ok(layout);
  saveDashboard(u, layout!);
  assert.deepEqual(getDashboard(u)[0]!.config, { name: 'github-stuff', url: 'https://mcp.example.com/mcp', header: 'x-api-key', trust: 'read' });
  assert.deepEqual(getDashboard(u)[1]!.config, { name: 'mcp', url: '', header: 'Authorization', trust: 'write' });
  setMcpToken(u, 'gh', 'sekrit');

  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fake = (async (url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, body });
    const json = (result: unknown, extra: Record<string, string> = {}) => ({
      status: 200,
      statusText: 'OK',
      url,
      headers: { 'content-type': 'application/json', ...extra },
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })),
    });
    switch (body.method) {
      case 'initialize':
        return json({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '1' } }, { 'mcp-session-id': 's1' });
      case 'notifications/initialized':
        return { status: 202, statusText: 'Accepted', url, headers: {}, body: Buffer.alloc(0) };
      case 'tools/list':
        return json({ tools: [{ name: 'search.issues', description: 'Search issues', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }, { name: 'odd', inputSchema: 'junk' }] });
      case 'tools/call': {
        const msg = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `found ${body.params.arguments.q}` }] } });
        return { status: 200, statusText: 'OK', url, headers: { 'content-type': 'text/event-stream' }, body: Buffer.from(`event: message\ndata: ${msg}\n\n`) };
      }
    }
    throw new Error(`unexpected ${body.method}`);
  }) as any;

  const defs = await mcpToolDefs(u, fake);
  assert.deepEqual(Object.keys(defs), ['mcp__github-stuff__search_issues', 'mcp__github-stuff__odd']);
  const search = defs['mcp__github-stuff__search_issues']!;
  assert.equal(search.kind, 'read');
  assert.deepEqual(search.parameters, { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] });
  assert.deepEqual(defs['mcp__github-stuff__odd']!.parameters, { type: 'object', properties: {} });
  assert.equal(calls[0]!.headers['x-api-key'], 'sekrit'); // a custom header carries the raw token
  assert.equal(calls[0]!.headers['mcp-session-id'], undefined);
  assert.equal(calls[2]!.headers['mcp-session-id'], 's1'); // the session id rides after initialize
  // the spec the model sees carries the reason like every other tool
  const spec = aiTools('read-only', defs).find((t) => t.name === 'mcp__github-stuff__search_issues')!;
  assert.deepEqual((spec.parameters as any).required, ['reason', 'q']);
  assert.deepEqual(await search.run({ reason: 'r', q: 'bug' }, { userId: u, ward: 'ag', conv: 1 }), { text: 'found bug' });
  assert.equal(calls.at(-1)!.body.params.name, 'search.issues'); // the wire name is the server's, reason stripped
  assert.deepEqual(calls.at(-1)!.body.params.arguments, { q: 'bug' });
  assert.equal(calls.length, 5); // session reused; tools/list revalidates the loaded definition before execution
  assert.deepEqual(Object.keys(mcpToolDefsSync(u)), Object.keys(defs));

  const st = await mcpStatus(u, 'gh', false, fake);
  assert.equal(st.ok, true);
  assert.equal(st.hasToken, true);
  assert.equal(st.server?.name, 'fake');

  // a server that will not connect: remembered, contributes nothing, the ward learns why
  dropSession(u, 'gh');
  const dead = (async () => {
    throw new Error('refused: mcp.example.com resolves to the private address 127.0.0.1');
  }) as any;
  assert.deepEqual(await mcpToolDefs(u, dead), {});
  assert.match((await mcpStatus(u, 'gh', false, dead)).error!, /private address/);
  await assert.rejects(callTool(u, 'gh', 'search.issues', {}, dead), /not connected/);
  setMcpToken(u, 'gh', null);
  assert.equal((await mcpStatus(u, 'bare', false, dead)).error, 'no server url configured');
});

test('mcp.call: an action on an mcp ward, arguments a JSON template', () => {
  const layout = [{ i: 'gh', type: 'mcp', size: '2x1', config: { name: 'github', url: 'https://x.dev/mcp' } }, { i: 'b', type: 'button', size: '1x1' }] as WardInstance[];
  const edge = {
    id: 'e1',
    source: { ward: 'b', trigger: 'button-pressed', params: {} },
    conditions: [],
    action: { type: 'mcp.call', ward: 'gh', params: { tool: 'search.issues', arguments: '{"q": "{{ward.title}}"}' } },
    enabled: true,
  };
  assert.equal(validateGraph({ edges: [edge] }, layout, { isAdmin: true })?.edges.length, 1);
  // anchored on the wrong ward type: dropped
  assert.equal(validateGraph({ edges: [{ ...edge, action: { ...edge.action, ward: 'b' } }] }, layout, { isAdmin: true }), null);
});

test('js-exec: a sandbox script reaches read-only tools through the proxy, and nothing else', async () => {
  const seen: string[] = [];
  const res = await runShell(1, `js-exec -c 'const r = await tools.echo({a: 1}); console.log(r.a + 1)'`, async (path, argsJson) => {
    seen.push(path);
    return JSON.stringify(JSON.parse(argsJson));
  });
  assert.equal(res.stderr, '');
  assert.equal(res.stdout.trim(), '2');
  assert.deepEqual(seen, ['echo']);
  // a second script, a different proxy closure: no singleton config conflict, the worker is reused
  const again = await runShell(1, `js-exec -c 'console.log(JSON.stringify(await tools.two({})))'`, async () => JSON.stringify({ two: 2 }));
  assert.equal(again.stdout.trim(), '{"two":2}');
  assert.equal(again.stderr, '');
  const ctx = { userId: 1, ward: 'ag', conv: 1 };
  await assert.rejects(invokeReadTool('send_mail', '{}', ctx), /not a read-only tool/);
  await assert.rejects(invokeReadTool('remember', '{}', ctx), /not a read-only tool/);
  await assert.rejects(invokeReadTool('nope', '{}', ctx), /not a read-only tool/);
  assert.equal(await invokeReadTool('list_timers', '', ctx), JSON.stringify(await (await import('../src/lib/agent/tools.ts')).TOOLS.list_timers!.run({}, ctx)));
});

test('storeImageParts: one png part becomes an attachment of this conversation, anything dubious is skipped', async () => {
  const u = user('mcpimg@t.dev');
  const ctx = { userId: u, ward: 'ag', conv: 0 };
  const res = (data: unknown, mimeType = 'image/png') => ({ content: [{ type: 'text', text: 'here' }, { type: 'image', mimeType, data }] });

  const stored = await storeImageParts(res(PNG_1X1), ctx, 'mcp__lens__lens_crop');
  assert.equal(typeof stored.file_id, 'number');
  assert.match(stored.image_sha256!, /^[a-f0-9]{64}$/);
  const file = getAttachment(u, stored.file_id!)!;
  assert.equal(file.mime, 'image/png');
  assert.equal(file.name, 'mcp__lens__lens_crop.png');

  assert.deepEqual(await storeImageParts(res('not base64!!'), ctx, 't'), {});          // charset
  assert.deepEqual(await storeImageParts(res('A'.repeat(7 * 1024 * 1024 + 4)), ctx, 't'), {}); // over 7 MiB
  assert.deepEqual(await storeImageParts(res(PNG_1X1, 'image/gif'), ctx, 't'), {});    // not png/jpeg
  assert.deepEqual(await storeImageParts({ content: [{ type: 'text', text: 'no image' }] }, ctx, 't'), {});
  assert.deepEqual(await storeImageParts(null, ctx, 't'), {});
});

test('vettedFetch refuses this machine; loopbackVettedFetch reaches it and nothing else private', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('local');
  });
  const url = await listen(server);
  try {
    await assert.rejects(vettedFetch(url), /private address 127\.0\.0\.1/);
    const ok = await loopbackVettedFetch(url);
    assert.equal(ok.status, 200);
    assert.equal(Buffer.from(ok.body).toString('utf8'), 'local');
    // 10.x is private but not this machine: still refused, with loopback allowed.
    await assert.rejects(loopbackVettedFetch('http://10.1.2.3/mcp'), /private address 10\.1\.2\.3/);
  } finally {
    await shut(server);
  }
});

test('clampLongWait: only a server on this machine, reached from the desktop, may hold a turn', () => {
  const remote = 'https://mcp.example.com/mcp';
  const local = 'http://127.0.0.1:7777/mcp';
  assert.equal(clampLongWait(remote, 300_000, true), 25_000);   // not this machine
  assert.equal(clampLongWait(local, 300_000, false), 25_000);   // this machine, but a server install
  assert.equal(clampLongWait(local, 300_000, true), 300_000);
  assert.equal(clampLongWait('http://localhost:7777/mcp', 60_000, true), 60_000);
  assert.equal(clampLongWait('http://[::1]:7777/mcp', 60_000, true), 60_000);
  assert.equal(clampLongWait(local, 900_000, true), MAX_LONG_WAIT_MS);
  assert.equal(clampLongWait(local, undefined, true), 25_000);  // unset = the default
  assert.equal(clampLongWait(local, 1.5, true), 25_000);
  assert.equal(clampLongWait(local, 0, true), 25_000);
  assert.equal(clampLongWait('not a url', 300_000, true), 25_000);
  assert.equal(clampLongWait(local, 5_000, false), 5_000);      // shorter than the default is fine anywhere
});

test('an mcp ward on this machine: longWaitMs bounds a blocking call, an image part rides back, an interrupt cancels it server-side', async () => {
  const u = user('mcploop@t.dev');
  const seen: { method: string; id?: number; params?: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw) as { id?: number; method: string; params?: Record<string, any> };
      seen.push({ method: body.method, id: body.id, params: body.params });
      const send = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'loop-1' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      };
      switch (body.method) {
        case 'initialize':
          return send({ protocolVersion: MCP_PROTOCOL, serverInfo: { name: 'lens', version: '1' } });
        case 'tools/list':
          return send({ tools: [{ name: 'wait', description: 'blocks until something happens', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } }] });
        case 'tools/call': {
          // The blocking tool: answers after `ms`, and drops the work when the client goes away.
          const timer = setTimeout(() => send({ content: [{ type: 'text', text: 'woke' }, { type: 'image', mimeType: 'image/png', data: PNG_1X1 }] }), Number(body.params?.arguments?.ms ?? 0));
          res.on('close', () => clearTimeout(timer));
          return;
        }
        default:
          res.writeHead(202);
          return res.end();
      }
    });
  });
  const url = await listen(server);
  const ward = (longWaitMs: number) => {
    const layout = validateLayout([{ i: 'lens', type: 'mcp', size: '2x1', config: { name: 'lens', url, trust: 'read', longWaitMs } }]);
    assert.ok(layout);
    saveDashboard(u, layout!);
    dropSession(u, 'lens');
    return mcpToolDefs(u, loopbackVettedFetch);
  };
  process.env.RIMEWARD_DESKTOP = '1';
  process.env.RIMEWARD_NATIVE_TOKEN = 'native'; // isDesktop(): the clamp only lifts here
  const ctx = { userId: u, ward: 'ag', conv: 0 };
  try {
    assert.equal((getDashboard(u)[0]!.config as { longWaitMs?: number }).longWaitMs, undefined); // nothing saved yet

    // 3 s under a 10 s bound: the call completes, and its image becomes an attachment
    const out = await (await ward(10_000))['mcp__lens__wait']!.run({ reason: 'r', ms: 3000 }, ctx) as { text: string; file_id?: number; image_sha256?: string };
    assert.match(out.text, /^woke\n\[image image\/png omitted\]$/);
    assert.equal(getAttachment(u, out.file_id!)!.mime, 'image/png');

    // the bound bites: the same call under 1 s does not wait for the server
    const short = (await ward(1000))['mcp__lens__wait']!;
    await assert.rejects(() => Promise.resolve(short.run({ reason: 'r', ms: 3000 }, ctx)), /deadline|timed out|socket/i);

    // an interrupted turn: the call rejects and the server is told to stop working on it
    const defs = await ward(60_000);
    const from = seen.length;
    const ac = new AbortController();
    const pending = Promise.resolve(defs['mcp__lens__wait']!.run({ reason: 'r', ms: 60_000 }, { ...ctx, signal: ac.signal }));
    const abort = setTimeout(() => ac.abort(), 200);
    await assert.rejects(pending, /abort/i);
    clearTimeout(abort);
    for (let i = 0; i < 60 && !seen.some((m) => m.method === 'notifications/cancelled'); i++) await new Promise((r) => setTimeout(r, 50));
    const call = seen.slice(from).find((m) => m.method === 'tools/call')!;
    const cancelled = seen.find((m) => m.method === 'notifications/cancelled')!;
    assert.equal(cancelled.params!.requestId, call.id); // the id of the call it is cancelling
    assert.equal(cancelled.params!.reason, 'interrupted');
  } finally {
    delete process.env.RIMEWARD_DESKTOP;
    delete process.env.RIMEWARD_NATIVE_TOKEN;
    await shut(server);
  }
});
