// Writes tests/fixtures/lens/normal-work-10min.jsonl: ten minutes of synthetic
// editor work for the event-rate check (plan M3: <= 6 deliveries/min with no
// watches, <= 1/min with one specific watch).
//
//   node tests/fixtures/lens/gen-normal-work.mjs
//
// Deterministic: one LCG, no clock, no randomness from the environment. Every
// string is generated — nothing here has ever been on a real screen.

import fs from 'node:fs';

const OUT = new URL('./normal-work-10min.jsonl', import.meta.url);
const TOTAL_MS = 600_000;
const SETTLE_MS = 800; // the fixture waits past the 750 ms settle window
const KEYSTROKE_MS = 90;

const DISPLAY = { id: 1, w: 1800, h: 1169, scale: 2 };
const GEOMETRY = {
  window: [195, 92, 656, 422],
  scale: 2,
  contentRect: [0, 0, 1312, 844],
  contentScale: 2,
  captured: [0, 0, 656, 422],
};

/** The build errors the `watch` consumer is meant to catch. */
const ERRORS = [
  'error: build failed with 2 errors in gate.rs',
  'Build failed: 3 errors',
  'the build errored out',
];

const WORDS = ['quartz', 'falcon', 'basalt', 'condor', 'lumen', 'kestrel', 'agate', 'plover'];
const SEGMENTS = [
  { bundle: 'com.apple.dt.Xcode', name: 'Xcode', pid: 4211, window: 5375, title: 'gate.rs' },
  { bundle: 'com.microsoft.VSCode', name: 'Code', pid: 4880, window: 6102, title: 'scene.ts' },
  { bundle: 'com.apple.Terminal', name: 'Terminal', pid: 5104, window: 6640, title: 'blackice — zsh' },
  { bundle: 'com.apple.dt.Xcode', name: 'Xcode', pid: 4211, window: 5901, title: 'events.ts' },
];

let seed = 20260917;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = (list) => list[Math.floor(rnd() * list.length) % list.length];

const steps = [];
let t = 0;
let epoch = 0;
let seq = 0;
let top = 34;
let body = [];

const push = (step) => steps.push(step);
const note = (text) => push({ type: 'note', text });
const tick = (ms) => {
  t += ms;
  push({ type: 'tick', ms });
};
const lens = (kind) => push({ type: 'source', epoch, seq: ++seq, ...kind });
const wire = (text, y, conf) =>
  conf === undefined ? { bbox: [12, y, 300, 18], text } : { bbox: [12, y, 300, 18], text, conf };
const y = (i) => top + i * 18;
/** A rect that claims line `i` and neither neighbour (>= half of 18 px). */
const band = (i) => [0, y(i) - 5, 656, 28];
const ack = () => {
  push({ type: 'ack', consumer: 'plain' });
  push({ type: 'ack', consumer: 'watch' });
};

const codeLine = (i) => `  let ${pick(WORDS)}_${i} = ${pick(WORDS)}(${Math.floor(rnd() * 90) + 10});`;

function openSegment(index) {
  const seg = SEGMENTS[index];
  epoch += 1;
  seq = 0;
  top = 34;
  body = [`fn ${pick(WORDS)}(order: Order) -> f64 {`, codeLine(1), codeLine(2), codeLine(3), codeLine(4), '}'];
  note(`${seg.name}: ${seg.title}`);
  lens({ kind: 'app', bundle: seg.bundle, name: seg.name, pid: seg.pid });
  lens({
    kind: 'window',
    id: seg.window,
    title: seg.title,
    bounds: [195, 92, 656, 422],
    display: DISPLAY,
  });
  lens({ kind: 'ax-text', rect: [0, top - 6, 656, 140], lines: body.map((text, i) => wire(text, y(i))) });
  lens({
    kind: 'ax-focus',
    role: 'AXTextArea',
    label: 'Source Editor',
    value: body[1],
    bounds: [0, 32, 656, 384],
  });
  tick(SETTLE_MS);
  ack();
}

/** `n` keystrokes on the fourth body line, one OCR read each. */
function burst(n) {
  const target = `  let ${pick(WORDS)} = total + ${Math.floor(rnd() * 900) + 100};`;
  lens({
    kind: 'frame',
    ref: `f-${epoch}-${seq + 1}`,
    w: 1312,
    h: 844,
    ratio: 0.12,
    dirty: [{ bbox: band(4), d: 0.22 }],
    geometry: GEOMETRY,
  });
  for (let i = 0; i < n; i++) {
    const text = target.slice(0, Math.min(target.length, 6 + i * 2));
    lens({
      kind: 'ocr',
      ref: `f-${epoch}-${seq}`,
      rect: band(4),
      lines: [wire(text, y(4), 0.94)],
      ms: 108 + (i % 7),
      axCovered: false,
    });
    tick(KEYSTROKE_MS);
  }
  body[4] = target.slice(0, Math.min(target.length, 6 + (n - 1) * 2));
  tick(SETTLE_MS);
  ack();
}

/** One line of scroll: every line keeps its text and moves, so nothing fires. */
function scroll() {
  top -= 18;
  lens({ kind: 'ax-text', rect: [0, top - 6, 656, 140], lines: body.map((text, i) => wire(text, y(i))) });
  tick(SETTLE_MS);
}

function buildError(index) {
  note('A build finishes badly in the console pane.');
  lens({
    kind: 'ocr',
    ref: `f-${epoch}-${seq}`,
    rect: [0, 295, 656, 28],
    lines: [wire(ERRORS[index % ERRORS.length], 300, 0.96)],
    ms: 121,
    axCovered: false,
  });
  tick(SETTLE_MS);
  ack();
}

function dialog() {
  note('A save sheet opens: a flush, delivered to every consumer whatever it watches.');
  lens({ kind: 'ax-sheet', title: 'Save changes to gate.rs?', bounds: [120, 140, 400, 200] });
  tick(SETTLE_MS);
  ack();
}

// ------------------------------------------------------------------- script

note('Ten minutes of synthetic editor work: typing bursts, scrolls, idle stretches, three app switches and one save sheet. `plain` has no watches; `watch` looks for a build error and sets its own threshold for the replay harness stand-in embedder.');
push({ type: 'consumer', id: 'plain' });
push({
  type: 'consumer',
  id: 'watch',
  watches: [{ for: 'a build error appeared', visual: false, triage: false, threshold: 0.55 }],
});
push({ type: 'expect', expect: 'watch', consumer: 'watch', id: 'watch:w1', mode: 'for' });

for (let segment = 0; segment < SEGMENTS.length; segment++) {
  openSegment(segment);
  for (let i = 0; i < 9; i++) {
    burst(8 + (i % 5));
    if (i % 3 === 1) scroll();
    tick(3000 + ((i * 2300 + segment * 700) % 11_000));
    if (i === 6 && segment < 3) buildError(segment);
    if (segment === 1 && i === 4) dialog();
  }
  note('The user steps away.');
  tick(18_000);
}

const left = TOTAL_MS - t;
if (left > 0) {
  note('Idle to the ten minute mark.');
  tick(left);
}

push({ type: 'expect', expect: 'epoch', value: SEGMENTS.length });
push({ type: 'expect', expect: 'deliveries', consumer: 'plain', atMost: 60 });
push({ type: 'expect', expect: 'deliveries', consumer: 'watch', atMost: 10 });
push({ type: 'expect', expect: 'deliveries', consumer: 'watch', atLeast: 4 });

fs.writeFileSync(OUT, steps.map((s) => JSON.stringify(s)).join('\n') + '\n');
console.log(`wrote ${steps.length} steps, ${t} ms of fixture time -> ${OUT.pathname}`);
