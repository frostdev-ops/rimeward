// Keep the complete layout in the DOM: routing and layout saves still need it.
export const popoutWard = document.querySelector<HTMLElement>('main[data-popout-ward]')?.dataset.popoutWard;

export function inWardView(id: string): boolean {
  const card = document.querySelector(`[data-wd="${CSS.escape(id)}"]`);
  if (card?.closest('.wd-window-away')) return false;
  if (!popoutWard) return true;
  return !!card?.closest('.wd-popout-root');
}

export function stageWardView(): void {
  if (!popoutWard) return;
  const grid = document.getElementById('wd-grid');
  if (!grid) return;
  for (const card of grid.querySelectorAll('.wd-popout-root, .wd-popout-ancestor')) card.classList.remove('wd-popout-root', 'wd-popout-ancestor');
  const root = grid.querySelector<HTMLElement>(`[data-wd="${CSS.escape(popoutWard)}"]`);
  root?.classList.add('wd-popout-root');
  for (let parent = root?.parentElement?.closest('[data-wd]'); parent; parent = parent.parentElement?.closest('[data-wd]')) parent.classList.add('wd-popout-ancestor');
  for (const card of grid.querySelectorAll<HTMLElement>('[data-wd]')) card.toggleAttribute('data-wd-off', !inWardView(card.dataset.wd ?? '') && !card.classList.contains('wd-popout-ancestor'));
  document.getElementById('ward-window-missing')?.toggleAttribute('hidden', !!root);
  if (root) document.title = `${root.querySelector('[data-wd-title]')?.textContent ?? 'Ward'} — Rimeward`;
}
