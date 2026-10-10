# Human-run integration acceptance — 1.0.18

Prepared 2026-10-10 for RIME-47; acceptance belongs to RIME-6, RIME-9 and
RIME-13. **No external acceptance has been run or passed in this record.** The
[delivery contract](../board/DELIVERY.md) reserves all Notion, identity/OAuth,
SMTP and model/voice provider actions to the human operator. Agents may prepare
procedures, run existing isolated tests and diagnose returned redacted evidence.
This document does not authorize an agent to contact or mutate those services.

## Candidate and evidence prerequisites

1. Obtain the coordinator's RIME-46 candidate-ready handoff: full committed SHA,
   version, clean build, installer/runtime hashes, signature/notarization status,
   server artifact/deployed SHA, and local/CI validation results. Do not use a
   running development tree or assume the installed 1.0.17 app is the candidate.
   Candidate-ready is separate from release acceptance.
2. Use disposable Rimeward profiles/data directories and test accounts with no
   production documents or messages. The coordinator prepares installations and
   backups under the local release guide; the human selects
   credentials, consent, account replacement and pairings. Do not import a CLI
   auth cache, copy project roots or `workspaces.db`, or replace a normal profile.
3. Inventory actual hosts and record OS version/build, architecture, app/runtime
   version/hash, browser, server/broker origin and candidate SHA. An absent Windows
   or Linux installed host is **blocked**, not covered by macOS or a build job.
4. Record test account labels A/B and workspace/source labels without credentials.
   Keep tokens, callback codes, setup/invitation tokens, PKCE verifiers, SMTP
   passwords, raw request bodies, cookies and personal data out of committed
   evidence and the board. Network evidence should retain only path, status,
   time, sanitized source identity, request ID and counts; do not attach raw HARs.
5. Make one pass per scenario. Stop at an unexpected destination, duplicate write,
   provider denial, 429, timeout or budget limit; retain the result and diagnose
   before rerunning. An uncertain create/send/authorization-code exchange is read
   back or polled through its existing receipt; it is never blindly repeated.

Each table's action bound is a limit on deliberate human actions. One UI action
can make several upstream calls, paginate, refresh or retry internally; record
actual counts separately. It is not proof of a provider-request or spend ceiling.
For external paid calls the operator also sets a provider-side spending cap where
available, records the chosen model and maximum output, and stops on exhaustion.

## RIME-6 — disposable linked Notion database

Source: [linked UI contract](../notion-notebook-design.md),
[linked API](../../src/pages/api/notion/linked.ts), `notionLinked*` in
[notion.ts](../../src/lib/notion.ts), and `linkedAskText`/`askNotebook` in
[notebook.ts](../../src/lib/notebook.ts). Existing
[Notion parsing tests](../../tests/notion.test.ts) and
[codec tests](../../tests/notion-codec.test.ts) exercise parsing/serialization,
not the live linked API, view API, conflict guard or workspace replacement.

Human prerequisites: a disposable workspace A and separately identified
workspace B; a test integration shared only with the fixture; two independent
browser sessions; a notebook in the candidate. Before the timed run, the human
creates/imports a 250-row fixture, numbered 001–250, with `Marker=UNLOADED-250`
on row 250 and a saved table view showing only rows 001–010. Include title,
annotated/linked rich text, number, checkbox, date/timezone, select/status,
multi-select, a relation with 101 existing entries, formula/rollup/system fields,
and an unsupported value when available. Put `BODY-ONLY-MARKER` in a row's page
body. Retain original values privately. Fixture preparation is itself external
human work; it is not performed by this procedure's agent owner.

| Scenario | Exact actions and bound | Required observation |
| --- | --- | --- |
| N1 Read/view/pagination | New page → Linked Notion database → fixture source → saved view. Inspect its ten rows; select All rows and load through row 250 once (at most 6 grid-page loads). | Stable source/property/page IDs, visible continuation until exhausted, no local 200-row truncation or duplicate IDs; saved-view count differs from All rows. Formula/rollup/system/unknown cells cannot be edited. |
| N2 Lossless edit/insert | Edit one rich-text run and one scalar cell, Save to Notion once each; create one uniquely titled row once. Reload in Rimeward and inspect the same rows directly in Notion. At most 3 successful writes. | Unchanged runs, mentions, annotations, links, timezone and unrelated fields survive. Exactly one new page ID exists. A pending write or unsaved draft blocks navigation/close/reload; cancellation preserves the upstream original. |
| N3 Conflict | In session A open a cell edit; in Notion/session B change the same cell once; A submits its original draft once. Repeat once for a saved view or schema definition. At most 2 upstream edits and 2 rejected Rimeward saves. | Visible conflict (linked API 409), refreshed upstream value survives, draft recoverable; no blind overwrite. Read-before-write is not atomic CAS: this checks a change before the preflight read, not an edit racing after that read. |
| N4 Definition/long value | Save one supported view change and one property rename/format change. Read the full 101-entry relation once and attempt one edit/save of that value. At most 2 successful definition writes and 1 rejected property write. | Supported definition persists upstream; unrelated advanced rules survive. Long value is read completely before editing; a value above the 100-item write limit is refused without truncation. Removed/read-only properties remain protected. |
| N5 Source-wide Ask | Restore the ten-row view; do not load row 250 in this session. Ask once: “Which row has UNLOADED-250? Report database coverage and whether row page bodies were included.” Use this small fixture only; maximum 2 model dispatches including any summarization, then stop. | Answer/source evidence reaches row 250 despite loaded/view filtering; coverage reflects all selected sources, database properties only, no BODY-ONLY-MARKER as retrieved evidence. Record raw coverage fields separately from the model's prose. |
| N6 Retrieval failure/limits | Link a second disposable source, then human removes its sharing permission. Ask all selected notes once with an accessible source retained; maximum 2 model dispatches. For limit evidence use only an already prepared fixture that exceeds a documented ceiling; do not create 10,000 rows during the run. | Incomplete coverage notice lists the failed source/retrieval. Current ceilings are 10,000 rows, 2,000,000 characters and 100 long-property expansions per database; upstream incomplete queries, unusable cursors and incomplete properties must be disclosed. If no oversized fixture exists, record ceiling behavior as source-reviewed and live limit acceptance as not run. |
| N7 Account replacement/link sync | Human replaces A's connection with workspace B once; open the existing A link and attempt one save. Export link JSON, import once in the second candidate installation, then restore A only if the operator elects to. | Workspace mismatch refuses read/write; no B row is modified. Sync/export contains the versioned link and layout preferences, not remote rows or credentials; second installation requires access to the original workspace. |

Bound: at most 6 successful Rimeward writes, 4 rejected saves, 2 conflict-fixture
edits, 2 Ask actions, 1 account replacement and 1 link import. Fixture creation,
sharing changes, restore and cleanup are counted separately. Inspect each known
page ID after uncertain writes. Human archives only the disposable fixture after
evidence capture; do not delete anything when identity is ambiguous. RIME-6
remains pending for every unrun required case, including absent limit evidence.

## RIME-9 — installation identity, integration OAuth, SMTP and OS handoff

Source: [installation contract](../installation-and-identity.md),
[identity](../../src/lib/identity.ts),
[OAuth attempts](../../src/lib/oauth-attempts.ts),
[broker](../../src/lib/oauth-broker.ts),
[broker client](../../src/lib/broker-client.ts),
[integration route](../../src/pages/api/account/integration.ts), and
[loopback](../../src/lib/codex-loopback.ts). Existing
[identity](../../tests/identity-redesign.test.ts),
[integration](../../tests/oauth-integration.test.ts),
[state](../../tests/oauth-state.test.ts),
[loopback](../../tests/codex-loopback.test.ts) and
[setup](../../tests/setup.test.ts) suites are isolated/mocked checks;
[auth UI smoke](../../tests/auth-ui-smoke.mjs) sends no email and proves no consent.

Human prerequisites: candidate server and installed desktop on each claimed OS;
HTTPS public URL; registered redirects already configured by the human; a broker
running the candidate protocol; one test SMTP mailbox and recipient; a disposable
administrator retaining a working sign-in; two browser sessions/accounts A/B.
Inventory enabled SSO connectors separately from integration grants: Google,
Microsoft, Notion and Zoho integration callbacks remain
`{public-url}/api/connect/{provider}/callback`; identity callbacks use
`/api/auth/google/callback` or `/api/auth/identity/{connector}/callback`.
If provider registration/access is missing, stop that connector's scenario as
blocked. Configuring a broker URL does not establish its deployment or clients.

| Scenario | Exact actions and bound | Required observation |
| --- | --- | --- |
| I1 Setup/SMTP | In empty disposable server data, human claims setup once and configures public URL/SMTP. Send one wizard test email to the owned recipient. After receipt, Continue once with unchanged fields and finish setup. | Token cannot be reused; secret absent from rendered forms; actual recipient receives one message with recorded UTC/subject/message ID. Unchanged Continue keeps email verification; SMTP accepted/queued alone is not delivery. |
| I2 Invitation/approval/recovery | Send one invitation to owned test address; accept once through one enabled SSO or password. Where approval policy is enabled, perform one password recovery request before admin approval. | Invitation binds intended address/role; no automatic account merge solely by matching email. Pending account stays pending through verification/recovery; last-admin/last-working-login guard remains. Maximum 1 invitation + 1 recovery email, separately confirm both receipts. |
| I3 Direct integration consent | For each enabled Google/Microsoft/Notion/Zoho connector, start once in server browser's own session and complete once; cancel a second attempt before consent. | Own-session flow returns to Account without broker code hop; cancellation is terminal. A captured terminal URL reopened once cannot recreate credentials. Record actual scopes, provider account and legacy callback path, with codes redacted. |
| I4 Standalone/paired broker | For each enabled connector, complete one standalone-desktop start and one paired-desktop start. In broker browser verify displayed destination account/code before approving. Poll existing receipt, then reload originating card once. | Both brokered/relayed flows retain confirmation hop. Only initiating runtime claims delivery; credentials persist at selected destination; broker does not pair a standalone desktop or sync files. `rimeward://oauth/complete` only raises native window; polling establishes completion. |
| I5 Session/cancel/stale callback | For one representative connector, start in session A, try approval once in wrong destination B, then cancel in A and open its stale completion once. Start a fresh attempt, reload/restart desktop before completion, then complete once. | Wrong account/session refuses; cancelled attempt cannot resurrect; recovered attempt remains destination/session-bound; no duplicate code exchange or false automatic-listener claim. Repeat connector-specific failures before accepting that connector. |
| I6 OS loopback/manual | On each installed OS, complete one ChatGPT connection in disposable local scope with port 1455 free. Human then occupies 1455 using a disposable owned listener; start one more attempt, verify manual fallback, and cancel it. | System browser returns to exact `/auth/callback`; owned listener is not killed/stolen. Mismatched state does not claim an attempt; listener closes on terminal result. OS app focus/deep-link behavior observed on actual installed candidate. Reuse matching P5 evidence below. |
| I7 Disconnect/refresh handoff | On one disposable integration, human disconnects while a pending attempt exists, then opens its stale completion once. For real refresh/lost-response behavior, retain one expiring test grant and observe one refresh; if no safe expiring grant/network interruption is available, record blocked. | Pending grant cancelled; old completion cannot reconnect. Refresh belongs to original grant, rotation recovery does not replay a consumed provider exchange, disconnect disables broker access. Source/mocked refresh evidence alone does not pass the real-provider gate. |

Per connector: at most 3 completed integration consent flows (direct, standalone,
paired) and 1 cancelled start; I5/I7 add at most 3 starts total on the selected
connector. Per OS: 1 completed ChatGPT handoff + 1 cancelled busy-port start.
SMTP bound is 3 delivered emails including invitation/recovery, no bulk mail.
SSO connectors not covered by I2 need one additional explicit sign-in/return
check each, listed before execution. Read provider connection status once after
each terminal result; do not use a model call to prove OAuth. Refresh waiting is
scheduled by the human; no background automation or repeated consent is implied.

## RIME-13 — two-installation provider ownership

Use the [R1–R10 reconciliation](../desktop-server-provider-review.md#current-source-reconciliation--2026-10-10)
and [policy matrix](../desktop-server-provider-plan.md#10-validation-and-acceptance-matrix).
Human prerequisites: candidate desktop D and candidate server S in disposable
profiles, paired by the human; server browser session; distinct test provider
accounts A/B with permission to replace only those connections. Record serving
installation, sync profile, pairing and opaque generation through sanitized
status/receipts, not tokens. A provider with no test credentials is blocked.
Have a separately staged old-peer artifact reporting contract 1/format 3 or
older, and an independent installation S2 for switch/identity tests; record their
SHAs. Do not label an old browser cache as an old protocol peer. S2 and old-peer
execution remain human-run; never repoint production services.

Provider management: `/desktop/providers` is desktop-owned, `/account` is
server-owned when paired. Policies are Automatic, This runtime only and Connected
server only. Current `providerScope`/`routePin` are both **2**, `CHAT_FORMAT` is
**4** and compat pins are `server:<installation>:<profile>:<url>`. Unsupported
remote authority/contracts refuse; transport outage alone may select same-provider
local access for a new Automatic turn. An admitted turn never changes source.

| Scenario / checkpoint | Exact human actions and bound | Required observation |
| --- | --- | --- |
| P1 Scope/mode inventory (R2/R4/R10) | Inspect fresh D, direct S and paired D. With only S configured, then only D, then both A/A and A/B, load cards/catalog once per state. Select each of 3 policies in both-configured state. | Destination/connection labels stay distinct. Runtime-only uses local catalog/default/context; server route uses server envelope `origin/source/fetchedAt/profile`. Credentials never sync. Viewing a desktop chat in S does not change run owner. |
| P2 Offline/account/authority (R8/R10) | Human isolates S transport in disposable environment; load paired `/account`, provider page and submit one already-rendered server form. Restore S; repeat with revoked pairing or mismatched identity/unsupported contract. | `/account` gives server-unavailable surface, local controls remain local; stale/unknown server write refuses. New Automatic same-provider transport fallback is disclosed; server-only refuses. Authority/protocol/auth failure never silently bills D. Sync-only failure/old history format does not change model source. |
| P3 Stale forms/account generation (R3/R4) | Keep A card open. Human replaces disposable key/account with B (including a key with same masked ends), then submit one stale form. Repeat after switching S→S2 and after removing pair. Maximum 3 stale submissions. | Binding/generation conflict (409 or unsupported-contract 426); neither B nor S2 changes. Policy/primary writes require runtime binding. Browserbase replacement is generation-sensitive even when presence stays true; no hosted browser start needed. |
| P4 Text source/receipts (R1/R2/R6) | For each configured provider family, send one fresh “Reply only ACCEPTANCE” turn in each of 3 policies; then one inherited child/one-shot or resumed-history scenario with bounded harmless read-only context. | Composer's running receipt agrees with call record and serving account. Catalog/context/model selection matches admitted route. Parent/child/compaction keep route; resume checks its recorded identity. Unsupported/no-credential states refuse before dispatch. |
| P5 OAuth races/recovery (R5) | In D start local and server attempts together. Reload once; restart once; cancel one and complete the other once. In stale server card start after S→S2 switch; open late callback after disconnect. Repeat recovery in second browser session. | Displayed binding captured at render; no retarget, no other-session adoption. Disposed card's old poller cannot overwrite replacement. Single-use/latest completion wins; busy-port fallback retains original scope. Reuse I5/I6 evidence where the same candidate/scenario matches. |
| P6 Mid-turn replacement/failure (R3/R6/R8) | Admit one two-round read-only/tool turn on S; while its first round is held, human replaces only S test connection. Observe next round once. Separately interrupt one dispatched stream and Stop once. | Generation mismatch stops before replacement dispatch/retry; receipts show original source. Failed/uncertain stream is reported, no local replay, no repeated tool action. Refresh preserves owning generation; a 401 cannot poison/retry on B. A race without an observable controlled boundary is blocked, not passed by fast clicking. |
| P7 Compat pins/legacy history (R1/R9) | Use same alias on D/S with different endpoints, including same loopback URL on different machines. Continue a local-pinned chat under server-only, remote-pinned under runtime-only, after endpoint repoint, and a pre-pin history on previously paired D. Maximum 4 continuation attempts. | Recorded pin outranks preference; mismatch refuses without context reaching alternate backend. Unknown or unattested old pin stays unknown, never backfilled from current alias. S local continuation accepts only its own installation/profile/backend. |
| P8 Old peers/catalog provenance (R2/R8/R9) | Pair disposable new D to staged old S once; inspect unsupported server controls and admit one fresh remote turn. Repeat new S/old D history sync using an existing remote-pin record; switch S/S2 sharing a profile and hostname, then read catalog once. | Contract 1/missing runtime/generation fails closed for remote inference/scoped writes; supported local management remains usable. Format <4 holds protected chat records back, local history intact. Catalog cache cannot cross pairing/installation/profile/generation/backend; cached/fallback lists are labelled and never proof of live access. |
| P9 Voice owner/clip capability (R7) | Start one short voice lease on S; switch primary to S2 while active; heartbeat/Stop once. Record owner receipt and confirm closure at original owner or retain uncertain stop until lease expiry. Inspect remote-only OpenAI/OpenRouter/compat clip availability without recording. | Control never lands on S2/local substitute; unknown owner refuses and uncertain stop does not claim closure. Remote-only clip is explicitly unavailable; ChatGPT Live uses its admitted voice route. Reuse RIME-19 owner/cleanup evidence; no duplicate voice run is required. |
| P10 Unauthorized/standalone (R4/R10) | In disposable sessions submit one missing-binding/forged-target write and one foreign-origin form; inspect standalone D without internet once. | No credential changes/secret disclosure; appropriate 400/403/409. Local non-AI tools remain available; cloud unavailability shown. Local compat eligibility does not imply a live provider pass. |

Bound per provider family: maximum **16 text dispatches total**, including tool
rounds, one-shots and any compaction; choose small context/output to avoid hidden
extra rounds and tally call records. P4 uses 3 basic turns plus one inherited
scenario; reserve remaining dispatches for P6/P7/P8. Stop before exhaustion and
record remaining cases as not run; no retry-to-green. Provider families are Codex,
OpenAI, OpenRouter and compat only where configured; no family's pass substitutes
for another's transport. P5 permits at most 5 starts, 2 completions, 3 cancellations
per destination set; reuse identity evidence instead of repeating consent. P9 is
one voice session, at most 30 seconds, only after the human verifies cleanup
controls; broader microphone/echo/delegation acceptance belongs to RIME-19.

For exact races (401/reconnect, tool-round credential replacement, lost broker
response), if the human cannot hold and observe the boundary safely on the
candidate, capture the missing setup and leave the case blocked. Source inspection
or a mocked unit pass is not a substitute. Clean up only disposable pairs/grants
through their owning installation; preserve uncertain receipts for diagnosis.

## Evidence record and closure

Copy one record per scenario and provider/OS combination. Store redacted evidence
outside `docs/goldens`; no golden generation or inspection is required.

```text
Package / scenario: RIME-__ / N__, I__ or P__
Operator:
UTC start / end:
Candidate commit (full SHA) / branch / version:
Server/broker commit and artifact SHA256:
Desktop installer/app/runtime artifact SHA256, signing/notarization result:
OS version/build / architecture / browser:
Installation D/S/S2/old-peer labels and protocol versions:
Provider / model / account A/B labels / workspace/source fixture labels:
Prerequisites confirmed / missing:
Action budget / actual app actions / actual provider requests / observed spend:
Steps performed and observable request/receipt identifiers (no secrets):
Expected result:
Observed result / direct provider-side readback:
Evidence file paths and hashes:
Result: PASS | FAIL | BLOCKED | NOT RUN
Limitations / unobserved boundary / skipped provider or OS:
Cleanup performed / uncertain operations retained:
Reviewer / affected rerun if candidate changes:
```

Preparing these procedures completes only the integration portion of RIME-47.
RIME-6/9/13 stay open until their required human records are reviewed on the exact
candidate. Coordinator posts `ready` only with actual accepted criteria, then
continues the already authorized release sequence. Candidate changes invalidate
affected results; unchanged evidence remains tied to its original artifact.
