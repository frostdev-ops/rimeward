# Lens replay fixtures

One JSON Lines file per scenario. `tests/lens-replay.test.ts` runs every
`*.jsonl` in this directory and asserts zero failures; the parser and the step
runner live in `src/lib/lens/replay.ts` and the fake clock, the SQLite store,
the two sources and the scripted decider live in `tests/lens-replay.ts`.

Every string in here is generated. No fixture contains text that has ever been
on a real screen or in a real terminal.

## Running

```
node --test tests/lens-replay.test.ts       # all fixtures, with per-fixture elapsed
node tests/fixtures/lens/gen-normal-work.mjs  # regenerate normal-work-10min.jsonl
```

## Format

Blank lines and lines starting with `//` are skipped. Every other line is one
JSON object, dispatched on `type`. A failure quotes the fixture's own line
number.

| step | fields | effect |
| --- | --- | --- |
| `note` | `text` | nothing; a comment that survives JSON Lines |
| `source` | a screen wire signal: `epoch`, `seq`, `kind`, plus that kind's fields | the screen fixture source turns it into `Feed` calls |
| `term` | `seq`, plus `rows`+`scrolled`+`lost?`, or `session`, or `reset` | drives the real `terminalSource` over a fake dev runtime |
| `page` | `url?`, `title?`, `nodes:[{text,rect}]`, `changed?` | what a browser tab now shows; the real `browserSource` reads it on its next poll |
| `tick` | `ms` | advance the fake clock by `ms`, then drain the async work |
| `consumer` | `id`, `kind?`, `watches?` (`WatchSpec[]`), `minIntervalS?` | `core.consumer` then `core.watch` |
| `ack` | `consumer`, `id?` (default `"last"`) | acknowledges through `core.history`, which never produces |
| `wait` | `consumer`, `timeoutMs` | starts `core.wait` and records how it settles |
| `reply` | `op`, `reply` | queues one reply for the next `helper-triage` / `helper-describe` / `lens-snapshot` |
| `expect` | `expect` plus that verb's fields | asserts; see below |

A fixture is a terminal fixture when it contains any `term` step, a browser
fixture when it contains any `page` step, and a screen fixture otherwise; that
is what picks the core's source.

### Screen signals

A `source` step is shaped exactly like BlackIce's Rust wire: `ref` is
`f-<epoch>-<seq>`, `dirty` is `[{bbox, d}]`, `ocr` carries `ms` and `axCovered`.
`at` may be left out and the runner stamps it from the replay clock, so spacing
comes from the `tick` steps. The clock starts at `1758120000000`
(2025-09-17T16:00:00Z).

`seq` must rise within an epoch and restarts at 1 when the epoch does. A rect
claims a line when it covers at least half that line's height, so a "one line"
rect is `[0, y - 5, 656, 28]` for an 18 px line at `y`.

The screen source in `tests/lens-replay.ts` is test-only and minimal: it exists
so these fourteen lifted fixtures keep pinning the core. The real one is
`src/lib/lens/screen.ts` (phase B2), and its header fields may differ in detail
— only `app=` and `window=` are asserted here.

### Terminal signals

A `term` step is what the dev runtime would have produced:

- `{"type":"term","seq":10,"rows":[…],"scrolled":0,"lost":0}` — exactly what
  `renderedLines` returns (the rows that scrolled off since the last read, then
  the viewport), and an `output` event carrying `seq`. A step before the first
  `consumer` only sets the screen: nobody is listening yet, so it is what the
  session already shows when the source connects.
- `{"type":"term","seq":11,"session":{"state":"exited","exitCode":0,"cols":80,"rows":24}}`
  — a `session` event. A different `cols`/`rows` is a re-wrap: a new epoch.
- `{"type":"term","seq":21,"reset":true}` — the dev stream restarted, which the
  source reports as a gap.

Row `i` of the window is document line `[0, position, 1, 1]`, where `position`
is `scrolled - above + i`.

### Browser signals

A `page` step is what the tab shows after some change, and the whole state each
time (like `term`'s rows, not a patch):

- `nodes` are the block-level boxes, `[{ "text": "…", "rect": [x, y, w, h] }]`
  in CSS pixels; `changed` are the rectangles the page's MutationObserver saw
  repaint since the last read. A step with no `changed` is a scroll or a resize:
  every box moves, no text changes, and the lines only `moved`.
- A step whose `url` differs is a NEW DOCUMENT — the page-side reader goes with
  it — so the source opens a new epoch and `url` forces the keyframe.
- The browser source POLLS (250 ms, `POLL_MS`): a `page` step only sets what the
  next read will find, and a `tick` of at least that long is what performs it.
  There is no `seq` — a page has no stream to carry one, so the source counts its
  own reads.

### Expect verbs

| verb | fields | checks |
| --- | --- | --- |
| `deliveries` | `consumer`, `count` \| `atMost` \| `atLeast` | how many deliveries that consumer has had |
| `keyframe` | `consumer`, `pages?`, `page?` | the last delivery is a keyframe, on that page of that many |
| `delta` | `consumer`, `since?` | the last delivery is a delta from that version |
| `lines` | `consumer`, `plus?`, `minus?`, `same?` | `+`/`-`/`=` line counts in the last delivery |
| `truncated` | `consumer`, `value` | the last delivery was cut |
| `text` | `consumer?`, `contains?`, `notContains?` | substrings of the last delivery's text |
| `notContains` | `consumer?`, `contains` | the same check, inverted only |
| `moved` | `count` | lines that kept an id and changed a bbox, **cumulative over the run** |
| `incomplete` | `value` | `core.doc().incomplete` |
| `epoch` | `value` | `core.doc().epoch` |
| `version` | `value` \| `atLeast` | `core.doc().v` |
| `scene.lines` | `count` | how many lines the document holds |
| `scene.text` | `contains?`, `notContains?` | line texts in the document |
| `meta` | `key`, `value?` \| `contains?` | one header field of the document |
| `live` | `count?` \| `atLeast?` | live regions on the newest frozen version |
| `cursor` | `consumer`, `value` | the acknowledged version (`null` for none) |
| `delivered` | `consumer`, `value` (id, `"last"` or `null`) | the unacknowledged delivery, if any |
| `watch` | `consumer`, `id`, `mode?`, `evaluation?`, `hit?` | the mode the watch got, and the last evaluation |
| `wait` | `consumer`, `result` (`delivery`\|`timeout`\|`cancelled`\|`pending`) | how that consumer's last `wait` settled |

`consumer` may be omitted on the delivery verbs only while the fixture has a
single consumer.

## The harness

`tests/lens-replay.ts` wires the core so a fixture can script everything the
core cannot do itself:

- `triage`, `describe` and the screen source's `snapshot()` answer from the
  fixture's `reply` steps (`helper-triage`, `helper-describe`,
  `lens-snapshot`). The core spends at most one describe per settle round,
  shared by every consumer whose watch meets the visual candidate, so a fixture
  queues one reply per round. An unscripted `helper-triage` is an error to the
  gate, which a `for` watch survives on its cosine alone (`evaluation: 'weak'`).
- `embed` is a **deterministic stand-in**: hashed character trigrams,
  L2-normalised (`trigramVector`). It keeps replay hermetic, but its cosine
  scale is its own, so a fixture that exercises a `for` watch sets `threshold`
  explicitly.
- `loadConsumers` is wrapped to return nothing, so each replay starts with no
  consumers even though the store is the real SQLite one.

Note that `deliveries` counts re-deliveries too: an unacknowledged delivery is
re-rendered on the next `wait`, `look` or `history`, and that re-render is a new
delivery id.

## The fixtures

| fixture | what it pins |
| --- | --- |
| `typing-burst` | 20 OCR replacements 80 ms apart settle into exactly one delta; a stream 500 ms apart never reaches the 750 ms settle, so the 3 s cap delivers instead |
| `live-region` | a toolbar clock dirtying one rect on 6 consecutive frames becomes live; the text churn inside it never becomes a candidate nor a rendered `+`/`-` line, and the next change outside it reports `live` alongside itself |
| `app-switch` | an epoch bump is an immediate keyframe for both consumers; OCR of the old epoch arriving afterwards never enters |
| `same-app-window-switch` | a `window` signal on a new epoch is a keyframe, and the old text is gone |
| `duplicate-labels` | two `OK` lines are two ids; moving the lower one keeps both and reports a move, not an add plus a remove |
| `scrolling` | every line keeps its id and text and only its bbox moves: 5 moves, no version bump, no delivery |
| `partial-edit` | an edit at the end of a long line is one `-` and one `+`, and the neighbours are untouched |
| `ax-ocr-switch` | AX, then an `axCovered` OCR that replaces nothing, then OCR with `axCovered:false` taking the rect, then AX taking it back, with no spurious event |
| `out-of-order-ocr` | OCR 50 landing after OCR 51 is discarded whole |
| `visual-only` | a dirty rect with no text change: one describe serves the round, a `visual` watch fires with the interpreted text on its `~` line, an unrelated text watch stays quiet; then a rect with no description, where the `visual` watch fires bare (`rect-only`) and the text watch is `unavailable` |
| `saturation-recovery` | a `gap` marks the document incomplete, the snapshot arrives with `seq: 50`, queued signals at or below it are discarded, newer ones apply in order, and a keyframe is forced |
| `stale-epoch` | OCR carrying epoch 1 after epoch 2 began never enters |
| `ack-and-pages` | 600 lines page into 3; each page is acknowledged on its own and page 1 is not repeated; an unacknowledged delta comes back from the same cursor; a delta that had to be cut leaves the baseline incomplete |
| `normal-work-10min` | the event-rate budget: `plain` (no watches) at or under 6/min, `watch` (one `for`) at or under 1/min, over 10 minutes |
| `terminal-burst` | appended rows settle into one delta, and a terminal never renders a `-` line |
| `terminal-spinner` | the CLI activity spinner is a live region: six frames of it deliver nothing, and the output row beside it still does |
| `terminal-prompt-typing` | a prompt repainting one row becomes live, so keystrokes never reach a consumer; the submitted line arrives with the output after the repaints stop |
| `terminal-resize` | a re-wrap is a new epoch and a keyframe, not a delta full of rewrites |
| `terminal-exit` | `session` is a header field a change to which is a keyframe on its own, exit code included |
| `terminal-ack-and-pages` | 300 rows page into more than one keyframe, each acknowledged on its own |
| `browser-navigation` | a new document is a new epoch and a keyframe forced by `url`; nothing the old page said survives it |
| `browser-ticker` | a clock repainting the same box becomes live: twelve repaints, no delivery |
| `browser-mutation-burst` | a message list growing a row at a time settles into exactly one delta, and distinct boxes never become live |
| `browser-scroll` | a scroll moves every box and changes no text: same ids, same version, no delivery |
| `terminal-restart-resume` | a dev-stream `reset` is a gap: the document is repainted from the session and a keyframe is forced |
