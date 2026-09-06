# Security

Report a vulnerability privately through GitHub's **Report a vulnerability** button on this
repository's Security tab. Please do not open a public issue for it. You will get an answer
within a week, and a fix or a mitigation before any public disclosure.

Application data routes require an authenticated session. Public sign-in, device authorization
start/poll, one-shot desktop bootstrap, and OAuth callback routes have their own scoped
credentials and validation. The agent's outbound tools wait for a confirm; every host a user names
(webhooks, MCP servers, browser wards' pages) is resolved once and checked against the private
address ranges before it is connected to; browser wards run Chromium sandboxed unless the server
is root without `BROWSER_EXECUTABLE`; stored credentials are sealed with `TOKEN_ENC_KEY`.

The standalone desktop binds to loopback with authenticated bootstrap/native actions; being
on loopback is not authorization. Its native workspace database, project files, recovery
buffers, and terminal screens remain local. Rime conversations and agent files can sync
with the paired account as described below. Encryption keys and pairing
credentials live in the OS credential store. Terminal environments exclude backend secrets.
Approved project roots constrain file operations, including symlinks. Biome runs with a
bundled configuration in a private temporary directory and never loads project plugins.

Remote clients authenticate to the server and select an owned, paired desktop. Both ends
authorize the relay; a server user ID never becomes a desktop user ID. Revocation closes
the connection and device-issued server sessions. An offline desktop cannot be edited or
continued remotely. The server handles plaintext content transiently over HTTPS/WSS; this
release does not provide end-to-end encryption against the server operator.

Deploy the [relay nginx configuration](ops/runtime-relay.nginx.conf), and disable payload
capture, cache overrides, disk buffering, and request-body reporting at every proxy/CDN.
Server backups may contain explicitly synced Rime files, memories, skills, attachments,
and chat histories (including code/tool excerpts), but never a replica of project folders
or native workspace databases. Sync is scoped to the paired server account, validates
regular-file paths, and preserves conflicting local versions. Provider credentials stay
on the server; its model endpoint resolves the user from the pairing credential and never
executes desktop tools. No remote mutation, pending approval, or terminal input is
automatically replayed after an uncertain acknowledgement.

Native terminal agents run with the local user's filesystem access. Rime input is off by
default. Only the user can enable **Allow Rime to type**, including native prompt responses;
that change applies immediately, while human ownership still blocks agent input until
released. Standard CLI permissions remain enabled unless the user selects **Unrestricted**
(YOLO), which applies on the next start. Shells use OS account permissions. Shared-tree coordination is advisory, not a
filesystem sandbox. Dirty worktrees and unrelated edits must be preserved.

Relayed model calls disable automatic inference retries (including SDK retries); a rejected
Codex credential can still be refreshed once. Provider failures retain their category, HTTP
status and request reference. The server records metadata rather than provider error bodies
for these calls. Native runtime diagnostics also store fixed categories only, in a 64 KiB
rotating file with one previous file. Task-review records remain in the desktop workspace
database; excerpts explicitly read into a conversation follow the shared Rime data policy.
