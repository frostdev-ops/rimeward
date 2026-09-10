import { bindContextMenu, menuItem, openMenu } from './menu.ts';
import { askText } from './workspace-dialogs.ts';
import type { NotebookPageEngine, NotebookPageOptions } from './notebook-page-engine.ts';
import { el } from './dom.ts';
import { newSlide, normalizeSlides, slideId, slideObject, slideObjectSvg, slideSvg, slidesHtml, type NotebookSlide, type SlideObject, type SlidesDocument } from '../../lib/notebook-slides.ts';
import '../../styles/notebook-slides.css';

export function createSlidesPage(options: NotebookPageOptions): NotebookPageEngine {
  const element = el('div', 'nb-slides');
  element.tabIndex = 0;
  element.setAttribute('aria-label', 'Presentation editor');
  let state: SlidesDocument = { version: 1, slides: [newSlide()] };
  let current = 0, selected = '', destroyed = false;
  const undo: string[] = [], redo: string[] = [];
  const toolbar = el('div', 'nb-slides-toolbar');
  toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'Presentation');
  const workspace = el('div', 'nb-slides-workspace');
  const strip = el('div', 'nb-slides-strip'); strip.setAttribute('aria-label', 'Slides');
  const canvasWrap = el('div', 'nb-slides-canvas-wrap');
  const canvas = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  canvas.classList.add('nb-slides-canvas'); canvas.setAttribute('viewBox', '0 0 960 540');
  canvas.setAttribute('role', 'group'); canvas.setAttribute('aria-label', 'Slide canvas');
  canvas.tabIndex = 0;
  const inspector = el('div', 'nb-slides-inspector');
  const status = el('div', 'nb-slides-status'); status.setAttribute('role', 'status');
  const notes = el('textarea', 'nb-slides-notes'); notes.placeholder = 'Speaker notes'; notes.setAttribute('aria-label', 'Speaker notes'); notes.maxLength = 20000;
  const liveEditor = el('textarea', 'nb-slides-live-editor'); liveEditor.hidden = true; liveEditor.maxLength = 20000; liveEditor.setAttribute('aria-label', 'Edit slide text');
  const stage = el('div', 'nb-slides-stage'); stage.append(canvas, liveEditor);
  canvasWrap.append(stage, notes);
  workspace.append(strip, canvasWrap, inspector); element.append(toolbar, workspace, status);
  const slide = () => state.slides[current]!;
  const object = () => slide().objects.find((o) => o.id === selected);
  const say = (message: string) => { status.textContent = message; };
  const snapshot = () => JSON.stringify(state);
  function remember() {
    const saved = snapshot(); if (undo.at(-1) === saved) return;
    undo.push(saved);
    // ponytail: bounded snapshots; use object deltas if large image decks need deeper undo.
    while (undo.length > 1 && (undo.length > 60 || undo.reduce((sum, entry) => sum + entry.length, 0) > 12_000_000)) undo.shift();
    redo.length = 0;
  }
  function changed() { options.onChange(); }
  function edit(fn: () => void, all = true) { finishText(); remember(); fn(); changed(); all ? render() : paint(); }
  const button = (label: string, fn: () => void, parent: HTMLElement = toolbar) => {
    const b = el('button', 'nb-slides-button', label); b.type = 'button'; b.addEventListener('click', fn); parent.append(b); return b;
  };
  const field = (label: string, input: HTMLElement, parent = inspector) => {
    const wrap = el('label', 'nb-slides-field'); wrap.append(el('span', '', label), input); parent.append(wrap); return input;
  };
  const choose = (label: string, values: [string, string][], value: string, fn: (value: string) => void, parent = inspector) => {
    const input = el('select'); for (const [v, text] of values) { const option = el('option', '', text); option.value = v; input.append(option); }
    input.value = value; input.addEventListener('change', () => fn(input.value)); field(label, input, parent); return input;
  };
  function number(label: string, value: number, min: number, max: number, fn: (n: number) => void) {
    const input = el('input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.value = String(Math.round(value));
    input.addEventListener('change', () => { const n = Number(input.value); if (Number.isFinite(n)) fn(Math.max(min, Math.min(max, n))); }); field(label, input);
  }
  function color(label: string, value: string, fn: (v: string) => void) {
    const input = el('input'); input.type = 'color'; input.value = value; input.addEventListener('change', () => fn(input.value)); field(label, input);
  }
  function history(from: string[], to: string[]) {
    finishText(); const previous = from.pop(); if (!previous) return;
    to.push(snapshot()); state = JSON.parse(previous); current = Math.min(current, state.slides.length - 1); selected = ''; changed(); render();
  }
  const undoButton = button('Undo', () => history(undo, redo));
  const redoButton = button('Redo', () => history(redo, undo));
  const layout = choose('New slide', [['title', 'Title'], ['content', 'Title + content'], ['columns', 'Two columns'], ['blank', 'Blank']], 'title', () => {}, toolbar);
  button('Add slide', () => {
    if (state.slides.length >= 100) return say('Maximum 100 slides.');
    edit(() => { state.slides.splice(++current, 0, newSlide(layout.value)); selected = ''; });
  });
  button('Text', () => addObject('text'));
  const shape = choose('Shape', [['rectangle', 'Rectangle'], ['ellipse', 'Ellipse'], ['arrow', 'Arrow']], 'rectangle', () => {}, toolbar);
  button('Add shape', () => addObject(shape.value as SlideObject['kind']));
  button('Image', () => imageInput.click());
  button('Present', present);
  const exportType = choose('Export', [['html', 'HTML / Print PDF'], ['svg', 'Current slide SVG'], ['json', 'Presentation JSON']], 'html', () => {}, toolbar);
  button('Download', () => {
    finishText();
    const format = exportType.value;
    const blob = new Blob([format === 'html' ? slidesHtml(state) : format === 'svg' ? slideSvg(slide()) : JSON.stringify(state, null, 2)], { type: format === 'html' ? 'text/html' : format === 'svg' ? 'image/svg+xml' : 'application/json' });
    const url = URL.createObjectURL(blob); const a = el('a'); a.href = url; a.download = `presentation.${format}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (format === 'html') say('Open the downloaded HTML presentation to present, print, or save as PDF.');
  });
  const imageInput = el('input'); imageInput.type = 'file'; imageInput.accept = 'image/png,image/jpeg,image/webp'; imageInput.hidden = true; element.append(imageInput);
  imageInput.addEventListener('change', async () => {
    const file = imageInput.files?.[0]; imageInput.value = ''; if (!file) return;
    if (file.size > 2_000_000) return say('Choose an image smaller than 2 MB.');
    const target = slide().id;
    try {
      const bitmap = await createImageBitmap(file);
      const c = document.createElement('canvas'); const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height)); c.width = Math.round(bitmap.width * scale); c.height = Math.round(bitmap.height * scale);
      const context = c.getContext('2d'); if (!context) throw new Error('Image processing is unavailable.'); context.drawImage(bitmap, 0, 0, c.width, c.height); bitmap.close();
      const src = c.toDataURL('image/png');
      if (destroyed) return;
      if (snapshot().length + src.length > 4_000_000) return say('This image exceeds the 4 MB presentation limit. Try a smaller image.');
      if (slide().id !== target) return say('Image canceled because you changed slides.');
      const width = Math.min(600, c.width), height = Math.min(380, width * c.height / c.width);
      addObject('image', { src, width: height * c.width / c.height, height, x: 80, y: 80 });
    } catch { say('Unable to read this image. Use a PNG, JPEG, or WebP image.'); }
  });
  function addObject(kind: SlideObject['kind'], values: Partial<SlideObject> = {}) {
    if (slide().objects.length >= 200) return say('Maximum 200 objects per slide.');
    edit(() => { const o = slideObject(kind, kind === 'text' ? values : { width: 220, height: 140, ...values }); slide().objects.push(o); selected = o.id; });
  }
  function paint() {
    canvas.innerHTML = `<rect width="960" height="540" fill="${slide().background}"/>` + slide().objects.map((o) => `<g data-object="${o.id}" tabindex="0" role="button" aria-label="${o.kind} object">${slideObjectSvg(o)}<rect x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" fill="transparent"/></g>`).join('');
    const o = object();
    if (o) {
      const box = document.createElementNS(canvas.namespaceURI, 'g');
      box.innerHTML = `<rect x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" fill="none" stroke="#0284c7" stroke-width="2" stroke-dasharray="5 3" pointer-events="none"/><rect data-resize="1" x="${o.x + o.width - 8}" y="${o.y + o.height - 8}" width="16" height="16" fill="#0284c7" stroke="white" stroke-width="2"/>`;
      canvas.append(box);
    }
    undoButton.disabled = !undo.length; redoButton.disabled = !redo.length;
  }
  function renderStrip() {
    strip.replaceChildren();
    state.slides.forEach((s, index) => {
      const row = el('div', `nb-slides-thumb${index === current ? ' active' : ''}`); row.draggable = true;
      const select = button(`${index + 1}. ${s.title}`, () => { finishText(); current = index; selected = ''; render(); }, row);
      const preview = el('div', 'nb-slides-preview'); preview.innerHTML = slideSvg(s); preview.setAttribute('aria-hidden', 'true'); select.prepend(preview);
      select.setAttribute('aria-current', index === current ? 'true' : 'false');
      bindContextMenu(select, event => { event.preventDefault(); event.stopPropagation(); finishText(); current = index; selected = ''; render(); canvas.focus(); openMenu(event.clientX, event.clientY, pageMenu); });
      row.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('application/x-notebook-slide', s.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('application/x-notebook-slide')) e.preventDefault(); });
      row.addEventListener('drop', (e) => {
        e.preventDefault(); const id = e.dataTransfer?.getData('application/x-notebook-slide'); const from = state.slides.findIndex((s) => s.id === id); if (from < 0 || from === index) return;
        edit(() => { const [moved] = state.slides.splice(from, 1); state.slides.splice(index, 0, moved!); current = index; selected = ''; });
      });
      strip.append(row);
    });
  }
  function renderInspector() {
    inspector.replaceChildren();
    choose('Selection', [['', 'Slide settings'], ...slide().objects.map((o, i): [string, string] => [o.id, `${i + 1}. ${o.kind === 'text' ? o.text.slice(0, 25) || 'Text' : o.kind}`])], selected, (v) => { selected = v; render(); });
    const o = object();
    const heading = el('h3', '', o ? `${o.kind[0]!.toUpperCase()}${o.kind.slice(1)}` : 'Slide'); inspector.append(heading);
    if (o) {
      if (o.kind === 'text') {
        const input = el('textarea'); input.value = o.text; input.maxLength = 20000;
        input.addEventListener('focus', remember); input.addEventListener('input', () => { o.text = input.value; changed(); paint(); }); input.addEventListener('blur', renderStrip); field('Text', input);
        number('Font size', o.fontSize, 8, 144, (n) => edit(() => { o.fontSize = n; }));
        color('Text color', o.color, (v) => edit(() => { o.color = v; }));
        const styles = el('div', 'nb-slides-actions'); inspector.append(styles);
        button('Bold', () => edit(() => { o.bold = !o.bold; }), styles).setAttribute('aria-pressed', String(o.bold));
        button('Italic', () => edit(() => { o.italic = !o.italic; }), styles).setAttribute('aria-pressed', String(o.italic));
        choose('Text alignment', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']], o.align, (v) => edit(() => { o.align = v as SlideObject['align']; }));
      } else if (o.kind !== 'image') color('Fill', o.fill, (v) => edit(() => { o.fill = v; }));
      number('X', o.x, 0, 960 - o.width, (n) => edit(() => { o.x = n; }));
      number('Y', o.y, 0, 540 - o.height, (n) => edit(() => { o.y = n; }));
      number('Width', o.width, 20, 960 - o.x, (n) => edit(() => { o.width = n; }));
      number('Height', o.height, 20, 540 - o.y, (n) => edit(() => { o.height = n; }));
      const actions = el('div', 'nb-slides-actions'); inspector.append(actions);
      button('Center on slide', () => edit(() => { o.x = (960 - o.width) / 2; o.y = (540 - o.height) / 2; }), actions);
      button('Bring forward', () => edit(() => { const i = slide().objects.indexOf(o); if (i < slide().objects.length - 1) { slide().objects.splice(i, 1); slide().objects.splice(i + 1, 0, o); } }), actions);
      button('Send backward', () => edit(() => { const i = slide().objects.indexOf(o); if (i > 0) { slide().objects.splice(i, 1); slide().objects.splice(i - 1, 0, o); } }), actions);
      button('Duplicate object', () => {
        if (slide().objects.length >= 200) return say('Maximum 200 objects per slide.');
        edit(() => { const copy = { ...o, id: slideId(), x: Math.min(960 - o.width, o.x + 20), y: Math.min(540 - o.height, o.y + 20) }; slide().objects.push(copy); selected = copy.id; });
      }, actions);
      button('Delete object', () => edit(() => { slide().objects = slide().objects.filter((v) => v.id !== selected); selected = ''; }), actions);
      button('Slide settings', () => { selected = ''; render(); }, actions);
    } else {
      const title = el('input'); title.value = slide().title; title.maxLength = 200; title.addEventListener('change', () => edit(() => { slide().title = title.value || 'Untitled slide'; })); field('Slide title', title);
      color('Background', slide().background, (v) => edit(() => { slide().background = v; }));
      const actions = el('div', 'nb-slides-actions'); inspector.append(actions);
      button('Duplicate slide', () => {
        if (state.slides.length >= 100) return say('Maximum 100 slides.');
        edit(() => { const copy: NotebookSlide = structuredClone(slide()); copy.id = slideId(); copy.objects.forEach((o) => { o.id = slideId(); }); state.slides.splice(++current, 0, copy); });
      }, actions);
      button('Move earlier', () => moveSlide(-1), actions).disabled = current === 0;
      button('Move later', () => moveSlide(1), actions).disabled = current === state.slides.length - 1;
      button('Delete slide', () => edit(() => { state.slides.splice(current, 1); if (!state.slides.length) state.slides.push(newSlide('blank')); current = Math.min(current, state.slides.length - 1); }), actions);
      inspector.append(el('p', 'nb-slides-hint', 'Drag objects to move. Drag the blue corner to resize. Double-click text to edit. Arrow keys nudge a selected object; Shift moves 10 pixels.'));
    }
  }
  function moveSlide(direction: number) {
    const next = current + direction; if (next < 0 || next >= state.slides.length) return;
    edit(() => { const [moved] = state.slides.splice(current, 1); state.slides.splice(next, 0, moved!); current = next; });
  }
  function render() { paint(); renderStrip(); renderInspector(); notes.value = slide().notes; }
  notes.addEventListener('focus', remember); notes.addEventListener('input', () => { slide().notes = notes.value; changed(); });
  let textObject: SlideObject | undefined;
  function finishText() {
    if (!textObject) return;
    const hasChange = textObject.text !== liveEditor.value;
    textObject.text = liveEditor.value; textObject = undefined; liveEditor.hidden = true;
    if (hasChange) changed();
    paint(); renderStrip();
  }
  liveEditor.addEventListener('input', () => { if (textObject) { textObject.text = liveEditor.value; changed(); } });
  liveEditor.addEventListener('blur', () => { finishText(); renderInspector(); });
  liveEditor.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); finishText(); canvas.focus(); } });
  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * 960 / rect.width, y = (e.clientY - rect.top) * 540 / rect.height;
    const o = [...slide().objects].reverse().find((o) => x >= o.x && x <= o.x + o.width && y >= o.y && y <= o.y + o.height);
    if (!o || o.kind !== 'text') return;
    selected = o.id;
    remember(); textObject = o; liveEditor.value = o.text; liveEditor.hidden = false;
    Object.assign(liveEditor.style, { left: `${o.x / 9.6}%`, top: `${o.y / 5.4}%`, width: `${o.width / 9.6}%`, height: `${o.height / 5.4}%`, fontSize: `${o.fontSize / 9.6}cqw`, fontWeight: o.bold ? '700' : '400', fontStyle: o.italic ? 'italic' : 'normal', textAlign: o.align, color: o.color, background: slide().background });
    liveEditor.focus(); liveEditor.select();
  });
  let drag: { id: number; o: SlideObject; x: number; y: number; original: SlideObject; resize: boolean; moved: boolean } | undefined;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; finishText();
    const target = e.target as Element;
    const resize = !!target.closest('[data-resize]'); const group = target.closest('[data-object]');
    if (!resize) selected = group?.getAttribute('data-object') || '';
    paint(); renderInspector(); const o = object(); if (!o) return;
    e.preventDefault(); canvas.focus(); canvas.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, o, x: e.clientX, y: e.clientY, original: { ...o }, resize, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return; const rect = canvas.getBoundingClientRect(); if (!rect.width) return;
    const dx = (e.clientX - drag.x) * 960 / rect.width, dy = (e.clientY - drag.y) * 540 / rect.height;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
    if (!drag.moved) { remember(); drag.moved = true; }
    const { o, original, resize } = drag;
    if (resize) { o.width = Math.max(20, Math.min(960 - o.x, original.width + dx)); o.height = Math.max(20, Math.min(540 - o.y, original.height + dy)); }
    else { o.x = Math.max(0, Math.min(960 - o.width, original.x + dx)); o.y = Math.max(0, Math.min(540 - o.height, original.y + dy)); }
    paint();
  });
  function finishDrag() { if (!drag) return; const moved = drag.moved; drag = undefined; if (moved) { changed(); render(); } }
  canvas.addEventListener('pointerup', finishDrag); canvas.addEventListener('pointercancel', finishDrag); canvas.addEventListener('lostpointercapture', finishDrag);
  element.addEventListener('keydown', (e) => {
    const target = e.target as Element; if (target.closest('input,textarea,select,[contenteditable=true]')) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); history(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo); return; }
    const o = object();
    if (e.key === 'Escape') { e.stopPropagation(); selected = ''; render(); return; }
    if (o && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); edit(() => { slide().objects = slide().objects.filter((v) => v.id !== selected); selected = ''; }); }
    if (o && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation(); const step = e.shiftKey ? 10 : 1;
      edit(() => { o.x = Math.max(0, Math.min(960 - o.width, o.x + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0))); o.y = Math.max(0, Math.min(540 - o.height, o.y + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0))); }); canvas.focus();
    }
  });
  async function clipboard(action: 'copy' | 'cut' | 'paste') {
    finishText(); const before = snapshot(), slideIdBefore = slide().id, objectId = selected, chosen = object();
    try {
      if (action === 'paste') {
        const raw = await navigator.clipboard.readText();
        if (destroyed || snapshot() !== before || slide().id !== slideIdBefore || selected !== objectId) return say('Paste canceled because the presentation or selection changed.');
        if (raw.length > 4_500_000) throw new Error('Clipboard presentation exceeds the size limit.');
        const data = JSON.parse(raw);
        if (!['rimeward-slide', 'rimeward-slide-object'].includes(data?.kind) || !Array.isArray(data.document?.slides) || data.document.slides.length !== 1) throw new Error('Copy a slide or object from a notebook presentation first.');
        const imported = normalizeSlides(data.document).slides[0];
        imported.id = slideId(); imported.objects.forEach(o => { o.id = slideId(); });
        const next = structuredClone(state);
        if (data.kind === 'rimeward-slide') next.slides.splice(current + 1, 0, imported);
        else next.slides[current].objects.push(...imported.objects);
        normalizeSlides(next);
        if (JSON.stringify(next).length > 4_500_000) throw new Error('Pasting would exceed the presentation size limit.');
        edit(() => { state = next; if (data.kind === 'rimeward-slide') { current++; selected = ''; } else selected = imported.objects.at(-1)?.id ?? ''; });
      } else {
        const copied = chosen ? { ...slide(), objects: [chosen] } : slide();
        await navigator.clipboard.writeText(JSON.stringify({ kind: chosen ? 'rimeward-slide-object' : 'rimeward-slide', document: { version: 1, slides: [copied] } }));
        if (action === 'cut') {
          if (destroyed || snapshot() !== before || slide().id !== slideIdBefore || selected !== objectId) return say('Copied; cut canceled because the presentation or selection changed.');
          const b = [...inspector.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === (chosen ? 'Delete object' : 'Delete slide')); b?.click();
        }
        say(action === 'cut' ? 'Selection cut.' : 'Selection copied.');
      }
    } catch (error) { say(error instanceof SyntaxError ? 'Copy a notebook slide or object first.' : error instanceof Error ? error.message : 'Clipboard unavailable; no objects changed.'); }
  }
  function pageMenu(menu: HTMLElement) {
    for (const action of ['copy', 'cut', 'paste'] as const) menu.append(menuItem('copy', `${action[0].toUpperCase() + action.slice(1)}${action === 'paste' ? ' slide or object' : object() ? ' object' : ' slide'}`, () => void clipboard(action)));

    for (const b of inspector.querySelectorAll<HTMLButtonElement>('button')) {
      const label = b.textContent || b.title;
      const item = menuItem(label.startsWith('Delete') ? 'trash' : 'page', label, () => b.click(), label.startsWith('Delete')) as HTMLButtonElement;
      item.disabled = b.disabled; menu.append(item);
    }
    if (!object()) menu.append(menuItem('pen', 'Rename slide…', () => { const id = slide().id; void askText('Slide title', slide().title).then(title => { if (title?.trim() && !destroyed && slide().id === id) edit(() => { slide().title = title.trim().slice(0, 200); }); }); }));
    else if (object()?.kind === 'text') menu.append(menuItem('pen', 'Edit text', () => { inspector.querySelector('textarea')?.focus(); }));
    for (const label of ['Add slide', 'Text', 'Add shape', 'Image', 'Present', 'Undo', 'Redo']) {
      const b = [...toolbar.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label);
      if (b) { const item = menuItem('page', label, () => b.click()) as HTMLButtonElement; item.disabled = b.disabled; menu.append(item); }
    }
  }
  bindContextMenu(canvas, event => {
    event.preventDefault(); event.stopPropagation(); finishText();
    const target = event.target instanceof Element ? event.target.closest('[data-object]') : null;
    if (target) selected = target.getAttribute('data-object') || '';
    else if (event.detail !== -1) selected = '';
    paint(); renderInspector(); canvas.focus(); openMenu(event.clientX, event.clientY, pageMenu);
  });
  let presentation: HTMLDialogElement | undefined;
  function present() {
    finishText(); if (presentation) return;
    const dialog = el('dialog', 'nb-slides-presentation'); presentation = dialog;
    const frame = el('div', 'nb-slides-present-frame'); const controls = el('div', 'nb-slides-present-controls'); const counter = el('span'); let page = current;
    const draw = () => { frame.innerHTML = slideSvg(state.slides[page]!); counter.textContent = `${page + 1} / ${state.slides.length}`; };
    const go = (by: number) => { page = Math.max(0, Math.min(state.slides.length - 1, page + by)); draw(); };
    button('Previous', () => go(-1), controls); controls.append(counter); button('Next', () => go(1), controls); button('Exit presentation', () => dialog.close(), controls);
    dialog.append(frame, controls); element.append(dialog);
    dialog.addEventListener('keydown', (e) => { e.stopPropagation(); if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); go(1); } if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); go(-1); } if (e.key === 'Home') { page = 0; draw(); } if (e.key === 'End') { page = state.slides.length - 1; draw(); } });
    dialog.addEventListener('close', () => { dialog.remove(); presentation = undefined; element.focus(); }); draw(); dialog.showModal();
  }
  render();
  return { element, load(value) { finishText(); state = normalizeSlides(value); current = 0; selected = ''; undo.length = 0; redo.length = 0; render(); }, serialize() { return structuredClone(state); }, text() { return state.slides.map((s, i) => `Slide ${i + 1}: ${s.title}\n${s.objects.map((o) => o.text).filter(Boolean).join('\n')}${s.notes ? `\nSpeaker notes: ${s.notes}` : ''}`).join('\n\n'); }, focus() { canvas.focus(); }, destroy() { destroyed = true; finishText(); presentation?.close(); element.remove(); } };
}
