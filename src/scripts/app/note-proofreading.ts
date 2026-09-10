import { el, postJson, toast } from './dom.ts';
import { menuItem, openMenu } from './menu.ts';
import '../../styles/note-proofreading.css';
interface Issue { start: number; end: number; original: string; replacements: string[]; message: string; severity: 'error' | 'warning'; autocorrect?: boolean }
export interface ProofreadingOptions { doc: HTMLElement; tools: HTMLElement; api(): string | null; onChange(): void; replace(range: Range, text: string): void }
export function attachProofreading(o: ProofreadingOptions): { refresh(): void; destroy(): void } {
  const group = el('div', 'np-proof-tools np-adv');
  const review = el('button', undefined, 'Review grammar'); review.type = 'button';
  const automatic = el('input'); automatic.type = 'checkbox'; automatic.setAttribute('aria-label', 'Live grammar review');
  const autocorrect = el('input'); autocorrect.type = 'checkbox'; autocorrect.checked = true; autocorrect.setAttribute('aria-label', 'Autocorrect spelling');
  const liveLabel = el('label', undefined, 'Live grammar'), autoLabel = el('label', undefined, 'Autocorrect');
  liveLabel.prepend(automatic); autoLabel.prepend(autocorrect); group.append(review, liveLabel, autoLabel);
  const panel = el('div', 'np-proof-panel'); panel.hidden = true; panel.setAttribute('aria-live', 'polite');
  o.tools.append(group); o.tools.after(panel);
  const id = crypto.randomUUID().replace(/-/g, '');
  const errorName = `grammar-error-${id}`, warningName = `grammar-warning-${id}`;
  const style = el('style'); style.textContent = `::highlight(${errorName}){text-decoration:underline wavy #ef4444;text-underline-offset:3px}::highlight(${warningName}){text-decoration:underline wavy #eab308;text-underline-offset:3px;background-color:#eab30820}`; document.head.append(style);
  let issues: { issue: Issue; range: Range }[] = [], revision = 0, timer = 0, disposed = false, snapshot = '';
  const clear = () => { issues = []; CSS.highlights?.delete(errorName); CSS.highlights?.delete(warningName); panel.replaceChildren(); panel.hidden = true; };
  function documentText() {
    let text = ''; const runs: { node: Text; start: number; end: number }[] = [];
    const boundary = () => { if (text && !text.endsWith('\n')) text += '\n'; };
    const walk = (node: Node) => {
      if (node instanceof Text) { const start = text.length; text += node.data; runs.push({ node, start, end: text.length }); return; }
      if (!(node instanceof Element)) return;
      if (node.matches('del,pre,code')) { boundary(); return; }
      if (node.matches('br')) { boundary(); return; }
      for (const child of node.childNodes) walk(child);
      if (node.matches('p,div,h1,h2,h3,h4,h5,h6,li,td,th,header,footer,section')) boundary();
    };
    walk(o.doc); return { text, runs };
  }
  const rangeAt = (start: number, end: number): Range | null => {
    const { runs, text } = documentText();
    if (text.slice(start, end).includes('\n')) return null;
    const first = runs.find(run => start >= run.start && start < run.end), last = runs.find(run => end > run.start && end <= run.end);
    if (!first || !last) return null;
    const range = document.createRange(); range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start); return range;
  };
  const apply = (issue: Issue, range: Range, replacement: string) => {
    if (documentText().text !== snapshot || range.toString() !== issue.original) { clear(); return; }
    o.replace(range, replacement); o.onChange(); changed();
  };
  const check = async () => {
    const api = o.api(), text = documentText().text; if (!api || !text.trim() || review.disabled || disposed) return;
    const gen = revision; review.disabled = true; review.textContent = 'Reviewing…';
    try {
      const { ok, data } = await postJson(api, { action: 'proofread', text });
      if (disposed || revision !== gen || documentText().text !== text) return;
      if (!ok) { toast((data as { error?: string })?.error ?? 'Grammar review failed.', undefined, true); return; }
      clear(); snapshot = text;
      for (const issue of (data as { issues: Issue[] }).issues) {
        const range = rangeAt(issue.start, issue.end);
        if (range && range.toString() === issue.original) issues.push({ issue, range });
      }
      if (autocorrect.checked) {
        const safe = issues.filter(({ issue }) => issue.autocorrect && issue.replacements[0]).sort((a, b) => b.issue.start - a.issue.start);
        const remaining = issues.filter(x => !safe.includes(x));
        for (const { issue, range } of safe) if (range.toString() === issue.original) o.replace(range, issue.replacements[0]!);
        if (safe.length) { o.onChange(); snapshot = documentText().text; issues = remaining.filter(x => x.range.toString() === x.issue.original); }
      }
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        CSS.highlights.set(errorName, new Highlight(...issues.filter(x => x.issue.severity === 'error').map(x => x.range)));
        CSS.highlights.set(warningName, new Highlight(...issues.filter(x => x.issue.severity === 'warning').map(x => x.range)));
      }
      panel.hidden = false;
      if (!issues.length) panel.append(el('span', undefined, 'No grammar issues found.'));
      for (const { issue, range } of issues) {
        const row = el('div', `np-proof-issue np-proof-${issue.severity}`);
        row.append(el('span', undefined, `${issue.original}: ${issue.message}`));
        for (const replacement of issue.replacements) { const b = el('button', 'btn', replacement || 'Delete'); b.type = 'button'; b.onclick = () => apply(issue, range, replacement); row.append(b); }
        const ignore = el('button', 'btn', 'Ignore'); ignore.type = 'button'; ignore.onclick = () => { issues = issues.filter(x => x.issue !== issue); CSS.highlights?.get(errorName)?.delete(range); CSS.highlights?.get(warningName)?.delete(range); row.remove(); }; row.append(ignore); panel.append(row);
      }
    } finally { review.disabled = false; review.textContent = 'Review grammar'; if (!disposed && automatic.checked && revision !== gen && o.api()) { clearTimeout(timer); timer = window.setTimeout(() => void check(), 5000); } }
  };
  function changed() { revision++; clearTimeout(timer); clear(); if (automatic.checked && o.api()) timer = window.setTimeout(() => void check(), 5000); }
  const nativeCorrection = () => { o.doc.spellcheck = true; o.doc.setAttribute('autocorrect', autocorrect.checked ? 'on' : 'off'); o.doc.setAttribute('autocapitalize', autocorrect.checked ? 'sentences' : 'off'); };
  const context = (event: MouseEvent) => {
    const match = issues.find(({ range }) => [...range.getClientRects()].some(r => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom));
    if (!match) return;
    event.preventDefault(); event.stopPropagation(); openMenu(event.clientX, event.clientY, menu => {
      menu.append(el('div', 'ctx-label', match.issue.message));
      for (const replacement of match.issue.replacements) menu.append(menuItem('check', replacement || 'Delete', () => apply(match.issue, match.range, replacement)));
      menu.append(menuItem('close', 'Ignore suggestion', () => { CSS.highlights?.get(errorName)?.delete(match.range); CSS.highlights?.get(warningName)?.delete(match.range); issues = issues.filter(x => x !== match); }));
    });
  };
  review.onclick = () => void check(); automatic.onchange = changed; autocorrect.onchange = nativeCorrection; nativeCorrection();
  o.doc.addEventListener('input', changed); o.doc.addEventListener('contextmenu', context);
  return { refresh: changed, destroy() { disposed = true; revision++; clearTimeout(timer); clear(); style.remove(); group.remove(); panel.remove(); o.doc.removeEventListener('input', changed); o.doc.removeEventListener('contextmenu', context); } };
}
