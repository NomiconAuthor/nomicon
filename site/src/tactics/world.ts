/**
 * The tactics lab's world: a 2.5D grid. Each cell is one metre square and has a
 * kind, which fixes its height and whether you can walk on it and see through it.
 *
 *   ground    walkable, height 0
 *   low wall  blocks movement; 1 m high, so it hides a crouching unit but not a standing one
 *   building  blocks movement and sight; 4 m high
 *   ravine    a drop you can't cross on foot (here), but can see and loose arrows across
 *   water     the same, at ground level
 *
 * Map generators are shared with the pathing lab, so maps feel the same: their walls
 * become buildings, water stays water, mud becomes ravine, and a few presets add
 * low walls and ravines of their own.
 */
import { PRESETS as PATH_PRESETS } from '../lab/world/presets';
import { makeRng, randInt } from '../lab/core/rng';

export const GROUND = 0;
export const LOW = 1;
export const BUILDING = 2;
export const RAVINE = 3;
export const WATER = 4;

export interface Kind {
  id: number;
  name: string;
  height: number;
  walk: boolean;
  colour: string;
  note: string;
}
export const KINDS: Kind[] = [
  { id: GROUND, name: 'Ground', height: 0, walk: true, colour: '--floor', note: 'walkable' },
  { id: LOW, name: 'Low wall', height: 1, walk: false, colour: '--t-road', note: '1 m: hides a crouching unit' },
  { id: BUILDING, name: 'Building', height: 4, walk: false, colour: '--wall', note: '4 m: blocks sight' },
  { id: RAVINE, name: 'Ravine', height: -1.5, walk: false, colour: '--t-mud', note: "can't cross, can see across" },
  { id: WATER, name: 'Water', height: 0, walk: false, colour: '--t-water', note: "can't cross, can see across" },
];

/** Eye and body heights used for line of sight. */
export const EYE = 1.7;
export const STANDING = 1.5;
export const CROUCHED = 0.8;

export interface P {
  x: number;
  y: number;
}

export interface TWorld {
  w: number;
  h: number;
  kind: Uint8Array;
  /** Cells the preset marks as a thin gap, to check whether a method found it. */
  thin: Uint8Array;
  unit: P;
  threats: P[];
  version: number;
  /** Heights of moving obstacles (wagons) on top of the static map; 0 where there are none. */
  dyn: Float32Array;
  dynVersion: number;
}

let ver = 0;
export const bump = (w: TWorld) => (w.version = ++ver);

export function makeWorld(w: number, h: number): TWorld {
  return { w, h, kind: new Uint8Array(w * h), thin: new Uint8Array(w * h), unit: { x: 2, y: 2 }, threats: [], version: ++ver, dyn: new Float32Array(w * h), dynVersion: 0 };
}

export const walkable = (w: TWorld, i: number) => KINDS[w.kind[i]].walk;
export const heightAt = (w: TWorld, i: number) => KINDS[w.kind[i]].height;
export function inside(w: TWorld, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < w.w && y < w.h;
}

/**
 * Line of sight over the height grid, from an eye at (a, eyeZ) to a point at (b, targetZ),
 * both standing on ground. Walks the cells the segment crosses (exact grid traversal) and
 * fails if any cell in between is taller than the line at that point. Returns the number
 * of cells visited too, as the cost of the test.
 */
export function los(w: TWorld, ax: number, ay: number, bx: number, by: number, eyeZ = EYE, targetZ = STANDING): { clear: boolean; steps: number } {
  const x0 = ax + 0.5;
  const y0 = ay + 0.5;
  const x1 = bx + 0.5;
  const y1 = by + 0.5;
  const dx = x1 - x0;
  const dy = y1 - y0;
  let cx = ax;
  let cy = ay;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tx = dx > 0 ? (cx + 1 - x0) * tdx : dx < 0 ? (x0 - cx) * tdx : Infinity;
  let ty = dy > 0 ? (cy + 1 - y0) * tdy : dy < 0 ? (y0 - cy) * tdy : Infinity;
  let steps = 0;
  for (;;) {
    // Step to the next cell along the segment; t is how far along we are at its entry.
    let t: number;
    if (tx < ty) {
      t = tx;
      tx += tdx;
      cx += sx;
    } else {
      t = ty;
      ty += tdy;
      cy += sy;
    }
    if (cx === bx && cy === by) return { clear: true, steps };
    if (t >= 1) return { clear: true, steps };
    steps++;
    // Compare against the line's lowest point in this cell: the lower of its entry and exit
    // heights (after the step, min(tx, ty) is where it leaves the cell). Exact for this model.
    const z = Math.min(eyeZ + (targetZ - eyeZ) * t, eyeZ + (targetZ - eyeZ) * Math.min(tx, ty, 1));
    const ci = cy * w.w + cx;
    if (Math.max(KINDS[w.kind[ci]].height, w.dyn[ci]) > z) return { clear: false, steps };
  }
}

// ---------------------------------------------------------------------------
// Maps

export interface TPreset {
  id: string;
  name: string;
  build(w: number, h: number, seed: number): TWorld;
}

function fromPathPreset(id: string, w: number, h: number, seed: number): TWorld {
  const p = PATH_PRESETS.find((x) => x.id === id)!;
  const src = p.build(w, h, seed);
  const l = src.layers[0];
  const out = makeWorld(l.w, l.h);
  for (let i = 0; i < l.w * l.h; i++) out.kind[i] = l.blocked[i] ? BUILDING : l.terrain[i] === 4 ? WATER : GROUND;
  out.unit = { x: src.start.x, y: src.start.y };
  out.threats = [{ x: src.goal.x, y: src.goal.y }];
  return out;
}

function fill(t: TWorld, x0: number, y0: number, x1: number, y1: number, k: number): void {
  for (let y = Math.max(0, y0); y <= Math.min(t.h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(t.w - 1, x1); x++) t.kind[y * t.w + x] = k;
}

/** Scatter short low walls (garden walls, sandbags, hedges) on open ground. */
function lowWalls(t: TWorld, rng: () => number, n: number): void {
  for (let k = 0; k < n; k++) {
    const x = randInt(rng, 2, t.w - 3);
    const y = randInt(rng, 2, t.h - 3);
    const len = randInt(rng, 3, 8);
    const horiz = rng() < 0.5;
    for (let i = 0; i < len; i++) {
      const cx = horiz ? x + i : x;
      const cy = horiz ? y : y + i;
      if (inside(t, cx, cy) && t.kind[cy * t.w + cx] === GROUND) t.kind[cy * t.w + cx] = LOW;
    }
  }
}

function nearestFree(t: TWorld, x0: number, y0: number): P {
  for (let r = 0; r < Math.max(t.w, t.h); r++)
    for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) if (inside(t, x, y) && KINDS[t.kind[y * t.w + x]].walk) return { x, y };
  return { x: x0, y: y0 };
}

function clearAround(t: TWorld, p: P, r = 1): void {
  for (let y = p.y - r; y <= p.y + r; y++) for (let x = p.x - r; x <= p.x + r; x++) if (inside(t, x, y)) t.kind[y * t.w + x] = GROUND;
}

export const PRESETS: TPreset[] = [
  {
    id: 'town',
    name: 'Town block',
    build(w, h, seed) {
      const t = fromPathPreset('city', w, h, seed);
      lowWalls(t, makeRng(seed * 7 + 1), Math.round((w * h) / 260));
      t.unit = nearestFree(t, Math.round(w * 0.4), Math.round(h * 0.55));
      t.threats = [nearestFree(t, Math.round(w * 0.62), Math.round(h * 0.3))];
      return t;
    },
  },
  {
    id: 'ravine',
    name: 'Ravine and bridge',
    build(w, h, seed) {
      const t = makeWorld(w, h);
      const rng = makeRng(seed);
      // A ravine across the map with one narrow bridge, and a wide gap far to the side.
      const tx = Math.floor(w * 0.5);
      fill(t, tx - 1, 0, tx + 1, h - 1, RAVINE);
      const by = Math.floor(h * 0.45);
      fill(t, tx - 1, by, tx + 1, by + 1, GROUND);
      // A doorway in a wall on the left: a choke for movement *and* sight.
      const wx = Math.floor(w * 0.22);
      fill(t, wx, 0, wx, h - 1, BUILDING);
      fill(t, wx, Math.floor(h * 0.7), wx, Math.floor(h * 0.7) + 1, GROUND);
      fill(t, wx, Math.floor(h * 0.15), wx, Math.floor(h * 0.15) + 2, GROUND);
      // A few buildings on the far side.
      for (let k = 0; k < 6; k++) {
        const x = randInt(rng, tx + 6, w - 8);
        const y = randInt(rng, 2, h - 8);
        fill(t, x, y, x + randInt(rng, 2, 5), y + randInt(rng, 2, 5), BUILDING);
      }
      lowWalls(t, rng, Math.round((w * h) / 400));
      t.unit = { x: 3, y: Math.floor(h / 2) };
      t.threats = [{ x: w - 4, y: Math.floor(h / 2) }];
      clearAround(t, t.unit);
      clearAround(t, t.threats[0]);
      return t;
    },
  },
  {
    id: 'thin',
    name: 'Thin gaps',
    build(w, h, seed) {
      const t = makeWorld(w, h);
      const rng = makeRng(seed);
      // Rows of buildings separated by gaps one cell wide: good cover that's easy to miss.
      const cy = Math.floor(h / 2);
      let x = 6;
      while (x < w - 10) {
        const bw = randInt(rng, 4, 9);
        fill(t, x, cy - 6, x + bw - 1, cy - 2, BUILDING);
        fill(t, x, cy + 3, x + bw - 1, cy + 7, BUILDING);
        x += bw;
        // The gap.
        for (let y = cy - 6; y <= cy - 2; y++) t.thin[y * w + x] = 1;
        for (let y = cy + 3; y <= cy + 7; y++) t.thin[y * w + x] = 1;
        x += 1;
      }
      lowWalls(t, rng, Math.round((w * h) / 500));
      fill(t, 0, cy - 1, w - 1, cy + 2, GROUND);
      t.unit = { x: 3, y: cy };
      t.threats = [{ x: w - 4, y: 3 }];
      return t;
    },
  },
  {
    id: 'keep',
    name: 'Castle keep',
    build(w, h, seed) {
      const t = fromPathPreset('rooms', w, h, seed);
      // Tables, benches and barrels: short low walls inside the halls.
      lowWalls(t, makeRng(seed * 3 + 5), Math.round((w * h) / 220));
      clearAround(t, t.unit);
      for (const q of t.threats) clearAround(t, q);
      return t;
    },
  },
  {
    id: 'country',
    name: 'Countryside',
    build(w, h, seed) {
      const t = fromPathPreset('country', w, h, seed);
      const rng = makeRng(seed * 11 + 3);
      // Hedgerows: long low walls along field edges, with gaps.
      for (let k = 0; k < 6; k++) {
        const horiz = rng() < 0.5;
        const at = horiz ? randInt(rng, 4, h - 5) : randInt(rng, 4, w - 5);
        const n = horiz ? w : h;
        for (let i = 0; i < n; i++) {
          if (rng() < 0.08) i += randInt(rng, 2, 4);
          const x = horiz ? i : at;
          const y = horiz ? at : i;
          if (inside(t, x, y) && t.kind[y * w + x] === GROUND) t.kind[y * w + x] = LOW;
        }
      }
      // A farmhouse or two.
      for (let k = 0; k < 2; k++) {
        const x = randInt(rng, 5, w - 12);
        const y = randInt(rng, 5, h - 10);
        fill(t, x, y, x + 5, y + 3, BUILDING);
      }
      clearAround(t, t.unit);
      for (const q of t.threats) clearAround(t, q);
      return t;
    },
  },
  {
    id: 'caves',
    name: 'Caves',
    build(w, h, seed) {
      return fromPathPreset('caves', w, h, seed);
    },
  },
  {
    id: 'empty',
    name: 'Empty',
    build(w, h) {
      const t = makeWorld(w, h);
      t.unit = { x: 3, y: Math.floor(h / 2) };
      t.threats = [{ x: w - 4, y: Math.floor(h / 2) }];
      return t;
    },
  },
];

export const SIZES: Record<string, [number, number]> = { small: [64, 40], medium: [96, 60], large: [144, 90] };
