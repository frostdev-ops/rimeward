import { parsePatch, planPatch, type PatchOperation } from '../../lib/dev/patch.ts';
import { resolveWorkspacePath } from '../../lib/dev/workspace-contract.ts';
import { el } from './dom.ts';
import { icon } from './icon.ts';
import { workspaceApi, workspaceContext } from './workspace.ts';

type Line = { kind: 'add' | 'remove' | 'context' | 'gap'; text: string };
interface Receipt { path?: string; to?: string; relativePath?: string; relativeTo?: string; runtimeId?: string; rootId?: string; recovery?: number; hash?: string | null }
interface Options { ward?: string; running?: boolean; error?: string; result?: unknown }
const identities = new WeakMap<HTMLElement, string>();
export const samePatchPreview = (a: HTMLElement, b: HTMLElement) => identities.get(a) === identities.get(b);

/** The patch's context pairs distinguish unchanged lines from replacements without guessing a diff. */
export function patchLines(op: PatchOperation): Line[] {
  if (op.kind === 'delete') return [];
  if (op.kind === 'add') return (op.text ? op.text.slice(0, -1).split('\n') : []).map(text => ({ kind: 'add', text }));
  const lines: Line[] = [];
  for (const hunk of op.hunks) {
    lines.push({ kind: 'gap', text: hunk.anchor ?? (hunk.eof ? 'End of file' : 'Changed section') });
    let before = 0, after = 0;
    for (const [oldIndex, newIndex] of [...hunk.context, [hunk.before.length, hunk.after.length]]) {
      while (before < oldIndex!) lines.push({ kind: 'remove', text: hunk.before[before++]! });
      while (after < newIndex!) lines.push({ kind: 'add', text: hunk.after[after++]! });
      if (before < hunk.before.length) { lines.push({ kind: 'context', text: hunk.before[before++]! }); after++; }
    }
  }
  return lines;
}

/** Group contiguous lines into text spans so expanding a large file doesn't create a node per line. */
function fullFile(text: string, op?: PatchOperation): HTMLPreElement {
  const display = el('pre', 'ag-patch-full-code'); display.tabIndex = 0;
  const append = (kind: Line['kind'], lines: string[]) => {
    if (lines.length) display.append(el('span', `ag-patch-full-${kind}`, lines.map(line => `${kind === 'add' ? '+' : kind === 'remove' ? '−' : ' '} ${line}`).join('\n') + '\n'));
  };
  if (op?.kind === 'update') {
    const plan = planPatch(text, op); let cursor = 0;
    for (const change of plan.replacements) {
      append('context', plan.lines.slice(cursor, change.at));
      const rows = patchLines({ kind: 'update', path: op.path, hunks: [{ before: plan.lines.slice(change.at, change.at + change.before), after: change.after, context: change.context, eof: false }] }).filter(line => line.kind !== 'gap');
      let group: string[] = [], kind: Line['kind'] = 'context';
      for (const row of rows) { if (row.kind !== kind) { append(kind, group); group = []; kind = row.kind; } group.push(row.text); }
      append(kind, group); cursor = change.at + change.before;
    }
    append('context', plan.lines.slice(cursor));
  } else append(op?.kind === 'delete' ? 'remove' : op?.kind === 'add' ? 'add' : 'context', (text.endsWith('\n') ? text.slice(0,-1) : text).split('\n'));
  return display;
}

export function patchPreview(patch: string, options: Options = {}): HTMLElement | null {
  let operations: PatchOperation[];
  try { operations = parsePatch(patch); } catch { return null; }
  const result = options.result && typeof options.result === 'object' ? options.result as { ok?: boolean; uncertain?: boolean; applied?: Receipt[]; workspaceId?: string; error?: string } : undefined;
  const state = options.error || result?.ok === false || result?.uncertain ? 'review' : options.running ? 'running' : result?.ok === true ? 'applied' : 'proposed';
  const root = el('section', 'ag-patch-preview'); root.dataset.state = state;
  identities.set(root, JSON.stringify([patch, options]));
  const title = el('div', 'ag-patch-heading');
  title.append(icon('code'), el('span', undefined, `${operations.length} ${operations.length === 1 ? 'file' : 'files'}`), el('span', 'ag-patch-state', { review: 'Check result', running: 'Applying…', applied: 'Applied', proposed: 'Proposed changes' }[state]));
  root.append(title);
  if (state === 'review') root.append(el('p', 'ag-patch-notice', 'Requested changes below. Some changes may not have been applied; check the execution details.'));
  for (const [index, op] of operations.entries()) {
    const lines = patchLines(op), added = lines.filter(line => line.kind === 'add').length, removed = lines.filter(line => line.kind === 'remove').length;
    const file = el('details', 'ag-patch-file'); file.open = index < 3;
    const header = el('summary'), filename = el('span', 'ag-patch-path', op.kind === 'update' && op.move ? `${op.path} → ${op.move}` : op.path);
    filename.title = filename.textContent ?? '';
    const stats = el('span', 'ag-patch-counts'); stats.title = 'Changed lines included in this patch';
    if (added) stats.append(el('span', 'ag-patch-added', `+${added}`));
    if (removed) stats.append(el('span', 'ag-patch-removed', `−${removed}`));
    header.append(icon('file'), filename, el('span', 'ag-patch-operation', op.kind === 'add' ? 'New' : op.kind === 'delete' ? 'Delete' : op.move ? 'Rename' : 'Edit'), stats);
    const content = el('div', 'ag-patch-content'), scroll = el('div', 'ag-patch-scroll'); scroll.tabIndex = 0; scroll.setAttribute('aria-label', `Requested changes to ${op.path}`);
    const code = el('div', 'ag-patch-code');
    let shown = 0, omitted = false;
    for (const [at, line] of lines.entries()) {
      const nearby = line.kind !== 'context' || lines.slice(Math.max(0, at - 3), at + 4).some(row => row.kind === 'add' || row.kind === 'remove');
      if (!nearby || shown >= 80) { omitted = true; continue; }
      if (omitted) { code.append(el('div', 'ag-patch-gap', '⋯ context omitted')); omitted = false; }
      const row = el('div', `ag-patch-line ag-patch-${line.kind}`);
      const sign = el('span', 'ag-patch-sign', { add: '+', remove: '−', context: ' ', gap: '⋯' }[line.kind]);
      sign.setAttribute('aria-label', { add: 'Added', remove: 'Removed', context: 'Unchanged', gap: 'Section' }[line.kind]);
      row.append(sign, el('span', 'ag-patch-text', line.text.length > 400 ? `${line.text.slice(0,400)}…` : line.text || ' ')); code.append(row); shown++;
    }
    if (omitted) code.append(el('div', 'ag-patch-gap', '⋯ preview shortened · expand for the full file'));
    if (!lines.length) code.append(el('p', 'ag-patch-notice', op.kind === 'delete' ? 'This patch requests deletion of the file.' : op.kind === 'add' ? 'Empty file.' : 'File renamed without content changes.'));
    scroll.append(code); content.append(scroll);
    const expand = el('button', 'ag-patch-expand', 'Expand full file'); expand.type = 'button'; expand.setAttribute('aria-expanded', 'false');
    const full = el('div', 'ag-patch-full'); full.hidden = true;
    const exact = result?.applied?.find(item => item.path?.replace(/^\//, '') === op.path.replace(/^\//, ''));
    const matches = result?.applied?.filter(item => item.path?.endsWith(`/${op.path.replace(/^\//, '')}`)) ?? [];
    const receipt = exact ?? (matches.length === 1 ? matches[0] : undefined);
    let loaded = false;
    expand.onclick = async () => {
      const opening = full.hidden; full.hidden = !opening; expand.setAttribute('aria-expanded', String(opening)); expand.textContent = opening ? 'Collapse full file' : 'Expand full file';
      if (!opening || loaded) return;
      expand.disabled = true; full.replaceChildren(el('p', 'ag-patch-notice', 'Loading file…'));
      try {
        let text: string, label: string, fullOperation: PatchOperation | undefined;
        if (op.kind === 'add') { text = op.text; label = 'Full file in this patch'; fullOperation = op; }
        else {
          if (result?.applied?.length && !receipt) throw Error('This patch does not have a unique full-file source. Inspect its execution details.');
          let runtimeId = receipt?.runtimeId, rootId = receipt?.rootId, path = op.kind === 'update' && op.move && receipt?.recovery === undefined ? op.move : op.path;
          const relative = op.kind === 'update' && op.move && receipt?.recovery === undefined ? receipt?.relativeTo : receipt?.relativePath;
          if (runtimeId && rootId && relative !== undefined) path = relative;
          else if (runtimeId && rootId) {
            // Receipts use virtual paths; strip only the mount that owns this root.
            const context = options.ward ? await workspaceContext(options.ward) : undefined;
            const mount = context?.binding.mounts.find(m => m.rootId === rootId && m.runtimeId === runtimeId);
            if (mount && mount.mountPath !== '/' && path.startsWith(`${mount.mountPath}/`)) path = path.slice(mount.mountPath.length + 1);
            else path = path.replace(/^\//, '');
          } else {
            if (!options.ward) throw Error('Open this conversation in its original workspace to load the file.');
            const context = await workspaceContext(options.ward);
            if (result?.workspaceId && result.workspaceId !== context.binding.workspaceId) throw Error('This ward is now linked to a different workspace.');
            const target = resolveWorkspacePath(context.binding, path); runtimeId = target.runtimeId; rootId = target.rootId; path = target.relativePath;
          }
          const source = await workspaceApi<{ text: string; source: string; hash?: string }>({ action: 'patch-preview', runtimeId, rootId, path, ...(receipt?.recovery === undefined ? {} : { recovery: receipt.recovery }) });
          text = source.text;
          if (source.source === 'original') {
            fullOperation = op;
            label = op.kind === 'delete' ? 'Original file before deletion' : 'Entire file · changes from this edit';
          } else if (state === 'proposed' && options.result === undefined) {
            fullOperation = op; label = 'Entire file · proposed changes to current contents';
          } else label = receipt?.hash === source.hash ? 'Full file · matches this edit' : 'Current file · may differ from this earlier patch';
        }
        const display = fullFile(text, fullOperation); display.setAttribute('aria-label', `Full file: ${op.path}`);
        full.replaceChildren(el('p', 'ag-patch-notice', label), display); loaded = true;
      } catch (error) { full.replaceChildren(el('p', 'ag-patch-notice', (error as Error).message)); expand.textContent = 'Collapse full file'; }
      finally { expand.disabled = false; }
    };
    content.append(expand, full); file.append(header, content); root.append(file);
  }
  return root;
}
