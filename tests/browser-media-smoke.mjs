// The browser ward's WebRTC transport against a real headless Chrome for Testing:
// the Rimeward Stream extension captures a tab that plays a tone over an animated
// canvas, a viewer page receives it over loopback, and the stats say whether video
// frames AND audio samples arrived. No TURN, no UDP policy: this checks capture,
// codec, tab following and constraints — not the network path.
//
//   node tests/browser-media-smoke.mjs                 # --mute-audio kept (the ward's default)
//   RIMEWARD_MEDIA_MUTE=0 node tests/browser-media-smoke.mjs
//   BROWSER_EXECUTABLE=/opt/frostdev-browser/chrome RIMEWARD_MEDIA_PROFILE=/var/lib/frostdev-browser/smoke \
//     RIMEWARD_MEDIA_EXT=/var/lib/frostdev-browser/smoke-ext node browser-media-smoke.mjs   # on the VPS
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = process.env.RIMEWARD_MEDIA_EXT ?? path.join(here, '..', 'assets', 'browser-extensions', 'stream');
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
// Production intent after the phase-0 spike: no --mute-audio (it starves the capture); the
// extension mutes tabs browser-side instead. RIMEWARD_MEDIA_MUTE=1 reproduces the flag.
const mute = process.env.RIMEWARD_MEDIA_MUTE === '1';
const codecs = process.env.RIMEWARD_MEDIA_CODECS ?? (process.platform === 'darwin' ? 'h264' : 'vp8');
const profile = process.env.RIMEWARD_MEDIA_PROFILE ?? fs.mkdtempSync(path.join(os.tmpdir(), 'rw-media-'));
const exe = process.env.BROWSER_EXECUTABLE;
const size = { w: 960, h: 540 };
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms, what) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw Error(`timed out: ${what}`); await wait(50); } };

const TARGET = (hue, tone) => `<!doctype html><title>target ${hue}</title><canvas id=c width=960 height=540></canvas><script>
const c=document.getElementById('c').getContext('2d');let t=0;
(function draw(){t++;c.fillStyle='hsl(${hue},70%,'+(30+20*Math.sin(t/10))+'%)';c.fillRect(0,0,960,540);c.fillStyle='#fff';c.font='80px sans-serif';c.fillText(String(t),40+(t*7)%800,300);requestAnimationFrame(draw)})();
${tone ? `const ac=new AudioContext();window.ac=ac;const o=ac.createOscillator();const g=ac.createGain();g.gain.value=0.4;o.frequency.value=440;o.connect(g).connect(ac.destination);o.start();ac.resume();` : ''}
</script>`;

/** Peak RMS over one second of an audio MediaStream picked by `pick` (an expression in the page). */
const rms = (page, pick) => page.evaluate(async (pick) => {
  const stream = new Function('return (' + pick + ')')();
  if (!stream || !stream.getAudioTracks().length) return -1;
  const ac = new AudioContext(); const src = ac.createMediaStreamSource(stream);
  const an = ac.createAnalyser(); an.fftSize = 2048; const g = ac.createGain(); g.gain.value = 0;
  src.connect(an); an.connect(g); g.connect(ac.destination); await ac.resume();
  const buf = new Float32Array(an.fftSize); let max = 0;
  for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 100)); an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; max = Math.max(max, Math.sqrt(s / buf.length)); }
  await ac.close(); return max;
}, pick);

const events = [];
const signals = { conns: new Map() };
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(exe ? { executablePath: exe } : { channel: 'chromium' }),
    headless: true,
    chromiumSandbox: !!exe || process.getuid?.() !== 0,
    viewport: { width: size.w, height: size.h },
    ignoreDefaultArgs: ['--disable-extensions', ...(mute ? [] : ['--mute-audio'])],
    args: [`--load-extension=${ext}`, `--allowlisted-extension-id=${id}`, '--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
  });
  log('launched', { id, mute, codecs, exe: exe ?? 'channel:chromium' });

  // The streamer page: bindings before navigation so `ready` reaches us.
  const streamer = await context.newPage();
  const viewer = await context.newPage();
  const candidates = new Map(); // conn → buffered candidates until the viewer has the offer
  await streamer.exposeBinding('rwSignal', async (source, json) => {
    const msg = JSON.parse(json);
    events.push(msg);
    if (!source.frame.url().startsWith(`chrome-extension://${id}/`)) { log('SIGNAL FROM FOREIGN FRAME', source.frame.url()); return; }
    if (msg.event) { log('signal', msg); return; }
    if (msg.sdp) {
      const sdp = await viewer.evaluate(async (sdp) => {
        await window.peer.setRemoteDescription({ type: 'offer', sdp });
        const answer = await window.peer.createAnswer(); await window.peer.setLocalDescription(answer); return answer.sdp;
      }, msg.sdp);
      await streamer.evaluate((m) => window.rwIn(m), { answer: { conn: msg.conn, sdp } });
      for (const c of (candidates.get(msg.conn) ?? []).splice(0)) await viewer.evaluate((c) => window.peer.addIceCandidate(c), c);
    } else if (msg.candidate) {
      const has = await viewer.evaluate(() => !!window.peer?.remoteDescription);
      if (has) await viewer.evaluate((c) => window.peer.addIceCandidate(c), msg.candidate);
      else (candidates.get(msg.conn) ?? candidates.set(msg.conn, []).get(msg.conn)).push(msg.candidate);
    } else if (msg.state) { log('peer', msg.conn, msg.state, msg.message ?? ''); signals.conns.set(msg.conn, msg.state); }
  });
  await streamer.goto(`chrome-extension://${id}/stream.html`);
  await until(() => events.some((e) => e.event === 'ready'), 5000, 'extension ready');
  log('streamer at', streamer.url());

  // The viewer: an ordinary page with a receiving peer.
  await viewer.exposeFunction('candidate', (c) => streamer.evaluate((m) => window.rwIn(m), { ice: { conn: 'v1', candidate: c } }));
  await viewer.setContent('<video autoplay playsinline muted style="width:480px;height:270px"></video>');
  await viewer.evaluate(() => {
    window.peer = new RTCPeerConnection({ iceServers: [] });
    window.peer.onicecandidate = (e) => { if (e.candidate) void window.candidate(e.candidate.toJSON()); };
    const stream = new MediaStream(); document.querySelector('video').srcObject = stream;
    window.peer.ontrack = (e) => stream.addTrack(e.track);
  });

  // The target tab, brought to front the way session.ts will.
  const target = context.pages()[0];
  await target.setContent(TARGET(200, true));
  await target.bringToFront();
  await wait(300);
  const pong = async () => { const n = events.length; await streamer.evaluate(() => window.rwIn({ ping: true })); await until(() => events.slice(n).some((e) => e.event === 'pong'), 3000, 'pong'); return events.slice(n).find((e) => e.event === 'pong'); };
  const before = await pong();
  log('after bringToFront: lastActivated =', before.lastActivated);

  await streamer.evaluate((m) => window.rwIn(m), { capture: { rev: 1, size } });
  await until(() => events.some((e) => e.event === 'captured'), 10000, 'captured');
  const captured = events.find((e) => e.event === 'captured');
  log('captured', captured);

  await streamer.evaluate((m) => window.rwIn(m), { add: { conn: 'v1', ice: [], relay: false, maxBitrate: 4_000_000, codecs } });
  await until(() => signals.conns.get('v1') === 'connected', 15000, 'peer connected');
  await wait(4000);

  const stats = async () => viewer.evaluate(async () => {
    const out = { video: null, audio: null };
    const report = await window.peer.getStats();
    report.forEach((s) => {
      if (s.type !== 'inbound-rtp') return;
      const codec = report.get(s.codecId)?.mimeType;
      if (s.kind === 'video') out.video = { codec, framesDecoded: s.framesDecoded, fps: s.framesPerSecond, w: s.frameWidth, h: s.frameHeight, bytes: s.bytesReceived };
      if (s.kind === 'audio') out.audio = { codec, samples: s.totalSamplesReceived, energy: s.totalAudioEnergy, level: s.audioLevel, bytes: s.bytesReceived };
    });
    return out;
  });
  const s1 = await stats();
  log('stats after 4 s', JSON.stringify(s1));
  const acState = await target.evaluate(() => window.ac?.state ?? 'none');
  const hostRms = await rms(streamer, 'current && current.stream');
  const viewerRms = await rms(viewer, 'document.querySelector("video").srcObject');
  log('audio levels', JSON.stringify({ acState, hostRms, viewerRms }));
  // Tabs muted browser-side (the ward's sound knob off): the capture must stay fed.
  await streamer.evaluate((m) => window.rwIn(m), { sound: false });
  await wait(800);
  const pm = await pong();
  const mutedRms = await rms(streamer, 'current && current.stream');
  const mutedViewerRms = await rms(viewer, 'document.querySelector("video").srcObject');
  log('with tabs muted', JSON.stringify({ muted: pm.muted, mutedRms, mutedViewerRms }));
  await streamer.evaluate((m) => window.rwIn(m), { sound: true });

  // Constraints on the live track.
  await streamer.evaluate((m) => window.rwIn(m), { size: { w: 480, h: 270 } });
  await wait(2500);
  const p2 = await pong();
  const s2 = await stats();
  log('after size 480x270: host settings', JSON.stringify(p2.settings), 'viewer', JSON.stringify(s2.video));

  // Tab switch: a second tab without sound; frames must keep flowing after replaceTrack.
  const other = await context.newPage();
  await other.setContent(TARGET(20, false));
  await other.bringToFront();
  await wait(200);
  await streamer.evaluate((m) => window.rwIn(m), { capture: { rev: 2, size: { w: 960, h: 540 } } });
  await until(() => events.filter((e) => e.event === 'captured').length >= 2, 10000, 'second capture');
  const cap2 = events.filter((e) => e.event === 'captured').at(-1);
  const framesBefore = (await stats()).video?.framesDecoded ?? 0;
  await wait(3000);
  const s3 = await stats();
  log('after tab switch', JSON.stringify({ cap2, framesBefore, framesAfter: s3.video?.framesDecoded, audioSamplesDelta: (s3.audio?.samples ?? 0) - (s1.audio?.samples ?? 0) }));

  const verdict = {
    id, mute, codecs,
    activatedFired: before.lastActivated !== null,
    videoFrames: (s1.video?.framesDecoded ?? 0) > 0,
    videoCodec: s1.video?.codec,
    audioSamples: (s1.audio?.samples ?? 0) > 0,
    audioEnergy: (s1.audio?.energy ?? 0) > 0 || (s3.audio?.energy ?? 0) > 0,
    acState, hostRms: Number(hostRms.toFixed(4)), viewerRms: Number(viewerRms.toFixed(4)),
    audible: hostRms > 0.01 && viewerRms > 0.01,
    targetTabMuted: !!pm.muted.find(([id]) => id === captured.tabId)?.[1],
    audibleWhileTabMuted: mutedRms > 0.01 && mutedViewerRms > 0.01,
    resizeApplied: p2.settings?.width <= 480,
    switchedTab: cap2.tabId !== captured.tabId,
    framesAfterSwitch: (s3.video?.framesDecoded ?? 0) > framesBefore,
  };
  log('VERDICT', JSON.stringify(verdict));
  await streamer.evaluate((m) => window.rwIn(m), { remove: { conn: 'v1' } });
  process.exitCode = verdict.videoFrames && verdict.audible ? 0 : 1;
} catch (error) {
  log('FAILED', error?.stack ?? error);
  log('events', JSON.stringify(events.filter((e) => !e.candidate && !e.sdp).slice(-20)));
  process.exitCode = 2;
} finally {
  await context?.close().catch(() => {});
  if (!process.env.RIMEWARD_MEDIA_PROFILE) fs.rmSync(profile, { recursive: true, force: true });
}
