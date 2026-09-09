import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { DATA_DIR, getDb } from "../db.ts";
import { getSetting, setSetting } from "../settings.ts";
import { getDashboard } from "../dashboard.ts";
import { attachmentPath, storeAttachment } from "./attachments.ts";
import {
  activeConversation,
  retireConversation,
  appendItems,
  addMessage,
  type AgentStep,
  type TurnSource,
} from "./conversations.ts";
import type { AgentProviderId } from "./provider.ts";
import { INSTANCE_KEY, dashboardForSync, validateInstance, installInstance } from '../dev/instance.ts';
import { isDesktop } from '../dev/runtime.ts';
import { BG_DIR, listBackgrounds, MAX_PER_USER } from '../backgrounds.ts';
import { brandFile, BRAND_DIR, SLOTS, isSlot } from '../brand-files.ts';

export const SYNC_RECORD_MAX = 64 * 1024 * 1024;
export interface SyncRecord {
  key: string;
  hash: string;
  payload: string;
}
export interface SharedChat {
  provider: AgentProviderId;
  endpoint?: string | null;
  ward: string;
  title: string;
  device: string;
  updated: string;
  messages: {
    role: "user" | "assistant";
    text: string;
    steps?: AgentStep[];
    source?: TurnSource;
    at?: string;
  }[];
  items: unknown[];
  files: Record<string, string>;
}
interface SharedFile {
  name: string;
  mime: string;
  data: string;
  sha256: string;
  text?: string | null;
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const failure = (text: string) =>
  Object.assign(new Error(text), { status: 400 });
function assetDirectory(dir: string, create = false) {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('Shared appearance directories cannot be symlinks.');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
function agentDir(user: number, kind: "work" | "history" | "docs") {
  let dir = fs.realpathSync(DATA_DIR);
  for (const part of ["agent", String(user), kind]) {
    dir = path.join(dir, part);
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw failure("Agent data directories cannot be symlinks.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      fs.mkdirSync(dir, { mode: 0o700 });
    }
  }
  return dir;
}
export function installationId() {
  let id = getSetting("rime:installation");
  if (!id) {
    id = randomUUID();
    setSetting("rime:installation", id);
  }
  return id;
}
export function profileId(user: number) {
  let id = getSetting(`rime:profile:${user}`);
  if (!id) {
    id = randomUUID();
    setSetting(`rime:profile:${user}`, id);
  }
  return id;
}
function workParts(key: string) {
  if (!key.startsWith("work/")) throw failure("Not an agent file.");
  const parts = key.slice(5).split("/");
  if (
    parts.length > 32 ||
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[\\:]/.test(p) ||
        [...p].some((c) => c.charCodeAt(0) < 32),
    )
  )
    throw failure("Invalid agent file path.");
  return parts;
}
function workPath(user: number, key: string, create = false) {
  const parts = workParts(key);
  let target = agentDir(user, "work");
  for (const [i, part] of parts.entries()) {
    target = path.join(target, part);
    if (!fs.existsSync(target)) {
      // lstat catches dangling symlinks too.
      try {
        if (fs.lstatSync(target).isSymbolicLink())
          throw failure("Agent file symlinks are not synced.");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (create && i < parts.length - 1) fs.mkdirSync(target);
      continue;
    }
    const stat = fs.lstatSync(target);
    if (
      stat.isSymbolicLink() ||
      (i < parts.length - 1
        ? !stat.isDirectory()
        : !stat.isFile() || stat.nlink !== 1)
    )
      throw failure("Only regular agent files are synced.");
  }
  return target;
}
function readFile(file: string) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > SYNC_RECORD_MAX / 2)
      throw failure(
        "Agent file cannot be synced (regular files up to 32 MiB).",
      );
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function payloadData(payload: string): Buffer {
  const data: unknown = JSON.parse(payload);
  if (typeof data !== "string") throw failure("Invalid agent file data.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > SYNC_RECORD_MAX / 2 || bytes.toString("base64") !== data)
    throw failure("Invalid agent file data (maximum 32 MiB).");
  return bytes;
}
export function validateRecord(record: SyncRecord) {
  if (
    !record ||
    typeof record.key !== "string" ||
    record.key.length > 1024 ||
    typeof record.payload !== "string" ||
    Buffer.byteLength(record.payload) > SYNC_RECORD_MAX ||
    record.hash !== digest(record.payload)
  )
    throw failure("Invalid Rime sync record.");
  const value: unknown = JSON.parse(record.payload);
  if (record.key.startsWith('appearance/image/')) {
    if (!/^appearance\/image\/[a-f0-9]{16}$/.test(record.key)) throw failure('Invalid shared image.');
    if (value !== null) {
      const bytes = payloadData(record.payload);
      if (createHash('sha256').update(bytes).digest('hex').slice(0, 16) !== record.key.slice(17) || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw failure('Invalid shared image.');
    }
  } else if (record.key.startsWith('appearance/brand/')) {
    const slot = record.key.slice(17), asset = value as { ext: string; data: string } | null;
    if (!isSlot(slot) || !asset || !SLOTS[slot].some(ext => ext === asset.ext)) throw failure('Invalid brand asset.');
    payloadData(JSON.stringify(asset.data));
  } else if (record.key === INSTANCE_KEY) {
    validateInstance(value);
  } else if (record.key.startsWith("work/")) {
    workParts(record.key);
    if (value !== null) payloadData(record.payload);
  } else if (/^(chat|file)\/[a-f0-9-]{36}\/\d+$/.test(record.key)) {
    if (value === null) return;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw failure("Invalid shared history.");
    if (record.key.startsWith("chat/")) {
      const chat = value as SharedChat;
      if (
        !["codex", "openrouter"].includes(chat.provider) ||
        typeof chat.title !== "string" ||
        typeof chat.ward !== "string" ||
        typeof chat.device !== "string" ||
        typeof chat.updated !== "string" ||
        !Array.isArray(chat.items) ||
        !Array.isArray(chat.messages) ||
        !chat.files ||
        typeof chat.files !== "object" ||
        Array.isArray(chat.files)
      )
        throw failure("Invalid conversation.");
      for (const m of chat.messages)
        if (
          !m ||
          !["user", "assistant"].includes(m.role) ||
          typeof m.text !== "string" ||
          (m.steps !== undefined && !Array.isArray(m.steps)) ||
          (m.source !== undefined &&
            !["chat", "automation", "wake", "agent"].includes(m.source)) ||
          (m.at !== undefined && (typeof m.at !== "string" || m.at.length > 40))
        )
          throw failure("Invalid conversation message.");
      for (const [id, key] of Object.entries(chat.files))
        if (
          !/^\d+$/.test(id) ||
          typeof key !== "string" ||
          !/^file\/[a-f0-9-]{36}\/\d+$/.test(key)
        )
          throw failure("Invalid attachment reference.");
    } else {
      const file = value as SharedFile;
      if (
        typeof file.name !== "string" ||
        typeof file.mime !== "string" ||
        typeof file.data !== "string" ||
        (file.text != null && typeof file.text !== "string") ||
        createHash("sha256")
          .update(payloadData(JSON.stringify(file.data)))
          .digest("hex") !== file.sha256
      )
        throw failure("Invalid shared attachment.");
    }
  } else throw failure("Only Rime agent files and history may sync.");
}
export function syncRecord(user: number, key: string): SyncRecord | undefined {
  return getDb()
    .prepare(
      "SELECT key,hash,payload FROM agent_sync_records WHERE user_id=? AND key=?",
    )
    .get(user, key) as SyncRecord | undefined;
}
function store(user: number, key: string, value: unknown) {
  const payload = JSON.stringify(value),
    record = { key, payload, hash: digest(payload) };
  validateRecord(record);
  getDb()
    .prepare(
      "INSERT INTO agent_sync_records VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET hash=excluded.hash,payload=excluded.payload WHERE agent_sync_records.hash!=excluded.hash",
    )
    .run(user, key, record.hash, payload);
  return record;
}
/** Hash only Rime's own work directory and records. No project path is read. */
export function captureRime(user: number) {
  if (!isDesktop() || getSetting(`instance:joined:${user}`)) store(user, INSTANCE_KEY, dashboardForSync(user));
  const images = new Set<string>();
  assetDirectory(BG_DIR);
  for (const name of listBackgrounds(user)) {
    const key = `appearance/image/${name.slice(name.indexOf('-') + 1, -5)}`;
    images.add(key);
    if (!syncRecord(user, key) || syncRecord(user, key)?.payload === 'null') store(user, key, readFile(path.join(BG_DIR, name)).toString('base64'));
  }
  for (const row of getDb().prepare("SELECT key FROM agent_sync_records WHERE user_id=? AND key LIKE 'appearance/image/%' AND payload!='null'").all(user) as { key: string }[])
    if (!images.has(row.key)) store(user, row.key, null);
  if (!isDesktop()) for (const slot of Object.keys(SLOTS)) {
    assetDirectory(BRAND_DIR);
    if (!isSlot(slot)) continue;
    const file = brandFile(slot);
    store(user, `appearance/brand/${slot}`, { ext: path.extname(file).slice(1), data: readFile(file).toString('base64') });
  }
  const files = new Set<string>();
  function walk(dir: string, prefix = "work/") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.size >= 10000)
        throw failure("Rime has more than 10,000 agent files; sync paused.");
      const key = prefix + entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (key.split("/").length > 32)
          throw failure("Agent folders are nested too deeply.");
        walk(path.join(dir, entry.name), `${key}/`);
      } else if (entry.isFile()) {
        files.add(key);
        store(user, key, readFile(workPath(user, key)).toString("base64"));
      }
    }
  }
  walk(agentDir(user, "work"));
  for (const row of getDb()
    .prepare(
      "SELECT key FROM agent_sync_records WHERE user_id=? AND key LIKE 'work/%' AND payload!='null'",
    )
    .all(user) as { key: string }[]) {
    if (!files.has(row.key)) {
      // A symlink replacing a synced file is an error, never a deletion to propagate.
      workPath(user, row.key);
      store(user, row.key, null);
    }
  }
  const origin = installationId(),
    db = getDb();
  const attachments = db
    .prepare(
      "SELECT id,name,mime,sha256,text,conversation_id FROM agent_files WHERE user_id=?",
    )
    .all(user) as {
    id: number;
    name: string;
    mime: string;
    sha256: string;
    text: string | null;
    conversation_id: number | null;
  }[];
  for (const file of attachments) {
    const key = `file/${origin}/${file.id}`;
    if (!syncRecord(user, key))
      store(user, key, {
        name: file.name,
        mime: file.mime,
        sha256: file.sha256,
        text: file.text,
        data: readFile(attachmentPath(file.sha256)).toString("base64"),
      });
  }
  const wards = getDashboard(user);
  for (const conv of db
    .prepare(
      "SELECT id,ward,provider,endpoint,updated_at FROM agent_conversations WHERE user_id=? AND task_id IS NULL",
    )
    .all(user) as {
    id: number;
    ward: string;
    provider: AgentProviderId;
    endpoint: string | null;
    updated_at: string;
  }[]) {
    const messages = (
      db
        .prepare(
          "SELECT role,text,steps_json,source,at FROM agent_messages WHERE conversation_id=? ORDER BY id",
        )
        .all(conv.id) as {
        role: string;
        text: string;
        steps_json: string | null;
        source: TurnSource;
        at: string;
      }[]
    ).map((m) => ({
      role: m.role,
      text: m.text,
      source: m.source,
      at: m.at,
      ...(m.steps_json ? { steps: JSON.parse(m.steps_json) } : {}),
    }));
    if (!messages.length) continue;
    const items = (
      db
        .prepare(
          "SELECT json FROM agent_items WHERE conversation_id=? ORDER BY id",
        )
        .all(conv.id) as { json: string }[]
    ).map((i) => JSON.parse(i.json));
    const refs = Object.fromEntries(
      attachments
        .filter((f) => f.conversation_id === conv.id)
        .map((f) => [String(f.id), `file/${origin}/${f.id}`]),
    );
    store(user, `chat/${origin}/${conv.id}`, {
      provider: conv.provider,
      ...(conv.endpoint ? { endpoint: conv.endpoint } : {}),
      ward: conv.ward,
      title:
        messages.find((m) => m.role === "user")?.text.slice(0, 120) ||
        wards.find((w) => w.i === conv.ward)?.title ||
        "Rime chat",
      device: os.hostname(),
      updated: conv.updated_at,
      messages,
      items,
      files: refs,
    });
  }
}
export function syncManifest(user: number) {
  captureRime(user);
  return getDb()
    .prepare(
      "SELECT key,hash FROM agent_sync_records WHERE user_id=? ORDER BY key",
    )
    .all(user) as { key: string; hash: string }[];
}
export function refreshWorkRecord(user: number, key: string) {
  if (key === INSTANCE_KEY) {
    store(user, key, dashboardForSync(user));
    return;
  }
  if (key.startsWith('appearance/image/')) {
    assetDirectory(BG_DIR);
    const file = path.join(BG_DIR, `${user}-${key.slice(17)}.webp`);
    if (!fs.existsSync(file) && syncRecord(user, key)) store(user, key, null);
    return;
  }
  if (!key.startsWith("work/")) return;
  const target = workPath(user, key);
  if (fs.existsSync(target))
    store(user, key, readFile(target).toString("base64"));
  else if (syncRecord(user, key)) store(user, key, null);
}
export function preserveConflict(user: number, record: SyncRecord) {
  getDb()
    .prepare(
      "INSERT INTO agent_sync_conflicts(user_id,key,payload) VALUES(?,?,?)",
    )
    .run(user, record.key, record.payload);
}
function replaceFile(target: string, data: string | Buffer) {
  const temp = `${target}.rime-sync-${randomUUID()}`;
  try {
    fs.writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
/** The caller checks its base immediately before installing. Atomic file replacement. */
export function installRecord(user: number, record: SyncRecord) {
  validateRecord(record);
  if (record.key === INSTANCE_KEY) installInstance(user, JSON.parse(record.payload));
  if (record.key.startsWith('appearance/image/')) {
    assetDirectory(BG_DIR, record.payload !== 'null');
    const file = path.join(BG_DIR, `${user}-${record.key.slice(17)}.webp`);
    if (record.payload === 'null') { if (fs.existsSync(file)) fs.unlinkSync(file); }
    else {
      if (!fs.existsSync(file) && listBackgrounds(user).length >= MAX_PER_USER) throw failure('Remove an unused background before syncing more images.');
      replaceFile(file, payloadData(record.payload));
    }
  }
  if (record.key.startsWith('appearance/brand/') && isDesktop()) {
    const asset = JSON.parse(record.payload) as { ext: string; data: string }, slot = record.key.slice(17);
    assetDirectory(BRAND_DIR, true);
    replaceFile(path.join(BRAND_DIR, `${slot}.${asset.ext}`), payloadData(JSON.stringify(asset.data)));
    if (isSlot(slot)) for (const ext of SLOTS[slot]) if (ext !== asset.ext) fs.rmSync(path.join(BRAND_DIR, `${slot}.${ext}`), { force: true });
  }
  if (record.key.startsWith("work/")) {
    const target = workPath(user, record.key, record.payload !== "null");
    if (record.payload === "null") {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } else {
      replaceFile(target, payloadData(record.payload));
    }
  }
  store(user, record.key, JSON.parse(record.payload));
  if (record.payload !== "null" && record.key.startsWith("chat/")) {
    const chat = JSON.parse(record.payload) as SharedChat;
    replaceFile(
      path.join(agentDir(user, "history"), `shared-${digest(record.key)}.md`),
      `# ${chat.title}\n\n${Object.entries(chat.files)
        .map(
          ([id, key]) =>
            `Origin file_id ${id}: /docs/shared-${digest(key)}.txt (use this synced text path, not a local attachment ID)`,
        )
        .join(
          "\n",
        )}\n\n${chat.messages.map((m) => `## ${m.role}\n\n${m.text}`).join("\n\n")}`,
    );
  }
  if (record.payload !== "null" && record.key.startsWith("file/")) {
    const file = JSON.parse(record.payload) as SharedFile;
    if (typeof file.text === "string")
      replaceFile(
        path.join(agentDir(user, "docs"), `shared-${digest(record.key)}.txt`),
        file.text,
      );
  }
}
export function acceptRecord(
  user: number,
  record: SyncRecord,
  base: string | null,
) {
  validateRecord(record);
  refreshWorkRecord(user, record.key);
  const current = syncRecord(user, record.key);
  if (current?.hash === record.hash) return { ok: true, record: current }; // retry after a lost acknowledgement
  if ((current?.hash ?? null) !== base)
    return { ok: false, record: current ?? null };
  installRecord(user, record);
  return { ok: true, record };
}
export function sharedChats(user: number) {
  captureRime(user);
  return (
    getDb()
      .prepare(
        "SELECT key,payload FROM agent_sync_records WHERE user_id=? AND key LIKE 'chat/%' AND payload!='null'",
      )
      .all(user) as { key: string; payload: string }[]
  )
    .map((row) => ({
      key: row.key,
      ...(JSON.parse(row.payload) as SharedChat),
    }))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}
export async function continueSharedChat(
  user: number,
  ward: string,
  key: string,
) {
  const record = syncRecord(user, key);
  if (!key.startsWith("chat/") || !record || record.payload === "null")
    throw failure("Conversation not found.");
  const chat = JSON.parse(record.payload) as SharedChat;
  const remapped = new Map<string, number>();
  for (const [oldId, fileKey] of Object.entries(chat.files)) {
    const attachment = syncRecord(user, fileKey);
    if (!attachment || attachment.payload === "null")
      throw failure("Attachments are still syncing. Try again shortly.");
    const f = JSON.parse(attachment.payload) as SharedFile;
    const saved = await storeAttachment({
      userId: user,
      name: f.name,
      mime: f.mime,
      bytes: Buffer.from(f.data, "base64"),
      conversationId: null,
    });
    remapped.set(oldId, saved.id);
  }
  const remap = (value: unknown, name = ""): unknown => {
    if (
      (name === "file_id" || name === "fileId") &&
      remapped.has(String(value))
    )
      return remapped.get(String(value));
    if (typeof value === "string") {
      if (name === "arguments" || name === "output") {
        try {
          return JSON.stringify(remap(JSON.parse(value)));
        } catch {
          /* Plain text outputs remain text. */
        }
      }
      return value
        .replace(
          /attachment:(\d+)/g,
          (_m, id) => `attachment:${remapped.get(id) ?? id}`,
        )
        .replace(
          /file_id (\d+)/g,
          (_m, id) => `file_id ${remapped.get(id) ?? id}`,
        );
    }
    if (Array.isArray(value)) return value.map((v) => remap(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, remap(v, k)]),
      );
    return value;
  };
  retireConversation(user, ward);
  const conv = activeConversation(user, ward, chat.provider, chat.endpoint ?? null);
  for (const id of remapped.values())
    getDb()
      .prepare(
        "UPDATE agent_files SET conversation_id=? WHERE id=? AND user_id=?",
      )
      .run(conv.id, id, user);
  for (const m of chat.messages) {
    addMessage(conv, {
      ...m,
      text: remap(m.text) as string,
      steps: remap(m.steps) as AgentStep[] | undefined,
    });
    if (typeof m.at === "string")
      getDb()
        .prepare(
          "UPDATE agent_messages SET at=? WHERE id=(SELECT MAX(id) FROM agent_messages WHERE conversation_id=?)",
        )
        .run(m.at, conv.id);
  }
  appendItems(
    conv.id,
    chat.items.map((i) => remap(i)),
  );
  // No pending approvals, scheduled wakes, or commands are imported or executed.
  return conv;
}
