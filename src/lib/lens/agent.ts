// The agent door onto the lens tools: which consumer a turn reads as, and the
// one call that resolves a source, runs the tool and hands the result back in
// the shape the device tool path expects (`src/lib/dev/tool-routing.ts`
// storeImage turns `image`/`imageMime` into a conversation-local file_id).

import { SOURCES, lens } from './core.ts';
import { LENS_TOOLS } from './tools.ts';
import type { LensToolName } from './tools.ts';
import type { ToolCtx } from '../agent/tools.ts';

export const DEFAULT_SOURCE = 'screen:local';

/** Who this turn reads a source as. A conversation is one consumer, so its
 *  cursor and its unacknowledged delivery survive between turns; a relayed
 *  agent-tool call arrives as ward `remote:<64 hex>` with no conversation of
 *  its own, and reads as that caller. Both stay inside `^[a-z0-9-]{1,40}$`. */
export function consumerOf(ctx: ToolCtx): string {
  const id = ctx.conv ? `conv-${ctx.conv}` : `remote-${ctx.ward.slice(7, 39)}`;
  return id.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

export async function lensToolRun(name: LensToolName, args: Record<string, any>, ctx: ToolCtx): Promise<unknown> {
  const tool = LENS_TOOLS[name];
  if (!tool) throw new Error(`Unknown lens tool ${name}.`);
  const source = typeof args.source === 'string' && args.source !== '' ? args.source : DEFAULT_SOURCE;
  const core = lens(ctx.userId, source);
  if (!core) {
    const known = Object.keys(SOURCES).map((t) => `${t}:<target>`).join(', ');
    throw new Error(
      `No lens for source "${source}" on this computer. ${known ? `Available: ${known}.` : 'No lens source is available here.'}`
    );
  }
  const r = await tool.call(core, consumerOf(ctx), args, { source, ...(ctx.signal ? { signal: ctx.signal } : {}) });
  return {
    ...r.receipt,
    text: r.text,
    ...(r.image ? { image: r.image.data, imageMime: r.image.mime } : {}),
  };
}
