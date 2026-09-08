# Remote Desktop acceptance record

Implementation target: web **0.23.3**, desktop **0.5.3**, remote-desktop protocol **1**.
Recorded 2026-09-07. This is an implementation/verification record, not a release
or installed-platform certification. Fixtures use generated pixels/audio and
temporary files, with no model calls or personal application input.

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
| Local Developer ID signing | 96 nested binaries and six bundles signed; app version 0.5.3 passed deep strict verification before and after installation; not notarized |
| Web deployment | 0.23.3 at `2773ff5`; online database/application/nginx rollback backup retained, migrations 021/022 applied, database integrity and public/origin HTTP health passed; PM2 and TURN service healthy |
| Apple Silicon installation | Signed 0.5.3 installed after graceful shutdown and a fresh profile, WebKit, preferences and recovery backup; four pages, 29 wards, 47 buffers and seven recovery copies retained. Paired server sync and authenticated public relay read passed |
| macOS permission setup and restoration | Request/settings/recheck/relaunch UI, denied status, failed-recovery gating, setup modal above restored expanded wards, page/draft/editor/undo/layout restoration fixtures passed; native local-origin and safe-destination tests passed |
| Local browser | Installed `0c9b548`: unassigned ward connected locally; two tabs, their order, active tab and exact draft survived installation/restart. Command-A, typing, paste and navigation title updates passed. Earlier navigation/history/expansion checks and automated routing, resize, reconnect and bounded shutdown checks passed. Dedicated test ward/page removed and original Spanish page restored |
| Connected Account page | Cloudflare rewriting, missing server-build CSS and native redirect loop fixed; installed app served all eight assets, all seven sections and the preset picker worked, and Dashboard navigation stayed local |
| Dashboard keyboard ownership | Page shortcuts and dashboard Undo share a guard for handled events, IME composition, focused input surfaces and the original event path. An isolated check against installed 0.5.2 reproduced the browser page jump; corrected build checks passed browser digits/brackets, input and nested-note events after focus changes, composition, handled events and neutral navigation. Actual CUA keypresses in installed 0.5.3 WKWebView then kept `123456789[]` in the browser, nested rich-text note and Rime composer, while neutral page shortcuts still worked. No model calls; fixture removed, original layout/pages verified unchanged and Home restored. Existing browser/editor/terminal/conversation and remote-workspace checks passed |
| Installed macOS permissions | Both permissions report Allowed after the user's changes; authenticated paired-host capabilities report available screen, input, clipboard, files and audio. A real cross-site bootstrap regression reproduced the missing restore marker and passed after the short-lived metadata cookie changed to Lax. Installed 0.5.2 then passed Save & relaunch: a fresh process reopened Set up this Mac above the same Spanish page with both permissions Allowed. Done returned to that restored page |
| Installed final-tab closure | 0.5.1 passed three immediate close/navigation cycles through the authenticated API with exactly one tab and real frames; native UI confirmed replacement navigation. Window inspection interrupted the final typing check; temporary fixtures were removed and the Spanish page restored |
| Intel native CI | Native lint/tests passed; run `34173656106` then caught a final-browser-tab replacement race. Replacement creation/activation now finishes before closing the original; failed creation preserves it. Repeated immediate close/navigation checks passed locally, including restored sessions and live screencasting; Intel revalidation remains required |
| Distributed release | Tags `desktop-v0.5.0`, `desktop-v0.5.1` and `desktop-v0.5.2` remain unchanged. Installer runs `34175413579`, `34176085313` and `34177028750` were canceled before publication for the browser race, installed permission-modal failure and dashboard shortcut regression respectively; none has a published release. Main CI `34178425073` passed at `2773ff5`; after installed keyboard verification, `desktop-v0.5.3` was pushed at that revision and queued installer run `34178912203`. Distributed signing, notarization and publication remain unconfirmed |

The one-hour run used the shared-capture implementation before the later isolated
pipeline-error handling change; the four-viewer fault test covers that change.
Observed process memory varied rather than demonstrating a monotonic leak, but this
is not a substitute for installed capture/resource profiling.

## Outstanding acceptance and release gates

- Installed Apple Silicon/Intel macOS, Windows, X11, GNOME Wayland and KDE Wayland
  acceptance, including signed macOS ScreenCaptureKit permission attribution.
- Desktop-to-desktop and mobile-web input against actual supported host OSes.
- Actual input-to-visible-response p95 under LAN and the specified impaired network;
  generated streaming/network RTT is not that measurement.
- Real display/audio capture for 60 minutes with monitor hotplug, lock, sleep and
  permission changes on each reference platform.
- Four-platform packaging CI, distributed installer jobs and notarization.

The desktop workflow has a manual `validation_only` mode that builds/checks every
target without publishing a release. Production TURN setup is in
[`ops/turn-setup.sh`](../ops/turn-setup.sh); operation and test controls are documented
in [computer-control.md](computer-control.md).
