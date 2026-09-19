// The lens' own settings, lifted from BlackIce src/settings.ts onto Rimeward's
// settings table: one `lens:<key>` row per value, JSON text, same defaults.
// `consented` is the user's answer to the Screen lens switch (plan D7) — the one
// thing that lets the desktop app capture anything at all; the gate knobs are
// the ward's (lens/runtime.ts) and `caption_from`/`caption_to` are the pair the
// last `lens_captions` call settled on, so turning captions on again reuses it.
//
// This is a network boundary: an unknown key, or a known key with the wrong
// type, is ignored rather than stored.

import { getSetting, setSetting } from '../settings.ts';

export interface LensSettings {
  consented: boolean;
  caption_from: string | null;
  caption_to: string | null;
}

export const LENS_SETTINGS_DEFAULTS: LensSettings = {
  consented: false,
  caption_from: null,
  caption_to: null,
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

/** Pause is per user and per computer: the Screen lens keeps its consent and
 *  its consumers, and simply stops capturing (lens/runtime.ts `setLensPaused`
 *  is what tells the app). It lives here, beside the lens' other rows, so a
 *  reader does not have to reach into the runtime to ask.
 *  ponytail: one row per user rather than a column — there is one screen. */
const pausedKey = (user: number): string => `lens:paused:${user}`;

export const lensPaused = (user: number): boolean => getSetting(pausedKey(user)) === '1';

export const setLensPausedRow = (user: number, paused: boolean): void => setSetting(pausedKey(user), paused ? '1' : '0');
