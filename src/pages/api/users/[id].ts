import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db.ts';
import { audit, config } from '../../../lib/app-config.ts';
import { getUser, setUserRole, setUserPassword, deleteUser, generatePassword, setUserStatus, revokeUserAccess, setDisplayName } from '../../../lib/users.ts';
import { sessionId, type Role } from '../../../lib/auth.ts';
import { setSetting } from '../../../lib/settings.ts';

export const prerender = false;

// Forms can't PATCH/DELETE; one POST with an action switch keeps the admin
// page dependency-free. Guards (last admin, last user) throw → err redirect.
export const POST: APIRoute = async ({ params, request, cookies, redirect, locals }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || !getUser(id)) return redirect('/admin/users?err=missing', 303);

  const form = await request.formData();
  const action = String(form.get('action') ?? '');

  try {
    switch (action) {
      case 'unlink-identity': {
        getDb().transaction(()=>{
          const user=getUser(id)!;
          const count=(getDb().prepare('SELECT count(*) AS n FROM login_identities WHERE user_id=?').get(id) as {n:number}).n;
          if((!user.has_password||config('PASSWORD_LOGIN')!=='true')&&count<=1)throw new Error('Set up account recovery before removing the last sign-in identity');
          getDb().prepare('DELETE FROM login_identities WHERE user_id=? AND connector=? AND issuer=? AND subject=?').run(id,String(form.get('connector')),String(form.get('issuer')),String(form.get('subject')));
          audit(locals.user!.userId,'identity.unlinked',String(id));
        })();return redirect('/admin/users',303);
      }
      case 'status': setUserStatus(id,String(form.get('status')) as 'active',locals.user!.userId);return redirect('/admin/users',303);
      case 'revoke': revokeUserAccess(id,locals.user!.userId);return redirect('/admin/users',303);
      case 'name': setDisplayName(id,String(form.get('name')??''));return redirect('/admin/users',303);
      case 'role': {
        const role = String(form.get('role')) as Role;
        if (role !== 'admin' && role !== 'member') return redirect('/admin/users?err=bad-role', 303);
        setUserRole(id, role);audit(locals.user!.userId,'user.role',String(id));
        return redirect('/admin/users?ok=role', 303);
      }
      case 'reset-password': {
        const password = generatePassword();
        setUserPassword(id, password);audit(locals.user!.userId,'user.password-reset',String(id));
        setSetting(`flash_pw:${sessionId(cookies)}`, password);
        return redirect('/admin/users?ok=reset', 303);
      }
      case 'delete': {
        deleteUser(id);audit(locals.user!.userId,'user.deleted',String(id));
        return redirect('/admin/users?ok=deleted', 303);
      }
      default:
        return redirect('/admin/users?err=bad-action', 303);
    }
  } catch (err) {
    return redirect(`/admin/users?err=${encodeURIComponent((err as Error).message)}`, 303);
  }
};
