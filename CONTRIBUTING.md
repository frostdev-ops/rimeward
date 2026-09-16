# Contributing

This guide is for working on Rimeward's source. To install and use the app, start with the [desktop-only](https://github.com/frostdev-ops/rimeward/wiki/Desktop-Setup) or [remote/web](https://github.com/frostdev-ops/rimeward/wiki/Remote-Web-Setup) wiki guide. User-guide sources are in `docs/wiki/`; update them alongside affected setup or behavior changes.

## Run it

```sh
npm ci
cp .env.example .env                         # PUBLIC_BASE_URL and TOKEN_ENC_KEY at least
node bin/rimeward.mjs users create you@example.com --admin
npm run dev:env                              # http://localhost:4321
npm test                                     # node --test tests/*.test.ts
npm run typecheck
```

Every test file seeds its own temporary data directory (`tests/_setup.ts`, imported first) and
runs under Node's native type stripping, which is why relative TypeScript imports carry their
`.ts` extension everywhere. Keep both.

## The words

User-facing copy says **ward**, **leyline**, **Rime**, **routine**, **packet**. Identifiers,
routes, tables and CSS classes keep their engineering names (`WardInstance`, logic edges,
`.wiring`). A new ward type is one `CATALOG` entry in `src/lib/wards.ts` (with its `concepts` and
`does`, which the add dialog's search and the tests need) plus one renderer in
`src/scripts/app/wards.ts`.

## Changes

- Keep changes focused. Preserve all existing tests and run the applicable checks; do not add test code unless the maintainer explicitly requests it.
- Nothing instance-specific in the tree: names, domains, addresses and the monitor list are
  settings, environment or `data/` (see `.env.example`, `src/lib/site.ts`, `src/lib/brand-files.ts`,
  the admin monitor registry).
- `npm run lint:desktop`, `npm test`, `npm run typecheck`, and `npm run build` green; the Tests workflow runs these on Linux and Windows for pushes to `main` and `dev/**`, and for pull requests. Keep the test glob double-quoted so Windows runs the suite. Desktop lint treats warnings as failures and covers the native launcher, runtime, APIs, editor/terminal UI, and development styles.

## Release branches

Prepare each release on `dev/<version>` (for example, `dev/1.0.14`), branched from
current `main`. Keep release changes there until validation is complete. Pushes
run Tests, the server tarball/image build, and desktop validation on macOS,
Windows, and Linux. Branch builds do not publish releases, container images, or
updater manifests; the desktop job builds native applications and Linux packages.

Before promotion, keep the package and desktop version files consistent, run the
applicable local checks, and wait for all three workflows to pass on the final
branch commit. Run the UI smoke checks for UI changes, then the remote workspace
smoke check; goldens are regenerated only on request. Review the release diff and merge into `main`; a
fast-forward keeps the validated commit intact. If integrating newer `main`
changes alters the release, validate the resulting branch commit again.

After `main` CI passes, deploy from its clean committed revision and create the
matching `v<version>` server and `desktop-v<version>` desktop tags when publishing
those distributions. Tag workflows verify that the version matches and the
commit belongs to `main`. Desktop installers remain a draft until every platform
passes and the release is published. Never move a published tag. Delete only the
merged release branch after promotion is complete.

## Desktop and remote workspaces

`npm run desktop:build` stages the pinned Node runtime, Chromium, application assets, and
native dependencies before Tauri builds. Build on the target platform; do not copy another
Node version's `better-sqlite3` or `node-pty` binaries into the payload. The desktop process
owns `workspaces.db`, recovery, PTYs, and agent tasks. The ordinary server must reject native
execution. Shared Rime files/history use the separate, account-scoped sync journal;
project files and native process state never enter it. Keep relay/sync paths free of payload logging
and persistent caching. See [the runtime contract and checks](docs/development-workspaces.md).

Rust 1.98.0 is pinned in `rust-toolchain.toml` and the release workflow so local and CI
diagnostics agree. The Tauri CLI is a pinned development dependency, excluded from the
bundled backend. After staging, run `npm run desktop:check`: Biome, Rust formatting, Clippy with warnings
as errors, and native unit tests. Desktop release Actions run this on each target; the release remains a draft until every platform succeeds. On macOS,
`desktop/sign-runtime.mjs` signs and verifies bundled Chromium and native binaries before
Tauri signs/notarizes the outer app. Build intermediates and other platforms' PTY prebuilds
are excluded. macOS copies the runtime as a whole directory to preserve signed framework
links. Linux builds DEB and AppImage packages; RPM is excluded because its packager stalls
on the bundled runtime, even with Zstandard compression. `desktop/entitlements.plist`
supplies the Node/Chromium JIT entitlements. Manual release dispatches must select the
version's existing tag; every build verifies that tag against its checked-out commit.
DMGs use Tauri's CI mode to avoid opening Finder during packaging; they retain the
application and Applications link without customized icon positioning.

Install-script permissions are pinned in `package.json` for native dependencies. The SDK's
network-based model-type freshness check is disabled; models are discovered at runtime.
The current `just-bash` dependency emits Node's experimental `stripTypeScriptTypes` notice
when its JavaScript worker starts under Node 22. Its optional compression dependency also
uses the deprecated `prebuild-install` package. Node 22 also marks the built-in mock timers
used by Discord tests as experimental. macOS 27 also reports deprecated `hdiutil` commands
in Tauri's DMG packager; those commands still work. Verbose AppImage builds report
linuxdeploy's library copyright-discovery and optional AppStream metadata warnings,
alongside skipped stripping/rpath changes and existing AppRun notices. These come from
the upstream packagers. WiX also emits ICE03/40/57/60/61 validation warnings from its
generated MSI template and bundled binary metadata. These remain outside the
application's lint and compiler checks and are not suppressed. The pinned node-pty version
can also report `AttachConsole failed` from its Windows console-list helper after a process
has exited; its parent uses the existing fallback and releases the PTY worker.

After a web build, run `npm run test:ui` with the staged Chromium available. These checks
exercise real editor/PTY behavior, shared-client control, recovery, and isolated HTTPS
handoff. Conversation provider responses and native desktop UI operations are test adapters;
they do not authorize model calls or validate OS webviews. `npm run test:standalone` checks
the staged app with its bundled Node. Actual macOS, Windows, and Linux release behavior still
needs platform validation.

New UI controls use `icon()` or `<Icon>` with a semantic ID from `src/lib/icon-names.ts`.
Register the ID in every icon set. Keep user-authored emoji as content. CodeMirror's native
folding and diagnostic controls use the same theme contract. Preserve keyboard access,
reduced motion, editor recovery, and explicit terminal input ownership.

Terminal input and event sharing live in `terminal-input.ts` and `terminal-stream.ts` and
are included in desktop lint. Keep snapshot recovery independent of output activity, never
retry uncertain input, and drain xterm's parser before persisting a shutdown snapshot.
`terminal-input.test.ts`, `terminal-shutdown.test.ts`, and the terminal UI smoke cover these
contracts. Rime input authority is separate from the CLI's next-launch permission policy.

## Screenshots and release documentation

`npm run goldens` regenerates every image in `docs/goldens` from disposable users, projects,
and synthetic conversation data. It builds the app, captures the original dashboard screens,
and runs the editor, terminal, and conversation UI checks for desktop/phone screenshots.
It needs Chromium (`npx playwright-core install chromium` or `desktop/prebuild.mjs`) and
uses software rendering. Review every generated image before committing it. Goldens are
documentation screenshots, not pixel-diff assertions, and are regenerated only on request,
never as part of validating a UI change.

Update README, this guide, the security boundaries, and the workspace guide together when
changing setup or ownership. `docs/pages-spec.md` records the page model and its workspace
extension. Keep private deployment instructions (`AGENTS.md`, `CLAUDE.md`, local deployment
scripts) out of the public repository.


Workspace navigation changes must pass `node --test tests/workspace-navigation.test.ts`
and the built `node tests/remote-workspace-smoke.mjs` handoff test. The latter exercises
the real workspace picker on desktop and phone, a native-command adapter, page continuity,
terminal and buffer identity across navigation, offline recovery, and exclusion of desktop
content from server files/logs. Native command permissions and origin checks also require
`npm run desktop:check`; use a separate app identifier/data directory for interactive native
previews so testing cannot take over an existing runtime's database or terminal processes.
