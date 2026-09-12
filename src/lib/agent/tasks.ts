import { liveTurn } from './live-turn.ts';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.ts';
import { broadcast } from '../logic-engine.ts';
import { activeConversationRow, addMessage, appendItems, getConversation, transcript, userItemFor } from './conversations.ts';
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
  /** A child run's route, as started (and as switched by set_model). */
  provider?: string;
  model?: string;
  endpoint?: string;
}
interface Row {
  id: string; user_id: number; ward: string; conversation_id: number;
  tool: string; reason: string; state: AgentTask['state']; background: number;
  started_at: number; finished_at: number | null; error: string | null;
  result: string; output: string; output_offset: number; notified: number;
  provider: string | null; model: string | null; endpoint: string | null;
}
interface Running {
  ac: AbortController;
  cancellable: boolean;
  release: () => void;
  done: Promise<unknown>;
  /** Who asked for the cancel — the run's own interrupt line names them. */
  cancelledBy?: string;
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
    db.prepare("UPDATE agent_jobs SET state='interrupted', finished_at=?, error='Runtime restarted; inspect the result before retrying. Nothing was replayed.' WHERE state IN ('running','stopping')").run(Date.now());
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
function view(r: Row): AgentTask {
  return { id: r.id, tool: r.tool, reason: r.reason, state: r.state, background: !!r.background,
    startedAt: r.started_at, finishedAt: r.finished_at, error: r.error,
    cancellable: !!live.get(r.id)?.cancellable && r.state === 'running',
    ...(r.provider ? { provider: r.provider } : {}), ...(r.model ? { model: r.model } : {}), ...(r.endpoint ? { endpoint: r.endpoint } : {}) };
}
function publish(r: Row) {
  observe({ user:r.user_id,source:'agent',target:r.id,key:`${r.id}:${r.state}`,data:{ eventType:'task',status:r.state,text:r.result?.slice(0,8000) ?? '',tool:r.tool } });
  broadcast(r.user_id, 'agent-live', { ward: r.ward, event: { type: 'task', task: view(r) } });
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
  return (db().prepare(`SELECT id,tool,reason,state,background,started_at,finished_at,error,provider,model,endpoint FROM agent_jobs WHERE user_id=? AND ward=?
    AND (? OR state IN ('running','stopping') OR (background=1 AND notified=0 AND conversation_id=?))
    ORDER BY state IN ('running','stopping') DESC, started_at DESC LIMIT 100`).all(ctx.userId, ctx.ward, Number(history), conversation) as Row[]).map(view).concat(listMonitors({ ...ctx,conv:conversation }));
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
  return { task: view(r), conversation: conv?.id, live: running, transcript: running?.transcript ?? (conv ? transcript(conv.id) : []), output: r.output, truncated: r.output_offset > 0,
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
export function cancelTask(ctx: Pick<ToolCtx, 'userId' | 'ward'>, id: string, by = 'the user'): AgentTask {
  if (id.startsWith('monitor:')) { const { monitor } = readMonitor(ctx,id); deleteMonitor(ctx,id); return { ...monitor,state:'cancelled',finishedAt:Date.now(),cancellable:false }; }
  const r = row(ctx, id), run = live.get(id);
  if (!run || !['running', 'stopping'].includes(r.state)) return view(r);
  if (!run.cancellable) throw Error('This tool cannot be stopped safely. It will retain its result when it finishes.');
  db().prepare("UPDATE agent_jobs SET state='stopping' WHERE id=?").run(id);
  run.cancelledBy ??= by;
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
    addMessage(conv, { role: 'user', text: `📋 Child run ${r.state}: ${r.reason}${childBrief(r) ? `\n${childBrief(r).trim()}` : ''}`, source: 'agent' });
    return true;
  })();
}

/** The child's final reply, for a notice — the parent should not need task_output to hear it. */
function childBrief(r: Row): string {
  try {
    const reply = (JSON.parse(r.result) as { reply?: unknown }).reply;
    return typeof reply === 'string' && reply.trim() ? `\nIts final reply:\n<<<\n${reply.slice(0, 4000)}\n>>>` : '';
  } catch { return ''; }
}
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
  store.prepare('INSERT INTO agent_jobs(id,user_id,ward,conversation_id,tool,reason,background,started_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, ctx.userId, ctx.ward, ctx.conv, name, String(args.reason ?? name).slice(0, 500), Number(background), Date.now());
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
    store.prepare('UPDATE agent_jobs SET state=?,finished_at=?,result=?,error=? WHERE id=?')
      .run(cancelled ? 'cancelled' : error !== null ? 'failed' : 'completed', Date.now(), json.length <= RESULT_KEEP ? json : JSON.stringify({ omitted: true, note: 'Result exceeded 128k characters; inspect the output or source. Do not repeat a mutation.', preview: json.slice(0, 8000) }),
        error?.slice(0, 500) ?? null, id);
    return value;
  }).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    failure = new Error(message);
    store.prepare('UPDATE agent_jobs SET state=?,finished_at=?,result=?,error=? WHERE id=?')
      .run(ac.signal.aborted ? 'cancelled' : 'failed', Date.now(), JSON.stringify({ error: message.slice(0, 8000) }), message.slice(0, 500), id);
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
