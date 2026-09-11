// Package pinned llama.cpp; weights are downloaded into application storage during setup.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here,'embedding-runtime.json'),'utf8'));
const target = manifest.targets[`${process.platform}-${process.arch}`];
if (!target) throw Error('No pinned llama.cpp build for this platform.');
const destination = process.argv[2] ?? path.join(here,'runtime/app/assets/embedding');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'rimeward-embedding-'));
try {
  const response = await fetch(target.url); if (!response.ok) throw Error(`llama.cpp download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== target.sha256) throw Error('llama.cpp archive checksum mismatch.');
  const archive = path.join(temporary,target.url.endsWith('.zip') ? 'runtime.zip' : 'runtime.tar.gz'); fs.writeFileSync(archive,bytes);
  const extracted = path.join(temporary,'extracted'); fs.mkdirSync(extracted);
  if (process.platform === 'win32') execFileSync('powershell',['-NoProfile','-Command','Expand-Archive','-LiteralPath',archive,'-DestinationPath',extracted]);
  else execFileSync('tar',['-xzf',archive,'-C',extracted]);
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  function find(dir) { for (const e of fs.readdirSync(dir,{ withFileTypes:true })) { const file = path.join(dir,e.name); if (e.isFile() && e.name === name) return file; if (e.isDirectory()) { const result = find(file); if (result) return result; } } }
  const binary = find(extracted); if (!binary) throw Error('Pinned archive did not contain llama-server.');
  fs.rmSync(destination,{ recursive:true,force:true });
  fs.cpSync(path.dirname(binary),destination,{ recursive:true,verbatimSymlinks:true });
  const libraries = path.join(path.dirname(path.dirname(binary)),'lib');
  if (fs.existsSync(libraries)) fs.cpSync(libraries,path.join(path.dirname(destination),'lib'),{ recursive:true,verbatimSymlinks:true });
  fs.writeFileSync(path.join(destination,'rimeward-manifest.json'),JSON.stringify({ version:manifest.version,...target },null,2));
  execFileSync(path.join(destination,name),['--version'],{ stdio:'inherit' });
} finally { fs.rmSync(temporary,{ recursive:true,force:true }); }
