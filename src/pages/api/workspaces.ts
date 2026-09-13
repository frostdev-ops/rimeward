import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDb } from '../../lib/db.ts';
import { getDashboard,getPages,saveDashboard } from '../../lib/dashboard.ts';
import { validateLayout,validatePages,type WardInstance } from '../../lib/wards.ts';
import { validateGraph } from '../../lib/logic.ts';
import { saveGraph,getGraph,broadcast,pruneUserLogic } from '../../lib/logic-engine.ts';
import { nativeDesktop } from '../../lib/dev/remote.ts';
import { isDesktop,DevError,requireWorkspaceRuntime } from '../../lib/dev/runtime.ts';
import { validateWorkspaceDefinition,workspaceFingerprint,WORKSPACE_CONSUMERS } from '../../lib/dev/workspace-contract.ts';
import { currentRuntimeId,workspaceInventory,workspaceRuntimeCatalog,workspaceContext,workspaceHostAction,workspaceRegisterRoot,workspaceConfigureSsh,resolveWorkspaceForWard,workspaceOperation,preflightWorkspaceDashboard,completeWorkspaceDashboard,reconcileWorkspaceActivity } from '../../lib/dev/workspaces.ts';
import { recordLegacyAgentPlacement,publishAgentBirth } from '../../lib/dev/agent-placement.ts';

export const prerender=false;
const json=(value:unknown,status=200)=>Response.json(value??null,{status,headers:{'cache-control':'no-store','x-rimeward-private':'1'}});
export const ALL:APIRoute=async({request,locals,url})=>{
  try{
    if(!locals.user)throw new DevError('Sign in required.',401);const user=locals.user.userId;
    if(request.method==='GET'){if(url.searchParams.has('catalog'))return json(await workspaceRuntimeCatalog(user));if(url.searchParams.has('workerEvents')){if(isDesktop())throw new DevError('Use the connected server worker.',403);return(await import('../../lib/dev/workspace-worker-client.ts')).workerEvents(user,String(url.searchParams.get('workerEvents')).split(','),request.signal);}if(url.searchParams.has('rootEvents')){requireWorkspaceRuntime();return(await import('../../lib/dev/workspace-events.ts')).rootEvents(user,String(url.searchParams.get('rootEvents')).split(','),request.signal);}const ward=url.searchParams.get('ward');return json(ward?await workspaceContext(user,ward):await workspaceInventory(user));}
    if(request.method!=='POST')throw new DevError('Method not allowed.',405);
    const chunks:Uint8Array[]=[];let size=0;const reader=request.body?.getReader();if(!reader)throw new DevError('Missing request.');
    try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>16*1024*1024)throw new DevError('Workspace request exceeds limit.',413);chunks.push(chunk.value);}}finally{reader.releaseLock();}
    const body=JSON.parse(Buffer.concat(chunks).toString());
    if(body.action==='consumer-status')return json(await workspaceHostAction(user,'consumer-status',{ward:body.ward}));
    if(body.action==='reconcile')return json(await reconcileWorkspaceActivity(user,String(body.ward),body.confirmedStopped));
    if(body.action==='worker-host'){if(isDesktop()||body.runtimeId!==`worker:${user}`)throw new DevError('Worker does not belong to this account.',403);return json(await (await import('../../lib/dev/workspace-worker-client.ts')).workerRequest(user,String(body.hostAction),body,request.signal));}
    if(body.action==='host'){requireWorkspaceRuntime();return json(await workspaceHostAction(user,String(body.hostAction),body,request.signal));}
    if(body.action==='root')return json(await workspaceRegisterRoot(user,String(body.runtimeId),body));
    if(body.action==='ssh')return json(await workspaceConfigureSsh(user,String(body.runtimeId),body));
    if(body.action==='folder'){if(!isDesktop()||body.runtimeId!==await currentRuntimeId(user))throw new DevError('Enter the absolute folder path for a remote runtime.');return json({path:await nativeDesktop('folder')});}
    if(body.action==='dev'){
      const ward=String(body.ward),args={...(body.args??{}),ward},method=String(body.method??'GET'),consumer=getDashboard(user).find(w=>w.i===ward);
      const owner=typeof body.owner==='string'&&/^client:[\w:-]{1,110}$/.test(body.owner)?body.owner:'client:workspace';
      const unlinkedTerminal=consumer?.type==='terminal'&&!consumer.workspace;
      const freshTerminal=unlinkedTerminal&&body.operation==='sessions'&&method==='POST';
      const freshContext=freshTerminal||(unlinkedTerminal&&body.operation==='capabilities'&&args.newSession===true);
      if(body.expectedWorkspaceWard!==undefined&&body.expectedWorkspaceWard!==(consumer?.workspace??null))throw new DevError('Workspace link changed while this view was open. Reload before acting.',409);
      if(unlinkedTerminal&&method!=='GET'&&body.expectedWorkspaceWard!==null)throw new DevError('Reload this terminal before changing it; its workspace link baseline is required.',409);
      if(unlinkedTerminal&&!freshTerminal){const aliases:Record<string,string>={sessions:method==='DELETE'?'terminal-stop':args.id?'terminal-read':'terminal-list','session-resources':'terminal-resources',restart:'terminal-restart',release:'terminal-release',control:'terminal-control',input:'terminal-write',resize:'terminal-resize',interrupt:'terminal-interrupt',configure:'terminal-configure',reconcile:'terminal-reconcile','session-history':'terminal-delete'};const op=aliases[String(body.operation)]??String(body.operation);
        if(op.startsWith('terminal-')||op==='view'||op==='capabilities'){const result=await(await import('../../lib/dev/workspace-terminal-navigation.ts')).existingTerminalOperation(user,ward,op,args,owner,request.signal);if(result.handled){const value=result.value as {sessions?:unknown[];unavailable?:unknown[]}|undefined;return json(op==='terminal-list'?value:value??result.value);}}
      }
      const binding=await resolveWorkspaceForWard(user,ward);
      const expectation=[body.expectedWorkspaceId,body.expectedRevision,body.expectedFingerprint];
      if(!freshContext&&expectation.some(value=>value!==undefined)&&(body.expectedWorkspaceId!==binding.workspaceId||body.expectedRevision!==binding.revision||body.expectedFingerprint!==binding.definitionFingerprint))throw new DevError('Workspace changed while this view was open. Your unsaved text was not written; reload its workspace context.',409);
      const readOnly=method==='GET'&&['view','capabilities','files','buffer','copies','git','search','sessions','session-resources','projects'].includes(String(body.operation))&&args.value===undefined&&args.text===undefined;
      if(!freshTerminal&&!readOnly&&expectation.some(value=>value===undefined))throw new DevError('Reload this view before writing; its workspace revision is required.',409);
      let operation=String(body.operation);
      if(operation==='projects')return json([{id:binding.mounts.find(m=>m.mountPath==='/')!.rootId,name:'Workspace',root:'/'}]);
      if(operation==='files'){
        if(method==='POST'){if(args.directory)return json(await workspaceOperation(user,binding,'mkdir',args,owner,request.signal));return json(await workspaceOperation(user,binding,'write-bytes',{...args,data:'',expectedHash:null},owner,request.signal));}
        const entries=[];let cursor:number|undefined=0;do{const page=await workspaceOperation(user,binding,'tree',{...args,cursor},owner,request.signal);entries.push(...page.entries);cursor=page.next;}while(cursor!==undefined);return json(entries);
      }
      if(operation==='search'){
        const matches:unknown[]=[],unavailable:unknown[]=[];let next:number|undefined=Number(args.cursor??0),complete=false;
        for(let pages=0;pages<16&&next!==undefined&&matches.length<200;pages++){
          const page=await workspaceOperation(user,binding,'search',{...args,cursor:next},owner,request.signal);
          matches.push(...page.matches);if(page.unavailable)unavailable.push(...page.unavailable);next=page.next;complete=page.complete;
        }
        return json({matches,complete:complete&&next===undefined&&!unavailable.length,...(next===undefined?{}:{next}),unavailable,hint:unavailable.length?'Some folders could not be searched. Reconnect them and retry.':next===undefined?'':'More files remain. Continue the search to include them.'});
      }
      if(operation==='rename')return json(await workspaceOperation(user,binding,'transfer',{source:args.path,destination:args.to,mode:'move'},owner,request.signal));
      if(operation==='buffer')operation=method==='GET'?'buffer':'edit';
      if(operation==='lint'||operation==='format'){args.format=operation==='format';operation='analyze';}
      if(operation==='worktree')args.operation=args.op;
      if(operation==='sessions')operation=method==='GET'?(args.id?'terminal-read':'terminal-list'):method==='DELETE'?'terminal-stop':'terminal-start';
      const terminal:Record<string,string>={restart:'terminal-restart',release:'terminal-release',control:'terminal-control',input:'terminal-write',resize:'terminal-resize',interrupt:'terminal-interrupt',configure:'terminal-configure',reconcile:'terminal-reconcile','session-history':'terminal-delete','session-resources':'terminal-resources'};
      operation=terminal[operation]??operation;
      const result=await workspaceOperation(user,binding,operation,args,owner,request.signal);
      if(operation==='terminal-list')return json(result);
      return json(result);
    }
    const current=getDashboard(user),currentPages=getPages(user);
    if(body.dashboard&&!body.dashboard.base)throw new DevError('A dashboard draft requires its original baseline.',409);
    if(body.dashboard?.base&&(!isDeepStrictEqual(body.dashboard.base.layout,current)||!isDeepStrictEqual(body.dashboard.base.pages,currentPages)))throw new DevError('Dashboard changed elsewhere; your draft has not been saved.',409);
    let pages=body.dashboard?.pages===undefined?currentPages:validatePages(body.dashboard.pages);if(!pages)throw new DevError('Invalid pages.');
    let layout=body.dashboard?.layout===undefined?structuredClone(current):validateLayout(body.dashboard.layout,pages);if(!layout)throw new DevError('Invalid layout.');
    let savedWard:WardInstance|undefined;
    if(body.action==='create'){
      const definition=validateWorkspaceDefinition(body.definition);if(current.some(w=>w.type==='workspace'&&w.config?.workspaceId===definition.workspaceId))throw new DevError('Workspace already exists.',409);
      savedWard={i:`ws${crypto.randomUUID().replace(/-/g,'').slice(0,24)}`,type:'workspace',size:'3x3',title:String(body.title||'Workspace').slice(0,60),page:typeof body.page==='string'?body.page:pages[0]!.id,config:definition as unknown as Record<string,unknown>};layout.push(savedWard);
    }else if(body.action==='configure'){
      const ward=layout.find(w=>w.i===body.ward&&w.type==='workspace'),existing=current.find(w=>w.i===body.ward&&w.type==='workspace');if(!ward||!existing)throw new DevError('Workspace not found.',404);
      const old=validateWorkspaceDefinition(existing.config);if(old.revision!==body.expectedRevision||workspaceFingerprint(old)!==body.expectedFingerprint)throw new DevError('Workspace changed elsewhere. Reload before configuring it.',409);
      const definition=validateWorkspaceDefinition(body.definition);if(definition.workspaceId!==old.workspaceId)throw new DevError('Preserve workspace identity.',409);definition.revision=old.revision+1;ward.config=definition as unknown as Record<string,unknown>;if(typeof body.title==='string')ward.title=body.title.slice(0,60);savedWard=ward;
    }else if(body.action==='links'){
      const links=body.links??[{ward:body.ward,workspace:body.workspace,expectedWorkspace:body.expectedWorkspace}];if(!Array.isArray(links)||links.length>200)throw new DevError('Invalid workspace links.');
      for(const link of links){const ward=layout.find(w=>w.i===link.ward),old=current.find(w=>w.i===link.ward);if(!ward||!(WORKSPACE_CONSUMERS as readonly string[]).includes(ward.type))throw new DevError('This ward does not consume a workspace.');if(link.expectedWorkspace===undefined||(old?.workspace??null)!==link.expectedWorkspace)throw new DevError('Workspace link changed elsewhere or its baseline is missing.',409);if(link.workspace===null)delete ward.workspace;else if(typeof link.workspace==='string'&&layout.some(w=>w.i===link.workspace&&w.type==='workspace'))ward.workspace=link.workspace;else throw new DevError('Choose an existing workspace.');}
    }else throw new DevError('Unknown workspace action.');
    const valid=validateLayout(layout,pages);if(!valid)throw new DevError('Invalid workspace layout.');layout=valid;
    const newAgents=layout.filter(w=>w.type==='agent'&&!current.some(old=>old.i===w.i)),birthRuntime=await currentRuntimeId(user);
    for(const ward of layout)if(!current.some(old=>old.i===ward.i)&&(WORKSPACE_CONSUMERS as readonly string[]).includes(ward.type))ward.workspaceVersion=1;
    for(const ward of newAgents){if(birthRuntime==='server')delete ward.device;else ward.device=birthRuntime;}
    const graph=body.graph===undefined?undefined:validateGraph(body.graph,layout,{isAdmin:locals.user.role==='admin'});if(graph===null)throw new DevError('Invalid Leylines.');
    if(graph&&(!body.expectedGraph||!isDeepStrictEqual(body.expectedGraph,getGraph(user))))throw new DevError('Leylines changed elsewhere; reload the graph.',409);
    await preflightWorkspaceDashboard(user,layout);
    if(!isDeepStrictEqual(getDashboard(user),current)||!isDeepStrictEqual(getPages(user),currentPages))throw new DevError('Dashboard changed during workspace preflight.',409);
    if(graph&&!isDeepStrictEqual(body.expectedGraph,getGraph(user)))throw new DevError('Leylines changed during workspace preflight.',409);
    getDb().transaction(()=>{saveDashboard(user,layout!,pages!);for(const ward of newAgents)recordLegacyAgentPlacement(user,ward.i,birthRuntime);if(graph)saveGraph(user,graph);})();await completeWorkspaceDashboard(user);
    for(const ward of newAgents)await publishAgentBirth(user,ward.i,birthRuntime);
    pruneUserLogic(user);broadcast(user,'layout',{layout,pages});
    return json({ok:true,layout,pages,...(savedWard?{ward:savedWard.i,config:savedWard.config}:{})});
  }catch(error){return json({error:error instanceof Error?error.message:String(error)},error instanceof DevError?error.status:400);}
};
