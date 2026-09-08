// Test-only WebSocket observation/injection. Events still traverse LiveEventSource's frame parser.
// Self-contained so Playwright can serialize it into the browser's init script.
export function liveStreamFixture({ mockAll = false, browserFrame } = {}) {
  const Native = window.WebSocket;
  const subscriptions = new Map();
  window.__streams = [];
  window.terminalTestStreams = [];
  window.__browserStreams = [];
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      this.liveFixture = new URL(String(url), location.href).pathname === '/api/live/stream';
      if (!this.liveFixture) return;
      this.addEventListener('message', event => {
        const value = JSON.parse(event.data), source = subscriptions.get(value.id);
        if (!source) return;
        if (value.open) source.readyState = 1;
        if (value.error) source.readyState = value.error >= 400 && value.error < 500 && value.error !== 429 ? 2 : 0;
      });
      this.addEventListener('close', () => {
        for (const source of subscriptions.values()) if (source.socket === this && source.readyState !== 2) source.readyState = 0;
      });
    }
    emit(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    send(raw) {
      if (!this.liveFixture) return super.send(raw);
      const value = JSON.parse(raw);
      if (value.close) {
        const source = subscriptions.get(value.id);
        if (source) source.readyState = 2;
        if (!source?.mock) super.send(raw);
        return;
      }
      if (!value.path) return super.send(raw);
      let source = subscriptions.get(value.id);
      if (!source) {
        source = {
          id: value.id, url: value.path, readyState: 0, socket: this,
          mock: mockAll || (!!browserFrame && value.path.includes('/api/browser/stream/')),
          dispatchEvent(event) {
            this.socket.emit(event.type === 'error' ? { id: this.id, error: 404 } : {
              id: this.id, data: `event: ${event.type}\ndata: ${event.data}\n\n`,
            });
            return true;
          },
          close() { this.socket.send(JSON.stringify({ id: this.id, close: true })); },
          fail() { this.close(); this.dispatchEvent(new Event('error')); },
        };
        subscriptions.set(value.id, source); window.__streams.push(source);
        if (value.path.includes('/api/dev/events')) window.terminalTestStreams.push(source);
        if (value.path.includes('/api/browser/stream/')) window.__browserStreams.push(source);
      }
      source.socket = this;
      if (!source.mock) return super.send(raw);
      setTimeout(() => {
        if (source.readyState === 2) return;
        this.emit({ id: value.id, open: true });
        if (browserFrame && value.path.includes('/api/browser/stream/')) {
          for (const data of [
            { type: 'frame', data: browserFrame, width: 640, height: 480 },
            { type: 'nav', url: 'https://browser.fixture/one', title: 'Generated fixture' },
            { type: 'tabs', tabs: [{ url: 'https://browser.fixture/one', title: 'One' }, { url: 'https://browser.fixture/two', title: 'Two' }], active: 0 },
          ]) source.dispatchEvent(new MessageEvent(data.type, { data: JSON.stringify(data) }));
        }
      }, 10);
    }
  };
}
