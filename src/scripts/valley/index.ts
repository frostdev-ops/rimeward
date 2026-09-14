// Valley entry — three arrives lazily, the form never waits on it.
import type { ValleyHandle } from './scene.ts';

const canvas = document.getElementById('valley-canvas') as HTMLCanvasElement | null;
// ?still renders a single deterministic frame — used for screenshots/review.
const still = new URLSearchParams(location.search).has('still');
const reduced = still || matchMedia('(prefers-reduced-motion: reduce)').matches;

let handle: ValleyHandle | null = null;
let gating = false;
let settle!: (h: ValleyHandle | null) => void;

/** Resolves once the scene is up (or null: no canvas, no WebGL, chunk failed). */
export const valley: Promise<ValleyHandle | null> = new Promise((r) => {
  settle = r;
});

function boot() {
  if (!canvas) return settle(null);
  if (canvas.dataset.booted) return;
  canvas.dataset.booted = '1';
  const depth = Number(canvas.dataset.depth) || 0;
  import('./scene.ts')
    .then((m) => {
      handle = m.createValleyScene(canvas, { still, depth });
    })
    .catch(() => {
      // Chunk failed to load — the CSS ground layer stays the experience.
    })
    .then(() => settle(handle));
}

if ('requestIdleCallback' in window) requestIdleCallback(boot);
else setTimeout(boot, 1);
addEventListener('pointermove', boot, { once: true, passive: true });

// bfcache hands the page back exactly as it left it: mid-gate, so the flash is
// still down and the gate still closed. Nothing here touches the DOM otherwise
// (a disabled button would come back disabled forever).
addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  gating = false;
  document.getElementById('gate-flash')?.classList.remove('flash-in');
  try {
    sessionStorage.removeItem('fd-gate');
  } catch {
    /* private mode */
  }
});

/** Dive into the terrain, then navigate. /dash plays the inverse flash. */
export async function gate(go: () => void): Promise<void> {
  if (gating) return;
  gating = true;
  boot(); // idempotent — idle callback may not have fired yet
  // The scene chunk may still be in flight (~350ms cold). Worth a moment for
  // the dive, never worth the form feeling stuck.
  if (!reduced && !handle) await Promise.race([valley, new Promise((r) => setTimeout(r, 300))]);
  if (reduced || !handle) return go();
  handle.startGate(); // camera dive + glow, 650ms
  setTimeout(() => document.getElementById('gate-flash')?.classList.add('flash-in'), 350);
  setTimeout(() => {
    try {
      sessionStorage.setItem('fd-gate', '1');
    } catch {
      /* private mode */
    }
  }, 500);
  setTimeout(go, 650);
}

// A form that wants the dive marks itself data-gate. Its submit button gusts
// the terrain on hover, and submitting dives before the real POST goes out.
for (const form of document.querySelectorAll<HTMLFormElement>('form[data-gate]')) {
  const btn = form.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])');
  if (btn) {
    const up = () => handle?.setGust(3);
    const down = () => handle?.setGust(1);
    btn.addEventListener('pointerenter', up);
    btn.addEventListener('pointerleave', down);
    btn.addEventListener('focus', up);
    btn.addEventListener('blur', down);
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    // gate() is the re-entry guard (a second press before the dive lands is
    // dropped). form.submit() omits the submitter's name/value, so a gated
    // form must not need one.
    void gate(() => form.submit());
  });
}
