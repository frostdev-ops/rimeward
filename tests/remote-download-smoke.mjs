// Runs inside the existing isolated browser smoke session; all bytes are generated.
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';
export async function remoteDownloadSmoke(page) {
  const source = stripTypeScriptTypes(fs.readFileSync('src/scripts/app/remote-download-worker.ts', 'utf8'));
  await page.route('**/rimeward-download-worker-test.js', route => route.fulfill({ contentType: 'text/javascript', body: source }));
  const result = await page.evaluate(async () => {
    const worker = new Worker('/rimeward-download-worker-test.js', { type: 'module' });
    const call = body => new Promise((resolve, reject) => {
      worker.onmessage = event => event.data.error ? reject(Error(event.data.error)) : resolve(event.data.result);
      worker.onerror = event => reject(Error(event.message)); worker.postMessage(body);
    });
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const id = 'a'.repeat(32), bytes = new Uint8Array(4194304); bytes.fill(23);
    let record = { id, device: 'fixture', root: '/fixture', path: 'generated.bin', source: 'fixture', size: bytes.length + 3, offset: 0, digest: await hash(new Uint8Array()), chunks: [], complete: false };
    try {
      await call({ command: 'create', record });
      record = { ...record, offset: bytes.length, digest: await hash(bytes), chunks: [await hash(bytes)] };
      await call({ command: 'append', record, bytes: bytes.buffer });
      const verified = await call({ command: 'verify', id });
      if (verified.offset !== bytes.length || verified.digest !== record.digest) throw Error('Checkpoint was not preserved');
      // A disk write whose metadata commit did not arrive must not advance the resume point.
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('rimeward-downloads');
      const file = await directory.getFileHandle(`${id}.part`), writer = await file.createWritable({ keepExistingData: true });
      await writer.seek(bytes.length); await writer.write(new Uint8Array([1, 2, 3])); await writer.close();
      if ((await call({ command: 'verify', id })).offset !== bytes.length) throw Error('Uncommitted bytes were trusted');
      record = { ...record, offset: record.size, chunks: [...record.chunks, await hash(new Uint8Array([7, 8, 9]))] };
      await call({ command: 'append', record, bytes: new Uint8Array([7, 8, 9]).buffer });
      await call({ command: 'verify', id });
      const data = new Uint8Array(await (await file.getFile()).slice(-3).arrayBuffer());
      if (data.join() !== '7,8,9') throw Error('Resume duplicated the uncertain chunk');
      const corrupt = await file.createWritable({ keepExistingData: true }); await corrupt.write(new Uint8Array([99])); await corrupt.close();
      let rejected = false;
      try { await call({ command: 'verify', id }); } catch { rejected = true; }
      if (!rejected) throw Error('Changed destination accepted');
      await call({ command: 'remove', id });
      if ((await call({ command: 'list', device: 'fixture' })).length) throw Error('Cancelled bytes retained');
      try { await call({ command: 'remove', id: '../escape' }); return false; } catch { return true; }
    } finally { await call({ command: 'remove', id }).catch(() => {}); worker.terminate(); }
  });
  assert.equal(result, true);
  await page.unroute('**/rimeward-download-worker-test.js');
}

export async function remoteFolderDownloadSmoke(page) {
  for (const name of ['remote-files.ts', 'dom.ts', 'remote-download-worker.ts']) {
    const source = stripTypeScriptTypes(fs.readFileSync(`src/scripts/app/${name}`, 'utf8'));
    await page.route(`**/rimeward-file-fixture/${name}`, route => route.fulfill({ contentType: 'text/javascript', body: source }));
  }
  const result = await page.evaluate(async () => {
    const { remoteFiles } = await import('/rimeward-file-fixture/remote-files.ts');
    const originalFetch = window.fetch, errors = [], size = 4194304;
    let interrupt = true, changed = false;
    window.fetch = (url, options) => {
      if (!String(url).includes('/sessions/folder-fixture/download/')) return originalFetch(url, options);
      let index = 0;
      return Promise.resolve(new Response(new ReadableStream({ pull(controller) {
        if (index++ === 0) { const bytes = new Uint8Array(size); bytes.fill(changed ? 22 : 21); controller.enqueue(bytes); }
        else if (interrupt) controller.error(Error('Generated transport interruption'));
        else if (index === 2) controller.enqueue(new Uint8Array([1, 2, 3]));
        else controller.close();
      } }, { highWaterMark: 0 })));
    };
    const files = remoteFiles(async body => Response.json(body.command === 'download-folder' ? { id: 'b'.repeat(32) } : body.command === 'recoveries' ? { transfers: [] } : {}), () => 'folder-fixture', () => 'folder-fixture-device', error => errors.push(error.message));
    document.body.append(files.panel); files.open(); files.panel.querySelector('input').value = '/generated';
    const button = text => [...files.panel.querySelectorAll('button')].find(b=>b.textContent === text);
    const until = async predicate => { const deadline=Date.now()+10000; while(!predicate()){if(Date.now()>deadline)throw Error('Folder fixture timed out');await new Promise(r=>setTimeout(r,20));} };
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('rimeward-downloads', {create:true});
    const records = async () => {
      const records=[]; for await(const file of directory.values()) if(file.name.endsWith('.json')) {const record=JSON.parse(await (await file.getFile()).text());if(record.device==='folder-fixture-device')records.push(record);}return records;
    };
    try {
      button('Download folder').click(); await until(()=>errors.length===1&&!files.active());
      let saved=await records(); if(saved.length!==1||saved[0].offset!==size||saved[0].complete)throw Error('Folder checkpoint missing');
      interrupt=false; button('Interrupted transfers').click(); await until(()=>button('Resume folder.tar'));
      button('Resume folder.tar').click(); await until(()=>!files.active()&&button('Save folder archive'));
      saved=await records(); if(!saved[0].complete||saved[0].size!==size+3)throw Error('Folder resume failed');
      const data=await (await directory.getFileHandle(`${saved[0].id}.part`)).getFile();
      if([...new Uint8Array(await data.slice(-3).arrayBuffer())].join()!=='1,2,3')throw Error('Folder resume duplicated bytes');
      interrupt=true; button('Download folder').click(); await until(()=>errors.length===2&&!files.active());
      changed=true; interrupt=false; button('Interrupted transfers').click(); await until(()=>button('Resume folder.tar'));
      button('Resume folder.tar').click(); await until(()=>errors.length===3&&!files.active());
      if(!errors[2].includes('source folder changed'))throw Error('Changed folder accepted');
      saved=await records(); if(saved.find(r=>!r.complete)?.offset!==size)throw Error('Changed source overwrote saved bytes');
      return true;
    } finally {
      window.fetch=originalFetch; files.stop(); files.panel.remove();
      for(const record of await records()){await directory.removeEntry(`${record.id}.part`);await directory.removeEntry(`${record.id}.json`);}
    }
  });
  assert.equal(result, true);
  // Same metadata and first/last chunks cannot authorize a changed middle prefix.
  assert.equal(await page.evaluate(async () => {
    const { remoteFiles } = await import('/rimeward-file-fixture/remote-files.ts');
    const size=4194304, original=new Uint8Array(size).fill(42), changed=new Uint8Array(size).fill(99);
    const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
    const sha=await hash(original), source=`generated.bin:${size*3}:1:${sha}:${sha}`;
    let file=new File([original,changed,original],'generated.bin',{lastModified:1}), verified=0, cancelValidation=false;
    const calls=[],errors=[],click=HTMLInputElement.prototype.click;
    const files=remoteFiles(async body=>{
      calls.push(body.command);
      if(body.command==='recoveries')return Response.json({transfers:[{id:'c'.repeat(32),root:'/fixture',path:'generated.bin',upload:true,offset:size*2,size:size*3,source}]});
      if(body.command==='resume'){verified=0;return Response.json({id:'c'.repeat(32),offset:size*2,validating:true});}
      if(body.command==='validate'){
        verified+=size;
        if(cancelValidation)[...files.panel.querySelectorAll('button')].find(b=>b.textContent==='Cancel')?.click();
        return Response.json({verified,validating:verified<size*2,chunkSha256:sha});
      }
      return Response.json(body.command==='chunk'?{offset:size*3}:body.command==='browse'?{entries:[]}:{});
    },()=> 'upload-fixture',()=> 'upload-fixture-device',error=>errors.push(error.message));
    HTMLInputElement.prototype.click=function(){if(this.type!=='file')return click.call(this);Object.defineProperty(this,'files',{value:[file]});this.dispatchEvent(new Event('change'));};
    document.body.append(files.panel);files.open();
    const button=text=>[...files.panel.querySelectorAll('button')].find(b=>b.textContent===text);
    const until=async predicate=>{const deadline=Date.now()+10000;while(!predicate()){if(Date.now()>deadline)throw Error('Upload fixture timed out');await new Promise(r=>setTimeout(r,20));}};
    try{
      button('Interrupted transfers').click();await until(()=>button('Resume generated.bin · 67%'));
      button('Resume generated.bin · 67%').click();await until(()=>errors.length===1&&!files.active());
      if(!errors[0].includes('source prefix changed')||calls.includes('chunk')||calls.includes('finalize')||!calls.includes('pause'))throw Error('Changed upload prefix accepted');
      file=new File([original,original,original],'generated.bin',{lastModified:1});
      button('Resume generated.bin · 67%').click();await until(()=>!files.active());
      if(!calls.includes('finalize')||errors.length!==1)throw Error('Matching upload prefix refused');
      cancelValidation=true;button('Resume generated.bin · 67%').click();await until(()=>!files.active());
      if(!calls.includes('cancel'))throw Error('Validation ignored cancellation');
      return true;
    }finally{HTMLInputElement.prototype.click=click;files.stop();files.panel.remove();}
  }),true);
  for (const name of ['remote-files.ts', 'dom.ts', 'remote-download-worker.ts']) await page.unroute(`**/rimeward-file-fixture/${name}`);
}
