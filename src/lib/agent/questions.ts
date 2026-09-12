import { randomUUID } from 'node:crypto';
import { getDb } from '../db.ts';
import { getSetting, setSetting, deleteSetting } from '../settings.ts';
import { broadcast } from '../logic-engine.ts';
import { activeConversationRow, addMessage, appendItems, getConversation, userItemFor, type ConvRow } from './conversations.ts';
import type { ToolCtx } from './tools.ts';

export interface UserQuestion {
  question: string;
  input: 'single' | 'multiple' | 'text';
  options: string[];
  wait: boolean;
}
export interface PendingQuestion extends UserQuestion { id: string }
export type UserAnswer = string | string[];
interface StoredQuestion extends PendingQuestion { userId: number; answer?: UserAnswer | null }
const key = (conv: number) => `agent_question:${conv}`;

export function parseUserQuestion(raw: Record<string, unknown>): UserQuestion {
  if (typeof raw.question !== 'string' || !raw.question.trim() || raw.question.length > 4000) throw Error('Provide a question of 1–4000 characters.');
  const input = raw.input ?? 'text';
  if (input !== 'single' && input !== 'multiple' && input !== 'text') throw Error('input must be single, multiple, or text.');
  if (raw.wait !== undefined && typeof raw.wait !== 'boolean') throw Error('wait must be a boolean.');
  const options = raw.options ?? [];
  if (!Array.isArray(options) || options.some(x => typeof x !== 'string' || !x.trim() || x.length > 200)) throw Error('Options must be nonempty strings, at most 200 characters each.');
  const labels = options.map(x => (x as string).trim());
  if (new Set(labels).size !== labels.length || (input === 'text' ? labels.length !== 0 : labels.length < 2 || labels.length > 12))
    throw Error('Choice questions need 2–12 distinct options; text questions have no options.');
  return { question: raw.question.trim(), input, options: labels, wait: raw.wait !== false };
}

export function validateUserAnswer(question: UserQuestion, raw: unknown): UserAnswer {
  if (question.input === 'multiple') {
    if (!Array.isArray(raw) || !raw.length || raw.length > question.options.length || new Set(raw).size !== raw.length || raw.some(x => typeof x !== 'string' || !question.options.includes(x)))
      throw Error('Choose one or more of the offered options.');
    return question.options.filter(x => raw.includes(x));
  }
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 8000) throw Error('Provide an answer of 1–8000 characters.');
  if (question.input === 'single' && !question.options.includes(raw)) throw Error('Choose one of the offered options.');
  return raw.trim();
}

export const questionAnswerText = (question: UserQuestion, answer: UserAnswer) => `Answer to “${question.question}”:\n${Array.isArray(answer) ? answer.join('\n') : answer}`;

export function storedUserQuestion(userId: number, conv: number): StoredQuestion | null {
  const raw = getSetting(key(conv));
  if (!raw) return null;
  const q = JSON.parse(raw) as StoredQuestion;
  return q.userId === userId ? q : null;
}

export function postUserQuestion(raw: Record<string, unknown>, ctx: ToolCtx) {
  const question = parseUserQuestion(raw), conv = getConversation(ctx.conv);
  if (!conv || conv.user_id !== ctx.userId || conv.ward !== ctx.ward || ctx.task) throw Error('Ask the user from the main conversation; child runs should ask their parent.');
  if (activeConversationRow(ctx.userId, ctx.ward)?.id !== ctx.conv) throw Error('The conversation changed before the question could be shown.');
  if (question.wait) throw Error('Waiting questions must be paused by the conversation dispatcher.');
  if (storedUserQuestion(ctx.userId, ctx.conv)) throw Error('A question is already awaiting an answer or delivery.');
  const q: StoredQuestion = { ...question, id: randomUUID(), userId: ctx.userId };
  setSetting(key(ctx.conv), JSON.stringify(q));
  broadcast(ctx.userId, 'agent-live', { ward: ctx.ward, event: { type: 'question', question: q } });
  return { question_id: q.id, waiting: false, note: 'Question shown. Continue independent work; the user’s answer will arrive in this conversation.' };
}

export function saveUserAnswer(userId: number, conv: number, id: string, raw: unknown) {
  const q = storedUserQuestion(userId, conv);
  if (!q || q.id !== id) throw Error('This question is no longer current.');
  const answer = raw === null ? null : validateUserAnswer(q, raw);
  if (q.answer !== undefined && JSON.stringify(q.answer) !== JSON.stringify(answer)) throw Error('This question has already been answered.');
  setSetting(key(conv), JSON.stringify({ ...q, answer }));
}

/** Claim and persist an asynchronous answer together; restart cannot lose or replay it. */
export function drainUserAnswer(conv: ConvRow): { item: unknown; text: string; query?: string } | null {
  return getDb().transaction(() => {
    const q = storedUserQuestion(conv.user_id, conv.id);
    if (!q || q.answer === undefined) return null;
    const text = q.answer === null ? `Skipped question: ${q.question}` : questionAnswerText(q, q.answer), item = userItemFor(conv.dialect, text);
    appendItems(conv.id, [item]); addMessage(conv, { role: 'user', text, source: 'chat' });
    deleteSetting(key(conv.id));
    return { item, text, query:q.answer === null ? undefined : Array.isArray(q.answer) ? q.answer.join('\n') : q.answer };
  })();
}
export function clearUserQuestion(conv: ConvRow) { drainUserAnswer(conv); deleteSetting(key(conv.id)); }
