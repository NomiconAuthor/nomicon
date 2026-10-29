/**
 * Cover generation algorithms, recorded step by step for playback.
 *
 *   scan     Grid edge scan: visit every cell, mark walkable cells beside cover.
 *   walk     Recast-style boundary walk: trace the outline of walkable space where it
 *            meets obstacles, simplify it, walk the simplified edges at a fixed spacing
 *            probing for cover height, merge samples into rails, and add peek points
 *            where the cover ends.
 *   random / poisson / biased   Sample points and probe around each one.
 */
import { makeRng } from '../lab/core/rng';
import { coverAt, type CoverCell } from './analysis';
import { EventTrace, type Caption, type Stat } from './playback';
import { BUILDING, KINDS, LOW, type TWorld, inside } from './world';

export type CoverAlgo = 'scan' | 'walk' | 'random' | 'poisson' | 'biased';
export const COVER_ALGOS: Array<[CoverAlgo, string, string]> = [
  ['scan', 'Grid edge scan', 'exhaustive'],
  ['walk', 'Boundary walk (Recast-style)', 'exhaustive'],
  ['random', 'Random sampling', 'stochastic'],
  ['poisson', 'Poisson-disk sampling', 'stochastic'],
  ['biased', 'Edge-biased sampling', 'stochastic'],
];

const percent = (a: number, b: number) => `${Math.round((a / Math.max(1, b)) * 100)}%`;

/** Ground-truth cover cells (every walkable cell with a low wall or building beside it). */
export function coverTruth(t: TWorld): Map<number, CoverCell> {
  const m = new Map<number, CoverCell>();
  for (let i = 0; i < t.w * t.h; i++) {
    const c = coverAt(t, i);
    if (c) m.set(i, c);
  }
  return m;
}

interface Colours {
  get(name: string): string;
  rgba(name: string, a: number): string;
}

function drawCoverCell(ctx: CanvasRenderingContext2D, t: TWorld, cs: number, c: CoverCell, colour: string): void {
  const x = (c.i % t.w) * cs;
  const y = Math.floor(c.i / t.w) * cs;
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1.5, cs * 0.28);
  const o = ctx.lineWidth / 2;
  ctx.beginPath();
  if (c.dirs & 1) ((ctx.moveTo(x + cs - o, y), ctx.lineTo(x + cs - o, y + cs)));
  if (c.dirs & 2) ((ctx.moveTo(x, y + cs - o), ctx.lineTo(x + cs, y + cs - o)));
  if (c.dirs & 4) ((ctx.moveTo(x + o, y), ctx.lineTo(x + o, y + cs)));
  if (c.dirs & 8) ((ctx.moveTo(x, y + o), ctx.lineTo(x + cs, y + o)));
  ctx.stroke();
  ctx.lineWidth = 1;
}

function drawMissed(ctx: CanvasRenderingContext2D, t: TWorld, cs: number, truth: Map<number, CoverCell>, found: Set<number>, col: Colours): void {
  for (const c of truth.values()) if (!found.has(c.i)) drawCoverCell(ctx, t, cs, c, col.rgba('--alert', 0.3));
}

// ===========================================================================
// Grid edge scan

type ScanEvent = { row: number };

export class ScanTrace extends EventTrace<ScanEvent> {
  private found = new Map<number, CoverCell>();
  private row = -1;
  private truth: Map<number, CoverCell>;
  constructor(
    private t: TWorld,
    private col: Colours,
  ) {
    super();
    this.truth = coverTruth(t);
    for (let r = 0; r < t.h; r++) this.events.push({ row: r });
    this.marks = [t.h - 1];
  }
  protected reset(): void {
    this.found.clear();
    this.row = -1;
  }
  protected apply(e: ScanEvent): void {
    this.row = e.row;
    for (let x = 0; x < this.t.w; x++) {
      const c = this.truth.get(e.row * this.t.w + x);
      if (c) this.found.set(c.i, c);
    }
  }
  draw(ctx: CanvasRenderingContext2D, cs: number): void {
    const t = this.t;
    for (const c of this.found.values()) drawCoverCell(ctx, t, cs, c, this.col.get(c.full ? '--accent' : '--walker'));
    if (this.row < t.h - 1 && this.row >= 0) {
      ctx.fillStyle = this.col.rgba('--accent', 0.18);
      ctx.fillRect(0, this.row * cs, t.w * cs, cs);
    }
  }
  caption(): Caption {
    if (this.row < this.t.h - 1)
      return {
        title: `Row ${this.row + 1} of ${this.t.h}.`,
        text: 'Visit every cell. A walkable cell with a low wall or building directly beside it (north, south, east or west) is a cover position; the line marks which side the cover is on. Blue is full height (stand behind it), yellow is low (crouch).',
      };
    return {
      title: 'Done.',
      text: `Every cell was visited once: ${this.t.w * this.t.h} checks, and every cover position found, including ones in the thinnest gaps. Exhaustive and exact, but on its own it gives cells, not structure: no rails to slide along, no corners to peek from. The boundary walk adds that.`,
    };
  }
  stats(): Stat[] {
    const full = [...this.found.values()].filter((c) => c.full).length;
    return [
      [String(((this.row + 1) * this.t.w).toLocaleString()), 'cells checked'],
      [String(this.found.size), 'cover positions'],
      [`${full} / ${this.found.size - full}`, 'full / low'],
      [percent(this.found.size, this.truth.size), 'of all cover found'],
    ];
  }
}

// ===========================================================================
// Recast-style boundary walk

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}
interface Sample {
  x: number;
  y: number;
  /** Where the probe ended (hit point or full length). */
  px: number;
  py: number;
  kind: 'full' | 'low' | 'none';
  poly: number;
  /** Which edge of the simplified outline it was taken on. */
  seg: number;
  /** Tangent along the edge, for peeks. */
  tx: number;
  ty: number;
  nx: number;
  ny: number;
}
interface Rail {
  samples: Sample[];
  kind: 'full' | 'low';
}
interface Peek {
  x: number;
  y: number;
  fromX: number;
  fromY: number;
}

type WalkEvent =
  | { k: 'seg'; segs: Seg[]; chain: number }
  | { k: 'simplify'; chain: number; poly: Array<[number, number]> }
  | { k: 'sample'; s: Sample }
  | { k: 'rail'; rail: Rail }
  | { k: 'peek'; p: Peek };

/** Is the obstacle cell at (x, y) something that gives cover? */
const isCoverObstacle = (t: TWorld, x: number, y: number) => inside(t, x, y) && (t.kind[y * t.w + x] === LOW || t.kind[y * t.w + x] === BUILDING);

/** Douglas-Peucker simplification of a polyline (vertices in lattice coordinates). */
function simplify(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const rec = (a: number, b: number) => {
    let best = -1;
    let bd = tol;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const L = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = L < 1e-9 ? Math.hypot(px - ax, py - ay) : Math.abs((px - ax) * dy - (py - ay) * dx) / L;
      if (d > bd) ((bd = d), (best = i));
    }
    if (best >= 0) {
      keep[best] = 1;
      rec(a, best);
      rec(best, b);
    }
  };
  // Closed loops: split at the vertex farthest from the start so both halves simplify.
  const closed = pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  if (closed && pts.length > 3) {
    let far = 1;
    let fd = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
      if (d > fd) ((fd = d), (far = i));
    }
    keep[far] = 1;
    rec(0, far);
    rec(far, pts.length - 1);
  } else rec(0, pts.length - 1);
  return pts.filter((_, i) => keep[i]);
}

export class WalkTrace extends EventTrace<WalkEvent> {
  private segs: Array<{ seg: Seg; chain: number }> = [];
  private polys = new Map<number, Array<[number, number]>>();
  private samples: Sample[] = [];
  private rails: Rail[] = [];
  private peeks: Peek[] = [];
  private phase = 'start';
  private truth: Map<number, CoverCell>;
  private counts = { segs: 0, chains: 0, verts: 0, samples: 0, rails: 0, peeks: 0 };

  constructor(
    private t: TWorld,
    private col: Colours,
    private spacing = 1,
    private tol = 0.5,
  ) {
    super();
    this.truth = coverTruth(t);
    this.record();
  }

  private record(): void {
    const t = this.t;
    // 1. Boundary segments: each side of a walkable cell that faces a cover obstacle,
    //    oriented so the walkable side is on the left of the direction of travel.
    const segs: Seg[] = [];
    for (let y = 0; y < t.h; y++)
      for (let x = 0; x < t.w; x++) {
        if (!KINDS[t.kind[y * t.w + x]].walk) continue;
        if (isCoverObstacle(t, x + 1, y)) segs.push({ ax: x + 1, ay: y, bx: x + 1, by: y + 1 });
        if (isCoverObstacle(t, x - 1, y)) segs.push({ ax: x, ay: y + 1, bx: x, by: y });
        if (isCoverObstacle(t, x, y + 1)) segs.push({ ax: x + 1, ay: y + 1, bx: x, by: y + 1 });
        if (isCoverObstacle(t, x, y - 1)) segs.push({ ax: x, ay: y, bx: x + 1, by: y });
      }
    // 2. Chain them into outlines by joining each segment's end to the next one's start.
    const key = (x: number, y: number) => y * (t.w + 1) + x;
    const byStart = new Map<number, number[]>();
    const incoming = new Map<number, number>();
    segs.forEach((s, i) => {
      const k = key(s.ax, s.ay);
      byStart.set(k, [...(byStart.get(k) ?? []), i]);
      incoming.set(key(s.bx, s.by), (incoming.get(key(s.bx, s.by)) ?? 0) + 1);
    });
    const used = new Uint8Array(segs.length);
    const chains: number[][] = [];
    const follow = (start: number) => {
      const chain: number[] = [];
      let cur = start;
      while (cur >= 0 && !used[cur]) {
        used[cur] = 1;
        chain.push(cur);
        const nexts = (byStart.get(key(segs[cur].bx, segs[cur].by)) ?? []).filter((n) => !used[n]);
        cur = nexts.length ? nexts[0] : -1;
      }
      chains.push(chain);
    };
    // Open outlines first (they start where an obstacle meets something else), then loops.
    segs.forEach((s, i) => {
      if (!used[i] && !incoming.get(key(s.ax, s.ay))) follow(i);
    });
    segs.forEach((_, i) => {
      if (!used[i]) follow(i);
    });
    this.marks = [];
    // One step per outline, so the playback draws whole outlines at a time.
    chains.forEach((c, ci) => this.events.push({ k: 'seg', segs: c.map((si) => segs[si]), chain: ci }));
    this.marks.push(this.events.length - 1);
    // 3. Simplify each outline.
    const polys: Array<Array<[number, number]>> = chains.map((c) => {
      const pts: Array<[number, number]> = [[segs[c[0]].ax, segs[c[0]].ay]];
      for (const si of c) pts.push([segs[si].bx, segs[si].by]);
      return simplify(pts, this.tol);
    });
    polys.forEach((p, ci) => this.events.push({ k: 'simplify', chain: ci, poly: p }));
    this.marks.push(this.events.length - 1);
    // 4. Walk each simplified edge at a fixed spacing, probing towards the obstacle.
    const allSamples: Sample[] = [];
    polys.forEach((poly, pi) => {
      for (let v = 0; v + 1 < poly.length; v++) {
        const [ax, ay] = poly[v];
        const [bx, by] = poly[v + 1];
        const L = Math.hypot(bx - ax, by - ay);
        if (L < 1e-6) continue;
        const tx = (bx - ax) / L;
        const ty = (by - ay) / L;
        // Unit normal pointing to the walkable side of the edge.
        const nx = -ty;
        const ny = tx;
        for (let d = this.spacing / 2; d < L; d += this.spacing) {
          const x = ax + tx * d + nx * 0.5;
          const y = ay + ty * d + ny * 0.5;
          let kind: Sample['kind'] = 'none';
          let px = x - nx * 1.5;
          let py = y - ny * 1.5;
          const cx0 = Math.floor(x);
          const cy0 = Math.floor(y);
          if (inside(t, cx0, cy0) && KINDS[t.kind[cy0 * t.w + cx0]].walk) {
            for (let s = 0.25; s <= 1.5; s += 0.25) {
              const cx = Math.floor(x - nx * s);
              const cy = Math.floor(y - ny * s);
              if (!inside(t, cx, cy)) break;
              const k = t.kind[cy * t.w + cx];
              if (KINDS[k].walk) continue;
              // Two probes, as an engine would cast: at crouch height and at standing height.
              const hgt = KINDS[k].height;
              kind = hgt >= 1.5 ? 'full' : hgt >= 0.8 ? 'low' : 'none';
              px = x - nx * s;
              py = y - ny * s;
              break;
            }
          }
          const smp: Sample = { x, y, px, py, kind, poly: pi, seg: v, tx, ty, nx, ny };
          allSamples.push(smp);
          this.events.push({ k: 'sample', s: smp });
        }
      }
    });
    this.marks.push(this.events.length - 1);
    // 5. Merge consecutive samples of the same kind into rails; add peek points at their ends.
    let cur: Rail | null = null;
    const rails: Rail[] = [];
    let prev: Sample | null = null;
    for (const s of allSamples) {
      // Split rails at convex corners (where the outline turns away from the walkable side):
      // the cover ends there, so each side is its own rail with a peekable end.
      const convex = prev && s.poly === prev.poly && s.seg !== prev.seg && prev.tx * s.ty - prev.ty * s.tx < -0.3;
      const joins = prev && cur && !convex && s.poly === prev.poly && s.kind === cur.kind && Math.hypot(s.x - prev.x, s.y - prev.y) <= this.spacing * 1.6;
      if (s.kind !== 'none' && joins && cur) cur.samples.push(s);
      else {
        if (cur && cur.samples.length >= 2) rails.push(cur);
        cur = s.kind !== 'none' ? { samples: [s], kind: s.kind } : null;
      }
      prev = s;
    }
    if (cur && cur.samples.length >= 2) rails.push(cur);
    for (const r of rails) this.events.push({ k: 'rail', rail: r });
    this.marks.push(this.events.length - 1);
    // Peek points: step a metre past each end of a rail; if the cover has ended there and
    // the spot is walkable, a unit can lean or step out from the end of the rail.
    for (const r of rails) {
      const ends: Array<[Sample, number]> = [
        [r.samples[0], -1],
        [r.samples[r.samples.length - 1], 1],
      ];
      for (const [s, dir] of ends) {
        const x = s.x + s.tx * dir * 1.2;
        const y = s.y + s.ty * dir * 1.2;
        const cx = Math.floor(x);
        const cy = Math.floor(y);
        if (!inside(t, cx, cy) || !KINDS[t.kind[cy * t.w + cx]].walk) continue;
        let covered = false;
        for (let d = 0.25; d <= 1.25; d += 0.25) {
          const ox = Math.floor(x - s.nx * d);
          const oy = Math.floor(y - s.ny * d);
          if (isCoverObstacle(t, ox, oy)) covered = true;
        }
        if (!covered) this.events.push({ k: 'peek', p: { x, y, fromX: s.x, fromY: s.y } });
      }
    }
    this.marks.push(this.events.length - 1);
    this.counts = { segs: segs.length, chains: chains.length, verts: polys.reduce((a, p) => a + p.length, 0), samples: allSamples.length, rails: rails.length, peeks: 0 };
  }

  protected reset(): void {
    this.segs = [];
    this.polys.clear();
    this.samples = [];
    this.rails = [];
    this.peeks = [];
    this.phase = 'start';
  }
  protected apply(e: WalkEvent): void {
    this.phase = e.k;
    if (e.k === 'seg') for (const seg of e.segs) this.segs.push({ seg, chain: e.chain });
    else if (e.k === 'simplify') this.polys.set(e.chain, e.poly);
    else if (e.k === 'sample') this.samples.push(e.s);
    else if (e.k === 'rail') this.rails.push(e.rail);
    else this.peeks.push(e.p);
  }

  draw(ctx: CanvasRenderingContext2D, cs: number): void {
    const col = this.col;
    // Raw outline (fades once simplified).
    const simplified = this.polys.size > 0;
    ctx.strokeStyle = col.rgba('--accent', simplified ? 0.25 : 0.9);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const { seg } of this.segs) {
      ctx.moveTo(seg.ax * cs, seg.ay * cs);
      ctx.lineTo(seg.bx * cs, seg.by * cs);
    }
    ctx.stroke();
    // The outline just added, highlighted.
    if (this.phase === 'seg' && this.segs.length) {
      const last = this.segs[this.segs.length - 1].chain;
      ctx.strokeStyle = col.get('--walker');
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (const { seg, chain } of this.segs)
        if (chain === last) {
          ctx.moveTo(seg.ax * cs, seg.ay * cs);
          ctx.lineTo(seg.bx * cs, seg.by * cs);
        }
      ctx.stroke();
      ctx.lineWidth = 2;
    }
    if (simplified) {
      ctx.strokeStyle = col.get('--accent');
      ctx.fillStyle = col.get('--accent');
      for (const p of this.polys.values()) {
        ctx.beginPath();
        p.forEach(([x, y], i) => (i ? ctx.lineTo(x * cs, y * cs) : ctx.moveTo(x * cs, y * cs)));
        ctx.stroke();
        if (this.phase === 'simplify') for (const [x, y] of p) ctx.fillRect(x * cs - 2, y * cs - 2, 4, 4);
      }
    }
    // Samples and their probes.
    const showProbes = this.phase === 'sample';
    const last = this.samples.length - 1;
    this.samples.forEach((s, i) => {
      const c = s.kind === 'full' ? '--accent' : s.kind === 'low' ? '--walker' : '--alert';
      if (showProbes && i > last - 60) {
        ctx.strokeStyle = col.rgba(c, i === last ? 1 : 0.5);
        ctx.lineWidth = i === last ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(s.x * cs, s.y * cs);
        ctx.lineTo(s.px * cs, s.py * cs);
        ctx.stroke();
      }
      ctx.fillStyle = col.get(c);
      ctx.beginPath();
      ctx.arc(s.x * cs, s.y * cs, Math.max(1.5, cs * (i === last && showProbes ? 0.3 : 0.16)), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.lineWidth = 1;
    // Rails.
    for (const r of this.rails) {
      ctx.strokeStyle = col.get(r.kind === 'full' ? '--accent' : '--walker');
      ctx.lineWidth = Math.max(3, cs * 0.35);
      ctx.lineCap = 'round';
      ctx.beginPath();
      r.samples.forEach((s, i) => (i ? ctx.lineTo(s.x * cs, s.y * cs) : ctx.moveTo(s.x * cs, s.y * cs)));
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
    ctx.lineWidth = 1;
    // Peek points: an arrow from the end of the rail to where the unit can lean out.
    for (const p of this.peeks) {
      ctx.strokeStyle = col.get('--good');
      ctx.fillStyle = col.get('--good');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.fromX * cs, p.fromY * cs);
      ctx.lineTo(p.x * cs, p.y * cs);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x * cs, p.y * cs, Math.max(2.5, cs * 0.3), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.lineWidth = 1;
  }

  caption(): Caption {
    const c = this.counts;
    switch (this.phase) {
      case 'start':
      case 'seg':
        return {
          title: '1. Trace the outline.',
          text: `Find every edge where walkable ground meets a low wall or building, and chain the edges end to end into outlines, keeping the walkable side on the left (the outline just traced is highlighted). Recast does the same to its walkable spans before building polygons (its "contours"). ${this.segs.length} of ${c.segs} edges, ${c.chains} outlines in all.`,
        };
      case 'simplify':
        return {
          title: '2. Simplify.',
          text: `Grid outlines are staircases. Douglas-Peucker keeps only the vertices that matter (any point more than ${this.tol} m from the simplified line is kept), turning staircases into straight walls: ${c.segs} edges become ${c.verts} vertices. Recast simplifies its contours the same way, with its own error tolerance.`,
        };
      case 'sample':
        return {
          title: '3. Walk the edges and probe.',
          text: `Every ${this.spacing} m along each simplified edge, stand half a metre out on the walkable side and cast a short probe back towards the wall, at crouch and at standing height. Hit at standing height: full cover (blue). Only at crouch height: low cover (yellow). Missed: no cover here (red), where simplification cut a corner so the probe falls short of the wall.`,
        };
      case 'rail':
        return {
          title: '4. Merge into rails.',
          text: `Consecutive samples of the same kind join into a rail: a line a unit can move along while staying in cover. A rail is split where the outline turns a convex corner (the wall turns away from you), because the cover ends there: those ends become peek points in the next step. ${this.rails.length} of ${c.rails} rails.`,
        };
      default:
        return {
          title: '5. Peek points.',
          text: `Step a little past each end of each rail. If the cover has ended there and the spot is walkable, a unit at the end of the rail can lean or step out to attack: a peek point (green). These, not the middle of a rail, are where attack positions are. ${this.peeks.length} peek points.`,
        };
    }
  }

  stats(): Stat[] {
    const found = new Set<number>();
    for (const s of this.samples)
      if (s.kind !== 'none') {
        const i = Math.floor(s.y) * this.t.w + Math.floor(s.x);
        if (this.truth.has(i)) found.add(i);
      }
    return [
      [String(this.segs.length), 'outline edges'],
      [String([...this.polys.values()].reduce((a, p) => a + p.length, 0)), 'vertices after simplifying'],
      [String(this.samples.length), 'probes cast'],
      [`${this.rails.length} / ${this.peeks.length}`, 'rails / peek points'],
      [percent(found.size, this.truth.size), 'of cover cells sampled'],
    ];
  }
}

// ===========================================================================
// Sampling

type SampleEvent = { x: number; y: number; hits: number[] };

export function samplePoints(t: TWorld, algo: 'random' | 'poisson' | 'biased', budget: number, seed: number): Array<[number, number]> {
  const rng = makeRng(seed);
  const out: Array<[number, number]> = [];
  if (algo === 'random') {
    for (let k = 0; k < budget; k++) out.push([Math.floor(rng() * t.w), Math.floor(rng() * t.h)]);
  } else if (algo === 'poisson') {
    const r = Math.sqrt((t.w * t.h) / (budget * 1.5));
    const cell = r / Math.SQRT2;
    const gw = Math.ceil(t.w / cell);
    const gh = Math.ceil(t.h / cell);
    const grid = new Int32Array(gw * gh).fill(-1);
    const pts: Array<[number, number]> = [];
    const active: number[] = [];
    const add = (x: number, y: number) => {
      pts.push([x, y]);
      active.push(pts.length - 1);
      grid[Math.floor(y / cell) * gw + Math.floor(x / cell)] = pts.length - 1;
    };
    add(rng() * t.w, rng() * t.h);
    while (active.length && pts.length < budget) {
      const ai = Math.floor(rng() * active.length);
      const [px, py] = pts[active[ai]];
      let placed = false;
      for (let k = 0; k < 20 && !placed; k++) {
        const a = rng() * Math.PI * 2;
        const d = r * (1 + rng());
        const x = px + Math.cos(a) * d;
        const y = py + Math.sin(a) * d;
        if (x < 0 || y < 0 || x >= t.w || y >= t.h) continue;
        const gx = Math.floor(x / cell);
        const gy = Math.floor(y / cell);
        let ok = true;
        for (let yy = Math.max(0, gy - 2); yy <= Math.min(gh - 1, gy + 2) && ok; yy++)
          for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) {
            const q = grid[yy * gw + xx];
            if (q >= 0 && Math.hypot(pts[q][0] - x, pts[q][1] - y) < r) {
              ok = false;
              break;
            }
          }
        if (ok) {
          add(x, y);
          placed = true;
        }
      }
      if (!placed) active.splice(ai, 1);
    }
    for (const [x, y] of pts) out.push([Math.floor(x), Math.floor(y)]);
  } else {
    const edges: number[] = [];
    for (let i = 0; i < t.w * t.h; i++) {
      const k = t.kind[i];
      if (k !== LOW && k !== BUILDING) continue;
      const x = i % t.w;
      const y = (i - x) / t.w;
      const n4: Array<[number, number]> = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
      if (n4.some(([dx, dy]) => inside(t, x + dx, y + dy) && KINDS[t.kind[(y + dy) * t.w + x + dx]].walk)) edges.push(i);
    }
    for (let k = 0; k < budget && edges.length; k++) {
      const e = edges[Math.floor(rng() * edges.length)];
      out.push([e % t.w, Math.floor(e / t.w)]);
    }
  }
  return out;
}

export class SampleTrace extends EventTrace<SampleEvent> {
  private found = new Set<number>();
  private pts: SampleEvent[] = [];
  private truth: Map<number, CoverCell>;
  private probes = 0;
  constructor(
    private t: TWorld,
    private col: Colours,
    private algo: 'random' | 'poisson' | 'biased',
    budget: number,
    seed = 11,
  ) {
    super();
    this.truth = coverTruth(t);
    for (const [x, y] of samplePoints(t, algo, budget, seed)) {
      const hits: number[] = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const i = (y + dy) * t.w + x + dx;
          if (inside(t, x + dx, y + dy) && this.truth.has(i)) hits.push(i);
        }
      this.events.push({ x, y, hits });
    }
    this.marks = [this.events.length - 1];
  }
  protected reset(): void {
    this.found.clear();
    this.pts = [];
    this.probes = 0;
  }
  protected apply(e: SampleEvent): void {
    this.pts.push(e);
    this.probes += 9;
    for (const i of e.hits) this.found.add(i);
  }
  draw(ctx: CanvasRenderingContext2D, cs: number): void {
    const t = this.t;
    const done = this.at >= this.events.length - 1;
    if (done) drawMissed(ctx, t, cs, this.truth, this.found, this.col);
    for (const i of this.found) {
      const c = this.truth.get(i)!;
      drawCoverCell(ctx, t, cs, c, this.col.get(c.full ? '--accent' : '--walker'));
    }
    ctx.fillStyle = this.col.rgba('--ink', 0.75);
    this.pts.forEach((p, k) => {
      const last = k === this.pts.length - 1 && !done;
      if (last) {
        ctx.strokeStyle = this.col.get('--ink');
        ctx.lineWidth = 2;
        ctx.strokeRect((p.x - 1) * cs, (p.y - 1) * cs, 3 * cs, 3 * cs);
        ctx.lineWidth = 1;
      }
      ctx.beginPath();
      ctx.arc((p.x + 0.5) * cs, (p.y + 0.5) * cs, Math.max(1.2, cs * (last ? 0.3 : 0.15)), 0, Math.PI * 2);
      ctx.fill();
    });
  }
  caption(): Caption {
    const n = this.pts.length;
    const done = this.at >= this.events.length - 1;
    const what = {
      random: 'Drop points uniformly at random. Each one probes the 3 × 3 cells around it (the box) for cover, as a unit standing there would feel for a wall. Random points clump by chance and leave holes.',
      poisson: 'Poisson-disk sampling (Bridson\'s algorithm): each new point is placed in a ring around an existing one and kept only if no other point is closer than a minimum distance. The result covers the map evenly, with no clumps and no big holes.',
      biased: 'Edge-biased sampling: instead of anywhere, drop points on obstacle cells that border walkable ground, which is where cover can actually be. Almost every sample lands next to something solid.',
    }[this.algo];
    if (!done) return { title: `Sample ${n}.`, text: what };
    let thin = 0;
    let thinFound = 0;
    for (const i of this.truth.keys())
      if (this.t.thin[i]) {
        thin++;
        if (this.found.has(i)) thinFound++;
      }
    return {
      title: 'Done.',
      text: `${n} samples, ${this.probes.toLocaleString()} cells probed, ${percent(this.found.size, this.truth.size)} of the cover found. Faint red is cover that no sample got close to.${thin ? ` In the thin gaps: ${thinFound} of ${thin} positions found.` : ''} Compare with the edge scan, which checks every cell once and misses nothing.`,
    };
  }
  stats(): Stat[] {
    let thin = 0;
    let thinFound = 0;
    for (const i of this.truth.keys())
      if (this.t.thin[i]) {
        thin++;
        if (this.found.has(i)) thinFound++;
      }
    const s: Stat[] = [
      [String(this.pts.length), 'samples'],
      [this.probes.toLocaleString(), 'cells probed'],
      [String(this.found.size), 'cover positions found'],
      [percent(this.found.size, this.truth.size), 'of all cover'],
    ];
    if (thin) s.push([`${thinFound} / ${thin}`, 'thin-gap positions', thinFound > thin * 0.7 ? 'found' : 'bad']);
    return s;
  }
}
