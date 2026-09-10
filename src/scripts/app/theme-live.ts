// Applying a ThemeConfig to the live page — the client half of the same
// derivation the server does in themeHtmlAttrs(). Two callers, and they must
// stay identical: the account editor's live preview, and a theme the agent
// changed arriving on the logic SSE stream.
//
// Everything here is a write to <html>; frost.css derives the actual colours
// off those attributes and knob vars. The three.js scenes are the exception —
// they go through background.ts, the one writer of the scene canvases.

import { bgKind, headerSceneConfig, sceneConfig, themeHtmlAttrs, type ThemeConfig } from '../../lib/theme.ts';
import { applyBackground, applyHeaderScene } from './background.ts';
import { ensureFonts } from './fonts.ts';
import { fitButtonIconTint, repaintIcons } from './icon.ts';

export function applyThemeLive(cfg: ThemeConfig): void {
  const html = document.documentElement;
  // The page shipped only the faces it was already painting; whatever this
  // config names has to arrive before it can render. No-ops for a face that
  // is already here, so a slider drag costs nothing.
  ensureFonts([cfg.uiFont, cfg.brandFont]);
  const attrs = themeHtmlAttrs(cfg);
  html.setAttribute('style', attrs.style!);
  html.setAttribute('data-themed', '');
  html.setAttribute('data-mode', cfg.mode);
  const flag = (name: string, on: boolean) => (on ? html.setAttribute(name, '') : html.removeAttribute(name));
  flag('data-glass', attrs['data-glass'] !== undefined);
  flag('data-glass-blur', attrs['data-glass-blur'] !== undefined);
  flag('data-hdr-sweep', cfg.hdrSweep > 0);
  flag('data-surfaced', cfg.surfaceCustom);
  flag('data-brand-fx', attrs['data-brand-fx'] !== undefined);
  flag('data-icon-tint', attrs['data-icon-tint'] !== undefined);
  // Icons read the attribute at draw time, so restamp THEN redraw the page's.
  const icons = attrs['data-icons'];
  if (icons !== html.getAttribute('data-icons')) {
    if (icons === undefined) html.removeAttribute('data-icons');
    else html.setAttribute('data-icons', icons);
    repaintIcons();
  }
  if (cfg.brandPos === 'left') html.removeAttribute('data-brand-pos');
  else html.setAttribute('data-brand-pos', cfg.brandPos);
  // The wordmark and the logo are DOM, not vars — the only part of a theme
  // that is. AppLayout stamped the built-in mark's URL on the <img>.
  const text = document.getElementById('brand-text');
  if (text) text.textContent = cfg.brandText;
  const logo = document.getElementById('brand-logo') as HTMLImageElement | null;
  if (logo) logo.src = cfg.brandLogo ? `/api/bg/${cfg.brandLogo}` : logo.dataset.default!;
  const kind = bgKind(cfg);
  if (kind === 'flat') html.removeAttribute('data-bg');
  else html.setAttribute('data-bg', kind);
  applyBackground(kind === 'scene' ? sceneConfig(cfg) : null);
  applyHeaderScene(headerSceneConfig(cfg));
  // 'system' follows the OS; the class is what frost.css actually reads.
  const light = cfg.mode === 'light' || (cfg.mode === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  html.classList.toggle('dark', !light);
  document.querySelectorAll<HTMLElement>('.btn-primary').forEach(fitButtonIconTint);
}
