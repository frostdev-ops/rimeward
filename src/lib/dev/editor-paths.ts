import { workspacePath } from './workspace-contract.ts';

/** Normalize view/checkpoint keys only; native buffer/root identities stay unchanged. */
export function normalizeEditorPaths<T>(state: { tabs?: string[]; active?: string }, files?: Record<string, T>): { tabs?: string[]; active?: string; files?: Record<string, T> } {
  return {
    ...(state.tabs ? { tabs: [...new Set(state.tabs.map(path => workspacePath(path)))] } : {}),
    ...(state.active ? { active: workspacePath(state.active) } : {}),
    ...(files ? { files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => Number(a.startsWith('/')) - Number(b.startsWith('/'))).map(([path, value]) => [workspacePath(path), value])) } : {}),
  };
}
