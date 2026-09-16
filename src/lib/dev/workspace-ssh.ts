import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client, type SFTPWrapper, type ClientChannel } from 'ssh2';
import { DevError, requireWorkspaceRuntime, workDb, isDesktop } from './runtime.ts';
import { sealToken, openToken } from '../crypto.ts';

export interface SshConnection {
  id:string; user:number; name:string; host:string; port:number; username:string;
  auth:'agent'|'key'|'password'; identityFile?:string; hostFingerprint:string;
  platform?:'linux'|'darwin'; remembered?:boolean;
}
const sessions = new Map<string,{ client:Client; sftp:SFTPWrapper }>();
const volatile = new Map<string,{password?:string;passphrase?:string}>();
const pending = new Map<string,Promise<{client:Client;sftp:SFTPWrapper}>>();
let vaultWrites=Promise.resolve();
async function rememberedSecret(user:number,id:string,value?:{password?:string;passphrase?:string}|null):Promise<{password?:string;passphrase?:string}|undefined>{
  if(isDesktop()){
    const vault=(globalThis as typeof globalThis & {__nativeVault?:(op:string,value?:string)=>Promise<string>}).__nativeVault;
    if(!vault)throw new DevError('The desktop credential store is unavailable.',503);
    if(value===undefined){const saved=JSON.parse(await vault('ssh-get'));return saved[id];}
    const update=vaultWrites.then(async()=>{const saved=JSON.parse(await vault('ssh-get'));if(value===null)delete saved[id];else saved[id]=value;await vault('ssh-set',JSON.stringify(saved));});vaultWrites=update.catch(()=>{});await update;return value??undefined;
  }
  const db=connectionDb();db.exec('CREATE TABLE IF NOT EXISTS workspace_credentials (id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,sealed TEXT NOT NULL)');
  if(value===null){db.prepare('DELETE FROM workspace_credentials WHERE id=? AND user_id=?').run(id,user);return;}
  if(value!==undefined){db.prepare('INSERT INTO workspace_credentials VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET sealed=excluded.sealed WHERE user_id=excluded.user_id').run(id,user,sealToken(JSON.stringify(value)));return value;}
  const row=db.prepare('SELECT sealed FROM workspace_credentials WHERE id=? AND user_id=?').get(id,user) as {sealed:string}|undefined;return row?JSON.parse(openToken(row.sealed)):undefined;
}
function connectionDb() { const db = workDb(); db.exec('CREATE TABLE IF NOT EXISTS workspace_connections (id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,json TEXT NOT NULL)'); return db; }
export async function sshConnections(user:number):Promise<SshConnection[]> {
  requireWorkspaceRuntime();
  return (connectionDb().prepare('SELECT json FROM workspace_connections WHERE user_id=?').all(user) as {json:string}[]).map(r => JSON.parse(r.json));
}
export const shellQuote = (v:string) => `'${v.replace(/'/g, `'\\''`)}'`;
export async function configureSsh(user:number,input:Record<string,unknown>) {
  requireWorkspaceRuntime();
  if (typeof input.host !== 'string' || !input.host || /[\s\0/]/.test(input.host) || input.host.length > 253 || typeof input.username !== 'string' || !/^[\w.@-]{1,100}$/.test(input.username)) throw new DevError('Enter an SSH host and username.');
  const port = input.port === undefined ? 22 : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['agent','key','password'].includes(String(input.auth))) throw new DevError('Invalid SSH port or authentication method.');
  if (input.auth === 'key' && (typeof input.identityFile !== 'string' || !path.isAbsolute(input.identityFile))) throw new DevError('Choose an existing absolute private-key path on the connection runtime.');
  const connection:SshConnection = { id:crypto.randomUUID(),user,name:String(input.name || input.host).slice(0,100),host:input.host,port,username:input.username,auth:input.auth as SshConnection['auth'],hostFingerprint:String(input.hostFingerprint ?? ''),...(input.auth === 'key' ? {identityFile:String(input.identityFile)} : {}) };
  if (input.id !== undefined) { const existing = (await sshConnections(user)).find(c => c.id === input.id); if (!existing) throw new DevError('SSH connection not found.',404);if(existing.host!==connection.host||existing.port!==connection.port||existing.username!==connection.username||(connection.hostFingerprint&&existing.hostFingerprint!==connection.hostFingerprint))throw new DevError('Create a new connection to change its host, account or trusted host key.',409);if(connectionDb().prepare("SELECT 1 FROM terminal_sessions t JOIN projects p ON p.id=t.project WHERE p.connection=? AND t.user_id=? AND t.state='running'").get(existing.id,user))throw new DevError('Stop active SSH terminals before refreshing their credentials.',409);connection.id = existing.id;connection.hostFingerprint=existing.hostFingerprint; sessions.get(existing.id)?.client.end(); sessions.delete(existing.id); }
  const secret = { ...(typeof input.password === 'string' ? {password:input.password} : {}), ...(typeof input.passphrase === 'string' ? {passphrase:input.passphrase} : {}) };
  volatile.set(connection.id,secret);
  try { const live=await connect(connection);const platform=await execOnClient(live.client,'uname -s');if(platform.exitCode!==0||!['Linux','Darwin'].includes(platform.stdout.trim())){live.client.end();throw new DevError('Plain SSH workspaces support Linux and macOS. Connect Windows through its Rimeward desktop.',409);}connection.platform=platform.stdout.trim()==='Linux'?'linux':'darwin'; }
  catch(e) {
    volatile.delete(connection.id);
    if (e && typeof e === 'object' && 'hostFingerprint' in e) return {requiresHostVerification:true,hostFingerprint:e.hostFingerprint,host:connection.host};
    throw e;
  }
  if(input.remember===true){await rememberedSecret(user,connection.id,secret);connection.remembered=true;}else if(input.remember===false)await rememberedSecret(user,connection.id,null);
  connectionDb().prepare('INSERT INTO workspace_connections(id,user_id,json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json WHERE user_id=excluded.user_id').run(connection.id,user,JSON.stringify(connection));
  return connection;
}
async function connect(connection:SshConnection) {
  const cached = sessions.get(connection.id); if (cached) return cached;
  const existing = pending.get(connection.id); if (existing) return existing;
  const operation = (async () => {
    const client = new Client(); let observed = '';
    const key = connection.identityFile ? await fs.readFile(connection.identityFile) : undefined;
    const secret = volatile.get(connection.id)??(connection.remembered?await rememberedSecret(connection.user,connection.id):undefined);
    if (connection.auth === 'password' && !secret?.password) throw new DevError('SSH password is needed again on this connection runtime.',401);
    const value = await new Promise<{client:Client;sftp:SFTPWrapper}>((resolve,reject) => {
      client.on('error',error => { sessions.delete(connection.id); reject(observed && observed !== connection.hostFingerprint ? Object.assign(new Error('Verify the SSH host key.'),{hostFingerprint:observed}) : error); });
      client.once('ready',() => client.sftp((error,sftp) => error ? reject(error) : resolve({client,sftp})));
      client.connect({host:connection.host,port:connection.port,username:connection.username,
        ...(connection.auth === 'agent' ? {agent:process.env.SSH_AUTH_SOCK} : {}),
        ...(key ? {privateKey:key,passphrase:secret?.passphrase} : {}), ...(connection.auth === 'password' ? {password:secret?.password} : {}),
        hostVerifier:(key:Buffer) => { observed = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/,'')}`; return observed === connection.hostFingerprint; },
        keepaliveInterval:15000,keepaliveCountMax:3,readyTimeout:15000});
    }).catch(error => { client.end(); throw error; });
    sessions.set(connection.id,value); client.once('close',() => sessions.delete(connection.id));
    return value;
  })();
  pending.set(connection.id,operation);
  try { return await operation; } finally { pending.delete(connection.id); }
}
export async function sshSession(user:number,id:string) {
  const connection = (await sshConnections(user)).find(c => c.id === id);
  if (!connection) throw new DevError('SSH connection not found.',404);
  return {...await connect(connection),connection};
}
export async function sshExec(user:number,id:string,command:string,signal?:AbortSignal):Promise<{stdout:string;stderr:string;exitCode:number|null}> {
  const {client} = await sshSession(user,id);
  return execOnClient(client,command,signal);
}
async function execOnClient(client:Client,command:string,signal?:AbortSignal):Promise<{stdout:string;stderr:string;exitCode:number|null}>{
  return new Promise((resolve,reject) => {
    let channel:ClientChannel | undefined, stdout = '',stderr = '',finished = false;
    const stop = () => { channel?.signal('TERM'); channel?.close(); finish(new DevError('SSH execution interrupted; remote process termination is unconfirmed.',502)); };
    const timer = setTimeout(stop,30000);
    const finish = (error?:Error,code:number|null = null) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort',stop); if (error) reject(error); else resolve({stdout,stderr,exitCode:code}); };
    signal?.addEventListener('abort',stop,{once:true});
    if (signal?.aborted) { stop(); return; }
    client.exec(command,(error,stream) => {
      if (error) { finish(error); return; } channel = stream;
      if (finished) { stream.close(); return; }
      stream.setEncoding('utf8'); stream.stderr.setEncoding('utf8');
      stream.on('data',(data:string) => { stdout += data; if (Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>2*1024*1024) stop(); });
      stream.stderr.on('data',(data:string) => {stderr += data; if (Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>2*1024*1024) stop();});
      stream.once('error',(error:Error) => finish(error)); stream.once('close',(code:number|undefined) => finish(undefined,code ?? null));
    });
  });
}
export const sftpCall = <T>(call:(callback:(error?:Error|null,value?:T)=>void)=>void):Promise<T> => new Promise((resolve,reject) => call((error,value) => error ? reject(error) : resolve(value as T)));
