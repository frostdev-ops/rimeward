import { getDashboard } from '../dashboard.ts';
import { DevError } from './runtime.ts';
import { workspaceDispatch,resolveWorkspaceForWard } from './workspaces.ts';
import { readTerminalPlacements,saveTerminalPlacementView,publishTerminalPlacement,forgetTerminalPlacement,type TerminalPlacement } from './terminal-placement.ts';
import type { SessionView } from './types.ts';

export async function terminalNavigation(user:number,ward:string){
  const consumer=getDashboard(user).find(w=>w.i===ward&&w.type==='terminal');
  if(!consumer)throw new DevError('Terminal ward not found.',404);
  return {consumer,directory:await readTerminalPlacements(user,ward)};
}
async function placementOperation(user:number,ward:string,ref:TerminalPlacement,operation:string,args:Record<string,unknown>,owner:string,signal?:AbortSignal){
  const proof=await workspaceDispatch(user,ref.runtimeId,'operation',{rootId:ref.rootId,operation:'terminal-placement-read',args:{session:ref.sessionId,ward},owner},signal);
  if(proof.sessionId!==ref.sessionId||proof.rootId!==ref.rootId||(proof.originWard!==ward&&proof.associated!==true))throw new DevError('This terminal source is not associated with the ward.',403);
  const result=await workspaceDispatch(user,ref.runtimeId,'operation',{rootId:ref.rootId,operation,args:{...args,session:ref.sessionId,id:ref.sessionId,scopeWard:ward},owner},signal);
  return result&&typeof result==='object'?{...result,ownerRuntimeId:ref.runtimeId}:result;
}
function unavailableSession(ref:TerminalPlacement):SessionView&{offline:true;lastKnownState?:string}{
  return {id:ref.sessionId,project:ref.rootId,ownerRuntimeId:ref.runtimeId,virtualCwd:ref.virtualCwd,workspace:ref.workspace,
    title:ref.title??'Unavailable terminal',kind:ref.kind??'shell',state:'interrupted',terminationReason:'owner-offline',mode:'read-only',nextMode:'read-only',agentInput:false,
    exitCode:null,owner:null,cols:100,rows:30,sequence:0,task:'',assignment:'',taskState:'needs-attention',offline:true,lastKnownState:ref.state};
}
/** Existing unlinked sessions retain their source. This path never resolves a viewer's default folder. */
export async function existingTerminalOperation(user:number,ward:string,operation:string,args:Record<string,unknown>,owner:string,signal?:AbortSignal):Promise<{handled:boolean;value?:unknown}>{
  const {consumer,directory}=await terminalNavigation(user,ward);if(consumer.workspace)return {handled:false};
  if(operation==='view'){
    if(args.value!==undefined){
      const ids=new Set<string>();const collect=(value:unknown):void=>{if(typeof value==='string'){ids.add(value);return;}if(Array.isArray(value)){value.forEach(collect);return;}if(value&&typeof value==='object')for(const[key,item]of Object.entries(value))if(['session','tabs','closedSessions','groups','a','b'].includes(key))collect(item);};collect(args.value);
      const unknown=[...ids].filter(id=>!directory.placements.some(p=>p.sessionId===id));
      if(unknown.length){const binding=await resolveWorkspaceForWard(user,ward),root=binding.mounts.find(m=>m.mountPath==='/');if(!root)throw new DevError('Default workspace is unavailable.');await workspaceDispatch(user,root.runtimeId,'operation',{rootId:root.rootId,operation:'view',args:{ward,value:args.value},owner},signal);const sessions=await workspaceDispatch(user,root.runtimeId,'operation',{rootId:root.rootId,operation:'terminal-list',args:{},owner},signal);for(const session of sessions.sessions)if(unknown.includes(session.id))await publishTerminalPlacement(user,ward,{runtimeId:root.runtimeId,rootId:root.rootId,sessionId:session.id,virtualCwd:session.virtualCwd??'/'},args.value);}
      await saveTerminalPlacementView(user,ward,args.value);(await import('./workspace-events.ts')).refreshWorkspaceEvents(user,ward);return {handled:true,value:{ok:true}};
    }
    return directory.view?{handled:true,value:directory.view}:directory.placements.length?{handled:true,value:{session:directory.placements[0]?.sessionId,tabs:directory.placements.map(p=>p.sessionId),project:directory.placements[0]?.rootId}}:{handled:false};
  }
  if(operation==='capabilities'&&args.newSession!==true&&directory.placements.length){const ref=directory.placements.find(p=>p.sessionId===directory.view?.session)??directory.placements[0];if(ref)return {handled:true,value:await workspaceDispatch(user,ref.runtimeId,'operation',{rootId:ref.rootId,operation:'capabilities',args:{},owner},signal)};}
  if(operation==='terminal-list'||operation==='terminal-resources'){
    if(!directory.placements.length)return {handled:false};
    const sessions:unknown[]=[],unavailable:unknown[]=[];
    for(const ref of directory.placements){try{if(operation==='terminal-resources'){const values=await workspaceDispatch(user,ref.runtimeId,'operation',{rootId:ref.rootId,operation,args:{history:args.history===true||args.history==='true'},owner},signal);const session=values.sessions.find((s:{id:string})=>s.id===ref.sessionId);if(!session)throw new DevError('Terminal not found.',404);sessions.push({...session,ownerRuntimeId:ref.runtimeId});}else{const result=await placementOperation(user,ward,ref,'terminal-read',{},owner,signal);sessions.push({...result.session,ownerRuntimeId:ref.runtimeId});}}catch(error){sessions.push({...unavailableSession(ref),...(operation==='terminal-resources'?{pid:null,cpuPercent:null,memoryBytes:null}:{})});unavailable.push({session:ref.sessionId,runtimeId:ref.runtimeId,error:error instanceof Error?error.message:String(error)});}}
    return {handled:true,value:{sessions,unavailable,complete:unavailable.length===0}};
  }
  const session=String(args.session??args.id??''),ref=directory.placements.find(p=>p.sessionId===session);if(!ref)return {handled:false};
  if(args.sessionRuntimeId!==undefined&&args.sessionRuntimeId!==ref.runtimeId)throw new DevError('The terminal runtime does not match its saved source.',409);
  const value=await placementOperation(user,ward,ref,operation,args,owner,signal);
  if(operation==='terminal-delete')await forgetTerminalPlacement(user,ward,session);
  return {handled:true,value};
}
