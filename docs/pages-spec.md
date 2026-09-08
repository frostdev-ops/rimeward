# Pages — spec (draft 1, 2026-09-03)

> Workspace extension, 2026-09-06: each runtime owns its own pages and layout. A page may
> reference a default `project` ID. **Open project** reuses that project's editor page or
> creates an ordinary page containing Editor, Terminal, and Changes; it is not a new page
> type. Development wards inherit the page project unless configured explicitly. Editor
> includes a left file explorer; a separate Project files ward remains optional. Native
> processes and recovery data stay on the desktop when a page/view detaches. Remote clients
> operate that runtime through `/runtime/<device>/…`, with no server-side layout replica.
> See [development workspaces](development-workspaces.md) for the current implementation.

> Status 2026-09-03: shipped, all phases. Deviations: the list editor lives in
> `logic-edit.ts` (same session graph, no second module); the tab strip also
> shows with one page while editing (the `+` chip is how a second page gets
> made); the popover's target select labels options `Page › Ward` (SearchSelect
> has no optgroup); Leylines mode orders cards by page with CSS `order` rather
> than moving DOM; the browser ward needs no canvas release (its own
> IntersectionObserver drops the stream), only spacer scenes are released.

Several dashboards per user, tabbed. Only the page you are on is booted in the
browser; every ward on every page keeps working on the server (leylines, chat
bots, timers, watchers never look at what a browser shows).

## 1. Model — a property, not a second layout

```ts
interface WardInstance {
  …
  /** The page this ward sits on; absent = the first page. Like `in` (its group):
   *  one pointer, and the layout stays ONE flat list. */
  page?: string;
}
interface PageDef { id: string; title: string; icon?: IconId; project?: string }
```

- The layout stays one flat list per user. Every key in the system is
  `(userId, wardId)` — leylines, the agent's tools, the comms manager, timers,
  notes — and none of them change. A page is a filter over that list.
- Page definitions live beside the layout in `dashboards` (new column
  `pages_json`, migration 015), ordered; the first is the default. A ward whose
  `page` names a page that no longer exists self-heals to the first page in
  `validateLayout`, the way a dangling `in` does. Deleting a page moves its
  wards to the first page (never deletes wards).
- A ward inside a group follows the group's page; `page` on a nested ward is
  ignored and stripped by `validateLayout`.
- Ids: `[a-z0-9-]{1,32}`, unique. Title ≤ 40 chars. Max pages: 12.
- Caps: `MAX_WARDS_PER_PAGE = 40` (today's number, per page), `MAX_WARDS = 200`
  total. Both enforced in `validateLayout`.

## 2. Server

- `validateLayout` gains the page rules above; `getDashboard` unchanged.
- `saveDashboard` / `PUT /api/dashboard` carry `pages` beside `layout`.
- `/dash` SSR renders every ward's SHELL (the card chrome, no data) so the
  first paint of any page needs no request, but stamps `data-page` and hides
  the off-page ones with `[data-wd-off]` (`data-wd-hidden` is the separate tray state). `#layout-data`
  keeps the whole layout — `readLayout()` consumers depend on it.
- Nothing else: the engine, the comms manager and the watchers read the stored
  layout and never look at `page`.

## 3. Client

### 3.1 Tabs
- A tab strip under the app header (`.app-pages`), one chip per page, the
  active one underlined with the accent. Right-click a tab: Rename, Move left /
  right, Delete. A `+` chip at the end adds a page (name prompt inline, no
  dialog). Hidden when there is one page.
- URL: `/dash#p=<id>` (hash, so SSR is unaffected and back/forward work).
  Last page per device in `localStorage` `fd-page`, applied on boot if the URL
  has none.
- Keyboard: `[` / `]` previous / next page; `1`–`9` jump. These shortcuts and
  dashboard Undo yield to text fields, note/chat editors, browser and remote
  desktop canvases, and IME composition. Already-handled keystrokes never
  trigger dashboard actions. Touch: horizontal
  swipe on the grid (only when the grid is not scrollable horizontally, i.e.
  always today) with a 40px / 300ms threshold.

### 3.2 Boot, cache, swap
- Booting a ward = `bootInstance` (poll + renderer). Only the active page's
  wards are booted. Leaving a page does NOT unboot: `poll()` already pauses
  while `document.hidden`, so extend that with a per-ward "on stage" flag —
  an off-page ward's poll skips its fetch, and a renderer that renders from
  an SSE store (Services, agent, chat) simply keeps painting into a hidden
  card, which costs nothing visible.
- Cache tiers per ward:
  1. **DOM kept** — the card and its last render stay in the document
     (`display:none`). Returning to a page is instant and shows the last data.
  2. **Warm** — the poll resumes on return and paints in place.
  3. **Cold** — a ward never visited since load boots on first visit; its
     shell shows the skeleton until the first render, like today.
- Memory ceiling: canvases (spacer scenes, browser ward screencast, note ink)
  are released when their page leaves the stage (`RENDERERS[type].stop`)
  and re-mounted on return; a browser ward's remote session stays alive
  server-side regardless (it already has its own idle reaper).
- SSE stores are global and stay connected across pages; a `refresh` event
  for an off-stage ward marks it dirty instead of rerendering; the dirty set
  is flushed when the page comes on stage.
- Pre-warm: on idle after boot, boot the NEXT page's wards too (one page of
  lookahead), so the most likely swap is warm. Never more than two pages
  booted per tab.

### 3.3 Swap animation
- Animation rule: never animate cards through motion's JS driver,
  never leave a WAAPI fill on a card. The swap therefore animates the GRID,
  not the cards: outgoing grid `translateX(-24px)` + fade over 160ms, incoming
  grid from `translateX(24px)` over 200ms, direction from the tab order
  (moving right slides left). Both are WAAPI on the grid container with
  `fd-page` ids, cancelled on a new swap.
- The incoming page's cards replay the CSS entrance cascade (`.wd-enter`,
  stagger 20ms) ONLY the first time that page is shown; later visits just
  slide, so a fast tabber is not watching cascades.
- `prefers-reduced-motion`: crossfade only, 120ms, no translate, no cascade.
- The tab underline slides between chips (WAAPI on the underline element,
  spring pre-baked like the cards' `linear()` easings).
- Two grids in the DOM during a swap: the outgoing one is a clone painted
  once and removed on finish, so the real grid never carries two pages.

### 3.4 Edit mode
- Edit mode edits one page. Drag between pages: drag a card onto a tab chip
  (the chip highlights on hover, 400ms dwell switches page while dragging,
  the same idiom as dragging into a group). Context menu "Move to page ›".
- The tray (hidden wards) is per page. Add ward lands on the current page.
- Undo history is per session, not per page; a move across pages is one undo
  step.

### 3.5 Leylines mode
- Leylines can cross pages. In Leylines mode every page is laid out in flow
  under a page header row — the trick `fitGroups` already uses for groups —
  so both ends of any leyline are on screen and the wire layer needs no
  change. Wards on other pages sit at 60% opacity until hovered.
- Outside Leylines mode a card with a leyline to another page shows a chip
  "→ Ops › Alerts" in its footer; clicking it swaps page and pulses the
  target card.

### 3.6 Mobile: leylines as a list, not a drawing
The wire canvas is a pointer-device UI and is already poor on a phone; pages
would make it worse (every page in flow on a 390px screen). So the leylines
editor gets a second surface that needs no dragging and no geometry, and it is
the ONLY surface on narrow screens (`< 768px` or coarse pointer):

- **Per-ward sheet.** Long-press (context menu) a ward → "Leylines" opens a
  bottom sheet listing that ward's leylines as rows: `trigger → action @ target
  ward`, enabled toggle, last run chip. Tap a row to edit it in the same form
  the desktop popover uses (`fieldFor` renders both). "New leyline" starts
  from a trigger select (only the ward's own triggers), then an action select,
  then a target-ward select — a searchable `<select>` (SearchSelect upgrades
  it) grouped by page, so cross-page wiring is a pick, not a drag.
- **Global list.** The Leylines tab button on mobile opens the same sheet for
  the whole dashboard: grouped by source ward, sorted by page, searchable.
  This is also the accessibility path on desktop (keyboard-only editing).
- One data model, two views: the sheet edits the same graph through the same
  validate-on-save; the canvas repaints from it when it is next shown.
- The canvas on desktop keeps the flow layout across pages for the visual
  overview, but the popover's target-ward select gains the page grouping too,
  so a cross-page leyline can be made without scrolling to the other page.

Consequence for scope: the list editor lands in phase 3 BEFORE the flow layout,
because it is the part that makes pages usable on the device where the app is
weakest today, and the flow layout is the optional nicety.

### 3.7 Rime
- `get_layout` rows gain `page`; `add_ward` / `configure_ward` / `move_ward`
  accept `page`; new `list_pages` / `add_page` / `rename_page` /
  `delete_page` (write kind). The prompt's ward list groups by page.
- Rime's own ward stays where it is; the chat ward's `refresh` events and the
  agent stream are page-agnostic.

## 4. Migration
- 015: `ALTER TABLE dashboards ADD COLUMN pages_json TEXT NOT NULL DEFAULT '[]'`.
  Empty = one implicit page "Home". Existing layouts need no rewrite (absent
  `page` = first page).

## 5. Open questions
- Q1 Should groups be allowed to span pages (no — a group is on one page)?
  Confirm.
- Q2 Per-page theme (background scene per page)? Cheap once pages exist:
  `PageDef.theme` reusing `WardTheme`. Later.
- Q3 Shared pages between users (a household board)? Out of scope; every key
  is per user.
- Q4 Pre-warm lookahead: next page only, or the last-visited page too?

## 6. Phases
1. Model + validation + migration + `/dash` shells with `data-page` + the tab
   strip + hash routing + boot gating. Swap = plain show/hide. Tests for
   validation and caps.
2. Swap animation, entrance-once, reduced motion, keyboard, swipe, pre-warm,
   canvas release/remount, dirty-set flush.
3. The leylines list editor (per-ward sheet + global list, mobile-only
   surface, desktop keyboard path) and the page-grouped target select; then
   edit mode across pages (drag to tab, Move to page, per-page tray).
5. Leylines-mode flow layout across pages with the cross-page chip (desktop
   nicety, last).
4. Rime tools + prompt grouping.
