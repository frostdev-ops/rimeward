// Boot wiring for the bundled screen lens: the push channel from Rust, the
// user's consent, and pause. Desktop only — on a server none of this exists and
// `SOURCES.screen` is never registered, which is what makes the ward and the
// tools say so (plan D7: consent and pause are runtime state, never layout).

import { releaseLens } from './core.ts';
// Importing the module is what registers `SOURCES.screen` on a desktop.
import { pushSignal } from './screen.ts';
import { lensSetting, setLensSettings } from './settings.ts';
import { localOwner } from '../dev/native.ts';
import { nativeDesktop } from '../dev/remote.ts';
import { isDesktop } from '../dev/runtime.ts';
import { getSetting, setSetting } from '../settings.ts';
import { getDashboard } from '../dashboard.ts';
import type { WardInstance } from '../wards.ts';

/** The one screen per process (plan D5). */
export const SCREEN_SOURCE = 'screen:local';

type LensGlobal = typeof globalThis & {
  __lensAttach?: (fn: (line: string, signal: Record<string, unknown>) => void) => void;
};

/** The user's Screen lens ward, if they have one: what the ward route checks
 *  before it answers, and where the lens knobs live. */
export function lensWard(userId: number, ward: unknown): WardInstance | null {
  return getDashboard(userId).find((w) => w.i === ward && w.type === 'lens') ?? null;
}

const pausedKey = (user: number): string => `lens:paused:${user}`;

export const lensPaused = (user: number): boolean => getSetting(pausedKey(user)) === '1';

/** Pause stops the capture itself: no frames, no signals, so no deliveries. */
export function setLensPaused(user: number, paused: boolean): void {
  setSetting(pausedKey(user), paused ? '1' : '0');
  if (isDesktop()) void nativeDesktop(paused ? 'lens-pause' : 'lens-resume').catch(() => {});
}

let attached = false;

/** Installs the signal channel and hands Rust the stored consent. Idempotent,
 *  and every later call is the retry the ungranted case needs: with consent
 *  stored but Screen Recording not granted, `lens-start` answers `permission`
 *  and the setting stands — the next call starts the capture for real. */
export function ensureLens(): void {
  if (!isDesktop()) return;
  if (!attached) {
    attached = true;
    (globalThis as LensGlobal).__lensAttach?.((_line: string, signal: Record<string, unknown>) => pushSignal(signal));
  }
  void startLens();
}

/** Tells Rust what the user answered. Returns the refusal, if any: `permission`
 *  is Screen Recording, which the setup page points at. */
export async function startLens(): Promise<string | null> {
  if (!isDesktop()) return null;
  const consented = lensSetting('consented');
  try {
    await nativeDesktop('lens-start', { consented });
    if (consented && lensPaused(localOwner())) await nativeDesktop('lens-pause');
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The Screen lens switch. Turning it back on rebuilds the core: the one that
 *  was told its source went offline can never be told otherwise. */
export async function setLensConsent(consented: boolean): Promise<string | null> {
  setLensSettings({ consented });
  if (consented) releaseLens(localOwner(), SCREEN_SOURCE);
  return startLens();
}

export interface LensConsentStatus {
  consented: boolean;
  paused: boolean;
  /** `warming | running | idle | paused | stopped`, or `unsupported` off the app. */
  state: string;
  /** Screen Recording, the one grant the lens cannot run without. */
  screen: boolean;
  ax: boolean;
  error: string | null;
}

/** What the setup page's Screen lens switch draws. Reading it is also the retry:
 *  a lens consented to before Screen Recording was granted starts here. */
export async function lensConsentStatus(error: string | null = null): Promise<LensConsentStatus> {
  const consented = lensSetting('consented');
  if (!isDesktop()) {
    return { consented, paused: false, state: 'unsupported', screen: false, ax: false, error };
  }
  const failed = error ?? (consented ? await startLens() : null);
  const status = (await nativeDesktop('lens-status').catch(() => null)) as Record<string, unknown> | null;
  const permissions = (status?.permissions ?? {}) as { screen?: unknown; ax?: unknown };
  return {
    consented,
    paused: lensPaused(localOwner()),
    state: typeof status?.state === 'string' ? status.state : 'unsupported',
    screen: permissions.screen === true,
    ax: permissions.ax === true,
    error: failed,
  };
}
