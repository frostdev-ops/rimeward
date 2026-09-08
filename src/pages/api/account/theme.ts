import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db.ts';
import { normalizeTheme, parseTheme } from '../../../lib/theme.ts';
import { isDesktop } from '../../../lib/dev/runtime.ts';
import { getSetting } from '../../../lib/settings.ts';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const form = await request.formData();
  const userId = locals.user!.userId;
  const db = getDb();

  if (form.get('reset')) {
    db.prepare('UPDATE users SET theme = NULL WHERE id = ?').run(userId);
    return redirect('/account?ok=theme', 303);
  }

  // Header toggle sends only `mode`: merge it into the stored theme (or the
  // defaults when none is saved yet).
  const modeOnly = form.has('mode') && !form.has('preset');
  const base = modeOnly ? (parseTheme(locals.user!.theme) ?? {}) : {};
  const cfg = normalizeTheme({ ...base, ...Object.fromEntries(form) });
  // Connected Account HTML names the server's copies; files on this desktop
  // retain the local owner's prefix, just like background upload/delete.
  if (isDesktop() && getSetting(`instance:joined:${userId}`))
    for (const key of ['bgImage', 'brandLogo'] as const) cfg[key] = cfg[key].replace(/^\d+-/, `${userId}-`);
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(JSON.stringify(cfg), userId);
  return redirect('/account?ok=theme', 303);
};
