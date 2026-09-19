// What judges a change, when anything can (plan D6). One entry per capability
// source; this file holds the helper's, which is the bundled Swift sidecar's
// on-device model — MobileCLIP-S0 for the `for` prefilter, Foundation Models
// for triage and describe. Nothing here leaves the device.
//
// Track D adds the local (llama.cpp) and cloud (`askModel`) deciders and keys
// the calibration thresholds by `embedderId`; until then `calibration.json`'s
// numbers are this embedder's, measured on MobileCLIP-S0.

import type { Decider } from './core.ts';
import { CLOUD_FALLBACK } from './gate.ts';
import type { DescribeQuery, TriageQuery } from './gate.ts';

type Desktop = (op: string, value?: unknown, deadlineMs?: number) => Promise<unknown>;

/** The thresholds in `calibration.json` were measured against this embedder. */
export const HELPER_EMBEDDER = 'helper:mobileclip-s0';

const EMBED_MS = 5_000;
const TRIAGE_MS = 5_000;
const DESCRIBE_MS = 8_000;

/** A helper that is down, busy, rate-limited or without the model is one thing
 *  to a watch: nothing judged it. The real code stays in the desktop log. */
function reason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return CLOUD_FALLBACK.has(message) ? 'unavailable' : message;
}

/** The bundled helper as a decider. `desktop` is the native op channel, which
 *  rejects when the op is refused — including `assets-missing`, which is the
 *  model files never having been installed. */
export function helperDecider(desktop: Desktop): Decider {
  return {
    embedderId: HELPER_EMBEDDER,
    // Null, never a throw: the core reads it as "no vectors" and the watch
    // drops to triage-only rather than the whole round failing.
    embed: async (texts: string[]): Promise<number[][] | null> => {
      const reply = (await desktop('lens-embed', { texts }, EMBED_MS).catch(() => null)) as {
        vectors?: number[][];
      } | null;
      return Array.isArray(reply?.vectors) ? reply.vectors : null;
    },
    triage: async (q: TriageQuery): Promise<{ yes: boolean } | { error: string }> => {
      try {
        const reply = (await desktop('helper-triage', q, TRIAGE_MS)) as { yes?: boolean };
        return { yes: reply?.yes === true };
      } catch (err) {
        return { error: reason(err) };
      }
    },
    describe: async (q: DescribeQuery): Promise<{ json: unknown } | { error: string }> => {
      try {
        const reply = (await desktop('helper-describe', q, DESCRIBE_MS)) as { value?: { json?: unknown } };
        return { json: reply?.value?.json ?? null };
      } catch (err) {
        return { error: reason(err) };
      }
    },
  };
}
