# Rimeward media runtime sources and notices

This helper is distributed with GStreamer 1.28.6. Plugins load only from the
app-owned media directory. No system GStreamer installation is required.
`manifest.json` lists the included files and their SHA-256 hashes. `licenses/`
contains upstream license/copyright notices. No SDK interpreters or general
plugin search paths are enabled in the app.

- GStreamer 1.28.6 source releases: https://gstreamer.freedesktop.org/src/
- Release and checksummed platform packages: https://gstreamer.freedesktop.org/releases/1.28/
- Linux build recipes, including exact dependency source URLs and checksums:
  https://gitlab.freedesktop.org/gstreamer/cerbero/-/tree/59548269f4fd0f701818f0bafdb102959ec81e65
- GStreamer Rust WebRTC implementation 0.15.3 (MPL-2.0):
  https://crates.io/api/v1/crates/gst-plugin-webrtc/0.15.3/download
- GStreamer Rust RTP implementation 0.15.3 (MPL-2.0), including congestion control:
  https://crates.io/api/v1/crates/gst-plugin-rtp/0.15.3/download
- GStreamer Rust bindings (MIT OR Apache-2.0): the exact versions and registry
  archive checksums are in the included Cargo.lock. Source archives are available
  at `https://crates.io/api/v1/crates/<name>/<version>/download` for each registry
  package listed in that lockfile.
- PipeWire 1.4.9 (MIT), Linux client and GStreamer capture plugin:
  https://github.com/PipeWire/pipewire/tree/1.4.9
  Archive SHA-256: `8066a7b220069e4c6e3b02bd2b6ea303bba66df255023c07c99323449ba8fe3c`.
- ScreenCaptureKit Rust bindings 10.0.3 (MIT OR Apache-2.0):
  https://crates.io/api/v1/crates/screencapturekit/10.0.3/download

The GStreamer libraries remain separate dynamic libraries. Rimeward's helper
source and build recipe are `desktop/media-helper/` and `desktop/media-runtime.mjs`
in the corresponding Rimeward release source. The media helper owns no account
credentials, keychain data, project files or input authority.
