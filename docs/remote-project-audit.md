# Remote project audit — 2026-09-08

## Confirmed problems and repairs

- **Double routing:** `/runtime/<device>/api/dev/…?_ward=…` was resolved by ward again, producing a forbidden nested runtime path. Explicit runtime URLs now reach the relay once, preserving encoded paths and API error responses.
- **Destination routing:** the relay's local hop now carries an installation-authenticated marker. Native shell requests still resolve placement normally; relayed ward requests execute at their selected destination even while dashboard sync catches up.
- **Reconnect and capacity:** missed heartbeats permit reconnect, while replacement/revocation stops the old connection. Pending and active requests share the existing 64-channel device limit, including cancellation cleanup. The global pending limit remains intact.
- **Session churn:** concurrent session creation is coalesced; live shell sessions survive a new runtime session. The server retains at most eight device sessions and revocation removes them all. Delayed authentication failures do not invalidate a newer cached session.
- **Ward lifecycle:** failed mounts schedule one cancellable retry. Stopped mounts cannot restart themselves after a delayed failure. Resizing/remounting replaces the old view; removal stops the loaded renderer synchronously. A delayed module import cannot render into a replacement card.
- **Failure handling:** dev requests have deadlines, malformed HTTP responses produce useful errors, permission failures retain their reason, and closed terminal streams back off. Automatic control acquisition suppresses only ownership conflicts, not transport failures.
- **Editor traffic:** owned buffers renew and refresh in one request roughly every ten seconds; other owners' buffers refresh about every two seconds. Existing conflict/recovery handling remains in use.
- **Adjacent backend fixes:** stale buffer revisions are checked before lease takeover; terminal lists omit stored screen snapshots; repository-driven hooks/fsmonitor are disabled for managed Git operations; Chromium inherits the existing environment allowlist instead of backend credentials.

## Corrections to the unfinished audit patch

Removed automatic deletion of recovery history, silent search truncation, and clearing the shared-account identity guard on unpair. A UI page size is not a retention policy, and reconnecting must not silently authorize sharing the previous account's journal with a different account. Retained all existing tests, including the tests already added before this review.

## Verification and limits

The existing 481-test suite, TypeScript check, desktop lint, editor UI, terminal UI, browser UI, and remote workspace handoff checks passed during this review. The remote workspace check uses isolated accounts and fixture model responses; it verifies terminal/buffer continuity and excludes project content from server data/logs. No external model calls were made.

The combined golden run subsequently passed all editor, permissions, terminal,
conversation, Remote Desktop and browser checks. The remote workspace smoke
also passed after integration. The earlier missing staged browser cache and
Remote Desktop fixture failure were resolved before release preparation.

These repairs are included with the browser and Remote Desktop work in web
0.23.7 / desktop 0.5.7. See [release notes](releases/0.5.7.md) for the combined
scope. Production deployment and installed-platform verification are separate
release gates; the source audit itself does not establish those results.
