// Updates: release discovery for both apps, the server's self-update, and the
// policy behind them. Releases live on GitHub — the server's tagged `vX.Y.Z`
// (a prebuilt tarball + SHA256SUMS + a ghcr image), the desktop's
// `desktop-vX.Y.Z` (installers + the signed updater manifest latest.json).
// One lookup per instance every 6 h is cached in a settings row and shared by
// the header chip, the `update-available` leyline trigger, the CLI and the
// desktop app — which asks its bundled runtime (/api/update/desktop), never
// GitHub, so a fleet of desktops costs one API call per runtime.
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { DATA_DIR, repoDir } from './db.ts';
import { getSetting, setSetting } from './settings.ts';

export const REPO = 'frostdev-ops/rimeward';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const IMAGE = `ghcr.io/${REPO}`;
/** The GitHub releases API; tests point it at a local server. */
const API = () => process.env.RIMEWARD_UPDATE_API ?? `https://api.github.com/repos/${REPO}/releases`;
const CACHE_KEY = 'update:releases';
const POLICY_KEY = 'update:auto';
const TTL_MS = 6 * 3600_000;
const ROOT = path.dirname(repoDir('package.json'));

export const SERVER_VERSION: string = (() => {
  try {
    return (JSON.parse(fs.readFileSync(repoDir('package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();
/** The desktop app's version, when this runtime is one's (desktop-runtime.mjs sets it). */
export const desktopVersion = (): string | null => process.env.RIMEWARD_DESKTOP_VERSION || null;

export type InstallKind = 'desktop' | 'docker' | 'node';
/** How this instance was installed — which update path applies. */
export function installKind(): InstallKind {
  if (process.env.RIMEWARD_DESKTOP === '1') return 'desktop';
  if (process.env.RIMEWARD_INSTALL === 'docker' || fs.existsSync('/.dockerenv')) return 'docker';
  return 'node';
}

export interface Release {
  version: string;
  tag: string;
  url: string;
  notes: string;
  publishedAt: string;
  /** asset name → download URL */
  assets: Record<string, string>;
}
export interface Releases {
  checkedAt: number;
  server: Release | null;
  desktop: Release | null;
  /** The last refresh failed; server/desktop are the previous answer. */
  error?: string;
}

/** Numeric semver compare (a leading v is fine); a pre-release sorts below its release. */
export function cmpVersion(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i]! - y.n[i]!;
  if (!x.pre !== !y.pre) return x.pre ? -1 : 1;
  return x.pre < y.pre ? -1 : x.pre > y.pre ? 1 : 0;
}
export const newer = (latest: string | null | undefined, current: string | null | undefined): boolean =>
  !!latest && !!current && cmpVersion(latest, current) > 0;

/** GitHub's release list → the newest PUBLISHED server and desktop release. Pure. */
export function pickReleases(list: unknown, checkedAt = Date.now()): Releases {
  const out: Releases = { checkedAt, server: null, desktop: null };
  if (!Array.isArray(list)) return out;
  for (const r of list as Record<string, unknown>[]) {
    if (!r || r.draft || r.prerelease || typeof r.tag_name !== 'string') continue;
    const m = /^(desktop-)?v(\d+\.\d+\.\d+)$/.exec(r.tag_name);
    if (!m) continue;
    const kind = m[1] ? 'desktop' : 'server';
    if (out[kind] && cmpVersion(out[kind].version, m[2]!) >= 0) continue;
    const assets: Record<string, string> = {};
    for (const a of Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : [])
      if (typeof a?.name === 'string' && typeof a.browser_download_url === 'string') assets[a.name] = a.browser_download_url;
    out[kind] = {
      version: m[2]!,
      tag: r.tag_name,
      url: typeof r.html_url === 'string' ? r.html_url : `${RELEASES_URL}/tag/${r.tag_name}`,
      notes: String(r.body ?? '').slice(0, 4000),
      publishedAt: typeof r.published_at === 'string' ? r.published_at : '',
      assets,
    };
  }
  return out;
}

type Fetch = typeof fetch;
const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': `rimeward/${SERVER_VERSION}` };
async function fetchJson(url: string, fetchImpl: Fetch): Promise<unknown> {
  const r = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
  return r.json();
}

export function cachedReleases(): Releases | null {
  try {
    const raw = getSetting(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Releases) : null;
  } catch {
    return null;
  }
}
let inflight: Promise<Releases> | null = null;
/** The cached lookup, refreshed after its TTL or on demand (single-flight). A
 *  failed refresh keeps the last good answer, stamps the attempt and records why —
 *  so an outage costs one request per TTL, not one per dashboard load. */
export async function latestReleases(opts: { refresh?: boolean; fetchImpl?: Fetch } = {}): Promise<Releases> {
  const cached = cachedReleases();
  if (cached && !opts.refresh && Date.now() - cached.checkedAt < TTL_MS) return cached;
  inflight ??= fetchJson(`${API()}?per_page=30`, opts.fetchImpl ?? fetch)
    .then((list) => pickReleases(list))
    .catch((e: Error) => ({ server: null, desktop: null, ...cached, checkedAt: Date.now(), error: e.message }) as Releases)
    .then((r) => {
      setSetting(CACHE_KEY, JSON.stringify(r));
      return r;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// ---------------------------------------------------------------- policy
export type Policy = 'off' | 'notify' | 'install';
export const POLICIES: readonly Policy[] = ['off', 'notify', 'install'];
export function updatePolicy(): Policy {
  const v = getSetting(POLICY_KEY);
  return POLICIES.includes(v as Policy) ? (v as Policy) : 'notify';
}
export function setUpdatePolicy(p: string): Policy {
  if (!POLICIES.includes(p as Policy)) throw new Error('policy must be off, notify or install');
  setSetting(POLICY_KEY, p);
  return p as Policy;
}

// ----------------------------------------------------------------- state
export interface AppUpdate {
  current: string;
  latest: string | null;
  available: boolean;
  url: string | null;
  notes: string;
  publishedAt: string;
}
export interface Job {
  version: string;
  startedAt: number;
  done?: number;
  error?: string;
  log: string[];
}
export interface UpdateState {
  install: InstallKind;
  policy: Policy;
  checkedAt: number;
  error?: string;
  /** null on a desktop's runtime — its server is replaced with the app. */
  server: AppUpdate | null;
  /** only on a desktop's runtime */
  desktop: AppUpdate | null;
  job: Job | null;
  /** the version `.update/prev` holds — what a rollback returns to */
  previous: string | null;
  image: string;
}
const appUpdate = (rel: Release | null, current: string): AppUpdate => ({
  current,
  latest: rel?.version ?? null,
  available: newer(rel?.version, current),
  url: rel?.url ?? null,
  notes: rel?.notes ?? '',
  publishedAt: rel?.publishedAt ?? '',
});
export async function updateState(opts: { refresh?: boolean } = {}): Promise<UpdateState> {
  const r = await latestReleases(opts);
  const kind = installKind();
  const dv = desktopVersion();
  return {
    install: kind,
    policy: updatePolicy(),
    checkedAt: r.checkedAt,
    error: r.error,
    server: kind === 'desktop' ? null : appUpdate(r.server, SERVER_VERSION),
    desktop: dv ? appUpdate(r.desktop, dv) : null,
    job,
    previous: installed()?.previous ?? null,
    image: IMAGE,
  };
}

// --------------------------------------------------------------- install
const run = promisify(execFile);
/** What a release replaces at the checkout root (the tarball's entries plus the
 *  node_modules the stage installs). data/, .env and .update/ are never touched. */
export const SHIPPED = [
  'dist', 'src', 'public', 'migrations', 'assets', 'bin', 'ops', 'node_modules',
  'package.json', 'package-lock.json', 'server.mjs', 'ecosystem.config.cjs', 'astro.config.mjs', 'tsconfig.json', 'compose.yaml', 'Dockerfile',
];
const WORK = path.join(ROOT, '.update');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Replace `names` under root with the stage's copies, parking what was there
 *  in `prev` (an entry the new release dropped goes there too). Renames only,
 *  so the live tree is inconsistent for milliseconds, not for an npm ci.
 *  Returns the names that changed. Exported for tests. */
export function swapTree(root: string, stage: string, prev: string, names: readonly string[]): string[] {
  fs.mkdirSync(prev, { recursive: true });
  const moved: string[] = [];
  for (const name of names) {
    const live = path.join(root, name), fresh = path.join(stage, name), park = path.join(prev, name);
    const had = fs.existsSync(live), has = fs.existsSync(fresh);
    if (!had && !has) continue;
    if (had) {
      fs.rmSync(park, { recursive: true, force: true });
      fs.renameSync(live, park);
    }
    if (has) fs.renameSync(fresh, live);
    moved.push(name);
  }
  return moved;
}

interface Installed { version: string; previous: string; at: string; moved: string[] }
const installed = (): Installed | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(WORK, 'installed.json'), 'utf8')) as Installed;
  } catch {
    return null;
  }
};

async function sha256(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}
/** Download to `dest` unless a copy with the expected digest is already there (the cache). */
async function download(url: string, dest: string, expected: string, fetchImpl: Fetch): Promise<boolean> {
  if (fs.existsSync(dest) && (await sha256(dest)) === expected) return true;
  const part = `${dest}.part`;
  const r = await fetchImpl(url, { headers: { 'user-agent': HEADERS['user-agent'] }, signal: AbortSignal.timeout(600_000) });
  if (!r.ok || !r.body) throw new Error(`download failed: HTTP ${r.status}`);
  await pipeline(r.body as unknown as NodeJS.ReadableStream, fs.createWriteStream(part));
  if ((await sha256(part)) !== expected) {
    fs.rmSync(part, { force: true });
    throw new Error('download checksum mismatch');
  }
  fs.renameSync(part, dest);
  return false;
}

function refuseUnlessNode(): void {
  const kind = installKind();
  if (kind === 'docker') throw new Error(`a Docker install updates by pulling the image: docker compose pull && docker compose up -d  (${IMAGE})`);
  if (kind === 'desktop') throw new Error('the desktop app updates itself from its tray menu');
}

/** Install a server release beside the running checkout, then swap it in.
 *  The archive is kept under data/updates (a re-run is a checksum, not a
 *  download); the replaced tree is kept under .update/prev for `rollbackServer`.
 *  The process keeps running the old code until it is restarted. */
export async function installServerRelease(opts: { version?: string; log?: (line: string) => void; fetchImpl?: Fetch } = {}): Promise<{ version: string; cached: boolean }> {
  refuseUnlessNode();
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? fetch;
  let rel: Release | null;
  if (opts.version) {
    const v = opts.version.replace(/^v/, '');
    rel = pickReleases([await fetchJson(`${API()}/tags/v${v}`, fetchImpl)]).server;
    if (!rel) throw new Error(`v${v} is not a published server release`);
  } else {
    const r = await latestReleases({ refresh: true, fetchImpl });
    rel = r.server;
    if (!rel) throw new Error(r.error ? `could not read releases: ${r.error}` : 'no server release published yet');
    if (!newer(rel.version, SERVER_VERSION)) throw new Error(`already on v${SERVER_VERSION} (latest is v${rel.version})`);
  }
  const name = `rimeward-server-v${rel.version}.tar.gz`;
  const asset = rel.assets[name], sums = rel.assets['SHA256SUMS'];
  if (!asset || !sums) throw new Error(`release v${rel.version} carries no ${name}`);
  const sumsText = await (await fetchImpl(sums, { signal: AbortSignal.timeout(15_000) })).text();
  const expected = sumsText.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === name)?.[0];
  if (!expected) throw new Error(`SHA256SUMS lists no ${name}`);

  const cacheDir = path.join(DATA_DIR, 'updates');
  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, name);
  log(`fetching ${name}`);
  const cached = await download(asset, archive, expected, fetchImpl);
  log(cached ? 'archive cached, checksum ok' : 'downloaded, checksum ok');
  for (const old of fs.readdirSync(cacheDir)) if (old !== name && old.endsWith('.tar.gz')) fs.rmSync(path.join(cacheDir, old), { force: true }); // ponytail: one cached archive, the current one

  const stage = path.join(WORK, 'stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  log('extracting');
  await run('tar', ['-xzf', archive, '-C', stage]);
  if (!fs.existsSync(path.join(stage, 'server.mjs')) || !fs.existsSync(path.join(stage, 'dist'))) throw new Error('archive is not a Rimeward server release');
  log('installing dependencies (npm ci --omit=dev)');
  await run(NPM, ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, env: { ...process.env, NODE_ENV: 'production' }, maxBuffer: 16 * 1024 * 1024 });
  const prev = path.join(WORK, 'prev');
  fs.rmSync(prev, { recursive: true, force: true });
  log('swapping in');
  const moved = swapTree(ROOT, stage, prev, SHIPPED);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.writeFileSync(path.join(WORK, 'installed.json'), JSON.stringify({ version: rel.version, previous: SERVER_VERSION, at: new Date().toISOString(), moved } satisfies Installed));
  log(`installed v${rel.version}`);
  return { version: rel.version, cached };
}

/** Put `.update/prev` back. Returns the version it holds. */
export function rollbackServer(): string {
  refuseUnlessNode();
  const last = installed();
  const prev = path.join(WORK, 'prev');
  if (!last || !fs.existsSync(prev)) throw new Error('nothing to roll back to');
  const trash = path.join(WORK, 'trash');
  fs.rmSync(trash, { recursive: true, force: true });
  swapTree(ROOT, prev, trash, last.moved);
  fs.rmSync(trash, { recursive: true, force: true });
  fs.rmSync(prev, { recursive: true, force: true });
  fs.rmSync(path.join(WORK, 'installed.json'), { force: true });
  return last.previous;
}

/** Hand the restart to the supervisor: RIMEWARD_RESTART_CMD when set (e.g.
 *  `pm2 reload rimeward`), else exit 0 and rely on it restarting the process
 *  (pm2 does; systemd needs Restart=always). */
export function restartServer(): 'command' | 'exit' {
  const cmd = process.env.RIMEWARD_RESTART_CMD;
  if (cmd) {
    spawn(cmd, { shell: true, detached: true, stdio: 'ignore' }).unref();
    return 'command';
  }
  setTimeout(() => process.exit(0), 1000).unref();
  return 'exit';
}

let job: Job | null = null;
/** The in-process install the dashboard's Install button and the `install`
 *  policy start; `updateState().job` is its progress. */
export function startInstall(opts: { version?: string; restart?: boolean } = {}): Job {
  if (job && !job.done) throw new Error(`already installing v${job.version}`);
  refuseUnlessNode();
  const j: Job = { version: opts.version ?? '…', startedAt: Date.now(), log: [] };
  job = j;
  void installServerRelease({ version: opts.version, log: (l) => j.log.push(l) })
    .then(({ version }) => {
      j.version = version;
      if (opts.restart !== false) j.log.push(restartServer() === 'exit' ? 'restarting' : 'restart command started');
    })
    .catch((e: Error) => {
      j.error = e.message;
      j.log.push(`failed: ${e.message}`);
    })
    .finally(() => {
      j.done = Date.now();
    });
  return j;
}

let started = false;
/** The server's periodic check (boot + every 6 h): refresh the cache; under the
 *  `install` policy, install a newer release and restart. Not on a desktop's
 *  runtime — the app runs its own check against the cache. */
export function ensureUpdateChecks(): void {
  if (started || installKind() === 'desktop' || process.env.RIMEWARD_UPDATE_CHECKS === '0') return;
  started = true;
  const tick = async () => {
    if (updatePolicy() === 'off') return;
    const r = await latestReleases({ refresh: true });
    if (updatePolicy() === 'install' && installKind() === 'node' && newer(r.server?.version, SERVER_VERSION) && !(job && !job.done)) {
      console.log(`[updates] installing v${r.server!.version} (policy: install)`);
      startInstall();
    }
  };
  setTimeout(() => void tick(), 90_000).unref();
  setInterval(() => void tick(), TTL_MS).unref();
}
