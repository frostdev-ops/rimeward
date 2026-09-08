import { inflateRawSync } from 'node:zlib';

// Document text extraction (ported from the PMA office app). PDFs are extracted
// to text server-side and the WHOLE text is kept — the agent reaches the parts
// that don't fit in a prompt through read_document/search_document rather than
// us deciding up front how much of a document it is allowed to see.
//
// A scanned PDF has no text layer and comes back empty; that is reported as a
// scan rather than handed to the model as a blank page to hallucinate over.

export interface PdfText {
  pages: string[];
  /** Page-delimited full text — what gets stored and searched. */
  text: string;
  /** No extractable text anywhere: it is a scan and needs vision instead. */
  scanned: boolean;
}

export const PAGE_MARK = (n: number) => `--- page ${n} ---`;

export async function extractPdfText(data: Uint8Array): Promise<PdfText> {
  // Legacy build: pure JS, no DOM, no worker — the one that runs under Node.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js refuses a Node Buffer by name ("Please provide binary data as
  // `Uint8Array`"), and every caller here starts from one. Copy, don't cast:
  // pdf.js takes ownership of the array it is handed.
  const bytes = Buffer.isBuffer(data) ? new Uint8Array(data) : data;
  // v6 note: PMA passed isEvalSupported:false; pdf.js 5+ removed eval entirely,
  // so the option (and the worry) no longer exists.
  const task = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    disableFontFace: true,
  });
  try {
    const doc = await task.promise;

    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // Re-introduce line breaks: pdf.js hands back positioned runs, and a wall of
      // space-joined text loses the row structure an invoice lives in.
      let line = '';
      const lines: string[] = [];
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        line += item.str ?? '';
        if (item.hasEOL) {
          lines.push(line.trimEnd());
          line = '';
        }
      }
      if (line.trim()) lines.push(line.trimEnd());
      pages.push(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim());
      page.cleanup();
    }

    const text = pages.map((p, i) => `${PAGE_MARK(i + 1)}\n${p}`).join('\n\n');
    return { pages, text, scanned: !pages.some(page => page.trim()) };
  } finally { await task.destroy(); }
}

/** Bounded page image for scans, diagrams and layout that text extraction cannot describe. */
export async function renderPdfPage(data: Uint8Array, pageNumber: number): Promise<{ bytes: Uint8Array; pages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false, disableFontFace: true });
  try {
    const doc = await task.promise;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) throw Error(`Page must be between 1 and ${doc.numPages}.`);
    const page = await doc.getPage(pageNumber), base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1800 / Math.max(base.width, base.height)) });
    const factory = doc.canvasFactory as { create(w: number, h: number): { canvas: HTMLCanvasElement & { toBuffer(type: string): Uint8Array }; context: CanvasRenderingContext2D }; destroy(target: unknown): void };
    const target = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    try {
      await page.render({ canvas: target.canvas, canvasContext: target.context, viewport }).promise;
      return { bytes: target.canvas.toBuffer('image/png'), pages: doc.numPages };
    } finally { factory.destroy(target); }
  } finally { await task.destroy(); }
}

/** Lines matching `query`, with the page they came from. */
export function searchPages(pages: string[], query: string, limit = 40): { page: number; line: string }[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: { page: number; line: string }[] = [];
  for (let i = 0; i < pages.length && hits.length < limit; i++) {
    for (const line of pages[i].split('\n')) {
      if (line.toLowerCase().includes(needle)) {
        hits.push({ page: i + 1, line: line.trim().slice(0, 300) });
        if (hits.length >= limit) break;
      }
    }
  }
  return hits;
}

/**
 * A text file (CSV, Markdown, JSON, a log, source) cut into pages, so it lands
 * in the same shape as a PDF and read_document/search_document work on it
 * unchanged. Pages are line-aligned — a CSV row never straddles two of them.
 */
export function paginateText(raw: string, perPage = 3000): PdfText {
  const pages: string[] = [];
  let cur = '';
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    if (cur && cur.length + line.length + 1 > perPage) {
      pages.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur.trim() || !pages.length) pages.push(cur);
  const text = pages.map((p, i) => `${PAGE_MARK(i + 1)}\n${p}`).join('\n\n');
  return { pages, text, scanned: false };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** One named file out of a zip. Read through the central directory, because a
 *  local header is allowed to leave the sizes at zero and defer them. */
function zipEntry(buf: Buffer, want: string): Buffer | null {
  const eocd = buf.lastIndexOf('PK\x05\x06', buf.length, 'binary');
  if (eocd < 0 || eocd + 20 > buf.length) return null;
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (buf.toString('utf8', p + 46, p + 46 + nameLen) === want) {
      const method = buf.readUInt16LE(p + 10);
      const size = buf.readUInt32LE(p + 20);
      const local = buf.readUInt32LE(p + 42);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      // A 50MB ceiling: a .docx that inflates past that is a zip bomb, not a
      // document, and this runs on the request path.
      return method === 0 ? data : inflateRawSync(data, { maxOutputLength: 50 * 1024 * 1024 });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * The text of a .docx, paragraph breaks kept. Null if the bytes are not a Word
 * document — the caller then tries them as plain text.
 * ponytail: .docx only. .xlsx (shared strings + per-sheet XML) and legacy .doc
 * are not read; add them here if someone actually attaches one.
 */
export function extractDocxText(bytes: Uint8Array): string | null {
  let xml: Buffer | null;
  try {
    xml = zipEntry(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), 'word/document.xml');
  } catch {
    return null; // not a zip we understand (zip64, encrypted, truncated)
  }
  if (!xml) return null;
  return xml
    .toString('utf8')
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<\/w:(p|tr)>/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_m, e) => ENTITIES[e])
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
