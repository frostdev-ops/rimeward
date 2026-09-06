import { randomUUID } from 'node:crypto';
import { getDb } from '../db.ts';
import { broadcast } from '../logic-engine.ts';
import type { ToolCtx, ToolDef } from './tools.ts';

/** Runtime-local receipts survive reloads; executable promises never cross a runtime. */
export interface AgentTask {
  id: string;
  tool: string;
  reason: string;
  state: 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  background: boolean;
  startedAt: number;
  finishedAt: number | null;
  cancellable: boolean;
  error: string | null;
}
interface Row {
  id: string; user_id: number; ward: string; conversation_id: number;
  tool: string; reason: string; state: AgentTask['state']; background: number;
  started_at: number; finished_at: number | null; error: string | null;
  result: string; output: string; output_offset: number;
}
interface Running {
  ac: AbortController;
  cancellable: boolean;
  release: () => void;
  done: Promise<unknown>;
}
const live = new Map<string, Running>();
const OUTPUT_KEEP = 64_000;
const RESULT_KEEP = 128_000;
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
function view(r: Row): AgentTask {
  return { id: r.id, tool: r.tool, reason: r.reason, state: r.state, background: !!r.background,
    startedAt: r.started_at, finishedAt: r.finished_at, error: r.error,
    cancellable: !!live.get(r.id)?.cancellable && r.state === 'running' };
}
function publish(r: Row) {
  broadcast(r.user_id, 'agent-live', { ward: r.ward, event: { type: 'task', task: view(r) } });
}
export function listTasks(ctx: Pick<ToolCtx, 'userId' | 'ward'>): AgentTask[] {
  return (db().prepare(`SELECT id,tool,reason,state,background,started_at,finished_at,error FROM agent_jobs WHERE user_id=? AND ward=?
    ORDER BY state IN ('running','stopping') DESC, started_at DESC LIMIT 100`).all(ctx.userId, ctx.ward) as Row[]).map(view);
}
/** Output offsets are absolute, so a rolling log can report an explicit gap. */
export function readTask(ctx: Pick<ToolCtx, 'userId' | 'ward'>, id: string, cursor = 0, result = false) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error('cursor must be a non-negative integer.');
  const r = row(ctx, id), start = result ? 0 : r.output_offset;
  const all = result ? r.result : r.output;
  const from = Math.max(cursor, start);
  let text = all.slice(from - start, from - start + 8000);
  while (JSON.stringify(text).length > 9000) text = text.slice(0, Math.floor(text.length * .8));
  const next = Math.min(from, start + all.length) + text.length;
  return { task: view(r), text, next, truncated: cursor < start, complete: next >= start + all.length };
}
export function backgroundTasks(ctx: Pick<ToolCtx, 'userId' | 'ward'>, id?: string): AgentTask[] {
  const tasks = id ? [view(row(ctx, id))] : listTasks(ctx);
  const changed: AgentTask[] = [];
  for (const task of tasks) {
    const run = live.get(task.id);
    if (!run || task.background || task.state !== 'running') continue;
    db().prepare('UPDATE agent_jobs SET background=1 WHERE id=?').run(task.id);
    run.release();
    const r = row(ctx, task.id);
    changed.push(view(r)); publish(r);
  }
  return changed;
}
export function cancelTask(ctx: Pick<ToolCtx, 'userId' | 'ward'>, id: string): AgentTask {
  const r = row(ctx, id), run = live.get(id);
  if (!run || !['running', 'stopping'].includes(r.state)) return view(r);
  if (!run.cancellable) throw Error('This tool cannot be stopped safely. It will retain its result when it finishes.');
  db().prepare("UPDATE agent_jobs SET state='stopping' WHERE id=?").run(id);
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
/** Called only at conversation boundaries; completing a job never spends a model call. */
export function taskNotices(ctx: ToolCtx): string[] {
  const rows = db().prepare(`UPDATE agent_jobs SET notified=1 WHERE user_id=? AND ward=? AND conversation_id=?
    AND background=1 AND notified=0 AND state NOT IN ('running','stopping') RETURNING *`).all(ctx.userId, ctx.ward, ctx.conv) as Row[];
  return rows.map(r => `Background task ${r.id} (${r.tool}): ${r.state}. ${r.error ?? ''} Use task_output to inspect its result before claiming success or repeating work.`);
}

/** One dispatch path for ordinary and confirmed calls. Approval happens in core before this. */
export async function runTask(name: string, args: Record<string, unknown>, ctx: ToolCtx, def: ToolDef): Promise<unknown> {
  const store = db();
  if ((store.prepare("SELECT count(*) AS n FROM agent_jobs WHERE user_id=? AND state IN ('running','stopping')").get(ctx.userId) as { n: number }).n >= 8)
    throw Error('Eight tasks are already running. Wait for one to finish or stop it.');
  // ponytail: keep the latest 100 settled receipts per user; add export if long-term task archives are needed.
  store.prepare(`DELETE FROM agent_jobs WHERE user_id=? AND state NOT IN ('running','stopping') AND id NOT IN
    (SELECT id FROM agent_jobs WHERE user_id=? ORDER BY started_at DESC LIMIT 100)`).run(ctx.userId, ctx.userId);
  const id = randomUUID(), ac = new AbortController();
  const background = args.background === true;
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
  run.done = Promise.resolve().then(() => def.run(args, { ...ctx, signal: ac.signal, progress })).then(value => {
    const json = JSON.stringify(value ?? null);
    const failed = value && typeof value === 'object' && ('error' in value || ('exit_code' in value && value.exit_code !== 0));
    store.prepare('UPDATE agent_jobs SET state=?,finished_at=?,result=?,error=? WHERE id=?')
      .run(ac.signal.aborted ? 'cancelled' : failed ? 'failed' : 'completed', Date.now(), json.length <= RESULT_KEEP ? json : JSON.stringify({ omitted: true, note: 'Result exceeded 128k characters; inspect the output or source. Do not repeat a mutation.', preview: json.slice(0, 8000) }),
        failed ? String('error' in value ? value.error : `Command exited with status ${value.exit_code}`).slice(0, 500) : null, id);
    return value;
  }).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    failure = new Error(message);
    store.prepare('UPDATE agent_jobs SET state=?,finished_at=?,result=?,error=? WHERE id=?')
      .run(ac.signal.aborted ? 'cancelled' : 'failed', Date.now(), JSON.stringify({ error: message.slice(0, 8000) }), message.slice(0, 500), id);
    return { error: message };
  }).finally(() => {
    flushOutput();
    live.delete(id);
    publish(row(ctx, id));
  });
  if (background) release();
  return Promise.race([run.done.then(value => { if (failure) throw failure; return value; }), detached.then(() => ({ task_id: id, background: true, state: row(ctx, id).state,
    note: 'Task continues independently. Do other work; use task_output or task_wait for its result. Do not repeat the operation.' }))]);
}
