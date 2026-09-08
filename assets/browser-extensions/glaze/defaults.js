// Shared by the content script and the popup — the one place a default lives.
// One row per colour token: CSS variable, popup label, default value (the "Frost" preset).
const GZ_COLORS = [
  ['--gz-accent', 'Accent', '#17c8f4'],
  ['--gz-accent-hi', 'Accent bright', '#6fdcff'],
  ['--gz-accent-soft', 'Accent tint', '#082f49'],
  ['--gz-accent-ink', 'Text on accent', '#04121f'],
  ['--gz-surface', 'Surface', '#0d1b2e'],
  ['--gz-surface-2', 'Ground', '#060d18'],
  ['--gz-ink', 'Text', '#e8f2fa'],
  ['--gz-ink-muted', 'Muted text', '#8fa8c0'],
  ['--gz-ink-faint', 'Faint text', '#5c7189'],
  ['--gz-line', 'Line', '#16283f'],
  ['--gz-line-strong', 'Strong line', '#24405f'],
  ['--gz-ok', 'Success', '#34d399'],
  ['--gz-warn', 'Warning', '#fbbf24'],
  ['--gz-err', 'Error', '#f87171'],
];

const GZ_DEFAULTS = {
  enabled: true,
  colors: Object.fromEntries(GZ_COLORS.map(([v, , d]) => [v, d])),
  motion: { enter: true, hover: true, transitions: true },
  footer: true,
};

// Stored settings are partial (older versions, a token added later): fill from defaults.
const GZ_MERGE = (raw = {}) => ({
  enabled: raw.enabled ?? GZ_DEFAULTS.enabled,
  colors: { ...GZ_DEFAULTS.colors, ...(raw.colors || {}) },
  motion: { ...GZ_DEFAULTS.motion, ...(raw.motion || {}) },
  footer: raw.footer ?? GZ_DEFAULTS.footer,
});

// ---- presets ---------------------------------------------------------------------------------
// A preset is a full palette. Values are listed in GZ_COLORS order, so a token added to GZ_COLORS
// without a matching value here shows up as undefined immediately rather than silently defaulting.
const GZ_PALETTE = (...v) => Object.fromEntries(GZ_COLORS.map(([tok], i) => [tok, v[i]]));

// [name, colors]. Every palette clears WCAG AA (4.5:1 ink on surface, >=3:1 muted/faint on
// surface, 4.5:1 accent-ink on accent).
const GZ_PRESETS = [
  ['Frost', { ...GZ_DEFAULTS.colors }],
  ['Midnight', GZ_PALETTE(
    '#a78bfa', '#c4b5fd', '#2a2140', '#16101f',
    '#16161a', '#0d0d10', '#ececf1', '#a1a1ac', '#6e6e78', '#26262c', '#3a3a44',
    '#34d399', '#fbbf24', '#f87171')],
  ['Forest', GZ_PALETTE(
    '#5eead4', '#99f6e4', '#062f2a', '#04201c',
    '#0f1f18', '#081410', '#e4f2ea', '#93b3a4', '#648376', '#17332a', '#26503f',
    '#34d399', '#fbbf24', '#f87171')],
  ['Ember', GZ_PALETTE(
    '#fb923c', '#fdba74', '#3a2113', '#1e1006',
    '#221c19', '#15100e', '#f5ebe4', '#b4a094', '#82706a', '#332723', '#4d3a33',
    '#34d399', '#fbbf24', '#f87171')],
  ['Paper', GZ_PALETTE(
    '#2563eb', '#1d4ed8', '#dbeafe', '#ffffff',
    '#ffffff', '#f4f5f7', '#14181f', '#5b6472', '#8a929e', '#e3e6ea', '#c8cdd4',
    '#15803d', '#b45309', '#b91c1c')],
  ['Rose', GZ_PALETTE(
    '#c026d3', '#a21caf', '#fbe3fb', '#ffffff',
    '#fff7fa', '#fdeef4', '#2a1622', '#6d4d61', '#997d8d', '#f4dbe6', '#e5bfd1',
    '#15803d', '#b45309', '#be123c')],
];
