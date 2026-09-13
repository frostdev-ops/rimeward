import { getDashboard } from '../dashboard.ts';
import { sharedRime } from './sync.ts';
import { PERMISSION_MODES, isPermissionMode, type PermissionMode } from '../dev/types.ts';
import { defaultAgentProvider, isAgentProvider, DEFAULT_MODELS, AGENT_EFFORTS, type AgentEffort, type AgentProviderId } from './provider.ts';

export const HEADLESS_PER_HOUR = 6; // per ward — the agent.ask ↔ agent-replied loop brake
export type ApprovalsPolicy = 'outbound' | 'all' | 'off';
/** How a coding CLI (Claude Code, Codex) that this ward launches handles permissions — the
 *  same ranked list the terminal side uses (lib/dev/types.ts). */
export const CLI_PERMISSIONS = PERMISSION_MODES;
export type CliPermissions = PermissionMode;

export interface AgentWardConfig {
  provider: AgentProviderId;
  /** provider 'compat': which of the user's endpoints. */
  endpoint?: string;
  model: string;
  persona: string;
  tools: 'all' | 'read-only';
  approvals: ApprovalsPolicy;
  /** Permissions for the coding CLIs this ward launches (terminal_start). Always set by agentWardConfig;
   *  optional only so hand-built configs (tests, forks) read as 'normal'. Stored on the ward only when
   *  the user picked one; absent inherits the paired server Rime's setting, else normal. */
  permissions?: CliPermissions;
  effort: AgentEffort;
  /** Unattended runs per hour on this ward (agent.ask, agent-to-agent, chat bots); 0 = no cap. */
  headlessCap: number;
  /** Tool rounds per turn on this ward; absent = the account setting, 0 = no cap. */
  rounds?: number;
}

/** The stored agent ward's config — from the STORED layout, never the client. */
export function agentWardConfig(userId: number, ward: string): AgentWardConfig | null {
  const w = getDashboard(userId).find((x) => x.i === ward && x.type === 'agent');
  if (!w) return null;
  const shared = sharedRime(userId)?.config;
  const provider: AgentProviderId = isAgentProvider(w.config?.provider) ? w.config.provider : defaultAgentProvider(userId);
  const c = { ...shared, ...(shared?.provider !== provider ? {model: undefined, effort: undefined} : {}), ...w.config } as Record<string, unknown>;
  return {
    provider,
    ...(provider === 'compat' && typeof c.endpoint === 'string' && c.endpoint ? { endpoint: c.endpoint } : {}),
    model: typeof c.model === 'string' && c.model.trim() ? c.model.trim() : DEFAULT_MODELS[provider],
    persona: typeof c.persona === 'string' ? c.persona : '',
    tools: c.tools === 'read-only' ? 'read-only' : 'all',
    approvals: c.approvals === 'all' || c.approvals === 'off' ? c.approvals : 'outbound',
    permissions: (CLI_PERMISSIONS as readonly unknown[]).includes(c.permissions) ? (c.permissions as CliPermissions) : 'normal',
    effort: (AGENT_EFFORTS as readonly string[]).includes(c.effort as string) ? (c.effort as AgentEffort) : 'medium',
    headlessCap: Number.isInteger(c.headlessCap) && (c.headlessCap as number) >= 0 ? (c.headlessCap as number) : HEADLESS_PER_HOUR,
    ...(Number.isInteger(c.rounds) && (c.rounds as number) >= 0 ? { rounds: c.rounds as number } : {}),
  };
}

/** The mode a ward with no pick of its own runs at: the paired server Rime's setting, else normal.
 *  What "Default" means in the ⚙ dialog and the chat footer — shown there, so choosing Default is
 *  never a blind change. */
export function inheritedCliPermissions(userId: number): CliPermissions {
  const shared = sharedRime(userId)?.config.permissions;
  return isPermissionMode(shared) ? shared : 'normal';
}
/** Both numbers the pickers need: what this ward runs at, and what Default would make it. */
export function cliPermissionState(userId: number, ward: string): { effective: CliPermissions; inherited: CliPermissions } | null {
  const cfg = agentWardConfig(userId, ward);
  return cfg ? { effective: cfg.permissions ?? 'normal', inherited: inheritedCliPermissions(userId) } : null;
}
