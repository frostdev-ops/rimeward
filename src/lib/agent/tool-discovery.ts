import type { ToolDef } from './tools.ts';
import { indexToolCatalog, searchKnowledge } from './knowledge.ts';
import { mcpToolDefs, mcpToolDefsSync } from './mcp.ts';

export const BOOTSTRAP_TOOLS = ['search_tools','search_knowledge','read_knowledge','ask_user_question','task_list','task_output','task_cancel'] as const;
export interface ToolSearch { query:string; filters?:{ kind?:string; server?:string }; limit?:number }
/** runLoop persists this conversation's union of names. Discovery conveys no permission. */
export async function discoverTools(user:number, all:Record<string,ToolDef>, allow:'all'|'read-only', loaded:Set<string>, args:ToolSearch,
  options:{ signal?:AbortSignal; keywordOnly?:boolean; excludeLoaded?:boolean } = {}) {
  options.signal?.throwIfAborted();
  const { query,filters } = args, limit = args.limit ?? 5;
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw Error('Use a capability or exact tool name, up to 2000 characters.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw Error('limit must be 1–10.');
  if (filters !== undefined && (!filters || typeof filters !== 'object' || Array.isArray(filters))) throw Error('filters must be an object.');
  if (filters?.kind !== undefined && !['read','write','confirm'].includes(filters.kind)) throw Error('kind must be read, write, or confirm.');
  if (filters?.server !== undefined && (typeof filters.server !== 'string' || !/^[a-z0-9-]{1,48}$/.test(filters.server))) throw Error('server must be a configured MCP server name.');
  const available = Object.entries(all).filter(([name,d]) => (!options.excludeLoaded || !loaded.has(name)) && (allow === 'all' || d.kind === 'read') && (!filters?.kind || d.kind === filters.kind)
    && (!filters?.server || name.startsWith(`mcp__${filters.server}__`)));
  const words = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const ranked = new Map(available.map(([name,d]) => {
    const text = `${name} ${d.description} ${JSON.stringify(d.parameters)}`.toLowerCase();
    return [name, name.toLowerCase() === query.toLowerCase().trim() ? 1000 : words.reduce((n,w) => n+(name.toLowerCase().includes(w) ? 10 : text.includes(w) ? 1 : 0),0)];
  }));
  let status = 'keyword';
  if (!options.keywordOnly && available.length) try {
    await indexToolCatalog(user,all);
    options.signal?.throwIfAborted();
    const found = await searchKnowledge(user,query,['tool'],10,available.map(([n]) => `tool:${n}`),options.signal);
    options.signal?.throwIfAborted();
    found.results.forEach((h,i) => { const n = h.source.slice(5); if (ranked.has(n)) ranked.set(n,ranked.get(n)!+(10-i)/10); });
    status = `${found.mode}: ${found.status}`;
  } catch (e) { status = `keyword: ${e instanceof Error ? e.message : String(e)}`; }
  options.signal?.throwIfAborted();
  const results = available.filter(([n]) => ranked.get(n)! > 0).sort(([a],[b]) => ranked.get(b)!-ranked.get(a)! || a.localeCompare(b)).slice(0,limit)
    .map(([name,d]) => { loaded.add(name); return { name,kind:d.kind,description:d.description }; });
  return { results,status,note:'These tools become callable next round and remain loaded for this conversation, subject to availability and permissions. Use agent_help for detailed usage guidance.' };
}

/** Two seconds for MCP + hybrid retrieval; late work never mutates the caller's loaded set. */
export async function preloadTools(user:number, builtins:Record<string,ToolDef>, allow:'all'|'read-only', loaded:ReadonlySet<string>, query:string, signal:AbortSignal) {
  signal.throwIfAborted();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException('Tool preload timed out.','TimeoutError')),2000);
  const deadline = AbortSignal.any([signal,timeout.signal]);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_,reject) => {
    onAbort = () => reject(deadline.reason);
    deadline.addEventListener('abort',onAbort,{ once:true });
  });
  const args = { query:query.slice(0,2000),limit:5 };
  try {
    return await Promise.race([
      (async () => {
        const extra = await mcpToolDefs(user,undefined,deadline);
        return discoverTools(user,{ ...builtins,...extra },allow,new Set(loaded),args,{ signal:deadline,excludeLoaded:true });
      })(),
      aborted,
    ]);
  } catch {
    signal.throwIfAborted();
    return discoverTools(user,{ ...builtins,...mcpToolDefsSync(user) },allow,new Set(loaded),args,{ keywordOnly:true,excludeLoaded:true });
  } finally {
    clearTimeout(timer);
    deadline.removeEventListener('abort',onAbort);
    timeout.abort(); // Also cancel other connections if one failed before the deadline.
  }
}
