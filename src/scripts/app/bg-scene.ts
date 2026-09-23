// The three.js scene renderer. One quad running bg-shaders, so a preset switch
// is a uniform write and the whole thing is one draw call. Everything three
// lives here: background.ts imports it dynamically, so the dash's main chunk
// still ships zero three bytes unless a scene is turned on.
//
// Sized to ITS CANVAS, not the window — that is what lets the same renderer
// drive the full-screen background and the header banner. For the background
// the canvas is inset:0 fixed, so the two are the same number.
import * as THREE from 'three';
import { bgVert, bgFrag } from './bg-shaders.ts';
import { SCENE_INDEX } from '../../lib/theme.ts';
import type { SceneConfig } from '../../lib/theme.ts';

export interface BgHandle {
  /** Live knob change (the account editor calls this on every input). */
  update(cfg: SceneConfig): void;
  destroy(): void;
}


export function createBgScene(canvas: HTMLCanvasElement, cfg: SceneConfig): BgHandle | null {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false, // one quad, no geometry edges to smooth
      powerPreference: 'low-power', // it is wallpaper, not the point of the page
      depth: false,
      stencil: false,
    });
  } catch {
    return null; // no WebGL — the page keeps its flat token background
  }

  // Wallpaper does not need device pixels, and most presets do not even need
  // CSS pixels: cfg.res (default SCENES[x].res) is the fraction the /perf diff
  // harness found indistinguishable after the compositor's upscale (0.5 = a
  // quarter of the fragment work). hidpi lifts the device-pixel cap to 2×.
  // The governor can go lower still.
  let notch = 0; // 1: 0.7× smaller again, 2: 15fps. Never steps back up.
  let res = cfg.res;
  let hidpi = cfg.hidpi;
  let govern = cfg.govern;
  const baseScale = () => Math.min(devicePixelRatio || 1, hidpi ? 2 : 1) * res;
  const applyScale = () => {
    renderer.setPixelRatio(baseScale() * (notch >= 1 ? 0.7 : 1));
    renderer.setSize(boxW(), boxH(), false);
  };
  // clientWidth is 0 before layout (or on a display:none host) — fall back to
  // the viewport so the first frame is never a 0x0 render.
  const boxW = () => canvas.clientWidth || innerWidth;
  const boxH = () => canvas.clientHeight || innerHeight;
  applyScale();

  const uniforms = {
    uRes: { value: new THREE.Vector2(boxW(), boxH()) },
    uTime: { value: 0 },
    uC1: { value: new THREE.Color(cfg.colors[0]) },
    uC2: { value: new THREE.Color(cfg.colors[1]) },
    uC3: { value: new THREE.Color(cfg.colors[2]) },
    uGlow: { value: cfg.glow },
    uScale: { value: cfg.scale },
    uWarp: { value: cfg.warp },
    uOpacity: { value: cfg.opacity },
    uMouse: { value: new THREE.Vector2(0, 0) },
    uScene: { value: SCENE_INDEX[cfg.scene] ?? 0 },
    uDetail: { value: cfg.detail },
  };

  let parallax = cfg.parallax;

  const scene = new THREE.Scene();
  const camera = new THREE.Camera(); // the quad is already in clip space
  // One program for all presets, selected by the uScene uniform. Compiling one
  // preset per program (the shader's SCENE_ID hook; /perf has a checkbox for
  // it) measured no per-frame or compile-time difference on Apple silicon, so
  // a preset switch stays a uniform write.
  const material = new THREE.ShaderMaterial({ vertexShader: bgVert, fragmentShader: bgFrag, uniforms, transparent: true });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);

  // ---------------------------------------------------------- parallax
  const target = new THREE.Vector2(0, 0);
  const mouse = new THREE.Vector2(0, 0);
  const onPointer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    target.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
  };
  // Always attached: update() can raise parallax from 0 (the live editor), and
  // a passive pointermove is cheaper than getting that wrong.
  if (matchMedia('(pointer: fine)').matches) addEventListener('pointermove', onPointer, { passive: true });

  // ------------------------------------------------- perf governor state
  // Two notches, never back up: render smaller, then cap the frame rate.
  // Wallpaper is capped at ~30fps by default: nothing here moves fast enough
  // to read at 60, and every rendered frame also forces every glass surface
  // on the page to re-run its backdrop-filter. The gate sits ~7% under the
  // cap (1/32 for 30) so a whole number of 60Hz frames always clears it.
  let fps = cfg.fps;
  const gate = () => 1 / (fps * 1.07);
  let minFrame = gate();
  let winSum = 0;
  let winCount = 0;
  let badWindows = 0;
  function throttle(dt: number) {
    if (!govern || notch >= 2) return;
    winSum += dt;
    if (++winCount < 60) return;
    const avg = winSum / winCount;
    winSum = winCount = 0;
    if (avg <= 0.024) {
      badWindows = 0;
      return;
    }
    if (++badWindows < 2) return;
    badWindows = 0;
    if (++notch === 1) applyScale();
    else minFrame = Math.max(minFrame, 1 / 15);
  }

  // ------------------------------------------------------------ the loop
  let speed = cfg.speed;
  let t = reduced ? 12 : 0; // still frame: far enough in to have shapes
  let raf = 0;
  let timer = 0;
  let lastT = 0;
  let acc = 0;
  let visible = document.visibilityState === 'visible';

  function render() {
    uniforms.uTime.value = t;
    renderer.render(scene, camera);
  }

  // At 24fps and under the loop sleeps on a timer and asks for ONE animation
  // frame per render: a frame requested every vsync keeps the page's display
  // link running, which cost more than the renders (WebKit, % of a core:
  // 15fps 11.5 → 5.7, 24fps 12 → 9). At 30 the link never idles: no gain.
  const paced = () => minFrame > 0.035;
  function next() {
    if (!paced()) raf = requestAnimationFrame(frame);
    else timer = window.setTimeout(() => {
      timer = 0;
      raf = requestAnimationFrame(frame);
    }, minFrame * 1000); // the vsync after the cap renders
  }

  function frame(now: number) {
    raf = 0;
    const pace = paced();
    const dt = lastT ? Math.min((now - lastT) / 1000, pace ? 0.25 : 0.05) : 1 / 60;
    lastT = now;
    acc += dt;
    if (!pace) throttle(dt); // raw frame time — the skipped frames are the cheap ones
    if (acc < minFrame) {
      raf = requestAnimationFrame(frame);
      return;
    }
    // A paced frame is one render: it reports how far past the cap it landed,
    // in 60Hz frame terms, so the governor keeps its threshold.
    if (pace) throttle(acc / (minFrame * 60));
    const step = acc; // the whole skipped stretch, or the clock runs slow
    acc = 0;
    t += step * speed;
    mouse.lerp(target, 1 - Math.exp(-3 * step));
    uniforms.uMouse.value.copy(mouse).multiplyScalar(parallax);
    render();
    next();
  }

  function pause() {
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = timer = 0;
  }
  function resume() {
    if (!raf && !timer && visible && !reduced) {
      lastT = 0; // clock reset — no dt spike after a hidden stretch
      raf = requestAnimationFrame(frame);
    }
  }

  const onVisibility = () => {
    visible = document.visibilityState === 'visible';
    visible ? resume() : pause();
  };
  const onResize = () => {
    uniforms.uRes.value.set(boxW(), boxH());
    renderer.setSize(boxW(), boxH(), false);
    if (reduced) render();
  };
  document.addEventListener('visibilitychange', onVisibility);
  // Watches the canvas box, so a header that changes height re-sizes too.
  const ro = new ResizeObserver(onResize);
  ro.observe(canvas);

  if (reduced) render();
  else resume();
  canvas.classList.add('live');

  return {
    update(next: SceneConfig) {
      uniforms.uC1.value.set(next.colors[0]);
      uniforms.uC2.value.set(next.colors[1]);
      uniforms.uC3.value.set(next.colors[2]);
      uniforms.uGlow.value = next.glow;
      uniforms.uScale.value = next.scale;
      uniforms.uWarp.value = next.warp;
      uniforms.uOpacity.value = next.opacity;
      uniforms.uScene.value = SCENE_INDEX[next.scene] ?? 0;
      uniforms.uDetail.value = next.detail;
      if (next.res !== res || next.hidpi !== hidpi) {
        res = next.res;
        hidpi = next.hidpi;
        applyScale();
      }
      govern = next.govern;
      if (next.fps !== fps) {
        fps = next.fps;
        if (notch < 2) minFrame = gate(); // the 15fps notch stays a floor
      }
      speed = next.speed;
      parallax = next.parallax;
      uniforms.uMouse.value.copy(mouse).multiplyScalar(parallax);
      if (reduced || (!raf && !timer)) render(); // frozen scenes still show the new knobs
    },
    destroy() {
      pause();
      document.removeEventListener('visibilitychange', onVisibility);
      ro.disconnect();
      removeEventListener('pointermove', onPointer);
      quad.geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
