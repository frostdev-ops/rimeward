import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { DATA_DIR, repoDir } from '../db.ts';
import { processUsage } from '../dev/process-usage.ts';
import { LOCAL_MODELS, QWEN_REVISION, type Quantization } from './embedding-profiles.ts';
import runtimeManifest from './embedding-runtime.json' with { type: 'json' };

const directory = () => path.join(DATA_DIR, 'embedding-models');
// The desktop app bundles llama.cpp under assets/embedding at build time; any other runtime
// (a server) installs the same pinned build into its data directory on demand.
const BINARY = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const runtimeDir = () => path.join(DATA_DIR, 'embedding-runtime');
const bundledBinary = () => { const p = path.join(repoDir('assets'), 'embedding', BINARY); return fs.existsSync(p) ? p : null; };
const installedBinary = () => { const p = path.join(runtimeDir(), 'bin', BINARY); return fs.existsSync(p) ? p : null; };
/** The llama.cpp binary this runtime can host the model with, if any. */
export const embeddingBinary = (): string | null => bundledBinary() ?? installedBinary();
const runtimeTarget = () => (runtimeManifest.targets as Record<string, { url: string; sha256: string } | undefined>)[`${process.platform}-${process.arch}`] ?? null;
let runtimeInstall: { received: number; done: boolean; error?: string } | undefined;
export function embeddingRuntimeStatus() {
  const target = runtimeTarget();
  return { binary: embeddingBinary(), bundled: !!bundledBinary(), version: runtimeManifest.version, installable: !!target,
    install: runtimeInstall ? { ...runtimeInstall } : null };
}
/** Fetch the pinned llama.cpp build for this platform into the data directory (checksum verified). */
export async function installEmbeddingRuntime(): Promise<void> {
  const target = runtimeTarget();
  if (!target) throw Error(`No pinned llama.cpp build for ${process.platform}-${process.arch}.`);
  if (runtimeInstall && !runtimeInstall.done) throw Error('Runtime install already running.');
  if (bundledBinary()) return;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(DATA_DIR, '.embedding-runtime-'));
  const previous = path.join(temporary, 'previous');
  const state = { received: 0, done: false, error: undefined as string | undefined }; runtimeInstall = state;
  try {
    const response = await fetch(target.url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw Error(`llama.cpp download failed (${response.status}).`);
    const digest = createHash('sha256'), parts: Buffer[] = [];
    for await (const bytes of response.body) {
      state.received += bytes.length;
      if (state.received > 400 * 1024 * 1024) throw Error('llama.cpp archive exceeded the expected size.');
      digest.update(bytes); parts.push(Buffer.from(bytes));
    }
    if (digest.digest('hex') !== target.sha256) throw Error('llama.cpp archive checksum mismatch; download discarded.');
    const archive = path.join(temporary, target.url.endsWith('.zip') ? 'runtime.zip' : 'runtime.tar.gz');
    fs.writeFileSync(archive, Buffer.concat(parts), { mode: 0o600 });
    const extracted = path.join(temporary, 'extracted'); fs.mkdirSync(extracted);
    if (process.platform === 'win32') await promisify(execFile)('powershell', ['-NoProfile', '-Command', 'Expand-Archive', '-LiteralPath', archive, '-DestinationPath', extracted]);
    else await promisify(execFile)('tar', ['-xzf', archive, '-C', extracted]);
    const find = (dir: string): string | undefined => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, e.name);
        if (e.isFile() && e.name === BINARY) return file;
        if (e.isDirectory()) { const found = find(file); if (found) return found; }
      }
    };
    const binary = find(extracted); if (!binary) throw Error('Pinned archive did not contain llama-server.');
    const staged = path.join(temporary, 'runtime'); fs.mkdirSync(staged, { mode: 0o700 });
    fs.cpSync(path.dirname(binary), path.join(staged, 'bin'), { recursive: true, verbatimSymlinks: true });
    const libraries = path.join(path.dirname(path.dirname(binary)), 'lib');
    if (fs.existsSync(libraries)) fs.cpSync(libraries, path.join(staged, 'lib'), { recursive: true, verbatimSymlinks: true });
    fs.writeFileSync(path.join(staged, 'rimeward-manifest.json'), JSON.stringify({ version: runtimeManifest.version, ...target }, null, 2));
    if (fs.existsSync(runtimeDir())) fs.renameSync(runtimeDir(), previous);
    try { fs.renameSync(staged, runtimeDir()); }
    catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, runtimeDir());
      throw error;
    }
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e); throw Error(state.error);
  } finally {
    state.done = true;
    // Keep the backup if restoring it failed; never delete the last usable runtime.
    if (fs.existsSync(runtimeDir()) || !fs.existsSync(previous)) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
const modelPath = (q: Quantization) => path.join(directory(), LOCAL_MODELS[q].file);
const downloads = new Map<Quantization, { ac: AbortController; received: number; error?: string; done: boolean }>();
let child: ChildProcess | undefined, loaded: Quantization | undefined, endpoint = '', key = '', startupMs: number | null = null;
let queryMs: number | null = null, lastError = '', stopping = false;
let memoryBytes:number | null = null,peakMemoryBytes:number | null = null,throughput:number | null = null;
let availableMemoryBytes:number | null = null;
let lifecycle = new AbortController(), queued = 0;
let processStopped: Promise<void> = Promise.resolve();
let unloaded = false;
/** macOS's unused pages omit reclaimable memory; ask the OS's pressure estimator instead. */
export async function refreshEmbeddingMemory(): Promise<number | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await promisify(execFile)('/usr/bin/memory_pressure',['-Q'],{ timeout:3000 });
      const percent = /System-wide memory free percentage:\s*(\d+)%/.exec(stdout);
      availableMemoryBytes = percent ? os.totalmem()*Number(percent[1])/100 : null;
    } else if (process.platform === 'linux') {
      const text = await fs.promises.readFile('/proc/meminfo','utf8'), kb = /^MemAvailable:\s+(\d+) kB/m.exec(text);
      availableMemoryBytes = kb ? Number(kb[1])*1024 : null;
    } else availableMemoryBytes = os.freemem();
  } catch { availableMemoryBytes = null; }
  return availableMemoryBytes;
}
let serial: Promise<unknown> = Promise.resolve();
export function localEmbeddingStatus() {
  const memory = availableMemoryBytes;
  return { runtime: embeddingRuntimeStatus(), loaded: loaded ?? null, ready: !!child && !!loaded, unloaded, startupMs, queryMs,memoryBytes,peakMemoryBytes,throughput,error: lastError || null,
    memoryMetric:'sampled-process-rss',availableMemoryBytes: memory, totalMemoryBytes: os.totalmem(), location: os.hostname(),
    models: Object.entries(LOCAL_MODELS).map(([q,m]) => ({ quantization:q,...m, installed: fs.existsSync(modelPath(q as Quantization)),
      download: downloads.get(q as Quantization) ? { received: downloads.get(q as Quantization)!.received, done: downloads.get(q as Quantization)!.done, error: downloads.get(q as Quantization)!.error } : null,
      recommendation: (memory !== null && memory < m.memoryGB * 1024 ** 3) || (queryMs !== null && queryMs > 2000)
        ? 'Consider putting another computer first in the priority list, or choose OpenAI API or OpenRouter.' : null })) };
}
export async function downloadEmbeddingModel(q: Quantization): Promise<void> {
  if (!Object.hasOwn(LOCAL_MODELS,q)) throw Error('Unknown embedding quantization.');
  if (downloads.has(q) && !downloads.get(q)!.done) throw Error('Download already running.');
  const spec = LOCAL_MODELS[q], ac = new AbortController(), state = { ac,received:0,done:false,error:undefined as string | undefined };
  downloads.set(q,state); fs.mkdirSync(directory(),{ recursive:true,mode:0o700 });
  const temporary = modelPath(q) + '.partial';
  try {
    const response = await fetch(`https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/resolve/${QWEN_REVISION}/${spec.file}`, { signal:ac.signal });
    if (!response.ok || !response.body) throw Error(`Model download failed (${response.status}).`);
    const output = fs.createWriteStream(temporary,{ mode:0o600 });
    output.on('error',error => ac.abort(error));
    const digest = createHash('sha256');
    try {
      for await (const bytes of response.body) {
        ac.signal.throwIfAborted(); state.received += bytes.length;
        if (state.received > spec.bytes) throw Error('Model download exceeded the pinned size.');
        digest.update(bytes);
        if (!output.write(bytes)) await once(output,'drain');
      }
      output.end(); await once(output,'finish');
    } catch (e) { output.destroy(); throw e; }
    ac.signal.throwIfAborted();
    if (state.received !== spec.bytes || digest.digest('hex') !== spec.sha256) throw Error('Model checksum mismatch; download discarded.');
    fs.renameSync(temporary,modelPath(q));
  } catch (e) {
    const error = ac.signal.aborted ? ac.signal.reason : e;
    state.error = error instanceof Error && error.name === 'AbortError' ? 'Download cancelled.' : error instanceof Error ? error.message : String(error);
    fs.rmSync(temporary,{ force:true }); throw Error(state.error);
  } finally { state.done = true; }
}
export function cancelEmbeddingDownload(q: Quantization): void { downloads.get(q)?.ac.abort(); }
async function stopProcess(): Promise<void> {
  const process = child; child = undefined; loaded = undefined; endpoint = '';
  if (!process?.pid || process.exitCode !== null || process.signalCode !== null) return processStopped;
  processStopped = (async () => {
    const exited = once(process,'close').catch(() => {});
    process.kill('SIGTERM');
    const timeout = setTimeout(() => process.kill('SIGKILL'),5000).unref();
    await exited; clearTimeout(timeout);
  })();
  return processStopped;
}
export async function unloadEmbeddingModel(): Promise<void> {
  unloaded = true;
  lifecycle.abort(Error('Local embedding model unloaded.'));
  lifecycle = new AbortController();
  await stopProcess();
}
async function start(q: Quantization, signal?: AbortSignal): Promise<void> {
  if (stopping) throw Error('Runtime is shutting down.');
  unloaded = false;
  if (child && loaded === q) return;
  await stopProcess();
  signal?.throwIfAborted();
  if (!fs.existsSync(modelPath(q))) throw Error('Local embedding model is not downloaded. Open Account → Semantic retrieval to set it up.');
  const binary = embeddingBinary();
  if (!binary) throw Error('The llama.cpp runtime is not installed here. Open Account → Semantic retrieval to set it up.');
  const listener = net.createServer(); listener.listen(0,'127.0.0.1'); await once(listener,'listening');
  const port = (listener.address() as net.AddressInfo).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  signal?.throwIfAborted();
  key = randomBytes(32).toString('hex'); endpoint = `http://127.0.0.1:${port}`;
  const started = performance.now();
  const proc = spawn(binary,['--model',modelPath(q),'--host','127.0.0.1','--port',String(port),'--embedding','--pooling','last',
    '--ctx-size','8192','--batch-size','8192','--ubatch-size','8192','--parallel','1','--gpu-layers','99','--api-key',key],
    { stdio:['ignore','ignore','pipe'],windowsHide:true,
      // An installed Linux build carries its shared objects beside the binary and under ../lib.
      env:{ ...process.env,...(process.platform === 'linux' ? { LD_LIBRARY_PATH:[path.dirname(binary),path.join(path.dirname(binary),'..','lib'),process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } : {}) } });
  child = proc;
  peakMemoryBytes = null; memoryBytes = null;
  const sample = setInterval(() => {
    if (!proc.pid) return;
    void processUsage([proc.pid]).then(values => { const n = values.get(proc.pid!)?.memoryBytes;
      if (n !== undefined) { memoryBytes = n; peakMemoryBytes = Math.max(n,peakMemoryBytes ?? 0); } }).catch(() => {});
  },1000).unref();
  proc.on('error',e => { lastError = e.message; });
  proc.stderr?.on('data',() => {}); // Model logs may echo inputs; never persist them.
  proc.on('exit',() => { clearInterval(sample); if (child === proc) { child = undefined; loaded = undefined; } });
  proc.on('error',() => clearInterval(sample));
  try {
    while (performance.now()-started < 120000) {
      signal?.throwIfAborted();
      if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) throw Error(lastError || 'Local inference process exited.');
      const res = await fetch(`${endpoint}/health`,{ headers:{ authorization:`Bearer ${key}` },signal:AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(2000)]) }).catch(() => null);
      signal?.throwIfAborted();
      if (res?.ok) { loaded = q; startupMs = Math.round(performance.now()-started); lastError = ''; return; }
      await new Promise(resolve => setTimeout(resolve,250));
    }
    throw Error('Local inference startup timed out.');
  } catch (e) { await stopProcess(); throw e; }
}
export function localEmbed(q: Quantization, input: string[], signal?: AbortSignal, query = false): Promise<unknown> {
  // ponytail: one model process and serialized inference; a pool needs a measured memory budget first.
  if (queued >= 16) return Promise.reject(Error('Local inference is busy; retry after the queued requests finish.'));
  signal = AbortSignal.any([lifecycle.signal,...(signal ? [signal] : []),AbortSignal.timeout(120000)]);
  queued++;
  const run = serial.catch(() => {}).then(async () => {
    signal?.throwIfAborted(); await start(q,signal);
    const started = performance.now();
    const response = await fetch(`${endpoint}/v1/embeddings`, { method:'POST',headers:{ 'content-type':'application/json',authorization:`Bearer ${key}` },
      body:JSON.stringify({ input,encoding_format:'float' }),signal:AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(120000)]) });
    if (!response.ok) throw Error(`Local embeddings failed (${response.status}).`);
    const body = await response.json(), elapsed = Math.round(performance.now()-started);
    if (query) queryMs = elapsed;
    throughput = input.length/(Math.max(1,elapsed)/1000);
    return body.data?.sort((a: { index:number },b: { index:number }) => a.index-b.index).map((v: { embedding:unknown }) => v.embedding);
  });
  serial = run;
  return run.catch(e => { lastError = e instanceof Error ? e.message : String(e); throw e; }).finally(() => { queued--; });
}
export async function shutdownEmbeddings(): Promise<void> {
  stopping = true; for (const d of downloads.values()) d.ac.abort(); await unloadEmbeddingModel();
}
