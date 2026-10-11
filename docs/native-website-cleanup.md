# Native website cleanup: 1.0.20

The public Frostdev website belongs to `frostdev-ops/frostdev.io`, with a static
build, Website workflow and separate deployment. Rimeward contains the desktop
app and authenticated server; it does not import files from the website checkout.

## App entry and shared contracts

The native server root redirects signed-in requests to `/dash`. Middleware sends
fresh servers to `/setup` and signed-out browsers to `/login`. Desktop startup
still redeems `/api/native/bootstrap` once and enters `/desktop/start`, preserving
onboarding and restored navigation. Login, setup, recovery, registration and
desktop onboarding retain ValleyLayout, native valley terrain/shaders, frost palette,
semantic icons, Rimeward brand assets and installation-local brand helpers.

The marketing root, `/rimeward`, `/crosspane`, `/rimewire`, MarketingLayout, three
marketing demos, products CSS, unused public splash renderer/entry/overlay CSS, `public/projects`, `public/ads.txt`, website-only
master art, marketing screenshots and `docs/public-pages.md` are removed.
All existing tests and `docs/goldens` remain. The screenshot capture instruction
now targets `/login?still=1` for the welcome/valley capture; no goldens are generated
or inspected during this cleanup.

Native API, authentication, OAuth origins, server identity and nginx relay/static
include remain independent of this source removal. Public links to the separate
website remain valid. Native terrain constants and unchanged shaders live under
`src/scripts/valley`, used by forms and the existing performance benchmark.

## Release ordering

`dev/1.0.20` starts from refreshed `origin/main` at `5ae7ea0`. The preceding
`dev/1.0.19` Lens candidate is still unmerged and is preserved. This cleanup must
not publish ahead of it. Before promotion, integrate the final previous release,
remove any restored marketing/guide source and repeat local and final-commit CI
validation. Its later guides, privacy and crawler routes are absent from this
base; they must remain absent after that integration. Review middleware's exact
public-page bypass and website metadata again when resolving that integration.

Required final native workflows are Tests, Rimeward server and Rimeward desktop.
A draft PR is reviewable preparation, not authorization to merge/tag/deploy/install.

## Artwork migration

The primary `dev/1.0.19` checkout still owns local, untracked website artwork.
Preserve it while migrating the website masters into the website repository:

- `assets/frostdev-blender/`: Blender masters, backups, previews, icons, wordmarks
  and animation renders, including the tracked condensing sources.
- `assets/frostdev-directions/`, `assets/frostdev-v2-styles/` and
  `assets/frostdev-icon-v2.png`: previous tracked design masters.
- `assets/product-marketing/`: provenance and local `rimeward-flow.png`.
- `docs/screenshots/`: Frostdev hub/art directions and product marketing captures,
  including local brand/carousel captures; keep native `agent-thinking-dropdown.png`.
- Local `public/projects/frostdev-icon.webp`, `frostdev-wordmark.webp` and
  `frostdev-wordmark-animated.webp`.
- Local `tmp/marketing-demo-20261009/` and `tmp/marketing-review-20261009/`.

No primary artwork or profile data is deleted by this worktree. Master migration
must be confirmed before the eventual release replaces tracked source in primary.
