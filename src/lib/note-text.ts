import { httpUrl } from './wards.ts';

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
    .map((para) => `<p>${escText(para).replace(/\n/g, '<br>')}</p>`)
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
  'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'a', 'div', 'span',
]);
const VOID = new Set(['br', 'hr']);
// What the HTML tokenizer treats as markup after a `<`: a letter (a tag), `!`
// (a comment / declaration), `/` (an end tag), `?` (a bogus comment). Any other
// `<` is text — "a < b" must survive as text.
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|<!--[\s\S]*?-->|<[!?/][^>]*>?/g;

function attr(raw: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(raw);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
}

/** Rebuild `input` from an allowlist. The output is only ever escaped text and
 *  canonical tags this function wrote — nothing from the input reaches it as-is. */
export function sanitizeHtml(input: string): string {
  const out: string[] = [];
  const open: string[] = [];
  let i = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(input))) {
    out.push(escText(input.slice(i, m.index)));
    i = m.index + m[0].length;
    const name = m[1]?.toLowerCase();
    if (!name || !ALLOWED.has(name)) continue; // an unknown tag, a comment, junk: dropped
    if (m[0].startsWith('</')) {
      if (VOID.has(name)) continue;
      const at = open.lastIndexOf(name);
      if (at < 0) continue; // a close with no open: dropped
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    let attrs = '';
    if (name === 'a') {
      // A note link (<a data-note="id">) is an internal reference the editor
      // follows itself; it never carries an href. Anything else is a vetted URL.
      const note = attr(m[2] ?? '', 'data-note');
      if (NOTE_LINK_RE.test(note)) attrs = ` data-note="${note}"`;
      else {
        const href = httpUrl(attr(m[2] ?? '', 'href'));
        if (href) attrs = ` href="${href.replace(/"/g, '&quot;')}" target="_blank" rel="noreferrer"`;
      }
    }
    const align = /text-align\s*:\s*(left|center|right)/i.exec(attr(m[2] ?? '', 'style'));
    if (align) attrs += ` style="text-align:${align[1]!.toLowerCase()}"`;
    out.push(`<${name}${attrs}>`);
    if (!VOID.has(name)) open.push(name);
  }
  out.push(escText(input.slice(i)));
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('');
}
