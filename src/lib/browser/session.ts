import { terminalEnv } from '../dev/environment.ts';
import { isDesktop } from '../dev/runtime.ts';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { DATA_DIR } from '../db.ts';
import { browserScale, httpUrl, type BrowserConfig } from '../wards.ts';
import { direct, guardFor, guardPort, type Dial } from './guard.ts';
import { connectBrowserbase, dropBrowserbase } from './browserbase.ts';
import { connectApp } from './app-backend.ts';
import { publicAddress } from '../net-guard.ts';
import { openStream, subscribeTunnel, tunnelOnline, tunnelStatus } from '../tunnel.ts';
import { captureDownload, listDownloads, moveDownloads, type BrowserDownload } from './downloads.ts';
import { extensionPaths, extensionStorage, cleanExtensions, extensionMaintenance, quiet, STREAM_EXTENSION } from './extensions.ts';
import { TURN_HOST } from '../dev/remote-turn.ts';

// One live browser per browser ward, keyed `${userId}:${ward}`. The human
// (screencast out + input in over the ward's WebSocket, lib/browser/live.ts;
// SSE + POST for a viewer the relay serves) and the agent (tools) share
// it: one page handle, one profile, so a login the human completes is the
// session the agent picks up — and it survives the browser closing.
//
// A backend is anything that yields a BrowserContext plus a close(): local
// chromium (persistent profile under PROFILES, egress through guard.ts),
// Browserbase (browserbase.ts), or the user's own computer through the
// desktop app (app-backend.ts). Nothing above launch() knows which.

/** Where local profiles live. A server that runs chromium as a separate user
 *  (BROWSER_EXECUTABLE) points this OUTSIDE data/: that user must never be able
 *  to read homepage.db. */
export const PROFILES = process.env.BROWSER_PROFILES ?? path.join(DATA_DIR, 'browser');
/** A wrapper that drops root before exec, so chromium keeps its sandbox on a
 *  root-run server. Unset = playwright-core's own chromium. */
const EXE = process.env.BROWSER_EXECUTABLE;
/** Playwright's default is --no-sandbox. These tabs load whatever the user
 *  types; the renderer sandbox is the containment. Chromium refuses to sandbox
 *  as root, so root without the wrapper runs unsandboxed — loudly. */
const SANDBOX = !!EXE || process.getuid?.() !== 0;
if (!SANDBOX)
  console.warn('[browser] root without BROWSER_EXECUTABLE: chromium sandbox OFF — run as a non-root user or set BROWSER_EXECUTABLE to a wrapper that drops root');
const MAX = Number(process.env.BROWSER_MAX_SESSIONS ?? 3);
const IDLE_MS = 10 * 60_000;
const CLOSE_MS = 5_000;
const NAV_MS = 30_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const MIN_VIEW = { width: 320, height: 240 };
const MAX_VIEW = { width: 1920, height: 1200 };
/** wards.ts ID_RE — the ward id becomes a path segment, so re-check it here. */
const WARD_RE = /^[a-z0-9-]{1,32}$/;
const restoreDesktop = () => isDesktop() && process.platform === 'darwin';

export type BrowserEvent =
  /** jpeg, base64 — exactly as CDP hands it over, never re-encoded. */
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'nav'; url: string; title: string }
  | { type: 'tabs'; tabs: { url: string; title: string }[]; active: number }
  /** A JS alert/confirm/prompt: auto-dismissed (it would freeze the page for
   *  both drivers), the text shown to the human. */
  | { type: 'dialog'; kind: string; message: string }
  /** A home-routed ward: whether the desktop app's tunnel is up right now. */
  | { type: 'route'; online: boolean; detail?: string }
  | { type: 'download'; file: BrowserDownload }
  /** The session's device scale: a frame is viewport × dsf pixels. Sent with
   *  the state on connect and on every resize, with the CSS viewport (what a
   *  viewer maps input against once the picture is a video, not a frame); the
   *  in-app driver emits it after its own resize, scale only. */
  | { type: 'view'; dsf: number; width?: number; height?: number }
  | { type: 'closed' };

/** The capture page (assets/browser-extensions/stream) of a local browser. */
export interface Streamer { page: Page; rev: number }
/** A message from the capture page for one viewer: an offer, a candidate, or a connection state. */
export type StreamSignal = { conn: string; sdp?: string; candidate?: unknown; state?: string; message?: string };

/** One connected human viewer on the ward's WebSocket (lib/browser/live.ts). */
export interface HumanOwner {
  dead: boolean;
  /** Keys/buttons whose `down` this owner EXECUTED and whose `up` has not. */
  heldKeys: Set<string>;
  heldButtons: Set<number>;
}
export type HumanEntry =
  | { owner: HumanOwner; cmd: Cmd; bytes: number }
  | { owner: HumanOwner; control: 'release'; bytes: 0 };

export interface Session {
  key: string;
  userId: number;
  ward: string;
  backend: BrowserConfig['backend'];
  route?: BrowserConfig['route'];
  context: BrowserContext;
  pages: Page[];
  pageReady: WeakMap<Page, Promise<void>>;
  /** The active tab — what the screencast shows and the agent acts on. */
  page: Page;
  viewport: { width: number; height: number };
  /** Device scale factor, fixed at launch (a Playwright context option). */
  dsf: number;
  /** Viewers; `jpeg` = this one still wants screencast frames (a viewer on WebRTC does not). */
  subs: Map<(e: BrowserEvent) => void, { jpeg: boolean }>;
  /** The ward's sound knob: play the tabs' audio on the machine running Chromium. */
  sound: boolean;
  /** The capture page — local backends only; undefined = JPEG frames for everyone. */
  stream?: Streamer;
  /** Its open in flight: a close waits for it, so a half-open blank tab never lands in the saved session. */
  streamOpening?: Promise<void>;
  /** WebRTC signaling sinks by viewer connection id (lib/browser/rtc.ts registers them). */
  rtc: Map<string, (msg: StreamSignal) => void>;
  /** Pages the context announced while the capture page was being opened (the `page` event is
   *  quiet then): whoever opened it sorts them — its own page dropped, every other one adopted. */
  quietPages: Page[];
  /** The human WebSocket viewers' ordered input, drained by ONE worker
   *  (lib/browser/live.ts); separate from the agent's `chain`. */
  humanQueue: HumanEntry[];
  humanBytes: number;
  humanWorker?: Promise<void>;
  owners: Set<HumanOwner>;
  lastUsed: number;
  /** Agent operations serialize here; the human's input never waits on it. */
  chain: Promise<unknown>;
  operations?: number;
  close: () => Promise<void>;
  closing?: Promise<void>;
  cast?: Promise<CDPSession>;
  /** The running cast's max frame size (device px). Chromium only ever scales
   *  frames DOWN to it, so a smaller viewport needs no restart — only a larger one. */
  castMax?: { width: number; height: number };
  castStop?: Promise<void>;
  /** Where the human's pointer last went, so a click at the same spot skips the move. */
  pointer?: { x: number; y: number };
  unsubRoute?: () => void;
}

// On globalThis, like the engines' tick handles: dev HMR re-evaluates this
// module while the chromiums it launched live on, and a fresh Map would try
// to launch a second browser onto a profile that is still locked.
const g = globalThis as { __fdBrowserSessions?: Map<string, Session>; __fdBrowserOpening?: Map<string, Promise<Session>> };
const sessions = (g.__fdBrowserSessions ??= new Map<string, Session>());
const opening = (g.__fdBrowserOpening ??= new Map<string, Promise<Session>>());

export const peek = (userId: number, ward: string): Session | undefined => sessions.get(`${userId}:${ward}`);

/** The session for a ward, launching it if needed. `cfg` is the ward's own
 *  validated config — the caller has already checked the ward exists and is
 *  a browser ward (dashboard.ts browserWard). */
export function open(userId: number, ward: string, cfg: BrowserConfig, opts: { dsf?: number } = {}): Promise<Session> {
  if (!WARD_RE.test(ward)) return Promise.reject(new Error('bad ward id'));
  const key = `${userId}:${ward}`;
  const live = sessions.get(key);
  if (live) {
    if (live.closing) return live.closing.then(() => open(userId, ward, cfg, opts));
    live.lastUsed = Date.now();
    return Promise.resolve(live);
  }
  let p = opening.get(key);
  if (!p) {
    p = launch(userId, ward, key, cfg, browserScale(opts.dsf)).finally(() => opening.delete(key));
    opening.set(key, p);
  }
  return p;
}

async function launch(userId: number, ward: string, key: string, cfg: BrowserConfig, dsf: number): Promise<Session> {
  if(isDesktop())cfg={...cfg,backend:cfg.backend==='app'?'local':cfg.backend,route:undefined};
  ensureBrowser();
  await makeRoom();
  // Only a launch takes options; a browser connected over CDP keeps its own scale.
  if (cfg.backend !== 'local') dsf = 1;
  const backend =
    cfg.backend === 'browserbase' ? await connectBrowserbase(userId, ward)
    : cfg.backend === 'app' ? await connectApp(userId, ward)
    : await launchLocal(userId, ward, cfg, dsf);
  const { context } = backend;
  try { if (cfg.backend === 'browserbase') await extensionStorage(context, userId, ward, true); }
  catch (error) { await backend.close(); throw error; }
  // A restored profile (macOS --restore-last-session) brings the capture page back as a tab: never that.
  for (const p of context.pages().filter(isStreamPage)) await p.close().catch(() => {});
  const restored = restoreDesktop() && cfg.backend !== 'browserbase' ? await restoreView(context, userId, ward) : null;
  const page = restored?.page ?? userPages(context)[0] ?? (await context.newPage());
  const s: Session = {
    key,
    userId,
    ward,
    backend: cfg.backend,
    route: cfg.route,
    context,
    pages: restored?.pages ?? userPages(context),
    pageReady: new WeakMap(),
    page,
    viewport: { ...DEFAULT_VIEWPORT },
    dsf,
    subs: new Map(),
    sound: cfg.sound === true,
    rtc: new Map(),
    quietPages: [],
    humanQueue: [],
    humanBytes: 0,
    owners: new Set(),
    lastUsed: Date.now(),
    chain: Promise.resolve(),
    close: backend.close,
  };
  for (const p of s.pages) watchPage(s, p);
  if (s.route === 'home') s.unsubRoute = subscribeTunnel(userId, (online) => emit(s, { type: 'route', online }));
  // Popups (OAuth consent, "open in new window") become tabs and take focus.
  context.on('page', (p) => {
    if (extensionMaintenance(context)) { s.quietPages.push(p); return; }
    adopt(s, p);
  });
  context.on('close', () => {
    // Crashed, or closed by us: either way the viewers reconnect and relaunch.
    if (sessions.get(key) === s) sessions.delete(key);
    emit(s, { type: 'closed' });
  });
  sessions.set(key, s);
  if (cfg.backend === 'local') s.streamOpening = openStreamer(s);
  // A fresh (headless) profile always opens on about:blank; the ward's URL is
  // its home page. Failures show on the screencast, not here.
  if (cfg.url && page.url() === 'about:blank') void page.goto(cfg.url, { waitUntil: 'commit', timeout: NAV_MS }).catch(() => {});
  return s;
}

/** Egress through the desktop app: vetted here like every dial, then sent as
 *  the HOSTNAME so the app resolves at home (its own geo-DNS, and its own
 *  private-address check on what that resolves to). */
const homeDial =
  (userId: number): Dial =>
  async (host, port) => {
    if (host === TURN_HOST) return direct(host, port); // media to our own relay never rides the home uplink twice
    await publicAddress(host);
    return openStream(userId, `${host}:${port}`);
  };

/** The shell allowlist minus the two things a browser has no use for and must not hold. */
function browserEnv(): Record<string, string> {
  const { SSH_AUTH_SOCK: _agent, SHELL: _shell, ...env } = terminalEnv();
  return env;
}
async function launchLocal(userId: number, ward: string, cfg: BrowserConfig, dsf: number): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  // A home-routed ward gets its own listener; every other one shares the direct proxy.
  const home = cfg.route === 'home' ? await guardFor(homeDial(userId)) : undefined;
  const port = home?.port ?? (await guardPort());
  const profile = profileDir(userId, ward);
  cleanExtensions(userId, ward);
  const extensions = extensionPaths(userId, ward);
  const downloads = path.join(profile, 'rimeward-transfers');
  fs.mkdirSync(downloads, { recursive: true });
  const owner = fs.statSync(profile);
  if (process.getuid?.() === 0 && owner.uid !== 0) fs.chownSync(downloads, owner.uid, owner.gid);
  // These are Chromium's temporary transfers; completed files live outside the profile.
  for (const name of fs.readdirSync(downloads)) fs.rmSync(path.join(downloads, name), { force: true, recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    ...(EXE ? { executablePath: EXE } : { channel: 'chromium' }),
    headless: true,
    chromiumSandbox: SANDBOX,
    // Shutdown is ours (below): Playwright's handlers SIGKILL the browser and
    // exit, which loses the cookie writes chromium batches for up to 30s —
    // i.e. the login the human just finished.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    // Without this the browser child inherits TOKEN_ENC_KEY and RIMEWARD_NATIVE_TOKEN, readable
    // from its own /proc/<pid>/environ — on the VPS by the very user the sandbox isolates.
    env: browserEnv(),
    proxy: { server: `http://127.0.0.1:${port}`, bypass: '<-loopback>' },
    viewport: DEFAULT_VIEWPORT,
    // The viewer's display density (HiDPI frames). BOTH halves matter: the
    // context option keeps Playwright's own metrics (re-sent on every viewport
    // change and new page) and `scale: 'css'` screenshots right, and the
    // process flag below is what the screencast actually follows — an
    // emulated scale alone renders at 2× and casts at 1×.
    deviceScaleFactor: dsf,
    acceptDownloads: true,
    downloadsPath: downloads,
    // Chromium restores history, scroll positions and form state itself. A
    // forced blank startup tab would take the place of the restored page.
    // Playwright's --mute-audio would starve the capture (renderers get a null sink), so it
    // goes: the capture page mutes every tab browser-side while the ward's sound is off
    // (stream.js applySound), and a ward with sound on plays through this machine's default
    // output (CoreAudio / WASAPI / PulseAudio-PipeWire via XDG_RUNTIME_DIR, which browserEnv passes).
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio', ...(restoreDesktop() ? ['about:blank'] : [])],
    args: [
      '--enable-unsafe-extension-debugging',
      `--load-extension=${[...extensions, STREAM_EXTENSION.dir].join(',')}`,
      `--allowlisted-extension-id=${STREAM_EXTENSION.id}`, // tabCapture without a gesture, for that one extension
      ...(restoreDesktop() ? ['--restore-last-session'] : []),
      ...(dsf !== 1 ? [`--force-device-scale-factor=${dsf}`] : []),
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', // no unproxied UDP out of ICE
      '--disk-cache-size=52428800', // the profile's size cap, in effect
    ],
  });
  const pages = userPages(context);
  if (restoreDesktop() && pages.length === 1 && pages[0]!.url().startsWith('chrome://new-tab-page'))
    await pages[0]!.goto('about:blank');
  return {
    context,
    close: async () => {
      await context.close();
      home?.close();
    },
  };
}

/** CDP discovery order is not tab-strip order after Chromium restores a
 * profile. Keep only Rimeward's tab selection here; Chromium owns page data. */
async function tabView(context: BrowserContext, page: Page): Promise<{ url: string; key: string }> {
  const cdp = await context.newCDPSession(page);
  try {
    const history = await cdp.send('Page.getNavigationHistory');
    return {
      url: history.entries[history.currentIndex]?.url ?? page.url(),
      key: createHash('sha256').update(JSON.stringify([history.currentIndex, history.entries.map(e => e.url)])).digest('hex'),
    };
  } finally { await cdp.detach(); }
}

async function restoreView(context: BrowserContext, userId: number, ward: string): Promise<{ pages: Page[]; page: Page } | null> {
  try {
    const file = path.join(PROFILES, String(userId), ward, 'rimeward-view.json');
    if (fs.statSync(file).size > 128 * 1024) return null;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { tabs: { url: string; key: string }[]; active: number };
    if (!Array.isArray(saved.tabs) || saved.tabs.length > 32 || !Number.isInteger(saved.active) || !saved.tabs[saved.active] ||
      saved.tabs.some(t => !t || typeof t.url !== 'string' || !/^[a-f0-9]{64}$/.test(t.key))) return null;
    const available = await Promise.all(userPages(context).map(async page => ({ page, ...await tabView(context, page) })));
    const pages: Page[] = [];
    let active: Page | undefined;
    for (const [i, tab] of saved.tabs.entries()) {
      let found = available.findIndex(p => p.key === tab.key);
      if (found < 0) found = available.findIndex(p => p.url === tab.url);
      if (found < 0) continue;
      const page = available.splice(found, 1)[0]!.page;
      pages.push(page);
      if (i === saved.active) active = page;
    }
    pages.push(...available.map(p => p.page));
    return pages.length ? { pages, page: active ?? pages[0]! } : null;
  } catch { return null; } // A missing/corrupt checkpoint never discards restored tabs.
}

async function saveView(s: Session): Promise<void> {
  if (!restoreDesktop() || s.backend !== 'local') return;
  try {
    const tabs = await Promise.all(s.pages.map(page => tabView(s.context, page)));
    const file = path.join(PROFILES, String(s.userId), s.ward, 'rimeward-view.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ tabs, active: s.pages.indexOf(s.page) }), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  } catch { console.warn('[browser] Could not save tab selection; Chromium will restore its last session.'); }
}

function profileDir(userId: number, ward: string): string {
  const dir = path.join(PROFILES, String(userId), ward);
  fs.mkdirSync(dir, { recursive: true });
  // Prod: node is root, PROFILES belongs to the browser user — hand it over.
  const st = fs.statSync(PROFILES);
  if (process.getuid?.() === 0 && st.uid !== 0) {
    fs.chownSync(path.dirname(dir), st.uid, st.gid);
    fs.chownSync(dir, st.uid, st.gid);
  }
  return dir;
}

/** Cap live browsers: evict the longest-idle unwatched one, else refuse. */
async function makeRoom(): Promise<void> {
  if (sessions.size < MAX) return;
  const idle = [...sessions.values()].filter((s) => !s.subs.size && !s.operations && !s.closing).sort((a, b) => a.lastUsed - b.lastUsed)[0];
  if (!idle) throw new Error(`too many live browsers (${MAX}) — close one first`);
  await closeSession(idle);
}
// ponytail: in-flight launches don't count toward MAX; a burst can overshoot by
// the number of concurrent first-opens. Count `opening` too if it ever matters.

function emit(s: Session, ev: BrowserEvent): void {
  for (const [sub, o] of s.subs) if (ev.type !== 'frame' || o.jpeg) sub(ev);
}

function watchPage(s: Session, p: Page): void {
  p.on('download', download => captureDownload(s.userId, s.ward, download,
    s.backend === 'local' ? path.join(PROFILES, String(s.userId), s.ward, 'rimeward-transfers') : undefined,
    file => emit(s, { type: 'download', file })));

  const nav = () => {
    if (s.page === p) void pushNav(s);
    void pushTabs(s);
  };
  p.on('framenavigated', (f) => f === p.mainFrame() && nav());
  p.on('load', nav);
  p.on('dialog', (d) => {
    emit(s, { type: 'dialog', kind: d.type(), message: d.message().slice(0, 500) });
    // beforeunload must be accepted or the page can never leave.
    void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {});
  });
  p.on('close', () => {
    s.pages = s.pages.filter((x) => x !== p);
    if (s.page === p) {
      if (s.pages.length) void activate(s, s.pages[s.pages.length - 1]!);
      else void newPage(s).catch(() => {}); // a page can also close itself
    } else void pushTabs(s);
  });
}

async function pushNav(s: Session): Promise<void> {
  const page = s.page;
  const title = await page.title().catch(() => '');
  if (s.page === page) emit(s, { type: 'nav', url: page.url(), title });
}

async function pushTabs(s: Session): Promise<void> {
  const tabs = await Promise.all(s.pages.map(async (p) => ({ url: p.url(), title: await p.title().catch(() => '') })));
  emit(s, { type: 'tabs', tabs, active: s.pages.indexOf(s.page) });
}

/** What a viewer needs on connect: the current page and tab strip. */
export async function pushState(s: Session): Promise<void> {
  emit(s, { type: 'view', dsf: s.dsf, width: s.viewport.width, height: s.viewport.height });
  await pushNav(s);
  await pushTabs(s);
  if (s.route === 'home') emit(s, { type: 'route', online: tunnelOnline(s.userId) });
  for (const file of listDownloads(s.userId, s.ward).filter(f => f.status === 'downloading')) emit(s, { type: 'download', file });
}

/** Switch the active tab; the screencast (if running) follows. */
export async function activate(s: Session, page: Page): Promise<void> {
  if (s.page !== page) {
    s.page = page;
    s.pointer = undefined; // a new page has its own mouse state
    await stopCast(s);
    if (s.page !== page || s.closing) return; // A newer tab selection owns the cast.
    await page.setViewportSize(s.viewport).catch(() => {});
    if (s.page !== page) return;
    // Chromium's active tab follows ours: the capture page takes the tab from the activation this fires.
    await page.bringToFront().catch(() => {});
    if (s.page !== page) return;
    startCast(s);
    capture(s);
  }
  await pushState(s);
}

/** A new page becomes a tab and takes focus; its screencast/selection work is
 *  asynchronous (`pageReady`), and a page is adopted once. */
function adopt(s: Session, p: Page): void {
  if (s.pages.includes(p) || p.isClosed()) return;
  s.pages.push(p);
  watchPage(s, p);
  const ready = activate(s, p);
  s.pageReady.set(p, ready);
  void ready.catch(() => {}); // explicit new-tab commands await and report it
}

async function newPage(s: Session): Promise<Page> {
  const page = await s.context.newPage();
  // The context event adopts the tab before newPage resolves — unless the capture
  // page was being opened at that instant (the event is quiet then): adopt it here.
  s.quietPages = s.quietPages.filter(p => p !== page);
  adopt(s, page);
  await s.pageReady.get(page);
  return page;
}

export async function goto(s: Session, url: string): Promise<void> {
  const href = httpUrl(url);
  if (!href) throw new Error('http(s) URLs only');
  s.lastUsed = Date.now();
  // 'commit' — return as soon as navigation lands; the screencast shows the
  // rest. Callers that need the DOM (the agent) wait for a load state after.
  const before = new Set(listDownloads(s.userId, s.ward).map(f => f.id));
  try { await s.page.goto(href, { waitUntil: 'commit', timeout: NAV_MS }); }
  catch (e) {
    // An attachment response deliberately aborts navigation; its download receipt is the result.
    if (!listDownloads(s.userId, s.ward).some(f => !before.has(f.id)) ||
        !/Download is starting|net::ERR_ABORTED/.test(String(e))) throw e;
  }
}

export async function resize(s: Session, width: number, height: number): Promise<void> {
  const w = Math.round(Math.min(MAX_VIEW.width, Math.max(MIN_VIEW.width, width)));
  const h = Math.round(Math.min(MAX_VIEW.height, Math.max(MIN_VIEW.height, height)));
  if (w === s.viewport.width && h === s.viewport.height) return;
  s.viewport = { width: w, height: h };
  await s.page.setViewportSize(s.viewport).catch(() => {});
  tell(s, { size: captureSize(s) });
  emit(s, { type: 'view', dsf: s.dsf, width: w, height: h });
  // The screencast's max size is fixed at start, and frames only shrink to
  // fit it: restart only when the viewport outgrows it (the expand dialog),
  // never on the way back down — that restart was a visible frame gap.
  if (s.cast && s.castMax && (w * s.dsf > s.castMax.width || h * s.dsf > s.castMax.height)) {
    await stopCast(s);
    startCast(s);
  }
}

// ------------------------------------------------------------------ input

export type Cmd =
  | { t: 'move'; x: number; y: number }
  | { t: 'down' | 'up'; x: number; y: number; button?: number; clicks?: number }
  | { t: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { t: 'key'; type: 'down' | 'up'; key: string }
  | { t: 'text'; text: string }
  | { t: 'goto'; url: string }
  | { t: 'back' }
  | { t: 'forward' }
  | { t: 'reload' }
  /** `dsf` is the in-app driver's (browser-cdp.ts); the server's scale is fixed at launch. */
  | { t: 'resize'; w: number; h: number; dsf?: number }
  | { t: 'tab'; i: number }
  | { t: 'newtab' }
  | { t: 'closetab'; i: number };

const BUTTONS = ['left', 'middle', 'right'] as const;
const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0);
const CMD_TYPES = new Set(['move', 'down', 'up', 'wheel', 'key', 'text', 'goto', 'back', 'forward', 'reload', 'resize', 'tab', 'newtab', 'closetab']);

/** A batch's shape: an array of at most 200, else `bad batch`; entries that
 *  are not an object with a known `t` are dropped, never refused (what the
 *  POST route has always done). Field values are clamped at execution. */
export function normalizeCmds(cmds: unknown): Cmd[] {
  if (!Array.isArray(cmds) || cmds.length > 200) throw new Error('bad batch');
  return cmds.filter((raw): raw is Cmd => !!raw && typeof raw === 'object' && CMD_TYPES.has(String((raw as { t?: unknown }).t)));
}

/** The remote key a `key` command presses: ⌘ from a Mac becomes Ctrl on the
 *  (Linux) server's browser and the reverse for a Mac dev box, so ⌘C/V/A/Z do
 *  the same thing there as at home. '' for a name the batch must drop. */
export function remoteKey(s: Session, raw: unknown): string {
  const key = typeof raw === 'string' && raw.length <= 20 ? raw : '';
  const remoteMac = s.backend === 'app' ? tunnelStatus(s.userId).platform === 'darwin' : s.backend === 'local' && process.platform === 'darwin';
  return key === 'Meta' && !remoteMac ? 'Control' : key === 'Control' && remoteMac ? 'Meta' : key;
}

/** The human's input, one batch as the client sent it. Every field is
 *  re-checked here — the body is untrusted. Throws on the first failing
 *  navigation command; pointer/key errors (an unknown key name) are dropped. */
export async function runCmds(s: Session, cmds: unknown): Promise<void> {
  const batch = normalizeCmds(cmds);
  s.lastUsed = Date.now();
  for (const raw of batch) {
    const c = raw as Partial<Cmd> & Record<string, unknown>;
    const { mouse, keyboard } = s.page;
    const { width: vw, height: vh } = s.viewport;
    // Through Playwright's mouse, never raw CDP: the agent's page.mouse/click
    // share its position and button state. A move to where the pointer
    // already is (a click after the move that got it there) is skipped —
    // one CDP round trip per click instead of two.
    const moveTo = async (x: number, y: number) => {
      if (s.pointer && s.pointer.x === x && s.pointer.y === y) return;
      await mouse.move(x, y);
      s.pointer = { x, y };
    };
    try {
      switch (c.t) {
        case 'move':
          await moveTo(num(c.x, vw), num(c.y, vh));
          break;
        case 'down':
        case 'up': {
          await moveTo(num(c.x, vw), num(c.y, vh));
          const opts = { button: BUTTONS[num(c.button, 2)], clickCount: Math.max(1, num(c.clicks, 3)) };
          await (c.t === 'down' ? mouse.down(opts) : mouse.up(opts));
          break;
        }
        case 'wheel':
          await moveTo(num(c.x, vw), num(c.y, vh));
          await mouse.wheel(num(Number(c.dx) + 5000, 10_000) - 5000, num(Number(c.dy) + 5000, 10_000) - 5000);
          break;
        case 'key': {
          // The client sends its own modifier; the remote OS decides what it means.
          const key = remoteKey(s, c.key);
          if (key) await (c.type === 'up' ? keyboard.up(key) : keyboard.down(key));
          break;
        }
        case 'text':
          if (typeof c.text === 'string' && c.text.length <= 10_000) await keyboard.insertText(c.text);
          break;
        case 'goto':
          await goto(s, String(c.url ?? ''));
          break;
        case 'back':
          await s.page.goBack({ waitUntil: 'commit', timeout: NAV_MS });
          break;
        case 'forward':
          await s.page.goForward({ waitUntil: 'commit', timeout: NAV_MS });
          break;
        case 'reload':
          await s.page.reload({ waitUntil: 'commit', timeout: NAV_MS });
          break;
        case 'resize':
          await resize(s, num(c.w, MAX_VIEW.width), num(c.h, MAX_VIEW.height));
          break;
        case 'tab': {
          const p = s.pages[num(c.i, 99)];
          if (p) await activate(s, p);
          break;
        }
        case 'newtab':
          if (s.pages.length < 8) await newPage(s);
          break;
        case 'closetab': {
          const p = s.pages[num(c.i, 99)];
          if (p) {
            // Keep a live page throughout the operation. Creating one from
            // the close event leaves subsequent input targeting a closed tab.
            const next = s.pages.findLast(tab => tab !== p && !tab.isClosed()) ?? await newPage(s);
            if (s.page === p) await activate(s, next);
            await p.close();
          }
          break;
        }
      }
    } catch (err) {
      if (c.t === 'goto' || c.t === 'back' || c.t === 'forward' || c.t === 'reload' || c.t === 'newtab' || c.t === 'closetab') throw err;
    }
  }
}

/** Serialize the agent's operations on one session. Human input goes around
 *  this on purpose: a person mid-click must never queue behind a 30s goto. */
export function withSession<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  if (s.closing) return Promise.reject(new Error('Browser is closing — retry after it reconnects.'));
  s.pointer = undefined; // the agent moves the mouse on its own: the human's next click moves first
  s.operations = (s.operations ?? 0) + 1;
  const run = s.chain.then(fn, fn).finally(() => {
    s.operations!--;
    s.lastUsed = Date.now();
  });
  s.chain = run.catch(() => {});
  s.lastUsed = Date.now();
  return run;
}

// ------------------------------------------------------------- screencast

/** Events flow while at least one subscriber is attached; frames are encoded only
 *  while one still wants them — `jpeg(false)` once that viewer is on WebRTC, `jpeg(true)`
 *  when that ends. Returns the unsubscribe, carrying `jpeg`. */
export function subscribe(s: Session, fn: (e: BrowserEvent) => void, jpeg = true): (() => void) & { jpeg: (on: boolean) => void } {
  s.subs.set(fn, { jpeg });
  s.lastUsed = Date.now();
  recast(s);
  const unsub = () => {
    if (!s.subs.delete(fn)) return;
    s.lastUsed = Date.now();
    recast(s);
  };
  return Object.assign(unsub, { jpeg: (on: boolean) => { const o = s.subs.get(fn); if (!o || o.jpeg === on) return; o.jpeg = on; recast(s); } });
}
const wantsJpeg = (s: Session): boolean => [...s.subs.values()].some(o => o.jpeg);
/** Start or stop the screencast to match who still wants frames. */
function recast(s: Session): void {
  if (wantsJpeg(s)) startCast(s);
  else if (s.cast) void stopCast(s);
}

function startCast(s: Session): void {
  if (s.cast || !wantsJpeg(s) || s.closing) return;
  const page = s.page;
  const stopped = s.castStop;
  const max = { width: Math.round(s.viewport.width * s.dsf), height: Math.round(s.viewport.height * s.dsf) };
  s.castMax = max;
  const cast = (async () => {
    await stopped;
    const cdp = await s.context.newCDPSession(page);
    cdp.on('Page.screencastFrame', (e: { data: string; sessionId: number }) => {
      // Ack first, always — chromium stops sending without it.
      void cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
      if (s.cast === cast && s.page === page) emit(s, { type: 'frame', data: e.data, width: s.viewport.width, height: s.viewport.height });
    });
    try { await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: max.width,
      maxHeight: max.height,
      everyNthFrame: 1,
    }); } catch (error) { await cdp.detach().catch(() => {}); throw error; }
    return cdp;
  })();
  s.cast = cast;
  cast.catch(() => {
    if (s.cast === cast) s.cast = undefined;
  });
}

function stopCast(s: Session): Promise<void> {
  const cast = s.cast;
  if (!cast) return s.castStop ?? Promise.resolve();
  s.cast = undefined;
  // A new cast waits for this stop; an old stop must never stop its replacement.
  return s.castStop = (async () => {
    const cdp = await cast.catch(() => null);
    if (!cdp) return;
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  })();
}

// ---------------------------------------------------------------- capture

const isStreamPage = (p: Page): boolean => p.url().startsWith(STREAM_EXTENSION.origin);
/** The ward's tabs: every page of the context but the capture page. */
const userPages = (context: BrowserContext): Page[] => context.pages().filter(p => !isStreamPage(p));

/** The capture page (assets/browser-extensions/stream), opened so it is never a tab of the
 *  ward, kept behind the active page, reopened once if something closes it. Without it the
 *  ward is what it was: JPEG frames for everyone. */
async function openStreamer(s: Session, retry = true): Promise<void> {
  if (s.backend !== 'local' || s.closing) return;
  let mine: Page | undefined;
  try {
    const page = await quiet(s.context, async () => {
      const p = mine = await s.context.newPage();
      try {
        await p.exposeBinding('rwSignal', (source, raw: unknown) => { if (source.frame.url().startsWith(STREAM_EXTENSION.origin)) streamSignal(s, raw); });
        await p.goto(STREAM_EXTENSION.origin + 'stream.html', { timeout: 10_000, waitUntil: 'domcontentloaded' });
      } catch (error) { await p.close().catch(() => {}); throw error; }
      return p;
    });
    if (s.closing) { await page.close().catch(() => {}); return; }
    s.stream = { page, rev: s.stream?.rev ?? 0 };
    page.on('close', () => {
      if (s.stream?.page !== page) return;
      s.stream = undefined;
      for (const [conn, sink] of s.rtc) sink({ conn, state: 'closed' }); // its peers died with it
      if (retry && !s.closing) s.streamOpening = openStreamer(s, false);
    });
    await s.page.bringToFront().catch(() => {});
    tell(s, { sound: s.sound, size: captureSize(s) });
  } catch (error) {
    if (s.closing) return;
    console.warn('[browser] capture page unavailable, frames stay JPEG:', error instanceof Error ? error.message.split('\n')[0] : error);
    if (retry) setTimeout(() => { if (!s.closing && !s.stream) s.streamOpening = openStreamer(s, false); }, 2_000).unref?.();
  } finally {
    // A popup that arrived while the event was quiet is a tab like any other.
    for (const p of s.quietPages.splice(0)) if (p !== mine) adopt(s, p);
  }
}
/** A command for the capture page (stream.js rwIn). A gone page is a lost message, never a throw. */
export function tell(s: Session, msg: Record<string, unknown>): void {
  void s.stream?.page.evaluate((m) => (window as unknown as { rwIn?: (m: unknown) => boolean }).rwIn?.(m), msg).catch(() => {});
}
/** Follow the active tab: the capture page takes the tab from the activation `bringToFront` fired. */
function capture(s: Session): void {
  if (!s.stream) return;
  tell(s, { capture: { rev: ++s.stream.rev, size: captureSize(s) } });
}
/** The capture's pixel size: CSS px on a server (software encode, no GPU), the
 *  device scale on a desktop (hardware encode). */
export function captureSize(s: Session): { w: number; h: number } {
  const k = isDesktop() ? s.dsf : 1;
  return { w: Math.round(s.viewport.width * k), h: Math.round(s.viewport.height * k) };
}
function streamSignal(s: Session, raw: unknown): void {
  let msg: unknown;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  const m = msg as { event?: string; message?: string; conn?: unknown };
  if (m.event) { if (m.event === 'error') console.warn('[browser] capture:', m.message); return; }
  if (typeof m.conn !== 'string') return;
  s.rtc.get(m.conn)?.(m as StreamSignal);
}

// -------------------------------------------------------------- lifecycle

export function closeSession(s: Session): Promise<void> {
  return s.closing ??= closeBrowser(s);
}

/** The ward's sound knob changed: the capture page applies it live. A browser
 *  without one relaunches if idle — unless the agent is on it, in which case
 *  the change waits for the next launch. */
export function setSound(userId: number, ward: string, sound: boolean): void {
  const s = peek(userId, ward);
  if (!s) return;
  s.sound = sound;
  if (s.stream) tell(s, { sound });
  else if (!s.operations && !s.closing) void closeSession(s).catch(() => {});
}

async function closeBrowser(s: Session): Promise<void> {
  if (s.backend === 'browserbase') await extensionStorage(s.context, s.userId, s.ward, false).catch(error => console.warn('[browser] Could not save extension settings:', error instanceof Error ? error.message : error));
  s.unsubRoute?.();
  // The capture page must not be in the session Chromium saves: macOS restore would bring
  // it back as a tab (blank, before the extension loads — invisible to the launch-time filter).
  await Promise.race([s.streamOpening?.catch(() => {}), sleep(3_000)]);
  const stream = s.stream;
  s.stream = undefined;
  if (stream) await Promise.race([stream.page.close().catch(() => {}), sleep(1_000)]);
  await Promise.race([saveView(s), sleep(1_000)]);
  // Graceful first (Browser.close flushes the profile); if the browser won't
  // go, the process scan below will. A stalled CDP screencast must not prevent
  // that deadline from starting.
  const closed = await Promise.race([(async () => { await stopCast(s); await s.close(); return true; })().catch(() => true), sleep(CLOSE_MS).then(() => false)]);
  if (!closed && s.backend === 'local') killByProfile(path.join(PROFILES, String(s.userId), s.ward));
  if (sessions.get(s.key) === s) sessions.delete(s.key);
  emit(s, { type: 'closed' });
}

/** The ward is gone from the layout: close the browser and forget everything
 *  it kept — the local profile, or the Browserbase context pointer. */
export async function dropSession(userId: number, ward: string): Promise<void> {
  if (!WARD_RE.test(ward)) return;
  const s = sessions.get(`${userId}:${ward}`);
  if (s) await closeSession(s);
  await moveDownloads(userId, ward);
  fs.rmSync(path.join(PROFILES, String(userId), ward), { recursive: true, force: true });
  dropBrowserbase(userId, ward);
}

/** Preserve a browser's profile when a desktop joins an existing instance. */
export async function rekeySession(userId: number, before: string, after: string): Promise<void> {
  if (!WARD_RE.test(before) || !WARD_RE.test(after)) throw Error('Invalid browser ward');
  const active = sessions.get(`${userId}:${before}`);
  if (active) await closeSession(active);
  const source = path.join(PROFILES, String(userId), before), target = path.join(PROFILES, String(userId), after);
  if (fs.existsSync(source)) fs.renameSync(source, target);
  await moveDownloads(userId, before, after);
  const { getDb } = await import('../db.ts');
  getDb().prepare('UPDATE settings SET key=? WHERE key=?').run(`browserbase_ctx:${userId}:${after}`, `browserbase_ctx:${userId}:${before}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** SIGKILL every chromium whose profile sits under `prefix`. At boot that is
 *  everything a SIGKILLed predecessor (pm2 max_memory_restart) left behind. */
export function killByProfile(prefix: string): number {
  let out = '';
  try {
    out = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand',
          Buffer.from('$ProgressPreference = "SilentlyContinue"; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process -Property ProcessId,CommandLine -Filter "CommandLine LIKE \'%--user-data-dir=%\'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }', 'utf16le').toString('base64'),
        ], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      : execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 10_000 });
  } catch (error) {
    console.warn('[browser] Profile cleanup failed:', (error as NodeJS.ErrnoException).code ?? 'process query failed');
    return 0;
  }
  let killed = 0;
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !m[2]!.includes(`--user-data-dir=${prefix}`)) continue;
    try {
      process.kill(Number(m[1]), 'SIGKILL');
      killed++;
    } catch {}
  }
  return killed;
}

function reap(): void {
  const now = Date.now();
  for (const s of sessions.values()) if (!s.subs.size && !s.operations && now - s.lastUsed > IDLE_MS) void closeSession(s);
}

async function shutdown(): Promise<void> {
  await Promise.all([...sessions.values()].map(closeSession));
}

/** Boot once per process: sweep orphans, reap idle sessions, close cleanly on
 *  the signals pm2 sends (kill_timeout in ecosystem.config.cjs leaves room). */
export function ensureBrowser(): void {
  const g = globalThis as { __fdBrowser?: true };
  if (g.__fdBrowser) return;
  g.__fdBrowser = true;
  killByProfile(PROFILES + path.sep);
  setInterval(reap, 60_000).unref();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      const terminals = isDesktop() ? import('../dev/terminals.ts').then(m => m.shutdownTerminals()) : Promise.resolve();
      const voice = import('../agent/voice.ts').then(m => m.shutdownVoice());
      const embeddings = import('../agent/embedding-local.ts').then(m => m.shutdownEmbeddings());
      const knowledge = import('../agent/knowledge.ts').then(m => m.shutdownKnowledge());
      const monitors = import('../agent/monitors.ts').then(m => m.shutdownAgentMonitors());
      void Promise.race([Promise.all([shutdown(), terminals, voice, embeddings, knowledge, monitors]), sleep(CLOSE_MS + 1_000)]).finally(() => process.exit(0));
    });
  }
}
