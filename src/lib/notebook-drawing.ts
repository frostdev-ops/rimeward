/** Portable diagram data and SVG. No HTML, external resources, or executable SVG is imported. */
export const DRAWING_SHAPES = ['rectangle', 'rounded', 'ellipse', 'diamond', 'parallelogram', 'cylinder', 'arrow', 'text', 'bar', 'line', 'pie'] as const;
export type DrawingShape = typeof DRAWING_SHAPES[number];
export interface DrawingStyle { fill: string; stroke: string; color: string; strokeWidth: number; fontSize: number; bold: boolean; dashed: boolean }
export interface DrawingNode extends DrawingStyle {
  id: string; type: DrawingShape; x: number; y: number; width: number; height: number; label: string;
  data: { label: string; value: number }[];
}
export interface DrawingConnector { id: string; from: string; to: string; label: string; route: 'line' | 'elbow'; arrow: 'none' | 'end' | 'both'; stroke: string; strokeWidth: number; dashed: boolean }
export interface DrawingDocument { version: 1; nodes: DrawingNode[]; connectors: DrawingConnector[]; view: { x: number; y: number; zoom: number }; grid: boolean; snap: boolean }
export const DRAWING_LIMITS = { nodes: 500, connectors: 1000, bytes: 2_000_000 };
export const DEFAULT_DRAWING_STYLE: DrawingStyle = { fill: '#e6f7ff', stroke: '#0284c7', color: '#0c1a2b', strokeWidth: 2, fontSize: 16, bold: false, dashed: false };
export const blankDrawing = (): DrawingDocument => ({ version: 1, nodes: [], connectors: [], view: { x: 0, y: 0, zoom: 1 }, grid: true, snap: true });
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const finite = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
const label = (v: unknown, max = 2000) => typeof v === 'string' ? v.slice(0, max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') : '';
const color = (v: unknown, fallback: string, transparent = false) => typeof v === 'string' && (/^#[0-9a-f]{6}$/i.test(v) || transparent && v === 'none') ? v : fallback;
const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v) ? v : '';

export function validateDrawing(value: unknown): DrawingDocument {
  if (value == null) return blankDrawing();
  const source = record(value);
  if (source.version !== 1 || !Array.isArray(source.nodes) || !Array.isArray(source.connectors)) throw new Error('This is not a supported drawing document.');
  if (source.nodes.length > DRAWING_LIMITS.nodes || source.connectors.length > DRAWING_LIMITS.connectors) throw new Error('Drawing exceeds 500 shapes or 1,000 connectors.');
  const used = new Set<string>();
  const nodes = source.nodes.map((raw): DrawingNode => {
    const n = record(raw), nodeId = id(n.id);
    if (!nodeId || used.has(nodeId) || !DRAWING_SHAPES.includes(n.type as DrawingShape)) throw new Error('Drawing contains an invalid or duplicate shape.');
    used.add(nodeId);
    return { id: nodeId, type: n.type as DrawingShape, x: finite(n.x, 0, -100000, 100000), y: finite(n.y, 0, -100000, 100000),
      width: finite(n.width, 160, 40, 20000), height: finite(n.height, 80, 30, 20000), label: label(n.label),
      fill: color(n.fill, DEFAULT_DRAWING_STYLE.fill, true), stroke: color(n.stroke, DEFAULT_DRAWING_STYLE.stroke), color: color(n.color, DEFAULT_DRAWING_STYLE.color),
      strokeWidth: finite(n.strokeWidth, 2, 0, 20), fontSize: finite(n.fontSize, 16, 8, 120), bold: n.bold === true, dashed: n.dashed === true,
      data: Array.isArray(n.data) ? n.data.slice(0, 60).map(item => { const d = record(item); return { label: label(d.label, 80), value: finite(d.value, 0, -1e12, 1e12) }; }) : [],
    };
  });
  const nodeIds = new Set(used);
  const connectors = source.connectors.map((raw): DrawingConnector => {
    const c = record(raw), edgeId = id(c.id), from = id(c.from), to = id(c.to);
    if (!edgeId || used.has(edgeId) || !nodeIds.has(from) || !nodeIds.has(to) || from === to) throw new Error('Drawing contains an invalid connector.');
    used.add(edgeId);
    return { id: edgeId, from, to, label: label(c.label), route: c.route === 'elbow' ? 'elbow' : 'line', arrow: c.arrow === 'none' || c.arrow === 'both' ? c.arrow : 'end',
      stroke: color(c.stroke, DEFAULT_DRAWING_STYLE.stroke), strokeWidth: finite(c.strokeWidth, 2, 1, 20), dashed: c.dashed === true };
  });
  const view = record(source.view);
  return { version: 1, nodes, connectors, view: { x: finite(view.x, 0, -100000, 100000), y: finite(view.y, 0, -100000, 100000), zoom: finite(view.zoom, 1, .1, 4) }, grid: source.grid !== false, snap: source.snap !== false };
}

export const escapeDrawingXml = (value: string): string => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const num = (value: number) => String(Math.round(value * 1000) / 1000);
export function drawingBounds(nodes: DrawingNode[]) {
  if (!nodes.length) return { x: 0, y: 0, width: 800, height: 600 };
  const x = Math.min(...nodes.map(n => n.x)) - 40, y = Math.min(...nodes.map(n => n.y)) - 40;
  return { x, y, width: Math.max(...nodes.map(n => n.x + n.width)) - x + 40, height: Math.max(...nodes.map(n => n.y + n.height)) - y + 40 };
}
/** Anchor on the boundary, so connectors stay attached while a node moves/resizes. */
export function drawingAnchor(n: DrawingNode, toward: { x: number; y: number }) {
  const cx = n.x + n.width / 2, cy = n.y + n.height / 2, dx = toward.x - cx, dy = toward.y - cy;
  const rx = n.width / 2, ry = n.height / 2;
  const scale = n.type === 'ellipse' ? 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2) : n.type === 'diamond' ? 1 / (Math.abs(dx / rx) + Math.abs(dy / ry)) : 1 / Math.max(Math.abs(dx / rx), Math.abs(dy / ry));
  return Number.isFinite(scale) ? { x: cx + dx * scale, y: cy + dy * scale } : { x: cx + rx, y: cy };
}
export function drawingConnectorPath(c: DrawingConnector, from: DrawingNode, to: DrawingNode) {
  const a = drawingAnchor(from, { x: to.x + to.width / 2, y: to.y + to.height / 2 });
  const b = drawingAnchor(to, { x: from.x + from.width / 2, y: from.y + from.height / 2 });
  if (c.route === 'line') return { path: `M${num(a.x)} ${num(a.y)} L${num(b.x)} ${num(b.y)}`, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  // Use side ports for orthogonal connectors, avoiding diagonal segments at the node.
  if (horizontal) { a.x = from.x + (b.x >= a.x ? from.width : 0); a.y = from.y + from.height / 2; b.x = to.x + (b.x >= a.x ? 0 : to.width); b.y = to.y + to.height / 2; }
  else { a.y = from.y + (b.y >= a.y ? from.height : 0); a.x = from.x + from.width / 2; b.y = to.y + (b.y >= a.y ? 0 : to.height); b.x = to.x + to.width / 2; }
  const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
  return { path: horizontal ? `M${num(a.x)} ${num(a.y)} H${num(x)} V${num(b.y)} H${num(b.x)}` : `M${num(a.x)} ${num(a.y)} V${num(y)} H${num(b.x)} V${num(b.y)}`, x, y };
}

function wrappedLabel(text: string, width: number, fontSize: number): string[] {
  const max = Math.max(1, Math.floor(width / (fontSize * .6)));
  return text.split('\n').flatMap(line => {
    const lines: string[] = []; let remaining = line;
    while (remaining.length > max && lines.length < 30) {
      const space = remaining.lastIndexOf(' ', max), end = space > max / 3 ? space : max;
      lines.push(remaining.slice(0, end)); remaining = remaining.slice(end).trimStart();
    }
    lines.push(remaining); return lines;
  }).slice(0, 30);
}
const CHART_COLORS = ['#0284c7', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0891b2'];
function chartSvg(n: DrawingNode): string {
  const values = n.data, w = n.width - 40, h = Math.max(20, n.height - 85), x = 28, y = 42;
  if (!values.length) return '';
  let marks = '';
  if (n.type === 'pie') {
    const total = values.reduce((s, d) => s + Math.max(0, d.value), 0), r = Math.max(10, Math.min(w * .28, h / 2));
    let angle = -Math.PI / 2;
    values.forEach((d, i) => {
      if (d.value <= 0 || !total) return;
      const end = angle + d.value / total * Math.PI * 2, cx = x + r, cy = y + h / 2, fill = CHART_COLORS[i % CHART_COLORS.length];
      if (d.value === total) marks += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
      else marks += `<path d="M${cx} ${cy} L${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)} A${r} ${r} 0 ${end - angle > Math.PI ? 1 : 0} 1 ${cx + r * Math.cos(end)} ${cy + r * Math.sin(end)} Z" fill="${fill}"/>`;
      angle = end;
    });
    values.slice(0, Math.max(1, Math.floor(h / 18))).forEach((d, i) => { marks += `<rect x="${x + r * 2 + 12}" y="${y + i * 18}" width="9" height="9" fill="${CHART_COLORS[i % CHART_COLORS.length]}"/><text x="${x + r * 2 + 25}" y="${y + i * 18 + 9}" font-size="11" fill="${n.color}">${escapeDrawingXml(d.label.slice(0, 12))} ${d.value}</text>`; });
    return marks;
  }
  const low = Math.min(0, ...values.map(d => d.value)), high = Math.max(1, ...values.map(d => d.value));
  const py = (v: number) => y + h - (v - low) / (high - low) * h, step = w / values.length;
  marks += `<path d="M${x} ${y} V${y + h} M${x} ${py(0)} H${x + w}" stroke="${n.stroke}" fill="none" stroke-width="1"/>`;
  const points: string[] = [];
  values.forEach((d, i) => {
    const cx = x + step * (i + .5), top = py(d.value);
    if (n.type === 'bar') marks += `<rect x="${cx - step * .35}" y="${Math.min(top, py(0))}" width="${step * .7}" height="${Math.max(1, Math.abs(top - py(0)))}" fill="${CHART_COLORS[i % CHART_COLORS.length]}"><title>${escapeDrawingXml(d.label)}: ${d.value}</title></rect>`;
    else { points.push(`${cx},${top}`); marks += `<circle cx="${cx}" cy="${top}" r="3" fill="${n.stroke}"><title>${escapeDrawingXml(d.label)}: ${d.value}</title></circle>`; }
    if (values.length <= 12) marks += `<text x="${cx}" y="${y + h + 15}" text-anchor="middle" font-size="10" fill="${n.color}">${escapeDrawingXml(d.label.slice(0, 9))}</text><text x="${cx}" y="${Math.max(y + 10, top - 5)}" text-anchor="middle" font-size="10" fill="${n.color}">${d.value}</text>`;
  });
  if (n.type === 'line') marks += `<polyline points="${points.join(' ')}" stroke="${n.stroke}" stroke-width="${n.strokeWidth}" fill="none"/>`;
  return marks;
}

export function drawingNodeSvg(n: DrawingNode, interactive = false): string {
  const w = n.width, h = n.height, chart = ['bar', 'line', 'pie'].includes(n.type);
  const style = `fill="${n.type === 'text' ? 'none' : n.fill}" stroke="${n.type === 'text' ? 'none' : n.stroke}" stroke-width="${n.strokeWidth}"${n.dashed ? ' stroke-dasharray="6 4"' : ''}`;
  let shape: string;
  if (n.type === 'ellipse') shape = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" ${style}/>`;
  else if (n.type === 'diamond') shape = `<polygon points="${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}" ${style}/>`;
  else if (n.type === 'parallelogram') shape = `<polygon points="${w * .18},0 ${w},0 ${w * .82},${h} 0,${h}" ${style}/>`;
  else if (n.type === 'arrow') shape = `<polygon points="0,${h * .25} ${w * .65},${h * .25} ${w * .65},0 ${w},${h / 2} ${w * .65},${h} ${w * .65},${h * .75} 0,${h * .75}" ${style}/>`;
  else if (n.type === 'cylinder') shape = `<path d="M0 ${h * .15} A${w / 2} ${h * .15} 0 0 1 ${w} ${h * .15} V${h * .85} A${w / 2} ${h * .15} 0 0 1 0 ${h * .85} Z M0 ${h * .15} A${w / 2} ${h * .15} 0 0 0 ${w} ${h * .15}" ${style}/>`;
  else shape = `<rect width="${w}" height="${h}" rx="${n.type === 'rounded' ? Math.min(20, h / 2) : 0}" ${style}/>`;
  const lines = wrappedLabel(n.label, w * (n.type === 'diamond' ? .55 : .85), n.fontSize).slice(0, chart ? 1 : Math.max(1, Math.floor(h * .8 / (n.fontSize * 1.2))));
  const startY = chart ? 25 : h / 2 - (lines.length - 1) * n.fontSize * .6 + n.fontSize * .35;
  const text = lines.map((line, i) => `<tspan x="${w / 2}" y="${startY + i * n.fontSize * 1.2}">${escapeDrawingXml(line)}</tspan>`).join('');
  return `<g transform="translate(${n.x} ${n.y})"${interactive ? ` data-node="${n.id}" role="button" tabindex="0" aria-label="${escapeDrawingXml(n.label || n.type)}"` : ''}><title>${escapeDrawingXml(n.label || n.type)}</title>${shape}${interactive ? `<rect width="${w}" height="${h}" fill="transparent" stroke="none"/>` : ''}<g font-family="system-ui, sans-serif" pointer-events="none"><text fill="${n.color}" font-size="${n.fontSize}" font-weight="${n.bold ? 700 : 400}" text-anchor="middle">${text}</text>${chart ? chartSvg(n) : ''}</g></g>`;
}

export function drawingContentsSvg(doc: DrawingDocument, prefix = 'drawing', interactive = false): string {
  const nodes = new Map(doc.nodes.map(n => [n.id, n]));
  return doc.connectors.map(c => {
    const from = nodes.get(c.from), to = nodes.get(c.to); if (!from || !to) return '';
    const path = drawingConnectorPath(c, from, to), marker = `${prefix}-${c.id}`;
    return `<g${interactive ? ` data-connector="${c.id}" role="button" tabindex="0" aria-label="${escapeDrawingXml(c.label || 'Connector')}"` : ''}><defs><marker id="${marker}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="${c.stroke}"/></marker></defs>${interactive ? `<path d="${path.path}" stroke="transparent" stroke-width="16" fill="none"/>` : ''}<path d="${path.path}" fill="none" stroke="${c.stroke}" stroke-width="${c.strokeWidth}"${c.dashed ? ' stroke-dasharray="6 4"' : ''}${c.arrow !== 'none' ? ` marker-end="url(#${marker})"` : ''}${c.arrow === 'both' ? ` marker-start="url(#${marker})"` : ''}/><text x="${path.x}" y="${path.y - 8}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="${c.stroke}" pointer-events="none">${escapeDrawingXml(c.label)}</text></g>`;
  }).join('') + doc.nodes.map(n => drawingNodeSvg(n, interactive)).join('');
}

export function exportDrawingSvg(value: unknown): string {
  const doc = validateDrawing(value), b = drawingBounds(doc.nodes);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(b.width)}" height="${Math.ceil(b.height)}" viewBox="${b.x} ${b.y} ${b.width} ${b.height}"><title>Notebook drawing</title>${drawingContentsSvg(doc)}</svg>`;
}
