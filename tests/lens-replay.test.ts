import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, replay } from './lens-replay.ts';

/** Every fixture in the directory, so a new one is covered by adding the file. */
const FILES = fs
  .readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.jsonl'))
  .sort();

/** The plan's budget for the ten minute fixture, and the guard on replay speed. */
const BUDGET_MS = 1500;

test('every lens fixture replays with no failures', async (t) => {
  assert.ok(FILES.length >= 21, `expected the lifted fixtures plus the terminal ones, found ${FILES.length}`);
  for (const file of FILES) {
    await t.test(file, async () => {
      const report = await replay(path.join(FIXTURES, file));
      const counts = [...report.deliveries]
        .map(([id, list]) => `${id}=${list.length}`)
        .sort()
        .join(' ');
      console.log(
        `  ${file.padEnd(30)} ${String(report.steps).padStart(5)} steps  ${String(report.elapsedMs).padStart(5)} ms  deliveries ${counts || '(none)'}`
      );
      assert.deepEqual(
        report.failures,
        [],
        report.failures.map((f) => `line ${f.line}: expected ${f.expect}, got ${f.actual}`).join('\n')
      );
    });
  }
});

test('the ten minute fixture replays inside the budget', async () => {
  const report = await replay('normal-work-10min.jsonl');
  assert.deepEqual(report.failures, []);
  console.log(`  normal-work-10min            ${report.steps} steps  ${report.elapsedMs} ms`);
  assert.ok(report.elapsedMs < BUDGET_MS, `replay took ${report.elapsedMs} ms, budget ${BUDGET_MS} ms`);
});
