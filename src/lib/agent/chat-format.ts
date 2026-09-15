// The shared-history CHAT record format, versioned the way note records are (notebook-pages.ts):
// a peer advertises the format it understands and each side holds back records the other cannot
// take, so a newer runtime never sends an old peer a record it would reject, and local History never
// depends on the peer. Format 1 carried codex/openrouter conversations only; format 2 carries every
// configured provider (openai, compat with its endpoint name and base URL) and the model a thread ran on.
// Pure: no db, ships nowhere but the server and desktop runtimes.

// Format 3 carries a compat backend recorded as a CONNECTED SERVER's (`server:<profile>:<url>`, see
// agent/route.ts). A format-2 reader would read that string as an ordinary base URL - it would refuse
// every continuation rather than mis-serve one, but refusing is not understanding, so such records
// are held back and the peer is told to update, exactly as note formats are.
export const CHAT_FORMAT = 4;
export const CHAT_FORMAT_HEADER = 'x-rime-chat-format';
/** Providers a format-1 peer accepts in a chat record. */
const FORMAT_1_PROVIDERS = new Set(['codex', 'openrouter']);
/** A backend recorded as a connected server's, which only a format-3 reader can interpret. */
const REMOTE_BACKEND_PREFIX = 'server:';

/** True when this chat record needs a NEWER format than a legacy peer's — a provider format 1 refuses,
 *  or a connected-server backend only format 3 can interpret. The
 *  optional `model` and `endpointUrl` fields ride format 1 too: old validation ignores unknown fields
 *  and stores the payload verbatim. */
export function chatRecordNeedsFormat(record?: { key?: unknown; payload?: unknown } | null): boolean {
  if (!record || typeof record.key !== 'string' || !record.key.startsWith('chat/') || typeof record.payload !== 'string' || record.payload === 'null') return false;
  try {
    const chat = JSON.parse(record.payload) as { provider?: unknown; endpointUrl?: unknown } | null;
    if (!chat || typeof chat !== 'object') return false;
    if (typeof chat.endpointUrl === 'string' && chat.endpointUrl.startsWith(REMOTE_BACKEND_PREFIX)) return true;
    return !FORMAT_1_PROVIDERS.has(String(chat.provider));
  } catch {
    return false;
  }
}

/** What a peer says it understands, read conservatively: a missing, malformed, non-finite,
 *  fractional or negative value is a LEGACY peer (format 1). `Number('garbage') < 2` is false, which
 *  would have made a garbled header look like a new peer and sent it records it cannot take. */
export function peerFormat(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
