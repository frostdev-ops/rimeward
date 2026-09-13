import { getSetting, setSetting } from "../../../lib/settings.ts";
import type { APIRoute } from "astro";
import {
	codexOauthStart,
	codexOauthFinish,
	codexOauthPending,
	codexOauthCancel,
} from "../../../lib/agent/codex.ts";
import {
	attemptOf,
	attemptSession,
	attemptView,
	failAttempt,
} from "../../../lib/oauth-attempts.ts";
import {
	listenForCodex,
	closeCodexListener,
	codexListenerActive,
} from "../../../lib/codex-loopback.ts";
import { isDesktop } from "../../../lib/dev/runtime.ts";
import {
	nativeDesktop,
	rimeConnection,
	instanceRequest,
} from "../../../lib/dev/remote.ts";
import { publicOrigin } from "../../../lib/app-config.ts";
export const ALL: APIRoute = async ({ request, url, locals, cookies }) => {
	if (
		isDesktop() &&
		(request.headers.has("x-rimeward-native-token") ||
			request.headers.get("x-rimeward-relayed") === "1")
	)
		return new Response("Open sign-in on this desktop directly", {
			status: 403,
		});
	const user = locals.user!.userId,
		session = attemptSession(request, cookies);
	if (!session) return new Response("Sign in required", { status: 401 });
	const json = (v: unknown) =>
		Response.json(v, { headers: { "cache-control": "no-store" } });
	try {
		const connection = isDesktop() ? await rimeConnection(user) : undefined;
		const body = request.method === "POST" ? await request.json() : {};
		const remoteKey = `oauth_remote:${user}:${String(body.id ?? url.searchParams.get("id") ?? "")}`;
		const owner = getSetting(remoteKey);
		const remote =
			!!owner ||
			(body.action === "start" && connection && body.destination !== "local");
		if (remote) {
			if (!connection || (owner && owner !== connection.id))
				throw new Error(
					"The original server is unavailable. Reconnect it to finish this sign-in.",
				);
			const forward = async (payload: Record<string, unknown>) => {
				const current = await rimeConnection(user);
				if (current?.id !== connection.id)
					throw new Error("The destination server changed");
				const req = new Request("https://rimeward.invalid/api/account/oauth", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
				});
				const response = await instanceRequest(user, "/api/account/oauth", req);
				const value = await response.json();
				if (!response.ok)
					throw new Error(
						value.error ?? "Update the server to use browser sign-in",
					);
				return value;
			};
			if (request.method === "GET") {
				const response = await instanceRequest(
					user,
					`/api/account/oauth?id=${encodeURIComponent(url.searchParams.get("id") ?? "")}`,
					new Request("https://rimeward.invalid/api/account/oauth"),
				);
				if (!response.ok) return response;
				const data = await response.json();
				return json({ ...data, automatic: codexListenerActive(data.id) });
			}
			if (body.action === "start") {
				const data = await forward(body);
				setSetting(`oauth_remote:${user}:${data.id}`, connection.id);
				setSetting(`oauth_open:${user}:${data.id}`, data.url);
				try {
					await listenForCodex(
						data.id,
						new URL(data.url).searchParams.get("state") ?? "",
						async (pasted) => {
							await forward({ action: "finish", id: data.id, pasted });
						},
					);
					data.automatic = true;
				} catch {
					data.automatic = false;
				}
				if (data.automatic)
					try {
						await nativeDesktop("open-url", { url: data.url });
						data.browserOpened = true;
					} catch {
						data.browserOpened = false;
					}
				return json(data);
			}
			if (body.action === "open") {
				const target = getSetting(`oauth_open:${user}:${body.id}`);
				if (!target) throw new Error("Sign-in expired");
				await nativeDesktop("open-url", { url: target });
				return json({ ok: true });
			}
			if (body.action === "cancel") closeCodexListener(String(body.id));
			return json(await forward(body));
		}
		if (request.method === "GET" && url.searchParams.has("capabilities"))
			return json({
				protocol: 1,
				providers: ["codex", "google", "microsoft", "notion", "zoho"],
				automatic: isDesktop(),
			});
		if (request.method === "GET") {
			const id = url.searchParams.get("id") ?? "";
			return json({
				...attemptView(attemptOf(user, id, session)),
				url: codexOauthPending(user, id)?.url,
				automatic: codexListenerActive(id),
			});
		}
		if (request.method !== "POST") return new Response(null, { status: 405 });
		if (body.action === "start") {
			const pending = codexOauthStart(
				user,
				session,
				isDesktop() ? "This desktop" : new URL(publicOrigin()).host,
			);
			let automatic = false;
			if (isDesktop())
				try {
					await listenForCodex(pending.id, pending.state, async (url) => {
						try {
							await codexOauthFinish(user, url, pending.id);
						} catch (e) {
							failAttempt(user, pending.id);
							throw e;
						}
					});
					automatic = true;
				} catch {}
			let browserOpened = false;
			if (automatic)
				try {
					await nativeDesktop("open-url", { url: pending.url });
					browserOpened = true;
				} catch {}
			return json({
				...attemptView(attemptOf(user, pending.id)),
				url: pending.url,
				automatic,
				browserOpened,
			});
		}
		const id = String(body.id ?? "");
		attemptOf(user, id, session);
		if (body.action === "cancel") {
			codexOauthCancel(user, id);
			closeCodexListener(id);
			return json(attemptView(attemptOf(user, id)));
		}
		const pending = codexOauthPending(user, id);
		if (!pending) throw new Error("Sign-in expired. Start again.");
		if (body.action === "open") {
			await nativeDesktop("open-url", { url: pending.url });
			return json({ ok: true });
		}
		if (body.action === "finish") {
			await codexOauthFinish(user, String(body.pasted ?? ""), id);
			closeCodexListener(id);
			return json(attemptView(attemptOf(user, id)));
		}
		throw new Error("Unknown sign-in action");
	} catch (e) {
		return Response.json(
			{ error: e instanceof Error ? e.message : "Sign-in failed" },
			{ status: 400, headers: { "cache-control": "no-store" } },
		);
	}
};
