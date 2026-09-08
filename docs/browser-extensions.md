# Browser extensions

Every browser ward has an **Extensions** button beside Downloads. Its packages
and enabled choices persist per ward on the browser's owning runtime, including
when controlling that runtime remotely. A new ward includes **Glaze for Blackboard
Ultra** enabled by default.

- **Install ZIP** accepts a Manifest V3 extension with `manifest.json` at the ZIP
  root. Uploads start disabled; the manager displays declared permissions and site
  matches. ZIPs are limited to 10 MB, 30 MB expanded, and 2,000 entries. Each ward
  can hold 20 extensions. Paths, duplicate filenames and public keys are checked.
- **Enable**, **Disable**, and **Remove** save the next session's configuration.
  **Restart browser to apply** applies it explicitly. Finish open forms first.
  Management remains available when an invalid extension prevents startup.
- **Settings** opens the extension's options page or toolbar popup as a browser
  tab. **Restore Glaze** puts a removed Glaze back in the list, disabled.
- Desktop and server Chromium support multiple enabled extensions. Browserbase's
  [session API](https://docs.browserbase.com/platform/browser/core-features/browser-extensions)
  accepts one uploaded extension per session. Disable its current extension before
  enabling another. The selected ZIP is uploaded using the account's Browserbase
  key and its provider ID is cached per credential and package.

This installs ZIP packages; it does not download Chrome Web Store listings or
manage regular Chrome/Edge profiles outside Rimeward. Extensions requesting
`proxy`, `nativeMessaging`, or `debugger` permissions are rejected so they cannot
bypass the browser's existing network/native execution boundary.

`src/lib/browser/extensions.ts` stores packages and an atomic registry under the
ward profile's `rimeward-extensions/`. Chromium owns local extension storage;
Browserbase also snapshots `chrome.storage.local` and `chrome.storage.sync` at
graceful shutdown and restores them when starting its next session. Other
extension databases remain subject to the provider's context persistence. Browser
ward deletion removes local packages with the rest of its profile; rekeying moves
them together. The older CDP tunnel copies enabled packages to its computer's
scoped profile through the authenticated `extensions:<ward>` stream, capped at
64 MB. It requires the updated desktop app.

The bundled Glaze 1.0.0 comes from the FrostDev `bb-frost` project under its MIT
license. Only extension runtime files, icons and LICENSE are included. A stable
public manifest key keeps its Chrome ID consistent across runtimes; a blank
`_rimeward_storage.html` page allows storage persistence without opening the UI.
The normal desktop prebuild already includes `assets/`, so no first-run download
is needed for Glaze. Updating the bundled snapshot is an explicit source change;
existing installations are not silently replaced.

Validation uses the existing browser session/UI and desktop checks. No production
Browserbase session or installed-app migration is implied by those local checks.
