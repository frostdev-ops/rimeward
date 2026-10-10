# Product UI demonstrations

## Crosspane Settings

Captured on 2026-10-10 from Crosspane source `ce3dee9` with its built-in native
demo/screenshot export: `CROSSPANE_UI_SCREENSHOT=… CROSSPANE_UI_TAB=layout`
(then `windows`) and `cargo run --locked --release -p crosspane-ui`.
Screenshot mode uses the app's demo model with no worker, agent socket or DNS.
No machine was paired, controlled or projected, and no privacy or driver settings
were changed. The screenshots use Crosspane's own renderer and demo fixtures.

`crosspane-settings.webp` and `crosspane-windows.webp` are unchanged 2200 × 1520
native pixels from the app's 1100 × 760 window at 2× scale, encoded as WebP.
The marketing animation adds illustrative pointer and window motion over these
captures. It does not record or perform a live cross-machine session. Full-size
captures remain available for inspecting the actual controls.

## Rimewire board

Captured on 2026-10-10 from Rimewire source `93c6f7a`, using its actual board
server, styles and client renderer with a disposable local demo checkout. The
tracker contains three sample packages for a website refresh. The real CLI
posts notes, 70% progress, a blocked download link, unblock and explicit ready
updates to that checkout's ignored journal. These package IDs and updates were
never posted to a real project board.

The three `rimewire-board-{plan,progress,ready}.webp` images are 1280 × 720 and
show the resulting board states in the default browser viewport. Matching
`-phone` images use the real responsive layout at a 390 × 844 viewport, cropped
to the work-package area: plan 358 × 430, progress 358 × 546 and ready 358 × 404.
Roadmap and the duplicate In flight section are collapsed through their normal
controls; the completed package section is expanded. These crops preserve
genuine browser pixels and keep the package labels readable at narrow widths.
No production account, project data, model or external agent call is included.
The marketing page's replay changes local visual states; it does not write a
journal or control an agent.

## Rimeward

Captured from the current built Rimeward application in an isolated local desktop
runtime on 2026-10-09 (America/New_York). The profile, Orbital project, notes, and notebook were created
from scratch for these images. They contain no production account or project data.

| Image | Intrinsic size | What it shows |
| --- | --- | --- |
| `public/projects/rimeward-editor.webp` | 1248 × 660 | The real editor and Rime wards side by side, with a seeded TypeScript workspace contract. |
| `public/projects/rimeward-chat.webp` | 1088 × 900 | The real expanded Rime interface with a synthetic Orbital conversation and tool timeline. |
| `public/projects/rimeward-notes.webp` | 1248 × 772 | Real notepad, notebook, focus timer, and button wards using curated demo content. |
| `public/projects/rimeward-phone.webp` | 390 × 844 | The real expanded editor at a phone viewport, after taking editing ownership through its normal control. |

Desktop captures use a 1440 × 1000 browser viewport and crop the actual UI elements
for readability. The phone capture uses a 390 × 844 touch viewport. Screenshots are
unchanged browser pixels, converted to WebP for the public page.

The conversation, tool results, timings, and context indicator are demonstration
data supplied through the existing agent response contract. They are not evidence
of a model run, measured tool performance, or a connected provider. No model calls
were made. Workspace operations and note storage use the actual local backend;
the disposable runtime and profile were removed after capture.

Recommended caption: **Current Rimeward interface with seeded demo content.**

The marketing page's animated ward example uses these same captures, cropped by
CSS inside illustrative ward frames. Its step labels, connection and playback
are a local explanation of **Button pressed → Ask Rime**, not a recorded model
run. Icons come from Rimeward's semantic catalogue and its `rime-agent.svg`.

## Phone reply detail

`public/projects/rimeward-reply-phone.webp` is a **346 × 343** crop of the actual
responsive Rime assistant reply body at a **375 × 1100** touch viewport. Paragraph
text renders at **15.04 CSS pixels** before capture. It uses the same seeded
Orbital reply as the expanded desktop chat image, without composer, controls,
or surrounding chrome. The image is an unchanged browser-element screenshot,
converted to WebP; it was not resized or reconstructed. A separate disposable
runtime/profile was removed after capture, and no model calls were made.
