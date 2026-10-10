// Native, pinned OCR acquisition/build. Never use a developer OCR installation.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const pins = {
	tesseract: {
		version: "5.5.2",
		url: "https://codeload.github.com/tesseract-ocr/tesseract/tar.gz/refs/tags/5.5.2",
		sha256: "6235ea0dae45ea137f59c09320406f5888383741924d98855bd2ce0d16b54f21",
		bytes: 1903633,
		source: "tesseract-5.5.2",
	},
	leptonica: {
		version: "1.87.0",
		url: "https://github.com/DanBloomberg/leptonica/releases/download/1.87.0/leptonica-1.87.0.tar.gz",
		sha256: "c73363397f96eb1295602bf44d708a994ad42046c791bf03ea0505d829bdb6a7",
		bytes: 14802808,
		source: "leptonica-1.87.0",
	},
	zlib: {
		version: "1.3.2",
		url: "https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz",
		sha256: "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16",
		bytes: 1502830,
		source: "zlib-1.3.2",
	},
	png: {
		version: "1.6.59",
		url: "https://codeload.github.com/pnggroup/libpng/tar.gz/refs/tags/v1.6.59",
		sha256: "2540302a1844ad2b2b501977abecfa850f265f97b78f065a712ab4074a89f5b5",
		bytes: 1600400,
		source: "libpng-1.6.59",
	},
	data: {
		version: "87416418657359cb625c412a48b6e1d6d41c29bd",
		url: "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata",
		sha256: "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
		bytes: 4113088,
	},
};
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const run = (file, args, options = {}) =>
	execFileSync(file, args, { stdio: "inherit", ...options });
const output = (file, args) =>
	execFileSync(file, args, { encoding: "utf8" }).trim();
const files = (directory) =>
	fs
		.readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) =>
			path
				.relative(directory, path.join(e.parentPath, e.name))
				.replaceAll(path.sep, "/"),
		);

export function validate(directory) {
	try {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
		);
		if (
			manifest.tesseract !== pins.tesseract.version ||
			manifest.leptonica !== pins.leptonica.version ||
			manifest.dataRevision !== pins.data.version ||
			manifest.platform !==
				(process.platform === "win32" ? "windows" : process.platform) ||
			manifest.arch !== (process.arch === "x64" ? "x86_64" : "aarch64")
		)
			return false;
		for (const name of [
			process.platform === "win32" ? "tesseract.exe" : "tesseract",
			"tessdata/eng.traineddata",
			"tessdata/configs/tsv",
		])
			if (!manifest.hashes[name]) return false;
		for (const [name, hash] of Object.entries(manifest.hashes)) {
			if (
				path.isAbsolute(name) ||
				name
					.split("/")
					.some((piece) => !piece || piece === ".." || piece === ".")
			)
				return false;
			if (sha(fs.readFileSync(path.join(directory, name))) !== hash)
				return false;
		}
		return manifest.hashes["tessdata/eng.traineddata"] === pins.data.sha256;
	} catch {
		return false;
	}
}

async function acquire(pin, destination) {
	if (
		fs.existsSync(destination) &&
		fs.statSync(destination).size === pin.bytes &&
		sha(fs.readFileSync(destination)) === pin.sha256
	)
		return;
	const response = await fetch(pin.url);
	if (!response.ok)
		throw new Error(`OCR source acquisition failed: ${pin.url}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length !== pin.bytes || sha(bytes) !== pin.sha256)
		throw new Error(`OCR source checksum mismatch: ${pin.url}`);
	fs.writeFileSync(`${destination}.part`, bytes);
	fs.renameSync(`${destination}.part`, destination);
}

export async function ensureOcr(destination = path.join(here, "runtime/ocr")) {
	if (
		!["win32", "linux"].includes(process.platform) ||
		!["x64", "arm64"].includes(process.arch)
	)
		throw new Error(
			"Portable OCR builds require a native Windows/Linux target",
		);
	const windows = process.platform === "win32";
	const installation = windows
		? JSON.parse(
				output(
					path.join(
						process.env["ProgramFiles(x86)"],
						"Microsoft Visual Studio/Installer/vswhere.exe",
					),
					["-latest", "-products", "*", "-format", "json"],
				),
			)[0]
		: null;
	const compiler = windows
		? {
				installation,
				msvc: fs
					.readFileSync(
						path.join(
							installation.installationPath,
							"VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt",
						),
						"utf8",
					)
					.trim(),
				sdks: fs.readdirSync(
					path.join(
						process.env["ProgramFiles(x86)"],
						"Windows Kits/10/Include",
					),
				),
			}
		: output("c++", ["--version"]);
	const toolchain = {
		cmake: output("cmake", ["--version"]),
		compiler,
		sdk: process.env.WindowsSDKVersion ?? null,
		generator: windows ? "Visual Studio 17 2022" : "Unix Makefiles",
	};
	const cacheRoot = path.resolve(
		process.env.RIMEWARD_OCR_CACHE ||
			path.join(os.homedir(), ".cache/rimeward-ocr"),
	);
	const key = sha(
		Buffer.from(
			JSON.stringify({
				script: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
				platform: process.platform,
				arch: process.arch,
				toolchain,
			}),
		),
	);
	const cache = path.join(cacheRoot, key),
		staged = path.join(cache, "runtime");
	if (!validate(staged)) {
		fs.mkdirSync(cache, { recursive: true });
		const sources = path.join(cache, "sources"),
			prefix = path.join(cache, "install");
		fs.rmSync(sources, { recursive: true, force: true });
		fs.mkdirSync(sources, { recursive: true });
		for (const [name, pin] of Object.entries(pins)) {
			const archive = path.join(
				cache,
				name === "data" ? "eng.traineddata" : `${name}.tar.gz`,
			);
			await acquire(pin, archive);
			if (name !== "data") run("tar", ["-xzf", archive, "-C", sources]);
		}
		// A failed build is retried from pinned source, never reused as an available runtime.
		fs.rmSync(prefix, { recursive: true, force: true });
		fs.rmSync(path.join(cache, "build"), { recursive: true, force: true });
		const common = [
			"-DCMAKE_BUILD_TYPE=Release",
			`-DCMAKE_INSTALL_PREFIX=${prefix}`,
			`-DCMAKE_PREFIX_PATH=${prefix}`,
			"-DZLIB_USE_STATIC_LIBS=ON",
			"-DCMAKE_INSTALL_LIBDIR=lib",
			"-DBUILD_SHARED_LIBS=OFF",
			...(windows
				? [
						"-G",
						"Visual Studio 17 2022",
						"-A",
						process.arch === "arm64" ? "ARM64" : "x64",
						"-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
						"-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
					]
				: []),
		];
		const zlib = path.join(prefix, "lib", windows ? "zs.lib" : "libz.a"),
			png = path.join(
				prefix,
				"lib",
				windows ? "libpng16_static.lib" : "libpng16.a",
			);
		const codecs = [
			`-DZLIB_INCLUDE_DIR=${prefix}/include`,
			`-DZLIB_LIBRARY=${zlib}`,
			`-DPNG_PNG_INCLUDE_DIR=${prefix}/include`,
			`-DPNG_LIBRARY=${png}`,
		];
		const flags = {
			zlib: [
				"-DZLIB_BUILD_SHARED=OFF",
				"-DZLIB_BUILD_STATIC=ON",
				"-DZLIB_BUILD_TESTING=OFF",
			],
			png: [
				"-DPNG_SHARED=OFF",
				"-DPNG_STATIC=ON",
				"-DPNG_TESTS=OFF",
				"-DPNG_TOOLS=OFF",
				...codecs.slice(0, 2),
			],
			leptonica: [
				"-DBUILD_PROG=OFF",
				"-DSW_BUILD=OFF",
				"-DSTRICT_CONF=ON",
				"-DENABLE_PNG=ON",
				"-DENABLE_ZLIB=ON",
				"-DENABLE_GIF=OFF",
				"-DENABLE_JPEG=OFF",
				"-DENABLE_TIFF=OFF",
				"-DENABLE_WEBP=OFF",
				"-DENABLE_OPENJPEG=OFF",
				...codecs,
			],
			tesseract: [
				`-DLeptonica_DIR=${prefix}/lib/cmake/leptonica`,
				"-DSW_BUILD=OFF",
				"-DBUILD_TRAINING_TOOLS=OFF",
				"-DBUILD_TESTS=OFF",
				"-DDISABLED_LEGACY_ENGINE=ON",
				"-DGRAPHICS_DISABLED=ON",
				"-DDISABLE_TIFF=ON",
				"-DDISABLE_ARCHIVE=ON",
				"-DDISABLE_CURL=ON",
				"-DOPENMP_BUILD=OFF",
				"-DENABLE_NATIVE=OFF",
				"-DENABLE_LTO=OFF",
				"-DINSTALL_CONFIGS=ON",
				...(windows
					? ["-DWIN32_MT_BUILD=ON"]
					: ["-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ -static-libgcc"]),
				...codecs,
			],
		};
		for (const name of ["zlib", "png", "leptonica", "tesseract"]) {
			const build = path.join(cache, "build", name);
			run("cmake", [
				"-S",
				path.join(sources, pins[name].source),
				"-B",
				build,
				...common,
				...flags[name],
			]);
			run("cmake", [
				"--build",
				build,
				"--config",
				"Release",
				"--parallel",
				"2",
			]);
			run("cmake", ["--install", build, "--config", "Release"]);
		}
		fs.rmSync(staged, { recursive: true, force: true });
		fs.mkdirSync(path.join(staged, "licenses"), { recursive: true });
		fs.mkdirSync(path.join(staged, "tessdata/configs"), { recursive: true });
		const executable = windows ? "tesseract.exe" : "tesseract";
		fs.copyFileSync(
			path.join(prefix, "bin", executable),
			path.join(staged, executable),
		);
		fs.chmodSync(path.join(staged, executable), 0o755);
		fs.copyFileSync(
			path.join(cache, "eng.traineddata"),
			path.join(staged, "tessdata/eng.traineddata"),
		);
		fs.copyFileSync(
			path.join(sources, pins.tesseract.source, "tessdata/configs/tsv"),
			path.join(staged, "tessdata/configs/tsv"),
		);
		for (const [name, licenses] of Object.entries({
			tesseract: ["LICENSE", "AUTHORS"],
			leptonica: ["leptonica-license.txt"],
			zlib: ["LICENSE"],
			png: ["LICENSE", "AUTHORS"],
		})) {
			for (const license of licenses)
				fs.copyFileSync(
					path.join(sources, pins[name].source, license),
					path.join(
						staged,
						"licenses",
						`${name}-${license.replaceAll("/", "-")}`,
					),
				);
		}
		fs.copyFileSync(
			path.join(staged, "licenses/tesseract-LICENSE"),
			path.join(staged, "licenses/tessdata_fast-LICENSE"),
		);
		if (!windows) {
			// GCC's statically linked runtime has an exception. Ship the actual
			// toolchain's GPL and runtime exception texts with its compiler identity.
			const licenses = [
				"/usr/share/doc/gcc-14-base",
				"/usr/share/doc/gcc-13-base",
			].find((dir) => fs.existsSync(path.join(dir, "copyright")));
			if (!licenses)
				throw new Error("GCC runtime redistribution notices are required");
			fs.copyFileSync(
				path.join(licenses, "copyright"),
				path.join(staged, "licenses/GCC-runtime-copyright"),
			);
			fs.copyFileSync(
				"/usr/share/common-licenses/GPL-3",
				path.join(staged, "licenses/GCC-runtime-GPL-3"),
			);
		}
		fs.writeFileSync(
			path.join(staged, "SOURCES.md"),
			`# Portable OCR\n\n${Object.entries(pins)
				.map(
					([name, pin]) =>
						`${name} ${pin.version}\n${pin.url}\nSHA-256 ${pin.sha256}\n`,
				)
				.join(
					"\n",
				)}\nBuild toolchain and exact flags:\n\n${JSON.stringify({ toolchain, common, flags }, null, 2)}\n`,
		);
		const hashes = Object.fromEntries(
			files(staged).map((name) => [
				name,
				sha(fs.readFileSync(path.join(staged, name))),
			]),
		);
		fs.writeFileSync(
			path.join(staged, "manifest.json"),
			JSON.stringify(
				{
					tesseract: pins.tesseract.version,
					leptonica: pins.leptonica.version,
					dataRevision: pins.data.version,
					platform: windows ? "windows" : "linux",
					arch: process.arch === "x64" ? "x86_64" : "aarch64",
					pins,
					toolchain,
					hashes,
				},
				null,
				2,
			),
		);
		if (!validate(staged))
			throw new Error("Built OCR manifest validation failed");
		run(process.execPath, [
			path.join(here, "../tests/portable-ocr-smoke.mjs"),
			staged,
		]);
	}
	fs.rmSync(destination, { recursive: true, force: true });
	fs.cpSync(staged, destination, { recursive: true });
	run(process.execPath, [
		path.join(here, "../tests/portable-ocr-smoke.mjs"),
		destination,
	]);
	return destination;
}
if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	await ensureOcr(process.argv[2]);
