import type { APIRoute } from 'astro';
import type { AgentEvent } from '../../../lib/agent/core.ts';
import { agentConfigured } from '../../../lib/agent/provider.ts';
import { parseCommand } from '../../../lib/agent/commands.ts';
import { syncRime, syncStatus } from '../../../lib/agent/sync.ts';
import { listTasks, readTask, backgroundTasks, cancelTask } from '../../../lib/agent/tasks.ts';

export const prerender = false;

// The agent ward's chat surface. GET = repaint data; POST = one turn as a
// stream of `data: {json}` frames (no SSE event names — the discriminant is
// event.type). A client disconnect never aborts the turn: tools already wrote,
// and the transcript is the record either way.

export const GET: APIRoute = async ({ params, locals, url }) => {
  const { wardSurface, agentWardConfig } = await import('../../../lib/agent/core.ts');
  const userId = locals.user!.userId;
  if (url.searchParams.has('tasks')) {
    const ctx = { userId, ward: String(params.ward) };
    if (!agentWardConfig(userId, ctx.ward)) return Response.json({ error: 'not an agent ward' }, { status: 400 });
    try {
      const id = url.searchParams.get('task');
      return Response.json(id ? readTask(ctx, id, Number(url.searchParams.get('cursor') ?? 0), url.searchParams.get('output') !== 'true') : { tasks: listTasks(ctx) }, { headers: { 'cache-control': 'no-store' } });
    } catch (err) { return Response.json({ error: err instanceof Error ? err.message : 'Task unavailable' }, { status: 400 }); }
  }
  await syncRime(userId);
  const surface = await wardSurface(userId, String(params.ward));
  // 400, not 404 — the ward helpers map 404 to a Connect chip.
  if (!surface) return Response.json({ error: 'not an agent ward' }, { status: 400 });
  return Response.json({...surface,sync:syncStatus(userId)}, { headers: { 'cache-control': 'no-store' } });
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { agentWardConfig, clearThread, interruptTurn, resolveConfirmTurn, steerTurn, runChatTurn, runCommand, wardBusy } = await import('../../../lib/agent/core.ts');
  const userId = locals.user!.userId;
  const ward = String(params.ward);

  const body = (await request.json().catch(() => null)) as {
    message?: string;
    file_ids?: unknown;
    action?: 'clear' | 'confirm' | 'decline' | 'interrupt' | 'background' | 'cancel-task';
    task?: string;
    confirmId?: string;
    /** steer: hand the message to the turn already running (JSON {steered}); never a stream. */
    mode?: 'steer';
  } | null;
  if (!body) return Response.json({ error: 'bad body' }, { status: 400 });
  // Local controls must remain responsive while reconciliation is in flight.
  if (!body.action && body.mode !== 'steer') await syncRime(userId);
  const cfg = agentWardConfig(userId, ward);
  if (!cfg) return Response.json({ error: 'not an agent ward' }, { status: 400 });
  if (body.action === 'background' || body.action === 'cancel-task') {
    try {
      const ctx = { userId, ward };
      return Response.json(body.action === 'background' ? { tasks: backgroundTasks(ctx, body.task) } : { task: cancelTask(ctx, String(body.task ?? '')) });
    } catch (err) { return Response.json({ error: err instanceof Error ? err.message : 'Task action failed' }, { status: 400 }); }
  }

  if (body.action === 'clear') {
    clearThread(userId, ward);
    return Response.json({ ok: true });
  }
  // The Stop button: the running turn ends at its next round boundary (the
  // model call in flight is aborted). False = nothing was running.
  if (body.action === 'interrupt') return Response.json({ ok: true, interrupted: interruptTurn(userId, ward, 'the user') });

  const typed = typeof body.message === 'string' ? body.message.trim().slice(0, 8000) : '';
  // Conversation control answers as plain JSON, ahead of the busy gate — these
  // never call the model, and /clear is exactly what you want mid-turn.
  const command = body.action ? null : parseCommand(typed);
  if (command) {
    try {
      return Response.json(await runCommand(userId, ward, command.name, command.args));
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : 'command failed' }, { status: 400 });
    }
  }

  if (!agentConfigured(userId, cfg.provider)) return Response.json({ error: 'not-configured' }, { status: 503 });
  if (body.mode === 'steer') {
    // Typed while the agent works: the next round reads it as a user message.
    // steered:false = the turn ended first — the client sends it as a turn.
    if (!typed) return Response.json({ error: 'empty message' }, { status: 400 });
    if (!wardBusy(userId, ward)) return Response.json({ steered: false });
    steerTurn(userId, ward, { text: typed, from: 'user' });
    return Response.json({ steered: true });
  }
  if (wardBusy(userId, ward)) return Response.json({ error: 'busy' }, { status: 409 });

  const deciding = body.action === 'confirm' || body.action === 'decline';
  const message = typed;
  const fileIds = Array.isArray(body.file_ids) ? body.file_ids.map(Number).filter(Number.isInteger).slice(0, 8) : [];
  if (!deciding && !message && !fileIds.length) return Response.json({ error: 'empty message' }, { status: 400 });

  const enc = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      heartbeat = setInterval(() => {
        try { controller.enqueue(enc.encode(': keepalive\n\n')); }
        catch { clearInterval(heartbeat); }
      }, 15_000);
      const send = (event: AgentEvent | { type: 'done' | 'error'; [k: string]: unknown }) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* client gone — the turn still finishes and persists */
        }
      };
      const run = deciding
        ? resolveConfirmTurn(userId, ward, String(body.confirmId ?? ''), body.action === 'confirm', send)
        : runChatTurn(userId, ward, { message, fileIds }, send);
      run
        .then((turn) => send({ type: 'done', reply: turn.reply, steps: turn.steps, pending: turn.pending ?? null }))
        .catch((err) => send({ type: 'error', error: err instanceof Error ? err.message : 'turn failed' }))
        .finally(() => {
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {}
        });
    },
    cancel() { clearInterval(heartbeat); },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no', // nginx must not hold frames (same as the status stream)
    },
  });
};
