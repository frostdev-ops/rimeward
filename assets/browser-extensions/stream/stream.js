// Rimeward Stream: captures this window's active tab (picture and sound) with
// chrome.tabCapture and sends it over one RTCPeerConnection per viewer.
//
// Node drives this page (lib/browser/session.ts + rtc.ts) through window.rwIn
// and hears back through window.rwSignal, a Playwright binding. Every viewer
// message carries `conn`, the viewer's connection id; nothing here is reachable
// from web content — the page is not web-accessible and has no content scripts.
//
// rwIn accepts one object with any of:
//   capture: { rev, size? }   follow the tab Node just brought to front (a stale rev is dropped)
//   size: { w, h }            the capture's maximum size (device px), applied to the live track
//   sound: boolean            play the captured audio on this machine too (the ward's `sound` knob)
//   add: { conn, ice, relay, maxBitrate, codecs }   a viewer: offer follows on rwSignal
//   answer: { conn, sdp }     the viewer's answer (once)
//   ice: { conn, candidate }  a viewer's candidate
//   remove: { conn }          the viewer left
//   ping: true                → rwSignal({ event: 'pong', ... }) for tests
// rwSignal carries: { conn, sdp } | { conn, candidate } | { conn, state, message? }
//   | { event: 'ready' | 'captured' | 'error' | 'pong', ... }
'use strict';

// Browser UI pages cannot be captured; about:blank (a fresh ward tab) can.
const INTERNAL = /^(chrome|chrome-extension|devtools|edge):/;
const signal = (msg) => { try { window.rwSignal?.(JSON.stringify(msg)); } catch { /* binding gone: Node is */ } };

/** conn → { pc, video, audio, answered, pending } */
const peers = new Map();
/** The live capture, or null. */
let current = null; // { stream, tabId }
let size = { w: 1280, h: 800 };
let rev = 0;
let chain = Promise.resolve();
let me = null; // this tab
let lastActivated = null; // { tabId, at }
const waiters = [];
let sound = false, audioCtx = null, audioSrc = null;

chrome.tabs.getCurrent().then((tab) => { me = tab ?? null; });
chrome.tabs.onActivated.addListener(({ tabId }) => {
  lastActivated = { tabId, at: Date.now() };
  for (const w of waiters.splice(0)) w(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (current && tabId === current.tabId && typeof info.audible === 'boolean') hint(info.audible);
});
chrome.tabs.onRemoved.addListener((tabId) => { if (current && tabId === current.tabId) stopCapture(); });
chrome.tabs.onCreated.addListener((tab) => { if (!sound && tab.id !== undefined && tab.id !== me?.id) chrome.tabs.update(tab.id, { muted: true }).catch(() => {}); });

/** The ward's sound knob. Off: every tab is muted browser-side — a tab mute keeps
 *  the capture fed, where Chromium's --mute-audio flag starves it (renderers get a
 *  null sink). On: tabs unmuted, and the capture, which silences the captured tab on
 *  this machine, is played back through this page (`local`). */
async function applySound() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((t) => t.id !== undefined && t.id !== me?.id).map((t) => chrome.tabs.update(t.id, { muted: !sound }).catch(() => {})));
  local();
}

/** A movie wants smooth frames, a text page sharp ones; a tab that is audible is watched, not read. */
function hint(audible) {
  const track = current?.stream.getVideoTracks()[0];
  if (track) track.contentHint = audible ? 'motion' : 'detail';
}

function stopCapture() {
  if (!current) return;
  for (const t of current.stream.getTracks()) t.stop();
  current = null;
  local();
}

/** The tab Node just brought to front: the newest activation (waited for briefly),
 *  else this window's active tab. Never this page or an internal page. */
async function targetTab(since) {
  let id = lastActivated && lastActivated.at >= since - 1500 ? lastActivated.tabId : null;
  if (id === null) id = await new Promise((resolve) => { waiters.push(resolve); setTimeout(() => resolve(null), 300); });
  if (id === null) id = lastActivated?.tabId ?? null;
  let tab = id === null ? null : await chrome.tabs.get(id).catch(() => null);
  if (!tab || tab.id === me?.id || INTERNAL.test(tab.url || tab.pendingUrl || '')) {
    const active = await chrome.tabs.query({ active: true });
    tab = active.find((t) => t.id !== me?.id && !INTERNAL.test(t.url || t.pendingUrl || '')) ?? null;
  }
  return tab;
}

async function capture(myRev, since) {
  const tab = await targetTab(since);
  if (myRev !== rev) return;
  if (!tab) { signal({ event: 'error', message: 'no tab to capture' }); return; }
  if (current?.tabId === tab.id) { await resize(); return; }
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  const mandatory = (extra) => ({ mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, ...extra } });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: mandatory({}),
    video: mandatory({ maxWidth: size.w, maxHeight: size.h, maxFrameRate: 30 }),
  });
  if (myRev !== rev) { for (const t of stream.getTracks()) t.stop(); return; }
  const old = current;
  current = { stream, tabId: tab.id };
  hint(!!tab.audible);
  const video = stream.getVideoTracks()[0], audio = stream.getAudioTracks()[0] ?? null;
  for (const p of peers.values()) { await p.video.replaceTrack(video); await p.audio.replaceTrack(audio); }
  if (old) for (const t of old.stream.getTracks()) t.stop();
  local();
  const s = video.getSettings();
  signal({ event: 'captured', tabId: tab.id, w: s.width, h: s.height, audio: !!audio });
}

async function resize() {
  const track = current?.stream.getVideoTracks()[0];
  if (!track) return;
  try { await track.applyConstraints({ width: { max: size.w }, height: { max: size.h }, frameRate: { max: 30 } }); }
  catch (e) { signal({ event: 'error', message: `resize: ${e?.message ?? e}` }); }
}

/** The captured tab goes silent on this machine; when the ward's sound is on, play it back here. */
function local() {
  if (audioSrc) { audioSrc.disconnect(); audioSrc = null; }
  if (!sound || !current || !current.stream.getAudioTracks().length) return;
  audioCtx ??= new AudioContext();
  audioSrc = audioCtx.createMediaStreamSource(current.stream);
  audioSrc.connect(audioCtx.destination);
  void audioCtx.resume().catch(() => {});
}

function prefer(transceiver, codecs) {
  const caps = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
  const order = codecs === 'h264' ? ['video/H264', 'video/VP8', 'video/VP9'] : ['video/VP8', 'video/H264', 'video/VP9'];
  const rank = (c) => { const i = order.indexOf(c.mimeType); return i < 0 ? order.length : i; };
  try { transceiver.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b))); } catch { /* keep the default order */ }
}

function add({ conn, ice = [], relay = true, maxBitrate = 4_000_000, codecs = 'vp8' }) {
  if (typeof conn !== 'string' || !conn) return;
  remove(conn);
  const pc = new RTCPeerConnection({ iceServers: ice, iceTransportPolicy: relay ? 'relay' : 'all' });
  const vt = pc.addTransceiver('video', { direction: 'sendonly' });
  const at = pc.addTransceiver('audio', { direction: 'sendonly' });
  prefer(vt, codecs);
  const peer = { pc, video: vt.sender, audio: at.sender, answered: false, pending: [] };
  peers.set(conn, peer);
  pc.onicecandidate = (e) => { if (e.candidate) signal({ conn, candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => signal({ conn, state: pc.connectionState });
  chain = chain.then(async () => {
    if (!current) await capture(rev, Date.now());
    if (peers.get(conn) !== peer) return;
    if (current) {
      await vt.sender.replaceTrack(current.stream.getVideoTracks()[0]);
      await at.sender.replaceTrack(current.stream.getAudioTracks()[0] ?? null);
    }
    const params = vt.sender.getParameters();
    params.degradationPreference = 'maintain-framerate';
    params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate, maxFramerate: 30 }];
    await vt.sender.setParameters(params).catch(() => {});
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signal({ conn, sdp: pc.localDescription.sdp });
  }).catch((e) => signal({ conn, state: 'failed', message: String(e?.message ?? e) }));
}

async function answer({ conn, sdp }) {
  const p = peers.get(conn);
  if (!p || p.answered || typeof sdp !== 'string') return;
  p.answered = true;
  await p.pc.setRemoteDescription({ type: 'answer', sdp });
  for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
}

async function ice({ conn, candidate }) {
  const p = peers.get(conn);
  if (!p || !candidate) return;
  if (p.answered) await p.pc.addIceCandidate(candidate).catch(() => {});
  else p.pending.push(candidate);
}

function remove(conn) {
  const p = peers.get(conn);
  if (!p) return;
  peers.delete(conn);
  try { p.pc.close(); } catch { /* already closed */ }
  if (!peers.size) stopCapture(); // nobody watching: the tab plays on its own machine again
}

window.rwIn = (msg) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.size && Number.isFinite(msg.size.w) && Number.isFinite(msg.size.h)) {
    size = { w: Math.max(16, Math.round(msg.size.w)), h: Math.max(16, Math.round(msg.size.h)) };
    if (!msg.capture) chain = chain.then(resize).catch(() => {});
  }
  if (msg.capture) {
    const myRev = rev = Number.isFinite(msg.capture.rev) ? msg.capture.rev : rev + 1;
    if (msg.capture.size && Number.isFinite(msg.capture.size.w) && Number.isFinite(msg.capture.size.h)) size = { w: Math.round(msg.capture.size.w), h: Math.round(msg.capture.size.h) };
    const since = Date.now();
    chain = chain.then(() => capture(myRev, since)).catch((e) => signal({ event: 'error', message: String(e?.message ?? e) }));
  }
  if (typeof msg.sound === 'boolean') { sound = msg.sound; void applySound(); }
  if (msg.add) add(msg.add);
  if (msg.answer) chain = chain.then(() => answer(msg.answer)).catch((e) => signal({ conn: msg.answer.conn, state: 'failed', message: String(e?.message ?? e) }));
  if (msg.ice) chain = chain.then(() => ice(msg.ice)).catch(() => {});
  if (msg.remove) remove(msg.remove.conn);
  if (msg.ping) void chrome.tabs.query({}).then((tabs) => signal({ event: 'pong', peers: [...peers.keys()], tab: current?.tabId ?? null, lastActivated, size, sound,
    muted: tabs.map((t) => [t.id, !!t.mutedInfo?.muted]), settings: current?.stream.getVideoTracks()[0]?.getSettings() ?? null }));
  return true;
};

void applySound(); // silent until Node says otherwise
signal({ event: 'ready' });
