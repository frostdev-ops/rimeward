import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { unzipSync, zipSync, type Unzipped } from 'fflate';
import type { BrowserContext } from 'playwright-core';
import { DATA_DIR, repoDir } from '../db.ts';

export const EXTENSION_BYTES = 10 * 1024 * 1024;
const EXPANDED_BYTES = 30 * 1024 * 1024;
const MAX_EXTENSIONS = 20;
const maintenance = new WeakSet<BrowserContext>();
export const extensionMaintenance = (context: BrowserContext): boolean => maintenance.has(context);
export interface BrowserExtension {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  bundled?: boolean;
  popup?: string;
  permissions: string[];
  storage?: { local?: Record<string, unknown>; sync?: Record<string, unknown> };
}
interface Registry { extensions: BrowserExtension[] }

export function extensionRoot(user: number, ward: string): string {
  if (!Number.isSafeInteger(user) || user < 1 || !/^[a-z0-9-]{1,32}$/.test(ward)) throw Error('Invalid browser owner');
  return path.join(process.env.BROWSER_PROFILES ?? path.join(DATA_DIR, 'browser'), String(user), ward, 'rimeward-extensions');
}
function writeRegistry(root: string, value: Registry): void {
  const temp = path.join(root, `${randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, path.join(root, 'registry.json'));
}
function readFiles(dir: string, prefix = ''): Unzipped {
  const files: Unzipped = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, readFiles(path.join(dir, entry.name), name + '/'));
    else if (entry.isFile()) files[name] = fs.readFileSync(path.join(dir, entry.name));
  }
  return files;
}
export function bundledExtension(): Unzipped { return readFiles(path.join(repoDir('assets'), 'browser-extensions/glaze')); }
/** Chromium's extension id for a manifest `key`: the first 32 hex digits of sha256(DER public key), a–p. */
export function extensionIdOf(key: string): string {
  return [...createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
/** Rimeward Stream (assets/browser-extensions/stream): the capture extension every LOCAL
 *  browser loads beside the registry's — not an entry in it, so nobody can disable it,
 *  the ward's extension list never shows it, and Browserbase never receives it. The id
 *  is fixed by the manifest's key; `--allowlisted-extension-id` names it at launch so
 *  tabCapture works without a user gesture (chrome tab_capture_api.cc). */
export const STREAM_EXTENSION = (() => {
  const dir = path.join(repoDir('assets'), 'browser-extensions/stream');
  const id = extensionIdOf((JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { key: string }).key);
  return { dir, id, origin: `chrome-extension://${id}/` };
})();
/** Run `fn` while the context's `page` events are ours, not the ward's (a maintenance
 *  or capture page must never become a tab). */
export async function quiet<T>(context: BrowserContext, fn: () => Promise<T>): Promise<T> {
  maintenance.add(context);
  try { return await fn(); } finally { maintenance.delete(context); }
}

function safeFile(name: string): boolean {
  return name.length <= 240 && !/[\\\x00-\x1f:<>"|?*]/.test(name) && !name.startsWith('/') &&
    name.split('/').every(part => part && part !== '.' && part !== '..' && !part.endsWith('.') && !part.endsWith(' ') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function unpackExtension(data: Uint8Array): Unzipped {
  if (!data.length || data.length > EXTENSION_BYTES) throw Error('Extension ZIP must be at most 10 MB');
  let total = 0, count = 0;
  const names = new Set<string>();
  const files = unzipSync(data, { filter: entry => {
    if (++count > 2000 || (total += entry.originalSize) > EXPANDED_BYTES) throw Error('Extension ZIP expands beyond the 30 MB / 2,000 file limit');
    if (entry.name.endsWith('/')) return false;
    if (!safeFile(entry.name)) throw Error('Extension ZIP contains an unsafe filename');
    if (names.has(entry.name.toLowerCase())) throw Error('Extension ZIP contains duplicate filenames');
    names.add(entry.name.toLowerCase());
    return true;
  } });
  if (Object.values(files).reduce((sum, file) => sum + file.length, 0) > EXPANDED_BYTES) throw Error('Extension ZIP is too large');
  if (!files['manifest.json']) throw Error('ZIP must contain manifest.json at its root');
  return files;
}
function installFiles(root: string, files: Unzipped, bundled = false): BrowserExtension {
  const manifest = JSON.parse(Buffer.from(files['manifest.json'] ?? []).toString('utf8'));
  if (manifest.manifest_version !== 3 || typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 200 ||
      typeof manifest.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) throw Error('A valid Manifest V3 Chrome extension is required');
  // Extensions share Chromium's network boundary. A proxy override would bypass guard.ts.
  const permissions = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? []), ...(manifest.host_permissions ?? []), ...(manifest.optional_host_permissions ?? []), ...(manifest.content_scripts ?? []).flatMap((script: { matches?: string[] }) => script.matches ?? [])];
  if (permissions.some(p => typeof p !== 'string') || permissions.some(p => ['proxy', 'nativeMessaging', 'debugger'].includes(p)))
    throw Error('Extensions requesting proxy, nativeMessaging or debugger access are not supported');
  if (!manifest.key) manifest.key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  if (typeof manifest.key !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(manifest.key)) throw Error('Invalid extension key');
  try { createPublicKey({ key: Buffer.from(manifest.key, 'base64'), format: 'der', type: 'spki' }); }
  catch { throw Error('Invalid extension public key'); }
  const id = extensionIdOf(manifest.key);
  const popup = manifest.options_ui?.page ?? manifest.options_page ?? manifest.action?.default_popup;
  if (popup !== undefined && (typeof popup !== 'string' || !safeFile(popup) || !files[popup])) throw Error('Extension settings page is missing or invalid');
  const dir = path.join(root, id);
  const entry = { id, name: manifest.name, version: manifest.version, enabled: true, bundled, popup, permissions: [...new Set<string>(permissions)] };
  if (fs.existsSync(dir)) {
    if (bundled) return entry;
    throw Error('This extension is already installed. Restart after removing it before installing another version.');
  }
  const temp = path.join(root, randomUUID());
  fs.mkdirSync(temp, { recursive: true });
  try {
    for (const [name, data] of Object.entries({ ...files, 'manifest.json': Buffer.from(JSON.stringify(manifest)), '_rimeward_storage.html': Buffer.from('<!doctype html><title>Extension storage</title>') })) {
      if (!safeFile(name)) throw Error('Unsafe extension filename');
      fs.mkdirSync(path.dirname(path.join(temp, name)), { recursive: true });
      fs.writeFileSync(path.join(temp, name), data);
    }
    fs.renameSync(temp, dir);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  return entry;
}
export function extensionRegistry(user: number, ward: string): Registry {
  const root = extensionRoot(user, ward), file = path.join(root, 'registry.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as Registry;
  fs.mkdirSync(root, { recursive: true });
  const value = { extensions: [installFiles(root, bundledExtension(), true)] };
  writeRegistry(root, value);
  return value;
}
export function installExtension(user: number, ward: string, data: Uint8Array): BrowserExtension {
  const value = extensionRegistry(user, ward), root = extensionRoot(user, ward);
  if (value.extensions.length >= MAX_EXTENSIONS) throw Error('At most 20 extensions per browser');
  const entry = installFiles(root, unpackExtension(data));
  // New uploads are reviewed and enabled explicitly. Glaze alone starts enabled.
  entry.enabled = false;
  value.extensions.push(entry);
  writeRegistry(root, value);
  return entry;
}
export function restoreGlaze(user: number, ward: string): void {
  const value = extensionRegistry(user, ward), root = extensionRoot(user, ward);
  if (value.extensions.some(e => e.bundled)) return;
  if (value.extensions.length >= MAX_EXTENSIONS) throw Error('At most 20 extensions per browser');
  const entry = installFiles(root, bundledExtension(), true);
  entry.enabled = false;
  value.extensions.push(entry);
  writeRegistry(root, value);
}
export function changeExtension(user: number, ward: string, id: unknown, enabled: unknown, remove: boolean, hosted: boolean): void {
  const value = extensionRegistry(user, ward), root = extensionRoot(user, ward);
  const entry = value.extensions.find(e => e.id === id);
  if (!entry) throw Error('Extension not found');
  if (remove) value.extensions = value.extensions.filter(e => e !== entry);
  else {
    if (typeof enabled !== 'boolean') throw Error('Enabled must be true or false');
    if (hosted && enabled && value.extensions.some(e => e !== entry && e.enabled)) throw Error('Browserbase supports one enabled extension. Disable the current extension first.');
    entry.enabled = enabled;
  }
  writeRegistry(root, value);
  // Keep removed files until shutdown: the running browser may still be using them.
}
export function extensionPaths(user: number, ward: string): string[] {
  return extensionRegistry(user, ward).extensions.filter(e => e.enabled).map(e => path.join(extensionRoot(user, ward), e.id));
}
export function extensionZip(user: number, ward: string, id: string): Uint8Array<ArrayBuffer> {
  if (!extensionRegistry(user, ward).extensions.some(e => e.id === id)) throw Error('Extension not found');
  return zipSync(readFiles(path.join(extensionRoot(user, ward), id)), { mtime: new Date(2000, 0, 1) });
}

/** chrome.storage is explicitly retained even when a provider rebuilds its browser profile. */
export async function extensionStorage(context: BrowserContext, user: number, ward: string, restore: boolean): Promise<void> {
  const value = extensionRegistry(user, ward);
  const entries = value.extensions.filter(entry => entry.permissions.includes('storage') && (restore ? entry.enabled && entry.storage : true));
  if (!entries.length) return;
  maintenance.add(context);
  const page = await context.newPage().catch(error => { maintenance.delete(context); throw error; });
  try {
    for (const entry of entries) {
      try { await page.goto(`chrome-extension://${entry.id}/_rimeward_storage.html`, { timeout: 5000, waitUntil: 'domcontentloaded' }); }
      catch (error) { if (restore) throw error; else continue; } // Disabled or removed from this running session.
      for (const storageArea of ['local', 'sync'] as const) {
        if (restore) {
          if (entry.storage?.[storageArea]) await page.evaluate(async ({ area, values }) => {
            const chrome = (globalThis as unknown as { chrome: { storage: Record<string, { set: (values: Record<string, unknown>) => Promise<void> }> } }).chrome;
            await chrome.storage[area]!.set(values);
          }, { area: storageArea, values: entry.storage[storageArea]! });
        } else {
          const data = await page.evaluate(async area => {
            const chrome = (globalThis as unknown as { chrome: { storage: Record<string, { get: (keys: null) => Promise<Record<string, unknown>> }> } }).chrome;
            return chrome.storage[area]!.get(null);
          }, storageArea);
          (entry.storage ??= {})[storageArea] = data;
        }
      }
    }
    if (!restore) {
      const latest = extensionRegistry(user, ward);
      for (const entry of latest.extensions) {
        const storage = value.extensions.find(previous => previous.id === entry.id)?.storage;
        if (storage) entry.storage = storage;
      }
      writeRegistry(extensionRoot(user, ward), latest);
    }
  } finally { await page.close().catch(() => {}); maintenance.delete(context); }
}

export function cleanExtensions(user: number, ward: string): void {
  const value = extensionRegistry(user, ward), root = extensionRoot(user, ward);
  for (const entry of fs.readdirSync(root, { withFileTypes: true }))
    if (entry.isDirectory() && !value.extensions.some(e => e.id === entry.name)) fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
}
