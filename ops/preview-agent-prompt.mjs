// node ops/preview-agent-prompt.mjs > tmp/rime-system-prompt.md
// Uses the real prompt builders with disposable example data, never a live profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rime-prompt-'));
process.env.HOMEPAGE_DATA_DIR = directory; // Must precede all application imports.
process.env.RIMEWARD_DESKTOP = '0';
process.env.TZ = 'America/New_York';
let db;
try {
  const { getDb } = await import('../src/lib/db.ts');
  const { buildInstructions, detailedInstructions } = await import('../src/lib/agent/core.ts');
  const { workDir, NOTES_FILE } = await import('../src/lib/agent/history.ts');
  const cfg = {
    provider: 'codex', model: 'example-model', effort: 'medium',
    tools: 'all', approvals: 'outbound', headlessCap: 6,
    persona: 'Explain your work clearly and keep answers concise.',
  };
  db = getDb();
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO users (email, password_hash, role) VALUES ('example@example.invalid', 'unused', 'admin')",
  ).run();
  const user = Number(lastInsertRowid), ward = 'agent-example';
  // Seed directly: no dashboard-change events, browser launches or indexing jobs.
  db.prepare('INSERT INTO dashboards (user_id, layout_json) VALUES (?, ?)').run(user, JSON.stringify([
    { i: ward, type: 'agent', size: '2x2', config: cfg },
    { i: 'browser-example', type: 'browser', size: '4x3' },
    { i: 'agent-peer', type: 'agent', size: '2x2', config: { ...cfg, title: 'Research', persona: 'Research and summarize sources.' } },
  ]));
  fs.writeFileSync(path.join(workDir(user), NOTES_FILE), '# Example standing notes\nThe user prefers concise answers.\n');
  const child = { task: 'child-example', reason: 'Review the example project and report findings' };
  const sections = [
    '# Rime prompt example',
    'Generated from src/lib/agent/core.ts using synthetic data. Server runtime, outbound approvals, example model/persona, a browser and peer agent, no saved skills or memories, and no running children. No model request is made.',
    '## Initial system prompt — buildInstructions()',
    buildInstructions(cfg, user, ward, undefined, 1),
    '## Detailed guidance — detailedInstructions()',
    'This full reference is available through agent_help(topic: all). Normal calls return only the requested topic (general by default), with pagination. It is NOT appended to the initial system prompt.',
    detailedInstructions(cfg, user, ward, undefined, 1),
    '## Child system prompt — buildInstructions(child)',
    'An alternative initial prompt for a child run, not an additional parent prompt block.',
    buildInstructions(cfg, user, ward, child, 2),
    '## Child delegation help — agent_help(topic: delegation)',
    detailedInstructions(cfg, user, ward, child, 2, 'delegation'),
    '## Runtime assembly',
    'runLoop appends an observation-only restriction for monitor-triggered turns and retrieved memory/skill passages to buildInstructions(). This ordinary example has neither. Persona, standing notes, project context, child status and retrieved passages vary by account and turn. Provider adapters send the result as instructions (Codex) or a system message (OpenRouter); tool schemas and conversation messages are separate.',
  ];
  process.stdout.write(`${sections.join('\n\n')}\n`);
} finally {
  db?.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
