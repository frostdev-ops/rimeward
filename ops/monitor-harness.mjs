// Terminal-monitor harness: record the exact PTY output of a real Claude Code / Codex / shell
// session, then replay it through the real monitor pipeline (node-pty ingestion → headless
// xterm → renderedLines → connectMonitorSource) and print every observation a monitor on
// that session delivers. Nothing here changes what the monitor filters; it shows it.
//
//   node ops/monitor-harness.mjs record <out.jsonl> [--kind claude|codex|shell] [--cmd program] [-- args…]
//   node ops/monitor-harness.mjs replay <in.jsonl> [--speed N | --fast] [--json] [--kind claude|codex|shell]
//
// record: your terminal is proxied to the CLI (same launch flags as a Rimeward terminal ward),
// so interact normally and exit it as usual. The file keeps the terminal size, every output chunk
// with its delay, resizes and the exit. Nothing is sent anywhere; the CLI talks to its own account.
// replay: uses an isolated data directory and never runs the CLI (node-pty's spawn is replaced by
// a player), but the CLI must still be installed because the session is created with its kind —
// that kind is what turns the CLI chrome filter on. Delays are real time by default: the monitor
// dedupes against a 5 s on-screen window and flushes after 300 ms / 2 s, so --fast or --speed
// change how observations coalesce, not which rows are content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const [mode, file, ...rest] = process.argv.slice(2);
const opts = {}, extra = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--') { extra.push(...rest.slice(i + 1)); break; }
  if (a === '--fast' || a === '--json') opts[a.slice(2)] = true;
  else if (a.startsWith('--')) opts[a.slice(2)] = rest[++i];
  else extra.push(a);
}
const usage = () => { console.error('Usage:\n  node ops/monitor-harness.mjs record <out.jsonl> [--kind claude|codex|shell] [--cmd program] [-- args…]\n  node ops/monitor-harness.mjs replay <in.jsonl> [--speed N | --fast] [--json] [--kind claude|codex|shell]'); process.exit(2); };
if (!file || !['record', 'replay'].includes(mode)) usage();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function record() {
  const pty = require('node-pty');
  const kind = opts.kind ?? 'claude';
  if (!['claude', 'codex', 'shell'].includes(kind)) usage();
  const program = opts.cmd ?? (kind === 'shell' ? process.env.SHELL || '/bin/sh' : kind);
  // The flags a Rimeward terminal ward launches with in human mode (terminals.ts cliArgs).
  const args = extra.length ? extra : kind === 'codex' ? ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write'] : kind === 'claude' ? ['--permission-mode', 'default'] : [];
  const cols = process.stdout.columns ?? 100, rows = process.stdout.rows ?? 30;
  const out = fs.createWriteStream(file);
  const started = Date.now();
  const line = o => out.write(JSON.stringify(o) + '\n');
  line({ v: 1, kind, program, args, cols, rows, platform: process.platform, started: new Date(started).toISOString() });
  const child = pty.spawn(program, args, { name: 'xterm-256color', cols, rows, cwd: process.cwd(), env: process.env });
  let chunks = 0, bytes = 0;
  child.onData(data => { chunks++; bytes += Buffer.byteLength(data); process.stdout.write(data); line({ t: Date.now() - started, data }); });
  const tty = !!process.stdin.isTTY;
  if (tty) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', d => child.write(d.toString('utf8')));
  process.stdout.on('resize', () => { const c = process.stdout.columns, r = process.stdout.rows; child.resize(c, r); line({ t: Date.now() - started, resize: [c, r] }); });
  const exit = await new Promise(resolve => child.onExit(e => { line({ t: Date.now() - started, exit: e.exitCode, signal: e.signal }); out.end(() => resolve(e)); }));
  if (tty) process.stdin.setRawMode(false);
  process.stdin.pause();
  console.log(`\r\n[monitor-harness] recorded ${chunks} chunks, ${bytes} bytes, ${cols}×${rows}, exit ${exit.exitCode} → ${file}`);
  process.exit(0);
}

async function replay() {
  const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const head = records.shift();
  if (head?.v !== 1) throw Error('Not a monitor-harness recording (missing header).');
  const kind = opts.kind ?? head.kind;
  const speed = opts.fast ? Infinity : Number(opts.speed ?? 1);
  if (!(speed > 0)) usage();
  // Isolated runtime: its own data directory and workspaces.db, desktop flags on, no real PTY.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-monitor-harness-')), project = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-monitor-project-'));
  process.env.HOMEPAGE_DATA_DIR = data;
  process.env.TOKEN_ENC_KEY = crypto.randomBytes(32).toString('base64');
  process.env.RIMEWARD_DESKTOP = '1';
  process.env.RIMEWARD_NATIVE_TOKEN ||= 'monitor-harness';
  let output, exited, ended = false;
  const pty = require('node-pty');
  pty.spawn = () => ({ pid: 0, process: 'monitor-harness', onData: fn => { output = fn; }, onExit: fn => { exited = fn; },
    kill() { if (!ended) { ended = true; exited?.({ exitCode: 0, signal: 0 }); } }, pause() {}, resume() {}, resize() {}, write() {} });
  const { addProject } = await import('../src/lib/dev/projects.ts');
  const { startSession, resizeSession, shutdownTerminals } = await import('../src/lib/dev/terminals.ts');
  const { connectMonitorSource } = await import('../src/lib/agent/monitor-sources.ts');
  const user = 1, t0 = Date.now();
  let events = 0;
  try {
    const p = addProject(user, project);
    const session = await startSession(user, { project: p.id, kind, cols: head.cols, rows: head.rows, title: 'monitor harness' });
    const print = (key, d, baseline) => {
      events++;
      if (opts.json) { console.log(JSON.stringify({ at: Date.now() - t0, key, baseline: !!baseline, ...d })); return; }
      const label = d.eventType === 'output' ? `output #${d.sequence}${d.pages ? ` page ${d.page}/${d.pages}` : ''}`
        : d.eventType === 'session' ? `session ${d.status}${d.exitCode == null ? '' : ` exit ${d.exitCode}`}`
        : `${d.eventType}${baseline ? ' (baseline)' : ''}${d.status ? ` ${d.status}` : ''}`;
      console.log(`── ${String(Date.now() - t0).padStart(7)} ms  ${label}`);
      if (typeof d.text === 'string') console.log(d.text);
    };
    const stop = await connectMonitorSource(user, { type: 'terminal', target: session.id }, print, error => console.error(`[monitor offline] ${error}`));
    let clock = 0;
    for (const r of records) {
      const wait = speed === Infinity ? 0 : Math.max(0, r.t - clock) / speed;
      clock = r.t;
      if (wait) await sleep(wait);
      if (r.data !== undefined) output(r.data);
      else if (r.resize) resizeSession(user, session.id, 'monitor-harness', r.resize[0], r.resize[1]);
      else if (r.exit !== undefined && !ended) { ended = true; exited({ exitCode: r.exit ?? 0, signal: r.signal ?? 0 }); }
    }
    if (!ended) { ended = true; exited({ exitCode: 0, signal: 0 }); }
    await sleep(2500); // past the monitor's trailing 2 s flush window
    stop();
    await shutdownTerminals();
    console.log(`\n[monitor-harness] ${events} monitor events from ${records.length} records (${kind}, ${head.cols}×${head.rows}, ${speed === Infinity ? 'max' : `${speed}×`} speed)`);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
  process.exit(0);
}

await (mode === 'record' ? record() : replay());
