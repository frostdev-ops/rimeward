import type { APIRoute } from 'astro';
import type { AgentEvent } from '../../../lib/agent/core.ts';
import { agentConfigured } from '../../../lib/agent/provider.ts';
import { validateMentionLabels, type WardMention } from '../../../lib/agent/mentions.ts';
import { validateWardMentions } from '../../../lib/agent/ward-context.ts';
import { parseCommand } from '../../../lib/agent/commands.ts';
import { syncRime, syncStatus } from '../../../lib/agent/sync.ts';
import { listTasks, readTask, readChildTask, backgroundTasks, cancelTask } from '../../../lib/agent/tasks.ts';
import { broadcast } from '../../../lib/logic-engine.ts';

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
      if (id && url.searchParams.has('session')) return Response.json(readChildTask(ctx, id), { headers: { 'cache-control': 'no-store' } });
      return Response.json(id ? readTask(ctx, id, Number(url.searchParams.get('cursor') ?? 0), url.searchParams.get('output') !== 'true') : { tasks: listTasks(ctx, url.searchParams.get('history') === 'true') }, { headers: { 'cache-control': 'no-store' } });
    } catch (err) { return Response.json({ error: err instanceof Error ? err.message : 'Task unavailable' }, { status: 400 }); }
  }
  await syncRime(userId);
  const surface = await wardSurface(userId, String(params.ward));
  // 400, not 404 — the ward helpers map 404 to a Connect chip.
  if (!surface) return Response.json({ error: 'not an agent ward' }, { status: 400 });
  return Response.json({...surface,sync:syncStatus(userId)}, { headers: { 'cache-control': 'no-store' } });
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { agentWardConfig, backgroundTurn, clearThread, interruptTurn, resolveConfirmTurn, prepareUserAnswer, steerTurn, runChatTurn, runCommand, wardBusy } = await import('../../../lib/agent/core.ts');
  const userId = locals.user!.userId;
  const ward = String(params.ward);

  const body = (await request.json().catch(() => null)) as {
    message?: string;
    file_ids?: unknown;
    ward_ids?: unknown;
    ward_mentions?: unknown;
    action?: 'clear' | 'confirm' | 'decline' | 'interrupt' | 'background' | 'cancel-task' | 'message-child' | 'answer-question';
    answer?: unknown;
    task?: string;
    questionId?: unknown;
    confirmId?: string;
    /** steer: hand the message to the turn already running (JSON {steered}); never a stream. */
    mode?: 'steer';
  } | null;
  if (!body) return Response.json({ error: 'bad body' }, { status: 400 });
  const typed = typeof body.message === 'string' ? body.message.trim().slice(0, 8000) : '';
  const command = body.action ? null : parseCommand(typed);
  // Local controls must remain responsive while reconciliation is in flight.
  if (!body.action && body.mode !== 'steer' && command?.name !== 'compact') await syncRime(userId);
  const cfg = agentWardConfig(userId, ward);
  if (!cfg) return Response.json({ error: 'not an agent ward' }, { status: 400 });
  if (body.action === 'message-child') {
    try {
      const { messageChild } = await import('../../../lib/agent/inbox.ts');
      return Response.json(await messageChild(userId, ward, String(body.task ?? ''), body.message, body.questionId));
    } catch (err) { return Response.json({ error: err instanceof Error ? err.message : 'Could not message child agent' }, { status: 400 }); }
  }
  if (body.action === 'background' || body.action === 'cancel-task') {
    try {
      const ctx = { userId, ward };
      if (body.action === 'cancel-task') return Response.json({ task: cancelTask(ctx, String(body.task ?? '')) });
      // Ctrl+B: the foreground tool task if there is one — else the whole turn forks into a child run.
      const tasks = backgroundTasks(ctx, body.task);
      const forked = !tasks.length && !body.task ? await backgroundTurn(userId, ward) : null;
      return Response.json({ tasks: forked ? [forked] : tasks, forked: !!forked });
    } catch (err) { return Response.json({ error: err instanceof Error ? err.message : 'Task action failed' }, { status: 400 }); }
  }

  if (body.action === 'clear') {
    clearThread(userId, ward);
    return Response.json({ ok: true });
  }
  // The Stop button: the running turn ends at its next round boundary (the
  // model call in flight is aborted). False = nothing was running.
  if (body.action === 'interrupt') return Response.json({ ok: true, interrupted: interruptTurn(userId, ward, 'the user') });

  // Commands answer JSON ahead of the busy gate. Compaction calls the model,
  // so flush headers before synchronization and keep the remote route alive.
  if (command) {
    if (command.name === 'compact') {
      const encoder = new TextEncoder();
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (text: string) => { try { controller.enqueue(encoder.encode(text)); } catch { /* disconnected; compaction still finishes */ } };
          send(' '); heartbeat = setInterval(() => send(' '), 10_000);
          void syncRime(userId).then(() => runCommand(userId, ward, command.name, command.args))
            .then(value => send(JSON.stringify(value)), error => send(JSON.stringify({ error: error instanceof Error ? error.message : 'command failed' })))
            .finally(() => { clearInterval(heartbeat); try { controller.close(); } catch {} });
        },
        cancel() { clearInterval(heartbeat); },
      });
      return new Response(stream, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } });
    }
    try {
      return Response.json(await runCommand(userId, ward, command.name, command.args));
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : 'command failed' }, { status: 400 });
    }
  }

  let wardIds: string[], mentions: WardMention[];
  try {
    wardIds = validateWardMentions(userId, body.ward_ids);
    mentions = validateMentionLabels(wardIds, body.ward_mentions);
  }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Invalid ward mentions' }, { status: 400 }); }

  if (!agentConfigured(userId, cfg.provider, cfg.endpoint)) return Response.json({ error: 'not-configured' }, { status: 503 });
  if (body.mode === 'steer') {
    // Typed while the agent works: the next round reads it as a user message.
    // steered:false = the turn ended first — the client sends it as a turn.
    if (!typed) return Response.json({ error: 'empty message' }, { status: 400 });
    if (!wardBusy(userId, ward)) return Response.json({ steered: false });
    steerTurn(userId, ward, { text: typed, from: 'user', wardIds, mentions });
    return Response.json({ steered: true });
  }
  const answering = body.action === 'answer-question';
  let waitingQuestion = false;
  if (answering) {
    let resume = false;
    try { const result = prepareUserAnswer(userId, ward, String(body.questionId ?? ''), body.answer); waitingQuestion = result.waiting; resume = result.resume; }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Invalid answer' }, { status: 409 }); }
    if (!waitingQuestion) {
      if (resume) void runChatTurn(userId, ward, { message: '', fileIds: [] }, () => {}).catch(error => {
        broadcast(userId, 'agent-live', { ward, event: { type: 'end', error: error instanceof Error ? error.message : 'Could not continue after your answer.' } });
      });
      return Response.json({ answered: true, queued: true });
    }
  }
  if (wardBusy(userId, ward)) return Response.json({ error: 'busy' }, { status: 409 });

  const deciding = body.action === 'confirm' || body.action === 'decline' || waitingQuestion;
  const message = typed;
  const fileIds = Array.isArray(body.file_ids) ? body.file_ids.map(Number).filter(Number.isInteger).slice(0, 8) : [];
  if (!deciding && !answering && !message && !fileIds.length) return Response.json({ error: 'empty message' }, { status: 400 });

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
        ? resolveConfirmTurn(userId, ward, String(waitingQuestion ? body.questionId : body.confirmId ?? ''), waitingQuestion ? body.answer !== null : body.action === 'confirm', send, waitingQuestion ? body.answer : undefined)
        : runChatTurn(userId, ward, { message: answering ? '' : message, fileIds: answering ? [] : fileIds, wardIds, mentions }, send);
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
