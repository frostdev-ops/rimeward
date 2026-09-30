# Public pages

`/` is the Frostdev project hub. `/rimeward` introduces Rimeward and links to the latest desktop release and existing sign-in flow. Both pages are public and indexable; private routes keep their existing authentication gates.

The pages share `src/layouts/MarketingLayout.astro` and the existing splash landscape. Artwork lives in `public/projects/`:

- `frostdev.webp` and `frostdev-favicon.png`: existing public Frostdev assets from `https://frostdev.io/brand/wordmark` and `/brand/favicon`.
- `frostsim.webp`: optimized copy of `public/brand/frostsim-logo-web.png` in `frostdev-ops/frostsim`.
- `loothing.webp`: optimized copy of `logo.webp` from the `master` branch of `frostdev-ops/loothing` on GitHub.
- `rimeward-workspace.webp`: optimized copy of this repository's `docs/browser-workspace-split.png`, showing demonstration pages.

Rimeward's vector marks are imported from `assets/`. Instance branding continues to apply to sign-in and setup; these marketing pages use their own artwork and copy.

Desktop and phone previews are saved in `docs/screenshots/frostdev-hub-*.jpg` and `docs/screenshots/rimeward-marketing-*.jpg`. They are browser captures of the built pages, separate from the unchanged golden screenshots.
