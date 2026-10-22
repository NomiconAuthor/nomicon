import { MinHeap } from '../core/heap';
import { Recorder } from '../search/types';
import { fmt, fmtTime } from '../ui/dom';
import { drawTree, type Palette } from '../ui/renderer';
import { TERRAINS, type GridLayer } from '../world/world';
import { RecastNavmesh, areaCosts, funnel, loadRecast } from './navmesh';
import { polyLength, type Message, type Plan, type PlanContext, type Pt, type RepView, type ViewRect } from './types';

export interface NavLaneConfig {
  showDetour: boolean;
  useTerrain: boolean;
}

/**
 * A* over navmesh polygons: nodes are polygons, edges cross shared portals.
 * As in Detour, each polygon's position is the midpoint of the portal it was entered
 * through (the start point for the first one), and costs are distances between those.
 */
function polyAStar(nav: RecastNavmesh, sp: number, gp: number, startPt: Pt, goalPt: Pt, rec: Recorder, areaCost: number[]) {
  const n = nav.polys.length;
  const g = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const closed = new Uint8Array(n);
  const open = new MinHeap(256);
  // Heuristic: straight-line distance times the cheapest area cost, so it never overestimates.
  const minCost = Math.min(...areaCost);
  const h = (x: number, y: number) => minCost * Math.hypot(x - goalPt.x, y - goalPt.y);
  const cost = (poly: number) => areaCost[nav.polys[poly].area] ?? 1;
  g[sp] = 0;
  px[sp] = startPt.x;
  py[sp] = startPt.y;
  open.push(sp, h(startPt.x, startPt.y), 0);
  rec.open(sp, -1, 0, h(startPt.x, startPt.y));
  let expanded = 0;
  let pushes = 1;
  let maxOpen = 1;
  while (open.size) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    rec.close(cur);
    if (cur === gp) {
      const path: number[] = [];
      for (let c = gp; c !== -1; c = parent[c]) path.push(c);
      return { found: true, polys: path.reverse(), expanded, pushes, maxOpen, cost: g[gp] };
    }
    for (const link of nav.polys[cur].links) {
      if (closed[link.to]) continue;
      const mx = (link.left.x + link.right.x) / 2;
      const my = (link.left.y + link.right.y) / 2;
      // As in Detour: each leg is priced by the area of the polygon it crosses.
      let ng = g[cur] + cost(cur) * Math.hypot(mx - px[cur], my - py[cur]);
      if (link.to === gp) ng += cost(gp) * Math.hypot(goalPt.x - mx, goalPt.y - my);
      if (ng < g[link.to] - 1e-12) {
        g[link.to] = ng;
        parent[link.to] = cur;
        px[link.to] = mx;
        py[link.to] = my;
        const f = ng + (link.to === gp ? 0 : h(mx, my));
        open.push(link.to, f, -ng);
        rec.open(link.to, cur, ng, f);
        pushes++;
      }
    }
    if (open.size > maxOpen) maxOpen = open.size;
  }
  return { found: false, polys: [] as number[], expanded, pushes, maxOpen, cost: Infinity };
}

class NavView implements RepView {
  nodeCount: number;
  constructor(
    private nav: RecastNavmesh,
    private pal: Palette,
    private corridor: number[],
    private detour: Pt[] | null,
  ) {
    this.nodeCount = nav.polys.length;
  }
  nodeAt(x: number, y: number): number {
    // The convex polygon containing the point (same winding test for every edge).
    const polys = this.nav.polys;
    for (let i = 0; i < polys.length; i++) {
      const vs = polys[i].verts;
      let pos = 0;
      let neg = 0;
      for (let k = 0; k < vs.length; k++) {
        const a = vs[k];
        const b = vs[(k + 1) % vs.length];
        const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
        if (c > 1e-9) pos++;
        else if (c < -1e-9) neg++;
      }
      if (!(pos && neg) && vs.length >= 3) return i;
    }
    return -1;
  }
  nodeLabel(id: number): string {
    const p = this.nav.polys[id];
    return p ? `Polygon ${id} · ${TERRAINS[p.area]?.name.toLowerCase() ?? 'ground'} · ${p.verts.length} sides` : `Polygon ${id}`;
  }
  private visible(i: number, v: ViewRect): boolean {
    const c = this.nav.polys[i].centroid;
    return c.x >= v.x0 - 8 && c.x <= v.x1 + 9 && c.y >= v.y0 - 8 && c.y <= v.y1 + 9;
  }
  private polyPath(ctx: CanvasRenderingContext2D, i: number, cs: number): void {
    const vs = this.nav.polys[i].verts;
    ctx.moveTo(vs[0].x * cs, vs[0].y * cs);
    for (let k = 1; k < vs.length; k++) ctx.lineTo(vs[k].x * cs, vs[k].y * cs);
    ctx.closePath();
  }
  drawStructure(ctx: CanvasRenderingContext2D, v: ViewRect): void {
    const { nav, pal } = this;
    const cs = v.cs;
    // Tiles rebuilt by the last edit.
    const tcs = nav.tileCells;
    if (nav.lastRebuiltTiles.size < nav.tw * nav.th) {
      ctx.fillStyle = pal.get('--alert');
      ctx.globalAlpha = 0.1;
      for (const t of nav.lastRebuiltTiles) {
        const tx = t % nav.tw;
        const ty = (t - tx) / nav.tw;
        ctx.fillRect((nav.originX + tx * tcs) * cs, (nav.originY + ty * tcs) * cs, tcs * cs, tcs * cs);
      }
      ctx.globalAlpha = 1;
    }
    // Polygons, filled by terrain area (Recast splits polygons along terrain borders).
    for (let area = 0; area < TERRAINS.length; area++) {
      ctx.fillStyle = area === 0 ? pal.get('--vehicle') : pal.get(TERRAINS[area].color);
      ctx.globalAlpha = area === 0 ? 0.08 : 0.55;
      ctx.beginPath();
      for (let i = 0; i < nav.polys.length; i++) if (nav.polys[i].area === area && this.visible(i, v)) this.polyPath(ctx, i, cs);
      ctx.fill();
    }
    ctx.beginPath();
    for (let i = 0; i < nav.polys.length; i++) if (this.visible(i, v)) this.polyPath(ctx, i, cs);
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = pal.get('--vehicle');
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Tile borders.
    ctx.strokeStyle = pal.get('--ink');
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (let tx = 1; tx < nav.tw; tx++) {
      const x = (nav.originX + tx * tcs) * cs;
      ctx.moveTo(x, v.y0 * cs);
      ctx.lineTo(x, (v.y1 + 1) * cs);
    }
    for (let ty = 1; ty < nav.th; ty++) {
      const y = (nav.originY + ty * tcs) * cs;
      ctx.moveTo(v.x0 * cs, y);
      ctx.lineTo((v.x1 + 1) * cs, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  drawState(ctx: CanvasRenderingContext2D, v: ViewRect, status: Uint8Array, parent: Int32Array, current: number, tree: boolean): void {
    const { nav, pal } = this;
    const cs = v.cs;
    for (const [s, color] of [
      [2, pal.get('--closed')],
      [1, pal.get('--open')],
    ] as Array<[number, string]>) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i < status.length; i++) if (status[i] === s && this.visible(i, v)) this.polyPath(ctx, i, cs);
      ctx.fill();
    }
    // Once the search is done, outline the corridor of polygons the path runs through.
    const done = current < 0 && status.length > 0 && this.corridor.length > 0 && status[this.corridor[this.corridor.length - 1]] === 2;
    if (done) {
      ctx.strokeStyle = pal.get('--walker');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const i of this.corridor) this.polyPath(ctx, i, cs);
      ctx.stroke();
    }
    if (tree) drawTree(ctx, cs, status, parent, (i) => nav.polys[i].centroid, (i) => this.visible(i, v), pal.get('--tree'));
    if (current >= 0) {
      ctx.strokeStyle = pal.get('--walker');
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      this.polyPath(ctx, current, cs);
      ctx.stroke();
    }
    if (done && this.detour && this.detour.length > 1) {
      ctx.strokeStyle = pal.get('--vehicle');
      ctx.lineWidth = 2;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      this.detour.forEach((p, k) => (k ? ctx.lineTo(p.x * cs, p.y * cs) : ctx.moveTo(p.x * cs, p.y * cs)));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

/** Owns a Recast navmesh for one lane; rebuilds only edited tiles. */
export class NavmeshPlanner {
  private nav: RecastNavmesh | null = null;
  private key = '';
  loaded = false;
  loadError: string | null = null;

  constructor(onReady: () => void) {
    loadRecast().then(
      () => {
        this.loaded = true;
        onReady();
      },
      (e: unknown) => {
        this.loadError = String(e);
        onReady();
      },
    );
  }

  plan(ctx: PlanContext, layer: GridLayer, cfg: NavLaneConfig, pal: Palette, emptyView: RepView): Plan {
    const { space, start, goal } = ctx;
    const messages: Message[] = [];
    const base = (status: Plan['status']): Plan => ({
      status,
      expanded: 0,
      pushes: 0,
      maxOpen: 0,
      rec: new Recorder(true),
      rawPath: [],
      finalPath: [],
      length: NaN,
      cost: NaN,
      queryMs: NaN,
      extra: [],
      messages,
      view: emptyView,
    });
    if (this.loadError) {
      messages.push({ text: `Recast failed to load: ${this.loadError}`, bad: true });
      return base('unusable');
    }
    if (!this.loaded) {
      messages.push({ text: 'Loading Recast (WebAssembly)…', bad: false });
      return base('unusable');
    }
    const key = `${ctx.structureKey}`;
    let info;
    if (!this.nav || key !== this.key || ctx.changed === 'all') {
      this.nav?.destroy();
      this.nav = new RecastNavmesh(layer, space.opts.need);
      info = this.nav.build(layer, null);
      this.key = key;
    } else if (ctx.changed === 'none') {
      this.nav.lastRebuiltTiles = new Set();
      info = { ms: 0, tilesBuilt: 0, kind: 'reused' };
    } else {
      info = this.nav.build(layer, ctx.changed);
    }
    const nav = this.nav;
    const sPt = { x: space.x(start), y: space.y(start) };
    const gPt = { x: space.x(goal), y: space.y(goal) };
    const s = nav.nearest(sPt);
    const g = nav.nearest(gPt);
    const extra: Array<[string, string]> = [
      ['Polygons', fmt(nav.polys.length)],
      ['Tiles', `${fmt(nav.tw * nav.th)} of ${nav.tileCells}×${nav.tileCells}`],
      ['Voxel size', `${nav.cs} cell`],
      ['Build', `${fmtTime(info.ms)} · ${info.kind}`],
    ];
    const costs = areaCosts(cfg.useTerrain);
    if (!s || !g) {
      messages.push({ text: `${!s ? 'Start' : 'Goal'} is not on the navmesh for this unit size.`, bad: true });
      const p = base('unreachable');
      p.extra = extra;
      p.view = new NavView(nav, pal, [], null);
      return p;
    }
    const rec = new Recorder(true);
    const r = polyAStar(nav, s.poly, g.poly, s.point, g.point, rec, costs);
    let reps = 0;
    const t0 = performance.now();
    let elapsed = 0;
    do {
      const rr = polyAStar(nav, s.poly, g.poly, s.point, g.point, new Recorder(false), costs);
      if (rr.found) funnel(s.point, g.point, portalsOf(nav, rr.polys));
      reps++;
      elapsed = performance.now() - t0;
    } while (elapsed < 12 && reps < 200);
    let detour: Pt[] | null = null;
    let detourMs = NaN;
    if (cfg.showDetour) {
      const t1 = performance.now();
      detour = nav.detourPath(s.point, g.point, costs);
      detourMs = performance.now() - t1;
    }
    const plan = base(r.found ? 'found' : 'noPath');
    Object.assign(plan, { expanded: r.expanded, pushes: r.pushes, maxOpen: r.maxOpen, rec, queryMs: elapsed / reps, extra });
    plan.unitNote = info.kind === 'reused' ? 'navmesh reused' : `navmesh ${info.kind}`;
    plan.idSpace = 'shared';
    plan.priority = 'g+h';
    plan.view = new NavView(nav, pal, r.polys, detour);
    plan.note = 'Expanded, queued and max open count polygons. The page runs its own A* over Recast\'s polygons so the search can be stepped; the dotted purple line is Detour\'s own path.';
    if (r.found) {
      const centres = r.polys.map((i) => nav.polys[i].centroid);
      plan.rawPath = [s.point, ...centres.slice(1, -1), g.point];
      plan.finalPath = funnel(s.point, g.point, portalsOf(nav, r.polys));
      plan.length = polyLength(plan.finalPath);
      // Cost of the corridor as searched (portal midpoints, priced by each polygon's terrain).
      plan.cost = r.cost;
      extra.push(['Corridor', `${fmt(r.polys.length)} polygons`]);
      if (detour) extra.push(['Detour path', `${fmt(polyLength(detour), 2)} · ${fmtTime(detourMs)}`]);
    }
    return plan;
  }
}

function portalsOf(nav: RecastNavmesh, polys: number[]): Array<{ left: Pt; right: Pt }> {
  const out: Array<{ left: Pt; right: Pt }> = [];
  for (let k = 0; k + 1 < polys.length; k++) {
    const link = nav.polys[polys[k]].links.find((l) => l.to === polys[k + 1]);
    if (link) out.push({ left: link.left, right: link.right });
  }
  return out;
}

/** Exposed for the test suite. */
export const polyAStarForTest = polyAStar;
export const portalsOfForTest = portalsOf;
