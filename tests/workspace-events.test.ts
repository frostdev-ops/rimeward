import './_setup.ts';
import { test,after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rootEvents } from '../src/lib/dev/workspace-events.ts';
import { addProject } from '../src/lib/dev/projects.ts';
import { emitDev,workDb } from '../src/lib/dev/runtime.ts';
import { localOwner } from '../src/lib/dev/native.ts';

process.env.RIMEWARD_DESKTOP='1';process.env.RIMEWARD_NATIVE_TOKEN='event-fixture-only';
const folder=fs.mkdtempSync('/tmp/rime-workspace-events-');after(()=>fs.rmSync(folder,{recursive:true,force:true}));
const user=localOwner(),project=addProject(user,folder);
const timeouts=()=>process.getActiveResourcesInfo().filter(resource=>resource==='Timeout').length;
test('workspace event streams filter sessions and dispose heartbeat resources on cancellation',async()=>{
  workDb().prepare("INSERT INTO terminal_sessions(id,user_id,project,kind,mode,title,state) VALUES(?,?,?,'shell','approvals','Fixture','exited')").run('event-session',user,project.id);
  const before=timeouts(),response=rootEvents(user,[project.id]),reader=response.body?.getReader();assert.ok(reader);
  assert.match(new TextDecoder().decode((await reader.read()).value),/"type":"reset"/);
  emitDev(user,'session','foreign-session',{unexpected:true});
  emitDev(user,'session','event-session',{expected:true});
  const event=new TextDecoder().decode((await reader.read()).value);assert.match(event,/"expected":true/);assert.doesNotMatch(event,/unexpected/);
  await reader.cancel();reader.releaseLock();assert.ok(timeouts()<=before,'consumer cancellation clears the source heartbeat interval');
});
test('aborting a workspace event source closes its reader without replaying events',async()=>{
  const abort=new AbortController(),reader=rootEvents(user,[project.id],abort.signal).body?.getReader();assert.ok(reader);await reader.read();abort.abort();assert.equal((await reader.read()).done,true);reader.releaseLock();
});
