// The word-processor ribbon over the collaborative editor (note-editor.ts): the
// same tabs and copy as note-word.ts — Text, Paragraph, Insert, Layout, Review —
// run as ProseMirror transactions on the shared document, so every collaborator
// sees a font change, a table, a page break, a comment or a tracked change the
// moment it is made. Attached by note.ts while the collaborative editor runs.
import { Fragment, type Mark, type Node as PMNode } from 'prosemirror-model';
import { TextSelection, type Transaction } from 'prosemirror-state';
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, mergeCells, splitCell } from 'prosemirror-tables';
import { canSplit } from 'prosemirror-transform';
import { cleanStyle } from '../../lib/note-text.ts';
import { noteSchema as s } from '../../lib/note-schema.ts';
import { bindContextMenu, menuItem, openMenu } from './menu.ts';
import { askText, dialog } from './workspace-dialogs.ts';
import type { DocumentEditor } from './note-editor.ts';
import '../../styles/note-word.css';

interface RibbonOptions { editor: DocumentEditor; tools: HTMLElement; changed(): void; title(): string }
const escape = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** `key:value;…` with one rule replaced (or dropped when value is empty), through the shared allowlist. */
export const mergeStyle = (style: string, prop: string, value: string): string =>
  cleanStyle([...style.split(';').filter((r) => r && !r.trim().toLowerCase().startsWith(`${prop}:`)), value ? `${prop}:${value}` : ''].join(';'));
const styleValue = (style: string, prop: string): string => style.split(';').map((r) => r.split(':')).find(([k]) => k?.trim() === prop)?.[1]?.trim() ?? '';

export function attachWordRibbon({ editor, tools, changed: onChanged, title }: RibbonOptions) {
  const control = new AbortController(), signal = control.signal;
  const view = editor.view;
  let disposed = false;
  const ribbon = document.createElement('div'); ribbon.className = 'np-word np-adv';
  const tabs = document.createElement('div'); tabs.className = 'np-word-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Document tools'); ribbon.append(tabs); tools.append(ribbon);
  const notice = document.createElement('div'); notice.className = 'np-word-notice'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); ribbon.append(notice);
  const panels = new Map<string, HTMLElement>(); const tabButtons: HTMLButtonElement[] = [];
  const message = (text: string) => { notice.textContent = text; };
  const state = () => view.state;
  const dispatch = (tr: Transaction) => { view.dispatch(tr); onChanged(); };
  const selection = () => { const { from, to, empty } = state().selection; return { from, to, empty }; };

  function panel(name: string) {
    const p = document.createElement('div'); p.className = 'np-word-panel'; p.setAttribute('role', 'tabpanel'); p.id = `word-${crypto.randomUUID()}`; p.hidden = panels.size > 0;
    const b = document.createElement('button'); b.type = 'button'; b.textContent = name; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', p.id); b.setAttribute('aria-selected', String(!p.hidden)); b.tabIndex = p.hidden ? -1 : 0;
    b.addEventListener('click', () => { for (const [key, value] of panels) value.hidden = key !== name; for (const button of tabButtons) { button.setAttribute('aria-selected', String(button === b)); button.tabIndex = button === b ? 0 : -1; } }, { signal });
    b.addEventListener('keydown', (event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const i = tabButtons.indexOf(b), target = event.key === 'Home' ? 0 : event.key === 'End' ? tabButtons.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabButtons.length) % tabButtons.length; tabButtons[target]!.click(); tabButtons[target]!.focus(); }, { signal });
    tabs.append(b); tabButtons.push(b); panels.set(name, p); notice.before(p); return p;
  }
  function button(parent: HTMLElement, label: string, work: () => void | Promise<void>) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = label;
    b.addEventListener('mousedown', (event) => event.preventDefault(), { signal }); // the selection stays in the document
    b.addEventListener('click', () => { void Promise.resolve(work()).catch((error) => message(error instanceof Error ? error.message : 'Unable to complete this action.')); }, { signal });
    parent.append(b); return b;
  }
  function select(parent: HTMLElement, label: string, values: [string, string][], work: (value: string) => void) {
    const input = document.createElement('select'); input.setAttribute('aria-label', label); input.title = label;
    for (const [value, text] of values) { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); }
    input.addEventListener('change', () => work(input.value), { signal }); parent.append(input); return input;
  }

  // ---- marks and block attributes
  function styleSelection(prop: string, value: string) {
    const { from, to, empty } = selection();
    if (empty) { message('Select text to apply this formatting.'); return; }
    const base = (state().doc.resolve(from).marks().find((m) => m.type === s.marks.text_style)?.attrs.style as string) ?? '';
    const style = mergeStyle(base, prop, value);
    let tr = state().tr.removeMark(from, to, s.marks.text_style!);
    if (style) tr = tr.addMark(from, to, s.marks.text_style!.create({ style }));
    dispatch(tr); view.focus();
  }
  function paragraph(prop: string, value: string | ((current: string) => string)) {
    const { from, to } = selection();
    const tr = state().tr;
    state().doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock || !('style' in node.attrs)) return;
      const current = node.attrs.style as string;
      const next = typeof value === 'function' ? value(styleValue(current, prop)) : value;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, style: mergeStyle(current, prop, next) });
    });
    if (tr.docChanged) dispatch(tr);
    view.focus();
  }
  const toggle = (name: string) => { editor.cmd(name); onChanged(); };

  const text = panel('Text');
  const fontSelect = select(text, 'Font family', [['', 'Font'], ...['Arial', 'Calibri', 'Cambria', 'Georgia', 'Helvetica', 'Times New Roman', 'Courier New', 'Verdana', 'system-ui'].map((x) => [x, x] as [string, string])], (value) => { if (value) styleSelection('font-family', value); });
  select(text, 'Font size', [['', 'Size'], ...[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72].map((x) => [`${x}pt`, `${x} pt`] as [string, string])], (value) => { if (value) styleSelection('font-size', value); });
  for (const [property, label, initial] of [['color', 'Text color', '#202020'], ['background-color', 'Highlight', '#fff199']]) {
    const wrapper = document.createElement('label'); wrapper.textContent = label;
    const input = document.createElement('input'); input.type = 'color'; input.value = initial; input.setAttribute('aria-label', label);
    input.addEventListener('change', () => styleSelection(property, input.value), { signal });
    wrapper.append(input); text.append(wrapper);
  }
  button(text, 'Strikethrough', () => toggle('strikeThrough')); button(text, 'Subscript', () => toggle('subscript')); button(text, 'Superscript', () => toggle('superscript'));
  button(text, 'Clear formatting', () => { toggle('removeFormat'); paragraph('text-align', ''); });
  // The picker shows the font at the caret.
  const syncFont = () => { const style = (state().selection.$from.marks().find((m) => m.type === s.marks.text_style)?.attrs.style as string) ?? ''; const name = styleValue(style, 'font-family'); fontSelect.value = [...fontSelect.options].find((o) => o.value.toLowerCase() === name)?.value ?? ''; };
  document.addEventListener('selectionchange', syncFont, { signal });

  const para = panel('Paragraph');
  for (const value of ['left', 'center', 'right', 'justify']) button(para, value[0]!.toUpperCase() + value.slice(1), () => paragraph('text-align', value));
  select(para, 'Line spacing', [['', 'Line spacing'], ...[1, 1.15, 1.5, 1.75, 2, 2.5, 3].map((x) => [String(x), `${x} lines`] as [string, string])], (value) => { if (value) paragraph('line-height', value); });
  for (const side of ['top', 'bottom']) select(para, `Paragraph spacing ${side === 'top' ? 'before' : 'after'}`, [['', side === 'top' ? 'Before' : 'After'], ...[0, 3, 6, 8, 12, 18, 24].map((x) => [`${x}pt`, `${x} pt`] as [string, string])], (value) => { if (value) paragraph(`margin-${side}`, value); });
  button(para, 'Indent', () => paragraph('margin-left', (cur) => `${Math.min(192, (parseFloat(cur) || 0) + 24)}px`));
  button(para, 'Outdent', () => paragraph('margin-left', (cur) => { const n = Math.max(0, (parseFloat(cur) || 0) - 24); return n ? `${n}px` : ''; }));
  select(para, 'First line indent', [['', 'First line'], ['0mm', 'None'], ['12.7mm', 'Half inch'], ['-12.7mm', 'Hanging']], (value) => { if (value) paragraph('text-indent', value); });

  // ---- insert
  const insertBlock = (node: PMNode) => {
    const { $to } = state().selection;
    const pos = $to.depth >= 1 ? $to.after(1) : state().doc.content.size;
    const tr = state().tr.insert(pos, node);
    dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1))).scrollIntoView()); view.focus();
  };
  const tables = panel('Insert');
  button(tables, 'Table', async () => {
    const value = await askText('Table size: rows × columns (maximum 30 × 20)', '3 × 3');
    if (!value || disposed) return;
    const match = /^(\d+)\s*[x×,]\s*(\d+)$/.exec(value.trim());
    if (!match || +match[1]! < 1 || +match[1]! > 30 || +match[2]! < 1 || +match[2]! > 20) { message('Enter a size such as 3 × 3, up to 30 rows and 20 columns.'); return; }
    const cell = () => s.nodes.table_cell!.create(null, s.nodes.paragraph!.create());
    const rows = Array.from({ length: +match[1]! }, () => s.nodes.table_row!.create(null, Array.from({ length: +match[2]! }, cell)));
    insertBlock(s.nodes.table!.create({ style: 'width:100%' }, rows));
  });
  const tableActions: Record<string, () => void> = {
    'row-above': () => run(addRowBefore), 'row-below': () => run(addRowAfter), 'column-before': () => run(addColumnBefore), 'column-after': () => run(addColumnAfter),
    'delete-row': () => run(deleteRow), 'delete-column': () => run(deleteColumn), merge: () => run(mergeCells), split: () => run(splitCell), 'delete-table': () => run(deleteTable),
  };
  function run(command: (st: typeof view.state, d?: typeof view.dispatch) => boolean) {
    if (!command(state(), (tr) => dispatch(tr))) throw new Error('Place the cursor in a table cell first (merge and split need a cell selection).');
    view.focus();
  }
  const tableMenu = select(tables, 'Table actions', [['', 'Table actions'], ['row-above', 'Row above'], ['row-below', 'Row below'], ['column-before', 'Column left'], ['column-after', 'Column right'], ['delete-row', 'Delete row'], ['delete-column', 'Delete column'], ['merge', 'Merge selected cells'], ['split', 'Split cell'], ['delete-table', 'Delete table']], (value) => { try { tableActions[value]?.(); } catch (e) { message((e as Error).message); } tableMenu.value = ''; });
  const insertImage = (src: string, alt: string) => { dispatch(state().tr.replaceSelectionWith(s.nodes.image!.create({ src, alt, style: 'max-width:100%;height:auto' })).scrollIntoView()); view.focus(); };
  button(tables, 'Image URL', async () => {
    const url = await askText('Image URL (https://)');
    if (!url || disposed) return;
    let valid: URL; try { valid = new URL(url); if (!['https:', 'http:'].includes(valid.protocol)) throw new Error(); } catch { message('Enter an HTTP or HTTPS image URL.'); return; }
    const alt = await askText('Describe this image for accessibility', 'Image');
    if (alt === null || disposed) return;
    insertImage(valid.href, alt);
  });
  const imageFile = document.createElement('input'); imageFile.type = 'file'; imageFile.accept = 'image/png,image/jpeg,image/webp,image/gif'; imageFile.hidden = true; tables.append(imageFile);
  button(tables, 'Image file', () => imageFile.click());
  imageFile.addEventListener('change', async () => {
    const file = imageFile.files?.[0]; imageFile.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 3_000_000) { message('Choose a PNG, JPEG, WebP or GIF image under 3 MB.'); return; }
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); }).catch(() => '');
    if (!data || disposed) return;
    const alt = await askText('Describe this image for accessibility', file.name);
    if (alt === null || disposed) return;
    insertImage(data, alt);
  }, { signal });
  button(tables, 'Horizontal rule', () => insertBlock(s.nodes.horizontal_rule!.create()));

  // ---- layout: pages
  const pages = () => { const out: { node: PMNode; pos: number }[] = []; state().doc.forEach((node, pos) => { if (node.type === s.nodes.page) out.push({ node, pos }); }); return out; };
  const pageAt = () => { const { $from } = state().selection; for (let d = 1; d <= $from.depth; d++) if ($from.node(d).type === s.nodes.page) return { node: $from.node(d), pos: $from.before(d) }; return pages()[0]; };
  const layout = panel('Layout');
  const pageSize = select(layout, 'Paper size', [['letter', 'Letter'], ['a4', 'A4']], () => applyPage());
  const orientation = select(layout, 'Page orientation', [['portrait', 'Portrait'], ['landscape', 'Landscape']], () => applyPage());
  const margins = select(layout, 'Page margins', [['20', 'Normal margins'], ['12.7', 'Narrow margins'], ['25.4', 'One-inch margins'], ['32', 'Wide margins']], () => applyPage());
  const pageAttrs = (style: string) => {
    const paper = `${pageSize.value}-${orientation.value}`;
    const width = pageSize.value === 'a4' ? (orientation.value === 'landscape' ? 297 : 210) : orientation.value === 'landscape' ? 279 : 216;
    return { paper, style: mergeStyle(mergeStyle(style, 'width', `${width}mm`), 'padding', `${margins.value}mm`) };
  };
  /** Every top-level block inside one page when there is none yet. */
  function ensurePage(tr: Transaction): Transaction {
    if (pages().length) return tr;
    const content = tr.doc.content;
    return tr.replaceWith(0, tr.doc.content.size, s.nodes.page!.create(pageAttrs(''), content));
  }
  function applyPage() {
    let tr = ensurePage(state().tr);
    tr.doc.forEach((node, pos) => { if (node.type === s.nodes.page) tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...pageAttrs(node.attrs.style as string) }); });
    dispatch(tr); view.focus();
  }
  button(layout, 'Page break', () => {
    let tr = ensurePage(state().tr);
    const $from = tr.doc.resolve(tr.mapping.map(state().selection.from));
    let depth = 0; for (let d = 1; d <= $from.depth; d++) if ($from.node(d).type === s.nodes.page) depth = d;
    if (!depth || $from.depth <= depth) { message('Place the cursor in a paragraph to break the page there.'); return; }
    const page = $from.node(depth);
    const at = $from.before(depth + 1);
    const after = [{ type: s.nodes.page!, attrs: { ...page.attrs, style: mergeStyle(page.attrs.style as string, 'page-break-before', 'always') } }];
    if (!canSplit(tr.doc, at, 1, after)) { message('A page cannot start with nothing on it.'); return; }
    dispatch(tr.split(at, 1, after).scrollIntoView()); view.focus();
  });
  for (const part of ['header', 'footer'] as const) button(layout, part === 'header' ? 'Edit header' : 'Edit footer', () => {
    let tr = ensurePage(state().tr);
    const page = pageAt() ?? (() => { let p: { node: PMNode; pos: number } | undefined; tr.doc.forEach((node, pos) => { if (!p && node.type === s.nodes.page) p = { node, pos }; }); return p; })();
    if (!page) return;
    const type = part === 'header' ? s.nodes.page_header! : s.nodes.page_footer!;
    const live = tr.doc.nodeAt(tr.mapping.map(page.pos))!;
    const pos = tr.mapping.map(page.pos);
    const existing = part === 'header' ? (live.firstChild?.type === type ? pos + 1 : null) : live.lastChild?.type === type ? pos + live.nodeSize - 1 - live.lastChild.nodeSize : null;
    let at = existing;
    if (at === null) {
      const region = type.create(null, s.nodes.paragraph!.create(null, s.text(part === 'header' ? title() || 'Header' : 'Footer')));
      at = part === 'header' ? pos + 1 : pos + live.nodeSize - 1;
      tr = tr.insert(at, region);
    }
    dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2))).scrollIntoView()); view.focus();
  });
  button(layout, 'Page number', () => { dispatch(state().tr.replaceSelectionWith(s.nodes.page_number!.create({ n: String((pageAt() ? pages().findIndex((p) => p.pos === pageAt()!.pos) : 0) + 1) }))); view.focus(); });
  const syncPage = () => { const page = pageAt(); if (!page) return; const [size, direction] = String(page.node.attrs.paper).split('-'); pageSize.value = size!; orientation.value = direction!; margins.value = String(parseFloat(styleValue(page.node.attrs.style as string, 'padding')) || 20); };
  document.addEventListener('selectionchange', syncPage, { signal });

  // ---- review
  /** Every inline range carrying a mark of `type` (merged across adjacent text nodes). */
  const ranges = (type: typeof s.marks.comment, within?: { from: number; to: number }) => {
    const out: { from: number; to: number; mark: Mark }[] = [];
    state().doc.nodesBetween(within?.from ?? 0, within?.to ?? state().doc.content.size, (node, pos) => {
      if (!node.isInline) return;
      const mark = node.marks.find((m) => m.type === type);
      if (!mark) return;
      const last = out.at(-1);
      if (last && last.to === pos && last.mark.eq(mark)) last.to = pos + node.nodeSize; else out.push({ from: pos, to: pos + node.nodeSize, mark });
    });
    return out;
  };
  const review = panel('Review');
  button(review, 'Find / Replace', () => findDialog());
  button(review, 'Add comment', async () => {
    const { from, to, empty } = selection();
    if (empty) { message('Select the passage to comment on.'); return; }
    const value = await askText('Comment');
    if (!value || disposed) return;
    dispatch(state().tr.addMark(from, to, s.marks.comment!.create({ comment: value.slice(0, 4000), author: editor.track.author }))); view.focus();
  });
  button(review, 'Comments', () => commentsDialog());
  const trackButton = button(review, 'Track changes', () => { editor.track.on = !editor.track.on; trackButton.setAttribute('aria-pressed', String(editor.track.on)); message(editor.track.on ? 'Tracking what you type, paste and delete. Formatting and structural edits apply directly.' : 'Track changes off.'); });
  trackButton.setAttribute('aria-pressed', 'false');
  button(review, 'Author', async () => { const value = await askText('Name used for new comments and changes', editor.track.author); if (value) editor.track.author = value.slice(0, 100); });
  function resolveChanges(accept: boolean, all: boolean) {
    const within = all ? undefined : selection();
    const ins = ranges(s.marks.ins_change!, within), del = ranges(s.marks.del_change!, within);
    if (!ins.length && !del.length) throw new Error('Place the cursor in a tracked change or select it first.');
    const tr = state().tr.setMeta('track', true);
    // Accept: insertions stay (unmarked), deletions go. Reject: the reverse. Removals from the end keep positions valid.
    const remove = (accept ? del : ins).sort((a, b) => b.from - a.from);
    const keep = accept ? ins : del;
    for (const r of keep) tr.removeMark(r.from, r.to, r.mark.type);
    for (const r of remove) tr.delete(tr.mapping.map(r.from), tr.mapping.map(r.to));
    dispatch(tr); view.focus();
  }
  for (const accept of [true, false]) { button(review, accept ? 'Accept change' : 'Reject change', () => resolveChanges(accept, false)); button(review, accept ? 'Accept all' : 'Reject all', () => resolveChanges(accept, true)); }

  /** The document's text with a map from text index to document position. */
  const textRuns = () => {
    let text = ''; const runs: { start: number; end: number; pos: number }[] = [];
    state().doc.descendants((node, pos) => {
      if (node.isText) { runs.push({ start: text.length, end: text.length + node.text!.length, pos }); text += node.text; }
      else if (node.isBlock && text && !text.endsWith('\n')) text += '\n';
      return true;
    });
    return { text, runs, posAt: (i: number) => { const r = runs.find((x) => i >= x.start && i <= x.end); return r ? r.pos + (i - r.start) : null; } };
  };
  function findDialog() {
    const { d, form, actions, submit, error } = dialog('Find and replace'); submit.textContent = 'Find next';
    const query = document.createElement('input'), replacementInput = document.createElement('input'), matchCase = document.createElement('input'), caseLabel = document.createElement('label');
    query.placeholder = 'Find'; query.setAttribute('aria-label', 'Find text'); query.required = true; replacementInput.placeholder = 'Replace with'; replacementInput.setAttribute('aria-label', 'Replacement text'); matchCase.type = 'checkbox'; caseLabel.append(matchCase, ' Match case');
    actions.before(query, replacementInput, caseLabel);
    let searchAt = 0, found: { from: number; to: number } | null = null;
    const matches = (limit = Infinity) => {
      const { text, posAt } = textRuns(); const needle = query.value; if (!needle) return [];
      const hay = matchCase.checked ? text : text.toLocaleLowerCase(), term = matchCase.checked ? needle : needle.toLocaleLowerCase();
      const out: { from: number; to: number; at: number }[] = [];
      for (let i = hay.indexOf(term); i >= 0 && out.length < limit; i = hay.indexOf(term, i + needle.length)) { const from = posAt(i), to = posAt(i + needle.length); if (from !== null && to !== null) out.push({ from, to, at: i }); }
      return out;
    };
    function find() {
      const all = matches(); const next = all.find((m) => m.at >= searchAt) ?? all[0];
      if (!next) { found = null; error.textContent = 'No matches.'; error.hidden = false; return; }
      found = next; searchAt = next.at + query.value.length;
      view.dispatch(state().tr.setSelection(TextSelection.create(state().doc, next.from, next.to)).scrollIntoView());
      error.hidden = true;
    }
    form.addEventListener('submit', (event) => { event.preventDefault(); find(); }, { signal });
    button(actions, 'Replace', () => { if (!found) { find(); return; } dispatch(state().tr.insertText(replacementInput.value, found.from, found.to)); found = null; find(); });
    button(actions, 'Replace all', () => {
      const all = matches(1001);
      if (all.length > 1000) { error.textContent = 'Replace at most 1,000 matches at a time.'; error.hidden = false; return; }
      const tr = state().tr;
      for (const m of all.sort((a, b) => b.from - a.from)) tr.insertText(replacementInput.value, m.from, m.to);
      if (all.length) dispatch(tr);
      error.textContent = `Replaced ${all.length} matches.`; error.hidden = false; found = null; searchAt = 0;
    });
    d.addEventListener('close', () => { if (!d.open) d.remove(); }); query.focus();
  }
  function commentsDialog() {
    const { d, form, actions, submit } = dialog('Comments'); submit.textContent = 'Done';
    const list = document.createElement('div'); list.className = 'np-word-comments';
    const comments = ranges(s.marks.comment!);
    if (!comments.length) list.textContent = 'No comments in this document.';
    for (const c of comments) {
      const item = document.createElement('article'), who = document.createElement('strong'), quote = document.createElement('blockquote'), body = document.createElement('p');
      who.textContent = (c.mark.attrs.author as string) || 'Comment'; quote.textContent = state().doc.textBetween(c.from, c.to, ' '); body.textContent = c.mark.attrs.comment as string;
      item.append(who, quote, body);
      button(item, 'Go to passage', () => { d.close(); view.dispatch(state().tr.setSelection(TextSelection.create(state().doc, c.from, c.to)).scrollIntoView()); view.focus(); });
      button(item, 'Resolve', () => { const live = ranges(s.marks.comment!).find((r) => r.mark.eq(c.mark)); if (live) dispatch(state().tr.removeMark(live.from, live.to, s.marks.comment!)); item.remove(); });
      list.append(item);
    }
    actions.before(list);
    form.addEventListener('submit', (event) => { event.preventDefault(); d.close(); }, { signal });
    d.addEventListener('close', () => { if (!d.open) d.remove(); });
  }

  // ---- the context menu over the document
  bindContextMenu(view.dom, (event) => {
    if (event.shiftKey || !view.editable) return; // Shift-right-click keeps the browser's spelling menu
    const target = event.target instanceof Element ? event.target : null;
    if (event.detail !== -1) { const at = view.posAtCoords({ left: event.clientX, top: event.clientY }); if (at && state().selection.empty) view.dispatch(state().tr.setSelection(TextSelection.create(state().doc, at.pos))); }
    event.preventDefault(); event.stopPropagation();
    const { from, to, empty } = selection();
    openMenu(event.clientX, event.clientY, (menu) => {
      const hint = document.createElement('div'); hint.className = 'ctx-label'; hint.textContent = 'Native spelling menu: Shift + right-click'; menu.append(hint);
      const clipboard = async (action: 'copy' | 'cut' | 'paste') => {
        try {
          if (action === 'paste') { const value = await navigator.clipboard.readText(); if (!disposed) { editor.insertText(value); onChanged(); } }
          else { await navigator.clipboard.writeText(state().doc.textBetween(from, to, '\n')); if (action === 'cut' && !disposed) dispatch(state().tr.deleteSelection()); }
        } catch { message('Clipboard unavailable. Use the keyboard shortcut or Shift + right-click for the native menu.'); }
      };
      for (const action of ['copy', 'cut', 'paste'] as const) { const item = menuItem('copy', `${action[0]!.toUpperCase() + action.slice(1)}${action === 'paste' ? ' plain text' : ' text'}`, () => void clipboard(action)) as HTMLButtonElement; item.disabled = action !== 'paste' && empty; menu.append(item); }
      menu.append(menuItem('list', 'Select all', () => { view.dispatch(state().tr.setSelection(TextSelection.create(state().doc, 0, state().doc.content.size))); view.focus(); }));
      for (const [command, label] of [['undo', 'Undo'], ['redo', 'Redo'], ['bold', 'Bold'], ['italic', 'Italic'], ['underline', 'Underline'], ['strikeThrough', 'Strikethrough'], ['removeFormat', 'Clear formatting'], ['insertUnorderedList', 'Bullet list'], ['insertOrderedList', 'Numbered list']]) menu.append(menuItem('pen', label!, () => toggle(command!)));
      const link = state().selection.$from.marks().find((m) => m.type === s.marks.link);
      menu.append(menuItem('link', link ? 'Edit link…' : 'Add link…', () => { void (async () => {
        const value = await askText('Link URL (https:// or mailto:)', (link?.attrs.href as string) ?? 'https://');
        if (!value || disposed) return;
        if (!/^(https?:\/\/|mailto:)/i.test(value)) return message('Use an HTTP, HTTPS, or mailto link.');
        if (empty && link) { const r = ranges(s.marks.link!).find((x) => x.from <= from && x.to >= from); if (r) view.dispatch(state().tr.setSelection(TextSelection.create(state().doc, r.from, r.to))); }
        editor.cmd('createLink', value); onChanged();
      })(); }));
      if (link) {
        menu.append(menuItem('link', 'Open link', () => { if (/^(https?:|mailto:)/i.test(link.attrs.href as string)) window.open(link.attrs.href as string, '_blank', 'noopener,noreferrer'); }));
        menu.append(menuItem('close', 'Remove link', () => { const r = ranges(s.marks.link!).find((x) => x.from <= from && x.to >= from); if (r) dispatch(state().tr.removeMark(r.from, r.to, s.marks.link!)); }));
      }
      for (const label of ['Add comment', 'Comments', 'Accept change', 'Reject change', 'Find / Replace']) { const b = [...review.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === label); if (b) menu.append(menuItem('pen', label, () => b.click())); }
      if (target?.closest('td,th')) for (const option of [...tableMenu.options].filter((o) => o.value)) menu.append(menuItem(option.value.startsWith('delete') ? 'trash' : 'database', option.text, () => { try { tableActions[option.value]?.(); } catch (e) { message((e as Error).message); } }, option.value.startsWith('delete')));
      const image = target?.closest('img');
      if (image) menu.append(menuItem('trash', 'Remove image', () => { const pos = view.posAtDOM(image, 0); dispatch(state().tr.delete(pos, pos + 1)); }, true));
    });
  }, signal);

  return { destroy() { disposed = true; control.abort(); ribbon.remove(); } };
}
