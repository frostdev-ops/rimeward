// Splash entry — tiny and sync. All of three arrives via the dynamic import
// of scene.ts, kicked off at idle (or first interaction, whichever is first).
import type { SceneHandle } from './scene.ts';

const canvas = document.getElementById('splash-canvas') as HTMLCanvasElement | null;
const cta = document.getElementById('enter') as HTMLAnchorElement | null;
// ?still renders a single deterministic frame — used for screenshots/review.
const still = new URLSearchParams(location.search).has('still');
const reduced = still || matchMedia('(prefers-reduced-motion: reduce)').matches;

let handle: SceneHandle | null = null;
let booted = false;

function boot() {
  if (booted || !canvas) return;
  booted = true;
  import('./scene.ts')
    .then((m) => {
      handle = m.createScene(canvas, { still });
    })
    .catch(() => {
      // Chunk failed to load — the CSS ground layer stays, CTA still navigates.
    });
}

if ('requestIdleCallback' in window) requestIdleCallback(boot);
else setTimeout(boot, 1);
addEventListener('pointermove', boot, { once: true, passive: true });
addEventListener('scroll', boot, { once: true, passive: true });

if (cta) {
  const gustUp = () => handle?.setGust(3);
  const gustDown = () => handle?.setGust(1);
  cta.addEventListener('pointerenter', gustUp);
  cta.addEventListener('pointerleave', gustDown);
  cta.addEventListener('focus', gustUp);
  cta.addEventListener('blur', gustDown);

  let gating = false;
  // bfcache restores the page mid-dive: re-arm the CTA and drop the flash.
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
  cta.addEventListener('click', (e) => {
    e.preventDefault();
    if (gating) return;
    if (reduced || !handle) {
      location.href = cta.href; // plain navigation
      return;
    }
    gating = true;
    handle.startGate(); // camera dive + glow, 650ms
    setTimeout(() => document.getElementById('gate-flash')?.classList.add('flash-in'), 350);
    setTimeout(() => {
      try {
        sessionStorage.setItem('fd-gate', '1'); // login plays the inverse
      } catch {
        /* private mode */
      }
    }, 500);
    setTimeout(() => {
      location.href = cta.href;
    }, 650);
  });
}
