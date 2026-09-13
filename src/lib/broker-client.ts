import { config, publicOrigin } from "./app-config.ts";
import { getSetting, setSetting, deleteSetting } from "./settings.ts";
import { sealToken, openToken } from "./crypto.ts";
import {
	startAttempt,
	attemptOf,
	attemptData,
	attemptView,
	claimAttempt,
	completeAttempt,
	cancelAttempt,
	failAttempt,
} from "./oauth-attempts.ts";
import { storeLink, type Provider } from "./linked-accounts.ts";
import { isDesktop } from "./dev/runtime.ts";
import {
	beginBroker,
	pollBroker,
	acknowledgeBroker,
	cancelBroker,
	type OAuthProvider,
	type BrokerTokens,
} from "./oauth-broker.ts";
interface ClientGrant {
	origin: string;
	id: string;
	key: string;
	code: string;
	verificationUrl: string;
	local: boolean;
}
export async function brokerRequest(
	origin: string,
	body: Record<string, unknown>,
) {
	const { pinnedRequest } = await import("./agent/shell.ts");
	const url = new URL(origin);
	if (url.protocol !== "https:") throw new Error("Broker requires HTTPS");
	const r = await pinnedRequest(`${url.origin}/api/oauth/broker`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (r.status !== 200)
		throw new Error(
			"OAuth broker unavailable or incompatible. Check its configuration.",
		);
	return JSON.parse(r.text);
}
export async function startIntegration(
	user: number,
	provider: OAuthProvider,
	session: string,
	options: { readonly?: boolean; teams?: boolean } = {},
) {
	const local = !isDesktop() && config("OAUTH_USE_BROKER") !== "true";
	const origin = local ? publicOrigin() : config("OAUTH_BROKER_URL");
	if (!origin)
		throw new Error(
			"Choose an OAuth broker in Admin settings before connecting",
		);
	const grant = local
		? beginBroker(provider, user, options)
		: await brokerRequest(origin, { action: "start", provider, options });
	if (
		!/^[\w-]{20,80}$/.test(grant.id) ||
		!/^[\w-]{20,80}$/.test(grant.key) ||
		!/^[A-F0-9]{12}$/.test(grant.code)
	)
		throw new Error("Invalid broker response");
	const data: ClientGrant = {
		origin,
		id: grant.id,
		key: grant.key,
		code: grant.code,
		verificationUrl: `${origin}/oauth/broker?code=${grant.code}`,
		local,
	};
	const attempt = startAttempt(
		user,
		provider,
		isDesktop() ? "This desktop" : new URL(publicOrigin()).host,
		session,
		data,
	);
	return {
		...attemptView(attempt),
		verificationUrl: data.verificationUrl,
		code: grant.code,
	};
}
export async function pollIntegration(
	user: number,
	id: string,
	session: string,
) {
	const attempt = attemptOf(user, id, session);
	const receipt = getSetting(`broker_receipt:${id}`);
	if (receipt) {
		const data = JSON.parse(openToken(receipt)) as ClientGrant;
		if (data.local) acknowledgeBroker(data.id, data.key);
		else
			await brokerRequest(data.origin, {
				action: "ack",
				id: data.id,
				key: data.key,
			});
		deleteSetting(`broker_receipt:${id}`);
	}
	if (!["pending", "authorizing"].includes(attempt.status))
		return attemptView(attempt);
	const data = attemptData<ClientGrant>(attempt);
	const result = data.local
		? pollBroker(data.id, data.key)
		: await brokerRequest(data.origin, {
				action: "poll",
				id: data.id,
				key: data.key,
			});
	if (["failed", "revoked"].includes(result.status)) {
		claimAttempt(user, id);
		failAttempt(user, id);
		return attemptView(attemptOf(user, id));
	}
	if (result.status === "ready") {
		const tok = result.tokens as BrokerTokens;
		claimAttempt(user, id);
		completeAttempt(user, id, () => {
			storeLink({
				userId: user,
				provider: attempt.provider as Provider,
				label: tok.label,
				refreshToken: tok.refresh_token ?? tok.access_token,
				accessToken: tok.access_token,
				expiresInSec: tok.refresh_token ? (tok.expires_in ?? 3600) : undefined,
				scopes: tok.scope,
				meta: {
					...tok.meta,
					rotating: !!tok.refresh_token,
					broker: !data.local,
				},
			});
			setSetting(`broker_receipt:${id}`, sealToken(JSON.stringify(data)));
			if (!data.local)
				setSetting(
					`broker_connection:${user}:${attempt.provider}`,
					sealToken(JSON.stringify(data)),
				);
		});
		if (data.local) acknowledgeBroker(data.id, data.key);
		else
			await brokerRequest(data.origin, {
				action: "ack",
				id: data.id,
				key: data.key,
			});
		deleteSetting(`broker_receipt:${id}`);
	}
	const current=attemptOf(user,id,session);return {...attemptView(current),...(['pending','authorizing'].includes(current.status)?integrationURL(user,id,session):{})};
}
export async function cancelIntegration(
	user: number,
	id: string,
	session: string,
) {
	const attempt = attemptOf(user, id, session),
		data = attemptData<ClientGrant>(attempt);
	cancelAttempt(user, id, session);
	if (data.local) cancelBroker(data.id, data.key);
	else
		await brokerRequest(data.origin, {
			action: "cancel",
			id: data.id,
			key: data.key,
		});
}
export async function refreshBrokerConnection(
	user: number,
	provider: Provider,
	token: string,
	meta: Record<string, unknown>,
): Promise<BrokerTokens> {
	const raw = getSetting(`broker_connection:${user}:${provider}`);
	if (!raw) throw new Error("Reconnect this provider");
	const data = JSON.parse(openToken(raw)) as ClientGrant;
	return brokerRequest(data.origin, {
		action: "refresh",
		id: data.id,
		key: data.key,
		token,
		meta,
	});
}

export async function disconnectBrokerConnection(
	user: number,
	provider: Provider,
) {
	const name = `broker_connection:${user}:${provider}`,
		raw = getSetting(name);
	if (!raw) return;
	const data = JSON.parse(openToken(raw)) as ClientGrant;
	await brokerRequest(data.origin, {
		action: "cancel",
		id: data.id,
		key: data.key,
	});
	deleteSetting(name);
}

export function integrationURL(user:number,id:string,session:string){
  const row=attemptOf(user,id,session);
  if(!['pending','authorizing'].includes(row.status))throw new Error('Sign-in expired or completed');
  const data=attemptData<ClientGrant>(row);return {verificationUrl:data.verificationUrl,code:data.code};
}
