# Background app control

Native background control is enabled only on Apple Silicon macOS 27 build
`26A5416b`, validated on the owner's Mac. Other builds, including macOS 14,
remain disabled. No environment variable or remote argument can opt a host in.
Text in windows containing web content is refused before dispatch: isolated
VS Code testing showed that background text could be ignored. Use browser tools
or an explicit physical-control handoff for those fields. Click/scroll receipts
remain best effort and include a new observation for inspection.

## Backend and ownership

The macOS parent uses Cua Driver 0.25.0 at
`6c0348b059595e63d1df96e6df2047ca7dbbbf1c`, through the Rust SDK's private worker
protocol. The worker inherits anonymous pipes from the signed Rimeward parent;
there is no public socket, raw Cua tool endpoint, or automatic daemon attachment.
Startup checks driver metadata, host permission attribution, and the observed
parent application's bundle identity. Worker telemetry is disabled. Production
prebuild compiles the worker from that revision with its upstream lockfile;
normal nested-code signing includes the worker and its notices.

`computer_apps` defaults to a page of windows; `kind: "apps"` lists running and
installed apps. Both accept `query`, `pid`, `cursor`, and `limit` (default 20,
maximum 50). Repeat the filters with `next` as the cursor. Ordering is stable
while the app/window set is unchanged; restart pagination if that set changes.
`computer_app_state` selects an existing background window and returns a bounded
accessibility page and screenshot. It accepts `max_elements` (1–300, default 300),
`max_depth` (1–25, default 15), `query`, and `cursor`. The limits bound the native
AX walk; filtering and paging happen after exact-window isolation. Every read
captures fresh state and replaces the observation, so an active UI can shift
between pages. `elements_complete: false` remains explicit: missing rows prove
nothing about the full UI. Lower walk limits require an observed native text
element for text insertion; they cannot enable pixel text into an unseen web view.

Text receipts reserve room for session, observation, window, errors, and action
metadata below the agent's 12 KB limit. Long text fields are marked truncated;
`page` reports returned/available rows and `next` points to remaining rows.
Screenshot bytes travel separately as attachments. The agent's final omission
fallback also retains control IDs and action outcomes for older desktops.
`computer_app_input` accepts left click, targeted scroll, or text, addressed by
the short `element_index` in the current returned page, an observed element token,
or screenshot pixels. Index lookup stays in the native host and requires the
same one-use observation; hidden/paged-out indices are rejected. `computer_app_release` releases
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
Rimeward menu bar can Resume, after the app is background again, and input then requires
a fresh observation. Sessions are in memory; screenshots
requested by Rime follow existing conversation attachment persistence.

Background operations share a FIFO queue per device, with a 25-second queue
timeout before dispatch. Stop, Release, and heartbeats bypass the queue. Stop or
permission changes invalidate queued work. Serialize dependent reads/actions:
concurrent state reads each replace the preceding observation; duplicate inputs
still consume their observation only once and are never replayed.

An action returns its original `effect` and a fresh screenshot when available.
`verification.screenshot_changed` compares before/after capture hashes;
`requires_inspection: true` means Rime must inspect the screenshot/elements for
the requested outcome. A changed image is not proof of success, and
`effect: "unverifiable"` is never promoted to confirmed. Failed post-action
captures retain the session/window, consumed observation, action receipt, and
fresh-observation/local-resume requirements so the agent can inspect or release.

## Agent feedback

A live Codex native-tool probe on a disposable TextEdit document informed this
interface: Codex returns readable accessibility roles/labels, short element
numbers, the focused control, and automatic tree diffs; screenshots can be
requested separately or alongside the tree. Its programmatic wrapper can filter
text explicitly. These observations describe that tested tool surface, not
undocumented Codex internals.

Rime keeps fresh bounded rows with each action instead of relying on an implicit
old tree. `changes` highlights current indices whose returned rows differ from
the previous page, ignoring snapshot-token churn. It is a page comparison, not
proof of stable UI identity, a complete app diff, or successful delivery. Each
receipt gives `expiresAt` and the screenshot coordinate space. Images are
automatically attached after observation/input; their names identify device,
window and observation, and both model dialects receive an explicit file-ID
label immediately before each image, including after approval. Error and list
receipts also retain the device. The prompt tells Rime to inspect the returned
image first rather than unconditionally capturing another screenshot.

The native macOS sharing menu replaces the floating preview window. A
ScreenCaptureKit stream in the signed host captures only the selected window
at up to 2 fps and 640 pixels on its longest side. macOS supplies its live preview
and Stop Sharing control; Rimeward discards the stream frames locally. Agent
screenshots still come from fresh Cua observations. No display-wide stream,
audio, camera, or content-changing picker is enabled.

Stop Sharing immediately cancels the worker through its independent Stop channel.
A local pause latch survives tool release and session expiry; the agent cannot
resume itself. Rimeward's existing menu-bar dropdown shows the app and pause reason,
with Pause/Resume and Stop background control. Bringing the target window forward
also pauses input. Resume stays local, verifies the target when one is retained,
and requires a new worker and observation. No webview command grants Resume.
The stream ends on Pause, release, expiry, disconnect, or Quit. Apple's system UI
is described in [What's new in ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2023/10136/).

## Cancellation and release

The host uses the pinned SDK's private protocol with separate I/O and Stop
channels. Stop drops an inherited pipe immediately, independently of a blocked
request. A release-only child records each held key/button before the patched
worker can post its down event. On Stop, target invalidation, worker death, or
parent death, it terminates the sender before releasing retained input. Physical
control waits for release to settle. There is no reconnect or automatic replay.

The small pinned-source overlay guards public and private PID event posts and
checks the Objective-C metaclass for the keyboard authentication factory. Fresh
key-up events avoid carrying an obsolete authentication envelope from serialized
down events. Mouse releases preserve exact window-routing fields. The host uses
WindowServer's direct foreground check, since NSWorkspace can return stale
activation state in a process without an AppKit event loop. The guardian also
checks process start time, bounds, current Space, visibility and unlocked session.

Local Pause retains the session but cancels the worker. Resume requires a fresh
worker and observation. The snapshot excludes the application menu bar. Pixel
input uses the host-bound snapshot geometry without incorrectly passing Cua's
AX-only snapshot argument. Unconfirmed text pauses for local inspection.

## Live validation recorded 2026-09-09

Disposable native apps and a separate VS Code profile were used on macOS 27
`26A5416b`. The probe was a Developer ID signed Rimeward bundle, running the actual
worker and host session code; only app setup/policy plumbing was replaced by the
scratch harness. The production sharing menu and full installed runtime are checked
separately during installation. No model calls or real documents were used.

- Worker metadata, embedded mode, Accessibility/Screen Recording attribution,
  and the observed signed parent bundle identity passed.
- Exact-window native AX clicks, pixel clicks, text and scroll worked with a
  separate foreground scratch document receiving concurrent typing. Neither the
  physical pointer nor foreground app changed; the other target window was intact.
- Synthetic native text delivered balanced key transitions and the expected text.
- Stop during a stopped worker's held key, abrupt worker death, and abrupt parent
  death released input without replay. The final parent-death probe recorded
  27 key-downs/27 key-ups and a 50 ms release. Held-mouse Stop recorded two
  downs/two ups. These are observations on this Mac, not universal timing bounds.
- Host session checks passed duplicate-observation rejection, menu exclusion,
  Pause/Resume with fresh observation, foreground takeover, local Stop and the
  disconnect/revocation path (`tick(false)`).
- VS Code text delivery failed its file-content check. The host now refuses text
  in web-content windows before dispatch; a live refusal left the scratch file
  unchanged. It does not silently switch to foreground input.

Actual lock/permission-revocation UI, other Spaces, out-of-process dialogs and
macOS 14 were not exercised. The host fails closed on unavailable target/session
state; compatibility is intentionally limited to the recorded build and routes.
Do not expand the OS allowlist without separate signed-host acceptance.

Existing JavaScript tests, typecheck, desktop lint, native checks and packaged
standalone validation remain required for every build. No repository tests were
added or removed. The pinned dependencies still emit duplicate CoreMediaBridge
Swift linker warnings; the signed worker's capture/input paths were exercised,
but those upstream warnings have not been eliminated.
