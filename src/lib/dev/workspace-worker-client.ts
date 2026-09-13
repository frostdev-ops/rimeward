import http from 'node:http';
import { Readable } from 'node:stream';
import { DevError } from './runtime.ts';

function socketRequest(socketPath:string,body:unknown,token?:string,signal?:AbortSignal):Promise<ReturnType<typeof JSON.parse>> {
  return new Promise((resolve,reject)=>{
    const request=http.request({socketPath,path:'/',method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},signal},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>32*1024*1024)request.destroy(new Error('Worker response exceeds limit.'));else chunks.push(chunk);});
      response.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString());if((response.statusCode??500)>=400)reject(new DevError(value.error??'Workspace worker unavailable.',response.statusCode));else resolve(value);}catch(error){reject(error);}});response.on('error',reject);
    });
    request.on('error',error=>reject(new DevError(`Workspace worker connection failed: ${error.message}. Inspect operation status before retrying a write.`,503)));
    request.setTimeout(60000,()=>request.destroy(new Error('Worker response timed out; operation status is unknown.')));request.end(JSON.stringify(body));
  });
}
export async function workerRequest(user:number,action:string,args:Record<string,unknown>,signal?:AbortSignal){
  if(!Number.isSafeInteger(user)||user<1)throw new DevError('Invalid worker account.',403);
  const worker=await socketRequest(process.env.RIMEWARD_WORKER_SUPERVISOR_SOCKET??'/run/rimeward-worker-supervisor.sock',{operation:'ensure',account:user},undefined,signal);
  return socketRequest(worker.socketPath,{action,args},worker.token,signal);
}
export async function workerEvents(user:number,rootIds:string[],signal?:AbortSignal):Promise<Response>{
  const worker=await socketRequest(process.env.RIMEWARD_WORKER_SUPERVISOR_SOCKET??'/run/rimeward-worker-supervisor.sock',{operation:'ensure',account:user},undefined,signal);
  return new Promise((resolve,reject)=>{const request=http.request({socketPath:worker.socketPath,path:'/',method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${worker.token}`},signal},response=>resolve(new Response(Readable.toWeb(response) as ReadableStream,{status:response.statusCode??500,headers:{'content-type':'text/event-stream'}})));request.on('error',reject);request.end(JSON.stringify({action:'events',args:{rootIds}}));});
}
