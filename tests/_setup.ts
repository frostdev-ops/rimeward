// Must be imported FIRST in every test file: db.ts reads HOMEPAGE_DATA_DIR at
// import time and caches the handle, so the env var has to exist before any
// src module is evaluated. Each test file runs in its own process, so one
// fresh temp dir per file gives full DB isolation.
import fs from 'node:fs';
import os from 'node:os';

process.env.TZ ??= 'UTC'; // pin local-time assertions (dailyClock, due dates) machine-independently
process.env.HOMEPAGE_DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/fdtest-');
// Native defaults must stay in the fixture, outside both app data and the user's Documents.
process.env.RIMEWARD_DOCUMENTS_DIR = `${process.env.HOMEPAGE_DATA_DIR}-documents`;
process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString('base64');

// Two monitors for the tests that name one. The registry loads from the
// database, so this opens it (each test file has its own temp dir anyway).
const { upsertMonitor } = await import('../src/lib/monitors.ts');
upsertMonitor({ id: 'site', label: 'example.com', group: 'Site', kind: 'http', url: 'https://example.com', method: 'HEAD' });
upsertMonitor({ id: 'self', label: 'dev server', group: 'This server', kind: 'http', url: 'http://127.0.0.1:4321/api/status', expect: [200, 401] });
