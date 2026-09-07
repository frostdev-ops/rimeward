# Remote Desktop and Rime computer control

A Remote Desktop ward targets one paired computer using `WardInstance.device`.
It opens view-only; **Take control** acquires the physical desktop's single input
lease. Human takeover preempts Rime. Taking over another viewer is explicit.
**Give control to Rime** selects an existing agent ward and grants its lease without
making a model call. Project folders and terminals remain on their original device.

Access belongs to the paired account. Configure account/device access in Devices,
the ward's Configure dialog, or the host's local Connections page. Policies are
stored separately from dashboards and use revisions to reject stale saves. Access
starts enabled for the owner, subject to OS permissions. Optional local connection
approval, individual capability restrictions, and access until the host quits are
supported. The latter is bound to the host process's boot nonce.

The tray **Stop remote access** disables viewing and synthetic input immediately
and persists a local suspension latch. Only a local action can resume it. Terminal
commands continue independently. OS permissions cannot be granted through the relay.
On macOS, allow Rimeward in Accessibility and Screen & System Audio Recording.

## Current transport and platform support

The app bundles a separate GStreamer 1.28.6 helper, Rust WebRTC/RTP plugins, and
a restricted, checksummed set of native media libraries. It negotiates media over
authenticated account signaling; video/audio use WebRTC and ordered input enters
the parent's existing controller through a data channel. H.264 is preferred with
VP8 fallback; Opus carries explicitly enabled system audio. Quality presets select
bandwidth saver, adaptive 1080p, or native resolution up to 4K. The helper's EOF,
authorization expiry and supervision are independent of viewer cleanup.

Failed WebRTC connections use explicitly labeled **Compatibility mode**:
acknowledged JPEG frames up to 1280 pixels and 8 fps through the account's HTTPS
relay. One frame per viewer may be outstanding; slower viewers do not accumulate
frames. Capture and input use XCap 0.9.8 and Enigo 0.6.1 in the signed parent.
macOS, Windows and Linux X11 have native implementations; installed-platform
acceptance remains separate from fixture tests. Wayland uses one RemoteDesktop/
ScreenCast portal session for PipeWire capture and EIS input. Notify is used only
when EIS is unavailable; an established EIS session never mixes the two protocols.
Portal restore tokens remain local and are consumed and rotated. Clipboard and
composed-text capabilities depend on the compositor and are reported independently.

macOS continuous capture uses ScreenCaptureKit; Windows uses D3D11 and WASAPI
loopback. Linux uses the selected PulseAudio/PipeWire-Pulse output monitor, never
the default source or microphone. Audio is muted initially and unavailable in Compatibility mode.
The TURN credential adapter is implemented; DNS/TLS/service provisioning remains
outstanding. Up to four viewers share one capture per display; independent bounded
branches preserve their quality and audio choices. Capture of system audio stops
when the final authorized listener leaves.
No microphones are captured. iOS target/Appium support has been removed; obsolete
stored settings are ignored. Mobile web clients may control supported computers.

Expand moves the same live viewer into a dialog. Retargeting closes the old session
before saving the new device. Fit/actual-size scaling, zoom, monitor selection,
control state and compatibility diagnostics are provided. Auto-connect is off by
default. Hidden viewers pause media; controlling clients heartbeat every two seconds
and lose synthetic input after five seconds without a heartbeat. Viewing reconnects
must reacquire control; uncertain input is never replayed.
After 60 seconds hidden, viewing releases its slot. Active transfers can continue
under their own renewed authorization. Returning starts view-only and rechecks the
four-viewer limit. Monitor unplugging releases input and selects a remaining display.
The parent also supervises a release-only input guardian: a native crash releases
held input through the guardian, while a stalled parent expires after five seconds.

## Clipboard and files

Clipboard exchange is manual text or PNG. Optional text synchronization runs only
while the controlling viewer is focused. Text is limited to 1 MiB and PNG to 8 MiB;
images have decoded allocation/pixel limits. Handoff clears pending synchronization.
Native clipboard processing has its own lock so image conversion cannot block input
release. Browser clipboard availability depends on its secure-context permissions.

The file panel browses an explicitly selected absolute root. File/folder uploads
use chunks of at most 4 MiB with SHA-256 checks, two active transfers per session,
progress and cancellation. Downloads stream through the authenticated HTTP relay;
no server file storage is used. Native directory capabilities confine relative
paths even if a symlink is substituted. Uploads use unpublished temporary files
beside the destination and atomic finalization: Keep both, Skip, or explicit
Replace. Cancellation never removes a pre-existing destination.

Interrupted uploads retain local recovery metadata and the unpublished temporary
file. Resume requires fresh account/session authorization, the same root/path,
a matching source fingerprint, and verification of the already transferred prefix.
Folder downloads stream a tar archive with bounded queues and cancellation,
including empty directories. File and folder downloads use private browser storage for partial
files, chunk checkpoints and explicit Save/Discard controls. Resumption verifies
the local bytes and the host prefix, and can rewind a chunk whose reply was lost.
Native prefix validation runs in bounded, reauthorized steps. Local recovery records
contain paths on the participating computers; they are not dashboard/audit data.
Folder resume replays the deterministically ordered archive from the host, verifies
each saved prefix chunk, and appends only after it matches. This avoids server file
storage but rereads the saved prefix. A changed prefix leaves the partial copy intact.

## TURN and operational monitoring

Create a DNS-only `turn.frostdev.io` A record for the deployment host, then run
`sudo bash ops/turn-setup.sh` there from the reviewed checkout. The script backs up
its configuration, obtains a publicly trusted certificate through an isolated HTTP
ACME location, and installs `rimeward-turn.service`. Existing nginx HTTPS listeners
are retained. Allow UDP/TCP 3478, TCP 5349 and UDP 55000–55199 in the host/provider
firewalls. The root-only shared secret remains in `/etc/rimeward/turn.secret`.
The account server reads that file and issues five-minute session-associated
credentials; no secret belongs in source control or dashboard settings.

Devices → Remote Desktop diagnostics shows owner-scoped 30-day session totals,
connection failures, HTTPS relay bytes, viewer-reported media bytes and network RTT.
The TURN check validates its TLS listener and certificate; forced-TURN tests prove
allocation and media separately. Add the `rimeward-turn.service` systemd unit and
port 5349 to the existing Services monitor registry after provisioning. Audit data
contains no media, clipboard, keys, credentials or full file paths.

## Rime tools

`list_devices`, `computer_status`, `computer_screenshot`, `computer_input` and the
existing project/file/terminal tools retain explicit `device` targeting. A server
agent supplies the paired device ID. A desktop agent can use `device: "local"`.
Keep project and terminal IDs bound to the device that created them.

Rime screenshots are individual conversation attachments. Human stream frames are
never conversation attachments and never automatically sent to a model. Agent input
requires a fresh single-use observation bound to the agent, target, display topology
and ownership generation. Human takeover invalidates it; another viewer receiving
a frame does not. Screenshot images follow the batch's tool replies and existing
approval ordering in both provider dialects. Screenshot content remains untrusted.

## Boundaries and verification

`/api/remote-desktop/` is excluded from automatic runtime forwarding. Viewer calls
use the account cookie and origin checks. Host execution requires both the native
parent token and a grant attached by the authenticated device control channel.
Session IDs alone confer no authority. Policy, ownership, topology and sequence are
checked on their relevant operations. Known logout/revocation tears sessions down;
account grants expire after 30 seconds without renewal. Parent IPC loss stops native
input independently. Audit retention is 30 days and excludes media, clipboard,
keystrokes, credentials and full file paths.

Shared-layout synchronization requires the separate remote-desktop capability
header before a layout containing this ward can be read or overwritten. An older
client gets an upgrade requirement and preserves its last valid local dashboard.
Existing pairing/project/terminal protocol versions remain unchanged.

Run the existing full suite, TypeScript checks, desktop lint, Rust formatting,
Clippy/tests, production build, standalone runtime checks and remote-workspace
smoke. `npm run goldens` also runs the editor, terminal, conversation and generated
remote-desktop UI smoke checks. Fixtures use generated screen pixels and temporary
files; they do not capture personal applications or make model calls. Installed
macOS/Windows/X11/Wayland acceptance, media performance, TURN and release signing/
notarization must be reported separately; passing fixtures does not establish them.

`tests/remote-media-smoke.mjs` exercises the actual bundled helper and browser with
generated video/audio, DTLS negotiation and input data-channel delivery. Set
`RIMEWARD_MEDIA_SDK` to the bundle directory and `RIMEWARD_MEDIA_HELPER` to its
executable. Omit `RIMEWARD_MEDIA_USE_SDK` to verify operation without a development
SDK in the loader path. This check does not establish OS permission attribution,
physical input behavior or multi-platform support. Set `RIMEWARD_MEDIA_VIEWERS=4`
to exercise shared capture, different qualities and removal of the last audio
listener. `RIMEWARD_MEDIA_DURATION_MS=3600000` runs a one-hour generated-media soak.
`RIMEWARD_MEDIA_FAULTS=1` with four viewers injects synthetic audio and per-viewer
pipeline errors, verifying that other viewers retain video. Fault injection is
available only when the helper is launched explicitly in synthetic-test mode.
