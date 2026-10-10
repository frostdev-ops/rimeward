# Provider ownership review and acceptance record

This is an evidence record, not new authorization. Current source reconciliation
is followed by the historical parent review from 2026-09-15.

## Current source reconciliation — 2026-10-10

RIME-12 implementation was committed as `60c7565` (installation-bound provider
connections/routes); `46162cf` corrected routed provider mocks and cross-platform
fixtures. Reconciliation inspected `dev/1.0.18` at `82abf2c`; this is source
evidence, not installed/provider acceptance. RIME-13 remains open for the
[human-run two-installation matrix](validation/integration-acceptance.md#rime-13--two-installation-provider-ownership).
The September 629/632 result below belongs to its named snapshot. It cannot
establish current failures or current acceptance; validate the actual candidate.

Current enforced values: [provider contract](../src/lib/agent/contract.ts)
`{ providerScope: 2, routePin: 2 }`,
[chat format](../src/lib/agent/chat-format.ts) **4**, and
[compat pin](../src/lib/agent/route.ts) `server:<installation>:<profile>:<url>`.
An old profile-only pin parses as unidentified. A new desktop refuses remote
model authority without installation/generation/contract-2 guarantees; it does
not knowingly accept an old peer ignoring account checks. Protected chat records
are held back from format <4 peers by both harness and sync paths. These supersede
the contract-1, chat-format-3 and permissive-old-peer descriptions in section 12
of the historical plan.

| Checkpoint | Current source disposition | Existing test evidence and remaining human gate |
| --- | --- | --- |
| R1 Recorded backend/local compat | `resolveProviderRoute`, `recordedBackendCheck`, `parseRemotePin` in [route.ts](../src/lib/agent/route.ts) and `getProvider.run` in [provider.ts](../src/lib/agent/provider.ts) refuse pin/route conflicts; serving installation and profile qualify remote identity. Unpinned compat history is blocked where previous relay cannot be ruled out. | [conversation tests](../tests/agent-conversations.test.ts) preserve existing history behavior; they do not exercise the live cross-installation pin matrix. P7 checks same alias, machine-local URLs, repoint and legacy history. |
| R2 Source-bound catalog/context | `modelCatalog` in [models.ts](../src/lib/agent/models.ts) accepts the admitted route; `sharedCatalog` in [sync.ts](../src/lib/agent/sync.ts) verifies contract/runtime/profile/generation and caches by pairing/installation/profile/generation/provider/backend. Local Codex/OpenAI catalog keys in [codex.ts](../src/lib/agent/codex.ts) include credential generation; `getProvider.context` uses the same route. | [context tests](../tests/agent-context.test.ts) cover context arithmetic, not paired provenance. Codex may show a labelled fallback catalog when discovery fails; it is not a live catalog attestation. P1/P4/P8 verify actual source, defaults, freshness and cache segregation. |
| R3 Credential account pinned | [accounts.ts](../src/lib/agent/accounts.ts) persists opaque UUID generations; refresh preserves its owning revision. Provider dispatch/transport retry re-checks credential, while [harness model dispatch](../src/pages/api/devices/harness/[...action].ts) validates contract/runtime/profile/generation and passes `credential` into the outgoing call. | [provider tests](../tests/agent-providers.test.ts) cover dialect/stream mechanics; [harness authorization test](../tests/agent-sync.test.ts) scopes calls to the authenticated account. Neither proves real 401/reconnect races. P3/P6 require a controlled boundary and provider receipts. |
| R4 Scoped writes/transport | [provider API](../src/pages/api/account/provider.ts) requires valid target and binding; `runtimeBinding` in [provider-scope.ts](../src/lib/agent/provider-scope.ts) hashes opaque account generations including Browserbase. Remote writes keep the validated `instanceRequestOn` connection and server generation precondition. | [identity tests](../tests/identity-redesign.test.ts) cover session/CSRF and credential protection, not every provider card mutation. P3/P10 check same-mask replacement, stale/missing target/binding and unauthorized requests. |
| R5 OAuth binding/recovery | [desktop provider cards](../src/scripts/app/desktop-providers.ts) retain render-time binding and dispose OAuth controllers. [account-oauth.ts](../src/scripts/account-oauth.ts) guards async results; [OAuth API](../src/pages/api/account/oauth.ts) uses session-bound attempt enumeration and remote owner receipts; `codexAttempts` in [codex.ts](../src/lib/agent/codex.ts) filters session. | [identity](../tests/identity-redesign.test.ts), [OAuth state](../tests/oauth-state.test.ts), [integration](../tests/oauth-integration.test.ts) and [loopback](../tests/codex-loopback.test.ts) checks are partial mocked/local evidence. P5/I5/I6 require simultaneous scopes, restart/disposal, stale card and actual OS consent/handoff. |
| R6 Turn/child/UI source | [core.ts](../src/lib/agent/core.ts) carries admitted `ToolCtx.route` into matching child work and model validation; provider receipt is attached to call records; running ward surface reports the in-flight source separately from next-turn policy. Resume/continue validate recorded backend and run owner. | [core](../tests/agent-core.test.ts), [conversation](../tests/agent-conversations.test.ts) and [placement](../tests/agent-placement.test.ts) suites exercise scripted work/history/owner behavior, not a live policy/account switch mid-turn. P4/P6 inspect child/one-shot/compaction/continuation receipts. |
| R7 Voice owner/control | [voice API](../src/pages/api/agent/[ward]/voice.ts), `sharedVoice` in [sync.ts](../src/lib/agent/sync.ts) and [voice leases](../src/lib/agent/voice.ts) check original pairing/runtime/profile/credential/lease. Uncertain stop retains owner receipt; missing owner cannot guess. [transcribe.ts](../src/lib/agent/transcribe.ts) deliberately requires local clip credentials. | Existing [Live delegation tests](../tests/agent-live.test.ts) cover router/deduplication, not provider lease ownership. P9 and RIME-19 supply one actual owner-switch/cleanup record; remote-only clip availability is inspected without upload. |
| R8 Health versus authority | [sync.ts](../src/lib/agent/sync.ts) separates online/reachable/authority and transport/authority failure; [route.ts](../src/lib/agent/route.ts) blocks unverified identity/protocol rather than Automatic account hopping. Sync format errors alone do not revoke valid model authority. | [sync tests](../tests/agent-sync.test.ts) cover auth/CAS/local-data boundaries, not the entire authority/outage matrix. P2/P8 verify transport outage, revoked pairing, mismatched identity and old protocol separately. |
| R9 Compatibility/constraint preservation | Contract 2 and chat format 4 are negotiated; [harness](../src/pages/api/devices/harness/[...action].ts) refuses empty/non-string/>300-character backend constraints instead of dropping them. [sync.ts](../src/lib/agent/sync.ts) pauses protected history to incompatible peers. | Current source supersedes permissive old-peer assertions; no dedicated existing test directly covers all remote format/pin combinations. P7/P8 need actual old/new artifacts and identity-specific history/catalog results. |
| R10 Offline Account ownership | [instance-routing.ts](../src/lib/dev/instance-routing.ts) redirects joined desktop `/account` to `/desktop/server-unavailable` when it cannot supply the server-owned page; destination-bound provider/OAuth paths stay local. [legacy agent form](../src/pages/api/account/agent.ts) requires bound credential scope and refuses relayed/native local credential writes. | [instance tests](../tests/instance.test.ts) cover routing safeguards but do not establish the formerly unsafe offline credential submission. P2/P3/P10 require outage/recovery, stale form and standalone behavior on installed candidate. |

Focused preparation checks on 2026-10-10, source `82abf2c`: existing Notion,
Notion-codec, identity-redesign, OAuth-integration, OAuth-state, Codex-loopback,
setup, agent-providers and agent-sync suites **86/86 pass**, no skips. A separate
existing agent-core run **36/36 pass**, including both named historical failing
scenarios (computer observations/pending approval and resumed-confirm
interjection filing). This resolves their status for this local source check,
not all installed/live routing acceptance. Tests use
isolated data and mocked provider transports; no external provider action or
account mutation was performed. Full candidate validation belongs to the
coordinator. No source or test code was changed for this reconciliation.

## Historical final checkpoint — direct implementation, NOT fully accepted

The user asked Rime to implement the corrections directly at 22:07Z and to wrap
up at 22:38Z and 22:42Z. Claude remained idle; its handoff monitor was deleted.
The historical first/second handoff findings below are retained as review evidence,
not a claim that their original source is still current.

Rime directly implemented:
- Opaque persisted credential generations, including Browserbase and ordinary
  refresh preservation; generation checks at model retry/dispatch boundaries.
- Bound legacy Account forms and a server-unavailable Account surface instead of
  editable local fallback followed by remote form forwarding.
- Render-time OAuth bindings, session-filtered recovery, per-session remote receipts,
  superseded-attempt protection, and disposable/attempt-bound frontend controllers.
- Serving installation plus profile/backend identity, provider contract version 2,
  chat format 4, and refusal of unverified older model-routing contracts.
- Separation of transport outage from authority failures, route-bound catalogs,
  generation-separated caches, catalog-envelope freshness, and call-receipt source
  attribution.
- Voice credential/owner checks and retention of uncertain stop receipts.

**Final snapshot:** `/tmp/rime-provider-final.OBH3PM`, based on
`fbb3c72121e2209cec32600b625616109235d7a6`.

**Observed final checks:** typecheck PASS; desktop lint PASS (11 pre-existing
informational findings); build PASS; `git diff --check` PASS. Existing test suite:
**629/632 PASS, 3 FAIL**:
1. `tests/agent-core.test.ts:89` — computer observations / pending approval:
   `codex: not connected`.
2. `tests/agent-core.test.ts:382` — resumed-confirm interjection filing:
   `codex: not connected`.
3. `tests/browser-live.test.ts:306` — WebSocket frame wait timed out at 8000 ms.

At that snapshot, the two core failures were unresolved regressions in the direct implementation's
provider-wrapper/mock interaction; do not dismiss them as baseline failures.
The browser frame timeout resembles previously observed flakiness, but this final
run failed and was not retried to manufacture a green result.

No test code was changed or added. The final revised provider UI, two-installation
flows, live OAuth and paid inference were NOT exercised. Earlier isolated UI
observation covered an older snapshot only. No final desktop packaging/signing
check or updated UI smoke suite was run. This is a local, uncommitted checkpoint,
not release sign-off. No commit, push, deploy, install, version bump, live credential
or pairing change was performed.

## First handoff: NOT ACCEPTED

Claude's first implementation is preserved in `/tmp/rime-provider-review.9iFlqg`
(baseline `fbb3c72121e2209cec32600b625616109235d7a6`, generated patch plus untracked
implementation files). Parent independently ran the existing suite: 632/632 pass;
typecheck and build also pass. The unchanged baseline independently passed 632/632
in `/tmp/rime-provider-baseline.sBY47J`.

Passing those checks does not establish the new ownership guarantees. The following
source paths contradict the approved plan and block acceptance. No new test code
is authorized; use existing tests and manual checks in disposable profiles.

### R1 — existing local compat constraints can be bypassed

`getProvider.run` now always follows `route.via`; for a conversation with an existing
local `call.backend` URL, an Automatic server route can send context remotely using
`route.remoteBackend` instead. Previously the recorded local backend prevented
relay. Reject a route inconsistent with the recorded constraint before sending
anything; never substitute today's remote attestation for the recorded local pin.

`turnProvider` also permits a historical unpinned compat conversation to be stamped
with today's backend. Its `unpinned` option protects only some Automatic/paired
cases, not runtime-only or removal of the old pair. Unknown history is not evidence
of local identity. Remote pins must include the serving installation/profile,
not only `server:<url>`: localhost URLs on different servers are not interchangeable.
An old peer with no backend attestation must not silently accept an unverified pin.

### R2 — catalog and context still disagree with the selected source

`modelCatalog` still unconditionally calls `sharedCodexModels` and `sharedCatalog`,
including under runtime-only. Those helpers do not take the resolved route.
The Codex helper still returns a cached server list while offline; server cache keys
still use origin (plus provider/alias), not profile, pairing and credential identity.
`sourceOf` still infers freshness from optional context fields. Non-Codex context
can still use local provider context for a server route. Pass one source-bound
resolution through discovery, validation, context, defaults and dispatch; implement
envelope-level provenance and segregate/invalidate caches by actual identity.
Do not fall back to local discovery/context for a pinned server route.

### R3 — credential/account identity is not pinned across calls

`ResolvedProviderRoute` contains no local credential identity or generation.
Local `provider.run` re-reads whichever credential exists on each call. A reconnect
between tool-loop rounds can still change billing accounts. Remote `/model` requests
likewise carry no expected server profile/account generation to check at the server;
comparing the client's cached `shared.profile` is not server-side verification.

The new conditional access-token poisoning improves the 401 path, but a replacement
between that update and recursive async header acquisition can still select the
new account. Carry a stable account/credential identity through request construction
and refresh/retry, preserving the existing refresh compare-before-store protection.
Apply equivalent rules to keys and endpoint credential changes.

### R4 — scoped management preconditions are optional and transport re-resolves

`/api/account/provider` treats an absent/invalid target as runtime and only checks
runtime binding when it is nonempty. A missing binding therefore permits writes.
Policy and primary mutations also permit missing bindings. Require an explicit
valid target and the intended preconditions; do not silently choose a destination.

The endpoint validates one connection, then `instanceRequest` looks up the primary
again. Pass a resolved, validated connection through the operation, including the
status response and OAuth operations. `runtimeBinding` is only installation/profile;
it does not change when the provider account is replaced. Add the relevant credential
generation preconditions without exposing credentials.

### R5 — OAuth start can still change the destination shown by the card

The new card passes only the string `server`/`local`, not its binding, into
`wireCodexConnect`. A stale server card can therefore start on a newly selected
server; with no remaining pair, `destination: server` falls through to local sign-in.
Reject rather than retarget. Bind start and all later actions to the validated
original destination and account/session.

Pending UI storage is scoped only by `runtime`/`server` or `account`, not by
pair/profile/attempt. The new attempt-enumeration API is not used by the UI and
local enumeration does not recover server-owned attempts. Audit reload/restart,
two pending scopes, stale async polling after card replacement, and completion
return from legacy `/account` local sign-in; do not reload the remote account page.

### R6 — children and UI do not inherit the running turn's source

`runChildRun` explicitly resolves a fresh route from current settings instead of
inheriting the parent's admitted source. A policy/connectivity change during a turn
can therefore send child context elsewhere. Carry the parent route in the execution
context and validate it for spawn/fork/resume and compaction.

`wardSurface` computes a new provider/route, even while a turn is running. Its
composer label may describe today's settings rather than the source actually in use.
Expose the live receipt during a turn and clearly distinguish next-turn policy,
historical source and unknown provenance. Review one-shot/model-switch paths too.

### R7 — voice stores an owner ID but does not use it

`pinnedVoiceRoute` includes `serverId`, but heartbeat/stop call `sharedVoice`,
which always uses the current primary. Start also resolves once then re-resolves
inside that helper. A server switch can direct control to the wrong installation.
The receipt is ward-scoped rather than bound to the actual lease/principal, and the
no-receipt branch restores the old remote/local fallback. Pin and verify the full
session owner throughout; unknown ownership must not guess or claim a stop.
Preserve cleanup/lease expiry without clearing a receipt as proof of remote success.

### R8 — health split is not sufficient identity/capability validation

The `answered` flag stays true after invalid payload/profile mismatch. Cached
capabilities can then remain eligible against a different current connection.
Separate transport reachability from verified model authority/compatibility.
Bind capabilities to the actual connection and profile. Authentication/revocation,
incompatible model protocol and invalid identity must not be treated as ordinary
offline consent to choose a different billing account.

### R9 — compatibility and documentation must match enforced guarantees

New `server:` values enter existing enforcement-critical conversation endpoint
fields without a negotiated history/route format. Old readers and server-local
continuation need explicit handling; do not reinterpret a machine-local URL on a
different serving runtime. `/model` also silently drops backend strings over 300
characters instead of refusing an unsupported constraint. Never drop constraints.

Do not describe all phases as complete or the tree as clean while source changes
remain uncommitted and acceptance cases are unverified. Reconcile section 12 against
the actual corrected implementation and evidence. No release/install/live OAuth
acceptance is authorized or established.

### R10 — the original offline Account ownership bug remains

First-snapshot `instance-routing.ts` still returns local `/account` HTML when shared
sync is offline, and still forwards `/api/account/agent` to the current server.
The new guard inside the local handler cannot protect a request that middleware
forwards before that handler runs. A locally rendered Disconnect/key form can still
write the remote account when the connection recovers. Implement the plan's stable
server-unavailable Account surface rather than editable local fallback; keep
standalone local Account behavior intact. The banner also claims unreachable means
local inference even for strict server-only policy.

## Second handoff: NOT ACCEPTED

Snapshot `/tmp/rime-provider-review2.jTJE4l`. Parent independently ran the existing
suite once: 632/632 pass; typecheck, desktop lint and build pass (lint reports 11
informational findings). This is not a retry-until-green claim. First-snapshot
provider page was opened in an isolated Chrome profile via native background
observation; corrected-build manual inspection is in progress.

Several first-pass problems are improved: explicit `/provider` targets/bindings
are now required, resolved transport is available, and local compat constraints
are explicitly checked before remote dispatch. The following are still blockers:

1. **R10 remains unchanged.** The original offline `/account` ownership split is
   still in middleware; the local handler's new guard cannot protect forwarded
   requests. Implement R10 above, including legacy/native-relay credential guards.
2. **R5 remains.** OAuth retrieves a new binding at click time rather than carrying
   the binding of the displayed card. A stale A card can authorize B. Missing
   bindings are still accepted in the OAuth endpoint. Preserve the displayed
   destination, reject stale/missing scope preconditions, and keep direct server
   login working without silently weakening paired-desktop writes.
3. **R3/R4 generation is not an identity/version.** `credentialId` uses masked API
   key labels; `runtimeBinding` also uses Browserbase presence. Different keys can
   have identical masks, and replacing a present Browserbase key always preserves
   its binding. Use persisted opaque generations for replacement/removal/reconnect,
   with ordinary refresh preserving its owning generation. Do not expose secrets.
4. **R3 server dispatch discards its check.** The harness checks `body.generation`,
   then awaits `getProvider`, but omits `credential` from the resulting ProviderCall.
   A reconnect after that await or during a 401 retry is therefore not constrained
   at request construction. `getProvider` also returns a bare provider immediately
   on non-desktop runtimes, discarding the caller's pinned route. Server-owned turns
   need the same per-turn credential guarantees. OpenRouter's retry path lacks the
   credential check too. Validate actual request credentials, including absence,
   at every dispatch/retry boundary.
5. **R8 still converts invalid authority into Automatic local fallback.**
   `resolveProviderRoute` calculates `usable` from authority, then falls through to
   `local` when authority is false. An identity/protocol/auth failure is not ordinary
   transport outage. Keep these cases blocked rather than changing billing source.
6. **R9 deliberately weakened old-peer behavior is not approved.** The handoff
   explicitly says old servers may ignore mid-turn generation checks. A new client
   must negotiate the required guarantee and fail closed when absent, not silently
   soften it to preserve old pairs. Bump the capability version when semantics
   change; a capability-1 first-pass peer does not enforce the new checks.
7. **R1/R9 serving profile is not serving installation.** `profileId` is a shared
   sync identity, not a unique machine identity. Remote pins/capabilities need the
   serving installation/runtime as well as profile and URL; otherwise the same
   shared profile on a different machine can reinterpret a localhost endpoint.
8. **R2 remains only partly route-bound.** Provider context calls shared catalog
   helpers without its pinned route; those helpers re-resolve the current primary.
   Cache keys still need account generation separation/invalidation, not just the
   shared profile and alias/backend. Apply the admitted route to discovery,
   model-switch validation, context and actual dispatch consistently.
9. **R5 lifecycle/recovery remains unsafe.** Card replacement does not dispose old
   pollers/visibility listeners. Recovery runs while Start is enabled and can
   overwrite a newly started attempt; responses are not matched to a captured
   attempt/controller generation. Return/invoke a disposer and guard async results.
10. **R5 attempt enumeration is account-wide rather than session-bound.**
    `codexAttempts` filters by user, not the initiating session; UI adopts the first
    destination match, then ordinary poll/cancel authorization rejects it. Filter
    enumeration by the authenticated attempt binding and reconstruct only authorized
    remote owner receipts. Do not disclose/adopt another session's attempts.

Items 1, 2, 3, 9 and 10 were independently corroborated by read-only child review
`ed0add55-2194-4255-b977-0e1c55e5e1fd`; parent directly checked the core source paths.
No child source/test changes were made.

## Review process constraints

- Rime took over source corrections on the user's instruction; Claude is idle.
- Do not stash, reset, checkout or restore the shared source tree for A/B validation.
  Use separate generated snapshots/worktrees and preserve unrelated edits.
- No new or changed test code, including temporary bespoke test scripts.
- No live credential, account, pairing, service, deployment or installation actions.
- Parent will independently inspect corrections and verify the completed UI.
