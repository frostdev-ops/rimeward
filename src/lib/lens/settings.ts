// The lens' own settings, lifted from BlackIce src/settings.ts onto Rimeward's
// settings table: one `lens:<key>` row per value, JSON text, same defaults.
// `consented` is the user's answer to the Screen lens switch (plan D7) — the one
// thing that lets the desktop app capture anything at all.
//
// This is a network boundary: an unknown key, or a known key with the wrong
// type, is ignored rather than stored.

import { getSetting, setSetting } from '../settings.ts';

export interface LensSettings {
  consented: boolean;
  cloud_images: boolean;
  caption_from: string | null;
  caption_to: string | null;
  settle_ms: number;
  min_lines: number;
}

export const LENS_SETTINGS_DEFAULTS: LensSettings = {
  consented: false,
  cloud_images: false,
  caption_from: null,
  caption_to: null,
  settle_ms: 750,
  min_lines: 1,
};

const KEYS = Object.keys(LENS_SETTINGS_DEFAULTS) as (keyof LensSettings)[];
const row = (key: keyof LensSettings): string => `lens:${key}`;

export function lensSettings(): LensSettings {
  const out = { ...LENS_SETTINGS_DEFAULTS };
  for (const key of KEYS) {
    const stored = getSetting(row(key));
    if (stored === null) continue;
    try {
      Object.assign(out, { [key]: JSON.parse(stored) });
    } catch {
      // A hand-edited row must not take the app down; the default stands.
    }
  }
  return out;
}

export function lensSetting<K extends keyof LensSettings>(key: K): LensSettings[K] {
  return lensSettings()[key];
}

/** Writes only the known keys, with the type each one declares. */
export function setLensSettings(patch: Record<string, unknown>): LensSettings {
  for (const key of KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    const want = typeof LENS_SETTINGS_DEFAULTS[key];
    const ok =
      want === 'boolean'
        ? typeof value === 'boolean'
        : want === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : value === null || typeof value === 'string';
    if (!ok) continue;
    setSetting(row(key), JSON.stringify(value));
  }
  return lensSettings();
}
