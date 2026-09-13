import type { APIRoute } from "astro";
import { getDb } from "../../../lib/db.ts";
import {
  sharedChats,
  syncRecord,
  installRecord,
  preserveConflict,
  captureRime,
} from "../../../lib/agent/sync-store.ts";
import { syncRime, syncStatus } from "../../../lib/agent/sync.ts";

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  const user = locals.user.userId;
  await syncRime(user);
  const conflict = url.searchParams.get("conflict");
  if (conflict) {
    const saved = getDb()
      .prepare(
        "SELECT id,key,payload,saved_at FROM agent_sync_conflicts WHERE user_id=? AND id=?",
      )
      .get(user, Number(conflict));
    return Response.json(saved ?? { error: "Recovery version not found." }, {
      status: saved ? 200 : 404,
      headers: { "cache-control": "no-store" },
    });
  }
  const key = url.searchParams.get("key");
  const chats = sharedChats(user);
  // The ward the person would continue into, so the dialog can say whether the route matches and which model applies.
  const wardId = url.searchParams.get("ward");
  const { agentWardConfig } = await import("../../../lib/agent/ward-config.ts");
  const cfg = wardId ? agentWardConfig(user, wardId) : null;
  const target = cfg ? { provider: cfg.provider, endpoint: cfg.endpoint ?? null, model: cfg.model } : null;
  // Why this conversation cannot be continued here, decided by the same code the POST enforces, so the
  // dialog never offers a button that is going to be refused.
  const { continueBlocker } = await import("../../../lib/agent/core.ts");
  return Response.json(
    key
      ? (() => { const chat = chats.find((c) => c.key === key); return chat ? { ...chat, target, blocked: wardId ? continueBlocker(user, wardId, chat) : 'No ward named.' } : null; })()
      : {
          chats: chats.map(({ key, title, device, updated, provider, endpoint, model }) => ({
            key,
            title,
            device,
            updated,
            provider,
            endpoint: endpoint ?? null,
            model: model ?? null,
          })),
          target,
          sync: syncStatus(user),
        },
    { headers: { "cache-control": "no-store" } },
  );
};
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  try {
    const user = locals.user.userId,
      body = await request.json();
    if (body.action === "sync") await syncRime(user, true);
    else if (body.conflict) {
      const saved = getDb()
        .prepare(
          "SELECT key,payload FROM agent_sync_conflicts WHERE user_id=? AND id=?",
        )
        .get(user, Number(body.conflict)) as
        | { key: string; payload: string }
        | undefined;
      if (!saved || !(saved.key.startsWith('work/') || saved.key === 'instance/dashboard' || saved.key.startsWith('appearance/image/')))
        throw Error("Recovery version not found.");
      captureRime(user);
      const current = syncRecord(user, saved.key);
      if (current) preserveConflict(user, current);
      const { createHash } = await import("node:crypto");
      installRecord(user, {
        ...saved,
        hash: createHash("sha256").update(saved.payload).digest("hex"),
      });
      void syncRime(user, true);
    } else {
      const { continueChat } = await import("../../../lib/agent/core.ts");
      const result = await continueChat(user, String(body.ward ?? ""), String(body.key ?? ""), { model: typeof body.model === "string" ? body.model : undefined, acknowledged: body.acknowledged === true });
      return Response.json({ ok: true, ...result }, { headers: { "cache-control": "no-store" } });
    }
    return Response.json(
      { ok: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Could not open history." },
      { status: (e as { status?: number })?.status === 409 ? 409 : 400 },
    );
  }
};
