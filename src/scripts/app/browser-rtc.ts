// The browser ward's WebRTC viewer: the capture page (assets/browser-extensions/stream)
// offers, this side answers; every message rides the ward's own transport (the
// socket, or POST ?rtc=1 beside the SSE stream — browser.ts hands both in through
// `send`). `ice` starts a fresh peer for a new connection id; a state the host or
// this peer reports as ended hands the picture back to the JPEG frames (`onState`).
// No retry here: the server re-offers on the next socket, and frames never stopped.
import type { RtcMessage } from '../../lib/browser/rtc.ts';

const CONNECT_MS = 15_000;
const ENDED = new Set(['failed', 'disconnected', 'closed']);

export interface RtcViewer {
  handle(msg: RtcMessage): void;
  close(): void;
  readonly connected: boolean;
}

export function rtcViewer(video: HTMLVideoElement, send: (msg: object) => void, onState: (connected: boolean) => void): RtcViewer {
  let pc: RTCPeerConnection | undefined;
  let conn = '';
  let offered = false;
  let dead = false;
  let pending: RTCIceCandidateInit[] = [];
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stream = new MediaStream();
  const teardown = () => {
    clearTimeout(deadline);
    pc?.close(); pc = undefined;
    offered = false; pending = [];
    for (const t of stream.getTracks()) stream.removeTrack(t);
    video.srcObject = null;
  };
  const fail = () => { if (dead || !pc) return; teardown(); onState(false); };
  return {
    handle(msg) {
      if (dead) return;
      if (msg.ice) {
        teardown();
        conn = msg.conn;
        const p = pc = new RTCPeerConnection({ iceServers: msg.ice as RTCIceServer[] });
        p.ontrack = (e) => {
          if (pc !== p) return;
          stream.addTrack(e.track);
          if (video.srcObject !== stream) video.srcObject = stream;
          void video.play().catch(() => {});
        };
        p.onicecandidate = (e) => { if (e.candidate && pc === p) send({ rtc: { conn, candidate: e.candidate.toJSON() } }); };
        p.onconnectionstatechange = () => {
          if (pc !== p) return;
          if (p.connectionState === 'connected') { clearTimeout(deadline); onState(true); }
          else if (ENDED.has(p.connectionState)) fail();
        };
        deadline = setTimeout(() => { if (pc === p && p.connectionState !== 'connected') fail(); }, CONNECT_MS);
        return;
      }
      if (!pc || msg.conn !== conn) return;
      const p = pc;
      if (msg.sdp) {
        if (offered) { fail(); return; } // a second offer is not a protocol we speak: back to frames
        offered = true;
        void (async () => {
          await p.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
          const answer = await p.createAnswer();
          await p.setLocalDescription(answer);
          if (pc !== p) return;
          send({ rtc: { conn, sdp: answer.sdp } });
          for (const c of pending.splice(0)) await p.addIceCandidate(c).catch(() => {});
        })().catch(fail);
      } else if (msg.candidate) {
        const c = msg.candidate as RTCIceCandidateInit;
        if (p.remoteDescription) void p.addIceCandidate(c).catch(() => {}); else pending.push(c);
      } else if (msg.state && ENDED.has(msg.state)) fail();
    },
    close() { dead = true; teardown(); },
    get connected() { return pc?.connectionState === 'connected'; },
  };
}
