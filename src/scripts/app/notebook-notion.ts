import { el } from './dom.ts';
import { propView, richText, chip } from './notion-view.ts';
import { readProp, editorFor } from '../../lib/notion-props.ts';
import { createNotionViewFilters } from './notebook-notion-filters.ts';
import { bindContextMenu, menuItem, openMenu } from './menu.ts';
import type { NotebookPageEngine, NotebookPageOptions } from './notebook-page-engine.ts';
import '../../styles/notebook-notion.css';

type Raw = Record<string, any>;
interface SourceLink { workspaceId: string; databaseId: string; dataSourceId: string; viewId?: string; title?: string }
interface LinkedState { version: 1; source?: SourceLink; preferences: { widths?: Record<string, number>; hidden?: string[]; wrap?: boolean } }
interface Draft { original: Raw; value: any; error?: string }
// Drafts survive switching notebook pages; authoritative Notion rows never enter note sync.
const drafts = new Map<string, Draft>();
const safeUrl = (value: unknown) => typeof value === 'string' && /^https?:\/\//i.test(value) ? value : '';
const title = (source: Raw) => (source.title ?? []).map((run: Raw) => run.plain_text ?? run.text?.content ?? '').join('') || 'Untitled database';
const idKey = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
const sameId = (a: string, b: string) => idKey(a) === idKey(b);
const rawValue = (row: Raw, id: string): Raw | undefined => Object.values(row.properties ?? {}).find((p: any) => sameId(p.id, id)) as Raw | undefined;
const runText = (run: Raw) => run.text?.content ?? run.plain_text ?? run.equation?.expression ?? '';
function linkedState(value: unknown): LinkedState {
  if (value === null || value === undefined) return { version: 1, preferences: {} };
  const input = value as Partial<LinkedState>;
  const invalid = () => { throw new Error('This linked Notion page has an invalid or unsupported source reference. Its saved content was not changed.'); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== 1) return invalid();
  if (input.source !== undefined) {
    const source = input.source, id = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(value);
    if (!source || typeof source !== 'object' || !id(source.workspaceId) || !id(source.databaseId) || !id(source.dataSourceId) || (source.viewId !== undefined && source.viewId !== '' && !id(source.viewId)) || (source.title !== undefined && typeof source.title !== 'string')) return invalid();
  }
  const prefs = input.preferences ?? {};
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs) || (prefs.hidden !== undefined && (!Array.isArray(prefs.hidden) || prefs.hidden.some(id => typeof id !== 'string'))) || (prefs.wrap !== undefined && typeof prefs.wrap !== 'boolean') || (prefs.widths !== undefined && (!prefs.widths || typeof prefs.widths !== 'object' || Array.isArray(prefs.widths) || Object.values(prefs.widths).some(width => typeof width !== 'number' || !Number.isFinite(width) || width < 0 || width > 1200)))) return invalid();
  return structuredClone({ version: 1, source: input.source, preferences: prefs });
}
function button(label: string, work: () => void, cls = 'btn'): HTMLButtonElement { const b = el('button', cls, label); b.type = 'button'; b.onclick = work; return b; }
function field(label: string, value = '', type = 'text'): { label: HTMLLabelElement; input: HTMLInputElement } { const root = el('label', 'nbn-field', label), input = el('input', 'input'); input.type = type; input.value = value; root.append(input); return { label: root, input }; }
function anchor(label: string, url: string): HTMLElement { const a = el('a', 'link', label); a.href = url.startsWith('/') && !url.startsWith('//') ? url : safeUrl(url); a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }

export function createNotionPage(options: NotebookPageOptions): NotebookPageEngine {
  const element = el('div', 'nb-notion'), tools = el('div', 'nbn-tools'), status = el('p', 'nbn-status'), body = el('div', 'nbn-body'), grid = el('div', 'nbn-grid'), inspector = el('aside', 'nbn-inspector');
  status.setAttribute('role', 'status'); inspector.hidden = true; body.append(grid, inspector); element.append(tools, status, body);
  const controller = new AbortController(), { signal } = controller;
  let state: LinkedState = { version: 1, preferences: {} }, source: Raw | null = null, views: Raw[] = [], rows: Raw[] = [], cursor: string | undefined, queryId: string | undefined, queryViewId: string | undefined, hasMore = false, loading = false, generation = 0, active: { rowId: string; propertyId: string } | null = null, disposed = false, viewsError = '', incomplete = false;
  const writes = new Set<Promise<Raw>>();
  const ref = () => state.source ? { workspaceId: state.source.workspaceId, sourceId: state.source.dataSourceId } : {};
  const keyFor = (rowId: string, propertyId: string) => `${state.source?.workspaceId}/${state.source?.dataSourceId}/${rowId}/${propertyId}`;
  const report = (text: string, error = false) => { status.textContent = text; status.dataset.error = String(error); };
  function request(action: string, params: Raw = {}, method = 'GET'): Promise<Raw> {
    const operation = (async () => {
    const payload = { ...ref(), ...params, action }, url = '/api/notion/linked';
    const response = await fetch(method === 'GET' ? `${url}?${new URLSearchParams(Object.entries(payload).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}` : url,
      { method, ...(method === 'DELETE' ? { keepalive: true } : { signal }), ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error === 'not-linked' ? 'Connect Notion in Account, then refresh this page.' : data.error ?? `Notion request failed (${response.status}).`), { status: response.status });
    return data;
    })();
    if (method !== 'GET' && method !== 'DELETE') { const controls = [...inspector.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,textarea,select,button')].map(control => [control, control.disabled] as const); controls.forEach(([control]) => control.disabled = true); writes.add(operation); void operation.finally(() => { writes.delete(operation); controls.forEach(([control, disabled]) => control.disabled = disabled); }).catch(() => {}); }
    return operation;
  }
  function failure(error: unknown) { if (!disposed && (error as Error)?.name !== 'AbortError') report((error as Error).message || 'Notion is unavailable. Your draft is retained.', true); }
  function changed() { options.onChange(); }
  function selectedView(): Raw | undefined { return views.find(v => v.id === state.source?.viewId); }
  function props(): Raw[] { return Object.entries(source?.properties ?? {}).map(([name, p]) => ({ ...(p as Raw), name })); }
  function configProps(): Raw[] { return selectedView()?.configuration?.properties ?? []; }
  function columns(): Raw[] {
    const all = props(), configured = configProps(), byId = new Map(all.map(p => [idKey(p.id), p]));
    return [...configured.map(c => byId.get(idKey(c.property_id))).filter(Boolean), ...all.filter(p => !configured.some(c => sameId(c.property_id, p.id)))].filter((p): p is Raw => !!p).filter(p => state.preferences.hidden ? !state.preferences.hidden.includes(p.id) : configured.find(c => sameId(c.property_id, p.id))?.visible !== false);
  }
  function clearQuery() { const id = queryId, viewId = queryViewId; queryId = queryViewId = undefined; if (id && viewId) void request('query', { queryId: id, viewId }, 'DELETE').catch(() => {}); }
  function closeInspector() { inspector.hidden = true; inspector.replaceChildren(); active = null; }
  function canSwitch() { if (!dirty()) return true; report('Save or discard the current Notion edit first.', true); return false; }
  function cancelEdit() { if (writes.size) return report('Waiting for Notion to finish saving…'); if (active) drafts.delete(keyFor(active.rowId, active.propertyId)); localFormDirty = false; closeInspector(); renderGrid(); }
  function openInspector(label: string) { inspector.hidden = false; inspector.replaceChildren(el('h3', '', label), button('Cancel editing', cancelEdit, 'btn nbn-close')); }
  async function picker() {
    const epoch = ++generation; source = null; rows = []; closeInspector(); tools.replaceChildren(); grid.replaceChildren(); report('Loading your Notion connection…');
    try {
      const connection = await request('connection'); if (epoch !== generation) return;
      tools.append(el('strong', '', connection.label || 'Notion workspace'));
      const search = field('Find a database', ''), list = el('div', 'nbn-sources'), more = button('More databases', () => void find(false)); let next: string | undefined;
      const form = el('form', 'nbn-search'); form.append(search.label, button('Search', () => void find(true))); form.onsubmit = e => { e.preventDefault(); void find(true); }; grid.append(form, list, more);
      let searching = false;
      async function find(reset: boolean) {
        if (searching) return; searching = true; more.disabled = true;
        try {
          const data = await request('search', { q: search.input.value.trim(), cursor: reset ? undefined : next }); if (epoch !== generation) return;
          if (reset) list.replaceChildren(); next = data.nextCursor; more.hidden = !data.hasMore;
          for (const result of data.results ?? []) {
            const card = button(title(result), () => { clearQuery(); state = { version: 1, source: { workspaceId: connection.workspaceId, databaseId: result.parent?.database_id ?? '', dataSourceId: result.id, title: title(result) }, preferences: {} }; changed(); void loadSource(); }, 'btn nbn-source');
            if (result.parent?.database_id) card.title = `Database ${result.parent.database_id}`;
            list.append(card);
          }
          report(list.children.length ? 'Choose a database shared with your Notion connection.' : 'No databases found. Share the database with your Notion connection, then search again.');
        } catch (error) { failure(error); } finally { searching = false; more.disabled = false; }
      }
      await find(true);
    } catch (error) { failure(error); grid.append(anchor('Open Account to connect Notion', '/account'), button('Retry connection', () => void picker())); }
  }
  async function loadSource(recover = false) {
    if (!recover && !canSwitch()) return; const epoch = ++generation; loading = false; clearQuery(); rows = []; cursor = undefined; incomplete = false; closeInspector(); report('Loading linked database…');
    try { const result = await request('source'); if (epoch !== generation) return; source = result.source; views = result.views ?? []; viewsError = result.viewsError ?? ''; if (state.source && state.source.viewId === undefined) { const initial = views.find(view => view.type === 'table'); if (initial) { state.source.viewId = initial.id; changed(); } } renderTools(); renderGrid(); if (result.viewsError) report(`Saved views unavailable: ${result.viewsError}`, true); await loadRows(true, epoch, recover); }
    catch (error) { failure(error); tools.replaceChildren(button('Refresh', () => void loadSource()), button('Choose database', () => void picker())); }
  }
  async function loadRows(reset = false, epoch = generation, recover = false) {
    if (loading || (reset && !recover && !canSwitch())) return; loading = true; renderTools();
    try {
      if (reset) { clearQuery(); cursor = undefined; incomplete = false; }
      const result = await request('rows', { viewId: state.source?.viewId, cursor: reset ? undefined : cursor, queryId });
      if (epoch !== generation) return;
      if (reset) rows = [];
      const existing = new Set(rows.map(r => r.id)); for (const row of result.rows ?? []) if (!existing.has(row.id)) rows.push(row);
      cursor = result.nextCursor; queryId = result.queryId; queryViewId = state.source?.viewId; incomplete ||= !!result.incomplete; hasMore = !!result.hasMore; renderGrid();
      report(`${rows.length} rows loaded${incomplete ? ' · Notion query limit reached: narrow the saved view to access remaining rows' : hasMore ? ' · More rows available' : ' · All rows in this view loaded'}${viewsError ? ` · Saved views unavailable: ${viewsError}` : ''}${selectedView()?.configuration?.subtasks?.display_mode && selectedView()?.configuration?.subtasks?.display_mode !== 'disabled' ? ' · Subitems are shown as flat rows' : ''}${selectedView()?.type && selectedView()?.type !== 'table' ? ` · ${selectedView()!.type} view shown as a table` : ''}`);
    } catch (error) { failure(error); } finally { if (epoch === generation) { loading = false; renderTools(); } }
  }
  function renderTools() {
    tools.replaceChildren(el('strong', 'nbn-title', title(source ?? {})));
    const view = el('select', 'input'); view.setAttribute('aria-label', 'Notion saved view'); view.append(new Option('All rows', ''));
    for (const v of views) view.append(new Option(v.name || v.type, v.id)); if (state.source?.viewId && !views.some(v => v.id === state.source!.viewId)) view.append(new Option('Unavailable saved view', state.source.viewId)); view.value = state.source?.viewId ?? ''; view.disabled = loading;
    view.onchange = () => { if (!state.source || !canSwitch()) { view.value = state.source?.viewId ?? ''; return; } clearQuery(); state.source.viewId = view.value; state.preferences = {}; changed(); closeInspector(); void loadRows(true); };
    const refresh = button('Refresh', () => void loadSource()); refresh.disabled = loading;
    tools.append(view, refresh, button('New row', createRow), button('Columns & view', layoutEditor), button('Database properties', schemaEditor));
    if (state.source) tools.append(anchor('Open in Notion', selectedView()?.url || source?.url || `https://www.notion.so/${state.source.databaseId.replace(/-/g, '')}`));
  }
  function cellDisplay(p: Raw | undefined, schema: Raw): HTMLElement {
    if (!p) return el('span', 'text-ink-faint', 'Unavailable');
    const pv = readProp(p), display = configProps().find(c => sameId(c.property_id, schema.id)) ?? {};
    if (p.type === 'status' && display.status_show_as === 'checkbox') { const cb = el('input'); cb.type = 'checkbox'; cb.disabled = true; const done = schema.status?.groups?.at(-1); cb.checked = !!done?.option_ids?.includes(p.status?.id); cb.title = p.status?.name ?? ''; return cb; }
    if (p.type === 'date' && p.date?.start) { const one = (text: string) => { const date = new Date(text.includes('T') ? text : `${text}T00:00:00`); if (!Number.isFinite(date.getTime())) return text; const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(p.date.time_zone ? { timeZone: p.date.time_zone } : {}) }).formatToParts(date), part = (name: string) => parts.find(v => v.type === name)?.value; let result = display.date_format === 'year_month_day' ? `${part('year')}/${part('month')}/${part('day')}` : display.date_format === 'day_month_year' ? `${part('day')}/${part('month')}/${part('year')}` : display.date_format === 'month_day_year' ? `${part('month')}/${part('day')}/${part('year')}` : display.date_format === 'relative' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round((date.getTime() - Date.now()) / 86400000), 'day') : date.toLocaleDateString(undefined, { dateStyle: display.date_format === 'short' ? 'short' : 'long', ...(p.date.time_zone ? { timeZone: p.date.time_zone } : {}) }); if (text.includes('T') && display.time_format !== 'hidden') result += ` ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: display.time_format !== '24_hour', ...(p.date.time_zone ? { timeZone: p.date.time_zone } : {}) })}`; return result; }; return el('span', '', `${one(p.date.start)}${p.date.end ? ` → ${one(p.date.end)}` : ''}`); }
    if ((p.type === 'title' || p.type === 'rich_text') && p[p.type]) return richText(p[p.type], pv.text);
    if (p.type === 'number' && p.number != null) {
      const format = schema.number?.format ?? 'number'; const currencies: Record<string, string> = { dollar: 'USD', canadian_dollar: 'CAD', australian_dollar: 'AUD', euro: 'EUR', pound: 'GBP', yen: 'JPY', yuan: 'CNY', rupee: 'INR', won: 'KRW', franc: 'CHF', real: 'BRL', ruble: 'RUB', hong_kong_dollar: 'HKD', new_zealand_dollar: 'NZD', singapore_dollar: 'SGD' };
      if (currencies[format] || format === 'percent' || format === 'number_with_commas') return el('span', '', new Intl.NumberFormat(undefined, currencies[format] ? { style: 'currency', currency: currencies[format] } : format === 'percent' ? { style: 'percent', maximumFractionDigits: 8 } : { maximumFractionDigits: 12 }).format(p.number));
    }
    if (p.type === 'relation') { const node = el('span', 'nbn-chips'); for (const related of p.relation ?? []) node.append(anchor(related.title || related.id.slice(0, 8), `https://www.notion.so/${related.id.replace(/-/g, '')}`)); if (p.has_more) node.append(chip('More…')); return node; }
    if (editorFor(p.type) === 'none' && !pv.text) return el('span', 'text-ink-faint', p.type === 'formula' || p.type === 'rollup' ? `— (${p.type})` : `${p.type} · read-only`);
    return propView(pv, { options: schema[schema.type]?.options });
  }
  function rowGroups(configuration: Raw): { name?: string; rows: Raw[] }[] {
    const spec = configuration.group_by, property = props().find(p => sameId(p.id, spec?.property_id ?? ''));
    if (!spec || !property) return [{ rows }];
    const buckets = new Map<string, Raw[]>();
    const labels = (raw: Raw | undefined, rule: Raw = spec): string[] => {
      if (!raw) return ['No value'];
      const value = raw[raw.type];
      if (raw.type === 'formula' && value) return labels({ type: value.type === 'string' ? 'rich_text' : value.type === 'boolean' ? 'checkbox' : value.type, [value.type === 'string' ? 'rich_text' : value.type === 'boolean' ? 'checkbox' : value.type]: value.type === 'string' ? [{ text: { content: value.string ?? '' } }] : value[value.type] }, rule.group_by ?? rule);
      if (raw.type === 'status' && rule.group_by === 'group') return [property.status?.groups?.find((g: Raw) => g.option_ids?.includes(value?.id))?.name ?? 'No value'];
      if (raw.type === 'multi_select' || raw.type === 'people' || raw.type === 'relation') return value?.length ? value.map((v: Raw) => v.name || v.title || v.id) : ['No value'];
      if (['date', 'created_time', 'last_edited_time'].includes(raw.type)) {
        const text = typeof value === 'string' ? value : value?.start; if (!text) return ['No value'];
        const date = new Date(text.includes('T') ? text : `${text}T00:00:00`); if (!Number.isFinite(date.getTime())) return [text];
        if (rule.group_by === 'year') return [String(date.getFullYear())];
        if (rule.group_by === 'month') return [date.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })];
        if (rule.group_by === 'week') { date.setDate(date.getDate() - (date.getDay() - (rule.start_day_of_week ?? 0) + 7) % 7); return [`Week of ${date.toLocaleDateString()}`]; }
        if (rule.group_by === 'relative') { const today = new Date(); today.setHours(0, 0, 0, 0); date.setHours(0, 0, 0, 0); const days = Math.round((date.getTime() - today.getTime()) / 86400000); return [days < -7 ? 'Earlier' : days < -1 ? 'Past week' : days === -1 ? 'Yesterday' : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days <= 7 ? 'Next week' : 'Later']; }
        return [date.toLocaleDateString()];
      }
      if (raw.type === 'number' && typeof value === 'number' && rule.range_size >= 1) { const start = rule.range_start ?? 0, end = rule.range_end; if (value < start) return [`Below ${start}`]; if (typeof end === 'number' && value >= end) return [`${end} and above`]; const low = start + Math.floor((value - start) / rule.range_size) * rule.range_size; return [`${low} – ${low + rule.range_size}`]; }
      const text = readProp(raw).text || 'No value'; return [rule.group_by === 'alphabet_prefix' ? text[0]!.toLocaleUpperCase() : text];
    };
    const options = property.type === 'status' && spec.group_by === 'group' ? property.status?.groups : property[property.type]?.options;
    for (const option of options ?? []) buckets.set(option.name, []);
    for (const row of rows) for (const label of new Set(labels(rawValue(row, property.id)))) { const items = buckets.get(label) ?? []; items.push(row); buckets.set(label, items); }
    let entries = [...buckets].filter(([, rows]) => !spec.hide_empty_groups || rows.length);
    if (spec.sort?.type === 'ascending' || spec.sort?.type === 'descending') { const position = (entry: [string, Raw[]]) => { const raw = entry[1][0] && rawValue(entry[1][0], property.id), value = raw?.[raw.type]; const date = raw?.type === 'date' ? value?.start : ['created_time', 'last_edited_time'].includes(raw?.type ?? '') ? value : undefined; return date ? Date.parse(date) : raw?.type === 'number' && typeof value === 'number' ? value : undefined; }; entries.sort((a, b) => { const x = position(a), y = position(b); return (x !== undefined && y !== undefined ? x - y : a[0].localeCompare(b[0], undefined, { numeric: true })) * (spec.sort.type === 'descending' ? -1 : 1); }); }
    return entries.map(([name, rows]) => ({ name, rows }));
  }
  function renderGrid() {
    const scrollTop = grid.scrollTop, scrollLeft = grid.scrollLeft, cols = columns(), configuration = selectedView()?.configuration ?? {};
    const table = el('table', 'nbn-table'); table.dataset.verticalLines = String(configuration.show_vertical_lines !== false); table.setAttribute('aria-label', `${title(source ?? {})} database`); const head = el('thead'), tr = el('tr'), tbody = el('tbody'); head.append(tr);
    let frozenLeft = 0; const widths = cols.map(p => Math.max(72, Math.min(1200, state.preferences.widths?.[p.id] ?? configProps().find(c => sameId(c.property_id, p.id))?.width ?? 200)));
    cols.forEach((p, index) => {
      const th = el('th', '', p.name); th.scope = 'col'; th.dataset.propertyId = p.id; th.title = `${p.type}${editorFor(p.type) === 'none' ? ' · read-only' : ''}`; th.style.width = `${widths[index]}px`; th.style.minWidth = `${widths[index]}px`;
      if (index < (configuration.frozen_column_index ?? 0)) { th.classList.add('nbn-frozen'); th.style.left = `${frozenLeft}px`; } frozenLeft += widths[index]!;
      tr.append(th);
    });
    // Pagination remains authoritative; each loaded group expands as more rows arrive.
    for (const group of rowGroups(configuration)) {
      if (group.name !== undefined) { const tr = el('tr', 'nbn-group'), label = el('th', '', `${group.name} · ${group.rows.length}${hasMore ? ' loaded' : ''}`); label.colSpan = Math.max(1, cols.length); tr.append(label); tbody.append(tr); }
      for (const row of group.rows) {
      const line = el('tr'); let left = 0;
      cols.forEach((p, index) => {
        const value = rawValue(row, p.id), td = el('td'); td.tabIndex = 0; td.dataset.rowId = row.id; td.dataset.propertyId = p.id; td.style.width = `${widths[index]}px`; td.style.maxWidth = `${widths[index]}px`; td.setAttribute('aria-label', `${p.name}: ${readProp(value).text || 'empty'}`);
        td.dataset.wrap = String(state.preferences.wrap ?? configProps().find(c => sameId(c.property_id, p.id))?.wrap ?? configuration.wrap_cells ?? false);
        if (index < (configuration.frozen_column_index ?? 0)) { td.classList.add('nbn-frozen'); td.style.left = `${left}px`; } left += widths[index]!;
        if (drafts.has(keyFor(row.id, p.id))) td.dataset.draft = 'true';
        const content = el('div', 'nbn-value'); if (p.type === 'title' && row.icon?.type === 'emoji') content.append(el('span', '', `${row.icon.emoji} `)); content.append(cellDisplay(value, p)); for (const link of content.querySelectorAll<HTMLAnchorElement>('a')) if (!/^(https?:|mailto:|tel:)/i.test(link.href)) link.removeAttribute('href'); td.append(content);
        td.ondblclick = () => void editCell(row.id, p.id); td.onkeydown = e => { if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); void editCell(row.id, p.id); } else if (e.key.startsWith('Arrow')) { e.preventDefault(); const x = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0, y = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0; const at = rows.indexOf(row); table.querySelector<HTMLElement>(`td[data-row-id="${rows[at + y]?.id ?? row.id}"][data-property-id="${CSS.escape(cols[index + x]?.id ?? p.id)}"]`)?.focus(); } };
        line.append(td);
      }); tbody.append(line);
      }
    }
    table.append(head, tbody); grid.replaceChildren(table);
    if (!rows.length) grid.append(el('p', 'nbn-empty', 'No rows in this view.'));
    if (hasMore) grid.append(button('Load more rows', () => void loadRows(), 'btn nbn-more'));
    grid.scrollTop = scrollTop; grid.scrollLeft = scrollLeft;
  }
  async function editCell(rowId: string, propertyId: string) {
    if (!canSwitch() && !((!active || (active.rowId === rowId && active.propertyId === propertyId)) && drafts.has(keyFor(rowId, propertyId)) && !writes.size && !localFormDirty)) return; const p = props().find(p => p.id === propertyId); if (!p) return;
    active = { rowId, propertyId }; openInspector(p.name); const target = active, draftKey = keyFor(rowId, propertyId); inspector.append(el('p', '', 'Loading complete value…'));
    try {
      let draft = drafts.get(draftKey);
      if (!draft) { const result = await request('property', { pageId: rowId, propertyId }); if (!result.complete) throw new Error('Notion did not return the complete value. Open it in Notion to edit without losing items.'); draft = { original: result.property, value: structuredClone(result.property[result.property.type]) }; }
      if (active !== target || disposed) return;
      const current = draft; openInspector(p.name); const row = rows.find(r => r.id === rowId);
      if (row?.cover) { const url = safeUrl(row.cover[row.cover.type]?.url); if (url) { const image = el('img', 'nbn-cover'); image.src = url; image.alt = 'Notion page cover'; inspector.append(image); } } inspector.append(anchor('Open row in Notion', row?.url || `https://www.notion.so/${rowId.replace(/-/g, '')}`));
      if (editorFor(p.type) === 'none') { inspector.append(el('p', '', `${p.type} is maintained by Notion and is read-only here.`), cellDisplay(current.original, p)); return; }
      const editor = valueEditor(p, current.value, value => { if (active !== target || disposed) return; current.value = value; drafts.set(draftKey, current); }); inspector.append(editor);
      const message = el('p', 'nbn-status', current.error ?? 'Changes save to the original Notion database.'); message.setAttribute('role', 'status'); inspector.append(message);
      const save = button('Save to Notion', async () => {
        save.disabled = true; editor.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,textarea,select,button').forEach(control => control.disabled = true); message.textContent = 'Saving…'; drafts.set(draftKey, current);
        try { const result = await request('property', { pageId: rowId, propertyId, value: structuredClone(current.value), original: current.original }, 'PATCH'); if (disposed) return; const i = rows.findIndex(r => r.id === rowId); if (i >= 0) rows[i] = result.row; drafts.delete(draftKey); closeInspector(); renderGrid(); await loadRows(true); if (!disposed) report(`Saved to Notion. ${status.textContent ?? ''}`); }
        catch (error) { current.error = (error as Error).message; message.textContent = `${current.error} Your draft is retained.`; message.dataset.error = 'true'; }
        finally { save.disabled = false; editor.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,textarea,select,button').forEach(control => control.disabled = false); }
      });
      inspector.append(save, button('Discard draft', cancelEdit));
    } catch (error) { if (active === target) { inspector.append(el('p', 'text-err', (error as Error).message), button('Retry', () => void editCell(rowId, propertyId))); } }
  }
  function valueEditor(p: Raw, initial: any, update: (value: any) => void): HTMLElement {
    const root = el('div', 'nbn-editor'); let value = structuredClone(initial); const commit = () => update(structuredClone(value));
    if (p.type === 'title' || p.type === 'rich_text') {
      value = Array.isArray(value) ? value : []; const list = el('div', 'nbn-runs'); root.append(list);
      function paint() {
        list.replaceChildren();
        value.forEach((run: Raw, i: number) => {
          const section = el('div', 'nbn-run'), kind = run.type ?? 'text';
          if (kind === 'text' || kind === 'equation') {
            const text = el('textarea', 'input'); text.rows = 2; text.value = runText(run); text.setAttribute('aria-label', kind === 'equation' ? 'Equation' : `Text span ${i + 1}`);
            text.oninput = () => { if (kind === 'text') run.text = { ...run.text, content: text.value }; else run.equation = { ...run.equation, expression: text.value }; delete run.plain_text; commit(); }; section.append(text);
          } else { section.append(chip(runText(run) || 'Notion mention'), el('small', '', 'Mention identity is preserved.')); }
          const format = el('div', 'nbn-run-format');
          for (const [key, label] of [['bold', 'Bold'], ['italic', 'Italic'], ['underline', 'Underline'], ['strikethrough', 'Strike'], ['code', 'Code']]) {
            const control = button(label!, () => { run.annotations = { ...run.annotations, [key!]: !run.annotations?.[key!] }; control.setAttribute('aria-pressed', String(!!run.annotations[key!])); commit(); }, 'btn'); control.setAttribute('aria-pressed', String(!!run.annotations?.[key!])); format.append(control);
          }
          const color = el('select', 'input'); color.setAttribute('aria-label', 'Text color'); for (const c of ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red', 'gray_background', 'brown_background', 'orange_background', 'yellow_background', 'green_background', 'blue_background', 'purple_background', 'pink_background', 'red_background']) color.append(new Option(c.replace('_', ' '), c)); color.value = run.annotations?.color ?? 'default'; color.onchange = () => { run.annotations = { ...run.annotations, color: color.value }; commit(); }; format.append(color); section.append(format);
          if (kind === 'text') { const link = field('Link (optional)', run.text?.link?.url ?? '', 'url'); link.input.oninput = () => { run.text = { ...run.text, link: link.input.value ? { url: link.input.value } : null }; delete run.href; commit(); }; section.append(link.label); }
          section.append(button('Remove span', () => { value.splice(i, 1); commit(); paint(); })); list.append(section);
        });
      }
      root.append(button('Add text span', () => { value.push({ type: 'text', text: { content: '' } }); commit(); paint(); }), button('Add equation', () => { value.push({ type: 'equation', equation: { expression: '' } }); commit(); paint(); })); paint(); return root;
    }
    if (p.type === 'select' || p.type === 'status' || p.type === 'multi_select') {
      const multi = p.type === 'multi_select', select = el('select', 'input'); select.multiple = multi; select.setAttribute('aria-label', p.name); if (!multi && p.type !== 'status') select.append(new Option('None', ''));
      const chosen = new Set((multi ? value ?? [] : value ? [value] : []).map((v: Raw) => v.id));
      for (const option of p[p.type]?.options ?? []) select.append(new Option(option.name, option.id, false, chosen.has(option.id)));
      select.onchange = () => { value = multi ? [...select.selectedOptions].map(o => ({ id: o.value })) : select.value ? { id: select.value } : null; commit(); }; root.append(select); return root;
    }
    if (p.type === 'checkbox') { const cb = field(p.name, '', 'checkbox'); cb.input.checked = !!value; cb.input.onchange = () => { value = cb.input.checked; commit(); }; root.append(cb.label); return root; }
    if (p.type === 'date') {
      const start = field('Start date / time', value?.start ?? ''), end = field('End date / time (optional)', value?.end ?? ''), zone = field('Time zone (optional)', value?.time_zone ?? '');
      start.input.placeholder = '2026-09-10 or 2026-09-10T14:30:00-04:00'; end.input.placeholder = start.input.placeholder; zone.input.placeholder = 'America/New_York';
      const apply = () => { value = start.input.value ? { ...(value ?? {}), start: start.input.value, end: end.input.value || null, time_zone: zone.input.value || null } : null; commit(); }; for (const f of [start, end, zone]) { f.input.oninput = apply; root.append(f.label); } return root;
    }
    if (p.type === 'people' || p.type === 'relation' || p.type === 'files') {
      value = Array.isArray(value) ? value : []; const list = el('div', 'nbn-chips'); root.append(list);
      const paint = () => { list.replaceChildren(); value.forEach((item: Raw, index: number) => { const c = chip(item.name || item.title || item.id || 'File'); c.append(button('×', () => { value.splice(index, 1); commit(); paint(); })); list.append(c); }); }; paint();
      if (p.type === 'files') {
        const upload = field('Add file', '', 'file'); upload.input.onchange = async () => { const file = upload.input.files?.[0]; if (!file) return; upload.input.disabled = true;
          try { const form = new FormData(); form.append('file', file); const uploadWork = fetch('/api/notion/upload', { method: 'POST', body: form, signal }).then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || 'File upload failed'); return result as Raw; }); writes.add(uploadWork); void uploadWork.finally(() => writes.delete(uploadWork)).catch(() => {}); const result = await uploadWork; value.push({ name: file.name, type: 'file_upload', file_upload: { id: result.id } }); commit(); paint(); }
          catch (error) { root.append(el('p', 'text-err', (error as Error).message)); } finally { upload.input.disabled = false; upload.input.value = ''; }
        }; root.append(upload.label);
        const name = field('External file name'), url = field('External file URL', '', 'url'); root.append(name.label, url.label, button('Add external file', () => { if (!safeUrl(url.input.value)) { url.input.reportValidity(); return; } value.push({ name: name.input.value || 'File', type: 'external', external: { url: url.input.value } }); commit(); paint(); name.input.value = ''; url.input.value = ''; }));
      } else {
        const search = field(p.type === 'people' ? 'Filter people' : 'Filter related pages'), choices = el('div', 'nbn-reference-choices'); let next: string | undefined, candidates: Raw[] = [], busy = false;
        const show = () => { choices.replaceChildren(); const text = search.input.value.toLowerCase(); for (const item of candidates) { const label = p.type === 'people' ? item.name || item.id : Object.values(item.properties ?? {}).filter((v: any) => v.type === 'title').map((v: any) => readProp(v).text).join('') || 'Untitled page'; if (text && !label.toLowerCase().includes(text)) continue; const b = button(label, () => { if (value.some((v: Raw) => v.id === item.id)) return; value.push(p.type === 'people' ? { id: item.id, name: item.name } : { id: item.id }); commit(); paint(); show(); }); b.disabled = value.some((v: Raw) => v.id === item.id); choices.append(b); } };
        const more = button('Load choices', () => void fetchChoices());
        async function fetchChoices() { if (busy) return; busy = true; more.disabled = true;
          try { const relatedSource = p.relation?.data_source_id; if (p.type === 'relation' && !relatedSource) throw new Error('Notion did not expose the related data source. Open this property in Notion.'); const result = await request(p.type === 'people' ? 'users' : 'rows', { ...(relatedSource ? { sourceId: relatedSource } : {}), cursor: next }); candidates.push(...(result.users ?? result.results ?? result.rows ?? [])); next = result.nextCursor; more.hidden = !result.hasMore; more.textContent = 'More choices'; show(); }
          catch (error) { choices.append(el('p', 'text-err', (error as Error).message)); } finally { busy = false; more.disabled = false; }
        }
        search.input.oninput = show; root.append(search.label, choices, more); void fetchChoices();
      }
      return root;
    }
    const input = field(p.name, value == null ? '' : String(value), p.type === 'number' ? 'number' : p.type === 'url' ? 'url' : p.type === 'email' ? 'email' : 'text');
    input.input.oninput = () => { value = p.type === 'number' ? input.input.value === '' ? null : Number(input.input.value) : input.input.value || null; commit(); }; root.append(input.label); return root;
  }
  let localFormDirty = false;
  function createRow() {
    if (!canSwitch()) return; const p = props().find(p => p.type === 'title'); if (!p) return report('This database has no title property.', true);
    active = null; openInspector('New Notion row'); const input = field(p.name); input.input.oninput = () => { localFormDirty = true; }; const message = el('p', 'nbn-status');
    const create = button('Create in Notion', async () => { if (!input.input.value.trim()) return input.input.focus(); create.disabled = true; message.textContent = 'Creating…';
      try { const result = await request('create', { properties: { [p.id]: { title: [{ type: 'text', text: { content: input.input.value } }] } } }, 'POST'); localFormDirty = false; closeInspector(); report('Row created. Refreshing this view…'); await loadRows(true); if (result.row) void editCell(result.row.id, p.id); }
      catch (error) { message.textContent = `${(error as Error).message} Refresh the database before retrying to avoid a duplicate row.`; if ((error as { status?: number }).status && (error as { status: number }).status < 500) create.disabled = false; }
    }); inspector.append(input.label, create, button('Cancel new row', () => { localFormDirty = false; closeInspector(); }), message); input.input.focus();
  }
  function layoutEditor() {
    if (!canSwitch()) return; active = null; openInspector('Columns & view'); const configuration = selectedView()?.configuration ?? {}, rows = el('div', 'nbn-layout-columns');
    for (const p of props()) {
      const row = el('div', 'nbn-layout-column'), show = field(p.name, '', 'checkbox'), width = field('Width', String(state.preferences.widths?.[p.id] ?? configProps().find(c => sameId(c.property_id, p.id))?.width ?? 200), 'number');
      show.input.checked = columns().some(c => c.id === p.id); width.input.min = '72'; width.input.max = '1200';
      show.input.onchange = () => { const hidden = state.preferences.hidden ?? props().filter(p => !columns().some(c => c.id === p.id)).map(p => p.id); state.preferences.hidden = show.input.checked ? hidden.filter(id => id !== p.id) : [...new Set([...hidden, p.id])]; changed(); renderGrid(); };
      width.input.onchange = () => { state.preferences.widths = { ...state.preferences.widths, [p.id]: Math.max(72, Math.min(1200, Number(width.input.value) || 200)) }; changed(); renderGrid(); }; row.append(show.label, width.label); rows.append(row);
    }
    const wrap = field('Wrap cells', '', 'checkbox'); wrap.input.checked = state.preferences.wrap ?? configuration.wrap_cells ?? false; wrap.input.onchange = () => { state.preferences.wrap = wrap.input.checked; changed(); renderGrid(); };
    inspector.append(el('p', '', 'Column changes are local to this notebook until you save the shared view.'), rows, wrap.label, button('Reset local layout', () => { state.preferences = {}; changed(); renderGrid(); layoutEditor(); }));
    const view = selectedView();
    if (view?.type === 'table') {
      const rules = createNotionViewFilters(view, props(), () => { localFormDirty = true; }); inspector.append(rules.element);
      const name = field('Shared view name', view.name), frozen = field('Frozen columns', String(configuration.frozen_column_index ?? 0), 'number'); frozen.input.min = '0'; frozen.input.max = String(props().length); name.input.oninput = frozen.input.oninput = () => { localFormDirty = true; };
      const message = el('p', 'nbn-status'); const save = button('Save layout to shared Notion view', async () => {
        save.disabled = true;
        try {
          const patch = rules.value(), layout = { ...(patch.configuration ?? {}) };
          if (name.input.value !== view.name) patch.name = name.input.value;
          if (state.preferences.widths || state.preferences.hidden) {
            const existing = new Map(configProps().map(p => [idKey(p.property_id), p]));
            const order = [...configProps().map(c => props().find(p => sameId(p.id, c.property_id))).filter((p): p is Raw => !!p), ...props().filter(p => !existing.has(idKey(p.id)))];
            layout.properties = order.filter(p => existing.has(idKey(p.id)) || state.preferences.hidden !== undefined || state.preferences.widths?.[p.id] !== undefined).map(p => ({ ...existing.get(idKey(p.id)), property_id: p.id, ...(state.preferences.hidden !== undefined ? { visible: columns().some(c => c.id === p.id) } : {}), ...(state.preferences.widths?.[p.id] !== undefined ? { width: state.preferences.widths[p.id] } : {}) }));
          }
          if (state.preferences.wrap !== undefined && state.preferences.wrap !== configuration.wrap_cells) layout.wrap_cells = state.preferences.wrap;
          if (Number(frozen.input.value) !== (configuration.frozen_column_index ?? 0)) layout.frozen_column_index = Math.max(0, Number(frozen.input.value));
          if (Object.keys(layout).length) patch.configuration = { type: 'table', ...layout }; else delete patch.configuration;
          if (Object.keys(patch).length) await request('view', { viewId: view.id, original: view, patch }, 'PATCH');
          localFormDirty = false; state.preferences = {}; changed(); await loadSource();
        }
        catch (error) { message.textContent = (error as Error).message; } finally { save.disabled = false; }
      }); inspector.append(name.label, frozen.label, el('p', '', 'Saving changes this view for everyone who uses it in Notion.'), save, message);
    }
  }
  function schemaEditor() {
    if (!canSwitch()) return; active = null; openInspector('Database properties'); inspector.append(el('p', '', 'Changes here update the original Notion database for everyone.'));
    const properties = el('select', 'input'); properties.setAttribute('aria-label', 'Database property'); for (const p of props()) properties.append(new Option(p.name, p.id)); const editor = el('div'); inspector.append(properties, editor); let propertySelection = properties.value;
    const draw = () => {
      propertySelection = properties.value; editor.replaceChildren(); const p = props().find(p => p.id === properties.value); if (!p) return; const name = field('Property name', p.name); name.input.oninput = () => { localFormDirty = true; }; editor.append(name.label, el('p', '', `${p.type}${editorFor(p.type) === 'none' ? ' · values computed by Notion' : ''}`));
      const format = el('select', 'input'); format.setAttribute('aria-label', 'Number format'); if (p.type === 'number') { for (const f of ['number', 'number_with_commas', 'percent', 'dollar', 'canadian_dollar', 'euro', 'pound', 'yen', 'rupee', 'won', 'franc', 'real']) format.append(new Option(f.replaceAll('_', ' '), f)); if (![...format.options].some(o => o.value === p.number?.format)) format.append(new Option(p.number?.format || 'number', p.number?.format || 'number')); format.value = p.number?.format ?? 'number'; format.onchange = () => { localFormDirty = true; }; editor.append(format); }
      const formula = field('Notion formula expression', p.formula?.expression ?? ''); if (p.type === 'formula') { formula.input.oninput = () => { localFormDirty = true; }; editor.append(formula.label); } const message = el('p', 'nbn-status'); const save = button('Save property to Notion', async () => { save.disabled = true; try { await request('schema', { original: source, patch: { properties: { [p.id]: { name: name.input.value, ...(p.type === 'number' ? { number: { ...p.number, format: format.value } } : p.type === 'formula' ? { formula: { expression: formula.input.value } } : {}) } } } }, 'PATCH'); localFormDirty = false; await loadSource(); } catch (error) { message.textContent = (error as Error).message; } finally { save.disabled = false; } }); editor.append(save, message);
    }; properties.onchange = () => { if (localFormDirty) { properties.value = propertySelection; report('Save or close the current property edit first.', true); return; } draw(); }; draw();
    const add = el('details'), summary = el('summary', '', 'Add property'), name = field('New property name'), type = el('select', 'input'); type.setAttribute('aria-label', 'New property type'); for (const t of ['rich_text', 'number', 'checkbox', 'date', 'select', 'multi_select', 'url', 'email', 'phone_number', 'people', 'files']) type.append(new Option(t.replaceAll('_', ' '), t)); name.input.oninput = () => { localFormDirty = true; }; const message = el('p', 'nbn-status'); const create = button('Add property to Notion', async () => { if (!name.input.value.trim()) return; if (props().some(p => p.name.toLocaleLowerCase() === name.input.value.trim().toLocaleLowerCase())) { message.textContent = 'A property with that name already exists.'; return; } create.disabled = true; try { await request('schema', { original: source, patch: { properties: { [name.input.value]: { type: type.value, [type.value]: {} } } } }, 'PATCH'); localFormDirty = false; await loadSource(); } catch (error) { message.textContent = (error as Error).message; } finally { create.disabled = false; } }); add.append(summary, name.label, type, create, message); inspector.append(add);
  }
  bindContextMenu(grid, event => {
    const target = (event.target as Element).closest<HTMLElement>('[data-property-id]'); if (!target) return; event.preventDefault(); event.stopPropagation(); target.focus();
    const rowId = target.dataset.rowId, propertyId = target.dataset.propertyId!;
    openMenu(event.clientX, event.clientY, menu => {
      if (rowId) { const row = rows.find(r => r.id === rowId); menu.append(menuItem('pen', 'Edit property', () => void editCell(rowId, propertyId)), menuItem('copy', 'Copy value', () => { void navigator.clipboard.writeText(readProp(rawValue(row ?? {}, propertyId)).text).then(() => report('Value copied.')).catch(() => report('Clipboard unavailable. Use the keyboard copy command.', true)); })); const url = safeUrl(row?.url); if (url) menu.append(menuItem('external', 'Open row in Notion', () => { window.open(url, '_blank', 'noopener,noreferrer'); })); }
      menu.append(menuItem('columns', 'Column settings', layoutEditor), menuItem('refresh', 'Refresh database', () => void loadSource()));
    });
  }, signal);
  window.addEventListener('focus', () => { if (source && !loading && !dirty()) void loadRows(true); }, { signal });
  function dirty(): boolean { const prefix = `${state.source?.workspaceId}/${state.source?.dataSourceId}/`; return writes.size > 0 || localFormDirty || [...drafts.keys()].some(k => k.startsWith(prefix)); }
  return {
    element,
    load(value) { const next = linkedState(value); generation++; clearQuery(); localFormDirty = false; state = next; if (state.source) void loadSource(true); else void picker(); },
    serialize() { return structuredClone(state); },
    text() { return state.source ? `Linked Notion database: ${state.source.title || state.source.dataSourceId}. Live rows are stored in Notion; this note contains a link, not database content.` : 'Linked Notion database (choose a database).'; },
    focus() { grid.querySelector<HTMLElement>('td,button,input')?.focus(); },
    dirty,
    async flush() { await Promise.allSettled([...writes]); if (!dirty()) return true; report('Save or discard the Notion draft before leaving this page.', true); return false; },
    destroy() { clearQuery(); disposed = true; generation++; controller.abort(); element.remove(); },
  };
}
