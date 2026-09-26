import { readSse } from './stream.ts';
import { REMOTE_DESKTOP_HEADER, REMOTE_DESKTOP_PROTOCOL } from '../dev/remote-desktop-contract.ts';
import { WORKSPACE_FORMAT,WORKSPACE_FORMAT_HEADER,requireWorkspaceLayoutVersion } from '../dev/workspace-migration.ts';
import { modelFailure } from "./diagnostics.ts";
import { randomUUID } from "node:crypto";
import { getDb } from "../db.ts";
import { cached } from '../cache.ts';
import type { VoiceAction, VoiceReply } from './voice.ts';
import { getSetting, setSetting } from "../settings.ts";
import { isDesktop } from "../dev/runtime.ts";
import { rimeConnection, designatedOffline, reachability } from "../dev/remote.ts";
import { INSTANCE_KEY, instanceDashboard, mergeInstance, moveLocalWardState, localWardsWithContent } from '../dev/instance.ts';
import { createHash } from 'node:crypto';
import {
  refreshWorkRecord,
  syncManifest,
  syncRecord,
  installRecordGuarded,
  validateRecord,
  preserveConflict,
  type SyncRecord,
} from "./sync-store.ts";
import { NOTE_KEY, resolveNoteConflict, validateNoteRecord } from '../note-sync.ts';
import { NOTE_FORMAT, NOTE_FORMAT_HEADER, noteRecordNeedsFormat } from '../notebook-pages.ts';
import { CHAT_FORMAT, CHAT_FORMAT_HEADER, chatRecordNeedsFormat, peerFormat } from './chat-format.ts';
import { COMMS_TYPES } from '../comms/types.ts';
import type {
  AgentProviderId,
  ProviderCall,
  ProviderResult,
} from "./provider.ts";
import type { ResolvedProviderRoute } from "./route.ts";

interface SharedRime {
  server: string;
  pair?: string;
  runtime?: string;
  profile: string;
  providers: Record<AgentProviderId, boolean>;
  /** The server's OpenAI-compatible endpoints, by name. */
  endpoints?: string[];
  /** Per endpoint name, the backend the SERVER attests it resolves to. A name is an alias; this is
   *  the identity a relayed conversation is pinned to and the server re-checks where it dispatches. */
  backends?: Record<string, string>;
  /** A non-secret generation per provider the server offers (`codex`, `openrouter`, `openai`,
   *  `compat:<name>`): it changes when the ACCOUNT behind one is replaced. A turn pins the value it
   *  was admitted against and the server re-checks it at dispatch. */
  generations?: Record<string, string>;
  /** What this server's Rime contract supports. Absent/0 = an older server; callers fail closed
   *  rather than degrading a guarantee. */
  caps?: { providerScope?: number; routePin?: number };
  config: Record<string, unknown>;
}
interface SyncStatus {
  /** The last reconciliation succeeded - dashboards, notes, history. */
  online: boolean;
  /** The SERVER answered. A payload/format problem leaves this true: a note that cannot sync must
   *  never move model access to another billing account. */
  reachable: boolean;
  /** Its IDENTITY was established on the last contact: it answered as the profile we are joined to.
   *  Reachability alone is not authority - a server that answers as a different account, or answers
   *  something unreadable, makes the capabilities stored here describe a connection we do not have,
   *  so they stop being eligible even though the socket works. */
  authority: boolean;
  syncing: boolean;
  at: number;
  error?: string;
  failure?: 'transport' | 'authority';
}
const statuses = new Map<number, SyncStatus>();
const pending = new Map<number, Promise<void>>();
export function sharedRime(user: number): (SharedRime & SyncStatus) | null {
  if (!isDesktop()) return null;
  const raw = getSetting(`rime:shared:${user}`);
  if (!raw) return null;
  try {
    return {
      ...(JSON.parse(raw) as SharedRime),
      ...(statuses.get(user) ?? { online: false, reachable: false, authority: false, syncing: false, at: 0 }),
    };
  } catch {
    return null;
  }
}
export function syncStatus(user: number) {
  const shared = sharedRime(user);
  return {
    ...shared,
    conflicts: getDb()
      .prepare(
        "SELECT id,key,saved_at FROM agent_sync_conflicts WHERE user_id=? ORDER BY id DESC",
      )
      .all(user),
  };
}
export function disconnectRime(user: number) {
  statuses.set(user, { online: false, reachable: false, authority: false, syncing: false, at: 0 });
}
async function request(
  server: string,
  token: string,
  suffix = "",
  init: RequestInit = {},
) {
  const response = await fetch(`${server}/api/devices/harness${suffix}`, {
    ...init,
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(15000),
    headers: { ...init.headers, [WORKSPACE_FORMAT_HEADER]:String(WORKSPACE_FORMAT), [REMOTE_DESKTOP_HEADER]: String(REMOTE_DESKTOP_PROTOCOL), [NOTE_FORMAT_HEADER]: String(NOTE_FORMAT), [CHAT_FORMAT_HEADER]: String(CHAT_FORMAT), authorization: `Bearer ${token}` },
  });
  if (response.status === 426) throw Object.assign(new Error('Update Rimeward before synchronizing this dashboard. Your local dashboard is preserved.'), { status: 426 });
  if (!response.ok && !(response.status === 409 && suffix === "")) {
    let message =
      response.status === 401
        ? "Rime server connection was revoked."
        : response.status === 404
          ? "Update the server to enable shared Rime."
          : "Rime server is unavailable.";
    if (
      (suffix === "/model" || suffix === "/voice") &&
      response.status >= 400 &&
      response.status < 500 &&
      ![401, 403, 404].includes(response.status)
    ) {
      const body = await response.json().catch(() => null);
      message =
        typeof body?.error === "string"
          ? body.error
          : "The server rejected this model request.";
    }
    throw Object.assign(new Error(message), { status: response.status });
  }
  return response;
}

/** Paired signaling only; voice media never enters sharedModel or sync records. */
export async function sharedVoice(user: number, ward: string, action: VoiceAction, pin?: { serverId?: string; profile?: string; runtime?: string; credential?: string }): Promise<VoiceReply | null> {
  if (!isDesktop()) return null;
  const connection = await rimeConnection(user);
  if (!connection) return null;
  const shared = sharedRime(user);
  // A pinned session is answered by the installation that HOLDS it or by nobody: control of a live
  // call must never be sent to whichever server is designated now.
  if (!pin?.runtime || !shared || connection.id !== pin.serverId || shared.profile !== pin.profile || shared.runtime !== pin.runtime || shared.pair !== connection.id || (shared.caps?.routePin ?? 0) < 2)
    throw Object.assign(new Error('This call was started on a different connected server than the one designated now. It was not controlled from here.'), { status: 409 });
  // Null means "not the server's call": the caller then uses this runtime's own ChatGPT connection.
  // A paired desktop whose server is unreachable must reach that branch, not throw inside the relay.
  if (!shared?.reachable || shared.authority !== true || (action.action === 'start' && !shared.providers.codex)) return null;
  if (action.action === 'start' && (!pin.credential || pin.credential !== shared.generations?.codex))
    throw Error('The admitted voice credential changed. No call was started elsewhere.');
  const response = await request(connection.server, connection.token, '/voice', {
    method: 'POST', headers: { 'content-type': 'application/json',
      'x-rime-provider-contract': '2', 'x-rime-provider-runtime': pin.runtime,
      'x-rime-provider-profile': shared.profile, 'x-rime-provider-generation': pin.credential ?? '' },
    body: JSON.stringify({ ...action, ward }), signal: AbortSignal.timeout(action.action === 'start' ? 90_000 : 15_000),
  });
  return await response.json() as VoiceReply;
}
export function syncRime(user: number, force = false): Promise<void> {
  if (!isDesktop()) return Promise.resolve();
  // A server already known to be unreachable is not worth waiting for (the dashboard awaits this):
  // the pass still runs in the background as the probe that notices it coming back.
  const offline = designatedOffline(user);
  const running = pending.get(user);
  if (running) return offline ? Promise.resolve() : running;
  const last = statuses.get(user);
  if (!force && last && Date.now() - last.at < 15000) return Promise.resolve();
  let answered = false;
  // Its identity, separately from its reachability: only a round that read a matching profile
  // re-establishes it, and a round that read a WRONG one destroys it.
  let identified = false;
  let pair: string | undefined;
  const promise = (async () => {
    try {
      const connection = await rimeConnection(user);
      pair = connection?.id;
      if (!connection) {
        disconnectRime(user);
        return;
      }
      statuses.set(user, {
        online: last?.online ?? false,
        reachable: last?.reachable ?? false,
        authority: last?.authority ?? false,
        syncing: true,
        at: Date.now(),
      });
      const response = await request(connection.server, connection.token);
      // From here the server has answered: everything after this is OUR payload's business.
      answered = true;
      reachability(connection.id, true);
      const remote = (await response.json()) as {
        profile: string;
        runtime?: string;
        providers: SharedRime["providers"];
        endpoints?: unknown;
        endpointBackends?: unknown;
        generations?: unknown;
        capabilities?: { providerScope?: unknown; routePin?: unknown };
        config: Record<string, unknown>;
        manifest: { key: string; hash: string }[];
        noteFormat?: number;
        chatFormat?: number;
        workspaceFormat?: number;
      };
      if (
        typeof remote.profile !== "string" ||
        !remote.providers ||
        !Array.isArray(remote.manifest)
      ) {
        identified = false;
        throw Error("Invalid Rime server response.");
      }
      const previous = sharedRime(user);
      let changed =
        !last?.online ||
        JSON.stringify(previous?.config) !== JSON.stringify(remote.config);
      if (previous && previous.profile !== remote.profile) {
        identified = false;
        throw Error(
          "This local Rime belongs to another server account. Its data has not been sent to this account.",
        );
      }
      if (previous?.runtime && previous.pair === connection.id && previous.runtime !== remote.runtime) {
        identified = false;
        throw Error('This pairing answered as a different serving installation. Its capabilities were not adopted.');
      }
      identified = true;
      const still = await rimeConnection(user);
      if (still?.id !== connection.id || still.server !== connection.server) {
        identified = false;
        throw Error('The designated server changed during synchronization.');
      }
      setSetting(
        `rime:shared:${user}`,
        JSON.stringify({
          server: connection.server,
          pair: connection.id,
          runtime: typeof remote.runtime === 'string' ? remote.runtime : '',
          profile: remote.profile,
          providers: remote.providers,
          endpoints: Array.isArray(remote.endpoints) ? remote.endpoints.filter((e): e is string => typeof e === 'string') : [],
          backends: remote.endpointBackends && typeof remote.endpointBackends === 'object' && !Array.isArray(remote.endpointBackends)
            ? Object.fromEntries(Object.entries(remote.endpointBackends as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
            : {},
          generations: remote.generations && typeof remote.generations === 'object' && !Array.isArray(remote.generations)
            ? Object.fromEntries(Object.entries(remote.generations as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
            : {},
          caps: {
            providerScope: Number(remote.capabilities?.providerScope) || 0,
            routePin: Number(remote.capabilities?.routePin) || 0,
          },
          config: remote.config,
        }),
      );
      requireWorkspaceLayoutVersion(instanceDashboard(user).layout,remote.workspaceFormat);
      let instanceChanged = !last?.online;
      const instance = remote.manifest.find(r => r.key === INSTANCE_KEY);
      if (instance && !getSetting(`instance:joined:${user}`)) {
        const record = await request(connection.server, connection.token, `?key=${encodeURIComponent(INSTANCE_KEY)}`).then(r => r.json()) as SyncRecord;
        const localRuntimeId = getSetting('workspace:runtime-id') ?? undefined;
        const { dashboard, wardIds } = mergeInstance(JSON.parse(record.payload), instanceDashboard(user), connection.id, localWardsWithContent(user), localRuntimeId);
        const payload = JSON.stringify(dashboard);
        // Preserve the pre-join dashboard before any re-keying or layout replacement.
        const original = JSON.stringify(instanceDashboard(user));
        setSetting(`instance:before-join:${user}`, original);
        await moveLocalWardState(user, wardIds);
        if (localRuntimeId && localRuntimeId !== connection.id) (await import('../dev/agent-placement.ts')).remapLocalAgentRuntime(user, localRuntimeId, connection.id);
        await installRecordGuarded(user, { key: INSTANCE_KEY, payload, hash: createHash('sha256').update(payload).digest('hex') });
        setSetting(`instance:joined:${user}`, remote.profile);
        getDb().prepare('INSERT INTO agent_sync_baselines VALUES(?,?,?,?) ON CONFLICT(user_id,profile,key) DO UPDATE SET hash=excluded.hash')
          .run(user, remote.profile, INSTANCE_KEY, record.hash);
        changed = instanceChanged = true;
      }
      const local = new Map(syncManifest(user).map((r) => [r.key, r.hash])),
        other = new Map(remote.manifest.map((r) => [r.key, r.hash]));
      const db = getDb();
      const bases = new Map(
        (
          db
            .prepare(
              "SELECT key,hash FROM agent_sync_baselines WHERE user_id=? AND profile=?",
            )
            .all(user, remote.profile) as { key: string; hash: string }[]
        ).map((r) => [r.key, r.hash]),
      );
      const acknowledge = (key: string, hash: string) =>
        db
          .prepare(
            "INSERT INTO agent_sync_baselines VALUES(?,?,?,?) ON CONFLICT(user_id,profile,key) DO UPDATE SET hash=excluded.hash WHERE agent_sync_baselines.hash!=excluded.hash",
          )
          .run(user, remote.profile, key, hash);
      let dashboardRecovered = false;
      const receive = async (record: SyncRecord) => {
        changed = true;
        if (record.key === INSTANCE_KEY) instanceChanged = true;
        // Re-read after network I/O: an editor or agent may have written in the meantime.
        refreshWorkRecord(user, record.key);
        const current = syncRecord(user, record.key);
        if (peerFormat(remote.noteFormat) < NOTE_FORMAT && noteRecordNeedsFormat(current)) return;
        // A conversation record the peer's format cannot carry stays ours; nothing it sends replaces it.
        if (peerFormat(remote.chatFormat) < CHAT_FORMAT && (chatRecordNeedsFormat(current) || chatRecordNeedsFormat(record))) return;
        if (
          current &&
          current.hash !== record.hash &&
          current.hash !== bases.get(record.key)
        ) {
          if (record.key === INSTANCE_KEY) {
            validateRecord(record);
            // Neither full dashboard has authority over concurrent local edits.
            // Keep the incoming copy in History recovery. Acknowledge it as the new base
            // so the next pass can publish ours; other records continue syncing now.
            if (!db.prepare('SELECT 1 FROM agent_sync_conflicts WHERE user_id=? AND key=? AND payload=?').get(user, record.key, record.payload)) preserveConflict(user, record);
            acknowledge(record.key, record.hash);
            dashboardRecovered = true;
            return;
          }
          if (NOTE_KEY.test(record.key)) {
            // Both runtimes edited this note: the newer save wins, the other is
            // kept as a conflict copy beside it (note-sync.ts). When ours is
            // newer the server's hash becomes the base so the next pass pushes ours.
            const parse = (r: SyncRecord) => { const v: unknown = JSON.parse(r.payload); return v === null ? null : validateNoteRecord(v); };
            if (resolveNoteConflict(user, parse(current), parse(record))) {
              acknowledge(record.key, record.hash);
              return;
            }
          } else preserveConflict(user, current);
        }
        try { await installRecordGuarded(user, record); }
        catch(error){if(record.key!==INSTANCE_KEY)throw error;if(!db.prepare('SELECT 1 FROM agent_sync_conflicts WHERE user_id=? AND key=? AND payload=?').get(user,record.key,record.payload))preserveConflict(user,record);dashboardRecovered=true;return;}
        acknowledge(record.key, record.hash);
      };
      // Attachments first (history opens immediately), then notebooks before their notes.
      const rank = (k: string) => (k.startsWith("file/") ? 0 : k.startsWith("notebook/") ? 1 : 2);
      const keys = [...new Set([...local.keys(), ...other.keys()])].sort(
        (a, b) => rank(a) - rank(b) || a.localeCompare(b),
      );
      let notesPaused = false, chatsPaused = false;
      for (const key of keys) {
        if (peerFormat(remote.noteFormat) < NOTE_FORMAT && noteRecordNeedsFormat(syncRecord(user, key))) { notesPaused = true; continue; }
        // Never send an old peer a conversation record it would reject: it is kept locally (History still lists it).
        if (peerFormat(remote.chatFormat) < CHAT_FORMAT && chatRecordNeedsFormat(syncRecord(user, key))) { chatsPaused = true; continue; }
        const ours = local.get(key),
          theirs = other.get(key),
          base = bases.get(key);
        if (ours === theirs) {
          if (ours) acknowledge(key, ours);
          continue;
        }
        if (theirs && theirs !== base) {
          const record = (await request(
            connection.server,
            connection.token,
            `?key=${encodeURIComponent(key)}`,
          ).then((r) => r.json())) as SyncRecord;
          if (record.key !== key) throw Error("Unexpected Rime sync record.");
          await receive(record);
        } else {
          const record = syncRecord(user, key);
          if (!record) continue;
          const result = (await request(
            connection.server,
            connection.token,
            "",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ record, base: base ?? null }),
            },
          ).then((r) => r.json())) as {
            ok: boolean;
            record: SyncRecord | null;
          };
          if (result.ok) acknowledge(key, record.hash);
          else if (result.record?.key === key) await receive(result.record);
          else
            throw Error(
              "Rime sync changed during reconciliation; retrying later.",
            );
        }
      }
      statuses.set(user, { online: true, reachable: true, authority: true, syncing: false, at: Date.now(), ...(dashboardRecovered ? { error: 'Concurrent dashboard changes: local settings kept. Open Rime History → Recovered version · instance/dashboard to review or restore the other version.' } : notesPaused ? { error: 'New document formats are saved locally. Update the server to sync them.' } : chatsPaused ? { error: 'Conversations this server does not sync yet — a provider or a server-side endpoint it cannot record — are kept locally. Update the server to sync them.' } : {}) });
      if (changed) {
        const { broadcast } = await import("../logic-engine.ts");
        broadcast(user, "refresh", { type: "memory" });
        broadcast(user, "refresh", { type: "skill" });
        broadcast(user, "refresh", { type: "agent" });
        if (instanceChanged) {
          const dashboard = instanceDashboard(user);
          broadcast(user, 'layout', { layout: dashboard.layout, pages: dashboard.pages });
          broadcast(user, 'theme', dashboard.theme ? JSON.parse(dashboard.theme) : {});
        }
        // Back from an outage: wards the server feeds still show its error until their next poll
        // (up to 15 min). Repaint them now; a focused card is skipped client-side.
        if (last && !last.online) {
          broadcast(user, 'refresh', { link: 'notion' });
          for (const type of ['weather', 'mail', 'calendar', 'next-up', ...COMMS_TYPES]) broadcast(user, 'refresh', { type });
        }
      }
    } catch (e) {
      // 426 is the peer refusing OUR format - it answered, so it is reachable.
      const spoke = answered || typeof (e as { status?: number }).status === 'number';
      if (pair) reachability(pair, spoke);
      statuses.set(user, {
        online: false,
        reachable: spoke,
        authority: spoke && identified,
        failure: spoke ? 'authority' : 'transport',
        syncing: false,
        at: Date.now(),
        error: e instanceof Error ? e.message : "Rime sync failed.",
      });
      if (last?.online) {
        const { broadcast } = await import("../logic-engine.ts");
        broadcast(user, "refresh", { type: "agent" });
      }
    }
  })().finally(() => pending.delete(user));
  pending.set(user, promise);
  return offline ? Promise.resolve() : promise;
}
let timer: ReturnType<typeof setInterval> | undefined;
export function ensureRimeSync(user: number) {
  if (!isDesktop() || timer) return;
  void syncRime(user, true);
  // ponytail: bounded file hashing every 15s; replace with a watcher journal if profiles grow large.
  timer = setInterval(() => void syncRime(user), 15000);
  timer.unref();
}
/** Longer than the server's own provider timeout (codex TIMEOUT_MS) and under
 *  nginx's 360s read timeout on the harness location — the desktop must be the
 *  last to give up, or the server finishes a call nobody is listening to. */
const MODEL_TIMEOUT_MS = 330_000;
export async function sharedModel(
  user: number,
  provider: AgentProviderId,
  call: ProviderCall,
  pin?: ResolvedProviderRoute,
): Promise<ProviderResult | null> {
  const connection = await rimeConnection(user),
    shared = sharedRime(user);
  const endpoint = call.endpoint;
  const offered = provider === 'compat' ? !!endpoint && (shared?.endpoints ?? []).includes(endpoint) : !!shared?.providers[provider];
  // A route resolved at turn admission names ONE pairing and ONE server profile. If either changed
  // since, the turn stops here; its context is never sent to a different account.
  // (No connection at all falls through to the caller's "not available" message: gone is not changed.)
  if (pin?.server && connection && (connection.id !== pin.server.id || shared?.profile !== pin.server.profile || shared.runtime !== pin.server.runtime || shared.pair !== connection.id))
    throw Object.assign(new Error('The connected server or its account changed during this turn. Nothing was sent to the new one - start the next turn to use it.'), { status: 409 });
  // An attested backend the server cannot confirm is a refusal, not a silent downgrade.
  if ((shared?.caps?.routePin ?? 0) < 2 || !pin?.server?.runtime || !pin.serverCredential)
    throw Object.assign(new Error(`Update the connected server: it cannot confirm which backend "${endpoint}" serves, and this conversation is pinned to it.`), { status: 426 });
  if (!connection || !shared?.reachable || shared.authority === false || !offered)
    return null;
  const requestId = randomUUID();
  let accepted = false;
  // The server writes at least every 15 s once it answers: a longer silence is a dead link, not a slow
  // model. Without this a dropped network held the turn until MODEL_TIMEOUT_MS (5.5 min).
  const stalled = new AbortController();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const alive = () => { clearTimeout(watchdog); watchdog = setTimeout(() => stalled.abort(new Error('The server stopped responding during the model request.')), 60_000); };
  try {
    const response = await request(
      connection.server,
      connection.token,
      "/model",
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({
          stream: true,
          provider,
          endpoint,
          ...(call.remoteBackend ? { backend: call.remoteBackend } : {}),
          // The instance AND the provider account this turn was admitted against. The SERVER checks
          // both: comparing our own cached copies here would only prove what we already believed.
          ...(pin?.server ? { profile: pin.server.profile } : {}),
          runtime: pin.server.runtime,
          routeContract: 2,
          ...(pin?.serverCredential ? { generation: pin.serverCredential } : {}),
          child: call.child === true,
          requestId,
          model: call.model,
          effort: call.effort,
          instructions: call.instructions,
          items: call.items,
          tools: call.tools,
          cacheKey: call.cacheKey,
        }),
        signal: AbortSignal.any([...(call.signal ? [call.signal] : []), AbortSignal.timeout(MODEL_TIMEOUT_MS), stalled.signal]),
      },
    );
    accepted = true;
    alive();
    if (!response.body) throw new SyntaxError("Missing model response.");
    let parsed: ProviderResult | { error: string; status?: number; category?: string } | undefined;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      await readSse(response.body, payload => {
        alive();
        if (payload === '[DONE]') return;
        const event = JSON.parse(payload);
        if (event.type === 'text_delta' && typeof event.delta === 'string') call.onTextDelta?.(event.delta);
        else if (event.type === 'thinking') call.onThinking?.(event.progress);
        else if (event.type === 'result') parsed = event.result;
        else if (event.type === 'error') parsed = event;
      }, () => { alive(); call.onProgress?.(); }, AbortSignal.any([...(call.signal ? [call.signal] : []), stalled.signal]));
      if (!parsed) throw Error('Model relay ended before completion.');
    } else {
      // Older servers send whitespace heartbeats and one final JSON document.
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let text = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          alive(); call.onProgress?.(); text += decoder.decode(value, { stream: true });
        }
        parsed = JSON.parse(text + decoder.decode());
      } finally { reader.releaseLock(); }
    }
    if (!parsed) throw Error('Missing model result.');
    if ("error" in parsed)
      throw Object.assign(new Error(typeof parsed.error === "string" ? parsed.error : "Invalid model response."), {
        status: parsed.status ?? 502,
        category: parsed.category,
      });
    return parsed as ProviderResult;
  } catch (e) {
    const failure = modelFailure(user, e, requestId, call.signal?.aborted);
    if (failure.category === 'connection-lost' || (!accepted && (failure.status === 401 || failure.status === 403))) disconnectRime(user);
    if (failure.category === 'connection-lost') reachability(connection.id, false);
    throw failure;
  } finally { clearTimeout(watchdog); }
}

/** The connected server's ChatGPT catalog, with ENVELOPE provenance - live or cache, and when. Keyed
 *  by the serving profile as well as its origin, so one host answering for two accounts, or the same
 *  account re-created, never serves the other's list. Null when this is not the server's catalog to
 *  give. */
export async function sharedCodexModels(
  user: number,
  pin?: ResolvedProviderRoute,
): Promise<SharedCatalogView | null> {
  return sharedCatalog(user, 'codex', undefined, pin);
}

/** The server's catalog for a provider it offers and the desktop cannot ask itself
 *  (an API key or endpoint that lives only there), with the provenance the server
 *  reported; served from the last stored copy — marked so — when it cannot be
 *  asked. Null when not paired/offered. */
export async function sharedCatalog(user: number, provider: AgentProviderId, endpoint?: string | null, pin?: ResolvedProviderRoute): Promise<SharedCatalogView | null> {
  if (!isDesktop() || !pin?.server || pin.via !== 'server' || pin.blocked) return null;
  const serving = pin.server, admittedGeneration = pin.serverCredential;
  if (!admittedGeneration) return null;
  await syncRime(user);
  const connection = await rimeConnection(user);
  const shared = sharedRime(user);
  const offered = provider === 'compat' ? !!endpoint && (shared?.endpoints ?? []).includes(endpoint) : !!shared?.providers[provider];
  if (!connection || !shared?.reachable || shared.authority !== true || !offered) return null;
  const generation = shared.generations?.[provider === 'compat' ? `compat:${endpoint}` : provider];
  if (connection.id !== pin.server.id || shared.pair !== connection.id ||
      shared.runtime !== pin.server.runtime || shared.profile !== pin.server.profile ||
      generation !== pin.serverCredential || (shared.caps?.routePin ?? 0) < 2)
    throw Error('The admitted catalog source changed; no other source was queried.');
  // Keyed by the serving PROFILE and, for a compat alias, the backend that server attests behind it:
  // a repointed alias or a replaced account gets its own entry rather than the previous one's list.
  const key = `agent_models:shared:v2:${user}:${connection.id}:${shared.runtime}:${shared.profile}:${generation}:${provider}:${endpoint ?? ''}:${pin.remoteBackend ?? ''}`;
  try {
    return await cached(key, 3600_000, async () => {
      const query = new URLSearchParams({ provider, routeContract: '2', runtime: serving.runtime,
        profile: serving.profile, generation: admittedGeneration });
      if (endpoint) query.set('endpoint', endpoint);
      const response = await request(connection.server, connection.token, `/models?${query}`);
      const body = (await response.json()) as SharedCatalogView & { runtime?: string; profile?: string; generation?: string; routeContract?: number };
      if (body.routeContract !== 2 || body.runtime !== serving.runtime || body.profile !== serving.profile ||
          body.generation !== pin.serverCredential || !Array.isArray(body.models))
        throw Error('The catalog response did not verify the admitted source.');
      const view: SharedCatalogView = { source: body.source, ...(body.fetchedAt ? { fetchedAt: body.fetchedAt } : {}), models: body.models };
      setSetting(key, JSON.stringify(view));
      return view;
    });
  } catch {
    const stored = JSON.parse(getSetting(key) ?? 'null') as SharedCatalogView | null;
    return stored?.models?.length ? { ...stored, source: 'cache' } : null;
  }
}
export interface SharedCatalogView {
  source: 'live' | 'cache' | 'fallback' | 'none';
  fetchedAt?: string;
  models: { id: string; name: string; efforts?: string[]; tools?: boolean; vision?: boolean; pricing?: { prompt: string; completion: string }; context?: import('./context.ts').ModelContext }[];
}

/** Integration authority remains with the connected account; tool approvals remain in core. */
export function serverTool(name: string) {
  return /^(?:notion_|chat_)/.test(name) || ['service_status', 'get_weather', 'list_mail', 'send_mail', 'list_calendar', 'list_checklist', 'add_checklist_item', 'check_checklist_item'].includes(name);
}
export async function sharedTool(user: number, ward: string, name: string, args: Record<string, unknown>) {
  if (!isDesktop() || !serverTool(name)) return null;
  const connection = await rimeConnection(user);
  if (!connection) return null;
  if (!sharedRime(user)?.reachable || sharedRime(user)?.authority === false) throw Error('This service needs a connection. Your local project tools remain available.');
  const response = await request(connection.server, connection.token, '/tool', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, ward, args }),
  });
  return { value: await response.json() };
}
