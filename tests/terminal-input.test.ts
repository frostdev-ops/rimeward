import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalInput } from "../src/scripts/app/terminal-input.ts";
import { terminalEvents } from "../src/scripts/app/terminal-stream.ts";

const globals = () => ({ WebSocket: globalThis.WebSocket, EventSource: globalThis.EventSource, window: globalThis.window, location: globalThis.location, document: globalThis.document });
const fixture = { EventSource: { CLOSED: 2 }, window: {}, location: { protocol: 'http:', host: 'fixture', origin: 'http://fixture' }, document: { querySelector: () => null } };

test("terminal streams share a connection per desktop and reconnect using a remaining ward", t => {
  const opened: { url: string; readyState: number; onmessage: (message: { data: string }) => void; onerror: () => void; close: () => void }[] = [];
  let refused = 0;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (message: { data: string }) => void;
    onclose?: () => void;
    subscriptions = new Map<number, typeof opened[number]>();
    constructor(url: string) {
      // The dedicated socket is refused before `hello`: this page latches to the SSE mux.
      if (url.includes("/api/dev/ws?")) { refused++; setTimeout(() => this.close(), 0); return; }
      setTimeout(() => this.onopen?.(), 0);
    }
    send(raw: string) {
      const frame = JSON.parse(raw);
      if (frame.close) { const source = this.subscriptions.get(frame.id); if (source) source.readyState = 2; return; }
      const emit = (value: unknown) => this.onmessage?.({ data: JSON.stringify(value) });
      const source = {
        url: frame.path, readyState: 1,
        onmessage: (message: { data: string }) => emit({ id: frame.id, data: `data: ${message.data}\n\n` }),
        onerror: () => emit({ id: frame.id, error: 404 }),
        close() { this.readyState = 2; },
      };
      this.subscriptions.set(frame.id, source); opened.push(source);
      emit({ id: frame.id, open: true });
    }
    close() { this.readyState = 2; this.onclose?.(); }
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globals();
  Object.assign(globalThis, { ...fixture, WebSocket: FakeSocket });
  const received: unknown[] = [];
  let stopA = () => {}, stopB = () => {}, stopC = () => {};
  try {
    const a = terminalEvents("desktop", "ward-a", event => received.push(event));
    stopA = a.stop;
    stopB = terminalEvents("desktop", "ward-b", event => received.push(event)).stop;
    t.mock.timers.tick(0);
    assert.equal(refused, 1, "one dedicated socket is tried per desktop");
    assert.equal(a.live(), false);
    assert.equal(a.send({ t: "in" }), false, "SSE mode: input goes over HTTP");
    t.mock.timers.tick(0);
    assert.equal(opened.length, 1);
    opened[0]?.onmessage?.({ data: JSON.stringify({ type: "reset", sequence: 0, id: "" }) });
    assert.deepEqual(received.filter(Boolean), [{ type: "reset", sequence: 0, id: "" }, { type: "reset", sequence: 0, id: "" }]);
    const late: unknown[] = [];
    const stopLate = terminalEvents("desktop", "ward-late", event => late.push(event)).stop;
    assert.deepEqual(late, [{ type: "reset", sequence: 0, id: "" }], "a new ward can attach to an already-connected stream");
    stopLate();
    stopA(); stopA = () => {};
    t.mock.timers.tick(0);
    assert.equal(opened[0]?.readyState, 2);
    assert.match(opened[1]?.url ?? "", /ward-b/);
    opened[1]?.close(); opened[1]?.onerror?.();
    assert.equal(received.at(-1), null);
    t.mock.timers.tick(3000);
    assert.equal(opened.length, 3, "a refused SSE source is retried, the socket is not tried again");
    stopC = terminalEvents("other-desktop", "ward-c", () => {}).stop;
    t.mock.timers.tick(0); t.mock.timers.tick(0);
    assert.equal(opened.length, 4);
  } finally {
    stopA(); stopB(); stopC();
    Object.assign(globalThis, original);
    t.mock.timers.reset();
  }
  assert.ok(opened.every(source => source.readyState === 2));
});

test("the dedicated socket carries events, subscriptions, input and acks; a drop after hello reconnects it", t => {
  const sockets: FakeWs[] = [];
  class FakeWs {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    onmessage?: (message: { data: string }) => void;
    onclose?: () => void;
    url: string;
    constructor(url: string) { this.url = url; sockets.push(this); }
    send(raw: string) { this.sent.push(raw); }
    close() { this.readyState = 2; this.onclose?.(); }
    emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globals();
  Object.assign(globalThis, { ...fixture, WebSocket: FakeWs });
  const received: unknown[] = [], acks: unknown[] = [];
  const stream = terminalEvents("desktop", "ward-a", event => received.push(event), ack => acks.push(ack));
  try {
    const ws = sockets[0];
    assert.ok(ws);
    assert.match(ws.url, /\/api\/dev\/ws\?_ward=ward-a&owner=client%3A/);
    stream.sub("s1");
    assert.deepEqual(ws.sent.map(m => JSON.parse(m)), [{ t: "sub", id: "s1" }]);
    ws.emit({ t: "hello" });
    assert.deepEqual(ws.sent.length, 2, "subscriptions are re-sent after hello");
    ws.emit({ t: "ev", ev: { type: "reset", sequence: 0, id: "" } });
    assert.equal(stream.live(), true);
    assert.equal(stream.send({ t: "in", id: "s1", data: "x", n: 3 }), true);
    ws.emit({ t: "ack", id: "s1", n: 3 });
    ws.emit({ t: "err", id: "s1", n: 4, message: "nope" });
    ws.emit({ t: "ev", ev: { type: "output", sequence: 2, id: "s1", data: { sequence: 1, data: "hi" } } });
    assert.deepEqual(received.filter(Boolean).map(e => (e as { type: string }).type), ["reset", "output"]);
    assert.deepEqual(acks, [{ id: "s1", n: 3 }, { id: "s1", n: 4, error: "nope" }]);
    ws.close();
    assert.equal(received.at(-1), null);
    assert.equal(stream.live(), false);
    t.mock.timers.tick(1000);
    assert.equal(sockets.length, 2, "a socket that had said hello is reconnected, not replaced by SSE");
    assert.match(sockets[1]?.url ?? "", /\/api\/dev\/ws\?/);
  } finally {
    stream.stop();
    Object.assign(globalThis, original);
    t.mock.timers.reset();
  }
});

test("terminal input batches across latency, preserves Unicode and binary order, and never replays a failed request", async () => {
  const sent: { id: string; data: string; binary: boolean }[] = [];
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const input = new TerminalInput(async (id, data, binary) => {
    sent.push({ id, data, binary });
    if (sent.length === 1) await blocked;
  }, () => assert.fail("unexpected input failure"));
  input.send("one", "a");
  const done = input.flush();
  const paste = "界🙂".repeat(30000);
  for (const key of "bcdef") input.send("one", key);
  input.send("one", paste);
  input.send("one", "\xff", true);
  input.send("two", "next");
  unblock();
  await done;
  assert.equal(sent.filter(s => s.id === "one" && !s.binary).map(s => s.data).join(""), "abcdef" + paste);
  assert.ok(sent.every(s => Buffer.byteLength(s.data) <= 64 * 1024 && s.data.isWellFormed()));
  assert.deepEqual(sent.slice(-2), [{ id: "one", data: "\xff", binary: true }, { id: "two", data: "next", binary: false }]);
  assert.ok(sent.length < 12, "paste and keystrokes are batched instead of one request per character");
  let calls = 0, failures = 0;
  const lost = new TerminalInput(async () => { calls++; throw Error("ack lost"); }, () => { failures++; });
  lost.send("one", "x".repeat(32000));
  await lost.flush();
  await lost.flush();
  assert.equal(calls, 1);
  assert.equal(failures, 1);
});
