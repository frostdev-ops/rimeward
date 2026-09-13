// The terminal ward's WebSocket: one socket per viewer per desktop runtime at
// /api/dev/ws?_ward=<ward>&owner=<owner>. Output DOWN only for the sessions the
// viewer subscribed to, every other runtime event as-is, and the viewer's input,
// resizes and interrupts UP — each applied through the same functions the POST
// routes call, so the lease rules are identical. Every input message is
// acknowledged by number: a socket that drops with unacked input leaves the
// session "unconfirmed" on the client, never retried. Everything that is not
// a hot path (sessions, snapshots, control, configure) stays HTTP. A page the
// desktop relay serves cannot upgrade (HTTP relay) and keeps SSE + POST.
import type http from 'node:http';
import type net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { getSession } from '../auth.ts';
import { refuseUpgrade, upgradeSession } from '../live-stream.ts';
import { DevError, isDesktop, subscribeDev } from './runtime.ts';
import { interruptSession, resizeSession, writeSession } from './terminals.ts';
import { getDashboard } from '../dashboard.ts';
import { resolveWorkspaceForWard,workspaceOperation } from './workspaces.ts';
import { workspaceEvents,refreshWorkspaceEvents } from './workspace-events.ts';
import { existingTerminalOperation } from './workspace-terminal-navigation.ts';
import type { WorkspaceBinding } from './workspace-contract.ts';

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
const OWNER = /^client:[\w:-]{1,113}$/;
const BACKLOG = 4 * 1024 * 1024;

type Up =
  | { t: 'sub' | 'unsub' | 'int'; id: string }
  | { t: 'in'; id: string; data: string; binary?: boolean; n: number }
  | { t: 'rs'; id: string; cols: number; rows: number };

export function devUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  socket.on('error', () => {});
  const auth = upgradeSession(req);
  if (typeof auth === 'number') { refuseUpgrade(socket, auth); return; }
  const query=new URL(req.url??'','http://localhost').searchParams,ward=query.get('_ward'),workspaceOwner=query.get('owner')??'';
  if(ward&&getDashboard(auth.userId).some(w=>w.i===ward&&['terminal','editor','project-files','changes'].includes(w.type))){
    if(!OWNER.test(workspaceOwner)){refuseUpgrade(socket,400);return;}
    const consumer=getDashboard(auth.userId).find(w=>w.i===ward),binding=consumer?.type==='terminal'&&!consumer.workspace?Promise.resolve(undefined):resolveWorkspaceForWard(auth.userId,ward);
    void binding.then(value=>wss.handleUpgrade(req,socket,head,ws=>attachWorkspace(ws,auth.userId,auth.id,workspaceOwner,ward,value))).catch(()=>refuseUpgrade(socket,503));return;
  }
  if (!isDesktop()) { refuseUpgrade(socket, 409); return; }
  const owner = new URL(req.url ?? '', 'http://localhost').searchParams.get('owner') ?? '';
  if (!OWNER.test(owner)) { refuseUpgrade(socket, 400); return; }
  wss.handleUpgrade(req, socket, head, ws => attach(ws, auth.userId, auth.id, owner));
}
function attachWorkspace(ws:WebSocket,user:number,session:string,owner:string,ward:string,binding?:WorkspaceBinding){
  const abort=new AbortController(),subs=new Set<string>();let queue=Promise.resolve();
  const send=(value:object)=>{if(ws.readyState!==WebSocket.OPEN)return;if(ws.bufferedAmount>BACKLOG){ws.close(1013,'Slow receiver');return;}ws.send(JSON.stringify(value));};
  const close=()=>abort.abort();ws.on('close',close);ws.on('error',close);send({t:'hello'});
  void workspaceEvents(user,ward,abort.signal).then(async response=>{if(!response.body)throw new Error('Workspace stream unavailable.');const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();let pending='';try{for(;;){const chunk=await reader.read();if(chunk.done)break;pending+=chunk.value;while(pending.includes('\n\n')){const end=pending.indexOf('\n\n'),frame=pending.slice(0,end);pending=pending.slice(end+2);const data=frame.split('\n').find(line=>line.startsWith('data: '));if(!data)continue;const ev=JSON.parse(data.slice(6));if(ev.type==='output'&&!subs.has(ev.id))continue;send({t:'ev',ev});}}}finally{reader.releaseLock();}}).catch(()=>ws.close(1011,'Workspace event connection lost'));
  const timer=setInterval(()=>{if(!getSession(session)){ws.close(4401,'Signed out');return;}ws.ping();},25000);ws.once('close',()=>clearInterval(timer));
  ws.on('message',(raw,isBinary)=>{let message:Up;try{message=JSON.parse(raw.toString());if(isBinary||typeof message.id!=='string')throw Error();}catch{ws.close(1008,'Bad message');return;}if(message.t==='sub'){subs.add(message.id);refreshWorkspaceEvents(user,ward);return;}if(message.t==='unsub'){subs.delete(message.id);return;}
    queue=queue.then(async()=>{if(!getSession(session))throw new DevError('Signed out.',401);const args=message.t==='in'?{session:message.id,data:message.data,binary:message.binary}:message.t==='rs'?{session:message.id,cols:message.cols,rows:message.rows}:{session:message.id};const operation=message.t==='in'?'terminal-write':message.t==='rs'?'terminal-resize':'terminal-interrupt';if(binding)await workspaceOperation(user,binding,operation,args,owner,abort.signal);else{const result=await existingTerminalOperation(user,ward,operation,args,owner,abort.signal);if(!result.handled)throw new DevError('Terminal source is unavailable. Reopen its saved view.',409);}if(message.t==='in')send({t:'ack',id:message.id,n:message.n});}).catch(error=>send({t:'err',id:message.id,n:message.t==='in'?message.n:undefined,message:error instanceof Error?error.message:'Workspace input failed.'}));
  });
}

function attach(ws: WebSocket, user: number, session: string, owner: string): void {
  const subs = new Set<string>();
  let alive = true;
  const text = (value: object) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > BACKLOG) { ws.close(1013, 'Slow receiver'); return; }
    ws.send(JSON.stringify(value));
  };
  const heartbeat = setInterval(() => {
    if (!alive || !getSession(session)) { ws.terminate(); return; }
    alive = false; ws.ping();
  }, 25_000);
  // `hello` first: subscribing emits `reset` synchronously, and the client reads
  // "closed before hello" as "this page cannot upgrade".
  text({ t: 'hello' });
  const unsub = subscribeDev(user, ev => {
    if (ev.type === 'output' && !subs.has(ev.id)) return;
    text({ t: 'ev', ev });
  });
  const stop = () => { clearInterval(heartbeat); unsub(); };
  ws.on('pong', () => { alive = true; });
  ws.on('error', stop);
  ws.on('close', stop);
  ws.on('message', (raw, isBinary) => {
    let m: Up;
    try { m = JSON.parse(raw.toString()); if (isBinary || typeof m?.id !== 'string') throw 0; } catch { ws.close(1008, 'Bad message'); return; }
    if (!getSession(session)) { ws.close(4401, 'Signed out'); return; }
    try {
      if (m.t === 'sub') subs.add(m.id);
      else if (m.t === 'unsub') subs.delete(m.id);
      else if (m.t === 'in') { writeSession(user, m.id, owner, String(m.data ?? ''), m.binary === true); text({ t: 'ack', id: m.id, n: m.n }); }
      else if (m.t === 'rs') resizeSession(user, m.id, owner, Number(m.cols), Number(m.rows));
      else if (m.t === 'int') interruptSession(user, m.id, owner);
      else ws.close(1008, 'Bad message');
    } catch (err) {
      text({ t: 'err', id: m.id, n: m.t === 'in' ? m.n : undefined, message: err instanceof DevError ? err.message : 'The terminal did not take the input.' });
    }
  });
}

export function ensureDevLive(): void {
  (globalThis as typeof globalThis & { __fdDevUpgrade?: typeof devUpgrade }).__fdDevUpgrade = devUpgrade;
}
