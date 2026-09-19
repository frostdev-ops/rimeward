// The agent door onto the lens tools: which consumer a turn reads as, and the
// one call that resolves a source, runs the tool and hands the result back in
// the shape the device tool path expects (`src/lib/dev/tool-routing.ts`
// storeImage turns `image`/`imageMime` into a conversation-local file_id).

import { SOURCES, lens } from './core.ts';
import { LENS_TOOLS, RESULT_CAP } from './tools.ts';
import type { LensToolName } from './tools.ts';
import { AGENT_DELIVERY_CAP } from './types.ts';
import { DevError } from '../dev/runtime.ts';
import type { ToolCtx } from '../agent/tools.ts';

export const DEFAULT_SOURCE = 'screen:local';

/** core.ts drops a tool result whole once its JSON passes this, so the result
 *  is cut to whole lines here instead. Kept in step with OUTPUT_CAP there. */
const OUTPUT_CAP = 12_000;
/** What a tool renders against for this door. The rendered text is one JSON
 *  string field by the time the model sees it, and escaping a quote, a
 *  backslash or a newline costs a second character: the gap between this and
 *  OUTPUT_CAP is that overhead. A delivery is already budgeted the same way,
 *  per consumer kind, inside the core (lens/events.ts `deliveryCap`). */
const AGENT_CAP = AGENT_DELIVERY_CAP;

/** Who this turn reads a source as. A conversation is one consumer, so its
 *  cursor and its unacknowledged delivery survive between turns; a relayed
 *  agent-tool call arrives as ward `remote:<64 hex>` with no conversation of
 *  its own, and reads as that caller. Both stay inside `^[a-z0-9-]{1,40}$`. */
export function consumerOf(ctx: ToolCtx): string {
  if (ctx.conv) return `conv-${ctx.conv}`;
  // Anything else has no identity of its own, and sharing one cursor between
  // unrelated callers would hand each of them the other's deliveries.
  if (!ctx.ward.startsWith('remote:')) throw new DevError('A lens tool needs a conversation or a relayed caller to read as.');
  return `remote-${ctx.ward.slice(7, 39)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/** The write tools draw on the screen; they read no document, so they have no
 *  cursor and need no consumer. A leyline calls them with no conversation of
 *  its own (logic-engine `lensDeviceTool`), which `consumerOf` would refuse. */
const CONSUMERLESS = new Set<string>(['overlay_show', 'overlay_clear', 'lens_captions']);

export async function lensToolRun(name: LensToolName, args: Record<string, any>, ctx: ToolCtx): Promise<unknown> {
  const tool = LENS_TOOLS[name];
  if (!tool) throw new DevError(`Unknown lens tool ${name}.`);
  const source = typeof args.source === 'string' && args.source !== '' ? args.source : DEFAULT_SOURCE;
  const core = lens(ctx.userId, source);
  if (!core) {
    const known = Object.keys(SOURCES).map((t) => `${t}:<target>`).join(', ');
    throw new DevError(
      `No lens for source "${source}" on this computer. ${known ? `Available: ${known}.` : 'No lens source is available here.'}`
    );
  }
  const r = await tool.call(core, CONSUMERLESS.has(name) ? 'overlay' : consumerOf(ctx), args, {
    source,
    user: ctx.userId,
    cap: Math.min(AGENT_CAP, RESULT_CAP),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (r.isError) throw new DevError(r.text);
  return budget({
    ...r.receipt,
    text: r.text,
    ...(r.image ? { image: r.image.data, imageMime: r.image.mime } : {}),
  });
}

/** The last guard: a result core.ts would drop whole loses whole lines of its
 *  text instead, so the caller still sees the receipt and knows what is
 *  missing. Nothing is sliced mid-line — a half-line of observed text reads
 *  like the source said it.
 *  ponytail: one serialisation per dropped line, on a path that only runs when
 *  a result is already over budget; bisect if that ever shows up in a profile. */
function budget(value: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(value).length <= OUTPUT_CAP) return value;
  const tail = (n: number): string => `… ${n} lines omitted; read the rest with lens_text {rect} or another lens_wait`;
  const all = String(value.text ?? '').split('\n');
  for (let kept = all.length - 1; kept > 0; kept--) {
    const out = { ...value, truncated: true, text: [...all.slice(0, kept), tail(all.length - kept)].join('\n') };
    if (JSON.stringify(out).length <= OUTPUT_CAP) return out;
  }
  return { ...value, truncated: true, text: tail(all.length) };
}
