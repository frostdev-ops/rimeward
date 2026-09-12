import { LiveEventSource } from './live-stream.ts';
import type { RuntimeEvent } from "../../lib/dev/types.ts";
import { shareView } from "./share-view.ts";

/** The input lease identity every terminal on this page shares. */
const store = typeof sessionStorage === "undefined" ? undefined : sessionStorage; // absent under node's unit tests
export const owner = store?.getItem("rimeward-input-owner") ?? `client:${crypto.randomUUID()}`;
store?.setItem("rimeward-input-owner", owner);

export type InputAck = { id: string; n: number; error?: string };
type Listener = (event: RuntimeEvent | null) => void;
type Entry = { ward: string; subs: Set<string>; ack?: (a: InputAck) => void };
interface Stream {
  listeners: Map<Listener, Entry>;
  mode: 'ws' | 'sse';
  socket?: WebSocket;
  source?: LiveEventSource;
  retry?: ReturnType<typeof setTimeout>;
  delay?: number;
  ready?: boolean;
  connect: () => void;
}
export interface TerminalStream {
  stop(): void;
  /** Sends over the socket when it is up. false = use the HTTP route (SSE mode) or drop (socket down). */
  send(msg: object): boolean;
  /** Output for `id` reaches this listener (a no-op on SSE, which carries every session). */
  sub(id: string): void;
  unsub(id: string): void;
  live(): boolean;
}
const streams = new Map<string, Stream>();
let serial = 0;
/** A page-unique input serial: the ack names it back. */
export const nextSerial = () => ++serial;

/** One connection per desktop, shared by all terminal wards: the dedicated
 *  WebSocket first (closed before `hello` = this page cannot upgrade, e.g. a
 *  relayed desktop — the SSE mux then, for good). null = disconnected. */
export function terminalEvents(device: string, ward: string, listener: Listener, ack?: (a: InputAck) => void): TerminalStream {
  let stream = streams.get(device);
  if (!stream) {
    const relayed = typeof document !== "undefined" && !!document.querySelector('meta[name="rimeward-runtime-base"]');
    // A share view's socket would reach the server, which hosts no PTY: straight to the SSE mux, which relays.
    stream = { listeners: new Map(), mode: relayed || shareView ? 'sse' : 'ws', connect: () => {} };
    streams.set(device, stream);
    const current = stream;
    const down = () => { current.ready = false; for (const receive of current.listeners.keys()) receive(null); };
    const later = () => { current.retry = setTimeout(current.connect, current.delay ?? 1000); current.delay = Math.min((current.delay ?? 1000) * 2, 30000); };
    const connectSse = () => {
      const routingWard = current.listeners.values().next().value?.ward;
      if (!routingWard) return;
      const source = new LiveEventSource(`/api/dev/events?_ward=${encodeURIComponent(routingWard)}`);
      current.source = source;
      source.onmessage = message => {
        if (current.source !== source) return;
        current.delay = undefined;
        let event: RuntimeEvent;
        try { event = JSON.parse(message.data) as RuntimeEvent; } catch { return; } // a torn frame: the sequence gap triggers a resync
        if (event.type === "reset") current.ready = true;
        for (const receive of current.listeners.keys()) receive(event);
      };
      source.onerror = () => {
        if (current.source !== source) return;
        down();
        // CLOSED = the server refused (401/403/404/5xx): back off instead of hammering the relay.
        if (source.readyState === EventSource.CLOSED) later();
      };
    };
    const connectWs = () => {
      const routingWard = current.listeners.values().next().value?.ward;
      if (!routingWard) return;
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/dev/ws?${new URLSearchParams({ _ward: routingWard, owner })}`);
      current.socket = ws;
      let hello = false;
      ws.onmessage = message => {
        if (current.socket !== ws) return;
        let m: { t: string; ev?: RuntimeEvent; id?: string; n?: number; message?: string };
        try { m = JSON.parse(message.data); } catch { ws.close(); return; }
        if (m.t === 'hello') {
          hello = true; current.delay = undefined;
          for (const entry of current.listeners.values()) for (const id of entry.subs) ws.send(JSON.stringify({ t: 'sub', id }));
        } else if (m.t === 'ev' && m.ev) {
          if (m.ev.type === 'reset') current.ready = true;
          for (const receive of current.listeners.keys()) receive(m.ev);
        } else if ((m.t === 'ack' || m.t === 'err') && typeof m.id === 'string') {
          for (const entry of current.listeners.values()) entry.ack?.({ id: m.id, n: m.n ?? -1, ...(m.t === 'err' ? { error: m.message ?? 'The terminal did not take the input.' } : {}) });
        }
      };
      ws.onclose = () => {
        if (current.socket !== ws) return;
        current.socket = undefined;
        down();
        if (!hello) { current.mode = 'sse'; current.connect(); return; }
        if (current.listeners.size) later();
      };
    };
    current.connect = () => {
      clearTimeout(current.retry);
      current.source?.close(); current.source = undefined;
      const old = current.socket; current.socket = undefined; old?.close();
      down();
      if (current.mode === 'ws') connectWs(); else connectSse();
    };
  }
  const entry: Entry = { ward, subs: new Set(), ack };
  stream.listeners.set(listener, entry);
  const s = stream;
  if (!s.source && !s.socket) s.connect();
  else if (s.ready) listener({ type: "reset", sequence: 0, id: "" });
  const up = () => s.mode === 'ws' && s.socket?.readyState === WebSocket.OPEN && !!s.ready;
  return {
    live: up,
    send: msg => { if (!up()) return false; s.socket?.send(JSON.stringify(msg)); return true; },
    sub: id => { entry.subs.add(id); if (s.socket?.readyState === WebSocket.OPEN) s.socket.send(JSON.stringify({ t: 'sub', id })); },
    unsub: id => { entry.subs.delete(id); if (s.socket?.readyState === WebSocket.OPEN) s.socket.send(JSON.stringify({ t: 'unsub', id })); },
    stop: () => {
      const routingWard = s.listeners.values().next().value?.ward;
      s.listeners.delete(listener);
      if (!s.listeners.size) {
        clearTimeout(s.retry); s.source?.close(); s.socket?.close(); streams.delete(device);
      } else if (routingWard === ward) s.connect();
    },
  };
}
