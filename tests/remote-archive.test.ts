import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { extract } from 'tar-stream';
import { remoteArchive, type ArchiveFileReply } from '../src/lib/dev/remote-archive.ts';

test('folder download streams validated files and empty directories, and cancels a slow reader', async () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024, 42); let chunks = 0, finished = 0, cancelled = 0, done = 0;
  const call = async (command: string, body: Record<string, unknown>): Promise<ArchiveFileReply> => {
    if (command === 'browse') return { entries: body.path === '' ? [{ name: 'empty', directory: true }, { name: 'large.bin', directory: false }] : [] };
    if (command === 'create') return { id: 'fixture', size: bytes.length * 10 };
    if (command === 'chunk') { chunks++; return { data: bytes.toString('base64'), offset: Number(body.offset) + bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
    if (command === 'finalize') { finished++; return {}; }
    if (command === 'cancel') { cancelled++; return {}; }
    throw Error('Unexpected operation');
  };
  const response = remoteArchive('/selected', '', call, new AbortController().signal, () => done++);
  const unpack = extract(), entries: { name: string; size: number }[] = [];
  const complete = new Promise<void>((resolve, reject) => {
    unpack.on('entry', (header, stream, next) => {
      let size = 0; stream.on('data', chunk => size += chunk.length);
      stream.on('end', () => { entries.push({ name: header.name, size }); next(); }); stream.resume();
    });
    unpack.on('finish', resolve); unpack.on('error', reject);
  });
  Readable.fromWeb(response.body! as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(unpack); await complete;
  assert.deepEqual(entries, [{ name: 'folder/', size: 0 }, { name: 'folder/empty/', size: 0 }, { name: 'folder/large.bin', size: bytes.length * 10 }]);
  assert.equal(finished, 1); assert.equal(chunks, 10); assert.equal(done, 1);
  chunks = 0;
  const slow = remoteArchive('/selected', '', call, new AbortController().signal, () => done++);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(chunks <= 3, `slow consumer pulled ${chunks} chunks`);
  await slow.body!.cancel();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(done, 2); assert.ok(cancelled <= 1); assert.equal(finished, 1);
  const invalid = remoteArchive('/selected', '', async () => ({ entries: [{ name: '../escape', directory: false }] }), new AbortController().signal, () => {});
  await assert.rejects(() => invalid.arrayBuffer(), /Invalid archive entry/);
});

test('folder archive prefixes are deterministic across fresh authorizations and directory ordering', async () => {
  let reverse = false;
  const call = async (command: string, body: Record<string, unknown>): Promise<ArchiveFileReply> => {
    if (command === 'browse') return { entries: body.path === ''
      ? (reverse ? ['z', 'a'] : ['a', 'z']).map(name => ({ name, directory: true })) : [] };
    throw Error('Unexpected operation');
  };
  const first = await remoteArchive('/selected', '', call, new AbortController().signal, () => {}).arrayBuffer();
  reverse = true;
  const second = await remoteArchive('/selected', '', call, new AbortController().signal, () => {}).arrayBuffer();
  assert.deepEqual(Buffer.from(first), Buffer.from(second));
});
