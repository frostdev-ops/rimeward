import type { APIRoute } from 'astro';
import { getDashboard } from '../../../../lib/dashboard.ts';
import { limitDeviceAuth } from '../../../../lib/dev/device-auth.ts';
import { AUDIO_MAX, transcribeAudio, transcriptionRoute } from '../../../../lib/agent/transcribe.ts';

export const prerender = false;

const headers = { 'cache-control': 'no-store' };
const guard = (locals: App.Locals, ward: string) => {
  const user = locals.user?.userId;
  if (!user) return { error: Response.json({ error: 'Unauthorized.' }, { status: 401, headers }) };
  // A share view drives a browser ward's page and nothing else; it never spends the owner's credits.
  if (locals.share) return { error: Response.json({ error: 'Not in a shared view.' }, { status: 403, headers }) };
  if (!getDashboard(user).some(w => w.i === ward && w.type === 'agent')) return { error: Response.json({ error: 'Agent ward unavailable.' }, { status: 404, headers }) };
  return { user };
};

/** Whether this ward can transcribe a clip at all, so the composer can say so before recording. */
export const GET: APIRoute = ({ params, locals }) => {
  const ward = String(params.ward);
  const check = guard(locals, ward);
  if (check.error) return check.error;
  const route = transcriptionRoute(check.user!, ward);
  return Response.json({ available: !!route, via: route?.via ?? null }, { headers });
};

/** One recording in, its text out. The transcript goes to the composer's draft — never to a turn. */
export const POST: APIRoute = async ({ params, locals, request }) => {
  const ward = String(params.ward);
  const check = guard(locals, ward);
  if (check.error) return check.error;
  const user = check.user!;
  try {
    limitDeviceAuth(`transcribe:${user}`, 120);
    const mime = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!mime.startsWith('audio/')) return Response.json({ error: 'Send the recording as audio.' }, { status: 415, headers });
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > AUDIO_MAX) return Response.json({ error: 'That recording is too long. Dictate it in shorter passes.' }, { status: 413, headers });
    const audio = await bytes(request);
    const result = await transcribeAudio(user, ward, audio, mime, request.signal);
    return Response.json(result, { headers });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 502;
    return Response.json({ error: error instanceof Error ? error.message : 'Transcription failed.' }, { status, headers });
  }
};

/** Bounded while it reads: a client that lies about content-length still cannot fill memory. */
async function bytes(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('Nothing was recorded.'), { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AUDIO_MAX) throw Object.assign(new Error('That recording is too long. Dictate it in shorter passes.'), { status: 413 });
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
