// Ward contract, shared by server (shell render, layout validation) and
// client (renderer registry, add dialog). Pure data + functions only — this
// module must never import db.ts; it ships to the browser.

import { FONTS, SCENE_IDS, normalizeWardTheme, type SceneId, type WardTheme } from './theme.ts';
import { TARGETS, GROUP_TITLES as TARGET_GROUP_TITLES } from './targets.ts';
import { ICON_NAME_RE, ICONS, type IconId } from './icon-names.ts';

/** Reasoning effort an agent ward asks its model for (`config.effort`, default
 *  medium). `max` and `ultra` are what the newest codex models list; a model
 *  that lacks one answers with its own error, which the ward shows. */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
/** Where a model call goes: the ChatGPT-backend Responses endpoint, OpenRouter, the OpenAI API
 *  with a key, or one of the user's own OpenAI-compatible endpoints (named in `endpoint`). */
export const AGENT_PROVIDERS = ['codex', 'openrouter', 'openai', 'compat'] as const;
export type AgentProviderId = (typeof AGENT_PROVIDERS)[number];
export const isAgentProvider = (v: unknown): v is AgentProviderId => (AGENT_PROVIDERS as readonly unknown[]).includes(v);
/** An endpoint's name: short, lowercase, what the user typed in Account → Agent. */
export const ENDPOINT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** One page of a Notion database read (notion.ts) — the ceiling on a task
 *  ward's limit, and on the count params logic.ts re-exports this for. */
export const CHECKLIST_PAGE_SIZE = 50;

/** Every mailbox a ward, a logic rule or an agent tool can name. Widening this
 *  is what adds a mail account everywhere at once — the option lists in
 *  logic.ts and the tool enums in agent/tools.ts are built from it. */
export const MAIL_ACCOUNTS = ['google', 'microsoft', 'zoho', 'mailbox'] as const;
export type MailAccount = (typeof MAIL_ACCOUNTS)[number];

/** What an MCP server's tools count as, set per ward (lib/agent/mcp.ts). */
export const MCP_TRUST = ['read', 'write', 'confirm'] as const;
export type McpTrust = (typeof MCP_TRUST)[number];

/** Known remote MCP servers — the add dialog's preset list prefills url and
 *  header from these; the token is set on the ward. Unverified beyond the
 *  vendors' own docs: a moved endpoint is a config edit, not a code change. */
export const MCP_PRESETS: { name: string; title: string; url: string; header?: string; note: string }[] = [
  { name: 'deepwiki', title: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', note: 'docs of any public GitHub repo, no token' },
  { name: 'context7', title: 'Context7', url: 'https://mcp.context7.com/mcp', header: 'CONTEXT7_API_KEY', note: 'library docs; a key raises the limits' },
  { name: 'github', title: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', note: 'a fine-grained personal access token as the bearer token' },
  { name: 'huggingface', title: 'Hugging Face', url: 'https://huggingface.co/mcp', note: 'a Hugging Face token as the bearer token' },
  { name: 'cloudflare-docs', title: 'Cloudflare docs', url: 'https://docs.mcp.cloudflare.com/mcp', note: 'Cloudflare documentation, no token' },
];

/** A ward size, `WxH`: W grid columns (1-6), H grid rows (1-12). */
export type WardSize = `${number}x${number}`;
export const MAX_W = 6;
export const MAX_H = 12;
const SIZE_RE = /^([1-6])x([1-9]|1[0-2])$/;

/** [cols, rows] of a size string; 2x1 for anything unparsable. */
export function sizeParts(size: string): [number, number] {
  const m = SIZE_RE.exec(size);
  return m ? [+m[1]!, +m[2]!] : [2, 1];
}

/** Agent controls need four rows; all layout writers share the same minimum. */
export function fitWardSize(type: string, size: WardSize): WardSize {
  const [cols, rows] = sizeParts(size);
  return `${cols}x${type === 'agent' ? Math.max(4, rows) : rows}`;
}

/** Row span of an instance — the wards that cap their item count scale it by this. */
export const rowsOf = (w: WardInstance): number => sizeParts(w.size)[1];

export interface WardInstance {
  /** Execution placement, managed by the app; never a user-facing mode. */
  device?: string;
  /** Instance id, [a-z0-9-]{1,32}, unique within a layout. */
  i: string;
  /** Key of CATALOG. */
  type: string;
  size: WardSize;
  /** Optional title override (applink uses it as the ward name). */
  title?: string;
  /** Off the dashboard — rendered only in edit and logic mode. A ward that
   *  exists to anchor automations doesn't need to take up a grid slot. */
  hidden?: boolean;
  /** This card's own theme — colours, glass, radius, font, even light/dark.
   *  Absent (or empty) = follow the dashboard's. See lib/theme.ts WardTheme. */
  theme?: WardTheme;
  /** The `container` ward this one lives in. The layout stays ONE flat list —
   *  logic, tools and validation see every ward the same way — and nesting is
   *  this one pointer, one level deep. A dangling pointer self-heals to the
   *  top level rather than failing the layout. */
  in?: string;
  /** The page this ward sits on; absent = the first page. Like `in`: one
   *  pointer, and the layout stays ONE flat list — every key in the system is
   *  (userId, wardId) and none of them look at this. A nested ward follows its
   *  group's page (validateLayout strips `page` off it). */
  page?: string;
  /** Per-type config; validated/rebuilt by validateLayout. */
  config?: Record<string, unknown>;
}

export interface CatalogEntry {
  title: string;
  defaultSize: WardSize;
  /** Semantic icon id (lib/icon-names.ts ICONS) for the catalog, group peeks and the tray. */
  icon: IconId;
  /** One-liner for the add-ward catalog card. */
  blurb: string;
  /** Which linked account powers it; the client swaps in a Connect chip when missing. */
  link?: 'google' | 'microsoft' | 'notion' | 'zoho' | 'mailbox';
  /** Can appear more than once per layout. */
  multi?: boolean;
  /** Still valid (stored layouts and logic name it) but hidden from the add
   *  dialog — superseded by another type. */
  legacy?: boolean;
  /** Has per-type config: validateLayout stores the rebuilt config, the card
   *  gets a ⚙ and the context menu a Configure… entry. */
  configurable?: true;
  /** The most this type may be shared as (lib/shares.ts): `edit` = a collaborator may
   *  write (a document) or drive (a browser); `view` = watch only; absent = never shared. */
  share?: 'view' | 'edit';
  /** Add-dialog group. */
  category: Category;
  /** SEMANTIC vocabulary — what a person might call it or want from it:
   *  synonyms, tasks, moods. Searched with title + blurb (catalog-search.ts). */
  concepts: string[];
  /** FUNCTIONAL vocabulary — what the ward DOES: data read/written, verbs, the
   *  logic it offers. The trigger/action labels anchored on the type and its
   *  link provider are appended by the caller (registryDoes): never hand-write
   *  a registry label such as "reset" here — the test proves the wiring with it. */
  does: string[];
}

/** Add-dialog groups, in display order. */
export const CATEGORIES = {
  glance: 'At a glance',
  mail: 'Mail',
  comms: 'Chat & messaging',
  notion: 'Notion',
  write: 'Write & capture',
  logic: 'Leylines & automation',
  rime: 'Rime',
  layout: 'Layout & looks',
} as const;
export type Category = keyof typeof CATEGORIES;

export const CATALOG: Record<string, CatalogEntry> = {
  'remote-desktop': { title: 'Remote Desktop', defaultSize: '6x4', icon: 'host', blurb: 'View and control one of your paired computers.', multi: true, configurable: true, category: 'rime', concepts: ['computer', 'screen', 'remote', 'desktop', 'monitor', 'control', 'sharing'], does: ['view computer screen', 'control mouse and keyboard', 'select display', 'hand control to Rime'] },
  'project-files': { title: 'Project files', defaultSize: '2x3', icon: 'folder', blurb: 'Browse and search a desktop project.', multi: true, category: 'rime', concepts: ['project','folder','files','tree','workspace','search'], does: ['browse folders','create files','rename files'] },
  editor: { title: 'Editor', defaultSize: '6x4', icon: 'code', blurb: 'Project files, code editing, linting, and recovery in one workspace.', multi: true, category: 'rime', concepts: ['code','text','file','editor','source','buffer','lint','vscode','explorer'], does: ['edit files','save changes','recover drafts','find problems','format code'] },
  terminal: { share: 'view', title: 'Terminal', defaultSize: '3x3', icon: 'bot', blurb: 'A live shell, Codex, or Claude Code session on your desktop.', multi: true, category: 'rime', concepts: ['shell','console','terminal','codex','claude','command'], does: ['run commands','control sessions','inspect output'] },
  changes: { title: 'Changes', defaultSize: '2x3', icon: 'folders', blurb: 'Git status, diffs, and worktrees for a desktop project.', multi: true, category: 'rime', concepts: ['git','diff','changes','worktree','branch','repository'], does: ['review changes','inspect status','manage worktrees'] },
  weather: {
    share: 'view',
    title: 'Weather', defaultSize: '2x1', icon: 'weather', blurb: 'Now and 3 days for a place you pick; at 2x2 the next 24 hours and the week.', multi: true, configurable: true, category: 'glance',
    concepts: ['forecast', 'temperature', 'rain', 'snow', 'sun', 'clouds', 'wind', 'humidity', 'outlook', 'today', 'tomorrow', 'umbrella', 'cold', 'hot', 'conditions', '3 day', 'week', 'location', 'city', 'place'],
    does: ['reads the open-meteo forecast', 'shows current conditions and a three-day outlook', 'triggers logic when the weather turns', 'daily weather report', 'temperature crosses a threshold'],
  },
  mail: {
    title: 'Inbox', defaultSize: '1x1', icon: 'mail', blurb: 'Every linked mailbox in one ward — 1x1 is the unread count, taller is the inbox with reader and compose.', multi: true, configurable: true, category: 'mail',
    concepts: ['inbox', 'email', 'e-mail', 'messages', 'unread', 'gmail', 'google mail', 'outlook', 'microsoft', 'zoho', 'imap', 'pop3', 'smtp', 'mailbox', 'compose', 'reply', 'archive', 'sender', 'subject', 'badge', 'count', 'unified', 'all accounts'],
    does: ['reads every linked mailbox in one list', 'counts unread mail', 'opens and reads a message', 'composes replies and sends mail', 'archives a message', 'fires logic when new mail arrives', 'filters by account'],
  },
  calendar: {
    share: 'view',
    title: 'Agenda', defaultSize: '2x2', icon: 'calendar', blurb: 'Google, Outlook, iCloud and a Notion calendar database, next 5 days.', category: 'glance',
    concepts: ['calendar', 'agenda', 'schedule', 'events', 'meetings', 'appointments', 'classes', 'today', 'tomorrow', 'this week', 'upcoming', 'due', 'deadlines', 'when', 'google calendar', 'outlook', 'icloud', 'notion calendar', 'all day'],
    does: ['reads the merged agenda from google outlook icloud and a notion database', 'lists the next five days of events', 'shows the free gap today', 'fires logic before an event starts', 'fires logic when an event is added'],
  },
  'next-up': {
    share: 'view',
    title: 'Next up', defaultSize: '1x1', icon: 'calendar', blurb: 'Countdown to your next event — room and Join link.', category: 'glance',
    concepts: ['next up', 'next event', 'next meeting', 'next class', 'countdown', 'soon', 'upcoming', 'in x minutes', 'join link', 'zoom', 'teams', 'meet', 'room', 'where', 'agenda', 'schedule', 'ends in'],
    does: ['counts down to the next calendar event', 'shows the room and a join link', 'shows ends in during an event', 'reads the merged agenda', 'fires logic before an event starts'],
  },
  'notion-db': {
    share: 'edit',
    title: 'Database view', defaultSize: '3x2', icon: 'database', blurb: 'One view of a Notion database — table, task list or month calendar. What Notion shows, editable here.', link: 'notion', multi: true, configurable: true, category: 'notion',
    concepts: ['todo', 'todos', 'tasks', 'task list', 'checklist', 'checkbox', 'table', 'rows', 'columns', 'spreadsheet', 'database', 'view', 'list', 'calendar', 'month', 'schedule', 'assignments', 'exams', 'due', 'deadline', 'deadlines', 'overdue', 'done', 'tick', 'kanban', 'project', 'tracker', 'habits', 'grocery', 'shopping list'],
    does: ['reads a notion database', 'shows rows as an editable table or a task list', 'shows rows on a month calendar', 'picks which date column the calendar uses', 'edits cells in place', 'checks off todos', 'adds rows', 'shows what is due', 'fires logic when items change or come due', 'counts items'],
  },
  'notion-tasks': {
    share: 'edit',
    title: 'Tasks', defaultSize: '2x2', icon: 'tasks', blurb: 'A Notion database as a task list.', link: 'notion', multi: true, legacy: true, configurable: true, category: 'notion',
    concepts: ['tasks', 'todo', 'task list', 'checklist', 'due', 'done'],
    does: ['reads a notion database as a task list', 'checks off tasks', 'fires logic when items change'],
  },
  'notion-page': {
    share: 'edit',
    title: 'Notion page', defaultSize: '2x2', icon: 'page', blurb: 'A whole page — properties, blocks, comments, a capture line — all editable. No page = capture to your capture page.', link: 'notion', multi: true, configurable: true, category: 'notion',
    concepts: ['page', 'document', 'doc', 'wiki', 'notes', 'properties', 'fields', 'blocks', 'content', 'comments', 'form', 'status', 'tags', 'journal', 'capture', 'jot', 'write', 'outline', 'headings', 'checkbox'],
    does: ['reads a whole notion page', 'edits properties in place', 'edits blocks in place', 'adds comments', 'appends captured text', 'fires logic when the page or a property changes'],
  },
  'notion-recent': {
    title: 'Recent pages', defaultSize: '2x1', icon: 'history', blurb: 'Recently edited Notion pages.', link: 'notion', category: 'notion',
    concepts: ['recent', 'recently edited', 'history', 'last opened', 'activity', 'changes', 'pages', 'feed', 'what changed'],
    does: ['lists recently edited notion pages', 'opens a page', 'fires logic when any page is created or edited'],
  },
  applink: {
    share: 'view',
    title: 'Launcher', defaultSize: '1x1', icon: 'link', blurb: 'One link, or up to twelve: icon, host, live status dot each.', multi: true, configurable: true, category: 'glance',
    concepts: ['launcher', 'link', 'shortcut', 'bookmark', 'app', 'url', 'website', 'icon', 'dock', 'favourites', 'favorites', 'quick access', 'open', 'jump', 'status dot', 'uptime'],
    does: ['opens a url in a new tab', 'shows an icon per link', 'shows a live status dot from a monitored service', 'holds up to twelve links'],
  },
  browser: {
    share: 'edit',
    title: 'Browser', defaultSize: '3x3', icon: 'globe', blurb: 'A real browser you and Rime both drive — logins stick.', multi: true, configurable: true, category: 'rime',
    concepts: ['browser', 'chromium', 'chrome', 'web', 'website', 'page', 'tab', 'tabs', 'login', 'session', 'cookies', 'remote', 'headless', 'browse', 'surf', 'url', 'address bar', 'rime drives it'],
    does: ['drives a real headless chromium', 'keeps logins per ward', 'rime reads and acts on the same page', 'opens tabs and navigates', 'types clicks and scrolls', 'expands to a desktop-sized page', 'streams video and sound to viewers', 'runs on this server or browserbase', 'runs on your computer through the rimeward app', 'egresses from your home ip'],
  },
  embed: {
    title: 'Embed', defaultSize: '2x2', icon: 'image', blurb: 'Any http(s) page in a sandboxed frame.', multi: true, legacy: true, configurable: true, category: 'rime',
    concepts: ['embed', 'iframe', 'frame', 'web page', 'website', 'url', 'external', 'ward', 'view'],
    does: ['shows any http page in a sandboxed frame', 'no login persistence', 'sites that refuse embedding stay blank'],
  },
  'service-group': {
    share: 'view',
    title: 'Services', defaultSize: '3x2', icon: 'folders', blurb: 'A group or custom set — wards, or a dots wall. Host cpu/mem/disk can be members.', multi: true, configurable: true, category: 'glance',
    concepts: ['services', 'status', 'uptime', 'monitor', 'health', 'up', 'down', 'latency', 'processes', 'containers', 'pm2', 'docker', 'systemd', 'group', 'board', 'dots', 'what is down'],
    does: ['shows a group or custom set of monitored services', 'shows up down and latency live', 'sparklines of latency', 'fires logic when any service in the group changes', 'host metrics as rows'],
  },
  incidents: {
    share: 'view',
    title: 'Incidents', defaultSize: '1x1', icon: 'incident', blurb: 'What went down and came back — live changes and the last 24h of outages.', category: 'glance',
    concepts: ['incidents', 'outages', 'downtime', 'went down', 'came back', 'flapping', 'history', 'last 24 hours', 'status', 'uptime', 'reliability', 'postmortem', 'alerts', 'what broke', 'sla'],
    does: ['lists what went down and came back', 'shows live status changes', 'sums downtime over the last 24 hours', 'reads status history'],
  },
  chart: {
    share: 'view',
    title: 'Chart', defaultSize: '2x2', icon: 'chart', blurb: 'Plot any data source over time.', multi: true, configurable: true, category: 'glance',
    concepts: ['chart', 'graph', 'plot', 'line', 'area', 'bars', 'history', 'trend', 'over time', 'latency', 'uptime', 'cpu', 'memory', 'disk', 'temperature', 'rain', 'sparkline', 'analytics', 'metrics'],
    does: ['plots service latency or uptime history', 'plots host cpu memory or disk', 'plots the weather forecast', 'line area or bar chart', 'picks a lookback window'],
  },
  timer: {
    share: 'edit',
    title: 'Timer', defaultSize: '1x1', icon: 'timer', blurb: 'Server-side countdown — fires logic when done.', multi: true, configurable: true, category: 'logic',
    concepts: ['timer', 'countdown', 'stopwatch', 'alarm', 'pomodoro', 'focus', 'break', 'minutes', 'seconds', 'remind', 'reminder', 'routine', 'interval', 'schedule', 'every', 'clock', 'delay', 'wait'],
    does: ['counts down on the server', 'fires logic when it finishes', 'starts pauses and restarts from logic', 'runs every n minutes', 'runs at a time of day', 'keeps going with the tab closed'],
  },
  button: {
    share: 'edit',
    title: 'Button', defaultSize: '1x1', icon: 'button', blurb: 'One tap fires your logic — wire it up in Logic mode.', multi: true, configurable: true, category: 'logic',
    concepts: ['button', 'switch', 'trigger', 'tap', 'press', 'click', 'manual', 'start', 'go', 'run', 'panel', 'remote', 'hotkey', 'launch', 'kick off', 'one tap'],
    does: ['fires logic when pressed', 'one tap fires your automations', 'press and hold on touch', 'shows the wired rules and the last run'],
  },
  note: {
    share: 'edit',
    title: 'Notepad', defaultSize: '2x2', icon: 'note', blurb: 'Write or draw; Rime reads your handwriting. Expand it into a full editor.', multi: true, configurable: true, category: 'write',
    concepts: ['notepad', 'note', 'notes', 'scratch', 'scratchpad', 'write', 'writing', 'draw', 'drawing', 'sketch', 'ink', 'pen', 'handwriting', 'stylus', 'journal', 'memo', 'editor', 'rich text', 'markdown', 'paper', 'doodle', 'whiteboard'],
    does: ['stores rich text and ink strokes', 'pen and eraser drawing', 'rime transcribes handwriting to text', 'runs writing commands on the text', 'expands into a full editor', 'anchors schedules every n minutes or at a time of day'],
  },
  notebook: {
    share: 'edit',
    title: 'Notebook', defaultSize: '2x2', icon: 'notebook', blurb: 'Notes in sections with tags, pins, saved views and search — the notepad, organized.', multi: true, configurable: true, category: 'write',
    concepts: ['notebook', 'notes', 'journal', 'diary', 'wiki', 'knowledge base', 'zettelkasten', 'second brain', 'sections', 'chapters', 'tags', 'pinned', 'archive', 'trash', 'search', 'writing', 'documents', 'binder', 'collection', 'organize', 'outline', 'index'],
    does: ['organizes notes into sections and tags', 'searches titles text and tags', 'pins and orders notes by hand', 'saves filtered sorted views as list table or cards', 'archives and trashes notes with restore and delete forever', 'links an existing notepad document', 'generates an index of the notebook', 'opens a full editor for each note', 'links notes to each other and lists backlinks', 'defines typed properties per notebook', 'starts notes from templates', 'answers questions from the notes', 'syncs notes between the server and paired desktops'],
  },
  checklist: {
    share: 'edit',
    title: 'Checklist', defaultSize: '2x2', icon: 'check', blurb: 'Same list, compact — a second view of any database.', link: 'notion', multi: true, legacy: true, configurable: true, category: 'notion',
    concepts: ['checklist', 'tasks', 'todo', 'tick', 'done', 'list'],
    does: ['reads a notion database as a checklist', 'checks off items', 'fires logic when an item is checked'],
  },
  flow: {
    share: 'view',
    title: 'Flow', defaultSize: '2x2', icon: 'flow', blurb: 'Packets travel ward to ward through your logic.', multi: true, category: 'logic',
    concepts: ['flow', 'packets', 'pipeline', 'queue', 'channel', 'kanban', 'stages', 'inbox outbox', 'workflow', 'routing', 'items', 'cards', 'conveyor', 'sorter', 'tickets', 'messages'],
    does: ['holds packets in channels', 'emits packets from logic', 'moves packets ward to ward', 'fires logic when a packet arrives or passes', 'passes waiting packets along', 'completes and annotates packets', 'sorts packets with a model'],
  },
  agent: {
    title: 'Rime', defaultSize: '2x4', icon: 'rime', blurb: 'Rime — an AI with real tools over your wards, logic and Notion.', multi: true, configurable: true, category: 'rime',
    concepts: ['rime', 'ai', 'assistant', 'agent', 'chat', 'bot', 'llm', 'gpt', 'model', 'openrouter', 'codex', 'ask', 'talk', 'help', 'automation', 'tools', 'shell', 'web search', 'browse'],
    does: ['chats with a model that has real tools', 'reads and edits your wards and logic', 'reads and writes notion', 'runs shell commands in a sandbox', 'searches the web', 'drives the browser ward', 'wakes on a schedule or a trigger', 'answers a question from logic', 'confirms before sending mail'],
  },
  memory: {
    title: 'Memory', defaultSize: '2x2', icon: 'memory', blurb: "What Rime remembers — one file per fact, the index in every turn's prompt. Read, edit, forget.", category: 'rime',
    concepts: ['memory', 'memories', 'remember', 'forget', 'recall', 'facts', 'long-term', 'knowledge', 'what rime knows', 'index', 'brain', 'context', 'preferences', 'learned', 'reflection'],
    does: ['lists every memory file with its description', 'shows how much of the index rides in the prompt', 'reads and edits a memory in place', 'forgets a memory', 'turns nightly reflection on or off', 'anchors a daily schedule'],
  },
  skill: {
    title: 'Skills', defaultSize: '2x2', icon: 'skill', blurb: 'What Rime knows how to do — one SKILL.md per procedure, listed in every turn, read when a task matches. Write, edit, delete.', category: 'rime',
    concepts: ['skills', 'skill', 'procedure', 'how to', 'playbook', 'checklist', 'recipe', 'routine', 'instructions', 'teach rime', 'workflow', 'steps', 'template', 'custom', 'what rime can do'],
    does: ['lists every skill with when to use it', 'reads and edits a skill in place', 'writes a new skill by hand', 'deletes a skill', 'shows how much of the index rides in the prompt'],
  },
  mcp: {
    title: 'MCP server', defaultSize: '2x1', icon: 'mcp', blurb: 'A remote MCP server — its tools become Rime\'s, prefixed with the server name. Logic can call them too.', multi: true, configurable: true, category: 'rime',
    concepts: ['mcp', 'model context protocol', 'server', 'connector', 'integration', 'plugin', 'tools', 'api', 'github', 'context7', 'deepwiki', 'hugging face', 'remote', 'connect', 'extend rime'],
    does: ['connects to a remote mcp server over http', 'gives rime the server\'s tools', 'lists the tools and whether it is connected', 'holds the token sealed', 'sets how much its tools are trusted', 'calls a tool from logic'],
  },
  discord: {
    title: 'Discord', defaultSize: '2x2', icon: 'discord', blurb: 'A Discord bot on one server — read and post in its channels, react, run the server; Rime and logic both reach it.', multi: true, configurable: true, category: 'comms',
    concepts: ['discord', 'discord bot', 'discord server', 'guild', 'channel', 'channels', 'chat', 'community', 'gaming', 'bot', 'dm', 'direct message', 'thread', 'threads', 'reaction', 'reactions', 'emoji', 'moderation', 'roles', 'members', 'invite', 'mention', 'ping me', 'answer people'],
    does: ['connects a discord bot to one server over the gateway', 'shows the messages of a channel and posts to it', 'watches channels for new messages mentions and reactions', 'creates and edits channels threads roles and invites', 'kicks bans and times out members', 'rime reads and manages the server', 'holds the bot token sealed'],
  },
  telegram: {
    title: 'Telegram', defaultSize: '2x2', icon: 'telegram', blurb: 'A Telegram bot — DMs, groups and channels it is in; Rime and logic answer through it.', multi: true, configurable: true, category: 'comms',
    concepts: ['telegram', 'telegram bot', 'botfather', 'chat', 'group', 'supergroup', 'channel', 'dm', 'private chat', 'bot', 'text me', 'ping me', 'notify me on my phone', 'messenger', 'forum topic', 'reaction'],
    does: ['connects a telegram bot by long polling', 'shows the chats the bot has seen and posts to them', 'watches chats for new messages mentions and reactions', 'pins messages sets titles creates invites and topics', 'bans mutes and unbans members', 'rime reads and manages the chats', 'holds the bot token sealed'],
  },
  slack: {
    title: 'Slack', defaultSize: '2x2', icon: 'slack', blurb: 'A Slack app in one workspace — read and post in its channels; with an app token it hears mentions and reactions live.', multi: true, configurable: true, category: 'comms',
    concepts: ['slack', 'slack bot', 'slack app', 'workspace', 'channel', 'channels', 'chat', 'team chat', 'work chat', 'thread', 'threads', 'dm', 'direct message', 'reaction', 'emoji', 'mention', 'socket mode', 'ping me', 'answer people'],
    does: ['connects a slack app to one workspace', 'shows the messages of a channel and posts to it', 'watches channels for new messages mentions and reactions live over socket mode', 'creates renames and archives channels sets topics pins and invites', 'kicks members and deletes messages', 'rime reads and manages the workspace', 'holds the tokens sealed'],
  },
  twilio: {
    title: 'Twilio SMS', defaultSize: '2x2', icon: 'sms', blurb: 'Text messages and WhatsApp through a Twilio number — an allow list of people who can reach the bot, and it can reach them.', multi: true, configurable: true, category: 'comms',
    concepts: ['twilio', 'sms', 'text', 'texts', 'text message', 'whatsapp', 'phone', 'mobile', 'cell', 'number', 'text me', 'notify me on my phone', 'page me', 'alert my phone', 'two-way texting', 'mms'],
    does: ['sends sms and whatsapp messages from a twilio number', 'polls the number for texts every 30 seconds', 'watches for new texts from the allow list', 'shows the conversation with each number', 'rime reads and sends texts', 'holds the auth token sealed', 'caps sends at 20 an hour'],
  },
  push: {
    title: 'Push notification', defaultSize: '1x1', icon: 'push', blurb: 'A buzz on your phone through ntfy or Pushover — the place logic and Rime send what must not wait.', multi: true, configurable: true, category: 'comms',
    concepts: ['push', 'push notification', 'notification', 'notify', 'notify me', 'alert', 'alert me', 'buzz', 'phone', 'ntfy', 'pushover', 'ping me', 'wake me', 'urgent', 'pager'],
    does: ['sends a push notification to your phone', 'delivers rime answers and logic alerts', 'first line of the text is the title', 'works with any ntfy server or pushover', 'holds the token sealed'],
  },
  matrix: {
    title: 'Matrix', defaultSize: '2x2', icon: 'matrix', blurb: 'A Matrix account on your homeserver — rooms, replies, reactions; Element and Beeper users see the bot as one of them.', multi: true, configurable: true, category: 'comms',
    concepts: ['matrix', 'element', 'beeper', 'synapse', 'homeserver', 'room', 'rooms', 'chat', 'federated', 'open protocol', 'self-hosted chat', 'dm', 'reaction', 'thread', 'mention', 'bot', 'answer people'],
    does: ['connects a matrix account over sync long polling', 'shows the messages of a room and posts to it', 'watches rooms for new messages mentions and reactions', 'creates rooms invites sets names and topics', 'kicks bans and redacts', 'accepts room invites', 'rime reads and manages the rooms', 'holds the access token sealed'],
  },
  teams: {
    title: 'Microsoft Teams', defaultSize: '2x2', icon: 'teams', blurb: 'Your Teams chats, or one team\'s channels, through your linked Microsoft account — Rime and logic post as you.', multi: true, configurable: true, category: 'comms', link: 'microsoft',
    concepts: ['teams', 'microsoft teams', 'ms teams', 'office', 'microsoft 365', 'work chat', 'chat', 'channel', 'channels', 'group chat', 'meeting chat', 'colleagues', 'mention', 'reply', 'answer people'],
    does: ['reads your teams chats or a team\'s channels through microsoft graph', 'posts as you in a chat or channel', 'polls the watched conversations every minute', 'replies in a channel thread', 'creates a channel sets a chat topic adds a member', 'soft-deletes a message', 'rime reads and answers your teams chats'],
  },
  spacer: {
    share: 'view',
    title: 'Spacer', defaultSize: '1x1', icon: 'square', blurb: 'An empty slot — invisible, or glass, a lens, an aurora, a scene; or a labelled rule between sections.', multi: true, configurable: true, category: 'layout',
    concepts: ['spacer', 'gap', 'blank', 'empty', 'padding', 'placeholder', 'glass', 'lens', 'magnify', 'aurora', 'scene', 'decoration', 'effect', 'layout', 'align'],
    does: ['takes a grid slot with no data', 'wears glass a lens an aurora or an animated scene', 'pushes wards into place', 'shows the page background through it'],
  },
  shared: {
    // Not superseded: `legacy` keeps it out of the picker grid and the search — a shared
    // ward is placed from the dialog's "Shared with me" list (edit.ts), never chosen as a type.
    title: 'Shared with me', defaultSize: '2x2', icon: 'share', blurb: 'A ward someone shared with you — theirs to arrange, yours to place.', multi: true, legacy: true, category: 'layout',
    concepts: ['shared', 'share', 'collaborate', 'someone else', 'friend', 'household', 'team', 'guest', 'their ward', 'invite'],
    does: ['shows a ward another user shared', 'stays live like theirs', 'moves and resizes on your page', 'never changes what is theirs'],
  },
  container: {
    share: 'view',
    // configurable with no knobs: the ⚙ is how a group is renamed (the title field).
    title: 'Group', defaultSize: '2x1', icon: 'folder', blurb: 'A folder of wards — tap to open it over the board.', multi: true, configurable: true, category: 'layout',
    concepts: ['group', 'folder', 'container', 'nest', 'bundle', 'collection', 'stack', 'collapse', 'fold', 'tidy', 'organise', 'organize', 'popover', 'drawer', 'category'],
    does: ['holds other wards', 'opens as a popover over the board', 'drag wards in and out', 'logic wires reach the wards inside', 'keeps its own size'],
  },
};

/** The looks a spacer can wear. none = no chrome at all; the rest
 *  give it a surface (glass), a lens over the page background (magnify), the
 *  CSS aurora blobs, or its own animated scene preset in a canvas. */
export const WARD_FX = ['none', 'glass', 'magnify', 'aurora', 'scene'] as const;
export type WardFx = (typeof WARD_FX)[number];
/** The effect a ward wears, for the `data-fx` attribute both writers stamp. */
export const fxOf = (w: WardInstance): WardFx | undefined => (w.type === 'spacer' ? ((w.config?.effect as WardFx) ?? 'none') : undefined);

/** The wards that read a whole Notion data source as a list: the database
 *  ward and the two legacy task types it superseded. Logic anchors, the
 *  server resolver (notion.ts taskWardRef) and the dialog all share it. */
export const TASK_WARDS = new Set(['notion-db', 'checklist', 'notion-tasks']);

/** A group's display title: the registry's, or `Host` for the host metrics column. */
export const groupTitle = (g: string): string => (g === 'host' ? 'Host' : (TARGET_GROUP_TITLES[g] ?? g));

/** Pseudo-service ids under which host metrics land in status_history, and
 *  the members a Services ward can hold beside real targets. */
export const HOST_SERVICE_IDS = ['host:cpu', 'host:mem', 'host:disk'] as const;
export const HOST_LABELS: Record<string, string> = { 'host:cpu': 'Load', 'host:mem': 'Memory', 'host:disk': 'Disk' };

// ------------------------------------------------------------------ charts

/** The browser ward: a real (headless) Chromium the human drives from the ward
 *  and the agent drives with tools. `url` is its home page; the profile — and
 *  every login in it — persists per ward. */
export interface BrowserConfig {
  url?: string;
  /** Where the Chromium runs: this server, Browserbase, or the user's own
   *  computer through the Rimeward app (lib/browser/app-backend.ts). */
  backend: 'local' | 'browserbase' | 'app';
  /** Egress for a local backend: absent = this server's address, `home` =
   *  through the desktop app's tunnel, i.e. the user's own IP (lib/tunnel.ts). */
  route?: 'home';
  /** Play the page's audio through the speakers of the computer that runs the
   *  Chromium (the desktop app's). Off = Chromium's --mute-audio. Applied at
   *  launch; an idle session relaunches when it changes. */
  sound?: boolean;
}

/** The notepad (type `note`). The document itself lives in the notes table
 *  (lib/note.ts) — the layout carries only these knobs. */
export const NOTE_PAPERS = ['plain', 'lines', 'grid', 'dots'] as const;
export interface NoteConfig {
  paper: (typeof NOTE_PAPERS)[number];
  /** The ink layer (pen, eraser) is available. */
  ink: boolean;
  /** off = ink stays ink · manual = a Transcribe button · live = each pause in writing is read. */
  transcribe: 'off' | 'manual' | 'live';
  /** Leave the strokes in place once their text has landed. */
  keepInk: boolean;
  /** Which of the agent's providers reads the ink / runs ✨ commands — the model must accept images. */
  provider: AgentProviderId;
  endpoint?: string;
  model?: string;
  /** Legacy: the text a note held before the document store; seeds the first draft. */
  text?: string;
  /** The document this ward shows (lib/note.ts) — absent = its own id. Set
   *  when a notebook note is put on the dashboard; the SAME row, never a copy. */
  note?: string;
}

/** The Notebook ward: the notepad's knobs (its shared editor reads them) plus
 *  the notebook it shows — absent = its own id, the way a note's document is. */
export interface NotebookConfig extends Omit<NoteConfig, 'text' | 'note'> {
  notebook?: string;
}
export function notebookConfig(w: WardInstance): NotebookConfig {
  const { text: _t, note: _n, ...knobs } = noteConfig(w);
  const cfg: NotebookConfig = knobs;
  const raw = w.config ?? {};
  if (typeof raw.notebook === 'string' && WARD_ID_RE.test(raw.notebook) && raw.notebook !== w.i) cfg.notebook = raw.notebook;
  return cfg;
}

/** A note ward's knobs with every default applied (a fresh ward has none yet). */
export function noteConfig(w: WardInstance): NoteConfig {
  const raw = w.config ?? {};
  const cfg: NoteConfig = {
    paper: (NOTE_PAPERS as readonly unknown[]).includes(raw.paper) ? (raw.paper as NoteConfig['paper']) : 'plain',
    ink: raw.ink !== false,
    transcribe: raw.transcribe === 'off' || raw.transcribe === 'live' ? raw.transcribe : 'manual',
    keepInk: raw.keepInk === true,
    provider: isAgentProvider(raw.provider) ? raw.provider : 'openrouter',
  };
  if (cfg.provider === 'compat' && typeof raw.endpoint === 'string' && ENDPOINT_NAME_RE.test(raw.endpoint)) cfg.endpoint = raw.endpoint;
  if (typeof raw.model === 'string' && raw.model.trim() && raw.model.length <= 100) cfg.model = raw.model.trim();
  if (typeof raw.text === 'string' && raw.text) cfg.text = raw.text.slice(0, 2000);
  if (typeof raw.note === 'string' && WARD_ID_RE.test(raw.note) && raw.note !== w.i) cfg.note = raw.note;
  return cfg;
}

// ------------------------------------------------------------------ timer

/** A routine (pomodoro) step; `rounds` unset on the timer = a plain timer. */
export interface RoutineStep {
  label: 'Focus' | 'Break' | 'Long break';
  min: number;
}

/** The step list a timer's config expands to: Focus/Break per round, a Long
 *  break after the last; zero-minute rests are omitted. Empty for a plain timer. */
export function timerSteps(cfg: Record<string, unknown> | undefined): RoutineStep[] {
  const rounds = Number(cfg?.rounds) || 0;
  if (!rounds) return [];
  const out: RoutineStep[] = [];
  for (let r = 1; r <= rounds; r++) {
    out.push({ label: 'Focus', min: Number(cfg!.work) });
    const rest: RoutineStep = r === rounds ? { label: 'Long break', min: Number(cfg!.long) } : { label: 'Break', min: Number(cfg!.rest) };
    if (rest.min) out.push(rest);
  }
  return out;
}

// --------------------------------------------------------------- next up

/** What next-up needs of a CalEvent, typed here because this module must
 *  not import google.ts. */
export interface CalEventLite {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  source: string;
  joinUrl?: string;
}

export interface NextUp {
  now?: CalEventLite;
  next: CalEventLite[];
}

/** Timed events only — Google all-day starts are naive midnight strings. */
export function nextUp(events: CalEventLite[], now: number): NextUp {
  const timed = events.filter((e) => !e.allDay && Number.isFinite(Date.parse(e.start)) && Date.parse(e.end) > now);
  const cur = timed.find((e) => Date.parse(e.start) <= now);
  return { now: cur, next: timed.filter((e) => Date.parse(e.start) > now).slice(0, 3) };
}

export interface ChartConfig {
  source: 'status' | 'host' | 'weather';
  /** status: a TARGETS id · host: cpu|mem|disk · weather: unused */
  service?: string;
  /** status: latency|uptime · host: pct · weather: temp|precip */
  metric: string;
  chart: 'line' | 'area' | 'bars';
  /** Lookback window, 1..168 (weather ignores it — fixed 24h forecast). */
  hours: number;
}

/** Per-source rules; drives both validation and the add-dialog selects.
 *  Adding a data source = one entry here + one SOURCES entry in charts.ts. */
export const CHART_SOURCES: Record<
  ChartConfig['source'],
  { label: string; metrics: string[]; services: string[] | 'targets' | null }
> = {
  status: { label: 'Service history', metrics: ['latency', 'uptime'], services: 'targets' },
  host: { label: 'Host resources', metrics: ['pct'], services: ['cpu', 'mem', 'disk'] },
  weather: { label: 'Weather forecast', metrics: ['temp', 'precip'], services: null },
};

// --------------------------------------------------------------- agenda

/** Where "today" ends for the free-time line on the Agenda ward.
 *  ponytail: fixed day end; a per-ward knob costs a dialog section. */
export const DAY_END_H = 22;

/** Biggest unbooked stretch in [now, end] ms. Overlaps merge; all-day events
 *  are not busy; events past `end` or already over are ignored. null = no
 *  timed event left before `end` (the list already says that). A zero-length
 *  result means booked solid. */
/** The 42 local days a Sunday-first month grid shows (Notion's calendar),
 *  as YYYY-MM-DD: the month plus the days that pad its first and last week. */
export function monthCells(year: number, month0: number): string[] {
  const first = new Date(year, month0, 1);
  const start = new Date(year, month0, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
}

/** The local days a Notion date value covers, [first, last]; an end before
 *  the start clamps to the start. A datetime's day is its LOCAL day. */
export function dateSpan(v: { start?: string; end?: string | null } | undefined): [string, string] | null {
  if (!v?.start) return null;
  const day = (s: string) => {
    if (!s.includes('T')) return s.slice(0, 10);
    const d = new Date(s);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const a = day(v.start);
  const b = v.end ? day(v.end) : a;
  return [a, b < a ? a : b];
}

/** The columns a calendar card shows under its title: the picked ones, else
 *  every tag-like column (select / multi-select / status — what Notion's own
 *  calendar shows) up to three. Title and the date column never repeat. */
export function calendarChips(props: { name: string; type: string }[], picked: string[] | undefined, titleName: string, dateName: string): string[] {
  const names = new Set(props.map((p) => p.name));
  const chosen = (picked ?? []).filter((n) => names.has(n));
  const out = chosen.length ? chosen : props.filter((p) => p.type === 'select' || p.type === 'multi_select' || p.type === 'status').map((p) => p.name).slice(0, 3);
  return out.filter((n) => n !== titleName && n !== dateName);
}

export function biggestGap(events: { start: string; end: string; allDay: boolean }[], now: number, end: number): { from: number; to: number } | null {
  const busy = events
    .filter((e) => !e.allDay && Date.parse(e.end) > now && Date.parse(e.start) < end)
    .map((e) => [Math.max(Date.parse(e.start), now), Math.min(Date.parse(e.end), end)] as const)
    .sort((a, b) => a[0] - b[0]);
  if (busy.length === 0) return null;
  let best = { from: now, to: now };
  let cursor = now;
  for (const [s, e] of [...busy, [end, end] as const]) {
    if (s - cursor > best.to - best.from) best = { from: cursor, to: s };
    cursor = Math.max(cursor, e);
  }
  return best;
}

// ----------------------------------------------------------------- layout

export const DEFAULT_LAYOUT: WardInstance[] = [
  { i: 'host', type: 'service-group', size: '2x1', title: 'Host', config: { services: [...HOST_SERVICE_IDS] } },
  { i: 'incidents', type: 'incidents', size: '1x1' },
  { i: 'weather', type: 'weather', size: '2x1' },
  { i: 'mail', type: 'mail', size: '2x2', config: { account: 'all' } },
  { i: 'calendar', type: 'calendar', size: '2x2' },
  { i: 'notion-db', type: 'notion-db', size: '2x2', config: { view: 'list' } },
  { i: 'notion-capture', type: 'notion-page', size: '2x1', title: 'Quick capture', config: { show: ['add'] } },
  { i: 'notion-recent', type: 'notion-recent', size: '2x1' },
  // Every monitor in the registry; empty until an admin adds some.
  { i: 'services', type: 'service-group', size: '3x2', config: {} },
];

/** The service ids some ward in this layout actually puts on screen.
 *  Page-level alerts scope themselves to this: a dashboard with no service
 *  ward has no business shouting about a service being down. Group wards
 *  expand through TARGETS, the same list the snapshot is built from. */
export function shownServiceIds(layout: WardInstance[]): Set<string> {
  const ids = new Set<string>();
  const hiddenGroups = new Set(layout.filter((w) => w.type === 'container' && w.hidden).map((w) => w.i));
  for (const w of layout) {
    if (w.hidden || (w.in && hiddenGroups.has(w.in))) continue;
    const cfg = w.config ?? {};
    if (w.type === 'service-group') {
      if (Array.isArray(cfg.services)) {
        for (const id of cfg.services) if (typeof id === 'string') ids.add(id);
      } else {
        // A group, or (no config) every monitor.
        for (const t of TARGETS) if (typeof cfg.group !== 'string' || t.group === cfg.group) ids.add(t.id);
      }
    } else if (w.type === 'applink' && Array.isArray(cfg.links)) {
      for (const l of cfg.links as Record<string, unknown>[]) if (typeof l?.statusService === 'string') ids.add(l.statusService);
    }
  }
  return ids;
}

/** Display title: explicit override > derived from config (a group's title,
 *  a sole member's label) > catalog default. */
export function wardTitle(w: WardInstance): string {
  if (w.title) return w.title;
  if (w.type === 'service-group') {
    const cfg = w.config ?? {};
    if (typeof cfg.group === 'string') return groupTitle(cfg.group);
    const one = Array.isArray(cfg.services) && cfg.services.length === 1 ? cfg.services[0] : undefined;
    if (typeof one === 'string') return TARGETS.find((t) => t.id === one)?.label ?? HOST_LABELS[one] ?? CATALOG[w.type]!.title;
  }
  if (w.type === 'weather' && typeof w.config?.name === 'string' && w.config.name) return `Weather · ${w.config.name}`;
  return CATALOG[w.type]?.title ?? w.type;
}

// ------------------------------------------------------------- validation

const ID_RE = /^[a-z0-9-]{1,32}$/;
/** The id shape of a ward, a note document and a notebook alike. */
export const WARD_ID_RE = ID_RE;
/** Today's whole-dashboard cap, now per page; the total is the hard ceiling. */
export const MAX_WARDS_PER_PAGE = 40;
export const MAX_WARDS = 200;
export const MAX_PAGES = 12;
const PAGE_TITLE_MAX = 40;

/** One tab of the dashboard. The list is ordered; the first is the default. */
export interface PageDef {
  id: string;
  title: string;
  icon?: IconId;
  project?: string;
  /** The computer that owns this project's files. No filesystem path is shared. */
  device?: string;
  /** A page someone else shared with this user (lib/shares.ts): the tab shows THEIR page;
   *  none of this user's wards live on it, and it is never the first page. */
  share?: string;
}
/** The id shape of a share (lib/shares.ts SHARE_ID_RE, repeated here: this module stays db-free). */
const SHARE_RE = /^[a-z0-9]{12}$/;
/** What an empty stored page list means. */
export const DEFAULT_PAGES: PageDef[] = [{ id: 'home', title: 'Home' }];

/** A page id from its title: lowercase, dashes, 24 chars, `-2`/`-3`… past a taken id. */
export function pageSlug(title: string, taken: PageDef[]): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'page';
  let id = base;
  for (let n = 2; taken.some((p) => p.id === id); n++) id = `${base}-${n}`;
  return id;
}

/** The page list as stored: null on anything malformed, DEFAULT_PAGES for an
 *  empty list (the column default). An unknown icon is dropped, not refused. */
export function validatePages(raw: unknown): PageDef[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_PAGES) return null;
  const seen = new Set<string>();
  const out: PageDef[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const { id, title, icon } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !ID_RE.test(id) || seen.has(id)) return null;
    if (typeof title !== 'string' || !title.trim() || title.trim().length > PAGE_TITLE_MAX) return null;
    seen.add(id);
    const p: PageDef = { id, title: title.trim() };
    if (typeof (item as PageDef).device === 'string' && /^[a-f0-9-]{36}$/.test((item as PageDef).device!)) p.device = (item as PageDef).device;
    if (typeof (item as PageDef).project === 'string' && /^[\w-]{1,80}$/.test((item as PageDef).project!)) p.project = (item as PageDef).project;
    if (typeof (item as PageDef).share === 'string' && SHARE_RE.test((item as PageDef).share!)) p.share = (item as PageDef).share;
    if (typeof icon === 'string' && icon in ICONS) p.icon = icon as IconId;
    out.push(p);
  }
  // Absent `page` on a ward means the first page: a shared page there would swallow them.
  if (out[0]?.share) delete out[0].share;
  return out.length ? out : DEFAULT_PAGES;
}

/** The page a ward is on — its group's when nested, the first page when unset. */
export function pageOf(w: WardInstance, pages: PageDef[], layout: WardInstance[] = []): string {
  const owner = w.in ? (layout.find((g) => g.i === w.in) ?? w) : w;
  return owner.page ?? pages[0]!.id;
}

/** A browser ward's device scale: the display's pixel ratio, clamped 1–2 in
 *  quarter steps so the server, the in-app driver and the client agree. */
export function browserScale(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1;
  return Math.min(2, Math.max(1, Math.round(n * 4) / 4));
}

export function httpUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// References may belong to a connected server whose monitor registry is not local.
const isTargetId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
/** A Services ward member: a target, or a host metric row. isTargetId stays
 *  narrow on purpose — applink dots and charts never see host:* ids. */
const isMemberId = (v: unknown): v is string => isTargetId(v) || (HOST_SERVICE_IDS as readonly string[]).includes(v as string);

/** A user-typed icon: an emoji, or a name in the theme's icon set
 *  (ICON_NAME_RE — the only shape that reaches a URL). */
const freeIcon = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && (v.length <= 8 || ICON_NAME_RE.test(v));

const MAX_LINKS = 12;
/** One launcher link: url (http/https), an emoji or icon name, a status dot. */
function appLink(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const url = httpUrl(r.url);
  if (!url) return null;
  const out: Record<string, unknown> = { url };
  if (freeIcon(r.icon)) out.icon = r.icon;
  if (r.statusService !== undefined) {
    if (!isTargetId(r.statusService)) return null;
    out.statusService = r.statusService;
  }
  return out;
}

/** Accepts a raw 32-hex id, dashed UUID, or pasted notion.so URL; returns the
 *  dashed id. Lives here (not notion.ts) so client code and logic.ts can use
 *  it — notion.ts's module chain imports db.ts. */
export function notionIdFrom(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2048) return null;
  const m =
    v.trim().match(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i) ??
    v.trim().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) return null;
  const hex = m[0].replace(/-/g, '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Rebuild (never pass through) each per-type config; null = reject the layout. */
/** A capped list of Notion property names — shared by every ward that lets
 *  you choose which columns to show. */
function nameList(raw: unknown, cap: number): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const name = x.trim();
    if (name && name.length <= 100) seen.add(name);
    if (seen.size >= cap) break;
  }
  return [...seen];
}

function validateConfig(type: string, raw: Record<string, unknown>): Record<string, unknown> | null {
  switch (type) {
    // A legacy single {url, icon?, statusService?} normalizes to links:[…] on
    // every read, so nothing downstream ever sees the old shape.
    case 'applink': {
      const list = Array.isArray(raw.links) ? raw.links : [raw];
      if (list.length === 0 || list.length > MAX_LINKS) return null;
      const links = list.map(appLink);
      return links.every(Boolean) ? { links } : null;
    }
    // An MCP server. url optional so a fresh ward shows its card instead of
    // failing the layout; name is the tool prefix, so a slug.
    case 'mcp': {
      const name = String(raw.name ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'mcp';
      const header = String(raw.header ?? '').trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'Authorization';
      const trust = (MCP_TRUST as readonly string[]).includes(raw.trust as string) ? raw.trust : 'write';
      return { name, url: httpUrl(raw.url) ?? '', header, trust };
    }
    // A Discord bot on one server. Never null: ids are snowflakes or empty
    // (a fresh ward shows its card and asks); watch is 'all' or a csv of ids.
    case 'discord': {
      const id = (v: unknown) => (typeof v === 'string' && /^\d{5,25}$/.test(v.trim()) ? v.trim() : '');
      const watchRaw = String(raw.watch ?? '').trim();
      const ids = watchRaw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^\d{5,25}$/.test(s));
      return { guild: id(raw.guild), channel: id(raw.channel), watch: watchRaw && watchRaw !== 'all' && ids.length ? ids.join(',') : 'all' };
    }
    // A Telegram bot. Chat ids are integers (negative for groups) or @usernames.
    case 'telegram': {
      const CHAT = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;
      const chat = typeof raw.channel === 'string' && CHAT.test(raw.channel.trim()) ? raw.channel.trim() : '';
      const watchRaw = String(raw.watch ?? '').trim();
      const ids = watchRaw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => CHAT.test(s));
      return { channel: chat, watch: watchRaw && watchRaw !== 'all' && ids.length ? ids.join(',') : 'all' };
    }
    // A Slack app. Channel ids start with C (public), G (private) or D (a DM).
    case 'slack': {
      const CH = /^[CDG][A-Z0-9]{5,}$/;
      const channel = typeof raw.channel === 'string' && CH.test(raw.channel.trim()) ? raw.channel.trim() : '';
      const watchRaw = String(raw.watch ?? '').trim();
      const ids = watchRaw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => CH.test(s));
      return { channel, watch: watchRaw && watchRaw !== 'all' && ids.length ? ids.join(',') : 'all' };
    }
    // Twilio: the account SID and the number are config, the auth token is sealed
    // on the ward. `allow` is the list of numbers that may reach the bot (csv).
    case 'twilio': {
      const NUM = /^(whatsapp:)?\+\d{7,15}$/;
      const num = (v: unknown) => (typeof v === 'string' && NUM.test(v.replace(/[\s()-]/g, '')) ? v.replace(/[\s()-]/g, '') : '');
      const sid = typeof raw.sid === 'string' && /^AC[0-9a-f]{32}$/i.test(raw.sid.trim()) ? raw.sid.trim() : '';
      const allow = String(raw.allow ?? '').split(/[\s,]+/).map((s) => num(s)).filter(Boolean);
      return { sid, from: num(raw.from), channel: num(raw.channel), allow: [...new Set(allow)].join(',') };
    }
    // A push ward: ntfy (a topic on a server) or Pushover (a user key).
    case 'push': {
      const service = raw.service === 'pushover' ? 'pushover' : 'ntfy';
      const server = service === 'ntfy' ? httpUrl(typeof raw.server === 'string' && raw.server.trim() ? (/^https?:\/\//.test(raw.server.trim()) ? raw.server.trim() : `https://${raw.server.trim()}`) : 'https://ntfy.sh')?.replace(/\/+$/, '') ?? 'https://ntfy.sh' : '';
      const target = typeof raw.channel === 'string' ? raw.channel.trim() : '';
      const okTarget = service === 'ntfy' ? /^[A-Za-z0-9_-]{1,64}$/.test(target) : /^[A-Za-z0-9]{30}$/.test(target);
      return { service, server, channel: okTarget ? target : '' };
    }
    // A Matrix account: the homeserver is the user's, rooms are !id:server or #alias:server.
    case 'matrix': {
      const ROOM = /^[!#][^\s:]+:[^\s/]+$/;
      const hs = typeof raw.homeserver === 'string' && raw.homeserver.trim() ? httpUrl(/^https?:\/\//.test(raw.homeserver.trim()) ? raw.homeserver.trim() : `https://${raw.homeserver.trim()}`) : null;
      const channel = typeof raw.channel === 'string' && ROOM.test(raw.channel.trim()) ? raw.channel.trim() : '';
      const watchRaw = String(raw.watch ?? '').trim();
      const ids = watchRaw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => ROOM.test(s));
      return { homeserver: hs?.replace(/\/+$/, '') ?? '', channel, watch: watchRaw && watchRaw !== 'all' && ids.length ? ids.join(',') : 'all' };
    }
    // Teams over the linked Microsoft account: a team id → its channels, none → the user's chats.
    case 'teams': {
      const ID = /^[A-Za-z0-9:@._%-]{8,200}$/;
      const id = (v: unknown) => (typeof v === 'string' && ID.test(v.trim()) ? v.trim() : '');
      const watchRaw = String(raw.watch ?? '').trim();
      const ids = watchRaw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => ID.test(s));
      return { team: id(raw.team), channel: id(raw.channel), watch: watchRaw && watchRaw !== 'all' && ids.length ? ids.join(',') : 'all' };
    }
    case 'embed': {
      const url = httpUrl(raw.url);
      return url ? { url } : null;
    }
    // Someone else's ward on this dashboard (lib/shares.ts): the share id IS the config.
    case 'shared':
      return typeof raw.share === 'string' && SHARE_RE.test(raw.share) ? { share: raw.share } : null;
    // A place: both coordinates, in range — else no place, and the ward uses
    // the instance fallback if there is one (lib/weather.ts). Never null: an
    // unplaced weather ward is still a ward. `name` is what the title shows.
    case 'weather': {
      const num = (v: unknown) => (v === undefined || v === null || v === '' ? NaN : Number(v));
      const lat = num(raw.lat);
      const lon = num(raw.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return {};
      const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '';
      return { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, ...(name ? { name } : {}) };
    }
    // Label = the title override; the icon is the only knob. Never null.
    case 'button':
      return freeIcon(raw.icon) ? { icon: raw.icon } : {};
    // Never null: a bad account degrades to every linked mailbox.
    case 'mail': {
      const a = raw.account;
      const out: Record<string, unknown> = { account: a === 'all' || (MAIL_ACCOUNTS as readonly string[]).includes(a as string) ? a : 'all' };
      if (raw.unreadOnly === true) out.unreadOnly = true;
      return out;
    }
    case 'browser': {
      // No home URL is fine (about:blank); a junk one is not.
      const backend = raw.backend === 'browserbase' || raw.backend === 'app' ? raw.backend : 'local';
      const out: Record<string, unknown> = { backend } satisfies BrowserConfig;
      if (raw.route === 'home') out.route = 'home';
      if (raw.sound === true) out.sound = true;
      if (typeof raw.url === 'string' && raw.url.trim()) {
        const url = httpUrl(raw.url.trim());
        if (!url) return null;
        out.url = url;
      }
      return out;
    }
    case 'remote-desktop': {
      return { autoConnect: raw.autoConnect === true, quality: ['saver', 'auto', 'sharp'].includes(String(raw.quality)) ? raw.quality : 'auto',
        view: ['fill', 'actual'].includes(String(raw.view)) ? raw.view : 'fit', diagnostics: raw.diagnostics === true };
    }
    case 'service-group': {
      // A group, a list of members, or neither: every monitor in the registry.
      const out: Record<string, unknown> = {};
      if (typeof raw.group === 'string' && raw.group !== '') {
        if (raw.group.length > 80 || /[\x00-\x1f]/.test(raw.group)) return null;
        out.group = raw.group;
      } else if (Array.isArray(raw.services)) {
        if (raw.services.length === 0 || raw.services.length > 100 || !raw.services.every(isMemberId)) return null;
        out.services = raw.services;
      }
      if (raw.view === 'dots') out.view = 'dots'; // the default wards view is not stored
      return out;
    }
    case 'chart': {
      const spec = CHART_SOURCES[raw.source as ChartConfig['source']];
      if (!spec) return null;
      const metric = typeof raw.metric === 'string' && spec.metrics.includes(raw.metric) ? raw.metric : spec.metrics[0]!;
      const chart = raw.chart === 'area' || raw.chart === 'bars' ? raw.chart : 'line';
      const out: Record<string, unknown> = { source: raw.source, metric, chart };
      // The lookback is meaningless for a fixed forecast — stored only where a source honours it.
      if (spec.services !== null) out.hours = Math.min(Math.max(Math.round(Number(raw.hours) || 24), 1), 168);
      if (spec.services === 'targets') {
        if (!isTargetId(raw.service)) return null;
        out.service = raw.service;
      } else if (spec.services) {
        if (typeof raw.service !== 'string' || !spec.services.includes(raw.service)) return null;
        out.service = raw.service;
      }
      return out;
    }
    // rounds 1-12 turns the timer into a routine (Focus/Break × rounds, a
    // Long break last, loop); 0/absent = a plain timer, byte for byte.
    case 'timer': {
      // Absent/junk → the default; an explicit 0 stays 0 (a zero-minute step is omitted).
      const n = (v: unknown, d: number, max: number) => Math.min(Math.max(Math.round(v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v)), 0), max);
      const out: Record<string, unknown> = { duration: Math.min(Math.max(Math.round(Number(raw.duration) || 300), 1), 86400) };
      const rounds = n(raw.rounds, 0, 12);
      if (rounds) Object.assign(out, { rounds, work: n(raw.work, 25, 1440) || 25, rest: n(raw.rest, 5, 1440), long: n(raw.long, 15, 1440), loop: raw.loop === true });
      return out;
    }
    // The notepad: knobs only (the document is in the notes table). Never
    // null — it is also the ward a schedule hangs off, and a bad knob must not
    // take the layout down. `text` is the pre-store note, kept as the seed.
    case 'note':
      return { ...noteConfig({ i: '', type: 'note', size: '2x2', config: raw }) };
    case 'notebook':
      return { ...notebookConfig({ i: '', type: 'notebook', size: '2x2', config: raw }) };
    // A whole page (or a few of its fields, or only the capture line). `page`
    // is optional so a fresh ward shows its picker instead of failing the layout.
    case 'notion-page': {
      const out: Record<string, unknown> = {};
      if (raw.page !== undefined && raw.page !== '') {
        const page = notionIdFrom(raw.page);
        if (!page) return null;
        out.page = page;
      }
      const names = nameList(raw.props, 8);
      if (names.length) out.props = names;
      if (raw.head === false) out.head = false; // no title/icon chrome
      // 'add' is the capture line: Enter appends to this page (or, with no
      // page, to the account's capture page).
      const show = (Array.isArray(raw.show) ? raw.show : []).filter((x): x is string => x === 'props' || x === 'blocks' || x === 'comments' || x === 'add');
      if (show.length) out.show = [...new Set(show)];
      const depth = Math.round(Number(raw.depth));
      out.depth = depth >= 0 && depth <= 4 ? depth : 2;
      return out;
    }
    // One database ward, three views: 'table' (default — rows × columns),
    // 'list' (the task list the legacy checklist/notion-tasks types render)
    // and 'calendar' (a month grid on one date column, `date`).
    case 'notion-db':
    case 'checklist':
    case 'notion-tasks': {
      const out: Record<string, unknown> = {};
      if (type === 'notion-db' && (raw.view === 'list' || raw.view === 'calendar')) out.view = raw.view;
      if (out.view === 'calendar' && typeof raw.date === 'string' && raw.date.trim() && raw.date.length <= 100) out.date = raw.date.trim();
      if (raw.db !== undefined && raw.db !== '') {
        const db = notionIdFrom(raw.db);
        if (!db) return null;
        out.db = db;
      }
      if (raw.ds !== undefined && raw.ds !== '') {
        const ds = notionIdFrom(raw.ds);
        if (!ds) return null;
        out.ds = ds;
      }
      // show/sort are list-view knobs; the table view ignores them.
      if (out.view === 'list' || type !== 'notion-db') {
        if (raw.show === 'all' || raw.show === 'done') out.show = raw.show;
        if (raw.sort === 'created' || raw.sort === 'edited' || raw.sort === 'title') out.sort = raw.sort;
      }
      const limit = Math.round(Number(raw.limit));
      if (limit > 0 && limit < CHECKLIST_PAGE_SIZE) out.limit = limit;
      const cols = nameList(raw.props, 8);
      if (cols.length) out.props = cols;
      return out;
    }
    // One look ward; `rule` draws a labelled line across it (the old separator).
    case 'spacer': {
      const effect = (WARD_FX as readonly unknown[]).includes(raw.effect) ? (raw.effect as WardFx) : 'none';
      const out: Record<string, unknown> = { effect };
      if (effect === 'scene') out.scene = (SCENE_IDS as string[]).includes(raw.scene as string) ? (raw.scene as SceneId) : 'aurora';
      if (raw.rule === true) out.rule = true;
      return out;
    }
    case 'agent': {
      // Never null — bad values fall back to defaults (the ward always works).
      const out: Record<string, unknown> = {
        provider: isAgentProvider(raw.provider) ? raw.provider : 'default',
        tools: raw.tools === 'read-only' ? 'read-only' : 'all',
        approvals: raw.approvals === 'all' || raw.approvals === 'off' ? raw.approvals : 'outbound',
      };
      if (out.provider === 'compat' && typeof raw.endpoint === 'string' && ENDPOINT_NAME_RE.test(raw.endpoint)) out.endpoint = raw.endpoint;
      if (typeof raw.model === 'string') {
        const model = raw.model.trim();
        if (model && model.length <= 100) out.model = model;
      }
      if (typeof raw.persona === 'string' && raw.persona.trim() && raw.persona.length <= 2000) out.persona = raw.persona;
      if ((AGENT_EFFORTS as readonly string[]).includes(raw.effort as string)) out.effort = raw.effort;
      // Unattended runs per hour (agent.ask, agent-to-agent, chat bots) — the
      // loop brake; 0 = no cap. Tool rounds per turn; absent = the account
      // setting, 0 = no cap. Both parsed from text: an EMPTY field is absent,
      // never 0 — a cleared box must not uncap anything.
      const whole = (v: unknown, max: number): number | undefined => {
        if (v === undefined || v === null || v === '') return undefined;
        const n = Math.floor(Number(v));
        return Number.isFinite(n) && n >= 0 && n <= max ? n : undefined;
      };
      const cap = whole(raw.headlessCap, 1000);
      if (cap !== undefined && cap !== 6) out.headlessCap = cap;
      const rounds = whole(raw.rounds, 500);
      if (rounds !== undefined) out.rounds = rounds;
      return out;
    }
    default:
      // Types without config get none; stray client config is dropped, not fatal.
      return {};
  }
}

/** The trust boundary for layout JSON. Returns a rebuilt layout or null. */
/** `pages` heals wards against the page list (a vanished page → the first
 *  page, and the first page is always written as absent). Without it every
 *  well-formed `page` is kept as-is — for callers that don't have the list
 *  (the agent's mutateLayout, the boot rewrite, the client's SSE echo). */
export function validateLayout(raw: unknown, pages?: PageDef[]): WardInstance[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_WARDS) return null;
  const seen = new Set<string>();
  const seenTypes = new Set<string>();
  const out: WardInstance[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const { i, type, size, title, hidden, theme, font, config, in: parent, page, device } = item as Record<string, unknown>;
    if (typeof i !== 'string' || !ID_RE.test(i) || seen.has(i)) return null;
    if (typeof type !== 'string' || !CATALOG[type]) return null;
    const placement = typeof device === 'string' && /^[a-f0-9-]{36}$/.test(device) ? device : '';
    const uniqueType = `${placement}:${type}`;
    if (!CATALOG[type].multi && seenTypes.has(uniqueType)) return null;
    if (typeof size !== 'string' || !SIZE_RE.test(size)) return null;
    seen.add(i);
    seenTypes.add(uniqueType);
    const w: WardInstance = { i, type, size: fitWardSize(type, size as WardSize) };
    if (typeof device === 'string' && /^[a-f0-9-]{36}$/.test(device)) w.device = device;
    if (typeof title === 'string' && title.trim() && title.length <= 60) w.title = title.trim();
    if (hidden === true) w.hidden = true;
    if (typeof parent === 'string' && ID_RE.test(parent)) w.in = parent;
    if (typeof page === 'string' && ID_RE.test(page)) w.page = page;
    // Anything unreadable in an override is dropped, not rejected: a layout is
    // not worth refusing over a colour. `font` is where a ward's typeface used
    // to live on its own — fold a stored one in rather than lose it.
    const tt = normalizeWardTheme({
      ...(typeof font === 'string' && font in FONTS ? { font } : {}),
      ...(typeof theme === 'object' && theme !== null ? theme : {}),
    });
    if (tt) w.theme = tt;
    const cfg = validateConfig(type, typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {});
    if (cfg === null) return null;
    if (CATALOG[type].configurable || type === 'shared') w.config = cfg;
    out.push(w);
  }
  // Nesting is one level: a pointer at anything but a container (a removed
  // one, a plain ward, a container itself) lifts the ward to the top level.
  const groups = new Set(out.filter((w) => w.type === 'container').map((w) => w.i));
  for (const w of out) if (w.in !== undefined && (w.type === 'container' || !groups.has(w.in))) delete w.in;
  // Pages: a nested ward follows its group; a ward on a page that no longer
  // exists self-heals to the first page, which is what an absent `page` means.
  const known = pages && new Set(pages.map((p) => p.id));
  for (const w of out) {
    if (w.in !== undefined || (known && w.page !== undefined && (!known.has(w.page) || w.page === pages![0]!.id))) delete w.page;
  }
  const perPage = new Map<string, number>();
  for (const w of out) {
    const k = pageOf(w, pages ?? DEFAULT_PAGES, out);
    perPage.set(k, (perPage.get(k) ?? 0) + 1);
  }
  for (const n of perPage.values()) if (n > MAX_WARDS_PER_PAGE) return null;
  return out;
}
