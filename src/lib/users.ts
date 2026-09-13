import { revoke } from './dev/devices.ts';
import { revokeRemoteSessions } from './dev/remote-desktop-events.ts';
import { audit, config, identityEnabled } from './app-config.ts';
import crypto from 'node:crypto';
import { getDb } from './db.ts';
import { hashPassword, verifyPassword, type Role } from './auth.ts';

export interface User {
  id: number;
  email: string;
  role: Role;
  display_name: string;
  created_at: string;
  has_password: 0 | 1;
  status: 'active' | 'pending' | 'suspended';
  email_verified: number;
}

const COLS = 'id, email, role, display_name, created_at, status, email_verified, (password_hash IS NOT NULL) AS has_password';

export function listUsers(): User[] {
  return getDb().prepare(`SELECT ${COLS} FROM users ORDER BY email COLLATE NOCASE`).all() as User[];
}

export function getUser(id: number): User | null {
  return ((getDb().prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(id) as User | undefined) ?? null);
}

export function getUserByEmail(email: string): User | null {
  return (
    (getDb().prepare(`SELECT ${COLS} FROM users WHERE email = ? COLLATE NOCASE`).get(email.trim().toLowerCase()) as
      | User
      | undefined) ?? null
  );
}

export function userCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

function adminCount(except?:number): number {
  const admins=getDb().prepare("SELECT id,password_hash IS NOT NULL AS password FROM users WHERE role='admin' AND status='active'").all() as {id:number;password:number}[];
  return admins.filter(user => user.id!==except && ((user.password && config('PASSWORD_LOGIN')==='true') || (getDb().prepare('SELECT connector FROM login_identities WHERE user_id=?').all(user.id) as {connector:string}[]).some(identity=>identityEnabled(identity.connector)) || (identityEnabled('google') && !!getDb().prepare('SELECT 1 FROM legacy_google_users WHERE user_id=?').get(user.id)))).length;
}

/** The last admin cannot be demoted — there would be nobody left to undo it. */
export function setUserRole(id: number, role: Role): void {
  const db = getDb();
  db.transaction(() => {
    const current = getUser(id);
    if (!current) throw new Error('no such user');
    if (current.role === 'admin' && current.status === 'active' && role !== 'admin' && adminCount(id) === 0)
      throw new Error('cannot demote the only admin');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    // getSession joins users, so a demotion takes effect on the next request.
  })();
}

export function setDisplayName(id: number, name: string): void {
  getDb().prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name.trim().slice(0, 100), id);
}

/** 20-char URL-safe password for the "generate" option. */
export function generatePassword(): string {
  return crypto.randomBytes(15).toString('base64url').slice(0, 20);
}

export function emailInUse(email: string, exceptId?: number): boolean {
  const row = getDb()
    .prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE')
    .get(email.trim().toLowerCase()) as { id: number } | undefined;
  return !!row && row.id !== exceptId;
}

/** password null = SSO-only invite: the row existing is what lets them sign in with Google. */
export function createUser(email: string, password: string | null, role: Role = 'member'): number {
  const info = getDb()
    .prepare('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)')
    .run(email.trim().toLowerCase(), password === null ? null : hashPassword(password), role);
  return Number(info.lastInsertRowid);
}

/**
 * Changing a password ends every session that password opened; `keepSession`
 * spares the browser doing the changing.
 */
export function setUserPassword(id: number, password: string, keepSession?: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(id, keepSession ?? null);
  })();
}

/** Whether this user has a password at all — an SSO-only user setting their first one skips the current-password check. */
export function hasPassword(id: number): boolean {
  const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as
    | { password_hash: string | null }
    | undefined;
  return !!row?.password_hash;
}

export function verifyUserPassword(id: number, password: string): boolean {
  const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as
    | { password_hash: string | null }
    | undefined;
  if (!row?.password_hash) return false;
  return verifyPassword(password, row.password_hash);
}

/** Never the last user, nor the last admin. linked_accounts and sessions go via FK CASCADE. */
export function deleteUser(id: number): void {
  const db = getDb();
  db.transaction(() => {
    if (userCount() <= 1) throw new Error('cannot delete the only user');
    const victim = getUser(id);
    if (victim?.role === 'admin' && victim.status === 'active' && adminCount(id) === 0) throw new Error('cannot delete the only admin');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
}

export function setUserStatus(id: number, status: User['status'], actor: number) {
  if (!['active','pending','suspended'].includes(status)) throw new Error('Invalid account status');
  getDb().transaction(() => {
    const user = getUser(id);
    if (!user) throw new Error('Unknown user');
    if (user.role === 'admin' && user.status === 'active' && status !== 'active' && adminCount(id) === 0) throw new Error('Cannot suspend the only active administrator');
    getDb().prepare('UPDATE users SET status=? WHERE id=?').run(status,id);
    if (status !== 'active') revokeUserAccess(id,actor);
    audit(actor,'user.status',`${id}:${status}`);
  })();
}
export function revokeUserAccess(id: number, actor: number) {
  getDb().prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  for (const device of getDb().prepare('SELECT id FROM devices WHERE user_id=?').all(id) as {id:string}[]) revoke(id,device.id);
  revokeRemoteSessions({user:id});
  audit(actor,'user.access-revoked',String(id));
}
