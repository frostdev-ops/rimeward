import { DEFAULT_MODELS, agentConfigured, getProvider, providerDialect, type AgentProviderId } from './provider.ts';

// One model call: no tools, no conversation, no memory — what a ward that just
// needs a model (transcribe this ink, rewrite that paragraph) uses. It rides the
// same two providers and per-user credentials as the agent ward, so there is
// nothing new to connect, and the same per-dialect image part buildUserItem
// (core.ts) sends for an attachment.

export interface OneShot {
  userId: number;
  provider: AgentProviderId;
  endpoint?: string;
  /** Empty = the provider's default. */
  model?: string;
  instructions: string;
  text: string;
  /** A data: URL — png/jpeg/webp. The model must accept images. */
  image?: string;
}

export async function askModel(o: OneShot): Promise<string> {
  if (!agentConfigured(o.userId, o.provider, o.endpoint)) {
    throw Object.assign(new Error(`${o.provider} is not connected — add it under Account → Agent`), { status: 503 });
  }
  const provider = await getProvider(o.provider, o.endpoint);
  const model = o.model?.trim() || DEFAULT_MODELS[o.provider];
  if (!model) throw Object.assign(new Error(`${o.provider} has no default model — pick one in the ward's settings`), { status: 422 });
  const item = !o.image
    ? provider.userItem(o.text)
    : providerDialect(provider) === 'codex'
      ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: o.text }, { type: 'input_image', image_url: o.image }] }
      : { role: 'user', content: [{ type: 'text', text: o.text }, { type: 'image_url', imageUrl: { url: o.image } }] };
  try {
    const r = await provider.run({ userId: o.userId, model, instructions: o.instructions, items: [item], tools: [] });
    return r.text.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The one failure the user can fix from the ward's ⚙: a text-only model.
    if (o.image && /image|vision|modalit|multimodal/i.test(msg)) {
      throw Object.assign(new Error(`"${model}" does not accept images — pick a vision model in the ward's settings`), { status: 422 });
    }
    throw err;
  }
}

/** One call whose answer must be a JSON object; fences and preamble around it
 *  are tolerated, anything else throws. */
export async function askJson(o: OneShot): Promise<Record<string, unknown>> {
  const raw = await askModel(o);
  let v: unknown;
  try {
    v = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    throw new Error('model did not return JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('model did not return an object');
  return v as Record<string, unknown>;
}
