// Derived data only. This worker never writes the authoritative database or work files.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { plainText } from '../src/lib/note-text.ts';

const source = new Database(path.join(workerData.directory, 'homepage.db'), { readonly: true, fileMustExist: true });
const db = new Database(path.join(workerData.directory, 'knowledge.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
let vectorError = '';
try { sqliteVec.load(db); } catch (e) { vectorError = e.message; }
db.exec(`
  CREATE TABLE IF NOT EXISTS sources (owner INTEGER NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
    title TEXT NOT NULL, reference TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(owner,id));
  CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, owner INTEGER NOT NULL, source TEXT NOT NULL,
    page INTEGER NOT NULL, line INTEGER NOT NULL, offset INTEGER NOT NULL, text TEXT NOT NULL,
    FOREIGN KEY(owner,source) REFERENCES sources(owner,id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS chunks_source ON chunks(owner,source);
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(title,text);
  CREATE TABLE IF NOT EXISTS vectors (chunk INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    profile TEXT NOT NULL, dimensions INTEGER NOT NULL, embedding BLOB NOT NULL, PRIMARY KEY(chunk,profile));
  CREATE TRIGGER IF NOT EXISTS chunks_delete BEFORE DELETE ON chunks BEGIN
    DELETE FROM chunks_fts WHERE rowid=old.id;
  END;
`);
const hash = text => createHash('sha256').update(text).digest('hex');
const catalogs = new Map();
const watchers = new Map();
const dirty = new Set();
const slug = /^[a-z0-9][a-z0-9-]{0,47}$/;
const base = owner => path.join(workerData.directory, 'agent', String(owner), 'work');
function fileText(owner, relative) {
  const root = base(owner), file = path.join(root, relative);
  try {
    // Never follow a symlink out of this user's Rime-owned work directory.
    const expectedRoot = path.join(fs.realpathSync(workerData.directory),'agent',String(owner),'work');
    if (fs.realpathSync(root) !== expectedRoot || fs.realpathSync(file) !== path.join(expectedRoot,relative)) return null;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}
function files(owner, kind) {
  try {
    const folder = kind === 'memory' ? 'memory' : 'skills';
    return fs.readdirSync(path.join(base(owner), folder)).sort().flatMap(file => {
      const name = kind === 'memory' ? file.replace(/\.md$/, '') : file;
      if (!slug.test(name) || (kind === 'memory' && !file.endsWith('.md'))) return [];
      const relative = kind === 'memory' ? `${folder}/${file}` : `${folder}/${name}/SKILL.md`;
      const text = fileText(owner, relative);
      return text === null ? [] : [{ id: `${kind}:${name}`, kind, title: name, reference: `/work/${relative}`, text }];
    });
  } catch { return []; }
}
function* sources(owner) {
  yield* files(owner, 'memory'); yield* files(owner, 'skill');
  const notes = fileText(owner, 'AGENTS.md');
  if (notes !== null) yield { id: 'standing:AGENTS.md', kind: 'standing', title: 'Standing notes', reference: '/work/AGENTS.md', text: notes };
  for (const n of source.prepare(`SELECT n.ward,n.title,n.rev,n.notebook,n.html FROM notes n
    WHERE n.user_id=? AND n.trashed_at IS NULL AND n.archived_at IS NULL AND n.template=0`).iterate(owner)) {
    yield { id: `note:${n.ward}`, kind: n.notebook ? 'notebook' : 'note', title: n.title || n.ward, reference: `note:${n.ward}`, text: plainText(n.html), version: n.rev };
  }
  for (const n of source.prepare('SELECT id,title,sections FROM notebooks WHERE user_id=?').iterate(owner)) {
    yield { id: `notebook:${n.id}`, kind: 'notebook', title: n.title || n.id, reference: `notebook:${n.id}`, text: `${n.title}\n${n.sections}` };
  }
  for (const c of source.prepare('SELECT id FROM agent_conversations WHERE user_id=? ORDER BY id').iterate(owner)) {
    const messages = source.prepare('SELECT role,text,at FROM agent_messages WHERE conversation_id=? ORDER BY id').all(c.id);
    yield { id: `conversation:${c.id}`, kind: 'conversation', title: `Conversation ${c.id}`, reference: `conversation:${c.id}`,
      text: messages.map(m => `## ${m.role} — ${m.at}\n${m.text}`).join('\n\n') };
  }
  for (const f of source.prepare("SELECT id,name,text FROM agent_files WHERE user_id=? AND text IS NOT NULL AND text!='' AND mime NOT LIKE 'image/%'").iterate(owner)) {
    yield { id: `attachment:${f.id}`, kind: 'attachment', title: f.name, reference: `attachment:${f.id}`, text: f.text };
  }
  yield* catalogs.get(owner) ?? [];
}
function fingerprint(s) { return hash(JSON.stringify([s.kind, s.title, s.reference, s.text, s.version])); }
function currentHits(owner, rows) {
  const wanted = new Set(rows.map(r => r.source)), current = new Map();
  for (const s of sources(owner)) if (wanted.has(s.id)) current.set(s.id,fingerprint(s));
  return rows.filter(r => current.get(r.source) === r.revision);
}
function chunks(text) {
  const out = []; let page = 1, line = 1, offset = 0, start = 0, firstLine = 1, body = '';
  const flush = () => { if (body.trim()) out.push({ text: body, page, line: firstLine, offset: start }); body = ''; };
  for (const row of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!row) continue;
    const marker = /^--- page (\d+) ---\r?\n?$/.exec(row);
    if (marker) { flush(); page = Number(marker[1]); line = 0; }
    else for (let at = 0; at < row.length;) {
      let end = Math.min(row.length, at + 2400);
      if (end < row.length && /[\uD800-\uDBFF]/.test(row[end - 1])) end--;
      const part = row.slice(at, end);
      if (body.length + part.length > 2600) flush();
      if (!body) { start = offset + at; firstLine = line; }
      body += part;
      at = end;
    }
    offset += row.length; line++;
  }
  flush(); return out;
}
async function reconcile(owner, tools) {
  if (tools) catalogs.set(owner, tools);
  const seen = new Set();
  for (const s of sources(owner)) {
    seen.add(s.id);
    const revision = fingerprint(s);
    if (db.prepare('SELECT revision FROM sources WHERE owner=? AND id=?').get(owner,s.id)?.revision === revision) continue;
    db.transaction(() => {
      db.prepare('DELETE FROM chunks WHERE owner=? AND source=?').run(owner,s.id);
      db.prepare(`INSERT INTO sources VALUES(?,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET kind=excluded.kind,title=excluded.title,
        reference=excluded.reference,revision=excluded.revision`).run(owner,s.id,s.kind,s.title,s.reference,revision);
      for (const c of chunks(s.text)) {
        const id = db.prepare('INSERT INTO chunks(owner,source,page,line,offset,text) VALUES(?,?,?,?,?,?)').run(owner,s.id,c.page,c.line,c.offset,c.text).lastInsertRowid;
        db.prepare('INSERT INTO chunks_fts(rowid,title,text) VALUES(?,?,?)').run(id,s.title,c.text);
      }
    })();
    await new Promise(resolve => setImmediate(resolve));
  }
  for (const row of db.prepare('SELECT id,kind FROM sources WHERE owner=?').all(owner)) {
    if (!seen.has(row.id) && (row.kind !== 'tool' || catalogs.has(owner))) {
      db.transaction(() => {
        db.prepare('DELETE FROM chunks WHERE owner=? AND source=?').run(owner,row.id);
        db.prepare('DELETE FROM sources WHERE owner=? AND id=?').run(owner,row.id);
      })();
    }
  }
  dirty.delete(owner);
  if (!watchers.has(owner)) {
    try {
      const watcher = fs.watch(base(owner), { recursive: true }, () => dirty.add(owner));
      watcher.on('error',() => { watcher.close(); watchers.set(owner,null); });
      watchers.set(owner,watcher);
    } catch { watchers.set(owner,null); /* Reconciliation covers unavailable filesystem watchers. */ }
  }
}
function scope(owner, kinds, sources) {
  const list = Array.isArray(kinds) ? kinds.filter(k => ['tool','memory','skill','standing','note','notebook','conversation','attachment'].includes(k)) : [];
  return { sql: `c.owner=?${list.length ? ` AND s.kind IN (${list.map(() => '?').join(',')})` : ''}${sources ? ` AND s.id IN (${sources.map(() => '?').join(',') || 'NULL'})` : ''}`, args: [owner,...list,...(sources ?? [])] };
}
const select = 'SELECT c.*,s.kind,s.title,s.reference,s.revision FROM chunks c JOIN sources s ON s.owner=c.owner AND s.id=c.source';
function search({ owner, query, kinds, sources, limit, profile, vector }) {
  const bound = scope(owner,kinds,sources), scores = new Map();
  const add = (rows, weight) => rows.forEach((r,i) => {
    const old = scores.get(r.id); scores.set(r.id, { ...r, score: (old?.score ?? 0) + weight/(20+i) });
  });
  const q = query.toLowerCase().trim();
  add(db.prepare(`${select} WHERE ${bound.sql} AND (lower(s.title)=? OR lower(s.id)=?) LIMIT 100`).all(...bound.args,q,q), 4);
  const terms = query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0,24).map(t => `"${t}"`).join(' OR ');
  if (terms) add(db.prepare(`${select} JOIN chunks_fts f ON f.rowid=c.id WHERE ${bound.sql} AND chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 100`).all(...bound.args,terms), 1);
  if (vector && !vectorError) {
    // ponytail: exact scoped O(n) vector scan in the worker; use vec0 partitions if the corpus outgrows it.
    const bytes = Buffer.from(new Float32Array(vector).buffer);
    const rows = db.prepare(`${select} JOIN vectors v ON v.chunk=c.id WHERE ${bound.sql} AND v.profile=? AND v.dimensions=?
      ORDER BY vec_distance_cosine(v.embedding,?) LIMIT 100`).all(...bound.args,profile,vector.length,bytes);
    add(rows,1);
  }
  return [...scores.values()].sort((a,b) => b.score-a.score || a.id-b.id).slice(0,limit);
}
async function handle(m) {
  const { owner, op } = m;
  if (!Number.isSafeInteger(owner) || owner < 1) throw Error('Invalid knowledge owner.');
  if (op === 'named') {
    const matched = files(owner,'skill').filter(s => new RegExp(`(?:^|[^a-z0-9-])${s.title}(?:$|[^a-z0-9-])`,'i').test(String(m.query).slice(-4000)));
    return matched.slice(0,6).map(s => ({ name:s.title,text:s.text.slice(0,65536),truncated:s.text.length > 65536 }));
  }
  if (op === 'rebuild') {
    db.transaction(() => {
      db.prepare('DELETE FROM chunks WHERE owner=?').run(owner);
      db.prepare('DELETE FROM sources WHERE owner=?').run(owner);
    })();
  }
  if (['reconcile','rebuild','search','read','pending'].includes(op)) await reconcile(owner,m.tools);
  if (op === 'search') return currentHits(owner,search(m));
  if (op === 'read') {
    return currentHits(owner,db.prepare(`${select} WHERE c.owner=? AND s.id=? AND c.offset>=? ORDER BY c.offset LIMIT ?`).all(owner,m.source,m.offset ?? 0,m.limit ?? 3));
  }
  if (op === 'pending') return db.prepare(`${select} WHERE c.owner=? AND NOT EXISTS(SELECT 1 FROM vectors v WHERE v.chunk=c.id AND v.profile=?) LIMIT 8`).all(owner,m.profile);
  if (op === 'vectors') {
    if (vectorError) throw Error(vectorError);
    db.transaction(() => {
      for (const v of m.values) {
        if (!db.prepare(`${select} WHERE c.owner=? AND c.id=? AND s.revision=?`).get(owner,v.id,v.revision)) continue;
        db.prepare('INSERT OR REPLACE INTO vectors VALUES(?,?,?,?)').run(v.id,m.profile,v.vector.length,Buffer.from(new Float32Array(v.vector).buffer));
      }
    })();
  }
  const counts = db.prepare('SELECT count(*) AS chunks FROM chunks WHERE owner=?').get(owner);
  const embedded = db.prepare('SELECT count(*) AS embedded FROM vectors v JOIN chunks c ON c.id=v.chunk WHERE c.owner=? AND v.profile=?').get(owner,m.profile ?? '');
  return { ...counts,...embedded,vectorError };
}
let chain = Promise.resolve();
parentPort.on('message', m => {
  chain = chain.then(async () => {
    try { parentPort.postMessage({ id:m.id,value:await handle(m) }); }
    catch (e) { parentPort.postMessage({ id:m.id,error:e.message }); }
  });
});
setInterval(() => {
  for (const owner of dirty) chain = chain.then(() => reconcile(owner)).catch(() => {});
}, 1000).unref();
