import fs from 'node:fs';
import path from 'node:path';
import { workDir } from './history.ts';
import { knowledgeChanged } from './observation-events.ts';

// Rime's document stores: memory (one file per durable fact) and skills (one
// SKILL.md per procedure), both under the per-user work dir the sandbox mounts
// read-write — `cat /work/memory/x.md`, `cat /work/skills/x/SKILL.md` is how
// the agent reads one back — and both with an INDEX (name + description per
// document) generated into every turn's instructions. Generated, never
// written by the agent: an index it maintained by hand would drift from the
// files it points at; this one cannot. /work/AGENTS.md stays the
// always-in-prompt tier (standing rules, in full); these are read on demand.
//
//   ---
//   description: one line — what the document holds
//   ---
//   the fact, or the procedure, markdown
//
// A document without that header (the agent wrote it with bash) still lists:
// its first line is the description.

export type StoreKind = 'memory' | 'skill';

export interface StoreSpec {
  /** Under /work. */
  dir: string;
  /** The document's path under dir. */
  file: (name: string) => string;
  /** What deleting removes, under dir — the file, or the skill's folder. */
  unit: (name: string) => string;
  bodyMax: number;
  /** The index rides in every turn's prompt; past this it is cut, with a note. */
  indexCap: number;
}

export const STORES: Record<StoreKind, StoreSpec> = {
  memory: { dir: 'memory', file: (n) => `${n}.md`, unit: (n) => `${n}.md`, bodyMax: 6000, indexCap: 4000 },
  // A folder per skill: the ward-folder shape (a SKILL.md beside whatever a
  // shared ward ships with it later) and the Claude Code convention.
  skill: { dir: 'skills', file: (n) => `${n}/SKILL.md`, unit: (n) => n, bodyMax: 12000, indexCap: 2000 },
};

export const storeKind = (k: unknown): StoreKind | null => (typeof k === 'string' && k in STORES ? (k as StoreKind) : null);

export const DOC_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const DOC_DESC_MAX = 160;

export interface DocEntry {
  name: string;
  description: string;
  chars: number;
  /** unix ms */
  updatedAt: number;
  /** A skill's other files (tool.js, mcp.json, …); a memory has none. */
  files?: string[];
}
export interface Doc extends DocEntry {
  body: string;
  /** What a skill's mcp.json asks for. */
  mcp?: McpNeed[];
}

/** One server a ward folder's mcp.json names — the shape of an mcp ward's config. */
export interface McpNeed {
  name: string;
  url: string;
  header?: string;
}

export const SKILL_FILE_MAX = 64 * 1024;
const MCP_JSON_MAX = 16 * 1024;

/** The path the agent sees in its sandbox. */
export const docPath = (kind: StoreKind, name: string): string => `/work/${STORES[kind].dir}/${STORES[kind].file(name)}`;

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

export function storeDir(userId: number, kind: StoreKind): string {
  const dir = path.join(workDir(userId), STORES[kind].dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const fileOf = (userId: number, kind: StoreKind, name: string) => path.join(storeDir(userId, kind), STORES[kind].file(name));

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Header + body → the parts. No header: the first line describes it. */
export function parseDoc(text: string): { description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    const d = /^description:[ \t]*(.*)$/m.exec(m[1]!);
    return { description: oneLine(d?.[1] ?? '').slice(0, DOC_DESC_MAX), body: text.slice(m[0].length).trim() };
  }
  const body = text.trim();
  return { description: oneLine(body.split('\n')[0] ?? '').replace(/^#+\s*/, '').slice(0, DOC_DESC_MAX), body };
}

export function serializeDoc(description: string, body: string): string {
  return `---\ndescription: ${description}\n---\n${body.trim()}\n`;
}

export function readDoc(userId: number, kind: StoreKind, name: string): Doc | null {
  if (!DOC_NAME_RE.test(name)) return null;
  try {
    const file = fileOf(userId, kind, name);
    const { description, body } = parseDoc(fs.readFileSync(file, 'utf8'));
    const doc: Doc = { name, description, body, chars: body.length, updatedAt: fs.statSync(file).mtimeMs };
    if (kind === 'skill') {
      doc.files = fs
        .readdirSync(path.dirname(file))
        .filter((f) => f !== 'SKILL.md' && !f.startsWith('.'))
        .sort();
      if (doc.files.includes('mcp.json')) doc.mcp = parseMcpNeeds(JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'mcp.json'), 'utf8')));
    }
    return doc;
  } catch {
    return null;
  }
}

/** mcp.json → the servers it names, shaped like mcp ward config. Anything else in it is ignored. */
export function parseMcpNeeds(raw: unknown): McpNeed[] {
  const list = (raw as { servers?: unknown } | null)?.servers;
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is { name: string; url: string; header?: unknown } => !!s && typeof s === 'object' && typeof (s as { name?: unknown }).name === 'string' && typeof (s as { url?: unknown }).url === 'string' && /^https?:\/\//.test((s as { url: string }).url))
    .slice(0, 8)
    .map((s) => ({ name: s.name.slice(0, 24), url: s.url.slice(0, 500), ...(typeof s.header === 'string' ? { header: s.header.slice(0, 64) } : {}) }));
}

/** Every document, by name. An entry that is not one (bad name, no file
 *  behind it, unreadable) is skipped, never fatal. */
export function listDocs(userId: number, kind: StoreKind): DocEntry[] {
  const out: DocEntry[] = [];
  const seen = new Set<string>();
  for (const f of fs.readdirSync(storeDir(userId, kind)).sort()) {
    const name = f.endsWith('.md') ? f.slice(0, -3) : f;
    if (seen.has(name) || !DOC_NAME_RE.test(name)) continue;
    const d = readDoc(userId, kind, name);
    if (!d) continue;
    seen.add(name);
    out.push({ name, description: d.description, chars: d.chars, updatedAt: d.updatedAt, ...(d.files ? { files: d.files } : {}) });
  }
  return out;
}

/** Create or overwrite. Throws {status: 400} on a bad name, a missing
 *  description or body, or a part past its cap. */
export function writeDoc(userId: number, kind: StoreKind, name: string, description: string, body: string): DocEntry {
  name = name.trim();
  if (!DOC_NAME_RE.test(name)) throw bad('name must be a slug: [a-z0-9-], 1-48 chars, starting with a letter or digit');
  description = oneLine(description);
  if (!description) throw bad('description is required — one line saying what the document holds');
  if (description.length > DOC_DESC_MAX) throw bad(`description must be ≤${DOC_DESC_MAX} chars`);
  body = body.trim();
  if (!body) throw bad('body is required');
  const { bodyMax } = STORES[kind];
  if (body.length > bodyMax) throw bad(`body must be ≤${bodyMax} chars — split it, or drop what is not durable`);
  const file = fileOf(userId, kind, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeDoc(description, body), { mode: 0o600 });
  knowledgeChanged(userId);
  return { name, description, chars: body.length, updatedAt: Date.now() };
}

export function deleteDoc(userId: number, kind: StoreKind, name: string): boolean {
  if (!DOC_NAME_RE.test(name)) return false;
  try {
    fs.rmSync(path.join(storeDir(userId, kind), STORES[kind].unit(name)), { recursive: true });
    knowledgeChanged(userId);
    return true;
  } catch {
    return false;
  }
}

/** The prompt block: one line per document. Cut at the store's indexCap on a
 *  line boundary, saying so — the agent can always ls the directory. */
export function docIndex(userId: number, kind: StoreKind): string {
  const { indexCap, dir } = STORES[kind];
  const lines = listDocs(userId, kind).map((m) => `- ${m.name} — ${m.description}`);
  let out = '';
  for (const [i, line] of lines.entries()) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > indexCap) return `${out}\n… index cut at ${indexCap} chars (${lines.length - i} more — ls /work/${dir})`;
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------- ward folders

/** What importSkill needs of a fetch — vettedFetch fits; tests pass a fake. */
export type FolderFetch = (url: string, options?: { timeoutMs?: number }) => Promise<{ status: number; body: Uint8Array }>;

/** A ward folder from a URL: its SKILL.md, plus tool.js and mcp.json beside it
 *  when they exist. `url` may be the folder (ending in /), the SKILL.md
 *  itself, or any file in the folder — a raw GitHub folder works. Fetched
 *  through vettedFetch by the route: this is the USER's action, so the
 *  agent's network switch does not apply; the SSRF guard does. An import over
 *  an existing skill replaces what it fetched and leaves the rest. */
export async function importSkill(userId: number, name: string, url: string, fetchImpl: FolderFetch): Promise<{ entry: DocEntry; files: string[] }> {
  let base: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
    base = u.href.endsWith('/') ? u.href : u.href.slice(0, u.href.lastIndexOf('/') + 1);
  } catch {
    throw bad('the url must be http(s) — a folder, or the SKILL.md in it');
  }
  const get = async (file: string, max: number): Promise<string | null> => {
    const res = await fetchImpl(base + file, { timeoutMs: 15_000 });
    if (res.status === 404) return null;
    if (res.status !== 200) throw bad(`${file}: HTTP ${res.status}`);
    if (res.body.byteLength > max) throw bad(`${file} is larger than ${max} bytes`);
    return Buffer.from(res.body).toString('utf8');
  };
  const skill = await get('SKILL.md', STORES.skill.bodyMax * 2);
  if (skill === null) throw bad('no SKILL.md at that url');
  const { description, body } = parseDoc(skill);
  const entry = writeDoc(userId, 'skill', name, description || name, body);
  const dir = path.join(storeDir(userId, 'skill'), entry.name);
  const files: string[] = [];
  const tool = await get('tool.js', SKILL_FILE_MAX);
  if (tool !== null) {
    fs.writeFileSync(path.join(dir, 'tool.js'), tool, { mode: 0o600 });
    files.push('tool.js');
  }
  const mcp = await get('mcp.json', MCP_JSON_MAX);
  if (mcp !== null) {
    try {
      if (parseMcpNeeds(JSON.parse(mcp)).length) {
        fs.writeFileSync(path.join(dir, 'mcp.json'), mcp, { mode: 0o600 });
        files.push('mcp.json');
      }
    } catch {
      /* not the shape we read — left out, the skill still lands */
    }
  }
  return { entry: { ...entry, files }, files };
}
