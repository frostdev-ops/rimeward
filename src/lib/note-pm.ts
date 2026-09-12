// The server's document codec: HTML ↔ ProseMirror document over linkedom, the
// same schema and the same parser rules the editor runs in the browser
// (note-schema.ts). What the collaboration room (note-room.ts) builds a shared
// document from, and what it writes back to the notes table.
import { parseHTML } from 'linkedom';
import type { Node as PMNode } from 'prosemirror-model';
import { noteSchema, parseNoteHtml, serializeNoteDoc } from './note-schema.ts';

const dom = (): Document => (parseHTML('<!doctype html><html><body></body></html>') as unknown as { document: Document }).document;

export function htmlToDoc(html: string): PMNode {
  return parseNoteHtml(dom(), html);
}
export function docToHtml(doc: PMNode): string {
  return serializeNoteDoc(dom(), doc);
}
export const docToJSON = (doc: PMNode): unknown => doc.toJSON();
export const jsonToDoc = (json: unknown): PMNode => noteSchema.nodeFromJSON(json);
