// The interactive Notion wards: 'notion-page' renders a whole page — chrome,
// properties, block tree, comments, a capture line, any subset — and
// 'notion-db' a database. Every part is editable through the same
// property/block editors below — a new property type is one case in
// propControl, not a new ward.
//
// The pure codecs (lib/notion-props.ts, lib/notion-blocks.ts) ship to the
// browser on purpose: the client decides which editor a type gets from the
// same table the server writes with.

import { icon } from './icon.ts';
import type { WardInstance } from '../../lib/wards.ts';
import { editorFor, type PropValue } from '../../lib/notion-props.ts';
import { WRITABLE, blockLabel, type NBlock } from '../../lib/notion-blocks.ts';
import { RENDERERS, body, handled, note } from './wards.ts';
import { busy, el, getJson, postJson } from './dom.ts';
import { addRowForm, pickDbNote, renderChecklist } from './logic.ts';
import { blockView, propView, withValue } from './notion-view.ts';
import { renderNotionCalendar } from './notion-cal.ts';
import { shareReadOnly, shareView } from './share-view.ts';

interface SourceProp {
  name: string;
  type: string;
  options?: { name: string; color?: string }[];
}
interface PageBundle {
  meta: { id: string; title: string; url: string; icon: string; archived: boolean; parentType: string; edited: string };
  props: Record<string, PropValue>;
  blocks: (NBlock & { depth: number })[];
  comments: { id: string; discussionId: string; text: string; author: string; created: string }[];
  schema: { props: SourceProp[] } | null;
}

const cfgOf = (w: WardInstance) => (w.config ?? {}) as Record<string, unknown>;

/** Every write from these wards funnels through here so one failure path,
 *  one busy state and one re-render rule cover the whole surface. */
async function send(url: string, method: string, payload?: unknown, el?: HTMLElement): Promise<{ ok: boolean; data: any }> {
  if (el) el.style.opacity = '0.5';
  const res = await postJson(url, payload, method);
  if (el) el.style.opacity = '1';
  return res;
}

function flash(target: HTMLElement, msg: string): void {
  target.title = msg;
  target.classList.add('ring-1', 'ring-err');
  setTimeout(() => target.classList.remove('ring-1', 'ring-err'), 2000);
}

// --------------------------------------------------------- property editors

const INPUT = 'input min-h-0 w-full px-1.5 py-0.5 text-xs';

/** The control for one property. `save(value)` resolves false on rejection,
 *  which is when the control puts the old value back. */
function propControl(pv: PropValue, spec: SourceProp | undefined, save: (v: unknown) => Promise<boolean>): HTMLElement {
  const kind = editorFor(pv.type);

  if (kind === 'none' || !pv.editable) {
    const span = el('span', 'block truncate py-0.5 text-xs text-ink-muted', pv.text || '—');
    span.title = `${pv.type} — computed by Notion`;
    return span;
  }

  if (kind === 'checkbox') {
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = pv.value === true;
    cb.addEventListener('change', async () => {
      if (!(await save(cb.checked))) cb.checked = !cb.checked;
    });
    return cb;
  }

  if (kind === 'select') {
    const sel = el('select', INPUT) as HTMLSelectElement;
    // A status column cannot be cleared; a select can.
    if (pv.type !== 'status') sel.append(new Option('—', ''));
    for (const o of spec?.options ?? []) sel.append(new Option(o.name, o.name));
    const current = String(pv.value ?? '');
    if (current && ![...sel.options].some((o) => o.value === current)) sel.append(new Option(current, current));
    sel.value = current;
    sel.addEventListener('change', async () => {
      if (!(await save(sel.value))) sel.value = current;
    });
    return sel;
  }

  if (kind === 'multi_select') {
    const sel = el('select', INPUT) as HTMLSelectElement;
    sel.multiple = true;
    sel.size = Math.min(Math.max((spec?.options ?? []).length, 2), 4);
    const chosen = new Set(Array.isArray(pv.value) ? (pv.value as string[]) : []);
    for (const o of spec?.options ?? []) sel.append(new Option(o.name, o.name, false, chosen.has(o.name)));
    for (const name of chosen) if (![...sel.options].some((o) => o.value === name)) sel.append(new Option(name, name, false, true));
    sel.addEventListener('change', async () => {
      const picked = [...sel.selectedOptions].map((o) => o.value);
      if (!(await save(picked))) [...sel.options].forEach((o) => (o.selected = chosen.has(o.value)));
    });
    return sel;
  }

  if (kind === 'date') {
    const wrap = el('span', 'flex items-center gap-1');
    const cur = (pv.value ?? {}) as { start?: string; end?: string };
    const start = el('input', `${INPUT} w-[8.5rem]`) as HTMLInputElement;
    start.type = 'date';
    start.value = (cur.start ?? '').slice(0, 10);
    const end = el('input', `${INPUT} w-[8.5rem]`) as HTMLInputElement;
    end.type = 'date';
    end.value = (cur.end ?? '').slice(0, 10);
    end.title = 'End date (optional)';
    const commit = async () => {
      if (!(await save({ start: start.value, end: end.value }))) {
        start.value = (cur.start ?? '').slice(0, 10);
        end.value = (cur.end ?? '').slice(0, 10);
      }
    };
    start.addEventListener('change', commit);
    end.addEventListener('change', commit);
    wrap.append(start, end);
    return wrap;
  }

  if (kind === 'people' || kind === 'relation' || kind === 'files') {
    // Sets of references: chips you can remove, plus one adder. Adding a
    // person picks from the workspace; a relation searches pages; a file
    // uploads. All three end up as an array write, so they share this path.
    return refEditor(pv, save);
  }

  const isLong = pv.type === 'rich_text';
  const input = el(isLong ? 'textarea' : 'input', INPUT) as HTMLInputElement | HTMLTextAreaElement;
  if (!isLong) (input as HTMLInputElement).type = pv.type === 'email' ? 'email' : pv.type === 'url' ? 'url' : 'text';
  else (input as HTMLTextAreaElement).rows = 2;
  if (kind === 'number') (input as HTMLInputElement).type = 'number';
  input.value = kind === 'number' ? String(pv.value ?? '') : String(pv.value ?? '');
  const was = input.value;
  const commit = async () => {
    if (input.value === was) return;
    if (!(await save(input.value))) input.value = was;
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter' && !isLong) input.blur();
    if ((e as KeyboardEvent).key === 'Escape') input.value = was;
  });
  return input;
}

/** The Notion look of a value (notion-view.ts) that becomes its editor on
 *  click and goes back to the look once the write lands, Escape is pressed or
 *  a click lands elsewhere. Checkboxes are live either way. */
function editableView(pv: PropValue, spec: SourceProp | undefined, save: (v: unknown) => Promise<boolean>): HTMLElement {
  if (shareReadOnly) return propView(pv, spec); // a share's viewer reads
  const kind = editorFor(pv.type);
  if (kind === 'none' || !pv.editable) {
    const v = propView(pv, spec);
    v.title = `${pv.type} — computed by Notion`;
    return v;
  }
  if (kind === 'checkbox') return propControl(pv, spec, save);
  let cur = pv;
  const slot = el('div', 'nv -mx-0.5 min-h-5 min-w-0 cursor-pointer rounded px-0.5 hover:bg-surface-2');
  slot.title = 'Click to edit';
  const show = () => {
    delete slot.dataset.editing;
    slot.replaceChildren(propView(cur, spec));
  };
  show();
  slot.addEventListener('click', (e) => {
    if (slot.dataset.editing || (e.target as HTMLElement).closest('a')) return;
    slot.dataset.editing = '1';
    const ctl = propControl(cur, spec, async (v) => {
      const ok = await save(v);
      if (ok) {
        cur = withValue(cur, spec, v);
        show();
      }
      return ok;
    });
    slot.replaceChildren(ctl);
    ((ctl.matches('input,select,textarea') ? ctl : ctl.querySelector('input,select,textarea')) as HTMLElement | null)?.focus();
    const outside = (ev: Event) => {
      const t = ev.target as HTMLElement;
      if (slot.contains(t) || t.closest('.fd-ss-panel')) return;
      document.removeEventListener('pointerdown', outside, true);
      if (!slot.dataset.editing) return;
      // Removing a focused input fires no blur: commit the text editors by hand first.
      if (slot.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      show();
    };
    document.addEventListener('pointerdown', outside, true);
    ctl.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key !== 'Escape') return;
      ev.stopPropagation();
      document.removeEventListener('pointerdown', outside, true);
      show();
    });
  });
  return slot;
}

let userCache: Promise<{ id: string; name: string }[]> | null = null;
const workspaceUsers = () =>
  (userCache ??= getJson('/api/notion/users').then((r) => (r.status === 200 ? ((r.data?.users ?? []) as { id: string; name: string }[]) : [])));

function refEditor(pv: PropValue, save: (v: unknown) => Promise<boolean>): HTMLElement {
  const wrap = el('span', 'flex flex-wrap items-center gap-1');
  const items = (Array.isArray(pv.value) ? pv.value : []) as { id?: string; name?: string; url?: string }[];
  const current = () => items.slice();

  const paint = () => {
    wrap.textContent = '';
    items.forEach((it, i) => {
      const chip = el('span', 'nchip', it.name || it.url || it.id || '?');
      const x = el('button', 'ml-1 text-ink-faint hover:text-err'); x.append(icon('close')); x.setAttribute('aria-label', 'Remove reference');
      x.type = 'button';
      x.addEventListener('click', async () => {
        const before = current();
        items.splice(i, 1);
        paint();
        if (!(await save(items))) {
          items.splice(0, items.length, ...before);
          paint();
        }
      });
      chip.append(x);
      wrap.append(chip);
    });
    wrap.append(adder());
  };

  const push = async (item: { id?: string; name?: string; url?: string }) => {
    items.push(item);
    paint();
    if (!(await save(items))) {
      items.pop();
      paint();
    }
  };

  function adder(): HTMLElement {
    if (pv.type === 'people') {
      const sel = el('select', `${INPUT} w-auto`) as HTMLSelectElement;
      sel.append(new Option('+ person', ''));
      void workspaceUsers().then((us) => {
        for (const u of us) if (!items.some((i) => i.id === u.id)) sel.append(new Option(u.name || u.id, u.id));
      });
      sel.addEventListener('change', () => {
        const id = sel.value;
        if (id) void push({ id, name: sel.selectedOptions[0]?.textContent ?? '' });
      });
      return sel;
    }
    if (pv.type === 'files') {
      const label = el('label', 'nchip cursor-pointer', '+ file');
      const file = el('input', 'hidden') as HTMLInputElement;
      file.type = 'file';
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        if (!f) return;
        const form = new FormData();
        form.append('file', f);
        label.textContent = 'uploading…';
        const res = await fetch('/api/notion/upload', { method: 'POST', body: form }).catch(() => null);
        const data = res ? await res.json().catch(() => null) : null;
        label.textContent = '+ file';
        if (!res?.ok) return flash(label, data?.error ?? 'upload failed');
        await push({ name: f.name, id: data.id, url: '' });
      });
      label.append(file);
      return label;
    }
    // relation: search the workspace for a page to link
    const input = el('input', `${INPUT} w-28`) as HTMLInputElement;
    input.placeholder = '+ link page…';
    input.addEventListener('keydown', async (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      e.preventDefault();
      const q = input.value.trim();
      if (q.length < 2) return;
      const { status, data } = await getJson(`/api/notion/search?q=${encodeURIComponent(q)}&kind=page`);
      const hit = status === 200 ? (data?.results ?? [])[0] : null;
      if (!hit) return flash(input, 'no page matched');
      input.value = '';
      await push({ id: hit.id, name: hit.title });
    });
    return input;
  }

  // A files chip carries its upload id, which the server turns back into an
  // attachment; a people/relation chip carries the page or user id.
  paint();
  return wrap;
}

/** name → the value shape writeProp expects, straight from the control. */
function propsBlock(
  pageId: string,
  props: Record<string, PropValue>,
  schema: SourceProp[] | undefined,
  only: string[] | undefined,
  onSaved: () => void
): HTMLElement {
  const specs = new Map((schema ?? []).map((p) => [p.name, p]));
  const grid = el('div', 'grid grid-cols-[minmax(4rem,auto)_1fr] items-center gap-x-2 gap-y-1');
  const names = only?.length ? only.filter((n) => props[n]) : Object.keys(props);
  for (const name of names) {
    const pv = props[name]!;
    const label = el('span', 'truncate text-[10px] text-ink-faint', name);
    label.title = `${name} · ${pv.type}`;
    const save = async (value: unknown): Promise<boolean> => {
      const { ok, data } = await send('/api/notion/page', 'PATCH', { id: pageId, props: { [name]: value } });
      if (!ok) {
        flash(label, data?.error ?? 'save failed');
        return false;
      }
      if (data?.skipped?.includes(name)) {
        flash(label, `Notion would not accept a write to "${name}"`);
        return false;
      }
      onSaved();
      return true;
    };
    grid.append(label, editableView(pv, specs.get(name), save));
  }
  if (!names.length) grid.append(el('span', 'text-[10px] text-ink-faint', 'No properties.'));
  return grid;
}

// ------------------------------------------------------------ block editors

const BLOCK_INDENT = 0.85; // rem per nesting level

function blockRow(b: NBlock & { depth: number }, reload: () => void, n = 1): HTMLElement {
  const row = el('div', 'group flex items-start gap-1 py-px');
  row.style.paddingLeft = `${b.depth * BLOCK_INDENT}rem`;

  const patch = async (draft: Record<string, unknown>, target: HTMLElement): Promise<boolean> => {
    const { ok, data } = await send('/api/notion/block', 'PATCH', { id: b.id, block: { type: b.type, ...draft } }, target);
    if (!ok) flash(target, data?.error ?? 'save failed');
    return ok;
  };

  // The Notion look (notion-view.ts); an editable text block swaps to its
  // editor on click and back once the write lands, Escape or blur.
  const slot = el('div', 'min-w-0 flex-1');
  const show = () => {
    const view = blockView(b, n);
    const cb = b.type === 'to_do' ? view.querySelector<HTMLInputElement>('input[type=checkbox]') : null;
    if (cb && !shareReadOnly) {
      cb.disabled = false;
      cb.addEventListener('change', async () => {
        if (!(await patch({ text: b.text, checked: cb.checked }, row))) cb.checked = !cb.checked;
        else b.checked = cb.checked;
      });
    }
    if (!b.editable) view.title = `${blockLabel(b.type)} — read-only here; open it in Notion to edit`;
    else if (b.type !== 'divider' && !shareReadOnly) {
      view.classList.add('cursor-text');
      view.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('a, input')) return;
        edit();
      });
    }
    slot.replaceChildren(view);
  };
  const edit = () => {
    const long = b.type === 'code' || b.type === 'quote' || b.type === 'callout';
    const field = el(long ? 'textarea' : 'input', `min-w-0 w-full bg-transparent px-1 py-0.5 outline-none focus:bg-surface-2 ${textClass(b)}`) as
      | HTMLInputElement
      | HTMLTextAreaElement;
    field.value = b.url && !b.text ? b.url : b.text;
    if (long) (field as HTMLTextAreaElement).rows = Math.min(6, Math.max(1, field.value.split('\n').length));
    const was = field.value;
    let done = false;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      if (commit && field.value !== was) {
        const draft: Record<string, unknown> = { text: field.value };
        if (b.type === 'to_do') draft.checked = b.checked;
        if (b.type === 'code') draft.language = b.language;
        if (b.url) draft.url = field.value;
        if (await patch(draft, row)) {
          b.text = field.value;
          delete b.runs; // one plain run now — the write flattened it
          if (b.url) b.url = field.value;
        }
      }
      show();
    };
    field.addEventListener('blur', () => void finish(true));
    field.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'Enter' && !long) field.blur();
      if (k === 'Escape') {
        e.stopPropagation();
        void finish(false);
      }
    });
    slot.replaceChildren(field);
    field.focus();
  };
  show();
  row.append(slot);

  const del = el('button', 'shrink-0 px-1 text-[10px] text-ink-faint opacity-0 group-hover:opacity-100 hover:text-err'); del.append(icon('close')); del.setAttribute('aria-label', 'Delete block');
  del.type = 'button';
  del.title = `Delete this ${blockLabel(b.type).toLowerCase()} (Notion keeps it in trash)`;
  del.addEventListener('click', async () => {
    const { ok, data } = await send(`/api/notion/block?id=${encodeURIComponent(b.id)}`, 'DELETE', undefined, row);
    if (!ok) return flash(row, data?.error ?? 'delete failed');
    row.remove();
    reload();
  });
  if (!shareReadOnly) row.append(del);
  return row;
}

function textClass(b: NBlock): string {
  if (b.type === 'heading_1') return 'text-sm font-semibold';
  if (b.type === 'heading_2') return 'text-xs font-semibold';
  if (b.type === 'heading_3') return 'text-xs font-medium';
  if (b.type === 'code') return 'font-mono text-[10px]';
  if (b.type === 'quote') return 'border-l-2 border-line pl-2 text-xs italic';
  if (b.type === 'to_do') return `text-xs${b.checked ? ' line-through text-ink-muted' : ''}`;
  return 'text-xs';
}

function addBlockForm(pageId: string, reload: () => void): HTMLElement {
  const form = el('form', 'mt-1 flex gap-1');
  const type = el('select', 'input min-h-0 w-24 shrink-0 px-1 py-0.5 text-[10px]') as HTMLSelectElement;
  for (const t of WRITABLE) type.append(new Option(blockLabel(t), t));
  const text = el('input', 'input min-h-0 min-w-0 flex-1 px-2 py-0.5 text-xs') as HTMLInputElement;
  text.placeholder = 'Add a block…';
  form.append(type, text);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = text.value.trim();
    if (!value && type.value !== 'divider') return;
    const block: Record<string, unknown> = { type: type.value, text: value };
    if (type.value === 'bookmark' || type.value === 'embed') block.url = value;
    const { ok, data } = await send('/api/notion/block', 'POST', { parentId: pageId, blocks: [block] }, form);
    if (!ok) return flash(text, data?.error ?? 'could not add that');
    text.value = '';
    reload();
  });
  return form;
}

// ---------------------------------------------------------------- renderers

function chrome(bundle: PageBundle): HTMLElement {
  const head = el('div', 'mb-1 flex items-baseline gap-1');
  if (bundle.meta.icon) head.append(el('span', 'shrink-0 text-xs', bundle.meta.icon));
  const link = el('a', 'min-w-0 flex-1 truncate text-xs font-semibold hover:underline', bundle.meta.title || '(untitled)');
  link.href = bundle.meta.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  head.append(link);
  if (bundle.meta.archived) head.append(el('span', 'nchip', 'in trash'));
  return head;
}

async function load(w: WardInstance, parts: string): Promise<PageBundle | null> {
  const cfg = cfgOf(w);
  const page = typeof cfg.page === 'string' ? cfg.page : '';
  const b = body(w.i);
  if (!b) return null;
  if (!page) {
    b.textContent = '';
    b.append(
      el('p', 'wd-note text-xs text-ink-faint', 'No page picked yet.'),
      el('p', 'wd-note text-[10px] text-ink-faint', 'Configure this ward in edit mode.')
    );
    return null;
  }
  const depth = Math.min(Math.max(Number(cfg.depth ?? 2), 0), 4);
  const { status, data } = await getJson(`/api/notion/page?id=${encodeURIComponent(page)}&parts=${parts}&depth=${depth}`);
  if (handled(w.i, 'notion', status)) return null;
  if (status !== 200) {
    note(w.i, String(data?.error ?? 'Notion unavailable.').slice(0, 140));
    return null;
  }
  return data as PageBundle;
}

/** The capture line: Enter appends a paragraph to `pageId`, or — with none —
 *  to the account's capture page (set under Account → Notion). */
function captureForm(w: WardInstance, pageId: string | undefined, onSaved: () => void): HTMLElement {
  const form = el('form', 'flex min-h-0 flex-1 flex-col gap-1');
  const input = el('textarea', 'input min-h-0 flex-1 resize-none text-sm');
  input.placeholder = pageId ? 'Jot it down… Enter appends to this page.' : 'Jot it down… Enter saves to your capture page.';
  input.rows = 1;
  const hint = el('p', 'hidden text-[10px]');
  form.append(input, hint);
  form.addEventListener('submit', (e) => e.preventDefault());
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    const res = await postJson('/api/notion/capture', { text, ...(pageId ? { pageId } : {}) });
    input.disabled = false;
    if (res.ok) {
      input.value = '';
      input.classList.add('ring-2', 'ring-ok/40');
      setTimeout(() => input.classList.remove('ring-2', 'ring-ok/40'), 900);
      onSaved();
    } else if (res.status === 404 || res.status === 409) {
      handled(w.i, 'notion', res.status);
      return;
    } else {
      hint.textContent = res.data?.error === 'no capture page configured' ? 'Save failed — set a capture page in Account.' : (res.data?.error ?? 'Save failed.');
      hint.className = 'text-[10px] text-warn';
    }
    input.focus();
  });
  return form;
}

async function renderNotionPage(w: WardInstance): Promise<void> {
  const pre = body(w.i);
  if (pre && busy(pre)) return;
  const cfg = cfgOf(w);
  const show = new Set(Array.isArray(cfg.show) ? (cfg.show as string[]) : ['props', 'blocks', 'comments']);
  // No page + the capture line = the bare capture ward: the account's capture page.
  if (typeof cfg.page !== 'string' && show.has('add')) {
    if (!pre) return;
    if (shareView) return note(w.i, 'Capture goes to its owner’s page: not available in a share.');
    pre.textContent = '';
    pre.append(captureForm(w, undefined, () => {}));
    pre.classList.add('flex');
    return;
  }
  const parts = [...show].filter((s) => s !== 'add');
  const bundle = await load(w, parts.join(',') || 'props');
  if (!bundle) return;
  const b = body(w.i);
  if (!b || busy(b)) return;
  const reload = () => void renderNotionPage(w);
  b.textContent = '';
  if (cfg.head !== false) b.append(chrome(bundle));

  if (show.has('props') && Object.keys(bundle.props).length) {
    const only = Array.isArray(cfg.props) && cfg.props.length ? (cfg.props as string[]) : undefined;
    b.append(propsBlock(bundle.meta.id, bundle.props, bundle.schema?.props, only, reload));
    if (show.has('blocks')) b.append(el('hr', 'my-1.5 border-line'));
  }

  if (show.has('blocks')) {
    const list = el('div', '');
    // Numbered items count their run at one depth; a different block there restarts it.
    const runAt = new Map<number, { type: string; n: number }>();
    for (const blk of bundle.blocks) {
      const prev = runAt.get(blk.depth);
      const n = blk.type === 'numbered_list_item' && prev?.type === 'numbered_list_item' ? prev.n + 1 : 1;
      for (const d of [...runAt.keys()]) if (d > blk.depth) runAt.delete(d);
      runAt.set(blk.depth, { type: blk.type, n });
      list.append(blockRow(blk, reload, n));
    }
    if (!bundle.blocks.length) list.append(el('p', 'text-[10px] text-ink-faint', 'Empty page.'));
    b.append(list);
    if (!shareReadOnly) b.append(addBlockForm(bundle.meta.id, reload));
  }

  if (show.has('comments')) {
    b.append(el('hr', 'my-1.5 border-line'));
    for (const c of bundle.comments) {
      const row = el('div', 'py-px text-[10px]');
      row.append(el('span', 'text-ink-faint', `${c.author || 'someone'}: `), el('span', 'text-ink-muted', c.text));
      b.append(row);
    }
    const form = el('form', 'mt-1');
    const input = el('input', 'input min-h-0 w-full px-2 py-0.5 text-[10px]') as HTMLInputElement;
    input.placeholder = 'Comment…';
    form.append(input);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const { ok, data } = await send('/api/notion/page', 'PATCH', { id: bundle.meta.id, comment: text }, form);
      if (!ok) return flash(input, data?.error ?? 'could not comment');
      input.value = '';
      reload();
    });
    if (!shareReadOnly) b.append(form);
  }

  if (show.has('add') && !shareReadOnly) b.append(captureForm(w, bundle.meta.id, reload));
}

// ------------------------------------------------------------ database table
// The 'notion-db' ward: one database, two views. 'table' renders every row ×
// chosen columns with the SAME per-type editor a page property gets
// (propControl); 'list' is the checklist renderer, unchanged.

interface SourceRow {
  id: string;
  url: string;
  icon: string;
  props: Record<string, PropValue>;
}

async function renderNotionTable(w: WardInstance): Promise<void> {
  const pre = body(w.i);
  if (!pre || busy(pre)) return;
  const { status, data } = await getJson(`/api/notion/source?ward=${encodeURIComponent(w.i)}&rows=1`);
  if (handled(w.i, 'notion', status)) return;
  const b = body(w.i);
  if (!b || busy(b)) return;
  if (data?.needsConfig) return pickDbNote(w, b);
  if (status !== 200) return note(w.i, String(data?.error ?? 'Notion unavailable.').slice(0, 140));

  const cfg = cfgOf(w);
  const schema = (data?.schema ?? { props: [] }) as { title?: string; props: SourceProp[] };
  const specs = new Map(schema.props.map((p) => [p.name, p]));
  const titleName = schema.props.find((p) => p.type === 'title')?.name ?? '';
  const chosen =
    Array.isArray(cfg.props) && cfg.props.length ? (cfg.props as string[]) : schema.props.map((p) => p.name).slice(0, 6);
  const cols = chosen.filter((n) => n !== titleName && specs.has(n));
  const limit = Number(cfg.limit);
  const rows = ((data?.rows ?? []) as SourceRow[]).slice(0, limit > 0 ? limit : undefined);

  b.textContent = '';
  const wrap = el('div', 'overflow-x-auto');
  const table = el('table', 'w-full border-collapse');
  const headRow = el('tr');
  for (const name of [titleName || 'Title', ...cols]) {
    const th = el('th', 'border-b border-line px-1.5 py-0.5 text-left text-[10px] font-normal whitespace-nowrap text-ink-faint', name);
    th.title = specs.get(name)?.type ?? '';
    headRow.append(th);
  }
  const thead = el('thead');
  thead.append(headRow);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr', 'border-b border-line/40');
    const titleTd = el('td', 'max-w-[14rem] px-1.5 py-0.5 align-top');
    const a = el('a', 'block truncate text-xs hover:underline', `${row.icon ? row.icon + ' ' : ''}${row.props[titleName]?.text || '(untitled)'}`);
    if (row.url) {
      a.href = row.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
    }
    titleTd.append(a);
    tr.append(titleTd);
    for (const name of cols) {
      const td = el('td', 'min-w-[6rem] px-1.5 py-0.5 align-top');
      const pv = row.props[name];
      if (!pv) {
        td.append(el('span', 'text-xs text-ink-faint', '—'));
        tr.append(td);
        continue;
      }
      const save = async (value: unknown): Promise<boolean> => {
        const { ok, data: res } = await send('/api/notion/page', 'PATCH', { id: row.id, props: { [name]: value } }, td);
        if (!ok) {
          flash(td, res?.error ?? 'save failed');
          return false;
        }
        if (res?.skipped?.includes(name)) {
          flash(td, `Notion would not accept a write to "${name}"`);
          return false;
        }
        return true;
      };
      td.append(editableView(pv, specs.get(name), save));
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  b.append(wrap);
  if (!rows.length) b.append(el('p', 'wd-note text-xs text-ink-faint', 'No rows.'));

  if (!shareReadOnly) b.append(addRowForm(w, () => renderNotionTable(w), false));
}

RENDERERS['notion-page'] = { intervalMs: 2 * 60_000, render: (w) => renderNotionPage(w) };
RENDERERS['notion-db'] = {
  intervalMs: 2 * 60_000,
  render: (w) => (cfgOf(w).view === 'list' ? renderChecklist(w) : cfgOf(w).view === 'calendar' ? renderNotionCalendar(w) : renderNotionTable(w)),
};
