# Two-release completion contract

Accepted 2026-10-10. Finish 1.0.18 distribution and baseline acceptance first;
then ship native Windows/Linux Lens in 1.0.19. External Notion, OAuth, SMTP,
model/voice and hosted-browser acceptance is human-run. Agents prepare exact
procedures, diagnose failures and review returned evidence. Focused new tests
for native backends and reproduced defects are authorized; preserve all tests.

Execution adjustment, 2026-10-10: the user will run interactive Windows, Linux
and Arch acceptance manually and asked to use CI/CD acceptance for now. Release
publication may proceed after final-commit CI, packaged-runtime checks and the
available Mac distribution checks pass. Missing installed-platform and external
provider results remain open in their acceptance packages; they do not become
passing evidence. Current-Mac background support still requires RIME-48's signed
qualification before its exact build can enter the production allowlist.

Scope adjustment, 2026-10-10: the user explicitly said to skip AUR. RIME-43's
publication and AUR install/update acceptance are retired, not shipped. Keep
repository Arch fallback packaging/docs and the manual publisher; disable its
automatic release trigger. Neither release nor final completion requires AUR.

## Work and evidence ownership

The coordinator owns the tracker, release branches, shared versions/manifests,
workflows, signing, publication and installations. Integration owns Notion,
identity/provider reconciliation and acceptance. Rime/browser owns reliability,
voice and browser persistence. Native owns installed control/Lens/Remote Desktop.
At most three subagents run alongside the coordinator. Give each explicit file
ownership; preserve others' work. Serialize native input, microphones, account
replacement and installations. Use local disposable data and preserve profiles.

Register RIME-47 through RIME-54 before updates. Executing agents read the board,
post meaningful progress/blockers/review handoffs, and use ready only after their
named checks pass. Journal entries stay ignored; settled evidence lives in the
tracker. Every result records package, commit, artifact, OS/build, date, scenario,
observed result and limitations. Changed candidates invalidate affected evidence.
Preparing a checklist does not establish acceptance. Missing accounts/hosts or
human results block their gates while independent preparation continues.

## Baseline release: 1.0.18

1. RIME-47 refreshes board/config, local delegation instructions, acceptance
   procedures and environment inventory. No secrets/private instructions are
   published. RIME-27 retires optional local-chat D2 without removing existing
   embeddings, Apple helper triage or explicitly opted-in cloud triage.
2. RIME-35 corrects exact-build background support, historical TURN versus current
   health, triage composition and superseded findings. RIME-42 integrates the
   reviewed two-file fallback documentation from 73d3e70 and publishes the wiki.
3. RIME-48 qualifies arm64 macOS 27.0.1 build 26A434 on the current M5 Pro. Use a
   disposable committed qualification worktree containing only a temporary exact
   build allowlist addition. Sign the normal parent/worker/guardian under the
   production bundle identity. Preserve the profile, avoid remote pairing, and
   use disposable local native documents. Check target identity, click/scroll/
   text, concurrent foreground input, web-text refusal, Stop with held input,
   worker/parent failure, lock, revocation, Spaces and external dialogs. Verify
   balanced releases, no replay, independent Stop and local-only Resume. Only
   passing evidence permits the identical exact-build addition on dev/1.0.18.
   Failure discards the qualification change and preserves production refusal.
4. RIME-46 stages signed committed candidates from clean detached /tmp checkouts
   before acceptance starts. Its candidate-ready handoff is distinct from ready;
   acceptance does not depend on RIME-46 completion. RIME-6/9/13/17/19/23/25/31/33
   retain actual candidate evidence gates and remain open for manual results.
   RIME-46 publication uses the CI/CD adjustment above. RIME-17 includes B5 diagnostics
   without browser autostart and reuses RIME-19 for B6; RIME-19 follows RIME-13.
5. Require local unit/type/lint/build and applicable UI/remote-workspace checks,
   staged desktop/standalone checks, then Tests/server/desktop CI on the final
   development commit. Investigate the earlier Windows backup/restore assertion
   with subprocess exit code/stderr; do not infer a cause from empty stdout.
6. Promote only validated code; verify main CI. Preserve online database and
   application/config rollback backups; deploy only the clean committed revision.
   Immutable server tags publish server artifacts. Desktop tags create drafts;
   verify Mac signing/notarization, Windows NSIS/MSI and Linux DEB/AppImage CI
   packaged-runtime acceptance and all jobs before publishing. Windows/Linux
   installed startup remains pending manual evidence. Verify updater signatures,
   Homebrew, profile-preserving installation, restored sync and authenticated
   production-to-desktop relay. RIME-43 records the explicit AUR retirement;
   no automatic AUR publication is attempted. Never move published tags.

## Portable native Lens: 1.0.19

Use dev/1.0.19 after baseline closure. RIME-49 lands first, then Windows and Linux
owners work concurrently. Linux completes X11 before Wayland integration. One
integration owner controls shared native runtime/contracts/Cargo/prebuild edits.
Each implementation phase uses lens-impl at xhigh; each commit gets independent
lens-review at medium. Spawn with fork_turns=none and explicit reasoning effort.
Local agent prompts must name this contract and the current package/branch,
replacing obsolete dev/1.0.15 and missing-plan assumptions.

RIME-53 depends on RIME-49 through RIME-52; RIME-26 depends on those implementation
packages and RIME-53. RIME-54 depends on RIME-26/46/53 for final completion;
publication may use CI/CD acceptance while manual results are pending. RIME-53
must not depend on RIME-26. Repeat affected baseline checks after shared native
changes; unaffected evidence remains tied to its original candidate. Shipping
all installers is distinct from installed acceptance.

### Shared contracts and scope

Reuse LensCore, Doc/Source/Feed, native operation names, bridge epoch/sequence
ordering, immutable refs, acknowledgements, ring bounds and capture demand.
Native execution, project roots and workspaces.db remain local. No new authority
is obtained from observed text. Supported portable features are capture, exact
available accessibility text, OCR, look/wait/history/crop, regex/visual watches,
existing calibrated embeddings and opted-in cloud triage, and capability-gated
native overlays. Apple-only local describe/document/translation is unavailable;
never replace a local-only promise with an implicit cloud call.

Windows uses WGC CreateForWindow for the exact HWND and the existing pinned
Windows crate with required COM/D3D11/DXGI/UIAutomation features. Bind capture,
UIA and callbacks to HWND/PID/process creation time/epoch. Capture-time geometry
and DPI govern crops; resize/device loss recreate the frame pool. Protected,
locked, cloaked, minimized or destroyed targets refuse rather than switch window.
UIA reads are bounded and off the UI thread; inaccessible AX yields OCR-only or
unavailable status. Keep XCap for existing Remote Desktop behavior.

X11 reuses capture machinery and joins AT-SPI text only after exact application/
window association. Wayland uses a separate capture-only ScreenCast portal through
existing ashpd/GStreamer/PipeWire. Request one locally chosen window, or explicitly
label a display source where required. Never request input, EIS, clipboard or audio.
The helper receives private inherited pipes and its Lens-owned PipeWire FD; no
WebRTC viewer/remote grant is created. Keep latest BGRA frames bounded. Native
session handles, node IDs/serials, FDs and restore tokens never enter tool results.
Use available stream serials, otherwise session/generation pinning; tear down on
replacement, closure, revocation, suspend or topology changes. Unproved application
identity is unknown and OCR-only, with process-local source ordinals rather than
invented OS window IDs/global coordinates. Windows/X11 overlays require exact
anchor/exclusion behavior; Wayland overlays remain unavailable unless proved.

### Portable OCR

Bundle Tesseract 5.5.2, Leptonica 1.87.0 and English tessdata_fast at
87416418657359cb625c412a48b6e1d6d41c29bd, with checksum/manifests/notices and TSV
configuration. Invoke the bundled executable directly, without a shell:

```
tesseract stdin stdout --tessdata-dir <bundled-tessdata> -l eng --oem 1 --psm 11 tsv
```

Encode PNG into stdin, parse word TSV into whole lines with union boxes and 0–1
confidence, and map through capture-time top-left pixel geometry. No screenshot
files. One OCR child per Lens; latest capture wins while it runs. Background
deadline is five seconds; explicit OCR is min(caller deadline, thirty seconds).
Stdout cap 1 MiB, stderr 8 KiB, output 4,096 words/128 KiB recognized text. Kill,
reap and discard on Stop/timeout/cancellation/epoch change/overflow. Never publish
partial replacement as complete; accurate OCR uses retained immutable pixels and
preserves frame-evicted refusal. Sanitize diagnostics and keep raw stderr private.

### Portable visual scoring

Compare packed RGB on a 32x32 captured-pixel grid. Changed pixels have maximum
channel difference >=16/255. Tile score is changed_pixels/tile_pixels; join touching
dirty tiles and reuse minimum-waste merging to cap at eight rectangles, with the
maximum constituent score. Map to target points and reset on target/epoch/size
change. Score IDs are windows:wgc:rgb16-tile32-v1, linux:x11:rgb16-tile32-v1 and
linux:pipewire:rgb16-tile32-v1. Do not reuse FeaturePrint thresholds.

Add an optional source visual calibration accessor returning scoreId, thresholds
and calibrated state. Override gateDefaults visual/live thresholds after embedding
calibration; preserve absent-accessor behavior for Mac/browser/terminal. Persist
rows under lens_visual_calibration:<scoreId>, separately from embedder rows.
Missing/invalid calibration disables visual watches and live-region suppression
without suppressing ordinary OCR/AX delivery. Calibrate generated cursor/clock/
spinner/noise/edit/scroll/image/resize/switch cases, record corpus and error rates,
and prove against real disposable applications before seeding release thresholds.

## Acceptance and publication limits

Focused regressions cover native target lifetime/DPI, stale callbacks, OCR parser/
bounds/cancellation/assets, portal denial/node reuse, ambiguous AT-SPI, capability
truth, overlay exclusion, visual/embedder calibration isolation, queue/ring bounds
and quit. Preserve existing suites and goldens. New UI evidence uses disposable
captures outside docs/goldens.

Remote Desktop needs >=200 actual input-to-visible samples after warmup per path:
p95 <=200 ms LAN and <=400 ms at 100 ms RTT/20 ms jitter/1% loss/10 Mbps down/5 Mbps
up, adaptive 1080p/one viewer. Run sixty-minute actual display/audio soaks on Mac,
Windows, X11, GNOME Wayland and KDE Wayland including four viewers, hotplug, lock,
sleep, permission/audio changes. Final steady-state median RSS growth stays below
max(50 MiB, 10%) of post-warmup median. Watchdog releases and no replay are
independent safety gates. Synthetic media/RTT alone does not prove these results.

Completion requires all original open packages accepted or explicitly retired,
all new implementation packages passed, and 1.0.19 public distribution/installed
evidence. Human external results and absent native hosts remain explicit final
completion gates. Publication follows the user's interim CI/CD acceptance rule;
it does not close the manual acceptance packages.
