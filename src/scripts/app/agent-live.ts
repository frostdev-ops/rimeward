import { chainRelease, claimOwner, ownsAudio, releaseOwner, releasePending, resetRelease, signal, speechChunks, type SignalReply } from './agent-voice-lease.ts';

// This module owns a call, never an agent, a draft, a tool or an approval.
// The pure digest/router exports are also used by the native Node tests.
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[^a-zA-Z0-9_.:-]/.test(value);

function bounded(text: string, limit: number): string {
  let result = '', length = 0;
  for (const point of text) {
    length += bytes(point);
    if (length > limit) break;
    result += point;
  }
  return result;
}

export interface LiveDigestInput {
  busy: boolean;
  pending: boolean;
  status?: { at: string; services: readonly { label: string; ok: boolean | null }[] };
  unread?: number;
}

/** Only already-visible, slow-moving state. Unknown/stale is never rendered as healthy. */
export function buildLiveDigest(input: LiveDigestInput, nowMs: number): string {
  const at = input.status ? Date.parse(input.status.at) : NaN;
  const fresh = Number.isFinite(nowMs) && Number.isFinite(at) && at <= nowMs && nowMs - at <= 90_000;
  const services = input.status?.services ?? [];
  const down = services.filter(item => item.ok === false);
  const digest = {
    kind: 'live_state',
    observed_at: Number.isFinite(at) ? new Date(at).toISOString() : null,
    stale: !fresh,
    rime: input.pending ? 'needs_on_screen_action' : input.busy ? 'working' : 'idle',
    services: input.status ? {
      up: services.filter(item => item.ok === true).length,
      down: down.length,
      unknown: services.filter(item => item.ok !== true && item.ok !== false).length,
      down_names: down.slice(0, 4).map(item => bounded([...item.label].map(point => point.charCodeAt(0) < 32 ? ' ' : point).join(''), 36)),
    } : null,
    ...(Number.isSafeInteger(input.unread) && Number(input.unread) >= 0 ? { unread: Math.min(Number(input.unread), 999999) } : {}),
  };
  // JSON escaping counts too. Drop decoration, never counts or freshness, to fit the wire.
  while (bytes(JSON.stringify(digest)) > 490 && digest.services?.down_names.length) digest.services.down_names.pop();
  return JSON.stringify(digest);
}

/** A changed digest is sent at most once per 30 seconds, including under a busy event stream. */
export function createDigestGate() {
  let last: string | undefined, at: number | undefined;
  return {
    offer(text: string, nowMs: number): string | null {
      if (!text || bytes(text) > 500 || !Number.isFinite(nowMs) || text === last || (at !== undefined && nowMs - at < 30_000)) return null;
      last = text; at = nowMs;
      return text;
    },
  };
}

export interface LiveDelegation { id: string; text: string }

/** Recorded before dispatch, including refusals. A new call gets a fresh bounded identity set. */
export function createDelegationGate() {
  const seen = new Set<string>();
  return {
    admit(id: string): 'new' | 'duplicate' | 'full' | 'invalid' {
      if (!identifier(id)) return 'invalid';
      if (seen.has(id)) return 'duplicate';
      if (seen.size >= 256) return 'full';
      seen.add(id);
      return 'new';
    },
  };
}

/** The pinned Codex V3 wire, not the incompatible public session.delegation.created event. */
export function parseLiveDelegation(value: unknown): LiveDelegation | null {
  const event = record(value), item = record(event?.item);
  if (event?.type !== 'delegation.created' || item?.type !== 'delegation' || item.target !== 'client' || !identifier(item.id)) return null;
  if (!Array.isArray(item.content) || item.content.length > 64) return null;
  let text = '';
  for (const value of item.content) {
    const content = record(value);
    if (content?.type !== 'input_text') continue;
    if (typeof content.text !== 'string') return null;
    text += content.text;
    if (text.length > 8000) return null;
  }
  return text.trim() ? { id: item.id, text: text.trim() } : null;
}

export interface LiveRouteState {
  active: boolean;
  busy: boolean;
  pending: boolean;
  blocked: boolean;
  session?: string;
  delegation?: string;
}

/** Framing is visible in ordinary chat. It is not an authorization or a hidden system message. */
export function routeLiveDelegation(text: string, state: LiveRouteState): { action: 'turn' | 'steer'; text: string } | { action: 'refuse'; reason: string } {
  if (!state.active) return { action: 'refuse', reason: 'The voice session has ended. Nothing new was submitted.' };
  if (state.pending) return { action: 'refuse', reason: 'Rime needs an on-screen confirmation or answer. Voice cannot operate that control.' };
  if (state.blocked) return { action: 'refuse', reason: 'This conversation is unavailable or changing. Check the chat before asking again.' };
  if (typeof text !== 'string' || !text.trim() || text.length > 8000) return { action: 'refuse', reason: 'The delegated request is empty or too long. Please make a shorter request.' };
  if (text.trimStart().startsWith('/')) return { action: 'refuse', reason: 'Chat commands must be entered on screen, not executed by the voice model.' };
  const content = JSON.stringify({
    origin: 'voice-model',
    ...(state.session ? { session: state.session } : {}),
    ...(state.delegation ? { delegation: state.delegation } : {}),
    request: text.trim(),
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const framed = `<realtime_delegation>\n${content}\n</realtime_delegation>`;
  if (framed.length > 8000) return { action: 'refuse', reason: 'The delegated request exceeds the chat limit after safe framing. Please shorten it.' };
  return { action: state.busy ? 'steer' : 'turn', text: framed };
}

export interface LiveVoiceState {
  phase: 'idle' | 'connecting' | 'listening' | 'speaking' | 'ending' | 'error';
  message: string;
  muted: boolean;
  speakerSafe: boolean;
  playbackBlocked: boolean;
  input: string;
  output: string;
  startedAt?: number;
  endedAt?: number;
  expiresAt?: number;
  usage?: unknown;
  echoCancellation?: boolean;
  delegated: number;
}

export interface LiveVoiceRequest {
  session: string;
  id: string;
  text: string;
  action: 'turn' | 'steer';
}

export interface LiveSubmission { accepted: boolean; reason?: string }
interface Hooks {
  ward: string;
  /** Conversation, runtime and provider binding, independent of ordinary stream revisions. */
  scope: () => string;
  available: () => boolean;
  route: () => Pick<LiveRouteState, 'busy' | 'pending' | 'blocked'>;
  history: () => { role: 'user' | 'assistant'; text: string }[];
  digest: () => LiveDigestInput;
  delegate: (request: LiveVoiceRequest) => Promise<LiveSubmission>;
  onState: (state: LiveVoiceState) => void;
}

interface Call {
  owner: string;
  scope: string;
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  audio: HTMLAudioElement;
  microphone?: MediaStream;
  sender?: RTCRtpSender;
  silence?: MediaStream;
  silenceSource?: ConstantSourceNode;
  silenceContext?: AudioContext;
  lease?: string;
  starting?: Promise<SignalReply>;
  closed: boolean;
  closedAck: boolean;
  ready: boolean;
  remoteSpeaking: boolean;
  previousAudioPurpose?: string;
  digest: ReturnType<typeof createDigestGate>;
  delegationGate: ReturnType<typeof createDelegationGate>;
  history: { role: 'user' | 'assistant'; text: string }[];
  outbox: string[];
  queuedBytes: number;
  frames: Set<string>;
  replies: Set<string>;
  delegations: Map<string, { text: string; submitted: boolean }>;
  timers: Set<ReturnType<typeof setTimeout>>;
  expiry?: ReturnType<typeof setTimeout>;
  speechTail?: ReturnType<typeof setTimeout>;
  microphoneWork?: Promise<void>;
  inputDone: boolean;
  outputDone: boolean;
  outputVersion: number;
}

/** One full-duplex call from Start to End. There are no draft, approval or task-control hooks. */
export function createAgentLive(hooks: Hooks) {
  let current: Call | undefined, closing: Promise<boolean> | undefined;
  let state: LiveVoiceState = { phase: 'idle', message: '', muted: false, speakerSafe: false, playbackBlocked: false, input: '', output: '', delegated: 0 };
  const identity = { dispose: () => { void stop(); } };
  const audioSession = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  const wireLog = (() => { try { return localStorage.getItem('fd-voice-wire') === '1'; } catch { return false; } })();
  const emit = (patch: Partial<LiveVoiceState>) => { state = { ...state, ...patch }; hooks.onState({ ...state }); };
  const owned = (call: Call) => current === call && !call.closed && ownsAudio(identity);
  const inScope = (call: Call) => owned(call) && hooks.available() && hooks.scope() === call.scope;
  const later = (call: Call, fn: () => void, ms: number) => {
    const timer = setTimeout(() => { call.timers.delete(timer); if (owned(call)) fn(); }, ms);
    call.timers.add(timer);
    return timer;
  };

  function send(call: Call, event: Record<string, unknown>): boolean {
    if (!owned(call)) return false;
    const raw = JSON.stringify(event);
    if (call.channel.readyState === 'connecting') {
      if (call.outbox.length >= 128 || call.queuedBytes + bytes(raw) > 64 * 1024) {
        void stop('Too much context arrived while voice was connecting. Check the chat and start again.', true);
        return false;
      }
      call.outbox.push(raw); call.queuedBytes += bytes(raw);
      return true;
    }
    if (call.channel.readyState !== 'open') return false;
    if (call.channel.bufferedAmount > 256 * 1024) { void stop('Voice context delivery stalled. Start a new session after checking the connection.', true); return false; }
    if (wireLog) console.debug('[voice live wire] →', raw);
    try { call.channel.send(raw); return true; }
    catch { void stop('The voice data channel disconnected. Tasks already submitted remain in chat.', true); return false; }
  }

  function context(call: Call, text: string, delegation?: string, channel?: 'commentary' | 'speakable') {
    // Omitted channel is the pinned V3 Thinking path. Do not borrow public GPT-Live event names.
    for (const chunk of speechChunks(text, true)) {
      if (!send(call, {
        type: delegation ? 'delegation.context.append' : 'session.context.append',
        ...(delegation ? { delegation_item_id: delegation } : {}),
        ...(channel ? { channel } : {}),
        content: [{ type: 'input_text', text: chunk }],
      })) break;
    }
  }

  function updateDigest(call: Call) {
    if (!call.ready || !inScope(call)) return;
    const next = call.digest.offer(buildLiveDigest(hooks.digest(), Date.now()), Date.now());
    if (next) context(call, next);
  }

  function expiry(call: Call, until: number) {
    clearTimeout(call.expiry);
    if (call.expiry !== undefined) call.timers.delete(call.expiry);
    emit({ expiresAt: until });
    call.expiry = later(call, () => { void stop('Voice lease expired. Start a new session to continue.', true); }, Math.max(0, until - Date.now()));
  }

  async function heartbeat(call: Call) {
    if (!inScope(call)) { if (owned(call)) await stop('The conversation or connection changed. Start a new voice session.'); return; }
    try {
      const reply = await signal(hooks.ward, 'status', { owner: call.owner, lease: call.lease });
      if (!owned(call)) return;
      if (!reply.active || reply.closed) {
        call.closedAck = reply.closed === true;
        await stop(reply.message ?? reply.reason ?? 'The voice session is no longer active. Start again to continue.', true);
        return;
      }
      if (typeof reply.expiresAt !== 'number' || !Number.isFinite(reply.expiresAt)) throw Error('Voice returned an invalid lease deadline.');
      expiry(call, reply.expiresAt);
      emit({ usage: reply.usage });
      updateDigest(call);
      later(call, () => { void heartbeat(call); }, 15_000);
    } catch (error) {
      if (owned(call)) await stop(error instanceof Error ? error.message : 'Voice heartbeat failed. The call has been stopped locally.', true);
    }
  }

  function microphoneGate(call: Call): Promise<void> {
    if (!owned(call) || !call.sender) return Promise.resolve();
    const shouldMute = () => state.muted || state.playbackBlocked || (state.speakerSafe && call.remoteSpeaking);
    // Silence immediately; serialize replaceTrack so a late mute cannot undo a later unmute.
    for (const track of call.microphone?.getAudioTracks() ?? []) track.enabled = !shouldMute();
    call.microphoneWork = (call.microphoneWork ?? Promise.resolve()).then(async () => {
      if (!owned(call) || !call.sender) return;
      try {
        if (shouldMute() && !call.silence) {
          const ctx = new AudioContext(), source = ctx.createConstantSource(), destination = ctx.createMediaStreamDestination();
          source.offset.value = 0; source.connect(destination); source.start();
          call.silenceContext = ctx; call.silenceSource = source; call.silence = destination.stream;
          // A background WebView may defer resume indefinitely. The capture track is
          // already disabled; a suspended silence source must not block later unmute.
          void ctx.resume().catch(() => {});
        }
        if (!owned(call)) return;
        const silent = shouldMute();
        for (const track of call.microphone?.getAudioTracks() ?? []) track.enabled = !silent;
        await call.sender.replaceTrack((silent ? call.silence : call.microphone)?.getAudioTracks()[0] ?? null);
      } catch (error) { if (owned(call)) await stop(error instanceof Error ? error.message : 'Microphone could not be muted safely.', true); }
    });
    return call.microphoneWork;
  }

  async function play(call: Call) {
    try {
      await call.audio.play();
      if (!inScope(call)) { if (owned(call)) await stop('The conversation changed while voice audio was starting.'); return; }
      emit({ playbackBlocked: false });
      await microphoneGate(call);
    } catch {
      if (!owned(call)) return;
      emit({ playbackBlocked: true, message: 'Click Enable voice audio to hear the session. The microphone is paused until playback is allowed.' });
      await microphoneGate(call);
    }
  }

  async function delegate(call: Call, request: LiveDelegation) {
    if (!inScope(call)) return;
    const admission = call.delegationGate.admit(request.id);
    if (admission === 'duplicate' || admission === 'invalid') return;
    if (admission === 'full') { await stop('This session reached its request limit. Start a new session to continue.', true); return; }
    const routed = routeLiveDelegation(request.text, { ...hooks.route(), active: true, session: call.owner, delegation: request.id });
    // Record even a refusal before any asynchronous operation: no frame can dispatch twice.
    call.delegations.set(request.id, { text: routed.action === 'refuse' ? '' : routed.text, submitted: false });
    if (routed.action === 'refuse') {
      context(call, `[BACKEND] ${routed.reason}`, request.id, 'commentary');
      emit({ message: routed.reason });
      return;
    }
    emit({ delegated: state.delegated + 1 });
    try {
      const reply = await hooks.delegate({ session: call.owner, id: request.id, text: routed.text, action: routed.action });
      if (!inScope(call)) return;
      const entry = call.delegations.get(request.id);
      if (entry) entry.submitted = reply.accepted;
      if (!reply.accepted) {
        const reason = reply.reason ?? 'Rime could not confirm receipt. Check the chat; do not repeat an uncertain action automatically.';
        context(call, `[BACKEND] ${reason}`, request.id, 'commentary');
        emit({ message: reason });
      }
    } catch {
      if (!inScope(call)) return;
      const reason = 'The request could not be confirmed. It may already be running; check the chat before repeating it.';
      context(call, `[BACKEND] ${reason}`, request.id, 'commentary');
      emit({ message: reason });
    }
  }

  function receive(call: Call, raw: unknown) {
    if (typeof raw !== 'string' || raw.length > 100_000 || !owned(call)) return;
    if (wireLog) console.debug('[voice live wire] ←', raw);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return; }
    const event = record(value);
    if (!event) return;
    if (!inScope(call)) { void stop('This conversation changed. Start a new voice session.'); return; }
    if (event.type === 'session.closed') { call.closedAck = true; void stop('Voice session ended.'); return; }
    if (event.type === 'error' || event.type === 'session.error') { void stop('The voice provider reported an error. Existing Rime work is still in the chat.', true); return; }
    if (event.type === 'session.delegation.created') { void stop('The provider changed its voice protocol. No new request was dispatched.', true); return; }
    if (event.type === 'session.usage.updated') { emit({ usage: event.session_usage }); return; }
    if (event.type === 'delegation.created') {
      const request = parseLiveDelegation(event);
      if (request) void delegate(call, request);
      else {
        const item = record(event.item);
        const message = 'The delegated request was invalid or too long. Nothing was submitted; please state a shorter request.';
        if (item?.type === 'delegation' && item.target === 'client' && identifier(item.id)) {
          const admission = call.delegationGate.admit(item.id);
          if (admission === 'full') { void stop('This session reached its request limit. Start another session.', true); return; }
          if (admission === 'new') context(call, `[BACKEND] ${message}`, item.id, 'commentary');
        }
        emit({ message });
      }
      return;
    }
    const input = event.type === 'input_transcript.added', output = event.type === 'output_transcript.added';
    if (input || output) {
      const item = record(event.item);
      if (typeof item?.text !== 'string') return;
      // An item can carry multiple fragments. Only a wire event id establishes a
      // replay; equal text or an equal item id must not erase a repeated word.
      if (identifier(event.event_id)) {
        const key = `event:${event.event_id}`;
        if (call.frames.has(key)) return;
        if (call.frames.size >= 20000) { void stop('This session reached its transcript limit. Start a new session to continue.', true); return; }
        call.frames.add(key);
      }
      if (input) {
        emit({ input: bounded((call.inputDone ? '' : state.input) + item.text, 4000), phase: call.remoteSpeaking ? 'speaking' : 'listening' });
        call.inputDone = false;
      } else {
        clearTimeout(call.speechTail); if (call.speechTail !== undefined) call.timers.delete(call.speechTail);
        call.outputVersion++;
        call.remoteSpeaking = true;
        emit({ output: bounded((call.outputDone ? '' : state.output) + item.text, 4000), phase: 'speaking', message: state.speakerSafe ? 'Speaking · microphone paused in speaker-safe mode' : 'Speaking · you can interrupt naturally' });
        call.outputDone = false;
        void microphoneGate(call);
      }
    }
    if (event.type === 'turn.done') {
      const turn = record(event.turn);
      if (typeof turn?.transcript !== 'string') return;
      if (identifier(turn.id)) {
        const key = `done:${String(turn.role)}:${turn.id}`;
        if (call.frames.has(key)) return;
        if (call.frames.size >= 20000) { void stop('This session reached its transcript limit. Start another session to continue.', true); return; }
        call.frames.add(key);
      }
      // Final text replaces, rather than duplicates, that speaker's partial caption.
      // A user transcript is not a delegation and has no submission path here.
      if (turn.role === 'user') { call.inputDone = true; emit({ input: bounded(turn.transcript, 4000) }); }
      if (turn.role === 'assistant') {
        call.outputDone = true;
        emit({ output: bounded(turn.transcript, 4000) });
        clearTimeout(call.speechTail); if (call.speechTail !== undefined) call.timers.delete(call.speechTail);
        const version = call.outputVersion;
        call.speechTail = later(call, () => {
          if (version !== call.outputVersion) return;
          call.remoteSpeaking = false;
          emit({ phase: 'listening', message: state.muted ? 'Microphone muted · session connected' : 'Listening · speak naturally' });
          void microphoneGate(call);
        }, state.speakerSafe ? 1500 : 0);
      }
    }
  }

  async function start() {
    if (current || closing) return;
    if (!hooks.available()) { emit({ phase: 'error', message: 'Connect ChatGPT and open an available Rime conversation before starting voice.' }); return; }
    if (!window.isSecureContext || !window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) { emit({ phase: 'error', message: 'Live voice needs a secure connection and microphone/WebRTC support.' }); return; }
    let peer: RTCPeerConnection | undefined;
    let channel: RTCDataChannel;
    const audio = document.createElement('audio');
    try {
      claimOwner(identity);
      peer = new RTCPeerConnection(); channel = peer.createDataChannel('oai-events');
      audio.autoplay = true; audio.hidden = true; audio.setAttribute('playsinline', ''); document.body.append(audio);
    } catch {
      peer?.close(); audio.remove(); releaseOwner(identity);
      emit({ phase: 'error', message: 'This WebView could not create a live voice connection.' });
      return;
    }
    const call: Call = { owner: crypto.randomUUID(), scope: hooks.scope(), peer, channel, audio, closed: false, closedAck: false, ready: false,
      remoteSpeaking: false, digest: createDigestGate(), delegationGate: createDelegationGate(), history: [], outbox: [], queuedBytes: 0,
      frames: new Set(), replies: new Set(), delegations: new Map(), timers: new Set(), inputDone: true, outputDone: true, outputVersion: 0 };
    current = call;
    emit({ phase: 'connecting', message: 'Starting live voice session…', muted: false, playbackBlocked: false, input: '', output: '', delegated: 0, startedAt: undefined, endedAt: undefined, expiresAt: undefined, usage: undefined });
    later(call, () => { if (!call.ready) void stop('Voice connection timed out. Nothing will be retried automatically.', true); }, 45_000);
    if (audioSession) { call.previousAudioPurpose = audioSession.type; try { audioSession.type = 'play-and-record'; } catch { /* Optional browser API. */ } }
    try {
      // Capture once, before awaiting permissions; later ordinary replies go through the outbox.
      call.history = hooks.history();
      for (;;) {
        const pending = releasePending(), closed = await pending;
        if (!inScope(call)) { if (owned(call)) await stop('The conversation changed before voice connected.'); return; }
        if (pending !== releasePending()) continue;
        if (!closed) { resetRelease(pending); throw Error('The previous voice call has not confirmed closure. Start again only after checking its state.'); }
        break;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!inScope(call)) { stream.getTracks().forEach(track => { track.stop(); }); if (owned(call)) await stop('The conversation changed while microphone permission was pending.'); return; }
      call.microphone = stream;
      const track = stream.getAudioTracks()[0];
      if (!track) throw Error('No microphone audio track is available.');
      track.onended = () => { if (owned(call)) void stop('The microphone disconnected. Start a new session after reconnecting it.', true); };
      const echoCancellation = track.getSettings().echoCancellation === true;
      emit({ echoCancellation, speakerSafe: state.speakerSafe || !echoCancellation });
      track.enabled = !state.muted && !state.playbackBlocked;
      call.sender = peer.addTrack(track, stream);
      await microphoneGate(call);
      if (!inScope(call)) { if (owned(call)) await stop('The conversation changed before voice connected.'); return; }
      peer.ontrack = event => {
        if (!inScope(call)) { if (owned(call)) void stop('The conversation changed before voice audio arrived.'); return; }
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]); void play(call);
      };
      peer.onconnectionstatechange = () => {
        if (!owned(call)) return;
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') void stop('Voice disconnected. Tasks already sent remain in chat.', true);
        else if (peer.connectionState === 'disconnected') {
          emit({ message: 'Voice connection interrupted…' });
          later(call, () => { if (peer.connectionState === 'disconnected') void stop('Voice connection did not recover. Start a new session.', true); }, 10_000);
        }
      };
      channel.onmessage = event => receive(call, event.data);
      channel.onerror = () => { if (owned(call)) void stop('Voice data channel failed.', true); };
      channel.onclose = () => { if (owned(call)) void stop('Voice session disconnected.', true); };
      channel.onopen = () => {
        if (!inScope(call)) { if (owned(call)) void stop('The conversation changed before voice connected.'); return; }
        call.ready = true;
        emit({ phase: 'listening', startedAt: Date.now(), message: state.playbackBlocked ? 'Enable voice audio to continue; microphone paused.' : state.muted ? 'Microphone muted · session connected' : 'Listening · speak naturally' });
        const queued = call.outbox.splice(0); call.queuedBytes = 0;
        for (const raw of queued) {
          if (!owned(call)) break;
          // These are application-built JSON frames, preserved byte-for-byte while connecting.
          if (!send(call, JSON.parse(raw) as Record<string, unknown>)) break;
        }
        updateDigest(call);
      };
      const offer = await peer.createOffer();
      if (!inScope(call)) { if (owned(call)) await stop('The conversation changed before voice connected.'); return; }
      await peer.setLocalDescription(offer);
      if (!inScope(call)) { if (owned(call)) await stop('The conversation changed before voice connected.'); return; }
      call.starting = signal(hooks.ward, 'start', { owner: call.owner, sdp: offer.sdp, mode: 'live', context: call.history });
      const reply = await call.starting;
      call.lease = reply.lease;
      if (!owned(call)) return; // stop() still harvests and closes a late receipt.
      if (!inScope(call)) { await stop('The conversation changed while voice was starting.'); return; }
      if (reply.mode !== 'live') throw Error('The voice-owning server does not support Live sessions yet. Update it before starting Live; manual dictation remains available.');
      if (!reply.lease || typeof reply.sdp !== 'string' || typeof reply.expiresAt !== 'number' || !Number.isFinite(reply.expiresAt)) throw Error('Voice returned an invalid session receipt.');
      expiry(call, reply.expiresAt);
      await peer.setRemoteDescription({ type: 'answer', sdp: reply.sdp });
      if (!inScope(call)) { if (owned(call)) await stop('The conversation changed while voice was connecting.'); return; }
      later(call, () => { void heartbeat(call); }, 15_000);
    } catch (error) {
      if (owned(call)) await stop(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Allow microphone access in System Settings, then start a session.' : error instanceof Error ? error.message : 'Live voice could not start.', true);
    }
  }

  function stop(message = 'Voice session ended.', failed = false): Promise<boolean> {
    if (!current) return closing ?? Promise.resolve(true);
    const call = current;
    call.closed = true; current = undefined;
    call.outbox.length = 0; call.queuedBytes = 0; call.history.length = 0;
    for (const timer of call.timers) clearTimeout(timer);
    call.timers.clear();
    call.microphone?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    call.audio.pause(); call.audio.srcObject = null; call.audio.remove();
    call.silence?.getTracks().forEach(track => { track.stop(); });
    call.silenceSource?.stop(); call.silenceSource?.disconnect();
    void call.silenceContext?.close().catch(() => {});
    if (call.channel.readyState === 'open') { try { call.channel.send(JSON.stringify({ type: 'session.close' })); } catch { /* Server control also closes it. */ } }
    call.channel.close(); call.peer.close();
    if (audioSession && call.previousAudioPurpose !== undefined && ownsAudio(identity)) { try { audioSession.type = call.previousAudioPurpose; } catch { /* Optional browser API. */ } }
    releaseOwner(identity);
    // Captions are deliberately not persisted, even on End or a lost connection.
    emit({ phase: 'ending', message: 'Closing voice session…', input: '', output: '', playbackBlocked: false, endedAt: Date.now() });
    const completion = chainRelease((async () => {
      try {
        if (call.starting) { const reply = await call.starting; call.lease = reply.lease; }
        if (!call.lease) return call.closedAck || !call.starting;
        const result = await signal(hooks.ward, 'stop', { owner: call.owner, lease: call.lease });
        return result.closed === true || call.closedAck;
      } catch { return call.closedAck; }
    })());
    closing = completion;
    void completion.then(closed => {
      if (closing !== completion) return;
      closing = undefined;
      emit({ phase: failed || !closed ? 'error' : 'idle', message: closed ? message : `${message} Audio stopped locally; provider closure is not confirmed. Its lease remains protected.`, muted: false });
    });
    return completion;
  }

  return {
    start, stop,
    dispose: identity.dispose,
    get active() { return !!current || !!closing; },
    get session() { return current?.owner; },
    get binding() { return current?.scope; },
    state: () => ({ ...state }),
    setMuted(muted: boolean) { if (!current) return; emit({ muted, message: muted ? 'Microphone muted · session connected' : 'Listening · speak naturally' }); void microphoneGate(current); },
    setSpeakerSafe(speakerSafe: boolean) { emit({ speakerSafe }); if (current) void microphoneGate(current); },
    resumeAudio() { if (current) void play(current); },
    refreshContext() { if (current) updateDigest(current); },
    /** The ordinary stream proves that a queued steer reached this exact Rime turn. */
    observeUser(text: string): string | undefined {
      if (!current || !inScope(current)) return;
      for (const [id, entry] of current.delegations) if (entry.text === text) return id;
    },
    /** Completed Rime messages, not raw tool output or a duplicate done payload. */
    backend(text: string, key: string, delegations: readonly string[] = []) {
      const call = current;
      if (!call || !inScope(call) || !text.trim() || call.replies.has(key)) return;
      if (call.replies.size >= 2000) { void stop('This voice session reached its context limit. Start another session to continue.', true); return; }
      call.replies.add(key);
      const id = [...delegations].reverse().find(value => call.delegations.has(value));
      // The most recently absorbed delegation owns a steered turn's one answer, as in Codex V3.
      // Do not repeat the result as a synthetic completion: V3 has no completion event.
      const excerpt = bounded(text, 16000);
      context(call, `[BACKEND] ${excerpt}${excerpt.length < text.length ? '\n[The remainder was omitted from voice context. The complete answer is on screen; do not infer an unseen ending.]' : ''}`, id);
    },
    needsOnScreenAction() {
      const call = current;
      if (!call || !inScope(call) || call.replies.has('pending-screen-action')) return;
      call.replies.add('pending-screen-action');
      context(call, '[BACKEND] Rime needs your confirmation or answer on screen. Voice cannot operate that control.', undefined, 'commentary');
      emit({ message: 'Rime needs your confirmation or answer on screen.' });
    },
    clearOnScreenAction() { current?.replies.delete('pending-screen-action'); },
  };
}

export type AgentLiveVoice = ReturnType<typeof createAgentLive>;
