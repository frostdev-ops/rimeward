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
import { createUser, getUserByEmail, getUser } from "./users.ts";
import { accountEmail } from "./account-access.ts";

export interface IdentityConnector {
	id: string;
	name: string;
	issuer: string;
	clientId: string;
	clientSecret: string;
	enabled: boolean;
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
			enabled:
				config("GOOGLE_SSO_ENABLED") === "true" && !!config("GOOGLE_CLIENT_ID"),
		},
		{
			id: "microsoft",
			name: "Microsoft",
			issuer: `https://login.microsoftonline.com/${config("MS_TENANT_ID")}/v2.0`,
			clientId: config("MS_CLIENT_ID"),
			clientSecret: config("MS_CLIENT_SECRET"),
			enabled: identityEnabled("microsoft"),
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
	if (config("PASSWORD_LOGIN") === "false")
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
	getDb().transaction(() => {
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
	})();
}
async function client(c: IdentityConnector) {
	// Discovery and every subsequent server request share the existing pinned transport.
	const { pinnedRequest } = await import("./agent/shell.ts");
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
				const r = await pinnedRequest(u.toString(), {
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
}
function identityRedirectUri(id:string){return `${publicOrigin()}/api/auth/${id==='google'?'google/callback':`identity/${id}/callback`}`;}
export async function beginIdentity(id: string, linkUser?: number) {
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
			JSON.stringify({ id, nonce, verifier, linkUser, at: Date.now() }),
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
		claims.email_verified === true,
	)};
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
