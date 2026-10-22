import { makeRng } from '../core/rng';
import type { GridSpace } from '../graph/gridSpace';
import type { Message, Plan, Pt, RepView, VehiclePath, ViewRect } from '../rep/types';
import { EV_OPEN, Recorder, type SearchStatus } from '../search/types';
import type { Agent, Cell } from '../world/world';
import { UNIT_COLORS } from './renderer';

/** One unit's share of a lane's plan. */
export interface UnitPart {
  status: SearchStatus;
  rawPath: Pt[];
  finalPath: Pt[];
  length: number;
  cost: number;
  expanded: number;
  queryMs: number;
  /** What this query reused or built. */
  note: string;
  /** Range of this unit's events in the merged recording. */
  evStart: number;
  evEnd: number;
  /** Vehicles: poses along the path. */
  vehicle?: VehiclePath;
}

/** A lane's plan for every unit: the merged search for playback, plus each unit's own result. */
export interface LanePlan extends Plan {
  units: UnitPart[];
}

/**
 * Merges the plans of several units, planned one after another on the same lane.
 * Events are concatenated so playback runs unit 1's search, then unit 2's, and so on.
 * Representations whose node ids are shared (cells, doors, polygons, a kept roadmap)
 * draw with the last unit's view, which has seen everything the earlier ones built.
 * Ones with private ids (each RRT grows its own tree) get a composite view, with
 * each unit's ids shifted into its own range.
 */
export function mergePlans(parts: Plan[], emptyView: RepView): LanePlan {
  if (parts.length === 1) {
    const p = parts[0];
    return { ...p, units: [unitPart(p, 0, p.rec.length)] };
  }
  const own = parts.some((p) => p.idSpace === 'own');
  const offsets: number[] = [];
  let total = 0;
  for (const p of parts) {
    offsets.push(total);
    if (own) total += p.view.nodeCount;
  }
  const events = parts.reduce((n, p) => n + p.rec.length, 0);
  const rec = new Recorder(true, Math.max(events, 1));
  rec.data = new Int32Array(Math.max(3, events * 3));
  rec.gf = new Float32Array(Math.max(2, events * 2));
  rec.length = events;
  const units: UnitPart[] = [];
  let k = 0;
  parts.forEach((p, i) => {
    const off = offsets[i];
    const d = p.rec.data;
    const start = k;
    for (let e = 0; e < p.rec.length; e++, k++) {
      rec.data[3 * k] = d[3 * e];
      rec.data[3 * k + 1] = d[3 * e + 1] + off;
      const par = d[3 * e + 2];
      rec.data[3 * k + 2] = d[3 * e] === EV_OPEN && par >= 0 ? par + off : par;
      rec.gf[2 * k] = p.rec.gf[2 * e];
      rec.gf[2 * k + 1] = p.rec.gf[2 * e + 1];
    }
    if (p.rec.truncated) rec.truncated = true;
    units.push(unitPart(p, start, k));
  });

  let view: RepView = emptyView;
  if (own) {
    parts.forEach((p, i) => p.view.setTint?.(UNIT_COLORS[i % UNIT_COLORS.length], i, parts.length));
    view = new CompositeView(parts.map((p) => p.view), offsets);
  }
  else for (const p of parts) if (p.view !== emptyView && p.view.nodeCount >= view.nodeCount) view = p.view;

  // Messages: say once what every unit hit; name the units for the rest. Notes that only
  // some units got (cache hits, local searches) are left to the per-unit table, except problems.
  const byText = new Map<string, { bad: boolean; units: number[] }>();
  parts.forEach((p, i) => {
    for (const m of p.messages) {
      const e = byText.get(m.text) ?? { bad: m.bad, units: [] };
      if (!e.units.includes(i)) e.units.push(i);
      byText.set(m.text, e);
    }
  });
  const messages: Message[] = [];
  for (const [text, e] of byText) {
    if (e.units.length === parts.length) messages.push({ text, bad: e.bad });
    else if (e.bad) messages.push({ text: `${e.units.length === 1 ? 'Unit' : 'Units'} ${e.units.map((u) => u + 1).join(', ')}: ${text}`, bad: e.bad });
  }

  const found = parts.filter((p) => p.status === 'found');
  const sum = (f: (p: Plan) => number, list = parts) => list.reduce((n, p) => n + (Number.isFinite(f(p)) ? f(p) : 0), 0);
  const last = [...parts].reverse().find((p) => p.view !== emptyView) ?? parts[parts.length - 1];
  // Stats rows come from the last unit (the structure as it ends up), except the build,
  // which happened before the first unit that actually searched.
  const first = parts.find((p) => p.view !== emptyView);
  const firstBuild = first?.extra.find(([k]) => k === 'Build');
  const extra = last.extra.map(([k, v]): [string, string] => (k === 'Build' && firstBuild ? firstBuild : [k, v]));
  return {
    status: found.length ? 'found' : parts[0].status,
    expanded: sum((p) => p.expanded),
    pushes: sum((p) => p.pushes),
    maxOpen: Math.max(...parts.map((p) => p.maxOpen)),
    rec,
    rawPath: [],
    finalPath: [],
    length: found.length ? sum((p) => p.length, found) : NaN,
    cost: found.length ? sum((p) => p.cost, found) : NaN,
    queryMs: sum((p) => p.queryMs),
    extra,
    messages,
    note: last.note,
    view,
    units,
    priority: last.priority,
    weight: last.weight,
  };
}

function unitPart(p: Plan, evStart: number, evEnd: number): UnitPart {
  return {
    status: p.status,
    rawPath: p.rawPath,
    finalPath: p.finalPath,
    length: p.length,
    cost: p.cost,
    expanded: p.expanded,
    queryMs: p.queryMs,
    note: p.unitNote ?? '',
    evStart,
    evEnd,
    vehicle: p.vehicle,
  };
}

/** Several views side by side in one id space: part i owns ids [offset_i, offset_i + nodeCount_i). */
class CompositeView implements RepView {
  nodeCount: number;
  private local: Int32Array[] = [];
  constructor(
    private views: RepView[],
    private offsets: number[],
  ) {
    this.nodeCount = views.reduce((n, v) => n + v.nodeCount, 0);
    this.local = views.map((v) => new Int32Array(v.nodeCount));
  }
  drawStructure(ctx: CanvasRenderingContext2D, v: ViewRect): void {
    for (const view of this.views) view.drawStructure(ctx, v);
  }
  nodeAt(x: number, y: number, r: number): number {
    // Later units' trees draw on top, so look there first.
    for (let i = this.views.length - 1; i >= 0; i--) {
      const id = this.views[i].nodeAt?.(x, y, r) ?? -1;
      if (id >= 0) return id + this.offsets[i];
    }
    return -1;
  }
  nodeLabel(id: number): string {
    for (let i = this.views.length - 1; i >= 0; i--) {
      if (id >= this.offsets[i]) return `Unit ${i + 1} · ${this.views[i].nodeLabel?.(id - this.offsets[i]) ?? `node ${id - this.offsets[i]}`}`;
    }
    return `node ${id}`;
  }
  drawState(ctx: CanvasRenderingContext2D, v: ViewRect, status: Uint8Array, parent: Int32Array, current: number, tree: boolean): void {
    this.views.forEach((view, i) => {
      const off = this.offsets[i];
      const n = view.nodeCount;
      if (!n) return;
      const par = this.local[i];
      for (let j = 0; j < n; j++) {
        const q = parent[off + j];
        par[j] = q >= 0 ? q - off : q;
      }
      const cur = current >= off && current < off + n ? current - off : -1;
      view.drawState(ctx, v, status.subarray(off, off + n), par, cur, tree);
    });
  }
}

/**
 * A random start and goal for a new unit: both standable for this unit size, in the
 * same reachable area, and far apart, so each unit has a real journey to make.
 */
export function randomUnit(space: GridSpace, components: Int32Array, taken: Agent[], seed: number): Agent | null {
  const rng = makeRng(seed);
  const { w, h } = space;
  const used = new Set<number>();
  for (const u of taken) used.add(u.start.y * w + u.start.x).add(u.goal.y * w + u.goal.x);
  const pick = (ok: (i: number) => boolean): number => {
    for (let t = 0; t < 400; t++) {
      const i = Math.floor(rng() * w * h);
      if (space.passable(i) && !used.has(i) && ok(i)) return i;
    }
    return -1;
  };
  let best: [number, number] | null = null;
  let bestD = -1;
  const want = 0.45 * Math.hypot(w, h);
  for (let attempt = 0; attempt < 12; attempt++) {
    const a = pick(() => true);
    if (a < 0) break;
    const ax = a % w;
    const ay = Math.floor(a / w);
    for (let t = 0; t < 30; t++) {
      const b = pick((i) => components[i] === components[a] && i !== a);
      if (b < 0) break;
      const d = Math.hypot((b % w) - ax, Math.floor(b / w) - ay);
      if (d > bestD) {
        bestD = d;
        best = [a, b];
      }
      if (d >= want) break;
    }
    if (bestD >= want) break;
  }
  if (!best) return null;
  const cell = (i: number): Cell => ({ layer: 0, x: i % w, y: Math.floor(i / w) });
  return { start: cell(best[0]), goal: cell(best[1]) };
}
