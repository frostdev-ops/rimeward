**Section 2 · Remote / web** · [Wiki home](https://github.com/frostdev-ops/rimeward/wiki/Home) · Previous: [Pairing](https://github.com/frostdev-ops/rimeward/wiki/Remote-Access) · Next: [Operations](https://github.com/frostdev-ops/rimeward/wiki/Remote-Operations)

The **Remote Desktop** ward shows a paired computer's screen and can pass mouse/keyboard input to it. It is optional: remotely routed Editor and Terminal wards work without opening a screen session.

## Start a session

1. Pair the host computer with your account and leave Rimeward running there.
2. Review the host's access policy in local **Connections**, **Devices**, or the ward's Configure dialog.
3. Grant any necessary OS permissions locally on the host.
4. Add a **Remote Desktop** ward, choose the paired computer, and connect.
5. Begin in view-only mode. Choose **Take control** when you want input, then **Release control** when finished.

Access belongs to the paired owner account. Local connection approval and individual capability restrictions can be enabled. Cross-account desktop sharing is not part of the current product.

## Grant platform permissions

| Host | What to expect |
| --- | --- |
| macOS | Use **Mac permissions** from Account or **Set up Mac permissions** in Connections. Screen & System Audio Recording permits capture; Accessibility permits mouse/keyboard input. Grant access to the signed installed app. |
| Windows | Screen capture and input depend on the active desktop/session. OS-reserved shortcuts and secure-desktop actions are not guaranteed through ordinary simulated input. |
| Linux X11 | Native capture/input are implemented. Use a distribution meeting the current package requirements. |
| Linux Wayland | Capture/input use the compositor's RemoteDesktop/ScreenCast portal. Follow its local chooser. Clipboard and composed-text support vary and are reported separately. |

On macOS, Microphone, Input Monitoring, and Full Disk Access are not required simply for Remote Desktop. If macOS requires a relaunch, use **Save & relaunch Rimeward** after finishing important work. Recovery restores supported UI state; it does not restart native commands or input ownership.

Permissions cannot be granted through the relay. A browser on a phone can be a viewer; iOS/iPadOS are not host targets.

## Give control to Rime

Use **Give control to Rime** and select an existing Rime ward. This grants the screen-control lease; it does not itself make a model call. Then ask that agent to perform the intended task.

Only one controller owns screen input at a time. Human takeover preempts Rime; taking over another viewer is explicit. A reconnect begins view-only and requires control to be acquired again. Held input is released on failures rather than replayed.

The local tray's **Stop remote access** immediately suspends screen viewing and synthetic input, and only a local action can resume it. This is a screen-access control, not a command to stop independent terminal work or remove the server pairing.

## View, sound, clipboard, and files

Use the toolbar to select a monitor, fit/fill/actual size, quality, and audio. **Expand** opens a larger ward view; **Fullscreen** uses the viewer's screen. The Keys menu can send explicit shortcuts, although host and viewer operating systems may reserve some combinations.

Audio starts muted. Supported WebRTC sessions can carry system sound when explicitly enabled; they do not capture your microphone. Audio is unavailable in Compatibility mode.

Clipboard exchange is manual text or PNG, with optional text sync only while the controlling viewer is focused. Browser clipboard permissions and host capability still apply. Text is limited to 1 MiB and PNG to 8 MiB.

The Files panel uses an explicitly selected host root. Uploads and downloads show progress and cancellation; replacement is an explicit choice. Transfers pass through the authenticated relay without server-side file storage. Partial downloads can use private browser storage on the viewing device, and explicit save/export creates a local copy there. This is intentional file transfer, separate from dashboard synchronization.

## Transport and quality

WebRTC carries video/audio where available. Quality presets include bandwidth saver, adaptive 1080p, and native resolution up to 4K; actual quality depends on host encoding, network conditions, and viewer support. Up to four viewers can share capture.

When WebRTC cannot connect, **Compatibility mode** sends acknowledged JPEG frames through HTTPS, capped at 1280 pixels and 8 fps, without audio. It is a usable fallback with a lower ceiling. A working fallback does not prove TURN or the high-quality media path works.

### TURN is an advanced, deployment-specific step

TURN helps WebRTC connect across restrictive networks. The current source hardcodes `turn.frostdev.io` in the TURN credential adapter/health check and provisions that same domain in `ops/turn-setup.sh`. **It is not a generic bring-your-own-host configuration switch.** Do not run the script unchanged for an unrelated domain.

For your own TURN deployment, adapt and review both the application adapter and provisioning/configuration for your hostname, then build/deploy that source. Provision DNS, a trusted TLS certificate, coturn, and firewall access for UDP/TCP 3478, TCP 5349, and the configured media relay range (the supplied script uses UDP 55000–55199).

The server supports `RIMEWARD_TURN_SECRET` or `RIMEWARD_TURN_SECRET_FILE` (default `/etc/rimeward/turn.secret`) for issuing short-lived credentials. Keep the file readable only by the necessary service identity; containers need an explicitly protected secret/file mount. Setting a secret alone does not provision DNS, certificates, or a working TURN server.

Verify a **forced-TURN allocation and media session**, not just a reachable TLS port. You can operate the web app and remote project tools without TURN; WebRTC direct connections and Compatibility mode have their own network-dependent behavior.

For exact implementation contracts and acceptance checks, see [Computer control](https://github.com/frostdev-ops/rimeward/blob/main/docs/computer-control.md). Platform implementations and synthetic tests do not guarantee every installed OS/compositor/network combination has been validated.
