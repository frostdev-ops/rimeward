/** Process-local event fanout. Durable monitor cursors/receipts live in SQLite. */
export interface ObservationEvent { user:number; source:string; target:string; key:string; data:Record<string,unknown>; baseline?:boolean }
const listeners = new Set<(event:ObservationEvent) => void>();
export function onObservation(fn:(event:ObservationEvent) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export function observe(event:ObservationEvent): void {
  for (const fn of listeners) { try { fn(event); } catch (e) { console.error('[observation]',e instanceof Error ? e.message : String(e)); } }
}
export function knowledgeChanged(user:number): void { observe({ user,source:'knowledge',target:'',key:'changed',data:{} }); }
