# Background app control

The integration is staged but **not enabled**. `computer_status.backgroundApps`
reports the pinned backend and the validation blocker. No agent argument, account
setting, environment variable, or remote request can enable it.

## Backend and ownership

The macOS parent uses Cua Driver 0.25.0 at
`6c0348b059595e63d1df96e6df2047ca7dbbbf1c`, through the Rust SDK's private worker
constructor. The worker inherits anonymous pipes from the signed Rimeward parent;
there is no public socket, raw Cua tool endpoint, or automatic daemon attachment.
Startup checks driver metadata, host permission attribution, and the observed
parent application's bundle identity. Worker telemetry is disabled. Production
prebuild compiles the worker from that revision with its upstream lockfile;
normal nested-code signing includes the worker and its notices.

`computer_apps` lists apps/windows. `computer_app_state` selects an existing,
background window and returns its accessibility elements and screenshot.
`computer_app_input` accepts left click, targeted scroll, or text, addressed by
an observed element token or screenshot pixels. `computer_app_release` releases
that agent's session. Launching, dragging, key chords, and other actions are not
exposed in this initial integration; limitations do not invoke physical input.

The tools reuse explicit device targeting, paired authentication, account screen,
Rime and input policies, local approval, and conversation attachments. PNG/JPEG
bytes are attached on the conversation's runtime and enter both model dialects,
including the approval-resumed path. Remote caller identity includes the source
conversation/task. Native observations are bound to that caller, the kernel's
process start time, exact window, bounds, Space, host generation, and expiry.
Input consumes the observation before dispatch. No uncertain input is replayed.

Only one app session is retained per host. Native permission/lock/disconnect
checks and the existing Stop paths invalidate it. Physical takeover invalidates
background authority. Bringing the target app forward pauses it. Only the local
preview can Resume, after the app is background again, and input then requires
a fresh observation. Sessions and image previews are in memory; screenshots
requested by Rime follow existing conversation attachment persistence.

The compact native preview has its own local-only Tauri capability, opens with
`focused(false)`, uses the native draggable window frame, and labels its images
as observations. It shows the app, image age, Rime's screenshot cursor, Pause /
Resume, Take over (pause), and Stop. Images update on observations around actions;
it does not claim to be live video. No ordinary web or remote page can invoke
its resume command.

## Release blocker

The pinned SDK's `worker.rs::request_with_timeout` holds the child-process mutex
while waiting for a response (up to 120 seconds). `shutdown_sync` acquires that
same mutex and sends shutdown on the same serialized channel. The private
worker also processes requests sequentially. Consequently a Stop, cancellation,
foreground takeover, or permission loss can revoke host authority immediately,
but cannot yet guarantee that already-running backend input stops immediately
or that routed held input is released after abrupt worker death.

The capability is therefore disabled in `desktop/src/background_apps.rs`.
Enabling it requires fixing or replacing this cancellation behavior, not merely
changing that flag. A dependency update must preserve the pinned-source,
private-worker, exact-window, and no-physical-fallback contracts.

## Required live validation before enabling

Run from a signed Rimeward app, first on the current macOS 27 build and separately
at the macOS 14 boundary. Record the OS build, app signature, Cua revision and
observed permission attribution. Keep typing in a foreground scratch document
while background clicks, scrolls and text target a separate scratch app. Verify
pointer position, typing destination, foreground app, and Space throughout.

Cover native and Electron apps, multiple windows, covered/minimized windows,
dialogs and out-of-process panels, Retina scaling, and unavailable private APIs.
Exercise stale observations, duplicate requests, foreground takeover, local Stop,
remote takeover, cancellation during input, lock, permission revocation, worker
failure, and relay disconnect. Verify no redirection, replay, or held input.
Do not mark an OS supported based on compilation, unit tests, or an unsigned
helper. Until these gates pass, older/unsupported hosts keep their existing
physical Remote Desktop controls.

## Validation recorded 2026-09-09

- Existing `npm test`: 481 passed; no test code was added or removed.
- Typecheck and desktop lint passed.
- A disposable committed snapshot outside Documents completed prebuild, including
  the pinned worker, bundled Node, native modules, Chromium, and license notices.
- Staged `desktop:check` passed: formatting, Clippy, 12 Rust unit tests, and the
  existing input-recovery harness. Its Linux OS acceptance run is not a macOS
  background-input proof.
- Packaged standalone and remote workspace smoke checks passed using disposable
  data and model fixtures; no external provider calls were made.
- Goldens completed and regenerated screens were inspected. The preview was also
  rendered with a generated test state; this does not validate native focus behavior.
- A disposable PNG receipt check exercised both new image-returning tools.

The pinned upstream native code emits linker warnings for duplicate
`CoreMediaBridge` Swift symbols, both in its own worker and in the linked SDK.
The system Swift runtime search path needed by the SDK was added to the host.
The duplicate-symbol warnings, signed-app permission attribution, concurrent
foreground typing, immediate cancellation/held-input recovery, and separate
macOS 27/macOS 14 compatibility still need resolution or live validation.
These checks preceded deployment and desktop installation. Background control
remains disabled in deployed and locally installed builds until the gates above pass.
