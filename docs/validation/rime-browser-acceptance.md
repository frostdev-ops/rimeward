# Rime and browser baseline acceptance

RIME-17, RIME-19 and RIME-31 remain open until human-run results are reviewed
against the exact 1.0.18 candidate. Follow [the delivery contract](../board/DELIVERY.md).
RIME-19 follows RIME-13's real provider ownership acceptance. RIME-46 supplies a
signed committed candidate before these checks; its final ready is not a prerequisite.

## Evidence record

Use one row per scenario, including refusals and failures. Keep raw transcripts,
audio and provider logs private; publish sanitized outcomes and opaque references.

| Field | Required value |
|---|---|
| Package / scenario | RIME-17, RIME-19 or RIME-31; row below |
| Candidate | Full Git SHA; server build stamp; desktop version and artifact checksum |
| Host | OS, exact build, architecture; browser/runtime version; signing verification |
| Run | UTC date/time, human operator, disposable account/ward labels |
| Route | Credential owner installation and generation; provider/backend; peer versions |
| Observation | Expected and actual result, counts/timings, receipt or sanitized log reference |
| Disposition | Pass / fail / unavailable; cleanup confirmation; limitation and next owner |

Re-run affected scenarios after changing their candidate. Never put credentials,
session cookies, raw account identifiers or private prompts in board updates.

## RIME-17: reliability and B1–B11

Use disposable chats, project files, browser wards and fixture services. Record
configured permission ceilings and model/backend; relay runs need both build identities.

| Scenario | Human procedure and passing evidence |
|---|---|
| B1/B2 ceilings and MCP trust | Lower the parent ceiling; attempt a child/write and a fixture MCP tool advertised as read-only. Stored ceiling and ward trust win; denied work has no execution receipt. |
| B3/B4 task inspection | Start a disposable background task; inspect status, bounded output and terminal receipt from Rime/task UI. Failure/nonzero exit stays visible; observation alone never claims success. |
| B5 inactive diagnostics | Leave a ward unopened. Request `browser_console`, `browser_network`, then `browser_asset` by explicit ward ID. Each returns `running:false`; no Chromium/profile/provider session appears. Repeat on installed local and relay paths. |
| B5 active diagnostics | Open a page with a unique console error and known failed/text/binary response. Read filtered console/network and asset-by-ID; only that ward's evidence appears. Asset-by-URL may re-fetch through the active session/guard, so use an ID to prove recorded-body access. |
| B6 dictation | Reuse RIME-19's signed and provider clip results below; fixtures and legacy manual reports do not close this gate. |
| B7/B10 presentation and Markdown | Inspect long chat and literal Markdown with HTML-looking text in ward/expanded/mobile views. Text stays literal where intended; controls stay keyboard accessible; following does not lose drafts. |
| B8/B9 following | Follow a background task through completion, page hiding/reopening and duplicate events. Inspect the persisted receipt; one event gives one notification/result, with no history replay. |
| B11 admission and Stop | Resume a linked stopped child and continue from History. Race parent Stop or a lowered ceiling with admission. Record lineage, original stop cause and refusal without creating an unauthorized child. |
| B11 pinned route | Change/remove the recorded provider/model/backend before resume. Unavailable recorded execution is refused without silent substitution. |
| Attachment rollback / mixed peers | Continue a shared chat with a generated attachment; force mid-import failure. No incomplete chat/files become visible. Repeat with the supported old peer: unsupported provenance/pins refuse safely; foreign numeric attachment IDs are never reused. |
| Relay restart / no replay | Submit one marked disposable write through the paired relay; interrupt transport after admission and restart the disposable runtime. Reconciliation reads its durable result or reports uncertainty, never resends the accepted request; the write occurs once. |
| Stop / model wait | Stop a fixture provider withholding response. Record immediate UI feedback, settled wait, suppressed late output and a successful next turn. Native operations still need their own completion receipts. |

## RIME-19: Live provider protocol

The human operator runs the existing probe on the credential-owning installation
after RIME-13, with no other voice call/uncertain lease. Inspect the probe first.
Select `RIMEWARD_PROBE_USER` and `RIMEWARD_PROBE_WARD` when required and the
installation's existing data directory. Never copy credentials or replace an
account just to make preflight pass.

```sh
node --env-file-if-exists=.env tests/voice-delegation-probe.mjs --check
# Human-run only: creates real provider usage, one call per case.
node --env-file-if-exists=.env tests/voice-delegation-probe.mjs p1 p2 p3 p4 p5 p6
```

`--check` is read-only; no refresh/provider request. A real Mac run generates
speech with `say`; elsewhere set `RIMEWARD_PROBE_AUDIO_DIR` to WAVs named for all
nine cases. Keep `RIMEWARD_PROBE_DIR` reports private and outside the checkout.
Each case records create status, event identities, observed behavior and
`closed:true`. Stop on uncertain cleanup; preserve the lease rather than deleting it.

| Group / cases | Observation required |
|---|---|
| p1 | `delegation.created` shape/ID and acknowledgement filler; no task execution by voice. |
| p2 | One speakable `delegation.context.append` reaches the same delegation and ends its turn. |
| p3 | Observed repeated same-ID result behavior, compared with application deduplication. |
| p4 | Session-only context behavior, including any leak/stall; do not infer delegation equivalence. |
| p5-commentary, p5-omitted | Separate calls prove seeded-fact retention and unsolicited-audio behavior. The omitted-channel path used by Live must stay quiet. |
| p6-baseline, p6-initial, p6-tools | Separate baseline/history/tools comparisons. `initial_items` must be retained; tools-field acceptance does not prove executable function tools. |

These six groups make nine calls. HTTP success or zero exit is insufficient;
review every frame report. In the signed candidate Live UI, speak a harmless task
request: exactly one framed main-chat delegation and one ordinary Rime result
spoken on the same call. Repeat with busy/steering, pending approval, history
refresh and duplicate done delivery. Voice cannot answer/confirm approvals.
Casual speech/captions stay transient; typed drafts, mentions and attachments survive.
Record quiet context after service/unread changes without extra polling, retained
initial history, reachable Mute/End in hidden/expanded/modal views, and confirmed
cleanup after End, navigation and provider/runtime changes.

## RIME-19: signed acoustic and clip checks

The human uses the signed staged desktop on the exact target Mac. Record devices,
speaker volume, echo-cancellation track settings, Speaker-safe state and listening
results; headless synthetic audio and a previous manual build are insufficient.

1. With headphones, dictate a known sentence into an edited unsent draft: preserved
   punctuation/tail, one append, no automatic send. Read an ordinary Rime reply;
   compare audible words with text. Test Finish & Send once.
2. Repeat on open speakers with automatic and selected Speaker-safe. During voice
   output, stay silent: no self-delegation, repeated reply or draft pollution.
   Speak an interruption; record whether the mode admits it or pauses capture,
   and whether playback stops as shown.
3. Switch chat/page and Cmd-Tab, mute/unmute, open a modal, then End/Stop. Requested
   capture/playback stop immediately, drain preserves tails and provider closure
   is acknowledged. Denied mic/unavailable credentials keep typed chat usable;
   late permission/start callbacks cannot revive capture.
4. In separate disposable configurations, transcribe one real clip through OpenAI,
   the ward's chosen compatible endpoint and an audio-capable OpenRouter model.
   Record route/owner, 16 kHz mono WAV, editable draft append and zero Rime turns.
   Incompatible OpenRouter models report audio unavailability without substitution.
   Absent local credentials mean unavailable, never implicit relay.

## RIME-31: hosted, legacy and installed persistence

Use human-controlled disposable contexts/wards, preserving normal profiles.
Record extension ID/version/package checksum, ward owner, enabled registry,
storage values and download/checkpoint checksums before/after each transition.
Close gracefully; SIGKILL immediately after storage changes does not prove persistence.

| Path | Human procedure and passing evidence |
|---|---|
| Browserbase enable/restart | New ZIP starts disabled. Disable Glaze/current extension, enable a disposable MV3 storage extension and explicitly restart. One enabled extension loads; a second is refused before provider creation. Keep hosted session/context identity private. |
| Browserbase storage | Set harmless unique `chrome.storage.local`/`.sync` values through extension UI; close/restart twice. Same ID and both values survive. Record other database persistence separately. |
| Browserbase downloads | Controlled public HTTPS page: click download and fetch inline PDF URL. Check pending/ready/failure, retained checksum, save-copy, conversation import/text/page rendering and cross-user refusal. Record provider failures. |
| Legacy app CDP | Use an actual older CDP-tunnel topology with updated extension-capable desktop, preserving topology. Verify authenticated `extensions:<ward>` transfer, enabled packages/restart/storage, click/direct downloads, explicit capability-absent error. Record both versions. |
| Installed migration | Inventory disposable extension packages/registry, cookies, tabs, downloads, ownership and transfer checkpoints. Coordinator performs profile-preserving signed upgrade. Verify checksums/storage/owner and resume without duplicate bytes; an uncommitted chunk never advances a checkpoint. |
| Rename/rekey/delete | Rename/rekey the disposable ward: packages/downloads/owner stay associated. Delete only that ward: its profile/packages/downloads disappear; unrelated wards/users remain intact. |

## Preparation evidence, 2026-10-10

Source `82abf2cb0cea9b17dc4cd6331a018724b8c4c98a`, dev/1.0.18; Node 26.10.0,
arm64 macOS 27.0.1 build 26A434. Source preparation is not signed/installed evidence.

- Twelve focused existing agent/browser suites: **114 passed, zero failures/skips**;
  private log `/tmp/rime-browser-offline-20261010.log`.
- Disposable B5 assert check: nine inactive actions across local/app/Browserbase
  configurations returned `running:false` without a profile; three actual local
  tool calls did not launch. An opened local page's unique console error was
  scoped correctly and gracefully closed. No hosted/legacy transport was used.
  Initial cleanup used the wrong argument; corrected complete run passed.
- Voice `--check`: **unavailable**, exit 1, “No ChatGPT connection in this database.
  No provider calls were made.” No real probe or acoustic run occurred.
- Built conversation UI smoke passed with disposable accounts/synthetic events
  and no provider calls. Browser UI and remote-workspace smokes also passed;
  remote continuation/reconnect/privacy used fixture model responses, no provider.
  Coordinator records final committed-build smokes separately.
- Main macOS Runtime CI on this SHA failed two browser-live checks (prior mouse
  release crossing a fixture boundary; missing RTC offer). A disposable delayed
  cleanup reproduced the exact extra `mouseup`; awaiting the previous input
  worker before clearing the next fixture log fixed that reproducer. No runtime
  behavior or safety assertion changed. RTC passed standalone/focused repeats;
  its unchanged timeout now records capture state on failure. The earlier CI
  failure still needs a passing final-candidate run.

Outstanding: reviewed human results for installed/external rows, exact signed
artifact identity, final committed local/build/desktop checks and final CI.
