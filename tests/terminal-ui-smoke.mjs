import { liveStreamFixture } from './live-stream-fixture.mjs';
// Real PTY + isolated desktop data. Agent launcher dialogs are exercised without
// starting external agents or sending any provider requests.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const screenshotDir=process.env.RIMEWARD_GOLDEN_DIR ?? os.tmpdir();
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rimeward-terminal-ui-'));
const project=path.join(temp,'project');fs.mkdirSync(project);
const shellHome=path.join(temp,'home');fs.mkdirSync(shellHome);
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repo,'desktop/runtime/browsers');
const {chromium}=await import('playwright-core');
const child=spawn(process.execPath,['desktop-runtime.mjs'],{cwd:repo,env:{PATH:process.env.PATH,HOME:shellHome,USER:'demo',LOGNAME:'demo',SHELL:process.platform==='win32'?process.env.SHELL:'/bin/sh'},stdio:['pipe','pipe','pipe']});
let browser,logs='';child.stderr.on('data',d=>logs+=d);
const ready=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Desktop startup timeout '+logs)),20000);
  readline.createInterface({input:child.stdout}).on('line',line=>{try{
    const m=JSON.parse(line);
    if(m.type==='ready'){clearTimeout(timer);resolve(m.url);}
    if(m.type==='vault')child.stdin.write(JSON.stringify({id:m.id,value:'[]'})+'\n');
  }catch{}});
  child.once('exit',code=>{clearTimeout(timer);reject(Error('Desktop exited '+code+' '+logs));});
});
child.stdin.write(JSON.stringify({key:Buffer.alloc(32,9).toString('base64'),data:path.join(temp,'state'),browsers:process.env.PLAYWRIGHT_BROWSERS_PATH})+'\n');
const leaves=n=>typeof n==='string'?[n]:[...leaves(n.a),...leaves(n.b)];
const screenText=async(scope)=>scope.locator('.xterm').first().evaluate(el=>el.textContent);
const fits=async(locator)=>locator.evaluate(el=>el.scrollWidth<=el.clientWidth+1&&el.scrollHeight<=el.clientHeight+1);
try {
  const url=await ready, origin=new URL(url).origin;
  browser=await chromium.launch({headless:true,channel:'chromium',args:['--disable-gpu']});
  const pc=await browser.newContext({viewport:{width:1280,height:850}}), page=await pc.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  // The terminal's own WebSocket, observed from the outside: input frames are
  // counted, acks can be withheld, and the page side can be dropped.
  const socket={inputs:0,dropAcks:false,current:null};
  await page.routeWebSocket('**/api/dev/ws*',ws=>{
    const server=ws.connectToServer();
    socket.current=ws;
    ws.onMessage(m=>{ if(JSON.parse(m).t==='in')socket.inputs++; server.send(m); });
    server.onMessage(m=>{ if(socket.dropAcks&&JSON.parse(m).t==='ack')return; ws.send(m); });
  });
  await page.addInitScript(() => localStorage.setItem('rimeward-terminal-accessibility', 'true'));
  await page.addInitScript(liveStreamFixture);
  let inputPosts=0;
  await page.route('**/api/dev/input*',async route=>{inputPosts++;await route.continue();});
  await page.goto(url);
  await page.waitForURL('**/desktop/start');
  await page.getByRole('button',{name:'Continue without connecting'}).click();
  await page.waitForURL('**/dash');
  await page.evaluate(async()=>{
    const r=await fetch('/api/dashboard',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({layout:[{i:'terminal-ui',type:'terminal',size:'6x4'}],pages:[]})});
    if(!r.ok)throw Error(await r.text());
  });
  await page.reload();
  const ward=page.locator('[data-wd="terminal-ui"]');
  await ward.getByRole('button',{name:'Open / new project'}).click();
  const projectDialog=page.getByRole('dialog',{name:'Open a project'});
  await projectDialog.getByRole('textbox',{name:'Project folder',exact:true}).fill(project);
  await projectDialog.getByRole('button',{name:'Open project',exact:true}).click();
  await ward.getByRole('button',{name:'Open terminal',exact:true}).waitFor();
  await page.screenshot({path:path.join(screenshotDir,'rimeward-terminal-empty.png'),animations:'disabled'});
  // New sessions let the user and Rime share the keyboard.
  await ward.getByRole('button',{name:'Open terminal',exact:true}).click();
  await ward.getByText('Shared with Rime',{exact:true}).waitFor();

  assert.equal(await ward.getByRole('button',{name:'Take control',exact:true}).isVisible(),false);
  assert.equal(await ward.locator('.term-keys').isVisible(),false);
  assert.equal(await ward.locator('.term-toolbar button:visible').count(),5,'session tab, close button and three toolbar controls');
  const terminal=ward.locator('.xterm-helper-textarea');
  // System shell profiles may print the real hostname even with an isolated HOME.
  if(process.env.RIMEWARD_GOLDEN_DIR&&process.platform!=='win32'){
    await terminal.focus();await page.keyboard.type("PS1='project $ '; printf '\\033[3J\\033[H\\033[2J'");await page.keyboard.press('Enter');
  }
  const marker=process.env.RIMEWARD_GOLDEN_DIR?'Rimeward workspace ready':'TERMINAL_UI_'+crypto.randomUUID().slice(0,8);
  await terminal.focus();await page.keyboard.type('echo '+marker);await page.keyboard.press('Enter');
  await page.waitForFunction(marker=>document.querySelector('.xterm')?.textContent?.includes(marker),marker);
  assert.ok(socket.inputs>0,'keystrokes travel over the terminal socket');
  assert.equal(inputPosts,0,'no POST /api/dev/input while the socket is up');
  const first=(await page.evaluate(()=>fetch('/api/dev/sessions').then(r=>r.json())))[0];
  assert.equal(first.mode,'approvals');
  assert.ok(first.owner?.startsWith('client:'));
  // The ward always fits its box: no scrollbars, nothing out of view.
  assert.equal(await fits(ward.locator('.term-surface')),true,'terminal surface never overflows');
  if (process.env.RIMEWARD_TERMINAL_BENCH === '1') {
  // Enter → the echo painted: the input path, the shell, the output path and one paint.
  const samples=[];
  for(let i=0;i<9;i++) {
    const token=crypto.randomUUID().slice(0,8), match='ECHO_'+token;
    await terminal.focus();
    await page.keyboard.type("printf 'ECHO_%s\\n' "+token);
    await new Promise(r=>setTimeout(r,150));
    const start=performance.now();
    await page.keyboard.press('Enter');
    // Detected through the search addon: the accessibility rows xterm renders lag by a debounce.
    await page.waitForFunction(match=>{ const q=document.querySelector('.term-find input'); q.value=match; q.dispatchEvent(new Event('input')); return document.querySelector('.term-find-result').textContent===''; },match,{polling:'raf'});
    samples.push(Math.round(performance.now()-start));
  }
  await new Promise(r=>setTimeout(r,1000));
  let requests=0;
  const count=req=>{if(/\/api\/dev\/(sessions|control)/.test(req.url()))requests++;};
  page.on('request',count);
  await new Promise(r=>setTimeout(r,3000));
  page.off('request',count);
  console.log(JSON.stringify({echoMilliseconds:samples,median:samples.sort((a,b)=>a-b)[4],idleRequestsIn3Seconds:requests}));
  }
  // The kitty keyboard protocol: a program that pushes it gets Shift+Enter as
  // CSI u — also after a reload, where the snapshot must carry the mode; a
  // program that never asked gets the legacy CR.
  if(process.platform!=='win32'){
    const csiU=()=>page.waitForFunction(()=>document.querySelector('.xterm')?.textContent?.includes('^[[13;2u'));
    await terminal.focus();await page.keyboard.type("printf '\\033[>1u'; cat -v");await page.keyboard.press('Enter');
    await new Promise(r=>setTimeout(r,300));
    await page.keyboard.press('Shift+Enter');
    await csiU();
    await page.reload();
    await ward.getByText('Shared with Rime',{exact:true}).waitFor();
    await ward.locator('.xterm-helper-textarea').focus();await page.keyboard.press('Shift+Enter');
    await page.waitForFunction(()=>(document.querySelector('.xterm')?.textContent?.match(/\^\[\[13;2u/g)??[]).length>=2,null,{timeout:10000}).catch(()=>{throw Error('kitty mode did not survive the snapshot restore');});
    await page.keyboard.press('Control+c');
    await page.keyboard.type("printf '\\033[<u'; cat -v");await page.keyboard.press('Enter');
    await new Promise(r=>setTimeout(r,300));
    await page.keyboard.press('Shift+Enter');
    await new Promise(r=>setTimeout(r,300));
    assert.equal((await ward.locator('.xterm').first().evaluate(el=>el.textContent.match(/\^\[\[13;2u/g)??[])).length,2,'after the pop Shift+Enter is a plain CR again');
    await page.keyboard.press('Control+c');
    await page.keyboard.type('echo done-'+marker);await page.keyboard.press('Enter');
    await page.waitForFunction(marker=>document.querySelector('.xterm')?.textContent?.includes('done-'+marker),marker);
  }
  // Search stays in the terminal, while plain Ctrl+F remains a shell key.
  await terminal.focus();await page.keyboard.press('Control+f');
  assert.equal(await ward.locator('.term-find').isVisible(),false);
  await page.keyboard.press('Control+Shift+f');
  await ward.getByRole('textbox',{name:'Find in terminal'}).fill(marker);
  await ward.getByRole('textbox',{name:'Find in terminal'}).press('Escape');
  assert.equal(await ward.locator('.term-find').isVisible(),false);
  await ward.getByRole('button',{name:'Expand terminal'}).click();
  const expanded=page.locator('.dev-expanded');
  await expanded.locator('.xterm-helper-textarea').focus();await page.keyboard.press('Escape');
  assert.equal(await expanded.isVisible(),true,'Escape reaches terminal applications without closing the view');
  assert.equal(await fits(expanded.locator('.term-surface')),true,'expanded surface never overflows');
  const menu=page.getByRole('menu',{name:'Terminal actions'});
  await expanded.getByRole('checkbox',{name:'Let Rime control'}).check();
  await expanded.getByText('Shared with Rime',{exact:true}).waitFor();
  let sessions=await page.evaluate(()=>fetch('/api/dev/sessions').then(r=>r.json()));
  assert.equal(sessions[0].mode,'approvals');assert.equal(sessions[0].agentInput,true);assert.equal(sessions[0].id,first.id);
  await expanded.getByRole('checkbox',{name:'Let Rime control'}).uncheck();
  await expanded.getByText('You’re in control',{exact:true}).waitFor();
  await expanded.getByRole('button',{name:'Terminal actions'}).click();
  assert.ok(await menu.evaluate(el=>el.matches(':popover-open')),'menu works above expanded dialog');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  assert.equal(await expanded.isVisible(),true,'Escape closes menu before expanded terminal');
  await expanded.getByRole('button',{name:'Close',exact:true}).click();
  // New session options are secondary; missing agent guidance doesn't run a CLI.
  await page.route('**/api/dev/capabilities*',async route=>{const r=await route.fetch();const v=await r.json();v.agents={codex:false,claude:false};await route.fulfill({json:v});});
  await page.reload();
  await ward.getByText('You’re in control',{exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>fetch('/api/dev/sessions').then(r=>r.json()))).length,1,'reload keeps the same session and ownership');
  // A transient snapshot failure must recover even when the live stream is idle.
  let failedSnapshots = 0;
  await page.route('**/api/dev/sessions*', async route => {
    if (route.request().method() === 'GET' && !failedSnapshots++)
      await route.fulfill({status:503,json:{error:'Transient snapshot failure'}});
    else await route.continue();
  });
  await page.reload();
  await ward.getByText('You’re in control',{exact:true}).waitFor();
  assert.ok(failedSnapshots > 1, 'the snapshot is retried without output or user input');
  await page.unroute('**/api/dev/sessions*');
  await ward.getByRole('button',{name:'New terminal session'}).click();
  let launch=page.getByRole('dialog',{name:'New terminal session',exact:true});
  await launch.locator('select[aria-label="Program"]').selectOption('codex',{force:true});
  assert.equal(await launch.getByRole('button',{name:'Start Codex'}).isDisabled(),true);
  assert.match(await launch.innerText(),/isn’t installed/);
  await launch.locator('select[aria-label="Program"]').selectOption('shell',{force:true});
  await launch.getByRole('button',{name:'Open terminal',exact:true}).click();
  await ward.getByText('Shared with Rime',{exact:true}).waitFor();
  await ward.getByRole('checkbox',{name:'Let Rime control'}).uncheck();
  await ward.getByText('You’re in control',{exact:true}).waitFor();
  sessions=await page.evaluate(()=>fetch('/api/dev/sessions').then(r=>r.json()));
  assert.equal(sessions.length,2);const second=sessions[0];assert.notEqual(first.id,second.id);
  await page.evaluate(async first => {
    const response = await fetch('/api/dev/resize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: first.id, owner: first.owner, cols: 400, rows: 150 }) });
    if (!response.ok) throw Error(await response.text());
  }, first);
  const beforeSwitch = await ward.boundingBox();
  await ward.locator(`[role=tab][data-session="${first.id}"]`).click();
  await ward.getByText('You’re in control',{exact:true}).waitFor();
  await page.waitForFunction(marker=>document.querySelector('.xterm')?.textContent?.includes(marker),marker);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await ward.boundingBox(), beforeSwitch, 'switching tabs preserves ward position and size');
  await page.screenshot({path:path.join(screenshotDir,'rimeward-terminal-desktop.png'),animations:'disabled'});
  // Tiling: a split opens a shell beside the pane; a tab dragged onto a pane's
  // edge tiles in; a pane dragged to the strip becomes its own tab; the divider
  // resizes; every pane still fits; the layout is saved with the ward.
  const view=async()=>page.evaluate(()=>fetch('/api/dev/view?id=terminal-ui').then(r=>r.json()));
  await ward.getByRole('button',{name:'Terminal actions'}).click();
  await menu.getByRole('menuitem',{name:'Split right'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-wd="terminal-ui"] .term-pane').length===2);
  await ward.getByText('Shared with Rime',{exact:true}).waitFor();
  sessions=await page.evaluate(()=>fetch('/api/dev/sessions').then(r=>r.json()));
  assert.equal(sessions.length,3,'a split launches a new shell');
  const third=sessions[0];
  assert.equal((await ward.locator('.term-split[data-dir="row"]').count()),1);
  assert.equal(await fits(ward.locator('.term-panes')),true,'two panes fit the surface');
  for(const pane of await ward.locator('.term-pane').all())assert.equal(await fits(pane),true,'each pane clips to its box');
  const drag=async(from,to)=>{
    const a=await from.boundingBox(), b=await to.boundingBox();
    await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
    await page.mouse.move(a.x+a.width/2+6,a.y+a.height/2+2);
    await page.mouse.move(b.x,b.y,{steps:6});await page.mouse.move(b.x,b.y);
    await page.mouse.up();
  };
  const paneOf=id=>ward.locator(`.term-pane[data-session="${id}"]`);
  // The second session's tab onto the RIGHT edge of the split's new pane.
  const thirdBox=await paneOf(third.id).boundingBox();
  await drag(ward.locator(`[role=tab][data-session="${second.id}"]`),{boundingBox:async()=>({x:thirdBox.x+thirdBox.width*0.92,y:thirdBox.y+thirdBox.height/2})});
  await page.waitForFunction(()=>document.querySelectorAll('[data-wd="terminal-ui"] .term-pane').length===3);
  let state=await view();
  assert.equal(state.groups.length,1);assert.deepEqual(leaves(state.groups[0]),[first.id,third.id,second.id],'tab tiled in on the right, saved with the ward');
  assert.equal(await ward.locator('[role=tab]').count(),1,'one tab holds the three panes');
  assert.equal(await ward.locator('.term-tab-badge').innerText(),'+2');
  // The third pane's bar onto the tab strip: its own tab again.
  const strip=await ward.locator('.term-tabs').boundingBox();
  await drag(paneOf(third.id).locator('.term-pane-bar'),{boundingBox:async()=>({x:strip.x+strip.width-12,y:strip.y+strip.height/2})});
  await page.waitForFunction(()=>document.querySelectorAll('[data-wd="terminal-ui"] [role=tab]').length===2);
  state=await view();
  assert.deepEqual(state.groups.map(leaves),[[first.id,second.id],[third.id]],'pane became its own tab, groups saved');
  assert.equal(await ward.locator('.term-pane').count(),1,'the dragged pane is now the active tab');
  await ward.locator(`[role=tab][data-session="${first.id}"]`).click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-wd="terminal-ui"] .term-pane').length===2);
  const divider=ward.locator('.term-divider');
  const d=await divider.boundingBox();
  await page.mouse.move(d.x+d.width/2,d.y+d.height/2);await page.mouse.down();await page.mouse.move(d.x+120,d.y+d.height/2,{steps:4});await page.mouse.up();
  state=await view();
  assert.ok(state.groups[0].ratio>0.55,'divider drag changes the saved ratio');
  assert.equal(await fits(ward.locator('.term-panes')),true,'panes still fit after resizing');
  await paneOf(first.id).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Meta+Shift+Enter');
  await page.waitForFunction(()=>document.querySelectorAll('[data-wd="terminal-ui"] .term-pane').length===1);
  assert.ok(await ward.locator('.term-panes').evaluate(el=>el.classList.contains('term-zoomed')),'zoom shows one pane');
  await page.keyboard.press('Meta+Shift+Enter');
  await page.waitForFunction(()=>document.querySelectorAll('[data-wd="terminal-ui"] .term-pane').length===2);
  // Font settings persist per browser and apply live.
  await ward.getByRole('button',{name:'Terminal actions'}).click();
  await menu.getByRole('menuitem',{name:'Terminal settings…'}).click();
  const settings=page.getByRole('dialog',{name:'Terminal settings'});
  assert.match(await settings.innerText(),/Renderer now: (WebGL|DOM)/);
  const rows=el=>el.querySelectorAll('.xterm-accessibility-tree > div').length;
  const rowsBefore=await ward.locator('.xterm').first().evaluate(rows);
  await settings.getByRole('spinbutton',{name:'Font size'}).fill('16');
  await settings.getByRole('button',{name:'Save'}).click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('rimeward-terminal-prefs')||'{}').size===16);
  await page.waitForFunction(before=>document.querySelector('[data-wd="terminal-ui"] .xterm-accessibility-tree').children.length<before,rowsBefore);
  assert.equal(await fits(ward.locator('.term-panes')),true,'a bigger font still fits');
  await paneOf(second.id).locator('.xterm-helper-textarea').focus();
  await ward.getByRole('button',{name:'Terminal actions'}).click();
  await menu.getByRole('menuitem',{name:'Close pane'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-wd="terminal-ui"] .term-pane').length===1);
  // Lose one input acknowledgement after the backend actually accepted it.
  await ward.locator(`[role=tab][data-session="${first.id}"]`).click();
  await ward.getByText('You’re in control',{exact:true}).waitFor();
  const before=socket.inputs;
  socket.dropAcks=true;
  await terminal.focus();await page.keyboard.type('x');
  await new Promise(r=>setTimeout(r,200));
  socket.current.close();
  await ward.getByText('Input unconfirmed · review the screen',{exact:true}).waitFor();
  socket.dropAcks=false;
  await page.keyboard.type('y');assert.equal(socket.inputs,before+1,'uncertain keystrokes must not be retried or sent');
  await ward.getByRole('button',{name:'Review & take control'}).click();
  await ward.getByText('You’re in control',{exact:true}).waitFor();
  await terminal.focus();await page.keyboard.press('Control+c');
  // Losing the stream alone (nothing in flight) is not an uncertain mutation or a new session.
  await new Promise(r=>setTimeout(r,300));
  socket.current.close();
  await ward.getByText('Reconnecting…',{exact:true}).waitFor();
  await ward.getByText('You’re in control',{exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>fetch('/api/dev/sessions').then(r=>r.json()))).length,3);
  // A phone attaches read-only; taking control updates the PC without duplicate sessions.
  const phone=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await phone.addInitScript(() => localStorage.setItem('rimeward-terminal-accessibility', 'true'));
  await phone.addCookies(await pc.cookies());const mobile=await phone.newPage();
  mobile.on('pageerror',e=>errors.push(e.message));await mobile.goto(origin+'/dash');
  const mobileWard=mobile.locator('[data-wd="terminal-ui"]');
  await mobileWard.getByRole('button',{name:'Take control',exact:true}).click();
  await mobileWard.getByText('You’re in control',{exact:true}).waitFor();
  await ward.getByText('Viewing · controlled elsewhere',{exact:true}).waitFor();
  assert.equal(await mobileWard.locator('.term-keys').isVisible(),true);
  assert.equal(await mobileWard.locator('.term-toolbar').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
  await mobileWard.getByRole('button',{name:'Expand terminal'}).click();
  await mobile.waitForFunction(marker=>document.querySelector('.xterm')?.textContent?.includes(marker),marker);
  await mobile.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await mobile.screenshot({path:path.join(screenshotDir,'rimeward-terminal-phone.png'),animations:'disabled'});
  await mobile.locator('.dev-expanded').getByRole('button',{name:'Close',exact:true}).click();
  await ward.getByRole('button',{name:'Take control',exact:true}).click();
  await ward.getByText('You’re in control',{exact:true}).waitFor();
  // Ending a process is explicit and retains the saved screen; restart is separate.
  await ward.getByRole('button',{name:'Terminal actions'}).click();
  await menu.getByRole('menuitem',{name:'End session…'}).click();
  await page.locator('.dev-project-dialog').getByRole('button',{name:'Continue',exact:true}).click();
  await ward.getByRole('button',{name:'Resume session',exact:true}).waitFor();
  sessions=await page.evaluate(()=>fetch('/api/dev/sessions').then(r=>r.json()));
  assert.equal(sessions.find(s=>s.id===first.id).state,'exited');
  await ward.getByRole('button',{name:'Resume session',exact:true}).click();
  await ward.getByText('You’re in control',{exact:true}).waitFor();
  sessions=await page.evaluate(()=>fetch('/api/dev/sessions').then(r=>r.json()));
  assert.equal(sessions.find(s=>s.id===first.id).mode,'approvals');assert.equal(sessions.find(s=>s.id===first.id).agentInput,false);assert.equal(sessions.length,3);
  assert.deepEqual(errors,[]);
  console.log('Terminal UI passed: project entry, one-click shell + typing over the socket, Shift+Enter, session toolbar, search, expanded menus, launch guidance, switching, split + drag tiling + divider + zoom, settings, uncertain input, phone takeover, permissions, explicit end/restart. No agent CLI or model calls.');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(()=>{child.kill('SIGKILL');r();},4000).unref())]);
  fs.rmSync(temp,{recursive:true,force:true});
}
