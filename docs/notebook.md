# Notebook

Notepad edits one document. Notebook organizes those same documents into sections,
tags, pins, saved views and typed properties. A document can appear in a Notebook
and multiple Notepad wards without copying its content.

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

Ask retrieves up to eight notes using any-word FTS, falling back to recent notes
when no terms match. Context is bounded to 3,000 characters per note and 24,000 total.
One shared 60-per-hour model slot supplies a response through the ward's configured
provider. Sources open their documents. Repeated Enter while a request is pending
cannot submit duplicate calls. Ask is one question at a time, without a follow-up
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

## Completion validation

Validation uses throwaway data directories and authenticated browser fixtures.
No production user data or paid model calls are needed.

- Existing unit suite: 481 passing; TypeScript, production build and desktop lint pass.
- Storage probes cover both migrations, ownership, exact/alias resolution, atomic
  writes, FTS, links, typed properties, templates, manual purge and real Leyline
  execution. Regression checks include equal-revision conflicts, first upload,
  metadata timestamps, pairing link rewrites and emptying over 1,000 trashed notes.
- Browser walkthroughs cover properties, table/cards and saved views, Configure
  selection/clearing, wiki links/backlinks, template ink, Ask/sources, confirmed
  purge, cross-notebook navigation and failed/delayed saves and loads. Visual checks
  cover dark Lucide, light Phosphor, desktop, tablet, phone and reduced motion.
- `npm run goldens` regenerates the standard screens and runs the existing editor,
  terminal, conversation, permissions, remote desktop and browser checks.
- The remote workspace smoke harness runs independent desktop/server processes
  over HTTPS and pairing. Its Notebook extension verifies first upload, metadata,
  offline reads/writes, both content-conflict directions, stable conflict copies,
  concurrent purge and Ask through shared-model HTTP using a fixture response.

Signing, packaged-runtime validation, production relay health, installation and
installer publication belong to the coordinated Release Agent sequence. Fixture
model transport proves request routing; it does not claim a live provider response.
