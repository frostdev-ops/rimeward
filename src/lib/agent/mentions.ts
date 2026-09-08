/** Shared by compact/expanded composers and draft recovery. IDs, never titles, select data. */
export const MAX_WARD_MENTIONS = 8;
export interface WardMention { ward: string; title: string }
export function mentionPattern(mention: WardMention): RegExp {
  const token = `@${mention.title}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_@])${token}(?![\\p{L}\\p{N}_-])`, 'gu');
}
function mentionSpans(text: string, mentions: WardMention[]): { start: number; end: number; mention: WardMention }[] {
  const spans: { start: number; end: number; mention: WardMention }[] = [];
  for (const m of [...mentions].sort((a, b) => b.title.length - a.title.length)) {
    for (const match of text.matchAll(mentionPattern(m))) {
      const start = match.index, end = start + match[0].length;
      if (spans.some(s => start < s.end && end > s.start)) continue;
      spans.push({ start, end, mention: m });
    }
  }
  return spans;
}
export const activeMentions = (text: string, mentions: WardMention[]): WardMention[] => {
  const selected = new Set(mentionSpans(text, mentions).map(s => s.mention.ward));
  return mentions.filter(m => selected.has(m.ward));
};

/** Ordinary message text stores the tags, so history, sync and older clients need no new schema. */
export function tagMentionMessage(text: string, mentions: WardMention[]): string {
  const tag = (m: WardMention) => `[@${m.title.replace(/[\[\]\r\n]/g, ' ')}](ward:${m.ward})`;
  const spans = mentionSpans(text, mentions).sort((a, b) => b.start - a.start);
  let shown = text;
  for (const s of spans) shown = shown.slice(0, s.start) + tag(s.mention) + shown.slice(s.end);
  const found = new Set(spans.map(s => s.mention.ward));
  const extra = mentions.filter(m => !found.has(m.ward)).map(tag);
  return shown + (extra.length ? `\n\n${extra.join(' ')}` : '');
}

export const plainMentionText = (text: string): string => text.replace(/\[(@[^\]]+)\]\(ward:[a-z0-9-]{1,32}\)/g, '$1');

/** Labels are display data only; the separately authorized IDs select context. */
export function validateMentionLabels(ids: string[], raw: unknown): WardMention[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_WARD_MENTIONS || raw.some(m =>
    !m || typeof m.ward !== 'string' || !ids.includes(m.ward) || typeof m.title !== 'string' || !m.title.trim() || m.title.length > 240 || /[\r\n]/.test(m.title)))
    throw Error('Invalid ward mention labels. Choose the ward from the @ list again.');
  return [...new Map(raw.map(m => [m.ward, { ward: m.ward, title: m.title }])).values()];
}
