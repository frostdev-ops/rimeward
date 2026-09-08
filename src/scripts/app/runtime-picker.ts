// Connection health is information, never an operating mode.
import { prepareWorkspaceNavigation } from './workspace-dialogs.ts';
import { el, toast } from './dom.ts';
import { icon } from './icon.ts';
import '../../styles/workspaces.css';

type NativeWindow = Window & { __TAURI__?: { core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } } };
const native = (window as NativeWindow).__TAURI__?.core;
const host = document.getElementById('instance-status');
const local = host?.dataset.desktop === '1' || !!document.querySelector('meta[name="rimeward-local"]');
const base = document.querySelector<HTMLMetaElement>('meta[name="rimeward-runtime-base"]')?.content;

async function connections() {
  await prepareWorkspaceNavigation();
  if (native && !local) await native.invoke('open_workspace', { runtime: 'local', screen: 'connections' });
  else location.assign(local ? '/desktop/start?setup=1' : '/devices');
}
document.getElementById('manage-environments')?.addEventListener('click', () => void connections().catch(e => toast((e as Error).message)));

if (native && (!local || base)) {
  // Old bookmarks and app upgrades return to the same authenticated app shell.
  void native.invoke('open_workspace', { runtime: 'local', page: new URLSearchParams(location.hash.slice(1)).get('p') ?? undefined }).catch(() => {});
} else if (host) {
  const label = el('span', 'instance-connection');
  const text = el('span');
  label.append(icon('check'), text);
  host.append(label);
  let busy = false;
  const refresh = async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const response = await fetch('/api/instance', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw Error('Connection unavailable');
      const status = await response.json();
      text.textContent = status.connected ? 'Connected' : 'Working offline';
      label.dataset.offline = String(!status.connected);
      label.title = status.connected ? 'Your workspace is connected. Pages, settings and Rime stay in sync.' : 'Local projects remain available. Changes will reconcile when the connection returns.';
      const project = document.getElementById('dev-open-project');
      if (project) project.hidden = !local && !status.devices?.some((d: { online: boolean }) => d.online);
      window.dispatchEvent(new CustomEvent('fd:instance', { detail: status }));
    } catch {
      text.textContent = 'Reconnecting…';
      label.dataset.offline = 'true';
    } finally { busy = false; }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 15000);
  window.addEventListener('online', () => void refresh());
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
