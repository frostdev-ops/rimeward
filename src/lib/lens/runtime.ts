// Boot wiring for the bundled screen lens: the push channel from Rust, the
// user's consent, and pause. Desktop only — on a server none of this exists and
// `SOURCES.screen` is never registered, which is what makes the ward and the
// tools say so (plan D7: consent and pause are runtime state, never layout).

import { LENS_SETTINGS, lens } from './core.ts';
import type { Decider, LensSettings } from './core.ts';
import { deciderFor, helperDecider } from './decider.ts';
// Importing the module is what registers `SOURCES.screen` on a desktop.
import { applyNativeState, nativeState, onHelperSignal, pushSignal } from './screen.ts';
import { screenOffline } from './types.ts';
import { lensPaused, setLensPausedRow, lensSetting, setLensSettings } from './settings.ts';
import { localOwner } from '../dev/native.ts';
import { nativeDesktop } from '../dev/remote.ts';
import { isDesktop } from '../dev/runtime.ts';
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

/** The gate knobs are the Screen lens ward's (wards.ts clamps them); with no
 *  such ward the core's own defaults stand.
 *
 *  The core asks per dirty rectangle, which is per captured frame, so the answer
 *  is memoised: reading it is a row read, a JSON parse and a whole
 *  `validateLayout`, and a scrolling window must not pay that at frame rate.
 *  ponytail: a one-second memo rather than an invalidation pushed from
 *  `saveDashboard` — `dashboards.updated_at` has one-second resolution anyway,
 *  so this is the same freshness for none of the wiring. */
const KNOBS_TTL_MS = 1000;
let knobs: { user: number; at: number; value: LensSettings } | null = null;

const screenSettings = (user: number) => (): LensSettings => {
  const now = Date.now();
  if (knobs && knobs.user === user && now - knobs.at < KNOBS_TTL_MS) return knobs.value;
  const cfg = lensWardConfig(user);
  const value: LensSettings = {
    settleMs: typeof cfg?.settleMs === 'number' ? cfg.settleMs : LENS_SETTINGS.settleMs,
    minLines: typeof cfg?.minLines === 'number' ? cfg.minLines : LENS_SETTINGS.minLines,
  };
  knobs = { user, at: now, value };
  return value;
};

function lensWardConfig(user: number): { settleMs?: unknown; minLines?: unknown } | undefined {
  try {
    return getDashboard(user).find((w) => w.type === 'lens')?.config as { settleMs?: unknown; minLines?: unknown } | undefined;
  } catch {
    return undefined; // no layout yet (first boot): the defaults stand
  }
}

// The row itself lives with the lens' other settings (lens/settings.ts), where a
// reader that is not the runtime — the tools' receipts — can ask for it.
export { lensPaused };

/** Pause stops the capture itself: no frames, no signals, so no deliveries. */
export function setLensPaused(user: number, paused: boolean): void {
  setLensPausedRow(user, paused);
  if (isDesktop()) void startLens();
}

let attached = false;
let readers = 0;
let syncing: Promise<string | null> = Promise.resolve(null);

/** Only live subscriptions and in-flight readers count; saved consumers do not. */
export async function screenDemand(active: boolean): Promise<void> {
  readers += active ? 1 : -1;
  await startLens();
}

/** Installs the signal channel and stored consent. Capture stays stopped until
 *  a live reader needs it; retries never turn an idle lens on. */
export function ensureLens(): void {
  if (!isDesktop()) return;
  if (!attached) {
    attached = true;
    (globalThis as LensGlobal).__lensAttach?.((_line: string, signal: Record<string, unknown>) => pushSignal(signal));
    // Built here and nowhere else, so the ward's knobs reach it: `lens()` keeps
    // one core per (user, source), and whoever reads it next gets this one.
    lens(localOwner(), SCREEN_SOURCE, screenSettings(localOwner()));
    // The helper comes up on its own schedule, and may go down and come back;
    // each state change is a reason to ask what it can answer now.
    onHelperSignal(() => void syncDecider());
  }
  void startLens();
}

/** Installs the helper as the screen's decider once the app says the on-device
 *  text tower is loadable, and takes it away again when it is not. Swapped on
 *  the LIVE core — the helper coming up is no more a reason to rebuild it than
 *  a consent toggle is, and a rebuild would drop every cursor — so the stored
 *  watches are re-embedded and re-scored in place.
 *  (Track D adds the local and cloud deciders through the same call.) */
async function syncDecider(status?: unknown): Promise<void> {
  const reply = status ?? (await nativeDesktop('lens-status').catch(() => null));
  const capabilities = helperCapabilities(reply);
  // A read that failed says nothing about the helper. Only an explicit answer
  // takes it away: a dropped tunnel would otherwise disarm every `for` watch.
  if (!capabilities) return;
  const core = lens(localOwner(), SCREEN_SOURCE, screenSettings(localOwner()));
  // One instance, so a helper state change that says nothing new (a recovery,
  // a rate-limit window) is identity-equal and re-embeds nothing.
  if (capabilities.embed) helper ??= helperDecider(nativeDesktop);
  // `deciderFor` composes the rest per capability (local embeddings, cloud
  // triage behind the ward switch) and hands back the same instance while the
  // parts are unchanged.
  await core?.setDecider(deciderFor(localOwner(), capabilities.embed ? helper : undefined));
}

/** What a `lens-status` reply says the helper can do, or null when it is not a
 *  reply at all (the read threw, the app is gone). */
export function helperCapabilities(reply: unknown): { embed: boolean } | null {
  if (!reply || typeof reply !== 'object') return null;
  const capabilities = (reply as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== 'object') return null;
  return { embed: (capabilities as { embed?: unknown }).embed === true };
}

let helper: Decider | undefined;

/** Tells Rust what the user answered. Returns the refusal, if any: `permission`
 *  is Screen Recording, which the setup page points at. */
export function startLens(): Promise<string | null> {
  syncing = syncing.then(syncCapture, syncCapture);
  return syncing;
}

/** What the last `lens-start` said about demand: the app writes one
 *  `lens-demand` diagnostics line per crossing of zero. Tracked here rather
 *  than in `screenDemand` because this is where `active` is actually sent, so
 *  the line can never disagree with the op it rode on. */
let lastDemand: boolean | null = null;

async function syncCapture(): Promise<string | null> {
  if (!isDesktop()) return null;
  const consented = lensSetting('consented');
  const core = lens(localOwner(), SCREEN_SOURCE, screenSettings(localOwner()));
  const active = readers > 0;
  // Node cannot append to the app's diagnostics file, so the transition rides
  // the op the app already answers. One line, only when demand crossed zero:
  // a capture running with no reader on record could not otherwise be explained.
  const why = lastDemand === active ? undefined : `${active ? 'on' : 'off'} readers=${readers}`;
  lastDemand = active;
  try {
    // `lens-start` answers with the whole status, so the decider is synced from
    // that reply rather than a second round trip.
    const status = await nativeDesktop('lens-start', { consented, active, paused: lensPaused(localOwner()), ...(why ? { why } : {}) });
    await syncDecider(status);
    // The same reply says whether anything is capturing at all. The source only
    // ever learns it went down from a `status stopped` TRANSITION, and there is
    // none when nothing was ever running: without this an unconsented lens
    // reads as a live, empty screen, which is what every tool then reported.
    applyNativeState(core, status);
    return null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The refusal IS the reason: `lens-start` answers `not-consented` or
    // `permission` by throwing, and nothing is capturing after it.
    core?.feed.offline(screenOffline(reason));
    return reason;
  }
}

/** The Screen lens switch. The core outlives it either way: consent withdrawn
 *  stops the capture, which the source reports as offline, and consent given
 *  back brings the same core live again (lens/screen.ts `status`), so every
 *  bound leyline, monitor and conversation keeps its cursor. */
export async function setLensConsent(consented: boolean): Promise<string | null> {
  setLensSettings({ consented });
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

/** What the app itself says it is doing, or null where there is no app to ask.
 *  `state` is `warming | running | idle | paused | stopped`, and `offline` is
 *  why it is not reading (lens/screen.ts `nativeState`, the one decode the
 *  screen source's own connect shares). */
export async function lensNativeStatus(): Promise<{ state: string; screen: boolean; ax: boolean; offline: string | null } | null> {
  if (!isDesktop()) return null;
  return nativeState(await nativeDesktop('lens-status').catch(() => null));
}

/** What the setup page's Screen lens switch draws. Retrying a grant only
 *  starts capture when a live reader is still waiting for it. */
export async function lensConsentStatus(error: string | null = null): Promise<LensConsentStatus> {
  const consented = lensSetting('consented');
  if (!isDesktop()) {
    return { consented, paused: false, state: 'unsupported', screen: false, ax: false, error };
  }
  const failed = error ?? (consented ? await startLens() : null);
  const status = await lensNativeStatus();
  return {
    consented,
    paused: lensPaused(localOwner()),
    state: status?.state ?? 'unsupported',
    screen: status?.screen === true,
    ax: status?.ax === true,
    error: failed,
  };
}
