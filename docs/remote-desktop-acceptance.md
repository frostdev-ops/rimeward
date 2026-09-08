# Remote Desktop acceptance record

Implementation target: web **0.23.0**, desktop **0.5.0**, remote-desktop protocol **1**.
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
| Committed macOS standalone package | Prebuild, desktop checks and standalone runtime checks passed in a detached checkout |
| Local Developer ID signing | 96 nested binaries and six bundles signed; app version 0.5.0 passed deep strict verification; not notarized |
| Web deployment | 0.23.0 at `5ffef5e`; online database/application/nginx rollback backup retained, migrations 021/022 applied, database integrity and public/origin HTTP health passed |
| Apple Silicon installation | Signed 0.5.0 installed after graceful shutdown and profile backup; 29 wards and recovery records restored, paired server sync and authenticated public relay read passed |
| macOS permission setup and restoration | Request/settings/recheck/relaunch UI, denied status, failed-recovery gating, page/draft/editor/undo/expanded/layout restoration fixtures passed; native local-origin and safe-destination tests passed |
| Local browser | Installed failure reproduced; local routing, paste, batched tab input, independent resize, reconnect, native Chromium session restoration, stalled capture shutdown and half-closed proxy cleanup checks passed; installed fixed-app check pending |
| Connected Account page | Reproduced Cloudflare script rewriting, missing server-build CSS and a native redirect loop; Cloudflare exclusion applied, mixed-build asset/tab checks passed; fixed-app installation pending |
| Installed macOS permissions | Screen recording and Accessibility are off; host accurately reports permission-required and local permission instructions |

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
