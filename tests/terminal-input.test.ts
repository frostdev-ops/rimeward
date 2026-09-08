import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalInput } from "../src/scripts/app/terminal-input.ts";
import { terminalEvents } from "../src/scripts/app/terminal-stream.ts";

test("terminal streams share a connection per desktop and reconnect using a remaining ward", t => {
  const opened: { url: string; readyState: number; onmessage: (message: { data: string }) => void; onerror: () => void; close: () => void }[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (message: { data: string }) => void;
    onclose?: () => void;
    subscriptions = new Map<number, typeof opened[number]>();
    constructor(_url: string) { setTimeout(() => this.onopen?.(), 0); }
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
  const original = { WebSocket: globalThis.WebSocket, EventSource: globalThis.EventSource, window: globalThis.window, location: globalThis.location };
  Object.assign(globalThis, { WebSocket: FakeSocket, EventSource: { CLOSED: 2 }, window: {}, location: { protocol: 'http:', host: 'fixture', origin: 'http://fixture' } });
  const received: unknown[] = [];
  let stopA = () => {}, stopB = () => {}, stopC = () => {};
  try {
    stopA = terminalEvents("desktop", "ward-a", event => received.push(event));
    stopB = terminalEvents("desktop", "ward-b", event => received.push(event));
    t.mock.timers.tick(0);
    assert.equal(opened.length, 1);
    opened[0]?.onmessage?.({ data: JSON.stringify({ type: "reset", sequence: 0, id: "" }) });
    assert.deepEqual(received, [null, { type: "reset", sequence: 0, id: "" }, { type: "reset", sequence: 0, id: "" }]);
    const late: unknown[] = [];
    const stopLate = terminalEvents("desktop", "ward-late", event => late.push(event));
    assert.deepEqual(late, [{ type: "reset", sequence: 0, id: "" }], "a new ward can attach to an already-connected stream");
    stopLate();
    stopA(); stopA = () => {};
    t.mock.timers.tick(0);
    assert.equal(opened[0]?.readyState, 2);
    assert.match(opened[1]?.url ?? "", /ward-b/);
    opened[1]?.close(); opened[1]?.onerror?.();
    assert.equal(received.at(-1), null);
    t.mock.timers.tick(3000);
    assert.equal(opened.length, 3);
    stopC = terminalEvents("other-desktop", "ward-c", () => {});
    assert.equal(opened.length, 4);
  } finally {
    stopA(); stopB(); stopC();
    Object.assign(globalThis, original);
    t.mock.timers.reset();
  }
  assert.ok(opened.every(source => source.readyState === 2));
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
