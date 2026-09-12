// How a coding CLI's rime_ask reaches Rime. One seam on purpose: whether the CLI blocks for the
// answer, gets a "Rime will follow up" receipt, or is answered by the ward's own model is going
// to be decided by how real sessions feel — swap the strategy, nothing else moves.
import { parkQuestion } from './cli-bridge.ts';
import type { CliOrigin } from './cli-bridge.ts';

export interface AskStrategy { ask(req: { user: number; session: string; origin?: CliOrigin; question: string; options?: string[] }): Promise<string> }

/** The CLI's tool call waits (up to ASK_WAIT_MS) for terminal_answer; a session nobody
 *  launched from a Rime turn is told to decide for itself. */
export const blockingAsk: AskStrategy = {
  ask: ({ session, question, options }) => parkQuestion(session, question, options) ?? Promise.resolve('No coordinator is attached to this session; decide yourself.'),
};
export let askStrategy: AskStrategy = blockingAsk;
export function setAskStrategy(strategy: AskStrategy): void { askStrategy = strategy; }
