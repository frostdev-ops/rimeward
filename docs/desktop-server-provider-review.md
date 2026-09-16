# Independent implementation review

Parent review, 2026-09-15. This is an acceptance record, not new authorization.

## Current checkpoint — direct implementation, NOT fully accepted

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

The two core failures are unresolved regressions in the direct implementation's
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
