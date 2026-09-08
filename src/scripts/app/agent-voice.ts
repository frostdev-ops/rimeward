export type ConversationVoiceMode = 'off' | 'finish-send' | 'hands-free';
export interface VoiceState {
  phase: 'idle' | 'connecting' | 'listening' | 'finishing' | 'speaking' | 'error';
  message: string;
  mode: ConversationVoiceMode;
  readEnabled: boolean;
}

interface VoiceHooks {
  ward: string;
  getDraft: () => string;
  setDraft: (text: string) => void;
  onState: (state: VoiceState) => void;
  isAlive?: () => boolean;
  submitDraft?: (expected: string) => Promise<boolean>;
  canAutoSend?: () => boolean;
}
interface SignalReply { sdp?: string; lease?: string; expiresAt?: number; active?: boolean; closed?: boolean }
interface Call {
  owner: string;
  lease?: string;
  kind: 'dictation' | 'speech';
  phase: VoiceState['phase'];
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  silence: MediaStream;
  source: ConstantSourceNode;
  sender?: RTCRtpSender;
  output: GainNode;
  seen: Set<string>;
  turns: Set<string>;
  transcript: string;
  text: string;
  chunks: string[];
  firstInput: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  starting?: Promise<SignalReply>;
  released?: Promise<boolean>;
  closedAck?: boolean;
  ended: Promise<void>;
  resolveEnd: () => void;
  drain?: Promise<boolean>;
  resolveDrain?: (quiet: boolean) => void;
}

// Capture and queued playback have one owner even while its chat is hidden.
let owner: { dispose: () => void } | undefined;
let releasing: Promise<boolean> = Promise.resolve(true);
window.addEventListener('pagehide', () => owner?.dispose());
const normalized = (text: string) => text.trim().replace(/\s+/g, ' ');

// The experimental speakable wire accepts at most 500 UTF-8 bytes per append.
function speechChunks(text: string): string[] {
  const chunks: string[] = [], encoder = new TextEncoder();
  const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  let rest = text.trim();
  while (rest) {
    let bytes = 0, end = 0, boundary = 0;
    for (const point of rest) {
      const size = encoder.encode(point).length;
      if (bytes + size > 500) break;
      bytes += size; end += point.length;
      if (/\s/.test(point)) boundary = end;
    }
    if (end < rest.length) {
      let sentence = 0;
      for (const part of sentences.segment(rest)) {
        const finish = part.index + part.segment.trimEnd().length;
        if (finish > end) break;
        sentence = finish;
      }
      end = sentence || boundary || end;
    }
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trimStart();
  }
  return chunks;
}

/** Voice can edit a draft or invoke the ordinary submit hook; it cannot run tools or grant approvals. */
export function createAgentVoice(hooks: VoiceHooks) {
  let current: Call | undefined, audio: AudioContext | undefined, microphone: MediaStream | undefined;
  let pendingKind: Call['kind'] | undefined;
  const audioSession = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  let previousAudioPurpose: string | undefined;
  let analyser: AnalyserNode | undefined, microphoneSource: MediaStreamAudioSourceNode | undefined;
  let sampleTimer: ReturnType<typeof setTimeout> | undefined;
  let mode: ConversationVoiceMode = 'off', readEnabled = false, revision = 0, transitioning = false, sending = false;
  let lastInput = 0, lastSpeech = 0, voiceMs = 0, sampleAt = 0, noiseFloor = 0.002, edited = false, submitted = false;
  let lastState: Pick<VoiceState, 'phase' | 'message'> = { phase: 'idle', message: '' };
  const queue: { text: string; key: string }[] = [], readKeys = new Set<string>();
  const identity = { dispose };
  const url = `/api/agent/${encodeURIComponent(hooks.ward)}/voice?_ward=${encodeURIComponent(hooks.ward)}`;

  function announce(phase: VoiceState['phase'], message: string) {
    lastState = { phase, message };
    hooks.onState({ ...lastState, mode, readEnabled });
  }
  function state(call: Call, phase: VoiceState['phase'], message: string) {
    if (current !== call) return;
    call.phase = phase; announce(phase, message);
  }
  function claim() { if (owner !== identity) owner?.dispose(); owner = identity; }
  function audioPurpose(capture: boolean) {
    if (!audioSession) return;
    previousAudioPurpose ??= audioSession.type;
    try { audioSession.type = capture ? 'play-and-record' : 'playback'; } catch { /* Optional browser API. */ }
  }
  function unlock() {
    claim();
    if (!window.isSecureContext || !window.RTCPeerConnection || !window.AudioContext) throw new Error('Voice needs a secure browser with WebRTC support.');
    audio ??= new AudioContext();
    audioPurpose(mode !== 'off' || !!microphone);
    return audio.resume(); // Called synchronously from the enable gesture, reused for later replies.
  }
  function closeAudioIfUnused() {
    if (current || mode !== 'off' || readEnabled) return;
    void audio?.close().catch(() => {}); audio = undefined;
    if (audioSession && previousAudioPurpose !== undefined) {
      try { audioSession.type = previousAudioPurpose; } catch { /* Optional browser API. */ }
      previousAudioPurpose = undefined;
    }
    if (owner === identity) owner = undefined;
  }
  function stopCapture() {
    clearTimeout(sampleTimer); sampleTimer = undefined;
    microphone?.getTracks().forEach(track => { track.stop(); }); microphone = undefined;
    microphoneSource?.disconnect(); microphoneSource = undefined; analyser = undefined;
  }
  function resetInput() { lastInput = 0; lastSpeech = 0; voiceMs = 0; edited = !!hooks.getDraft().trim(); }
  function observeMicrophone() {
    if (!audio || !microphone || analyser || mode === 'off') return;
    microphoneSource = audio.createMediaStreamSource(microphone);
    analyser = audio.createAnalyser(); analyser.fftSize = 2048; microphoneSource.connect(analyser);
    sampleAt = Date.now(); sample();
  }
  async function request(call: Call, action: 'start' | 'status' | 'stop', sdp?: string): Promise<SignalReply> {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ action, owner: call.owner, lease: call.lease, sdp }),
      // Keep harvesting a slow refresh/create after the shorter UI connection timeout closes media.
      signal: AbortSignal.timeout(action === 'start' ? 90_000 : 10_000), keepalive: action === 'stop',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Voice is unavailable. Try again.');
    return data;
  }
  function later(call: Call, fn: () => void, ms: number) {
    const timer = setTimeout(() => { call.timers.delete(timer); if (current === call) fn(); }, ms);
    call.timers.add(timer);
  }
  function close(call: Call, message = '', keepContext = false) {
    if (call.released) return;
    call.output.gain.value = 0;
    call.output.disconnect();
    call.source.stop(); call.source.disconnect();
    call.silence.getTracks().forEach(track => { track.stop(); });
    for (const timer of call.timers) clearTimeout(timer);
    call.timers.clear();
    if (current === call) { current = undefined; announce('idle', message); }
    if (call.channel.readyState === 'open') {
      try { call.channel.send(JSON.stringify({ type: 'session.close' })); } catch { /* server also closes the lease */ }
    }
    call.channel.close(); call.peer.close();
    call.resolveDrain?.(false); call.resolveDrain = undefined; call.resolveEnd();
    if (!call.released) {
      const previous = releasing;
      const release = (async () => {
        if (call.starting && !call.lease) call.lease = (await call.starting).lease;
        if (!call.lease) return true;
        const result = await request(call, 'stop');
        return result.closed === true || call.closedAck === true;
      })().catch(() => false);
      call.released = Promise.all([previous, release]).then(([, closed]) => closed);
      releasing = call.released;
    }
    if (mode === 'off') stopCapture();
    if (!keepContext) closeAudioIfUnused();
  }
  function fail(error: unknown) {
    mode = 'off'; readEnabled = false; queue.length = 0; revision++; transitioning = false;
    stopCapture();
    if (current) close(current);
    closeAudioIfUnused();
    const message = error instanceof DOMException && error.name === 'NotAllowedError'
      ? 'Allow microphone access in your browser or System Settings, then try again.'
      : error instanceof Error ? error.message : 'Voice disconnected. Your draft is still editable.';
    announce('error', message);
  }
  function sendChunk(call: Call) {
    const text = call.chunks.shift();
    if (!text || call.channel.readyState !== 'open') return;
    if (call.transcript && !/\s$/.test(call.transcript)) call.transcript += ' ';
    call.channel.send(JSON.stringify({ type: 'session.context.append', channel: 'speakable', content: [{ type: 'input_text', text }] }));
  }
  function receive(call: Call, raw: unknown) {
    if (current !== call || typeof raw !== 'string' || raw.length > 100_000) return;
    let event: { type?: unknown; item?: { id?: unknown; text?: unknown }; turn?: { id?: unknown; role?: unknown } } | null;
    try { event = JSON.parse(raw); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'session.closed') {
      call.closedAck = true; fail(new Error('Voice session ended. Review your draft before sending.')); return;
    }
    if (event.type === 'error' || event.type === 'session.error') { fail(new Error('Voice disconnected. Your draft is still editable.')); return; }
    // Item fragments overlap turn and delegation events. Only this stream can edit the draft.
    if (event.type === 'input_transcript.added' || event.type === 'output_transcript.added') {
      const item = event.item;
      if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || call.seen.has(item.id)) return;
      call.seen.add(item.id);
      if (event.type === 'input_transcript.added' && call.kind === 'dictation') {
        lastInput = Date.now();
        const draft = hooks.getDraft();
        let fragment = item.text;
        if (call.firstInput || !draft) {
          fragment = fragment.trimStart();
          if (draft && !/\s$/.test(draft) && fragment) fragment = ` ${fragment}`;
          call.firstInput = false;
        }
        hooks.setDraft(draft + fragment);
        if (submitted && voiceMs === 0) {
          edited = true; state(call, call.phase, 'Late transcript received. Review your draft, then Finish & Send.');
        }
        if ((draft + fragment).length > 8000) fail(new Error('Dictation stopped at the message limit. Shorten your draft; all received text is preserved.'));
      } else if (event.type === 'output_transcript.added' && call.kind === 'speech') call.transcript += item.text;
    }
    if (event.type === 'turn.done' && event.turn?.role === 'assistant' && call.kind === 'speech') {
      if (typeof event.turn.id !== 'string' || call.turns.has(event.turn.id)) return;
      call.turns.add(event.turn.id);
      if (call.chunks.length) { sendChunk(call); return; }
      const matches = normalized(call.transcript) === normalized(call.text);
      state(call, 'speaking', matches ? 'Finishing read-aloud…' : 'Voice may pronounce numbers or code names differently.');
      // Inter-chunk turn.done already follows audio; only the final chunk needs a playback tail.
      later(call, () => close(call, matches ? 'Read-aloud finished.' : 'Read-aloud finished. Spoken wording may differ from the message.'), 1500);
    }
  }
  function monitor(call: Call, expiresAt: number) {
    later(call, () => fail(new Error('Voice session expired. Start again to continue.')), Math.max(0, expiresAt - Date.now()));
    const heartbeat = async () => {
      if (hooks.isAlive && !hooks.isAlive()) { dispose(); return; }
      try {
        const status = await request(call, 'status');
        if (current !== call) return;
        if (!status.active || status.closed) { fail(new Error('Voice session ended. Start again to continue.')); return; }
        later(call, () => { void heartbeat(); }, 15_000);
      } catch (error) { if (current === call) fail(error); }
    };
    later(call, () => { void heartbeat(); }, 15_000);
  }
  async function connect(kind: Call['kind'], text = ''): Promise<Call | undefined> {
    if (kind === 'speech' && (!text.trim() || text.length > 24_000)) { fail(new Error('Select a reply of up to 24,000 characters to read aloud.')); return; }
    const epoch = revision;
    const conversational = mode !== 'off';
    pendingKind = kind;
    let call: Call | undefined;
    try {
      const resumed = unlock();
      if (kind === 'dictation') audioPurpose(true);
      // Keep the unlocked context alive while replacing a nonpersistent manual call.
      const context = audio;
      if (!context) return;
      if (current) close(current, '', true);
      audio = context;
      await resumed;
      if (epoch !== revision || owner !== identity || (kind === 'dictation' && conversational && mode === 'off')) return;
      if (!await releasing) {
        // A later explicit attempt may ask the authoritative server again; never retry creation here.
        releasing = Promise.resolve(true);
        throw new Error('The previous voice session has not confirmed it closed. Wait before starting again.');
      }
      if (epoch !== revision || owner !== identity || (kind === 'dictation' && conversational && mode === 'off')) return;
      const source = context.createConstantSource(); source.offset.value = 0;
      const destination = context.createMediaStreamDestination(); source.connect(destination); source.start();
      const peer = new RTCPeerConnection(), channel = peer.createDataChannel('oai-events');
      const output = context.createGain(); output.gain.value = kind === 'speech' ? 1 : 0; output.connect(context.destination);
      let resolveEnd = () => {};
      const ended = new Promise<void>(resolve => { resolveEnd = resolve; });
      call = { owner: crypto.randomUUID(), kind, phase: 'connecting', peer, channel, source,
        silence: destination.stream, output, seen: new Set(), turns: new Set(), transcript: '', text,
        chunks: kind === 'speech' ? speechChunks(text) : [], firstInput: true, timers: new Set(), ended, resolveEnd };
      const owned = call; current = call;
      state(call, 'connecting', kind === 'dictation' ? 'Connecting microphone…' : 'Connecting read-aloud…');
      const timeout = setTimeout(() => { if (current === owned) fail(new Error('Voice connection timed out. Try again.')); }, 45_000);
      call.timers.add(timeout);
      peer.ontrack = event => { if (current === owned) context.createMediaStreamSource(new MediaStream([event.track])).connect(output); };
      peer.onconnectionstatechange = () => {
        if (current === owned && (peer.connectionState === 'failed' || peer.connectionState === 'disconnected')) fail(new Error('Voice disconnected. Your draft is still editable.'));
      };
      channel.onmessage = event => receive(owned, event.data);
      channel.onclose = () => { if (current === owned) fail(new Error('Voice session ended. Your draft is still editable.')); };
      channel.onerror = () => { if (current === owned) fail(new Error('Voice connection failed. Try again.')); };
      channel.onopen = () => {
        if (current !== owned) return;
        clearTimeout(timeout); owned.timers.delete(timeout);
        state(owned, kind === 'dictation' ? 'listening' : 'speaking', kind === 'speech' ? 'Reading reply aloud…' : mode === 'hands-free' ? 'Listening — pauses send your message.' : mode === 'finish-send' ? 'Listening — Finish & Send when ready.' : 'Listening — edit or send when ready.');
        if (kind === 'speech') sendChunk(owned);
      };
      let stream = call.silence;
      if (kind === 'dictation') {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in this browser.');
        if (!microphone) {
          const capture = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
          if (current !== call || epoch !== revision) { capture.getTracks().forEach(track => { track.stop(); }); return; }
          microphone = capture;
        }
        stream = microphone;
        observeMicrophone();
      }
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('No microphone audio track is available.');
      call.sender = peer.addTrack(track, stream);
      const offer = await peer.createOffer();
      if (current !== call) return;
      await peer.setLocalDescription(offer);
      if (current !== call) return;
      call.starting = request(call, 'start', offer.sdp);
      const result = await call.starting; call.lease = result.lease;
      if (current !== call) return;
      if (!call.lease || typeof result.sdp !== 'string' || typeof result.expiresAt !== 'number' || !Number.isFinite(result.expiresAt)) throw new Error('Voice returned an invalid connection. Try again.');
      await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
      if (current === call) monitor(call, result.expiresAt);
      return call;
    } catch (error) { if (epoch === revision && (!call || current === call)) fail(error); return; }
    finally { if (epoch === revision) pendingKind = undefined; }
  }

  function sample() {
    clearTimeout(sampleTimer);
    if (!analyser || !microphone || mode === 'off') return;
    if (hooks.isAlive && !hooks.isAlive()) { dispose(); return; }
    const now = Date.now(), frame = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(frame);
    const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length);
    const threshold = Math.max(0.008, noiseFloor * 3.5);
    if (rms < threshold) noiseFloor = noiseFloor * 0.98 + rms * 0.02;
    if (current && !transitioning && !sending && !current.drain && ['listening', 'speaking'].includes(current.phase)) {
      if (rms >= threshold) {
        voiceMs += Math.min(100, now - sampleAt); lastSpeech = now;
        if (current.kind === 'speech' && voiceMs >= 120) void bargeIn();
      }
      if (mode === 'hands-free' && current.kind === 'dictation' && voiceMs >= 200 &&
          now - lastSpeech >= 2500 && now - lastInput >= 1200 && hooks.getDraft().trim()) {
        if (hooks.canAutoSend?.() === false) edited = true;
        if (!edited && hooks.canAutoSend?.() && !hooks.getDraft().trimStart().startsWith('/')) void submitCurrent(true);
      }
    }
    sampleAt = now;
    if (!transitioning) void pump();
    sampleTimer = setTimeout(sample, 20);
  }
  async function submitCurrent(automatic: boolean): Promise<void> {
    if (sending || mode === 'off' || !hooks.submitDraft) return;
    const expected = hooks.getDraft(), epoch = revision;
    if (!expected.trim() || expected.length > 8000 || (automatic && (edited || !hooks.canAutoSend?.() || expected.trimStart().startsWith('/')))) return;
    sending = true;
    try {
      const accepted = await hooks.submitDraft(expected);
      if (epoch !== revision) return;
      if (accepted) { resetInput(); submitted = true; if (current) current.firstInput = true; }
      else { edited = true; announce('listening', 'Review your draft, then Finish & Send.'); }
    } catch (error) { edited = true; announce('error', error instanceof Error ? error.message : 'Could not send your draft. Review it before trying again.'); }
    finally { sending = false; }
  }
  function drain(call: Call, releaseCapture: boolean): Promise<boolean> {
    if (call.drain) return call.drain;
    call.output.gain.value = 0;
    if (releaseCapture) stopCapture();
    void call.sender?.replaceTrack(call.silence.getAudioTracks()[0] ?? null).catch(() => {});
    state(call, 'finishing', releaseCapture ? 'Microphone stopped. Finishing your draft…' : 'Finishing your message…');
    const stopped = Date.now();
    call.drain = new Promise(resolve => { call.resolveDrain = resolve; });
    // ponytail: bounded manual drain; an unsettled transcript stays editable instead of auto-sending.
    const poll = () => {
      const elapsed = Date.now() - stopped, quiet = elapsed >= 2000 && Date.now() - lastInput >= 1200;
      if (quiet || elapsed >= 6000) { call.resolveDrain?.(quiet); call.resolveDrain = undefined; }
      else later(call, poll, 100);
    };
    later(call, poll, 100);
    return call.drain;
  }
  async function finishAndSend() {
    const call = current, epoch = revision;
    if (mode === 'off' || !call || call.kind !== 'dictation' || call.phase !== 'listening' || sending) return;
    const quiet = await drain(call, false);
    if (epoch !== revision || current !== call) return;
    call.drain = undefined;
    if (quiet) await submitCurrent(false);
    else { edited = true; announce('listening', 'Transcript is still arriving. Review your draft, then Finish & Send.'); }
    if (epoch !== revision || current !== call) return;
    try { await call.sender?.replaceTrack(microphone?.getAudioTracks()[0] ?? null); }
    catch (error) { if (current === call) fail(error); return; }
    state(call, 'listening', !quiet ? 'Transcript is still arriving. Review your draft, then Finish & Send.' : edited ? 'Review your draft, then Finish & Send.' : mode === 'hands-free' ? 'Listening — pauses send your message.' : 'Listening — Finish & Send when ready.');
    void pump();
  }
  async function resumeListening(epoch: number) {
    if (epoch !== revision || mode === 'off' || current) return;
    await connect('dictation');
  }
  async function pump() {
    if (!readEnabled || !queue.length || transitioning || sending || current?.kind === 'speech') return;
    if (current && (current.phase !== 'listening' || voiceMs > 0 || (lastInput && Date.now() - lastInput < 1200))) return;
    const next = queue.shift();
    if (!next) return;
    transitioning = true;
    const epoch = revision;
    try {
      if (current) close(current);
      const call = await connect('speech', next.text);
      if (epoch !== revision) return;
      transitioning = false;
      if (call) await call.ended;
      if (epoch !== revision) return;
      if (readEnabled && queue.length) void pump();
      else await resumeListening(epoch);
    } finally { if (epoch === revision) transitioning = false; }
  }
  async function bargeIn() {
    if (transitioning || current?.kind !== 'speech' || mode === 'off') return;
    current.output.gain.value = 0; queue.length = 0;
    revision++; const epoch = revision; transitioning = true;
    close(current); resetInput();
    announce('connecting', 'Reconnecting voice. Wait for Listening before speaking.');
    try { await resumeListening(epoch); }
    finally { if (epoch === revision) transitioning = false; }
  }
  async function setConversation(next: ConversationVoiceMode) {
    if (next === mode) return;
    if (next === 'off') { await viewHidden(); return; }
    if (current?.kind === 'dictation') {
      if (!hooks.submitDraft) { fail(new Error('Conversation voice is unavailable in this view.')); return; }
      mode = next;
      edited ||= !!hooks.getDraft().trim();
      try { await unlock(); observeMicrophone(); announce(current?.phase ?? 'idle', next === 'hands-free' ? 'Listening — pauses send your message. Review any existing draft with Finish & Send.' : 'Listening — Finish & Send when ready.'); }
      catch (error) { fail(error); }
      return;
    }
    const epoch = ++revision;
    mode = next; resetInput(); submitted = false;
    try {
      if (!hooks.submitDraft) throw new Error('Conversation voice is unavailable in this view.');
      const resumed = unlock();
      transitioning = true;
      if (current) close(current);
      await resumed;
      if (epoch !== revision) return;
      await connect('dictation');
    } catch (error) { if (epoch === revision) fail(error); }
    finally { if (epoch === revision) transitioning = false; }
  }
  async function setReadResponses(enabled: boolean) {
    readEnabled = enabled;
    try {
      if (enabled) await unlock();
      else {
        queue.length = 0;
        if (current?.kind === 'speech' || pendingKind === 'speech') {
          revision++; pendingKind = undefined; const epoch = revision;
          if (current?.kind === 'speech') close(current);
          transitioning = false; await resumeListening(epoch);
        }
        closeAudioIfUnused();
      }
      announce(current?.phase ?? 'idle', enabled ? 'New responses will be read aloud.' : 'Automatic read-aloud is off.');
      void pump();
    } catch (error) { fail(error); }
  }
  async function viewHidden() {
    const call = current;
    mode = 'off';
    if (call?.kind === 'dictation' || pendingKind === 'dictation') { revision++; pendingKind = undefined; transitioning = false; }
    stopCapture();
    if (audio) audioPurpose(false);
    if (call?.kind === 'dictation') {
      await drain(call, true);
      if (current === call) close(call, 'Dictation stopped. Your draft is saved.');
    } else announce(call?.phase ?? 'idle', call ? lastState.message : 'Microphone stopped.');
    closeAudioIfUnused();
    void pump();
  }
  async function stop() {
    revision++; pendingKind = undefined; transitioning = false;
    readEnabled = false; queue.length = 0;
    await viewHidden();
    if (current) close(current);
    closeAudioIfUnused();
  }
  function dispose() {
    revision++; pendingKind = undefined; mode = 'off'; readEnabled = false; transitioning = false; queue.length = 0;
    stopCapture(); if (current) close(current); closeAudioIfUnused();
    announce('idle', '');
  }
  async function dictate() {
    if (current?.kind === 'dictation') { await stop(); return; }
    mode = 'off'; revision++; resetInput(); submitted = false;
    await connect('dictation');
  }
  async function speak(text: string) {
    if (current?.kind === 'dictation') { await viewHidden(); announce('idle', 'Dictation finished. Select Read aloud again to continue.'); return; }
    revision++; const epoch = revision;
    queue.length = 0;
    const call = await connect('speech', text);
    if (call) void call.ended.then(() => { if (epoch === revision) void resumeListening(epoch); });
  }
  return {
    dictate, speak, stop, dispose, setConversation, setReadResponses, finishAndSend, viewHidden, finishDraft: viewHidden,
    read(text: string, key: string) {
      if (!readEnabled || readKeys.has(key) || !text.trim()) return;
      readKeys.add(key); queue.push({ text, key }); void pump();
    },
    draftEdited() { edited = true; },
  };
}
export type AgentVoice = ReturnType<typeof createAgentVoice>;
