/**
 * "Post-processing": the CPU-side model of the lesson's frame. No DOM, no GPU.
 *
 * The frame: the courtyard at night drawn into a half-float HDR target (lamps far brighter than 1),
 * optionally jittered for temporal anti-aliasing and at a lower render scale; a TAA resolve into a
 * history at the canvas's size; a bloom chain (13-tap downsamples, then tent upsamples, after
 * Jimenez 2014); and a tone-mapping pass to the canvas. The passes are listed here (postPasses), the
 * renderers walk the list, and the lesson's numbers come from the same functions: tone curves, the
 * jitter sequence, how long a stale colour survives in the history, and the chain's sizes and bytes.
 */
import { type V3, v3 } from '../raster';
import { type FramePlan } from '../gpu/plan';
import { type PointLight, viewProj } from '../gpu/scene';
import { box } from './common';
import { gpuMesh, type GpuMesh } from '../gpu/scene';
import { COURTYARD_CAMERA, courtyardDraws, courtyardLights } from './courtyard';

// ---------------------------------------------------------------------------------------------
// Tone mapping

export type ToneOp = 'clamp' | 'reinhard' | 'reinhard-ext' | 'aces';
export const TONE_OPS: Array<[ToneOp, string]> = [
  ['clamp', 'None (clamp)'],
  ['reinhard', 'Reinhard'],
  ['reinhard-ext', 'Reinhard, white 4'],
  ['aces', 'ACES fit'],
];
/** Reinhard's extended operator's white point: the input that maps to 1. */
export const WHITE = 4;

/** The curves, per channel, on exposed linear values (the shaders apply the same formulas). */
export function tone(op: ToneOp, x: number): number {
  switch (op) {
    case 'clamp':
      return Math.min(1, Math.max(0, x));
    case 'reinhard':
      return x / (1 + x);
    case 'reinhard-ext':
      return Math.min(1, (x * (1 + x / (WHITE * WHITE))) / (1 + x));
    case 'aces':
      // Narkowicz's fit of the ACES filmic curve (2016).
      return Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
  }
}
/** The input that a curve maps to 99% of white (Infinity if it never gets there). */
export function inputFor(op: ToneOp, y: number): number {
  let lo = 0;
  let hi = 1e6;
  if (tone(op, hi) < y) return Infinity;
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2;
    if (tone(op, m) < y) lo = m;
    else hi = m;
  }
  return hi;
}

// ---------------------------------------------------------------------------------------------
// Temporal anti-aliasing

/** The radical inverse of i in base b: the Halton sequence's i-th value. */
export function halton(i: number, b: number): number {
  let f = 1;
  let r = 0;
  let n = i;
  while (n > 0) {
    f /= b;
    r += f * (n % b);
    n = Math.floor(n / b);
  }
  return r;
}
export const JITTER_COUNT = 8;
/** Sub-pixel offsets, −0.5..0.5 pixels: Halton (2, 3) from index 1, repeating every JITTER_COUNT frames. */
export const jitter = (frame: number): [number, number] => {
  const i = (frame % JITTER_COUNT) + 1;
  return [halton(i, 2) - 0.5, halton(i, 3) - 0.5];
};
/** The history keeps (1 − α) of itself each frame. */
export const TAA_ALPHA = 0.1;
/** An exponential moving average with weight α has the variance of a plain average of (2 − α) / α samples. */
export const effectiveSamples = (alpha: number) => (2 - alpha) / alpha;
/** How much of a colour that's no longer there survives after n frames, if nothing rejects it. */
export const staleAfter = (alpha: number, n: number) => (1 - alpha) ** n;
export function framesBelow(alpha: number, share: number): number {
  let n = 0;
  while (staleAfter(alpha, n) >= share) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Bloom

export const BLOOM_LEVELS = 5;
/** Jimenez's mix: the bloom is lerped in at this weight. */
export const BLOOM_STRENGTH = 0.04;
/** The chain's sizes for a w × h source: each level half the last (rounded down, at least 1). */
export function bloomSizes(w: number, h: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let x = w;
  let y = h;
  for (let i = 0; i < BLOOM_LEVELS; i++) {
    x = Math.max(1, Math.floor(x / 2));
    y = Math.max(1, Math.floor(y / 2));
    out.push([x, y]);
  }
  return out;
}
/** Bytes per pixel of a half-float RGBA target. */
export const HDR_BYTES = 8;
/** Bytes of the chain: every downsampled level, and an upsampled one for each but the smallest. */
export function bloomBytes(w: number, h: number): number {
  const s = bloomSizes(w, h);
  const px = s.reduce((a, [x, y]) => a + x * y, 0) + s.slice(0, -1).reduce((a, [x, y]) => a + x * y, 0);
  return px * HDR_BYTES;
}

// ---------------------------------------------------------------------------------------------
// Settings, scene and passes

export type BloomOrder = 'hdr' | 'ldr';
export type TaaSpace = 'linear' | 'tonemapped';
export interface PostSettings {
  taa: boolean;
  clamp: boolean;
  taaSpace: TaaSpace;
  /** Render scale: the scene is drawn at this fraction of the canvas's width and height. */
  scale: number;
  bloom: boolean;
  bloomOrder: BloomOrder;
  strength: number;
  tone: ToneOp;
  /** Exposure in stops. */
  ev: number;
  /** Show the frame without post-processing on the left half. */
  split: boolean;
}
export const POST_DEFAULTS: PostSettings = { taa: true, clamp: true, taaSpace: 'linear', scale: 1, bloom: true, bloomOrder: 'hdr', strength: BLOOM_STRENGTH, tone: 'aces', ev: 0, split: false };
export const SCALES = [1, 0.75, 0.5];

/** Lamps: the first 16 courtyard lights, drawn as small glowing cubes. */
export const LAMP_COUNT = 16;
export const LAMP_INTENSITY = 4;
/** The lamps' cubes glow at this radiance, far above 1. */
export const LAMP_GLOW = 24;
export const postLights = (): PointLight[] => courtyardLights(LAMP_COUNT);

/** The crate that slides from side to side, for ghosting. */
export const MOVER = { centre: v3(-0.3, 0.35, 2.6), size: 0.7, amplitude: 2.2, speed: 0.9 };
export const moverOffset = (t: number): V3 => v3(MOVER.amplitude * Math.sin(t * MOVER.speed), 0, 0);

export interface PostDraw {
  name: string;
  mesh: GpuMesh;
  albedo: [number, number, number];
  checker: boolean;
  emissive: boolean;
  moves: boolean;
}
export function postDraws(): PostDraw[] {
  const base = courtyardDraws().map((d) => ({ name: d.name, mesh: d.mesh, albedo: d.albedo, checker: d.checker, emissive: false, moves: false }));
  const lamps = postLights().map((l) => box(l.pos, v3(0.14, 0.14, 0.14)));
  const m = { positions: lamps.flatMap((b) => b.positions), attrs: lamps.flatMap((b) => b.attrs), indices: lamps.flatMap((b, i) => b.indices.map((x) => x + i * 24)) };
  return [
    ...base,
    { name: 'lamps', mesh: gpuMesh('lamps', m), albedo: [1, 1, 1], checker: false, emissive: true, moves: false },
    { name: 'moving crate', mesh: gpuMesh('moving crate', box(MOVER.centre, v3(MOVER.size, MOVER.size, MOVER.size), 1, 0)), albedo: [0.7, 0.45, 0.3], checker: false, emissive: false, moves: true },
  ];
}

export interface PostPass {
  name: string;
  /** Renderer key. */
  pipeline: 'scene' | 'taa' | 'down-first' | 'down' | 'up' | 'composite';
  w: number;
  h: number;
  /** Named textures it reads, and the one it writes ('canvas' for the canvas). */
  inputs: string[];
  output: string;
}

/** The passes, in order, for a canvas of w × h device pixels. */
export function postPasses(s: PostSettings, w: number, h: number): PostPass[] {
  const rw = Math.max(1, Math.round(w * s.scale));
  const rh = Math.max(1, Math.round(h * s.scale));
  const out: PostPass[] = [{ name: 'scene (HDR)', pipeline: 'scene', w: rw, h: rh, inputs: [], output: 'scene' }];
  let src = 'scene';
  if (s.taa) {
    out.push({ name: 'TAA resolve', pipeline: 'taa', w, h, inputs: ['scene', 'history', 'depth'], output: 'history-next' });
    src = 'history-next';
  }
  if (s.bloom) {
    const sizes = bloomSizes(w, h);
    sizes.forEach(([x, y], i) => out.push({ name: `bloom down ${i + 1}`, pipeline: i === 0 ? 'down-first' : 'down', w: x, h: y, inputs: [i === 0 ? src : `down${i}`], output: `down${i + 1}` }));
    for (let i = BLOOM_LEVELS - 1; i >= 1; i--)
      out.push({ name: `bloom up ${i}`, pipeline: 'up', w: sizes[i - 1][0], h: sizes[i - 1][1], inputs: [i === BLOOM_LEVELS - 1 ? `down${BLOOM_LEVELS}` : `up${i + 1}`, `down${i}`], output: `up${i}` });
  }
  out.push({ name: 'tone map', pipeline: 'composite', w: 0, h: 0, inputs: [src, s.bloom ? 'up1' : src, 'scene'], output: 'canvas' });
  return out;
}

export function postPlan(s: PostSettings, w: number, h: number): FramePlan {
  const draws = postDraws();
  return {
    passes: postPasses(s, w, h).map((p) => ({
      name: p.name,
      target: p.output === 'canvas' ? 'the canvas' : `${p.output}, ${p.w} × ${p.h}`,
      w: p.output === 'canvas' ? 0 : p.w,
      h: p.output === 'canvas' ? 0 : p.h,
      draws:
        p.pipeline === 'scene'
          ? draws.map((d) => ({ name: d.name, pipeline: 'scene', indexed: true, count: d.mesh.indexCount, instances: 1 }))
          : [{ name: 'full-screen triangle', pipeline: p.pipeline, indexed: false, count: 3, instances: 1 }],
    })),
  };
}

export const postViewProj = () => viewProj(COURTYARD_CAMERA);
/** The view-projection with a sub-pixel offset added to clip x and y (in pixels of a w × h target). */
export function jitteredViewProj(jx: number, jy: number, w: number, h: number): Float32Array {
  const m = postViewProj();
  // clip.x += (2 jx / w) · clip.w: add that multiple of row 3 to row 0 (column-major: element c·4 + r).
  const ax = (2 * jx) / w;
  const ay = (2 * jy) / h;
  for (let c = 0; c < 4; c++) {
    m[c * 4] += ax * m[c * 4 + 3];
    m[c * 4 + 1] += ay * m[c * 4 + 3];
  }
  return m;
}
