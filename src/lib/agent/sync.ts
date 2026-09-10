import { REMOTE_DESKTOP_HEADER, REMOTE_DESKTOP_PROTOCOL } from '../dev/remote-desktop-contract.ts';
import { modelFailure } from "./diagnostics.ts";
import { randomUUID } from "node:crypto";
import { getDb } from "../db.ts";
import { cached } from '../cache.ts';
import type { CodexModel } from './codex.ts';
import type { VoiceAction, VoiceReply } from './voice.ts';
import { getSetting, setSetting } from "../settings.ts";
import { isDesktop } from "../dev/runtime.ts";
import { rimeConnection } from "../dev/remote.ts";
import { INSTANCE_KEY, instanceDashboard, mergeInstance, moveLocalWardState, localWardsWithContent } from '../dev/instance.ts';
import { createHash } from 'node:crypto';
import {
  refreshWorkRecord,
  syncManifest,
  syncRecord,
  installRecord,
  preserveConflict,
  type SyncRecord,
} from "./sync-store.ts";
import { NOTE_KEY, resolveNoteConflict, validateNoteRecord } from '../note-sync.ts';
import type {
  AgentProviderId,
  ProviderCall,
  ProviderResult,
} from "./provider.ts";

interface SharedRime {
  server: string;
  profile: string;
  providers: Record<AgentProviderId, boolean>;
  /** The server's OpenAI-compatible endpoints, by name. */
  endpoints?: string[];
  config: Record<string, unknown>;
}
interface SyncStatus {
  online: boolean;
  syncing: boolean;
  at: number;
  error?: string;
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
      ...(statuses.get(user) ?? { online: false, syncing: false, at: 0 }),
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
  statuses.set(user, { online: false, syncing: false, at: 0 });
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
    headers: { ...init.headers, [REMOTE_DESKTOP_HEADER]: String(REMOTE_DESKTOP_PROTOCOL), authorization: `Bearer ${token}` },
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
export async function sharedVoice(user: number, ward: string, action: VoiceAction): Promise<VoiceReply | null> {
  if (!isDesktop()) return null;
  const connection = await rimeConnection(user);
  if (!connection) return null;
  const response = await request(connection.server, connection.token, '/voice', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...action, ward }), signal: AbortSignal.timeout(action.action === 'start' ? 90_000 : 15_000),
  });
  return await response.json() as VoiceReply;
}
export function syncRime(user: number, force = false): Promise<void> {
  if (!isDesktop()) return Promise.resolve();
  const running = pending.get(user);
  if (running) return running;
  const last = statuses.get(user);
  if (!force && last && Date.now() - last.at < 15000) return Promise.resolve();
  const promise = (async () => {
    try {
      const connection = await rimeConnection(user);
      if (!connection) {
        disconnectRime(user);
        return;
      }
      statuses.set(user, {
        online: last?.online ?? false,
        syncing: true,
        at: Date.now(),
      });
      const response = await request(connection.server, connection.token);
      const remote = (await response.json()) as {
        profile: string;
        providers: SharedRime["providers"];
        endpoints?: unknown;
        config: Record<string, unknown>;
        manifest: { key: string; hash: string }[];
      };
      if (
        typeof remote.profile !== "string" ||
        !remote.providers ||
        !Array.isArray(remote.manifest)
      )
        throw Error("Invalid Rime server response.");
      const previous = sharedRime(user);
      let changed =
        !last?.online ||
        JSON.stringify(previous?.config) !== JSON.stringify(remote.config);
      if (previous && previous.profile !== remote.profile)
        throw Error(
          "This local Rime belongs to another server account. Its data has not been sent to this account.",
        );
      setSetting(
        `rime:shared:${user}`,
        JSON.stringify({
          server: connection.server,
          profile: remote.profile,
          providers: remote.providers,
          endpoints: Array.isArray(remote.endpoints) ? remote.endpoints.filter((e): e is string => typeof e === 'string') : [],
          config: remote.config,
        }),
      );
      let instanceChanged = !last?.online;
      const instance = remote.manifest.find(r => r.key === INSTANCE_KEY);
      if (instance && !getSetting(`instance:joined:${user}`)) {
        const record = await request(connection.server, connection.token, `?key=${encodeURIComponent(INSTANCE_KEY)}`).then(r => r.json()) as SyncRecord;
        const { dashboard, wardIds } = mergeInstance(JSON.parse(record.payload), instanceDashboard(user), connection.id, localWardsWithContent(user));
        const payload = JSON.stringify(dashboard);
        // Preserve the pre-join dashboard before any re-keying or layout replacement.
        const original = JSON.stringify(instanceDashboard(user));
        setSetting(`instance:before-join:${user}`, original);
        await moveLocalWardState(user, wardIds);
        installRecord(user, { key: INSTANCE_KEY, payload, hash: createHash('sha256').update(payload).digest('hex') });
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
      const receive = (record: SyncRecord) => {
        changed = true;
        if (record.key === INSTANCE_KEY) instanceChanged = true;
        // Re-read after network I/O: an editor or agent may have written in the meantime.
        refreshWorkRecord(user, record.key);
        const current = syncRecord(user, record.key);
        if (
          current &&
          current.hash !== record.hash &&
          current.hash !== bases.get(record.key)
        ) {
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
        installRecord(user, record);
        acknowledge(record.key, record.hash);
      };
      // Attachments first (history opens immediately), then notebooks before their notes.
      const rank = (k: string) => (k.startsWith("file/") ? 0 : k.startsWith("notebook/") ? 1 : 2);
      const keys = [...new Set([...local.keys(), ...other.keys()])].sort(
        (a, b) => rank(a) - rank(b) || a.localeCompare(b),
      );
      for (const key of keys) {
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
          receive(record);
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
          else if (result.record?.key === key) receive(result.record);
          else
            throw Error(
              "Rime sync changed during reconciliation; retrying later.",
            );
        }
      }
      statuses.set(user, { online: true, syncing: false, at: Date.now() });
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
      }
    } catch (e) {
      statuses.set(user, {
        online: false,
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
  return promise;
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
): Promise<ProviderResult | null> {
  const connection = await rimeConnection(user),
    shared = sharedRime(user);
  const endpoint = call.endpoint;
  const offered = provider === 'compat' ? !!endpoint && (shared?.endpoints ?? []).includes(endpoint) : !!shared?.providers[provider];
  if (!connection || !shared?.online || !offered)
    return null;
  const requestId = randomUUID();
  let accepted = false;
  try {
    const response = await request(
      connection.server,
      connection.token,
      "/model",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          endpoint,
          child: call.child === true,
          requestId,
          model: call.model,
          effort: call.effort,
          instructions: call.instructions,
          items: call.items,
          tools: call.tools,
          cacheKey: call.cacheKey,
        }),
        signal: call.signal
          ? AbortSignal.any([call.signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)])
          : AbortSignal.timeout(MODEL_TIMEOUT_MS),
      },
    );
    accepted = true;
    // Whitespace heartbeats, then one JSON document: the result, or the
    // server's error with its status (the status line was long gone by then).
    if (!response.body) throw new SyntaxError("Missing model response.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        call.onProgress?.();
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    const parsed = JSON.parse(text) as
      | ProviderResult
      | { error: string; status?: number; category?: string };
    if ("error" in parsed)
      throw Object.assign(new Error(typeof parsed.error === "string" ? parsed.error : "Invalid model response."), {
        status: parsed.status ?? 502,
        category: parsed.category,
      });
    return parsed as ProviderResult;
  } catch (e) {
    const failure = modelFailure(user, e, requestId, call.signal?.aborted);
    if (failure.category === 'connection-lost' || (!accepted && (failure.status === 401 || failure.status === 403))) disconnectRime(user);
    throw failure;
  }
}

export async function sharedCodexModels(
  user: number,
): Promise<CodexModel[] | null> {
  if (!isDesktop()) return null;
  await syncRime(user);
  const connection = await rimeConnection(user);
  if (!connection) return null;
  const key = `agent_models:shared:${user}:${connection.server}`;
  try {
    if (!sharedRime(user)?.online) throw Error('offline');
    return await cached(key, 3600_000, async () => {
      const response = await request(connection.server, connection.token, '/models');
      const models = await response.json() as CodexModel[];
      setSetting(key, JSON.stringify(models));
      return models;
    });
  } catch {
    const stored = JSON.parse(getSetting(key) ?? '[]') as CodexModel[];
    return stored.length ? stored.map((m) => ({ ...m, ...(m.context ? { context: { ...m.context, source: 'cache' as const } } : {}) })) : null;
  }
}

/** The server's catalog for a provider it offers and the desktop cannot ask itself
 *  (an API key or endpoint that lives only there), with the provenance the server
 *  reported; served from the last stored copy — marked so — when it cannot be
 *  asked. Null when not paired/offered. */
export async function sharedCatalog(user: number, provider: AgentProviderId, endpoint?: string | null): Promise<SharedCatalogView | null> {
  if (!isDesktop()) return null;
  await syncRime(user);
  const connection = await rimeConnection(user);
  const shared = sharedRime(user);
  const offered = provider === 'compat' ? !!endpoint && (shared?.endpoints ?? []).includes(endpoint) : !!shared?.providers[provider];
  if (!connection || !shared?.online || !offered) return null;
  const key = `agent_models:shared:${user}:${connection.server}:${provider}:${endpoint ?? ''}`;
  try {
    return await cached(key, 3600_000, async () => {
      const response = await request(connection.server, connection.token, `/models?provider=${provider}${endpoint ? `&endpoint=${encodeURIComponent(endpoint)}` : ''}`);
      const body = (await response.json()) as SharedCatalogView | { id: string; name: string }[];
      // An older server answers a bare list: provenance unknown, so never "live".
      const view: SharedCatalogView = Array.isArray(body) ? { source: 'cache', models: body } : { source: body.source, ...(body.fetchedAt ? { fetchedAt: body.fetchedAt } : {}), models: body.models ?? [] };
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
  if (!sharedRime(user)?.online) throw Error('This service needs a connection. Your local project tools remain available.');
  const response = await request(connection.server, connection.token, '/tool', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, ward, args }),
  });
  return { value: await response.json() };
}
