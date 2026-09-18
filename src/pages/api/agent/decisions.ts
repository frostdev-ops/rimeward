import type { APIRoute } from 'astro';
import { isDesktop } from '../../../lib/dev/runtime.ts';
import { decide, type Question } from '../../../lib/agent/decisions.ts';
import { boundedEmbeddingBody } from '../../../lib/agent/embedding-request.ts';
export const prerender = false;
/** A paired desktop's decision request, answered with the SERVER's sealed OpenRouter key, which
 *  never leaves it (the same shape as /api/agent/embeddings). Only the questions and state the
 *  desktop already chose to send are forwarded; nothing is added, and nothing fans out further. */
export const POST:APIRoute = async ({ locals,request }) => {
  try {
    if (isDesktop()) throw Error('Credential dispatch belongs on the paired server.');
    const body = await boundedEmbeddingBody(request);
    if (!body.questions || typeof body.questions !== 'object' || Array.isArray(body.questions)) throw Error('Decision questions required.');
    if (body.state === undefined || body.state === null) throw Error('Decision state required.');
    const decision = await decide(locals.user!.userId,'relay',body.state,body.questions as Record<string,Question>,{ signal:request.signal });
    return Response.json({ model:decision.model,answers:decision.answers,...(decision.usage ? { usage:decision.usage } : {}),...(decision.id ? { id:decision.id } : {}) });
  } catch (e) { return Response.json({ error:{ message:e instanceof Error ? e.message : String(e) } },{ status:(e as { status?:number }).status ?? 400 }); }
};
