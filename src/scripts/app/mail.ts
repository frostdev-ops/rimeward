// Mail: the inbox wards, the reader, and the compose/confirm dialog.
//
// The reader is the point. Clicking a message opens the message — its real
// body, in a sandboxed iframe with no allow-scripts and remote images blocked
// (the viewer, the sanitizer and the image policy are ported from PMA
// Office's /comms/email viewer). Replying is a deliberate second step from
// there, and it still goes through the two-phase confirm the server enforces.
//
// Everything is built with createElement/textContent: subjects, sender names
// and file names are hostile input.

import { icon } from './icon.ts';
import { rowsOf, sizeParts, type MailAccount, type WardInstance } from '../../lib/wards.ts';
import { RENDERERS, body, handled, note } from './wards.ts';
import { el, getJson, postJson } from './dom.ts';

type Account = MailAccount;

/** What the compose header says before the address is known. */
const ACCOUNT_NAME: Record<Account, string> = {
  google: 'Gmail',
  microsoft: 'Outlook',
  zoho: 'Zoho Mail',
  mailbox: 'your mailbox',
};

interface Addr {
  name?: string;
  address?: string;
}
interface MailRow {
  id: string;
  /** Set by the merged (all-accounts) inbox. */
  account?: Account;
  from?: Addr;
  subject?: string;
  snippet?: string;
  at: string;
  unread?: boolean;
  starred?: boolean;
  hasAttachments?: boolean;
}
interface MailView {
  id: string;
  subject: string;
  from: Addr;
  to: Addr[];
  cc: Addr[];
  at: string;
  unread: boolean;
  starred: boolean;
  doc: string;
  text: string;
  blockedImages: boolean;
  attachments: { id: string; name: string; size: number; mime: string }[];
  canModify: boolean;
}

/** The inbox the reader is currently reading, so ↑/↓ and archive-then-next
 *  can walk it and a mutation can repaint the ward that opened it. */
interface Inbox {
  account: Account;
  address: string;
  /** The merged inbox: each linked account's address, keyed by account. */
  addresses?: Partial<Record<Account, string>>;
  rows: MailRow[];
  index: number;
  refresh: () => void;
}

/** The account the reader's CURRENT row belongs to (a merged inbox mixes them). */
const acct = (i: Inbox): Account => i.rows[i.index]?.account ?? i.account;
/** "Me" for a reply: the current row's account address. */
const myAddress = (i: Inbox): string => i.addresses?.[acct(i)] ?? i.address;

// ------------------------------------------------------------ formatting

const displayName = (a?: Addr): string => a?.name || a?.address || '(unknown)';

const initials = (a?: Addr): string =>
  displayName(a)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => (/[a-z0-9]/i.test(w[0] ?? '') ? w[0]!.toUpperCase() : ''))
    .join('') || '@';

/** Today reads as a clock time, anything older as a date — the same glance
 *  rule every mail client uses. */
function when(iso: string, long = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (long) return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fileIcon(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'avif'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'page';
  if (['doc', 'docx', 'rtf', 'txt', 'md'].includes(ext)) return 'note';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'chart';
  if (['zip', '7z', 'rar', 'gz', 'tar'].includes(ext)) return 'archive';
  return 'attach';
}

const fileSize = (b: number): string =>
  !b ? '' : b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

// ------------------------------------------------------------- inbox ward

/** The badge letter a merged row wears. */
const GLYPH: Record<Account, string> = { google: 'G', microsoft: 'O', zoho: 'Z', mailbox: 'M' };

function renderMessages(id: string, account: Account, data: any, refresh: () => void, addresses?: Partial<Record<Account, string>>): void {
  const b = body(id);
  if (!b) return;
  const rows = (data?.messages ?? []) as MailRow[];
  const address = String(data?.address ?? '');
  if (rows.length === 0) {
    note(id, 'Inbox zero.');
  } else {
    b.textContent = '';
    const list = el('ul', 'divide-y divide-line/60');
    rows.forEach((m, i) => {
      const li = el('li', 'group cursor-pointer px-1 py-1.5 hover:bg-surface-2/60');
      li.setAttribute('role', 'button');
      li.tabIndex = 0;

      const top = el('div', 'flex items-baseline gap-1.5');
      // The unread dot carries the state; bold alone reads as noise in a
      // small ward where half the rows are unread.
      const dot = el('span', `mt-1 size-1.5 shrink-0 rounded-full ${m.unread ? 'bg-accent' : 'bg-transparent'}`);
      top.append(dot);
      top.append(el('span', `min-w-0 flex-1 truncate text-xs ${m.unread ? 'font-semibold' : 'text-ink-muted'}`, displayName(m.from)));
      if (addresses && m.account) top.append(el('span', 'shrink-0 text-[10px] text-ink-faint', GLYPH[m.account]));
      if (m.starred) top.append(icon('star', 'shrink-0 text-[10px]', 'Starred'));
      if (m.hasAttachments) top.append(icon('attach', 'shrink-0 text-[10px] text-ink-faint', 'Has attachments'));
      top.append(el('span', 'shrink-0 text-[10px] tabular-nums text-ink-faint', when(m.at)));
      li.append(top);

      li.append(el('div', `truncate pl-3 text-xs ${m.unread ? 'font-medium' : 'text-ink-muted'}`, m.subject || '(no subject)'));
      if (m.snippet) li.append(el('div', 'truncate pl-3 text-[10px] text-ink-faint', m.snippet));

      const open = () => openMessage({ account, address, addresses, rows, index: i, refresh });
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
      list.append(li);
    });
    b.append(list);
  }

  const bar = el('div', 'mt-2 flex items-center gap-2');
  const compose = el('button', 'btn min-h-0 px-2 py-1 text-xs', 'Compose');
  compose.type = 'button';
  compose.addEventListener('click', () => openCompose(account, { from: address }));
  bar.append(compose);
  const unread = rows.filter((m) => m.unread).length;
  if (unread) bar.append(el('span', 'text-[10px] text-ink-faint', `${unread} unread`));
  b.append(bar);
}

/** No mailbox at all: the same connect chip the Agenda and Notion wards show. */
function connectMail(id: string): void {
  const b = body(id);
  if (!b) return;
  b.textContent = '';
  const a = el('a', 'wd-note btn text-xs', 'Connect mail');
  a.setAttribute('href', '/account#accounts');
  b.append(a);
}

const accountOf = (w: WardInstance): Account | 'all' => (w.config?.account as Account | 'all' | undefined) ?? 'all';

/** 1x1: the unread count, per account underneath; a tap opens the fullest inbox. */
async function renderBadge(w: WardInstance, account: Account | 'all'): Promise<void> {
  const { status, data } = await getJson(`/api/mail/unread?account=${account}`);
  if (account !== 'all' ? handled(w.i, account, status) : status === 404) {
    if (account === 'all') connectMail(w.i);
    return;
  }
  const b = body(w.i);
  if (!b) return;
  if (status !== 200) {
    note(w.i, 'Mail unavailable.');
    return;
  }
  const counts = Object.entries((data ?? {}) as Record<string, number>) as [Account, number][];
  const total = counts.reduce((n, [, c]) => n + c, 0);
  b.textContent = '';
  const btn = el('button', 'flex h-full w-full flex-col items-center justify-center gap-0.5 rounded hover:bg-surface-2/60');
  btn.type = 'button';
  btn.append(el('div', `text-2xl font-semibold tabular-nums${total ? '' : ' text-ink-faint'}`, String(total)));
  btn.append(el('div', 'text-[10px] text-ink-faint', counts.map(([a, c]) => `${GLYPH[a]} ${c}`).join(' · ') || 'unread'));
  btn.addEventListener('click', async () => {
    const [best] = [...counts].sort((x, y) => y[1] - x[1])[0] ?? [];
    if (!best) return;
    const res = await getJson(`/api/mail?account=${best}&limit=25`);
    if (res.status !== 200 || !res.data?.messages?.length) return;
    void openMessage({ account: best, address: String(res.data.address ?? ''), rows: res.data.messages, index: 0, refresh: () => void renderBadge(w, account) });
  });
  b.append(btn);
  b.classList.add('flex');
}

async function renderInbox(w: WardInstance): Promise<void> {
  const account = accountOf(w);
  if (sizeParts(w.size)[0] === 1) return renderBadge(w, account);
  // Fill the ward: ~5 messages per grid row, capped at what /api/mail allows.
  const limit = w.config?.unreadOnly ? 25 : Math.min(25, rowsOf(w) * 5);
  const { status, data } = await getJson(`/api/mail?account=${account}&limit=${limit}`);
  if (account !== 'all' ? handled(w.i, account, status) : status === 404) {
    if (account === 'all') connectMail(w.i);
    return;
  }
  if (status !== 200) {
    note(w.i, 'Mail unavailable.');
    return;
  }
  if (w.config?.unreadOnly) data.messages = (data.messages as MailRow[]).filter((m) => m.unread).slice(0, rowsOf(w) * 5);
  renderMessages(w.i, data.account, data, () => void renderInbox(w), account === 'all' ? data.addresses : undefined);
}

// ----------------------------------------------------------- the reader

let inbox: Inbox | null = null;
let current: MailView | null = null;

const dlg = () => document.getElementById('mail-view') as HTMLDialogElement | null;
const part = <T extends HTMLElement>(sel: string): T | null => dlg()?.querySelector<T>(sel) ?? null;

/** `hidden` and `flex` are both display utilities — a leftover `flex` would
 *  win over `hidden`, so they always move together. */
function show(node: HTMLElement, on: boolean): void {
  node.classList.toggle('hidden', !on);
  node.classList.toggle('flex', on);
}

function readerErr(msg: string): void {
  const p = part('[data-mv-err]');
  if (!p) return;
  p.textContent = msg;
  p.classList.toggle('hidden', !msg);
}

/** Size the frame to its content. The sandbox has allow-same-origin and NO
 *  allow-scripts, so nothing inside runs but the parent may still measure it. */
function fitBody(frame: HTMLIFrameElement): void {
  const measure = () => {
    const h = frame.contentDocument?.documentElement?.scrollHeight;
    if (h) frame.style.height = `${Math.min(Math.max(h + 24, 224), 2400)}px`;
  };
  measure();
  setTimeout(measure, 250); // images that were allowed arrive late
  setTimeout(measure, 1200);
}

async function openMessage(next: Inbox, images = false): Promise<void> {
  const dialog = dlg();
  const row = next.rows[next.index];
  if (!dialog || !row) return;
  inbox = next;
  // The old message stays on screen for a beat, but it is no longer the
  // target: every action reads `current`, and a slow load would otherwise
  // archive/star/reply to the message the reader just left.
  current = null;
  if (!dialog.open) dialog.showModal();
  readerErr('');

  // Paint what the list already knows, so the dialog is never blank.
  part('[data-mv-subject]')!.textContent = row.subject || '(no subject)';
  part('[data-mv-avatar]')!.textContent = initials(row.from);
  part('[data-mv-from]')!.textContent = displayName(row.from);
  part('[data-mv-meta]')!.textContent = 'Loading…';
  const frame = part<HTMLIFrameElement>('[data-mv-body]')!;
  frame.removeAttribute('srcdoc');
  frame.style.height = '';
  show(part('[data-mv-attachments]')!, false);
  show(part('[data-mv-images]')!, false);
  part('[data-mv-actions]')!.classList.add('hidden');

  const { status, data } = await getJson(
    `/api/mail/message?account=${acct(next)}&id=${encodeURIComponent(row.id)}${images ? '&images=1' : ''}`
  );
  // A stale response from a message the reader has already moved on from.
  if (inbox !== next || next.rows[next.index]?.id !== row.id) return;
  if (status !== 200) {
    readerErr(status === 409 ? 'Account needs reconnecting (see Account page).' : (data?.error ?? 'Could not load this message.'));
    part('[data-mv-meta]')!.textContent = when(row.at, true);
    return;
  }

  const m = data as MailView;
  current = m;
  part('[data-mv-subject]')!.textContent = m.subject || '(no subject)';
  part('[data-mv-avatar]')!.textContent = initials(m.from);

  const from = part('[data-mv-from]')!;
  from.textContent = '';
  from.append(el('span', 'font-semibold', displayName(m.from)));
  if (m.from.name && m.from.address) from.append(el('span', 'text-ink-faint', ` <${m.from.address}>`));

  const recipients = [
    m.to.length ? `to ${m.to.map(displayName).join(', ')}` : '',
    m.cc.length ? `cc ${m.cc.map(displayName).join(', ')}` : '',
  ].filter(Boolean);
  part('[data-mv-meta]')!.textContent = [when(m.at, true), ...recipients].join(' · ');

  frame.srcdoc = m.doc;
  frame.onload = () => fitBody(frame);

  show(part('[data-mv-images]')!, m.blockedImages);

  const att = part('[data-mv-attachments]')!;
  att.textContent = '';
  show(att, m.attachments.length > 0);
  for (const a of m.attachments) {
    // The name rides the URL so the download saves as the real file name; the
    // route re-sanitizes it rather than trusting what comes back.
    const link = el('a', 'btn min-h-0 max-w-full gap-1 px-2 py-1 text-xs');
    link.href = `/api/mail/attachment?account=${acct(next)}&id=${encodeURIComponent(m.id)}&a=${encodeURIComponent(a.id)}&name=${encodeURIComponent(a.name)}`;
    link.setAttribute('download', a.name);
    link.append(icon(fileIcon(a.name)), el('span', 'min-w-0 truncate', a.name));
    if (a.size) link.append(el('span', 'text-ink-faint', fileSize(a.size)));
    att.append(link);
  }

  part('[data-mv-op="star"]')!.textContent = m.starred ? '★' : '☆';
  part('[data-mv-actions]')!.classList.toggle('hidden', !m.canModify);
  part<HTMLButtonElement>('[data-mv-prev]')!.disabled = next.index === 0;
  part<HTMLButtonElement>('[data-mv-next]')!.disabled = next.index >= next.rows.length - 1;

  // Opening a message is reading it. Best effort — a read-only link just
  // leaves the row bold.
  if (m.unread && m.canModify) {
    void act('read', false).then((ok) => {
      if (!ok) return;
      row.unread = false;
      inbox?.refresh();
    });
  }
}

function step(delta: number): void {
  if (!inbox) return;
  const index = inbox.index + delta;
  if (index < 0 || index >= inbox.rows.length) return;
  void openMessage({ ...inbox, index });
}

/** Runs one mail action. `advance` moves the reader on (archive/trash), which
 *  is what makes triage a single button per message. */
async function act(op: string, advance: boolean): Promise<boolean> {
  if (!inbox || !current) return false;
  const target = inbox;
  const id = current.id;
  const res = await postJson('/api/mail/act', { account: acct(target), id, op });
  // The reader moved on while this was in flight: no error to show, and
  // nothing to advance or toggle — the star/unread handlers key off this.
  if (current?.id !== id) return false;
  if (!res.ok) {
    readerErr(res.data?.error ?? 'That action failed.');
    return false;
  }
  if (!advance) return true;

  // Drop the row locally so ↑/↓ and "next" stay right without a round-trip.
  const rows = target.rows.filter((_, i) => i !== target.index);
  target.refresh();
  if (rows.length === 0) {
    dlg()?.close();
    return true;
  }
  void openMessage({ ...target, rows, index: Math.min(target.index, rows.length - 1) });
  return true;
}

function bootReader(): void {
  const dialog = dlg();
  if (!dialog) return;

  dialog.querySelector('[data-mv-close]')?.addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-mv-prev]')?.addEventListener('click', () => step(-1));
  dialog.querySelector('[data-mv-next]')?.addEventListener('click', () => step(1));
  dialog.querySelector('[data-mv-load-images]')?.addEventListener('click', () => {
    if (inbox) void openMessage(inbox, true);
  });

  for (const btn of dialog.querySelectorAll<HTMLButtonElement>('[data-mv-op]')) {
    btn.addEventListener('click', () => {
      const op = btn.dataset.mvOp!;
      if (op === 'star')
        return void act(current?.starred ? 'unstar' : 'star', false).then((ok) => {
          if (!ok || !current) return;
          current.starred = !current.starred;
          btn.textContent = current.starred ? '★' : '☆';
          inbox?.refresh();
        });
      if (op === 'unread')
        return void act('unread', false).then((ok) => {
          if (!ok) return;
          inbox?.refresh();
          dialog.close();
        });
      void act(op, true);
    });
  }

  dialog.querySelector('[data-mv-reply]')?.addEventListener('click', () => reply(false));
  dialog.querySelector('[data-mv-replyall]')?.addEventListener('click', () => reply(true));
  dialog.querySelector('[data-mv-forward]')?.addEventListener('click', forward);

  // ↑/↓ walk the inbox, as long as the reader isn't in a text field.
  dialog.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.matches('input, textarea')) return;
    if (e.key === 'ArrowUp' || e.key === 'k') step(-1);
    else if (e.key === 'ArrowDown' || e.key === 'j') step(1);
    else return;
    e.preventDefault();
  });
}

// ------------------------------------------------- reply / reply-all / forward

const addrs = (list: Addr[]): string[] => list.map((a) => a.address ?? '').filter(Boolean);

const quote = (m: MailView): string =>
  `\n\nOn ${when(m.at, true)}, ${displayName(m.from)} wrote:\n` +
  m.text
    .split('\n')
    .slice(0, 200)
    .map((line) => `> ${line}`)
    .join('\n');

function reply(all: boolean): void {
  if (!inbox || !current) return;
  const m = current;
  const me = myAddress(inbox).toLowerCase();
  const not = (a: string) => a.toLowerCase() !== me;
  const to = [m.from.address ?? '', ...(all ? addrs(m.to) : [])].filter((a) => a && not(a));
  openCompose(acct(inbox), {
    from: myAddress(inbox),
    inReplyTo: m.id,
    title: all ? 'Reply all' : 'Reply',
    to: [...new Set(to)].join(', '),
    cc: all ? [...new Set(addrs(m.cc).filter(not))].join(', ') : '',
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    body: quote(m),
  });
}

function forward(): void {
  if (!inbox || !current) return;
  const m = current;
  const header = [
    '\n\n---------- Forwarded message ----------',
    `From: ${displayName(m.from)}${m.from.address ? ` <${m.from.address}>` : ''}`,
    `Date: ${when(m.at, true)}`,
    `Subject: ${m.subject}`,
    m.to.length ? `To: ${m.to.map(displayName).join(', ')}` : '',
    '',
    m.text,
  ]
    .filter((l) => l !== '')
    .join('\n');
  // A forward is a new message, not a reply: no inReplyTo, so it doesn't
  // land threaded onto the sender's conversation.
  openCompose(acct(inbox), {
    from: myAddress(inbox),
    title: 'Forward',
    subject: /^fwd:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
    body: header,
  });
}

// ---------------------------------------------------------------- compose

interface ComposeCtx {
  from?: string;
  title?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  inReplyTo?: string;
}

export function openCompose(account: Account, ctx: ComposeCtx = {}): void {
  const dialog = document.getElementById('compose') as HTMLDialogElement | null;
  if (!dialog) return;
  const form = dialog.querySelector('form')!;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement;
  const fields = dialog.querySelector<HTMLElement>('[data-compose-fields]')!;
  const confirm = dialog.querySelector<HTMLElement>('[data-compose-confirm]')!;
  const err = dialog.querySelector<HTMLElement>('[data-compose-err]')!;
  fields.classList.remove('hidden');
  confirm.classList.add('hidden');
  confirm.classList.remove('flex');
  err.classList.add('hidden');

  field('account').value = account;
  field('inReplyTo').value = ctx.inReplyTo ?? '';
  field('to').value = ctx.to ?? '';
  field('cc').value = ctx.cc ?? '';
  field('subject').value = ctx.subject ?? '';
  field('body').value = ctx.body ?? '';
  // Cc opens itself when it already has someone in it (reply-all).
  dialog.querySelector<HTMLDetailsElement>('[data-compose-cc]')!.open = !!ctx.cc;
  dialog.querySelector('#compose-title')!.textContent = ctx.title ?? 'New message';
  dialog.querySelector<HTMLElement>('[data-compose-from]')!.textContent =
    `From ${ctx.from || ACCOUNT_NAME[account]}`;

  // The reader stays open underneath — a reply is a step inside reading, and
  // closing it would lose the message being answered.
  if (!dialog.open) dialog.showModal();
  const bodyField = field('body') as HTMLTextAreaElement;
  bodyField.focus();
  bodyField.setSelectionRange(0, 0); // cursor above the quote, not below it
  bodyField.scrollTop = 0;
}

function bootCompose(): void {
  const dialog = document.getElementById('compose') as HTMLDialogElement | null;
  if (!dialog) return;
  const form = dialog.querySelector('form')!;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement;
  const fields = dialog.querySelector<HTMLElement>('[data-compose-fields]')!;
  const confirm = dialog.querySelector<HTMLElement>('[data-compose-confirm]')!;
  const err = dialog.querySelector<HTMLElement>('[data-compose-err]')!;
  let draftId: string | null = null;

  const showErr = (msg: string) => {
    err.textContent = msg;
    err.classList.remove('hidden');
  };
  const list = (name: string) =>
    field(name)
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  dialog.querySelector('[data-compose-close]')?.addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-compose-back]')?.addEventListener('click', () => {
    confirm.classList.add('hidden');
    confirm.classList.remove('flex');
    fields.classList.remove('hidden');
  });

  dialog.querySelector('[data-compose-review]')?.addEventListener('click', async () => {
    err.classList.add('hidden');
    const payload = {
      account: field('account').value,
      to: list('to'),
      cc: list('cc'),
      subject: field('subject').value,
      body: field('body').value,
      inReplyTo: field('inReplyTo').value || undefined,
    };
    if (payload.to.length === 0 || !payload.body.trim()) {
      showErr('Recipient and message are required.');
      return;
    }
    const { ok, data } = await postJson('/api/mail/draft', payload);
    if (!ok) {
      showErr(data?.error === 'reconnect' ? 'Account needs reconnecting (see Account page).' : (data?.error ?? 'Draft failed.'));
      return;
    }
    draftId = data.draftId;
    const p = data.preview;
    dialog.querySelector<HTMLElement>('[data-preview-line]')!.textContent =
      `${p.isReply ? 'Reply' : 'Mail'} from ${p.from} to ${p.to.join(', ')}${p.cc?.length ? ` (cc ${p.cc.join(', ')})` : ''} — “${p.subject || '(no subject)'}”`;
    fields.classList.add('hidden');
    confirm.classList.remove('hidden');
    confirm.classList.add('flex');
  });

  dialog.querySelector('[data-compose-send]')?.addEventListener('click', async (e) => {
    if (!draftId) return;
    const btn = e.currentTarget as HTMLButtonElement;
    btn.dataset.busy = '1';
    const res = await postJson('/api/mail/send', { draftId });
    delete btn.dataset.busy;
    if (!res.ok) {
      showErr(res.data?.error ?? 'Send failed.');
      return;
    }
    draftId = null;
    dialog.close();
    inbox?.refresh();
  });
}

// --------------------------------------------------------------- registry

// Poll, not SSE: mail has no push. (A mailbox account is a real IMAP/POP
// connection per miss; the server's 60s cache keeps that to one per poll.)
RENDERERS.mail = { intervalMs: 5 * 60_000, render: renderInbox };

bootCompose();
bootReader();
