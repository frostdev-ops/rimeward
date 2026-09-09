import type { APIRoute } from 'astro';
import { getNote, noteWard, saveNote } from '../../../lib/note.ts';
import { noteConfig } from '../../../lib/wards.ts';
import { askModel } from '../../../lib/agent/oneshot.ts';

export const prerender = false;

// The notepad ward's document. GET = the document; PUT = a patch (html and/or
// ink, each half saved as it changes); POST = the model: transcribe an image of
// ink, or run a writing command over a passage. The ward id must be one of
// this user's note wards — the layout is the only registry of them.

const MAX_BODY = 3 * 1024 * 1024; // ink JSON is the big one (NOTE_INK_MAX + the html)
const MAX_IMAGE = 4 * 1024 * 1024;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

const TRANSCRIBE = `You transcribe handwriting. Reply with ONLY the text written in the image, as plain text, keeping the writer's line breaks and their exact words — fix nothing, add nothing. Use a blank line between separate paragraphs or notes. If the image holds no legible writing (a drawing, a diagram, a scribble), reply with nothing at all.`;

const WRITE = `You are Rime, the writing assistant inside the user's notepad. You receive a passage from their document and an instruction. Reply with the resulting text ONLY — no preamble, no quotes around it, no commentary, no closing remark. Plain text with a blank line between paragraphs. Keep the writer's voice and tense.`;

/** The ✨ presets. `custom` uses the user's own instruction. */
const PRESETS: Record<string, string> = {
  fix: 'Fix spelling, grammar and punctuation. Change nothing else — not the wording, not the length.',
  shorten: 'Make this shorter and clearer without losing any point it makes.',
  expand: 'Expand this with more detail and examples, in the same voice, about twice the length.',
  summarize: 'Summarize this in a few tight sentences.',
  continue: 'Continue writing from where this text ends, in the same voice and format, one to three paragraphs. Reply with the continuation only.',
  outline: 'Turn this into a clean outline: short headings and bullet points, one idea per line.',
};

export const GET: APIRoute = ({ params, locals }) => {
  const userId = locals.user!.userId;
  const w = noteWard(userId, params.ward);
  if (!w) return Response.json({ error: 'not a note ward' }, { status: 400 });
  return Response.json(getNote(userId, w), { headers: { 'cache-control': 'no-store' } });
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const userId = locals.user!.userId;
  const w = noteWard(userId, params.ward);
  if (!w) return Response.json({ error: 'not a note ward' }, { status: 400 });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return Response.json({ error: 'too large' }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { html?: unknown; ink?: unknown } | null;
  if (!body) return Response.json({ error: 'bad body' }, { status: 400 });
  const patch: { html?: string; ink?: string } = {};
  if (body.html !== undefined) {
    if (typeof body.html !== 'string') return Response.json({ error: 'bad html' }, { status: 400 });
    patch.html = body.html;
  }
  if (body.ink !== undefined) {
    if (typeof body.ink !== 'string') return Response.json({ error: 'bad ink' }, { status: 400 });
    patch.ink = body.ink;
  }
  try {
    return Response.json({ updated: saveNote(userId, w, patch) });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status === 500) console.error('[note]', err);
    return Response.json({ error: err instanceof Error ? err.message : 'save failed' }, { status });
  }
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const userId = locals.user!.userId;
  const w = noteWard(userId, params.ward);
  if (!w) return Response.json({ error: 'not a note ward' }, { status: 400 });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_IMAGE + 64 * 1024) return Response.json({ error: 'too large' }, { status: 413 });
  const body = (await request.json().catch(() => null)) as {
    action?: string;
    image?: unknown;
    mode?: unknown;
    prompt?: unknown;
    text?: unknown;
  } | null;
  if (!body) return Response.json({ error: 'bad body' }, { status: 400 });
  const cfg = noteConfig(w);
  try {
    if (body.action === 'transcribe') {
      const image = typeof body.image === 'string' ? body.image : '';
      if (!IMAGE_RE.test(image) || image.length > MAX_IMAGE) return Response.json({ error: 'bad image' }, { status: 400 });
      const text = await askModel({ userId, provider: cfg.provider, endpoint: cfg.endpoint, model: cfg.model, instructions: TRANSCRIBE, text: 'Transcribe this handwriting.', image });
      return Response.json({ text });
    }
    if (body.action === 'ai') {
      const mode = typeof body.mode === 'string' && body.mode in PRESETS ? body.mode : 'custom';
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 1000) : '';
      const passage = typeof body.text === 'string' ? body.text.trim().slice(0, 20_000) : '';
      const instruction = mode === 'custom' ? prompt : PRESETS[mode]!;
      if (!instruction) return Response.json({ error: 'say what to do with it' }, { status: 400 });
      if (!passage) return Response.json({ error: 'nothing to work on — select some text or write something first' }, { status: 400 });
      const text = await askModel({
        userId,
        provider: cfg.provider,
        endpoint: cfg.endpoint,
        model: cfg.model,
        instructions: WRITE,
        text: `INSTRUCTION: ${instruction}\n\nPASSAGE:\n${passage}`,
      });
      return Response.json({ text });
    }
    return Response.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 502;
    if (status === 502) console.error('[note model]', err);
    return Response.json({ error: err instanceof Error ? err.message : 'model call failed' }, { status });
  }
};
