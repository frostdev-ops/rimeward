import { getDb } from '../db.ts';
import fs from 'node:fs';
import path from 'node:path';
import { getAttachment, attachmentDataUrl } from './attachments.ts';
import { appendTurn, historyDir } from './history.ts';
import { dialectOf, providerDialect, type AgentProvider, type AgentProviderId, type Dialect } from './provider.ts';
import { estimateTokens, type ContextUsage } from './context.ts';

// The agent's memory, per (user, ward). Two views of one conversation:
//   agent_messages — what the ward renders
//   agent_items    — the raw wire conversation replayed to the provider,
//                    verbatim (codex reasoning items must ride along)
//
// A conversation is PINNED to the provider it started on; when the ward's
// config names a different one, the thread is retired and a fresh one starts —
// the two dialects' stored items are mutually unreadable.

const COMPACT_FRACTION = 0.6;
const IMAGE_TURNS = 2; // images are re-sent every round; only recent ones ride along

export interface ConvRow {
  id: number;
  user_id: number;
  ward: string;
  /** The wire dialect the stored items are written in — pinned for the thread's life. */
  dialect: Dialect;
  /** The provider (and, for compat, endpoint) the thread runs on — a change retires it. */
  provider: AgentProviderId;
  endpoint: string | null;
  active: number;
  pending_confirm_id: string | null;
  /** Set on a child run's thread (the agent_jobs id); null on a ward's own threads. */
  task_id: string | null;
}

export interface AgentStep {
  /** The provider's call id, and the tool round it ran in: every step of one
   *  round ran in parallel, and the client draws them as one batch. Absent on
   *  steps older than batching, and on a confirm resolved out of band. */
  id?: string;
  round?: number;
  tool: string;
  kind: string;
  args: Record<string, unknown>;
  reason?: string;
  result?: unknown;
  error?: string;
  ms?: number;
}

/** What produced a turn. 'chat' = the user typed it; the others ran unattended. */
export type TurnSource = 'chat' | 'automation' | 'wake' | 'agent';

export interface TranscriptMsg {
  role: 'user' | 'assistant';
  text: string;
  steps?: AgentStep[];
  source: TurnSource;
  at: string;
}

export function getConversation(id: number): ConvRow | null {
  return (getDb().prepare('SELECT * FROM agent_conversations WHERE id = ?').get(id) as ConvRow | undefined) ?? null;
}

/** The active thread for a ward, if one exists. Read-only: unlike
 *  activeConversation it never creates a row. */
export function activeConversationRow(userId: number, ward: string): ConvRow | null {
  return (
    (getDb()
      .prepare('SELECT * FROM agent_conversations WHERE user_id = ? AND ward = ? AND active = 1')
      .get(userId, ward) as ConvRow | undefined) ?? null
  );
}

/** The active thread for a ward — created (or retired-and-recreated on a
 *  provider change) as needed. */
export function activeConversation(userId: number, ward: string, provider: AgentProviderId, endpoint?: string | null): ConvRow {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM agent_conversations WHERE user_id = ? AND ward = ? AND active = 1')
    .get(userId, ward) as ConvRow | undefined;
  const ep = provider === 'compat' ? endpoint ?? null : null;
  if (row && row.provider === provider && (row.endpoint ?? null) === ep) return row;
  if (row) db.prepare('UPDATE agent_conversations SET active = 0 WHERE id = ?').run(row.id);
  const id = Number(
    db
      .prepare('INSERT INTO agent_conversations (user_id, ward, dialect, provider, endpoint) VALUES (?, ?, ?, ?, ?)')
      .run(userId, ward, dialectOf(provider), provider, ep).lastInsertRowid
  );
  return getConversation(id)!;
}

/** A child run's own thread: under the parent ward, never active, linked to its job. */
export function childConversation(userId: number, ward: string, provider: AgentProviderId, endpoint: string | null, taskId: string): ConvRow {
  const id = Number(
    getDb()
      .prepare('INSERT INTO agent_conversations (user_id, ward, dialect, provider, endpoint, active, task_id) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(userId, ward, dialectOf(provider), provider, provider === 'compat' ? endpoint : null, taskId).lastInsertRowid
  );
  return getConversation(id)!;
}

/** Fork: the parent's replay, verbatim, as the start of a child's thread. The
 *  copy boundary checks what the caller cannot be trusted with: both threads
 *  belong to one user and one ward and speak one dialect, or nothing is copied. */
export function copyItems(from: number, to: number): number {
  const db = getDb();
  const ok = db
    .prepare('SELECT a.id FROM agent_conversations a JOIN agent_conversations b ON b.id = ? WHERE a.id = ? AND a.user_id = b.user_id AND a.ward = b.ward AND a.dialect = b.dialect')
    .get(to, from);
  if (!ok) throw new Error('fork refused: the source thread is not this ward’s own, or is written in another dialect');
  return db.prepare('INSERT INTO agent_items (conversation_id, json, chars) SELECT ?, json, chars FROM agent_items WHERE conversation_id = ? ORDER BY id').run(to, from).changes;
}

/** A user message in the shape a thread's dialect stores — for filing a note
 *  into a thread without loading its provider. */
export const userItemFor = (dialect: Dialect, text: string): unknown =>
  dialect === 'codex' ? { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } : { role: 'user', content: text };

/** "Clear" retires the thread — nothing is destroyed. */
export function retireConversation(userId: number, ward: string): void {
  getDb().prepare('UPDATE agent_conversations SET active = 0 WHERE user_id = ? AND ward = ?').run(userId, ward);
}

export function setPendingConfirm(conversationId: number, confirmId: string | null): void {
  getDb().prepare('UPDATE agent_conversations SET pending_confirm_id = ? WHERE id = ?').run(confirmId, conversationId);
}

function touch(conversationId: number): void {
  getDb().prepare(`UPDATE agent_conversations SET updated_at = datetime('now') WHERE id = ?`).run(conversationId);
}

// ---------------------------------------------------------------- messages

export function addMessage(
  conv: ConvRow,
  msg: { role: 'user' | 'assistant'; text: string; steps?: AgentStep[]; source?: TurnSource }
): void {
  getDb()
    .prepare('INSERT INTO agent_messages (conversation_id, role, text, steps_json, source) VALUES (?, ?, ?, ?, ?)')
    .run(conv.id, msg.role, msg.text, msg.steps?.length ? JSON.stringify(msg.steps) : null, msg.source ?? 'chat');
  // Disk mirror so the bash sandbox can rg its own past (/history mount).
  appendTurn(conv.user_id, conv.id, msg.role, msg.text, { steps: msg.steps });
  touch(conv.id);
}

export function transcript(conversationId: number, limit = 60): TranscriptMsg[] {
  const rows = getDb()
    .prepare('SELECT * FROM (SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
    .all(conversationId, limit) as {
    role: 'user' | 'assistant';
    text: string;
    steps_json: string | null;
    source: TurnSource | null;
    at: string;
  }[];
  return rows.map((r) => {
    let steps: AgentStep[] | undefined;
    try {
      steps = r.steps_json ? JSON.parse(r.steps_json) : undefined;
    } catch {
      /* malformed steps must not cost the user their history */
    }
    return { role: r.role, text: r.text, steps, source: r.source ?? 'chat', at: r.at };
  });
}

// ---------------------------------------------------------------- raw items

/** Both dialects mark a user turn this way (codex adds type:'message'). */
const isUserMsg = (it: any): boolean =>
  it?.role === 'user' && (it.type === 'message' || it.type === undefined);

/** A tool RESULT in either dialect. The compaction boundary must never land on
 *  one: its call would go into the summary, the output would stay in the tail
 *  as an orphan, and repairItems would then delete the orphan — leaving the
 *  result in neither half. */
const isToolOutput = (it: any): boolean =>
  it?.type === 'function_call_output' || (it?.role === 'tool' && !!it.toolCallId);

/** Image bytes live in the attachment store, not in five copies of the thread.
 *  Image parts carry a file_id (codex dialect) / fileId (openrouter) that the
 *  providers strip before sending — it exists for exactly this bookkeeping. */
function dehydrate(item: unknown): unknown {
  const it = item as { type?: string; role?: string; content?: unknown };
  if (!Array.isArray(it?.content)) return item;
  return {
    ...it,
    content: it.content.map((c: any) => {
      if (c?.type === 'input_image' && typeof c.image_url === 'string' && c.image_url.startsWith('data:') && c.file_id) {
        return { type: 'input_image', image_url: `attachment:${c.file_id}`, file_id: c.file_id };
      }
      if (c?.type === 'image_url' && typeof c.imageUrl?.url === 'string' && c.imageUrl.url.startsWith('data:') && c.fileId) {
        return { type: 'image_url', imageUrl: { url: `attachment:${c.fileId}` }, fileId: c.fileId };
      }
      return c;
    }),
  };
}

function rehydrate(userId: number, item: unknown, withImages: boolean): unknown {
  const it = item as { type?: string; role?: string; content?: unknown };
  if (!Array.isArray(it?.content)) return item;
  const content: unknown[] = [];
  for (const c of it.content as any[]) {
    const codexRef = c?.type === 'input_image' && typeof c.image_url === 'string' && c.image_url.startsWith('attachment:');
    const orRef = c?.type === 'image_url' && typeof c.imageUrl?.url === 'string' && c.imageUrl.url.startsWith('attachment:');
    if (!codexRef && !orRef) {
      content.push(c);
      continue;
    }
    const id = Number(codexRef ? c.image_url.slice('attachment:'.length) : c.imageUrl.url.slice('attachment:'.length));
    const f = getAttachment(userId, id);
    const url = withImages && f ? attachmentDataUrl(f) : null;
    // A dropped image leaves a note — the model should know something was
    // attached rather than see a turn that makes no sense.
    if (url) content.push(codexRef ? { type: 'input_image', image_url: url, file_id: id } : { type: 'image_url', imageUrl: { url }, fileId: id });
    else {
      const text = `[image ${f?.name ?? 'attachment'} was attached earlier in this conversation]`;
      content.push(codexRef ? { type: 'input_text', text } : { type: 'text', text });
    }
  }
  return { ...it, content };
}

export function appendItems(conversationId: number, items: unknown[]): void {
  const db = getDb();
  const ins = db.prepare('INSERT INTO agent_items (conversation_id, json, chars) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const raw of items) {
      const json = JSON.stringify(dehydrate(raw));
      ins.run(conversationId, json, json.length);
    }
  })();
  touch(conversationId);
}

/**
 * Replay the whole retained conversation, rehydrate recent images, then repair
 * tool pairs. Compaction happens with the complete request's token budget in
 * runLoop; loading must never silently discard the user's instructions.
 */
export function loadItems(conv: ConvRow, provider: AgentProvider, keepOpen: Set<string>): unknown[] {
  // Raw Responses items and chat-completion messages are mutually unreadable:
  // a thread is only ever replayed to a provider of its own dialect.
  if (providerDialect(provider) !== conv.dialect) throw new Error(`thread ${conv.id} is written in the ${conv.dialect} dialect and cannot be replayed to ${provider.id}`);
  const rows = getDb()
    .prepare('SELECT json FROM agent_items WHERE conversation_id = ? ORDER BY id')
    .all(conv.id) as { json: string }[];
  const kept = rows.map((r) => safeParse(r.json)).filter(Boolean);
  const userTurns: number[] = [];
  kept.forEach((it, i) => {
    if (isUserMsg(it)) userTurns.push(i);
  });
  const imagesFrom = userTurns.length > IMAGE_TURNS ? userTurns[userTurns.length - IMAGE_TURNS]! : 0;
  return provider.repairItems(
    kept.map((it, i) => rehydrate(conv.user_id, it, i >= imagesFrom)),
    keepOpen
  );
}

// ---------------------------------------------------------------- compaction
//
// Truncation loses the beginning of a long session — the part that says what
// was decided. The oldest stretch is summarised by the same provider and
// replaced with one item; the verbatim transcript stays under /history where
// the bash tool can rg it.

/** `force` is the /compact command: same fold, thresholds skipped. It still
 *  needs enough items to have an older half worth folding. `focus` is that
 *  command's optional hint about what the brief must not lose. */
export function needsCompaction(usage: ContextUsage): boolean {
  return usage.compactAt !== null && usage.tokens >= usage.compactAt;
}

export async function compactIfNeeded(
  conv: ConvRow,
  provider: AgentProvider,
  model: string,
  force = false,
  focus = '',
  usage?: ContextUsage,
  /** A Stop while the summary is being written aborts that call too. */
  signal?: AbortSignal
): Promise<boolean> {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, json, chars FROM agent_items WHERE conversation_id = ? ORDER BY id')
    .all(conv.id) as { id: number; json: string; chars: number }[];
  const total = rows.reduce((n, r) => n + r.chars, 0);
  if (force ? rows.length < 4 : rows.length < 2 || !usage || !needsCompaction(usage)) return false;

  let acc = 0;
  let end = 0;
  for (let i = 0; i < rows.length; i++) {
    acc += rows[i]!.chars;
    if (acc >= total * COMPACT_FRACTION) {
      end = i;
      break;
    }
  }
  // Extend to a user-message boundary so the surviving tail starts a turn.
  const boundary = rows.findIndex((r, i) => i >= end && isUserMsg(safeParse(r.json)));
  if (boundary > 0) end = boundary;
  // No boundary to be had (a long final tool loop — the usual shape for codex,
  // whose encrypted reasoning blobs push the fraction deep into the last turn).
  // Then at least keep every tool result with the call it answers.
  else while (end < rows.length && isToolOutput(safeParse(rows[end]!.json))) end++;

  // One item can be most of the conversation on its own — a big inlined
  // document, or a single fat reasoning blob. Folding just that one is the
  // whole point of the request, so don't refuse; the shrink check below is what
  // decides whether the fold was worth committing.
  if (end <= 0) end = 1;
  end = Math.min(end, rows.length - 1); // the tail must never be empty

  const older = rows.slice(0, end);
  const olderChars = older.reduce((n, r) => n + r.chars, 0);
  const limits = await provider.context?.(conv.user_id, model).catch(() => undefined);
  let plain = older
    .map((r) => summarisable(safeParse(r.json)))
    .filter(Boolean)
    .join('\n')
    .slice(0, 120_000);
  const summaryBudget = Math.max(0, (limits?.inputLimit ?? 31_000) - 1000);
  while (plain && estimateTokens(plain) > summaryBudget) {
    plain = plain.slice(0, Math.floor(plain.length * summaryBudget / estimateTokens(plain) * .95));
  }
  if (!plain.trim()) return false;

  const result = await provider.run({
    userId: conv.user_id,
    model,
    instructions:
      'You are compacting the earlier part of a dashboard-assistant conversation so it can be carried forward in less space. ' +
      'Write a dense factual brief, no preamble. Cover: what the user asked for, what was actually changed (wards, ' +
      'automations, mail sent — with ward ids, edge ids and exact values), what was refused or left undone, decisions and ' +
      'corrections, and anything still open. Never invent. Prefer identifiers over adjectives.' +
      // The user's own words about what this thread is for. Additive: it steers
      // what survives in full, it never licenses dropping the rest.
      (focus
        ? `\n\nThe user asked you to pay particular attention to this — keep every detail bearing on it, and stay ` +
          `brief about the rest:\n${focus.slice(0, 500)}`
        : ''),
    items: [provider.userItem(plain)],
    tools: [],
    signal,
    // A child's compaction is a child's call: it shares the child slots, never the foreground's.
    child: !!conv.task_id,
  });

  // A model that answered with nothing (or a refusal that is all whitespace)
  // must not replace real context: SQLite is the only copy of these items.
  if (!result.text.trim()) {
    console.error(`[agent] compaction of conversation ${conv.id} produced no summary — kept the items`);
    return false;
  }

  const summary = provider.userItem(
    `[Earlier in this conversation, compacted. The transcript is at /history/${conv.id}.md; ` +
      `the full original items removed by compaction are at /history/${conv.id}.compacted.jsonl — ` +
      `search it with the bash tool if you need a detail that is not here.]\n\n${result.text}`
  );
  const json = JSON.stringify(summary);
  // Folding has to actually pay for itself. Without this, a conversation whose
  // first item is already a summary re-summarizes that summary every single
  // turn: one wasted model round-trip each time, freeing nothing and degrading
  // the brief with every pass.
  if (json.length >= olderChars) {
    console.log(`[agent] skipped compacting conversation ${conv.id}: the summary is no smaller than the ${older.length} items`);
    return false;
  }

  // Mid-turn tool results may not have reached the final assistant message yet.
  // Archive before deleting; a failed archive must leave the replay untouched.
  fs.appendFileSync(path.join(historyDir(conv.user_id), `${conv.id}.compacted.jsonl`),
    older.map((r) => JSON.stringify({ id: r.id, item: safeParse(r.json) })).join('\n') + '\n', { flush: true });
  db.transaction(() => {
    db.prepare('DELETE FROM agent_items WHERE id IN (' + older.map(() => '?').join(',') + ')').run(...older.map((r) => r.id));
    // The oldest row's id, so ordering survives without renumbering.
    db.prepare('INSERT INTO agent_items (id, conversation_id, json, chars) VALUES (?, ?, ?, ?)').run(
      older[0]!.id,
      conv.id,
      json,
      json.length
    );
  })();
  console.log(`[agent] compacted conversation ${conv.id}: ${older.length} items -> 1 summary`);
  return true;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const SUMMARY_PART_CAP = 2000;
const cap = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > SUMMARY_PART_CAP ? `${s.slice(0, SUMMARY_PART_CAP)}…` : s;
};

/**
 * One readable line per item (either dialect), for the summariser.
 *
 * Order matters. The chat dialect stores an assistant message that BOTH speaks
 * and calls tools as one item ({content:'Let me check…', toolCalls:[…]}), which
 * is how most models answer — so a generic `content` branch placed first would
 * report what the agent said and silently lose everything it did. Tool shapes
 * are therefore matched before the plain-text ones, and every part is capped:
 * uncapped tool output let two fat early results eat the whole 120k budget and
 * push the recent, still-relevant part of the region out of the brief.
 */
function summarisable(item: unknown): string {
  const it = item as any;
  if (!it) return '';

  // Tool traffic first, in both dialects.
  if (it.type === 'function_call') return `tool ${it.name}(${cap(it.arguments)})`;
  if (it.type === 'function_call_output') return `result: ${cap(it.output)}`;
  if (it.role === 'tool') return `result: ${cap(it.content)}`;

  const lines: string[] = [];
  if (typeof it.content === 'string' && it.content.trim() && it.role) {
    lines.push(`${it.role}: ${it.content}`);
  } else if (Array.isArray(it.content)) {
    const text = it.content
      .map((c: any) => (typeof c?.text === 'string' ? c.text : c?.type?.includes('image') ? '[image]' : ''))
      .filter(Boolean)
      .join(' ');
    if (text) lines.push(`${it.role ?? 'assistant'}: ${text}`);
  }
  if (Array.isArray(it.toolCalls)) {
    for (const tc of it.toolCalls) lines.push(`tool ${tc.function?.name}(${cap(tc.function?.arguments)})`);
  }
  return lines.join('\n');
}

export function conversationSize(conversationId: number): { items: number; chars: number } {
  return getDb()
    .prepare('SELECT COUNT(*) AS items, COALESCE(SUM(chars), 0) AS chars FROM agent_items WHERE conversation_id = ?')
    .get(conversationId) as { items: number; chars: number };
}
