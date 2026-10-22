import { MinHeap } from '../core/heap';
import type { GridSpace } from '../graph/gridSpace';

/**
 * HPA* (Botea, Müller & Schaeffer, 2004): the grid is cut into square clusters
 * ("tiles"). Wherever a unit can cross between two neighbouring tiles we place a
 * pair of entrance nodes ("doors"), one on each side. Inside each tile we cache the
 * cheapest route between every pair of its doors. A query then searches the small
 * graph of doors and fills in each hop from the cache.
 *
 * Two build modes:
 *  - eager: every tile's door-to-door routes are computed up front;
 *  - lazy:  a tile's routes are computed the first time a query reaches it, then kept.
 *
 * Edits only rebuild the tiles they touch (plus their neighbours, whose doors share
 * the changed borders). Everything else stays cached.
 */

export interface IntraEdge {
  to: number; // cell id of the other door
  cost: number;
  path: Int32Array; // cell ids from this door to `to`, inclusive
}

/** Result of a search confined to a rectangle. */
export interface LocalSearch {
  expanded: number;
  /** Cost from the source (Infinity if not reached). */
  dist(cell: number): number;
  /** Cells from the source to `to`, inclusive. */
  trace(to: number): Int32Array;
}

export interface ClusterCache {
  edges: Map<number, IntraEdge[]>;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number; // inclusive
  y1: number;
}

export class HpaGraph {
  readonly C: number;
  readonly w: number;
  readonly h: number;
  readonly cw: number; // clusters across
  readonly chh: number; // clusters down
  space: GridSpace;
  /** Door pairs on the border between cluster (cx,cy) and (cx+1,cy): flat [a,b,a,b,...]. */
  private vBorders: number[][];
  /** Door pairs on the border between cluster (cx,cy) and (cx,cy+1). */
  private hBorders: number[][];
  /** Doors inside each cluster (unique cell ids). */
  clusterNodes: number[][];
  /** Cached door-to-door routes per cluster; null = not built yet (lazy) or invalidated. */
  intra: Array<ClusterCache | null>;
  /** Edges crossing a border, keyed by door cell. */
  inter = new Map<number, Array<{ to: number; cost: number }>>();
  /** Clusters rebuilt by the most recent update (drawn highlighted). */
  lastRebuilt = new Set<number>();
  /** Clusters whose routes were built by the most recent query (lazy mode). */
  lastQueryBuilt = new Set<number>();
  buildMsTotal = 0;

  constructor(
    space: GridSpace,
    C: number,
    readonly lazy: boolean,
  ) {
    this.space = space;
    this.C = C;
    this.w = space.w;
    this.h = space.h;
    this.cw = Math.ceil(this.w / C);
    this.chh = Math.ceil(this.h / C);
    const n = this.cw * this.chh;
    this.vBorders = Array.from({ length: n }, () => []);
    this.hBorders = Array.from({ length: n }, () => []);
    this.clusterNodes = Array.from({ length: n }, () => []);
    this.intra = new Array(n).fill(null);
    const t0 = performance.now();
    for (let c = 0; c < n; c++) {
      this.computeBorders(c);
    }
    for (let c = 0; c < n; c++) this.computeNodes(c);
    this.rebuildInter();
    if (!lazy) for (let c = 0; c < n; c++) this.buildCluster(c);
    this.buildMsTotal = performance.now() - t0;
    this.lastRebuilt = new Set(Array.from({ length: n }, (_, i) => i));
  }

  get clusterCount(): number {
    return this.cw * this.chh;
  }

  clusterOf(cell: number): number {
    const x = cell % this.w;
    const y = (cell - x) / this.w;
    return Math.floor(y / this.C) * this.cw + Math.floor(x / this.C);
  }

  bounds(c: number): Rect {
    const cx = c % this.cw;
    const cy = (c - cx) / this.cw;
    return {
      x0: cx * this.C,
      y0: cy * this.C,
      x1: Math.min(this.w, (cx + 1) * this.C) - 1,
      y1: Math.min(this.h, (cy + 1) * this.C) - 1,
    };
  }

  builtCount(): number {
    let k = 0;
    for (const c of this.intra) if (c) k++;
    return k;
  }

  nodeCount(): number {
    let k = 0;
    for (const n of this.clusterNodes) k += n.length;
    return k;
  }

  intraEdgeCount(): number {
    let k = 0;
    for (const c of this.intra) if (c) for (const list of c.edges.values()) k += list.length;
    return k / 2;
  }

  interEdgeCount(): number {
    let k = 0;
    for (const list of this.inter.values()) k += list.length;
    return k / 2;
  }

  /** All door pairs, for drawing. */
  *doorPairs(): Generator<[number, number]> {
    for (const list of [this.vBorders, this.hBorders])
      for (const pairs of list) for (let i = 0; i < pairs.length; i += 2) yield [pairs[i], pairs[i + 1]];
  }

  // ---------- Construction ----------

  /** Find doors on cluster c's right and bottom borders. */
  private computeBorders(c: number): void {
    const { C, w, h, space } = this;
    const cx = c % this.cw;
    const cy = (c - cx) / this.cw;
    const b = this.bounds(c);
    // Right border: column x1 | x1+1.
    const v: number[] = [];
    if (cx < this.cw - 1) {
      const xl = b.x1;
      this.scanRuns(b.y0, b.y1, (y) => space.ok(xl, y) && space.ok(xl + 1, y), (y) => v.push(y * w + xl, y * w + xl + 1));
    }
    this.vBorders[c] = v;
    // Bottom border: row y1 | y1+1.
    const hz: number[] = [];
    if (cy < this.chh - 1) {
      const yt = b.y1;
      this.scanRuns(b.x0, b.x1, (x) => space.ok(x, yt) && space.ok(x, yt + 1), (x) => hz.push(yt * w + x, (yt + 1) * w + x));
    }
    this.hBorders[c] = hz;
    void C;
    void h;
  }

  /**
   * Walk a border; each maximal run of crossable cells becomes one door (in the middle)
   * if short, or doors at both ends (as in the HPA* paper) plus one every ~6 cells between.
   */
  private scanRuns(a: number, b: number, open: (i: number) => boolean, emit: (i: number) => void): void {
    let i = a;
    while (i <= b) {
      if (!open(i)) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 <= b && open(j + 1)) j++;
      const len = j - i + 1;
      if (len < 6) emit(i + ((len - 1) >> 1));
      else {
        // Long openings: both ends, as in the paper, plus evenly spaced doors between them
        // so paths crossing the middle of a wide opening don't detour to an end.
        const gaps = Math.max(1, Math.round((len - 1) / 6));
        for (let k = 0; k <= gaps; k++) emit(i + Math.round(((len - 1) * k) / gaps));
      }
      i = j + 1;
    }
  }

  private computeNodes(c: number): void {
    const set = new Set<number>();
    const cx = c % this.cw;
    const cy = (c - cx) / this.cw;
    const take = (pairs: number[], side: 0 | 1) => {
      for (let i = 0; i < pairs.length; i += 2) set.add(pairs[i + side]);
    };
    take(this.vBorders[c], 0);
    take(this.hBorders[c], 0);
    if (cx > 0) take(this.vBorders[c - 1], 1);
    if (cy > 0) take(this.hBorders[c - this.cw], 1);
    this.clusterNodes[c] = [...set].sort((p, q) => p - q);
  }

  private rebuildInter(): void {
    this.inter.clear();
    const add = (a: number, b: number) => {
      const cost = this.space.stepCost(a, b, 1);
      let la = this.inter.get(a);
      if (!la) this.inter.set(a, (la = []));
      la.push({ to: b, cost });
      let lb = this.inter.get(b);
      if (!lb) this.inter.set(b, (lb = []));
      lb.push({ to: a, cost });
    };
    for (const [a, b] of this.doorPairs()) add(a, b);
  }

  /**
   * Dijkstra from one cell, confined to a rectangle, on flat typed arrays indexed by
   * position inside the rectangle. Stops early once every cell in `stop` is settled.
   */
  localDijkstra(from: number, r: Rect, stop?: Set<number>): LocalSearch {
    const w = this.w;
    const bw = r.x1 - r.x0 + 1;
    const bh = r.y1 - r.y0 + 1;
    const dist = new Float64Array(bw * bh).fill(Infinity);
    const parent = new Int32Array(bw * bh).fill(-1);
    const done = new Uint8Array(bw * bh);
    const li = (cell: number) => {
      const x = cell % w;
      const y = (cell - x) / w;
      return x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1 ? -1 : (y - r.y0) * bw + (x - r.x0);
    };
    const heap = new MinHeap(64);
    dist[li(from)] = 0;
    heap.push(from, 0);
    let expanded = 0;
    let remaining = stop ? stop.size : -1;
    while (heap.size) {
      const cur = heap.pop();
      const ci = li(cur);
      if (done[ci]) continue;
      done[ci] = 1;
      expanded++;
      if (stop && stop.has(cur) && --remaining <= 0) break;
      const dc = dist[ci];
      this.space.neighbors(cur, (nb, cost) => {
        const ni = li(nb);
        if (ni < 0) return;
        const nd = dc + cost;
        if (nd < dist[ni] - 1e-12) {
          dist[ni] = nd;
          parent[ni] = cur;
          heap.push(nb, nd);
        }
      });
    }
    return {
      expanded,
      dist: (cell) => {
        const i = li(cell);
        return i < 0 ? Infinity : dist[i];
      },
      trace: (to) => {
        const out: number[] = [];
        let c = to;
        for (let guard = bw * bh + 1; guard > 0 && c !== -1; guard--) {
          out.push(c);
          if (c === from) break;
          const i = li(c);
          c = i < 0 ? -1 : parent[i];
        }
        return Int32Array.from(out.reverse());
      },
    };
  }

  /** Compute and cache door-to-door routes inside cluster c. */
  buildCluster(c: number): void {
    const nodes = this.clusterNodes[c];
    const r = this.bounds(c);
    const edges = new Map<number, IntraEdge[]>();
    for (const n of nodes) edges.set(n, []);
    const targets = new Set(nodes);
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const search = this.localDijkstra(a, r, targets);
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const d = search.dist(b);
        if (d === Infinity) continue;
        const path = search.trace(b);
        edges.get(a)!.push({ to: b, cost: d, path });
        edges.get(b)!.push({ to: a, cost: d, path: path.slice().reverse() });
      }
    }
    this.intra[c] = { edges };
  }

  /** Make sure cluster c's routes exist. Returns true if it had to build them. */
  ensure(c: number): boolean {
    if (this.intra[c]) return false;
    const t0 = performance.now();
    this.buildCluster(c);
    this.buildMsTotal += performance.now() - t0;
    this.lastQueryBuilt.add(c);
    return true;
  }

  /**
   * Rebuild after an edit. `changed` is the bounding box of edited cells; passability can
   * change up to (need - 1) cells further out, and doors live on borders, so the box is
   * grown accordingly before picking clusters.
   */
  update(space: GridSpace, changed: Rect): number {
    const t0 = performance.now();
    this.space = space;
    const grow = space.opts.need;
    const x0 = Math.max(0, changed.x0 - grow);
    const y0 = Math.max(0, changed.y0 - grow);
    const x1 = Math.min(this.w - 1, changed.x1 + grow);
    const y1 = Math.min(this.h - 1, changed.y1 + grow);
    const dirty = new Set<number>();
    for (let cy = Math.floor(y0 / this.C); cy <= Math.floor(y1 / this.C); cy++)
      for (let cx = Math.floor(x0 / this.C); cx <= Math.floor(x1 / this.C); cx++) dirty.add(cy * this.cw + cx);
    // Borders owned by dirty clusters and by their left/top neighbours (who own the shared border).
    const borderOwners = new Set<number>();
    for (const c of dirty) {
      borderOwners.add(c);
      const cx = c % this.cw;
      if (cx > 0) borderOwners.add(c - 1);
      if (c >= this.cw) borderOwners.add(c - this.cw);
    }
    for (const c of borderOwners) this.computeBorders(c);
    // Every cluster touching a recomputed border may have new doors.
    const affected = new Set<number>(dirty);
    for (const c of borderOwners) {
      affected.add(c);
      const cx = c % this.cw;
      if (cx < this.cw - 1) affected.add(c + 1);
      if (c + this.cw < this.clusterCount) affected.add(c + this.cw);
    }
    for (const c of affected) {
      this.computeNodes(c);
      this.intra[c] = null;
    }
    this.rebuildInter();
    if (!this.lazy) for (const c of affected) this.buildCluster(c);
    this.lastRebuilt = affected;
    const ms = performance.now() - t0;
    this.buildMsTotal += ms;
    return ms;
  }
}
