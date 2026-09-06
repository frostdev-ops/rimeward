import { randomUUID } from 'node:crypto';
import { getSetting, setSetting } from '../settings.ts';

export function modelFailure(user: number, error: unknown, requestId: string = randomUUID(), aborted = false) {
  const e = error as { status?: number; name?: string; category?: string; cause?: { name?: string; statusCode?: number } };
  const code = e?.status ?? e?.cause?.statusCode;
  const status = typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599 ? code : undefined;
  const category = aborted ? 'cancelled' : e?.category && ['cancelled', 'timeout', 'provider-unavailable', 'request-rejected', 'invalid-response', 'connection-lost'].includes(e.category) ? e.category : [e?.name, e?.cause?.name].some(name => name === 'TimeoutError' || name === 'RequestTimeoutError') ? 'timeout' :
    status ? (status >= 500 ? 'provider-unavailable' : 'request-rejected') :
    e?.name === 'SyntaxError' ? 'invalid-response' : 'connection-lost';
  const record = { requestId, category, status, at: new Date().toISOString() };
  // Metadata only, bounded per account; no prompts, response bodies or credentials.
  const key = `agent_diagnostics:${user}`;
  try {
    const previous = JSON.parse(getSetting(key) ?? '[]');
    setSetting(key, JSON.stringify([...(Array.isArray(previous) ? previous.slice(-99) : []), record]));
  } catch { /* A diagnostic write must not replace the original failure. */ }
  return Object.assign(new Error(`Model request ${category}${status ? ` (HTTP ${status})` : ''}. Reference ${requestId}. No uncertain inference request was automatically replayed.`), record);
}
