import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

// The CLI MCP door only exists inside the desktop runtime, and so does a lens source.
process.env.RIMEWARD_DESKTOP = '1';
process.env.RIMEWARD_NATIVE_TOKEN = 'test-only';

import { createUser } from '../src/lib/users.ts';
import { cliContext, prepareCliLaunch } from '../src/lib/dev/cli-bridge.ts';
import { handleCliMcp } from '../src/lib/dev/cli-mcp.ts';
import { SOURCES, lens, releaseLens } from '../src/lib/lens/core.ts';
import type { Feed, LensSettings, Source } from '../src/lib/lens/core.ts';
import { LENS_TOOLS, LENS_TOOL_NAMES } from '../src/lib/lens/tools.ts';
import { terminalSource } from '../src/lib/lens/terminal.ts';
import { OBSERVATION_BANNER } from '../src/lib/lens/types.ts';
import { terminalFixture } from './lens-replay.ts';

const CONSUMER_ID = /^[a-z0-9-]{1,40}$/;

const rpc = async (user: number, session: string, method: string, params?: Record<string, unknown>) => {
  const out = await handleCliMcp(user, session, JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }));
  return out.body as { result?: any; error?: { code: number; message: string } };
};
const callTool = (user: number, session: string, name: string, args: Record<string, unknown> = {}) =>
  rpc(user, session, 'tools/call', { name, arguments: args });

/** No source type registered: the machine this test runs on has no lens at all. */
function noSources(t: { after(fn: () => void): void }) {
  const screen = SOURCES.screen, terminal = SOURCES.terminal;
  delete SOURCES.screen;
  delete SOURCES.terminal;
  t.after(() => {
    if (screen) SOURCES.screen = screen;
    if (terminal) SOURCES.terminal = terminal;
  });
}

/** A source that never feeds: enough for `lens()` to build a core. */
const idle = (): Source => ({ async connect(_u: number, _t: string, _f: Feed) { return () => {}; } });

test('the lens tools are offered only where a lens source is reachable', async (t) => {
  noSources(t);
  const user = createUser('cli-mcp-list@example.com', 'pw-cli-mcp-1');

  const bare = await rpc(user, 'sess-1', 'tools/list');
  assert.deepEqual(bare.result.tools.map((x: { name: string }) => x.name), ['rime_status', 'rime_ask', 'rime_report', 'rime_context']);
  const quiet = await rpc(user, 'sess-1', 'initialize', { protocolVersion: '2025-06-18' });
  assert.doesNotMatch(quiet.result.instructions, /lens/);

  SOURCES.terminal = idle;
  const withLens = await rpc(user, 'sess-1', 'tools/list');
  assert.deepEqual(withLens.result.tools.map((x: { name: string }) => x.name), ['rime_status', 'rime_ask', 'rime_report', 'rime_context', ...LENS_TOOL_NAMES]);
  for (const name of LENS_TOOL_NAMES) {
    const listed = withLens.result.tools.find((x: { name: string }) => x.name === name);
    assert.equal(listed.inputSchema, LENS_TOOLS[name].inputSchema, `${name} lists its own schema`);
    assert.equal(listed.inputSchema.required.includes('source'), false, `${name} takes source optionally`);
  }
  const loud = await rpc(user, 'sess-1', 'initialize', {});
  assert.match(loud.result.instructions, /lens_wait/);
  assert.match(loud.result.instructions, /untrusted data/);
});

test('an unknown source type is a JSON-RPC error, not a tool result', async (t) => {
  noSources(t);
  const user = createUser('cli-mcp-source@example.com', 'pw-cli-mcp-2');
  const out = await callTool(user, 'sess-2', 'lens_look', { source: 'nope:1' });
  assert.equal(out.result, undefined);
  assert.equal(out.error?.code, -32602);
  assert.match(out.error!.message, /No lens for source "nope:1"/);
});

test('a lens result carries its text in a content block AND in structuredContent', async (t) => {
  const user = createUser('cli-mcp-look@example.com', 'pw-cli-mcp-3');
  const session = crypto.randomUUID();
  const source = `terminal:${'s1'}`;
  const fixture = terminalFixture(() => Date.now());
  const real = SOURCES.terminal;
  SOURCES.terminal = (): Source => terminalSource(fixture.deps);
  t.after(() => {
    releaseLens(user, source);
    SOURCES.terminal = real;
  });
  fixture.inject({ rows: ['ready', 'building…'], seq: 1 });
  // Settles instantly, so the test never waits on the 750 ms window; the door reuses this core.
  const core = lens(user, source, (): LensSettings => ({ settleMs: 0, minLines: 1 }));
  assert.ok(core);

  const key = await callTool(user, session, 'lens_wait', { source, timeout_s: 5 });
  assert.equal(key.result.content.length, 1);
  assert.equal(key.result.content[0].type, 'text');
  assert.ok(key.result.content[0].text.startsWith(OBSERVATION_BANNER));
  assert.ok(key.result.content[0].text.includes('building…'));
  // Claude Code hands the model `structuredContent` and drops `content`: the observation is in both.
  assert.equal(key.result.structuredContent.text, key.result.content[0].text);
  assert.equal(key.result.structuredContent.kind, 'key');
  assert.equal(key.result.isError, undefined);

  const look = await callTool(user, session, 'lens_look', { source, ack: key.result.structuredContent.delivery });
  assert.equal(look.result.structuredContent.text, look.result.content[0].text);
  assert.ok(look.result.content[0].text.includes('building…'));

  // One cursor per CLI session, at the `cli` kind (a host reads the text raw).
  const consumer = core.status().consumers[0];
  assert.equal(consumer.id, `cli-${session}`);
  assert.equal(consumer.id.length, 40);
  assert.match(consumer.id, CONSUMER_ID);
  assert.equal(consumer.kind, 'cli');

  // A session id that is not a plain uuid still fits the consumer shape.
  const odd = await callTool(user, 'Session/One!', 'lens_look', { source });
  assert.equal(odd.result.structuredContent.text, odd.result.content[0].text);
  const hashed = core.status().consumers.map(c => c.id).find(id => id !== `cli-${session}`);
  assert.match(hashed!, /^cli-[0-9a-f]{32}$/);
  assert.match(hashed!, CONSUMER_ID);
});

test('an image rides beside the text, and an error passes through as isError', async (t) => {
  const user = createUser('cli-mcp-image@example.com', 'pw-cli-mcp-4');
  const source = 'screen:local';
  const realSource = SOURCES.screen;
  SOURCES.screen = idle;
  const realCall = LENS_TOOLS.lens_crop.call;
  t.after(() => {
    LENS_TOOLS.lens_crop.call = realCall;
    releaseLens(user, source);
    if (realSource) SOURCES.screen = realSource; else delete SOURCES.screen;
  });

  // The frame the B2 body returns, in the shape the agent door also consumes.
  const data = Buffer.from([0xff, 0xd8, 0xff, 0xdb]).toString('base64');
  LENS_TOOLS.lens_crop.call = () => ({ text: '{"ref":"f-1-2"}', receipt: { ref: 'f-1-2', v: 3 }, image: { data, mime: 'image/jpeg' } });
  const shot = await callTool(user, 'sess-4', 'lens_crop', { rect: [0, 0, 8, 8] });
  assert.deepEqual(shot.result.content, [{ type: 'text', text: '{"ref":"f-1-2"}' }, { type: 'image', data, mimeType: 'image/jpeg' }]);
  assert.deepEqual(shot.result.structuredContent, { ref: 'f-1-2', v: 3, text: '{"ref":"f-1-2"}' });

  // The real body, with no frame ever captured: an error result, not a JSON-RPC error.
  LENS_TOOLS.lens_crop.call = realCall;
  const missing = await callTool(user, 'sess-4', 'lens_crop', { rect: [0, 0, 8, 8] });
  assert.equal(missing.result.isError, true);
  // A sentence for the host to read, with the app's own condition beside it.
  const said = missing.result.content[0].text as string;
  assert.match(said, /^lens_crop has no such frame: /);
  assert.deepEqual(missing.result.content, [{ type: 'text', text: said }]);
  assert.deepEqual(missing.result.structuredContent, { error: said, detail: 'frame-evicted', text: said });
});

test('the four Rime tools answer exactly as they did before the lens door', async (t) => {
  const user = createUser('cli-mcp-rime@example.com', 'pw-cli-mcp-5');
  SOURCES.terminal ??= idle; // the lens being reachable must not change a Rime reply
  const session = crypto.randomUUID();
  const launch = prepareCliLaunch(user, session, 'claude', 'normal');
  t.after(() => launch.cleanup());

  const context = await callTool(user, session, 'rime_context');
  assert.equal(JSON.stringify(context), JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: cliContext(session) }] } }));

  // A tool that throws: one text block, isError, and no structuredContent.
  const unknown = await callTool(user, 'nobody', 'rime_status', { message: 'hi' });
  assert.equal(JSON.stringify(unknown), JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Unknown session.' }], isError: true } }));

  const bogus = await callTool(user, session, 'rime_nope');
  assert.equal(JSON.stringify(bogus), JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Unknown tool: rime_nope' }], isError: true } }));
});
