// The collaborative document editor: a ProseMirror view over the shared Yjs
// document a room holds (lib/note-room.ts), synced through y-websocket at
// /api/note/ws/<document>?ward=<host>. note.ts owns the surface around it (the
// toolbar, ink, the ✨ bar, transcription, export); this module owns the view,
// the provider, and the commands those surfaces call. One editor per open
// document: open another and this one is destroyed.
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { EditorState, Plugin, PluginKey, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { ReplaceStep } from 'prosemirror-transform';
import * as decoding from 'lib0/decoding';
import { EditorView } from 'prosemirror-view';
import { DOMParser as PMDOMParser, Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, chainCommands, lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { tableEditing } from 'prosemirror-tables';
import { absolutePositionToRelativePosition, initProseMirrorDoc, redo, relativePositionToAbsolutePosition, undo, yCursorPlugin, ySyncPlugin, ySyncPluginKey, yUndoPlugin } from 'y-prosemirror';
import { noteSchema, parseNoteHtml, serializeNoteDoc } from '../../lib/note-schema.ts';

export interface Stroke { id?: string; c: string; w: number; p: [number, number, number][] }
export type EditorStatus = 'connecting' | 'connected' | 'disconnected';

/** Track changes (the ribbon's Review tab): while on, this author's typing carries an
 *  insertion mark and what they delete stays as a deletion mark. */
export interface TrackRef { on: boolean; author: string }

export interface DocumentEditor {
  readonly view: EditorView;
  readonly ink: Y.Array<Stroke>;
  readonly track: TrackRef;
  /** The socket is open and synced. */
  readonly connected: boolean;
  /** Local edits made while out of sync that the room has not seen; they live in this document until it syncs. */
  pendingLocal: boolean;
  /** The document as the store would keep it. */
  html(): string;
  text(): string;
  /** Replace the whole document (an import, a Rime rewrite) as one undoable change. */
  setHtml(html: string): void;
  insertHtml(html: string): void;
  /** Replace the selection (or `range`) with text; newlines become line breaks. */
  insertText(text: string, range?: { from: number; to: number }): void;
  /** Paragraphs (blank-line separated) after the block holding `after`, or at the end. */
  appendParagraphs(text: string, after?: number): void;
  /** The selection as positions that follow every edit (a remote collaborator's included) until read. */
  anchor(): () => { from: number; to: number } | null;
  /** Paragraphs before the first block below page-y `y` (handwriting lands where it was written). */
  insertParagraphsAt(text: string, y: number): void;
  /** Replace a document range with plain text (a grammar fix). */
  replaceRange(from: number, to: number, text: string): void;
  /** Inline highlights (grammar issues) by document position; an empty list clears them. */
  setHighlights(marks: { from: number; to: number; cls: string }[]): void;
  /** Hear every document change, local or remote; returns the unsubscribe. */
  onDocChange(fn: () => void): () => void;
  /** The document's text with a map from text index to document position (search, grammar). */
  textRuns(): { text: string; posAt(i: number): number | null };
  /** Replace the DOM text range [from, to) of `node` with a note link — the `[[` picker's pick. */
  replaceDomRange(node: Text, from: number, to: number, id: string, title: string): void;
  selectionText(): string;
  hasSelection(): boolean;
  /** What the toolbar's block buttons read: p, h1–h6, blockquote, pre. */
  blockType(): string;
  /** The execCommand names the toolbar always used, run as ProseMirror commands. */
  cmd(name: string, value?: string): void;
  removeStrokes(ids: Set<string>): void;
  setEditable(on: boolean): void;
  focus(): void;
  destroy(): void;
}

const s = noteSchema;

/** Inline highlights set from outside (the grammar review): a decoration set mapped through every change. */
const highlightsKey = new PluginKey<DecorationSet>('np-highlights');
const highlights = () => new Plugin<DecorationSet>({
  key: highlightsKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const next = tr.getMeta(highlightsKey) as { from: number; to: number; cls: string }[] | undefined;
      if (next) return DecorationSet.create(tr.doc, next.map((m) => Decoration.inline(m.from, m.to, { class: m.cls })));
      return set.map(tr.mapping, tr.doc);
    },
  },
  props: { decorations: (state) => highlightsKey.getState(state) },
});

/** Copies of a fragment with this author's own tracked insertions dropped (deleting
 *  what you just inserted is a real delete) and, for the rest, the deletion mark added. */
function withoutOwnInsertions(frag: Fragment, author: string): Fragment {
  const out: PMNode[] = [];
  frag.forEach((node) => {
    if (node.isText) {
      const ins = node.marks.find((m) => m.type === s.marks.ins_change);
      if (ins && ins.attrs.author === author) return;
      out.push(node);
    } else if (node.isLeaf) out.push(node);
    else {
      const content = withoutOwnInsertions(node.content, author);
      if (content.size || node.type.spec.content === undefined) out.push(node.copy(content));
    }
  });
  return Fragment.from(out);
}
function markDeleted(frag: Fragment, author: string, id: string): Fragment {
  const del = s.marks.del_change!.create({ id, author });
  const out: PMNode[] = [];
  frag.forEach((node) => {
    if (node.isText || node.isLeaf) out.push(node.isInline && !node.marks.some((m) => m.type === s.marks.del_change) ? node.mark(del.addToSet(node.marks.filter((m) => m.type !== s.marks.ins_change))) : node);
    else out.push(node.copy(markDeleted(node.content, author, id)));
  });
  return Fragment.from(out);
}
/** While tracking, this author's inline edits are rewritten in place: insertions marked,
 *  deletions kept as marked text. Structural edits (a heading, a list, Enter, a paste of
 *  blocks) apply directly — only a replacement inside one text block is tracked. */
function trackChanges(track: TrackRef): Plugin {
  return new Plugin({
    appendTransaction(trs, _old, newState) {
      if (!track.on) return null;
      let tr: Transaction | null = null;
      for (const t of trs) {
        if (!t.docChanged || t.getMeta('track') || t.getMeta(ySyncPluginKey) || t.getMeta('addToHistory') === false) continue;
        t.steps.forEach((step, i) => {
          if (!(step instanceof ReplaceStep)) return;
          const { from, to, slice } = step;
          if (slice.openStart || slice.openEnd || (slice.size && !slice.content.firstChild!.isInline)) return;
          const before = t.docs[i]!;
          const $from = before.resolve(from);
          if (!$from.parent.isTextblock || !$from.sameParent(before.resolve(to))) return;
          const toFinal = t.mapping.slice(i + 1);
          tr ??= newState.tr.setMeta('track', true).setMeta('addToHistory', true);
          const id = Math.random().toString(36).slice(2, 10);
          if (to > from) {
            const kept = withoutOwnInsertions(before.slice(from, to).content, track.author);
            if (kept.size) tr.insert(tr.mapping.map(toFinal.map(from, -1)), markDeleted(kept, track.author, id));
          }
          if (slice.size) {
            const a = tr.mapping.map(toFinal.map(from, -1)), b = tr.mapping.map(toFinal.map(from + slice.size, 1));
            if (b > a) tr.addMark(a, b, s.marks.ins_change!.create({ id, author: track.author }));
          }
        });
      }
      return tr;
    },
  });
}

/** A rule or a table as the last block leaves nowhere to type after it: a paragraph follows
 *  (the legacy editor inserted one). Only after local edits — every client fixing a remote
 *  document at once would add one paragraph each. */
const trailingParagraph = () => new Plugin({
  appendTransaction(trs, _old, state) {
    if (!trs.some((t) => t.docChanged && !t.getMeta(ySyncPluginKey))) return null;
    const { doc } = state;
    let container: PMNode = doc, base = 0;
    if (doc.lastChild?.type === s.nodes.page) { container = doc.lastChild; base = doc.content.size - container.nodeSize + 1; }
    let last: PMNode | undefined, endPos = base;
    container.forEach((child, offset) => { if (child.type !== s.nodes.page_footer) { last = child; endPos = base + offset + child.nodeSize; } });
    if (!last || !((last as PMNode).isLeaf || (last as PMNode).type === s.nodes.table)) return null;
    return state.tr.insert(endPos, s.nodes.paragraph!.create()).setMeta('addToHistory', false).setMeta('track', true);
  },
});

const inList = (state: EditorState, type: string): boolean => {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === type) return true;
  return false;
};
const inAncestor = (state: EditorState, type: string): boolean => inList(state, type);

/** Text with single newlines as line breaks, as one paragraph's content. */
const lineContent = (text: string): PMNode[] => {
  const out: PMNode[] = [];
  text.split('\n').forEach((line, i) => {
    if (i) out.push(s.nodes.hard_break!.create());
    if (line) out.push(s.text(line));
  });
  return out;
};
/** Paragraphs on blank lines — what the model or the pen produce. */
const paragraphs = (text: string): PMNode[] => text.split(/\n{2,}/).map((para) => s.nodes.paragraph!.create(null, lineContent(para)));

let me: Promise<{ name: string; color: string }> | undefined;
const COLORS = ['#e06c75', '#d19a66', '#98c379', '#56b6c2', '#61afef', '#c678dd', '#f28fad', '#8bd5ca'];
function whoami(): Promise<{ name: string; color: string }> {
  me ??= fetch('/api/me', { headers: { accept: 'application/json' } })
    .then((r) => r.json())
    .then((d: { displayName?: string; email?: string }) => {
      const name = d.displayName || d.email?.split('@')[0] || 'Someone';
      let h = 0;
      for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return { name, color: COLORS[h % COLORS.length]! };
    })
    .catch(() => ({ name: 'Someone', color: COLORS[0]! }));
  return me;
}

export interface EditorOptions {
  /** The element the view takes over — the notepad's .np-doc. */
  mount: HTMLElement;
  docId: string;
  /** The host ward id, so the server resolves exactly this document. */
  ward: string;
  readOnly: boolean;
  onChange(): void;
  onStatus(status: EditorStatus): void;
  /** The room refused us (an old server, a structured page, a desktop viewing a share): fall back. */
  onFail(): void;
  /** The room's save landed or was refused (lib/note-room.ts MSG_STATUS): what the status line shows. */
  onPersist?(status: { persist: 'ok' | 'error'; message?: string }): void;
}

export function createDocumentEditor(o: EditorOptions): DocumentEditor {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment('prosemirror');
  const ink = ydoc.getArray<Stroke>('ink');
  const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/note/ws`;
  const provider = new WebsocketProvider(url, o.docId, ydoc, { params: { ward: o.ward }, disableBc: true, maxBackoffTime: 10_000 });
  let readOnly = o.readOnly;
  // Nothing is editable before the first sync: a keystroke into the empty pre-sync document would be a document.
  let everSynced = false;
  let failures = 0;
  const track: TrackRef = { on: false, author: 'You' };
  const editor = {
    pendingLocal: false,
    track,
    get connected() { return provider.wsconnected && provider.synced; },
  } as DocumentEditor & { pendingLocal: boolean };

  const { doc, meta } = initProseMirrorDoc(fragment, s);
  const state = EditorState.create({
    doc,
    plugins: [
      ySyncPlugin(fragment, { mapping: meta.mapping }),
      yCursorPlugin(provider.awareness),
      yUndoPlugin(),
      keymap({
        'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo,
        'Mod-b': toggleMark(s.marks.strong!), 'Mod-i': toggleMark(s.marks.em!), 'Mod-u': toggleMark(s.marks.underline!),
        Enter: chainCommands(splitListItem(s.nodes.list_item!), baseKeymap.Enter!),
        Tab: sinkListItem(s.nodes.list_item!), 'Shift-Tab': liftListItem(s.nodes.list_item!),
        'Shift-Enter': (st, dispatch) => { dispatch?.(st.tr.replaceSelectionWith(s.nodes.hard_break!.create()).scrollIntoView()); return true; },
      }),
      keymap(baseKeymap),
      trackChanges(track),
      trailingParagraph(),
      highlights(),
      inputRules({ rules: [
        wrappingInputRule(/^\s*([-+*])\s$/, s.nodes.bullet_list!),
        wrappingInputRule(/^(\d+)\.\s$/, s.nodes.ordered_list!, (m) => ({ start: Number(m[1]) }), (m, node) => node.childCount + (node.attrs.start as number) === Number(m[1])),
        wrappingInputRule(/^\s*>\s$/, s.nodes.blockquote!),
        textblockTypeInputRule(/^(#{1,6})\s$/, s.nodes.heading!, (m) => ({ level: m[1]!.length })),
      ] }),
      tableEditing(),
    ],
  });
  const changeListeners = new Set<() => void>();
  const view = new EditorView({ mount: o.mount }, {
    state,
    editable: () => !readOnly && everSynced,
    dispatchTransaction(tr: Transaction) {
      view.updateState(view.state.apply(tr));
      if (tr.docChanged) {
        if (!provider.synced && !tr.getMeta(ySyncPluginKey)) editor.pendingLocal = true;
        o.onChange();
        for (const fn of changeListeners) fn();
      }
    },
  });
  provider.on('status', ({ status }: { status: string }) => {
    if (status === 'connected') failures = 0;
    o.onStatus(status === 'connected' ? (provider.synced ? 'connected' : 'connecting') : status === 'connecting' ? 'connecting' : 'disconnected');
  });
  provider.on('sync', (ok: boolean) => {
    if (!ok) return;
    const first = !everSynced;
    everSynced = true;
    editor.pendingLocal = false; // whatever was typed offline has been exchanged
    if (first) view.setProps({ editable: () => !readOnly });
    o.onStatus('connected');
    o.onChange();
  });
  // Each failed attempt closes once (the error event precedes it): two closes before any sync = fall back.
  provider.on('connection-close', (event: { code?: number } | null) => {
    // The room said no (deleted, a structured page) or the server cannot host it: the surface falls back.
    if (event?.code === 4404 || event?.code === 4426) { o.onFail(); return; }
    if (!everSynced && ++failures >= 2) o.onFail();
  });
  // lib/note-room.ts MSG_STATUS (100): the room's save landed or was refused.
  provider.messageHandlers[100] = (_encoder, decoder) => { try { o.onPersist?.(JSON.parse(decoding.readVarString(decoder))); } catch { /* not ours */ } };
  void whoami().then((user) => { provider.awareness.setLocalStateField('user', user); if (track.author === 'You') track.author = user.name; });

  const run = (command: Command) => { command(view.state, view.dispatch, view); view.focus(); };
  const toggleList = (list: 'bullet_list' | 'ordered_list') => run(inList(view.state, list) ? liftListItem(s.nodes.list_item!) : wrapInList(s.nodes[list]!));
  const block = (name: string) => {
    if (name === 'blockquote') return run(inAncestor(view.state, 'blockquote') ? lift : wrapIn(s.nodes.blockquote!));
    if (name === 'pre') return run(setBlockType(s.nodes.code_block!));
    const m = /^h([1-6])$/.exec(name);
    if (m) return run(setBlockType(s.nodes.heading!, { level: Number(m[1]) }));
    if (inAncestor(view.state, 'blockquote')) run(lift);
    run(setBlockType(s.nodes.paragraph!));
  };
  const parseFragment = (html: string): Slice => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return PMDOMParser.fromSchema(s).parseSlice(host);
  };
  const insertBlocksAt = (pos: number, nodes: PMNode[]) => {
    const tr = view.state.tr.insert(pos, Fragment.from(nodes));
    view.dispatch(tr.scrollIntoView());
  };

  Object.assign(editor, {
    view, ink,
    html: () => serializeNoteDoc(document, view.state.doc),
    text: () => view.state.doc.textBetween(0, view.state.doc.content.size, '\n', ''),
    // One ProseMirror transaction, so ⌘Z undoes it (a change made on the Y.Doc directly is outside the undo manager).
    setHtml: (html: string) => { view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parseNoteHtml(document, html).content).setMeta('track', true)); },
    insertHtml: (html: string) => { view.dispatch(view.state.tr.replaceSelection(parseFragment(html)).scrollIntoView()); view.focus(); },
    insertText: (text: string, range?: { from: number; to: number }) => {
      const slice = new Slice(Fragment.from(lineContent(text)), 0, 0);
      view.dispatch((range ? view.state.tr.replaceRange(range.from, range.to, slice) : view.state.tr.replaceSelection(slice)).scrollIntoView());
    },
    appendParagraphs: (text: string, after?: number) => {
      const $p = after !== undefined ? view.state.doc.resolve(Math.min(after, view.state.doc.content.size)) : null;
      insertBlocksAt($p && $p.depth >= 1 ? $p.after(1) : view.state.doc.content.size, paragraphs(text));
    },
    anchor: () => {
      const ys = ySyncPluginKey.getState(view.state);
      const { from, to } = view.state.selection;
      if (!ys?.binding) return () => ({ from, to });
      const rel = (pos: number) => absolutePositionToRelativePosition(pos, ys.type, ys.binding!.mapping);
      const rf = rel(from), rt = rel(to);
      return () => {
        const now = ySyncPluginKey.getState(view.state);
        if (!now?.binding) return null;
        const a = relativePositionToAbsolutePosition(ydoc, ys.type, rf, now.binding.mapping), b = relativePositionToAbsolutePosition(ydoc, ys.type, rt, now.binding.mapping);
        return a === null || b === null ? null : { from: Math.min(a, b), to: Math.max(a, b) };
      };
    },
    insertParagraphsAt: (text: string, y: number) => {
      const page = o.mount.closest<HTMLElement>('.np-page') ?? o.mount;
      const rect = page.getBoundingClientRect();
      const hit = view.posAtCoords({ left: rect.left + Math.min(40, rect.width / 2), top: rect.top - page.scrollTop + y });
      let pos = view.state.doc.content.size;
      if (hit) { const $p = view.state.doc.resolve(hit.pos); if ($p.depth >= 1) pos = $p.before(1); }
      insertBlocksAt(pos, paragraphs(text));
    },
    replaceRange: (from: number, to: number, text: string) => { view.dispatch(view.state.tr.insertText(text, from, to)); },
    setHighlights: (marks: { from: number; to: number; cls: string }[]) => { view.dispatch(view.state.tr.setMeta(highlightsKey, marks).setMeta('addToHistory', false)); },
    onDocChange: (fn: () => void) => { changeListeners.add(fn); return () => { changeListeners.delete(fn); }; },
    textRuns: () => {
      let text = '';
      const runs: { start: number; end: number; pos: number }[] = [];
      view.state.doc.descendants((node, pos) => {
        if (node.isText) { runs.push({ start: text.length, end: text.length + node.text!.length, pos }); text += node.text; }
        else if (node.isBlock && text && !text.endsWith('\n')) text += '\n';
        return true;
      });
      return { text, posAt: (i: number) => { const r = runs.find((x) => i >= x.start && i <= x.end); return r ? r.pos + (i - r.start) : null; } };
    },
    replaceDomRange: (node: Text, from: number, to: number, id: string, title: string) => {
      const a = view.posAtDOM(node, from), b = view.posAtDOM(node, to);
      const tr = view.state.tr.replaceWith(a, b, [s.text(title, [s.marks.note_link!.create({ id })]), s.text(' ')]);
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, a + title.length + 1)).scrollIntoView());
      view.focus();
    },
    selectionText: () => { const { from, to } = view.state.selection; return view.state.doc.textBetween(from, to, '\n', ''); },
    hasSelection: () => !view.state.selection.empty,
    blockType: () => {
      if (inAncestor(view.state, 'blockquote')) return 'blockquote';
      const parent = view.state.selection.$from.parent;
      if (parent.type === s.nodes.heading) return `h${parent.attrs.level}`;
      if (parent.type === s.nodes.code_block) return 'pre';
      return 'p';
    },
    cmd: (name: string, value?: string) => {
      switch (name) {
        case 'bold': return run(toggleMark(s.marks.strong!));
        case 'italic': return run(toggleMark(s.marks.em!));
        case 'underline': return run(toggleMark(s.marks.underline!));
        case 'strikeThrough': return run(toggleMark(s.marks.strike!));
        case 'subscript': return run(toggleMark(s.marks.sub!));
        case 'superscript': return run(toggleMark(s.marks.sup!));
        case 'insertUnorderedList': return toggleList('bullet_list');
        case 'insertOrderedList': return toggleList('ordered_list');
        case 'formatBlock': return block((value ?? 'p').toLowerCase().replace(/[<>]/g, ''));
        case 'indent': return run(sinkListItem(s.nodes.list_item!));
        case 'outdent': return run(liftListItem(s.nodes.list_item!));
        case 'removeFormat': {
          // Formatting only: links, note links, comments and tracked changes are content, not style.
          const { from, to } = view.state.selection;
          const tr = view.state.tr;
          for (const m of [s.marks.strong, s.marks.em, s.marks.underline, s.marks.strike, s.marks.sub, s.marks.sup, s.marks.code, s.marks.highlight, s.marks.text_style]) tr.removeMark(from, to, m!);
          view.dispatch(tr);
          return;
        }
        case 'undo': return run(undo);
        case 'redo': return run(redo);
        case 'createLink': {
          if (!value) return;
          const { from, to } = view.state.selection;
          view.dispatch(view.state.tr.removeMark(from, to, s.marks.link!).addMark(from, to, s.marks.link!.create({ href: value })));
          return;
        }
        case 'unlink': { const { from, to } = view.state.selection; view.dispatch(view.state.tr.removeMark(from, to, s.marks.link!)); return; }
        case 'insertHTML': return value !== undefined ? editor.insertHtml(value) : undefined;
        default: return;
      }
    },
    removeStrokes: (ids: Set<string>) => {
      ydoc.transact(() => {
        for (let i = ink.length - 1; i >= 0; i--) { const id = ink.get(i)?.id; if (id && ids.has(id)) ink.delete(i, 1); }
      });
    },
    setEditable: (on: boolean) => { readOnly = !on; view.setProps({ editable: () => on }); },
    focus: () => view.focus(),
    destroy: () => {
      view.destroy();
      o.mount.classList.remove('ProseMirror'); // the view leaves its class on the mount; the plain editor's CSS must not inherit it
      // Edits made out of sync live only in this Y.Doc: it and its socket stay until they reach the room (or five minutes).
      const done = () => { provider.destroy(); ydoc.destroy(); };
      if (!editor.pendingLocal || provider.synced) { done(); return; }
      const t = setTimeout(done, 5 * 60_000);
      provider.on('sync', (ok: boolean) => { if (ok) { clearTimeout(t); done(); } });
    },
  });
  return editor;
}
