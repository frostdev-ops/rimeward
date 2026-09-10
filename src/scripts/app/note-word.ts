import { bindContextMenu, menuItem, openMenu } from './menu.ts';
import { askText, dialog } from './workspace-dialogs.ts';
import { sanitizeHtml } from '../../lib/note-text.ts';
import '../../styles/note-word.css';

interface WordOptions { doc: HTMLElement; tools: HTMLElement; changed(): void; title(): string; identity(): string }
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function attachWordEditor({ doc, tools, changed: onChanged, title, identity }: WordOptions) {
  const control = new AbortController(), signal = control.signal;
  let saved: Range | null = null, tracking = false, internal = false, composing = false, author = 'You', disposed = false;
  let compositionDeleted = '', compositionStart = 0;
  const ribbon = document.createElement('div'); ribbon.className = 'np-word np-adv';
  const tabs = document.createElement('div'); tabs.className = 'np-word-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Document tools'); ribbon.append(tabs); tools.append(ribbon);
  const notice = document.createElement('div'); notice.className = 'np-word-notice'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); ribbon.append(notice);
  const panels = new Map<string, HTMLElement>(); const tabButtons: HTMLButtonElement[] = [];
  function message(text: string) { notice.textContent = text; }
  function currentRange() { const selection = window.getSelection(); if (selection?.rangeCount) { const range = selection.getRangeAt(0); if (doc.contains(range.commonAncestorContainer)) return range.cloneRange(); } return saved && doc.contains(saved.commonAncestorContainer) ? saved.cloneRange() : null; }
  function remember() { const range = currentRange(); if (range) saved = range; }
  function restore(range = saved) { doc.focus(); const selection = window.getSelection(); if (range && doc.contains(range.commonAncestorContainer)) { selection?.removeAllRanges(); selection?.addRange(range); } else { const next = document.createRange(); next.selectNodeContents(doc); next.collapse(false); selection?.removeAllRanges(); selection?.addRange(next); } }
  function offset(range: Range, end = false) { const before = document.createRange(); before.selectNodeContents(doc); before.setEnd(end ? range.endContainer : range.startContainer, end ? range.endOffset : range.startOffset); return before.toString().length; }
  function textRange(start: number, end: number) { const range = document.createRange(), walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT); let count = 0, first = false; while (walker.nextNode()) { const node = walker.currentNode, length = node.textContent?.length ?? 0; if (!first && start <= count + length) { range.setStart(node, Math.max(0, start - count)); first = true; } if (first && end <= count + length) { range.setEnd(node, Math.max(0, end - count)); return range; } count += length; } if (!first) { range.selectNodeContents(doc); range.collapse(false); } else range.setEnd(doc, doc.childNodes.length); return range; }
  function native(command: string, value?: string) { if (command === 'undo' || command === 'redo') { history(command); return; } restore(); internal = true; try { document.execCommand('styleWithCSS', false, 'true'); document.execCommand(command, false, value); } finally { internal = false; } remember(); changed(); refresh(); }
  function insert(html: string, range = currentRange()) { restore(range); internal = true; try { document.execCommand('insertHTML', false, html); } finally { internal = false; } remember(); changed(); refresh(); }
  // Editing a page is a DOM update, not pasting the whole document inside its current block.
  // ponytail: full-document undo is bounded to 40 entries / 16 MiB per stack; use incremental transactions if large-document typing becomes slow.
  type Snapshot = { html: string; start: number; end: number };
  const undo: Snapshot[] = [], redo: Snapshot[] = [];
  let historyIdentity = identity(), restoring = false;
  const snapshot = (): Snapshot => { const range = currentRange(); return { html: doc.innerHTML.replace(/ title="[^"]*"/g, ''), start: range ? offset(range) : 0, end: range ? offset(range, true) : 0 }; };
  let baseline = snapshot();
  function push(stack: Snapshot[], value: Snapshot) {
    stack.push(value); let size = stack.reduce((n, item) => n + item.html.length, 0);
    while (stack.length > 1 && (stack.length > 40 || size > 16 * 1024 * 1024)) size -= stack.shift()!.html.length;
  }
  function record() {
    const next = snapshot(), key = identity();
    if (key !== historyIdentity) { historyIdentity = key; undo.length = redo.length = 0; baseline = next; return; }
    if (next.html === baseline.html) return;
    if (!restoring) { push(undo, baseline); redo.length = 0; }
    baseline = next;
  }
  function changed() { record(); onChanged(); }
  function history(direction: 'undo' | 'redo'): void {
    record(); const source = direction === 'undo' ? undo : redo, target = direction === 'undo' ? redo : undo;
    const value = source.pop(); if (!value) return;
    push(target, snapshot()); restoring = true;
    try { doc.innerHTML = value.html; baseline = value; refresh(); saved = textRange(value.start, value.end); restore(); onChanged(); }
    finally { restoring = false; baseline = snapshot(); }
  }
  function repairPages(): boolean {
    let repaired = false;
    for (const page of [...doc.querySelectorAll<HTMLElement>('[data-word-page]')]) {
      if (page.querySelector('[data-word-page]')) { page.replaceWith(...page.childNodes); repaired = true; }
    }
    return repaired;
  }
  function mutate(work: () => void) {
    restore(); record(); const before = snapshot();
    try {
      work(); repairPages();
      saved = textRange(before.start, before.end); restore(); changed(); refresh();
    } catch (error) { doc.innerHTML = before.html; saved = textRange(before.start, before.end); restore(); message(error instanceof Error ? error.message : 'Unable to edit this selection.'); }
  }
  function panel(name: string) { const p = document.createElement('div'); p.className = 'np-word-panel'; p.setAttribute('role', 'tabpanel'); p.id = `word-${crypto.randomUUID()}`; p.hidden = panels.size > 0; const b = document.createElement('button'); b.type = 'button'; b.textContent = name; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', p.id); b.setAttribute('aria-selected', String(!p.hidden)); b.tabIndex = p.hidden ? -1 : 0; b.addEventListener('click', () => { for (const [key, value] of panels) value.hidden = key !== name; for (const button of tabButtons) { button.setAttribute('aria-selected', String(button === b)); button.tabIndex = button === b ? 0 : -1; } }, { signal }); b.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const i = tabButtons.indexOf(b), target = event.key === 'Home' ? 0 : event.key === 'End' ? tabButtons.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabButtons.length) % tabButtons.length; tabButtons[target].click(); tabButtons[target].focus(); }, { signal }); tabs.append(b); tabButtons.push(b); panels.set(name, p); notice.before(p); return p; }
  function button(parent: HTMLElement, label: string, work: () => void | Promise<void>) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = label; b.addEventListener('mousedown', event => { remember(); event.preventDefault(); }, { signal }); b.addEventListener('click', () => { void Promise.resolve(work()).catch(error => message(error instanceof Error ? error.message : 'Unable to complete this action.')); }, { signal }); parent.append(b); return b; }
  function select(parent: HTMLElement, label: string, values: [string, string][], work: (value: string) => void) { const input = document.createElement('select'); input.setAttribute('aria-label', label); input.title = label; for (const [value, text] of values) { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); } input.addEventListener('pointerdown', remember, { signal }); input.addEventListener('change', () => work(input.value), { signal }); parent.append(input); return input; }
  function styleSelection(property: string, value: string) { restore(); const range = currentRange(); if (!range || range.collapsed) { message('Select text to apply this formatting.'); return; } const span = document.createElement('span'); span.style.setProperty(property, value); span.append(range.cloneContents()); insert(span.outerHTML, range); }
  function blocks() { const range = currentRange(); if (!range) return []; const elements = [...doc.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th')].filter(el => range.intersectsNode(el) && !el.querySelector('p,h1,h2,h3,h4,h5,h6,li')); if (elements.length) return elements; native('formatBlock', 'p'); const node = currentRange()?.startContainer; const block = (node instanceof HTMLElement ? node : node?.parentElement)?.closest<HTMLElement>('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th'); return block ? [block] : []; }
  function paragraph(property: string, value: string) { mutate(() => { for (const block of blocks()) block.style.setProperty(property, value); }); }
  const text = panel('Text');
  select(text, 'Font family', [['', 'Font'], ...['Arial', 'Calibri', 'Cambria', 'Georgia', 'Helvetica', 'Times New Roman', 'Courier New', 'Verdana', 'system-ui'].map(x => [x, x] as [string, string])], value => { if (value) native('fontName', value); });
  select(text, 'Font size', [['', 'Size'], ...[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72].map(x => [`${x}pt`, `${x} pt`] as [string, string])], value => { if (value) styleSelection('font-size', value); });
  for (const [property, label, initial] of [['color', 'Text color', '#202020'], ['background-color', 'Highlight', '#fff199']]) { const wrapper = document.createElement('label'); wrapper.textContent = label; const input = document.createElement('input'); input.type = 'color'; input.value = initial; input.setAttribute('aria-label', label); input.addEventListener('pointerdown', remember, { signal }); input.addEventListener('change', () => styleSelection(property, input.value), { signal }); wrapper.append(input); text.append(wrapper); }
  button(text, 'Strikethrough', () => native('strikeThrough')); button(text, 'Subscript', () => native('subscript')); button(text, 'Superscript', () => native('superscript')); button(text, 'Clear formatting', () => native('removeFormat'));
  const para = panel('Paragraph');
  for (const value of ['left', 'center', 'right', 'justify']) button(para, value[0].toUpperCase() + value.slice(1), () => paragraph('text-align', value));
  select(para, 'Line spacing', [['', 'Line spacing'], ...[1, 1.15, 1.5, 1.75, 2, 2.5, 3].map(x => [String(x), `${x} lines`] as [string, string])], value => { if (value) paragraph('line-height', value); });
  for (const side of ['top', 'bottom']) select(para, `Paragraph spacing ${side === 'top' ? 'before' : 'after'}`, [['', side === 'top' ? 'Before' : 'After'], ...[0, 3, 6, 8, 12, 18, 24].map(x => [`${x}pt`, `${x} pt`] as [string, string])], value => { if (value) paragraph(`margin-${side}`, value); });
  button(para, 'Indent', () => mutate(() => { for (const b of blocks()) b.style.marginLeft = `${Math.min(192, parseFloat(b.style.marginLeft || '0') + 24)}px`; })); button(para, 'Outdent', () => mutate(() => { for (const b of blocks()) b.style.marginLeft = `${Math.max(0, parseFloat(b.style.marginLeft || '0') - 24)}px`; }));
  select(para, 'First line indent', [['', 'First line'], ['0mm', 'None'], ['12.7mm', 'Half inch'], ['-12.7mm', 'Hanging']], value => { if (value) paragraph('text-indent', value); });
  const tables = panel('Insert');
  button(tables, 'Table', async () => { remember(); const generation = identity(); const value = await askText('Table size: rows × columns (maximum 30 × 20)', '3 × 3'); if (!value || disposed || generation !== identity()) return; const match = /^(\d+)\s*[x×,]\s*(\d+)$/.exec(value.trim()); if (!match || +match[1] < 1 || +match[1] > 30 || +match[2] < 1 || +match[2] > 20) { message('Enter a size such as 3 × 3, up to 30 rows and 20 columns.'); return; } insert(`<table style="width:100%"><tbody>${Array.from({ length: +match[1] }, () => `<tr>${'<td><p><br></p></td>'.repeat(+match[2])}</tr>`).join('')}</tbody></table><p><br></p>`); });
  function selectedCell() { const node = currentRange()?.startContainer; return (node instanceof Element ? node : node?.parentElement)?.closest<HTMLTableCellElement>('td,th') ?? null; }
  function tableAction(action: string) { mutate(() => { const cell = selectedCell(), table = cell?.closest('table'); if (!cell || !table) throw new Error('Place the cursor in a table cell first.'); const row = cell.parentElement as HTMLTableRowElement; if (action === 'delete-table') { table.remove(); return; }
    if (action === 'merge') { const range = currentRange(); if (!range || range.collapsed) throw new Error('Select adjacent cells in one row to merge.'); const cells = [...row.cells].filter(c => range.intersectsNode(c)); if ([...table.rows].some(other => other !== row && [...other.cells].some(c => range.intersectsNode(c)))) throw new Error('Merge cells within one row at a time.'); if (cells.length < 2 || cells.some(c => c.rowSpan !== 1)) throw new Error('Select at least two adjacent cells in one unmerged row.'); const first = cells[0]; first.colSpan = cells.reduce((sum, c) => sum + c.colSpan, 0); for (const next of cells.slice(1)) { first.append(...next.childNodes); next.remove(); } return; }
    if (action === 'split') { const colspan = cell.colSpan, rowspan = cell.rowSpan; if (rowspan > 1) throw new Error('Split supports horizontal merged cells.'); cell.colSpan = 1; for (let n = 1; n < colspan; n++) { const next = document.createElement(cell.tagName.toLowerCase()); next.innerHTML = '<p><br></p>'; cell.after(next); } return; }
    if ([...table.querySelectorAll('td,th')].some(c => (c as HTMLTableCellElement).rowSpan > 1 || (c as HTMLTableCellElement).colSpan > 1)) throw new Error('Split merged cells before adding or deleting rows and columns.');
    if (action === 'row-above' || action === 'row-below') { if (table.rows.length >= 200) throw new Error('Table limit: 200 rows.'); const next = row.cloneNode(true) as HTMLTableRowElement; for (const c of next.cells) c.innerHTML = '<p><br></p>'; action === 'row-above' ? row.before(next) : row.after(next); }
    if (action === 'column-before' || action === 'column-after') { if (row.cells.length >= 52) throw new Error('Table limit: 52 columns.'); const index = cell.cellIndex; for (const r of table.rows) { const near = r.cells[index]; if (!near) continue; const next = document.createElement(near.tagName.toLowerCase()); next.innerHTML = '<p><br></p>'; action === 'column-before' ? near.before(next) : near.after(next); } }
    if (action === 'delete-row') { if (table.rows.length === 1) table.remove(); else row.remove(); }
    if (action === 'delete-column') { const index = cell.cellIndex; if (row.cells.length === 1) table.remove(); else for (const r of table.rows) r.cells[index]?.remove(); }
  }); }
  const tableMenu = select(tables, 'Table actions', [['', 'Table actions'], ['row-above', 'Row above'], ['row-below', 'Row below'], ['column-before', 'Column left'], ['column-after', 'Column right'], ['delete-row', 'Delete row'], ['delete-column', 'Delete column'], ['merge', 'Merge selected cells'], ['split', 'Split cell'], ['delete-table', 'Delete table']], value => { if (value) tableAction(value); tableMenu.value = ''; });
  button(tables, 'Image URL', async () => { remember(); const generation = identity(); const url = await askText('Image URL (https://)'); if (!url || disposed || generation !== identity()) return; let valid: URL; try { valid = new URL(url); if (!['https:', 'http:'].includes(valid.protocol)) throw new Error(); } catch { message('Enter an HTTP or HTTPS image URL.'); return; } const alt = await askText('Describe this image for accessibility', 'Image'); if (alt === null || disposed || generation !== identity()) return; insert(`<img src="${escape(valid.href)}" alt="${escape(alt)}" style="max-width:100%;height:auto">`); });
  let imageIdentity = '';
  const imageFile = document.createElement('input'); imageFile.type = 'file'; imageFile.accept = 'image/png,image/jpeg,image/webp,image/gif'; imageFile.hidden = true; tables.append(imageFile);
  button(tables, 'Image file', () => { remember(); imageIdentity = identity(); imageFile.click(); });
  imageFile.addEventListener('change', async () => { const generation = imageIdentity; const file = imageFile.files?.[0]; imageFile.value = ''; if (!file || generation !== identity()) return; if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 3_000_000) { message('Choose a PNG, JPEG, WebP or GIF image under 3 MB.'); return; } const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); }).catch(() => ''); if (!data || disposed || generation !== identity()) return; const alt = await askText('Describe this image for accessibility', file.name); if (alt === null || disposed || generation !== identity()) return; insert(`<img src="${escape(data)}" alt="${escape(alt)}" style="max-width:100%;height:auto">`); }, { signal });
  button(tables, 'Horizontal rule', () => insert('<hr><p><br></p>'));
  const layout = panel('Layout');
  function pageAt() { const node = currentRange()?.startContainer; return (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-word-page]') ?? doc.querySelector<HTMLElement>('[data-word-page]'); }
  function ensurePage() { let page = pageAt(); if (!page) { page = document.createElement('section'); page.dataset.wordPage = 'letter-portrait'; page.style.width = '216mm'; page.style.padding = '20mm'; while (doc.firstChild) page.append(doc.firstChild); if (!page.childNodes.length) page.innerHTML = '<p><br></p>'; doc.append(page); } return page; }
  const pageSize = select(layout, 'Paper size', [['letter', 'Letter'], ['a4', 'A4']], () => applyPage());
  const orientation = select(layout, 'Page orientation', [['portrait', 'Portrait'], ['landscape', 'Landscape']], () => applyPage());
  const margins = select(layout, 'Page margins', [['20', 'Normal margins'], ['12.7', 'Narrow margins'], ['25.4', 'One-inch margins'], ['32', 'Wide margins']], () => applyPage());
  function applyPage() { mutate(() => { repairPages(); ensurePage(); for (const page of doc.querySelectorAll<HTMLElement>('[data-word-page]')) { page.dataset.wordPage = `${pageSize.value}-${orientation.value}`; page.style.width = `${pageSize.value === 'a4' ? orientation.value === 'landscape' ? 297 : 210 : orientation.value === 'landscape' ? 279 : 216}mm`; page.style.padding = `${margins.value}mm`; } }); }
  button(layout, 'Page break', () => mutate(() => { const range = currentRange(); const page = ensurePage(); const next = page.cloneNode(false) as HTMLElement; if (range && page.contains(range.startContainer)) { const tail = range.cloneRange(); tail.setEnd(page, page.childNodes.length); next.append(tail.extractContents()); } if (!next.childNodes.length) next.innerHTML = '<p><br></p>'; next.style.pageBreakBefore = 'always'; page.after(next); }));
  for (const part of ['header', 'footer'] as const) button(layout, part === 'header' ? 'Edit header' : 'Edit footer', () => { mutate(() => { const page = ensurePage(); let region = page.querySelector<HTMLElement>(`[data-word-${part}]`); if (!region) { region = document.createElement(part); region.setAttribute(`data-word-${part}`, 'true'); region.innerHTML = `<p>${part === 'header' ? escape(title()) : 'Footer'}</p>`; part === 'header' ? page.prepend(region) : page.append(region); } }); const region = pageAt()?.querySelector<HTMLElement>(`[data-word-${part}]`); if (region) { const range = document.createRange(); range.selectNodeContents(region); saved = range; restore(); } });
  button(layout, 'Page number', () => insert('<span data-page-number="true">1</span>'));
  const review = panel('Review');
  button(review, 'Find / Replace', () => findDialog());
  button(review, 'Add comment', async () => { remember(); const generation = identity(); const range = currentRange(); if (!range || range.collapsed) { message('Select the passage to comment on.'); return; } const value = await askText('Comment'); if (!value || disposed || generation !== identity() || !doc.contains(range.commonAncestorContainer)) return; const mark = document.createElement('mark'); mark.dataset.comment = value.slice(0, 4000); mark.dataset.author = author; mark.append(range.cloneContents()); insert(mark.outerHTML, range); });
  button(review, 'Comments', () => commentsDialog());
  const trackButton = button(review, 'Track changes', () => { tracking = !tracking; trackButton.setAttribute('aria-pressed', String(tracking)); message(tracking ? 'Tracking typed, pasted and deleted text. Formatting and structural edits apply directly.' : 'Track changes off.'); }); trackButton.setAttribute('aria-pressed', 'false');
  button(review, 'Author', async () => { const value = await askText('Name used for new comments and changes', author); if (value) author = value.slice(0, 100); });
  for (const accept of [true, false]) { button(review, accept ? 'Accept change' : 'Reject change', () => resolveChanges(accept, false)); button(review, accept ? 'Accept all' : 'Reject all', () => resolveChanges(accept, true)); }
  function resolveChanges(accept: boolean, all: boolean) { mutate(() => { const range = currentRange(); const changes = [...doc.querySelectorAll<HTMLElement>('ins[data-change],del[data-change]')].filter(el => all || range && range.intersectsNode(el)); if (!changes.length) throw new Error('Place the cursor in a tracked change or select it first.'); for (const change of changes) { if (!doc.contains(change)) continue; const remove = accept ? change.tagName === 'DEL' : change.tagName === 'INS'; if (remove) change.remove(); else change.replaceWith(...change.childNodes); } }); }
  function replacement(range: Range, value: string, deletedOverride?: string, insertionHtml?: string) { if (!doc.contains(range.commonAncestorContainer)) return;
    const html = insertionHtml ?? escape(value).replaceAll('\n', '<br>');
    const container = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const addition = container?.closest<HTMLElement>('ins[data-change]');
    if (!tracking || addition && addition.dataset.author === author && !deletedOverride) { insert(html, range); return; }
    const id = crypto.randomUUID(), holder = document.createElement('div'); holder.append(range.cloneContents()); const deleted = deletedOverride ?? holder.innerHTML; const fragment = document.createElement('div'); fragment.innerHTML = deleted; for (const addition of fragment.querySelectorAll('ins[data-change]')) addition.remove(); for (const deletion of fragment.querySelectorAll('del[data-change]')) deletion.replaceWith(...deletion.childNodes);
    const old = fragment.innerHTML ? `<del data-change="${id}" data-author="${escape(author)}">${fragment.innerHTML}</del>` : '';
    const added = html ? `<ins data-change="${id}" data-author="${escape(author)}">${html}</ins>` : '';
    insert(old + added, range);
  }
  function findDialog() { remember(); const { d, form, actions, submit, error } = dialog('Find and replace'); submit.textContent = 'Find next'; const query = document.createElement('input'), replacementInput = document.createElement('input'), matchCase = document.createElement('input'), caseLabel = document.createElement('label'); query.placeholder = 'Find'; query.setAttribute('aria-label', 'Find text'); query.required = true; replacementInput.placeholder = 'Replace with'; replacementInput.setAttribute('aria-label', 'Replacement text'); matchCase.type = 'checkbox'; caseLabel.append(matchCase, ' Match case'); actions.before(query, replacementInput, caseLabel); let searchAt = 0, found: Range | null = null; const editBehindDialog = (work: () => void) => { d.close(); work(); if (!disposed) d.showModal(); };
    function find() { const source = doc.textContent ?? '', needle = query.value; if (!needle) return; const haystack = matchCase.checked ? source : source.toLocaleLowerCase(), term = matchCase.checked ? needle : needle.toLocaleLowerCase(); let index = haystack.indexOf(term, searchAt); if (index < 0 && searchAt) index = haystack.indexOf(term); if (index < 0) { found = null; error.textContent = 'No matches.'; error.hidden = false; return; } found = textRange(index, index + needle.length); searchAt = index + needle.length; saved = found; const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(found); found.startContainer.parentElement?.scrollIntoView({ block: 'nearest' }); error.hidden = true; }
    form.addEventListener('submit', event => { event.preventDefault(); find(); }, { signal }); button(actions, 'Replace', () => { if (!found) { find(); return; } const target = found; editBehindDialog(() => replacement(target, replacementInput.value)); found = null; find(); }); button(actions, 'Replace all', () => { const needle = query.value; if (!needle) return; const source = doc.textContent ?? '', haystack = matchCase.checked ? source : source.toLocaleLowerCase(), term = matchCase.checked ? needle : needle.toLocaleLowerCase(); const positions: number[] = []; for (let index = haystack.indexOf(term); index >= 0; index = haystack.indexOf(term, index + needle.length)) { positions.push(index); if (positions.length > 1000) { error.textContent = 'Replace at most 1,000 matches at a time.'; error.hidden = false; return; } } editBehindDialog(() => { for (const index of positions.reverse()) replacement(textRange(index, index + needle.length), replacementInput.value); }); error.textContent = `Replaced ${positions.length} matches.`; error.hidden = false; found = null; searchAt = 0; }); d.addEventListener('close', () => { if (!d.open) d.remove(); }); query.focus(); }
  function commentsDialog() { const { d, form, actions, submit } = dialog('Comments'); submit.textContent = 'Done'; const list = document.createElement('div'); list.className = 'np-word-comments'; const comments = [...doc.querySelectorAll<HTMLElement>('[data-comment]')]; if (!comments.length) list.textContent = 'No comments in this document.'; for (const mark of comments) { const liveMark = () => [...doc.querySelectorAll<HTMLElement>('[data-comment]')].find(el => el.dataset.comment === mark.dataset.comment && el.dataset.author === mark.dataset.author && el.textContent === mark.textContent); const item = document.createElement('article'), who = document.createElement('strong'), quote = document.createElement('blockquote'), comment = document.createElement('p'); who.textContent = mark.dataset.author ?? 'Comment'; quote.textContent = mark.textContent; comment.textContent = mark.dataset.comment ?? ''; item.append(who, quote, comment); button(item, 'Go to passage', () => { const live = liveMark(); if (!live) return; const range = document.createRange(); range.selectNodeContents(live); saved = range; d.close(); restore(); live.scrollIntoView({ block: 'center' }); }); button(item, 'Resolve', () => { d.close(); mutate(() => { const live = liveMark(); if (live) live.replaceWith(...live.childNodes); }); item.remove(); if (!disposed) d.showModal(); }); list.append(item); } actions.before(list); form.addEventListener('submit', event => { event.preventDefault(); d.close(); }, { signal }); d.addEventListener('close', () => { if (!d.open) d.remove(); }); }
  bindContextMenu(doc, event => {
    // Shift-right-click keeps the browser's spelling, services and rich clipboard menu.
    if (event.shiftKey || !doc.isContentEditable) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input,textarea')) return;
    let range = currentRange();
    if (event.detail !== -1) {
      const pointed = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (pointed && doc.contains(pointed.startContainer) && (!range || range.collapsed || !range.isPointInRange(pointed.startContainer, pointed.startOffset))) range = pointed;
    }
    if (!range) { range = document.createRange(); range.selectNodeContents(doc); range.collapse(false); }
    saved = range.cloneRange(); const selection = saved.cloneRange(), generation = identity();
    event.preventDefault(); event.stopPropagation();
    const run = (work: () => void) => { if (disposed || generation !== identity() || !doc.contains(selection.commonAncestorContainer)) return; saved = selection.cloneRange(); restore(); work(); };
    openMenu(event.clientX, event.clientY, menu => {
      const hint = document.createElement('div'); hint.className = 'ctx-label'; hint.textContent = 'Native spelling menu: Shift + right-click'; menu.append(hint);
      async function clipboard(action: 'copy' | 'cut' | 'paste') {
        const before = doc.innerHTML;
        try {
          if (action === 'paste') {
            const text = await navigator.clipboard.readText();
            if (disposed || generation !== identity() || doc.innerHTML !== before || !doc.contains(selection.commonAncestorContainer)) return message('Paste canceled because the document changed.');
            replacement(selection, text);
          } else {
            await navigator.clipboard.writeText(selection.toString());
            if (action === 'cut') {
              if (disposed || generation !== identity() || doc.innerHTML !== before || !doc.contains(selection.commonAncestorContainer)) return message('Text copied; cut canceled because the document changed.');
              replacement(selection, '');
            }
          }
        } catch { message('Clipboard unavailable. Use the keyboard shortcut or Shift + right-click for the native menu. No text changed.'); }
      }
      for (const action of ['copy', 'cut', 'paste'] as const) {
        const item = menuItem('copy', `${action[0].toUpperCase() + action.slice(1)}${action === 'paste' ? ' plain text' : ' text'}`, () => void clipboard(action)) as HTMLButtonElement;
        item.disabled = action !== 'paste' && selection.collapsed; menu.append(item);
      }
      menu.append(menuItem('list', 'Select all', () => { const all = document.createRange(); all.selectNodeContents(doc); saved = all; restore(); }));
      for (const [command, label] of [['undo', 'Undo'], ['redo', 'Redo'], ['bold', 'Bold'], ['italic', 'Italic'], ['underline', 'Underline'], ['strikeThrough', 'Strikethrough'], ['removeFormat', 'Clear formatting'], ['insertUnorderedList', 'Bullet list'], ['insertOrderedList', 'Numbered list']]) menu.append(menuItem('pen', label, () => run(() => native(command))));
      const node = selection.startContainer instanceof Element ? selection.startContainer : selection.startContainer.parentElement;
      const anchor = node?.closest<HTMLAnchorElement>('a');
      if (!anchor?.dataset.note) menu.append(menuItem('link', anchor ? 'Edit link…' : 'Add link…', () => { void (async () => {
        const value = await askText('Link URL (https:// or mailto:)', anchor?.getAttribute('href') ?? 'https://');
        if (!value || disposed) return;
        if (!/^(https?:\/\/|mailto:)/i.test(value)) return message('Use an HTTP, HTTPS, or mailto link.');
        run(() => { if (anchor && doc.contains(anchor)) { saved = document.createRange(); saved.selectNodeContents(anchor); } native('createLink', value); });
      })(); }));
      if (anchor) {
        menu.append(menuItem('link', 'Open link', () => { if (anchor.dataset.note) anchor.click(); else if (/^(https?:|mailto:)/i.test(anchor.href)) window.open(anchor.href, '_blank', 'noopener,noreferrer'); }));
        if (anchor.hasAttribute('href')) menu.append(menuItem('copy', 'Copy link address', () => { void (async () => { await navigator.clipboard.writeText(anchor.href); })().catch(() => message('Clipboard unavailable. Use Shift + right-click to copy the link.')); }));
        menu.append(menuItem('close', 'Remove link', () => run(() => native('unlink'))));
      }
      for (const label of ['Add comment', 'Comments', 'Accept change', 'Reject change', 'Find / Replace']) {
        const b = [...review.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label);
        if (b) menu.append(menuItem('pen', label, () => run(() => b.click())));
      }
      const grammar = tools.querySelector<HTMLButtonElement>('.np-proof-tools button');
      if (grammar) { const item = menuItem('check', 'Review grammar', () => grammar.click()) as HTMLButtonElement; item.disabled = grammar.disabled; menu.append(item); }
      if (node?.closest('td,th')) for (const option of [...tableMenu.options].filter(o => o.value)) menu.append(menuItem(option.value.startsWith('delete') ? 'trash' : 'database', option.text, () => run(() => tableAction(option.value)), option.value.startsWith('delete')));
      const image = target?.closest('img');
      if (image) menu.append(menuItem('trash', 'Remove image', () => run(() => mutate(() => image.remove())), true));
    });
  }, signal);
  doc.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); history(event.shiftKey ? 'redo' : 'undo'); } }, { signal });
  doc.addEventListener('beforeinput', event => { const input = event as InputEvent; if (input.inputType === 'historyUndo' || input.inputType === 'historyRedo') { input.preventDefault(); history(input.inputType === 'historyUndo' ? 'undo' : 'redo'); return; } if (!tracking || internal || composing || input.isComposing || !input.cancelable) return; let range = currentRange(); if (!range) return;
    if (['insertText', 'insertReplacementText', 'insertParagraph', 'insertLineBreak'].includes(input.inputType)) { input.preventDefault(); replacement(range, input.inputType === 'insertParagraph' || input.inputType === 'insertLineBreak' ? '\n' : input.data ?? ''); }
    else if (input.inputType.startsWith('delete')) { if (range.collapsed) { const selection = window.getSelection() as Selection & { modify?: (alter: string, direction: string, granularity: string) => void }; const backward = /Backward$/.test(input.inputType); if (selection.modify) { selection.modify('extend', backward ? 'backward' : 'forward', input.inputType.includes('Word') ? 'word' : input.inputType.includes('Line') ? 'lineboundary' : 'character'); range = currentRange() ?? range; } else { const index = offset(range), source = doc.textContent ?? '', step = backward ? [...source.slice(0, index)].at(-1)?.length ?? 0 : [...source.slice(index)][0]?.length ?? 0; range = textRange(backward ? Math.max(0, index - step) : index, backward ? index : index + step); } } if (!range.collapsed) { input.preventDefault(); replacement(range, ''); } }
  }, { signal, capture: true });
  doc.addEventListener('paste', event => { if (internal || event.defaultPrevented) return; const clipboard = (event as ClipboardEvent).clipboardData; const range = currentRange(); if (!clipboard || !range) return; event.preventDefault(); event.stopImmediatePropagation(); const rich = clipboard.getData('text/html'); replacement(range, clipboard.getData('text/plain'), undefined, rich ? sanitizeHtml(rich) : undefined); }, { signal, capture: true });
  doc.addEventListener('compositionstart', () => { composing = true; const range = currentRange(); compositionDeleted = ''; if (tracking && range) { compositionStart = offset(range); const holder = document.createElement('div'); holder.append(range.cloneContents()); compositionDeleted = holder.innerHTML; } }, { signal });
  doc.addEventListener('compositionend', event => { composing = false; if (!tracking || !event.data) return; queueMicrotask(() => { if (disposed) return; const range = textRange(compositionStart, compositionStart + event.data.length); replacement(range, event.data, compositionDeleted); }); }, { signal });
  document.addEventListener('selectionchange', remember, { signal });
  doc.addEventListener('input', () => { if (!internal) refresh(); }, { signal });
  function refresh() { const repaired = repairPages(); if (identity() !== historyIdentity) record(); for (const mark of doc.querySelectorAll<HTMLElement>('[data-comment]')) mark.title = `${mark.dataset.author ?? 'Comment'}: ${mark.dataset.comment ?? ''}`; for (const change of doc.querySelectorAll<HTMLElement>('[data-change]')) change.title = `${change.tagName === 'DEL' ? 'Deleted' : 'Inserted'} by ${change.dataset.author ?? 'Unknown'}`; for (const [i, page] of [...doc.querySelectorAll<HTMLElement>('[data-word-page]')].entries()) for (const number of page.querySelectorAll<HTMLElement>('[data-page-number]')) number.textContent = String(i + 1); const page = doc.querySelector<HTMLElement>('[data-word-page]'); if (page) { const [size, direction] = (page.dataset.wordPage ?? 'letter-portrait').split('-'); pageSize.value = size; orientation.value = direction; margins.value = String(parseFloat(page.style.padding) || 20); } if (repaired) changed(); }
  refresh();
  return { refresh, record, history, replace(range: Range, value: string) { replacement(range, value); }, destroy() { disposed = true; control.abort(); ribbon.remove(); } };
}
