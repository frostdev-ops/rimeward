// The valley — the same terraced terrain as the splash, seen from down inside
// it. The splash gate dives into a valley; this is where every form lands.
// Shares the splash shaders and palette; only camera, amplitude and mood
// differ. `depth` walks the camera further down as a flow progresses.
import * as THREE from 'three';
import { terrainVert, terrainFrag } from '../splash/shaders.ts';
import { PALETTE, FOG_COLOR, LEVELS } from '../splash/scene.ts';

export interface ValleyOptions {
  /** Render exactly one frame (reduced motion, or ?still for screenshots). */
  still?: boolean;
  /** 0 = the arrival look (login), 1 = the floor of the valley. */
  depth?: number;
}

export interface ValleyHandle {
  /** Retarget the descent; the camera eases there over ~a second. */
  setDepth(d: number): void;
  /** 1 normally, ~3 while a submit button is hovered/focused (morph speeds up). */
  setGust(n: number): void;
  /** Begin the 650ms dive (index.ts fires the flash + nav). */
  startGate(): void;
}

const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1);

export function createValleyScene(canvas: HTMLCanvasElement, opts: ValleyOptions = {}): ValleyHandle | null {
  if (!canvas) return null;
  const reduced = opts.still || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;
  const high = fine && (navigator.hardwareConcurrency || 0) >= 8;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: high,
      // Still frames must survive compositor presents for screenshots — which
      // is any frame we only draw once, reduced motion included.
      preserveDrawingBuffer: reduced,
    });
  } catch {
    return null; // no WebGL — the CSS ground stays
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, high ? 1.75 : 1.25));
  renderer.setSize(innerWidth, innerHeight, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);

  // Lower and mistier than the splash overview — descending toward the valley.
  // (A true ground-level camera shows the terrace cliffs edge-on, where the
  // quantized steps triangulate into ugly teeth; the plates need to be read
  // from above.) depth 0 is the arrival frame; depth 1 the floor.
  const camY = (d: number) => 5.4 + (3.4 - 5.4) * d;
  const camZ = (d: number) => 6.8 + (4.6 - 6.8) * d;

  const want = clamp01(opts.depth ?? 0);
  // Every arrival reads as a short descent: start a little above the target.
  let depth = reduced ? want : Math.max(0, want - 0.12);
  let depthTarget = want;

  camera.position.set(0, camY(depth), camZ(depth));

  const segs = high ? [420, 260] : [260, 160];
  const geo = new THREE.PlaneGeometry(60, 40, segs[0]!, segs[1]!);
  geo.rotateX(-Math.PI / 2);

  const uniforms = {
    uTime: { value: 0 },
    uFlow: { value: 1 },
    uDetail: { value: 1 },
    uLevels: { value: LEVELS },
    uAmp: { value: 1.5 },
    uPalette: { value: PALETTE.map((c) => new THREE.Color(c)) },
    uFog: { value: new THREE.Color(FOG_COLOR) },
    uCam: { value: camera.position },
    // Mist closes in nearer than on the splash overview, and nearer still the
    // deeper you go.
    uFogRange: { value: new THREE.Vector2(9, 26) },
  };
  const terrain = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({ vertexShader: terrainVert, fragmentShader: terrainFrag, uniforms, transparent: true })
  );
  terrain.position.set(0, 0, -6);
  scene.add(terrain);

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

  let gust = 1;
  let gustTarget = 1;
  let gateStart = 0;
  const gateFrom = new THREE.Vector3();

  let t = reduced ? 14 : 0;
  let raf = 0;
  let lastT = 0;
  let live = false;

  function step(dt: number, now: number) {
    depth += (depthTarget - depth) * (reduced ? 1 : 1 - Math.exp(-2.5 * dt));
    gust += (gustTarget - gust) * (reduced ? 1 : 1 - Math.exp(-3 * dt));

    uniforms.uTime.value = t;
    // Very slow: the valley walls quietly re-form while you type.
    uniforms.uFlow.value = (0.55 + 0.45 * depth) * gust;
    uniforms.uFogRange.value.set(9 + 4 * depth, 26 + 8 * depth);

    if (gateStart) {
      const g = Math.min((now - gateStart) / 650, 1);
      camera.position.lerpVectors(gateFrom, new THREE.Vector3(gateFrom.x * 0.3, 0.7, -2.2), g * g);
    } else {
      const target = new THREE.Vector3(
        Math.sin(t * 0.07) * 0.7 + mx * 0.5,
        camY(depth) + Math.sin(t * 0.16) * 0.15 + my * 0.25,
        camZ(depth)
      );
      camera.position.lerp(target, reduced ? 1 : 1 - Math.exp(-4 * dt));
    }
    camera.lookAt(0, 0.2, -7);
  }

  function render() {
    renderer.render(scene, camera);
    if (!live) {
      live = true;
      canvas.classList.add('live');
    }
  }

  function renderStill() {
    step(0, performance.now());
    render();
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = lastT ? Math.min((now - lastT) / 1000, 0.05) : 1 / 60;
    lastT = now;
    t += dt;
    step(dt, now);
    render();
  }

  function pause() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }
  function resume() {
    if (!raf && document.visibilityState === 'visible' && !reduced) {
      lastT = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
    if (reduced) renderStill();
  });

  // Back out of a dive (bfcache restores the page mid-gate): let go of the
  // camera, and the idle lerp eases it up out of the terrain.
  addEventListener('pageshow', (e) => {
    if (e.persisted) gateStart = 0;
  });

  if (reduced) {
    renderStill();
  } else {
    document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? resume() : pause()));
    resume();
  }

  return {
    setDepth(d: number) {
      depthTarget = clamp01(d);
      if (reduced) renderStill();
    },
    setGust(n: number) {
      gustTarget = n;
    },
    startGate() {
      if (reduced || gateStart) return;
      gateStart = performance.now();
      gateFrom.copy(camera.position);
      resume();
    },
  };
}
