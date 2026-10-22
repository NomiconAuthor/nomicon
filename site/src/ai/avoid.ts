/**
 * Local avoidance between agents: no avoidance, a separation force, Helbing's social
 * forces, sampled velocity obstacles (plain and reciprocal), and ORCA (the half-plane
 * method behind the RVO2 library). Pure simulation; the widget lives in steer.ts and
 * test/avoid-batch.ts measures it.
 */
import { type V, add, cross, dot, len, mul, norm, rng, sub, trunc, v, angleOf, wrapAngle } from './vec';

export const AV_SIZE = 640;
export type AvoidMethod = 'none' | 'separation' | 'social' | 'vo' | 'rvo' | 'orca';
export type AvoidScene = 'circle' | 'groups' | 'cross';

export interface AvAgent {
  p: V;
  vel: V;
  goal: V;
  r: number;
  done: boolean;
  dist: number; // distance travelled
  straight: number; // straight-line distance start to goal
  hue: number;
}

export interface AvoidStats {
  time: number;
  allDoneAt: number;
  overlap: number; // sum over pairs of penetration depth × time, px·s
  turn: number; // sum over agents of |heading change|, radians
  agentTime: number;
  ended: boolean;
}

const MAX_SPEED = 90;
const R = 9;
const NEIGHBOUR_DIST = 120;
const MAX_NEIGHBOURS = 10;
const HORIZON = 1.5; // seconds ahead that velocity obstacles look
export const AV_LIMIT = 40;

interface Line {
  point: V;
  dir: V;
}
const det = cross;

// --- ORCA's linear programs, after RVO2 (van den Berg, Guy, Snape, Lin, Manocha) ---------

function lp1(lines: Line[], no: number, radius: number, opt: V, dirOpt: boolean): V | null {
  const L = lines[no];
  const dp = dot(L.point, L.dir);
  const disc = dp * dp + radius * radius - dot(L.point, L.point);
  if (disc < 0) return null; // max speed circle fully invalidates this line
  const sq = Math.sqrt(disc);
  let tL = -dp - sq;
  let tR = -dp + sq;
  for (let i = 0; i < no; i++) {
    const den = det(L.dir, lines[i].dir);
    const num = det(lines[i].dir, sub(L.point, lines[i].point));
    if (Math.abs(den) <= 1e-6) {
      if (num < 0) return null;
      continue;
    }
    const t = num / den;
    if (den >= 0) tR = Math.min(tR, t);
    else tL = Math.max(tL, t);
    if (tL > tR) return null;
  }
  if (dirOpt) return add(L.point, mul(L.dir, dot(opt, L.dir) > 0 ? tR : tL));
  const t = Math.max(tL, Math.min(tR, dot(L.dir, sub(opt, L.point))));
  return add(L.point, mul(L.dir, t));
}

function lp2(lines: Line[], radius: number, opt: V, dirOpt: boolean, out: { v: V }): number {
  if (dirOpt) out.v = mul(opt, radius);
  else if (dot(opt, opt) > radius * radius) out.v = mul(norm(opt), radius);
  else out.v = opt;
  for (let i = 0; i < lines.length; i++) {
    if (det(lines[i].dir, sub(lines[i].point, out.v)) > 0) {
      const r = lp1(lines, i, radius, opt, dirOpt);
      if (!r) return i;
      out.v = r;
    }
  }
  return lines.length;
}

function lp3(lines: Line[], begin: number, radius: number, out: { v: V }): void {
  let distance = 0;
  for (let i = begin; i < lines.length; i++) {
    if (det(lines[i].dir, sub(lines[i].point, out.v)) <= distance) continue;
    const proj: Line[] = [];
    for (let j = 0; j < i; j++) {
      const d = det(lines[i].dir, lines[j].dir);
      let point: V;
      if (Math.abs(d) <= 1e-6) {
        if (dot(lines[i].dir, lines[j].dir) > 0) continue;
        point = mul(add(lines[i].point, lines[j].point), 0.5);
      } else point = add(lines[i].point, mul(lines[i].dir, det(lines[j].dir, sub(lines[i].point, lines[j].point)) / d));
      proj.push({ point, dir: norm(sub(lines[j].dir, lines[i].dir)) });
    }
    const keep = out.v;
    if (lp2(proj, radius, v(-lines[i].dir.y, lines[i].dir.x), true, out) < proj.length) out.v = keep;
    distance = det(lines[i].dir, sub(lines[i].point, out.v));
  }
}

// -------------------------------------------------------------------------------------------

export class AvoidSim {
  agents: AvAgent[] = [];
  stats: AvoidStats = { time: 0, allDoneAt: -1, overlap: 0, turn: 0, agentTime: 0, ended: false };
  /** For drawing: the ORCA half-planes or sampled candidates of agent 0 on the last step. */
  debug: { lines: Line[]; cands: Array<{ v: V; cost: number }>; chosen: V | null } = { lines: [], cands: [], chosen: null };
  private r: () => number;

  constructor(
    public method: AvoidMethod,
    public scene: AvoidScene,
    public count: number,
    seed = 7,
  ) {
    this.r = rng(seed);
    const C = AV_SIZE / 2;
    const mk = (p: V, goal: V, hue: number): AvAgent => ({ p, vel: v(), goal, r: R, done: false, dist: 0, straight: len(sub(goal, p)), hue });
    if (scene === 'circle') {
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const p = v(C + Math.cos(a) * 280, C + Math.sin(a) * 280);
        this.agents.push(mk(p, v(C - Math.cos(a) * 280, C - Math.sin(a) * 280), i));
      }
    } else {
      // Two blocks of half the agents each, in loose grids.
      const half = Math.floor(count / 2);
      const cols = Math.ceil(Math.sqrt(half));
      for (let g = 0; g < 2; g++)
        for (let i = 0; i < half; i++) {
          const row = Math.floor(i / cols);
          const col = i % cols;
          const off = v((col - (cols - 1) / 2) * 26, (row - (Math.ceil(half / cols) - 1) / 2) * 26);
          if (scene === 'groups') {
            const sx = g === 0 ? 90 : AV_SIZE - 90;
            const p = v(sx + (g === 0 ? -off.y : off.y), C + off.x);
            this.agents.push(mk(p, v(AV_SIZE - p.x, p.y), g));
          } else {
            const p = g === 0 ? v(90 - off.y, C + off.x) : v(C + off.x, 90 - off.y);
            const goal = g === 0 ? v(AV_SIZE - 90 - off.y, p.y) : v(p.x, AV_SIZE - 90 - off.y);
            this.agents.push(mk(p, goal, g));
          }
        }
    }
  }

  private pref(a: AvAgent): V {
    const d = sub(a.goal, a.p);
    const l = len(d);
    if (l < 1) return v();
    const want = mul(d, Math.min(MAX_SPEED, l * 2) / l);
    // A tiny random nudge breaks perfect symmetry, as RVO2's examples do.
    const ang = (this.r() - 0.5) * 0.04;
    return v(want.x * Math.cos(ang) - want.y * Math.sin(ang), want.x * Math.sin(ang) + want.y * Math.cos(ang));
  }

  private neighbours(a: AvAgent): AvAgent[] {
    // Agents that have arrived have left the scene.
    return this.agents
      .filter((o) => o !== a && !o.done && len(sub(o.p, a.p)) < NEIGHBOUR_DIST)
      .sort((x, y) => len(sub(x.p, a.p)) - len(sub(y.p, a.p)))
      .slice(0, MAX_NEIGHBOURS);
  }

  /** Earliest time the relative motion `rv` brings two discs (offset `p`, radii sum `rs`) into contact. */
  private static ttc(p: V, rv: V, rs: number): number {
    const A = dot(rv, rv);
    const B = dot(p, rv);
    const C = dot(p, p) - rs * rs;
    if (C < 0) return 0;
    if (A < 1e-9) return Infinity;
    const disc = B * B - A * C;
    if (disc < 0 || B < 0) return Infinity;
    const t = (B - Math.sqrt(disc)) / A;
    return t >= 0 ? t : Infinity;
  }

  private sampled(a: AvAgent, pref: V, reciprocal: boolean, nb: AvAgent[], record: boolean): V {
    const cands: V[] = [pref, v()];
    for (let k = 0; k < 16; k++)
      for (const s of [0.35, 0.7, 1]) {
        const ang = (k / 16) * Math.PI * 2;
        cands.push(v(Math.cos(ang) * MAX_SPEED * s, Math.sin(ang) * MAX_SPEED * s));
      }
    let best = pref;
    let bestCost = Infinity;
    if (record) this.debug.cands = [];
    for (const c of cands) {
      let tc = Infinity;
      for (const o of nb) {
        // Plain VO: assume the other keeps its velocity. Reciprocal: assume it does half the avoiding.
        const rv = reciprocal ? sub(sub(mul(c, 2), a.vel), o.vel) : sub(c, o.vel);
        tc = Math.min(tc, AvoidSim.ttc(sub(o.p, a.p), rv, a.r + o.r));
        if (tc === 0) break;
      }
      const cost = (1.2 / Math.max(tc, 1e-3)) * 60 + len(sub(c, pref));
      if (record) this.debug.cands.push({ v: c, cost });
      if (cost < bestCost) ((bestCost = cost), (best = c));
    }
    return best;
  }

  private orca(a: AvAgent, pref: V, nb: AvAgent[], dt: number, record: boolean): V {
    const lines: Line[] = [];
    const invT = 1 / HORIZON;
    for (const o of nb) {
      const relPos = sub(o.p, a.p);
      const relVel = sub(a.vel, o.vel);
      const distSq = dot(relPos, relPos);
      const rs = a.r + o.r;
      let dir: V;
      let u: V;
      if (distSq > rs * rs) {
        const w = sub(relVel, mul(relPos, invT));
        const wLenSq = dot(w, w);
        const dp1 = dot(w, relPos);
        if (dp1 < 0 && dp1 * dp1 > rs * rs * wLenSq) {
          // Closest to the cut-off circle.
          const wLen = Math.sqrt(wLenSq);
          const unitW = mul(w, 1 / wLen);
          dir = v(unitW.y, -unitW.x);
          u = mul(unitW, rs * invT - wLen);
        } else {
          // Closest to one of the cone's legs.
          const leg = Math.sqrt(distSq - rs * rs);
          if (det(relPos, w) > 0) dir = mul(v(relPos.x * leg - relPos.y * rs, relPos.x * rs + relPos.y * leg), 1 / distSq);
          else dir = mul(v(relPos.x * leg + relPos.y * rs, -relPos.x * rs + relPos.y * leg), -1 / distSq);
          u = sub(mul(dir, dot(relVel, dir)), relVel);
        }
      } else {
        // Already overlapping: get out within one step.
        const invDt = 1 / dt;
        const w = sub(relVel, mul(relPos, invDt));
        const wLen = len(w);
        const unitW = mul(w, 1 / Math.max(wLen, 1e-9));
        dir = v(unitW.y, -unitW.x);
        u = mul(unitW, rs * invDt - wLen);
      }
      // Reciprocity: this agent takes half of the change.
      lines.push({ point: add(a.vel, mul(u, 0.5)), dir });
    }
    const out = { v: v() };
    const fail = lp2(lines, MAX_SPEED, pref, false, out);
    if (fail < lines.length) lp3(lines, fail, MAX_SPEED, out);
    if (record) this.debug.lines = lines;
    return out.v;
  }

  step(dt = 1 / 60): void {
    const st = this.stats;
    if (st.ended) return;
    st.time += dt;
    const next: V[] = [];
    this.agents.forEach((a, i) => {
      if (a.done) {
        next.push(v());
        return;
      }
      const record = i === 0;
      const pref = this.pref(a);
      const nb = this.neighbours(a);
      let nv: V;
      switch (this.method) {
        case 'none':
          nv = add(a.vel, trunc(mul(sub(pref, a.vel), 4 * dt), 300 * dt));
          break;
        case 'separation': {
          let f = mul(sub(pref, a.vel), 4);
          let sep = v();
          for (const o of nb) {
            const d = sub(a.p, o.p);
            const l = len(d);
            if (l > 0 && l < 30) sep = add(sep, mul(d, 1 / (l * l)));
          }
          if (len(sep) > 0) f = add(f, mul(sub(mul(norm(sep), MAX_SPEED), a.vel), 3));
          nv = add(a.vel, mul(trunc(f, 300), dt));
          break;
        }
        case 'social': {
          // Helbing & Molnár: relax towards the preferred velocity, pushed by exponential repulsion.
          let f = mul(sub(pref, a.vel), 1 / 0.5);
          for (const o of nb) {
            const d = sub(a.p, o.p);
            const l = len(d);
            if (l < 1e-6) continue;
            const n = mul(d, 1 / l);
            let mag = 260 * Math.exp((a.r + o.r - l) / 7);
            // Look ahead a little: agents ahead (in the direction we're going) push harder.
            const ahead = dot(norm(a.vel), mul(n, -1));
            mag *= 0.5 + 0.5 * Math.max(0, ahead);
            f = add(f, mul(n, mag));
          }
          nv = add(a.vel, mul(trunc(f, 600), dt));
          break;
        }
        case 'vo':
        case 'rvo': {
          const best = this.sampled(a, pref, this.method === 'rvo', nb, record);
          nv = add(a.vel, mul(trunc(mul(sub(best, a.vel), 8), 600), dt));
          if (record) this.debug.chosen = best;
          break;
        }
        case 'orca':
          nv = this.orca(a, pref, nb, dt, record);
          if (record) this.debug.chosen = nv;
          break;
      }
      next.push(trunc(nv, MAX_SPEED));
    });
    this.agents.forEach((a, i) => {
      const before = len(a.vel) > 5 ? angleOf(a.vel) : null;
      a.vel = next[i];
      const step = mul(a.vel, dt);
      a.p = add(a.p, step);
      a.dist += len(step);
      if (before !== null && len(a.vel) > 5) st.turn += Math.abs(wrapAngle(angleOf(a.vel) - before));
      if (!a.done) st.agentTime += dt;
      if (!a.done && len(sub(a.goal, a.p)) < 6) a.done = true;
    });
    for (let i = 0; i < this.agents.length; i++)
      for (let j = i + 1; j < this.agents.length; j++) {
        const A = this.agents[i];
        const B = this.agents[j];
        if (A.done || B.done) continue;
        const pen = A.r + B.r - len(sub(A.p, B.p));
        if (pen > 0) st.overlap += pen * dt;
      }
    if (this.agents.every((a) => a.done)) {
      st.allDoneAt = st.time;
      st.ended = true;
    } else if (st.time >= AV_LIMIT) st.ended = true;
  }

  run(): AvoidStats {
    while (!this.stats.ended) this.step();
    return this.stats;
  }

  /** Average over arrived agents of distance travelled over straight-line distance (1 = perfectly direct). */
  detour(): number {
    // Only agents that got there: a stuck agent's ratio means nothing.
    const done = this.agents.filter((a) => a.done);
    let s = 0;
    for (const a of done) s += a.dist / Math.max(1, a.straight);
    return done.length ? s / done.length : 1;
  }
}
