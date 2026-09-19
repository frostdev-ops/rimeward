// Pure render helpers for the overlay page: no DOM, no Tauri, no globals.
// Lifted from BlackIce overlay/render.ts; plain ESM, because `frontendDist` is
// this folder as it stands — nothing builds it.

/** A card shows at most this many lines. The rest is dropped and the last line fades. */
export const CARD_LINES = 6;

/** @param {string} text @returns {{lines: string[], truncated: boolean}} */
export function cardLines(text) {
  const all = text.replace(/\s+$/, '').split('\n');
  return { lines: all.slice(0, CARD_LINES), truncated: all.length > CARD_LINES };
}

/**
 * `text` is either the JSON per-line form `{items:[{rect:[x,y,w,h], text}]}` with rects
 * in the target window's points, or plain text (one centred caption). `origin` is this
 * overlay window's own top-left in those same window points, so an item is placed at
 * `rect.xy - origin` inside the window.
 *
 * @param {string} text
 * @param {[number, number]} origin
 */
export function caption(text, origin) {
  const items = parseItems(text);
  if (!items) return { form: 'single', text };
  const [ox, oy] = origin;
  return {
    form: 'items',
    items: items.map((it) => ({
      left: it.rect[0] - ox,
      top: it.rect[1] - oy,
      width: it.rect[2],
      height: it.rect[3],
      text: it.text,
    })),
  };
}

function parseItems(text) {
  if (text.charCodeAt(0) !== 123 /* { */) return null; // screen text is rarely JSON
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const items = value?.items;
  if (!Array.isArray(items)) return null;
  const out = [];
  for (const it of items) {
    const r = it?.rect;
    if (typeof it?.text !== 'string') return null;
    if (!Array.isArray(r) || r.length < 4) return null;
    if (!r.slice(0, 4).every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    out.push({ rect: [r[0], r[1], r[2], r[3]], text: it.text });
  }
  return out;
}
