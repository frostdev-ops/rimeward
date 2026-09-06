// The slash-command CONTRACT. Pure — it ships to the browser, so it must never
// import the db (same rule as wards.ts). The server runs these commands
// (agent/core.ts) and the composer's completion menu (scripts/app/agent.ts)
// lists them; both read this file, so the two can never disagree about what
// exists or what it is called.

export interface CommandSpec {
  name: string;
  /** One line, shown in the completion menu and in /help. */
  summary: string;
  /** Placeholder for what may follow the name, if anything. */
  args?: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'background', summary: 'Keep running tool tasks in the background · Ctrl+B' },
  { name: 'tasks', summary: 'Show running tasks and their recent results' },
  { name: 'clear', summary: 'Start a fresh thread — this one is archived, not deleted' },
  {
    name: 'compact',
    summary: 'Fold the older half of the thread into a summary to free up context',
    args: '[what to keep in full]',
  },
  { name: 'size', summary: 'How much context this thread is using' },
  { name: 'help', summary: 'List these commands' },
];

/** Spellings that resolve to a command. Kept separate from the catalog so the
 *  menu lists each command once, under its canonical name. */
export const ALIASES: Record<string, string> = {
  new: 'clear',
  reset: 'clear',
  summarize: 'compact',
  summarise: 'compact',
  stats: 'size',
  context: 'size',
  '?': 'help',
};

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/** The command a word names, following aliases. */
export function resolveCommand(word: string): CommandSpec | null {
  const key = word.toLowerCase();
  return BY_NAME.get(ALIASES[key] ?? key) ?? null;
}

/**
 * The command a message names, with anything after it, or null if it is
 * ordinary text. Only KNOWN commands match — a typo or a path ("/usr/bin/x",
 * "/opt is full") is text and goes to the model, which is a better failure than
 * an error about a command the user never meant to type.
 */
export function parseCommand(message: string): { name: string; args: string } | null {
  const m = message.trim().match(/^\/([a-z?]+)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const spec = resolveCommand(m[1]!);
  return spec ? { name: spec.name, args: (m[2] ?? '').trim() } : null;
}

/**
 * What the completion menu should offer for the text currently in the composer,
 * or null when it should be closed.
 *
 * Open only while the whole input is a bare slash-word: a leading '/' with no
 * space yet. Once a space is typed the user is writing arguments (or ordinary
 * prose that merely began with a slash) and a popup would be in the way.
 */
export function completeCommand(text: string): CommandSpec[] | null {
  const m = text.match(/^\/([a-z?]*)$/i);
  if (!m) return null;
  const prefix = m[1]!.toLowerCase();
  if (!prefix) return [...COMMANDS];
  // Canonical names only. Matching hidden aliases too would put a row reading
  // "/size" under a typed "/c" (via `context`) with nothing on screen to explain
  // why — aliases stay a typing shortcut that parses, not a menu entry.
  const hit = COMMANDS.filter((c) => c.name.startsWith(prefix));
  return hit.length ? hit : null;
}

/** Plain text, no markdown: /help renders as a note, not a chat bubble. */
export function commandHelp(): string {
  return [
    'Conversation commands:',
    ...COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ''} — ${c.summary}`),
  ].join('\n');
}
