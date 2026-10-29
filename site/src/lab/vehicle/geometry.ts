import { MinHeap } from '../core/heap';
import type { GridSpace } from '../graph/gridSpace';
import type { Pose } from './curves';

/**
 * A vehicle: a rectangle that moves with a minimum turning radius. Its pose is the
 * reference point: the middle of the rear axle for wheeled vehicles (the point the
 * turning circle is centred on the side of), the middle for tracked ones, which can
 * also turn on the spot.
 */
export interface VehicleSpec {
  id: string;
  name: string;
  length: number; // cells
  width: number; // cells
  /** Distance from the reference point back to the rear bumper. */
  rear: number;
  /** Default minimum turning radius, in cells. */
  radius: number;
  /** Cost multiplier for driving in reverse. */
  reversePenalty: number;
  /** Extra cost for each change between forward and reverse. */
  switchPenalty: number;
  /** Tracked vehicles can turn on the spot. */
  pivot: boolean;
}

export const VEHICLES: VehicleSpec[] = [
  { id: 'car', name: 'Car 4 × 2', length: 4, width: 2, rear: 0.8, radius: 4, reversePenalty: 2, switchPenalty: 5, pivot: false },
  { id: 'rover', name: 'Rover 3 × 1.6', length: 3, width: 1.6, rear: 0.6, radius: 2.5, reversePenalty: 1.5, switchPenalty: 3, pivot: false },
  { id: 'truck', name: 'Truck 7 × 2.6', length: 7, width: 2.6, rear: 1.4, radius: 7, reversePenalty: 3, switchPenalty: 12, pivot: false },
  { id: 'tracked', name: 'Tracked 5 × 3', length: 5, width: 3, rear: 2.5, radius: 3, reversePenalty: 1.3, switchPenalty: 2, pivot: true },
];

export function vehicleById(id: string): VehicleSpec {
  return VEHICLES.find((v) => v.id === id) ?? VEHICLES[0];
}

/** The four corners of the footprint at a pose (rear-left, front-left, front-right, rear-right). */
export function footprintCorners(v: { length: number; width: number; rear: number }, p: Pose): Array<[number, number]> {
  const c = Math.cos(p.theta);
  const s = Math.sin(p.theta);
  const b = -v.rear;
  const f = v.length - v.rear;
  const hw = v.width / 2;
  const pt = (along: number, side: number): [number, number] => [p.x + c * along - s * side, p.y + s * along + c * side];
  return [pt(b, -hw), pt(f, -hw), pt(f, hw), pt(b, hw)];
}

/**
 * Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher) from every
 * cell centre to the nearest blocked cell centre. The map border counts as blocked.
 * Returns plain distances.
 */
export function distanceField(w: number, h: number, blocked: Uint8Array): Float32Array {
  const W = w + 2;
  const H = h + 2;
  const INF = 1e20;
  const f = new Float64Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inside = x > 0 && y > 0 && x <= w && y <= h;
      f[y * W + x] = !inside || blocked[(y - 1) * w + (x - 1)] ? 0 : INF;
    }
  const n = Math.max(W, H);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const g = new Float64Array(n);
  const pass = (get: (i: number) => number, set: (i: number, val: number) => void, len: number) => {
    for (let i = 0; i < len; i++) g[i] = get(i);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (g[q] + q * q - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (g[q] + q * q - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + g[v[k]];
    }
    for (let i = 0; i < len; i++) set(i, d[i]);
  };
  for (let x = 0; x < W; x++)
    pass(
      (i) => f[i * W + x],
      (i, val) => (f[i * W + x] = val),
      H,
    );
  for (let y = 0; y < H; y++)
    pass(
      (i) => f[y * W + i],
      (i, val) => (f[y * W + i] = val),
      W,
    );
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(f[(y + 1) * W + (x + 1)]);
  return out;
}

/**
 * Footprint collision checks against the painted grid. A distance field gives a quick
 * answer far from walls; near walls the rectangle is tested exactly against each
 * blocked cell it might touch (separating-axis test).
 */
export class FootprintChecker {
  checks = 0;
  exact = 0;
  readonly half: number; // half length
  readonly hw: number; // half width
  private centreAhead: number;
  private circum: number;
  constructor(
    readonly w: number,
    readonly h: number,
    readonly blocked: Uint8Array,
    readonly dist: Float32Array,
    readonly v: { length: number; width: number; rear: number },
  ) {
    // A hair of slack so a vehicle exactly as wide as a gap still fits.
    this.half = v.length / 2 - 0.01;
    this.hw = v.width / 2 - 0.02;
    this.centreAhead = v.length / 2 - v.rear;
    this.circum = Math.hypot(this.half, this.hw);
  }

  free(x: number, y: number, theta: number): boolean {
    this.checks++;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const cx = x + c * this.centreAhead;
    const cy = y + s * this.centreAhead;
    const ix = Math.floor(cx);
    const iy = Math.floor(cy);
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return false;
    // Nearest wall point is at least (distance between centres) - 1.42 away.
    const d = this.dist[iy * this.w + ix];
    if (d - 1.4143 > this.circum) return true;
    this.exact++;
    const ac = Math.abs(c);
    const as = Math.abs(s);
    const ex = this.half * ac + this.hw * as;
    const ey = this.half * as + this.hw * ac;
    if (cx - ex < 0 || cy - ey < 0 || cx + ex > this.w || cy + ey > this.h) return false;
    const x0 = Math.floor(cx - ex);
    const x1 = Math.floor(cx + ex);
    const y0 = Math.floor(cy - ey);
    const y1 = Math.floor(cy + ey);
    const ru = this.half + 0.5 * (ac + as);
    const rv = this.hw + 0.5 * (ac + as);
    for (let yy = y0; yy <= y1; yy++) {
      const row = yy * this.w;
      for (let xx = x0; xx <= x1; xx++) {
        if (!this.blocked[row + xx]) continue;
        // Square [xx, xx+1] x [yy, yy+1] against the rectangle: x and y axes are already
        // overlapping (bounding box); test the rectangle's own two axes.
        const dx = xx + 0.5 - cx;
        const dy = yy + 0.5 - cy;
        if (Math.abs(dx * c + dy * s) >= ru) continue;
        if (Math.abs(-dx * s + dy * c) >= rv) continue;
        if (xx + 1 <= cx - ex || xx >= cx + ex || yy + 1 <= cy - ey || yy >= cy + ey) continue;
        return false;
      }
    }
    return true;
  }

  /** Checks poses (x, y, theta, dir quadruples) from index `from`; true if all are free. */
  freeAlong(poses: ArrayLike<number>, from = 0): boolean {
    for (let k = from; k < poses.length; k += 4) if (!this.free(poses[k], poses[k + 1], poses[k + 2])) return false;
    return true;
  }
}

/**
 * Cost-to-goal ignoring turning: Dijkstra from the goal over every cell where a disc
 * that fits inside the vehicle (round its reference point) is clear of walls, priced
 * with terrain. It never blocks a place the vehicle can really reach, and it knows about
 * dead ends, which is what keeps Hybrid A* out of them. It moves in 8 directions, so on open
 * diagonals it can be up to ~8% above the true distance: not a strict lower bound.
 */
export function holonomicField(space: GridSpace, dist: Float32Array, discRadius: number, goal: number): Float64Array {
  const { w, h } = space;
  const n = w * h;
  // Float64: a Float32 field rounds stored costs and can make Dijkstra re-improve cells forever.
  const field = new Float64Array(n).fill(Infinity);
  const need = discRadius - 0.5;
  const ok = (i: number) => dist[i] >= need;
  if (!ok(goal)) return field;
  const heap = new MinHeap();
  field[goal] = 0;
  heap.push(goal, 0, 0);
  const layer = space.layer;
  const mult = (i: number) => space.multiplier(i);
  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DY = [0, 0, 1, -1, 1, -1, 1, -1];
  while (heap.size) {
    const g = heap.peekKey();
    const i = heap.pop();
    if (g > field[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (layer.blocked[j] || !ok(j)) continue;
      // Costs are symmetric enough: price a step by the average of both cells.
      const step = (k < 4 ? 1 : Math.SQRT2) * 0.5 * (mult(i) + mult(j));
      const ng = g + step;
      if (ng < field[j]) {
        field[j] = ng;
        heap.push(j, ng, 0);
      }
    }
  }
  return field;
}

/** Radius of the largest disc round the reference point that stays inside the footprint. */
export function innerDisc(v: VehicleSpec): number {
  return Math.min(v.width / 2, v.rear, v.length - v.rear);
}
