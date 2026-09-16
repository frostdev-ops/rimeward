import { getDb } from '../db.ts';
import { getDashboard } from '../dashboard.ts';
import { getSetting } from '../settings.ts';
import { isDesktop, DevError } from './runtime.ts';
import { instanceRequest, rimeConnection } from './remote.ts';
import { workspaceDispatch } from './workspaces.ts';
import { parseNode, type Node } from './terminal-layout.ts';
import { workspacePath, validateWorkspaceDefinition, workspaceFingerprint, type WorkspaceBinding } from './workspace-contract.ts';

export interface TerminalPlacement {
  runtimeId: string;
  rootId: string;
  sessionId: string;
  virtualCwd: string;
  originWard?: string;
  workspace?: WorkspaceBinding;
  title?: string;
  kind?: 'shell' | 'codex' | 'claude';
  state?: string;
  version?: number;
}
export interface TerminalPlacementView { project?: string; session?: string; tabs?: string[]; closedSessions?: string[]; groups?: Node[] }
export interface TerminalPlacements { placements: TerminalPlacement[]; view?: TerminalPlacementView; revision?: number; offline?: boolean }
const idPattern = /^[a-zA-Z0-9][\w:.-]{0,159}$/;
const sessionPattern = /^[\w-]{1,64}$/;
function assertWard(user: number, ward: string) {
  if (!getDashboard(user).some(w => w.i === ward && w.type === 'terminal')) throw new DevError('Terminal ward not found.', 404);
}
function bindingView(raw: WorkspaceBinding | undefined, ward: string): WorkspaceBinding | undefined {
  if (!raw) return;
  const definition = validateWorkspaceDefinition(raw);
  if (raw.consumerWardId !== ward || !idPattern.test(raw.runOwnerRuntimeId) || workspaceFingerprint(definition) !== raw.definitionFingerprint) throw new DevError('Invalid saved terminal binding.');
  return { ...definition, consumerWardId: ward, runOwnerRuntimeId: raw.runOwnerRuntimeId, definitionFingerprint: raw.definitionFingerprint, cwd: workspacePath(raw.cwd) };
}
/** Only navigation metadata can travel; no terminal screen, command, credential or file text. */
export function terminalPlacementView(raw: unknown): TerminalPlacementView {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DevError('Invalid terminal view.');
  const v = raw as Record<string, unknown>, out: TerminalPlacementView = {};
  if (v.project !== undefined) { if (typeof v.project !== 'string' || !idPattern.test(v.project)) throw new DevError('Invalid terminal folder reference.'); out.project = v.project; }
  if (v.session !== undefined) { if (typeof v.session !== 'string' || !sessionPattern.test(v.session)) throw new DevError('Invalid terminal session reference.'); out.session = v.session; }
  for (const key of ['tabs', 'closedSessions'] as const) if (v[key] !== undefined) {
    if (!Array.isArray(v[key]) || v[key].length > 500 || v[key].some(id => typeof id !== 'string' || !sessionPattern.test(id))) throw new DevError('Invalid terminal tabs.');
    out[key] = [...new Set(v[key] as string[])];
  }
  if (v.groups !== undefined) {
    if (!Array.isArray(v.groups) || v.groups.length > 500) throw new DevError('Invalid terminal pane groups.');
    out.groups = v.groups.map(raw => { const node = parseNode(raw); if (!node) throw new DevError('Invalid terminal pane tree.'); return node; });
  }
  if (JSON.stringify(out).length > 32768) throw new DevError('Terminal view exceeds the metadata limit.');
  return out;
}
function storePlacement(user: number, ward: string, placement: TerminalPlacement): void {
  const previous = getDb().prepare('SELECT runtime_id,root_id FROM terminal_placements WHERE user_id=? AND session_id=?').all(user, placement.sessionId) as { runtime_id: string; root_id: string }[];
  if (previous.some(old => old.root_id !== placement.rootId || (old.runtime_id !== placement.runtimeId && getSetting(`agent-runtime-alias:${user}:${old.runtime_id}`) !== placement.runtimeId))) throw new DevError('A saved terminal session cannot change its source.', 409);
  getDb().prepare('INSERT INTO terminal_placements(user_id,ward,session_id,runtime_id,root_id,json,version) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,ward,session_id) DO UPDATE SET runtime_id=excluded.runtime_id,json=excluded.json,version=MAX(terminal_placements.version,excluded.version)').run(user, ward, placement.sessionId, placement.runtimeId, placement.rootId, JSON.stringify(placement), placement.version ?? 1);
}
function localPlacements(user: number, ward: string): TerminalPlacements {
  const placements = (getDb().prepare('SELECT json,version FROM terminal_placements WHERE user_id=? AND ward=? ORDER BY rowid').all(user, ward) as { json: string; version: number }[]).map(row => ({ ...JSON.parse(row.json), version: row.version }) as TerminalPlacement);
  const view = getDb().prepare('SELECT json,revision FROM terminal_placement_views WHERE user_id=? AND ward=?').get(user, ward) as { json: string; revision: number } | undefined;
  return { placements, ...(view ? { view: terminalPlacementView(JSON.parse(view.json)), revision: view.revision } : {}) };
}
function storeView(user: number, ward: string, view: TerminalPlacementView): void {
  getDb().prepare('INSERT INTO terminal_placement_views(user_id,ward,json,pending) VALUES(?,?,?,?) ON CONFLICT(user_id,ward) DO UPDATE SET json=excluded.json,pending=excluded.pending,revision=terminal_placement_views.revision+1').run(user, ward, JSON.stringify(view), Number(isDesktop()));
}
const markViewPublished = (user: number, ward: string, view: TerminalPlacementView) => getDb().prepare('UPDATE terminal_placement_views SET pending=0 WHERE user_id=? AND ward=? AND json=?').run(user, ward, JSON.stringify(view));
async function verifyPlacement(user: number, ward: string, raw: TerminalPlacement): Promise<TerminalPlacement> {
  if (!raw || !idPattern.test(raw.runtimeId) || !idPattern.test(raw.rootId) || !sessionPattern.test(raw.sessionId)) throw new DevError('Invalid terminal source reference.');
  const proof = await workspaceDispatch(user, raw.runtimeId, 'operation', { rootId: raw.rootId, operation: 'terminal-placement-read', args: { session: raw.sessionId, ward }, owner: 'client:placement' });
  const layout = getDashboard(user), viewer = layout.find(w => w.i === ward), target = viewer?.workspace && layout.find(w => w.i === viewer.workspace && w.type === 'workspace');
  const sharedRoot = !!target && validateWorkspaceDefinition(target.config).mounts.some(m => m.runtimeId === raw.runtimeId && m.rootId === raw.rootId);
  if (proof.sessionId !== raw.sessionId || proof.rootId !== raw.rootId || (proof.originWard !== ward && proof.associated !== true && !sharedRoot)) throw new DevError('The source did not confirm this terminal belongs to the ward or its Workspace.', 403);
  const originalBinding = proof.workspace ? bindingView(proof.workspace, String(proof.workspace.consumerWardId)) : undefined;
  const workspace = originalBinding ? { ...originalBinding, consumerWardId: ward } : undefined;
  return { runtimeId: raw.runtimeId, rootId: raw.rootId, sessionId: raw.sessionId, virtualCwd: workspacePath(proof.virtualCwd ?? raw.virtualCwd),
    ...(typeof proof.originWard === 'string' && proof.originWard ? { originWard: proof.originWard } : {}),
    ...(workspace ? { workspace } : {}), ...(typeof proof.title === 'string' ? { title: proof.title.slice(0, 200) } : {}),
    ...(['shell', 'codex', 'claude'].includes(proof.kind) ? { kind: proof.kind } : {}), ...(typeof proof.state === 'string' ? { state: proof.state.slice(0, 40) } : {}) };
}
async function remoteRequest<T>(user: number, body: Record<string, unknown>): Promise<T> {
  const response = await instanceRequest(user, '/api/terminal-placement', new Request('https://rimeward.invalid/api/terminal-placement', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const value = await response.json().catch(() => null); if (!response.ok || !value) throw new DevError(value?.error ?? 'Terminal directory unavailable.', response.status >= 400 ? response.status : 502); return value;
}
export async function terminalPlacementAction(user: number, body: Record<string, unknown>): Promise<TerminalPlacements> {
  if (isDesktop()) throw new DevError('The connected server owns the terminal directory.', 409);
  const ward = String(body.ward ?? ''); assertWard(user, ward);
  if (body.action === 'publish') {
    const verified = await verifyPlacement(user, ward, body.placement as TerminalPlacement);
    const current = localPlacements(user, ward).placements.find(p => p.sessionId === verified.sessionId);
    storePlacement(user, ward, { ...verified, version: (current?.version ?? 0) + 1 });
    if (body.view !== undefined) storeView(user, ward, terminalPlacementView(body.view));
  } else if (body.action === 'view') storeView(user, ward, terminalPlacementView(body.view));
  else if (body.action === 'remove') {
    const ref = localPlacements(user, ward).placements.find(p => p.sessionId === body.sessionId);
    if (ref) {
      let missing = false;
      try { await verifyPlacement(user, ward, ref); }
      catch (error) { if ((error as { status?: number }).status !== 404) throw error; missing = true; }
      if (!missing) throw new DevError('Delete the stopped session on its original runtime first.', 409);
      getDb().prepare('DELETE FROM terminal_placements WHERE user_id=? AND session_id=?').run(user, ref.sessionId);
    }
  }
  else if (body.action !== 'read') throw new DevError('Unknown terminal directory action.');
  return localPlacements(user, ward);
}
export async function publishTerminalPlacement(user: number, ward: string, placement: TerminalPlacement, view?: unknown): Promise<void> {
  assertWard(user, ward);
  const verified = await verifyPlacement(user, ward, placement), normalized = view === undefined ? undefined : terminalPlacementView(view);
  storePlacement(user, ward, verified); if (normalized) storeView(user, ward, normalized);
  if (isDesktop() && await rimeConnection(user).catch(() => undefined)) {
    try { const saved = await remoteRequest<TerminalPlacements>(user, { action: 'publish', ward, placement: verified, ...(normalized ? { view: normalized } : {}) }); for (const ref of saved.placements) storePlacement(user, ward, ref); if (normalized) markViewPublished(user, ward, normalized); }
    catch (error) { if (error instanceof DevError && [400, 403, 409].includes(error.status)) throw error; }
  }
}
export async function readTerminalPlacements(user: number, ward: string): Promise<TerminalPlacements> {
  assertWard(user, ward); const local = localPlacements(user, ward);
  if (!isDesktop() || !(await rimeConnection(user).catch(() => undefined))) return local;
  try {
    const pending = getDb().prepare('SELECT pending FROM terminal_placement_views WHERE user_id=? AND ward=?').get(user, ward) as { pending: number } | undefined;
    if (pending?.pending && local.view) { await remoteRequest(user, { action: 'view', ward, view: local.view }); markViewPublished(user, ward, local.view); }
    let remote = await remoteRequest<TerminalPlacements>(user, { action: 'read', ward });
    for (const ref of local.placements.filter(local => !remote.placements.some(saved => saved.sessionId === local.sessionId))) {
      try { remote = await remoteRequest<TerminalPlacements>(user, { action: 'publish', ward, placement: ref }); }
      catch (error) { if (error instanceof DevError && [400, 403, 409].includes(error.status)) throw error; }
    }
    for (const ref of remote.placements) storePlacement(user, ward, ref);
    const latest = localPlacements(user, ward);
    const unchanged = latest.revision === local.revision && JSON.stringify(latest.view) === JSON.stringify(local.view);
    if (remote.view && unchanged) { storeView(user, ward, terminalPlacementView(remote.view)); markViewPublished(user, ward, remote.view); }
    return { ...localPlacements(user, ward), ...(remote.view && unchanged ? { view: remote.view, revision: remote.revision } : {}) };
  } catch { return { ...local, offline: true }; }
}
export async function saveTerminalPlacementView(user: number, ward: string, value: unknown): Promise<void> {
  assertWard(user, ward); const view = terminalPlacementView(value); storeView(user, ward, view);
  if (isDesktop() && await rimeConnection(user).catch(() => undefined)) {
    try { await remoteRequest<TerminalPlacements>(user, { action: 'view', ward, view }); markViewPublished(user, ward, view); }
    catch (error) { if (error instanceof DevError && [400, 403, 409].includes(error.status)) throw error; }
  }
}

export async function forgetTerminalPlacement(user: number, ward: string, sessionId: string): Promise<void> {
  assertWard(user, ward);
  if (isDesktop() && await rimeConnection(user).catch(() => undefined)) await remoteRequest(user, { action: 'remove', ward, sessionId });
  else if (!isDesktop()) await terminalPlacementAction(user, { action: 'remove', ward, sessionId });
  getDb().prepare('DELETE FROM terminal_placements WHERE user_id=? AND session_id=?').run(user, sessionId);
}
