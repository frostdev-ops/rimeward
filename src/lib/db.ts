import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { backfillNotesIndex, migrateLegacyWards, migrateWardKeys } from './migrate-wards.ts';
import { loadMonitors } from './monitors.ts';

export const DATA_DIR = process.env.HOMEPAGE_DATA_DIR ?? path.join(process.cwd(), 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const handle = new Database(path.join(DATA_DIR, 'homepage.db'));
  handle.pragma('journal_mode = WAL');
  handle.pragma('busy_timeout = 5000');
  handle.pragma('foreign_keys = ON');
  migrate(handle);
  db = handle;
  return db;
}

/** A folder that ships beside the code (migrations/, assets/), not the working
 *  directory: src/lib/ sits two levels under the repo root, the built
 *  dist/server/chunks/ three — walk up from this module until it appears, cwd
 *  as the last resort. */
export function repoDir(name: string, from = path.dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return path.join(process.cwd(), name);
  }
}
export const migrationsDir = (from?: string): string => repoDir('migrations', from);

function migrate(handle: Database.Database): void {
  handle.exec(
    `CREATE TABLE IF NOT EXISTS applied_migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  );
  const dir = migrationsDir();
  if (!fs.existsSync(dir)) return;

  const applied = new Set(
    (handle.prepare('SELECT name FROM applied_migrations').all() as { name: string }[]).map((r) => r.name)
  );
  // Only release migration names; Finder/cloud conflict copies must never run as new SQL.
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const record = handle.prepare('INSERT INTO applied_migrations (name) VALUES (?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    handle.transaction(() => {
      handle.exec(sql);
      record.run(file);
    })();
  }

  // The monitor registry (lib/targets.ts) must be in memory before any layout
  // is validated — the data migrations below check Services wards against it.
  loadMonitors(handle);

  // A data migration, not SQL: stored layouts and graphs move off the legacy
  // ward ids once (after 010_timer_step.sql; the row name keeps the sequence).
  const LEGACY_WARDS = '011_legacy_tiles';
  if (!applied.has(LEGACY_WARDS)) {
    handle.transaction(() => {
      migrateLegacyWards(handle);
      record.run(LEGACY_WARDS);
    })();
  }

  // Tiles became wards (012_wards.sql renamed the columns): the JSON keys
  // inside saved graphs and packet histories follow, once.
  const WARD_KEYS = '013_ward_keys';
  if (!applied.has(WARD_KEYS)) {
    handle.transaction(() => {
      migrateWardKeys(handle);
      record.run(WARD_KEYS);
    })();
  }

  // The notes full-text index (025_notebooks.sql) starts empty: the documents
  // from before it are indexed once, in JS (their text comes out of the HTML).
  const NOTES_FTS = '025_notes_fts';
  if (!applied.has(NOTES_FTS)) {
    handle.transaction(() => {
      backfillNotesIndex(handle);
      record.run(NOTES_FTS);
    })();
  }
}
