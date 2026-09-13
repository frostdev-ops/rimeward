import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The CLI is a separate process, so it gets its own data dir (not _setup's):
// every run below shares DATA_A, restore lands in DATA_B, doctor's empty case in DATA_EMPTY.
const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fdcli-'));
const DATA_A = tmp();
const DATA_B = tmp();
const DATA_EMPTY = tmp();
const SCRATCH = tmp();

function run(args: string[], dataDir = DATA_A) {
  const r = spawnSync(process.execPath, ['bin/rimeward.mjs', ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOMEPAGE_DATA_DIR: dataDir,
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
      PUBLIC_BASE_URL: 'http://localhost:4321',
    },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('--help prints usage, exit 0', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage: rimeward/);
  assert.match(run(['users', '--help']).out, /users create <email>/);
  assert.equal(run(['nope']).code, 2);
  assert.equal(run(['users', '--bogus']).code, 2);
});

test('users create prints a generated password once; list shows it', () => {
  const r = run(['users', 'create', 'Admin@Test.io', '--admin']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /created: 1 admin@test.io admin/);
  const pw = r.out.match(/^password: (\S+)$/m)?.[1];
  assert.ok(pw && pw.length === 20, 'generated password printed');

  assert.equal(run(['users', 'create', 'admin@test.io']).code, 1, 'duplicate refused');
  assert.equal(run(['users', 'create', 'not-an-email']).code, 1);

  const sso = run(['users', 'create', 'guest@test.io', '--sso']);
  assert.equal(sso.code, 0, sso.err);
  assert.doesNotMatch(sso.out, /^password:/m);

  const list = run(['users', 'list']);
  assert.equal(list.code, 0);
  assert.match(list.out, /^1 admin@test.io admin password=yes created=/m);
  assert.match(list.out, /^2 guest@test.io member password=no created=/m);
});

test('users role, passwd, and the last-admin / last-user guards', () => {
  const demote = run(['users', 'role', 'admin@test.io', 'member']);
  assert.equal(demote.code, 1);
  assert.match(demote.err, /only admin/);

  assert.equal(run(['users', 'role', 'guest@test.io', 'admin']).code, 0);
  // An unlinked SSO-only row is not a usable replacement administrator.
  assert.equal(run(['users', 'role', 'admin@test.io', 'member']).code, 1);
  const pw = run(['users', 'passwd', 'guest@test.io', '--password', 'hunter22']);
  assert.equal(pw.code, 0, pw.err);
  assert.match(pw.out, /session/);
  assert.doesNotMatch(pw.out, /^password:/m, 'a supplied password is not echoed');
  assert.equal(run(['users', 'role', 'admin@test.io', 'member']).code, 0);
  assert.match(run(['users', 'list']).out, /^1 admin@test.io member/m);

  const del = run(['users', 'delete', 'guest@test.io']);
  assert.equal(del.code, 1);
  assert.match(del.err, /only admin/);
  assert.equal(run(['users', 'delete', 'admin@test.io']).code, 0);
  assert.match(run(['users', 'delete', 'nobody@test.io']).err, /no such user/);
  assert.match(run(['users', 'delete', 'guest@test.io']).err, /only user/);
});

test('settings set/get/list/unset', () => {
  assert.equal(run(['settings', 'set', 'site_name', 'Rimeward']).code, 0);
  assert.equal(run(['settings', 'set', 'secret:api', 'shh']).code, 0);
  assert.equal(run(['settings', 'set', 'long', 'x'.repeat(100)]).code, 0);
  assert.equal(run(['settings', 'get', 'site_name']).out, 'Rimeward\n');
  const list = run(['settings', 'list']).out;
  assert.match(list, /^site_name = Rimeward$/m);
  assert.match(list, /^secret:api = <hidden>$/m);
  assert.match(list, /^long = x{79}…$/m);
  assert.equal(run(['settings', 'unset', 'site_name']).code, 0);
  const missing = run(['settings', 'get', 'site_name']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no such setting/);
});

test('splash writes the site rows and validates the cards file', () => {
  const cards = path.join(SCRATCH, 'cards.json');
  fs.writeFileSync(cards, JSON.stringify([{ title: 'One', blurb: 'first', extra: 1 }, { title: 'Two', blurb: 'second' }], null, 2));
  const r = run(['splash', '--name', 'Rimeward', '--tagline', 'a dashboard', '--footer', 'foot', '--cards', cards]);
  assert.equal(r.code, 0, r.err);
  assert.equal(run(['settings', 'get', 'site_tagline']).out, 'a dashboard\n');
  assert.equal(
    run(['settings', 'get', 'splash_cards']).out,
    '[{"title":"One","blurb":"first"},{"title":"Two","blurb":"second"}]\n',
    'stored compact, unknown keys dropped'
  );
  const show = run(['splash']).out;
  assert.match(show, /^site_name = Rimeward$/m);
  assert.match(show, /^site_footer = foot$/m);

  assert.equal(run(['splash', '--footer', '']).code, 0);
  assert.equal(run(['settings', 'get', 'site_footer']).code, 1, 'empty string clears the row');

  fs.writeFileSync(cards, JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ title: `c${i}`, blurb: 'b' }))));
  const seven = run(['splash', '--cards', cards]);
  assert.equal(seven.code, 1);
  assert.match(seven.err, /at most 6/);
  fs.writeFileSync(cards, JSON.stringify([{ title: 'x'.repeat(61), blurb: 'b' }]));
  assert.match(run(['splash', '--cards', cards]).err, /over 60/);
});

test('brand install/list/remove', () => {
  const png = path.join(SCRATCH, 'Logo.PNG');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  assert.match(run(['brand', 'list']).out, /^wordmark: built-in$/m);

  const r = run(['brand', 'install', 'wordmark', png]);
  assert.equal(r.code, 0, r.err);
  const dest = path.join(DATA_A, 'brand', 'wordmark.webp');
  assert.ok(fs.existsSync(dest), 'a raster is normalised to webp');
  assert.match(run(['brand', 'list']).out, new RegExp(`^wordmark: ${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));

  const svg = path.join(SCRATCH, 'logo.svg');
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal(run(['brand', 'install', 'wordmark', svg]).code, 0);
  assert.ok(!fs.existsSync(dest), 'the other extension of the slot is removed');
  assert.ok(fs.existsSync(path.join(DATA_A, 'brand', 'wordmark.svg')));

  const bad = run(['brand', 'install', 'favicon', svg]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /favicon needs a raster/);
  assert.equal(run(['brand', 'install', 'logo', png]).code, 2, 'unknown slot is a usage error');

  assert.equal(run(['brand', 'remove', 'wordmark']).code, 0);
  assert.match(run(['brand', 'list']).out, /^wordmark: built-in$/m);
});

test('doctor: 0 on the seeded dir, 1 on an empty one', () => {
  const ok = run(['doctor']);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.out, /^ok {3}users: 1$/m);
  assert.match(ok.out, /^ok {3}TOKEN_ENC_KEY: 32 bytes$/m);
  assert.doesNotMatch(ok.out, /^fail/m);

  const empty = run(['doctor'], DATA_EMPTY);
  assert.equal(empty.code, 1);
  assert.match(empty.out, /^fail users: no users — run: rimeward users create <email> --admin$/m);
});

test('backup then restore round-trips the db and the data dirs', () => {
  fs.mkdirSync(path.join(DATA_A, 'backgrounds'), { recursive: true });
  fs.writeFileSync(path.join(DATA_A, 'backgrounds', 'a.webp'), 'not really webp');
  const bak = path.join(SCRATCH, 'bak');

  const b = run(['backup', bak]);
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /^copied: homepage.db$/m);
  assert.match(b.out, /^copied: backgrounds\/$/m);
  assert.match(b.out, /TOKEN_ENC_KEY from .env is part of this backup$/m);
  assert.ok(fs.existsSync(path.join(bak, 'homepage.db')));
  assert.equal(run(['backup', bak]).code, 1, 'non-empty target refused');

  assert.equal(run(['restore', SCRATCH], DATA_B).code, 1, 'no homepage.db in the source');
  const r = run(['restore', bak], DATA_B);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^restored: backgrounds\/$/m);
  assert.equal(fs.readFileSync(path.join(DATA_B, 'backgrounds', 'a.webp'), 'utf8'), 'not really webp');
  assert.match(run(['users', 'list'], DATA_B).out, /^2 guest@test.io admin/m);
  assert.equal(run(['settings', 'get', 'site_name'], DATA_B).out, 'Rimeward\n');
});
