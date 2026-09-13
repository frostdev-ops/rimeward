import crypto from 'node:crypto';
import os from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { getDashboard, getPages, saveDashboard } from '../dashboard.ts';
import { getSetting, setSetting } from '../settings.ts';
import { getDb } from '../db.ts';
import type { WardInstance, PageDef } from '../wards.ts';
import { isDesktop, isWorkspaceWorker, DevError, workDb } from './runtime.ts';
import { rimeConnection, instanceRequest } from './remote.ts';
import { listDevices, relayRequest } from './devices.ts';
import { defaultRoot, rootOperation, roots, registerRoot } from './workspace-roots.ts';
import { configureSsh, sshConnections } from './workspace-ssh.ts';
import { runWorkspacePatch, runWorkspaceTransfer, workspacePatchStatus } from './workspace-patch.ts';
import { searchWorkspace } from './workspace-read.ts';
import { validateWorkspaceDefinition, workspaceFingerprint, resolveWorkspacePath, workspacePath, type WorkspaceDefinition, type WorkspaceBinding } from './workspace-contract.ts';
function bindingPrimary(definition:WorkspaceDefinition){const primary=definition.mounts.find(m=>m.mountPath==='/');if(!primary)throw new DevError('Workspace has no primary folder.');return primary;}
const changingConsumers=new Set<string>(),activeConsumerOperations=new Map<string,number>(),heldConsumers=new Map<number,string[]>();
const consumerKey=(user:number,ward:string)=>`${user}:${ward}`;
function releaseConsumers(user:number){for(const key of heldConsumers.get(user)??[])changingConsumers.delete(key);heldConsumers.delete(user);}

export async function currentRuntimeId(user:number):Promise<string> {
  if(isWorkspaceWorker())return `worker:${process.env.RIMEWARD_WORKER_ACCOUNT}`;
  if(!isDesktop())return 'server';
  const pair=await rimeConnection(user);if(pair)return pair.id;
  let id=getSetting('workspace:runtime-id');if(!id){id=crypto.randomUUID();setSetting('workspace:runtime-id',id);}return id;
}
const sourceRuntime = async(user:number) => isDesktop()||isWorkspaceWorker()?currentRuntimeId(user):`worker:${user}`;
async function dispatch(user:number,runtimeId:string,action:string,args:Record<string,unknown>,signal?:AbortSignal) {
  if(runtimeId===await currentRuntimeId(user)||(isDesktop()&&runtimeId===getSetting('workspace:runtime-id'))){
    if(action==='consumer-status'){const {wardBusy}=await import('../agent/core.ts');const ward=String(args.ward),consumer=getDashboard(user).find(w=>w.i===ward);const busy=wardBusy(user,ward)||!!getDb().prepare('SELECT 1 FROM agent_conversations WHERE user_id=? AND ward=? AND pending_confirm_id IS NOT NULL').get(user,ward)||!!getDb().prepare("SELECT 1 FROM agent_jobs WHERE user_id=? AND ward=? AND state IN ('running','stopping')").get(user,ward);return {busy,workspaceWard:consumer?.workspace??null,...(consumer&&['agent','terminal','editor','project-files','changes'].includes(consumer.type)?{binding:await resolveWorkspaceForWard(user,ward)}:{})};}
    if(action==='roots')return {roots:roots(user),connections:await sshConnections(user)};
    if(action==='legacy'){const views=Object.fromEntries((workDb().prepare('SELECT ward,json FROM ward_state WHERE user_id=?').all(user) as {ward:string;json:string}[]).map(r=>[r.ward,JSON.parse(r.json)]));return {projects:roots(user),views,sessions:(await import('./terminals.ts')).listSessions(user)};}
    if(action==='default')return defaultRoot(user);
    if(action==='register')return registerRoot(user,args);
    if(action==='ssh')return configureSsh(user,args);
    if(action==='operation')return rootOperation(user,String(args.rootId),String(args.operation),args.args as Record<string,unknown>,String(args.owner),signal);
    throw new DevError('Unknown workspace host operation.');
  }
  if(runtimeId===`worker:${user}`&&!isDesktop())return (await import('./workspace-worker-client.ts')).workerRequest(user,action,args,signal);
  if(/^worker:[1-9]\d*$/.test(runtimeId)&&isDesktop()){
    const request=new Request('https://rimeward.invalid/api/workspaces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'worker-host',runtimeId,hostAction:action,...args}),signal});
    const response=await instanceRequest(user,'/api/workspaces',request),value=await response.json();if(!response.ok)throw new DevError(value.error??'Server worker unavailable.',response.status);return value;
  }
  if(runtimeId==='server'&&action==='consumer-status'&&isDesktop()){const response=await instanceRequest(user,'/api/workspaces',new Request('https://rimeward.invalid/api/workspaces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'consumer-status',ward:args.ward}),signal}));const value=await response.json();if(!response.ok)throw new DevError(value.error??'Agent coordinator is unavailable.',response.status);return value;}
  if(!/^[a-f0-9-]{36}$/i.test(runtimeId))throw new DevError('Workspace runtime is unavailable.',503);
  const request=new Request('https://rimeward.invalid/api/workspaces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'host',hostAction:action,...args}),signal});
  const response=isDesktop()?await instanceRequest(user,`/runtime/${runtimeId}/api/workspaces`,request):await relayRequest(user,runtimeId,'/api/workspaces',request);
  const value=await response.json();if(!response.ok)throw new DevError(value.error||'Workspace host unavailable.',response.status);return value;
}
export { dispatch as workspaceDispatch };
export interface WorkspaceRunLease {runtimeId:string;rootId:string;id:string}
export async function beginWorkspaceRun(user:number,binding:WorkspaceBinding):Promise<WorkspaceRunLease>{await assertWorkspaceBinding(user,binding);const primary=bindingPrimary(binding);const {id}=await dispatch(user,primary.runtimeId,'operation',{rootId:primary.rootId,operation:'activity-start',args:{workspaceId:binding.workspaceId,fingerprint:binding.definitionFingerprint,consumerWardId:binding.consumerWardId,runOwnerRuntimeId:binding.runOwnerRuntimeId},owner:`agent:${binding.consumerWardId}`});return {runtimeId:primary.runtimeId,rootId:primary.rootId,id};}
export async function endWorkspaceRun(user:number,lease:WorkspaceRunLease){await dispatch(user,lease.runtimeId,'operation',{rootId:lease.rootId,operation:'activity-end',args:{id:lease.id},owner:'agent:workspace'});}
export async function workspaceHostAction(user:number,action:string,args:Record<string,unknown>,signal?:AbortSignal) {return dispatch(user,await currentRuntimeId(user),action,args,signal);}
export async function resolveWorkspaceForWard(user:number,wardId:string,runOwnerRuntimeId?:string):Promise<WorkspaceBinding> {
  await ensureWorkspaceMigration(user);
  const layout=getDashboard(user),ward=layout.find(w=>w.i===wardId);if(!ward)throw new DevError('Ward not found.',404);
  const pending=JSON.parse(getSetting(`workspace:migration-pending:${user}`)??'[]') as {ward:string;reason:string}[];
  const blocked=pending.find(entry=>entry.ward===wardId);if(!ward.workspace&&ward.type!=='workspace'&&blocked)throw new DevError(`Workspace upgrade needs attention: ${blocked.reason} Your original location has not been changed.`,409);
  let definition:WorkspaceDefinition;
  if(ward.type==='workspace'||ward.workspace){const target=ward.type==='workspace'?ward:layout.find(w=>w.i===ward.workspace&&w.type==='workspace');if(!target)throw new DevError('Workspace link is unresolved. Reconnect or explicitly disconnect it.',409);definition=validateWorkspaceDefinition(target.config);}
  else{const runtimeId=await sourceRuntime(user),root=await dispatch(user,runtimeId,'default',{});definition={workspaceId:`default:${runtimeId}:${wardId}`,revision:1,mounts:[{id:root.id,mountPath:'/',runtimeId,rootId:root.id}]};}
  const binding:WorkspaceBinding={...definition,definitionFingerprint:workspaceFingerprint(definition),consumerWardId:wardId,runOwnerRuntimeId:runOwnerRuntimeId??await currentRuntimeId(user),cwd:'/'};
  await assertWorkspaceBinding(user,binding);
  binding.mounts.forEach(Object.freeze);Object.freeze(binding.mounts);return Object.freeze(binding);
}
export async function assertWorkspaceBinding(user:number,binding:WorkspaceBinding):Promise<void> {
  await recoverWorkspaceDashboard(user);
  const definition=validateWorkspaceDefinition(binding);if(workspaceFingerprint(definition)!==binding.definitionFingerprint)throw new DevError('Workspace definition changed.',409);
  const layout=getDashboard(user),ward=layout.find(w=>w.i===binding.consumerWardId);if(!ward)throw new DevError('Workspace consumer no longer exists.',409);
  if(ward.type==='workspace'||ward.workspace){const target=ward.type==='workspace'?ward:layout.find(w=>w.i===ward.workspace&&w.type==='workspace');if(!target||workspaceFingerprint(validateWorkspaceDefinition(target.config))!==binding.definitionFingerprint||(target.config as unknown as WorkspaceDefinition).revision!==binding.revision)throw new DevError('Workspace changed; begin a fresh run after resolving changes.',409);}
  else{const runtimeId=await sourceRuntime(user),root=await dispatch(user,runtimeId,'default',{});const expected:WorkspaceDefinition={workspaceId:`default:${runtimeId}:${binding.consumerWardId}`,revision:1,mounts:[{id:root.id,mountPath:'/',runtimeId,rootId:root.id}]};if(binding.revision!==1||workspaceFingerprint(expected)!==binding.definitionFingerprint)throw new DevError('The default workspace binding does not match this runtime.',409);}
  const primary=bindingPrimary(binding);
  await dispatch(user,primary.runtimeId,'operation',{rootId:primary.rootId,operation:'stat',args:{path:''},owner:`agent:${binding.consumerWardId}`});
}
export async function workspaceOperation(user:number,binding:WorkspaceBinding,operation:string,args:Record<string,unknown>,owner:string,signal?:AbortSignal):Promise<Awaited<ReturnType<typeof dispatch>>> {
  const key=consumerKey(user,binding.consumerWardId),mutation=!['stat','bytes','tree','read','buffer','search','git','capabilities','terminal-list','terminal-resources','terminal-read','terminal-wait','patch-status'].includes(operation)&&!(operation==='view'&&args.value===undefined)&&!(operation==='copies'&&args.text===undefined);
  if(mutation&&changingConsumers.has(key))throw new DevError('This ward is changing workspaces. Wait for the configuration receipt.',409);
  if(mutation)activeConsumerOperations.set(key,(activeConsumerOperations.get(key)??0)+1);
  try{return await performWorkspaceOperation(user,binding,operation,args,owner,signal);}finally{if(mutation){const remaining=(activeConsumerOperations.get(key)??1)-1;if(remaining)activeConsumerOperations.set(key,remaining);else activeConsumerOperations.delete(key);}}
}
async function performWorkspaceOperation(user:number,binding:WorkspaceBinding,operation:string,args:Record<string,unknown>,owner:string,signal?:AbortSignal):Promise<Awaited<ReturnType<typeof dispatch>>> {
  const readOnly=new Set(['stat','bytes','tree','read','buffer','search','git','view','capabilities','copies','terminal-list','terminal-resources','terminal-read','terminal-wait','patch-status']);
  if(readOnly.has(operation)&&!(operation==='view'&&args.value!==undefined)&&!(operation==='copies'&&args.text!==undefined))return operateWorkspace(user,binding,operation,args,owner,signal);
  if(owner.startsWith('agent:')&&(await import('../agent/ward-config.ts')).agentWardConfig(user,binding.consumerWardId)?.tools==='read-only')throw new DevError('This ward is read-only; workspace files and processes were not changed.',403);
  const lease=await beginWorkspaceRun(user,binding);let retained=false,result:Awaited<ReturnType<typeof dispatch>>;
  try{result=await operateWorkspace(user,binding,operation,args,owner,signal);if(operation==='terminal-start'||operation==='terminal-exec'){
      const ref=resolveWorkspacePath(binding,String(args.cwd??binding.cwd),binding.cwd),session=String(result.session_id??result.session?.id??result.id??'');
      // Keep admission closed if an acknowledged start loses its lease-publication receipt.
      retained=true;const response=await dispatch(user,ref.runtimeId,'operation',{rootId:ref.rootId,operation:'terminal-lease',args:{session,lease},owner});retained=response.retained;
      if(getDashboard(user).some(w=>w.i===binding.consumerWardId&&w.type==='terminal')){await(await import('./terminal-placement.ts')).publishTerminalPlacement(user,binding.consumerWardId,{runtimeId:ref.runtimeId,rootId:ref.rootId,sessionId:session,virtualCwd:ref.virtualPath,workspace:binding});(await import('./workspace-events.ts')).refreshWorkspaceEvents(user,binding.consumerWardId);}
    }if(operation==='terminal-exec')result=await completeWorkspaceCommand(user,binding,args,owner,result,signal);return result;
  }finally{if(!retained)try{await endWorkspaceRun(user,lease);}catch{if(result&&typeof result==='object'){result.activity_release_unconfirmed=true;result.activity_note='The operation receipt is preserved. Workspace activity release was not confirmed; reconcile before reconfiguration.';}}}
}
async function completeWorkspaceCommand(user:number,binding:WorkspaceBinding,args:Record<string,unknown>,owner:string,started:Awaited<ReturnType<typeof dispatch>>,signal?:AbortSignal){
  const target=resolveWorkspacePath(binding,String(args.cwd??binding.cwd),binding.cwd),session=String(started.session_id??started.session?.id??started.id),{fitOutput}=await import('../agent/shell.ts');let after=0,output='',truncated=false;
  const stop=()=>dispatch(user,target.runtimeId,'operation',{rootId:target.rootId,operation:'terminal-stop',args:{session,cancelled:true},owner});
  try{for(;;){signal?.throwIfAborted();const read=await dispatch(user,target.runtimeId,'operation',{rootId:target.rootId,operation:'terminal-wait',args:{session,after,milliseconds:1000,raw:true},owner},signal);const text=stripVTControlCharacters(read.data??'');output=read.reset?text:output+text;if(output.length>64000){output=output.slice(-64000);truncated=true;}after=read.session.sequence;if(read.session.state!=='running'){const fitted=fitOutput(output,'');return {session,ownerRuntimeId:target.runtimeId,exit_code:read.session.exitCode,exit_signal:read.session.exitSignal??null,cancelled:read.session.terminationReason==='cancelled',termination_reason:read.session.terminationReason??null,...fitted,truncated:truncated||fitted.truncated};}}}
  catch(error){if(signal?.aborted)await stop().catch(()=>{});return {session,ownerRuntimeId:target.runtimeId,exit_code:null,cancelled:signal?.aborted??false,uncertain:true,termination_reason:signal?.aborted?'cancellation-unconfirmed':'connection-lost',...fitOutput(output,''),error:error instanceof Error?error.message:String(error)};}
}
async function operateWorkspace(user:number,binding:WorkspaceBinding,operation:string,args:Record<string,unknown>,owner:string,signal?:AbortSignal):Promise<Awaited<ReturnType<typeof dispatch>>> {
  await assertWorkspaceBinding(user,binding);signal?.throwIfAborted();
  if(operation==='patch')return runWorkspacePatch(user,binding,args,owner,signal);
  if(operation==='patch-status')return workspacePatchStatus(user,binding,args.operation_id === undefined ? '' : String(args.operation_id),owner,signal,{ ...(typeof args.path === 'string' ? { path: args.path } : {}), ...(args.cursor === undefined ? {} : { cursor: Number(args.cursor) }) });
  if(operation==='transfer')return runWorkspaceTransfer(user,binding,args,owner,signal);
  if(operation==='search')return searchWorkspace(binding,args,(runtimeId,rootId,operation,args)=>dispatch(user,runtimeId,'operation',{rootId,operation,args,owner},signal));
  if(operation==='terminal-list'||operation==='terminal-resources'){
    const sessions=[],unavailable:unknown[]=[];for(const m of binding.mounts){try{if(binding.unavailableMountIds?.includes(m.id))throw new DevError('This mount is unavailable for this run.');const value=await dispatch(user,m.runtimeId,'operation',{rootId:m.rootId,operation,args,owner},signal);sessions.push(...value.sessions.map((s:unknown)=>({...s as object,ownerRuntimeId:m.runtimeId})));}catch(error){if(m.mountPath==='/')throw error;unavailable.push({mount:m.mountPath,error:error instanceof Error?error.message:String(error)});}}return {sessions,unavailable,complete:unavailable.length===0};
  }
  let target=resolveWorkspacePath(binding,String(args.path??args.cwd??binding.cwd),binding.cwd);
  const selectedMount=binding.mounts.find(m=>m.id===target.mountId);if(selectedMount&&selectedMount.mountPath!=='/'){
    const primary=bindingPrimary(binding);let collision=false;try{await dispatch(user,primary.runtimeId,'operation',{rootId:primary.rootId,operation:'stat',args:{path:selectedMount.mountPath.slice(1)},owner},signal);collision=true;}catch(error){const e=error as {status?:number;code?:number|string};if(![404,2,'ENOENT'].includes(e.status??e.code??''))throw error;}if(collision)throw new DevError(`Mount ${selectedMount.mountPath} hides a primary folder entry. Rename the mount.`,409);
  }
  if(operation.startsWith('terminal-')&&!['terminal-start','terminal-exec'].includes(operation)){
    const candidates=await workspaceOperation(user,binding,'terminal-list',{},owner,signal);const session=candidates.sessions.find((s:{id:string})=>s.id===String(args.session??args.id));if(!session)throw new DevError('Session not found in the workspace.',404);const mount=binding.mounts.find(m=>m.rootId===session.project&&m.runtimeId===session.ownerRuntimeId);if(!mount)throw new DevError('Session owner is outside the workspace.',403);target={...target,mountId:mount.id,rootId:mount.rootId,runtimeId:mount.runtimeId};
  }
  if(operation==='terminal-task'&&Array.isArray(args.files))args={...args,files:args.files.map(file=>{const ref=resolveWorkspacePath(binding,String(file),binding.cwd);if(ref.rootId!==target.rootId||ref.runtimeId!==target.runtimeId)throw new DevError('Review files must belong to this terminal folder. Record other mounted folders separately.');return ref.relativePath;})};
  const result=await dispatch(user,target.runtimeId,'operation',{rootId:target.rootId,operation,args:{...args,path:target.relativePath,...(operation==='tree'?{virtualPrefix:selectedMount?.mountPath&&selectedMount.mountPath!=='/'?`${selectedMount.mountPath}/`:'/'}:{}),...(operation==='terminal-start'||operation==='terminal-exec'?{workspace:binding,ownerRuntimeId:target.runtimeId,virtualCwd:target.virtualPath}:{})},owner},signal);
  if(operation==='tree'){
    const prefix=selectedMount?.mountPath??'/';
    result.entries=result.entries.map((entry:{path:string})=>({...entry,path:workspacePath(`${prefix==='/'?'':prefix}/${entry.path}`)}));
    if(target.virtualPath==='/'){const mounts=binding.mounts.filter(m=>m.mountPath!=='/');if(typeof result.total==='number')result.total+=mounts.length;if(!Number(args.cursor))for(const m of mounts){const name=m.mountPath.slice(1);if(result.entries.some((e:{name:string})=>e.name===name))throw new DevError(`Mount ${m.mountPath} hides a primary folder entry. Rename the mount.`,409);result.entries.push({name,path:m.mountPath,directory:true,mount:true,bytes:0});}}
  }
  const prefix=binding.mounts.find(m=>m.id===target.mountId)?.mountPath??'/';
  const virtual=(p:string)=>workspacePath(`${prefix==='/'?'':prefix}/${p}`);
  if(Array.isArray(result))return result.map(value=>value&&typeof value==='object'&&typeof value.path==='string'?{...value,path:virtual(value.path)}:value);
  if(result&&typeof result==='object'){
    if(typeof result.path==='string')result.path=virtual(result.path);
    if(Array.isArray(result.matches))result.matches=result.matches.map((m:{path:string})=>({...m,path:virtual(m.path)}));
  }
  return result&&typeof result==='object'?{...result,ownerRuntimeId:target.runtimeId,...(operation.startsWith('terminal-')?{workspace:binding,virtualCwd:target.virtualPath}:{})}:result;
}
export async function workspaceInventory(user:number){
  await ensureWorkspaceMigration(user);
  const own=await sourceRuntime(user),runtimes=[];const local=await dispatch(user,own,'roots',{}).catch((error:Error)=>({roots:[],error:error.message}));runtimes.push({id:own,name:isDesktop()?os.hostname():'Server workspace',kind:isDesktop()?'desktop':'worker',online:!local.error,...local});
  if(isDesktop()){const connection=await rimeConnection(user);if(connection){try{const response=await instanceRequest(user,'/api/workspaces?catalog=1',new Request('https://rimeward.invalid/api/workspaces?catalog=1'));if(!response.ok)throw new DevError('Connected server workspace unavailable.',response.status);const runtime=await response.json();if(typeof runtime.id!=='string'||!/^worker:[1-9]\d*$/.test(runtime.id))throw new DevError('Connected server returned an invalid workspace runtime.');runtimes.push({...runtime,name:connection.name||'Connected server'});}catch(error){runtimes.push({id:'',name:connection.name||'Connected server',kind:'worker',online:false,roots:[],error:error instanceof Error?error.message:String(error)});}}}
  const devices=isDesktop()?await import('./tool-routing.ts').then(m=>m.agentDevices(user)).then(r=>r.devices).catch(()=>[]):listDevices(user);
  for(const d of devices){if(d.id==='local'||d.id===own)continue;const details=d.online?await dispatch(user,d.id,'roots',{}).catch((error:Error)=>({roots:[],error:error.message})):{roots:[]};runtimes.push({...d,kind:'desktop',...details,online:d.online&&!details.error});}
  return {runtimes,workspaces:getDashboard(user).filter(w=>w.type==='workspace').map(w=>({ward:w.i,title:w.title??'Workspace',config:w.config,fingerprint:workspaceFingerprint(validateWorkspaceDefinition(w.config))}))};
}
export async function workspaceRuntimeCatalog(user:number){const id=await sourceRuntime(user),details=await dispatch(user,id,'roots',{}).catch((error:Error)=>({roots:[],connections:[],error:error.message}));return {id,name:isDesktop()?os.hostname():'Server workspace',kind:isDesktop()?'desktop':'worker',online:!details.error,...details};}
export async function workspaceContext(user:number,ward:string){
  const consumer=getDashboard(user).find(w=>w.i===ward);
  if(!consumer)throw new DevError('Workspace consumer not found.',404);
  const own=await currentRuntimeId(user),newSessionRuntimeId=await sourceRuntime(user),newSessionRuntimeName=isDesktop()?os.hostname():'Server workspace';
  const devices=isDesktop()?await import('./tool-routing.ts').then(m=>m.agentDevices(user)).then(r=>r.devices).catch(()=>[]):listDevices(user);
  const runtimeName=(id:string)=>id===own&&isDesktop()?os.hostname():id.startsWith('worker:')?'Server workspace':devices.find(d=>d.id===id)?.name??id;
  if(consumer.type==='terminal'&&!consumer.workspace){
    const roster=await (await import('./terminal-placement.ts')).readTerminalPlacements(user,ward);
    const selected=roster.placements.find(ref=>ref.sessionId===roster.view?.session)??roster.placements[0];
    if(selected){
      const definition:WorkspaceDefinition=selected.workspace??{workspaceId:`default:${selected.runtimeId}:${ward}`,revision:1,mounts:[{id:selected.rootId,mountPath:'/',runtimeId:selected.runtimeId,rootId:selected.rootId}]};
      const binding:WorkspaceBinding=selected.workspace??{...definition,definitionFingerprint:workspaceFingerprint(definition),consumerWardId:ward,runOwnerRuntimeId:selected.runtimeId,cwd:selected.virtualCwd};
      let info:{name?:string;path?:string;runtimeName?:string;hostName?:string}={},error:string|undefined;
      try{info=await dispatch(user,selected.runtimeId,'operation',{rootId:selected.rootId,operation:'info',args:{},owner:'client:workspace'});}catch(e){error=e instanceof Error?e.message:String(e);}
      return {binding,project:{id:selected.rootId,name:info.name??selected.title??'Existing terminal',root:'/'},viewOnly:true,newSessionRuntimeId,newSessionRuntimeName,
        status:error?'offline':'ready',error,ownerRuntimeId:selected.runtimeId,ownerName:info.runtimeName??runtimeName(selected.runtimeId),
        mounts:[{id:selected.rootId,mountPath:'/',runtimeId:selected.runtimeId,rootId:selected.rootId,name:info.name??'Existing terminal folder',path:info.path,runtimeName:info.runtimeName??runtimeName(selected.runtimeId),hostName:info.hostName,status:error?'offline':'ready',error}]};
    }
  }
  const binding=await resolveWorkspaceForWard(user,ward),primary=bindingPrimary(binding);
  const w=getDashboard(user).find(w=>w.type==='workspace'&&(w.config as unknown as WorkspaceDefinition).workspaceId===binding.workspaceId);
  const mounts=await Promise.all(binding.mounts.map(async m=>{try{const info=await dispatch(user,m.runtimeId,'operation',{rootId:m.rootId,operation:'info',args:{},owner:'client:workspace'});return {...m,name:info.name,path:info.path,runtimeName:info.runtimeName,hostName:info.hostName,status:'ready'};}catch(error){return {...m,name:'Unavailable folder',runtimeName:runtimeName(m.runtimeId),status:'offline',error:error instanceof Error?error.message:String(error)};}}));
  return {binding,workspace:w?{ward:w.i,title:w.title??'Workspace',config:w.config,fingerprint:binding.definitionFingerprint}:undefined,project:{id:primary.rootId,name:w?.title??mounts.find(m=>m.mountPath==='/')?.name??'Workspace',root:'/'},status:mounts.some(m=>m.status!=='ready')?'partial':'ready',ownerRuntimeId:binding.runOwnerRuntimeId,ownerName:runtimeName(binding.runOwnerRuntimeId),newSessionRuntimeId:consumer.workspace?primary.runtimeId:newSessionRuntimeId,newSessionRuntimeName:consumer.workspace?runtimeName(primary.runtimeId):newSessionRuntimeName,mounts};
}
export async function workspaceRegisterRoot(user:number,runtimeId:string,args:Record<string,unknown>){return {...await dispatch(user,runtimeId,'register',args),runtimeId};}
export async function workspaceConfigureSsh(user:number,runtimeId:string,args:Record<string,unknown>){return dispatch(user,runtimeId,'ssh',args);}

type Gate={runtimeId:string;rootId:string;workspaceId:string;token:string;before:string;after:string};
const proofs=new Map<number,{before:string;after:string;expires:number;gates:Gate[]}>();
const completions=new Map<number,Promise<void>>();
const recoveries=new Map<number,Promise<void>>();
const proofKey=(user:number)=>`workspace:gate-proof:${user}`;
const protectedLayout=(layout:WardInstance[])=>JSON.stringify(layout.filter(w=>w.type==='workspace'||w.workspace).map(w=>({i:w.i,workspace:w.workspace,definition:w.type==='workspace'?validateWorkspaceDefinition(w.config):undefined})).sort((a,b)=>a.i<b.i?-1:1));
export function assertWorkspaceDashboardWrite(user:number,before:WardInstance[],after:WardInstance[]){const old=protectedLayout(before),next=protectedLayout(after);if(old===next)return;const proof=proofs.get(user);if(!proof||proof.before!==old||proof.after!==next||proof.expires<Date.now())throw new DevError('Workspace changes require active-run and dirty-buffer preflight.',409);proofs.delete(user);
  // Finish after the synchronous SQLite write. A failed acknowledgement leaves the authority closed.
  const completion=Promise.resolve().then(async()=>{if(protectedLayout(getDashboard(user))!==next)throw new DevError('Workspace save failed; configuration gate needs reconciliation.',409);for(const gate of proof.gates)await dispatch(user,gate.runtimeId,'operation',{rootId:gate.rootId,operation:'gate-finish',args:{workspaceId:gate.workspaceId,token:gate.token,fingerprint:gate.after},owner:'client:workspace'});releaseConsumers(user);});completion.catch(()=>{});completions.set(user,completion);
}
export async function completeWorkspaceDashboard(user:number){const completion=completions.get(user);if(completion)try{await completion;getDb().prepare('DELETE FROM settings WHERE key=?').run(proofKey(user));}finally{if(completions.get(user)===completion)completions.delete(user);}}
export async function recoverWorkspaceDashboard(user:number):Promise<void>{
  const pending=proofs.get(user);if(pending&&pending.expires>Date.now())return;
  const existing=recoveries.get(user);if(existing)return existing;
  const raw=getSetting(proofKey(user));if(!raw)return;
  const recovery=(async()=>{await completions.get(user)?.catch(()=>{});const proof=JSON.parse(raw) as {before:string;after:string;gates:Gate[]};const current=protectedLayout(getDashboard(user));if(current!==proof.before&&current!==proof.after)throw new DevError('Workspace configuration changed while a previous save was unconfirmed. Resolve the saved configuration conflict first.',409);
    for(const gate of proof.gates)await dispatch(user,gate.runtimeId,'operation',{rootId:gate.rootId,operation:'gate-finish',args:{workspaceId:gate.workspaceId,token:gate.token,fingerprint:current===proof.after?gate.after:gate.before},owner:'client:workspace'});
    getDb().prepare('DELETE FROM settings WHERE key=? AND value=?').run(proofKey(user),raw);proofs.delete(user);releaseConsumers(user);
  })();recoveries.set(user,recovery);try{await recovery;}finally{recoveries.delete(user);}
}
export async function preflightWorkspaceDashboard(user:number,next:WardInstance[],options:{sync?:boolean}={}){
  await recoverWorkspaceDashboard(user);
  const before=getDashboard(user),changed=new Set(before.filter(w=>w.type==='workspace'&&JSON.stringify(w.config)!==JSON.stringify(next.find(n=>n.i===w.i)?.config)).map(w=>w.i));
  if(protectedLayout(before)===protectedLayout(next))return;
  if(heldConsumers.has(user))throw new DevError('Finish the pending workspace configuration change first.',409);
  const keys=before.filter(w=>w.workspace!==next.find(n=>n.i===w.i)?.workspace||changed.has(w.workspace??'')).map(w=>consumerKey(user,w.i));
  for(const key of keys)if(changingConsumers.has(key)||(activeConsumerOperations.get(key)??0)>0)throw new DevError('Finish the ward’s pending operation before changing its workspace.',409);
  for(const key of keys)changingConsumers.add(key);heldConsumers.set(user,keys);
  try{await prepareWorkspaceDashboard(user,next,options);if(!proofs.has(user))releaseConsumers(user);}catch(error){releaseConsumers(user);throw error;}
}
async function prepareWorkspaceDashboard(user:number,next:WardInstance[],options:{sync?:boolean}={}){
  await recoverWorkspaceDashboard(user);
  const before=getDashboard(user),old=protectedLayout(before);if(old===protectedLayout(next))return;
  const definitionIds=next.filter(w=>w.type==='workspace').map(w=>validateWorkspaceDefinition(w.config).workspaceId);if(new Set(definitionIds).size!==definitionIds.length)throw new DevError('Each Workspace ward needs a distinct workspace identity.');
  const changed=new Set(before.filter(w=>w.type==='workspace'&&JSON.stringify(w.config)!==JSON.stringify(next.find(n=>n.i===w.i)?.config)).map(w=>w.i));
  const adopted=new Set<string>();
  if(options.sync)for(const ward of next.filter(w=>w.type==='workspace'&&(!before.some(old=>old.i===w.i)||changed.has(w.i)))){
    const previous=before.find(w=>w.i===ward.i);
    const oldDefinition=previous?validateWorkspaceDefinition(previous.config):undefined,definition=validateWorkspaceDefinition(ward.config);if(oldDefinition&&definition.revision<=oldDefinition.revision)continue;
    const fingerprint=workspaceFingerprint(definition),authorities=[...(oldDefinition?[bindingPrimary(oldDefinition)]:[]),bindingPrimary(definition)];
    const states=await Promise.all(authorities.map(m=>dispatch(user,m.runtimeId,'operation',{rootId:m.rootId,operation:'gate-status',args:{workspaceId:definition.workspaceId},owner:'client:workspace'})));
    if(states.every(state=>state?.state==='idle'&&state.fingerprint===fingerprint))adopted.add(ward.i);
  }
  for(const w of before.filter(w=>w.type==='workspace'&&!next.some(n=>n.i===w.i)))if(before.some(n=>n.workspace===w.i))throw new DevError('Disconnect linked wards in a separate saved change before deleting their workspace.',409);
  const targets=new Map<string,Omit<Gate,'token'>>();
  for(const ward of before.filter(w=>w.type==='workspace'||w.workspace||(['agent','terminal','editor','project-files','changes'].includes(w.type)&&w.workspace!==next.find(n=>n.i===w.i)?.workspace))){
    if(adopted.has(ward.type==='workspace'?ward.i:ward.workspace??''))continue;
    if(JSON.stringify(ward)===JSON.stringify(next.find(w=>w.i===ward.i))&&!changed.has(ward.workspace??''))continue;
    if(ward.type==='terminal'&&!ward.workspace){
      const directory=await(await import('./terminal-placement.ts')).readTerminalPlacements(user,ward.i);
      if(directory.placements.length){const seenOwners=new Set<string>();for(const ref of directory.placements){await dispatch(user,ref.runtimeId,'operation',{rootId:ref.rootId,operation:'guard',args:{},owner:'client:workspace'});const owner=ref.workspace?.runOwnerRuntimeId??(ref.runtimeId.startsWith('worker:')?'server':ref.runtimeId);if(seenOwners.has(owner))continue;seenOwners.add(owner);const status=await dispatch(user,owner,'consumer-status',{ward:ward.i});if(status.busy)throw new DevError('Stop the original terminal owner’s pending work before relinking.',409);const original:WorkspaceBinding|undefined=status.binding;if(!original)throw new DevError('The original terminal context could not be confirmed.',409);const primary=bindingPrimary(original);targets.set(`${primary.runtimeId}:${original.workspaceId}`,{runtimeId:primary.runtimeId,rootId:primary.rootId,workspaceId:original.workspaceId,before:original.definitionFingerprint,after:`retired:${original.definitionFingerprint}`});}continue;}
    }
    const owner=ward.type==='agent'?(await(await import('./agent-placement.ts')).agentPlacement(user,ward.i)).runtime_id:ward.device??await currentRuntimeId(user);const status=await dispatch(user,owner,'consumer-status',{ward:ward.i});
    const proposedConsumer=next.find(w=>w.i===ward.i),proposedWorkspace=next.find(w=>w.i===proposedConsumer?.workspace&&w.type==='workspace');
    if(options.sync&&proposedConsumer&&status.binding&&status.workspaceWard===(proposedConsumer.workspace??null)&&(!proposedWorkspace||(workspaceFingerprint(validateWorkspaceDefinition(proposedWorkspace.config))===status.binding.definitionFingerprint&&validateWorkspaceDefinition(proposedWorkspace.config).revision===status.binding.revision)))continue;
    if(status.busy)throw new DevError('Stop the active agent and resolve pending approvals before changing its workspace.',409);
    const binding:WorkspaceBinding=status.binding??await resolveWorkspaceForWard(user,ward.i);
    if(ward.workspace){const expected=before.find(w=>w.i===ward.workspace&&w.type==='workspace');if(!expected||workspaceFingerprint(validateWorkspaceDefinition(expected.config))!==binding.definitionFingerprint)throw new DevError('The consuming runtime has another workspace definition; synchronize before changing the link.',409);}
    for(const m of binding.mounts)await dispatch(user,m.runtimeId,'operation',{rootId:m.rootId,operation:'guard',args:{workspaceId:binding.workspaceId},owner:`client:workspace`});
    const primary=bindingPrimary(binding),replacement=next.find(w=>w.type==='workspace'&&w.config?.workspaceId===binding.workspaceId);targets.set(`${primary.runtimeId}:${binding.workspaceId}`,{runtimeId:primary.runtimeId,rootId:primary.rootId,workspaceId:binding.workspaceId,before:binding.definitionFingerprint,after:replacement?workspaceFingerprint(validateWorkspaceDefinition(replacement.config)):`retired:${binding.definitionFingerprint}`});
  }
  for(const w of next.filter(w=>w.type==='workspace'&&!adopted.has(w.i)&&(!before.some(o=>o.i===w.i)||changed.has(w.i)))){const def=validateWorkspaceDefinition(w.config),primary=bindingPrimary(def);if(def.workspaceId.startsWith('default:'))throw new DevError('The default workspace identity is reserved.');const previous=before.find(o=>o.i===w.i);if(previous&&(options.sync?def.revision<=validateWorkspaceDefinition(previous.config).revision:def.revision!==validateWorkspaceDefinition(previous.config).revision+1))throw new DevError('Configure workspaces through their revision-checked configuration action.',409);let cursor:number|undefined=0;do{const list=await dispatch(user,primary.runtimeId,'operation',{rootId:primary.rootId,operation:'tree',args:{path:'',cursor},owner:'client:workspace'});for(const m of def.mounts)if(m.mountPath!=='/'&&list.entries.some((e:{name:string})=>e.name.toLowerCase()===m.mountPath.slice(1).toLowerCase()))throw new DevError(`Mount ${m.mountPath} hides a primary folder entry.`,409);cursor=list.next;}while(cursor!==undefined);const fingerprint=workspaceFingerprint(def);targets.set(`${primary.runtimeId}:${def.workspaceId}`,{runtimeId:primary.runtimeId,rootId:primary.rootId,workspaceId:def.workspaceId,before:previous?workspaceFingerprint(validateWorkspaceDefinition(previous.config)):fingerprint,after:fingerprint});}
  const gates:Gate[]=[];try{for(const target of targets.values()){const result=await dispatch(user,target.runtimeId,'operation',{rootId:target.rootId,operation:'gate-prepare',args:{workspaceId:target.workspaceId,fingerprint:target.before},owner:'client:workspace'});gates.push({...target,token:result.token});}if(protectedLayout(getDashboard(user))!==old)throw new DevError('Dashboard changed during workspace preflight.',409);const proof={before:old,after:protectedLayout(next),expires:Date.now()+5000,gates};setSetting(proofKey(user),JSON.stringify(proof));proofs.set(user,proof);}catch(error){for(const gate of gates)await dispatch(user,gate.runtimeId,'operation',{rootId:gate.rootId,operation:'gate-finish',args:{workspaceId:gate.workspaceId,token:gate.token,fingerprint:gate.before},owner:'client:workspace'}).catch(()=>{});throw error;}
}
export async function saveWorkspaceDashboard(user:number,layout:WardInstance[],pages?:PageDef[]){await preflightWorkspaceDashboard(user,layout);saveDashboard(user,layout,pages);await completeWorkspaceDashboard(user);}
/** Only the explicit human recovery action clears orphaned admission records after verification. */
export async function reconcileWorkspaceActivity(user:number,ward:string,confirmedStopped:unknown){
  if(confirmedStopped!==true)throw new DevError('Verify that the interrupted operations have stopped before reconciling them.',409);
  const binding=await resolveWorkspaceForWard(user,ward),primary=bindingPrimary(binding);
  for(const mount of binding.mounts)await dispatch(user,mount.runtimeId,'operation',{rootId:mount.rootId,operation:'guard',args:{workspaceId:binding.workspaceId},owner:'client:workspace'});
  const activities=await dispatch(user,primary.runtimeId,'operation',{rootId:primary.rootId,operation:'activity-list',args:{workspaceId:binding.workspaceId},owner:'client:workspace'}) as {id:string;owner:string;consumer:string}[];
  for(const activity of activities){const status=await dispatch(user,activity.owner,'consumer-status',{ward:activity.consumer});if(status.busy)throw new DevError('An originating run is still active. Stop it before reconciliation.',409);}
  for(const activity of activities)await dispatch(user,primary.runtimeId,'operation',{rootId:primary.rootId,operation:'activity-end',args:{id:activity.id},owner:'client:workspace'});
  return {ok:true,reconciled:activities.length};
}
export async function cancelWorkspaceDashboard(user:number){const proof=proofs.get(user);if(!proof){releaseConsumers(user);return;}proofs.delete(user);for(const gate of proof.gates)await dispatch(user,gate.runtimeId,'operation',{rootId:gate.rootId,operation:'gate-finish',args:{workspaceId:gate.workspaceId,token:gate.token,fingerprint:gate.before},owner:'client:workspace'});releaseConsumers(user);getDb().prepare('DELETE FROM settings WHERE key=?').run(proofKey(user));}
const migrations=new Map<number,Promise<void>>(),migrationVersions=new Map<number,string>();
export async function ensureWorkspaceMigration(user:number):Promise<void>{
  const layout=getDashboard(user),version=JSON.stringify(layout);if(migrationVersions.get(user)===version)return;
  const existing=migrations.get(user);if(existing)return existing;
  const operation=(async()=>{
    const {migrateProjectWorkspaces}=await import('./workspace-migration.ts'),runtimeId=await sourceRuntime(user),pages=getPages(user);
    const requested=new Set([runtimeId,...layout.map(w=>w.device).filter((v):v is string=>!!v),...pages.map(p=>p.device).filter((v):v is string=>!!v)]);
    const owners=await Promise.all([...requested].map(async id=>{try{return {runtimeId:id,online:true,...await dispatch(user,id,'legacy',{})};}catch{return {runtimeId:id,online:false};}}));
    const result=migrateProjectWorkspaces(layout,pages,owners,runtimeId);
    const {recordLegacyAgentPlacement}=await import('./agent-placement.ts');for(const placement of result.owners){setSetting(`workspace:legacy-owner:${user}:${placement.ward}`,placement.runtimeId);recordLegacyAgentPlacement(user,placement.ward,placement.runtimeId);if(placement.runtimeId===runtimeId&&(isDesktop()||isWorkspaceWorker())){const view=owners.find(o=>o.runtimeId===runtimeId)?.views?.[placement.ward];if(view?.session)workDb().prepare("UPDATE terminal_sessions SET owner_runtime=? WHERE user_id=? AND id=? AND owner_runtime=''").run(runtimeId,user,view.session);}}
    setSetting(`workspace:migration-pending:${user}`,JSON.stringify(result.pending));
    if(result.changed){if(JSON.stringify(getDashboard(user))!==version)throw new DevError('Dashboard changed during workspace migration.',409);proofs.set(user,{before:protectedLayout(layout),after:protectedLayout(result.layout),expires:Date.now()+5000,gates:[]});saveDashboard(user,result.layout,result.pages);await completeWorkspaceDashboard(user);}
    const terminalDirectory=await import('./terminal-placement.ts');
    for(const placement of result.owners){if(!getDashboard(user).some(w=>w.i===placement.ward&&w.type==='terminal'))continue;const owner=owners.find(o=>o.runtimeId===placement.runtimeId),view=owner?.views?.[placement.ward];if(!view)continue;
      const ids=new Set<string>();const collect=(value:unknown):void=>{if(typeof value==='string'){ids.add(value);return;}if(Array.isArray(value)){value.forEach(collect);return;}if(value&&typeof value==='object')for(const[key,item]of Object.entries(value))if(['session','tabs','closedSessions','groups','a','b'].includes(key))collect(item);};collect(view);
      for(const session of owner?.sessions??[])if(ids.has(session.id))try{await terminalDirectory.publishTerminalPlacement(user,placement.ward,{runtimeId:placement.runtimeId,rootId:session.project,sessionId:session.id,virtualCwd:session.virtualCwd??'/'},view);}catch{ /* Keep source state intact; its next live view retries directory publication. */ }
    }
    if(result.changed)(await import('../logic-engine.ts')).broadcast(user,'layout',{layout:result.layout,pages:result.pages});
    if(!result.pending.length)migrationVersions.set(user,JSON.stringify(getDashboard(user)));
  })();migrations.set(user,operation);try{await operation;}finally{migrations.delete(user);}
}
