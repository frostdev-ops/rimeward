import type { APIRoute } from 'astro';
import { cardsFromLines, saveSite } from '../../../lib/site.ts';

export const prerender = false;

/** The admin page's Site form: name, tagline, footer, one card per line. */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const field = (k: string) => String(form.get(k) ?? '');
  try {
    saveSite({ name: field('name'), tagline: field('tagline'), footer: field('footer'), cards: cardsFromLines(field('cards')), links: form.has('links') });
  } catch (err) {
    return redirect(`/admin/users?err=${encodeURIComponent((err as Error).message)}`, 303);
  }
  return redirect('/admin/users?ok=site', 303);
};
