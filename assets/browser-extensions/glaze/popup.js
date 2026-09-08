// Popup: every control writes straight to chrome.storage.sync; the content script listens.
const $ = (s) => document.querySelector(s);
let settings = GZ_MERGE();

// Switches save at once: the popup closes the moment focus leaves it, and a pending timer dies
// with it. Colour inputs fire on every drag tick and sync storage has a per-minute write quota,
// so those alone are debounced.
let saveTimer = 0;
let touched = false;
// sync storage has write quotas and can fail offline; say so instead of silently losing the change.
const note = (msg) => { const h = $('.hint'); if (h) h.textContent = msg; };
const save = () => {
  clearTimeout(saveTimer);
  touched = true;
  try {
    chrome.storage.sync.set(settings, () => {
      const err = chrome.runtime.lastError;
      note(err ? `Not saved: ${err.message}` : 'Changes apply to open Blackboard Ultra tabs immediately.');
    });
  } catch (e) { note(`Not saved: ${e.message}`); }
};
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 150); };

// The popup previews the palette on itself.
const preview = () => { for (const [v] of GZ_COLORS) document.documentElement.style.setProperty(v, settings.colors[v]); };

// body.off only sets pointer-events:none, which still leaves the controls keyboard-reachable.
const setOff = () => {
  document.body.classList.toggle('off', !settings.enabled);
  for (const s of document.querySelectorAll('section')) s.inert = !settings.enabled;
};

const render = () => {
  $('#enabled').checked = settings.enabled;
  setOff();
  const grid = $('#colors');
  grid.replaceChildren();
  for (const [v, label] of GZ_COLORS) {
    const row = document.createElement('label');
    const input = Object.assign(document.createElement('input'), { type: 'color', value: settings.colors[v], title: v });
    input.addEventListener('input', () => { settings.colors[v] = input.value; preview(); saveSoon(); });
    input.addEventListener('change', save);
    row.append(input, label);
    grid.append(row);
  }
  for (const cb of document.querySelectorAll('[data-motion]')) cb.checked = settings.motion[cb.dataset.motion];
  $('#footer').checked = settings.footer;
  preview();
};

// The popup renders from the defaults first, so ignore a slow load if the user already changed
// something — otherwise their edit is overwritten by what was on disk.
render();
chrome.storage.sync.get(null, (raw) => {
  if (touched) return;
  if (chrome.runtime.lastError) return note(`Could not load settings: ${chrome.runtime.lastError.message}`);
  settings = GZ_MERGE(raw);
  render();
});

$('#enabled').addEventListener('change', (e) => {
  settings.enabled = e.target.checked;
  setOff();
  save();
});
for (const cb of document.querySelectorAll('[data-motion]')) {
  cb.addEventListener('change', () => { settings.motion[cb.dataset.motion] = cb.checked; save(); });
}
$('#footer').addEventListener('change', (e) => { settings.footer = e.target.checked; save(); });
$('#reset').addEventListener('click', () => { settings.colors = { ...GZ_DEFAULTS.colors }; render(); save(); });
