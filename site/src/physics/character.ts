/**
 * Two ways to make a character, on the teaching engine.
 *
 * KinematicMover: a circle outside the simulation, moved by the game with scene queries
 * ("collide and slide"), like Jolt's CharacterVirtual, PhysX's PxController and Box3D's mover.
 * It climbs steps, refuses slopes steeper than a limit, sticks to the ground going downhill,
 * and pushes dynamic bodies with a capped impulse. Nothing pushes it back unless code says so.
 *
 * DynamicCharacter: an ordinary dynamic body (a circle with rotation locked) driven by setting
 * its velocity, like Jolt's Character. It reacts to everything for free, including things you
 * didn't want: sliding down slopes, being shoved, bouncing on steps.
 */
import { type V, add, dot, len, scale, sub, v } from './math';
import { circle } from './collide';
import { type BodyHandle, type World } from './world';

export interface MoveInput {
  /** -1, 0 or 1. */
  x: number;
  jump: boolean;
}

export interface MoverSettings {
  radius: number;
  speed: number;
  jumpSpeed: number;
  /** Steepest walkable slope, as the cosine of its angle (cos 45° ≈ 0.707). */
  minGroundCos: number;
  stepHeight: number;
  /** How far down to look for ground to stick to after walking off a downward slope or step. */
  snap: number;
  /** Strongest shove a mover gives a dynamic body per step, N·s. */
  pushImpulse: number;
}

export const MOVER_DEFAULTS: MoverSettings = { radius: 0.35, speed: 4, jumpSpeed: 6.5, minGroundCos: Math.SQRT1_2, stepHeight: 0.3, snap: 0.25, pushImpulse: 2 };
const SKIN = 0.01;
/** The mover's queries ignore this category (give the dynamic character its own). */
export const CHARACTER_CATEGORY = 0x4000;

export interface CastDebug {
  from: V;
  to: V;
  hit: V | null;
  normal: V | null;
  kind: 'move' | 'step' | 'snap';
}

export class KinematicMover {
  pos: V;
  vel: V = v(0, 0);
  grounded = false;
  groundNormal: V = v(0, 1);
  s: MoverSettings;
  /** The casts made last step, for drawing. */
  casts: CastDebug[] = [];
  stepped = false;
  private mask: number;

  constructor(
    private w: World,
    at: V,
    s: Partial<MoverSettings> = {},
  ) {
    this.pos = { ...at };
    this.s = { ...MOVER_DEFAULTS, ...s };
    this.mask = 0xffff & ~CHARACTER_CATEGORY;
  }

  private cast(from: V, delta: V, kind: CastDebug['kind']) {
    const d = len(delta);
    if (d < 1e-6) return null;
    const dir = scale(delta, 1 / d);
    const hit = this.w.circleCast(this.s.radius, from, dir, d, this.mask);
    this.casts.push({ from, to: add(from, delta), hit: hit ? add(from, scale(dir, hit.t)) : null, normal: hit?.normal ?? null, kind });
    return hit ? { ...hit, dir, dist: d } : null;
  }

  /** Move by delta, sliding along whatever is hit (up to 4 times). Returns the planes touched. */
  private slide(delta: V, kind: CastDebug['kind'] = 'move', noClimb = false): V[] {
    const planes: V[] = [];
    let rest = delta;
    for (let i = 0; i < 4 && len(rest) > 1e-5; i++) {
      const hit = this.cast(this.pos, rest, kind);
      if (!hit) {
        this.pos = add(this.pos, rest);
        break;
      }
      const go = Math.max(0, hit.t - SKIN);
      this.pos = add(this.pos, scale(hit.dir, go));
      planes.push(hit.normal);
      if (hit.body.type === 'dynamic') {
        // Shove what we walked into, but only so hard: a mover is not an infinite-mass bulldozer.
        const into = -dot(rest, hit.normal) / (len(rest) || 1);
        const imp = Math.min(this.s.pushImpulse, Math.max(0, into) * this.s.pushImpulse * 2);
        this.w.applyImpulse(hit.body.handle, scale(hit.normal, -imp), hit.point);
      }
      // Whatever is left of the move, minus the part going into the surface.
      const left = scale(rest, 1 - go / hit.dist);
      rest = sub(left, scale(hit.normal, Math.min(0, dot(left, hit.normal))));
      // Walking into a slope too steep to stand on must not slide us up it.
      if (noClimb && hit.normal.y < this.s.minGroundCos && rest.y > 0) rest = v(rest.x, 0);
    }
    return planes;
  }

  step(input: MoveInput, dt: number, gravity: V): void {
    this.casts = [];
    this.stepped = false;
    const s = this.s;
    // Velocity: walking sets x directly; gravity accumulates unless grounded.
    this.vel.x = input.x * s.speed;
    if (this.grounded) {
      this.vel.y = 0;
      if (input.jump) {
        this.vel.y = s.jumpSpeed;
        this.grounded = false;
      }
    } else this.vel = add(this.vel, scale(gravity, dt));
    const wasGrounded = this.grounded;
    const delta = scale(this.vel, dt);

    // Horizontal and vertical moves separately: walking along slopes and steps is easier to reason about.
    const start = { ...this.pos };
    const hPlanes = this.slide(v(delta.x, 0), 'move', true);
    const blocked = hPlanes.some((n) => n.y < s.minGroundCos);
    if (blocked && wasGrounded && delta.x !== 0) this.tryStep(start, delta.x);
    const vPlanes = this.slide(v(0, delta.y));
    const all = [...hPlanes, ...vPlanes];
    const ground = all.filter((n) => n.y >= s.minGroundCos);
    this.grounded = ground.length > 0 && this.vel.y <= 0;
    if (ground.length) this.groundNormal = ground[0];
    // Bumping a ceiling ends the jump. (Walking speed is set fresh every step, so walls need nothing;
    // clipping it against a steep slope would turn it into upward speed and climb the slope.)
    if (this.vel.y > 0 && all.some((n) => n.y < -0.1)) this.vel.y = 0;
    // Stick to the ground walking downhill or off a small step, instead of flying off the edge.
    if (!this.grounded && wasGrounded && this.vel.y <= 0) {
      const hit = this.cast(this.pos, v(0, -s.snap), 'snap');
      if (hit && hit.normal.y >= s.minGroundCos) {
        this.pos = add(this.pos, v(0, -Math.max(0, hit.t - SKIN)));
        this.grounded = true;
        this.groundNormal = hit.normal;
      }
    }
    // Overlapping something after all that (a platform moved into us, a box landed on us)?
    // Static and kinematic geometry pushes the mover out, a few passes so corners settle.
    // Dynamic bodies are pushed away instead: nothing in the simulation knows the mover is there,
    // so a box resting on its head would otherwise press it into the floor.
    for (let pass = 0; pass < 3; pass++) {
      const hits = this.w.overlapCircle(this.pos, s.radius, this.mask);
      if (!hits.length) break;
      for (const o of hits) {
        if (o.body.type === 'dynamic') {
          const toward = Math.max(0, dot(o.body.v, o.normal));
          if (pass === 0) this.w.applyImpulse(o.body.handle, scale(o.normal, -o.body.mass * (toward + o.depth * 10)));
        } else this.pos = add(this.pos, scale(o.normal, o.depth + SKIN));
      }
    }
    void start;
  }

  /** Blocked by a wall-like surface: try up by stepHeight, across, then back down onto something walkable. */
  private tryStep(start: V, dx: number): void {
    const s = this.s;
    const saved = { ...this.pos };
    this.pos = { ...start };
    const up = this.cast(this.pos, v(0, s.stepHeight), 'step');
    const rise = up ? Math.max(0, up.t - SKIN) : s.stepHeight;
    this.pos = add(this.pos, v(0, rise));
    // Reach far enough over the edge that the rounded bottom lands on the step's top, not its corner
    // (Jolt's WalkStairs has a "step forward" distance for the same reason).
    const reach = Math.sign(dx) * Math.max(Math.abs(dx), s.radius * 0.4);
    const across = this.cast(this.pos, v(reach, 0), 'step');
    this.pos = add(this.pos, v(across ? Math.sign(dx) * Math.max(0, across.t - SKIN) : reach, 0));
    const down = this.cast(this.pos, v(0, -rise - SKIN * 2), 'step');
    if (down && down.normal.y >= s.minGroundCos && Math.abs(this.pos.x - start.x) > Math.abs(saved.x - start.x) + 1e-4) {
      this.pos = add(this.pos, v(0, -Math.max(0, down.t - SKIN)));
      this.stepped = true;
    } else this.pos = saved;
  }
}

export class DynamicCharacter {
  handle: BodyHandle;
  grounded = false;
  constructor(
    private w: World,
    at: V,
    public radius = 0.35,
    public speed = 4,
    public jumpSpeed = 6.5,
  ) {
    this.handle = w.createBody({ shape: circle(radius), position: at, fixedRotation: true, friction: 0.2, density: 2, category: CHARACTER_CATEGORY, tag: 2, awake: true });
  }
  step(input: MoveInput): void {
    const b = this.w.get(this.handle);
    if (!b) return;
    // Grounded if a contact pushes up on it.
    this.grounded = [...this.w.contacts.values()].some((c) => (c.a === b.index || c.b === b.index) && c.touching && (c.a === b.index ? c.normal.y < -0.5 : c.normal.y > 0.5));
    const vx = input.x * this.speed;
    // Walking sets horizontal speed directly; standing still leaves it to friction and the solver.
    if (vx !== 0) b.v = v(vx, b.v.y);
    if (input.jump && this.grounded) b.v = v(b.v.x, this.jumpSpeed);
    this.w.wake(b);
  }
  get pos(): V {
    return this.w.get(this.handle)?.xf.p ?? v(0, 0);
  }
}
