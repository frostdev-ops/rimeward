import type { APIRoute } from 'astro';
import { isDesktop } from '../../../lib/dev/runtime.ts';
import { embed } from '../../../lib/agent/embeddings.ts';
import { embeddingProfile, parseEmbeddingConfig } from '../../../lib/agent/embedding-profiles.ts';
import { boundedEmbeddingBody } from '../../../lib/agent/embedding-request.ts';
export const prerender = false;
/** The paired desktop explicitly selects a cloud provider; the user's sealed key stays on the server. */
export const POST:APIRoute = async ({ locals,request }) => {
  try {
    if (isDesktop()) throw Error('Cloud credential dispatch belongs on the paired server.');
    const body = await boundedEmbeddingBody(request), config = parseEmbeddingConfig(body.config);
    if (config.provider !== 'openai' && config.provider !== 'openrouter') throw Error('Select OpenAI API or OpenRouter explicitly.');
    const vectors = await embed(locals.user!.userId,body.input,body.query === true,request.signal,config);
    return Response.json({ profile:embeddingProfile(config).id,vectors });
  } catch (e) { return Response.json({ error:e instanceof Error ? e.message : String(e) },{ status:400 }); }
};
