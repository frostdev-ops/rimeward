// Structured page state rides inside the existing sanitized, revisioned note document.
// Its visible text remains searchable and readable by legacy note clients and model tools.
export const NOTEBOOK_PAGE_TYPES = ['markdown', 'spreadsheet', 'slides', 'drawing'] as const;
export type NotebookPageType = typeof NOTEBOOK_PAGE_TYPES[number];
export const NOTE_FORMAT = 2;
export const NOTE_FORMAT_HEADER = 'x-rime-note-format';
/** Old runtimes strip these tags/attributes; do not let them round-trip enhanced documents. */
export function noteRecordNeedsFormat(record?: { key?: unknown; payload?: unknown } | null): boolean {
  if (typeof record?.key !== 'string' || !record.key.startsWith('note/') || typeof record.payload !== 'string') return false;
  try {
    const html = (JSON.parse(record.payload) as { html?: unknown } | null)?.html;
    return typeof html === 'string' && (/\bdata-(page|word|comment|change|author)\b|<(table|thead|tbody|tfoot|tr|td|th|img|input|ins|del|header|footer|section|h5|h6)\b|<ol\b[^>]*\b(start|type)=/i.test(html) || [...html.matchAll(/style="([^"]*)"/gi)].some(m => m[1]!.replace(/text-align:(left|center|right);?/gi, '').trim()) || html.length > 512 * 1024);
  } catch { return false; }
}
export function isNotebookPageType(value: unknown): value is NotebookPageType {
  return typeof value === 'string' && (NOTEBOOK_PAGE_TYPES as readonly string[]).includes(value);
}
export function pageDocument(type: NotebookPageType, state: unknown, text = ''): string {
  const payload = encodeURIComponent(JSON.stringify(state ?? null)).replace(/'/g, '%27');
  const summary = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  return `<div data-page="${type}" data-page-state="${payload}">${summary}</div>`;
}
export function readPageDocument(html: string): { type: NotebookPageType; state: unknown } | null {
  const m = /^<div data-page="([a-z]+)" data-page-state="([^"]*)">/.exec(html);
  if (!m || !isNotebookPageType(m[1])) return null;
  if (!html.endsWith('</div>') || /<\/?div\b/i.test(html.slice(m[0].length, -6))) return null;
  try { return { type: m[1], state: JSON.parse(decodeURIComponent(m[2]!)) }; } catch { return null; }
}
