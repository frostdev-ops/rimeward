import { getDb } from '../db.ts';
import { deviceBoot, notifyDevicePolicy } from './devices.ts';
import { revokeRemoteSessions } from './remote-desktop-events.ts';
import { DEFAULT_REMOTE_POLICY, parseRemotePolicy, operationCapability, RemoteDesktopError, type RemoteOperation } from './remote-desktop-contract.ts';

/** All device operations enter here; caller identity always comes from authentication. */
export function authorizeDevice(user: number, device: string, operation: RemoteOperation) {
  if (!getDb().prepare('SELECT 1 FROM devices WHERE id=? AND user_id=?').get(device, user))
    throw new RemoteDesktopError('Computer not found.', 404, 'device_not_found');
  const row = getDb().prepare('SELECT policy_json,revision,boot_id FROM remote_desktop_policies WHERE device_id=? AND user_id=?')
    .get(device, user) as { policy_json: string; revision: number; boot_id: string | null } | undefined;
  const policy = row ? parseRemotePolicy({ ...JSON.parse(row.policy_json), revision: row.revision }) : { ...DEFAULT_REMOTE_POLICY };
  const capability = operationCapability(operation);
  if (policy.persistence === 'until-quit' && (!row?.boot_id || row.boot_id !== deviceBoot(device))) policy.connection = 'disabled';
  if (capability && (policy.connection === 'disabled' || !policy[capability]))
    throw new RemoteDesktopError('Remote access is disabled for this operation.', 403, 'access_disabled');
  return policy;
}
export function saveDevicePolicy(user: number, device: string, raw: unknown) {
  const policy = getDb().transaction(() => {
    const current = authorizeDevice(user, device, 'configure'), value = parseRemotePolicy(raw);
    if (value.revision !== current.revision) throw new RemoteDesktopError('Access settings changed. Refresh before saving.', 409, 'policy_changed');
    const boot = value.persistence === 'until-quit' ? deviceBoot(device) : null;
    if (value.persistence === 'until-quit' && !boot) throw new RemoteDesktopError('Connect an updated host before allowing access until it quits.', 409);
    value.revision++;
    getDb().prepare(`INSERT INTO remote_desktop_policies(device_id,user_id,revision,policy_json,boot_id) VALUES(?,?,?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,policy_json=excluded.policy_json,boot_id=excluded.boot_id,updated_at=datetime('now')`)
      .run(device, user, value.revision, JSON.stringify(value), boot);
    return value;
  })();
  revokeRemoteSessions({ device, user });
  notifyDevicePolicy(device);
  return policy;
}
