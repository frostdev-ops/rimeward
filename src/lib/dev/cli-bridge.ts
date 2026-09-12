// The bridge between a coding CLI Rime launched (Claude Code, Codex) and Rime.
//
// Every such session gets an EPHEMERAL plugin: a temp dir holding hook.mjs, which the
// CLI's lifecycle hooks run. The hook POSTs its stdin JSON to /api/cli/<session>/hook
// on the desktop runtime's loopback address, authenticated by a per-session bearer
// token that exists only here and in the CLI's environment — never the native token.
// Nothing is written to ~/.claude or ~/.codex, and the dir goes with the session.
//
// Phases come from the hooks, not from the screen: PermissionRequest parks the request
// and HOLDS the hook's HTTP response until Rime decides (terminal_decide) — the CLI
// never gets an answer typed into its TTY. Stop carries the last assistant message
// (done), Notification idle_prompt means it is waiting for input, SessionEnd ends it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { getDashboard } from '../dashboard.ts';
import { observe } from '../agent/observation-events.ts';
import { secretEqual } from './native.ts';
import { DevError, isDesktop, workDb } from './runtime.ts';
import type { CliPhase, PermissionMode } from './types.ts';

export type { CliPhase };
export interface CliOrigin { ward: string; conv?: number }
export interface CliLaunch { args: string[]; env: Record<string, string>; cleanup(): void;
  /** Codex only: the positional task with the coordination preamble in front of it. */
  task?: string }

export const PERMISSION_MODES: readonly PermissionMode[] = ['read-only', 'approvals', 'normal', 'yolo'];
/** Rows written before the modes were tied to the agent ward. */
export const LEGACY_MODES: Record<string, PermissionMode> = { human: 'approvals', rimeward: 'normal' };

interface Pending { id: string; tool: string; input: unknown; toolUse: string; at: number; resolve(decision: Record<string, unknown>): void; timer: ReturnType<typeof setTimeout> }
interface Question { id: string; question: string; options?: string[]; at: number; resolve(answer: string): void; timer: ReturnType<typeof setTimeout> }
interface Entry {
  user: number; kind: 'claude' | 'codex'; mode: PermissionMode; origin?: CliOrigin;
  token: string; dir: string; phase: CliPhase | ''; lastMessage: string; seq: number;
  /** rime_report was called in the CURRENT turn: the Stop that follows is the same completion,
   *  not a second one. Cleared by whatever starts the next turn's work. */
  reported: boolean;
  pending: Map<string, Pending>;
  /** rime_ask questions parked for terminal_answer (lib/dev/cli-ask.ts decides the waiting). */
  questions: Map<string, Question>;
}
const registry = new Map<string, Entry>();
const PERMISSION_WAIT_MS = 30 * 60_000;
export const ASK_WAIT_MS = 30 * 60_000;
export const ASK_TIMEOUT_TEXT = 'No answer from Rime within 30 minutes; proceed with your best judgment and say what you assumed.';

const MODE_MEANING: Record<PermissionMode, string> = {
  'read-only': 'read-only: you may inspect but not change files or run mutating commands; report what you would do',
  approvals: 'approvals: every permission prompt is decided by Rime, not by a person at the terminal — keep working while it is pending',
  normal: 'normal (auto): routine actions proceed; the few prompts that remain are decided by Rime',
  yolo: 'yolo: no permission prompts at all — be deliberate about destructive commands',
};
/** The coordination instructions every Rime-launched CLI gets (Claude: appended to the system
 *  prompt; Codex: in front of the task). Plain prose, under 1800 characters. */
export function cliInstructions(session: string, mode: PermissionMode): string {
  return `You were launched by Rime, the Rimeward agent that coordinates this work; a person may also be watching this terminal. This session's permission mode is ${MODE_MEANING[mode]}. Rime is reachable through the "rime" MCP server. Use rime_status for progress worth reporting (a milestone, a blocker, a change of plan), not every step. When you need a decision or a clarification, call rime_ask instead of asking in the terminal; it blocks until Rime answers, so ask once with the options you see. Call rime_context if you need the assignment, the project or the permission mode restated. When the task is complete, or you are blocked, call rime_report exactly once with what changed (files) and what you checked (commands, tests); never claim completion without it. Keep the terminal readable: no walls of output when a summary will do. Session id: ${session}.`;
}

/** The agent ward's `permissions` knob; default normal. Read defensively — validateConfig
 *  learns the key in a parallel change. TODO: what these modes mean for Rime's OWN tool
 *  approvals is deliberately open; today they only shape the CLIs Rime launches. */
export function cliPermissions(user: number, ward?: string): PermissionMode {
  const wards = getDashboard(user);
  const w = ward ? wards.find(x => x.i === ward && x.type === 'agent') : wards.find(x => x.type === 'agent');
  const value = (w?.config as Record<string, unknown> | undefined)?.permissions;
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value) ? (value as PermissionMode) : 'normal';
}

const HOOK_SCRIPT = `// Rimeward CLI hook: forwards the CLI's hook payload to the runtime that launched it.
import { readFileSync } from 'node:fs';
let text = process.argv[2] ?? '';
if (!text) try { text = readFileSync(0, 'utf8'); } catch {}
let payload = {};
try { payload = JSON.parse(text); } catch {}
const permission = payload.hook_event_name === 'PermissionRequest';
const { RIMEWARD_CLI_URL: url, RIMEWARD_CLI_SESSION: session, RIMEWARD_CLI_TOKEN: token } = process.env;
const endpoint = url + '/api/cli/' + session + '/hook';
const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + token };
if (permission) {
  // The CLI ends this process when the prompt is cancelled (Esc, interrupt): say which request died,
  // by its tool_use_id, so the runtime releases exactly that one and nothing else.
  const cancel = async () => {
    try { await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ hook_event_name: 'PermissionRequest', cancelled: true, tool_use_id: payload.tool_use_id }), signal: AbortSignal.timeout(2000) }); } catch {}
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, cancel);
}
try {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: permission ? undefined : AbortSignal.timeout(10000),
  });
  const body = res.status === 204 ? '' : await res.text();
  if (!res.ok) throw new Error(body);
  if (body) process.stdout.write(body);
} catch {
  // Reporting hooks fail open (nothing printed, exit 0); a permission request fails closed.
  if (permission) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Rimeward could not reach its runtime; denied.' } } }));
}
`;

const quote = (s: string) => { if (/["\n\r]/.test(s)) throw new DevError('The hook path cannot contain quotes.'); return `"${s}"`; };
/** JSON string escapes are valid TOML basic-string escapes (\\, \", \n, \uXXXX). */
const toml = (s: string) => JSON.stringify(s);

export function prepareCliLaunch(user: number, session: string, kind: 'claude' | 'codex', mode: PermissionMode, origin?: CliOrigin, task = ''): CliLaunch {
  if (!isDesktop()) throw new DevError('CLI sessions belong on the desktop runtime.', 403);
  const dir = path.join(os.tmpdir(), `rimeward-cli-${session}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const script = path.join(dir, 'hook.mjs');
  fs.writeFileSync(script, HOOK_SCRIPT, { mode: 0o600 });
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const args: string[] = [];
  const token = randomBytes(32).toString('hex');
  const base = process.env.PUBLIC_BASE_URL ?? '';
  const mcpUrl = `${base}/api/cli/${session}/mcp`;
  const instructions = cliInstructions(session, mode);
  // Timeouts: a permission decision waits on Rime (and possibly a human); reports are quick.
  const hook = (timeout: number) => ({ type: 'command', command, timeout });
  if (kind === 'claude') {
    // Plugin layout per code.claude.com/docs/en/plugins: hooks/hooks.json at the plugin root,
    // .claude-plugin/plugin.json the manifest. --plugin-dir loads it for this session only,
    // merging with the user's own hooks (a --settings hooks key would replace them).
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { mode: 0o700 });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'rimeward', description: 'Rimeward session bridge', version: '1.0.0' }));
    fs.mkdirSync(path.join(dir, 'hooks'), { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({
      description: 'Rimeward session bridge',
      hooks: {
        PermissionRequest: [{ hooks: [hook(PERMISSION_WAIT_MS / 1000 + 60)] }],
        Notification: [{ hooks: [hook(15)] }],
        UserPromptSubmit: [{ hooks: [hook(15)] }],
        Stop: [{ hooks: [hook(15)] }],
        SessionStart: [{ hooks: [hook(15)] }],
        SessionEnd: [{ hooks: [hook(5)] }],
      },
    }));
    // .mcp.json at the plugin root (code.claude.com/docs/en/plugins); type http + headers per
    // code.claude.com/docs/en/mcp. The literal token lives in a 0600 file inside a 0700 dir.
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { rime: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });
    args.push('--plugin-dir', dir, '--append-system-prompt', instructions);
  } else {
    // Codex: hook tables ride -c overrides (codex-rs config_override.rs); the key spelling
    // follows the app-server fixtures ([[hooks.SessionEnd]]). `notify` is the older
    // turn-complete path — both may fire; the bridge ignores a repeat of the same phase.
    const table = (timeout: number) => `[{hooks=[{type="command",command=${toml(command)},timeout=${timeout}}]}]`;
    args.push(
      '-c', `hooks.PermissionRequest=${table(PERMISSION_WAIT_MS / 1000 + 60)}`,
      '-c', `hooks.UserPromptSubmit=${table(15)}`,
      '-c', `hooks.Stop=${table(15)}`,
      '-c', `hooks.SessionStart=${table(15)}`,
      '-c', `hooks.SessionEnd=${table(5)}`,
      '-c', `notify=[${toml(process.execPath)},${toml(script)}]`,
      // Streamable HTTP MCP server; the bearer comes from the env (codex-rs config/src/mcp_types.rs).
      '-c', `mcp_servers.rime.url=${toml(mcpUrl)}`,
      '-c', 'mcp_servers.rime.bearer_token_env_var="RIMEWARD_CLI_TOKEN"',
      // Codex parks hooks it has not seen behind a "Hooks need review" screen, which an unattended
      // launch would never pass. The only hooks here are this session's own script in its 0700 dir.
      '--dangerously-bypass-hook-trust',
    );
  }
  registry.set(session, { user, kind, mode, origin, token, dir, phase: '', lastMessage: '', seq: 0, reported: false, pending: new Map(), questions: new Map() });
  return {
    args,
    // Codex has no system-prompt flag: the preamble rides the task, so an interactive session (no task) gets none.
    ...(kind === 'codex' && task ? { task: `${instructions}\n\n${task}` } : {}),
    env: { RIMEWARD_CLI_URL: process.env.PUBLIC_BASE_URL ?? '', RIMEWARD_CLI_SESSION: session, RIMEWARD_CLI_TOKEN: token },
    cleanup() {
      const entry = registry.get(session);
      if (entry?.token === token) { settle(entry, 'The session ended before a decision.'); registry.delete(session); }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function cliState(session: string): { phase: CliPhase; lastMessage?: string; pending?: { id: string; tool: string; input: unknown; at: number } } | null {
  const e = registry.get(session);
  if (!e?.phase) return null;
  const first = [...e.pending.values()].sort((a, b) => a.at - b.at)[0];
  return { phase: e.phase, ...(e.lastMessage ? { lastMessage: e.lastMessage } : {}), ...(first ? { pending: { id: first.id, tool: first.tool, input: first.input, at: first.at } } : {}) };
}

/** Rime's answer to a parked permission request. False when there is nothing to answer. */
export function decideCli(user: number, session: string, request: string, decision: 'allow' | 'deny', reason?: string): boolean {
  const e = registry.get(session);
  const p = e?.user === user ? e.pending.get(request) : undefined;
  if (!e || !p) return false;
  clearTimeout(p.timer);
  e.pending.delete(request);
  p.resolve(decisionJson(decision, reason));
  if (!e.pending.size) void setPhase(e, session, 'running', 'decision', { request, decision });
  return true;
}

function decisionJson(decision: 'allow' | 'deny', message?: string): Record<string, unknown> {
  // code.claude.com/docs/en/hooks: PermissionRequest → hookSpecificOutput.decision.behavior.
  // Codex mirrors Claude's hook wire format; if it does not decide from this, its own
  // approval flow proceeds (core/hook_runtime.rs) and the TTY prompt is still visible.
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: decision, ...(message ? { message } : {}) } } };
}

function settle(e: Entry, why: string): void {
  for (const p of e.pending.values()) { clearTimeout(p.timer); p.resolve(decisionJson('deny', why)); }
  e.pending.clear();
  for (const q of e.questions.values()) { clearTimeout(q.timer); q.resolve(ASK_TIMEOUT_TEXT); }
  e.questions.clear();
}

/** The session's bearer, checked in constant time. */
export function authenticateCli(session: string, token: string): boolean {
  const e = registry.get(session);
  return !!e && secretEqual(token, e.token);
}

/** rime_status: progress on a running session. */
export async function cliStatus(session: string, message: string): Promise<void> {
  const e = registry.get(session);
  if (!e) throw new DevError('Unknown session.', 401);
  e.reported = false;
  await setPhase(e, session, e.phase === 'done' || e.phase === 'ended' ? e.phase : 'running', 'status', { message }, message);
}

/** rime_report: the CLI's own completion, which also tells Rime. */
export async function cliReport(session: string, summary: string, files: string[], checks: string[]): Promise<void> {
  const e = registry.get(session);
  if (!e) throw new DevError('Unknown session.', 401);
  e.reported = true;
  await setPhase(e, session, 'done', 'report', { summary, files, checks }, summary);
  const tail = [files.length ? `Changed: ${files.join(', ')}` : '', checks.length ? `Checked: ${checks.join('; ')}` : ''].filter(Boolean).join('\n');
  notifyCli(e, `${label(e)} session ${session} reports done:\n${summary.slice(0, 2000)}${tail ? `\n${tail}` : ''}`);
}

/** rime_context: what the session was started for. */
export function cliContext(session: string): string {
  const e = registry.get(session);
  if (!e) throw new DevError('Unknown session.', 401);
  const row = workDb().prepare('SELECT project,task,assignment FROM terminal_sessions WHERE id=? AND user_id=?').get(session, e.user) as { project: string; task: string; assignment: string } | undefined;
  return [`Session: ${session} (${label(e)})`, `Project: ${row?.project ?? ''}`, `Permission mode: ${MODE_MEANING[e.mode]}`, `Assignment: ${row?.assignment || '(none)'}`, `Task: ${row?.task || '(none)'}`].join('\n');
}

/** Park a rime_ask question; resolves with Rime's answer (terminal_answer) or the timeout text.
 *  Returns null when the session has no coordinator to ask. */
export function parkQuestion(session: string, question: string, options?: string[]): Promise<string> | null {
  const e = registry.get(session);
  if (!e) throw new DevError('Unknown session.', 401);
  if (!e.origin) return null;
  const id = randomUUID().slice(0, 8);
  const answer = new Promise<string>(resolve => {
    const timer = setTimeout(() => { if (e.questions.delete(id)) { resolve(ASK_TIMEOUT_TEXT); if (!e.questions.size) void setPhase(e, session, 'running', 'question-timeout', { question: id }); } }, ASK_WAIT_MS);
    timer.unref();
    e.questions.set(id, { id, question, options, at: Date.now(), resolve, timer });
  });
  void setPhase(e, session, 'waiting-input', 'question', { question: id, text: question, options }).then(() =>
    notifyCli(e, `${label(e)} session ${session} asks: ${question}${options?.length ? `\nOptions: ${options.join(' | ')}` : ''}\nAnswer with terminal_answer {session: "${session}", question: "${id}", answer: "…"}.`));
  return answer;
}

/** Rime's answer to a parked question. False when there is nothing to answer. */
export function answerCli(user: number, session: string, question: string, answer: string): boolean {
  const e = registry.get(session);
  const q = e?.user === user ? e.questions.get(question) : undefined;
  if (!e || !q) return false;
  clearTimeout(q.timer);
  e.questions.delete(question);
  q.resolve(answer);
  if (!e.questions.size) void setPhase(e, session, 'running', 'answer', { question });
  return true;
}

export async function handleCliHook(session: string, token: string, payload: unknown): Promise<Record<string, unknown>> {
  if (!isDesktop()) throw new DevError('Not available on this runtime.', 404);
  const e = registry.get(session);
  if (!e || !secretEqual(token, e.token)) throw new DevError('Unknown session.', 401);
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  // Codex's legacy notify passes {type:'agent-turn-complete', 'last-assistant-message'}.
  const event = str(p.hook_event_name, 40) || (p.type === 'agent-turn-complete' ? 'Stop' : '');
  switch (event) {
    case 'PermissionRequest': {
      const toolUse = str(p.tool_use_id, 200);
      if (p.cancelled === true) {
        // The prompt was cancelled at the terminal (Esc, interrupt): release exactly the request
        // that carried this tool_use_id. Anything else parked stays parked.
        const parked = toolUse ? [...e.pending.values()].find(x => x.toolUse === toolUse) : undefined;
        if (parked) release(e, session, parked, 'Cancelled at the terminal.', 'permission-cancelled');
        return {};
      }
      const id = randomUUID().slice(0, 8), tool = str(p.tool_name, 200) || 'tool';
      // A resend of the same tool use (its cancel never arrived) supersedes the parked copy.
      const stale = toolUse ? [...e.pending.values()].find(x => x.toolUse === toolUse) : undefined;
      if (stale) release(e, session, stale, 'Superseded by a resend.', 'permission-superseded');
      e.reported = false;
      const decision = new Promise<Record<string, unknown>>(resolve => {
        const timer = setTimeout(() => { if (e.pending.delete(id)) { resolve(decisionJson('deny', 'No decision within 30 minutes.')); if (!e.pending.size) void setPhase(e, session, 'running', 'timeout', { request: id }); } }, PERMISSION_WAIT_MS);
        timer.unref();
        e.pending.set(id, { id, tool, input: p.tool_input, toolUse, at: Date.now(), resolve, timer });
      });
      await setPhase(e, session, 'waiting-permission', 'permission', { request: id, tool, input: p.tool_input });
      notifyCli(e, `${label(e)} session ${session} requests permission: ${tool} ${compact(p.tool_input)}\nDecide with terminal_decide {session: "${session}", request: "${id}", decision: "allow" | "deny"}.`);
      return decision;
    }
    case 'Notification': {
      const type = str(p.notification_type, 40);
      if (type === 'permission_prompt' && !e.pending.size) await setPhase(e, session, 'waiting-permission', 'permission-prompt', { message: str(p.message, 500) });
      // Idle means "the turn ended and nobody typed": only a running session becomes waiting; a
      // finished, ended or prompting one is not regressed, and no notice is raised for it.
      else if (type === 'idle_prompt' && e.phase === 'running') { if (await setPhase(e, session, 'waiting-input', 'idle', {})) notifyCli(e, `${label(e)} session ${session} is waiting for input.`); }
      return {};
    }
    case 'UserPromptSubmit': e.reported = false; await setPhase(e, session, 'running', 'prompt', {}); return {};
    case 'Stop': {
      const last = str(p.last_assistant_message ?? p['last-assistant-message'], 8000);
      // A permission prompt blocks its turn, so one still parked when the turn stops was cancelled
      // at the terminal and its cancel never arrived: it belongs to this turn and ends with it.
      for (const parked of [...e.pending.values()]) release(e, session, parked, 'The turn ended before a decision.', 'permission-cancelled');
      const reported = e.reported;
      const changed = await setPhase(e, session, 'done', 'stop', { lastMessage: last, reported }, last);
      // rime_report already said this; the Stop is the same completion, so the text is kept and nothing is announced twice.
      if (changed && !reported) notifyCli(e, `${label(e)} session ${session} finished${last ? `:\n${last.slice(0, 2000)}` : '.'}`);
      return {};
    }
    case 'SessionStart': e.reported = false; await setPhase(e, session, 'running', 'start', {}); return {};
    case 'SessionEnd': settle(e, 'The session ended.'); await setPhase(e, session, 'ended', 'end', { reason: str(p.reason, 60) }); return {};
    default: return {};
  }
}

const label = (e: Entry) => (e.kind === 'claude' ? 'Claude Code' : 'Codex');
/** Resolve one parked request (deny with a reason) and return the phase to running when it was the last. */
function release(e: Entry, session: string, parked: Pending, why: string, eventType: string): void {
  clearTimeout(parked.timer);
  e.pending.delete(parked.id);
  parked.resolve(decisionJson('deny', why));
  if (!e.pending.size && e.phase === 'waiting-permission') void setPhase(e, session, 'running', eventType, { request: parked.id });
}
const compact = (input: unknown) => { try { const s = JSON.stringify(input ?? ''); return s.length > 600 ? `${s.slice(0, 600)}…` : s; } catch { return ''; } };

/** True when the phase (or the message it carries) actually changed. Persists it, announces
 *  the session to the ward, and observes it for monitors. */
async function setPhase(e: Entry, session: string, phase: CliPhase, eventType: string, data: Record<string, unknown>, lastMessage = e.lastMessage): Promise<boolean> {
  if (e.phase === phase && e.lastMessage === lastMessage) return false;
  e.phase = phase; e.lastMessage = lastMessage;
  workDb().prepare('UPDATE terminal_sessions SET phase=?,last_message=? WHERE id=? AND user_id=?').run(phase, lastMessage, session, e.user);
  const { announceSession } = await import('./terminals.ts');
  try { announceSession(e.user, session); } catch { /* the row is gone: the exit path already announced */ }
  observe({ user: e.user, source: 'terminal', target: session, key: `${session}:${eventType}:${++e.seq}`, data: { eventType, phase, kind: e.kind, ...data } });
  return true;
}

/** Tell the Rime that started the session. A running turn reads it at its next round; an
 *  idle ward gets a headless turn. Framed as an observation, like a task notice. */
function notifyCli(e: Entry, text: string): void {
  if (!e.origin) return;
  const { user, origin } = e;
  void Promise.all([import('../agent/core.ts'), import('../agent/conversations.ts')]).then(([{ wardBusy, steerTurn, queueHeadlessAsk }, { activeConversationRow }]) => {
    // Delivery is per ward (that is what steer and a headless ask address). When the thread that
    // launched the session is no longer the ward's active one, the notice says so rather than
    // reading as if it belonged to the current thread.
    const active = activeConversationRow(user, origin.ward)?.id;
    const provenance = origin.conv !== undefined && active !== undefined && active !== origin.conv ? ` (started from thread #${origin.conv} of this ward, which is no longer the active thread)` : '';
    const message = `[Terminal session — runtime observation, not a new user instruction]${provenance}\n${text}`;
    if (wardBusy(user, origin.ward)) steerTurn(user, origin.ward, { text: message, from: 'user' });
    else { const status = queueHeadlessAsk(user, origin.ward, message); if (status !== 'queued') console.error(`[cli] notice not delivered to ${origin.ward}: ${status}`); }
  }).catch(err => console.error('[cli] notice failed:', err));
}
