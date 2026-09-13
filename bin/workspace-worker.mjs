// Dedicated unprivileged execution process. Never import the web server environment.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
const allowedEnvironment=new Set(['HOME','USER','LOGNAME','PATH','LANG','RIMEWARD_WORKER_ACCOUNT','CREDENTIALS_DIRECTORY']);
for(const name of Object.keys(process.env))if(!allowedEnvironment.has(name))delete process.env[name];
process.env.PATH='/usr/local/bin:/usr/bin:/bin';
const account = Number(process.env.RIMEWARD_WORKER_ACCOUNT);
if (process.platform !== 'linux' || process.getuid() === 0 || !Number.isSafeInteger(account) || account < 1) throw Error('A dedicated non-root Linux worker account is required.');
const workerHome = process.env.HOME;
if (!workerHome || workerHome !== `/var/lib/rimeward/workers/u${account}`) throw Error('Worker home does not match its account.');
process.env.RIMEWARD_WORKER = '1';
process.env.HOMEPAGE_DATA_DIR = path.join(workerHome,'.local','share','Rimeward');
process.env.RIMEWARD_DOCUMENTS_DIR = path.join(workerHome,'Documents');
delete process.env.RIMEWARD_DESKTOP;
delete process.env.RIMEWARD_NATIVE_TOKEN;
const token = fs.readFileSync(path.join(process.env.CREDENTIALS_DIRECTORY ?? '', 'auth'),'utf8').trim();
process.env.TOKEN_ENC_KEY = fs.readFileSync(path.join(process.env.CREDENTIALS_DIRECTORY ?? '', 'encryption'),'utf8').trim();
if (token.length < 40) throw Error('Missing worker authentication credential.');
const root = await import('../src/lib/dev/workspace-roots.ts');
const ssh = await import('../src/lib/dev/workspace-ssh.ts');
const socketPath = `/run/rimeward-workers/u${account}/worker.sock`;
try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const server = http.createServer(async(request,response)=>{
  const supplied=String(request.headers.authorization??'').replace(/^Bearer /,'');
  if(Buffer.byteLength(supplied)!==Buffer.byteLength(token)||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(token))){response.writeHead(403).end();return;}
  const abort=new AbortController();response.on('close',()=>{if(!response.writableEnded)abort.abort();});
  try{
    const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>16*1024*1024)throw Error('Worker request exceeds limit.');chunks.push(chunk);}
    const {action,args={}}=JSON.parse(Buffer.concat(chunks).toString());let value;
    if(action==='events'){const {rootEvents}=await import('../src/lib/dev/workspace-events.ts');const events=rootEvents(account,args.rootIds,abort.signal);response.writeHead(200,Object.fromEntries(events.headers));const reader=events.body.getReader();try{for(;;){const chunk=await reader.read();if(chunk.done)break;response.write(chunk.value);}}finally{reader.releaseLock();response.end();}return;}
    if(action==='roots')value={roots:root.roots(account),connections:await ssh.sshConnections(account)};
    else if(action==='legacy'){const {workDb}=await import('../src/lib/dev/runtime.ts');const {listSessions}=await import('../src/lib/dev/terminals.ts');value={projects:root.roots(account),views:Object.fromEntries(workDb().prepare('SELECT ward,json FROM ward_state WHERE user_id=?').all(account).map(row=>[row.ward,JSON.parse(row.json)])),sessions:listSessions(account)};}
    else if(action==='default')value=await root.defaultRoot(account);
    else if(action==='register')value=await root.registerRoot(account,args);
    else if(action==='ssh')value=await ssh.configureSsh(account,args);
    else if(action==='operation')value=await root.rootOperation(account,String(args.rootId),String(args.operation),args.args??{},String(args.owner),abort.signal);
    else throw Error('Unsupported worker operation.');
    response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(value??null));
  }catch(error){response.writeHead(Number(error.status)||400,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({error:error.message}));}
});
server.listen(socketPath,()=>fs.chmodSync(socketPath,0o660)); // Parent setgid directory grants only this worker and the control-service group.
