import type { AgentEvent } from './core.ts';
import type { TranscriptMsg } from './conversations.ts';

export interface LiveTurn {
  id: string;
  conversation: number;
  task?: string;
  transcript: TranscriptMsg[];
  events: AgentEvent[];
}
const active = new Map<number, { user: number; turn: LiveTurn }>();

export function liveTurn(user: number, conversation: number): LiveTurn | undefined {
  const entry = active.get(conversation);
  return entry?.user === user ? entry.turn : undefined;
}

/** Only active turns live here; deltas coalesce rather than retaining a token log. */
export function trackTurn(user: number, turn: LiveTurn) {
  active.set(turn.conversation, { user, turn });
  return {
    event(event: AgentEvent) {
      const events = turn.events;
      if (event.type === 'thinking' || event.type === 'text_delta' || event.type === 'says' || event.type === 'reply' || event.type === 'step_start') {
        for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === 'thinking') events.splice(i, 1);
      }
      if (event.type === 'text_delta') {
        const old = events.find(e => e.type === 'text_delta' && e.id === event.id);
        if (old?.type === 'text_delta') { old.delta += event.delta; return; }
      }
      const index = events.findIndex(e =>
        (event.type === 'says' || event.type === 'reply') && e.type === 'text_delta' && e.id === event.id ||
        event.type === 'step' && e.type === 'step_start' && e.id === event.step.id);
      if (index >= 0) events[index] = event;
      else if (event.type !== 'usage' && event.type !== 'task') events.push({ ...event });
    },
    close() { if (active.get(turn.conversation)?.turn === turn) active.delete(turn.conversation); },
  };
}
