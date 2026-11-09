/**
 * "Physically based shading": the BRDF the shaders use, written once more in TypeScript so the
 * widget's plots and the lesson's numbers come from the same formulas, plus the two tables the
 * GPU reads for image-based lighting, computed here: the split-sum BRDF table (Karis 2013) and the
 * environment prefiltered for each roughness. No DOM, no GPU.
 *
 * The model is UE4's, as Karis's course notes give it: Lambert diffuse, a GGX (Trowbridge-Reitz)
 * distribution with α = roughness², Smith's geometry term in Schlick's form with
 * k = (roughness + 1)² / 8 for lights (k = α / 2 for the environment), and Schlick's Fresnel.
 * Metalness picks between a dielectric (F0 from "reflectance", diffuse = base colour) and a metal
 * (F0 = base colour, no diffuse).
 */
import { type Camera, v3 } from '../raster';
import { type FramePlan } from '../gpu/plan';
import { type GpuMesh, KEY_LIGHT, gpuMesh, viewProj } from '../gpu/scene';
import { type RGB, toLinear } from './courtyard';

// ---------------------------------------------------------------------------------------------
// The BRDF

/** Below this roughness GGX's peak gets too narrow for the shaders' precision; they clamp to it. */
export const MIN_ROUGHNESS = 0.05;
export const alphaOf = (roughness: number) => Math.max(MIN_ROUGHNESS, roughness) ** 2;

/** GGX / Trowbridge-Reitz normal distribution: α² / (π ((n·h)²(α² − 1) + 1)²). */
export function dGgx(nh: number, a: number): number {
  const a2 = a * a;
  const d = nh * nh * (a2 - 1) + 1;
  return a2 / (Math.PI * d * d);
}
/** Schlick's form of one Smith term: n·v / (n·v (1 − k) + k). */
export const g1 = (nx: number, k: number) => nx / (nx * (1 - k) + k);
/** k for analytic lights (Karis's remapping) and for image-based lighting. */
export const kLight = (roughness: number) => (Math.max(MIN_ROUGHNESS, roughness) + 1) ** 2 / 8;
export const kIbl = (roughness: number) => alphaOf(roughness) / 2;
/** Schlick's Fresnel: F0 + (1 − F0)(1 − v·h)⁵. */
export const fresnel = (f0: number, vh: number) => f0 + (1 - f0) * (1 - vh) ** 5;

/**
 * The specular BRDF, D·F·G / (4 (n·l)(n·v)), for directions in the plane of incidence given by
 * their angles from the normal (radians; l on the opposite side from v is positive).
 */
export function specular(thetaV: number, thetaL: number, roughness: number, f0: number, k = kLight(roughness)): number {
  const nv = Math.cos(thetaV);
  const nl = Math.cos(thetaL);
  if (nv <= 0 || nl <= 0) return 0;
  // In the plane: v = (−sin θv, cos θv), l = (sin θl, cos θl), h = normalise(v + l).
  const hx = -Math.sin(thetaV) + Math.sin(thetaL);
  const hy = nv + nl;
  const len = Math.sqrt(hx * hx + hy * hy);
  const nh = hy / len;
  const vh = (-Math.sin(thetaV) * hx + nv * hy) / len;
  const a = alphaOf(roughness);
  return (dGgx(nh, a) * fresnel(f0, vh) * g1(nv, k) * g1(nl, k)) / (4 * nl * nv);
}

// ---------------------------------------------------------------------------------------------
// Sampling (Karis's course notes, "Image based lighting")

/** The i-th of n Hammersley points: (i/n, radical inverse of i in base 2). */
export function hammersley(i: number, n: number): [number, number] {
  let b = i >>> 0;
  b = ((b << 16) | (b >>> 16)) >>> 0;
  b = (((b & 0x55555555) << 1) | ((b & 0xaaaaaaaa) >>> 1)) >>> 0;
  b = (((b & 0x33333333) << 2) | ((b & 0xcccccccc) >>> 2)) >>> 0;
  b = (((b & 0x0f0f0f0f) << 4) | ((b & 0xf0f0f0f0) >>> 4)) >>> 0;
  b = (((b & 0x00ff00ff) << 8) | ((b & 0xff00ff00) >>> 8)) >>> 0;
  return [i / n, b / 4294967296];
}
/** A half vector drawn in proportion to D(h)(n·h), in the frame where n = +z. */
export function sampleGgx(u: [number, number], a: number): [number, number, number] {
  const phi = 2 * Math.PI * u[0];
  const cosT = Math.sqrt((1 - u[1]) / (1 + (a * a - 1) * u[1]));
  const sinT = Math.sqrt(1 - cosT * cosT);
  return [sinT * Math.cos(phi), sinT * Math.sin(phi), cosT];
}

/** Samples per entry of the BRDF table, as in Karis's code. */
export const LUT_SAMPLES = 1024;
/**
 * The split sum's second factor for one roughness and n·v: the specular BRDF integrated against a
 * constant white environment, split into a scale and a bias on F0: ∫ f cos = F0·A + B.
 */
export function envBrdf(roughness: number, nv: number, samples = LUT_SAMPLES): [number, number] {
  const v = [Math.sqrt(1 - nv * nv), 0, nv];
  const a = alphaOf(roughness);
  const k = kIbl(roughness);
  let A = 0;
  let B = 0;
  for (let i = 0; i < samples; i++) {
    const hv = sampleGgx(hammersley(i, samples), a);
    const vh = v[0] * hv[0] + v[2] * hv[2];
    const lz = 2 * vh * hv[2] - v[2];
    if (lz <= 0) continue;
    const nh = hv[2];
    const gVis = (g1(nv, k) * g1(lz, k) * vh) / (nh * nv);
    const fc = (1 - vh) ** 5;
    A += (1 - fc) * gVis;
    B += fc * gVis;
  }
  return [A / samples, B / samples];
}

export const LUT_SIZE = 32;
/** The table the shaders read: LUT_SIZE × LUT_SIZE, x = n·v, y = roughness (texel centres), RG = (A, B). */
export function brdfTable(size = LUT_SIZE, samples = LUT_SAMPLES): Float32Array {
  const out = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const [A, B] = envBrdf((y + 0.5) / size, (x + 0.5) / size, samples);
      out.set([A, B, 0, 1], (y * size + x) * 4);
    }
  return out;
}

/** The white furnace for the specular lobe alone: what fraction of light a white (F = 1) GGX surface reflects. */
export const specAlbedo = (roughness: number, nv: number) => {
  const [A, B] = envBrdf(roughness, nv);
  return A + B;
};
/** The same for a whole material lit by a white environment: diffuse (base × (1 − metal)) plus specular (F0·A + B). */
export function materialAlbedo(base: number, metal: number, reflectance: number, roughness: number, nv: number): number {
  const [A, B] = envBrdf(roughness, nv);
  const f0 = reflectance + (base - reflectance) * metal;
  return base * (1 - metal) + f0 * A + B;
}

/** ∫ D(h)(n·h) dω over the hemisphere, by a midpoint rule in θ (D is isotropic): 1 for a normalised distribution. */
export function dNormalisation(roughness: number, steps = 20000): number {
  const a = alphaOf(roughness);
  let s = 0;
  for (let i = 0; i < steps; i++) {
    const t = ((i + 0.5) / steps) * (Math.PI / 2);
    s += dGgx(Math.cos(t), a) * Math.cos(t) * Math.sin(t);
  }
  return s * (Math.PI / 2 / steps) * 2 * Math.PI;
}
/** ∫ (1/π) cos θ dω: Lambert's 1/π is what makes a white diffuse surface reflect exactly what arrives. */
export function lambertAlbedo(steps = 20000): number {
  let s = 0;
  for (let i = 0; i < steps; i++) {
    const t = ((i + 0.5) / steps) * (Math.PI / 2);
    s += (1 / Math.PI) * Math.cos(t) * Math.sin(t);
  }
  return s * (Math.PI / 2 / steps) * 2 * Math.PI;
}

// ---------------------------------------------------------------------------------------------
// Materials

export interface Material {
  name: string;
  /** sRGB-encoded base colour 0–255, as an artist would pick it; metals' come from Hoffman's linear F0 table. */
  base: RGB;
  metal: number;
  roughness: number;
  /** A dielectric's F0 (ignored for metals). */
  reflectance: number;
}
const srgb8 = (lin: RGB): RGB => lin.map((x) => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055))) as RGB;
/** Metals' F0, linear, from Hoffman's "Physics and Math of Shading" (SIGGRAPH 2013 course notes), Table 1. */
export const METAL_F0: Record<string, RGB> = {
  gold: [1.0, 0.71, 0.29],
  copper: [0.95, 0.64, 0.54],
  iron: [0.56, 0.57, 0.58],
  aluminium: [0.91, 0.92, 0.92],
  silver: [0.95, 0.93, 0.88],
};
export const MATERIALS: Material[] = [
  { name: 'Red plastic', base: [200, 30, 30], metal: 0, roughness: 0.35, reflectance: 0.04 },
  { name: 'White', base: [255, 255, 255], metal: 0, roughness: 0.5, reflectance: 0.04 },
  { name: 'Gold', base: srgb8(METAL_F0.gold), metal: 1, roughness: 0.25, reflectance: 0.04 },
  { name: 'Copper', base: srgb8(METAL_F0.copper), metal: 1, roughness: 0.35, reflectance: 0.04 },
  { name: 'Iron', base: srgb8(METAL_F0.iron), metal: 1, roughness: 0.5, reflectance: 0.04 },
  { name: 'Silver', base: srgb8(METAL_F0.silver), metal: 1, roughness: 0.15, reflectance: 0.04 },
];
export const linearBase = (m: Material): RGB => toLinear(m.base);

// ---------------------------------------------------------------------------------------------
// The environment: a sky, a ground and two bright windows, in linear radiance

export const ENV_W = 64;
export const ENV_H = 32;
/** Prefiltered levels for roughness 0, 0.25, 0.5, 0.75, 1, then one band of diffuse irradiance. */
export const ENV_LEVELS = 5;
export const ENV_BANDS = ENV_LEVELS + 1;

export function environment(d: [number, number, number]): RGB {
  const [x, y, z] = d;
  let c: RGB;
  if (y >= 0) {
    const t = Math.sqrt(y);
    c = [0.9 + (0.25 - 0.9) * t, 0.95 + (0.4 - 0.95) * t, 1.05 + (0.75 - 1.05) * t];
  } else {
    const t = Math.min(1, -y * 4);
    c = [0.35 + (0.12 - 0.35) * t, 0.32 + (0.1 - 0.32) * t, 0.3 + (0.09 - 0.3) * t];
  }
  // Two windows: one up and to the left behind the camera's shoulder, one to the right.
  const win = (cx: number, cy: number, cz: number, size: number, power: number) => {
    const l = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const dot = (x * cx + y * cy + z * cz) / l;
    // A soft edge, so prefiltering with a few hundred samples doesn't alias.
    return power * Math.min(1, Math.max(0, (dot - (1 - size)) / (size * 0.6)));
  };
  const w = win(-0.6, 0.7, 0.5, 0.06, 8) + win(0.9, 0.25, -0.3, 0.03, 6);
  return [c[0] + w, c[1] + w, c[2] + w];
}

/** The direction of the centre of texel (x, y) of a w × h equirectangular map: u around the vertical, v from the top. */
export function equirectDir(x: number, y: number, w: number, h: number): [number, number, number] {
  const phi = ((x + 0.5) / w - 0.5) * 2 * Math.PI;
  const th = ((y + 0.5) / h) * Math.PI;
  return [Math.sin(th) * Math.sin(phi), Math.cos(th), -Math.sin(th) * Math.cos(phi)];
}

function frame(n: [number, number, number]): [[number, number, number], [number, number, number]] {
  const up: [number, number, number] = Math.abs(n[1]) < 0.999 ? [0, 1, 0] : [1, 0, 0];
  let tx = up[1] * n[2] - up[2] * n[1];
  let ty = up[2] * n[0] - up[0] * n[2];
  let tz = up[0] * n[1] - up[1] * n[0];
  const l = Math.sqrt(tx * tx + ty * ty + tz * tz);
  tx /= l;
  ty /= l;
  tz /= l;
  return [
    [tx, ty, tz],
    [n[1] * tz - n[2] * ty, n[2] * tx - n[0] * tz, n[0] * ty - n[1] * tx],
  ];
}

/**
 * The environment prefiltered for each level's roughness with n = v = r (Karis's assumption), plus
 * a band of cosine-weighted irradiance / π for diffuse: ENV_W × (ENV_H · ENV_BANDS) RGBA floats.
 */
export function prefilteredEnvironment(samples = 256): Float32Array {
  const out = new Float32Array(ENV_W * ENV_H * ENV_BANDS * 4);
  for (let band = 0; band < ENV_BANDS; band++)
    for (let y = 0; y < ENV_H; y++)
      for (let x = 0; x < ENV_W; x++) {
        const n = equirectDir(x, y, ENV_W, ENV_H);
        const [t, b] = frame(n);
        let c: RGB = [0, 0, 0];
        let wsum = 0;
        if (band < ENV_LEVELS) {
          const a = alphaOf(band / (ENV_LEVELS - 1));
          for (let i = 0; i < samples; i++) {
            const h = sampleGgx(hammersley(i, samples), a);
            const hw = [t[0] * h[0] + b[0] * h[1] + n[0] * h[2], t[1] * h[0] + b[1] * h[1] + n[1] * h[2], t[2] * h[0] + b[2] * h[1] + n[2] * h[2]];
            const vh = h[2];
            const l: [number, number, number] = [2 * vh * hw[0] - n[0], 2 * vh * hw[1] - n[1], 2 * vh * hw[2] - n[2]];
            const nl = l[0] * n[0] + l[1] * n[1] + l[2] * n[2];
            if (nl <= 0) continue;
            const e = environment(l);
            c = [c[0] + e[0] * nl, c[1] + e[1] * nl, c[2] + e[2] * nl];
            wsum += nl;
          }
        } else {
          // Cosine-weighted hemisphere: directions from the Hammersley points.
          for (let i = 0; i < samples; i++) {
            const [u1, u2] = hammersley(i, samples);
            const r = Math.sqrt(u2);
            const phi = 2 * Math.PI * u1;
            const lx = r * Math.cos(phi);
            const ly = r * Math.sin(phi);
            const lz = Math.sqrt(Math.max(0, 1 - u2));
            const l: [number, number, number] = [t[0] * lx + b[0] * ly + n[0] * lz, t[1] * lx + b[1] * ly + n[1] * lz, t[2] * lx + b[2] * ly + n[2] * lz];
            const e = environment(l);
            c = [c[0] + e[0], c[1] + e[1], c[2] + e[2]];
            wsum += 1;
          }
        }
        out.set([c[0] / wsum, c[1] / wsum, c[2] / wsum, 1], ((band * ENV_H + y) * ENV_W + x) * 4);
      }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The spheres and the frame

/** A sphere as a subdivided cube pushed out to radius 1 (sqrt only): 6 faces of n × n quads. */
export function sphereMesh(n = 16): GpuMesh {
  const positions: ReturnType<typeof v3>[] = [];
  const indices: number[] = [];
  const faces: Array<[number[], number[], number[]]> = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [o, u, w] of faces) {
    const base = positions.length;
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const a = (2 * i) / n - 1;
        const b = (2 * j) / n - 1;
        const p = [o[0] + u[0] * a + w[0] * b, o[1] + u[1] * a + w[1] * b, o[2] + u[2] * a + w[2] * b];
        const l = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
        positions.push(v3(p[0] / l, p[1] / l, p[2] / l));
      }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const q = base + j * (n + 1) + i;
        indices.push(q, q + 1, q + n + 2, q, q + n + 2, q + n + 1);
      }
  }
  // Normals from the triangles (the sphere's own normal, closely).
  return gpuMesh('sphere', { positions, attrs: positions.map(() => [0, 0]), indices });
}

export type BallLayout = 'grid' | 'one';
export const GRID_COLS = 5;
export const GRID_ROWS = 2;
/** The grid: roughness 0, 0.25 … 1 across; a dielectric row above a metal row. */
export const gridRoughness = (i: number) => (i % GRID_COLS) / (GRID_COLS - 1);
export const gridMetal = (i: number) => Math.floor(i / GRID_COLS);

export const PBR_W = 640;
export const PBR_H = 400;
export const PBR_CAMERA: Camera = { eye: v3(0, 0.3, 3.9), target: v3(0, 0, 0), focal: 1.5, aspect: PBR_W / PBR_H, near: 0.1, far: 30, reverseZ: false };
export const pbrViewProj = () => viewProj(PBR_CAMERA);
/** The key light: the concept lessons' direction, as a sun of this illuminance (n·l = 1 gives this much). */
export const SUN = { dir: KEY_LIGHT.dir, intensity: 3 };

export type PbrView = 'full' | 'diffuse' | 'specular';
export interface PbrSettings {
  layout: BallLayout;
  material: number;
  metal: number;
  roughness: number;
  reflectance: number;
  direct: boolean;
  ibl: boolean;
  view: PbrView;
}
export const PBR_DEFAULTS: PbrSettings = { layout: 'grid', material: 0, ...pick(0), direct: true, ibl: true, view: 'full' };
function pick(i: number) {
  const m = MATERIALS[i];
  return { metal: m.metal, roughness: m.roughness, reflectance: m.reflectance };
}

export const SKY_PIPE = 'sky';
export const BALL_PIPE = 'spheres';
export function pbrPlan(s: PbrSettings, w: number, h: number): FramePlan {
  const n = sphereMesh().indexCount;
  return {
    passes: [
      {
        name: 'shade',
        target: `the canvas + depth, ${w} × ${h}`,
        w,
        h,
        draws: [
          { name: 'environment', pipeline: SKY_PIPE, indexed: false, count: 3, instances: 1 },
          { name: s.layout === 'grid' ? `${GRID_COLS * GRID_ROWS} spheres` : 'sphere', pipeline: BALL_PIPE, indexed: true, count: n, instances: s.layout === 'grid' ? GRID_COLS * GRID_ROWS : 1 },
        ],
      },
    ],
  };
}

/** A 32-bit float to IEEE half (for rgba16float uploads on WebGPU). */
export function toHalf(f: number): number {
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, f);
  const x = b.getUint32(0);
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  if (e >= 31) return sign | 0x7c00;
  const r = sign | (e << 10) | (m >> 13);
  return (m & 0x1000) ? r + 1 : r;
}
export const halves = (f: Float32Array) => Uint16Array.from(f, toHalf);
