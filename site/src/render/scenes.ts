/**
 * The scenes the rendering lessons draw, and the measurements their text quotes (checked by
 * test/lesson-claims.ts, `render` group). Everything here is built from exact numbers and sqrt,
 * never trig, so the same pixels come out in every browser and in Node.
 */
import { type Camera, type DepthFormat, type DepthMode, type Draw, type FillRule, type Mesh, type Options, type Stats, type V3, DEFAULTS, Target, depthAt, emptyStats, neighbour, quantise, render as renderGen, renderAll, v3 } from './raster';

// ---------------------------------------------------------------------------------------------
// Mesh builders

/** A quad from four corners, counter-clockwise seen from the front, with per-corner attributes. */
export function quad(p: [V3, V3, V3, V3], attrs: number[][]): Mesh {
  return { positions: p, attrs, indices: [0, 1, 2, 0, 2, 3] };
}

/** A fixed light direction for flat shading, normalised with sqrt. */
const LIGHT = (() => {
  const l = v3(0.4, 1, 0.6);
  const s = Math.sqrt(l.x * l.x + l.y * l.y + l.z * l.z);
  return v3(l.x / s, l.y / s, l.z / s);
})();
/** Brightness of a face with this normal: a little ambient plus Lambert. */
const lambert = (n: V3) => 0.35 + 0.65 * Math.max(0, n.x * LIGHT.x + n.y * LIGHT.y + n.z * LIGHT.z);

/**
 * A box: 24 vertices (each face has its own four, because each face has its own shade), 36 indices,
 * 12 triangles. Turned about the vertical axis by (c, s) = (cos, sin), given exactly.
 */
export function box(centre: V3, size: V3, c = 1, s = 0): Mesh {
  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;
  const rot = (p: V3) => v3(centre.x + p.x * c + p.z * s, centre.y + p.y, centre.z - p.x * s + p.z * c);
  const rotN = (n: V3) => v3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c);
  // Each face: normal, then its four corners counter-clockwise seen from outside.
  const faces: Array<[V3, V3[]]> = [
    [v3(0, 0, 1), [v3(-hx, -hy, hz), v3(hx, -hy, hz), v3(hx, hy, hz), v3(-hx, hy, hz)]],
    [v3(0, 0, -1), [v3(hx, -hy, -hz), v3(-hx, -hy, -hz), v3(-hx, hy, -hz), v3(hx, hy, -hz)]],
    [v3(1, 0, 0), [v3(hx, -hy, hz), v3(hx, -hy, -hz), v3(hx, hy, -hz), v3(hx, hy, hz)]],
    [v3(-1, 0, 0), [v3(-hx, -hy, -hz), v3(-hx, -hy, hz), v3(-hx, hy, hz), v3(-hx, hy, -hz)]],
    [v3(0, 1, 0), [v3(-hx, hy, hz), v3(hx, hy, hz), v3(hx, hy, -hz), v3(-hx, hy, -hz)]],
    [v3(0, -1, 0), [v3(-hx, -hy, -hz), v3(hx, -hy, -hz), v3(hx, -hy, hz), v3(-hx, -hy, hz)]],
  ];
  const m: Mesh = { positions: [], attrs: [], indices: [] };
  for (const [n, corners] of faces) {
    const b = m.positions.length;
    const lum = lambert(rotN(n));
    for (const p of corners) {
      m.positions.push(rot(p));
      m.attrs.push([lum]);
    }
    m.indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return m;
}

/** A horizontal rectangle at height y, from (x0, z0) to (x1, z1), facing up, with u, v in metres / tile. */
export function floor(x0: number, x1: number, z0: number, z1: number, y: number, tile: number): Mesh {
  // Seen from above, counter-clockwise: near-left, near-right, far-right, far-left (z1 < z0 is "far").
  return quad(
    [v3(x0, y, z0), v3(x1, y, z0), v3(x1, y, z1), v3(x0, y, z1)],
    [
      [x0 / tile, z0 / tile],
      [x1 / tile, z0 / tile],
      [x1 / tile, z1 / tile],
      [x0 / tile, z1 / tile],
    ],
  );
}

/** Checkerboard brightness for texture coordinates u, v (one square per unit). */
export const checker = (a: number[]) => ((Math.floor(a[0]) + Math.floor(a[1])) & 1 ? 0.55 : 1);
const flat = (a: number[]) => a[0];

// ---------------------------------------------------------------------------------------------
// Lesson 1: the pipeline. A floor that runs behind the camera (so the near plane has to clip it)
// and a box turned by a 3-4-5 angle.

export const PIPE_W = 64;
export const PIPE_H = 40;
export const PIPE_NEARS = [0.1, 1, 4.6] as const;

export function pipelineScene(): Draw[] {
  return [
    { name: 'floor', mesh: floor(-6, 6, 8, -20, 0, 2), color: '--c4', shade: checker },
    { name: 'box', mesh: box(v3(0, 0.7, 0), v3(1.4, 1.4, 1.4), 0.8, 0.6), color: '--c2', shade: flat },
  ];
}
export function pipelineCamera(near: number): Camera {
  return { eye: v3(0, 2.6, 5), target: v3(0, 0.4, 0), focal: 1.5, aspect: PIPE_W / PIPE_H, near, far: 100, reverseZ: false };
}
export function pipelineRun(near: number, cull: boolean): { stats: Stats; target: Target } {
  const target = new Target(PIPE_W, PIPE_H);
  const stats = renderAll(pipelineScene(), target, pipelineCamera(near), { ...DEFAULTS, cull });
  return { stats, target };
}

// ---------------------------------------------------------------------------------------------
// Lesson 2: rasterisation. Triangles given straight in pixels (x right, y down), in a tiny target.

export const RAST_W = 14;
export const RAST_H = 10;
export type RasterPreset = 'shared' | 'sliver';

/** Vertex positions in pixels for each preset: two triangles, A then B. */
export function rasterPoints(p: RasterPreset): Array<[number, number]> {
  if (p === 'shared')
    // A quad split along a 45° diagonal that runs exactly through nine pixel centres. A's top
    // edge and B's bottom edge are horizontal and also run through pixel centres.
    return [
      [1.5, 0.5],
      [10.5, 0.5],
      [2.5, 8.5],
      [10.5, 0.5],
      [12.5, 8.5],
      [2.5, 8.5],
    ];
  // A long sliver that slips between pixel centres, and a triangle smaller than a pixel that
  // covers no centre at all.
  return [
    [0.7, 1.2],
    [13.3, 7.6],
    [13.4, 8.6],
    [4.6, 7.1],
    [5.4, 7.25],
    [4.75, 7.45],
  ];
}

/** Screen-space draws: positions are pixels, mapped straight to clip space with w = 1. */
export function rasterScene(pts: Array<[number, number]>): { draws: Draw[]; camera: Camera } {
  // An orthographic camera that maps pixel (x, y) to clip space: built as clip coordinates directly.
  const toWorld = ([x, y]: [number, number]) => v3(x, y, 0.5);
  const mk = (i: number, color: string, name: string): Draw => ({
    name,
    color,
    twoSided: true,
    mesh: { positions: pts.slice(i, i + 3).map(toWorld), attrs: [[1], [0.8], [0.6]], indices: [0, 1, 2] },
    shade: () => 1,
  });
  return { draws: [mk(0, '--c2', 'A'), mk(3, '--c3', 'B')], camera: SCREEN_CAMERA };
}
/**
 * The "camera" for screen-space draws: render() spots `screen: true` and maps pixel positions
 * straight to clip space (w = 1), so no projection happens.
 */
export const SCREEN_CAMERA: Camera = { eye: v3(0, 0, 0), target: v3(0, 0, 1), focal: 1, aspect: 1, near: 0, far: 1, reverseZ: false, screen: { w: RAST_W, h: RAST_H } };

export interface CoverageCount {
  a: number;
  b: number;
  twice: number;
  missed: number;
  /** With 4× MSAA: pixels partly covered, fragment shader runs, covered samples. */
  partial: number;
  shaded: number;
  samples: number;
}

/** Each triangle drawn on its own (and both together), for counting and for marking pixels. */
export function coverageMaps(pts: Array<[number, number]>, fill: FillRule, samples: 1 | 4): { per: Target[]; ref: Target[]; both: Target; stats: Stats } {
  const { draws, camera } = rasterScene(pts);
  const one = (d: Draw, f: FillRule) => {
    const t = new Target(RAST_W, RAST_H, samples);
    renderAll([d], t, camera, { ...DEFAULTS, fill: f, depthTest: false });
    return t;
  };
  const both = new Target(RAST_W, RAST_H, samples);
  const stats = renderAll(draws, both, camera, { ...DEFAULTS, fill, depthTest: false });
  return { per: draws.map((d) => one(d, fill)), ref: draws.map((d) => one(d, 'top-left')), both, stats };
}

/** Count what a fill rule does to the two triangles. */
export function coverage(pts: Array<[number, number]>, fill: FillRule, samples: 1 | 4): CoverageCount {
  const { per, ref, both, stats } = coverageMaps(pts, fill, samples);
  const n = RAST_W * RAST_H * samples;
  let a = 0;
  let b = 0;
  let twice = 0;
  let missed = 0;
  let covered = 0;
  for (let i = 0; i < n; i++) {
    const ia = per[0].owner[i] >= 0;
    const ib = per[1].owner[i] >= 0;
    if (ia) a++;
    if (ib) b++;
    if (ia && ib) twice++;
    // "Missed": inside the pair by the top-left rule, but drawn by neither.
    if (!ia && !ib && (ref[0].owner[i] >= 0 || ref[1].owner[i] >= 0)) missed++;
    if (both.owner[i] >= 0) covered++;
  }
  let partial = 0;
  if (samples === 4)
    for (let p = 0; p < RAST_W * RAST_H; p++) {
      let k = 0;
      for (let s = 0; s < 4; s++) if (both.owner[p * 4 + s] >= 0) k++;
      if (k > 0 && k < 4) partial++;
    }
  return { a, b, twice, missed, partial, shaded: stats.shaded, samples: covered };
}

// ---------------------------------------------------------------------------------------------
// Lesson 2: perspective-correct interpolation. A checkerboard floor in two triangles.

export const PERSP_W = 64;
export const PERSP_H = 40;
export function perspectiveScene(): Draw[] {
  return [{ name: 'floor', mesh: floor(-4, 4, 1, -16, 0, 1), color: '--c1', shade: checker }];
}
export const perspectiveCamera: Camera = { eye: v3(0, 1.4, 1.4), target: v3(0, 0, -3), focal: 1.5, aspect: PERSP_W / PERSP_H, near: 0.1, far: 100, reverseZ: false };

/** The largest difference in texture coordinates between affine and perspective-correct, in squares. */
export function affineError(): { max: number; pixels: number; wrong: number } {
  const ta = new Target(PERSP_W, PERSP_H);
  const tb = new Target(PERSP_W, PERSP_H);
  renderAll(perspectiveScene(), ta, perspectiveCamera, { ...DEFAULTS, perspective: false });
  renderAll(perspectiveScene(), tb, perspectiveCamera, { ...DEFAULTS, perspective: true });
  let max = 0;
  let pixels = 0;
  let wrong = 0;
  // Re-run, collecting the uv each way per pixel.
  const uv = (perspective: boolean) => {
    const m = new Map<number, number[]>();
    const st = { ...DEFAULTS, perspective };
    const t = new Target(PERSP_W, PERSP_H);
    for (const s of renderSteps(perspectiveScene(), t, perspectiveCamera, st)) if (s.kind === 'pixel' && s.mask) m.set(s.y * PERSP_W + s.x, s.attrs);
    return m;
  };
  const A = uv(false);
  const B = uv(true);
  for (const [k, a] of A) {
    const b = B.get(k)!;
    pixels++;
    max = Math.max(max, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    if (ta.lum[k] !== tb.lum[k]) wrong++;
  }
  return { max, pixels, wrong };
}

// ---------------------------------------------------------------------------------------------
// Lesson 3: depth. Looking down at a field from 50 m up: a tower, the ground, and a road painted
// on as a separate quad 2 cm above the ground (a decal).

export const DEPTH_W = 96;
export const DEPTH_H = 60;
export const DEPTH_NEARS = [0.01, 0.1, 1, 10] as const;
export const DEPTH_FAR = 5000;
export const ROAD_LIFT = 0.02;

export function depthScene(): Draw[] {
  return [
    { name: 'tower', mesh: box(v3(-60, 30, -260), v3(30, 60, 30), 0.8, 0.6), color: '--c5', shade: flat },
    { name: 'ground', mesh: floor(-1500, 1500, 0, -3000, 0, 40), color: '--c4', shade: (a) => 0.4 + 0.35 * checker(a) },
    { name: 'road', mesh: floor(-12, 12, -40, -3000, ROAD_LIFT, 40), color: '--c1', shade: () => 1 },
  ];
}
export interface DepthSettings {
  format: DepthFormat;
  near: number;
  reverseZ: boolean;
  depthTest: boolean;
}
export const DEPTH_DEFAULT: DepthSettings = { format: 'unorm24', near: 0.1, reverseZ: false, depthTest: true };
export function depthCamera(s: DepthSettings): Camera {
  return { eye: v3(0, 50, 0), target: v3(0, 0, -100), focal: 1.5, aspect: DEPTH_W / DEPTH_H, near: s.near, far: DEPTH_FAR, reverseZ: s.reverseZ };
}
export function depthOptions(s: DepthSettings): Options {
  return { ...DEFAULTS, format: s.format, depthTest: s.depthTest };
}

/** How many of the road's pixels the ground shows through (z-fighting), and of how many. */
export function zFight(s: DepthSettings): { road: number; fighting: number; towerHidden: boolean } {
  const scene = depthScene();
  const cam = depthCamera(s);
  const roadOnly = new Target(DEPTH_W, DEPTH_H);
  renderAll([scene[2]], roadOnly, cam, depthOptions(s));
  const full = new Target(DEPTH_W, DEPTH_H);
  renderAll(scene, full, cam, depthOptions(s));
  let road = 0;
  let fighting = 0;
  let tower = 0;
  for (let i = 0; i < DEPTH_W * DEPTH_H; i++) {
    if (full.owner[i] === 0) tower++;
    if (roadOnly.owner[i] < 0) continue;
    road++;
    if (full.owner[i] === 1) fighting++;
  }
  return { road, fighting, towerHidden: tower === 0 };
}

/**
 * The depth buffer's resolution at distance z: how far apart two surfaces must be (along the view
 * direction) to be sure of different stored values: the width, in distance, of the range of
 * depths that round to the same value as z (halfway to the storable value on each side).
 */
export function resolution(z: number, near: number, far: number, fmt: DepthFormat, reverseZ: boolean): number {
  const q = quantise(depthAt(z, near, far, reverseZ), fmt);
  const lo = Math.max(0, (q + neighbour(q, fmt, -1)) / 2);
  const hi = Math.min(1, (q + neighbour(q, fmt, 1)) / 2);
  return Math.abs(distanceAt(hi, near, far, reverseZ) - distanceAt(lo, near, far, reverseZ));
}
/** The inverse of depthAt: the distance that maps to depth d. */
export function distanceAt(d: number, near: number, far: number, reverseZ: boolean): number {
  if (!reverseZ) return far === Infinity ? near / (1 - d) : near / (1 - (d * (far - near)) / far);
  return far === Infinity ? near / d : far / (1 + (d * (far - near)) / near);
}

// ---------------------------------------------------------------------------------------------
// Lesson 3: early Z, late Z and a depth prepass. Boxes in a row, overlapping on screen.

export const OVER_W = 80;
export const OVER_H = 50;
export type DrawOrder = 'front' | 'back';
export function overdrawScene(order: DrawOrder): Draw[] {
  const boxes: Draw[] = [];
  const cols = ['--c2', '--c3', '--c6', '--c5', '--c7', '--c1'];
  // Front to back as authored; reversed for back to front.
  // Two rows of buildings down a street, each taller than the one in front, so they hide each other.
  for (let i = 0; i < 6; i++)
    for (const side of [-1, 1]) {
      const hgt = 2 + i * 0.7;
      boxes.push({ name: `${side < 0 ? 'left' : 'right'} building ${i + 1}`, mesh: box(v3(side * 2.6, hgt / 2, -1.5 - i * 2), v3(2.2, hgt, 1.6)), color: cols[i], shade: flat });
    }
  const wall: Draw = { name: 'back wall', mesh: quad([v3(-12, 0, -14), v3(12, 0, -14), v3(12, 8, -14), v3(-12, 8, -14)], [[0.5], [0.5], [0.5], [0.5]]), color: '--c8', shade: flat };
  const ground: Draw = { name: 'ground', mesh: floor(-12, 12, 4, -14, 0, 1), color: '--c4', shade: checker };
  const list = [...boxes, ground, wall];
  return order === 'front' ? list : list.reverse();
}
export const overdrawCamera: Camera = { eye: v3(0, 1.6, 3), target: v3(0, 1.2, -6), focal: 1.4, aspect: OVER_W / OVER_H, near: 0.1, far: 100, reverseZ: false };

export function overdraw(order: DrawOrder, mode: DepthMode): { stats: Stats; visible: number; target: Target } {
  const t = new Target(OVER_W, OVER_H);
  const stats = renderAll(overdrawScene(order), t, overdrawCamera, { ...DEFAULTS, depthMode: mode });
  let visible = 0;
  for (let i = 0; i < OVER_W * OVER_H; i++) if (t.owner[i] >= 0) visible++;
  return { stats, visible, target: t };
}

/** Every step of a frame (for measurements that need per-pixel detail). */
export function* renderSteps(draws: Draw[], target: Target, cam: Camera, opt: Options) {
  yield* renderGen(draws, target, cam, opt, emptyStats());
}

/** A length for the lesson text and the widgets: metres, centimetres, millimetres or micrometres. */
export function lengthText(m: number): string {
  const r = (x: number) => (x >= 10 || Number.isInteger(x) ? Math.round(x).toString() : x.toFixed(1));
  if (m >= 1) return `${r(m)} m`;
  if (m >= 0.01) return `${r(m * 100)} cm`;
  if (m >= 0.001) return `${r(m * 1000)} mm`;
  return `${r(m * 1e6)} µm`;
}
