/**
 * Does the realtime voice session delegate, and how?
 *
 * The client half of this protocol is undocumented. Reading codex's own source gives the shape of
 * `delegation.created` and `delegation.context.append`, but not whether either reaches the call
 * creation path Rimeward uses (`intent=quicksilver&architecture=avas`), what closes a delegation,
 * or which context channel is silent. Those are answerable only by asking the endpoint.
 *
 * This is a probe, not a test. It is never part of `npm test` (which globs tests/*.test.ts) and it
 * creates REAL, BILLABLE calls on the connected ChatGPT account — one per probe, closed on the way
 * out. Run it deliberately, on an installation that has a ChatGPT connection:
 *
 *   npm run build && node --env-file=.env tests/voice-delegation-probe.mjs
 *   node --env-file=.env tests/voice-delegation-probe.mjs p1 p5     # a subset
 *
 * It talks to the provider directly rather than through Rimeward's voice route, so it takes no
 * lease — do not run it while a voice call is live in the app.
 *
 * Output: a transcript of every data-channel frame per probe, plus a JSON report next to it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-voice-probe-'));
const outDir = process.env.RIMEWARD_PROBE_DIR ?? temp;
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repo, 'desktop/runtime/browsers');

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
    ask: 'What version is running right now?',
    question: 'Which of commentary / channel-omitted is silent AND still remembered?',
    session: { instructions: CONVERSATIONAL, delegation: { type: 'client', ack_filler: false } },
    seed: [
      { channel: 'commentary', text: '[BACKEND] The running version is 1.0.14.' },
      { channel: undefined, text: '[BACKEND] The host is loothing-vps.' },
    ],
    answer: null,
  },
  p6: {
    ask: 'What did I just tell you?',
    question: 'Is initial_items accepted on the creation body? Is a tools array accepted or refused?',
    session: {
      instructions: CONVERSATIONAL,
      delegation: { type: 'client', ack_filler: false },
      initial_items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'My favourite colour is oxblood.' }] }],
      tools: [{ type: 'function', name: 'probe_tool', description: 'A probe.', parameters: { type: 'object', properties: {} } }],
    },
    answer: null,
  },
};

function speech(text) {
  const wav = path.join(temp, `${Buffer.from(text).toString('hex').slice(0, 16)}.wav`);
  if (!fs.existsSync(wav)) execFileSync('say', ['-o', wav, '--data-format=LEI16@16000', text]);
  return wav;
}

async function tokens() {
  const { ensureFreshTokens } = await import('../src/lib/agent/codex.ts');
  const { getDb } = await import('../src/lib/db.ts');
  const row = getDb().prepare("SELECT user_id FROM agent_accounts WHERE provider='codex' LIMIT 1").get();
  if (!row) throw new Error('No ChatGPT connection in this database. Connect one under Account → Agent, or run this where one exists.');
  const t = await ensureFreshTokens(row.user_id);
  if (!t.access_token || !t.account_id) throw new Error('The stored ChatGPT login did not yield a usable token.');
  return t;
}

/** Create the call upstream. Never retried: a timeout can hide a live, billable call. */
async function createCall(t, sdp, session) {
  const response = await fetch('https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${t.access_token}`, 'chatgpt-account-id': t.account_id,
      'content-type': 'application/json', 'openai-alpha': 'quicksilver=v2', originator: 'codex_cli_rs',
    },
    body: JSON.stringify({ sdp, session: { model: 'gpt-live-1-codex', audio: { output: { voice: 'cove' } }, ...session } }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return { ok: false, status: response.status, detail: detail.slice(0, 400) };
  }
  const location = response.headers.get('location') ?? '';
  return { ok: true, sdp: await response.text(), callId: new URL(location, 'https://chatgpt.com').pathname.split('/').filter(Boolean).at(-1) };
}

async function runProbe(page, t, name, probe) {
  const log = [];
  await page.exposeFunction('probeFrame', (dir, raw) => { log.push({ at: Date.now(), dir, raw }); });
  const offer = await page.evaluate(async () => {
    const pc = new RTCPeerConnection();
    const channel = pc.createDataChannel('oai-events');
    channel.onmessage = e => { window.probeFrame('in', String(e.data)); };
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc.addTrack(mic.getAudioTracks()[0], mic);
    const audio = new Audio(); audio.autoplay = true;
    pc.ontrack = e => { audio.srcObject = new MediaStream([e.track]); };
    await pc.setLocalDescription(await pc.createOffer());
    Object.assign(window, { pc, channel, send: (m) => { window.probeFrame('out', JSON.stringify(m)); channel.send(JSON.stringify(m)); } });
    return pc.localDescription.sdp;
  });

  const call = await createCall(t, offer, probe.session);
  if (!call.ok) return { name, question: probe.question, created: false, status: call.status, detail: call.detail, log };

  await page.evaluate(sdp => window.pc.setRemoteDescription({ type: 'answer', sdp }), call.sdp);
  await page.waitForFunction(() => window.channel.readyState === 'open', null, { timeout: 30_000 });

  for (const seed of probe.seed ?? []) {
    await page.evaluate(s => window.send({
      type: 'session.context.append', ...(s.channel ? { channel: s.channel } : {}),
      content: [{ type: 'input_text', text: s.text }],
    }), seed);
    await page.waitForTimeout(1500);
  }

  // The microphone is Chromium's fake device reading a file; it loops, so one pass is the question.
  await page.waitForTimeout(12_000);

  if (probe.answer) {
    const id = log.map(f => { try { return JSON.parse(f.raw); } catch { return null; } })
      .find(e => e?.type === 'delegation.created')?.item?.id;
    if (id || probe.answer.viaSession) {
      for (let i = 0; i < probe.answer.repeat; i++) {
        await page.evaluate(a => window.send(a.viaSession
          ? { type: 'session.context.append', ...(a.channel ? { channel: a.channel } : {}), content: [{ type: 'input_text', text: a.text }] }
          : { type: 'delegation.context.append', delegation_item_id: a.id, ...(a.channel ? { channel: a.channel } : {}), content: [{ type: 'input_text', text: a.text }] },
        ), { ...probe.answer, id });
        await page.waitForTimeout(6000);
      }
    }
    await page.waitForTimeout(8000);
  }

  await page.evaluate(() => { window.send({ type: 'session.close' }); window.pc.close(); });
  await page.waitForTimeout(1500);
  return { name, question: probe.question, created: true, callId: call.callId, log };
}

const wanted = process.argv.slice(2).filter(a => PROBES[a]);
const names = wanted.length ? wanted : Object.keys(PROBES);
const t = await tokens();
const { chromium } = await import('playwright-core');
const results = [];
for (const name of names) {
  const probe = PROBES[name];
  const browser = await chromium.launch({ args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${speech(probe.ask)}%noloop`, '--autoplay-policy=no-user-gesture-required',
  ] });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.error(`  ! page error: ${e.message}`); });
  console.log(`\n=== ${name}: ${probe.question}`);
  console.log(`    spoken: "${probe.ask}"`);
  try {
    const result = await runProbe(page, t, name, probe);
    results.push(result);
    if (!result.created) console.log(`    REFUSED ${result.status}: ${result.detail}`);
    for (const frame of result.log) console.log(`    ${frame.dir === 'in' ? '←' : '→'} ${frame.raw.slice(0, 600)}`);
  } catch (error) {
    console.error(`    probe failed: ${error.message}`);
    results.push({ name, question: probe.question, error: String(error) });
  } finally { await browser.close(); }
}
const report = path.join(outDir, 'voice-delegation-probe.json');
fs.writeFileSync(report, JSON.stringify(results, null, 2));
console.log(`\nReport: ${report}`);
console.log('Fold the answers into docs/agent-voice-plan.md before building on them.');
