// @ts-check
import { setTimeout } from 'node:timers/promises';

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
]);

/** @param {unknown} error */
function retryable(error) {
  if (!(error instanceof Error)) return false;
  const code = /** @type {NodeJS.ErrnoException} */ (error).code
    ?? /** @type {NodeJS.ErrnoException | undefined} */ (error.cause)?.code;
  return code ? RETRY_CODES.has(code)
    : error instanceof TypeError && ['fetch failed', 'terminated'].includes(error.message);
}

/**
 * Astro's binary font fetcher has no retry, unlike its Google metadata provider.
 * Keep the native Response (and the original request) intact for Astro's cache.
 * @param {typeof fetch} original
 * @returns {typeof fetch}
 */
export function retryFontFetch(original) {
  return async (input, init) => {
    let url;
    try { url = new URL(input instanceof Request ? input.url : input); }
    catch { return original(input, init); }
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.protocol !== 'https:' || url.hostname !== 'fonts.gstatic.com' || url.port
      || method.toUpperCase() !== 'GET') return original(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const response = await original(input, init);
        signal?.throwIfAborted();
        if (response.ok) {
          // A fetch can resolve before the binary body fails. Validate a clone
          // so callers still receive the native URL, headers and unread body.
          await response.clone().arrayBuffer();
          signal?.throwIfAborted();
          return response;
        }
        if (!RETRY_STATUSES.has(response.status) || attempt === 2) return response;
        await response.body?.cancel();
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt === 2 || !retryable(error)) throw error;
      }
      try { await setTimeout(250 * (attempt + 1), undefined, { signal }); }
      catch (error) { signal?.throwIfAborted(); throw error; }
    }
  };
}

/** @returns {import('vite').Plugin} */
export function fontFetchRetry() {
  /** @type {typeof fetch | undefined} */
  let original;
  /** @type {typeof fetch | undefined} */
  let wrapped;
  function restore() {
    if (globalThis.fetch === wrapped && original) globalThis.fetch = original;
    original = wrapped = undefined;
  }
  return {
    name: 'rimeward-font-fetch-retry',
    apply: 'build',
    buildStart: {
      order: 'pre', sequential: true,
      handler() {
        if (wrapped) return;
        original = globalThis.fetch;
        wrapped = retryFontFetch(original);
        globalThis.fetch = wrapped;
      },
    },
    buildEnd: { order: 'post', sequential: true, handler: restore },
    closeBundle: restore,
  };
}
