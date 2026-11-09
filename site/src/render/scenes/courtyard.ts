/**
 * The lighting lessons' shared scene: a long courtyard (a floor 16 m wide and 40 m deep, two rows
 * of pillars, the pipeline lesson's box in front and a few crates), one camera looking down it,
 * and the lights. No DOM and no GPU: the claims run everything here in Node.
 *
 * Besides the meshes the GPU draws, the scene is kept as solids (a floor rectangle and turned
 * boxes) so the CPU models can cast rays against it exactly: which surface a pixel sees, at what
 * depth, with what normal, and whether the sun reaches it. Only sqrt and the four arithmetic
 * operations go into the geometry, so Node and every browser get the same numbers.
 *
 *   courtyardDraws()        the meshes and their (linear) albedo, for the GPU renderers
 *   COURTYARD_CAMERA        the camera, as the rasteriser's Camera (viewProj() turns it into a matrix)
 *   courtyardLights(n)      POINT_LIGHTS first, then seeded point lights along the courtyard
 *   cast(o, d)              the nearest hit of a ray, with its normal and solid
 *   pixelRay(x, y, w, h)    the camera ray through a pixel's centre
 */
import { type Camera, type Mesh, type V3, basis, dot3, sub3, v3 } from '../raster';
import { type GpuMesh, type PointLight, POINT_LIGHTS, gpuMesh, viewProj } from '../gpu/scene';
import { box, floor } from './common';

export type RGB = [number, number, number];

/** A box turned about the vertical axis by (c, s) = (cos, sin), as common.ts's box() builds it. */
export interface Solid {
  name: string;
  centre: V3;
  size: V3;
  c: number;
  s: number;
  /** Which draw it belongs to. */
  draw: number;
}

export const FLOOR = { x0: -8, x1: 8, z0: 6, z1: -34, tile: 2 };

function solids(): Solid[] {
  const out: Solid[] = [];
  // Two rows of pillars, 5 m apart.
  for (let i = 0; i < 7; i++)
    for (const x of [-4.5, 4.5]) out.push({ name: `pillar ${x < 0 ? 'L' : 'R'}${i + 1}`, centre: v3(x, 1.5, -5 * i), size: v3(0.8, 3, 0.8), c: 1, s: 0, draw: 1 });
  // The pipeline lesson's box, turned by a 3-4-5 angle, and crates turned by others.
  out.push({ name: 'box', centre: v3(0, 0.7, 0), size: v3(1.4, 1.4, 1.4), c: 0.8, s: 0.6, draw: 2 });
  out.push({ name: 'crate 1', centre: v3(2, 0.4, -6), size: v3(0.8, 0.8, 0.8), c: 0.6, s: 0.8, draw: 2 });
  out.push({ name: 'crate 2', centre: v3(-1.5, 0.5, -12), size: v3(1, 1, 1), c: 12 / 13, s: 5 / 13, draw: 2 });
  out.push({ name: 'crate 3', centre: v3(1, 0.3, -18), size: v3(0.6, 0.6, 0.6), c: 1, s: 0, draw: 2 });
  out.push({ name: 'wall', centre: v3(0, 2, -34.5), size: v3(16, 4, 1), c: 1, s: 0, draw: 1 });
  return out;
}
export const SOLIDS: Solid[] = solids();

/** One mesh from several. */
function merge(ms: Mesh[]): Mesh {
  const m: Mesh = { positions: [], attrs: [], indices: [] };
  for (const x of ms) {
    const b = m.positions.length;
    m.positions.push(...x.positions);
    m.attrs.push(...x.attrs);
    m.indices.push(...x.indices.map((i) => i + b));
  }
  return m;
}

export interface CourtyardDraw {
  name: string;
  mesh: GpuMesh;
  /** Linear albedo; the floor's is the lighter of its two checker squares. */
  albedo: RGB;
  /** The floor: a checkerboard from its texture coordinates (the darker squares are 0.55 ×). */
  checker: boolean;
}

/** Three draws: the floor, the pillars and back wall, and the props. */
export function courtyardDraws(): CourtyardDraw[] {
  const boxesOf = (d: number) => merge(SOLIDS.filter((s) => s.draw === d).map((s) => box(s.centre, s.size, s.c, s.s)));
  return [
    { name: 'floor', mesh: gpuMesh('floor', floor(FLOOR.x0, FLOOR.x1, FLOOR.z0, FLOOR.z1, 0, FLOOR.tile)), albedo: [0.5, 0.5, 0.5], checker: true },
    { name: 'pillars', mesh: gpuMesh('pillars', boxesOf(1)), albedo: [0.6, 0.55, 0.5], checker: false },
    { name: 'props', mesh: gpuMesh('props', boxesOf(2)), albedo: [0.45, 0.5, 0.6], checker: false },
  ];
}
export const ALBEDO: RGB[] = courtyardDraws().map((d) => d.albedo);
/** The floor checker's darker squares, as a factor on its albedo (same as the concept lessons' checker). */
export const CHECKER_DARK = 0.55;

/** The canvas the lighting lessons draw: 640 × 400 logical pixels. */
export const VIEW_W = 640;
export const VIEW_H = 400;
export const COURTYARD_CAMERA: Camera = { eye: v3(0, 2.6, 6.5), target: v3(0, 0.9, -4), focal: 1.5, aspect: VIEW_W / VIEW_H, near: 0.1, far: 60, reverseZ: false };
export const courtyardViewProj = () => viewProj(COURTYARD_CAMERA);

// ---------------------------------------------------------------------------------------------
// Lights

/** A small deterministic generator (an LCG), so every run places the same lights. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const LIGHT_TOKENS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--accent'];
export const MAX_LIGHTS = 256;

/** n point lights: the three POINT_LIGHTS, then lights scattered along the courtyard. */
export function courtyardLights(n: number): PointLight[] {
  const r = rng(7);
  const out: PointLight[] = POINT_LIGHTS.map((l) => ({ ...l }));
  while (out.length < MAX_LIGHTS) {
    const i = out.length;
    out.push({
      name: `light ${i + 1}`,
      pos: v3(-7 + 14 * r(), 0.3 + 1.7 * r(), 5 - 38 * r()),
      color: LIGHT_TOKENS[i % LIGHT_TOKENS.length],
      radius: 1.5 + 2 * r(),
      intensity: 1,
    });
  }
  return out.slice(0, n);
}

/**
 * Karis's windowed inverse-square falloff (Real Shading in Unreal Engine 4, 2013): reaches 0 at
 * the light's radius, so a light can be culled exactly. Distances in metres; 1 m² keeps it finite at 0.
 */
export function falloff(d: number, radius: number): number {
  const x = d / radius;
  const w = Math.max(0, Math.min(1, 1 - x * x * x * x));
  return (w * w) / (d * d + 1);
}

// ---------------------------------------------------------------------------------------------
// Rays

export interface Hit {
  t: number;
  /** World position. */
  p: V3;
  /** Unit normal facing the ray. */
  n: V3;
  /** Index into SOLIDS, or -1 for the floor. */
  solid: number;
  draw: number;
}

function hitBox(s: Solid, o: V3, d: V3, tMax: number): { t: number; n: V3 } | null {
  // Into the box's own frame: the inverse of common.ts's turn.
  const ox = o.x - s.centre.x;
  const oy = o.y - s.centre.y;
  const oz = o.z - s.centre.z;
  const lo = [ox * s.c - oz * s.s, oy, ox * s.s + oz * s.c];
  const ld = [d.x * s.c - d.z * s.s, d.y, d.x * s.s + d.z * s.c];
  const half = [s.size.x / 2, s.size.y / 2, s.size.z / 2];
  let t0 = 0;
  let t1 = tMax;
  let axis = -1;
  let sign = 0;
  for (let a = 0; a < 3; a++) {
    if (ld[a] === 0) {
      if (Math.abs(lo[a]) > half[a]) return null;
      continue;
    }
    let ta = (-half[a] - lo[a]) / ld[a];
    let tb = (half[a] - lo[a]) / ld[a];
    let sg = -1;
    if (ta > tb) {
      [ta, tb] = [tb, ta];
      sg = 1;
    }
    if (ta > t0) {
      t0 = ta;
      axis = a;
      sign = sg;
    }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  if (axis < 0) return null; // the ray starts inside
  const ln = [0, 0, 0];
  ln[axis] = sign;
  // Back to world: x = lx·c + lz·s, z = −lx·s + lz·c.
  return { t: t0, n: v3(ln[0] * s.c + ln[2] * s.s, ln[1], -ln[0] * s.s + ln[2] * s.c) };
}

/** The nearest surface along o + t·d (d need not be unit length), for t in (tMin, tMax). */
export function cast(o: V3, d: V3, tMin = 0, tMax = Infinity): Hit | null {
  let best: Hit | null = null;
  if (d.y !== 0) {
    const t = -o.y / d.y;
    if (t > tMin && t < tMax) {
      const x = o.x + d.x * t;
      const z = o.z + d.z * t;
      if (x >= FLOOR.x0 && x <= FLOOR.x1 && z <= FLOOR.z0 && z >= FLOOR.z1) best = { t, p: v3(x, 0, z), n: v3(0, d.y < 0 ? 1 : -1, 0), solid: -1, draw: 0 };
    }
  }
  SOLIDS.forEach((s, i) => {
    const h = hitBox(s, o, d, best ? best.t : tMax);
    if (h && h.t > tMin && (!best || h.t < best.t)) best = { t: h.t, p: v3(o.x + d.x * h.t, o.y + d.y * h.t, o.z + d.z * h.t), n: h.n, solid: i, draw: s.draw };
  });
  return best;
}

/** Is anything between p and p + d·tMax? */
export function blocked(p: V3, d: V3, tMax = Infinity): boolean {
  return cast(p, d, 1e-4, tMax) !== null;
}

/**
 * The camera ray through the centre of pixel (x, y) of a w × h image, as a direction whose
 * component along the view axis is 1 (so a hit's t is its view depth, the clip-space w).
 */
export function pixelRay(cam: Camera, x: number, y: number, w: number, h: number): V3 {
  const { right, up, fwd } = basis(cam);
  const a = ((2 * (x + 0.5)) / w - 1) * (cam.aspect / cam.focal);
  const b = (1 - (2 * (y + 0.5)) / h) / cam.focal;
  return v3(fwd.x + right.x * a + up.x * b, fwd.y + right.y * a + up.y * b, fwd.z + right.z * a + up.z * b);
}

/** A point in the camera's view space: x right, y up, z = distance along the view axis. */
export function toView(cam: Camera, p: V3): V3 {
  const { right, up, fwd } = basis(cam);
  const d = sub3(p, cam.eye);
  return v3(dot3(d, right), dot3(d, up), dot3(d, fwd));
}

/** What every pixel of a w × h image of the courtyard sees (null: sky). */
export function viewHits(w: number, h: number, cam = COURTYARD_CAMERA): Array<Hit | null> {
  const out: Array<Hit | null> = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(cast(cam.eye, pixelRay(cam, x, y, w, h)));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Matrices (column-major, as WGSL and GLSL want them)

/** Inverse of a 4 × 4 column-major matrix (to rebuild a position from depth). */
export function invert4(m: Float32Array | number[]): Float32Array {
  const a = Array.from(m);
  const inv = new Array<number>(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  return new Float32Array(inv.map((x) => x / det));
}

/** a · b for column-major 4 × 4 matrices. */
export function mul4(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

/** sRGB-encoded 0–255 to linear 0–1 (the theme's colours are sRGB). */
export function toLinear(c: [number, number, number]): RGB {
  const f = (x: number) => {
    const v = x / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [f(c[0]), f(c[1]), f(c[2])];
}
