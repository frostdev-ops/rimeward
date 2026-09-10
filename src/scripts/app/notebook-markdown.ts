import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { autocompletion, snippetCompletion, type CompletionContext } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { marked } from 'marked';
import { sanitizeHtml, plainText } from '../../lib/note-text.ts';
import { el, postJson, toast } from './dom.ts';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { menuItem, openMenu } from './menu.ts';
import type { NotebookPageEngine, NotebookPageOptions } from './notebook-page-engine.ts';
import '../../styles/notebook-markdown.css';

const snippets = [
  ['heading', '# ${Heading}', 'Heading'], ['heading2', '## ${Heading}', 'Section heading'],
  ['bold', '**${text}**', 'Bold'], ['italic', '*${text}*', 'Italic'], ['strike', '~~${text}~~', 'Strikethrough'],
  ['link', '[${label}](${https://example.com})', 'Link'], ['image', '![${description}](${https://example.com/image.png})', 'Image'],
  ['code', '```\n${code}\n```', 'Fenced code'], ['quote', '> ${quotation}', 'Block quote'],
  ['task', '- [ ] ${task}', 'Task list'], ['list', '- ${item}', 'Bullet list'],
  ['table', '| ${Column 1} | ${Column 2} |\n| --- | --- |\n| ${Value} | ${Value} |', 'Table'],
  ['rule', '\n---\n', 'Horizontal rule'],
];
function completions(context: CompletionContext) {
  const word = context.matchBefore(/\/?[a-z]*$/i);
  if (!word || (!context.explicit && !word.text.startsWith('/'))) return null;
  return { from: word.from, options: snippets.map(([label, template, detail]) => snippetCompletion(template!, { label: label!, detail, type: 'text' })) };
}
export function createMarkdownPage(options: NotebookPageOptions): NotebookPageEngine {
  const element = el('div', 'nb-markdown');
  const tools = el('div', 'nb-md-tools');
  const mode = el('select', 'input');
  mode.setAttribute('aria-label', 'Markdown layout');
  mode.append(new Option('Source and preview', 'split'), new Option('Source', 'source'), new Option('Preview', 'preview'));
  const download = el('button', 'btn', 'Export .md'); download.type = 'button';
  const review = el('button', 'btn', 'Review grammar'); review.type = 'button';
  tools.append(mode, download, review);
  const panes = el('div', 'nb-md-panes'), source = el('div', 'nb-md-source'), preview = el('div', 'np-doc nb-md-preview');
  preview.setAttribute('aria-label', 'Markdown preview');
  panes.append(source, preview); element.append(tools, panes);
  let loading = false, disposed = false;
  let suggestions: { start: number; end: number; replacements: string[]; message: string }[] = [];
  const render = () => { preview.innerHTML = sanitizeHtml(marked.parse(view.state.doc.toString(), { async: false, gfm: true })); };
  const view = new EditorView({ parent: source, state: EditorState.create({ extensions: [
    basicSetup, markdown({ base: markdownLanguage, codeLanguages: languages }), autocompletion({ override: [completions] }), keymap.of([indentWithTab]),
    EditorView.lineWrapping, EditorView.contentAttributes.of({ 'aria-label': 'Markdown source', spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' }),
    EditorView.updateListener.of(update => { if (update.docChanged) { suggestions = []; queueMicrotask(() => { if (!disposed) view.dispatch(setDiagnostics(view.state, [])); }); render(); if (!loading) options.onChange(); } }),
    EditorView.theme({ '&': { height: '100%', background: 'var(--color-surface)', color: 'var(--color-ink)' }, '.cm-scroller': { overflow: 'auto' }, '.cm-content': { padding: '16px', fontSize: '14px' }, '.cm-gutters': { background: 'var(--color-surface-2)', color: 'var(--color-ink-muted)', border: 'none' }, '&.cm-focused': { outline: 'none' }, '.cm-cursor': { borderLeftColor: 'var(--color-accent)' } }),
  ] }) });
  mode.onchange = () => { element.dataset.mode = mode.value; view.requestMeasure(); };
  review.onclick = async () => {
    const api = options.api?.(), text = view.state.doc.toString(); if (!api || !text.trim() || review.disabled) return;
    review.disabled = true;
    try {
      const { ok, data } = await postJson(api, { action: 'proofread', text });
      if (disposed || view.state.doc.toString() !== text) return;
      if (!ok) { toast((data as { error?: string })?.error ?? 'Grammar review failed.', undefined, true); return; }
      const found = (data as { issues: { start: number; end: number; replacements: string[]; message: string; severity: 'error' | 'warning' }[] }).issues;
      suggestions = found;
      const diagnostics: Diagnostic[] = found.map(issue => ({ from: issue.start, to: issue.end, severity: issue.severity, message: issue.message,
        actions: issue.replacements.map(replacement => ({ name: replacement || 'Delete', apply(editor, from, to) { editor.dispatch({ changes: { from, to, insert: replacement } }); } })) }));
      view.dispatch(setDiagnostics(view.state, diagnostics));
      if (!found.length) toast('No grammar issues found.');
    } finally { review.disabled = false; }
  };
  source.addEventListener('contextmenu', event => {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const issue = suggestions.find(issue => pos !== null && pos >= issue.start && pos <= issue.end); if (!issue) return;
    event.preventDefault(); event.stopPropagation(); openMenu(event.clientX, event.clientY, menu => { menu.append(el('div', 'ctx-label', issue.message));
      for (const replacement of issue.replacements) menu.append(menuItem('check', replacement || 'Delete', () => view.dispatch({ changes: { from: issue.start, to: issue.end, insert: replacement } })));
    });
  });
  download.onclick = () => {
    const url = URL.createObjectURL(new Blob([view.state.doc.toString()], { type: 'text/markdown;charset=utf-8' }));
    const a = el('a'); a.href = url; a.download = 'note.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return { element,
    load(value) { const raw = value as { source?: unknown } | null; if (raw !== null && (typeof raw?.source !== 'string' || raw.source.length > 500_000)) throw Error('This Markdown page is invalid or exceeds 500,000 characters.'); const text = typeof raw?.source === 'string' ? raw.source : ''; loading = true; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); loading = false; render(); },
    serialize: () => ({ source: view.state.doc.toString() }), text: () => plainText(preview.innerHTML),
    focus: () => view.focus(), destroy: () => { disposed = true; view.destroy(); },
  };
}
