# Remote Desktop audit — 2026-09-08

Scope: viewer lifecycle/input, authenticated relay, host authorization and native
media/file dispatch, capture/encoding, and the integrated ward UI. Reviewed with
separate client, native-media and host/relay agents. Concurrent browser and remote
workspace work was preserved and checked with its owners.

## Repairs

- Hidden viewers renew their grant until idle detach. Visibility transitions are
  serialized; failed resume returns to reconnect instead of leaving a dead viewer.
- File/clipboard transport allows 120 seconds, including request upload. A slow
  body still requires independent renewal of the same approved host session.
- Authenticated paired endpoints translate the bounded grant lifetime to the host
  clock. Delayed requests cannot shorten newer host, media or transfer leases.
- Disconnect remains available after the ward is removed or retargeted. An expired
  host resume closes the corresponding server viewer.
- Relay upgrade timeouts remain armed until the upgrade succeeds; cancellation
  also cleans up pending channel waits.
- Pause, release, disconnect and monitor changes invalidate in-flight acquisition
  and media starts. Stale completions release their exact ownership, and cleanup
  blocks replacement starts until it finishes. Captures cannot return old-monitor
  pixels paired with new-monitor input coordinates.
- Media polling preserves queued events under contention; failed starts roll back.
  Overflowing ICE indices are rejected. Downloads reject invalid declared sizes
  and chunks extending beyond the declared file length.
- Input cleanup covers visibility, touch, lost control and teardown. Cancelled media
  negotiation does not spuriously start compatibility mode. The existing audit
  assertion now checks the count instead of merely checking that a SQL row exists.
- Media SDK caches are checked for required plugins before their completion marker
  is trusted. Incomplete default caches are reacquired; explicit incomplete SDKs
  fail before compiling the helper. Fresh packaging caught a missing JPEG plugin
  in a previously marked-complete cache.

## Performance and UI

- Compatibility frames are paced at the host, avoiding early-request responses
  that caused the client to wait another full frame interval. Acknowledgements and
  the single outstanding-frame bound remain enforced.
- Frequent native status requests reuse a short cache. macOS captures use the
  requested output size through ScreenCaptureKit; matching viewers share capture.
- VideoToolbox H.264 discovery now uses its actual baseline profile rather than
  the pinned media plugin's incompatible constrained-baseline parser filter.
  Generated-media checks confirmed live H.264 encoding. Hardware encoder presets
  use bounded fixed targets; adaptive hardware congestion control is not claimed.
- The ward has an integrated compact toolbar, expanded dialog, actual browser
  fullscreen, pin/hide/reveal controls, scaling/zoom, monitor and quality selection,
  audio, key sequences/sticky modifiers, touch controls, clipboard/files and
  explicit Rime handoff. Keyboard lock is requested only where supported.

## Verification and limits

The existing 481-test suite, TypeScript checks and desktop lint passed. Native
parent formatting/Clippy and 12 tests passed; the media helper passed formatting,
Clippy and release compilation. The staged desktop check also passed. Actual Chromium/helper checks passed with generated
1080p video, Opus audio, one and four viewers, and injected pipeline failures.
H.264 baseline negotiation was observed with VideoToolbox. Fresh packaging verified
653 runtime files, and restricted-bundle checks passed without SDK library paths,
including four-viewer fault recovery. Four SDK cache-gate checks passed without
adding repository tests.

Production build and the existing UI smoke checks passed. Golden screenshots were
regenerated and inspected. A temporary generated-fixture probe additionally checked
`document.fullscreenElement`, screen dimensions, toolbar hiding/pinning, popovers,
and fullscreen entry/exit from both the ward and expanded dialog. The bundled
Node runtime passed authentication, dashboard, Biome, recovery, PTY and restart
checks; remote workspace continuity/offline/reconnect smoke passed.

These checks do not quantify real-screen CPU, latency or bandwidth improvements,
establish installed Windows/X11/Wayland behavior, or verify production TURN,
signing/notarization or OS-reserved secure-desktop shortcuts. Existing tests also
do not exhaustively cover server session happy paths and every revocation race.
No deployment or desktop installation was performed by this audit.

See [computer control](computer-control.md) for the implementation contracts and
commands, and [remote project audit](remote-project-audit.md) for related relay and
workspace findings.
