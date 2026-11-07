/**
 * The textures lesson's scene: a long checkerboard floor seen from low down, so the texture is
 * magnified at the bottom of the frame and squeezed hard towards the horizon. Every pixel samples
 * one texture through the sampler the widget picks; the measurements compare each filter with a
 * supersampled reference and count the texels it reads.
 */
import { type Camera, type Draw, type Frag, type Sampler, type SampleTrace, DEFAULTS, Target, Texture, basis, newTrace, renderAll, v3 } from '../raster';
import { floor } from './common';

export const TEX_W = 96;
export const TEX_H = 60;
/** Texels per side, and texels per checker square. */
export const TEX_SIZE = 64;
export const TEX_SQUARE = 8;
/** Metres per repeat of the texture on the floor. */
export const TEX_REPEAT = 4;

/** An 8 × 8 checkerboard, 64 texels across: light and dark squares of 8 × 8 texels. */
export function checkerTexture(): Texture {
  const d: number[] = [];
  for (let y = 0; y < TEX_SIZE; y++) for (let x = 0; x < TEX_SIZE; x++) d.push((Math.floor(x / TEX_SQUARE) + Math.floor(y / TEX_SQUARE)) & 1 ? 0.12 : 0.92);
  return new Texture(TEX_SIZE, TEX_SIZE, 1, d);
}

export type FilterMode = 'point' | 'bilinear' | 'mip-nearest' | 'trilinear' | 'aniso';
export const FILTER_LABEL: Record<FilterMode, string> = {
  point: 'Nearest, no mipmaps',
  bilinear: 'Bilinear, no mipmaps',
  'mip-nearest': 'Bilinear, nearest mip',
  trilinear: 'Trilinear',
  aniso: 'Anisotropic',
};
export const ANISO_STEPS = [2, 4, 8, 16] as const;
export function samplerFor(mode: FilterMode, aniso = 16): Sampler {
  if (mode === 'point') return { filter: 'nearest', mip: 'none', aniso: 1 };
  if (mode === 'bilinear') return { filter: 'linear', mip: 'none', aniso: 1 };
  if (mode === 'mip-nearest') return { filter: 'linear', mip: 'nearest', aniso: 1 };
  if (mode === 'trilinear') return { filter: 'linear', mip: 'linear', aniso: 1 };
  return { filter: 'linear', mip: 'linear', aniso };
}

/** What each pixel's sample did: its coordinates (in texture units), derivatives and the trace. */
export interface PixelSample {
  u: number;
  v: number;
  d: number[];
  trace: SampleTrace;
  value: number;
}

export const texCamera: Camera = { eye: v3(0, 0.8, 1.5), target: v3(0, -2.2, -6), focal: 1.4, aspect: TEX_W / TEX_H, near: 0.1, far: 500, reverseZ: false };

/** The floor, sampling the texture through `s`; every sample is logged by pixel. */
export function texScene(tex: Texture, s: Sampler, log?: Map<number, PixelSample>): Draw[] {
  // uv in texture repeats: floor() gives metres / tile.
  const mesh = floor(-800, 800, 1.5, -400, 0, TEX_REPEAT);
  const shade = (a: number[], f: Frag) => {
    const tr = newTrace();
    const d = [f.dx[0], f.dx[1], f.dy[0], f.dy[1]];
    const value = tex.sample(a[0], a[1], d, s, tr)[0];
    log?.set(f.y * TEX_W + f.x, { u: a[0], v: a[1], d, trace: tr, value });
    return value;
  };
  return [{ name: 'floor', mesh, color: '--c1', shade }];
}

export interface TexRun {
  target: Target;
  log: Map<number, PixelSample>;
  /** Mean |sampled − reference| over the floor's pixels, and the texels read per pixel. */
  error: number;
  reads: number;
  /** Highest level of detail any pixel asked for, and the largest footprint ratio long : short. */
  maxLambda: number;
  maxRatio: number;
}

export function texRun(mode: FilterMode, aniso = 16): TexRun {
  const tex = checkerTexture();
  const log = new Map<number, PixelSample>();
  const target = new Target(TEX_W, TEX_H);
  renderAll(texScene(tex, samplerFor(mode, aniso), log), target, texCamera, { ...DEFAULTS, quads: true });
  return { target, log, ...measure(log) };
}

/** Error against the reference, texels read per pixel, and the extremes of the footprint. */
export function measure(log: Map<number, PixelSample>): Omit<TexRun, 'target' | 'log'> {
  const ref = reference();
  let err = 0;
  let reads = 0;
  let maxLambda = 0;
  let maxRatio = 1;
  for (const [p, s] of log) {
    err += Math.abs(s.value - ref[p]);
    reads += s.trace.reads;
    maxLambda = Math.max(maxLambda, s.trace.lambda);
    maxRatio = Math.max(maxRatio, Math.max(s.trace.px, s.trace.py) / Math.min(s.trace.px, s.trace.py));
  }
  return { error: err / log.size, reads: reads / log.size, maxLambda, maxRatio };
}

/**
 * The reference: each pixel's true average over its area, from 16 × 16 rays per pixel hitting the
 * floor (y = 0) and reading the nearest texel of the full-size texture. Pixels whose rays miss
 * the floor's far edge average only the hits.
 */
let refCache: Float64Array | null = null;
export function reference(): Float64Array {
  if (refCache) return refCache;
  const tex = checkerTexture();
  const b = basis(texCamera);
  const out = new Float64Array(TEX_W * TEX_H);
  const N = 16;
  for (let y = 0; y < TEX_H; y++)
    for (let x = 0; x < TEX_W; x++) {
      let sum = 0;
      let hits = 0;
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const nx = ((x + (i + 0.5) / N) / TEX_W) * 2 - 1;
          const ny = 1 - ((y + (j + 0.5) / N) / TEX_H) * 2;
          const dir = {
            x: b.fwd.x + (b.right.x * nx * texCamera.aspect) / texCamera.focal + (b.up.x * ny) / texCamera.focal,
            y: b.fwd.y + (b.right.y * nx * texCamera.aspect) / texCamera.focal + (b.up.y * ny) / texCamera.focal,
            z: b.fwd.z + (b.right.z * nx * texCamera.aspect) / texCamera.focal + (b.up.z * ny) / texCamera.focal,
          };
          if (dir.y >= 0) continue;
          const t = -texCamera.eye.y / dir.y;
          const wz = texCamera.eye.z + dir.z * t;
          if (wz < -400 || Math.abs(texCamera.eye.x + dir.x * t) > 800) continue;
          const wx = texCamera.eye.x + dir.x * t;
          sum += tex.texel(0, Math.floor((wx / TEX_REPEAT) * TEX_SIZE), Math.floor((wz / TEX_REPEAT) * TEX_SIZE))[0];
          hits++;
        }
      out[y * TEX_W + x] = hits ? sum / hits : 0;
    }
  refCache = out;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Texture memory: a 2048 × 2048 texture in different formats, with its mip chain.

export interface TexFormat {
  name: string;
  /** Block size in texels and bytes (1 × 1 for uncompressed). */
  bw: number;
  bh: number;
  bytes: number;
}
export const TEX_FORMATS: TexFormat[] = [
  { name: 'RGBA8 (uncompressed)', bw: 1, bh: 1, bytes: 4 },
  { name: 'BC1', bw: 4, bh: 4, bytes: 8 },
  { name: 'BC7', bw: 4, bh: 4, bytes: 16 },
  { name: 'ASTC 4 × 4', bw: 4, bh: 4, bytes: 16 },
  { name: 'ASTC 8 × 8', bw: 8, bh: 8, bytes: 16 },
];
/** Bytes for a w × h texture, optionally with every mip level (each level padded to whole blocks). */
export function textureBytes(w: number, h: number, f: TexFormat, mips: boolean): number {
  let total = 0;
  for (;;) {
    total += Math.ceil(w / f.bw) * Math.ceil(h / f.bh) * f.bytes;
    if (!mips || (w === 1 && h === 1)) break;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return total;
}
export const bitsPerTexel = (f: TexFormat) => (f.bytes * 8) / (f.bw * f.bh);
/** Decimal megabytes (10^6 bytes), the section's convention. */
export const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
