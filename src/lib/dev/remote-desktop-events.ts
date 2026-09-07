/** In-process revocation hooks; no session or screen data is broadcast to clients. */
type Revocation = { session?: string; device?: string; user?: number };
const listeners = new Set<(event: Revocation) => void>();
export function onRemoteRevocation(listener: (event: Revocation) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function revokeRemoteSessions(event: Revocation) {
  for (const listener of listeners) listener(event);
}
