// The document's ProseMirror schema — PURE, shared by the editor (scripts/app/
// note-editor.ts) and the server codec (lib/note-pm.ts), which is what lets one
// Yjs document stand behind every collaborator (lib/note-room.ts). Every node and
// mark maps to exactly what `sanitizeHtml` (note-text.ts) keeps, and every style
// goes through the same `cleanStyle`, so serialize(parse(html)) is a fixed point on
// sanitizer output — the round trip tests prove it construct by construct.
import { DOMParser as PMDOMParser, DOMSerializer, Schema, type DOMOutputSpec, type MarkSpec, type Node as PMNode, type NodeSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';
import { cleanStyle, sanitizeHtml } from './note-text.ts';

type Attrs = Record<string, unknown>;
const styleOf = (dom: Element): { style: string } => ({ style: cleanStyle(dom.getAttribute('style') ?? '') });
const withStyle = (attrs: Attrs, extra: Attrs = {}): Attrs => ({ ...extra, ...(attrs.style ? { style: attrs.style as string } : {}) });
const text = (dom: Element, name: string, max = 4000): string => (dom.getAttribute(name) ?? '').slice(0, max);
const NOTE_LINK_RE = /^[a-z0-9-]{1,32}$/;
const PAPER_RE = /^(letter|a4)-(portrait|landscape)$/;

/** A block that carries the paragraph-level knobs the ribbon sets (alignment, spacing, indents). */
const styledBlock = (tag: string, extra: Partial<NodeSpec> = {}): NodeSpec => ({
  content: 'inline*',
  group: 'block',
  attrs: { style: { default: '' } },
  parseDOM: [{ tag, getAttrs: (dom) => styleOf(dom as Element) }],
  toDOM: (node) => [tag, withStyle(node.attrs), 0] as DOMOutputSpec,
  ...extra,
});

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  paragraph: styledBlock('p'),
  heading: {
    content: 'inline*',
    group: 'block',
    defining: true,
    attrs: { level: { default: 1 }, style: { default: '' } },
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, getAttrs: (dom: Node | string) => ({ level, ...styleOf(dom as Element) }) })),
    toDOM: (node) => [`h${node.attrs.level}`, withStyle(node.attrs), 0] as DOMOutputSpec,
  },
  blockquote: { content: 'block+', group: 'block', defining: true, parseDOM: [{ tag: 'blockquote' }], toDOM: () => ['blockquote', 0] },
  code_block: {
    content: 'text*', marks: '', group: 'block', code: true, defining: true,
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM: () => ['pre', 0],
  },
  horizontal_rule: { group: 'block', parseDOM: [{ tag: 'hr' }], toDOM: () => ['hr'] },
  bullet_list: { content: 'list_item+', group: 'block', parseDOM: [{ tag: 'ul' }], toDOM: () => ['ul', 0] },
  ordered_list: {
    content: 'list_item+', group: 'block',
    attrs: { start: { default: 1 }, type: { default: '' } },
    parseDOM: [{ tag: 'ol', getAttrs: (dom) => {
      const el = dom as Element;
      const start = Number(el.getAttribute('start'));
      const type = el.getAttribute('type') ?? '';
      return { start: Number.isInteger(start) && start >= 1 && start <= 1_000_000 ? start : 1, type: /^[1aAiI]$/.test(type) ? type : '' };
    } }],
    toDOM: (node) => ['ol', { ...(node.attrs.start !== 1 ? { start: String(node.attrs.start) } : {}), ...(node.attrs.type ? { type: node.attrs.type as string } : {}) }, 0],
  },
  list_item: { content: 'paragraph block*', defining: true, parseDOM: [{ tag: 'li' }], toDOM: () => ['li', 0] },
  /** A generic wrapper the sanitizer keeps: div, or header/footer/section outside a page. */
  block_container: {
    content: 'block+', group: 'block',
    attrs: { tag: { default: 'div' }, style: { default: '' } },
    parseDOM: [
      { tag: 'div', getAttrs: (dom) => ({ tag: 'div', ...styleOf(dom as Element) }) },
      { tag: 'section:not([data-word-page])', getAttrs: (dom) => ({ tag: 'section', ...styleOf(dom as Element) }) },
      { tag: 'header:not([data-word-header])', getAttrs: (dom) => ({ tag: 'header', ...styleOf(dom as Element) }) },
      { tag: 'footer:not([data-word-footer])', getAttrs: (dom) => ({ tag: 'footer', ...styleOf(dom as Element) }) },
    ],
    toDOM: (node) => [node.attrs.tag as string, withStyle(node.attrs), 0] as DOMOutputSpec,
  },
  /** A Word-style page (note-word.ts): paper + orientation, its margins as padding, a page break before it. */
  page: {
    content: 'page_header? block+ page_footer?', group: 'block', defining: true, isolating: true,
    attrs: { paper: { default: 'letter-portrait' }, style: { default: '' } },
    parseDOM: [{ tag: 'section[data-word-page]', getAttrs: (dom) => {
      const el = dom as Element;
      const paper = el.getAttribute('data-word-page') ?? '';
      return { paper: PAPER_RE.test(paper) ? paper : 'letter-portrait', ...styleOf(el) };
    } }],
    toDOM: (node) => ['section', withStyle(node.attrs, { 'data-word-page': node.attrs.paper as string }), 0] as DOMOutputSpec,
  },
  page_header: { content: 'block+', defining: true, parseDOM: [{ tag: 'header[data-word-header]' }], toDOM: () => ['header', { 'data-word-header': 'true' }, 0] },
  page_footer: { content: 'block+', defining: true, parseDOM: [{ tag: 'footer[data-word-footer]' }], toDOM: () => ['footer', { 'data-word-footer': 'true' }, 0] },
  text: { group: 'inline' },
  hard_break: { inline: true, group: 'inline', selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
  image: {
    inline: true, group: 'inline', draggable: true,
    attrs: { src: {}, alt: { default: '' }, style: { default: '' } },
    parseDOM: [{ tag: 'img[src]', getAttrs: (dom) => {
      const el = dom as Element;
      return { src: el.getAttribute('src'), alt: text(el, 'alt', 1000), ...styleOf(el) };
    } }],
    toDOM: (node) => ['img', withStyle(node.attrs, { src: node.attrs.src as string, alt: node.attrs.alt as string })] as DOMOutputSpec,
  },
  /** A task box (imports, markdown): the sanitizer keeps it disabled; the editor toggles it. */
  checkbox: {
    inline: true, group: 'inline', atom: true,
    attrs: { checked: { default: false } },
    parseDOM: [{ tag: 'input[type=checkbox]', getAttrs: (dom) => ({ checked: (dom as Element).hasAttribute('checked') }) }],
    toDOM: (node) => ['input', { type: 'checkbox', disabled: '', ...(node.attrs.checked ? { checked: '' } : {}) }],
  },
  /** The page number the ribbon inserts; its text is the number, kept as an attr so a decoration can redraw it. */
  page_number: {
    inline: true, group: 'inline', atom: true,
    attrs: { n: { default: '1' } },
    parseDOM: [{ tag: 'span[data-page-number]', getAttrs: (dom) => ({ n: ((dom as Element).textContent ?? '1').slice(0, 8) }) }],
    toDOM: (node) => ['span', { 'data-page-number': 'true' }, node.attrs.n as string],
  },
  ...tableNodes({
    tableGroup: 'block',
    cellContent: 'block+',
    cellAttributes: {
      style: { default: '', getFromDOM: (dom) => cleanStyle(dom.getAttribute('style') ?? ''), setDOMAttr: (value, attrs) => { if (value) attrs.style = value; } },
    },
  }),
};
// The table itself keeps its width; rows come back inside one tbody.
nodes.table = {
  ...nodes.table!,
  attrs: { style: { default: '' } },
  parseDOM: [{ tag: 'table', getAttrs: (dom) => styleOf(dom as Element) }],
  toDOM: (node) => ['table', withStyle(node.attrs), ['tbody', 0]] as DOMOutputSpec,
};

const change = (tag: 'ins' | 'del'): MarkSpec => ({
  attrs: { id: { default: '' }, author: { default: '' } },
  excludes: '',
  parseDOM: [{ tag: `${tag}[data-change]`, getAttrs: (dom) => ({ id: text(dom as Element, 'data-change', 64), author: text(dom as Element, 'data-author', 100) }) }],
  toDOM: (mark) => [tag, { 'data-change': mark.attrs.id as string, 'data-author': mark.attrs.author as string }, 0],
});

const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: {} },
    inclusive: false,
    parseDOM: [{ tag: 'a[href]:not([data-note])', getAttrs: (dom) => ({ href: (dom as Element).getAttribute('href') }) }],
    toDOM: (mark) => ['a', { href: mark.attrs.href as string, target: '_blank', rel: 'noreferrer' }, 0],
  },
  /** An internal reference (`[[` picker): the sanitizer keeps only the id. */
  note_link: {
    attrs: { id: {} },
    inclusive: false,
    parseDOM: [{ tag: 'a[data-note]', getAttrs: (dom) => { const id = (dom as Element).getAttribute('data-note') ?? ''; return NOTE_LINK_RE.test(id) ? { id } : false; } }],
    toDOM: (mark) => ['a', { 'data-note': mark.attrs.id as string }, 0],
  },
  strong: { parseDOM: [{ tag: 'b' }, { tag: 'strong' }], toDOM: () => ['b', 0] },
  em: { parseDOM: [{ tag: 'i' }, { tag: 'em' }], toDOM: () => ['i', 0] },
  underline: { parseDOM: [{ tag: 'u' }], toDOM: () => ['u', 0] },
  strike: { parseDOM: [{ tag: 's' }, { tag: 'strike' }, { tag: 'del:not([data-change])' }], toDOM: () => ['s', 0] },
  sub: { parseDOM: [{ tag: 'sub' }], toDOM: () => ['sub', 0] },
  sup: { parseDOM: [{ tag: 'sup' }], toDOM: () => ['sup', 0] },
  code: { parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
  highlight: { parseDOM: [{ tag: 'mark:not([data-comment])' }], toDOM: () => ['mark', 0] },
  /** A review comment on a passage (note-word.ts). */
  comment: {
    attrs: { comment: { default: '' }, author: { default: '' } },
    excludes: '',
    parseDOM: [{ tag: 'mark[data-comment]', getAttrs: (dom) => ({ comment: text(dom as Element, 'data-comment'), author: text(dom as Element, 'data-author', 100) }) }],
    toDOM: (mark) => ['mark', { 'data-comment': mark.attrs.comment as string, 'data-author': mark.attrs.author as string }, 0],
  },
  ins_change: change('ins'),
  // Typing at the end of a deletion continues the text, not the deletion.
  del_change: { ...change('del'), inclusive: false },
  /** A run's inline style (font, size, colour…) — the allowlisted rules verbatim; runs may stack. */
  text_style: {
    attrs: { style: {} },
    excludes: '',
    parseDOM: [{ tag: 'span[style]', getAttrs: (dom) => { const style = cleanStyle((dom as Element).getAttribute('style') ?? ''); return style ? { style } : false; } }],
    toDOM: (mark) => ['span', { style: mark.attrs.style as string }, 0],
  },
};

export const noteSchema = new Schema({ nodes, marks });
export type NoteDoc = PMNode;

/** HTML → document, through the DOM you hand it (the browser's, or linkedom on the server). */
export function parseNoteHtml(document: Document, html: string): PMNode {
  const host = document.createElement('div');
  host.innerHTML = sanitizeHtml(html);
  return PMDOMParser.fromSchema(noteSchema).parse(host);
}
/** Document → the HTML the store keeps: serialized, then through the sanitizer like every save. */
export function serializeNoteDoc(document: Document, doc: PMNode): string {
  const host = document.createElement('div');
  host.appendChild(DOMSerializer.fromSchema(noteSchema).serializeFragment(doc.content, { document }));
  return sanitizeHtml(host.innerHTML);
}
