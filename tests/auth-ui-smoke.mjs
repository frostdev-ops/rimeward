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
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	await page.goto(origin + "/setup");
	await page.screenshot({ path: path.join(data, "setup.png"), fullPage: true });
	await page
		.locator("[name=token]")
		.fill(fs.readFileSync(path.join(data, "setup-token"), "utf8"));
	await page.locator("[name=email]").fill("owner@example.com");
	await page.locator("[name=password]").fill("test-password-long");
	await Promise.all([
		page.waitForURL("**/admin/settings?setup=1"),
		page
			.getByRole("button", { name: "Create administrator and continue" })
			.click(),
	]);
	assert.equal(fs.existsSync(path.join(data, "setup-token")), false);
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
	assert.ok(verification.startsWith(origin + "/oauth/broker?code="));
	await page.goto(verification);
	assert.ok(
		(await page.locator("main").innerText()).includes("owner@example.com"),
	);
	assert.ok(!(await page.content()).includes("fixture-secret-do-not-render"));
	console.log(`Auth UI smoke passed. Screenshots: ${data}`);
} finally {
	await browser?.close();
	child.kill("SIGTERM");
	await once(child, "exit");
}
