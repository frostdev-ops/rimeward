/** Public profile identities are also the vector compatibility boundary. Never use Codex sign-in for embeddings. */
export const QWEN_REVISION = '69d0e58a13e463cd99a9b83e3f5fee7c10265fab';
export const QUERY_INSTRUCTION = 'Given a web search query, retrieve relevant passages that answer the query';
export const LOCAL_MODELS = {
  Q4_K_M: { file: 'Qwen3-Embedding-8B-Q4_K_M.gguf', bytes: 4676804928, sha256: '3fcd3febec8b3fd64435204db75bf0dd73b91e8d0661e0331acfe7e7c3120b85', memoryGB: 7 },
  Q8_0: { file: 'Qwen3-Embedding-8B-Q8_0.gguf', bytes: 8047105824, sha256: 'd20ddc71e8a5c4344f2343481e242233a997dc5eaff442427a945836c97b4deb', memoryGB: 11 },
} as const;
export type Quantization = keyof typeof LOCAL_MODELS;
export interface EmbeddingConfig {
  provider: 'local' | 'device' | 'openai' | 'openrouter';
  quantization: Quantization;
  model: string;
  device?: string;
  sharing: boolean;
}
export interface EmbeddingProfile { id: string; model: string; dimensions: number; qwen: boolean; quantization?: Quantization }
export const DEFAULT_EMBEDDING: EmbeddingConfig = { provider: 'local', quantization: 'Q4_K_M', model: 'Qwen3-Embedding-8B', sharing: false };
export function parseEmbeddingConfig(raw: unknown): EmbeddingConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid embedding settings.');
  const r = raw as Record<string, unknown>;
  if (!['local','device','openai','openrouter'].includes(String(r.provider))) throw Error('Choose an embedding provider.');
  const provider = r.provider as EmbeddingConfig['provider'];
  const quantization = r.quantization ?? 'Q4_K_M';
  if (quantization !== 'Q4_K_M' && quantization !== 'Q8_0') throw Error('Choose Q4_K_M or Q8_0.');
  const model = provider === 'openai' ? String(r.model || 'text-embedding-3-small') : provider === 'openrouter' ? 'qwen/qwen3-embedding-8b' : 'Qwen3-Embedding-8B';
  if (provider === 'openai' && !['text-embedding-3-small','text-embedding-3-large'].includes(model)) throw Error('Unsupported OpenAI embedding model.');
  if (provider === 'device' && (typeof r.device !== 'string' || !/^[a-f0-9-]{36}$/i.test(r.device))) throw Error('Select a paired desktop.');
  return { provider, quantization, model, ...(provider === 'device' ? { device: String(r.device) } : {}), sharing: r.sharing === true };
}
export function embeddingProfile(c: EmbeddingConfig): EmbeddingProfile {
  const qwen = c.provider !== 'openai';
  const local = c.provider === 'local' || c.provider === 'device';
  const dimensions = qwen ? 4096 : c.model === 'text-embedding-3-large' ? 3072 : 1536;
  return { id: [c.model,local ? `${QWEN_REVISION}:${c.quantization}` : c.provider,dimensions,qwen ? `last:l2:instruct-v1:${QUERY_INSTRUCTION}` : 'l2:raw-v1'].join('|'),
    model:c.model, dimensions,qwen,...(local ? { quantization:c.quantization } : {}) };
}
export function encodeEmbeddingInputs(profile: EmbeddingProfile, input: string[], query: boolean): string[] {
  if (!Array.isArray(input) || !input.length || input.length > 8 || input.some(s => typeof s !== 'string' || !s.trim() || Buffer.byteLength(s) > 16000)) throw Error('Embeddings require 1–8 nonempty texts, at most 16 KB each.');
  return input.map(s => query && profile.qwen ? `Instruct: ${QUERY_INSTRUCTION}\nQuery: ${s}` : s);
}
export function normalizeEmbeddings(raw: unknown, count: number, dimensions: number): number[][] {
  if (!Array.isArray(raw) || raw.length !== count) throw Error('Embedding response count mismatch.');
  return raw.map(v => {
    if (!Array.isArray(v) || v.length !== dimensions || v.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw Error('Embedding dimensions or values are invalid.');
    const norm = Math.hypot(...v);
    if (!Number.isFinite(norm) || norm === 0) throw Error('Embedding has no finite magnitude.');
    return v.map(x => x/norm);
  });
}
