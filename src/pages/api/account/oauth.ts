import { getSetting, setSetting } from "../../../lib/settings.ts";
import { createHash } from "node:crypto";
import type { APIRoute } from "astro";
import {
	codexAttempts,
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
	instanceRequestOn,
} from "../../../lib/dev/remote.ts";
import { sharedRime } from "../../../lib/agent/sync.ts";
import { publicOrigin } from "../../../lib/app-config.ts";
import { oauthRuntimeBinding } from "../../../lib/agent/provider-scope.ts";

/**
 * Which installation and account a sign-in card is offering, as one opaque string.
 *
 * A card sends it back when it starts, and a start whose binding no longer matches is REFUSED rather
 * than retargeted: a page left open across a server switch, an unpair or a re-designation must not
 * quietly sign a different account in. It is deliberately not the credential generation — saving a
 * key beside an open sign-in card should not cancel it — only WHICH installation and WHICH server
 * account the card was showing.
 */
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
		const connection = isDesktop() ? await rimeConnection(user).catch(() => undefined) : undefined;
		const shared = isDesktop() ? sharedRime(user) : null;
		const body = request.method === "POST" ? await request.json() : {};
		const remoteKey = `oauth_remote:${user}:${String(body.id ?? url.searchParams.get("id") ?? "")}`;
		const storedOwner = getSetting(remoteKey);
		const sessionHash = createHash("sha256").update(session).digest("hex");
		let owner: { pair: string; profile: string; session: string } | undefined;
		if (storedOwner) {
			try { owner = JSON.parse(storedOwner); } catch { throw new Error("This older sign-in cannot establish its initiating session. Start a new sign-in."); }
			if (!owner || owner.session !== sessionHash) throw new Error("Sign-in attempt is unavailable.");
		}
		// A started attempt keeps the destination it was started with, for its whole life: the pointer
		// above IS that record, and nothing below re-derives it from today's settings or connectivity.
		if (body.action === "start") {
			const wanted = String(body.destination ?? "");
			// Naming the server when there is none is a REFUSAL. Falling through to a local sign-in
			// here would connect an account to an installation the person did not choose.
			if (wanted === "server" && !connection)
				throw new Error(
					"No connected server is designated, so there is nowhere to sign this account in. Nothing was started on this desktop.",
				);
			if (!["local", "server"].includes(wanted) || typeof body.binding !== "string" || !body.binding)
				throw new Error("Reload the provider card and choose its explicit sign-in destination.");
			if (wanted === "local" && body.binding !== oauthRuntimeBinding(user))
				throw new Error("This provider card is stale. Reload it before starting sign-in.");
			if (wanted === "server" && (!shared || shared.authority !== true ||
				!body.binding.startsWith(`server:${connection!.id}:${shared.profile}:oauth:`)))
				throw new Error("This card no longer names the verified connected server. Reload it.");
		}
		const remote =
			!!owner ||
			(body.action === "start" && body.destination === "server");
		if (remote) {
			if (!connection || (owner && (owner.pair !== connection.id || owner.profile !== shared?.profile)))
				throw new Error(
					"The original server is unavailable. Reconnect it to finish this sign-in.",
				);
			// The connection validated above is the one every hop of this attempt travels on: looking
			// the designated server up again inside the transport is how an admitted operation reaches
			// a different account.
			const forward = async (payload: Record<string, unknown>) => {
				const current = await rimeConnection(user);
				if (current?.id !== connection.id)
					throw new Error("The destination server changed");
				const req = new Request("https://rimeward.invalid/api/account/oauth", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
				});
				const response = await instanceRequestOn(connection, user, "/api/account/oauth", req, session);
				const value = await response.json();
				if (!response.ok)
					throw new Error(
						value.error ?? "Update the server to use browser sign-in",
					);
				return value;
			};
			if (request.method === "GET") {
				const response = await instanceRequestOn(
					connection,
					user,
					`/api/account/oauth?id=${encodeURIComponent(url.searchParams.get("id") ?? "")}`,
					new Request("https://rimeward.invalid/api/account/oauth"),
					session,
				);
				if (!response.ok) return response;
				const data = await response.json();
				return json({ ...data, automatic: codexListenerActive(data.id) });
			}
			if (body.action === "start") {
				const remoteBinding = String(body.binding).slice(`server:${connection.id}:${shared!.profile}:`.length);
				const data = await forward({ ...body, destination: "local", binding: remoteBinding });
				setSetting(`oauth_remote:${user}:${data.id}`, JSON.stringify({ pair: connection.id, profile: shared!.profile, session: sessionHash }));
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
				protocol: 2,
				providers: ["codex", "google", "microsoft", "notion", "zoho"],
				automatic: isDesktop(),
				scoped: true,
				// What this runtime can offer RIGHT NOW, each with the binding a start must carry.
				// The card asks for these at the moment it starts, so a page left open across a
				// server switch sends a binding that no longer matches and is refused.
				destinations: [
					{ kind: "local", binding: oauthRuntimeBinding(user), available: true },
					...(connection
						? [{
							kind: "server",
							binding: "",
							host: shared ? new URL(shared.server).host : "",
							available: false,
						}]
						: []),
				],
			});
		if (
			request.method === "GET" &&
			url.searchParams.has("attempts") &&
			url.searchParams.get("target") === "server"
		) {
			// A server-owned attempt lives in the SERVER's table; enumerating locally would never
			// recover it, which is how a reload lost a remote sign-in in progress.
			if (!connection) throw new Error("No connected server is designated.");
			const prefix = `server:${connection.id}:${shared?.profile}:`;
			const binding = url.searchParams.get("binding") ?? "";
			if (!shared || shared.authority !== true || !binding.startsWith(prefix + "oauth:"))
				throw new Error("Reload the server provider card before recovering sign-in.");
			const response = await instanceRequestOn(
				connection,
				user,
				`/api/account/oauth?attempts=1&binding=${encodeURIComponent(binding.slice(prefix.length))}`,
				new Request("https://rimeward.invalid/api/account/oauth"),
				session,
			);
			if (!response.ok) return response;
			const value = (await response.json()) as { attempts?: { id: string }[] };
			for (const a of value.attempts ?? [])
				setSetting(`oauth_remote:${user}:${a.id}`, JSON.stringify({ pair: connection.id, profile: shared.profile, session: sessionHash }));
			return json({
				attempts: (value.attempts ?? []).map((a) => ({
					...a,
					remote: true,
					automatic: codexListenerActive(a.id),
				})),
			});
		}
		if (request.method === "GET" && url.searchParams.has("attempts")) {
			if (url.searchParams.get("binding") !== oauthRuntimeBinding(user))
				throw new Error("Reload the provider card before recovering sign-in.");
			// Explicit ids, so a card can recover its OWN attempt after a reload and never adopt one
			// that belongs to the other destination.
			return json({
				attempts: codexAttempts(user, session).map((a) => ({
					...a,
					remote: !!getSetting(`oauth_remote:${user}:${a.id}`),
					automatic: codexListenerActive(a.id),
				})),
			});
		}
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
