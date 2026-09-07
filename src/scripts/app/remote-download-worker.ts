/** OPFS keeps partial downloads off the server and out of memory. One acknowledged chunk at a time. */
export interface DownloadRecord {
  id: string; device: string; root: string; path: string; source: string;
  size: number; offset: number; digest: string; chunks: string[]; complete: boolean;
  folderPath?: string;
}
interface SyncFile {
  write(bytes: Uint8Array, options: { at: number }): number;
  truncate(size: number): void; flush(): void; close(): void;
}
const hash = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const directory = () => navigator.storage.getDirectory().then(root => root.getDirectoryHandle('rimeward-downloads', { create: true }));
const idOf = (id: unknown) => { if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw Error('Invalid local transfer'); return id; };
async function save(root: FileSystemDirectoryHandle, record: DownloadRecord) {
  const file = await root.getFileHandle(`${idOf(record.id)}.json`, { create: true });
  const writer = await file.createWritable();
  try { await writer.write(JSON.stringify(record)); await writer.close(); }
  catch (error) { await writer.abort().catch(() => {}); throw error; }
}
async function load(root: FileSystemDirectoryHandle, id: string): Promise<DownloadRecord> {
  const file = await (await root.getFileHandle(`${idOf(id)}.json`)).getFile();
  if (file.size > 20 * 1024 * 1024) throw Error('Invalid local recovery record');
  const record = JSON.parse(await file.text()) as DownloadRecord;
  if (record.id !== id || !Array.isArray(record.chunks) || record.chunks.length > 262144 ||
      !Number.isSafeInteger(record.offset) || record.offset < 0 || record.offset > record.size || record.size > 2 ** 40)
    throw Error('Invalid local recovery record');
  return record;
}
async function run(value: { command: string; id?: string; record?: DownloadRecord; bytes?: ArrayBuffer; device?: string; index?: number }) {
  const root = await directory();
  if (value.command === 'list') {
    const records: DownloadRecord[] = [];
    for await (const handle of (root as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (!/^[a-f0-9]{32}\.json$/.test(handle.name)) continue;
      if (records.length >= 1000) break;
      const record = await load(root, handle.name.slice(0, -5));
      if (record.device === value.device) records.push(record);
    }
    return records;
  }
  const id = idOf(value.record?.id ?? value.id);
  if (value.command === 'remove') {
    await root.removeEntry(`${id}.part`).catch(() => {}); await root.removeEntry(`${id}.json`).catch(() => {}); return;
  }
  if (value.command === 'verify') {
    const record = await load(root, id), file = await (await root.getFileHandle(`${id}.part`)).getFile();
    if (file.size < record.offset || record.chunks.length !== Math.ceil(record.offset / 4194304)) throw Error('The partial download changed');
    if (value.index !== undefined && (!Number.isSafeInteger(value.index) || value.index < 0 || value.index >= Math.max(1, record.chunks.length))) throw Error('Invalid verification chunk');
    for (let index = value.index ?? 0; index < Math.min(record.chunks.length, value.index === undefined ? Infinity : value.index + 1); index++) {
      if (await hash(await file.slice(index * 4194304, Math.min(record.offset, (index + 1) * 4194304)).arrayBuffer()) !== record.chunks[index])
        throw Error('The partial download changed; start a new download');
    }
    return record;
  }
  const record = value.record; if (!record) throw Error('Missing download record');
  if (value.command === 'append' || value.command === 'create') {
    const file = await root.getFileHandle(`${id}.part`, { create: true });
    const handle = await (file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncFile> }).createSyncAccessHandle();
    try {
      if (value.command === 'create') handle.truncate(0);
      else {
        if (!value.bytes || value.bytes.byteLength > 4194304 || record.offset < value.bytes.byteLength) throw Error('Invalid download chunk');
        const written = handle.write(new Uint8Array(value.bytes), { at: record.offset - value.bytes.byteLength });
        if (written !== value.bytes.byteLength) throw Error('Local storage is full');
        handle.truncate(record.offset);
      }
      handle.flush();
    } finally { handle.close(); }
  } else if (value.command !== 'save') throw Error('Unknown local download operation');
  await save(root, record);
  return record;
}
let busy = false;
self.onmessage = event => {
  if (busy) { self.postMessage({ error: 'A local download operation is already pending' }); return; }
  busy = true;
  void run(event.data).then(result => self.postMessage({ result }), error => self.postMessage({ error: String(error instanceof Error ? error.message : error) }))
    .finally(() => { busy = false; });
};
