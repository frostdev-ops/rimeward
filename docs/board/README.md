# Rimeward project tracker

This is the versioned tracker for this checkout's Rimewire board. Agents record
progress, blockers, decisions, and acceptance evidence in the checkout-local
`.rimewire/journal/`; the journal stays out of Git.

Use stable `RIME-<number>` package IDs. Release work keeps the existing
`dev/<version>` convention and records its actual branch in the Branch column.
OS cells use Desktop, Server, Web, or Shared; individual desktop platforms can
use macOS, Windows, or Linux. Hooks are disabled.

Snapshot: **2026-10-10**, local and GitHub `main` **5ae7ea0**, deployed website and
published server/desktop/Homebrew **1.0.18**. Active `dev/1.0.19` source is **1.0.19**;
installed Mac remains **1.0.17** while its locked session prevents installation.
See [state and evidence](STATE.md) for the live CI, release and branch checks.

**Merged** means implementation in main; live acceptance is a separate package.
**Planned** is remaining documented acceptance/delivery, without an active assigned
branch. **Spec** is an optional follow-up requiring current scope. The accepted
[two-release delivery plan](DELIVERY.md) authorizes implementation and publication;
external account/provider checks remain human-run. On 2026-10-10 the user chose
CI/CD acceptance for publication and will run installed Windows/Linux/Arch checks
manually. Missing manual evidence remains open. New focused regression tests are
authorized for this work.
AUR publication was explicitly retired at the user's request on the same date;
repository fallback packaging remains available.

## Workspace and integrations

### Implemented

| ID | Title | OS | Depends on | Status | Branch | Evidence | Acceptance / next step |
|---|---|---|---|---|---|---|---|
| RIME-3 | Dashboard pages, ward windows and mobile Leylines editing | Shared | — | Merged | main | [Pages contract](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/pages-spec.md), 3b6e23a | Pages and pop-outs preserve ward identity and the shared layout. |
| RIME-4 | Notebook editors, local imports and document exports | Shared | — | Merged | main | [Notebook](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/notebook.md), de1f87a, d7d3c86 | Rich/Markdown/sheet/slides/drawing documents, navigation, import/export and revision guards are implemented. |
| RIME-5 | Linked Notion database sheets and lossless editing | Shared | RIME-4 | Merged | main | [Notion design/status](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/notion-notebook-design.md), 90c6b77 | Versioned links, workspace binding, paged rows, field/schema/view editing and explicit Ask coverage are present. |
| RIME-7 | Ward/page sharing and collaborative notes | Shared | RIME-3, RIME-4 | Merged | main | [Sharing](https://github.com/frostdev-ops/rimeward/commit/f2f68ea), 279d48c | Scoped view/edit links, Yjs collaboration, relay guards and terminal view-only sharing are present. |
| RIME-8 | Installation wizard, identities and integration OAuth lifecycle | Shared | — | Merged | main | [Identity contract](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/installation-and-identity.md), 844a874, 1e12a1c | Invitation/SSO, single-use attempts, broker delivery and migrations are in main. Model-account ownership is RIME-12. |
| RIME-10 | Dashboard continuity, startup and background performance | Shared | RIME-3 | Merged | main | [Continuity audit](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/dashboard-continuity-audit.md), 5a89b27, 424b4d2, 74a807a | Stable streams/drafts, deferred wards, incremental sync, lazy browser loading and less hidden-page work are merged. |
| RIME-11 | Leylines automation and connected service wards | Shared | — | Merged | main | [Product contract](https://github.com/frostdev-ops/rimeward/blob/22d956a/README.md), src/lib/logic-engine.ts, src/lib/comms/index.ts | Mail/calendar/Notion/comms and event/action routing are implemented; Lens triggers and decision assistance have separate packages. |

### Acceptance

| ID | Title | OS | Depends on | Status | Branch | Evidence | Acceptance / next step |
|---|---|---|---|---|---|---|---|
| RIME-6 | Verify live linked Notion editing and coverage | Shared | RIME-5 | Planned | — | [Reserved live validation](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/notion-notebook-design.md) | Record real read/edit/insert, conflicts, account replacement, pagination and source-wide Ask coverage on the current candidate. |
| RIME-9 | Verify installed identity, OAuth broker and SMTP handoff | Shared | RIME-8 | Planned | — | [Rollout gates](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/installation-and-identity.md#validation-and-rollout) | Record real provider consent, SMTP and installed OS handoff, including stale/cancelled attempts and legacy callbacks. |

## Rime and model access

### Implemented

| ID | Title | OS | Depends on | Status | Branch | Evidence | Acceptance / next step |
|---|---|---|---|---|---|---|---|
| RIME-12 | Provider connection ownership and pinned inference routes | Shared | — | Merged | main | [Routing](https://github.com/frostdev-ops/rimeward/commit/60c7565), mock correction 46162cf | Installation/profile/generation binding, stale-form refusal, source-bound catalogs and immutable model/voice routes; chat format 4, route contract 2. |
| RIME-14 | Reliable turns, bounded tools and background task evidence | Shared | — | Merged | main | a9fa583, e2a5b81, bc4541f, [responsive chat](https://github.com/frostdev-ops/rimeward/commit/21a5358) | Persisted failures, bounded serialized output, deadlines/cancellation and stream reconciliation; native termination metadata already resolved. |
| RIME-15 | B1–B5 and B7–B10 permissions, task surfaces and Markdown | Shared | RIME-14 | Merged | main | [Checkpoint](https://github.com/frostdev-ops/rimeward/commit/064831f), ward-config.ts, agent.ts, browser/devtools.ts, notebook-markdown.css | B1/B2 ceilings/MCP trust; B3/B4 task inspection; B5 scoped browser diagnostics without autostart; B7 styling; B8/B9 following; B10 literal Markdown access. |
| RIME-16 | B11 linked child resume and History continuation | Shared | RIME-12, RIME-14 | Merged | main | [Later resume checks](https://github.com/frostdev-ops/rimeward/commit/af42597), 064831f, 04b9617 | Atomic lineage admission, stop provenance, ceilings and recorded model/backend refusal; later checks supersede the old stopped checkpoint. |
| RIME-18 | Manual voice, B6 clip dictation and persistent Live delegation | Shared | RIME-12, RIME-14 | Merged | main | [Live sessions](https://github.com/frostdev-ops/rimeward/commit/278356e), b84cb5e, 48402c6, 064831f | One renewable session, bounded delegation, transient captions and deduplication; clip credentials are intentionally local-only. |
| RIME-20 | Semantic retrieval, durable monitors and callable tool catalog | Shared | RIME-14 | Merged | main | [Retrieval](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/semantic-retrieval.md), aea6724, b41a86c, 7d4b1ce | Workers/indexes, embedding profiles, keyword fallback, exact-before-semantic gates and durable delivery; discovered tools remain callable. |
| RIME-21 | Optional Jev decision assistance | Shared | RIME-11, RIME-20 | Merged | main | [Decisions](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/decision-assistance.md), 724fe0b | Bounded decisions/advice/routing are off by default, grant no authority, and carry no calibration claim. |

### Acceptance and historical disposition

| ID | Title | OS | Depends on | Status | Branch | Evidence | Acceptance / next step |
|---|---|---|---|---|---|---|---|
| RIME-13 | Verify provider ownership and reconcile rejected checkpoints | Shared | RIME-12 | Planned | — | [Plan](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/desktop-server-provider-plan.md), [old review](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/desktop-server-provider-review.md) | Reconcile R1–R10; record two-installation mode/account/OAuth races, old peers, catalogs and voice ownership. Old 629/632 is not current defect proof. |
| RIME-17 | Verify B1–B11 acceptance and reconcile reliability records | Shared | RIME-14, RIME-15, RIME-16, RIME-19 | Planned | dev/1.0.18 | [Historical chat audit](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/agent-chat-reliability.md), af42597 | Confirm ceilings, B5 no-autostart diagnostics, Stop/lineage/backend refusal, attachment rollback/mixed peers; reconcile old failures and relay restart/no-replay; reuse RIME-19 for B6. |
| RIME-19 | Verify Live voice and clip providers | Shared | RIME-18, RIME-13 | Planned | — | [Voice gates](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/agent-voice-plan.md) | Six probe groups/nine calls; delegation/result, quiet context/initial_items, cleanup, signed-Mac speaker echo/interruption and real clip-provider results. |

## Lens and desktop control

### Implemented

| ID | Title | OS | Depends on | Status | Branch | Evidence | Acceptance / next step |
|---|---|---|---|---|---|---|---|
| RIME-22 | Desktop runtime lifecycle and guarded native app control | Desktop | — | Merged | main | 58a7a3a, fe7c587, 9c451b4, [runtime](https://github.com/frostdev-ops/rimeward/blob/22d956a/desktop/src/runtime.rs) | Bundled startup/shutdown, native observation/input, cancellation and Pause/Stop; background input has a narrow Apple Silicon build allowlist. |
| RIME-24 | Bundled macOS Lens and shared observation surfaces | macOS | RIME-22, RIME-28 | Merged | main | [Lens core](https://github.com/frostdev-ops/rimeward/blob/22d956a/src/lib/lens/core.ts), eaa378a, e55bd37, a457416, 8ea849e | Screen/browser/terminal Doc/Source/Feed, consent, helper/models, tools, monitors, Leylines, watches and captions; capture follows active demand. |
| RIME-28 | Browser sessions, standalone windows and streaming | Desktop, Web | RIME-22 | Merged | main | [Browser workspace](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/browser-workspace.md), 887a74c, 91cbbb4, 469a096 | Persistent ward/expanded/pop-out sessions, stable tabs, split streams, fullscreen, fallback and viewer cleanup are present. |
| RIME-29 | Per-ward browser extensions and persistence | Desktop, Web | RIME-28 | Merged | main | [Extensions](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/browser-extensions.md), 971ba52, c6c029e | Bounded MV3 installation, restart, permissions, Glaze, ward packages/storage and legacy transfer are present. |
| RIME-30 | Authenticated browser downloads and document observations | Desktop, Web | RIME-28 | Merged | main | [Downloads](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/browser-downloads.md), a10f727 | Owning-runtime downloads, bounded retention, scoped attachments/import IDs and PDF text/page images are implemented. |
| RIME-32 | Remote Desktop media, input ownership and recoverable transfers | Desktop | RIME-22 | Merged | main | [Computer control](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/computer-control.md), 30d22a0, 70f3b0f, a10f727 | Account-bound control, WebRTC/native X11/Wayland capture, audio/clipboard and resumable bounded transfers are present. |
| RIME-34 | Multi-root Workspaces and remote continuity | Desktop | RIME-22 | Merged | main | [Workspaces](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/development-workspaces.md), 98db5b9, 04b9617, ca01260, 2a9bea0 | Local roots, virtual mounts, desktop/worker/SSH execution, guarded migration, patch recovery, PTYs and paired continuity; workspaces.db stays local. |

### Acceptance

| ID | Title | OS | Depends on | Status | Branch | Evidence | Acceptance / next step |
|---|---|---|---|---|---|---|---|
| RIME-23 | Verify installed workspace and native app-control behavior | Desktop | RIME-22, RIME-34, RIME-48 | Planned | dev/1.0.18 | [Workspace limits](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/development-workspaces.md), [background limits](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/background-app-control.md) | Installed dialogs/PTY/stores, touch/IME, real CLI approvals, marker exclusions; qualified-Mac Stop, lock/revocation, Spaces and external dialogs. |
| RIME-25 | Verify signed macOS Lens pixels, OCR and visual lifecycle | macOS | RIME-24 | Planned | — | [Capture](https://github.com/frostdev-ops/rimeward/blob/22d956a/desktop/src/lens/capture.rs), terminal.ts, tools.ts | Verify target/pixel/OCR identity through switches/occlusion, crops/descriptions, acknowledgements/overlays and idle/release/Pause/Stop recovery. |
| RIME-31 | Verify hosted and legacy browser persistence paths | Desktop, Web | RIME-29, RIME-30 | Planned | — | [Extension limits](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/browser-extensions.md), [download limits](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/browser-downloads.md) | Browserbase/legacy CDP confirm enable/restart/storage/downloads; installed migrations preserve packages, ownership and checkpoints. |
| RIME-33 | Verify installed Remote Desktop platforms and performance | Desktop | RIME-32 | Planned | — | [Outstanding gates](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/remote-desktop-acceptance.md#outstanding-acceptance-and-release-gates) | macOS/Windows/X11/GNOME/KDE, desktop/mobile input, attribution, actual response p95 and 60-minute capture/audio/hotplug/lock/sleep/resource runs. |
| RIME-35 | Reconcile native capability and acceptance documentation | Desktop | RIME-22, RIME-24, RIME-32 | Done | dev/1.0.18 | Scoped source/docs reconciliation 2026-10-10; native acceptance procedure; journal ready | Exact-build support, historical TURN/current-health and triage composition now match source. Decider 10/10 and local links/whitespace pass; installed gates retained. |

### Approved portability and scope disposition

| ID | Title | OS | Depends on | Status | Branch | Evidence | Acceptance / next step |
|---|---|---|---|---|---|---|---|
| RIME-26 | Deliver Windows/Linux native Lens | Windows, Linux | RIME-24, RIME-49, RIME-50, RIME-51, RIME-52, RIME-53 | Planned | dev/1.0.19 | [Approved native capability matrix](DELIVERY.md) | Capture/OCR/AX/tools/watches and capability-gated overlays; installed Windows/X11/GNOME/KDE evidence. Apple-only describe/translation remains unavailable. |
| RIME-27 | Retire optional local-chat Lens triage proposal | Desktop | RIME-24 | Done | dev/1.0.18 | [Approved retirement](DELIVERY.md); decider 10/10; emitted logic identical; journal ready 2026-10-10 | Composition comments and assertion wording corrected; embeddings/helper/cloud triage preserved. Retirement is a scope decision, not a shipped feature. |

### Portable implementation and installed acceptance

| ID | Title | OS | Depends on | Status | Branch | Evidence | Acceptance / next step |
|---|---|---|---|---|---|---|---|
| RIME-48 | Qualify current Mac background-control build | macOS | RIME-47 | Planned | dev/1.0.19 | [Qualification boundary](DELIVERY.md) | Signed temporary exact-build artifact and parent/worker/guardian safety matrix; extend the next unpublished candidate's allowlist only after passing evidence. Published tags remain immutable. |
| RIME-49 | Implement shared portable Lens and OCR | Windows, Linux | RIME-47, RIME-24 | In progress | dev/1.0.19 | [Portable contracts](DELIVERY.md), [phase evidence](STATE.md) | Shared lifecycle/OCR/cancellation/calibration and pinned packaging implemented; local checks pass. Independent commit review and Windows/Linux packaged OCR CI remain required before ready. Concrete capture awaits RIME-50–52. |
| RIME-50 | Implement Windows native Lens | Windows | RIME-49 | In progress | dev/1.0.19 | [WGC/UIA contract](DELIVERY.md), [blocked native phase](STATE.md) | Native WGC/UIA/lifetime/overlay probe is prepared; historical capture-time bounds/DPI remain unproved, so capture/AX/overlays are refused pending the coordinate decision. Independent review, real Windows checks and installed acceptance remain required. |
| RIME-51 | Implement Linux X11 native Lens | Linux | RIME-49 | In progress | dev/1.0.19 | [X11/AT-SPI contract](DELIVERY.md) | Exclusive capture/lifecycle/native overlay module implementation uses the landed, reviewed shared contract. AT-SPI stays unavailable until exact association is proved; integration/acceptance still requires shared package CI. |
| RIME-52 | Implement Linux Wayland native Lens | Linux | RIME-49, RIME-51 | Planned | dev/1.0.19 | [Capture-only portal contract](DELIVERY.md) | Separate ScreenCast/PipeWire session; local private stream identities, truthful unknown app/OCR-only fallback, revocation and capability-gated overlays. |
| RIME-53 | Verify portable installed Lens backends | Desktop | RIME-49, RIME-50, RIME-51, RIME-52 | Planned | dev/1.0.19 | [Platform acceptance](DELIVERY.md) | Independent phase reviews, installed Windows/X11/GNOME/KDE and affected Mac/shared-runtime acceptance; compilation alone is insufficient. |

## Release history

Retained release branches have no unique commits beyond main. These rows record
delivered milestones and do not identify active work.

| ID | Title | OS | Depends on | Status | Branch | Evidence | Acceptance / next step |
|---|---|---|---|---|---|---|---|
| RIME-36 | Deliver 1.0.14 workspaces and provider routing | Shared | — | Merged | dev/1.0.14 | [PR #2](https://github.com/frostdev-ops/rimeward/pull/2), 832fb74 | Server and desktop published; feature acceptance belongs to the packages above. |
| RIME-37 | Deliver 1.0.15 browser, Lens and voice updates | Shared | RIME-36 | Merged | dev/1.0.15 | [Desktop 1.0.15](https://github.com/frostdev-ops/rimeward/releases/tag/desktop-v1.0.15), 5a0eb2c | Server/desktop published after PRs #3–#6; live feature gates remain separate. |
| RIME-38 | Merge 1.0.16 desktop startup and runtime polish | Shared | RIME-37 | Merged | dev/1.0.16 | [PR #8](https://github.com/frostdev-ops/rimeward/pull/8), 1ae7d62 | Server published; desktop draft superseded by published 1.0.17, not an active blocker. |
| RIME-39 | Deliver 1.0.17 Linux AppImage fix | Shared | RIME-38 | Merged | dev/1.0.17 | [PR #10](https://github.com/frostdev-ops/rimeward/pull/10), [Desktop 1.0.17](https://github.com/frostdev-ops/rimeward/releases/tag/desktop-v1.0.17) | Server/desktop published; updater, DMG, DEB/AppImage and Windows artifacts are present. |

## Distribution and public site

### Implemented and delivered

| ID | Title | OS | Depends on | Status | Branch | Evidence | Acceptance / next step |
|---|---|---|---|---|---|---|---|
| RIME-40 | Automate Homebrew cask updates | macOS | RIME-39 | Merged | main | [PR #7](https://github.com/frostdev-ops/rimeward/pull/7), [1.0.18 publication](https://github.com/frostdev-ops/rimeward/actions/runs/38077925212) | Public and refreshed local cask point to verified 1.0.18 DMG URL/checksum; subsequent release updates require verification. |
| RIME-41 | Repository Arch package and AUR publishing workflow | Linux | RIME-39 | Merged | main | [PR #11](https://github.com/frostdev-ops/rimeward/pull/11), 06b8e11 | Versioned packaging/workflow merged; public AUR publication remains separate. |
| RIME-44 | Make Frostdev the central project hub and product pages | Web | — | Merged | main | [PR #15](https://github.com/frostdev-ops/rimeward/pull/15), 82abf2c; journal ready 2026-10-10 | Hub, public product pages and actual-interface animated examples accepted and deployed. Website-only publication does not establish a native release. |
| RIME-45 | AdSense site ownership verification metadata | Web | — | Merged | main | [PR #12](https://github.com/frostdev-ops/rimeward/pull/12), f94ed5e | Verification metadata/ads.txt merged; advertising delivery and Google review were not checked by this survey. |

### Remaining delivery

| ID | Title | OS | Depends on | Status | Branch | Evidence | Acceptance / next step |
|---|---|---|---|---|---|---|---|
| RIME-42 | Finish Arch fallback installation documentation | Linux | RIME-41 | Done | dev/1.0.18 | [Reviewed source change 73d3e70](https://github.com/frostdev-ops/rimeward/commit/73d3e70); public wiki 87051d1 | Integrated two-file fallback changes; published current Desktop Setup source without changing other wiki pages. |
| RIME-43 | Retire AUR publication from release scope | Linux | RIME-41, RIME-42 | Done | dev/1.0.18 | User decision 2026-10-10: Skip AUR; journal ready as retirement | Publication/install acceptance retired, not shipped or passed. Automatic release hook disabled; manual publisher and repository fallback packaging retained. |
| RIME-46 | Complete 1.0.18 release and desktop distribution | Shared | RIME-27, RIME-35, RIME-42, RIME-44, RIME-47 | In progress | dev/1.0.18 | [Merged PR #16](https://github.com/frostdev-ops/rimeward/pull/16), [CI and delivery](STATE.md) | Server/desktop/production and verified updater/cask delivered at 5ae7ea0. Final ready still requires profile-preserving Mac installation, restored dashboard/sync and post-install authenticated relay; Mac session locked. Manual feature/platform acceptance remains separate. |
| RIME-54 | Publish and verify 1.0.19 native Lens release | Shared | RIME-26, RIME-46, RIME-53 | Planned | dev/1.0.19 | [Second release](DELIVERY.md) | Publication may advance on CI/CD and packaged-runtime evidence; final ready also requires manual installed acceptance, updater/Homebrew and affected acceptance on the promoted revision. AUR is retired. |

## Board setup

| ID | Title | OS | Depends on | Status | Branch | Evidence | Acceptance / next step |
|---|---|---|---|---|---|---|---|
| RIME-1 | Configure and verify the local Rimewire board | Shared | — | Done | main | Three independent surveys; [snapshot](STATE.md); final verification below | 46 unique packages, six lanes, four release milestones, valid acyclic dependencies, resolving source links and visible evidence/acceptance details. |
| RIME-2 | Theme the board to match Rimeward | Shared | — | Done | main | Rimeward brand/theme; dedicated theme agent; live appearance checks | Local logo/fonts/CSS and auto light/dark frost palettes; 775px board and 390px board/drawer are readable without horizontal overflow. |
| RIME-47 | Prepare acceptance environments and evidence | Shared | — | Done | dev/1.0.18 | [Delivery plan](DELIVERY.md), [state](STATE.md); independent preparation review; 54-ID graph/config checks | Board/config/style versioned; three human procedures/evidence templates; signing available, missing AUR access and manual hosts recorded; obsolete private Lens instructions refreshed. |

Acceptance requires valid config and agent TOML, one managed block per applicable
instruction file, preservation of existing instructions and unrelated files,
an unchanged helper rerun, an ignored journal with versionable config/tracker,
and matching CLI/MCP package and completion evidence.

Initial mechanics verified 2026-10-05 with Rimewire 0.1.0 and Node 26.10.0: config and both local
agent TOML files parse; all four instruction files contain one managed block;
original instructions and 467 unrelated files are preserved; identical setup
inputs report zero changes; the journal is ignored and CLI-readable; config and
tracker are versionable; tracker links resolve; MCP resolves RIME-1 and the
configured lane/platforms; `git diff --check` passes. Setup was then reopened to
reconcile actual product state; its new completion entry records the expanded
board's final verification.

Expanded board verified 2026-10-05: config, tracker and agent TOML parse; all 46
IDs and six lanes resolve through CLI/MCP; four release milestones derive from
the release rows; dependencies are valid and acyclic; all 26 pinned-source links
and local evidence links resolve. The helper rerun reports zero changes; all 467
unrelated files and existing instruction blocks remain unchanged. The live board
renders evidence, acceptance criteria and STATE.md. Light/dark and narrow views
pass; configured text contrast is at least 4.56:1 light and 5.64:1 dark, with focus
above 3:1. Journal ignore/versionable-file checks and `git diff --check` pass.
Setup/theme completion leaves 29 merged implementations, two completed setup
packages, 13 planned acceptance/delivery packages and two optional scope packages.

## Planning references

The [documentation index](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/README.md)
identifies plans/reviews as historical evidence. Packages above reconcile them
with main; these references do not assert current live acceptance:

- [Desktop/server provider plan](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/desktop-server-provider-plan.md) and
  [review checkpoint](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/desktop-server-provider-review.md).
- [Voice plan and gates](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/agent-voice-plan.md).
- [Remote Desktop acceptance](https://github.com/frostdev-ops/rimeward/blob/22d956a/docs/remote-desktop-acceptance.md).
