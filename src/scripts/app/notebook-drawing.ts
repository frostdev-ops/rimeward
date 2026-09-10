import { saveDocumentBlob } from './document-export.ts';
import { bindContextMenu, menuItem, openMenu } from './menu.ts';
import { el } from './dom.ts';
import type { NotebookPageEngine, NotebookPageOptions } from './notebook-page-engine.ts';
import { blankDrawing, validateDrawing, drawingBounds, drawingContentsSvg, exportDrawingSvg, drawingConnectorPath, DEFAULT_DRAWING_STYLE, DRAWING_LIMITS, type DrawingDocument, type DrawingNode, type DrawingShape, type DrawingConnector } from '../../lib/notebook-drawing.ts';
import '../../styles/notebook-drawing.css';

const NS = 'http://www.w3.org/2000/svg';
type Tool = 'select' | 'pan' | 'connect';
const PALETTE: [DrawingShape, string, string][] = [['rectangle', '▭', 'Process'], ['rounded', '▢', 'Start / end'], ['ellipse', '◯', 'Ellipse'], ['diamond', '◇', 'Decision'], ['parallelogram', '▱', 'Input / output'], ['cylinder', '▤', 'Database'], ['arrow', '➜', 'Arrow'], ['text', 'T', 'Text'], ['bar', '▥', 'Bar chart'], ['line', '⌁', 'Line chart'], ['pie', '◕', 'Pie chart']];
const clone = <T>(value: T): T => structuredClone(value);

export function createDrawingPage(options: NotebookPageOptions): NotebookPageEngine {
  let doc = blankDrawing(), tool: Tool = 'select', sourceId: string | null = null, space = false, destroyed = false;
  let selected = new Set<string>(), undo: string[] = [], redo: string[] = [];
  let width = 800, height = 560, wheelTimer: ReturnType<typeof setTimeout> | undefined;
  const prefix = `drawing-${crypto.randomUUID()}`;
  const element = el('section', 'nb-drawing'); element.setAttribute('aria-label', 'Drawing designer');
  const toolbar = el('div', 'nb-drawing-toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'Drawing tools');
  const body = el('div', 'nb-drawing-body'), palette = el('div', 'nb-drawing-palette'), workspace = el('div', 'nb-drawing-workspace');
  const inspector = el('aside', 'nb-drawing-inspector'); inspector.setAttribute('aria-label', 'Shape properties');
  const status = el('div', 'nb-drawing-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const svg = document.createElementNS(NS, 'svg'); svg.classList.add('nb-drawing-canvas'); svg.setAttribute('tabindex', '0'); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', 'Diagram canvas. Shift-click for multiple selection. Arrow keys move shapes; Delete removes; Enter edits label.');
  const scene = document.createElementNS(NS, 'g'), background = document.createElementNS(NS, 'g'), overlay = document.createElementNS(NS, 'g');
  svg.append(background, scene, overlay); workspace.append(svg); body.append(palette, workspace, inspector); element.append(toolbar, body, status);
  const message = (text: string) => { status.textContent = text; };
  function button(label: string, action: () => void, parent: HTMLElement = toolbar, title = label) {
    const b = el('button', '', label); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.addEventListener('click', action); parent.append(b); return b;
  }
  function field(label: string, input: HTMLElement, parent: HTMLElement = inspector) { const row = el('label', 'nb-drawing-field'); row.append(el('span', '', label), input); parent.append(row); return input; }
  const toolButtons = new Map<Tool, HTMLButtonElement>();
  for (const [name, label] of [['select', 'Select'], ['pan', 'Pan'], ['connect', 'Connect']] as const) toolButtons.set(name, button(label, () => setTool(name)));
  const undoButton = button('↶', () => history(false), toolbar, 'Undo (⌘/Ctrl Z)'), redoButton = button('↷', () => history(true), toolbar, 'Redo (⌘/Ctrl Shift Z)');
  button('Duplicate', duplicate); button('Delete', remove);
  const zoomOut = button('−', () => zoomAt(doc.view.zoom / 1.2), toolbar, 'Zoom out');
  const zoomLabel = el('span', 'nb-drawing-zoom', '100%'); toolbar.append(zoomLabel);
  button('+', () => zoomAt(doc.view.zoom * 1.2), toolbar, 'Zoom in'); button('Fit', fit);
  const grid = el('input'); grid.type = 'checkbox'; grid.checked = true; field('Grid', grid, toolbar); grid.addEventListener('change', () => change(() => { doc.grid = grid.checked; }));
  const snap = el('input'); snap.type = 'checkbox'; snap.checked = true; field('Snap', snap, toolbar); snap.addEventListener('change', () => change(() => { doc.snap = snap.checked; }));
  button('Import JSON', () => file.click()); button('JSON', () => download('drawing.json', JSON.stringify(doc, null, 2), 'application/json'), toolbar, 'Export drawing JSON');
  button('SVG', () => download('drawing.svg', exportDrawingSvg(doc), 'image/svg+xml'), toolbar, 'Export drawing SVG');
  const file = el('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true; element.append(file);
  file.addEventListener('change', async () => {
    const picked = file.files?.[0]; file.value = ''; if (!picked) return;
    try {
      if (picked.size > DRAWING_LIMITS.bytes) throw new Error('Choose a drawing JSON file smaller than 2 MB.');
      const imported = validateDrawing(JSON.parse(await picked.text())); if (destroyed) return;
      change(() => { doc = imported; selected.clear(); sourceId = null; }); fit(); message('Drawing imported. Undo restores the previous drawing.');
    } catch (e) { message(e instanceof Error ? e.message : 'Unable to import drawing.'); }
  });
  palette.setAttribute('aria-label', 'Shape palette');
  for (const [type, icon, label] of PALETTE) {
    const b = button(icon, () => add(type), palette, label); b.append(el('span', '', label)); b.draggable = true;
    b.addEventListener('dragstart', event => { event.dataTransfer?.setData('application/x-rimeward-shape', type); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'; });
  }
  workspace.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('application/x-rimeward-shape')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  workspace.addEventListener('drop', event => { const type = event.dataTransfer?.getData('application/x-rimeward-shape'); if (PALETTE.some(item => item[0] === type)) { event.preventDefault(); add(type as DrawingShape, point(event)); } });
  function snapshot() { return JSON.stringify(doc); }
  function remember(before: string) {
    if (before === snapshot()) return;
    // ponytail: history is capped at 50 snapshots/8 MB; use operation deltas if large diagrams need longer history.
    undo.push(before); while (undo.length > 50 || undo.length > 1 && undo.reduce((s, v) => s + v.length, 0) > 8_000_000) undo.shift();
    redo = []; options.onChange();
  }
  function change(fn: () => void) { const before = snapshot(); fn(); remember(before); render(); properties(); }
  function history(forward: boolean) {
    finishDrag(); const from = forward ? redo : undo, to = forward ? undo : redo, previous = from.pop(); if (!previous) return;
    to.push(snapshot()); doc = validateDrawing(JSON.parse(previous)); selected.clear(); sourceId = null; options.onChange(); render(); properties();
  }
  function setTool(value: Tool) { tool = value; sourceId = null; render(); message(value === 'connect' ? 'Choose a source shape, then a destination shape.' : value === 'pan' ? 'Drag the canvas to pan.' : 'Shift-click to select several shapes. Drag empty space to select an area.'); }
  function connectTo(nodeId: string) {
    if (!sourceId) { sourceId = nodeId; selected = new Set([nodeId]); render(); properties(); message('Choose the destination shape.'); return; }
    if (sourceId === nodeId) return;
    if (doc.connectors.length >= DRAWING_LIMITS.connectors) { message('This drawing has reached the 1,000 connector limit.'); return; }
    const from = sourceId;
    change(() => { const id = crypto.randomUUID(); doc.connectors.push({ id, from, to: nodeId, label: '', route: 'elbow', arrow: 'end', stroke: DEFAULT_DRAWING_STYLE.stroke, strokeWidth: 2, dashed: false }); selected = new Set([id]); sourceId = null; });
    message('Connector added. Choose another source, or switch to Select.');
  }
  function point(event: { clientX: number; clientY: number }) { const r = svg.getBoundingClientRect(); return { x: doc.view.x + (event.clientX - r.left) / doc.view.zoom, y: doc.view.y + (event.clientY - r.top) / doc.view.zoom }; }
  const rounded = (v: number) => doc.snap ? Math.round(v / 10) * 10 : Math.round(v);
  function add(type: DrawingShape, at = { x: doc.view.x + width / doc.view.zoom / 2, y: doc.view.y + height / doc.view.zoom / 2 }) {
    if (doc.nodes.length >= DRAWING_LIMITS.nodes) { message('This drawing has reached the 500 shape limit.'); return; }
    const chart = ['bar', 'line', 'pie'].includes(type), w = chart ? 320 : 160, h = chart ? 240 : 80;
    const id = crypto.randomUUID();
    change(() => { doc.nodes.push({ id, type, x: rounded(at.x - w / 2), y: rounded(at.y - h / 2), width: w, height: h, label: PALETTE.find(p => p[0] === type)?.[2] || 'Shape', ...DEFAULT_DRAWING_STYLE, fill: type === 'text' ? 'none' : DEFAULT_DRAWING_STYLE.fill, data: chart ? [{ label: 'A', value: 30 }, { label: 'B', value: 55 }, { label: 'C', value: 40 }] : [] }); selected = new Set([id]); tool = 'select'; sourceId = null; });
    svg.focus(); message('Shape added. Double-click it to edit its label.');
  }
  function remove() { if (!selected.size) return; change(() => { doc.nodes = doc.nodes.filter(n => !selected.has(n.id)); doc.connectors = doc.connectors.filter(c => !selected.has(c.id) && !selected.has(c.from) && !selected.has(c.to)); selected.clear(); }); }
  function duplicate() {
    const nodes = doc.nodes.filter(n => selected.has(n.id)), edges = doc.connectors.filter(c => selected.has(c.id) || selected.has(c.from) && selected.has(c.to));
    if (doc.nodes.length + nodes.length > DRAWING_LIMITS.nodes || doc.connectors.length + edges.length > DRAWING_LIMITS.connectors) { message('Duplicating would exceed the drawing size limit.'); return; }
    if (!nodes.length && !edges.length) return;
    change(() => {
      const ids = new Map(nodes.map(n => [n.id, crypto.randomUUID()])); selected.clear();
      for (const n of nodes) { const copy = { ...clone(n), id: ids.get(n.id)!, x: n.x + 20, y: n.y + 20 }; doc.nodes.push(copy); selected.add(copy.id); }
      for (const c of edges) { const copy = { ...c, id: crypto.randomUUID(), from: ids.get(c.from) || c.from, to: ids.get(c.to) || c.to }; doc.connectors.push(copy); selected.add(copy.id); }
    });
  }
  function zoomAt(value: number, client?: { clientX: number; clientY: number }) {
    const zoom = Math.max(.1, Math.min(4, value)), rect = svg.getBoundingClientRect(), px = client ? client.clientX - rect.left : width / 2, py = client ? client.clientY - rect.top : height / 2;
    doc.view.x += px / doc.view.zoom - px / zoom; doc.view.y += py / doc.view.zoom - py / zoom; doc.view.zoom = zoom;
    render(); viewChanged();
  }
  function viewChanged() { clearTimeout(wheelTimer); wheelTimer = setTimeout(() => { if (!destroyed) options.onChange(); }, 180); }
  function fit() { const b = drawingBounds(doc.nodes); doc.view.zoom = Math.max(.1, Math.min(2, (width - 40) / b.width, (height - 40) / b.height)); doc.view.x = b.x - (width / doc.view.zoom - b.width) / 2; doc.view.y = b.y - (height / doc.view.zoom - b.height) / 2; render(); viewChanged(); }
  function download(name: string, contents: string, mime: string) { status.textContent = 'Preparing export…'; void saveDocumentBlob(new Blob([contents], { type: mime }), name).then(message => { status.textContent = message; }).catch(error => { status.textContent = `Export failed: ${error.message}`; }); }
  function render() {
    svg.setAttribute('viewBox', `${doc.view.x} ${doc.view.y} ${width / doc.view.zoom} ${height / doc.view.zoom}`);
    background.innerHTML = doc.grid ? `<defs><pattern id="${prefix}-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="${1 / doc.view.zoom}" fill="currentColor"/></pattern></defs><rect x="${doc.view.x}" y="${doc.view.y}" width="${width / doc.view.zoom}" height="${height / doc.view.zoom}" fill="url(#${prefix}-grid)"/>` : '';
    scene.innerHTML = drawingContentsSvg(doc, prefix, true);
    overlay.replaceChildren();
    const size = 9 / doc.view.zoom;
    for (const n of doc.nodes) if (selected.has(n.id) || sourceId === n.id) {
      const rect = document.createElementNS(NS, 'rect');
      for (const [key, value] of Object.entries({ x: n.x - 3, y: n.y - 3, width: n.width + 6, height: n.height + 6, fill: 'none', stroke: 'var(--color-accent, #0284c7)', 'stroke-width': 2 / doc.view.zoom, 'stroke-dasharray': `${5 / doc.view.zoom} ${3 / doc.view.zoom}`, 'pointer-events': 'none' })) rect.setAttribute(key, String(value));
      overlay.append(rect);
      if (selected.has(n.id)) {
        const handle = document.createElementNS(NS, 'rect');
        for (const [key, value] of Object.entries({ x: n.x + n.width - size / 2, y: n.y + n.height - size / 2, width: size, height: size, fill: 'var(--color-accent, #0284c7)', stroke: '#ffffff', 'stroke-width': 1 / doc.view.zoom, 'data-resize': n.id })) handle.setAttribute(key, String(value));
        handle.style.cursor = 'nwse-resize'; overlay.append(handle);
      }
    }
    for (const c of doc.connectors) if (selected.has(c.id)) {
      const from = doc.nodes.find(n => n.id === c.from), to = doc.nodes.find(n => n.id === c.to); if (!from || !to) continue;
      const path = document.createElementNS(NS, 'path'); path.setAttribute('d', drawingConnectorPath(c, from, to).path); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'var(--color-accent, #0284c7)'); path.setAttribute('stroke-width', String((c.strokeWidth + 5) / doc.view.zoom)); path.setAttribute('opacity', '.4'); path.setAttribute('pointer-events', 'none'); overlay.append(path);
    }
    if (drag?.kind === 'box') {
      const rect = document.createElementNS(NS, 'rect'); for (const [k, v] of Object.entries({ x: Math.min(drag.start.x, drag.last.x), y: Math.min(drag.start.y, drag.last.y), width: Math.abs(drag.start.x - drag.last.x), height: Math.abs(drag.start.y - drag.last.y), fill: 'var(--color-accent, #0284c7)', opacity: '.18', 'pointer-events': 'none' })) rect.setAttribute(k, String(v)); overlay.append(rect);
    }
    for (const [name, b] of toolButtons) b.setAttribute('aria-pressed', String(tool === name));
    svg.style.cursor = tool === 'pan' || space ? 'grab' : tool === 'connect' ? 'crosshair' : 'default';
    undoButton.disabled = !undo.length; redoButton.disabled = !redo.length; grid.checked = doc.grid; snap.checked = doc.snap; zoomLabel.textContent = `${Math.round(doc.view.zoom * 100)}%`; zoomOut.disabled = doc.view.zoom <= .1;
  }
  function properties() {
    inspector.replaceChildren(); const nodes = doc.nodes.filter(n => selected.has(n.id)), edges = doc.connectors.filter(c => selected.has(c.id)), first = nodes[0] || edges[0];
    inspector.append(el('h3', '', selected.size ? `${selected.size} selected` : 'Drawing'));
    if (!first) { inspector.append(el('p', '', 'Add a shape or chart, then select it to edit.')); return; }
    const label = el('textarea'); label.value = first.label; label.rows = 3; label.maxLength = 2000; label.dataset.drawingLabel = '';
    field('Label', label); label.addEventListener('input', () => { const before = snapshot(); for (const n of [...nodes, ...edges]) n.label = label.value; remember(before); render(); });
    function number(label: string, value: number, min: number, max: number, apply: (v: number) => void, step = 1) { const input = el('input'); input.type = 'number'; input.value = String(value); input.min = String(min); input.max = String(max); input.step = String(step); field(label, input); input.addEventListener('change', () => { const value = Number(input.value); if (!Number.isFinite(value)) return; change(() => apply(Math.max(min, Math.min(max, value)))); }); }
    function colour(label: string, value: string, apply: (v: string) => void) { const input = el('input'); input.type = 'color'; input.value = value === 'none' ? '#ffffff' : value; field(label, input); input.addEventListener('change', () => change(() => apply(input.value))); }
    function check(label: string, value: boolean, apply: (v: boolean) => void) { const input = el('input'); input.type = 'checkbox'; input.checked = value; field(label, input); input.addEventListener('change', () => change(() => apply(input.checked))); }
    colour('Stroke', first.stroke, v => { for (const n of [...nodes, ...edges]) n.stroke = v; });
    number('Stroke width', first.strokeWidth, edges.length ? 1 : 0, 20, v => { for (const n of [...nodes, ...edges]) n.strokeWidth = v; });
    check('Dashed', first.dashed, v => { for (const n of [...nodes, ...edges]) n.dashed = v; });
    if (nodes.length) {
      const n = nodes[0]; colour('Fill', n.fill, v => { nodes.forEach(n => { n.fill = v; }); }); check('Transparent', n.fill === 'none', v => { nodes.forEach(n => { n.fill = v ? 'none' : DEFAULT_DRAWING_STYLE.fill; }); });
      colour('Text', n.color, v => { nodes.forEach(n => { n.color = v; }); }); number('Font size', n.fontSize, 8, 120, v => { nodes.forEach(n => { n.fontSize = v; }); }); check('Bold', n.bold, v => { nodes.forEach(n => { n.bold = v; }); });
      for (const [key, label, min, max] of [['x', 'X', -100000, 100000], ['y', 'Y', -100000, 100000], ['width', 'Width', 40, 20000], ['height', 'Height', 30, 20000]] as const) number(label, n[key], min, max, v => { nodes.forEach(n => { n[key] = v; }); });
      const layers = el('div', 'nb-drawing-inspector-actions'); inspector.append(layers);
      button('To front', () => change(() => { doc.nodes = [...doc.nodes.filter(n => !selected.has(n.id)), ...nodes]; }), layers);
      button('To back', () => change(() => { doc.nodes = [...nodes, ...doc.nodes.filter(n => !selected.has(n.id))]; }), layers);
      if (nodes.length > 1) {
        const align = el('select'); align.append(new Option('Align shapes…', ''));
        for (const key of ['Left', 'Center', 'Right', 'Top', 'Middle', 'Bottom', 'Distribute horizontally', 'Distribute vertically']) align.append(new Option(key, key));
        field('Align', align); align.addEventListener('change', () => change(() => {
          const left = Math.min(...nodes.map(n => n.x)), top = Math.min(...nodes.map(n => n.y)), right = Math.max(...nodes.map(n => n.x + n.width)), bottom = Math.max(...nodes.map(n => n.y + n.height));
          if (align.value.startsWith('Distribute')) { const horizontal = align.value.endsWith('horizontally'), list = [...nodes].sort((a, b) => horizontal ? a.x - b.x : a.y - b.y); const span = horizontal ? right - left : bottom - top, size = list.reduce((s, n) => s + (horizontal ? n.width : n.height), 0), gap = (span - size) / (list.length - 1); let cursor = horizontal ? left : top; for (const item of list) { item[horizontal ? 'x' : 'y'] = cursor; cursor += (horizontal ? item.width : item.height) + gap; } }
          else for (const item of nodes) { if (align.value === 'Left') item.x = left; if (align.value === 'Center') item.x = (left + right - item.width) / 2; if (align.value === 'Right') item.x = right - item.width; if (align.value === 'Top') item.y = top; if (align.value === 'Middle') item.y = (top + bottom - item.height) / 2; if (align.value === 'Bottom') item.y = bottom - item.height; }
        }));
      }
      if (nodes.length === 1 && ['bar', 'line', 'pie'].includes(n.type)) {
        const type = el('select'); for (const v of ['bar', 'line', 'pie']) type.append(new Option(`${v[0].toUpperCase()}${v.slice(1)} chart`, v)); type.value = n.type; field('Chart type', type); type.addEventListener('change', () => { if (type.value === 'pie' && n.data.some(d => d.value < 0)) { type.value = n.type; message('Pie chart values must be zero or greater.'); return; } change(() => { n.type = type.value as DrawingShape; }); });
        const data = el('textarea'); data.rows = 7; data.value = n.data.map(d => `${d.label}, ${d.value}`).join('\n'); data.placeholder = 'Revenue, 120\nCosts, 80'; field('Data (label, value per line)', data);
        button('Apply chart data', () => {
          const rows = data.value.split('\n').filter(line => line.trim()), parsed: DrawingNode['data'] = [];
          if (rows.length > 60) { message('Charts support up to 60 data points.'); return; }
          for (const row of rows) { const split = row.lastIndexOf(','), value = Number(row.slice(split + 1).trim()); if (split < 1 || !row.slice(split + 1).trim() || !Number.isFinite(value) || Math.abs(value) > 1e12) { message('Each chart row needs a label and a number separated by a comma.'); return; } if (n.type === 'pie' && value < 0) { message('Pie chart values must be zero or greater.'); return; } parsed.push({ label: row.slice(0, split).trim().slice(0, 80), value }); }
          change(() => { n.data = parsed; }); message('Chart updated.');
        }, inspector);
      }
    }
    if (edges.length) {
      const route = el('select'); for (const v of ['line', 'elbow']) route.append(new Option(v === 'line' ? 'Straight' : 'Elbow', v)); route.value = edges[0].route; field('Connector', route); route.addEventListener('change', () => change(() => { edges.forEach(c => { c.route = route.value as DrawingConnector['route']; }); }));
      const arrows = el('select'); for (const [v, label] of [['none', 'None'], ['end', 'End'], ['both', 'Both ends']]) arrows.append(new Option(label, v)); arrows.value = edges[0].arrow; field('Arrowheads', arrows); arrows.addEventListener('change', () => change(() => { edges.forEach(c => { c.arrow = arrows.value as DrawingConnector['arrow']; }); }));
    }
  }
  type Drag = { kind: 'move' | 'resize' | 'pan' | 'box'; pointer: number; start: { x: number; y: number }; last: { x: number; y: number }; client: { x: number; y: number }; before: string; nodes: DrawingNode[]; resize?: string; additive: Set<string>; camera: DrawingDocument['view'] };
  let drag: Drag | null = null;
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.button !== 1) return;
    const target = event.target instanceof Element ? event.target : null, nodeId = target?.closest('[data-node]')?.getAttribute('data-node'), edgeId = target?.closest('[data-connector]')?.getAttribute('data-connector'), resize = target?.closest('[data-resize]')?.getAttribute('data-resize');
    svg.focus(); event.preventDefault(); event.stopPropagation();
    if (tool === 'connect' && nodeId && !space && event.button === 0) {
      connectTo(nodeId);
      return;
    }
    const pan = tool === 'pan' || space || event.button === 1, hit = nodeId || edgeId || resize;
    const additive = new Set(event.shiftKey ? selected : []);
    if (!pan && hit && !resize) { if (event.shiftKey) { if (selected.has(hit)) selected.delete(hit); else selected.add(hit); } else if (!selected.has(hit)) selected = new Set([hit]); }
    if (!pan && !hit && !event.shiftKey) selected.clear();
    const p = point(event);
    drag = { kind: pan ? 'pan' : resize ? 'resize' : nodeId ? 'move' : edgeId ? 'move' : 'box', pointer: event.pointerId, start: p, last: p, client: { x: event.clientX, y: event.clientY }, before: snapshot(), nodes: clone(doc.nodes.filter(n => selected.has(n.id))), resize: resize || undefined, additive, camera: { ...doc.view } };
    svg.setPointerCapture(event.pointerId); render(); properties();
  });
  svg.addEventListener('pointermove', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const p = point(event); drag.last = p;
    if (drag.kind === 'pan') { doc.view.x = drag.camera.x - (event.clientX - drag.client.x) / doc.view.zoom; doc.view.y = drag.camera.y - (event.clientY - drag.client.y) / doc.view.zoom; }
    else if (drag.kind === 'move') { const dx = rounded(p.x - drag.start.x), dy = rounded(p.y - drag.start.y); for (const original of drag.nodes) { const n = doc.nodes.find(n => n.id === original.id); if (n) { n.x = Math.max(-100000, Math.min(100000, original.x + dx)); n.y = Math.max(-100000, Math.min(100000, original.y + dy)); } } }
    else if (drag.kind === 'resize') { const n = doc.nodes.find(n => n.id === drag!.resize), original = drag.nodes.find(n => n.id === drag!.resize); if (n && original) { n.width = Math.max(40, Math.min(20000, rounded(original.width + p.x - drag.start.x))); n.height = Math.max(30, Math.min(20000, rounded(original.height + p.y - drag.start.y))); } }
    else { const x = Math.min(p.x, drag.start.x), y = Math.min(p.y, drag.start.y), right = Math.max(p.x, drag.start.x), bottom = Math.max(p.y, drag.start.y); selected = new Set([...drag.additive, ...doc.nodes.filter(n => n.x >= x && n.y >= y && n.x + n.width <= right && n.y + n.height <= bottom).map(n => n.id)]); }
    render();
  });
  function finishDrag(cancel = false) {
    if (!drag) return; const previous = drag; drag = null;
    if (svg.hasPointerCapture(previous.pointer)) svg.releasePointerCapture(previous.pointer);
    if (cancel) doc = validateDrawing(JSON.parse(previous.before));
    else if (previous.kind === 'pan') viewChanged();
    else if (previous.kind !== 'box') remember(previous.before);
    render(); properties();
  }
  svg.addEventListener('pointerup', () => finishDrag()); svg.addEventListener('pointercancel', () => finishDrag(true));
  svg.addEventListener('lostpointercapture', () => finishDrag());
  svg.addEventListener('dblclick', event => { const target = event.target instanceof Element ? event.target : null, id = target?.closest('[data-node],[data-connector]')?.getAttribute('data-node') || target?.closest('[data-connector]')?.getAttribute('data-connector'); if (id) { selected = new Set([id]); render(); properties(); editLabel(); } });
  function editLabel() { const input = inspector.querySelector<HTMLTextAreaElement>('[data-drawing-label]'); input?.focus(); input?.select(); }
  svg.addEventListener('wheel', event => { event.preventDefault(); event.stopPropagation(); if (event.ctrlKey || event.metaKey) zoomAt(doc.view.zoom * Math.exp(-event.deltaY * .005), event); else { doc.view.x += event.deltaX / doc.view.zoom; doc.view.y += event.deltaY / doc.view.zoom; render(); viewChanged(); } }, { passive: false });
  element.addEventListener('keydown', event => {
    if (event.target instanceof Element && event.target.closest('button, input, textarea, select, [contenteditable]')) return;
    const modifier = event.metaKey || event.ctrlKey, key = event.key.toLowerCase(); let handled = true;
    if (modifier && key === 'z') history(event.shiftKey); else if (modifier && key === 'y') history(true);
    else if (modifier && key === 'a') { selected = new Set([...doc.nodes, ...doc.connectors].map(n => n.id)); render(); properties(); }
    else if (modifier && key === 'd') duplicate();
    else if (event.key === 'Delete' || event.key === 'Backspace') remove();
    else if (event.key === 'Escape') { finishDrag(true); selected.clear(); setTool('select'); properties(); }
    else if (event.key === 'Enter') { const focused = event.target instanceof Element ? event.target.closest('[data-node],[data-connector]') : null; if (tool === 'connect' && focused?.getAttribute('data-node')) connectTo(focused.getAttribute('data-node')!); else { if (focused) { const id = focused.getAttribute('data-node') || focused.getAttribute('data-connector'); if (id) { selected = new Set([id]); render(); properties(); } } editLabel(); } }
    else if (event.code === 'Space') { space = true; svg.style.cursor = 'grab'; }
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) change(() => { const step = event.shiftKey ? 10 : 1; for (const n of doc.nodes) if (selected.has(n.id)) { n.x = Math.max(-100000, Math.min(100000, n.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0))); n.y = Math.max(-100000, Math.min(100000, n.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0))); } });
    else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  });
  element.addEventListener('keyup', event => { if (event.code === 'Space') { space = false; svg.style.cursor = tool === 'pan' ? 'grab' : 'default'; } });
  element.addEventListener('focusout', event => { if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) space = false; });
  async function clipboard(action: 'copy' | 'cut' | 'paste') {
    const before = snapshot(), selection = [...selected].join(',');
    try {
      if (action === 'paste') {
        const raw = await navigator.clipboard.readText();
        if (destroyed || snapshot() !== before || [...selected].join(',') !== selection) return message('Paste canceled because the drawing or selection changed.');
        if (raw.length > DRAWING_LIMITS.bytes) throw new Error('Clipboard drawing exceeds the size limit.');
        const data = JSON.parse(raw);
        if (data?.kind !== 'rimeward-drawing-selection') throw new Error('Copy shapes from a notebook drawing first.');
        const imported = validateDrawing(data.document), ids = new Map(imported.nodes.map(n => [n.id, crypto.randomUUID()]));
        const nodes = imported.nodes.map(n => ({ ...n, id: ids.get(n.id) ?? n.id, x: Math.min(100000, n.x + 20), y: Math.min(100000, n.y + 20) }));
        const edges = imported.connectors.map(c => ({ ...c, id: crypto.randomUUID(), from: ids.get(c.from) ?? c.from, to: ids.get(c.to) ?? c.to }));
        const next = validateDrawing({ ...doc, nodes: [...doc.nodes, ...nodes], connectors: [...doc.connectors, ...edges] });
        change(() => { doc = next; selected = new Set([...nodes, ...edges].map(n => n.id)); });
      } else {
        const edges = doc.connectors.filter(c => selected.has(c.id) || selected.has(c.from) && selected.has(c.to));
        const ids = new Set([...selected, ...edges.flatMap(c => [c.from, c.to])]);
        const copied = { ...blankDrawing(), nodes: doc.nodes.filter(n => ids.has(n.id)), connectors: edges };
        await navigator.clipboard.writeText(JSON.stringify({ kind: 'rimeward-drawing-selection', document: copied }));
        if (action === 'cut') {
          if (destroyed || snapshot() !== before || [...selected].join(',') !== selection) return message('Copied; cut canceled because the drawing or selection changed.');
          remove();
        }
        message(`Selection copied with connector endpoints.${action === 'cut' ? ' Selected originals removed.' : ''}`);
      }
    } catch (error) { message(error instanceof SyntaxError ? 'Copy notebook drawing shapes first.' : error instanceof Error ? error.message : 'Clipboard unavailable; no shapes changed.'); }
  }
  bindContextMenu(svg, event => {
    event.preventDefault(); event.stopPropagation(); finishDrag();
    const target = event.target instanceof Element ? event.target.closest('[data-node],[data-connector]') : null;
    const hit = target?.getAttribute('data-node') || target?.getAttribute('data-connector');
    if (hit && !selected.has(hit)) selected = new Set([hit]);
    else if (!hit && event.detail !== -1) selected.clear();
    render(); properties(); svg.focus();
    openMenu(event.clientX, event.clientY, menu => {
      for (const action of ['copy', 'cut', 'paste'] as const) { const item = menuItem('copy', `${action[0].toUpperCase() + action.slice(1)} shapes`, () => void clipboard(action)) as HTMLButtonElement; item.disabled = action !== 'paste' && !selected.size; menu.append(item); }
      if (selected.size) {
        menu.append(menuItem('pen', 'Edit label', editLabel), menuItem('copy', 'Duplicate', duplicate), menuItem('trash', 'Delete selection', remove, true));
        if (selected.size === 1 && doc.nodes.some(n => selected.has(n.id))) menu.append(menuItem('link', 'Connect from this shape', () => { tool = 'connect'; sourceId = [...selected][0]; render(); message('Choose the destination shape.'); }));
        for (const b of inspector.querySelectorAll<HTMLButtonElement>('.nb-drawing-inspector-actions button')) menu.append(menuItem('page', b.textContent ?? b.title, () => b.click()));
        for (const select of inspector.querySelectorAll<HTMLSelectElement>('select')) {
          const label = select.closest('label')?.querySelector('span')?.textContent || '';
          for (const option of [...select.options].filter(o => o.value)) menu.append(menuItem('pen', `${label}: ${option.text}`, () => { select.value = option.value; select.dispatchEvent(new Event('change')); }));
        }
      } else for (const [type, , label] of PALETTE) menu.append(menuItem('plus', `Add ${label.toLowerCase()}`, () => add(type, point(event))));
      menu.append(menuItem('list', 'Select all', () => { selected = new Set([...doc.nodes, ...doc.connectors].map(n => n.id)); render(); properties(); }));
      for (const [b, label] of [[undoButton, 'Undo'], [redoButton, 'Redo']] as const) { const item = menuItem('undo', label, () => b.click()) as HTMLButtonElement; item.disabled = b.disabled; menu.append(item); }
      menu.append(menuItem('resize', 'Fit drawing', fit));
    });
  });
  const observer = new ResizeObserver(() => { const rect = workspace.getBoundingClientRect(); if (rect.width && rect.height) { width = rect.width; height = rect.height; render(); } }); observer.observe(workspace);
  render(); properties(); message('Add a shape, or drag one onto the canvas.');
  return {
    element,
    load(value) { finishDrag(true); clearTimeout(wheelTimer); doc = validateDrawing(value); selected.clear(); undo = []; redo = []; sourceId = null; render(); properties(); },
    serialize() { return clone(doc); },
    text() { return doc.nodes.map(n => `${n.type}: ${n.label}${n.data.length ? '\n' + n.data.map(d => `${d.label}: ${d.value}`).join(', ') : ''}`).join('\n') + (doc.connectors.length ? '\n' + doc.connectors.map(c => `${doc.nodes.find(n => n.id === c.from)?.label || c.from} → ${doc.nodes.find(n => n.id === c.to)?.label || c.to}${c.label ? ': ' + c.label : ''}`).join('\n') : ''); },
    focus() { svg.focus(); },
    destroy() { destroyed = true; clearTimeout(wheelTimer); observer.disconnect(); drag = null; element.remove(); },
  };
}
