# Dashboard continuity audit

2026-09-08. Scope: chat disappearing and other wards becoming unavailable while Rime works.

## Findings and repairs

1. **Long-lived requests exhausted the local browser's HTTP/1.1 connections.**
   Status, logic, paired-instance, terminal and browser SSE subscriptions each
   occupied a connection. A streamed agent response could take the sixth slot,
   leaving editor requests, browser commands and connection-health checks queued.
   The existing streams now share one authenticated WebSocket per dashboard.
   Subscription paths still pass through the original API authorization and
   runtime routing. The bridge permits only existing SSE GET routes, bounds
   subscriptions and buffering, and cancels upstream requests on unsubscribe.
   The tracked nginx configuration includes its upgrade route.

2. **Refreshing chat destroyed the visible view before its request completed.**
   Shared Rime reconciliation broadcasts agent refreshes, including during turns.
   Stateful renderers now retain their DOM while refreshing. Chat updates its
   existing view, retains the transcript and draft through failed refreshes, and
   discards stale responses after newer live events. Each ward registers its
   event listeners once. Remote turns also hold their ward against layout removal
   or repaint. Reconnect reconciliation cannot supersede the first mounting pass.

3. **Interrupted response streams were mistaken for completed turns.**
   A response must carry its terminal event to count as complete. An interrupted
   accepted stream switches to the live mirror and checks the stored state.
   Reconnected logic streams refresh conversations so a missed completion does
   not leave the chat permanently busy. No inference or uncertain input is replayed.

4. **Layout fallbacks could reload the whole workspace.**
   The latest deferred layout and page metadata are retained and reapplied when
   holds clear. A late turn starting during the exit animation is checked again.
   Incompatible changes offer an explicit reload instead of silently interrupting
   other wards and unsaved work.

5. **Browser rendering and screencast lifecycle had unnecessary teardown races.**
   Routine rerenders preserve the canvas, transport and expanded view. A new
   screencast waits for its predecessor to stop; stale starts and frames cannot
   replace the current cast. Tab selection honors the newest selection. Closing
   a session is idempotent, and reconnect waits for closure. Idle eviction and
   reaping exclude queued or active agent operations; explicit extension restart
   refuses while those operations are running.

## Validation

- Disposable Chromium reproduction before the transport fix: five idle SSE
  streams plus one held response prevented a browser request from reaching the
  server for over 1,000 ms. An independent server probe completed in 8 ms.
  Releasing the response immediately unblocked the browser request.
- With the actual new client and server transport: 12 subscriptions plus a held
  response, ordinary request completed in 1 ms; missing-cookie and foreign-origin
  connections were rejected; forbidden routes were rejected; runtime routing,
  socket reconnection and complete upstream cleanup passed.
- A separate compiled-dashboard check passed delayed, stale and failed chat
  refreshes during live output, stable DOM and draft, single event delivery after
  repeated refreshes, completion during the first render, and expanded-dialog
  close during a remote turn.
- All 481 existing tests, typecheck, desktop lint, production build, regenerated
  goldens and editor/terminal/conversation/browser/Remote Desktop smoke checks
  passed. Existing transport mocks were adapted without removing assertions.
- Remote-workspace smoke passed navigation, relay, offline recovery and retained
  terminal/editor state without external model calls.
- A fresh staged desktop prebuild, standalone-runtime smoke and desktop checks
  passed, including Clippy and all 12 Rust tests. The staging command explicitly
  matched the Xcode compiler and SDK after detecting an inherited SDK mismatch;
  system settings were not changed. No signing, installation or release occurred.

## Delivery boundary

These are source changes coordinated with the concurrent browser-extension task.
The later ward-mention task continues to edit the shared chat client; its subsequent
feature changes require that task's validation and are outside this audit's checks.
The audit does not establish deployed or installed behavior. The server, desktop
bundle and nginx upgrade configuration must ship together before using the new
transport in production. Existing profile data and unrelated edits are preserved.
