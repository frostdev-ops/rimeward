// The browser ward's LOCAL driver. Inside the Rimeward app, a "My computer"
// ward's Chromium is on this machine, so the page speaks CDP to it directly
// over ws://127.0.0.1 — frames and input never leave the machine; only the
// agent's Playwright (on the server, through the tunnel) shares the browser.
// Same events out (frame/nav/tabs/dialog) and the same Cmd vocabulary in as
// the server's lib/browser/session.ts, so browser.ts cannot tell them apart.

import type { BrowserEvent, Cmd } from '../../lib/browser/session.ts';
import { browserScale, httpUrl } from '../../lib/wards.ts';

/** One CDP websocket, abstracted so the test can fake it. */
export interface Transport {
  send(text: string): void;
  close(): void;
  onmessage?: (text: string) => void;
  onclose?: () => void;
}

interface Target {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

const MIN_VIEW = { width: 320, height: 240 };
const MAX_VIEW = { width: 1920, height: 1200 };
const MAX_TABS = 8;
const BUTTONS = ['left', 'middle', 'right'] as const;
const BUTTON_BITS = [1, 4, 2] as const;
const MOD: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0);

/** The keys a keyDown must mean by itself: virtual key code + DOM code. */
const KEYS: Record<string, [number, string]> = {
  Enter: [13, 'Enter'], Backspace: [8, 'Backspace'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Space: [32, 'Space'],
  Delete: [46, 'Delete'], Insert: [45, 'Insert'], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
  ArrowLeft: [37, 'ArrowLeft'], ArrowUp: [38, 'ArrowUp'], ArrowRight: [39, 'ArrowRight'], ArrowDown: [40, 'ArrowDown'],
  Shift: [16, 'ShiftLeft'], Control: [17, 'ControlLeft'], Alt: [18, 'AltLeft'], Meta: [91, 'MetaLeft'], CapsLock: [20, 'CapsLock'],
};
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = [111 + i, `F${i}`];

/** macOS headless does not turn ⌘-shortcuts into editing commands by itself
 *  (Playwright carries the same table). The ones people reach for. */
const MAC_COMMANDS: Record<string, string[]> = {
  a: ['selectAll'], z: ['undo'], x: ['cut'], c: ['copy'], v: ['paste'],
  ArrowLeft: ['moveToBeginningOfLine'], ArrowRight: ['moveToEndOfLine'], Backspace: ['deleteToBeginningOfLine'],
};

/** Input.dispatchKeyEvent params for a Playwright-style key name, or null
 *  for one CDP cannot express. Pure — the test pins it. */
export function keyEvent(key: string, type: 'down' | 'up', modifiers: number, mac: boolean): Record<string, unknown> | null {
  const special = KEYS[key];
  const base = { modifiers, ...(mac && type === 'down' && modifiers & MOD.Meta && MAC_COMMANDS[key] ? { commands: MAC_COMMANDS[key] } : {}) };
  if (special) {
    return { ...base, type: type === 'down' ? 'rawKeyDown' : 'keyUp', key: key === 'Space' ? ' ' : key, code: special[1], windowsVirtualKeyCode: special[0] };
  }
  if ([...key].length !== 1) return null;
  const upper = key.toUpperCase();
  const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(key) ? `Digit${key}` : '';
  // A held ⌘/Ctrl makes it a shortcut, not a character.
  const text = type === 'down' && !(modifiers & (MOD.Control | MOD.Meta)) ? { text: key, unmodifiedText: key } : {};
  return { ...base, type: type === 'down' ? 'keyDown' : 'keyUp', key, code, windowsVirtualKeyCode: upper.charCodeAt(0), ...text };
}

export class LocalDriver {
  private readonly tr: Transport;
  private readonly emit: (e: BrowserEvent) => void;
  private readonly mac: boolean;
  private next = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  /** Pages in creation order — the tab strip's order. */
  private targets = new Map<string, Target>();
  private sessions = new Map<string, string>();
  private active = '';
  private ready = false;
  viewport = { width: 1280, height: 800 };
  /** This display's scale, emulated for the page (dpr, srcset). The FRAME's
   *  scale follows the Chromium process (--force-device-scale-factor at the
   *  app's launch), so browser.ts reads the real one off each frame's size. */
  dsf = 1;
  private mods = 0;
  private button: (typeof BUTTONS)[number] | 'none' = 'none';
  private buttons = 0;

  constructor(tr: Transport, emit: (e: BrowserEvent) => void, mac = false) {
    this.tr = tr;
    this.emit = emit;
    this.mac = mac;
    tr.onmessage = (text) => this.onMessage(JSON.parse(text) as Msg);
    tr.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('browser closed'));
      this.pending.clear();
      this.emit({ type: 'closed' });
    };
  }

  private call<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      this.tr.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** A command on the active page's session. */
  private page<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
    return this.call<T>(method, params, this.sessions.get(this.active));
  }

  private onMessage(msg: Msg): void {
    if (msg.id) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!p) return;
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (msg.method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const t = params.targetInfo as Target;
        if (t.type !== 'page') return;
        const known = this.targets.has(t.targetId);
        this.targets.set(t.targetId, t);
        // Popups (OAuth consent, "open in new window") become tabs and take focus.
        if (!known && this.ready) void this.activate(t.targetId);
        else if (t.targetId === this.active) this.emit({ type: 'nav', url: t.url, title: t.title });
        this.pushTabs();
        return;
      }
      case 'Target.targetDestroyed': {
        const id = params.targetId as string;
        if (!this.targets.delete(id)) return;
        this.sessions.delete(id);
        if (id === this.active) {
          const last = [...this.targets.keys()].at(-1);
          if (last) void this.activate(last);
          else void this.call('Target.createTarget', { url: 'about:blank' }).catch(() => {}); // targetCreated activates it
        } else this.pushTabs();
        return;
      }
      case 'Target.detachedFromTarget':
        for (const [tid, sid] of this.sessions) if (sid === params.sessionId) this.sessions.delete(tid);
        return;
      case 'Page.screencastFrame': {
        if (msg.sessionId !== this.sessions.get(this.active)) return;
        // Ack first, always — chromium stops sending without it.
        void this.call('Page.screencastFrameAck', { sessionId: params.sessionId }, msg.sessionId).catch(() => {});
        const md = params.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined;
        this.emit({ type: 'frame', data: params.data as string, width: md?.deviceWidth ?? this.viewport.width, height: md?.deviceHeight ?? this.viewport.height });
        return;
      }
      case 'Page.javascriptDialogOpening': {
        if (msg.sessionId !== this.sessions.get(this.active)) return;
        const kind = String(params.type);
        this.emit({ type: 'dialog', kind, message: String(params.message ?? '').slice(0, 500) });
        // beforeunload must be accepted or the page can never leave.
        void this.call('Page.handleJavaScriptDialog', { accept: kind === 'beforeunload' }, msg.sessionId).catch(() => {});
        return;
      }
      case 'Page.frameNavigated': {
        const frame = params.frame as { parentId?: string; url: string };
        if (frame.parentId || msg.sessionId !== this.sessions.get(this.active)) return;
        const t = this.targets.get(this.active);
        this.emit({ type: 'nav', url: frame.url, title: t?.title ?? '' });
        return;
      }
    }
  }

  /** Discover the pages, take the first one, start the screencast. */
  async start(): Promise<void> {
    await this.call('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.call<{ targetInfos: Target[] }>('Target.getTargets');
    for (const t of targetInfos) if (t.type === 'page') this.targets.set(t.targetId, t);
    let first = [...this.targets.keys()][0];
    if (!first) first = (await this.call<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
    this.ready = true;
    await this.activate(first);
  }

  private async activate(id: string): Promise<void> {
    if (!this.targets.has(id)) return;
    if (this.active && this.active !== id && this.sessions.has(this.active)) await this.page('Page.stopScreencast').catch(() => {});
    this.active = id;
    if (!this.sessions.has(id)) {
      const { sessionId } = await this.call<{ sessionId: string }>('Target.attachToTarget', { targetId: id, flatten: true });
      this.sessions.set(id, sessionId);
      await this.call('Page.enable', {}, sessionId).catch(() => {});
    }
    await this.call('Target.activateTarget', { targetId: id }).catch(() => {});
    await this.applyViewport();
    await this.startCast();
    const t = this.targets.get(id);
    if (!t || this.active !== id) return;
    this.emit({ type: 'nav', url: t.url, title: t.title });
    this.pushTabs();
  }

  private pushTabs(): void {
    const tabs = [...this.targets.values()].map((t) => ({ url: t.url, title: t.title }));
    this.emit({ type: 'tabs', tabs, active: [...this.targets.keys()].indexOf(this.active) });
  }

  private applyViewport(): Promise<unknown> {
    return this.page('Emulation.setDeviceMetricsOverride', { ...this.viewport, deviceScaleFactor: this.dsf, mobile: false }).catch(() => {});
  }

  private startCast(): Promise<unknown> {
    return this.page('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: Math.round(this.viewport.width * this.dsf), maxHeight: Math.round(this.viewport.height * this.dsf), everyNthFrame: 1 }).catch(() => {});
  }

  private async resize(width: number, height: number, scale: unknown): Promise<void> {
    const w = Math.round(Math.min(MAX_VIEW.width, Math.max(MIN_VIEW.width, width)));
    const h = Math.round(Math.min(MAX_VIEW.height, Math.max(MIN_VIEW.height, height)));
    const dsf = scale === undefined ? this.dsf : browserScale(scale);
    if (w === this.viewport.width && h === this.viewport.height && dsf === this.dsf) return;
    this.viewport = { width: w, height: h };
    this.dsf = dsf;
    await this.applyViewport();
    // The screencast's max size is fixed at start — restart it at the new one.
    await this.page('Page.stopScreencast').catch(() => {});
    await this.startCast();
  }

  private mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number, button?: number, clicks?: number): Promise<unknown> {
    const i = num(button, 2), name = BUTTONS[i], bit = BUTTON_BITS[i];
    if (!name || bit === undefined) return Promise.resolve();
    if (type !== 'mouseMoved') {
      this.button = type === 'mousePressed' ? name : 'none';
      this.buttons = type === 'mousePressed' ? this.buttons | bit : this.buttons & ~bit;
    }
    return this.page('Input.dispatchMouseEvent', {
      type,
      x: num(x, this.viewport.width),
      y: num(y, this.viewport.height),
      button: type === 'mouseMoved' ? this.button : name,
      buttons: this.buttons,
      clickCount: Math.max(1, num(clicks, 3)),
      modifiers: this.mods,
    });
  }

  /** The same batch semantics as the server's runCmds: navigation errors
   *  throw, pointer/key errors are dropped. */
  async run(cmds: Cmd[]): Promise<void> {
    for (const c of cmds) {
      try {
        switch (c.t) {
          case 'move':
            await this.mouse('mouseMoved', c.x, c.y);
            break;
          case 'down':
          case 'up':
            await this.mouse(c.t === 'down' ? 'mousePressed' : 'mouseReleased', c.x, c.y, c.button, c.clicks);
            break;
          case 'wheel':
            await this.page('Input.dispatchMouseEvent', {
              type: 'mouseWheel',
              x: num(c.x, this.viewport.width),
              y: num(c.y, this.viewport.height),
              deltaX: num(Number(c.dx) + 5000, 10_000) - 5000,
              deltaY: num(Number(c.dy) + 5000, 10_000) - 5000,
              modifiers: this.mods,
            });
            break;
          case 'key': {
            const key = typeof c.key === 'string' && c.key.length <= 20 ? c.key : '';
            if (!key) break;
            const bit = MOD[key];
            if (bit) this.mods = c.type === 'up' ? this.mods & ~bit : this.mods | bit;
            const ev = keyEvent(key, c.type === 'up' ? 'up' : 'down', this.mods, this.mac);
            if (ev) await this.page('Input.dispatchKeyEvent', ev);
            break;
          }
          case 'text':
            if (typeof c.text === 'string' && c.text.length <= 10_000) await this.page('Input.insertText', { text: c.text });
            break;
          case 'goto': {
            const href = httpUrl(String(c.url ?? ''));
            if (!href) throw new Error('http(s) URLs only');
            await this.page('Page.navigate', { url: href });
            break;
          }
          case 'back':
          case 'forward': {
            const h = await this.page<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
            const entry = h.entries[h.currentIndex + (c.t === 'back' ? -1 : 1)];
            if (entry) await this.page('Page.navigateToHistoryEntry', { entryId: entry.id });
            break;
          }
          case 'reload':
            await this.page('Page.reload');
            break;
          case 'resize':
            await this.resize(num(c.w, MAX_VIEW.width), num(c.h, MAX_VIEW.height), c.dsf);
            break;
          case 'tab': {
            const id = [...this.targets.keys()][num(c.i, 99)];
            if (id) await this.activate(id);
            break;
          }
          case 'newtab':
            if (this.targets.size < MAX_TABS) await this.call('Target.createTarget', { url: 'about:blank' }); // targetCreated activates it
            break;
          case 'closetab': {
            const id = [...this.targets.keys()][num(c.i, 99)];
            if (id) await this.call('Target.closeTarget', { targetId: id });
            break;
          }
        }
      } catch (err) {
        if (c.t === 'goto' || c.t === 'back' || c.t === 'forward' || c.t === 'reload') throw err;
      }
    }
  }

  close(): void {
    this.tr.close();
  }
}

interface Msg {
  id?: number;
  method?: string;
  params?: unknown;
  sessionId?: string;
  result?: unknown;
  error?: { message: string };
}
