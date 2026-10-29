/**
 * Terrain analysis over the 2.5D grid. Everything here is a pure function of the
 * world, so results are cached by world version and recomputed only after edits.
 */
import { makeRng } from '../lab/core/rng';
import { BUILDING, CROUCHED, EYE, KINDS, LOW, STANDING, type P, type TWorld, inside, los } from './world';

const SQ2 = Math.SQRT2;
const N8: Array<[number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQ2],
  [1, -1, SQ2],
  [-1, 1, SQ2],
  [-1, -1, SQ2],
];

// ---------------------------------------------------------------------------
// Clearance: exact Euclidean distance transform (Felzenszwalb & Huttenlocher).

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Distance (in cells) from every cell to the nearest cell where `solid` is true. The map edge counts as solid. */
export function distanceField(w: number, h: number, solid: (i: number) => boolean): Float32Array {
  // Pad by one so the border is an obstacle.
  const W = w + 2;
  const H = h + 2;
  const INF = 1e12;
  const g = new Float64Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inner = x > 0 && y > 0 && x <= w && y <= h;
      g[y * W + x] = !inner || solid((y - 1) * w + (x - 1)) ? 0 : INF;
    }
  const n = Math.max(W, H);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) g[y * W + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(g[(y + 1) * W + x + 1]);
  return out;
}

// ---------------------------------------------------------------------------
// Regions and chokes: a watershed over the clearance field.

export interface Choke {
  x: number;
  y: number;
  /** Width of the opening in cells, measured straight across at the choke cell. */
  width: number;
  a: number;
  b: number;
  /** Fraction of sampled routes that pass through it (filled in by traffic). */
  traffic: number;
}
export interface Regions {
  region: Int32Array;
  /** Cells where two regions meet without merging (the gateway lines). */
  gate: Uint8Array;
  chokes: Choke[];
  count: number;
}

/**
 * Flood the free space from its widest points downwards. Each local maximum of the
 * clearance starts a region. Where two growing regions meet, they merge if the meeting
 * point is nearly as wide as the regions themselves; if it's much narrower (below
 * `ratio` × the smaller region's widest point), the meeting point is a choke and the
 * regions stay apart. The first meeting point of a pair is the saddle: the widest
 * point of the narrowest crossing, so its clearance is roughly the choke's half-width.
 */
export function regions(w: number, h: number, free: (i: number) => boolean, clear: Float32Array, ratio: number, minPeak = 2): Regions {
  const n = w * h;
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (free(i)) order.push(i);
  order.sort((a, b) => clear[b] - clear[a]);
  const parent = new Int32Array(n).fill(-1);
  const peak = new Float32Array(n);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const owner = new Int32Array(n).fill(-1);
  const gate = new Uint8Array(n);
  // Width of the opening at a choke: the shorter of the free runs across it horizontally and vertically.
  const run = (x: number, y: number, dx: number, dy: number) => {
    let k = 0;
    while (x + dx * (k + 1) >= 0 && y + dy * (k + 1) >= 0 && x + dx * (k + 1) < w && y + dy * (k + 1) < h && free((y + dy * (k + 1)) * w + x + dx * (k + 1))) k++;
    return k;
  };
  const span = (x: number, y: number) => Math.min(1 + run(x, y, 1, 0) + run(x, y, -1, 0), 1 + run(x, y, 0, 1) + run(x, y, 0, -1));
  const met = new Map<string, Choke[]>();
  for (const i of order) {
    const x = i % w;
    const y = (i - x) / w;
    const roots = new Set<number>();
    for (const [dx, dy] of N8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (owner[j] >= 0) roots.add(find(owner[j]));
    }
    if (!roots.size) {
      parent[i] = i;
      peak[i] = clear[i];
      owner[i] = i;
      continue;
    }
    const rs = [...roots].sort((a, b) => peak[b] - peak[a]);
    let main = rs[0];
    for (const r of rs.slice(1)) {
      const small = Math.min(peak[main], peak[r]);
      if (clear[i] < ratio * small && small >= minPeak) {
        // A narrow meeting point between two substantial regions: keep them apart.
        gate[i] = 1;
        // Only report it as a choke if the opening measured across is narrow too: a cell can
        // look narrow in the clearance field (beside a short wall in the open) without being
        // an opening anyone has to squeeze through.
        const sp = span(x, y);
        if (sp / 2 < ratio * small + 0.5) {
          const key = main < r ? `${main}|${r}` : `${r}|${main}`;
          const list = met.get(key) ?? [];
          // Several separate openings can join the same pair of regions (two doors into one room).
          if (!list.some((c) => Math.abs(c.x - x) + Math.abs(c.y - y) < 8)) list.push({ x, y, width: sp, a: main, b: r, traffic: 0 });
          met.set(key, list);
        }
      } else {
        parent[r] = main;
        peak[main] = Math.max(peak[main], peak[r]);
        main = find(main);
      }
    }
    owner[i] = main;
  }
  // Number the surviving regions.
  const region = new Int32Array(n).fill(-1);
  const ids = new Map<number, number>();
  for (const i of order) {
    const r = find(owner[i]);
    if (!ids.has(r)) ids.set(r, ids.size);
    region[i] = ids.get(r)!;
  }
  const chokes: Choke[] = [];
  for (const c of [...met.values()].flat()) {
    const a = ids.get(find(c.a));
    const b = ids.get(find(c.b));
    if (a === undefined || b === undefined || a === b) continue;
    chokes.push({ ...c, a, b });
  }
  return { region, gate, chokes, count: ids.size };
}

// ---------------------------------------------------------------------------
// Traffic: how many sampled shortest routes pass through each cell.

class Heap {
  k: number[] = [];
  v: number[] = [];
  push(key: number, val: number): void {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.k;
    const v = this.v;
    const top = v[0];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
  get size(): number {
    return this.k.length;
  }
}

/** Dijkstra over walkable cells, 8-connected, no corner cutting. Returns distances and parents. */
export function dijkstra(t: TWorld, from: number, maxDist = Infinity): { dist: Float32Array; prev: Int32Array } {
  const n = t.w * t.h;
  const dist = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const walk = (i: number) => KINDS[t.kind[i]].walk && !t.dyn[i];
  const q = new Heap();
  dist[from] = 0;
  q.push(0, from);
  while (q.size) {
    const i = q.pop();
    const d = dist[i];
    if (d > maxDist) break;
    const x = i % t.w;
    const y = (i - x) / t.w;
    for (const [dx, dy, c] of N8) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(t, nx, ny)) continue;
      const j = ny * t.w + nx;
      if (!walk(j)) continue;
      if (dx && dy && (!walk(y * t.w + nx) || !walk(ny * t.w + x))) continue;
      const nd = d + c;
      if (nd < dist[j]) {
        dist[j] = nd;
        prev[j] = i;
        q.push(nd, j);
      }
    }
  }
  return { dist, prev };
}

export function traffic(t: TWorld, sources = 40, targetsEach = 12, seed = 1): Float32Array {
  const n = t.w * t.h;
  const walk: number[] = [];
  for (let i = 0; i < n; i++) if (KINDS[t.kind[i]].walk) walk.push(i);
  const count = new Float32Array(n);
  if (walk.length < 2) return count;
  const rng = makeRng(seed);
  let routes = 0;
  for (let s = 0; s < sources; s++) {
    const from = walk[Math.floor(rng() * walk.length)];
    const { dist, prev } = dijkstra(t, from);
    for (let k = 0; k < targetsEach; k++) {
      const to = walk[Math.floor(rng() * walk.length)];
      if (!Number.isFinite(dist[to])) continue;
      routes++;
      for (let c = to; c >= 0; c = prev[c]) count[c]++;
    }
  }
  if (routes) for (let i = 0; i < n; i++) count[i] /= routes;
  return count;
}

// ---------------------------------------------------------------------------
// Openness: rays from eye height in 16 directions.

export interface Openness {
  long: Float32Array;
  short: Float32Array;
  kind: Uint8Array; // 0 open, 1 street/corridor, 2 enclosed, 3 mixed
  rays: number;
}
export const OPEN_KINDS = ['Open ground', 'Street or corridor', 'Enclosed', 'Junction or plaza'];
const DIRS = 16;
export const RAY_MAX = 40;

/** Length of one horizontal ray at eye height, stepping half a cell at a time. */
export function rayLength(t: TWorld, x: number, y: number, a: number): number {
  const dx = Math.cos(a) * 0.5;
  const dy = Math.sin(a) * 0.5;
  let px = x + 0.5;
  let py = y + 0.5;
  for (let s = 1; s <= RAY_MAX * 2; s++) {
    px += dx;
    py += dy;
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    if (!inside(t, cx, cy)) return s * 0.5;
    if (KINDS[t.kind[cy * t.w + cx]].height >= EYE) return s * 0.5;
  }
  return RAY_MAX;
}

/**
 * Pair opposite rays into 8 axes through the cell; an axis's length is the open distance
 * from wall to wall through the cell. Even the shortest axis long → open ground; even the
 * longest short → enclosed (a room). Otherwise look across the longest axis: if the space
 * is narrow at right angles to it, it's a street or corridor; if it's wide that way too,
 * two long directions cross here: a junction, plaza or courtyard.
 */
export const OPEN_RULES = { open: 20, ratio: 2.5, enclosed: 12 };
export function classifyOpen(long: number, short: number, across: number): number {
  if (short >= OPEN_RULES.open) return 0;
  if (long < OPEN_RULES.enclosed) return 2;
  if (across * OPEN_RULES.ratio <= long) return 1;
  return 3;
}

function axes(rays: number[]): { long: number; short: number; across: number; longK: number; shortK: number } {
  let long = 0;
  let short = Infinity;
  let longK = 0;
  let shortK = 0;
  for (let k = 0; k < DIRS / 2; k++) {
    const a = rays[k] + rays[k + DIRS / 2];
    if (a > long) ((long = a), (longK = k));
    if (a < short) ((short = a), (shortK = k));
  }
  const q = (longK + DIRS / 4) % DIRS;
  const across = rays[q] + rays[(q + DIRS / 2) % DIRS];
  return { long, short, across, longK, shortK };
}

export function openness(t: TWorld): Openness {
  const n = t.w * t.h;
  const o: Openness = { long: new Float32Array(n), short: new Float32Array(n), kind: new Uint8Array(n), rays: 0 };
  const d: number[] = new Array(DIRS).fill(0);
  for (let y = 0; y < t.h; y++)
    for (let x = 0; x < t.w; x++) {
      const i = y * t.w + x;
      if (!KINDS[t.kind[i]].walk) continue;
      for (let k = 0; k < DIRS; k++) d[k] = rayLength(t, x, y, (k / DIRS) * Math.PI * 2);
      o.rays += DIRS;
      const ax = axes(d);
      o.long[i] = ax.long;
      o.short[i] = ax.short;
      o.kind[i] = classifyOpen(ax.long, ax.short, ax.across);
    }
  return o;
}

/** The same measurement for one cell, keeping the rays and axes for drawing. */
export function probeOpenness(t: TWorld, x: number, y: number): { rays: number[]; long: number; short: number; across: number; longA: number; shortA: number; kind: number } {
  const rays = Array.from({ length: DIRS }, (_, k) => rayLength(t, x, y, (k / DIRS) * Math.PI * 2));
  const ax = axes(rays);
  return { rays, long: ax.long, short: ax.short, across: ax.across, longA: (ax.longK / DIRS) * Math.PI * 2, shortA: (ax.shortK / DIRS) * Math.PI * 2, kind: classifyOpen(ax.long, ax.short, ax.across) };
}

// ---------------------------------------------------------------------------
// Cover

export interface CoverCell {
  i: number;
  /** Directions (0 E, 1 S, 2 W, 3 N) in which an obstacle gives cover. */
  dirs: number;
  /** True if any side is a building (full cover); otherwise low cover only. */
  full: boolean;
}
const D4: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/** Is cell i a cover position: walkable, with a low wall or building directly beside it? */
export function coverAt(t: TWorld, i: number): CoverCell | null {
  if (!KINDS[t.kind[i]].walk) return null;
  const x = i % t.w;
  const y = (i - x) / t.w;
  let dirs = 0;
  let full = false;
  D4.forEach(([dx, dy], k) => {
    const nx = x + dx;
    const ny = y + dy;
    if (!inside(t, nx, ny)) return;
    const kk = t.kind[ny * t.w + nx];
    if (kk === LOW || kk === BUILDING) {
      dirs |= 1 << k;
      if (kk === BUILDING) full = true;
    }
  });
  return dirs ? { i, dirs, full } : null;
}

export interface CoverSet {
  cells: Map<number, CoverCell>;
  /** Rail id per cover cell: connected runs of cover. */
  rail: Map<number, number>;
  rails: number;
}

export function railsOf(t: TWorld, cells: Map<number, CoverCell>): CoverSet {
  const rail = new Map<number, number>();
  let rails = 0;
  for (const i of cells.keys()) {
    if (rail.has(i)) continue;
    const stack = [i];
    rail.set(i, rails);
    while (stack.length) {
      const c = stack.pop()!;
      const x = c % t.w;
      const y = (c - x) / t.w;
      for (const [dx, dy] of N8) {
        const j = (y + dy) * t.w + x + dx;
        if (inside(t, x + dx, y + dy) && cells.has(j) && !rail.has(j)) {
          rail.set(j, rails);
          stack.push(j);
        }
      }
    }
    rails++;
  }
  return { cells, rail, rails };
}

export type CoverMethod = 'edges' | 'random' | 'poisson' | 'biased';
export interface CoverRun {
  found: Map<number, CoverCell>;
  samples: P[];
  /** Cells inspected (exhaustive scan) or probes made (sampling). */
  work: number;
}

/**
 * Find cover by one method. Sampling methods drop points and probe the 8 cells around
 * each one (as a unit standing there would feel for a wall), so a sample within a cell
 * of cover finds it.
 */
export function findCover(t: TWorld, method: CoverMethod, budget: number, seed: number): CoverRun {
  const found = new Map<number, CoverCell>();
  const samples: P[] = [];
  let work = 0;
  const probe = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!inside(t, x + dx, y + dy)) continue;
        const i = (y + dy) * t.w + x + dx;
        work++;
        const c = coverAt(t, i);
        if (c) found.set(i, c);
      }
  };
  const rng = makeRng(seed);
  if (method === 'edges') {
    for (let i = 0; i < t.w * t.h; i++) {
      work++;
      const c = coverAt(t, i);
      if (c) found.set(i, c);
    }
    return { found, samples, work };
  }
  if (method === 'random') {
    for (let k = 0; k < budget; k++) {
      const x = Math.floor(rng() * t.w);
      const y = Math.floor(rng() * t.h);
      samples.push({ x, y });
      probe(x, y);
    }
  } else if (method === 'poisson') {
    // Bridson's algorithm: samples at least r apart, filling the map evenly. The radius is
    // chosen so that roughly `budget` points fit, for a fair comparison with random.
    const r = Math.sqrt((t.w * t.h) / (budget * 1.5));
    const cell = r / Math.SQRT2;
    const gw = Math.ceil(t.w / cell);
    const gh = Math.ceil(t.h / cell);
    const grid = new Int32Array(gw * gh).fill(-1);
    const pts: Array<[number, number]> = [];
    const active: number[] = [];
    const add = (x: number, y: number) => {
      pts.push([x, y]);
      active.push(pts.length - 1);
      grid[Math.floor(y / cell) * gw + Math.floor(x / cell)] = pts.length - 1;
    };
    add(rng() * t.w, rng() * t.h);
    while (active.length && pts.length < budget) {
      const ai = Math.floor(rng() * active.length);
      const [px, py] = pts[active[ai]];
      let placed = false;
      for (let k = 0; k < 20; k++) {
        const a = rng() * Math.PI * 2;
        const d = r * (1 + rng());
        const x = px + Math.cos(a) * d;
        const y = py + Math.sin(a) * d;
        if (x < 0 || y < 0 || x >= t.w || y >= t.h) continue;
        const gx = Math.floor(x / cell);
        const gy = Math.floor(y / cell);
        let ok = true;
        for (let yy = Math.max(0, gy - 2); yy <= Math.min(gh - 1, gy + 2) && ok; yy++)
          for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) {
            const q = grid[yy * gw + xx];
            if (q >= 0 && Math.hypot(pts[q][0] - x, pts[q][1] - y) < r) {
              ok = false;
              break;
            }
          }
        if (ok) {
          add(x, y);
          placed = true;
          break;
        }
      }
      if (!placed) active.splice(ai, 1);
    }
    for (const [x, y] of pts) {
      samples.push({ x: Math.floor(x), y: Math.floor(y) });
      probe(Math.floor(x), Math.floor(y));
    }
  } else {
    // Edge-biased: start from random obstacle cells that touch walkable ground.
    const edges: number[] = [];
    for (let i = 0; i < t.w * t.h; i++) {
      const k = t.kind[i];
      if (k !== LOW && k !== BUILDING) continue;
      const x = i % t.w;
      const y = (i - x) / t.w;
      if (D4.some(([dx, dy]) => inside(t, x + dx, y + dy) && KINDS[t.kind[(y + dy) * t.w + x + dx]].walk)) edges.push(i);
    }
    for (let k = 0; k < budget && edges.length; k++) {
      const e = edges[Math.floor(rng() * edges.length)];
      const x = e % t.w;
      const y = (e - x) / t.w;
      samples.push({ x, y });
      probe(x, y);
    }
  }
  return { found, samples, work };
}

// ---------------------------------------------------------------------------
// Exposure

/** For each walkable cell: how many of the threats can see a unit there, standing and crouched. */
export function exposureKnown(t: TWorld, threats: P[]): { standing: Uint8Array; crouched: Uint8Array; rays: number } {
  const n = t.w * t.h;
  const standing = new Uint8Array(n);
  const crouched = new Uint8Array(n);
  let rays = 0;
  for (let i = 0; i < n; i++) {
    if (!KINDS[t.kind[i]].walk) continue;
    const x = i % t.w;
    const y = (i - x) / t.w;
    for (const q of threats) {
      rays += 2;
      if (los(t, q.x, q.y, x, y, EYE, STANDING).clear) standing[i]++;
      if (los(t, q.x, q.y, x, y, EYE, CROUCHED).clear) crouched[i]++;
    }
  }
  return { standing, crouched, rays };
}

/**
 * Monte Carlo exposure with no known threats: for random (cell, shooter) pairs, test line
 * of sight from a shooter placed at a random walkable spot within `range` of the cell.
 * Accumulates hits and samples per cell and per 8 compass sectors, so it converges as
 * samples are added and can be refined forever.
 */
export class MonteCarloExposure {
  hits: Float32Array;
  samples: Float32Array;
  sectorHits: Float32Array;
  sectorSamples: Float32Array;
  rays = 0;
  steps = 0;
  private rng: () => number;
  private walk: number[] = [];
  constructor(
    private t: TWorld,
    public range = 30,
    public crouched = false,
    seed = 9,
  ) {
    const n = t.w * t.h;
    this.hits = new Float32Array(n);
    this.samples = new Float32Array(n);
    this.sectorHits = new Float32Array(n * 8);
    this.sectorSamples = new Float32Array(n * 8);
    this.rng = makeRng(seed);
    for (let i = 0; i < n; i++) if (KINDS[t.kind[i]].walk) this.walk.push(i);
  }
  /** Add `count` random samples. */
  run(count: number): void {
    const t = this.t;
    const rng = this.rng;
    for (let k = 0; k < count && this.walk.length; k++) {
      const i = this.walk[Math.floor(rng() * this.walk.length)];
      const x = i % t.w;
      const y = (i - x) / t.w;
      const a = rng() * Math.PI * 2;
      const d = 2 + Math.sqrt(rng()) * (this.range - 2);
      const sx = Math.round(x + Math.cos(a) * d);
      const sy = Math.round(y + Math.sin(a) * d);
      if (!inside(t, sx, sy) || !KINDS[t.kind[sy * t.w + sx]].walk) continue;
      const r = los(t, sx, sy, x, y, EYE, this.crouched ? CROUCHED : STANDING);
      this.rays++;
      this.steps += r.steps;
      // Sector the shot comes *from*, as seen from the cell.
      const sec = ((Math.round((Math.atan2(sy - y, sx - x) / (Math.PI * 2)) * 8) % 8) + 8) % 8;
      this.samples[i]++;
      this.sectorSamples[i * 8 + sec]++;
      if (r.clear) {
        this.hits[i]++;
        this.sectorHits[i * 8 + sec]++;
      }
    }
  }
  value(i: number): number {
    return this.samples[i] ? this.hits[i] / this.samples[i] : NaN;
  }
}
