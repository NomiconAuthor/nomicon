import { MinHeap } from '../core/heap';
import type { GridSpace } from '../graph/gridSpace';
import type { Recorder } from '../search/types';
import type { Rect } from './hpaGraph';
import type { Pt } from './types';

/**
 * Shared machinery for sampling-based roadmaps. Points live in continuous map
 * coordinates (1 unit = 1 cell). A point is free when the cell under it is
 * standable for the unit (clearance >= its size), so every planner here sees the
 * same world as the grid, HPA* and the navmesh.
 */

/** Collision checks, counted so the stats can show what each planner pays for. */
export class Collision {
  segmentChecks = 0;
  pointChecks = 0;
  constructor(readonly space: GridSpace) {}

  pointFree(x: number, y: number): boolean {
    this.pointChecks++;
    return this.space.ok(Math.floor(x), Math.floor(y));
  }

  /**
   * Walks every cell a straight segment passes through (a DDA traversal). Passing
   * exactly through a cell corner needs both side cells free unless the diagonal
   * rule allows corner cutting, matching the grid's rules.
   */
  segmentFree(ax: number, ay: number, bx: number, by: number): boolean {
    this.segmentChecks++;
    const sp = this.space;
    let x = Math.floor(ax);
    let y = Math.floor(ay);
    const ex = Math.floor(bx);
    const ey = Math.floor(by);
    if (!sp.ok(x, y)) return false;
    const dx = bx - ax;
    const dy = by - ay;
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = dx > 0 ? (x + 1 - ax) / dx : dx < 0 ? (ax - x) / -dx : Infinity;
    let tmy = dy > 0 ? (y + 1 - ay) / dy : dy < 0 ? (ay - y) / -dy : Infinity;
    const cut = sp.opts.diagonal === 'always';
    let guard = Math.abs(ex - x) + Math.abs(ey - y) + 4;
    while ((x !== ex || y !== ey) && guard-- > 0) {
      if (Math.abs(tmx - tmy) < 1e-9) {
        if (!cut && (!sp.ok(x + sx, y) || !sp.ok(x, y + sy))) return false;
        x += sx;
        y += sy;
        tmx += tdx;
        tmy += tdy;
      } else if (tmx < tmy) {
        x += sx;
        tmx += tdx;
      } else {
        y += sy;
        tmy += tdy;
      }
      if (!sp.ok(x, y)) return false;
    }
    return true;
  }

  /** Cost of a straight segment: length x the average terrain multiplier under it. */
  segmentCost(ax: number, ay: number, bx: number, by: number): number {
    const len = Math.hypot(bx - ax, by - ay);
    if (this.space.uniformCost || len === 0) return len;
    const steps = Math.max(1, Math.ceil(len * 2));
    let sum = 0;
    const w = this.space.w;
    for (let i = 0; i < steps; i++) {
      const f = (i + 0.5) / steps;
      const cx = Math.floor(ax + (bx - ax) * f);
      const cy = Math.floor(ay + (by - ay) * f);
      sum += this.space.multiplier(cy * w + cx);
    }
    return (len * sum) / steps;
  }
}

/** Uniform-grid spatial hash over node positions, for nearest and radius queries. */
export class SpatialHash {
  private buckets = new Map<number, number[]>();
  constructor(
    readonly size: number,
    private xs: () => Float64Array | number[],
    private ys: () => Float64Array | number[],
  ) {}
  private key(cx: number, cy: number): number {
    return (cy + 4096) * 16384 + (cx + 4096);
  }
  insert(id: number, x: number, y: number): void {
    const k = this.key(Math.floor(x / this.size), Math.floor(y / this.size));
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = []));
    b.push(id);
  }
  remove(id: number, x: number, y: number): void {
    const b = this.buckets.get(this.key(Math.floor(x / this.size), Math.floor(y / this.size)));
    if (!b) return;
    const i = b.indexOf(id);
    if (i >= 0) b.splice(i, 1);
  }
  /** Ids within radius r of (x, y). */
  within(x: number, y: number, r: number, out: number[] = []): number[] {
    const xs = this.xs();
    const ys = this.ys();
    const c0 = Math.floor((x - r) / this.size);
    const c1 = Math.floor((x + r) / this.size);
    const r0 = Math.floor((y - r) / this.size);
    const r1 = Math.floor((y + r) / this.size);
    const r2 = r * r;
    for (let cy = r0; cy <= r1; cy++)
      for (let cx = c0; cx <= c1; cx++) {
        const b = this.buckets.get(this.key(cx, cy));
        if (!b) continue;
        for (const id of b) {
          const dx = xs[id] - x;
          const dy = ys[id] - y;
          if (dx * dx + dy * dy <= r2) out.push(id);
        }
      }
    return out;
  }
  /** Nearest id passing `accept`, searching outward ring by ring. -1 if none. */
  nearest(x: number, y: number, accept: (id: number) => boolean = () => true, maxRings = 4096): number {
    const xs = this.xs();
    const ys = this.ys();
    const cx = Math.floor(x / this.size);
    const cy = Math.floor(y / this.size);
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring <= maxRings; ring++) {
      // Once a candidate is found, one more ring is enough to be sure.
      if (best >= 0 && (ring - 1) * this.size > Math.sqrt(bestD)) break;
      let any = false;
      for (let gy = cy - ring; gy <= cy + ring; gy++)
        for (let gx = cx - ring; gx <= cx + ring; gx++) {
          if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== ring) continue;
          const b = this.buckets.get(this.key(gx, gy));
          if (!b) continue;
          any = true;
          for (const id of b) {
            if (!accept(id)) continue;
            const dx = xs[id] - x;
            const dy = ys[id] - y;
            const d = dx * dx + dy * dy;
            if (d < bestD) {
              bestD = d;
              best = id;
            }
          }
        }
      if (!any && ring > 0 && this.buckets.size === 0) break;
    }
    return best;
  }
}

export interface Edge {
  to: number;
  cost: number;
  /** Collision-checked yet? (Lazy PRM leaves edges unchecked until a path uses them.) */
  checked: boolean;
}

/** An undirected roadmap graph with removable nodes. */
export class Roadmap {
  xs: number[] = [];
  ys: number[] = [];
  adj: Edge[][] = [];
  alive: boolean[] = [];
  /** Query number in which each node was added (for highlighting new growth). */
  born: number[] = [];
  hash: SpatialHash;
  edgeCount = 0;

  constructor(bucket: number) {
    this.hash = new SpatialHash(
      bucket,
      () => this.xs,
      () => this.ys,
    );
  }

  get size(): number {
    return this.xs.length;
  }

  aliveCount(): number {
    let n = 0;
    for (const a of this.alive) if (a) n++;
    return n;
  }

  addNode(x: number, y: number, born = 0): number {
    const id = this.xs.length;
    this.xs.push(x);
    this.ys.push(y);
    this.adj.push([]);
    this.alive.push(true);
    this.born.push(born);
    this.hash.insert(id, x, y);
    return id;
  }

  hasEdge(a: number, b: number): boolean {
    return this.adj[a].some((e) => e.to === b);
  }

  addEdge(a: number, b: number, cost: number, checked = true): void {
    if (a === b || this.hasEdge(a, b)) return;
    this.adj[a].push({ to: b, cost, checked });
    this.adj[b].push({ to: a, cost, checked });
    this.edgeCount++;
  }

  removeEdge(a: number, b: number): void {
    const i = this.adj[a].findIndex((e) => e.to === b);
    if (i < 0) return;
    this.adj[a].splice(i, 1);
    const j = this.adj[b].findIndex((e) => e.to === a);
    if (j >= 0) this.adj[b].splice(j, 1);
    this.edgeCount--;
  }

  removeNode(id: number): void {
    if (!this.alive[id]) return;
    for (const e of [...this.adj[id]]) this.removeEdge(id, e.to);
    this.alive[id] = false;
    this.hash.remove(id, this.xs[id], this.ys[id]);
  }

  /**
   * Repair after an edit: drop nodes that are no longer free and re-check every edge
   * whose bounding box touches the edited area. Returns how many edges were re-checked.
   */
  repair(col: Collision, box: Rect, lazy: boolean): { removedNodes: number; recheckedEdges: number; removedEdges: number } {
    const grow = col.space.opts.need + 1;
    const x0 = box.x0 - grow;
    const y0 = box.y0 - grow;
    const x1 = box.x1 + 1 + grow;
    const y1 = box.y1 + 1 + grow;
    let removedNodes = 0;
    let recheckedEdges = 0;
    let removedEdges = 0;
    for (let i = 0; i < this.size; i++) {
      if (!this.alive[i]) continue;
      if (this.xs[i] >= x0 && this.xs[i] <= x1 && this.ys[i] >= y0 && this.ys[i] <= y1 && !col.pointFree(this.xs[i], this.ys[i])) {
        this.removeNode(i);
        removedNodes++;
      }
    }
    for (let a = 0; a < this.size; a++) {
      if (!this.alive[a]) continue;
      for (const e of [...this.adj[a]]) {
        const b = e.to;
        if (b < a) continue;
        const ex0 = Math.min(this.xs[a], this.xs[b]);
        const ex1 = Math.max(this.xs[a], this.xs[b]);
        const ey0 = Math.min(this.ys[a], this.ys[b]);
        const ey1 = Math.max(this.ys[a], this.ys[b]);
        if (ex1 < x0 || ex0 > x1 || ey1 < y0 || ey0 > y1) continue;
        recheckedEdges++;
        if (lazy) {
          // Lazy roadmaps just forget what they knew; the next query checks again.
          e.checked = false;
          const back = this.adj[b].find((q) => q.to === a);
          if (back) back.checked = false;
          e.cost = col.segmentCost(this.xs[a], this.ys[a], this.xs[b], this.ys[b]);
          if (back) back.cost = e.cost;
        } else if (!col.segmentFree(this.xs[a], this.ys[a], this.xs[b], this.ys[b])) {
          this.removeEdge(a, b);
          removedEdges++;
        } else {
          const c = col.segmentCost(this.xs[a], this.ys[a], this.xs[b], this.ys[b]);
          e.cost = c;
          const back = this.adj[b].find((q) => q.to === a);
          if (back) back.cost = c;
        }
      }
    }
    return { removedNodes, recheckedEdges, removedEdges };
  }

  /**
   * Connect node id to up to k nearest live nodes within radius r that it can see.
   * `lazy` adds edges without collision checks.
   */
  connect(col: Collision, id: number, k: number, r: number, lazy = false, accept?: (j: number) => boolean): number {
    const x = this.xs[id];
    const y = this.ys[id];
    const cand = this.hash
      .within(x, y, r)
      .filter((j) => j !== id && this.alive[j] && (!accept || accept(j)))
      .map((j) => ({ j, d: (this.xs[j] - x) ** 2 + (this.ys[j] - y) ** 2 }))
      .sort((p, q) => p.d - q.d);
    let made = 0;
    for (const { j } of cand) {
      if (made >= k) break;
      if (this.hasEdge(id, j)) {
        made++;
        continue;
      }
      if (lazy) {
        this.addEdge(id, j, col.segmentCost(x, y, this.xs[j], this.ys[j]), false);
        made++;
      } else if (col.segmentFree(x, y, this.xs[j], this.ys[j])) {
        this.addEdge(id, j, col.segmentCost(x, y, this.xs[j], this.ys[j]), true);
        made++;
      }
    }
    return made;
  }
}

/** A* over a roadmap; records events with roadmap node ids. */
export function roadmapAStar(
  g: Roadmap,
  s: number,
  t: number,
  minCost: number,
  rec: Recorder,
  usable: (a: number, e: Edge) => boolean = () => true,
): { found: boolean; path: number[]; expanded: number; pushes: number; maxOpen: number; cost: number } {
  const n = g.size;
  const gs = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = new MinHeap(256);
  const tx = g.xs[t];
  const ty = g.ys[t];
  const h = (i: number) => minCost * Math.hypot(g.xs[i] - tx, g.ys[i] - ty);
  gs[s] = 0;
  open.push(s, h(s), 0);
  rec.open(s, -1, 0, h(s));
  let expanded = 0;
  let pushes = 1;
  let maxOpen = 1;
  while (open.size) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    rec.close(cur);
    if (cur === t) {
      const path: number[] = [];
      for (let c = t; c !== -1; c = parent[c]) path.push(c);
      return { found: true, path: path.reverse(), expanded, pushes, maxOpen, cost: gs[t] };
    }
    for (const e of g.adj[cur]) {
      if (closed[e.to] || !usable(cur, e)) continue;
      const ng = gs[cur] + e.cost;
      if (ng < gs[e.to] - 1e-12) {
        gs[e.to] = ng;
        parent[e.to] = cur;
        open.push(e.to, ng + h(e.to), -ng);
        rec.open(e.to, cur, ng, ng + h(e.to));
        pushes++;
      }
    }
    if (open.size > maxOpen) maxOpen = open.size;
  }
  return { found: false, path: [], expanded, pushes, maxOpen, cost: Infinity };
}

/** Line-of-sight shortcutting for point paths (continuous). */
export function shortcutPoints(col: Collision, p: Pt[]): Pt[] {
  if (p.length < 3) return p.slice();
  const out = [p[0]];
  let i = 0;
  while (i < p.length - 1) {
    let j = p.length - 1;
    while (j > i + 1 && !col.segmentFree(p[i].x, p[i].y, p[j].x, p[j].y)) j--;
    out.push(p[j]);
    i = j;
  }
  return out;
}

export function pathCost(col: Collision, p: Pt[]): number {
  let c = 0;
  for (let k = 1; k < p.length; k++) c += col.segmentCost(p[k - 1].x, p[k - 1].y, p[k].x, p[k].y);
  return c;
}

/** Uniform random free point (rejection sampling), or null after many misses. */
export function sampleFree(col: Collision, rng: () => number, x0 = 0, y0 = 0, x1?: number, y1?: number): Pt | null {
  const W = x1 ?? col.space.w;
  const H = y1 ?? col.space.h;
  for (let tries = 0; tries < 200; tries++) {
    const x = x0 + rng() * (W - x0);
    const y = y0 + rng() * (H - y0);
    if (col.pointFree(x, y)) return { x, y };
  }
  return null;
}
