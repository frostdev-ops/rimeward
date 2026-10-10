# Installed native acceptance

Prepared 2026-10-10 for the approved [two-release contract](../board/DELIVERY.md).
This is a procedure, not passing evidence. RIME-23, RIME-25, RIME-33 and RIME-48
remain pending until their exact-candidate checks pass. Use disposable local data;
preserve the profile and project roots. Serialize native input and installations
with the release coordinator. External accounts/providers are human-run.

## Candidate and evidence record

Before any live run, the coordinator supplies a committed signed candidate from
a clean detached `/tmp` checkout, staged desktop/standalone results, artifact
SHA-256, parent/helper/worker signatures and installation handoff. Follow the
release guide for backups, graceful shutdown, profile-preserving installation and
restored dashboard/sync verification. A successful build is not this handoff.

Record one row per scenario with package, source commit, artifact hash/version,
host architecture/OS/build, date, steps, expected and observed result, evidence
paths and limitations. Mark unrun checks pending and failures blocked. Candidate
changes invalidate affected evidence. Screenshots must contain only disposable
content, live outside `docs/goldens`, and exclude credentials and private paths.

Read-only inventory on 2026-10-10: this host is an arm64 Apple M5 Pro, macOS
27.0.1 build `26A434`. `/Applications/Rimeward.app` reports 1.0.17, bundle ID
`io.frostdev.rimeward`, Developer ID team `22AAZFMTV8`; a valid Developer ID
Application identity is available. The installed bundle contains the Apple helper,
MobileCLIP-S0 assets and Cua worker. Presence and signature metadata do not prove
runtime capabilities, Screen Recording/Accessibility attribution or current model
availability. No candidate was built/installed and no app input was performed
while preparing this procedure.

The installed 1.0.17 app passes `codesign --verify --deep --strict`; its Cua worker
and Apple helper signature metadata both name team `22AAZFMTV8`. This read-only
check neither notarizes a new candidate nor proves live permission attribution.

## RIME-23 installed workspaces and native control

- [ ] Record signed candidate, restored profile and the exact owning local runtime.
  Create a disposable two-root Workspace; verify the folder picker, instruction
  selection, virtual paths, Files/Editor/Changes and explicit consumer Leylines.
  An unavailable mount refuses without silently choosing another host.
- [ ] Save and recover a disposable file, close/reopen a dirty tab, resolve an
  external edit explicitly, and restart. Verify buffers, undo/recovery and local
  stores survive; project roots and `workspaces.db` never enter sync or backups.
- [ ] Open/end/resume a shell; verify PTY output, final saved screen, input ownership,
  delayed Enter cancellation and restart without task replay. Test real installed
  Codex/Claude prompt approvals with a disposable operation; a transport receipt
  alone does not prove approval or task completion. Absent CLI/login is pending.
- [ ] Verify touch controls and IME composition in an installed viewer without
  page shortcuts stealing input. Confirm changed/lost acknowledgements require
  reconciliation and do not retry mutations automatically.
- [ ] With RIME-48 passed, repeat the background safety matrix below on the actual
  installed candidate through production policies, tools and native menu. Verify
  permission attribution and marker/menu-bar exclusions, independent Stop,
  lock/revocation, Spaces and external dialogs. A scratch harness alone is insufficient.

## RIME-25 signed macOS Lens

Use two disposable native windows with distinct large text markers and colored
blocks, plus an image-only marker for OCR. Record actual window/app identity,
capture-time bounds/display scale, epoch, sequence, version and immutable frame
ref from `lens-status`/tool receipts. Never substitute a whole-display image for
the selected target or infer capture identity from a window title alone.

- [ ] Confirm Screen Recording/Accessibility attribution belongs to the signed
  parent. With consent denied, capture is unavailable. With consent granted and
  an active consumer, actual target pixels, AX lines and image-only OCR agree.
  Distinguish observed `ax`/`ocr` text from interpreted descriptions.
- [ ] Switch between windows/apps repeatedly; move/resize across display scales,
  occlude/unocclude, minimize/close and reopen. Verify target/pixel/OCR association
  follows the documented frontmost source and epoch; delayed OCR/helper callbacks
  from the old target never update the new document. Covers are not mistaken for
  underlying text, and unavailable targets report their actual state.
- [ ] Use `lens_look`, `lens_wait` and `lens_history` with the same consumer.
  Retain an unacknowledged delivery, verify repeated reads preserve it, then send
  its exact `ack` and verify cursor progress. Other consumers remain independent;
  omission/page receipts remain explicit and acknowledgement loses no unseen rows.
- [ ] Crop a retained `ref` using `lens_crop {ref, rect}` and inspect the returned
  geometry against its actual captured pixels, including scaled displays. Edit or
  switch after capture: the old crop remains immutable or reports `frame-evicted`.
  Run `lens_text {accurate:true, rect}` and compare the returned ref/epoch with the
  pixels it actually read: this tool selects the current captured ref internally,
  and accepts no caller ref. Native `lens-ocr` can test an explicit retained ref.
  Ref eviction must refuse rather than reading another window. Test invalid/outside rectangles.
- [ ] If the helper advertises describe, run `lens_describe` on the disposable
  retained crop; verify interpretation is separate and stamped to that ref. Missing
  local capability reports unavailable; cloud opt-in is not implied. Record helper
  availability without converting asset presence into a successful model result.
- [ ] Draw `overlay_show` cards/rect anchors and `lens_captions`, move the target,
  then clear them with `overlay_clear`. Verify anchoring, visibility and interactive
  controls; Lens excludes its own overlay pixels/OCR while other app windows still
  count as covers. Pixels/overlay ward switches independently enforce refusal.
- [ ] Observe idle startup and final-consumer release: no active demand means no
  ongoing capture. Add/remove a watch, monitor and wait consumer independently;
  remaining demand keeps capture alive. Pause captures/delivers nothing and returns
  a paused receipt; local Resume refreshes correctly. Stop, consent revocation,
  stream loss, app quit/relaunch and recovery leave no stale OCR, leaked consumers
  or automatic input replay. Retained offline documents carry an offline reason.

### Embedding and visual calibration feasibility

`deciderFor` prefers helper embeddings, then the configured embedding profile.
Apple helper triage and explicitly opted-in cloud triage remain; optional local-chat
D2 is retired. `localDecider` exposes embeddings only. Calibration is keyed by
`lens_calibration:<embedderId>`; helper seeds never certify a different embedder.

The existing `ops/lens-calibrate.ts` measures a synthetic changed-line corpus and
writes the selected embedder's row. Its existing test supplies a trigram stand-in
and a disposable test database; that validates the script, not real model quality.
Do not run the default CLI during offline preparation: it chooses the user's
configured profile and can reach a paired runtime or external embedding provider.
An actual run requires confirmed route ownership, exact embedder ID and approved
local assets/runtime; retain corpus size, FN/FP, AUC, chosen score and threshold.
The CLI's default `deciderFor(user)` has no injected native helper, so do not claim
it measured MobileCLIP without proving which embedder answered. Seeded/helper
availability and real-screen calibration remain separate evidence.

For 1.0.19, portable visual scores require their own `lens_visual_calibration`
rows and generated plus real disposable-application corpus under DELIVERY.md.
Do not reuse FeaturePrint/embedding thresholds or suppress ordinary OCR/AX when
portable visual calibration is missing. No new calibration was performed here.

## RIME-48 background-control qualification

Production `validated_host()` allows only arm64 build `26A5416b`. The current
`26A434` build must continue refusing until qualification passes. The coordinator
creates a disposable committed worktree with only the temporary exact-build
addition, signs normal parent/worker/guardian under `io.frostdev.rimeward`, and
records the artifact and diff. No environment flag or agent argument bypasses it.
Preserve the profile, avoid remote pairing and use disposable native documents.

| Scenario | Required observed result |
| --- | --- |
| Host/worker startup | Pinned worker metadata, inherited private pipes, telemetry off, production parent identity and macOS permission attribution agree. |
| Exact-window AX/pixel click, scroll and native text | Correct target changes; a second same-app window stays unchanged; bounds/Space/process-start/generation and one-use observation checks hold. |
| Concurrent foreground typing | Foreground document and physical pointer stay under human control while only the selected background target changes. |
| Web-content text | VS Code/web-content field refuses before dispatch; file remains unchanged; no silent foreground fallback. |
| Stale/duplicate observations and queued input | Replaced, expired, paged-out or consumed observations refuse; Stop invalidates queued work without dispatch or replay. |
| Stop with held key and held mouse | Independent Stop terminates sender before balanced releases; verify down/up counts and no stuck input before physical takeover. |
| Worker death, blocked request and parent death | Guardian releases retained input even when request/parent cannot respond; collect release times, no replay and settled child cleanup. |
| Local Pause, foreground takeover and Resume | Worker stops, local latch persists across tool release/expiry, remote Resume refuses; local Resume requires a new worker and fresh observation. |
| Real lock and permission revocation | Actual OS transition invalidates target/session and releases input; unlocking/regranting never replays and requires fresh local continuation. |
| Spaces and external dialogs | Different Space, hidden/moved window and out-of-process dialog cannot redirect input; target mismatch fails closed. |
| Native sharing/menu markers | Production sharing menu/Stop Sharing works independently; preview remains window-only with no audio; menu/marker pixels are excluded from observations. |

All rows must pass on the signed normal host. Failure discards the qualification
change and preserves production refusal. Only complete passing evidence permits
the identical exact-build addition on `dev/1.0.18`; revalidate the resulting signed
installed candidate for RIME-23. Do not broaden to an OS-version family.

## RIME-33 installed Remote Desktop

- [ ] Record exact installed host/viewer candidates on Apple Silicon macOS,
  Windows, X11, GNOME Wayland and KDE Wayland. Verify real permissions/portal and
  signed-macOS ScreenCaptureKit attribution; absent hosts remain pending.
- [ ] Exercise desktop-to-desktop and mobile-web mouse/keys/IME/touch, ownership
  takeover, local Stop, stale observations, account expiry/revocation and disconnect.
  Verify held inputs release and reconnect starts view-only without replay.
- [ ] Test actual direct WebRTC and Compatibility mode, four shared viewers with
  mixed quality/audio, final-listener audio shutdown, clipboard limits and disposable
  transfer conflict/cancel/resume. No microphone capture or server file storage.
- [ ] Record fresh current TURN TLS/refusal and forced UDP/TCP/TLS allocation/media
  evidence when the human-run deployment check is available. Historical production
  provisioning and the TLS health adapter alone do not close this gate.
- [ ] After warmup, collect ≥200 actual input-to-visible samples for each host/path
  in adaptive 1080p, one viewer. Keep raw samples and use nearest-rank p95. Require
  ≤200 ms LAN and ≤400 ms at 100 ms RTT, 20 ms jitter, 1% loss, 10 Mbps down/5 Mbps
  up; record shaping direction/configuration. Use a disposable visible response and
  a common-clock recording from dispatch to viewer pixels, not reported RTT.
- [ ] Run 60 minutes of actual display/audio on every named platform, including
  four viewers, monitor hotplug, lock, sleep and permission/audio changes. Log
  capture/audio/viewer lifecycle, CPU/RSS and interruption/recovery outcomes.
  Compare post-warmup and final steady-state median RSS for each host component
  and their total; growth must be below max(50 MiB, 10%) of its baseline. Record
  sampling cadence and steady-state intervals. Watchdog releases and no replay
  remain independent safety checks. Synthetic media soaks are separate evidence.

Release publication uses the final development commit's Tests/server/desktop
workflows, packaged-runtime checks, distribution signing/notarization and all
supported installers under the user's interim CI/CD acceptance rule. Manual
installed-platform results remain open; this checklist supplies no acceptance
or service-health certification.
