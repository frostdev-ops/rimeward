# Remote Desktop acceptance record

Implementation target: web **0.23.6**, desktop **0.5.6**, remote-desktop protocol **1**.
Updated 2026-09-08 UTC. This is an implementation/verification record, not a release
or installed-platform certification. Fixtures use generated pixels/audio and
temporary files, with no model calls or personal application input.

Supported release targets: Apple Silicon macOS, Windows and Linux. Intel Mac
support was retired at the user's request on 2026-09-08.

| Check | Result |
| --- | --- |
| Full Node suite | 476 passed, none skipped |
| TypeScript and desktop lint | Passed |
| macOS native formatting, Clippy and unit tests | Passed; twelve unit tests |
| Linux parent Clippy | Passed in isolated Linux build environment |
| GStreamer 1.28.6 macOS and Linux packages | Built with restricted plugins and checksummed manifests |
| Actual macOS bundled helper → Chromium | Direct WebRTC, generated 1080p video, Opus and input data channel passed |
| Actual Linux bundled helper → Chromium | Passed without the development SDK mounted; four viewers and injected audio/viewer failures |
| Shared capture and viewer isolation | Four viewers, mixed qualities, one capture, final-listener audio shutdown passed |
| One-hour generated media soak | Completed; 107,976 decoded frames, final 30 fps, no reported packet loss |
| Forced TURN | Production `turn.frostdev.io`: UDP with four viewers and injected failures, TCP for eleven minutes across credential/allocation refresh, and certificate-validated TLS passed |
| TURN refusal checks | Production endpoint refused anonymous/expired credentials and private/reserved peer destinations |
| Production TURN service | DNS-only A record, trusted certificate with renewal hook, bounded allocation range and quotas installed; service/TLS monitors registered |
| HTTP relay exclusions | Cloudflare streaming/cache rules and nginx buffering/cache/logging exclusions include the remote-desktop route; nginx validation and public health passed |
| Native input recovery | Isolated Linux Xvfb: crash release 16 ms, stalled parent 5,004 ms, normal Stop 16 ms |
| Transfer failure preservation | Traversal/symlink/conflict/cancellation/resume tests passed; actual Linux tmpfs ENOSPC preserved the existing file |
| Browser transfer recovery | Partial file/folder persistence, changed local/source prefix refusal, upload middle-prefix validation and cancellation passed |
| UI goldens and smoke | Regenerated and inspected; editor, terminal, conversation, remote desktop and remote workspace checks passed |
| Rust source/license notices | Resolved for macOS, Windows MSVC and Linux dependency graphs |
| Main CI | Linux and Windows test jobs passed |
| Apple Silicon and Windows native CI | Bundled runtime, native tests, four-viewer media/fault checks and application compilation passed; distributed installer packaging is separate |
| Linux native CI | Bundled runtime, native checks, four-viewer media/fault checks and application compilation passed in run `34173319110` |
| Committed macOS standalone package | Prebuild, desktop checks and standalone runtime checks passed in a detached checkout |
| Local Developer ID signing | 96 nested binaries and six bundles signed; app version 0.5.5 passed deep strict verification before and after installation; local build not notarized |
| Web deployment | 0.23.5 at `70f3b0f`; online database/application/nginx rollback backup retained in `/var/backups/rimeward-before-0.23.5-tUF8KI`, migrations 021/022 applied, database integrity and public/origin HTTP health passed; PM2 and TURN service healthy |
| Apple Silicon installation | Signed 0.5.5 installed after graceful shutdown and a fresh profile, WebKit, preferences and recovery backup; five pages, 30 saved wards, 47 buffers and seven recovery copies retained. The Remotes page reopened outside edit mode. Paired server sync and authenticated public relay read passed |
| macOS permission setup and restoration | Request/settings/recheck/relaunch UI, denied status, failed-recovery gating, setup modal above restored expanded wards, page/draft/editor/undo/layout restoration fixtures passed; native local-origin and safe-destination tests passed |
| Local browser | Installed `0c9b548`: unassigned ward connected locally; two tabs, their order, active tab and exact draft survived installation/restart. Command-A, typing, paste and navigation title updates passed. Earlier navigation/history/expansion checks and automated routing, resize, reconnect and bounded shutdown checks passed. Dedicated test ward/page removed and original Spanish page restored |
| Connected Account page | Cloudflare rewriting, missing server-build CSS and native redirect loop fixed; installed app served all eight assets, all seven sections and the preset picker worked, and Dashboard navigation stayed local |
| Dashboard keyboard ownership | Page shortcuts and dashboard Undo share a guard for handled events, IME composition, focused input surfaces and the original event path. An isolated check against installed 0.5.2 reproduced the browser page jump; corrected build checks passed browser digits/brackets, input and nested-note events after focus changes, composition, handled events and neutral navigation. Actual CUA keypresses in installed 0.5.3 WKWebView then kept `123456789[]` in the browser, nested rich-text note and Rime composer, while neutral page shortcuts still worked. No model calls; fixture removed, original layout/pages verified unchanged and Home restored. Existing browser/editor/terminal/conversation and remote-workspace checks passed |
| Installed macOS permissions | Both permissions report Allowed after the user's changes; authenticated paired-host capabilities report available screen, input, clipboard, files and audio. A real cross-site bootstrap regression reproduced the missing restore marker and passed after the short-lived metadata cookie changed to Lax. Installed 0.5.2 then passed Save & relaunch: a fresh process reopened Set up this Mac above the same Spanish page with both permissions Allowed. Done returned to that restored page |
| Installed final-tab closure | 0.5.1 passed three immediate close/navigation cycles through the authenticated API with exactly one tab and real frames; native UI confirmed replacement navigation. Window inspection interrupted the final typing check; temporary fixtures were removed and the Spanish page restored |
| Intel native CI | Native lint/tests passed; run `34173656106` then caught a final-browser-tab replacement race. Replacement creation/activation now finishes before closing the original; failed creation preserves it. Repeated immediate close/navigation checks passed locally, including restored sessions and live screencasting; Intel Mac support was subsequently retired at the user's request |
| Distributed release | Existing tags remain unchanged. 0.5.3 Apple Silicon signing/notarization passed, Linux packaging failed, and remaining jobs were canceled before publication. 0.5.4 corrected Linux packaging, but Apple Silicon and extracted Linux media checks exposed a viewer-attachment race. The deterministic fix targets 0.5.5; publication remains gated on every installer job |

Packaging follow-up: installer run `34178912203` passed Apple Silicon signing,
notarization (Accepted) and draft asset upload, but Linux failed when linuxdeploy
scanned the private media directory and could not resolve `libgstwebrtc-1.0.so.0`.
Commit `2c4556d` relocates the Linux runtime to `usr/share/Rimeward/runtime` and
adds extracted-AppImage byte comparison plus the existing standalone and
four-viewer media checks. Local checks passed (476 Node tests, TypeScript, lint,
and twelve Rust tests); Linux validation run `34180823056` passed DEB/AppImage packaging, extracted-runtime byte comparison, standalone checks and four-viewer media/fault checks.
An isolated Linux reproduction failed with private libraries under `usr/lib`,
then passed under `usr/share` with byte-identical files and no SDK libraries
merged into Tauri's library directory. The development path remains the prebuilt
`desktop/runtime` directory.

The `desktop-v0.5.3` tag remains unchanged. Its Windows and Intel jobs were
canceled before completion, without preceding build errors; its release remains
a draft. Main CI `34180996385` passed at `c0ac353`; `desktop-v0.5.4` starts the
four-platform installer run `34181274549`. Local staged prebuild, native tests,
standalone smoke, nested signing and strict app verification passed. Web 0.23.4
was deployed and signed desktop 0.5.4 installed; public/origin HTTP, paired-host
relay and host capability checks passed. Installer publication is still pending. Apple Silicon job `101920716402` passed
native and runtime checks but timed out during the four-viewer media test. Two
local runs of the same signed helper passed. Commit `0c8101d` adds every viewer's
state and frame counters to failure diagnostics without changing test assertions;
Apple Silicon diagnostic validation run `34182265435` passed, confirming that the old ordering could pass intermittently.

The 0.5.4 Linux installers also built, then the extracted media test hit the same
viewer-join timeout. A deterministic local reproduction inserted a 150 ms
scheduling gap between attaching a live tee and starting the viewer branch: the
old order stalled before SDP with zero frames. Starting the branch before linking
the tee passed the unchanged four-viewer/audio/fault checks with the same gap.
The production fix changes only that ordering, without an artificial delay or
relaxed assertions. This correction targets 0.5.5; 0.5.4 remains unpublished.

The fixed revision `70f3b0f` passed all 476 Node tests, TypeScript, desktop lint,
helper formatting/Clippy/tests, and the unchanged four-viewer/audio/fault smoke.
Main Linux and Windows CI `34182987861` passed. A clean detached checkout passed
prebuild, twelve native tests, standalone checks, nested signing, the signed
four-viewer smoke, and the application build. Web 0.23.5 was deployed and signed
desktop 0.5.5 installed; public/origin health, actual paired-host relay access,
and available host capabilities passed. In installer run `34183314335`, Apple
Silicon passed signing/notarization (Accepted) and uploaded the DMG/app archive;
Linux passed DEB/AppImage packaging, extracted byte verification, standalone
checks and four-viewer media validation. Windows hit `ECONNRESET` while fetching
the pinned SDK before compilation. At the user's request, Intel Mac support was
retired and the remaining Intel job canceled. Release 0.5.6 removes the Intel
runner/target, rejects Intel macOS bundling, and adds bounded SDK download retries
with partial-file cleanup and unchanged checksum verification. Existing release
tags remain unchanged. Apple Silicon, Windows and Linux remain supported.
The updated bundlers passed isolated connection-reset, interrupted-stream,
HTTP-error, retry-exhaustion, checksum-mismatch and cache-reuse checks; both
macOS build entry points reject x64 and accept arm64. All 476 existing Node
tests, TypeScript and desktop lint passed again for this change.

The one-hour run used the shared-capture implementation before the later isolated
pipeline-error handling change; the four-viewer fault test covers that change.
Observed process memory varied rather than demonstrating a monotonic leak, but this
is not a substitute for installed capture/resource profiling.

## Outstanding acceptance and release gates

- Installed Apple Silicon macOS, Windows, X11, GNOME Wayland and KDE Wayland
  acceptance, including signed macOS ScreenCaptureKit permission attribution.
- Desktop-to-desktop and mobile-web input against actual supported host OSes.
- Actual input-to-visible-response p95 under LAN and the specified impaired network;
  generated streaming/network RTT is not that measurement.
- Real display/audio capture for 60 minutes with monitor hotplug, lock, sleep and
  permission changes on each reference platform.
- Three-platform packaging CI, distributed installer jobs and macOS notarization.

The desktop workflow has a manual `validation_only` mode that builds/checks every
target without publishing a release. Production TURN setup is in
[`ops/turn-setup.sh`](../ops/turn-setup.sh); operation and test controls are documented
in [computer-control.md](computer-control.md).
