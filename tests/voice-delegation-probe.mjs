/**
 * Does the realtime voice session delegate, and how?
 *
 * The client half of this protocol is undocumented. Reading codex's own source gives the shape of
 * `delegation.created` and `delegation.context.append`, but not whether either reaches the call
 * creation path Rimeward uses (`intent=quicksilver&architecture=avas`), what closes a delegation,
 * or which context channel is silent. Those are answerable only by asking the endpoint.
 *
 * This is a probe, not a test. It is never part of `npm test` (which globs tests/*.test.ts) and it
 * creates REAL, BILLABLE calls on the connected ChatGPT account — one per case, closed on the way
 * out. Run it deliberately, on an installation that has a ChatGPT connection:
 *
 *   node --env-file=.env tests/voice-delegation-probe.mjs --check
 *   node --env-file=.env tests/voice-delegation-probe.mjs
 *   node --env-file=.env tests/voice-delegation-probe.mjs p1 p5     # a subset
 *
 * Uses the server's lease and control-channel cleanup. It refuses an existing call, never takes
 * over an orphan, and stops the run if cleanup is uncertain. No build is needed. On macOS, `say`
 * supplies synthetic speech; elsewhere set RIMEWARD_PROBE_AUDIO_DIR to a folder of case-name WAVs.
 * With several connected accounts or agent wards, select RIMEWARD_PROBE_USER / RIMEWARD_PROBE_WARD.
 *
 * Output: a transcript of every data-channel frame per probe, plus a JSON report next to it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repo, 'desktop/runtime/browsers');
process.env.HOMEPAGE_DATA_DIR ||= path.join(repo, 'data');

const CONVERSATIONAL = [
  'You are the voice of Rimeward. You are the person\'s way of talking to Rime, their agent —',
  'you are not the agent. Hold an ordinary spoken conversation. You may answer from what is',
  'already in your context. For anything else — any task, lookup, action or question about their',
  'data — hand it to Rime and say you are doing so. Never claim to have done something yourself.',
].join(' ');

/** Each probe is one call and one question of the protocol. */
const PROBES = {
  p1: {
    ask: 'Can you check whether my deploy landed?',
    question: 'Does delegation.created fire at all, and what does ack_filler say?',
    session: { instructions: CONVERSATIONAL, delegation: { type: 'client', ack_filler: true } },
    answer: null,
  },
  p2: {
    ask: 'Can you check whether my deploy landed?',
    question: 'Does one delegation.context.append on speakable get spoken, and does the turn end?',
    session: { instructions: CONVERSATIONAL, delegation: { type: 'client', ack_filler: true } },
    answer: { channel: 'speakable', text: 'Version 1.0.14 went live four minutes ago.', repeat: 1 },
  },
  p3: {
    ask: 'Can you check whether my deploy landed?',
    question: 'Codex answers then repeats the same text. Does the same id twice speak twice?',
    session: { instructions: CONVERSATIONAL, delegation: { type: 'client', ack_filler: true } },
    answer: { channel: 'speakable', text: 'Version 1.0.14 went live four minutes ago.', repeat: 2 },
  },
  p4: {
    ask: 'Can you check whether my deploy landed?',
    question: 'Answer via session.context.append only, never touching the id: does it leak or stall?',
    session: { instructions: CONVERSATIONAL, delegation: { type: 'client', ack_filler: true } },
    answer: { viaSession: true, channel: 'speakable', text: 'Version 1.0.14 went live four minutes ago.', repeat: 1 },
  },
  p5: {
    question: 'Measure each context channel in a separate call, then ask for its seeded fact.',
    session: { instructions: CONVERSATIONAL, delegation: { type: 'client', ack_filler: false } },
    variants: [
      { suffix: 'commentary', ask: 'What version is running right now?', seed: { channel: 'commentary', text: '[BACKEND] The running version is 1.0.14.' } },
      { suffix: 'omitted', ask: 'What version is running right now?', seed: { text: '[BACKEND] The running version is 1.0.14.' } },
    ],
    answer: null,
  },
  p6: {
    ask: 'What did I just tell you?',
    question: 'Compare baseline, initial_items alone, and tools alone; acceptance does not prove tools work.',
    session: {
      instructions: CONVERSATIONAL,
      delegation: { type: 'client', ack_filler: false },
    },
    variants: [
      { suffix: 'baseline', session: {} },
      { suffix: 'initial', session: { initial_items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'My favourite colour is oxblood.' }] }] } },
      { suffix: 'tools', session: { tools: [{ type: 'function', name: 'probe_tool', description: 'A probe.', parameters: { type: 'object', properties: {} } }] } },
    ],
    answer: null,
  },
};

function selectedCases(args) {
  const unknown = args.filter(name => name !== '--check' && !Object.hasOwn(PROBES, name));
  if (unknown.length) throw new Error(`Unknown probe: ${unknown.join(', ')}. Use p1–p6 or --check; no calls were created.`);
  const names = [...new Set(args.filter(name => name !== '--check'))];
  return (names.length ? names : Object.keys(PROBES)).flatMap(name => {
    const probe = PROBES[name];
    return (probe.variants ?? [{}]).map(variant => ({ ...probe, ...variant,
      name: variant.suffix ? `${name}-${variant.suffix}` : name,
      session: { ...probe.session, ...variant.session } }));
  });
}

/** Preflight is read-only: no token refresh, migrations, account changes or provider requests. */
async function preflight(cases) {
  const { default: Database } = await import('better-sqlite3');
  const filename = path.join(process.env.HOMEPAGE_DATA_DIR, 'homepage.db');
  if (!fs.existsSync(filename)) throw new Error('No Rimeward database here. Run on the installation with the ChatGPT connection.');
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  let user, ward;
  try {
    const rows = db.prepare("SELECT user_id FROM agent_accounts WHERE provider='codex' ORDER BY user_id").all();
    if (!rows.length) throw new Error('No ChatGPT connection in this database. No provider calls were made.');
    const selected = process.env.RIMEWARD_PROBE_USER;
    if (!selected && rows.length !== 1) throw new Error('Several ChatGPT accounts are connected. Set RIMEWARD_PROBE_USER explicitly.');
    user = selected ? Number(selected) : rows[0].user_id;
    if (!Number.isSafeInteger(user) || !rows.some(row => row.user_id === user)) throw new Error('RIMEWARD_PROBE_USER is not a connected ChatGPT user.');
    const raw = db.prepare('SELECT value FROM settings WHERE key=?').get(`voice:lease:${user}`)?.value;
    if (raw) {
      let until;
      try { const mark = JSON.parse(raw); until = typeof mark === 'number' ? mark : mark?.until; } catch { /* Refuse unknown state. */ }
      if (!Number.isFinite(until) || until > Date.now()) throw new Error('An active or uncertain voice lease already exists. The probe will not take it over.');
    }
    const layout = JSON.parse(db.prepare('SELECT layout_json FROM dashboards WHERE user_id=?').get(user)?.layout_json ?? '[]');
    const wards = layout.filter(value => value.type === 'agent');
    ward = process.env.RIMEWARD_PROBE_WARD;
    if (!ward && wards.length === 1) ward = wards[0].i;
    if (!ward || !wards.some(value => value.i === ward)) throw new Error('Select an existing agent ward with RIMEWARD_PROBE_WARD.');
  } finally { db.close(); }
  const { chromium } = await import('playwright-core');
  if (!fs.existsSync(chromium.executablePath())) throw new Error('The configured Playwright Chromium is not installed.');
  if (process.env.RIMEWARD_PROBE_AUDIO_DIR) {
    for (const probe of cases) if (!fs.existsSync(path.join(process.env.RIMEWARD_PROBE_AUDIO_DIR, `${probe.name}.wav`)))
      throw new Error(`Missing synthetic audio file: ${probe.name}.wav`);
  } else if (process.platform !== 'darwin') throw new Error('Set RIMEWARD_PROBE_AUDIO_DIR to a folder of case-name WAVs on this platform.');
  else execFileSync('/usr/bin/say', ['-v', '?'], { stdio: 'ignore' });
  return { user, ward, chromium };
}

function speech(probe, temp) {
  const wav = process.env.RIMEWARD_PROBE_AUDIO_DIR
    ? path.join(process.env.RIMEWARD_PROBE_AUDIO_DIR, `${probe.name}.wav`) : path.join(temp, `${probe.name}.wav`);
  if (!process.env.RIMEWARD_PROBE_AUDIO_DIR) execFileSync('/usr/bin/say', ['-o', wav, '--data-format=LEI16@16000', probe.ask], { stdio: 'ignore' });
  const bytes = fs.readFileSync(wav);
  if (bytes.length > 4 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`${probe.name}.wav must be a WAV smaller than 4 MiB.`);
  return bytes;
}

async function runProbe(page, account, probe, voice, logFile) {
  const result = { name: probe.name, question: probe.question, ask: probe.ask, created: false, log: [] };
  const owner = randomUUID();
  let call, heartbeat, heartbeatTask = Promise.resolve(), heartbeatError, logError, pageError;
  let logBytes = 0;
  await page.exposeFunction('probeFrame', frame => {
    if (logError) return;
    try {
      const line = JSON.stringify(frame) + '\n'; logBytes += Buffer.byteLength(line);
      if (logBytes > 8 * 1024 * 1024) throw new Error('Probe frame log exceeded 8 MiB.');
      result.log.push(frame); fs.appendFileSync(logFile, line, { mode: 0o600 });
    } catch (error) { logError = error; void page.close().catch(() => {}); }
  });
  const failedPage = error => { pageError ??= error; void page.close().catch(() => {}); };
  page.on('pageerror', failedPage);
  try {
    const offer = await page.evaluate(async name => {
      const context = new AudioContext(); await context.resume();
      const buffer = await context.decodeAudioData(await (await fetch(`/audio/${name}.wav`)).arrayBuffer());
      if (buffer.duration <= 0 || buffer.duration > 30) throw new Error('Synthetic speech must last between zero and 30 seconds.');
      const destination = context.createMediaStreamDestination();
      const silence = context.createConstantSource(); silence.offset.value = 0; silence.connect(destination); silence.start();
      const pc = new RTCPeerConnection(), channel = pc.createDataChannel('oai-events');
      const frames = [], pendingLogs = [];
      let phase = 'connecting';
      const record = (dir, raw) => {
        if (raw.length > 100_000 || frames.length >= 10_000) throw new Error('Probe event bound exceeded.');
        const frame = { at: Date.now(), phase, dir, raw }; frames.push(frame);
        pendingLogs.push(window.probeFrame(frame));
      };
      channel.onmessage = event => record('in', String(event.data));
      pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
      const audio = new Audio(); audio.autoplay = true;
      pc.ontrack = event => { audio.srcObject = new MediaStream([event.track]); void audio.play(); };
      Object.assign(window, { pc, channel, frames, pendingLogs,
        setPhase: value => { phase = value; },
        send: message => { const raw = JSON.stringify(message); record('out', raw); channel.send(raw); },
        speak: () => new Promise(resolve => {
          const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
          source.onended = () => { source.disconnect(); resolve(); }; source.start();
        }),
        cleanup: async () => { destination.stream.getTracks().forEach(track => track.stop()); silence.stop(); pc.close(); audio.pause(); audio.srcObject = null; await context.close(); },
      });
      await pc.setLocalDescription(await pc.createOffer());
      return pc.localDescription.sdp;
    }, probe.name);
    call = await voice.probeVoiceCall(account.user, account.ward, { action: 'start', owner, sdp: offer }, probe.session);
    result.created = true;
    const pulse = () => {
      heartbeatTask = voice.voiceAction(account.user, account.ward, `probe:${process.pid}`, { action: 'status', owner, lease: call.lease })
        .then(status => {
          result.usage = status.usage;
          if (!status.active) throw new Error('The voice lease is no longer active.');
          heartbeat = setTimeout(pulse, 15_000);
        }).catch(error => { heartbeatError = error; void page.close().catch(() => {}); });
    };
    heartbeat = setTimeout(pulse, 15_000);
    await page.evaluate(sdp => window.pc.setRemoteDescription({ type: 'answer', sdp }), call.sdp);
    await page.waitForFunction(() => window.channel.readyState === 'open' && window.pc.connectionState === 'connected', null, { timeout: 30_000 });
    if (probe.seed) {
      await page.evaluate(seed => {
        window.setPhase('seed');
        window.send({ type: 'session.context.append', ...(seed.channel ? { channel: seed.channel } : {}), content: [{ type: 'input_text', text: seed.text }] });
      }, probe.seed);
      // Observe seed-only output before sending the question. Each channel gets its own call.
      await page.waitForTimeout(4000);
    }
    await page.evaluate(async () => { window.setPhase('question'); await window.speak(); });
    await page.waitForTimeout(12_000);
    if (probe.answer) {
      const id = await page.evaluate(() => window.frames.map(frame => { try { return JSON.parse(frame.raw); } catch { return null; } })
        .find(event => event?.type === 'delegation.created')?.item?.id);
      if (typeof id === 'string' || probe.answer.viaSession) {
        for (let i = 0; i < probe.answer.repeat; i++) {
          await page.evaluate(answer => {
            window.setPhase(`answer-${answer.index + 1}`);
            window.send({ type: answer.viaSession ? 'session.context.append' : 'delegation.context.append',
              ...(!answer.viaSession ? { delegation_item_id: answer.id } : {}),
              ...(answer.channel ? { channel: answer.channel } : {}), content: [{ type: 'input_text', text: answer.text }] });
          }, { ...probe.answer, id, index: i });
          await page.waitForTimeout(6000);
        }
      } else result.note = 'No delegation.created item id was observed; no answer was injected.';
      await page.waitForTimeout(8000);
    }
    if (heartbeatError) throw heartbeatError;
    const stats = await page.evaluate(async () => [...(await window.pc.getStats()).values()]
      .filter(value => value.type === 'inbound-rtp' && value.kind === 'audio')
      .map(value => ({ bytesReceived: value.bytesReceived, packetsReceived: value.packetsReceived, totalAudioEnergy: value.totalAudioEnergy })));
    result.audio = stats;
  } catch (error) { result.error = logError?.message ?? pageError?.message ?? heartbeatError?.message ?? error.message; result.status = error.status; }
  finally {
    clearTimeout(heartbeat); await heartbeatTask; clearTimeout(heartbeat);
    if (call?.lease) {
      try {
        await page.evaluate(() => { window.setPhase('closing'); }).catch(() => {});
        const stopped = await voice.voiceAction(account.user, account.ward, `probe:${process.pid}`, { action: 'stop', owner, lease: call.lease });
        result.closed = stopped.closed === true;
      } catch { result.closed = false; }
    } else {
      // A failed create may still have admitted a call; its server-side tombstone remains authoritative.
      result.closed = await voice.shutdownVoice();
    }
    try {
      if (!page.isClosed()) await page.evaluate(async () => { await Promise.all(window.pendingLogs ?? []); });
    } catch { result.error ??= 'The frame log could not be completed.'; }
    finally {
      await page.evaluate(async () => { await window.cleanup?.(); }).catch(() => {});
      page.off('pageerror', failedPage);
      if (logError || pageError) result.error ??= (logError ?? pageError).message;
    }
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2), cases = selectedCases(args);
  const account = await preflight(cases);
  if (args.includes('--check')) { console.log(`Preflight passed for ${cases.length} cases. No credentials refreshed or provider calls made.`); return; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-voice-probe-'));
  const outDir = path.resolve(process.env.RIMEWARD_PROBE_DIR ?? temp);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const report = path.join(outDir, `voice-delegation-${randomUUID()}.json`), results = [];
  let browser, page, interrupted = false;
  const audio = new Map(cases.map(probe => [`/audio/${probe.name}.wav`, speech(probe, temp)]));
  const server = createServer((request, response) => {
    const bytes = audio.get(request.url);
    response.writeHead(bytes || request.url === '/' ? 200 : 404, { 'content-type': bytes ? 'audio/wav' : 'text/html', 'cache-control': 'no-store' });
    response.end(bytes ?? '<!doctype html><title>Voice protocol probe</title>');
  });
  const interrupt = () => { interrupted = true; void page?.close().catch(() => {}); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const voice = await import('../src/lib/agent/voice.ts');
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    browser = await account.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], ignoreDefaultArgs: ['--mute-audio'] });
    for (const probe of cases) {
      if (interrupted) throw new Error('Probe interrupted.');
      page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      console.log(`${probe.name}: ${probe.question}`);
      const result = await runProbe(page, account, probe, voice, path.join(outDir, `${path.basename(report, '.json')}-${probe.name}.ndjson`));
      results.push(result);
      fs.writeFileSync(report, JSON.stringify(results, null, 2), { mode: 0o600 });
      await page.close(); page = undefined;
      console.log(`  created=${result.created}, cleanupConfirmed=${result.closed}, frames=${result.log.length}${result.error ? `, error=${result.error}` : ''}`);
      if (result.error || !result.closed) process.exitCode = 1;
      if (!result.closed) throw new Error('Provider cleanup was not acknowledged. Stopping before any further call.');
      if (result.error && !result.status) throw new Error('Probe transport or recording failed. Stopping before any further call.');
    }
  } finally {
    await voice.shutdownVoice();
    await browser?.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    fs.writeFileSync(report, JSON.stringify(results, null, 2), { mode: 0o600 });
    console.log(`Report: ${report}`);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
