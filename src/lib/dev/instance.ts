import { createHash } from 'node:crypto';
import { getDb } from '../db.ts';
import { getDashboard, getPages, saveDashboard } from '../dashboard.ts';
import { getSetting, setSetting } from '../settings.ts';
import { TARGETS, GROUP_TITLES } from '../targets.ts';
import { parseTheme } from '../theme.ts';
import { DEFAULT_LAYOUT, DEFAULT_PAGES, pageOf, validateLayout, validatePages, type PageDef, type WardInstance } from '../wards.ts';
import { isDesktop, workDb } from './runtime.ts';

export const INSTANCE_KEY = 'instance/dashboard';
export interface InstanceDashboard {
  layout: WardInstance[];
  pages: PageDef[];
  theme: string | null;
  name: string;
  catalog?: { targets: { id: string; label: string; group: string }[]; titles: Record<string, string> };
}
export function instanceDashboard(user: number): InstanceDashboard {
  const profile = getDb().prepare('SELECT theme,display_name,email FROM users WHERE id=?').get(user) as { theme: string | null; display_name: string; email: string };
  const catalog = isDesktop() ? JSON.parse(getSetting(`instance:catalog:${user}`) ?? 'null') : { targets: TARGETS.map(({ id, label, group }) => ({ id, label, group })), titles: GROUP_TITLES };
  return validateInstance({ ...(catalog ? { catalog } : {}), layout: getDashboard(user), pages: getPages(user), theme: profile.theme,
    name: getSetting(`instance:name:${user}`) ?? (profile.display_name || profile.email.split('@')[0] || 'Rimeward') });
}
/** Uploaded images have account-local filenames; the shared identity is their content hash. */
export function dashboardForSync(user: number) {
  const value = instanceDashboard(user);
  if (value.theme) {
    const theme = JSON.parse(value.theme);
    for (const key of ['bgImage', 'brandLogo']) if (theme[key]) theme[key] = theme[key].replace(/^\d+-/, '0-');
    value.theme = JSON.stringify(theme);
  }
  return value;
}
export function validateInstance(value: unknown): InstanceDashboard {
  const data = value as InstanceDashboard | null;
  const pages = validatePages(data?.pages), layout = pages && validateLayout(data?.layout, pages);
  if (!data || !pages || !layout || (data.theme !== null && typeof data.theme !== 'string') ||
    typeof data.name !== 'string' || data.name.length > 120) throw Error('Invalid shared dashboard.');
  const theme = data.theme === null ? null : parseTheme(data.theme);
  if (data.theme !== null && !theme) throw Error('Invalid shared theme.');
  let catalog: InstanceDashboard['catalog'];
  if (data.catalog) {
    const { targets, titles } = data.catalog;
    if (!Array.isArray(targets) || targets.length > 1000 || !titles || typeof titles !== 'object' || Array.isArray(titles)) throw Error('Invalid monitor catalog.');
    catalog = { targets: targets.map(t => {
      if (!t || typeof t.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(t.id) || typeof t.label !== 'string' || t.label.length > 120 || typeof t.group !== 'string' || t.group.length > 80) throw Error('Invalid monitor reference.');
      return { id: t.id, label: t.label, group: t.group };
    }), titles: Object.fromEntries(Object.entries(titles).filter(([k,v]) => k.length <= 80 && typeof v === 'string' && v.length <= 120)) };
  }
  return { pages, layout, theme: theme ? JSON.stringify(theme) : null, name: data.name, ...(catalog ? { catalog } : {}) };
}
export function installInstance(user: number, raw: unknown) {
  const value = validateInstance(raw);
  if (value.theme) {
    const theme = JSON.parse(value.theme);
    for (const key of ['bgImage', 'brandLogo']) if (theme[key]) theme[key] = theme[key].replace(/^\d+-/, `${user}-`);
    value.theme = JSON.stringify(theme);
  }
  getDb().transaction(() => {
    saveDashboard(user, value.layout, value.pages);
    getDb().prepare('UPDATE users SET theme=? WHERE id=?').run(value.theme, user);
    if (isDesktop()) {
      setSetting(`instance:name:${user}`, value.name);
      if (value.catalog) setSetting(`instance:catalog:${user}`, JSON.stringify(value.catalog));
    }
  })();
}

/** Join once: the server supplies Home; preserve custom desktop wards and every project. */
export function mergeInstance(server: InstanceDashboard, local: InstanceDashboard, device: string, keep = new Set<string>()) {
  server = validateInstance(server);
  local = validateInstance(local);
  const pages = [...server.pages], layout = [...server.layout];
  const wardIds = new Map<string, string>(), pageIds = new Map<string, string>();
  const stable = (kind: string, id: string) => `d${createHash('sha256').update(`${device}:${kind}:${id}`).digest('hex').slice(0, 24)}`;
  const defaults = validateLayout(DEFAULT_LAYOUT, DEFAULT_PAGES) ?? DEFAULT_LAYOUT;
  const imported = local.layout.filter(w => {
    const original = defaults.find(d => d.i === w.i);
    return keep.has(w.i) || w.page || w.device || !original || JSON.stringify(w) !== JSON.stringify(original);
  });
  for (const w of imported) wardIds.set(w.i, layout.some(s => s.i === w.i) ? stable('ward', w.i) : w.i);
  for (const page of local.pages) {
    if (!imported.some(w => pageOf(w, local.pages, local.layout) === page.id)) continue;
    const collision = pages.some(p => p.id === page.id);
    const id = collision ? stable('page', page.id) : page.id;
    pageIds.set(page.id, id);
    pages.push({ ...page, id, device, title: collision && page.title === 'Home' ? 'Personal' : page.title });
  }
  for (const w of imported) layout.push({ ...w, i: wardIds.get(w.i) ?? w.i, device: w.type === 'remote-desktop' ? w.device : device,
    page: pageIds.get(pageOf(w, local.pages, local.layout)), ...(w.in ? { in: wardIds.get(w.in) } : {}) });
  return { dashboard: validateInstance({ ...server, pages, layout }), wardIds };
}

/** Re-key existing local content only when a pre-pairing ward id collides. */
export async function moveLocalWardState(user: number, ids: Map<string, string>) {
  const db = getDb();
  for (const [before, after] of ids) {
    if (before === after) continue;
    const { rekeySession } = await import('../browser/session.ts');
    await rekeySession(user, before, after);
    for (const table of ['notes', 'timers', 'packets', 'agent_conversations', 'agent_wakes', 'agent_inbox', 'comms_messages', 'agent_tasks', 'agent_jobs']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some(c => c.name === 'user_id')) continue;
      for (const field of ['ward', 'tile', 'sender']) if (columns.some(c => c.name === field))
        db.prepare(`UPDATE ${table} SET ${field}=? WHERE user_id=? AND ${field}=?`).run(after, user, before);
    }
    if (isDesktop()) workDb().prepare('UPDATE ward_state SET ward=? WHERE user_id=? AND ward=?').run(after, user, before);
    for (const prefix of ['comms_token', 'comms_app', 'mcp_token'])
      db.prepare('UPDATE settings SET key=? WHERE key=?').run(`${prefix}:${user}:${after}`, `${prefix}:${user}:${before}`);
  }
}

export function localWardsWithContent(user: number) {
  const keep = new Set<string>(), db = getDb();
  for (const table of ['notes', 'timers', 'comms_messages']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const field = columns.find(c => c.name === 'ward' || c.name === 'tile')?.name;
    if (field) for (const row of db.prepare(`SELECT DISTINCT ${field} AS ward FROM ${table} WHERE user_id=?`).all(user) as { ward: string }[]) keep.add(row.ward);
  }
  for (const row of db.prepare('SELECT DISTINCT c.ward FROM agent_conversations c JOIN agent_messages m ON m.conversation_id=c.id WHERE c.user_id=?').all(user) as { ward: string }[]) keep.add(row.ward);
  return keep;
}

/** Resolve hidden execution placement from the stored layout, never a client-supplied device. */
export function wardDevice(user: number, id: string): string | undefined {
  const layout = getDashboard(user), pages = getPages(user), ward = layout.find(w => w.i === id);
  if (!ward) return undefined;
  return ward.device ?? (ward.type === 'remote-desktop' ? undefined : pages.find(p => p.id === pageOf(ward, pages, layout))?.device);
}
