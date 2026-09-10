import { el, toast } from './dom.ts';
import { bootInstance, readLayout, unbootInstance } from './wards.ts';
import { pageOfCard, showPage } from './pages.ts';
import { popoutWard } from './ward-view.ts';
import { wardTitle } from '../../lib/wards.ts';
import { prepareWorkspaceNavigation } from './workspace-dialogs.ts';
import '../../styles/ward-window.css';

const tauri = (window as Window & { __TAURI__?: {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  window: { getCurrentWindow(): { onCloseRequested(handler: (event: { preventDefault(): void }) => void): Promise<() => void> } };
} }).__TAURI__;
const native = tauri?.core;
const scope = document.querySelector<HTMLElement>('main[data-ward-window-scope]')?.dataset.wardWindowScope;
const channel = typeof BroadcastChannel === 'function' && scope ? new BroadcastChannel(`ward-windows:${scope}:${location.pathname}`) : null;
const away = new Set<string>();
const openWindows = new Set<string>();
const wardIds = (id: string) => [id, ...readLayout().filter(w => w.in === id).map(w => w.i)];
async function flushWard(id: string) {
  const pending: Promise<unknown>[] = [];
  window.dispatchEvent(new CustomEvent('fd:ward-context', { detail: {
    wards: wardIds(id), waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } }));
  await Promise.all(pending);
}
function suspendWard(id: string) {
  if (away.has(id)) return;
  const card = document.querySelector<HTMLElement>(`[data-wd="${CSS.escape(id)}"]`);
  if (!card) return;
  away.add(id);
  for (const ward of wardIds(id)) unbootInstance(ward);
  card.classList.add('wd-window-away');
  const placeholder = el('div', 'wd-window-placeholder');
  const focus = el('button', 'btn text-xs', 'Show window');
  focus.type = 'button';
  focus.onclick = () => void popOutWard(id);
  const back = el('button', 'btn text-xs', 'Bring back');
  back.type = 'button';
  back.onclick = () => {
    channel?.postMessage({ action: 'dock', ward: id });
  };
  placeholder.append(el('span', 'text-xs text-ink-muted', 'Open in its own window'), focus, back);
  card.append(placeholder);
}
function restoreWard(id: string) {
  if (!away.delete(id)) return;
  const card = document.querySelector<HTMLElement>(`[data-wd="${CSS.escape(id)}"]`);
  card?.classList.remove('wd-window-away');
  card?.querySelector(':scope > .wd-window-placeholder')?.remove();
  const ids = new Set(wardIds(id));
  for (const ward of readLayout().filter(w => ids.has(w.i))) bootInstance(ward);
}
channel?.addEventListener('message', event => {
  if (popoutWard) {
    if (event.data?.action === 'query') channel?.postMessage({ action: 'open', ward: popoutWard });
    if (event.data?.action === 'dock' && event.data.ward === popoutWard) void returnToDashboard();
    return;
  }
  if (typeof event.data?.ward !== 'string') return;
  if (!readLayout().some(w => w.i === event.data.ward)) return;
  if (event.data.action === 'open') {
    const id = event.data.ward;
    openWindows.add(id);
    void flushWard(id).then(() => { if (openWindows.has(id)) suspendWard(id); }).catch(error => toast(String(error), undefined, true));
    return;
  }
  if (event.data.action !== 'return' && event.data.action !== 'closed') return;
  openWindows.delete(event.data.ward);
  restoreWard(event.data.ward);
  if (event.data.action === 'closed') return;
  const page = pageOfCard(event.data.ward);
  if (page) showPage(page);
});
channel?.postMessage(popoutWard ? { action: 'open', ward: popoutWard } : { action: 'query' });

export async function popOutWard(id: string): Promise<void> {
  const ward = readLayout().find(w => w.i === id);
  if (!ward) return;
  if (ward.type === 'container' && readLayout().some(w => w.in === id && away.has(w.i))) {
    toast('Bring back this group’s popped-out wards before opening the whole group.');
    return;
  }
  if (document.querySelector('#wd-grid.editing, #wd-grid.wiring')) {
    toast('Finish editing the dashboard before popping out a ward.');
    return;
  }
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('ward', id);
  // Reserve synchronously in the click handler so saving drafts does not trip popup blockers.
  const popup = native ? null : window.open('', `rimeward:${scope}:${location.pathname}:${id}`, 'popup,width=960,height=720,resizable=yes,scrollbars=yes');
  if (!native && !popup) {
    toast('Allow pop-ups for Rimeward to open this ward.', undefined, true);
    return;
  }
  try {
    await flushWard(id);
    if (native) await native.invoke('open_ward_window', { ward: id, title: wardTitle(ward), account: scope });
    else if (popup) {
      // Browsers copy the opener's sessionStorage. A second view must have its own input owner.
      if (popup.location.href === 'about:blank') popup.sessionStorage.removeItem('rimeward-input-owner');
      if (popup.location.href !== url.href) popup.location.replace(url.href);
      popup.focus();
    }
  } catch (error) {
    restoreWard(id);
    if (popup?.location.href === 'about:blank') popup.close();
    toast(error instanceof Error ? error.message : String(error), undefined, true);
  }
}

let closing = false;
async function returnToDashboard(): Promise<void> {
  if (closing || !popoutWard) return;
  closing = true;
  try {
    await prepareWorkspaceNavigation();
    for (const id of wardIds(popoutWard)) unbootInstance(id);
    channel?.postMessage({ action: 'return', ward: popoutWard });
    if (native) await native.invoke('close_ward_window');
    else if (window.opener && !window.opener.closed) {
      window.opener.focus();
      window.close();
    } else {
      const url = new URL(location.href);
      url.searchParams.delete('ward');
      url.hash = `p=${pageOfCard(popoutWard) ?? ''}`;
      location.assign(url.href);
    }
  } catch (error) {
    for (const ward of readLayout()) bootInstance(ward);
    channel?.postMessage({ action: 'open', ward: popoutWard });
    toast(error instanceof Error ? error.message : String(error), undefined, true);
  } finally { closing = false; }
}

document.addEventListener('click', event => {
  const button = (event.target as Element).closest('[data-ward-popout]');
  if (button) {
    event.stopPropagation();
    const id = button.closest<HTMLElement>('[data-wd]')?.dataset.wd;
    if (id) void popOutWard(id);
  }
});
document.getElementById('ward-window-return')?.addEventListener('click', () => void returnToDashboard());
if (popoutWard && tauri) void tauri.window.getCurrentWindow().onCloseRequested(event => {
  event.preventDefault();
  void returnToDashboard();
}).catch(error => toast(String(error), undefined, true));
window.addEventListener('pagehide', () => {
  if (popoutWard) channel?.postMessage({ action: 'closed', ward: popoutWard });
  channel?.close();
}, { once: true });
