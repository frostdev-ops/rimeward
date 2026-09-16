import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUser,
  getUser,
  getUserByEmail,
  deleteUser,
  setUserRole,
  setUserStatus,
  setUserPassword,
  hasPassword,
  verifyUserPassword,
  emailInUse,
  userCount,
  adminCount,
} from '../src/lib/users.ts';
import { saveConfig } from '../src/lib/app-config.ts';
import { setSetting } from '../src/lib/settings.ts';
import { POST as userPost } from '../src/pages/api/users/[id].ts';
import { createSession, getSession } from '../src/lib/auth.ts';
import { getDb } from '../src/lib/db.ts';

// Tests run sequentially in one process against one DB; ordering below is
// deliberate (last-user / last-admin guards depend on global counts).

let adminId: number;
let memberId: number;

test('createUser with password, email lowercased', () => {
  adminId = createUser('  Admin@Test.IO ', 'pw-admin', 'admin');
  const u = getUser(adminId);
  assert.ok(u);
  assert.equal(u.email, 'admin@test.io');
  assert.equal(u.role, 'admin');
  assert.equal(u.has_password, 1);
  assert.equal(hasPassword(adminId), true);
});

test('deleteUser refuses the only user', () => {
  assert.equal(userCount(), 1);
  assert.throws(() => deleteUser(adminId), /only user/);
});

test('setUserRole refuses demoting the only admin', () => {
  assert.throws(() => setUserRole(adminId, 'member'), /only admin/);
});

test('setUserRole throws for unknown user', () => {
  assert.throws(() => setUserRole(99999, 'member'), /no such user/);
});

test('createUser SSO-only (null password)', () => {
  memberId = createUser('member@test.io', null);
  const u = getUser(memberId);
  assert.ok(u);
  assert.equal(u.role, 'member');
  assert.equal(u.has_password, 0);
  assert.equal(hasPassword(memberId), false);
});

test('deleteUser refuses the only admin', () => {
  assert.throws(() => deleteUser(adminId), /only admin/);
});

test('emailInUse is case-insensitive, exceptId excludes self', () => {
  assert.equal(emailInUse('ADMIN@TEST.IO'), true);
  assert.equal(emailInUse('admin@test.io', adminId), false);
  assert.equal(emailInUse('nobody@test.io'), false);
});

test('getUserByEmail is case-insensitive', () => {
  assert.equal(getUserByEmail('MEMBER@test.io')?.id, memberId);
  assert.equal(getUserByEmail('ghost@test.io'), null);
});

test('verifyUserPassword', () => {
  assert.equal(verifyUserPassword(adminId, 'pw-admin'), true);
  assert.equal(verifyUserPassword(adminId, 'wrong'), false);
  assert.equal(verifyUserPassword(memberId, 'anything'), false); // SSO-only
  assert.equal(verifyUserPassword(99999, 'pw'), false); // no such user
});

test('setUserPassword kills other sessions but keeps keepSession', () => {
  const keep = createSession(adminId);
  const other = createSession(adminId);
  const bystander = createSession(memberId);
  setUserPassword(adminId, 'new-pw', keep.id);
  assert.ok(getSession(keep.id), 'keepSession survives');
  assert.equal(getSession(other.id), null, 'other session for same user is killed');
  assert.ok(getSession(bystander.id), 'other users untouched');
  assert.equal(verifyUserPassword(adminId, 'new-pw'), true);
  assert.equal(verifyUserPassword(adminId, 'pw-admin'), false);
});

test('setUserPassword without keepSession kills all sessions', () => {
  const s = createSession(memberId);
  setUserPassword(memberId, 'first-pw');
  assert.equal(getSession(s.id), null);
  assert.equal(hasPassword(memberId), true);
});

test('deleteUser deletes a non-last member', () => {
  const extraId = createUser('extra@test.io', null);
  deleteUser(extraId);
  assert.equal(getUser(extraId), null);
});

test('cannot delete a suspended admin when no other admin can sign in', () => {
  getDb().prepare("UPDATE users SET status='suspended' WHERE id=?").run(adminId);
  assert.throws(() => deleteUser(adminId), /only admin/);
  getDb().prepare("UPDATE users SET status='active' WHERE id=?").run(adminId);
});

test('cannot demote a suspended admin when no other admin can sign in', () => {
  getDb().prepare("UPDATE users SET status='suspended' WHERE id=?").run(adminId);
  assert.throws(() => setUserRole(adminId, 'member'), /only admin/);
  assert.throws(() => setUserStatus(adminId, 'pending', adminId), /only active administrator/);
  getDb().prepare("UPDATE users SET status='active' WHERE id=?").run(adminId);
});

test('adminCount ignores a sign-in row whose issuer the connector no longer presents', () => {
  const ssoId = createUser('sso-admin@test.io', null, 'admin');
  getDb()
    .prepare(
      "INSERT INTO login_identities(connector,issuer,subject,user_id) VALUES('microsoft','https://login.microsoftonline.com/tenant-a/v2.0','sub-a',?)",
    )
    .run(ssoId);
  setSetting('config:MS_SSO_ENABLED', 'true');
  setSetting('config:MS_CLIENT_ID', 'app-a');
  setSetting('config:MS_TENANT_ID', 'tenant-a');
  // Through saveConfig: the secret is read back through openToken, so a raw settings row
  // reads as an empty secret — and a builtin without one is no longer a way in.
  saveConfig('MS_CLIENT_SECRET', 'ms-secret', null);
  // Only this admin has a sign-in method at all: passwords are off for the count.
  setSetting('config:PASSWORD_LOGIN', 'false');
  assert.equal(adminCount(), 1);
  // Another tenant is another issuer, and resolveIdentity matches connector AND issuer.
  setSetting('config:MS_TENANT_ID', 'tenant-b');
  assert.equal(adminCount(), 0);
  setSetting('config:MS_TENANT_ID', 'tenant-a');
  setSetting('config:PASSWORD_LOGIN', 'true');
  deleteUser(ssoId);
});

test('unlinking an identity cannot remove the last administrator sign-in that works', async () => {
  const ssoId = createUser('unlink-admin@test.io', null, 'admin');
  const row = (connector: string, issuer: string, subject: string) =>
    getDb()
      .prepare('INSERT INTO login_identities(connector,issuer,subject,user_id) VALUES(?,?,?,?)')
      .run(connector, issuer, subject, ssoId);
  row('microsoft', 'https://login.microsoftonline.com/tenant-a/v2.0', 'sub-live');
  // A second ROW that opens nothing: Google is switched off, so counting rows says two ways
  // in where there is one.
  row('google', 'https://accounts.google.com', 'sub-dead');
  setSetting('config:GOOGLE_SSO_ENABLED', 'false');
  setSetting('config:MS_SSO_ENABLED', 'true');
  setSetting('config:MS_CLIENT_ID', 'app-a');
  setSetting('config:MS_TENANT_ID', 'tenant-a');
  saveConfig('MS_CLIENT_SECRET', 'ms-secret', null);
  setSetting('config:PASSWORD_LOGIN', 'false');
  try {
    assert.equal(adminCount(), 1);
    const res = await userPost({
      params: { id: String(ssoId) },
      request: new Request('https://own.example/api/users/1', {
        method: 'POST',
        body: new URLSearchParams({
          action: 'unlink-identity',
          connector: 'microsoft',
          issuer: 'https://login.microsoftonline.com/tenant-a/v2.0',
          subject: 'sub-live',
        }),
      }),
      cookies: { get: () => undefined },
      redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
      locals: { user: { userId: ssoId } },
    } as unknown as Parameters<typeof userPost>[0]);
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get('location')!), /lock out/);
    assert.equal(adminCount(), 1);
    assert.equal(
      (getDb().prepare('SELECT count(*) AS n FROM login_identities WHERE user_id=?').get(ssoId) as { n: number }).n,
      2,
    );
  } finally {
    setSetting('config:PASSWORD_LOGIN', 'true');
    setSetting('config:MS_SSO_ENABLED', 'false');
    getDb().prepare('DELETE FROM login_identities WHERE user_id=?').run(ssoId);
    deleteUser(ssoId);
  }
});

test('unlinking cannot leave a user with only rows that open nothing', async () => {
  // Another administrator keeps a password, so the installation-wide guard never fires and
  // the per-user check is the only thing standing between this user and a locked account.
  const boss = createUser('unlink-boss@test.io', 'boss-password', 'admin');
  const victim = createUser('unlink-victim@test.io', null, 'admin');
  const unlink = (connector: string, issuer: string, subject: string) =>
    userPost({
      params: { id: String(victim) },
      request: new Request('https://own.example/api/users/1', {
        method: 'POST',
        body: new URLSearchParams({ action: 'unlink-identity', connector, issuer, subject }),
      }),
      cookies: { get: () => undefined },
      redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
      locals: { user: { userId: boss } },
    } as unknown as Parameters<typeof userPost>[0]);
  const row = (connector: string, issuer: string, subject: string) =>
    getDb()
      .prepare('INSERT INTO login_identities(connector,issuer,subject,user_id) VALUES(?,?,?,?)')
      .run(connector, issuer, subject, victim);
  row('microsoft', 'https://login.microsoftonline.com/tenant-a/v2.0', 'sub-live');
  // Google is off: this row is a row, not a way in.
  row('google', 'https://accounts.google.com', 'sub-dead');
  setSetting('config:GOOGLE_SSO_ENABLED', 'false');
  setSetting('config:MS_SSO_ENABLED', 'true');
  setSetting('config:MS_CLIENT_ID', 'app-a');
  setSetting('config:MS_TENANT_ID', 'tenant-a');
  saveConfig('MS_CLIENT_SECRET', 'ms-secret', null);
  setSetting('config:PASSWORD_LOGIN', 'true');
  try {
    const refused = await unlink('microsoft', 'https://login.microsoftonline.com/tenant-a/v2.0', 'sub-live');
    assert.match(decodeURIComponent(refused.headers.get('location')!), /account recovery/);
    assert.equal(
      (getDb().prepare('SELECT count(*) AS n FROM login_identities WHERE user_id=?').get(victim) as { n: number }).n,
      2,
    );
    // The dead row itself is still removable: the check is differential, not a freeze.
    const ok = await unlink('google', 'https://accounts.google.com', 'sub-dead');
    assert.equal(ok.headers.get('location'), '/admin/users');
    assert.equal(
      (getDb().prepare('SELECT count(*) AS n FROM login_identities WHERE user_id=?').get(victim) as { n: number }).n,
      1,
    );
  } finally {
    setSetting('config:MS_SSO_ENABLED', 'false');
    getDb().prepare('DELETE FROM login_identities WHERE user_id=?').run(victim);
    deleteUser(victim);
    deleteUser(boss);
  }
});
