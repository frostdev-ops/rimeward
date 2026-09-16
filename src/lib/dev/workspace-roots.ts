import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import crypto from 'node:crypto';
import type { Stats as Attributes, Client } from 'ssh2';
import { DevError, workDb, claimLease, leaseOwner, releaseLease, emitDev, reserveDirectoryMutation, assertNoDirectoryMutation, isWorkspaceWorker, requireWorkspaceRuntime } from './runtime.ts';
import { addProject, projectPath, bufferKey, treePage, readPage, readBuffer, searchPage, editBuffer, gitView, worktreeOp, bufferCopies, decode, encode, hash, MAX_FILE, type BufferRow } from './projects.ts';
import { analyzeFile } from './lint.ts';
import { applyProjectBytes, applyProjectPatch } from './apply-patch.ts';
import { parsePatch, patchText } from './patch.ts';
import { sshSession, sshConnections, sshExec, shellQuote, sftpCall } from './workspace-ssh.ts';
import * as terminals from './terminals.ts';
import type { TerminalTransport } from './terminals.ts';
import { workspacePath } from './workspace-contract.ts';
import { pageBuffer, pageGitView, createProject, renameFile } from './projects.ts';

export interface WorkspaceRoot {id:string;name:string;root:string;connection:string}
function db() { const d = workDb(); if (!(d.pragma('table_info(projects)') as {name:string}[]).some(c=>c.name==='native_root')) d.exec("ALTER TABLE projects ADD COLUMN native_root TEXT NOT NULL DEFAULT ''"); return d; }
export function rootOf(user:number,id:string):WorkspaceRoot {
  const row = db().prepare("SELECT id,name,CASE WHEN native_root='' THEN root ELSE native_root END AS root,connection FROM projects WHERE id=? AND user_id=? AND archived=0").get(id,user) as WorkspaceRoot|undefined;
  if (!row) throw new DevError('Workspace folder not found.',404); return row;
}
export function roots(user:number):WorkspaceRoot[] { return (db().prepare('SELECT id FROM projects WHERE user_id=? AND archived=0').all(user) as {id:string}[]).map(r=>rootOf(user,r.id)); }
export async function defaultRoot(user:number) {
  const documents = process.env.RIMEWARD_DOCUMENTS_DIR ?? path.join(os.homedir(),'Documents');
  const root = path.join(documents,'Rimeward','workspace'); await fs.mkdir(root,{recursive:true}); return registerRoot(user,{root});
}
export async function browseWorkspaceFolders(user:number,args:Record<string,unknown>) {
  requireWorkspaceRuntime();
  const requested=String(args.path??''),cursor=Number(args.cursor??0);
  if(requested.includes('\0')||requested.length>4096||!Number.isSafeInteger(cursor)||cursor<0)throw new DevError('Invalid folder selection.');
  let directory:string,names:string[];
  const paths=args.connection?path.posix:path;
  if(requested&&!paths.isAbsolute(requested))throw new DevError('Choose an absolute folder path.');
  if(args.connection){
    const {sftp}=await sshSession(user,String(args.connection));
    directory=await sftpCall<string>(cb=>sftp.realpath(requested||'.',cb));
    const entries=await sftpCall<import('ssh2').FileEntryWithStats[]>(cb=>sftp.readdir(directory,cb));
    names=entries.filter(entry=>entry.attrs.isDirectory()&&!entry.attrs.isSymbolicLink()).map(entry=>entry.filename);
  }else{
    directory=await fs.realpath(requested||os.homedir());
    names=(await fs.readdir(directory,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name);
  }
  names=names.filter(name=>name!=='.'&&name!=='..').sort((a,b)=>a.localeCompare(b));
  return {path:directory,parent:paths.dirname(directory),folders:names.slice(cursor,cursor+100).map(name=>({name,path:paths.join(directory,name)})),...(cursor+100<names.length?{next:cursor+100}:{})};
}
export async function registerRoot(user:number,args:Record<string,unknown>):Promise<WorkspaceRoot> {
  if (typeof args.root !== 'string' || !args.root || args.root.includes('\0')) throw new DevError('Choose an absolute workspace folder.');
  if (!args.connection) {
    if (!path.isAbsolute(args.root)) throw new DevError('Choose an absolute workspace folder.');
    if (args.create === true) {const created=createProject(user,path.dirname(args.root),path.basename(args.root));return rootOf(user,created.id);}
    const root = addProject(user,args.root,typeof args.name==='string'?args.name:undefined); return rootOf(user,root.id);
  }
  const connection = String(args.connection), {sftp} = await sshSession(user,connection);
  if (!args.root.startsWith('/')) throw new DevError('Choose an absolute SSH folder.');
  if (args.create === true) await sftpCall<void>(cb=>sftp.mkdir(args.root as string,{mode:0o700},cb));
  const real = await sftpCall<string>(cb=>sftp.realpath(args.root as string,cb));
  const stat = await sftpCall<Attributes>(cb=>sftp.stat(real,cb));
  if (!stat.isDirectory()) throw new DevError('Choose a directory.');
  const key = `ssh:${connection}:${real}`,id = crypto.randomUUID();
  db().prepare('INSERT OR IGNORE INTO projects(id,user_id,name,root,connection,native_root) VALUES(?,?,?,?,?,?)').run(id,user,String(args.name||path.posix.basename(real)).slice(0,100),key,connection,real);
  const saved = db().prepare('SELECT id FROM projects WHERE user_id=? AND root=?').get(user,key) as {id:string}; return rootOf(user,saved.id);
}
function relativePath(file:string) { const relative = workspacePath(file).slice(1); if (relative.split('/').some(s=>s.toLowerCase()==='.git')) throw new DevError('Git metadata is not an editable workspace file.',403); return relative; }
async function sshPath(user:number,root:WorkspaceRoot,file:string,create=false) {
  const relative = relativePath(file), {sftp} = await sshSession(user,root.connection);
  if(await sftpCall<string>(cb=>sftp.realpath(root.root,cb))!==root.root)throw new DevError('The registered SSH root changed or now traverses a symlink.',409);
  let current = root.root;
  const segments = relative ? relative.split('/') : [];
  for (const part of ['',...segments]) {
    current = path.posix.join(current,part);
    try { const stat = await sftpCall<Attributes>(cb=>sftp.lstat(current,cb)); if (stat.isSymbolicLink()) throw new DevError('Workspace file operations do not follow SSH symlinks.',403); }
    catch(error) { if (create && (error as {code?:number}).code === 2) continue; throw error; }
  }
  return {sftp,target:current,relative};
}
async function rootLocation(user:number,root:WorkspaceRoot,file:string){
  let target:string,endpoint='';
  if(root.connection){const result=await sshPath(user,root,file,true);target=result.target;const {connection}=await sshSession(user,root.connection);endpoint=`${connection.host.toLowerCase()}:${connection.port}:${connection.username}:${connection.hostFingerprint}:`;}
  else{target=projectPath(user,root.id,relativePath(file),true);if(target!==path.resolve(root.root,relativePath(file)))throw new DevError('Directory transfers do not follow symlinks.',403);}
  const normalize=(value:string)=>root.connection||process.platform!=='linux'?value.normalize('NFC').toLowerCase():value;
  const key=(value:string)=>`mutation:${hash(Buffer.from(endpoint+normalize(value)))}`;
  const ancestors:string[]=[];let parent=(root.connection?path.posix:path).dirname(target);
  for(;;){ancestors.push(key(parent));const next=(root.connection?path.posix:path).dirname(parent);if(next===parent)break;parent=next;}
  return {key:key(target),ancestors,scope:root.connection?'ssh':'local'};
}
async function transferTree(user:number,root:WorkspaceRoot,file:string,cursor:number){
  let entries:{name:string;path:string;directory:boolean;symlink:boolean;unsupported:boolean;bytes:number;mode:number}[];
  if(root.connection){const {sftp,target,relative}=await sshPath(user,root,file);const rows=await sftpCall<import('ssh2').FileEntryWithStats[]>(cb=>sftp.readdir(target,cb));entries=rows.filter(e=>e.filename!=='.'&&e.filename!=='..').map(e=>({name:e.filename,path:path.posix.join(relative,e.filename),directory:e.attrs.isDirectory(),symlink:e.attrs.isSymbolicLink(),unsupported:e.filename.toLowerCase()==='.git'||/[\\/\0]/.test(e.filename)||(!e.attrs.isDirectory()&&!e.attrs.isFile()),bytes:e.attrs.size,mode:e.attrs.mode}));}
  else{const target=projectPath(user,root.id,relativePath(file));entries=await Promise.all((await fs.readdir(target)).map(async name=>{const stat=await fs.lstat(path.join(target,name));return {name,path:path.posix.join(relativePath(file),name),directory:stat.isDirectory(),symlink:stat.isSymbolicLink(),unsupported:name.toLowerCase()==='.git'||/[\\/\0]/.test(name)||(!stat.isDirectory()&&!stat.isFile()),bytes:stat.size,mode:stat.mode};}));}
  entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);const offset=Math.max(0,Math.floor(cursor)||0);return {entries:entries.slice(offset,offset+100),complete:offset+100>=entries.length,...(offset+100<entries.length?{next:offset+100}:{})};
}
async function renameDirectory(user:number,root:WorkspaceRoot,from:string,to:string,owner:string){
  const source=relativePath(from),destination=relativePath(to);if(!source||!destination||destination===source||destination.startsWith(`${source}/`))throw new DevError('Choose distinct directory paths; mounted roots cannot be moved.');
  if(!(await rootStat(user,root,source)).isDirectory)throw new DevError('Source is not a directory.');
  try{await rootStat(user,root,destination);throw new DevError('Destination already exists.',409);}catch(error){const e=error as {status?:number;code?:number|string};if(![404,2,'ENOENT'].includes(e.status??e.code??''))throw error;}
  const sourceTarget=root.connection?path.posix.join(root.root,source):projectPath(user,root.id,source);
  const contains=(base:string,value:string)=>value===base||value.startsWith(base+(root.connection?'/':path.sep));
  const registered=roots(user).filter(r=>r.connection===root.connection);if(registered.some(r=>r.id!==root.id&&contains(sourceTarget,r.root)))throw new DevError('A registered workspace folder is inside this directory. Reconnect its location explicitly before moving it.',409);
  const affected=(db().prepare('SELECT b.user_id,b.project,b.path,b.dirty,p.root,p.native_root,p.connection FROM buffers b JOIN projects p ON p.id=b.project').all() as {user_id:number;project:string;path:string;dirty:number;root:string;native_root:string;connection:string}[]).filter(row=>row.connection===root.connection&&contains(sourceTarget,(root.connection?path.posix:path).join(row.native_root||row.root,row.path)));
  if(affected.some(row=>row.dirty||(leaseOwner(bufferKey(row.user_id,row.project,row.path))&&leaseOwner(bufferKey(row.user_id,row.project,row.path))!==owner)))throw new DevError('Save dirty buffers and release other editors before renaming the directory.',409);
  const fromLocation=await rootLocation(user,root,source),toLocation=await rootLocation(user,root,destination);
  if(fromLocation.key===toLocation.key||toLocation.ancestors.includes(fromLocation.key))throw new DevError('A directory cannot be renamed into itself through a path alias.',409);
  const token=`directory:${crypto.randomUUID()}`,release=reserveDirectoryMutation(token);
  try{
    if(root.connection){const {sftp,target}=await sshPath(user,root,source),dest=await sshPath(user,root,destination,true);const before=await sftpCall<Attributes>(cb=>sftp.lstat(target,cb));if(!before.isDirectory())throw new DevError('Directory changed before rename.',409);await sftpCall<void>(cb=>sftp.rename(target,dest.target,cb));}
    else renameFile(user,root.id,source,destination,token);
    for(const row of affected){db().prepare('DELETE FROM buffers WHERE user_id=? AND project=? AND path=?').run(row.user_id,row.project,row.path);emitDev(row.user_id,'project',row.project);}
    emitDev(user,'project',root.id);return {ok:true,path:source,to:destination,renamed:true};
  }finally{release();}
}
export async function rootReadBytes(user:number,root:WorkspaceRoot,file:string):Promise<Buffer> {
  if (!root.connection) { const target=projectPath(user,root.id,relativePath(file));const s=await fs.stat(target);if(!s.isFile()||s.size>MAX_FILE)throw new DevError('Read only regular files up to 5 MiB.');return fs.readFile(target); }
  const {sftp,target}=await sshPath(user,root,file); const stat=await sftpCall<Attributes>(cb=>sftp.stat(target,cb));
  if(!stat.isFile()||stat.size>MAX_FILE)throw new DevError('Read only regular files up to 5 MiB.');
  const bytes=await sftpCall<Buffer>(cb=>sftp.readFile(target,cb));if(bytes.length>MAX_FILE)throw new DevError('File exceeds 5 MiB.');return bytes;
}
export async function rootStat(user:number,root:WorkspaceRoot,file:string) {
  if (!root.connection) {const stat=await fs.lstat(projectPath(user,root.id,relativePath(file)));return {isFile:stat.isFile(),isDirectory:stat.isDirectory(),isSymbolicLink:stat.isSymbolicLink(),size:stat.size,mode:stat.mode,mtime:stat.mtime,identity:`${stat.dev}:${stat.ino}`};}
  const {sftp,target}=await sshPath(user,root,file);const stat=await sftpCall<Attributes>(cb=>sftp.lstat(target,cb));
  return {isFile:stat.isFile(),isDirectory:stat.isDirectory(),isSymbolicLink:stat.isSymbolicLink(),size:stat.size,mode:stat.mode,mtime:new Date(stat.mtime*1000),identity:`${root.connection}:${target}`};
}
async function remoteBuffer(user:number,root:WorkspaceRoot,file:string) {
  file=relativePath(file);const bytes=await rootReadBytes(user,root,file),d=decode(bytes),digest=hash(bytes);
  let row=db().prepare('SELECT * FROM buffers WHERE user_id=? AND project=? AND path=?').get(user,root.id,file) as BufferRow|undefined;
  if(!row)db().prepare('INSERT INTO buffers(user_id,project,path,text,base_hash,encoding,newline,readonly) VALUES(?,?,?,?,?,?,?,?)').run(user,root.id,file,d.text,digest,d.encoding,d.newline,Number(d.readonly));
  else if(!row.dirty&&row.base_hash!==digest)db().prepare('UPDATE buffers SET text=?,base_hash=?,encoding=?,newline=?,readonly=?,revision=revision+1 WHERE user_id=? AND project=? AND path=?').run(d.text,digest,d.encoding,d.newline,Number(d.readonly),user,root.id,file);
  row=db().prepare('SELECT * FROM buffers WHERE user_id=? AND project=? AND path=?').get(user,root.id,file) as BufferRow;
  return {project:root.id,path:file,text:row.text,revision:row.revision,dirty:!!row.dirty,readonly:!!row.readonly,conflict:!!row.dirty&&row.base_hash!==digest,diskText:d.text,owner:leaseOwner(bufferKey(user,root.id,file)) ?? leaseOwner(`file:${root.connection}:${root.root}/${file}`),encoding:row.encoding,newline:row.newline};
}
type SshSnapshot = { file: string; target: string; raw: Buffer | null; stat?: Attributes; identity?: string; parents: Map<string, string>; client: Client; resource: string };
async function sshIdentities(user: number, root: WorkspaceRoot, paths: string[]) {
  const files = paths.map(shellQuote).join(' ');
  const result = await sshExec(user, root.connection, `command -v sync >/dev/null && if [ "$(uname -s)" = Darwin ]; then stat -f '%d:%i:%l:%p' ${files}; else stat -c '%d:%i:%h:%f' -- ${files}; fi`);
  const lines = result.stdout.trim().split('\n');
  if (result.exitCode !== 0 || lines.length !== paths.length || lines.some(line => !/^\d+:\d+:\d+:[0-9a-f]+$/i.test(line))) throw new DevError('SSH writes require supported Linux/macOS stat and sync commands. No files were changed.');
  return new Map(paths.map((p, i) => [p, lines[i] ?? '']));
}
async function inspectSsh(user: number, root: WorkspaceRoot, file: string): Promise<SshSnapshot> {
  assertNoDirectoryMutation();
  file = relativePath(file);
  if (!file) throw new DevError('Cannot mutate a workspace root.');
  const { client, connection, sftp } = await sshSession(user, root.connection);
  if (await sftpCall<string>(cb => sftp.realpath(root.root, cb)) !== root.root) throw new DevError('SSH root changed or became a symlink.', 409);
  const { target } = await sshPath(user, root, file, true);
  const parents: string[] = [];
  let current = root.root;
  for (const segment of ['', ...file.split('/').slice(0, -1)]) {
    current = path.posix.join(current, segment);
    try { const stat = await sftpCall<Attributes>(cb => sftp.lstat(current, cb)); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DevError('SSH parent is not a regular directory.', 409); parents.push(current); }
    catch (e) { if ((e as { code?: number }).code !== 2) throw e; }
  }
  let stat: Attributes | undefined, raw: Buffer | null = null;
  try { stat = await sftpCall<Attributes>(cb => sftp.lstat(target, cb)); }
  catch (e) { if ((e as { code?: number }).code !== 2) throw e; }
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE)) throw new DevError('SSH mutations require regular files up to 5 MiB.');
  const identities = await sshIdentities(user, root, [...parents, ...(stat ? [target] : [])]);
  const identity = identities.get(target);
  if (identity && identity.split(':')[2] !== '1') throw new DevError('SSH mutations refuse hard-linked files.');
  if (stat) raw = await rootReadBytes(user, root, file);
  identities.delete(target);
  for (const [p, value] of identities) { const fields = value.split(':'); identities.set(p, `${fields[0]}:${fields[1]}:${fields[3]}`); }
  // Conservative case folding also protects case-insensitive SSH filesystems.
  const endpoint = `${connection.host.toLowerCase()}:${connection.port}:${connection.username}:${connection.hostFingerprint}`;
  return { file, target, raw, stat, identity, parents: identities, client, resource: `mutation:${hash(Buffer.from(`${endpoint}:${target.normalize('NFC').toLowerCase()}`))}` };
}
function sshPeers(root: WorkspaceRoot, snapshot: SshSnapshot) {
  const connections = db().prepare('SELECT id,json FROM workspace_connections').all() as { id: string; json: string }[];
  const currentRow = connections.find(c => c.id === root.connection);
  if (!currentRow) throw new DevError('SSH connection no longer exists.', 409);
  const current = JSON.parse(currentRow.json);
  const same = new Set(connections.filter(c => { const v = JSON.parse(c.json); return v.host.toLowerCase() === current.host.toLowerCase() && v.port === current.port && v.username === current.username && v.hostFingerprint === current.hostFingerprint; }).map(c => c.id));
  return (db().prepare('SELECT b.*,p.connection,p.native_root FROM buffers b JOIN projects p ON p.id=b.project').all() as (BufferRow & { user_id: number; project: string; path: string; connection: string; native_root: string })[])
    .filter(p => same.has(p.connection) && path.posix.join(p.native_root, p.path).normalize('NFC').toLowerCase() === snapshot.target.normalize('NFC').toLowerCase());
}
function checkSshBuffers(user: number, root: WorkspaceRoot, snapshot: SshSnapshot, owner: string, reservation?: string, revision?: unknown, savingRevision?: number) {
  const lock = leaseOwner(snapshot.resource);
  if (lock && lock !== reservation) throw new DevError('Another mutation is prepared for this SSH file.', 409);
  for (const peer of sshPeers(root, snapshot)) {
    const lease = leaseOwner(bufferKey(peer.user_id, peer.project, peer.path)) ?? leaseOwner(`file:${peer.connection}:${peer.native_root}/${peer.path}`);
    if (lease && (lease !== owner || peer.user_id !== user)) throw new DevError('Another client owns an overlapping SSH buffer.', 409);
    if (peer.dirty && !(peer.user_id === user && peer.project === root.id && peer.path === snapshot.file && peer.revision === savingRevision && lease === owner)) throw new DevError('Save or resolve dirty SSH recovery buffers before mutation.', 409);
  }
  const row = db().prepare('SELECT revision,base_hash FROM buffers WHERE user_id=? AND project=? AND path=?').get(user, root.id, snapshot.file) as { revision: number; base_hash: string } | undefined;
  if (revision !== undefined && (!Number.isSafeInteger(revision) || Number(revision) < 0 || revision !== (row?.revision ?? 0) || row && row.base_hash !== (snapshot.raw ? hash(snapshot.raw) : ''))) throw new DevError('Stale SSH buffer revision or disk hash.', 409);
}
async function recheckSsh(user: number, root: WorkspaceRoot, snapshot: SshSnapshot) {
  const granted = rootOf(user, root.id);
  if (granted.root !== root.root || granted.connection !== root.connection) throw new DevError('Workspace folder grant changed before publication.', 409);
  const current = await inspectSsh(user, root, snapshot.file);
  if (current.client !== snapshot.client || current.identity !== snapshot.identity || (current.raw ? hash(current.raw) : null) !== (snapshot.raw ? hash(snapshot.raw) : null) ||
    [...snapshot.parents].some(([p, identity]) => current.parents.get(p) !== identity)) throw new DevError('SSH file, parent or connection changed during mutation preparation.', 409);
}
async function sshWriteSupport(user: number, root: WorkspaceRoot) {
  const { sftp } = await sshSession(user, root.connection);
  const probe = path.posix.join(root.root, `.rimeward-probe-${crypto.randomUUID()}`), linked = `${probe}-link`, renamed = `${probe}-rename`;
  let handle: Buffer | undefined;
  try {
    handle = await sftpCall<Buffer>(cb => sftp.open(probe, 'wx', 0o600, cb));
    const opened = handle;
    await sftpCall<void>(cb => sftp.fchmod(opened, 0o600, cb));
    await sftpCall<void>(cb => sftp.ext_openssh_fsync(opened, cb));
    await sftpCall<void>(cb => sftp.ext_openssh_hardlink(probe, linked, cb));
    await sftpCall<void>(cb => sftp.ext_openssh_rename(linked, renamed, cb));
  } catch { throw new DevError('SSH writes require OpenSSH fsync, hardlink and atomic rename extensions. Source files were not changed.'); }
  finally { const opened = handle; if (opened) await sftpCall<void>(cb => sftp.close(opened, cb)).catch(() => {}); for (const file of [probe, linked, renamed]) await sftpCall<void>(cb => sftp.unlink(file, cb)).catch(() => {}); }
}
function saveSshBuffers(user: number, root: WorkspaceRoot, snapshot: SshSnapshot, bytes: Buffer | null, owner: string) {
  const decoded = decode(bytes ?? snapshot.raw ?? Buffer.alloc(0));
  const peers = [{ user_id: user, project: root.id, path: snapshot.file }, ...sshPeers(root, snapshot).filter(p => p.user_id !== user || p.project !== root.id || p.path !== snapshot.file)];
  for (const p of peers) {
    db().prepare(`INSERT INTO buffers(user_id,project,path,text,base_hash,encoding,newline,readonly) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,project,path) DO UPDATE SET text=excluded.text,base_hash=excluded.base_hash,encoding=excluded.encoding,newline=excluded.newline,readonly=excluded.readonly,dirty=0,revision=buffers.revision+1`)
      .run(p.user_id, p.project, p.path, decoded.text, bytes ? hash(bytes) : '', decoded.encoding, decoded.newline, Number(!bytes || decoded.readonly));
    emitDev(p.user_id, 'buffer', p.project, { path: p.path });
  }
  claimLease(bufferKey(user, root.id, snapshot.file), owner);
  return (db().prepare('SELECT revision FROM buffers WHERE user_id=? AND project=? AND path=?').get(user, root.id, snapshot.file) as { revision: number }).revision;
}
async function mutateSsh(user: number, root: WorkspaceRoot, snapshot: SshSnapshot, bytes: Buffer | null, owner: string, reservation?: string, recovery?: number, savingRevision?: number, signal?: AbortSignal, newMode?: number) {
  signal?.throwIfAborted();
  if (bytes && bytes.length > MAX_FILE) throw new DevError('File exceeds 5 MiB.');
  checkSshBuffers(user, root, snapshot, owner, reservation, savingRevision, savingRevision);
  const lock = reservation ?? `mutation:${crypto.randomUUID()}`;
  const mode = (snapshot.stat?.mode ?? newMode ?? 0o600) & 0o777;
  if (!reservation) claimLease(snapshot.resource, lock, false, Infinity);
  const receipt = { operation: bytes === null ? 'delete' : snapshot.raw === null ? 'add' : 'update', path: snapshot.file, saved: false, revision: null as number | null,
    hash: bytes ? hash(bytes) : null, recovery };
  let temp: string | undefined, published = false;
  try {
    await recheckSsh(user, root, snapshot);
    if (!reservation) await sshWriteSupport(user, root);
    const { sftp } = await sshSession(user, root.connection);
    if (snapshot.raw && receipt.recovery === undefined) receipt.recovery = Number(db().prepare('INSERT INTO buffer_copies(user_id,project,path,text,raw,mode) VALUES(?,?,?,?,?,?)')
      .run(user, root.id, snapshot.file, decode(snapshot.raw).text, snapshot.raw, snapshot.stat?.mode ?? 0o600).lastInsertRowid);
    if (bytes !== null) {
      let parent = root.root;
      for (const segment of snapshot.file.split('/').slice(0, -1)) {
        parent = path.posix.join(parent, segment);
        try { await sftpCall<Attributes>(cb => sftp.lstat(parent, cb)); }
        catch (error) { if ((error as { code?: number }).code !== 2) throw error; await sftpCall<void>(cb => sftp.mkdir(parent, { mode: 0o700 }, cb)); }
      }
      await recheckSsh(user, root, snapshot);
      temp = path.posix.join(path.posix.dirname(snapshot.target), `.rimeward-patch-${crypto.randomUUID()}`);
      const handle = await sftpCall<Buffer>(cb => sftp.open(temp as string, 'wx', 0o600, cb));
      try {
        if (bytes.length) await sftpCall<void>(cb => sftp.write(handle, bytes, 0, bytes.length, 0, cb));
        await sftpCall<void>(cb => sftp.fchmod(handle, mode, cb));
        await sftpCall<void>(cb => sftp.ext_openssh_fsync(handle, cb));
      } finally { await sftpCall<void>(cb => sftp.close(handle, cb)); }
      const staged = await sftpCall<Attributes>(cb => sftp.lstat(temp as string, cb));
      if (!staged.isFile() || staged.isSymbolicLink() || staged.size !== bytes.length) throw new DevError('SSH staging path changed.');
      if (hash(await sftpCall<Buffer>(cb => sftp.readFile(temp as string, cb))) !== receipt.hash) throw new DevError('SSH staged file verification failed.');
    }
    checkSshBuffers(user, root, snapshot, owner, lock, savingRevision, savingRevision);
    if (leaseOwner(snapshot.resource) !== lock) throw new DevError('SSH mutation reservation expired.', 409);
    await recheckSsh(user, root, snapshot);
    if (leaseOwner(snapshot.resource) !== lock) throw new DevError('SSH mutation reservation expired before publication.', 409);
    const granted = rootOf(user, root.id);
    if (granted.root !== root.root || granted.connection !== root.connection) throw new DevError('Workspace folder grant changed before publication.', 409);
    signal?.throwIfAborted();
    // No-clobber publication for new paths; existing paths use atomic OpenSSH rename.
    if (bytes === null) await sftpCall<void>(cb => sftp.unlink(snapshot.target, cb));
    else if (snapshot.raw === null) await sftpCall<void>(cb => sftp.ext_openssh_hardlink(temp as string, snapshot.target, cb));
    else await sftpCall<void>(cb => sftp.ext_openssh_rename(temp as string, snapshot.target, cb));
    published = true; receipt.saved = true;
    if ((await sshExec(user, root.connection, 'sync')).exitCode !== 0) throw new DevError('SSH directory durability could not be confirmed.');
    if (bytes !== null && hash(await rootReadBytes(user, root, snapshot.file)) !== receipt.hash) throw new DevError('SSH destination changed after publication.');
    if (bytes !== null && ((await sftpCall<Attributes>(cb => sftp.lstat(snapshot.target, cb))).mode & 0o777) !== mode) throw new DevError('SSH destination mode could not be verified.');
    receipt.revision = saveSshBuffers(user, root, snapshot, bytes, owner);
    return { ...receipt, ok: true, ...(bytes === null ? { deleted: true } : {}) };
  } catch (error) {
    throw Object.assign(new DevError(error instanceof Error ? error.message : String(error), 409), { receipt: { ok: false, applied: published ? [receipt] : [], uncertain: true } });
  } finally {
    if (temp) { const connection = await sshSession(user, root.connection).catch(() => null); if (connection?.client === snapshot.client) await sftpCall<void>(cb => connection.sftp.unlink(temp as string, cb)).catch(() => {}); }
    if (!reservation) releaseLease(snapshot.resource, lock);
    emitDev(user, 'project', root.id);
  }
}
export async function rootWriteBytes(user:number,root:WorkspaceRoot,file:string,bytes:Buffer,owner:string,expectedHash:string|null,savingRevision?:number,signal?:AbortSignal,newMode?:number) {
  signal?.throwIfAborted();
  const granted = rootOf(user, root.id);
  if (granted.root !== root.root || granted.connection !== root.connection) throw new DevError('Workspace folder grant changed.', 409);
  if (!root.connection) {
    const result = applyProjectBytes(user, root.id, owner, relativePath(file), bytes, expectedHash, { newMode });
    if (!result.ok) throw Object.assign(new DevError(('error' in result ? result.error : undefined) ?? 'Workspace write failed.', 409), { receipt: result });
    return { ...result.applied[0], ok: true };
  }
  const snapshot = await inspectSsh(user, root, file);
  if ((snapshot.raw ? hash(snapshot.raw) : null) !== expectedHash) throw new DevError('The file changed; read it again.', 409);
  return mutateSsh(user, root, snapshot, bytes, owner, undefined, undefined, savingRevision, signal, newMode);
}
export async function rootRemove(user:number,root:WorkspaceRoot,file:string,owner:string,expectedHash?:string,signal?:AbortSignal) {
  signal?.throwIfAborted();
  const granted = rootOf(user, root.id);
  if (granted.root !== root.root || granted.connection !== root.connection) throw new DevError('Workspace folder grant changed.', 409);
  if (!root.connection) {
    const result = applyProjectBytes(user, root.id, owner, relativePath(file), null, expectedHash ?? hash(await rootReadBytes(user, root, file)));
    if (!result.ok) throw Object.assign(new DevError(('error' in result ? result.error : undefined) ?? 'Workspace deletion failed.', 409), { receipt: result });
    return { ...result.applied[0], deleted: true, ok: true };
  }
  const snapshot = await inspectSsh(user, root, file);
  if (!snapshot.raw || expectedHash !== undefined && hash(snapshot.raw) !== expectedHash) throw new DevError('Source changed before deletion; copied destination is preserved.', 409);
  return mutateSsh(user, root, snapshot, null, owner, undefined, undefined, undefined, signal);
}
type PreparedPatch = {
  user: number; root: string; owner: string; operationId: string; planId: string; fingerprint: string; patch: string; revisions?: unknown;
  hashes: Record<string, string | null>; identities?: Record<string, string | null>; parents?: Record<string, string>;
  resources: string[]; expires: number; sourceBytes: number; ssh?: Map<string, SshSnapshot>; bytes?: Map<string, Buffer>; recovery?: Map<string, number>;
};
const preparations = new Map<string, PreparedPatch>();
const PATCH_TTL = 30_000;
const journalId = (operationId: string, root: string) => hash(Buffer.from(`${operationId}:${root}`));
function savePatchReceipt(plan: PreparedPatch, state: string, receipt: object) {
  db().prepare('UPDATE workspace_operations SET state=?,receipt=?,updated=? WHERE id=? AND user_id=?')
    .run(state, JSON.stringify({ operationId: plan.operationId, rootId: plan.root, state, ...receipt }), Date.now(), plan.planId, plan.user);
}
function releasePatch(plan: PreparedPatch) {
  preparations.delete(plan.planId);
  for (const resource of plan.resources) releaseLease(resource, `patch:${plan.planId}`);
}
function patchStatus(user: number, root: WorkspaceRoot, operationId: string, cursor = 0) {
  if (!/^[a-f0-9-]{36}$/i.test(operationId)) throw new DevError('Invalid workspace operation ID.');
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DevError('Invalid receipt cursor.');
  const where = "user_id=? AND json_extract(receipt,'$.rootId')=? AND json_extract(receipt,'$.operationId')=?";
  const counts = db().prepare(`SELECT state,COUNT(*) AS count FROM workspace_operations WHERE ${where} GROUP BY state`).all(user, root.id, operationId) as { state: string; count: number }[];
  const total = counts.reduce((n, row) => n + row.count, 0);
  const rows = db().prepare(`SELECT id,state,receipt FROM workspace_operations WHERE ${where} ORDER BY rowid LIMIT 10 OFFSET ?`).all(user, root.id, operationId, cursor) as { id: string; state: string; receipt: string }[];
  const results: Record<string, unknown>[] = [];
  for (const row of rows) {
    const receipt = JSON.parse(row.receipt);
    results.push(row.state === 'running' || row.state === 'prepared' && !preparations.has(row.id)
      ? { ...receipt, ok: false, uncertain: row.state === 'running', state: row.state === 'running' ? 'uncertain' : 'expired', note: 'Inspect current paths and hashes before another mutation. Status lookup never replays an operation.' } : receipt);
  }
  if (!total) return { operationId, rootId: root.id, state: 'not-found', ok: false };
  return total === 1 ? results[0] : { operationId, rootId: root.id, state: 'transfer', phases: results, counts: Object.fromEntries(counts.map(row => [row.state, row.count])), total, ...(cursor + results.length < total ? { next: cursor + results.length } : {}) };
}
async function journalByteMutation(user: number, root: WorkspaceRoot, operation: 'write-bytes' | 'remove', args: Record<string, unknown>, owner: string, signal?: AbortSignal) {
  const operationId = typeof args.operationId === 'string' ? args.operationId : crypto.randomUUID(), phase = operation === 'remove' ? 'delete' : 'copy';
  if (!/^[a-f0-9-]{36}$/i.test(operationId)) throw new DevError('Invalid workspace operation ID.');
  const file = relativePath(String(args.path ?? ''));
  const encoded = operation === 'write-bytes' ? String(args.data ?? '') : '';
  if (encoded.length > Math.ceil(MAX_FILE / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new DevError('Invalid or oversized file bytes.');
  const bytes = operation === 'write-bytes' ? Buffer.from(encoded, 'base64') : null;
  const permissions = args.permissions === undefined ? undefined : Number(args.permissions);
  if (permissions !== undefined && (!Number.isInteger(permissions) || permissions < 0 || permissions > 0o777)) throw new DevError('Invalid file mode.');
  const id = journalId(operationId, `${root.id}:${phase}:${file}`), fingerprint = JSON.stringify({ owner, root: root.root, connection: root.connection, file, operation, expectedHash: args.expectedHash ?? null, hash: bytes ? hash(bytes) : null, permissions });
  const old = db().prepare('SELECT fingerprint,state,receipt FROM workspace_operations WHERE id=? AND user_id=?').get(id, user) as { fingerprint: string; state: string; receipt: string } | undefined;
  if (old) {
    if (old.fingerprint !== fingerprint) throw new DevError('Operation ID already names a different mutation.', 409);
    const result = JSON.parse(old.receipt);
    if (old.state === 'completed') return result;
    throw Object.assign(new DevError(`Workspace operation ${operationId} is ${old.state}; inspect its receipt before another mutation.`, 409), { receipt: { ...result, uncertain: old.state === 'running' || result.uncertain } });
  }
  const started = { operationId, rootId: root.id, phase, path: file, state: 'running', ok: false, applied: [], expectedHash: args.expectedHash ?? null, hash: bytes ? hash(bytes) : null };
  db().prepare("INSERT INTO workspace_operations(id,user_id,fingerprint,state,receipt,updated) VALUES(?,?,?,'running',?,?)").run(id, user, fingerprint, JSON.stringify(started), Date.now());
  try {
    const result = bytes === null ? await rootRemove(user, root, file, owner, typeof args.expectedHash === 'string' ? args.expectedHash : undefined, signal)
      : await rootWriteBytes(user, root, file, bytes, owner, args.expectedHash === null ? null : String(args.expectedHash), undefined, signal, permissions);
    const receipt = { ...result, operationId, rootId: root.id, phase, state: 'completed', ok: true };
    db().prepare("UPDATE workspace_operations SET state='completed',receipt=?,updated=? WHERE id=?").run(JSON.stringify(receipt), Date.now(), id);
    return receipt;
  } catch (error) {
    const partial = error && typeof error === 'object' && 'receipt' in error ? error.receipt as object : {};
    const receipt = { ...started, ...partial, state: 'uncertain', ok: false, uncertain: true, error: error instanceof Error ? error.message : String(error) };
    db().prepare("UPDATE workspace_operations SET state='uncertain',receipt=?,updated=? WHERE id=?").run(JSON.stringify(receipt), Date.now(), id);
    throw Object.assign(new DevError(`Workspace operation ${operationId}: ${receipt.error}`, 409), { receipt });
  }
}
async function journalDirectoryMutation(user: number, root: WorkspaceRoot, operation: string, args: Record<string, unknown>, owner: string, signal?: AbortSignal) {
  const operationId = String(args.operationId), file = relativePath(String(args.path ?? ''));
  if (!/^[a-f0-9-]{36}$/i.test(operationId)) throw new DevError('Invalid workspace operation ID.');
  const id = journalId(operationId, `${root.id}:${operation}:${file}`), fingerprint = JSON.stringify({ owner, root: root.root, connection: root.connection, file, operation, to: args.to ?? null });
  const prior = db().prepare('SELECT fingerprint,state,receipt FROM workspace_operations WHERE id=? AND user_id=?').get(id, user) as { fingerprint: string; state: string; receipt: string } | undefined;
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new DevError('Operation ID already names another directory mutation.', 409);
    if (prior.state === 'completed') return JSON.parse(prior.receipt);
    throw new DevError(`Directory operation ${operationId} has an uncertain receipt. Inspect its current state before another mutation.`, 409);
  }
  const started = { operationId, rootId: root.id, phase: operation, path: file, state: 'running', ok: false, directory: true };
  db().prepare("INSERT INTO workspace_operations(id,user_id,fingerprint,state,receipt,updated) VALUES(?,?,?,'running',?,?)").run(id, user, fingerprint, JSON.stringify(started), Date.now());
  try {
    await rootOperation(user, root.id, operation, { ...args, operationId: undefined }, owner, signal);
    const result = { ...started, ok: true, state: 'completed', created: operation === 'mkdir', deleted: operation === 'rmdir', ...(operation === 'rename-directory' ? { renamed: true, to: args.to } : {}) };
    db().prepare("UPDATE workspace_operations SET state='completed',receipt=?,updated=? WHERE id=?").run(JSON.stringify(result), Date.now(), id);
    return result;
  } catch (error) {
    const result = { ...started, state: 'uncertain', uncertain: true, error: error instanceof Error ? error.message : String(error) };
    db().prepare("UPDATE workspace_operations SET state='uncertain',receipt=?,updated=? WHERE id=?").run(JSON.stringify(result), Date.now(), id);
    throw Object.assign(new DevError(`Directory operation ${operationId}: ${result.error}`, 409), { receipt: result });
  }
}
async function prepareRootPatch(user: number, root: WorkspaceRoot, args: Record<string, unknown>, owner: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  for (const plan of preparations.values()) if (plan.expires < Date.now()) { savePatchReceipt(plan, 'expired', { ok: false, notRun: true, applied: [] }); releasePatch(plan); }
  const operationId = typeof args.operationId === 'string' ? args.operationId : crypto.randomUUID();
  if (!/^[a-f0-9-]{36}$/i.test(operationId)) throw new DevError('Invalid workspace operation ID.');
  const patch = String(args.patch), operations = parsePatch(patch), planId = journalId(operationId, root.id);
  const fingerprint = JSON.stringify({ owner, root: root.root, connection: root.connection, patch: hash(Buffer.from(patch)), revisions: args.expected_revisions ?? null });
  const prior = db().prepare('SELECT fingerprint FROM workspace_operations WHERE id=? AND user_id=?').get(planId, user) as { fingerprint: string } | undefined;
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new DevError('Operation ID was already used for a different patch.', 409);
    const existing = preparations.get(planId);
    if (existing) return { planId, operationId, sourceBytes: existing.sourceBytes, resources: existing.resources, resourceScope: root.connection ? 'ssh' : 'local', expiresAt: existing.expires };
    throw Object.assign(new DevError('This patch operation already has a receipt; inspect it instead of replaying.', 409), { receipt: patchStatus(user, root, operationId) });
  }
  const plan: PreparedPatch = { user, root: root.id, owner, operationId, planId, fingerprint, patch, revisions: args.expected_revisions, hashes: {}, resources: [], expires: Date.now() + PATCH_TTL, sourceBytes: 0 };
  try {
    if (!root.connection) {
      const preview = applyProjectPatch(user, root.id, owner, patch, args.expected_revisions, { prepare: true });
      if (!('prepared' in preview) || !preview.prepared) throw new DevError('Local patch preflight failed.');
      plan.hashes = preview.prepared; plan.resources = preview.resources; plan.identities = preview.identities; plan.parents = preview.parents; plan.sourceBytes = preview.sourceBytes;
    } else {
      if (args.expected_revisions !== undefined && (!args.expected_revisions || typeof args.expected_revisions !== 'object' || Array.isArray(args.expected_revisions))) throw new DevError('expected_revisions must be a path-to-revision map.');
      const revisions = (args.expected_revisions ?? {}) as Record<string, unknown>;
      plan.ssh = new Map(); plan.bytes = new Map(); plan.recovery = new Map();
      const targets: string[] = [];
      for (const op of operations) {
        signal?.throwIfAborted();
        for (const file of [op.path, ...(op.kind === 'update' && op.move ? [op.move] : [])]) {
          const snapshot = await inspectSsh(user, root, file);
          const target = snapshot.target.normalize('NFC').toLowerCase();
          if (targets.some(p => p === target || p.startsWith(`${target}/`) || target.startsWith(`${p}/`))) throw new DevError('Duplicate or colliding SSH patch paths.');
          targets.push(target);
          if (plan.resources.includes(snapshot.resource)) throw new DevError('Patch aliases the same SSH file more than once.');
          checkSshBuffers(user, root, snapshot, owner, undefined, revisions[file]);
          plan.ssh.set(file, snapshot); plan.resources.push(snapshot.resource); plan.hashes[file] = snapshot.raw ? hash(snapshot.raw) : null;
          plan.sourceBytes += snapshot.raw?.length ?? 0;
          if (plan.sourceBytes > 20 * 1024 * 1024) throw new DevError('Patch sources exceed 20 MiB.');
        }
        const source = plan.ssh.get(op.path) as SshSnapshot;
        if (op.kind === 'add' ? source.raw !== null : source.raw === null) throw new DevError('Patch source or destination changed.', 409);
        if (op.kind === 'update' && op.move && plan.ssh.get(op.move)?.raw !== null) throw new DevError('Move destination already exists.', 409);
        const decoded = decode(source.raw ?? Buffer.alloc(0));
        if (decoded.readonly) throw new DevError('Patch source has unsupported encoding, mixed newlines or binary content.');
        if (op.kind !== 'delete') {
          const bytes = encode(op.kind === 'add' ? op.text : patchText(decoded.text, op), decoded.encoding, decoded.newline);
          if (bytes.length > MAX_FILE) throw new DevError('Patched file exceeds 5 MiB.');
          plan.bytes.set(op.path, bytes);
        }
      }
      for (const file of Object.keys(revisions)) if (!plan.ssh.has(file)) throw new DevError('Expected revision does not name a patch path.');
      await sshWriteSupport(user, root);
    }
    plan.resources.sort();
    signal?.throwIfAborted();
    for (const resource of plan.resources) claimLease(resource, `patch:${planId}`, false, PATCH_TTL);
    plan.expires = Date.now() + PATCH_TTL;
    if (plan.ssh) for (const snapshot of plan.ssh.values()) {
      signal?.throwIfAborted();
      await recheckSsh(user, root, snapshot);
      if (snapshot.raw) plan.recovery?.set(snapshot.file, Number(db().prepare('INSERT INTO buffer_copies(user_id,project,path,text,raw,mode) VALUES(?,?,?,?,?,?)')
        .run(user, root.id, snapshot.file, decode(snapshot.raw).text, snapshot.raw, snapshot.stat?.mode ?? 0o600).lastInsertRowid));
    }
    const receipt = { operationId, rootId: root.id, state: 'prepared', ok: false, applied: [], paths: Object.keys(plan.hashes), baseHashes: plan.hashes };
    db().prepare("INSERT INTO workspace_operations(id,user_id,fingerprint,state,receipt,updated) VALUES(?,?,?,'prepared',?,?)").run(planId, user, fingerprint, JSON.stringify(receipt), Date.now());
    preparations.set(planId, plan);
    return { planId, operationId, sourceBytes: plan.sourceBytes, resources: plan.resources, resourceScope: root.connection ? 'ssh' : 'local', expiresAt: plan.expires };
  } catch (error) { releasePatch(plan); throw error; }
}
function admittedPatch(user: number, root: WorkspaceRoot, args: Record<string, unknown>, owner: string) {
  const plan = preparations.get(String(args.planId));
  if (!plan || plan.user !== user || plan.root !== root.id || plan.owner !== owner || plan.expires < Date.now() || plan.fingerprint !== JSON.stringify({ owner, root: root.root, connection: root.connection, patch: hash(Buffer.from(plan.patch)), revisions: plan.revisions ?? null })) throw new DevError('Patch preparation expired or changed; inspect its operation receipt.', 409);
  if (plan.resources.some(key => leaseOwner(key) !== `patch:${plan.planId}`)) throw new DevError('A patch reservation expired or was lost.', 409);
  return plan;
}
async function commitRootPatch(user: number, root: WorkspaceRoot, args: Record<string, unknown>, owner: string, signal?: AbortSignal) {
  const previous = db().prepare('SELECT fingerprint,state,receipt FROM workspace_operations WHERE id=? AND user_id=?').get(String(args.planId), user) as { fingerprint: string; state: string; receipt: string } | undefined;
  if (previous && previous.state !== 'prepared') {
    const identity = JSON.parse(previous.fingerprint);
    if (identity.owner !== owner || identity.root !== root.root || identity.connection !== root.connection) throw new DevError('Not your patch operation.', 403);
    const receipt = JSON.parse(previous.receipt);
    return { ...receipt, ...(previous.state === 'running' ? { ok: false, uncertain: true, state: 'uncertain' } : {}) };
  }
  const plan = admittedPatch(user, root, args, owner);
  const claimed = db().prepare("UPDATE workspace_operations SET state='running',updated=? WHERE id=? AND user_id=? AND state='prepared'").run(Date.now(), plan.planId, user).changes;
  if (!claimed) return patchStatus(user, root, plan.operationId);
  const applied: Record<string, unknown>[] = [];
  const renew = setInterval(() => { plan.expires = Date.now() + PATCH_TTL; for (const key of plan.resources) if (leaseOwner(key) === `patch:${plan.planId}`) claimLease(key, `patch:${plan.planId}`, false, PATCH_TTL); }, PATCH_TTL / 3);
  try {
    signal?.throwIfAborted();
    if (!root.connection) {
      const result = applyProjectPatch(user, root.id, owner, plan.patch, plan.revisions, { hashes: plan.hashes, identities: plan.identities, parents: plan.parents, mutationOwner: `patch:${plan.planId}` });
      savePatchReceipt(plan, result.ok ? 'completed' : 'partial', result);
      return { ...result, operationId: plan.operationId };
    }
    for (const snapshot of plan.ssh?.values() ?? []) { checkSshBuffers(user, root, snapshot, owner, `patch:${plan.planId}`); await recheckSsh(user, root, snapshot); }
    for (const op of parsePatch(plan.patch)) {
      signal?.throwIfAborted();
      const source = plan.ssh?.get(op.path) as SshSnapshot;
      if (op.kind === 'delete') applied.push(await mutateSsh(user, root, source, null, owner, `patch:${plan.planId}`, plan.recovery?.get(op.path), undefined, signal));
      else {
        const dest = op.kind === 'update' && op.move ? plan.ssh?.get(op.move) as SshSnapshot : source;
        const receipt: Record<string, unknown> = await mutateSsh(user, root, dest, plan.bytes?.get(op.path) as Buffer, owner, `patch:${plan.planId}`, plan.recovery?.get(dest.file), undefined, signal);
        if (dest !== source) Object.assign(receipt, { operation: 'copy', path: source.file, to: dest.file });
        applied.push(receipt); savePatchReceipt(plan, 'running', { ok: false, applied, baseHashes: plan.hashes });
        if (dest !== source) { const removed = await mutateSsh(user, root, source, null, owner, `patch:${plan.planId}`, plan.recovery?.get(source.file), undefined, signal); Object.assign(receipt, { operation: 'move', recovery: removed.recovery }); }
      }
      savePatchReceipt(plan, 'running', { ok: false, applied, baseHashes: plan.hashes });
    }
    const result = { ok: true, operationId: plan.operationId, applied };
    savePatchReceipt(plan, 'completed', result); return result;
  } catch (error) {
    const partial = error && typeof error === 'object' && 'receipt' in error ? error.receipt as { applied?: Record<string, unknown>[] } : undefined;
    applied.push(...(partial?.applied ?? []));
    const result = { ok: false, operationId: plan.operationId, applied, uncertain: true, error: error instanceof Error ? error.message : String(error), baseHashes: plan.hashes, note: 'Inspect this operation receipt and the same paths before retrying; no rollback or replay was attempted.' };
    savePatchReceipt(plan, 'uncertain', result); return result;
  } finally { clearInterval(renew); releasePatch(plan); }
}
export async function rootOperation(user:number,rootId:string,operation:string,args:Record<string,unknown>,owner:string,signal?:AbortSignal):Promise<unknown> {
  const root=rootOf(user,rootId),file=String(args.path??'');signal?.throwIfAborted();
  if(operation==='terminal-placement-read'){
    const session=String(args.session??''),ward=String(args.ward??'');const row=db().prepare('SELECT id,project,origin_ward,title,kind,state,workspace_json,virtual_cwd FROM terminal_sessions WHERE id=? AND user_id=? AND project=?').get(session,user,rootId) as {id:string;project:string;origin_ward:string;title:string;kind:string;state:string;workspace_json:string;virtual_cwd:string}|undefined;
    if(!row)throw new DevError('Terminal session not found.',404);
    const view=JSON.parse((db().prepare('SELECT json FROM ward_state WHERE user_id=? AND ward=?').get(user,ward) as {json:string}|undefined)?.json??'{}');
    const contains=(value:unknown):boolean=>typeof value==='string'?value===session:Array.isArray(value)?value.some(contains):!!value&&typeof value==='object'&&Object.entries(value).some(([key,item])=>['session','id','tabs','closedSessions','groups','children','a','b','first','second'].includes(key)&&contains(item));
    return {sessionId:row.id,rootId:row.project,originWard:row.origin_ward,associated:contains(view),title:row.title,kind:row.kind,state:row.state,virtualCwd:row.virtual_cwd||'/',...(row.workspace_json?{workspace:JSON.parse(row.workspace_json)}:{})};
  }
  if(operation==='location')return rootLocation(user,root,file);
  if(operation==='patch-preview'){
    if(args.recovery!==undefined){
      if(!Number.isSafeInteger(args.recovery))throw new DevError('Invalid recovery reference.');
      const copy=db().prepare('SELECT text FROM buffer_copies WHERE id=? AND user_id=? AND project=? AND path=?').get(args.recovery,user,rootId,relativePath(file)) as {text:string}|undefined;
      if(!copy)throw new DevError('This edit’s original file is no longer retained.',404);
      return {text:copy.text,source:'original'};
    }
    const bytes=await rootReadBytes(user,root,file),decoded=decode(bytes);
    if(decoded.readonly)throw new DevError('This file cannot be displayed as text.');
    return {text:decoded.text,hash:hash(bytes),source:'current'};
  }
  if(operation==='transfer-tree')return transferTree(user,root,file,Number(args.cursor)||0);
  if(operation==='rename-directory')return renameDirectory(user,root,file,String(args.to),owner);
  if(['mkdir','rmdir','rename-directory'].includes(operation)&&typeof args.operationId==='string')return journalDirectoryMutation(user,root,operation,args,owner,signal);
  if(operation==='info'){await rootStat(user,root,'');const connection=root.connection?(await sshConnections(user)).find(c=>c.id===root.connection):undefined;return {id:root.id,name:root.name,path:root.root,runtimeName:connection?.name??os.hostname(),hostName:connection?.host??os.hostname()};}
  if(operation==='activity-start'){
    const workspace=String(args.workspaceId),fingerprint=String(args.fingerprint),id=crypto.randomUUID();db().transaction(()=>{const gate=db().prepare('SELECT fingerprint,state FROM workspace_gates WHERE user_id=? AND workspace=?').get(user,workspace) as {fingerprint:string;state:string}|undefined;if(gate&&(gate.state!=='idle'||gate.fingerprint!==fingerprint))throw new DevError('Workspace configuration is changing or conflicts with this run. Reload before starting.',409);db().prepare("INSERT OR IGNORE INTO workspace_gates(user_id,workspace,fingerprint,state) VALUES(?,?,?,'idle')").run(user,workspace,fingerprint);db().prepare('INSERT INTO workspace_runs VALUES(?,?,?,?,?,?)').run(id,user,workspace,String(args.consumerWardId),String(args.runOwnerRuntimeId),fingerprint);})();return {id};
  }
  if(operation==='activity-end'){db().prepare('DELETE FROM workspace_runs WHERE id=? AND user_id=?').run(String(args.id),user);return {ok:true};}
  if(operation==='activity-list')return db().prepare('SELECT * FROM workspace_runs WHERE user_id=? AND workspace=?').all(user,String(args.workspaceId));
  if(operation==='gate-prepare'){
    const workspace=String(args.workspaceId),token=crypto.randomUUID();db().transaction(()=>{if(db().prepare('SELECT 1 FROM workspace_runs WHERE user_id=? AND workspace=?').get(user,workspace))throw new DevError('A workspace run is still active or its stop has not been confirmed.',409);const gate=db().prepare('SELECT state,fingerprint FROM workspace_gates WHERE user_id=? AND workspace=?').get(user,workspace) as {state:string;fingerprint:string}|undefined;if(gate?.state==='changing')throw new DevError('Another workspace configuration change needs reconciliation.',409);if(gate&&gate.fingerprint!==String(args.fingerprint))throw new DevError('Workspace authority has a different definition; resolve the configuration conflict before editing.',409);db().prepare("INSERT INTO workspace_gates(user_id,workspace,fingerprint,token,state) VALUES(?,?,?,?,'changing') ON CONFLICT(user_id,workspace) DO UPDATE SET token=excluded.token,state='changing'").run(user,workspace,String(args.fingerprint),token);})();return {token};
  }
  if(operation==='gate-finish'){const changed=db().prepare("UPDATE workspace_gates SET fingerprint=?,state='idle',token=NULL WHERE user_id=? AND workspace=? AND token=?").run(String(args.fingerprint),user,String(args.workspaceId),String(args.token));if(!changed.changes&&!db().prepare("SELECT 1 FROM workspace_gates WHERE user_id=? AND workspace=? AND fingerprint=? AND state='idle'").get(user,String(args.workspaceId),String(args.fingerprint)))throw new DevError('Workspace gate changed; reconcile configuration before retrying.',409);return {ok:true};}
  if(operation==='gate-status')return db().prepare('SELECT state,fingerprint FROM workspace_gates WHERE user_id=? AND workspace=?').get(user,String(args.workspaceId))??null;
  if(operation==='view'){if(args.value!==undefined){const value=JSON.stringify(args.value);if(value.length>16384)throw new DevError('View state exceeds limit.');db().prepare('INSERT INTO ward_state VALUES(?,?,?) ON CONFLICT(user_id,ward) DO UPDATE SET json=excluded.json').run(user,String(args.ward),value);return {ok:true};}return JSON.parse((db().prepare('SELECT json FROM ward_state WHERE user_id=? AND ward=?').get(user,String(args.ward)) as {json:string}|undefined)?.json??'{}');}
  if(operation==='terminal-lease'){const changed=db().prepare("UPDATE terminal_sessions SET workspace_lease=? WHERE user_id=? AND project=? AND id=? AND (state='running' OR termination_reason='remote-process-unconfirmed')").run(JSON.stringify(args.lease),user,rootId,String(args.session));return {retained:!!changed.changes};}
  if(operation==='capabilities')return root.connection||isWorkspaceWorker()?{platform:root.connection?'ssh':process.platform,agents:{codex:false,claude:false},shells:['/bin/sh'],managedCli:false,note:'Run installed coding CLIs manually in a shell; managed hooks require a desktop runtime.'}:terminals.terminalCapabilities();
  if(operation==='buffer')return root.connection?remoteBuffer(user,root,file):readBuffer(user,rootId,relativePath(file));
  if(operation==='copies'){if(args.text!==undefined){if(typeof args.text!=='string'||Buffer.byteLength(args.text)>MAX_FILE)throw new DevError('Recovery copy exceeds limit.');db().prepare('INSERT INTO buffer_copies(user_id,project,path,text) VALUES(?,?,?,?)').run(user,rootId,relativePath(file),args.text);return {ok:true};}return bufferCopies(user,rootId,relativePath(file));}
  if(operation==='analyze'){if(root.connection)throw new DevError('Live analysis is unavailable on a plain SSH connection.');return analyzeFile(user,rootId,relativePath(file),args.text,args.format===true);}
  if(operation==='worktree'){if(root.connection)throw new DevError('Use the SSH terminal for Git worktrees.');return worktreeOp(user,rootId,args.operation==='remove'?'remove':'add',String(args.name));}
  if(operation==='stat')return rootStat(user,root,file);
  if(operation==='bytes')return {data:(await rootReadBytes(user,root,file)).toString('base64')};
  if(operation==='mutation-check'){
    const expected = args.expectedHash === null ? null : String(args.expectedHash);
    const bytes = args.deleting === true ? null : Buffer.from(String(args.data ?? ''), 'base64');
    if (!root.connection) {
      const checked = applyProjectBytes(user, root.id, owner, relativePath(file), bytes, expected, { prepare: true });
      return { ok: true, resources: 'resources' in checked ? checked.resources : [] };
    }
    const snapshot = await inspectSsh(user, root, file);
    if ((snapshot.raw ? hash(snapshot.raw) : null) !== expected) throw new DevError('Transfer source or destination changed.', 409);
    if (bytes && bytes.length > MAX_FILE) throw new DevError('Transfer file exceeds 5 MiB.');
    checkSshBuffers(user, root, snapshot, owner); await sshWriteSupport(user, root);
    return { ok: true, resources: [snapshot.resource] };
  }
  if(operation==='write-bytes'||operation==='remove')return journalByteMutation(user,root,operation,args,owner,signal);
  if(operation==='guard') {const dirty=db().prepare('SELECT 1 FROM buffers WHERE user_id=? AND project=? AND dirty=1').get(user,rootId);const active=db().prepare("SELECT 1 FROM terminal_sessions WHERE user_id=? AND project=? AND (state='running' OR termination_reason='remote-process-unconfirmed')").get(user,rootId);if(dirty||active)throw new DevError('Stop running sessions, reconcile unconfirmed remote processes, and resolve dirty buffers before changing the workspace.',409);return {ok:true};}
  if(operation==='mkdir'){if(root.connection){const {sftp,target}=await sshPath(user,root,file,true);await sftpCall<void>(cb=>sftp.mkdir(target,{mode:0o700},cb));}else await fs.mkdir(projectPath(user,rootId,relativePath(file),true),{recursive:args.recursive===true});return {ok:true};}
  if(operation==='rmdir'||operation==='chmod'||operation==='utimes'){
    if(!relativePath(file))throw new DevError('Cannot modify the mounted root.');
    if(root.connection){const {sftp,target}=await sshPath(user,root,file);if(operation==='rmdir')await sftpCall<void>(cb=>sftp.rmdir(target,cb));else if(operation==='chmod')await sftpCall<void>(cb=>sftp.chmod(target,Number(args.mode)&0o777,cb));else await sftpCall<void>(cb=>sftp.utimes(target,new Date(Number(args.atime)),new Date(Number(args.mtime)),cb));}
    else{const target=projectPath(user,rootId,relativePath(file));if(operation==='rmdir')await fs.rmdir(target);else if(operation==='chmod')await fs.chmod(target,Number(args.mode)&0o777);else await fs.utimes(target,new Date(Number(args.atime)),new Date(Number(args.mtime)));}return {ok:true};
  }
  if(operation==='tree'){
    if(!root.connection)return treePage(user,rootId,relativePath(file),Number(args.cursor)||0,String(args.virtualPrefix??''));
    const {sftp,target,relative}=await sshPath(user,root,file);const entries=await sftpCall<import('ssh2').FileEntryWithStats[]>(cb=>sftp.readdir(target,cb));
    const sorted=entries.filter(e=>e.filename!=='.git').map(e=>({name:e.filename,path:path.posix.join(relative,e.filename),directory:e.attrs.isDirectory(),bytes:e.attrs.size})).sort((a,b)=>a.name<b.name?-1:1),prefix=String(args.virtualPrefix??'');
    const page:typeof sorted=[];let next=Math.max(0,Math.floor(Number(args.cursor))||0),size=0;
    while(next<sorted.length){const entry=sorted[next];if(!entry)break;const bytes=JSON.stringify({...entry,path:prefix+entry.path}).length+1;if(size+bytes>(prefix?5000:9000)){if(!page.length)throw new DevError('Directory entry exceeds the page size.');break;}page.push(entry);size+=bytes;next++;}
    return {entries:page,total:sorted.length,complete:next>=sorted.length,...(next<sorted.length?{next}:{})};
  }
  if(operation==='read'){
    if(!root.connection)return readPage(user,rootId,relativePath(file),args.from,args.lines,args.column,args.version);
    return pageBuffer(await remoteBuffer(user,root,file),args.from,args.lines,args.column,args.version);
  }
  if(operation==='edit'){
    if(args.create===true&&args.revision===0){let exists=true;try{await rootStat(user,root,file);}catch(error){const e=error as {code?:number|string;status?:number};if(![2,'ENOENT',404].includes(e.code??e.status??''))throw error;exists=false;}if(!exists){await rootWriteBytes(user,root,file,Buffer.alloc(0),owner,null,undefined,signal);const created=root.connection?await remoteBuffer(user,root,file):readBuffer(user,rootId,relativePath(file));args={...args,revision:created.revision};}}
    if(!root.connection)return editBuffer(user,rootId,relativePath(file),owner,args as Parameters<typeof editBuffer>[4]);
    const snapshot=await inspectSsh(user,root,file);
    if(leaseOwner(snapshot.resource))throw new DevError('A prepared workspace mutation holds this SSH file.',409);
    const view=await remoteBuffer(user,root,file);
    if(args.text===undefined&&args.save!==true){claimLease(bufferKey(user,rootId,relativePath(file)),owner,args.takeover===true);return remoteBuffer(user,root,file);}
    if(view.readonly||view.conflict||(args.revision!==undefined&&args.revision!==view.revision)||(args.text!==undefined&&typeof args.text!=='string'))throw new DevError('Read the current writable buffer before editing.',409);
    claimLease(bufferKey(user,rootId,relativePath(file)),owner,args.takeover===true);
    if(args.save===true){await rootWriteBytes(user,root,file,encode(String(args.text??view.text),view.encoding,view.newline),owner,snapshot.raw ? hash(snapshot.raw) : null,view.revision,signal);return remoteBuffer(user,root,file);}
    if(Buffer.byteLength(String(args.text))>MAX_FILE)throw new DevError('Buffer exceeds 5 MiB.');
    db().prepare('UPDATE buffers SET text=?,dirty=1,revision=revision+1 WHERE user_id=? AND project=? AND path=?').run(args.text,user,rootId,relativePath(file));return remoteBuffer(user,root,file);
  }
  if(operation==='search'){
    if(!root.connection)return searchPage(user,rootId,String(args.query??args.q??''),relativePath(file),Number(args.cursor)||0,args.includeIgnored===true,String(args.virtualPrefix??''));
    const query=String(args.query??args.q??'').toLowerCase(),prefix=String(args.virtualPrefix??''),matches:{path:string;line:number;text:string}[]=[];if(!query.trim()||query.length>200)return {matches,complete:true,scanned:0};
    const pending=[relativePath(file)],cursor=Math.max(0,Math.floor(Number(args.cursor))||0);let scanned=0,position=0,size=0;
    const partial=(next:number)=>({matches,complete:false,next,scanned,scope:{source:'ssh-filesystem'},hint:'Continue with cursor while files are unchanged. SSH traversal excludes .git and, unless requested, hidden and dependency/build folders.'});
    while(pending.length){signal?.throwIfAborted();const next=pending.pop();if(next===undefined)break;const st=await rootStat(user,root,next);
      if(st.isDirectory){if(position++>=cursor&&scanned++>=10000)return partial(position-1);let pageCursor:number|undefined=0;const entries:{path:string;name:string;directory:boolean}[]=[];do{const page=await rootOperation(user,rootId,'tree',{path:next,cursor:pageCursor},owner) as {entries:typeof entries;next?:number};entries.push(...page.entries);pageCursor=page.next;}while(pageCursor!==undefined);for(const e of entries.reverse())if(!e.directory||args.includeIgnored===true||(!e.name.startsWith('.')&&!['node_modules','dist','target'].includes(e.name)))pending.push(e.path);}
      else if(st.isFile){const decoded=st.size<=MAX_FILE?decode(await rootReadBytes(user,root,next)):undefined,candidates=[path.posix.basename(next),...(decoded&&!decoded.readonly?decoded.text.split('\n'):[])];for(let i=0;i<candidates.length;i++){if(position++<cursor)continue;const text=candidates[i]??'',hit=(i===0?prefix+next:text).toLowerCase().includes(query);const match={path:next,line:Math.max(1,i),text:text.slice(0,300)},bytes=hit?JSON.stringify({...match,path:prefix+next}).length+1:0;if(scanned>=10000||size+bytes>(prefix?6000:9000))return partial(position-1);scanned++;if(bytes){size+=bytes;matches.push(match);}}}
    }
    return {matches,complete:true,scanned,scope:{source:'ssh-filesystem'}};
  }
  if(operation==='git'){
    if(!root.connection)return gitView(user,rootId,file||undefined,9000,Number(args.cursor)||0);
    const {target}=await sshPath(user,root,'');if(file)await sshPath(user,root,file,true);
    const execute=(argv:string[])=>sshExec(user,root.connection,`cd ${shellQuote(target)} && git --no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null ${argv.map(shellQuote).join(' ')}`,signal);
    const checked=async(argv:string[])=>{const result=await execute(argv);if(result.exitCode!==0)throw new DevError(result.exitCode===null?'SSH Git exit status is unconfirmed.':result.stderr.trim().slice(0,500)||'SSH Git command failed.',result.exitCode===null?502:409);return result.stdout;};
    if((await checked(['rev-parse','--is-inside-work-tree'])).trim()!=='true')throw new DevError('This workspace folder is not a Git worktree.',409);
    const head=await execute(['rev-parse','--verify','HEAD']);if(head.exitCode===null)throw new DevError('SSH Git HEAD verification is unconfirmed.',502);
    const scope=file?[relativePath(file)]:[];
    const result={status:await checked(['status','--short']),diff:await checked(['--literal-pathspecs','diff','--no-ext-diff','--no-textconv',head.exitCode===0?'HEAD':'--cached','--',...scope]),worktrees:await checked(['worktree','list','--porcelain'])};
    return pageGitView(result,9000,Number(args.cursor)||0);
  }
  if(operation==='patch-prepare'){
    return prepareRootPatch(user,root,args,owner,signal);
  }
  if(operation==='patch-status')return patchStatus(user,root,String(args.operationId),args.cursor === undefined ? 0 : Number(args.cursor));
  if(operation==='patch-recent'){
    const rows=db().prepare("SELECT receipt,state,updated FROM workspace_operations WHERE user_id=? AND json_extract(receipt,'$.rootId')=? ORDER BY updated DESC LIMIT 10").all(user,root.id) as {receipt:string;state:string;updated:number}[];
    return {recent:rows.map(row=>{const value=JSON.parse(row.receipt);return {operationId:value.operationId,rootId:root.id,state:row.state==='running'?'uncertain':row.state,updated:row.updated,paths:(value.paths??(value.path?[value.path]:value.applied?.map((p:{path:string})=>p.path)??[])).slice(0,3)};})};
  }
  if(operation==='patch-renew'){
    if(!preparations.has(String(args.planId))){
      const prior=db().prepare("SELECT fingerprint FROM workspace_operations WHERE id=? AND user_id=? AND state='completed'").get(String(args.planId),user) as {fingerprint:string}|undefined;
      if(prior){const identity=JSON.parse(prior.fingerprint);if(identity.owner===owner&&identity.root===root.root&&identity.connection===root.connection)return {ok:true,completed:true};}
    }
    const plan=admittedPatch(user,root,args,owner);plan.expires=Date.now()+PATCH_TTL;
    for(const key of plan.resources)claimLease(key,`patch:${plan.planId}`,false,PATCH_TTL);
    return {ok:true,expiresAt:plan.expires};
  }
  if(operation==='patch-release'){
    const plan=preparations.get(String(args.planId));
    if(plan){
      if(plan.user!==user||plan.root!==rootId||plan.owner!==owner)throw new DevError('Not your patch preparation.',403);
      const row=db().prepare('SELECT state FROM workspace_operations WHERE id=?').get(plan.planId) as {state:string}|undefined;
      if(row?.state==='running')return {ok:false,uncertain:true,operationId:plan.operationId,note:'Commit is still running; no cancellation or replay was attempted.'};
      savePatchReceipt(plan,'cancelled',{ok:false,notRun:true,applied:[],baseHashes:plan.hashes});releasePatch(plan);
    }
    return {ok:true};
  }
  if(operation==='patch-commit')return commitRootPatch(user,root,args,owner,signal);
  if(operation.startsWith('terminal-'))return rootTerminal(user,root,operation,args,owner,signal);
  throw new DevError(`Unsupported workspace operation: ${operation}`);
}
async function rootTerminal(user:number,root:WorkspaceRoot,operation:string,args:Record<string,unknown>,owner:string,signal?:AbortSignal) {
  const id=String(args.session??args.id??'');
  if(typeof args.scopeWard==='string'){const proof=await rootOperation(user,root.id,'terminal-placement-read',{session:id,ward:args.scopeWard},owner,signal) as {originWard:string;associated:boolean};if(proof.originWard!==args.scopeWard&&!proof.associated)throw new DevError('Terminal is not associated with this ward.',403);}
  if(operation==='terminal-list')return {sessions:terminals.listSessions(user,root.id)};
  if(operation==='terminal-resources')return terminals.sessionResources(user,root.id,args.history===true||args.history==='true');
  if(operation==='terminal-start'||operation==='terminal-exec'){
    if(isWorkspaceWorker()&&args.kind&&args.kind!=='shell')throw new DevError('Managed CLI hooks are unavailable on this worker. Run the installed CLI manually in a shell.');
    let transport:TerminalTransport|undefined;const cwd=String(args.path??'');
    if(root.connection){if(args.kind&&args.kind!=='shell')throw new DevError('Managed CLI hooks require a Rimeward runtime. Start the installed CLI in an SSH shell instead.');const {client}=await sshSession(user,root.connection),{target}=await sshPath(user,root,cwd);
      const channel=await new Promise<import('ssh2').ClientChannel>((resolve,reject)=>client.exec(`cd ${shellQuote(target)} && ${operation==='terminal-exec'?`exec /bin/sh -lc ${shellQuote(String(args.command))}`:`exec "\${SHELL:-/bin/sh}" -l`}`,{pty:{term:'xterm-256color',cols:Number(args.cols)||100,rows:Number(args.rows)||30}},(e,c)=>e?reject(e):resolve(c)));
      channel.setEncoding('utf8');channel.on('error',()=>{});transport={pid:0,onData:listener=>{channel.on('data',listener);return{dispose:()=>channel.off('data',listener)};},onExit:listener=>{const fn=(code:number|undefined)=>listener({exitCode:code??Number.NaN});channel.once('close',fn);return{dispose:()=>channel.off('close',fn)};},write:data=>{channel.write(data);},resize:(cols,rows)=>channel.setWindow(rows,cols,0,0),kill:s=>{channel.signal((s??'TERM').replace(/^SIG/,''));channel.close();},pause:()=>{channel.pause();},resume:()=>{channel.resume();}};
    }
    const session=await terminals.startSession(user,{...args,...(!args.origin&&typeof args.ward==='string'?{origin:{ward:args.ward}}:{}),project:root.id,nativeCwd:root.connection?undefined:projectPath(user,root.id,relativePath(cwd)),transport,...(operation==='terminal-exec'?{command:String(args.command)}:{})} as Parameters<typeof terminals.startSession>[1]);
    db().prepare('UPDATE terminal_sessions SET owner_runtime=?,workspace_json=?,virtual_cwd=? WHERE id=? AND user_id=?').run(String(args.ownerRuntimeId??''),args.workspace?JSON.stringify(args.workspace):'',String(args.virtualCwd??'/'),session.id,user);
    return session;
  }
  const current=terminals.readSession(user,id,undefined,false);if(current.session.project!==root.id)throw new DevError('Terminal is outside the bound workspace.',403);
  if(operation==='terminal-task'){
    if(typeof args.review!=='string'||!args.review.trim()||!['needs-attention','done','cancelled'].includes(String(args.state)))throw new DevError('Provide review evidence and a valid task state.');
    if(!Array.isArray(args.files)||args.files.length>100||args.files.some(f=>typeof f!=='string'))throw new DevError('List up to 100 reviewed files.');
    if(!Array.isArray(args.checks)||args.checks.length>30||args.checks.some(c=>!c||typeof c.command!=='string'||c.command.length>1000||!(c.exitCode===null||Number.isInteger(c.exitCode))))throw new DevError('Provide observed checks or an empty list.');
    const files=await Promise.all(args.files.map(async file=>{let digest:string|null=null;try{digest=hash(await rootReadBytes(user,root,file));}catch(error){const e=error as {status?:number;code?:number|string};if(![404,2,'ENOENT'].includes(e.status??e.code??''))throw error;}return {path:file,hash:digest};}));
    const changes=await rootOperation(user,root.id,'git',{},owner,signal).catch(()=>null) as {snapshot?:string}|null;
    const evidence={reviewer:owner,at:new Date().toISOString(),sequence:current.session.sequence,diff:changes?.snapshot??null,files,checks:args.checks.map(c=>({command:c.command,exitCode:c.exitCode}))};
    db().prepare('INSERT INTO task_receipts VALUES(?,?) ON CONFLICT(session) DO UPDATE SET json=excluded.json').run(id,JSON.stringify(evidence));
    terminals.configureSession(user,id,{taskState:args.state as 'done'|'needs-attention'|'cancelled',review:args.review});
    return {session:id,taskState:args.state,reviewSaved:true,reviewer:owner,at:evidence.at,sequence:evidence.sequence,diff:evidence.diff,files:files.length,checks:args.checks.length};
  }
  if(operation==='terminal-answer'||operation==='terminal-decide'){
    if(root.connection)throw new DevError('Managed CLI hooks require a Rimeward runtime.');const bridge=await import('./cli-bridge.ts');
    if(operation==='terminal-answer'){if(!bridge.answerCli(user,id,String(args.question),String(args.answer)))throw new DevError('No such open CLI question.');return {answered:true,question:args.question};}
    if(!['allow','deny'].includes(String(args.decision))||!bridge.decideCli(user,id,String(args.request),args.decision as 'allow'|'deny',typeof args.reason==='string'?args.reason:undefined))throw new DevError('No such pending permission request.');return {decided:args.decision,request:args.request};
  }
  if((operation==='terminal-read'||operation==='terminal-wait')&&owner.startsWith('agent:')){
    const read=operation==='terminal-wait'?await terminals.waitSession(user,id,Number(args.after)||0,Number(args.milliseconds??args.ms)||20000,false,signal):terminals.readSession(user,id,args.after===undefined?undefined:Number(args.after),args.review===true);
    if(args.review===true){const all=JSON.stringify({review:read.session.review,evidence:read.session.evidence}),cursor=Math.max(0,Math.floor(Number(args.cursor))||0);let text=all.slice(cursor,cursor+9000);while(JSON.stringify(text).length>9000)text=text.slice(0,Math.floor(text.length*0.8));const next=cursor+text.length;return {text,snapshot:hash(Buffer.from(all)),complete:next>=all.length,...(next<all.length?{next}:{})};}
    const commandInput=operation==='terminal-read'?terminals.commandObservation(user,id,owner):undefined;
    const {data,...rest}=read;return args.raw===true?{...read,commandInput}:{...rest,commandInput,rawChars:data.length,...(rest.screen===''&&data?{screen:stripVTControlCharacters(data).replace(/\r\n?/g,'\n').trimEnd().slice(-8000),snapshot:true}:{})};
  }
  if(operation==='terminal-command')return terminals.commandSession(user,id,owner,String(args.observation??''),String(args.command??''),signal);
  if(operation==='terminal-reconcile')return terminals.reconcileSession(user,id,owner,args.confirmedStopped);
  switch(operation){case'terminal-read':return terminals.readSession(user,id,Number(args.after)||undefined,false);case'terminal-wait':return terminals.waitSession(user,id,Number(args.after)||0,Number(args.ms)||20000,false,signal);case'terminal-input':return terminals.inputSession(user,id,owner,String(args.text??args.data??''),args.send!==false,signal);case'terminal-write':terminals.writeSession(user,id,owner,String(args.data??''),args.binary===true);return {ok:true};case'terminal-interrupt':return terminals.interruptSession(user,id,owner);case'terminal-stop':return terminals.closeSession(user,id);case'terminal-configure':return terminals.configureSession(user,id,args as Parameters<typeof terminals.configureSession>[2]);case'terminal-resize':return terminals.resizeSession(user,id,owner,Number(args.cols),Number(args.rows));case'terminal-control':return terminals.controlSession(user,id,owner,args.takeover===true);case'terminal-release':return terminals.releaseControl(user,id,owner);case'terminal-delete':return terminals.deleteSession(user,id);case'terminal-restart':if(root.connection)throw new DevError('Start a new SSH session; disconnected commands are never replayed.');return terminals.restartSession(user,id);default:throw new DevError('Unsupported terminal operation.');}
}
