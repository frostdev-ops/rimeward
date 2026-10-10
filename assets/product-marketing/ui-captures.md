# Rimeward UI demonstrations

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
