// Grammar review over the collaborative editor (note-editor.ts): the same
// Review grammar / Live grammar / Autocorrect controls and issue panel as
// note-proofreading.ts, with issues anchored at document positions and drawn
// as inline highlights instead of CSS Highlight ranges. Any change to the
// document clears the review; live mode re-runs it after a pause.
import { el, postJson, toast } from './dom.ts';
import { menuItem, openMenu } from './menu.ts';
import type { DocumentEditor } from './note-editor.ts';
import '../../styles/note-proofreading.css';

interface Issue { start: number; end: number; original: string; replacements: string[]; message: string; severity: 'error' | 'warning'; autocorrect?: boolean }
interface Anchored { issue: Issue; from: number; to: number }
export interface ProofreadingPmOptions { editor: DocumentEditor; tools: HTMLElement; api(): string | null; onChange(): void }

export function attachProofreadingPm(o: ProofreadingPmOptions): { refresh(): void; destroy(): void } {
  const { editor } = o;
  const group = el('div', 'np-proof-tools np-adv');
  const review = el('button', undefined, 'Review grammar') as HTMLButtonElement; review.type = 'button';
  const automatic = el('input') as HTMLInputElement; automatic.type = 'checkbox'; automatic.setAttribute('aria-label', 'Live grammar review');
  const autocorrect = el('input') as HTMLInputElement; autocorrect.type = 'checkbox'; autocorrect.checked = true; autocorrect.setAttribute('aria-label', 'Autocorrect spelling');
  const liveLabel = el('label', undefined, 'Live grammar'), autoLabel = el('label', undefined, 'Autocorrect');
  liveLabel.prepend(automatic); autoLabel.prepend(autocorrect); group.append(review, liveLabel, autoLabel);
  const panel = el('div', 'np-proof-panel'); panel.hidden = true; panel.setAttribute('aria-live', 'polite');
  o.tools.append(group); o.tools.after(panel);
  let issues: Anchored[] = [], revision = 0, timer = 0, disposed = false, snapshot = '', applying = false;
  const paint = () => editor.setHighlights(issues.map((x) => ({ from: x.from, to: x.to, cls: `np-proof-mark np-proof-mark-${x.issue.severity}` })));
  const clear = () => { issues = []; paint(); panel.replaceChildren(); panel.hidden = true; };
  const textAt = (a: Anchored) => editor.view.state.doc.textBetween(a.from, a.to, ' ');
  const apply = (a: Anchored, replacement: string) => {
    if (editor.textRuns().text !== snapshot || textAt(a) !== a.issue.original) { clear(); return; }
    applying = true;
    try { editor.replaceRange(a.from, a.to, replacement); } finally { applying = false; }
    o.onChange(); changed();
  };
  const check = async () => {
    const api = o.api(); const { text, posAt } = editor.textRuns();
    if (!api || !text.trim() || review.disabled || disposed) return;
    const gen = revision; review.disabled = true; review.textContent = 'Reviewing…';
    try {
      const { ok, data } = await postJson(api, { action: 'proofread', text });
      if (disposed || revision !== gen || editor.textRuns().text !== text) return;
      if (!ok) { toast((data as { error?: string })?.error ?? 'Grammar review failed.', undefined, true); return; }
      snapshot = text;
      issues = [];
      for (const issue of (data as { issues: Issue[] }).issues) {
        if (text.slice(issue.start, issue.end).includes('\n')) continue;
        const from = posAt(issue.start), to = posAt(issue.end);
        if (from === null || to === null || to <= from) continue;
        const a = { issue, from, to };
        if (textAt(a) === issue.original) issues.push(a);
      }
      if (autocorrect.checked) {
        const safe = issues.filter(({ issue }) => issue.autocorrect && issue.replacements[0]).sort((a, b) => b.from - a.from);
        if (safe.length) {
          applying = true;
          try { for (const a of safe) if (textAt(a) === a.issue.original) editor.replaceRange(a.from, a.to, a.issue.replacements[0]!); } finally { applying = false; }
          o.onChange();
          // Positions moved: the review runs again over the corrected text.
          issues = []; snapshot = ''; revision++; clearTimeout(timer); timer = window.setTimeout(() => void check(), 300);
          return;
        }
      }
      paint();
      panel.replaceChildren(); panel.hidden = false;
      if (!issues.length) panel.append(el('span', undefined, 'No grammar issues found.'));
      for (const a of issues) {
        const row = el('div', `np-proof-issue np-proof-${a.issue.severity}`);
        row.append(el('span', undefined, `${a.issue.original}: ${a.issue.message}`));
        for (const replacement of a.issue.replacements) { const b = el('button', 'btn', replacement || 'Delete') as HTMLButtonElement; b.type = 'button'; b.onclick = () => apply(a, replacement); row.append(b); }
        const ignore = el('button', 'btn', 'Ignore') as HTMLButtonElement; ignore.type = 'button';
        ignore.onclick = () => { issues = issues.filter((x) => x !== a); paint(); row.remove(); };
        row.append(ignore); panel.append(row);
      }
    } finally { review.disabled = false; review.textContent = 'Review grammar'; if (!disposed && automatic.checked && revision !== gen && o.api()) { clearTimeout(timer); timer = window.setTimeout(() => void check(), 5000); } }
  };
  function changed() { revision++; clearTimeout(timer); clear(); if (automatic.checked && o.api()) timer = window.setTimeout(() => void check(), 5000); }
  const nativeCorrection = () => { editor.view.dom.spellcheck = true; editor.view.dom.setAttribute('autocorrect', autocorrect.checked ? 'on' : 'off'); editor.view.dom.setAttribute('autocapitalize', autocorrect.checked ? 'sentences' : 'off'); };
  const unsubscribe = editor.onDocChange(() => { if (!applying) changed(); });
  const context = (event: MouseEvent) => {
    if (event.shiftKey || !issues.length) return;
    const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
    const match = at ? issues.find((a) => at.pos >= a.from && at.pos <= a.to) : undefined;
    if (!match) return;
    event.preventDefault(); event.stopImmediatePropagation();
    openMenu(event.clientX, event.clientY, (menu) => {
      menu.append(el('div', 'ctx-label', match.issue.message));
      for (const replacement of match.issue.replacements) menu.append(menuItem('check', replacement || 'Delete', () => apply(match, replacement)));
      menu.append(menuItem('close', 'Ignore suggestion', () => { issues = issues.filter((x) => x !== match); paint(); }));
    });
  };
  review.onclick = () => void check(); automatic.onchange = changed; autocorrect.onchange = nativeCorrection; nativeCorrection();
  editor.view.dom.addEventListener('contextmenu', context, true);
  return {
    refresh: changed,
    destroy() { disposed = true; revision++; clearTimeout(timer); unsubscribe(); if (!editor.view.isDestroyed) editor.setHighlights([]); group.remove(); panel.remove(); editor.view.dom.removeEventListener('contextmenu', context, true); },
  };
}
