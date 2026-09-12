import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { DATA_DIR, getDb, repoDir } from '../db.ts';
import { embed, embeddingConfig } from './embeddings.ts';
import { embeddingProfile } from './embedding-profiles.ts';
import { localEmbeddingStatus } from './embedding-local.ts';
import { parseDoc, docPath } from './store.ts';
import { estimateTokens } from './context.ts';
import type { ToolDef } from './tools.ts';
import { onObservation } from './observation-events.ts';

export interface KnowledgeHit { id:number; source:string; kind:string; title:string; reference:string; revision:string; text:string; page:number; line:number; offset:number; score?:number }
export interface KnowledgeStatus { chunks:number; embedded:number; vectorError:string; error?:string; indexing?:boolean }
let worker: Worker | undefined, sequence = 0;
let stopping = false;
const pending = new Map<number,{ resolve:(v:any) => void; reject:(e:Error) => void; timer:ReturnType<typeof setTimeout> }>();
const indexing = new Map<number,Promise<void>>();
const reindex = new Set<number>();
const errors = new Map<number,string>();
function request<T>(owner:number, op:string, args:Record<string,unknown> = {}): Promise<T> {
  if (stopping) return Promise.reject(Error('Knowledge runtime is shutting down.'));
  getDb();
  if (!worker) {
    const entry = import.meta.url.endsWith('.ts') ? 'knowledge.mjs' : 'knowledge.bundle.mjs';
    const current = new Worker(path.join(repoDir('workers'),entry),{ workerData:{ directory:DATA_DIR },execArgv:[] });
    worker = current;
    const fail = (e:Error) => {
      if (worker !== current) return;
      worker = undefined;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear();
    };
    current.on('error',fail); current.on('exit',() => fail(Error('Knowledge worker stopped; retry to restart it.')));
    current.on('message',m => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(Error(m.error)); else p.resolve(m.value); if (!pending.size) current.unref(); });
  }
  worker.ref(); const id = ++sequence;
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Knowledge indexing is still busy; results are unavailable.')); if (!pending.size) worker?.unref(); },120000).unref();
    pending.set(id,{ resolve,reject,timer }); worker!.postMessage({ ...args,owner,op,id });
  });
}
export async function indexToolCatalog(user:number, definitions:Record<string,ToolDef>): Promise<void> {
  const tools = Object.entries(definitions).map(([name,d]) => ({ id:`tool:${name}`,kind:'tool',title:name,reference:`tool:${name}`,text:`${name}\n${d.description}\n${JSON.stringify(d.parameters)}`,version:d.kind }));
  await request(user,'reconcile',{ tools });
  indexKnowledge(user);
}
export function indexKnowledge(user:number): void {
  if (stopping) return;
  if (indexing.has(user)) { reindex.add(user); return; }
  const config = embeddingConfig(user), profile = embeddingProfile(config);
  const run = (async () => {
    for (;;) {
      if (stopping) break;
      if (JSON.stringify(embeddingConfig(user)) !== JSON.stringify(config)) { reindex.add(user); break; }
      const batch = await request<KnowledgeHit[]>(user,'pending',{ profile:profile.id });
      if (!batch.length) { errors.delete(user); break; }
      if (config.provider === 'local' && localEmbeddingStatus().unloaded) throw Error('Local model is unloaded. Keyword indexing continues; the next retrieval request can load it again.');
      const vectors = await embed(user,batch.map(c => c.text),false,undefined,config);
      await request(user,'vectors',{ profile:profile.id,values:batch.map((c,i) => ({ id:c.id,revision:c.revision,vector:vectors[i] })) });
    }
  })().catch(e => errors.set(user,e instanceof Error ? e.message : String(e))).finally(() => {
    indexing.delete(user);
    if (reindex.delete(user)) indexKnowledge(user);
  });
  indexing.set(user,run.then(() => {}));
}
export async function knowledgeStatus(user:number): Promise<KnowledgeStatus> {
  const result = await request<KnowledgeStatus>(user,'status',{ profile:embeddingProfile(embeddingConfig(user)).id });
  return { ...result,indexing:indexing.has(user),...(errors.has(user) ? { error:errors.get(user) } : {}) };
}
export async function rebuildKnowledge(user:number): Promise<KnowledgeStatus> {
  await request(user,'rebuild'); indexKnowledge(user); return knowledgeStatus(user);
}
export async function searchKnowledge(user:number, query:string, kinds?:string[], limit = 5, sources?:string[], signal?:AbortSignal) {
  signal?.throwIfAborted();
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw Error('Search requires a query of 1–2000 characters.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw Error('Search limit must be 1–10.');
  if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.length || kinds.some(k => !['tool','memory','skill','standing','note','notebook','conversation','attachment'].includes(k)))) throw Error('Select valid knowledge source scopes.');
  if (sources !== undefined && (!Array.isArray(sources) || sources.length > 2000 || sources.some(s => typeof s !== 'string' || s.length > 160))) throw Error('Invalid knowledge source identities.');
  const config = embeddingConfig(user), profile = embeddingProfile(config);
  let vector:number[] | undefined, fallback = '';
  try { [vector] = await embed(user,[query],true,signal,config); }
  catch (e) { fallback = e instanceof Error ? e.message : String(e); }
  signal?.throwIfAborted();
  const hits = await request<KnowledgeHit[]>(user,'search',{ query,kinds,sources,limit,profile:profile.id,vector });
  signal?.throwIfAborted();
  indexKnowledge(user);
  const progress = await knowledgeStatus(user);
  signal?.throwIfAborted();
  const partial = !!fallback || !!progress.vectorError || progress.embedded < progress.chunks;
  return { mode:partial ? 'keyword-fallback' : 'hybrid',status: partial ? fallback || progress.vectorError || 'Embedding index is rebuilding; keyword retrieval remains available.' : 'ready',
    exhaustive:false,profile:profile.id,progress,results:hits.map(h => ({ ...h,text:h.text.slice(0,1800) })) };
}
export async function readKnowledge(user:number, source:string, offset = 0) {
  if (typeof source !== 'string' || !/^(memory|skill|standing|note|notebook|conversation|attachment|tool):.{1,150}$/.test(source)) throw Error('Use a source identity returned by search_knowledge.');
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error('offset must be a non-negative integer.');
  const results = await request<KnowledgeHit[]>(user,'read',{ source,offset,limit:2 });
  return { source,results,next:results.length ? results.at(-1)!.offset+results.at(-1)!.text.length : null,status:results.length ? 'current' : 'Source missing, deleted, outside scope, or no more text.' };
}
export async function memoryPassages(user:number, query:string): Promise<string> {
  const passages:string[] = [], named:string[] = [];
  const names = await request<{ name:string; text:string; truncated:boolean }[]>(user,'named',{ query }).catch(() => {
    named.push('Named skill lookup unavailable; read requested procedures from /work/skills.');
    return [];
  });
  for (const skill of names.slice(0,5)) {
    const doc = parseDoc(skill.text);
    let body = doc.body;
    while (body && estimateTokens(named.join('\n\n') + body) > 12000) body = body.slice(0,Math.floor(body.length*.8));
    named.push(`[Named skill: ${skill.name}; ${docPath('skill',skill.name)}]\n${body}${skill.truncated || body.length < doc.body.length ? `\n[Continues: use read_knowledge on skill:${skill.name}.]` : ''}`);
  }
  if (names.length > 5) named.push('More named skills are available under /work/skills; read them explicitly with read_knowledge.');
  let status = '';
  try {
    const found = await searchKnowledge(user,query.slice(-2000) || 'standing preferences',['memory','skill'],5);
    status = `Retrieval: ${found.mode}. ${found.status}`;
    for (const h of found.results) if (!names.some(n => h.source === `skill:${n.name}`)) passages.push(`[${h.source}; ${h.reference}; line ${h.line}]\n${h.text}`);
  } catch (e) { status = `Knowledge retrieval unavailable: ${e instanceof Error ? e.message : String(e)}. Named skills can still be read from /work/skills.`; }
  let out = status;
  for (let p of passages.slice(0,5)) {
    while (p && estimateTokens(out+'\n\n'+p) > 2000) p = p.slice(0,Math.floor(p.length*.8));
    if (p) out += '\n\n'+p;
  }
  return [...named,out].join('\n\n');
}
let timer:ReturnType<typeof setInterval> | undefined;
const changed = new Map<number,ReturnType<typeof setTimeout>>();
let unsubscribe:(() => void) | undefined;
export function ensureKnowledge(): void {
  if (timer) return;
  unsubscribe = onObservation(e => {
    if (e.source !== 'knowledge' || changed.has(e.user)) return;
    changed.set(e.user,setTimeout(() => { changed.delete(e.user); indexKnowledge(e.user); },1000).unref());
  });
  const tick = () => { for (const u of getDb().prepare('SELECT id FROM users').all() as { id:number }[]) indexKnowledge(u.id); };
  timer = setInterval(tick,30000).unref();
}
export async function shutdownKnowledge(): Promise<void> {
  stopping = true; clearInterval(timer); timer = undefined; unsubscribe?.();
  for (const t of changed.values()) clearTimeout(t);
  changed.clear(); reindex.clear(); await worker?.terminate(); worker = undefined;
}
