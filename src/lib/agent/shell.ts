import dns from 'node:dns/promises';
import type * as dnsTypes from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import net from 'node:net';
import path, { posix } from 'node:path';
import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs, defineCommand } from 'just-bash';
import type { ResolvedCommandContext, SecureFetch } from 'just-bash';
import { extractPdfText } from './docs.ts';
import { docsDir, historyDir, workDir } from './history.ts';
import { getSetting } from '../settings.ts';
import { isLoopbackAddress, isPrivateAddress } from '../net-guard.ts';

// A real shell for the agent — just-bash: a bash interpreter with a virtual
// filesystem, not a subprocess. Nothing it runs can touch the host beyond the
// directories mounted below, which is the point: the agent reads documents that
// arrive from other people, so "shell access" has to mean something bounded.
//
// Mounted (all per-user — one user's agent never sees another's files):
//   /history  that user's past conversations, as markdown  (read-only)
//   /docs     the extracted text of their attachments      (read-only)
//   /work     the agent's own scratch space                (read-write, real)
//
// Deliberately NOT mounted: data/homepage.db. just-bash ships a sqlite3
// command, and the dashboard DB is reachable only through the audited tools —
// never raw SQL.

export const SHELL_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const NETWORK_SETTING = 'agent_shell_network';

/** Network is a per-user setting because it is the one capability that turns a
 *  prompt injection in an attached PDF into an outbound channel. Default OFF —
 *  only the literal 'true' enables it (this is a multi-user box). */
export function shellNetworkEnabled(userId: number): boolean {
  return getSetting(`${NETWORK_SETTING}:${userId}`) === 'true';
}

/** The context has no path resolver — commands get a cwd and do it themselves. */
const at = (ctx: ResolvedCommandContext, p: string) => (p.startsWith('/') ? p : posix.resolve(ctx.cwd, p));

async function readPdf(ctx: ResolvedCommandContext, file: string) {
  const raw = (await ctx.fs.readFile(at(ctx, file))) as unknown;
  const bytes =
    raw instanceof Uint8Array ? raw : new Uint8Array(Buffer.from(String(raw), 'latin1'));
  return extractPdfText(bytes);
}

const pdftotext = defineCommand('pdftotext', async (args, ctx) => {
  const input = args.find((a) => !a.startsWith('-'));
  if (!input) return { stdout: '', stderr: 'usage: pdftotext <file.pdf> [out.txt]\n', exitCode: 2 };
  const target = args.filter((a) => !a.startsWith('-'))[1];
  try {
    const pdf = await readPdf(ctx, input);
    if (pdf.scanned) return { stdout: '', stderr: `${input}: no text layer (scanned)\n`, exitCode: 1 };
    if (target) {
      await ctx.fs.writeFile(at(ctx, target), pdf.text);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: pdf.text, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `pdftotext: ${err instanceof Error ? err.message : err}\n`, exitCode: 1 };
  }
});

const pdfinfo = defineCommand('pdfinfo', async (args, ctx) => {
  const input = args.find((a) => !a.startsWith('-'));
  if (!input) return { stdout: '', stderr: 'usage: pdfinfo <file.pdf>\n', exitCode: 2 };
  try {
    const pdf = await readPdf(ctx, input);
    return {
      stdout: `Pages: ${pdf.pages.length}\nCharacters: ${pdf.text.length}\nText layer: ${pdf.scanned ? 'no (scanned)' : 'yes'}\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    return { stdout: '', stderr: `pdfinfo: ${err instanceof Error ? err.message : err}\n`, exitCode: 1 };
  }
});

const MAX_HOPS = 5;

/** The one address the private-range check approved, pinned for the connect. */
interface VettedAddress {
  address: string;
  family: number;
}

async function vetHost(target: URL, allowLoopback = false): Promise<VettedAddress> {
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error(`refused: ${target.protocol} is not allowed`);
  }
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await dns.lookup(host, { all: true });
  if (!addresses.length) throw new Error(`refused: ${host} did not resolve`);
  for (const a of addresses) {
    if (isPrivateAddress(a.address) && !(allowLoopback && isLoopbackAddress(a.address))) {
      throw new Error(`refused: ${host} resolves to the private address ${a.address}`);
    }
  }
  // The address that PASSED must be the address we connect to. Returning it
  // (and pinning it below) closes the DNS-rebinding window: otherwise node
  // resolves the hostname a second time at connect and an attacker-controlled
  // TTL-0 domain can answer public here and 127.0.0.1 there.
  return { address: addresses[0]!.address, family: Number(addresses[0]!.family) || 4 };
}

/** One request, no redirect handling — node:http(s), deliberately not fetch.
 *  `pinned` is the address vetHost approved; the socket connects to exactly
 *  that (TLS still validates against the original hostname, which node takes
 *  from the URL). */
function request(
  target: URL,
  options: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number; pinned: VettedAddress; signal?: AbortSignal; deadlineMs?: number; onChunk?: (chunk: Uint8Array, headers: Record<string, string>) => void }
): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: Uint8Array; location?: string }> {
  const mod = target.protocol === 'https:' ? https : http;
  const { address, family } = options.pinned;
  // Overriding `lookup` is the supported way to make node skip its own second
  // resolution without breaking SNI/Host/cert checks.
  const lookup = (
    _hostname: string,
    opts: dnsTypes.LookupOneOptions | dnsTypes.LookupAllOptions | ((err: null, address: any, family?: number) => void),
    cb?: (err: null, address: any, family?: number) => void
  ) => {
    const done = (typeof opts === 'function' ? opts : cb)!;
    const all = typeof opts !== 'function' && (opts as dnsTypes.LookupAllOptions).all;
    if (all) done(null, [{ address, family }] as never);
    else done(null, address, family);
  };
  return new Promise((resolve, reject) => {
    // `timeout` is socket inactivity; the deadline bounds a trickling response too.
    const onAbort = () => req.destroy(new Error('aborted'));
    const deadline = options.deadlineMs ? setTimeout(() => req.destroy(new Error('deadline exceeded')), options.deadlineMs) : undefined;
    const settle = () => {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const req = mod.request(
      target,
      { method: options.method, headers: options.headers, timeout: options.timeoutMs, lookup: lookup as never },
      (res) => {
        const headers = Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value ?? '')]));
        const chunks: Buffer[] = [];
        let size = 0;
        let ended = false;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(c);
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
            try { options.onChunk?.(c, headers); } catch (error) { req.destroy(error instanceof Error ? error : new Error(String(error))); }
          }
        });
        // A response that errors, is aborted, or closes before its end (a
        // provider dropping the socket mid-body) settles here — a promise that
        // waited for 'end' would hang for good.
        res.on('error', (err) => { settle(); reject(err); });
        res.on('aborted', () => { settle(); reject(new Error('response aborted before it was complete')); });
        res.on('close', () => { if (!ended) { settle(); reject(new Error(`response closed after ${size} bytes, before its end`)); } });
        res.on('end', () => {
          ended = true;
          settle();
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])
            ),
            body: new Uint8Array(Buffer.concat(chunks)),
            location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => { settle(); reject(err); });
    // A cancel tears the socket down; the promise rejects through 'error'.
    if (options.signal?.aborted) req.destroy(new Error('aborted'));
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * The request an API credential rides on (the OpenAI-compatible provider): the
 * same private-range check and pinned connect as vettedFetch, but NO redirect is
 * ever followed — a 3xx is an error, so a bearer key is never replayed to a host
 * the user did not name — the cancel signal reaches the socket, and the timeout
 * is the caller's (a model call thinks for minutes). `allowLoopback` is for the
 * desktop, where a local model server on 127.0.0.1 is the point; the server
 * refuses every private address.
 */
export async function pinnedRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; signal?: AbortSignal; allowLoopback?: boolean; onChunk?: (chunk: Uint8Array, headers: Record<string, string>) => void }
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const target = new URL(url);
  const pinned = await vetHost(target, options.allowLoopback === true);
  // A credential travels in the clear only to this machine.
  if (target.protocol === 'http:' && options.headers?.Authorization && !isLoopbackAddress(pinned.address)) throw new Error(`refused: ${target.host} is http — a key goes only over https, or to 127.0.0.1`);
  // One bound, the caller's: a non-streaming inference legitimately sends no
  // byte for minutes, so socket inactivity is not cut shorter than the deadline.
  const deadlineMs = options.timeoutMs ?? 20_000;
  const res = await request(target, { method: options.method ?? 'GET', headers: options.headers, body: options.body, timeoutMs: deadlineMs, deadlineMs, pinned, signal: options.signal, onChunk: options.onChunk });
  if (res.status >= 300 && res.status < 400) throw new Error(`refused: ${target.host} redirected (${res.status}); credentials are never forwarded to another address`);
  return { status: res.status, headers: res.headers, text: Buffer.from(res.body).toString('utf8') };
}

/**
 * Full internet, minus anything on this machine or this network.
 *
 * Two things forced this to be hand-rolled. just-bash's own denyPrivateRanges
 * fails closed on runtimes it cannot pin a resolved address to, which here meant
 * no network at all; and its defense-in-depth layer blocks `WeakRef` during
 * script execution, which Node's global fetch uses internally — so this goes
 * through node:https directly. The private-range check is the part that matters:
 * without it the sandbox could reach 127.0.0.1:3005 and drive this very app.
 */
export const vettedFetch: SecureFetch = async (url, options) => {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`bad URL: ${url}`);
  }
  const timeoutMs = Math.min(options?.timeoutMs ?? 20_000, 30_000);
  const headers = options?.headers instanceof Headers
    ? Object.fromEntries(options.headers.entries())
    : ((options?.headers as Record<string, string>) ?? {});

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const pinned = await vetHost(target); // every hop is re-checked, not just the first
    const res = await request(target, { method: options?.method ?? 'GET', headers, body: options?.body, timeoutMs, pinned });
    const redirecting = res.status >= 300 && res.status < 400 && res.location;
    if (!redirecting || options?.followRedirects === false) {
      return { status: res.status, statusText: res.statusText, headers: res.headers, body: res.body, url: target.toString() };
    }
    target = new URL(res.location!, target);
  }
  throw new Error(`refused: more than ${MAX_HOPS} redirects`);
};

// DefenseInDepthBox is a process-wide singleton that compares every option,
// the callback included, BY REFERENCE across Bash instances: an inline arrow
// here made the second shell command in the process ever throw "config conflict".
const onViolation = (v: unknown) => console.warn('[shell] sandbox violation:', v);

/** js-exec's host-tool bridge: path "get_weather" for `tools.get_weather(…)`. */
export type InvokeTool = (path: string, argsJson: string) => Promise<string>;

function makeShell(userId: number, invoke?: InvokeTool): Bash {
  const network = shellNetworkEnabled(userId);
  const fsys = new MountableFs({
    base: new InMemoryFs(),
    mounts: [
      // mountPoint:'/' on the OverlayFs itself — it otherwise defaults to
      // /home/user/project and the files end up nested under the mount.
      { mountPoint: '/history', filesystem: new OverlayFs({ root: historyDir(userId), mountPoint: '/', readOnly: true }) },
      { mountPoint: '/docs', filesystem: new OverlayFs({ root: docsDir(userId), mountPoint: '/', readOnly: true }) },
      { mountPoint: '/work', filesystem: new ReadWriteFs({ root: workDir(userId) }) },
    ],
  });

  return new Bash({
    fs: fsys,
    cwd: '/work',
    env: { HOME: '/work', HISTORY: '/history', DOCS: '/docs' },
    // Full internet when enabled, through our own resolver check (see above).
    fetch: network ? vettedFetch : undefined,
    // just-bash's defense-in-depth blocks globals the TLS stack itself needs
    // (WeakRef, NODE_TLS_REJECT_UNAUTHORIZED), so with the network on it is off.
    // With the network off it runs in AUDIT mode — logged, never blocked:
    // blocking mode also blocks js-exec's own worker cleanup timer (a
    // "bound callback after deactivate" violation), which strands the QuickJS
    // worker after every script. It is explicitly a SECONDARY layer — the
    // primary controls (virtual filesystem, no real process execution, the
    // private-range check above) are unchanged either way.
    defenseInDepth: network ? false : { enabled: true, auditMode: true, onViolation },
    customCommands: [pdftotext, pdfinfo],
    // js-exec: QuickJS in a worker (64 MB, the same 30 s), fs onto the virtual
    // tree, fetch = the vetted one above when the network is on. `tools.*` is
    // the bridge back into the registry — the caller decides what it exposes.
    javascript: invoke ? { invokeTool: invoke } : true,
  });
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

// As JSON, under core.ts OUTPUT_CAP (12k) with room for the bash tool's
// fields. A bigger allowance is not more output: past the cap the whole result
// is replaced by an error, so 40k was 0 useful chars.
const MAX_OUTPUT = 11_000;
const STDERR_KEEP = 2_000;
/** Cut by serialized size — escapes inflate a text by 5–20% (the agent's
 *  `head -c 10100` came back as 12,291 JSON chars and was refused). */
export function fitOutput(stdout: string, stderr: string): { stdout: string; stderr: string; truncated: boolean } {
  let err = stderr.slice(0, STDERR_KEEP);
  let out = stdout;
  for (;;) {
    const json = JSON.stringify({ stdout: out, stderr: err });
    if (json.length <= MAX_OUTPUT) break;
    if (out.length) out = out.slice(0, Math.max(0, Math.floor((out.length * MAX_OUTPUT) / json.length) - 64));
    else err = err.slice(0, Math.max(0, Math.floor((err.length * MAX_OUTPUT) / json.length) - 64));
  }
  return { stdout: out, stderr: err, truncated: out.length < stdout.length || err.length < stderr.length };
}

/** Run one command line. Each call is a fresh shell over the same mounts —
 *  /work persists between calls because it is a real directory. */
export async function runShell(userId: number, command: string, invoke?: InvokeTool, signal?: AbortSignal): Promise<ShellResult> {
  const bash = makeShell(userId, invoke);
  const timeout = new AbortController();
  let result: { stdout?: unknown; stderr?: unknown; exitCode?: number };
  // The timer MUST be cleared: an un-cleared race timer keeps a handle alive for
  // its full duration after the command has already finished, which pins the
  // event loop and stops the process exiting.
  let timer: NodeJS.Timeout | undefined;
  try {
    result = await Promise.race([
      bash.exec(command, { signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timeout.abort();
          reject(new Error(`shell: timed out after ${SHELL_TIMEOUT_MS / 1000}s`));
        }, SHELL_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    // A refused write (EROFS on the read-only mounts), a limit, a parse error:
    // the shell throws where bash would just set $?. Report it as the command
    // failing — a bad command must never take the whole turn down.
    return {
      stdout: '',
      stderr: `${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
      truncated: false,
    };
  } finally {
    clearTimeout(timer);
  }
  return { ...fitOutput(String(result.stdout ?? ''), String(result.stderr ?? '')), exitCode: result.exitCode ?? 0 };
}

/** Files the agent produced, for the user to look at. */
export function listWorkFiles(userId: number): { name: string; bytes: number }[] {
  try {
    const dir = workDir(userId);
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => ({ name: e.name, bytes: fs.statSync(path.join(dir, e.name)).size }));
  } catch {
    return [];
  }
}
