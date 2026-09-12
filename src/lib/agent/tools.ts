import { DEV_TOOLS } from '../dev/tools.ts';
import { listTasks, readTask, waitTask, cancelTask, childJob } from './tasks.ts';
import { postUserQuestion } from './questions.ts';
import { searchKnowledge, readKnowledge } from './knowledge.ts';
import type { ToolSearch } from './tool-discovery.ts';
import { manageMonitor } from './monitors.ts';
import { isDesktop } from '../dev/runtime.ts';
import { sharedTool, serverTool } from './sync.ts';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { renderPdfPage } from './docs.ts';
import { getDb } from '../db.ts';
import { getDashboard, getPages, saveDashboard } from '../dashboard.ts';
import { browserId } from '../browser/routing.ts';
import { browserCall, browserRequest } from '../browser/request.ts';
import { DOWNLOAD_BYTES, type BrowserDownload } from '../browser/downloads.ts';
import { validateLayout, validatePages, wardTitle, pageSlug, AGENT_EFFORTS, AGENT_PROVIDERS, isAgentProvider, CATALOG, MAX_H, MAX_PAGES, MAX_W, type PageDef, type WardInstance, type WardSize } from '../wards.ts';
import { validateGraph, CHANNEL_RE, type LogicGraph } from '../logic.ts';
import {
  broadcast,
  enqueueFire,
  getGraph,
  getRuns,
  pruneUserLogic,
  saveGraph,
  timerOp,
} from '../logic-engine.ts';
import { getSnapshot, getHistory, recentIncidents } from '../status.ts';
import { forecastFor } from '../weather.ts';
import { agenda } from '../calendar.ts';
import { MAIL_ACCOUNTS } from '../wards.ts';
import {
  notionAddComment,
  notionAppendBlocks,
  notionArchive,
  notionBlocks,
  notionCapture,
  notionChecklist,
  notionChecklistAdd,
  notionChecklistToggle,
  notionComments,
  notionCreateDatabase,
  notionCreatePage,
  notionCreateSource,
  notionDataSources,
  notionDatabases,
  notionDeleteBlock,
  notionPage,
  notionQuery,
  notionRecent,
  notionSearch,
  notionSourceId,
  notionSourceSchema,
  notionTasks,
  notionUpdateBlock,
  notionUpdateDatabase,
  notionUpdateProps,
  notionUpdateSource,
  notionUsers,
  taskWardSource,
} from '../notion.ts';
import { buildFilter, opsFor, type FilterSpec } from '../notion-filter.ts';
import { WRITABLE } from '../notion-blocks.ts';
import { getTimers } from '../timers.ts';
import { createPacket, listPackets, markPassed, completePacket } from '../flow.ts';
import { asAccount, mailInbox, sendNow } from '../mail.ts';
import { normalizeTheme, parseTheme } from '../theme.ts';
import { getAttachment, listAttachments, readPages, searchAttachment, storeAttachment, attachmentPath } from './attachments.ts';
import { plainText, readNote, resolveNote, textToHtml, writeNote } from '../note.ts';
import { askNotebook, createNote, getNotebook, linkNote, listNotebooks, listNotes, noteBacklinks, notebookIndex, notebookWardsOf, purgeNote, unlinkNote, updateNoteMeta } from '../notebook.ts';
import { getNoteMeta } from '../note.ts';
import { runShell, shellNetworkEnabled } from './shell.ts';
import { webSearch } from './websearch.ts';
import { scheduleWake, cancelWake, listWakes } from './wakes.ts';
import type { AgentToolSpec } from './provider.ts';
import { deleteDoc, docPath, writeDoc, DOC_DESC_MAX, STORES, type StoreKind } from './store.ts';
import { askAgent, getMessage, listInbox, INBOX_MODES, type InboxMode, type InboxRow } from './inbox.ts';
import { opsDoc } from '../comms/ops.ts';
import { COMMS_TYPES, isCommsType } from '../comms/types.ts';

// The agent's tool registry. Every wrap goes through the SAME trust boundary
// the HTTP routes use — validateLayout/validateGraph rebuild, stored-layout
// ward resolution, sendNow revalidation — never around it.
//
// kind: 'read' is always free; 'write' is user-visible and reversible (layout,
// edges, timers, packets, notion); 'confirm' leaves the building or destroys
// something (send_mail, remove_ward, remove_edge) — whether a kind actually
// pauses for a Confirm click is the ward's approvals policy (core.ts).

export type ToolKind = 'read' | 'write' | 'confirm';
export const AGENT_HELP_TOPICS = ['general', 'computer', 'browser', 'sandbox', 'wards', 'leylines', 'memory', 'delegation', 'all'] as const;

export interface ToolCtx {
  /** Turn-local discovery, absent in the sandbox and outside the model loop. */
  searchTools?: (args:ToolSearch) => Promise<unknown>;
  userId: number;
  ward: string;
  /** The conversation this call belongs to. Rides on the ctx, never a module
   *  global — turns for different users run concurrently. */
  conv: number;
  /** Agent wards whose sync ask_agent is waiting on this turn — see core.askAgent. */
  via?: string[];
  /** Set inside a child run: its agent_jobs id — its identity for messages, and the recursion stop. */
  task?: string;
  /** Set by runTask on the ctx a backgroundable tool runs with: this call's own job id. */
  job?: string;
  /** Trusted, never a tool argument: the child continues THIS conversation (Ctrl+B),
   *  copying it once `forkReady` resolves (the interrupted turn has settled). */
  fork?: boolean;
  forkReady?: Promise<void>;
  /** Set by runTask on a spawn: the child calls it once its arguments and route
   *  have validated — only then does the caller get a task id instead of the error. */
  detach?: () => void;
  signal?: AbortSignal;
  progress?: (text: string) => void;
}

export interface ToolDef {
  /** A loaded external definition's immutable identity, including trust and endpoint. */
  revision?:string;
  kind: ToolKind;
  backgroundable?: boolean;
  cancellable?: boolean;
  /** Starts an independent run (a child): always detached, capped, refused inside a child. */
  spawn?: boolean;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, any>, ctx: ToolCtx) => unknown | Promise<unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const bool = (description: string) => ({ type: 'boolean', description });

// ---------------------------------------------------------------- helpers

/** What read_note / write_note were given: `note` is an exact document id, `ward` a note ward (legacy — the document it shows). */
function noteRef(userId: number, a: Record<string, unknown>): { id: string; ward: WardInstance | null } {
  if (typeof a.note === 'string' && a.note) {
    const n = resolveNote(userId, a.note, true);
    if (!n) throw new Error(`no note "${a.note}" — search_notes / list_notebooks give note ids`);
    return n;
  }
  const n = resolveNote(userId, a.ward);
  if (!n) throw new Error(`no note ward "${a.ward}" — call get_layout for ward ids, or pass a note id as \`note\``);
  return n;
}

/** An inbox row as the model reads it. */
const receipt = (m: InboxRow) => ({
  id: m.id,
  to: m.ward,
  from: m.sender,
  mode: m.mode,
  status: m.status,
  text: m.text.length > 300 ? `${m.text.slice(0, 300)}…` : m.text,
  ...(m.reply_to !== null ? { reply_to: m.reply_to } : {}),
  ...(m.result ? { result: m.result } : {}),
  sent_at: m.created_at,
  ...(m.finished_at ? { finished_at: m.finished_at } : {}),
});

const newWardId = () => 'w' + randomBytes(3).toString('hex');

/** The chat wards' op vocabulary, once per process — the tool descriptions
 *  must stay byte-identical across turns (prompt caching). */
const CHAT_OPS = opsDoc();

/** The chat ward a tool means: the named one, or the only one there is. */
function chatWard(userId: number, ward: unknown): WardInstance {
  const all = getDashboard(userId).filter((w) => isCommsType(w.type));
  if (typeof ward === 'string' && ward) {
    const w = all.find((x) => x.i === ward);
    if (!w) throw new Error(`no chat ward "${ward}" — call get_layout for the real ids`);
    return w;
  }
  if (all.length === 1) return all[0]!;
  if (!all.length) throw new Error('no chat ward on the layout — add a Discord (or other chat) ward first');
  throw new Error(`several chat wards — say which (ward id): ${all.map((w) => `${w.i} (${w.type})`).join(', ')}`);
}

/** Compact layout view — enough to reference wards without a second call. */
const layoutView = (userId: number) =>
  getDashboard(userId).map((w) => ({
    ward: w.i,
    type: w.type,
    size: w.size,
    title: wardTitle(w),
    hidden: !!w.hidden,
    ...(w.in ? { group: w.in } : {}),
    // Absent = the first page; a nested ward's page is its group's.
    page: w.page ?? getPages(userId)[0]!.id,
    config: w.config ?? {},
  }));

/** A `page` argument: absent is fine, otherwise it must name a page. */
function pageArg(userId: number, page: unknown): string | undefined | Error {
  if (page === undefined || page === null || page === '') return undefined;
  if (typeof page !== 'string' || !getPages(userId).some((p) => p.id === page)) return new Error(`no page "${String(page)}" — call list_pages for the real ids`);
  return page;
}

/** Mutate-validate-save-prune-broadcast, the one path every layout write takes.
 *  fn returns the new layout or an error string. */
function mutateLayout(userId: number, fn: (layout: WardInstance[]) => WardInstance[] | string): unknown {
  const current = getDashboard(userId);
  const next = fn(JSON.parse(JSON.stringify(current)) as WardInstance[]);
  if (typeof next === 'string') throw new Error(next);
  const valid = validateLayout(next, getPages(userId));
  if (!valid) {
    throw new Error(
      `resulting layout is invalid — check the ward type exists, sizes are "WxH" with W 1-${MAX_W} and H 1-${MAX_H}, ` +
        'non-multi types appear once, and per-type config is complete'
    );
  }
  saveDashboard(userId, valid);
  pruneUserLogic(userId);
  // The full layout, not a diff: events can arrive out of order and the last
  // one still lands the browser on the right grid.
  broadcast(userId, 'layout', { layout: valid, pages: getPages(userId) });
  return { ok: true, layout: layoutView(userId) };
}

/** The page-list twin of mutateLayout: pages and layout change together
 *  (a deleted page's wards land on the first page), one save, one broadcast. */
function mutatePages(userId: number, fn: (pages: PageDef[], layout: WardInstance[]) => string | void): unknown {
  const pages = JSON.parse(JSON.stringify(getPages(userId))) as PageDef[];
  const layout = JSON.parse(JSON.stringify(getDashboard(userId))) as WardInstance[];
  const err = fn(pages, layout);
  if (typeof err === 'string') throw new Error(err);
  const validPages = validatePages(pages);
  if (!validPages) throw new Error(`pages rejected — ids [a-z0-9-]{1,32} and unique, titles 1–40 chars, at most ${MAX_PAGES} pages`);
  const valid = validateLayout(layout, validPages);
  if (!valid) throw new Error('resulting layout is invalid');
  saveDashboard(userId, valid, validPages);
  broadcast(userId, 'layout', { layout: valid, pages: validPages });
  return { ok: true, pages: validPages };
}

// ---------------------------------------------------------------- browser


function isAdminUser(userId: number): boolean {
  const row = getDb().prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role?: string } | undefined;
  return row?.role === 'admin';
}

/** Validate-strict-save, the one path every graph write takes. */
function mutateGraph(userId: number, fn: (graph: LogicGraph) => LogicGraph | string): unknown {
  const next = fn(JSON.parse(JSON.stringify(getGraph(userId))) as LogicGraph);
  if (typeof next === 'string') throw new Error(next);
  // Say WHY. A generic rejection is unactionable: the model can only retry
  // blind, which is exactly how one over-long notify.flash text burned nine
  // tool calls in prod before the agent gave up.
  const why: string[] = [];
  const valid = validateGraph(next, getDashboard(userId), { isAdmin: isAdminUser(userId), why });
  if (!valid) {
    throw new Error(
      why.length
        ? `graph rejected — ${why[0]}`
        : 'graph rejected — an edge references a missing/wrong-type ward, an unknown trigger/condition/action, or bad params. Check against the trigger/action spec in your instructions.'
    );
  }
  saveGraph(userId, valid);
  return { ok: true, edges: valid.edges };
}

const findWard = (userId: number, ward: string, type?: string): WardInstance => {
  const w = getDashboard(userId).find((x) => x.i === ward && (!type || x.type === type));
  if (!w) throw new Error(`no ${type ?? ''} ward "${ward}" in the saved layout — call get_layout for the real ids`);
  return w;
};

const checklistDbOf = async (userId: number, ward: string): Promise<string> => {
  const db = await taskWardSource(userId, ward);
  if (!db) throw new Error(`no task ward "${ward}" with a database configured — call get_layout for the real ids`);
  return db;
};

const ownedFile = (userId: number, id: unknown) => {
  const f = getAttachment(userId, Number(id));
  if (!f) throw new Error(`no attachment with file_id ${id}`);
  return f;
};

// ---------------------------------------------------------------- registry

/** remember / save_skill: write one document, repaint its ward. */
const saveDoc = (kind: StoreKind, a: Record<string, any>, ctx: ToolCtx) => {
  const saved = writeDoc(ctx.userId, kind, String(a.name ?? ''), String(a.description ?? ''), String(a.body ?? ''));
  broadcast(ctx.userId, 'refresh', { type: kind });
  return { ...saved, path: docPath(kind, saved.name) };
};
/** forget / delete_skill. */
const dropDoc = (kind: StoreKind, a: Record<string, any>, ctx: ToolCtx) => {
  if (!deleteDoc(ctx.userId, kind, String(a.name ?? ''))) throw new Error(`no ${kind} named "${a.name}" — the index in your instructions has the real names`);
  broadcast(ctx.userId, 'refresh', { type: kind });
  return { deleted: a.name };
};
const docName = str('a slug, [a-z0-9-] ≤48 chars, e.g. "user-timezone" or "deploy-check"');

export const TOOLS: Record<string, ToolDef> = {
  monitor: {
    kind:'write',description:'Create, update, pause, resume, delete, or inspect a persistent background monitor in this conversation. Observation only: never authorizes replies or external actions. Sources: terminal, file, browser, agent, note, notebook, http, comms, event (Leylines). Initial observations are baselines; matching events wake this conversation or arrive between rounds. Clearing/archiving deletes monitors. HTTP defaults to 30 seconds. Watching does not occupy running-task slots. Exact filters run before an optional semantic gate; unavailable semantic inference visibly blocks delivery.',
    parameters:obj({ action:{ type:'string',enum:['create','update','pause','resume','delete','status'] },id:str('Monitor id for an existing monitor'),name:str('Short description'),
      source:{ type:'object',properties:{ type:{ type:'string',enum:['terminal','file','browser','agent','note','notebook','http','comms','event'] },target:str('Terminal, ward, note, notebook or child task id'),project:str('Owned local project id for files'),path:str('Project-relative file or scoped folder'),url:str('Read-only HTTP(S) probe'),selector:str('Optional browser CSS selector'),event:str('Leyline trigger type'),intervalSeconds:num('5–86400 seconds, default 30; connector minimums still apply'),headers:{ type:'array',items:{ type:'string' } },fields:{ type:'array',items:{ type:'string' },description:'Selected JSON field paths' } },required:['type'],additionalProperties:false },
      filter:{ type:'object',description:'Exact filter: {all:[filters]}, {any:[filters]}, {not:filter}, or {field,op,value}; op eq, contains, glob (* and ?), gt, gte, lt, lte, changed. Maximum depth 8 and 64 nodes. Source fields include path, sender, channel, eventType, status, exitCode, text, and json fields.',additionalProperties:true },
      semantic:{ type:['object','null'],properties:{ field:str('Text field to compare'),query:str('Meaning to match'),threshold:num('Minimum cosine similarity, -1 to 1') },required:['field','query','threshold'],additionalProperties:false } },['action']),
    run:(a,ctx) => manageMonitor(ctx,a),
  },
  search_tools: {
    kind:'read', description:'Search available capabilities or exact tool names. Loads up to five callable schemas for the next round (maximum ten). Search before calling tools outside the bootstrap set. Discovery grants no authority.',
    parameters:obj({ query:str('Capability to find, or exact tool name'), filters:{ type:'object',properties:{ kind:{ type:'string',enum:['read','write','confirm'] },server:str('MCP server name') },additionalProperties:false },limit:num('Default 5; maximum 10') },['query']),
    run:(a,ctx) => { if (!ctx.searchTools) throw Error('Tool discovery requires an agent turn.'); return ctx.searchTools(a as ToolSearch); },
  },
  search_knowledge: {
    kind:'read',description:'Search existing memories, skills, notes, notebooks, conversation transcripts and extracted attachments. Returns bounded excerpts, page/line locators and authoritative source identities. Explicit keyword fallback when embeddings are unavailable. Project files are excluded.',
    parameters:obj({ query:str('Question, keyword or exact source name'),scope:{ type:'array',items:{ type:'string',enum:['memory','skill','standing','note','notebook','conversation','attachment'] } },limit:num('Default 5; maximum 10') },['query']),
    run:(a,ctx) => searchKnowledge(ctx.userId,a.query,a.scope,a.limit ?? 5),
  },
  read_knowledge: {
    kind:'read',description:'Read a current authoritative knowledge source using its source identity and character offset. Deleted, trashed and inaccessible sources are excluded.',
    parameters:obj({ source:str('Source identity, for example skill:deploy or note:abc'),offset:num('Character offset returned by an earlier read; default 0') },['source']),
    run:(a,ctx) => readKnowledge(ctx.userId,a.source,a.offset ?? 0),
  },
  agent_help: {
    kind:'read',description:'Read Rime operating guidance by topic: general, computer, browser, sandbox/documents, wards, leylines, memory/skills, or delegation. Defaults to general; use all only for the full reference. Continue the same topic with next as offset when needed.',
    parameters:obj({ topic:{ type:'string',enum:AGENT_HELP_TOPICS,description:'Help topic; default general. all returns the full reference.' },offset:num('Character offset within this topic; default 0') }),
    run:async (a,ctx) => {
      const { effectiveConfig,detailedInstructions } = await import('./core.ts');
      const config = effectiveConfig(ctx); if (!config) throw Error('Agent ward unavailable.');
      const topic = a.topic ?? 'general';
      if (!AGENT_HELP_TOPICS.includes(topic)) throw Error(`Unknown help topic; use ${AGENT_HELP_TOPICS.join(', ')}.`);
      const offset = a.offset ?? 0; if (!Number.isSafeInteger(offset) || offset < 0) throw Error('offset must be non-negative.');
      const child = ctx.task ? childJob(ctx.userId,ctx.task) : null;
      if (ctx.task && (!child || child.ward !== ctx.ward)) throw Error('Child run unavailable.');
      const text = detailedInstructions(config,ctx.userId,ctx.ward,child ? { task:child.id,reason:child.reason } : undefined,ctx.conv,topic);
      return { topic,topics:AGENT_HELP_TOPICS,text:text.slice(offset,offset+8000),next:offset+8000 < text.length ? offset+8000 : null };
    },
  },
  current_time: {
    kind:'read',description:'Read the current UTC time and this runtime’s timezone. The runtime timezone is not necessarily the user’s timezone.',
    parameters:obj({}),
    run:() => ({ utc:new Date().toISOString(),runtimeTimezone:Intl.DateTimeFormat().resolvedOptions().timeZone }),
  },
  ask_user_question: {
    kind: 'read',
    description: 'Ask the user a concise question inline in this conversation. input: single for one choice, multiple for multiple selections, or text for free text. Provide 2–12 options for choice questions. wait defaults true: pause this conversation until the user answers, without assuming any choice. wait:false lets you continue independent work and delivers the answer later. Ask only one unanswered question at a time. Child runs should ask their parent instead.',
    parameters: obj({ question: str('The complete question'), input: { type: 'string', enum: ['single', 'multiple', 'text'] },
      options: { type: 'array', items: { type: 'string' }, description: 'Distinct choices for single/multiple; omit for text' },
      wait: { type: 'boolean', default: true, description: 'Wait for user input before continuing (default true)' } }, ['question']),
    run: postUserQuestion,
  },
  ...DEV_TOOLS,
  // ------------------------------------------------------------------ reads
  get_layout: {
    kind: 'read',
    description: 'The saved dashboard layout: every ward with its id, type, size, title, page and config, plus the page list.',
    parameters: obj({}),
    run: (_a, ctx) => ({ layout: layoutView(ctx.userId), pages: getPages(ctx.userId) }),
  },
  list_pages: {
    kind: 'read',
    description: 'The dashboard\'s pages (tabs), in order — the first is the default. Every ward on every page keeps running; a page is only what the browser shows.',
    parameters: obj({}),
    run: (_a, ctx) => ({ pages: getPages(ctx.userId) }),
  },
  get_logic_graph: {
    kind: 'read',
    description: 'The leylines — the automation graph, every logic edge — plus each edge\'s last run result.',
    parameters: obj({}),
    run: (_a, ctx) => ({ graph: getGraph(ctx.userId), runs: getRuns(ctx.userId) }),
  },
  get_theme: {
    kind: 'read',
    description: 'The user\'s current theme configuration.',
    parameters: obj({}),
    run: (_a, ctx) => {
      const row = getDb().prepare('SELECT theme FROM users WHERE id = ?').get(ctx.userId) as { theme: string | null } | undefined;
      return { theme: parseTheme(row?.theme) ?? normalizeTheme({}) };
    },
  },
  service_status: {
    kind: 'read',
    description: 'Live status of every monitored service plus host CPU/memory/disk. Optionally read one service history or recent incidents.',
    parameters: obj({ service: str('service id for history'), hours: num('history lookback, 1–168 hours'), incidents: bool('include recent incident spans instead of current status') }),
    run: async (a) => {
      if (a.incidents === true) return { hours: 24, incidents: await recentIncidents() };
      if (typeof a.service === 'string' && a.service) return { service: a.service, rows: getHistory(a.service, Number(a.hours) || 24) };
      const snap = getSnapshot();
      if (!snap) throw new Error('no status snapshot yet — the engine just booted, try again shortly');
      return snap;
    },
  },
  get_weather: {
    kind: 'read',
    description: 'Current conditions and the short forecast for a weather ward, or the first configured place if no ward is specified.',
    parameters: obj({ ward: str('optional weather ward id') }),
    run: async (a, ctx) => {
      const f = await forecastFor(ctx.userId, typeof a.ward === 'string' ? a.ward : undefined);
      if (!f) throw new Error('weather unavailable — no weather ward has a place');
      return f;
    },
  },
  list_mail: {
    kind: 'read',
    description:
      'Latest inbox messages from one of the user\'s mailboxes: "google" (Gmail), "microsoft" (Outlook), "zoho" (Zoho Mail) or "mailbox" (their own IMAP/POP server).',
    parameters: obj(
      { account: { type: 'string', enum: [...MAIL_ACCOUNTS] }, limit: num('max messages, default 8, cap 20') },
      ['account']
    ),
    run: async (a, ctx) => {
      const limit = Math.min(Math.max(Math.round(Number(a.limit) || 8), 1), 20);
      return { messages: await mailInbox(ctx.userId, asAccount(a.account), limit) };
    },
  },
  list_calendar: {
    kind: 'read',
    description: 'Upcoming events from Google Calendar, Outlook, iCloud and a Notion calendar database, merged.',
    parameters: obj({ days: num('how many days ahead, default 5, cap 14') }),
    run: async (a, ctx) => {
      const days = Math.min(Math.max(Math.round(Number(a.days) || 5), 1), 14);
      // agenda() tolerates one dead source and throws only when none is set up or every one failed.
      try {
        return { events: await agenda(ctx.userId, days) };
      } catch (err) {
        return { events: [], note: err instanceof Error ? err.message : 'no calendar linked' };
      }
    },
  },
  read_note: {
    kind: 'read',
    description: 'The text of a note: a notepad ward (type "note", by ward id) or a notebook note (by note id — list_notebooks / search_notes give them; pass it as `note`, never as `ward`). The user\'s own writing, plus whatever their handwriting was transcribed into; ink that was never transcribed is not text.',
    parameters: obj({ ward: str('a note ward id (get_layout) — the document that ward shows'), note: str('an exact note id (list_notebooks / search_notes)') }),
    run: (a, ctx) => {
      const n = noteRef(ctx.userId, a);
      const doc = readNote(ctx.userId, n.ward ?? n.id);
      return { id: doc.id, ward: n.ward?.i, title: n.ward ? wardTitle(n.ward) : doc.title, text: plainText(doc.html), updated: doc.updated, rev: doc.rev, etag: doc.etag };
    },
  },
  write_note: {
    kind: 'write',
    description: 'Write into a note (a notepad ward id or a note id): append paragraphs to it, or replace the whole document. Plain text; a blank line separates paragraphs. The ink layer is untouched. Pass the rev and etag read_note returned to refuse stale writes, including after sync.',
    parameters: obj({ ward: str('a note ward id — the document that ward shows'), note: str('an exact note id'), text: str('what to write'), mode: { type: 'string', enum: ['append', 'replace'], description: 'default append' }, rev: num('the rev from read_note — the write fails if the note changed since'), etag: str('the etag from read_note — detects conflicting changes across runtimes') }, ['text']),
    run: (a, ctx) => {
      const n = noteRef(ctx.userId, a);
      const text = String(a.text ?? '').trim();
      if (!text) throw new Error('nothing to write');
      const target = n.ward ?? n.id;
      const html = a.mode === 'replace' ? textToHtml(text) : readNote(ctx.userId, target).html + textToHtml(text);
      const { updated, rev, etag } = writeNote(ctx.userId, target, { html, rev: typeof a.rev === 'number' ? a.rev : undefined, etag: typeof a.etag === 'string' ? a.etag : undefined });
      broadcast(ctx.userId, 'note', { ward: n.ward?.i, note: n.id }); // the open ward reloads its document
      return { ok: true, id: n.id, ward: n.ward?.i, updated, rev, etag };
    },
  },
  list_notebooks: {
    kind: 'read',
    description: 'The user\'s notebooks (Notebook wards organize note documents into sections, tags and pins). With `notebook`, that notebook\'s index: its sections and every live note\'s id + title (no bodies — read_note one).',
    parameters: obj({ notebook: str('a notebook id for its index') }),
    run: (a, ctx) => {
      if (typeof a.notebook === 'string' && a.notebook) {
        const book = getNotebook(ctx.userId, a.notebook);
        if (!book) throw new Error(`no notebook "${a.notebook}"`);
        const templates = listNotes(ctx.userId, { notebook: book.id, template: true, limit: 50 }).notes.map((n) => ({ id: n.id, title: n.title || 'Untitled template' }));
        return { notebook: { id: book.id, title: book.title, sections: book.sections, properties: book.props, views: book.views.map((v) => ({ id: v.id, title: v.title, layout: v.layout })), templates }, index: notebookIndex(ctx.userId, book.id) };
      }
      return { notebooks: listNotebooks(ctx.userId).map((b) => ({ id: b.id, title: b.title, notes: b.count, sections: b.sections })) };
    },
  },
  search_notes: {
    kind: 'read',
    description: 'Find notes: full-text over titles, text and tags (transcribed handwriting included, raw ink never), or list by notebook / tag / status. Metadata and a matching snippet per hit, never bodies; page with offset. Omit notebook to search every note.',
    parameters: obj({
      q: str('words to find (all must match, prefixes allowed)'),
      notebook: str('limit to one notebook; "none" = standalone notes'),
      tag: str('limit to one tag'),
      status: { type: 'string', enum: ['active', 'archived', 'trash'], description: 'default active' },
      templates: bool('true = list the notebook\'s templates instead of its notes'),
      limit: num('per page, default 10, cap 20'),
      offset: num('page start, default 0'),
    }),
    run: (a, ctx) => {
      const page = listNotes(ctx.userId, {
        q: typeof a.q === 'string' ? a.q : undefined,
        notebook: a.notebook === 'none' ? null : typeof a.notebook === 'string' && a.notebook ? a.notebook : undefined,
        tag: typeof a.tag === 'string' && a.tag ? a.tag : undefined,
        status: a.status,
        template: a.templates === true || undefined,
        limit: Math.min(Math.max(Math.round(Number(a.limit) || 10), 1), 20),
        offset: Math.max(Math.round(Number(a.offset) || 0), 0),
      });
      return {
        total: page.total, next: page.next,
        notes: page.notes.map((n) => ({ id: n.id, title: n.title || n.excerpt.slice(0, 60) || 'Untitled', notebook: n.notebook, section: n.section, tags: n.tags, pinned: n.pinned, updated: n.updated, archived: !!n.archived, trashed: !!n.trashed, ...(Object.keys(n.props).length ? { properties: n.props } : {}), ...(n.template ? { template: true } : {}), snippet: n.snippet?.replace(/\u0001/g, '«').replace(/\u0002/g, '»') })),
        note: page.next !== undefined ? 'More pages: pass offset=next.' : undefined,
      };
    },
  },
  create_note: {
    kind: 'write',
    description: 'A new note document — in a notebook (optionally in one of its sections), or standalone when no notebook is given. Plain text body; a blank line separates paragraphs. `from` = a template note id of that notebook (list_notebooks lists them): its text, tags and properties seed the note. `properties` = values by property id from the notebook\'s schema.',
    parameters: obj({ notebook: str('the notebook id (list_notebooks)'), section: str('a section id of that notebook'), title: str('the title'), text: str('the body, plain text'), tags: { type: 'array', items: { type: 'string' }, description: 'tags' }, from: str('a template note id'), properties: { type: 'object', description: 'property values by property id', additionalProperties: true } }),
    run: (a, ctx) => {
      const meta = createNote(ctx.userId, {
        notebook: typeof a.notebook === 'string' && a.notebook ? a.notebook : undefined,
        section: typeof a.section === 'string' && a.section ? a.section : undefined,
        title: typeof a.title === 'string' ? a.title : '',
        html: typeof a.text === 'string' && a.text.trim() ? textToHtml(a.text.trim()) : undefined,
        tags: Array.isArray(a.tags) ? a.tags : undefined,
        from: typeof a.from === 'string' && a.from ? a.from : undefined,
        props: a.properties && typeof a.properties === 'object' ? a.properties : undefined,
      });
      if (meta.notebook) broadcast(ctx.userId, 'notebook', { notebook: meta.notebook });
      return { ok: true, note: meta };
    },
  },
  update_note: {
    kind: 'write',
    description: 'A note\'s metadata, never its text (write_note does that): title, section, tags, pin, archive (a shelf) or trash (recoverable; trashed:false restores), property values, template flag, and which notebook is its home — notebook:"" unfiles it, another id moves it. Nothing here deletes the document (purge_note does, from the trash only).',
    parameters: obj({
      id: str('the note id'), title: str('new title'), section: str('a section id of its notebook, or "" for none'),
      tags: { type: 'array', items: { type: 'string' }, description: 'the full tag list' }, pinned: bool('pin it'),
      archived: bool('true = archive, false = unarchive'), trashed: bool('true = trash, false = restore'), notebook: str('its home notebook id; "" = standalone'),
      properties: { type: 'object', description: 'property values to merge, by property id of its notebook; "" clears one', additionalProperties: true }, template: bool('true = a template (New ▾ offers it; lists leave it out)'),
    }, ['id']),
    run: (a, ctx) => {
      // `id` is an exact note id (a ward alias is never followed). Materialize,
      // move/unfile and the metadata change are one transaction: a rejected tag
      // or section leaves the home notebook, section, order and text as they were.
      const n = resolveNote(ctx.userId, a.id, true);
      if (!n) throw new Error(`no note "${a.id}" — search_notes / list_notebooks give note ids`);
      const { before, meta } = getDb().transaction(() => {
        if (n.ward) writeNote(ctx.userId, n.ward, {});
        const before = getNoteMeta(ctx.userId, n.id)!.notebook;
        if (typeof a.notebook === 'string' && a.notebook !== (before ?? '')) {
          if (a.notebook) linkNote(ctx.userId, a.notebook, n.id, { move: true });
          else unlinkNote(ctx.userId, n.id);
        }
        const patch: Record<string, unknown> = {};
        for (const k of ['title', 'section', 'tags', 'pinned', 'archived', 'trashed', 'template'] as const) if (a[k] !== undefined) patch[k] = a[k];
        if (a.properties !== undefined) patch.props = a.properties;
        return { before, meta: updateNoteMeta(ctx.userId, n.id, patch) };
      })();
      for (const book of new Set([before, meta.notebook])) if (book) broadcast(ctx.userId, 'notebook', { notebook: book });
      broadcast(ctx.userId, 'note', { note: n.id, meta: true });
      return { ok: true, note: meta };
    },
  },
  ask_notebook: {
    kind: 'read',
    description: 'Answer a question from the notes of one notebook: the best full-text matches (up to 8, bodies trimmed) go to the notebook ward\'s model in one call, which answers from them and names its sources. Counts against the 60/h one-shot window. For a specific note\'s text use read_note.',
    parameters: obj({ notebook: str('the notebook id (list_notebooks)'), question: str('the question') }, ['notebook', 'question']),
    run: async (a, ctx) => {
      const w = notebookWardsOf(ctx.userId, String(a.notebook ?? ''))[0];
      if (!w) throw new Error(`no Notebook ward shows "${String(a.notebook)}" — list_notebooks gives ids`);
      return askNotebook(ctx.userId, w, String(a.question ?? ''));
    },
  },
  note_backlinks: {
    kind: 'read',
    description: 'The notes whose text links to a note ([[Title]] links the editor stores as note links), with their home notebooks.',
    parameters: obj({ note: str('an exact note id') }, ['note']),
    run: (a, ctx) => {
      const n = resolveNote(ctx.userId, a.note, true);
      if (!n) throw new Error(`no note "${String(a.note)}"`);
      return { note: n.id, backlinks: noteBacklinks(ctx.userId, n.id) };
    },
  },
  purge_note: {
    kind: 'confirm',
    description: 'Delete a note for good — only a note that is already in the trash (update_note trashed:true first). Irreversible: the document, its ink, its index entry and its links are gone on every runtime it synced to.',
    parameters: obj({ id: str('the note id') }, ['id']),
    run: (a, ctx) => {
      const n = resolveNote(ctx.userId, a.id, true);
      if (!n) throw new Error(`no note "${String(a.id)}"`);
      const meta = getNoteMeta(ctx.userId, n.id);
      purgeNote(ctx.userId, n.id);
      if (meta?.notebook) broadcast(ctx.userId, 'notebook', { notebook: meta.notebook });
      broadcast(ctx.userId, 'note', { note: n.id, gone: true });
      return { ok: true, purged: n.id };
    },
  },
  // ---------------------------------------------------------------- memory + skills
  remember: {
    kind: 'write',
    description:
      'Save one durable fact to your memory as /work/memory/<name>.md — a new file, or a rewrite of the one with that name. The index of names + descriptions is in your instructions every turn; read a file back with bash (cat /work/memory/<name>.md). One fact per file; the description is what you will see when deciding whether to read it.',
    parameters: obj(
      {
        name: docName,
        description: str(`one line, ≤${DOC_DESC_MAX} chars: what the file holds, specific enough to know when to read it`),
        body: str(`the fact in full, ≤${STORES.memory.bodyMax} chars, markdown`),
      },
      ['name', 'description', 'body']
    ),
    run: (a, ctx) => saveDoc('memory', a, ctx),
  },
  forget: {
    kind: 'confirm',
    description: 'Delete one memory file for good (/work/memory/<name>.md). To change a fact, call remember with the same name instead.',
    parameters: obj({ name: str('the memory name, as listed in your instructions') }, ['name']),
    run: (a, ctx) => dropDoc('memory', a, ctx),
  },
  save_skill: {
    kind: 'write',
    description:
      'Save a procedure as /work/skills/<name>/SKILL.md — how to do a kind of task: the steps, a checklist, a format, the rules of a recurring job. A new skill, or a rewrite of the one with that name. The index of names + descriptions is in your instructions every turn; read one back with bash (cat /work/skills/<name>/SKILL.md) before following it.',
    parameters: obj(
      {
        name: docName,
        description: str(`one line, ≤${DOC_DESC_MAX} chars: WHEN to use it — the task it covers`),
        body: str(`the procedure, ≤${STORES.skill.bodyMax} chars, markdown`),
      },
      ['name', 'description', 'body']
    ),
    run: (a, ctx) => saveDoc('skill', a, ctx),
  },
  delete_skill: {
    kind: 'confirm',
    description: 'Delete a skill for good (its whole /work/skills/<name>/ folder). To change one, call save_skill with the same name instead.',
    parameters: obj({ name: str('the skill name, as listed in your instructions') }, ['name']),
    run: (a, ctx) => dropDoc('skill', a, ctx),
  },

  notion_tasks: {
    kind: 'read',
    description: 'Open tasks from the user\'s Notion tasks database.',
    parameters: obj({}),
    run: (_a, ctx) => notionTasks(ctx.userId),
  },
  notion_recent: {
    kind: 'read',
    description: 'Recently edited Notion pages.',
    parameters: obj({}),
    run: async (_a, ctx) => ({ pages: await notionRecent(ctx.userId) }),
  },
  notion_search: {
    kind: 'read',
    description: 'Search the user\'s Notion workspace.',
    parameters: obj({ query: str('search text') }, ['query']),
    run: async (a, ctx) => ({ results: await notionSearch(ctx.userId, String(a.query)) }),
  },
  list_checklist: {
    kind: 'read',
    description: 'Items on a task/checklist ward (a Notion database).',
    parameters: obj({ ward: str('the task or checklist ward id') }, ['ward']),
    run: async (a, ctx) => ({ items: await notionChecklist(ctx.userId, await checklistDbOf(ctx.userId, String(a.ward))) }),
  },
  notion_databases: {
    kind: 'read',
    description: 'Every Notion database the integration can see, each with the data sources (lists) inside it.',
    parameters: obj({}),
    run: async (_a, ctx) => ({ databases: await notionDatabases(ctx.userId) }),
  },
  notion_schema: {
    kind: 'read',
    description: 'The columns of one Notion list: name, type, and the options of any select/status/multi-select. Pass a database id OR a data source id.',
    parameters: obj({ id: str('a database id or data source id') }, ['id']),
    run: async (a, ctx) => {
      const source = await notionSourceId(ctx.userId, String(a.id));
      const schema = await notionSourceSchema(ctx.userId, source);
      return { ...schema, filterOps: Object.fromEntries(schema.props.map((p) => [p.name, opsFor(p.type)])) };
    },
  },
  notion_lists: {
    kind: 'read',
    description: 'The data sources (lists) inside one Notion database — a database can hold several, each with its own columns.',
    parameters: obj({ database_id: str('the database id') }, ['database_id']),
    run: async (a, ctx) => ({ lists: await notionDataSources(ctx.userId, String(a.database_id)) }),
  },
  notion_query: {
    kind: 'read',
    description:
      'Rows of a Notion list, optionally filtered and sorted. Filters are [{property, op, value}]; call notion_schema first for the column names and the ops each one accepts.',
    parameters: obj(
      {
        id: str('a database id or data source id'),
        filter: { type: 'array', description: 'conditions, ANDed', items: obj({ property: str('column name'), op: str('an op from notion_schema.filterOps'), value: str('the value to compare') }, ['property', 'op']) },
        sort: str('column name to sort by'),
        descending: bool('sort high-to-low'),
        limit: num('rows to return, 1-100 (default 50)'),
      },
      ['id']
    ),
    run: async (a, ctx) => {
      const source = await notionSourceId(ctx.userId, String(a.id));
      const schema = await notionSourceSchema(ctx.userId, source);
      const filter = buildFilter(schema.types, Array.isArray(a.filter) ? (a.filter as FilterSpec[]) : []);
      const sort = typeof a.sort === 'string' && schema.types[a.sort] ? a.sort : undefined;
      return {
        rows: await notionQuery(ctx.userId, source, {
          ...(filter ? { filter } : {}),
          ...(sort ? { sorts: [{ property: sort, direction: a.descending ? 'descending' : 'ascending' }] } : {}),
          max: Math.min(Math.max(Number(a.limit) || 50, 1), 100),
        }),
      };
    },
  },
  notion_page: {
    kind: 'read',
    description: 'One Notion page: its properties (flattened, with which are writable), and optionally its content blocks and comments.',
    parameters: obj({ page_id: str('the page id'), blocks: bool('include content blocks'), comments: bool('include comments') }, ['page_id']),
    run: async (a, ctx) => {
      const id = String(a.page_id);
      const [page, blocks, comments] = await Promise.all([
        notionPage(ctx.userId, id),
        a.blocks ? notionBlocks(ctx.userId, id) : Promise.resolve(undefined),
        a.comments ? notionComments(ctx.userId, id) : Promise.resolve(undefined),
      ]);
      return { ...page, blocks, comments };
    },
  },
  notion_set_props: {
    kind: 'write',
    description:
      'Set properties on a Notion page by column name. Values are coerced to the column type: text/number/checkbox as-is, date as {start,end} or "YYYY-MM-DD", select/status as the option name, multi-select as a name array, people/relation as an id array. Computed columns (formula, rollup, created_time…) come back in `skipped`.',
    parameters: obj({ page_id: str('the page id'), props: { type: 'object', description: 'column name → value', additionalProperties: true } }, ['page_id', 'props']),
    run: async (a, ctx) => {
      const props = (a.props ?? {}) as Record<string, unknown>;
      if (!Object.keys(props).length) throw new Error('no properties given');
      const { skipped } = await notionUpdateProps(ctx.userId, String(a.page_id), props);
      return { ok: true, written: Object.keys(props).filter((k) => !skipped.includes(k)), skipped };
    },
  },
  notion_create_page: {
    kind: 'write',
    description: 'Create a Notion page: a row in a list (pass list_id and props) or a child page (pass parent_page_id and title).',
    parameters: obj(
      {
        list_id: str('a database or data source id to add a row to'),
        parent_page_id: str('a page id to add a child page under'),
        title: str('the page title'),
        props: { type: 'object', description: 'column name → value, for a row', additionalProperties: true },
      },
      []
    ),
    run: async (a, ctx) => {
      if (a.list_id) {
        const source = await notionSourceId(ctx.userId, String(a.list_id));
        const schema = await notionSourceSchema(ctx.userId, source);
        const props = { ...((a.props ?? {}) as Record<string, unknown>) };
        // A title is mandatory in Notion; let the agent pass it either way.
        if (a.title) {
          const titleCol = schema.props.find((p) => p.type === 'title')?.name ?? 'Name';
          props[titleCol] ??= String(a.title);
        }
        if (!Object.keys(props).length) throw new Error('give a title or some props');
        return notionCreatePage(ctx.userId, { sourceId: source }, props);
      }
      if (!a.parent_page_id) throw new Error('give either list_id or parent_page_id');
      return notionCreatePage(ctx.userId, { pageId: String(a.parent_page_id) }, { title: String(a.title ?? 'Untitled') });
    },
  },
  notion_blocks: {
    kind: 'read',
    description: "A page's content blocks, flattened depth-first with a `depth` on each.",
    parameters: obj({ page_id: str('the page (or block) id') }, ['page_id']),
    run: async (a, ctx) => ({ blocks: await notionBlocks(ctx.userId, String(a.page_id)) }),
  },
  notion_add_blocks: {
    kind: 'write',
    description: `Append content blocks to a Notion page or block. Types: ${WRITABLE.join(', ')}. A bookmark/embed takes a url; a to_do takes checked; code takes language.`,
    parameters: obj(
      {
        parent_id: str('the page or block to append to'),
        blocks: {
          type: 'array',
          description: 'blocks to append, in order',
          items: obj({ type: str('block type'), text: str('the text'), checked: bool('to_do only'), language: str('code only'), url: str('bookmark/embed only') }, ['type']),
        },
        after: str('optional block id to insert after'),
      },
      ['parent_id', 'blocks']
    ),
    run: async (a, ctx) => ({
      blocks: await notionAppendBlocks(ctx.userId, String(a.parent_id), (a.blocks ?? []) as never[], a.after ? String(a.after) : undefined),
    }),
  },
  notion_edit_block: {
    kind: 'write',
    description: 'Rewrite one block in place (its id comes from notion_blocks). The type must stay the same.',
    parameters: obj({ block_id: str('the block id'), type: str('its existing type'), text: str('the new text'), checked: bool('to_do only'), language: str('code only'), url: str('bookmark/embed only') }, ['block_id', 'type']),
    run: async (a, ctx) => ({
      block: await notionUpdateBlock(ctx.userId, String(a.block_id), {
        type: String(a.type),
        text: String(a.text ?? ''),
        ...(typeof a.checked === 'boolean' ? { checked: a.checked } : {}),
        ...(a.language ? { language: String(a.language) } : {}),
        ...(a.url ? { url: String(a.url) } : {}),
      }),
    }),
  },
  notion_delete_block: {
    kind: 'confirm',
    description: 'Move one block to Notion trash (recoverable there).',
    parameters: obj({ block_id: str('the block id') }, ['block_id']),
    run: async (a, ctx) => {
      await notionDeleteBlock(ctx.userId, String(a.block_id));
      return { ok: true };
    },
  },
  notion_archive_page: {
    kind: 'confirm',
    description: 'Move a Notion page to trash, or restore it. Recoverable either way.',
    parameters: obj({ page_id: str('the page id'), restore: bool('true to bring it back') }, ['page_id']),
    run: async (a, ctx) => {
      await notionArchive(ctx.userId, String(a.page_id), a.restore !== true);
      return { ok: true, archived: a.restore !== true };
    },
  },
  notion_comments: {
    kind: 'read',
    description: 'Open comment threads on a Notion page.',
    parameters: obj({ page_id: str('the page id') }, ['page_id']),
    run: async (a, ctx) => ({ comments: await notionComments(ctx.userId, String(a.page_id)) }),
  },
  notion_add_comment: {
    kind: 'write',
    description: 'Comment on a Notion page, or reply into an existing discussion.',
    parameters: obj({ page_id: str('the page id'), discussion_id: str('reply into this thread instead'), text: str('the comment') }, ['text']),
    run: async (a, ctx) => {
      if (!a.page_id && !a.discussion_id) throw new Error('give page_id or discussion_id');
      await notionAddComment(
        ctx.userId,
        a.discussion_id ? { discussionId: String(a.discussion_id) } : { pageId: String(a.page_id) },
        String(a.text)
      );
      return { ok: true };
    },
  },
  notion_create_list: {
    kind: 'write',
    description: 'Create a Notion database under a page, or add another list (data source) to an existing database. Columns use Notion schema shape, e.g. {"Name":{"title":{}},"Status":{"status":{}}}.',
    parameters: obj(
      {
        parent_page_id: str('page to create a new database under'),
        database_id: str('existing database to add another list to'),
        title: str('name for the database or list'),
        columns: { type: 'object', description: 'Notion property schema; defaults to a single Name title column', additionalProperties: true },
      },
      ['title']
    ),
    run: async (a, ctx) => {
      const columns = (a.columns ?? { Name: { title: {} } }) as Record<string, unknown>;
      if (a.database_id) return notionCreateSource(ctx.userId, String(a.database_id), String(a.title), columns);
      if (!a.parent_page_id) throw new Error('give parent_page_id (new database) or database_id (extra list)');
      return notionCreateDatabase(ctx.userId, String(a.parent_page_id), String(a.title), columns);
    },
  },
  notion_edit_schema: {
    kind: 'write',
    description:
      'Rename a Notion list or change its columns. `columns` uses Notion schema shape: {"Priority":{"select":{"options":[{"name":"High"}]}}} adds or retypes, {"Old":{"name":"New"}} renames, {"Gone":null} deletes the column AND its data in every row.',
    parameters: obj({ list_id: str('the data source id'), title: str('new name for the list'), columns: { type: 'object', additionalProperties: true } }, ['list_id']),
    run: async (a, ctx) => {
      if (a.title === undefined && !a.columns) throw new Error('give title or columns');
      await notionUpdateSource(ctx.userId, String(a.list_id), {
        ...(a.title !== undefined ? { title: String(a.title) } : {}),
        ...(a.columns ? { properties: a.columns as Record<string, unknown> } : {}),
      });
      return { ok: true };
    },
  },
  notion_trash_list: {
    kind: 'confirm',
    description: 'Move a whole Notion list, or a whole database, to trash — or restore it. Takes every row with it. Recoverable in Notion.',
    parameters: obj({ list_id: str('a data source id'), database_id: str('a database id'), restore: bool('true to bring it back') }, []),
    run: async (a, ctx) => {
      const inTrash = a.restore !== true;
      if (a.list_id) await notionUpdateSource(ctx.userId, String(a.list_id), { inTrash });
      else if (a.database_id) await notionUpdateDatabase(ctx.userId, String(a.database_id), { inTrash });
      else throw new Error('give list_id or database_id');
      return { ok: true, inTrash };
    },
  },
  notion_people: {
    kind: 'read',
    description: 'People in the Notion workspace — their ids are what a `people` column takes.',
    parameters: obj({}),
    run: async (_a, ctx) => ({ people: await notionUsers(ctx.userId) }),
  },
  list_timers: {
    kind: 'read',
    description: 'State of every timer ward.',
    parameters: obj({}),
    run: (_a, ctx) => ({ timers: getTimers(ctx.userId) }),
  },
  list_packets: {
    kind: 'read',
    description: 'Packets on a flow ward.',
    parameters: obj({ ward: str('the flow ward id') }, ['ward']),
    run: (a, ctx) => {
      findWard(ctx.userId, String(a.ward), 'flow');
      return { packets: listPackets(ctx.userId, String(a.ward)) };
    },
  },
  list_wakes: {
    kind: 'read',
    description: 'Your scheduled wakes (unattended future runs of yourself).',
    parameters: obj({}),
    run: (_a, ctx) => ({ wakes: listWakes(ctx.userId) }),
  },
  list_attachments: {
    kind: 'read',
    description: 'Files attached to this conversation.',
    parameters: obj({}),
    run: (_a, ctx) => ({
      files: listAttachments(ctx.userId, ctx.conv).map((f) => ({ file_id: f.id, name: f.name, mime: f.mime, pages: f.pages })),
    }),
  },
  read_document: {
    kind: 'read',
    description: 'Read a page range of an attached document (whole documents are stored; excerpts inline are only the beginning).',
    parameters: obj({ file_id: num('attachment id'), from_page: num('first page, default 1'), to_page: num('last page') }, ['file_id']),
    run: (a, ctx) => readPages(ownedFile(ctx.userId, a.file_id), Number(a.from_page) || 1, a.to_page ? Number(a.to_page) : undefined),
  },
  search_document: {
    kind: 'read',
    description: 'Search an attached document for lines matching a query.',
    parameters: obj({ file_id: num('attachment id'), query: str('text to find') }, ['file_id', 'query']),
    run: (a, ctx) => ({ hits: searchAttachment(ownedFile(ctx.userId, a.file_id), String(a.query)) }),
  },
  render_document_page: {
    kind: 'read',
    description: 'See one PDF page as an image, including scanned documents, diagrams and tables. The rendered page is sent to your vision input. Use read_document/search_document for searchable text and this tool when layout or image-only content matters.',
    parameters: obj({ file_id: num('PDF attachment ID'), page: num('page number, starting at 1') }, ['file_id', 'page']),
    run: async (a, ctx) => {
      const file = ownedFile(ctx.userId, a.file_id);
      if (file.mime !== 'application/pdf') throw Error('This tool renders PDF pages only.');
      const rendered = await renderPdfPage(fs.readFileSync(attachmentPath(file.sha256)), Number(a.page));
      const image = await storeAttachment({ userId: ctx.userId, conversationId: ctx.conv, name: `${file.name} — page ${a.page}.png`,
        mime: 'image/png', bytes: rendered.bytes });
      return { file_id: image.id, source_file_id: file.id, page: Number(a.page), pages: rendered.pages, image_sha256: image.sha256 };
    },
  },
  web_search: {
    kind: 'read',
    description: 'Search the web (Brave keyword + Exa semantic, merged). Needs a search key under Account → Agent.',
    parameters: obj({ query: str('what to search for'), count: num('max results, default 5') }, ['query']),
    run: async (a, ctx) => ({ hits: await webSearch(ctx.userId, String(a.query), Math.min(Number(a.count) || 5, 10)) }),
  },
  web_fetch: {
    kind: 'read',
    description: 'Fetch one web page as markdown (through the sandbox; needs the network toggle under Account → Agent).',
    parameters: obj({ url: str('the http(s) URL to read') }, ['url']),
    run: async (a, ctx) => {
      if (!shellNetworkEnabled(ctx.userId)) throw new Error('sandbox network is off — the user can enable it under Account → Agent');
      const url = String(a.url).replace(/'/g, '%27'); // single-quoted below, so the only escape char is quoted away
      const res = await runShell(ctx.userId, `curl -sL '${url}' | html-to-markdown`);
      if (res.exitCode !== 0) throw new Error(res.stderr || 'fetch failed');
      return { markdown: res.stdout, truncated: res.truncated };
    },
  },
  browser_snapshot: {
    kind: 'read',
    description:
      'What is on a browser ward\'s current page. mode "tree" (default): the accessibility tree as YAML — interactive elements carry [ref=eN] handles for browser_act. mode "text": the page\'s visible text. Browser wards are real Chromium sessions the user also watches and drives live; logins they completed there are yours to use.',
    parameters: obj({
      ward: str('the browser ward id — optional when there is exactly one'),
      mode: str('"tree" (default) or "text"'),
      depth: num('tree only: limit the depth — big pages get cut at the output cap'),
    }),
    run: async (a, ctx) => browserCall(ctx.userId, browserId(ctx.userId, a.ward), 'snapshot', a, ctx.signal),
  },
  bash: {
    kind: 'write',
    backgroundable: true,
    cancellable: true,
    description:
      'Run one command line in your sandbox (a bash interpreter over a virtual FS — /history holds your past conversations, /docs the text of every attachment, /work is your scratch space; rg, sed, awk, sqlite3, pdftotext, js-exec are available). js-exec runs JavaScript (QuickJS): `js-exec file.js` or `js-exec -c "…"`; inside a script `await tools.<name>({…})` calls any of your READ-ONLY tools. It cannot touch the dashboard DB or the host.',
    parameters: obj({ command: str(`the command line, e.g. rg -n "invoice" /docs`) }, ['command']),
    run: async (a, ctx) => {
      const res = await runShell(ctx.userId, String(a.command), (path, argsJson) => invokeReadTool(path, argsJson, ctx), ctx.signal);
      return { exit_code: res.exitCode, stdout: res.stdout, stderr: res.stderr.slice(0, 500), truncated: res.truncated };
    },
  },

  // ---------------------------------------------------------------- browser
  browser_open: {
    kind: 'write',
    description: 'Navigate a browser ward to a URL and wait for it to load. Then browser_snapshot to see it. The user sees the same page move on their ward.',
    parameters: obj({ url: str('the http(s) URL'), ward: str('the browser ward id — optional when there is exactly one') }, ['url']),
    run: async (a, ctx) => browserCall(ctx.userId, browserId(ctx.userId, a.ward), 'open', a, ctx.signal),
  },
  browser_act: {
    kind: 'write',
    description:
      'Act on a browser ward\'s page. action: click · fill (text into ref) · press (a key like Enter — into ref, or the page when no ref) · select (option value or label on a <select> ref) · hover · scroll (dy px, positive = down) · back · forward. ref = a [ref=eN] handle from the LAST browser_snapshot; refs go stale after anything changes, so snapshot again before the next act.',
    parameters: obj(
      {
        action: str('click | fill | press | select | hover | scroll | back | forward'),
        ref: str('the [ref=eN] handle to act on'),
        text: str('fill: the text to type (replaces the field\'s content)'),
        key: str('press: the key, e.g. Enter, Tab, ArrowDown, Control+a'),
        value: str('select: the option value or label'),
        dy: num('scroll: pixels, positive = down (default 600)'),
        ward: str('the browser ward id — optional when there is exactly one'),
      },
      ['action']
    ),
    run: async (a, ctx) => browserCall(ctx.userId, browserId(ctx.userId, a.ward), 'act', a, ctx.signal),
  },
  browser_downloads: {
    kind: 'read',
    description: 'List files downloaded in a browser ward, including downloads started by the user. Ready downloads have an id; use browser_download with that id to inspect the file. Failed and in-progress downloads have explicit status.',
    parameters: obj({ ward: str('browser ward ID, optional when there is exactly one'), offset: num('pagination offset; use next from the previous result') }),
    run: async (a, ctx) => browserCall(ctx.userId, browserId(ctx.userId, a.ward), 'downloads', a, ctx.signal),
  },
  browser_download: {
    kind: 'write',
    description: 'Import a ready browser download into this conversation for inspection (max 25 MB). Supply id from browser_downloads, or a direct file URL to fetch through the authenticated browser (including inline PDFs). A normal web page is not a downloaded file; use its download link through browser_act. Returns file_id for read_document/search_document; scanned PDFs and unsupported formats are reported explicitly.',
    parameters: obj({ ward: str('browser ward ID'), id: str('download id from browser_downloads'), url: str('direct http(s) download URL, only when id is omitted') }),
    run: async (a, ctx) => {
      const ward = browserId(ctx.userId, a.ward);
      let id = typeof a.id === 'string' ? a.id : '';
      if (!id && a.url) {
        const state = await browserCall(ctx.userId, ward, 'download', { url: a.url }, ctx.signal);
        id = state.download.id;
      }
      const state = await browserCall(ctx.userId, ward, 'downloads', { id }, ctx.signal);
      const file = (state.downloads as BrowserDownload[]).find(f => f.id === id);
      if (!file || file.status !== 'ready') throw Error(file?.error ?? 'Choose a ready download from browser_downloads; an in-progress download can be checked again.');
      const response = await browserRequest(ctx.userId, ward, 'file', { id }, ctx.signal);
      if (!response.ok || !response.body) throw Error(`Downloaded file unavailable (${response.status}).`);
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.length;
          if (size > DOWNLOAD_BYTES) throw Error('Download exceeds 25 MB.');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      // File IDs are runtime-local; import bytes rather than passing the browser owner's ID to this conversation.
      const stored = await storeAttachment({ userId: ctx.userId, conversationId: ctx.conv, name: file.name,
        mime: 'application/octet-stream', bytes: Buffer.concat(chunks) });
      return { file_id: stored.id, name: stored.name, mime: stored.mime, bytes: stored.bytes, pages: stored.pages,
        ...(stored.pages !== null && !stored.text ? { scanned: true, next: 'Use render_document_page with this file_id to inspect the scanned PDF.' } : {}),
        ...(stored.text ? { next: 'Use read_document or search_document with this file_id.' } : {}) };
    },
  },

  // ----------------------------------------------------------------- layout
  add_ward: {
    kind: 'write',
    description:
      'Add a ward to the dashboard. type must be a catalog key (see your instructions); config must satisfy that type\'s rules.',
    parameters: obj(
      {
        type: str('catalog key, e.g. "timer", "chart", "applink"'),
        size: { type: 'string', pattern: '^[1-6]x([1-9]|1[0-2])$', description: 'ward size "WxH": W columns 1-6, H rows 1-12; defaults to the type\'s default' },
        title: str('optional title override, ≤60 chars'),
        hidden: bool('keep the ward off the dashboard — it still shows in Edit and Leylines mode. Use it for a "note" ward that only exists to anchor a schedule.'),
        group: str('id of a "container" ward to put it inside (groups unfold in place when tapped)'),
        page: str('page id (list_pages) to put it on; default the first page. A ward in a group follows the group\'s page.'),
        config: { type: 'object', description: 'per-type config (links:[{url, icon?, statusService?}] (or a single url) for applink, url for embed, account all|google|microsoft|zoho|mailbox + unreadOnly for mail, icon (emoji or icon name) for button, services (targets, or host:cpu|mem|disk) or group + view wards|dots for service-group, db + view table|list for notion-db, duration + optional rounds/work/rest/long/loop (a routine) for timer, paper plain|lines|grid|dots + ink + transcribe off|manual|live + keepInk + provider/model for note (its text is read_note/write_note; note = a notebook note id to show that document instead of its own), the same knobs + notebook (the id of another Notebook ward, to share one notebook) for notebook, source/metric/chart/hours for chart, effect none|glass|magnify|aurora|scene + scene for spacer/separator…)', additionalProperties: true },
      },
      ['type']
    ),
    run: (a, ctx) =>
      mutateLayout(ctx.userId, (layout) => {
        const type = String(a.type);
        if (!CATALOG[type]) return `unknown ward type "${type}"`;
        const w: WardInstance = { i: newWardId(), type, size: (a.size as WardSize) ?? CATALOG[type].defaultSize };
        if (typeof a.title === 'string' && a.title.trim()) w.title = a.title.trim().slice(0, 60);
        if (a.hidden === true) w.hidden = true;
        if (typeof a.group === 'string' && a.group) {
          if (!layout.some((x) => x.i === a.group && x.type === 'container')) return `no container ward "${a.group}"`;
          w.in = a.group;
        }
        const page = pageArg(ctx.userId, a.page);
        if (page instanceof Error) return page.message;
        if (page) w.page = page;
        if (a.config && typeof a.config === 'object') w.config = a.config as Record<string, unknown>;
        layout.push(w);
        return layout;
      }),
  },
  configure_ward: {
    kind: 'write',
    description: 'Change a ward\'s title, visibility and/or config (config replaces the old one wholesale).',
    parameters: obj(
      {
        ward: str('the ward id'),
        title: str('new title, empty string clears it'),
        hidden: bool('true keeps the ward off the dashboard (still visible in Edit and Leylines mode); false puts it back'),
        group: str('id of a "container" ward to move it into; empty string moves it back to the top level'),
        page: str('page id (list_pages) to move it to'),
        config: { type: 'object', additionalProperties: true },
      },
      ['ward']
    ),
    run: (a, ctx) =>
      mutateLayout(ctx.userId, (layout) => {
        const w = layout.find((x) => x.i === a.ward);
        if (!w) return `no ward "${a.ward}"`;
        const page = pageArg(ctx.userId, a.page);
        if (page instanceof Error) return page.message;
        if (page) w.page = page;
        if (typeof a.title === 'string') {
          if (a.title.trim()) w.title = a.title.trim().slice(0, 60);
          else delete w.title;
        }
        if (typeof a.hidden === 'boolean') {
          if (a.hidden) w.hidden = true;
          else delete w.hidden;
        }
        if (typeof a.group === 'string') {
          if (!a.group) delete w.in;
          else if (w.type === 'container') return 'a container cannot go inside another';
          else if (!layout.some((x) => x.i === a.group && x.type === 'container')) return `no container ward "${a.group}"`;
          else w.in = a.group;
        }
        if (a.config && typeof a.config === 'object') w.config = a.config as Record<string, unknown>;
        return layout;
      }),
  },
  resize_ward: {
    kind: 'write',
    description: 'Resize a ward.',
    parameters: obj({ ward: str('the ward id'), size: { type: 'string', pattern: '^[1-6]x([1-9]|1[0-2])$', description: 'ward size "WxH": W columns 1-6, H rows 1-12' } }, ['ward', 'size']),
    run: (a, ctx) =>
      mutateLayout(ctx.userId, (layout) => {
        const w = layout.find((x) => x.i === a.ward);
        if (!w) return `no ward "${a.ward}"`;
        w.size = a.size as WardSize;
        return layout;
      }),
  },
  move_ward: {
    kind: 'write',
    description: 'Move a ward to a new position (0-based index in the grid order, which runs across pages), and/or to another page.',
    parameters: obj({ ward: str('the ward id'), index: num('target position, 0 = first'), page: str('page id (list_pages) to move it to') }, ['ward', 'index']),
    run: (a, ctx) =>
      mutateLayout(ctx.userId, (layout) => {
        const from = layout.findIndex((x) => x.i === a.ward);
        if (from < 0) return `no ward "${a.ward}"`;
        const page = pageArg(ctx.userId, a.page);
        if (page instanceof Error) return page.message;
        if (page) layout[from]!.page = page;
        const [w] = layout.splice(from, 1);
        layout.splice(Math.min(Math.max(Math.round(Number(a.index)), 0), layout.length), 0, w!);
        return layout;
      }),
  },
  remove_ward: {
    kind: 'confirm',
    description: 'Remove a ward from the dashboard (its timers and packets go with it; its automations go dormant).',
    parameters: obj({ ward: str('the ward id') }, ['ward']),
    run: (a, ctx) =>
      mutateLayout(ctx.userId, (layout) => {
        const from = layout.findIndex((x) => x.i === a.ward);
        if (from < 0) return `no ward "${a.ward}"`;
        layout.splice(from, 1);
        return layout;
      }),
  },
  add_page: {
    kind: 'write',
    description: 'Add a dashboard page (a tab). Returns the page list with the new id.',
    parameters: obj({ title: str('page title, 1–40 chars'), id: str('optional id [a-z0-9-]{1,32}; default a slug of the title') }, ['title']),
    run: (a, ctx) =>
      mutatePages(ctx.userId, (pages) => {
        const title = String(a.title ?? '').trim();
        if (!title) return 'title is required';
        if (pages.length >= MAX_PAGES) return `at most ${MAX_PAGES} pages`;
        const id = typeof a.id === 'string' && a.id ? a.id : pageSlug(title, pages);
        if (pages.some((p) => p.id === id)) return `page "${id}" already exists`;
        pages.push({ id, title });
      }),
  },
  rename_page: {
    kind: 'write',
    description: 'Rename a dashboard page.',
    parameters: obj({ page: str('the page id'), title: str('new title, 1–40 chars') }, ['page', 'title']),
    run: (a, ctx) =>
      mutatePages(ctx.userId, (pages) => {
        const p = pages.find((x) => x.id === a.page);
        if (!p) return `no page "${a.page}"`;
        p.title = String(a.title ?? '').trim();
      }),
  },
  delete_page: {
    kind: 'write',
    description: 'Delete a dashboard page. Its wards are NOT deleted — they move to the first page. The last page cannot be deleted.',
    parameters: obj({ page: str('the page id') }, ['page']),
    run: (a, ctx) =>
      mutatePages(ctx.userId, (pages, layout) => {
        const i = pages.findIndex((x) => x.id === a.page);
        if (i < 0) return `no page "${a.page}"`;
        if (pages.length < 2) return 'the last page cannot be deleted';
        // Absent `page` means the first page; write it out before the first
        // page can change, then send the deleted page's wards to the new first.
        for (const w of layout) if (!w.in) w.page ??= pages[0]!.id;
        pages.splice(i, 1);
        for (const w of layout) if (w.page === a.page) delete w.page;
      }),
  },
  set_theme: {
    kind: 'write',
    description:
      'Change the user\'s theme. Keys: preset (frost|glass|oled), mode (dark|light|system), accent (#rrggbb), glassAlpha (0.3–1), glassBlur (0–30), radius (0–1.25), density (compact|cozy|comfortable), background (flat|aurora|image|scene), border (0–4, card/ward border width in px), rim (0–1, glass edge trim), shadow (0–1, card drop shadow). Set surfaceCustom=true to replace the palette with surface (#rrggbb, ward + glass colour), surface2 (page colour) and line (border colour) — text colour then derives from surface, so both modes stay readable. With background=image: bgImage (a name from get_theme — uploads happen on /account only), bgBlur (0–60), bgDim (0–0.95), bgSat (0–2), bgBright (0.2–1.8), bgZoom (1–1.6), bgFixed (bool). With background=scene: bgScene (aurora|nebula|waves|orbs|starfield|grid), bgColor1/2/3 (#rrggbb), bgSpeed (0–3), bgGlow (0–2), bgScale (0.25–4), bgWarp (0–2), bgParallax (0–1); graphics: bgRes (0.25–1 render scale, default per scene), bgFps (15|24|30|60), bgDetail (2–5 noise octaves, fbm scenes only), gfxGovern (bool, auto-throttle when frames run slow), gfxHiDpi (bool, render at device pixels — 4× the work on phones). Both: bgOpacity (0.05–1). Header: hdrPad (0.25–1.5rem, its height), hdrAlpha (0.2–1), hdrBlur (0–30), hdrBorder (0–4), hdrHalo (0–1, accent glow under the bar), hdrSweep (0–1, animated accent sweep), hdrCustom + hdrBg (#rrggbb) for its own colour instead of the page colour. Header banner (same scenes as the background): hdrScene (none|aurora|nebula|waves|orbs|starfield|grid), hdrColor1/2/3 (#rrggbb), hdrSpeed (0–3), hdrGlow (0–2), hdrScale (0.25–4), hdrWarp (0–2), hdrOpacity (0.05–1), hdrRes/hdrFps/hdrDetail as for the background. Unspecified keys keep their current value.',
    parameters: obj({ theme: { type: 'object', additionalProperties: true, description: 'partial theme, merged over the current one' } }, ['theme']),
    run: (a, ctx) => {
      const row = getDb().prepare('SELECT theme FROM users WHERE id = ?').get(ctx.userId) as { theme: string | null } | undefined;
      const current = parseTheme(row?.theme) ?? {};
      const next = normalizeTheme({ ...current, ...(a.theme as Record<string, unknown>) });
      getDb().prepare('UPDATE users SET theme = ? WHERE id = ?').run(JSON.stringify(next), ctx.userId);
      // Its own event: the theme applies to <html> live, no reload needed.
      broadcast(ctx.userId, 'theme', next);
      return { ok: true, theme: next };
    },
  },

  // ------------------------------------------------------------------ logic
  add_edge: {
    kind: 'write',
    description:
      'Add an automation edge: {source: {ward, trigger, params}, conditions: [{type, params}…], action: {type, ward?, params}, enabled?}. Triggers/conditions/actions and their params are listed in your instructions; template params may use {{vars}}.',
    parameters: obj({ edge: { type: 'object', additionalProperties: true } }, ['edge']),
    run: (a, ctx) =>
      mutateGraph(ctx.userId, (graph) => {
        const e: Record<string, unknown> = { enabled: true, conditions: [], ...(a.edge as Record<string, unknown>) };
        if (typeof e.id !== 'string' || !e.id) e.id = 'e' + randomBytes(3).toString('hex');
        if (graph.edges.some((x) => x.id === e.id)) return `edge id "${e.id}" already exists — use update_edge`;
        graph.edges.push(e as never);
        return graph;
      }),
  },
  update_edge: {
    kind: 'write',
    description: 'Replace a leyline (automation edge) wholesale (same shape as add_edge, id required).',
    parameters: obj({ edge: { type: 'object', additionalProperties: true } }, ['edge']),
    run: (a, ctx) =>
      mutateGraph(ctx.userId, (graph) => {
        const e = a.edge as { id?: unknown };
        const idx = graph.edges.findIndex((x) => x.id === e.id);
        if (idx < 0) return `no edge "${e.id}" — call get_logic_graph for the real ids`;
        graph.edges[idx] = { conditions: [], enabled: true, ...(a.edge as object) } as never;
        return graph;
      }),
  },
  set_edge_enabled: {
    kind: 'write',
    description: 'Enable or disable a leyline (automation edge).',
    parameters: obj({ id: str('the edge id'), enabled: bool('true to enable') }, ['id', 'enabled']),
    run: (a, ctx) =>
      mutateGraph(ctx.userId, (graph) => {
        const e = graph.edges.find((x) => x.id === a.id);
        if (!e) return `no edge "${a.id}"`;
        e.enabled = a.enabled !== false;
        return graph;
      }),
  },
  remove_edge: {
    kind: 'confirm',
    description: 'Delete a leyline (automation edge) permanently.',
    parameters: obj({ id: str('the edge id') }, ['id']),
    run: (a, ctx) =>
      mutateGraph(ctx.userId, (graph) => {
        const idx = graph.edges.findIndex((x) => x.id === a.id);
        if (idx < 0) return `no edge "${a.id}"`;
        graph.edges.splice(idx, 1);
        return graph;
      }),
  },

  // ------------------------------------------------------------ ward organs
  timer_op: {
    kind: 'write',
    description: 'Start, pause, reset or skip a timer ward (skip = end the current routine step now).',
    parameters: obj(
      { ward: str('the timer ward id'), op: { type: 'string', enum: ['start', 'pause', 'reset', 'skip'] }, duration_sec: num('optional duration for start, 1–86400') },
      ['ward', 'op']
    ),
    run: (a, ctx) => {
      findWard(ctx.userId, String(a.ward), 'timer');
      const res = timerOp(ctx.userId, String(a.ward), a.op as 'start' | 'pause' | 'reset' | 'skip', a.duration_sec ? Number(a.duration_sec) * 1000 : undefined);
      if ('error' in res) throw new Error(res.error);
      return { ok: true, timer: res.ok };
    },
  },
  add_checklist_item: {
    kind: 'write',
    description: 'Add an item to a task or checklist ward.',
    parameters: obj(
      { ward: str('the task or checklist ward id'), title: str('the item text'), due: str('optional due date, YYYY-MM-DD') },
      ['ward', 'title']
    ),
    run: async (a, ctx) => {
      const due = /^\d{4}-\d{2}-\d{2}$/.test(String(a.due ?? '')) ? String(a.due) : undefined;
      await notionChecklistAdd(ctx.userId, await checklistDbOf(ctx.userId, String(a.ward)), String(a.title).trim(), due);
      return { ok: true };
    },
  },
  check_checklist_item: {
    kind: 'write',
    description: 'Check or uncheck a task/checklist item (its Notion page id comes from list_checklist). Works whether the database uses a checkbox, a status or a select column.',
    parameters: obj({ ward: str('the task or checklist ward id'), page_id: str('the item\'s page id'), done: bool('true = checked') }, ['ward', 'page_id', 'done']),
    run: async (a, ctx) => {
      const db = await checklistDbOf(ctx.userId, String(a.ward));
      const done = a.done !== false;
      // The list is cached, so this is cheap — and it buys both the real
      // {{item.title}} for automations and a "did this actually change?" guard
      // (a human click only fires on a real toggle; so should this).
      const before = (await notionChecklist(ctx.userId, db)).find((i) => i.id === String(a.page_id));
      if (before?.done === done) return { ok: true, unchanged: true };
      await notionChecklistToggle(ctx.userId, db, String(a.page_id), done);
      // No enqueueFire here: checklist-done is a WATCHER (logic-engine.ts), and
      // firing it from the write path too would double every automation on it.
      return { ok: true, title: before?.title };
    },
  },
  notion_capture: {
    kind: 'write',
    description: 'Append a line to the user\'s Notion quick-capture page.',
    parameters: obj({ text: str('what to capture') }, ['text']),
    run: async (a, ctx) => {
      await notionCapture(ctx.userId, String(a.text));
      return { ok: true };
    },
  },
  emit_packet: {
    kind: 'write',
    description: 'Drop a packet onto a flow ward (fires packet-arrived automations).',
    parameters: obj({ ward: str('the flow ward id'), channel: str('channel, [a-z0-9-], e.g. "inbox"'), text: str('packet text') }, ['ward', 'text']),
    run: (a, ctx) => {
      findWard(ctx.userId, String(a.ward), 'flow');
      const channel = a.channel === undefined ? 'inbox' : String(a.channel);
      if (!CHANNEL_RE.test(channel)) throw new Error('bad channel — [a-z0-9-]{1,32}');
      const packet = createPacket(ctx.userId, String(a.ward), channel, String(a.text).trim());
      broadcast(ctx.userId, 'packets', { wards: [String(a.ward)] });
      enqueueFire(ctx.userId, { type: 'packet-arrived', ward: String(a.ward), channel, packet });
      return { ok: true, packet_id: packet.id };
    },
  },
  pass_packet: {
    kind: 'write',
    description: 'Pass a waiting packet along (fires packet-passed automations).',
    parameters: obj({ id: num('the packet id') }, ['id']),
    run: (a, ctx) => {
      const packet = markPassed(ctx.userId, Number(a.id));
      if (!packet) throw new Error(`no waiting packet #${a.id}`);
      broadcast(ctx.userId, 'packets', { wards: [packet.ward] });
      enqueueFire(ctx.userId, { type: 'packet-passed', ward: packet.ward, channel: packet.channel, packet });
      return { ok: true };
    },
  },
  complete_packet: {
    kind: 'write',
    description: 'Mark a packet done.',
    parameters: obj({ id: num('the packet id') }, ['id']),
    run: (a, ctx) => {
      const packet = completePacket(ctx.userId, Number(a.id));
      if (!packet) throw new Error(`no packet #${a.id}`);
      broadcast(ctx.userId, 'packets', { wards: [packet.ward] });
      return { ok: true };
    },
  },

  // ------------------------------------------------------------------ wakes
  schedule_wake: {
    kind: 'write',
    description:
      'Wake yourself later, unattended, to do something ("in 20 minutes check the deploy"). You continue this conversation with nobody watching. For recurring work use an "every" leyline (logic edge) with the "Ask the agent" action instead.',
    parameters: obj({ instructions: str('what to do when you wake'), in_minutes: num('minutes from now, 1–129600') }, ['instructions', 'in_minutes']),
    run: (a, ctx) => {
      const wake = scheduleWake(ctx.userId, ctx.ward, String(a.instructions), Number(a.in_minutes));
      return { ok: true, wake_id: wake.id, runs_at: new Date(wake.run_at).toISOString() };
    },
  },
  cancel_wake: {
    kind: 'write',
    description: 'Cancel a scheduled wake.',
    parameters: obj({ id: num('the wake id') }, ['id']),
    run: (a, ctx) => {
      if (!cancelWake(Number(a.id), ctx.userId)) throw new Error(`no scheduled wake #${a.id}`);
      return { ok: true };
    },
  },

  // ---------------------------------------------------------- agent ↔ agent
  list_agents: {
    kind: 'read',
    description: 'The other Rime agent wards on this dashboard: title, persona (their role), model, tools, whether one is mid-turn. Discover who to delegate to.',
    parameters: obj({}),
    run: async (_a, ctx) => {
      const { peerAgents } = await import('./core.ts');
      return { agents: peerAgents(ctx.userId, ctx.ward) };
    },
  },
  spawn_agent: {
    kind: 'write',
    backgroundable: true,
    cancellable: true,
    spawn: true,
    description:
      'Start an independent child Rime run on a task and return its task_id at once. It inherits this ward’s tools, project and approval policy — never more — and runs unattended in its own thread (confirm-gated tools decline there; it cannot spawn). It sees only task and context. By default it runs on your provider and model; provider/model/endpoint/effort pick another for it (list_models shows exact ids — an id the catalog does not list is refused, never swapped). Message it with ask_agent({ward: task_id, …}); its final reply reaches this thread once as a task notice, and task_list/task_output/task_wait/task_cancel apply to it.',
    parameters: obj(
      {
        task: str('what to do, complete and self-contained — it cannot see this thread (≤ 8000 chars)'),
        context: str('optional material it needs: findings so far, ids, constraints, text to work on (≤ 20000 chars)'),
        provider: { type: 'string', enum: [...AGENT_PROVIDERS], description: 'default: this ward’s' },
        model: str('exact model id from list_models; default: this ward’s (when the provider is the same)'),
        endpoint: str('provider "compat": which of the user’s endpoints (list_models names them)'),
        effort: { type: 'string', enum: [...AGENT_EFFORTS], description: 'reasoning effort; default: this ward’s, or the model’s own default' },
      },
      ['task']
    ),
    run: async (a, ctx) => {
      const { runChildRun } = await import('./core.ts');
      return runChildRun(a, ctx);
    },
  },
  ask_agent: {
    kind: 'write',
    backgroundable: true,
    description:
      'Send a message to another Rime agent ward, or to one of your child runs (ward = its task_id). A ward runs a turn in its own thread with its own tool configuration, unattended (confirm-gated tools decline there). Memory, skills, notes and /work files are shared across this user’s agents. wait (default true) returns the reply; wait:false returns at once and a peer ward’s reply arrives later as a message to you. mode: "queue" (default) waits its turn behind whatever it is doing; "steer" slips the note into the turn it is running now (a queue if idle); "interrupt" stops that turn, then runs this. Family traffic is always a steer: to a child run the note lands between its rounds and it answers with a message of its own; reply_to answers a child’s question #N (its waiting ask_agent returns your message), and a plain message to a child that is waiting on you answers its oldest question. A child’s wait:false note to its parent gets no automatic reply. Every message has a receipt — check_message({id}).',
    parameters: obj(
      {
        ward: str('the agent ward id (list_agents), or a child run’s task_id (task_list)'),
        message: str('what to ask or tell it — include the context it needs; it cannot see your thread'),
        wait: bool('default true; false = fire and forget'),
        mode: { type: 'string', enum: [...INBOX_MODES], description: 'queue (default) | steer | interrupt — peer wards only' },
        reply_to: num('answering a child run’s question: the message id it arrived with'),
      },
      ['ward', 'message']
    ),
    run: (a, ctx) => askAgent(ctx, String(a.ward), String(a.message), { wait: a.wait !== false, mode: a.mode as InboxMode, ...(a.reply_to !== undefined ? { replyTo: Number(a.reply_to) } : {}) }),
  },
  check_message: {
    kind: 'read',
    description: 'The receipt of a message you sent with ask_agent (or one sent to you): queued, delivered, done (result = the reply) or failed (result = why).',
    parameters: obj({ id: num('the message id') }, ['id']),
    run: (a, ctx) => {
      const m = getMessage(ctx.userId, Number(a.id));
      if (!m) throw new Error(`no message #${a.id}`);
      return receipt(m);
    },
  },
  list_models: {
    kind: 'read',
    description:
      'Browse the models available to this user: every configured provider (codex = ChatGPT backend, openrouter, openai = the OpenAI API, compat = the user’s OpenAI-compatible endpoints) with exact ids, context windows, reasoning efforts, tool/vision support and prices where the provider reports them, and where each list came from (live, cache with its fetch time, the hand-kept fallback). Search with query, page with cursor. Use an id exactly as listed in spawn_agent or set_model.',
    parameters: obj({
      provider: { type: 'string', enum: [...AGENT_PROVIDERS], description: 'one provider; default: every configured one' },
      endpoint: str('provider "compat": one endpoint by name; default: all of them'),
      query: str('substring of the id or name'),
      cursor: num('page offset from next; default 0'),
      limit: num('page size 1–100; default 25'),
    }),
    run: async (a, ctx) => {
      const { browseModels } = await import('./models.ts');
      return browseModels(ctx.userId, { provider: isAgentProvider(a.provider) ? a.provider : undefined, endpoint: typeof a.endpoint === 'string' ? a.endpoint : undefined, query: typeof a.query === 'string' ? a.query : undefined, cursor: Number(a.cursor) || 0, limit: Number(a.limit) || 25 });
    },
  },
  set_model: {
    kind: 'read',
    description:
      'Switch the model (and/or reasoning effort) THIS run uses from its next round on — within its provider and endpoint: a thread is pinned to those, so changing them means starting a child (spawn_agent) with the context it needs. The ward’s own setting is untouched. The id must be one the provider lists (list_models); nothing is substituted.',
    parameters: obj({ model: str('exact model id'), effort: { type: 'string', enum: [...AGENT_EFFORTS] } }, ['model']),
    run: async (a, ctx) => {
      const { selectRunModel } = await import('./core.ts');
      return selectRunModel(ctx, { model: a.model, effort: a.effort });
    },
  },
  task_list: {
    kind: 'read',
    description: 'List active tasks and undelivered background results in this chat. Completed logs are hidden by default; history:true includes retained logs (newest 100 for 30 days). Read an exact task with task_output. Tasks stay on their originating runtime.',
    parameters: obj({ cursor: num('Task list offset; default 0'), history: bool('Include retained completed logs; default false') }),
    run: (a, ctx) => {
      const cursor = a.cursor ?? 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error('cursor must be a non-negative integer.');
      const all = listTasks(ctx, a.history === true), tasks = all.slice(cursor, cursor + 10);
      return { tasks, complete: cursor + tasks.length >= all.length, next: cursor + tasks.length };
    },
  },
  task_output: {
    kind: 'read',
    description: 'Read a task result or live output in bounded pages. Follow next until complete. A live output log may drop old text (truncated=true); a completed command has an exit_code. A successful process exit alone does not prove the requested change is correct.',
    parameters: obj({ id: str('Task ID'), cursor: num('Offset from next; default 0'), output: bool('true: live command output; false/default: final result JSON') }, ['id']),
    run: (a, ctx) => readTask(ctx, String(a.id), a.cursor ?? 0, a.output !== true),
  },
  task_wait: {
    kind: 'read',
    description: 'Wait at most 30 seconds for a task, then return its status and a page of its result. Completion notices arrive between rounds or on your next turn; do useful work instead of repeatedly polling.',
    parameters: obj({ id: str('Task ID'), milliseconds: num('Wait 0–30000ms, default 20000'), cursor: num('Result offset from next; default 0') }, ['id']),
    run: (a, ctx) => waitTask(ctx, String(a.id), a.milliseconds ?? 20_000, a.cursor ?? 0),
  },
  task_cancel: {
    kind: 'confirm',
    description: 'Request cancellation of a cancellable task in this chat. Native commands terminate their terminal process. Stopping is not rollback; inspect files/output for partial changes. Non-cancellable tools must finish.',
    parameters: obj({ id: str('Task ID') }, ['id']),
    run: (a, ctx) => cancelTask(ctx, String(a.id), ctx.task ? `child run ${ctx.task}` : 'the parent agent (task_cancel)'),
  },
  inbox: {
    kind: 'read',
    description: 'Your recent agent-to-agent traffic, both directions, newest first, with receipts.',
    parameters: obj({ limit: num('default 20, max 100') }),
    run: (a, ctx) => ({ messages: listInbox(ctx.userId, ctx.task ?? ctx.ward, Number(a.limit) || 20).map(receipt) }),
  },

  // ------------------------------------------------------------------- mail
  send_mail: {
    kind: 'confirm',
    description:
      'Send an email from one of the user\'s own mailboxes ("google", "microsoft", "zoho", or "mailbox" for their own IMAP/SMTP server). The effective ward approval policy determines whether this call pauses for confirmation.',
    parameters: obj(
      {
        account: { type: 'string', enum: [...MAIL_ACCOUNTS] },
        to: { type: 'array', items: { type: 'string' }, description: 'recipient addresses, max 5' },
        subject: str('subject line'),
        body: str('plain-text body'),
      },
      ['account', 'to', 'body']
    ),
    run: async (a, ctx) => {
      const res = await sendNow(ctx.userId, asAccount(a.account), {
        to: (Array.isArray(a.to) ? a.to : [String(a.to)]).map(String),
        subject: String(a.subject ?? ''),
        body: String(a.body ?? ''),
      });
      if ('error' in res) throw new Error(res.error);
      return { ok: true, sent_to: a.to };
    },
  },

  // ------------------------------------------------------------------- chat
  // The communication wards (Discord, …). One tool set for every provider;
  // `ward` is optional when exactly one chat ward is on the layout. Sends and
  // structure changes are confirm-gated: an unattended run (a public message
  // that woke the agent) can never post, invite or ban on its own — the
  // sanctioned reply path for a bot is the chat.send logic action.
  chat_read: {
    kind: 'read',
    description: `Read from a chat ward (${COMMS_TYPES.join(', ')}): "channels" (with ids), "messages" {channel?, limit?} (the ward's stored feed, newest first; an empty channel backfills from the provider), "search" {query}, or a provider read. Provider reads:\n${CHAT_OPS}`,
    parameters: obj(
      {
        ward: str('the chat ward id (get_layout) — optional when there is only one'),
        what: str('channels | messages | search | a provider read'),
        channel: str('channel / chat id where the read needs one'),
        message: str('message id where the read needs one'),
        user: str('user id where the read needs one'),
        query: str('search text (search, members)'),
        limit: num('default 20'),
      },
      ['what']
    ),
    run: async (a, ctx) => {
      const w = chatWard(ctx.userId, a.ward);
      const { ward: _w, what, ...rest } = a;
      const { commsRead } = await import('../comms/index.ts');
      return { ward: w.i, type: w.type, result: await commsRead(ctx.userId, w.i, String(what), rest) };
    },
  },
  chat_send: {
    kind: 'confirm',
    description: 'Post a message from a chat ward\'s bot. channel blank = the ward\'s default channel. The effective ward approval policy determines whether this call pauses for confirmation.',
    parameters: obj(
      { ward: str('the chat ward id — optional when there is only one'), channel: str('channel / chat id; blank = the ward\'s default'), text: str('the message'), reply_to: str('message id to reply to'), thread: bool('answer in a thread off reply_to') },
      ['text']
    ),
    run: async (a, ctx) => {
      const w = chatWard(ctx.userId, a.ward);
      const { sendChat } = await import('../comms/index.ts');
      const m = await sendChat(ctx.userId, w.i, a.channel ? String(a.channel) : undefined, String(a.text ?? ''), { replyTo: a.reply_to ? String(a.reply_to) : undefined, thread: a.thread === true });
      return { ok: true, id: m.id, channel: m.channel };
    },
  },
  chat_react: {
    kind: 'write',
    description: 'Add a reaction to a message in a chat ward. emoji: the character, or name:id for a custom Discord emoji.',
    parameters: obj({ ward: str('the chat ward id — optional when there is only one'), channel: str('channel id'), message: str('message id'), emoji: str('👍 or name:id') }, ['channel', 'message', 'emoji']),
    run: async (a, ctx) => {
      const w = chatWard(ctx.userId, a.ward);
      const { reactChat } = await import('../comms/index.ts');
      await reactChat(ctx.userId, w.i, String(a.channel), String(a.message), String(a.emoji));
      return { ok: true };
    },
  },
  chat_manage: {
    kind: 'confirm',
    description: `Change a chat server's structure through the ward's bot: channels, categories, threads, pins, roles, permissions, invites, nicknames. op + args per provider:\n${CHAT_OPS}\nThe effective ward approval policy determines whether this call pauses for confirmation.`,
    parameters: obj({ ward: str('the chat ward id — optional when there is only one'), op: str('the operation'), args: { type: 'object', description: 'the op\'s arguments', additionalProperties: true } }, ['op']),
    run: async (a, ctx) => {
      const w = chatWard(ctx.userId, a.ward);
      const { clientForWard } = await import('../comms/index.ts');
      return { ward: w.i, result: await clientForWard(ctx.userId, w).manage(String(a.op), (a.args ?? {}) as Record<string, unknown>) };
    },
  },
  chat_moderate: {
    kind: 'confirm',
    description: `The destructive server operations through the ward's bot — delete messages or channels, kick, ban, time out. op + args per provider:\n${CHAT_OPS}\nThe effective ward approval policy determines whether this call pauses for confirmation.`,
    parameters: obj({ ward: str('the chat ward id — optional when there is only one'), op: str('the operation'), args: { type: 'object', description: 'the op\'s arguments (reason is passed to the audit log)', additionalProperties: true } }, ['op']),
    run: async (a, ctx) => {
      const w = chatWard(ctx.userId, a.ward);
      const { clientForWard } = await import('../comms/index.ts');
      return { ward: w.i, result: await clientForWard(ctx.userId, w).moderate(String(a.op), (a.args ?? {}) as Record<string, unknown>) };
    },
  },
};

for (const [name, definition] of Object.entries(TOOLS)) {
  if (!serverTool(name)) continue;
  const run = definition.run;
  definition.run = async (args, ctx) => {
    const remote = await sharedTool(ctx.userId, ctx.ward, name, args);
    return remote ? remote.value : run(args, ctx);
  };
}

/** js-exec's `tools.<name>(args)` proxy (agent/shell.ts): READ tools only —
 *  a write stays a call the agent makes itself, where the approvals policy
 *  can pause it. MCP tools are not reachable this way either. */
export async function invokeReadTool(path: string, argsJson: string, ctx: ToolCtx): Promise<string> {
  const def = TOOLS[path];
  if (!def || def.kind !== 'read') throw new Error(`tools.${path}: not a read-only tool`);
  const { searchTools: _searchTools,...sandboxCtx } = ctx;
  const out = await def.run(argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}, sandboxCtx);
  return JSON.stringify(out ?? null);
}

/** Whether this tool's success leaves the user's Notion wards stale. The write
 *  helpers already drop the server caches; core.ts broadcasts 'refresh' off
 *  this so the open tabs repaint. Matched on the name, not a list, so a new
 *  notion_* write or *checklist* tool is covered without touching this. */
export function dirtiesNotion(name: string): boolean {
  const t = TOOLS[name];
  return !!t && t.kind !== 'read' && (name.startsWith('notion_') || name.includes('checklist'));
}

/**
 * Tool specs for the provider call, with `reason` injected once for all tools
 * (the reason line IS the streaming UI — enforced in core.ts, not just asked).
 */
export function aiTools(allow: 'all' | 'read-only', extra: Record<string, ToolDef> = {}, loaded?:ReadonlySet<string>): AgentToolSpec[] {
  return Object.entries({ ...TOOLS, ...extra })
    .filter(([name]) => !loaded || loaded.has(name))
    .filter(([, t]) => allow === 'all' || t.kind === 'read')
    .map(([name, t]) => {
      const params = t.parameters as { properties?: Record<string, unknown>; required?: string[] };
      return {
        name,
        description: t.description,
        parameters: {
          ...params,
          properties: {
            ...(t.backgroundable ? { background: { type: 'boolean', description: 'Run independently and return a task ID immediately. Use task_output/task_wait for the result; completion is announced. The user can also press Ctrl+B while this call runs.' } } : {}),
            reason: {
              type: 'string',
              description:
                'REQUIRED. One short, concrete sentence explaining this action in the activity feed. Read the room: light wit when welcome, calm precision when stakes are high. Never claim success before the result.',
            },
            ...(params.properties ?? {}),
          },
          required: ['reason', ...(params.required ?? [])],
        },
      };
    });
}
