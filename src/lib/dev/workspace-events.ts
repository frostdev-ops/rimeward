import { subscribeDev, workDb, DevError, isDesktop } from './runtime.ts';
import { rootOf } from './workspace-roots.ts';
import { currentRuntimeId, resolveWorkspaceForWard } from './workspaces.ts';
import { instanceRequest } from './remote.ts';
import { relayRequest } from './devices.ts';
import { workerEvents } from './workspace-worker-client.ts';

const headers = { 'content-type':'text/event-stream', 'cache-control':'no-store, no-transform', 'x-accel-buffering':'no' };
export function rootEvents(user:number, rootIds:string[], signal?:AbortSignal):Response {
  if (!Array.isArray(rootIds) || rootIds.length > 16) throw new DevError('Invalid event roots.');
  for (const id of rootIds) rootOf(user,id);
  const allowed = new Set(rootIds), encoder = new TextEncoder();
  let finish = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false, stop = () => {};
      finish = () => { if (ended) return; ended=true; clearInterval(timer); stop(); signal?.removeEventListener('abort',finish); try { controller.close(); } catch {} };
      const send = (text:string) => { if (ended) return; if ((controller.desiredSize??0)<0) { finish(); return; } controller.enqueue(encoder.encode(text)); };
      const timer = setInterval(() => send(': heartbeat\n\n'),15000);
      stop = subscribeDev(user,event => {
        if (event.type !== 'reset') {
          if (['buffer','project'].includes(event.type)) { if (!allowed.has(event.id)) return; }
          else if (event.type==='session' || event.type==='output') {
            const row = workDb().prepare('SELECT project FROM terminal_sessions WHERE id=? AND user_id=?').get(event.id,user) as {project:string}|undefined;
            if (!row || !allowed.has(row.project)) return;
          } else return;
        }
        send('data: ' + JSON.stringify(event) + '\n\n');
      });
      signal?.addEventListener('abort',finish,{once:true});
      if (signal?.aborted) finish();
    },
    cancel() { finish(); },
  },new ByteLengthQueuingStrategy({highWaterMark:4*1024*1024}));
  return new Response(body,{headers});
}

const refreshers = new Map<string,Set<()=>void>>();
export function refreshWorkspaceEvents(user:number,ward:string):void {
  for(const refresh of refreshers.get(user+':'+ward)??[])refresh();
}
export async function workspaceEvents(user:number,ward:string,signal?:AbortSignal):Promise<Response> {
  const {getDashboard}=await import('../dashboard.ts');
  const {readTerminalPlacements}=await import('./terminal-placement.ts');
  const consumer=getDashboard(user).find(w=>w.i===ward);
  if(!consumer)throw new DevError('Ward not found.',404);
  const unlinked=consumer.type==='terminal'&&!consumer.workspace,own=await currentRuntimeId(user);
  let directory=unlinked?await readTerminalPlacements(user,ward):undefined;
  const binding=directory?.placements.length?undefined:await resolveWorkspaceForWard(user,ward);
  const primary=unlinked?undefined:binding?.mounts.find(m=>m.mountPath==='/');
  const abort=new AbortController(),onAbort=()=>abort.abort();
  signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)abort.abort();
  const open=async(runtime:string,ids:string[],requestSignal:AbortSignal)=>{
    if(runtime===own)return rootEvents(user,ids,requestSignal);
    if(runtime==='worker:'+user&&!isDesktop())return workerEvents(user,ids,requestSignal);
    if(runtime.startsWith('worker:')&&isDesktop()){const url='/api/workspaces?workerEvents='+encodeURIComponent(ids.join(','));return instanceRequest(user,url,new Request('https://rimeward.invalid'+url,{signal:requestSignal}));}
    const url='/api/workspaces?rootEvents='+encodeURIComponent(ids.join(',')),request=new Request('https://rimeward.invalid'+url,{signal:requestSignal});
    return isDesktop()?instanceRequest(user,'/runtime/'+runtime+url,request):relayRequest(user,runtime,url,request);
  };
  let sequence=0,finish=()=>{};
  const encoder=new TextEncoder(),key=user+':'+ward,active=new Map<string,AbortController>(),allowedSessions=new Set<string>();
  const body=new ReadableStream<Uint8Array>({
    start(out){
      let ended=false,busy=false,lastDirectory='';
      const emit=(event:object)=>{if(ended)return;if((out.desiredSize??0)<0){finish();return;}out.enqueue(encoder.encode('data: '+JSON.stringify({...event,sequence:++sequence})+'\n\n'));};
      const heartbeat=setInterval(()=>{if(ended)return;if((out.desiredSize??0)<0){finish();return;}out.enqueue(encoder.encode(': heartbeat\n\n'));},15000);
      const connect=(group:string,runtime:string,ids:string[])=>{
        const connection=new AbortController();active.set(group,connection);
        const combined=AbortSignal.any([abort.signal,connection.signal]);
        void(async()=>{
          while(!combined.aborted){
            let reader:ReadableStreamDefaultReader<string>|undefined;
            try{
              const response=await open(runtime,ids,combined);if(!response.ok||!response.body)throw new Error('Workspace event source unavailable.');
              reader=response.body.pipeThrough(new TextDecoderStream()).getReader();let pending='';
              emit({type:'reset',id:'',data:{runtimeId:runtime,online:true}});
              for(;;){
                const chunk=await reader.read();if(chunk.done)throw new Error('Workspace event connection ended.');
                pending+=chunk.value;if(pending.length>4*1024*1024)throw new Error('Workspace event exceeds limit.');
                while(pending.includes('\n\n')){
                  const end=pending.indexOf('\n\n'),frame=pending.slice(0,end);pending=pending.slice(end+2);
                  const data=frame.split('\n').find(line=>line.startsWith('data: '));if(!data)continue;
                  const event=JSON.parse(data.slice(6));if(event.type==='reset')continue;
                  if(unlinked&&(!['session','output'].includes(event.type)||!allowedSessions.has(event.id)))continue;
                  emit(event);
                }
              }
            }catch(error){
              if(combined.aborted)return;
              if(primary&&runtime===primary.runtimeId&&ids.includes(primary.rootId)){out.error(error);finish();return;}
              emit({type:'reset',id:'',data:{runtimeId:runtime,online:false}});
            }finally{await reader?.cancel().catch(()=>{});reader?.releaseLock();}
            await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);combined.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,5000);combined.addEventListener('abort',done,{once:true});if(combined.aborted)done();});
          }
        })();
      };
      const refresh=()=>{
        if(ended||busy)return;busy=true;
        void(async()=>{
          if(unlinked)directory=await readTerminalPlacements(user,ward);
          const byRuntime=new Map<string,string[]>();
          const add=(runtime:string,root:string)=>{const ids=byRuntime.get(runtime)??[];if(!ids.includes(root))ids.push(root);byRuntime.set(runtime,ids);};
          if(unlinked&&directory?.placements.length){
            allowedSessions.clear();for(const ref of directory.placements)allowedSessions.add(ref.sessionId);
            const view=directory.view,selected=new Set([...(view?.tabs??[]),...(view?.session?[view.session]:[])]);
            const refs=selected.size?directory.placements.filter(ref=>selected.has(ref.sessionId)):directory.placements.slice(0,1);
            for(const ref of refs)add(ref.runtimeId,ref.rootId);
          }else if(binding)for(const mount of binding.mounts)add(mount.runtimeId,mount.rootId);
          const wanted=new Set<string>();
          for(const[runtime,all]of byRuntime){all.sort();for(let offset=0;offset<all.length;offset+=16){const ids=all.slice(offset,offset+16),group=runtime+':'+ids.join(',');wanted.add(group);if(!active.has(group))connect(group,runtime,ids);}}
          for(const[group,connection]of active)if(!wanted.has(group)){connection.abort();active.delete(group);}
          const version=JSON.stringify([directory?.view,[...allowedSessions].sort(),[...wanted].sort(),directory?.offline]);
          if(version!==lastDirectory){lastDirectory=version;emit({type:'reset',id:''});}
        })().catch(error=>{if(!unlinked){out.error(error);finish();}else emit({type:'reset',id:'',data:{directoryUnavailable:true}});}).finally(()=>{busy=false;});
      };
      const refreshTimer=unlinked?setInterval(refresh,5000):undefined;
      const listeners=refreshers.get(key)??new Set<()=>void>();listeners.add(refresh);refreshers.set(key,listeners);
      finish=()=>{if(ended)return;ended=true;clearInterval(heartbeat);clearInterval(refreshTimer);listeners.delete(refresh);if(!listeners.size)refreshers.delete(key);signal?.removeEventListener('abort',onAbort);abort.abort();for(const connection of active.values())connection.abort();try{out.close();}catch{}};
      abort.signal.addEventListener('abort',finish,{once:true});if(abort.signal.aborted){finish();return;}
      emit({type:'reset',id:''});refresh();
    },
    cancel(){finish();},
  },new ByteLengthQueuingStrategy({highWaterMark:4*1024*1024}));
  return new Response(body,{headers});
}
