// Who is looking at a shared ward: initials chips in the card header, painted
// from `presence` events — the share's own stream inside a share view, the
// owner's stream on their dashboard (lib/shares.ts joinPresence).
import { el } from './dom.ts';
import { readPages } from './pages.ts';

interface Presence { share: string; kind: 'ward' | 'page'; target: string; viewers: string[] }

const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

function cards(d: Presence): HTMLElement[] {
  if (d.kind === 'ward') { const c = document.querySelector<HTMLElement>(`[data-wd="${CSS.escape(d.target)}"]`); return c ? [c] : []; }
  const first = readPages()[0]?.id;
  return [...document.querySelectorAll<HTMLElement>('#wd-grid > [data-wd]')].filter((n) => (n.dataset.page ?? first) === d.target);
}

window.addEventListener('fd:presence', (e) => {
  const d = (e as CustomEvent<Presence>).detail;
  if (!d || !Array.isArray(d.viewers)) return;
  for (const card of cards(d)) {
    const header = card.querySelector(':scope > header');
    if (!header) continue;
    // One chip row per SHARE: a ward share and a page share of the same card each keep their own.
    let box = header.querySelector<HTMLElement>(`.wd-presence[data-share="${CSS.escape(d.share)}"]`);
    if (!d.viewers.length) { box?.remove(); continue; }
    if (!box) { box = el('span', 'wd-presence'); box.dataset.share = d.share; header.querySelector('.wd-status')?.after(box) ?? header.append(box); }
    box.textContent = '';
    box.title = `Viewing: ${d.viewers.join(', ')}`;
    for (const name of d.viewers.slice(0, 5)) box.append(el('span', 'wd-presence-chip', initials(name)));
    if (d.viewers.length > 5) box.append(el('span', 'wd-presence-chip', `+${d.viewers.length - 5}`));
  }
});
