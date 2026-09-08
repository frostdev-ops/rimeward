// The icon catalogue — PURE, ships to the browser (scripts/app/icon.ts) and
// renders on the server (components/Icon.astro) from the same table. A ward
// names a semantic id ('mail', 'folder'); the user's theme picks the SET it is
// drawn from, and this module maps id + set → the Iconify name /api/icon
// serves. Everything a user types (an applink icon) is validated to ICON_NAME_RE
// before it can reach a URL.

/** The sets a theme can pick. `emoji` is the stock look — plain text, nothing
 *  fetched. `meteocons` is weather-only and colour, so it is never the general
 *  set; the weatherIcons knob reaches it. */
export type IconSet = 'emoji' | 'lucide' | 'ph' | 'tabler' | 'solar' | 'material' | 'meteocons';

export interface IconSetDef {
  label: string;
  /** `@iconify-json/<pkg>` — absent for emoji. */
  pkg?: string;
  /** style id → name suffix. The FIRST entry is the default style. */
  styles: Record<string, string>;
  /** Stroke-drawn set: the stroke knob rewrites its stroke-width. */
  stroke?: boolean;
  /** Full-colour art: rendered as <img>, not a currentColor mask — no tint. */
  color?: boolean;
  /** Only the weather ids have a name in it. */
  weatherOnly?: boolean;
}

export const ICON_SETS: Record<IconSet, IconSetDef> = {
  emoji: { label: 'Emoji', styles: {} },
  lucide: { label: 'Lucide', pkg: 'lucide', styles: {}, stroke: true },
  ph: {
    label: 'Phosphor',
    pkg: 'ph',
    styles: { regular: '', thin: '-thin', light: '-light', bold: '-bold', fill: '-fill', duotone: '-duotone' },
  },
  tabler: { label: 'Tabler', pkg: 'tabler', styles: { outline: '', filled: '-filled' }, stroke: true },
  solar: {
    label: 'Solar',
    pkg: 'solar',
    styles: {
      linear: '-linear',
      outline: '-outline',
      bold: '-bold',
      broken: '-broken',
      'line-duotone': '-line-duotone',
      'bold-duotone': '-bold-duotone',
    },
  },
  material: {
    label: 'Material Symbols',
    pkg: 'material-symbols',
    styles: {
      outline: '-outline',
      fill: '',
      'outline-rounded': '-outline-rounded',
      rounded: '-rounded',
      'outline-sharp': '-outline-sharp',
      sharp: '-sharp',
    },
  },
  meteocons: { label: 'Meteocons', pkg: 'meteocons', styles: { line: '', fill: '-fill' }, color: true, weatherOnly: true },
};

export const ICON_SET_IDS = Object.keys(ICON_SETS) as IconSet[];
/** What the theme's Icons picker offers. */
export const GENERAL_ICON_SETS = ICON_SET_IDS.filter((s) => !ICON_SETS[s].weatherOnly);
export type WeatherIcons = 'follow' | 'meteocons' | 'meteocons-fill';
export const WEATHER_ICONS: readonly WeatherIcons[] = ['follow', 'meteocons', 'meteocons-fill'];

/** A name that may appear in an /api/icon URL. */
export const ICON_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** [emoji, lucide, ph, tabler, solar, material, meteocons?] — one row per
 *  semantic id. tests/icons.test.ts proves every name resolves in its set. */
type Row = [string, string, string, string, string, string, string?];
const COL: Record<Exclude<IconSet, 'emoji'>, number> = { lucide: 1, ph: 2, tabler: 3, solar: 4, material: 5, meteocons: 6 };

export const ICONS = {
  host: ['🖥️', 'server', 'desktop', 'server', 'server', 'dns'],
  weather: ['⛅', 'cloud-sun', 'cloud-sun', 'cloud', 'cloud-sun', 'partly-cloudy-day', 'partly-cloudy-day'],
  mail: ['✉️', 'mail', 'envelope', 'mail', 'letter', 'mail'],
  calendar: ['📅', 'calendar', 'calendar', 'calendar', 'calendar', 'calendar-month'],
  database: ['🗃️', 'database', 'database', 'database', 'database', 'database'],
  tasks: ['✅', 'list-checks', 'list-checks', 'list-check', 'checklist', 'checklist'],
  page: ['📄', 'file-text', 'file-text', 'file-text', 'document-text', 'description'],
  tag: ['🏷️', 'tag', 'tag', 'tag', 'tag', 'label'],
  pen: ['✍️', 'pen-line', 'pencil-line', 'pencil', 'pen', 'edit-note'],
  history: ['🕘', 'history', 'clock-counter-clockwise', 'history', 'history', 'history'],
  link: ['🔗', 'link', 'link', 'link', 'link', 'link'],
  globe: ['🌐', 'globe', 'globe', 'world', 'global', 'language'],
  image: ['🖼️', 'image', 'image', 'photo', 'gallery', 'image'],
  radio: ['📡', 'radio-tower', 'broadcast', 'antenna', 'wi-fi-router', 'sensors'],
  folders: ['🗂️', 'folders', 'folders', 'folders', 'folder-with-files', 'folder-copy'],
  chart: ['📈', 'chart-line', 'chart-line', 'chart-line', 'chart', 'show-chart'],
  timer: ['⏱️', 'timer', 'timer', 'stopwatch', 'stopwatch', 'timer'],
  note: ['📝', 'sticky-note', 'note', 'note', 'notes', 'sticky-note-2'],
  check: ['☑️', 'square-check', 'check-square', 'square-check', 'check-square', 'check-box'],
  flow: ['📦', 'package', 'package', 'package', 'box', 'package-2'],
  bot: ['🤖', 'bot', 'robot', 'robot', 'chat-round-dots', 'smart-toy'],
  memory: ['🧠', 'brain', 'brain', 'brain', 'brain', 'psychology'],
  skill: ['📜', 'book-open', 'book-open', 'book', 'book', 'menu-book'],
  mcp: ['🔌', 'plug', 'plug', 'plug', 'plug-circle', 'cable'],
  // --- the communication wards: a brand glyph where the set has one ---
  discord: ['🎮', 'message-square', 'discord-logo', 'brand-discord', 'chat-round-dots', 'forum'],
  slack: ['💬', 'hash', 'slack-logo', 'brand-slack', 'hashtag-chat', 'chat'],
  telegram: ['✈️', 'send', 'telegram-logo', 'brand-telegram', 'plain', 'send'],
  sms: ['📱', 'message-circle', 'chat-dots', 'message-2', 'chat-round-line', 'sms'],
  push: ['🔔', 'bell-ring', 'bell', 'bell', 'bell', 'notifications'],
  matrix: ['🔲', 'hash', 'hash', 'brand-matrix', 'hashtag-square', 'forum'],
  teams: ['👥', 'users', 'microsoft-teams-logo', 'brand-teams', 'users-group-rounded', 'group'],
  square: ['⬜', 'square', 'square', 'square', 'stop', 'crop-square'],
  minus: ['➖', 'minus', 'minus', 'minus', 'minus-square', 'remove'],
  folder: ['📁', 'folder', 'folder', 'folder', 'folder', 'folder'],
  dot: ['▫️', 'square-dot', 'dots-three', 'square-dot', 'menu-dots-square', 'more-horiz'],
  incident: ['🚨', 'siren', 'siren', 'alert-triangle', 'siren', 'siren'],
  button: ['🔘', 'mouse-pointer-click', 'hand-tap', 'click', 'cursor', 'touch-app'],
  // --- chrome: edit-mode controls, context menu, dialogs ---
  left: ['◀', 'chevron-left', 'caret-left', 'chevron-left', 'alt-arrow-left', 'chevron-left'],
  right: ['▶', 'chevron-right', 'caret-right', 'chevron-right', 'alt-arrow-right', 'chevron-right'],
  resize: ['⤢', 'maximize-2', 'arrows-out', 'arrows-diagonal', 'maximize', 'open-in-full'],
  eye: ['👁', 'eye', 'eye', 'eye', 'eye', 'visibility'],
  palette: ['🎨', 'palette', 'palette', 'palette', 'palette', 'palette'],
  settings: ['⚙', 'settings', 'gear', 'settings', 'settings', 'settings'],
  close: ['✕', 'x', 'x', 'x', 'close-circle', 'close'],
  more: ['⋯', 'ellipsis', 'dots-three', 'dots', 'menu-dots', 'more-horiz'],
  search: ['🔍', 'search', 'magnifying-glass', 'search', 'magnifer', 'search'],
  save: ['💾', 'save', 'floppy-disk', 'device-floppy', 'diskette', 'save'],
  warning: ['⚠️', 'triangle-alert', 'warning', 'alert-triangle', 'danger-triangle', 'warning'],
  info: ['ℹ️', 'info', 'info', 'info-circle', 'info-circle', 'info'],
  star: ['⭐', 'star', 'star', 'star', 'star', 'star'],
  archive: ['🗜️', 'archive', 'archive', 'archive', 'archive', 'archive'],
  plus: ['＋', 'plus', 'plus', 'plus', 'add-circle', 'add'],
  'folder-out': ['📤', 'folder-output', 'folder-minus', 'folder-minus', 'folder-error', 'folder-off'],
  copy: ['⧉', 'copy', 'copy', 'copy', 'copy', 'content-copy'],
  reset: ['↺', 'rotate-ccw', 'arrow-counter-clockwise', 'rotate', 'restart', 'restart-alt'],
  attach: ['📎', 'paperclip', 'paperclip', 'paperclip', 'paperclip', 'attach-file'],
  stop: ['⏹', 'square', 'stop', 'player-stop', 'stop', 'stop'],
  send: ['➤', 'send', 'paper-plane-tilt', 'send', 'plain', 'send'],
  // --- the notepad's toolbar ---
  sparkle: ['✨', 'sparkles', 'sparkle', 'sparkles', 'stars-minimalistic', 'auto-awesome'],
  wand: ['🪄', 'wand-sparkles', 'magic-wand', 'wand', 'magic-stick-3', 'auto-fix'],
  route: ['🛤️', 'route', 'path', 'route', 'routing', 'route'],
  brush: ['🖌️', 'pen-tool', 'pen-nib', 'brush', 'pen-2', 'draw'],
  eraser: ['🧽', 'eraser', 'eraser', 'eraser', 'eraser', 'ink-eraser'],
  bold: ['𝐁', 'bold', 'text-b', 'bold', 'text-bold', 'format-bold'],
  italic: ['𝘐', 'italic', 'text-italic', 'italic', 'text-italic', 'format-italic'],
  underline: ['U̲', 'underline', 'text-underline', 'underline', 'text-underline', 'format-underlined'],
  strike: ['S̶', 'strikethrough', 'text-strikethrough', 'strikethrough', 'text-cross', 'format-strikethrough'],
  heading: ['H', 'heading', 'text-h', 'heading', 'text-square', 'format-h1'],
  list: ['•', 'list', 'list-bullets', 'list', 'list', 'format-list-bulleted'],
  'list-ol': ['1.', 'list-ordered', 'list-numbers', 'list-numbers', 'list-check', 'format-list-numbered'],
  quote: ['❝', 'quote', 'quotes', 'quote', 'chat-square-like', 'format-quote'],
  code: ['‹›', 'code', 'code', 'code', 'code', 'code'],
  indent: ['⇥', 'indent-increase', 'text-indent', 'indent-increase', 'text-field', 'format-indent-increase'],
  outdent: ['⇤', 'indent-decrease', 'text-outdent', 'indent-decrease', 'text-field-focus', 'format-indent-decrease'],
  'clear-format': ['⌫', 'remove-formatting', 'text-t-slash', 'clear-formatting', 'text-cross', 'format-clear'],
  undo: ['↶', 'undo-2', 'arrow-u-up-left', 'arrow-back-up', 'undo-left', 'undo'],
  redo: ['↷', 'redo-2', 'arrow-u-up-right', 'arrow-forward-up', 'undo-right', 'redo'],
  download: ['⬇', 'download', 'download-simple', 'download', 'download', 'download'],
  // --- the remote desktop ward's toolbar ---
  fullscreen: ['⛶', 'maximize', 'corners-out', 'maximize', 'full-screen', 'fullscreen'],
  'fullscreen-exit': ['⤡', 'minimize', 'corners-in', 'minimize', 'quit-full-screen', 'fullscreen-exit'],
  keyboard: ['⌨️', 'keyboard', 'keyboard', 'keyboard', 'keyboard', 'keyboard'],
  mouse: ['🖱️', 'mouse', 'mouse', 'mouse', 'mouse', 'mouse'],
  monitor: ['🖥', 'monitor', 'monitor', 'device-desktop', 'monitor', 'desktop-windows'],
  volume: ['🔊', 'volume-2', 'speaker-high', 'volume', 'volume-loud', 'volume-up'],
  'volume-off': ['🔇', 'volume-x', 'speaker-slash', 'volume-off', 'muted', 'volume-off'],
  gauge: ['📊', 'gauge', 'gauge', 'gauge', 'speedometer-middle', 'speed'],
  quality: ['🎚️', 'sliders-horizontal', 'sliders-horizontal', 'adjustments-horizontal', 'tuning-2', 'tune'],
  clipboard: ['📋', 'clipboard', 'clipboard', 'clipboard', 'clipboard', 'content-paste'],
  pin: ['📌', 'pin', 'push-pin', 'pin', 'pin', 'push-pin'],
  touchpad: ['🤚', 'touchpad', 'hand-grabbing', 'hand-move', 'cursor-square', 'trackpad-input'],
  scaling: ['⊡', 'scaling', 'frame-corners', 'aspect-ratio', 'crop', 'aspect-ratio'],
  print: ['🖨', 'printer', 'printer', 'printer', 'printer', 'print'],
  trash: ['🗑', 'trash-2', 'trash', 'trash', 'trash-bin-trash', 'delete'],
  // --- weather (the meteocons column) ---
  sun: ['☀️', 'sun', 'sun', 'sun', 'sun', 'sunny', 'clear-day'],
  'sun-cloud': ['⛅', 'cloud-sun', 'cloud-sun', 'sun-wind', 'cloud-sun', 'partly-cloudy-day', 'partly-cloudy-day'],
  cloud: ['☁️', 'cloud', 'cloud', 'cloud', 'cloud', 'cloud', 'overcast'],
  fog: ['🌫', 'cloud-fog', 'cloud-fog', 'mist', 'cloud-waterdrops', 'foggy', 'fog'],
  drizzle: ['🌦', 'cloud-drizzle', 'cloud-rain', 'cloud-rain', 'cloud-rain', 'rainy-light', 'drizzle'],
  rain: ['🌧', 'cloud-rain-wind', 'cloud-rain', 'cloud-storm', 'cloud-storm', 'rainy', 'rain'],
  snow: ['🌨', 'cloud-snow', 'cloud-snow', 'cloud-snow', 'cloud-snowfall', 'weather-snowy', 'snow'],
  storm: ['⛈', 'cloud-lightning', 'cloud-lightning', 'cloud-storm', 'cloud-bolt', 'thunderstorm', 'thunderstorms'],
} satisfies Record<string, Row>;

export type IconId = keyof typeof ICONS;
export const ICON_IDS = Object.keys(ICONS) as IconId[];

/** WMO weather code → icon id (Open-Meteo's `weather_code`). */
export const WMO_ICON: Record<number, IconId> = {
  0: 'sun', 1: 'sun-cloud', 2: 'sun-cloud', 3: 'cloud', 45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'rain', 61: 'rain', 63: 'rain', 65: 'rain',
  66: 'rain', 67: 'rain', 71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow',
  80: 'drizzle', 81: 'rain', 82: 'storm', 85: 'snow', 86: 'snow', 95: 'storm', 96: 'storm', 99: 'storm',
};

/** The slice of a theme the icon renderer needs — stamped on <html data-icons>. */
export interface IconCfg {
  set: IconSet;
  style: string;
  /** stroke-width for the stroke sets. */
  stroke: number;
  weather: WeatherIcons;
}

export type IconRef = { kind: 'text'; text: string } | { kind: 'mask' | 'img'; url: string };

export function iconUrl(set: IconSet, name: string, style: string, stroke?: number): string {
  const q = new URLSearchParams();
  if (style) q.set('s', style);
  if (stroke && ICON_SETS[set].stroke) q.set('sw', String(stroke));
  const qs = q.toString();
  return `/api/icon/${set}/${name}${qs ? `?${qs}` : ''}`;
}

/** Resolve an id (or, for user text like an applink icon, an emoji / a raw
 *  name in the current set) to what to draw. No cfg = the stock emoji. */
export function iconRef(cfg: IconCfg | null, id: string): IconRef {
  const row = (ICONS as Record<string, Row>)[id];
  if (!row) {
    // Free text: a name-shaped string is looked up in the current set (Lucide
    // when the theme is still on emoji), anything else is shown as-is.
    if (!ICON_NAME_RE.test(id)) return { kind: 'text', text: id };
    const set = cfg && cfg.set !== 'emoji' ? cfg.set : 'lucide';
    return { kind: 'mask', url: iconUrl(set, id, cfg?.set === set ? cfg.style : '', cfg?.stroke) };
  }
  const meteo = row[COL.meteocons];
  if (meteo && cfg && cfg.weather !== 'follow') {
    return { kind: 'img', url: iconUrl('meteocons', meteo, cfg.weather === 'meteocons-fill' ? 'fill' : 'line') };
  }
  if (!cfg || cfg.set === 'emoji') return { kind: 'text', text: row[0] };
  return { kind: 'mask', url: iconUrl(cfg.set, row[COL[cfg.set]]!, cfg.style, cfg.stroke) };
}
