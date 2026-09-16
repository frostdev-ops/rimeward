/** Shared logical workspace contracts. No native paths, credentials or runtime imports. */
export const WORKSPACE_CONSUMERS = ['agent', 'terminal', 'editor', 'project-files', 'changes'] as const;
export interface WorkspaceMount {
  id: string;
  mountPath: string;
  runtimeId: string;
  rootId: string;
  instructionsPath?: string;
}
export interface WorkspaceDefinition {
  workspaceId: string;
  revision: number;
  mounts: WorkspaceMount[];
}
export interface WorkspaceBinding extends WorkspaceDefinition {
  definitionFingerprint: string;
  consumerWardId: string;
  runOwnerRuntimeId: string;
  cwd: string;
  unavailableMountIds?: string[];
}
export interface WorkspaceFileRef {
  mountId: string;
  runtimeId: string;
  rootId: string;
  relativePath: string;
  virtualPath: string;
}
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/;
const validId = (v:unknown): v is string => typeof v === 'string' && identifier.test(v);
export function workspacePath(value: string, cwd = '/'): string {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\')) throw Error('Use a virtual workspace path with forward slashes.');
  const parts: string[] = [];
  for (const part of (value.startsWith('/') ? value : `${cwd}/${value}`).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw Error('Path leaves the workspace.'); parts.pop(); }
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}
export function validateWorkspaceDefinition(value: unknown): WorkspaceDefinition {
  const v = value as WorkspaceDefinition | null;
  if (!v || !validId(v.workspaceId) || !Number.isSafeInteger(v.revision) || v.revision < 1 || !Array.isArray(v.mounts) || !v.mounts.length || v.mounts.length > 16) throw Error('Invalid workspace definition.');
  const ids = new Set<string>(), paths = new Set<string>();
  const mounts = v.mounts.map(m => {
    if (!m || !validId(m.id) || !validId(m.runtimeId) || ['local','server'].includes(m.runtimeId) || !validId(m.rootId) || typeof m.mountPath !== 'string' ||
      !/^\/(?:[a-zA-Z0-9][a-zA-Z0-9._-]{0,63})?$/.test(m.mountPath) || ids.has(m.id) || paths.has(m.mountPath.toLowerCase())) throw Error('Workspace folders need unique IDs and distinct /name mount paths.');
    ids.add(m.id); paths.add(m.mountPath.toLowerCase());
    if (m.instructionsPath !== undefined && (typeof m.instructionsPath !== 'string' || !m.instructionsPath || m.instructionsPath.startsWith('/') || workspacePath(m.instructionsPath).slice(1) !== m.instructionsPath)) throw Error('Choose an instruction file inside its mounted folder.');
    return { id:m.id, mountPath:m.mountPath, runtimeId:m.runtimeId, rootId:m.rootId, ...(m.instructionsPath ? { instructionsPath:m.instructionsPath } : {}) };
  });
  if (!paths.has('/')) throw Error('Choose one primary workspace folder.');
  return { workspaceId:v.workspaceId, revision:v.revision, mounts };
}
/** Exact canonical identity, not an authorization secret; avoids hash collisions and browser dependencies. */
export function workspaceFingerprint(value: WorkspaceDefinition): string {
  const v = validateWorkspaceDefinition(value);
  return JSON.stringify({ workspaceId:v.workspaceId, mounts:v.mounts.slice().sort((a,b) => a.mountPath < b.mountPath ? -1 : a.mountPath > b.mountPath ? 1 : 0) });
}
export function resolveWorkspacePath(binding: WorkspaceDefinition, value: string, cwd = '/'): WorkspaceFileRef {
  const virtualPath = workspacePath(value, cwd);
  const mount = binding.mounts.find(m => m.mountPath !== '/' && (virtualPath === m.mountPath || virtualPath.startsWith(`${m.mountPath}/`))) ?? binding.mounts.find(m => m.mountPath === '/');
  if (!mount) throw Error('Workspace has no primary folder.');
  if ('unavailableMountIds' in binding && (binding as WorkspaceBinding).unavailableMountIds?.includes(mount.id)) throw Error(`Workspace folder ${mount.mountPath} is unavailable for this run.`);
  return { mountId:mount.id, runtimeId:mount.runtimeId, rootId:mount.rootId, virtualPath,
    relativePath:mount.mountPath === '/' ? virtualPath.slice(1) : virtualPath.slice(mount.mountPath.length).replace(/^\//,'') };
}
