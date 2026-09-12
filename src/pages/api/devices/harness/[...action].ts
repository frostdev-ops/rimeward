import { REMOTE_DESKTOP_HEADER, requireRemoteLayoutVersion } from '../../../../lib/dev/remote-desktop-contract.ts';
import { NOTE_FORMAT, NOTE_FORMAT_HEADER, noteRecordNeedsFormat } from '../../../../lib/notebook-pages.ts';
import { modelFailure } from "../../../../lib/agent/diagnostics.ts";
import { randomUUID } from "node:crypto";
import { voiceAction, voiceBody } from '../../../../lib/agent/voice.ts';
import type { APIRoute } from "astro";
import {
  authenticatedDevice,
  limitDeviceAuth,
} from "../../../../lib/dev/device-auth.ts";
import { isDesktop } from "../../../../lib/dev/runtime.ts";
import {
  agentConfigured,
  getProvider,
  isAgentProvider,
  AGENT_PROVIDERS,
  type ProviderCall,
} from "../../../../lib/agent/provider.ts";
import { listEndpoints } from "../../../../lib/agent/accounts.ts";
import { getDashboard } from "../../../../lib/dashboard.ts";
import { INSTANCE_KEY, instanceDashboard } from '../../../../lib/dev/instance.ts';
import {
  acceptRecord,
  profileId,
  syncManifest,
  syncRecord,
  SYNC_RECORD_MAX,
} from "../../../../lib/agent/sync-store.ts";

const active = new Map<number, number>();
/** Child calls, counted apart: three of the four slots at most, so a foreground turn always fits. */
const activeChildren = new Map<number, number>();
const CHILD_SLOTS = 3, TOTAL_SLOTS = 4;
async function bodyOf(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw Error("Missing request.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SYNC_RECORD_MAX + 8192) throw Error("Request too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
export const ALL: APIRoute = async ({
  params,
  locals: _locals,
  request,
  url,
}) => {
  let modelUser: number | undefined;
  let modelChild = false;
  const release = (user: number, child: boolean) => {
    active.set(user, Math.max(0, (active.get(user) ?? 1) - 1));
    if (child) activeChildren.set(user, Math.max(0, (activeChildren.get(user) ?? 1) - 1));
  };
  try {
    if (isDesktop() || request.headers.has("origin"))
      return Response.json(
        { error: "Native server connection required." },
        { status: 403 },
      );
    const device = authenticatedDevice(
        request.headers.get("authorization")?.replace(/^Bearer /, ""),
      ),
      user = device.user_id;
    // Block before manifest reads or writes: old clients must never replace an
    // unfamiliar dashboard with their fallback layout.
    const version = request.headers.get(REMOTE_DESKTOP_HEADER);
    if (!params.action) requireRemoteLayoutVersion(getDashboard(user), version);
    let value: unknown,
      status = 200;
    if (request.method === "GET" && !params.action) {
      const key = url.searchParams.get("key");
      if (key) {
        value = syncRecord(user, key);
        if (Number(request.headers.get(NOTE_FORMAT_HEADER) ?? 1) < NOTE_FORMAT && noteRecordNeedsFormat(value as { key: string; payload: string } | null)) return Response.json({ error: 'Update Rimeward to sync this document format.' }, { status: 426 });
        if (!value)
          return Response.json({ error: "Record not found." }, { status: 404 });
      } else {
        const endpoints = listEndpoints(user).map((e) => e.name);
        const providers = Object.fromEntries(AGENT_PROVIDERS.map((p) => [p, p === 'compat' ? endpoints.length > 0 : agentConfigured(user, p)])) as Record<(typeof AGENT_PROVIDERS)[number], boolean>;
        const config = getDashboard(user).find((w) => w.type === "agent")
          ?.config ?? { provider: providers.codex ? "codex" : "openrouter" };
        // Provider credentials and integration tokens never enter sync payloads
        // (an endpoint's NAME is not a credential; its url and key stay here).
        // A persona is per ward, never an account default: the first ward's
        // would otherwise reach every desktop ward without one of its own.
        const { model, effort, endpoint } = config;
        const provider =
          isAgentProvider(config.provider)
            ? config.provider
            : providers.codex
              ? "codex"
              : "openrouter";
        value = {
          profile: profileId(user),
          providers,
          endpoints,
          config: { provider, model, effort, ...(provider === 'compat' && typeof endpoint === 'string' ? { endpoint } : {}) },
          manifest: syncManifest(user),
          noteFormat: NOTE_FORMAT,
        };
      }
    } else if (request.method === "GET" && params.action === "models") {
      const which = url.searchParams.get("provider") ?? "codex";
      if (which === "codex") {
        const { listCodexModels } = await import(
          "../../../../lib/agent/codex.ts"
        );
        value = await listCodexModels(user);
      } else {
        // The server's own catalog for a key or endpoint that lives only here —
        // whole, with its provenance and metadata, so the desktop can validate
        // an id against it exactly as the server would.
        if (!isAgentProvider(which)) throw Error("Unknown provider.");
        const { modelCatalog } = await import("../../../../lib/agent/models.ts");
        const catalog = await modelCatalog(user, which, url.searchParams.get("endpoint"));
        if (!catalog.models.length) throw Object.assign(Error(catalog.error ?? "No models."), { status: 502 });
        value = catalog;
      }
    } else if (request.method === "POST" && !params.action) {
      const body = await bodyOf(request);
      if (Number(request.headers.get(NOTE_FORMAT_HEADER) ?? 1) < NOTE_FORMAT && (noteRecordNeedsFormat(body.record) || (typeof body.record?.key === 'string' && noteRecordNeedsFormat(syncRecord(user, body.record.key))))) return Response.json({ error: 'Update Rimeward to sync this document format.' }, { status: 426 });
      if (body.record?.key?.startsWith('appearance/brand/')) return Response.json({ error: 'Instance brand assets are managed on the server.' }, { status: 403 });
      if (body.record?.key === INSTANCE_KEY && typeof body.record.payload === 'string')
        requireRemoteLayoutVersion(JSON.parse(body.record.payload)?.layout, version);
      value = acceptRecord(
        user,
        body.record,
        typeof body.base === "string" ? body.base : null,
      );
      if (!(value as { ok: boolean }).ok) status = 409;
      else if (body.record?.key === INSTANCE_KEY) {
        const { broadcast } = await import('../../../../lib/logic-engine.ts');
        const state = instanceDashboard(user);
        broadcast(user, 'layout', { layout: state.layout, pages: state.pages });
        broadcast(user, 'theme', state.theme ? JSON.parse(state.theme) : {});
      }
    } else if (request.method === 'POST' && params.action === 'voice') {
      const body = await voiceBody(request);
      if (typeof body.ward !== 'string' || !getDashboard(user).some(w => w.i === body.ward && w.type === 'agent'))
        return Response.json({ error: 'Agent ward unavailable.' }, { status: 404, headers: { 'cache-control': 'no-store' } });
      value = await voiceAction(user, body.ward, `device:${device.id}`, body);
    } else if (request.method === 'POST' && params.action === 'tool') {
      limitDeviceAuth(`rime-tool:${user}`, 240);
      const body = await bodyOf(request);
      const { serverTool } = await import('../../../../lib/agent/sync.ts');
      const { TOOLS } = await import('../../../../lib/agent/tools.ts');
      if (typeof body.name !== 'string' || !serverTool(body.name) || !TOOLS[body.name] ||
        !body.args || typeof body.args !== 'object' || Array.isArray(body.args) ||
        !getDashboard(user).some(w => w.i === body.ward && w.type === 'agent')) throw Error('Invalid integration tool request.');
      value = await TOOLS[body.name].run(body.args, { userId: user, ward: body.ward, conv: 0 });
    } else if (request.method === "POST" && params.action === "model") {
      limitDeviceAuth(`rime-model:${user}`, 240);
      const body = await bodyOf(request);
      // Four calls per user at once; a child run may take at most three of them,
      // so the foreground turn on a paired desktop always has one slot.
      const child = body.child === true;
      if ((active.get(user) ?? 0) >= TOTAL_SLOTS || (child && (activeChildren.get(user) ?? 0) >= CHILD_SLOTS))
        return Response.json({ error: child ? "Rime is busy — three child model calls are already in flight; this one was not made." : "Rime is busy." }, { status: 429 });
      active.set(user, (active.get(user) ?? 0) + 1);
      if (child) activeChildren.set(user, (activeChildren.get(user) ?? 0) + 1);
      modelUser = user;
      modelChild = child;
      if (
        !isAgentProvider(body.provider) ||
        (body.endpoint !== undefined && (typeof body.endpoint !== "string" || body.endpoint.length > 40)) ||
        typeof body.model !== "string" ||
        body.model.length > 200 ||
        typeof body.instructions !== "string" ||
        !Array.isArray(body.items) ||
        !Array.isArray(body.tools) ||
        body.tools.length > 512
      )
        throw Error("Invalid model request.");
      const endpoint = body.provider === "compat" ? String(body.endpoint ?? "") : undefined;
      if (!agentConfigured(user, body.provider, endpoint))
        return Response.json(
          { error: "Provider not configured on the server." },
          { status: 503 },
        );
      const provider = await getProvider(body.provider, endpoint);
      // Streaming is negotiated; older desktops still receive the JSON result.
      const streaming = body.stream === true && request.headers.get('accept')?.includes('text/event-stream');
      const disconnected = new AbortController();
      const call: ProviderCall = {
        userId: user,
        relayRequestId: typeof body.requestId === 'string' && /^[a-f0-9-]{36}$/.test(body.requestId) ? body.requestId : randomUUID(),
        model: body.model,
        effort: typeof body.effort === "string" ? body.effort : undefined,
        child,
        instructions: body.instructions,
        items: body.items,
        tools: body.tools,
        cacheKey:
          typeof body.cacheKey === "string"
            ? `device:${device.id}:${body.cacheKey.slice(0, 120)}`
            : undefined,
        signal: AbortSignal.any([request.signal, disconnected.signal]),
      };
      const owner = user;
      modelUser = undefined; // the stream releases the slot when the call settles
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          cancel() { disconnected.abort(); },
          async start(ctrl) {
            const push = (s: string) => {
              try {
                ctrl.enqueue(enc.encode(s));
              } catch {
                /* the desktop went away; the slot is still released below */
              }
            };
            const send = (event: unknown) => push(`data: ${JSON.stringify(event)}\n\n`);
            if (streaming) call.onTextDelta = delta => send({ type: 'text_delta', delta });
            push(streaming ? ': connected\n\n' : '\n');
            const beat = setInterval(() => push(streaming ? ': heartbeat\n\n' : "\n"), 15_000);
            try {
              const result = await provider.run(call);
              if (streaming) send({ type: 'result', result });
              else push(JSON.stringify(result));
            } catch (e) {
              const failure = modelFailure(owner, e, call.relayRequestId, call.signal?.aborted);
              const error = { type: 'error', error: failure.message, status: failure.status ?? 502,
                category: failure.category, requestId: failure.requestId };
              if (streaming) send(error);
              else push(JSON.stringify(error));
            } finally {
              clearInterval(beat);
              release(owner, child);
              try {
                ctrl.close();
              } catch {
                /* already cancelled */
              }
            }
          },
        }),
        {
          headers: {
            "content-type": streaming ? "text/event-stream" : "application/json",
            "cache-control": "no-store",
            "x-accel-buffering": "no",
          },
        },
      );
    } else
      return Response.json(
        { error: "Unknown Rime operation." },
        { status: 404 },
      );
    return Response.json(value, {
      status,
      headers: { "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Rime request failed." },
      {
        status: (e as { status?: number }).status ?? 400,
        headers: { "cache-control": "no-store" },
      },
    );
  } finally {
    if (modelUser !== undefined) release(modelUser, modelChild);
  }
};
