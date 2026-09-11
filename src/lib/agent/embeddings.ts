import { getSetting, setSetting } from '../settings.ts';
import { agentKey } from './accounts.ts';
import { DEFAULT_EMBEDDING, embeddingProfile, parseEmbeddingConfig, encodeEmbeddingInputs, normalizeEmbeddings, type EmbeddingConfig } from './embedding-profiles.ts';
import { localEmbed } from './embedding-local.ts';
import { isDesktop } from '../dev/runtime.ts';
import { instanceRequest, rimeConnection } from '../dev/remote.ts';
import { relayRequest } from '../dev/devices.ts';

const timings = new Map<string,{ profile:string; provider:string; device?:string; queryMs:number; measuredAt:string }>();
const timingKey = (user:number,config:EmbeddingConfig) => `${user}|${config.provider}|${config.device ?? ''}|${embeddingProfile(config).id}`;
export function embeddingTiming(user:number) { return timings.get(timingKey(user,embeddingConfig(user))) ?? null; }

export function embeddingConfig(user: number): EmbeddingConfig {
  try { return parseEmbeddingConfig(JSON.parse(getSetting(`embedding:${user}`) ?? 'null')); } catch { return { ...DEFAULT_EMBEDDING }; }
}
export function saveEmbeddingConfig(user: number, raw: unknown): EmbeddingConfig {
  const config = parseEmbeddingConfig(raw); setSetting(`embedding:${user}`,JSON.stringify(config)); return config;
}
export async function embed(user: number, input: string[], query = false, signal?: AbortSignal, config = embeddingConfig(user)): Promise<number[][]> {
  const started = performance.now();
  const vectors = await embedInputs(user,input,query,signal,config);
  if (query) timings.set(timingKey(user,config),{ profile:embeddingProfile(config).id,provider:config.provider,...(config.device ? { device:config.device } : {}),
    queryMs:Math.round(performance.now()-started),measuredAt:new Date().toISOString() });
  return vectors;
}
async function embedInputs(user: number, input: string[], query: boolean, signal: AbortSignal | undefined, config:EmbeddingConfig): Promise<number[][]> {
  const profile = embeddingProfile(config), encoded = encodeEmbeddingInputs(profile,input,query);
  let raw: unknown;
  if (config.provider === 'local') raw = await localEmbed(config.quantization,encoded,signal,query);
  else if (config.provider === 'device') {
    const endpoint = '/api/dev/embeddings';
    const request = new Request(`https://rimeward.invalid${endpoint}`,{ method:'POST',headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ input,query,profile:profile.id,quantization:config.quantization }),signal:AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(120000)]) });
    const pair = isDesktop() ? await rimeConnection(user) : null;
    if (pair?.id === config.device) throw Error('Choose this desktop as the local inference provider.');
    const response = isDesktop() ? await instanceRequest(user,`/runtime/${config.device}${endpoint}`,request) : await relayRequest(user,config.device!,endpoint,request);
    if (!response.ok) throw Error(`Selected embedding desktop is unavailable or not sharing (${response.status}).`);
    const body = await response.json(); if (body.profile !== profile.id) throw Error('Selected desktop embedding profile changed.');
    raw = body.vectors;
  } else {
    const key = agentKey(user,config.provider);
    if (!key && isDesktop() && await rimeConnection(user)) {
      const endpoint = '/api/agent/embeddings';
      const response = await instanceRequest(user,endpoint,new Request(`https://rimeward.invalid${endpoint}`,{ method:'POST',headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ input,query,config }),signal:AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(30000)]) }));
      if (!response.ok) throw Error(`Paired server cloud embeddings failed (${response.status}).`);
      const body = await response.json(); if (body.profile !== profile.id) throw Error('Cloud embedding profile mismatch.');
      return normalizeEmbeddings(body.vectors,input.length,profile.dimensions);
    }
    if (!key) throw Error(`${config.provider === 'openai' ? 'OpenAI API' : 'OpenRouter'} embedding key is not configured on this runtime.`);
    const endpoint = config.provider === 'openai' ? 'https://api.openai.com/v1/embeddings' : 'https://openrouter.ai/api/v1/embeddings';
    const response = await fetch(endpoint,{ method:'POST',redirect:'error',headers:{ authorization:`Bearer ${key}`,'content-type':'application/json' },
      body:JSON.stringify({ model:config.model,input:encoded,encoding_format:'float' }),signal:AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(30000)]) });
    if (!response.ok) throw Error(`${config.provider} embeddings failed (${response.status}).`);
    const body = await response.json(); raw = body.data?.sort((a: { index:number },b: { index:number }) => a.index-b.index).map((v: { embedding:unknown }) => v.embedding);
  }
  return normalizeEmbeddings(raw,input.length,profile.dimensions);
}
