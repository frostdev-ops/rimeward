// Clip dictation: the composer's microphone for people whose connection is an OpenAI key, their own
// OpenAI-compatible endpoint, or OpenRouter. Record, stop, one request, text into the draft.
//
// The live WebRTC route (agent-voice.ts) is a conversation and belongs to a ChatGPT login. This
// shares its microphone ownership, but has no peer connection, lease, read-aloud or automatic send. It appends
// to the draft the person is already editing and stops there, which is the whole feature.
//
// Audio goes out as 16 kHz mono WAV because that is the one format every route takes — OpenRouter
// accepts only WAV or MP3, and the transcription endpoints take WAV happily. MediaRecorder's own
// webm/opus is decoded and re-encoded here rather than negotiated per provider.

import { claimOwner, releaseOwner } from './agent-voice-lease.ts';

const SAMPLE_RATE = 16_000;
/** Ten minutes. Past that the recording is closed and sent rather than lost. */
const MAX_MS = 10 * 60_000;

export interface DictationState {
  phase: 'idle' | 'recording' | 'sending' | 'error';
  message: string;
}
interface Hooks {
  ward: string;
  getDraft: () => string;
  setDraft: (text: string) => void;
  onState: (state: DictationState) => void;
}

export function createClipDictation(hooks: Hooks) {
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let chunks: Blob[] = [];
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let phase: DictationState['phase'] = 'idle';
  /** Bumped by dispose and by each new take: a late result from an old one is dropped. */
  let epoch = 0;
  let request: AbortController | undefined;
  const identity = { dispose: cancel };

  const state = (next: DictationState['phase'], message: string) => {
    phase = next;
    hooks.onState({ phase: next, message });
  };

  function releaseMicrophone() {
    clearTimeout(stopTimer);
    stopTimer = undefined;
    if (recorder) {
      recorder.ondataavailable = null; recorder.onstop = null;
      if (recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* Already stopped. */ } }
    }
    stream?.getTracks().forEach((t) => { t.stop(); });
    stream = undefined;
    recorder = undefined;
    releaseOwner(identity);
  }

  async function start(): Promise<void> {
    if (phase === 'recording' || phase === 'sending') return;
    const mine = ++epoch;
    try {
      claimOwner(identity);
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in this browser.');
      if (typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record audio.');
      state('recording', 'Starting…');
      const capture = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (mine !== epoch) { capture.getTracks().forEach((t) => { t.stop(); }); return; }
      stream = capture;
      chunks = [];
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', ''].find((t) => !t || MediaRecorder.isTypeSupported(t)) ?? '';
      recorder = new MediaRecorder(capture, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => { if (mine === epoch && e.data.size) chunks.push(e.data); };
      recorder.onstop = () => { void finish(mine); };
      recorder.start();
      // Never hold the microphone open forever: at the cap the take is closed and sent.
      stopTimer = setTimeout(() => { if (mine === epoch) void stop(); }, MAX_MS);
      state('recording', 'Recording — press again to transcribe.');
    } catch (error) {
      if (mine !== epoch) return;
      releaseMicrophone();
      state('error', reason(error));
    }
  }

  /** Close the take and transcribe it. */
  async function stop(): Promise<void> {
    if (phase !== 'recording') return;
    if (!recorder) { cancel(); return; }
    state('sending', 'Transcribing…');
    // onstop does the rest; the tracks stay open until then so the tail is not clipped.
    try { recorder.stop(); } catch { await finish(epoch); }
  }

  /** Drop the take without transcribing it. */
  function cancel(): void {
    if (phase === 'idle') return;
    epoch++;
    request?.abort(); request = undefined;
    chunks = [];
    releaseMicrophone();
    state('idle', '');
  }

  async function finish(mine: number): Promise<void> {
    if (mine !== epoch) return;
    const takes = chunks;
    chunks = [];
    releaseMicrophone();
    if (mine !== epoch) return;
    try {
      if (!takes.length) throw new Error('Nothing was recorded.');
      const wav = await toWav(new Blob(takes, { type: takes[0]?.type || 'audio/webm' }));
      if (mine !== epoch) return;
      const abort = new AbortController(); request = abort;
      const response = await fetch(`/api/agent/${encodeURIComponent(hooks.ward)}/transcribe?_ward=${encodeURIComponent(hooks.ward)}`, {
        method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
      });
      const data = await response.json().catch(() => null) as { text?: string; via?: string; error?: string } | null;
      if (mine !== epoch) return;
      if (!response.ok || !data?.text) throw new Error(data?.error ?? 'Transcription failed.');
      // Appended to whatever the person has typed since, never replacing it.
      const draft = hooks.getDraft();
      hooks.setDraft(draft && !/\s$/.test(draft) ? `${draft} ${data.text}` : `${draft}${data.text}`);
      state('idle', '');
    } catch (error) {
      if (mine === epoch) state('error', reason(error));
    } finally { if (mine === epoch) request = undefined; }
  }

  return {
    /** The one control the microphone button needs: start, or stop and transcribe. */
    toggle: () => (phase === 'recording' ? stop() : start()),
    cancel,
    dispose: cancel,
    get phase() { return phase; },
  };
}

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/NotAllowedError|Permission denied/i.test(message)) return 'Allow microphone access in your browser or System Settings, then try again.';
  if (/NotFoundError|no audio/i.test(message)) return 'No microphone was found.';
  return message || 'Dictation failed.';
}

/** Decode whatever the browser recorded and re-encode it as 16 kHz mono 16-bit WAV. */
async function toWav(blob: Blob): Promise<Blob> {
  const bytes = await blob.arrayBuffer();
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('This browser cannot process the recording.');
  const context = new Ctor();
  let decoded: AudioBuffer;
  try { decoded = await context.decodeAudioData(bytes); }
  catch { throw new Error('The recording could not be read.'); }
  finally { void context.close().catch(() => {}); }
  return new Blob([encodeWav(downmix(decoded), SAMPLE_RATE)], { type: 'audio/wav' });
}

/** Every channel averaged to one, resampled to SAMPLE_RATE by linear interpolation. */
export function downmix(buffer: AudioBuffer): Float32Array {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const ratio = buffer.sampleRate / SAMPLE_RATE;
  const length = Math.max(1, Math.floor(buffer.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const at = i * ratio;
    const low = Math.floor(at), high = Math.min(low + 1, buffer.length - 1), t = at - low;
    let sum = 0;
    for (const channel of channels) sum += (channel[low] ?? 0) * (1 - t) + (channel[high] ?? 0) * t;
    out[i] = sum / channels.length;
  }
  return out;
}

/** 16-bit PCM WAV. Exported beside downmix so the encoder can be checked without a browser. */
export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);        // PCM header size
  view.setUint16(20, 1, true);         // PCM
  view.setUint16(22, 1, true);         // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);  // byte rate
  view.setUint16(32, 2, true);         // block align
  view.setUint16(34, 16, true);        // bits per sample
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (const [i, sample] of samples.entries()) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}
