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
import { adminCount, createUser, getUser, setUserStatus } from "../src/lib/users.ts";
import { createSession, getSession } from "../src/lib/auth.ts";
import { csrfBlocked } from "../src/lib/csrf.ts";
import {
	attemptSession,
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
import { acceptInvite,beginIdentity,discoveryTransport,resolveIdentity,saveIdentityConnector,deleteIdentityConnector,identityConnectors,identityEmailVerified } from "../src/lib/identity.ts";
import { POST as identityPost } from "../src/pages/api/auth/identity/[...action].ts";

test("installer must prove ownership and cannot replay setup", () => {
	// The token is printed at boot too: under Docker/pm2 the file is out of reach.
	const logged: string[] = [];
	const log = console.log;
	console.log = (...a: unknown[]) => void logged.push(a.join(" "));
	try {
		ensureSetupToken();
	} finally {
		console.log = log;
	}
	assert.equal(needsSetup(), true);
	const token = fs.readFileSync(`${DATA_DIR}/setup-token`, "utf8");
	assert.ok(
		logged.some((l) => l.includes("/setup") && l.includes(token)),
		logged.join("|"),
	);
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

const formPost=(url:string,origin:string,host?:string)=>new Request(url,{method:"POST",headers:{origin,"content-type":"application/x-www-form-urlencoded",...(host?{host}:{})}});
const identityCtx=(action:string,fields?:Record<string,string>)=>{
	const url=`https://own.example/api/auth/identity/${action}`;
	return {
		url:new URL(url),
		params:{action},
		cookies:{get:()=>undefined,set(){},delete(){}},
		redirect:(location:string,status=302)=>new Response(null,{status,headers:{location}}),
		request:new Request(url,{method:"POST",body:new URLSearchParams(fields??{})}),
		clientAddress:"203.0.113.9",
	} as unknown as Parameters<typeof identityPost>[0];
};
test("link and invite starts are form posts a foreign origin cannot make",async()=>{
	saveConfig("PUBLIC_BASE_URL","https://own.example",null);
	assert.equal(typeof identityPost,"function");
	for(const path of ["link","invite"]){
		const url=`https://own.example/api/auth/identity/google/${path}`;
		assert.equal(csrfBlocked(formPost(url,"https://evil.invalid")),true);
		assert.equal(csrfBlocked(formPost(url,"https://own.example")),false);
		// A bodyless cross-site fetch() declares no content type and is still a simple request.
		assert.equal(csrfBlocked(new Request(url,{method:"POST",headers:{origin:"https://evil.invalid"}})),true);
		assert.equal(csrfBlocked(new Request(url,{method:"POST"})),false);
	}
	assert.equal((await identityPost(identityCtx("google/link"))).status,401);
	// A tokenless invite is refused before any identity provider is contacted. The 400 is
	// the proof: the connector's own discovery does not go through globalThis.fetch, so a
	// counter on it would see nothing, and the catch-all 303 would hide a live round trip.
	assert.equal((await identityPost(identityCtx("google/invite"))).status,400);
	// Six of them: a stranger must not be able to spend a rate window that a real
	// invitee needs — the window is keyed on the invitation, not on the caller.
	for(let i=0;i<6;i++)
		assert.equal((await identityPost(identityCtx("google/invite",{token:`not-an-invitation-${i}`}))).status,400);
});
test("a browser session cannot supply its own attempt binding",()=>{
	const user=createUser("binding@example.com",null);
	const browser=createSession(user),relay=createSession(user);
	getDb().prepare("INSERT INTO devices(id,user_id,name,platform,protocol,token_hash) VALUES('dev-1',?,'Mac','darwin',1,'hash')").run(user);
	getDb().prepare("INSERT INTO device_sessions(device_id,session_id) VALUES('dev-1',?)").run(relay.id);
	const cookies=(id:string)=>({get:(name:string)=>name==="rimeward_session"?{value:id}:undefined});
	const named=new Request("https://own.example/api/account/oauth",{headers:{"x-rimeward-oauth-binding":"relay-binding"}});
	assert.equal(attemptSession(named,cookies(browser.id)),browser.id);
	assert.equal(attemptSession(named,cookies(relay.id)),"relay-binding");
	assert.equal(attemptSession(new Request("https://own.example/api/account/oauth"),cookies(relay.id)),relay.id);
});
test("single-tenant Microsoft trusts the tenant's email; common does not",()=>{
	const microsoft=()=>identityConnectors().find(c=>c.id==="microsoft")!;
	for(const tenant of ["common","organizations","consumers"]){
		saveConfig("MS_TENANT_ID",tenant,null);
		assert.equal(microsoft().trustEmail,false,tenant);
	}
	saveConfig("MS_TENANT_ID","6babcaad-604b-40ac-a9d7-9fd97c0b779f",null);
	assert.equal(microsoft().trustEmail,true);
});
test("an invitation can be accepted by a new SSO identity without a password",()=>{
	const user=createUser("invited@example.com",null);
	getDb().prepare("UPDATE users SET status='pending' WHERE id=?").run(user);
	const token=actionToken(user,"invite");
	// No email in the identity: the token activates the account, nothing verifies the address.
	assert.equal(acceptInvite(token,"google","https://accounts.google.com","invited-subject",undefined,true),user);
	assert.equal(getUser(user)!.status,"active");
	assert.equal(getUser(user)!.email_verified,0);
	assert.ok(getDb().prepare("SELECT 1 FROM login_identities WHERE user_id=?").get(user));
	assert.throws(()=>acceptInvite(token,"google","https://accounts.google.com","invited-subject",undefined,true),/invalid or expired/);
});
test("disabling the only administrator's sign-in method is refused",()=>{
	const admin=(getDb().prepare("SELECT id FROM users WHERE role='admin' AND status='active'").get() as {id:number}).id;
	setSetting("identity_admin_verified",`${admin}:google`);
	assert.throws(()=>saveConfig("PASSWORD_LOGIN","false",admin),/lock out/);
	assert.equal(config("PASSWORD_LOGIN"),"true");
});
test("setup posts from the request's own host pass until finished; foreign origins never",()=>{
	const own=()=>formPost("http://10.0.0.5:4321/setup","http://10.0.0.5:4321","10.0.0.5:4321");
	const foreign=()=>formPost("http://10.0.0.5:4321/setup","https://evil.invalid","10.0.0.5:4321");
	assert.equal(csrfBlocked(own()),false);
	assert.equal(csrfBlocked(foreign()),true);
	setSetting("setup_done","true");
	assert.equal(csrfBlocked(own()),true);
	assert.equal(csrfBlocked(foreign()),true);
});

test("an invitation is bound to the address it was sent to",()=>{
	const user=createUser("bound@example.com",null);
	getDb().prepare("UPDATE users SET status='pending' WHERE id=?").run(user);
	const token=actionToken(user,"invite");
	assert.throws(()=>acceptInvite(token,"google","https://accounts.google.com","other-subject","someone@else.example",true),/address this invitation was sent to/);
	// The refusal rolled the whole transaction back, so the invitation is still spendable.
	assert.equal(getUser(user)!.status,"pending");
	assert.equal(acceptInvite(token,"google","https://accounts.google.com"," bound-subject","  Bound@Example.com ",true),user);
	assert.equal(getUser(user)!.status,"active");
	assert.equal(getUser(user)!.email_verified,1);
});
test("an invitation redeemed by an unverified address activates without verifying it",()=>{
	const user=createUser("unverified@example.com",null);
	getDb().prepare("UPDATE users SET status='pending' WHERE id=?").run(user);
	const token=actionToken(user,"invite");
	assert.equal(acceptInvite(token,"custom","https://issuer.example","unverified-subject","unverified@example.com",false),user);
	assert.equal(getUser(user)!.status,"active");
	assert.equal(getUser(user)!.email_verified,0);
});
test("only Microsoft's own xms_edov stands in for email_verified",()=>{
	const google=identityConnectors().find(c=>c.id==="google")!;
	const microsoft=()=>identityConnectors().find(c=>c.id==="microsoft")!;
	saveConfig("MS_TENANT_ID","common",null);
	assert.equal(identityEmailVerified(google,{email_verified:true}),true);
	assert.equal(identityEmailVerified(google,{email_verified:false}),false);
	assert.equal(identityEmailVerified(google,{xms_edov:true}),false);
	assert.equal(identityEmailVerified(microsoft(),{xms_edov:true}),true);
	assert.equal(identityEmailVerified(microsoft(),{}),false);
	saveConfig("MS_TENANT_ID","6babcaad-604b-40ac-a9d7-9fd97c0b779f",null);
	assert.equal(identityEmailVerified(microsoft(),{}),true);
	assert.equal(identityEmailVerified({...google,trustEmail:true},{}),true);
	assert.equal(identityEmailVerified({...google,id:"custom"},{xms_edov:true}),false);
});
test("only real connector IDs can be deleted",()=>{
	for(const id of ["google","microsoft","Bad","../evil",""])
		assert.throws(()=>deleteIdentityConnector(id,1),/Unknown connector/);
	// A well-formed id that was never configured is a no-op: reporting success while
	// clearing identity_admin_verified silently re-locks PASSWORD_LOGIN=false.
	const rows=()=>(getDb().prepare("SELECT count(*) AS n FROM auth_audit").get() as {n:number}).n;
	setSetting("identity_admin_verified","1:google");
	const before=rows();
	deleteIdentityConnector("ghost-oidc",1);
	assert.equal(getSetting("identity_admin_verified"),"1:google");
	assert.equal(rows(),before);
	getDb().prepare("DELETE FROM settings WHERE key='identity_admin_verified'").run();
});
test("an installation with no administrator left can still configure its way back in",()=>{
	const admin=(getDb().prepare("SELECT id FROM users WHERE role='admin'").get() as {id:number}).id;
	getDb().prepare("UPDATE users SET password_hash=NULL WHERE id=?").run(admin);
	assert.equal(adminCount(),0);
	// The shape that loses every administrator is the SSO-only one, where passwords are
	// off: the refusal guarding SSO changes must stand aside there too.
	setSetting("config:PASSWORD_LOGIN","false");
	saveConfig("GOOGLE_CLIENT_ID","repair-client",null);
	assert.equal(config("GOOGLE_CLIENT_ID"),"repair-client");
	saveIdentityConnector({id:"repair-oidc",name:"Repair",issuer:"https://repair.example",clientId:"client",clientSecret:"secret",enabled:true},admin);
	assert.ok(identityConnectors().some(c=>c.id==="repair-oidc"));
	saveConfig("PASSWORD_LOGIN","true",admin);
	deleteIdentityConnector("repair-oidc",admin);
	getDb().prepare("UPDATE users SET password_hash='restored' WHERE id=?").run(admin);
	assert.equal(adminCount(),1);
});
test("with passwords off a connector may be rotated but never added or repointed",()=>{
	// Somebody must still be able to sign in, or the refusal has no administrator to protect.
	const admin=(getDb().prepare("SELECT id FROM users WHERE role='admin'").get() as {id:number}).id;
	getDb().prepare("INSERT INTO login_identities(connector,issuer,subject,user_id) VALUES('google','https://accounts.google.com','rotate-subject',?)").run(admin);
	const connector={id:"rotate-oidc",name:"Rotate",issuer:"https://rotate.example",clientId:"client",clientSecret:"secret",enabled:true};
	saveIdentityConnector(connector,1);
	setSetting("config:PASSWORD_LOGIN","false");
	try{
		saveIdentityConnector({...connector,name:"Rotated",clientSecret:"new-secret",enabled:false},1);
		assert.equal(identityConnectors().find(c=>c.id==="rotate-oidc")?.clientSecret,"new-secret");
		assert.throws(()=>saveIdentityConnector({...connector,clientId:"other-client"},1),/Re-enable password login/);
		assert.throws(()=>saveIdentityConnector({...connector,issuer:"https://elsewhere.example"},1),/Re-enable password login/);
		assert.throws(()=>saveIdentityConnector({...connector,id:"fresh-oidc"},1),/Re-enable password login/);
	}finally{setSetting("config:PASSWORD_LOGIN","true");}
	deleteIdentityConnector("rotate-oidc",1);
});
test("repointing the connector the only administrator signs in through is refused",()=>{
	const admin=createUser("repoint@example.com",null,"admin");
	getDb().prepare("UPDATE users SET status='active' WHERE id=?").run(admin);
	// Sealed while the installation's own administrator still has a password: a builtin
	// without its client secret is no longer a way in, and saveConfig refuses a write that
	// leaves nobody able to sign in.
	saveConfig("MS_CLIENT_SECRET","ms-secret",null);
	// This administrator's SSO row must be the only way into the installation, or the
	// differential guard has another administrator to fall back on.
	getDb().prepare("DELETE FROM login_identities");
	getDb().prepare("DELETE FROM legacy_google_users");
	getDb().prepare("UPDATE users SET password_hash=NULL WHERE role='admin' AND id<>?").run(admin);
	// Passwords stay ON: this administrator simply has none, so the SSO row is the way in
	// and the earlier "re-enable password login" refusal is not what is being tested.
	setSetting("config:GOOGLE_SSO_ENABLED","false");
	setSetting("config:MS_SSO_ENABLED","true");setSetting("config:MS_CLIENT_ID","app-a");setSetting("config:MS_TENANT_ID","tenant-a");
	getDb().prepare("INSERT INTO login_identities(connector,issuer,subject,user_id) VALUES('microsoft','https://login.microsoftonline.com/tenant-a/v2.0','sub-a',?)").run(admin);
	setSetting("config:PASSWORD_LOGIN","true");
	try{
		// A tenant is part of the issuer, and a sign-in row is looked up by connector AND
		// issuer: repointing it strands every row without ever touching "enabled".
		assert.equal(adminCount(),1);
		assert.throws(()=>saveConfig("MS_TENANT_ID","tenant-b",null),/lock out/);
		assert.equal(config("MS_TENANT_ID"),"tenant-a");
		// Entra mints `sub` per application, so pointing the connector at another client
		// strands every stored row while the issuer stays character for character the same.
		assert.throws(()=>saveConfig("MS_CLIENT_ID","app-b",null),/lock out/);
		assert.equal(config("MS_CLIENT_ID"),"app-a");
		// "Use environment value" posts a reset, and the environment here carries the SAME
		// client id: nothing is repointed and the write must go through.
		process.env.MS_CLIENT_ID="app-a";
		saveConfig("MS_CLIENT_ID",null,null);
		assert.equal(config("MS_CLIENT_ID"),"app-a");
		setSetting("config:MS_CLIENT_ID","app-a");
		delete process.env.MS_CLIENT_ID;
		// A multi-tenant registration (common/organizations/consumers) mints id_tokens whose
		// `iss` carries the SIGNING-IN user's own tenant GUID: compared against .../common/v2.0
		// every stored row is unequal, adminCount() reports 0 and the guard stops firing.
		setSetting("config:MS_TENANT_ID","common");
		getDb().prepare("UPDATE login_identities SET issuer='https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0' WHERE user_id=?").run(admin);
		assert.equal(adminCount(),1);
		assert.throws(()=>saveConfig("MS_CLIENT_ID","app-b",null),/lock out/);
		assert.equal(config("MS_CLIENT_ID"),"app-a");
		assert.throws(()=>saveConfig("MS_SSO_ENABLED","false",null),/lock out/);
		assert.equal(config("MS_SSO_ENABLED"),"true");
		// The family is that one host, not any issuer at all.
		getDb().prepare("UPDATE login_identities SET issuer='https://evil.example/v2.0' WHERE user_id=?").run(admin);
		assert.equal(adminCount(),0);
		setSetting("config:MS_TENANT_ID","tenant-a");
		getDb().prepare("UPDATE login_identities SET issuer='https://login.microsoftonline.com/tenant-a/v2.0' WHERE user_id=?").run(admin);
		// The same blindness through a custom connector.
		setSetting("config:MS_SSO_ENABLED","false");
		getDb().prepare("DELETE FROM login_identities WHERE user_id=?").run(admin);
		const connector={id:"repoint-oidc",name:"Repoint",issuer:"https://repoint.example",clientId:"c1",clientSecret:"secret",enabled:true};
		saveIdentityConnector(connector,admin);
		getDb().prepare("INSERT INTO login_identities(connector,issuer,subject,user_id) VALUES('repoint-oidc','https://repoint.example','sub-b',?)").run(admin);
		assert.equal(adminCount(),1);
		assert.throws(()=>saveIdentityConnector({...connector,issuer:"https://elsewhere.example"},admin),/lock out/);
		assert.equal(identityConnectors().find(c=>c.id==="repoint-oidc")?.issuer,"https://repoint.example");
		assert.throws(()=>saveIdentityConnector({...connector,clientId:"c2"},admin),/lock out/);
		assert.equal(identityConnectors().find(c=>c.id==="repoint-oidc")?.clientId,"c1");
		// A stray space in the client ID field is the same client, not a repoint.
		saveIdentityConnector({...connector,clientId:" c1 "},admin);
		assert.equal(identityConnectors().find(c=>c.id==="repoint-oidc")?.clientId,"c1");
		// Both rotations are ordinary maintenance the moment somebody else can get in.
		getDb().prepare("UPDATE users SET password_hash='restored' WHERE role='admin' AND id<>?").run(admin);
		saveIdentityConnector({...connector,clientId:"c2"},admin);
		assert.equal(identityConnectors().find(c=>c.id==="repoint-oidc")?.clientId,"c2");
		setSetting("config:MS_SSO_ENABLED","true");
		saveConfig("MS_CLIENT_ID","app-b",null);
		assert.equal(config("MS_CLIENT_ID"),"app-b");
	}finally{
		delete process.env.MS_CLIENT_ID;
		setSetting("config:PASSWORD_LOGIN","true");
		setSetting("config:MS_SSO_ENABLED","false");
		getDb().prepare("DELETE FROM login_identities");
		getDb().prepare("DELETE FROM users WHERE id=?").run(admin);
		if(identityConnectors().some(c=>c.id==="repoint-oidc"))deleteIdentityConnector("repoint-oidc",1);
	}
});
test("clearing a builtin's client secret cannot take the last administrator's sign-in away",()=>{
	const admin=createUser("secret@example.com",null,"admin");
	getDb().prepare("UPDATE users SET status='active' WHERE id=?").run(admin);
	saveConfig("MS_CLIENT_SECRET","ms-secret",null);
	getDb().prepare("DELETE FROM login_identities");
	getDb().prepare("DELETE FROM legacy_google_users");
	getDb().prepare("UPDATE users SET password_hash=NULL WHERE role='admin' AND id<>?").run(admin);
	setSetting("config:GOOGLE_SSO_ENABLED","false");
	setSetting("config:MS_SSO_ENABLED","true");setSetting("config:MS_CLIENT_ID","app-a");setSetting("config:MS_TENANT_ID","tenant-a");
	getDb().prepare("INSERT INTO login_identities(connector,issuer,subject,user_id) VALUES('microsoft','https://login.microsoftonline.com/tenant-a/v2.0','sub-a',?)").run(admin);
	setSetting("config:PASSWORD_LOGIN","true");
	try{
		assert.equal(adminCount(),1);
		// A blank secret makes the app a public client, which neither Google's web client nor
		// Entra accepts: the code exchange fails and nobody signs in again. The settings page
		// clears with "" and resets with null, and both must be refused here.
		assert.throws(()=>saveConfig("MS_CLIENT_SECRET","",null),/lock out/);
		assert.throws(()=>saveConfig("MS_CLIENT_SECRET",null,null),/lock out/);
		assert.equal(config("MS_CLIENT_SECRET"),"ms-secret");
		assert.equal(adminCount(),1);
		getDb().prepare("UPDATE users SET password_hash='restored' WHERE role='admin' AND id<>?").run(admin);
		saveConfig("MS_CLIENT_SECRET","",null);
		assert.equal(config("MS_CLIENT_SECRET"),"");
		saveConfig("MS_CLIENT_SECRET","ms-secret",null);
		saveConfig("MS_CLIENT_SECRET",null,null);
		assert.equal(config("MS_CLIENT_SECRET"),"");
	}finally{
		setSetting("config:MS_SSO_ENABLED","false");
		getDb().prepare("DELETE FROM login_identities");
		getDb().prepare("DELETE FROM users WHERE id=?").run(admin);
	}
});
test("concurrent sign-in starts share one discovery round trip",async()=>{
	saveConfig("PUBLIC_BASE_URL","https://own.example",null);
	const connector={id:"cached-oidc",name:"Cached",issuer:"https://cached.example",clientId:"client",clientSecret:"secret",enabled:true};
	saveIdentityConnector(connector,1);
	const real=discoveryTransport.request;
	let calls=0;
	discoveryTransport.request=async()=>{
		calls++;
		return {status:200,headers:{"content-type":"application/json"},text:JSON.stringify({
			issuer:connector.issuer,
			authorization_endpoint:`${connector.issuer}/authorize`,
			token_endpoint:`${connector.issuer}/token`,
			jwks_uri:`${connector.issuer}/jwks`,
			response_types_supported:["code"],
			subject_types_supported:["public"],
			id_token_signing_alg_values_supported:["RS256"],
		})};
	};
	try{
		// Starting a sign-in is public and unauthenticated, so ten callers at once on a cold
		// cache must not become ten requests aimed at the issuer.
		const starts=await Promise.all(Array.from({length:10},()=>beginIdentity("cached-oidc")));
		assert.equal(calls,1);
		for(const start of starts)assert.ok(start.url.startsWith("https://cached.example/authorize?"),start.url);
		for(let i=0;i<10;i++)await beginIdentity("cached-oidc");
		assert.equal(calls,1);
	}finally{
		discoveryTransport.request=real;
		deleteIdentityConnector("cached-oidc",1);
	}
});
