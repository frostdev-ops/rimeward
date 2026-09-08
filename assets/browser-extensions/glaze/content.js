// Glaze — content script, document_start.
// Three jobs: (1) put theme.css on the page while the theme is on (a <link> we own, so the popup
// can toggle it without a reload), (2) push settings onto <html> — custom --gz-* colours as inline
// vars, which beat the stylesheet defaults, and the motion/footer switches as data attributes,
// (3) the long tail: tag what no selector can reach and let theme.css restyle the tag.
(() => {
  if (window.__gzGlaze) return;
  window.__gzGlaze = true;

  const html = document.documentElement;
  const SKIP = /^(IMG|VIDEO|CANVAS|SVG|IFRAME|PICTURE|SOURCE|PATH|USE|SCRIPT|STYLE|LINK|META)$/;
  const TAGS = ['data-gz-light', 'data-gz-dark', 'data-gz-fixed-bottom', 'data-gz-vh'];
  let settings = GZ_DEFAULTS;
  let link = null;
  let observer = null;
  let timer = 0;
  let notUltra = false;

  // Luminance of an rgb()/rgba() string; null when transparent, or when the colour is saturated
  // (an accent button, a grade pill) — only greys and whites are Ultra's "paper", never brand colours.
  const lum = (c) => {
    const m = c.match(/[\d.]+/g);
    if (!m || (m[3] !== undefined && +m[3] < 0.5)) return null;
    if (Math.max(m[0], m[1], m[2]) - Math.min(m[0], m[1], m[2]) > 60) return null;
    return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
  };
  const hexLum = (h) => { const n = parseInt(h.slice(1), 16); return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
  const hasText = (e) => { for (const n of e.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true; return false; };
  const onBody = (fn) => (document.body ? fn() : document.addEventListener('DOMContentLoaded', fn, { once: true }));
  // `https://*/ultra/*` matches any host with that path, so confirm this is really Blackboard
  // Ultra before touching the page. Checked once, when the body exists.
  const isUltra = () => !!document.querySelector('#site-wrap, [class*="bb-"], [id*="bb-"], base[href*="ultra"]');

  // ---- long tail -------------------------------------------------------------------------------
  // Read everything first, write after: setting an attribute mid-loop invalidates layout and the
  // next getBoundingClientRect would force a reflow, once per element.
  // A full pass is O(elements) getComputedStyle calls, so only the first pass looks at everything;
  // after that we only look at the subtrees the mutation observer reports.
  // ponytail: 20k-element cap on the full pass; drop it if a real page ever needs one that big.
  const MAX_FULL = 20000;
  const sweepEls = (els) => {
    const pending = [];
    for (const e of els) {
      if (!e.isConnected || SKIP.test(e.tagName) || e.id === 'gz-footer' || e.closest('svg')) continue;
      const cs = getComputedStyle(e);
      const tags = [];
      const bg = lum(cs.backgroundColor);
      if (bg !== null && bg > 0.4 && cs.backgroundImage === 'none') tags.push('data-gz-light');
      const fg = lum(cs.color);
      if (fg !== null && fg < 0.35 && hasText(e)) tags.push('data-gz-dark');
      const r = e.getBoundingClientRect();
      // Fixed to the bottom of the VIEWPORT (Ultra's action bars, the help button): outside the
      // shrunk layout, so it would sit over the footer. Lift it by the footer height.
      if (cs.position === 'fixed' && r.bottom >= innerHeight - 1) tags.push('data-gz-fixed-bottom');
      // Sized with 100vh (Ultra's route containers): the shrunk wrappers can't reach it, so clamp.
      if (Math.abs(r.height - innerHeight) <= 1) tags.push('data-gz-vh');
      if (tags.length) pending.push([e, tags]);
    }
    for (const [e, tags] of pending) for (const a of tags) e.setAttribute(a, '');
  };
  const sweepAll = () => {
    const all = document.body.querySelectorAll('*');
    if (all.length <= MAX_FULL) sweepEls(all);
  };
  const sweepRoots = (roots) => {
    const els = [];
    for (const r of roots) {
      if (!r.isConnected) continue;
      els.push(r);
      for (const d of r.querySelectorAll('*')) els.push(d);
      if (els.length > MAX_FULL) break;
    }
    sweepEls(els);
  };

  let dirty = new Set();
  let full = false;
  const flush = () => {
    const roots = [...dirty];
    dirty.clear();
    if (full) { full = false; sweepAll(); } else sweepRoots(roots);
  };
  const schedule = (records) => {
    for (const r of records) {
      if (r.type === 'attributes') dirty.add(r.target);
      else for (const n of r.addedNodes) if (n.nodeType === 1) dirty.add(n);
    }
    // Too many separate subtrees to be worth tracking: one full pass is cheaper.
    if (dirty.size > 500) { dirty.clear(); full = true; }
    clearTimeout(timer);
    timer = setTimeout(flush, 150);
  };
  const startSweep = () => {
    if (observer) return;
    sweepAll();
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  };
  const stopSweep = () => {
    observer?.disconnect();
    observer = null;
    clearTimeout(timer);
    dirty.clear();
    full = false;
    for (const a of TAGS) for (const e of document.querySelectorAll(`[${a}]`)) e.removeAttribute(a);
  };

  // ---- footer ---------------------------------------------------------------------------------
  // A full-width bar, top frame only. theme.css shrinks the app by --gz-footer-h so the bar sits
  // below everything rather than over it.
  const syncFooter = () => {
    const want = link && settings.footer && window.top === window && document.body;
    const have = document.getElementById('gz-footer');
    if (want && !have) {
      const f = document.createElement('footer');
      f.id = 'gz-footer';
      const a = document.createElement('a');
      a.href = 'https://github.com/frostdev-ops/glaze';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Glaze';
      f.appendChild(a);
      document.body.appendChild(f);
    } else if (!want && have) have.remove();
  };

  // ---- settings → <html> ----------------------------------------------------------------------
  const applySettings = () => {
    for (const [v] of GZ_COLORS) html.style.setProperty(v, settings.colors[v]);
    html.style.colorScheme = hexLum(settings.colors['--gz-surface']) > 0.5 ? 'light' : 'dark';
    html.toggleAttribute('data-gz-no-trans', !settings.motion.transitions);
    html.toggleAttribute('data-gz-no-enter', !settings.motion.enter);
    html.toggleAttribute('data-gz-no-hover', !settings.motion.hover);
    html.toggleAttribute('data-gz-footer', settings.footer);
    syncFooter();
  };
  const clearSettings = () => {
    for (const [v] of GZ_COLORS) html.style.removeProperty(v);
    html.style.removeProperty('color-scheme');
    for (const a of ['data-gz-no-trans', 'data-gz-no-enter', 'data-gz-no-hover', 'data-gz-footer']) html.removeAttribute(a);
  };

  const enable = () => {
    if (notUltra) return;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('theme.css');
      (document.head || html).appendChild(link);
    }
    applySettings();
    onBody(() => {
      if (!link) return;
      if (!isUltra()) { disable(); notUltra = true; return; }
      syncFooter();
      startSweep();
    });
  };
  const disable = () => {
    link?.remove();
    link = null;
    stopSweep();
    clearSettings();
    syncFooter();
  };

  // Storage can fail (offline sync errors) and every chrome.* call throws once the extension is
  // reloaded or updated under a live tab. Fall back to the defaults rather than breaking the page.
  const load = () => new Promise((res) => {
    try {
      chrome.storage.sync.get(null, (raw) => {
        if (chrome.runtime.lastError) return res(GZ_MERGE());
        res(GZ_MERGE(raw));
      });
    } catch { res(GZ_MERGE()); }
  });
  load().then((s) => { settings = s; if (s.enabled) enable(); });
  chrome.storage.onChanged.addListener((_, area) => {
    if (area !== 'sync') return;
    load().then((s) => {
      const was = settings.enabled && !!link;
      settings = s;
      if (s.enabled && !was) enable();
      else if (!s.enabled && was) disable();
      else if (s.enabled) applySettings();
    });
  });
})();
