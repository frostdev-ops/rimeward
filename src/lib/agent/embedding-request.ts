export async function boundedEmbeddingBody(request:Request): Promise<Record<string,any>> {
  const reader = request.body?.getReader(); if (!reader) throw Error('Missing inference request.');
  const chunks:Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.byteLength;
      if (size > 140000) throw Error('Inference input exceeds 140 KB.'); chunks.push(r.value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Invalid inference request.');
  return body;
}
