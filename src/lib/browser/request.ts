import { routeBrowser } from './routing.ts';
import { runBrowserAction } from './actions.ts';
import { downloadResponse } from './downloads.ts';

/** Tool calls use the ward's HTTP route, including its authenticated runtime relay. */
export async function browserRequest(user: number, ward: string, action: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const target = `/api/browser/${ward}${action === 'file' ? `?download=${encodeURIComponent(String(args.id))}` : ''}`;
  const request = new Request(`https://rimeward.invalid${target}`, action === 'file' ? { signal } : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args }), signal,
  });
  const routed = await routeBrowser(user, ward, request);
  if (routed) return routed;
  return action === 'file' ? downloadResponse(user, ward, String(args.id)) : Response.json(await runBrowserAction(user, ward, action, args));
}

export async function browserCall(user: number, ward: string, action: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const response = await browserRequest(user, ward, action, args, signal);
  const value = await response.json().catch(() => null);
  if (!response.ok || value?.error) throw Error(value?.error ?? `Browser request failed (${response.status}). Update the browser's desktop app if needed.`);
  if (!value || typeof value !== 'object') throw Error('Browser returned an invalid response.');
  return value;
}
