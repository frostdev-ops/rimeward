// The terminal ward's pane tree: a group (one tab) is a leaf — a session id —
// or a split of two nodes. Pure; ships to the browser; the ward's saved view
// carries `groups: Node[]` in tab order. Presentation only: which sessions a
// ward shows is still `tabs`/`closedSessions`, and `reconcile` keeps the two
// in step whichever side changed.
export type Split = { dir: 'row' | 'col'; a: Node; b: Node; ratio: number };
export type Node = string | Split;
export type Side = 'left' | 'right' | 'top' | 'bottom';
/** Panes one group may hold: each is a live xterm (and a WebGL context). */
export const MAX_PANES = 8;

export const leaves = (n: Node): string[] => typeof n === 'string' ? [n] : [...leaves(n.a), ...leaves(n.b)];
export const has = (n: Node, id: string): boolean => typeof n === 'string' ? n === id : has(n.a, id) || has(n.b, id);

/** The tree without `id`; a split left with one side collapses to it. */
export function remove(n: Node, id: string): Node | null {
  if (typeof n === 'string') return n === id ? null : n;
  const a = remove(n.a, id), b = remove(n.b, id);
  if (a === null) return b;
  if (b === null) return a;
  return a === n.a && b === n.b ? n : { ...n, a, b };
}

/** `node` split beside the leaf `target` on `side`; unchanged when `target` is absent. */
export function insert(n: Node, target: string, node: Node, side: Side): Node {
  if (typeof n === 'string') {
    if (n !== target) return n;
    const dir = side === 'left' || side === 'right' ? 'row' : 'col';
    return side === 'left' || side === 'top' ? { dir, a: node, b: n, ratio: 0.5 } : { dir, a: n, b: node, ratio: 0.5 };
  }
  const a = insert(n.a, target, node, side), b = insert(n.b, target, node, side);
  return a === n.a && b === n.b ? n : { ...n, a, b };
}

export function swap(n: Node, x: string, y: string): Node {
  if (typeof n === 'string') return n === x ? y : n === y ? x : n;
  return { ...n, a: swap(n.a, x, y), b: swap(n.b, x, y) };
}

export function withRatio(n: Node, split: Split, ratio: number): Node {
  if (typeof n === 'string') return n;
  if (n === split) return { ...n, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
  return { ...n, a: withRatio(n.a, split, ratio), b: withRatio(n.b, split, ratio) };
}

/** A stored node, or null when the JSON is not one. */
export function parseNode(raw: unknown): Node | null {
  if (typeof raw === 'string') return /^[\w-]{1,64}$/.test(raw) ? raw : null;
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<Split>;
  if (s.dir !== 'row' && s.dir !== 'col') return null;
  const a = parseNode(s.a), b = parseNode(s.b);
  if (a === null || b === null) return null;
  const ratio = typeof s.ratio === 'number' && Number.isFinite(s.ratio) ? Math.max(0.1, Math.min(0.9, s.ratio)) : 0.5;
  return { dir: s.dir, a, b, ratio };
}

/** Groups holding exactly `visible`, in order: vanished leaves pruned, empty groups
 *  dropped, a session shown twice kept once, newcomers appended as their own tab,
 *  and no group above MAX_PANES (extras become tabs). */
export function reconcile(groups: readonly Node[], visible: readonly string[], cap = MAX_PANES): Node[] {
  const wanted = new Set(visible), seen = new Set<string>();
  const out: Node[] = [];
  for (const g of groups) {
    let n: Node | null = g;
    for (const id of leaves(g)) if (!wanted.has(id) || seen.has(id)) n = n === null ? null : remove(n, id); else seen.add(id);
    if (n === null) continue;
    const extras: string[] = [];
    for (let ids = leaves(n); ids.length > cap; ids = leaves(n)) {
      const last: string = ids[ids.length - 1] as string;
      n = remove(n, last) ?? last;
      extras.push(last);
    }
    out.push(n, ...extras);
  }
  for (const id of visible) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}
