import type { APIRoute } from 'astro';
import { isDesktop } from '../../../lib/dev/runtime.ts';
import { embed, embeddingConfig } from '../../../lib/agent/embeddings.ts';
import { embeddingProfile, parseEmbeddingConfig } from '../../../lib/agent/embedding-profiles.ts';
import { localEmbeddingStatus } from '../../../lib/agent/embedding-local.ts';
import { boundedEmbeddingBody } from '../../../lib/agent/embedding-request.ts';
export const prerender = false;
/** What a paired desktop may lean on here: the server's own model, if one is set up. */
export const GET:APIRoute = ({ locals }) => {
  if (!locals.user) return Response.json({ error:'Sign in required.' },{ status:401 });
  if (isDesktop()) return Response.json({ error:'This is a desktop.' },{ status:400 });
  const c = embeddingConfig(locals.user.userId), status = localEmbeddingStatus();
  return Response.json({ hosting:!!status.runtime.binary,quantization:c.quantization,location:status.location,
    models:status.models.map(m => ({ quantization:m.quantization,installed:m.installed })),ready:!!status.runtime.binary && status.models.some(m => m.installed),
    startupMs:status.startupMs,queryMs:status.queryMs },{ headers:{ 'cache-control':'no-store' } });
};
/** A paired desktop explicitly selects a cloud provider (the user's sealed key stays on the server) or the server's own model. */
export const POST:APIRoute = async ({ locals,request }) => {
  try {
    if (isDesktop()) throw Error('Cloud credential dispatch belongs on the paired server.');
    const body = await boundedEmbeddingBody(request), config = parseEmbeddingConfig(body.config);
    // The server never fans out to other desktops on a desktop's behalf: its own model or nothing.
    if (config.provider === 'local') config.runtimes = ['local'];
    const vectors = await embed(locals.user!.userId,body.input,body.query === true,request.signal,config);
    return Response.json({ profile:embeddingProfile(config).id,vectors });
  } catch (e) { return Response.json({ error:e instanceof Error ? e.message : String(e) },{ status:400 }); }
};
