// The overlay page. One file for every window in the pool (ov-0..ov-7); the kind
// arrives with each `overlay:show`, so a slot can be reused for any kind.
// Lifted from BlackIce overlay/main.ts as plain ESM.
import { caption, cardLines } from './render.js';

const tauri = window.__TAURI__;
// Listeners belong to THIS window. Rust emits `overlay:show` to one slot by
// label; a global `event.listen` is a catch-all that every window in the pool
// would fire on, and then every visible caption shows the newest batch.
const own = tauri?.webviewWindow.getCurrentWebviewWindow();
const root = document.getElementById('root');

function box(className, text) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text; // screen text is untrusted: never innerHTML
  return el;
}

export function render(p) {
  root.className = p.kind;
  root.replaceChildren();
  if (p.kind === 'card') {
    const { lines, truncated } = cardLines(p.text);
    root.append(box(truncated ? 'card-text truncated' : 'card-text', lines.join('\n')));
    return;
  }
  if (p.kind === 'caption') {
    const c = caption(p.text, p.origin ?? [0, 0]);
    if (c.form === 'single') {
      root.append(box('caption-single', c.text));
      return;
    }
    for (const item of c.items) {
      const el = box('caption-item', item.text);
      el.style.left = `${item.left}px`;
      el.style.top = `${item.top}px`;
      // min, not fixed: a translation is often longer than the line it covers.
      el.style.minWidth = `${item.width}px`;
      el.style.minHeight = `${item.height}px`;
      root.append(el);
    }
    return;
  }
  // highlight: the window is the rect, overlay.css draws the frame on #root.
}

if (tauri && own) {
  void own.listen('overlay:show', (e) => {
    render(e.payload);
    // Ack at once: the DOM is already in place, and a window that is still
    // hidden gets no animation frame, so anything deferred would only run
    // after Rust gave up waiting and showed it anyway.
    void tauri.event.emit('overlay:ready', { id: e.payload.id });
  });
  void own.listen('overlay:interactive', (e) => {
    document.body.classList.toggle('interactive', e.payload.on === true);
  });
}
