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
try {
  const url=await ready, origin=new URL(url).origin;
  browser=await chromium.launch({headless:true,channel:'chromium',args:['--disable-gpu']});
  const pc=await browser.newContext({viewport:{width:1280,height:850}}), page=await pc.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('rimeward-terminal-accessibility', 'true'));
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.terminalTestStreams = [];
    window.EventSource = class extends Native {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes('/api/dev/events')) window.terminalTestStreams.push(this);
      }
    };
  });
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
  // The common path starts a real shell and claims input without a second step.
  await ward.getByRole('button',{name:'Open terminal',exact:true}).click();
  await ward.getByText('You’re in control',{exact:true}).waitFor();
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
  const first=(await page.evaluate(()=>fetch('/api/dev/sessions').then(r=>r.json())))[0];
  assert.equal(first.mode,'human');
  assert.ok(first.owner?.startsWith('client:'));
  if (process.env.RIMEWARD_TERMINAL_BENCH === '1') {
  const samples=[];
  for(let i=0;i<5;i++) {
    const token=crypto.randomUUID().slice(0,8), match='ECHO_'+token;
    const start=performance.now();
    await terminal.focus();
    await page.keyboard.type("printf 'ECHO_%s\\n' "+token);
    await page.keyboard.press('Enter');
    await page.waitForFunction(match=>{ const q=document.querySelector('.term-find input'); q.value=match; q.dispatchEvent(new Event('input')); return document.querySelector('.term-find-result').textContent===''; },match);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    samples.push(Math.round(performance.now()-start));
  }
  await new Promise(r=>setTimeout(r,1000));
  let requests=0;
  const count=req=>{if(/\/api\/dev\/(sessions|control)/.test(req.url()))requests++;};
  page.on('request',count);
  await new Promise(r=>setTimeout(r,3000));
  page.off('request',count);
  console.log(JSON.stringify({echoMilliseconds:samples,median:samples.sort((a,b)=>a-b)[2],idleRequestsIn3Seconds:requests}));
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
  await expanded.getByRole('button',{name:'Terminal actions'}).click();
  const menu=page.getByRole('menu',{name:'Terminal actions'});
  await menu.getByRole('menuitem',{name:'Session settings…'}).click();
  const settings=page.getByRole('dialog',{name:'Session settings',exact:true});
  await settings.getByRole('checkbox',{name:'Allow Rime to type'}).check();
  await settings.getByRole('button',{name:'Save settings'}).click();
  let sessions=await page.evaluate(()=>fetch('/api/dev/sessions').then(r=>r.json()));
  assert.equal(sessions[0].mode,'human');assert.equal(sessions[0].agentInput,true);assert.equal(sessions[0].id,first.id);
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
  // Lose one input acknowledgement after the backend actually accepted it.
  let sent=0;
  await page.route('**/api/dev/input*',async route=>{sent++;await route.fetch();await route.abort('failed');});
  await terminal.focus();await page.keyboard.type('x');
  await ward.getByText('Input unconfirmed · review the screen',{exact:true}).waitFor();
  await page.keyboard.type('y');assert.equal(sent,1,'uncertain keystrokes must not be retried');
  await page.unroute('**/api/dev/input*');
  await ward.getByRole('button',{name:'Review & take control'}).click();
  await ward.getByText('You’re in control',{exact:true}).waitFor();
  await terminal.focus();await page.keyboard.press('Control+c');
  // Losing the stream alone is not an uncertain mutation or a new session.
  await page.evaluate(() => {
    for (const stream of window.terminalTestStreams) {
      if (stream.readyState === EventSource.CLOSED) continue;
      stream.close(); stream.dispatchEvent(new Event('error'));
    }
  });
  await ward.getByText('Reconnecting…',{exact:true}).waitFor();
  await ward.getByText('You’re in control',{exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>fetch('/api/dev/sessions').then(r=>r.json()))).length,2);
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
  await ward.getByRole('button',{name:'Start again',exact:true}).waitFor();
  sessions=await page.evaluate(()=>fetch('/api/dev/sessions').then(r=>r.json()));
  assert.equal(sessions.find(s=>s.id===first.id).state,'exited');
  await ward.getByRole('button',{name:'Start again',exact:true}).click();
  await ward.getByText('You’re in control',{exact:true}).waitFor();
  sessions=await page.evaluate(()=>fetch('/api/dev/sessions').then(r=>r.json()));
  assert.equal(sessions[0].mode,'human');assert.equal(sessions[0].agentInput,true);assert.equal(sessions.length,3);
  assert.deepEqual(errors,[]);
  console.log('Terminal UI passed: project entry, one-click shell + typing, session toolbar, search, expanded menus, launch guidance, switching, uncertain input, phone takeover, permissions, explicit end/restart. No agent CLI or model calls.');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(()=>{child.kill('SIGKILL');r();},4000).unref())]);
  fs.rmSync(temp,{recursive:true,force:true});
}
