// "Living Topography" — the brand's paper-cut contour art as a living
// landscape. One mesh, one shader pair; everything three lives here so the
// library loads lazily (dynamic import from index.ts) and only on this route.
import * as THREE from 'three';
import { terrainVert, terrainFrag } from './shaders.ts';

export interface SceneHandle {
  /** 1.0 normally, ~3.0 while the Enter CTA is hovered/focused (morph speeds up). */
  setGust(target: number): void;
  /** Begin the 650ms dive down into a valley (index.ts fires the flash + nav). */
  startGate(): void;
}

export interface SceneOptions {
  /** Render exactly one frame (reduced motion, or ?still for screenshots). */
  still?: boolean;
}

// Brand palette, deep pits → pale plateaus (from assets/frostbackground*.png).
// Exported for the /perf bench, which builds the same mesh under its own clock.
export const PALETTE = [0x0a1626, 0x123b66, 0x2e6db4, 0x1f8fc9, 0x5f93ab, 0x8fa6b5, 0xc4d4dc, 0xeaf6f9];
export const FOG_COLOR = 0x060d18;
export const LEVELS = 8;
export const AMP = 1.1;
/** Mesh density per tier: [high, low]. */
export const SEGMENTS: [[number, number], [number, number]] = [[420, 260], [260, 160]];

// High and fairly top-down: plates read as blobby paper cutouts, not a horizon.
export const CAM_BASE = new THREE.Vector3(0, 10.5, 5.0);

export function createScene(canvas: HTMLCanvasElement, opts: SceneOptions = {}): SceneHandle | null {
  const reduced = opts.still || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;
  const high = fine && (navigator.hardwareConcurrency || 0) >= 8;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      // No MSAA. Every edge you can see in this scene is drawn by the fragment
      // shader from vH (the contour bands, the plate drop shadows, the rims) —
      // multisampling does nothing for those. The only geometry edges are the
      // terrace cliffs, and each one already carries a dark shadow band, and
      // the plane's own border, which the alpha vignette fades to nothing.
      // 4x samples over a full-screen buffer at dpr 1.75 is the most expensive
      // thing here and it buys ~nothing.
      antialias: false,
      // Still frames must survive compositor presents for screenshots.
      preserveDrawingBuffer: !!opts.still,
    });
  } catch {
    return null; // no WebGL — the CSS ground layer stays the experience
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, high ? 1.75 : 1.25));
  renderer.setSize(innerWidth, innerHeight, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.1, 100);
  camera.position.copy(CAM_BASE);

  // ------------------------------------------------------------- terrain
  // Dense grid: displacement is quantized into terraces per-vertex while the
  // fragment shader draws pixel-crisp contour bands from the raw height.
  const segs = SEGMENTS[high ? 0 : 1];
  const geo = new THREE.PlaneGeometry(60, 40, segs[0]!, segs[1]!);
  geo.rotateX(-Math.PI / 2);

  const uniforms = {
    uTime: { value: 0 },
    uFlow: { value: 1 },
    uDetail: { value: 1 },
    uLevels: { value: LEVELS },
    uAmp: { value: AMP },
    uPalette: { value: PALETTE.map((c) => new THREE.Color(c)) },
    uFog: { value: new THREE.Color(FOG_COLOR) },
    uCam: { value: camera.position },
    uFogRange: { value: new THREE.Vector2(15, 34) },
  };
  const terrain = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      vertexShader: terrainVert,
      fragmentShader: terrainFrag,
      uniforms,
      transparent: true,
    })
  );
  terrain.position.set(0, 0, -3);
  scene.add(terrain);

  // -------------------------------------------------- perf governor state
  let notch = 0; // 1: dpr→1, 2: domain warp off. Never steps back up.
  let winSum = 0;
  let winCount = 0;
  let badWindows = 0;
  function govern(dt: number) {
    if (notch >= 2) return;
    winSum += dt;
    if (++winCount < 60) return;
    const avg = winSum / winCount;
    winSum = winCount = 0;
    if (avg <= 0.022) {
      badWindows = 0;
      return;
    }
    if (++badWindows < 2) return;
    badWindows = 0;
    notch++;
    if (notch === 1) {
      renderer.setPixelRatio(1);
      renderer.setSize(innerWidth, innerHeight, false);
    } else {
      uniforms.uDetail.value = 0;
    }
  }

  // ------------------------------------------------------------ parallax
  let mx = 0;
  let my = 0;
  if (fine && !reduced) {
    addEventListener(
      'pointermove',
      (e) => {
        mx = (e.clientX / innerWidth) * 2 - 1;
        my = -((e.clientY / innerHeight) * 2 - 1);
      },
      { passive: true }
    );
  }

  // ------------------------------------------------------- flow and gate
  let flow = 1;
  let flowTarget = 1;
  let gateStart = 0;
  const gateFrom = new THREE.Vector3();

  // ------------------------------------------------------------ the loop
  let t = reduced ? 24 : 0; // still frame: far enough in for interesting shapes
  let raf = 0;
  let lastT = 0;
  let live = false;
  let visible = document.visibilityState === 'visible';
  let intersecting = true;

  function step(dt: number, now: number) {
    const p = Math.min(Math.max(scrollY / (innerHeight * 1.2), 0), 1);
    canvas.style.setProperty('--splash-opacity', (1 - 0.6 * Math.min(scrollY / innerHeight, 1)).toFixed(3));

    flow += (flowTarget - flow) * (1 - Math.exp(-3 * dt));
    uniforms.uTime.value = t;
    uniforms.uFlow.value = flow;

    // Slow autonomous sway + mouse parallax + scroll descent. The landscape
    // itself morphs via the shader; the camera just breathes over it.
    const sway = reduced ? 0 : Math.sin(t * 0.1) * 0.5;
    const target = new THREE.Vector3(
      sway + mx * 0.9,
      CAM_BASE.y - p * 2.2 + my * 0.4,
      CAM_BASE.z - p * 2.0
    );
    if (gateStart) {
      const g = Math.min((now - gateStart) / 650, 1);
      const ease = g * g; // easeInQuad — accelerating plunge
      camera.position.lerpVectors(gateFrom, new THREE.Vector3(gateFrom.x * 0.3, 0.9, -1.5), ease);
    } else {
      const k = 1 - Math.exp(-4 * dt);
      camera.position.lerp(target, reduced ? 1 : k);
    }
    camera.lookAt(0, 0, -3.5);
  }

  function render() {
    renderer.render(scene, camera);
    if (!live) {
      live = true;
      canvas.classList.add('live');
    }
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = lastT ? Math.min((now - lastT) / 1000, 0.05) : 1 / 60;
    lastT = now;
    t += dt;
    step(dt, now);
    render();
    govern(dt);
  }

  function pause() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }
  function resume() {
    if (!raf && visible && intersecting && !reduced) {
      lastT = 0; // clock reset — no dt spike after a hidden stretch
      raf = requestAnimationFrame(frame);
    }
  }

  function renderStill() {
    step(0, performance.now());
    render();
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
    if (reduced) renderStill();
  });

  // Same as the valley: bfcache restores the page mid-dive, so let go of the
  // camera and the idle lerp eases it back up.
  addEventListener('pageshow', (e) => {
    if (e.persisted) gateStart = 0;
  });

  if (reduced) {
    renderStill();
  } else {
    document.addEventListener('visibilitychange', () => {
      visible = document.visibilityState === 'visible';
      visible ? resume() : pause();
    });
    new IntersectionObserver((entries) => {
      intersecting = entries[entries.length - 1]?.isIntersecting ?? true;
      intersecting ? resume() : pause();
    }).observe(canvas);
    resume();
  }

  return {
    setGust(target: number) {
      flowTarget = target;
    },
    startGate() {
      if (reduced || gateStart) return;
      gateStart = performance.now();
      gateFrom.copy(camera.position);
      resume();
    },
  };
}
