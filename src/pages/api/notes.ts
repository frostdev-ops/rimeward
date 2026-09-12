import type { APIRoute } from 'astro';
import { listDocuments, notebookIdOf } from '../../lib/notebook.ts';

export const prerender = false;

// Every live note document of this user's, as id + title + home notebook —
// what the Notepad's Configure picker ("Document") and the editor's [[link]]
// lookup list. `q` narrows by full-text prefix match; never bodies; bounded.
// Standalone and notebook notes alike, templates and the trash left out.
export const GET: APIRoute = ({ url, locals }) => {
  const userId = locals.user!.userId;
  const q = url.searchParams.get('q')?.trim().slice(0, 200) || undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
  let notes = listDocuments(userId, q, limit);
  // Inside a share, only what is filed in a shared notebook may be linked.
  if (locals.share) {
    const books = new Set(locals.share.wards.filter((w) => w.type === 'notebook').map(notebookIdOf));
    notes = notes.filter((n) => n.notebook !== null && books.has(n.notebook));
  }
  return Response.json({ notes }, { headers: { 'cache-control': 'no-store' } });
};
