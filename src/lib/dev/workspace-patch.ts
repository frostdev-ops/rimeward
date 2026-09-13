import { createHash, randomUUID } from 'node:crypto';
import { DevError } from './runtime.ts';
import { parsePatch, patchPath } from './patch.ts';
import { resolveWorkspacePath, workspacePath, type WorkspaceBinding } from './workspace-contract.ts';
import { assertWorkspaceBinding, workspaceDispatch } from './workspaces.ts';

type Group = { runtimeId: string; rootId: string; chunks: string[]; revisions: Record<string, number>; paths: Map<string, string> };
type Prepared = Group & { planId: string };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 700);

/** Full preflight precedes commits. Each authority retains a durable, non-replayable receipt. */
export async function runWorkspacePatch(user: number, binding: WorkspaceBinding, args: Record<string, unknown>, owner: string, signal?: AbortSignal) {
  const operations = parsePatch(args.patch), raw = String(args.patch).replace(/\r\n/g, '\n');
  const chunks = raw.split(/(?=^\*\*\* (?:Add|Update|Delete) File: )/m).slice(1);
  const groups = new Map<string, Group>(), used = new Set<string>();
  const operationId = randomUUID();
  for (const [i, op] of operations.entries()) {
    const ref = resolveWorkspacePath(binding, op.path, binding.cwd), key = JSON.stringify([ref.runtimeId, ref.rootId]);
    let group = groups.get(key);
    if (!group) { group = { runtimeId: ref.runtimeId, rootId: ref.rootId, chunks: [], revisions: {}, paths: new Map() }; groups.set(key, group); }
    for (const file of [op.path, ...(op.kind === 'update' && op.move ? [op.move] : [])]) {
      const target = resolveWorkspacePath(binding, file, binding.cwd);
      if (target.runtimeId !== ref.runtimeId || target.rootId !== ref.rootId) throw new DevError('Cross-root patch moves require workspace_transfer.');
      const identity = JSON.stringify([target.runtimeId, target.rootId, target.relativePath]);
      if (used.has(identity)) throw new DevError('Patch aliases the same file more than once.');
      used.add(identity); group.paths.set(target.relativePath, target.virtualPath);
    }
    let chunk = (chunks[i] ?? '').replace(/\n\*\*\* End Patch\s*$/, '').replace(/^(\*\*\* (?:Add|Update|Delete) File: ).+$/m, (_, prefix: string) => `${prefix}${ref.relativePath}`);
    if (op.kind === 'update' && op.move) {
      const dest = resolveWorkspacePath(binding, op.move, binding.cwd);
      chunk = chunk.replace(/^\*\*\* Move to: .+$/m, () => `*** Move to: ${dest.relativePath}`);
    }
    group.chunks.push(chunk.replace(/\n$/, ''));
  }
  if (args.expected_revisions !== undefined) {
    if (!args.expected_revisions || typeof args.expected_revisions !== 'object' || Array.isArray(args.expected_revisions)) throw new DevError('expected_revisions must map paths to integer revisions.');
    for (const [file, revision] of Object.entries(args.expected_revisions)) {
      if (!Number.isSafeInteger(revision) || Number(revision) < 0) throw new DevError('Expected revisions must be nonnegative integers.');
      const ref = resolveWorkspacePath(binding, patchPath(file), binding.cwd), group = groups.get(JSON.stringify([ref.runtimeId, ref.rootId]));
      if (!group?.paths.has(ref.relativePath)) throw new DevError('An expected revision does not name a patch path.');
      group.revisions[ref.relativePath] = Number(revision);
    }
  }
  const manifest = [...groups.values()].flatMap(g => [...g.paths.values()].map(path => ({ path, runtimeId: g.runtimeId, rootId: g.rootId, operation: 'update', saved: true, revision: Number.MAX_SAFE_INTEGER, recovery: Number.MAX_SAFE_INTEGER, hash: '0'.repeat(64) })));
  if (JSON.stringify(manifest).length > 9000) throw new DevError('Patch receipts would exceed the result limit; use a smaller batch.');
  const prepared: Prepared[] = [], resources = new Set<string>(), applied: Record<string, unknown>[] = [], finished = new Set<string>();
  let sourceBytes = 0, dispatched: Prepared | undefined, renewalFailure: unknown, renewTimer: NodeJS.Timeout | undefined;
  const invoke = (p: Pick<Group, 'runtimeId' | 'rootId'>, operation: string, extra: Record<string, unknown>, requestSignal = signal) =>
    workspaceDispatch(user, p.runtimeId, 'operation', { rootId: p.rootId, operation, args: extra, owner }, requestSignal);
  const renew = () => Promise.all(prepared.filter(p => !finished.has(p.planId)).map(p => invoke(p, 'patch-renew', { planId: p.planId })));
  const describe = (p: Group, receipt: Record<string, unknown>) => ({ ...receipt, runtimeId: p.runtimeId, rootId: p.rootId,
    ...(typeof receipt.path === 'string' ? { path: p.paths.get(receipt.path) ?? receipt.path } : {}),
    ...(typeof receipt.to === 'string' ? { to: p.paths.get(receipt.to) ?? receipt.to } : {}) });
  try {
    for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      signal?.throwIfAborted();
      const result = await invoke(group, 'patch-prepare', { operationId, patch: `*** Begin Patch\n${group.chunks.join('\n')}\n*** End Patch`, ...(Object.keys(group.revisions).length ? { expected_revisions: group.revisions } : {}) });
      if (typeof result.planId !== 'string') throw new DevError('Invalid patch preparation receipt.');
      prepared.push({ ...group, planId: result.planId });
      if (!Array.isArray(result.resources) || !Number.isSafeInteger(result.sourceBytes) || result.sourceBytes < 0 || !['local', 'ssh'].includes(result.resourceScope)) throw new DevError('Invalid patch preparation capabilities.');
      for (const resource of result.resources) { const key = result.resourceScope === 'ssh' ? resource : `${group.runtimeId}:${resource}`; if (typeof resource !== 'string' || resources.has(key)) throw new DevError('Patch aliases the same physical file across mounted roots.'); resources.add(key); }
      sourceBytes += result.sourceBytes;
      if (sourceBytes > 20 * 1024 * 1024) throw new DevError('Patch sources exceed 20 MiB.');
      await renew();
    }
    await assertWorkspaceBinding(user, binding);
    renewTimer = setInterval(() => { void renew().catch(error => { renewalFailure = error; }); }, 10_000);
    for (const plan of prepared) {
      signal?.throwIfAborted();
      if (renewalFailure) throw renewalFailure;
      await assertWorkspaceBinding(user, binding);
      dispatched = plan;
      const result = await invoke(plan, 'patch-commit', { planId: plan.planId });
      for (const receipt of result.applied ?? []) applied.push(describe(plan, receipt));
      if (!result.ok) return { ...result, workspaceId: binding.workspaceId, operationId, applied, note: 'Inspect workspace_receipt for this operation before proposing another mutation. No rollback or replay was attempted.' };
      finished.add(plan.planId);
      dispatched = undefined;
    }
    return { ok: true, workspaceId: binding.workspaceId, operationId, applied };
  } catch (error) {
    return { ok: false, workspaceId: binding.workspaceId, operationId, applied, uncertain: !!dispatched,
      ...(dispatched ? { uncertainRoot: { runtimeId: dispatched.runtimeId, rootId: dispatched.rootId }, paths: [...dispatched.paths.values()] } : { notRun: !applied.length }),
      error: message(error), note: 'Inspect workspace_receipt and current files on the same hosts before retrying. No rollback or replay was attempted.' };
  } finally {
    clearInterval(renewTimer);
    await Promise.allSettled(prepared.map(p => invoke(p, 'patch-release', { planId: p.planId }, AbortSignal.timeout(5000))));
  }
}

export async function workspacePatchStatus(user: number, binding: WorkspaceBinding, operationId: string, owner: string, signal?: AbortSignal, options: { path?: string; cursor?: number } = {}) {
  if (operationId && !/^[a-f0-9-]{36}$/i.test(operationId)) throw new DevError('Invalid workspace operation ID.');
  const selected = options.path === undefined ? undefined : resolveWorkspacePath(binding, options.path, binding.cwd);
  const mounts = binding.mounts.filter(m => !selected || m.rootId === selected.rootId && m.runtimeId === selected.runtimeId);
  const results = await Promise.all([...new Map(mounts.map(m => [JSON.stringify([m.runtimeId, m.rootId]), m])).values()].map(async m => {
    try { return { runtimeId: m.runtimeId, mountPath: m.mountPath, ...await workspaceDispatch(user, m.runtimeId, 'operation', { rootId: m.rootId, operation: operationId ? 'patch-status' : 'patch-recent', args: { operationId, cursor: options.cursor }, owner }, signal) }; }
    catch (error) { return { runtimeId: m.runtimeId, rootId: m.rootId, operationId, state: 'unavailable', error: message(error) }; }
  }));
  if (!operationId) return { recent: results.flatMap(r => (r.recent ?? []).map((entry: Record<string, unknown>) => ({ ...entry, runtimeId: r.runtimeId }))).sort((a: { updated: number }, b: { updated: number }) => b.updated - a.updated).slice(0, 10), unavailable: results.filter(r => r.state === 'unavailable') };
  const receipt = { operationId, results: results.filter(r => r.state !== 'not-found') };
  if (JSON.stringify(receipt).length > 10_000) return { operationId, results: receipt.results.map(r => ({ runtimeId: r.runtimeId, rootId: r.rootId, mountPath: r.mountPath, state: r.state, counts: r.counts, total: r.total })), note: 'Read one mounted folder with path and follow its next cursor for complete phase receipts.' };
  return receipt;
}

export async function runWorkspaceTransfer(user: number, binding: WorkspaceBinding, args: Record<string, unknown>, owner: string, signal?: AbortSignal) {
  if (!['copy', 'move'].includes(String(args.mode))) throw new DevError('Choose copy or move.');
  const source = resolveWorkspacePath(binding, String(args.source), binding.cwd), destination = resolveWorkspacePath(binding, String(args.destination), binding.cwd);
  if (source.runtimeId === destination.runtimeId && source.rootId === destination.rootId && source.relativePath === destination.relativePath) throw new DevError('Source and destination are the same file.');
  const operationId = randomUUID();
  const stat = await workspaceDispatch(user, source.runtimeId, 'operation', { rootId: source.rootId, operation: 'stat', args: { path: source.relativePath }, owner }, signal);
  if (stat.isSymbolicLink) throw new DevError('Transfers do not follow symbolic links.');
  if (stat.isDirectory) {
    if (!source.relativePath || !destination.relativePath) throw new DevError('Transfer a directory inside a mount; mounted roots cannot be moved or replaced.');
    if (args.mode === 'move' && source.runtimeId === destination.runtimeId && source.rootId === destination.rootId) {
      await assertWorkspaceBinding(user, binding);
      try { return { operationId, ...await workspaceDispatch(user, source.runtimeId, 'operation', { rootId: source.rootId, operation: 'rename-directory', args: { path: source.relativePath, to: destination.relativePath, operationId }, owner }, signal) }; }
      catch (error) { return { ok: false, operationId, uncertain: true, source: source.virtualPath, destination: destination.virtualPath, error: message(error), note: 'Inspect both directory paths and the operation receipt before another rename.' }; }
    }
    return transferDirectory(user, binding, args, owner, operationId, signal);
  }
  if (!stat.isFile) throw new DevError('Transfer only regular files or directories.');
  return transferFile(user, binding, args, owner, operationId, signal, undefined, Number(stat.mode) & 0o777);
}

async function transferFile(user: number, binding: WorkspaceBinding, args: Record<string, unknown>, owner: string, operationId: string, signal?: AbortSignal, expectedHash?: string, permissions?: number) {
  const source = resolveWorkspacePath(binding, String(args.source), binding.cwd), destination = resolveWorkspacePath(binding, String(args.destination), binding.cwd);
  let copied = false, deleted = false, pending: 'copy' | 'delete' | undefined;
  const invoke = (ref: typeof source, operation: string, values: Record<string, unknown>) => workspaceDispatch(user, ref.runtimeId, 'operation', { rootId: ref.rootId, operation, args: { path: ref.relativePath, ...values }, owner }, signal);
  try {
    const data = await invoke(source, 'bytes', {});
    const digest = createHash('sha256').update(Buffer.from(String(data.data), 'base64')).digest('hex');
    if (expectedHash !== undefined && digest !== expectedHash) throw new DevError('A source file changed after the directory inventory.');
    if (args.mode === 'move') await invoke(source, 'mutation-check', { deleting: true, expectedHash: digest });
    await invoke(destination, 'mutation-check', { data: data.data, expectedHash: null });
    signal?.throwIfAborted(); await assertWorkspaceBinding(user, binding);
    pending = 'copy';
    const receipt = await invoke(destination, 'write-bytes', { operationId, data: data.data, expectedHash: null, permissions });
    if (!receipt.ok) throw new DevError('Destination write did not complete.');
    copied = true; pending = undefined;
    const verified = await invoke(destination, 'bytes', {});
    if (createHash('sha256').update(Buffer.from(String(verified.data), 'base64')).digest('hex') !== digest) throw new DevError('Destination verification failed; the source was preserved.');
    if (args.mode === 'move') {
      signal?.throwIfAborted(); await assertWorkspaceBinding(user, binding);
      pending = 'delete';
      const removal = await invoke(source, 'remove', { operationId, expectedHash: digest });
      if (!removal.ok) throw new DevError('Source deletion did not complete.');
      deleted = true; pending = undefined;
    }
    return { ok: true, operationId, copied, deleted, source: source.virtualPath, destination: destination.virtualPath, hash: digest };
  } catch (error) {
    return { ok: false, operationId, copied: pending === 'copy' ? null : copied, deleted: pending === 'delete' ? null : deleted, uncertain: pending !== undefined, pending,
      source: source.virtualPath, destination: destination.virtualPath, error: message(error),
      note: 'Inspect workspace_receipt and both current paths. A lost copy/delete response does not establish that the operation failed. No replay or rollback was attempted.' };
  }
}

async function transferDirectory(user: number, binding: WorkspaceBinding, args: Record<string, unknown>, owner: string, operationId: string, signal?: AbortSignal) {
  const source = workspacePath(String(args.source), binding.cwd), destination = workspacePath(String(args.destination), binding.cwd);
  const invoke = async (file: string, operation: string, values: Record<string, unknown> = {}) => {
    const ref = resolveWorkspacePath(binding, file, binding.cwd);
    const result = await workspaceDispatch(user, ref.runtimeId, 'operation', { rootId: ref.rootId, operation, args: { path: ref.relativePath, ...values }, owner }, signal);
    if (result?.ok === false) throw new DevError(typeof result.error === 'string' ? result.error : `${operation} did not complete for ${file}.`);
    return result;
  };
  const files: { source: string; destination: string; hash: string; mode: number }[] = [], directories: { source: string; destination: string; mode: number }[] = [];
  const pending = [{ source, destination }], seen = new Set<string>(), names = new Set<string>();
  let bytes = 0, entries = 0, copiedFiles = 0, deletedFiles = 0, createdDirectories = 0, removedDirectories = 0, published = false, uncertainPath: string | undefined;
  const missing = (e: unknown) => [404, 2, 'ENOENT'].includes((e as { status?: number; code?: number | string }).status ?? (e as { code?: number | string }).code ?? '');
  try {
    const [from, to] = await Promise.all([invoke(source, 'location'), invoke(destination, 'location')]);
    if (typeof from.key !== 'string' || !Array.isArray(to.ancestors) || !['local', 'ssh'].includes(from.scope) || !['local', 'ssh'].includes(to.scope)) throw new DevError('Cannot verify transfer locations.');
    const sameDomain = from.scope === 'ssh' && to.scope === 'ssh' || from.scope === 'local' && to.scope === 'local' && resolveWorkspacePath(binding, source).runtimeId === resolveWorkspacePath(binding, destination).runtimeId;
    if (sameDomain && (from.key === to.key || to.ancestors.includes(from.key))) throw new DevError('A directory cannot be copied into itself or a descendant through another mount.');
    try { await invoke(destination, 'stat'); throw new DevError('Destination directory already exists.'); } catch (e) { if (!missing(e)) throw e; }
    while (pending.length) {
      signal?.throwIfAborted();
      const dir = pending.pop() as { source: string; destination: string }, stat = await invoke(dir.source, 'stat');
      const identity = (await invoke(dir.source, 'location')).key;
      if (!stat.isDirectory || stat.isSymbolicLink || seen.has(identity)) throw new DevError('Directory inventory contains a link, cycle or changed directory.');
      seen.add(identity); directories.push({ ...dir, mode: Number(stat.mode) & 0o777 });
      let cursor = 0;
      for (;;) {
        const page = await invoke(dir.source, 'transfer-tree', { cursor });
        if (!Array.isArray(page.entries)) throw new DevError('Directory inventory is incomplete.');
        for (const entry of page.entries) {
          if (++entries > 1000) throw new DevError('Directory transfers support at most 1000 entries; no destination was created.');
          if (typeof entry.name !== 'string' || !entry.name || ['.', '..', '.git'].includes(entry.name.toLowerCase()) || /[/\\\0]/.test(entry.name) || entry.symlink || entry.isSymbolicLink) throw new DevError('Directory transfers refuse links, Git metadata and unsupported entries.');
          const child = { source: workspacePath(entry.name, dir.source), destination: workspacePath(entry.name, dir.destination) };
          const target = resolveWorkspacePath(binding, child.destination, binding.cwd); patchPath(target.relativePath);
          const name = child.destination.normalize('NFC').toLowerCase();
          if (names.has(name)) throw new DevError('Directory transfer contains colliding destination names.'); names.add(name);
          const info = await invoke(child.source, 'stat');
          if (info.isSymbolicLink) throw new DevError('Directory transfers do not follow links.');
          if (info.isDirectory) pending.push(child);
          else if (info.isFile) {
            const data = await invoke(child.source, 'bytes'), content = Buffer.from(String(data.data), 'base64'); bytes += content.length;
            if (content.length > 5 * 1024 * 1024 || bytes > 100 * 1024 * 1024) throw new DevError('Directory transfer exceeds 5 MiB per file or 100 MiB total; no destination was created.');
            files.push({ ...child, hash: createHash('sha256').update(content).digest('hex'), mode: Number(info.mode) & 0o777 });
          } else throw new DevError('Directory transfers contain only regular files and directories.');
        }
        if (page.next === undefined) { if (page.complete !== true) throw new DevError('Directory inventory is incomplete.'); break; }
        if (!Number.isSafeInteger(page.next) || page.next <= cursor) throw new DevError('Invalid directory continuation.'); cursor = page.next;
      }
    }
    // All inventory limits and known source/destination failures precede publication.
    await invoke(destination, 'mutation-check', { data: '', expectedHash: null });
    for (const file of files) {
      await invoke(file.destination, 'mutation-check', { data: '', expectedHash: null });
      if (args.mode === 'move') await invoke(file.source, 'mutation-check', { deleting: true, expectedHash: file.hash });
    }
    await assertWorkspaceBinding(user, binding); signal?.throwIfAborted();
    const parent = workspacePath('..', destination);
    try { await invoke(parent, 'stat'); } catch (e) { if (!missing(e)) throw e; uncertainPath = parent; await invoke(parent, 'mkdir', { recursive: true, operationId }); uncertainPath = undefined; }
    for (const dir of directories.slice().sort((a, b) => a.destination.length - b.destination.length)) {
      uncertainPath = dir.destination; await invoke(dir.destination, 'mkdir', { recursive: false, operationId }); uncertainPath = undefined; published = true; createdDirectories++;
    }
    for (const file of files) {
      const result = await transferFile(user, binding, { source: file.source, destination: file.destination, mode: 'copy' }, owner, operationId, signal, file.hash, file.mode);
      if (!result.ok) { if (result.uncertain) uncertainPath = file.destination; throw new DevError(result.error ?? 'File transfer did not complete.'); }
      copiedFiles++;
    }
    for (const dir of directories.slice().sort((a, b) => b.destination.length - a.destination.length)) { uncertainPath = dir.destination; await invoke(dir.destination, 'chmod', { mode: dir.mode }); uncertainPath = undefined; }
    // Verify the entire destination before deleting any source file.
    for (const file of files) {
      const copied = Buffer.from(String((await invoke(file.destination, 'bytes')).data), 'base64');
      if (createHash('sha256').update(copied).digest('hex') !== file.hash) throw new DevError('Destination changed before full verification; all source files were preserved.');
      if (args.mode === 'move') await invoke(file.source, 'mutation-check', { deleting: true, expectedHash: file.hash });
    }
    if (args.mode === 'move') {
      for (const file of files) { signal?.throwIfAborted(); await assertWorkspaceBinding(user, binding); uncertainPath = file.source; await invoke(file.source, 'remove', { expectedHash: file.hash, operationId }); uncertainPath = undefined; deletedFiles++; }
      for (const dir of directories.slice().sort((a, b) => b.source.length - a.source.length)) { uncertainPath = dir.source; await invoke(dir.source, 'rmdir', { operationId }); uncertainPath = undefined; removedDirectories++; }
    }
    return { ok: true, operationId, directory: true, source, destination, copiedFiles, deletedFiles, createdDirectories, removedDirectories };
  } catch (error) {
    return { ok: false, operationId, directory: true, source, destination, copiedFiles, deletedFiles, createdDirectories, removedDirectories, uncertain: uncertainPath !== undefined, uncertainPath,
      notRun: !published && uncertainPath === undefined, error: message(error), note: 'Inspect paged workspace_receipt and both directory trees. Known counts exclude uncertain actions. No rollback or automatic replay was attempted.' };
  }
}
