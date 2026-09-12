import type { APIRoute } from 'astro';
import { requireDesktop } from '../../../lib/dev/runtime.ts';
import { embed, embeddingConfig } from '../../../lib/agent/embeddings.ts';
import { embeddingProfile, parseEmbeddingConfig } from '../../../lib/agent/embedding-profiles.ts';
import { localEmbeddingStatus } from '../../../lib/agent/embedding-local.ts';
import { boundedEmbeddingBody } from '../../../lib/agent/embedding-request.ts';

export const prerender = false;
/** What this desktop shares with the user's other runtimes: its own model, never a relay onward. */
const served = (user:number) => parseEmbeddingConfig({ ...embeddingConfig(user),provider:'local',model:'Qwen3-Embedding-8B',runtimes:['local'] });
export const GET:APIRoute = ({ locals }) => {
  if (!locals.user) return Response.json({ error:'Sign in required.' },{ status:401 });
  requireDesktop(); const c = embeddingConfig(locals.user.userId), status = localEmbeddingStatus();
  const profile = embeddingProfile(served(locals.user.userId));
  return Response.json({ sharing:c.sharing,profile:profile.id,quantization:c.quantization,ready:c.sharing && !!status.runtime.binary && status.models.some(m => m.quantization === c.quantization && m.installed),
    location:status.location,startupMs:status.startupMs,queryMs:status.queryMs },{ headers:{ 'cache-control':'no-store' } });
};
export const POST:APIRoute = async ({ locals,request }) => {
  try {
    if (!locals.user) return Response.json({ error:'Sign in required.' },{ status:401 });
    requireDesktop(); const user = locals.user.userId, c = embeddingConfig(user);
    if (!c.sharing) return Response.json({ error:'This desktop is not sharing inference.' },{ status:403 });
    const body = await boundedEmbeddingBody(request);
    if (body.quantization !== c.quantization) throw Error('Selected desktop is sharing a different quantization.');
    const config = served(user), profile = embeddingProfile(config);
    if (body.profile !== profile.id) throw Error('Embedding profile mismatch.');
    const vectors = await embed(user,body.input,body.query === true,request.signal,config);
    if (!embeddingConfig(user).sharing) throw Error('Inference sharing was disabled.');
    return Response.json({ profile:profile.id,vectors });
  } catch (e) { return Response.json({ error:e instanceof Error ? e.message : String(e) },{ status:400 }); }
};
