// Sign nested native resources before Tauri seals and notarizes the outer app.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const desktop = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? path.join(desktop, "runtime");
const identity = process.env.APPLE_SIGNING_IDENTITY;
if (process.platform !== "darwin" || !identity)
  throw new Error("macOS and APPLE_SIGNING_IDENTITY are required.");

const files = [], bundles = [];
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(file);
      if (/\.(app|framework|xpc)$/.test(entry.name)) bundles.push(file);
    } else if (entry.isFile()) {
      const fd = fs.openSync(file, "r"), header = Buffer.alloc(4);
      try {
        if (fs.readSync(fd, header, 0, 4, 0) === 4 &&
            [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header.readUInt32BE())) {
          // `file` distinguishes universal Mach-O from Java's shared magic value.
          if (execFileSync("file", ["-b", file], { encoding: "utf8" }).includes("Mach-O")) files.push(file);
        }
      } finally { fs.closeSync(fd); }
    }
  }
}
// Build artifacts can acquire Finder metadata after extraction on macOS.
execFileSync("xattr", ["-cr", root], { stdio: "pipe" });
scan(root);
if (!files.length) throw new Error("No Mach-O runtime binaries found.");
const options = ["--force", "--sign", identity, "--options", "runtime",
  "--entitlements", path.join(desktop, "entitlements.plist"),
  ...(identity === "-" ? ["--timestamp=none"] : ["--timestamp"]),
  ...(process.env.RIMEWARD_SIGNING_KEYCHAIN ? ["--keychain", process.env.RIMEWARD_SIGNING_KEYCHAIN] : [])];
// A framework binary can seal its bundle, so sign all nested code first.
const code = [...files, ...bundles].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
for (const file of code) {
  // Finder can restore bundle metadata while a large runtime is being signed.
  const bundle = bundles.find((dir) => file === dir || file.startsWith(dir + path.sep));
  if (bundle) execFileSync("xattr", ["-c", bundle], { stdio: "pipe" });
  execFileSync("codesign", [...options, file], { stdio: "pipe" });
}
for (const file of code) execFileSync("codesign", ["--verify", "--strict", file], { stdio: "pipe" });
// Signing changes Mach-O bytes; the manifest must describe the files sealed into the app.
const mediaManifest = path.join(root, "media/manifest.json");
if (fs.existsSync(mediaManifest)) {
  const manifest = JSON.parse(fs.readFileSync(mediaManifest, "utf8"));
  for (const name of Object.keys(manifest.hashes)) {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(path.join(root, "media", name))) hash.update(chunk);
    manifest.hashes[name] = hash.digest("hex");
  }
  fs.writeFileSync(mediaManifest, JSON.stringify(manifest, null, 2));
}
console.log(`Signed and verified ${files.length} native binaries and ${bundles.length} bundles.`);
