import './_setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workerRequest } from '../src/lib/dev/workspace-worker-client.ts';

test('worker routing provisions the authenticated account and never retries an uncertain mutation',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rime-worker-rpc-'));
  const socketDirectory=process.platform==='win32'?`\\\\.\\pipe\\${path.basename(directory)}`:directory;
  const supervisorPath=path.join(socketDirectory,'supervisor.sock'),workerPath=path.join(socketDirectory,'worker.sock');
  const original=process.env.RIMEWARD_WORKER_SUPERVISOR_SOCKET;
  const ensured:unknown[]=[];let requests=0,disconnect=false;
  const worker=http.createServer(async(request,response)=>{
    requests++;assert.equal(request.headers.authorization,'Bearer fixture-only-worker-token');
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    const payload=JSON.parse(Buffer.concat(chunks).toString());
    if(disconnect){request.socket.destroy();return;}
    response.setHeader('content-type','application/json');response.end(JSON.stringify({action:payload.action,roots:[]}));
  });
  const supervisor=http.createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    ensured.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader('content-type','application/json');response.end(JSON.stringify({socketPath:workerPath,token:'fixture-only-worker-token'}));
  });
  worker.listen(workerPath);supervisor.listen(supervisorPath);await Promise.all([once(worker,'listening'),once(supervisor,'listening')]);
  process.env.RIMEWARD_WORKER_SUPERVISOR_SOCKET=supervisorPath;
  try{
    assert.deepEqual(await workerRequest(17,'roots',{}),{action:'roots',roots:[]});
    assert.deepEqual(ensured,[{operation:'ensure',account:17}]);
    disconnect=true;await assert.rejects(workerRequest(17,'operation',{operation:'write-bytes'}),/Inspect operation status before retrying/);
    assert.equal(requests,2,'one successful read and exactly one dispatched mutation');
    await assert.rejects(workerRequest(0,'roots',{}),/Invalid worker account/);
    assert.equal(ensured.length,2,'invalid account never reaches the supervisor');
  }finally{
    if(original===undefined)delete process.env.RIMEWARD_WORKER_SUPERVISOR_SOCKET;else process.env.RIMEWARD_WORKER_SUPERVISOR_SOCKET=original;
    worker.closeAllConnections();supervisor.closeAllConnections();await Promise.all([new Promise<void>(resolve=>worker.close(()=>resolve())),new Promise<void>(resolve=>supervisor.close(()=>resolve()))]);await fs.rm(directory,{recursive:true,force:true});
  }
});

test('the worker entrypoint refuses the ordinary process identity before loading application data',async()=>{
  const exec=promisify(execFile);
  await assert.rejects(exec(process.execPath,['bin/workspace-worker.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{PATH:process.env.PATH,HOME:'/tmp/not-a-worker',RIMEWARD_WORKER_ACCOUNT:'17'}}),error=>error instanceof Error&&/dedicated non-root Linux worker|Worker home does not match/.test(String((error as Error&{stderr?:string}).stderr)));
});
