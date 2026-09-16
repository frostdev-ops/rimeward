import test from "node:test";
import assert from "node:assert/strict";
import {
	listenForCodex,
	closeCodexListener,
} from "../src/lib/codex-loopback.ts";
test("loopback validates state, preserves the listener on mismatch, and closes after completion", async (t) => {
	let completed = "";
	try {
		await listenForCodex("test", "expected", async (url) => {
			completed = url;
		});
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
			t.skip("Registered callback port is already in use");
			return;
		}
		throw e;
	}
	try {
		await assert.rejects(
			listenForCodex("other", "other", async () => {}),
			/Another/,
		);
		const headers = { Host: "localhost:1455" };
		const wrong = await fetch(
			"http://localhost:1455/auth/callback?state=wrong&code=x",
			{ headers },
		);
		assert.equal(wrong.status, 400);
		await wrong.text();
		assert.equal(completed, "");
		const right = await fetch(
			"http://localhost:1455/auth/callback?state=expected&code=x",
			{ headers },
		);
		assert.equal(right.status, 200);
		await right.text();
		assert.ok(completed.includes("code=x"));
	} finally {
		closeCodexListener("test");
	}
});
