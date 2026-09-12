// What a share may touch in the owner's Notion: only what its wards show. The
// allowlist (shares.ts) admits the routes by ward type; these answer the per-id
// questions the routes then ask — is this page, data source or block one of the
// shared wards' own? — from the wards' config and the same cached reads the wards
// render from, so a request naming any OTHER page of the owner's workspace is
// refused before Notion hears of it. Every lookup fails closed.
import { notionBlocks, notionRows, taskWardSource } from './notion.ts';
import type { ShareLocals } from './shares.ts';
import { TASK_WARDS, notionIdFrom as rawId } from './wards.ts';

/** A Notion id in one spelling (Notion writes them lowercase; a caller may not). */
const notionIdFrom = (v: unknown): string | null => rawId(v)?.toLowerCase() ?? null;

/** The page ids the share's Page wards are configured on (normalised). */
const configuredPages = (share: ShareLocals): string[] =>
  share.wards.filter((w) => w.type === 'notion-page').map((w) => notionIdFrom(w.config?.page)).filter((p): p is string => !!p);

/** A task ward of the share, by id — what /api/checklist and /api/notion/source?ward= may name. */
export const shareNotionWard = (share: ShareLocals, ward: unknown): boolean =>
  typeof ward === 'string' && share.wards.some((w) => w.i === ward && TASK_WARDS.has(w.type));

/** The data sources behind the share's database wards. */
export async function shareNotionSources(share: ShareLocals, owner: number): Promise<Set<string>> {
  const out = new Set<string>();
  for (const w of share.wards) {
    if (!TASK_WARDS.has(w.type)) continue;
    try { const id = await taskWardSource(owner, w.i); if (id) out.add(id); } catch { /* closed */ }
  }
  return out;
}
export const shareNotionSource = async (share: ShareLocals, owner: number, sourceId: string): Promise<boolean> => (await shareNotionSources(share, owner)).has(sourceId);

/** A page the share shows: a Page ward's own page, or a row of a shared database. */
export async function shareNotionPage(share: ShareLocals, owner: number, pageId: string): Promise<boolean> {
  const id = notionIdFrom(pageId);
  if (!id) return false;
  if (configuredPages(share).includes(id)) return true;
  for (const source of await shareNotionSources(share, owner)) {
    try { if ((await notionRows(owner, source)).some((r) => notionIdFrom(r.id) === id)) return true; } catch { /* closed */ }
  }
  return false;
}

/** A block inside a shared page — as deep as the ward reads (the same cached tree it renders). */
export async function shareNotionBlock(share: ShareLocals, owner: number, blockId: string): Promise<boolean> {
  const id = notionIdFrom(blockId);
  if (!id) return false;
  for (const w of share.wards) {
    if (w.type !== 'notion-page') continue;
    const page = notionIdFrom(w.config?.page);
    if (!page) continue;
    if (page === id) return true;
    const depth = Math.min(Math.max(Number(w.config?.depth ?? 2), 0), 4);
    try { if ((await notionBlocks(owner, page, depth)).some((b) => notionIdFrom(b.id) === id)) return true; } catch { /* closed */ }
  }
  return false;
}

export const notShared = (): Error & { status: number } => Object.assign(new Error('not in this share'), { status: 403 });
