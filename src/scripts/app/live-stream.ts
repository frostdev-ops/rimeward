/** EventSource surface over one WebSocket: live wards must not consume HTTP/1 request slots. */
const sources = new Map<number, LiveEventSource>();
let serial = 0;
let socket: WebSocket | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let delay = 1000;
function connect(): void {
  if (socket || retry || !sources.size) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/live/stream`);
  socket = ws;
  ws.onopen = () => { if (socket !== ws) return; delay = 1000; for (const source of sources.values()) source.subscribe(); };
  ws.onmessage = event => {
    if (socket !== ws) return;
    let value: { id: number; open?: boolean; data?: string; error?: number };
    try { value = JSON.parse(event.data); } catch { ws.close(); return; }
    const source = sources.get(value.id);
    if (!source) return;
    if (value.open) source.open();
    else if (typeof value.data === 'string') source.receive(value.data);
    else if (value.error) source.failed(value.error);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = undefined;
    for (const source of sources.values()) source.disconnected();
    if (sources.size) { retry = setTimeout(() => { retry = undefined; connect(); }, delay); delay = Math.min(delay * 2, 30000); }
  };
}
export class LiveEventSource extends EventTarget {
  readonly id = ++serial;
  readyState = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  private buffer = '';
  private retry?: ReturnType<typeof setTimeout>;
  private delay = 1000;
  readonly url: string;
  constructor(url: string) {
    super(); this.url = url;
    sources.set(this.id, this);
    if (socket?.readyState === WebSocket.OPEN) this.subscribe(); else connect();
  }
  subscribe(): void {
    if (this.readyState === 2 || socket?.readyState !== WebSocket.OPEN) return;
    clearTimeout(this.retry); this.buffer = '';
    const bridge = window as typeof window & { rimewardRuntimeUrl?: (url: string) => string };
    socket.send(JSON.stringify({ id: this.id, path: bridge.rimewardRuntimeUrl?.(this.url) ?? this.url }));
  }
  open(): void { if (this.readyState === 2) return; this.readyState = 1; this.delay = 1000; const event = new Event('open'); this.dispatchEvent(event); this.onopen?.(event); }
  disconnected(): void {
    if (this.readyState === 2) return;
    clearTimeout(this.retry); this.buffer = ''; this.readyState = 0;
    const event = new Event('error'); this.dispatchEvent(event); this.onerror?.(event);
  }
  failed(status: number): void {
    if (status >= 400 && status < 500 && status !== 429) {
      this.close(); const event = new Event('error'); this.dispatchEvent(event); this.onerror?.(event); return;
    }
    this.disconnected();
    if (this.readyState === 2) return;
    this.retry = setTimeout(() => this.subscribe(), this.delay); this.delay = Math.min(this.delay * 2, 30000);
  }
  receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) { this.close(); const event = new Event('error'); this.dispatchEvent(event); this.onerror?.(event); return; }
    // Existing routes use LF; accept CRLF as EventSource does, including split delimiters.
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const frame = this.buffer.slice(0, match.index); this.buffer = this.buffer.slice(match.index + match[0].length);
      let name = 'message'; const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) name = line.slice(6).replace(/^ /, '') || 'message';
        if (line === 'data' || line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      const event = new MessageEvent(name, { data: data.join('\n'), origin: location.origin });
      this.dispatchEvent(event); if (name === 'message') this.onmessage?.(event);
      if (this.readyState === 2) break;
    }
  }
  close(): void {
    if (this.readyState === 2) return;
    this.readyState = 2; clearTimeout(this.retry); this.buffer = ''; sources.delete(this.id);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: this.id, close: true }));
    if (!sources.size) { clearTimeout(retry); retry = undefined; const old = socket; socket = undefined; old?.close(); }
  }
}
