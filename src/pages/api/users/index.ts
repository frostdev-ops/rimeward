import { inviteAccount } from '../../../lib/account-access.ts';
import type { APIRoute } from 'astro';
import { listUsers, createUser, emailInUse, generatePassword } from '../../../lib/users.ts';
import { sessionId } from '../../../lib/auth.ts';
import { setSetting } from '../../../lib/settings.ts';

export const prerender = false;

export const GET: APIRoute = async () => {
  return Response.json(
    listUsers().map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      displayName: u.display_name,
      createdAt: u.created_at,
      hasPassword: !!u.has_password,
      status: u.status,
      emailVerified: !!u.email_verified,
    }))
  );
};

// Admin "invite/create user" form. mode=sso creates a password-less row —
// the row existing is what lets that email in through Google SSO.
export const POST: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const role = String(form.get('role') ?? 'member') === 'admin' ? 'admin' : 'member';
  const mode = String(form.get('mode') ?? 'sso');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return redirect('/admin/users?err=bad-email', 303);
  if (emailInUse(email)) return redirect('/admin/users?err=exists', 303);

  if (mode === 'email') { try { await inviteAccount(email,locals.user!.userId);return redirect('/admin/users?ok=invited',303); } catch {return redirect('/admin/users?err=Email%20invitation%20could%20not%20be%20sent',303);} }
  if (mode === 'password') {
    const password = String(form.get('password') ?? '') || generatePassword();
    createUser(email, password, role);
    // Shown once on the next page render, never in a URL (query strings hit
    // nginx logs and browser history). Keyed to this admin's session.
    setSetting(`flash_pw:${sessionId(cookies)}`, password);
    return redirect('/admin/users?ok=created', 303);
  }
  createUser(email, null, role);
  return redirect('/admin/users?ok=invited', 303);
};
