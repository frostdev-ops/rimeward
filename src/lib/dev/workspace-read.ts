import { DevError } from './runtime.ts';
import { resolveWorkspacePath, workspacePath, type WorkspaceBinding } from './workspace-contract.ts';

export interface WorkspaceSearchPage {
  matches: { path: string; line: number; text: string }[];
  complete: boolean;
  next?: number;
  scanned?: number;
  unavailable?: { mount: string; error: string }[];
  hint?: string;
  scope?: unknown;
}
type ReadRoot = (runtimeId: string, rootId: string, operation: string, args: Record<string, unknown>) => Promise<unknown>;
// ponytail: 2^40 positions per root keep numeric cursors; use opaque cursors if a single root exceeds that ceiling.
const ROOT_CURSOR = 2 ** 40;

/** One bounded source page per call. The cursor advances through every root under virtual /. */
export async function searchWorkspace(binding: WorkspaceBinding, args: Record<string, unknown>, read: ReadRoot): Promise<WorkspaceSearchPage> {
  const scope = workspacePath(String(args.path ?? binding.cwd), binding.cwd), cursor = Number(args.cursor ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DevError('Invalid workspace search cursor.');
  const scopes = scope === '/' ? binding.mounts.slice().sort((a, b) => a.mountPath.localeCompare(b.mountPath)) : binding.mounts.filter(m => m.id === resolveWorkspacePath(binding, scope).mountId);
  const index = Math.floor(cursor / ROOT_CURSOR), offset = cursor % ROOT_CURSOR, mount = scopes[index];
  if (!mount) throw new DevError('Search cursor does not belong to this path. Start the search again.');
  const nextRoot = index + 1 < scopes.length ? (index + 1) * ROOT_CURSOR : undefined;
  const prefix = mount.mountPath === '/' ? '/' : `${mount.mountPath}/`;
  const relative = scope === '/' ? '' : resolveWorkspacePath(binding, scope).relativePath;
  try {
    if (binding.unavailableMountIds?.includes(mount.id)) throw new DevError('This folder is unavailable for this run.', 503);
    const primary = binding.mounts.find(m => m.mountPath === '/');
    if (!primary) throw new DevError('Workspace has no primary folder.');
    // A physical folder that appeared under a mount name would make search results ambiguous.
    for (const candidate of scope === '/' ? scopes.filter(m => m.mountPath !== '/') : mount.mountPath === '/' ? [] : [mount]) {
      let exists = false;
      try { await read(primary.runtimeId, primary.rootId, 'stat', { path: candidate.mountPath.slice(1) }); exists = true; }
      catch (error) { const e = error as { status?: number; code?: string | number }; if (![404, 2, 'ENOENT'].includes(e.status ?? e.code ?? '')) throw error; }
      if (exists) throw new DevError(`Mount ${candidate.mountPath} hides a primary folder entry. Rename the mount.`, 409);
    }
    const page = await read(mount.runtimeId, mount.rootId, 'search', { ...args, path: relative, cursor: offset, virtualPrefix: prefix }) as WorkspaceSearchPage;
    if (page.next !== undefined && (!Number.isSafeInteger(page.next) || page.next < 0 || page.next >= ROOT_CURSOR || page.next <= offset)) throw new DevError('The source returned an invalid search continuation.', 502);
    const next = page.next === undefined ? nextRoot : index * ROOT_CURSOR + page.next;
    return { ...page, matches: page.matches.map(match => ({ ...match, path: workspacePath(`${prefix}${match.path}`) })), complete: next === undefined && page.complete !== false,
      ...(page.complete === false && page.next === undefined ? { unavailable: [{ mount: mount.mountPath, error: 'The source stopped without a continuation. Narrow the search path and retry.' }] } : {}),
      ...(next === undefined ? { next: undefined } : { next }), scope: { path: scope, mount: mount.mountPath },
      hint: `${page.hint ?? ''} Continue with the same query and path until no next cursor remains. Unavailable folders reported on any page remain unsearched.`.trim() };
  } catch (error) {
    if (mount.mountPath === '/' || (error as { status?: number }).status === 409) throw error;
    return { matches: [], complete: false, ...(nextRoot === undefined ? {} : { next: nextRoot }), unavailable: [{ mount: mount.mountPath, error: (error instanceof Error ? error.message : String(error)).slice(0, 400) }],
      scope: { path: scope, mount: mount.mountPath }, hint: 'This folder was not searched. Other folders can still be searched; retry this path after reconnecting.' };
  }
}
