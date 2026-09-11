import { createHash } from 'node:crypto';
import { getDb } from '../db.ts';
import { getDashboard } from '../dashboard.ts';
import { deleteSetting, getSetting, setSetting } from '../settings.ts';
import { openToken, sealToken } from '../crypto.ts';
import type { WardInstance } from '../wards.ts';
import { broadcast, enqueueFire, takeChatSlot, takeSlot, type FireEvent } from '../logic-engine.ts';
import { discordClient } from './discord.ts';
import { telegramClient } from './telegram.ts';
import { slackClient } from './slack.ts';
import { twilioClient } from './twilio.ts';
import { pushClient } from './push.ts';
import { matrixClient } from './matrix.ts';
import { teamsClient } from './teams.ts';
import { getLink, liveToken } from '../linked-accounts.ts';
import { channelsSeen, deleteWardMessages, getMessage, ingest, listMessages, searchMessages } from './store.ts';
import { isCommsType, messageVars, type ChatChannel, type ChatMessage, type CommsClient, type CommsEvent, type CommsType, type SendOpts, type Whoami } from './types.ts';

// The communication wards' manager. A chat ward is a provider type plus a
// config in the layout; its credential is sealed in a settings row
// (comms_token:<uid>:<ward>, and comms_app:<uid>:<ward> where a second token
// exists), never in the layout and never under /work. One live CONNECTION per
// (user, type, token, scope) — two wards on one bot share it (Telegram allows
// exactly one poller per token) — and syncComms() reconciles the stored
// layout against what is open: boot, every token change, every layout save.
//
// Inbound events land in the store first; only rows that actually inserted
// fire logic (the store's key is the replay guard), then the open tabs get one
// coalesced 'refresh'. Every send — logic exec, agent tool, agent.ask delivery
// — goes through sendChat: destination validated against the client's destRe,
// one per-user hourly window, the outbound row stored as mine.
//
// The manager lives on globalThis (dev HMR re-evaluates this module; a socket
// that survived must call the CURRENT handleEvent, so it goes through hooks).

export type ConnStatus = 'connecting' | 'ready' | 'error' | 'closed';

export interface Conn {
  key: string;
  userId: number;
  type: CommsType;
  wards: Set<string>;
  client: CommsClient;
  status: ConnStatus;
  error?: string;
  note?: string;
  self?: Whoami;
  stop: () => void;
}

interface State {
  conns: Map<string, Conn>;
  hooks: { onEvent: (conn: Conn, ev: CommsEvent) => void; build?: typeof buildClient };
  refresh: Map<string, ReturnType<typeof setTimeout>>;
  booted?: true;
}

const g = globalThis as { __fdComms?: State };
const state: State = (g.__fdComms ??= { conns: new Map(), hooks: { onEvent: () => {} }, refresh: new Map() });
state.hooks.onEvent = (conn, ev) => void handleEvent(conn, ev).catch((err) => console.error('[comms] event failed:', err));

// ---------------------------------------------------------------- config

export interface CommsWardConfig {
  type: CommsType;
  /** The default destination: a channel / chat / number. */
  channel: string;
  /** Which channels fire logic and fill the ward: every one, or a list. */
  watch: 'all' | string[];
  /** The server the ward is scoped to (Discord guild); '' where the type has none. */
  guild: string;
  /** Twilio only: the account SID and the number the ward speaks from. */
  sid?: string;
  from?: string;
  /** Push only: ntfy | pushover, and the ntfy server. */
  service?: 'ntfy' | 'pushover';
  server?: string;
  /** Matrix only. */
  homeserver?: string;
  /** Teams only: a team id → its channels; empty → the user's chats. */
  team?: string;
}

const csv = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);

export function commsConfig(w: WardInstance): CommsWardConfig {
  const c = (w.config ?? {}) as Record<string, unknown>;
  const watchRaw = c.watch === undefined || c.watch === '' || c.watch === 'all' ? 'all' : csv(c.watch);
  const out: CommsWardConfig = {
    type: w.type as CommsType,
    channel: typeof c.channel === 'string' ? c.channel.trim() : '',
    watch: watchRaw === 'all' || watchRaw.length === 0 ? 'all' : watchRaw,
    guild: typeof c.guild === 'string' ? c.guild.trim() : '',
  };
  if (w.type === 'twilio') {
    // Texts cost money: the allow list is the watch list, and empty means nobody.
    out.watch = csv(c.allow);
    out.sid = typeof c.sid === 'string' ? c.sid.trim() : '';
    out.from = typeof c.from === 'string' ? c.from.trim() : '';
  }
  if (w.type === 'push') {
    out.service = c.service === 'pushover' ? 'pushover' : 'ntfy';
    out.server = typeof c.server === 'string' ? c.server.trim() : '';
  }
  if (w.type === 'matrix') out.homeserver = typeof c.homeserver === 'string' ? c.homeserver.trim() : '';
  if (w.type === 'teams') out.team = typeof c.team === 'string' ? c.team.trim() : '';
  return out;
}

/** The stored ward, never the client's copy. */
export function commsWard(userId: number, ward: unknown): WardInstance | null {
  return getDashboard(userId).find((w) => w.i === ward && isCommsType(w.type)) ?? null;
}

// ---------------------------------------------------------------- credentials

const tokenKey = (userId: number, ward: string) => `comms_token:${userId}:${ward}`;
const appKey = (userId: number, ward: string) => `comms_app:${userId}:${ward}`;

/** Seal what is given; null clears both. An omitted field keeps its value. */
export function setCommsToken(userId: number, ward: string, tokens: { token?: string; appToken?: string } | null): void {
  if (!tokens) {
    deleteSetting(tokenKey(userId, ward));
    deleteSetting(appKey(userId, ward));
  } else {
    if (tokens.token) setSetting(tokenKey(userId, ward), sealToken(tokens.token));
    if (tokens.appToken) setSetting(appKey(userId, ward), sealToken(tokens.appToken));
  }
  syncComms(userId);
}

export const hasCommsToken = (userId: number, ward: string): boolean => getSetting(tokenKey(userId, ward)) !== null;

function opened(key: string): string | null {
  const sealed = getSetting(key);
  if (!sealed) return null;
  try {
    return openToken(sealed);
  } catch {
    return null;
  }
}
export const tokenOf = (userId: number, ward: string): string | null => opened(tokenKey(userId, ward));
export const appTokenOf = (userId: number, ward: string): string | null => opened(appKey(userId, ward));

/** Drop everything a ward that left the layout owned. */
export function forgetWard(userId: number, ward: string): void {
  deleteSetting(tokenKey(userId, ward));
  deleteSetting(appKey(userId, ward));
  deleteWardMessages(userId, ward);
}

// ---------------------------------------------------------------- connections

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** What a connection is scoped to beyond the token — a Discord bot in two
 *  servers is two wards AND two gateways, so each client's guild is fixed. */
const scopeOf = (cfg: CommsWardConfig): string =>
  cfg.type === 'discord' ? cfg.guild : cfg.type === 'twilio' ? `${cfg.sid}:${cfg.from}` : cfg.type === 'matrix' ? (cfg.homeserver ?? '') : cfg.type === 'teams' ? (cfg.team ?? '') : '';

/** Teams has no ward token: the linked Microsoft account is the credential. */
const LINK_TOKEN = 'microsoft-link';
function credentialOf(userId: number, w: WardInstance, cfg: CommsWardConfig): string | null {
  if (w.type === 'teams') return getLink(userId, 'microsoft') ? LINK_TOKEN : null;
  return tokenOf(userId, w.i) ?? (tokenOptional(cfg) ? '' : null);
}

function buildClient(type: CommsType, token: string, cfg: CommsWardConfig, key: string, appToken: string | null = null, userId = 0): CommsClient {
  switch (type) {
    case 'discord':
      return discordClient(token, { guild: cfg.guild, channel: cfg.channel, watch: cfg.watch === 'all' ? 'all' : cfg.watch.join(',') }, key);
    case 'telegram':
      return telegramClient(token, { channel: cfg.channel, watch: cfg.watch === 'all' ? 'all' : cfg.watch.join(',') }, key);
    case 'slack':
      return slackClient(token, appToken, { channel: cfg.channel, watch: cfg.watch === 'all' ? 'all' : cfg.watch.join(',') }, key);
    case 'twilio':
      return twilioClient(token, { sid: cfg.sid ?? '', from: cfg.from ?? '', channel: cfg.channel }, key);
    case 'push':
      return pushClient(token, { service: cfg.service ?? 'ntfy', server: cfg.server ?? '', channel: cfg.channel }, key);
    case 'matrix':
      return matrixClient(token, { homeserver: cfg.homeserver ?? '', channel: cfg.channel, watch: cfg.watch === 'all' ? 'all' : cfg.watch.join(',') }, key);
    case 'teams':
      return teamsClient(() => liveToken(userId, 'microsoft'), { team: cfg.team ?? '', channel: cfg.channel, watch: cfg.watch === 'all' ? 'all' : cfg.watch.join(',') }, key);
  }
}

function openConn(key: string, userId: number, type: CommsType, token: string, cfg: CommsWardConfig, wards: string[], appToken: string | null): Conn {
  const client = (state.hooks.build ?? buildClient)(type, token, cfg, key, appToken, userId);
  const conn: Conn = { key, userId, type, wards: new Set(wards), client, status: 'connecting', stop: () => {} };
  conn.stop = client.live((ev) => state.hooks.onEvent(conn, ev));
  void client
    .whoami()
    .then((s) => {
      conn.self = s;
      scheduleRefresh(userId, type);
    })
    .catch((err) => {
      conn.error ??= err instanceof Error ? err.message : String(err);
    });
  return conn;
}

/** Reconcile one user's stored layout + tokens against the open connections. */
export function syncComms(userId: number): void {
  const desired = new Map<string, { type: CommsType; token: string; appToken: string | null; cfg: CommsWardConfig; wards: string[] }>();
  for (const w of getDashboard(userId)) {
    if (!isCommsType(w.type) || w.type === 'push') continue; // nothing to listen to on a push ward
    const token = credentialOf(userId, w, commsConfig(w));
    if (!token) continue;
    const appToken = appTokenOf(userId, w.i);
    const cfg = commsConfig(w);
    // Both tokens in the key: a new app token is a new socket.
    const key = `${userId}:${w.type}:${hash(`${token}\n${appToken ?? ''}`)}:${scopeOf(cfg)}`;
    const d = desired.get(key);
    if (d) d.wards.push(w.i);
    else desired.set(key, { type: w.type, token, appToken, cfg, wards: [w.i] });
  }
  for (const [key, conn] of state.conns) {
    if (conn.userId !== userId || desired.has(key)) continue;
    conn.stop();
    state.conns.delete(key);
  }
  for (const [key, d] of desired) {
    const conn = state.conns.get(key);
    if (conn) conn.wards = new Set(d.wards);
    else state.conns.set(key, openConn(key, userId, d.type, d.token, d.cfg, d.wards, d.appToken));
  }
}

export function syncAll(): void {
  let users: { user_id: number }[] = [];
  try {
    users = getDb().prepare('SELECT user_id FROM dashboards').all() as { user_id: number }[];
  } catch (err) {
    console.error('[comms] boot sync failed:', err);
    return;
  }
  for (const { user_id } of users) {
    try {
      syncComms(user_id);
    } catch (err) {
      console.error(`[comms] sync failed for user ${user_id}:`, err);
    }
  }
}

function stopAll(): void {
  for (const conn of state.conns.values()) {
    try {
      conn.stop();
    } catch {}
  }
  state.conns.clear();
}

/** Boot: every stored chat ward with a token reconnects (pm2 restarts and
 *  memory kills happen); every socket closes on the way down. Sync on
 *  purpose — the browser module's handler exits the process a few seconds in. */
export function ensureComms(): void {
  if (state.booted) return;
  state.booted = true;
  (setTimeout(syncAll, 0) as { unref?: () => void }).unref?.();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, stopAll);
}

/** Test seam: every connection from here on is built by this (null restores the real clients). */
export function setClientBuilderForTests(build: typeof buildClient | null): void {
  if (build) state.hooks.build = build;
  else delete state.hooks.build;
}

/** Test seam: a hand-built connection (a fake client) stands in for a live one. */
export function registerConnForTests(conn: Conn): void {
  state.conns.set(conn.key, conn);
}

/** Test seam: close everything and forget it. */
export function resetCommsForTests(): void {
  stopAll();
  for (const t of state.refresh.values()) clearTimeout(t);
  state.refresh.clear();
}

function connFor(userId: number, ward: string): Conn | null {
  for (const conn of state.conns.values()) if (conn.userId === userId && conn.wards.has(ward)) return conn;
  return null;
}

/** The live connection's client, or a one-off over the stored token. */
export function clientForWard(userId: number, w: WardInstance): CommsClient {
  return clientFor(userId, w);
}

function clientFor(userId: number, w: WardInstance): CommsClient {
  const conn = connFor(userId, w.i);
  if (conn) return conn.client;
  const cfg = commsConfig(w);
  const token = credentialOf(userId, w, cfg);
  if (token === null) throw new Error(w.type === 'teams' ? 'no Microsoft account linked — Account → Accounts' : 'no token — paste the bot token on the ward');
  return (state.hooks.build ?? buildClient)(w.type as CommsType, token, cfg, `${userId}:${w.type}:${hash(token)}:${scopeOf(cfg)}`, appTokenOf(userId, w.i), userId);
}

// ---------------------------------------------------------------- inbound

/** Does this ward listen to where the message came from? DMs always count. */
export function watched(cfg: CommsWardConfig, m: { channel: string; threadId?: string; guild?: string; direct?: boolean }): boolean {
  if (m.guild && cfg.guild && m.guild !== cfg.guild) return false;
  if (m.direct) return true;
  if (cfg.watch === 'all') return true;
  return cfg.watch.includes(m.channel) || (!!m.threadId && cfg.watch.includes(m.threadId));
}

export const messageEvent = (ward: string, m: ChatMessage): FireEvent => ({
  type: 'message-arrived',
  ward,
  channel: m.channel,
  match: { from: m.from.id, mention: m.mention ? 'yes' : 'no' },
  extra: messageVars(m),
});

export const reactionEvent = (ward: string, r: Extract<CommsEvent, { type: 'reaction' }>, m: ChatMessage | null): FireEvent => ({
  type: 'reaction-added',
  ward,
  channel: r.channel,
  match: { emoji: r.emoji, from: r.from.id },
  extra: {
    ...(m ? messageVars(m) : { 'msg.id': r.messageId, 'msg.channel': r.channel }),
    'reaction.emoji': r.emoji,
    'reaction.from': r.from.name,
    'reaction.fromId': r.from.id,
  },
});

export const memberEvent = (ward: string, m: { id: string; name: string }): FireEvent => ({
  type: 'member-joined',
  ward,
  extra: { 'member.name': m.name, 'member.id': m.id },
});

/** One 'refresh' per (user, type) per second, however many messages land. */
function scheduleRefresh(userId: number, type: CommsType): void {
  const key = `${userId}:${type}`;
  if (state.refresh.has(key)) return;
  const t = setTimeout(() => {
    state.refresh.delete(key);
    broadcast(userId, 'refresh', { type });
  }, 1_000);
  (t as { unref?: () => void }).unref?.();
  state.refresh.set(key, t);
}

/** Exported for tests: what a connection's event does to its wards. */
export async function handleEvent(conn: Conn, ev: CommsEvent): Promise<void> {
  const { userId } = conn;
  if (ev.type === 'state') {
    conn.status = ev.status;
    conn.error = ev.error;
    const { observe } = await import('../agent/observation-events.ts');
    for (const ward of conn.wards) observe({ user:userId,source:'comms-state',target:ward,key:String(Date.now()),data:{ status:ev.status,error:ev.error ?? '' } });
    if (ev.note !== undefined) conn.note = ev.note;
    scheduleRefresh(userId, conn.type);
    return;
  }
  const layout = getDashboard(userId);
  for (const wardId of conn.wards) {
    const w = layout.find((x) => x.i === wardId);
    if (!w) continue;
    const cfg = commsConfig(w);
    if (ev.type === 'message') {
      if (!watched(cfg, ev.message)) continue;
      const m = { ...ev.message, channelName: ev.message.channelName ?? conn.client.nameOf(ev.message.channel) };
      if (!ingest(userId, wardId, [m]).length) continue;
      if (!ev.quiet) {
        const { observe } = await import('../agent/observation-events.ts');
        observe({ user:userId,source:'comms',target:wardId,key:m.id,data:{ eventType:'message',provider:conn.type,sender:m.from.id,senderName:m.from.name,channel:m.channel,text:m.text,at:m.at } });
        enqueueFire(userId, messageEvent(wardId, m));
      }
      scheduleRefresh(userId, conn.type);
    } else if (ev.type === 'reaction') {
      if (!watched(cfg, { channel: ev.channel, guild: ev.guild })) continue;
      let m = getMessage(userId, wardId, ev.messageId);
      if (!m) {
        // The event carries no text; one fetch, stored without firing.
        try {
          const fetched = (await conn.client.read('message', { channel: ev.channel, message: ev.messageId })) as ChatMessage;
          if (fetched?.id) {
            ingest(userId, wardId, [{ ...fetched, channelName: conn.client.nameOf(fetched.channel) }]);
            m = getMessage(userId, wardId, ev.messageId);
          }
        } catch {}
      }
      enqueueFire(userId, reactionEvent(wardId, ev, m));
    } else if (ev.type === 'member-joined') {
      if (ev.guild && cfg.guild && ev.guild !== cfg.guild) continue;
      enqueueFire(userId, memberEvent(wardId, ev.member));
    }
  }
}

// ---------------------------------------------------------------- outbound + reads

const smsWindow = new Map<number, number[]>();
const SMS_CAP_PER_HOUR = 20;

/** THE send path. `channel` empty = the ward's default. */
export async function sendChat(userId: number, ward: string, channel: string | undefined, text: string, opts: SendOpts = {}): Promise<ChatMessage> {
  const w = commsWard(userId, ward);
  if (!w) throw new Error(`no chat ward "${ward}" — call get_layout for the real ids`);
  const cfg = commsConfig(w);
  const client = clientFor(userId, w);
  const dest = (channel ?? '').trim() || cfg.channel;
  if (!dest) throw new Error('no channel — name one, or set a default under ⚙ Configure');
  if (!client.destRe.test(dest)) throw new Error(`"${dest}" is not a ${w.type} channel id`);
  const body = text.trim();
  if (!body) throw new Error('nothing to send');
  takeChatSlot(userId);
  if (w.type === 'twilio') takeSlot(smsWindow, userId, SMS_CAP_PER_HOUR, 'sms'); // money
  const sent = await client.send(dest, body.slice(0, client.maxText), opts);
  const m: ChatMessage = { ...sent, mine: true, channelName: sent.channelName ?? client.nameOf(sent.channel) };
  ingest(userId, w.i, [m]);
  scheduleRefresh(userId, w.type as CommsType);
  return m;
}

export async function reactChat(userId: number, ward: string, channel: string, messageId: string, emoji: string): Promise<void> {
  const w = commsWard(userId, ward);
  if (!w) throw new Error(`no chat ward "${ward}"`);
  await clientFor(userId, w).react(channel, messageId, emoji);
}

/** The ward's messages, newest first; an empty channel backfills once from
 *  the provider's history (Discord/Slack — Telegram has none). */
export async function messagesFor(userId: number, ward: string, channel: string | null, limit: number): Promise<ChatMessage[]> {
  const w = commsWard(userId, ward);
  if (!w) throw new Error(`no chat ward "${ward}"`);
  let rows = listMessages(userId, w.i, channel, limit);
  if (!rows.length && channel) {
    try {
      const client = clientFor(userId, w);
      const h = await client.history(channel, 50);
      ingest(userId, w.i, h.map((m) => ({ ...m, channelName: m.channelName ?? client.nameOf(m.channel) })));
      rows = listMessages(userId, w.i, channel, limit);
    } catch {}
  }
  return rows;
}

export async function channelsFor(userId: number, ward: string): Promise<ChatChannel[]> {
  const w = commsWard(userId, ward);
  if (!w) throw new Error(`no chat ward "${ward}"`);
  // The provider's list, plus every chat the store has seen and the configured
  // default — a Telegram bot cannot list its chats at all.
  const cfg = commsConfig(w);
  const out = new Map<string, ChatChannel>();
  let failure: unknown;
  try {
    for (const c of await clientFor(userId, w).channels()) out.set(c.id, c);
  } catch (err) {
    failure = err;
  }
  for (const c of channelsSeen(userId, w.i)) if (!out.has(c.id)) out.set(c.id, { id: c.id, name: c.name || c.id });
  if (cfg.channel && !out.has(cfg.channel)) out.set(cfg.channel, { id: cfg.channel, name: cfg.channel });
  if (!out.size && failure) throw failure;
  return [...out.values()];
}

/** The agent's chat_read: channels / messages / search from here, everything
 *  else the provider's own reads. */
export async function commsRead(userId: number, ward: string, what: string, args: Record<string, unknown>): Promise<unknown> {
  const w = commsWard(userId, ward);
  if (!w) throw new Error(`no chat ward "${ward}" — call get_layout for the real ids`);
  const limit = Math.min(Math.max(Math.round(Number(args.limit)) || 20, 1), 100);
  switch (what) {
    case 'channels':
      return channelsFor(userId, ward);
    case 'messages':
      return messagesFor(userId, ward, typeof args.channel === 'string' && args.channel ? args.channel : null, limit);
    case 'search':
      return searchMessages(userId, w.i, String(args.query ?? ''), limit);
    default:
      return clientFor(userId, w).read(what, args);
  }
}

export interface CommsStatus {
  type: CommsType;
  hasToken: boolean;
  hasAppToken: boolean;
  status: ConnStatus | 'no-token';
  error?: string;
  note?: string;
  self?: Whoami;
  channel: string;
  guild: string;
  watch: 'all' | string[];
  /** What the config still lacks before the ward can work, or ''. */
  needs: string;
  /** ntfy: the ward works with no token at all. */
  tokenOptional: boolean;
  /** Teams: where to re-consent when the Microsoft link lacks the Teams scopes. */
  reconnect?: string;
}

/** ntfy works without any token; everything else needs one. */
export const tokenOptional = (cfg: CommsWardConfig): boolean => (cfg.type === 'push' && cfg.service !== 'pushover') || cfg.type === 'teams';

/** The Microsoft scopes a Teams ward needs; a link granted before them must be redone. */
export const TEAMS_SCOPE = 'Chat.ReadWrite';

/** The config gap a type cannot work without — the ward shows it instead of a feed. */
export function configNeeds(cfg: CommsWardConfig): string {
  if (cfg.type === 'discord' && !cfg.guild) return 'Set the server id under ⚙ Configure.';
  if (cfg.type === 'twilio' && !(cfg.sid && cfg.from)) return 'Set the account SID and the Twilio number under ⚙ Configure.';
  if (cfg.type === 'twilio' && cfg.watch !== 'all' && !cfg.watch.length) return 'Nobody is on the allow list yet — add numbers under ⚙ Configure, or texts are ignored.';
  if (cfg.type === 'push' && !cfg.channel) return cfg.service === 'pushover' ? 'Set your Pushover user key under ⚙ Configure.' : 'Set the ntfy topic under ⚙ Configure.';
  if (cfg.type === 'matrix' && !cfg.homeserver) return 'Set the homeserver under ⚙ Configure.';
  return '';
}

export function commsStatus(userId: number, w: WardInstance): CommsStatus {
  const cfg = commsConfig(w);
  const conn = connFor(userId, w.i);
  const hasToken = hasCommsToken(userId, w.i);
  const optional = tokenOptional(cfg);
  if (cfg.type === 'teams') {
    const link = getLink(userId, 'microsoft');
    const consented = !!link && link.scopes.split(/\s+/).some((s) => s === TEAMS_SCOPE || s.endsWith(`/${TEAMS_SCOPE}`));
    return {
      needs: !link ? 'Link a Microsoft account first (Account → Accounts).' : consented ? configNeeds(cfg) : 'The Microsoft link was made without Teams access — reconnect it.',
      ...(link && !consented ? { reconnect: '/api/connect/microsoft?teams' } : {}),
      tokenOptional: true,
      type: cfg.type,
      hasToken: !!link,
      hasAppToken: false,
      status: conn ? conn.status : link && consented ? 'connecting' : 'no-token',
      error: conn?.error,
      note: conn?.note,
      self: conn?.self,
      channel: cfg.channel,
      guild: cfg.guild,
      watch: cfg.watch,
    };
  }
  return {
    needs: configNeeds(cfg),
    tokenOptional: optional,
    type: cfg.type,
    hasToken,
    hasAppToken: getSetting(appKey(userId, w.i)) !== null,
    status: conn ? conn.status : cfg.type === 'push' ? (hasToken || optional ? 'ready' : 'no-token') : hasToken ? 'connecting' : 'no-token',
    error: conn?.error,
    note: conn?.note,
    self: conn?.self,
    channel: cfg.channel,
    guild: cfg.guild,
    watch: cfg.watch,
  };
}
