import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { getDashboard, saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout, type WardInstance } from '../src/lib/wards.ts';
import { validateGraph } from '../src/lib/logic.ts';
import { runShell } from '../src/lib/agent/shell.ts';
import { aiTools, invokeReadTool } from '../src/lib/agent/tools.ts';
import { callTool, dropSession, mcpStatus, mcpToolDefs, mcpToolDefsSync, parseRpcBody, safeToolName, setMcpToken, toolText } from '../src/lib/agent/mcp.ts';

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
