import crypto from "node:crypto";
import { getDb } from "./db.ts";
import { sealToken, openToken } from "./crypto.ts";
import { mintState } from "./oauth.ts";
import {
	googleConnectUrl,
	microsoftConnectUrl,
	notionConnectUrl,
	zohoConnectUrl,
	zohoAccountsBase,
} from "./connect.ts";
import { config } from "./app-config.ts";
import { secret } from "./secrets.ts";
export const oauthProviders = [
	"google",
	"microsoft",
	"notion",
	"zoho",
] as const;
export type OAuthProvider = (typeof oauthProviders)[number];
export interface BrokerTokens {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	label: string;
	scope?: string;
	meta?: Record<string, unknown>;
}
interface Grant {
	options_json: string;
	id: string;
	secret_hash: string;
	user_code: string;
	user_id: number | null;
	provider: OAuthProvider;
	status: string;
	expires_at: number;
	delivery_enc: string;
	refresh_hash: string;
	previous_refresh_hash: string;
	last_poll: number;
}
const digest = (s: string) =>
	crypto.createHash("sha256").update(s).digest("hex");
export function beginBroker(
	provider: OAuthProvider,
	user?: number,
	options: { readonly?: boolean; teams?: boolean; local?: boolean } = {},
) {
	if (!oauthProviders.includes(provider)) throw new Error("Unknown provider");
	const prefix = {
		google: "GOOGLE",
		microsoft: "MS",
		notion: "NOTION",
		zoho: "ZOHO",
	}[provider];
	if (
		!secret(`${prefix}_CLIENT_ID` as "GOOGLE_CLIENT_ID") ||
		!secret(`${prefix}_CLIENT_SECRET` as "GOOGLE_CLIENT_SECRET")
	)
		throw new Error("Configure this provider in Admin settings first");
	const id = crypto.randomBytes(24).toString("base64url"),
		key = crypto.randomBytes(32).toString("base64url"),
		code = crypto.randomBytes(6).toString("hex").toUpperCase();
	getDb()
		.prepare(
			"UPDATE oauth_broker_grants SET delivery_enc='',previous_refresh_hash='' WHERE status='active' AND expires_at<?",
		)
		.run(Date.now());
	getDb()
		.prepare(
			"DELETE FROM oauth_broker_grants WHERE expires_at<? AND status!='active'",
		)
		.run(Date.now());
	getDb()
		.prepare(
			"INSERT INTO oauth_broker_grants(id,secret_hash,user_code,provider,expires_at,user_id,options_json) VALUES(?,?,?,?,?,?,?)",
		)
		.run(
			id,
			digest(key),
			code,
			provider,
			Date.now() + 900000,
			user ?? null,
			JSON.stringify({
				readonly: options.readonly === true,
				teams: options.teams === true,
				// The public broker route passes an unauthenticated caller's own JSON as
				// options and never a user: a grant is local only when this server started it.
				local: options.local === true && user !== undefined,
			}),
		);
	return {
		id,
		key,
		code,
		verificationPath: `/oauth/broker?code=${code}`,
		expiresAt: Date.now() + 900000,
	};
}
export function brokerByCode(code: string): Grant {
	const grant = getDb()
		.prepare(
			"SELECT * FROM oauth_broker_grants WHERE user_code=? AND expires_at>? AND status IN ('pending','authorizing')",
		)
		.get(code, Date.now()) as Grant | undefined;
	if (!grant) throw new Error("Connection request expired");
	return grant;
}
function ownedGrant(id: string, key: string): Grant {
	const g = getDb()
		.prepare("SELECT * FROM oauth_broker_grants WHERE id=? AND secret_hash=?")
		.get(id, digest(key)) as Grant | undefined;
	if (!g || g.status === "revoked")
		throw new Error("Connection grant is unavailable");
	if (g.status !== "active" && g.expires_at <= Date.now())
		throw new Error("Connection request expired");
	if (
		g.user_id &&
		!getDb()
			.prepare("SELECT 1 FROM users WHERE id=? AND status='active'")
			.get(g.user_id)
	)
		throw new Error("Account is not active");
	return g;
}
export function authorizeBroker(code: string, user: number) {
	const g = brokerByCode(code);
	if (g.user_id !== null && g.user_id !== user)
		throw new Error("Sign in to the account that started this connection");
	if (
		!getDb()
			.prepare("SELECT 1 FROM users WHERE id=? AND status='active'")
			.get(user)
	)
		throw new Error("Sign in first");
	const changed = getDb()
		.prepare(
			"UPDATE oauth_broker_grants SET user_id=?,status='authorizing' WHERE id=? AND status='pending'",
		)
		.run(user, g.id);
	if (!changed.changes)
		throw new Error("This request has already been answered");
	const options = JSON.parse(g.options_json);
	const state = mintState(g.provider, user, {
		brokerId: g.id,
		readonly: options.readonly,
	});
	return g.provider === "google"
		? googleConnectUrl(state)
		: g.provider === "microsoft"
			? microsoftConnectUrl(state, options.readonly, options.teams)
			: g.provider === "notion"
				? notionConnectUrl(state)
				: zohoConnectUrl(state);
}
export function deliverBroker(id: string, user: number, tokens: BrokerTokens) {
	if (!tokens.access_token) throw new Error("Missing provider token");
	const changed = getDb()
		.prepare(
			"UPDATE oauth_broker_grants SET delivery_enc=?,refresh_hash=?,status='ready' WHERE id=? AND user_id=? AND status='authorizing' AND expires_at>?",
		)
		.run(
			sealToken(JSON.stringify(tokens)),
			digest(tokens.refresh_token ?? tokens.access_token),
			id,
			user,
			Date.now(),
		);
	if (!changed.changes) throw new Error("Connection was cancelled or expired");
}
export function pollBroker(id: string, key: string) {
	const g = ownedGrant(id, key);
	if (Date.now() - g.last_poll < 2500) return { status: "pending" };
	getDb()
		.prepare("UPDATE oauth_broker_grants SET last_poll=? WHERE id=?")
		.run(Date.now(), id);
	return g.status === "ready"
		? {
				status: "ready",
				tokens: JSON.parse(openToken(g.delivery_enc)) as BrokerTokens,
			}
		: { status: g.status };
}
export function acknowledgeBroker(id: string, key: string) {
	ownedGrant(id, key);
	getDb()
		.prepare(
			"UPDATE oauth_broker_grants SET status='active',delivery_enc='' WHERE id=? AND status='ready'",
		)
		.run(id);
}
export function cancelBroker(id: string, key: string) {
	ownedGrant(id, key);
	getDb()
		.prepare(
			"UPDATE oauth_broker_grants SET status='revoked',delivery_enc='',refresh_hash='' WHERE id=?",
		)
		.run(id);
}
const refreshes = new Map<string, Promise<BrokerTokens>>();
export function refreshBroker(
	id: string,
	key: string,
	token: string,
	meta: Record<string, unknown> = {},
) {
	const g = ownedGrant(id, key);
	if (
		g.status === "active" &&
		g.previous_refresh_hash === digest(token) &&
		g.delivery_enc &&
		g.expires_at > Date.now()
	)
		return Promise.resolve(
			JSON.parse(openToken(g.delivery_enc)) as BrokerTokens,
		);
	if (g.status !== "active" || g.refresh_hash !== digest(token))
		throw new Error("Connection does not own this token");
	const running = refreshes.get(id);
	if (running) return running;
	const work = (async () => {
		const prefix = {
			google: "GOOGLE",
			microsoft: "MS",
			notion: "NOTION",
			zoho: "ZOHO",
		}[g.provider];
		const clientId = secret(`${prefix}_CLIENT_ID` as "GOOGLE_CLIENT_ID"),
			clientSecret = secret(
				`${prefix}_CLIENT_SECRET` as "GOOGLE_CLIENT_SECRET",
			);
		const endpoint =
			g.provider === "google"
				? "https://oauth2.googleapis.com/token"
				: g.provider === "microsoft"
					? `https://login.microsoftonline.com/${config("MS_TENANT_ID")}/oauth2/v2.0/token`
					: g.provider === "notion"
						? "https://api.notion.com/v1/oauth/token"
						: `${zohoAccountsBase(String(meta.accounts_base ?? "https://accounts.zoho.com"))}/oauth/v2/token`;
		const response = await fetch(endpoint, {
			method: "POST",
			headers:
				g.provider === "notion"
					? {
							"content-type": "application/json",
							authorization:
								"Basic " +
								Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
						}
					: { "content-type": "application/x-www-form-urlencoded" },
			body:
				g.provider === "notion"
					? JSON.stringify({
							grant_type: "refresh_token",
							refresh_token: token,
						})
					: new URLSearchParams({
							grant_type: "refresh_token",
							refresh_token: token,
							client_id: clientId,
							client_secret: clientSecret,
						}),
			signal: AbortSignal.timeout(15000),
			redirect: "error",
		});
		if (!response.ok) throw new Error("Provider refresh failed");
		const data = (await response.json()) as BrokerTokens;
		if (!data.access_token) throw new Error("Provider refresh failed");
		const changed = getDb()
			.prepare(
				"UPDATE oauth_broker_grants SET refresh_hash=?,previous_refresh_hash=?,delivery_enc=?,expires_at=? WHERE id=? AND status='active' AND refresh_hash=?",
			)
			.run(
				digest(data.refresh_token ?? token),
				digest(token),
				sealToken(JSON.stringify(data)),
				Date.now() + 900000,
				id,
				digest(token),
			);
		if (!changed.changes) throw new Error("Connection was revoked");
		return data;
	})().finally(() => refreshes.delete(id));
	refreshes.set(id, work);
	return work;
}

export function rejectBroker(id: string, user: number) {
	getDb()
		.prepare(
			"UPDATE oauth_broker_grants SET status='failed',delivery_enc='' WHERE id=? AND user_id=? AND status='authorizing'",
		)
		.run(id, user);
}
/** Where a connect callback sends the browser back to: a local grant was started
 *  in this same browser's session, so it skips the broker confirmation page. A row
 *  swept mid-consent is gone, and only the caller still knows the provider — a
 *  browser that never saw the broker page must not be sent to it. */
export function brokerDone(
	id: string,
	provider: string,
	error?: "denied" | "failed",
): string {
	const g = getDb()
		.prepare("SELECT options_json FROM oauth_broker_grants WHERE id=?")
		.get(id) as { options_json: string } | undefined;
	if (!g) return `/account?err=${provider}-failed`;
	if (JSON.parse(g.options_json).local === true)
		return error ? `/account?err=${provider}-${error}` : "/account#accounts";
	return `/oauth/broker?done=1${error ? `&error=${error}` : ""}`;
}
