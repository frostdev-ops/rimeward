// Presets: one row of swatches above the colour grid. Loaded after popup.js, so `settings` and
// `render` (top-level bindings of a classic script) are in scope — no popup.js change needed.
for (const [name, colors] of GZ_PRESETS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch';
  b.title = name;
  b.setAttribute('aria-label', name);
  b.style.background = colors['--gz-surface'];
  b.style.borderColor = colors['--gz-line-strong'];
  b.style.setProperty('--dot', colors['--gz-accent']);
  b.addEventListener('click', () => {
    // Merge onto whatever is stored: a preset replaces the palette, nothing else.
    chrome.storage.sync.get(null, (raw) => chrome.storage.sync.set({ ...raw, colors: { ...colors } }));
    settings.colors = { ...colors };
    render();
  });
  document.querySelector('#presets').append(b);
}
