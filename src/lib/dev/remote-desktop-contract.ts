/** Shared wire contract. Pairing keeps its own, independent protocol version. */
export const REMOTE_DESKTOP_PROTOCOL = 1;
export const REMOTE_DESKTOP_HEADER = 'x-rimeward-remote-desktop';
export const REMOTE_LIMITS = {
  viewers: 4, heartbeatMs: 2000, controlExpiryMs: 5000, authorizationMs: 30000,
  renewMs: 10000, idleMs: 60000, textBytes: 1024 * 1024, pngBytes: 8 * 1024 * 1024,
  chunkBytes: 4 * 1024 * 1024, transfers: 2, compatibilityPixels: 1280, compatibilityFps: 8,
} as const;
export const REMOTE_CAPABILITIES = ['screen', 'input', 'rime', 'clipboard', 'files', 'audio'] as const;
export type RemoteCapability = typeof REMOTE_CAPABILITIES[number];
export type RemoteOperation = 'status' | 'configure' | 'connect' | 'view' | 'control' | 'rime' | 'clipboard' | 'transfer' | 'audio';
export interface DeviceAccessPolicy {
  revision: number;
  connection: 'account' | 'approval' | 'disabled';
  persistence: 'remember' | 'until-quit';
  screen: boolean; input: boolean; rime: boolean; clipboard: boolean; files: boolean; audio: boolean;
}
export const DEFAULT_REMOTE_POLICY: Readonly<DeviceAccessPolicy> = Object.freeze({
  revision: 0, connection: 'account', persistence: 'remember',
  screen: true, input: true, rime: true, clipboard: true, files: true, audio: true,
});
export type RemoteTransport = 'webrtc' | 'turn' | 'compatibility';
export interface RemoteDisplay {
  display: number; name?: string; x: number; y: number; width: number; height: number;
  scale: number; rotation: number;
}
export interface RemoteController {
  kind: 'human' | 'rime'; id: string; generation: number;
}
export interface DeviceCapabilities {
  protocol: number;
  platform: string;
  state: 'available' | 'locked' | 'suspended' | 'disabled' | 'permission-required' | 'unsupported';
  features: Record<RemoteCapability, boolean>;
  unavailable: Partial<Record<RemoteCapability, string>>;
  textInput?: { available: boolean; reason?: string };
  displays: RemoteDisplay[];
  topology: number;
  controller: RemoteController | null;
  transports: RemoteTransport[];
  policy: DeviceAccessPolicy;
}
export class RemoteDesktopError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = 'remote_desktop_error') {
    super(message); this.status = status; this.code = code;
  }
}
export function parseRemotePolicy(value: unknown): DeviceAccessPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RemoteDesktopError('Invalid access policy.');
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 0 ||
      !['account', 'approval', 'disabled'].includes(String(v.connection)) ||
      !['remember', 'until-quit'].includes(String(v.persistence)) ||
      REMOTE_CAPABILITIES.some(c => typeof v[c] !== 'boolean')) throw new RemoteDesktopError('Invalid access policy.');
  return { revision: Number(v.revision), connection: v.connection as DeviceAccessPolicy['connection'],
    persistence: v.persistence as DeviceAccessPolicy['persistence'],
    ...Object.fromEntries(REMOTE_CAPABILITIES.map(c => [c, v[c]])) } as DeviceAccessPolicy;
}
export function operationCapability(operation: RemoteOperation): RemoteCapability | undefined {
  switch (operation) {
    case 'connect': case 'view': return 'screen';
    case 'control': return 'input';
    case 'rime': return 'rime';
    case 'clipboard': return 'clipboard';
    case 'transfer': return 'files';
    case 'audio': return 'audio';
    case 'status': case 'configure': return;
    default: throw new RemoteDesktopError('Unknown device operation.');
  }
}
/** Check the raw layout, before validation can drop an unknown ward. */
export function requireRemoteLayoutVersion(layout: unknown, version: string | null) {
  if (Array.isArray(layout) && layout.some(w => w?.type === 'remote-desktop') && version !== String(REMOTE_DESKTOP_PROTOCOL))
    throw new RemoteDesktopError('Update Rimeward before synchronizing this dashboard. Your local dashboard has been preserved.', 426, 'remote_desktop_upgrade_required');
}
