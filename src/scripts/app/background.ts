// Mounts (and unmounts) the three.js scenes. Tiny and sync — three itself
// arrives through the dynamic import of bg-scene.ts, so a user with no scene
// anywhere never downloads it.
//
// Two surfaces, one mount path: the full-screen page background and the header
// banner. Both are a SceneConfig on a canvas, so the only difference is which
// element hosts the canvas. Null (or a non-scene background) tears that
// surface's canvas down and leaves the other alone.
//
// One writer per surface: the SSR boot and the account editor's live preview
// both come through here.
import type { SceneConfig } from '../../lib/theme.ts';
import type { BgHandle } from './bg-scene.ts';

interface Slot {
  /** Canvas id, and where it gets prepended. */
  readonly id: string;
  readonly host: () => HTMLElement | null;
  canvas: HTMLCanvasElement | null;
  handle: BgHandle | null;
  importing: boolean;
  wanted: SceneConfig | null;
}

const PAGE: Slot = {
  id: 'fd-bg-canvas',
  host: () => document.body,
  canvas: null,
  handle: null,
  importing: false,
  wanted: null,
};
const HEADER: Slot = {
  id: 'fd-hdr-canvas',
  host: () => document.querySelector('.app-header'),
  canvas: null,
  handle: null,
  importing: false,
  wanted: null,
};

function teardown(s: Slot) {
  s.handle?.destroy();
  s.handle = null;
  s.canvas?.remove();
  s.canvas = null;
}

function apply(s: Slot, cfg: SceneConfig | null): void {
  // Pop-outs own only their ward. Decline before allocating a canvas or importing WebGL,
  // including later live theme changes received from the dashboard.
  if (document.documentElement.hasAttribute('data-ward-window')) cfg = null;
  s.wanted = cfg;
  if (!cfg) {
    teardown(s);
    return;
  }
  if (!s.canvas) {
    // No host (the header on a layout that has none) — nothing to mount into.
    const host = s.host();
    if (!host) return;
    s.canvas = document.createElement('canvas');
    s.canvas.id = s.id;
    s.canvas.setAttribute('aria-hidden', 'true');
    host.prepend(s.canvas);
  }
  if (s.handle) {
    s.handle.update(cfg);
    return;
  }
  if (s.importing) return; // the in-flight load will pick up `wanted`
  s.importing = true;
  void import('./bg-scene.ts')
    .then((m) => {
      s.importing = false;
      if (!s.wanted || !s.canvas) return;
      s.handle = m.createBgScene(s.canvas, s.wanted);
      if (!s.handle) teardown(s); // no WebGL — the flat token background stays
    })
    .catch(() => {
      s.importing = false;
      teardown(s);
    });
}

/** The full-screen page background. */
export const applyBackground = (cfg: SceneConfig | null): void => apply(PAGE, cfg);

/** The header banner. No-ops on layouts without an .app-header. */
export const applyHeaderScene = (cfg: SceneConfig | null): void => apply(HEADER, cfg);

/** Boot both from what the server stamped on <html> (theme.ts themeHtmlAttrs). */
export function bootBackground(): void {
  // A valley page (ValleyLayout) already owns the backdrop with its terrain at
  // the same z-index; a signed-in user's saved scene would paint over it.
  if (document.getElementById('valley-canvas') || document.documentElement.hasAttribute('data-ward-window')) return;
  const d = document.documentElement.dataset;
  for (const [raw, fn] of [
    [d.bgCfg, applyBackground],
    [d.hdrCfg, applyHeaderScene],
  ] as const) {
    if (!raw) continue;
    try {
      fn(JSON.parse(raw) as SceneConfig);
    } catch {
      /* malformed attribute — no scene, no crash */
    }
  }
}
