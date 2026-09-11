import type { APIRoute } from 'astro';
import { desktopVersion, latestReleases, newer } from '../../../lib/updates.ts';

export const prerender = false;

/** What the desktop app asks its bundled runtime: is a newer desktop release
 *  published, and where is its signed updater manifest (latest.json). The app
 *  hands that https URL to tauri-plugin-updater, which verifies the manifest's
 *  signature and downloads the bundle itself. Only a desktop's runtime answers. */
export const GET: APIRoute = async () => {
  const current = desktopVersion();
  if (!current) return new Response('Not a desktop runtime', { status: 404 });
  const { desktop, error } = await latestReleases();
  return Response.json(
    {
      current,
      latest: desktop?.version ?? null,
      available: newer(desktop?.version, current),
      url: desktop?.url ?? null,
      notes: desktop?.notes ?? null,
      manifest: desktop?.assets['latest.json'] ?? null,
      error: error ?? null,
    },
    { headers: { 'cache-control': 'no-store' } }
  );
};
