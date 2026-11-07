/**
 * "Forward, deferred and clustered": the CPU-side model of the lesson's frame. No DOM, no GPU.
 *
 * The light lists are built here, on the CPU (as Avalanche did in Just Cause 3, Persson 2015),
 * and uploaded for the GPU to read: a grid of cells (one cell for "no culling", 16 × 10 screen
 * tiles, or those tiles cut into 16 depth slices), each with an offset and a count into one list
 * of light indices. The same lists give the lesson's numbers: how many lights a pixel evaluates,
 * how long the lists are, how many bytes they take, alongside the G-buffer's bytes per pixel.
 *
 * The per-pixel numbers come from casting a ray through each pixel of a 320 × 200 image of the
 * courtyard (scenes/courtyard.ts), so they don't depend on the GPU.
 */
import { type V3, basis, v3 } from '../raster';
import { type FramePlan } from '../gpu/plan';
import { type PointLight } from '../gpu/scene';
import { COURTYARD_CAMERA, VIEW_H, VIEW_W, courtyardDraws, courtyardLights, toView, viewHits } from './courtyard';

export type Shading = 'forward' | 'deferred';
export type Culling = 'none' | 'tiles' | 'clusters';
export type ViewMode = 'lit' | 'heat' | 'albedo' | 'normal' | 'depth';

export interface FdcSettings {
  shading: Shading;
  culling: Culling;
  lights: number;
  view: ViewMode;
}
export const FDC_DEFAULTS: FdcSettings = { shading: 'deferred', culling: 'clusters', lights: 64, view: 'lit' };
export const LIGHT_STEPS = [1, 4, 16, 64, 128, 256];

// ---------------------------------------------------------------------------------------------
// The grid

export const TILES_X = 16;
export const TILES_Y = 10;
export const SLICES = 16;
/** Depth slices are spaced exponentially from ZC0 to ZC1 (closer than ZC0 goes in slice 0, farther than ZC1 in the last). */
export const ZC0 = 1;
export const ZC1 = 64;
/** slice = floor(log2(z / ZC0) · SLICE_SCALE), clamped: 16 slices over a factor of 64 = 2⁶. */
export const SLICE_SCALE = SLICES / Math.log2(ZC1 / ZC0);
export const sliceOf = (z: number) => Math.min(SLICES - 1, Math.max(0, Math.floor(Math.log2(z / ZC0) * SLICE_SCALE)));
/** The view depth where slice k starts (slice 0 starts at the near plane). */
export const sliceStart = (k: number) => (k === 0 ? COURTYARD_CAMERA.near : ZC0 * 2 ** (k / SLICE_SCALE));
export const sliceEnd = (k: number) => (k === SLICES - 1 ? COURTYARD_CAMERA.far : ZC0 * 2 ** ((k + 1) / SLICE_SCALE));

export interface Grid {
  tx: number;
  ty: number;
  slices: number;
}
export const gridOf = (c: Culling): Grid => (c === 'none' ? { tx: 1, ty: 1, slices: 1 } : c === 'tiles' ? { tx: TILES_X, ty: TILES_Y, slices: 1 } : { tx: TILES_X, ty: TILES_Y, slices: SLICES });
export const cellCount = (g: Grid) => g.tx * g.ty * g.slices;

/** The light-index texture is this wide; it has enough rows for every cell to hold every light. */
export const INDEX_W = 4096;
export const INDEX_H = (TILES_X * TILES_Y * SLICES * 256) / INDEX_W;
/** Bytes per cell (offset and count, two 32-bit integers) and per index (one 32-bit integer). */
export const CELL_BYTES = 8;
export const INDEX_BYTES = 4;

/**
 * Depth bounds of each screen tile (nearest and farthest surface, sky ignored), from a ray per
 * pixel at the canvas's logical size: what a tiled renderer reads from its depth buffer. Widened
 * by 1% so the GPU's own pixels, which may sit a little differently, stay inside.
 */
let bounds: Array<[number, number] | null> | null = null;
export function tileBounds(): Array<[number, number] | null> {
  if (bounds) return bounds;
  const hits = viewHits(VIEW_W, VIEW_H);
  const b: Array<[number, number] | null> = new Array(TILES_X * TILES_Y).fill(null);
  hits.forEach((h, i) => {
    if (!h) return;
    const x = i % VIEW_W;
    const y = Math.floor(i / VIEW_W);
    const t = Math.floor((x * TILES_X) / VIEW_W) + Math.floor((y * TILES_Y) / VIEW_H) * TILES_X;
    const cur = b[t];
    b[t] = cur ? [Math.min(cur[0], h.t), Math.max(cur[1], h.t)] : [h.t, h.t];
  });
  bounds = b.map((x) => (x ? [x[0] * 0.99, x[1] * 1.01] : null));
  return bounds;
}

/** Does a sphere (view space) touch the slab of tile columns i (or rows) between ndc a0..a1? */
function sideTest(c: number, z: number, r: number, a0: number, a1: number): boolean {
  // Planes through the eye: x = a·z. Inside the left one: (x − a0·z)/√(1+a0²) ≥ −r; the right: (a1·z − x)/√(1+a1²) ≥ −r.
  return (c - a0 * z) / Math.sqrt(1 + a0 * a0) >= -r && (a1 * z - c) / Math.sqrt(1 + a1 * a1) >= -r;
}

export interface LightLists {
  grid: Grid;
  /** Per cell: offset into `indices`, and count. Cell index = (i + j·tx) + k·tx·ty. */
  offset: Uint32Array;
  count: Uint32Array;
  indices: Uint32Array;
}

/** Assign lights to cells: a sphere (the light's radius) against each cell's planes and depth range. */
export function buildLists(lights: PointLight[], culling: Culling): LightLists {
  const g = gridOf(culling);
  const cells = cellCount(g);
  const per: number[][] = Array.from({ length: cells }, () => []);
  const cam = COURTYARD_CAMERA;
  const ax = cam.aspect / cam.focal;
  const ay = 1 / cam.focal;
  const tb = culling === 'tiles' ? tileBounds() : null;
  lights.forEach((l, li) => {
    if (culling === 'none') {
      per[0].push(li);
      return;
    }
    const c = toView(cam, l.pos);
    const r = l.radius;
    if (c.z + r < cam.near || c.z - r > cam.far) return;
    // Tile columns and rows the sphere touches (ndc x runs left to right, tile rows top to bottom).
    const cols: number[] = [];
    for (let i = 0; i < g.tx; i++) if (sideTest(c.x, c.z, r, (-1 + (2 * i) / g.tx) * ax, (-1 + (2 * (i + 1)) / g.tx) * ax)) cols.push(i);
    const rows: number[] = [];
    for (let j = 0; j < g.ty; j++) if (sideTest(c.y, c.z, r, (1 - (2 * (j + 1)) / g.ty) * ay, (1 - (2 * j) / g.ty) * ay)) rows.push(j);
    for (const j of rows)
      for (const i of cols) {
        const t = i + j * g.tx;
        if (tb) {
          const b = tb[t];
          if (b && c.z + r >= b[0] && c.z - r <= b[1]) per[t].push(li);
          continue;
        }
        for (let k = 0; k < g.slices; k++) if (c.z + r >= sliceStart(k) && c.z - r <= sliceEnd(k)) per[t + k * g.tx * g.ty].push(li);
      }
  });
  const offset = new Uint32Array(cells);
  const count = new Uint32Array(cells);
  let n = 0;
  per.forEach((p, i) => {
    offset[i] = n;
    count[i] = p.length;
    n += p.length;
  });
  const indices = new Uint32Array(n);
  per.forEach((p, i) => indices.set(p, offset[i]));
  return { grid: g, offset, count, indices };
}

/** The cell a view sample falls in: pixel (x, y) of a w × h image at view depth z. */
export function cellOf(g: Grid, x: number, y: number, w: number, h: number, z: number): number {
  const i = Math.min(g.tx - 1, Math.floor(((x + 0.5) * g.tx) / w));
  const j = Math.min(g.ty - 1, Math.floor(((y + 0.5) * g.ty) / h));
  const k = g.slices === 1 ? 0 : sliceOf(z);
  return i + j * g.tx + k * g.tx * g.ty;
}

// ---------------------------------------------------------------------------------------------
// The numbers the lesson quotes

/** The model's image: a ray per pixel at a quarter of the canvas's logical width and height... */
export const MODEL_W = 320;
export const MODEL_H = 200;
let modelHits: ReturnType<typeof viewHits> | null = null;
const hits = () => (modelHits ??= viewHits(MODEL_W, MODEL_H));

export interface ListStats {
  cells: number;
  /** Cells with at least one light. */
  used: number;
  entries: number;
  maxPerCell: number;
  /** Bytes of the grid and the index list. */
  bytes: number;
  /** Pixels that see a surface (not sky), in the model's image. */
  covered: number;
  /** Lights evaluated per covered pixel, on average, and at the worst pixel. */
  perPixel: number;
  worstPixel: number;
  /** Lights that actually reach the pixel (closer than their radius), on average. */
  reaching: number;
}

export function listStats(lights: PointLight[], culling: Culling, lists = buildLists(lights, culling), withReach = true): ListStats {
  const g = lists.grid;
  let covered = 0;
  let evals = 0;
  let worst = 0;
  let reach = 0;
  hits().forEach((h, i) => {
    if (!h) return;
    covered++;
    const n = lists.count[cellOf(g, i % MODEL_W, Math.floor(i / MODEL_W), MODEL_W, MODEL_H, h.t)];
    evals += n;
    worst = Math.max(worst, n);
    if (withReach)
      for (const l of lights) {
      const dx = l.pos.x - h.p.x;
      const dy = l.pos.y - h.p.y;
      const dz = l.pos.z - h.p.z;
      if (dx * dx + dy * dy + dz * dz < l.radius * l.radius) reach++;
    }
  });
  const used = Array.from(lists.count).filter((c) => c > 0).length;
  return {
    cells: lists.count.length,
    used,
    entries: lists.indices.length,
    maxPerCell: Math.max(...lists.count),
    bytes: lists.count.length * CELL_BYTES + lists.indices.length * INDEX_BYTES,
    covered,
    perPixel: evals / covered,
    worstPixel: worst,
    reaching: reach / covered,
  };
}

/** Cells that hold a light but no surface any pixel of the model's image sees: lights assigned for nothing. */
export function emptyCellsWithLights(lights: PointLight[], culling: Culling): { occupied: number; wasted: number } {
  const lists = buildLists(lights, culling);
  const occ = new Uint8Array(lists.count.length);
  hits().forEach((h, i) => {
    if (h) occ[cellOf(lists.grid, i % MODEL_W, Math.floor(i / MODEL_W), MODEL_W, MODEL_H, h.t)] = 1;
  });
  let wasted = 0;
  lists.count.forEach((c, i) => {
    if (c > 0 && !occ[i]) wasted++;
  });
  return { occupied: occ.reduce((a, b) => a + b, 0), wasted };
}

/** Lights that miss every pixel and still get evaluated: a check that culling never drops a light a pixel needs. */
export function missedLights(lights: PointLight[], culling: Culling): number {
  const lists = buildLists(lights, culling);
  let missed = 0;
  hits().forEach((h, i) => {
    if (!h) return;
    const c = cellOf(lists.grid, i % MODEL_W, Math.floor(i / MODEL_W), MODEL_W, MODEL_H, h.t);
    const inList = new Set(lists.indices.subarray(lists.offset[c], lists.offset[c] + lists.count[c]));
    lights.forEach((l, li) => {
      const dx = l.pos.x - h.p.x;
      const dy = l.pos.y - h.p.y;
      const dz = l.pos.z - h.p.z;
      if (dx * dx + dy * dy + dz * dz < l.radius * l.radius && !inList.has(li)) missed++;
    });
  });
  return missed;
}

// ---------------------------------------------------------------------------------------------
// The G-buffer

export interface GTarget {
  name: string;
  /** WebGPU format; the WebGL2 internal format is in `gl`. */
  format: string;
  gl: string;
  bytes: number;
  holds: string;
}
export const GBUFFER: GTarget[] = [
  { name: 'albedo', format: 'rgba8unorm', gl: 'RGBA8', bytes: 4, holds: 'base colour in RGB (A unused)' },
  { name: 'normal', format: 'rgb10a2unorm', gl: 'RGB10_A2', bytes: 4, holds: 'the normal, 10 bits per axis' },
  { name: 'depth', format: 'depth24plus', gl: 'DEPTH_COMPONENT24', bytes: 4, holds: 'depth, to rebuild the position' },
];
export const GBUFFER_BYTES = GBUFFER.reduce((s, t) => s + t.bytes, 0);
/** The lit output: the canvas, 8 bits per channel. */
export const OUTPUT_BYTES = 4;

/**
 * Bytes written and read per pixel, ignoring caches, compression and overdraw: forward writes
 * colour and depth once; deferred writes the G-buffer, reads it back in the lighting pass, and
 * writes the colour.
 */
export function bytesPerPixel(s: Shading): number {
  return s === 'forward' ? OUTPUT_BYTES + 4 : GBUFFER_BYTES * 2 + OUTPUT_BYTES;
}
export const mb = (bytes: number) => bytes / (1024 * 1024);

// ---------------------------------------------------------------------------------------------
// The frame as the renderers draw it

export const FORWARD = 'forward';
export const GBUFFER_PASS = 'G-buffer';
export const LIGHTING = 'lighting';
export const FDC_PIPELINES = [FORWARD, GBUFFER_PASS, LIGHTING];

export const fdcDraws = () => courtyardDraws();

export function fdcPlan(s: FdcSettings, canvasW: number, canvasH: number): FramePlan {
  const draws = fdcDraws();
  const scene = (pipeline: string) => draws.map((d) => ({ name: d.name, pipeline, indexed: true, count: d.mesh.indexCount, instances: 1 }));
  if (s.shading === 'forward')
    return { passes: [{ name: 'forward', target: `colour + depth, ${canvasW} × ${canvasH}`, w: canvasW, h: canvasH, draws: scene(FORWARD) }] };
  return {
    passes: [
      { name: 'G-buffer', target: `albedo + normal + depth, ${canvasW} × ${canvasH}`, w: canvasW, h: canvasH, draws: scene(GBUFFER_PASS) },
      { name: 'lighting', target: 'the canvas', w: 0, h: 0, draws: [{ name: 'full-screen triangle', pipeline: LIGHTING, indexed: false, count: 3, instances: 1 }] },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Lights, moving or not

/** The lights at time t (seconds): each drifts round a small circle; t = 0 is where the lesson's numbers come from. */
export function lightsAt(n: number, t: number): PointLight[] {
  const ls = courtyardLights(n);
  if (t === 0) return ls;
  return ls.map((l, i) => {
    const a = t * (0.4 + (i % 5) * 0.1) + i;
    return { ...l, pos: v3(l.pos.x + 0.8 * Math.sin(a), l.pos.y, l.pos.z + 0.8 * Math.cos(a)) };
  });
}

/** For the top-down view: a point's view-space x and z. */
export function viewXZ(p: V3): { x: number; z: number } {
  const v = toView(COURTYARD_CAMERA, p);
  return { x: v.x, z: v.z };
}
export const camBasis = () => basis(COURTYARD_CAMERA);

/** Heat colours for a light count, as the shaders and the legend use them: 0, 1, 4, 16, 64+ lights. */
export const HEAT_STOPS: Array<[number, [number, number, number]]> = [
  [0, [0.05, 0.06, 0.1]],
  [1, [0.1, 0.25, 0.6]],
  [4, [0.1, 0.65, 0.55]],
  [16, [0.95, 0.8, 0.2]],
  [64, [0.95, 0.2, 0.15]],
];
