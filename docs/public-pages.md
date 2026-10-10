# Public pages

`/` is the Frostdev project hub. `/rimeward` introduces Rimeward and links to the latest desktop release and existing sign-in flow. Both pages are public and indexable; private routes keep their existing authentication gates.

The hub showcases Rimeward, Frostsim, Loothing, Crosspane, and Rimewire in an 80-second carousel. Desktop shows three flat cards with continuous horizontal movement and soft fades at the edges; widths up to 760px use vertical rotation. Drag horizontally on desktop or swipe vertically on mobile to spin, with gentle momentum on release. Taps and clicks still open project links; a drag does not. Arrow keys browse and Space pauses/resumes, with no visible control buttons. Hovering, keyboard focus, and a hidden tab pause automatic motion. Mobile vertical gestures inside the carousel spin it; gestures outside retain page scrolling and pinch zoom stays available. Focusing a project brings it into view. The desktop row repeats for a seamless loop, with duplicate links excluded from keyboard navigation and screen readers. Reduced motion or unavailable JavaScript leaves all five links in a static grid. Crosspane and Rimewire link to their public repositories.

The pages share `src/layouts/MarketingLayout.astro` and the existing splash landscape. Artwork lives in `public/projects/`:

- `frostdev-icon-crystal.webp`: the user's revised Blender snowflake/crystal icon in the shared marketing header, optimized from `assets/frostdev-blender/condensing-v2-icon.png`.
- `frostdev-wordmark-crystal-animated.webp`: the transparent six-second, 60 fps Blender wordmark loop in the homepage hero. The matching `frostdev-wordmark-crystal.webp` still, optimized from `assets/frostdev-blender/condensing-v2-wordmark.png`, is selected through a picture source for reduced motion and while the carousel is paused or the tab is hidden. Both are 1600×560; the animation retains the original page background and adds no video controls or JavaScript animation driver.
- `frostdev.webp`, `frostdev-favicon.png`, and `frostdev-icon-v2.webp`: retained earlier Frostdev assets; the existing favicon remains in use. The old FD header master is `assets/frostdev-icon-v2.png`.
- `frostsim.webp`: optimized copy of `public/brand/frostsim-logo-web.png` in `frostdev-ops/frostsim`.
- `loothing.webp`: optimized copy of `logo.webp` from the `master` branch of `frostdev-ops/loothing` on GitHub.
- `crosspane.webp`: optimized copy of `assets/brand/crosspane-banner-logo.png` in `frostdev-ops/crosspane`.
- `rimewire.webp`: optimized copy of `assets/brand/rimewire-banner.png` in `frostdev-ops/rimewire`.
- `rimeward-workspace.webp`: optimized copy of this repository's `docs/browser-workspace-split.png`, showing demonstration pages.

Rimeward's vector marks are imported from `assets/`. Instance branding continues to apply to sign-in and setup; these marketing pages use their own artwork and copy.

Desktop and phone previews are saved in `docs/screenshots/frostdev-hub-*.jpg` and `docs/screenshots/rimeward-marketing-*.jpg`. They are browser captures of the built pages, separate from the unchanged golden screenshots.

## Wordmark art directions

These earlier transparent PNG drafts were generated with the built-in imagegen tool from the FD icon. They were superseded by the approved Blender artwork below and are not used on the homepage. The comparison is `docs/screenshots/frostdev-art-directions.html`, with a rendered preview in `frostdev-art-directions.jpg`.

- A, Faceted: `assets/frostdev-directions/faceted.png`, extending the folded geometry across the word.
- B, Balanced: `assets/frostdev-directions/balanced.png`, signature F/D with quieter companion letters.
- C, Mixed case: `assets/frostdev-directions/mixed-case.png`, uppercase F/D anchoring `FrostDev`.

<details>
<summary>Built-in imagegen prompt set</summary>

### Approved header icon

Use case: logo-brand. Asset type: production transparent standalone Frostdev header icon. Input image: reference for the exact brand identity and monogram. Create the standalone icon version of the geometric interlocking F/D frost monogram at the LEFT of the reference logo. Preserve that exact cyan and ice-white silhouette, negative-space structure, facet geometry and restrained premium bevels. Remove every letter of the wordmark and all other content; output only this one monogram, centered upright on a square transparent canvas, large and clear with modest balanced clear space. It must match the reference as a paired asset and remain recognizable at 40 pixels. Very crisp clean silhouette and alpha edges, no stray pixels, no background, no badge, no mockup, no text, no added ornaments, no watermark. Genuine transparency.

### A — Faceted

Use case: logo-brand. Create a Frostdev WORDMARK direction from the supplied approved FD icon. Exact text: FROSTDEV, eight letters in order F R O S T D E V. Keep the approved F and D shapes and their cyan/ice-white folded, faceted material identity. Use that F as the FIRST letter and that D as the SIXTH letter of the actual word. The reference monogram must participate in the spelling; do not add an extra standalone FD badge before ordinary FROSTDEV text. Separate and adapt the F/D glyphs only as needed for readable letter spacing, while preserving their distinctive angular silhouettes and original finish. The remaining R O S T E V should branch naturally from those two approved letters. Aim between generic plain typography and an over-stylized game logo: premium, restrained, custom-made, highly legible. Modest dimension, crisp solid letter faces, controlled cyan accents, immaculate clean edges. No distressed texture, scratches, speckles, holes or chipped letter faces; only intentional letter counters. Straight-on horizontal composition, one word, genuine transparent background, balanced clear space. No ribbons spanning the whole word, no flourish, no glow, no badge, no extra text, no mockup, no watermark. Direction A: balanced contemporary proportions. The approved faceted F and D are the signature letters; ROSTEV have calm medium-bold geometric shapes with a few matching chamfered cuts and restrained shallow facets. Careful open optical spacing. A cohesive, sophisticated studio wordmark with enough character to feel designed, without extra ornament.

### B — Balanced

Use case: logo-brand. Edit the supplied FROSTDEV wordmark into a genuinely different, balanced art direction. Preserve the FIRST F and SIXTH D letterforms with their original cyan/ice-white angular folded shapes and faceted finish. Those two letters are the signature anchors. Change ONLY their companion R O S T E V into clean ice-white contemporary geometric letterforms with small matching diagonal corner cuts, flat solid faces and only the faintest cyan side edge. The other six letters must be visibly calmer and less three-dimensional than the preserved F and D. Keep equal cap height, balanced medium-bold stroke weight, comfortable optical spacing and the exact spelling FROSTDEV. No extra FD badge, no separate icon, no ornamental ligatures, no glow, no texture or distressed holes. Let the two approved signature letters carry the identity while the companion typography gives it space. Professional, restrained, coherent. Transparent background, horizontal composition, crisp clean alpha edges, no extra text or mockup.

### C — Mixed case

Use case: logo-brand. Create a distinct mixed-case Frostdev wordmark using the supplied approved FD as the anchor. Exact text: FrostDev, with uppercase F and D, lowercase rost and ev, eight letters in that order. Preserve the approved F and D shapes and their original cyan/ice-white folded, faceted finish as the actual uppercase F and D inside the spelling. Do not put an extra FD icon before ordinary text. Design the lowercase rost and ev as clean custom ice-white geometric forms, more approachable and quieter than the F/D anchors, with a few matching angular cuts and restrained cyan accents. Generous clear counters and carefully balanced optical spacing; no flourishes, no connecting ribbon or elaborate ligature, no glow, no texture, no distressed holes. Maintain the sculptural approved FD identity while exploring a calmer contemporary mixed-case studio brand. Straight-on, transparent background, one word only, high-quality clean edges, no badge, mockup, tagline or watermark.

### Mixed-case spelling correction

Use case: precise-object-edit / logo-brand. Edit this mixed-case logo. Change ONLY the sixth letter, the uppercase D after 'Frost'. The current sixth position mistakenly repeats an FD monogram, so there is an unwanted EXTRA F on top of the D. REMOVE that extra F completely. At the sixth position draw ONLY a freestanding uppercase D: straight left stem, chamfered right bowl, open counter, with the same ice-white/cyan faceted finish. The D must be one readable D with no F top bar or middle bar anywhere in it. Exact final spelling 'FrostDev', eight letters F r o s t D e v, one word. Preserve the existing FIRST F exactly and preserve the lowercase r o s t e v exactly; keep their spacing and coloring. Maintain the approved original faceted cyan/white FD visual style, but only one F in the whole word. No extra badge or extra letters. Transparent background and crisp clean edges.

</details>

## Blender logo exploration

`assets/frostdev-blender/frostdev-condensing-flow-v2.blend` is the user's revised editable source. A softly rounded navy hexagonal backplate supports the cyan snowflake. The Rimeward flake reference informs six straight stems with three paired fork tiers: the longest fork sits closest to the cube, and the upper forks become progressively shorter. The stems and forks have stronger, consistent widths without flared bases. A narrow raised glacier accent follows the branches, cube rim and three inner spokes with consistent spacing. The revision adds a faceted translucent crystal, ordered wire connections, luminous reactor core and supporting cradle inside the cube. The shared cyan/glacier/navy app palette and lowercase wordmark remain. Earlier sources, including `frostdev-condensing-flow.blend`, are preserved.

The six-second, 60 fps loop keeps the outer silhouette and lettering fixed. Broad sheen waves move inward over the branches and condense into tokens at the network entries, then follow the connections into the luminous crystal core. The current v2 scene, including its crystal and reactor animation, is rendered through the live Blender MCP at a native transparent 720×720 emblem crop. Frames 1–360 are composited with the matching static typography and encoded as an animated WebP at 1600×560. Rendered frames 1 and 361 are pixel-identical. The static 16-bit `condensing-v2-wordmark.png` (3200×1120) and `condensing-v2-icon.png` (2048×2048) supply the still and header assets. The user's camera, frame and render settings are restored after export; their Blender source is not overwritten.

The revised icon and animated wordmark are integrated into the homepage.

## Revised logo style variations

`assets/frostdev-v2-styles/` contains transparent PNG alternatives generated with the built-in imagegen tool from the revised Blender exports: abstract, high-detail, photorealistic, drawn, and a minimalist emblem without text. The exact prompts and reference roles are saved in `prompts.md` alongside the unchanged output files. These are exploratory alternatives; the homepage continues to use the revised Blender artwork.
