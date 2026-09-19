#!/usr/bin/env node
// The Swift helper's wire protocol with no model behind it, so `helper.rs` can
// be tested without Apple Intelligence, without a Swift build, and in
// milliseconds. It is started the way the real helper is: argv `--test-ops`,
// JSON lines on stdin and stdout, logging on stderr.
//
// Knobs, all read from the environment `helper.rs` gives this child:
//   FAKE_EXIT_75_AFTER_MS   exit 75 this long after start, as the watchdog does
//   FAKE_IGNORE_PINGS=1     never answer `ping`
//   FAKE_HANG=1             never answer anything
//   FAKE_OUTSTANDING=<n>    report this retained-work count on every line
//   FAKE_UNAVAILABLE=1      Apple Intelligence off: `capabilities` says so, the
//                           first model op answers `unavailable` and pushes the
//                           `state` line the real helper pushes

import { createInterface } from 'node:readline';

const knob = (name) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : null;
};
const hang = process.env.FAKE_HANG === '1';
const ignorePings = process.env.FAKE_IGNORE_PINGS === '1';
const fixedOutstanding = knob('FAKE_OUTSTANDING');
const exitAfter = knob('FAKE_EXIT_75_AFTER_MS');
const unavailable = process.env.FAKE_UNAVAILABLE === '1';
let saidUnavailable = false;

/** Work started and not finished, exactly as the real helper counts it. */
let running = 0;
const outstanding = () => fixedOutstanding ?? running;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id, value) => send({ id, value, outstanding: outstanding() });
const fail = (id, error, detail) =>
  send({ id, error, detail, outstanding: outstanding() });

if (exitAfter !== null) {
  // The real helper exits 75 when an abandoned task outlives its recovery
  // deadline; the timer stands in for the watchdog.
  setTimeout(() => {
    process.stderr.write('fake-helper: abandoned work, exiting 75\n');
    process.exit(75);
  }, exitAfter);
}

async function handle(request) {
  const { id, op } = request;
  const value = request.value ?? {};
  switch (op) {
    case 'ping':
      if (!ignorePings) ok(id, true);
      return;
    case 'capabilities':
      ok(id, {
        model: {
          available: !unavailable,
          variant: 'fake',
          contextSize: 8192,
          vision: !unavailable,
          ...(unavailable ? { reason: 'appleIntelligenceNotEnabled' } : {}),
        },
        translation: [['en', 'es']],
        embedding: true,
      });
      return;
    case 'triage':
    case 'translate':
      if (unavailable) {
        if (!saidUnavailable) {
          saidUnavailable = true;
          send({ type: 'state', model: 'unavailable', outstanding: outstanding() });
        }
        fail(id, 'unavailable', 'appleIntelligenceNotEnabled');
        return;
      }
      fail(id, 'unknown-op', op);
      return;
    case 'echo':
    // The crop path's two ops answer with the payload they were given, so the
    // test on the Rust side can look at the JPEG that actually crossed.
    case 'describe':
    case 'document':
      ok(id, value);
      return;
    case 'sleep': {
      const ms = Number(value.ms);
      if (!Number.isFinite(ms) || ms < 0) {
        fail(id, 'bad-request', 'ms is required');
        return;
      }
      running += 1;
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      ok(id, true);
      return;
    }
    default:
      fail(id, 'unknown-op', op);
  }
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    send({ id: 0, error: 'bad-request', outstanding: outstanding() });
    continue;
  }
  if (message.type === 'shutdown') break;
  if (hang) continue;
  // Not awaited: a slow op must never hold up the next line, which is the
  // whole point of the retained-work accounting.
  void handle(message);
}
process.exit(0);
