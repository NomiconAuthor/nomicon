import { Recorder } from '../search/types';
import { fmt, fmtTime } from '../ui/dom';
import { CellImage, type Palette } from '../ui/renderer';
import { wrapPi, type Pose } from '../vehicle/curves';
import { FootprintChecker, distanceField, footprintCorners, holonomicField, innerDisc, vehicleById, type VehicleSpec } from '../vehicle/geometry';
import {
  LATTICE_ANGLES,
  clearLatticeCache,
  hybridAStar,
  latticeAStar,
  latticeTable,
  measurePoses,
  nearestLatticeHeading,
  vehicleRRT,
  type VehicleProblem,
  type VehicleResult,
  type VehicleTree,
} from '../vehicle/search';
import type { Message, Plan, PlanContext, RepView, VehicleShape, ViewRect } from './types';

export type VehicleAlg = 'hybrid' | 'lattice' | 'rrt';

export interface VehicleLaneConfig {
  alg: VehicleAlg;
  vehicle: string;
  /** Minimum turning radius in cells; 0 = the vehicle's own. */
  radius: number;
  reverse: boolean;
  anyHeading: boolean;
  bins: number;
  shots: boolean;
  limit: number;
  iterations: number;
  seed: number;
}


export const VEHICLE_ALGS: Array<{
  id: VehicleAlg;
  name: string;
  family: string;
  summary: string;
  chips: Array<[string, string]>;
  watch: string;
}> = [
  {
    id: 'hybrid',
    name: 'Hybrid A*',
    family: 'Search with continuous poses',
    summary:
      'A* over (cell, heading), but every node remembers the exact pose it was reached with, and children come from driving short arcs at a few steering angles, forwards and in reverse. Paths are drivable by construction. The heuristic is the larger of "cost ignoring turning" (which knows about walls and dead ends) and "shortest curve ignoring walls". Every few expansions it tries to finish with one Reeds–Shepp curve straight to the goal.',
    chips: [
      ['Optimal', 'No, but close'],
      ['Complete', 'Resolution-complete, roughly'],
      ['Path', 'Drivable arcs; exact goal pose only via the analytic shot'],
    ],
    watch:
      'Turn the analytic shot off and the search has to hit the goal cell and heading on its own: watch the expansions climb. On a tight map, watch it back out of dead ends (purple is reversing). The faint purple bands are the "ignoring turning" heuristic: it flows round walls, so the search is not lured into cul-de-sacs.',
  },
  {
    id: 'lattice',
    name: 'State lattice',
    family: 'Search over precomputed motions',
    summary:
      'States are cell centres with one of 16 headings. A small set of motion primitives (a straight step and the tightest clean turns to nearby headings, all ending exactly on the lattice) is computed once for the vehicle, together with every cell each primitive sweeps. Search is then plain A*, and collision checks are table lookups.',
    chips: [
      ['Optimal', 'Yes, for paths made of these primitives (with terrain costs, nearly)'],
      ['Complete', 'For this lattice'],
      ['Path', 'Drivable, but only 16 headings'],
    ],
    watch:
      'The primitive fan drawn at the start: that is the whole menu of moves. The table is built once per vehicle and turning radius and then shared by every unit and query (see the per-unit table). Start and goal headings snap to the nearest of the 16.',
  },
  {
    id: 'rrt',
    name: 'RRT with car steering',
    family: 'Sampling',
    summary:
      'An RRT whose every branch is drivable: from the nearest node (by distance and heading), follow the shortest Reeds–Shepp or Dubins curve toward a random pose for one step. Near the goal it tries the full curve to the goal.',
    chips: [
      ['Optimal', 'No'],
      ['Complete', 'Probabilistically'],
      ['Path', 'Drivable, wandering'],
    ],
    watch: 'How different the branches look from a point robot\'s RRT: every one is a sweep of arcs. Paths wander and reverse more than they need to; nothing is kept for the next query.',
  },
];

export function vehicleAlgInfo(id: VehicleAlg) {
  return VEHICLE_ALGS.find((a) => a.id === id) ?? VEHICLE_ALGS[0];
}

export function vehicleShape(cfg: VehicleLaneConfig): VehicleSpec {
  return vehicleById(cfg.vehicle);
}

export function turningRadius(cfg: VehicleLaneConfig): number {
  return cfg.radius > 0 ? cfg.radius : vehicleById(cfg.vehicle).radius;
}

/** Draws a vehicle search tree: each node joined to its parent by the motion that reached it. */
class VehicleView implements RepView {
  nodeCount: number;
  private tint = '--walker';
  private primary = true;
  private fieldImg: CellImage | null = null;
  constructor(
    private tree: VehicleTree,
    private pal: Palette,
    private shape: VehicleShape,
    private field: Float64Array | null,
    private w: number,
    private h: number,
    private fan: Array<Float32Array | number[]>,
    private shot: number[] | null,
  ) {
    this.nodeCount = tree.size;
  }
  setTint(colorToken: string, index = 0, count = 1): void {
    this.tint = colorToken;
    this.primary = index === count - 1;
  }
  nodeAt(x: number, y: number, r: number): number {
    let best = -1;
    let bd = r * r;
    const t = this.tree;
    for (let i = 0; i < t.size; i++) {
      const d = (t.x[i] - x) ** 2 + (t.y[i] - y) ** 2;
      if (d <= bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
  nodeLabel(id: number): string {
    const t = this.tree;
    const deg = Math.round((((t.t[id] * 180) / Math.PI) % 360 + 360) % 360);
    return `Pose ${t.x[id].toFixed(1)}, ${t.y[id].toFixed(1)} facing ${deg}° · ${t.dir[id] < 0 ? 'reversing' : 'forward'}`;
  }
  private inView(i: number, v: ViewRect): boolean {
    const x = this.tree.x[i];
    const y = this.tree.y[i];
    return x >= v.x0 - 8 && x <= v.x1 + 9 && y >= v.y0 - 8 && y <= v.y1 + 9;
  }
  drawStructure(ctx: CanvasRenderingContext2D, v: ViewRect): void {
    const cs = v.cs;
    // Bands of the "ignoring turning" heuristic (the last unit's goal only).
    if (this.field && this.primary) {
      if (!this.fieldImg) {
        // Alternate bands of equal cost-to-goal, like contour rings on a map.
        const img = new CellImage(this.w, this.h);
        const f = this.field;
        let max = 0;
        for (let i = 0; i < f.length; i++) if (Number.isFinite(f[i]) && f[i] > max) max = f[i];
        const band = Math.max(2, max / 14);
        const col = this.pal.packed('--vehicle', 0.07);
        for (let i = 0; i < f.length; i++) if (Number.isFinite(f[i]) && Math.floor(f[i] / band) % 2 === 1) img.px[i] = col;
        img.commit();
        this.fieldImg = img;
      }
      this.fieldImg.draw(ctx, cs);
    }
    // The menu of moves at the start (lattice primitives, or Hybrid A*'s arcs).
    if (this.fan.length && this.tree.size) {
      ctx.strokeStyle = this.pal.get('--vehicle');
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = Math.max(1, Math.min(2, cs * 0.08));
      for (const pts of this.fan) {
        ctx.beginPath();
        for (let k = 0; k < pts.length; k += 4) {
          const x = pts[k] * cs;
          const y = pts[k + 1] * cs;
          if (k) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
  drawState(ctx: CanvasRenderingContext2D, v: ViewRect, status: Uint8Array, _parent: Int32Array, current: number): void {
    const { tree, pal } = this;
    const cs = v.cs;
    const lw = Math.max(0.8, Math.min(1.8, cs * 0.06));
    // Open (queued) motions first and faint, then the expanded ones on top.
    const groups: Array<[string, number, (i: number) => boolean]> = [
      [pal.get('--cache'), 0.45, (i) => status[i] === 1],
      [pal.get(this.tint), 1, (i) => status[i] === 2 && tree.dir[i] > 0],
      [pal.get('--vehicle'), 1, (i) => status[i] === 2 && tree.dir[i] < 0],
    ];
    let budget = 120000;
    for (const [color, alpha, want] of groups) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = alpha < 1 ? lw * 0.7 : lw;
      ctx.beginPath();
      for (let i = 1; i < tree.size && budget > 0; i++) {
        if (!want(i)) continue;
        const p = tree.parent[i];
        if (p < 0 || (!this.inView(i, v) && !this.inView(p, v))) continue;
        budget--;
        const n = tree.ptsN[i];
        if (n) {
          const at = tree.ptsAt[i];
          ctx.moveTo(tree.pts[at] * cs, tree.pts[at + 1] * cs);
          for (let q = 1; q < n; q++) ctx.lineTo(tree.pts[at + 2 * q] * cs, tree.pts[at + 2 * q + 1] * cs);
        } else {
          // A short arc: a quadratic curve leaving along the parent's heading.
          const ax = tree.x[p];
          const ay = tree.y[p];
          const bx = tree.x[i];
          const by = tree.y[i];
          const d = Math.hypot(bx - ax, by - ay);
          if (d < 1e-6) {
            // Turned on the spot: a little tick showing the new heading.
            ctx.moveTo(bx * cs, by * cs);
            ctx.lineTo((bx + 0.6 * Math.cos(tree.t[i])) * cs, (by + 0.6 * Math.sin(tree.t[i])) * cs);
            continue;
          }
          const s = tree.dir[i] * d * 0.5;
          ctx.moveTo(ax * cs, ay * cs);
          ctx.quadraticCurveTo((ax + s * Math.cos(tree.t[p])) * cs, (ay + s * Math.sin(tree.t[p])) * cs, bx * cs, by * cs);
        }
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // The analytic shot that ended the search, once playback reaches the end.
    if (this.shot && current < 0 && status[0] === 2) {
      ctx.strokeStyle = pal.get('--alert');
      ctx.lineWidth = Math.max(1.5, cs * 0.1);
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (let k = 0; k < this.shot.length; k += 4) {
        if (k) ctx.lineTo(this.shot[k] * cs, this.shot[k + 1] * cs);
        else ctx.moveTo(this.shot[k] * cs, this.shot[k + 1] * cs);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // The pose being expanded, with the vehicle's outline.
    if (current >= 0 && current < tree.size) {
      const c = footprintCorners(this.shape, tree.pose(current));
      ctx.strokeStyle = pal.get('--ink');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      c.forEach(([x, y], k) => (k ? ctx.lineTo(x * cs, y * cs) : ctx.moveTo(x * cs, y * cs)));
      ctx.closePath();
      ctx.stroke();
    }
  }
}

/**
 * Plans for a vehicle. Keeps the distance field (per map version), heuristic fields
 * (per goal, so units heading to the same place share one) and, through the search
 * module, the lattice tables (per vehicle).
 */
export class VehiclePlanner {
  private dist: Float32Array | null = null;
  private distKey = '';
  private fields = new Map<string, Float64Array>();

  plan(ctx: PlanContext, cfg: VehicleLaneConfig, pal: Palette, emptyView: RepView): Plan {
    const { space } = ctx;
    const layer = space.layer;
    const spec = vehicleShape(cfg);
    const radius = turningRadius(cfg);
    const messages: Message[] = [];
    const t0 = performance.now();
    const built: string[] = [];
    if (!this.dist || this.distKey !== ctx.structureKey || ctx.changed !== 'none' || this.dist.length !== space.count) {
      this.dist = distanceField(space.w, space.h, layer.blocked);
      this.distKey = ctx.structureKey;
      this.fields.clear();
      built.push('distance field');
      if (ctx.changed === 'all') clearLatticeCache();
    }
    const dist = this.dist;
    const check = new FootprintChecker(space.w, space.h, layer.blocked, dist, spec);
    const start: Pose = { x: space.x(ctx.start), y: space.y(ctx.start), theta: ctx.startHeading ?? 0 };
    const goal: Pose = { x: space.x(ctx.goal), y: space.y(ctx.goal), theta: ctx.goalHeading ?? 0 };
    const rec = new Recorder(true);
    const base = (status: Plan['status'], text: string, note: string): Plan => ({
      status,
      expanded: 0,
      pushes: 0,
      maxOpen: 0,
      rec,
      rawPath: [],
      finalPath: [],
      length: NaN,
      cost: NaN,
      queryMs: NaN,
      extra: [],
      messages: [{ text, bad: true }],
      view: emptyView,
      unitNote: note,
      idSpace: 'own',
    });
    const latticeMode = cfg.alg === 'lattice';
    const sPose = latticeMode ? { ...start, theta: LATTICE_ANGLES[nearestLatticeHeading(start.theta)] } : start;
    const gPose = latticeMode ? { ...goal, theta: LATTICE_ANGLES[nearestLatticeHeading(goal.theta)] } : goal;
    if (!check.free(sPose.x, sPose.y, sPose.theta))
      return base('unreachable', `The ${spec.name.toLowerCase()} doesn't fit at its start${latticeMode ? ' (at the nearest lattice heading)' : ''}. Move it or turn it with its handle.`, "doesn't fit at start");
    const goalFits = cfg.anyHeading ? Array.from({ length: 16 }, (_, k) => (k * Math.PI) / 8).some((t) => check.free(gPose.x, gPose.y, t)) : check.free(gPose.x, gPose.y, gPose.theta);
    if (!goalFits) return base('unreachable', `The ${spec.name.toLowerCase()} doesn't fit at the goal${cfg.anyHeading ? ' in any direction' : ' facing that way'}. Move the goal or turn it with its handle.`, "doesn't fit at goal");

    const fkey = `${ctx.goal}|${spec.id}|${space.opts.useTerrain}`;
    let field = this.fields.get(fkey);
    if (!field) {
      field = holonomicField(space, dist, innerDisc(spec), ctx.goal);
      if (this.fields.size > 8) this.fields.delete(this.fields.keys().next().value!);
      this.fields.set(fkey, field);
      built.push('heuristic field');
    }
    // The lattice's primitives (built once per vehicle, then shared).
    const table = cfg.alg === 'lattice' ? latticeTable(spec, radius, cfg.reverse) : null;
    if (table && table.served === 1) built.push(`${table.count} motion primitives`);
    const prepMs = performance.now() - t0;
    if (!Number.isFinite(field[ctx.start]))
      return {
        ...base(
          'unreachable',
          `Even ignoring how it turns, the ${spec.name.toLowerCase()} can't get from its start to the goal: some gap on the way is narrower than the vehicle.`,
          'unreachable, even ignoring turning',
        ),
        messages: [{ text: `Even ignoring how it turns, the ${spec.name.toLowerCase()} can't get from its start to the goal: some gap on the way is narrower than the vehicle.`, bad: false }],
      };

    const pr: VehicleProblem = { space, check, spec, radius, reverse: cfg.reverse, start: sPose, goal: gPose, anyHeading: cfg.anyHeading, field, rec };
    let r: VehicleResult;
    let fan: Array<Float32Array | number[]> = [];
    const t1 = performance.now();
    let tableNote = '';
    if (table) {
      tableNote = table.served === 1 ? `built ${table.count} primitives (${fmtTime(table.ms)})` : 'primitives reused';
      r = latticeAStar(pr, table, cfg.limit);
      const hd = nearestLatticeHeading(sPose.theta);
      fan = table.prims[hd].map((p) => {
        const out: number[] = [];
        for (let k = 0; k < p.poses.length; k += 4) out.push(sPose.x + p.poses[k], sPose.y + p.poses[k + 1], 0, 0);
        return out;
      });
    } else if (cfg.alg === 'rrt') {
      r = vehicleRRT(pr, { iterations: cfg.iterations, seed: cfg.seed });
    } else {
      r = hybridAStar(pr, { bins: cfg.bins, shots: cfg.shots, limit: cfg.limit });
      // Hybrid A*'s menu: one arc per steering angle, each way.
      const step = Math.max(1.5, Math.min(radius * 0.6, 2.2));
      for (const dir of cfg.reverse ? [1, -1] : [1])
        for (const steer of [-1, -0.5, 0, 0.5, 1]) {
          const out: number[] = [];
          const kappa = steer / radius;
          for (let j = 0; j <= 6; j++) {
            const s = (dir * step * 2 * j) / 6;
            if (Math.abs(kappa) < 1e-9) out.push(sPose.x + s * Math.cos(sPose.theta), sPose.y + s * Math.sin(sPose.theta), 0, 0);
            else {
              const t2 = sPose.theta + kappa * s;
              out.push(sPose.x + (Math.sin(t2) - Math.sin(sPose.theta)) / kappa, sPose.y + (Math.cos(sPose.theta) - Math.cos(t2)) / kappa, 0, 0);
            }
          }
          fan.push(out);
        }
    }
    const searchMs = performance.now() - t1;
    const view = new VehicleView(r.tree, pal, spec, cfg.alg === 'rrt' ? null : field, space.w, space.h, fan, r.shot);
    const extra: Array<[string, string]> = [
      ['Vehicle', `${spec.name} · turns ${fmt(radius, radius % 1 ? 1 : 0)} cells`],
      ...r.extra,
      ['Prep', built.length ? `${fmtTime(prepMs)} · ${built.join(', ')}` : `${fmtTime(prepMs)} · reused`],
    ];
    if (cfg.alg === 'lattice') {
      const diff = Math.abs(wrapPi(sPose.theta - start.theta)) + Math.abs(wrapPi(gPose.theta - goal.theta));
      if (diff > 0.02) messages.push({ text: 'Start and goal headings were snapped to the nearest of the lattice\'s 16 headings.', bad: false });
    }
    if (!r.found) messages.push({ text: r.reason, bad: true });
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
      queryMs: searchMs,
      extra,
      messages,
      view,
      note:
        cfg.alg === 'rrt'
          ? 'Expanded counts tree nodes. Time is one run, recording included.'
          : 'Expanded counts poses taken off the open list. Cost is length priced by terrain; reversing and gear-change penalties steer the search but aren\'t included. Time is one run, recording included.',
      idSpace: 'own',
      priority: cfg.alg === 'rrt' ? undefined : 'g+h',
    };
    if (r.found) {
      const m = measurePoses(space, r.poses);
      const pts = [];
      for (let k = 0; k < r.poses.length; k += 4) pts.push({ x: r.poses[k], y: r.poses[k + 1] });
      plan.rawPath = pts;
      plan.finalPath = pts;
      plan.length = m.length;
      plan.cost = m.cost;
      plan.vehicle = { poses: Float32Array.from(r.poses), shape: { length: spec.length, width: spec.width, rear: spec.rear } };
      extra.push(['Reversing', `${fmt(m.reverse, 1)} cells`]);
    }
    const unitNotes: Record<VehicleAlg, string> = {
      hybrid: built.includes('heuristic field') ? 'new search · built heuristic field' : 'new search · heuristic field reused (same goal)',
      lattice: tableNote,
      rrt: `new tree · ${fmt(r.tree.size)} nodes`,
    };
    plan.unitNote = unitNotes[cfg.alg];
    return plan;
  }
}
