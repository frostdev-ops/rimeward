import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { terminalEnv } from './environment.ts';

const exec = promisify(execFile);
type Process = { pid: number; parent: number; seconds: number; memory: number; cpu: number | null };
let processes = new Map<number, Process>(), sampledAt = 0;
let pending: Promise<void> | undefined;

async function sample() {
  const windows = process.platform === 'win32';
  // Numeric process counters only; never collect command lines or environment variables.
  const { stdout } = await exec(windows ? 'powershell.exe' : '/bin/ps', windows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,UserModeTime,KernelModeTime,WorkingSetSize | ConvertTo-Json -Compress']
    : ['-axo', 'pid=,ppid=,time=,rss='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...terminalEnv(), LC_ALL: 'C' } });
  const at = performance.now(), elapsed = (at - sampledAt) / 1000;
  const next = new Map<number, Process>();
  const add = (pid: number, parent: number, seconds: number, memory: number) => {
    if (![pid, parent, seconds, memory].every(Number.isFinite) || pid < 1 || seconds < 0 || memory < 0) return;
    const previous = processes.get(pid);
    const cpu = previous && previous.parent === parent && elapsed > 0 && elapsed < 10 && seconds >= previous.seconds
      ? (seconds - previous.seconds) / elapsed * 100 : null;
    next.set(pid, { pid, parent, seconds, memory, cpu });
  };
  if (windows) {
    const rows = JSON.parse(stdout || '[]');
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (row.UserModeTime == null || row.KernelModeTime == null || row.WorkingSetSize == null) continue;
      add(Number(row.ProcessId), Number(row.ParentProcessId), (Number(row.UserModeTime) + Number(row.KernelModeTime)) / 1e7, Number(row.WorkingSetSize));
    }
  } else {
    for (const line of stdout.trim().split('\n')) {
      const [pid, parent, time, rss] = line.trim().split(/\s+/);
      if (!time) continue;
      const [days, clock] = time.includes('-') ? time.split('-') : ['0', time];
      const seconds = Number(days) * 86400 + clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);
      add(Number(pid), Number(parent), seconds, Number(rss) * 1024);
    }
  }
  if (!next.size) throw new Error('Process counters unavailable.');
  processes = next; sampledAt = at;
}

/** One shared OS sample per second; return only each requested process and its descendants. */
export async function processUsage(roots: number[]) {
  if (!pending && (!sampledAt || performance.now() - sampledAt >= 1000))
    pending = sample().finally(() => { pending = undefined; });
  await pending;
  const children = new Map<number, number[]>();
  for (const p of processes.values()) {
    const siblings = children.get(p.parent) ?? [];
    siblings.push(p.pid); children.set(p.parent, siblings);
  }
  return new Map(roots.map(pid => {
    const root = processes.get(pid);
    if (!root) return [pid, null] as const;
    const seen = new Set<number>(), queue = [pid];
    let cpu = 0, memory = 0;
    for (const id of queue) {
      if (seen.has(id)) continue;
      seen.add(id);
      const p = processes.get(id);
      if (!p) continue;
      cpu += p.cpu ?? 0; memory += p.memory;
      queue.push(...children.get(id) ?? []);
    }
    return [pid, { cpuPercent: root.cpu === null ? null : Math.round(cpu * 10) / 10, memoryBytes: memory }] as const;
  }));
}
