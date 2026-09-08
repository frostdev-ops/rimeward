// Real WebRTC transport with generated video/audio; never captures a personal screen.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const sdk = process.env.RIMEWARD_MEDIA_SDK;
const binary = process.env.RIMEWARD_MEDIA_HELPER;
const turn = process.env.RIMEWARD_MEDIA_TURN_FILE ? JSON.parse(fs.readFileSync(process.env.RIMEWARD_MEDIA_TURN_FILE, 'utf8')) : undefined;
const viewerCount = Number(process.env.RIMEWARD_MEDIA_VIEWERS ?? 1);
if (!Number.isInteger(viewerCount) || viewerCount < 1 || viewerCount > 4) throw Error('Use 1–4 test viewers.');
const duration = Number(process.env.RIMEWARD_MEDIA_DURATION_MS ?? 0), width = 1920, height = 1080;
if (!Number.isSafeInteger(duration) || duration < 0 || duration > 3600000) throw Error('Use a media test duration from 0 to 3600000 ms.');
if (!sdk || !binary) throw Error('Set RIMEWARD_MEDIA_SDK and RIMEWARD_MEDIA_HELPER to the staged helper and bundled runtime.');
const helper = spawn(binary, ['--synthetic-test'], { env: { PATH: process.env.PATH, HOME: process.env.HOME,
  SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, USERPROFILE: process.env.USERPROFILE,
  GST_DEBUG: process.env.GST_DEBUG ?? '', RIMEWARD_MEDIA_PLUGIN_DIR: path.join(sdk,'lib/gstreamer-1.0'), GST_PLUGIN_SCANNER_1_0: path.join(sdk,'libexec/gstreamer-1.0',process.platform==='win32'?'gst-plugin-scanner.exe':'gst-plugin-scanner'),
  ...(process.platform === 'linux' ? { LD_LIBRARY_PATH: path.join(sdk,'lib') } : {}),
  ...(process.env.RIMEWARD_MEDIA_USE_SDK === '1' ? { DYLD_LIBRARY_PATH: path.join(sdk,'lib') } : {}), GST_REGISTRY_1_0: path.join(os.tmpdir(),`rimeward-gst-test-${process.pid}.bin`) }, stdio: ['pipe','pipe','pipe'] });
let browser, page, heartbeat, logs = '', events = [];
const peers = new Map();
const session = crypto.randomUUID();
const send = (value, id = session) => helper.stdin.write(JSON.stringify({ session: id,...value })+'\n');
helper.stderr.on('data', b => { logs = (logs+b).slice(-10000); });
let start;
const ready = new Promise((resolve,reject) => { start=resolve; helper.once('exit',code=>reject(Error('Helper exited '+code+' '+logs))); });
ready.catch(()=>{});
let chain=Promise.resolve();
readline.createInterface({input:helper.stdout}).on('line', line => {
  const event=JSON.parse(line); events.push(event);
  if(event.event==='ready') start();
  chain=chain.then(async()=>{
    const viewer = peers.get(event.session), page = viewer?.page, pendingIce = viewer?.ice;
    if (['sdp','ice'].includes(event.event) && !viewer) return;
    if(event.event==='sdp') {
      assert.ok(event.sdp.includes('a=fingerprint:sha-256 '));
      const sdp=await page.evaluate(async sdp=>{
        await window.peer.setRemoteDescription({type:'offer',sdp});
        const answer=await window.peer.createAnswer(); await window.peer.setLocalDescription(answer); return answer.sdp;
      },event.sdp);
      send({command:'answer',sdp},event.session);
      for(const candidate of pendingIce.splice(0)) await page.evaluate(c=>window.peer.addIceCandidate(c),candidate);
    }
    if(event.event==='ice') {
      const candidate={candidate:event.candidate,sdpMLineIndex:event.sdpMLineIndex,sdpMid:event.sdpMid};
      const remote=await page.evaluate(()=>!!window.peer?.remoteDescription);
      if(remote) await page.evaluate(c=>window.peer.addIceCandidate(c),candidate);else pendingIce.push(candidate);
    }
    if(event.event==='error') throw Error(event.reason);
  }).catch(error=>{ logs+='\n'+error.stack; });
});
try {
  browser=await chromium.launch({headless:true,channel:'chromium',args:['--autoplay-policy=no-user-gesture-required']});
  const addPeer = async id => {
    const page = await browser.newPage(); peers.set(id, { page, ice: [] });
    await page.exposeFunction('candidate',c=>send({command:'ice',candidate:c.candidate,sdpMLineIndex:c.sdpMLineIndex},id));
    await page.setContent('<video autoplay playsinline muted style="width:640px;height:360px"></video>');
    await page.evaluate(turn=>{
      window.peer=new RTCPeerConnection({iceServers:turn?.iceServers??[],iceTransportPolicy:turn?'relay':'all'});
      window.peer.onicecandidate=e=>{if(e.candidate)void window.candidate(e.candidate.toJSON());};
      window.iceErrors=[]; window.peer.onicecandidateerror=e=>window.iceErrors.push({code:e.errorCode,text:e.errorText});
      const stream=new MediaStream();document.querySelector('video').srcObject=stream;
      window.peer.ontrack=e=>stream.addTrack(e.track);
      window.peer.ondatachannel=e=>{window.input=e.channel;};
    },turn); return page;
  };
  page = await addPeer(session);
  await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Media initialization timed out '+logs)),20000))]);
  send({command:'start',width,height,display:1,quality:'auto',audio:viewerCount === 1,turn:turn?.servers??[],forceTurn:!!turn});
  heartbeat=setInterval(()=>{ for (const id of peers.keys()) send({command:'renew'},id); },1000);
  await page.waitForFunction(width=>document.querySelector('video').videoWidth===width && document.querySelector('video').currentTime>1,width,{timeout:30000});
  const stats=await page.evaluate(async()=>[...(await window.peer.getStats()).values()].filter(r=>r.type==='inbound-rtp').map(r=>({kind:r.kind,packets:r.packetsReceived,frames:r.framesDecoded,codec:r.codecId})));
  assert.ok(stats.some(s=>s.kind==='video'&&s.frames>=10));if (viewerCount === 1) assert.ok(stats.some(s=>s.kind==='audio'&&s.packets>0));
  if (turn) assert.equal(await page.evaluate(async()=>{const report=await window.peer.getStats();return [...report.values()].some(r=>r.type==='candidate-pair'&&r.state==='succeeded'&&r.nominated&&report.get(r.localCandidateId)?.candidateType==='relay');}),true,'forced TURN must use a relay candidate');
  await page.waitForFunction(()=>window.input?.readyState==='open');
  await page.evaluate(()=>window.input.send(JSON.stringify({ownership:1,topology:1,sequence:1,events:[{type:'move',x:0.5,y:0.5}]})));
  await new Promise(r=>setTimeout(r,100));
  assert.ok(events.some(e=>e.event==='input'&&e.session===session));
  for (let index = 1; index < viewerCount; index++) {
    const id = crypto.randomUUID(), secondary = await addPeer(id);
    const small = index % 2 === 1, targetWidth = small ? 1280 : width;
    send({ command:'start', display:1, width:targetWidth, height:small ? 720 : height, quality:small ? 'saver' : 'sharp', audio:small, turn:turn?.servers??[], forceTurn:!!turn }, id);
    await secondary.waitForFunction(width => document.querySelector('video').videoWidth === width && document.querySelector('video').currentTime > 1, targetWidth, { timeout:30000 });
    const inbound = await secondary.evaluate(async()=>[...(await window.peer.getStats()).values()].filter(r=>r.type==='inbound-rtp'));
    assert.equal(inbound.some(s=>s.kind==='audio'&&s.packetsReceived>0),small);
  }
  if (viewerCount > 1) assert.ok(events.some(e=>e.event==='state'&&e.captures===2&&e.viewers===viewerCount&&e.audioCaptures===1), 'viewers share a capture per size (1280×720 and full size) and listeners share its audio');
  const until = Date.now() + duration;
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, Math.min(30000, until - Date.now())));
    const status = await page.evaluate(async () => ({ state: window.peer.connectionState,
      streams: [...(await window.peer.getStats()).values()].filter(r => r.type === 'inbound-rtp').map(r => ({ kind: r.kind, frames: r.framesDecoded, fps: r.framesPerSecond, lost: r.packetsLost, jitter: r.jitter, bytes: r.bytesReceived })) }));
    assert.equal(status.state, 'connected');
    assert.equal(events.some(e => e.event === 'closed' || e.event === 'error'), false);
    console.log(JSON.stringify({ at: new Date().toISOString(), helperPid: helper.pid, ...status }));
  }
  if (viewerCount > 1) {
    if (process.env.RIMEWARD_MEDIA_FAULTS === '1') {
      const before = await Promise.all([...peers.values()].map(v=>v.page.evaluate(()=>document.querySelector('video').currentTime)));
      send({command:'test-error',audio:true}, [...peers.keys()][1]);
      await new Promise(resolve=>setTimeout(resolve,250));
      assert.equal(events.some(e=>e.event==='closed'),false,'audio failure must preserve every viewer');
      assert.ok(events.some(e=>e.event==='capability-unavailable'&&e.capability==='audio'));
      let index=0;
      for (const viewer of peers.values()) await viewer.page.waitForFunction(t=>document.querySelector('video').currentTime>t+1,before[index++]);
      const [id, viewer] = [...peers].at(-1);
      send({command:'test-error'},id);
      peers.delete(id);
      await new Promise(resolve=>setTimeout(resolve,250));
      assert.deepEqual([...new Set(events.filter(e=>e.event==='closed').map(e=>e.session))],[id],'a viewer branch failure must stay isolated');
      await viewer.page.close();
    }
    for (const [id, viewer] of [...peers]) if (id !== session) { send({command:'stop'},id); await viewer.page.close(); peers.delete(id); }
    const before = await page.evaluate(()=>document.querySelector('video').currentTime);
    await page.waitForFunction(before => document.querySelector('video').currentTime > before + 1, before);
    assert.ok(events.some(e=>e.event==='state'&&e.captures===1&&e.viewers===1&&e.audioCaptures===0), 'last listener stops audio while the remaining viewer continues');
  }
  send({command:'stop'});clearInterval(heartbeat);helper.stdin.end();
  console.log(`remote media smoke passed: ${turn?'forced TURN':'direct'} DTLS-bound WebRTC, generated 1080p video, Opus audio, explicit stop`);
} catch(error) {
  const state = await Promise.all([...peers].map(async ([session, viewer]) => ({ session, ...await viewer.page.evaluate(async()=>({
    connection:window.peer?.connectionState, ice:window.peer?.iceConnectionState, errors:window.iceErrors,
    video:{width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight,time:document.querySelector('video').currentTime},
    streams:[...(await window.peer.getStats()).values()].filter(s=>s.type==='inbound-rtp').map(s=>({kind:s.kind,width:s.frameWidth,height:s.frameHeight,frames:s.framesDecoded,packets:s.packetsReceived,lost:s.packetsLost,bytes:s.bytesReceived})),
    candidates:[...(await window.peer.getStats()).values()].filter(s=>s.type.endsWith('-candidate')).map(s=>({type:s.type,kind:s.candidateType,protocol:s.protocol,relay:s.relayProtocol}))
  })).catch(()=>null) })));
  const detail = error.stack+'\n'+logs+'\n'+JSON.stringify({state,events:events.map(e=>({event:e.event,session:e.session,reason:e.reason}))});
  throw Error(detail.replace(/turns?:\/\/[^\s@]+@/g,'turn://[redacted]@').replace(/(ufrag:|pwd:)\S+/g,'$1[redacted]'));
}
finally { clearInterval(heartbeat);await browser?.close();helper.kill(); }
