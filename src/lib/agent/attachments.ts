import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getDb } from '../db.ts';
import { extractDocxText, extractPdfText, paginateText, searchPages, PAGE_MARK } from './docs.ts';
import { writeDocText } from './history.ts';
import { knowledgeChanged } from './observation-events.ts';

// Attachments the user hands the agent. Bytes are content-addressed on disk,
// metadata and extracted text in SQLite (agent_files, per-user). Stored once,
// referenced by id afterwards — nothing gets re-uploaded or re-embedded per turn.

export const ATTACH_DIR = path.join(DATA_DIR, 'attachments');

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export interface AgentFile {
  id: number;
  conversation_id: number | null;
  user_id: number;
  name: string;
  mime: string;
  sha256: string;
  bytes: number;
  pages: number | null;
  text: string | null;
  created_at: string;
}

export const isImage = (mime: string) => IMAGE_MIMES.includes(mime);
export const isPdf = (mime: string) => mime === 'application/pdf';
/** Everything that is not an image is stored with its text extracted, so
 *  "document" is simply the other case — PDF, Word, CSV, Markdown, code, log. */
export const isDoc = (mime: string) => !isImage(mime);

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Format from the leading bytes, for the two containers we open ourselves. */
function sniff(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 4)).toString('binary');
  if (head === '%PDF') return 'application/pdf';
  // A drag-and-drop or a Windows browser can hand over an image with no mime.
  if (head.startsWith('\x89PNG')) return 'image/png';
  if (head.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (head === 'GIF8') return 'image/gif';
  if (head === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp';
  // Every OOXML/ODF file is a zip; extractDocxText returns null for the rest.
  if (head === 'PK\x03\x04') return DOCX_MIME;
  return null;
}

/** A mime to store text under: the browser's if it is already a text type. */
function textMime(name: string, mime: string): string {
  if (mime.startsWith('text/')) return mime;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return ext === 'csv' ? 'text/csv' : ext === 'md' || ext === 'markdown' ? 'text/markdown' : 'text/plain';
}

/** UTF-8 text, or null if these bytes are not text at all. */
function decodeText(bytes: Uint8Array): string | null {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return s.includes('\u0000') ? null : s;
  } catch {
    return null;
  }
}

export function attachmentPath(sha256: string): string {
  return path.join(ATTACH_DIR, sha256);
}

/**
 * Store one attachment and extract its text — a PDF's text layer, a Word
 * document's body, or a text file (CSV, Markdown, JSON, code) as-is. Throws with
 * a sentence the user can act on — callers report per file rather than silently
 * dropping anything.
 */
export async function storeAttachment(opts: {
  userId: number;
  name: string;
  mime: string;
  bytes: Uint8Array;
  conversationId: number | null;
}): Promise<AgentFile> {
  const { userId, name, bytes, conversationId } = opts;
  if (!bytes.length) throw new Error(`${name} is empty`);
  // The browser's mime is unreliable (blank for .md, "application/vnd.ms-excel"
  // for .csv), so the bytes decide: image, PDF, Word, or anything that decodes
  // as text. Only what decodes as none of those is refused.
  const mime = isImage(opts.mime) ? opts.mime : (sniff(bytes) ?? textMime(name, opts.mime));
  let docText: string | null = null;
  if (!isImage(mime) && !isPdf(mime)) {
    docText = mime === DOCX_MIME ? extractDocxText(bytes) : decodeText(bytes);
    if (docText === null) {
      throw new Error(
        `${name}: ${opts.mime || 'that file type'} is not something I can read — attach a PDF, a Word document, an image, or a text file (CSV, Markdown, JSON, …)`
      );
    }
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  const file = attachmentPath(sha256);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { mode: 0o600 });

  let pages: number | null = null;
  let text: string | null = null;
  if (isDoc(mime)) {
    // Reuse a previous extraction of the identical file — same bytes, same text.
    const seen = getDb()
      .prepare("SELECT pages, text FROM agent_files WHERE sha256 = ? AND text <> '' LIMIT 1")
      .get(sha256) as { pages: number; text: string } | undefined;
    if (seen) {
      pages = seen.pages;
      text = seen.text;
    } else {
      const doc = docText === null ? await extractPdfText(bytes) : paginateText(docText);
      pages = doc.pages.length;
      text = doc.scanned ? '' : doc.text;
    }
  }

  const info = getDb()
    .prepare(
      `INSERT INTO agent_files (conversation_id, user_id, name, mime, sha256, bytes, pages, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(conversationId, userId, name.slice(0, 200), mime, sha256, bytes.length, pages, text);
  const stored = getAttachment(userId, Number(info.lastInsertRowid))!;
  // A plain .txt next to every document, so the shell can grep across all of them.
  if (text) writeDocText(userId, stored.id, stored.name, text);
  knowledgeChanged(userId);
  return stored;
}

/** Ownership-checked: an id from another user's conversation is simply not found. */
export function getAttachment(userId: number, id: number): AgentFile | null {
  return (
    (getDb().prepare('SELECT * FROM agent_files WHERE id = ? AND user_id = ?').get(id, userId) as
      | AgentFile
      | undefined) ?? null
  );
}

/** Ownership-checked like getAttachment — the conversation id alone is not a
 *  capability. */
export function listAttachments(userId: number, conversationId: number): AgentFile[] {
  return getDb()
    .prepare('SELECT * FROM agent_files WHERE conversation_id = ? AND user_id = ? ORDER BY id')
    .all(conversationId, userId) as AgentFile[];
}

/** Data URL for the vision input item. */
export function attachmentDataUrl(f: AgentFile): string | null {
  try {
    return `data:${f.mime};base64,${fs.readFileSync(attachmentPath(f.sha256)).toString('base64')}`;
  } catch {
    return null; // bytes gone (restored DB without the files) — degrade, don't throw
  }
}

export function pagesOf(f: AgentFile): string[] {
  if (!f.text) return [];
  return f.text
    .split(/\n*--- page \d+ ---\n?/)
    .slice(1)
    .map((p) => p.trim());
}

/** A slice of a document, by page range. */
export function readPages(f: AgentFile, from = 1, to?: number): { pages: number; from: number; to: number; text: string } {
  const all = pagesOf(f);
  const start = Math.max(1, Math.min(from, all.length));
  const end = Math.max(start, Math.min(to ?? start + 4, all.length));
  const text = all
    .slice(start - 1, end)
    .map((p, i) => `${PAGE_MARK(start + i)}\n${p}`)
    .join('\n\n');
  return { pages: all.length, from: start, to: end, text };
}

export function searchAttachment(f: AgentFile, query: string): { page: number; line: string }[] {
  return searchPages(pagesOf(f), query);
}
