// One terminal pane: an xterm over one session. Owns the screen, the output
// sequence (gap = snapshot resync), input over the ward's WebSocket (serial-
// acknowledged; unacked at a drop = "unconfirmed") or the POST fallback, its
// own fit/resize, the shortcut layer and the display prefs. The ward composes
// panes into groups (lib/dev/terminal-layout.ts) and owns everything that is
// about the session LIST: tabs, launching, control, the footer.
import { Terminal } from "@xterm/xterm";
import { shareView } from "./share-view.ts";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { WebglAddon } from "@xterm/addon-webgl";
import { el, toast } from "./dom.ts";
import { icon } from "./icon.ts";
import { TerminalInput } from "./terminal-input.ts";
import { nextSerial, owner, type InputAck, type TerminalStream } from "./terminal-stream.ts";
import { terminalNeedsRestore, type RuntimeEvent, type SessionView } from "../../lib/dev/types.ts";
import type { readSession } from "../../lib/dev/terminals.ts";

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
/** The ward's modifier: ⌘, or Ctrl+Shift (plain Ctrl belongs to the shell). */
export const mod = (e: KeyboardEvent): boolean => e.metaKey || (e.ctrlKey && e.shiftKey);

export interface Prefs {
  font: string; size: number; lineHeight: number; weight: number; boldWeight: number;
  cursor: "block" | "underline" | "bar"; blink: boolean; optionMeta: boolean; contrast: number; scrollback: number; webgl: boolean;
}
export const DEFAULT_PREFS: Prefs = {
  font: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace', size: 13, lineHeight: 1.2, weight: 400, boldWeight: 700,
  cursor: "block", blink: true, optionMeta: true, contrast: 1, scrollback: 10000, webgl: true,
};
const PREFS_KEY = "rimeward-terminal-prefs";
const num = (v: unknown, lo: number, hi: number, d: number) => typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
export function readPrefs(): Prefs {
  let raw: Partial<Prefs> = {};
  try { raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"); } catch {}
  const d = DEFAULT_PREFS;
  return {
    font: typeof raw.font === "string" && raw.font.trim() ? raw.font.slice(0, 200) : d.font,
    size: num(raw.size, 9, 28, d.size), lineHeight: num(raw.lineHeight, 1, 1.6, d.lineHeight),
    weight: num(raw.weight, 100, 900, d.weight), boldWeight: num(raw.boldWeight, 100, 900, d.boldWeight),
    cursor: raw.cursor === "underline" || raw.cursor === "bar" ? raw.cursor : "block",
    blink: raw.blink !== false, optionMeta: raw.optionMeta !== false, contrast: num(raw.contrast, 1, 21, d.contrast),
    scrollback: num(raw.scrollback, 1000, 50000, d.scrollback), webgl: raw.webgl !== false,
  };
}
export const savePrefs = (p: Prefs) => localStorage.setItem(PREFS_KEY, JSON.stringify(p));

export interface PaneHost {
  api: <T = unknown>(action: string, data?: Record<string, unknown>, method?: string) => Promise<T>;
  stream: TerminalStream;
  prefs: () => Prefs;
  screenReader: () => boolean;
  /** The ward is saving a control change on this pane: input is paused. */
  busy: (pane: Pane) => boolean;
  /** Session or connection state moved: the ward redraws its footer/tabs. */
  changed: (pane: Pane) => void;
  focused: (pane: Pane) => void;
  /** A ward-level shortcut (split, tabs, find, font…). true = consumed. */
  shortcut: (e: KeyboardEvent, pane: Pane) => boolean;
  close: (pane: Pane) => void;
  /** A pointer went down on the pane's bar: the ward may start a drag. */
  drag: (e: PointerEvent, pane: Pane) => void;
}

export class Pane {
  readonly id: string;
  readonly el = el("div", "term-pane");
  readonly bar = el("div", "term-pane-bar");
  readonly title = el("span", "term-pane-title");
  readonly screen = el("div", "dev-terminal");
  readonly term: Terminal;
  readonly search = new SearchAddon();
  session?: SessionView;
  connected = false;
  streamReady = false;
  failure = "";
  uncertain = false;
  disposed = false;
  private readonly host: PaneHost;
  private readonly fit = new FitAddon();
  private gpu?: WebglAddon;
  private sequence?: number;
  private updating?: Promise<void>;
  private painting?: Promise<void>;
  private outputs: { sequence: number; data: string }[] = [];
  private outputSize = 0;
  private resync = false;
  private retrySnapshot?: ReturnType<typeof setTimeout>;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private resizing = false;
  private lastSize = "";
  private restored = false;
  private readonly outstanding = new Set<number>();
  private readonly inputBuffer: TerminalInput;
  private readonly ro: ResizeObserver;

  constructor(id: string, host: PaneHost) {
    this.id = id; this.host = host;
    const p = host.prefs();
    this.term = new Terminal({
      scrollback: p.scrollback, fontSize: p.size, lineHeight: p.lineHeight, fontFamily: p.font, fontWeight: p.weight, fontWeightBold: p.boldWeight,
      cursorStyle: p.cursor, cursorBlink: p.blink, macOptionIsMeta: p.optionMeta, minimumContrastRatio: p.contrast,
      theme: { background: "#101419", foreground: "#e4e9f0", cursor: "#c5d6e8" },
      disableStdin: true, screenReaderMode: host.screenReader(),
      allowProposedApi: true, rightClickSelectsWord: true,
      // The kitty keyboard protocol (xterm 6.1 beta): Claude Code and Codex
      // negotiate it and get Shift+Enter, Ctrl+Enter and a distinct Esc.
      vtExtensions: { kittyKeyboard: true },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(new WebLinksAddon((event, url) => {
      if ((event.ctrlKey || event.metaKey) && /^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
    }));
    // OSC 52: what tmux, neovim and the agent CLIs use to copy into the clipboard.
    this.term.parser.registerOscHandler(52, data => {
      const b64 = data.split(";")[1];
      if (b64 && b64 !== "?") try { void navigator.clipboard.writeText(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)))); } catch {}
      return true;
    });
    const close = el("button", "term-tool term-pane-close");
    close.type = "button"; close.title = "Close pane"; close.setAttribute("aria-label", "Close pane"); close.append(icon("close"));
    close.onclick = () => host.close(this);
    this.bar.append(this.title, close);
    this.bar.hidden = true;
    this.bar.onpointerdown = e => { if (e.target === close || close.contains(e.target as globalThis.Node)) return; host.drag(e, this); };
    this.screen.setAttribute("role", "tabpanel");
    this.el.append(this.bar, this.screen);
    this.el.dataset.session = id;
    this.term.open(this.screen);
    this.term.textarea?.addEventListener("focus", () => host.focused(this));
    this.el.addEventListener("pointerdown", () => host.focused(this), true);
    this.term.attachCustomKeyEventHandler(e => this.key(e));
    this.term.onData(data => this.send(data));
    this.term.onBinary(data => this.send(data, true));
    this.inputBuffer = new TerminalInput(async (sid, data, binary) => {
      if (this.disposed || !this.canType()) return;
      await host.api("input", { id: sid, data, binary }, "POST");
    }, (_, error) => { this.uncertain = true; if (!this.disposed) { this.draw(); toast((error as Error).message, undefined, true); } });
    this.setGpu(p.webgl);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.screen);
    void document.fonts.ready.then(() => { if (!this.disposed) this.resize(); });
    host.stream.sub(id);
  }

  canType(): boolean {
    return !this.disposed && !shareView && !!this.session && this.connected && this.streamReady && this.session.state === "running" &&
      this.session.owner === owner && !this.uncertain;
  }
  writable(): boolean { return this.canType() && !this.host.busy(this); }
  renderer(): "webgl" | "dom" { return this.gpu ? "webgl" : "dom"; }

  private key(e: KeyboardEvent): boolean {
    if (mod(e) && e.type === "keydown" && this.host.shortcut(e, this)) { e.preventDefault(); return false; }
    return !mod(e) || !SHORTCUT_KEYS.has(e.key.toLowerCase());
  }

  send(data: string, binary = false): void {
    if (!this.session || !this.writable()) return;
    if (this.host.stream.live()) {
      const n = nextSerial();
      this.outstanding.add(n);
      if (!this.host.stream.send({ t: "in", id: this.id, data, binary, n })) this.outstanding.delete(n);
    } else this.inputBuffer.send(this.id, data, binary);
  }
  ack(a: InputAck): void {
    if (a.id !== this.id || !this.outstanding.delete(a.n)) return;
    if (a.error) { this.uncertain = true; this.draw(); toast(a.error, undefined, true); }
  }
  interrupt(): void { if (this.host.stream.live()) this.host.stream.send({ t: "int", id: this.id }); else void this.host.api("interrupt", { id: this.id }, "POST").catch(e => toast(e.message, undefined, true)); }

  /** A runtime event from the ward's stream (null = the stream dropped). */
  event(ev: RuntimeEvent | null): void {
    if (this.disposed) return;
    if (!ev) {
      this.streamReady = false; this.inputBuffer.clear();
      // Sent, not acknowledged: the runtime may or may not have taken it.
      if (this.outstanding.size) { this.uncertain = true; this.outstanding.clear(); }
      this.draw(); return;
    }
    if (ev.type === "reset") { this.streamReady = true; this.resync = true; void this.update(); return; }
    if (ev.type === "session" && ev.id === this.id && ev.data) {
      this.session = ev.data as SessionView;
      if (!this.canType()) { this.inputBuffer.clear(); this.term.resize(this.session.cols, this.session.rows); }
      this.draw();
      if (this.updating) this.resync = true;
      return;
    }
    if (ev.type !== "output" || ev.id !== this.id) return;
    const chunk = ev.data as { sequence: number; data: string };
    if (this.outputSize + chunk.data.length > 1024 * 1024) { this.outputs = []; this.outputSize = 0; this.resync = true; }
    else { this.outputs.push(chunk); this.outputSize += chunk.data.length; }
    this.drainOutput();
  }
  private drainOutput(): void {
    if (this.disposed || this.updating || this.painting) return;
    if (this.resync) { void this.update(); return; }
    const chunks = this.outputs;
    this.outputs = []; this.outputSize = 0;
    let next = this.sequence;
    const text: string[] = [];
    for (const chunk of chunks) {
      if (next !== undefined && chunk.sequence <= next) continue;
      if (next === undefined || chunk.sequence !== next + 1) { this.resync = true; void this.update(); return; }
      next = chunk.sequence;
      text.push(chunk.data);
    }
    if (!text.length) return;
    this.painting = new Promise<void>(resolve => this.term.write(text.join(""), resolve)).then(() => { this.sequence = next; })
      .finally(() => { this.painting = undefined; this.drainOutput(); });
  }
  /** The snapshot: everything since the last sequence, or the whole screen. */
  update(): Promise<void> {
    if (this.updating) return this.updating;
    if (this.disposed) return Promise.resolve();
    clearTimeout(this.retrySnapshot);
    this.updating = (async () => {
      try {
        await this.painting;
        this.resync = false;
        const read = () => this.host.api<ReturnType<typeof readSession>>("sessions", { id: this.id, ...(this.sequence === undefined ? {} : { after: this.sequence }) });
        let result = await read();
        if (this.disposed) return;
        if (terminalNeedsRestore(result.session) && !this.restored && !shareView) {
          this.restored = true;
          await this.host.api("restart", { id: this.id }, "POST").catch(e => toast(e.message, undefined, true));
          result = await read();
          if (this.disposed) return;
        }
        this.session = result.session;
        if (result.session.cols !== this.term.cols || result.session.rows !== this.term.rows) this.term.resize(result.session.cols, result.session.rows);
        if (result.reset) this.term.reset();
        if (result.data) await new Promise<void>(resolve => this.term.write(result.data, resolve));
        this.sequence = result.session.sequence;
        // A share's viewer never claims an unowned session; everyone else does, so typing works at once.
        if (this.session.state === "running" && !this.session.owner && !this.uncertain && !shareView)
          this.session = await this.host.api<SessionView>("control", { id: this.id }, "POST").catch(e => { if (e.status === 409) return this.session as SessionView; throw e; });
        this.connected = true;
        this.failure = "";
      } catch (e) {
        this.connected = false;
        // A dead session, a refused route or a vanished desktop will not fix itself in 3 s: say why, retry slowly.
        this.failure = [401, 403, 404].includes((e as { status?: number }).status ?? 0) ? (e as Error).message : "";
        if (!this.disposed) this.retrySnapshot = setTimeout(() => void this.update(), this.failure ? 30000 : 3000);
      } finally {
        if (!this.disposed) { this.draw(); this.resize(); }
      }
    })().finally(() => { this.updating = undefined; if (this.connected) this.drainOutput(); });
    return this.updating;
  }
  /** After a takeover or a review: the lease is ours again. */
  reclaim(): void { this.uncertain = false; this.outstanding.clear(); }
  /** The POST fallback's queued keystrokes, delivered (the socket path has none). */
  flush(): Promise<void> { return this.inputBuffer.flush(); }

  draw(): void {
    if (this.disposed) return;
    this.term.options.disableStdin = !this.writable();
    this.title.textContent = this.session?.title ?? "";
    this.host.changed(this);
  }
  resize(): void {
    if (this.disposed || !this.canType() || !this.screen.clientWidth || !this.screen.clientHeight) return;
    const size = this.fit.proposeDimensions();
    if (size && Number.isFinite(size.cols) && Number.isFinite(size.rows)) this.term.resize(Math.max(20, Math.min(400, size.cols)), Math.max(5, Math.min(150, size.rows)));
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => void this.sendSize(), 40);
  }
  private async sendSize(): Promise<void> {
    if (this.resizing || !this.canType()) return;
    const cols = this.term.cols, rows = this.term.rows, size = `${cols}:${rows}`;
    if (this.lastSize === size) return;
    if (this.host.stream.live()) { if (this.host.stream.send({ t: "rs", id: this.id, cols, rows })) this.lastSize = size; return; }
    this.resizing = true;
    try { await this.host.api("resize", { id: this.id, cols, rows }, "POST"); this.lastSize = size; }
    catch { this.lastSize = ""; }
    finally { this.resizing = false; }
    if (this.canType() && (this.term.cols !== cols || this.term.rows !== rows)) this.resize();
  }
  applyPrefs(p: Prefs): void {
    const o = this.term.options;
    o.fontFamily = p.font; o.fontSize = p.size; o.lineHeight = p.lineHeight; o.fontWeight = p.weight; o.fontWeightBold = p.boldWeight;
    o.cursorStyle = p.cursor; o.cursorBlink = p.blink; o.macOptionIsMeta = p.optionMeta; o.minimumContrastRatio = p.contrast; o.scrollback = p.scrollback;
    this.setGpu(p.webgl);
    this.resize();
  }
  private setGpu(on: boolean): void {
    if (!on) { this.gpu?.dispose(); this.gpu = undefined; return; }
    if (this.gpu) return;
    void import("@xterm/addon-webgl").then(({ WebglAddon }) => {
      if (this.disposed || this.gpu || !this.host.prefs().webgl) return;
      let gpu: WebglAddon | undefined;
      try { gpu = new WebglAddon(); gpu.onContextLoss(() => { gpu?.dispose(); if (this.gpu === gpu) this.gpu = undefined; }); this.term.loadAddon(gpu); this.gpu = gpu; }
      catch { gpu?.dispose(); } // DOM renderer remains available without a GPU.
      this.host.changed(this);
    }).catch(() => {});
  }
  focus(): void { this.term.focus(); }
  setActive(on: boolean): void { this.el.dataset.focus = String(on); }
  showBar(on: boolean): void { this.bar.hidden = !on; this.resize(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host.stream.unsub(this.id);
    clearTimeout(this.resizeTimer); clearTimeout(this.retrySnapshot); this.inputBuffer.clear();
    this.ro.disconnect(); this.term.dispose(); this.el.remove();
  }
}
/** Keys the ward claims under `mod` on every event type (down, press, up). */
const SHORTCUT_KEYS = new Set(["f", "c", "v", "k", "d", "e", "[", "]", "+", "=", "-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
