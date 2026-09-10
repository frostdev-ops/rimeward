/** A portable 16:9 slide document. Coordinates use a 960 × 540 canvas. */
export interface SlideObject {
  id: string;
  kind: 'text' | 'rectangle' | 'ellipse' | 'arrow' | 'image';
  x: number; y: number; width: number; height: number;
  text: string; src: string; fill: string; color: string;
  fontSize: number; bold: boolean; italic: boolean;
  align: 'left' | 'center' | 'right';
}
export interface NotebookSlide { id: string; title: string; background: string; objects: SlideObject[]; notes: string }
export interface SlidesDocument { version: 1; slides: NotebookSlide[] }
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown, fallback = '', max = 20000) => typeof v === 'string' ? v.slice(0, max) : fallback;
const num = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const color = (v: unknown, fallback: string) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
export const slideId = () => crypto.randomUUID();
export function slideObject(kind: SlideObject['kind'], value: Partial<SlideObject> = {}): SlideObject {
  return { id: slideId(), kind, x: 80, y: 100, width: 380, height: 100, text: kind === 'text' ? 'Add your text' : '', src: '', fill: '#0ea5e9', color: '#152238', fontSize: 32, bold: false, italic: false, align: 'left', ...value };
}
export function newSlide(layout = 'title'): NotebookSlide {
  const objects = layout === 'blank' ? [] : [slideObject('text', { x: 70, y: layout === 'title' ? 155 : 50, width: 820, height: 110, text: 'Slide title', fontSize: 48, bold: true })];
  if (layout === 'title') objects.push(slideObject('text', { x: 70, y: 280, width: 820, height: 100, text: 'Add a subtitle', fontSize: 26 }));
  if (layout === 'content') objects.push(slideObject('text', { x: 70, y: 175, width: 820, height: 300, text: 'Add your ideas here', fontSize: 28 }));
  if (layout === 'columns') for (const x of [70, 510]) objects.push(slideObject('text', { x, y: 175, width: 380, height: 300, text: 'Add your ideas here', fontSize: 28 }));
  return { id: slideId(), title: 'Untitled slide', background: '#ffffff', objects, notes: '' };
}
export function normalizeSlides(value: unknown): SlidesDocument {
  const root = record(value);
  if (!Array.isArray(root.slides) || !root.slides.length) return { version: 1, slides: [newSlide()] };
  if (root.slides.length > 100) throw new Error('A presentation can contain up to 100 slides.');
  let imageBytes = 0;
  const ids = new Set<string>();
  const id = (value: unknown) => {
    const key = typeof value === 'string' && /^[a-z\d_-]{1,80}$/i.test(value) && !ids.has(value) ? value : slideId();
    ids.add(key); return key;
  };
  const slides = root.slides.map((raw) => {
    const s = record(raw);
    const input = Array.isArray(s.objects) ? s.objects : [];
    if (input.length > 200) throw new Error('A slide can contain up to 200 objects.');
    const objects = input.map((rawObject) => {
      const o = record(rawObject);
      const kind = ['text', 'rectangle', 'ellipse', 'arrow', 'image'].includes(String(o.kind)) ? o.kind as SlideObject['kind'] : 'text';
      const src = typeof o.src === 'string' && /^data:image\/(png|jpeg|webp);base64,[a-z\d+/=]+$/i.test(o.src) ? o.src : '';
      imageBytes += src.length;
      if (imageBytes > 4_000_000) throw new Error('Embedded images exceed the 4 MB presentation limit.');
      const width = num(o.width, 380, 20, 960), height = num(o.height, 100, 20, 540);
      return slideObject(kind, { id: id(o.id), x: num(o.x, 80, 0, 960 - width), y: num(o.y, 100, 0, 540 - height), width, height, text: str(o.text), src, fill: color(o.fill, '#0ea5e9'), color: color(o.color, '#152238'), fontSize: num(o.fontSize, 32, 8, 144), bold: o.bold === true, italic: o.italic === true, align: o.align === 'center' || o.align === 'right' ? o.align : 'left' });
    });
    return { id: id(s.id), title: str(s.title, 'Untitled slide', 200), background: color(s.background, '#ffffff'), notes: str(s.notes), objects };
  });
  return { version: 1, slides };
}
const xml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
/** Shared wrapping keeps editor, thumbnails and exports identical. */
export function slideTextLines(o: SlideObject): string[] {
  const columns = Math.max(1, Math.floor(o.width / (o.fontSize * 0.56)));
  return o.text.split('\n').flatMap((line) => {
    const lines: string[] = [];
    let rest = line;
    while (rest.length > columns) {
      const space = rest.lastIndexOf(' ', columns);
      const cut = space > columns / 3 ? space : columns;
      lines.push(rest.slice(0, cut)); rest = rest.slice(cut + (rest[cut] === ' ' ? 1 : 0));
    }
    return [...lines, rest];
  });
}
export function slideObjectSvg(o: SlideObject): string {
  const x = o.x, y = o.y, w = o.width, h = o.height;
  if (o.kind === 'image') return `<image href="${xml(o.src)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>`;
  if (o.kind === 'rectangle') return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${o.fill}"/>`;
  if (o.kind === 'ellipse') return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${o.fill}"/>`;
  if (o.kind === 'arrow') return `<path d="M${x},${y + h * .3}H${x + w * .65}V${y}L${x + w},${y + h / 2}L${x + w * .65},${y + h}V${y + h * .7}H${x}Z" fill="${o.fill}"/>`;
  const tx = o.align === 'center' ? x + w / 2 : o.align === 'right' ? x + w : x;
  return `<svg x="${x}" y="${y}" width="${w}" height="${h}" overflow="hidden"><text x="${tx - x}" y="${o.fontSize}" font-family="Arial, sans-serif" font-size="${o.fontSize}" font-weight="${o.bold ? 700 : 400}" font-style="${o.italic ? 'italic' : 'normal'}" fill="${o.color}" text-anchor="${o.align === 'center' ? 'middle' : o.align === 'right' ? 'end' : 'start'}">${slideTextLines(o).map((line, i) => `<tspan x="${tx - x}" dy="${i ? o.fontSize * 1.25 : 0}">${xml(line)}</tspan>`).join('')}</text></svg>`;
}
export function slideSvg(slide: NotebookSlide): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" width="960" height="540" role="img" aria-label="${xml(slide.title)}"><title>${xml(slide.title)}</title><rect width="960" height="540" fill="${slide.background}"/>${slide.objects.map(slideObjectSvg).join('')}</svg>`;
}
export function slidesHtml(doc: SlidesDocument): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Presentation</title><style>body{margin:0;background:#111;font-family:Arial;color:white}section{height:100vh;display:grid;place-items:center;break-after:page}svg{display:block;width:100%;max-height:100vh;height:auto}nav{position:fixed;bottom:12px;right:12px}button{padding:8px 14px;margin:4px}@media print{@page{size:landscape;margin:0}body{background:white}section{height:100vh}nav{display:none}}</style>${doc.slides.map((s) => `<section>${slideSvg(s)}</section>`).join('')}<nav><button onclick="window.scrollBy(0,-innerHeight)">Previous</button><button onclick="window.scrollBy(0,innerHeight)">Next</button><button onclick="window.print()">Print / PDF</button></nav><script>addEventListener('keydown',e=>{if(['ArrowRight','ArrowDown','PageDown',' '].includes(e.key)){e.preventDefault();scrollBy(0,innerHeight)}if(['ArrowLeft','ArrowUp','PageUp'].includes(e.key)){e.preventDefault();scrollBy(0,-innerHeight)}})</script></html>`;
}
