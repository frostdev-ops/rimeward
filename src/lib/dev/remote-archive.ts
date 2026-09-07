import { createHash } from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';
import { once } from 'node:events';
import { pack } from 'tar-stream';
import { REMOTE_LIMITS } from './remote-desktop-contract.ts';

export interface ArchiveFileReply {
  entries?: { name: string; directory: boolean }[];
  id?: string; size?: number; data?: string; offset?: number; sha256?: string;
}
type FileCall = (command: string, body: Record<string, unknown>) => Promise<ArchiveFileReply>;
/** A single active file, one chunk in flight, no archive or file content stored on the server. */
export function remoteArchive(root: string, path: string, call: FileCall, signal: AbortSignal, done: () => void) {
  const lifetime = new AbortController();
  const archive = pack(), bridge = new PassThrough({ highWaterMark: 65536 });
  archive.pipe(bridge);
  archive.on('error', error => bridge.destroy(error));
  bridge.once('close', () => archive.destroy());
  const output = Readable.toWeb(bridge, { strategy: { highWaterMark: 0, size: chunk => chunk.byteLength } }) as ReadableStream<Uint8Array>;
  let active: string | undefined, count = 0;
  const cancel = () => { lifetime.abort(Error('Folder download cancelled')); archive.destroy(Error('Folder download cancelled')); };
  signal.addEventListener('abort', cancel, { once: true });
  archive.once('close', () => lifetime.abort(Error('Folder download closed')));
  // An error listener is needed even before the browser starts reading the response.
  archive.on('error', () => {});
  const name = path.split('/').filter(Boolean).at(-1) || 'folder';
  const checkName = (value: unknown): string => {
    if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\0:]/.test(value)) throw Error('Invalid archive entry');
    return value;
  };
  const check = () => { signal.throwIfAborted(); lifetime.signal.throwIfAborted(); if (archive.destroyed) throw Error('Folder download cancelled'); };
  const wait = async (promise: Promise<void>) => {
    check(); let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(lifetime.signal.reason); lifetime.signal.addEventListener('abort', abort, { once: true }); });
    try { await Promise.race([promise, cancelled]); } finally { lifetime.signal.removeEventListener('abort', abort); }
  };
  async function directory(remote: string, target: string, depth: number) {
    check(); if (depth > 64 || ++count > 100000) throw Error('Folder exceeds the transfer entry limit');
    if (bridge.writableNeedDrain) await once(bridge, 'drain', { signal: lifetime.signal });
    await wait(new Promise<void>((resolve, reject) => archive.entry({ name: `${target}/`, type: 'directory', mode: 0o755, mtime: new Date(0) }, Buffer.alloc(0), error => error ? reject(error) : resolve())));
    const result = await call('browse', { root, path: remote });
    if (!Array.isArray(result.entries) || result.entries.length > 1000) throw Error('Invalid folder listing');
    // Stable headers/order let a resumed download verify its saved byte prefix.
    for (const entry of result.entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      check(); const name = checkName(entry.name), from = [remote, name].filter(Boolean).join('/'), to = `${target}/${name}`;
      if (entry.directory) { await directory(from, to, depth + 1); continue; }
      if (++count > 100000) throw Error('Folder exceeds the transfer entry limit');
      const transfer = await call('create', { root, path: from, upload: false, source: 'folder-download' });
      active = String(transfer.id); let offset = 0;
      const size = transfer.size;
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw Error('Invalid file size');
      let finish!: () => void, fail!: (error: Error) => void;
      const complete = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      complete.catch(() => {});
      const stream = archive.entry({ name: to, type: 'file', size, mode: 0o644, mtime: new Date(0) }, error => error ? fail(error) : finish());
      while (offset < size) {
        check();
        const chunk = await call('chunk', { id: active, offset });
        if (typeof chunk.data !== 'string' || chunk.data.length > 6 * 1024 * 1024 || typeof chunk.offset !== 'number') throw Error('Invalid transfer chunk');
        const bytes = Buffer.from(chunk.data, 'base64');
        if (!bytes.length || bytes.length > REMOTE_LIMITS.chunkBytes || chunk.offset !== offset + bytes.length ||
          chunk.offset > size || createHash('sha256').update(bytes).digest('hex') !== chunk.sha256) throw Error('Invalid transfer chunk');
        offset = chunk.offset;
        if (!stream.write(bytes)) await once(stream, 'drain', { signal: lifetime.signal });
      }
      stream.end(); await wait(complete); await call('finalize', { id: active }); active = undefined;
    }
  }
  void (async () => {
    try { await directory(path, checkName(name), 0); archive.finalize(); }
    catch (error) { archive.destroy(error instanceof Error ? error : Error('Folder download failed')); }
    finally {
      if (active) await call('cancel', { id: active }).catch(() => {});
      signal.removeEventListener('abort', cancel); done();
    }
  })();
  return new Response(output, { headers: { 'content-type': 'application/x-tar',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.tar`,
    'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } });
}
