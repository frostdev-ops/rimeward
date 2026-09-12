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

export async function readSse(body: ReadableStream<Uint8Array>, receive: (data: string) => void, progress?: () => void): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder(), parser = sseParser(receive);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      progress?.();
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode()); parser.finish();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
