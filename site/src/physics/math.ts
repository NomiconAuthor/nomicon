/**
 * Small 2D maths for the teaching engine.
 *
 * No Math.sin, Math.cos, Math.atan2 or Math.hypot inside the simulation: their results are
 * allowed to differ between JavaScript engines. +, -, *, / and Math.sqrt are exactly rounded
 * IEEE operations everywhere, so a simulation built only from them replays bit for bit in every
 * browser. Rotations are stored as (cos, sin) and integrated by adding and renormalising, the
 * way Box2D v3 does it; makeRot() uses its own polynomial for the few angles set up by hand.
 */

export interface V {
  x: number;
  y: number;
}
export interface Rot {
  c: number;
  s: number;
}

export const v = (x: number, y: number): V => ({ x, y });
export const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
export const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y;
export const cross = (a: V, b: V): number => a.x * b.y - a.y * b.x;
/** cross(w, r) for a scalar angular velocity w: the velocity of point r on a spinning body. */
export const crossSV = (w: number, r: V): V => ({ x: -w * r.y, y: w * r.x });
export const perp = (a: V): V => ({ x: -a.y, y: a.x });
export const neg = (a: V): V => ({ x: -a.x, y: -a.y });
export const len = (a: V): number => Math.sqrt(a.x * a.x + a.y * a.y);
export const lenSq = (a: V): number => a.x * a.x + a.y * a.y;
export const norm = (a: V): V => {
  const l = len(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};
export const lerpV = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

export const ROT0: Rot = { c: 1, s: 0 };
export const rotate = (q: Rot, a: V): V => ({ x: q.c * a.x - q.s * a.y, y: q.s * a.x + q.c * a.y });
export const invRotate = (q: Rot, a: V): V => ({ x: q.c * a.x + q.s * a.y, y: -q.s * a.x + q.c * a.y });
export const mulRot = (a: Rot, b: Rot): Rot => ({ c: a.c * b.c - a.s * b.s, s: a.s * b.c + a.c * b.s });

/** Advance a rotation by angle h*w: q + h*w*perp(q), renormalised. Accurate for small steps. */
export function integrateRot(q: Rot, hw: number): Rot {
  const c = q.c - hw * q.s;
  const s = q.s + hw * q.c;
  const l = Math.sqrt(c * c + s * s);
  return l > 0 ? { c: c / l, s: s / l } : ROT0;
}

/** Interpolate rotations (normalised lerp): fine for render interpolation between steps. */
export function nlerpRot(a: Rot, b: Rot, t: number): Rot {
  const c = a.c + (b.c - a.c) * t;
  const s = a.s + (b.s - a.s) * t;
  const l = Math.sqrt(c * c + s * s);
  return l > 0 ? { c: c / l, s: s / l } : a;
}

/** A rotation from an angle in radians, with a deterministic polynomial (no Math.sin). */
export function makeRot(angle: number): Rot {
  // Reduce to [-pi, pi], reflect into [-pi/2, pi/2], then Taylor series (good to ~1e-7 there).
  const PI = 3.141592653589793;
  const r = angle - Math.floor((angle + PI) / (2 * PI)) * 2 * PI;
  let x = r;
  let cosSign = 1;
  if (r > PI / 2) [x, cosSign] = [PI - r, -1];
  else if (r < -PI / 2) [x, cosSign] = [-PI - r, -1];
  const x2 = x * x;
  const s = x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * (1 - x2 / 110)))));
  const c = cosSign * (1 - (x2 / 2) * (1 - (x2 / 12) * (1 - (x2 / 30) * (1 - (x2 / 56) * (1 - x2 / 90)))));
  const l = Math.sqrt(s * s + c * c);
  return { c: c / l, s: s / l };
}

/** Angle of a rotation, for display only (not used by the simulation). */
export const angleOf = (q: Rot) => Math.atan2(q.s, q.c);

export interface Transform {
  p: V;
  q: Rot;
}
export const xf = (t: Transform, a: V): V => add(rotate(t.q, a), t.p);
export const invXf = (t: Transform, a: V): V => invRotate(t.q, sub(a, t.p));

export interface AABB {
  lo: V;
  hi: V;
}
export const overlaps = (a: AABB, b: AABB) => !(a.hi.x < b.lo.x || b.hi.x < a.lo.x || a.hi.y < b.lo.y || b.hi.y < a.lo.y);
