import { deleteSetting, getSetting, setSetting } from './settings.ts';

// What the public pages say about this instance — name, tagline, the splash's
// cards and footer — as settings rows, edited on the admin page or with
// `rimeward splash`. An empty row is not rendered; the name falls back.

export interface SiteCard {
  title: string;
  blurb: string;
}
export interface SiteInfo {
  name: string;
  tagline: string;
  footer: string;
  cards: SiteCard[];
  /** Anyone-with-the-link sharing (lib/shares.ts): on unless an admin turned it off. */
  links: boolean;
}

export const SITE_DEFAULTS: SiteInfo = { name: 'Rimeward', tagline: 'The rime remembers', footer: '', cards: [], links: true };
export const MAX_CARDS = 6;
const MAX = { name: 60, tagline: 120, footer: 200, title: 60, blurb: 200 };

export function siteInfo(): SiteInfo {
  return {
    name: (getSetting('site_name') ?? '').trim() || SITE_DEFAULTS.name,
    tagline: (getSetting('site_tagline') ?? '').trim() || SITE_DEFAULTS.tagline,
    footer: (getSetting('site_footer') ?? '').trim(),
    cards: storedCards(getSetting('splash_cards')),
    links: getSetting('share_links') !== '0',
  };
}

/** `[{ title, blurb }]`, at most MAX_CARDS, trimmed and bounded. Throws on bad shape. */
export function validateCards(input: unknown): SiteCard[] {
  if (!Array.isArray(input)) throw new Error('cards: expected an array');
  if (input.length > MAX_CARDS) throw new Error(`cards: at most ${MAX_CARDS} (got ${input.length})`);
  return input.map((c: { title?: unknown; blurb?: unknown }, i) => {
    const title = typeof c?.title === 'string' ? c.title.trim() : '';
    const blurb = typeof c?.blurb === 'string' ? c.blurb.trim() : '';
    if (!title) throw new Error(`cards[${i}]: title required`);
    if (title.length > MAX.title) throw new Error(`cards[${i}].title: over ${MAX.title} chars`);
    if (blurb.length > MAX.blurb) throw new Error(`cards[${i}].blurb: over ${MAX.blurb} chars`);
    return { title, blurb };
  });
}

function storedCards(raw: string | null): SiteCard[] {
  if (!raw) return [];
  try {
    return validateCards(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** The admin form's textarea: one card per line, `Title | blurb`. */
export function cardsFromLines(text: string): SiteCard[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return validateCards(
    lines.map((l) => {
      const [title, ...rest] = l.split('|');
      return { title: title!.trim(), blurb: rest.join('|').trim() };
    })
  );
}
export function cardsToLines(cards: SiteCard[]): string {
  return cards.map((c) => (c.blurb ? `${c.title} | ${c.blurb}` : c.title)).join('\n');
}

/** Absent field = leave the row alone; empty = clear it. */
export function saveSite(input: { name?: string; tagline?: string; footer?: string; cards?: SiteCard[]; links?: boolean }): void {
  const put = (key: string, value: string | undefined, max: number) => {
    if (value === undefined) return;
    const v = value.trim().slice(0, max);
    if (v) setSetting(key, v);
    else deleteSetting(key);
  };
  put('site_name', input.name, MAX.name);
  put('site_tagline', input.tagline, MAX.tagline);
  put('site_footer', input.footer, MAX.footer);
  if (input.cards) {
    if (input.cards.length) setSetting('splash_cards', JSON.stringify(validateCards(input.cards)));
    else deleteSetting('splash_cards');
  }
  if (input.links !== undefined) {
    if (input.links) deleteSetting('share_links');
    else setSetting('share_links', '0');
  }
}
