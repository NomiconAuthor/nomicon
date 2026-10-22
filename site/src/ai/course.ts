/**
 * The steering course: six agents follow a path through walls, using one of several
 * motion models, path followers and ways of noticing walls (rays, whiskers, context
 * steering, or querying wall geometry directly). Pure simulation, no DOM, so the
 * lesson's numbers can be measured headlessly (test/steer-batch.ts).
 */
import { type V, add, angleOf, dot, fromAngle, len, mul, norm, sub, trunc, v, wrapAngle } from './vec';

export const COURSE_W = 900;
export const COURSE_H = 480;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/** A wall face, with its normal pointing out into free space. */
export interface Face {
  a: V;
  b: V;
  n: V;
}
export interface Crate {
  base: V;
  amp: number;
  speed: number;
  phase: number;
  p: V;
  r: number;
}
export interface Course {
  id: string;
  name: string;
  rects: Rect[];
  /** The planner's path: string-pulled, with corners kept an agent's radius (plus a margin) from the walls. */
  path: V[];
  crates: Array<[number, number, number, number]>; // x, y, vertical amplitude, speed
}

const BORDER: Rect[] = [
  { x0: 0, y0: 0, x1: COURSE_W, y1: 16 },
  { x0: 0, y0: COURSE_H - 16, x1: COURSE_W, y1: COURSE_H },
  { x0: 0, y0: 0, x1: 16, y1: COURSE_H },
  { x0: COURSE_W - 16, y0: 0, x1: COURSE_W, y1: COURSE_H },
];
const sq = (x: number, y: number, s = 30): Rect => ({ x0: x - s / 2, y0: y - s / 2, x1: x + s / 2, y1: y + s / 2 });

export const COURSES: Course[] = [
  {
    id: 'bends',
    name: 'Corridor with bends',
    rects: [...BORDER, { x0: 220, y0: 16, x1: 260, y1: 340 }, { x0: 440, y0: 140, x1: 480, y1: 464 }, { x0: 660, y0: 16, x1: 700, y1: 340 }],
    path: [v(100, 240), v(213, 357), v(267, 357), v(433, 123), v(487, 123), v(653, 357), v(707, 357), v(810, 120)],
    crates: [
      [350, 240, 110, 0.9],
      [570, 250, 110, 1.1],
      [790, 300, 120, 0.8],
    ],
  },
  {
    id: 'pillars',
    name: 'Pillars',
    rects: [...BORDER, sq(300, 150), sq(300, 330), sq(450, 240, 36), sq(600, 120), sq(600, 360), sq(700, 250), sq(200, 250, 24)],
    path: [v(100, 240), v(820, 240)],
    crates: [
      [380, 240, 150, 0.9],
      [530, 240, 150, 1.2],
      [770, 240, 150, 0.7],
    ],
  },
  {
    id: 'deadend',
    name: 'Dead end',
    rects: [...BORDER, { x0: 520, y0: 120, x1: 540, y1: 360 }, { x0: 380, y0: 120, x1: 540, y1: 140 }, { x0: 380, y0: 340, x1: 540, y1: 360 }],
    path: [v(100, 240), v(373, 103), v(547, 103), v(800, 240)],
    crates: [
      [250, 240, 120, 1.0],
      [680, 240, 140, 0.8],
      [460, 60, 30, 1.3],
    ],
  },
];

export type Motion = 'point' | 'spot' | 'car';
export type Follow = 'waypoint' | 'carrot' | 'goal';
export type Sense = 'none' | 'feeler' | 'whiskers' | 'context' | 'query';

export interface CourseSettings {
  course: string;
  motion: Motion;
  follow: Follow;
  sense: Sense;
  /** Directions in the context ring. */
  slots: number;
  /** Each agent casts every `every` ticks, staggered so agents take turns. */
  every: number;
  hysteresis: boolean;
  crates: boolean;
}
export const DEFAULT_SETTINGS: CourseSettings = {
  course: 'bends',
  motion: 'point',
  follow: 'carrot',
  sense: 'context',
  slots: 16,
  every: 1,
  hysteresis: true,
  crates: false,
};

export interface Hit {
  dir: V; // world direction the ray was cast in
  d: number; // distance to the hit (or the ray length if nothing was hit)
  len: number; // ray length
  point: V | null; // world point hit
  n: V | null; // surface normal at the hit
  fresh: boolean; // cast this tick
}

export interface Agent {
  id: number;
  p: V;
  vel: V;
  heading: number;
  speed: number;
  wp: number;
  s: number; // progress along the path (carrot follower)
  seg: number;
  done: boolean;
  doneAt: number;
  hits: Hit[];
  chosen: V | null;
  interest: number[];
  danger: number[];
  pick: number;
  target: V;
  trail: V[];
}

export const AGENT_R = 9;
export const MAX_SPEED = 110;
const MAX_FORCE = 480;
const SPOT_TURN = 5; // rad/s
const CAR_RADIUS = 45; // minimum turning radius, px
const CONTEXT_RANGE = 90;
const QUERY_RANGE = 45;
const CARROT = 70;
export const TIME_LIMIT = 45;
export const TICK = 1 / 60;

function faces(rects: Rect[]): Face[] {
  const out: Face[] = [];
  for (const r of rects) {
    const a = v(r.x0, r.y0);
    const b = v(r.x1, r.y0);
    const c = v(r.x1, r.y1);
    const d = v(r.x0, r.y1);
    out.push({ a, b, n: v(0, -1) }, { a: b, b: c, n: v(1, 0) }, { a: c, b: d, n: v(0, 1) }, { a: d, b: a, n: v(-1, 0) });
  }
  return out;
}

/** Ray against a segment: distance along the ray, or Infinity. */
function raySeg(o: V, d: V, a: V, b: V): number {
  const e = sub(b, a);
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-9) return Infinity;
  const w = sub(a, o);
  const t = (w.x * e.y - w.y * e.x) / den;
  const u = (w.x * d.y - w.y * d.x) / den;
  return t >= 0 && u >= 0 && u <= 1 ? t : Infinity;
}
function rayCircle(o: V, d: V, c: V, r: number): number {
  const m = sub(o, c);
  const b = dot(m, d);
  const cc = dot(m, m) - r * r;
  if (cc > 0 && b > 0) return Infinity;
  const disc = b * b - cc;
  if (disc < 0) return Infinity;
  return Math.max(0, -b - Math.sqrt(disc));
}
function closestOnSeg(p: V, a: V, b: V): V {
  const e = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), e) / Math.max(1e-9, dot(e, e))));
  return add(a, mul(e, t));
}

export interface CourseStats {
  time: number;
  through: number;
  allThroughAt: number; // -1 until everyone is through
  contact: number; // agent-seconds touching a wall or crate
  agentTime: number; // agent-seconds simulated (for agents not yet through)
  rays: number;
  turn: number; // sum of |heading change| over agents, radians
  ended: boolean;
}

export class CourseSim {
  readonly course: Course;
  readonly faces: Face[];
  crates: Crate[] = [];
  agents: Agent[] = [];
  stats: CourseStats = { time: 0, through: 0, allThroughAt: -1, contact: 0, agentTime: 0, rays: 0, turn: 0, ended: false };
  private tick = 0;
  private pathLen: number[] = [0];

  constructor(public s: CourseSettings) {
    this.course = COURSES.find((c) => c.id === s.course) ?? COURSES[0];
    this.faces = faces(this.course.rects);
    const P = this.course.path;
    for (let i = 1; i < P.length; i++) this.pathLen.push(this.pathLen[i - 1] + len(sub(P[i], P[i - 1])));
    if (s.crates) this.crates = this.course.crates.map(([x, y, amp, speed], i) => ({ base: v(x, y), amp, speed, phase: i * 1.7, p: v(x, y), r: 16 }));
    const start = P[0];
    const offs = [v(0, -30), v(0, 0), v(0, 30), v(-32, -15), v(-32, 15), v(-32, 45)];
    const h0 = angleOf(sub(P[1], P[0]));
    this.agents = offs.map((o, id) => ({
      id,
      p: add(start, o),
      vel: v(),
      heading: h0,
      speed: 0,
      wp: 1,
      s: 0,
      seg: 0,
      done: false,
      doneAt: -1,
      hits: [],
      chosen: null,
      interest: [],
      danger: [],
      pick: -1,
      target: P[1],
      trail: [],
    }));
  }

  get goal(): V {
    const P = this.course.path;
    return P[P.length - 1];
  }

  /** Nearest hit along a ray, against walls and crates. */
  cast(o: V, d: V, maxLen: number): Hit {
    let best = maxLen;
    let n: V | null = null;
    for (const f of this.faces) {
      if (dot(d, f.n) >= 0) continue; // back-facing
      const t = raySeg(o, d, f.a, f.b);
      if (t < best) ((best = t), (n = f.n));
    }
    for (const c of this.crates) {
      const t = rayCircle(o, d, c.p, c.r);
      if (t < best) ((best = t), (n = norm(sub(add(o, mul(d, t)), c.p))));
    }
    return { dir: d, d: best, len: maxLen, point: n ? add(o, mul(d, best)) : null, n, fresh: true };
  }

  private pointAt(s: number): V {
    const P = this.course.path;
    const L = this.pathLen;
    if (s >= L[L.length - 1]) return P[P.length - 1];
    let i = 1;
    while (L[i] < s) i++;
    const t = (s - L[i - 1]) / Math.max(1e-9, L[i] - L[i - 1]);
    return add(P[i - 1], mul(sub(P[i], P[i - 1]), t));
  }

  /** Where the path layer wants to go: a desired velocity. */
  private desired(a: Agent): V {
    const P = this.course.path;
    const goal = this.goal;
    let target = goal;
    if (this.s.follow === 'waypoint') {
      while (a.wp < P.length - 1 && len(sub(P[a.wp], a.p)) < 26) a.wp++;
      target = P[a.wp];
    } else if (this.s.follow === 'carrot') {
      // Project onto the path near the current segment; progress never goes backwards.
      let bestD = Infinity;
      let bestS = a.s;
      let bestSeg = a.seg;
      for (let i = a.seg; i < Math.min(P.length - 1, a.seg + 3); i++) {
        const q = closestOnSeg(a.p, P[i], P[i + 1]);
        const d = len(sub(q, a.p));
        if (d < bestD) ((bestD = d), (bestS = this.pathLen[i] + len(sub(q, P[i]))), (bestSeg = i));
      }
      if (bestS >= a.s) ((a.s = bestS), (a.seg = bestSeg));
      target = this.pointAt(a.s + CARROT);
    }
    a.target = target;
    const toGoal = len(sub(goal, a.p));
    const speed = MAX_SPEED * Math.min(1, 0.3 + toGoal / 80);
    return mul(norm(sub(target, a.p)), speed);
  }

  private sense(a: Agent, hd: V): void {
    const s = this.s;
    const casting = (this.tick + a.id) % s.every === 0;
    if (casting) {
      const dirs: Array<[V, number]> = [];
      const fl = 25 + a.speed * 0.9;
      if (s.sense === 'feeler') dirs.push([hd, fl]);
      else if (s.sense === 'whiskers') dirs.push([hd, fl], [fromAngle(angleOf(hd) + 0.6), fl * 0.65], [fromAngle(angleOf(hd) - 0.6), fl * 0.65]);
      else if (s.sense === 'context') for (let k = 0; k < s.slots; k++) dirs.push([fromAngle(angleOf(hd) + (k / s.slots) * Math.PI * 2), CONTEXT_RANGE]);
      a.hits = dirs.map(([d, l]) => this.cast(a.p, d, l));
      this.stats.rays += dirs.length;
    } else {
      for (const hit of a.hits) {
        hit.fresh = false;
        // Hits are remembered as world points, so for static walls they stay right as the
        // agent moves: only the distance and direction need recomputing.
        if (hit.point) {
          const rel = sub(hit.point, a.p);
          hit.d = len(rel);
          hit.dir = norm(rel);
        }
      }
    }
  }

  private avoid(a: Agent, des: V, hd: V): V {
    const s = this.s;
    if (s.sense === 'feeler' || s.sense === 'whiskers') {
      let out = des;
      let slow = 0;
      const side = v(-hd.y, hd.x);
      for (const hit of a.hits) {
        if (!hit.n || hit.d >= hit.len) continue;
        const w = 1 - hit.d / hit.len;
        // Push off the surface, and sideways: a wall hit head-on has a normal straight back
        // at us, which on its own only brakes. Break the tie to the left.
        const lat = dot(hit.n, side);
        const turn = Math.abs(lat) > 0.05 ? Math.sign(lat) : 1;
        out = add(out, mul(add(hit.n, mul(side, turn)), w * MAX_SPEED));
        if (dot(hit.dir, hd) > 0.9) slow = Math.max(slow, w);
      }
      return trunc(out, len(des) * (1 - 0.5 * slow));
    }
    if (s.sense === 'query') {
      // No rays: ask the geometry for nearby wall faces directly.
      let out = des;
      for (const f of this.faces) {
        const q = closestOnSeg(a.p, f.a, f.b);
        const rel = sub(a.p, q);
        const d = len(rel);
        if (d > QUERY_RANGE || dot(rel, f.n) <= 0) continue;
        const w = 1 - Math.max(0, d - AGENT_R) / (QUERY_RANGE - AGENT_R);
        out = add(out, mul(f.n, w * w * MAX_SPEED * 2));
      }
      for (const c of this.crates) {
        const rel = sub(a.p, c.p);
        const d = len(rel) - c.r;
        if (d > QUERY_RANGE) continue;
        const w = 1 - Math.max(0, d - AGENT_R) / (QUERY_RANGE - AGENT_R);
        out = add(out, mul(norm(rel), w * w * MAX_SPEED * 2));
      }
      return trunc(out, len(des));
    }
    if (s.sense === 'context') {
      const N = s.slots;
      const base = angleOf(hd);
      const dirs = Array.from({ length: N }, (_, k) => fromAngle(base + (k / N) * Math.PI * 2));
      const danger = new Array<number>(N).fill(0);
      const slotW = (Math.PI * 2) / N;
      for (const hit of a.hits) {
        if (!hit.point) continue;
        const w = Math.max(0, Math.min(1, 1 - (hit.d - AGENT_R) / (CONTEXT_RANGE - AGENT_R)));
        // The agent has width: any direction that would bring its body within reach of the
        // hit point is dangerous too. That's an angle, not a fixed number of slots.
        const half = Math.asin(Math.min(1, (AGENT_R * 1.6) / Math.max(hit.d, 1)));
        const ha = angleOf(hit.dir);
        for (let k = 0; k < N; k++) {
          const off = Math.abs(wrapAngle(base + k * slotW - ha));
          if (off <= half + slotW / 2) danger[k] = Math.max(danger[k], w * (off <= slotW / 2 ? 1 : 0.7));
        }
      }
      const want = norm(des);
      const interest = dirs.map((d) => Math.max(0, dot(d, want)));
      if (s.hysteresis && a.chosen) for (let k = 0; k < N; k++) interest[k] += 0.3 * Math.max(0, dot(dirs[k], a.chosen));
      // Mask: keep only the least dangerous directions, then take the most interesting.
      const minD = Math.min(...danger);
      let pick = -1;
      for (let k = 0; k < N; k++) if (danger[k] <= minD + 0.15 && (pick < 0 || interest[k] > interest[pick])) pick = k;
      // Interpolate between the picked slot and its neighbours for a smooth heading.
      const l = (pick - 1 + N) % N;
      const r = (pick + 1) % N;
      const il = danger[l] <= minD + 0.15 ? interest[l] : 0;
      const ir = danger[r] <= minD + 0.15 ? interest[r] : 0;
      const den = il - 2 * interest[pick] + ir;
      const off = Math.abs(den) > 1e-6 ? Math.max(-0.5, Math.min(0.5, (0.5 * (il - ir)) / den)) : 0;
      const dir = fromAngle(base + ((pick + off) / N) * Math.PI * 2);
      a.interest = interest;
      a.danger = danger;
      a.pick = pick;
      a.chosen = dir;
      const speed = len(des) * Math.max(0.3, 1 - danger[pick]);
      return mul(dir, speed);
    }
    return des;
  }

  private move(a: Agent, des: V, dt: number): void {
    const m = this.s.motion;
    const before = a.heading;
    if (m === 'point') {
      // Steering = desired − velocity, scaled so it settles in a fraction of a second, capped at the maximum force.
      const f = trunc(mul(sub(des, a.vel), 6), MAX_FORCE);
      a.vel = trunc(add(a.vel, mul(f, dt)), MAX_SPEED);
      a.speed = len(a.vel);
      if (a.speed > 5) a.heading = angleOf(a.vel);
    } else {
      const err = len(des) > 1 ? wrapAngle(angleOf(des) - a.heading) : 0;
      let target: number;
      if (m === 'spot') {
        a.heading += Math.max(-SPOT_TURN * dt, Math.min(SPOT_TURN * dt, err));
        // Slow down to turn: no speed at all when facing away.
        target = len(des) * Math.max(0, Math.cos(err));
      } else {
        // A car turns at most speed / radius, and can't turn standing still.
        const maxRate = Math.max(a.speed, 20) / CAR_RADIUS;
        a.heading += Math.max(-maxRate * dt, Math.min(maxRate * dt, err * 3 * dt));
        target = len(des) * (Math.abs(err) > 1.2 ? 0.45 : 1);
        target = Math.max(20, target);
      }
      a.speed += Math.max(-300 * dt, Math.min(300 * dt, target - a.speed));
      a.vel = fromAngle(a.heading, a.speed);
    }
    this.stats.turn += Math.abs(wrapAngle(a.heading - before));
    a.p = add(a.p, mul(a.vel, dt));
  }

  /** Push the agent out of walls and crates; returns true if it was touching anything. */
  private collide(a: Agent): boolean {
    let touched = false;
    for (const r of this.course.rects) {
      const q = v(Math.max(r.x0, Math.min(r.x1, a.p.x)), Math.max(r.y0, Math.min(r.y1, a.p.y)));
      const rel = sub(a.p, q);
      const d = len(rel);
      if (d >= AGENT_R) continue;
      touched = true;
      if (d > 1e-6) a.p = add(q, mul(rel, AGENT_R / d));
      else {
        // Centre inside the rectangle: leave by the nearest side.
        const m = Math.min(a.p.x - r.x0, r.x1 - a.p.x, a.p.y - r.y0, r.y1 - a.p.y);
        if (m === a.p.x - r.x0) a.p.x = r.x0 - AGENT_R;
        else if (m === r.x1 - a.p.x) a.p.x = r.x1 + AGENT_R;
        else if (m === a.p.y - r.y0) a.p.y = r.y0 - AGENT_R;
        else a.p.y = r.y1 + AGENT_R;
      }
    }
    for (const c of this.crates) {
      const rel = sub(a.p, c.p);
      const d = len(rel);
      if (d >= c.r + AGENT_R) continue;
      touched = true;
      a.p = add(c.p, mul(d > 1e-6 ? rel : v(1, 0), (c.r + AGENT_R) / Math.max(d, 1e-6)));
    }
    return touched;
  }

  step(dt = TICK): void {
    const st = this.stats;
    if (st.ended) return;
    this.tick++;
    st.time += dt;
    for (const c of this.crates) c.p = v(c.base.x, c.base.y + Math.sin(c.phase + st.time * c.speed) * c.amp);
    const live = this.agents.filter((a) => !a.done);
    for (const a of live) {
      const hd = fromAngle(a.heading);
      let des = this.desired(a);
      this.sense(a, hd);
      des = this.avoid(a, des, hd);
      // Light separation between the six, so they don't stack up.
      let sep = v();
      for (const o of live) {
        if (o === a) continue;
        const rel = sub(a.p, o.p);
        const d = len(rel);
        if (d > 0 && d < 26) sep = add(sep, mul(rel, 900 / (d * d)));
      }
      des = trunc(add(des, trunc(sep, MAX_SPEED)), MAX_SPEED);
      this.move(a, des, dt);
      if (this.collide(a)) st.contact += dt;
      st.agentTime += dt;
      if (this.tick % 6 === 0) {
        a.trail.push({ ...a.p });
        if (a.trail.length > 60) a.trail.shift();
      }
      if (len(sub(this.goal, a.p)) < 22) {
        a.done = true;
        a.doneAt = st.time;
        st.through++;
      }
    }
    if (st.through === this.agents.length) {
      st.allThroughAt = st.time;
      st.ended = true;
    } else if (st.time >= TIME_LIMIT) st.ended = true;
  }

  run(): CourseStats {
    while (!this.stats.ended) this.step();
    return this.stats;
  }
}
