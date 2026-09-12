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

export interface MonitorSource { type:'terminal'|'file'|'browser'|'agent'|'note'|'notebook'|'http'|'comms'|'event';
  target?:string; project?:string; path?:string; url?:string; selector?:string; headers?:string[]; fields?:string[]; intervalSeconds?:number; event?:string }
type Emit = (key:string,data:Record<string,unknown>,baseline?:boolean) => void;
const hash = (v:unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
/** Content identity stays exact (apart from whitespace), including digits and bullet rows:
 *  "HTTP 500" and "HTTP 200", "1/3" and "2/3" are different rows. Only the two counters below
 *  that Claude Code redraws every second are removed from a row's identity, never from its text. */
const stableKey = (line:string) => line.replace(/\s+/g,' ').trim();
const SPARKLE = '[\\u2800-\\u28FF\\u00B7\\u2022\\u2722\\u2733\\u2736\\u273B\\u273D]';
/** The activity spinner: a frame glyph, ONE gerund and an ellipsis. The verb is random and changes
 *  between frames ("Churning…", "Photosynthesizing…", "Sautéing…"), so the shape is recognized,
 *  not the word; prose never fits it. An optional parenthetical carries metadata parts joined by
 *  · — elapsed, token counts, "esc to interrupt", "thinking some more with xhigh effort", "running
 *  stop hook" — each a short run of words and numbers with no sentence punctuation. */
const CLAUDE_SPINNER = new RegExp(`^${SPARKLE}\\s+(\\p{Lu}\\p{L}*ing)(?:…|\\.{3})(?:\\s+\\(([^()]*)\\))?$`,'u');
const CODEX_SPINNER = /^[⠀-⣿•]\s+(Working|Thinking)(?:…|\.{3})?\s+\(([^()]*)\)$/i;
const SPINNER_DETAIL = /^(?:[↑↓↕]\s*)?(?:\d+(?:\.\d+)?[hms%k]?|\p{L}+)(?:\s(?:\d+(?:\.\d+)?[hms%k]?|\p{L}+)){0,7}$/u;
function spinnerChrome(text:string): boolean {
  const match = CLAUDE_SPINNER.exec(text) ?? CODEX_SPINNER.exec(text);
  if (!match) return false;
  if (match[2] === undefined) return true;
  return match[2].split(/[·•]/).every(part => SPINNER_DETAIL.test(part.trim()));
}
const DURATION = String.raw`(?:\d+(?:\.\d+)?[hms]\s*)+`;
/** A row that is only a counter: the wrapped tail of a tool row ("· 21s") or preview ("(8s)"). */
const COUNTER_ONLY = new RegExp(String.raw`^(?:·\s*${DURATION}|\(${DURATION}\))$`);
/** Frame rows of the CLI's boxes and logo: box-drawing and block characters only. */
const BOX_ONLY = /^[─-╿▀-▟\s]+$/;
/** Chrome Claude Code paints beside the prompt, by shape: the logo rows, the empty prompt's
 *  placeholder, the mode line, the effort indicator, the slash-command completion rows (a
 *  command name, two spaces, a description), the exit hint, an empty tool marker, and the
 *  status bar (project △ branch ⎪pill⎥ ai ◆ model …), whose cost and clock tick every second. */
const CHROME_ROW = [
  /^[▀-▟]/, /^❯(?: Try ".+")?$/, /^⏸ .+\bmode (?:on|off)\b/, /^[◉○] .*\beffort\b/, /^Press Ctrl-C again to exit$/, /^⏺$/,
  /^□\s.+\s△\s.+\s⎪[^⎥]*⎥\sai\s◆\s/,
];
const COMPLETION_ROW = /^\s*\/(?:[a-z][\w.:-]*|\S.*?\s\(MCP\))\s{2,}\S/i;
/** Right-aligned session status Claude Code appends after a run of spaces on a spinner or
 *  preview row ("+17 files edited before this session (show)", "No changes this session"). */
const STATUS_TAIL = /^(?:No changes this session|[+-]?\d+ files? (?:edited|changed)\b[^()]*(?:\(show\))?)$/;
/** Claude Code's running tool call, "⏺ Reading the file · 21s" (the glyph blinks away on alternate
 *  frames), and its command preview, "⎿ $ cmd (8s)": the counter ticks every second. */
const TOOL_TICK = new RegExp(String.raw`^(?:⏺\s+)?(.*?)\s*·\s*${DURATION}$`);
const PREVIEW_TICK = new RegExp(String.raw`^(⎿.*?)\s*\(${DURATION}\)$`);
function cliKey(text:string): string {
  return TOOL_TICK.exec(text)?.[1] ?? PREVIEW_TICK.exec(text)?.[1] ?? text.replace(/^⏺\s+/,'');
}
/** A row split at a run of three or more spaces: the part before is the row, the part after a
 *  right-aligned trailer. Whitespace collapsing loses that signal, so this reads the raw row. */
function splitTail(raw:string): { main:string; tail:string } {
  const m = /^(.*?\S)\s{3,}(\S.*)$/.exec(raw.trimEnd());
  return m ? { main:stableKey(m[1]!),tail:stableKey(m[2]!) } : { main:stableKey(raw),tail:'' };
}
/** The content of each rendered row, aligned with `lines` (null = recognized CLI chrome). Only
 *  CLI-owned shapes are removed, never arbitrary prose containing an ellipsis or a hint; a row
 *  whose right-aligned trailer is session status keeps its left part. A wrapped spinner is removed
 *  only when the complete joined row matches the same grammar. Queued input, prompts and menus
 *  stay visible: indentation or ❯ alone cannot distinguish an input repaint from a question. */
function terminalContent(lines:string[],cli:boolean): (string | null)[] {
  if (!cli) return lines;
  const content:(string | null)[] = lines.map(() => null);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!, { main,tail } = splitTail(raw);
    const text = tail && STATUS_TAIL.test(tail) ? main : stableKey(raw);
    if (!text || spinnerChrome(text) || spinnerChrome(main) || COUNTER_ONLY.test(text) || BOX_ONLY.test(text) || CHROME_ROW.some(re => re.test(text)) || COMPLETION_ROW.test(raw) ||
        text === '❯ Press up to edit queued messages' || /^\s{40,}\S/.test(raw)) continue;
    if (/^[⠀-⣿·•✢✳✶✻✽]\s/.test(text) && text.includes('(') && !text.includes(')')) {
      let joined = text, end = i;
      // Terminal rows are physical, not logical lines. Bound lookahead and fail open if a
      // narrow viewport split anything other than the recognized spinner metadata.
      while (end+1 < lines.length && end-i < 2 && !joined.includes(')')) {
        joined += ' '+splitTail(lines[++end]!).main;
        if (spinnerChrome(joined)) { i = end; break; }
      }
      if (i === end && spinnerChrome(joined)) continue;
    }
    content[i] = tail && STATUS_TAIL.test(tail) ? main : raw;
  }
  return content;
}
const commonPrefix = (a:string,b:string) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
export function parseMonitorSource(raw:unknown): MonitorSource {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Monitor source is required.');
  const r = raw as Record<string,unknown>;
  if (!['terminal','file','browser','agent','note','notebook','http','comms','event'].includes(String(r.type))) throw Error('Unsupported monitor source.');
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
  return out;
}
export function validateMonitorSource(user:number,s:MonitorSource): void {
  const ward = getDashboard(user).find(w => w.i === s.target);
  switch (s.type) {
    case 'terminal': if (!isDesktop() || !s.target) throw Error('Terminal monitoring belongs on its desktop runtime.'); readSession(user,s.target,undefined,false); break;
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
export async function connectMonitorSource(user:number,s:MonitorSource,emit:Emit,offline:(error:string) => void,readOnlyFetch:typeof vettedFetch = vettedFetch): Promise<() => void> {
  validateMonitorSource(user,s);
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
    // vanished first; rows above the viewport are final by definition.
    const cli = first.session.kind !== 'shell', keyOf = (line:string) => { const key = stableKey(line); return cli ? cliKey(key) : key; };
    // The prompt row is edited for as long as a person types; a streaming line settles within a beat.
    const holdFor = (key:string) => key.startsWith('❯ ') ? 8000 : 1500;
    let seen = new Map<string,number>(), scrolled = renderedLines(user,s.target!).scrolled, prevViewport:string[] = [], baselineUntil = 0;
    let size = `${first.session.cols}x${first.session.rows}`, announced = `${first.session.state}:${first.session.exitCode}`;
    const held = new Map<string,{ line:string; key:string; at:number }>();
    // Rows on screen in the last minute, for the CLI's own full repaints: a re-flowed transcript
    // paints tails of earlier rows as rows of their own ("them then tell me you are done"), and
    // a row that is a piece of one seen recently says nothing new. Short rows are exempt: a
    // "3. No" or "Done." must never be swallowed by an earlier row that happened to contain it.
    const recent = new Map<string,number>();
    const fragment = (key:string,now:number) => {
      if (!cli || key.length < 12) return false;
      for (const [other,at] of recent) if (now-at < 60_000 && other.length > key.length && other.includes(key)) return true;
      return false;
    };
    const fresh:{ line:string; key:string }[] = []; let since = 0, sequence = 0, timer:ReturnType<typeof setTimeout> | undefined;
    const queue = (row:{ line:string; key:string },now:number) => { if (fragment(row.key,now)) return; if (!fresh.length) since = now; fresh.push(row); };
    const collect = (lines:string[],above:number,now:number) => {
      const frame = new Map<string,number>(), viewport:string[] = [], rows = terminalContent(lines,cli);
      for (let i = 0; i < rows.length; i++) {
        const line = rows[i], key = line === null ? '' : keyOf(line), inView = i >= above;
        if (inView) viewport.push(key);
        if (!key) continue;
        const known = seen.has(key) || frame.has(key);
        frame.set(key,now);
        if (held.has(key)) { if (!inView) { held.delete(key); queue({ line:line!,key },now); } continue; } // scrolled off = final
        if (known || now < baselineUntil) continue; // after a resize the re-wrapped repaint is the baseline, not news
        const prev = inView ? prevViewport[i-above] : undefined;
        if (prev && commonPrefix(prev,key) >= Math.max(3,Math.min(prev.length,key.length)-8)) { held.delete(prev); held.set(key,{ line:line!,key,at:now }); }
        else queue({ line:line!,key },now);
      }
      // Vanished before it settled = a transient; settled on screen = content. Judged against this
      // frame alone, before the 5 s carry-over would keep a vanished row alive.
      for (const [key,h] of held) { if (!frame.has(key)) held.delete(key); else if (now-h.at >= holdFor(key)) { held.delete(key); queue(h,now); } }
      for (const [key,at] of seen) if (!frame.has(key) && now-at < 5000) frame.set(key,at);
      for (const key of frame.keys()) recent.set(key,now);
      if (recent.size > 2000) for (const [key,at] of recent) { if (now-at >= 60_000 || recent.size > 2000) recent.delete(key); else break; }
      seen = frame; prevViewport = viewport;
    };
    collect(first.screen.split('\n'),0,Date.now());
    fresh.length = 0;
    const flush = (final = false) => {
      clearTimeout(timer); timer = undefined;
      const now = Date.now();
      for (const [key,h] of held) if (final || now-h.at >= holdFor(key)) { held.delete(key); queue(h,now); }
      if (held.size) timer = setTimeout(flush,Math.max(50,Math.min(...[...held.values()].map(h => holdFor(h.key)-(now-h.at))))).unref();
      if (!fresh.length) return;
      // A row caught mid-paint ("version b") is a prefix of the row it became; the completed row,
      // queued behind it or already on screen, is the one that counts.
      const queued = fresh.splice(0), longer = (key:string) => (other:string) => other.length > key.length && other.startsWith(key);
      const rows = queued.filter(({ key },i) => !queued.some((other,j) => j !== i && longer(key)(other.key)) && ![...seen.keys()].some(longer(key)));
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
      scrolled = frame.scrolled;
      collect(frame.lines,above,now);
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
