export type MonitorFilter = { all:MonitorFilter[] } | { any:MonitorFilter[] } | { not:MonitorFilter } |
  { field:string; op:'eq'|'contains'|'glob'|'gt'|'gte'|'lt'|'lte'|'changed'; value?:string|number|boolean|null };
export interface SemanticFilter { field:string; query:string; threshold:number }
const fields = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/;
export function fieldValue(event:Record<string,unknown>, field:string): unknown {
  if (Object.hasOwn(event,field)) return event[field];
  let value:unknown = event;
  const parts = field.split('.');
  for (const [i,key] of parts.entries()) {
    if (['__proto__','constructor','prototype'].includes(key) || !value || typeof value !== 'object' || !Object.hasOwn(value,key)) return undefined;
    value = (value as Record<string,unknown>)[key];
    const remainder = parts.slice(i+1).join('.');
    if (remainder && value && typeof value === 'object' && Object.hasOwn(value,remainder)) return (value as Record<string,unknown>)[remainder];
  }
  return value;
}
export function parseMonitorFilter(raw:unknown, depth = 0, budget = { nodes:0 }): MonitorFilter {
  if (++budget.nodes > 64 || depth > 8 || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Filter must be an object with at most 64 nodes and depth 8.');
  const f = raw as Record<string,unknown>, keys = Object.keys(f);
  if ('all' in f || 'any' in f) {
    const op = 'all' in f ? 'all' : 'any', list = f[op];
    if (keys.length !== 1 || !Array.isArray(list) || list.length > 16 || (op === 'any' && !list.length)) throw Error('all/any requires an array of at most 16 filters.');
    return { [op]:list.map(v => parseMonitorFilter(v,depth+1,budget)) } as MonitorFilter;
  }
  if ('not' in f) { if (keys.length !== 1) throw Error('not takes one filter.'); return { not:parseMonitorFilter(f.not,depth+1,budget) }; }
  if (keys.some(k => !['field','op','value'].includes(k)) || typeof f.field !== 'string' || f.field.length > 120 || !fields.test(f.field)) throw Error('Use a bounded field name.');
  if (!['eq','contains','glob','gt','gte','lt','lte','changed'].includes(String(f.op))) throw Error('Unsupported filter operator.');
  if (f.op === 'contains' || f.op === 'glob') {
    if (typeof f.value !== 'string' || !f.value || f.value.length > 256) throw Error('Text and glob filters require 1–256 characters.');
  } else if (['gt','gte','lt','lte'].includes(String(f.op))) {
    if (typeof f.value !== 'number' || !Number.isFinite(f.value)) throw Error('Numeric comparison requires a finite number.');
  } else if (f.op === 'eq' && !(f.value === null || ['string','boolean','number'].includes(typeof f.value))) throw Error('Equality requires a scalar value.');
  if (typeof f.value === 'string' && f.value.length > 2000) throw Error('Filter value too long.');
  if (typeof f.value === 'number' && !Number.isFinite(f.value)) throw Error('Filter numbers must be finite.');
  return { field:f.field,op:f.op,value:f.value } as MonitorFilter;
}
/** Bounded wildcard matching without regex backtracking. '*' and '?' are the only metacharacters. */
export function monitorGlob(pattern:string, text:string): boolean {
  if (pattern.length > 256 || text.length > 64000) return false;
  let p = 0,t = 0,star = -1,match = 0;
  while (t < text.length) {
    if (pattern[p] === '?' || pattern[p] === text[t]) { p++; t++; }
    else if (pattern[p] === '*') { star = p++; match = t; }
    else if (star >= 0) { p = star+1; t = ++match; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
export function matchesMonitor(filter:MonitorFilter, event:Record<string,unknown>, previous:Record<string,unknown>): boolean {
  if ('all' in filter) return filter.all.every(f => matchesMonitor(f,event,previous));
  if ('any' in filter) return filter.any.some(f => matchesMonitor(f,event,previous));
  if ('not' in filter) return !matchesMonitor(filter.not,event,previous);
  const value = fieldValue(event,filter.field);
  switch (filter.op) {
    case 'eq': return value === filter.value;
    case 'contains': return typeof value === 'string' && value.includes(String(filter.value));
    case 'glob': return typeof value === 'string' && monitorGlob(String(filter.value),value);
    case 'changed': return Object.keys(previous).length > 0 && JSON.stringify(value) !== JSON.stringify(fieldValue(previous,filter.field));
    case 'gt': return typeof value === 'number' && value > Number(filter.value);
    case 'gte': return typeof value === 'number' && value >= Number(filter.value);
    case 'lt': return typeof value === 'number' && value < Number(filter.value);
    case 'lte': return typeof value === 'number' && value <= Number(filter.value);
  }
}
export function parseSemanticFilter(raw:unknown): SemanticFilter | null {
  if (raw == null) return null;
  const f = raw as SemanticFilter;
  if (!f || typeof f.field !== 'string' || !fields.test(f.field) || f.field.length > 120 || typeof f.query !== 'string' || !f.query.trim() || f.query.length > 2000
    || typeof f.threshold !== 'number' || !Number.isFinite(f.threshold) || f.threshold < -1 || f.threshold > 1) throw Error('Semantic filter needs field, query (1–2000 characters), and cosine threshold (-1 to 1).');
  return { field:f.field,query:f.query,threshold:f.threshold };
}
