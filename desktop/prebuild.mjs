// Build on the target OS/architecture so native modules match the bundled Node.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rustNotices } from './rust-notices.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)),
  root = path.dirname(here);
const version = "22.22.0",
  platform = process.platform,
  arch = process.arch;
if (platform === "darwin" && arch !== "arm64")
  throw new Error("macOS builds require Apple Silicon (arm64).");
const target = `${arch === "arm64" ? "aarch64" : "x86_64"}-${platform === "darwin" ? "apple-darwin" : platform === "win32" ? "pc-windows-msvc" : "unknown-linux-gnu"}`;
if (
  !["darwin", "linux", "win32"].includes(platform) ||
  !["arm64", "x64"].includes(arch)
)
  throw new Error("Unsupported desktop target");
const run = (file, args, opts = {}) =>
  execFileSync(file, args, { stdio: "inherit", ...opts });
const npm =
  process.env.npm_execpath || (platform === "win32" ? "npm.cmd" : "npm");
if(process.env.npm_execpath)run(process.execPath,[process.env.npm_execpath,"run","build"],{cwd:root});
else run(npm,["run","build"],{cwd:root,shell:platform==="win32"});
const runtime = path.join(here, "runtime"),
  app = path.join(runtime, "app");
fs.rmSync(runtime, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rimeward-node-"));
try {
  const base = `node-v${version}-${platform === "win32" ? "win" : platform}-${arch}`,
    name = base + (platform === "win32" ? ".zip" : ".tar.gz");
  const origin = `https://nodejs.org/dist/v${version}/`;
  const [archive, checks] = await Promise.all([
    fetch(origin + name).then((r) => {
      if (!r.ok) throw new Error("Node download failed");
      return r.arrayBuffer();
    }),
    fetch(`${origin}SHASUMS256.txt`).then((r) => r.text()),
  ]);
  const expected = checks
    .split("\n")
    .find((line) => line.endsWith(`  ${name}`))
    ?.split(" ")[0];
  if (
    !expected ||
    crypto.createHash("sha256").update(Buffer.from(archive)).digest("hex") !==
      expected
  )
    throw new Error("Node checksum mismatch");
  const downloaded = path.join(temporary, name);
  fs.writeFileSync(downloaded, Buffer.from(archive));
  if (platform === "win32")
    run("powershell", [
      "-NoProfile",
      "-Command",
      "Expand-Archive",
      "-LiteralPath",
      downloaded,
      "-DestinationPath",
      temporary,
    ]);
  else run("tar", ["-xzf", downloaded, "-C", temporary]);
  const node = path.join(runtime, platform === "win32" ? "node.exe" : "node");
  fs.copyFileSync(
    path.join(temporary, base, platform === "win32" ? "node.exe" : "bin/node"),
    node,
  );
  fs.chmodSync(node, 0o755);
  fs.copyFileSync(path.join(temporary,base,"LICENSE"),path.join(runtime,"Node-LICENSE"));
  for (const name of [
    "dist",
    "public",
    "migrations",
    "assets",
    "package.json",
    "package-lock.json",
    "server.mjs",
    "desktop-runtime.mjs",
  ])
    fs.cpSync(path.join(root, name), path.join(app, name), { recursive: true });
  fs.mkdirSync(path.join(app, "bin"), { recursive: true });
  fs.copyFileSync(
    path.join(root, "bin/prepare-pty.mjs"),
    path.join(app, "bin/prepare-pty.mjs"),
  );
  const npmCli = path.join(
    temporary,
    base,
    platform === "win32"
      ? "node_modules/npm/bin/npm-cli.js"
      : "lib/node_modules/npm/bin/npm-cli.js",
  );
  const env = {
    ...process.env,
    PATH: runtime + path.delimiter + process.env.PATH,
  };
  // Install against the bundled runtime. Never copy developer node_modules or .env.
  run(node, [npmCli, "ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: app,
    env,
  });
  for (const dir of fs.readdirSync(
    path.join(app, "node_modules/node-pty/prebuilds"),
  )) {
    if (dir !== `${platform}-${arch}`) {
      fs.rmSync(path.join(app, "node_modules/node-pty/prebuilds", dir), { recursive: true, force: true });
      continue;
    }
    const helper = path.join(
      app,
      "node_modules/node-pty/prebuilds",
      dir,
      "spawn-helper",
    );
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
  // Native build intermediates are not runtime code and cannot be notarized.
  for (const entry of fs.readdirSync(path.join(app, "node_modules"), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".o")) fs.unlinkSync(path.join(entry.parentPath, entry.name));
  }
  const browsers = path.join(runtime, "browsers");
  run(
    node,
    [
      path.join(app, "node_modules/playwright-core/cli.js"),
      "install",
      "chromium",
    ],
    { cwd: app, env: { ...env, PLAYWRIGHT_BROWSERS_PATH: browsers } },
  );
  if (process.env.RIMEWARD_SKIP_TESTS !== "1") run(
    node,
    [
      "--input-type=module",
      "-e",
      `import Database from 'better-sqlite3'; const db=new Database(':memory:');db.close();import pty from 'node-pty';const p=pty.spawn(${JSON.stringify(platform === "win32" ? "cmd.exe" : "/bin/sh")},${JSON.stringify(platform === "win32" ? ["/c", "echo runtime-ok"] : ["-c", "printf runtime-ok"])},{env:process.env});p.onData(()=>{});p.onExit(e=>process.exit(e.exitCode));`,
    ],
    { cwd: app, env },
  );
  const binaries = path.join(here, "binaries");
  fs.mkdirSync(binaries, { recursive: true });
  fs.copyFileSync(
    node,
    path.join(
      binaries,
      `rimeward-node-${target}${platform === "win32" ? ".exe" : ""}`,
    ),
  );
  fs.chmodSync(
    path.join(
      binaries,
      `rimeward-node-${target}${platform === "win32" ? ".exe" : ""}`,
    ),
    0o755,
  );
  fs.rmSync(node);
  // The media SDK is dozens of upstream fetches (a from-source build on
  // Linux); cerbero resumes from its cache dir, so one retry covers a bad
  // mirror response without failing the platform.
  for (let attempt = 1; ; attempt++) {
    try { run(process.execPath, [path.join(here, 'media-runtime.mjs')]); break; }
    catch (error) { if (attempt === 2) throw error; console.warn('Media SDK acquisition failed; retrying once'); }
  }
  run(process.execPath, [path.join(here, 'cua-runtime.mjs')]);
  rustNotices(path.join(here, 'Cargo.toml'), path.join(runtime, 'rust-licenses'), target);
  fs.writeFileSync(
    path.join(runtime, "runtime.json"),
    JSON.stringify({ node: version, target, protocol: 1 }),
  );
  console.log(
    `Bundled Node ${version}, native dependencies, application, and Chromium for ${platform}/${arch}.`,
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
