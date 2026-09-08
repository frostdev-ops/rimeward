export interface VoiceState {
  phase: 'idle' | 'connecting' | 'listening' | 'finishing' | 'speaking' | 'error';
  message: string;
}

interface VoiceHooks {
  ward: string;
  getDraft: () => string;
  setDraft: (text: string) => void;
  onState: (state: VoiceState) => void;
  isAlive?: () => boolean;
}

interface Call {
  owner: string;
  lease?: string;
  mode: 'dictation' | 'speech';
  phase: VoiceState['phase'];
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  audio: AudioContext;
  silence: MediaStream;
  microphone?: MediaStream;
  sender?: RTCRtpSender;
  output: GainNode;
  seen: Set<string>;
  transcript: string;
  text: string;
  lastInput: number;
  firstInput: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  finishing?: Promise<void>;
  resolveFinish?: () => void;
  starting?: Promise<SignalReply>;
  released?: Promise<boolean>;
  closedAck?: boolean;
  stop: () => Promise<void>;
  dispose: () => void;
}

interface SignalReply { sdp?: string; lease?: string; expiresAt?: number; active?: boolean; closed?: boolean }

// One microphone/playback owner, including duplicated wards and dialogs.
let active: Call | undefined;
let releasing: Promise<boolean> = Promise.resolve(true);
window.addEventListener('pagehide', () => active?.dispose());

const normalized = (text: string) => text.trim().replace(/\s+/g, ' ');

/** Explicit user gestures only. Voice events edit drafts or report speech; they never execute Rime. */
export function createAgentVoice(hooks: VoiceHooks) {
  let current: Call | undefined;
  const url = `/api/agent/${encodeURIComponent(hooks.ward)}/voice?_ward=${encodeURIComponent(hooks.ward)}`;

  async function request(call: Call, action: 'start' | 'status' | 'stop', sdp?: string): Promise<SignalReply> {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ action, owner: call.owner, lease: call.lease, sdp }),
      signal: AbortSignal.timeout(action === 'start' ? 45_000 : 10_000),
      keepalive: action === 'stop',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Voice is unavailable. Try again.');
    return data;
  }

  function state(call: Call, phase: VoiceState['phase'], message: string) {
    if (current !== call) return;
    call.phase = phase;
    hooks.onState({ phase, message });
  }

  function later(call: Call, fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      call.timers.delete(timer);
      if (current === call) fn();
    }, ms);
    call.timers.add(timer);
  }

  function silence(call: Call) {
    call.output.gain.value = 0;
    call.microphone?.getTracks().forEach(track => { track.stop(); });
    call.microphone = undefined;
  }

  function close(call: Call, message = '', failed = false) {
    // Silence/release hardware synchronously, even if signaling cannot reach the server.
    silence(call);
    call.silence.getTracks().forEach(track => { track.stop(); });
    for (const timer of call.timers) clearTimeout(timer);
    call.timers.clear();
    if (current === call) {
      current = undefined;
      hooks.onState({ phase: failed ? 'error' : 'idle', message });
    }
    if (active === call) active = undefined;
    if (call.channel.readyState === 'open') {
      try { call.channel.send(JSON.stringify({ type: 'session.close' })); } catch { /* server also closes the lease */ }
    }
    call.channel.close();
    call.peer.close();
    void call.audio.close().catch(() => {});
    call.resolveFinish?.();
    call.resolveFinish = undefined;
    if (!call.released) {
      // Also harvest a late start response: cancelling local media must not orphan its lease.
      const previousRelease = releasing;
      const release = (async () => {
        if (call.starting && !call.lease) {
          const result = await call.starting;
          call.lease = result.lease;
        }
        if (!call.lease) return true;
        const result = await request(call, 'stop');
        return result.closed === true || call.closedAck === true;
      })().catch(() => false);
      call.released = Promise.all([previousRelease, release]).then(([, closed]) => closed);
      releasing = call.released;
    }
  }

  function fail(call: Call, error: unknown) {
    if (current !== call) return;
    const message = error instanceof DOMException && error.name === 'NotAllowedError'
      ? 'Allow microphone access in your browser or System Settings, then try again.'
      : error instanceof Error ? error.message : 'Voice disconnected. Your draft is still editable.';
    close(call, message, true);
  }

  function receive(call: Call, raw: unknown) {
    if (current !== call || typeof raw !== 'string' || raw.length > 100_000) return;
    let event: { type?: unknown; item?: { id?: unknown; text?: unknown }; turn?: { role?: unknown } } | null;
    try { event = JSON.parse(raw); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'session.closed') {
      call.closedAck = true;
      close(call, call.mode === 'dictation' ? 'Dictation ended. Review your draft before sending.' : 'Voice session ended.');
      return;
    }
    if (event.type === 'error' || event.type === 'session.error') {
      fail(call, new Error('Voice disconnected. Your draft is still editable.'));
      return;
    }
    // Item fragments overlap turn.created/delta/done: consume this stream once only.
    if (event.type === 'input_transcript.added' || event.type === 'output_transcript.added') {
      const item = event.item;
      if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || call.seen.has(item.id)) return;
      call.seen.add(item.id);
      if (event.type === 'input_transcript.added' && call.mode === 'dictation') {
        call.lastInput = Date.now();
        const draft = hooks.getDraft();
        let fragment = item.text;
        if (call.firstInput) {
          fragment = fragment.trimStart();
          if (draft && !/\s$/.test(draft) && fragment) fragment = ` ${fragment}`;
          call.firstInput = false;
        }
        // Append to the latest edited draft; never restore a captured stale draft.
        hooks.setDraft(draft + fragment);
        if ((draft + fragment).length > 8000) {
          close(call, 'Dictation stopped at the message limit. Shorten your draft before sending; all received text is preserved.', true);
        }
      } else if (event.type === 'output_transcript.added' && call.mode === 'speech') {
        call.transcript += item.text;
      }
    }
    if (event.type === 'turn.done' && event.turn?.role === 'assistant' && call.mode === 'speech') {
      const matches = normalized(call.transcript) === normalized(call.text);
      state(call, 'speaking', matches ? 'Finishing read-aloud…' : 'Voice may pronounce numbers or code names differently.');
      // Let buffered audio finish before releasing the peer; Stop still silences immediately.
      later(call, () => close(call, matches ? 'Read-aloud finished.' : 'Read-aloud finished. Spoken wording may differ from the message.'), 1500);
    }
  }

  function monitor(call: Call, expiresAt: number) {
    later(call, () => close(call, 'Voice session expired. Start again to continue.'), Math.max(0, expiresAt - Date.now()));
    const heartbeat = async () => {
      if (hooks.isAlive && !hooks.isAlive()) { close(call); return; }
      try {
        const status = await request(call, 'status');
        if (current !== call) return;
        if (!status.active || status.closed) { close(call, 'Voice session ended. Start again to continue.'); return; }
        later(call, () => { void heartbeat(); }, 15_000);
      } catch (error) { fail(call, error); }
    };
    later(call, () => { void heartbeat(); }, 15_000);
  }

  async function start(mode: Call['mode'], text = '') {
    if (mode === 'speech' && (!text.trim() || text.length > 24_000)) {
      hooks.onState({ phase: 'error', message: 'Select a reply of up to 24,000 characters to read aloud.' });
      return;
    }
    if (!window.isSecureContext || !window.RTCPeerConnection || !window.AudioContext ||
        (mode === 'dictation' && !navigator.mediaDevices?.getUserMedia)) {
      hooks.onState({ phase: 'error', message: 'Voice needs a secure browser with microphone and WebRTC support.' });
      return;
    }
    if (active?.mode === 'dictation') {
      await active.stop();
      if (!active && !current) hooks.onState({ phase: 'idle', message: 'Dictation finished. Select the voice action again to continue.' });
      return;
    }
    active?.dispose();
    const previousRelease = releasing;
    let call: Call | undefined;
    let pendingAudio: AudioContext | undefined;
    try {
      // Resume inside the gesture, before signaling or microphone-permission awaits.
      const audio = new AudioContext();
      pendingAudio = audio;
      const resumed = audio.resume();
      const source = audio.createConstantSource();
      source.offset.value = 0;
      const destination = audio.createMediaStreamDestination();
      source.connect(destination);
      source.start();
      const peer = new RTCPeerConnection();
      const channel = peer.createDataChannel('oai-events');
      const output = audio.createGain();
      output.gain.value = mode === 'speech' ? 1 : 0;
      output.connect(audio.destination);
      call = {
        owner: crypto.randomUUID(), mode, phase: 'connecting', peer, channel, audio,
        silence: destination.stream, output, seen: new Set(), transcript: '', text,
        lastInput: 0, firstInput: true, timers: new Set(), stop, dispose: () => { if (call) close(call); },
      };
      const owned = call;
      current = active = call;
      state(call, 'connecting', mode === 'dictation' ? 'Connecting microphone…' : 'Connecting read-aloud…');
      const connectTimeout = setTimeout(() => fail(owned, new Error('Voice connection timed out. Try again.')), 45_000);
      call.timers.add(connectTimeout);
      peer.ontrack = event => {
        if (current !== owned) return;
        audio.createMediaStreamSource(new MediaStream([event.track])).connect(output);
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
          fail(owned, new Error('Voice disconnected. Your draft is still editable.'));
        }
      };
      channel.onmessage = event => receive(owned, event.data);
      channel.onclose = () => {
        if (current === owned) close(owned, 'Voice session ended. Review your draft before sending.');
      };
      channel.onerror = () => fail(owned, new Error('Voice connection failed. Try again.'));
      channel.onopen = () => {
        if (current !== owned) return;
        clearTimeout(connectTimeout);
        owned.timers.delete(connectTimeout);
        state(owned, mode === 'dictation' ? 'listening' : 'speaking', mode === 'dictation' ? 'Listening — edit or send when ready.' : 'Reading selected reply aloud…');
        if (mode === 'speech') channel.send(JSON.stringify({ type: 'session.context.append', channel: 'speakable', content: [{ type: 'input_text', text }] }));
      };
      await resumed;
      if (current !== call) return;
      if (!await previousRelease) {
        throw new Error('The previous voice session has not confirmed it closed. Wait before starting again.');
      }
      if (current !== call) return;
      let stream = call.silence;
      if (mode === 'dictation') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        if (current !== call) { stream.getTracks().forEach(track => { track.stop(); }); return; }
        call.microphone = stream;
      }
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('No microphone audio track is available.');
      call.sender = peer.addTrack(track, stream);
      const offer = await peer.createOffer();
      if (current !== call) return;
      await peer.setLocalDescription(offer);
      if (current !== call) return;
      call.starting = request(call, 'start', offer.sdp);
      const result = await call.starting;
      if (typeof result.lease === 'string') call.lease = result.lease;
      if (current !== call) {
        return;
      }
      if (!call.lease || typeof result.sdp !== 'string' || typeof result.expiresAt !== 'number' || !Number.isFinite(result.expiresAt)) throw new Error('Voice returned an invalid connection. Try again.');
      await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
      if (current !== call) return;
      monitor(call, result.expiresAt);
    } catch (error) {
      if (call) fail(call, error);
      else {
        void pendingAudio?.close().catch(() => {});
        hooks.onState({ phase: 'error', message: 'Audio is unavailable in this browser. Try again.' });
      }
    }
  }

  function stop(): Promise<void> {
    const call = current;
    if (!call) return Promise.resolve();
    if (call.finishing) return call.finishing;
    silence(call);
    if (call.mode !== 'dictation' || call.phase !== 'listening') { close(call); return Promise.resolve(); }
    state(call, 'finishing', 'Microphone stopped. Finishing your draft…');
    void call.sender?.replaceTrack(call.silence.getAudioTracks()[0] ?? null).catch(() => {});
    const stoppedAt = Date.now();
    call.finishing = new Promise(resolve => { call.resolveFinish = resolve; });
    // ponytail: bounded manual drain, not an automatic-turn boundary; keep the draft editable.
    const drain = () => {
      const now = Date.now();
      if (now - stoppedAt >= 6000 || (now - stoppedAt >= 2000 && now - call.lastInput >= 1200)) {
        close(call, 'Dictation stopped. Review your draft before sending.');
      } else later(call, drain, 100);
    };
    later(call, drain, 100);
    return call.finishing;
  }

  return {
    dictate: () => start('dictation'),
    speak: (text: string) => start('speech', text),
    stop,
    dispose: () => { if (current) close(current); },
  };
}

export type AgentVoice = ReturnType<typeof createAgentVoice>;
