# Rimeward state and evidence

Refreshed **2026-10-10** for the accepted [two-release delivery contract](DELIVERY.md).
The October 5 survey remains historical evidence below. Current source/release
inspection and scoped preparation checks do not establish missing installed or
human-run provider acceptance.

## Revision and delivery

| Surface | Observed state | Evidence |
|---|---|---|
| Local and GitHub main | `82abf2c`; source version **1.0.18**; execution reuses `dev/1.0.18` | [PR #15](https://github.com/frostdev-ops/rimeward/pull/15), package.json, desktop/Cargo.toml, desktop/tauri.conf.json |
| Main Tests workflow | Passed on `82abf2c` | [Tests run](https://github.com/frostdev-ops/rimeward/actions/runs/38056828919) |
| Main server workflow | Passed on `82abf2c` | [Server run](https://github.com/frostdev-ops/rimeward/actions/runs/38056828905) |
| Main desktop workflow | Linux and Windows passed; macOS Runtime validation failed browser-live input-release/signaling checks | [Main desktop run](https://github.com/frostdev-ops/rimeward/actions/runs/38056828904); macOS job 114226923170 |
| Development desktop workflow | macOS/Linux passed; Windows still running at inspection | [Development run](https://github.com/frostdev-ops/rimeward/actions/runs/38056448593) |
| Published server | **1.0.17** | [Server release](https://github.com/frostdev-ops/rimeward/releases/tag/v1.0.17) |
| Published desktop | **1.0.17**, updater and platform installers present | [Desktop release](https://github.com/frostdev-ops/rimeward/releases/tag/desktop-v1.0.17) |
| Installed Mac app | **1.0.17**; deep strict signature passes, team `22AAZFMTV8`; live health unproved | Local `/Applications/Rimeward.app/Contents/Info.plist` and read-only codesign checks |
| Homebrew cask | **1.0.17** | Live tap/cask and [publication run](https://github.com/frostdev-ops/rimeward/actions/runs/36299392704) |
| Deployed website and public pages | **1.0.18**, `82abf2c`; hub/product pages and actual-interface examples published | RIME-44 ready journal 2026-10-10; [PR #15](https://github.com/frostdev-ops/rimeward/pull/15) |
| AUR package | `rimeward-bin` absent; RPC HTTP 200, resultcount 0 | [AUR RPC](https://aur.archlinux.org/rpc/v5/info/rimeward-bin); no aur.yml workflow runs found |

Passing build workflows establish the recorded revision's CI result. They do not
replace feature-specific live acceptance, installer publication or installed-app
checks. Source version 1.0.18 is not evidence of a published/installed 1.0.18 app.

## Branch and worktree disposition

- Retained `dev/1.0.14` through `dev/1.0.17` contain no unique commits beyond main.
  Existing BlackIce/agent branches are patch-equivalent to main; their checkout
  presence alone does not make them active work. Other people's worktrees remain.
- `aur-package` has one genuinely unmerged commit,
  [73d3e70](https://github.com/frostdev-ops/rimeward/commit/73d3e70), for Arch fallback
  README/wiki-source guidance. Its reviewed two-file change is integrated on
  `dev/1.0.18` for RIME-42; the stale branch is not merged wholesale.
- No open GitHub PR was found at initial refresh. `dev/1.0.18` exists at the
  published website revision and is reused for baseline execution. `dev/1.0.19`
  remains the planned portable release after baseline closure.
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
- Current main Windows CI passes on `82abf2c`; the older restore assertion remains
  historical. Browser-live's extra mouseup was reproduced as fixture cleanup
  crossing its log reset and fixed by awaiting that worker. The separate macOS
  RTC timeout has diagnostics and still requires final-candidate CI clearance.
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
  syntax and whitespace checks. Actual Windows extraction, tagged MSI and
  notarized Mac DMG checks still require their final candidate/tagged jobs.
- The user will run installed Windows/Linux/Arch checks manually and chose CI/CD
  acceptance for publication on 2026-10-10. Manual feature/platform packages stay
  open. Baseline publication requires final candidate CI and packaged-runtime
  acceptance; it no longer waits for those manual host results.
  No new release tag, deployment or installed candidate is established by this
  preparation snapshot. Track signed candidate handoffs separately from ready.

## Keeping the board truthful

Use a real tracker ID for progress, decisions and evidence. Do not post `ready`
on an implementation's acceptance package until that package's named checks pass.
Later progress or a blocker reopens a package. Persist settled status/evidence in
the tracker so it survives another checkout; journals remain local and ignored.

The original setup verified parsing/config/theme/preservation. Current preparation
adds scoped product checks; final full-suite, native build, installed acceptance,
distribution and external results are recorded only when actually performed.
