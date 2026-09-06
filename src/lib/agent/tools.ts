import { DEV_TOOLS } from '../dev/tools.ts';
import { isDesktop } from '../dev/runtime.ts';
import { sharedTool, serverTool } from './sync.ts';
import { randomBytes } from 'node:crypto';
import { getDb } from '../db.ts';
import { browserWard, getDashboard, getPages, saveDashboard } from '../dashboard.ts';
import { goto as browserGoto, open as openBrowser, withSession, type Session as BrowserSession } from '../browser/session.ts';
import { validateLayout, validatePages, wardTitle, CATALOG, MAX_H, MAX_PAGES, MAX_W, type PageDef, type WardInstance, type WardSize } from '../wards.ts';
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
import { getSnapshot } from '../status.ts';
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
import { getAttachment, listAttachments, readPages, searchAttachment } from './attachments.ts';
import { getNote, noteWard, plainText, saveNote, textToHtml } from '../note.ts';
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

export interface ToolCtx {
  userId: number;
  ward: string;
  /** The conversation this call belongs to. Rides on the ctx, never a module
   *  global — turns for different users run concurrently. */
  conv: number;
  /** Agent wards whose sync ask_agent is waiting on this turn — see core.askAgent. */
  via?: string[];
}

export interface ToolDef {
  kind: ToolKind;
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

const pageSlug = (title: string, taken: PageDef[]) => {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'page';
  let id = base;
  for (let n = 2; taken.some((p) => p.id === id); n++) id = `${base}-${n}`;
  return id;
};

// ---------------------------------------------------------------- browser

/** Ward → live session, through the same resolver the routes use. No ward
 *  named and exactly one browser ward on the layout → that one. */
async function browserSession(userId: number, ward: unknown): Promise<BrowserSession> {
  let id = typeof ward === 'string' ? ward.trim() : '';
  if (!id) {
    const all = getDashboard(userId).filter((w) => w.type === 'browser');
    if (all.length !== 1) {
      throw new Error(all.length ? 'several browser wards — say which (ward id)' : 'no browser ward — add one (add_ward type "browser")');
    }
    id = all[0]!.i;
  }
  const cfg = browserWard(userId, id);
  if (!cfg) throw new Error(`${id} is not a browser ward`);
  return openBrowser(userId, id, cfg);
}

const pageState = async (s: BrowserSession) => ({ url: s.page.url(), title: await s.page.title().catch(() => '') });
const SNAPSHOT_CAP = 11_000; // under core.ts OUTPUT_CAP with room for url/title
const capText = (t: string) => (t.length > SNAPSHOT_CAP ? `${t.slice(0, SNAPSHOT_CAP)}\n…[cut at ${SNAPSHOT_CAP} chars — trim with depth, or act on what is here]` : t);
const REF_RE = /^(f\d+)?e\d+$/;

async function browserAct(s: BrowserSession, a: Record<string, any>): Promise<void> {
  const ref = String(a.ref ?? '').trim();
  const T = { timeout: 10_000 };
  const loc = () => {
    if (!REF_RE.test(ref)) throw new Error('ref must be a [ref=eN] handle from the last browser_snapshot');
    return s.page.locator(`aria-ref=${ref}`);
  };
  switch (String(a.action)) {
    case 'click':
      await loc().click(T);
      break;
    case 'fill':
      await loc().fill(String(a.text ?? ''), T);
      break;
    case 'press':
      await (ref ? loc().press(String(a.key ?? 'Enter'), T) : s.page.keyboard.press(String(a.key ?? 'Enter')));
      break;
    case 'select':
      await loc().selectOption(String(a.value ?? ''), T); // a plain string matches value OR label
      break;
    case 'hover':
      await loc().hover(T);
      break;
    case 'scroll':
      await s.page.mouse.wheel(0, Number(a.dy) || 600);
      break;
    case 'back':
      await s.page.goBack({ waitUntil: 'commit', timeout: 30_000 });
      break;
    case 'forward':
      await s.page.goForward({ waitUntil: 'commit', timeout: 30_000 });
      break;
    default:
      throw new Error('action must be one of click, fill, press, select, hover, scroll, back, forward');
  }
}

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
  ...(isDesktop()?DEV_TOOLS:{}),
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
    description: 'Live status of every monitored service plus host CPU/memory/disk.',
    parameters: obj({}),
    run: () => {
      const snap = getSnapshot();
      if (!snap) throw new Error('no status snapshot yet — the engine just booted, try again shortly');
      return snap;
    },
  },
  get_weather: {
    kind: 'read',
    description: 'Current conditions and the short forecast, for the first weather ward on the board that has a place.',
    parameters: obj({}),
    run: async (_a, ctx) => {
      const f = await forecastFor(ctx.userId);
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
    description: 'The text of a notepad ward (type "note") — the user\'s own writing, plus whatever their handwriting was transcribed into.',
    parameters: obj({ ward: str('the note ward id (get_layout)') }, ['ward']),
    run: (a, ctx) => {
      const w = noteWard(ctx.userId, a.ward);
      if (!w) throw new Error(`no note ward "${a.ward}" — call get_layout for the real ids`);
      const doc = getNote(ctx.userId, w);
      return { ward: w.i, title: wardTitle(w), text: plainText(doc.html), updated: doc.updated };
    },
  },
  write_note: {
    kind: 'write',
    description: 'Write into a notepad ward: append paragraphs to it, or replace the whole document. Plain text; a blank line separates paragraphs. The ink layer is untouched.',
    parameters: obj({ ward: str('the note ward id'), text: str('what to write'), mode: { type: 'string', enum: ['append', 'replace'], description: 'default append' } }, ['ward', 'text']),
    run: (a, ctx) => {
      const w = noteWard(ctx.userId, a.ward);
      if (!w) throw new Error(`no note ward "${a.ward}" — call get_layout for the real ids`);
      const text = String(a.text ?? '').trim();
      if (!text) throw new Error('nothing to write');
      const html = a.mode === 'replace' ? textToHtml(text) : getNote(ctx.userId, w).html + textToHtml(text);
      const updated = saveNote(ctx.userId, w, { html });
      broadcast(ctx.userId, 'note', { ward: w.i }); // the open ward reloads its document
      return { ok: true, ward: w.i, updated };
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
    run: async (a, ctx) => {
      const s = await browserSession(ctx.userId, a.ward);
      return withSession(s, async () => {
        const state = await pageState(s);
        if (a.mode === 'text') return { ...state, text: capText(await s.page.innerText('body', { timeout: 10_000 }).catch(() => '')) };
        const depth = Number(a.depth) > 0 ? { depth: Math.floor(Number(a.depth)) } : {};
        return { ...state, snapshot: capText(await s.page.ariaSnapshot({ mode: 'ai', ...depth, timeout: 10_000 })) };
      });
    },
  },
  bash: {
    kind: 'write',
    description:
      'Run one command line in your sandbox (a bash interpreter over a virtual FS — /history holds your past conversations, /docs the text of every attachment, /work is your scratch space; rg, sed, awk, sqlite3, pdftotext, js-exec are available). js-exec runs JavaScript (QuickJS): `js-exec file.js` or `js-exec -c "…"`; inside a script `await tools.<name>({…})` calls any of your READ-ONLY tools. It cannot touch the dashboard DB or the host.',
    parameters: obj({ command: str(`the command line, e.g. rg -n "invoice" /docs`) }, ['command']),
    run: async (a, ctx) => {
      const res = await runShell(ctx.userId, String(a.command), (path, argsJson) => invokeReadTool(path, argsJson, ctx));
      return { exit_code: res.exitCode, stdout: res.stdout, stderr: res.stderr.slice(0, 500), truncated: res.truncated };
    },
  },

  // ---------------------------------------------------------------- browser
  browser_open: {
    kind: 'write',
    description: 'Navigate a browser ward to a URL and wait for it to load. Then browser_snapshot to see it. The user sees the same page move on their ward.',
    parameters: obj({ url: str('the http(s) URL'), ward: str('the browser ward id — optional when there is exactly one') }, ['url']),
    run: async (a, ctx) => {
      const s = await browserSession(ctx.userId, a.ward);
      return withSession(s, async () => {
        await browserGoto(s, String(a.url));
        await s.page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
        return pageState(s);
      });
    },
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
    run: async (a, ctx) => {
      const s = await browserSession(ctx.userId, a.ward);
      return withSession(s, async () => {
        await browserAct(s, a);
        await s.page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {});
        return pageState(s);
      });
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
        config: { type: 'object', description: 'per-type config (links:[{url, icon?, statusService?}] (or a single url) for applink, url for embed, account all|google|microsoft|zoho|mailbox + unreadOnly for mail, icon (emoji or icon name) for button, services (targets, or host:cpu|mem|disk) or group + view wards|dots for service-group, db + view table|list for notion-db, duration + optional rounds/work/rest/long/loop (a routine) for timer, paper plain|lines|grid|dots + ink + transcribe off|manual|live + keepInk + provider/model for note (its text is read_note/write_note), source/metric/chart/hours for chart, effect none|glass|magnify|aurora|scene + scene for spacer/separator…)', additionalProperties: true },
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
  ask_agent: {
    kind: 'write',
    description:
      'Send a message to another Rime agent ward. It runs a turn in its own thread with its own memory and tools, unattended (confirm-gated tools decline there). wait (default true) returns the reply; wait:false returns at once and the reply arrives later as a message to you. mode: "queue" (default) waits its turn behind whatever it is doing; "steer" slips the note into the turn it is running now (a queue if idle); "interrupt" stops that turn, then runs this. Every message has a receipt — check_message(id).',
    parameters: obj(
      {
        ward: str('the agent ward id (list_agents)'),
        message: str('what to ask or tell it — include the context it needs; it cannot see your thread'),
        wait: bool('default true; false = fire and forget, the answer comes back as a message'),
        mode: { type: 'string', enum: [...INBOX_MODES], description: 'queue (default) | steer | interrupt' },
      },
      ['ward', 'message']
    ),
    run: (a, ctx) => askAgent(ctx, String(a.ward), String(a.message), { wait: a.wait !== false, mode: a.mode as InboxMode }),
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
  inbox: {
    kind: 'read',
    description: 'Your recent agent-to-agent traffic, both directions, newest first, with receipts.',
    parameters: obj({ limit: num('default 20, max 100') }),
    run: (a, ctx) => ({ messages: listInbox(ctx.userId, ctx.ward, Number(a.limit) || 20).map(receipt) }),
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
  const out = await def.run(argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}, ctx);
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
export function aiTools(allow: 'all' | 'read-only', extra: Record<string, ToolDef> = {}): AgentToolSpec[] {
  return Object.entries({ ...TOOLS, ...extra })
    .filter(([, t]) => allow === 'all' || t.kind === 'read')
    .map(([name, t]) => {
      const params = t.parameters as { properties?: Record<string, unknown>; required?: string[] };
      return {
        name,
        description: t.description,
        parameters: {
          ...params,
          properties: {
            reason: {
              type: 'string',
              description:
                'REQUIRED. One short sentence, addressed to the user, saying what you are doing and why — it is shown on their screen the moment this call starts.',
            },
            ...(params.properties ?? {}),
          },
          required: ['reason', ...(params.required ?? [])],
        },
      };
    });
}
