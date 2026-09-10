import type { APIRoute } from 'astro';
import { noteWard, readNote, resolveNote, writeNote, type NotePatch } from '../../../lib/note.ts';
import { notebookWard } from '../../../lib/notebook.ts';
import { noteConfig } from '../../../lib/wards.ts';
import { broadcast } from '../../../lib/logic-engine.ts';
import { askModel } from '../../../lib/agent/oneshot.ts';

export const prerender = false;

// A note document. GET = the document; PUT = a patch (html and/or ink, each
// half saved as it changes, `rev` = the revision it started from — a save over
// a newer one is refused with 409 and the current document, `force` overrides);
// POST = the model: transcribe an image of ink, or run a writing command over
// a passage. `<ward>` is one of this user's note wards (→ its document) or one
// of this user's note ids (a notebook note); anything else is 404. A notebook
// request carries `?ward=<host ward>` to address the document exactly and
// use the host's model knobs. Documents are served by the local runtime.

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

const notFound = () => Response.json({ error: 'no such note' }, { status: 404 });

// A request that names a host ward (`?ward=`) means the exact document id;
// without it the id is read the way the notepad always did (a note ward first).
export const GET: APIRoute = ({ params, url, locals }) => {
  const userId = locals.user!.userId;
  const n = resolveNote(userId, params.ward, url.searchParams.has('ward'));
  if (!n) return notFound();
  return Response.json(readNote(userId, n.ward ?? n.id), { headers: { 'cache-control': 'no-store' } });
};

export const PUT: APIRoute = async ({ params, request, url, locals }) => {
  const userId = locals.user!.userId;
  const n = resolveNote(userId, params.ward, url.searchParams.has('ward'));
  if (!n) return notFound();
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return Response.json({ error: 'too large' }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { html?: unknown; ink?: unknown; title?: unknown; rev?: unknown; etag?: unknown; force?: unknown } | null;
  if (!body) return Response.json({ error: 'bad body' }, { status: 400 });
  const patch: NotePatch = {};
  if (body.html !== undefined) {
    if (typeof body.html !== 'string') return Response.json({ error: 'bad html' }, { status: 400 });
    patch.html = body.html;
  }
  if (body.ink !== undefined) {
    if (typeof body.ink !== 'string') return Response.json({ error: 'bad ink' }, { status: 400 });
    patch.ink = body.ink;
  }
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') return Response.json({ error: 'bad title' }, { status: 400 });
    patch.title = body.title;
  }
  if (body.rev !== undefined) {
    if (typeof body.rev !== 'number' || !Number.isInteger(body.rev) || body.rev < 0) return Response.json({ error: 'bad rev' }, { status: 400 });
    patch.rev = body.rev;
  }
  if (body.force === true) patch.force = true;
  if (body.etag !== undefined) {
    if (typeof body.etag !== 'string' || !/^[a-f0-9]{64}$/.test(body.etag)) return Response.json({ error: 'bad etag' }, { status: 400 });
    patch.etag = body.etag;
  }
  try {
    const out = writeNote(userId, n.ward ?? n.id, patch);
    // Every other surface showing this document (a notepad ward, a notebook) reloads it; the saver skips its own echo.
    broadcast(userId, 'note', { ward: n.ward?.i, note: n.id, rev: out.rev });
    return Response.json(out);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status === 500) console.error('[note]', err);
    const out: Record<string, unknown> = { error: err instanceof Error ? err.message : 'save failed' };
    if (status === 409) out.doc = (err as { doc?: unknown }).doc; // the current document, for the client's reload
    return Response.json(out, { status });
  }
};

export const POST: APIRoute = async ({ params, request, url, locals }) => {
  const userId = locals.user!.userId;
  const n = resolveNote(userId, params.ward, url.searchParams.has('ward'));
  if (!n) return notFound();
  // The model knobs: the notepad's own, or the notebook's the note is open in.
  const w = noteWard(userId, url.searchParams.get('ward')) ?? notebookWard(userId, url.searchParams.get('ward')) ?? n.ward ?? { i: '', type: 'note', size: '2x2' as const };
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
