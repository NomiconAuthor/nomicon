import { MinHeap } from '../core/heap';
import { makeRng } from '../core/rng';
import type { GridSpace } from '../graph/gridSpace';
import type { Recorder } from '../search/types';
import { curveCandidates, dubinsAll, mod2pi, samplePath, truncatePath, walkPath, wrapPi, type CurvePath, type Pose } from './curves';
import type { FootprintChecker, VehicleSpec } from './geometry';

/** Spacing of collision checks along any motion, in cells. */
export const CHECK_STEP = 0.3;

export interface VehicleProblem {
  space: GridSpace;
  check: FootprintChecker;
  spec: VehicleSpec;
  radius: number;
  reverse: boolean;
  start: Pose;
  goal: Pose;
  /** Arrive facing any direction. */
  anyHeading: boolean;
  /** Cost-to-goal ignoring turning (Infinity where the vehicle's inner disc can't go). */
  field: Float64Array;
  rec: Recorder;
}

/**
 * The search tree, for drawing. Each node has a pose and a parent; the motion from the
 * parent is either drawn as a smooth curve between the two poses (short arcs) or from
 * stored points (long RRT steering curves, lattice primitives).
 */
export class VehicleTree {
  x: number[] = [];
  y: number[] = [];
  t: number[] = [];
  parent: number[] = [];
  dir: number[] = [];
  /** Start of this node's stored points in `pts` (x, y pairs), and how many; 0 = draw a curve. */
  ptsAt: number[] = [];
  ptsN: number[] = [];
  pts: number[] = [];
  add(p: Pose, parent: number, dir: number, points?: ArrayLike<number>, stride = 4): number {
    const id = this.x.length;
    this.x.push(p.x);
    this.y.push(p.y);
    this.t.push(p.theta);
    this.parent.push(parent);
    this.dir.push(dir);
    this.ptsAt.push(this.pts.length);
    let n = 0;
    if (points)
      for (let k = 0; k < points.length; k += stride) {
        this.pts.push(points[k], points[k + 1]);
        n++;
      }
    this.ptsN.push(n);
    return id;
  }
  get size(): number {
    return this.x.length;
  }
  pose(i: number): Pose {
    return { x: this.x[i], y: this.y[i], theta: this.t[i] };
  }
}

export interface VehicleResult {
  found: boolean;
  /** x, y, theta, dir quadruples from start to goal. */
  poses: number[];
  expanded: number;
  pushes: number;
  maxOpen: number;
  tree: VehicleTree;
  /** The analytic shot that finished the search, if one did (Hybrid A*, RRT). */
  shot: number[] | null;
  extra: Array<[string, string]>;
  /** Why it stopped without a path. */
  reason: string;
}

/** Length, terrain-priced cost, reversing length and gear changes of a sampled path. */
export function measurePoses(space: GridSpace, poses: ArrayLike<number>): { length: number; cost: number; reverse: number; cusps: number } {
  let length = 0;
  let cost = 0;
  let reverse = 0;
  let cusps = 0;
  for (let k = 4; k < poses.length; k += 4) {
    const ds = Math.hypot(poses[k] - poses[k - 4], poses[k + 1] - poses[k - 3]);
    const mx = Math.floor((poses[k] + poses[k - 4]) / 2);
    const my = Math.floor((poses[k + 1] + poses[k - 3]) / 2);
    const m = mx >= 0 && my >= 0 && mx < space.w && my < space.h ? space.multiplier(my * space.w + mx) : 1;
    length += ds;
    cost += ds * m;
    if (poses[k + 3] < 0) reverse += ds;
    if (k >= 8 && poses[k + 3] !== poses[k - 1]) cusps++;
  }
  return { length, cost, reverse, cusps };
}

function terrainAlong(space: GridSpace, poses: ArrayLike<number>, from: number): number {
  // Average multiplier under the sampled poses.
  let s = 0;
  let n = 0;
  for (let k = from; k < poses.length; k += 4) {
    const x = Math.floor(poses[k]);
    const y = Math.floor(poses[k + 1]);
    s += x >= 0 && y >= 0 && x < space.w && y < space.h ? space.multiplier(y * space.w + x) : 1;
    n++;
  }
  return n ? s / n : 1;
}

function cellOf(space: GridSpace, x: number, y: number): number {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= space.w || cy >= space.h) return -1;
  return cy * space.w + cx;
}

/** Turn on the spot from `a` to heading `to` (tracked vehicles), sampled every ~4 degrees. */
function pivotPoses(x: number, y: number, from: number, to: number, out: number[]): void {
  const d = wrapPi(to - from);
  const n = Math.max(1, Math.ceil(Math.abs(d) / 0.07));
  for (let k = 1; k <= n; k++) out.push(x, y, from + (d * k) / n, 1);
}

/**
 * Candidate final approaches from a pose to the goal, cheapest first: obstacle-free
 * shortest curves (Reeds-Shepp or Dubins), and for tracked vehicles also "turn on
 * the spot, drive straight, turn on the spot".
 */
interface Shot {
  len: number;
  /** A curve from `a`, checked lazily, or ready-made poses (turn-on-the-spot shots). */
  curve?: CurvePath;
  poses?: number[];
}

function shotCandidates(pr: VehicleProblem, a: Pose, limit: number): Shot[] {
  const out: Shot[] = [];
  const goals: Pose[] = pr.anyHeading
    ? [
        { x: pr.goal.x, y: pr.goal.y, theta: Math.atan2(pr.goal.y - a.y, pr.goal.x - a.x) },
        { x: pr.goal.x, y: pr.goal.y, theta: a.theta },
      ]
    : [pr.goal];
  for (const g of goals) {
    for (const c of curveCandidates(a, g, pr.radius, pr.reverse).slice(0, limit)) out.push({ len: weightedLength(pr, c), curve: c });
    if (pr.spec.pivot) {
      const dx = g.x - a.x;
      const dy = g.y - a.y;
      const d = Math.hypot(dx, dy);
      const poses: number[] = [a.x, a.y, a.theta, 1];
      let heading = a.theta;
      let len = 0;
      if (d > 1e-6) {
        // Face the goal (or back toward it if reversing is allowed and shorter), then drive.
        const fwd = Math.atan2(dy, dx);
        const back = fwd + Math.PI;
        const useBack = pr.reverse && Math.abs(wrapPi(back - a.theta)) < Math.abs(wrapPi(fwd - a.theta)) - 0.3;
        const face = useBack ? back : fwd;
        pivotPoses(a.x, a.y, heading, face, poses);
        len += pivotCost(pr, Math.abs(wrapPi(face - heading)));
        heading = face;
        const n = Math.max(1, Math.ceil(d / CHECK_STEP));
        for (let k = 1; k <= n; k++) poses.push(a.x + (dx * k) / n, a.y + (dy * k) / n, heading, useBack ? -1 : 1);
        len += d * (useBack ? pr.spec.reversePenalty : 1);
      }
      pivotPoses(g.x, g.y, heading, g.theta, poses);
      len += pivotCost(pr, Math.abs(wrapPi(g.theta - heading)));
      out.push({ len, poses });
    }
  }
  out.sort((p, q) => p.len - q.len);
  return out;
}

function weightedLength(pr: VehicleProblem, c: CurvePath): number {
  let L = 0;
  let last = 0;
  for (const p of c.pieces) {
    const a = Math.abs(p.len) * c.radius;
    if (a < 1e-9) continue;
    const d = Math.sign(p.len);
    L += a * (d < 0 ? pr.spec.reversePenalty : 1);
    if (last && d !== last) L += pr.spec.switchPenalty;
    last = d;
  }
  return L;
}

/** Cost of turning on the spot by `angle` radians: about the distance the tracks travel. */
function pivotCost(pr: VehicleProblem, angle: number): number {
  return angle * (pr.spec.width / 2) * 1.5 + (angle > 1e-6 ? 0.3 : 0);
}

/** First free shot from `a`, or null. */
function tryShot(pr: VehicleProblem, a: Pose, limit: number): number[] | null {
  for (const s of shotCandidates(pr, a, limit)) {
    if (s.poses) {
      if (pr.check.freeAlong(s.poses, 4)) return s.poses;
    } else if (walkPath(a, s.curve!, CHECK_STEP, (x, y, t) => pr.check.free(x, y, t))) return samplePath(a, s.curve!, CHECK_STEP);
  }
  return null;
}

/** Curve heuristic: shortest drivable distance ignoring obstacles (only near the goal; it's costly). */
function curveH(pr: VehicleProblem, a: Pose): number {
  if (pr.spec.pivot) return 0;
  const g = pr.anyHeading ? null : pr.goal;
  if (!g) return 0;
  const d = Math.hypot(g.x - a.x, g.y - a.y);
  if (d > 4 * pr.radius) return 0;
  const c = pr.reverse ? curveCandidates(a, g, pr.radius, true)[0] : dubinsAll(a, g, pr.radius)[0];
  return c ? c.length * pr.space.minCostPerUnit : 0;
}

// ---------------------------------------------------------------------------
// Hybrid A*
// ---------------------------------------------------------------------------

export interface HybridConfig {
  bins: number;
  shots: boolean;
  limit: number;
}

interface Motion {
  steer: number; // -1..1 of full lock
  dir: number; // +1 / -1
  pivot: number; // radians turned on the spot (0 for driving)
}

/**
 * Hybrid A* (Dolgov, Thrun, Montemerlo & Diebel, 2008). A* over (cell, heading bin),
 * but each node keeps the exact continuous pose it was reached with, and children are
 * made by driving short arcs at a few steering angles, forward and in reverse. So
 * every path it returns is drivable. The heuristic is the larger of the cost ignoring
 * turning (which knows the walls) and the shortest curve ignoring walls. Every few
 * expansions it tries an "analytic expansion": a Reeds-Shepp or Dubins curve straight
 * to the goal; if that is collision-free the search ends early.
 */
export function hybridAStar(pr: VehicleProblem, cfg: HybridConfig): VehicleResult {
  const { space, check, radius, rec } = pr;
  const H = cfg.bins;
  const binW = (2 * Math.PI) / H;
  const step = Math.max(1.5, Math.min(radius * 0.6, 2.2));
  const motions: Motion[] = [];
  for (const dir of pr.reverse ? [1, -1] : [1]) for (const steer of [-1, -0.5, 0, 0.5, 1]) motions.push({ steer, dir, pivot: 0 });
  if (pr.spec.pivot) for (const a of [-3, 3]) motions.push({ steer: 0, dir: 1, pivot: a * binW });
  const tree = new VehicleTree();
  const g: number[] = [];
  const steerOf: number[] = [];
  const heap = new MinHeap();
  const best = new Map<number, number>();
  const closed = new Set<number>();
  const keyOf = (x: number, y: number, t: number) => {
    const c = cellOf(space, x, y);
    return c < 0 ? -1 : c * H + (Math.floor(mod2pi(t) / binW + 0.5) % H);
  };
  const hOf = (p: Pose) => {
    const c = cellOf(space, p.x, p.y);
    if (c < 0) return Infinity;
    const f = pr.field[c];
    if (!Number.isFinite(f)) return Infinity;
    return Math.max(f, Math.hypot(pr.goal.x - p.x, pr.goal.y - p.y) * space.minCostPerUnit, curveH(pr, p));
  };
  const root = tree.add(pr.start, -1, 1);
  g.push(0);
  steerOf.push(0);
  heap.push(root, hOf(pr.start), 0);
  best.set(keyOf(pr.start.x, pr.start.y, pr.start.theta), root);
  rec.open(root, -1, 0, hOf(pr.start));
  let expanded = 0;
  let pushes = 1;
  let maxOpen = 1;
  let shotsTried = 0;
  let shotAt = -1;
  let found = -1;
  let shot: number[] | null = null;
  let reason = '';
  const buf: number[] = [];
  while (heap.size) {
    const n = heap.pop();
    const k = keyOf(tree.x[n], tree.y[n], tree.t[n]);
    if (closed.has(k)) continue;
    closed.add(k);
    rec.close(n);
    expanded++;
    const p = tree.pose(n);
    // Close enough to the goal pose by itself? (Within a cell, and a heading bin or 7.5 degrees.)
    if (Math.hypot(p.x - pr.goal.x, p.y - pr.goal.y) <= 1 && (pr.anyHeading || Math.abs(wrapPi(p.theta - pr.goal.theta)) <= Math.max(binW, 0.131))) {
      found = n;
      break;
    }
    // Analytic expansion: more often as the goal gets closer.
    const d = Math.hypot(pr.goal.x - p.x, pr.goal.y - p.y);
    const every = d < 3 * radius ? 1 : d < 8 * radius ? 4 : 12;
    if (cfg.shots && expanded % every === 0) {
      shotsTried++;
      const s = tryShot(pr, p, 4);
      if (s) {
        shot = s;
        shotAt = expanded;
        found = n;
        break;
      }
    }
    if (expanded >= cfg.limit) {
      reason = `Stopped after ${cfg.limit.toLocaleString()} expansions without reaching the goal.`;
      break;
    }
    for (const m of motions) {
      buf.length = 0;
      let L = 0;
      if (m.pivot) {
        pivotPoses(p.x, p.y, p.theta, p.theta + m.pivot, buf);
      } else {
        L = step;
        const nSteps = Math.max(2, Math.ceil(L / CHECK_STEP));
        const kappa = m.steer / radius;
        for (let j = 1; j <= nSteps; j++) {
          const s = (m.dir * L * j) / nSteps;
          if (Math.abs(kappa) < 1e-9) buf.push(p.x + s * Math.cos(p.theta), p.y + s * Math.sin(p.theta), p.theta, m.dir);
          else {
            const t2 = p.theta + kappa * s;
            buf.push(p.x + (Math.sin(t2) - Math.sin(p.theta)) / kappa, p.y + (Math.cos(p.theta) - Math.cos(t2)) / kappa, t2, m.dir);
          }
        }
      }
      const e = buf.length - 4;
      const cp: Pose = { x: buf[e], y: buf[e + 1], theta: buf[e + 2] };
      const ck = keyOf(cp.x, cp.y, cp.theta);
      if (ck < 0 || closed.has(ck)) continue;
      if (!check.freeAlong(buf, 0)) continue;
      const h = hOf(cp);
      if (!Number.isFinite(h)) continue;
      let cost: number;
      if (m.pivot) cost = pivotCost(pr, Math.abs(m.pivot));
      else {
        cost = L * terrainAlong(space, buf, 0) * (m.dir < 0 ? pr.spec.reversePenalty : 1);
        cost += 0.05 * Math.abs(m.steer) * L + 0.1 * Math.abs(m.steer - steerOf[n]);
      }
      if (n !== root && tree.dir[n] !== m.dir && !m.pivot) cost += pr.spec.switchPenalty;
      const ng = g[n] + cost;
      const prev = best.get(ck);
      if (prev !== undefined && g[prev] <= ng) continue;
      const id = tree.add(cp, n, m.pivot ? tree.dir[n] : m.dir);
      g.push(ng);
      steerOf.push(m.steer);
      best.set(ck, id);
      heap.push(id, ng + h, -ng);
      rec.open(id, n, ng, ng + h);
      pushes++;
      if (heap.size > maxOpen) maxOpen = heap.size;
    }
  }
  if (!heap.size && found < 0 && !reason) reason = 'Every reachable pose was explored: no drivable path at this heading resolution.';
  const extra: Array<[string, string]> = [
    ['Poses reached', `${tree.size.toLocaleString()} (${H} heading bins)`],
    ['Arc length', `${step.toFixed(2)} cells`],
    ['Analytic shots', cfg.shots ? (shotAt >= 0 ? `${shotsTried} tried · hit at expansion ${shotAt}` : `${shotsTried} tried, none free`) : 'off'],
  ];
  if (found < 0) return { found: false, poses: [], expanded, pushes, maxOpen, tree, shot: null, extra, reason };
  const poses = chainPoses(pr, tree, found, (child, parent, out) => {
    // Re-drive the motion from parent to child to get its intermediate poses.
    const pp = tree.pose(parent);
    const cp = tree.pose(child);
    const ddir = tree.dir[child];
    const dx = cp.x - pp.x;
    const dy = cp.y - pp.y;
    if (Math.hypot(dx, dy) < 1e-9) {
      const tmp: number[] = [];
      pivotPoses(pp.x, pp.y, pp.theta, cp.theta, tmp);
      for (let i = 0; i < tmp.length; i += 4) out.push(tmp[i], tmp[i + 1], tmp[i + 2], ddir);
      return;
    }
    const dt = wrapPi(cp.theta - pp.theta);
    const nSteps = Math.max(2, Math.ceil(step / CHECK_STEP));
    if (Math.abs(dt) < 1e-9) {
      for (let j = 1; j <= nSteps; j++) out.push(pp.x + (dx * j) / nSteps, pp.y + (dy * j) / nSteps, pp.theta, ddir);
      return;
    }
    const kappa = dt / (ddir * step);
    for (let j = 1; j <= nSteps; j++) {
      const s = (ddir * step * j) / nSteps;
      const t2 = pp.theta + kappa * s;
      out.push(pp.x + (Math.sin(t2) - Math.sin(pp.theta)) / kappa, pp.y + (Math.cos(pp.theta) - Math.cos(t2)) / kappa, t2, ddir);
    }
  });
  if (shot) for (let i = 4; i < shot.length; i++) poses.push(shot[i]);
  return { found: true, poses, expanded, pushes, maxOpen, tree, shot, extra, reason };
}

/** Poses from the root to `node`, re-creating each motion with `motion(child, parent, out)`. */
function chainPoses(pr: VehicleProblem, tree: VehicleTree, node: number, motion: (child: number, parent: number, out: number[]) => void): number[] {
  const chain: number[] = [];
  for (let n = node; n >= 0; n = tree.parent[n]) chain.push(n);
  chain.reverse();
  const out: number[] = [pr.start.x, pr.start.y, pr.start.theta, chain.length > 1 ? tree.dir[chain[1]] : 1];
  for (let i = 1; i < chain.length; i++) motion(chain[i], chain[i - 1], out);
  return out;
}

// ---------------------------------------------------------------------------
// State lattice
// ---------------------------------------------------------------------------

/** The 16 lattice headings: directions of small integer vectors, so straight moves land exactly on cells. */
export const LATTICE_DIRS: Array<[number, number]> = [
  [1, 0], [2, 1], [1, 1], [1, 2], [0, 1], [-1, 2], [-1, 1], [-2, 1],
  [-1, 0], [-2, -1], [-1, -1], [-1, -2], [0, -1], [1, -2], [1, -1], [2, -1],
];
export const LATTICE_ANGLES = LATTICE_DIRS.map(([x, y]) => Math.atan2(y, x));

export function nearestLatticeHeading(theta: number): number {
  let best = 0;
  let bd = Infinity;
  LATTICE_ANGLES.forEach((a, i) => {
    const d = Math.abs(wrapPi(a - theta));
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

export interface Primitive {
  from: number; // heading index
  to: number;
  dx: number;
  dy: number;
  dir: number; // +1 forward, -1 reverse
  pivot: boolean;
  length: number; // driven length (0 for pivots)
  turn: number; // radians turned
  /** Poses relative to the start lattice point (x, y, theta, dir). */
  poses: Float32Array;
  /** Cells the footprint sweeps, relative to the start cell (pairs). */
  swept: Int16Array;
}

export interface LatticeTable {
  key: string;
  prims: Primitive[][]; // by start heading
  ms: number;
  count: number;
  /** How many queries have used this table (1 = the one that built it). */
  served: number;
}

/** Worst ratio of 8-direction grid distance to straight-line distance (at 22.5°). */
const OCTILE_OVER_EUCLID = Math.sqrt(4 - 2 * Math.SQRT2);

const latticeCache = new Map<string, LatticeTable>();

/** Forget every lattice table (for "replan from cold"). */
export function clearLatticeCache(): void {
  latticeCache.clear();
}

/**
 * Motion primitives for the lattice: for every start heading, a straight move and the
 * shortest clean turns to the neighbouring headings (one and two steps either way),
 * each ending exactly on a cell centre with an exact lattice heading. Built from Dubins
 * curves, mirrored for reverse, plus turns on the spot for tracked vehicles. Each
 * primitive also stores the cells the vehicle's footprint sweeps, so a collision check
 * during search is a handful of array lookups. The table depends only on the vehicle
 * and its turning radius, so it is built once and shared by every query and unit.
 */
export function latticeTable(spec: VehicleSpec, radius: number, reverse: boolean): LatticeTable {
  const key = `${spec.id}|${spec.length}|${spec.width}|${spec.rear}|${radius}|${reverse}|${spec.pivot}`;
  const hit = latticeCache.get(key);
  if (hit) {
    hit.served++;
    return hit;
  }
  const t0 = performance.now();
  // Forward primitives for headings 0..3, found by search; others by 90-degree rotation.
  const base: Array<Array<{ to: number; dx: number; dy: number; path: CurvePath | null }>> = [];
  const span = Math.ceil(3 * radius) + 3;
  for (let i = 0; i < 4; i++) {
    const list: Array<{ to: number; dx: number; dy: number; path: CurvePath | null }> = [];
    const [vx, vy] = LATTICE_DIRS[i];
    list.push({ to: i, dx: vx, dy: vy, path: null });
    if (vx * vx + vy * vy <= 2) list.push({ to: i, dx: 2 * vx, dy: 2 * vy, path: null });
    for (const dj of [-2, -1, 1, 2]) {
      const j = (i + dj + 16) % 16;
      const turn = wrapPi(LATTICE_ANGLES[j] - LATTICE_ANGLES[i]);
      let bestP: { dx: number; dy: number; path: CurvePath } | null = null;
      for (let dy = -span; dy <= span; dy++)
        for (let dx = -span; dx <= span; dx++) {
          if (dx === 0 && dy === 0) continue;
          const d = Math.hypot(dx, dy);
          if (bestP && d > bestP.path.length) continue;
          const a = { x: 0, y: 0, theta: LATTICE_ANGLES[i] };
          const b = { x: dx, y: dy, theta: LATTICE_ANGLES[j] };
          for (const c of dubinsAll(a, b, radius)) {
            // Clean: every arc turns the same way as the heading change, no loops.
            let total = 0;
            let clean = true;
            for (const p of c.pieces) {
              if (p.steer !== 0 && Math.abs(p.len) > 1e-9) {
                if (Math.sign(p.steer) !== Math.sign(turn)) clean = false;
                total += Math.abs(p.len);
              }
            }
            if (!clean || total > Math.abs(turn) + 1e-6) continue;
            if (!bestP || c.length < bestP.path.length) bestP = { dx, dy, path: c };
          }
        }
      if (bestP) list.push({ to: j, ...bestP });
    }
    base.push(list);
  }
  const prims: Primitive[][] = [];
  for (let i = 0; i < 16; i++) prims.push([]);
  const rot = (x: number, y: number, q: number): [number, number] => {
    for (let k = 0; k < q; k++) [x, y] = [-y, x];
    return [x, y];
  };
  for (let i = 0; i < 16; i++) {
    const q = Math.floor(i / 4);
    for (const b of base[i % 4]) {
      // Forward poses, rotated by q quarter turns.
      const a0 = LATTICE_ANGLES[i % 4];
      const raw: number[] = [];
      if (b.path) samplePath({ x: 0, y: 0, theta: a0 }, b.path, CHECK_STEP, raw);
      else {
        const L = Math.hypot(b.dx, b.dy);
        const n = Math.max(2, Math.ceil(L / CHECK_STEP));
        for (let k = 0; k <= n; k++) raw.push((b.dx * k) / n, (b.dy * k) / n, a0, 1);
      }
      const poses = new Float32Array(raw.length);
      for (let k = 0; k < raw.length; k += 4) {
        const [x, y] = rot(raw[k], raw[k + 1], q);
        poses[k] = x;
        poses[k + 1] = y;
        poses[k + 2] = raw[k + 2] + (q * Math.PI) / 2;
        poses[k + 3] = 1;
      }
      const [dx, dy] = rot(b.dx, b.dy, q);
      const to = (b.to + 4 * q) % 16;
      const length = b.path ? b.path.length : Math.hypot(b.dx, b.dy);
      prims[i].push({ from: i, to, dx, dy, dir: 1, pivot: false, length, turn: Math.abs(wrapPi(LATTICE_ANGLES[to] - LATTICE_ANGLES[i])), poses, swept: new Int16Array(0) });
    }
  }
  if (reverse) {
    // Reversing with heading i traces a forward primitive of heading i+8, facing backwards.
    for (let i = 0; i < 16; i++) {
      for (const f of prims[(i + 8) % 16].filter((p) => p.dir === 1 && !p.pivot)) {
        const poses = new Float32Array(f.poses.length);
        for (let k = 0; k < poses.length; k += 4) {
          poses[k] = f.poses[k];
          poses[k + 1] = f.poses[k + 1];
          poses[k + 2] = f.poses[k + 2] + Math.PI;
          poses[k + 3] = -1;
        }
        prims[i].push({ ...f, from: i, to: (f.to + 8) % 16, dir: -1, poses, swept: new Int16Array(0) });
      }
    }
  }
  if (spec.pivot) {
    for (let i = 0; i < 16; i++)
      for (const dj of [-1, 1, -2, 2]) {
        const j = (i + dj + 16) % 16;
        const raw: number[] = [0, 0, LATTICE_ANGLES[i], 1];
        pivotPoses(0, 0, LATTICE_ANGLES[i], LATTICE_ANGLES[j], raw);
        prims[i].push({ from: i, to: j, dx: 0, dy: 0, dir: 1, pivot: true, length: 0, turn: Math.abs(wrapPi(LATTICE_ANGLES[j] - LATTICE_ANGLES[i])), poses: Float32Array.from(raw), swept: new Int16Array(0) });
      }
  }
  // Swept cells: test the footprint at every pose against the cells round it (start at a cell centre).
  let count = 0;
  for (const list of prims)
    for (const p of list) {
      const cells = new Set<number>();
      for (let k = 0; k < p.poses.length; k += 4) sweptCells(spec, 0.5 + p.poses[k], 0.5 + p.poses[k + 1], p.poses[k + 2], cells);
      const out = new Int16Array(cells.size * 2);
      let n = 0;
      for (const c of cells) {
        out[n++] = (c % 1024) - 512;
        out[n++] = Math.floor(c / 1024) - 512;
      }
      p.swept = out;
      count++;
    }
  const table: LatticeTable = { key, prims, ms: performance.now() - t0, count, served: 1 };
  latticeCache.set(key, table);
  return table;
}

/** Cells (encoded (y+512)*1024 + x+512) a footprint at this pose overlaps, relative to cell (0, 0). */
function sweptCells(v: { length: number; width: number; rear: number }, x: number, y: number, theta: number, out: Set<number>): void {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const half = v.length / 2 - 0.01;
  const hw = v.width / 2 - 0.02;
  const ahead = v.length / 2 - v.rear;
  const cx = x + c * ahead;
  const cy = y + s * ahead;
  const ac = Math.abs(c);
  const as = Math.abs(s);
  const ex = half * ac + hw * as;
  const ey = half * as + hw * ac;
  const ru = half + 0.5 * (ac + as);
  const rv = hw + 0.5 * (ac + as);
  for (let yy = Math.floor(cy - ey); yy <= Math.floor(cy + ey); yy++)
    for (let xx = Math.floor(cx - ex); xx <= Math.floor(cx + ex); xx++) {
      if (xx + 1 <= cx - ex || xx >= cx + ex || yy + 1 <= cy - ey || yy >= cy + ey) continue;
      const dx = xx + 0.5 - cx;
      const dy = yy + 0.5 - cy;
      if (Math.abs(dx * c + dy * s) >= ru || Math.abs(-dx * s + dy * c) >= rv) continue;
      out.add((yy + 512) * 1024 + xx + 512);
    }
}

/**
 * A* over the state lattice: states are (cell, one of 16 headings), edges are the
 * precomputed primitives. Collision checks are lookups of each primitive's swept cells.
 */
export function latticeAStar(pr: VehicleProblem, table: LatticeTable, limit: number): VehicleResult {
  const { space, rec } = pr;
  const { w, h } = space;
  const blocked = space.layer.blocked;
  const tree = new VehicleTree();
  const sCell = cellOf(space, pr.start.x, pr.start.y);
  const gCell = cellOf(space, pr.goal.x, pr.goal.y);
  const sHead = nearestLatticeHeading(pr.start.theta);
  const gHead = nearestLatticeHeading(pr.goal.theta);
  const keyOf = (cell: number, hd: number) => cell * 16 + hd;
  const best = new Map<number, number>();
  const closed = new Set<number>();
  const g: number[] = [];
  const nodeKey: number[] = [];
  const prim: Array<Primitive | null> = [];
  const heap = new MinHeap();
  const centre = (cell: number): Pose => ({ x: (cell % w) + 0.5, y: Math.floor(cell / w) + 0.5, theta: 0 });
  // The field is an 8-direction grid cost, up to OCTILE_OVER_EUCLID times the straight-line
  // distance on open diagonals. Shrink it by that much so the heuristic never overestimates and
  // A* stays optimal over the primitives (the shared field stays as it is for Hybrid A*).
  const hOf = (cell: number) => {
    const f = pr.field[cell];
    if (!Number.isFinite(f)) return Infinity;
    const c = centre(cell);
    return Math.max(f / OCTILE_OVER_EUCLID, Math.hypot(pr.goal.x - c.x, pr.goal.y - c.y) * space.minCostPerUnit);
  };
  const sp = centre(sCell);
  const root = tree.add({ x: sp.x, y: sp.y, theta: LATTICE_ANGLES[sHead] }, -1, 1);
  g.push(0);
  nodeKey.push(keyOf(sCell, sHead));
  prim.push(null);
  best.set(nodeKey[0], root);
  heap.push(root, hOf(sCell), 0);
  rec.open(root, -1, 0, hOf(sCell));
  let expanded = 0;
  let pushes = 1;
  let maxOpen = 1;
  let found = -1;
  let reason = '';
  while (heap.size) {
    const n = heap.pop();
    const k = nodeKey[n];
    if (closed.has(k)) continue;
    closed.add(k);
    rec.close(n);
    expanded++;
    const cell = Math.floor(k / 16);
    const hd = k % 16;
    if (cell === gCell && (pr.anyHeading || hd === gHead)) {
      found = n;
      break;
    }
    if (expanded >= limit) {
      reason = `Stopped after ${limit.toLocaleString()} expansions without reaching the goal.`;
      break;
    }
    const cx = cell % w;
    const cy = (cell - cx) / w;
    for (const p of table.prims[hd]) {
      const nx = cx + p.dx;
      const ny = cy + p.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nc = ny * w + nx;
      const nk = keyOf(nc, p.to);
      if (closed.has(nk)) continue;
      let ok = true;
      const sw = p.swept;
      for (let q = 0; q < sw.length; q += 2) {
        const x = cx + sw[q];
        const y = cy + sw[q + 1];
        if (x < 0 || y < 0 || x >= w || y >= h || blocked[y * w + x]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const hh = hOf(nc);
      if (!Number.isFinite(hh)) continue;
      let cost: number;
      if (p.pivot) cost = pivotCost(pr, p.turn);
      else {
        let m = 0;
        let cnt = 0;
        for (let q = 0; q < p.poses.length; q += 8) {
          const x = Math.floor(cx + 0.5 + p.poses[q]);
          const y = Math.floor(cy + 0.5 + p.poses[q + 1]);
          m += x >= 0 && y >= 0 && x < w && y < h ? space.multiplier(y * w + x) : 1;
          cnt++;
        }
        cost = p.length * (m / Math.max(1, cnt)) * (p.dir < 0 ? pr.spec.reversePenalty : 1) + 0.15 * p.turn;
        const pp = prim[n];
        const lastDir = pp ? pp.dir : p.dir;
        if (pp && !pp.pivot && lastDir !== p.dir) cost += pr.spec.switchPenalty;
      }
      const ng = g[n] + cost;
      const prev = best.get(nk);
      if (prev !== undefined && g[prev] <= ng) continue;
      const pts: number[] = [];
      for (let q = 0; q < p.poses.length; q += 8) pts.push(cx + 0.5 + p.poses[q], cy + 0.5 + p.poses[q + 1]);
      pts.push(nx + 0.5, ny + 0.5);
      const id = tree.add({ x: nx + 0.5, y: ny + 0.5, theta: LATTICE_ANGLES[p.to] }, n, p.dir, pts, 2);
      g.push(ng);
      nodeKey.push(nk);
      prim.push(p);
      best.set(nk, id);
      heap.push(id, ng + hh, -ng);
      rec.open(id, n, ng, ng + hh);
      pushes++;
      if (heap.size > maxOpen) maxOpen = heap.size;
    }
  }
  if (!heap.size && found < 0 && !reason) reason = 'Every reachable lattice state was explored: no path made of these primitives.';
  const perHeading = table.prims[0].length;
  const extra: Array<[string, string]> = [
    ['Lattice states', `${closed.size.toLocaleString()} closed · 16 headings`],
    ['Primitives', `${table.count} (${perHeading} per heading)`],
  ];
  if (found < 0) return { found: false, poses: [], expanded, pushes, maxOpen, tree, shot: null, extra, reason };
  const poses = chainPoses({ ...pr, start: { x: sp.x, y: sp.y, theta: LATTICE_ANGLES[sHead] } }, tree, found, (child, parent, out) => {
    const p = prim[child]!;
    const px = tree.x[parent];
    const py = tree.y[parent];
    for (let q = 4; q < p.poses.length; q += 4) out.push(px + p.poses[q], py + p.poses[q + 1], p.poses[q + 2], p.dir);
  });
  return { found: true, poses, expanded, pushes, maxOpen, tree, shot: null, extra, reason };
}

// ---------------------------------------------------------------------------
// RRT with car steering
// ---------------------------------------------------------------------------

export interface RrtConfig {
  iterations: number;
  seed: number;
}

/**
 * RRT where every extension is drivable: from the nearest node (by distance plus
 * heading difference), follow the shortest Reeds-Shepp or Dubins curve toward a
 * random pose for at most one step, keep it if the footprint stays clear. Near the
 * goal it tries the full curve to the goal. One query, one tree, nothing kept.
 */
export function vehicleRRT(pr: VehicleProblem, cfg: RrtConfig): VehicleResult {
  const { space, check, radius, rec } = pr;
  const rng = makeRng(cfg.seed * 7919 + 13);
  const tree = new VehicleTree();
  const root = tree.add(pr.start, -1, 1);
  rec.open(root, -1);
  rec.close(root);
  const traj: number[][] = [[]];
  const step = Math.max(3, radius * 1.5);
  const free: number[] = [];
  const need = Math.min(pr.spec.width / 2, pr.spec.rear, pr.spec.length - pr.spec.rear) - 0.5;
  for (let i = 0; i < space.count; i++) if (pr.field[i] < Infinity || pr.check.dist[i] >= need) free.push(i);
  let found = -1;
  let shot: number[] | null = null;
  let iterations = 0;
  let shotsTried = 0;
  for (; iterations < cfg.iterations; iterations++) {
    let target: Pose;
    if (rng() < 0.1) target = pr.anyHeading ? { x: pr.goal.x, y: pr.goal.y, theta: rng() * 2 * Math.PI } : pr.goal;
    else {
      const c = free[Math.floor(rng() * free.length)];
      target = { x: (c % space.w) + rng(), y: Math.floor(c / space.w) + rng(), theta: rng() * 2 * Math.PI };
    }
    let near = 0;
    let nd = Infinity;
    for (let i = 0; i < tree.size; i++) {
      const d = Math.hypot(tree.x[i] - target.x, tree.y[i] - target.y) + 0.5 * radius * Math.abs(wrapPi(tree.t[i] - target.theta));
      if (d < nd) {
        nd = d;
        near = i;
      }
    }
    const from = tree.pose(near);
    const curve = curveCandidates(from, target, radius, pr.reverse)[0];
    if (!curve) continue;
    const part = truncatePath(curve, step);
    const poses = samplePath(from, part, CHECK_STEP);
    if (!check.freeAlong(poses, 4)) continue;
    const e = poses.length - 4;
    const id = tree.add({ x: poses[e], y: poses[e + 1], theta: poses[e + 2] }, near, poses[e + 3], poses, 4);
    traj.push(poses);
    rec.open(id, near);
    rec.close(id);
    const np = tree.pose(id);
    if (Math.hypot(pr.goal.x - np.x, pr.goal.y - np.y) < 3 * step) {
      shotsTried++;
      const s = tryShot(pr, np, 3);
      if (s) {
        found = id;
        shot = s;
        break;
      }
    }
  }
  const extra: Array<[string, string]> = [
    ['Tree nodes', tree.size.toLocaleString()],
    ['Iterations', `${Math.min(iterations + 1, cfg.iterations).toLocaleString()} of ${cfg.iterations.toLocaleString()}`],
    ['Step', `${step.toFixed(1)} cells`],
    ['Goal shots', `${shotsTried} tried`],
  ];
  const n = tree.size;
  if (found < 0)
    return { found: false, poses: [], expanded: n, pushes: n, maxOpen: 0, tree, shot: null, extra, reason: `No path within ${cfg.iterations.toLocaleString()} iterations. A sampling planner can't tell "unreachable" from "not lucky yet".` };
  const poses = chainPoses(pr, tree, found, (child, _parent, out) => {
    const t = traj[child];
    for (let q = 4; q < t.length; q++) out.push(t[q]);
  });
  for (let q = 4; q < shot!.length; q++) poses.push(shot![q]);
  return { found: true, poses, expanded: n, pushes: n, maxOpen: 0, tree, shot, extra, reason: '' };
}
