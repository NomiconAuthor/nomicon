/** Small 2D vector helpers and a seeded random generator, shared by the movement widgets. */

export interface V {
  x: number;
  y: number;
}
export const v = (x = 0, y = 0): V => ({ x, y });
export const add = (a: V, b: V): V => v(a.x + b.x, a.y + b.y);
export const sub = (a: V, b: V): V => v(a.x - b.x, a.y - b.y);
export const mul = (a: V, s: number): V => v(a.x * s, a.y * s);
export const len = (a: V) => Math.hypot(a.x, a.y);
export const dot = (a: V, b: V) => a.x * b.x + a.y * b.y;
export const cross = (a: V, b: V) => a.x * b.y - a.y * b.x;
export const norm = (a: V): V => {
  const l = len(a);
  return l > 1e-9 ? v(a.x / l, a.y / l) : v();
};
export const trunc = (a: V, m: number): V => {
  const l = len(a);
  return l > m ? mul(a, m / l) : a;
};
export const fromAngle = (a: number, l = 1): V => v(Math.cos(a) * l, Math.sin(a) * l);
export const angleOf = (a: V) => Math.atan2(a.y, a.x);
/** Wrap an angle to (-π, π]. */
export const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
};

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
