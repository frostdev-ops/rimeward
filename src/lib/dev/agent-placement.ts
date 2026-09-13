import type { APIContext } from 'astro';
import { getDb } from '../db.ts';
import { getDashboard, getPages } from '../dashboard.ts';
import { getSetting, setSetting } from '../settings.ts';
import { pageOf } from '../wards.ts';
import { activeConversation, activeConversationRow, stampConversationOwner } from '../agent/conversations.ts';
import { agentWardConfig } from '../agent/ward-config.ts';
import { currentRuntimeId } from './workspaces.ts';
import { isDesktop, DevError } from './runtime.ts';
import { instanceRequest, rimeConnection } from './remote.ts';
import { relayRequest, listDevices } from './devices.ts';

interface Placement { runtime_id: string; transition_id: string | null; target_runtime_id: string | null; directory_version: number; last_transition_id: string | null }
interface Receipt { id: string; ward: string; source_runtime_id: string; target_runtime_id: string; source_conversation: number | null; destination_conversation: number | null; directory_version: number; phase: 'retired' | 'created' | 'complete' }
interface Directory { runtime_id: string; version: number; transition_id: string | null }
const runtimePattern = /^(?:server|[a-f0-9-]{36})$/i;
const operationPattern = /^[a-f0-9-]{36}$/i;
const record = (user: number, ward: string) => getDb().prepare('SELECT * FROM agent_placements WHERE user_id=? AND ward=?').get(user, ward) as Placement | undefined;
const canonicalRuntime = (user: number, runtime: string) => {
  const seen = new Set<string>(); let current = runtime;
  for (;;) { if (seen.has(current) || seen.size > 8) throw new DevError('Agent runtime aliases need reconciliation.', 409); seen.add(current); const next = getSetting(`agent-runtime-alias:${user}:${current}`); if (!next) return current; current = next; }
};
const receipt = (user: number, id: string) => {
  const value = getDb().prepare('SELECT id,ward,source_runtime_id,target_runtime_id,source_conversation,destination_conversation,directory_version,phase FROM agent_placement_receipts WHERE user_id=? AND id=?').get(user, id) as Receipt | undefined;
  return value ? { ...value, source_runtime_id: canonicalRuntime(user, value.source_runtime_id), target_runtime_id: canonicalRuntime(user, value.target_runtime_id) } : undefined;
};

/** Pairing may replace the route ID of this same installation; history ownership is never rewritten. */
export function remapLocalAgentRuntime(user: number, before: string, after: string): void {
  if (before === after) return;
  if (!operationPattern.test(before) || !operationPattern.test(after)) throw new DevError('Only an installation pairing alias can be remapped.');
  getDb().transaction(() => {
    setSetting(`agent-runtime-alias:${user}:${before}`, after);
    getDb().prepare('UPDATE agent_placements SET runtime_id=? WHERE user_id=? AND runtime_id=?').run(after, user, before);
    getDb().prepare('UPDATE agent_placements SET target_runtime_id=? WHERE user_id=? AND target_runtime_id=?').run(after, user, before);
  })();
}

/** Migration records routing hints even for a projectless conversation; it never moves a session. */
export function recordLegacyAgentPlacement(user: number, ward: string, runtimeId: string): void {
  if (!getDashboard(user).some(w => w.i === ward && w.type === 'agent')) return;
  // A worker owns native filesystem execution, while the ordinary server owns its agent coordinator.
  const owner = runtimeId.startsWith('worker:') ? 'server' : runtimeId;
  if (!runtimePattern.test(owner)) throw new DevError('Invalid agent runtime.');
  getDb().prepare('INSERT OR IGNORE INTO agent_placements(user_id,ward,runtime_id) VALUES(?,?,?)').run(user, ward, owner);
  if (!isDesktop()) {
    getDb().prepare('INSERT OR IGNORE INTO agent_placement_directory(user_id,ward,runtime_id,version) VALUES(?,?,?,1)').run(user, ward, owner);
    getDb().prepare('UPDATE agent_placements SET directory_version=1 WHERE user_id=? AND ward=? AND directory_version=0').run(user, ward);
  }
}

const directoryRow = (user: number, ward: string) => getDb().prepare('SELECT runtime_id,version,transition_id FROM agent_placement_directory WHERE user_id=? AND ward=?').get(user, ward) as Directory | undefined;

/** The connected server is the account's owner directory; native file roots are not stored here. */
export async function agentDirectoryAction(user: number, input: Record<string, unknown>): Promise<Directory> {
  if (isDesktop()) throw new DevError('The connected server owns the agent directory.', 409);
  if (!['directory-read', 'directory-birth', 'directory-publish'].includes(String(input.action))) throw new DevError('Unknown agent directory operation.');
  const ward = String(input.ward ?? ''); if (!/^[a-z0-9-]{1,32}$/.test(ward)) throw new DevError('Invalid agent ward.');
  let current = directoryRow(user, ward);
  if (input.action === 'directory-publish') {
    const source = String(input.sourceRuntimeId ?? ''), id = String(input.idempotencyKey ?? '');
    if (!runtimePattern.test(source) || !operationPattern.test(id)) throw new DevError('Invalid owner publication.');
    const proof = await callRuntime(user, source, { action: 'receipt', ward, idempotencyKey: id });
    assertReceipt(proof, ward, source);
    if (proof.phase !== 'complete' || !proof.destination_conversation || proof.directory_version < 2) throw new DevError('The original runtime has not confirmed this transition.', 409);
    if (proof.target_runtime_id !== 'server' && !listDevices(user).some(d => d.id === proof.target_runtime_id)) throw new DevError('Agent destination is not connected to this account.', 403);
    getDb().transaction(() => {
      current = directoryRow(user, ward);
      if (current && current.version > proof.directory_version) return;
      if (current?.version === proof.directory_version && current.runtime_id === proof.target_runtime_id && current.transition_id === id) return;
      if (!current || current.runtime_id !== proof.source_runtime_id || current.version !== proof.directory_version - 1) throw new DevError('Agent owner directory changed during this transition.', 409);
      getDb().prepare('UPDATE agent_placement_directory SET runtime_id=?,version=?,transition_id=? WHERE user_id=? AND ward=?').run(proof.target_runtime_id, proof.directory_version, id, user, ward);
      current = { runtime_id: proof.target_runtime_id, version: proof.directory_version, transition_id: id };
    })();
    if (!current) throw new DevError('Agent directory unavailable.', 503); return current;
  }
  if (current) {
    if (input.action === 'directory-birth' && current.runtime_id !== input.runtimeId) throw new DevError('This agent already belongs to another runtime.', 409);
    return current;
  }
  const layout = getDashboard(user), w = layout.find(w => w.i === ward && w.type === 'agent');
  const pages = getPages(user), legacy = w?.device ?? (w ? pages.find(p => p.id === pageOf(w, pages, layout))?.device : undefined) ?? 'server';
  const owner = input.action === 'directory-birth' ? String(input.runtimeId ?? '') : legacy;
  if ((!w && input.action !== 'directory-birth') || !runtimePattern.test(owner)) throw new DevError('Agent directory entry not found.', 404);
  if (owner !== 'server' && !listDevices(user).some(d => d.id === owner)) throw new DevError('Agent runtime is not connected to this account.', 403);
  if (w && input.action === 'directory-birth' && legacy !== owner) throw new DevError('The saved agent has a different original runtime.', 409);
  getDb().prepare('INSERT OR IGNORE INTO agent_placement_directory(user_id,ward,runtime_id,version) VALUES(?,?,?,1)').run(user, ward, owner);
  const created = directoryRow(user, ward); if (!created) throw new DevError('Could not publish agent owner.', 503); return created;
}

async function directoryRequest(user: number, input: Record<string, unknown>): Promise<Directory> {
  if (!isDesktop()) return agentDirectoryAction(user, input);
  const response = await instanceRequest(user, '/api/agent-placement', new Request('https://rimeward.invalid/api/agent-placement', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
  const value = await response.json().catch(() => null);
  if (!response.ok || !value) throw new DevError(value?.error ?? 'Agent owner directory unavailable.', response.status >= 400 ? response.status : 502);
  return value;
}

export async function publishAgentBirth(user: number, ward: string, runtimeId: string): Promise<void> {
  recordLegacyAgentPlacement(user, ward, runtimeId);
  if (isDesktop() && !(await rimeConnection(user).catch(() => undefined))) return;
  try {
    const published = await directoryRequest(user, { action: 'directory-birth', ward, runtimeId });
    getDb().prepare('UPDATE agent_placements SET directory_version=? WHERE user_id=? AND ward=? AND runtime_id=? AND transition_id IS NULL').run(published.version, user, ward, runtimeId);
  } catch (error) {
    // A locally owned, unsynchronized ward can keep working offline. Its opaque device birth hint travels with the dashboard.
    if (error instanceof DevError && [403, 409].includes(error.status)) throw error;
  }
}

export async function agentPlacement(user: number, ward: string, refreshOwn = false): Promise<Placement> {
  const saved = record(user, ward), own = await currentRuntimeId(user);
  if (saved?.transition_id) return saved;
  const connected = isDesktop() ? await rimeConnection(user).catch(() => undefined) : undefined;
  if (saved?.runtime_id === own && !refreshOwn) {
    if (!saved.directory_version && connected) await publishAgentBirth(user, ward, own);
    return record(user, ward) ?? saved;
  }
  if (!isDesktop() || connected) {
    const canonical = await directoryRequest(user, { action: 'directory-read', ward });
    if (saved && canonical.version < saved.directory_version) return saved; // A confirmed source retirement may be waiting for publication.
    if (saved && canonical.version === saved.directory_version && canonical.runtime_id !== saved.runtime_id) throw new DevError('Conflicting agent owner records need reconciliation.', 409);
    getDb().prepare('INSERT INTO agent_placements(user_id,ward,runtime_id,directory_version,last_transition_id) VALUES(?,?,?,?,?) ON CONFLICT(user_id,ward) DO UPDATE SET runtime_id=excluded.runtime_id,directory_version=excluded.directory_version,last_transition_id=excluded.last_transition_id WHERE agent_placements.transition_id IS NULL').run(user, ward, canonical.runtime_id, canonical.version, canonical.transition_id);
    const refreshed = record(user, ward); if (refreshed) return refreshed;
  }
  if (saved) return saved;
  const layout = getDashboard(user), w = layout.find(w => w.i === ward && w.type === 'agent');
  if (!w) throw new DevError('Agent ward not found.', 404);
  const pages = getPages(user);
  const legacy = getSetting(`workspace:legacy-owner:${user}:${ward}`) ?? w.device ?? pages.find(p => p.id === pageOf(w, pages, layout))?.device;
  recordLegacyAgentPlacement(user, ward, legacy ?? own);
  const initialized = record(user, ward); if (!initialized) throw new DevError('Agent owner could not be recorded.', 503);
  return initialized;
}

/** Runs and queued wakes check this before opening any conversation or making model calls. */
export async function assertAgentRunsHere(user: number, ward: string): Promise<string> {
  const placement = await agentPlacement(user, ward), own = await currentRuntimeId(user);
  if (placement.transition_id) throw new DevError('A new conversation is being reconciled. Retry New chat to check its receipt.', 409);
  if (placement.runtime_id !== own) throw new DevError(`This agent belongs to ${placement.runtime_id}; the original runtime must handle it.`, 409);
  return own;
}

async function callRuntime(user: number, runtime: string, value: Record<string, unknown>): Promise<Receipt> {
  runtime = canonicalRuntime(user, runtime);
  if (runtime === await currentRuntimeId(user)) return agentPlacementAction(user, value);
  const request = new Request('https://rimeward.invalid/api/agent-placement', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const response = runtime === 'server' && isDesktop() ? await instanceRequest(user, '/api/agent-placement', request)
    : isDesktop() ? await instanceRequest(user, `/runtime/${runtime}/api/agent-placement`, request)
    : await relayRequest(user, runtime, '/api/agent-placement', request);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new DevError(body?.error ?? 'Conversation transition is unconfirmed. Retry New chat to reconcile it.', response.status >= 400 ? response.status : 502);
  return body;
}

async function assertIdle(user: number, ward: string, moving = false): Promise<() => void> {
  const { wardBusy } = await import('../agent/core.ts');
  const check = () => {
    const jobs = getDb().prepare("SELECT 1 FROM agent_jobs WHERE user_id=? AND ward=? AND state IN ('running','stopping') LIMIT 1").get(user, ward);
    if (wardBusy(user, ward) || jobs) throw new DevError('Finish the active response and background jobs before starting a new conversation.', 409);
    if (moving && activeConversationRow(user, ward)?.pending_confirm_id) throw new DevError('Resolve the pending approval before starting a conversation on another machine.', 409);
  };
  check();
  if (moving) {
    const conv = activeConversationRow(user, ward), recorded = conv && getSetting(`agent_workspace:${conv.id}`);
    const api = await import('./workspaces.ts');
    const binding = recorded && recorded !== 'null' ? JSON.parse(recorded) : getDashboard(user).find(w => w.i === ward)?.workspace ? await api.resolveWorkspaceForWard(user, ward) : undefined;
    if (binding) for (const mount of binding.mounts) await api.workspaceDispatch(user, mount.runtimeId, 'operation', { rootId: mount.rootId, operation: 'guard', args: { workspaceId: binding.workspaceId }, owner: 'client:workspace' });
  }
  check();
  return check;
}
function assertReceipt(r: Receipt, ward: string, source?: string, target?: string): void {
  if (r.ward !== ward || (source && r.source_runtime_id !== source) || (target && r.target_runtime_id !== target)) throw new DevError('This conversation transition receipt belongs to another request.', 409);
}

/** Authenticated source/target operations. Persisted receipts make retrying a transition safe. */
export async function agentPlacementAction(user: number, input: Record<string, unknown>): Promise<Receipt> {
  const ward = String(input.ward ?? ''), id = String(input.idempotencyKey ?? '');
  if (!operationPattern.test(id) || !getDashboard(user).some(w => w.i === ward && w.type === 'agent')) throw new DevError('Invalid conversation transition.');
  const own = await currentRuntimeId(user), saved = receipt(user, id);
  if (saved) assertReceipt(saved, ward);
  if (input.action === 'receipt') {
    if (!saved || saved.source_runtime_id !== own) throw new DevError('Source receipt not found.', 404);
    return saved;
  }
  if (input.action === 'complete') {
    if (!saved || saved.source_runtime_id !== own || saved.target_runtime_id !== input.targetRuntimeId || !Number.isSafeInteger(input.conversation)) throw new DevError('Conversation completion receipt is invalid.', 409);
    if (saved.phase === 'complete') return saved;
    const state = record(user, ward);
    if (state?.transition_id !== id) throw new DevError('The source transition no longer matches.', 409);
    getDb().transaction(() => {
      getDb().prepare("UPDATE agent_placement_receipts SET phase='complete',destination_conversation=? WHERE user_id=? AND id=?").run(input.conversation, user, id);
      getDb().prepare('UPDATE agent_placements SET runtime_id=?,directory_version=?,last_transition_id=?,transition_id=NULL,target_runtime_id=NULL WHERE user_id=? AND ward=? AND transition_id=?').run(saved.target_runtime_id, saved.directory_version, id, user, ward, id);
    })();
    (await import('../logic-engine.ts')).broadcast(user, 'agent', { ward });
    return { ...saved, phase: 'complete', destination_conversation: Number(input.conversation) };
  }
  if (input.action !== 'retire') throw new DevError('Unknown conversation placement operation.');
  const target = canonicalRuntime(user, String(input.targetRuntimeId ?? ''));
  if (!runtimePattern.test(target)) throw new DevError('Invalid conversation destination.');
  if (saved) { assertReceipt(saved, ward, own, target); return saved; }
  const placement = await agentPlacement(user, ward, target !== own);
  if (placement.transition_id || placement.runtime_id !== own) throw new DevError('The conversation owner changed; reload before starting another conversation.', 409);
  if (input.expectedDirectoryVersion !== undefined && input.expectedDirectoryVersion !== placement.directory_version) throw new DevError('Agent owner version changed. Reopen the conversation.', 409);
  const recheckIdle = await assertIdle(user, ward, target !== own);
  const current = activeConversationRow(user, ward);
  if ((current?.id ?? null) !== (input.expectedConversation ?? null)) throw new DevError('The conversation changed. Reopen it before starting a new one.', 409);
  const cfg = agentWardConfig(user, ward); if (!cfg) throw new DevError('Agent unavailable.', 404);
  const { clearThread } = await import('../agent/core.ts');
  const version = placement.directory_version + (target === own ? 0 : 1);
  let next: number | null = null;
  getDb().transaction(() => {
    recheckIdle();
    if (record(user, ward)?.transition_id || record(user, ward)?.directory_version !== placement.directory_version || (activeConversationRow(user, ward)?.id ?? null) !== (current?.id ?? null)) throw new DevError('Conversation changed during checks.', 409);
    getDb().prepare('UPDATE agent_placements SET transition_id=?,target_runtime_id=? WHERE user_id=? AND ward=?').run(id, target, user, ward);
    clearThread(user, ward);
    if (target === own) { const conv = activeConversation(user, ward, cfg.provider, cfg.endpoint); stampConversationOwner(conv.id, own); next = conv.id; }
    getDb().prepare('INSERT INTO agent_placement_receipts(user_id,id,ward,source_runtime_id,target_runtime_id,source_conversation,destination_conversation,directory_version,phase) VALUES(?,?,?,?,?,?,?,?,?)').run(user, id, ward, own, target, current?.id ?? null, next, version, next === null ? 'retired' : 'complete');
    if (next !== null) getDb().prepare('UPDATE agent_placements SET transition_id=NULL,target_runtime_id=NULL WHERE user_id=? AND ward=?').run(user, ward);
  })();
  return { id, ward, source_runtime_id: own, target_runtime_id: target, source_conversation: current?.id ?? null, destination_conversation: next, directory_version: version, phase: next === null ? 'retired' : 'complete' };
}

export async function newAgentConversation(user: number, input: Record<string, unknown>): Promise<{ conversation: number; ownerRuntimeId: string; idempotencyKey: string }> {
  const ward = String(input.ward ?? ''), id = String(input.idempotencyKey ?? '');
  if (!operationPattern.test(id)) throw new DevError('A conversation request ID is required.');
  const w = getDashboard(user).find(w => w.i === ward && w.type === 'agent'); if (!w) throw new DevError('Agent ward not found.', 404);
  const own = await currentRuntimeId(user), placement = await agentPlacement(user, ward), localReceipt = receipt(user, id);
  if (localReceipt) assertReceipt(localReceipt, ward);
  const source = localReceipt?.source_runtime_id ?? placement.runtime_id;
  const target = localReceipt?.target_runtime_id ?? (w.workspace ? source : own);
  if (input.expectedOwnerRuntimeId !== undefined && canonicalRuntime(user, String(input.expectedOwnerRuntimeId)) !== source) throw new DevError('The conversation owner changed. Reload before starting a new one.', 409);
  let remote = localReceipt?.phase === 'created' || localReceipt?.phase === 'complete' ? localReceipt : await callRuntime(user, source, { action: 'retire', ward, idempotencyKey: id, targetRuntimeId: target, expectedConversation: input.expectedConversation ?? null, expectedDirectoryVersion: placement.directory_version });
  assertReceipt(remote, ward, source, target);
  if (source === target) {
    if (remote.destination_conversation === null || remote.phase !== 'complete') throw new DevError('Conversation creation is not confirmed.', 409);
    return { conversation: remote.destination_conversation, ownerRuntimeId: target, idempotencyKey: id };
  }
  if (target !== own) throw new DevError('Continue this new-conversation request from its destination machine.', 409);
  if (remote.phase === 'retired') {
    const recheckIdle = await assertIdle(user, ward, true);
    const cfg = agentWardConfig(user, ward); if (!cfg) throw new DevError('Agent unavailable.', 404);
    getDb().transaction(() => {
      recheckIdle();
      const saved = receipt(user, id); if (saved) { assertReceipt(saved, ward, source, target); remote = saved; return; }
      const current = activeConversationRow(user, ward);
      if (current) throw new DevError('An existing local conversation must be reconciled before creating another.', 409);
      const conv = activeConversation(user, ward, cfg.provider, cfg.endpoint); stampConversationOwner(conv.id, own);
      getDb().prepare('INSERT INTO agent_placement_receipts(user_id,id,ward,source_runtime_id,target_runtime_id,source_conversation,destination_conversation,directory_version,phase) VALUES(?,?,?,?,?,?,?,?,?)').run(user, id, ward, source, target, remote.source_conversation, conv.id, remote.directory_version, 'created');
      getDb().prepare('UPDATE agent_placements SET runtime_id=?,directory_version=?,transition_id=?,target_runtime_id=? WHERE user_id=? AND ward=?').run(own, remote.directory_version, id, own, user, ward);
      remote = { ...remote, destination_conversation: conv.id, phase: 'created' };
    })();
  }
  if (remote.destination_conversation === null) throw new DevError('Conversation creation is unconfirmed. Retry the same request.', 409);
  // The destination stays blocked until the source acknowledges forwarding to this exact new identity.
  const acknowledged = await callRuntime(user, source, { action: 'complete', ward, idempotencyKey: id, targetRuntimeId: target, conversation: remote.destination_conversation });
  assertReceipt(acknowledged, ward, source, target);
  if (acknowledged.phase !== 'complete' || acknowledged.destination_conversation !== remote.destination_conversation) throw new DevError('Source forwarding does not match the created conversation.', 409);
  await directoryRequest(user, { action: 'directory-publish', ward, sourceRuntimeId: source, idempotencyKey: id });
  getDb().transaction(() => {
    getDb().prepare("UPDATE agent_placement_receipts SET phase='complete' WHERE user_id=? AND id=?").run(user, id);
    getDb().prepare('UPDATE agent_placements SET transition_id=NULL,target_runtime_id=NULL WHERE user_id=? AND ward=? AND transition_id=?').run(user, ward, id);
  })();
  (await import('../logic-engine.ts')).broadcast(user, 'agent', { ward });
  return { conversation: remote.destination_conversation, ownerRuntimeId: target, idempotencyKey: id };
}

/** Resolve before the generic relayed-request stop: an old source may now forward to a new owner. */
export async function routeAgentPlacement(context: APIContext, ward: string): Promise<Response | undefined> {
  const user = context.locals.user?.userId;
  if (!user) throw new DevError('Sign in required.', 401);
  const placement = await agentPlacement(user, ward), own = await currentRuntimeId(user);
  if (placement.transition_id) return Response.json({ error: 'New conversation is not fully confirmed. Reconcile it from the machine that started the request.', transition: placement.transition_id, targetRuntimeId: placement.target_runtime_id }, { status: 409 });
  if (placement.runtime_id === own) return;
  const hops = Number(context.request.headers.get('x-rimeward-agent-hops') ?? '0');
  if (!Number.isSafeInteger(hops) || hops < 0 || hops >= 3) throw new DevError('Agent owner routing could not be reconciled.', 409);
  const headers = new Headers(context.request.headers); headers.set('x-rimeward-agent-hops', String(hops + 1));
  const request = new Request(context.request, { headers }), route = context.url.pathname + context.url.search;
  if (placement.runtime_id === 'server' && isDesktop()) return instanceRequest(user, route, request);
  return isDesktop() ? instanceRequest(user, `/runtime/${placement.runtime_id}${route}`, request) : relayRequest(user, placement.runtime_id, route, request);
}
