// GLSL for native valley terrain. Plain template strings — no imports, no deps.
//
// The scene is one mesh: a plane displaced into quantized terraces by fbm
// noise — the same construction as the brand's paper-cut topography art,
// animated by slowly warping the noise domain. Color bands, plate-edge drop
// shadows, and rim highlights are computed per-pixel from the un-quantized
// height, so contours stay crisp regardless of mesh density.

export const terrainVert = /* glsl */ `
uniform float uTime;
uniform float uFlow;    // morph speed multiplier (CTA hover boosts it)
uniform float uDetail;  // 1 = full domain warp, 0 = governor-reduced
uniform float uLevels;
uniform float uAmp;

varying float vH;
varying vec3 vWorld;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
float fbm(vec2 p) {
  // 4 octaves with steep falloff: the reference plates have smooth, rounded
  // edges — high-frequency detail makes them ragged.
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.02 + vec2(11.3, 7.9);
    a *= 0.45;
  }
  return v;
}
// Two octaves, warp only: the warp is scaled by 0.5 before it is fed back into
// fbm, so its high octaves never survive into the height. This runs once per
// vertex on a six-figure grid, so the four fetches it drops are the single
// biggest cost in this shader.
float fbm2(vec2 p) {
  return 0.55 * noise(p) + 0.2475 * noise(p * 2.02 + vec2(11.3, 7.9));
}

void main() {
  vec3 pos = position;
  vec2 p = pos.xz * 0.13;
  float t = uTime * 0.018 * uFlow;

  // Domain warp gives the blobby, organic plate shapes of the reference art;
  // scrolling the domain makes the whole landscape slowly become a new one.
  vec2 warp = uDetail * 0.5 * vec2(fbm2(p * 1.6 + t), fbm2(p * 1.6 - t * 1.3 + 7.3));
  float h = fbm(p + warp + vec2(t * 0.6, -t * 0.25));
  // Linear stretch keeps every band represented (fbm rarely leaves 0.15–0.85).
  h = clamp((h - 0.18) / 0.64, 0.0, 1.0);

  vH = h;
  pos.y = (floor(h * uLevels) / uLevels) * uAmp;

  vWorld = (modelMatrix * vec4(pos, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

export const terrainFrag = /* glsl */ `
precision highp float;
uniform vec3 uPalette[8];
uniform float uLevels;
uniform vec3 uFog;
uniform vec3 uCam;
uniform vec2 uFogRange; // near, far — splash sees far; the login valley is misty

varying float vH;
varying vec3 vWorld;

void main() {
  float scaled = clamp(vH * uLevels, 0.0, uLevels - 0.001);
  vec3 col = uPalette[int(scaled)];
  float f = fract(scaled);

  // Paper-cut depth: the next-higher plate casts a soft shadow onto this one
  // just outside its boundary…
  col *= 1.0 - 0.30 * smoothstep(0.80, 0.995, f);
  // …and each plate carries a faint bright rim along its own cut edge.
  col += vec3(0.05) * smoothstep(0.07, 0.0, f);

  // Distance fade into the page background so the mesh has no horizon line.
  float fogF = smoothstep(uFogRange.x, uFogRange.y, distance(vWorld, uCam));
  col = mix(col, uFog, fogF);

  // Soft alpha vignette at the plane borders — blends into the CSS ground.
  float edge = smoothstep(28.0, 21.0, abs(vWorld.x)) * smoothstep(20.0, 14.0, abs(vWorld.z + 3.0));
  gl_FragColor = vec4(col, edge * (1.0 - fogF * 0.9));
}
`;
