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
		const modes = await core.watch("reader", {
			add: [{ visual: true, triage: false }],
		});
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
	const stops = Array.from({ length: 4 }, () =>
		controlsOnly.request("lens-stop"),
	);
	await assert.rejects(controlsOnly.request("lens-stop"), /busy/);
	for (let id = 1; id <= 4; id++)
		controlsOnly.lines.emit("line", JSON.stringify({ id, value: true }));
	await Promise.all(stops);
});

test("actual native overlay listener never renders or acknowledges an older slot generation", () => {
	let listener:
		| ((event: { payload: Record<string, unknown> }) => void)
		| undefined;
	let rendered: Record<string, unknown> | undefined;
	const acknowledgements: Record<string, unknown>[] = [];
	const source = fs.readFileSync(
		new URL("../desktop/frontend/overlay/main.js", import.meta.url),
		"utf8",
	);
	vm.runInNewContext(source.slice(source.indexOf("if (tauri && own)")), {
		tauri: {
			event: {
				emit: (_name: string, payload: Record<string, unknown>) =>
					acknowledgements.push(payload),
			},
		},
		own: {
			listen: (name: string, handler: typeof listener) => {
				if (name === "overlay:show") listener = handler;
			},
		},
		render: (payload: Record<string, unknown>) => {
			rendered = payload;
		},
		document: { body: { classList: { toggle() {} } } },
	});
	assert.ok(listener);
	listener({
		payload: { id: "caption", generation: 2, text: "new", origin: [200, 200] },
	});
	listener({
		payload: { id: "caption", generation: 1, text: "old", origin: [100, 100] },
	});
	listener({ payload: { id: "reused", generation: 2, text: "duplicate" } });
	listener({ payload: { id: "reused", text: "unversioned" } });
	assert.equal(rendered?.text, "new");
	assert.deepEqual(rendered?.origin, [200, 200]);
	assert.equal(acknowledgements.length, 1);
	assert.equal(acknowledgements[0]?.generation, 2);
	listener({ payload: { id: "reused", generation: 3, text: "new id" } });
	assert.equal(rendered?.text, "new id");
	assert.equal(acknowledgements.length, 2);
});

test("actual OCR recipe matches the installed Visual Studio major to available CMake generators", () => {
	const source = fs.readFileSync(
		new URL("../desktop/ocr-runtime.mjs", import.meta.url),
		"utf8",
	);
	const start = source.indexOf("const installation = windows"),
		end = source.indexOf("const cacheRoot");
	assert.ok(start >= 0 && end > start);
	const evaluate = (version: string, generators: string[]) =>
		vm.runInNewContext(`${source.slice(start, end)}; toolchain`, {
			windows: true,
			path: { join: (...parts: string[]) => parts.join("/") },
			process: { env: { "ProgramFiles(x86)": "C:/Program Files (x86)" } },
			fs: {
				readFileSync: () => "14.50\n",
				readdirSync: () => ["10.0.26100.0"],
			},
			console: { log() {} },
			output: (_file: string, args: string[]) =>
				args.includes("-format")
					? JSON.stringify([
							{
								installationPath: "C:/VisualStudio",
								installationVersion: version,
							},
						])
					: args.includes("capabilities")
						? JSON.stringify({
								generators: generators.map((name) => ({ name })),
							})
						: "cmake version 4.4.3",
		});
	const current = evaluate("18.10.12217.157", [
		"Visual Studio 17 2022",
		"Visual Studio 18 2026",
	]);
	assert.equal(current.generator, "Visual Studio 18 2026");
	assert.equal(current.instance, "C:/VisualStudio");
	assert.equal(
		evaluate("17.14.0", ["Visual Studio 17 2022", "Visual Studio 18 2026"])
			.generator,
		"Visual Studio 17 2022",
	);
	assert.throws(
		() => evaluate("18.10.12217.157", ["Visual Studio 17 2022"]),
		/no generator/,
	);
});
