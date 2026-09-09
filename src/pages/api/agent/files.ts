import type { APIRoute } from 'astro';
import { agentConfigured } from '../../../lib/agent/provider.ts';
import { activeConversation } from '../../../lib/agent/conversations.ts';
import { storeAttachment, attachmentPath, IMAGE_MIMES } from '../../../lib/agent/attachments.ts';
import { getDb } from '../../../lib/db.ts';
import fs from 'node:fs';

export const prerender = false;

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024; // formData() buffers the whole body
const MAX_FILES = 8; // the chat route only ever replays 8 file_ids anyway

/** Hash references survive shared-conversation attachment ID remapping. */
export const GET: APIRoute = ({ locals, url }) => {
  const hash = url.searchParams.get('sha') ?? '';
  const file = /^[a-f0-9]{64}$/.test(hash) && locals.user
    ? getDb().prepare('SELECT mime FROM agent_files WHERE user_id=? AND sha256=? LIMIT 1').get(locals.user.userId, hash) as { mime: string } | undefined : undefined;
  if (!file || !IMAGE_MIMES.includes(file.mime)) return new Response('Image not found', { status: 404 });
  try { return new Response(fs.readFileSync(attachmentPath(hash)), { headers: { 'content-type': file.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-rimeward-private': '1' } }); }
  catch { return new Response('Image unavailable', { status: 404 }); }
};

/** Attachments are uploaded when picked and referenced by id afterwards, so
 *  the chat request stays small. Per-file results — nothing silently dropped. */
export const POST: APIRoute = async ({ request, locals }) => {
  const userId = locals.user!.userId;
  // Checked BEFORE formData(), which buffers the entire multipart body in the
  // pm2 process — a 500MB upload would OOM the whole dashboard, not just this
  // request.
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_TOTAL_BYTES) {
    return Response.json({ error: `upload too large (max ${MAX_TOTAL_BYTES / 1024 / 1024}MB per request)` }, { status: 413 });
  }
  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: 'bad form' }, { status: 400 });
  const { agentWardConfig } = await import('../../../lib/agent/core.ts');
  const cfg = agentWardConfig(userId, String(form.get('ward') ?? ''));
  if (!cfg) return Response.json({ error: 'not an agent ward' }, { status: 400 });
  if (!agentConfigured(userId, cfg.provider, cfg.endpoint)) return Response.json({ error: 'not-configured' }, { status: 503 });
  const conv = activeConversation(userId, String(form.get('ward')), cfg.provider, cfg.endpoint);

  const out: { name: string; ok: boolean; id?: number; pages?: number | null; kind?: 'image' | 'document'; error?: string }[] = [];
  const entries = form.getAll('files').filter((e): e is File => e instanceof File);
  for (const entry of entries.slice(0, MAX_FILES)) {
    if (entry.size > MAX_BYTES) {
      out.push({ name: entry.name, ok: false, error: `larger than ${MAX_BYTES / 1024 / 1024}MB` });
      continue;
    }
    try {
      const stored = await storeAttachment({
        userId,
        name: entry.name,
        mime: entry.type,
        bytes: new Uint8Array(await entry.arrayBuffer()),
        conversationId: conv.id,
      });
      out.push({ name: entry.name, ok: true, id: stored.id, pages: stored.pages, kind: stored.mime.startsWith('image/') ? 'image' : 'document' });
    } catch (err) {
      out.push({ name: entry.name, ok: false, error: err instanceof Error ? err.message : 'upload failed' });
    }
  }
  for (const skipped of entries.slice(MAX_FILES)) {
    out.push({ name: skipped.name, ok: false, error: `only ${MAX_FILES} files per upload` });
  }
  return Response.json({ files: out });
};
