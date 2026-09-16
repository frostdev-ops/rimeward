import { el, postJson, getJson, toast } from './dom.ts';
import { wireCodexConnect } from '../account-oauth.ts';

// The desktop's provider page: one card per installation, each bound to the identity it was rendered
// against. Nothing here infers a destination — every write carries the card's binding, and the server
// card is reached only over the pairing this desktop already holds.

interface Scope {
  binding: string;
  oauthBinding: string;
  kind: 'runtime' | 'server';
  name: string;
  host?: string;
  codex: { connected: boolean; label: string; pending: boolean };
  keys: { id: string; name: string; hint: string; label: string }[];
  endpoints: { name: string; url: string; label: string }[];
  browserbase: string;
}
interface State {
  runtime: Scope;
  server: Scope | null;
  serverError?: string;
  policy: string;
  options: { id: string; name: string }[];
  pairs: { id: string; name: string; server: string; online: boolean }[];
  primary: string | null;
  designated: boolean;
  connection: { host: string; reachable: boolean; authority: boolean; synced: boolean; error?: string } | null;
}

const root = document.querySelector<HTMLElement>('[data-providers]');
const status = document.getElementById('providers-status')!;
const cards = document.getElementById('providers-cards')!;
const access = document.getElementById('providers-access')!;
const say = (text: string) => { status.textContent = text; };
const guard = (run: Promise<unknown>) => void run.catch((e: Error) => say(e.message));

/** el() with attributes and children — the page is built here rather than duplicated in markup. */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const n = el(tag, cls);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const kid of kids) n.append(kid);
  return n;
}
const text = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, value: string) => el(tag, cls, value);

async function write(body: Record<string, unknown>) {
  const { ok, data } = await postJson('/api/account/provider', body);
  if (!ok) throw new Error((data as { error?: string } | null)?.error ?? 'The change was not applied.');
  say((data as { ok?: string }).ok ?? 'Saved.');
  await load();
}

function field(label: string, hint: string, value: string, onSave: (v: string) => Promise<void>) {
  const input = node('input', 'input min-h-0 w-44 px-2 py-1 text-xs', { type: 'password', autocomplete: 'off', placeholder: value ? 'replace…' : 'paste key…' }) as HTMLInputElement;
  const save = node('button', 'btn min-h-0 px-2 py-1 text-xs', { type: 'button' }, 'Save');
  save.onclick = () => guard(onSave(input.value));
  const row = node('div', 'flex items-center gap-2 border-b border-line py-2', {},
    node('div', 'min-w-0 flex-1', {}, text('p', 'text-sm font-medium', label), text('p', 'truncate text-xs text-ink-muted', value ? `saved: ${value}` : hint)),
    input, save);
  if (value) {
    const clear = node('button', 'btn min-h-0 px-2 py-1 text-xs', { type: 'button' }, 'Clear');
    clear.onclick = () => guard(onSave(''));
    row.append(clear);
  }
  return row;
}

/** One installation's card. `scope.binding` rides every write it makes, so a card rendered against
 *  one connection can never be submitted against another. */
function card(scope: Scope, title: string, subtitle: string) {
  const box = node('section', 'card p-4', {}, text('h2', 'section-title mb-1', title), text('p', 'mb-3 text-xs text-ink-muted', subtitle));
  const send = (body: Record<string, unknown>) => write({ ...body, target: scope.kind, binding: scope.binding });

  const chat = node('div', 'flex items-center justify-between gap-3 border-b border-line py-2', {},
    node('div', '', {}, text('p', 'text-sm font-medium', 'ChatGPT (codex)'),
      text('p', 'text-xs text-ink-muted', scope.codex.connected ? scope.codex.label || 'connected' : scope.codex.pending ? 'sign-in in progress' : 'not connected here')));
  if (scope.codex.connected) {
    const off = node('button', 'btn', { type: 'button' }, 'Disconnect');
    off.onclick = () => guard(send({ action: 'codex-disconnect' }));
    chat.append(off);
  }
  box.append(chat);

  // Its own sign-in card, with its own pending state: a local and a server attempt can run at once
  // and neither adopts the other's callback.
  const connect = node('section', 'space-y-2 border-b border-line py-3', {
    'data-codex-connect': '', 'data-scope': scope.kind, 'data-native': '1',
    'data-destination': scope.kind === 'runtime' ? 'local' : 'server',
    'data-oauth-binding': scope.oauthBinding,
  },
    node('button', 'btn-primary', { type: 'button', 'data-start': '' }, scope.codex.connected ? 'Reconnect ChatGPT' : 'Connect ChatGPT'),
    node('p', 'text-xs', { role: 'status', 'aria-live': 'polite' }, `Signs in to ${title}.`),
    node('a', 'link', { hidden: '', target: '_blank', rel: 'noreferrer', 'data-open': '' }, 'Continue in browser'),
    node('button', 'btn', { type: 'button', hidden: '', 'data-cancel': '' }, 'Cancel'),
    node('form', 'grid gap-2', { hidden: '', 'data-manual': '' },
      text('p', 'text-xs', 'Compatibility sign-in: after authorizing, paste the full localhost callback address here.'),
      node('input', 'input', { name: 'pasted', type: 'text', required: '', autocomplete: 'off', placeholder: 'http://localhost:1455/auth/callback?code=…' }),
      node('button', 'btn', {}, 'Finish sign-in')));
  box.append(connect);

  for (const k of scope.keys) box.append(field(k.name, k.hint, k.label, (value) => send({ action: 'key', provider: k.id, key: value })));
  box.append(field('Browserbase API key', 'browser wards set to run on Browserbase', scope.browserbase, (value) => send({ action: 'browserbase-key', key: value })));

  const eps = node('div', 'py-2', {}, text('p', 'text-sm font-medium', 'OpenAI-compatible endpoints'));
  for (const e of scope.endpoints) {
    const remove = node('button', 'btn min-h-0 px-2 py-1 text-xs', { type: 'button' }, 'Remove');
    remove.onclick = () => guard(send({ action: 'endpoint-remove', name: e.name }));
    eps.append(node('div', 'mt-2 flex items-center gap-2 text-xs', {},
      text('span', 'min-w-0 flex-1 truncate', `${e.name} · ${e.url}${e.label ? ` · key ${e.label}` : ' · no key'}`), remove));
  }
  const name = node('input', 'input min-h-0 w-28 px-2 py-1 text-xs', { placeholder: 'name', 'aria-label': 'Endpoint name' }) as HTMLInputElement;
  const url = node('input', 'input min-h-0 flex-1 px-2 py-1 text-xs', { placeholder: 'https://host/v1', 'aria-label': 'Endpoint base URL' }) as HTMLInputElement;
  const key = node('input', 'input min-h-0 w-40 px-2 py-1 text-xs', { type: 'password', placeholder: 'key (optional)', 'aria-label': 'Endpoint API key', autocomplete: 'off' }) as HTMLInputElement;
  const add = node('button', 'btn min-h-0 px-2 py-1 text-xs', { type: 'button' }, 'Add');
  add.onclick = () => guard(send({ action: 'endpoint-add', name: name.value, url: url.value, key: key.value }));
  eps.append(node('div', 'mt-2 flex flex-wrap items-center gap-2', {}, name, url, key, add));
  box.append(eps);
  return box;
}

function renderAccess(state: State) {
  access.replaceChildren(text('h2', 'section-title mb-1', 'Model access'),
    text('p', 'mb-3 text-xs text-ink-muted',
      'Where this runtime sends the model calls it owns. It does not move where a conversation runs, and it is never synchronized: "this runtime only" would mean a different machine elsewhere.'));
  const select = node('select', 'input') as HTMLSelectElement;
  for (const o of state.options) {
    const option = el('option', '', o.name) as HTMLOptionElement;
    option.value = o.id;
    option.selected = o.id === state.policy;
    select.append(option);
  }
  select.onchange = () => guard(write({ target: 'runtime', binding: state.runtime.binding, action: 'policy', policy: select.value }));
  access.append(node('label', 'block text-xs', {}, 'Preference', select));
  if (state.connection)
    access.append(text('p', 'mt-2 text-xs text-ink-muted',
      `${state.connection.host} · ${!state.connection.reachable ? 'not reachable' : state.connection.authority === false ? 'reachable, but it did not answer as this account — its providers are not used' : 'reachable for model calls'} · dashboard sync ${state.connection.synced ? 'up to date' : 'behind'}${state.connection.error ? ` · ${state.connection.error}` : ''}`));
  if (state.pairs.length > 1 || (state.pairs.length > 0 && !state.primary)) {
    const pick = node('select', 'input') as HTMLSelectElement;
    if (!state.primary) pick.append(el('option', '', 'Choose a server…'));
    for (const p of state.pairs) {
      const option = el('option', '', `${p.name} · ${new URL(p.server).host}`) as HTMLOptionElement;
      option.value = p.id;
      option.selected = p.id === state.primary;
      pick.append(option);
    }
    pick.onchange = () => { if (pick.value) guard(write({ target: 'runtime', binding: state.runtime.binding, action: 'primary', id: pick.value })); };
    access.append(node('label', 'mt-2 block text-xs', {}, 'Designated server for accounts and model access', pick));
    if (!state.primary)
      access.append(text('p', 'banner banner-warn mt-2 text-xs',
        'No server is designated. Removing the previous one does not promote another: choose one before server-side model access resumes.'));
  }
}

let oauthDisposers: (() => void)[] = [];
let loadSequence = 0;
async function load() {
  const sequence = ++loadSequence;
  const { status: code, data } = await getJson('/api/account/provider');
  if (code !== 200 || !data?.runtime) {
    say((data as { error?: string } | null)?.error ?? 'Could not read provider connections.');
    toast('Could not read provider connections.');
    return;
  }
  const state = data as State;
  if (sequence !== loadSequence) return;
  renderAccess(state);
  for (const dispose of oauthDisposers) dispose();
  oauthDisposers = [];
  cards.replaceChildren();
  cards.append(card(state.runtime, `This desktop · ${state.runtime.name}`,
    'Credentials stored on this machine. Used when model access resolves to this runtime.'));
  if (state.server)
    cards.append(card(state.server, `Connected server · ${state.server.host ?? ''}`,
      'Credentials stored on the server, shown as it reports them. Changes are sent over this desktop’s existing pairing.'));
  else if (state.serverError)
    cards.append(node('section', 'card p-4', {}, text('h2', 'section-title mb-1', 'Connected server'),
      text('p', 'banner banner-warn text-xs', state.serverError)));
  for (const host of cards.querySelectorAll<HTMLElement>('[data-codex-connect]'))
    if (!host.dataset.wired) { host.dataset.wired = '1'; oauthDisposers.push(wireCodexConnect(host)); }
}

if (root) {
  (window as unknown as { __rimeProviderRefresh?: () => void }).__rimeProviderRefresh = () => void load();
  void load();
}
