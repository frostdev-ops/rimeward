import * as oidc from "openid-client";
import { config, publicOrigin, audit, identityEnabled } from "./app-config.ts";
import {
	getSetting,
	setSetting,
	takeSetting,
	sweepSettings,
	deleteSetting,
} from "./settings.ts";
import { sealToken, openToken } from "./crypto.ts";
import { getDb } from "./db.ts";
import { cached } from "./cache.ts";
import { adminCount, createUser, getUserByEmail, getUser } from "./users.ts";
import { accountEmail, takeAction } from "./account-access.ts";

export interface IdentityConnector {
	id: string;
	name: string;
	issuer: string;
	clientId: string;
	clientSecret: string;
	enabled: boolean;
	/** The issuer only ever hands out addresses it controls, so a missing
	 *  email_verified claim (Microsoft Entra never sends one) still counts. */
	trustEmail?: boolean;
}
export function identityConnectors(): IdentityConnector[] {
	const custom = JSON.parse(getSetting("identity_connectors") ?? "[]") as Omit<
		IdentityConnector,
		"clientSecret"
	>[];
	const builtins: IdentityConnector[] = [
		{
			id: "google",
			name: "Google",
			issuer: "https://accounts.google.com",
			clientId: config("GOOGLE_CLIENT_ID"),
			clientSecret: config("GOOGLE_CLIENT_SECRET"),
			enabled: identityEnabled("google"),
		},
		{
			id: "microsoft",
			name: "Microsoft",
			issuer: `https://login.microsoftonline.com/${config("MS_TENANT_ID")}/v2.0`,
			clientId: config("MS_CLIENT_ID"),
			clientSecret: config("MS_CLIENT_SECRET"),
			enabled: identityEnabled("microsoft"),
			trustEmail: !["common", "organizations", "consumers"].includes(
				config("MS_TENANT_ID"),
			),
		},
	];
	return [
		...builtins,
		...custom.map((c) => ({
			...c,
			clientSecret: openToken(getSetting(`identity_secret:${c.id}`) ?? ""),
		})),
	];
}
export function saveIdentityConnector(c: IdentityConnector, actor: number, clearSecret = false) {
	// The client id is stored and compared, and the settings form posts the field raw: an
	// untrimmed stray space would both be sent as client_id and read as a repoint.
	c = { ...c, clientId: c.clientId.trim() };
	const existing = identityConnectors().find((x) => x.id === c.id);
	// With passwords off an EXISTING connector may still be maintained (secret rotation,
	// name, enabled, trustEmail) — that is repair, not a new way in. Adding a connector or
	// pointing one at another issuer or client is a new way in, and needs passwords back —
	// unless nobody can sign in at all, where adding one is a repair, not a way in.
	if (
		config("PASSWORD_LOGIN") === "false" &&
		adminCount() > 0 &&
		(!existing ||
			existing.issuer !== c.issuer ||
			existing.clientId !== c.clientId)
	)
		throw new Error("Re-enable password login before changing SSO connectors");
	if (
		!/^[a-z][a-z0-9-]{1,39}$/.test(c.id) ||
		["google", "microsoft"].includes(c.id)
	)
		throw new Error("Use a unique connector ID");
	const issuer = new URL(c.issuer);
	if (
		issuer.protocol !== "https:" ||
		issuer.username ||
		issuer.password ||
		issuer.search ||
		issuer.hash
	)
		throw new Error("Issuer must use HTTPS");
	if (!c.name.trim() || !c.clientId.trim())
		throw new Error("Name and client ID are required");
	// A connector's issuer may mint `sub` per application too, so pointing one at another
	// client orphans the rows it left behind exactly as repointing the issuer does.
	const dead = existing && existing.clientId !== c.clientId ? c.id : undefined;
	getDb().transaction(() => {
		const before = adminCount();
		const list = JSON.parse(getSetting("identity_connectors") ?? "[]") as Omit<
			IdentityConnector,
			"clientSecret"
		>[];
		const { clientSecret, ...metadata } = c;
		if (clearSecret || clientSecret || !getSetting(`identity_secret:${c.id}`))
			setSetting(`identity_secret:${c.id}`, sealToken(clearSecret ? "" : clientSecret));
		setSetting(
			"identity_connectors",
			JSON.stringify([...list.filter((x) => x.id !== c.id), metadata]),
		);
		deleteSetting("identity_admin_verified");
		audit(actor, "identity.configured", c.id);
		if (before > 0 && adminCount(undefined, dead) === 0)
			throw new Error("This would lock out every administrator");
	})();
}
/** Sign-in rows for a removed connector stay: they are inert without it and revive if it returns. */
export function deleteIdentityConnector(id: string, actor: number): boolean {
	// The builtins are configured through CONFIG, never through the connector list.
	if (
		!/^[a-z][a-z0-9-]{1,39}$/.test(id) ||
		["google", "microsoft"].includes(id)
	)
		throw new Error("Unknown connector");
	return getDb().transaction(() => {
		const before = adminCount();
		const list = JSON.parse(getSetting("identity_connectors") ?? "[]") as Omit<
			IdentityConnector,
			"clientSecret"
		>[];
		// A replay (or a typo) must not report success, write an audit row and clear
		// identity_admin_verified — that silently re-locks PASSWORD_LOGIN=false.
		if (!list.some((x) => x.id === id)) return false;
		setSetting(
			"identity_connectors",
			JSON.stringify(list.filter((x) => x.id !== id)),
		);
		deleteSetting(`identity_secret:${id}`);
		deleteSetting("identity_admin_verified");
		audit(actor, "identity.removed", id);
		if (before > 0 && adminCount() === 0)
			throw new Error("This would lock out every administrator");
		return true;
	})();
}
/** One discovery per (issuer, client, secret) for five minutes, single-flight. Starting a
 *  sign-in is public and unauthenticated — GET /api/auth/identity/<id> is in PUBLIC_PREFIXES
 *  — so a fresh round trip per call is an amplifier aimed at the issuer, and a limiter cannot
 *  help: behind a reverse proxy every visitor shares one address, and keying it on the
 *  connector would throttle real sign-ins. A rotated secret changes the key and misses. */
export const discoveryKey = (c: IdentityConnector) =>
	`identity:discovery:${c.issuer}\u0000${c.clientId}\u0000${c.clientSecret}`;
/** Test seam, like the comms fetchImpl seams. The default reaches the pinned transport
 *  lazily so starting a sign-in is what pulls the sandbox module in. */
export const discoveryTransport = {
	request: async (
		url: string,
		options: {
			method?: string;
			headers?: Record<string, string>;
			body?: string;
			signal?: AbortSignal;
		},
	) => (await import("./agent/shell.ts")).pinnedRequest(url, options),
};
function client(c: IdentityConnector) {
	// cached() is TTL + single-flight: ten concurrent starts share one round trip, and a
	// rejection is never stored, so a failed discovery is retried rather than remembered.
	return cached(discoveryKey(c), 300000, async () => {
		const result = await oidc.discovery(
			new URL(c.issuer),
			c.clientId,
			c.clientSecret,
			c.clientSecret ? oidc.ClientSecretPost(c.clientSecret) : oidc.None(),
			{
				[oidc.customFetch]: async (url, options) => {
					const u = new URL(String(url));
					if (u.protocol !== "https:")
						throw new Error("Identity endpoints require HTTPS");
					const r = await discoveryTransport.request(u.toString(), {
						method: options?.method,
						headers: Object.fromEntries(new Headers(options?.headers)),
						body: options?.body ? String(options.body) : undefined,
						signal: options.signal,
					});
					return new Response(r.text, { status: r.status, headers: r.headers });
				},
				timeout: 15,
			},
		);
		oidc.enableNonRepudiationChecks(result);
		return result;
	});
}
function identityRedirectUri(id:string){return `${publicOrigin()}/api/auth/${id==='google'?'google/callback':`identity/${id}/callback`}`;}
export async function beginIdentity(
	id: string,
	linkUser?: number,
	inviteToken?: string,
) {
	const c = identityConnectors().find((c) => c.id === id && c.enabled);
	if (!c) throw new Error("Sign-in is not configured");
	sweepSettings("identity_pending:", 900000);
	const state = oidc.randomState(),
		nonce = oidc.randomNonce(),
		verifier = oidc.randomPKCECodeVerifier();
	const url = oidc.buildAuthorizationUrl(await client(c), {
		redirect_uri: identityRedirectUri(id),
		scope: "openid email profile",
		state,
		nonce,
		code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
		code_challenge_method: "S256",
	});
	setSetting(
		`identity_pending:${state}`,
		sealToken(
			JSON.stringify({
				id,
				nonce,
				verifier,
				linkUser,
				invite: inviteToken,
				at: Date.now(),
			}),
		),
	);
	return { state, url: url.toString() };
}
export async function finishIdentity(
	id: string,
	url: URL,
	cookie: string | undefined,
	sessionUser?: number,
) {
	const state = url.searchParams.get("state") ?? "";
	if (!cookie || cookie !== state || !/^[\w-]{20,128}$/.test(state))
		throw new Error("Sign-in browser does not match");
	const raw = takeSetting(`identity_pending:${state}`);
	if (!raw) throw new Error("Sign-in expired");
	const p = JSON.parse(openToken(raw));
	if (p.id !== id || Date.now() - p.at > 900000)
		throw new Error("Sign-in expired");
	const c = identityConnectors().find((c) => c.id === id && c.enabled);
	if (!c) throw new Error("Connector disabled");
	const canonical = new URL(
		identityRedirectUri(id),
	);
	canonical.search = url.search;
	const tokens = await oidc.authorizationCodeGrant(await client(c), canonical, {
		expectedState: state,
		expectedNonce: p.nonce,
		pkceCodeVerifier: p.verifier,
		idTokenExpected: true,
	});
	const claims = tokens.claims()!;
	const verified = identityEmailVerified(c, claims);
	if (p.invite)
		return {
			linked: false,
			user: acceptInvite(
				String(p.invite),
				id,
				String(claims.iss),
				String(claims.sub),
				claims.email ? String(claims.email) : undefined,
				verified,
			),
		};
	if (p.linkUser) {
		if (
			sessionUser !== p.linkUser ||
			getUser(sessionUser!)?.status !== "active"
		)
			throw new Error("Sign in again before linking");
		getDb()
			.prepare(
				"INSERT INTO login_identities(connector,issuer,subject,user_id) VALUES(?,?,?,?)",
			)
			.run(id, String(claims.iss), String(claims.sub), p.linkUser);
		audit(p.linkUser, "identity.linked", id);
		return {user:p.linkUser as number,linked:true};
	}
	return {linked:false,user:resolveIdentity(
		id,
		String(claims.iss),
		String(claims.sub),
		String(claims.email ?? ""),
		verified,
	)};
}
/** xms_edov is Microsoft's own claim, and only Microsoft's: no other issuer's claim of
 *  that name may stand in for email_verified. */
export function identityEmailVerified(
	c: IdentityConnector,
	claims: Record<string, unknown>,
): boolean {
	return (
		claims.email_verified === true ||
		(c.id === "microsoft" && claims.xms_edov === true) ||
		!!c.trustEmail
	);
}
/** An invitation is the account's proof of ownership: the first identity to arrive with
 *  the token becomes its sign-in method, no password anywhere in the flow. The token is
 *  what activates the account; the identity's own address is only ever believed when the
 *  issuer says it verified it, and when it is the address that was invited. */
export function acceptInvite(
	token: string,
	connector: string,
	issuer: string,
	subject: string,
	email: string | undefined,
	verified: boolean,
): number {
	return getDb().transaction(() => {
		const action = takeAction(token);
		if (action.purpose !== "invite")
			throw new Error("This link is invalid or expired");
		if (email && accountEmail(email) !== getUser(action.user_id)?.email)
			throw new Error("Sign in with the address this invitation was sent to");
		getDb()
			.prepare(
				"INSERT INTO login_identities(connector,issuer,subject,user_id) VALUES(?,?,?,?)",
			)
			.run(connector, issuer, subject, action.user_id);
		getDb()
			.prepare("UPDATE users SET email_verified=?,status='active' WHERE id=?")
			.run(email && verified ? 1 : 0, action.user_id);
		audit(action.user_id, "identity.invited", connector);
		return action.user_id;
	})();
}
export function resolveIdentity(
	connector: string,
	issuer: string,
	subject: string,
	email: string,
	verified: boolean,
) {
	return getDb().transaction(() => {
		const existing = getDb()
			.prepare(
				"SELECT user_id FROM login_identities WHERE connector=? AND issuer=? AND subject=?",
			)
			.get(connector, issuer, subject) as { user_id: number } | undefined;
		if (existing) {
			if (getUser(existing.user_id)?.status !== "active")
				throw new Error("Account is awaiting approval or suspended");
			return existing.user_id;
		}
		if (!verified)
			throw new Error("Your identity provider must verify your email");
		email = accountEmail(email);
		// Existing accounts require explicit linking; email alone is not account ownership.
		const legacy = getUserByEmail(email);
		if (legacy) {
			if (
				connector === "google" &&
				issuer === "https://accounts.google.com" &&
				legacy.status === "active" &&
				getDb()
					.prepare("SELECT 1 FROM legacy_google_users WHERE user_id=?")
					.get(legacy.id)
			) {
				getDb()
					.prepare(
						"INSERT INTO login_identities(connector,issuer,subject,user_id) VALUES(?,?,?,?)",
					)
					.run(connector, issuer, subject, legacy.id);
				getDb()
					.prepare("DELETE FROM legacy_google_users WHERE user_id=?")
					.run(legacy.id);
				return legacy.id;
			}
			throw new Error(
				"Sign in with your existing method before linking this identity",
			);
		}
		const domains = config("SSO_WORKSPACE_DOMAIN")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		if (
			config("REGISTRATION_POLICY") === "invite" ||
			(domains.length && !domains.includes(email.split("@")[1]!))
		)
			throw new Error("Ask an administrator for access");
		const user = createUser(email, null);
		const status =
			config("REGISTRATION_POLICY") === "approval" ? "pending" : "active";
		getDb()
			.prepare("UPDATE users SET email_verified=1,status=? WHERE id=?")
			.run(status, user);
		getDb()
			.prepare(
				"INSERT INTO login_identities(connector,issuer,subject,user_id) VALUES(?,?,?,?)",
			)
			.run(connector, issuer, subject, user);
		audit(user, "identity.created", connector);
		return status === "active" ? user : 0;
	})();
}
