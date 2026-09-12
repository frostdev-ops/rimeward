import type { APIRoute } from 'astro';
import { embeddingConfig, saveEmbeddingConfig, embeddingTiming, runtimeHolds } from '../../../lib/agent/embeddings.ts';
import { localEmbeddingStatus, refreshEmbeddingMemory, downloadEmbeddingModel, cancelEmbeddingDownload, unloadEmbeddingModel, embeddingBinary, embeddingRuntimeStatus, installEmbeddingRuntime } from '../../../lib/agent/embedding-local.ts';
import { embeddingProfile, LOCAL_MODELS, type Quantization } from '../../../lib/agent/embedding-profiles.ts';
import { knowledgeStatus, rebuildKnowledge, indexKnowledge } from '../../../lib/agent/knowledge.ts';
import { isDesktop } from '../../../lib/dev/runtime.ts';
import { agentDevices } from '../../../lib/dev/tool-routing.ts';
import { instanceRequest, rimeConnection } from '../../../lib/dev/remote.ts';
import { relayRequest } from '../../../lib/dev/devices.ts';
export const prerender = false;
export const GET:APIRoute = async ({ locals }) => {
  await refreshEmbeddingMemory();
  const user = locals.user!.userId, config = embeddingConfig(user), { devices } = await agentDevices(user);
  const probe = (path:string) => new Request(`https://rimeward.invalid${path}`,{ signal:AbortSignal.timeout(4000) });
  const available = await Promise.all(devices.filter(d => d.id !== 'local').map(async d => {
    if (!d.online) return { ...d,inference:null };
    try {
      const endpoint = '/api/dev/embeddings';
      const response = isDesktop() ? await instanceRequest(user,`/runtime/${d.id}${endpoint}`,probe(endpoint)) : await relayRequest(user,d.id,endpoint,probe(endpoint));
      return { ...d,inference:response.ok ? await response.json() : null };
    } catch { return { ...d,inference:null }; }
  }));
  // From a desktop, the paired server's own model is one more runtime to list.
  let server:unknown = null;
  if (isDesktop()) {
    try {
      if (await rimeConnection(user)) { const response = await instanceRequest(user,'/api/agent/embeddings',probe('/api/agent/embeddings')); server = response.ok ? await response.json() : null; }
    } catch { server = null; }
  }
  return Response.json({ config,profile:embeddingProfile(config),timing:embeddingTiming(user),desktop:isDesktop(),local:localEmbeddingStatus(),server,holds:await runtimeHolds(user),
    index:await knowledgeStatus(user).catch(e => ({ error:e.message })),devices:available },{ headers:{ 'cache-control':'no-store' } });
};
export const POST:APIRoute = async ({ locals,request }) => {
  try {
    const user = locals.user!.userId, body = await request.json();
    if (body.action === 'save') { const config = saveEmbeddingConfig(user,body.config); indexKnowledge(user); return Response.json({ config }); }
    if (body.action === 'rebuild') return Response.json(await rebuildKnowledge(user));
    if (body.action === 'unload') { await unloadEmbeddingModel(); return Response.json({ unloaded:true }); }
    if (!Object.hasOwn(LOCAL_MODELS,body.quantization)) throw Error('Choose Q4_K_M or Q8_0.');
    const q = body.quantization as Quantization;
    if (body.action === 'cancel') { cancelEmbeddingDownload(q); return Response.json({ cancelled:true }); }
    if (body.action === 'download') {
      // A runtime without the bundled binary (a server) installs the pinned llama.cpp first, then the weights.
      if (!embeddingBinary() && !embeddingRuntimeStatus().installable) throw Error(`No pinned llama.cpp build for ${process.platform}-${process.arch}; choose another runtime.`);
      void (embeddingBinary() ? Promise.resolve() : installEmbeddingRuntime()).then(() => downloadEmbeddingModel(q)).then(() => indexKnowledge(user)).catch(() => {});
      return Response.json({ downloading:true });
    }
    throw Error('Unknown embedding action.');
  } catch (e) { return Response.json({ error:e instanceof Error ? e.message : String(e) },{ status:400 }); }
};
