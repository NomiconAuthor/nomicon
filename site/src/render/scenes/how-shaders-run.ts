/**
 * The shader-execution lesson's models. Three of them:
 *
 * - Waves: a floor under a spotlight, rasterised in 2 × 2 quads; the quads are packed into waves
 *   of 32 or 64 lanes in the order they're launched, and a small pixel shader with a branch (lit
 *   or not) is stepped an instruction at a time with an execution mask.
 * - Quads: one 32 × 32-pixel square cut into ever smaller triangles, counting the lanes the quads
 *   run against the pixels they shade.
 * - Occupancy: how many waves fit on a SIMD for a register count (RDNA 3's numbers), and a toy
 *   latency model of what that does to a shader that waits on memory.
 *
 * All deterministic: the claims rerun them in Node.
 */
import { type Camera, type Draw, type Mesh, type QuadStep, DEFAULTS, Target, emptyStats, render, v3 } from '../raster';
import { floor } from './common';

// ---------------------------------------------------------------------------------------------
// Waves and divergence

export const WAVE_W = 96;
export const WAVE_H = 60;
/** The spotlight's centre on the floor and its radius, in metres. */
export const LIGHT_X = 0.8;
export const LIGHT_Z = -2.6;
export const LIGHT_R = 2.4;
export const waveCamera: Camera = { eye: v3(0, 3, 3), target: v3(0, 0, -4), focal: 1.4, aspect: WAVE_W / WAVE_H, near: 0.1, far: 100, reverseZ: false };

/** The floor, with world x and z as its attributes (floor() gives them in metres for tile 1). */
export function waveScene(): Draw[] {
  return [{ name: 'floor', mesh: floor(-10, 10, 4, -16, 0, 1), color: '--c1', shade: (a) => (lit(a) ? 1 : 0.3) }];
}
export const lit = (a: number[]) => (a[0] - LIGHT_X) ** 2 + (a[1] - LIGHT_Z) ** 2 < LIGHT_R * LIGHT_R;

/** The pixel shader, as the instructions a wave issues. `side`: which lanes run it. */
export interface Instr {
  text: string;
  side: 'all' | 'then' | 'else' | 'branch';
}
export const PROGRAM: Instr[] = [
  { text: 'p = interpolated world position', side: 'all' },
  { text: 'd = distance(p, light.pos)', side: 'all' },
  { text: 'if (d < light.radius) {', side: 'branch' },
  { text: '  l = normalize(light.pos − p)', side: 'then' },
  { text: '  diffuse = albedo · dot(n, l) · (1 − d / light.radius)', side: 'then' },
  { text: '  spec = pow(saturate(dot(reflect(−l, n), v)), 32)', side: 'then' },
  { text: '  c = diffuse + spec', side: 'then' },
  { text: '} else {', side: 'branch' },
  { text: '  c = albedo · ambient', side: 'else' },
  { text: '}', side: 'branch' },
  { text: 'out = c', side: 'all' },
];

export type LaneKind = 'pixel' | 'helper' | 'empty';
export interface Lane {
  kind: LaneKind;
  x: number;
  y: number;
  /** Takes the "then" side (lit). Helpers follow the same branch as their pixel would, and run too. */
  lit: boolean;
}
export interface Wave {
  lanes: Lane[];
  quads: Array<{ x: number; y: number }>;
}

/** Rasterise in quads and pack them into waves of `size` lanes, in launch order. */
export function buildWaves(size: 32 | 64): { waves: Wave[]; target: Target } {
  const target = new Target(WAVE_W, WAVE_H);
  const quads: QuadStep[] = [];
  for (const st of render(waveScene(), target, waveCamera, { ...DEFAULTS, quads: true }, emptyStats())) if (st.kind === 'quad') quads.push(st);
  const waves: Wave[] = [];
  const per = size / 4;
  for (let i = 0; i < quads.length; i += per) {
    const w: Wave = { lanes: [], quads: [] };
    for (const q of quads.slice(i, i + per)) {
      w.quads.push({ x: q.x, y: q.y });
      q.lanes.forEach((st, l) => {
        // Every lane of a launched quad runs; one outside the target still occupies its lane.
        const x = q.x + (l & 1);
        const y = q.y + (l >> 1);
        const isPixel = !!(q.active & (1 << l));
        w.lanes.push({ kind: isPixel ? 'pixel' : 'helper', x, y, lit: st ? lit(st.attrs) : false });
      });
    }
    while (w.lanes.length < size) w.lanes.push({ kind: 'empty', x: -1, y: -1, lit: false });
    waves.push(w);
  }
  return { waves, target };
}

/** Run one wave: which instructions it issues, and for each, the mask of lanes that execute it. */
export function runWave(w: Wave): Array<{ pc: number; mask: boolean[] }> {
  const live = w.lanes.map((l) => l.kind !== 'empty');
  const then = w.lanes.map((l, i) => live[i] && l.lit);
  const els = w.lanes.map((l, i) => live[i] && !l.lit);
  const anyThen = then.some(Boolean);
  const anyElse = els.some(Boolean);
  const out: Array<{ pc: number; mask: boolean[] }> = [];
  PROGRAM.forEach((ins, pc) => {
    if (ins.side === 'all') out.push({ pc, mask: live });
    else if (ins.side === 'then' && anyThen) out.push({ pc, mask: then });
    else if (ins.side === 'else' && anyElse) out.push({ pc, mask: els });
  });
  return out;
}

export interface WaveCost {
  /** Instructions issued, and lane-slots: issued × wave size. */
  issued: number;
  slots: number;
  /** Lane-slots doing work for a real pixel; helpers' and idle lanes' are the rest. */
  useful: number;
  helper: number;
  divergent: boolean;
}
export function waveCost(w: Wave): WaveCost {
  const run = runWave(w);
  let useful = 0;
  let helper = 0;
  for (const r of run)
    r.mask.forEach((on, i) => {
      if (!on) return;
      if (w.lanes[i].kind === 'pixel') useful++;
      else helper++;
    });
  const live = w.lanes.filter((l) => l.kind !== 'empty');
  return { issued: run.length, slots: run.length * w.lanes.length, useful, helper, divergent: live.some((l) => l.lit) && live.some((l) => !l.lit) };
}

/** Totals over the frame for one wave size. */
export function frameWaves(size: 32 | 64): { waves: number; divergent: number; issued: number; useful: number; slots: number; pixels: number } {
  const { waves } = buildWaves(size);
  let divergent = 0;
  let issued = 0;
  let useful = 0;
  let slots = 0;
  let pixels = 0;
  for (const w of waves) {
    const c = waveCost(w);
    if (c.divergent) divergent++;
    issued += c.issued;
    useful += c.useful;
    slots += c.slots;
    pixels += w.lanes.filter((l) => l.kind === 'pixel').length;
  }
  return { waves: waves.length, divergent, issued, useful, slots, pixels };
}
/** Instructions a wave issues with every lane on one side, and with lanes on both sides. */
export const ISSUED_LIT = PROGRAM.filter((i) => i.side === 'all' || i.side === 'then').length;
export const ISSUED_UNLIT = PROGRAM.filter((i) => i.side === 'all' || i.side === 'else').length;
export const ISSUED_BOTH = PROGRAM.filter((i) => i.side !== 'branch').length;

// ---------------------------------------------------------------------------------------------
// Tiny triangles: one square, cut finer and finer.

export const QUAD_W = 40;
export const QUAD_H = 40;
/** The square: 32 × 32 pixels from (4, 4). */
export const PATCH = { x: 4, y: 4, s: 32 };
export const CUTS = [1, 2, 4, 8, 16, 32] as const;

/** A small integer hash, for a deterministic wobble of the inner vertices. */
function hash(i: number): number {
  let x = (i + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/**
 * The square as an n × n grid of cells, two triangles each, sharing vertices (so the top-left
 * rule shades every pixel once). Inner vertices are nudged by up to a quarter cell so triangle
 * edges don't line up with the quads.
 */
export function patchMesh(n: number): Mesh {
  const m: Mesh = { positions: [], attrs: [], indices: [] };
  const c = PATCH.s / n;
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const inner = i > 0 && i < n && j > 0 && j < n;
      const ox = inner ? (hash(j * 97 + i) - 0.5) * 0.5 * c : 0;
      const oy = inner ? (hash(j * 97 + i + 5000) - 0.5) * 0.5 * c : 0;
      m.positions.push(v3(PATCH.x + i * c + ox, PATCH.y + j * c + oy, 0.5));
      m.attrs.push([(i + j) & 1]);
    }
  const id = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      m.indices.push(id(i, j), id(i + 1, j), id(i + 1, j + 1));
      m.indices.push(id(i, j), id(i + 1, j + 1), id(i, j + 1));
    }
  return m;
}
export const quadCamera: Camera = { eye: v3(0, 0, 0), target: v3(0, 0, 1), focal: 1, aspect: 1, near: 0, far: 1, reverseZ: false, screen: { w: QUAD_W, h: QUAD_H } };

export interface QuadCount {
  triangles: number;
  /** Triangles that cover no pixel centre at all. */
  empty: number;
  pixels: number;
  quads: number;
  lanes: number;
  helpers: number;
  /** Waves of 32 lanes, packing quads from any triangle. */
  waves: number;
  /** Per 2 × 2 block of the target: how many quads were launched there. */
  perBlock: Uint16Array;
  quadList: QuadStep[];
  /** Per pixel: the triangle that shaded it, or −1. */
  triOf: Int32Array;
  target: Target;
}
export function quadCount(n: number): QuadCount {
  const target = new Target(QUAD_W, QUAD_H);
  const stats = emptyStats();
  const mesh = patchMesh(n);
  const draws: Draw[] = [{ name: 'square', mesh, color: '--c2', twoSided: true, shade: () => 1 }];
  const perBlock = new Uint16Array((QUAD_W / 2) * (QUAD_H / 2));
  const quadList: QuadStep[] = [];
  const triPixels = new Map<number, number>();
  const triOf = new Int32Array(QUAD_W * QUAD_H).fill(-1);
  for (const st of render(draws, target, quadCamera, { ...DEFAULTS, depthTest: false, quads: true }, stats)) {
    if (st.kind === 'quad') {
      perBlock[(st.y / 2) * (QUAD_W / 2) + st.x / 2]++;
      quadList.push(st);
    }
    if (st.kind === 'pixel' && st.mask) {
      triPixels.set(st.tri, (triPixels.get(st.tri) ?? 0) + 1);
      triOf[st.y * QUAD_W + st.x] = st.tri;
    }
  }
  const triangles = mesh.indices.length / 3;
  return {
    triangles,
    empty: triangles - triPixels.size,
    pixels: stats.shaded,
    quads: stats.quads,
    lanes: stats.quads * 4,
    helpers: stats.helperLanes,
    waves: Math.ceil(stats.quads / 8),
    perBlock,
    quadList,
    triOf,
    target,
  };
}

// ---------------------------------------------------------------------------------------------
// Registers and occupancy (AMD RDNA 3, wave32, on the parts with 1,536 VGPRs per SIMD lane)

export const VGPRS_PER_SIMD = 1536;
/** VGPRs are handed out in blocks of this many (LLVM's AMDGPU backend, gfx11 with 1.5× VGPRs, wave32). */
export const VGPR_GRANULE = 24;
export const WAVE_SLOTS = 16;
export function wavesPerSimd(vgprs: number): number {
  const alloc = Math.ceil(vgprs / VGPR_GRANULE) * VGPR_GRANULE;
  return Math.min(WAVE_SLOTS, Math.floor(VGPRS_PER_SIMD / alloc));
}

/**
 * A toy SIMD: each wave runs `alu` instructions, then issues a memory load and waits `latency`
 * cycles for it, over and over. Each cycle the SIMD issues one instruction from a wave that's
 * ready: it sticks with one wave until that wave has to wait, then moves on to the next ready one.
 * Returns the fraction of cycles it was busy, and the timeline for drawing.
 */
export const ALU_RUN = 40;
export const MEM_LATENCY = 400;
export function latencyModel(waves: number, cycles = 4000, alu = ALU_RUN, latency = MEM_LATENCY): { busy: number; timeline: Int16Array } {
  const readyAt = new Array(waves).fill(0);
  const left = new Array(waves).fill(alu);
  // Stagger the start a little, so the waves don't all line up (as if launched one by one).
  for (let w = 0; w < waves; w++) readyAt[w] = w * 4;
  const timeline = new Int16Array(cycles).fill(-1);
  let busy = 0;
  let rr = 0;
  for (let t = 0; t < cycles; t++) {
    let pick = -1;
    for (let k = 0; k < waves; k++) {
      const w = (rr + k) % waves;
      if (readyAt[w] <= t) {
        pick = w;
        break;
      }
    }
    if (pick < 0) continue;
    busy++;
    timeline[t] = pick;
    if (--left[pick] === 0) {
      left[pick] = alu;
      readyAt[pick] = t + 1 + latency;
      rr = (pick + 1) % waves;
    }
  }
  return { busy: busy / cycles, timeline };
}
