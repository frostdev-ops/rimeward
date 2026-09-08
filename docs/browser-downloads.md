# Browser access and downloads

The reported Rime failure came from calling the legacy app CDP tunnel even when
the visible browser belonged to the standalone desktop runtime. Browser tools
now use the same authenticated runtime routing as the ward's controls and stream.
Explicit ward/page placement wins. An unplaced app browser binds to the desktop
opening it, or to its uniquely discovered active/profile-owning paired desktop.
That owner is retained when offline; ambiguous ownership returns an actionable error.

The browser's Downloads menu lists successful, pending and failed transfers, saves
a copy, removes retained files, and downloads the current file. Normal browser
downloads are captured automatically. Direct URLs, including inline PDFs, use
Chromium's credentialed network stack and existing proxy guard. Files are stored
privately on the browser's runtime and served only as attachments after ownership
checks. Limits: 25 MB per file, two minutes per transfer, one transfer per ward,
100 retained downloads. Renaming a ward preserves its downloads; removing it
removes them with its browser profile.

Rime lists downloads with `browser_downloads` (paginated), then imports one with
`browser_download`. The bytes are copied into the current conversation's attachment
store; a foreign runtime's numeric attachment ID is never reused. Existing
`read_document` and `search_document` inspect extracted text. `render_document_page`
sends a bounded PDF page image to the model for scans, diagrams and layout, using
the existing PDF renderer. Images remain tool observations through pending approvals
and replay. Very short PDFs keep their text, empty cached extractions are refreshed,
and PDF resources are released on failure as well as success.

Validation used isolated profiles, generated data and provider fixtures: the
built server's actual `browser_snapshot` reached the paired desktop browser through
the real relay; click/direct downloads, PDF import/text/page rendering, ownership,
private-address rejection, limits, lifecycle cleanup and the Downloads menu passed.
All 481 existing tests, typecheck, desktop lint, goldens and remote-workspace smoke
passed. The staged desktop checks, packaged Node 22.22.0 standalone smoke, and
packaged PDF text/page rendering also passed. No personal browser profiles were used for the probes and no live
model calls were made. Browserbase and legacy app CDP downloads were not exercised.

Both server and desktop need the new code, included in web 0.23.7 and desktop
0.5.7 alongside the remote project and Remote Desktop repairs. The supported
backup command includes retained browser downloads.
