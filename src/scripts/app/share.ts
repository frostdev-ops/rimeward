// The Share dialog (components/dashboard/ShareDialog.astro): one ward or page,
// the people who hold it (role, remove), the anyone-with-the-link section. Every
// change goes to /api/share; the server is the judge of what a target may be
// shared as and answers in words the dialog shows as they are.
import { el, getJson, postJson, toast } from './dom.ts';

/** Sharing lives on the server: a desktop app offers it only when joined to one. */
export const canShare = (): boolean => {
  const d = document.getElementById('instance-status')?.dataset;
  return d?.desktop !== '1' || d?.joined === '1';
};

export interface ShareTarget { kind: 'ward' | 'page'; target: string; title: string }
interface ShareRow {
  id: string; kind: string; target: string; role: 'view' | 'edit'; expiresAt: string | null;
  grantee: { id: number; email: string; displayName: string } | null; link: boolean;
}

let current: ShareTarget | null = null;
let bound = false;

export function openShareDialog(t: ShareTarget): void {
  const d = document.getElementById('share-dialog') as HTMLDialogElement | null;
  if (!d) return;
  current = t;
  const q = <T extends HTMLElement>(s: string) => d.querySelector<T>(s)!;
  q('[data-sh-title]').textContent = `Share ${t.title}`;
  q<HTMLInputElement>('[data-sh-email]').value = '';
  q('[data-sh-token]').hidden = true;
  q('[data-sh-token-hint]').hidden = true;
  q('[data-sh-err]').hidden = true;
  if (!bound) bind(d);
  bound = true;
  if (!d.open) d.showModal();
  void load(d);
}

const fail = (d: HTMLDialogElement, message: string) => {
  const err = d.querySelector<HTMLElement>('[data-sh-err]')!;
  err.textContent = message;
  err.hidden = !message;
};
const when = (iso: string | null) => (iso ? `expires ${new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : 'never expires');

async function load(d: HTMLDialogElement): Promise<void> {
  const t = current;
  if (!t) return;
  const { status, data } = await getJson('/api/share');
  if (current !== t) return;
  if (status !== 200) { fail(d, (data as { error?: string })?.error ?? 'Sharing is not available here.'); return; }
  fail(d, '');
  const rows = ((data as { shares: ShareRow[] }).shares ?? []).filter((s) => s.kind === t.kind && s.target === t.target);
  const people = d.querySelector<HTMLElement>('[data-sh-people]')!;
  people.textContent = '';
  for (const s of rows.filter((r) => r.grantee)) {
    const row = el('div', 'flex items-center gap-2 text-sm');
    row.append(el('span', 'flex-1 truncate', s.grantee!.displayName || s.grantee!.email), el('span', 'truncate text-xs text-ink-faint', s.grantee!.displayName ? s.grantee!.email : ''));
    const role = el('select', 'input min-h-0 w-auto py-0.5 text-xs') as HTMLSelectElement;
    role.append(new Option('view', 'view', false, s.role === 'view'), new Option('edit', 'edit', false, s.role === 'edit'));
    role.setAttribute('aria-label', `What ${s.grantee!.email} may do`);
    role.addEventListener('change', async () => {
      const r = await postJson(`/api/share/${s.id}`, { role: role.value }, 'PATCH');
      if (!r.ok) { fail(d, (r.data as { error?: string })?.error ?? 'Could not change that.'); void load(d); }
    });
    const rm = el('button', 'btn min-h-0 px-2 py-0.5 text-xs', '✕') as HTMLButtonElement;
    rm.type = 'button';
    rm.setAttribute('aria-label', `Stop sharing with ${s.grantee!.email}`);
    rm.addEventListener('click', async () => { await fetch(`/api/share/${s.id}`, { method: 'DELETE' }); void load(d); });
    row.append(role, rm);
    people.append(row);
  }
  if (!rows.some((r) => r.grantee)) people.append(el('p', 'text-xs text-ink-faint', 'Not shared with anyone yet.'));

  const links = (data as { links?: boolean }).links !== false;
  d.querySelector<HTMLElement>('[data-sh-links]')!.hidden = !links;
  const off = d.querySelector<HTMLElement>('[data-sh-links-off]')!;
  off.hidden = links;
  off.textContent = 'Public links are turned off for this instance. Sharing stays between accounts.';
  const linkRows = d.querySelector<HTMLElement>('[data-sh-link-rows]')!;
  linkRows.textContent = '';
  for (const s of rows.filter((r) => r.link)) {
    const row = el('div', 'flex items-center gap-2 text-sm');
    row.append(el('span', 'flex-1 truncate', `Link · ${when(s.expiresAt)}`));
    const rm = el('button', 'btn min-h-0 px-2 py-0.5 text-xs', 'Revoke') as HTMLButtonElement;
    rm.type = 'button';
    rm.addEventListener('click', async () => { await fetch(`/api/share/${s.id}`, { method: 'DELETE' }); void load(d); });
    row.append(rm);
    linkRows.append(row);
  }
}

function bind(d: HTMLDialogElement): void {
  const q = <T extends HTMLElement>(s: string) => d.querySelector<T>(s)!;
  q('[data-sh-form]').addEventListener('submit', (e) => e.preventDefault());
  q('[data-sh-close]').addEventListener('click', () => d.close());
  const email = q<HTMLInputElement>('[data-sh-email]');
  const add = async () => {
    const t = current;
    const address = email.value.trim();
    if (!t || !address) return;
    const r = await postJson('/api/share', { kind: t.kind, target: t.target, email: address, role: q<HTMLSelectElement>('[data-sh-role]').value });
    if (!r.ok) { fail(d, (r.data as { error?: string })?.error ?? 'Could not share.'); return; }
    email.value = '';
    toast(`Shared with ${address}.`);
    void load(d);
  };
  q('[data-sh-add]').addEventListener('click', () => void add());
  email.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } });
  q('[data-sh-link]').addEventListener('click', async () => {
    const t = current;
    if (!t) return;
    const r = await postJson('/api/share', { kind: t.kind, target: t.target, expiresIn: Number(q<HTMLSelectElement>('[data-sh-expiry]').value) || 0 });
    const token = (r.data as { token?: string })?.token;
    if (!r.ok || !token) { fail(d, (r.data as { error?: string })?.error ?? 'Could not create a link.'); return; }
    q<HTMLInputElement>('[data-sh-token-url]').value = `${location.origin}/s/${token}`;
    q('[data-sh-token]').hidden = false;
    q('[data-sh-token-hint]').hidden = false;
    void load(d);
  });
  q('[data-sh-copy]').addEventListener('click', async () => {
    const url = q<HTMLInputElement>('[data-sh-token-url]');
    try { await navigator.clipboard.writeText(url.value); toast('Link copied.'); }
    catch { url.select(); toast('Select the link and copy it.', undefined, true); }
  });
}
