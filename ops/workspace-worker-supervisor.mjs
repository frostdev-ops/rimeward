// Root-owned, fixed-function provisioning service. It never accepts commands or paths over RPC.
import fs from 'node:fs/promises';
import http from 'node:http';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const exec=promisify(execFile);
if(process.platform!=='linux'||process.getuid()!==0)throw Error('The administrator must install and run this Linux service as root.');
const configuration=JSON.parse(await fs.readFile('/etc/rimeward/workspace-workers.json','utf8'));
const cleanEnv={PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8'};
const command=(file,args)=>exec(file,args,{env:cleanEnv,timeout:30000,maxBuffer:128*1024});
const inflight=new Map();
async function ensure(account){
  if(!Number.isSafeInteger(account)||account<1)throw Error('Invalid account.');
  if(inflight.has(account))return inflight.get(account);
  const operation=(async()=>{
    const name=`rimeward-u${account}`,home=`/var/lib/rimeward/workers/u${account}`,run=`/run/rimeward-workers/u${account}`;
    for(const parent of ['/var/lib/rimeward/workers','/run/rimeward-workers']){await fs.mkdir(parent,{recursive:true,mode:0o755});const stat=await fs.lstat(parent);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o022))throw Error('Worker parent directory must be protected and root-owned.');await fs.chmod(parent,0o755);}
    let entry;try{entry=(await command('/usr/bin/getent',['passwd',name])).stdout.trim().split(':');}catch{await command('/usr/sbin/useradd',['--system','--create-home','--home-dir',home,'--shell','/bin/sh',name]);entry=(await command('/usr/bin/getent',['passwd',name])).stdout.trim().split(':');}
    const uid=Number(entry[2]);if(!uid||entry[5]!==home)throw Error('Existing OS account does not match the worker allocation.');
    const homeStat=await fs.lstat(home);if(!homeStat.isDirectory()||homeStat.isSymbolicLink()||homeStat.uid!==uid)throw Error('Worker home ownership does not match its OS account.');
    await fs.chmod(home,0o700);await fs.mkdir(run,{recursive:true,mode:0o750});const runStat=await fs.lstat(run);if(!runStat.isDirectory()||runStat.isSymbolicLink())throw Error('Worker runtime directory is invalid.');await fs.chown(run,uid,configuration.webGid);await fs.chmod(run,0o2750);
    await fs.mkdir('/var/lib/rimeward/worker-tokens',{recursive:true,mode:0o700});
    const credential=`/var/lib/rimeward/worker-tokens/u${account}`;let token;
    try{token=(await fs.readFile(credential,'utf8')).trim();}catch(error){if(error.code!=='ENOENT')throw error;token=crypto.randomBytes(48).toString('base64url');await fs.writeFile(credential,token,{flag:'wx',mode:0o600});}
    try{await fs.writeFile(`${credential}-encryption`,crypto.randomBytes(32).toString('base64'),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
    const unit=`rimeward-workspace@${account}`;
    const active=await command('/usr/bin/systemctl',['is-active',`${unit}.service`]).then(r=>r.stdout.trim()==='active',()=>false);
    if(!active)await command('/usr/bin/systemctl',['start',`${unit}.service`]);
    const socketPath=path.join(run,'worker.sock');for(let attempt=0;attempt<100;attempt++){try{if((await fs.stat(socketPath)).isSocket())return {socketPath,token};}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Worker did not become ready.');
  })();inflight.set(account,operation);try{return await operation;}finally{inflight.delete(account);}
}
const socket='/run/rimeward-worker-supervisor.sock';try{await fs.unlink(socket);}catch(error){if(error.code!=='ENOENT')throw error;}
const server=http.createServer(async(request,response)=>{
  try{const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>4096)throw Error('Request exceeds limit.');chunks.push(chunk);}const input=JSON.parse(Buffer.concat(chunks).toString());if(input.operation!=='ensure')throw Error('Unsupported provisioning operation.');const result=await ensure(input.account);response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));}
  catch(error){response.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:error.message}));}
});
server.listen(socket,async()=>{await fs.chmod(socket,0o600);await fs.chown(socket,configuration.webUid,configuration.webGid);});
