// The one-time rewrite of stored layouts and saved logic graphs from the
// legacy ward ids (gmail/outlook/zoho/mailbox, service/host, notion-fields/
// notion-capture, separator) to the types that absorbed them. Runs at boot
// from db.ts, BEFORE those ids leave CATALOG: an un-migrated layout_json would
// otherwise make getDashboard fall back to DEFAULT_LAYOUT silently, and a
// lenient graph read would drop every edge on a vanished trigger. Pure over
// the db handle — never imports db.ts.

import type Database from 'better-sqlite3';
import { DEFAULT_LAYOUT, HOST_SERVICE_IDS, validateLayout } from './wards.ts';
import { validateGraph } from './logic.ts';
import { excerpt, plainText } from './note-text.ts';

type Raw = Record<string, unknown>;

const MAIL: Record<string, [account: string, title: string]> = {
  gmail: ['google', 'Gmail'],
  outlook: ['microsoft', 'Outlook'],
  zoho: ['zoho', 'Zoho Mail'],
  mailbox: ['mailbox', 'Mailbox'],
};

/** One ward: the new (type, config, default title), or null to leave it, or
 *  'skip' when the stored config cannot be carried (a service ward with no service). */
function rewriteWard(w: Raw): { type: string; config: Raw; title?: string } | null | 'skip' {
  const cfg = (typeof w.config === 'object' && w.config !== null ? w.config : {}) as Raw;
  const type = String(w.type);
  if (MAIL[type]) return { type: 'mail', config: { account: MAIL[type]![0] }, title: MAIL[type]![1] };
  switch (type) {
    case 'service':
      return typeof cfg.service === 'string' ? { type: 'service-group', config: { services: [cfg.service] } } : 'skip';
    case 'host':
      return { type: 'service-group', config: { services: [...HOST_SERVICE_IDS] }, title: 'Host' };
    case 'notion-fields': {
      const config: Raw = { show: ['props'] };
      if (cfg.page !== undefined) config.page = cfg.page;
      if (cfg.props !== undefined) config.props = cfg.props;
      if (cfg.head === false) config.head = false;
      return { type: 'notion-page', config, title: 'Page fields' };
    }
    case 'notion-capture':
      return { type: 'notion-page', config: { show: ['add'] }, title: 'Quick capture' };
    case 'separator':
      return { type: 'spacer', config: { ...cfg, rule: true } };
    default:
      return null;
  }
}

/** i, size, hidden, theme, in are untouched; a title is stamped only when absent. */
export function migrateLayout(raw: unknown): { layout: unknown[]; changed: boolean; skipped: string[] } {
  if (!Array.isArray(raw)) return { layout: [], changed: false, skipped: ['not an array'] };
  let changed = false;
  const skipped: string[] = [];
  const layout = raw.map((item) => {
    if (typeof item !== 'object' || item === null) return item;
    const w = item as Raw;
    const next = rewriteWard(w);
    if (next === null) return w;
    if (next === 'skip') {
      skipped.push(String(w.i));
      return w;
    }
    changed = true;
    const out: Raw = { ...w, type: next.type, config: next.config };
    if (next.title && !(typeof w.title === 'string' && w.title.trim())) out.title = next.title;
    return out;
  });
  return { layout, changed, skipped };
}

const TRIGGERS: Record<string, string> = { 'outlook-arrived': 'microsoft', 'zoho-arrived': 'zoho', 'mailbox-arrived': 'mailbox' };

/** Edges only: the three per-provider mail triggers become mail-arrived with
 *  an account filter, so each keeps matching exactly the mail it did. */
export function migrateGraph(raw: unknown): { graph: unknown; changed: boolean } {
  const edges = (raw as { edges?: unknown } | null)?.edges;
  if (!Array.isArray(edges)) return { graph: raw, changed: false };
  let changed = false;
  const next = edges.map((e) => {
    const src = (e as Raw | null)?.source as Raw | undefined;
    const account = src && TRIGGERS[String(src.trigger)];
    if (!account) return e;
    changed = true;
    return { ...(e as Raw), source: { ...src, trigger: 'mail-arrived', params: { ...((src.params as Raw | undefined) ?? {}), account } } };
  });
  return { graph: { ...(raw as Raw), edges: next }, changed };
}

/** The boot-time runner: every dashboards row, then every logic_graphs row
 *  strictly checked against that user's (migrated) layout. A layout that
 *  cannot be carried is left untouched and logged, never guessed at. */
export function migrateLegacyWards(handle: Database.Database): void {
  const layouts = new Map<number, unknown[]>();
  const rows = handle.prepare('SELECT user_id, layout_json FROM dashboards').all() as { user_id: number; layout_json: string }[];
  const putLayout = handle.prepare('UPDATE dashboards SET layout_json = ?, updated_at = datetime(\'now\') WHERE user_id = ?');
  for (const r of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(r.layout_json);
    } catch {
      console.warn(`[migrate] user ${r.user_id}: layout_json unreadable, left untouched`);
      continue;
    }
    const { layout, changed, skipped } = migrateLayout(raw);
    if (skipped.length || validateLayout(layout) === null) {
      console.warn(`[migrate] user ${r.user_id}: layout left untouched${skipped.length ? ` (skipped ${skipped.join(', ')})` : ' (would not validate)'}`);
      continue;
    }
    layouts.set(r.user_id, layout);
    if (changed) putLayout.run(JSON.stringify(layout), r.user_id);
  }
  const graphs = handle.prepare('SELECT user_id, graph_json FROM logic_graphs').all() as { user_id: number; graph_json: string }[];
  const putGraph = handle.prepare('UPDATE logic_graphs SET graph_json = ?, updated_at = datetime(\'now\') WHERE user_id = ?');
  for (const g of graphs) {
    let raw: unknown;
    try {
      raw = JSON.parse(g.graph_json);
    } catch {
      console.warn(`[migrate] user ${g.user_id}: graph_json unreadable, left untouched`);
      continue;
    }
    const { graph, changed } = migrateGraph(raw);
    const layout = validateLayout(layouts.get(g.user_id) ?? DEFAULT_LAYOUT) ?? DEFAULT_LAYOUT;
    const edges = ((graph as { edges?: Raw[] }).edges ?? []).map((e) => String(e.id));
    const kept = validateGraph(graph, layout, { isAdmin: true, lenient: true })?.edges.map((e) => e.id) ?? [];
    const dropped = edges.filter((id) => !kept.includes(id));
    if (dropped.length) console.warn(`[migrate] user ${g.user_id}: edges a lenient read will drop: ${dropped.join(', ')}`);
    if (changed) putGraph.run(JSON.stringify(graph), g.user_id);
  }
}

// ---------------------------------------------------------------- 013: tiles → wards

/** Every `tile` key an edge carried — `source.tile`, `action.tile`, and the
 *  one param spec that was named tile (packet-count-above) — becomes `ward`,
 *  and the `trigger.tileTitle` template var follows. Values (the ids) are
 *  untouched. */
export function wardKeysGraph(raw: unknown): { graph: unknown; changed: boolean } {
  const edges = (raw as { edges?: unknown } | null)?.edges;
  if (!Array.isArray(edges)) return { graph: raw, changed: false };
  let changed = false;
  const fix = (o: unknown): unknown => {
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return o;
    const out: Raw = {};
    for (const [k, v] of Object.entries(o as Raw)) {
      if (k === 'tile') {
        changed = true;
        out.ward = v;
      } else out[k] = k === 'params' ? fix(v) : v;
    }
    return out;
  };
  const next = edges.map((e) => {
    if (typeof e !== 'object' || e === null) return e;
    const edge = e as Raw;
    const out: Raw = { ...edge, source: fix(edge.source), action: fix(edge.action) };
    if (Array.isArray(edge.conditions)) out.conditions = edge.conditions.map(fix);
    return out;
  });
  let json = JSON.stringify({ ...(raw as Raw), edges: next });
  if (json.includes('trigger.tileTitle')) {
    changed = true;
    json = json.replaceAll('trigger.tileTitle', 'trigger.wardTitle');
  }
  return { graph: JSON.parse(json), changed };
}

/** A packet's history entries: [{at, tile, event, note?}] → ward. */
export function wardKeysHistory(raw: unknown): { history: unknown; changed: boolean } {
  if (!Array.isArray(raw)) return { history: raw, changed: false };
  let changed = false;
  const history = raw.map((h) => {
    if (typeof h !== 'object' || h === null || !('tile' in h)) return h;
    changed = true;
    const { tile, ...rest } = h as Raw;
    return { ...rest, ward: tile };
  });
  return { history, changed };
}

/** The boot-time runner behind db.ts's 013_ward_keys row. Unreadable JSON is
 *  logged and left alone, like the legacy rewrite above. */
export function migrateWardKeys(handle: Database.Database): void {
  const graphs = handle.prepare('SELECT user_id, graph_json FROM logic_graphs').all() as { user_id: number; graph_json: string }[];
  const putGraph = handle.prepare('UPDATE logic_graphs SET graph_json = ?, updated_at = datetime(\'now\') WHERE user_id = ?');
  for (const g of graphs) {
    try {
      const { graph, changed } = wardKeysGraph(JSON.parse(g.graph_json));
      if (changed) putGraph.run(JSON.stringify(graph), g.user_id);
    } catch {
      console.warn(`[migrate] user ${g.user_id}: graph_json unreadable, left untouched`);
    }
  }
  const packets = handle.prepare("SELECT id, history_json FROM packets WHERE history_json LIKE '%\"tile\"%'").all() as { id: number; history_json: string }[];
  const putHistory = handle.prepare('UPDATE packets SET history_json = ? WHERE id = ?');
  for (const p of packets) {
    try {
      const { history, changed } = wardKeysHistory(JSON.parse(p.history_json));
      if (changed) putHistory.run(JSON.stringify(history), p.id);
    } catch {
      console.warn(`[migrate] packet ${p.id}: history_json unreadable, left untouched`);
    }
  }
}

/** Index every note that has no full-text row — the documents from before
 *  025_notebooks.sql. db.ts runs it once over the migrating handle; cheap to
 *  re-run, it only touches the missing. Tags are stored as a JSON list. */
export function backfillNotesIndex(db: Database.Database): number {
  const rows = db.prepare('SELECT user_id, ward, html, title, tags FROM notes WHERE NOT EXISTS (SELECT 1 FROM notes_fts f WHERE f.user_id = notes.user_id AND f.id = notes.ward)').all() as { user_id: number; ward: string; html: string; title: string; tags: string }[];
  const upd = db.prepare('UPDATE notes SET excerpt = ? WHERE user_id = ? AND ward = ?');
  const ins = db.prepare('INSERT INTO notes_fts (user_id, id, title, body, tags) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) {
    const text = plainText(r.html);
    let tags: unknown;
    try { tags = JSON.parse(r.tags); } catch { tags = []; }
    upd.run(excerpt(text), r.user_id, r.ward);
    ins.run(r.user_id, r.ward, r.title, text, Array.isArray(tags) ? tags.filter((t) => typeof t === 'string').join(' ') : '');
  }
  return rows.length;
}
