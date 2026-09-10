// Logic contract, shared by server (engine execution, graph validation) and
// client (wire editor UI, ward renderers). Pure data + functions only — this
// module must never import db.ts; it ships to the browser.
//
// Extension point: a new trigger/condition/action = one spec entry here + one
// exec entry in logic-engine.ts (CONDITION_EXECS / ACTION_EXECS) — the editor,
// validator and wire pills all render from these specs, nothing is hardcoded.

import { CHECKLIST_PAGE_SIZE, MAIL_ACCOUNTS, TASK_WARDS, httpUrl, notionIdFrom, type WardInstance } from './wards.ts';
import type { IconId } from './icon-names.ts';
import { TARGETS } from './targets.ts';
import { COMMS_INBOUND, COMMS_TYPES } from './comms/types.ts';

// ---------------------------------------------------------------- registries

export type ParamKind =
  | 'text'
  | 'template' // text; the editor adds click-to-insert {{var}} chips
  | 'ward'
  | 'channel'
  | 'seconds'
  | 'minutes'
  | 'percent'
  | 'count' // plain integer 0..10000 (0 is meaningful: "due within 0 days"; 10000 spans latency ms)
  | 'degrees' // integer °F, -100..150 — NJ winters go below zero
  | 'time' // local wall clock, 24h "HH:MM"
  | 'email-list'
  | 'notion-id'
  | 'url'
  | 'select';

export interface ParamSpec {
  kind: ParamKind;
  required?: boolean;
  /** Length cap for text/template. */
  max?: number;
  /** kind 'ward': required CATALOG type(s) of the referenced ward. */
  wardType?: string | string[];
  /** kind 'select'. */
  options?: string[];
  /** Trigger params only: the fired event must carry an equal value for this
   *  key (absent on the edge = wildcard). Non-filter params are config the
   *  watcher itself consumes (e.g. `every.minutes`). */
  filter?: boolean;
}

export interface TriggerSpec {
  label: string;
  icon: IconId;
  /** Ward type(s) the source ward may have. */
  wardType: string | string[];
  params: Record<string, ParamSpec>;
  /** Extra semantic check after generic param validation (pure). */
  verify?: (params: Record<string, unknown>) => boolean;
}

/** Ward types a trigger or action can anchor to. */
export const wardTypes = (t: { wardType?: string | string[] }): string[] =>
  t.wardType === undefined ? [] : Array.isArray(t.wardType) ? t.wardType : [t.wardType];

export interface ConditionSpec {
  label: string;
  icon: IconId;
  params: Record<string, ParamSpec>;
  /** Extra semantic check after generic param validation (pure). */
  verify?: (params: Record<string, unknown>) => boolean;
}

export interface ActionSpec {
  label: string;
  icon: IconId;
  /** 'client' actions execute in an open dashboard tab, delivered over SSE. */
  side: 'server' | 'client';
  adminOnly?: boolean;
  /** Set → edge.action.ward is required and must be a ward of one of these types. */
  wardType?: string | string[];
  params: Record<string, ParamSpec>;
  verify?: (params: Record<string, unknown>) => boolean;
}

export const WEATHER_KINDS = ['clear', 'clouds', 'fog', 'rain', 'snow', 'storm'] as const;

/** Count params above one page of a database read are unobservable — verify()
 *  gates them at save time. Defined in wards.ts, re-exported for callers. */
export { CHECKLIST_PAGE_SIZE };

export const TRIGGERS: Record<string, TriggerSpec> = {
  // Endogenous — events born inside the engine.
  // A routine's steps fire this with match.step; a plain timer fires it bare,
  // so a step-filtered edge never matches a plain timer (existing edges: wildcard).
  'timer-finished': { label: 'Timer finished', icon: 'timer', wardType: 'timer', params: { step: { kind: 'select', options: ['Focus', 'Break', 'Long break'], filter: true } } },
  // Endogenous: the button route fires it; the ward IS the switch.
  'button-pressed': { label: 'Button pressed', icon: 'button', wardType: 'button', params: {} },
  'routine-finished': { label: 'Routine finished', icon: 'timer', wardType: 'timer', params: {} },
  'packet-arrived': { label: 'Packet arrived', icon: 'mail', wardType: 'flow', params: { channel: { kind: 'channel', filter: true } } },
  'packet-passed': { label: 'Packet passed along', icon: 'folder-out', wardType: 'flow', params: { channel: { kind: 'channel', filter: true } } },
  // Exogenous — watchers in logic-engine.ts poll external state on the engine
  // tick and fire on transitions (see WATCHERS there; one entry each side).
  every: { label: 'Every N minutes', icon: 'reset', wardType: ['timer', 'note'], params: { minutes: { kind: 'minutes', required: true } } },
  'service-status': {
    label: 'Service goes up/down',
    icon: 'radio',
    wardType: 'service-group',
    params: { to: { kind: 'select', options: ['down', 'up'], filter: true } },
  },
  // One trigger for every mailbox: the account is a filter (absent = any).
  'mail-arrived': { label: 'New mail arrives', icon: 'mail', wardType: 'mail', params: { account: { kind: 'select', options: [...MAIL_ACCOUNTS], filter: true } } },
  // The chat wards (lib/comms): the connection manager fires these itself
  // from the live feed, so none has a watcher. `channel` is matched against
  // ev.channel (kind text — Slack ids and phone numbers are not slugs);
  // `from` is the sender's id, never the display name; mention=yes is also
  // every DM / private chat, i.e. "addressed to the bot".
  'message-arrived': {
    label: 'Message arrives',
    icon: 'sms',
    wardType: [...COMMS_INBOUND],
    params: {
      channel: { kind: 'text', max: 64, filter: true },
      from: { kind: 'text', max: 64, filter: true },
      mention: { kind: 'select', options: ['yes', 'no'], filter: true },
    },
  },
  'reaction-added': {
    label: 'Reaction added',
    icon: 'check',
    wardType: [...COMMS_INBOUND],
    params: { channel: { kind: 'text', max: 64, filter: true }, emoji: { kind: 'text', max: 64, filter: true } },
  },
  'member-joined': { label: 'Member joined', icon: 'teams', wardType: [...COMMS_INBOUND], params: {} },
  'weather-turned': {
    label: 'Weather turns',
    icon: 'sun-cloud',
    wardType: 'weather',
    params: { to: { kind: 'select', options: [...WEATHER_KINDS], filter: true } },
  },
  // Kept for graphs saved before the omnibus notion-item trigger — a lenient
  // read silently drops edges whose trigger id vanished. Same cache, costs nothing.
  'checklist-done': { label: 'Item checked off', icon: 'check', wardType: 'checklist', params: {} },
  // Endogenous: the agent ward fires this itself when a turn lands (chat or
  // unattended), so it needs no watcher.
  'agent-replied': {
    label: 'Agent replied',
    icon: 'bot',
    wardType: 'agent',
    // The reply is a value: filter by what prompted it, then route
    // {{agent.reply}} onward (a packet, mail, a capture line, another ask).
    params: { source: { kind: 'select', options: ['chat', 'automation', 'wake', 'agent'], filter: true } },
  },
  'notion-item': {
    label: 'Item added / changed / removed',
    icon: 'tasks',
    wardType: [...TASK_WARDS],
    params: {
      what: { kind: 'select', filter: true, options: ['added', 'checked', 'unchecked', 'renamed', 'changed', 'removed'] },
    },
  },
  'notion-item-due': {
    label: 'Item due / overdue',
    icon: 'calendar',
    wardType: [...TASK_WARDS],
    params: { when: { kind: 'select', filter: true, options: ['today', 'tomorrow', 'overdue'] } },
  },
  // The page wards' omnibus trigger: one watcher per ward covers the page's
  // own edits, any property change, and new comments.
  'notion-page-changed': {
    label: 'Page edited / property / comment',
    icon: 'page',
    wardType: 'notion-page',
    params: {
      what: { kind: 'select', filter: true, options: ['edited', 'property', 'comment'] },
      prop: { kind: 'text', max: 100, filter: true },
    },
  },
  'notion-page-touched': {
    label: 'Any page created / edited',
    icon: 'history',
    wardType: 'notion-recent',
    params: { what: { kind: 'select', filter: true, options: ['created', 'edited'] } },
  },
  'notion-capture-appended': { label: 'Capture page appended', icon: 'pen', wardType: 'notion-page', params: {} },
  // The notebook's endogenous events (lib/note-events.ts → logic-engine): a
  // note created in it, a document saved (one firing per note per minute),
  // tags added (one firing per tag — `tag` filters on it), a section change
  // (`section` filters on the section's TITLE). Every firing carries note.*
  // vars including the note's text, so a leyline can carry a note's content on.
  'note-created': { label: 'Note created', icon: 'notebook', wardType: 'notebook', params: {} },
  'note-saved': { label: 'Note saved', icon: 'pen', wardType: 'notebook', params: {} },
  'note-tagged': { label: 'Note tagged', icon: 'tag', wardType: 'notebook', params: { tag: { kind: 'text', max: 32, filter: true } }, verify: (p) => { if (typeof p.tag === 'string') p.tag = p.tag.trim().toLowerCase(); return true; } },
  'note-moved': { label: 'Note moved to a section', icon: 'folder', wardType: 'notebook', params: { section: { kind: 'text', max: 60, filter: true } } },
  'notion-count-crossed': {
    label: 'Item count crosses N',
    icon: 'list-ol',
    wardType: [...TASK_WARDS],
    params: {
      n: { kind: 'count', required: true },
      only: { kind: 'select', required: true, options: ['open', 'done', 'all'] },
      to: { kind: 'select', filter: true, options: ['above', 'below'] },
    },
    // Strictly below the page size: "above 50" can never be observed on a
    // 50-row read, so it would validate and then never fire.
    verify: (p) => Number(p.n) < CHECKLIST_PAGE_SIZE,
  },
  // Endogenous: fired from the complete paths (UI + flow.complete action).
  'packet-completed': { label: 'Packet completed', icon: 'check', wardType: 'flow', params: { channel: { kind: 'channel', filter: true } } },
  'packet-idle': {
    label: 'Packet waiting too long',
    icon: 'timer',
    wardType: 'flow',
    params: { minutes: { kind: 'minutes', required: true }, channel: { kind: 'channel', filter: true } },
  },
  'at-time-of-day': {
    // The cron ward idiom: hang daily rules off a note ward (hide it and the
    // schedule costs no grid slot), or off the memory ward (its nightly
    // reflection). Timers stay valid for graphs saved before.
    label: 'Every day at',
    icon: 'timer',
    wardType: ['note', 'timer', 'memory'],
    params: { at: { kind: 'time', required: true } },
  },
  'host-crossed': {
    label: 'Host metric crosses',
    icon: 'chart',
    wardType: 'service-group',
    params: {
      metric: { kind: 'select', required: true, options: ['cpu', 'mem', 'disk'] },
      pct: { kind: 'percent', required: true },
      to: { kind: 'select', options: ['above', 'below'], filter: true },
    },
  },
  'service-slow': {
    label: 'Service latency crosses',
    icon: 'timer',
    wardType: 'service-group',
    params: { ms: { kind: 'count', required: true }, to: { kind: 'select', options: ['above', 'below'], filter: true } },
  },
  // A pm2 restart count going up — the crash loop pm2 still reports as
  // online. Anchors on a single-service ward (soleService in the engine).
  'service-restarted': { label: 'Process restarted', icon: 'reset', wardType: 'service-group', params: {} },
  // Fires once per user on the first tick after a server (re)start; the
  // watcher's state is a settings row, since memory is empty on every boot.
  'deploy-landed': { label: 'Server restarted', icon: 'send', wardType: 'service-group', params: {} },
  'service-down-for': {
    label: 'Service down for N minutes',
    icon: 'incident',
    wardType: 'service-group',
    params: { minutes: { kind: 'minutes', required: true } },
  },
  'group-status': {
    label: 'Any service in group up/down',
    icon: 'folders',
    wardType: 'service-group',
    params: { to: { kind: 'select', options: ['down', 'up'], filter: true } },
  },
  'event-starting-soon': {
    label: 'Event starts soon',
    icon: 'calendar',
    wardType: ['calendar', 'next-up'],
    params: {
      withinMinutes: { kind: 'minutes', required: true },
      calendar: { kind: 'select', options: ['google', 'microsoft', 'icloud', 'notion'], filter: true },
    },
  },
  'event-added': {
    label: 'Event added to calendar',
    icon: 'calendar',
    wardType: ['calendar', 'next-up'],
    params: { calendar: { kind: 'select', options: ['google', 'microsoft', 'icloud', 'notion'], filter: true } },
  },
  'weather-daily': {
    // The morning briefing: fires with the full weather var set in scope.
    label: 'Daily weather report at',
    icon: 'weather',
    wardType: 'weather',
    params: { at: { kind: 'time', required: true } },
  },
  'temp-crossed': {
    label: 'Temperature crosses',
    icon: 'weather',
    wardType: 'weather',
    params: { tempF: { kind: 'degrees', required: true }, to: { kind: 'select', options: ['above', 'below'], filter: true } },
  },
};

const PACKETY = ['packet-arrived', 'packet-passed', 'packet-idle', 'packet-completed'];
const NOTEY = ['note-created', 'note-saved', 'note-tagged', 'note-moved'];
const MAILY = ['mail-arrived'];
const WEATHERY = ['weather-turned', 'weather-daily', 'temp-crossed'];
const EVENTY = ['event-starting-soon', 'event-added'];
const NOTION_ITEMY = ['notion-item', 'notion-item-due', 'checklist-done'];
const PAGEY = ['notion-page-touched', 'notion-capture-appended', 'notion-page-changed'];
const CHATTY = ['message-arrived', 'reaction-added'];

/** Vars available to `template` params; the editor renders these as chips,
 *  filtered by the edge's trigger (`triggers` absent = always shown). Vars
 *  exist only when the firing carries them (missing keys render '').
 *  NOTE: declared before CONDITIONS — var-contains builds its options from it. */
export const TEMPLATE_VARS: { key: string; label: string; triggers?: string[] }[] = [
  { key: 'trigger.ward', label: 'Source ward id' },
  { key: 'trigger.wardTitle', label: 'Source ward name' },
  { key: 'now', label: 'Time (ISO)' },
  { key: 'now.time', label: 'Time (HH:MM)' },
  { key: 'now.date', label: 'Date (YYYY-MM-DD)' },
  { key: 'now.day', label: 'Day of week' },
  { key: 'packet.text', label: 'Packet text', triggers: PACKETY },
  { key: 'packet.channel', label: 'Packet channel', triggers: PACKETY },
  { key: 'packet.id', label: 'Packet id', triggers: PACKETY },
  { key: 'packet.ward', label: 'Packet ward', triggers: PACKETY },
  { key: 'packet.ageMinutes', label: 'Packet age (min)', triggers: PACKETY },
  { key: 'mail.from', label: 'Mail sender', triggers: MAILY },
  { key: 'mail.fromAddress', label: 'Mail sender address', triggers: MAILY },
  { key: 'mail.subject', label: 'Mail subject', triggers: MAILY },
  { key: 'mail.snippet', label: 'Mail snippet', triggers: MAILY },
  { key: 'mail.attachments', label: 'Has attachments', triggers: MAILY },
  { key: 'mail.account', label: 'Mail account', triggers: MAILY },
  { key: 'service.label', label: 'Service name', triggers: ['service-status', 'service-slow', 'service-down-for', 'group-status', 'service-restarted'] },
  { key: 'service.state', label: 'Service state', triggers: ['service-status', 'service-slow', 'service-down-for', 'group-status', 'service-restarted'] },
  { key: 'service.restarts', label: 'Restart count', triggers: ['service-restarted'] },
  { key: 'service.restartsDelta', label: 'Restarts since last check', triggers: ['service-restarted'] },
  { key: 'build.stamp', label: 'Build', triggers: ['deploy-landed'] },
  { key: 'service.id', label: 'Service id', triggers: ['group-status'] },
  { key: 'service.latencyMs', label: 'Latency (ms)', triggers: ['service-slow'] },
  { key: 'service.downMinutes', label: 'Down for (min)', triggers: ['service-down-for'] },
  { key: 'host.metric', label: 'Host metric', triggers: ['host-crossed'] },
  { key: 'host.pct', label: 'Host %', triggers: ['host-crossed'] },
  { key: 'host.side', label: 'Above/below', triggers: ['host-crossed'] },
  { key: 'weather.condition', label: 'Weather condition', triggers: WEATHERY },
  { key: 'weather.tempF', label: 'Temperature °F', triggers: WEATHERY },
  { key: 'weather.windMph', label: 'Wind mph', triggers: WEATHERY },
  { key: 'weather.humidity', label: 'Humidity %', triggers: WEATHERY },
  { key: 'weather.hiF', label: "Today's high", triggers: WEATHERY },
  { key: 'weather.loF', label: "Today's low", triggers: WEATHERY },
  { key: 'weather.precipPct', label: 'Rain chance %', triggers: WEATHERY },
  { key: 'weather.tomorrowHi', label: "Tomorrow's high", triggers: WEATHERY },
  { key: 'weather.tomorrowCondition', label: 'Tomorrow', triggers: WEATHERY },
  { key: 'weather.tomorrowPrecipPct', label: 'Tomorrow rain %', triggers: WEATHERY },
  { key: 'event.title', label: 'Event title', triggers: EVENTY },
  { key: 'event.startTime', label: 'Event time', triggers: EVENTY },
  { key: 'event.location', label: 'Event location', triggers: EVENTY },
  { key: 'event.calendar', label: 'Which calendar', triggers: EVENTY },
  { key: 'event.in', label: 'Starts in (min)', triggers: ['event-starting-soon'] },
  { key: 'event.join', label: 'Join link', triggers: EVENTY },
  { key: 'routine.done', label: 'Step just finished', triggers: ['timer-finished', 'routine-finished'] },
  { key: 'routine.step', label: 'Next step', triggers: ['timer-finished'] },
  { key: 'routine.minutes', label: 'Next step (min)', triggers: ['timer-finished'] },
  { key: 'routine.index', label: 'Step number', triggers: ['timer-finished'] },
  { key: 'item.title', label: 'Item title', triggers: NOTION_ITEMY },
  { key: 'item.what', label: 'What happened', triggers: ['notion-item', 'notion-item-due', 'notion-page-touched', 'notion-count-crossed', 'notion-page-changed'] },
  { key: 'item.due', label: 'Item due date', triggers: NOTION_ITEMY },
  { key: 'item.url', label: 'Item link', triggers: NOTION_ITEMY },
  { key: 'item.id', label: 'Item page id', triggers: NOTION_ITEMY },
  { key: 'item.titleWas', label: 'Previous title', triggers: ['notion-item'] },
  { key: 'page.title', label: 'Page title', triggers: PAGEY },
  { key: 'page.url', label: 'Page link', triggers: PAGEY },
  { key: 'page.id', label: 'Page id', triggers: PAGEY },
  { key: 'capture.text', label: 'Captured text', triggers: ['notion-capture-appended'] },
  { key: 'note.id', label: 'Note id', triggers: NOTEY },
  { key: 'note.title', label: 'Note title', triggers: NOTEY },
  { key: 'note.text', label: 'Note text', triggers: NOTEY },
  { key: 'note.section', label: 'Note section', triggers: NOTEY },
  { key: 'note.tags', label: 'Note tags', triggers: NOTEY },
  { key: 'note.tag', label: 'Tag added', triggers: ['note-tagged'] },
  { key: 'note.notebook', label: 'Notebook title', triggers: NOTEY },
  { key: 'prop.name', label: 'Property name', triggers: ['notion-page-changed'] },
  { key: 'prop.value', label: 'Property value', triggers: ['notion-page-changed'] },
  { key: 'prop.was', label: 'Previous value', triggers: ['notion-page-changed'] },
  { key: 'comment.text', label: 'Comment text', triggers: ['notion-page-changed'] },
  { key: 'comment.author', label: 'Comment author', triggers: ['notion-page-changed'] },
  { key: 'count.n', label: 'Item count', triggers: ['notion-count-crossed'] },
  { key: 'agent.reply', label: 'Agent reply', triggers: ['agent-replied'] },
  { key: 'agent.source', label: 'What prompted it', triggers: ['agent-replied'] },
  { key: 'msg.text', label: 'Message text', triggers: CHATTY },
  { key: 'msg.from', label: 'Sender name', triggers: CHATTY },
  { key: 'msg.fromId', label: 'Sender id', triggers: CHATTY },
  { key: 'msg.channel', label: 'Channel id', triggers: CHATTY },
  { key: 'msg.channelName', label: 'Channel name', triggers: CHATTY },
  { key: 'msg.id', label: 'Message id', triggers: CHATTY },
  { key: 'msg.attachments', label: 'Attachment names', triggers: CHATTY },
  { key: 'reaction.emoji', label: 'Emoji', triggers: ['reaction-added'] },
  { key: 'reaction.from', label: 'Who reacted', triggers: ['reaction-added'] },
  { key: 'member.name', label: 'New member', triggers: ['member-joined'] },
  { key: 'member.id', label: 'New member id', triggers: ['member-joined'] },
];

export const CONDITIONS: Record<string, ConditionSpec> = {
  'notion-task-done': {
    label: 'Notion task is done',
    icon: 'check',
    params: { pageId: { kind: 'notion-id', required: true } },
  },
  'packet-text-matches': {
    // Case-insensitive substring ONLY. No user-supplied RegExp: catastrophic
    // backtracking would hand the single shared event loop to whoever typed
    // the pattern (a safe engine like RE2 could lift this later).
    label: 'Packet text contains',
    icon: 'search',
    params: { pattern: { kind: 'text', required: true, max: 100 } },
  },
  'host-above': {
    label: 'Host metric above/below',
    icon: 'host',
    params: {
      metric: { kind: 'select', required: true, options: ['cpu', 'mem', 'disk'] },
      // OPTIONAL (absent = above): required would silently drop shipped edges.
      cmp: { kind: 'select', options: ['above', 'below'] },
      pct: { kind: 'percent', required: true },
    },
  },
  'service-is': {
    label: 'Service state is',
    icon: 'radio',
    params: {
      service: { kind: 'select', required: true, get options() { return TARGETS.map((t) => t.id); } },
      state: { kind: 'select', required: true, options: ['up', 'down'] },
    },
  },
  'weather-is': {
    label: 'Weather is',
    icon: 'weather',
    params: { kind: { kind: 'select', required: true, options: [...WEATHER_KINDS] } },
  },
  'template-matches': {
    // The universal "…and it contains X" gate: filter params only test
    // equality, this tests any template against any trigger's vars.
    // Substring only — same ReDoS reasoning as packet-text-matches.
    label: 'Text contains',
    icon: 'search',
    params: { text: { kind: 'template', required: true, max: 500 }, pattern: { kind: 'text', required: true, max: 100 } },
  },
  'notion-prop-is': {
    label: 'Notion property is…',
    icon: 'tag',
    params: {
      pageId: { kind: 'notion-id', required: true },
      prop: { kind: 'text', required: true, max: 100 },
      op: { kind: 'select', required: true, options: ['equals', 'contains', 'is set', 'is empty'] },
      value: { kind: 'template', max: 200 },
    },
    // equals/contains without something to compare against always fails.
    verify: (p) => p.op === 'is set' || p.op === 'is empty' || !!String(p.value ?? '').trim(),
  },
  'notion-count': {
    label: 'Database count is',
    icon: 'list-ol',
    params: {
      db: { kind: 'notion-id', required: true },
      only: { kind: 'select', required: true, options: ['open', 'done', 'all'] },
      cmp: { kind: 'select', required: true, options: ['above', 'below'] },
      n: { kind: 'count', required: true },
    },
    verify: (p) => Number(p.n) < CHECKLIST_PAGE_SIZE, // ≥50 "above" is never observable in one page
  },
  'notion-task-due-within': {
    label: 'Notion task due within',
    icon: 'calendar',
    params: { pageId: { kind: 'notion-id', required: true }, days: { kind: 'count', required: true } },
  },
  'var-contains': {
    // The generic "…and it contains X" over any trigger's vars — replaces a
    // family of would-be per-trigger conditions. Substring only (ReDoS).
    label: 'Trigger value contains',
    icon: 'note',
    params: {
      key: { kind: 'select', required: true, options: TEMPLATE_VARS.map((v) => v.key) },
      mode: { kind: 'select', required: true, options: ['contains', 'not-contains'] },
      text: { kind: 'text', required: true, max: 100 },
    },
  },
  'time-between': {
    // THE quiet-hours guard, expressed positively: 07:00 → 22:00 on the noisy
    // edge. Wraps past midnight when from > to.
    label: 'Time is between',
    icon: 'timer',
    params: { from: { kind: 'time', required: true }, to: { kind: 'time', required: true } },
  },
  'day-is': {
    label: 'Day of week is',
    icon: 'calendar',
    params: { days: { kind: 'select', required: true, options: ['weekday', 'weekend', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } },
  },
  'calendar-busy-now': {
    label: 'Calendar is busy/free now',
    icon: 'calendar',
    params: { state: { kind: 'select', required: true, options: ['busy', 'free'] } },
  },
  'calendar-free-for': {
    label: 'Calendar clear for next',
    icon: 'calendar',
    params: { minutes: { kind: 'minutes', required: true } },
  },
  'rain-chance-above': {
    label: 'Rain chance above',
    icon: 'weather',
    params: { day: { kind: 'select', required: true, options: ['today', 'tomorrow'] }, pct: { kind: 'percent', required: true } },
  },
  'rain-within': {
    label: 'Rain within N hours',
    icon: 'weather',
    params: { hours: { kind: 'count', required: true }, pct: { kind: 'percent', required: true } },
  },
  'service-flapped': {
    // Durable: reads status_history, survives restarts. The pattern to copy
    // instead of in-memory fire counters.
    label: 'Service flapped recently',
    icon: 'chart',
    params: {
      service: { kind: 'select', required: true, get options() { return TARGETS.map((t) => t.id); } },
      hours: { kind: 'count', required: true },
      times: { kind: 'count', required: true },
    },
  },
  'service-uptime-below': {
    label: 'Service uptime below %',
    icon: 'chart',
    params: {
      service: { kind: 'select', required: true, get options() { return TARGETS.map((t) => t.id); } },
      hours: { kind: 'count', required: true },
      pct: { kind: 'percent', required: true },
    },
  },
  // A yes/no gate answered by a model, from an agent ward's provider — composes
  // with every action, not only the sorter.
  'model-says': {
    label: 'Rime says yes to',
    icon: 'bot',
    params: { agent: { kind: 'ward', required: true, wardType: 'agent' }, question: { kind: 'template', required: true, max: 500 } },
  },
  'packet-count-above': {
    label: 'Waiting packets above',
    icon: 'skill',
    params: { ward: { kind: 'ward', required: true, wardType: 'flow' }, count: { kind: 'count', required: true } },
  },
  'packet-text-unique': {
    // The dedupe primitive: packets are rows, so flow wards are the system's
    // memory — "don't tell me twice" without any new persistence.
    label: 'Packet text not seen recently',
    icon: 'button',
    params: { hours: { kind: 'count', required: true } },
  },
  'mail-unread-above': {
    label: 'Unread mail above',
    icon: 'mail',
    params: {
      account: { kind: 'select', required: true, options: [...MAIL_ACCOUNTS] },
      count: { kind: 'count', required: true },
    },
  },
};

export const ACTIONS: Record<string, ActionSpec> = {
  'timer.start': {
    label: 'Start timer',
    icon: 'right',
    side: 'server',
    wardType: 'timer',
    params: { durationSec: { kind: 'seconds' } },
  },
  'timer.stop': { label: 'Pause timer', icon: 'stop', side: 'server', wardType: 'timer', params: {} },
  'timer.reset': { label: 'Reset timer', icon: 'reset', side: 'server', wardType: 'timer', params: {} },
  'flow.emit': {
    label: 'Emit packet',
    icon: 'flow',
    side: 'server',
    wardType: 'flow',
    params: { channel: { kind: 'channel', required: true }, text: { kind: 'template', required: true, max: 500 } },
  },
  'flow.move': {
    label: 'Move this packet',
    icon: 'right',
    side: 'server',
    wardType: 'flow',
    params: { channel: { kind: 'channel', required: true } },
  },
  'flow.pass-waiting': { label: 'Pass all waiting packets', icon: 'folder-out', side: 'server', wardType: 'flow', params: {} },
  'notion.capture-append': {
    label: 'Append to a Notion page',
    icon: 'pen',
    side: 'server',
    // pageId absent → the configured capture page; type absent → a paragraph
    params: {
      text: { kind: 'template', required: true, max: 2000 },
      pageId: { kind: 'notion-id' },
      type: { kind: 'select', options: ['paragraph', 'heading_2', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'callout', 'code', 'divider'] },
    },
  },
  'notion.set-prop': {
    label: 'Set a Notion property',
    icon: 'tag',
    side: 'server',
    // Any writable column: text, number, date, select, status, multi-select,
    // checkbox, url/email/phone. The value is coerced to the column's type.
    params: {
      pageId: { kind: 'notion-id', required: true },
      prop: { kind: 'text', required: true, max: 100 },
      value: { kind: 'template', max: 500 },
    },
  },
  'notion.add-comment': {
    label: 'Comment on a Notion page',
    icon: 'sms',
    side: 'server',
    params: { pageId: { kind: 'notion-id', required: true }, text: { kind: 'template', required: true, max: 2000 } },
  },
  'notion.check-task': {
    label: 'Set a Notion checkbox',
    icon: 'check',
    side: 'server',
    params: { pageId: { kind: 'notion-id', required: true }, checked: { kind: 'select', options: ['yes', 'no'] } },
  },
  'checklist.add': {
    label: 'Add checklist item',
    icon: 'plus',
    side: 'server',
    wardType: [...TASK_WARDS],
    // due: YYYY-MM-DD, "today", or "+Nd"
    params: { title: { kind: 'template', required: true, max: 200 }, due: { kind: 'template', max: 20 } },
  },
  'checklist.set': {
    label: 'Check an item by title',
    icon: 'check',
    side: 'server',
    wardType: [...TASK_WARDS],
    params: { title: { kind: 'template', required: true, max: 200 }, checked: { kind: 'select', options: ['yes', 'no'] } },
  },
  'checklist.archive-done': { label: 'Archive checked items', icon: 'archive', side: 'server', wardType: [...TASK_WARDS], params: {} },
  'notion.create-page': {
    label: 'Create a Notion page',
    icon: 'page',
    side: 'server',
    // db = the database (or data source) to add a row to; ds picks one list
    // inside a multi-list database. Only a title column is required.
    params: {
      db: { kind: 'notion-id', required: true },
      ds: { kind: 'notion-id' },
      title: { kind: 'template', required: true, max: 200 },
      due: { kind: 'template', max: 20 },
    },
  },
  'notion.archive-page': {
    label: 'Archive a Notion page',
    icon: 'database',
    side: 'server',
    params: { pageId: { kind: 'notion-id', required: true } },
  },
  // The notebook as a sink: notes are named by title (this notebook's, case-
  // insensitive, exact first then prefix) or by id; sections by title.
  'note.create': {
    label: 'Create a note',
    icon: 'notebook',
    side: 'server',
    wardType: 'notebook',
    params: {
      title: { kind: 'template', required: true, max: 120 },
      text: { kind: 'template', max: 4000 },
      section: { kind: 'text', max: 60 },
      tags: { kind: 'text', max: 200 },
      // A template note's title: its text/tags/properties seed the new note (the text above is appended).
      from: { kind: 'text', max: 120 },
    },
  },
  'note.append': {
    label: 'Append to a note',
    icon: 'pen',
    side: 'server',
    wardType: 'notebook',
    params: { note: { kind: 'template', required: true, max: 120 }, text: { kind: 'template', required: true, max: 4000 } },
  },
  'note.set': {
    label: 'Change a note',
    icon: 'tag',
    side: 'server',
    wardType: 'notebook',
    // Blank = leave alone. tags replaces the whole list; section '' unfiles.
    params: {
      note: { kind: 'template', required: true, max: 120 },
      title: { kind: 'template', max: 120 },
      section: { kind: 'text', max: 60 },
      tags: { kind: 'template', max: 200 },
      pinned: { kind: 'select', options: ['yes', 'no'] },
      archived: { kind: 'select', options: ['yes', 'no'] },
    },
  },
  'note.trash': {
    label: 'Move a note to the trash',
    icon: 'trash',
    side: 'server',
    wardType: 'notebook',
    params: { note: { kind: 'template', required: true, max: 120 } },
  },
  'note.attach': {
    // Search the notebook and hand the hits to the packet in context: titles,
    // or titles + text (bounded) — what a later agent.ask / chat.send reads.
    label: 'Search notes and attach to the packet',
    icon: 'search',
    side: 'server',
    wardType: 'notebook',
    params: { q: { kind: 'template', required: true, max: 200 }, limit: { kind: 'count' }, what: { kind: 'select', options: ['titles', 'text'] } },
    verify: (p) => p.limit === undefined || p.limit === '' || (Number(p.limit) >= 1 && Number(p.limit) <= 5),
  },
  // Act on ctx.packet (no wardType — the packet knows its own ward): dock actions.
  'flow.complete': { label: 'Complete this packet', icon: 'check', side: 'server', params: {} },
  'flow.annotate': {
    label: 'Annotate this packet',
    icon: 'tag',
    side: 'server',
    params: { note: { kind: 'template', required: true, max: 200 } },
  },
  // The sorter: one model call sets the packet's channel from the list you
  // describe, and fires packet-passed with it — the channel filters route it on.
  'flow.sort': {
    label: 'Sort this packet (Rime)',
    icon: 'folders',
    side: 'server',
    params: { agent: { kind: 'ward', required: true, wardType: 'agent' }, channels: { kind: 'text', required: true, max: 500 } },
    verify: (p) => parseChannels(p.channels) !== null,
  },
  'notify.flash': {
    // Visible across the room on a parked tab; no permission prompt, no sound —
    // works inside quiet hours.
    label: 'Flash the tab title',
    icon: 'eye',
    side: 'client',
    params: { text: { kind: 'template', required: true, max: 60 } },
  },
  'speak.say': {
    label: 'Speak aloud',
    icon: 'sms',
    side: 'client',
    params: { text: { kind: 'template', required: true, max: 200 } },
  },
  'mail.send': {
    label: 'Send mail',
    icon: 'mail',
    side: 'server',
    params: {
      account: { kind: 'select', required: true, options: [...MAIL_ACCOUNTS] },
      // Recipients are fixed at rule-save time and validated here — never
      // templatable, so packet data can't redirect mail.
      to: { kind: 'email-list', required: true },
      subject: { kind: 'template', max: 200 },
      body: { kind: 'template', required: true, max: 4000 },
    },
  },
  'chat.send': {
    // Every chat ward. The destination is never a template: blank = the
    // channel the triggering message came from (msg.channel), else the
    // ward's default — a message can only ever be answered where it was sent.
    label: 'Send a chat message',
    icon: 'sms',
    side: 'server',
    wardType: [...COMMS_TYPES],
    params: {
      channel: { kind: 'text', max: 64 },
      text: { kind: 'template', required: true, max: 2000 },
      reply: { kind: 'select', options: ['plain', 'in-thread'] },
    },
  },
  'chat.react': {
    label: 'React to the message',
    icon: 'check',
    side: 'server',
    wardType: [...COMMS_INBOUND],
    params: { emoji: { kind: 'text', required: true, max: 64 } },
  },
  'audio.play': {
    label: 'Play a sound',
    icon: 'push',
    side: 'client',
    params: { sound: { kind: 'select', required: true, options: ['chime', 'alarm', 'ping'] } },
  },
  'youtube.play': {
    label: 'Play a YouTube video',
    icon: 'right',
    side: 'client',
    params: { videoId: { kind: 'text', required: true, max: 11 } },
    verify: (p) => /^[A-Za-z0-9_-]{11}$/.test(String(p.videoId ?? '')),
  },
  'agent.ask': {
    // The integrated-agent seam: run the ward's own agent unattended with a
    // prompt. Non-blocking — the exec queues onto the agent's per-ward chain
    // and returns; the per-ward hourly cap in agent/core.ts is the loop brake
    // (agent.ask → agent-replied → agent.ask is legal but bounded).
    label: 'Ask Rime',
    icon: 'bot',
    side: 'server',
    wardType: 'agent',
    params: {
      prompt: { kind: 'template', required: true, max: 2000 },
      // Where the answer goes, beyond the ward's own chat. Everything here is
      // optional: the reply is ALSO published as an 'agent-replied' firing, so
      // it can be piped anywhere the logic system reaches.
      deliverTo: { kind: 'ward', wardType: ['flow', ...COMMS_TYPES] },
      // Unset = toast (an unattended answer nobody is shown is the same as no
      // answer); 'silent' for rules that fire often enough to be noise.
      notify: { kind: 'select', options: ['toast', 'silent'] },
    },
  },
  'mcp.call': {
    // Any MCP server's tool, no model in the loop: the arguments are a JSON
    // template, the text of the result is the run record.
    label: 'Call an MCP tool',
    icon: 'mcp',
    side: 'server',
    wardType: 'mcp',
    params: { tool: { kind: 'text', required: true, max: 120 }, arguments: { kind: 'template', max: 2000 } },
  },
  'webhook.post': {
    // The "trigger an agent" seam: point it at anything that speaks JSON.
    label: 'POST to a webhook',
    icon: 'link',
    side: 'server',
    adminOnly: true,
    params: { url: { kind: 'url', required: true }, text: { kind: 'template', max: 2000 } },
  },
};


// --------------------------------------------------------------------- graph

export interface LogicEdge {
  /** [a-z0-9-]{1,32}, unique within the graph. */
  id: string;
  source: { ward: string; trigger: string; params: Record<string, unknown> };
  /** ≤ MAX_CONDITIONS, ANDed. */
  conditions: { type: string; params: Record<string, unknown> }[];
  /** One action per edge; fan-out = more edges. */
  action: { type: string; ward?: string; params: Record<string, unknown> };
  enabled: boolean;
}

export interface LogicGraph {
  edges: LogicEdge[];
}

export const MAX_EDGES = 64;
export const MAX_CONDITIONS = 5;
/** Total fire() invocations one trigger occurrence may cascade into
 *  (flow.emit/move/pass-waiting → packet events → …). A TOTAL budget, not a
 *  depth budget: branching actions like pass-waiting would otherwise fan out
 *  exponentially (N waiting packets ^ depth). */
export const MAX_FIRES = 64;

export const CHANNEL_RE = /^[a-z0-9-]{1,32}$/;

/** "billing: invoices; school: from .edu; noise" → [{id, desc}]; 2–12 entries, ids must pass CHANNEL_RE. */
export function parseChannels(s: unknown): { id: string; desc: string }[] | null {
  const out = String(s ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [id, ...rest] = p.split(':');
      return { id: id!.trim(), desc: rest.join(':').trim() };
    });
  return out.length >= 2 && out.length <= 12 && out.every((c) => CHANNEL_RE.test(c.id)) ? out : null;
}
const ID_RE = /^[a-z0-9-]{1,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A trigger occurrence the engine matches edges against. */
export interface TriggerEvent {
  type: string;
  ward: string;
  channel?: string;
  /** Values for `filter: true` trigger params (e.g. service-status `to`). */
  match?: Record<string, string>;
  /** Watcher-scheduled events aimed at ONE edge (e.g. `every`'s per-edge clock). */
  onlyEdge?: string;
}

export function edgeMatches(edge: LogicEdge, ev: TriggerEvent): boolean {
  if (!edge.enabled) return false;
  if (edge.source.trigger !== ev.type || edge.source.ward !== ev.ward) return false;
  if (ev.onlyEdge && ev.onlyEdge !== edge.id) return false;
  const specs = TRIGGERS[edge.source.trigger]?.params ?? {};
  for (const [key, spec] of Object.entries(specs)) {
    if (!spec.filter) continue;
    const want = edge.source.params[key];
    if (want === undefined) continue; // wildcard
    const got = key === 'channel' ? ev.channel : ev.match?.[key];
    if (want !== got) return false;
  }
  return true;
}

// ------------------------------------------------------------------ template

/** Single-pass {{key}} substitution against a FLAT string map. Substituted
 *  values are never re-scanned, so a var containing "{{x}}" stays inert; own
 *  keys only, so prototype names resolve to ''. Output clamped for safety —
 *  every sink is plain text (Notion JSON, RFC822, JSON SSE), never HTML. */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl
    .replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : ''
    )
    .slice(0, 8000);
}

// ---------------------------------------------------------------- validation

/** Record why something was refused and reject. The strict (write) path passes
 *  a sink so the caller can say what was actually wrong; the lenient (read)
 *  path passes nothing and this is just `return null`. */
const no = (why: string[] | undefined, msg: string): null => {
  why?.push(msg);
  return null;
};

function checkParam(spec: ParamSpec, v: unknown, wards: Map<string, WardInstance>): unknown | null {
  switch (spec.kind) {
    case 'text':
    case 'template': {
      if (typeof v !== 'string' || v.length === 0 || v.length > (spec.max ?? 2000)) return null;
      return v;
    }
    case 'ward': {
      if (typeof v !== 'string') return null;
      const w = wards.get(v);
      return w && (!spec.wardType || wardTypes(spec).includes(w.type)) ? v : null;
    }
    case 'channel':
      return typeof v === 'string' && CHANNEL_RE.test(v) ? v : null;
    case 'seconds': {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= 1 && n <= 86400 ? n : null;
    }
    case 'minutes': {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= 1 && n <= 1440 ? n : null;
    }
    case 'percent': {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= 1 && n <= 100 ? n : null;
    }
    case 'count': {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : null;
    }
    case 'degrees': {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= -100 && n <= 150 ? n : null;
    }
    case 'time':
      return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null;
    case 'email-list': {
      if (!Array.isArray(v) || v.length === 0 || v.length > 5) return null;
      const out = v.map((a) => (typeof a === 'string' ? a.trim() : ''));
      return out.every((a) => a && EMAIL_RE.test(a)) ? out : null;
    }
    case 'notion-id':
      return notionIdFrom(v);
    case 'url':
      return httpUrl(v);
    case 'select':
      return typeof v === 'string' && spec.options?.includes(v) ? v : null;
  }
}

/** Why one param was refused. checkParam only answers yes/no, so the message
 *  is rebuilt from the spec — the length cap first, because an over-long
 *  template is the mistake a model actually makes and cannot see. */
function paramWhy(key: string, spec: ParamSpec, v: unknown): string {
  const max = spec.max ?? 2000;
  if ((spec.kind === 'text' || spec.kind === 'template') && typeof v === 'string' && v.length > max) {
    return `${key} is ${v.length} chars, max ${max}`;
  }
  if (spec.kind === 'select') return `${key} must be one of ${spec.options?.join('|') ?? '—'}`;
  if (spec.kind === 'ward') return `${key} must be the id of a${spec.wardType ? ` ${wardTypes(spec).join('|')}` : 'n existing'} ward`;
  return `${key} is not a valid ${spec.kind}${spec.max ? ` (max ${spec.max})` : ''}`;
}

/** Rebuild (never pass through) the params for one spec; null = reject.
 *  `why` collects the reason for the strict (write) path. */
function validateParams(
  specs: Record<string, ParamSpec>,
  raw: unknown,
  wards: Map<string, WardInstance>,
  why?: string[],
  label = ''
): Record<string, unknown> | null {
  const src = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const v = src[key];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
      if (spec.required) return no(why, `${label}: ${key} is required`);
      continue;
    }
    const checked = checkParam(spec, v, wards);
    if (checked === null) return no(why, `${label}: ${paramWhy(key, spec, v)}`);
    out[key] = checked;
  }
  return out;
}

/** Rebuild one edge; null = invalid. `why` collects the reason (strict path). */
function validateEdge(
  item: unknown,
  wards: Map<string, WardInstance>,
  isAdmin: boolean,
  seen: Set<string>,
  why?: string[]
): LogicEdge | null {
  if (typeof item !== 'object' || item === null) return no(why, 'edge is not an object');
  const e = item as Record<string, unknown>;
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return no(why, `edge id "${String(e.id)}" is malformed`);
  if (seen.has(e.id)) return no(why, `duplicate edge id "${e.id}"`);

  const src = (typeof e.source === 'object' && e.source !== null ? e.source : {}) as Record<string, unknown>;
  const trigger = TRIGGERS[src.trigger as string];
  if (!trigger) return no(why, `unknown trigger "${String(src.trigger)}"`);
  if (typeof src.ward !== 'string') return no(why, `trigger ${String(src.trigger)}: source.ward is required`);
  const srcType = wards.get(src.ward)?.type;
  if (!wardTypes(trigger).includes(srcType ?? '')) {
    return no(
      why,
      srcType
        ? `trigger ${String(src.trigger)}: ward "${src.ward}" is a ${srcType}, needs ${wardTypes(trigger).join('|')}`
        : `trigger ${String(src.trigger)}: no ward "${src.ward}" in the layout`
    );
  }
  const srcParams = validateParams(trigger.params, src.params, wards, why, `trigger ${String(src.trigger)}`);
  if (srcParams === null) return null;
  if (trigger.verify && !trigger.verify(srcParams)) return no(why, `trigger ${String(src.trigger)}: params are inconsistent`);

  const condsRaw = Array.isArray(e.conditions) ? e.conditions : [];
  if (condsRaw.length > MAX_CONDITIONS) return no(why, `${condsRaw.length} conditions, max ${MAX_CONDITIONS}`);
  const conditions: LogicEdge['conditions'] = [];
  for (const c of condsRaw) {
    const cr = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
    const spec = CONDITIONS[cr.type as string];
    if (!spec) return no(why, `unknown condition "${String(cr.type)}"`);
    const params = validateParams(spec.params, cr.params, wards, why, `condition ${String(cr.type)}`);
    if (params === null) return null;
    if (spec.verify && !spec.verify(params)) return no(why, `condition ${String(cr.type)}: params are inconsistent`);
    conditions.push({ type: cr.type as string, params });
  }

  const act = (typeof e.action === 'object' && e.action !== null ? e.action : {}) as Record<string, unknown>;
  const spec = ACTIONS[act.type as string];
  if (!spec) return no(why, `unknown action "${String(act.type)}"`);
  if (spec.adminOnly && !isAdmin) return no(why, `action ${String(act.type)} is admin-only`);
  const action: LogicEdge['action'] = { type: act.type as string, params: {} };
  if (spec.wardType) {
    const allowed = wardTypes(spec);
    if (typeof act.ward !== 'string' || !allowed.includes(wards.get(act.ward)?.type ?? '')) {
      return no(why, `action ${String(act.type)}: action.ward must be the id of a ${allowed.join('|')} ward`);
    }
    action.ward = act.ward;
  }
  const actParams = validateParams(spec.params, act.params, wards, why, `action ${String(act.type)}`);
  if (actParams === null) return null;
  if (spec.verify && !spec.verify(actParams)) return no(why, `action ${String(act.type)}: params are inconsistent`);
  action.params = actParams;

  seen.add(e.id);
  return { id: e.id, source: { ward: src.ward, trigger: src.trigger as string, params: srcParams }, conditions, action, enabled: e.enabled !== false };
}

/** The trust boundary for graph JSON. Strict (writes): any bad edge rejects
 *  the whole graph. Lenient (reads): bad edges are dropped — a graph that WAS
 *  valid self-heals when a referenced ward leaves the layout, instead of one
 *  stale edge silently killing every automation the user has. */
export function validateGraph(
  raw: unknown,
  layout: WardInstance[],
  opts: { isAdmin: boolean; lenient?: boolean; why?: string[] }
): LogicGraph | null {
  const why = opts.lenient ? undefined : opts.why; // a dropped read-path edge is not an error
  if (typeof raw !== 'object' || raw === null) return no(why, 'graph is not an object');
  const edgesRaw = (raw as { edges?: unknown }).edges;
  if (!Array.isArray(edgesRaw)) return no(why, 'graph.edges is not an array');
  if (edgesRaw.length > MAX_EDGES) return no(why, `${edgesRaw.length} edges, max ${MAX_EDGES}`);

  const wards = new Map(layout.map((w) => [w.i, w]));
  const seen = new Set<string>();
  const edges: LogicEdge[] = [];
  for (const item of edgesRaw) {
    const edge = validateEdge(item, wards, opts.isAdmin, seen, why);
    if (edge) edges.push(edge);
    else if (!opts.lenient) return null;
  }
  return { edges };
}
