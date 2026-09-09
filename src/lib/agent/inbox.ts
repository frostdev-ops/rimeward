import { getDb } from '../db.ts';
import { getDashboard } from '../dashboard.ts';
import { childJob, isLive, fileChildNotice } from './tasks.ts';
import { getConversation } from './conversations.ts';

// The agent-to-agent pipeline: a durable per-ward queue with receipts. A
// message is a row; delivery is one headless turn on the target ward (mode
// 'queue'), an injection into the turn already running there ('steer'), or a
// stop of that turn followed by a turn of its own ('interrupt'). The row's
// status is the receipt. Wakes (wakes.ts) are the same shape with a clock
// instead of a sender; this is the same shape with a sender instead of a clock.
//
// A child run (tasks.ts, spawn_agent) is an address too — its task id. Family
// traffic is bound to the parent's ORIGINATING thread (conversation_id): a note
// TO a child is steered into its loop and done when read; a message FROM a
// child goes to that one thread — a steer into its running turn, else one turn
// of its own — never to whichever thread the ward is on now. It is exempt from
// the per-ward headless cap (a child's life bounds it), never answered by the
// reply-back hop (a child that wants an answer waits for it), and never
// re-armed by the sweep (a lost wake costs nothing: the result is a task notice).

export type InboxMode = 'queue' | 'steer' | 'interrupt';
export const INBOX_MODES: readonly InboxMode[] = ['queue', 'steer', 'interrupt'];

export interface InboxRow {
  id: number;
  user_id: number;
  ward: string;
  sender: string;
  mode: InboxMode;
  text: string;
  reply_to: number | null;
  wait: number;
  /** Family traffic: the parent thread this belongs to. */
  conversation_id: number | null;
  status: 'queued' | 'delivered' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  result: string;
  created_at: string;
  delivered_at: string | null;
  finished_at: string | null;
}

const TEXT_MAX = 8000;
const RESULT_MAX = 4000;
const MAX_OPEN = 50; // per user — a runaway pair of agents stops here
const CHILD_MESSAGES = 12; // per child run — every note to an idle parent is a turn of the user's hourly budget
export const WAIT_DEADLINE_MS = 10 * 60_000;

// ponytail: waiters live in memory — a restart drops them, and the row is the
// record the asker reads back (check_message) once its own turn is re-run.
const waiters = new Map<number, { resolve: (reply: string) => void; reject: (err: Error) => void }>();
const pumping = new Set<string>();

// ---------------------------------------------------------------- rows

export function getMessage(userId: number, id: number): InboxRow | null {
  return (getDb().prepare('SELECT * FROM agent_inbox WHERE id = ? AND user_id = ?').get(id, userId) as InboxRow | undefined) ?? null;
}

/** The recent traffic of one ward, both directions. */
export function listInbox(userId: number, ward: string, limit = 20): InboxRow[] {
  return getDb()
    .prepare('SELECT * FROM agent_inbox WHERE user_id = ? AND (ward = ? OR sender = ?) ORDER BY id DESC LIMIT ?')
    .all(userId, ward, ward, Math.min(Math.max(1, limit), 100)) as InboxRow[];
}

function finish(id: number, status: 'done' | 'failed', result: string): void {
  const db = getDb();
  const changed = db
    .prepare(`UPDATE agent_inbox SET status = ?, result = ?, finished_at = datetime('now') WHERE id = ? AND status IN ('queued', 'delivered')`)
    .run(status, result.slice(0, RESULT_MAX), id).changes;
  if (!changed) return; // the sweep already re-armed or failed it — that run owns the row
  const w = waiters.get(id);
  waiters.delete(id);
  if (w) status === 'done' ? w.resolve(result) : w.reject(new Error(result));
  // The reply-back hop of an unwaited ask: the answer becomes a message to the
  // asker. Never for a reply itself, or two agents ping-pong until the cap —
  // and never within a family (parent ↔ child), where every reply is explicit.
  const row = getDb().prepare('SELECT * FROM agent_inbox WHERE id = ?').get(id) as InboxRow;
  if (status === 'done' && !row.wait && row.reply_to === null && result.trim() && !childJob(row.user_id, row.ward) && !childJob(row.user_id, row.sender)) {
    void sendMessage(row.user_id, { to: row.sender, from: row.ward, text: result, replyTo: row.id }).catch((err) =>
      console.error('[inbox] reply-back failed:', err)
    );
  }
}

/** Resolves with the reply when the row finishes (or at once if it already
 *  has); rejects on failure, at the deadline, or when the asker is cancelled —
 *  the delivery itself keeps going and lands in the row. */
export function waitFor(id: number, ms = WAIT_DEADLINE_MS, signal?: AbortSignal): Promise<string> {
  const row = getDb().prepare('SELECT status, result FROM agent_inbox WHERE id = ?').get(id) as { status: string; result: string } | undefined;
  if (!row) return Promise.reject(new Error(`no message #${id}`));
  if (row.status === 'done') return Promise.resolve(row.result);
  if (row.status === 'failed' || row.status === 'cancelled') return Promise.reject(new Error(row.result || row.status));
  if (signal?.aborted) return Promise.reject(new Error('cancelled while waiting for the reply'));
  return new Promise<string>((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      waiters.delete(id);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      settle();
      reject(new Error(`cancelled while waiting for the reply — check_message(${id}) shows what became of it`));
    };
    const timer = setTimeout(() => {
      settle();
      reject(new Error(`message #${id} is still being worked on after ${Math.round(ms / 60_000)} minutes — check_message(${id}) later for the answer`));
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.set(id, {
      resolve: (r) => {
        settle();
        resolve(r);
      },
      reject: (e) => {
        settle();
        reject(e);
      },
    });
  });
}

// ---------------------------------------------------------------- send

export interface Outgoing {
  to: string;
  from: string;
  text: string;
  mode?: InboxMode;
  wait?: boolean;
  replyTo?: number;
  /** Wards whose sync ask is waiting up the call — rides to the delivered turn for its own cycle guard. */
  via?: string[];
  /** The sender's thread — family traffic is checked against, and bound to, the parent's originating thread. */
  conversation?: number | null;
}

/** Queue a message and start delivering it. Validation is the trust boundary
 *  for the tool AND the reply-back hop. */
export async function sendMessage(userId: number, m: Outgoing): Promise<InboxRow> {
  const text = m.text.trim();
  if (!text) throw new Error('say something');
  if (text.length > TEXT_MAX) throw new Error(`message too long (${text.length} > ${TEXT_MAX} chars)`);
  if (m.to === m.from) throw new Error('that is you — answer directly');
  const requested: InboxMode = INBOX_MODES.includes(m.mode as InboxMode) ? (m.mode as InboxMode) : 'queue';
  const { agentWardConfig, takeHeadlessSlot } = await import('./core.ts');
  const { agentConfigured } = await import('./provider.ts');
  const child = childJob(userId, m.to);
  const fromChild = childJob(userId, m.from);
  let conversation: number | null = null;
  if (child) {
    // Only its parent ward, from the thread that started it: no other ward or
    // later thread can steer a child it does not own.
    if (child.ward !== m.from) throw new Error(`child run ${m.to} belongs to ward "${child.ward}" — only its parent can message it`);
    if (m.conversation != null && m.conversation !== child.conversation_id) throw new Error(`child run ${m.to} belongs to an earlier thread of this ward — task_output still shows its work, task_cancel still stops it`);
    if (child.state !== 'running' || !isLive(m.to)) throw new Error(`child run ${m.to} is not running (${child.state}) — nothing is listening; task_output shows what it did`);
    conversation = child.conversation_id;
  } else {
    const cfg = agentWardConfig(userId, m.to);
    if (!cfg) throw new Error(`no agent ward "${m.to}" — list_agents shows the ones that exist, task_list your child runs`);
    if (!agentConfigured(userId, cfg.provider, cfg.endpoint)) throw new Error(`${cfg.provider} is not configured on "${m.to}"`);
    if (fromChild) {
      if (fromChild.ward !== m.to) throw new Error(`a child run reports to its parent ward "${fromChild.ward}" only`);
      conversation = fromChild.conversation_id;
    }
  }
  const family = !!(child || fromChild);
  // Family traffic lands at a round boundary: a steer into the running turn,
  // else a turn of its own — never an interrupt.
  const mode: InboxMode = family ? 'steer' : requested;
  const db = getDb();
  const open = (db.prepare(`SELECT COUNT(*) AS n FROM agent_inbox WHERE user_id = ? AND status IN ('queued', 'delivered')`).get(userId) as { n: number }).n;
  if (open >= MAX_OPEN) throw new Error(`too many messages in flight already (${MAX_OPEN}) — let some finish first`);
  // The per-ward headless cap is the loop brake, taken at send so the sender
  // hears "rate limited" now rather than reading it off a failed receipt. A
  // child talking to its own parent is bounded by its life instead; a message
  // into a child is a steer, never a turn.
  if (!family) takeHeadlessSlot(userId, m.to);
  const id = db
    .prepare('INSERT INTO agent_inbox (user_id, ward, sender, mode, text, reply_to, wait, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, m.to, m.from, mode, text, m.replyTo ?? null, m.wait ? 1 : 0, conversation).lastInsertRowid as number;
  void pump(userId, m.to, m.via).catch((err) => console.error('[inbox] pump failed:', err));
  return getMessage(userId, id)!;
}

// ---------------------------------------------------------------- deliver

/** Drain one ward's queue in order. Idempotent per ward: a second call while
 *  one is draining returns at once — the drain loop picks the new row up. */
export async function pump(userId: number, ward: string, via?: string[]): Promise<void> {
  const key = `${userId}:${ward}`;
  if (pumping.has(key)) return;
  pumping.add(key);
  try {
    for (;;) {
      const row = claim(userId, ward);
      if (!row) break;
      await deliver(row, via);
    }
  } finally {
    pumping.delete(key);
  }
}

function claim(userId: number, ward: string): InboxRow | null {
  const db = getDb();
  const next = db.prepare(`SELECT id FROM agent_inbox WHERE user_id = ? AND ward = ? AND status = 'queued' ORDER BY id LIMIT 1`).get(userId, ward) as
    | { id: number }
    | undefined;
  if (!next) return null;
  const got = db.prepare(`UPDATE agent_inbox SET status = 'delivered', attempts = attempts + 1 WHERE id = ? AND status = 'queued'`).run(next.id).changes;
  return got ? getMessage(userId, next.id) : null;
}

async function deliver(row: InboxRow, via?: string[]): Promise<void> {
  const core = await import('./core.ts');
  const reply = row.reply_to !== null;
  if (childJob(row.user_id, row.ward)) {
    // Into the child's loop at its next round; done the moment it is read,
    // failed if the run ends first.
    const taken = core.steerTask(row.ward, { id: row.id, text: row.text, from: row.sender, reply,
      read: () => finish(row.id, 'done', 'read by the child run'), fail: (why) => finish(row.id, 'failed', why) });
    if (taken) getDb().prepare(`UPDATE agent_inbox SET delivered_at = datetime('now') WHERE id = ?`).run(row.id);
    else finish(row.id, 'failed', 'the child run is not running any more');
    return;
  }
  if (!getDashboard(row.user_id).some((w) => w.i === row.ward && w.type === 'agent')) {
    finish(row.id, 'failed', `agent ward "${row.ward}" is gone from the layout`);
    return;
  }
  if (row.conversation_id !== null) {
    // Bound to the parent's originating thread. An archived thread never runs
    // again: a child's report is filed into it (once, as its task notice) and
    // the receipt says so; the active chat is never handed another thread's child.
    const target = getConversation(row.conversation_id);
    if (!target || !target.active || target.task_id) {
      let filed = false;
      try { filed = childJob(row.user_id, row.sender) ? fileChildNotice(row.user_id, row.sender) : false; }
      catch (err) { console.error('[inbox] filing a child notice failed (still owed):', err instanceof Error ? err.message : err); }
      finish(row.id, filed ? 'done' : 'failed', filed ? 'the parent thread is archived — the report was filed into it; task_output has the full result' : 'the parent thread is archived — nothing was delivered');
      return;
    }
  }
  if (row.mode === 'steer' && core.wardBusy(row.user_id, row.ward)) {
    // Into the running turn (the active thread's — the only one that runs);
    // that turn finishes the row when it ends.
    getDb().prepare(`UPDATE agent_inbox SET delivered_at = datetime('now') WHERE id = ?`).run(row.id);
    core.steerTurn(row.user_id, row.ward, { id: row.id, text: row.text, from: row.sender, reply, wait: !!row.wait, done: (r) => finish(row.id, 'done', r) });
    return;
  }
  if (row.mode === 'interrupt') core.interruptTurn(row.user_id, row.ward, `agent "${core.peerTitle(row.user_id, row.sender)}"`);
  try {
    const answer = await core.runHeadlessTurn(row.user_id, row.ward, row.text, {
      kind: 'agent',
      from: row.sender,
      reply,
      via,
      id: row.id,
      wait: !!row.wait,
      ...(row.conversation_id !== null ? { conversation: row.conversation_id } : {}),
      onStart: () => getDb().prepare(`UPDATE agent_inbox SET delivered_at = datetime('now') WHERE id = ?`).run(row.id),
    });
    finish(row.id, 'done', answer);
  } catch (err) {
    finish(row.id, 'failed', err instanceof Error ? err.message : 'delivery failed');
  }
}

// ---------------------------------------------------------------- sweep

/**
 * Re-arm what a dead process left 'delivered' and drain every queue with rows
 * waiting. `boot` re-arms every delivered row (nothing can be in flight at
 * boot); the tick only re-arms rows an hour stale, the same rule as wakes. One
 * retry, then the row fails — a third run would repeat writes every hour.
 */
export async function sweepInbox(boot = false): Promise<number> {
  const db = getDb();
  // Family rows are never re-armed: a child's steer has no run to land in, and
  // a wake re-run would be a fresh parent turn for a result the task notice
  // already holds — one retry is one replay too many there.
  db.prepare(
    `UPDATE agent_inbox SET
            status = CASE WHEN attempts >= 2 OR family THEN 'failed' ELSE 'queued' END,
            result = CASE WHEN family THEN 'interrupted — not retried; a child result stays in its task notice' WHEN attempts >= 2 THEN 'interrupted twice — not retried; ask again' ELSE result END,
            finished_at = CASE WHEN attempts >= 2 OR family THEN datetime('now') ELSE finished_at END
      FROM (SELECT id AS row_id, (sender IN (SELECT id FROM agent_jobs WHERE tool = 'spawn_agent') OR ward IN (SELECT id FROM agent_jobs WHERE tool = 'spawn_agent')) AS family FROM agent_inbox) AS f
      WHERE agent_inbox.id = f.row_id AND status = 'delivered' AND (? OR COALESCE(delivered_at, created_at) < datetime('now', '-60 minutes'))`
  ).run(boot ? 1 : 0);
  const wards = db.prepare(`SELECT DISTINCT user_id, ward FROM agent_inbox WHERE status = 'queued'`).all() as { user_id: number; ward: string }[];
  for (const w of wards) void pump(w.user_id, w.ward).catch((err) => console.error('[inbox] pump failed:', err));
  return wards.length;
}

// ---------------------------------------------------------------- the tool's entry

/** The run is over: every question it still had open closes with the run's own
 *  outcome (cancelled, or failed for anything else) — a waiting tool call was
 *  already released; this is the receipt. */
export function closeChildQuestions(userId: number, child: string, state: string): number {
  const cancelled = state === 'cancelled';
  const rows = getDb()
    .prepare(`UPDATE agent_inbox SET status = ?, result = ?, finished_at = datetime('now') WHERE user_id = ? AND sender = ? AND wait = 1 AND status IN ('queued', 'delivered') RETURNING id`)
    .all(cancelled ? 'cancelled' : 'failed', cancelled ? 'the child run was cancelled while waiting for the answer' : `the child run ${state} before the answer came`, userId, child) as { id: number }[];
  for (const r of rows) {
    const w = waiters.get(r.id);
    waiters.delete(r.id);
    w?.reject(new Error(cancelled ? 'cancelled' : 'the child run ended'));
  }
  return rows.length;
}

/** A child's question the parent has not answered yet, oldest first. */
function openQuestion(userId: number, child: string, parentWard: string): InboxRow | null {
  return (getDb()
    .prepare(`SELECT * FROM agent_inbox WHERE user_id = ? AND sender = ? AND ward = ? AND wait = 1 AND status IN ('queued', 'delivered') ORDER BY id LIMIT 1`)
    .get(userId, child, parentWard) as InboxRow | undefined) ?? null;
}

/** The parent's explicit answer to a child's waited question: closes that row —
 *  the child's ask_agent returns with the text — and sends nothing new. */
function answerQuestion(userId: number, parentWard: string, child: string, id: number, text: string): { message_id: number; answered: true; note: string } {
  const row = getMessage(userId, id);
  if (!row || row.sender !== child || row.ward !== parentWard || !row.wait) throw new Error(`#${id} is not a question from child run ${child} to you`);
  if (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') throw new Error(`#${id} was already ${row.status} (${row.result.slice(0, 80)}) — send a plain ask_agent to the child instead`);
  finish(id, 'done', text.trim());
  return { message_id: id, answered: true, note: `child run ${child} received this as the answer to its question #${id}` };
}

/**
 * ask_agent: send, and either wait for the receipt to close or hand back the
 * id. The cycle guard is here: a waited ask to a ward that is itself waiting
 * on this turn would hold both chains forever.
 *
 * Family protocol (one shape, both directions):
 *   child → parent  wait (default): the parent's answer IS the tool result —
 *                   its reply to a turn of its own, or, if it is mid-turn, its
 *                   explicit reply_to answer or else its end-of-turn reply.
 *                   wait:false: a note; nothing comes back on its own.
 *   parent → child  reply_to: answers that question. A plain message while the
 *                   child is waiting on a question answers the oldest one; with
 *                   nothing open it is a note the child reads at its next round.
 */
export async function askAgent(
  ctx: { userId: number; ward: string; conv?: number; via?: string[]; task?: string; signal?: AbortSignal },
  target: string,
  message: string,
  opts: { wait?: boolean; mode?: InboxMode; replyTo?: number } = {}
): Promise<{ message_id: number; from: string; reply: string } | { message_id: number; queued: true; note: string } | { message_id: number; answered: true; note: string }> {
  // A child run speaks as its task id; its parent ward is a peer to it.
  const self = ctx.task ?? ctx.ward;
  if (target === self) throw new Error('that is you — answer directly');
  if (ctx.signal?.aborted) throw new Error('cancelled — nothing sent');
  const text = message.trim();
  if (!text) throw new Error('say something');
  if (text.length > TEXT_MAX) throw new Error(`message too long (${text.length} > ${TEXT_MAX} chars)`);
  const child = childJob(ctx.userId, target);
  if (child) {
    // Every path to a child — an answer as much as a note — is the parent's,
    // from the thread that started it, to a child that is still running.
    if (ctx.task || child.ward !== self) throw new Error(`child run ${target} belongs to ward "${child.ward}" — only its parent can message it`);
    if (ctx.conv != null && ctx.conv !== child.conversation_id) throw new Error(`child run ${target} belongs to an earlier thread of this ward — task_output still shows its work, task_cancel still stops it`);
    if (child.state !== 'running' || !isLive(target)) throw new Error(`child run ${target} is not running (${child.state}) — nothing is listening; task_output shows what it did`);
  }
  if (opts.replyTo !== undefined) {
    if (!child) throw new Error('reply_to answers a question from one of your child runs — ward must be its task_id');
    return answerQuestion(ctx.userId, self, target, opts.replyTo, text);
  }
  if (child) {
    // A waiting child cannot read a note: what it is waiting for is the answer.
    const pending = openQuestion(ctx.userId, target, self);
    if (pending) return answerQuestion(ctx.userId, self, target, pending.id, text);
  }
  if (ctx.task && (getDb().prepare('SELECT COUNT(*) AS n FROM agent_inbox WHERE user_id = ? AND sender = ?').get(ctx.userId, ctx.task) as { n: number }).n >= CHILD_MESSAGES) {
    throw new Error(`you have sent ${CHILD_MESSAGES} messages already — finish the job and put the rest in your final report`);
  }
  const wait = !child && opts.wait !== false;
  const via = [...(ctx.via ?? []), self];
  if (wait && via.includes(target)) {
    throw new Error(`"${target}" is waiting on YOUR answer right now — put what you have to say in your reply, or send it with wait:false`);
  }
  const row = await sendMessage(ctx.userId, { to: target, from: self, text, mode: opts.mode, wait, via, conversation: ctx.conv ?? null });
  if (!wait) {
    return { message_id: row.id, queued: true, note: child
      ? `child run ${target} reads this at its next round; it can answer with a message of its own. check_message(${row.id}) shows the receipt`
      : ctx.task
        ? `noted for your parent — no reply comes back on its own; it may message you between your rounds. check_message(${row.id}) shows the receipt`
        : `"${target}" will answer in a later turn of yours; check_message(${row.id}) shows the receipt` };
  }
  return { message_id: row.id, from: target, reply: await waitFor(row.id, WAIT_DEADLINE_MS, ctx.signal) };
}
