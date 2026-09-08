import { terminalEnv } from '../dev/environment.ts';
import { isDesktop } from '../dev/runtime.ts';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { DATA_DIR } from '../db.ts';
import { httpUrl, type BrowserConfig } from '../wards.ts';
import { guardFor, guardPort, type Dial } from './guard.ts';
import { connectBrowserbase, dropBrowserbase } from './browserbase.ts';
import { connectApp } from './app-backend.ts';
import { publicAddress } from '../net-guard.ts';
import { openStream, subscribeTunnel, tunnelOnline, tunnelStatus } from '../tunnel.ts';
import { captureDownload, listDownloads, moveDownloads, type BrowserDownload } from './downloads.ts';
import { extensionPaths, extensionStorage, cleanExtensions, extensionMaintenance } from './extensions.ts';

// One live browser per browser ward, keyed `${userId}:${ward}`. The human
// (screencast out over SSE, input in over POST) and the agent (tools) share
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
  | { type: 'closed' };

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
  subs: Set<(e: BrowserEvent) => void>;
  lastUsed: number;
  /** Agent operations serialize here; the human's input never waits on it. */
  chain: Promise<unknown>;
  operations?: number;
  close: () => Promise<void>;
  closing?: Promise<void>;
  cast?: Promise<CDPSession>;
  castStop?: Promise<void>;
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
export function open(userId: number, ward: string, cfg: BrowserConfig): Promise<Session> {
  if (!WARD_RE.test(ward)) return Promise.reject(new Error('bad ward id'));
  const key = `${userId}:${ward}`;
  const live = sessions.get(key);
  if (live) {
    if (live.closing) return live.closing.then(() => open(userId, ward, cfg));
    live.lastUsed = Date.now();
    return Promise.resolve(live);
  }
  let p = opening.get(key);
  if (!p) {
    p = launch(userId, ward, key, cfg).finally(() => opening.delete(key));
    opening.set(key, p);
  }
  return p;
}

async function launch(userId: number, ward: string, key: string, cfg: BrowserConfig): Promise<Session> {
  if(isDesktop())cfg={...cfg,backend:cfg.backend==='app'?'local':cfg.backend,route:undefined};
  ensureBrowser();
  await makeRoom();
  const backend =
    cfg.backend === 'browserbase' ? await connectBrowserbase(userId, ward)
    : cfg.backend === 'app' ? await connectApp(userId, ward)
    : await launchLocal(userId, ward, cfg);
  const { context } = backend;
  try { if (cfg.backend === 'browserbase') await extensionStorage(context, userId, ward, true); }
  catch (error) { await backend.close(); throw error; }
  const restored = restoreDesktop() && cfg.backend !== 'browserbase' ? await restoreView(context, userId, ward) : null;
  const page = restored?.page ?? context.pages()[0] ?? (await context.newPage());
  const s: Session = {
    key,
    userId,
    ward,
    backend: cfg.backend,
    route: cfg.route,
    context,
    pages: restored?.pages ?? context.pages(),
    pageReady: new WeakMap(),
    page,
    viewport: { ...DEFAULT_VIEWPORT },
    subs: new Set(),
    lastUsed: Date.now(),
    chain: Promise.resolve(),
    close: backend.close,
  };
  for (const p of s.pages) watchPage(s, p);
  if (s.route === 'home') s.unsubRoute = subscribeTunnel(userId, (online) => emit(s, { type: 'route', online }));
  // Popups (OAuth consent, "open in new window") become tabs and take focus.
  context.on('page', (p) => {
    if (extensionMaintenance(context)) return;
    s.pages.push(p);
    watchPage(s, p);
    const ready = activate(s, p);
    s.pageReady.set(p, ready);
    void ready.catch(() => {}); // explicit new-tab commands await and report it
  });
  context.on('close', () => {
    // Crashed, or closed by us: either way the viewers reconnect and relaunch.
    if (sessions.get(key) === s) sessions.delete(key);
    emit(s, { type: 'closed' });
  });
  sessions.set(key, s);
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
    await publicAddress(host);
    return openStream(userId, `${host}:${port}`);
  };

/** The shell allowlist minus the two things a browser has no use for and must not hold. */
function browserEnv(): Record<string, string> {
  const { SSH_AUTH_SOCK: _agent, SHELL: _shell, ...env } = terminalEnv();
  return env;
}
async function launchLocal(userId: number, ward: string, cfg: BrowserConfig): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
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
    acceptDownloads: true,
    downloadsPath: downloads,
    // Chromium restores history, scroll positions and form state itself. A
    // forced blank startup tab would take the place of the restored page.
    ignoreDefaultArgs: ['--disable-extensions', ...(restoreDesktop() ? ['about:blank'] : [])],
    args: [
      '--enable-unsafe-extension-debugging',
      ...(extensions.length ? [`--load-extension=${extensions.join(',')}`] : []),
      ...(restoreDesktop() ? ['--restore-last-session'] : []),
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', // no unproxied UDP out of ICE
      '--disk-cache-size=52428800', // the profile's size cap, in effect
    ],
  });
  if (restoreDesktop() && context.pages().length === 1 && context.pages()[0]!.url().startsWith('chrome://new-tab-page'))
    await context.pages()[0]!.goto('about:blank');
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
    const available = await Promise.all(context.pages().map(async page => ({ page, ...await tabView(context, page) })));
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
  for (const sub of s.subs) sub(ev);
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
  await pushNav(s);
  await pushTabs(s);
  if (s.route === 'home') emit(s, { type: 'route', online: tunnelOnline(s.userId) });
  for (const file of listDownloads(s.userId, s.ward).filter(f => f.status === 'downloading')) emit(s, { type: 'download', file });
}

/** Switch the active tab; the screencast (if running) follows. */
export async function activate(s: Session, page: Page): Promise<void> {
  if (s.page !== page) {
    s.page = page;
    await stopCast(s);
    if (s.page !== page || s.closing) return; // A newer tab selection owns the cast.
    await page.setViewportSize(s.viewport).catch(() => {});
    if (s.page !== page) return;
    startCast(s);
  }
  await pushState(s);
}

async function newPage(s: Session): Promise<Page> {
  const page = await s.context.newPage();
  // The context event installs the tab before newPage resolves, but its
  // screencast/selection work is asynchronous. Do not activate it twice.
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
  // The screencast's max size is fixed at start — restart it at the new one.
  if (s.cast) {
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
  | { t: 'resize'; w: number; h: number }
  | { t: 'tab'; i: number }
  | { t: 'newtab' }
  | { t: 'closetab'; i: number };

const BUTTONS = ['left', 'middle', 'right'] as const;
const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0);

/** The human's input, one batch as the client sent it. Every field is
 *  re-checked here — the body is untrusted. Throws on the first failing
 *  navigation command; pointer/key errors (an unknown key name) are dropped. */
export async function runCmds(s: Session, cmds: unknown): Promise<void> {
  if (!Array.isArray(cmds) || cmds.length > 200) throw new Error('bad batch');
  s.lastUsed = Date.now();
  const remoteMac = s.backend === 'app' ? tunnelStatus(s.userId).platform === 'darwin' : s.backend === 'local' && process.platform === 'darwin';
  for (const raw of cmds) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Partial<Cmd> & Record<string, unknown>;
    const { mouse, keyboard } = s.page;
    const { width: vw, height: vh } = s.viewport;
    try {
      switch (c.t) {
        case 'move':
          await mouse.move(num(c.x, vw), num(c.y, vh));
          break;
        case 'down':
        case 'up': {
          await mouse.move(num(c.x, vw), num(c.y, vh));
          const opts = { button: BUTTONS[num(c.button, 2)], clickCount: Math.max(1, num(c.clicks, 3)) };
          await (c.t === 'down' ? mouse.down(opts) : mouse.up(opts));
          break;
        }
        case 'wheel':
          await mouse.move(num(c.x, vw), num(c.y, vh));
          await mouse.wheel(num(Number(c.dx) + 5000, 10_000) - 5000, num(Number(c.dy) + 5000, 10_000) - 5000);
          break;
        case 'key': {
          const raw = typeof c.key === 'string' && c.key.length <= 20 ? c.key : '';
          // The client sends its own modifier; the remote OS decides what it
          // means. ⌘ from a Mac becomes Ctrl on the (Linux) server's browser,
          // so ⌘C/V/A/Z do the same thing there as at home — and the reverse
          // for a Mac dev box.
          const key = raw === 'Meta' && !remoteMac ? 'Control' : raw === 'Control' && remoteMac ? 'Meta' : raw;
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

/** Events flow while at least one subscriber is attached; nothing is encoded
 *  for nobody. Returns the unsubscribe. */
export function subscribe(s: Session, fn: (e: BrowserEvent) => void): () => void {
  s.subs.add(fn);
  s.lastUsed = Date.now();
  if (s.subs.size === 1) startCast(s);
  return () => {
    s.subs.delete(fn);
    s.lastUsed = Date.now();
    if (!s.subs.size) void stopCast(s);
  };
}

function startCast(s: Session): void {
  if (s.cast || !s.subs.size || s.closing) return;
  const page = s.page;
  const stopped = s.castStop;
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
      maxWidth: s.viewport.width,
      maxHeight: s.viewport.height,
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

// -------------------------------------------------------------- lifecycle

export function closeSession(s: Session): Promise<void> {
  return s.closing ??= closeBrowser(s);
}

async function closeBrowser(s: Session): Promise<void> {
  if (s.backend === 'browserbase') await extensionStorage(s.context, s.userId, s.ward, false).catch(error => console.warn('[browser] Could not save extension settings:', error instanceof Error ? error.message : error));
  s.unsubRoute?.();
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
          Buffer.from('$ProgressPreference = "SilentlyContinue"; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }', 'utf16le').toString('base64'),
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
      void Promise.race([Promise.all([shutdown(), terminals, voice]), sleep(CLOSE_MS + 1_000)]).finally(() => process.exit(0));
    });
  }
}
