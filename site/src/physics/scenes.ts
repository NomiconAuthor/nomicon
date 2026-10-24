/** Scenes for the physics lessons. Each builds into a fresh World; positions in metres, y up. */
import { type V, makeRot, v } from './math';
import { box, circle, polygon } from './collide';
import { type BodyHandle, type Settings, World } from './world';

export interface Scene {
  world: World;
  /** World rectangle to show: [minX, minY, maxX, maxY]. */
  view: [number, number, number, number];
  ground: BodyHandle;
  /** Named bodies a widget or claim cares about. */
  named: Record<string, BodyHandle>;
}

function ground(w: World, width = 40, y = 0): BodyHandle {
  return w.createBody({ type: 'static', shape: box(width / 2, 0.5), position: v(0, y - 0.5), friction: 0.6 });
}

/** A seeded generator so scenes with scattered shapes are the same every time. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pyramid(settings: Partial<Settings> = {}, rows = 10, size = 0.5): Scene {
  const w = new World(settings);
  const g = ground(w);
  const h = size / 2;
  for (let r = 0; r < rows; r++) {
    const n = rows - r;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * size * 1.0;
      w.createBody({ shape: box(h, h), position: v(x, h + r * size), tag: r % 6 });
    }
  }
  return { world: w, view: [-rows * size * 0.9, -0.6, rows * size * 0.9, rows * size * 1.25], ground: g, named: {} };
}

export function tower(settings: Partial<Settings> = {}, height = 12, size = 0.5): Scene {
  const w = new World(settings);
  const g = ground(w);
  const h = size / 2;
  for (let i = 0; i < height; i++) w.createBody({ shape: box(h, h), position: v(0, h + i * size), tag: i % 6 });
  return { world: w, view: [-height * size * 0.55, -0.6, height * size * 0.55, height * size * 1.15], ground: g, named: {} };
}

/** Mixed shapes dropped into a bin: boxes, circles and polygons. */
export function bin(settings: Partial<Settings> = {}, count = 60, seed = 3): Scene {
  const w = new World(settings);
  const g = ground(w, 12);
  w.createBody({ type: 'static', shape: box(0.25, 4), position: v(-6.25, 3.5) });
  w.createBody({ type: 'static', shape: box(0.25, 4), position: v(6.25, 3.5) });
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const x = -5 + r() * 10;
    const y = 2 + i * 0.35;
    const k = i % 3;
    if (k === 0) w.createBody({ shape: box(0.2 + r() * 0.2, 0.2 + r() * 0.2), position: v(x, y), angle: r() * 3, tag: i % 6 });
    else if (k === 1) w.createBody({ shape: circle(0.2 + r() * 0.15), position: v(x, y), tag: i % 6 });
    else {
      const pts: V[] = [];
      const sides = 3 + Math.floor(r() * 4);
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * 6.283185307179586 + r() * 0.4;
        const rad = 0.22 + r() * 0.12;
        const q = makeRot(a);
        pts.push(v(rad * q.c, rad * q.s));
      }
      const p = polygon(pts);
      w.createBody({ shape: p.shape, position: v(x, y), tag: i % 6 });
    }
  }
  return { world: w, view: [-7, -0.6, 7, 9], ground: g, named: {} };
}

/** A fast ball fired at a thin wall: the tunnelling demo. */
export function tunnel(settings: Partial<Settings> = {}, speed = 120): Scene {
  const w = new World({ ...settings, gravity: v(0, 0) });
  const g = w.createBody({ type: 'static', shape: box(10, 0.25), position: v(0, -2.25) });
  const wall = w.createBody({ type: 'static', shape: box(0.05, 2), position: v(4, 0) });
  const ball = w.createBody({ shape: circle(0.15), position: v(-6, 0), velocity: v(speed, 0), restitution: 0.3, bullet: true, tag: 2 });
  return { world: w, view: [-7, -2.6, 7, 2.6], ground: g, named: { wall, ball } };
}

/** A chain bridge across a gap, with a few boxes to drop on it. */
export function bridge(settings: Partial<Settings> = {}, links = 20): Scene {
  const w = new World(settings);
  const g = ground(w, 30, -3);
  const left = w.createBody({ type: 'static', shape: box(1, 1.5), position: v(-6, -1.5) });
  const right = w.createBody({ type: 'static', shape: box(1, 1.5), position: v(6, -1.5) });
  const span = 10;
  const lw = span / links;
  let prev = left;
  for (let i = 0; i < links; i++) {
    const x = -5 + lw * (i + 0.5);
    const b = w.createBody({ shape: box(lw / 2, 0.08), position: v(x, 0), density: 2, tag: 3 });
    w.revolute(prev, b, v(-5 + lw * i, 0));
    prev = b;
  }
  w.revolute(prev, right, v(5, 0));
  for (let i = 0; i < 4; i++) w.createBody({ shape: box(0.35, 0.35), position: v(-2 + i * 1.3, 2 + i * 0.6), tag: i });
  return { world: w, view: [-7.5, -3.6, 7.5, 4], ground: g, named: {} };
}

/** A hanging chain, a rope, a spring and a motor: one of each joint. */
export function joints(settings: Partial<Settings> = {}): Scene {
  const w = new World(settings);
  const g = ground(w, 30, -4);
  const anchor = w.createBody({ type: 'static', shape: box(7, 0.1), position: v(0, 4.1) });
  // A chain of revolute-jointed links.
  let prev = anchor;
  for (let i = 0; i < 8; i++) {
    const b = w.createBody({ shape: box(0.08, 0.25), position: v(-5, 3.75 - i * 0.5), tag: 0 });
    w.revolute(prev, b, v(-5, 4 - i * 0.5));
    prev = b;
  }
  // A rope (distance joint with only a maximum length).
  const r = w.createBody({ shape: circle(0.35), position: v(-2, 1), tag: 1 });
  w.distance(anchor, r, v(-2, 4), v(-2, 1), { minLength: 0, maxLength: 3 });
  // A soft spring.
  const s = w.createBody({ shape: box(0.4, 0.4), position: v(1, 1.5), tag: 2 });
  w.distance(anchor, s, v(1, 4), v(1, 1.9), { hertz: 1.5, damping: 0.1, minLength: 0, maxLength: Infinity, length: 2.1 });
  // A motorised wheel on a revolute joint.
  const hub = w.createBody({ type: 'static', shape: circle(0.05), position: v(4.5, 1) });
  const wheel = w.createBody({ shape: box(1.2, 0.12), position: v(4.5, 1), density: 2, tag: 4 });
  w.revolute(hub, wheel, v(4.5, 1), { motorSpeed: 1.5, maxMotorTorque: 400 });
  return { world: w, view: [-6.5, -4.5, 6.5, 4.6], ground: g, named: { rope: r, spring: s, wheel } };
}

/** Lots of small bodies spread out, for the broadphase lesson. */
export function crowd(settings: Partial<Settings> = {}, count = 150, seed = 7): Scene {
  const w = new World({ ...settings, gravity: v(0, 0) });
  const g = w.createBody({ type: 'static', shape: box(12, 0.3), position: v(0, -7.3) });
  w.createBody({ type: 'static', shape: box(12, 0.3), position: v(0, 7.3) });
  w.createBody({ type: 'static', shape: box(0.3, 7), position: v(-12.3, 0) });
  w.createBody({ type: 'static', shape: box(0.3, 7), position: v(12.3, 0) });
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const p = v(-11 + r() * 22, -6 + r() * 12);
    const vel = v((r() - 0.5) * 6, (r() - 0.5) * 6);
    const layer = i % 3 === 0 ? 2 : 1;
    if (i % 2) w.createBody({ shape: circle(0.18 + r() * 0.12), position: p, velocity: vel, restitution: 1, friction: 0, tag: layer === 2 ? 5 : 1, category: layer, awake: true });
    else w.createBody({ shape: box(0.18 + r() * 0.1, 0.18 + r() * 0.1), position: p, velocity: vel, angle: r() * 3, restitution: 1, friction: 0, tag: layer === 2 ? 5 : 1, category: layer, awake: true });
  }
  return { world: w, view: [-12.8, -7.8, 12.8, 7.8], ground: g, named: {} };
}
