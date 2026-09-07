import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bufferKey, decode, encode, hash, MAX_FILE, projectOf, projectPath, type BufferRow } from './projects.ts';
import { claimLease, DevError, emitDev, leaseOwner, workDb } from './runtime.ts';
import { parsePatch, patchPath, patchText } from './patch.ts';

type Snapshot = { path: string; target: string; stat: fs.Stats | undefined; digest: string | null; raw: Buffer; text: string; encoding: string; newline: string };
type Receipt = { operation: string; path: string; to?: string; revision: number | null; saved: boolean; recovery?: number; hash: string | null };
const collisionKey = (file: string) => process.platform === 'linux' ? file : file.normalize('NFC').toLowerCase();

/** Synchronous preflight/commit prevents interleaving with this runtime's editor requests.
 * External processes are not locked: recheck before each write and report partial I/O honestly. */
export function applyProjectPatch(user: number, project: string, owner: string, patch: unknown, revisions?: unknown) {
  const operations = parsePatch(patch);
  if (!/^agent:[\w:-]{1,114}$/.test(owner)) throw new DevError('Invalid patch owner.');
  const db = workDb(), root = projectOf(user, project).root;
  const expected = new Map<string, number>();
  if (revisions !== undefined) {
    if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)) throw new DevError('expected_revisions must map patch paths to integer buffer revisions.');
    for (const [file, value] of Object.entries(revisions)) {
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DevError('Expected revisions must be non-negative integers.');
      expected.set(patchPath(file), value as number);
    }
  }
  const directories = new Map<string, fs.Stats>();
  const snapshots = new Map<string, Snapshot>();
  let total = 0;
  const inspect = (file: string): Snapshot => {
    const target = projectPath(user, project, file, true);
    // Reject even in-project symlinks: paths, buffers and recovery have one unambiguous identity.
    let ancestor = root;
    for (const segment of ['', ...file.split('/')]) {
      ancestor = path.join(ancestor, segment);
      const st = fs.lstatSync(ancestor, { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) throw new DevError(`${file}: symlinks are not supported by apply_patch.`, 403);
      if (ancestor !== path.join(root, file) && st) {
        if (!st.isDirectory()) throw new DevError(`${file}: parent is not a directory.`);
        directories.set(ancestor, st);
      }
    }
    if (fs.realpathSync(root) !== root || target !== path.join(root, file)) throw new DevError(`${file}: project path changed.`, 409);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE)) throw new DevError(`${file}: patch only regular, single-link files up to 5 MiB.`);
    const raw = stat ? fs.readFileSync(target) : Buffer.alloc(0);
    total += raw.length;
    if (total > 20 * 1024 * 1024) throw new DevError('Patch source files exceed 20 MiB in total.');
    const decoded = decode(raw);
    if (decoded.readonly) throw new DevError(`${file}: binary, mixed newlines, or unsupported text encoding.`);
    const snapshot = { path: file, target, stat, digest: stat ? hash(raw) : null, raw, ...decoded };
    snapshots.set(file, snapshot);
    return snapshot;
  };
  const used = new Set<string>();
  const plans = operations.map(op => {
    for (const file of [op.path, ...(op.kind === 'update' && op.move ? [op.move] : [])]) {
      const key = collisionKey(file);
      if ([...used].some(other => other === key || other.startsWith(`${key}/`) || key.startsWith(`${other}/`)))
        throw new DevError(`${file}: duplicate or colliding patch operation.`);
      used.add(key);
    }
    const source = inspect(op.path);
    if (op.kind === 'add' ? !!source.stat : !source.stat) throw new DevError(`${op.path}: ${op.kind === 'add' ? 'destination already exists' : 'source does not exist'}.`, 409);
    const dest = op.kind === 'update' && op.move ? inspect(op.move) : source;
    if (dest !== source && dest.stat) throw new DevError(`${dest.path}: destination already exists.`, 409);
    const text = op.kind === 'add' ? op.text : op.kind === 'update' ? patchText(source.text, op) : '';
    const bytes = encode(text, source.encoding, source.newline);
    if (bytes.length > MAX_FILE) throw new DevError(`${dest.path}: patched file exceeds 5 MiB.`);
    return { op, source, dest, text, bytes };
  });
  // Reserve space for error text and recovery metadata even if the last write fails.
  // Unapplied recovery records are smaller than these conservative per-operation receipts.
  const receiptBudget = plans.map(({ source, dest }) => ({ operation: 'update', path: source.path,
    ...(dest !== source ? { to: dest.path } : {}), revision: Number.MAX_SAFE_INTEGER, saved: true,
    recovery: Number.MAX_SAFE_INTEGER, hash: '0'.repeat(64) }));
  if (JSON.stringify(receiptBudget).length > 9000) throw new DevError('Patch receipt would exceed the tool limit; split this patch into smaller batches.');
  for (const file of expected.keys()) if (!snapshots.has(file)) throw new DevError(`${file}: expected revision does not name a patch path.`);

  // Overlapping registered projects/users must not bypass an existing editor's ownership.
  const peers = (db.prepare('SELECT b.user_id,b.project,b.path,p.root FROM buffers b JOIN projects p ON p.id=b.project').all() as
    { user_id: number; project: string; path: string; root: string }[])
    .filter(row => [...snapshots.values()].some(s => collisionKey(path.resolve(row.root, row.path)) === collisionKey(s.target)));
  const rowOf = (u: number, p: string, f: string) => db.prepare('SELECT * FROM buffers WHERE user_id=? AND project=? AND path=?').get(u, p, f) as BufferRow | undefined;
  const checkBuffers = () => {
    for (const peer of peers) {
      const currentOwner = leaseOwner(bufferKey(peer.user_id, peer.project, peer.path));
      if (currentOwner && (currentOwner !== owner || peer.user_id !== user)) throw new DevError(`${peer.path}: another client controls this buffer; release it before patching.`, 409);
      if (rowOf(peer.user_id, peer.project, peer.path)?.dirty) throw new DevError(`${peer.path}: save or resolve the dirty recovery buffer before patching.`, 409);
    }
    for (const snapshot of snapshots.values()) {
      const row = rowOf(user, project, snapshot.path), revision = expected.get(snapshot.path);
      if (revision !== undefined && (revision !== (row?.revision ?? 0) || (row && row.base_hash !== (snapshot.digest ?? ''))))
        throw new DevError(`${snapshot.path}: stale buffer revision or disk hash; read the current file.`, 409);
    }
  };
  const recheck = (snapshot: Snapshot) => {
    for (const [dir, before] of directories) {
      const now = fs.lstatSync(dir, { throwIfNoEntry: false });
      if (!now?.isDirectory() || now.dev !== before.dev || now.ino !== before.ino) throw new DevError(`${snapshot.path}: parent directory changed.`, 409);
    }
    if (projectPath(user, project, snapshot.path, true) !== snapshot.target) throw new DevError(`${snapshot.path}: path changed.`, 409);
    const now = fs.lstatSync(snapshot.target, { throwIfNoEntry: false }), before = snapshot.stat;
    if (!before ? !!now : !now?.isFile() || now.dev !== before.dev || now.ino !== before.ino || now.mode !== before.mode || now.nlink !== 1 || now.size > MAX_FILE || hash(fs.readFileSync(snapshot.target)) !== snapshot.digest)
      throw new DevError(`${snapshot.path}: file changed during patch planning.`, 409);
  };
  checkBuffers();
  for (const snapshot of snapshots.values()) recheck(snapshot);
  // Recovery is durable before any destructive operation. Raw bytes/mode supplement the existing text history.
  const recovery = new Map<string, number>();
  db.transaction(() => {
    for (const { source } of plans) if (source.stat) {
      const copy = db.prepare('INSERT INTO buffer_copies(user_id,project,path,text,raw,mode) VALUES(?,?,?,?,?,?)')
        .run(user, project, source.path, source.text, source.raw, source.stat.mode);
      recovery.set(source.path, Number(copy.lastInsertRowid));
    }
  })();
  const applied: Receipt[] = [], createdDirectories: string[] = [];
  const events: { user: number; project: string; path: string }[] = [];
  const saveBuffer = (snapshot: Snapshot, text: string, bytes: Buffer | null, encoding: string, newline: string) => {
    const owners = [{ user_id: user, project, path: snapshot.path }, ...peers.filter(p => collisionKey(path.resolve(p.root, p.path)) === collisionKey(snapshot.target) && !(p.user_id === user && p.project === project && p.path === snapshot.path))];
    for (const peer of owners) {
      db.prepare(`INSERT INTO buffers(user_id,project,path,text,base_hash,encoding,newline,readonly) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id,project,path) DO UPDATE SET text=excluded.text,base_hash=excluded.base_hash,encoding=excluded.encoding,newline=excluded.newline,
        readonly=excluded.readonly,dirty=0,revision=buffers.revision+1`)
        .run(peer.user_id, peer.project, peer.path, text, bytes ? hash(bytes) : '', encoding, newline, Number(!bytes));
      events.push({ user: peer.user_id, project: peer.project, path: peer.path });
    }
    claimLease(bufferKey(user, project, snapshot.path), owner);
    return rowOf(user, project, snapshot.path)?.revision ?? null;
  };
  const parents = (dest: Snapshot) => {
    let dir = root;
    for (const segment of dest.path.split('/').slice(0, -1)) {
      dir = path.join(dir, segment);
      if (!fs.lstatSync(dir, { throwIfNoEntry: false })) {
        fs.mkdirSync(dir);
        createdDirectories.push(path.relative(root, dir).split(path.sep).join('/'));
      }
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory()) throw new DevError(`${dest.path}: parent is not a directory.`, 409);
      if (!directories.has(dir)) directories.set(dir, stat);
    }
  };
  try {
    for (const { op, source, dest, text, bytes } of plans) {
      recheck(source);
      if (dest !== source) recheck(dest);
      const receipt: Receipt = { operation: op.kind === 'update' && op.move ? 'move' : op.kind, path: source.path,
        ...(dest !== source ? { to: dest.path } : {}), revision: null, saved: true,
        ...(recovery.has(source.path) ? { recovery: recovery.get(source.path) } : {}), hash: op.kind === 'delete' ? null : hash(bytes) };
      if (op.kind === 'delete') {
        fs.unlinkSync(source.target);
        applied.push(receipt);
        receipt.revision = saveBuffer(source, source.text, null, source.encoding, source.newline);
        continue;
      }
      parents(dest);
      const tmp = path.join(path.dirname(dest.target), `.rimeward-patch-${randomUUID()}`);
      try {
        fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: source.stat?.mode ?? 0o600 });
        if (source.stat) fs.chmodSync(tmp, source.stat.mode & 0o777);
        recheck(source);
        if (dest !== source) recheck(dest);
        if (op.kind === 'add' || dest !== source) fs.linkSync(tmp, dest.target); // Atomic no-clobber publication.
        else fs.renameSync(tmp, dest.target);
        // Record publication immediately, even if source removal or DB persistence fails next.
        applied.push(receipt);
        if (dest !== source) {
          receipt.operation = 'copy';
          recheck(source);
          fs.unlinkSync(source.target);
          receipt.operation = 'move';
          saveBuffer(source, source.text, null, source.encoding, source.newline);
        }
        receipt.revision = saveBuffer(dest, text, bytes, source.encoding, source.newline);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    return { project, ok: true, applied };
  } catch (error) {
    const written = new Set(applied.map(item => item.path));
    const originalError = error instanceof Error ? error.message : String(error);
    let message = originalError.slice(0, 500);
    while (JSON.stringify(message).length > 1000) message = message.slice(0, Math.floor(message.length * 0.8));
    return { project, ok: false, error: message, error_truncated: message !== originalError, applied, created_directory_count: createdDirectories.length,
      unapplied_recovery: [...recovery].filter(([file]) => !written.has(file)).map(([file, id]) => ({ path: file, id })),
      note: 'I/O failed; applied entries are disk writes already made. A null revision means buffer persistence did not finish. Inspect disk and recovery before retrying; no rollback was attempted.' };
  } finally {
    for (const event of events) emitDev(event.user, 'buffer', event.project, { path: event.path });
    // Even a partial I/O failure must invalidate directory/file views.
    emitDev(user, 'project', project);
  }
}
