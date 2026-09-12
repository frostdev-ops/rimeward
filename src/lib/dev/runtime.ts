import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR, getDb } from "../db.ts";
import type { RuntimeEvent } from "./types.ts";

export const isDesktop = (): boolean =>
  process.env.RIMEWARD_DESKTOP === "1" && !!process.env.RIMEWARD_NATIVE_TOKEN;
export class DevError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export function requireDesktop(): void {
  if (!isDesktop())
    throw new DevError("This tool runs on a connected desktop.", 403);
}

let database: Database.Database | undefined;
/** Native data is a separate, local-only database. A server never opens it. */
export function workDb(): Database.Database {
  requireDesktop();
  if (database) return database;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(DATA_DIR, "workspaces.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ward_state (user_id INTEGER NOT NULL, ward TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(user_id,ward));
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, root TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, root)
    );
    CREATE TABLE IF NOT EXISTS buffers (
      user_id INTEGER NOT NULL, project TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL,
      text TEXT NOT NULL, base_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      dirty INTEGER NOT NULL DEFAULT 0, encoding TEXT NOT NULL, newline TEXT NOT NULL,
      readonly INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, project, path)
    );
    CREATE TABLE IF NOT EXISTS buffer_copies (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, project TEXT NOT NULL, path TEXT NOT NULL,
      text TEXT NOT NULL, saved_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS terminal_sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, project TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL, mode TEXT NOT NULL, title TEXT NOT NULL, shell TEXT NOT NULL DEFAULT '',
      next_mode TEXT, human_control INTEGER NOT NULL DEFAULT 0, review TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL, exit_code INTEGER, snapshot TEXT NOT NULL DEFAULT '',
      task TEXT NOT NULL DEFAULT '', assignment TEXT NOT NULL DEFAULT '', task_state TEXT NOT NULL DEFAULT 'active',
      cols INTEGER NOT NULL DEFAULT 100, rows INTEGER NOT NULL DEFAULT 30,
      sequence INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS task_receipts (session TEXT PRIMARY KEY REFERENCES terminal_sessions(id), json TEXT NOT NULL);
  `);
  if (!(db.pragma("table_info(terminal_sessions)") as { name: string }[]).some(c => c.name === "agent_input")) {
    db.transaction(() => db.exec("ALTER TABLE terminal_sessions ADD COLUMN agent_input INTEGER NOT NULL DEFAULT 0; UPDATE terminal_sessions SET agent_input=(mode != 'human')"))();
  }
  if (!(db.pragma("table_info(terminal_sessions)") as { name: string }[]).some(c => c.name === "is_command")) {
    // Identify old command tabs from their receipts, never from user-authored titles.
    const jobs = getDb().prepare("SELECT user_id,result FROM agent_jobs WHERE tool='terminal_exec'").all() as { user_id: number; result: string }[];
    db.transaction(() => {
      db.exec("ALTER TABLE terminal_sessions ADD COLUMN is_command INTEGER NOT NULL DEFAULT 0");
      const mark = db.prepare("UPDATE terminal_sessions SET is_command=1 WHERE id=? AND user_id=? AND kind='shell'");
      for (const job of jobs) {
        let result: { session?: unknown } | null;
        try { result = JSON.parse(job.result); } catch { continue; }
        if (typeof result?.session === 'string') mark.run(result.session, job.user_id);
      }
    })();
  }
  db.transaction(() => {
    for (const [table, columns] of [
      ['terminal_sessions', [['exit_signal', 'INTEGER'], ['termination_reason', 'TEXT'], ['finished_at', 'INTEGER'], ['phase', "TEXT NOT NULL DEFAULT ''"], ['last_message', "TEXT NOT NULL DEFAULT ''"]]],
      ['buffer_copies', [['raw', 'BLOB'], ['mode', 'INTEGER']]],
    ] as const) {
      const existing = new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map(c => c.name));
      for (const [column, type] of columns) if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    db.exec(`UPDATE terminal_sessions SET state='interrupted',exit_code=NULL,exit_signal=NULL,
      termination_reason=COALESCE(termination_reason,'runtime-interrupted'),
      task_state=CASE WHEN task_state='active' THEN 'needs-attention' ELSE task_state END WHERE state IN ('running','interrupted')`);
    db.prepare("UPDATE terminal_sessions SET finished_at=? WHERE state!='running' AND finished_at IS NULL").run(Date.now());
    // Permission modes moved from the terminal to the agent ward: human → approvals, rimeward → normal.
    db.exec(`UPDATE terminal_sessions SET mode=CASE mode WHEN 'human' THEN 'approvals' WHEN 'rimeward' THEN 'normal' ELSE mode END,
      next_mode=CASE next_mode WHEN 'human' THEN 'approvals' WHEN 'rimeward' THEN 'normal' ELSE next_mode END
      WHERE mode IN ('human','rimeward') OR next_mode IN ('human','rimeward')`);
  })();
  database = db;
  return db;
}

const streams = new Map<
  number,
  { sequence: number; listeners: Set<(event: RuntimeEvent) => void> }
>();
function stream(user: number) {
  let s = streams.get(user);
  if (!s) {
    s = { sequence: 0, listeners: new Set() };
    streams.set(user, s);
  }
  return s;
}
export function emitDev(
  user: number,
  type: RuntimeEvent["type"],
  id: string,
  data?: unknown,
): void {
  const s = stream(user);
  const event = { sequence: ++s.sequence, type, id, data };
  for (const fn of s.listeners) fn(event);
}
export function subscribeDev(
  user: number,
  fn: (event: RuntimeEvent) => void,
): () => void {
  requireDesktop();
  const s = stream(user);
  s.listeners.add(fn);
  fn({ sequence: s.sequence, type: "reset", id: "" });
  return () => s.listeners.delete(fn);
}

// Leases serialize human input, not arbitrary third-party filesystem writes.
const leases = new Map<string, { owner: string; until: number }>();
export function leaseOwner(key: string): string | null {
  const l = leases.get(key);
  if (l && l.until > Date.now()) return l.owner;
  leases.delete(key);
  return null;
}
export function claimLease(key: string, owner: string, takeover = false, duration = 30_000): void {
  if (!/^[\w:-]{1,120}$/.test(owner))
    throw new DevError("Invalid input owner.");
  const current = leaseOwner(key);
  if (current && current !== owner && !takeover)
    throw new DevError(
      "Another client controls this session. Take over to edit.",
      409,
    );
  leases.set(key, { owner, until: Date.now() + duration });
}
export function releaseLease(key: string, owner: string): void {
  if (leaseOwner(key) === owner) leases.delete(key);
}
