import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { IFileSystem, FileContent, BufferEncoding } from 'just-bash';
import { workspacePath, resolveWorkspacePath, type WorkspaceBinding } from './workspace-contract.ts';
import { assertWorkspaceBinding, workspaceOperation } from './workspaces.ts';

/** Every interpreter file operation uses the same routing, leases and recovery as editing tools. */
export async function workspaceFileSystem(user:number,binding:WorkspaceBinding,owner:string,signal?:AbortSignal,mayMutate?:()=>boolean):Promise<IFileSystem> {
  await assertWorkspaceBinding(user,binding);
  const {agentWardConfig}=await import('../agent/ward-config.ts');
  const run=(operation:string,args:Record<string,unknown>)=>{if(!['bytes','stat','tree'].includes(operation)&&(mayMutate?.()===false||(owner.startsWith('agent:')&&agentWardConfig(user,binding.consumerWardId)?.tools==='read-only')))throw Error('This run is read-only; workspace files were not changed.');return workspaceOperation(user,binding,operation,args,owner,signal);};
  const read=async(file:string)=>Buffer.from((await run('bytes',{path:file})).data,'base64');
  const write=async(file:string,content:FileContent,options?:{encoding?:BufferEncoding}|BufferEncoding)=>{
    const encoding=typeof options==='string'?options:options?.encoding;
    const bytes=typeof content==='string'?Buffer.from(content,(encoding??'utf8') as globalThis.BufferEncoding):Buffer.from(content);
    let before:Buffer|null=null;try{before=await read(file);}catch(e){const error=e as {status?:number;code?:string|number};if(![404,2,'ENOENT'].includes(error.status??error.code??''))throw e;}
    await run('write-bytes',{path:file,data:bytes.toString('base64'),expectedHash:before?createHash('sha256').update(before).digest('hex'):null});
  };
  const unsupported=async()=>{throw Error('This workspace filesystem does not create links; use the native terminal when links are required.');};
  const filesystem:IFileSystem={
    readFile:async(file,options)=>{const encoding=typeof options==='string'?options:options?.encoding;return (await read(file)).toString((encoding??'utf8') as globalThis.BufferEncoding);},
    readFileBuffer:read,writeFile:write,
    appendFile:async(file,content,options)=>{let before:Buffer|null=null;try{before=await read(file);}catch(e){const error=e as {status?:number;code?:string|number};if(![404,2,'ENOENT'].includes(error.status??error.code??''))throw e;}const encoding=typeof options==='string'?options:options?.encoding;const bytes=Buffer.concat([before??Buffer.alloc(0),typeof content==='string'?Buffer.from(content,(encoding??'utf8') as globalThis.BufferEncoding):Buffer.from(content)]);await run('write-bytes',{path:file,data:bytes.toString('base64'),expectedHash:before?createHash('sha256').update(before).digest('hex'):null});},
    exists:async file=>{try{await run('stat',{path:file});return true;}catch(e){const error=e as {status?:number;code?:string|number};if([404,2,'ENOENT'].includes(error.status??error.code??''))return false;throw e;}},
    stat:async file=>{const stat=await run('stat',{path:file});return {...stat,mtime:new Date(stat.mtime)};},
    lstat:async file=>filesystem.stat(file),
    mkdir:async(file,options)=>{await run('mkdir',{path:file,recursive:options?.recursive});},
    readdir:async file=>{const entries:string[]=[];let cursor:number|undefined=0;do{const page=await run('tree',{path:file,cursor});entries.push(...page.entries.map((e:{name:string})=>e.name));cursor=page.next;}while(cursor!==undefined);return [...new Set(entries)];},
    rm:async(file,options)=>{if(!resolveWorkspacePath(binding,file,binding.cwd).relativePath)throw Error('Cannot delete a mounted workspace root.');try{const stat=await filesystem.stat(file);if(stat.isDirectory){const entries=await filesystem.readdir(file);if(entries.length&&!options?.recursive)throw Error('Directory is not empty.');for(const entry of entries)await filesystem.rm(workspacePath(entry,file),options);await run('rmdir',{path:file});}else await run('remove',{path:file});}catch(e){const error=e as {status?:number;code?:number|string};if(options?.force&&[404,2,'ENOENT'].includes(error.status??error.code??''))return;throw e;}},
    cp:async(source,destination,options)=>{const stat=await filesystem.stat(source);if(stat.isDirectory){if(!options?.recursive)throw Error('Copying a directory requires recursive mode.');const from=workspacePath(source,binding.cwd),to=workspacePath(destination,binding.cwd);if(to===from||to.startsWith(`${from.replace(/\/$/,'')}/`))throw Error('Cannot copy a directory inside itself.');const directories:string[]=[],files:{source:string;destination:string}[]=[],seen=new Set<string>();let count=0;const collect=async(a:string,b:string):Promise<void>=>{if(++count>10000)throw Error('Directory copy exceeds 10000 entries; choose a narrower source.');const s=await filesystem.stat(a);if(s.isDirectory){const identity=String(s.identity??a);if(seen.has(identity))return;seen.add(identity);directories.push(b);for(const child of await filesystem.readdir(a))await collect(workspacePath(child,a),workspacePath(child,b));}else files.push({source:a,destination:b});};await collect(from,to);for(const directory of directories)await filesystem.mkdir(directory,{recursive:true});for(const file of files){const result=await run('transfer',{...file,mode:'copy'});if(!result.ok)throw Error(result.error);}}else{const result=await run('transfer',{source,destination,mode:'copy'});if(!result.ok)throw Error(result.error);}},
    mv:async(source,destination)=>{const result=await run('transfer',{source,destination,mode:'move'});if(!result.ok)throw Error(result.error);},
    resolvePath:(base,file)=>workspacePath(file,base),
    getAllPaths:()=>[],chmod:async(file,mode)=>{await run('chmod',{path:file,mode});},symlink:unsupported,link:unsupported,readlink:unsupported,
    realpath:async file=>{await filesystem.stat(file);return workspacePath(file,binding.cwd);},utimes:async(file,atime,mtime)=>{await run('utimes',{path:file,atime:atime.getTime(),mtime:mtime.getTime()});},
  };
  return filesystem;
}
