import { createHash } from 'node:crypto';
import { MAX_WARDS, MAX_WARDS_PER_PAGE, pageOf, validateLayout, type PageDef, type WardInstance } from '../wards.ts';
import { WORKSPACE_CONSUMERS, validateWorkspaceDefinition, type WorkspaceDefinition } from './workspace-contract.ts';

/** Input supplied by the owning runtime. An absent views map means its saved selection is unknown. */
export interface LegacyWorkspaceOwner {
  runtimeId: string;
  online: boolean;
  projects?: { id: string; name: string }[];
  views?: Record<string, { project?: string; session?: string }>;
  sessions?: { id: string; project: string }[];
}
export interface WorkspaceMigration {
  layout: WardInstance[];
  pages: PageDef[];
  pending: { ward: string; runtimeId: string; reason: string }[];
  /** Stamp session ownership separately; this migration never moves native content. */
  owners: { ward: string; runtimeId: string }[];
  changed: boolean;
}

/** Pure, idempotent layout migration; buffer/session/project IDs stay exactly as they were. */
export function migrateProjectWorkspaces(
  layout: WardInstance[], pages: PageDef[], owners: LegacyWorkspaceOwner[], currentRuntimeId: string,
): WorkspaceMigration {
  const firstPage = pages[0];
  if (!firstPage) throw Error('Workspace migration requires the existing dashboard pages.');
  const next = structuredClone(layout), nextPages = structuredClone(pages);
  const pending: WorkspaceMigration['pending'] = [], placements: WorkspaceMigration['owners'] = [];
  const consumers = next.filter(w => (WORKSPACE_CONSUMERS as readonly string[]).includes(w.type));
  for (const consumer of consumers) {
    const page = pages.find(p => p.id === pageOf(consumer, pages, layout));
    const runtimeId = consumer.device ?? (consumer.workspaceVersion === 1 ? undefined : page?.device) ?? currentRuntimeId;
    const owner = owners.find(o => o.runtimeId === runtimeId);
    const state = owner?.views?.[consumer.i];
    placements.push({ ward: consumer.i, runtimeId });
    if (consumer.workspaceVersion === 1 || consumer.workspace) { consumer.workspaceVersion = 1; continue; }
    if (!owner?.online || (consumer.type !== 'agent' && !owner.views)) {
      pending.push({ ward: consumer.i, runtimeId, reason: 'Waiting for the original runtime to read its saved workspace selection.' });
      continue;
    }
    const sessionProject = state?.session && owner.sessions?.find(s => s.id === state.session)?.project;
    const project = state?.project || sessionProject || page?.project;
    if (!project) { consumer.workspaceVersion = 1; continue; } // Never use projects[0].
    const root = owner.projects?.find(p => p.id === project);
    if (!root) { pending.push({ ward: consumer.i, runtimeId, reason: 'The original folder registration is unavailable.' }); continue; }
    let workspace = next.find(w => {
      if (w.type !== 'workspace') return false;
      try { const d = validateWorkspaceDefinition(w.config); return d.mounts.some(m => m.mountPath === '/' && m.runtimeId === runtimeId && m.rootId === root.id); }
      catch { return false; }
    });
    if (!workspace) {
      const id = `ws${createHash('sha256').update(`${runtimeId}\0${root.id}`).digest('hex').slice(0, 24)}`;
      if (next.some(w => w.i === id)) { pending.push({ ward: consumer.i, runtimeId, reason: 'A workspace migration ID conflicts with an existing ward.' }); continue; }
      const destination = page?.id ?? firstPage.id;
      if (next.length >= MAX_WARDS || next.filter(w => pageOf(w, pages, next) === destination).length >= MAX_WARDS_PER_PAGE) {
        pending.push({ ward: consumer.i, runtimeId, reason: 'Make room for a Workspace ward on this page to finish the upgrade.' }); continue;
      }
      const definition: WorkspaceDefinition = { workspaceId: `migrated:${id}`, revision: 1, mounts: [{ id: 'primary', mountPath: '/', runtimeId, rootId: root.id }] };
      workspace = { i: id, type: 'workspace', size: '3x3', title: root.name.slice(0, 60), config: { ...definition }, ...(destination === firstPage.id ? {} : { page: destination }) };
      next.push(workspace);
    }
    consumer.workspace = workspace.i;
    consumer.workspaceVersion = 1;
  }
  // Preserve legacy opaque metadata until every affected ward's original runtime has answered.
  for (const page of nextPages) {
    if (!page.project) continue;
    const affected = consumers.filter(w => pageOf(w, pages, next) === page.id);
    if (affected.length && !affected.some(w => pending.some(p => p.ward === w.i))) delete page.project;
  }
  const valid = validateLayout(next, nextPages);
  if (!valid) throw Error('Workspace migration would invalidate the dashboard. The original layout must be preserved.');
  return { layout: valid, pages: nextPages, pending, owners: placements, changed: JSON.stringify(valid) !== JSON.stringify(layout) || JSON.stringify(nextPages) !== JSON.stringify(pages) };
}

export const WORKSPACE_FORMAT = 1;
export const WORKSPACE_FORMAT_HEADER = 'x-rimeward-workspace-format';
/** Must run on raw input before an older validator can discard new ward types or links. */
export function requireWorkspaceLayoutVersion(layout: unknown, version: unknown): void {
  if (Array.isArray(layout) && layout.some(w => w?.type === 'workspace' || w?.workspace !== undefined || w?.workspaceVersion !== undefined) && String(version) !== String(WORKSPACE_FORMAT))
    throw Object.assign(Error('Update Rimeward before syncing workspace connections. The dashboard is preserved.'), { status: 426 });
}
