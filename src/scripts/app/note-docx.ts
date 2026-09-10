import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from 'fflate';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const HTML_LIMIT = 16 * 1024 * 1024;
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS = `xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const esc = (v: unknown) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const children = (node: Element, name?: string) => Array.from(node.children).filter((e) => !name || e.localName === name);
const child = (node: Element | undefined | null, name: string) => node ? children(node, name)[0] : undefined;
const descendants = (node: Element | Document, name: string) => Array.from(node.getElementsByTagNameNS('*', name));
const attr = (node: Element | undefined | null, name: string) => node?.getAttributeNS(W, name) ?? node?.getAttribute(`w:${name}`) ?? node?.getAttribute(name) ?? '';
const value = (node: Element | undefined | null, name: string) => attr(child(node, name), 'val');
const finite = (v: string | null | undefined, fallback = 0, min = -100000, max = 100000) => v && Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback;
const on = (node: Element | undefined) => !!node && !['0', 'false', 'off', 'none'].includes(attr(node, 'val'));
const hex = (v: string) => /^[\da-f]{6}$/i.test(v) ? `#${v}` : '';
const fonts = new Set(['arial', 'calibri', 'cambria', 'georgia', 'helvetica', 'times new roman', 'courier new', 'verdana', 'system-ui', 'serif', 'sans-serif', 'monospace']);
const highlight: Record<string, string> = { yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff' };
type Rel = { id: string; target: string; type: string; external: boolean };
type Style = Record<string, string>;
const styleAttr = (style: Style) => Object.keys(style).length ? ` style="${esc(Object.entries(style).map(([k, v]) => `${k}:${v}`).join(';'))}"` : '';
const base64 = (bytes: Uint8Array) => {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(binary);
};

/** DOCX is an untrusted ZIP: reject large archives before inflating any part. */
export async function importDocx(file: File): Promise<{ html: string; warnings: string[] }> {
  if (!file.size || file.size > 15_000_000) throw new Error('Choose a DOCX file smaller than 15 MB.');
  let total = 0, count = 0;
  const names = new Set<string>();
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (entry) => {
    if (++count > 2000 || (total += entry.originalSize) > 35_000_000 || entry.originalSize > 10_000_000) throw new Error('The DOCX exceeds the 35 MB expanded size limit.');
    if (entry.name.endsWith('/')) return false;
    if (entry.name.startsWith('/') || /[\\\x00-\x1f]/.test(entry.name) || entry.name.split('/').some((part) => part === '..' || part === '.') || names.has(entry.name.toLowerCase())) throw new Error('The DOCX contains invalid or duplicate package paths.');
    names.add(entry.name.toLowerCase()); return true;
  } });
  if (Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0) > 35_000_000) throw new Error('The DOCX expands beyond 35 MB.');
  const warnings = new Set<string>();
  const warn = (text: string) => { warnings.add(text); };
  const cache = new Map<string, Document>();
  function xml(path: string): Document | undefined {
    if (cache.has(path)) return cache.get(path);
    const bytes = files[path]; if (!bytes) return;
    if (bytes.length > 5_000_000) throw new Error('A DOCX XML part exceeds 5 MB.');
    const text = strFromU8(bytes); if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('DOCX XML entity declarations are not supported.');
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error(`Unable to read DOCX part ${path}.`);
    if (doc.getElementsByTagName('*').length > 100000) throw new Error('The document contains too many elements.');
    cache.set(path, doc); return doc;
  }
  const relationshipCache = new Map<string, Rel[]>();
  function relationships(part: string): Rel[] {
    if (relationshipCache.has(part)) return relationshipCache.get(part)!;
    const slash = part.lastIndexOf('/'), folder = part.slice(0, slash + 1);
    const doc = xml(`${folder}_rels/${part.slice(slash + 1)}.rels`);
    if (!doc) return [];
    const result = descendants(doc, 'Relationship').map((r) => {
      const external = r.getAttribute('TargetMode') === 'External'; let target = r.getAttribute('Target') || '';
      if (!external) {
        const path = target.startsWith('/') ? target.slice(1) : folder + target;
        const parts: string[] = []; for (const p of path.split('/')) { if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p); } target = parts.join('/');
      }
      return { id: r.getAttribute('Id') || '', target, type: r.getAttribute('Type') || '', external };
    });
    relationshipCache.set(part, result); return result;
  }
  const rootRel = relationships('').find((r) => r.type.endsWith('/officeDocument') && !r.external);
  const main = rootRel?.target || 'word/document.xml';
  const mainXml = xml(main); const body = mainXml && descendants(mainXml, 'body')[0];
  if (!body) throw new Error('This file is not a supported Word DOCX document.');
  const rels = relationships(main);
  const part = (kind: string) => rels.find((r) => r.type.endsWith(`/${kind}`) && !r.external)?.target;
  const stylesXml = xml(part('styles') || 'word/styles.xml');
  const styles = new Map((stylesXml ? descendants(stylesXml, 'style') : []).map((s) => [attr(s, 'styleId'), s]));
  const defaults = stylesXml ? descendants(stylesXml, 'docDefaults')[0] : undefined;
  function styleChain(id: string, seen = new Set<string>()): Element[] {
    if (!id || seen.has(id) || seen.size > 12) return [];
    seen.add(id); const s = styles.get(id); return s ? [...styleChain(value(s, 'basedOn'), seen), s] : [];
  }
  function properties(p: Element, kind: 'pPr' | 'rPr', paragraphStyle = ''): Element[] {
    const own = child(p, kind);
    const style = value(own, kind === 'pPr' ? 'pStyle' : 'rStyle');
    const defaultPr = child(child(defaults, kind === 'pPr' ? 'pPrDefault' : 'rPrDefault'), kind);
    return [defaultPr, ...styleChain(paragraphStyle).map((s) => child(s, kind)), ...styleChain(style).map((s) => child(s, kind)), own].filter((s): s is Element => !!s);
  }
  function runStyle(props: Element[]): { style: Style; tags: string[] } {
    const css: Style = {}; const toggles: Record<string, boolean> = {};
    for (const p of props) {
      for (const [key, tag] of [['b', 'strong'], ['i', 'em'], ['u', 'u'], ['strike', 's']] as const) { const n = child(p, key); if (n) toggles[tag] = on(n); }
      const align = value(p, 'vertAlign'); if (align) { toggles.sub = align === 'subscript'; toggles.sup = align === 'superscript'; }
      const size = value(p, 'sz'); if (size) css['font-size'] = `${finite(size, 22, 12, 198) / 2}pt`;
      const name = attr(child(p, 'rFonts'), 'ascii') || attr(child(p, 'rFonts'), 'hAnsi');
      if (name) { if (fonts.has(name.toLowerCase())) css['font-family'] = name.toLowerCase(); else warn('Some custom fonts were replaced by the editor font.'); }
      const color = hex(value(p, 'color')); if (color) css.color = color;
      const fill = hex(attr(child(p, 'shd'), 'fill')) || highlight[value(p, 'highlight')]; if (fill) css['background-color'] = fill;
    }
    return { style: css, tags: Object.keys(toggles).filter((t) => toggles[t]) };
  }
  function paragraphStyle(props: Element[]): Style {
    const css: Style = {};
    for (const p of props) {
      const align = value(p, 'jc'); if (align) css['text-align'] = align === 'both' ? 'justify' : ['center', 'right'].includes(align) ? align : 'left';
      const spacing = child(p, 'spacing');
      if (spacing) {
        for (const side of ['before', 'after']) { const v = attr(spacing, side); if (v) css[side === 'before' ? 'margin-top' : 'margin-bottom'] = `${finite(v, 0, 0, 10000) / 20}pt`; }
        const line = attr(spacing, 'line'); if (line) {
          const rule = attr(spacing, 'lineRule'); css['line-height'] = String(Math.round(Math.max(1, Math.min(4, finite(line, 240) / 240)) * 100) / 100);
          if (rule === 'exact' || rule === 'atLeast') warn('Fixed line heights were converted to proportional line spacing.');
        }
      }
      const indent = child(p, 'ind');
      if (indent) {
        for (const side of ['left', 'right']) if (attr(indent, side)) css[`margin-${side}`] = `${finite(attr(indent, side)) / 20}pt`;
        if (attr(indent, 'firstLine')) css['text-indent'] = `${finite(attr(indent, 'firstLine')) / 20}pt`;
        if (attr(indent, 'hanging')) css['text-indent'] = `${-finite(attr(indent, 'hanging')) / 20}pt`;
      }
      if (on(child(p, 'pageBreakBefore'))) css['page-break-before'] = 'always';
      if (on(child(p, 'keepNext')) || on(child(p, 'keepLines'))) css['page-break-inside'] = 'avoid';
    }
    return css;
  }
  const commentsXml = xml(part('comments') || 'word/comments.xml');
  const comments = new Map((commentsXml ? descendants(commentsXml, 'comment') : []).map((c) => [attr(c, 'id'), { text: descendants(c, 't').map((t) => t.textContent || '').join(' ').slice(0, 4000), author: attr(c, 'author') }]));
  const numberingXml = xml(part('numbering') || 'word/numbering.xml');
  const nums = new Map((numberingXml ? descendants(numberingXml, 'num') : []).map((n) => [attr(n, 'numId'), n]));
  const abstracts = new Map((numberingXml ? descendants(numberingXml, 'abstractNum') : []).map((n) => [attr(n, 'abstractNumId'), n]));
  function listInfo(p: Element) {
    const props = properties(p, 'pPr'); const numPr = props.map((v) => child(v, 'numPr')).filter(Boolean).at(-1);
    const id = value(numPr, 'numId'); if (!id || id === '0') return;
    const level = finite(value(numPr, 'ilvl'), 0, 0, 8); const num = nums.get(id), abstract = abstracts.get(value(num, 'abstractNumId'));
    const lvl = abstract && children(abstract, 'lvl').find((l) => finite(attr(l, 'ilvl')) === level);
    const override = num && children(num, 'lvlOverride').find((l) => finite(attr(l, 'ilvl')) === level);
    const format = value(lvl, 'numFmt');
    if (!['bullet', 'decimal', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman', ''].includes(format)) warn('Some custom list numbering was converted to decimal numbering.');
    return { id, level, tag: format === 'bullet' ? 'ul' : 'ol', type: ({ lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I' } as Record<string, string>)[format] || '1', start: finite(value(override, 'startOverride') || value(lvl, 'start'), 1, 1, 1000000) };
  }
  let imageTotal = 0;
  function image(node: Element, source: string): string {
    const blip = descendants(node, 'blip')[0]; const rid = blip?.getAttributeNS(R, 'embed') || blip?.getAttribute('r:embed');
    const rel = relationships(source).find((r) => r.id === rid && !r.external);
    const bytes = rel && files[rel.target];
    if (!bytes || !rel) { warn('An external or unsupported image was omitted; no remote image was fetched.'); return ''; }
    const ext = rel.target.split('.').at(-1)?.toLowerCase(); const mime = ({ png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif' } as Record<string, string>)[ext || ''];
    if (!mime) { warn('Vector, metafile, and unsupported images were omitted.'); return ''; }
    imageTotal += bytes.length; if (imageTotal > 10_000_000) throw new Error('Embedded images exceed 10 MB.');
    const extent = descendants(node, 'extent')[0], description = descendants(node, 'docPr')[0];
    const width = finite(extent?.getAttribute('cx'), 3048000, 9525, 15240000) / 9525;
    const height = finite(extent?.getAttribute('cy'), 1905000, 9525, 15240000) / 9525;
    if (descendants(node, 'anchor').length) warn('Floating pictures were placed inline.');
    return `<img src="data:image/${mime};base64,${base64(bytes)}" alt="${esc(description?.getAttribute('descr') || '')}" style="width:${width}px;height:${height}px;max-width:100%">`;
  }
  type Context = { source: string; active: Set<string>; field: string; skipField: boolean; paragraph: string };
  function inline(node: Element, ctx: Context, depth = 0): string {
    if (depth > 80) throw new Error('DOCX nesting is too deep.');
    const name = node.localName;
    if (name === 'commentRangeStart') { ctx.active.add(attr(node, 'id')); return ''; }
    if (name === 'commentRangeEnd') { ctx.active.delete(attr(node, 'id')); return ''; }
    if (name === 'commentReference') return '';
    if (name === 'instrText') { ctx.field += node.textContent || ''; return ''; }
    if (name === 'fldChar') {
      const type = attr(node, 'fldCharType');
      if (type === 'begin') { ctx.field = ''; ctx.skipField = false; }
      if (type === 'separate' && /^\s*PAGE\b/i.test(ctx.field)) { ctx.skipField = true; return '<span data-page-number="true">1</span>'; }
      if (type === 'separate' && ctx.field.trim()) warn('Fields other than page numbers retain their last displayed text.');
      if (type === 'end') { ctx.field = ''; ctx.skipField = false; }
      return '';
    }
    if (name === 'fldSimple') {
      if (/^\s*PAGE\b/i.test(attr(node, 'instr'))) return '<span data-page-number="true">1</span>';
      warn('Fields other than page numbers retain their last displayed text.');
    }
    if (name === 't' || name === 'delText') return ctx.skipField ? '' : esc(node.textContent);
    if (name === 'tab') return '&#9;';
    if (name === 'br' || name === 'cr') return attr(node, 'type') === 'page' ? '<br><span style="page-break-before:always"></span>' : '<br>';
    if (name === 'drawing') return image(node, ctx.source);
    if (name === 'pict' || name === 'object') { warn('Legacy drawings and embedded objects were omitted.'); return ''; }
    if (['rPr', 'pPr', 'bookmarkStart', 'bookmarkEnd', 'proofErr', 'lastRenderedPageBreak'].includes(name)) return '';
    let content = children(node).map((n) => inline(n, ctx, depth + 1)).join('');
    if (name === 'r') {
      const format = runStyle(properties(node, 'rPr', ctx.paragraph));
      if (Object.keys(format.style).length) content = `<span${styleAttr(format.style)}>${content}</span>`;
      for (const tag of format.tags) content = `<${tag}>${content}</${tag}>`;
      for (const id of ctx.active) { const c = comments.get(id); if (c) content = `<mark data-comment="${esc(c.text)}" data-author="${esc(c.author)}">${content}</mark>`; }
    }
    if (name === 'ins' || name === 'del') content = `<${name} data-change="${esc(attr(node, 'id') || crypto.randomUUID())}" data-author="${esc(attr(node, 'author'))}">${content}</${name}>`;
    if (name === 'hyperlink') {
      const id = node.getAttributeNS(R, 'id') || node.getAttribute('r:id'); const rel = relationships(ctx.source).find((r) => r.id === id);
      if (rel?.external && /^https?:\/\//i.test(rel.target)) content = `<a href="${esc(rel.target)}">${content}</a>`;
    }
    return content;
  }
  function paragraph(p: Element, ctx: Context): string {
    ctx.field = ''; ctx.skipField = false; ctx.paragraph = value(child(p, 'pPr'), 'pStyle');
    const style = paragraphStyle(properties(p, 'pPr'));
    const heading = /heading\s*([1-6])/i.exec(ctx.paragraph); const tag = heading ? `h${heading[1]}` : 'p';
    return `<${tag}${styleAttr(style)}>${children(p).filter((n) => n.localName !== 'pPr').map((n) => inline(n, ctx)).join('') || '<br>'}</${tag}>`;
  }
  function blocks(nodes: Element[], ctx: Context, depth = 0): string {
    if (depth > 40) throw new Error('DOCX block nesting is too deep.');
    const container = document.createElement('div');
    const lists: { id: string; tag: string; node: HTMLElement; last?: HTMLElement }[] = [];
    for (const node of nodes) {
      if (node.localName === 'p') {
        const info = listInfo(node); const html = paragraph(node, ctx);
        if (!info) { lists.length = 0; container.insertAdjacentHTML('beforeend', html); continue; }
        const level = Math.min(info.level, lists.length);
        lists.length = Math.min(lists.length, level + 1);
        if (!lists[level] || lists[level]!.id !== info.id || lists[level]!.tag !== info.tag) {
          lists.length = level; const list = document.createElement(info.tag); if (info.tag === 'ol') { list.setAttribute('start', String(info.start)); list.setAttribute('type', info.type); }
          (level ? lists[level - 1]?.last || container : container).append(list); lists.push({ id: info.id, tag: info.tag, node: list });
        }
        const li = document.createElement('li'); li.innerHTML = html; lists[level]!.node.append(li); lists[level]!.last = li;
      } else if (node.localName === 'tbl') { lists.length = 0; container.insertAdjacentHTML('beforeend', table(node, ctx, depth + 1)); }
      else if (node.localName === 'sdt') { lists.length = 0; const content = child(node, 'sdtContent'); if (content) container.insertAdjacentHTML('beforeend', blocks(children(content), ctx, depth + 1)); }
      else if (!['sectPr', 'bookmarkStart', 'bookmarkEnd'].includes(node.localName)) { lists.length = 0; container.insertAdjacentHTML('beforeend', inline(node, ctx)); }
    }
    return container.innerHTML;
  }
  function table(node: Element, ctx: Context, depth: number): string {
    const table = document.createElement('table'); const body = document.createElement('tbody'); table.append(body);
    const merges = new Map<number, HTMLTableCellElement>();
    for (const row of children(node, 'tr')) {
      const tr = document.createElement('tr'); body.append(tr); let column = 0; const extended = new Set<HTMLTableCellElement>();
      for (const cell of children(row, 'tc')) {
        const props = child(cell, 'tcPr'), span = finite(value(props, 'gridSpan'), 1, 1, 100), merge = child(props, 'vMerge');
        if (column + span > 1000) throw new Error('A table exceeds 1,000 columns.');
        if (merge && attr(merge, 'val') !== 'restart' && merges.has(column)) {
          const origin = merges.get(column)!; if (!extended.has(origin)) { origin.rowSpan = Math.min(100, origin.rowSpan + 1); extended.add(origin); } column += span; continue;
        }
        const td = document.createElement('td'); td.colSpan = span; td.innerHTML = blocks(children(cell).filter((n) => n.localName !== 'tcPr'), ctx, depth + 1);
        const fill = hex(attr(child(props, 'shd'), 'fill')); if (fill) td.style.backgroundColor = fill;
        const align = value(props, 'vAlign'); if (align) td.style.verticalAlign = align === 'center' ? 'middle' : align === 'bottom' ? 'bottom' : 'top';
        const width = child(props, 'tcW'); if (attr(width, 'type') === 'dxa') td.style.width = `${finite(attr(width, 'w'), 1000, 20, 20000) / 20}pt`;
        tr.append(td); for (let i = 0; i < span; i++) { if (merge && attr(merge, 'val') === 'restart') merges.set(column + i, td); else merges.delete(column + i); } column += span;
      }
    }
    return table.outerHTML;
  }
  const context = (source: string): Context => ({ source, active: new Set(), field: '', skipField: false, paragraph: '' });
  let inheritedHeader = '', inheritedFooter = '';
  function section(nodes: Element[], props?: Element): string {
    const size = child(props, 'pgSz'), margins = child(props, 'pgMar');
    const width = finite(attr(size, 'w'), 11906, 1440, 31680), height = finite(attr(size, 'h'), 16838, 1440, 31680);
    const landscape = width > height; const letter = Math.abs(Math.min(width, height) - 12240) < 100; const a4 = Math.abs(Math.min(width, height) - 11906) < 100;
    const page = `${letter ? 'letter' : a4 ? 'a4' : `custom-${width}-${height}`}-${landscape ? 'landscape' : 'portrait'}`;
    const css: Style = { width: `${width / 20}pt` };
    for (const side of ['top', 'bottom', 'left', 'right']) css[`padding-${side}`] = `${finite(attr(margins, side), 1134, 0, 14400) / 20}pt`;
    if (props && (child(props, 'cols') && finite(attr(child(props, 'cols'), 'num'), 1) > 1)) warn('Multiple text columns were converted to a single flowing column.');
    for (const kind of ['header', 'footer']) {
      const refs = props ? children(props, `${kind}Reference`) : [];
      if (refs.length > 1) warn('Different first-page and even-page headers or footers were simplified to the default.');
      const ref = refs.find((r) => attr(r, 'type') === 'default') || refs[0];
      if (ref) { const id = ref.getAttributeNS(R, 'id') || ref.getAttribute('r:id'); const rel = rels.find((r) => r.id === id && !r.external); const partXml = rel && xml(rel.target); const text = partXml && rel ? blocks(children(partXml.documentElement), context(rel.target)) : ''; if (kind === 'header') inheritedHeader = text; else inheritedFooter = text; }
    }
    return `<section data-word-page="${esc(page)}"${styleAttr(css)}>${inheritedHeader ? `<header data-word-header="true">${inheritedHeader}</header>` : ''}${blocks(nodes, context(main))}${inheritedFooter ? `<footer data-word-footer="true">${inheritedFooter}</footer>` : ''}</section>`;
  }
  const chunks: string[] = []; let pending: Element[] = [];
  for (const node of children(body)) {
    if (node.localName === 'sectPr') { chunks.push(section(pending, node)); pending = []; continue; }
    pending.push(node); const props = node.localName === 'p' && child(child(node, 'pPr'), 'sectPr');
    if (props) { chunks.push(section(pending, props)); pending = []; }
  }
  if (pending.length || !chunks.length) chunks.push(section(pending));
  if (Object.keys(files).some((name) => /footnotes|endnotes|charts\/|embeddings\/|vbaProject/i.test(name))) warn('Footnotes, endnotes, charts, embedded files, and macros are not imported.');
  if (descendants(mainXml!, 'oMath').length) warn('Equation formatting is not supported; readable equation text may remain.');
  warn('DOCX layout may reflow in the editor. Advanced Word features and formatting outside the supported controls may be simplified.');
  const html = chunks.join(''); if (html.length > HTML_LIMIT) throw new Error('The imported document exceeds the 16 MiB note size limit.');
  return { html, warnings: [...warnings] };
}

const twips = (value: string, fallback = 0) => {
  const match = /^(-?\d+(?:\.\d+)?)\s*(px|pt|mm|in|cm)?$/i.exec(value.trim()); if (!match) return fallback;
  const factor = ({ px: 15, pt: 20, mm: 1440 / 25.4, in: 1440, cm: 1440 / 2.54 } as Record<string, number>)[match[2]?.toLowerCase() || 'px']!;
  return Math.max(-31680, Math.min(31680, Math.round(Number(match[1]) * factor)));
};
const cssHex = (color: string) => {
  if (/^#[\da-f]{6}$/i.test(color)) return color.slice(1).toUpperCase();
  if (/^#[\da-f]{3}$/i.test(color)) return color.slice(1).split('').map((c) => c + c).join('').toUpperCase();
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(color);
  if (rgb) return rgb.slice(1).map((v) => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  return ({ black: '000000', white: 'FFFFFF', red: 'FF0000', yellow: 'FFFF00', blue: '0000FF', green: '008000' } as Record<string, string>)[color.toLowerCase()] || '';
};

/** Produces a real, editable OOXML package; never fetches external resources. */
export async function exportDocx(html: string, title: string): Promise<Blob> {
  if (html.length > HTML_LIMIT) throw new Error('The document exceeds the 16 MiB note size limit.');
  const template = document.createElement('template'); template.innerHTML = html;
  if (template.content.querySelectorAll('*').length > 100000) throw new Error('The document contains too many elements.');
  const files: Unzipped = {};
  const rels = new Map<string, Rel[]>(); const overrides: [string, string][] = [];
  const write = (path: string, text: string) => { files[path] = strToU8(declaration + text); };
  const addRel = (part: string, type: string, target: string, external = false) => {
    const list = rels.get(part) || []; rels.set(part, list); const existing = list.find((r) => r.type === type && r.target === target && r.external === external); if (existing) return existing.id;
    const id = `rId${list.length + 1}`; list.push({ id, type, target, external }); return id;
  };
  const addPart = (path: string, kind: string, root: string, body: string) => { write(path, `<w:${root} ${NS}>${body}</w:${root}>`); overrides.push([path, `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`]); };
  const comments: string[] = [], numbering: string[] = [];
  let imageIndex = 0, imageBytes = 0, revisionIndex = 0;
  type Format = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; vertical?: string; font?: string; size?: string; color?: string; fill?: string };
  function format(node: HTMLElement, previous: Format): Format {
    const f = { ...previous }, tag = node.localName, css = node.style;
    if (['b', 'strong'].includes(tag)) f.bold = true; if (['i', 'em'].includes(tag)) f.italic = true; if (tag === 'u') f.underline = true; if (['s', 'strike'].includes(tag)) f.strike = true;
    if (tag === 'sub' || tag === 'sup') f.vertical = tag === 'sub' ? 'subscript' : 'superscript';
    if (css.fontWeight) f.bold = css.fontWeight === 'bold' || Number(css.fontWeight) >= 600;
    if (css.fontStyle) f.italic = css.fontStyle === 'italic';
    if (css.textDecoration) { f.underline = css.textDecoration.includes('underline'); f.strike = css.textDecoration.includes('line-through'); }
    if (css.fontFamily) f.font = css.fontFamily.replace(/["']/g, '').split(',')[0]!.trim();
    if (css.fontSize) f.size = String(Math.max(12, Math.min(400, Math.round(twips(css.fontSize, 220) / 10))));
    if (css.color) f.color = cssHex(css.color); if (css.backgroundColor) f.fill = cssHex(css.backgroundColor);
    if (css.verticalAlign === 'sub' || css.verticalAlign === 'super') f.vertical = css.verticalAlign === 'sub' ? 'subscript' : 'superscript';
    return f;
  }
  function runProps(f: Format): string {
    const props = `${f.font ? `<w:rFonts w:ascii="${esc(f.font)}" w:hAnsi="${esc(f.font)}"/>` : ''}${f.bold === undefined ? '' : `<w:b w:val="${f.bold ? 1 : 0}"/>`}${f.italic === undefined ? '' : `<w:i w:val="${f.italic ? 1 : 0}"/>`}${f.strike === undefined ? '' : `<w:strike w:val="${f.strike ? 1 : 0}"/>`}${f.color ? `<w:color w:val="${f.color}"/>` : ''}${f.size ? `<w:sz w:val="${f.size}"/>` : ''}${f.underline === undefined ? '' : `<w:u w:val="${f.underline ? 'single' : 'none'}"/>`}${f.fill ? `<w:shd w:val="clear" w:fill="${f.fill}"/>` : ''}${f.vertical ? `<w:vertAlign w:val="${esc(f.vertical)}"/>` : ''}`;
    return props ? `<w:rPr>${props}</w:rPr>` : '';
  }
  const textRun = (text: string, f: Format, deleted = false) => `<w:r>${runProps(f)}${text.split(/(\t|\n)/).map((part) => part === '\t' ? '<w:tab/>' : part === '\n' ? '<w:br/>' : `<w:${deleted ? 'delText' : 't'} xml:space="preserve">${esc(part)}</w:${deleted ? 'delText' : 't'}>`).join('')}</w:r>`;
  function image(node: HTMLImageElement, source: string): string {
    const match = /^data:image\/(png|jpeg|gif|webp);base64,([a-z\d+/=]+)$/i.exec(node.getAttribute('src') || '');
    if (!match) return textRun(node.alt ? `[Image: ${node.alt}]` : '[External image omitted]', {});
    const bytes = Uint8Array.from(atob(match[2]!), (c) => c.charCodeAt(0));
    imageBytes += bytes.length; if (imageBytes > 10_000_000) throw new Error('Images exceed the 10 MB export limit.');
    const type = match[1]!.toLowerCase(), id = ++imageIndex;
    files[`word/media/image${id}.${type}`] = bytes;
    const rel = addRel(source, `${R}/image`, `media/image${id}.${type}`);
    const cx = Math.max(9525, twips(node.style.width || `${node.getAttribute('width') || 320}px`, 4800) * 635);
    const cy = Math.max(9525, twips(node.style.height || `${node.getAttribute('height') || 200}px`, 3000) * 635);
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Image ${id}" descr="${esc(node.alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Image ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }
  function inline(node: Node, inherited: Format, source: string, deleted = false, depth = 0): string {
    if (depth > 80) throw new Error('Document nesting is too deep.');
    if (node.nodeType === Node.TEXT_NODE) return textRun(node.textContent || '', inherited, deleted);
    if (!(node instanceof HTMLElement)) return '';
    const tag = node.localName; if (['script', 'style', 'iframe', 'object', 'svg', 'canvas'].includes(tag)) return '';
    const f = format(node, inherited);
    if (tag === 'br') return `<w:r>${runProps(f)}<w:br${node.style.pageBreakBefore === 'always' ? ' w:type="page"' : ''}/></w:r>`;
    if (node.hasAttribute('data-page-number')) return `<w:fldSimple w:instr=" PAGE ">${textRun(node.textContent || '1', f)}</w:fldSimple>`;
    if (tag === 'img') return image(node as HTMLImageElement, source);
    if (tag === 'input') return textRun((node as HTMLInputElement).checked ? '☑ ' : '☐ ', f, deleted);
    let content = Array.from(node.childNodes).map((n) => inline(n, f, source, deleted || tag === 'del', depth + 1)).join('');
    if (tag === 'ins' || tag === 'del') content = `<w:${tag} w:id="${revisionIndex++}" w:author="${esc(node.dataset.author || 'Author')}" w:date="${new Date().toISOString()}">${content}</w:${tag}>`;
    if (tag === 'a') {
      const href = node.getAttribute('href') || ''; if (/^https?:\/\//i.test(href)) content = `<w:hyperlink r:id="${addRel(source, `${R}/hyperlink`, href, true)}">${content}</w:hyperlink>`;
    }
    if (node.dataset.comment) {
      const id = comments.length;
      comments.push(`<w:comment w:id="${id}" w:author="${esc(node.dataset.author || 'Author')}" w:date="${new Date().toISOString()}"><w:p>${textRun(node.dataset.comment, {})}</w:p></w:comment>`);
      content = `<w:commentRangeStart w:id="${id}"/>${content}<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`;
    }
    return content;
  }
  function paragraphProps(node: HTMLElement, extra = ''): string {
    const css = node.style; const heading = /^h([1-6])$/.exec(node.localName);
    let props = heading ? `<w:pStyle w:val="Heading${heading[1]}"/>` : '';
    if (css.pageBreakInside === 'avoid') props += '<w:keepLines/>';
    if (css.pageBreakBefore === 'always') props += '<w:pageBreakBefore/>';
    props += extra;
    if (css.marginTop || css.marginBottom || css.lineHeight) props += `<w:spacing${css.marginTop ? ` w:before="${Math.max(0, twips(css.marginTop))}"` : ''}${css.marginBottom ? ` w:after="${Math.max(0, twips(css.marginBottom))}"` : ''}${css.lineHeight && Number.isFinite(Number(css.lineHeight)) ? ` w:line="${Math.max(120, Math.min(960, Math.round(Number(css.lineHeight) * 240)))}" w:lineRule="auto"` : ''}/>`;
    if (css.marginLeft || css.marginRight || css.textIndent) { const indent = twips(css.textIndent); props += `<w:ind${css.marginLeft ? ` w:left="${twips(css.marginLeft)}"` : ''}${css.marginRight ? ` w:right="${twips(css.marginRight)}"` : ''}${css.textIndent ? ` w:${indent < 0 ? 'hanging' : 'firstLine'}="${Math.abs(indent)}"` : ''}/>`; }
    if (css.textAlign) props += `<w:jc w:val="${css.textAlign === 'justify' ? 'both' : ['left', 'center', 'right'].includes(css.textAlign) ? css.textAlign : 'left'}"/>`;
    return props ? `<w:pPr>${props}</w:pPr>` : '';
  }
  function paragraph(node: HTMLElement, source: string, extra = '', inherited: Format = {}): string {
    const f = format(node, inherited);
    return `<w:p>${paragraphProps(node, extra)}${Array.from(node.childNodes).map((n) => inline(n, f, source)).join('')}</w:p>${node.style.pageBreakAfter === 'always' ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : ''}`;
  }
  function list(node: HTMLElement, source: string, depth: number, inherited: Format): string {
    if (depth > 8) depth = 8;
    const id = numbering.length + 1, numFormat = node.localName === 'ul' ? 'bullet' : ({ a: 'lowerLetter', A: 'upperLetter', i: 'lowerRoman', I: 'upperRoman' } as Record<string, string>)[node.getAttribute('type') || ''] || 'decimal';
    const start = finite(node.getAttribute('start'), 1, 1, 1000000);
    numbering.push(`<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="multilevel"/>${Array.from({ length: 9 }, (_, level) => `<w:lvl w:ilvl="${level}"><w:start w:val="${start}"/><w:numFmt w:val="${numFormat}"/><w:lvlText w:val="${numFormat === 'bullet' ? '•' : `%${level + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="${720 * (level + 1)}"/></w:tabs><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('')}</w:abstractNum>`);
    return Array.from(node.children).filter((n): n is HTMLElement => n instanceof HTMLElement && n.localName === 'li').map((li) => {
      const f = format(li, inherited); const copy = li.cloneNode(true) as HTMLElement; for (const list of Array.from(copy.children).filter((n) => ['ul', 'ol'].includes(n.localName))) list.remove();
      const onlyP = copy.children.length === 1 && copy.firstElementChild?.localName === 'p' ? copy.firstElementChild as HTMLElement : copy;
      return paragraph(onlyP, source, `<w:numPr><w:ilvl w:val="${depth}"/><w:numId w:val="${id}"/></w:numPr>`, f) + Array.from(li.children).filter((n): n is HTMLElement => n instanceof HTMLElement && ['ul', 'ol'].includes(n.localName)).map((n) => list(n, source, depth + 1, f)).join('');
    }).join('');
  }
  function table(node: HTMLTableElement, source: string, depth: number, inherited: Format): string {
    const rows = Array.from(node.rows); if (rows.length > 1000) throw new Error('A table exceeds 1,000 rows.');
    const active = new Map<number, { rows: number; span: number; width: number }>();
    let maxColumns = 1;
    const content = rows.map((row) => {
      let column = 0, cells = '';
      const continued = () => {
        while (active.has(column)) { const a = active.get(column)!; cells += `<w:tc><w:tcPr><w:tcW w:w="${a.width}" w:type="dxa"/>${a.span > 1 ? `<w:gridSpan w:val="${a.span}"/>` : ''}<w:vMerge/></w:tcPr><w:p/></w:tc>`; if (--a.rows <= 0) active.delete(column); column += a.span; }
      };
      for (const cell of Array.from(row.cells)) {
        continued(); const span = Math.max(1, Math.min(100, cell.colSpan)), rowspan = Math.max(1, Math.min(100, cell.rowSpan)); const width = twips(cell.style.width, 1800 * span);
        if (column + span > 1000) throw new Error('A table exceeds 1,000 columns.');
        let props = `<w:tcW w:w="${Math.max(20, width)}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${rowspan > 1 ? '<w:vMerge w:val="restart"/>' : ''}`;
        const fill = cssHex(cell.style.backgroundColor); if (fill) props += `<w:shd w:val="clear" w:fill="${fill}"/>`;
        if (cell.style.verticalAlign) props += `<w:vAlign w:val="${cell.style.verticalAlign === 'middle' ? 'center' : cell.style.verticalAlign === 'bottom' ? 'bottom' : 'top'}"/>`;
        const body = blocks(Array.from(cell.childNodes), source, depth + 1, format(cell, inherited));
        cells += `<w:tc><w:tcPr>${props}</w:tcPr>${body || '<w:p/>'}${body.endsWith('</w:tbl>') ? '<w:p/>' : ''}</w:tc>`;
        if (rowspan > 1) active.set(column, { rows: rowspan - 1, span, width }); column += span;
      }
      continued(); maxColumns = Math.max(maxColumns, column);
      return `<w:tr>${cells}</w:tr>`;
    }).join('');
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="4" w:color="B7C2D0"/>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: maxColumns }, () => '<w:gridCol w:w="1800"/>').join('')}</w:tblGrid>${content}</w:tbl>`;
  }
  function blocks(nodes: Node[], source: string, depth = 0, inherited: Format = {}): string {
    if (depth > 40) throw new Error('Document nesting is too deep.');
    let result = '', pending = '';
    const flush = () => { if (pending) { result += `<w:p>${pending}</w:p>`; pending = ''; } };
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) { if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) pending += inline(node, inherited, source); continue; }
      const tag = node.localName; if (['header', 'footer'].includes(tag) || node.hasAttribute('data-word-header') || node.hasAttribute('data-word-footer')) continue;
      if (tag === 'table') { flush(); result += table(node as HTMLTableElement, source, depth + 1, format(node, inherited)); }
      else if (tag === 'ul' || tag === 'ol') { flush(); result += list(node, source, 0, format(node, inherited)); }
      else if (/^(p|h[1-6]|pre|blockquote)$/.test(tag)) { flush(); result += paragraph(node, source, '', inherited); }
      else if (['div', 'section', 'article'].includes(tag)) { flush(); result += blocks(Array.from(node.childNodes), source, depth + 1, format(node, inherited)); }
      else pending += inline(node, inherited, source);
    }
    flush(); return result;
  }
  function sectionProps(page: HTMLElement | undefined, index: number): string {
    const name = page?.dataset.wordPage || 'a4-portrait'; const landscape = name.includes('landscape'), letter = name.includes('letter');
    const custom = /custom-(\d+)-(\d+)/.exec(name);
    let width = custom ? Number(custom[1]) : letter ? 12240 : 11906, height = custom ? Number(custom[2]) : letter ? 15840 : 16838;
    if (!custom && landscape) [width, height] = [height, width];
    if (page?.style.width) width = twips(page.style.width, width);
    if (page?.style.height) height = twips(page.style.height, height);
    width = Math.max(1440, Math.min(31680, width)); height = Math.max(1440, Math.min(31680, height));
    let refs = '';
    for (const kind of ['header', 'footer']) {
      const node = page?.querySelector<HTMLElement>(`[data-word-${kind}],${kind}`);
      if (!node) continue; const path = `word/${kind}${index + 1}.xml`;
      addPart(path, kind, kind === 'header' ? 'hdr' : 'ftr', blocks(Array.from(node.childNodes), path) || '<w:p/>');
      refs += `<w:${kind}Reference w:type="default" r:id="${addRel('word/document.xml', `${R}/${kind}`, `${kind}${index + 1}.xml`)}"/>`;
    }
    const margins = ['top', 'right', 'bottom', 'left'].map((side) => ` w:${side}="${Math.max(0, twips(page?.style.getPropertyValue(`padding-${side}`) || page?.style.padding || '', 1134))}"`).join('');
    return `<w:sectPr>${refs}<w:type w:val="nextPage"/><w:pgSz w:w="${width}" w:h="${height}"${width > height ? ' w:orient="landscape"' : ''}/><w:pgMar${margins} w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`;
  }
  const pages = Array.from(template.content.querySelectorAll<HTMLElement>('[data-word-page]')).filter((page) => !page.parentElement?.closest('[data-word-page]'));
  let body = '';
  if (pages.length) {
    const loose = Array.from(template.content.childNodes).filter((n) => !(n instanceof HTMLElement && (n.hasAttribute('data-word-page') || n.querySelector('[data-word-page]'))));
    body += blocks(loose, 'word/document.xml');
    pages.forEach((page, index) => { body += blocks(Array.from(page.childNodes), 'word/document.xml', 0, format(page, {})); const props = sectionProps(page, index); body += index === pages.length - 1 ? props : `<w:p><w:pPr>${props}</w:pPr></w:p>`; });
  } else body = blocks(Array.from(template.content.childNodes), 'word/document.xml') + sectionProps(undefined, 0);
  addPart('word/document.xml', 'document.main', 'document', `<w:body>${body}</w:body>`);
  const headingStyles = Array.from({ length: 6 }, (_, i) => `<w:style w:type="paragraph" w:styleId="Heading${i + 1}"><w:name w:val="heading ${i + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[40, 32, 28, 26, 24, 22][i]}"/></w:rPr></w:style>`).join('');
  addPart('word/styles.xml', 'styles', 'styles', `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${headingStyles}`);
  addRel('word/document.xml', `${R}/styles`, 'styles.xml');
  if (numbering.length) { addPart('word/numbering.xml', 'numbering', 'numbering', numbering.join('') + numbering.map((_, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${i + 1}"/></w:num>`).join('')); addRel('word/document.xml', `${R}/numbering`, 'numbering.xml'); }
  if (comments.length) { addPart('word/comments.xml', 'comments', 'comments', comments.join('')); addRel('word/document.xml', `${R}/comments`, 'comments.xml'); }
  write('docProps/core.xml', `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title.slice(0, 500))}</dc:title><dc:creator>Rimeward</dc:creator></cp:coreProperties>`);
  overrides.push(['docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml']);
  addRel('', `${R}/officeDocument`, 'word/document.xml'); addRel('', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml');
  for (const [part, relationships] of rels) {
    const slash = part.lastIndexOf('/'); const path = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
    write(path, `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.map((r) => `<Relationship Id="${r.id}" Type="${esc(r.type)}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`);
  }
  write('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${['png', 'jpeg', 'gif', 'webp'].map((ext) => `<Default Extension="${ext}" ContentType="image/${ext}"/>`).join('')}${overrides.map(([path, content]) => `<Override PartName="/${path}" ContentType="${content}"/>`).join('')}</Types>`);
  return new Blob([zipSync(files, { level: 6 }) as Uint8Array<ArrayBuffer>], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
