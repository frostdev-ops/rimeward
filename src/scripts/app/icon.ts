// Client icon renderer — the DOM twin of components/Icon.astro. Reads the
// theme's icon slice off <html data-icons> (themeHtmlAttrs stamps it, the live
// editor restamps it) and draws a semantic id as emoji text, a currentColor
// mask, or an <img> for the colour weather art. Every icon carries data-icon
// so repaintIcons() can redraw the page when the theme changes under it.

import { iconRef, type IconCfg } from '../../lib/icon-names.ts';

const OWN = new Set(['fd-ic', 'fd-ic-e', 'fd-ic-img']);

// Resolve CSS colors (including light-dark/oklch) through the browser, then
// keep the chosen tint only when it has at least 3:1 contrast on the button.
let colorCanvas: CanvasRenderingContext2D | null;
const watchedButtons = new WeakSet<HTMLElement>();
export function fitButtonIconTint(button: HTMLElement): void {
  if (!button.isConnected) return;
  if (!watchedButtons.has(button)) {
    watchedButtons.add(button);
    for (const event of ['pointerenter', 'pointerleave', 'transitionend']) {
      button.addEventListener(event, () => fitButtonIconTint(button));
    }
  }
  button.style.removeProperty('--fd-icon-color');
  const style = getComputedStyle(button);
  const tint = style.getPropertyValue('--fd-icon-color').trim();
  if (!tint || tint === 'currentColor') return;
  colorCanvas ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!colorCanvas) return;
  const rgb = (color: string) => {
    colorCanvas!.clearRect(0, 0, 1, 1);
    colorCanvas!.fillStyle = color;
    colorCanvas!.fillRect(0, 0, 1, 1);
    return Array.from(colorCanvas!.getImageData(0, 0, 1, 1).data).slice(0, 3);
  };
  const luminance = (channels: number[]) => channels.reduce((sum, channel, i) => {
    const s = channel / 255;
    return sum + (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!;
  }, 0);
  const background = rgb(style.backgroundColor);
  const opacity = Number(style.getPropertyValue('--fd-icon-opacity').trim() || 1);
  const foreground = rgb(tint).map((c, i) => c * opacity + background[i]! * (1 - opacity));
  const a = luminance(foreground), b = luminance(background);
  if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 3) {
    button.style.setProperty('--fd-icon-color', style.color);
  }
}

function cfg(): IconCfg | null {
  const s = document.documentElement.dataset.icons;
  try {
    return s ? (JSON.parse(s) as IconCfg) : null;
  } catch {
    return null;
  }
}

export function icon(id: string, cls = '', title?: string): HTMLElement {
  const r = iconRef(cfg(), id);
  let n: HTMLElement;
  if (r.kind === 'text') {
    n = document.createElement('span');
    n.className = 'fd-ic-e';
    n.textContent = r.text;
  } else if (r.kind === 'img') {
    const i = document.createElement('img');
    i.className = 'fd-ic-img';
    i.src = r.url;
    i.alt = '';
    n = i;
  } else {
    n = document.createElement('span');
    n.className = 'fd-ic';
    n.style.setProperty('--ic', `url("${r.url}")`);
  }
  if (cls) n.className += ` ${cls}`;
  n.dataset.icon = id;
  requestAnimationFrame(() => {
    const button = n.closest<HTMLElement>('.btn-primary');
    if (button) fitButtonIconTint(button);
  });
  if (title) n.title = title;
  return n;
}

/** Redraw every icon on the page from the current <html data-icons>. */
export function repaintIcons(): void {
  for (const old of document.querySelectorAll<HTMLElement>('[data-icon]')) {
    const extra = [...old.classList].filter((c) => !OWN.has(c)).join(' ');
    old.replaceWith(icon(old.dataset.icon!, extra, old.title || undefined));
  }
}

/** A toolbar button is icon + label; the label hides on narrow screens
 *  (.tb-label in frost.css), so the icon and the aria-label carry it. */
export function relabel(b: HTMLElement, id: string, text: string): void {
  const label = document.createElement('span');
  label.className = 'tb-label';
  label.textContent = text;
  b.replaceChildren(icon(id), label);
  b.setAttribute('aria-label', text);
  b.title = text;
}
