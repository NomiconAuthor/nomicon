/**
 * The teaching rasteriser behind the rendering lessons. It does what a GPU's fixed-function
 * pipeline does, one step at a time, so a widget can pause it after any vertex, triangle or pixel:
 *
 *   vertex shading → primitive assembly → near/far clipping → perspective divide and viewport →
 *   snap to 8 bits of sub-pixel precision → back-face culling → edge functions with the
 *   top-left rule → barycentrics → (early or late) depth test → fragment shading → write.
 *
 * Deterministic: positions are snapped to integers before any coverage decision, edge functions
 * are exact integer arithmetic, and nothing on the path uses Math.sin/cos/tan, so every browser
 * draws the same pixels as the tests in Node. Depth is interpolated in double precision and
 * rounded to the depth format only when it's stored, so what you see is the format's limit.
 *
 * The target doesn't store colours: it stores, per sample, which draw wrote it and a brightness.
 * The views turn that into theme colours, so the three site themes all work.
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}
export const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
export const sub3 = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const add3 = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const scale3 = (a: V3, s: number): V3 => v3(a.x * s, a.y * s, a.z * s);
export const dot3 = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross3 = (a: V3, b: V3): V3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const norm3 = (a: V3): V3 => scale3(a, 1 / Math.sqrt(dot3(a, a)));

/** Clip-space position: x, y, z, w. */
export type V4 = [number, number, number, number];

// ---------------------------------------------------------------------------------------------
// Camera and the "vertex shader"

export interface Camera {
  eye: V3;
  /** Where it looks. The basis is built with sqrt only (no trig), so it's identical everywhere. */
  target: V3;
  /** 1 / tan(vertical field of view / 2). 1.5 is about 67°. */
  focal: number;
  /** Width / height of the target. */
  aspect: number;
  near: number;
  /** Infinity is allowed. */
  far: number;
  /** Map the near plane to depth 1 and the far plane to 0, and test with "greater". */
  reverseZ: boolean;
  /** No projection: positions are already pixels (x right, y down, z is depth), in a target this size. */
  screen?: { w: number; h: number };
}

export function basis(cam: Camera): { right: V3; up: V3; fwd: V3 } {
  const fwd = norm3(sub3(cam.target, cam.eye));
  const right = norm3(cross3(fwd, v3(0, 1, 0)));
  const up = cross3(right, fwd);
  return { right, up, fwd };
}

/**
 * World position to clip space, D3D/Vulkan/WebGPU style: after the divide, x and y run from −1 to 1
 * and depth from 0 to 1. w is the distance in front of the camera.
 */
export function toClip(p: V3, cam: Camera, b = basis(cam)): V4 {
  if (cam.screen) return [(p.x / cam.screen.w) * 2 - 1, 1 - (p.y / cam.screen.h) * 2, p.z, 1];
  const d = sub3(p, cam.eye);
  const xv = dot3(d, b.right);
  const yv = dot3(d, b.up);
  const z = dot3(d, b.fwd);
  const { near: n, far: f } = cam;
  let zc: number;
  if (!cam.reverseZ) zc = f === Infinity ? z - n : (f / (f - n)) * (z - n); // depth = f/(f−n)·(1 − n/z)
  else zc = f === Infinity ? n : (n / (f - n)) * (f - z); //                   depth = n/(f−n)·(f/z − 1), or n/z
  return [(xv * cam.focal) / cam.aspect, yv * cam.focal, zc, z];
}

/** The depth (after the divide) that a point at distance z in front of the camera gets. */
export function depthAt(z: number, near: number, far: number, reverseZ: boolean): number {
  const c = toClip(v3(0, 0, z), { eye: v3(0, 0, 0), target: v3(0, 0, 1), focal: 1, aspect: 1, near, far, reverseZ });
  return c[2] / c[3];
}

// ---------------------------------------------------------------------------------------------
// Depth formats

export type DepthFormat = 'unorm16' | 'unorm24' | 'float32';
export const FORMAT_LABEL: Record<DepthFormat, string> = { unorm16: '16-bit', unorm24: '24-bit', float32: '32-bit float' };

const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);

/** Round a depth in [0, 1] to what the format can store. */
export function quantise(d: number, fmt: DepthFormat): number {
  const c = d < 0 ? 0 : d > 1 ? 1 : d;
  if (fmt === 'float32') return Math.fround(c);
  const max = fmt === 'unorm16' ? 65535 : 16777215;
  return Math.round(c * max) / max;
}

/** The next storable value above (dir = 1) or below (dir = −1) a storable value q. */
export function neighbour(q: number, fmt: DepthFormat, dir: 1 | -1): number {
  if (fmt === 'float32') {
    f32[0] = q;
    if (q === 0) return dir > 0 ? 1.401298464324817e-45 : 0;
    i32[0] += dir;
    return f32[0];
  }
  const max = fmt === 'unorm16' ? 65535 : 16777215;
  return Math.round(q * max + dir) / max;
}

// ---------------------------------------------------------------------------------------------
// Meshes and draws

export interface Mesh {
  positions: V3[];
  /** Per-vertex attributes (texture coordinates, a shade), interpolated across each triangle. */
  attrs: number[][];
  /** Three indices per triangle, counter-clockwise when seen from the front. */
  indices: number[];
}

export interface Draw {
  name: string;
  mesh: Mesh;
  /** Theme token for its colour, such as '--c2'. */
  color: string;
  /** The "fragment shader": interpolated attributes to a brightness from 0 to 1. */
  shade: (a: number[]) => number;
  /** Draw both sides (default: cull back faces). */
  twoSided?: boolean;
}

// ---------------------------------------------------------------------------------------------
// The render target

/** 8 bits of sub-pixel precision, as D3D11 requires: positions are snapped to 1/256 pixel. */
export const SUB = 256;
/** The standard 4× sample positions in D3D and Vulkan, in 1/256 pixel from the pixel's corner. */
export const SAMPLES_4X: Array<[number, number]> = [
  [96, 32],
  [224, 96],
  [32, 160],
  [160, 224],
];
const SAMPLES_1X: Array<[number, number]> = [[128, 128]];

export class Target {
  readonly samples: number;
  /** Per sample: the draw that last wrote it, or −1. */
  readonly owner: Int16Array;
  /** Per sample: the brightness the fragment shader returned. */
  readonly lum: Float32Array;
  /** Per sample: the stored (already rounded) depth. */
  readonly depth: Float64Array;
  /** Per pixel: how many times the fragment shader ran there. */
  readonly shaded: Uint16Array;
  constructor(
    readonly w: number,
    readonly h: number,
    samples: 1 | 4 = 1,
  ) {
    this.samples = samples;
    const n = w * h * samples;
    this.owner = new Int16Array(n);
    this.lum = new Float32Array(n);
    this.depth = new Float64Array(n);
    this.shaded = new Uint16Array(w * h);
  }
  clear(depth: number): void {
    this.owner.fill(-1);
    this.lum.fill(0);
    this.depth.fill(depth);
    this.shaded.fill(0);
  }
}

// ---------------------------------------------------------------------------------------------
// Options, statistics and steps

export type FillRule = 'top-left' | 'inclusive' | 'exclusive';
export type DepthMode = 'late' | 'early' | 'prepass';

export interface Options {
  fill: FillRule;
  perspective: boolean;
  cull: boolean;
  depthTest: boolean;
  depthWrite: boolean;
  format: DepthFormat;
  /** Late: shade, then test. Early: test, then shade only what passed. Prepass: a depth-only pass first. */
  depthMode: DepthMode;
}
export const DEFAULTS: Options = { fill: 'top-left', perspective: true, cull: true, depthTest: true, depthWrite: true, format: 'unorm24', depthMode: 'early' };

export interface Stats {
  draws: number;
  vertices: number;
  triangles: number;
  /** Triangles thrown away: all outside the view, facing away, or zero area. */
  outside: number;
  backfacing: number;
  degenerate: number;
  /** Triangles cut by the near or far plane, and how many triangles came out. */
  clipped: number;
  clippedOut: number;
  rasterised: number;
  /** Pixels whose centre (or a sample) was tested against the edge functions. */
  tested: number;
  /** Fragments: pixels a triangle covers. */
  fragments: number;
  /** Fragment shader invocations. */
  shaded: number;
  /** Samples or pixels that failed the depth test. */
  depthFailed: number;
  /** Pixels written (at least one sample). */
  written: number;
  /** Fragments in the depth-only prepass. */
  prepassFragments: number;
}
export const emptyStats = (): Stats => ({ draws: 0, vertices: 0, triangles: 0, outside: 0, backfacing: 0, degenerate: 0, clipped: 0, clippedOut: 0, rasterised: 0, tested: 0, fragments: 0, shaded: 0, depthFailed: 0, written: 0, prepassFragments: 0 });

/** A triangle after the divide and viewport: integer positions in 1/256 pixel. */
export interface ScreenTri {
  /** Positions in 1/SUB pixel, y down. */
  x: [number, number, number];
  y: [number, number, number];
  /** Depth after the divide (0 to 1). */
  z: [number, number, number];
  /** 1 / w, for perspective-correct interpolation. */
  iw: [number, number, number];
  attrs: [number[], number[], number[]];
  /** Twice the signed area, in (1/SUB pixel)². Positive after setup. */
  area: number;
  /** Which edges are top or left edges (edge i runs from vertex i to vertex i+1). */
  topLeft: [boolean, boolean, boolean];
}

export type Step =
  | { kind: 'draw'; draw: number; pass: 'depth' | 'main' }
  | { kind: 'vertex'; draw: number; index: number; world: V3; clip: V4 }
  | { kind: 'triangle'; draw: number; tri: number; clip: V4[]; fate: 'drawn' | 'outside' | 'back' | 'degenerate'; pieces: ScreenTri[]; clipped: boolean }
  | PixelStep
  | { kind: 'done' };

export interface PixelStep {
  kind: 'pixel';
  draw: number;
  tri: number;
  piece: ScreenTri;
  x: number;
  y: number;
  /** Edge function values at the pixel centre, in pixels² (positive inside). */
  edges: [number, number, number];
  /** Which samples are covered (bit per sample). */
  mask: number;
  /** Why the centre counts or doesn't when it lies exactly on an edge. */
  tie: 'none' | 'top-left' | 'not-top-left' | 'inclusive' | 'exclusive';
  /** Screen-space barycentrics at the centre, and the perspective-corrected ones. */
  bary: [number, number, number];
  pbary: [number, number, number];
  /** Interpolated attributes at the centre. */
  attrs: number[];
  /** Depth at the centre (rounded to the format) and what was stored there before. */
  depth: number;
  stored: number;
  /** Covered samples that passed the depth test. */
  passMask: number;
  shaded: boolean;
  lum: number;
}

// ---------------------------------------------------------------------------------------------
// Clipping

interface ClipVert {
  c: V4;
  a: number[];
}
function lerpVert(p: ClipVert, q: ClipVert, t: number): ClipVert {
  return { c: p.c.map((x, i) => x + (q.c[i] - x) * t) as V4, a: p.a.map((x, i) => x + (q.a[i] - x) * t) };
}
/** Sutherland–Hodgman against one plane, keeping the side where dist(v) ≥ 0. */
function clipPlane(poly: ClipVert[], dist: (c: V4) => number): ClipVert[] {
  const out: ClipVert[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = dist(p.c);
    const dq = dist(q.c);
    if (dp >= 0) out.push(p);
    if (dp >= 0 !== dq >= 0) out.push(lerpVert(p, q, dp / (dp - dq)));
  }
  return out;
}

/**
 * Clip against the near and far planes only (0 ≤ z ≤ w). Like most GPUs, the sides are left to a
 * guard band: the rasteriser only visits pixels inside the target, so a triangle hanging off the
 * side costs nothing extra. Near must be clipped: behind the camera w ≤ 0 and the divide breaks.
 */
export function clipNearFar(tri: ClipVert[]): ClipVert[] {
  // With reverse-Z the near plane is z = w and the far plane z = 0; either way 0 ≤ z ≤ w.
  let poly = clipPlane(tri, (c) => c[2]);
  if (poly.length) poly = clipPlane(poly, (c) => c[3] - c[2]);
  return poly;
}

// ---------------------------------------------------------------------------------------------
// Setup

/** Edge function of the edge a→b at point p, in fixed point. Positive on the inside after setup. */
export const edge = (ax: number, ay: number, bx: number, by: number, px: number, py: number) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);

/**
 * With y pointing down and the inside positive, an edge a→b is a top edge if it's horizontal and the
 * inside is below it (b.x > a.x), and a left edge if the inside is to its right (a.y > b.y).
 */
export const isTopLeft = (ax: number, ay: number, bx: number, by: number) => (ay === by && bx > ax) || ay > by;

/** Divide, viewport, snap; returns null for a zero-area triangle. `front` says which way it faced. */
export function setup(v: ClipVert[], w: number, h: number): { tri: ScreenTri; front: boolean } | null {
  const x = v.map((p) => Math.round((p.c[0] / p.c[3] + 1) * 0.5 * w * SUB)) as [number, number, number];
  const y = v.map((p) => Math.round((1 - p.c[1] / p.c[3]) * 0.5 * h * SUB)) as [number, number, number];
  const z = v.map((p) => p.c[2] / p.c[3]) as [number, number, number];
  const iw = v.map((p) => 1 / p.c[3]) as [number, number, number];
  const attrs = v.map((p) => p.a) as [number[], number[], number[]];
  let area = edge(x[0], y[0], x[1], y[1], x[2], y[2]);
  if (area === 0) return null;
  // Counter-clockwise in clip space (y up) turns clockwise on screen (y down): negative area here.
  const front = area < 0;
  if (front) {
    // Swap vertices 1 and 2 so the inside is positive for every edge.
    for (const arr of [x, y, z, iw, attrs] as unknown as unknown[][]) [arr[1], arr[2]] = [arr[2], arr[1]];
    area = -area;
  }
  const topLeft: [boolean, boolean, boolean] = [0, 1, 2].map((i) => isTopLeft(x[i], y[i], x[(i + 1) % 3], y[(i + 1) % 3])) as [boolean, boolean, boolean];
  return { tri: { x, y, z, iw, attrs, area, topLeft }, front };
}

/** Is a point covered, given its three edge values? Ties (exactly 0) are settled by the fill rule. */
export function covers(e: [number, number, number], tl: [boolean, boolean, boolean], fill: FillRule): boolean {
  for (let i = 0; i < 3; i++) {
    if (e[i] > 0) continue;
    if (e[i] < 0) return false;
    if (fill === 'exclusive') return false;
    if (fill === 'top-left' && !tl[i]) return false;
  }
  return true;
}

/** Edge values at a point: e[i] is the edge from vertex i to vertex i+1, so it's 0 at those two. */
function edgesAt(t: ScreenTri, px: number, py: number): [number, number, number] {
  return [edge(t.x[0], t.y[0], t.x[1], t.y[1], px, py), edge(t.x[1], t.y[1], t.x[2], t.y[2], px, py), edge(t.x[2], t.y[2], t.x[0], t.y[0], px, py)];
}

/** Barycentrics from edge values: a vertex's weight is the edge opposite it over the area. */
function baryOf(t: ScreenTri, e: [number, number, number]): [number, number, number] {
  return [e[1] / t.area, e[2] / t.area, e[0] / t.area];
}
/** Perspective correction: weight each vertex by 1/w, then renormalise. */
export function perspectiveBary(t: ScreenTri, b: [number, number, number]): [number, number, number] {
  const p0 = b[0] * t.iw[0];
  const p1 = b[1] * t.iw[1];
  const p2 = b[2] * t.iw[2];
  const s = p0 + p1 + p2;
  return [p0 / s, p1 / s, p2 / s];
}

// ---------------------------------------------------------------------------------------------
// The pipeline, as a generator of steps

const less = (a: number, b: number) => a < b;
const greater = (a: number, b: number) => a > b;

/**
 * Render a list of draws into a target, yielding after every vertex, triangle and pixel. Run it
 * to the end for the finished frame, or call next() once per click to step through it.
 */
export function* render(draws: Draw[], target: Target, cam: Camera, opt: Options, stats: Stats): Generator<Step, void, void> {
  const W = target.w;
  const H = target.h;
  const S = target.samples;
  const pos = S === 4 ? SAMPLES_4X : SAMPLES_1X;
  const b = basis(cam);
  target.clear(cam.reverseZ ? 0 : 1);
  // Reverse-Z flips the comparison. After a prepass the main pass must also accept "equal".
  const strict = cam.reverseZ ? greater : less;
  const passes: Array<'depth' | 'main'> = opt.depthMode === 'prepass' && opt.depthTest ? ['depth', 'main'] : ['main'];

  for (const pass of passes) {
    const test = pass === 'main' && opt.depthMode === 'prepass' ? (a: number, s: number) => a === s || strict(a, s) : strict;
    for (let di = 0; di < draws.length; di++) {
      const d = draws[di];
      const m = d.mesh;
      if (pass === 'main') stats.draws++;
      yield { kind: 'draw', draw: di, pass };

      // Vertex shading: once per vertex in the buffer. (GPUs cache recent results by index; a vertex
      // shared by many triangles can still be shaded more than once if it falls out of that cache.)
      const clip: V4[] = [];
      for (let i = 0; i < m.positions.length; i++) {
        clip.push(toClip(m.positions[i], cam, b));
        if (pass === 'main') {
          stats.vertices++;
          yield { kind: 'vertex', draw: di, index: i, world: m.positions[i], clip: clip[i] };
        }
      }

      // Primitive assembly: three indices make a triangle.
      for (let t = 0; t * 3 < m.indices.length; t++) {
        const ids = [m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2]];
        const cv = ids.map((i) => ({ c: clip[i], a: m.attrs[i] }));
        if (pass === 'main') stats.triangles++;
        // Trivial reject: every vertex outside the same plane.
        const outside = [0, 1, 2, 3, 4, 5].some((k) =>
          cv.every(({ c }) => (k === 0 ? c[0] < -c[3] : k === 1 ? c[0] > c[3] : k === 2 ? c[1] < -c[3] : k === 3 ? c[1] > c[3] : k === 4 ? c[2] < 0 : c[2] > c[3])),
        );
        if (outside) {
          if (pass === 'main') stats.outside++;
          yield { kind: 'triangle', draw: di, tri: t, clip: cv.map((v) => v.c), fate: 'outside', pieces: [], clipped: false };
          continue;
        }
        const poly = clipNearFar(cv);
        const wasClipped = poly.length !== 3 || poly.some((p, k) => p !== cv[k]);
        // The clipped polygon is convex: split it into a fan.
        const pieces: ScreenTri[] = [];
        let fate: 'drawn' | 'back' | 'degenerate' = 'drawn';
        for (let k = 1; k + 1 < poly.length; k++) {
          const s = setup([poly[0], poly[k], poly[k + 1]], W, H);
          if (!s) {
            fate = 'degenerate';
            continue;
          }
          if (!s.front && opt.cull && !d.twoSided) {
            fate = 'back';
            continue;
          }
          fate = 'drawn';
          pieces.push(s.tri);
        }
        if (pass === 'main') {
          if (wasClipped) {
            stats.clipped++;
            stats.clippedOut += pieces.length;
          }
          if (!pieces.length && fate === 'back') stats.backfacing++;
          if (!pieces.length && fate === 'degenerate') stats.degenerate++;
          stats.rasterised += pieces.length;
        }
        yield { kind: 'triangle', draw: di, tri: t, clip: cv.map((v) => v.c), fate: pieces.length ? 'drawn' : fate, pieces, clipped: wasClipped };

        for (const tri of pieces) {
          // Bounding box in pixels, clamped to the target (this is the guard band at work).
          const minX = Math.max(0, Math.floor(Math.min(...tri.x) / SUB));
          const maxX = Math.min(W - 1, Math.floor(Math.max(...tri.x) / SUB));
          const minY = Math.max(0, Math.floor(Math.min(...tri.y) / SUB));
          const maxY = Math.min(H - 1, Math.floor(Math.max(...tri.y) / SUB));
          for (let py = minY; py <= maxY; py++)
            for (let px = minX; px <= maxX; px++) {
              const step = pixel(tri, px, py);
              if (step) yield step;
            }
          function pixel(tri: ScreenTri, px: number, py: number): PixelStep | null {
            if (pass === 'main') stats.tested++;
            // Coverage, per sample.
            let mask = 0;
            for (let s = 0; s < S; s++) {
              const e = edgesAt(tri, px * SUB + pos[s][0], py * SUB + pos[s][1]);
              if (covers(e, tri.topLeft, opt.fill)) mask |= 1 << s;
            }
            const cx = px * SUB + SUB / 2;
            const cy = py * SUB + SUB / 2;
            const ec = edgesAt(tri, cx, cy);
            let tie: PixelStep['tie'] = 'none';
            if (ec.every((e) => e >= 0) && ec.some((e) => e === 0)) tie = opt.fill === 'top-left' ? (covers(ec, tri.topLeft, 'top-left') ? 'top-left' : 'not-top-left') : opt.fill;
            // Attributes are evaluated at the pixel centre, even when only some samples are covered.
            const bary = baryOf(tri, ec);
            const pb = perspectiveBary(tri, bary);
            const wts = opt.perspective ? pb : bary;
            const attrs = tri.attrs[0].map((_, k) => wts[0] * tri.attrs[0][k] + wts[1] * tri.attrs[1][k] + wts[2] * tri.attrs[2][k]);
            // Depth is z/w, which is linear in screen space: plain barycentrics, no correction.
            const depthAtSample = (s: number) => {
              const e = S === 1 ? ec : edgesAt(tri, px * SUB + pos[s][0], py * SUB + pos[s][1]);
              const bb = baryOf(tri, e);
              return quantise(bb[0] * tri.z[0] + bb[1] * tri.z[1] + bb[2] * tri.z[2], opt.format);
            };
            const base = (py * W + px) * S;
            const out: PixelStep = { kind: 'pixel', draw: di, tri: t, piece: tri, x: px, y: py, edges: ec.map((e) => e / (SUB * SUB)) as [number, number, number], mask, tie, bary, pbary: pb, attrs, depth: quantise(bary[0] * tri.z[0] + bary[1] * tri.z[1] + bary[2] * tri.z[2], opt.format), stored: target.depth[base], passMask: 0, shaded: false, lum: 0 };
            if (!mask) return pass === 'main' ? out : null;
            if (pass === 'main') stats.fragments++;
            else stats.prepassFragments++;

            // Depth test for each covered sample.
            let passMask = 0;
            const ds: number[] = [];
            for (let s = 0; s < S; s++) {
              if (!(mask & (1 << s))) continue;
              ds[s] = depthAtSample(s);
              if (!opt.depthTest || test(ds[s], target.depth[base + s])) passMask |= 1 << s;
              else if (pass === 'main') stats.depthFailed++;
            }
            out.passMask = passMask;
            if (pass === 'depth') {
              for (let s = 0; s < S; s++) if (passMask & (1 << s)) target.depth[base + s] = ds[s];
              return out;
            }
            // Late Z shades every covered fragment; early Z (and the prepass) only ones that passed.
            const shade = opt.depthMode === 'late' || !opt.depthTest ? true : passMask !== 0;
            if (shade) {
              out.shaded = true;
              out.lum = d.shade(attrs);
              stats.shaded++;
              target.shaded[py * W + px]++;
            }
            if (passMask) stats.written++;
            for (let s = 0; s < S; s++) {
              if (!(passMask & (1 << s))) continue;
              if (opt.depthWrite && opt.depthMode !== 'prepass') target.depth[base + s] = ds[s];
              target.owner[base + s] = di;
              target.lum[base + s] = out.lum;
            }
            return out;
          }
        }
      }
    }
  }
  yield { kind: 'done' };
}

/** Run a whole frame and return its statistics. */
export function renderAll(draws: Draw[], target: Target, cam: Camera, opt: Options): Stats {
  const stats = emptyStats();
  for (const _ of render(draws, target, cam, opt, stats)) void _;
  return stats;
}
