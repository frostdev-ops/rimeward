import type { Page, Request, Response } from 'playwright-core';
import type { Session } from './session.ts';

// The developer tools of a browser ward: what the page logged, what it fetched, and the bytes of
// what it fetched. Recorded per SESSION (all its tabs, the human's browsing included — the ward is
// one shared Chromium), so the agent can answer "why is this page broken" from the same evidence a
// person would open DevTools for, without re-running anything.
//
// Metadata only, in fixed ring buffers. Response bodies stay where they already are — inside
// Chromium — and are read on demand; only the most recent handles are kept, because Playwright
// discards a body once its page navigates away, and holding thousands would pin memory in the
// browser for a question nobody asked.

const KEEP = 400;
/** Response handles kept for body reads. Small: a handle is cheap, the body behind it is not. */
const KEEP_BODIES = 60;
const TEXT_CAP = 40_000;
const LINE_CAP = 2000;

export interface ConsoleLine {
  at: number;
  /** log · debug · info · warning · error · trace … as Chromium reports it, plus `pageerror`. */
  level: string;
  text: string;
  /** The page it came from — a ward can have several tabs open. */
  page: string;
  /** Where in the source, when the browser said. */
  at_source?: string;
}
export interface NetLine {
  id: number;
  at: number;
  method: string;
  url: string;
  /** document · stylesheet · script · image · xhr · fetch … */
  type: string;
  status?: number;
  ms?: number;
  /** Content-Length when the server declared one; a chunked response has none until it is read. */
  bytes?: number;
  /** Set when the request never completed; the browser's own reason. */
  error?: string;
  /** True once its body can still be read straight from the browser. */
  body?: boolean;
}
interface Log {
  console: ConsoleLine[];
  net: NetLine[];
  seq: number;
  /** id → the response, newest last; trimmed to KEEP_BODIES. */
  bodies: Map<number, { response: Response; page: Page }>;
}

const logs = new WeakMap<Session, Log>();
const entries = new WeakMap<Request, NetLine>();
function logOf(s: Session): Log {
  let log = logs.get(s);
  if (!log) logs.set(s, (log = { console: [], net: [], seq: 0, bodies: new Map() }));
  return log;
}
function keep<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
}

/** Attach to one tab. Called from watchPage, so every tab a ward opens is covered, whoever opened it. */
export function watchDevtools(s: Session, p: Page): void {
  const log = logOf(s);
  p.on('console', (m) => {
    const where = m.location();
    keep(log.console, {
      at: Date.now(), level: m.type(), text: m.text().slice(0, LINE_CAP), page: p.url(),
      ...(where?.url ? { at_source: `${where.url}:${where.lineNumber ?? 0}` } : {}),
    });
  });
  // An uncaught exception is not a console message in Playwright, and it is usually the one that matters.
  p.on('pageerror', (e) => {
    keep(log.console, { at: Date.now(), level: 'pageerror', text: String(e.message ?? e).slice(0, LINE_CAP), page: p.url() });
  });
  p.on('request', (r) => {
    const line: NetLine = { id: ++log.seq, at: Date.now(), method: r.method(), url: r.url().slice(0, LINE_CAP), type: r.resourceType() };
    entries.set(r, line);
    keep(log.net, line);
  });
  p.on('response', (r) => {
    const line = entries.get(r.request());
    if (!line) return;
    line.status = r.status();
    line.body = true;
    // From the header, never response.sizes(): that is a CDP round trip per request, and the human
    // is browsing through this same session.
    const declared = Number(r.headers()['content-length']);
    if (Number.isFinite(declared) && declared >= 0) line.bytes = declared;
    log.bodies.set(line.id, { response: r, page: p });
    for (const id of log.bodies.keys()) {
      if (log.bodies.size <= KEEP_BODIES) break;
      log.bodies.delete(id);
      const dropped = log.net.find((n) => n.id === id);
      if (dropped) dropped.body = false;
    }
  });
  p.on('requestfinished', (r) => {
    const line = entries.get(r);
    if (line) line.ms = Date.now() - line.at;
  });
  p.on('requestfailed', (r) => {
    const line = entries.get(r);
    if (!line) return;
    line.ms = Date.now() - line.at;
    line.error = r.failure()?.errorText ?? 'request failed';
    line.body = false;
  });
}

const matches = (value: string, pattern?: string) => {
  if (!pattern) return true;
  try { return new RegExp(pattern, 'i').test(value); } catch { return value.toLowerCase().includes(pattern.toLowerCase()); }
};

export function consoleLines(s: Session, opts: { level?: string; pattern?: string; limit?: number }): { messages: ConsoleLine[]; total: number; kept: number } {
  const log = logOf(s);
  const level = opts.level?.trim().toLowerCase();
  // "error" means the two things a person means by it.
  const wanted = level === 'error' ? ['error', 'pageerror'] : level && level !== 'all' ? [level] : null;
  const all = log.console.filter((m) => (!wanted || wanted.includes(m.level)) && matches(m.text, opts.pattern));
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200);
  return { messages: all.slice(-limit), total: all.length, kept: KEEP };
}

export function networkLines(s: Session, opts: { pattern?: string; status?: string; type?: string; limit?: number }): { requests: NetLine[]; total: number; kept: number } {
  const log = logOf(s);
  const status = opts.status?.trim();
  const type = opts.type?.trim().toLowerCase();
  const all = log.net.filter((r) => {
    if (!matches(r.url, opts.pattern)) return false;
    if (type && r.type !== type) return false;
    if (!status) return true;
    if (status === 'failed') return !!r.error || (r.status ?? 0) >= 400;
    if (/^\dxx$/.test(status)) return String(r.status ?? '').startsWith(status[0]!);
    return String(r.status ?? '') === status;
  });
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200);
  return { requests: all.slice(-limit), total: all.length, kept: KEEP };
}

const decodable = (type: string) =>
  /^(text\/|application\/(json|xml|javascript|x-javascript|ecmascript|graphql)|application\/[\w.+-]*\+(json|xml))/i.test(type) || !type;

/**
 * The bytes of one thing the page loaded. Straight out of the browser when it still holds them —
 * that is a response the page really received, including one no second request could reproduce (a
 * POST result, a one-time URL, a page behind a form). Otherwise it is requested again through the
 * ward's own session, which carries its cookies and proxy but not its stored copy: a fresh request
 * that can answer differently, or not at all. The answer says which of the two it was, and a failed
 * re-read reports its own status rather than passing an error page off as the asset.
 */
export async function readAsset(s: Session, ref: { id?: number; url?: string }): Promise<Record<string, unknown>> {
  const log = logOf(s);
  const line = ref.id
    ? log.net.find((n) => n.id === ref.id)
    : [...log.net].reverse().find((n) => n.url === ref.url) ?? [...log.net].reverse().find((n) => matches(n.url, ref.url));
  if (!line && !ref.url) throw new Error('No such request in this ward\'s network log — browser_network lists what it has.');
  const held = line ? log.bodies.get(line.id) : undefined;
  const url = line?.url ?? String(ref.url);
  if (held && !held.page.isClosed()) {
    try {
      const buffer = await held.response.body();
      const type = (held.response.headers()['content-type'] ?? '').split(';')[0]!.trim();
      return { ...shape(url, held.response.status(), type, buffer), source: 'browser cache' };
    } catch {
      // Chromium drops a body when its page navigates; fall through and ask for it again.
    }
  }
  if (!/^https?:\/\//i.test(url)) throw new Error(`Its body is no longer in the browser and ${url} cannot be re-read.`);
  const again = await s.page.request.get(url, { timeout: 15_000, failOnStatusCode: false });
  const type = (again.headers()['content-type'] ?? '').split(';')[0]!.trim();
  const body = await again.body();
  const source = 're-read through this ward (its cookies and proxy; a fresh request, not the copy the page received)';
  // The re-read can fail where the original did not — the host is gone, the URL was one-time, the
  // proxy refused it. That is not the asset, and it is not reported as one.
  if (again.status() >= 400) return { url, status: again.status(), type, bytes: body.length, source, failed: `The browser no longer holds this response and requesting it again answered ${again.status()}.`, ...(body.length ? { answer: body.toString('utf8').slice(0, 2000) } : {}) };
  return { ...shape(url, again.status(), type, body), source };
}

function shape(url: string, status: number, type: string, buffer: Buffer): Record<string, unknown> {
  const bytes = buffer.length;
  if (!decodable(type)) return { url, status, type, bytes, note: `Binary content (${type || 'unknown type'}); its bytes are not text. Open it in the ward, or download it with browser_download.` };
  const text = buffer.toString('utf8');
  return { url, status, type, bytes, body: text.slice(0, TEXT_CAP), ...(text.length > TEXT_CAP ? { truncated: `cut at ${TEXT_CAP} characters of ${text.length}` } : {}) };
}
