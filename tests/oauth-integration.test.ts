import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { saveConfig } from "../src/lib/app-config.ts";
import { createUser, getUserByEmail } from "../src/lib/users.ts";
import { inviteAccount } from "../src/lib/account-access.ts";
import {
	attemptOf,
	claimAttempt,
	completeAttempt,
	startAttempt,
} from "../src/lib/oauth-attempts.ts";
import {
	beginBroker,
	brokerByCode,
	brokerDone,
	deliverBroker,
} from "../src/lib/oauth-broker.ts";
import {
	integrationURL,
	pollIntegration,
	startIntegration,
} from "../src/lib/broker-client.ts";
import { decodeIdToken } from "../src/lib/google-sso.ts";

// saveConfig refuses a sign-in change that would leave no reachable administrator.
createUser("admin@example.com", "long-password-123", "admin");
const google = () => {
	saveConfig("GOOGLE_CLIENT_ID", "client", null);
	saveConfig("GOOGLE_CLIENT_SECRET", "secret", null);
};

test("a refused completion fails the attempt instead of stranding it", async () => {
	google();
	const user = createUser("stranded@example.com", null);
	const started = await startIntegration(user, "google", "session", {}, true);
	deliverBroker(brokerByCode(started.code).id, user, {
		access_token: "access",
		refresh_token: "refresh",
		label: "Google",
	});
	// A newer connection for the same provider is what completeAttempt refuses.
	const newer = startAttempt(user, "google", "server", "session", {});
	claimAttempt(user, newer.id);
	completeAttempt(user, newer.id, () => {});
	await assert.rejects(pollIntegration(user, started.id, "session"));
	assert.equal(attemptOf(user, started.id).status, "failed");
});
test("a local connection started by this browser skips the confirmation hop", async () => {
	const user = createUser("local@example.com", null);
	const started = await startIntegration(user, "google", "session", {}, true);
	assert.equal(started.local, true);
	assert.ok(
		started.verificationUrl.startsWith("https://accounts.google.com"),
		started.verificationUrl,
	);
	const grant = brokerByCode(started.code);
	assert.equal(grant.status, "authorizing");
	assert.equal(brokerDone(grant.id, "google"), "/account#accounts");
	assert.equal(
		brokerDone(grant.id, "google", "denied"),
		"/account?err=google-denied",
	);
});
// A desktop relays its start through the server, so the browser that finishes it
// holds no session here: without the hop the callback has nothing to bind to.
test("a relayed start keeps the confirmation hop", async () => {
	const user = createUser("relayed@example.com", null);
	const started = await startIntegration(user, "google", "device-binding", {});
	// The account page reads this to say whether there is a code to confirm, and
	// this flow has one — the in-process broker flag the poll/ack/cancel path
	// reads is a different thing and stays true.
	assert.equal(started.local, false);
	assert.ok(
		started.verificationUrl.endsWith(`/oauth/broker?code=${started.code}`),
		started.verificationUrl,
	);
	const grant = brokerByCode(started.code);
	assert.equal(grant.status, "pending");
	// The finishing browser holds no session here, so the callback must send it
	// back to the broker page, never to this server's /account.
	assert.equal(brokerDone(grant.id, "google"), "/oauth/broker?done=1");
	assert.equal(
		brokerDone(grant.id, "google", "denied"),
		"/oauth/broker?done=1&error=denied",
	);
	// The grant is still brokered in-process: an HTTP broker request would refuse
	// this install's plain-http origin outright.
	const polled = await pollIntegration(user, started.id, "device-binding");
	assert.equal(polled.status, "pending");
	assert.equal(integrationURL(user, started.id, "device-binding").local, false);
});
test("a brokered connection still confirms its code first", () => {
	const user = createUser("brokered@example.com", null);
	const grant = beginBroker("google", user);
	assert.equal(grant.verificationPath, `/oauth/broker?code=${grant.code}`);
	assert.equal(brokerByCode(grant.code).status, "pending");
	assert.equal(brokerDone(grant.id, "google"), "/oauth/broker?done=1");
	assert.equal(
		brokerDone(grant.id, "google", "failed"),
		"/oauth/broker?done=1&error=failed",
	);
	// A grant swept mid-consent: the provider is all the callback still knows.
	assert.equal(brokerDone("gone", "google"), "/account?err=google-failed");
});
// The public broker endpoint hands an unauthenticated caller's JSON straight to
// beginBroker, and `local` decides where a callback sends the browser.
test("a caller cannot declare its own grant local", () => {
	const grant = beginBroker("google", undefined, { local: true });
	assert.equal(brokerDone(grant.id, "google"), "/oauth/broker?done=1");
});
test("an invitation that cannot be delivered leaves no account behind", async () => {
	await assert.rejects(inviteAccount("invited@example.com", 1));
	assert.equal(getUserByEmail("invited@example.com"), null);
});
test("decodeIdToken reads a base64url JWT payload", () => {
	const claims = { email: "a@example.com", email_verified: true, hd: "example.com", name: "Ada" };
	const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
	assert.deepEqual(decodeIdToken(`eyJhbGciOiJSUzI1NiJ9.${payload}.fakesig`), claims);
	assert.throws(() => decodeIdToken("nodots"), /malformed/);
});
