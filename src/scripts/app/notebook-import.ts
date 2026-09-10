import { marked } from 'marked';
import { pageDocument } from '../../lib/notebook-pages.ts';
import { plainText, sanitizeHtml, textToHtml } from '../../lib/note-text.ts';
import { cellName, normalizeSheet, parseDelimited, SHEET_COLS, SHEET_ROWS } from '../../lib/notebook-spreadsheet.ts';
import { normalizeSlides } from '../../lib/notebook-slides.ts';
import { validateDrawing } from '../../lib/notebook-drawing.ts';
import { importDocx } from './note-docx.ts';
import { el, toast } from './dom.ts';
import { closeMenu } from './menu.ts';

export const NOTEBOOK_FILE_ACCEPT = '.docx,.md,.markdown,.txt,.html,.htm,.csv,.tsv,.json,.png,.jpg,.jpeg,.webp,.gif';
export interface ImportedNotebookFile { title: string; html: string; warnings: string[] }
export function pickNotebookFiles(open: (files: File[]) => Promise<void>, multiple = true): void {
  closeMenu();
  const input = el('input'); input.type = 'file'; input.accept = NOTEBOOK_FILE_ACCEPT; input.multiple = multiple; input.hidden = true;
  input.addEventListener('cancel', () => input.remove(), { once: true });
  input.addEventListener('change', () => { const files = [...(input.files ?? [])]; input.remove(); if (files.length) void open(files).catch(error => toast(error instanceof Error ? error.message : 'Could not open the file.', undefined, true)); }, { once: true });
  const host = document.activeElement?.closest('dialog[open]') ?? [...document.querySelectorAll('dialog[open]')].at(-1) ?? document.body;
  host.append(input); input.click();
}
/** Read only the explicitly selected file; saving writes a notebook copy, never back to disk. */
export async function importNotebookFile(file: File): Promise<ImportedNotebookFile> {
  if (file.size > 16 * 1024 * 1024) throw Error('Choose a file smaller than 16 MiB.');
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  const title = (file.name.replace(/\.[^.]+$/, '') || file.name).slice(0, 120);
  let html = '', warnings: string[] = [];
  const markdown = (source: string) => {
    if (source.length > 500_000) throw Error('Markdown pages support up to 500,000 characters.');
    return pageDocument('markdown', { source }, plainText(sanitizeHtml(marked.parse(source, { async: false, gfm: true }))));
  };
  if (extension === 'docx') ({ html, warnings } = await importDocx(file));
  else if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension ?? '')) {
    if (file.size > 10_000_000) throw Error('Choose an image smaller than 10 MB.');
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(Error('Could not read the image.')); reader.readAsDataURL(new Blob([file], { type: `image/${extension === 'jpg' ? 'jpeg' : extension}` })); });
    const doc = document.createElement('div'), image = document.createElement('img'); image.src = data; image.alt = title; doc.append(image); html = doc.innerHTML;
  } else {
    const source = await file.text();
    if (extension === 'md' || extension === 'markdown') html = markdown(source);
    else if (extension === 'txt') html = textToHtml(source.replace(/&/g, '&amp;'));
    else if (extension === 'html' || extension === 'htm') {
      const parsed = new DOMParser().parseFromString(source, 'text/html');
      for (const element of parsed.querySelectorAll('script,style,link,meta,base,iframe,object,embed')) element.remove();
      html = parsed.body.innerHTML;
      warnings.push('HTML formatting is limited to the document editor’s supported styles.');
    } else if (extension === 'csv' || extension === 'tsv') {
      if (file.size > 2_000_000) throw Error('CSV/TSV imports support files up to 2 MB.');
      const rows = parseDelimited(source.replace(/^\uFEFF/, ''), extension === 'tsv' ? '\t' : ',');
      const sheet = normalizeSheet({ rows: Math.max(1, rows.length), cols: Math.max(1, ...rows.map(row => row.length)) });
      for (const [r, row] of rows.entries()) for (const [c, value] of row.entries()) sheet.cells[cellName(r, c)] = { value };
      html = pageDocument('spreadsheet', sheet, rows.map(row => row.join('\t')).join('\n'));
    } else if (extension === 'json') {
      const raw = JSON.parse(source) as Record<string, unknown> | null;
      if (raw?.version === 1 && Array.isArray(raw.slides)) {
        const slides = normalizeSlides(raw); html = pageDocument('slides', slides, slides.slides.map(slide => [slide.title, ...slide.objects.map(object => object.text), slide.notes].join('\n')).join('\n\n'));
      } else if (raw?.version === 1 && Array.isArray(raw.nodes) && Array.isArray(raw.connectors)) {
        const drawing = validateDrawing(raw); html = pageDocument('drawing', drawing, [...drawing.nodes.map(node => [node.label, ...node.data.map(point => `${point.label}: ${point.value}`)].join('\n')), ...drawing.connectors.map(edge => edge.label)].join('\n'));
      } else if (raw?.version === 1 && raw.cells && typeof raw.cells === 'object') {
        if (typeof raw.rows !== 'number' || raw.rows < 1 || raw.rows > SHEET_ROWS || typeof raw.cols !== 'number' || raw.cols < 1 || raw.cols > SHEET_COLS) throw Error(`Sheets support ${SHEET_ROWS} rows and ${SHEET_COLS} columns.`);
        const sheet = normalizeSheet(raw); html = pageDocument('spreadsheet', sheet, Object.entries(sheet.cells).map(([cell, value]) => `${cell}: ${value.value}`).join('\n'));
      } else html = markdown(`\`\`\`json\n${source}\n\`\`\``);
    } else throw Error('Supported files: DOCX, Markdown, text, HTML, CSV/TSV, notebook JSON and raster images.');
  }
  html = sanitizeHtml(html);
  if (html.length > 16 * 1024 * 1024) throw Error('The imported document exceeds the 16 MiB notebook limit.');
  return { title, html, warnings };
}
