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

// Admin "invite/create user" form. Both modes leave a way in: an emailed
// invitation (its link sets a password or links an identity), or a password
// generated here. A row with neither could never sign in at all.
export const POST: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const role = String(form.get('role') ?? 'member') === 'admin' ? 'admin' : 'member';
  const mode = String(form.get('mode') ?? 'email');
  const fail = (message: string) => redirect(`/admin/users?err=${encodeURIComponent(message)}`, 303);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('That is not an email address.');
  if (emailInUse(email)) return fail('That email already has an account.');

  if (mode === 'password') {
    const password = String(form.get('password') ?? '') || generatePassword();
    createUser(email, password, role);
    // Shown once on the next page render, never in a URL (query strings hit
    // nginx logs and browser history). Keyed to this admin's session.
    setSetting(`flash_pw:${sessionId(cookies)}`, password);
    return redirect('/admin/users?ok=created', 303);
  }
  try {
    await inviteAccount(email, locals.user!.userId, role);
    return redirect('/admin/users?ok=invited', 303);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'The invitation could not be sent.');
  }
};
