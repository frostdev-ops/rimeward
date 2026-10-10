import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { LensCore } from "../src/lib/lens/core.ts";
import { sqliteStore } from "../src/lib/lens/store.ts";
import { createUser } from "../src/lib/users.ts";
import { setSetting } from "../src/lib/settings.ts";
import {
	calibration,
	calibrationKey,
	saveVisualCalibration,
	visualCalibration,
	visualCalibrationKey,
} from "../src/lib/lens/gate.ts";
import { FakeClock } from "./fake-clock.ts";
import type { Feed, Source } from "../src/lib/lens/core.ts";

test("portable visual rows never borrow embedding calibration and refuse invalid scores", () => {
	const id = "windows:wgc:rgb16-tile32-v1";
	setSetting(
		calibrationKey(id),
		JSON.stringify({
			forThreshold: 0.5,
			visualThreshold: 0.001,
			liveThreshold: 0.001,
		}),
	);
	assert.equal(visualCalibration(id).calibrated, false);
	saveVisualCalibration(id, { visualThreshold: 0.25, liveThreshold: 0.02 });
	assert.equal(visualCalibration(id).visualThreshold, 0.25);
	assert.equal(calibration(id).visualThreshold, 0.001);
	setSetting(
		visualCalibrationKey(id),
		JSON.stringify({ visualThreshold: 2, liveThreshold: 0.1 }),
	);
	assert.equal(visualCalibration(id).calibrated, false);
	assert.throws(() =>
		saveVisualCalibration("unknown", {
			visualThreshold: 0.1,
			liveThreshold: 0.2,
		}),
	);
});

test("unmeasured visual scores disable watches and every live suppression while OCR text delivers", async () => {
	const user = createUser(
		"portable-calibration@example.com",
		"portable-calibration-password",
	);
	const clock = new FakeClock(1000000);
	let feed: Feed | null = null;
	const source: Source = {
		async connect(_u, _t, f) {
			feed = f;
			return () => {};
		},
		visualCalibration: () => ({
			scoreId: "linux:x11:rgb16-tile32-v1",
			visualThreshold: 0.01,
			liveThreshold: 0.01,
			calibrated: false,
		}),
	};
	const core = new LensCore({
		user,
		target: "portable",
		source,
		clock,
		store: {
			...sqliteStore(user, "portable-calibration", () => clock.now()),
			loadConsumers: () => [],
		},
		settings: () => ({ settleMs: 0, minLines: 1 }),
	});
	try {
		core.consumer("reader");
		await core.ready();
		const modes = await core.watch("reader", { add: [{ visual: true, triage: false }] });
		assert.match(JSON.stringify(modes), /unavailable/);
		const wire = feed as Feed | null;
		assert.ok(wire);
		wire.epoch(1, 1);
		wire.replace([{ text: "initial", src: "ocr", bbox: [0, 0, 100, 20] }], 1);
		await new Promise((resolve) => setImmediate(resolve));
		wire.live([[0, 0, 100, 20]]);
		for (let i = 0; i < 5; i++)
			wire.dirty({ bbox: [0, 0, 100, 20], d: 1 }, clock.now());
		wire.replace(
			[{ text: "ordinary OCR change", src: "ocr", bbox: [0, 0, 100, 20] }],
			2,
		);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(core.doc().live, []);
		assert.equal(core.doc().lines[0]?.text, "ordinary OCR change");
	} finally {
		core.close();
	}
});

function transport() {
	// Execute the actual bundled transport's protocol block, without starting a
	// server or spending native requests. This catches drift beyond the facade.
	const source = fs.readFileSync(
		new URL("../desktop-runtime.mjs", import.meta.url),
		"utf8",
	);
	const start = source.indexOf("const pending = new Map();"),
		end = source.indexOf("const { httpServer }");
	assert.ok(start >= 0 && end > start);
	const lines = new EventEmitter(),
		writes: Record<string, unknown>[] = [];
	const context = vm.createContext({
		lines,
		process: {
			stdout: {
				writableLength: 0,
				write: (line: string) => writes.push(JSON.parse(line)),
			},
			emit: () => true,
			exit: () => {},
		},
		setTimeout,
		clearTimeout,
		Buffer,
	});
	vm.runInContext(source.slice(start, end), context);
	return {
		lines,
		writes,
		output: context.process.stdout as { writableLength: number },
		request: context.__nativeDesktop as (
			op: string,
			value?: unknown,
			deadline?: number,
			signal?: AbortSignal,
		) => Promise<unknown>,
	};
}

test("real native transport reserves bounded Stop admission and sends cancellation on turn abort/timeout", async () => {
	const t = transport();
	const abort = new AbortController();
	const pending: Array<Promise<unknown>> = [];
	for (let i = 0; i < 32; i++)
		pending.push(
			t
				.request("lens-ocr", {}, 30000, i === 0 ? abort.signal : undefined)
				.catch((error) => error),
		);
	t.output.writableLength = 16 * 1024 * 1024;
	for (let i = 0; i < 4; i++)
		pending.push(t.request("lens-stop", {}, 30000).catch((error) => error));
	await assert.rejects(t.request("lens-stop", {}, 30000), /busy/);
	assert.equal(t.writes.length, 36);
	abort.abort();
	assert.deepEqual(t.writes.at(-1), { type: "cancel", id: 1 });
	for (let id = 2; id <= 36; id++)
		t.lines.emit("line", JSON.stringify({ id, value: true }));
	await Promise.all(pending);
	t.output.writableLength = 0;
	await assert.rejects(t.request("lens-ocr", {}, 1), /timed out/);
	assert.deepEqual(t.writes.at(-1), { type: "cancel", id: 37 });
	const stopped = transport();
	abort.abort();
	await assert.rejects(
		stopped.request("lens-ocr", {}, 30000, abort.signal),
		/cancelled/,
	);
	assert.equal(stopped.writes.length, 0);
	const controlsOnly = transport();
	const stops = Array.from({ length: 4 }, () => controlsOnly.request("lens-stop"));
	await assert.rejects(controlsOnly.request("lens-stop"), /busy/);
	for (let id = 1; id <= 4; id++)
		controlsOnly.lines.emit("line", JSON.stringify({ id, value: true }));
	await Promise.all(stops);
});
