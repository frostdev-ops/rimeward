# Linked Notion databases in notebook sheets

Status: feasibility investigation, September 10, 2026. Not implemented. Research
used source inspection and official documentation; no account data, Notion writes,
model calls, tests or browser probes were used.

## Recommendation

Add a **Linked Notion database** page to notebooks. Notion remains authoritative;
the notebook stores the connection/workspace identity, database/data-source/view
IDs, and local presentation preferences. Users edit the original rows through
existing authenticated Notion routes. Do not convert the database to CSV or store
an independently editable copy in an ordinary spreadsheet page.

The existing spreadsheet stores positional A1 cells with one string value and a
local formula evaluator, with a 200-row/52-column limit. That model cannot preserve
Notion identities, rich values, server-computed properties or large databases.
Reuse its grid interactions where useful, and reuse existing Notion cell renderers
and editors. Introduce a distinct versioned linked-page contract.

## Fidelity target

Preserve supported API values, stable identities, schema, rich text, and exposed
table-view settings. Preserve unrecognized fields unchanged and mark unsupported
editing explicitly. Do not promise every Notion feature or pixel-identical UI.

Notion's current Views API exposes saved views, including filters, sorts,
visibility, widths, wrapping, frozen columns, grouping and display configuration.
It requires API version 2025-09-03 or later; our current 2026-03-11 header qualifies.
The older architecture note that view definitions are unavailable is outdated.
[Official views guide](https://developers.notion.com/guides/data-apis/working-with-views)

| Feature | Required behavior |
| --- | --- |
| Title/rich text | Preserve runs, annotations, colors, links, mentions and equations; edit supported spans without flattening the whole value. |
| Numbers, checkbox, URL, email, phone | Typed cells; preserve null, empty and zero distinctly; respect schema number formatting. |
| Dates | Preserve date/time, range, timezone and display settings. |
| Select/multi-select/status | Use option IDs and colored chips. Preserve schema identity during edits. |
| People | Keep user IDs and permitted user metadata; never resolve identity from a display name alone. |
| Relations | Use page IDs and source-aware pickers. Load every relation item before replacing an array. |
| Formulas | Keep the expression in Notion schema; show Notion's computed result. Do not translate into the local A1 evaluator. |
| Rollups | Keep relation/property IDs and aggregation. Treat results as read-only and preserve incomplete/unsupported states. |
| Files | Retain hosted/external/upload variants and untouched files when replacing an array. Refresh expiring URLs. |
| Page icons/covers | Keep typed page chrome separately from property columns. |
| Views | Load actual Notion view queries and settings. Shared-view edits must be clearly distinguished from local layout preferences. |
| Created/edited fields, unique IDs | Display authoritative read-only values. |
| Unknown properties | Preserve raw values and show a protected unsupported cell; never turn them into empty editable text. |

Relevant contracts: [rich text](https://developers.notion.com/reference/rich-text),
[data-source properties](https://developers.notion.com/reference/property-object),
[page values](https://developers.notion.com/reference/page-property-values),
[files](https://developers.notion.com/reference/file-object), and
[page updates](https://developers.notion.com/reference/patch-page).

### API limits that affect one-to-one support

- Existing select/status option names and colors, and status-group configuration,
  have documented update restrictions. Do not work around them by deleting and
  recreating identities. [Schema updates](https://developers.notion.com/reference/update-data-source-properties)
- Formula and rollup outputs can be incomplete or explicitly unsupported. Current
  documentation also reports place reads as null despite newer write schemas;
  place round trips need clarification before being advertised.
  [Page values](https://developers.notion.com/reference/page-property-values)
- Notion-hosted file URLs expire; storing a current signed URL as a permanent
  external-file replacement changes the data model.
  [Files](https://developers.notion.com/reference/file-object)
- A sheet can preserve a board/calendar/gallery/chart view's configuration but
  does not render the same layout. Freeform spreadsheet fonts, borders and merged
  cells also have no equivalent in the documented database/table-view contract.
  [View object](https://developers.notion.com/reference/view)
- Reading a value before PATCH helps detect stale edits, but the documented page
  update contract does not offer an expected-revision/If-Match guarantee. Do not
  claim atomic prevention of simultaneous edits.
  [Page updates](https://developers.notion.com/reference/patch-page)

## Existing code to reuse and extend

- `src/lib/notion.ts`: authenticated REST client, source-ID resolution, schema and
  row operations, cache invalidation and uploads. Add view methods and complete
  cursor-returning query/property-item methods here.
- `src/lib/notion-props.ts`: extend the existing codecs with lossless typed values
  and raw configuration while retaining compatibility for existing ward callers.
  Current edit paths flatten text, lose timezone/file identity and ignore some formats.
- `src/scripts/app/notion.ts` and `notion-view.ts`: reuse/export typed property
  editors and themed renderers; avoid a competing set of Notion widgets.
- `src/pages/api/notion/source.ts`, `page.ts`, and `src/lib/notion-route.ts`: reuse
  account authorization and write routes; preserve actionable upstream errors.
- `src/lib/notion-filter.ts`: its current small flat-AND filter contract cannot
  represent arbitrary saved Notion view trees; retain the upstream view structure.
- `src/lib/notebook-pages.ts` and `src/scripts/app/notebook-page-editors.ts`: add the
  linked page type and engine registration, with source-specific save behavior.
- Keep row page bodies separate from database properties. The existing
  `notion-blocks.ts` editor supports a subset of blocks and is not a lossless
  replacement for every Notion page feature.

## Implementation sequence

1. **Lossless service contract.** Preserve complete schema configuration and typed
   property payloads. Query pagination must expose continuation/incomplete state;
   current helpers stop at small fixed row counts. Fully paginate relation and
   other property-item lists. Large-source queries have their own documented
   ceiling, which must remain visible to users.
   [Large sources](https://developers.notion.com/guides/data-apis/query-large-data-sources)
2. **Linked page and read view.** Add the picker and versioned source reference.
   Address rows by page ID and columns by property ID. Use paged/virtualized rows
   rather than increasing the local spreadsheet's hard limits. Keep credentials
   out of notebook state. Check stored workspace identity on reconnect.
3. **Field-level editing.** Keep drafts separate from cached remote values. Patch
   only changed properties, validate fresh schema, compare original values before
   writing, then refetch persisted results. Preserve drafts and explain per-cell
   failures. Computed/unsupported properties stay read-only.
4. **Schema and view editing.** Add deliberate controls for changes that affect
   the original Notion database or its shared views. Keep unsupported presentation
   choices local and visibly distinguish them from upstream settings.
5. **Refresh and compatibility.** Refresh on open/focus and after saves; optionally
   add webhook-driven cache invalidation later. Sync links/preferences between
   Rimeward runtimes, not authoritative copies of database rows. Version gates must
   prevent older clients from stripping the source reference or editing it as a
   local sheet. Existing NOTE_FORMAT=2 alone is insufficient for a new page kind.

The current connection model allows one Notion connection per Rimeward user.
Connection replacement must not silently rebind saved notebook links. Confirm
source sharing and read/update/insert capabilities; capability changes may require
reauthorization. [Capabilities](https://developers.notion.com/reference/capabilities)

Bulk operations need bounded concurrency and Retry-After handling through the
shared client. Do not blindly replay uncertain creates. Validate API limits rather
than silently truncate values. [Request limits](https://developers.notion.com/reference/request-limits)

Notebook Ask needs explicit coverage for linked data: fetch the required rows or
label a cached/partial snapshot. Never present the currently loaded grid page as
an analysis of the entire Notion database.

Webhooks should trigger refetches, not replace source records with event payloads.
[Webhooks](https://developers.notion.com/reference/webhooks)
