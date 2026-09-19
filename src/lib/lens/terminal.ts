// The terminal lens source: one document per session, one line per rendered row.
// The chrome helpers below are the ones `agent/monitor-sources.ts` grew (it
// imports them from here now, unchanged); everything else translates the dev
// stream into `Feed` calls.
//
// Geometry is the row band `[0, position, 1, 1]`, where `position` is the row's
// absolute index in the session (viewport row 0 sits at `scrolled`). It is what
// keeps reading order right and what lets a live region name a row: a spinner,
// and any row that keeps repainting in place, are churn the gate drops.

import type { Draft } from './doc.ts';
import { SOURCES } from './core.ts';
import type { Feed, Source, SourceSnapshot } from './core.ts';
import type { MetaField, Rect } from './types.ts';
import { subscribeDev } from '../dev/runtime.ts';
import { readSession, renderedLines } from '../dev/terminals.ts';

// ------------------------------------------------------- CLI chrome grammar
// Moved verbatim out of agent/monitor-sources.ts, which imports them from here.

/** Content identity stays exact (apart from whitespace), including digits and bullet rows:
 *  "HTTP 500" and "HTTP 200", "1/3" and "2/3" are different rows. Only the two counters below
 *  that Claude Code redraws every second are removed from a row's identity, never from its text. */
export const stableKey = (line: string): string => line.replace(/\s+/g, ' ').trim();
const SPARKLE = '[\\u2800-\\u28FF\\u00B7\\u2022\\u2722\\u2733\\u2736\\u273B\\u273D]';
/** The activity spinner: a frame glyph, ONE gerund and an ellipsis. The verb is random and changes
 *  between frames ("Churning…", "Photosynthesizing…", "Sautéing…"), so the shape is recognized,
 *  not the word; prose never fits it. An optional parenthetical carries metadata parts joined by
 *  · — elapsed, token counts, "esc to interrupt", "thinking some more with xhigh effort", "running
 *  stop hook" — each a short run of words and numbers with no sentence punctuation. */
const CLAUDE_SPINNER = new RegExp(`^${SPARKLE}\\s+(\\p{Lu}\\p{L}*ing)(?:…|\\.{3})(?:\\s+\\(([^()]*)\\))?$`,'u');
const CODEX_SPINNER = /^[⠀-⣿•◦]\s+(Working|Thinking)(?:…|\.{3})?\s+\(([^()]*)\)$/i;
const DURATION = String.raw`(?:\d+(?:\.\d+)?[hms]\s*)+`;
// Codex also uses a changing activity title instead of Working/Thinking. Match its
// elapsed/interrupt footer, not the title, and only its known background-terminal tail.
const CODEX_ACTIVITY = new RegExp(String.raw`^[⠀-⣿•◦]\s+[^()\r\n]{1,160}\s+\(${DURATION}[·•]\s*esc to interrupt\)(.*)$`, 'u');
function codexActivity(text:string): boolean {
  const match = CODEX_ACTIVITY.exec(text);
  if (!match) return false;
  const tail = match[1]!.trim();
  if (!tail) return true;
  const truncated = /(?:…|\.{3})$/.test(tail), prefix = tail.replace(/(?:…|\.{3})$/,'').trimEnd();
  // Even a trailer cut immediately after its separator is recognizable here: the
  // complete elapsed/interrupt invariant above must already have matched.
  if (truncated && prefix === '·') return true;
  const background = /^· \d+(?: (.*))?$/.exec(prefix);
  if (!background) return false;
  const value = background[1] ?? '';
  // Accept only prefixes of the known trailer, never an unrelated right-hand column.
  return ['background terminal running','background terminals running'].some(status =>
    [status,`${status} · /ps to view`].some(full => truncated ? full.startsWith(value) : value === full));
}
const SPINNER_DETAIL = /^(?:[↑↓↕]\s*)?(?:\d+(?:\.\d+)?[hms%k]?|\p{L}+)(?:\s(?:\d+(?:\.\d+)?[hms%k]?|\p{L}+)){0,7}$/u;
export function spinnerChrome(text:string): boolean {
  if (codexActivity(text)) return true;
  const match = CLAUDE_SPINNER.exec(text) ?? CODEX_SPINNER.exec(text);
  if (!match) return false;
  if (match[2] === undefined) return true;
  return match[2].split(/[·•]/).every(part => SPINNER_DETAIL.test(part.trim()));
}
/** A row that is only a counter: the wrapped tail of a tool row ("· 21s") or preview ("(8s)"). */
const COUNTER_ONLY = new RegExp(String.raw`^(?:·\s*${DURATION}|\(${DURATION}\))$`);
/** Frame rows of the CLI's boxes and logo: box-drawing and block characters only. */
const BOX_ONLY = /^[─-╿▀-▟\s]+$/;
/** Chrome Claude Code paints beside the prompt, by shape: the logo rows, the empty prompt's
 *  placeholder, the mode line, the effort indicator, the slash-command completion rows (a
 *  command name, two spaces, a description), the exit hint, an empty tool marker, and the
 *  status bar (project △ branch ⎪pill⎥ ai ◆ model …), whose cost and clock tick every second. */
const CHROME_ROW = [
  /^[▀-▟]/, /^❯(?: Try ".+")?$/, /^⏸ .+\bmode (?:on|off)\b/, /^[◉○] .*\beffort\b/, /^Press Ctrl-C again to exit$/, /^⏺$/, /^⎿\s+Tip:\s/,
  /^□\s.+\s△\s.+\s⎪[^⎥]*⎥\sai\s◆\s/,
];
const COMPLETION_ROW = /^\s*\/(?:[a-z][\w.:-]*|\S.*?\s\(MCP\))\s{2,}\S/i;
/** Right-aligned session status Claude Code appends after a run of spaces on a spinner or
 *  preview row ("+17 files edited before this session (show)", "No changes this session"). */
const STATUS_TAIL = /^(?:No changes this session|[+-]?\d+ files? (?:edited|changed)\b[^()]*(?:\(show\))?)$/;
/** Claude Code's running tool call, "⏺ Reading the file · 21s" (the glyph blinks away on alternate
 *  frames), and its command preview, "⎿ $ cmd (8s)": the counter ticks every second. The ❯ that
 *  marks the selected row of a menu moves between rows as the person arrows through it. */
const TOOL_TICK = new RegExp(String.raw`^(?:⏺\s+)?(.*?)\s*·\s*${DURATION}$`);
const PREVIEW_TICK = new RegExp(String.raw`^(⎿.*?)\s*\(${DURATION}\)$`);
export function cliKey(text:string): string {
  return TOOL_TICK.exec(text)?.[1] ?? PREVIEW_TICK.exec(text)?.[1] ?? text.replace(/^[⏺❯]\s+/,'');
}
/** A row split at a run of three or more spaces: the part before is the row, the part after a
 *  right-aligned trailer. Whitespace collapsing loses that signal, so this reads the raw row. */
function splitTail(raw:string): { main:string; tail:string } {
  const m = /^(.*?\S)\s{3,}(\S.*)$/.exec(raw.trimEnd());
  return m ? { main:stableKey(m[1]!),tail:stableKey(m[2]!) } : { main:stableKey(raw),tail:'' };
}
/** The content of each rendered row, aligned with `lines` (null = recognized CLI chrome). Only
 *  CLI-owned shapes are removed, never arbitrary prose containing an ellipsis or a hint; a row
 *  whose right-aligned trailer is session status keeps its left part. A wrapped spinner is removed
 *  only when the complete joined row matches the same grammar. Queued input, prompts and menus
 *  stay visible: indentation or ❯ alone cannot distinguish an input repaint from a question. */
export function terminalContent(lines:string[],cli:boolean,wrapped:boolean[]): (string | null)[] {
  if (!cli) return lines;
  const content:(string | null)[] = lines.map(() => null);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!, { main,tail } = splitTail(raw);
    const text = tail && STATUS_TAIL.test(tail) ? main : stableKey(raw);
    if (/^[⠀-⣿·•◦✢✳✶✻✽]\s/.test(text)) {
      let joined = raw, matched = spinnerChrome(text) ? i : -1;
      // Include a wrapped title, elapsed clock, or background-terminal tail only when
      // the complete joined text has the same anchored CLI shape. Unrelated rows stay.
      for (let end = i+1; end < lines.length && end-i <= 4 && wrapped[end] && stableKey(lines[end]!); end++) {
        joined += lines[end]!;
        if (spinnerChrome(stableKey(joined))) matched = end;
      }
      if (matched >= 0) { i = matched; continue; }
    }
    if (!text || COUNTER_ONLY.test(text) || BOX_ONLY.test(text) || CHROME_ROW.some(re => re.test(text)) || COMPLETION_ROW.test(raw) ||
        text === '❯ Press up to edit queued messages' || /^\s{40,}\S/.test(raw)) continue;
    content[i] = tail && STATUS_TAIL.test(tail) ? main : raw;
  }
  return content;
}

// ------------------------------------------------------------- the source

/** Rows kept above the viewport. ponytail: a fixed window, so a trimmed row
 *  leaves the document as a removal the gate still sees as changed text;
 *  `removals: false` keeps it out of every rendered delta. Make the trim silent
 *  only if scrollback watches ever misfire. */
export const KEEP = 400;
/** A pure repaint, loud enough for the live detector (>= liveThreshold) and
 *  quiet enough never to be a visual candidate (< visualThreshold). */
const REPAINT_D = 0.1;

export interface TerminalDeps {
  subscribe: typeof subscribeDev;
  rendered: typeof renderedLines;
  read: typeof readSession;
  /** Stamped on every repaint rectangle: one frame per instant, so a replay on
   *  a fake clock does not collapse a burst into one frame. */
  now?: () => number;
}

const band = (position: number): Rect => [0, position, 1, 1];

type SessionState = { state: string; exitCode: number | null; cols: number; rows: number; title: string; kind: string };

function sessionMeta(s: { state: string; exitCode: number | null; title: string }): Record<string, MetaField> {
  return {
    session: { value: `${s.state}${s.exitCode === null ? '' : ` exit=${s.exitCode}`}` },
    title: { value: s.title },
  };
}

export function terminalSource(deps: TerminalDeps): Source {
  const now = deps.now ?? Date.now;
  let user = 0;
  let target = '';
  let feed: Feed | null = null;
  let epoch = 0;
  let seq = 0;
  let scrolled = 0;
  let cli = false;
  let size = '';
  /** The previous frame's viewport, by absolute row position. */
  let previous = new Map<number, string>();

  const view = (): SessionState => {
    const s = deps.read(user, target, undefined, false).session;
    return { state: s.state, exitCode: s.exitCode, cols: s.cols, rows: s.rows, title: s.title, kind: s.kind };
  };

  /** One frame of rendered rows into drafts, live rows and repaint rectangles.
   *  `base` is the absolute position of the first viewport row, `above` how many
   *  of `lines` sit over it. */
  const draw = (
    lines: string[],
    above: number,
    base: number,
    lost: number,
    now: number
  ): { drafts: Draft[]; live: Rect[]; dirty: Rect[]; top: number } => {
    const top = base - above;
    const drafts: Draft[] = [];
    const live: Rect[] = [];
    const dirty: Rect[] = [];
    const next = new Map<number, string>();
    if (lost > 0) {
      const text = `[lens: ${lost} rows scrolled out of view before they were read]`;
      // Half a row above the window, so it keeps reading order and collides with
      // no row this read or any later one.
      drafts.push({ text, src: 'lens', key: `lens:lost:${top}`, bbox: [0, top - 0.5, 1, 1] });
    }
    for (const [index, raw] of lines.entries()) {
      const row = raw.trimEnd();
      const text = stableKey(row);
      if (!text) continue;
      const position = top + index;
      const key = cli ? cliKey(text) : text;
      drafts.push({ text: row, src: 'pty', key, bbox: band(position) });
      next.set(position, key);
      if (spinnerChrome(text)) live.push(band(position));
      const was = previous.get(position);
      if (was !== undefined && was !== key) dirty.push(band(position));
    }
    previous = next;
    void now;
    return { drafts, live, dirty, top };
  };

  const paint = (lines: string[], above: number, base: number, lost: number, at: number, now: number): void => {
    if (!feed) return;
    const { drafts, live, dirty, top } = draw(lines, above, base, lost, now);
    const cutoff = base - KEEP;
    feed.live(live);
    for (const bbox of dirty) feed.dirty({ bbox, d: REPAINT_D }, now);
    feed.ref(`${target}:${base}`);
    feed.replace(drafts, at, (line) => {
      const y = line.bbox?.[1] ?? 0;
      return y >= top || y < cutoff;
    });
  };

  /** The session start and every re-wrap: a new epoch, its header and a full
   *  repaint of what is on screen. */
  const open = (at: number): void => {
    if (!feed) return;
    const session = view();
    cli = session.kind !== 'shell';
    size = `${session.cols}x${session.rows}`;
    previous = new Map();
    epoch += 1;
    feed.epoch(epoch, at);
    const frame = deps.rendered(user, target);
    scrolled = frame.scrolled;
    paint(frame.lines, 0, frame.scrolled, 0, at, now());
    // The header last: `session` is what forces the keyframe, so writing it
    // after the rows is what makes that keyframe carry them.
    for (const [key, field] of Object.entries(sessionMeta(session))) feed.meta(key, field.value, at);
  };

  return {
    keyframeOn: ['session'],
    ruleKeys: ['session'],
    // A terminal's rows only ever scroll away: the `-` lines would be noise.
    removals: false,

    async connect(u, t, f): Promise<() => void> {
      user = u;
      target = t;
      feed = f;
      let started = false;
      const stop = deps.subscribe(user, (event) => {
        // `subscribe` announces itself with a `reset`; every later one is the
        // stream having restarted, which is a gap.
        if (!started) {
          seq = event.sequence;
          return;
        }
        if (event.type === 'reset') {
          seq = event.sequence;
          f.gap(0, event.sequence);
          return;
        }
        if (event.id !== target || (event.type !== 'output' && event.type !== 'session')) return;
        const data = event.data as { state?: string; exitCode?: number | null; cols?: number; rows?: number } | undefined;
        if (!data) {
          f.offline('Terminal is unavailable.');
          return;
        }
        seq = event.sequence;
        if (event.type === 'session') {
          // A resize re-wraps every row, so the rows in the document are not the
          // rows on screen any more: a new epoch, not a delta.
          if (`${data.cols}x${data.rows}` !== size) return open(event.sequence);
          const session = view();
          for (const [key, field] of Object.entries(sessionMeta(session))) {
            f.meta(key, field.value, event.sequence);
          }
          return;
        }
        let frame: ReturnType<typeof renderedLines>;
        try {
          frame = deps.rendered(user, target, scrolled);
        } catch (err) {
          f.offline(err instanceof Error ? err.message : String(err));
          return;
        }
        const above = Math.max(0, frame.scrolled - scrolled - frame.lost);
        scrolled = frame.scrolled;
        paint(frame.lines, above, frame.scrolled, frame.lost, event.sequence, now());
      });
      started = true;
      try {
        open(seq);
      } catch (err) {
        f.offline(err instanceof Error ? err.message : String(err));
      }
      return () => {
        feed = null;
        stop();
      };
    },

    async snapshot(): Promise<SourceSnapshot | null> {
      if (!feed || !target) return null;
      const session = view();
      cli = session.kind !== 'shell';
      size = `${session.cols}x${session.rows}`;
      const frame = deps.rendered(user, target);
      scrolled = frame.scrolled;
      previous = new Map();
      const { drafts, live } = draw(frame.lines, 0, frame.scrolled, 0, now());
      return {
        epoch,
        seq,
        meta: sessionMeta(session),
        lines: drafts,
        live,
        ref: `${target}:${frame.scrolled}`,
      };
    },
  };
}

SOURCES.terminal = (): Source =>
  terminalSource({ subscribe: subscribeDev, rendered: renderedLines, read: readSession });
