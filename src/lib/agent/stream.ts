export interface ThinkingProgress { tokens?: number; estimated?: boolean; detailDelta?: string }

/** Count only plain reasoning deltas, never encrypted payloads or summary text. */
export function thinkingCounter(receive?: (progress: ThinkingProgress) => void) {
  let bytes = 0;
  return {
    text(delta: string, expose = false) {
      if (!delta) return;
      // ponytail: four UTF-8 bytes/token; replace with provider counts whenever available.
      bytes += new TextEncoder().encode(delta).length;
      receive?.({ tokens: Math.ceil(bytes / 4), estimated: true, ...(expose ? { detailDelta: delta } : {}) });
    },
    usage(tokens: unknown) {
      if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0)
        receive?.({ tokens, estimated: false });
    },
  };
}

/** Incremental SSE framing shared by provider, relay and browser streams. */
export function sseParser(receive: (data: string) => void) {
  let buffer = '', data: string[] = [];
  const line = (value: string) => {
    if (!value) {
      if (data.length) { const payload = data.join('\n'); data = []; receive(payload); }
    } else if (value === 'data' || value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  const push = (text: string) => {
    buffer += text;
    for (;;) {
      const end = /\r\n|\n|\r(?!$)/.exec(buffer);
      if (!end) break;
      const value = buffer.slice(0, end.index);
      buffer = buffer.slice(end.index + end[0].length);
      line(value);
    }
    if (buffer.length > 16_000_000) throw Error('Stream frame is too large.');
  };
  return { push, finish() { push('\n\n'); } };
}

export async function readSse(body: ReadableStream<Uint8Array>, receive: (data: string) => void, progress?: () => void, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const reader = body.getReader(), decoder = new TextDecoder(), parser = sseParser(receive);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      progress?.();
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode()); parser.finish();
  } catch (error) {
    // A broken transport may never settle cancellation; do not hold the caller's error behind it.
    cancel();
    throw error;
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
}
