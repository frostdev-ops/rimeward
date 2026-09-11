// Build the worker from the same immutable revision as the Rust host SDK.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rustNotices } from './rust-notices.mjs';
import { patchCua } from './cua/patch.mjs';

export const CUA_REVISION = '6c0348b059595e63d1df96e6df2047ca7dbbbf1c';
const desktop = path.dirname(fileURLToPath(import.meta.url));
if (process.platform === 'darwin') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-cua-'));
  const run = (cmd, args, cwd = temporary) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
  try {
    run('git', ['init', '-q']);
    run('git', ['remote', 'add', 'origin', 'https://github.com/trycua/cua.git']);
    run('git', ['sparse-checkout', 'set', 'libs/cua-driver/rust']);
    run('git', ['fetch', '--depth=1', '--filter=blob:none', 'origin', CUA_REVISION]);
    run('git', ['checkout', '--detach', 'FETCH_HEAD']);
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: temporary, encoding: 'utf8' }).trim();
    if (revision !== CUA_REVISION) throw Error('Cua source revision mismatch');
    const source = path.join(temporary, 'libs/cua-driver/rust');
    patchCua(source);
    // Build the worker with the same pinned compiler as the desktop host.
    fs.copyFileSync(path.join(desktop, '../rust-toolchain.toml'), path.join(source, 'rust-toolchain.toml'));
    const target = 'aarch64-apple-darwin';
    const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(os.tmpdir(), 'rimeward-cua-rust-target');
    run('cargo', ['build', '--locked', '--release', '--bin', 'cua-driver', '--target', target, '--target-dir', targetDir], source);
    const output = path.join(desktop, 'runtime/cua');
    fs.mkdirSync(output, { recursive: true });
    fs.copyFileSync(path.join(targetDir, target, 'release/cua-driver'), path.join(output, 'cua-driver'));
    fs.chmodSync(path.join(output, 'cua-driver'), 0o755);
    fs.copyFileSync(path.join(temporary, 'LICENSE.md'), path.join(output, 'LICENSE.md'));
    rustNotices(path.join(source, 'crates/cua-driver/Cargo.toml'), path.join(output, 'rust-licenses'), target);
    fs.copyFileSync(path.join(source, 'Cargo.lock'), path.join(output, 'Cargo.lock'));
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ version: '0.25.0', revision, target, overlay: 'rimeward-release-guard-v1', validatedNativeOSBuilds: ['26A5416b'], webViewText: false }, null, 2));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
