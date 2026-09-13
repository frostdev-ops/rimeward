import { WORKSPACE_CONSUMERS, validateWorkspaceDefinition, workspaceFingerprint, type WorkspaceBinding, type WorkspaceDefinition, type WorkspaceMount } from '../../lib/dev/workspace-contract.ts';
import { CATALOG, pageOf, wardTitle, type PageDef, type WardInstance } from '../../lib/wards.ts';
import type { Project } from '../../lib/dev/types.ts';
import { body, poll, readLayout, RENDERERS } from './wards.ts';
import { currentPage, readPages, showPage } from './pages.ts';
import { dialog } from './workspace-dialogs.ts';
import { el, toast } from './dom.ts';
import { icon } from './icon.ts';
import '../../styles/workspace-ward.css';

interface RuntimeRoot { id: string; name: string; root?: string; path?: string }
interface SshChoice { id: string; name: string; host: string; username: string; port: number; auth: 'agent' | 'key' | 'password'; identityFile?: string; hostFingerprint: string; remembered?: boolean }
interface WorkspaceRuntime { id: string; name: string; kind: string; online: boolean; roots?: RuntimeRoot[]; defaultDirectory?: string; connections?: SshChoice[] }
interface WorkspaceSummary { ward: string; title: string; config: WorkspaceDefinition; fingerprint?: string }
interface Inventory { runtimes: WorkspaceRuntime[]; workspaces: WorkspaceSummary[] }
export interface WorkspaceContext {
  workspace?: WorkspaceSummary | null;
  binding: WorkspaceBinding;
  project: Project;
  status: string;
  error?: string;
  ownerRuntimeId?: string;
  ownerName?: string;
  viewOnly?: boolean;
  newSessionRuntimeId?: string;
  newSessionRuntimeName?: string;
  mounts: (WorkspaceMount & { status?: string; name?: string; runtimeName?: string; hostName?: string; path?: string; error?: string })[];
}
interface MutationResult { layout?: WardInstance[]; pages?: PageDef[]; ward?: string; config?: WorkspaceDefinition }

export async function workspaceApi<T>(value?: Record<string, unknown>, query: Record<string, string> = {}): Promise<T> {
  const response = await fetch(`/api/workspaces?${new URLSearchParams(query)}`, {
    method: value ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(60000),
    ...(value ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) } : {}),
  });
  const result = await response.json().catch(() => { throw Error('Workspace returned an invalid response. Check its connection before retrying.'); });
  if (!response.ok) throw Object.assign(Error(result.error ?? 'Workspace unavailable.'), { status: response.status });
  return result;
}
export const workspaceContext = (ward: string) => workspaceApi<WorkspaceContext>(undefined, { ward });
export const workspaceOperation = <T>(ward: string, operation: string, args: Record<string, unknown>, method: string, owner: string, binding?: WorkspaceBinding, workspaceWard: string | null = null) =>
  workspaceApi<T>({ action: 'dev', ward, operation, args, method, owner, expectedWorkspaceWard: workspaceWard, ...(binding ? { expectedWorkspaceId: binding.workspaceId, expectedRevision: binding.revision, expectedFingerprint: binding.definitionFingerprint } : {}) });

/** Drain editor recovery against the old binding before its location can change. */
export async function flushWorkspaceEditors(wards: string[]): Promise<void> {
  const pending: Promise<unknown>[] = [];
  window.dispatchEvent(new CustomEvent('fd:ward-context', { detail: { wards, waitUntil: (promise: Promise<unknown>) => pending.push(promise) } }));
  await Promise.all(pending);
}

async function applyResult(result: MutationResult): Promise<void> {
  if (result.layout) {
    const { applyWorkspaceLayout } = await import('./edit.ts');
    applyWorkspaceLayout(result.layout, result.pages);
  }
  window.dispatchEvent(new Event('fd:workspace-changed'));
}
const action = (label: string, run: () => unknown) => {
  const b = el('button', 'btn text-xs', label); b.type = 'button';
  b.onclick = () => { void Promise.resolve().then(run).catch(e => toast((e as Error).message, undefined, true)); };
  return b;
};
const field = (label: string, input: HTMLElement) => {
  const row = el('label', 'workspace-field'); row.append(el('span', undefined, label), input); return row;
};
const textInput = (label: string, value = '') => {
  const input = el('input', 'input'); input.value = value; input.setAttribute('aria-label', label); return input;
};

export function showWorkspace(consumer: WardInstance): void {
  if (!consumer.workspace) { void linkWorkspace(consumer); return; }
  const target = readLayout().find(w => w.i === consumer.workspace && w.type === 'workspace');
  if (!target) { void linkWorkspace(consumer); return; }
  showPage(pageOf(target, readPages(), readLayout()));
  document.querySelector<HTMLElement>(`[data-wd="${target.i}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
export function locationChip(ward: WardInstance, context?: WorkspaceContext): HTMLButtonElement {
  const label = ward.workspace ? context?.workspace?.title ?? 'Workspace' : 'Default workspace';
  const chip = action(label, () => showWorkspace(ward));
  chip.className = 'workspace-location'; chip.prepend(icon('folder'));
  chip.title = ward.workspace ? 'Show the connected Workspace ward' : 'This session uses the default folder. Connect a Workspace with a Leyline to choose other folders.';
  return chip;
}

/** A normal select is also the keyboard/touch alternative to drawing a Workspace Leyline. */
export async function linkWorkspace(consumer: WardInstance): Promise<void> {
  const { d, form, actions, error, submit } = dialog(`Workspace · ${wardTitle(consumer)}`);
  submit.textContent = 'Save connection';
  const select = el('select', 'input'); select.setAttribute('aria-label', 'Workspace');
  select.add(new Option('Default folder on the machine starting each new session', ''));
  for (const w of readLayout().filter(w => w.type === 'workspace')) select.add(new Option(wardTitle(w), w.i));
  if (consumer.workspace && !readLayout().some(w => w.i === consumer.workspace)) select.add(new Option('Missing Workspace', consumer.workspace));
  select.value = consumer.workspace ?? '';
  actions.before(field('Workspace Leyline', select), el('p', 'workspace-help', 'One Workspace per ward. Finish active work and resolve unsaved files before changing the connection. Existing sessions keep their original owner.'));
  d.onclose = () => d.remove();
  form.onsubmit = async event => {
    event.preventDefault(); submit.disabled = true; error.hidden = true;
    try {
      await flushWorkspaceEditors([consumer.i]);
      const { workspaceDraft } = await import('./edit.ts');
      await applyResult(await workspaceApi<MutationResult>({ action: 'links', ward: consumer.i, workspace: select.value || null, expectedWorkspace: consumer.workspace ?? null, dashboard: workspaceDraft() }));
      d.close();
    } catch (e) { error.textContent = (e as Error).message; error.hidden = false; }
    finally { submit.disabled = false; }
  };
}

async function registerFolder(runtime: WorkspaceRuntime): Promise<RuntimeRoot | null> {
  const { d, form, actions, error, submit } = dialog(`Folder · ${runtime.name}`);
  const path = textInput('Folder path', runtime.defaultDirectory ?? ''); path.required = true;
  const connection = el('select', 'input'); connection.setAttribute('aria-label', 'Folder location');
  connection.add(new Option(`On ${runtime.name}`, ''));
  for (const ssh of runtime.connections ?? []) connection.add(new Option(`${ssh.name} · SSH ${ssh.host}`, ssh.id));
  const create = el('input'); create.type = 'checkbox';
  const browse = action('Choose folder…', async () => {
    const result = await workspaceApi<{ path: string | null }>({ action: 'folder', runtimeId: runtime.id });
    if (result.path) path.value = result.path;
  });
  connection.onchange = () => { browse.disabled = !!connection.value; path.value = connection.value ? '' : runtime.defaultDirectory ?? ''; };
  actions.before(field('Folder location', connection), field('Folder path', path), browse, field('Create this folder if it does not exist', create));
  submit.textContent = 'Use folder';
  return new Promise(resolve => {
    let result: RuntimeRoot | null = null;
    d.onclose = () => { d.remove(); resolve(result); };
    form.onsubmit = async event => {
      event.preventDefault(); if (!form.reportValidity()) return; submit.disabled = true; error.hidden = true;
      try { result = await workspaceApi<RuntimeRoot>({ action: 'root', runtimeId: runtime.id, root: path.value, create: create.checked, ...(connection.value ? { connection: connection.value } : {}) }); d.close(); }
      catch (e) { error.textContent = (e as Error).message; error.hidden = false; }
      finally { submit.disabled = false; }
    };
  });
}

async function connectSsh(inventory: Inventory): Promise<boolean> {
  const { d, form, actions, error, submit } = dialog('Connect an SSH location');
  const gateway = el('select', 'input'); gateway.setAttribute('aria-label', 'Connect through');
  for (const r of inventory.runtimes.filter(r => r.kind !== 'ssh')) gateway.add(new Option(r.name, r.id));
  const existing = el('select', 'input'); existing.setAttribute('aria-label', 'SSH connection');
  const name = textInput('Connection name'), host = textInput('SSH host'), username = textInput('SSH username'), port = textInput('SSH port', '22'), identity = textInput('Private key path on gateway');
  const auth = el('select', 'input'); auth.setAttribute('aria-label', 'SSH authentication');
  auth.add(new Option('SSH agent', 'agent')); auth.add(new Option('Private key file', 'key')); auth.add(new Option('Password', 'password'));
  const password = textInput('SSH password'), passphrase = textInput('Private key passphrase'); password.type = passphrase.type = 'password'; password.autocomplete = passphrase.autocomplete = 'off';
  const keyRow = field('Private key path on the gateway', identity), passwordRow = field('Password', password), passphraseRow = field('Private key passphrase (optional)', passphrase);
  const remember = el('input'); remember.type = 'checkbox';
  const rememberRow = field('Remember credentials on this gateway for reconnecting', remember);
  const verification = el('div', 'workspace-host-verification'); verification.hidden = true;
  const fingerprint = el('code'), trust = el('input'); trust.type = 'checkbox';
  verification.append(el('p', 'workspace-help', 'Verify this fingerprint through a trusted source for the SSH server before accepting it.'), fingerprint, field('I recognize this server fingerprint', trust));
  let observed = '';
  const authChanged = () => { keyRow.hidden = passphraseRow.hidden = auth.value !== 'key'; passwordRow.hidden = auth.value !== 'password'; rememberRow.hidden = auth.value === 'agent'; identity.required = auth.value === 'key'; password.required = auth.value === 'password'; };
  auth.onchange = authChanged; authChanged();
  const forgetFingerprint = () => { observed = ''; trust.checked = false; verification.hidden = true; submit.textContent = 'Connect'; };
  for (const input of [gateway, host, username, port]) input.addEventListener('change', forgetFingerprint);
  const fillConnections = () => {
    existing.replaceChildren(new Option('New SSH connection', ''));
    for (const connection of inventory.runtimes.find(r => r.id === gateway.value)?.connections ?? []) existing.add(new Option(connection.name || connection.host, connection.id));
    host.disabled = username.disabled = port.disabled = false;
    password.value = passphrase.value = ''; remember.checked = false;
  };
  gateway.addEventListener('change', fillConnections); fillConnections();
  existing.onchange = () => {
    const saved = inventory.runtimes.find(r => r.id === gateway.value)?.connections?.find(c => c.id === existing.value);
    name.value = saved?.name ?? ''; host.value = saved?.host ?? ''; username.value = saved?.username ?? ''; port.value = String(saved?.port ?? 22);
    identity.value = saved?.identityFile ?? ''; auth.value = saved?.auth ?? 'agent'; remember.checked = saved?.remembered ?? false;
    password.value = passphrase.value = ''; observed = saved?.hostFingerprint ?? ''; trust.checked = !!observed; verification.hidden = true;
    host.disabled = username.disabled = port.disabled = !!saved; authChanged(); submit.textContent = saved ? 'Reconnect' : 'Connect';
  };
  host.required = username.required = true; port.type = 'number'; port.min = '1'; port.max = '65535';
  actions.before(field('Connect through', gateway), field('Connection', existing), field('Connection name', name), field('SSH host', host), field('Username', username), field('Port', port), field('Authentication', auth), keyRow, passphraseRow, passwordRow, rememberRow, verification, el('p', 'workspace-help', 'Private keys remain on the gateway. Passwords and passphrases last for this session unless you choose to remember them. To refresh credentials, select the saved connection and enter them again.'));
  submit.textContent = 'Connect';
  return new Promise(resolve => {
    let connected = false; d.onclose = () => { password.value = passphrase.value = ''; d.remove(); resolve(connected); };
    form.onsubmit = async event => {
      event.preventDefault(); if (!form.reportValidity()) return; submit.disabled = true; error.hidden = true;
      try {
        if (observed && !trust.checked) throw Error('Verify and accept the SSH server fingerprint before connecting.');
        const result = await workspaceApi<{ requiresHostVerification?: boolean; hostFingerprint?: string }>({ action: 'ssh', runtimeId: gateway.value, ...(existing.value ? { id: existing.value } : {}), name: name.value, host: host.value, username: username.value, port: Number(port.value), auth: auth.value, remember: auth.value !== 'agent' && remember.checked, ...(auth.value === 'key' ? { identityFile: identity.value, ...(passphrase.value ? { passphrase: passphrase.value } : {}) } : auth.value === 'password' ? { password: password.value } : {}), ...(observed && trust.checked ? { hostFingerprint: observed } : {}) });
        if (result.requiresHostVerification) {
          observed = result.hostFingerprint ?? ''; if (!observed) throw Error('The server did not provide its SSH fingerprint.');
          fingerprint.textContent = observed; verification.hidden = false; trust.checked = false; submit.textContent = 'Accept fingerprint and connect'; trust.focus(); return;
        }
        connected = true; d.close();
      } catch (e) { error.textContent = (e as Error).message; error.hidden = false; }
      finally { submit.disabled = false; }
    };
  });
}

export async function configureWorkspace(existing?: WardInstance, title = '', page = currentPage()): Promise<void> {
  const { d, form, actions, error, submit } = dialog(existing ? 'Configure Workspace' : 'Add Workspace');
  submit.textContent = existing ? 'Save workspace' : 'Add workspace'; submit.disabled = true;
  const name = textInput('Workspace name', existing?.title ?? title); name.maxLength = 60;
  const rows = el('div', 'workspace-mounts');
  actions.before(field('Name', name), el('p', 'workspace-help', 'The primary folder is /. Other folders appear at /name. Select each instruction file explicitly; leaving it blank loads none.'), rows);
  let inventory: Inventory;
  let initial: WorkspaceDefinition | undefined;
  const mounts: { node: HTMLElement; read(): WorkspaceMount }[] = [];
  const drawMount = (saved?: WorkspaceMount) => {
    const primary = saved ? saved.mountPath === '/' : !mounts.length;
    const node = el('fieldset', 'workspace-mount');
    node.append(el('legend', undefined, primary ? 'Primary folder · /' : 'Additional folder'));
    const alias = textInput('Mount path', saved?.mountPath ?? `/folder${mounts.length}`); alias.required = true; alias.disabled = primary;
    const runtime = el('select', 'input'); runtime.setAttribute('aria-label', 'Location');
    for (const r of inventory.runtimes) { const option = new Option(`${r.name}${r.online ? '' : ' · offline'}`, r.id); option.disabled = !r.id; runtime.add(option); }
    if (saved && !inventory.runtimes.some(r => r.id === saved.runtimeId)) runtime.add(new Option('Unavailable location', saved.runtimeId));
    if (saved) runtime.value = saved.runtimeId;
    const root = el('select', 'input'); root.required = true; root.setAttribute('aria-label', 'Folder');
    const fillRoots = (selected = '') => {
      root.replaceChildren(new Option('Choose a folder', ''));
      for (const r of inventory.runtimes.find(r => r.id === runtime.value)?.roots ?? []) root.add(new Option([r.name, r.root ?? r.path].filter(Boolean).join(' · ') || r.id, r.id));
      if (selected && ![...root.options].some(o => o.value === selected)) root.add(new Option('Saved folder · unavailable', selected));
      root.value = selected;
    };
    fillRoots(saved?.rootId); runtime.onchange = () => fillRoots();
    const folder = action('Choose another folder…', async () => {
      const selected = inventory.runtimes.find(r => r.id === runtime.value);
      if (!selected) throw Error('This location is unavailable.');
      const result = await registerFolder(selected); if (!result || !d.open) return;
      selected.roots = [...(selected.roots ?? []).filter(r => r.id !== result.id), result]; fillRoots(result.id);
    });
    const instructions = textInput('Instruction file', saved?.instructionsPath ?? ''); instructions.placeholder = 'AGENTS.md or CLAUDE.md';
    node.append(field('Location', runtime), field('Folder', root), folder, ...(primary ? [] : [field('Mount path', alias)]), field('Instruction file inside this folder (optional)', instructions));
    const item = { node, read: () => ({ id: saved?.id ?? id, mountPath: primary ? '/' : alias.value.trim(), runtimeId: runtime.value, rootId: root.value, ...(instructions.value.trim() ? { instructionsPath: instructions.value.trim() } : {}) }) };
    const id = crypto.randomUUID();
    if (!primary) node.append(action('Remove folder', () => { mounts.splice(mounts.indexOf(item), 1); node.remove(); }));
    mounts.push(item); rows.append(node);
  };
  const more = action('Add folder', () => { if (mounts.length >= 16) throw Error('A Workspace supports up to 16 folders.'); drawMount(); });
  const ssh = action('Connect SSH location…', async () => {
    if (!(await connectSsh(inventory))) return;
    const selections = mounts.map(m => m.read()); inventory = await workspaceApi<Inventory>();
    mounts.splice(0); rows.replaceChildren(); for (const m of selections) drawMount(m);
  });
  more.disabled = ssh.disabled = true; actions.before(more, ssh);
  d.onclose = () => d.remove();
  try {
    inventory = await workspaceApi<Inventory>();
    if (!d.open) return;
    if (existing) initial = validateWorkspaceDefinition(existing.config);
    if (initial) for (const mount of initial.mounts) drawMount(mount); else drawMount();
    submit.disabled = more.disabled = ssh.disabled = false;
  } catch (e) { error.textContent = (e as Error).message; error.hidden = false; }
  form.onsubmit = async event => {
    event.preventDefault(); if (!form.reportValidity()) return; submit.disabled = true; error.hidden = true;
    try {
      if (existing && !initial) throw Error('The Workspace definition could not be loaded. Close this dialog and reconnect.');
      if (existing) await flushWorkspaceEditors(readLayout().filter(w => w.workspace === existing.i).map(w => w.i));
      const definition = validateWorkspaceDefinition({ workspaceId: initial?.workspaceId ?? crypto.randomUUID(), revision: initial?.revision ?? 1, mounts: mounts.map(m => m.read()) });
      const { workspaceDraft } = await import('./edit.ts');
      const result = await workspaceApi<MutationResult>({ action: existing ? 'configure' : 'create', ...(existing && initial ? { ward: existing.i, expectedRevision: initial.revision, expectedFingerprint: workspaceFingerprint(initial) } : { page }), title: name.value, definition, dashboard: workspaceDraft() });
      await applyResult(result); d.close();
    } catch (e) { error.textContent = (e as Error).message; error.hidden = false; }
    finally { submit.disabled = false; }
  };
}

const stops = new Map<string, () => void>();
RENDERERS.workspace = {
  render(w) {
    stops.get(w.i)?.(); const target = body(w.i); if (!target) return;
    const host = el('div', 'workspace-ward'), status = el('p', 'workspace-status', 'Connecting…'), folders = el('div', 'workspace-folders'), links = el('div', 'workspace-links');
    status.setAttribute('role', 'status');
    host.append(status, folders, links, action('Configure workspace', () => configureWorkspace(w)));
    target.replaceChildren(host); let stopped = false, busy = false;
    const refreshLinks = () => {
      links.replaceChildren(el('h3', undefined, 'Connected wards'));
      for (const consumer of readLayout().filter(item => item.workspace === w.i)) links.append(action(`${CATALOG[consumer.type]?.title ?? consumer.type} · ${wardTitle(consumer)}`, () => {
        showPage(pageOf(consumer, readPages(), readLayout())); document.querySelector<HTMLElement>(`[data-wd="${consumer.i}"]`)?.scrollIntoView({ block: 'center' });
      }));
      links.append(action('Connect a ward…', () => {
        const { d, form, actions, submit, error } = dialog('Connect a ward'); submit.textContent = 'Connect';
        const select = el('select', 'input'); select.required = true; select.setAttribute('aria-label', 'Ward');
        select.add(new Option('Choose a ward', ''));
        for (const item of readLayout().filter(item => (WORKSPACE_CONSUMERS as readonly string[]).includes(item.type) && item.workspace !== w.i)) select.add(new Option(wardTitle(item), item.i));
        actions.before(field('Ward', select)); d.onclose = () => d.remove();
        form.onsubmit = async event => {
          event.preventDefault(); if (!form.reportValidity()) return; submit.disabled = true;
          try { const consumer = readLayout().find(item => item.i === select.value); if (!consumer) throw Error('This ward no longer exists.'); await flushWorkspaceEditors([consumer.i]); const { workspaceDraft } = await import('./edit.ts'); await applyResult(await workspaceApi<MutationResult>({ action: 'links', ward: consumer.i, workspace: w.i, expectedWorkspace: consumer.workspace ?? null, dashboard: workspaceDraft() })); d.close(); }
          catch (e) { error.textContent = (e as Error).message; error.hidden = false; }
          finally { submit.disabled = false; }
        };
      }));
      links.append(action('Add linked ward…', () => {
        const { d, form, actions, error, submit } = dialog('Add a linked ward'); submit.textContent = 'Add ward';
        const select = el('select', 'input'); select.setAttribute('aria-label', 'Ward type');
        for (const type of WORKSPACE_CONSUMERS) select.add(new Option(CATALOG[type]?.title ?? type, type));
        actions.before(field('Ward type', select)); d.onclose = () => d.remove();
        form.onsubmit = async event => {
          event.preventDefault(); submit.disabled = true; error.hidden = true;
          try {
            const { workspaceDraft } = await import('./edit.ts'), dashboard = workspaceDraft();
            if (!dashboard) throw Error('Open the dashboard to add a linked ward.');
            const type = select.value, id = `w${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
            dashboard.layout.push({ i: id, type, workspaceVersion: 1, size: CATALOG[type]?.defaultSize ?? '3x3', page: pageOf(w, dashboard.pages, dashboard.layout) });
            await applyResult(await workspaceApi<MutationResult>({ action: 'links', links: [{ ward: id, workspace: w.i, expectedWorkspace: null }], dashboard })); d.close();
          } catch (e) { error.textContent = (e as Error).message; error.hidden = false; }
          finally { submit.disabled = false; }
        };
      }));
    };
    const refresh = async () => {
      if (busy || stopped) return; busy = true;
      try {
        const context = await workspaceContext(w.i); if (stopped) return;
        status.textContent = context.error ?? (context.status === 'available' || context.status === 'ready' ? 'Ready' : context.status === 'partial' ? 'Some folders are unavailable' : context.status);
        host.dataset.status = context.status;
        folders.replaceChildren();
        for (const mount of context.mounts) {
          const row = el('div', 'workspace-folder'); row.dataset.status = mount.status ?? 'available';
          row.append(el('strong', undefined, mount.mountPath), el('span', undefined, mount.name ?? mount.runtimeName ?? mount.runtimeId));
          if (mount.runtimeName || mount.hostName) row.append(el('small', undefined, [...new Set([mount.runtimeName, mount.hostName].filter(Boolean))].join(' · ')));
          if (mount.path) row.title = mount.path;
          if (mount.error || (mount.status && !['available', 'ready'].includes(mount.status))) row.append(el('small', undefined, mount.error ?? mount.status));
          if (mount.instructionsPath) row.append(el('small', undefined, `Instructions: ${mount.instructionsPath}`));
          folders.append(row);
        }
      } catch (e) { if (!stopped) { status.textContent = (e as Error).message; host.dataset.status = 'unavailable'; } }
      finally { busy = false; }
      refreshLinks();
    };
    const change = () => { void refresh(); };
    window.addEventListener('fd:workspace-changed', change); document.addEventListener('fd:layout-saved', refreshLinks);
    const stop = poll(refresh, 15000);
    stops.set(w.i, () => { stopped = true; stop(); window.removeEventListener('fd:workspace-changed', change); document.removeEventListener('fd:layout-saved', refreshLinks); });
  },
  stop(id) { stops.get(id)?.(); stops.delete(id); },
};
