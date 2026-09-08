// Explicit UI state only: never serialize forms, credentials or input ownership.
const marker = document.querySelector<HTMLMetaElement>('meta[name="fd-mac-user"]');
const native = !!(window as Window & { __TAURI__?: { core?: unknown } }).__TAURI__?.core;
const account = native && !document.querySelector('meta[name="rimeward-runtime-base"]') ? marker?.content : undefined;
export const restoringDesktop = !!account && marker?.dataset.restore === '1';
const prefix = account ? `rimeward-mac:${account}:` : '';
export function readDesktopState<T>(key: string): T | undefined {
  if (!prefix) return;
  try { return JSON.parse(localStorage.getItem(prefix + key) ?? 'null') ?? undefined; } catch { return; }
}
export function readDesktopCheckpoint<T>(key: string): T | undefined {
  return restoringDesktop ? readDesktopState<T>(key) : undefined;
}
export function saveDesktopState(key: string, value: unknown) {
  if (!prefix) return;
  if (value === undefined) localStorage.removeItem(prefix + key);
  else { const text = JSON.stringify(value); if (localStorage.getItem(prefix + key) !== text) localStorage.setItem(prefix + key, text); }
}
let expanded = readDesktopCheckpoint<string>('expanded');
export function expandedDesktopWard(ward?: string) {
  expanded = ward;
  try { saveDesktopState('expanded', ward); } catch { /* The explicit checkpoint reports storage errors. */ }
}
window.addEventListener('fd:before-workspace-navigation', event => {
  (event as CustomEvent<{ waitUntil(p: Promise<unknown>): void }>).detail.waitUntil(Promise.resolve().then(() => saveDesktopState('expanded', expanded)));
});
export function restoreExpandedWard(ward: string, open: () => void) {
  if (readDesktopCheckpoint('expanded') === ward) requestAnimationFrame(() => {
    open();
    window.dispatchEvent(new Event('fd:desktop-expanded-restored'));
  });
}
document.querySelector('form[action="/api/logout"]')?.addEventListener('submit', () => {
  if (prefix) for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
});
