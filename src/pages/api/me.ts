import type { APIRoute } from 'astro';
import { getDb } from '../../lib/db.ts';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user!;
  // Inside a share the principal is the owner: say who is looking and what they may do, never the owner's accounts.
  if (locals.share) {
    const s = locals.share;
    return Response.json({ id: s.viewer ?? 0, email: '', role: 'member', displayName: s.viewerName ?? 'Guest',
      links: { google: false, microsoft: false, notion: false, zoho: false, mailbox: false, icloud: false },
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
