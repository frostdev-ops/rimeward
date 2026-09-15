# Desktop/server provider ownership and routing plan

Status: implementation in the working tree, **uncommitted and not accepted**. The first handoff was
rejected by `docs/desktop-server-provider-review.md`; section 12 records the second pass, including
what that review found and what changed. Sections 1-11 are the design record as approved. The
acceptance matrix in section 10 is NOT satisfied: most cases are source-verified only. No test code
was added or changed, and nothing has been signed in, paired, disconnected, committed, deployed or
installed.

Source baseline: `0056cda`, inspected 2026-09-15. Unrelated source edits appeared during this review and were left untouched; line references are baseline-sensitive. Re-read changed files before implementation.

## 1. Objective

Make standalone desktop, server-only, and paired desktop use predictable without merging credentials or confusing where work runs with where inference is billed. Connecting, inspecting, reconnecting, and disconnecting a provider must operate on the installation/account explicitly shown. Model discovery, admission, inference, and auxiliary AI features must agree on that destination.

This is an ownership/routing repair, not a new login system. Keep existing OAuth, pairing, session binding, encrypted refresh-token storage, native execution boundaries, and sync machinery where they already provide the required guarantees.

### Non-goals and authorization boundaries

- Do not copy/sync OAuth credentials, import a Codex CLI auth cache, or sign the CLI in.
- Do not change Rimeward application-login identities, integration OAuth registrations, broker configuration, provider consent, or live pairings.
- Do not enable native execution on the ordinary server or replicate project roots/workspaces.db.
- Do not retry uncertain inference or tool operations on another backend.
- Do not introduce automatic multi-server failover, a general account-page rewrite, or clustered token refresh merely to fix this issue.
- No implementation, test additions, commit, deployment, or installation is authorized by approval of this planning document alone.

## 2. Current behavior and evidence

| Area | Current behavior | Assessment / source |
| --- | --- | --- |
| Standalone Codex | Local PKCE attempt, localhost:1455 callback listener, local token exchange/storage; manual fallback if the port is busy | Correct foundation: `api/account/oauth.ts`, `agent/codex.ts`, `codex-loopback.ts` |
| Paired Codex sign-in | Defaults to first paired server; desktop catches callback, server exchanges/stores credentials; explicit local destination exists | Preserve separation; make destination unambiguous: `api/account/oauth.ts:42-48`, `dev/remote.ts:45-49` |
| Account page | Joined desktop proxies `/account` to server online, renders local account when shared sync reports offline | UI ownership changes with connectivity: `dev/instance-routing.ts:104-121` |
| Account mutations | `/api/account/agent` proxies to server on a joined desktop; unlike `/account`, it has no offline-local exception | Offline local-page key/endpoint/disconnect/rounds/network forms fail instead of writing locally; if connectivity recovers before submission they can target server: routing plus `api/account/agent.ts` |
| Local OAuth completion | Reloads `/account`, which can show server status rather than newly connected local account | Confirmed source-path mismatch: `scripts/account-oauth.ts`, `pages/account.astro:967-1020` |
| Offline OAuth start | Pair existence defaults to remote, but the local-destination picker is hidden on the offline local HTML: its desktop marker is injected only into server-proxied HTML | Local OAuth is not reachable through this offline UI; fix capability rendering, not just the default: `api/account/oauth.ts:42-48`, `scripts/account-oauth.ts:3-5`, `dev/instance-routing.ts:117` |
| Text model route | Desktop tries sharedModel; only a null result selects local provider | Server-first intent; thrown failures do not invoke local fallback: `agent/provider.ts:287-306`, `agent/sync.ts:343-421` |
| Catalog/context route | sharedCodexModels can return a cached remote catalog when offline, while model calls select local credentials | Catalog provenance can disagree with inference: `agent/models.ts:46-61`, `agent/sync.ts:423-448` |
| Voice | sharedVoice selects server whenever paired; an offline request throws instead of returning null, so local voice is never attempted | Working local ChatGPT credentials do not rescue paired/offline voice: `agent/sync.ts:113-123`, `api/agent/[ward]/voice.ts` |
| Clip dictation | Eligibility uses shared-aware agentConfigured; all three routes (OpenAI, compat, OpenRouter) directly require local credentials | Capability and execution disagree for remote-only credentials: `agent/transcribe.ts:38-89,117-124`; OpenRouter audio bypasses the shared provider wrapper too |
| CLI auth | Native CLI runs with its own user environment/auth; backend credentials are not injected | Intentional boundary: `dev/environment.ts`, `dev/terminals.ts`, desktop setup docs |
| Refresh races | Codex refresh already checks stored token_enc is unchanged before committing | Preserve this protection; review 401 invalidation and reconnect/cache identity separately: `agent/codex.ts:165-224` |
| Sync failure versus billing | An uncaught sync failure, including workspace-format mismatch, sets the same online=false flag used to decide shared model access | A sync-format problem can select local credentials despite a reachable server; separate health domains: `agent/sync.ts` syncRime catch and sharedModel |
| Compat remote pinning | pinnableBackend deliberately returns null for a server-offered alias; fallback can then use a local endpoint with the same name without a recorded backend constraint | Existing local URL pinning is insufficient for relayed compat conversations: `agent/core.ts` pinnableBackend, `agent/provider.ts` getProvider, `agent/openrouter.ts` callCompat |
| Per-turn source stability | Capturing a provider object does not capture a source: its wrapper resolves sharedModel anew on each call | Multiple rounds of one turn can use different installations; turn-level route pinning is new work |
| Model/default inheritance | ward-config merges shared provider/model defaults independently of credential source | Runtime-only selection must use runtime-scoped model defaults, not a server-only inherited model: `agent/ward-config.ts:34-39`, `agent/provider.ts` defaultAgentProvider |

These are source findings, not completed destructive/live acceptance tests. Credential presence is not proof of a working refresh token. Sync online status is not proof that a particular provider is healthy.

Review evidence: dedicated Claude Code session `452e17b2-b3ff-4553-95d3-0020580016e6` completed read-only exploration and review of the draft. It reported no writes. Its corrections to audio routing, offline picker reachability, sync-health coupling, and remote compat pinning were independently checked before incorporation. No test suite or live account mutation was run for this planning task.

## 3. Product contract: three separate identities

Every relevant view and request must distinguish:

1. **Account/credential destination:** installation and authenticated account whose provider connection is read or changed.
2. **Run owner:** runtime coordinating the conversation, tools, approvals, and workspace.
3. **Inference route:** runtime/account making the actual provider request.

Example: `Run owner: MacBook` and `Model access: Connected server · ChatGPT` are both true. A web viewer opening that conversation must not reinterpret “local” as the viewer's computer.

“This runtime only” means the run owner's own provider connection. Render it as “This desktop only” when the owner is a desktop, and “This server” on a server. It does not promise that shared conversation history or other synced content bypasses the connected server. Describe inference routing separately from dashboard/history synchronization and tool routing.

### Recommended policies

Keep legacy behavior as the initial default, but expose its meaning:

| Policy | Before starting a turn | On failure after dispatch |
| --- | --- | --- |
| Automatic — server preferred | Use the specifically bound shared server if reachable and offering this provider; otherwise use configured same-provider runtime credentials | Report failure; do not reroute/replay |
| This runtime only | Use only the run owner's credential/endpoint | Fail clearly if unavailable; never relay |
| Connected server only | Use the selected, explicitly bound server/account | Fail clearly if unavailable; never use local credentials |

- Provider and model remain separately selected; local OpenRouter is not fallback for a Codex conversation.
- Do not silently substitute model IDs, a different server account, or an endpoint of the same name.
- Configured-but-invalid credentials, quota rejection, or model denial should prompt repair or an explicit next-turn route choice, not automatic account hopping.
- Resolve one effective route at turn admission. All tool-loop rounds, compaction associated with that turn, and model switches within that turn use it.
- A new turn may resolve Automatic differently; disclose a changed source before sending context. Existing automatic same-provider offline fallback remains documented. A changed server/account identity requires explicit acknowledgement rather than being treated as ordinary reconnect.
- Voice calls retain their chosen owner for start/heartbeat/stop; never resolve their owner anew for each action.
- New children inherit the parent's effective source unless a separately authorized route is explicitly selected. Resume/continue operations verify recorded route/backend constraints.

Recommended initial preference storage: local to the run-owning runtime/account, with runtime-qualified ward overrides. Do not sync a bare “local” or device-specific pair ID as a portable global preference. Public UI/API names are design choices, not an existing schema contract.

Provider/model/effort defaults must be resolved from the selected source's configuration. Preserve explicit ward choices, but do not use shared provider/model defaults as the base of a runtime-only ward. Keep persona, tool permissions, approvals and CLI permission inheritance separate; this repair must not silently change them.

## 4. Workstream A — explicit provider management

### Stable page ownership

Add a dedicated desktop provider-management surface, for example `/desktop/providers`, linked from Account → Agent and desktop Settings. It stays local regardless of connectivity and displays separate cards:

- **This desktop**: local provider presence/status and local Connect/Reconnect/Disconnect.
- **Connected server — host/account**: remote provider presence/status and server-targeted controls; cached status explicitly marked with last checked time.

The server Account → Agent page remains server-owned. For a paired server-owned `/account` during an outage, show a server-unavailable state and explicit links to local surfaces instead of transparently rendering the other account's editable form. Standalone `/account` remains local. Reuse shared components instead of forking the provider form. Do not keep a local form whose submit endpoint is implicitly server-owned. Replace the current “This desktop's settings” detour with the actual provider-management link; `/desktop/settings` is an admin configuration page, not a local provider account editor.

Standalone users see only the relevant local scope, not a default “Connected server” option. Render desktop capabilities explicitly on both local and proxied surfaces; do not infer desktop access solely from a marker that appears only in server-proxied HTML. A pairing outage must not change what an existing card or button targets. Display “Disconnected”, “Stored; not checked”, “Available”, “Needs sign-in”, “Offline”, and “Update required” distinctly.

### Destination-bound API

Introduce a narrow provider-management API/dispatcher with explicit targets for status, key save/clear, endpoint add/remove, OAuth, and disconnect. A target contains a server-validated runtime identity and, for remote access, the specific pairing/profile binding. Never accept a client-supplied arbitrary server URL, user ID, or forwardable bearer token.

- Server direct requests act on the session's own server account.
- Local credential management requires the directly authenticated local desktop owner; preserve the refusal of relayed/native-token OAuth requests and apply equivalent guards to local credential writes.
- Desktop-to-server requests use the existing authenticated pairing transport and stable OAuth binding.
- When adding scoped paths, update both the local-routing exclusions in `instance-routing.ts` and the narrowly allowlisted OAuth binding attachment in `remote.ts` (currently only `/api/account/oauth` and `/api/account/integration`). Reuse an explicit endpoint classifier; do not accidentally strip the binding or attach it to arbitrary forwarded paths.
- Bind target identity when a form is rendered; include a version/identity precondition in mutations. Reject stale forms after unpair, account replacement, or server switch.
- Resolve the target once and pass that resolved connection through the operation. Rechecking `pairs[0]` inside a helper must not redirect an already admitted write.
- Mutations fail closed on missing/revoked/changed targets. Never retry against another account or fall through to local.
- Apply CSRF/session/role checks and no-store responses; return only sanitized status, never token fields.
- Separate credential writes from unrelated account knobs (rounds, shell/network controls, Browserbase, etc.); inventory action cases so new routing does not accidentally move their ownership.

Server Disconnect removes only that server's provider connection. Local Disconnect removes only the local connection. Neither action unpairs the desktop, logs the user out of Rimeward, revokes a CLI login, or clears the other installation.

## 5. Workstream B — OAuth lifecycle

Reuse oauth_attempts and the existing PKCE/single-use completion flow.

1. Store an immutable structured destination with each attempt: runtime, pairing/profile identity where relevant, provider, and authenticated initiating-session binding.
2. Keep the destination through start/open/poll/manual-finish/cancel/completion. A later settings change never retargets an existing attempt.
3. Return to the originating scope card on success and refresh that card's status, not an ambiguous `/account` reload.
4. Persist UI pending state by scope/provider/attempt identity rather than one `oauth:<origin>` slot. Also replace/scope the singleton `codex_oauth_pending:<uid>` recovery pointer or enumerate valid attempts by explicit IDs; the existing attempt table can already contain multiple rows. Remove the unused codexPending page variable or implement real scoped recovery rather than pretending it is rendered. Allow independent local and remote pending attempts to be displayed without mixing callbacks.
5. Keep one listener on the fixed registered localhost port. A busy port or another attempt gets explicit manual fallback; never kill another app or steal its listener.
6. After restart, do not falsely claim automatic capture is active. Re-establish safely if supported or offer the existing manual finish/new attempt path against the original destination.
7. Maintain state/session/Host/path validation, expiry, cancellation, latest-completion protections, encrypted attempt private data, and no-store/referrer protection.
8. Disconnect invalidates pending attempts for only the selected destination/provider. A late callback cannot recreate a disconnected account.
9. Network loss after token exchange is uncertain completion: poll/read the existing attempt receipt before offering restart; never blindly replay the authorization-code exchange.
10. Clean up listeners and pending client state on terminal outcomes. Do not expose callback codes/verifiers in logs, diagnostics, history, or persistent UI drafts.

Do not add device-code OAuth, a new broker, or new provider registration requirements. Preserve direct-server manual sign-in and desktop-assisted server sign-in.

## 6. Workstream C — one route resolver

Create a narrow shared provider-access abstraction reused by callers rather than another scattering of isDesktop/sharedRime branches.

Illustrative contracts:

- `ProviderAccessStatus`: credential presence, health/freshness, supported operations, sanitized destination identity.
- `ProviderRoutePolicy`: automatic, runtime-only, or explicit server-only target.
- `ResolvedProviderRoute`: provider, endpoint identity if relevant, owner/runtime/account binding, connection generation, capability provenance, and selection reason.
- `ProviderRouteReceipt`: requested policy and actual source recorded for a turn/call, with no credentials.

Resolve from authoritative owner-side configuration, not client-submitted policy alone. Separate cheap status reads from explicit provider refresh/probes. Pairing transport health, shared sync health, model-provider health, and catalog freshness must not collapse into one `online` boolean. A note/workspace/history sync error or format incompatibility must not select another billing account. Independently negotiate model-route compatibility; if it cannot be established, report it instead of interpreting it as consent to use another source.

Use the same resolved route for:

- agentConfigured/selection validation and UI availability;
- model catalog, effort/tool capabilities, context window, model selection;
- model dispatch and permitted same-source authentication refresh;
- context budgeting, compaction, one-shot/ink/notebook AI calls;
- child runs, resume, continue-history, and unattended jobs;
- voice/dictation feature availability and their actual request path.

Preserve existing local compat URL pinning and close the missing remote-pin path. The server must attest a non-secret backend identity/version associated with its account, runtime, and actual endpoint resolution; bind and verify that identity where the server builds the outgoing request. A client-supplied alias is not evidence of backend identity. A relayed thread must not become eligible for a same-named local endpoint when shared access is unavailable.

Keep known backend identity with the conversation where existing compat continuation rules require it, in addition to per-turn source pinning. For old remote compat conversations whose source was never recorded, do not backfill identity from today's alias or silently enable local fallback; offer an explicitly new chat/verified continuation on the intended route. Runtime-only must never quietly use a shared catalog or shared endpoint.

### Catalog and cache corrections

- Key catalog/capability caches by source runtime, account/profile binding, provider, endpoint identity, and credential/account generation as appropriate.
- Tag catalogs at envelope level with origin, freshness, fetchedAt, and live/cache/fallback state. Do not infer freshness solely from optional model context fields.
- Never use a cached remote catalog as evidence that a local credential can serve a model.
- Invalidate or segregate on reconnect/account change/disconnect/pair replacement. Ordinary same-account token rotation need not discard all capabilities.
- Cached lists may be displayed for reference but cannot prove live admission where existing resume/model-selection rules require confirmation.
- Server capability envelopes identify the answering profile/generation; callers reject mismatches. Do not let stale cached capabilities select a newly promoted `pairs[0]`.

### Failure semantics

- Before dispatch: a known unavailable Automatic route may select a configured local same-provider route, with catalog/model validation and an explicit source receipt.
- After dispatch: cancellation, stream loss, timeouts, 401/403, quota and other failures do not cause cross-route replay.
- Preserve existing bounded same-source retry behavior only where the transport already supports it; OAuth refresh/401 recovery must remain on the same account generation. Specifically, make poisonAccessToken conditional on the credential snapshot that received the 401 and prevent recursive retry from selecting a newly reconnected account. Keep the existing refresh token_enc compare-before-store guard.
- Distinguish server connection revoked from upstream ChatGPT login expired. A provider 401 should not masquerade as a revoked desktop pairing.
- Configuration or credential identity changes during a turn stop the next request with an actionable message rather than switching accounts.

## 7. Workstream D — auxiliary features and visibility

### Voice and dictation

Use the route resolver for capabilities and execution, but preserve operation-specific capabilities: chat access does not imply realtime voice or audio-transcription access.

- Voice start pins a server/local destination and session owner; heartbeat/stop follow that receipt even if connectivity or default preferences change.
- Paired desktop local-only voice must not unconditionally call sharedVoice.
- For clip transcription, remote OpenAI, compat and OpenRouter credentials must either use an explicitly supported bounded transcription relay or be reported unsupported there. Do not advertise them and then search for local keys. Include OpenRouter audio-chat routing, not only `/audio/transcriptions`.
- Prefer a narrow authenticated transcription harness action reusing existing size/time/provider/SSRF limits when implementing that supported remote feature. Do not proxy arbitrary URLs or forward secrets.
- Label unsupported combinations honestly; never silently change billing/provider to make a microphone work.
- Preserve media/tool separation, one-call limits, heartbeat expiry, and existing cleanup rules.
- Preserve existing `_ward`-based agent placement for voice and clip routes: those APIs already execute on the run owner. Fix inference-source selection there rather than inventing another run-owner router.

### UI and diagnostics

Show concise source labels in the composer/turn details: `Runs on …`, `Model access via …`, requested policy, actual fallback reason, and the appropriate scoped reconnect link.

Record sanitized request/turn IDs, destination runtime/profile reference, provider/model, route-policy decision, failure layer, and catalog freshness. Extend existing bounded `agent_model_calls:<uid>` receipts in runModel and existing diagnostics instead of creating a parallel call-log store. Bounded diagnostic receipts are not a substitute for durable conversation backend constraints where required. Do not record tokens, callback URLs, authorization codes, headers, audio, or user prompts as new diagnostics.

Old histories without route provenance say “Source not recorded”; do not invent provenance from today's settings. Historical route metadata is diagnostic, not permission to contact that source.

## 8. Pairing, sync, compatibility, and migration

Keep one designated shared-profile server; other pairings remain workspace connections. Persist an explicit primary binding rather than relying on array order for provider authority.

- Migrate the current first pairing as the designated shared server without changing credentials or data.
- Removing the designated server does not silently promote another pairing into model/account authority. Require an explicit new primary selection and preserve existing profile-mismatch protections.
- Route/default preferences must not move a conversation's run owner or broaden tool permissions.
- Keep local provider records in their existing installation database: no credential-separation migration is needed. Prefer existing settings rows for source policy/primary binding and existing call receipts for diagnostics. Add schema only where durable identity/version or conversation constraints cannot safely use existing structures; avoid a second credential vault.
- Keep legacy policy as Automatic for existing configurations; no forced reconnect, no token export/import.
- Make schema changes additive, transactional, idempotent, and compatible with the migration filename runner. Verify numbering before assigning a new migration.
- If chat/sync payloads gain enforcement-critical route fields, negotiate format support; old readers dropping them is not safe compatibility. Optional historical labels alone need not force an unrelated full sync migration.
- Advertise a versioned capability for scoped provider management and route-bound inference. New desktops fail closed for unsupported scoped writes, not fall back to ambiguous legacy mutation endpoints.
- Old desktop/new server retains legacy endpoints/semantics until explicitly retired. New desktop/old server offers local management and clear upgrade guidance for unsupported server controls.
- Existing pending OAuth attempts must finish on their original identifiable target or fail with a restart instruction; never rewrite their owner during migration.
- Upgrade the server contract first, then desktop consumers. Local-only management must remain usable if the server is offline or older.
- Back up application-owned databases using supported online backup before authorized migrations. Keep rollback material; prefer feature disable/forward repair over restoring old rotating-token snapshots that could invalidate live credentials.

## 9. Phased implementation and exit gates

### Primary file map

| Responsibility | Existing integration points |
| --- | --- |
| Stable account surface and scoped controls | `src/pages/account.astro`, `src/pages/desktop/settings.astro`, proposed desktop providers page/shared component, `src/scripts/account-oauth.ts`, `src/lib/dev/instance-routing.ts` |
| Credential mutation/auth lifecycle | `src/pages/api/account/agent.ts`, `src/pages/api/account/oauth.ts`, `src/lib/agent/accounts.ts`, `src/lib/agent/codex.ts`, `src/lib/oauth-attempts.ts`, `src/lib/codex-loopback.ts` |
| Explicit pairing transport and feature negotiation | `src/lib/dev/remote.ts`, `src/lib/agent/sync.ts`, `src/pages/api/devices/harness/[...action].ts`; preserve `src/lib/dev/instance.ts` profile safeguards |
| Shared access resolution and preferences | `src/lib/agent/provider.ts`, `src/lib/agent/models.ts`, `src/lib/agent/ward-config.ts`, proposed small route/access helper; UI config validation in `src/lib/wards.ts`, `src/components/dashboard/AddWardDialog.astro`, `src/scripts/app/edit.ts` as applicable |
| Turn/copy/child/context integration | `src/lib/agent/core.ts`, `conversations.ts`, `context.ts`, `oneshot.ts`, `tasks.ts`, `sync-store.ts`, `chat-format.ts`; preserve run ownership in `src/lib/dev/agent-placement.ts` |
| Model UI and provenance | `src/pages/api/agent/models.ts`, relevant ward-state API, `src/scripts/app/agent.ts`, `src/lib/agent/diagnostics.ts` |
| Voice and audio | `src/lib/agent/voice.ts`, `transcribe.ts`, `sync.ts`, `src/pages/api/agent/[ward]/voice.ts`, `transcribe.ts`, and `src/scripts/app/agent-voice.ts` |
| Migration and documentation | Next available migration(s), `docs/installation-and-identity.md`, wiki Desktop-Setup/Desktop-Rime/Remote-Access/Remote-Integrations, relevant engineering docs |

This is a caller map, not permission to refactor every listed file. Keep each phase's diff focused on the contract it establishes.

### Phase 0 — lock contracts and inventory callers

Review this plan, finalize terminology and policy defaults, inventory `/api/account/agent` action ownership and every provider caller. Confirm current server deployment/schema and existing test coverage without reading secrets. Record any changed baseline.

Exit: endpoint/DTO contract, route truth table, compatibility strategy, source map, and acceptance checklist reviewed.

### Phase 1 — fix credential management ownership (highest priority)

Implement stable desktop provider surface, explicit scoped management/status, identity preconditions, OAuth return/pending-state repair, and correct Connect/Disconnect behavior. Preserve existing inference selection for this phase, but ship a read-only actual-source label now so a local connection is not mistaken for the active connection. Do not advertise the legacy fallback as safe/complete before Phase 2 resolves sync-health and compat cross-source issues.

Exit: online/offline/reload/server-switch cases cannot write a different account from the one displayed; local and server connections are independently visible/manageable.

### Phase 2 — unify text access and model discovery

Implement route resolver, source-scoped defaults/policy settings, explicit primary binding, separate sync/model health, route-aware cache/catalog/context/admission, immutable turn route, remote compat backend identity, and credential-generation safeguards. Integrate normal turns, compaction, child/resume/continue and one-shots.

Exit: selected model and dispatched request use the same destination; failures cannot trigger cross-route replay; existing endpoint/run-owner protections remain intact.

### Phase 3 — complete auxiliary routes and provenance

Integrate voice, dictation, UI source labels, diagnostics and history provenance. Add negotiated transcription transport only where needed; otherwise mark unsupported combinations explicitly.

Exit: availability matches actual execution for each feature; voice session control remains on its original owner; source changes are visible and actionable.

### Phase 4 — compatibility, validation, documentation, rollout

Exercise the matrix below, update desktop/server/identity docs, review diffs and migration backups/rollback. Follow the existing release workflow only after separate implementation/release authorization.

Exit: required validation passes and real-provider/installed-app checks are separately documented; no live-acceptance claims based solely on compilation.

## 10. Validation and acceptance matrix

Use existing suites and disposable profiles/fixtures. Preserve every existing test. The repository requires explicit user authorization before adding test code; this plan specifies cases, not permission to create tests. Gaps can first be exercised with documented manual/disposable acceptance and reported.

| Case | Required result |
| --- | --- |
| Fresh standalone, no pairing | Local status/connect only; no misleading remote default; text and catalog use local |
| Server-only browser | Server account controls; manual Codex flow works; no local desktop credential management |
| Paired; remote only | Remote source clearly shown; outage reports missing local same-provider fallback |
| Paired; local only | Local connection remains visible after reload; server without provider does not hide it |
| Both configured, same account | Each Disconnect affects only selected installation; Automatic uses documented source |
| Both configured, different accounts | Labels/provenance distinguish sources; no invisible mid-turn account change |
| Offline paired desktop | Local management fully usable; server controls disabled/error in server scope; no retarget |
| Local-only while server healthy | Catalog, context, inference and supported voice stay local |
| Server-only during outage | Explicit failure; local credentials remain unused |
| Failure after server dispatch | No local replay, duplicate charge attempt, or repeated tool action |
| Stream interruption/cancellation | Correct partial/uncertain result and cleanup; no silent new request |
| Expired local or remote credential | Scoped reconnect guidance; pairing state distinguished from provider state |
| Sync format rejection or local sync-file error with server reachable | Inference source/account does not change solely because sync failed |
| Server status changes between tool-loop rounds | Original route remains pinned; next call fails safely rather than changing source |
| Port 1455 occupied / two attempts | No interference with existing listener; manual fallback keeps original scope |
| Restart/reload during OAuth | Correct pending scope and listener status; single-use completion/no false success |
| Finish versus cancel/disconnect | Cancel/disconnect wins where already committed; late completion cannot resurrect |
| Refresh/401 versus reconnect | Old response cannot overwrite or invalidate replacement account credentials |
| Server removed/switched mid-form | Stale target rejected; no write/model call against another pairing |
| Same host with different account | Profile identity checked; no origin-only cache or authority reuse |
| Catalog cached from other source | Display tagged correctly; never validates the active source's model access |
| Compat alias duplicated/repointed | Existing backend pinning enforced, no cross-machine loopback substitution |
| Old unpinned server-compat conversation during outage | No automatic dispatch to the same-named local endpoint; no fabricated historical pin |
| Runtime-only with server-only inherited defaults | Uses explicit ward/runtime-scoped defaults or reports missing local model; no shared catalog/default leakage |
| Web viewing desktop-owned chat | Owner remains desktop; “local” means owner runtime, not viewing client |
| Child/compaction/one-shot/resume | Same policy and route validation; history does not grant new authority |
| Voice start then route change | Heartbeat/stop use original owner; no orphaned call or wrong-account control |
| Remote-only OpenAI/compat/OpenRouter dictation | Supported relay works or capability is explicitly unavailable; no missing-local-key surprise |
| Old/new desktop-server combinations | Negotiated behavior; unsupported writes fail closed; no surprise reauth |
| Standalone without internet | Non-AI local tools still work; cloud AI reported unavailable, local compat remains eligible |
| Cross-user/forged target/CSRF | Unauthorized writes rejected; no credentials leaked |

Relevant existing suites: `identity-redesign.test.ts`, `oauth-integration.test.ts`, `oauth-state.test.ts`, `codex-loopback.test.ts`, `agent-providers.test.ts`, `agent-context.test.ts`, `agent-core.test.ts`, `agent-conversations.test.ts`, `agent-sync.test.ts`, `instance.test.ts`, `agent-placement.test.ts`, and `auth-ui-smoke.mjs` plus existing conversation/remote-workspace smokes.

Coverage gap: source search found no direct existing tests referencing sharedModel, sharedVoice, voiceAction, transcriptionRoute/transcribeAudio, or the Codex 401 invalidation helper. The auth UI smoke asserts the Codex section exists; that does not establish paired local/server write correctness. The independent review also found no assertions covering the `/account` versus `/api/account/agent` ownership split. Existing passing suites must not be represented as full regression coverage for this plan. Request explicit permission for focused new test cases at implementation approval, or document the corresponding disposable/manual acceptance evidence and remaining automation gap.

Validation sequence after implementation: focused existing suites; `npm test`, `npm run typecheck`, `npm run lint:desktop`; built auth/UI smoke and relevant `npm run test:ui`; remote-workspace smoke; staged `npm run desktop:check` and `npm run test:standalone`. Do not inspect or generate goldens unless requested. Validate real OAuth handoff and OS-specific loopback behavior separately using explicitly authorized test accounts, not by disconnecting production accounts.

## 11. Decisions and completion definition

Recommended decisions for implementation approval:

1. Keep Automatic/server-preferred for compatibility; add strict runtime-only and server-only choices.
2. Store policy at the run-owner runtime with qualified overrides; do not globally sync an ambiguous local preference.
3. Pin source for a complete turn and for a voice session; do not transparently fail over after dispatch.
4. Keep one explicit primary shared server; do not expand to multi-server model failover.
5. Fix credential-management scope first, then ship complete route/catalog/auxiliary consistency before declaring the overall issue resolved.

Completion means a user can always answer: **Which account am I changing? Where does this conversation run? Which connection is serving/billing this AI request? What happens if that connection fails?**

Planning is not implementation completion. Live deployment verification, provider consent, migration acceptance and installed-app validation remain outstanding until separately authorized and performed.

---

## 12. Historical Claude implementation status — superseded

The direct implementation and final validation checkpoint are recorded in
`docs/desktop-server-provider-review.md`. In particular, current code uses opaque
credential revisions, serving installation identity, provider contract 2 and chat
format 4; the older descriptions below are historical, not current guarantees.
The final direct-implementation suite has 629/632 passing tests with three
unresolved failures. This work is not fully accepted or release-ready.

Second pass, after the parent review in `docs/desktop-server-provider-review.md` rejected the first.
Source changes are **uncommitted** in the working tree; nothing is committed, built for release,
deployed or installed, and no live account, credential, pairing or provider call has been touched.
The matrix in section 10 is **not** satisfied: most of its cases have no automated coverage and no
live run, and are recorded below as source-verified only.

Baseline at implementation: branch `dev/1.0.14`, HEAD `fbb3c72`.

### 12.1 The two rules everything else follows from

1. **A constraint a conversation RECORDED outranks today's preference.** A thread admitted on a
   local backend is never relayed; a thread admitted on a server's backend is never served locally.
   Where the two disagree the turn is REFUSED, never redirected. `resolveProviderRoute` takes the
   conversation's recorded backend and either honours it or returns a `blocked` route that nothing
   dispatches under; `getProvider.run` re-checks the same thing independently before sending.
2. **A resolved route is immutable, including its credential generation.** A turn, the children it
   spawns, its compaction and a voice session each resolve once and keep that answer. Re-checking
   the credential generation immediately before dispatch is what makes a reconnect between tool
   rounds a stop rather than a change of billing account.

### 12.2 Contracts

**`src/lib/agent/route.ts`**

| Export | Contract |
| --- | --- |
| `ProviderRoutePolicy` = `automatic \| runtime \| server` | `agent_route_policy:<user>`, stored at the run-owning runtime, never synced; forced to `automatic` off-desktop, where there is nothing to choose between. |
| `remotePin(profile, url)` / `parseRemotePin` | A connected server's compat backend is `server:<profile>:<url>` — the serving ACCOUNT as well as the address, because two servers can both call an endpoint `http://localhost:11434/v1` and they are not the same backend. An empty url means that server attested none; such a thread stays server-only and is refused for continuation rather than credited with an identity nobody verified. A shape this build cannot read parses as unknown and is never dispatched. |
| `ResolvedProviderRoute` | `{ via, policy, reason, server?: {id, host, profile}, remoteBackend?, credential?, blocked?, at }`. |
| `resolveProviderRoute(user, provider, endpoint, { recorded, unpinned })` | The whole decision, rule 1 included. |
| `credentialId(user, provider, endpoint)` | A non-secret generation: a ChatGPT `account_id`, a masked key label, an endpoint's url+key revision. Changes when the account behind a credential is replaced; unchanged by an ordinary token rotation, so a refresh does not interrupt a turn while a reconnect to another account does. |
| `recordedBackendCheck` | One identity check for every caller that moves a conversation. |
| `pinVoiceRoute` / `pinnedVoiceRoute` | A voice receipt: installation, server profile, and the lease itself. |

**`src/lib/agent/provider-scope.ts`** — `providerScopeStatus`, `applyProviderWrite` (the single
implementation both the scoped API and the legacy account form call), and `runtimeBinding` =
`runtime:<installation>:<profile>:<digest of the account generations in this scope>`. The digest is
what makes a form stale when the ACCOUNT behind a card is replaced; installation and profile do not
change when a ChatGPT connection is swapped or an endpoint repointed.

**`src/lib/agent/contract.ts`** — `{ providerScope: 1, routePin: 1 }`, advertised on the harness and
read into `sharedRime().caps`. A desktop that needs a guarantee this server does not advertise
refuses rather than degrading.

**`/api/account/provider`** — `target` must be exactly `runtime` or `server` and `binding` must be
present and match; neither is defaulted. A server write resolves the pairing once, validates it, and
is sent on that same resolved connection (`instanceRequestOn`) rather than letting the transport look
the designated server up again. `policy` and `primary` are runtime-only and never forwarded.

**Health, in three parts.** `online` (the last reconciliation succeeded), `reachable` (the server
answered), `authority` (it answered as the profile we are joined to). A note or workspace format
mismatch leaves the last two true; an unreadable payload or a profile mismatch clears `authority`, so
capabilities stored from another account stop being eligible even though the socket works. Model
access, catalogs, endpoint discovery, voice and integration tools all require reachable **and**
authority.

**Server-side verification.** A relayed `/model` call carries the profile the turn was admitted
against and the backend constraint it must honour; the harness checks the profile against its own
`profileId(user)` and refuses a constraint it cannot parse or that is too long, rather than dropping
it. Comparing the desktop's cached copy of the profile would only have proved what it already
believed.

### 12.3 What the parent review found, and what changed

| # | Finding | Fix |
| --- | --- | --- |
| R1 | A locally pinned compat conversation could be RELAYED, because the wrapper followed `route.via` and substituted today's remote attestation | Rule 1 above. The resolver takes `recorded` and blocks on disagreement; `getProvider.run` independently refuses a local pin under a server route, a remote pin under a local route, and a remote pin whose profile is not the connected one. `turnProvider`'s `unpinned` case no longer depends on policy or on a pair still existing: an unrecorded compat thread with history is served only where relaying was never possible (a runtime that has never joined a server) and blocked otherwise. Remote pins carry the serving profile. |
| R2 | `modelCatalog` read shared catalogs unconditionally; cache keys were origin-based; context could fall back locally under a server route | `modelCatalog` takes the resolved route: a server route reads only the server's catalog and never falls back, a runtime-only route never reads it. `sharedCodexModels` returns an envelope (`source`, `fetchedAt`) instead of freshness inferred from model fields. Catalog keys include the serving profile, and a compat key the attested backend. `Catalog` gained `origin`/`profile`. `getProvider.context` is source-bound for every provider, not just codex. `knownEndpoints` and `agentConfigured` require authority. |
| R3 | No credential/account identity was pinned across calls | `ResolvedProviderRoute.credential`; re-checked immediately before every local dispatch, inside `codexTransport`/`openaiTransport` header construction (after the await, so the headers about to be sent are the pinned account's) and in `callCompat`. The 401 retry re-acquires headers through the same check, so a replacement landing between the 401 and its retry refuses. `poisonAccessToken` still only blanks the token that received the 401, and the refresh compare-before-store guard is untouched. Relayed calls carry the expected profile for the server to verify. |
| R4 | Target and binding were optional; the transport re-resolved the primary | Explicit target, mandatory binding on every action including policy and primary; one resolved connection carried through status, writes and OAuth; `runtimeBinding` includes the account generations. |
| R5 | A stale card could start on a newly designated server, and `destination: server` with no pair fell through to a LOCAL sign-in | `server` with no designated pairing is refused outright. The card asks this runtime for the destination binding at the moment it starts and sends it; a mismatch is refused, not retargeted. Pending state is keyed by that binding. `?attempts` is used by the UI, and `?attempts&target=server` forwards so a reload recovers a server-owned attempt. A local sign-in completed from server-proxied HTML goes to `/desktop/providers` instead of reloading the server's account page. |
| R6 | Children resolved fresh routes; the composer recomputed instead of reporting the running receipt | `ToolCtx.route` carries the admitted route; a child on the parent's provider/endpoint inherits it (a resume does not — it has its own record). `set_model` validates against that route's catalog. `wardSurface` reports the receipt of a turn in flight (`live: true`) and otherwise says what the NEXT turn would use; the composer renders "Model access via …" and "Next turn via …" differently and shows "Model access unavailable" for a blocked route. |
| R7 | The voice receipt stored an owner id it never used | The receipt records installation, profile and lease. `sharedVoice` takes it and refuses when the designated server is not the one that holds the call. A lease the client names must match the receipt. Unknown ownership refuses rather than guessing, and an unreachable owner does not have its receipt cleared as if the stop had succeeded. |
| R8 | `answered` stayed true through identity failures, leaving stale capabilities eligible | `authority`, above. |
| R9 | `server:` values entered a synced field without negotiation; `/model` dropped oversized constraints | `CHAT_FORMAT` is 3 and `chatRecordNeedsFormat` holds such records back from older peers, with the existing pause message. The harness refuses an unparseable or oversized backend constraint. History renders a remote pin as what it means, never the raw profile string, and never presents an unattested one as an established address. |

### 12.4 Deliberate behaviour changes this creates

- A compat conversation that has history, recorded no backend, and belongs to a runtime that has been
  connected to a server is **refused** with an instruction to start a new chat. Only a runtime that
  has never joined a server keeps serving such threads locally. This is rule 1 applied to unknown
  history, and it is the plan's own §6 position; it will affect real threads created before
  `037_conversation_endpoint.sql`.
- Under `Connected server only`, a locally pinned conversation is refused rather than served.
- A desktop connected to a server refuses credential writes posted to the legacy
  `/api/account/agent` form and sends the person to the scoped page.
- A voice `status`/`stop` with no receipt on this runtime is refused rather than answered locally.

### 12.5 Acceptance status for section 10

Evidence classes: **A** = exercised by an existing automated suite that passes; **S** =
source-verified (read end to end, typechecks, builds; no test or live run exercises it); **M** =
manual/live acceptance outstanding. Nothing below is claimed as live-verified, and no case is
claimed as satisfied on the strength of the suite alone.

| Case | Status | Evidence |
| --- | --- | --- |
| Fresh standalone, no pairing | S + M | Resolver returns local; the account page renders no "Connected server" option without a shared record. |
| Server-only browser | S + A(partial) | `isDesktop()` false short-circuits the resolver and forces `automatic`. `auth-ui-smoke` still asserts the Codex section renders. |
| Paired; remote only | S + M | Server route; on outage `getProvider.run` throws with the server named and no local fallback. |
| Paired; local only | S + M | The local card renders from `providerScopeStatus` regardless of the server. |
| Both configured, same account | S + M | Disconnect acts on the named installation only; separate databases. |
| Both configured, different accounts | S + M | `modelAccess` label plus the receipt on every call record. |
| Offline paired desktop | S + M | `/desktop/providers` and `/api/account/provider` are in `DESTINATION_BOUND`, so neither is relayed; the server card degrades to `serverError`. |
| Local-only while server healthy | S + M | `runtime` policy removes shared config, catalog, endpoints, context and voice. |
| Server-only during outage | S + M | Blocked route with an explicit reason; local credentials unused. |
| Failure after server dispatch | S | `sharedModel` has no retry; the wrapper throws rather than falling through. |
| Stream interruption/cancellation | A | Unchanged paths, covered by the existing cancellation/receipt tests. |
| Expired local or remote credential | S + M | Provider 401 is per account generation; pairing revocation remains its own message. |
| Sync format rejection with server reachable | S | `answered`/`identified` split; format failures keep both flags, identity failures clear `authority`. |
| Server status changes between tool-loop rounds | S | One route per turn; `sharedModel` rejects a changed pairing or profile with 409; the server verifies the profile itself. |
| Port 1455 occupied / two attempts | A(partial) + M | `codex-loopback.test.ts` passes unchanged; per-binding client state is new and unexercised. |
| Restart/reload during OAuth | S | `codexListenerActive` is still the only source of `automatic`; recovery is by explicit attempt id, per destination. |
| Finish versus cancel/disconnect | A(partial) | `identity-redesign.test.ts`, `oauth-integration.test.ts` pass unchanged. |
| Refresh/401 versus reconnect | S | Conditional poisoning plus the credential check inside header construction and the retry. |
| Server removed/switched mid-form | S | Binding precondition on every scoped write; one resolved connection through the operation. |
| Same host with different account | S | Profile is part of the binding, the pin, the cache key, the `sharedModel` precondition and the server-side check. |
| Catalog cached from other source | S | Source-bound catalogs, envelope provenance, profile-keyed caches. |
| Compat alias duplicated/repointed | A + S | Existing local pinning unchanged and green; the remote pin is new and unexercised. |
| Old unpinned server-compat conversation during outage | S | Blocked, with an instruction to start a new chat. |
| Runtime-only with server-only inherited defaults | S | `agentWardConfig` drops shared config under `runtime`. |
| Web viewing desktop-owned chat | A | `routeAgentPlacement` unchanged; `agent-placement.test.ts`, `instance.test.ts` pass. |
| Child/compaction/one-shot/resume | S + A | Inheritance via `ctx.route`; existing child/resume identity tests pass. |
| Voice start then route change | S + M | Receipt with installation, profile and lease; no live call was made. |
| Remote-only OpenAI/compat/OpenRouter dictation | S | Capability equals execution for all three paths; explicitly unsupported rather than relayed. |
| Old/new desktop-server combinations | S | `caps` gates; scoped writes 426; chat format 3 holds records back. |
| Standalone without internet | S + M | Local compat remains eligible; cloud providers report unavailable. |
| Cross-user/forged target/CSRF | S | Middleware CSRF unchanged; relayed/native refusal; mandatory binding; no client-supplied target address. |

### 12.6 Commands and artifacts

| Command | Exit | Artifact |
| --- | --- | --- |
| `npm test` (632 tests) | 0 — 632 pass on 4 of 6 runs; the other 2 failed only `browser-live.test.ts` (see below) | `/tmp/t4.txt` |
| `npm run typecheck` | 0 | — |
| `npm run lint:desktop` | 0 | — |
| `npm run build` | 0 | `/tmp/b.txt` |
| `npm run desktop:check` | 0 (first pass; no Rust changed since) | `/tmp/desktopcheck.txt` |
| UI smokes | see below | `/tmp/r2-*.txt` |

`browser-live.test.ts` is timing-flaky on this machine: across six full-suite runs and four standalone
runs during this pass it failed three times in total, at two DIFFERENT frame-wait assertions
(`:134` "resized frame not met within 5000ms" and `:306` "no frame within 8000ms"), including once
standalone while the machine was busy with back-to-back headless Chromium runs. Every other run was
green, including the most recent full suite (632/632) and the most recent standalone run (5/5). No
module this change touches is imported by `lib/browser/*`; it is a real-Chromium timing flake under
load, not a regression — but it is reported as flaky rather than as clean. Four UI smokes and `test:standalone` fail on this machine at the
unchanged baseline `fbb3c72` as well (established in the first pass by reverting the tree and
re-running); they are reported as pre-existing, not as passes, and were not fixed — that is outside
this task. No A/B in this pass used stash, reset or checkout on the shared tree.

### 12.7 What is NOT verified

- **Nothing is committed, released, deployed or installed.** No version bump. The tree is modified
  and uncommitted.
- **No live OAuth.** No sign-in started, no token exchanged, no account disconnected, no pairing
  created or removed, no service restarted. Every OAuth claim is source-level.
- **No paid model call**, and no two-installation run: everything involving `reachable`, `authority`,
  `caps`, `endpointBackends`, the relayed backend check, the 409 on a changed pairing and the
  server-side profile check was verified by reading both sides, not by pairing two runtimes.
- **`/desktop/providers` has never been opened.** It typechecks and builds; its rendering, its OAuth
  cards and the binding-mismatch path are unexercised.
- **No test code** was added, modified or removed. The coverage gap in section 10 stands: nothing
  asserts `/account` versus `/api/account/agent` ownership, `sharedModel`, `sharedVoice`,
  `transcriptionRoute`, the Codex 401 path, or any of the new route/binding logic.
- **No goldens** generated or inspected.

### 12.8 Known limitations, stated rather than hidden

- **Against a server too old to report them, the mid-turn identity checks do not run.** The expected
  profile and provider generation are sent on every relayed call, but an older server ignores unknown
  body fields, so it neither verifies nor rejects them. `caps.routePin` is what says a server can do
  this; it is enforced for a recorded backend constraint (refused rather than sent unverified) and
  not for the softer account check, because refusing there would break every existing paired setup on
  upgrade. Upgrade the server to get it.
- **A server that cannot attest a backend leaves such conversations without an address.** They still
  run there and are refused for continuation elsewhere; they are not credited with an identity.
- **The local catalog helpers still mark their own staleness from model context fields.** That is a
  helper's report about its own cache, not cross-source inference; the shared catalogs now carry
  envelope provenance, which is where the two could disagree.
- **`browser-live.test.ts` is timing-flaky** on this machine (real Chromium frame assertions), in
  full-suite runs and occasionally standalone under load. Tally and reasoning in 12.6.
