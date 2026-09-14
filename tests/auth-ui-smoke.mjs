import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "rimeward-auth-ui-"));
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["dist/server/entry.mjs"], {
	env: {
		...process.env,
		HOST: "127.0.0.1",
		PORT: String(port),
		PUBLIC_BASE_URL: "",
		HOMEPAGE_DATA_DIR: data,
		TOKEN_ENC_KEY: Buffer.alloc(32, 9).toString("base64"),
		RIMEWARD_DESKTOP: "0",
		RIMEWARD_UPDATE_CHECKS: "0",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let logs = "",
	browser;
child.stderr.on("data", (d) => (logs += d));
child.stdout.on("data", (d) => (logs += d));
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(origin + "/setup")).ok) {
				ready = true;
				break;
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.ok(ready, logs);
	const foreign=await fetch(origin+'/setup',{method:'POST',headers:{origin:'https://foreign.invalid','content-type':'application/x-www-form-urlencoded'},body:'token=wrong'});
	assert.equal(foreign.status,403);

	process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(
		"desktop/runtime/browsers",
	);
	// swiftshader: the valley terrain needs a GL context headless, and reduced
	// motion leaves the CSS entrances at rest — so each shot is one stable frame.
	browser = await chromium.launch({
		headless: true,
		args: [
			"--use-gl=angle",
			"--use-angle=swiftshader",
			"--enable-unsafe-swiftshader",
		],
	});
	const page = await browser.newPage({ reducedMotion: "reduce" });
	const shot = async (n) => {
		await page.waitForTimeout(500); // the scene boots on an idle callback
		await page.screenshot({
			path: path.join(data, `setup-${n}.png`),
			fullPage: true,
		});
	};
	await page.goto(origin + "/setup");
	await shot(0);
	await page
		.locator("[name=token]")
		.fill(fs.readFileSync(path.join(data, "setup-token"), "utf8"));
	await page.locator("[name=email]").fill("owner@example.com");
	await page.locator("[name=password]").fill("test-password-long");
	await Promise.all([
		page.waitForURL("**/setup?step=url"),
		page.getByRole("button", { name: "Continue" }).click(),
	]);
	assert.equal(fs.existsSync(path.join(data, "setup-token")), false);
	// Claimed but unfinished: an explicit step is the admin's to pick.
	assert.equal(
		(await page.request.get(origin + "/setup?step=policy", { maxRedirects: 0 }))
			.status(),
		200,
	);
	for (let i = 1; i <= 8 && !page.url().endsWith("/dash"); i++) {
		await shot(i);
		// The walk otherwise prefers Skip and never proves a step SAVES anything.
		// The email step is where it stops skipping — Continue, never "Save and
		// send a test email": there is no mail server to accept one.
		const mailStep = (await page.content()).includes("Email delivery");
		if (mailStep) {
			await page.locator("[name=SMTP_HOST]").fill("mail.example.invalid");
			await page.locator("[name=SMTP_FROM]").fill("rimeward@example.invalid");
		}
		const skip = page.getByRole("button", { name: "Skip for now" });
		const next =
			!mailStep && (await skip.isVisible())
				? skip
				: page.getByRole("button", { name: /^(Continue|Enter Rimeward)$/ });
		const before = page.url();
		await next.click();
		await page.waitForURL((u) => String(u) !== before);
		await page.waitForLoadState("load");
	}
	assert.ok(page.url().endsWith("/dash"), page.url());
	// Finished: bare /setup hands over to the admin console, an explicit step
	// still re-enters the wizard, and none of it is reachable signed out.
	const bare = await page.request.get(origin + "/setup", { maxRedirects: 0 });
	assert.equal(bare.status(), 303);
	assert.equal(bare.headers().location, "/admin/settings");
	assert.equal(
		(await page.request.get(origin + "/setup?step=sso", { maxRedirects: 0 }))
			.status(),
		200,
	);
	const anon = await fetch(origin + "/setup?step=url", { redirect: "manual" });
	assert.equal(anon.status, 303);
	assert.equal(anon.headers.get("location"), "/login");
	// Review reports the origin the claim stored, not the default.
	const review = await page.request.get(origin + "/setup?step=review");
	assert.equal(review.status(), 200);
	assert.ok((await review.text()).includes(origin), origin);
	// The /setup CSRF exemption closed with setup_done.
	const evil = await fetch(origin + "/setup?step=url", {
		method: "POST",
		headers: {
			origin: "https://evil.invalid",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: `PUBLIC_BASE_URL=${encodeURIComponent(origin)}`,
	});
	assert.equal(evil.status, 403);

	// Re-entering a step and pressing Continue over an unchanged form is not a
	// write: it must not throw, and what the wizard saved must survive it.
	await page.goto(origin + "/setup?step=email");
	assert.equal(
		await page.locator("[name=SMTP_HOST]").inputValue(),
		"mail.example.invalid",
	);
	await Promise.all([
		page.waitForURL("**/setup?step=policy"),
		page.getByRole("button", { name: "Continue" }).click(),
	]);

	// A step that throws halfway writes nothing and re-renders what was POSTED,
	// without the posted secret reaching the page.
	await page.goto(origin + "/setup?step=email");
	await page.locator("[name=SMTP_HOST]").fill("rolled-back.example.invalid");
	await page.locator("[name=SMTP_PORT]").fill("abc");
	await page.locator("[name=SMTP_PASSWORD]").fill("fixture-smtp-secret");
	await Promise.all([
		page.waitForLoadState("load"),
		page.getByRole("button", { name: "Continue" }).click(),
	]);
	assert.match(await page.locator("#form-error").innerText(), /Invalid limit/);
	assert.equal(
		await page.locator("[name=SMTP_HOST]").inputValue(),
		"rolled-back.example.invalid",
	);
	assert.ok(!(await page.content()).includes("fixture-smtp-secret"));
	await page.goto(origin + "/admin/settings");
	assert.equal(
		await page.locator("#SMTP_HOST").inputValue(),
		"mail.example.invalid",
	);
	// The email test is consume-once: a reload that replays the POST is refused.
	const nonce = await page.locator("[name=nonce]").inputValue();
	await Promise.all([
		page.waitForLoadState("load"),
		page.getByRole("button", { name: "Send test email" }).click(),
	]);
	const replay = await page.request.post(origin + "/admin/settings", {
		form: { action: "email-test", nonce },
	});
	assert.match(await replay.text(), /Refresh the page and try again/);
	const secretForm = page
		.locator("form")
		.filter({ has: page.locator("[name=key][value=GOOGLE_CLIENT_SECRET]") });
	await secretForm.locator("[name=value]").fill("fixture-secret-do-not-render");
	await Promise.all([
		page.waitForLoadState("load"),
		secretForm.getByRole("button", { name: "Save", exact: true }).click(),
	]);
	await page.waitForTimeout(250);
	assert.ok(!(await page.content()).includes("fixture-secret-do-not-render"));
	await page.screenshot({
		path: path.join(data, "settings.png"),
		fullPage: true,
	});
	await page.goto(origin + "/admin/users");
	await page.locator("[name=email]").fill("member@example.com");
	await page.locator("[name=mode]").selectOption("password");
	await Promise.all([
		page.waitForURL("**/admin/users?ok=created"),
		page.getByRole("button", { name: "Add", exact: true }).click(),
	]);
	assert.ok(
		await page.getByText("member@example.com", { exact: false }).count(),
	);
	await page.goto(origin + "/account");
	assert.ok(await page.locator("[data-codex-connect]").count());
	await page.goto(origin + "/admin/settings");
	const clientForm = page
		.locator("form")
		.filter({ has: page.locator("[name=key][value=GOOGLE_CLIENT_ID]") });
	await clientForm.locator("[name=value]").fill("fixture-client");
	await clientForm.getByRole("button", { name: "Save", exact: true }).click();
	await page.goto(origin + "/account#accounts");
	const integration = page.locator("[data-integration=google]");
	await integration
		.getByRole("button", { name: "Connect", exact: true })
		.click();
	await integration.locator("a").waitFor({ state: "visible" });
	const verification = await integration.locator("a").getAttribute("href");
	// A local grant is bound to this browser's session already, so startIntegration
	// may skip the broker confirmation hop and link straight at the provider
	// (lib/broker-client.ts). Both shapes pass; only the hop has a page to open.
	if (verification.startsWith(origin + "/oauth/broker?code=")) {
		await page.goto(verification);
		assert.ok(
			(await page.locator("main").innerText()).includes("owner@example.com"),
		);
	} else {
		assert.ok(
			verification.startsWith("https://accounts.google.com/") &&
				verification.includes(
					encodeURIComponent(origin + "/api/connect/google/callback"),
				),
			verification,
		);
	}
	assert.ok(!(await page.content()).includes("fixture-secret-do-not-render"));
	console.log(`Auth UI smoke passed. Screenshots: ${data}`);
} finally {
	await browser?.close();
	child.kill("SIGTERM");
	await once(child, "exit");
}
