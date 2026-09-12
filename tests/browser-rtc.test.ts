import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rtcIce, rtcInbound, rtcJoin, rtcPeers, withRtcHeader, rtcIceFromRelay, RTC_HEADER, type RtcMessage } from '../src/lib/browser/rtc.ts';
import type { Session, StreamSignal } from '../src/lib/browser/session.ts';

// The browser ward's WebRTC signaling without a browser: what a viewer is handed, what it may
// send back, and that nothing crosses between two viewers' connections.

/** A session with a capture page that records what Node tells it. */
function fakeSession(): { s: Session; told: Record<string, unknown>[] } {
  const told: Record<string, unknown>[] = [];
  const s = {
    stream: { page: { evaluate: async (_fn: unknown, m: Record<string, unknown>) => { told.push(m); } }, rev: 0 },
    rtc: new Map<string, (msg: StreamSignal) => void>(),
  } as unknown as Session;
  return { s, told };
}
const OFFER_ANSWER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AB:CD\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';

test('rtcIce: the host is always TURN; a signed-in viewer gets TURN too, an anonymous link viewer STUN only', () => {
  const secret = process.env.RIMEWARD_TURN_SECRET, direct = process.env.RIMEWARD_RTC_DIRECT;
  delete process.env.RIMEWARD_RTC_DIRECT;
  try {
    process.env.RIMEWARD_TURN_SECRET = 'x'.repeat(48);
    const anon = rtcIce(1, { userId: null })!;
    assert.ok(anon.host.some((s) => String(s.urls).includes('turn:')) && anon.host.every((s) => s.username && s.credential), 'the owner relays');
    assert.deepEqual(anon.viewer.map((s) => String(s.urls)), ['stun:turn.frostdev.io:3478']);
    assert.ok(anon.viewer.every((s) => !s.username && !s.credential), 'no relay credential for a link holder');
    const user = rtcIce(1, { userId: 7 })!;
    assert.ok(user.viewer.some((s) => s.username && s.credential), 'a grantee may relay');
    // The credentials outlive five minutes: the username's timestamp is hours away.
    const stamp = Number(String(user.host[0]!.username).split(':')[0]);
    assert.ok(stamp - Date.now() / 1000 > 11 * 3600, 'a movie-length TTL');
    process.env.RIMEWARD_TURN_SECRET = '';
    assert.equal(rtcIce(1, { userId: null }), null, 'no relay configured → no stream (JPEG stays)');
    process.env.RIMEWARD_RTC_DIRECT = '1';
    assert.deepEqual(rtcIce(1, { userId: null }), { host: [], viewer: [] }, 'dev/tests: loopback candidates');
    // Across the relay: the header round-trips.
    const ice = { host: [{ urls: 'turn:t:3478', username: 'u', credential: 'c' }], viewer: [{ urls: 'stun:t:3478' }] };
    const ctl = new AbortController();
    const r = withRtcHeader(new Request('https://x.invalid/api/browser/stream/w', { signal: ctl.signal }), ice);
    assert.deepEqual(rtcIceFromRelay(r), ice);
    ctl.abort();
    assert.ok(r.signal.aborted, 'the relayed request keeps the viewer\'s abort signal');
    assert.equal(rtcIceFromRelay(new Request('https://x.invalid/', { headers: { [RTC_HEADER]: '{"host":1}' } })), null);
  } finally {
    if (secret === undefined) delete process.env.RIMEWARD_TURN_SECRET; else process.env.RIMEWARD_TURN_SECRET = secret;
    if (direct === undefined) delete process.env.RIMEWARD_RTC_DIRECT; else process.env.RIMEWARD_RTC_DIRECT = direct;
  }
});

test('rtcJoin / rtcInbound: one connection per viewer, its messages only, validated answers and candidates', () => {
  const { s, told } = fakeSession();
  const a: RtcMessage[] = [], b: RtcMessage[] = [];
  const aState: boolean[] = [];
  const ice = { host: [{ urls: 'turn:t:3478', username: 'u', credential: 'c' }], viewer: [{ urls: 'stun:t:3478' }] };
  const ja = rtcJoin(s, ice, (m) => a.push(m), (on) => aState.push(on))!;
  const jb = rtcJoin(s, ice, (m) => b.push(m), () => {})!;
  assert.ok(ja && jb && ja.conn !== jb.conn && /^[0-9a-f]{32}$/.test(ja.conn));
  assert.deepEqual(a, [{ type: 'rtc', conn: ja.conn, ice: ice.viewer }], 'the viewer gets its ICE first');
  assert.deepEqual(told.map((m) => Object.keys(m)[0]), ['add', 'add']);
  assert.equal((told[0] as { add: { relay: boolean; ice: unknown } }).add.relay, true, 'the host is relay-only');
  assert.equal(rtcJoin(s, ice, () => {}, () => {}), null, 'a server host serves two peers per session');
  assert.equal(rtcPeers(), 2);

  // The capture page's offer for A reaches A alone.
  s.rtc.get(ja.conn)!({ conn: ja.conn, sdp: 'offer-a' });
  s.rtc.get(jb.conn)!({ conn: jb.conn, candidate: { candidate: 'x' } });
  assert.deepEqual(a.at(-1), { type: 'rtc', conn: ja.conn, sdp: 'offer-a' });
  assert.deepEqual(b.at(-1), { type: 'rtc', conn: jb.conn, candidate: { candidate: 'x' } });
  assert.equal(a.length, 2);

  // A's answer: once, bounded, with a DTLS fingerprint.
  assert.equal(rtcInbound(ja.conn, { sdp: 'v=0 no fingerprint' }), false);
  assert.equal(rtcInbound(ja.conn, { sdp: OFFER_ANSWER + 'x'.repeat(40_000) }), false, 'oversized');
  assert.equal(rtcInbound(ja.conn, { sdp: OFFER_ANSWER }), true);
  assert.deepEqual(told.at(-1), { answer: { conn: ja.conn, sdp: OFFER_ANSWER } });
  assert.equal(rtcInbound(ja.conn, { sdp: OFFER_ANSWER }), false, 'a second answer is refused');
  // Candidates: shape and size.
  assert.equal(rtcInbound(ja.conn, { candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } }), true);
  assert.deepEqual(told.at(-1), { ice: { conn: ja.conn, candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } } });
  assert.equal(rtcInbound(ja.conn, { candidate: { candidate: 'c'.repeat(2000) } }), false);
  assert.equal(rtcInbound(ja.conn, { candidate: { candidate: 'c', sdpMLineIndex: 9 } }), false);
  assert.equal(rtcInbound(ja.conn, { candidate: { candidate: 'c', sdpMid: 'm'.repeat(20) } }), false);
  assert.equal(rtcInbound(ja.conn, { candidate: 'not an object' }), false);
  assert.equal(rtcInbound('0'.repeat(32), { sdp: OFFER_ANSWER }), false, 'unknown connection');
  assert.equal(rtcInbound(ja.conn, { sdp: OFFER_ANSWER }, fakeSession().s), false, 'another session\'s connection');
  // States flip the viewer's frames.
  s.rtc.get(ja.conn)!({ conn: ja.conn, state: 'connected' });
  s.rtc.get(ja.conn)!({ conn: ja.conn, state: 'failed' });
  assert.deepEqual(aState, [true, false]);
  // The message budget.
  for (let i = 0; i < 70; i++) rtcInbound(jb.conn, { candidate: { candidate: 'c' } });
  assert.equal(rtcInbound(jb.conn, { candidate: { candidate: 'c' } }), false, 'a chatty viewer is cut off');

  ja.leave(); jb.leave();
  assert.equal(s.rtc.size, 0);
  assert.equal(rtcPeers(), 0);
  assert.deepEqual(told.at(-1), { remove: { conn: jb.conn } });
  assert.equal(rtcInbound(ja.conn, { candidate: { candidate: 'c' } }), false, 'gone');
  // No capture page, no ICE: the viewer stays on JPEG.
  assert.equal(rtcJoin({ rtc: new Map() } as unknown as Session, ice, () => {}, () => {}), null);
  assert.equal(rtcJoin(s, null, () => {}, () => {}), null);
  // Peers whose session closed, or whose leave never arrived, free their slot for the next viewer.
  const stale = [fakeSession(), fakeSession()];
  for (const f of stale) { rtcJoin(f.s, ice, () => {}, () => {}); rtcJoin(f.s, ice, () => {}, () => {}); }
  assert.equal(rtcPeers(), 4, 'the runtime-wide cap is full');
  (stale[0]!.s as { closing?: Promise<void> }).closing = Promise.resolve();
  stale[1]!.s.rtc.clear();
  const fresh = fakeSession();
  assert.ok(rtcJoin(fresh.s, ice, () => {}, () => {}), 'a closed session and a vanished viewer no longer count');
  assert.equal(rtcPeers(), 1);
});
