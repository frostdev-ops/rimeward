// Build-only SDK acquisition. The app ships its helper and a restricted plugin set.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { rustNotices } from './rust-notices.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const version = '1.28.6', platform = process.platform, arch = process.arch;
if (platform === 'darwin' && arch !== 'arm64') throw Error('macOS builds require Apple Silicon (arm64).');
const cache = path.join(os.tmpdir(), `rimeward-media-sdk-${version}-${platform}-${arch}`);
const output = path.resolve(process.argv[2] ?? path.join(here, 'runtime/media'));
const run = (file, args, options = {}) => execFileSync(file, args, { stdio: 'inherit', ...options });
const capture = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', ...options });
fs.mkdirSync(cache, { recursive: true });
async function checksum(file) {
  const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
async function download(url, expected) {
  const file = path.join(cache, path.basename(new URL(url).pathname));
  if (fs.existsSync(file) && await checksum(file) === expected) return file;
  const part = `${file}.part`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok || !response.body) throw Error(`Media download failed (${response.status})`);
      await pipeline(response.body, fs.createWriteStream(part));
      break;
    } catch (error) {
      fs.rmSync(part, { force: true });
      if (attempt === 3) throw error;
      console.warn(`Media download interrupted; retrying (${attempt + 1}/3): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  if (await checksum(part) !== expected) { fs.rmSync(part); throw Error('Media checksum mismatch'); }
  fs.renameSync(part, file); return file;
}
let sdk = process.env.RIMEWARD_MEDIA_SDK ?? path.join(cache, 'sdk');
if (!process.env.RIMEWARD_MEDIA_SDK && !fs.existsSync(path.join(sdk, '.rimeward-sdk-complete'))) {
  if (platform === 'darwin') {
    const packages = [
      ['gstreamer-1.0-1.28.6-universal.pkg', 'a8eb366c59b7e9e5dc049848fed6bcd203a8878aa7517c051639fda78797c6ad'],
      ['gstreamer-1.0-devel-1.28.6-universal.pkg', '177b1428d0f47b844e7bff2aeeb22047686d802eba21580dab52f4a6fe1dcf02'],
    ];
    for (const [name, hash] of packages) {
      const file = await download(`https://gstreamer.freedesktop.org/data/pkg/osx/${version}/${name}`, hash);
      const expanded = `${file}.expanded`; if (!fs.existsSync(expanded)) run('pkgutil', ['--expand-full', file, expanded]);
      for (const pkg of fs.readdirSync(expanded)) {
        const payload = path.join(expanded, pkg, 'Payload');
        // Use the flat SDK. The framework facade's Headers symlink collides with
        // the development package's Headers directory when their payloads merge.
        for (const directory of ['bin', 'etc', 'include', 'lib', 'libexec', 'share']) {
          const source = path.join(payload, directory);
          if (fs.existsSync(source)) run('ditto', ['--norsrc', '--noextattr', '--noqtn', source, path.join(sdk, directory)]);
        }
      }
    }
  } else if (platform === 'win32') {
    const name = `gstreamer-1.0-msvc-${arch === 'arm64' ? 'arm64' : 'x86_64'}-${version}.exe`;
    const hash = arch === 'arm64' ? '7334a0e5fe7e94fb036cc47c2709d4a6475eb49fc9efd372a7b13bdeba3c1547' : '059251444d1267b486eba390b18d25fed87e10315e72f757ec6c7e912fa746b5';
    const file = await download(`https://gstreamer.freedesktop.org/data/pkg/windows/${version}/msvc/${name}`, hash);
    // Upstream's portable mode disables registration, environment changes, uninstall records and VC-redist installation.
    run(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/portable=1', '/TYPE=devel', '/TASKS=', `/DIR=${sdk}`]);
  } else if (platform === 'linux') {
    const cerbero = path.join(cache, 'cerbero'), commit = '59548269f4fd0f701818f0bafdb102959ec81e65';
    if (!fs.existsSync(cerbero)) run('git', ['clone', '--depth=1', '--branch', version, 'https://gitlab.freedesktop.org/gstreamer/cerbero.git', cerbero]);
    if (capture('git', ['rev-parse', 'HEAD'], { cwd: cerbero }).trim() !== commit) throw Error('Unexpected Cerbero source revision');
    // Keep upstream checksums/build fixes, but compile only the media plugins we ship.
    const recipes = path.join(cache, 'recipes'); fs.mkdirSync(recipes, { recursive: true });
    fs.copyFileSync(path.join(cerbero, 'recipes/custom.py'), path.join(recipes, 'custom.py'));
    const minimal = {
      base: { deps: ['glib', 'gstreamer-1.0', 'orc', 'opus'], plugins: ['app', 'audioconvert', 'audioresample', 'audiotestsrc', 'opus', 'playback', 'rawparse', 'typefind', 'videoconvertscale', 'videorate', 'videotestsrc'] },
      good: { deps: ['gstreamer-1.0', 'gst-plugins-base-1.0', 'libjpeg-turbo', 'libvpx', 'x11', 'libpulse'], plugins: ['jpeg', 'vpx', 'rtp', 'rtpmanager', 'ximagesrc', 'pulse'] },
      bad: { deps: ['gstreamer-1.0', 'gst-plugins-base-1.0', 'libnice', 'openssl', 'libsrtp', 'libdrm', 'libva'], plugins: ['dtls', 'srtp', 'sctp', 'sctp-internal-usrsctp', 'webrtc', 'videoparsers', 'debugutils', 'va'] },
    };
    for (const [group, { deps, plugins }] of Object.entries(minimal)) {
      const name = `gst-plugins-${group}-1.0.recipe`;
      const upstream = fs.readFileSync(path.join(cerbero, 'recipes', name), 'utf8');
      fs.writeFileSync(path.join(recipes, name), `${upstream}
class Recipe(Recipe):
    def prepare(self):
        super().prepare()
        self.deps = ${JSON.stringify(deps)}
        self.platform_deps = {}
        self.meson_options = {k: ('disabled' if v in ('enabled', 'disabled', 'auto') else v) for k, v in self.meson_options.items()}
        self.meson_options['auto_features'] = 'disabled'
        self.meson_options.update({k: 'enabled' for k in ${JSON.stringify(plugins)}})
`);
    }
    const config = path.join(cache, 'linux.cbc');
    fs.writeFileSync(config, `prefix = ${JSON.stringify(sdk)}\nhome_dir = ${JSON.stringify(cache)}\nexternal_recipes = {'rimeward': (${JSON.stringify(recipes)}, 1)}\nnum_of_cpus = 2\nvariants.override(['x11', 'pulse', 'va', 'norust', 'nopython', 'nogi', 'nodebug'])\n`);
    const base = [path.join(cerbero, 'cerbero-uninstalled'), '-c', config];
    run('python3', [...base, 'bootstrap', '-y', '-j', '2', '--system=yes', '--toolchains=yes', '--build-tools=yes'], { cwd: cerbero });
    // Release recipes contain exact source versions and hashes, including the native dependency graph.
    run('python3', [...base, 'build', '-j', '2', 'gst-plugins-good-1.0', 'gst-plugins-bad-1.0', 'libnice'], { cwd: cerbero });
  } else throw Error('Unsupported media target');
  fs.writeFileSync(path.join(sdk, '.rimeward-sdk-complete'), `${version}\n`);
}
sdk = path.resolve(sdk);
const sdkLib = [path.join(sdk, 'lib'), ...fs.readdirSync(path.join(sdk, 'lib'), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => path.join(sdk, 'lib', entry.name))]
  .find(directory => fs.existsSync(path.join(directory, 'pkgconfig/gstreamer-1.0.pc')));
if (!sdkLib) throw Error('GStreamer SDK libraries are missing');
const pkgconfig = [path.join(sdk, 'bin', platform === 'win32' ? 'pkg-config.exe' : 'pkg-config'), path.join(cache, 'build-tools/bin/pkg-config')].find(file => fs.existsSync(file)) ?? 'pkg-config';
const env = { ...process.env, PKG_CONFIG: pkgconfig, PKG_CONFIG_PATH: path.join(sdkLib, 'pkgconfig'),
  PATH: path.join(sdk, 'bin') + path.delimiter + process.env.PATH,
  // A fallback lets test binaries find GStreamer without replacing Cargo's
  // system libcurl and its certificate trust store.
  ...(platform === 'darwin' ? { DYLD_FALLBACK_LIBRARY_PATH: sdkLib } : platform === 'linux' ? { LD_LIBRARY_PATH: sdkLib } : {}) };
if (capture(pkgconfig, ['--modversion', 'gstreamer-1.0'], { env }).trim() !== version) throw Error('GStreamer 1.28.6 SDK required');
if (platform === 'linux' && !fs.existsSync(path.join(sdkLib, 'gstreamer-1.0/libgstpipewire.so'))) {
  const archive = await download('https://codeload.github.com/PipeWire/pipewire/tar.gz/refs/tags/1.4.9', '8066a7b220069e4c6e3b02bd2b6ea303bba66df255023c07c99323449ba8fe3c');
  run('tar', ['-xzf', archive, '-C', cache]);
  const source = path.join(cache, 'pipewire-1.4.9'), build = path.join(cache, 'pipewire-build');
  const meson = fs.existsSync(path.join(cache, 'build-tools/bin/meson')) ? path.join(cache, 'build-tools/bin/meson') : 'meson';
  const pipeEnv = { ...env, PATH: path.join(cache, 'build-tools/bin') + path.delimiter + env.PATH };
  run(meson, ['setup', ...(fs.existsSync(path.join(build, 'build.ninja')) ? ['--reconfigure'] : []), build, source, `--prefix=${sdk}`, `--libdir=${path.relative(sdk, sdkLib)}`, '--buildtype=release', '--wrap-mode=nofallback',
    '-Dauto_features=disabled', '-Dgstreamer=enabled', '-Dgstreamer-device-provider=disabled', '-Dexamples=disabled', '-Dtests=disabled',
    '-Dsession-managers=[]', '-Dpipewire-jack=disabled', '-Dpipewire-v4l2=disabled', '-Ddbus=disabled', '-Dsystemd-user-service=disabled'], { env: pipeEnv });
  run(meson, ['compile', '-C', build, '-j', '2'], { env: pipeEnv });
  run(meson, ['install', '-C', build], { env: pipeEnv });
  fs.mkdirSync(path.join(sdk, 'share/licenses/pipewire'), { recursive: true });
  fs.copyFileSync(path.join(source, 'COPYING'), path.join(sdk, 'share/licenses/pipewire/COPYING'));
}
const manifest = path.join(here, 'media-helper/Cargo.toml');
run('cargo', ['fmt', '--manifest-path', manifest, '--check'], { env });
run('cargo', ['clippy', '--all-targets', '--locked', '--manifest-path', manifest, '--', '-D', 'warnings'], { env });
run('cargo', ['test', '--locked', '--manifest-path', manifest], { env });
run('cargo', ['build', '--release', '--locked', '--manifest-path', manifest], { env });
const target = path.resolve(env.CARGO_TARGET_DIR ?? path.join(here, 'media-helper/target'));
fs.mkdirSync(output, { recursive: true });
const executable = platform === 'win32' ? 'rimeward-media.exe' : 'rimeward-media';
fs.copyFileSync(path.join(target, 'release', executable), path.join(output, executable));
const common = ['coreelements', 'app', 'videotestsrc', 'audiotestsrc', 'videoconvertscale', 'audioconvert', 'audioresample',
  'videorate', 'debugutilsbad', 'jpeg',
  'rtp', 'rtpmanager', 'dtls', 'srtp', 'sctp', 'nice', 'webrtc', 'opus', 'vpx', 'videoparsersbad', 'typefindfunctions', 'playback', 'rawparse'];
const plugins = [...common, ...(platform === 'darwin' ? ['applemedia'] : platform === 'win32' ? ['d3d11', 'd3d12', 'wasapi2', 'mediafoundation'] : ['ximagesrc', 'pulseaudio', 'pipewire', 'va'])];
const extension = platform === 'darwin' ? '.dylib' : platform === 'win32' ? '.dll' : '.so';
const library = path.join(output, 'lib'), pluginDir = path.join(library, 'gstreamer-1.0');
fs.rmSync(pluginDir, { recursive: true, force: true }); fs.mkdirSync(pluginDir, { recursive: true });
for (const name of plugins) {
  const prefix = platform === 'win32' ? 'gst' : 'libgst';
  const file = path.join(sdkLib, 'gstreamer-1.0', prefix + name + extension);
  if (!fs.existsSync(file)) {
    if (['d3d12', 'mediafoundation', 'va'].includes(name)) continue;
    throw Error(`Missing required media plugin: ${name}`);
  }
  fs.copyFileSync(file, path.join(pluginDir, path.basename(file)));
}
const scanner = platform === 'win32' ? 'gst-plugin-scanner.exe' : 'gst-plugin-scanner';
const scannerOut = path.join(output, 'libexec/gstreamer-1.0', scanner); fs.mkdirSync(path.dirname(scannerOut), { recursive: true });
fs.copyFileSync(path.join(sdk, 'libexec/gstreamer-1.0', scanner), scannerOut);
if (platform === 'darwin') {
  // Copy the actual dylib closure, not unrelated SDK plugins, interpreters or codecs.
  const visited = new Set();
  const pending = [path.join(output, executable), scannerOut, ...fs.readdirSync(pluginDir).map(f => path.join(pluginDir, f))];
  while (pending.length) {
    const file = pending.pop(); if (visited.has(file)) continue; visited.add(file);
    const dependencies = [...capture('otool', ['-L', file]).matchAll(/^\s+(@rpath\/[^\s]+) /gm)].map(m => path.basename(m[1]));
    for (const dependency of new Set(dependencies)) {
      const source = path.join(sdkLib, dependency), dest = path.join(library, dependency);
      if (!fs.existsSync(source)) continue; // Plugin IDs and system Swift libraries have no SDK dylib.
      if (!fs.existsSync(dest)) fs.copyFileSync(fs.realpathSync(source), dest);
      pending.push(dest);
    }
  }
} else {
  // The helper has its own loader namespace; these are SDK shared libraries only, never Tauri's plugin environment.
  for (const directory of platform === 'win32' ? [path.join(sdk, 'bin')] : [sdkLib]) {
    for (const name of fs.readdirSync(directory)) {
      if (!(platform === 'win32' ? name.endsWith('.dll') : /\.so(?:\.|$)/.test(name))) continue;
      const source = path.join(directory, name); if (!fs.statSync(source).isFile()) continue;
      fs.copyFileSync(fs.realpathSync(source), path.join(platform === 'win32' ? output : library, name));
    }
  }
}
if (platform === 'linux') {
  // PipeWire's client modules and SPA implementations also load only from this bundle.
  for (const dir of ['pipewire-0.3', 'spa-0.2']) fs.cpSync(path.join(sdkLib, dir), path.join(library, dir), { recursive: true });
  const config = path.join(output, 'share/pipewire'); fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'client.conf'), `context.properties = { log.level = 0 }
context.spa-libs = { audio.convert.* = audioconvert/libspa-audioconvert support.* = support/libspa-support video.convert.* = videoconvert/libspa-videoconvert }
context.modules = [ { name = libpipewire-module-protocol-native } { name = libpipewire-module-client-node } { name = libpipewire-module-adapter } ]
`);
}
fs.cpSync(path.join(sdk, 'share/licenses'), path.join(output, 'licenses'), { recursive: true });
rustNotices(path.join(here, 'media-helper/Cargo.toml'), path.join(output, 'licenses/rust'), capture('rustc', ['-vV']).match(/^host: (.+)$/m)?.[1]);
fs.copyFileSync(path.join(here, 'media-helper/Cargo.lock'), path.join(output, 'Cargo.lock'));
fs.copyFileSync(path.join(here, 'media-notices.md'), path.join(output, 'SOURCES.md'));
const hashes = {};
for (const entry of fs.readdirSync(output, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || entry.name === 'manifest.json') continue;
  const file = path.join(entry.parentPath, entry.name); hashes[path.relative(output, file)] = await checksum(file);
}
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ gstreamer: version, protocol: 1, platform, arch, plugins, hashes }, null, 2));
console.log(`Bundled GStreamer ${version} helper and ${Object.keys(hashes).length} verified runtime files.`);
