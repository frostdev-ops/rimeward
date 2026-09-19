// Fetch the MobileCLIP-S0 text tower (Core ML) and the CLIP BPE tokenizer files that the
// Swift helper's `embed` op needs. Everything lands in ~/Library/Caches/rimeward-models
// (override with RIMEWARD_MODELS_CACHE), pinned by upstream revision and verified by
// sha256; nothing is ever written into the repository. `node desktop/models.mjs` fills the
// cache for development and for `npm run helper:test`; `--check` prints the plan and
// writes nothing; prebuild.mjs imports `ensureModels()` and copies the result into the
// bundle. Weights are Apple's MobileCLIP v1 under the Apple Sample Code License; v2 is
// research-only (see research/decision-models.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const NAME = 'mobileclip-s0';
export const LICENSE = 'apple-ascl';
// The Core ML packages Apple publishes, and the tokenizer files from Apple's iOS demo.
export const REVISION = {
  hf: '3e0a7bfb9fe83da8a3efaa3fd8f7df24214bb947',
  github: '48faa0fea4b08d74188b3841771aca6ff2c92852',
};

const pkg = (rel) =>
  `https://huggingface.co/apple/coreml-mobileclip/resolve/${REVISION.hf}/mobileclip_s0_text.mlpackage/${rel}`;
const res = (name) =>
  `https://raw.githubusercontent.com/apple/ml-mobileclip/${REVISION.github}/ios_app/MobileCLIPExplore/Resources/${name}`;

const FILES = [
  {
    rel: 'clip-vocab.json',
    url: res('clip-vocab.json'),
    size: 1197317,
    sha256: '7aeb221a2a93047170070379743b49204c13d6993d9947323cd94b75c1f657ba',
  },
  {
    rel: 'clip-merges.txt',
    url: res('clip-merges.txt'),
    size: 3194958,
    sha256: '7e0847f6fced8bd28a736dcaeab20e64ac19010771700197ba479a0a8e517d4f',
  },
  {
    rel: 'mobileclip_s0_text.mlpackage/Manifest.json',
    url: pkg('Manifest.json'),
    size: 617,
    sha256: 'a7cb0864a627468a953afd107262097ad74a0fcf82e49df7e00b9c86385bb7db',
  },
  {
    rel: 'mobileclip_s0_text.mlpackage/Data/com.apple.CoreML/model.mlmodel',
    url: pkg('Data/com.apple.CoreML/model.mlmodel'),
    size: 57953,
    sha256: '81eba836ff4dbc8ae021d70006288b533ba7eed3c2973d245b0d5ea047305bfd',
  },
  {
    rel: 'mobileclip_s0_text.mlpackage/Data/com.apple.CoreML/weights/weight.bin',
    url: pkg('Data/com.apple.CoreML/weights/weight.bin'),
    size: 84871616,
    sha256: '34723e51445b2630106e94e1fdbebed80e7676b404fb839f4eb9bec97bdcad68',
  },
];

export const cacheDir = () =>
  process.env.RIMEWARD_MODELS_CACHE || path.join(os.homedir(), 'Library/Caches/rimeward-models');

const bytes = (n) => `${n.toLocaleString('en-US')} B`;

const digest = async (file) => {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
};

// Present and byte-identical, or not there at all: a truncated or stale file is refetched.
const good = async (file, want) =>
  fs.existsSync(file) && fs.statSync(file).size === want.size && (await digest(file)) === want.sha256;

const download = async (want, file) => {
  const response = await fetch(want.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${want.url}: HTTP ${response.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(part));
  const found = await digest(part);
  const size = fs.statSync(part).size;
  if (found !== want.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`${want.rel}: sha256 ${found} is not ${want.sha256}`);
  }
  fs.renameSync(part, file);
  return size;
};

// Returns the directory that holds mobileclip-s0/, which is what `--models` names.
export async function ensureModels({ log = console.log } = {}) {
  const root = cacheDir();
  const dir = path.join(root, NAME);
  let fetched = 0;
  for (const want of FILES) {
    const file = path.join(dir, want.rel);
    if (await good(file, want)) {
      log(`  cached   ${want.rel} (${bytes(want.size)})`);
      continue;
    }
    const started = Date.now();
    const size = await download(want, file);
    fetched += 1;
    log(`  fetched  ${want.rel} (${bytes(size)} in ${((Date.now() - started) / 1000).toFixed(1)} s, sha256 ok)`);
  }
  const manifest = path.join(dir, 'manifest.json');
  const written = fetched > 0 || !fs.existsSync(manifest);
  if (written) {
    fs.writeFileSync(
      manifest,
      `${JSON.stringify(
        {
          name: NAME,
          revision: REVISION,
          files: Object.fromEntries(FILES.map((f) => [f.rel, f.sha256])),
          license: LICENSE,
          fetchedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }
  log(`${NAME} in ${dir} (${bytes(FILES.reduce((n, f) => n + f.size, 0))}, ${fetched} fetched, manifest ${written ? 'written' : 'kept'})`);
  return root;
}

export async function checkModels({ log = console.log } = {}) {
  const dir = path.join(cacheDir(), NAME);
  log(`${NAME} cache ${dir} (nothing is written)`);
  for (const want of FILES) {
    const file = path.join(dir, want.rel);
    log(`  ${(await good(file, want)) ? 'cached ' : 'missing'}  ${want.rel} (${bytes(want.size)})`);
  }
  log(`  manifest.json {name, revision, files, license: ${LICENSE}, fetchedAt}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await (process.argv.includes('--check') ? checkModels() : ensureModels());
}
