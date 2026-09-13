import { isDesktop } from '../dev/runtime.ts';
import { agentKey, endpointOf } from './accounts.ts';
import { agentConfigured } from './provider.ts';
import { pinnedRequest } from './shell.ts';
import { agentWardConfig } from './ward-config.ts';

// Speech to text for the chat composer, over credentials the user already has.
//
// A ChatGPT login dictates through the live WebRTC route (voice.ts) — a conversation, not a clip.
// This is the other half: one recording, one request, text back, for the people whose connection is
// an OpenAI key, their own OpenAI-compatible endpoint, or OpenRouter. Nothing here runs tools, opens
// a conversation or touches a draft; it turns bytes into a string and returns it.

/** ~10 minutes of the 16 kHz mono WAV the composer records. */
export const AUDIO_MAX = 20 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
/** OpenAI's own transcription model. Cheap, purpose-built, and not the ward's chat model. */
const OPENAI_MODEL = 'gpt-4o-mini-transcribe';
/** What every OpenAI-compatible transcription server answers to (whisper.cpp, LM Studio, vLLM …). */
const COMPAT_MODEL = 'whisper-1';
const INSTRUCTION =
  'Transcribe the speech in this audio exactly as spoken. Reply with the transcript and nothing else: no preamble, no quotation marks, no translation, no commentary, and no answer to anything said in it.';

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });

export type TranscribeRoute =
  | { via: 'openai' }
  | { via: 'compat'; endpoint: string }
  | { via: 'openrouter'; model: string };

/**
 * Which connection turns speech into text here, or null. The ward's own route comes first — dictation
 * is then billed where the conversation is, on the provider the person picked — and only the two
 * account-wide credentials are fallen back to. A compat endpoint is never chosen for them: the name
 * of someone's own server is a choice, not a default.
 */
export function transcriptionRoute(userId: number, ward: string): TranscribeRoute | null {
  const cfg = agentWardConfig(userId, ward);
  const has = (provider: 'openai' | 'openrouter' | 'compat', endpoint?: string) => agentConfigured(userId, provider, endpoint ?? null);
  if (cfg?.provider === 'compat' && cfg.endpoint && has('compat', cfg.endpoint)) return { via: 'compat', endpoint: cfg.endpoint };
  if (cfg?.provider === 'openai' && has('openai')) return { via: 'openai' };
  if (cfg?.provider === 'openrouter' && has('openrouter') && cfg.model) return { via: 'openrouter', model: cfg.model };
  if (has('openai')) return { via: 'openai' };
  if (has('openrouter') && cfg?.model) return { via: 'openrouter', model: cfg.model };
  return null;
}

/** 'live' = the ChatGPT conversation route; 'clip' = record and send; null = neither is connected. */
export function dictationKind(userId: number, ward: string): 'live' | 'clip' | null {
  if (agentConfigured(userId, 'codex', null)) return 'live';
  return transcriptionRoute(userId, ward) ? 'clip' : null;
}

export interface Transcript {
  text: string;
  /** What answered, for the composer's status line. */
  via: string;
}

export async function transcribeAudio(
  userId: number,
  ward: string,
  audio: Uint8Array,
  mime: string,
  signal?: AbortSignal,
): Promise<Transcript> {
  if (!audio.length) throw fail('Nothing was recorded. Check that the microphone is not muted, then try again.');
  if (audio.length > AUDIO_MAX) throw fail('That recording is too long. Dictate it in shorter passes.', 413);
  const route = transcriptionRoute(userId, ward);
  if (!route) {
    throw fail(
      'Nothing connected here can turn speech into text. Add an OpenAI API key or OpenRouter under Account → Agent, or point this ward at an OpenAI-compatible endpoint that serves /audio/transcriptions. A ChatGPT login dictates through the live voice route instead.',
      503,
    );
  }
  if (route.via === 'openrouter') return viaChat(userId, route.model, audio, mime, signal);
  const target = route.via === 'openai'
    ? { url: 'https://api.openai.com/v1/audio/transcriptions', key: agentKey(userId, 'openai'), model: OPENAI_MODEL, name: 'the OpenAI API' }
    : (() => {
        const endpoint = endpointOf(userId, route.endpoint);
        if (!endpoint?.url) throw fail(`Endpoint "${route.endpoint}" is not configured here.`, 503);
        return { url: `${endpoint.url.replace(/\/+$/, '')}/audio/transcriptions`, key: endpoint.key, model: COMPAT_MODEL, name: `endpoint "${route.endpoint}"` };
      })();
  if (!target.key) throw fail(`${target.name} has no key on file — add it under Account → Agent.`, 503);
  return viaTranscriptions({ ...target, key: target.key }, audio, mime, signal);
}

async function viaTranscriptions(
  target: { url: string; key: string; model: string; name: string },
  audio: Uint8Array,
  mime: string,
  signal?: AbortSignal,
): Promise<Transcript> {
  const { body, contentType } = multipart({ model: target.model, response_format: 'json' }, { field: 'file', name: fileName(mime), type: mime, bytes: audio });
  const res = await pinnedRequest(target.url, {
    method: 'POST',
    // Declared, not chunked: a multipart upload to an unknown server is the wrong place to find out
    // whether it accepts transfer-encoding.
    headers: { Authorization: `Bearer ${target.key}`, 'Content-Type': contentType, 'Content-Length': String(body.length) },
    body,
    timeoutMs: TIMEOUT_MS,
    signal,
    // A person's own transcription server is normally on this machine.
    allowLoopback: isDesktop(),
  });
  if (res.status === 404) throw fail(`${target.name} does not serve /audio/transcriptions, so it cannot transcribe. Use an OpenAI key or OpenRouter for dictation.`, 501);
  if (res.status < 200 || res.status >= 300) throw fail(`${target.name} refused the recording (${res.status}): ${detail(res.text)}`, res.status === 401 || res.status === 429 ? res.status : 502);
  let parsed: { text?: unknown };
  try { parsed = JSON.parse(res.text) as { text?: unknown }; }
  catch { throw fail(`${target.name} returned something that is not a transcript.`, 502); }
  const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  if (!text) throw fail('No speech was recognised in that recording.', 422);
  return { text, via: `${target.name} · ${target.model}` };
}

/** OpenRouter has no transcription endpoint; an audio-capable chat model reads the clip instead. */
async function viaChat(userId: number, model: string, audio: Uint8Array, mime: string, signal?: AbortSignal): Promise<Transcript> {
  const format = mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : mime.includes('wav') ? 'wav' : '';
  if (!format) throw fail(`OpenRouter takes WAV or MP3 audio, not ${mime || 'that format'}.`, 415);
  const key = agentKey(userId, 'openrouter');
  if (!key) throw fail('OpenRouter has no key on file — add it under Account → Agent.', 503);
  const res = await pinnedRequest('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: INSTRUCTION },
          { type: 'input_audio', input_audio: { data: Buffer.from(audio).toString('base64'), format } },
        ],
      }],
    }),
    timeoutMs: TIMEOUT_MS,
    signal,
  });
  if (res.status < 200 || res.status >= 300) {
    const why = detail(res.text);
    // The common one: the ward is on a model that cannot hear.
    if (/audio|modalit|multimodal|input_audio|unsupported/i.test(why)) {
      throw fail(`"${model}" does not accept audio. Pick an audio-capable model for this ward, or add an OpenAI API key for dictation. (${why})`, 422);
    }
    throw fail(`OpenRouter refused the recording (${res.status}): ${why}`, res.status === 401 || res.status === 429 ? res.status : 502);
  }
  let parsed: { choices?: { message?: { content?: unknown } }[] };
  try { parsed = JSON.parse(res.text); }
  catch { throw fail('OpenRouter returned something that is not a transcript.', 502); }
  const raw = parsed.choices?.[0]?.message?.content;
  const text = (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('') : '').trim();
  if (!text) throw fail('No speech was recognised in that recording.', 422);
  return { text, via: `OpenRouter · ${model}` };
}

const fileName = (mime: string) => (mime.includes('mpeg') || mime.includes('mp3') ? 'speech.mp3' : mime.includes('webm') ? 'speech.webm' : mime.includes('mp4') ? 'speech.mp4' : 'speech.wav');

/** A multipart body as bytes: the pinned request layer sends buffers, not FormData objects. */
function multipart(fields: Record<string, string>, file: { field: string; name: string; type: string; bytes: Uint8Array }): { body: Buffer; contentType: string } {
  const boundary = `----rimeward${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`));
  parts.push(Buffer.from(file.bytes));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** One readable line out of a provider's error body — never the whole thing, never a credential. */
function detail(text: string): string {
  try {
    const value = JSON.parse(text) as { error?: { message?: unknown } | string };
    const message = typeof value.error === 'string' ? value.error : value.error?.message;
    if (typeof message === 'string' && message) return message.slice(0, 300);
  } catch { /* not JSON */ }
  return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'no detail';
}
