#!/usr/bin/env node
// Rimeward operator CLI. Every command runs through src/lib — imported lazily,
// AFTER .env is loaded, because db.ts reads HOMEPAGE_DATA_DIR at import time.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(import.meta.dirname, '..');
const CWD = process.cwd();
const findUp = (rel) => [CWD, ROOT].map((d) => path.join(d, rel)).find((p) => fs.existsSync(p));

const ENV_PATH = findUp('.env');
if (ENV_PATH) process.loadEnvFile(ENV_PATH); // never overwrites what is already in process.env
// db.ts resolves migrations/ and the default data dir from cwd; the lib only ever runs from the repo.
process.chdir(ROOT);

const lib = (m) => import(pathToFileURL(path.join(ROOT, 'src/lib', m)).href);
const out = (s) => process.stdout.write(s + '\n');
class Usage extends Error {}

const USAGE = `usage: rimeward <command> [options]

  users list
  users create <email> [--admin] [--password <pw> | --sso]
  users passwd <email> [--password <pw>]
  users role <email> admin|member
  users delete <email>

  settings list
  settings get <key>
  settings set <key> <value>
  settings unset <key>

  splash [--name <site name>] [--tagline <text>] [--footer <text>] [--cards <file.json>]
         (an empty string clears a value; no flags prints the current values)

  brand list
  brand install <slot> <file>      slots: wordmark emblem mark (png|webp|svg)
  brand remove <slot>                     favicon apple-touch-icon icon-512 (png)

  monitors list
  monitors add --label <text> --group <title|id> --kind http|tcp|pm2|docker|systemd [--id <slug>]
               http: --url <url> [--method GET|HEAD] [--expect 200,401]   tcp: --host <h> --port <n>
               pm2: --name <process>   docker: --container <name>   systemd: --unit <unit>
  monitors remove <id>
  monitors import <targets.json>   (the old file's shape: { groups, targets })

  doctor
  backup <dir>
  restore <dir>

rimeward <command> --help prints that command's usage.`;

const groupUsage = (name) => {
  const lines = USAGE.split('\n').filter((l) => l.trim().startsWith(name) || (name === 'brand' && l.includes('favicon')));
  return `usage:\n${lines.join('\n')}`;
};

/** parseArgs with usage errors mapped to exit 2, --help to that group's usage. */
function parse(name, args, options = {}) {
  let r;
  try {
    r = parseArgs({ args, options: { ...options, help: { type: 'boolean', short: 'h' } }, allowPositionals: true });
  } catch (e) {
    throw new Usage(`${e.message}\n${groupUsage(name)}`);
  }
  if (r.values.help) {
    out(groupUsage(name));
    process.exit(0);
  }
  return r;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------- users
async function users(args) {
  const { values: v, positionals: [sub, email, extra] } = parse('users', args, {
    admin: { type: 'boolean' },
    password: { type: 'string' },
    sso: { type: 'boolean' },
  });
  const u = await lib('users.ts');
  const byEmail = (e) => {
    if (!e) throw new Usage(groupUsage('users'));
    const row = u.getUserByEmail(e);
    if (!row) throw new Error(`no such user: ${e}`);
    return row;
  };
  switch (sub) {
    case 'list':
      for (const r of u.listUsers())
        out(`${r.id} ${r.email} ${r.role} password=${r.has_password ? 'yes' : 'no'} created=${r.created_at}`);
      return;
    case 'create': {
      const e = String(email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(e)) throw new Error(`not an email address: ${email ?? ''}`);
      if (v.password && v.sso) throw new Usage('--password and --sso are exclusive');
      if (u.emailInUse(e)) throw new Error(`email already in use: ${e}`);
      const role = v.admin ? 'admin' : 'member';
      if (v.sso) {
        const id = u.createUser(e, null, role);
        out(`created: ${id} ${e} ${role} (SSO invite, no password)`);
        return;
      }
      const pw = v.password || u.generatePassword();
      const id = u.createUser(e, pw, role);
      out(`created: ${id} ${e} ${role}`);
      if (!v.password) out(`password: ${pw}`);
      return;
    }
    case 'passwd': {
      const row = byEmail(email);
      const pw = v.password || u.generatePassword();
      u.setUserPassword(row.id, pw);
      out(`password set: ${row.email} (every session of this user ended)`);
      if (!v.password) out(`password: ${pw}`);
      return;
    }
    case 'role': {
      const row = byEmail(email);
      if (extra !== 'admin' && extra !== 'member') throw new Usage('role must be admin or member');
      u.setUserRole(row.id, extra);
      out(`role set: ${row.email} ${extra}`);
      return;
    }
    case 'delete': {
      const row = byEmail(email);
      u.deleteUser(row.id);
      out(`deleted: ${row.email}`);
      return;
    }
    default:
      throw new Usage(groupUsage('users'));
  }
}

// ------------------------------------------------------------- settings
const HIDDEN_KEY = /^(secret:|mcp_token:|comms_)|token/i;

async function settings(args) {
  const { positionals: [sub, key, value] } = parse('settings', args);
  const s = await lib('settings.ts');
  switch (sub) {
    case 'list': {
      const { getDb } = await lib('db.ts');
      // No list helper in settings.ts; a read of the whole table is the one raw query here.
      for (const r of getDb().prepare('SELECT key, value FROM settings ORDER BY key').all()) {
        const val = HIDDEN_KEY.test(r.key) ? '<hidden>' : r.value.replace(/\n/g, '\\n');
        out(`${r.key} = ${val.length > 80 ? val.slice(0, 79) + '…' : val}`);
      }
      return;
    }
    case 'get': {
      if (!key) throw new Usage(groupUsage('settings'));
      const val = s.getSetting(key);
      if (val === null) throw new Error(`no such setting: ${key}`);
      out(val);
      return;
    }
    case 'set':
      if (!key || value === undefined) throw new Usage(groupUsage('settings'));
      s.setSetting(key, value);
      out(`set: ${key}`);
      return;
    case 'unset':
      if (!key) throw new Usage(groupUsage('settings'));
      s.deleteSetting(key);
      out(`unset: ${key}`);
      return;
    default:
      throw new Usage(groupUsage('settings'));
  }
}

// --------------------------------------------------------------- splash
const SPLASH_KEYS = { name: 'site_name', tagline: 'site_tagline', footer: 'site_footer', cards: 'splash_cards' };

async function parseCards(file) {
  let cards;
  try {
    cards = JSON.parse(fs.readFileSync(path.resolve(CWD, file), 'utf8'));
  } catch (e) {
    throw new Error(`cards: ${e.message}`);
  }
  // The same bounds the admin form and the splash apply (src/lib/site.ts).
  const { validateCards } = await lib('site.ts');
  return JSON.stringify(validateCards(cards));
}

async function splash(args) {
  const { values: v } = parse('splash', args, {
    name: { type: 'string' },
    tagline: { type: 'string' },
    footer: { type: 'string' },
    cards: { type: 'string' },
  });
  const s = await lib('settings.ts');
  const given = Object.keys(SPLASH_KEYS).filter((k) => v[k] !== undefined);
  if (!given.length) {
    for (const [flag, key] of Object.entries(SPLASH_KEYS)) out(`${key} = ${s.getSetting(key) ?? '(unset)'}`);
    return;
  }
  for (const flag of given) {
    const key = SPLASH_KEYS[flag];
    if (v[flag] === '') {
      s.deleteSetting(key);
      out(`cleared: ${key}`);
      continue;
    }
    s.setSetting(key, flag === 'cards' ? await parseCards(v.cards) : v[flag]);
    out(`set: ${key}`);
  }
}

// ---------------------------------------------------------------- brand
// Mirrors src/lib/brand-files.ts (which the CLI cannot import: brand.ts beside
// it pulls .svg files in as Astro components). Rasters are normalised on
// install so the /brand route stays a plain file read: the art slots become
// webp bounded by width, the icon slots exact-square png; svg passes through.
const SLOTS = {
  wordmark: ['svg', 'webp', 'png'],
  emblem: ['svg', 'webp', 'png'],
  mark: ['svg', 'webp', 'png'],
  favicon: ['png'],
  'apple-touch-icon': ['png'],
  'icon-512': ['png'],
};
const RASTER = { wordmark: { width: 1280 }, emblem: { width: 1024 }, mark: { width: 256 }, favicon: { square: 64 }, 'apple-touch-icon': { square: 180 }, 'icon-512': { square: 512 } };

async function brand(args) {
  const { positionals: [sub, slot, file] } = parse('brand', args);
  const { DATA_DIR } = await lib('db.ts');
  const dir = path.join(DATA_DIR, 'brand');
  const candidates = (s) => SLOTS[s].map((ext) => path.join(dir, `${s}.${ext}`));
  const checkSlot = (s) => {
    if (!SLOTS[s]) throw new Usage(`unknown slot: ${s ?? ''} (${Object.keys(SLOTS).join(' ')})`);
  };
  switch (sub) {
    case 'list':
      for (const s of Object.keys(SLOTS)) out(`${s}: ${candidates(s).find((p) => fs.existsSync(p)) ?? 'built-in'}`);
      return;
    case 'install': {
      checkSlot(slot);
      if (!file) throw new Usage(groupUsage('brand'));
      const src = path.resolve(CWD, file);
      if (!fs.existsSync(src)) throw new Error(`no such file: ${src}`);
      const ext = path.extname(src).slice(1).toLowerCase();
      const spec = RASTER[slot];
      let dest;
      if (ext === 'svg') {
        if (!SLOTS[slot].includes('svg')) throw new Error(`${slot} needs a raster image (png, jpg, webp), not svg`);
        fs.mkdirSync(dir, { recursive: true });
        for (const p of candidates(slot)) fs.rmSync(p, { force: true });
        dest = path.join(dir, `${slot}.svg`);
        fs.copyFileSync(src, dest);
      } else {
        const { default: sharp } = await import('sharp');
        const img = sharp(src);
        await img.metadata().catch(() => {
          throw new Error(`${file}: not an image sharp can read (png, jpg, webp, svg)`);
        });
        fs.mkdirSync(dir, { recursive: true });
        for (const p of candidates(slot)) fs.rmSync(p, { force: true });
        if (spec.square) {
          dest = path.join(dir, `${slot}.png`);
          await img.resize(spec.square, spec.square, { fit: 'cover' }).png().toFile(dest);
        } else {
          dest = path.join(dir, `${slot}.webp`);
          await img.resize({ width: spec.width, withoutEnlargement: true }).webp({ quality: 90 }).toFile(dest);
        }
      }
      out(`installed: ${slot} -> ${dest}`);
      return;
    }
    case 'remove': {
      checkSlot(slot);
      const had = candidates(slot).filter((p) => fs.existsSync(p));
      for (const p of had) fs.rmSync(p);
      out(had.length ? `removed: ${had.join(' ')}` : `${slot}: built-in (nothing to remove)`);
      return;
    }
    default:
      throw new Usage(groupUsage('brand'));
  }
}

// ------------------------------------------------------------- monitors
async function monitors(args) {
  const { positionals: [sub, arg], values: v } = parse('monitors', args, {
    id: { type: 'string' }, label: { type: 'string' }, group: { type: 'string' }, kind: { type: 'string' },
    url: { type: 'string' }, method: { type: 'string' }, expect: { type: 'string' },
    host: { type: 'string' }, port: { type: 'string' },
    name: { type: 'string' }, container: { type: 'string' }, unit: { type: 'string' },
  });
  const m = await lib('monitors.ts');
  const { TARGETS, GROUP_TITLES, describeTarget } = await lib('targets.ts');
  await (await lib('db.ts')).getDb(); // loads the registry
  switch (sub) {
    case 'list':
      for (const t of TARGETS) out(`${t.id}\t${t.kind}\t${GROUP_TITLES[t.group] ?? t.group}\t${t.label}\t${describeTarget(t)}`);
      if (!TARGETS.length) out('(no monitors)');
      return;
    case 'add': {
      const t = m.upsertMonitor(v);
      out(`saved: ${t.id} (${t.kind}, ${GROUP_TITLES[t.group] ?? t.group}) — ${describeTarget(t)}`);
      return;
    }
    case 'remove':
      if (!arg) throw new Usage(groupUsage('monitors'));
      out(m.deleteMonitor(arg) ? `removed: ${arg}` : `no such monitor: ${arg}`);
      return;
    case 'import': {
      if (!arg) throw new Usage(groupUsage('monitors'));
      const json = JSON.parse(fs.readFileSync(path.resolve(CWD, arg), 'utf8'));
      out(`imported: ${m.importTargets(json)} monitors`);
      return;
    }
    default:
      throw new Usage(groupUsage('monitors'));
  }
}

// --------------------------------------------------------------- doctor
const onPath = (bin) => {
  const isExe = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (path.isAbsolute(bin)) return isExe(bin) ? bin : undefined;
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, bin)).find(isExe);
};

async function doctor() {
  let failed = false;
  const say = (level, msg) => {
    if (level === 'fail') failed = true;
    out(`${level.padEnd(4)} ${msg}`);
  };
  const env = (k) => (process.env[k] ?? '').trim();

  const [maj, min] = process.versions.node.split('.').map(Number);
  say(maj > 22 || (maj === 22 && min >= 18) ? 'ok' : 'fail', `node: ${process.versions.node} (need >= 22.18)`);
  say(ENV_PATH ? 'ok' : 'warn', ENV_PATH ? `.env: ${ENV_PATH}` : '.env: not found in cwd or repo root');

  const base = env('PUBLIC_BASE_URL');
  let baseOk = false;
  try {
    baseOk = /^https?:$/.test(new URL(base).protocol);
  } catch {}
  say(baseOk ? 'ok' : 'fail', baseOk ? `PUBLIC_BASE_URL: ${base}` : `PUBLIC_BASE_URL: ${base ? 'not an http(s) URL' : 'unset'}`);

  const keyLen = Buffer.from(env('TOKEN_ENC_KEY'), 'base64').length;
  say(keyLen === 32 ? 'ok' : 'fail', keyLen === 32 ? 'TOKEN_ENC_KEY: 32 bytes' : `TOKEN_ENC_KEY: ${env('TOKEN_ENC_KEY') ? `decodes to ${keyLen} bytes, need 32` : 'unset'} (openssl rand -base64 32)`);

  for (const [name, id, secret] of [
    ['Google', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    ['Microsoft', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET'],
    ['Notion', 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET'],
    ['Zoho', 'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET'],
  ]) {
    const n = (env(id) ? 1 : 0) + (env(secret) ? 1 : 0);
    say(n === 1 ? 'warn' : 'ok', `${name} OAuth: ${n === 2 ? 'configured' : n === 0 ? 'absent' : `half a pair (${env(id) ? secret : id} missing)`}`);
  }

  const sso = env('SSO_WORKSPACE_DOMAIN');
  say(sso ? 'ok' : 'warn', sso ? `SSO_WORKSPACE_DOMAIN: ${sso}` : 'SSO_WORKSPACE_DOMAIN: unset — Google sign-in only for invited rows');

  const { DATA_DIR, getDb } = await lib('db.ts');
  let writable = false;
  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    writable = true;
  } catch {}
  say(writable ? 'ok' : 'fail', `data dir: ${DATA_DIR}${writable ? '' : ' (not writable)'}`);
  let db;
  try {
    db = getDb();
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM applied_migrations').get();
    say('ok', `migrations: ${n} applied`);
  } catch (e) {
    say('fail', `migrations: ${e.message}`);
  }
  if (db) {
    const { userCount } = await lib('users.ts');
    const n = userCount();
    say(n ? 'ok' : 'fail', n ? `users: ${n}` : 'users: no users — run: rimeward users create <email> --admin');
  }

  // The registry loaded when the database opened (the migrations check above).
  const { TARGETS } = await lib('targets.ts');
  const kinds = [...new Set(TARGETS.map((t) => t.kind))];
  say(TARGETS.length ? 'ok' : 'warn', TARGETS.length ? `monitors: ${TARGETS.length} (${kinds.join(', ')})` : 'monitors: none yet — /admin/monitors, or: rimeward monitors import <targets.json>');
  {
    for (const [kind, envVar, def] of [['pm2', 'PM2_BIN', 'pm2'], ['docker', 'DOCKER_BIN', 'docker'], ['systemd', 'SYSTEMCTL_BIN', 'systemctl']]) {
      if (!kinds.includes(kind)) continue;
      const bin = env(envVar) || def;
      const found = onPath(bin);
      say(found ? 'ok' : 'warn', found ? `${kind}: ${found}` : `${kind}: ${bin} not found (set ${envVar})`);
    }
  }

  const exe = env('BROWSER_EXECUTABLE');
  if (exe) say(onPath(exe) ? 'ok' : 'fail', `chromium: BROWSER_EXECUTABLE ${exe}${onPath(exe) ? '' : ' is not an executable file'}`);
  else {
    let p;
    try {
      p = (await import('playwright-core')).chromium.executablePath();
    } catch {}
    say(p && fs.existsSync(p) ? 'ok' : 'warn', p && fs.existsSync(p) ? `chromium: ${p}` : 'chromium: not installed — run: npx playwright-core install chromium');
    if (process.getuid?.() === 0) say('warn', 'chromium: running as root without BROWSER_EXECUTABLE — no sandbox (ops/browser-setup.sh)');
  }

  say('ok', `TZ: ${env('TZ') || Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  if (failed) process.exit(1);
}

// ----------------------------------------------------- backup / restore
const DATA_SUBDIRS = ['backgrounds', 'attachments', 'agent', 'browser', 'browser-downloads', 'brand'];

async function backup(args) {
  const { positionals: [dirArg] } = parse('backup', args);
  if (!dirArg) throw new Usage(groupUsage('backup'));
  const dir = path.resolve(CWD, dirArg);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`refusing: ${dir} exists and is not empty`);
  fs.mkdirSync(dir, { recursive: true });
  const { DATA_DIR, getDb } = await lib('db.ts');
  await getDb().backup(path.join(dir, 'homepage.db'));
  out('copied: homepage.db');
  for (const sub of DATA_SUBDIRS) {
    if (!fs.existsSync(path.join(DATA_DIR, sub))) continue;
    fs.cpSync(path.join(DATA_DIR, sub), path.join(dir, sub), { recursive: true });
    out(`copied: ${sub}/`);
  }
  out('remember: TOKEN_ENC_KEY from .env is part of this backup');
}

async function restore(args) {
  const { positionals: [dirArg] } = parse('restore', args);
  if (!dirArg) throw new Usage(groupUsage('restore'));
  const dir = path.resolve(CWD, dirArg);
  const src = path.join(dir, 'homepage.db');
  if (!fs.existsSync(src)) throw new Error(`refusing: ${src} does not exist`);
  const { DATA_DIR } = await lib('db.ts');
  const dest = path.join(DATA_DIR, 'homepage.db');
  const wal = `${dest}-wal`;
  if (fs.existsSync(wal) && Date.now() - fs.statSync(wal).mtimeMs < 30_000)
    throw new Error(`refusing: ${wal} was written in the last 30 s — stop the server first`);
  fs.copyFileSync(src, dest);
  fs.rmSync(wal, { force: true });
  fs.rmSync(`${dest}-shm`, { force: true });
  out(`restored: ${dest}`);
  for (const sub of DATA_SUBDIRS) {
    if (!fs.existsSync(path.join(dir, sub))) continue;
    fs.cpSync(path.join(dir, sub), path.join(DATA_DIR, sub), { recursive: true });
    out(`restored: ${sub}/`);
  }
}

// ----------------------------------------------------------------- main
const COMMANDS = { users, settings, splash, brand, monitors, doctor, backup, restore };

try {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    out(USAGE);
  } else if (!COMMANDS[cmd]) {
    throw new Usage(`unknown command: ${cmd}\n${USAGE}`);
  } else {
    await COMMANDS[cmd](rest);
  }
} catch (e) {
  console.error(e.message);
  process.exit(e instanceof Usage ? 2 : 1);
}
