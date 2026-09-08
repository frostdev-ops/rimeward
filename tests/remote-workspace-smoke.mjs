// Built-app handoff test: isolated desktop, independent server, HTTPS relay,
// desktop and phone browser clients. No real accounts or model requests.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import sharp from "sharp";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  runtime = path.join(repo, "desktop/runtime");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rimeward-handoff-")),
  project = path.join(temporary, "project");
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "hello.txt"), "hello\n");
execFileSync("git", ["init", project], { stdio: "ignore" });
const marker = "HANDOFF_" + crypto.randomUUID(),
  children = [];
let browser, proxy, unavailableNavigation = false, unavailableHarness = false;
let modelFixture = null, modelRequests = 0;
let nativeHandler = async () => {
  throw new Error("Native test adapter not ready");
};
let logs = "";
const connections = new Set();
const key = path.join(temporary, "key.pem"),
  cert = path.join(temporary, "cert.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ],
  { stdio: "ignore" },
);
function child(args, env) {
  const p = spawn(process.execPath, args, {
    cwd: repo,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(p);
  p.stderr.on("data", (d) => {
    logs += d.toString();
  });
  return p;
}
function ready(p, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Startup timeout: " + logs.slice(-500))),
      30000,
    );
    readline.createInterface({ input: p.stdout }).on("line", (raw) => {
      try {
        const m = JSON.parse(raw);
        if (m.type === type) {
          clearTimeout(timeout);
          resolve(m);
        }
        if (m.type === "desktop")
          void nativeHandler(m)
            .then((value) =>
              p.stdin.write(JSON.stringify({ id: m.id, value }) + "\n"),
            )
            .catch(() =>
              p.stdin.write(
                JSON.stringify({
                  id: m.id,
                  error: "Test native action failed",
                }) + "\n",
              ),
            );
        if (m.type === "vault")
          p.stdin.write(JSON.stringify({ id: m.id, value: "[]" }) + "\n");
      } catch {}
    });
    p.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error("Early runtime exit " + code));
    });
  });
}
try {
  // Seed only the independent server's account; application data remains separate.
  const fixture = path.join(repo, "tests/.handoff-server-fixture.mjs");
  fs.writeFileSync(
    fixture,
    `import { createUser } from '../src/lib/users.ts';import { createSession } from '../src/lib/auth.ts';import {writeDoc} from '../src/lib/agent/store.ts';import {storeAgentAccount} from '../src/lib/agent/accounts.ts';import {saveDashboard} from '../src/lib/dashboard.ts';import {activeConversation,addMessage} from '../src/lib/agent/conversations.ts';const user=createUser('test@example.com','test-only-password');const {getDb}=await import('../src/lib/db.ts');const {normalizeTheme}=await import('../src/lib/theme.ts');const {saveBackground}=await import('../src/lib/backgrounds.ts');const sharp=(await import('sharp')).default;const image=await saveBackground(user,await sharp({create:{width:3,height:2,channels:4,background:'#365372'}}).png().toBuffer());getDb().prepare('UPDATE users SET theme=? WHERE id=?').run(JSON.stringify(normalizeTheme({iconSet:'tabler',iconStyle:'outline',background:'image',bgImage:image,brandLogo:image,hdrScene:'aurora',brandText:'Unified Rime'})),user);const cookie=createSession(user).id;writeDoc(user,'memory','shared','Shared memory','server memory');storeAgentAccount({userId:user,provider:'codex',token:'fixture-only-never-sent'});saveDashboard(user,[{i:'server-rime',type:'agent',size:'2x2',config:{provider:'codex'}}]);addMessage(activeConversation(user,'server-rime','codex'),{role:'user',text:'Shared Rime history fixture'});const {httpServer}=await import('../server.mjs');if(!httpServer.listening)await new Promise(r=>httpServer.once('listening',r));console.log(JSON.stringify({type:'server',port:httpServer.address().port,cookie}));`,
  );
  const server = child([fixture], {
    HOMEPAGE_DATA_DIR: path.join(temporary, "server"),
    TOKEN_ENC_KEY: Buffer.alloc(32, 5).toString("base64"),
    PUBLIC_BASE_URL: "",
    HOST: "127.0.0.1",
    PORT: "0",
  });
  const serverInfo = await ready(server, "server");
  fs.rmSync(fixture);
  proxy = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (req, res) => {
      const accountAssets = {
        '/_astro/account-server-build.css': ['text/css', ':root { --account-server-build: ready; }'],
        '/_astro/account-server-build.js': ['text/javascript', 'import "./account-server-dependency.js";'],
        '/_astro/account-server-dependency.js': ['text/javascript', 'document.documentElement.dataset.accountServerBuild = "ready";'],
      };
      if (accountAssets[req.url]) {
        assert.match(req.headers.cookie ?? '', /rimeward_session=/);
        res.writeHead(200, { 'content-type': accountAssets[req.url][0] }); res.end(accountAssets[req.url][1]); return;
      }
      if (unavailableHarness && req.url.startsWith('/api/devices/harness')) { res.writeHead(503); res.end(); return; }
      if (modelFixture && req.url === '/api/devices/harness/model') {
        const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
          const call=JSON.parse(Buffer.concat(chunks));modelRequests++;
          assert.equal(call.provider,'codex');assert.equal('userId' in call,false);
          assert.equal(typeof call.instructions,'string');assert.ok(Array.isArray(call.tools));
          res.writeHead(modelFixture.status,{'content-type':'application/json'});res.end(JSON.stringify(modelFixture.body));
        });return;
      }
      if (unavailableNavigation && req.url === "/api/devices/navigation") {
        res.writeHead(404); res.end(); return;
      }
      const forward = http.request(
        {
          host: "127.0.0.1",
          port: serverInfo.port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      forward.on("error", () => res.destroy());
      req.pipe(forward);
    },
  );
  proxy.on("connection", (s) => {
    connections.add(s);
    s.on("close", () => connections.delete(s));
  });
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(serverInfo.port, "127.0.0.1", () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers)
          .map(([k, v]) => k + ": " + v)
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const origin = "https://localhost:" + proxy.address().port;
  const desktop = child(["desktop-runtime.mjs"], {
    HOMEPAGE_DATA_DIR: path.join(temporary, "desktop"),
    NODE_EXTRA_CA_CERTS: cert,
  });
  const boot = ready(desktop, "ready");
  desktop.stdin.write(
    JSON.stringify({
      key: Buffer.alloc(32, 7).toString("base64"),
      data: path.join(temporary, "desktop"),
      browsers: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(runtime, "browsers"),
    }) + "\n",
  );
  const { url } = await boot;
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(runtime, "browsers");
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    args: ["--disable-gpu"],
  });
  const pc = await browser.newContext({ ignoreHTTPSErrors: true }),
    phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
    });
  // Emulate only the native transport boundary; all navigation and workspace UI is real.
  const localOrigin = new URL(url).origin;
  const localHeaders = { "x-rimeward-native-token": new URL(url).searchParams.get("token") };
  await pc.exposeBinding("workspaceInvoke", async ({ page }, command, args) => {
    if (command === "workspace_navigation") {
      const result = await fetch(localOrigin + "/api/dev/navigation", { headers: localHeaders }).then(r => r.json());
      if (new URL(page.url()).origin === origin) result.current = result.workspaces.find(w => w.kind === "server").id;
      return result;
    }
    if (command === "open_workspace") return fetch(localOrigin + "/api/dev/navigate", { method: "POST", headers: { ...localHeaders, "content-type": "application/json" }, body: JSON.stringify(args) }).then(r => r.json());
    throw new Error("Unexpected native command: " + command);
  });
  await pc.addInitScript(() => { window.__TAURI__ = { core: { invoke: (command, args) => window.workspaceInvoke(command, args) } }; });
  const desktopPage = await pc.newPage();
  const errors = [];
  desktopPage.on("pageerror", (e) => errors.push(e.message));
  let verificationUrl = "";
  const remotePixels = await sharp({ create: { width: 64, height: 40, channels: 3, background: '#18314b' } }).jpeg().toBuffer();
  let remoteOwner = null;
  nativeHandler = async (m) => {
    if (m.op === 'computer-status') return { enabled: true, generation: 1, supported: true, suspended: false, platform: 'macos', topology: 1,
      screenPermission: true, inputPermission: true, controller: remoteOwner, displays: [{ display: 1, x: -1920, y: 0, width: 1920, height: 1080, scale: 1, rotation: 0 }] };
    if (m.op === 'computer-frame') return { image: remotePixels.toString('base64'), imageWidth: 64, imageHeight: 40 };
    if (m.op === 'computer-acquire') { remoteOwner = { id: m.value.owner, kind: 'human', generation: 1 }; return { ownership: 1, topology: 1 }; }
    if (m.op === 'computer-release' || m.op === 'computer-disconnect') { remoteOwner = null; return { released: true }; }
    if (m.op === 'computer-files') return { active: 0 };
    if (m.op === "open-url") {
      verificationUrl = m.value.url;
      return true;
    }
    if (m.op === "folder") return project;
    if (m.op === "local") {
      await desktopPage.goto(localOrigin + m.value.path); return true;
    }
    if (m.op === "server") {
      await pc.addCookies([
        { name: "rimeward_session", value: m.value.session, url: origin },
      ]);
      await desktopPage.goto(m.value.url);
      return true;
    }
    throw new Error("Unexpected native action");
  };
  desktopPage.on("dialog", (d) => {
    errors.push("Unexpected browser dialog: " + d.type());
    void d.dismiss();
  });
  await desktopPage.goto(url);
  await desktopPage.waitForURL("**/desktop/start");
  await desktopPage.screenshot({path:"/tmp/rimeward-first-run.png",fullPage:true,animations:"disabled"});
  await desktopPage
    .getByRole("textbox", { name: "Rimeward server address" })
    .fill(origin);
  await desktopPage
    .getByRole("button", { name: "Continue in browser" })
    .click();
  for (let i = 0; i < 100 && !verificationUrl; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(verificationUrl);
  assert.equal(await desktopPage.locator(".setup-progress [aria-current]").innerText(), "2\nApprove");
  const approvalContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const approval = await approvalContext.newPage();
  await approval.goto(verificationUrl);
  await approval.waitForURL("**/login");
  await approval.getByLabel("Email", { exact: true }).fill("test@example.com");
  await approval
    .getByLabel("Password", { exact: true })
    .fill("test-only-password");
  await approval.getByRole("button", { name: "Sign in", exact: true }).click();
  await approval.waitForURL("**/desktop/connect?code=*");
  const approved=approval.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/desktop/connect'));
  await approval.getByRole("button", { name: "Allow this desktop" }).click();
  const approvalResponse=await approved;
  assert.equal(approvalResponse.status(),200,(await approvalResponse.text()).slice(0,300)+" origin="+approvalResponse.request().headers().origin);
  await desktopPage
    .getByRole("button", { name: "Open Rimeward", exact: true })
    .waitFor().catch(async e=>{throw new Error(e.message+" | desktop: "+await desktopPage.locator('#setup-status').innerText()+" | browser: "+(await approval.evaluate(()=>document.body?.innerText))+" | "+errors.join(';'));});
  await desktopPage
    .getByRole("button", { name: "Open Rimeward", exact: true })
    .click();
  await desktopPage.waitForURL(localOrigin + "/dash");
  await pc.addCookies([{ name: 'rimeward_session', value: serverInfo.cookie, url: origin }]);
  await approvalContext.close();
  assert.equal(await desktopPage.getByRole('button', { name: 'Workspaces', exact: true }).count(), 0);
  await desktopPage.locator('[data-wd="server-rime"]').waitFor();
  const localRequest=async(route,method='GET',body)=>{
    const r=await fetch(localOrigin+route,{method,headers:{...localHeaders,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const value=await r.json();assert.equal(r.ok,true,JSON.stringify(value));return value;
  };
  await localRequest('/api/agent/history','POST',{action:'sync'});
  const initialHistory=await localRequest('/api/agent/history');
  assert.equal(initialHistory.sync.online,true,JSON.stringify(initialHistory.sync));
  assert.equal(initialHistory.sync.providers.codex,true);
  assert.ok(initialHistory.chats.some(c=>c.title==='Shared Rime history fixture'));
  assert.equal((await localRequest('/api/store/memory/shared')).body,'server memory');
  const appearance = JSON.parse((await localRequest('/api/runtime')).theme);
  assert.equal(appearance.iconSet, 'tabler');
  assert.equal(appearance.background, 'image');
  assert.equal(appearance.hdrScene, 'aurora');
  const localImage = await fetch(localOrigin + '/api/bg/' + appearance.bgImage, { headers: localHeaders });
  assert.equal(localImage.status, 200);
  assert.equal(localImage.headers.get('content-type'), 'image/webp');
  await desktopPage.reload();
  assert.equal(JSON.parse(await desktopPage.locator('html').getAttribute('data-icons')).set, 'tabler');
  // A server-owned Account page must work across independently built apps.
  await desktopPage.route(localOrigin + '/account', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('</head>', '<link rel="stylesheet" href="/_astro/account-server-build.css"><script type="module" src="/_astro/account-server-build.js"></script></head>') });
  });
  await desktopPage.goto(localOrigin + '/account');
  await desktopPage.waitForFunction(() => document.documentElement.dataset.accountServerBuild === 'ready');
  assert.equal(await desktopPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--account-server-build').trim()), 'ready');
  assert.equal(await desktopPage.locator('.acct-panel:visible').count(), 1);
  for (const name of ['Background', 'Header', 'Dashboard', 'Accounts', 'Agent', 'Security', 'Theme']) {
    await desktopPage.getByRole('tab', { name, exact: true }).click();
    assert.equal(await desktopPage.locator('.acct-panel:visible').count(), 1);
    assert.equal(await desktopPage.locator('.acct-panel:visible').getAttribute('id'), name.toLowerCase());
  }
  assert.ok(await desktopPage.locator('#theme .fd-ss-trigger').count(), 'searchable controls initialize');
  await desktopPage.locator('#th-alpha').fill('0.61');
  const checkpointAccount = () => desktopPage.evaluate(async () => {
    const waits = [];
    window.dispatchEvent(new CustomEvent('fd:before-workspace-navigation', { detail: { waitUntil(p) { waits.push(p); } } }));
    await Promise.all(waits);
  });
  await checkpointAccount();
  assert.equal(JSON.parse((await localRequest('/api/runtime')).theme).glassAlpha, 0.61, 'permission checkpoint flushes pending theme saves');
  if (process.platform === 'darwin') {
    await pc.addCookies([{ name: 'rimeward_ui_restore', value: '1', url: localOrigin, httpOnly: true, sameSite: 'Strict' }]);
    await desktopPage.reload();
    await desktopPage.locator('#acct-undo:not(.hidden)').waitFor();
    assert.equal(await desktopPage.locator('meta[name="fd-mac-user"]').getAttribute('data-restore'), '1');
  }
  await desktopPage.screenshot({ path: '/tmp/rimeward-account-local.png', animations: 'disabled' });
  await desktopPage.getByRole('tab', { name: 'Security', exact: true }).click();
  await desktopPage.locator('#next').fill('unsaved-fixture-only');
  await assert.rejects(checkpointAccount, /finish editing your account forms/);
  await desktopPage.locator('#next').fill('');
  assert.equal((await fetch(localOrigin + '/_astro/account-server-build.css')).status, 401, 'server assets require the local session');
  await desktopPage.unroute(localOrigin + '/account');
  await desktopPage.goto(localOrigin + '/dash');
  unavailableHarness=true;
  await localRequest('/api/agent/history','POST',{action:'sync'});
  assert.equal((await localRequest('/api/agent/history')).sync.online,false);
  assert.equal((await fetch(localOrigin + '/api/bg/' + appearance.bgImage, { headers: localHeaders })).status, 200, 'wallpaper is available from the local cache offline');
  const offlineTheme = await fetch(localOrigin + '/api/account/theme', { method: 'POST', headers: { ...localHeaders, 'content-type': 'application/x-www-form-urlencoded' }, body: 'mode=light', redirect: 'manual' });
  assert.equal(offlineTheme.status, 303);
  assert.equal(JSON.parse((await localRequest('/api/runtime')).theme).mode, 'light');

  await localRequest('/api/store/memory/shared','PUT',{description:'Shared memory',body:'desktop offline edit'});
  await localRequest('/api/store/memory/offline-new','PUT',{description:'Offline note',body:'created offline'});
  const remoteEdit=await pc.request.put(origin+'/api/store/memory/shared',{data:{description:'Shared memory',body:'server concurrent edit'}});
  assert.equal(remoteEdit.status(),200);
  unavailableHarness=false;
  await localRequest('/api/agent/history','POST',{action:'sync'});
  const reconciled=await localRequest('/api/agent/history');
  assert.equal(reconciled.sync.online,true,JSON.stringify(reconciled.sync));
  const sharedAppearance = await (await pc.request.get(origin + '/api/runtime')).json();
  assert.equal(JSON.parse(sharedAppearance.theme).mode, 'light', 'offline theme edits reconcile to the same account');

  assert.equal((await localRequest('/api/store/memory/shared')).body,'server concurrent edit');
  const savedConflict=reconciled.sync.conflicts.find(c=>c.key==='work/memory/shared.md');assert.ok(savedConflict);
  const copy=await localRequest('/api/agent/history?conflict='+savedConflict.id);
  assert.match(Buffer.from(JSON.parse(copy.payload),'base64').toString(),/desktop offline edit/);
  assert.equal((await (await pc.request.get(origin+'/api/store/memory/offline-new')).json()).body,'created offline');
  // A terminal without a project exposes the same project creation dialog.
  const isolated = await desktopPage.evaluate(async () => {
    const d = await fetch("/api/runtime").then((r) => r.json());
    const r = await fetch("/api/dashboard", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...d,
        layout: [
          ...d.layout,
          { i: "terminal-empty", type: "terminal", size: "3x2" },
        ],
      }),
    });
    return r.status;
  });
  assert.equal(isolated, 200);
  await desktopPage.reload();
  const terminalCard = desktopPage.locator('[data-wd="terminal-empty"]');
  await terminalCard
    .getByRole("button", { name: "Open / new project" })
    .click();
  await desktopPage
    .getByRole("button", { name: "New project", exact: true })
    .click();
  await desktopPage
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("terminal-created");
  assert.ok(await desktopPage.locator(".dev-project-dialog").evaluate(el=>parseFloat(getComputedStyle(el).paddingLeft)>=16), "project dialog keeps its padding");
  await desktopPage.screenshot({path:"/tmp/rimeward-project-picker.png",animations:"disabled"});
  await desktopPage
    .getByRole("textbox", { name: "Parent folder", exact: true })
    .fill(temporary);
  await desktopPage
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await terminalCard.getByRole("button", { name: "Open terminal", exact: true }).waitFor();
  assert.ok(fs.existsSync(path.join(temporary, "terminal-created")));
  // Exercise the button itself instead of bypassing it through the API.
  await desktopPage
    .getByRole("button", { name: "Open project", exact: true })
    .click();
  await desktopPage
    .getByRole("textbox", { name: "Project folder", exact: true })
    .fill(project);
  await desktopPage.getByRole("dialog", { name: "Open a project" })
    .getByRole("button", { name: "Open project", exact: true })
    .click();
  await desktopPage.waitForURL(u=>u.pathname.endsWith("/dash")&&u.hash.startsWith("#p="));
  const preset = { page: new URL(desktopPage.url()).hash.slice(3) };
  const rime=desktopPage.locator('[data-wd-type=agent]:not([data-wd-off])');
  const rimeId=await rime.getAttribute('data-wd');
  const rimeState=await localRequest('/api/agent/'+rimeId);
  assert.equal(rimeState.provider,'codex','new project Rime inherits the server provider');
  assert.equal(rimeState.configured,true,'server auth needs no second local login');
  await rime.getByRole('button',{name:'Expand chat',exact:true}).click();
  const expandedRime=desktopPage.locator('#agent-dialog');
  await expandedRime.getByRole('button',{name:'Chat history',exact:true}).click();
  const historyDialog=desktopPage.getByRole('dialog',{name:'Rime history'});
  await historyDialog.getByRole('button',{name:/Shared Rime history fixture/}).click();
  await historyDialog.getByRole('button',{name:'Continue here',exact:true}).click();
  await historyDialog.waitFor({state:'hidden'});
  await expandedRime.getByRole('button',{name:'Close chat',exact:true}).click();
  await rime.getByRole('log',{name:'Conversation'}).getByText('Shared Rime history fixture',{exact:true}).waitFor();
  unavailableHarness=true;
  await localRequest('/api/agent/history','POST',{action:'sync'});
  await desktopPage.reload();
  await rime.getByRole('log',{name:'Conversation'}).getByText('Shared Rime history fixture',{exact:true}).waitFor();
  assert.equal(await rime.getByRole('button',{name:'Send message',exact:true}).isEnabled(),false);
  unavailableHarness=false;
  await localRequest('/api/agent/history','POST',{action:'sync'});
  const requestModel=async()=>{
    const response=await fetch(localOrigin+'/api/agent/'+rimeId,{method:'POST',headers:{...localHeaders,'content-type':'application/json'},body:JSON.stringify({message:'Shared model transport fixture'})});
    assert.equal(response.status,200);return response.text();
  };
  modelFixture={status:400,body:{error:'Fixture model is not available'}};
  assert.match(await requestModel(),/Model request request-rejected \(HTTP 400\).*Reference [a-f0-9-]{36}/);
  assert.equal((await localRequest('/api/agent/'+rimeId)).sync.online,true,'a rejected model request does not disconnect Rime');
  modelFixture={status:200,body:{text:'Shared model transport works',calls:[],items:[]}};
  assert.match(await requestModel(),/Shared model transport works/);
  assert.equal(modelRequests,2,'one request per turn, no blind replay');modelFixture=null;
  const post = async (page, route, body) =>
    page.evaluate(
      async ({ route, body }) => {
        const r = await fetch(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const value = await r.json();
        if (!r.ok) throw new Error(JSON.stringify(value));
        return value;
      },
      { route, body },
    );

  await desktopPage.waitForLoadState("domcontentloaded");
  const p = (
    await desktopPage.evaluate(() =>
      fetch("/api/dev/projects").then((r) => r.json()),
    )
  ).find((p) => p.root === fs.realpathSync(project));
  await phone.addCookies([
    { name: "rimeward_session", value: serverInfo.cookie, url: origin },
  ]);
  const phonePage = await phone.newPage();
  phonePage.on("pageerror", (e) => errors.push(e.message));
  await phonePage.goto(origin + "/dash");

  let devices = [];
  for (let i = 0; i < 30; i++) {
    devices = await phonePage.evaluate(() =>
      fetch("/api/devices/list").then((r) => r.json()),
    );
    if (devices[0]?.online) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(devices[0]?.online);
  const session = await post(desktopPage, "/api/dev/sessions", {
    project: p.id,
    kind: "shell",
    mode: "human",
  });
  await post(desktopPage, "/api/dev/control", {
    id: session.id,
    owner: "client:pc",
    takeover: true,
  });
  await post(desktopPage, "/api/dev/input", {
    id: session.id,
    owner: "client:pc",
    data: "echo " + marker + "\r",
  });
  const base = "/runtime/" + devices[0].id;
  // A project is an ordinary tab in the same instance, on desktop and phone.
  await localRequest('/api/agent/history', 'POST', { action: 'sync' });
  await phonePage.reload();
  await phonePage.locator('#wd-pages').getByRole('button', { name: 'project', exact: true }).click();
  await phonePage.waitForURL(origin + '/dash#p=' + preset.page);
  assert.equal(await phonePage.getByRole('button', { name: 'Workspaces', exact: true }).count(), 0);
  await phonePage.screenshot({ path: '/tmp/rimeward-workspaces-phone.png', animations: 'disabled' });
  await phonePage.waitForTimeout(1000);
  const remote = await phonePage.evaluate(
    (id) => fetch("/api/dev/sessions?id=" + id).then((r) => r.json()),
    session.id,
  );
  assert.ok(remote.screen.includes(marker));
  await post(phonePage, "/api/dev/control", {
    id: session.id,
    owner: "client:phone",
    takeover: true,
  });
  await post(phonePage, "/api/dev/input", {
    id: session.id,
    owner: "client:phone",
    data: "echo PHONE_CONTINUED\r",
  });
  const initial = await phonePage.evaluate(
    (id) =>
      fetch("/api/dev/buffer?project=" + id + "&path=hello.txt").then((r) =>
        r.json(),
      ),
    p.id,
  );
  await post(phonePage, "/api/dev/buffer", {
    project: p.id,
    path: "hello.txt",
    text: marker,
    revision: initial.revision,
    owner: "client:phone",
  });
  const back = await desktopPage.evaluate(
    (id) =>
      fetch("/api/dev/buffer?project=" + id + "&path=hello.txt").then((r) =>
        r.json(),
      ),
    p.id,
  );
  assert.equal(back.text, marker);
  assert.equal(
    fs.readFileSync(path.join(project, "hello.txt"), "utf8"),
    "hello\n",
  );
  await phonePage
    .locator("[data-wd-type=editor] .editor-explorer")
    .getByRole("button", { name: "hello.txt", exact: true })
    .click();
  await phonePage
    .locator("#wd-grid [data-wd-type=editor] .cm-content")
    .filter({ hasText: marker })
    .waitFor();
  await desktopPage
    .locator("[data-wd-type=editor] .editor-explorer")
    .getByRole("button", { name: "hello.txt", exact: true })
    .click();
  await desktopPage
    .locator("#wd-grid [data-wd-type=editor] .cm-content")
    .filter({ hasText: marker })
    .waitFor();
  const phoneEditor = phonePage.locator("[data-wd-type=editor]");
  await phoneEditor
    .getByRole("button", { name: "Take over", exact: true })
    .click();
  const editable = phoneEditor.locator(".cm-content[contenteditable=true]");
  await editable.waitFor();
  await editable.click();
  await phonePage.keyboard.press(
    process.platform === "darwin" ? "Meta+A" : "Control+A",
  );
  await phonePage.keyboard.insertText(marker + "_UI");
  let edited;
  for (let i = 0; i < 30; i++) {
    edited = await desktopPage.evaluate(
      (id) =>
        fetch("/api/dev/buffer?project=" + id + "&path=hello.txt").then((r) =>
          r.json(),
        ),
      p.id,
    );
    if (edited.text === marker + "_UI") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(edited.text, marker + "_UI");
  assert.equal(
    fs.readFileSync(path.join(project, "hello.txt"), "utf8"),
    "hello\n",
  );
  await phonePage
    .locator(`[data-wd-type=terminal]:not([data-wd-off]) [role=tab][data-session="${session.id}"]`)
    .click();
  await phonePage
    .locator("[data-wd-type=terminal]:not([data-wd-off])")
    .getByRole("button", { name: "Expand terminal", exact: true })
    .click();
  await phonePage
    .locator("dialog[open]")
    .getByRole("button", { name: "Take control", exact: true })
    .click();
  await phonePage.waitForFunction(() =>
    document.activeElement?.classList.contains("xterm-helper-textarea"),
  );
  await phonePage.keyboard.type("echo UI_CONTINUED");
  await phonePage.keyboard.press("Enter");
  await phonePage.waitForTimeout(700);
  const visibleInput = await desktopPage.evaluate(
    (id) => fetch("/api/dev/sessions?id=" + id).then((r) => r.json()),
    session.id,
  );
  assert.match(visibleInput.screen, /UI_CONTINUED/);
  await phonePage.screenshot({
    path: "/tmp/rimeward-phone-handoff.png",
    fullPage: true,
  });
  await desktopPage.screenshot({
    path: "/tmp/rimeward-desktop-handoff.png",
    fullPage: true,
  });
  // Returning to the server and back keeps the exact terminal process and selected project.
  unavailableNavigation = true;
  const legacyNavigation = await fetch(localOrigin + "/api/dev/navigation", { headers: localHeaders }).then(r => r.json());
  const connectedServer = legacyNavigation.workspaces.find(w => w.kind === "server");
  assert.equal(connectedServer.online, true, "missing page-list support must not hide a connected server");
  assert.match(connectedServer.error, /Page list unavailable/);
  unavailableNavigation = false;
  await desktopPage.locator('#wd-pages').getByRole('button', { name: 'Home', exact: true }).click();
  await desktopPage.locator('#wd-pages').getByRole('button', { name: 'project', exact: true }).click();
  assert.equal(new URL(desktopPage.url()).origin, localOrigin, 'page changes do not switch app origins');
  await desktopPage.locator("#wd-grid [data-wd-type=editor] .cm-content").filter({ hasText: marker + "_UI" }).waitFor();
  assert.deepEqual(errors, []);
  // The new ward crosses the real account/device relay, using only generated native pixels.
  await phonePage.evaluate(async device => {
    const html = await fetch('/dash').then(r => r.text());
    const layout = JSON.parse(new DOMParser().parseFromString(html, 'text/html').getElementById('layout-data').textContent);
    const saved = await fetch('/api/dashboard', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      layout: [...layout, { i: 'remote-fixture', type: 'remote-desktop', size: '6x4', device }],
    }) });
    if (!saved.ok) throw Error(await saved.text());
  }, devices[0].id);
  const remoteDesktopFixture = await phonePage.evaluate(async device => {
    const response = await fetch('/api/remote-desktop/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 1, device, ward: 'remote-fixture', capabilities: ['screen','input'] }) });
    if (!response.ok) throw Error(await response.text());
    return response.json();
  }, devices[0].id);
  assert.equal(remoteDesktopFixture.transport, 'compatibility'); assert.equal(remoteOwner, null);
  const relayed = await phonePage.evaluate(async id => {
    const action = body => fetch('/api/remote-desktop/sessions/'+id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const frame = await action({ action: 'frame', ack: 0 });
    const bytes = (await frame.arrayBuffer()).byteLength;
    const stale = await action({ action: 'frame', ack: 0 });
    const acquired = await (await action({ action: 'acquire' })).json();
    await action({ action: 'disconnect' });
    const closed = await action({ action: 'status' });
    return { bytes, stale: stale.status, ownership: acquired.ownership, closed: closed.status };
  }, remoteDesktopFixture.id);
  assert.equal(relayed.bytes, remotePixels.length); assert.equal(relayed.stale, 409); assert.equal(relayed.ownership, 1); assert.equal(relayed.closed, 404); assert.equal(remoteOwner,null);
  await phonePage.close();
  const unchanged = await desktopPage.evaluate(
    (id) => fetch("/api/dev/sessions?id=" + id).then((r) => r.json()),
    session.id,
  );
  assert.equal(unchanged.session.id, session.id);
  assert.equal(unchanged.session.state, "running");
  desktop.stdin.write('{"type":"shutdown"}\n');
  await once(desktop, "exit");
  const offline = await phone.newPage();
  const reply = await offline.goto(origin + base + "/dash");
  assert.equal(reply.status(), 503);
  await offline.getByRole("heading", { name: "This computer is disconnected." }).waitFor();
  await offline.getByRole("link", { name: "Open server dashboard" }).click();
  await offline.waitForURL(origin + "/dash");
  assert.equal((await offline.goto(origin + "/dash")).status(), 200);
  for (const entry of fs.readdirSync(path.join(temporary, "server"))) {
    const filename = path.join(temporary, "server", entry);
    if (fs.statSync(filename).isFile())
      assert.ok(
        !fs.readFileSync(filename).includes(Buffer.from(marker)),
        entry,
      );
  }
  assert.ok(!logs.includes(marker));
  console.log(
    "Unified page navigation, shared appearance, Rime auth availability, model relay/error handling, history, offline memory edits, conflict recovery, and reconnect passed. PC → phone → PC keeps the same terminal and recovery buffer; desktop offline keeps server usable; project marker stays off server data/logs. Model responses are fixtures; no external provider calls.",
  );
} finally {
  if (browser) await browser.close();
  for (const p of children) if (p.exitCode === null) p.kill("SIGTERM");
  for (const s of connections) s.destroy();
  proxy?.close();
  fs.rmSync(path.join(repo, "tests/.handoff-server-fixture.mjs"), {
    force: true,
  });
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(temporary, { recursive: true, force: true });
}
