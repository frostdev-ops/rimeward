import { el } from './dom.ts';
import { sanitizeHtml } from '../../lib/note-text.ts';
import '../../styles/document-export.css';
const native = (window as Window & { __TAURI__?: { core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } } }).__TAURI__;
let saving = false;
export async function saveDocumentBlob(blob: Blob, requestedName: string): Promise<string> {
  const clean = requestedName.replace(/[\\/\u0000-\u001f\u007f]/g, '-') || 'document';
  const extension = /\.[a-z0-9]{1,10}$/i.exec(clean)?.[0] ?? '';
  const characters = [...clean.slice(0, extension ? -extension.length : undefined)];
  while (new TextEncoder().encode(characters.join('') + extension).length > 220) characters.pop();
  const name = characters.join('') + extension;
  if (blob.size > 32 * 1024 * 1024) throw Error('Exports are limited to 32 MiB.');
  if (native) {
    if (saving) throw Error('Finish the current Save dialog before exporting another file.');
    saving = true;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer()); let data = '';
      for (let at = 0; at < bytes.length; at += 8192) data += String.fromCharCode(...bytes.subarray(at, at + 8192));
      const path = await native.core.invoke<string | null>('save_document_export', { name, data: btoa(data) }).catch(error => { throw error instanceof Error ? error : new Error(String(error)); });
      return path ? `Saved ${path.split(/[\\/]/).at(-1)}.` : 'Export cancelled.';
    } finally { saving = false; }
  }
  const a = el('a'); const url = URL.createObjectURL(blob); a.href = url; a.download = name;
  const host = document.activeElement?.closest('dialog[open]') ?? [...document.querySelectorAll('dialog[open]')].at(-1) ?? document.body;
  host.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return `Download requested: ${name}.`;
}
/** The same print preview feeds the browser or macOS native Print / Save as PDF dialog. */
export function printDocument(html: string, title: string): void {
  document.getElementById('document-export-preview')?.remove();
  const d = el('dialog', 'fd-dialog fd-dialog-full'); d.id = 'document-export-preview'; d.setAttribute('aria-label', `Print ${title}`);
  const bar = el('div', 'document-export-bar'), heading = el('strong', undefined, title), print = el('button', 'btn-primary', 'Print / Save as PDF'), close = el('button', 'btn', 'Close');
  print.type = close.type = 'button'; const status = el('p', 'document-export-status'); status.setAttribute('role', 'status');
  const content = el('article', 'np-doc document-export-content');
  const parsed = new DOMParser().parseFromString(html, 'text/html'); content.innerHTML = sanitizeHtml(parsed.body.innerHTML);
  bar.append(heading, print, close); d.append(bar, status, content); document.body.append(d);
  close.onclick = () => d.close(); d.onclose = () => d.remove();
  print.onclick = async () => {
    print.disabled = true; status.textContent = 'Opening print dialog…';
    try { if (native) await native.core.invoke('print_document_export'); else window.print(); status.textContent = 'Use the print dialog’s Save as PDF option to export a PDF.'; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { print.disabled = false; }
  };
  d.showModal(); status.textContent = 'Print this document, or choose Save as PDF in the print dialog.';
  print.focus();
}
