import { httpUrl } from './wards.ts';
import { isNotebookPageType } from './notebook-pages.ts';

// The note document's pure codecs — text out of the editor's HTML, text into
// it, and the sanitizer every save passes through. No db import: db.ts runs
// the full-text backfill over these while the database is still migrating.

const EXCERPT_MAX = 200;
const escText = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The first lines of a document's text, one line, for lists. */
export const excerpt = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX);

/** The document as text — what the agent reads and the model gets as context. */
export function plainText(html: string): string {
  return html
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    // linkedom writes U+00A0 as &#160; where a browser writes &nbsp;: decode numeric references too.
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, code: string) => {
      const point = code[0]!.toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    })
    .replace(/\u00a0/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Plain text (paragraphs on blank lines) → the same HTML the editor would make. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escText(para.replace(/&/g, '&amp;')).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// ------------------------------------------------------------- sanitizer

/** The id shape a note link may name (lib/note.ts NOTE_ID_RE, repeated here so this module stays db-free). */
const NOTE_LINK_RE = /^[a-z0-9-]{1,32}$/;

/** The note ids a sanitized document links to (<a data-note="…">), deduped, in order. */
export function noteLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a data-note="([a-z0-9-]{1,32})">/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out.slice(0, 200);
}

const ALLOWED = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'mark',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'a', 'div', 'span', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'img', 'input', 'ins', 'del', 'header', 'footer', 'section',
]);
const VOID = new Set(['br', 'hr', 'img', 'input']);
// Scan once, without a per-attribute size limit or a backtracking tag regex.
// Structured pages and embedded images carry document-sized attributes; their
// limits belong to the document store, not the tokenizer. A quoted `>` is data.
function* htmlTags(input: string): Generator<{ start: number; end: number; name: string; raw: string; closing: boolean }> {
  const head = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b/y;
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf('<', cursor);
    if (start < 0) return;
    if (input.startsWith('<!--', start)) {
      const close = input.indexOf('-->', start + 4);
      cursor = close < 0 ? input.length : close + 3;
      yield { start, end: cursor, name: '', raw: '', closing: false };
      continue;
    }
    head.lastIndex = start;
    const match = head.exec(input);
    const name = match?.[1];
    if (!name) {
      if ('!?/'.includes(input[start + 1] ?? '\0')) {
        const close = input.indexOf('>', start + 2);
        cursor = close < 0 ? input.length : close + 1;
        yield { start, end: cursor, name: '', raw: '', closing: false };
      } else cursor = start + 1; // Ordinary `<` stays in the escaped text.
      continue;
    }
    const attrsStart = head.lastIndex;
    let end = attrsStart, quote = '';
    for (; end < input.length; end++) {
      const char = input.charAt(end);
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    // An incomplete tag is text, never an opportunity to reinterpret markup
    // inside its unfinished attribute. Do not rescan the same suffix.
    if (end === input.length) return;
    cursor = end + 1;
    yield { start, end: cursor, name: name.toLowerCase(), raw: input.slice(attrsStart, end), closing: input[start + 1] === '/' };
  }
}
/** An attribute value as it is written back: every character the tag scanner or a quote could trip on. */
const escAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function attr(raw: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(raw);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim().replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, code: string) => {
    const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    if (named[code.toLowerCase()]) return named[code.toLowerCase()]!;
    const point = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}

/** The inline style rules a document may keep — the same allowlist for the sanitizer
 *  and the editor's schema (note-schema.ts): lowercased, quotes dropped, `key:value;…`. */
export function cleanStyle(raw: string): string {
  const styles: string[] = [];
  for (const rule of raw.split(';')) {
    const [rawKey, ...rest] = rule.split(':');
    const key = rawKey?.trim().toLowerCase() ?? '', value = rest.join(':').trim().toLowerCase();
    const valid =
      (key === 'text-align' && /^(left|center|right|justify)$/.test(value)) ||
      (key === 'font-family' && /^(arial|calibri|cambria|georgia|helvetica|times new roman|courier new|verdana|system-ui|serif|sans-serif|monospace)$/.test(value.replace(/["']/g, ''))) ||
      (key === 'font-size' && /^(\d{1,2}(?:\.\d+)?)(px|pt)$/.test(value) && parseFloat(value) >= 6) ||
      (key === 'line-height' && /^(normal|[1-3](?:\.\d{1,2})?|4(?:\.0)?)$/.test(value)) ||
      (/^(color|background-color)$/.test(key) && /^(#[a-f0-9]{3,8}|black|white|red|yellow|blue|green|transparent|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/.test(value)) ||
      (/^(margin-left|margin-right|margin-top|margin-bottom|text-indent|padding|padding-left|padding-right|padding-top|padding-bottom)$/.test(key) && /^-?\d{1,3}(?:\.\d+)?(px|pt|mm|in)$/.test(value)) ||
      (/^(width|height|max-width)$/.test(key) && /^(auto|\d{1,4}(?:\.\d+)?(px|pt|mm|in|%))$/.test(value)) ||
      (/^page-break-(before|after|inside)$/.test(key) && /^(always|avoid|auto)$/.test(value)) ||
      (key === 'font-weight' && /^(normal|bold|[1-9]00)$/.test(value)) ||
      (key === 'font-style' && /^(normal|italic)$/.test(value)) ||
      (key === 'text-decoration' && /^(none|underline|line-through)$/.test(value)) ||
      (key === 'vertical-align' && /^(top|middle|bottom|sub|super)$/.test(value));
    if (valid) styles.push(`${key}:${value.replace(/["']/g, '')}`);
  }
  return styles.join(';');
}

/** Rebuild `input` from an allowlist. The output is only ever escaped text and
 *  canonical tags this function wrote — nothing from the input reaches it as-is. */
export function sanitizeHtml(input: string): string {
  const out: string[] = [];
  const open: string[] = [];
  let i = 0;
  for (const tag of htmlTags(input)) {
    out.push(escText(input.slice(i, tag.start)));
    i = tag.end;
    const { name, raw } = tag;
    if (!name || !ALLOWED.has(name)) continue; // an unknown tag, a comment, junk: dropped
    if (tag.closing) {
      if (VOID.has(name)) continue;
      const at = open.lastIndexOf(name);
      if (at < 0) continue; // a close with no open: dropped
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    let attrs = '';
    if (name === 'div' && isNotebookPageType(attr(raw, 'data-page'))) {
      try {
        const state = JSON.parse(decodeURIComponent(attr(raw, 'data-page-state')));
        attrs = ` data-page="${attr(raw, 'data-page')}" data-page-state="${encodeURIComponent(JSON.stringify(state)).replace(/'/g, '%27')}"`;
      } catch { /* Invalid structured data is discarded; visible text survives. */ }
    }
    if (name === 'a') {
      // A note link (<a data-note="id">) is an internal reference the editor
      // follows itself; it never carries an href. Anything else is a vetted URL.
      const note = attr(raw, 'data-note');
      if (NOTE_LINK_RE.test(note)) attrs = ` data-note="${note}"`;
      else {
        const rawHref = attr(raw, 'href');
        const href = httpUrl(rawHref) || (/^mailto:[^\s<>]{1,2040}$/i.test(rawHref) ? rawHref : null);
        if (href) attrs = ` href="${escAttr(href)}" target="_blank" rel="noreferrer"`;
      }
    }
    if (name === 'img') {
      const src = attr(raw, 'src');
      const safe = httpUrl(src) || (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : '');
      if (!safe) continue;
      attrs += ` src="${escAttr(safe)}" alt="${escAttr(attr(raw, 'alt'))}"`;
    }
    if (name === 'input') {
      if (attr(raw, 'type') !== 'checkbox') continue;
      attrs += ` type="checkbox" disabled${/\bchecked(?:\s|=|$)/i.test(raw) ? ' checked' : ''}`;
    }
    for (const key of ['colspan', 'rowspan']) {
      const value = Number(attr(raw, key));
      if ((name === 'td' || name === 'th') && Number.isInteger(value) && value >= 1 && value <= 100) attrs += ` ${key}="${value}"`;
    }
    if (name === 'ol') {
      const start = Number(attr(raw, 'start')), type = attr(raw, 'type');
      if (Number.isInteger(start) && start >= 1 && start <= 1_000_000) attrs += ` start="${start}"`;
      if (/^[1aAiI]$/.test(type)) attrs += ` type="${type}"`;
    }
    for (const key of ['data-comment', 'data-change', 'data-author', 'data-word-page', 'data-word-header', 'data-word-footer', 'data-page-number']) {
      const value = attr(raw, key);
      if (value) attrs += ` ${key}="${escAttr(value)}"`;
    }
    const style = cleanStyle(attr(raw, 'style'));
    if (style) attrs += ` style="${style}"`;
    out.push(`<${name}${attrs}>`);
    if (!VOID.has(name)) open.push(name);
  }
  out.push(escText(input.slice(i)));
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('');
}
