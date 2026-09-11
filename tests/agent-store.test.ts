import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deleteDoc, docIndex, docPath, importSkill, listDocs, parseDoc, parseMcpNeeds, readDoc, storeDir, storeKind, writeDoc, STORES } from '../src/lib/agent/store.ts';
import { buildInstructions, detailedInstructions } from '../src/lib/agent/core.ts';
import { validateGraph } from '../src/lib/logic.ts';
import type { WardInstance } from '../src/lib/wards.ts';

const U = 9101;

test('store: write → list → read round-trips through the file format', () => {
  const body = 'America/New_York — every "at 7" means Eastern.';
  const e = writeDoc(U, 'memory', 'user-tz', 'The user is in New York', body);
  assert.equal(e.chars, body.length);
  assert.equal(fs.readFileSync(path.join(storeDir(U, 'memory'), 'user-tz.md'), 'utf8'), `---\ndescription: The user is in New York\n---\n${body}\n`);
  assert.equal(readDoc(U, 'memory', 'user-tz')?.body, body);
  // the same name again is a rewrite, not a second file
  writeDoc(U, 'memory', 'user-tz', 'New York, Eastern time', 'changed');
  assert.equal(listDocs(U, 'memory').length, 1);
  assert.equal(listDocs(U, 'memory')[0]!.description, 'New York, Eastern time');
  assert.ok(deleteDoc(U, 'memory', 'user-tz'));
  assert.equal(deleteDoc(U, 'memory', 'user-tz'), false);
  assert.equal(readDoc(U, 'memory', 'user-tz'), null);
});

test('store: a skill is a folder with a SKILL.md, and deleting it removes the folder', () => {
  writeDoc(U, 'skill', 'deploy-check', 'After every deploy', '1. pm2 logs\n2. curl /api/status');
  const dir = path.join(storeDir(U, 'skill'), 'deploy-check');
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')));
  assert.equal(docPath('skill', 'deploy-check'), '/work/skills/deploy-check/SKILL.md');
  assert.equal(docPath('memory', 'x'), '/work/memory/x.md');
  fs.writeFileSync(path.join(dir, 'tool.js'), '// shipped beside the skill');
  assert.deepEqual(listDocs(U, 'skill').map((d) => d.name), ['deploy-check']);
  // a stray file in the skills dir is not a skill
  fs.writeFileSync(path.join(storeDir(U, 'skill'), 'stray.md'), 'x');
  assert.deepEqual(listDocs(U, 'skill').map((d) => d.name), ['deploy-check']);
  fs.rmSync(path.join(storeDir(U, 'skill'), 'stray.md'));
  assert.ok(deleteDoc(U, 'skill', 'deploy-check'));
  assert.ok(!fs.existsSync(dir));
  assert.equal(storeKind('skill'), 'skill');
  assert.equal(storeKind('skills'), null);
});

test('store: the name is a slug, the parts are required and capped per store', () => {
  for (const bad of ['', 'Has Caps', '../x', 'a'.repeat(49), '-lead']) assert.throws(() => writeDoc(U, 'memory', bad, 'd', 'b'), /name/, bad);
  assert.throws(() => writeDoc(U, 'memory', 'ok', '   ', 'b'), /description/);
  assert.throws(() => writeDoc(U, 'memory', 'ok', 'd', ' '), /body/);
  assert.throws(() => writeDoc(U, 'memory', 'ok', 'd', 'x'.repeat(STORES.memory.bodyMax + 1)), /6000/);
  assert.doesNotThrow(() => writeDoc(U, 'skill', 'ok', 'd', 'x'.repeat(STORES.memory.bodyMax + 1)));
  assert.throws(() => writeDoc(U, 'skill', 'ok', 'd', 'x'.repeat(STORES.skill.bodyMax + 1)), /12000/);
  assert.throws(() => writeDoc(U, 'memory', 'ok', 'd'.repeat(161), 'b'), /160/);
  assert.equal(writeDoc(U, 'memory', 'ok', 'two\n  lines', 'b').description, 'two lines');
  assert.equal(readDoc(U, 'memory', '../etc/passwd'), null);
  assert.equal(deleteDoc(U, 'skill', '../work'), false);
  deleteDoc(U, 'memory', 'ok');
  deleteDoc(U, 'skill', 'ok');
});

test('store: a file the agent wrote by hand still lists, first line as its description', () => {
  fs.writeFileSync(path.join(storeDir(U, 'memory'), 'hand.md'), '# VPS backup\nNightly at 03:30 via cron.\n');
  assert.deepEqual(parseDoc('# VPS backup\nNightly at 03:30 via cron.\n'), { description: 'VPS backup', body: '# VPS backup\nNightly at 03:30 via cron.' });
  assert.equal(listDocs(U, 'memory').find((m) => m.name === 'hand')?.description, 'VPS backup');
  fs.writeFileSync(path.join(storeDir(U, 'memory'), 'Bad Name.md'), 'x');
  assert.ok(!listDocs(U, 'memory').some((m) => m.name === 'Bad Name'));
  fs.rmSync(path.join(storeDir(U, 'memory'), 'Bad Name.md'));
  deleteDoc(U, 'memory', 'hand');
});

test('store: the indexes are generated from the files, ride the prompt before the notes, and are cut at the cap', () => {
  const u = 9102;
  assert.equal(docIndex(u, 'memory'), '');
  writeDoc(u, 'memory', 'a-fact', 'first', 'x');
  writeDoc(u, 'memory', 'b-fact', 'second', 'y');
  writeDoc(u, 'skill', 'weekly-review', 'Every monday', 'steps');
  assert.equal(docIndex(u, 'memory'), '- a-fact — first\n- b-fact — second');
  assert.equal(docIndex(u, 'skill'), '- weekly-review — Every monday');
  const cfg = { provider: 'codex' as const, model: 'm', persona: '', tools: 'all' as const, approvals: 'outbound' as const, effort: 'medium' as const, headlessCap: 6 };
  const prompt = detailedInstructions(cfg, u, 'agent-x');
  assert.match(prompt, /Memory index:\n- a-fact — first\n- b-fact — second/);
  assert.match(prompt, /Skills index:\n- weekly-review — Every monday/);
  const [skills, memory, notes] = [prompt.indexOf('Skills index:'), prompt.indexOf('Memory index:'), prompt.indexOf('Your notes')];
  assert.ok(skills < memory && memory < notes, 'skills, then memory, then the notes last');
  for (let i = 0; i < 60; i++) writeDoc(u, 'memory', `bulk-${i}`, 'd'.repeat(150), 'x');
  const idx = docIndex(u, 'memory');
  assert.ok(idx.length <= STORES.memory.indexCap + 80, String(idx.length));
  assert.match(idx, /… index cut at 4000 chars \(\d+ more — ls \/work\/memory\)$/);
});

test('memory ward: a daily schedule anchors on it, wired to agent.ask', () => {
  const layout = [
    { i: 'mem', type: 'memory', size: '2x2' },
    { i: 'ag1', type: 'agent', size: '2x2' },
  ] as WardInstance[];
  const edge = {
    id: 'mem-reflect-mem',
    source: { ward: 'mem', trigger: 'at-time-of-day', params: { at: '03:00' } },
    conditions: [],
    action: { type: 'agent.ask', ward: 'ag1', params: { prompt: 'reflect' } },
    enabled: true,
  };
  assert.equal(validateGraph({ edges: [edge] }, layout, { isAdmin: true })?.edges.length, 1);
});

test('store: a ward folder imports from a URL — SKILL.md, with tool.js and mcp.json beside it', async () => {
  const u = 9103;
  const files: Record<string, string> = {
    'https://x.dev/wards/deploy-check/SKILL.md': '---\nname: deploy-check\ndescription: After every deploy\n---\n1. pm2 logs\n',
    'https://x.dev/wards/deploy-check/tool.js': 'console.log(1)',
    'https://x.dev/wards/deploy-check/mcp.json': JSON.stringify({ servers: [{ name: 'github', url: 'https://api.githubcopilot.com/mcp/' }, { name: 'bad', url: 'ftp://x' }] }),
  };
  const fetched: string[] = [];
  const fake = async (url: string) => {
    fetched.push(url);
    const t = files[url];
    return t === undefined ? { status: 404, body: new Uint8Array() } : { status: 200, body: new TextEncoder().encode(t) };
  };
  const out = await importSkill(u, 'deploy-check', 'https://x.dev/wards/deploy-check/', fake);
  assert.deepEqual(out.files, ['tool.js', 'mcp.json']);
  assert.equal(out.entry.description, 'After every deploy');
  const doc = readDoc(u, 'skill', 'deploy-check')!;
  assert.equal(doc.body, '1. pm2 logs');
  assert.deepEqual(doc.files, ['mcp.json', 'tool.js']);
  assert.deepEqual(doc.mcp, [{ name: 'github', url: 'https://api.githubcopilot.com/mcp/' }]);
  assert.deepEqual(listDocs(u, 'skill')[0]!.files, ['mcp.json', 'tool.js']);
  // the SKILL.md url names the same folder; missing extras are fine
  delete files['https://x.dev/wards/deploy-check/tool.js'];
  delete files['https://x.dev/wards/deploy-check/mcp.json'];
  assert.deepEqual((await importSkill(u, 'dc2', 'https://x.dev/wards/deploy-check/SKILL.md', fake)).files, []);
  assert.equal(fetched.at(-3), 'https://x.dev/wards/deploy-check/SKILL.md');
  await assert.rejects(importSkill(u, 'x', 'https://x.dev/nothing/', fake), /no SKILL.md/);
  await assert.rejects(importSkill(u, 'x', 'file:///etc/passwd', fake), /http/);
  await assert.rejects(importSkill(u, 'Bad Name', 'https://x.dev/wards/deploy-check/', fake), /name/);
  assert.ok(deleteDoc(u, 'skill', 'deploy-check'));
  assert.ok(deleteDoc(u, 'skill', 'dc2'));
  assert.deepEqual(parseMcpNeeds({ servers: 'nope' }), []);
});
