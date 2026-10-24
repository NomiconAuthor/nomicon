/**
 * The teaching engine's world: bodies behind generational handles, a broadphase, contacts with
 * persistent manifolds, a sequential-impulse solver in two flavours (classic Baumgarte, and
 * Box2D v3's substepped "soft step"), joints, sleeping islands, three ways of dealing with fast
 * bodies, and scene queries. Small and readable rather than fast; deterministic in any browser
 * (see math.ts).
 */
import { type AABB, type Rot, type Transform, type V, ROT0, add, clamp, cross, crossSV, dot, integrateRot, invXf, len, lenSq, makeRot, overlaps, perp, rotate, scale, sub, v, xf } from './math';
import { type Manifold, type Shape, aabbOf, circleCast, collide, massOf, raycast } from './collide';

export type BodyType = 'static' | 'kinematic' | 'dynamic';
/** index in the low 16 bits, generation above: like Jolt's BodyID and Box2D's b2BodyId. */
export type BodyHandle = number;
export const NULL_BODY: BodyHandle = 0;

export interface BodyDef {
  type?: BodyType;
  shape: Shape;
  position: V;
  angle?: number;
  velocity?: V;
  angularVelocity?: number;
  density?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  fixedRotation?: boolean;
  /** Collision filtering: this body's category bits, and the categories it collides with. */
  category?: number;
  mask?: number;
  /** Fast body: gets swept against static geometry when continuous mode is "sweep". */
  bullet?: boolean;
  /** Free-form tag for scenes and widgets (a colour index, a name). */
  tag?: number;
  awake?: boolean;
}

export interface Body {
  handle: BodyHandle;
  index: number;
  type: BodyType;
  shape: Shape;
  xf: Transform;
  /** Transform at the start of the last step, for render interpolation. */
  prev: Transform;
  v: V;
  w: number;
  mass: number;
  invMass: number;
  invI: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  category: number;
  mask: number;
  bullet: boolean;
  tag: number;
  awake: boolean;
  sleepTime: number;
  /** Island id from the last step (-1: none). */
  island: number;
  aabb: AABB;
  /** Set when a sweep clamped the body this step (for drawing). */
  swept: boolean;
}

export interface ContactPoint {
  id: number;
  localA: V;
  localB: V;
  separation: number;
  /** Anchors relative to each body's centre, in world orientation, fixed for the step. */
  rA: V;
  rB: V;
  normalMass: number;
  tangentMass: number;
  normalImpulse: number;
  tangentImpulse: number;
  maxNormalImpulse: number;
  /** Normal relative velocity before solving, for restitution. */
  relVel: number;
  /** Whether last step's impulse was found for this point (warm started). */
  warm: boolean;
}

export interface Contact {
  a: number;
  b: number;
  key: string;
  normal: V;
  points: ContactPoint[];
  friction: number;
  restitution: number;
  touching: boolean;
}

export type JointKind = 'revolute' | 'distance' | 'mouse';
export interface Joint {
  id: number;
  kind: JointKind;
  a: number;
  b: number;
  localA: V;
  localB: V;
  /** distance: rest length, min and max (rope when min is 0), optional spring. */
  length: number;
  minLength: number;
  maxLength: number;
  hertz: number;
  damping: number;
  /** revolute motor. */
  motorSpeed: number;
  maxMotorTorque: number;
  /** mouse: world target. */
  target: V;
  maxForce: number;
  impulse: V;
  axialImpulse: number;
  upperImpulse: number;
  lowerImpulse: number;
  motorImpulse: number;
  // per-step scratch
  rA: V;
  rB: V;
}

export type SolverKind = 'soft' | 'baumgarte';
export type Continuous = 'none' | 'speculative' | 'sweep';
export type Broadphase = 'brute' | 'sap';

export interface Settings {
  gravity: V;
  solver: SolverKind;
  /** Soft step: substeps per step (Box2D v3 defaults to 4). Baumgarte: always 1. */
  substeps: number;
  /** Velocity iterations per step (Baumgarte) or per substep (soft step: 1 like Box2D v3). */
  iterations: number;
  warmStarting: boolean;
  sleeping: boolean;
  continuous: Continuous;
  broadphase: Broadphase;
  /** Soft contact stiffness (soft step). */
  contactHertz: number;
  contactDampingRatio: number;
  /** Fastest the soft solver pushes overlapping bodies apart, m/s. */
  maxPushout: number;
  /** Baumgarte: fraction of overlap corrected per step, and the overlap allowed before correcting. */
  baumgarte: number;
  slop: number;
  restitutionThreshold: number;
}

export const DEFAULT_SETTINGS: Settings = {
  gravity: v(0, -10),
  solver: 'soft',
  substeps: 4,
  iterations: 1,
  warmStarting: true,
  sleeping: true,
  continuous: 'speculative',
  broadphase: 'sap',
  contactHertz: 30,
  contactDampingRatio: 10,
  maxPushout: 3,
  baumgarte: 0.2,
  slop: 0.005,
  restitutionThreshold: 1,
};

export interface StepStats {
  bodies: number;
  awake: number;
  /** Broadphase AABB tests, pairs whose AABBs overlap, and pairs that made a manifold. */
  aabbTests: number;
  pairs: number;
  contacts: number;
  points: number;
  /** Manifold points whose impulse came from last step (warm started). */
  warmPoints: number;
  islands: number;
  sleeping: number;
  /** Bodies a sweep moved back to their time of impact. */
  swept: number;
  joints: number;
}

export interface ContactEvent {
  a: BodyHandle;
  b: BodyHandle;
}

const SLEEP_LINEAR = 0.05;
const SLEEP_ANGULAR = 0.035;
const TIME_TO_SLEEP = 0.5;
const CONTACT_MARGIN = 0.01;

/** Box2D v3's soft constraint coefficients for a spring of the given stiffness and damping, over step h. */
function soft(hertz: number, zeta: number, h: number): { biasRate: number; massScale: number; impulseScale: number } {
  if (hertz === 0) return { biasRate: 0, massScale: 1, impulseScale: 0 };
  const omega = 2 * Math.PI * hertz;
  const a1 = 2 * zeta + h * omega;
  const a2 = h * omega * a1;
  const a3 = 1 / (1 + a2);
  return { biasRate: omega / a1, massScale: a2 * a3, impulseScale: a3 };
}

export class World {
  settings: Settings;
  bodies: Array<Body | null> = [];
  private gens: number[] = [];
  private free: number[] = [];
  contacts = new Map<string, Contact>();
  joints: Joint[] = [];
  private nextJoint = 1;
  stats: StepStats = { bodies: 0, awake: 0, aabbTests: 0, pairs: 0, contacts: 0, points: 0, warmPoints: 0, islands: 0, sleeping: 0, swept: 0, joints: 0 };
  /** Contacts that started or stopped touching in the last step. */
  began: ContactEvent[] = [];
  ended: ContactEvent[] = [];
  /** Broadphase sort order, kept between steps (insertion sort is nearly free when little moves). */
  private sapOrder: number[] = [];
  /** Candidate pairs from the last broadphase, for drawing. */
  lastPairs: Array<[number, number]> = [];
  time = 0;
  steps = 0;

  constructor(settings: Partial<Settings> = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  // ----------------------------------------------------------------------------------------
  // Bodies

  createBody(d: BodyDef): BodyHandle {
    const type = d.type ?? 'dynamic';
    let index: number;
    if (this.free.length) index = this.free.pop()!;
    else {
      index = this.bodies.length;
      this.bodies.push(null);
      this.gens.push(0);
    }
    const gen = ++this.gens[index];
    const handle = gen * 65536 + index + 1;
    const q: Rot = d.angle ? makeRot(d.angle) : ROT0;
    const m = type === 'dynamic' ? massOf(d.shape, d.density ?? 1) : { mass: 0, inertia: 0 };
    const t: Transform = { p: { ...d.position }, q };
    const b: Body = {
      handle,
      index,
      type,
      shape: d.shape,
      xf: t,
      prev: { p: { ...t.p }, q: { ...t.q } },
      v: d.velocity ? { ...d.velocity } : v(0, 0),
      w: d.angularVelocity ?? 0,
      mass: m.mass,
      invMass: m.mass > 0 ? 1 / m.mass : 0,
      invI: m.inertia > 0 && !d.fixedRotation ? 1 / m.inertia : 0,
      friction: d.friction ?? 0.6,
      restitution: d.restitution ?? 0,
      linearDamping: d.linearDamping ?? 0,
      angularDamping: d.angularDamping ?? 0,
      category: d.category ?? 1,
      mask: d.mask ?? 0xffff,
      bullet: !!d.bullet,
      tag: d.tag ?? 0,
      awake: type !== 'static' && d.awake !== false,
      sleepTime: 0,
      island: -1,
      aabb: aabbOf(d.shape, t),
      swept: false,
    };
    this.bodies[index] = b;
    return handle;
  }

  /** The body a handle refers to, or null if the handle is stale (destroyed, slot reused). */
  get(h: BodyHandle): Body | null {
    if (h <= 0) return null;
    const index = (h % 65536) - 1;
    const gen = Math.floor(h / 65536);
    const b = this.bodies[index];
    return b && this.gens[index] === gen ? b : null;
  }

  destroyBody(h: BodyHandle): boolean {
    const b = this.get(h);
    if (!b) return false;
    for (const [k, c] of this.contacts) {
      if (c.a === b.index || c.b === b.index) {
        const other = this.bodies[c.a === b.index ? c.b : c.a];
        if (other) this.wake(other);
        if (c.touching) this.ended.push({ a: this.bodies[c.a]!.handle, b: this.bodies[c.b]!.handle });
        this.contacts.delete(k);
      }
    }
    this.joints = this.joints.filter((j) => j.a !== b.index && j.b !== b.index);
    this.bodies[b.index] = null;
    this.free.push(b.index);
    return true;
  }

  live(): Body[] {
    return this.bodies.filter((b): b is Body => !!b);
  }

  wake(b: Body): void {
    if (b.type === 'static') return;
    if (!b.awake) {
      // Wake the whole island it slept with: they were resting on each other.
      const isl = b.island;
      for (const o of this.bodies) {
        if (o && !o.awake && o.type !== 'static' && (o === b || (isl >= 0 && o.island === isl))) {
          o.awake = true;
          o.sleepTime = 0;
        }
      }
    }
    b.sleepTime = 0;
  }

  setVelocity(h: BodyHandle, vel: V, w?: number): void {
    const b = this.get(h);
    if (!b) return;
    b.v = { ...vel };
    if (w !== undefined) b.w = w;
    this.wake(b);
  }

  setTransform(h: BodyHandle, p: V, q?: Rot): void {
    const b = this.get(h);
    if (!b) return;
    b.xf = { p: { ...p }, q: q ?? b.xf.q };
    b.aabb = aabbOf(b.shape, b.xf);
    this.wake(b);
  }

  /** Kinematic bodies: set the velocity that reaches a target transform in one step of dt. */
  moveKinematic(h: BodyHandle, target: V, dt: number): void {
    const b = this.get(h);
    if (!b || b.type !== 'kinematic') return;
    b.v = scale(sub(target, b.xf.p), 1 / dt);
    b.awake = true;
  }

  applyImpulse(h: BodyHandle, impulse: V, point?: V): void {
    const b = this.get(h);
    if (!b || b.type !== 'dynamic') return;
    b.v = add(b.v, scale(impulse, b.invMass));
    if (point) b.w += b.invI * cross(sub(point, b.xf.p), impulse);
    this.wake(b);
  }

  // ----------------------------------------------------------------------------------------
  // Joints

  private joint(kind: JointKind, a: Body, b: Body, wa: V, wb: V, extra: Partial<Joint> = {}): Joint {
    const j: Joint = {
      id: this.nextJoint++,
      kind,
      a: a.index,
      b: b.index,
      localA: invXf(a.xf, wa),
      localB: invXf(b.xf, wb),
      length: len(sub(wb, wa)),
      minLength: 0,
      maxLength: Infinity,
      hertz: 0,
      damping: 0,
      motorSpeed: 0,
      maxMotorTorque: 0,
      target: { ...wb },
      maxForce: 0,
      impulse: v(0, 0),
      axialImpulse: 0,
      upperImpulse: 0,
      lowerImpulse: 0,
      motorImpulse: 0,
      rA: v(0, 0),
      rB: v(0, 0),
      ...extra,
    };
    if (kind === 'distance' && extra.minLength === undefined) j.minLength = j.length;
    if (kind === 'distance' && extra.maxLength === undefined) j.maxLength = j.length;
    this.joints.push(j);
    this.wake(a);
    this.wake(b);
    return j;
  }

  revolute(ha: BodyHandle, hb: BodyHandle, anchor: V, extra: Partial<Joint> = {}): Joint | null {
    const a = this.get(ha);
    const b = this.get(hb);
    return a && b ? this.joint('revolute', a, b, anchor, anchor, extra) : null;
  }

  distance(ha: BodyHandle, hb: BodyHandle, wa: V, wb: V, extra: Partial<Joint> = {}): Joint | null {
    const a = this.get(ha);
    const b = this.get(hb);
    return a && b ? this.joint('distance', a, b, wa, wb, extra) : null;
  }

  /** A soft spring pulling a point on a body towards a target: how widgets let you drag things. */
  mouse(h: BodyHandle, at: V, ground: BodyHandle): Joint | null {
    const b = this.get(h);
    const g = this.get(ground);
    if (!b || !g) return null;
    return this.joint('mouse', g, b, at, at, { hertz: 5, damping: 0.7, maxForce: 1000 * Math.max(b.mass, 0.1), target: { ...at } });
  }

  removeJoint(j: Joint | null): void {
    if (!j) return;
    this.joints = this.joints.filter((x) => x !== j);
    const b = this.bodies[j.b];
    if (b) this.wake(b);
  }

  // ----------------------------------------------------------------------------------------
  // The step

  step(dt: number): void {
    const s = this.settings;
    const st = this.stats;
    this.began = [];
    this.ended = [];
    const live = this.live();
    for (const b of live) {
      b.prev = { p: { ...b.xf.p }, q: { ...b.xf.q } };
      b.swept = false;
    }
    st.bodies = live.length;
    st.swept = 0;
    st.joints = this.joints.length;

    this.updatePairs(live, dt);

    const substeps = s.solver === 'soft' ? Math.max(1, s.substeps) : 1;
    const h = dt / substeps;
    const awake = live.filter((b) => b.awake && b.type !== 'static');
    // Every contact with manifold points is solved, including speculative ones not yet touching.
    const contacts = [...this.contacts.values()].filter((c) => c.points.length && (this.bodies[c.a]!.awake || this.bodies[c.b]!.awake));
    const joints = this.joints.filter((j) => this.bodies[j.a]!.awake || this.bodies[j.b]!.awake);
    this.prepareContacts(contacts);
    this.prepareJoints(joints, h);

    if (s.solver === 'soft') {
      for (let i = 0; i < substeps; i++) {
        this.integrateVelocities(awake, h);
        if (s.warmStarting) this.warmStart(contacts, joints);
        for (let k = 0; k < s.iterations; k++) {
          this.solveJoints(joints, h, true);
          this.solveContacts(contacts, h, true);
        }
        this.integratePositions(awake, h);
        for (let k = 0; k < s.iterations; k++) {
          this.solveJoints(joints, h, false);
          this.solveContacts(contacts, h, false);
        }
      }
      this.applyRestitution(contacts);
    } else {
      this.integrateVelocities(awake, dt);
      if (s.warmStarting) this.warmStart(contacts, joints);
      for (let k = 0; k < s.iterations; k++) {
        this.solveJoints(joints, dt, true);
        this.solveContacts(contacts, dt, true);
      }
      this.integratePositions(awake, dt);
    }

    if (s.continuous === 'sweep') this.sweepBullets(awake);
    for (const b of awake) b.aabb = aabbOf(b.shape, b.xf);
    this.updateSleep(live, dt);
    this.time += dt;
    this.steps++;
  }

  /** Broadphase and narrowphase: find pairs, update their manifolds, keep last step's impulses by feature id. */
  private updatePairs(live: Body[], dt: number): void {
    const s = this.settings;
    const st = this.stats;
    // Fattened bounds: fast bodies' boxes grow along their motion when contacts are speculative.
    for (const b of live) {
      const base = aabbOf(b.shape, b.xf, CONTACT_MARGIN);
      if (s.continuous === 'speculative' && b.type !== 'static' && b.awake) {
        const d = scale(b.v, dt);
        base.lo = v(Math.min(base.lo.x, base.lo.x + d.x), Math.min(base.lo.y, base.lo.y + d.y));
        base.hi = v(Math.max(base.hi.x, base.hi.x + d.x), Math.max(base.hi.y, base.hi.y + d.y));
      }
      b.aabb = base;
    }
    const pairs: Array<[number, number]> = [];
    let tests = 0;
    const consider = (a: Body, b: Body) => {
      if (a.type !== 'dynamic' && b.type !== 'dynamic') return;
      if (!a.awake && !b.awake) return;
      if (!(a.category & b.mask) || !(b.category & a.mask)) return;
      if (this.jointed(a.index, b.index)) return;
      tests++;
      if (overlaps(a.aabb, b.aabb)) pairs.push(a.index < b.index ? [a.index, b.index] : [b.index, a.index]);
    };
    if (s.broadphase === 'brute') {
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) consider(live[i], live[j]);
    } else {
      // Sort and sweep on x. The order persists, so insertion sort does little work frame to frame.
      const alive = new Set(live.map((b) => b.index));
      const order = this.sapOrder.filter((i) => alive.has(i));
      for (const b of live) if (!order.includes(b.index)) order.push(b.index);
      for (let i = 1; i < order.length; i++) {
        const k = order[i];
        const kx = this.bodies[k]!.aabb.lo.x;
        let j = i - 1;
        while (j >= 0 && this.bodies[order[j]]!.aabb.lo.x > kx) {
          order[j + 1] = order[j];
          j--;
        }
        order[j + 1] = k;
      }
      this.sapOrder = order;
      for (let i = 0; i < order.length; i++) {
        const a = this.bodies[order[i]]!;
        for (let j = i + 1; j < order.length; j++) {
          const b = this.bodies[order[j]]!;
          if (b.aabb.lo.x > a.aabb.hi.x) break;
          if (a.aabb.lo.y > b.aabb.hi.y || b.aabb.lo.y > a.aabb.hi.y) {
            // Counted as a test: the sweep found it overlapping on x and then checked y.
            if (a.type === 'dynamic' || b.type === 'dynamic') tests++;
            continue;
          }
          consider(a, b);
        }
      }
    }
    pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    this.lastPairs = pairs;
    st.aabbTests = tests;
    st.pairs = pairs.length;

    const seen = new Set<string>();
    let points = 0;
    let warm = 0;
    for (const [ia, ib] of pairs) {
      const a = this.bodies[ia]!;
      const b = this.bodies[ib]!;
      const key = `${ia}:${ib}`;
      seen.add(key);
      let c = this.contacts.get(key);
      // Sleeping against static or sleeping: keep the old manifold as it is.
      if (c && !a.awake && !b.awake) continue;
      const spec = s.continuous === 'speculative' ? CONTACT_MARGIN + len(sub(b.v, a.v)) * dt : CONTACT_MARGIN;
      const m: Manifold | null = collide(a.shape, a.xf, b.shape, b.xf, spec);
      if (!c) {
        c = { a: ia, b: ib, key, normal: v(0, 1), points: [], friction: Math.sqrt(a.friction * b.friction), restitution: Math.max(a.restitution, b.restitution), touching: false };
        this.contacts.set(key, c);
      }
      const was = c.touching;
      if (m) {
        const old = c.points;
        c.normal = m.normal;
        c.points = m.points.map((p) => {
          const o = old.find((x) => x.id === p.id);
          const keep = !!o && s.warmStarting;
          return {
            id: p.id,
            localA: p.localA,
            localB: p.localB,
            separation: p.separation,
            rA: v(0, 0),
            rB: v(0, 0),
            normalMass: 0,
            tangentMass: 0,
            normalImpulse: keep ? o!.normalImpulse : 0,
            tangentImpulse: keep ? o!.tangentImpulse : 0,
            maxNormalImpulse: 0,
            relVel: 0,
            warm: keep && o!.normalImpulse > 0,
          };
        });
        c.touching = c.points.some((p) => p.separation < CONTACT_MARGIN);
        points += c.points.length;
        warm += c.points.filter((p) => p.warm).length;
      } else {
        c.points = [];
        c.touching = false;
      }
      if (c.touching && !was) {
        this.began.push({ a: a.handle, b: b.handle });
        if (!a.awake) this.wake(a);
        if (!b.awake) this.wake(b);
      }
      if (!c.touching && was) this.ended.push({ a: a.handle, b: b.handle });
    }
    for (const [k, c] of this.contacts) {
      if (seen.has(k)) continue;
      const a = this.bodies[c.a];
      const b = this.bodies[c.b];
      // Keep resting contacts of sleeping bodies; drop the rest.
      if (a && b && !a.awake && !b.awake) continue;
      if (c.touching && a && b) this.ended.push({ a: a.handle, b: b.handle });
      this.contacts.delete(k);
    }
    st.contacts = [...this.contacts.values()].filter((c) => c.touching).length;
    st.points = points;
    st.warmPoints = warm;
  }

  private jointed(a: number, b: number): boolean {
    return this.joints.some((j) => j.kind !== 'mouse' && ((j.a === a && j.b === b) || (j.a === b && j.b === a)));
  }

  private integrateVelocities(bodies: Body[], h: number): void {
    const g = this.settings.gravity;
    for (const b of bodies) {
      if (b.type !== 'dynamic') continue;
      b.v = add(b.v, scale(g, h));
      if (b.linearDamping) b.v = scale(b.v, 1 / (1 + h * b.linearDamping));
      if (b.angularDamping) b.w *= 1 / (1 + h * b.angularDamping);
    }
  }

  private integratePositions(bodies: Body[], h: number): void {
    for (const b of bodies) {
      b.xf.p = add(b.xf.p, scale(b.v, h));
      if (b.w !== 0) b.xf.q = integrateRot(b.xf.q, h * b.w);
    }
  }

  private prepareContacts(contacts: Contact[]): void {
    for (const c of contacts) {
      const a = this.bodies[c.a]!;
      const b = this.bodies[c.b]!;
      const n = c.normal;
      const t = perp(n);
      for (const p of c.points) {
        p.rA = rotate(a.xf.q, p.localA);
        p.rB = rotate(b.xf.q, p.localB);
        const rnA = cross(p.rA, n);
        const rnB = cross(p.rB, n);
        const kn = a.invMass + b.invMass + a.invI * rnA * rnA + b.invI * rnB * rnB;
        p.normalMass = kn > 0 ? 1 / kn : 0;
        const rtA = cross(p.rA, t);
        const rtB = cross(p.rB, t);
        const kt = a.invMass + b.invMass + a.invI * rtA * rtA + b.invI * rtB * rtB;
        p.tangentMass = kt > 0 ? 1 / kt : 0;
        const dv = sub(add(b.v, crossSV(b.w, p.rB)), add(a.v, crossSV(a.w, p.rA)));
        p.relVel = dot(dv, n);
        p.maxNormalImpulse = 0;
      }
    }
  }

  private warmStart(contacts: Contact[], joints: Joint[]): void {
    for (const c of contacts) {
      const a = this.bodies[c.a]!;
      const b = this.bodies[c.b]!;
      const t = perp(c.normal);
      for (const p of c.points) {
        const P = add(scale(c.normal, p.normalImpulse), scale(t, p.tangentImpulse));
        this.applyPair(a, b, p.rA, p.rB, P);
      }
    }
    for (const j of joints) {
      const a = this.bodies[j.a]!;
      const b = this.bodies[j.b]!;
      if (j.kind === 'distance') {
        const d = norm2(sub(add(b.xf.p, j.rB), add(a.xf.p, j.rA)));
        this.applyPair(a, b, j.rA, j.rB, scale(d, j.axialImpulse - j.upperImpulse + j.lowerImpulse));
      } else {
        this.applyPair(a, b, j.rA, j.rB, j.impulse);
        if (j.kind === 'revolute' && j.motorImpulse) {
          a.w -= a.invI * j.motorImpulse;
          b.w += b.invI * j.motorImpulse;
        }
      }
    }
  }

  private applyPair(a: Body, b: Body, rA: V, rB: V, P: V): void {
    a.v = sub(a.v, scale(P, a.invMass));
    a.w -= a.invI * cross(rA, P);
    b.v = add(b.v, scale(P, b.invMass));
    b.w += b.invI * cross(rB, P);
  }

  private solveContacts(contacts: Contact[], h: number, useBias: boolean): void {
    const s = this.settings;
    const inv_h = 1 / h;
    const sp = soft(Math.min(s.contactHertz, 0.25 / h), s.contactDampingRatio, h);
    for (const c of contacts) {
      const a = this.bodies[c.a]!;
      const b = this.bodies[c.b]!;
      const n = c.normal;
      const t = perp(n);
      let totalNormal = 0;
      for (const p of c.points) {
        // Current separation from the anchors' current positions (bodies have moved since the narrowphase).
        const pa = add(a.xf.p, rotate(a.xf.q, p.localA));
        const pb = add(b.xf.p, rotate(b.xf.q, p.localB));
        const sep = dot(sub(pb, pa), n);
        let bias = 0;
        let massScale = 1;
        let impulseScale = 0;
        if (sep > 0) {
          bias = sep * inv_h; // speculative: allow closing the gap this step, no further
        } else if (useBias) {
          if (s.solver === 'soft') {
            bias = Math.max(sp.biasRate * sep, -s.maxPushout);
            massScale = sp.massScale;
            impulseScale = sp.impulseScale;
          } else {
            bias = -s.baumgarte * inv_h * Math.max(0, -sep - s.slop);
            if (p.relVel < -s.restitutionThreshold && c.restitution > 0) bias = Math.min(bias, c.restitution * p.relVel);
          }
        }
        const dv = sub(add(b.v, crossSV(b.w, p.rB)), add(a.v, crossSV(a.w, p.rA)));
        const vn = dot(dv, n);
        let impulse = -p.normalMass * massScale * (vn + bias) - impulseScale * p.normalImpulse;
        const nw = Math.max(p.normalImpulse + impulse, 0);
        impulse = nw - p.normalImpulse;
        p.normalImpulse = nw;
        p.maxNormalImpulse = Math.max(p.maxNormalImpulse, impulse);
        totalNormal += nw;
        this.applyPair(a, b, p.rA, p.rB, scale(n, impulse));
      }
      for (const p of c.points) {
        const dv = sub(add(b.v, crossSV(b.w, p.rB)), add(a.v, crossSV(a.w, p.rA)));
        const vt = dot(dv, t);
        let impulse = -p.tangentMass * vt;
        const maxF = c.friction * p.normalImpulse;
        const nw = clamp(p.tangentImpulse + impulse, -maxF, maxF);
        impulse = nw - p.tangentImpulse;
        p.tangentImpulse = nw;
        this.applyPair(a, b, p.rA, p.rB, scale(t, impulse));
      }
      void totalNormal;
    }
  }

  /** Soft step: bounce is applied once at the end, from the approach speed measured before solving. */
  private applyRestitution(contacts: Contact[]): void {
    const th = this.settings.restitutionThreshold;
    for (const c of contacts) {
      if (c.restitution === 0) continue;
      const a = this.bodies[c.a]!;
      const b = this.bodies[c.b]!;
      for (const p of c.points) {
        if (p.relVel > -th || p.maxNormalImpulse === 0) continue;
        const dv = sub(add(b.v, crossSV(b.w, p.rB)), add(a.v, crossSV(a.w, p.rA)));
        const vn = dot(dv, c.normal);
        let impulse = -p.normalMass * (vn + c.restitution * p.relVel);
        const nw = Math.max(p.normalImpulse + impulse, 0);
        impulse = nw - p.normalImpulse;
        p.normalImpulse = nw;
        this.applyPair(a, b, p.rA, p.rB, scale(c.normal, impulse));
      }
    }
  }

  private prepareJoints(joints: Joint[], h: number): void {
    for (const j of joints) {
      const a = this.bodies[j.a]!;
      const b = this.bodies[j.b]!;
      j.rA = rotate(a.xf.q, j.localA);
      j.rB = rotate(b.xf.q, j.localB);
      if (!this.settings.warmStarting) {
        j.impulse = v(0, 0);
        j.axialImpulse = 0;
        j.upperImpulse = 0;
        j.lowerImpulse = 0;
        j.motorImpulse = 0;
      }
      void h;
    }
  }

  private solveJoints(joints: Joint[], h: number, useBias: boolean): void {
    const s = this.settings;
    const inv_h = 1 / h;
    for (const j of joints) {
      const a = this.bodies[j.a]!;
      const b = this.bodies[j.b]!;
      const pa = add(a.xf.p, rotate(a.xf.q, j.localA));
      const pb = add(b.xf.p, rotate(b.xf.q, j.localB));
      // The anchor offsets follow the bodies' current rotation (they moved during substeps).
      j.rA = sub(pa, a.xf.p);
      j.rB = sub(pb, b.xf.p);
      if (j.kind === 'revolute') {
        if (j.maxMotorTorque > 0) {
          const k = a.invI + b.invI;
          if (k > 0) {
            const cdot = b.w - a.w - j.motorSpeed;
            let imp = -cdot / k;
            const old = j.motorImpulse;
            const max = j.maxMotorTorque * h;
            j.motorImpulse = clamp(old + imp, -max, max);
            imp = j.motorImpulse - old;
            a.w -= a.invI * imp;
            b.w += b.invI * imp;
          }
        }
        this.solvePoint(a, b, j, sub(pb, pa), h, useBias, s.solver === 'soft' ? soft(60, 2, h) : null, inv_h);
      } else if (j.kind === 'mouse') {
        // Body B pulled towards the target by a soft spring; A is the ground and doesn't move.
        const sp = soft(j.hertz, j.damping, h);
        const C = sub(pb, j.target);
        const vB = add(b.v, crossSV(b.w, j.rB));
        const K = k2(b, j.rB);
        const bias = scale(C, sp.biasRate);
        const rhs = add(vB, bias);
        let imp = scale(solve2(K, rhs), -sp.massScale);
        imp = sub(imp, scale(j.impulse, sp.impulseScale));
        const old = j.impulse;
        let nw = add(old, imp);
        const max = j.maxForce * h;
        if (lenSq(nw) > max * max) nw = scale(nw, max / len(nw));
        imp = sub(nw, old);
        j.impulse = nw;
        b.v = add(b.v, scale(imp, b.invMass));
        b.w += b.invI * cross(j.rB, imp);
      } else {
        const d = sub(pb, pa);
        const L = len(d);
        const u = L > 1e-9 ? scale(d, 1 / L) : v(1, 0);
        const crA = cross(j.rA, u);
        const crB = cross(j.rB, u);
        const k = a.invMass + b.invMass + a.invI * crA * crA + b.invI * crB * crB;
        if (k === 0) continue;
        const vr = () => dot(sub(add(b.v, crossSV(b.w, j.rB)), add(a.v, crossSV(a.w, j.rA))), u);
        const apply = (imp: number) => this.applyPair(a, b, j.rA, j.rB, scale(u, imp));
        const stiff = (c: number) => {
          if (!useBias) return { bias: 0, ms: 1, is: 0 };
          if (s.solver === 'soft') {
            const sp = soft(60, 5, h);
            return { bias: sp.biasRate * c, ms: sp.massScale, is: sp.impulseScale };
          }
          return { bias: s.baumgarte * inv_h * c, ms: 1, is: 0 };
        };
        if (j.minLength === j.maxLength && j.hertz === 0) {
          // A rigid rod: an equality constraint on the length.
          const k2 = stiff(L - j.length);
          const imp = (-k2.ms * (vr() + k2.bias)) / k - k2.is * j.axialImpulse;
          j.axialImpulse += imp;
          apply(imp);
          continue;
        }
        if (j.hertz > 0) {
          // A spring towards the rest length.
          const sp = soft(j.hertz, j.damping, h);
          const imp = (-sp.massScale * (vr() + sp.biasRate * (L - j.length))) / k - sp.impulseScale * j.axialImpulse;
          j.axialImpulse += imp;
          apply(imp);
        }
        if (Number.isFinite(j.maxLength)) {
          // A rope: the length may shrink but not grow past maxLength. Like a contact: impulse only pulls.
          const gap = j.maxLength - L;
          const st = gap > 0 ? { bias: gap * inv_h, ms: 1, is: 0 } : stiff(gap);
          let imp = (-st.ms * (-vr() + st.bias)) / k - st.is * j.upperImpulse;
          const nw = Math.max(j.upperImpulse + imp, 0);
          imp = nw - j.upperImpulse;
          j.upperImpulse = nw;
          apply(-imp);
        }
        if (j.minLength > 0) {
          const gap = L - j.minLength;
          const st = gap > 0 ? { bias: gap * inv_h, ms: 1, is: 0 } : stiff(gap);
          let imp = (-st.ms * (vr() + st.bias)) / k - st.is * j.lowerImpulse;
          const nw = Math.max(j.lowerImpulse + imp, 0);
          imp = nw - j.lowerImpulse;
          j.lowerImpulse = nw;
          apply(imp);
        }
      }
    }
  }

  private solvePoint(a: Body, b: Body, j: Joint, C: V, h: number, useBias: boolean, sp: ReturnType<typeof soft> | null, inv_h: number): void {
    const dv = sub(add(b.v, crossSV(b.w, j.rB)), add(a.v, crossSV(a.w, j.rA)));
    let bias = v(0, 0);
    let ms = 1;
    let is = 0;
    if (useBias) {
      if (sp) {
        bias = scale(C, sp.biasRate);
        ms = sp.massScale;
        is = sp.impulseScale;
      } else bias = scale(C, this.settings.baumgarte * inv_h);
    }
    const K = {
      a: a.invMass + b.invMass + a.invI * j.rA.y * j.rA.y + b.invI * j.rB.y * j.rB.y,
      b: -a.invI * j.rA.x * j.rA.y - b.invI * j.rB.x * j.rB.y,
      d: a.invMass + b.invMass + a.invI * j.rA.x * j.rA.x + b.invI * j.rB.x * j.rB.x,
    };
    let imp = scale(solve2(K, add(dv, bias)), -ms);
    imp = sub(imp, scale(j.impulse, is));
    j.impulse = add(j.impulse, imp);
    this.applyPair(a, b, j.rA, j.rB, imp);
    void h;
  }

  /** Continuous mode "sweep": fast bullets are cast along this step's motion against static shapes and stopped at the first hit. */
  private sweepBullets(bodies: Body[]): void {
    for (const b of bodies) {
      if (!b.bullet || b.shape.kind !== 'circle') continue;
      const d = sub(b.xf.p, b.prev.p);
      const dist = len(d);
      if (dist < b.shape.r * 0.5) continue;
      const dir = scale(d, 1 / dist);
      let best = 1;
      let hitN: V | null = null;
      for (const o of this.bodies) {
        if (!o || o.type !== 'static' || !(o.category & b.mask) || !(b.category & o.mask)) continue;
        const hit = circleCast(o.shape, o.xf, b.shape.r, b.prev.p, dir, dist);
        if (hit && hit.t / dist < best) {
          best = hit.t / dist;
          hitN = hit.normal;
        }
      }
      if (hitN && best < 1) {
        // Back off a little so the contact is found next step instead of overlapping.
        const t = Math.max(0, best - 0.01 / dist);
        b.xf.p = add(b.prev.p, scale(d, t));
        const vn = dot(b.v, hitN);
        if (vn < 0) b.v = sub(b.v, scale(hitN, vn * (1 + b.restitution)));
        b.swept = true;
        this.stats.swept++;
      }
    }
  }

  /** Islands (union-find over touching contacts and joints between awake dynamic bodies) and sleep. */
  private updateSleep(live: Body[], dt: number): void {
    const parent = new Map<number, number>();
    const find = (i: number): number => {
      let r = i;
      while (parent.get(r)! !== r) r = parent.get(r)!;
      let x = i;
      while (parent.get(x)! !== r) {
        const n = parent.get(x)!;
        parent.set(x, r);
        x = n;
      }
      return r;
    };
    const dyn = live.filter((b) => b.type !== 'static' && b.awake);
    for (const b of dyn) parent.set(b.index, b.index);
    const join = (i: number, k: number) => {
      if (!parent.has(i) || !parent.has(k)) return;
      const a = find(i);
      const c = find(k);
      if (a !== c) parent.set(Math.max(a, c), Math.min(a, c));
    };
    for (const c of this.contacts.values()) if (c.touching && c.points.length) join(c.a, c.b);
    for (const j of this.joints) if (j.kind !== 'mouse') join(j.a, j.b);
    // Bodies held by the mouse never sleep.
    const held = new Set(this.joints.filter((j) => j.kind === 'mouse').map((j) => j.b));
    const islands = new Map<number, Body[]>();
    for (const b of dyn) {
      const r = find(b.index);
      if (!islands.has(r)) islands.set(r, []);
      islands.get(r)!.push(b);
      const still = lenSq(b.v) < SLEEP_LINEAR * SLEEP_LINEAR && Math.abs(b.w) < SLEEP_ANGULAR && !held.has(b.index) && b.type === 'dynamic';
      b.sleepTime = still ? b.sleepTime + dt : 0;
    }
    for (const [root, bs] of islands) {
      for (const b of bs) b.island = root;
      if (this.settings.sleeping && bs.every((b) => b.sleepTime >= TIME_TO_SLEEP)) {
        for (const b of bs) {
          b.awake = false;
          b.v = v(0, 0);
          b.w = 0;
        }
      }
    }
    this.stats.awake = live.filter((b) => b.awake).length;
    this.stats.islands = islands.size;
    this.stats.sleeping = live.filter((b) => b.type !== 'static' && !b.awake).length;
  }

  // ----------------------------------------------------------------------------------------
  // Queries

  /** Closest body hit by a ray from p in direction d (unit) within maxT. */
  raycast(p: V, d: V, maxT: number, mask = 0xffff, ignore: BodyHandle = NULL_BODY): { body: Body; t: number; point: V; normal: V } | null {
    let best: { body: Body; t: number; point: V; normal: V } | null = null;
    for (const b of this.bodies) {
      if (!b || b.handle === ignore || !(b.category & mask)) continue;
      const h = raycast(b.shape, b.xf, p, d, best ? best.t : maxT);
      if (h && (!best || h.t < best.t)) best = { body: b, ...h };
    }
    return best;
  }

  /** Closest body hit by a circle of radius r swept from p along d (unit). */
  circleCast(r: number, p: V, d: V, maxT: number, mask = 0xffff, ignore: BodyHandle = NULL_BODY): { body: Body; t: number; point: V; normal: V } | null {
    let best: { body: Body; t: number; point: V; normal: V } | null = null;
    for (const b of this.bodies) {
      if (!b || b.handle === ignore || !(b.category & mask)) continue;
      const h = circleCast(b.shape, b.xf, r, p, d, best ? best.t : maxT);
      if (h && (!best || h.t < best.t)) best = { body: b, ...h };
    }
    return best;
  }

  /** Bodies whose shape contains point p. */
  pointQuery(p: V): Body[] {
    return this.live().filter((b) => {
      if (b.shape.kind === 'circle') return lenSq(sub(p, b.xf.p)) <= b.shape.r * b.shape.r;
      const lp = invXf(b.xf, p);
      return b.shape.normals.every((n, i) => dot(n, sub(lp, (b.shape as { verts: V[] }).verts[i])) <= 0);
    });
  }

  /** Overlap test of a circle against everything: who's in the way. */
  overlapCircle(c: V, r: number, mask = 0xffff, ignore: BodyHandle = NULL_BODY): Array<{ body: Body; normal: V; depth: number }> {
    const out: Array<{ body: Body; normal: V; depth: number }> = [];
    const probe = { kind: 'circle' as const, r };
    const t: Transform = { p: c, q: ROT0 };
    for (const b of this.bodies) {
      if (!b || b.handle === ignore || !(b.category & mask)) continue;
      const m = collide(b.shape, b.xf, probe, t, 0);
      if (m && m.points[0].separation < 0) out.push({ body: b, normal: m.normal, depth: -m.points[0].separation });
    }
    return out;
  }

  /** Kinetic energy of awake dynamic bodies (J), for the lessons' stability charts. */
  energy(): number {
    let e = 0;
    for (const b of this.bodies) if (b && b.type === 'dynamic') e += 0.5 * b.mass * lenSq(b.v) + (b.invI > 0 ? (0.5 * b.w * b.w) / b.invI : 0);
    return e;
  }
}

function norm2(a: V): V {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : v(1, 0);
}

function k2(b: Body, r: V) {
  return {
    a: b.invMass + b.invI * r.y * r.y,
    b: -b.invI * r.x * r.y,
    d: b.invMass + b.invI * r.x * r.x,
  };
}

/** Solve [a b; b d] x = r. */
function solve2(K: { a: number; b: number; d: number }, r: V): V {
  let det = K.a * K.d - K.b * K.b;
  if (det !== 0) det = 1 / det;
  return v(det * (K.d * r.x - K.b * r.y), det * (K.a * r.y - K.b * r.x));
}

export { xf };
