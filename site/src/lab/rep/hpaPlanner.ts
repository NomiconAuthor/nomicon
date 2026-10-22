import { MinHeap } from '../core/heap';
import type { GridSpace } from '../graph/gridSpace';
import { measurePath, shortcut, type SmoothingId } from '../post/smooth';
import { makeHeuristic, type HeuristicId } from '../search/heuristics';
import { Recorder } from '../search/types';
import { fmt, fmtTime } from '../ui/dom';
import { UNIT_COLORS, drawTree, type Palette } from '../ui/renderer';
import { HpaGraph, type LocalSearch } from './hpaGraph';
import { cellCenter, type Message, type Plan, type PlanContext, type Pt, type RepView, type ViewRect } from './types';

export interface HpaLaneConfig {
  cluster: number;
  lazy: boolean;
  /** Weight on the door-level heuristic; a little above 1 breaks plateaus of equal-cost door routes. */
  weight: number;
  heuristic: HeuristicId;
  smoothing: SmoothingId;
}

interface HpaQueryResult {
  found: boolean;
  cells: number[];
  expanded: number;
  pushes: number;
  maxOpen: number;
  insertionCells: number;
  usedDirect: boolean;
}

/**
 * One HPA* query:
 *  1. connect start and goal to the doors of their own tiles (a small Dijkstra inside each tile);
 *  2. A* over the door graph (doors are the nodes; cached routes and border crossings are edges),
 *     building a tile's routes on first visit when the graph is lazy;
 *  3. stitch the cached cell routes of each hop into the full path.
 * If start and goal share a tile, the direct route inside the tile is also considered.
 */
export function hpaQuery(g: HpaGraph, space: GridSpace, start: number, goal: number, heuristic: HeuristicId, rec: Recorder, weight = 1): HpaQueryResult {
  const sc = g.clusterOf(start);
  const gc = g.clusterOf(goal);
  const sIns = g.localDijkstra(start, g.bounds(sc));
  const gIns = g.localDijkstra(goal, g.bounds(gc));
  let insertionCells = sIns.expanded + gIns.expanded;
  // Edges from the start to its tile's doors, and from the goal tile's doors to the goal.
  const startEdges: Array<{ to: number; cost: number }> = [];
  for (const n of g.clusterNodes[sc]) {
    const d = sIns.dist(n);
    if (d < Infinity && n !== start) startEdges.push({ to: n, cost: d });
  }
  const toGoal = new Map<number, number>();
  for (const n of g.clusterNodes[gc]) {
    const d = gIns.dist(n);
    if (d < Infinity) toGoal.set(n, d);
  }
  // Nearby pairs: also search directly inside the start and goal tiles together. This avoids
  // the classic HPA* detour when the two sit either side of a border far from its doors.
  let direct = Infinity;
  let directSearch: LocalSearch | null = null;
  const dcx = Math.abs((sc % g.cw) - (gc % g.cw));
  const dcy = Math.abs(Math.floor(sc / g.cw) - Math.floor(gc / g.cw));
  let directCells = 0;
  if (dcx <= 1 && dcy <= 1) {
    const a = g.bounds(sc);
    const b = g.bounds(gc);
    const box = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
    const local = sc === gc ? sIns : g.localDijkstra(start, box, new Set([goal]));
    if (local !== sIns) directCells = local.expanded;
    direct = local.dist(goal);
    directSearch = local;
  }

  const h = makeHeuristic(space, goal, heuristic);
  const gScore = new Map<number, number>();
  const parent = new Map<number, number>();
  /** How each node was reached: 0 from the start, 1 cached route, 2 border crossing, 3 into the goal. */
  const via = new Map<number, number>();
  const closed = new Set<number>();
  const open = new MinHeap(256);
  gScore.set(start, 0);
  open.push(start, h(start), 0);
  rec.open(start, -1, 0, weight * h(start));
  let expanded = 0;
  let pushes = 1;
  let maxOpen = 1;
  let found = false;
  const relax = (from: number, to: number, cost: number, kind: number) => {
    const ng = gScore.get(from)! + cost;
    const old = gScore.get(to);
    if (old === undefined || ng < old - 1e-12) {
      gScore.set(to, ng);
      parent.set(to, from);
      via.set(to, kind);
      open.push(to, ng + weight * h(to), -ng);
      rec.open(to, from, ng, ng + weight * h(to));
      pushes++;
    }
  };
  while (open.size) {
    const cur = open.pop();
    if (closed.has(cur)) continue;
    closed.add(cur);
    expanded++;
    rec.close(cur);
    if (cur === goal) {
      found = true;
      break;
    }
    if (cur === start) {
      for (const e of startEdges) relax(cur, e.to, e.cost, 0);
      // The start can itself be a door: then it can also cross its border directly.
      for (const e of g.inter.get(cur) ?? []) relax(cur, e.to, e.cost, 2);
    } else {
      const c = g.clusterOf(cur);
      g.ensure(c);
      for (const e of g.intra[c]!.edges.get(cur) ?? []) relax(cur, e.to, e.cost, 1);
      for (const e of g.inter.get(cur) ?? []) relax(cur, e.to, e.cost, 2);
      const tg = toGoal.get(cur);
      if (tg !== undefined) relax(cur, goal, tg, 3);
    }
    if (open.size > maxOpen) maxOpen = open.size;
  }

  insertionCells += directCells;
  const abstractCost = found ? gScore.get(goal)! : Infinity;
  if (direct <= abstractCost && direct < Infinity && directSearch) {
    return { found: true, cells: Array.from(directSearch.trace(goal)), expanded, pushes, maxOpen, insertionCells, usedDirect: true };
  }
  if (!found) return { found: false, cells: [], expanded, pushes, maxOpen, insertionCells, usedDirect: false };

  // Abstract hops, start -> goal.
  const hops: number[] = [];
  for (let c: number | undefined = goal; c !== undefined; c = parent.get(c)) {
    hops.push(c);
    if (c === start) break;
  }
  hops.reverse();
  const cells: number[] = [start];
  for (let k = 1; k < hops.length; k++) {
    const a = hops[k - 1];
    const b = hops[k];
    let seg: ArrayLike<number>;
    switch (via.get(b)) {
      case 0:
        seg = sIns.trace(b);
        break;
      case 3:
        seg = gIns.trace(a).slice().reverse();
        break;
      case 1:
        seg = g.intra[g.clusterOf(a)]!.edges.get(a)!.find((e) => e.to === b)!.path;
        break;
      default:
        seg = [a, b];
    }
    for (let i = 1; i < seg.length; i++) cells.push(seg[i]);
  }
  return { found: true, cells, expanded, pushes, maxOpen, insertionCells, usedDirect: false };
}

/** Draws tiles, doors, cached routes and the abstract search. */
export class HpaView implements RepView {
  nodeCount: number;
  /** Tiles built during this round of unit queries, with the unit that built each (multi-unit only). */
  roundBuilt: Map<number, number> | null = null;
  constructor(
    private g: HpaGraph,
    private space: GridSpace,
    private pal: Palette,
  ) {
    this.nodeCount = space.count;
  }

  nodeAt(x: number, y: number, r: number): number {
    // The nearest door (or the start/goal cell) in the tile under the point and its neighbours.
    const w = this.space.w;
    const C = this.g.C;
    const tx = Math.floor(x / C);
    const ty = Math.floor(y / C);
    let best = -1;
    let bd = Math.max(r, 0.75) ** 2;
    for (let cy = ty - 1; cy <= ty + 1; cy++)
      for (let cx = tx - 1; cx <= tx + 1; cx++) {
        if (cx < 0 || cy < 0 || cx >= this.g.cw || cy >= this.g.chh) continue;
        for (const id of this.g.clusterNodes[cy * this.g.cw + cx] ?? []) {
          const d = ((id % w) + 0.5 - x) ** 2 + (Math.floor(id / w) + 0.5 - y) ** 2;
          if (d < bd) {
            bd = d;
            best = id;
          }
        }
      }
    if (best >= 0) return best;
    // Start and goal are search nodes too, though not doors.
    const cxl = Math.floor(x);
    const cyl = Math.floor(y);
    return cxl >= 0 && cyl >= 0 && cxl < w && cyl < this.space.h ? cyl * w + cxl : -1;
  }
  nodeLabel(id: number): string {
    const x = id % this.space.w;
    const y = Math.floor(id / this.space.w);
    return `Door at ${x}, ${y} · tile ${Math.floor(x / this.g.C)}, ${Math.floor(y / this.g.C)}`;
  }
  drawStructure(ctx: CanvasRenderingContext2D, v: ViewRect): void {
    const { g, pal } = this;
    const cs = v.cs;
    const C = g.C;
    const cx0 = Math.max(0, Math.floor(v.x0 / C));
    const cx1 = Math.min(g.cw - 1, Math.floor(v.x1 / C));
    const cy0 = Math.max(0, Math.floor(v.y0 / C));
    const cy1 = Math.min(g.chh - 1, Math.floor(v.y1 / C));
    // Tile tint: built (cached) tiles, and tiles rebuilt by the last edit.
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * g.cw + cx;
        const b = g.bounds(c);
        const by = this.roundBuilt?.get(c);
        if (g.lastRebuilt.size < g.clusterCount && g.lastRebuilt.has(c)) {
          ctx.fillStyle = pal.get('--alert');
          ctx.globalAlpha = 0.1;
        } else if (by !== undefined) {
          ctx.fillStyle = pal.get(UNIT_COLORS[by % UNIT_COLORS.length]);
          ctx.globalAlpha = 0.2;
        } else if (g.intra[c]) {
          ctx.fillStyle = pal.get('--cache');
          ctx.globalAlpha = g.lazy ? 0.08 : 0.04;
        } else continue;
        ctx.fillRect(b.x0 * cs, b.y0 * cs, (b.x1 - b.x0 + 1) * cs, (b.y1 - b.y0 + 1) * cs);
      }
    ctx.globalAlpha = 1;
    // Tile borders.
    ctx.strokeStyle = pal.get('--ink');
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (let cx = cx0 + 1; cx <= cx1; cx++) {
      ctx.moveTo(cx * C * cs, v.y0 * cs);
      ctx.lineTo(cx * C * cs, (v.y1 + 1) * cs);
    }
    for (let cy = cy0 + 1; cy <= cy1; cy++) {
      ctx.moveTo(v.x0 * cs, cy * C * cs);
      ctx.lineTo((v.x1 + 1) * cs, cy * C * cs);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const visibleTiles = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    const pos = (n: number) => cellCenter(this.space, n);
    // Cached door-to-door routes, drawn as straight links (the real routes bend around walls).
    if (visibleTiles <= 900 && C * cs >= 24) {
      ctx.strokeStyle = pal.get('--cache');
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const cache = g.intra[cy * g.cw + cx];
          if (!cache) continue;
          for (const [a, list] of cache.edges)
            for (const e of list) {
              if (e.to < a) continue;
              const p = pos(a);
              const q = pos(e.to);
              ctx.moveTo(p.x * cs, p.y * cs);
              ctx.lineTo(q.x * cs, q.y * cs);
            }
        }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Doors.
    if (visibleTiles <= 4000) {
      const r = Math.max(1.6, Math.min(cs * 0.3, 4));
      ctx.fillStyle = pal.get('--cache');
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++)
          for (const n of g.clusterNodes[cy * g.cw + cx]) {
            const p = pos(n);
            ctx.beginPath();
            ctx.arc(p.x * cs, p.y * cs, r, 0, Math.PI * 2);
            ctx.fill();
          }
    }
  }

  drawState(ctx: CanvasRenderingContext2D, v: ViewRect, status: Uint8Array, parent: Int32Array, current: number, tree: boolean): void {
    const cs = v.cs;
    const pos = (n: number) => cellCenter(this.space, n);
    // The abstract search is small, so always show its tree: the hops are the story.
    drawTree(ctx, cs, status, parent, pos, () => true, this.pal.get('--walker'), 20000);
    void tree;
    const r = Math.max(3, Math.min(cs * 0.45, 7));
    const open = this.pal.get('--cache');
    const closed = this.pal.get('--walker');
    for (let i = 0; i < status.length; i++) {
      const s = status[i];
      if (s !== 1 && s !== 2) continue;
      const p = pos(i);
      ctx.beginPath();
      ctx.arc(p.x * cs, p.y * cs, r, 0, Math.PI * 2);
      if (s === 2) {
        ctx.fillStyle = closed;
        ctx.fill();
      } else {
        ctx.fillStyle = this.pal.get('--paper');
        ctx.fill();
        ctx.strokeStyle = open;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    if (current >= 0) {
      const p = pos(current);
      ctx.strokeStyle = this.pal.get('--ink');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x * cs, p.y * cs, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/**
 * Keeps one HPA* graph alive across queries and edits, so its cache can be seen
 * growing (lazy mode) and only the touched tiles rebuilt after painting.
 */
export class HpaPlanner {
  private graph: HpaGraph | null = null;
  private key = '';
  private roundBuilt = new Map<number, number>();

  plan(ctx: PlanContext, cfg: HpaLaneConfig, pal: Palette): Plan {
    const { space, start, goal } = ctx;
    const messages: Message[] = [];
    const key = `${ctx.structureKey}|${cfg.cluster}|${cfg.lazy}`;
    let buildMs = 0;
    let buildKind = '';
    if (!this.graph || key !== this.key || ctx.changed === 'all') {
      const t0 = performance.now();
      this.graph = new HpaGraph(space, cfg.cluster, cfg.lazy);
      buildMs = performance.now() - t0;
      buildKind = 'full build';
      this.key = key;
    } else if (ctx.changed === 'none') {
      // Nothing edited (start or goal moved, or settings unrelated to the graph): keep the cache.
      this.graph.space = space;
      this.graph.lastRebuilt = new Set();
      buildKind = 'cache reused';
    } else {
      buildMs = this.graph.update(space, ctx.changed);
      const n = this.graph.lastRebuilt.size;
      buildKind = `rebuilt ${n} tile${n === 1 ? '' : 's'}`;
    }
    const g = this.graph;
    g.lastQueryBuilt = new Set();
    const builtBefore = g.builtCount();

    const rec = new Recorder(true);
    const t1 = performance.now();
    const r = hpaQuery(g, space, start, goal, cfg.heuristic, rec, cfg.weight);
    const firstMs = performance.now() - t1;
    const newlyBuilt = g.lastQueryBuilt.size;
    // Which unit built which tile, for this round of units (a new map each round, so old views keep theirs).
    const unit = ctx.unitIndex ?? 0;
    if (unit === 0) this.roundBuilt = new Map();
    for (const c of g.lastQueryBuilt) if (!this.roundBuilt.has(c)) this.roundBuilt.set(c, unit);
    // Time repeated queries now that everything they need is cached.
    let reps = 0;
    const t2 = performance.now();
    let elapsed = 0;
    do {
      hpaQuery(g, space, start, goal, cfg.heuristic, new Recorder(false), cfg.weight);
      reps++;
      elapsed = performance.now() - t2;
    } while (elapsed < 12 && reps < 200);

    const view = new HpaView(g, space, pal);
    if (unit > 0) view.roundBuilt = this.roundBuilt;
    const extra: Array<[string, string]> = [
      ['Tiles', `${fmt(g.clusterCount)} of ${g.C}×${g.C}`],
      ['Doors', fmt(g.nodeCount())],
      ['Cached tiles', `${fmt(g.builtCount())}${cfg.lazy ? ` (+${newlyBuilt} now)` : ''}`],
      ['Build', `${fmtTime(buildMs)} · ${buildKind}`],
      ['First query', fmtTime(firstMs)],
      ['Local search', `${fmt(r.insertionCells)} cells`],
    ];
    if (cfg.lazy && builtBefore > 0 && newlyBuilt === 0 && r.found)
      messages.push({ text: 'Every tile this query needed was already cached by earlier queries.', bad: false });
    if (r.usedDirect)
      messages.push({ text: 'Start and goal are in the same or neighbouring tiles, and a direct search inside those tiles beat the door route.', bad: false });
    const plan: Plan = {
      status: r.found ? 'found' : 'noPath',
      expanded: r.expanded,
      pushes: r.pushes,
      maxOpen: r.maxOpen,
      rec,
      rawPath: [],
      finalPath: [],
      length: NaN,
      cost: NaN,
      queryMs: elapsed / reps,
      extra,
      messages,
      view,
      note: 'Expanded, queued and max open count doors (abstract nodes), not cells. Time is a repeat query with the cache warm.',
      priority: 'g+wh',
      weight: cfg.weight,
      unitNote: newlyBuilt > 0 ? `built ${newlyBuilt} tile${newlyBuilt === 1 ? '' : 's'}` : r.usedDirect ? 'local search only' : 'all tiles cached',
      idSpace: 'shared',
    };
    if (r.found) {
      const raw: Pt[] = r.cells.map((n) => cellCenter(space, n));
      const sm = cfg.smoothing === 'shortcut' ? shortcut(space, r.cells) : r.cells;
      const m = measurePath(space, sm);
      plan.rawPath = raw;
      plan.finalPath = cfg.smoothing === 'shortcut' ? sm.map((n) => cellCenter(space, n)) : raw;
      plan.length = m.length;
      plan.cost = m.cost;
    }
    return plan;
  }
}
