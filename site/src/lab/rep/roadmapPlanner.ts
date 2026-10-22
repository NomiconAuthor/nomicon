import { makeRng } from '../core/rng';
import type { GridSpace } from '../graph/gridSpace';
import { Recorder } from '../search/types';
import { fmt, fmtTime } from '../ui/dom';
import { UNIT_COLORS, drawTree, type Palette } from '../ui/renderer';
import { Collision, Roadmap, pathCost, roadmapAStar, sampleFree, shortcutPoints, type Edge } from './roadmapCore';
import { polyLength, type Message, type Plan, type PlanContext, type Pt, type RepView, type ViewRect } from './types';

export type RoadmapMethod = 'prm' | 'lazyprm' | 'rrt' | 'rrtconnect' | 'rrtstar' | 'shared' | 'feature';

export interface RoadmapLaneConfig {
  method: RoadmapMethod;
  samples: number; // PRM-style roadmaps
  iterations: number; // tree growth budget
  step: number; // RRT step length in cells
  spacing: number; // feature roadmap filler spacing
  seed: number;
  smoothing: 'none' | 'shortcut';
}

export const ROADMAP_METHODS: Array<{ id: RoadmapMethod; name: string; family: string; summary: string; chips: Array<[string, string]>; watch: string }> = [
  {
    id: 'prm',
    name: 'PRM',
    family: 'Multi-query roadmap',
    summary:
      'Probabilistic roadmap: scatter random free points, connect each to its nearest neighbours that it can see, then answer queries with A* over that graph. The roadmap is built once and reused for every query.',
    chips: [
      ['Optimal', 'No (depends on samples)'],
      ['Complete', 'Probabilistically'],
      ['Reuse', 'Yes, multi-query'],
    ],
    watch:
      'Move the start or goal: the roadmap is reused (no build cost). Try "Rooms and doors": with few samples, one-cell doorways are often missed and the goal looks unreachable. That is the narrow-passage problem.',
  },
  {
    id: 'lazyprm',
    name: 'Lazy PRM',
    family: 'Multi-query roadmap',
    summary:
      'PRM that connects neighbours without checking for walls. A query searches the unchecked graph, checks only the edges on the path it found, deletes the blocked ones and searches again until the path is clean.',
    chips: [
      ['Optimal', 'No (depends on samples)'],
      ['Complete', 'Probabilistically'],
      ['Reuse', 'Yes; edits only forget checks'],
    ],
    watch: 'The collision-check count compared with plain PRM, and how many searches it takes on a map with lots of walls. Painting just marks nearby edges unchecked again.',
  },
  {
    id: 'rrt',
    name: 'RRT',
    family: 'Single-query tree',
    summary:
      'Rapidly-exploring random tree: from the start, repeatedly pick a random point (sometimes the goal), find the nearest tree node and step toward it. Stops when a new node can see the goal.',
    chips: [
      ['Optimal', 'No'],
      ['Complete', 'Probabilistically'],
      ['Reuse', 'No, rebuilt per query'],
    ],
    watch: 'Play it back: the tree races into open space (the Voronoi bias), then struggles at doorways. The raw path wanders; turn on smoothing.',
  },
  {
    id: 'rrtconnect',
    name: 'RRT-Connect',
    family: 'Single-query tree',
    summary: 'Two trees, one from the start and one from the goal. Each step extends one tree randomly, then greedily drives the other tree toward the new node until they join.',
    chips: [
      ['Optimal', 'No'],
      ['Complete', 'Probabilistically'],
      ['Reuse', 'No, rebuilt per query'],
    ],
    watch: 'Usually far fewer nodes than RRT for the same query. The greedy connect step shoots straight lines across open ground.',
  },
  {
    id: 'rrtstar',
    name: 'RRT*',
    family: 'Single-query tree',
    summary:
      'RRT that picks the cheapest nearby parent for each new node and rewires neighbours through it when that is cheaper. Paths keep improving as the iteration budget grows.',
    chips: [
      ['Optimal', 'Asymptotically'],
      ['Complete', 'Probabilistically'],
      ['Reuse', 'No, rebuilt per query'],
    ],
    watch: 'Turn on the search tree: branches straighten out as rewiring happens. Raise the iteration budget and watch the path cost fall.',
  },
  {
    id: 'shared',
    name: 'Shared RRT graph',
    family: 'Cached trees',
    summary:
      'Your original approach: every query adds its start and goal to one shared graph and connects them to nearby nodes. If they are not already connected, an RRT grows from the start side until it joins the goal side. Everything grown is kept for later queries.',
    chips: [
      ['Optimal', 'No'],
      ['Complete', 'Probabilistically'],
      ['Reuse', 'Yes, grows with use'],
    ],
    watch:
      'Drag the goal around: later queries often reuse earlier growth (no new nodes), but the graph keeps growing, its density follows past queries, and paths detour along old branches. Highlighted nodes are this query\'s growth.',
  },
  {
    id: 'feature',
    name: 'Feature roadmap',
    family: 'Deterministic roadmap',
    summary:
      'Nodes placed on purpose instead of at random: every convex wall corner (where shortest paths turn) plus a sparse lattice for open ground, connected to visible neighbours. Doorways can\'t be missed, and the same map always gives the same graph.',
    chips: [
      ['Optimal', 'Near (corners are where paths bend)'],
      ['Complete', 'Yes for passages with corners'],
      ['Reuse', 'Yes, multi-query'],
    ],
    watch: 'Compare with PRM on "Rooms and doors": no missed doorways, and paths hug corners like a visibility graph. Node count grows with wall detail, not map area.',
  },
];

export function methodInfo(id: RoadmapMethod) {
  return ROADMAP_METHODS.find((m) => m.id === id) ?? ROADMAP_METHODS[0];
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

interface Snapshot {
  xs: Float64Array;
  ys: Float64Array;
  edges: Int32Array; // pairs
  fresh: Uint8Array; // 0 = older; k = added in this round by unit k-1
  tree: boolean; // draw edges as a tree (RRT family)
  multi: boolean; // several units planned this round: colour fresh nodes by unit
}

/** Copy of the graph for drawing. Nodes born at or after `fromQuery` are marked with the unit that grew them. */
function snapshot(g: Roadmap, fromQuery: number, tree: boolean, unitOf: Map<number, number> | null = null): Snapshot {
  const n = g.size;
  const xs = Float64Array.from(g.xs);
  const ys = Float64Array.from(g.ys);
  const fresh = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (g.alive[i] && g.born[i] >= fromQuery) fresh[i] = 1 + (unitOf?.get(g.born[i]) ?? 0);
  const pairs: number[] = [];
  for (let a = 0; a < n; a++) if (g.alive[a]) for (const e of g.adj[a]) if (e.to > a) pairs.push(a, e.to);
  return { xs, ys, edges: Int32Array.from(pairs), fresh, tree, multi: !!unitOf && unitOf.size > 1 };
}

class RoadmapView implements RepView {
  nodeCount: number;
  private tint = '--walker';
  setTint(colorToken: string): void {
    this.tint = colorToken;
  }
  constructor(
    private snap: Snapshot,
    private alive: Uint8Array,
    private pal: Palette,
  ) {
    this.nodeCount = snap.xs.length;
  }
  nodeAt(x: number, y: number, r: number): number {
    let best = -1;
    let bd = r * r;
    const { xs, ys } = this.snap;
    for (let i = 0; i < xs.length; i++) {
      if (!this.alive[i]) continue;
      const d = (xs[i] - x) ** 2 + (ys[i] - y) ** 2;
      if (d <= bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
  nodeLabel(id: number): string {
    return `${this.snap.tree ? 'Tree node' : 'Roadmap node'} ${id} at ${this.snap.xs[id]?.toFixed(1)}, ${this.snap.ys[id]?.toFixed(1)}`;
  }
  private inView(i: number, v: ViewRect): boolean {
    const x = this.snap.xs[i];
    const y = this.snap.ys[i];
    return x >= v.x0 - 2 && x <= v.x1 + 3 && y >= v.y0 - 2 && y <= v.y1 + 3;
  }
  drawStructure(ctx: CanvasRenderingContext2D, v: ViewRect): void {
    const { snap, pal } = this;
    const cs = v.cs;
    if (!snap.tree) {
      ctx.strokeStyle = pal.get('--vehicle');
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < snap.edges.length; k += 2) {
        const a = snap.edges[k];
        const b = snap.edges[k + 1];
        if (!this.inView(a, v) && !this.inView(b, v)) continue;
        ctx.moveTo(snap.xs[a] * cs, snap.ys[a] * cs);
        ctx.lineTo(snap.xs[b] * cs, snap.ys[b] * cs);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const r = Math.max(1.5, Math.min(cs * 0.25, 3.5));
    ctx.fillStyle = pal.get('--vehicle');
    ctx.globalAlpha = snap.tree ? 0.35 : 0.8;
    ctx.beginPath();
    for (let i = 0; i < snap.xs.length; i++) {
      if (!this.alive[i] || !this.inView(i, v)) continue;
      ctx.moveTo(snap.xs[i] * cs + r, snap.ys[i] * cs);
      ctx.arc(snap.xs[i] * cs, snap.ys[i] * cs, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
    // This round's growth (shared graph), highlighted; with several units, in the colour of the unit that grew it.
    if (!snap.tree) {
      const groups = snap.multi ? UNIT_COLORS.length : 1;
      for (let gi = 0; gi < groups; gi++) {
        ctx.fillStyle = snap.multi ? pal.get(UNIT_COLORS[gi]) : pal.get('--alert');
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < snap.xs.length; i++) {
          const f = snap.fresh[i];
          if (!f || (snap.multi && f !== gi + 1) || !this.alive[i] || !this.inView(i, v)) continue;
          ctx.moveTo(snap.xs[i] * cs + r + 1, snap.ys[i] * cs);
          ctx.arc(snap.xs[i] * cs, snap.ys[i] * cs, r + 1, 0, Math.PI * 2);
          any = true;
        }
        if (any) ctx.fill();
      }
    }
  }
  drawState(ctx: CanvasRenderingContext2D, v: ViewRect, status: Uint8Array, parent: Int32Array, current: number, tree: boolean): void {
    const { snap, pal } = this;
    const cs = v.cs;
    const pos = (i: number): Pt => ({ x: snap.xs[i], y: snap.ys[i] });
    if (snap.tree || tree) drawTree(ctx, cs, status, parent, pos, (i) => this.inView(i, v), snap.tree ? pal.get(this.tint) : pal.get('--tree'), 80000);
    // With several units on one graph, keep search dots small so each node's unit colour shows round them.
    const r = snap.multi ? Math.max(1.2, Math.min(cs * 0.14, 2.2)) : Math.max(2, Math.min(cs * 0.3, 4.5));
    for (const [s, color] of [
      [1, pal.get('--cache')],
      [2, pal.get(this.tint)],
    ] as Array<[number, string]>) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i < status.length; i++) {
        if (status[i] !== s || !this.inView(i, v)) continue;
        ctx.moveTo(snap.xs[i] * cs + r, snap.ys[i] * cs);
        ctx.arc(snap.xs[i] * cs, snap.ys[i] * cs, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    if (current >= 0) {
      ctx.strokeStyle = pal.get('--ink');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(snap.xs[current] * cs, snap.ys[current] * cs, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function prmRadius(space: GridSpace, n: number): number {
  // About three average sample spacings: enough for a connected roadmap without huge edge counts.
  const freeArea = space.w * space.h * 0.75;
  return Math.max(2.5, 3.2 * Math.sqrt(freeArea / Math.max(1, n)));
}

function buildPRM(col: Collision, cfg: RoadmapLaneConfig, lazy: boolean): Roadmap {
  const space = col.space;
  const r = prmRadius(space, cfg.samples);
  const g = new Roadmap(Math.max(2, r));
  const rng = makeRng(cfg.seed * 7919 + 13);
  for (let i = 0; i < cfg.samples; i++) {
    const p = sampleFree(col, rng);
    if (p) g.addNode(p.x, p.y, 0);
  }
  for (let i = 0; i < g.size; i++) g.connect(col, i, 10, r, lazy);
  return g;
}

/** Convex wall corners (where shortest paths bend) plus a sparse lattice. */
function buildFeature(col: Collision, cfg: RoadmapLaneConfig): Roadmap {
  const space = col.space;
  const g = new Roadmap(8);
  const { w, h } = space;
  const seen = new Uint8Array(w * h);
  const add = (x: number, y: number) => {
    const i = y * w + x;
    if (seen[i]) return;
    seen[i] = 1;
    g.addNode(x + 0.5, y + 0.5, 0);
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!space.ok(x, y)) continue;
      for (const [dx, dy] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ]) {
        if (!space.ok(x + dx, y + dy) && space.ok(x + dx, y) && space.ok(x, y + dy)) {
          add(x, y);
          break;
        }
      }
    }
  const S = cfg.spacing;
  for (let y = Math.floor(S / 2); y < h; y += S) for (let x = Math.floor(S / 2); x < w; x += S) if (space.ok(x, y)) add(x, y);
  const r = Math.max(10, S * 2.2);
  for (let i = 0; i < g.size; i++) g.connect(col, i, 12, r);
  return g;
}

function steer(from: Pt, to: Pt, step: number): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d <= step) return { x: to.x, y: to.y };
  return { x: from.x + (dx / d) * step, y: from.y + (dy / d) * step };
}

interface TreeResult {
  g: Roadmap;
  path: number[];
  iterations: number;
  rewires: number;
}

/** Plain RRT from start toward goal. */
function growRRT(col: Collision, s: Pt, t: Pt, cfg: RoadmapLaneConfig, rec: Recorder, star: boolean): TreeResult {
  const space = col.space;
  const g = new Roadmap(Math.max(2, cfg.step * 2));
  const rng = makeRng(cfg.seed * 104729 + Math.floor(s.x * 31 + s.y * 17 + t.x * 13 + t.y * 7));
  const parent: number[] = [];
  const cost: number[] = [];
  const children: number[][] = [];
  const root = g.addNode(s.x, s.y);
  parent.push(-1);
  cost.push(0);
  children.push([]);
  /** Re-parent j under p; with RRT* the cost change is pushed down j's whole subtree. */
  const reparent = (j: number, p: number, newCost: number) => {
    const old = parent[j];
    if (old >= 0) {
      g.removeEdge(old, j);
      const list = children[old];
      const k = list.indexOf(j);
      if (k >= 0) list.splice(k, 1);
    }
    parent[j] = p;
    children[p].push(j);
    g.addEdge(p, j, newCost - cost[p]);
    const delta = newCost - cost[j];
    cost[j] = newCost;
    if (delta !== 0) {
      const stack = [...children[j]];
      while (stack.length) {
        const c = stack.pop()!;
        cost[c] += delta;
        for (const cc of children[c]) stack.push(cc);
      }
    }
  };
  rec.open(root, -1);
  rec.close(root);
  const area = space.w * space.h;
  let goalNode = -1;
  let iterations = 0;
  let rewires = 0;
  const rings = Math.ceil(Math.max(space.w, space.h) / g.hash.size) + 1;
  for (; iterations < cfg.iterations; iterations++) {
    const target = rng() < 0.05 ? t : { x: rng() * space.w, y: rng() * space.h };
    const near = g.hash.nearest(target.x, target.y, () => true, rings);
    if (near < 0) break;
    const q = steer({ x: g.xs[near], y: g.ys[near] }, target, cfg.step);
    if (!col.segmentFree(g.xs[near], g.ys[near], q.x, q.y)) continue;
    let best = near;
    let bestCost = cost[near] + col.segmentCost(g.xs[near], g.ys[near], q.x, q.y);
    let neighbours: number[] = [];
    if (star) {
      // Choose the cheapest visible parent within the shrinking RRT* radius.
      const n = g.size;
      const r = Math.min(cfg.step * 3, Math.max(cfg.step * 1.2, Math.sqrt((area / Math.PI) * (Math.log(n + 1) / (n + 1))) * 2));
      neighbours = g.hash.within(q.x, q.y, r).filter((j) => j !== near);
      for (const j of neighbours) {
        const c = cost[j] + col.segmentCost(g.xs[j], g.ys[j], q.x, q.y);
        if (c < bestCost && col.segmentFree(g.xs[j], g.ys[j], q.x, q.y)) {
          best = j;
          bestCost = c;
        }
      }
    }
    const id = g.addNode(q.x, q.y);
    parent.push(best);
    cost.push(bestCost);
    children.push([]);
    children[best].push(id);
    g.addEdge(best, id, bestCost - cost[best]);
    rec.open(id, best);
    rec.close(id);
    if (star) {
      for (const j of neighbours) {
        if (j === best) continue;
        const c = bestCost + col.segmentCost(q.x, q.y, g.xs[j], g.ys[j]);
        if (c < cost[j] - 1e-9 && col.segmentFree(q.x, q.y, g.xs[j], g.ys[j])) {
          reparent(j, id, c);
          rec.open(j, id);
          rec.close(j);
          rewires++;
        }
      }
    }
    // Can the new node see the goal?
    if (Math.hypot(t.x - q.x, t.y - q.y) <= cfg.step && col.segmentFree(q.x, q.y, t.x, t.y)) {
      const gc = bestCost + col.segmentCost(q.x, q.y, t.x, t.y);
      if (goalNode < 0 || gc < cost[goalNode] - 1e-9) {
        if (goalNode < 0) {
          goalNode = g.addNode(t.x, t.y);
          // The goal is a target, not a branch point: keep it out of neighbour searches,
          // so it never becomes a parent (and can never be re-parented under its own subtree).
          g.hash.remove(goalNode, t.x, t.y);
          parent.push(id);
          cost.push(gc);
          children.push([]);
          children[id].push(goalNode);
          g.addEdge(id, goalNode, gc - bestCost);
        } else {
          reparent(goalNode, id, gc);
        }
        rec.open(goalNode, id);
        rec.close(goalNode);
        if (!star) {
          iterations++;
          break;
        }
      }
    }
  }
  const path: number[] = [];
  if (goalNode >= 0) for (let c = goalNode, guard = g.size + 1; c !== -1 && guard > 0; c = parent[c], guard--) path.push(c);
  return { g, path: path.reverse(), iterations, rewires };
}

/** RRT-Connect: two trees, extend one randomly, drive the other greedily toward it. */
function growRRTConnect(col: Collision, s: Pt, t: Pt, cfg: RoadmapLaneConfig, rec: Recorder): TreeResult {
  const space = col.space;
  const g = new Roadmap(Math.max(2, cfg.step * 2));
  const rng = makeRng(cfg.seed * 104729 + Math.floor(s.x * 31 + s.y * 17 + t.x * 13 + t.y * 7) + 1);
  const parent: number[] = [];
  const tree: number[] = [];
  const add = (p: Pt, par: number, tr: number) => {
    const id = g.addNode(p.x, p.y);
    parent.push(par);
    tree.push(tr);
    if (par >= 0) g.addEdge(par, id, col.segmentCost(g.xs[par], g.ys[par], p.x, p.y));
    rec.open(id, par);
    rec.close(id);
    return id;
  };
  add(s, -1, 0);
  add(t, -1, 1);
  const rings = Math.ceil(Math.max(space.w, space.h) / g.hash.size) + 1;
  let a = 0;
  let iterations = 0;
  let link: [number, number] | null = null;
  for (; iterations < cfg.iterations && !link; iterations++) {
    const target = { x: rng() * space.w, y: rng() * space.h };
    const na = g.hash.nearest(target.x, target.y, (j) => tree[j] === a, rings);
    if (na < 0) break;
    const q = steer({ x: g.xs[na], y: g.ys[na] }, target, cfg.step);
    if (col.segmentFree(g.xs[na], g.ys[na], q.x, q.y)) {
      const newA = add(q, na, a);
      // Greedy connect: march the other tree toward the new node.
      const b = 1 - a;
      let nb = g.hash.nearest(q.x, q.y, (j) => tree[j] === b, rings);
      for (let guard = 0; nb >= 0 && guard < 10000; guard++) {
        const d = Math.hypot(q.x - g.xs[nb], q.y - g.ys[nb]);
        if (d <= cfg.step) {
          if (col.segmentFree(g.xs[nb], g.ys[nb], q.x, q.y)) link = a === 0 ? [newA, nb] : [nb, newA];
          break;
        }
        const step = steer({ x: g.xs[nb], y: g.ys[nb] }, q, cfg.step);
        if (!col.segmentFree(g.xs[nb], g.ys[nb], step.x, step.y)) break;
        nb = add(step, nb, b);
      }
    }
    a = 1 - a;
  }
  const path: number[] = [];
  if (link) {
    const [fromStart, fromGoal] = link;
    g.addEdge(fromStart, fromGoal, col.segmentCost(g.xs[fromStart], g.ys[fromStart], g.xs[fromGoal], g.ys[fromGoal]));
    for (let c = fromStart; c !== -1; c = parent[c]) path.push(c);
    path.reverse();
    for (let c = fromGoal; c !== -1; c = parent[c]) path.push(c);
  }
  return { g, path, iterations, rewires: 0 };
}

// ---------------------------------------------------------------------------
// Planner (keeps roadmaps alive across queries where the method allows it)
// ---------------------------------------------------------------------------

class UnionFind {
  p: Int32Array;
  constructor(n: number) {
    this.p = new Int32Array(n).map((_, i) => i);
  }
  grow(n: number): void {
    if (n <= this.p.length) return;
    const q = new Int32Array(Math.max(n, this.p.length * 2));
    q.set(this.p);
    for (let i = this.p.length; i < q.length; i++) q[i] = i;
    this.p = q;
  }
  find(a: number): number {
    while (this.p[a] !== a) {
      this.p[a] = this.p[this.p[a]];
      a = this.p[a];
    }
    return a;
  }
  union(a: number, b: number): void {
    this.p[this.find(a)] = this.find(b);
  }
}

export class RoadmapPlanner {
  private g: Roadmap | null = null;
  private key = '';
  private query = 0;
  /** First query of the current round of units, and which unit made each query since. */
  private roundStart = 1;
  private queryUnit = new Map<number, number>();

  plan(ctx: PlanContext, cfg: RoadmapLaneConfig, pal: Palette): Plan {
    const { space } = ctx;
    const col = new Collision(space);
    const messages: Message[] = [];
    const extra: Array<[string, string]> = [];
    const s: Pt = { x: space.x(ctx.start), y: space.y(ctx.start) };
    const t: Pt = { x: space.x(ctx.goal), y: space.y(ctx.goal) };
    const rec = new Recorder(true);
    const method = cfg.method;
    let pathPts: Pt[] = [];
    let expanded = 0;
    let pushes = 0;
    let maxOpen = 0;
    let found = false;
    let view: RepView;
    const minCost = space.minCostPerUnit;
    const t0 = performance.now();

    if (method === 'rrt' || method === 'rrtstar' || method === 'rrtconnect') {
      this.g = null;
      const res = method === 'rrtconnect' ? growRRTConnect(col, s, t, cfg, rec) : growRRT(col, s, t, cfg, rec, method === 'rrtstar');
      found = res.path.length > 0;
      pathPts = res.path.map((i) => ({ x: res.g.xs[i], y: res.g.ys[i] }));
      expanded = res.g.size;
      pushes = res.g.size;
      maxOpen = 0;
      const ms = performance.now() - t0;
      extra.push(['Tree nodes', fmt(res.g.size)], ['Iterations', `${fmt(res.iterations)} of ${fmt(cfg.iterations)}`], ['Wall checks', fmt(col.segmentChecks)]);
      if (method === 'rrtstar') extra.push(['Rewires', fmt(res.rewires)]);
      extra.push(['Build', `${fmtTime(ms)} · from scratch`]);
      if (!found) messages.push({ text: `No path within ${fmt(cfg.iterations)} iterations. A sampling planner can't tell "unreachable" from "not lucky yet".`, bad: true });
      view = new RoadmapView(snapshot(res.g, 0, true), aliveArray(res.g), pal);
      return this.finish(ctx, col, cfg, rec, found, pathPts, expanded, pushes, maxOpen, ms, extra, messages, view, 'Expanded counts tree nodes added. Time includes growing the tree, which is redone for every query.', `new tree · ${fmt(res.g.size)} nodes`, 'own');
    }

    // Persistent roadmaps.
    const key = `${ctx.structureKey}|${method}|${cfg.samples}|${cfg.spacing}|${cfg.step}|${cfg.seed}`;
    let buildMs = 0;
    let buildKind = '';
    if (!this.g || key !== this.key || ctx.changed === 'all' || (method === 'feature' && ctx.changed !== 'none')) {
      const tb = performance.now();
      if (method === 'feature') this.g = buildFeature(col, cfg);
      else if (method === 'shared') this.g = new Roadmap(Math.max(2, cfg.step * 2));
      else this.g = buildPRM(col, cfg, method === 'lazyprm');
      buildMs = performance.now() - tb;
      buildKind = method === 'shared' ? 'new empty graph' : 'full build';
      this.key = key;
      this.query = 0;
    } else if (ctx.changed === 'none') {
      buildKind = 'reused';
    } else {
      const tb = performance.now();
      const r = this.g.repair(col, ctx.changed, method === 'lazyprm');
      // PRM keeps its density: resample the edited area.
      let added = 0;
      if (method === 'prm' || method === 'lazyprm') {
        const box = ctx.changed;
        const area = (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1);
        const want = Math.max(1, Math.round((cfg.samples * area) / (space.w * space.h)));
        const rng = makeRng(cfg.seed * 31 + this.query * 977 + 5);
        const rr = prmRadius(space, cfg.samples);
        for (let i = 0; i < want; i++) {
          const p = sampleFree(col, rng, box.x0, box.y0, box.x1 + 1, box.y1 + 1);
          if (!p) continue;
          const id = this.g.addNode(p.x, p.y, this.query + 1);
          this.g.connect(col, id, 10, rr, method === 'lazyprm');
          added++;
        }
      }
      buildMs = performance.now() - tb;
      buildKind = `repaired: ${r.removedNodes} nodes and ${method === 'lazyprm' ? r.recheckedEdges + ' edges forgotten' : r.removedEdges + ' edges removed'}${added ? `, ${added} resampled` : ''}`;
    }
    const g = this.g;
    this.query++;
    const q = this.query;
    const unit = ctx.unitIndex ?? 0;
    if (unit === 0) {
      this.roundStart = q;
      this.queryUnit = new Map();
    }
    this.queryUnit.set(q, unit);
    const checksBefore = col.segmentChecks;

    let sId: number;
    let tId: number;
    let grown = 0;
    let iterations = 0;
    let searches = 0;
    let temp: number[] = [];
    const r = method === 'feature' ? Math.max(10, cfg.spacing * 2.2) : method === 'shared' ? cfg.step * 2.5 : prmRadius(space, cfg.samples) * 1.5;
    const lazy = method === 'lazyprm';
    sId = g.addNode(s.x, s.y, q);
    tId = g.addNode(t.x, t.y, q);
    g.connect(col, sId, 10, r, lazy);
    g.connect(col, tId, 10, r, lazy);
    if (method !== 'shared') temp = [sId, tId];

    if (method === 'shared') {
      // Union-find over the current graph; grow from the start's side until it joins the goal's.
      const uf = new UnionFind(g.size + 1024);
      for (let a = 0; a < g.size; a++) if (g.alive[a]) for (const e of g.adj[a]) uf.union(a, e.to);
      const rng = makeRng(cfg.seed * 7 + q * 104729);
      const rings = Math.ceil(Math.max(space.w, space.h) / g.hash.size) + 1;
      for (; iterations < cfg.iterations && uf.find(sId) !== uf.find(tId); iterations++) {
        const target = rng() < 0.1 ? t : { x: rng() * space.w, y: rng() * space.h };
        const sRoot = uf.find(sId);
        const near = g.hash.nearest(target.x, target.y, (j) => g.alive[j] && uf.find(j) === sRoot, rings);
        if (near < 0) break;
        const p = steer({ x: g.xs[near], y: g.ys[near] }, target, cfg.step);
        if (!col.segmentFree(g.xs[near], g.ys[near], p.x, p.y)) continue;
        const id = g.addNode(p.x, p.y, q);
        uf.grow(g.size);
        g.addEdge(near, id, col.segmentCost(g.xs[near], g.ys[near], p.x, p.y));
        uf.union(near, id);
        grown++;
        // Join anything nearby: earlier queries' branches, or the goal's side.
        const before = g.adj[id].length;
        g.connect(col, id, 6, cfg.step * 1.5);
        for (const e of g.adj[id].slice(before)) uf.union(id, e.to);
      }
      extra.push(['Graph', `${fmt(g.aliveCount())} nodes · ${fmt(g.edgeCount)} edges`], ['Grown now', `${fmt(grown)} nodes · ${fmt(iterations)} iterations`]);
      if (grown === 0) messages.push({ text: 'Cache hit: start and goal joined the existing graph, so nothing had to grow.', bad: false });
    }

    // Search the roadmap (Lazy PRM: search, check the path's edges, drop bad ones, repeat).
    let result = roadmapAStar(g, sId, tId, minCost, rec, (_a: number, _e: Edge) => true);
    searches = 1;
    if (lazy) {
      for (let guard = 0; guard < 500 && result.found; guard++) {
        let clean = true;
        for (let k = 1; k < result.path.length; k++) {
          const a = result.path[k - 1];
          const b = result.path[k];
          const e = g.adj[a].find((x) => x.to === b)!;
          if (e.checked) continue;
          if (col.segmentFree(g.xs[a], g.ys[a], g.xs[b], g.ys[b])) {
            e.checked = true;
            const back = g.adj[b].find((x) => x.to === a);
            if (back) back.checked = true;
          } else {
            g.removeEdge(a, b);
            clean = false;
          }
        }
        if (clean) break;
        result = roadmapAStar(g, sId, tId, minCost, rec);
        searches++;
      }
      let checked = 0;
      let total = 0;
      for (let a = 0; a < g.size; a++) if (g.alive[a]) for (const e of g.adj[a]) if (e.to > a) {
        total++;
        if (e.checked) checked++;
      }
      extra.push(['Edges checked', `${fmt(checked)} of ${fmt(total)}`], ['Searches', fmt(searches)]);
    }
    found = result.found;
    expanded = result.expanded;
    pushes = result.pushes;
    maxOpen = result.maxOpen;
    pathPts = result.path.map((i) => ({ x: g.xs[i], y: g.ys[i] }));
    const ms = performance.now() - t0 - buildMs;
    if (method !== 'shared') extra.push(['Roadmap', `${fmt(g.aliveCount() - temp.length)} nodes · ${fmt(g.edgeCount)} edges`]);
    extra.push(['Wall checks', `${fmt(col.segmentChecks)} (${fmt(col.segmentChecks - checksBefore)} this query)`], ['Build', `${fmtTime(buildMs)} · ${buildKind}`]);
    if (!found && method !== 'shared')
      messages.push({ text: 'No path through this roadmap. If the grid finds one, the samples missed a narrow passage: add samples or reseed.', bad: true });
    if (!found && method === 'shared') messages.push({ text: `The tree didn't reach the goal's side within ${fmt(cfg.iterations)} iterations.`, bad: true });
    view = new RoadmapView(snapshot(g, unit > 0 ? this.roundStart : q, false, unit > 0 ? this.queryUnit : null), aliveArray(g), pal);
    // Start and goal are temporary in multi-query roadmaps; the shared graph keeps them.
    for (const id of temp) g.removeNode(id);
    const note =
      method === 'shared'
        ? 'Expanded counts roadmap nodes searched by A*. Time includes any growth this query needed.'
        : 'Expanded counts roadmap nodes searched by A*. Time is the query only; the roadmap build is listed separately.';
    const unitNote =
      method === 'shared' ? (grown > 0 ? `grew ${fmt(grown)} nodes` : 'cache hit, no growth') : buildKind === 'reused' ? 'roadmap reused' : buildKind;
    return this.finish(ctx, col, cfg, rec, found, pathPts, expanded, pushes, maxOpen, ms, extra, messages, view, note, unitNote, 'shared');
  }

  private finish(
    _ctx: PlanContext,
    col: Collision,
    cfg: RoadmapLaneConfig,
    rec: Recorder,
    found: boolean,
    raw: Pt[],
    expanded: number,
    pushes: number,
    maxOpen: number,
    ms: number,
    extra: Array<[string, string]>,
    messages: Message[],
    view: RepView,
    note: string,
    unitNote = '',
    idSpace: 'shared' | 'own' = 'shared',
  ): Plan {
    const final = found && cfg.smoothing === 'shortcut' ? shortcutPoints(col, raw) : raw;
    return {
      status: found ? 'found' : 'noPath',
      expanded,
      pushes,
      maxOpen,
      rec,
      rawPath: raw,
      finalPath: final,
      length: found ? polyLength(final) : NaN,
      cost: found ? pathCost(col, final) : NaN,
      queryMs: ms,
      extra,
      messages,
      view,
      note,
      unitNote,
      idSpace,
      priority: idSpace === 'own' ? undefined : 'g+h',
    };
  }
}

function aliveArray(g: Roadmap): Uint8Array {
  const a = new Uint8Array(g.size);
  for (let i = 0; i < g.size; i++) a[i] = g.alive[i] ? 1 : 0;
  return a;
}

/** Exposed for tests. */
export const roadmapInternals = { buildPRM, buildFeature, growRRT, growRRTConnect };
