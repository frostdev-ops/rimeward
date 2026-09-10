# Notebook

Notepad edits one document. Notebook organizes those same documents into sections,
tags, pins, saved views and typed properties. A document can appear in a Notebook
and multiple Notepad wards without copying its content.

In dashboard edit mode, drag a Notepad onto the center of a Notebook to show
the “Move to notebook” target. Dropping removes the standalone card from the draft;
Done saves its document membership and the layout together. Undo restores the card
before saving, and Cancel discards the move. The notebook sidebar's add action
still includes a document while keeping its Notepad card on the dashboard.

## Documents and storage

Migration `025_notebooks.sql` adds notebooks and document metadata; migration
`026_notebook_v2.sql` adds property schemas, template flags and backlinks.
`notes.ward` is the document id. Existing Notepads retain their original ids and
pre-store `config.text` seed. A Notepad's `config.note` can select another document;
`config.notebook` lets Notebook wards share a notebook.

`src/lib/note.ts` owns content writes and `src/lib/notebook.ts` owns organization.
Every query is scoped to the user. HTML is rebuilt through the sanitizer in
`note-text.ts`; FTS5 indexes sanitized text, titles and tags. Ink becomes searchable
only after transcription. Content, revision, FTS and backlink changes are atomic.

Content writes accept `rev` and `etag`. The content hash catches divergent edits
from two runtimes that happen to have the same revision number. A stale save
returns 409 with the current document; an explicit `force` accepts an overwrite.
Metadata changes advance the sync timestamp without changing the content revision.

Archive and trash retain documents. Removing a section unfiles its notes;
removing a ward leaves its document intact. Delete forever and Empty trash require
confirmation and refuse active notes. Purge removes content, FTS and links and
records a sync tombstone immediately, including for notes not yet uploaded.
A surviving Notepad ward cannot silently recreate a purged document.

## Editor and navigation

Both ward types use `createNoteEditor` from `src/scripts/app/note.ts`. HTML and ink
saves serialize against a captured document target. Switching, closing, navigation
and recovery wait for pending saves. Failed writes retain drafts; a conflict offers
Reload and Keep mine. Failed reloads retain the draft, and late reads cannot replace
text typed since the request began.

Notepad requests bind to the exact document id with `?ward=<host>`, so a Configure
preview or in-flight layout save cannot redirect content into another document.
The legacy `/api/note/<ward>` alias remains available to existing callers. The host
ward supplies the model settings. The Document selector loads `/api/notes`; choosing
another document switches the shared editor, and choosing This notepad's own clears
the link. A failed selector load preserves the saved link.

Notebook provides list, table and card layouts, sorting, grouping, search snippets,
paging, keyboard selection, manual ordering and saved views. The generated Index
can open notes beyond the first page. Title, tags, section and property controls
keep focused drafts and open selectors during refresh. A failure in one field
continues to block navigation after another field saves successfully.

Desktop shows navigation, listing and editor. Tablet widths retain navigation and
switch between listing and editor; phones show one pane at a time. Table and card
layouts receive more horizontal space on desktop. All chrome icons use semantic
`icon()` / `<Icon>` ids, including checkbox values. Controls, selections, cards,
menus and the link picker use the app's theme tokens. Entrances and state changes
use the existing easing/keyframes; reduced motion disables movement and smooth
heading scrolling. Inputs keep readable mobile sizing and keyboard focus rings.

## Page types and document editing

New page offers Document, Markdown, Spreadsheet, Slides and Drawing. Each engine
uses the same document id, revisions, conflict handling, backups and sync. Its
validated JSON state and searchable text are stored together in one sanitized
HTML wrapper; ordinary text writers cannot append outside that wrapper or replace
the page type without explicit conversion. The shared document limit is 16 MiB.
Enhanced formats stay local when paired with an older server; format negotiation
prevents older sanitizers from stripping page state or rich formatting.

- Markdown uses the GFM parser and CodeMirror source/preview editing, with syntax
  highlighting, fenced-language support, slash snippets, completion, search,
  Markdown import/export and grammar suggestions. Switching between Document and
  Markdown is explicit because their formatting capabilities differ.
- Spreadsheet provides one sheet up to 200 rows by 52 columns, cell/range selection,
  keyboard editing, safe formulas with references/ranges and common functions,
  number/currency/percentage formats, styling, structural edits, sizing, undo/redo,
  TSV clipboard and CSV import/export. It does not provide XLSX or cross-sheet formulas.
- Slides provides layouts, slide ordering, editable text/shapes/raster images,
  positioning/sizing/layers, speaker notes, presentation mode, undo/redo and SVG,
  JSON and standalone HTML export. The HTML presentation supports browser print/PDF;
  PPTX is not supported. Limits are 100 slides and 200 objects per slide.
- Drawing provides flowchart shapes, text, bar/line/pie charts, anchored straight
  and elbow connectors/arrows, selection and sizing, styles, alignment/layers,
  grid/snapping, zoom/pan, undo/redo and JSON/SVG export. JSON import is supported;
  draw.io XML and obstacle-avoiding routing are not. Limits are 500 shapes and
  1,000 connectors.

Document tools add fonts, sizes, colors, highlighting, paragraph alignment,
line spacing and before/after spacing, indentation, tables, raster images,
find/replace, page setup, headers/footers and page-number fields. Comments persist
on their selected passages. Track changes records inserted/deleted text, including
paste and IME, with accept/reject actions; formatting and layout changes apply
directly. Page breaks are explicit, with browser/Word pagination on export.

DOCX import/export uses real OOXML packages and retains supported runs, headings,
lists, merged tables, raster images, margins, headers/footers, page fields, comments
and tracked text changes. Import reports unsupported features rather than silently
claiming exact Word fidelity. Embedded files are bounded; external images are not
fetched. This is a practical document editor, not complete Microsoft Word parity.

Grammar review uses the page's configured Rime model. Clear errors receive red
underlines and optional style suggestions yellow underlines, with right-click
replacements and a suggestion list. Native spelling/autocorrect remains available;
agent autocorrect applies only high-confidence spelling replacements. Live grammar
is opt-in, stale responses are discarded, and deleted text/code are excluded from
Document review. Markdown offers syntax-aware editing and explicit grammar review.

## Properties, links and templates

Each notebook has up to 20 properties: text, number, date, choice or checkbox.
Dates must be real calendar dates; boolean filters distinguish JSON booleans from
text such as "true". Values appear in the editor header and table columns. Equality
filters can be saved with a view. Removing a property removes its values and saved
filters. Table cells open the shared editor; they are not separately editable.

Typing `[[` opens the note selector at the caret. Selecting a note inserts
`<a data-note="id">Title</a>`; the sanitizer preserves that attribute without a URL.
Each save rebuilds `note_links`. Linked from chips navigate to their source, including
another notebook or an unfiled document with no dashboard ward. Renames retain the
original link label while the id continues to resolve.

Templates are ordinary notes with a flag, excluded from normal lists, counts,
search, Index and Q&A. The Templates navigation shows them; New note offers them
as starting points. A copy includes text, ink, tags and properties, with explicit
values taking precedence. A trashed template cannot seed a new note.

## Leylines and Q&A

Notebook triggers are `note-created`, `note-saved`, `note-tagged` and `note-moved`.
Saved events debounce for 60 seconds and read the current document, notebook,
section and tags when fired. Templates and trashed notes do not fire these events;
sync installs do not replay them. Tag and section filters apply to their respective
triggers. Variables include `note.id`, `title`, `text`, `section`, `tags`, `tag` and
`notebook`; text is capped at 4,000 characters. The loop guard allows 120 note-event
firings per user per hour.

Actions are `note.create`, `note.append`, `note.set`, `note.trash` and `note.attach`.
Title lookup accepts an exact title, a unique prefix or an id. `note.attach` searches
the notebook and adds matches to the flow packet for a following `agent.ask`; it
does not attach content to a Notion page.

Ask offers Automatic, All notes and Matching notes. Automatic summaries use every
active non-template note rather than searching for the word "summarize". Large
notebooks are read in bounded batches and their findings combined, with coverage
and all selected sources shown. Matching mode uses up to eight FTS matches with
bounded excerpts. The hourly model budget is checked before a multi-call summary;
each call uses the shared 60-per-hour window and the ward's configured provider.
Ask waits for pending document saves. Sources open their documents, and repeated
Enter while a request is pending cannot submit duplicate calls. Ask is one question at a time, without a follow-up
conversation. Agent tools expose listing, search, CRUD, backlinks, purge and Ask;
permanent purge is confirmation gated.

## Sync and pairing

`note-sync.ts` contributes `note/<id>` and `notebook/<id>` to the existing Rime sync.
Notes are served by each runtime's local database, including while the connected
server is unavailable. Native project roots and workspace databases are not part
of this replication.

The first upload does not invent an absent remote tombstone. Concurrent note edits
use the newer update timestamp and retain the loser as a stable conflict copy in
the same notebook. Long titles retain the conflict suffix. A deliberate local purge
wins over a concurrent remote edit; remote tombstones also propagate. Notebook
schema/section/view conflicts use the generic server-wins policy and retain the
losing record in `agent_sync_conflicts`.

Installs sanitize HTML, rebuild FTS/backlinks and notify every surface of the change,
even when the two content revisions are equal. Moving a document refreshes both
notebooks. Pairing rekeys document/notebook ids, membership, stored `data-note`
links and backlink rows together, and drops stale sync records/baselines.

## Local build verification

For this expansion the user requested compilation and a combined local build,
with no tests, browser probes or golden regeneration. The prior notebook checks
remain in the repository. Visual behavior, document round trips and interactions
are reserved for the user's manual testing of the local app.

The build owner waits for the terminal-permission and pop-out-window tasks before
snapshotting the shared checkout. Production deployment and installer publication
are separate from this local build.
