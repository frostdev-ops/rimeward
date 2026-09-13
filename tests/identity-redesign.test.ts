import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { getDb, DATA_DIR } from "../src/lib/db.ts";
import { config, saveConfig, configView } from "../src/lib/app-config.ts";
import { getSetting, setSetting } from "../src/lib/settings.ts";
import {
	ensureSetupToken,
	claimInstallation,
	needsSetup,
} from "../src/lib/installation.ts";
import { createUser, setUserStatus } from "../src/lib/users.ts";
import { createSession, getSession } from "../src/lib/auth.ts";
import {
	startAttempt,
	claimAttempt,
	completeAttempt,
	cancelAttempt,
	attemptOf,
	attemptView,
} from "../src/lib/oauth-attempts.ts";
import { actionToken, redeemAction } from "../src/lib/account-access.ts";
import { zohoAccountsBase } from "../src/lib/connect.ts";
import {
	beginBroker,
	authorizeBroker,
	deliverBroker,
	pollBroker,
	acknowledgeBroker,
	refreshBroker,
	cancelBroker,
} from "../src/lib/oauth-broker.ts";
import { resolveIdentity,saveIdentityConnector,identityConnectors } from "../src/lib/identity.ts";

test("installer must prove ownership and cannot replay setup", () => {
	ensureSetupToken();
	assert.equal(needsSetup(), true);
	const token = fs.readFileSync(`${DATA_DIR}/setup-token`, "utf8");
	assert.throws(() =>
		claimInstallation(
			"wrong",
			"owner@example.com",
			"long-password-123",
			"https://example.com",
		),
	);
	const id = claimInstallation(
		token,
		"owner@example.com",
		"long-password-123",
		"https://example.com",
	);
	assert.equal(needsSetup(), false);
	assert.equal(fs.existsSync(`${DATA_DIR}/setup-token`), false);
	assert.throws(() =>
		claimInstallation(
			token,
			"other@example.com",
			"long-password-123",
			"https://example.com",
		),
	);
	assert.throws(() => setUserStatus(id, "suspended", id), /only active/);
});
test("saved config wins, secrets migrate encrypted and never appear in views", () => {
	process.env.GOOGLE_CLIENT_SECRET = "env-secret";
	setSetting("secret:GOOGLE_CLIENT_SECRET", "legacy-secret");
	assert.equal(config("GOOGLE_CLIENT_SECRET"), "legacy-secret");
	assert.equal(getSetting("secret:GOOGLE_CLIENT_SECRET"), null);
	assert.ok(
		!getSetting("config:GOOGLE_CLIENT_SECRET")!.includes("legacy-secret"),
	);
	assert.equal(configView("GOOGLE_CLIENT_SECRET").value, "");
	saveConfig("GOOGLE_CLIENT_SECRET", null, null);
	assert.equal(config("GOOGLE_CLIENT_SECRET"), "env-secret");
});
test("suspension blocks existing sessions and new session issuance", () => {
	const user = createUser("suspended@example.com", "long-password-123");
	const session = createSession(user);
	setUserStatus(user, "suspended", 1);
	assert.equal(getSession(session.id), null);
	assert.throws(() => createSession(user));
});
test("OAuth completion is single-use and cancellation prevents writes", () => {
	const user = createUser("oauth@example.com", null);
	const row = startAttempt(user, "codex", "server", "session", {
		verifier: "secret",
	});
	assert.throws(() => attemptOf(user, row.id, "another-session"));
	assert.ok(!JSON.stringify(attemptView(row)).includes("secret"));
	claimAttempt(user, row.id);
	assert.throws(() => claimAttempt(user, row.id));
	cancelAttempt(user, row.id);
	let wrote = false;
	assert.throws(() =>
		completeAttempt(user, row.id, () => {
			wrote = true;
		}),
	);
	assert.equal(wrote, false);
});
test("verified pending users cannot bypass administrator approval with reset", () => {
	const user = createUser("pending@example.com", null);
	getDb()
		.prepare("UPDATE users SET status='pending',email_verified=1 WHERE id=?")
		.run(user);
	const token = actionToken(user, "reset");
	assert.equal(redeemAction(token, "new-password-long"), "pending");
	assert.throws(() => redeemAction(token, "new-password-long"));
});
test("Zoho exchange and refresh endpoints reject foreign hosts", () => {
	assert.equal(
		zohoAccountsBase("https://accounts.zoho.eu/"),
		"https://accounts.zoho.eu",
	);
	for (const host of [
		"https://evil.example",
		"https://accounts.zoho.com.evil.example",
		"http://accounts.zoho.com",
		"https://accounts.zoho.com@evil.example",
	])
		assert.throws(() => zohoAccountsBase(host));
});
test("broker cannot be approved by a different destination account or claimed without its secret", () => {
	const user = createUser("broker@example.com", null),
		other = createUser("broker-other@example.com", null);
	saveConfig("GOOGLE_CLIENT_ID", "client", null);
	saveConfig("GOOGLE_CLIENT_SECRET", "secret", null);
	const grant = beginBroker("google", user);
	assert.throws(() => authorizeBroker(grant.code, other));
	authorizeBroker(grant.code, user);
	assert.throws(() => authorizeBroker(grant.code, user));
	deliverBroker(grant.id, user, {
		access_token: "access",
		refresh_token: "refresh",
		label: "Google",
	});
	assert.throws(() => pollBroker(grant.id, "wrong"));
	assert.equal(pollBroker(grant.id, grant.key).status, "ready");
	acknowledgeBroker(grant.id, grant.key);
	assert.equal(
		(
			getDb()
				.prepare("SELECT delivery_enc FROM oauth_broker_grants WHERE id=?")
				.get(grant.id) as { delivery_enc: string }
		).delivery_enc,
		"",
	);
});
test("OIDC never links another issuer to an existing account just by email", () => {
	const connector={id:'test-oidc',name:'Test',issuer:'https://issuer.example',clientId:'client',clientSecret:'secret',enabled:true};
	saveIdentityConnector(connector,1);saveIdentityConnector({...connector,clientSecret:''},1);
	assert.equal(identityConnectors().find(c=>c.id==='test-oidc')?.clientSecret,'secret');
	saveIdentityConnector({...connector,clientSecret:''},1,true);
	assert.equal(identityConnectors().find(c=>c.id==='test-oidc')?.clientSecret,'');
	createUser("identity@example.com", null);
	assert.throws(
		() =>
			resolveIdentity(
				"custom",
				"https://issuer.example",
				"subject",
				"identity@example.com",
				true,
			),
		/existing method/,
	);
	assert.throws(
		() =>
			resolveIdentity(
				"custom",
				"https://issuer.example",
				"subject",
				"new@example.com",
				false,
			),
		/verify/,
	);
});
test("broker refresh rotation can recover a lost response and revocation prevents replay", async () => {
	const user = createUser("rotation@example.com", null),
		grant = beginBroker("google", user);
	authorizeBroker(grant.code, user);
	deliverBroker(grant.id, user, {
		access_token: "old-access",
		refresh_token: "old-refresh",
		label: "Google",
	});
	acknowledgeBroker(grant.id, grant.key);
	const fetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return Response.json({
			access_token: "new-access",
			refresh_token: "new-refresh",
		});
	};
	try {
		assert.equal(
			(await refreshBroker(grant.id, grant.key, "old-refresh")).refresh_token,
			"new-refresh",
		);
		assert.equal(
			(await refreshBroker(grant.id, grant.key, "old-refresh")).refresh_token,
			"new-refresh",
		);
		assert.equal(calls, 1);
		cancelBroker(grant.id, grant.key);
		assert.throws(() => refreshBroker(grant.id, grant.key, "old-refresh"));
	} finally {
		globalThis.fetch = fetch;
	}
});
test("a later completed attempt wins even when created in the same millisecond", () => {
	const user = createUser("race@example.com", null);
	const first = startAttempt(user, "google", "server", "session", {}),
		second = startAttempt(user, "google", "server", "session", {});
	getDb()
		.prepare("UPDATE oauth_attempts SET created_at=1 WHERE user_id=?")
		.run(user);
	claimAttempt(user, second.id);
	completeAttempt(user, second.id, () => {});
	claimAttempt(user, first.id);
	assert.throws(() =>
		completeAttempt(user, first.id, () => assert.fail("older write")),
	);
});
test('Microsoft broker consent preserves explicit limited and Teams access',()=>{
  saveConfig('MS_CLIENT_ID','client',null);saveConfig('MS_CLIENT_SECRET','secret',null);
  const user=createUser('scopes@example.com',null);
  const limited=beginBroker('microsoft',user,{readonly:true});
  const limitedScopes=new URL(authorizeBroker(limited.code,user)).searchParams.get('scope')!;
  assert.ok(limitedScopes.includes('Mail.Read'));assert.ok(!limitedScopes.includes('Mail.Send'));
  const teams=beginBroker('microsoft',user,{teams:true});
  assert.ok(new URL(authorizeBroker(teams.code,user)).searchParams.get('scope')!.includes('Chat.ReadWrite'));
});
