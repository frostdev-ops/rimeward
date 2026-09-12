import type { APIRoute } from 'astro';
import { getDb } from '../../lib/db.ts';
import { CATALOG } from '../../lib/wards.ts';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user!;
  // Inside a share the principal is the owner: say who is looking and what they may do. Of the owner's
  // accounts only the ones the shared wards draw from are named, and only as connected or not — a
  // "Connect Notion" chip on a shared Notion ward would send the viewer somewhere they may not go.
  if (locals.share) {
    const s = locals.share;
    const needed = new Set<string>(s.wards.map((w) => CATALOG[w.type]?.link ?? '').filter(Boolean));
    const linked = new Set((getDb().prepare('SELECT provider FROM linked_accounts WHERE user_id = ?').all(user.userId) as { provider: string }[]).map((r) => r.provider));
    const has = (p: string) => needed.has(p) && linked.has(p);
    return Response.json({ id: s.viewer ?? 0, email: '', role: 'member', displayName: s.viewerName ?? 'Guest',
      links: { google: has('google'), microsoft: has('microsoft'), notion: has('notion'), zoho: has('zoho'), mailbox: has('mailbox'), icloud: has('icloud') },
      share: { id: s.id, role: s.role, kind: s.kind, target: s.target, owner: s.owner } });
  }
  const rows = getDb()
    .prepare('SELECT provider, account_label FROM linked_accounts WHERE user_id = ?')
    .all(user.userId) as { provider: string; account_label: string }[];
  const links = Object.fromEntries(rows.map((r) => [r.provider, r.account_label || true]));
  return Response.json({
    id: user.userId,
    email: user.email,
    role: user.role,
    displayName: user.displayName,
    links: {
      google: links.google ?? false,
      microsoft: links.microsoft ?? false,
      notion: links.notion ?? false,
      zoho: links.zoho ?? false,
      mailbox: links.mailbox ?? false,
      icloud: links.icloud ?? false,
    },
  });
};
