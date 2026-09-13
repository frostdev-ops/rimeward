// Run once by the server administrator. Does not deploy or start the ordinary application.
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.platform!=='linux'||process.getuid()!==0)throw Error('Run this setup as root on the Linux server.');
const [uid,gid]=process.argv.slice(2).map(Number);
if(!Number.isSafeInteger(uid)||uid<0||!Number.isSafeInteger(gid)||gid<0)throw Error('Usage: node ops/setup-workspace-workers.mjs <web service uid> <web service gid>');
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(/[\r\n"%]/.test(base+process.execPath))throw Error('Install Rimeward at a path without quotes, percent signs or newlines.');
await fs.mkdir('/usr/local/libexec/rimeward',{recursive:true,mode:0o755});
for(const directory of ['/usr','/usr/local','/usr/local/libexec','/usr/local/libexec/rimeward']){const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o022))throw Error('Supervisor installation parents must be root-owned and not writable by other users.');}
await fs.copyFile(process.execPath,'/usr/local/libexec/rimeward/node');await fs.chown('/usr/local/libexec/rimeward/node',0,0);await fs.chmod('/usr/local/libexec/rimeward/node',0o755);
await fs.copyFile(path.join(base,'ops/workspace-worker-supervisor.mjs'),'/usr/local/libexec/rimeward/workspace-worker-supervisor.mjs');
await fs.chown('/usr/local/libexec/rimeward/workspace-worker-supervisor.mjs',0,0);await fs.chmod('/usr/local/libexec/rimeward/workspace-worker-supervisor.mjs',0o644);
await fs.mkdir('/etc/rimeward',{recursive:true,mode:0o700});await fs.writeFile('/etc/rimeward/workspace-workers.json',JSON.stringify({webUid:uid,webGid:gid}),{mode:0o600});
const unit=`[Unit]\nDescription=Rimeward per-user workspace provisioning\nAfter=network.target\n\n[Service]\nType=simple\nUser=root\nGroup=root\nExecStart=/usr/local/libexec/rimeward/node /usr/local/libexec/rimeward/workspace-worker-supervisor.mjs\nRestart=on-failure\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`;
await fs.writeFile('/etc/systemd/system/rimeward-worker-supervisor.service',unit,{mode:0o644});
const worker=`[Unit]\nDescription=Rimeward workspace worker for account %i\nAfter=network.target\n\n[Service]\nType=simple\nUser=rimeward-u%i\nGroup=rimeward-u%i\nWorkingDirectory=/var/lib/rimeward/workers/u%i\nEnvironment=HOME=/var/lib/rimeward/workers/u%i USER=rimeward-u%i LOGNAME=rimeward-u%i PATH=/usr/local/bin:/usr/bin:/bin RIMEWARD_WORKER_ACCOUNT=%i\nUnsetEnvironment=RIMEWARD_DESKTOP RIMEWARD_NATIVE_TOKEN TOKEN_ENC_KEY HOMEPAGE_DATA_DIR\nLoadCredential=auth:/var/lib/rimeward/worker-tokens/u%i\nLoadCredential=encryption:/var/lib/rimeward/worker-tokens/u%i-encryption\nExecStart="${process.execPath}" "${base}/bin/workspace-worker.mjs"\nNoNewPrivileges=yes\nKillMode=control-group\nUMask=0077\n`;
await fs.writeFile('/etc/systemd/system/rimeward-workspace@.service',worker,{mode:0o644});
execFileSync('/usr/bin/systemctl',['daemon-reload']);execFileSync('/usr/bin/systemctl',['enable','--now','rimeward-worker-supervisor.service']);
