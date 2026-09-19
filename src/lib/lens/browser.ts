// The browser lens source: one document per browser ward, one line per block of
// text on its active tab, geometry in CSS pixels straight from
// `getBoundingClientRect`. The ward's session is read exactly the way the
// browser monitor branch reads it today — `peek`, never `open`: a lens never
// starts a browser, and a ward whose session is not running is simply offline
// until it is.
//
// The page-side reader (`readInPage`, below) is READ ONLY: it walks text nodes,
// measures their block, and watches for mutations. It synthesises no input, and
// it is the only script this module puts in a page.

import { SOURCES, systemClock } from './core.ts';
import type { Clock, Feed, Source, SourceSnapshot } from './core.ts';
import type { Draft } from './doc.ts';
import type { MetaField, Rect } from './types.ts';

/** How often the page is re-read while a consumer is bound to it. A read that
 *  finds nothing changed costs one round trip and returns null, and nothing
 *  polls at all until something reads this ward's lens.
 *  ponytail: a poll, because a page cannot push. It is deliberately shorter
 *  than the 750 ms settle — three reads inside one settle window are what let a
 *  burst of mutations coalesce into one delta and a ticker become live. */
export const POLL_MS = 250;
/** A repaint, loud enough for the live detector and quiet enough never to be a
 *  visual candidate (the terminal source uses the same value for the same reason). */
const REPAINT_D = 0.1;
/** Blocks per read, and characters per block. */
const NODE_CAP = 500;
const TEXT_CAP = 1000;
/** The page-side reader's global. */
const MARKER = 'rimeLensReader';

export interface PageRead {
  url: string;
  title: string;
  /** This read installed the reader: the page is a new document (a navigation). */
  fresh: boolean;
  nodes: { text: string; rect: Rect }[];
  /** Rectangles that repainted since the last read. */
  changed: Rect[];
}

export interface BrowserDeps {
  /** One read of the ward's page, or null when nothing changed since the last
   *  one. Throws when the ward has no running session. */
  read(user: number, ward: string, force: boolean): Promise<PageRead | null>;
  /** Drop the page-side reader; best effort, the page may be gone. */
  release?(user: number, ward: string): void;
  clock?: Clock;
  every?: number;
}

// --------------------------------------------------------- the page-side read

/** Runs IN THE PAGE (`page.evaluate`), so it closes over nothing: everything it
 *  needs arrives as its one argument. One line per block-level element that
 *  carries text — the inline runs inside a paragraph are that paragraph, which
 *  is what keeps a bold word from being a line of its own. */
function readInPage({ marker, force, cap, chars }: { marker: string; force: boolean; cap: number; chars: number }): PageRead | null {
  const scope = window as unknown as Record<string, any>;
  let state = scope[marker] as { dirty: boolean; changed: Rect[]; observer: MutationObserver } | undefined;
  const fresh = !state;
  if (!state) {
    const next = {
      dirty: true,
      changed: [] as Rect[],
      observer: null as unknown as MutationObserver,
    };
    next.observer = new MutationObserver((records) => {
      next.dirty = true;
      for (const record of records) {
        if (next.changed.length >= 64) break;
        const node = record.target.nodeType === 1 ? (record.target as Element) : record.target.parentElement;
        if (!node) continue;
        const box = node.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          next.changed.push([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]);
        }
      }
    });
    next.observer.observe(document, { subtree: true, childList: true, characterData: true });
    // Scrolling and resizing move every box without mutating anything: they ask
    // for a re-read, and carry no repaint of their own — the lines then only
    // move, which is no version bump and no delivery.
    const touched = (): void => {
      next.dirty = true;
    };
    addEventListener('scroll', touched, { passive: true, capture: true });
    addEventListener('resize', touched, { passive: true });
    state = next;
    scope[marker] = next;
  }
  if (!fresh && !force && !state.dirty) return null;
  state.dirty = false;
  const changed = state.changed.splice(0);

  const blocks = new Map<Element, string[]>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && blocks.size < cap; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let element: Element | null = node.parentElement;
    if (!element || element.closest('script,style,noscript,template')) continue;
    while (element && element !== document.body) {
      const display = getComputedStyle(element).display;
      if (display && display !== 'contents' && !display.startsWith('inline')) break;
      element = element.parentElement;
    }
    const block = element ?? document.body;
    const group = blocks.get(block);
    if (group) group.push(text);
    else blocks.set(block, [text]);
  }

  const nodes: { text: string; rect: Rect }[] = [];
  for (const [block, parts] of blocks) {
    const box = block.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    nodes.push({
      text: parts.join(' ').slice(0, chars),
      rect: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
    });
  }
  return { url: location.href, title: document.title, fresh, nodes, changed };
}

/** The ward's session as it stands. `peek`, never `open`. ponytail: the main
 *  frame only — an iframe needs its own read, and a `frame` header field with it. */
async function evaluateRead(user: number, ward: string, force: boolean): Promise<PageRead | null> {
  // Imported here rather than at the top: this module is loaded wherever the
  // lens registry is, and playwright is not something a server that owns no
  // browser ward should pay for.
  const { peek } = await import('../browser/session.ts');
  const session = peek(user, ward);
  if (!session || session.page.isClosed()) throw Error('Browser is offline; waiting for its session to reconnect.');
  session.lastUsed = Date.now();
  return (await session.page.evaluate(readInPage, { marker: MARKER, force, cap: NODE_CAP, chars: TEXT_CAP })) as PageRead | null;
}

function releasePage(user: number, ward: string): void {
  void import('../browser/session.ts')
    .then(({ peek }) => {
      const session = peek(user, ward);
      if (!session || session.page.isClosed()) return undefined;
      return session.page.evaluate((marker) => {
        const scope = window as unknown as Record<string, any>;
        scope[marker]?.observer?.disconnect();
        delete scope[marker];
      }, MARKER);
    })
    .catch(() => {});
}

// ---------------------------------------------------------------- the source

export function browserSource(deps: BrowserDeps): Source {
  const clock = deps.clock ?? systemClock;
  const every = deps.every ?? POLL_MS;
  let user = 0;
  let ward = '';
  let feed: Feed | null = null;
  let epoch = 0;
  /** Monotonic over the source's life; one read is one seq. */
  let seq = 0;
  let timer: unknown = null;
  let busy = false;
  let offline = false;
  let stopped = false;

  /** `url` LAST: it is the keyframe key, so every field before it is already in
   *  the document when the keyframe it forces is rendered. */
  const meta = (read: PageRead): Record<string, MetaField> => ({
    title: { value: read.title },
    url: { value: read.url },
  });
  /** No `key`: the document's default is the normalised text, which is exactly
   *  what `Draft.key` requires — two blocks reading the same are the same line,
   *  and `#adopt` tells duplicates apart by where they sit. */
  const drafts = (read: PageRead): Draft[] => read.nodes.map((node) => ({ text: node.text, src: 'dom', bbox: node.rect }));

  const apply = (read: PageRead): void => {
    if (!feed) return;
    const at = clock.now();
    const s = ++seq;
    // A new document is a new epoch: nothing the old page said survives it.
    if (read.fresh) {
      epoch += 1;
      feed.epoch(epoch, s);
    }
    for (const bbox of read.changed) feed.dirty({ bbox, d: REPAINT_D }, at);
    feed.ref(`${read.url}#${s}`);
    feed.replace(drafts(read), s);
    // The header last: `url` is what forces the keyframe, so writing it after
    // the lines is what makes that keyframe carry them.
    for (const [key, field] of Object.entries(meta(read))) feed.meta(key, field.value, s);
  };

  const tick = async (force = false): Promise<void> => {
    if (busy || stopped || !feed) return;
    busy = true;
    try {
      const read = await deps.read(user, ward, force);
      if (stopped || !feed) return;
      if (offline) {
        offline = false;
        feed.online();
      }
      if (read) apply(read);
    } catch (err) {
      if (!offline && feed) {
        offline = true;
        feed.offline(err instanceof Error ? err.message : String(err));
      }
    } finally {
      busy = false;
    }
  };

  const arm = (): void => {
    if (stopped) return;
    timer = clock.setTimeout(() => void tick().finally(arm), every);
    (timer as { unref?: () => void } | null)?.unref?.();
  };

  return {
    // A navigation IS the observation: the header change is what carries it.
    keyframeOn: ['url'],
    // A page's text goes as freely as it arrives, so a delta says what left.
    removals: true,
    // Nothing is a delivery on its own. A title that ticks ("(3) Inbox", a call
    // timer) would otherwise deliver once a second; the text beside it is what
    // an observation is, and a navigation keyframes through `url` anyway.
    ruleKeys: [],

    async connect(u, t, f): Promise<() => void> {
      user = u;
      ward = t;
      feed = f;
      stopped = false;
      await tick();
      arm();
      return () => {
        stopped = true;
        clock.clearTimeout(timer);
        feed = null;
        deps.release?.(user, ward);
      };
    },

    async snapshot(): Promise<SourceSnapshot | null> {
      if (!feed) return null;
      const read = await deps.read(user, ward, true).catch(() => null);
      if (!read) return null;
      if (read.fresh) epoch += 1;
      const s = ++seq;
      return { epoch, seq: s, meta: meta(read), lines: drafts(read), ref: `${read.url}#${s}` };
    },
  };
}

SOURCES.browser = (): Source => browserSource({ read: evaluateRead, release: releasePage });
