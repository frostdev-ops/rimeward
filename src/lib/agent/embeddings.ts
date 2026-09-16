import { getSetting, setSetting } from '../settings.ts';
import { agentKey } from './accounts.ts';
import { DEFAULT_EMBEDDING, DEVICE_ID_RE, embeddingProfile, parseEmbeddingConfig, encodeEmbeddingInputs, normalizeEmbeddings, type EmbeddingConfig, type EmbeddingProfile } from './embedding-profiles.ts';
import { embeddingBinary, localEmbed } from './embedding-local.ts';
import { isDesktop } from '../dev/runtime.ts';
import { instanceRequest, rimeConnection } from '../dev/remote.ts';
import { listDevices, relayRequest } from '../dev/devices.ts';

const timings = new Map<number,{ profile:string; provider:string; runtime:string; queryMs:number; measuredAt:string }>();
/** The last query embedding's timing and the runtime that answered it. */
export function embeddingTiming(user:number) { return timings.get(user) ?? null; }

export function embeddingConfig(user: number): EmbeddingConfig {
  const saved = getSetting(`embedding:${user}`);
  // Before priorities are saved, a server may borrow its owner's shared desktops.
  // Explicit selections (including local-only) keep their meaning; sharing is checked by the host.
  if (!saved && !isDesktop()) return { ...DEFAULT_EMBEDDING,runtimes:['local',...listDevices(user).slice(0,7).map(d => d.id)] };
  try { return parseEmbeddingConfig(JSON.parse(saved ?? 'null')); } catch { return { ...DEFAULT_EMBEDDING, runtimes:[...DEFAULT_EMBEDDING.runtimes] }; }
}
export function saveEmbeddingConfig(user: number, raw: unknown): EmbeddingConfig {
  const config = parseEmbeddingConfig(raw); setSetting(`embedding:${user}`,JSON.stringify(config)); return config;
}
export async function embed(user: number, input: string[], query = false, signal?: AbortSignal, config = embeddingConfig(user)): Promise<number[][]> {
  const started = performance.now();
  const { vectors, runtime } = await embedInputs(user,input,query,signal,config);
  if (query) timings.set(user,{ profile:embeddingProfile(config).id,provider:config.provider,runtime,queryMs:Math.round(performance.now()-started),measuredAt:new Date().toISOString() });
  return vectors;
}

// ------------------------------------------------------------ local runtimes
//
// `local` tries the configured runtimes in order and the first that answers wins,
// so a laptop closing simply hands over to the next computer with the same model
// variant. A runtime that failed is skipped for a short while instead of costing
// every query a timeout; an offline desktop costs nothing (its presence is known).

const HOLD_MS = 30_000; // ponytail: one flat hold; per-error backoff if churn ever shows
const held = new Map<string,{ until:number; reason:string }>();
type Presence = { id:string; name:string; online:boolean };
const presence = new Map<number,{ at:number; devices:Presence[] }>();
/** Paired desktops with their online flag: the server knows; a desktop asks its server (cached 10 s). */
async function pairedDevices(user:number): Promise<Presence[]> {
  if (!isDesktop()) return listDevices(user).map(d => ({ id:d.id,name:d.name,online:d.online }));
  const cached = presence.get(user);
  if (cached && Date.now()-cached.at < 10_000) return cached.devices;
  const { agentDevices } = await import('../dev/tool-routing.ts');
  const devices = (await agentDevices(user)).devices.filter(d => d.id !== 'local').map(d => ({ id:d.id,name:d.name,online:d.online }));
  presence.set(user,{ at:Date.now(),devices }); return devices;
}
export const runtimeLabel = (id:string, devices:Presence[] = []) =>
  id === 'local' ? (isDesktop() ? 'this desktop' : 'this server') : id === 'server' ? 'the paired server' : devices.find(d => d.id === id)?.name ?? 'an unpaired desktop';

async function viaRuntimes(user:number, input:string[], query:boolean, signal:AbortSignal | undefined, config:EmbeddingConfig, profile:EmbeddingProfile, encoded:string[]): Promise<{ vectors:number[][]; runtime:string }> {
  // On the server, "the paired server" is this runtime.
  const runtimes = [...new Set(config.runtimes.map(id => !isDesktop() && id === 'server' ? 'local' : id))];
  if (!runtimes.length) throw Error(`No embedding runtime is chosen. Under Account → Agent → Semantic retrieval, add ${isDesktop() ? 'this desktop, the paired server' : 'this server'} or a paired desktop, or choose OpenAI or OpenRouter.`);
  const devices = runtimes.some(id => DEVICE_ID_RE.test(id)) ? await pairedDevices(user).catch(() => [] as Presence[]) : [];
  const pair = isDesktop() ? await rimeConnection(user).catch(() => undefined) : undefined;
  const tried:string[] = [];
  const timeout = (ms:number) => AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(ms)]);
  for (const id of runtimes) {
    const key = `${user}:${id}`, hold = held.get(key);
    if (hold && hold.until > Date.now()) { tried.push(`${runtimeLabel(id,devices)}: ${hold.reason}`); continue; }
    try {
      let raw:unknown;
      if (id === 'local') {
        if (!embeddingBinary()) { tried.push(`${runtimeLabel(id)}: no model set up`); continue; }
        raw = await localEmbed(config.quantization,encoded,signal,query);
      } else if (id === 'server') {
        if (!pair) { tried.push('the paired server: not connected'); continue; }
        // The server embeds with its own model only; it never fans out to desktops on our behalf.
        const endpoint = '/api/agent/embeddings';
        const response = await instanceRequest(user,endpoint,new Request(`https://rimeward.invalid${endpoint}`,{ method:'POST',headers:{ 'content-type':'application/json' },
          body:JSON.stringify({ input,query,config:{ ...config,runtimes:['local'],sharing:false } }),signal:timeout(120_000) }));
        if (!response.ok) throw Error(await failureText(response));
        const body = await response.json(); if (body.profile !== profile.id) throw Error('serves a different model variant');
        raw = body.vectors;
      } else {
        const device = devices.find(d => d.id === id);
        if (device && !device.online) { tried.push(`${device.name}: offline`); continue; }
        if (pair?.id === id) { tried.push(`${runtimeLabel(id,devices)}: is this desktop`); continue; }
        const endpoint = '/api/dev/embeddings';
        const request = new Request(`https://rimeward.invalid${endpoint}`,{ method:'POST',headers:{ 'content-type':'application/json' },
          body:JSON.stringify({ input,query,profile:profile.id,quantization:config.quantization }),signal:timeout(120_000) });
        const response = isDesktop() ? await instanceRequest(user,`/runtime/${id}${endpoint}`,request) : await relayRequest(user,id,endpoint,request);
        if (!response.ok) throw Error(await failureText(response));
        const body = await response.json(); if (body.profile !== profile.id) throw Error('shares a different model variant');
        raw = body.vectors;
      }
      held.delete(key);
      return { vectors:normalizeEmbeddings(raw,input.length,profile.dimensions),runtime:id };
    } catch (e) {
      if (signal?.aborted) throw e;
      const reason = e instanceof Error ? e.message : String(e);
      held.set(key,{ until:Date.now()+HOLD_MS,reason });
      tried.push(`${runtimeLabel(id,devices)}: ${reason}`);
    }
  }
  throw Error(`No embedding runtime answered (${tried.join('; ')}). Keyword search continues.`);
}
async function failureText(response:Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?:unknown } | null;
  return typeof body?.error === 'string' ? body.error : `unavailable (${response.status})`;
}
/** Which runtime a `local` config would use right now, for status displays; never runs inference. */
export async function runtimeHolds(user:number): Promise<Record<string,string>> {
  const out:Record<string,string> = {};
  for (const [key,hold] of held) if (key.startsWith(`${user}:`) && hold.until > Date.now()) out[key.slice(String(user).length+1)] = hold.reason;
  return out;
}

async function embedInputs(user: number, input: string[], query: boolean, signal: AbortSignal | undefined, config:EmbeddingConfig): Promise<{ vectors:number[][]; runtime:string }> {
  const profile = embeddingProfile(config), encoded = encodeEmbeddingInputs(profile,input,query);
  if (config.provider === 'local') return viaRuntimes(user,input,query,signal,config,profile,encoded);
  const key = agentKey(user,config.provider);
  if (!key && isDesktop() && await rimeConnection(user)) {
    // A desktop without its own key borrows the paired server's sealed one.
    const endpoint = '/api/agent/embeddings';
    const response = await instanceRequest(user,endpoint,new Request(`https://rimeward.invalid${endpoint}`,{ method:'POST',headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ input,query,config }),signal:AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(30000)]) }));
    if (!response.ok) throw Error(`Paired server cloud embeddings failed (${response.status}).`);
    const body = await response.json(); if (body.profile !== profile.id) throw Error('Cloud embedding profile mismatch.');
    return { vectors:normalizeEmbeddings(body.vectors,input.length,profile.dimensions),runtime:'server' };
  }
  if (!key) throw Error(`${config.provider === 'openai' ? 'OpenAI API' : 'OpenRouter'} embedding key is not configured on this runtime.`);
  const endpoint = config.provider === 'openai' ? 'https://api.openai.com/v1/embeddings' : 'https://openrouter.ai/api/v1/embeddings';
  const response = await fetch(endpoint,{ method:'POST',redirect:'error',headers:{ authorization:`Bearer ${key}`,'content-type':'application/json' },
    body:JSON.stringify({ model:config.model,input:encoded,encoding_format:'float' }),signal:AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(30000)]) });
  if (!response.ok) throw Error(`${config.provider} embeddings failed (${response.status}).`);
  const body = await response.json();
  const raw = body.data?.sort((a: { index:number },b: { index:number }) => a.index-b.index).map((v: { embedding:unknown }) => v.embedding);
  return { vectors:normalizeEmbeddings(raw,input.length,profile.dimensions),runtime:config.provider };
}
