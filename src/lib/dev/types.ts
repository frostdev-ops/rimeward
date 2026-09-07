// Shared desktop contracts. This module is safe to import in the browser.
export type PermissionMode = "human" | "rimeward" | "yolo";
export type TerminalKind = "shell" | "codex" | "claude";
export interface Project {
  id: string;
  name: string;
  root: string;
}
export interface BufferView {
  project: string;
  path: string;
  text: string;
  revision: number;
  dirty: boolean;
  readonly: boolean;
  conflict: boolean;
  diskText?: string;
  owner: string | null;
  encoding?: string;
  newline?: string;
}
export interface SessionView {
  id: string;
  project: string;
  kind: TerminalKind;
  mode: PermissionMode;
  nextMode: PermissionMode;
  agentInput: boolean;
  title: string;
  state: "running" | "exited" | "interrupted";
  exitCode: number | null;
  exitSignal?: number | null;
  terminationReason?: string | null;
  owner: string | null;
  cols: number;
  rows: number;
  sequence: number;
  task: string;
  assignment: string;
  review?: string;
  evidence?: { reviewer: string; at: string; sequence: number; diff: string | null; files: { path: string; hash: string | null }[]; checks: { command: string; exitCode: number | null }[]; stale?: boolean };
  taskState: "active" | "needs-attention" | "done" | "cancelled";
}
/** Older session responses have no termination metadata; do not guess their signals. */
export function terminalExitLabel(session: Pick<SessionView, 'state' | 'exitCode' | 'exitSignal' | 'terminationReason'>): string {
  const label = session.terminationReason === 'cancelled' ? 'Cancelled' :
    session.terminationReason === 'closed' ? 'Terminated' :
    session.state === 'interrupted' || session.terminationReason === 'runtime-interrupted' ? 'Interrupted' :
    session.terminationReason === 'runtime-shutdown' ? 'Stopped on shutdown' :
    session.exitSignal ? 'Terminated' : 'Exited';
  return `${label}${session.exitSignal ? ` · signal ${session.exitSignal}` : session.exitCode == null ? '' : ` · ${session.exitCode}`}`;
}
export interface RuntimeEvent {
  sequence: number;
  type: "project" | "buffer" | "session" | "output" | "reset" | "ward";
  id: string;
  data?: unknown;
}
export const DEV_WARDS = [
  "project-files",
  "editor",
  "terminal",
  "changes",
] as const;

/** Navigation metadata only. A project path, buffer or conversation is never a page entry. */
export interface WorkspaceEntry {
  id: string;
  name: string;
  kind: "desktop" | "server";
  online: boolean;
  pages: { id: string; title: string }[];
  activePage?: string;
  device?: string;
  server?: string;
  error?: string;
}
export interface WorkspaceNavigation {
  current: string;
  workspaces: WorkspaceEntry[];
}
