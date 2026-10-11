// The /perf bench (dev-only page). Three numbers, all from the real shaders and
// the real DOM, so a change to bg-shaders.ts, valley/shaders.ts or frost.css
// can be measured instead of guessed at:
//
//  1. Scene shaders — ms/frame per preset on one full-screen quad, exactly as
//     bg-scene.ts draws it, at a chosen buffer size. "Per preset" compiles
//     one program per scene (the shader's SCENE_ID hook) instead of the one
//     all-presets program production uses — the A/B for that idea.
//  2. Native terrain — ms/frame for the topography mesh per tier, with and
//     without MSAA.
//  3. Page audit — loads a route in an iframe and counts what the compositor
//     has to pay for: backdrop-filters, filters, running animations, canvases,
//     and the frame rate it actually holds.
//
// Timing is GPU time from EXT_disjoint_timer_query_webgl2 where the browser
// exposes it (Chrome on Apple silicon does), else wall time across the batch
// with the GPU drained by a readPixels — for a GPU-bound draw that is the GPU
// time. Either way: the minimum over three batches, which is the estimator
// that does not move between runs.
import { GFX_DEFAULTS, SCENE_IDS, SCENE_INDEX, SCENES } from '../lib/theme.ts';
import type { SceneConfig } from '../lib/theme.ts';
import { bgVert, bgFrag } from './app/bg-shaders.ts';
import { terrainVert, terrainFrag } from './valley/shaders.ts';

const FRAMES = 40;
const BATCHES = 3;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function bufferSize(): [number, number] {
  const v = $<HTMLSelectElement>('perf-res').value;
  if (v === 'view') return [Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio)];
  if (v === 'view1') return [innerWidth, innerHeight];
  const [w, h] = v.split('x').map(Number);
  return [w!, h!];
}

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}
/** How the current context is being timed — set by bench(), shown in the table note. */
let timing = 'wall';

/** ms per draw: one warm-up (compile + first use) outside the clock, then
 *  BATCHES × FRAMES draws, the best batch reported. */
async function bench(gl: WebGL2RenderingContext, draw: (i: number) => void): Promise<number> {
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  timing = ext ? 'GPU timer' : 'wall';
  draw(0);
  sync();
  let best = Infinity;
  for (let b = 0; b < BATCHES; b++) {
    // One query around the whole batch. Per-draw queries looked right but on
    // ANGLE/Metal each one is a command-buffer boundary, which inflated the
    // numbers 10× and made them swing 2× between runs.
    const q = ext ? gl.createQuery() : null;
    if (q) gl.beginQuery(ext!.TIME_ELAPSED_EXT, q);
    const t0 = performance.now();
    for (let i = 1; i <= FRAMES; i++) draw(i);
    if (q) gl.endQuery(ext!.TIME_ELAPSED_EXT);
    sync();
    let ms = (performance.now() - t0) / FRAMES;
    if (q) {
      while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) await sleep(1);
      const disjoint = gl.getParameter(ext!.GPU_DISJOINT_EXT) as boolean;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      gl.deleteQuery(q);
      if (disjoint) continue;
      ms = ns / 1e6 / FRAMES;
    }
    best = Math.min(best, ms);
  }
  return best;
}

interface Row {
  label: string;
  ms: number;
}

/** Rows sorted by cost with a bar scaled to the worst — the shape of the table
 *  is the finding; the numbers are for before/after. */
function table(el: HTMLElement, rows: Row[], note: string): void {
  const max = Math.max(...rows.map((r) => r.ms), 0.001);
  const min = Math.min(...rows.map((r) => r.ms));
  const sorted = [...rows].sort((a, b) => b.ms - a.ms);
  el.innerHTML =
    `<p class="text-xs text-ink-faint mb-2">${note}</p>` +
    sorted
      .map(
        (r) =>
          `<div class="perf-row"><span class="perf-label">${r.label}</span>` +
          `<span class="perf-ms tabular-nums">${r.ms.toFixed(2)} ms</span>` +
          `<span class="perf-x tabular-nums text-ink-faint">×${(r.ms / min).toFixed(1)}</span>` +
          `<span class="perf-bar"><i style="width:${((r.ms / max) * 100).toFixed(1)}%"></i></span></div>`
      )
      .join('');
}

// ------------------------------------------------------------- scene shaders

/** One bench job: a SceneConfig (the catalog default, or one of the user's
 *  own) at a buffer size. */
interface Job {
  label: string;
  cfg: Pick<SceneConfig, 'scene' | 'colors' | 'glow' | 'scale' | 'warp' | 'opacity'>;
  size: [number, number];
}

/** The user's saved background + header banner, stamped by perf.astro. */
function mine(): Job[] {
  const raw = $('perf-scenes').dataset.mine;
  if (!raw) return [];
  const m = JSON.parse(raw) as { bg: SceneConfig | null; hdr: SceneConfig | null; hdrHeight: number };
  const jobs: Job[] = [];
  const dpr = $<HTMLSelectElement>('perf-res').value === 'view' ? devicePixelRatio : 1;
  if (m.bg) jobs.push({ label: `yours · background · ${SCENES[m.bg.scene].label}`, cfg: m.bg, size: bufferSize() });
  if (m.hdr) {
    // bg-scene.ts sizes the banner to the header box, so that is its buffer.
    const size: [number, number] = [Math.round(innerWidth * dpr), Math.round(m.hdrHeight * dpr)];
    jobs.push({ label: `yours · header · ${SCENES[m.hdr.scene].label}`, cfg: m.hdr, size });
  }
  return jobs;
}

/** The buffer bg-scene.ts would actually allocate: the box × the preset's
 *  render scale. The label carries it so a 0.5 preset's row reads as such. */
function effective(job: Job): Job {
  const r = SCENES[job.cfg.scene].res;
  const size: [number, number] = [Math.round(job.size[0] * r), Math.round(job.size[1] * r)];
  return { ...job, size, label: `${job.label} · ${size[0]}×${size[1]}` };
}

async function runScenes(): Promise<void> {
  const THREE = await import('three');
  const out = $('perf-scenes');
  const perPreset = $<HTMLInputElement>('perf-per-preset').checked;
  const [w, h] = bufferSize();
  const jobs: Job[] = [...mine(), ...SCENE_IDS.map((id) => ({ label: SCENES[id].label, cfg: { ...SCENES[id], scene: id }, size: [w, h] as [number, number] }))].map(effective);

  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, depth: false, stencil: false });
  renderer.setPixelRatio(1);
  const gl = renderer.getContext() as WebGL2RenderingContext;

  const uniforms = {
    uRes: { value: new THREE.Vector2(w, h) },
    uTime: { value: 0 },
    uC1: { value: new THREE.Color() },
    uC2: { value: new THREE.Color() },
    uC3: { value: new THREE.Color() },
    uGlow: { value: 1 },
    uScale: { value: 1 },
    uWarp: { value: 1 },
    uOpacity: { value: 1 },
    uMouse: { value: new THREE.Vector2(0, 0) },
    uScene: { value: 0 },
    uDetail: { value: GFX_DEFAULTS.detail },
  };
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const geo = new THREE.PlaneGeometry(2, 2);
  const rows: Row[] = [];
  for (const job of jobs) {
    const { cfg, size } = job;
    renderer.setSize(size[0], size[1], false);
    uniforms.uRes.value.set(size[0], size[1]);
    uniforms.uC1.value.set(cfg.colors[0]);
    uniforms.uC2.value.set(cfg.colors[1]);
    uniforms.uC3.value.set(cfg.colors[2]);
    uniforms.uGlow.value = cfg.glow;
    uniforms.uScale.value = cfg.scale;
    uniforms.uWarp.value = cfg.warp;
    uniforms.uOpacity.value = cfg.opacity;
    uniforms.uScene.value = SCENE_INDEX[cfg.scene];
    const material = new THREE.ShaderMaterial({
      vertexShader: bgVert,
      fragmentShader: bgFrag,
      uniforms,
      transparent: true,
      defines: perPreset ? { SCENE_ID: String(SCENE_INDEX[cfg.scene]) } : {},
    });
    const quad = new THREE.Mesh(geo, material);
    quad.frustumCulled = false;
    scene.add(quad);
    rows.push({
      label: job.label,
      ms: await bench(gl, (i) => {
        uniforms.uTime.value = 9 + i / 30;
        renderer.render(scene, camera);
      }),
    });
    scene.remove(quad);
    material.dispose();
    table(out, rows, `box ${w}×${h}, each row at its preset's render scale · ${timing} · ${perPreset ? 'one program per preset' : 'single program (production)'} · ${rows.length}/${jobs.length}`);
    await sleep(0); // let the table paint (a timeout, not rAF — rAF stalls in a background tab)
  }
  geo.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
}

// ------------------------------------------------------------ native terrain

async function runTerrain(): Promise<void> {
  const THREE = await import('three');
  const { PALETTE, FOG_COLOR, LEVELS, AMP, SEGMENTS, CAM_BASE } = await import('./valley/terrain.ts');
  const out = $('perf-terrain');
  const [w, h] = bufferSize();
  const rows: Row[] = [];
  const configs: [string, [number, number], boolean][] = [
    ['high tier', SEGMENTS[0], false],
    ['high tier + MSAA', SEGMENTS[0], true],
    ['low tier', SEGMENTS[1], false],
  ];
  for (const [label, segs, antialias] of configs) {
    const canvas = document.createElement('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias });
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, w / h, 0.1, 100);
    camera.position.copy(CAM_BASE);
    camera.lookAt(0, 0, -3.5);
    const geo = new THREE.PlaneGeometry(60, 40, segs[0], segs[1]);
    geo.rotateX(-Math.PI / 2);
    const uniforms = {
      uTime: { value: 24 },
      uFlow: { value: 1 },
      uDetail: { value: 1 },
      uLevels: { value: LEVELS },
      uAmp: { value: AMP },
      uPalette: { value: PALETTE.map((c) => new THREE.Color(c)) },
      uFog: { value: new THREE.Color(FOG_COLOR) },
      uCam: { value: camera.position },
      uFogRange: { value: new THREE.Vector2(15, 34) },
    };
    const material = new THREE.ShaderMaterial({ vertexShader: terrainVert, fragmentShader: terrainFrag, uniforms, transparent: true });
    const terrain = new THREE.Mesh(geo, material);
    terrain.position.set(0, 0, -3);
    scene.add(terrain);
    rows.push({
      label: `${label} ${segs[0]}×${segs[1]}`,
      ms: await bench(gl, (i) => {
        uniforms.uTime.value = 24 + i / 60;
        renderer.render(scene, camera);
      }),
    });
    geo.dispose();
    material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    table(out, rows, `${w}×${h} · ${timing} · ${rows.length}/${configs.length}`);
    await sleep(0); // let the table paint (a timeout, not rAF — rAF stalls in a background tab)
  }
}

// ---------------------------------------------------------------- page audit

function tag(el: Element): string {
  const cls = [...el.classList].find((c) => !/^(flex|grid|min-|max-|p-|m-|text-|w-|h-|gap-|items-|justify-)/.test(c));
  return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (cls ? `.${cls}` : '');
}

async function audit(): Promise<void> {
  const out = $('perf-audit-out');
  const frame = $<HTMLIFrameElement>('perf-frame');
  out.textContent = 'loading…';
  frame.hidden = false;
  frame.src = $<HTMLInputElement>('perf-url').value;
  await new Promise<void>((r) => (frame.onload = () => r()));
  await sleep(2000); // wards land, entrance cascade finishes
  const win = frame.contentWindow!;
  const doc = frame.contentDocument!;
  const all = [...doc.querySelectorAll('*')];

  // Pseudo-elements too: the valley's blurred blobs are ::before/::after, and
  // querySelectorAll cannot see them.
  const tally = (pick: (cs: CSSStyleDeclaration) => string) => {
    const m = new Map<string, number>();
    for (const el of all) {
      for (const pseudo of [undefined, '::before', '::after']) {
        const cs = win.getComputedStyle(el, pseudo);
        if (pseudo && cs.content === 'none') continue;
        const v = pick(cs);
        if (!v || v === 'none') continue;
        const k = `${tag(el)}${pseudo ?? ''}  ${v}`;
        m.set(k, (m.get(k) ?? 0) + 1);
      }
    }
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const list = (title: string, rows: [string, number][]) =>
    `${title}: ${rows.reduce((n, r) => n + r[1], 0)}\n` + rows.map(([k, n]) => `  ${String(n).padStart(3)}  ${k}`).join('\n');

  const anims = doc.getAnimations().filter((a) => a.playState === 'running');
  const forever = anims.filter((a) => a.effect?.getTiming().iterations === Infinity);
  const animRows = new Map<string, number>();
  for (const a of forever) {
    // Duck-typed: these objects belong to the iframe's realm, so instanceof
    // against this window's KeyframeEffect / CSSAnimation is always false.
    const fx = a.effect as KeyframeEffect | null;
    const t = fx?.target ? tag(fx.target) + (fx.pseudoElement ?? '') : '?';
    const name = (a as CSSAnimation).animationName ?? a.id ?? 'waapi';
    animRows.set(`${t}  ${name}`, (animRows.get(`${t}  ${name}`) ?? 0) + 1);
  }
  const canvases = [...doc.querySelectorAll('canvas')].map((c) => `  ${tag(c)}  ${c.width}×${c.height}`);

  // Frame rate the page holds on its own for two seconds.
  let frames = 0;
  let long = 0;
  let last = 0;
  const t0 = performance.now();
  await new Promise<void>((done) => {
    const tick = (now: number) => {
      frames++;
      if (last && now - last > 25) long++;
      last = now;
      now - t0 < 2000 ? win.requestAnimationFrame(tick) : done();
    };
    win.requestAnimationFrame(tick);
  });
  const secs = (performance.now() - t0) / 1000;

  out.textContent = [
    `${frame.src}  ·  ${all.length} elements  ·  dpr ${devicePixelRatio}`,
    '',
    list('backdrop-filter surfaces', tally((cs) => cs.backdropFilter)),
    '',
    list('filter layers', tally((cs) => cs.filter)),
    '',
    `running animations: ${anims.length} (${forever.length} infinite)\n` + [...animRows].map(([k, n]) => `  ${String(n).padStart(3)}  ${k}`).join('\n'),
    '',
    `canvases: ${canvases.length}\n${canvases.join('\n')}`,
    '',
    `rAF: ${(frames / secs).toFixed(1)} fps over ${secs.toFixed(1)}s, ${long} frames over 25ms`,
  ].join('\n');
}

// ------------------------------------------------------------------- wiring

const busy = async (btn: HTMLButtonElement, fn: () => Promise<void>) => {
  btn.dataset.busy = '';
  $('perf-err').textContent = '';
  try {
    await fn();
  } catch (e) {
    $('perf-err').textContent = String(e);
  } finally {
    delete btn.dataset.busy;
  }
};
$<HTMLButtonElement>('perf-run-scenes').addEventListener('click', (e) => busy(e.currentTarget as HTMLButtonElement, runScenes));
$<HTMLButtonElement>('perf-run-terrain').addEventListener('click', (e) => busy(e.currentTarget as HTMLButtonElement, runTerrain));
$<HTMLButtonElement>('perf-audit').addEventListener('click', (e) => busy(e.currentTarget as HTMLButtonElement, audit));
