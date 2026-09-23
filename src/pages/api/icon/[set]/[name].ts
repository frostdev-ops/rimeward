import type { APIRoute } from 'astro';
import { ICON_NAME_RE, ICON_SETS, type IconSet } from '../../../../lib/icon-names.ts';
import { iconSvg } from '../../../../lib/icons.ts';

export const prerender = false;

/** GET /api/icon/<set>/<name>?s=<style>&sw=<stroke>&still=1 → image/svg+xml. */
export const GET: APIRoute = ({ params, url }) => {
  const set = params.set as IconSet;
  const name = params.name ?? '';
  if (!(set in ICON_SETS) || !ICON_NAME_RE.test(name)) return new Response(null, { status: 404 });
  const sw = Number(url.searchParams.get('sw'));
  const stroke = Number.isFinite(sw) && sw > 0 ? Math.min(Math.max(sw, 0.5), 4) : undefined;
  const svg = iconSvg(set, name, url.searchParams.get('s') ?? '', stroke, url.searchParams.get('still') === '1');
  if (!svg) return new Response(null, { status: 404 });
  return new Response(svg, {
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'private, max-age=31536000, immutable' },
  });
};
