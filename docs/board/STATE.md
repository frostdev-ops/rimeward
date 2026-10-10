# Rimeward state and evidence

Refreshed **2026-10-10** for the accepted [two-release delivery contract](DELIVERY.md).
The October 5 survey remains historical evidence below. Current source/release
inspection and scoped preparation checks do not establish missing installed or
human-run provider acceptance.

## Revision and delivery

| Surface | Observed state | Evidence |
|---|---|---|
| Local and GitHub main | `5ae7ea0`, source **1.0.18**; PR #16 merged without changing candidate | [PR #16](https://github.com/frostdev-ops/rimeward/pull/16) |
| Active development | `dev/1.0.19`, source **1.0.19**; immutable-artifact validation correction `f723d30` starts the follow-up release | [Draft PR #17](https://github.com/frostdev-ops/rimeward/pull/17) |
| Final 1.0.18 development workflows | Tests, server and all desktop platforms passed at `5ae7ea0` | [Tests](https://github.com/frostdev-ops/rimeward/actions/runs/38068411399), [server](https://github.com/frostdev-ops/rimeward/actions/runs/38068411406), [desktop](https://github.com/frostdev-ops/rimeward/actions/runs/38068411467) |
| Main workflows | Tests, server and all desktop platforms passed at the same `5ae7ea0` | [Tests](https://github.com/frostdev-ops/rimeward/actions/runs/38071140635), [server](https://github.com/frostdev-ops/rimeward/actions/runs/38071140666), [desktop](https://github.com/frostdev-ops/rimeward/actions/runs/38071140612) |
| Tagged desktop checks | Windows NSIS/MSI and Linux DEB/AppImage passed. Original Mac signer predicate failed; corrected audit passed on the unchanged DMG and frozen source | [Original tagged run](https://github.com/frostdev-ops/rimeward/actions/runs/38074080663), [corrected immutable-DMG audit](https://github.com/frostdev-ops/rimeward/actions/runs/38077738647) |
| Published server | **1.0.18**, exact `5ae7ea0` | [Server release](https://github.com/frostdev-ops/rimeward/releases/tag/v1.0.18), [tag workflow](https://github.com/frostdev-ops/rimeward/actions/runs/38074080686) |
| Published desktop | **1.0.18**, twelve unchanged platform/updater assets; published 2026-10-10T18:58:23Z | [Desktop release](https://github.com/frostdev-ops/rimeward/releases/tag/desktop-v1.0.18) |
| Installed Mac app | **1.0.17**, strict signature/team valid; authenticated native runtime healthy with nine pages/fifty wards. Mac locked, installation pending | Existing-profile read and updater offer **1.0.17 → 1.0.18**; no unsolicited model calls |
| Homebrew cask | **1.0.18**, public and refreshed local URL/hash match accepted DMG | [Publication run](https://github.com/frostdev-ops/rimeward/actions/runs/38077925212) |
| Production | **1.0.18**, `5ae7ea0`; PM2/Node 26.10.0/SQLite, origin/public HTTP and authenticated build stamp passed | Supported online DB plus application/config rollback backup before clean deployment; authenticated production-to-installed-1.0.17 relay passed |
| AUR package | Publication and installation acceptance explicitly retired; fallback retained | User decision **Skip AUR**, RIME-43 |

Passing build workflows establish the recorded revision's CI result. They do not
replace feature-specific live acceptance or installed-app checks. Published
1.0.18 is not evidence of an installed 1.0.18 app or live provider acceptance.

## Branch and worktree disposition

- Retained `dev/1.0.14` through `dev/1.0.17` contain no unique commits beyond main.
  Existing BlackIce/agent branches are patch-equivalent to main; their checkout
  presence alone does not make them active work. Other people's worktrees remain.
- `aur-package` has one genuinely unmerged commit,
  [73d3e70](https://github.com/frostdev-ops/rimeward/commit/73d3e70), for Arch fallback
  README/wiki-source guidance. Its reviewed two-file change is integrated on
  `dev/1.0.18` for RIME-42; the stale branch is not merged wholesale.
- No open GitHub PR was found at initial refresh. [PR #16](https://github.com/frostdev-ops/rimeward/pull/16)
  is now merged at the validated `5ae7ea0`. Draft [PR #17](https://github.com/frostdev-ops/rimeward/pull/17)
  tracks `dev/1.0.19`; portable implementation follows baseline distribution verification.
- Desktop 1.0.16 remains a historical draft superseded by published 1.0.17.
  It is not recorded as a current release blocker.

## Historical findings reconciled with main

- **Providers, RIME-12/13:** 60c7565 implements installation/profile/generation
  ownership and 46162cf corrects the routed test mock. The provider review's
  rejected/uncommitted checkpoint and 629/632 result are historical. The tracker
  requests disposition and current two-installation evidence instead of asserting
  that those same failures still exist.
- **B11, RIME-16/17:** 064831f/04b9617 implement resume/history and af42597 records
  170 resume, 33 sync, 39 UI and six race checks. These later repository records
  supersede the earlier stopped red checkpoint; installed/live acceptance remains
  a separate gate. B1–B4, B6 and B7–B11 identities are retained in package titles.
- **Lens, RIME-24/25:** main contains the port and later consent, demand-stop,
  attribution, whole-line, terminal ward-resolution and tool-readiness fixes,
  including e55bd37, acf3835, 01d2d90, 2f695bf and 8ea849e. Older smoke symptoms
  are not reopened as current bugs without reproduction. Signed target/pixel/OCR,
  crop/description, overlay and lifecycle evidence is still requested explicitly.
- **Voice, RIME-18/19:** 278356e merges persistent Live delegation. The voice plan
  still lacks qualifying Live probe/acoustic evidence. Prior manual voice success
  does not satisfy those gates. Clip transcription is intentionally local-only.
- **Retrieval, RIME-20:** permitted tools now remain callable after MCP discovery.
  The old deferred-tool reduction percentage is not a description of today's
  complete catalog. Decision assistance remains off by default and uncalibrated.

## Concrete follow-ups

- RIME-6/9/13/17/19/23/25/31/33 are candidate-specific live acceptance and historical
  evidence reconciliation. Their missing evidence is not a reproduced defect or
  a newly verified blocker.
- RIME-35 reconciles the obsolete "background disabled" description against the
  narrow Apple Silicon allowlist, TURN provisioning wording against historical
  production TURN evidence, and the local-triage comment against actual composition.
- RIME-26 is now approved native Windows/Linux Lens delivery through RIME-49–53,
  with basic observation/tools/watches and capability-gated overlays. Current
  non-Mac builds still report unavailable. Apple-only describe/translation remains
  unavailable; existing Remote Desktop capture alone does not implement Lens.
- RIME-27 retires optional local-chat D2: composition comments and assertion
  wording now match configured embeddings/helper triage/opted-in cloud triage.
  Scoped decider tests pass and emitted logic matches the prior revision.
- Initial execution audit: RIME-42 documentation was unmerged and RIME-43 lacked
  publication access. The repository has no AUR_SSH_PRIVATE_KEY, its owner is a
  User (no inherited organization secret), local AUR SSH authentication failed,
  and the public RPC returned zero packages. RIME-42 is now integrated/published;
  RIME-43 is explicitly retired. Native SSH aliases `desktop` and `berry-view`
  timed out; installed Windows/Linux checks remain user-run.
- RIME-46 records the 1.0.18 source/release gap and the existing authorized-release
  procedure's exit gates. The accepted implementation request authorizes the
  sequence, but external account/provider acceptance remains human-run.

## Execution evidence and prerequisites

- New RIME-47–54 are registered with acyclic dependencies. Human procedures and
  exact candidate evidence fields are prepared under `docs/validation/`.
- RIME-47 preparation passed independent review, 54-ID/dependency/config checks,
  ignored-journal and identical setup rerun (`changed: []`). Both release
  milestones and all three responsibility-stream procedures are versioned;
  private local Lens instructions were refreshed without publication.
- RIME-42's two-file source fallback is integrated. Public Desktop Setup is
  synchronized at wiki commit `87051d1`; unrelated wiki pages are preserved.
- RIME-43 publication was explicitly retired by the user on 2026-10-10 (Skip
  AUR). Its missing-credential audit remains historical evidence. The automatic
  release trigger is disabled; the manual publisher and fallback package remain.
- The local M5 Pro is arm64 macOS 27.0.1 build `26A434`, outside the production
  background allowlist `26A5416b`. RIME-48 requires a signed isolated qualification
  artifact and real parent/worker/guardian safety checks before any expansion.
  Xcode 27 and a valid Developer ID signing identity are available.
- External Notion/OAuth/SMTP/model/voice/Browserbase checks are human-run. Local
  voice preflight found no ChatGPT connection in its selected database and made
  no provider calls. This is an environment fact, not a product failure.
- The earlier Windows CLI restore assertion is unresolved as a historical CI
  result. Current Mac CLI tests pass; the assertion now checks subprocess exit
  status and stderr before interpreting restored output. It does not claim a
  root cause or Windows fix.
- Initial main Windows CI passed on `82abf2c`; the older restore assertion remains
  historical. Browser-live's extra mouseup was reproduced as fixture cleanup
  crossing its log reset and fixed by awaiting that worker. The separate macOS
  RTC timeout gained diagnostics. Final `5ae7ea0` development/main CI passed;
  the older failed [main run](https://github.com/frostdev-ops/rimeward/actions/runs/38056828904)
  and cancelled [development run](https://github.com/frostdev-ops/rimeward/actions/runs/38063079715)
  remain historical evidence.
- Full local preparation checks pass: 871 unit tests, typecheck, desktop lint and
  production build. Final installer/runtime CI coverage is being extended to Mac
  app contents and Windows installer extraction; manual GUI startup stays open.
- Full built UI smoke stopped at editor undo after file switching (line 132);
  the remaining smokes in that chained command did not run. Investigation is
  complete: a delayed view save reproduced cached text appearing while read-only
  with focus on the tab. The smoke now waits for editable content and focuses it
  before undo. Complete editor and all five other built UI smokes pass individually;
  no production editor behavior changed. Concurrent fixture failures are retained
  in local logs and are not installed acceptance.
- Packaged-runtime CI changes passed independent review plus actionlint/JS/bash
  syntax and whitespace checks. Final tagged NSIS/MSI and DEB/AppImage extracted
  runtime checks passed. Mac notarization was accepted and the app stapled, but
  the original signer predicate used default `codesign -dv` verbosity, which
  emitted no Authority line and made grep exit 1. Captured stderr and pipeline
  status `[0,1]` reproduced this validation defect; there was no SIGPIPE.
  Corrected audit **38077738647** used explicit verbosity and the existing
  immutable DMG with SHA256 `0f287091cb5e8a6c78e8fdfb4b08e61aa8d4205e5f4284d1e95a8afeefb6a6b7`.
  Frozen source `5ae7ea0`, digest, strict seal/version/Developer ID, Gatekeeper,
  stapler and DMG-contained standalone/four-viewer fault-media checks all passed.
  No asset replacement or tag movement occurred; the original failed job remains.
- Development `3e353fc` passed push Tests and server CI. Its desktop macOS and
  Linux jobs passed staged runtime/native checks and packaged app/DEB/AppImage
  standalone/media checks. The branch Mac app was ad hoc signed; this is not
  tagged Developer ID/notarized DMG evidence. Windows timed out waiting for
  browser hello and remained open after the failed fixture; cancellation does
  not provide a natural process exit code or establish installer startup failure.
- A controlled 5,500 ms synchronous process scan reproduced that browser hello
  failure. The boot-only orphan sweep is now asynchronous and awaited before
  launch; its asynchronous equivalent passes with the original hello deadline.
  Failure teardown closes pending launches and sockets, and the existing bounded
  synchronous shutdown fallback remains. Combined 871 unit tests, typecheck,
  desktop lint, production build, browser UI and remote-workspace smokes pass;
  final Windows development/main/tagged CI subsequently passed.
- The `3e353fc` pull-request Tests job hit an external Google font fetch failure;
  its merge tree matched the passing push tree. This is retained as CI evidence,
  without changing font behavior or treating the failed check as passed.
- Native Lens callback and AX-walk publication races were reproduced and fixed
  in `bb0cc22`; `8248f1c` repairs desired-PID advancement after refused activation.
  Review exposed the OCR-only Pause/switch/Resume path; `7a5e985` now discovers
  the foreground target before resuming capture, retries stale discovery once,
  and clears retained current state on failure. Pause/Stop cancel that request;
  denied-AX polling refreshes foreground identity independently. Independent
  exact-commit review found no remaining actionable findings. Formatting, Clippy
  and 138 native tests pass, with ten hardware-only checks ignored. These source
  regressions do not close signed installed Lens acceptance.
- The user will run installed Windows/Linux/Arch checks manually and chose CI/CD
  acceptance for publication on 2026-10-10. Manual feature/platform packages stay
  open. Baseline publication requires final candidate CI and packaged-runtime
  acceptance; it no longer waits for those manual host results.
- Both immutable 1.0.18 tags resolve `5ae7ea0`; server and desktop releases are
  public. Five updater signatures were verified against the configured key,
  and the final manifest contains eight valid platform aliases. Homebrew's
  publication workflow and refreshed local cask match the accepted DMG hash.
  Production rollback material precedes deployment; authenticated production
  relay reaches the existing desktop. Mac installation/restored sync and the
  post-install relay remain pending while its session is locked. RIME-46 stays open.
- A bounded independent overlay review at `5ae7ea0` found a pending caption can
  reappear after Clear/retarget frees its slot; TTL then misses that untracked
  window. Source trace and a deterministic scheduling model establish the race,
  not installed reproduction. Release notes disclose it. RIME-49 must invalidate
  pending reveal generations and preserve shared browser-overlay ownership.
- RIME-49 can proceed independently after baseline distribution verification;
  it does not depend on RIME-46. Mac qualification/manual provider/platform and
  RIME-46 installation exit criteria remain pending, never implicitly ready.
- The first RIME-49 shared phase implements portable routing, immutable capture
  leases, bounded cancellable OCR, reserved controls, separate visual calibration
  and pinned source-built OCR packaging. Missing calibration disables visual
  watches and live-region text suppression. Overlay reveal generations now
  invalidate delayed Clear/retarget/reused-ID results. Local working-tree checks
  pass: **875** unit tests, **149** native tests with eleven ignored, typecheck,
  build, lint, fmt/Clippy, staged standalone, editor and remote-workspace smokes.
  Ten existing native hardware ignores remain; the additional ignored child
  helper is explicitly launched by process regressions. This is preparation
  evidence: independent immutable review and real Windows/Linux OCR compiler,
  loader, license, PNG/TSV and extracted-installer CI gates remain open. Concrete
  capture/AX/overlays report unavailable until RIME-50–52 attach their providers.
- Follow-up workflow-only `f723d30` Windows CI failed one CONNECT fixture with
  `ECONNRESET`; all six Chromium lifecycle checks passed. A controlled real socket
  reset reproduced `events.once('close')` rejecting before the actual close.
  The fixture now observes close with the same two-second deadline; both status
  and actual close remain required. Reset regression and all **872** unit tests,
  typecheck and desktop lint pass in an isolated index-equivalent snapshot.
  This is a test-fixture correction; no product cause was evidenced. Both Windows
  Tests workflows pass on `a034503` (push 38080809643, PR 38080812129), including
  the corrected fixture. Candidate desktop/package checks remain separate;
  original red is retained.
- Independent review of the shared `a034503` phase found one additional overlay
  ordering defect: concurrent shows could emit an older payload/placement after
  the current reservation. An assertion executing the actual frontend listener
  reproduced it. The correction serializes slot mutation, placement, payload
  and visibility on the main thread and rejects stale frontend generations;
  installed reproduction remains pending. The corrected commit needs its own
  independent review.
  Corrected working-tree checks pass: **877** unit tests, **149** native tests
  with eleven ignored, typecheck/build/lint, fmt/Clippy, workflow YAML/actionlint
  with the existing `xcode-27` runner-label allowance, and PowerShell AST syntax.
  Clean committed `a034503` prebuild, staged standalone and desktop checks pass;
  affected checks must be repeated on the corrected candidate.
- Review of the corrected overlay transaction confirmed payload/placement order
  but reproduced a distinct delayed-show-after-Stop schedule: an old target
  clone can pass an unchanged epoch after Stop clears the slots. The focused
  correction freezes capture generation before cloning the target and carries
  request cancellation through the existing target-publication boundary inside
  main-thread placement/payload/reveal. Source-checked and native regressions
  are required; no live GUI reproduction is claimed.
  The actual cancellation token and frozen source now guard placement and delayed
  reveal; fresh paused overlays retain their prior behavior. Focused native
  regressions pass, as do **877** unit tests and **151** native tests with eleven
  ignored, typecheck/lint/fmt/Clippy. Independent review and committed validation
  remain required.
- Shared candidate Linux desktop run **38080809608** failed naturally while
  compiling pinned Tesseract 5.5.2 (`cmake --build` exit 2, prebuild exit 1).
  Its disabled-legacy source exclusions use absolute paths against a relative
  source list, leaving `docqual.cpp` to compile with removed declarations.
  The build recipe uses the supported default legacy compilation; all OCR
  invocations retain fixed `--oem 1` and the same pinned English fast data.
  Compiler/loader/PNG/TSV and extracted-package checks remain unproved until
  corrected CI passes. Branch Windows validation now requires both NSIS and MSI.
- The same shared desktop run failed independently on Windows before OCR
  compilation: zlib configuration exited 1 because hardcoded Visual Studio
  17 2022 had no installed instance. The recipe's `vswhere` toolchain discovery
  must also drive its CMake generator/instance selection. No Windows OCR,
  staged-runtime or installer checks ran in that failed job. This is a separate
  build failure from Linux's disabled-legacy source-list mismatch.
- All first shared-candidate workflows finished naturally. Push/PR Tests and
  server passed on `a034503`; desktop Mac passed **149** native tests with eleven
  ignored, **875** unit tests without skips, staged and app-contained standalone
  plus generated four-viewer fault-media checks, native build and strict seal/
  version. Its app was ad hoc signed. Windows/Linux failed at their recorded
  prebuild steps, so no downstream OCR/native/package checks ran there. No
  cancellation, rerun or installed/notarized acceptance is implied.

- Corrected shared candidate `8e99186` passes push/PR Tests and server CI: each
  Tests platform totals **877** with no failures (Ubuntu 871 passed/six skipped;
  Windows 868 passed/nine skipped). Windows and Linux now build the pinned OCR
  runtime and pass actual version/hash, memory-PNG/TSV and loader checks during
  prebuild. Linux's loader closure contains libc/libm/ld; Windows uses the
  discovered VS 18 instance/static CRT and imports only KERNEL32.dll.
  Desktop run **38082587085** then fails naturally at Clippy's unused staged
  provider APIs/geometry helpers (`-D warnings`), Linux Cargo exit 101; Windows
  workflow exits 1. Their native tests, standalone/media and extracted installers
  did not run. The exact logs and both previous build failures are retained.
  This is partial compiler/OCR evidence, not package or installed acceptance.
  The same run's Mac job passed **151** native tests with eleven ignored,
  **877** unit tests without skips, staged and ad hoc app-contained standalone/
  generated four-viewer fault-media checks, strict seal/version and native build.
  All jobs finished naturally; no reruns or cancellations. Full notices were
  copied and hashed by the completed OCR build path, but extracted-package notice
  proof and independent content assertions remain absent.
- A focused shared-provider correction compares expected generations atomically
  for capability grants, target acceptance and native invalidation. Returned
  generations/leases belong to that mutation; superseded grants recheck after
  OCR drain before metadata. Two actual state/drain regressions pass alongside
  **877** unit tests and **153** native tests with eleven ignored, typecheck,
  lint/fmt/Clippy on this Mac. Concrete provider attachment and cross-platform
  package gates remain pending; root commit and independent immutable review
  are required for this correction.
- The reviewed `8e99186` overlay source/cancellation fix has no actionable
  independent findings. Its clean committed prebuild, staged desktop checks
  (**151** native passes/eleven ignored), staged standalone and nested Developer
  ID signing pass locally; this is neither installed nor notarized acceptance.
- The staged-provider compile correction keeps strict warnings and limits
  temporary `expect(dead_code)` attributes to the unused provider publication
  closure. Mac-only Vision/cover helpers are conditionally compiled. Actual
  shared source via a disclosed local Tauri startup/state-lookup shim passes
  Linux/Windows library and test metadata checks; a deliberate backend call
  fails an unfulfilled expectation, requiring removal when providers attach.
  A full local Windows cross-build first stopped at missing MinGW GCC; that log
  is retained. Real desktop/package CI remains required.
  The OCR smoke now requires every common/Linux notice to be nonempty and
  manifest-hashed, plus all pinned source URLs/versions/hashes and toolchain
  provenance. Isolated checks exercise this exact assertion block; actual OCR
  and extracted-package execution remain pending on the next candidate.

- Shared `802355a` passes independent immutable review (**877** unit/**153**
  native passes, eleven ignored) and clean committed local prebuild, staged
  desktop/standalone and nested Developer ID signing. Its local app-only build
  passes version 1.0.19, strict deep Developer ID verification and contained
  standalone/generated four-viewer fault-media checks. Local updater archive
  generation was disabled for this app proof; distributed configuration is
  unchanged. No notarization, installation or physical acceptance is claimed.
- Desktop run **38084491542** fails Linux before Lens/OCR/native validation at
  Astro `CannotFetchFontFile`: binary Google font fetch failed, build child exit
  1/signal null. The network subtype is unreported. Push/PR Tests and server
  pass; the other desktop jobs continue naturally. This is separate from all
  recorded native/OCR failures. The minimal shared build fix retries only
  HTTPS Google-font GET failures and restores the native fetch after builds.
  An actual full Astro reproduction of the exact URL fails after one attempt
  without the fix and succeeds after two with it; all **112** emitted font names
  and SHA-256 hashes are identical. Warm build makes no requests; exhaustion
  still fails after three and restores fetch. **883** unit tests, typecheck,
  desktop lint and focused provider/theme/lifecycle checks pass locally.
  The fix is committed as `32f3d16`. Its clean committed prebuild, staged
  standalone and all six built UI smoke scripts pass, including the remote
  workspace check; no external provider calls or golden updates were made.
  Real corrected desktop CI remains pending. The original `802355a` macOS job
  **114308029494** succeeds with **153** native passes/eleven ignored, **877**
  unit passes/no skips, staged and app-contained standalone and generated
  four-viewer fault-media checks. Windows installer completion remains pending;
  the original Linux prebuild failure is retained.
- RIME-50/51 exclusive platform modules may proceed against the landed,
  independently reviewed shared contract while its package gates remain open.
  Integration, promotion and `ready` still require actual checks. One coordinator
  and three implementation agents own Windows, Linux and shared integration;
  the coordinator monitors CI. Ordinary servers never gain native execution.
- RIME-50 has a concrete geometry contract gate: the selected WGC frame API
  exposes rendered content dimensions and compositor time, but no historical
  HWND bounds/DPI. Out-of-context window events are asynchronous; callback-time
  queries alone do not prove capture-time geometry. The adapter currently
  refuses capture/AX/overlays. A user decision on frame-local pixel geometry
  versus the original strict DPI contract is pending; no requirement is silently
  relaxed. X11 AT-SPI association also remains unproved and AX stays unavailable
  until an exact association is established.
- The RIME-50 native preparation phase contains exact HWND/process-lifetime
  checks, bounded UIA, source callback ordinals, native exclusion/placement and
  verified cleanup paths. Its immutable source hash is
  `b96c3af6a3c9f4615f19c82c7a2d36024dfbf8b56155c230e2278248f73bc342`.
  Partial WGC initialization now owns its cleanup guard before registering
  callbacks; all cleanup stages are attempted and failed cleanup/panic blocks
  replacement and successful Stop acknowledgement. Thread DPI restores on
  unwind. Combined actual shared/native Windows metadata and strict all-target
  Clippy pass with disclosed Tauri/session shims; full product formatting passes.
  Eleven native tests are present but have not executed on Windows. Independent
  commit review and actual Windows integration/runtime/package checks remain
  required. The capture-time geometry refusal remains in force; this phase
  neither enables nor accepts Windows Lens.

## Keeping the board truthful

Use a real tracker ID for progress, decisions and evidence. Do not post `ready`
on an implementation's acceptance package until that package's named checks pass.
Later progress or a blocker reopens a package. Persist settled status/evidence in
the tracker so it survives another checkout; journals remain local and ignored.

The original setup verified parsing/config/theme/preservation. Current preparation
adds scoped product checks; final full-suite, native build, installed acceptance,
distribution and external results are recorded only when actually performed.
