import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db.ts';
import { getDashboard, browserWard } from '../dashboard.ts';
import { isDesktop, subscribeDev } from '../dev/runtime.ts';
import { projectPath } from '../dev/projects.ts';
import { readSession, renderedLines } from '../dev/terminals.ts';
import { onNoteEvent } from '../note-events.ts';
import { readNote, plainText, getNoteMeta } from '../note.ts';
import { onObservation } from './observation-events.ts';
import { shellNetworkEnabled, vettedFetch } from './shell.ts';
import { isCommsType } from '../comms/types.ts';
import { TRIGGERS, wardTypes } from '../logic.ts';
// The CLI chrome grammar lives with the terminal lens source; this branch reads it unchanged.
import { cliKey, stableKey, terminalContent } from '../lens/terminal.ts';
import { SOURCES, lens } from '../lens/core.ts';
// The watch grammar is the lens's own (the tool schema in lens/tools.ts is the same fields).
import { parseWatchSpec } from '../lens/gate.ts';
import { DELIVERY_CAP, OBSERVATION_BANNER } from '../lens/types.ts';
import type { Rect, WatchSpec } from '../lens/types.ts';

export interface MonitorSource { type:'terminal'|'screen'|'file'|'browser'|'agent'|'note'|'notebook'|'http'|'comms'|'event';
  target?:string; project?:string; path?:string; url?:string; selector?:string; headers?:string[]; fields?:string[]; intervalSeconds?:number; event?:string;
  /** Lens sources only: deliveries are held until this watch hits. */
  watch?:WatchSpec }
type Emit = (key:string,data:Record<string,unknown>,baseline?:boolean) => void;
const hash = (v:unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const commonPrefix = (a:string,b:string) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
export function parseMonitorSource(raw:unknown): MonitorSource {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Monitor source is required.');
  const r = raw as Record<string,unknown>;
  if (!['terminal','screen','file','browser','agent','note','notebook','http','comms','event'].includes(String(r.type))) throw Error('Unsupported monitor source.');
  const out:MonitorSource = { type:r.type as MonitorSource['type'] };
  for (const field of ['target','project','path','url','selector','event'] as const) {
    if (r[field] !== undefined) { if (typeof r[field] !== 'string' || r[field].length > (field === 'url' ? 2000 : 500)) throw Error(`Invalid source ${field}.`); out[field] = r[field]; }
  }
  if (r.intervalSeconds !== undefined) {
    if (!Number.isSafeInteger(r.intervalSeconds) || Number(r.intervalSeconds) < 5 || Number(r.intervalSeconds) > 86400) throw Error('Polling interval must be 5–86400 seconds.');
    out.intervalSeconds = Number(r.intervalSeconds);
  }
  for (const field of ['headers','fields'] as const) if (r[field] !== undefined) {
    const values = r[field];
    if (!Array.isArray(values) || values.length > 20 || values.some(x => typeof x !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(x))) throw Error(`Select at most 20 response ${field}.`);
    out[field] = values;
  }
  // A watch is the whole grammar; `for`/`regex`/`rect`/`visual` beside the source are the
  // shorthand the tool schema documents for a screen. An explicit `watch` object wins.
  const shorthand = Object.fromEntries((['for','regex','rect','visual'] as const).filter(field => r[field] !== undefined).map(field => [field,r[field]]));
  if (r.watch !== undefined) out.watch = parseWatchSpec(r.watch,{ triage:false });
  else if (Object.keys(shorthand).length > 0) out.watch = parseWatchSpec(shorthand,{ triage:false });
  return out;
}
/** The `<type>:<target>` a lens-backed source reads. One screen per process, so a screen
 *  monitor names its lens ward (or nothing at all) and still reads `screen:local`. */
export const lensSourceId = (s:MonitorSource): string => s.type === 'screen' ? 'screen:local' : `${s.type}:${s.target ?? ''}`;
/** The lens watch a lens-backed source holds its deliveries behind. */
export function validateMonitorSource(user:number,s:MonitorSource): void {
  const layout = getDashboard(user);
  const ward = layout.find(w => w.i === s.target);
  switch (s.type) {
    case 'terminal': if (!isDesktop() || !s.target) throw Error('Terminal monitoring belongs on its desktop runtime.'); readSession(user,s.target,undefined,false); break;
    // One screen per runtime: the ward is what the user consented through, not a target to read.
    case 'screen': if (!isDesktop() || !SOURCES.screen || !(s.target ? ward?.type === 'lens' : layout.some(w => w.type === 'lens'))) throw Error('Screen monitoring belongs on the desktop that hosts the Screen lens ward.'); break;
    case 'file': if (!isDesktop() || !s.project) throw Error('File monitoring requires an owned project on this desktop.'); projectPath(user,s.project,s.path ?? '',true); break;
    case 'browser': if (!ward || ward.type !== 'browser') throw Error('Browser ward not found.'); break;
    case 'agent': if ((!ward || ward.type !== 'agent') && !getDb().prepare("SELECT 1 FROM agent_jobs WHERE id=? AND user_id=? AND tool='spawn_agent'").get(s.target ?? '',user)) throw Error('Agent or child task not found.'); break;
    case 'note': if (!getDb().prepare('SELECT 1 FROM notes WHERE user_id=? AND ward=? AND trashed_at IS NULL').get(user,s.target ?? '')) throw Error('Note not found.'); break;
    case 'notebook': if (!getDb().prepare('SELECT 1 FROM notebooks WHERE user_id=? AND id=?').get(user,s.target ?? '')) throw Error('Notebook not found.'); break;
    case 'http': {
      if (!shellNetworkEnabled(user)) throw Error('Network observation is disabled in this runtime’s agent settings.');
      const url = new URL(s.url ?? ''); if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw Error('Use an HTTP(S) URL without credentials.'); break;
    }
    case 'comms': if (!ward || ward.type === 'push' || (!isCommsType(ward.type) && ward.type !== 'mail')) throw Error('Inbound communication ward not found.'); break;
    case 'event': if (!ward || !s.event || !TRIGGERS[s.event] || !wardTypes(TRIGGERS[s.event]!).includes(ward.type)) throw Error('Choose a Leyline event supported by the source ward.'); break;
  }
}
function poll(fn:() => Promise<void>,ms:number,offline:(error:string) => void): () => void {
  let busy = false,closed = false;
  const tick = async () => { if (busy || closed) return; busy = true; try { await fn(); } catch (e) { if (!closed) offline(e instanceof Error ? e.message : String(e)); } finally { busy = false; } };
  const timer = setInterval(() => void tick(),ms).unref(); void tick();
  return () => { closed = true; clearInterval(timer); };
}
export async function connectMonitorSource(user:number,s:MonitorSource,emit:Emit,offline:(error:string) => void,readOnlyFetch:typeof vettedFetch = vettedFetch,consumer?:string): Promise<() => void> {
  validateMonitorSource(user,s);
  // A source with a lens (terminal today, screen next) delivers through its core:
  // versioned, settled, ack-gated, one delivery outstanding at a time. Only a caller
  // that named a consumer takes that door; every other call keeps the branches below.
  const source = lensSourceId(s);
  const core = consumer ? lens(user,source) : null;
  if (core && consumer) {
    const held = core.consumer(consumer,'monitor');
    await core.watch(consumer,{ remove:held.watches.map(w => w.id),...(s.watch ? { add:[s.watch] } : {}),...(s.intervalSeconds === undefined ? {} : { minIntervalS:s.intervalSeconds }) });
    // One baseline per connect, taken BEFORE anything can be delivered: it is what
    // gives the monitor's cursor a `previous` (a `changed` filter would otherwise fire
    // on the first delta after a monitor update reset that cursor, and would compare a
    // re-offered delivery against `{}`). Never acknowledged, so it moves nothing.
    const view = core.look(consumer,{ fields:['meta','text'] });
    const head = Object.entries(view.meta ?? {}).map(([key,field]) => `${key}=${field.value}`);
    const text = [OBSERVATION_BANNER,...head,...(view.lines ?? []).map(line => line.text)].join('\n').slice(0,DELIVERY_CAP);
    emit(`baseline:${randomUUID()}`,{ eventType:'baseline',text,v:view.v,epoch:view.epoch,source },true);
    const off = core.on('delivery',(id,d) => {
      if (id !== consumer) return;
      // A keyframe is a baseline only when it carries no observation of its own: the
      // consumer's first, or one forced because what it acknowledged is no longer in the
      // ring (a restart, 32 settles of silence). Every other keyframe — a session exit or
      // a resize, the one after a run of deltas, a truncated delta, gap recovery — is
      // something the monitor's filter has to see.
      emit(d.delivery,{ eventType:d.kind,text:d.text,v:d.v,epoch:d.epoch,delivery:d.delivery,source },
        d.kind === 'key' && (d.reason === 'first' || d.reason === 'evicted'));
    });
    // A delivery this consumer never acknowledged is still its next one: hand it over
    // again now that the listener is there, after the baseline rather than before it.
    if (held.delivered) core.look(consumer,{ fields:[] });
    // ponytail: stopping is dropping the listener. The core and the consumer row
    // outlive it on purpose — that is what an unacknowledged delivery survives.
    return off;
  }
  if (s.type === 'terminal') {
    const connection = randomUUID();
    const first = readSession(user,s.target!,undefined,false); emit(`baseline:${randomUUID()}`,{ eventType:'baseline',status:first.session.state,exitCode:first.session.exitCode },true);
    // Rendered rows, never raw bytes: by the time an output event fires the headless terminal has
    // applied the chunk, so rows are read back from it — the viewport plus exactly the rows the
    // chunk scrolled above it (xterm's scroll count). A row is new when its key was not in the
    // previous frame or on screen within the last 5 s. Recognized CLI chrome is discarded before
    // deduplication and a CLI row's key drops its per-second counters; clear-then-repaint content
    // is quiet, but repeated content later passes. A viewport row that is still being written —
    // the same screen row, its previous text edited at the tail (a prompt being typed, a line
    // streaming in) — is held until it has stood for 1.5 s or scrolled off, and dropped if it
    // vanished first. A last-row input is not submitted merely because typing paused.
    const cli = first.session.kind !== 'shell', keyOf = (line:string) => { const key = stableKey(line); return cli ? cliKey(key) : key; };
    // The prompt row is edited for as long as a person types; a streaming line settles within a beat.
    const prompt = (line:string) => /^❯\s/.test(stableKey(line));
    const initial = renderedLines(user,s.target!);
    let seen = new Map<string,number>(), scrolled = initial.scrolled, prevViewport:string[] = [], baselineUntil = 0;
    let size = `${first.session.cols}x${first.session.rows}`, announced = `${first.session.state}:${first.session.exitCode}`;
    const held = new Map<string,{ line:string; key:string; at:number; hold:number; order:number; first:number; position:number; draft:boolean }>();
    const fresh:{ line:string; key:string; order:number; position?:number }[] = []; let since = 0, sequence = 0, order = 0, timer:ReturnType<typeof setTimeout> | undefined;
    const queue = (row:{ line:string; key:string; order?:number; position?:number },now:number) => { if (!fresh.length) since = now; fresh.push({ ...row, order: row.order ?? ++order }); };
    const collect = (lines:string[],above:number,now:number,wrapped:boolean[],displacement=0) => {
      const frame = new Map<string,number>(), viewport:string[] = [], rows = terminalContent(lines,cli,wrapped);
      // The input line is the last content row on screen (only chrome sits under it); a menu's
      // selected row never is, and must not wait for a hold it would not survive.
      const last = rows.findLastIndex(r => r !== null && !!stableKey(r));
      let draftStart = last;
      while (draftStart > above && wrapped[draftStart]) draftStart--;
      if (draftStart < above || !rows[draftStart] || !prompt(rows[draftStart]!)) draftStart = -1;
      // An empty input below a transcript prompt proves that the latter is no longer
      // the editable input. Chrome filtering would otherwise hide this distinction.
      if (lines.some((line,i) => i > last && /^❯(?:\s|$)/.test(stableKey(line)))) draftStart = -1;
      for (let i = 0; i < rows.length; i++) {
        const line = rows[i], key = line === null ? '' : keyOf(line), inView = i >= above;
        const position = scrolled+i-above, draft = draftStart >= 0 && i >= draftStart && i <= last;
        if (inView) viewport.push(key);
        if (!key) continue;
        const known = seen.has(key) || frame.has(key);
        frame.set(key,now);
        if (held.has(key)) {
          const h = held.get(key)!;
          if (!inView || (h.draft && !draft)) { held.delete(key); queue(h,now); }
          continue;
        } // moved out of the input position / scrolled off = final
        if (known || now < baselineUntil) continue; // after a resize the re-wrapped repaint is the baseline, not news
        const prev = inView ? prevViewport[i-above+displacement] : undefined;
        const pending = fresh.findIndex(row => row.key === prev && row.position === position);
        if (prev && (key.startsWith(prev) || commonPrefix(prev,key) >= Math.max(3,Math.min(prev.length,key.length)-8) || (pending >= 0 && commonPrefix(prev,key) >= 12))) {
          // Same physical row repainted before publication: replace its unfinished contents,
          // including an old right-hand menu trailer, without filtering real two-column rows.
          const old = held.get(prev)?.position === position ? held.get(prev) : undefined, queued = pending >= 0 ? fresh.splice(pending,1)[0] : undefined;
          if (old) held.delete(prev);
          const first = old?.first ?? now;
          held.set(key,{ line:line!,key,at:now,hold:Math.min(1500,Math.max(0,2000-(now-first))),order:old?.order ?? queued?.order ?? ++order,first,position,draft });
        }
        // Keep the editable input (including soft-wrap tails) out of observations until
        // it moves into the transcript. It never holds up already submitted output.
        else if (draft) held.set(key,{ line:line!,key,at:now,hold:1500,order:++order,first:now,position,draft });
        else queue({ line:line!,key,position },now);
      }
      // Vanished before it settled = a transient; settled on screen = content. Judged against this
      // frame alone, before the 5 s carry-over would keep a vanished row alive.
      for (const [key,h] of held) { if (!frame.has(key)) held.delete(key); else if (!h.draft && now-h.at >= h.hold) { held.delete(key); queue(h,now); } }
      for (const [key,at] of seen) if (!frame.has(key) && now-at < 5000) frame.set(key,at);
      // An input may disappear for one paint before returning as a submitted transcript
      // row. Unpublished drafts must not make that later row look already delivered.
      for (const [key,h] of held) if (h.draft) frame.delete(key);
      seen = frame; prevViewport = viewport;
    };
    collect(initial.lines,0,Date.now(),initial.wrapped);
    fresh.length = 0;
    const flush = (final = false) => {
      clearTimeout(timer); timer = undefined;
      const now = Date.now();
      for (const [key,h] of held) if (final || (!h.draft && now-h.at >= h.hold)) {
        held.delete(key);
        // At exit there may be no visible acknowledgment of a submitted prompt. Keep
        // that uncertain text explicitly labeled instead of silently losing it.
        queue(h.draft ? { ...h,line:`[Terminal input at exit; submission unverified] ${h.line}` } : h,now);
      }
      const pending = [...held.values()].filter(h => !h.draft);
      if (pending.length) timer = setTimeout(flush,Math.max(50,Math.min(...pending.map(h => h.hold-(now-h.at))))).unref();
      if (!fresh.length) return;
      // A later settled row cannot pass an earlier row still being painted. Holds have a
      // bounded deadline. Unsent input is held separately and cannot block real output.
      fresh.sort((a,b) => a.order-b.order);
      const barrier = Math.min(...pending.map(h => h.order));
      const end = fresh.findIndex(row => row.order > barrier);
      const rows = fresh.splice(0,end < 0 ? fresh.length : end);
      // Bounded events, nothing dropped: a long burst becomes several 16 kB pages.
      const pages:string[] = []; let page = '';
      for (const { line } of rows) { const row = line.slice(0,4000); if (page && page.length+row.length+1 > 16000) { pages.push(page); page = ''; } page += (page ? '\n' : '')+row; }
      if (page) pages.push(page);
      pages.forEach((text,i) => emit(`${connection}:output:${sequence}:${i}:${hash(text).slice(0,16)}`,{ eventType:'output',target:s.target,text,sequence,...(pages.length > 1 ? { page:i+1,pages:pages.length } : {}) }));
    };
    const stop = subscribeDev(user,event => {
      if (event.id !== s.target || !['output','session'].includes(event.type)) return;
      const data = event.data as { data?:string; sequence?:number; state?:string; exitCode?:number; cols?:number; rows?:number } | undefined;
      if (!data) { offline('Terminal is unavailable.'); return; }
      const now = Date.now();
      if (event.type === 'session') {
        // A resize re-wraps every row: the repaint that follows is a baseline, not new output.
        const next = `${data.cols}x${data.rows}`;
        if (next !== size) { size = next; baselineUntil = now+1500; held.clear(); prevViewport = []; }
        const status = `${data.state}:${data.exitCode}`;
        if (status === announced) return; // a lease, mode or size change is not a session event
        announced = status;
        flush(data.state !== 'running');
        emit(`${connection}:session:${event.sequence}`,{ eventType:'session',target:s.target,status:data.state,exitCode:data.exitCode,sequence:data.sequence });
        return;
      }
      sequence = data.sequence ?? sequence;
      let frame:ReturnType<typeof renderedLines>;
      try { frame = renderedLines(user,s.target!,scrolled); } catch (e) { offline(e instanceof Error ? e.message : String(e)); return; }
      const above = Math.max(0,frame.scrolled-scrolled-frame.lost);
      const displacement = frame.scrolled-scrolled;
      scrolled = frame.scrolled;
      collect(frame.lines,above,now,frame.wrapped,displacement);
      if (frame.lost) { const line = `[monitor: ${frame.lost} rows scrolled out of view before they were read]`; queue({ line,key:line },now); }
      if (!fresh.length && !held.size) return;
      // Trailing quiet period, capped: a burst settles (its partial rows complete) before it is
      // read, and sustained output still leaves within 2 s of its first new row.
      if (fresh.length >= 200 || (fresh.length && now-since >= 2000)) flush();
      else { clearTimeout(timer); timer = setTimeout(flush,300).unref(); }
    });
    return () => { clearTimeout(timer); stop(); };
  }
  if (s.type === 'file') {
    const projectRoot = projectPath(user,s.project!); // Never watch an ancestor outside the approved root.
    let previous = new Map<string,{ hash:string; ino:number; text:string; bytes:number }>(), first = true,closed = false,busy = false;
    const scan = async () => {
      if (closed || busy) return; busy = true;
      try {
        validateMonitorSource(user,s);
        const current = new Map<string,{ hash:string; ino:number; text:string; bytes:number }>();
        let entries = 0;
        const walk = async (relative:string):Promise<void> => {
          if (++entries > 10000) throw Error('File monitor scope exceeds 10000 entries; choose a narrower folder.');
          if (current.size >= 2000) throw Error('File monitor scope exceeds 2000 files; choose a narrower folder.');
          const file = projectPath(user,s.project!,relative,true);
          let stat; try { stat = await fs.promises.lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
          if (stat.isSymbolicLink()) return;
          if (stat.isDirectory()) {
            for (const entry of await fs.promises.readdir(file,{ withFileTypes:true })) {
              if (entry.name === '.git' || entry.isSymbolicLink()) continue;
              await walk(relative ? `${relative}/${entry.name}` : entry.name);
            }
          } else if (stat.isFile()) {
            const handle = await fs.promises.open(file,'r'); let text = '';
            try { const buffer = Buffer.alloc(Math.min(stat.size,64000)); const { bytesRead } = await handle.read(buffer,0,buffer.length,0); text = buffer.subarray(0,bytesRead).toString('utf8'); } finally { await handle.close(); }
            current.set(relative,{ hash:hash([stat.size,stat.mtimeMs,text]),ino:stat.ino,text:text.includes('\0') ? '' : text,bytes:stat.size });
          }
        };
        await walk(s.path ?? '');
        if (closed) return;
        if (first) { first = false; emit(`baseline:${randomUUID()}`,{ eventType:'baseline',path:s.path ?? '',files:current.size },true); }
        else {
          const renamedPaths = new Set<string>();
          for (const [file,value] of current) if (previous.get(file)?.hash !== value.hash) {
            const renamed = !previous.has(file) ? [...previous].find(([old,v]) => !current.has(old) && v.ino === value.ino)?.[0] : undefined;
            if (renamed) renamedPaths.add(renamed);
            emit(`${file}:${value.hash}`,{ eventType:renamed ? 'renamed' : previous.has(file) ? 'changed' : 'created',path:file,...(renamed ? { previousPath:renamed } : {}),text:value.text,bytes:value.bytes,truncated:value.bytes > 64000 });
          }
          for (const file of previous.keys()) if (!current.has(file) && !renamedPaths.has(file)) emit(`${file}:deleted:${randomUUID()}`,{ eventType:'deleted',path:file,text:'' });
        }
        previous = current;
      } finally { busy = false; }
    };
    const root = projectPath(user,s.project!,s.path ?? '',true);
    let watchRoot = root; while (!fs.existsSync(watchRoot)) {
      if (watchRoot === projectRoot) throw Error('Project root is unavailable.');
      watchRoot = path.dirname(watchRoot);
    }
    if (!fs.statSync(watchRoot).isDirectory()) watchRoot = path.dirname(watchRoot);
    let debounce:ReturnType<typeof setTimeout> | undefined;
    let watcher:fs.FSWatcher | undefined;
    try {
      watcher = fs.watch(watchRoot,{ recursive:true },() => { clearTimeout(debounce); debounce = setTimeout(() => void scan().catch(e => offline(e.message)),250); });
      watcher.on('error',() => { watcher?.close(); watcher = undefined; });
    } catch { /* Reconciliation remains active when OS watcher capacity is exhausted. */ }
    const stop = poll(scan,Math.max(5000,(s.intervalSeconds ?? 30)*1000),offline);
    return () => { closed = true; stop(); watcher?.close(); clearTimeout(debounce); };
  }
  if (s.type === 'browser') {
    const { peek, subscribe } = await import('../browser/session.ts');
    const session = peek(user,s.target!); if (!session) throw Error('Browser is offline; waiting for its session to reconnect.');
    const marker = `rimeMonitor${randomUUID().replaceAll('-','')}`;
    let first = true,last = '',closed = false,busy = false;
    const pages = new Set<typeof session.page>();
    const sample = async () => {
      if (closed || busy) return; busy = true;
      try {
      if (!browserWard(user,s.target!) || peek(user,s.target!) !== session || session.page.isClosed()) throw Error('Browser session disconnected.');
      const page = session.page; session.lastUsed = Date.now();
      pages.add(page);
      const value = await page.evaluate(({ marker,selector }) => {
        const globals = window as unknown as Record<string,any>;
        if (!globals[marker]) {
          const state = { dirty:true,changedAt:0,url:location.href,observer:new MutationObserver(() => { state.dirty = true; state.changedAt = Date.now(); }) };
          state.observer.observe(document,{ subtree:true,childList:true,characterData:true,attributes:true }); globals[marker] = state;
        }
        const state = globals[marker]; if ((!state.dirty && state.url === location.href) || Date.now()-state.changedAt < 250) return null;
        state.dirty = false; state.url = location.href;
        const element = selector ? document.querySelector(selector) : document.body;
        return { eventType:'changed',url:location.href,title:document.title,text:(element?.textContent ?? '').slice(0,16000),selectorFound:!!element };
      },{ marker,selector:s.selector });
      if (closed || !value) return;
      const key = hash(value); if (key === last) return; last = key;
      emit(`${randomUUID()}:${key}`,value,first); first = false;
      } finally { busy = false; }
    };
    const sub = (event:{ type:string }) => { if (event.type === 'closed' || ('online' in event && event.online === false)) offline('Browser disconnected.'); if (event.type === 'nav' || event.type === 'tabs') void sample().catch(e => offline(e.message)); };
    const unsub = subscribe(session,sub,false); const stop = poll(sample,1000,offline); // no frames: the monitor reads nav and tabs
    return () => { closed = true; stop(); unsub(); for (const page of pages) void page.evaluate(marker => { const g = window as unknown as Record<string,any>; g[marker]?.observer.disconnect(); delete g[marker]; },marker).catch(() => {}); };
  }
  if (s.type === 'http') {
    let first = true,last = '';
    return poll(async () => {
      validateMonitorSource(user,s);
      const result = await readOnlyFetch(s.url!,{ method:'GET',timeoutMs:15000 });
      const text = Buffer.from(result.body).toString('utf8').slice(0,16000);
      const event:Record<string,unknown> = { eventType:'response',url:s.url,status:result.status,text,headers:Object.fromEntries((s.headers ?? []).map(h => [h.toLowerCase(),result.headers[h.toLowerCase()] ?? null])) };
      if (s.fields?.length) {
        const { fieldValue } = await import('./monitor-filter.ts');
        try {
          if (result.body.byteLength > 1024*1024) throw Error('JSON response exceeds 1 MiB.');
          const body = JSON.parse(Buffer.from(result.body).toString('utf8')) as Record<string,unknown>;
          event.json = Object.fromEntries(s.fields.map(field => [field,fieldValue(body,field)]));
        } catch { event.json = {}; event.jsonError = 'Selected JSON fields unavailable; response is invalid JSON or exceeds 1 MiB.'; }
      }
      const key = hash(event); if (key === last) return; last = key; emit(`${randomUUID()}:${key}`,event,first); first = false;
    },(s.intervalSeconds ?? 30)*1000,offline);
  }
  if (s.type === 'note' || s.type === 'notebook') {
    const snapshot = (id:string) => ({ ...getNoteMeta(user,id),note:id,text:plainText(readNote(user,id).html).slice(0,16000) });
    emit(`baseline:${randomUUID()}`,{ ...(s.type === 'note' ? snapshot(s.target!) : {}),eventType:'baseline' },true);
    const stop = onNoteEvent(event => {
      if (event.userId !== user || (s.type === 'note' ? event.id !== s.target : event.notebook !== s.target && event.previousNotebook !== s.target)) return;
      const note = readNote(user,event.id);
      const data = { ...snapshot(event.id),eventType:event.type,notebook:event.notebook,title:event.title,tags:event.tags,section:event.section };
      emit(`${event.id}:${note.rev}:${event.type}:${hash(data)}`,data);
    });
    const stopMetadata = onObservation(event => { if (s.type === 'notebook' && event.source === 'notebook' && event.user === user && event.target === s.target) emit(event.key,event.data,event.baseline); });
    return () => { stop(); stopMetadata(); };
  }
  const ward = getDashboard(user).find(w => w.i === s.target);
  if (ward && isCommsType(ward.type)) {
    const { commsStatus } = await import('../comms/index.ts');
    const state = commsStatus(user,ward);
    if (state.status !== 'ready') throw Error(state.error || state.needs || `Connector ${state.status}; waiting for it to reconnect.`);
  }
  emit(`baseline:${randomUUID()}`,{ eventType:'baseline' },true);
  let probeBacked = false;
  const unsubscribe = onObservation(event => {
    if (event.user !== user || event.target !== s.target) return;
    if (event.source === 'comms-state') { if (event.data.status !== 'ready') offline(String(event.data.error || `Connector ${event.data.status}`)); return; }
    if (s.type === 'agent' && event.source !== 'agent') return;
    if (s.type === 'comms' && event.source !== 'comms') return;
    if (s.type === 'event' && (event.source !== 'event' || event.data.eventType !== s.event)) return;
    if (probeBacked && s.type === 'event') return;
    emit(event.key,event.data,event.baseline);
  });
  // Reuse existing exogenous Leyline probes and their connector-specific intervals.
  const trigger = s.type === 'comms' && ward?.type === 'mail' ? 'mail-arrived' : s.type === 'event' ? s.event : undefined;
  const { WATCHERS } = await import('../logic-engine.ts');
  const spec = trigger ? WATCHERS[trigger] : undefined;
  // Parameterized and globally receipted probes remain owned by the Leyline engine.
  if (!spec || !ward || Object.values(TRIGGERS[trigger!]?.params ?? {}).some(p => !p.filter) || ['deploy-landed','update-available'].includes(trigger!)) return unsubscribe;
  probeBacked = true;
  let previous:unknown;
  let previousConfig = JSON.stringify(ward.config ?? {});
  const stop = poll(async () => {
    validateMonitorSource(user,s);
    const config = getDashboard(user).find(w => w.i === s.target)!.config ?? {}, signature = JSON.stringify(config);
    if (signature !== previousConfig) { previous = undefined; previousConfig = signature; }
    const result = await spec.probe({ userId:user,ward:ward.i,config,edges:[],now:Date.now() },previous);
    const initial = previous === undefined; previous = result.state;
    if (initial) return;
    for (const f of result.fires) emit(hash([f,previous]),{ ...f.extra,eventType:trigger,sender:f.extra?.['mail.fromAddress'],text:[f.extra?.['mail.subject'],f.extra?.['mail.snippet']].filter(Boolean).join('\n'),channel:f.channel,match:f.match,packet:f.packet });
  },Math.max(spec.intervalMs,(s.intervalSeconds ?? 30)*1000),error => { previous = undefined; offline(error); });
  return () => { unsubscribe(); stop(); };
}
