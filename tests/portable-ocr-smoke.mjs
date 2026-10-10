// Real native executable, memory-generated PNG, TSV, hashes and loader closure.
// Called against both staged AND extracted Windows/Linux installers in CI.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { validate } from "../desktop/ocr-runtime.mjs";

const directory = path.resolve(process.argv[2] || "desktop/runtime/ocr");
assert.ok(
	validate(directory),
	"Pinned OCR runtime manifest and every shipped hash",
);
const executable = path.join(
	directory,
	process.platform === "win32" ? "tesseract.exe" : "tesseract",
);
const version = execFileSync(executable, ["--version"], {
	encoding: "utf8",
	timeout: 5000,
	maxBuffer: 8192,
});
assert.match(version, /tesseract 5\.5\.2\b/);
assert.match(version, /leptonica-1\.87\.0\b/);
const glyphs = {
	H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
	E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
	L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
	O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
	W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
	R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
	D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
};
const text = "HELLO WORLD",
	scale = 10,
	width = (text.length * 6 + 8) * scale,
	height = 15 * scale;
const rgb = Buffer.alloc((width * 3 + 1) * height, 255);
for (let y = 0; y < height; y++) rgb[y * (width * 3 + 1)] = 0;
for (let i = 0; i < text.length; i++)
	for (let y = 0; y < 7; y++)
		for (let x = 0; x < 5; x++)
			if (glyphs[text[i]]?.[y][x] === "1") {
				for (let dy = 0; dy < scale; dy++)
					for (let dx = 0; dx < scale; dx++) {
						const at =
							(y * scale + dy + 4 * scale) * (width * 3 + 1) +
							1 +
							(i * 6 * scale + x * scale + dx + 4 * scale) * 3;
						rgb.fill(0, at, at + 3);
					}
			}
const crc = (bytes) => {
	let n = 0xffffffff;
	for (const byte of bytes) {
		n ^= byte;
		for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
	}
	return (n ^ 0xffffffff) >>> 0;
};
const chunk = (name, bytes) => {
	const tag = Buffer.from(name),
		size = Buffer.alloc(4),
		check = Buffer.alloc(4);
	size.writeUInt32BE(bytes.length);
	check.writeUInt32BE(crc(Buffer.concat([tag, bytes])));
	return Buffer.concat([size, tag, bytes, check]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(width);
header.writeUInt32BE(height, 4);
header[8] = 8;
header[9] = 2;
const png = Buffer.concat([
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	chunk("IHDR", header),
	chunk("IDAT", deflateSync(rgb)),
	chunk("IEND", Buffer.alloc(0)),
]);
const env = {
	PATH:
		process.platform === "win32"
			? `${process.env.SystemRoot}/System32`
			: "/usr/bin:/bin",
	SystemRoot: process.env.SystemRoot,
	OMP_THREAD_LIMIT: "1",
};
const tsv = execFileSync(
	executable,
	[
		"stdin",
		"stdout",
		"--tessdata-dir",
		path.join(directory, "tessdata"),
		"-l",
		"eng",
		"--oem",
		"1",
		"--psm",
		"11",
		"tsv",
	],
	{ input: png, encoding: "utf8", env, timeout: 30000, maxBuffer: 1024 * 1024 },
);
const words = tsv
	.trim()
	.split(/\r?\n/)
	.slice(1)
	.map((row) => row.split("\t"))
	.filter((row) => row[0] === "5");
assert.match(
	words
		.map((row) => row.slice(11).join("\t"))
		.join(" ")
		.toUpperCase(),
	/HELLO WORLD/,
);
for (const row of words) {
	assert.equal(row.length, 12);
	const [x, y, w, h] = row.slice(6, 10).map(Number);
	assert.ok(
		x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= width && y + h <= height,
	);
	assert.ok(Number(row[10]) >= 0 && Number(row[10]) <= 100);
}
if (process.platform === "linux") {
	const dynamic = execFileSync("readelf", ["-d", executable], {
		encoding: "utf8",
	});
	const needed = [...dynamic.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(
		(match) => match[1],
	);
	const allowed = new Set([
		"libc.so.6",
		"libm.so.6",
		"libpthread.so.0",
		"libdl.so.2",
		"librt.so.1",
		"ld-linux-x86-64.so.2",
		"ld-linux-aarch64.so.1",
	]);
	assert.ok(needed.length > 0);
	for (const name of needed)
		assert.ok(allowed.has(name), `Unexpected OCR loader dependency: ${name}`);
	const resolved = execFileSync("ldd", [executable], { encoding: "utf8", env });
	assert.doesNotMatch(resolved, /not found/);
	for (const match of resolved.matchAll(/=>\s+(\/\S+)/g))
		assert.ok(
			/^\/(usr\/)?lib(64)?\//.test(match[1]),
			`Unexpected loader path: ${match[1]}`,
		);
	console.log(dynamic, resolved);
} else if (process.platform === "win32") {
	const vswhere = path.join(
		process.env["ProgramFiles(x86)"],
		"Microsoft Visual Studio/Installer/vswhere.exe",
	);
	const dumpbin = execFileSync(
		vswhere,
		[
			"-latest",
			"-products",
			"*",
			"-find",
			"VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe",
		],
		{ encoding: "utf8" },
	)
		.trim()
		.split(/\r?\n/)
		.filter(Boolean)
		.sort()
		.at(-1);
	assert.ok(dumpbin, "MSVC dumpbin required for import closure");
	const imports = execFileSync(dumpbin, ["/DEPENDENTS", executable], {
		encoding: "utf8",
	});
	const allowed = new Set([
		"KERNEL32.DLL",
		"USER32.DLL",
		"ADVAPI32.DLL",
		"SHELL32.DLL",
		"OLE32.DLL",
		"WS2_32.DLL",
		"GDI32.DLL",
		"BCRYPT.DLL",
	]);
	const needed = [...imports.matchAll(/^\s+([\w.-]+\.dll)\s*$/gim)].map(
		(match) => match[1].toUpperCase(),
	);
	assert.ok(needed.length > 0);
	for (const name of needed)
		assert.ok(
			allowed.has(name) || name.startsWith("API-MS-WIN-"),
			`Unexpected OCR import dependency: ${name}`,
		);
	console.log(imports);
}
assert.ok(
	fs.existsSync(path.join(directory, "licenses/tessdata_fast-LICENSE")),
);
console.log(
	"Portable OCR: pinned versions, hashes, memory PNG/TSV extraction and native loader closure passed.",
);
