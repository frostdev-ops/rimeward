import { liveTurn } from './live-turn.ts';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.ts';
import { broadcast } from '../logic-engine.ts';
import { activeConversationRow, addMessage, appendItems, getConversation, transcript, userItemFor, type ConvRow } from './conversations.ts';
import { agentConfigured } from './provider.ts';
import { recordedBackendCheck } from './route.ts';
import type { AgentProviderId } from '../wards.ts';
import type { Dialect } from './provider.ts';
import type { ToolCtx, ToolDef } from './tools.ts';
import { CHILD_ANSWER_MAX, openQuestion } from './inbox.ts';
import { listMonitors, readMonitor, deleteMonitor, retireMonitors } from './monitors.ts';
import { observe } from './observation-events.ts';

/** Runtime-local receipts survive reloads; executable promises never cross a runtime. */
export interface AgentTask {
  id: string;
  tool: string;
  reason: string;
  state: 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'watching' | 'paused' | 'blocked' | 'offline';
  background: boolean;
  startedAt: number;
  finishedAt: number | null;
  cancellable: boolean;
  error: string | null;
  /** The thread that started it — where a background result or a child's report is delivered. */
  conversation?: number;
  /** That thread has been told the result (a task notice drained, or filed into an archived thread). */
  notified?: boolean;
  /** Relative to the thread the list was asked from: started by it, or by an earlier one of this ward. */
  thread?: 'this' | 'earlier';
  /** A running child's question to its parent, still unanswered. */
  waiting?: { id: number; text: string };
  /** A finished child's final reply, first lines. */
  summary?: string;
  /** A child run's route, as started (and as switched by set_model). */
  provider?: string;
  model?: string;
  endpoint?: string;
  /** Resume lineage: which attempt this is, the attempt it continued, and the later attempt that continued it. */
  attempt?: number;
  resumedFrom?: string;
  resumedBy?: string;
  /** Who stopped it (cancelled/interrupted); absent when not stopped or unrecorded. */
  stoppedBy?: StopActor;
  /** false: the row was reserved and refused before its start — an audit line, not an attempt that ran. */
  started?: false;
  /** Who asked for this resumed attempt. */
  resumeActor?: 'user' | 'agent';
}
interface Row {
  id: string; user_id: number; ward: string; conversation_id: number;
  tool: string; reason: string; state: AgentTask['state']; background: number;
  started_at: number; finished_at: number | null; error: string | null;
  result: string; output: string; output_offset: number; notified: number;
  provider: string | null; model: string | null; endpoint: string | null;
  /** Listing rows only: the head of a child's reply, extracted in SQL from the parsed result. */
  reply_head?: string | null;
  /** Resume lineage (migration 035): the attempt this row continued, and the root of its chain (NULL on a root). */
  resumed_from: string | null; lineage: string | null;
  /** Structured stop provenance; NULL = not stopped, or stopped before it was recorded (unknown). */
  stopped_by: StopActor | null;
  /** Execution provenance: 0 = reserved and refused before its start (never a source, never a block), 1 = ran. */
  ran: number;
  /** Who asked for this resumed attempt: 'user' (Tasks, server-verified) or 'agent' (task_resume); NULL on a plain spawn. */
  resume_actor: 'user' | 'agent' | null;
}
/** Who stopped a job: the person (UI), the parent agent's task_cancel, a child run's task_cancel, the
 *  parent run's own stop cascading into its children, or a runtime restart. Stored, never parsed from text. */
export type StopActor = 'user' | 'agent' | 'child' | 'parent' | 'runtime';
const STOP_LABEL: Record<StopActor, string> = { user: 'the user', agent: 'the parent agent', child: 'a child run', parent: 'its parent run', runtime: 'the runtime' };
export const stopLabel = (actor: StopActor | null | undefined): string => (actor ? STOP_LABEL[actor] : 'an unrecorded actor');
/** Provenance precedence: an explicit user Stop is never downgraded by an earlier or later actor; otherwise the first recorded actor stands. */
const stopWins = (current: StopActor | null | undefined, next: StopActor): StopActor => (current === 'user' || next === 'user' ? 'user' : current ?? next);
/** SQL form of stopWins for the stored column. */
const STOP_SQL = "stopped_by=CASE WHEN stopped_by='user' OR ?='user' THEN 'user' ELSE COALESCE(stopped_by, ?) END";
interface Running {
  ac: AbortController;
  cancellable: boolean;
  release: () => void;
  done: Promise<unknown>;
  /** Who asked for the cancel — the run's own interrupt line names them. */
  cancelledBy?: string;
  stoppedBy?: StopActor;
}
/** Who cancelled a running job, once someone has. */
export const cancelledBy = (id: string): string | undefined => live.get(id)?.cancelledBy;
const live = new Map<string, Running>();
const OUTPUT_KEEP = 64_000;
const RESULT_KEEP = 128_000;
/** Child runs per user at once — each is a model loop of its own. */
export const MAX_CHILDREN = 4;
let recovered = false;
function db() {
  const db = getDb();
  if (!recovered) {
    // A recorded actor survives the restart; a stop that was pending without one stays UNKNOWN (never
    // relabelled as the runtime's); only a plainly running row was interrupted by the runtime itself.
    db.prepare(`UPDATE agent_jobs SET state='interrupted', finished_at=?,
      error=CASE WHEN state='stopping' THEN 'Runtime restarted while this run was stopping; inspect the result before retrying. Nothing was replayed.' ELSE 'Runtime restarted; inspect the result before retrying. Nothing was replayed.' END,
      stopped_by=CASE WHEN stopped_by IS NOT NULL THEN stopped_by WHEN state='stopping' THEN NULL ELSE 'runtime' END
      WHERE state IN ('running','stopping')`).run(Date.now());
    recovered = true;
  }
  return db;
}
function row(ctx: Pick<ToolCtx, 'userId' | 'ward'>, id: string): Row {
  const result = db().prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=? AND ward=?').get(id, ctx.userId, ctx.ward) as Row | undefined;
  if (!result) throw Error('Task not found in this chat.');
  return result;
}
/** Is this job still running in THIS process? (The row can say running after a restart; the map cannot.) */
export const isLive = (id: string): boolean => live.has(id);
/** A child run's job row, or null — the address check for messages and the framing lines.
 *  conversation_id is the PARENT thread it was started from: where its traffic goes. */
export function childJob(userId: number, id: string): { id: string; ward: string; reason: string; state: AgentTask['state']; conversation_id: number; notified: number; provider: string | null; model: string | null } | null {
  if (typeof id !== 'string' || id.length > 40) return null;
  return (db().prepare("SELECT id, ward, reason, state, conversation_id, notified, provider, model FROM agent_jobs WHERE id=? AND user_id=? AND tool='spawn_agent'").get(id, userId) as ReturnType<typeof childJob>) ?? null;
}
export function assertChildCapacity(userId: number): void {
  if ((db().prepare("SELECT count(*) AS n FROM agent_jobs WHERE user_id=? AND tool='spawn_agent' AND state IN ('running','stopping')").get(userId) as { n: number }).n >= MAX_CHILDREN)
    throw Error(`${MAX_CHILDREN} child runs are already running. Wait for one to finish or stop it.`);
}
export function assertTaskCapacity(userId: number): void {
  if ((db().prepare("SELECT count(*) AS n FROM agent_jobs WHERE user_id=? AND state IN ('running','stopping')").get(userId) as { n: number }).n >= 8)
    throw Error('Eight tasks are already running. Wait for one to finish or stop it.');
}
/** The route a child run was started on (and switches to), for the drawer. */
export function stampJob(id: string, sel: { provider: string; model: string; endpoint?: string | null }): void {
  db().prepare('UPDATE agent_jobs SET provider=?, model=?, endpoint=? WHERE id=?').run(sel.provider, sel.model, sel.endpoint ?? null, id);
}
const ACTIVE = new Set<AgentTask['state']>(['running', 'stopping']);
function view(r: Row, conversation?: number): AgentTask {
  const child = r.tool === 'spawn_agent';
  const question = child && r.state === 'running' ? openQuestion(r.user_id, r.id, r.ward) : null;
  const reply = child && !ACTIVE.has(r.state) ? summaryOf(childReply(r)) : '';
  const later = child ? descendant(r) : undefined;
  return { id: r.id, tool: r.tool, reason: r.reason, state: r.state, background: !!r.background,
    startedAt: r.started_at, finishedAt: r.finished_at, error: r.error,
    cancellable: !!live.get(r.id)?.cancellable && r.state === 'running',
    conversation: r.conversation_id, notified: !!r.notified,
    ...(conversation === undefined ? {} : { thread: r.conversation_id === conversation ? 'this' as const : 'earlier' as const }),
    ...(question ? { waiting: { id: question.id, text: question.text.slice(0, 500) } } : {}),
    ...(reply ? { summary: reply } : {}),
    ...(child ? { attempt: attemptOf(r), ...(r.resumed_from ? { resumedFrom: r.resumed_from } : {}), ...(later ? { resumedBy: later.id } : {}) } : {}),
    ...(r.ran ? {} : { started: false }),
    ...(r.resume_actor ? { resumeActor: r.resume_actor } : {}),
    ...(r.stopped_by ? { stoppedBy: r.stopped_by } : {}),
    ...(r.provider ? { provider: r.provider } : {}), ...(r.model ? { model: r.model } : {}), ...(r.endpoint ? { endpoint: r.endpoint } : {}) };
}
/** The attempt that continued this one, if any (a resume is always a new row pointing back). */
function descendant(r: Pick<Row, 'id' | 'user_id'>): { id: string; state: AgentTask['state'] } | undefined {
  // A row refused before its start (ran=0, finished) is an audit line: it never continued anything.
  return db().prepare("SELECT id,state FROM agent_jobs WHERE resumed_from=? AND user_id=? AND (ran=1 OR state IN ('running','stopping')) ORDER BY started_at DESC LIMIT 1").get(r.id, r.user_id) as { id: string; state: AgentTask['state'] } | undefined;
}
/** The source a reserved resume row was admitted for — written only by runTask's admitted insert; the
 *  one place a run learns it is a resume. NULL for every ordinary spawn, whatever its arguments said. */
export function admittedResume(userId: number, job: string): string | null {
  return (db().prepare('SELECT resumed_from FROM agent_jobs WHERE id=? AND user_id=?').get(job, userId) as { resumed_from: string | null } | undefined)?.resumed_from ?? null;
}
/** The run is about to start for real (its model is about to be called): from here on the row is an
 *  attempt that ran, whatever happens next — resumable, and a block on its lineage while live. */
export function markRan(job: string): void { db().prepare('UPDATE agent_jobs SET ran=1 WHERE id=?').run(job); }
/** 1 for a first attempt; one more per resumed_from hop. */
function attemptOf(r: Pick<Row, 'resumed_from'>): number {
  let n = 1, cur = r.resumed_from; const seen = new Set<string>();
  while (cur && !seen.has(cur) && n < 100) { seen.add(cur); n++; cur = (db().prepare('SELECT resumed_from FROM agent_jobs WHERE id=?').get(cur) as { resumed_from: string | null } | undefined)?.resumed_from ?? null; }
  return n;
}
/** Every resumed row carries the root id; a root is its own. */
const lineageRoot = (r: Pick<Row, 'id' | 'lineage'>): string => r.lineage ?? r.id;
/** What a resume continues from — the finished attempt, its thread and how much of it is there. */
export function resumeSource(userId: number, ward: string, id: string): { job: AgentTask & { attempt: number }; conv: ConvRow | null; items: number } | null {
  const r = db().prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=? AND ward=? AND tool=?').get(id, userId, ward, 'spawn_agent') as Row | undefined;
  if (!r) return null;
  const conv = (db().prepare('SELECT * FROM agent_conversations WHERE user_id=? AND ward=? AND task_id=?').get(userId, ward, id) as ConvRow | undefined) ?? null;
  const items = conv ? (db().prepare('SELECT count(*) AS n FROM agent_items WHERE conversation_id=?').get(conv.id) as { n: number }).n : 0;
  return { job: { ...view(r), attempt: attemptOf(r) }, conv, items };
}
/**
 * The finished attempt a resume continues, or the reason it cannot — decided in the same synchronous
 * step as capacity and the insert (runTask), so two resumes can never both pass. For every caller: this
 * chat's own child, finished, not already continued, no live attempt anywhere in its lineage. For the
 * agent's tool (no ctx.user, which only the server sets on a person's own action): from the thread that
 * started it, never inside a child, and never work the person stopped or whose stop is unrecorded —
 * those the person resumes from Tasks. No model-supplied flag can stand in for that.
 */
function admitResume(ctx: ToolCtx, id: string): Row {
  const r = db().prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=? AND ward=?').get(id, ctx.userId, ctx.ward) as Row | undefined;
  if (r?.tool !== 'spawn_agent') throw Error('Task not found in this chat, or not a child run.');
  if (ACTIVE.has(r.state)) throw Error(`Child run ${id} is still ${r.state}; there is nothing to resume.`);
  // A row refused before its start is not a source: it holds no record. Point at the attempt that does.
  if (!r.ran) throw Error(r.resumed_from
    ? `Attempt ${attemptOf(r)} (task ${id}) never started — its start was refused: ${r.error ?? 'unknown'}. Resume attempt ${attemptOf(r) - 1} (task ${r.resumed_from}) instead.`
    : `Child run ${id} never started — its start was refused: ${r.error ?? 'unknown'}. There is nothing to resume; start a new child.`);
  const later = descendant(r);
  if (later) throw Error(`Attempt ${attemptOf(r)} of this work was already resumed as task ${later.id} (${later.state}); resume that attempt instead.`);
  const root = lineageRoot(r);
  const running = db().prepare("SELECT id FROM agent_jobs WHERE user_id=? AND state IN ('running','stopping') AND (id=? OR lineage=?)").get(ctx.userId, root, root) as { id: string } | undefined;
  if (running) throw Error(`This work is already being continued by task ${running.id}; wait for it or stop it first.`);
  if (!ctx.user) {
    if (ctx.task) throw Error('A child run cannot resume runs. Ask your parent.');
    if (ctx.conv !== r.conversation_id) throw Error(`child run ${id} belongs to an earlier thread of this ward — only the user can resume it, from Tasks`);
    // The person's Stop is theirs to undo, whatever state the run ended in; so is any stop whose actor
    // is unknown or was the parent run's own stop. The tool may continue work the agent side stopped
    // (its own task_cancel, a child's) or a genuine runtime interruption.
    const stopped = r.state === 'cancelled' || r.state === 'interrupted' || r.stopped_by !== null;
    if (stopped && !(r.stopped_by === 'agent' || r.stopped_by === 'child' || r.stopped_by === 'runtime')) throw Error(`child run ${id} was stopped by ${stopLabel(r.stopped_by)}; only the user can resume it, from Tasks`);
    // A continuation of this source that the person (or an unknown actor, or a parent-run stop) stopped
    // before it started is an audit row for retryability, but its stop authority stands: the agent may
    // not re-continue that work — only the person's own Resume does. (A continuation the person started
    // that then RAN moved the source on; nothing here is read off the clock.)
    const barrier = db().prepare("SELECT stopped_by FROM agent_jobs WHERE resumed_from=? AND user_id=? AND ran=0 AND (state='cancelled' OR state='interrupted' OR stopped_by IS NOT NULL) AND (stopped_by IS NULL OR stopped_by NOT IN ('agent','child','runtime')) LIMIT 1").get(r.id, ctx.userId) as { stopped_by: StopActor | null } | undefined;
    if (barrier) throw Error(`a continuation of child run ${id} was stopped by ${stopLabel(barrier.stopped_by)} before it started; only the user can resume this work, from Tasks`);
  }
  // Identity and context that can be checked without waiting: refused here, BEFORE a row is reserved —
  // a missing thread, an empty record, an unrecorded model or an unconfigured provider leave no trace
  // and block nothing. (What remains async — the live catalog — is checked after reservation, and a
  // refusal there leaves a row that never ran: audit, not a source, not a block.)
  const conv = db().prepare('SELECT provider, endpoint, endpoint_url FROM agent_conversations WHERE user_id=? AND ward=? AND task_id=?').get(ctx.userId, ctx.ward, id) as { provider: AgentProviderId; endpoint: string | null; endpoint_url: string | null } | undefined;
  if (!conv) throw Error(`no recoverable context: the thread of child run ${id} is gone`);
  if (!(db().prepare('SELECT count(*) AS n FROM agent_items WHERE conversation_id=(SELECT id FROM agent_conversations WHERE user_id=? AND ward=? AND task_id=?)').get(ctx.userId, ctx.ward, id) as { n: number }).n) throw Error(`no recoverable context: child run ${id} left no conversation record`);
  if (!r.model) throw Error(`child run ${id} did not record its model; start a new child with spawn_agent instead`);
  if (!agentConfigured(ctx.userId, conv.provider, conv.endpoint)) throw Error(`${conv.provider}${conv.endpoint ? ` "${conv.endpoint}"` : ''} is no longer configured; child run ${id} ran there and is not moved to another provider`);
  // An endpoint NAME is a per-runtime alias; the attempt's recorded backend is what has to be behind it
  // still. runChildRun checks this again on the config it actually runs with — this copy is only so the
  // refusal costs no reservation. (Same wording, one meaning.)
  if (conv.endpoint) {
    if (!conv.endpoint_url) throw Error(`child run ${id} did not record which server "${conv.endpoint}" pointed at; start a new child with spawn_agent instead`);
    // One identity check for every caller: a local URL against this runtime's alias, a connected
    // server's pin against that server's own profile and attestation (agent/route.ts).
    const moved = recordedBackendCheck(ctx.userId, conv.endpoint, conv.endpoint_url);
    if (moved) throw Error(`child run ${id} is not moved to another server: ${moved}`);
  }
  return r;
}
/** A push carries the origin relative to the ward's active thread — the thread every open client shows. */
const broadcastTask = (r: Row) => broadcast(r.user_id, 'agent-live', { ward: r.ward, event: { type: 'task', task: view(r, activeConversationRow(r.user_id, r.ward)?.id) } });
function publish(r: Row) {
  observe({ user:r.user_id,source:'agent',target:r.id,key:`${r.id}:${r.state}`,data:{ eventType:'task',status:r.state,text:r.result?.slice(0,8000) ?? '',tool:r.tool } });
  broadcastTask(r);
}
/** Re-broadcast a task whose view changed without a state change — a child's question opened or
 *  closed — so badges and open drawers follow without polling. No observation: nothing happened to the job. */
export function touchTask(userId: number, id: string): void {
  const r = db().prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=?').get(id, userId) as Row | undefined;
  if (r) broadcastTask(r);
}
function cleanTaskLogs(userId: number) {
  // Unreported results for a current conversation/running child still carry work.
  db().prepare(`DELETE FROM agent_jobs WHERE user_id=? AND tool!='spawn_agent' AND state NOT IN ('running','stopping')
    AND NOT (background=1 AND notified=0 AND EXISTS (SELECT 1 FROM agent_conversations c WHERE c.id=agent_jobs.conversation_id
      AND (c.active=1 OR EXISTS (SELECT 1 FROM agent_jobs child WHERE child.id=c.task_id AND child.state IN ('running','stopping')))))
    AND (finished_at < ? OR id NOT IN (SELECT id FROM agent_jobs WHERE user_id=? AND tool!='spawn_agent' AND state NOT IN ('running','stopping')
      ORDER BY finished_at DESC,started_at DESC,id DESC LIMIT 100))`).run(userId, Date.now() - 30 * 86400_000, userId);
}
export function listTasks(ctx: Pick<ToolCtx, 'userId' | 'ward'> & Partial<Pick<ToolCtx, 'conv'>>, history = true): AgentTask[] {
  cleanTaskLogs(ctx.userId);
  const conversation = ctx.conv ?? activeConversationRow(ctx.userId, ctx.ward)?.id ?? 0;
  // The view reads the owner (a child's open question), the thread, the delivery flag and — for a
  // child — the head of its REPLY, extracted from the parsed result in SQL (a cut JSON envelope would
  // parse as nothing); output and result stay out of the listing.
  return (db().prepare(`SELECT id,user_id,ward,conversation_id,tool,reason,state,background,started_at,finished_at,error,notified,provider,model,endpoint,resumed_from,lineage,stopped_by,ran, '' AS result,
    CASE WHEN tool='spawn_agent' AND json_valid(result) AND json_type(result,'$.reply')='text' THEN substr(json_extract(result,'$.reply'),1,4000) END AS reply_head
    FROM agent_jobs WHERE user_id=? AND ward=?
    AND (? OR state IN ('running','stopping') OR (background=1 AND notified=0 AND conversation_id=?))
    ORDER BY state IN ('running','stopping') DESC, started_at DESC LIMIT 100`).all(ctx.userId, ctx.ward, Number(history), conversation) as Row[]).map((r) => view(r, conversation)).concat(listMonitors({ ...ctx,conv:conversation }));
}
/** Output offsets are absolute, so a rolling log can report an explicit gap. */
export function readTask(ctx: Pick<ToolCtx, 'userId' | 'ward'>, id: string, cursor = 0, result = false) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error('cursor must be a non-negative integer.');
  if (id.startsWith('monitor:')) {
    const value = readMonitor(ctx,id), all = JSON.stringify(value,null,2), text = all.slice(cursor,cursor+8000);
    return { task:value.monitor,text,next:cursor+text.length,truncated:false,complete:cursor+text.length >= all.length };
  }
  const r = row(ctx, id), start = result ? 0 : r.output_offset;
  const all = result ? r.result : r.output;
  const from = Math.max(cursor, start);
  let text = all.slice(from - start, from - start + 8000);
  while (JSON.stringify(text).length > 9000) text = text.slice(0, Math.floor(text.length * .8));
  const next = Math.min(from, start + all.length) + text.length;
  return { task: view(r), text, next, truncated: cursor < start, complete: next >= start + all.length };
}

/** The child stays attached to its own thread; opening it never activates or copies it. */
export function readChildTask(ctx: Pick<ToolCtx, 'userId' | 'ward'>, id: string) {
  const r = row(ctx, id);
  if (r.tool !== 'spawn_agent') throw Error('This task is not a child agent.');
  const conv = db().prepare('SELECT id FROM agent_conversations WHERE user_id=? AND ward=? AND task_id=?')
    .get(ctx.userId, ctx.ward, id) as { id: number } | undefined;
  const messages = db().prepare(`SELECT id,text,status,result FROM agent_inbox WHERE user_id=? AND ward=? AND sender='user' ORDER BY id DESC LIMIT 50`)
    .all(ctx.userId, id) as { id: number; text: string; status: string; result: string }[];
  const question = r.state === 'running' ? openQuestion(ctx.userId, id, ctx.ward) : null;
  const running = conv ? liveTurn(ctx.userId, conv.id) : undefined;
  const active = activeConversationRow(ctx.userId, ctx.ward)?.id ?? null;
  return { task: view(r, active ?? undefined), conversation: conv?.id, live: running, transcript: running?.transcript ?? (conv ? transcript(conv.id) : []), output: r.output, truncated: r.output_offset > 0,
    // Linkage: the thread this child reports to, and whether the user is still looking at it.
    parent: { conversation: r.conversation_id, active: r.conversation_id === active },
    canMessage: r.state === 'running' && isLive(id), messages: messages.reverse(),
    question: question ? { id: question.id, text: question.text, maxLength: CHILD_ANSWER_MAX } : null };
}
export function backgroundTasks(ctx: Pick<ToolCtx, 'userId' | 'ward'>, id?: string): AgentTask[] {
  const tasks = id ? [view(row(ctx, id))] : listTasks(ctx);
  // Unnamed = the ward's own turn's tasks: a child run's foreground tools stay with the child.
  const own = id ? null : activeConversationRow(ctx.userId, ctx.ward)?.id ?? null;
  const changed: AgentTask[] = [];
  for (const task of tasks) {
    const run = live.get(task.id);
    if (!run || task.background || task.state !== 'running') continue;
    if (own !== null && row(ctx, task.id).conversation_id !== own) continue;
    db().prepare('UPDATE agent_jobs SET background=1 WHERE id=?').run(task.id);
    run.release();
    const r = row(ctx, task.id);
    changed.push(view(r)); publish(r);
  }
  return changed;
}
export function cancelTask(ctx: Pick<ToolCtx, 'userId' | 'ward'>, id: string, by = 'the user', actor: StopActor = 'user'): AgentTask {
  if (id.startsWith('monitor:')) { const { monitor } = readMonitor(ctx,id); deleteMonitor(ctx,id); return { ...monitor,state:'cancelled',finishedAt:Date.now(),cancellable:false }; }
  const r = row(ctx, id), run = live.get(id);
  if (!run || !['running', 'stopping'].includes(r.state)) return view(r);
  if (!run.cancellable) throw Error('This tool cannot be stopped safely. It will retain its result when it finishes.');
  // The actor is durable from the moment the Stop is asked for — not at settlement, which a restart
  // may never reach — and a person's Stop outranks an earlier agent cancel.
  db().prepare(`UPDATE agent_jobs SET state='stopping', ${STOP_SQL} WHERE id=?`).run(actor, actor, id);
  if (actor === 'user' || !run.cancelledBy) run.cancelledBy = by;
  run.stoppedBy = stopWins(run.stoppedBy, actor);
  run.ac.abort();
  const updated = row(ctx, id); publish(updated);
  return view(updated);
}
export async function waitTask(ctx: Pick<ToolCtx, 'userId' | 'ward'>, id: string, milliseconds = 20_000, cursor = 0) {
  row(ctx, id);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw Error('milliseconds must be non-negative.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = live.get(id);
    if (run) await Promise.race([run.done, new Promise(resolve => { timer = setTimeout(resolve, Math.min(milliseconds, 30_000)); })]);
  } finally { clearTimeout(timer); }
  return readTask(ctx, id, cursor, true);
}
/**
 * Called only at conversation boundaries; completing a job never spends a model
 * call. The acknowledgement (notified=1) and the replay item that carries the
 * notice are ONE transaction: a notice is either in the thread for good or still
 * owed — never claimed and lost. The caller pushes the returned items into its
 * in-memory replay (they are already on disk).
 */
export function taskNotices(ctx: ToolCtx, dialect: Dialect): { text: string; item: unknown }[] {
  const store = db();
  return store.transaction(() => {
    const rows = store.prepare(`UPDATE agent_jobs SET notified=1 WHERE user_id=? AND ward=? AND conversation_id=?
      AND background=1 AND notified=0 AND state NOT IN ('running','stopping') RETURNING *`).all(ctx.userId, ctx.ward, ctx.conv) as Row[];
    const notices = rows.map((r) => { const text = noticeText(r); return { text, item: userItemFor(dialect, `[Task status — runtime observation, not a new user instruction]\n${text}`) }; });
    if (notices.length) appendItems(ctx.conv, notices.map((n) => n.item));
    return notices;
  })();
}
const noticeText = (r: Row): string => `Background task ${r.id} (${r.tool}): ${r.state}. ${r.error ?? ''} Use task_output to inspect its result before claiming success or repeating work.${r.tool === 'spawn_agent' ? childBrief(r) : ''}`;

/**
 * A child whose originating thread is archived can never be drained: its notice
 * is FILED into that thread instead — one user-role message and one replay item,
 * claimed through the same `notified` flag, so the record is complete and nothing
 * is ever delivered twice. The active chat is never told; nothing is reactivated.
 * False when there was nothing left to file.
 */
export function fileChildNotice(userId: number, id: string): boolean {
  const store = db();
  // One transaction: the claim, the replay item and the transcript line stand or fall together.
  return store.transaction(() => {
    const r = store.prepare(`UPDATE agent_jobs SET notified=1 WHERE id=? AND user_id=? AND tool='spawn_agent' AND notified=0 AND state NOT IN ('running','stopping') RETURNING *`).get(id, userId) as Row | undefined;
    if (!r) return false;
    const conv = getConversation(r.conversation_id);
    if (!conv || conv.user_id !== userId) throw Error('the originating thread is gone');
    const text = `[Task status — runtime observation, filed after this thread was archived]\n${noticeText(r)}`;
    appendItems(conv.id, [userItemFor(conv.dialect, text)]);
    addMessage(conv, { role: 'user', text: `Child run ${r.state}: ${r.reason}${childBrief(r) ? `\n${childBrief(r).trim()}` : ''}`, source: 'agent' });
    return true;
  })();
}

/** The child's final reply, for a notice — the parent should not need task_output to hear it. */
function childBrief(r: Row): string {
  const reply = childReply(r).trim();
  return reply ? `\nIts final reply:\n<<<\n${reply.slice(0, 4000)}\n>>>` : '';
}
/** A child's reply: the whole string from a full row, or the SQL-extracted head a listing row carries.
 *  A malformed, omitted or non-string result is no reply at all — never an error. */
function childReply(r: Pick<Row, 'result' | 'reply_head'>): string {
  if (r.reply_head !== undefined) return r.reply_head ?? '';
  try {
    const reply = (JSON.parse(r.result) as { reply?: unknown }).reply;
    return typeof reply === 'string' ? reply : '';
  } catch { return ''; }
}
/** The one summary every surface shows (listing, detail, live push): trimmed, 300 code points, never a split surrogate. */
const summaryOf = (reply: string): string => [...reply.trim().slice(0, 1200)].slice(0, 300).join('');
/**
 * A finished child's result reaches its parent through ONE durable path: the
 * task notice (taskNotices — the job row's `notified` flag, claimed atomically
 * by the parent thread's next drain and banked in the same round). This only
 * WAKES the originating thread so that drain happens now rather than at the
 * user's next message: a steer into its running turn, else one turn of its own.
 * A wake that cannot run (a pending approval, a rate limit, a restart, an
 * archived thread, a dead provider) changes nothing — the notice waits.
 */
async function wakeParent(ctx: Pick<ToolCtx, 'userId' | 'ward'>, id: string): Promise<void> {
  const r = row(ctx, id);
  if (r.notified || r.state === 'cancelled' || r.state === 'interrupted') return;
  try {
    const { sendMessage } = await import('./inbox.ts');
    await sendMessage(r.user_id, { to: r.ward, from: r.id, mode: 'steer', conversation: r.conversation_id,
      text: `[Child run ${r.state}] "${r.reason}" (task ${r.id}) has finished${r.error ? ` — ${r.error}` : ''}. Its report is attached to this turn as a task notice: read it there, then tell the user what it found. Do not repeat its work.` });
  } catch (err) {
    console.error('[tasks] child wake not sent (the task notice still delivers the result):', err instanceof Error ? err.message : err);
  }
}

/** A command terminated by a signal has no ordinary exit code; null is never success. */
export function toolFailure(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (result.cancelled === true || result.termination_reason === 'cancelled') return 'Command cancelled.';
  if (result.error != null) return String(result.error) || 'Tool reported failure.';
  if (typeof result.exit_signal === 'number' && result.exit_signal > 0) return `Command terminated by signal ${result.exit_signal}.`;
  if (typeof result.termination_reason === 'string' && result.termination_reason) return `Command terminated (${result.termination_reason}).`;
  if ('exit_code' in result && result.exit_code !== 0) return typeof result.exit_code === 'number' && Number.isFinite(result.exit_code)
    ? `Command exited with status ${result.exit_code}` : 'Command ended without a normal exit status.';
  return result.ok === false ? 'Tool reported failure.' : null;
}

/** One dispatch path for ordinary and confirmed calls. Approval happens in core before this. */
export async function runTask(name: string, args: Record<string, unknown>, ctx: ToolCtx, def: ToolDef): Promise<unknown> {
  const store = db();
  // A run that is already cancelled starts nothing — not even a job row.
  if (ctx.signal?.aborted) throw Error('Cancelled before it started.');
  assertTaskCapacity(ctx.userId);
  if (def.spawn) {
    // ponytail: one level of delegation; lift when a child needs children of its own.
    if (ctx.task) throw Error('A child run cannot start another run. Do the work yourself or ask your parent.');
    assertChildCapacity(ctx.userId);
  }
  cleanTaskLogs(ctx.userId);
  const id = randomUUID(), ac = new AbortController();
  const background = args.background === true || def.spawn === true;
  // A child's cancel reaches the tools it started, backgrounded or not.
  const onAbort = () => ac.abort();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  // A resume (ToolDef.resume: args.id names the finished attempt) is admitted in the same transaction
  // as the row it reserves — the lineage check and the insert cannot be split by another caller. The
  // new row is a child (tool spawn_agent) linked back; the attempt it continues is never edited.
  store.transaction(() => {
    const ancestor = def.resume ? admitResume(ctx, String(args.id ?? '')) : null;
    store.prepare('INSERT INTO agent_jobs(id,user_id,ward,conversation_id,tool,reason,background,started_at,resumed_from,lineage,ran,resume_actor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, ctx.userId, ctx.ward, ctx.conv, def.spawn ? 'spawn_agent' : name, ancestor ? ancestor.reason : String(args.reason ?? name).slice(0, 500), Number(background), Date.now(), ancestor?.id ?? null, ancestor ? lineageRoot(ancestor) : null, def.spawn ? 0 : 1, ancestor ? (ctx.user ? 'user' : 'agent') : null);
  })();
  let release!: () => void;
  const detached = new Promise<void>(resolve => { release = resolve; });
  const run: Running = { ac, cancellable: def.cancellable === true, release, done: Promise.resolve() };
  live.set(id, run);
  publish(row(ctx, id));
  let output = '', offset = 0;
  let outputTimer: ReturnType<typeof setTimeout> | undefined;
  let failure: Error | undefined;
  const flushOutput = () => {
    clearTimeout(outputTimer); outputTimer = undefined;
    store.prepare('UPDATE agent_jobs SET output=?, output_offset=? WHERE id=?').run(output, offset, id);
  };
  const progress = (text: string) => {
    if (!text) return;
    output += text;
    if (output.length > OUTPUT_KEEP) { offset += output.length - OUTPUT_KEEP; output = output.slice(-OUTPUT_KEEP); }
    outputTimer ??= setTimeout(flushOutput, 100);
  };
  run.done = Promise.resolve().then(() => def.run(args, { ...ctx, signal: ac.signal, progress, job: id, ...(def.spawn ? { detach: release } : {}) })).then(value => {
    const json = JSON.stringify(value ?? null);
    const error = toolFailure(value);
    const cancelled = ac.signal.aborted || !!(value && typeof value === 'object' && 'cancelled' in value && value.cancelled === true);
    // Who stopped it is recorded as data; a stopped child run's error line names them too
    // ("Command cancelled." is a process's line).
    const actor: StopActor | null = cancelled ? run.stoppedBy ?? (ctx.signal?.aborted ? 'parent' : 'user') : null;
    const why = cancelled && def.spawn ? `Stopped by ${run.cancelledBy ?? stopLabel(actor)}.` : error;
    store.prepare(`UPDATE agent_jobs SET state=?,finished_at=?,result=?,error=?,${STOP_SQL} WHERE id=?`)
      .run(cancelled ? 'cancelled' : error !== null ? 'failed' : 'completed', Date.now(), json.length <= RESULT_KEEP ? json : JSON.stringify({ omitted: true, note: 'Result exceeded 128k characters; inspect the output or source. Do not repeat a mutation.', preview: json.slice(0, 8000) }),
        why?.slice(0, 500) ?? null, actor, actor, id);
    return value;
  }).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    failure = new Error(message);
    const actor: StopActor | null = ac.signal.aborted ? run.stoppedBy ?? (ctx.signal?.aborted ? 'parent' : 'user') : null;
    store.prepare(`UPDATE agent_jobs SET state=?,finished_at=?,result=?,error=?,${STOP_SQL} WHERE id=?`)
      .run(ac.signal.aborted ? 'cancelled' : 'failed', Date.now(), JSON.stringify({ error: message.slice(0, 8000) }), message.slice(0, 500), actor, actor, id);
    return { error: message };
  }).finally(() => {
    ctx.signal?.removeEventListener('abort', onAbort);
    flushOutput();
    live.delete(id);
    publish(row(ctx, id));
    if (def.spawn) {
      for (const c of store.prepare('SELECT id FROM agent_conversations WHERE user_id=? AND task_id=?').all(ctx.userId,id) as { id:number }[]) retireMonitors(c.id);
      // A question the child was still waiting on closes with the run — an explicit
      // receipt, never a row left open — BEFORE the completion wake is sent, which is
      // a note (wait = 0) and stays one.
      void import('./inbox.ts').then(({ closeChildQuestions }) => { closeChildQuestions(ctx.userId, id, row(ctx, id).state); return wakeParent(ctx, id); });
    }
  });
  // A spawn detaches itself once its arguments have validated (ToolCtx.detach):
  // a bad spawn is an error to the caller, not a task id that failed at once.
  if (background && !def.spawn) release();
  return Promise.race([run.done.then(value => { if (failure) throw failure; return value; }), detached.then(() => ({ task_id: id, background: true, state: row(ctx, id).state,
    note: 'Task continues independently. Do other work; use task_output or task_wait for its result. Do not repeat the operation.' }))]);
}
