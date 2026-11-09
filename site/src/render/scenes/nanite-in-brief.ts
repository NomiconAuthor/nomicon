/**
 * The Nanite lesson's models, both on the CPU:
 *
 * - A cluster LOD hierarchy built the way Nanite builds its DAG, one dimension down: the "mesh" is
 *   a closed outline of 1,024 line segments, a cluster is 8 segments, and each level groups 4
 *   neighbouring clusters, simplifies the group to half its segments with the group's ends locked,
 *   and splits it into 2 new clusters. Groups at the next level straddle the old group boundaries,
 *   so no edge stays locked for ever. A cut is chosen per frame by projected error.
 * - Small triangles and 2 × 2 quads: a square of screen covered by ever smaller triangles,
 *   counting the pixels each covers and the quad lanes a hardware rasteriser would launch.
 *
 * No DOM, so the claims run the same code in Node. No trig: the outline is built by midpoint
 * displacement with a seeded generator, and distances use sqrt only.
 */
import { edge, isTopLeft } from '../raster';

// ---------------------------------------------------------------------------------------------
// The outline

export interface P2 {
  x: number;
  y: number;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Segments in the full-detail outline, per cluster, and clusters per group. */
export const SEGMENTS = 1024;
export const PER_CLUSTER = 8;
export const PER_GROUP = 4;
/** The world is the widget's canvas: 640 × 400 units. */
export const WORLD_W = 640;
export const WORLD_H = 400;

/**
 * A rocky closed outline, 1,024 vertices: 16 hand-placed points, each edge split 6 times with a
 * seeded sideways nudge that halves at every split (a fractal coastline).
 */
export function outline(): P2[] {
  const base: P2[] = [
    [420, 120], [470, 150], [500, 200], [490, 250], [450, 290], [400, 300], [350, 285], [300, 300],
    [245, 290], [200, 265], [175, 220], [185, 170], [220, 130], [270, 110], [320, 120], [370, 105],
  ].map(([x, y]) => ({ x: 320 + (x - 337) * 1.45, y: 200 + (y - 205) * 1.45 }));
  const r = lcg(11);
  let pts = base;
  let amp = 20;
  for (let level = 0; level < 6; level++) {
    const next: P2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const t = (r() * 2 - 1) * amp;
      next.push(a, { x: (a.x + b.x) / 2 - (dy / len) * t, y: (a.y + b.y) / 2 + (dx / len) * t });
    }
    pts = next;
    amp *= 0.5;
  }
  return pts;
}

// ---------------------------------------------------------------------------------------------
// Simplification: drop vertices (never move them) with the chain's two ends locked.

function segDist(p: P2, a: P2, b: P2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = a.x + t * dx - p.x;
  const ey = a.y + t * dy - p.y;
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * Simplify a chain of original vertex indices (along the loop, `from` .. `from + span`) to `target`
 * segments by repeatedly removing the interior vertex that adds the least error. Error is the
 * largest distance from any original vertex to the segment that now spans it.
 */
function simplify(pts: P2[], chain: number[], target: number): { chain: number[]; error: number } {
  const N = pts.length;
  const at = (i: number) => pts[((i % N) + N) % N];
  const spanErr = (a: number, b: number) => {
    let e = 0;
    for (let i = a + 1; i < b; i++) e = Math.max(e, segDist(at(i), at(a), at(b)));
    return e;
  };
  let c = [...chain];
  let error = 0;
  for (let i = 0; i + 1 < c.length; i++) error = Math.max(error, spanErr(c[i], c[i + 1]));
  while (c.length - 1 > target) {
    let best = -1;
    let bestE = Infinity;
    for (let j = 1; j < c.length - 1; j++) {
      const e = spanErr(c[j - 1], c[j + 1]);
      if (e < bestE) {
        bestE = e;
        best = j;
      }
    }
    error = Math.max(error, bestE);
    c = [...c.slice(0, best), ...c.slice(best + 1)];
  }
  return { chain: c, error };
}

// ---------------------------------------------------------------------------------------------
// The hierarchy

export interface Circle {
  x: number;
  y: number;
  r: number;
}
export interface Cluster {
  id: number;
  level: number;
  /** Original vertex indices along the loop (unwrapped: may run past SEGMENTS), first to last. */
  chain: number[];
  /** Error of the group that made this cluster (0 at level 0), and that group's bounds. */
  error: number;
  bounds: Circle;
  /** Error and bounds of the group this cluster is simplified in, one level up (Infinity at the root). */
  parentError: number;
  parentBounds: Circle;
  /** The clusters this one was made from (none at level 0). */
  children: number[];
}
export type Build = 'dag' | 'alone';
export const BUILD_LABEL: Record<Build, string> = { dag: 'Groups (a DAG, as Nanite does)', alone: 'Each cluster on its own' };

function enclose(cs: Circle[]): Circle {
  let x = 0;
  let y = 0;
  for (const c of cs) {
    x += c.x / cs.length;
    y += c.y / cs.length;
  }
  let r = 0;
  for (const c of cs) r = Math.max(r, Math.sqrt((c.x - x) ** 2 + (c.y - y) ** 2) + c.r);
  return { x, y, r };
}
function boundsOf(pts: P2[], chain: number[]): Circle {
  const N = pts.length;
  const ps: P2[] = [];
  for (let i = chain[0]; i <= chain[chain.length - 1]; i++) ps.push(pts[i % N]);
  return enclose(ps.map((p) => ({ ...p, r: 0 })));
}

export interface Hierarchy {
  build: Build;
  pts: P2[];
  clusters: Cluster[];
  /** Cluster ids per level. */
  levels: number[][];
}

/**
 * Build the hierarchy. 'dag': Nanite's scheme (group 4 neighbours, simplify to half with the group's
 * ends locked, split into 2; the next level's groups start one cluster later, so they straddle the
 * old boundaries). 'alone': every cluster simplified by itself, ends locked, 8 → 4 → 2 → 1 segments.
 */
export function buildHierarchy(build: Build): Hierarchy {
  const pts = outline();
  const clusters: Cluster[] = [];
  const NONE: Circle = { x: 0, y: 0, r: 0 };
  const make = (level: number, chain: number[], error: number, bounds: Circle, children: number[]) => {
    const c: Cluster = { id: clusters.length, level, chain, error, bounds, parentError: Infinity, parentBounds: NONE, children };
    clusters.push(c);
    return c.id;
  };
  const levels: number[][] = [[]];
  const nC = SEGMENTS / PER_CLUSTER;
  for (let k = 0; k < nC; k++) {
    const chain: number[] = [];
    for (let i = 0; i <= PER_CLUSTER; i++) chain.push(k * PER_CLUSTER + i);
    levels[0].push(make(0, chain, 0, boundsOf(pts, chain), []));
  }
  if (build === 'alone') {
    for (const id of [...levels[0]]) {
      let cur = id;
      for (let level = 1, segs = PER_CLUSTER / 2; segs >= 1; level++, segs /= 2) {
        const c = clusters[cur];
        const s = simplify(pts, c.chain, segs);
        const err = Math.max(s.error, c.error);
        const b = enclose([c.bounds, boundsOf(pts, c.chain)]);
        c.parentError = err;
        c.parentBounds = b;
        (levels[level] ??= []).push((cur = make(level, s.chain, err, b, [c.id])));
      }
    }
    return { build, pts, clusters, levels };
  }
  for (let level = 0; levels[level].length > 1; level++) {
    const cur = levels[level];
    const n = cur.length;
    const size = Math.min(PER_GROUP, n);
    // Start the groups one cluster later at every level after the first, so they straddle the old boundaries.
    const start = level === 0 || n <= PER_GROUP ? 0 : 1;
    const next: number[] = [];
    for (let g = 0; g < n / size; g++) {
      const members = Array.from({ length: size }, (_, i) => cur[(start + g * size + i) % n]);
      // The group's chain, unwrapped so indices increase along the loop.
      const chain: number[] = [];
      let off = 0;
      for (const id of members) {
        const ch = clusters[id].chain;
        if (chain.length) {
          while (ch[0] + off < chain[chain.length - 1]) off += SEGMENTS;
          if (ch[0] + off !== chain[chain.length - 1]) throw new Error('group members are not neighbours');
          chain.push(...ch.slice(1).map((i) => i + off));
        } else chain.push(...ch);
      }
      const segs = chain.length - 1;
      const s = simplify(pts, chain, Math.max(1, Math.floor(segs / 2)));
      const err = Math.max(s.error, ...members.map((id) => clusters[id].error));
      const b = enclose(members.map((id) => clusters[id].bounds));
      for (const id of members) {
        clusters[id].parentError = err;
        clusters[id].parentBounds = b;
      }
      // Split into clusters of up to PER_CLUSTER segments.
      const parts = Math.ceil((s.chain.length - 1) / PER_CLUSTER);
      const per = (s.chain.length - 1) / parts;
      for (let p = 0; p < parts; p++) {
        const a = Math.round(p * per);
        const z = Math.round((p + 1) * per);
        next.push(make(level + 1, s.chain.slice(a, z + 1), err, b, members));
      }
    }
    levels.push(next);
  }
  return { build, pts, clusters, levels };
}

// ---------------------------------------------------------------------------------------------
// Choosing a cut

export interface Viewer {
  x: number;
  y: number;
}
/** Pixels per world unit at distance 1: an error e at distance d looks FOCAL · e / d pixels big. */
export const FOCAL = 300;

/** An error seen from the viewer, in pixels, using the nearest point of the bounds (so a parent is never smaller than its child). */
export function projected(err: number, b: Circle, v: Viewer): number {
  if (err === Infinity) return Infinity;
  if (err === 0) return 0;
  const d = Math.max(1, Math.sqrt((b.x - v.x) ** 2 + (b.y - v.y) ** 2) - b.r);
  return (FOCAL * err) / d;
}

/** Nanite's test, cluster by cluster and in any order: draw it if its own error is small enough and its parent's isn't. */
export function selected(c: Cluster, v: Viewer, threshold: number): boolean {
  return projected(c.error, c.bounds, v) <= threshold && projected(c.parentError, c.parentBounds, v) > threshold;
}

export interface Cut {
  clusters: Cluster[];
  segments: number;
  /** Clusters drawn per level. */
  perLevel: number[];
  /** True if the drawn clusters join end to end into one closed loop, each original stretch covered once. */
  watertight: boolean;
}
export function cut(hy: Hierarchy, v: Viewer, threshold: number): Cut {
  const cs = hy.clusters.filter((c) => selected(c, v, threshold));
  const perLevel = hy.levels.map(() => 0);
  let segments = 0;
  for (const c of cs) {
    perLevel[c.level]++;
    segments += c.chain.length - 1;
  }
  // Watertight: the stretches [first, last] (mod the loop) tile the loop exactly.
  const spans = cs.map((c) => [c.chain[0] % SEGMENTS, c.chain[c.chain.length - 1] - c.chain[0]] as [number, number]).sort((a, b) => a[0] - b[0]);
  let watertight = spans.length > 0;
  let total = 0;
  for (let i = 0; i < spans.length; i++) {
    const [a, len] = spans[i];
    total += len;
    const nextStart = i + 1 < spans.length ? spans[i + 1][0] : spans[0][0] + SEGMENTS;
    if (a + len !== nextStart) watertight = false;
  }
  if (total !== SEGMENTS) watertight = false;
  return { clusters: cs, segments, perLevel, watertight };
}

/** Where the widget's viewer starts, and the distances the lesson quotes. */
export const VIEW_START: Viewer = { x: 590, y: 372 };
export const THRESHOLD_START = 1;

/** The fewest segments a build can draw: everything at its coarsest. */
export function coarsest(hy: Hierarchy): number {
  return cut(hy, { x: 1e7, y: 1e7 }, 1).segments;
}

// ---------------------------------------------------------------------------------------------
// Small triangles and 2 × 2 quads

export const QUAD_PX = 32;
export const QUAD_DIVS = [1, 2, 4, 8, 16, 32] as const;

export interface QuadStats {
  triangles: number;
  /** Pixels covered (each pixel covered by exactly one triangle, by the top-left rule). */
  pixels: number;
  /** Triangles that cover no pixel centre at all. */
  empty: number;
  /** 2 × 2 quads launched, summed over triangles: 4 lanes each. */
  quads: number;
  /** Per pixel: how many lanes ran for the quad it's in (for the heat view). */
  lanesAt: Int32Array;
  /** Per triangle: pixels covered (for the histogram). */
  sizes: number[];
}

/**
 * A QUAD_PX square of screen split into div × div cells, two triangles each, offset by a fraction of
 * a pixel so that edges don't line up with pixel centres. Coverage uses the rasteriser's own edge
 * functions and top-left rule, on positions in 1/256 pixel.
 */
export function quadModel(div: number): QuadStats {
  const SUBP = 256;
  const ox = 77; // 0.30 px
  const oy = 51; // 0.20 px
  const step = (QUAD_PX * SUBP) / div;
  const P = (i: number, j: number): [number, number] => [ox + Math.round(i * step), oy + Math.round(j * step)];
  const lanesAt = new Int32Array(QUAD_PX * QUAD_PX);
  const sizes: number[] = [];
  let pixels = 0;
  let empty = 0;
  let quads = 0;
  const tri = (a: [number, number], b: [number, number], c: [number, number]) => {
    // Clockwise on screen (y down) is the front here; make the edge functions positive inside.
    const area = edge(a[0], a[1], b[0], b[1], c[0], c[1]);
    if (area < 0) [b, c] = [c, b];
    const v = [a, b, c];
    const tl = [0, 1, 2].map((k) => isTopLeft(v[k][0], v[k][1], v[(k + 1) % 3][0], v[(k + 1) % 3][1]));
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) / SUBP));
    const x1 = Math.min(QUAD_PX - 1, Math.floor(Math.max(a[0], b[0], c[0]) / SUBP));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) / SUBP));
    const y1 = Math.min(QUAD_PX - 1, Math.floor(Math.max(a[1], b[1], c[1]) / SUBP));
    const touched = new Set<number>();
    let n = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x * SUBP + SUBP / 2;
        const py = y * SUBP + SUBP / 2;
        let inside = true;
        for (let k = 0; k < 3 && inside; k++) {
          const e = edge(v[k][0], v[k][1], v[(k + 1) % 3][0], v[(k + 1) % 3][1], px, py);
          inside = e > 0 || (e === 0 && tl[k]);
        }
        if (!inside) continue;
        n++;
        touched.add((y >> 1) * (QUAD_PX >> 1) + (x >> 1));
      }
    for (const q of touched) {
      const qx = (q % (QUAD_PX >> 1)) * 2;
      const qy = Math.floor(q / (QUAD_PX >> 1)) * 2;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) lanesAt[(qy + dy) * QUAD_PX + qx + dx] += 4;
    }
    quads += touched.size;
    pixels += n;
    if (n === 0) empty++;
    sizes.push(n);
  };
  for (let j = 0; j < div; j++)
    for (let i = 0; i < div; i++) {
      tri(P(i, j), P(i + 1, j), P(i + 1, j + 1));
      tri(P(i, j), P(i + 1, j + 1), P(i, j + 1));
    }
  return { triangles: 2 * div * div, pixels, empty, quads, lanesAt, sizes };
}
/** Share of the lanes launched that shade a pixel the triangle really covers, in percent. */
export const laneUse = (s: QuadStats) => (100 * s.pixels) / (4 * s.quads);
