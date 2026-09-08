import { LiveEventSource } from './live-stream.ts';
import type { RuntimeEvent } from "../../lib/dev/types.ts";

type Listener = (event: RuntimeEvent | null) => void;
const streams = new Map<string, {
  listeners: Map<Listener, string>;
  source?: LiveEventSource;
  retry?: ReturnType<typeof setTimeout>;
  delay?: number;
  ready?: boolean;
  connect: () => void;
}>();

/** One connection per desktop, shared by all terminal wards. null = disconnected. */
export function terminalEvents(device: string, ward: string, listener: Listener) {
  let stream = streams.get(device);
  if (!stream) {
    stream = { listeners: new Map(), connect: () => {} };
    streams.set(device, stream);
    const current = stream;
    current.connect = () => {
      clearTimeout(current.retry);
      current.source?.close();
      current.ready = false;
      for (const receive of current.listeners.keys()) receive(null);
      const routingWard = current.listeners.values().next().value;
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
        current.ready = false;
        for (const receive of current.listeners.keys()) receive(null);
        // CLOSED = the server refused (401/403/404/5xx): back off 3 s → 30 s instead of hammering the relay.
        if (source.readyState === EventSource.CLOSED) { current.retry = setTimeout(current.connect, current.delay ?? 3000); current.delay = Math.min((current.delay ?? 3000) * 2, 30000); }
      };
    };
  }
  stream.listeners.set(listener, ward);
  if (!stream.source) stream.connect();
  else if (stream.ready) listener({ type: "reset", sequence: 0, id: "" });
  return () => {
    const routingWard = stream.listeners.values().next().value;
    stream.listeners.delete(listener);
    if (!stream.listeners.size) {
      clearTimeout(stream.retry); stream.source?.close(); streams.delete(device);
    } else if (routingWard === ward) stream.connect();
  };
}
