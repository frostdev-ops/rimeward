import { el } from './dom.ts';
import { prepareWorkspaceNavigation } from './workspace-dialogs.ts';
import { readDesktopState, readDesktopCheckpoint, saveDesktopState } from './desktop-state.ts';

type Permissions = { screen: boolean; input: boolean };
const native = (window as unknown as { __TAURI__?: { core: { invoke<T>(command: string, args: unknown): Promise<T> } } }).__TAURI__?.core;
const entry = document.querySelector<HTMLButtonElement>('#macos-permissions');
if (native && document.querySelector('meta[name="fd-mac-user"]')) {
  const invoke = (action: string) => native.invoke<Permissions>('macos_permissions', { action });
  let dialog: HTMLDialogElement | undefined, busy = false, relaunching = false, raising = false;
  let armed = readDesktopState<boolean>('permission-pending') === true;
  const snapshot = () => saveDesktopState('window', { x: scrollX, y: scrollY });
  const checkpoint = async () => {
    await prepareWorkspaceNavigation();
    snapshot();
    saveDesktopState('permission-dialog', dialog?.open === true);
    await invoke('checkpoint');
    armed = true;
    saveDesktopState('permission-pending', true);
  };
  const saved = readDesktopCheckpoint<{ x: number; y: number }>('window');
  if (armed && saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    window.addEventListener('load', () => requestAnimationFrame(() => scrollTo(saved.x, saved.y)), { once: true });
  }
  if (entry) entry.hidden = false;
  const open = async () => {
    if (dialog?.open) return;
    const d = el('dialog', 'fd-dialog macos-permissions-dialog'); dialog = d;
    d.setAttribute('aria-labelledby', 'macos-permissions-title');
    const heading = el('h2', undefined, 'Set up this Mac'); heading.id = 'macos-permissions-title';
    const message = el('p', 'text-sm text-ink-muted', 'Allow Rimeward to share this Mac’s screen and control its mouse and keyboard. System sound is used only when a viewer selects Listen.');
    const status = el('p', 'text-sm'); status.setAttribute('role', 'status');
    const rows = el('div', 'macos-permission-rows'), footer = el('div', 'flex flex-wrap gap-2');
    const controls: HTMLButtonElement[] = [];
    const action = (label: string, work: () => Promise<unknown>) => {
      const b = el('button', 'btn', label); b.type = 'button'; controls.push(b);
      b.onclick = () => {
        if (busy) return; busy = true; controls.forEach(b => { b.disabled = true; });
        void work().catch(error => { status.textContent = `Could not continue: ${String(error instanceof Error ? error.message : error)}`; })
          .finally(() => { if (!relaunching) { busy = false; controls.forEach(b => { b.disabled = false; }); } });
      };
      return b;
    };
    const values = new Map<string, HTMLElement>();
    const refresh = async () => {
      const permissions = await invoke('status');
      for (const key of ['screen', 'input'] as const) {
        const value = values.get(key);
        if (value) value.textContent = permissions[key] ? 'Allowed' : 'Not allowed in this app session';
      }
      status.textContent = permissions.screen && permissions.input ? 'Permissions are ready. You can connect in view-only mode and choose Take control when needed.' : 'Choose Request access, then enable Rimeward in System Settings. If macOS asks you to quit, your workspace has been saved. Relaunch after changing Screen Recording.';
      await refreshLens();
      return permissions;
    };
    for (const [key, title, description] of [
      ['screen', 'Screen & System Audio Recording', 'Shows your displays and optionally shares system sound. No microphone access is needed.'],
      ['input', 'Accessibility', 'Allows mouse and keyboard input after you grant control.'],
    ] as const) {
      const row = el('section'), state = el('p', 'text-sm text-ink-muted'); values.set(key, state);
      const buttons = el('div', 'flex flex-wrap gap-2');
      buttons.append(action('Request access', async () => { await checkpoint(); await invoke(key); await refresh(); }),
        action('Open System Settings', async () => { await checkpoint(); await invoke(`settings-${key}`); await refresh(); }));
      row.append(el('h3', undefined, title), el('p', 'text-sm text-ink-muted', description), state, buttons); rows.append(row);
    }
    // The Screen lens is a setting rather than a macOS grant, but it is dead without
    // the Screen Recording grant above, so it belongs beside it. /api/dev/lens-consent
    // refuses native-token callers, which is why this page fetches it itself.
    type Lens = { consented: boolean; paused: boolean; state: string; screen: boolean; error: string | null };
    const lensRow = el('section'); lensRow.hidden = true;
    const lensState = el('p', 'text-sm text-ink-muted');
    const lensLabel = el('label', 'switch');
    const lensSwitch = el('input'); lensSwitch.type = 'checkbox'; lensSwitch.setAttribute('role', 'switch');
    lensLabel.append(lensSwitch, document.createTextNode('Let Rime read this screen'));
    lensRow.append(el('h3', undefined, 'Screen lens'),
      el('p', 'text-sm text-ink-muted', 'Rime reads the text of the window in front so it knows what you are looking at. Pixels leave this Mac only when you ask for a crop, and you can pause it from the Screen lens ward.'),
      lensState, lensLabel);
    rows.append(lensRow);
    const lensConsent = async (consented?: boolean) => {
      const response = await fetch('/api/dev/lens-consent', consented === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consented }) });
      const data = await response.json() as Lens & { error?: string };
      if (!response.ok) throw Error(data.error ?? 'Screen lens unavailable.');
      return data;
    };
    const showLens = (data: Lens) => {
      lensRow.hidden = false;
      lensSwitch.checked = data.consented;
      lensState.textContent = !data.consented
        ? 'The screen lens is off. Nothing on this screen is read.'
        : data.screen
          ? `The screen lens is on${data.paused ? ', paused from its ward' : ''} (${data.state}).`
          : 'Waiting for Screen Recording. Choose Request access under Screen & System Audio Recording above, then recheck.';
      if (data.consented && data.error) lensState.textContent += ` ${data.error}`;
    };
    // A runtime without the lens (an ordinary server) answers 403: leave the row hidden.
    const refreshLens = () => lensConsent().then(showLens).catch(() => { lensRow.hidden = true; });
    lensSwitch.onchange = () => {
      const wanted = lensSwitch.checked;
      lensSwitch.disabled = true;
      void lensConsent(wanted).then(showLens)
        .catch(error => {
          lensSwitch.checked = !wanted; // The setting did not move.
          lensState.textContent = String(error instanceof Error ? error.message : error);
        })
        .finally(() => { lensSwitch.disabled = false; });
    };
    const close = el('button', 'btn', 'Done'); close.type = 'button'; close.onclick = () => { if (!busy) d.close(); }; controls.push(close);
    d.oncancel = event => { if (busy) event.preventDefault(); };
    footer.append(action('Recheck permissions', refresh), action('Save & relaunch Rimeward', async () => {
      await checkpoint(); relaunching = true; status.textContent = 'Saved. Closing remote sessions and restarting Rimeward…';
      try { await invoke('relaunch'); } catch (error) { relaunching = false; throw error; }
    }), close);
    d.append(heading, message, rows, status, el('p', 'text-sm text-ink-muted', 'Relaunch keeps your workspace and drafts. Running local commands and remote-control sessions will stop.'), footer); document.body.append(d);
    d.onclose = () => {
      if (raising) { raising = false; d.showModal(); return; }
      d.remove(); dialog = undefined;
    };
    d.showModal();
    try { await refresh(); } catch (error) { status.textContent = String(error); }
  };
  if (entry) entry.onclick = () => { void open(); };
  window.addEventListener('fd:desktop-expanded-restored', () => {
    if (dialog?.open) { raising = true; dialog.close(); }
  });
  document.addEventListener('click', event => { if (event.target instanceof Element && event.target.closest('[data-macos-permissions]')) void open(); });
  window.addEventListener('pagehide', () => { if (armed) snapshot(); });
  // Keep the return page current while System Settings is open. Explicit requests
  // await every recovery write; background checkpoints never interrupt a user.
  window.addEventListener('blur', () => { if (armed && !busy) void checkpoint().catch(() => {}); });
  void invoke('status').then(p => {
    if (entry) entry.textContent = p.screen && p.input ? 'Mac permissions' : 'Set up Mac permissions';
    document.querySelectorAll<HTMLElement>('[data-macos-permissions]').forEach(b => { b.hidden = false; });
    if (readDesktopCheckpoint('permission-dialog') === true || ((!p.screen || !p.input) && !readDesktopState('permission-intro-seen'))) {
      try { saveDesktopState('permission-intro-seen', true); } catch { /* Setup stays available if storage is full. */ }
      void open();
    }
  }).catch(() => { if (entry) entry.hidden = true; });
}
