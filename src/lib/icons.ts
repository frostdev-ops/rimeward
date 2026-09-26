// Server half of the icon catalogue: resolves an Iconify set + name + style to
// an SVG string for /api/icon. The JSON sets are loaded lazily and once — the
// bigger ones are ~10 MB, and a user on emoji never touches them.

import { createRequire } from 'node:module';
import type { IconifyJSON } from '@iconify/types';
import { getIconData, iconToHTML, iconToSVG, replaceIDs } from '@iconify/utils';
import { ICON_SETS, type IconSet } from './icon-names.ts';

const require = createRequire(import.meta.url);
const loaded = new Map<string, IconifyJSON>();

function setJson(pkg: string): IconifyJSON {
  let j = loaded.get(pkg);
  if (!j) {
    j = require(`@iconify-json/${pkg}/icons.json`) as IconifyJSON;
    loaded.set(pkg, j);
  }
  return j;
}

/** SVG markup, or null when the set has no such icon. An unknown style — or a
 *  style the icon lacks (Tabler's filled is partial) — falls back to the base.
 *  `still` drops the SMIL animation (Meteocons): the drops and flakes that
 *  only fade in while animating are shown at full opacity instead. */
export function iconSvg(set: IconSet, name: string, style = '', stroke?: number, still = false): string | null {
  const def = ICON_SETS[set];
  if (!def?.pkg) return null;
  const json = setJson(def.pkg);
  const suffix = def.styles[style] ?? '';
  const data = getIconData(json, name + suffix) ?? getIconData(json, name);
  if (!data) return null;
  const r = iconToSVG(data, { height: 'auto' });
  let body = replaceIDs(r.body);
  if (def.stroke && stroke) body = body.replace(/stroke-width="[\d.]+"/g, `stroke-width="${stroke}"`);
  if (still) body = body.replace(/<animate[A-Za-z]*\b[^>]*\/>/g, '').replace(/ opacity="0"/g, '');
  return iconToHTML(body, r.attributes);
}
