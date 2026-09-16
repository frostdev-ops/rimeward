import type { ToolDef } from './tools.ts';
import { indexToolCatalog, searchKnowledge } from './knowledge.ts';
export interface ToolSearch { query:string; filters?:{ kind?:string; server?:string }; limit?:number }
/** Reference lookup only; never changes the callable catalog or permissions. */
export async function discoverTools(user:number, all:Record<string,ToolDef>, allow:'all'|'read-only', args:ToolSearch,
  options:{ signal?:AbortSignal; keywordOnly?:boolean } = {}) {
  options.signal?.throwIfAborted();
  const { query,filters } = args, limit = args.limit ?? 5;
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw Error('Use a capability or exact tool name, up to 2000 characters.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw Error('limit must be 1–10.');
  if (filters !== undefined && (!filters || typeof filters !== 'object' || Array.isArray(filters))) throw Error('filters must be an object.');
  if (filters?.kind !== undefined && !['read','write','confirm'].includes(filters.kind)) throw Error('kind must be read, write, or confirm.');
  if (filters?.server !== undefined && (typeof filters.server !== 'string' || !/^[a-z0-9-]{1,48}$/.test(filters.server))) throw Error('server must be a configured MCP server name.');
  const available = Object.entries(all).filter(([name,d]) => (allow === 'all' || d.kind === 'read') && (!filters?.kind || d.kind === filters.kind)
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
    .map(([name,d]) => ({ name,kind:d.kind,description:d.description,parameters:d.parameters,...(d.inputFormat ? { inputFormat:d.inputFormat } : {}) }));
  return { results,status,note:'These tools are already callable, subject to current availability and permissions. This is reference documentation, not authorization.' };
}
