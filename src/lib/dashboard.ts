import { getDb } from './db.ts';
import { DEFAULT_LAYOUT, DEFAULT_PAGES, validateLayout, validatePages, type BrowserConfig, type PageDef, type WardInstance } from './wards.ts';
import { dropSession, relaunchIdle } from './browser/session.ts';
import { isCommsType } from './comms/types.ts';
import { observe } from './agent/observation-events.ts';

type Row = { layout_json: string; pages_json: string };
const row = (userId: number) => getDb().prepare('SELECT layout_json, pages_json FROM dashboards WHERE user_id = ?').get(userId) as Row | undefined;

function pagesOf(r: Row | undefined): PageDef[] {
  if (!r) return DEFAULT_PAGES;
  try {
    return validatePages(JSON.parse(r.pages_json)) ?? DEFAULT_PAGES;
  } catch {
    return DEFAULT_PAGES;
  }
}

/** The user's page list, ordered; the first is the default. Never empty. */
export function getPages(userId: number): PageDef[] {
  return pagesOf(row(userId));
}

export function getDashboard(userId: number): WardInstance[] {
  const r = row(userId);
  if (!r) return DEFAULT_LAYOUT;
  try {
    return validateLayout(JSON.parse(r.layout_json), pagesOf(r)) ?? DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** The ONE resolver every browser route and tool uses: ward id → that ward's
 *  config, or null when it isn't this user's browser ward. */
export function browserWard(userId: number, ward: unknown): BrowserConfig | null {
  if (typeof ward !== 'string') return null;
  const w = getDashboard(userId).find((x) => x.i === ward && x.type === 'browser');
  return w ? (w.config as unknown as BrowserConfig) : null;
}

/** `pages` omitted leaves the stored page list alone — the agent's layout
 *  tools and every other layout-only writer never touch it. */
export function saveDashboard(userId: number, layout: WardInstance[], pages?: PageDef[]): void {
  // A browser ward leaving the layout takes its profile (cookies, logins) with it.
  const before = getDashboard(userId);
  const gone = before.filter((w) => w.type === 'browser' && !layout.some((x) => x.i === w.i));
  // A chat ward leaving takes its sealed token and its messages; the
  // connection manager then reconciles what is still open (late import: it
  // pulls the engine, which this module must not).
  const goneComms = before.filter((w) => isCommsType(w.type) && !layout.some((x) => x.i === w.i));
  getDb()
    .prepare(
      `INSERT INTO dashboards (user_id, layout_json) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = datetime('now')`
    )
    .run(userId, JSON.stringify(layout));
  if (pages) getDb().prepare('UPDATE dashboards SET pages_json = ? WHERE user_id = ?').run(JSON.stringify(pages), userId);
  for (const w of gone) void dropSession(userId, w.i).catch(() => {});
  // Sound is a launch flag: a live, idle browser relaunches to pick it up.
  for (const w of layout) {
    if (w.type !== 'browser') continue;
    const was = before.find((x) => x.i === w.i);
    if (was && (was.config as BrowserConfig | undefined)?.sound !== (w.config as BrowserConfig | undefined)?.sound) relaunchIdle(userId, w.i);
  }
  if (goneComms.length || layout.some((w) => isCommsType(w.type))) {
    void import('./comms/index.ts')
      .then((m) => {
        for (const w of goneComms) m.forgetWard(userId, w.i);
        m.syncComms(userId);
      })
      .catch((err) => console.error('[comms] sync after save failed:', err));
  }
  observe({ user:userId,source:'dashboard',target:'',key:'saved',data:{} });
}
