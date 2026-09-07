# Remote Desktop acceptance record

Implementation target: web **0.23.0**, desktop **0.5.0**, remote-desktop protocol **1**.
Recorded 2026-09-07. This is an implementation/verification record, not a release
or installed-platform certification. Fixtures use generated pixels/audio and
temporary files, with no model calls or personal application input.

| Check | Result |
| --- | --- |
| Full Node suite | 471 passed, none skipped |
| TypeScript and desktop lint | Passed |
| macOS native formatting, Clippy and unit tests | Passed; ten unit tests |
| Linux parent Clippy | Passed in isolated Linux build environment |
| GStreamer 1.28.6 macOS and Linux packages | Built with restricted plugins and checksummed manifests |
| Actual macOS bundled helper → Chromium | Direct WebRTC, generated 1080p video, Opus and input data channel passed |
| Actual Linux bundled helper → Chromium | Passed without the development SDK mounted; four viewers and injected audio/viewer failures |
| Shared capture and viewer isolation | Four viewers, mixed qualities, one capture, final-listener audio shutdown passed |
| One-hour generated media soak | Completed; 107,976 decoded frames, final 30 fps, no reported packet loss |
| Forced TURN | UDP and TCP passed against an isolated coturn fixture; TCP continued for eleven minutes across credential/allocation refresh |
| TURN refusal checks | Anonymous/expired credentials and private peer destinations refused |
| Native input recovery | Isolated Linux Xvfb: crash release 16 ms, stalled parent 5,004 ms, normal Stop 16 ms |
| Transfer failure preservation | Traversal/symlink/conflict/cancellation/resume tests passed; actual Linux tmpfs ENOSPC preserved the existing file |
| Browser transfer recovery | Partial file/folder persistence, changed local/source prefix refusal, upload middle-prefix validation and cancellation passed |
| UI goldens and smoke | Regenerated and inspected; editor, terminal, conversation, remote desktop and remote workspace checks passed |
| Rust source/license notices | Resolved for macOS, Windows MSVC and Linux dependency graphs |

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
- Production DNS-only `turn.frostdev.io`, trusted TLS, service/firewall provisioning,
  monitoring registration and forced-TURN acceptance on the production endpoint.
- Clean committed standalone packaging, distributed installer jobs, nested signing,
  notarization, deployment/rollback verification and installation verification.

The desktop workflow has a manual `validation_only` mode that builds/checks every
target without publishing a release. Production TURN setup is in
[`ops/turn-setup.sh`](../ops/turn-setup.sh); operation and test controls are documented
in [computer-control.md](computer-control.md).
