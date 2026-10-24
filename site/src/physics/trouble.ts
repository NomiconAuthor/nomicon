/**
 * Scenes for "When physics goes wrong": four common mistakes, each with the usual fix. A scene can
 * run code before every step (to spawn bodies or drive a platform) and reports one number for the
 * lesson to quote. Used by the widget and by the lesson claims, so both see the same thing.
 */
import { box, circle } from './collide';
import { type V, makeRot, overlaps, v } from './math';
import { type BodyHandle, type Settings, World } from './world';

export type Problem = 'crush' | 'chain' | 'spawn' | 'platform';

export interface TroubleScene {
  world: World;
  view: [number, number, number, number];
  ground: BodyHandle;
  /** Runs before each step (t: seconds simulated so far). */
  before: (t: number, dt: number) => void;
  /** Worst value seen so far of the scene's symptom, in metres or m/s. */
  worst: () => number;
}

const ground = (w: World, y = 0) => w.createBody({ type: 'static', shape: box(20, 0.5), position: v(0, y - 0.5), friction: 0.6 });

/** A heavy block dropped on a light box: 2,000 times its mass, or 10 times with the fix. */
function crush(fix: boolean, set: Partial<Settings>): TroubleScene {
  const w = new World(set);
  const g = ground(w);
  const light = w.createBody({ shape: box(0.5, 0.25), position: v(0, 0.25), density: fix ? 200 : 1, tag: 1 });
  const heavy = w.createBody({ shape: box(0.5, 0.5), position: v(0, 1.2), density: 1000, tag: 6 });
  let worst = 0;
  return {
    world: w,
    view: [-3, -0.4, 3, 2.6],
    ground: g,
    before: () => {
      const L = w.get(light)!;
      const H = w.get(heavy)!;
      // How far the light box is pushed into the ground, or the heavy block into it.
      worst = Math.max(worst, 0.25 - L.xf.p.y, L.xf.p.y + 0.75 - H.xf.p.y);
    },
    worst: () => worst,
  };
}

/** A heavy weight on a chain of light links: 1,000 times a link's mass. The fix adds a rope. */
function chain(fix: boolean, set: Partial<Settings>): TroubleScene {
  const w = new World(set);
  const g = ground(w);
  const top = v(-2, 6);
  const anchor = w.createBody({ type: 'static', shape: box(0.1, 0.1), position: top });
  const n = 10;
  const L = 0.4;
  let prev = anchor;
  for (let i = 0; i < n; i++) {
    const link = w.createBody({ shape: box(L / 2, 0.05), position: v(top.x + (i + 0.5) * L, top.y), density: 5, category: 2, mask: 1, tag: 2 });
    w.revolute(prev, link, v(top.x + i * L, top.y));
    prev = link;
  }
  const end = v(top.x + n * L, top.y);
  const weight = w.createBody({ shape: circle(0.4), position: v(end.x + 0.4, end.y), density: 100, tag: 6 });
  w.revolute(prev, weight, end);
  const length = n * L + 0.4;
  if (fix) w.distance(anchor, weight, top, v(end.x + 0.4, end.y), { minLength: 0, maxLength: length });
  let worst = 0;
  return {
    world: w,
    view: [-6.5, -0.4, 4.5, 7],
    ground: g,
    before: () => {
      const p = w.get(weight)!.xf.p;
      worst = Math.max(worst, Math.hypot(p.x - top.x, p.y - top.y) - length);
    },
    worst: () => worst,
  };
}

/** Find a spot for a new box that isn't inside anything: move up until its bounding box is clear. */
export function clearSpot(w: World, p: V, half: number): V {
  const at = { ...p };
  for (let i = 0; i < 200; i++) {
    const bb = { lo: v(at.x - half, at.y - half), hi: v(at.x + half, at.y + half) };
    if (!w.live().some((b) => overlaps(b.aabb, bb))) return at;
    at.y += 0.1;
  }
  return at;
}

/** A settled stack; after a second, three more boxes are spawned where the stack already is. */
function spawn(fix: boolean, set: Partial<Settings>): TroubleScene {
  const w = new World(set);
  const g = ground(w);
  for (let i = 0; i < 5; i++) w.createBody({ shape: box(0.4, 0.4), position: v(0, 0.4 + i * 0.8), tag: i % 6 });
  let spawned = false;
  let worst = 0;
  return {
    world: w,
    view: [-5, -0.4, 5, 8.5],
    ground: g,
    before: (t) => {
      if (!spawned && t >= 1) {
        spawned = true;
        for (let i = 0; i < 3; i++) {
          const want = v(0.1, 0.6 + i * 1.2);
          w.createBody({ shape: box(0.4, 0.4), position: fix ? clearSpot(w, want, 0.41) : want, tag: 6 });
        }
      }
      for (const b of w.live()) if (b.type === 'dynamic') worst = Math.max(worst, Math.hypot(b.v.x, b.v.y));
    },
    worst: () => worst,
  };
}

/** Where the platform should be at time t (makeRot's sine rounds the same in every browser). */
const sin = (a: number) => makeRot(a).s;
const platformAt = (t: number): V => v(2 * sin(t * 1.5), 1.5 + 0.5 * sin(t * 3));

/** A crate on a moving platform; the platform is teleported (setTransform) or moved by velocity (the fix). */
function platform(fix: boolean, set: Partial<Settings>): TroubleScene {
  const w = new World(set);
  const g = ground(w);
  const p0 = platformAt(0);
  const plat = w.createBody({ type: 'kinematic', shape: box(1.5, 0.15), position: p0, friction: 0.8, tag: 2 });
  const crate = w.createBody({ shape: box(0.3, 0.3), position: v(p0.x, p0.y + 0.45), friction: 0.8, tag: 1 });
  let worst = 0;
  return {
    world: w,
    view: [-5, -0.4, 5, 3.6],
    ground: g,
    before: (t, dt) => {
      const target = platformAt(t + dt);
      if (fix) w.moveKinematic(plat, target, dt);
      else w.setTransform(plat, target);
      worst = Math.max(worst, Math.abs(w.get(crate)!.xf.p.x - w.get(plat)!.xf.p.x));
    },
    worst: () => worst,
  };
}

export function troubleScene(p: Problem, fix: boolean, set: Partial<Settings> = {}): TroubleScene {
  return p === 'crush' ? crush(fix, set) : p === 'chain' ? chain(fix, set) : p === 'spawn' ? spawn(fix, set) : platform(fix, set);
}

/** Run a scene for `seconds` at 60 Hz and return its worst symptom. */
export function runTrouble(p: Problem, fix: boolean, seconds = 6, set: Partial<Settings> = {}): number {
  const s = troubleScene(p, fix, set);
  const dt = 1 / 60;
  for (let i = 0; i < seconds * 60; i++) {
    s.before(s.world.time, dt);
    s.world.step(dt);
  }
  s.before(s.world.time, dt);
  return s.worst();
}
