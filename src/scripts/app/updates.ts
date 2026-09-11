// The header's update chip: what is newer than this instance — the server,
// and the desktop app when the page runs inside it — one toast the first time
// a version is seen, and the actions: install, release notes, the policy.
// Server facts come from /api/update; the app's live phase (downloading,
// ready) comes from the app itself through `update_status`.
import { getJson, postJson, toast } from './dom.ts';
import { menuItem, openMenu } from './menu.ts';

interface App { current: string; latest: string | null; available: boolean; url: string | null; notes: string }
interface Job { version: string; done?: number; error?: string; log: string[] }
interface State {
  install: 'desktop' | 'docker' | 'node';
  policy: 'off' | 'notify' | 'install';
  server: App | null;
  desktop: App | null;
  job: Job | null;
  image: string;
}
interface Native {
  current: string;
  version: string | null;
  url: string | null;
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'failed';
  progress: number;
  policy: 'off' | 'notify' | 'download';
  error: string | null;
}

const chip = document.getElementById('update-chip');
const label = chip?.querySelector('span');
const admin = chip?.dataset.admin === '1';
const tauri = (window as Window & { __TAURI__?: { core?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } } }).__TAURI__?.core;
const POLICY: Record<State['policy'], string> = { notify: 'Server updates: notify only', install: 'Server updates: install automatically', off: 'Server updates: off' };
let state: State | null = null;
let native: Native | null = null;

async function refresh(): Promise<void> {
  const r = await getJson('/api/update').catch(() => null);
  if (r?.status === 200) state = r.data as State;
  if (tauri) native = ((await tauri.invoke('update_status').catch(() => null)) as Native | null) ?? native;
  render();
}

function render(): void {
  if (!chip || !label) return;
  const parts: string[] = [];
  if (native?.version) parts.push(native.phase === 'ready' ? `app v${native.version} ready` : native.phase === 'downloading' ? `app v${native.version} ${native.progress}%` : `app v${native.version}`);
  else if (!tauri && state?.desktop?.available) parts.push(`app v${state.desktop.latest}`);
  const job = state?.job && !state.job.done ? state.job : null;
  if (job) parts.push(`installing v${job.version}…`);
  else if (state?.server?.available) parts.push(`server v${state.server.latest}`);
  chip.hidden = !parts.length;
  if (!parts.length) return;
  label.textContent = parts.join(' · ');
  const key = `${native?.version ?? state?.desktop?.latest ?? ''}/${state?.server?.latest ?? ''}`;
  let seen: string | null = null;
  try { seen = localStorage.getItem('fd-update-seen'); } catch {}
  if (seen !== key && !job) {
    try { localStorage.setItem('fd-update-seen', key); } catch {}
    toast(`Update available: ${parts.join(', ')}`, { label: 'Details', fn: () => openActions() });
  }
}

async function act(action: string): Promise<void> {
  try {
    await tauri!.invoke('update_action', { action });
  } catch (e) {
    toast(String(e), undefined, true);
  }
  await refresh();
}
async function post(body: Record<string, unknown>, done: string): Promise<void> {
  const r = await postJson('/api/admin/update', body);
  if (!r.ok) return toast(r.data?.error ?? 'Update request failed', undefined, true);
  state = r.data as State;
  render();
  toast(done);
  if (state.job && !state.job.done) watchJob();
}
let watching = 0;
function watchJob(): void {
  if (watching) return;
  watching = window.setInterval(async () => {
    await refresh();
    const job = state?.job;
    if (!job || job.done) {
      clearInterval(watching);
      watching = 0;
      if (job?.error) toast(`Update failed: ${job.error}`, undefined, true);
    }
  }, 3000);
}

function openActions(x?: number, y?: number): void {
  if (!chip) return;
  const r = chip.getBoundingClientRect();
  openMenu(x ?? r.left, y ?? r.bottom + 4, (m) => {
    if (native?.version) {
      const v = native.version;
      if (native.phase === 'ready') m.append(menuItem('download', `Restart to update to v${v}`, () => void act('install')));
      else if (native.phase === 'downloading' || native.phase === 'installing') m.append(menuItem('download', `App v${v}: ${native!.phase}…`, () => {}));
      else m.append(menuItem('download', `Install app v${v} and restart`, () => void act('install')));
      if (native.url) m.append(menuItem('link', "What's new in the app", () => void act('notes')));
      const auto = native.policy === 'download';
      m.append(menuItem(auto ? 'check' : 'dot', 'Download app updates automatically', () => void act(`policy:${auto ? 'notify' : 'download'}`)));
      if (native.error) m.append(menuItem('info', native.error, () => void act('check')));
    } else if (!tauri && state?.desktop?.available && state.desktop.url) {
      const url = state.desktop.url;
      m.append(menuItem('link', `Download the app v${state.desktop.latest}`, () => window.open(url, '_blank')));
    }
    const s = state?.server;
    if (s?.available) {
      const job = state?.job && !state.job.done ? state.job : null;
      if (job) m.append(menuItem('download', `Installing v${job.version}… ${job.log.at(-1) ?? ''}`, () => {}));
      else if (admin && state!.install === 'node') m.append(menuItem('download', `Install server v${s.latest} and restart`, () => void post({ install: true }, 'Installing — the page reloads when the server is back')));
      else if (admin && state!.install === 'docker') m.append(menuItem('download', `Pull ${state!.image}:${s.latest}`, () => toast('On the host: docker compose pull && docker compose up -d')));
      if (s.url) m.append(menuItem('link', "What's new on the server", () => window.open(s.url!, '_blank')));
      if (admin) for (const p of ['notify', 'install', 'off'] as const) m.append(menuItem(state!.policy === p ? 'check' : 'dot', POLICY[p], () => void post({ policy: p }, POLICY[p])));
    }
  });
}

if (chip) {
  chip.addEventListener('click', (e) => openActions(e.clientX, e.clientY));
  void refresh();
  setInterval(() => void refresh(), tauri ? 60_000 : 10 * 60_000);
}
