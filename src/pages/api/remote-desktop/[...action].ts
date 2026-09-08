import type { APIRoute } from 'astro';
import { sessionId } from '../../../lib/auth.ts';
import { isDesktop } from '../../../lib/dev/runtime.ts';
import { instanceRequest } from '../../../lib/dev/remote.ts';
import { RemoteDesktopError } from '../../../lib/dev/remote-desktop-contract.ts';
import { authorizeDevice, saveDevicePolicy } from '../../../lib/dev/remote-desktop-policy.ts';
import { createRemoteSession, remoteCapabilities, remoteSessionAction, retargetRemoteWard, downloadRemoteFile, remoteDesktopMetrics } from '../../../lib/dev/remote-desktop.ts';
import { remoteTurnHealth } from '../../../lib/dev/remote-turn.ts';
import { listDevices } from '../../../lib/dev/devices.ts';
import { remoteHostAction } from '../../../lib/dev/remote-desktop-host.ts';

async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new RemoteDesktopError('Missing request.');
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120000)]);
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 12 * 1024 * 1024) throw new RemoteDesktopError('Request too large.', 413);
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RemoteDesktopError('Invalid request.');
  return body as Record<string, unknown>;
}
export const ALL: APIRoute = async ({ params, request, locals, cookies, url }) => {
  try {
    if (!locals.user) throw new RemoteDesktopError('Sign in required.', 401);
    const action = params.action ?? '', user = locals.user.userId;
    if (action === 'host') {
      if (!isDesktop() || request.method !== 'POST') throw new RemoteDesktopError('Private native dispatch required.', 403);
      return await remoteHostAction(request, () => readBody(request));
    }
    if (request.headers.has('x-rimeward-native-token')) throw new RemoteDesktopError('Viewer authentication required.', 403);
    if (isDesktop()) return await instanceRequest(user, url.pathname + url.search, request);
    const authentication = sessionId(cookies);
    if (!authentication) throw new RemoteDesktopError('Sign in required.', 401);
    if (action === 'metrics' && request.method === 'GET') return Response.json({ ...remoteDesktopMetrics(user) as object, turn: await remoteTurnHealth(), windowDays: 30 }, { headers: { 'cache-control': 'no-store' } });
    if (action === 'devices' && request.method === 'GET') return Response.json(listDevices(user));
    if (action === 'target' && request.method === 'PUT') {
      const body = await readBody(request);
      if (typeof body.ward !== 'string' || typeof body.device !== 'string') throw new RemoteDesktopError('Select a ward and computer.');
      return Response.json(await retargetRemoteWard(user, body.ward, body.device));
    }
    if (action === 'capabilities' && request.method === 'GET') return await remoteCapabilities(user, authentication, url.searchParams.get('device') ?? '');
    if (action === 'policy') {
      if (request.method === 'GET') return Response.json(authorizeDevice(user, url.searchParams.get('device') ?? '', 'status'));
      if (request.method === 'PUT') {
        const body = await readBody(request);
        if (typeof body.device !== 'string') throw new RemoteDesktopError('Select a computer.');
        return Response.json(saveDevicePolicy(user, body.device, body.policy));
      }
    }
    if (action === 'sessions' && request.method === 'POST') return await createRemoteSession(user, authentication, await readBody(request));
    const download = /^sessions\/([a-f0-9-]{36})\/download\/([a-f0-9]{32})$/.exec(action);
    if (download && request.method === 'GET') return await downloadRemoteFile(user, authentication, download[1] ?? '', download[2] ?? '', request.signal);
    if (/^sessions\/[a-f0-9-]{36}$/.test(action) && request.method === 'POST')
      return await remoteSessionAction(user, authentication, action.slice('sessions/'.length), await readBody(request));
    throw new RemoteDesktopError('Unknown remote desktop operation.', 404);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Remote desktop request failed.',
      code: error instanceof RemoteDesktopError ? error.code : 'remote_desktop_error' },
    { status: (error as { status?: number }).status ?? 400, headers: { 'cache-control': 'no-store' } });
  }
};
