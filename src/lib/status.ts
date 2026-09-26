import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import { DATA_DIR, getDb, repoDir } from './db.ts';
import { cached, invalidate } from './cache.ts';
import { TARGETS, type Target } from './targets.ts';

const run = promisify(execFile);
const TICK_MS = 60_000;
const HISTORY_DAYS = 7;

/** Changes on every server (re)start. The SSE client compares it across
 *  reconnects and reloads the page once — so dashboards left open for days
 *  pick up new code right after a deploy instead of running stale bundles. */
export const BOOT_ID = crypto.randomUUID();
const BOOTED_AT = new Date().toISOString();

/** The stamp when no build passes PUBLIC_APP_BUILD: the package version. */
const VERSION = (() => {
  try {
    return `v${(JSON.parse(fs.readFileSync(repoDir('package.json'), 'utf8')) as { version: string }).version}`;
  } catch {
    return 'dev';
  }
})();

/** The build actually running, per SSE send (rss is live). import.meta.env is
 *  guarded: tests import this file under plain Node, which has none. */
export function buildInfo(): { stamp: string; bootedAt: string; node: string; rssMb: number } {
  return {
    stamp: (import.meta as { env?: Record<string, string> }).env?.PUBLIC_APP_BUILD ?? process.env.PUBLIC_APP_BUILD ?? VERSION,
    bootedAt: BOOTED_AT,
    node: process.version,
    rssMb: Math.round(process.memoryUsage.rss() / 1048576),
  };
}

export interface ServiceStatus {
  id: string;
  label: string;
  group: string;
  kind: Target['kind'];
  /** true up · false down · null probe itself failed */
  ok: boolean | null;
  latencyMs: number | null;
  detail: string;
  /** ISO time of the last observed state change (since boot). */
  since: string | null;
  /** pm2 kinds only. memMb summed across cluster instances; limitMb from
   *  pm2_env.max_memory_restart (absent = no limit set). */
  cpu?: number;
  memMb?: number;
  restarts?: number;
  limitMb?: number;
}

export interface HostStats {
  disk: { usedPct: number; freeGb: number };
  mem: { usedPct: number };
  /** 1/5/15-minute load averages; null on Windows, which has none. */
  load: number[] | null;
  cores: number;
}

export interface Snapshot {
  at: string;
  host: HostStats;
  alerts: string[];
  services: ServiceStatus[];
  /** The first tick's time: every `since` equal to it is "since boot", not a real change. */
  baselineAt: string;
}

// ------------------------------------------------------------- collectors

async function probeHttp(t: Extract<Target, { kind: 'http' }>): Promise<Pick<ServiceStatus, 'ok' | 'latencyMs' | 'detail'>> {
  const start = performance.now();
  try {
    const res = await fetch(t.url, {
      method: t.method ?? 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'rimeward-status/1' },
    });
    const ms = Math.round(performance.now() - start);
    const ok = t.expect ? t.expect.includes(res.status) : res.status < 400;
    return { ok, latencyMs: ms, detail: `HTTP ${res.status}` };
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    const name = (err as Error).name === 'TimeoutError' ? 'timeout' : ((err as Error & { cause?: { code?: string } }).cause?.code ?? (err as Error).message);
    return { ok: false, latencyMs: ms, detail: String(name) };
  }
}

function probeTcp(t: Extract<Target, { kind: 'tcp' }>): Promise<Pick<ServiceStatus, 'ok' | 'latencyMs' | 'detail'>> {
  return new Promise((resolve) => {
    const start = performance.now();
    const sock = net.connect({ host: t.host, port: t.port, timeout: 5_000 });
    const done = (ok: boolean, detail: string) => {
      sock.destroy();
      resolve({ ok, latencyMs: Math.round(performance.now() - start), detail });
    };
    sock.once('connect', () => done(true, 'tcp open'));
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (err) => done(false, (err as NodeJS.ErrnoException).code ?? 'error'));
  });
}

export interface Pm2Proc {
  name: string;
  pm2_env?: { status?: string; restart_time?: number; max_memory_restart?: number | string };
  monit?: { cpu?: number; memory?: number };
}

export interface Pm2Summary {
  status: string;
  restarts: number;
  cpu: number;
  memMb: number;
  limitMb?: number;
}

/** One row per process name. Cluster apps appear once per instance: any online
 *  instance counts, cpu/memory/restarts summed. Exported for tests.
 *  ponytail: cluster mem summed, limit is per instance — Math.max if a cluster app ever appears. */
export function summarizePm2(procs: Pm2Proc[]): Map<string, Pm2Summary> {
  const map = new Map<string, Pm2Summary>();
  for (const p of procs) {
    const prev = map.get(p.name);
    const status = p.pm2_env?.status ?? 'unknown';
    const limit = p.pm2_env?.max_memory_restart;
    map.set(p.name, {
      status: prev?.status === 'online' ? 'online' : status,
      restarts: (prev?.restarts ?? 0) + (p.pm2_env?.restart_time ?? 0),
      cpu: (prev?.cpu ?? 0) + (p.monit?.cpu ?? 0),
      memMb: (prev?.memMb ?? 0) + Math.round((p.monit?.memory ?? 0) / 2 ** 20),
      // pm2 may report the limit as a string ("512M"); only a byte count is trusted.
      ...(typeof limit === 'number' ? { limitMb: Math.round(limit / 2 ** 20) } : prev?.limitMb !== undefined ? { limitMb: prev.limitMb } : {}),
    });
  }
  return map;
}

/** null = the tool errored (unreachable); 'missing' = not installed on this host. */
type Read<T> = T | null | 'missing';
const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

async function readPm2(): Promise<Read<Map<string, Pm2Summary>>> {
  try {
    const { stdout } = await run(process.env.PM2_BIN ?? 'pm2', ['jlist'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
    return summarizePm2(JSON.parse(stdout.slice(stdout.indexOf('['))) as Pm2Proc[]);
  } catch (err) {
    return missing(err) ? 'missing' : null;
  }
}

async function readDocker(): Promise<Read<Map<string, string>>> {
  try {
    const { stdout } = await run(process.env.DOCKER_BIN ?? 'docker', ['ps', '--format', '{{.Names}}\t{{.Status}}'], { timeout: 15_000 });
    return new Map(
      stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, ...rest] = line.split('\t');
          return [name!, rest.join(' ')] as const;
        })
    );
  } catch (err) {
    return missing(err) ? 'missing' : null;
  }
}

async function readSystemd(units: string[]): Promise<Read<Map<string, string>>> {
  if (units.length === 0) return new Map();
  try {
    // is-active exits non-zero when any unit is inactive — the output is still
    // one state per line, index-aligned with the unit list.
    const result = await run(process.env.SYSTEMCTL_BIN ?? 'systemctl', ['is-active', ...units], { timeout: 15_000 }).catch(
      (err: Error & { stdout?: string; code?: unknown }) => {
        if (missing(err)) throw err;
        return { stdout: err.stdout ?? '' };
      }
    );
    const lines = result.stdout.trim().split('\n');
    if (lines.length !== units.length) return null;
    return new Map(units.map((u, i) => [u, lines[i]!.trim()]));
  } catch (err) {
    return missing(err) ? 'missing' : null;
  }
}

async function readHost(): Promise<HostStats> {
  let disk = { usedPct: 0, freeGb: 0 };
  try {
    // The data directory's filesystem, not "/": in a container the root is the
    // wrong disk, and the database is what fills up.
    const s = fs.statfsSync(DATA_DIR);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    disk = { usedPct: Math.round(((total - free) / total) * 100), freeGb: Math.round((free / 1e9) * 10) / 10 };
  } catch {}
  let available = os.freemem();
  try {
    // Linux: MemAvailable is the honest number (freemem excludes reclaimable cache).
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = meminfo.match(/^MemAvailable:\s+(\d+) kB/m);
    if (m) available = Number(m[1]) * 1024;
  } catch {}
  let usedPct = Math.round(((os.totalmem() - available) / os.totalmem()) * 100);
  if (process.platform === 'darwin') {
    // macOS: freemem excludes the cache the kernel reclaims at will, so an idle
    // Mac read ~90% ("High" on the desktop's first dashboard). The kernel's
    // memory-pressure level is the percentage it considers available.
    const level = Number((await run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level']).catch(() => ({ stdout: '' }))).stdout);
    if (level > 0 && level <= 100) usedPct = 100 - level;
  }
  return {
    disk,
    mem: { usedPct },
    load: process.platform === 'win32' ? null : os.loadavg().map((l) => Math.round(l * 100) / 100),
    cores: os.cpus().length,
  };
}

// ------------------------------------------------------------ tick engine

let snapshot: Snapshot | null = null;
let baselineAt: string | null = null;
const sinceMap = new Map<string, { ok: boolean | null; since: string }>();
type Subscriber = (snap: Snapshot) => void;
const subscribers = new Set<Subscriber>();

async function tick(): Promise<void> {
  const pm2Targets = TARGETS.filter((t) => t.kind === 'pm2');
  const dockerTargets = TARGETS.filter((t) => t.kind === 'docker');
  const systemdTargets = TARGETS.filter((t) => t.kind === 'systemd');

  const [pm2Map, dockerMap, systemdMap, ...probes] = await Promise.all([
    pm2Targets.length ? readPm2() : Promise.resolve(new Map()),
    dockerTargets.length ? readDocker() : Promise.resolve(new Map()),
    readSystemd(systemdTargets.map((t) => (t as Extract<Target, { kind: 'systemd' }>).unit)),
    ...TARGETS.filter((t) => t.kind === 'http' || t.kind === 'tcp').map(async (t) => ({
      id: t.id,
      result: t.kind === 'http' ? await probeHttp(t) : await probeTcp(t as Extract<Target, { kind: 'tcp' }>),
    })),
  ]);

  const probeById = new Map(probes.map((p) => [p.id, p.result]));
  const now = new Date().toISOString();
  baselineAt ??= now;

  const services: ServiceStatus[] = TARGETS.map((t) => {
    let r: Pick<ServiceStatus, 'ok' | 'latencyMs' | 'detail' | 'cpu' | 'memMb' | 'restarts' | 'limitMb'>;
    if (t.kind === 'http' || t.kind === 'tcp') {
      r = probeById.get(t.id)!;
    } else if (t.kind === 'pm2') {
      const p = pm2Map instanceof Map ? pm2Map.get(t.name) : undefined;
      // detail is unchanged, so status_history rows stay byte-identical; the
      // typed extras ride the snapshot only.
      r = !(pm2Map instanceof Map)
        ? { ok: null, latencyMs: null, detail: pm2Map === 'missing' ? 'pm2 not installed' : 'pm2 unreachable' }
        : p
          ? { ok: p.status === 'online', latencyMs: null, detail: `${p.status}, ↺${p.restarts}`, cpu: p.cpu, memMb: p.memMb, restarts: p.restarts, ...(p.limitMb !== undefined ? { limitMb: p.limitMb } : {}) }
          : { ok: false, latencyMs: null, detail: 'not in pm2 list' };
    } else if (t.kind === 'docker') {
      const s = dockerMap instanceof Map ? dockerMap.get(t.container) : undefined;
      r = !(dockerMap instanceof Map)
        ? { ok: null, latencyMs: null, detail: dockerMap === 'missing' ? 'docker not installed' : 'docker unreachable' }
        : s
          ? { ok: s.startsWith('Up'), latencyMs: null, detail: s }
          : { ok: false, latencyMs: null, detail: 'not running' };
    } else {
      const s = systemdMap instanceof Map ? systemdMap.get(t.unit) : undefined;
      r = !(systemdMap instanceof Map)
        ? { ok: null, latencyMs: null, detail: systemdMap === 'missing' ? 'systemctl not installed' : 'systemctl unreachable' }
        : { ok: s === 'active', latencyMs: null, detail: s ?? 'unknown' };
    }

    const prev = sinceMap.get(t.id);
    if (!prev || prev.ok !== r.ok) sinceMap.set(t.id, { ok: r.ok, since: now });
    return { id: t.id, label: t.label, group: t.group, kind: t.kind, ...r, since: sinceMap.get(t.id)!.since };
  });

  const host = await readHost();
  // Host-level only. "N services down" is built on the CLIENT, which is the
  // only side that knows which services this user's dashboard shows —
  // see shownServiceIds + renderAlerts (scripts/app/status.ts).
  const alerts: string[] = [];
  if (host.disk.usedPct >= 90) alerts.push(`disk ${host.disk.usedPct}% used (${host.disk.freeGb} GB free)`);
  if (host.load && host.load[0]! > host.cores * 2) alerts.push(`load ${host.load[0]} on ${host.cores} cores`);

  snapshot = { at: now, host, alerts, services, baselineAt };

  // History rows + prune, one transaction per tick. Host metrics ride along
  // as pseudo-services (integer percent in latency_ms) so charts can read
  // them through the same table/endpoint.
  // ponytail: host metrics ride status_history; split into own table if schema diverges
  try {
    const db = getDb();
    const ins = db.prepare('INSERT INTO status_history (service, ok, latency_ms, detail) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (const s of services) ins.run(s.id, s.ok === null ? null : s.ok ? 1 : 0, s.latencyMs, s.detail);
      ins.run('host:cpu', 1, Math.round(((host.load?.[0] ?? 0) / host.cores) * 100), '');
      ins.run('host:mem', 1, host.mem.usedPct, '');
      ins.run('host:disk', 1, host.disk.usedPct, '');
      db.prepare(`DELETE FROM status_history WHERE checked_at < datetime('now', '-${HISTORY_DAYS} days')`).run();
    })();
  } catch (err) {
    console.error('[status] history write failed:', err);
  }
  invalidate('incidents:'); // exactly one scan per tick, never stale

  for (const fn of subscribers) {
    try {
      fn(snapshot);
    } catch {}
  }
}

/** Idempotent: middleware imports this module, dev HMR must not double-start. */
export function ensureStatusEngine(): void {
  const g = globalThis as { __fdStatusTick?: ReturnType<typeof setInterval> };
  if (g.__fdStatusTick) return;
  g.__fdStatusTick = setInterval(() => void tick().catch((e) => console.error('[status] tick failed:', e)), TICK_MS);
  void tick().catch((e) => console.error('[status] first tick failed:', e));
}

export function getSnapshot(): Snapshot | null {
  return snapshot;
}

/** cpu = 1-min load ÷ cores as a percent — the same number status_history
 *  stores as host:cpu. Shared by the logic engine's host condition + watcher. */
export function hostPct(host: HostStats, metric: string): number {
  return metric === 'cpu' ? ((host.load?.[0] ?? 0) / host.cores) * 100 : metric === 'mem' ? host.mem.usedPct : host.disk.usedPct;
}

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export interface Incident {
  service: string;
  down: string;
  up: string | null;
}

/** Down→up spans in the last `hours` from status_history. One pass over the
 *  (service, checked_at) index; LAG drops every non-transition row. Probe
 *  failures (ok NULL) are not transitions. Open spans first, then newest.
 *  ponytail: an outage that began before the window prints the window start; add `partial` when someone asks. */
export function queryIncidents(hours = 24): Incident[] {
  const rows = getDb()
    .prepare(
      `WITH h AS (
         SELECT service, ok, strftime('%Y-%m-%dT%H:%M:%SZ', checked_at) AS t,
                LAG(ok) OVER (PARTITION BY service ORDER BY checked_at) AS prev
         FROM status_history
         WHERE ok IS NOT NULL AND service NOT LIKE 'host:%' AND checked_at > datetime('now', ?)
       ) SELECT service, ok, t FROM h WHERE prev IS NULL OR prev <> ok ORDER BY service, t`
    )
    .all(`-${Math.min(Math.max(hours, 1), 24 * 7)} hours`) as { service: string; ok: number; t: string }[];
  const out: Incident[] = [];
  const open = new Map<string, string>();
  for (const r of rows) {
    if (r.ok === 0) {
      if (!open.has(r.service)) open.set(r.service, r.t); // first row in window down = down at window start
    } else {
      const d = open.get(r.service);
      if (d) {
        out.push({ service: r.service, down: d, up: r.t });
        open.delete(r.service);
      }
    }
  }
  for (const [service, down] of open) out.push({ service, down, up: null });
  const upAt = (s: Incident) => (s.up ? Date.parse(s.up) : Infinity); // open spans first, then newest
  return out.sort((a, b) => upAt(b) - upAt(a) || Date.parse(b.down) - Date.parse(a.down));
}

export const recentIncidents = (): Promise<Incident[]> => cached('incidents:24', 60_000, async () => queryIncidents());

export function getHistory(service: string, hours: number): { t: string; ok: number | null; ms: number | null }[] {
  // DESC + reverse: when the window holds more than the cap, keep the NEWEST
  // rows — an ascending LIMIT would silently drop the recent end.
  return (
    getDb()
      .prepare(
        `SELECT checked_at AS t, ok, latency_ms AS ms FROM status_history
          WHERE service = ? AND checked_at > datetime('now', ?)
          ORDER BY checked_at DESC LIMIT 2000`
      )
      .all(service, `-${Math.min(Math.max(hours, 1), 24 * 7)} hours`) as { t: string; ok: number | null; ms: number | null }[]
  ).reverse();
}
