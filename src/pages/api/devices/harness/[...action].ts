import { REMOTE_DESKTOP_HEADER, requireRemoteLayoutVersion } from '../../../../lib/dev/remote-desktop-contract.ts';
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
  type ProviderCall,
} from "../../../../lib/agent/provider.ts";
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
        if (!value)
          return Response.json({ error: "Record not found." }, { status: 404 });
      } else {
        const providers = {
          codex: agentConfigured(user, "codex"),
          openrouter: agentConfigured(user, "openrouter"),
        };
        const config = getDashboard(user).find((w) => w.type === "agent")
          ?.config ?? { provider: providers.codex ? "codex" : "openrouter" };
        // Provider credentials and integration tokens never enter sync payloads.
        const { model, effort, persona } = config;
        const provider =
          config.provider === "codex" || config.provider === "openrouter"
            ? config.provider
            : providers.codex
              ? "codex"
              : "openrouter";
        value = {
          profile: profileId(user),
          providers,
          config: { provider, model, effort, persona },
          manifest: syncManifest(user),
        };
      }
    } else if (request.method === "GET" && params.action === "models") {
      const { listCodexModels } = await import(
        "../../../../lib/agent/codex.ts"
      );
      value = await listCodexModels(user);
    } else if (request.method === "POST" && !params.action) {
      const body = await bodyOf(request);
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
      if ((active.get(user) ?? 0) >= 4)
        return Response.json({ error: "Rime is busy." }, { status: 429 });
      active.set(user, (active.get(user) ?? 0) + 1);
      modelUser = user;
      const body = await bodyOf(request);
      if (
        !["codex", "openrouter"].includes(body.provider) ||
        typeof body.model !== "string" ||
        body.model.length > 200 ||
        typeof body.instructions !== "string" ||
        !Array.isArray(body.items) ||
        !Array.isArray(body.tools) ||
        body.tools.length > 512
      )
        throw Error("Invalid model request.");
      if (!agentConfigured(user, body.provider))
        return Response.json(
          { error: "Provider not configured on the server." },
          { status: 503 },
        );
      const provider = await getProvider(body.provider);
      // Exactly one model call. The desktop owns the loop and executes its tools.
      // Answered as a stream: Cloudflare returns 524 to the desktop when the
      // origin is silent for 100s, and a long reasoning round is silent for
      // longer — so whitespace heartbeats go out until the JSON does. The
      // status line is already sent by then, so an error rides the body too.
      const disconnected = new AbortController();
      const call: ProviderCall = {
        userId: user,
        relayRequestId: typeof body.requestId === 'string' && /^[a-f0-9-]{36}$/.test(body.requestId) ? body.requestId : randomUUID(),
        model: body.model,
        effort: typeof body.effort === "string" ? body.effort : undefined,
        instructions: body.instructions,
        items: body.items,
        tools: body.tools,
        cacheKey:
          typeof body.cacheKey === "string"
            ? `device:${device.id}:${body.cacheKey.slice(0, 120)}`
            : undefined,
        signal: AbortSignal.any([request.signal, disconnected.signal]),
      };
      const pending = provider.run(call);
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
            const beat = setInterval(() => push("\n"), 15_000);
            try {
              push(JSON.stringify(await pending));
            } catch (e) {
              const failure = modelFailure(owner, e, call.relayRequestId, call.signal?.aborted);
              push(
                JSON.stringify({
                  error: failure.message,
                  status: failure.status ?? 502,
                  category: failure.category,
                  requestId: failure.requestId,
                }),
              );
            } finally {
              clearInterval(beat);
              active.set(owner, Math.max(0, (active.get(owner) ?? 1) - 1));
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
            "content-type": "application/json",
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
    if (modelUser !== undefined)
      active.set(modelUser, Math.max(0, (active.get(modelUser) ?? 1) - 1));
  }
};
