import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { DATA_DIR, repoDir } from '../db.ts';
import { requireDesktop } from '../dev/runtime.ts';
import { processUsage } from '../dev/process-usage.ts';
import { LOCAL_MODELS, QWEN_REVISION, type Quantization } from './embedding-profiles.ts';

const directory = () => path.join(DATA_DIR, 'embedding-models');
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
  return { loaded: loaded ?? null, ready: !!child && !!loaded, unloaded, startupMs, queryMs,memoryBytes,peakMemoryBytes,throughput,error: lastError || null,
    memoryMetric:'sampled-process-rss',availableMemoryBytes: memory, totalMemoryBytes: os.totalmem(), location: os.hostname(),
    models: Object.entries(LOCAL_MODELS).map(([q,m]) => ({ quantization:q,...m, installed: fs.existsSync(modelPath(q as Quantization)),
      download: downloads.get(q as Quantization) ? { received: downloads.get(q as Quantization)!.received, done: downloads.get(q as Quantization)!.done, error: downloads.get(q as Quantization)!.error } : null,
      recommendation: (memory !== null && memory < m.memoryGB * 1024 ** 3) || (queryMs !== null && queryMs > 2000)
        ? 'Consider another paired desktop or explicitly choose OpenAI API or OpenRouter. No provider is switched automatically.' : null })) };
}
export async function downloadEmbeddingModel(q: Quantization): Promise<void> {
  requireDesktop();
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
  requireDesktop();
  if (stopping) throw Error('Runtime is shutting down.');
  unloaded = false;
  if (child && loaded === q) return;
  await stopProcess();
  signal?.throwIfAborted();
  if (!fs.existsSync(modelPath(q))) throw Error('Local embedding model is not downloaded. Open Account → Semantic retrieval to set it up.');
  const binary = path.join(repoDir('assets'),'embedding',process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  if (!fs.existsSync(binary)) throw Error('Bundled llama.cpp is unavailable; update or build the desktop runtime.');
  const listener = net.createServer(); listener.listen(0,'127.0.0.1'); await once(listener,'listening');
  const port = (listener.address() as net.AddressInfo).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  signal?.throwIfAborted();
  key = randomBytes(32).toString('hex'); endpoint = `http://127.0.0.1:${port}`;
  const started = performance.now();
  const proc = spawn(binary,['--model',modelPath(q),'--host','127.0.0.1','--port',String(port),'--embedding','--pooling','last',
    '--ctx-size','8192','--batch-size','8192','--ubatch-size','8192','--parallel','1','--gpu-layers','99','--api-key',key],
    { stdio:['ignore','ignore','pipe'],windowsHide:true });
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
