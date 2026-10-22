/**
 * Influence and threat maps on the tactics lab's 2.5D grid.
 *
 * - Influence: each unit spreads a value that falls off with distance, summed per side. Either by
 *   straight-line distance (cheap, ignores walls) or by walking distance (a flood through walkable
 *   cells, so influence goes round buildings rather than through them).
 * - Control is the knights' influence minus the goblins' (the front line is where it crosses zero);
 *   tension is the two added.
 * - Threat to the knights: every cell a goblin archer could hit, i.e. within bow range and in its line of
 *   sight, weighted by distance and by how sure we are where that unit is. A unit last seen a while
 *   ago could be anywhere it could have walked since, so its threat is spread over those places and
 *   faded by the age of the sighting.
 * - A route that weighs threat: Dijkstra with each step's cost multiplied by (1 + k × threat).
 *
 * Pure and deterministic, so the lesson's numbers are checked in test/lesson-claims.ts.
 */
import { EYE, KINDS, PRESETS, STANDING, inside, los, type P, type TWorld } from '../tactics/world';
import { dijkstra } from '../tactics/analysis';

export type Side = 'knights' | 'goblins';
export interface Unit {
  x: number;
  y: number;
  side: Side;
  /** Seconds since this unit was last seen (0 = in sight now). Knights are always known. */
  age: number;
}
export type Spread = 'radius' | 'flood';

export const INFLUENCE_RADIUS = 28; // m
export const WEAPON_RANGE = 36; // m
export const MOVE_SPEED = 1.5; // m/s an unseen enemy is assumed to cover
export const MEMORY = 30; // s: confidence in a sighting falls to 1/e after this long

export interface Scene {
  t: TWorld;
  units: Unit[];
  start: P;
  goal: P;
}

const walk = (t: TWorld, i: number) => KINDS[t.kind[i]].walk;

function nearestFree(t: TWorld, x0: number, y0: number): P {
  for (let r = 0; r < Math.max(t.w, t.h); r++)
    for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) if (inside(t, x, y) && walk(t, y * t.w + x)) return { x, y };
  return { x: x0, y: y0 };
}

/** A town, the knights holding the west, the goblins the east; two goblins in sight, four seen earlier. The knights want to reach a point in the south of the contested middle. */
export function makeScene(seed = 6, age = 10): Scene {
  const t = PRESETS.find((p) => p.id === 'town')!.build(96, 60, seed);
  const at = (fx: number, fy: number) => nearestFree(t, Math.round(fx * t.w), Math.round(fy * t.h));
  const units: Unit[] = [
    ...[
      [0.12, 0.2],
      [0.18, 0.45],
      [0.1, 0.62],
      [0.22, 0.8],
      [0.28, 0.3],
      [0.3, 0.58],
    ].map(([x, y]) => ({ ...at(x, y), side: 'knights' as Side, age: 0 })),
    ...[
      [0.72, 0.25],
      [0.66, 0.6],
    ].map(([x, y]) => ({ ...at(x, y), side: 'goblins' as Side, age: 0 })),
    ...[
      [0.82, 0.12],
      [0.86, 0.45],
      [0.78, 0.78],
      [0.6, 0.85],
    ].map(([x, y]) => ({ ...at(x, y), side: 'goblins' as Side, age })),
  ];
  return { t, units, start: at(0.06, 0.4), goal: at(0.5, 0.9) };
}

/** How sure we are a unit is still around, from the age of the sighting. */
export const confidence = (age: number) => Math.exp(-age / MEMORY);

/** Distance from (x, y) to every cell: straight line, or walking distance up to `reach`. */
function distances(t: TWorld, x: number, y: number, spread: Spread, reach: number): Float32Array {
  if (spread === 'flood') return dijkstra(t, y * t.w + x, reach).dist;
  const d = new Float32Array(t.w * t.h).fill(Infinity);
  const r = Math.ceil(reach);
  for (let cy = Math.max(0, y - r); cy <= Math.min(t.h - 1, y + r); cy++)
    for (let cx = Math.max(0, x - r); cx <= Math.min(t.w - 1, x + r); cx++) {
      const i = cy * t.w + cx;
      if (!walk(t, i)) continue;
      d[i] = Math.hypot(cx - x, cy - y);
    }
  return d;
}

/** One side's influence: each unit adds (1 − d / R) × confidence to every cell within R. */
export function influence(t: TWorld, units: Unit[], side: Side, spread: Spread, R = INFLUENCE_RADIUS): Float32Array {
  const out = new Float32Array(t.w * t.h);
  for (const u of units) {
    if (u.side !== side) continue;
    const c = confidence(u.age);
    const d = distances(t, u.x, u.y, spread, R);
    for (let i = 0; i < d.length; i++) if (d[i] < R) out[i] += c * (1 - d[i] / R);
  }
  return out;
}

/** Cells an unseen unit could have reached since it was seen: up to `count` of them, spread out. */
export function possiblePositions(t: TWorld, u: Unit, count = 12): P[] {
  if (u.age <= 0) return [{ x: u.x, y: u.y }];
  const reach = u.age * MOVE_SPEED;
  const d = dijkstra(t, u.y * t.w + u.x, reach).dist;
  const cells: number[] = [];
  for (let i = 0; i < d.length; i++) if (d[i] <= reach) cells.push(i);
  // Deterministic and spread out: sort by angle around the last sighting, then by distance, and take every k-th.
  cells.sort((a, b) => {
    const aa = Math.atan2(Math.floor(a / t.w) - u.y, (a % t.w) - u.x);
    const bb = Math.atan2(Math.floor(b / t.w) - u.y, (b % t.w) - u.x);
    return aa - bb || d[a] - d[b];
  });
  const out: P[] = [{ x: u.x, y: u.y }];
  const step = Math.max(1, Math.floor(cells.length / (count - 1)));
  for (let k = step - 1; k < cells.length && out.length < count; k += step) out.push({ x: cells[k] % t.w, y: Math.floor(cells[k] / t.w) });
  return out;
}

export interface ThreatMap {
  threat: Float32Array;
  /** Line-of-sight tests it took. */
  rays: number;
}

/**
 * Threat to the knights: for each goblin, every walkable cell within bow range that the unit (or a
 * possible position of it) can see a standing body in, weighted by distance and confidence.
 */
export function threatMap(t: TWorld, units: Unit[], range = WEAPON_RANGE): ThreatMap {
  const threat = new Float32Array(t.w * t.h);
  let rays = 0;
  for (const u of units) {
    if (u.side !== 'goblins') continue;
    const where = possiblePositions(t, u);
    const share = confidence(u.age) / where.length;
    for (const p of where) {
      const r = Math.ceil(range);
      for (let y = Math.max(0, p.y - r); y <= Math.min(t.h - 1, p.y + r); y++)
        for (let x = Math.max(0, p.x - r); x <= Math.min(t.w - 1, p.x + r); x++) {
          const i = y * t.w + x;
          if (!walk(t, i)) continue;
          const d = Math.hypot(x - p.x, y - p.y);
          if (d > range) continue;
          rays++;
          if (!los(t, p.x, p.y, x, y, EYE, STANDING).clear) continue;
          threat[i] += share * (1 - 0.6 * (d / range));
        }
    }
  }
  return { threat, rays };
}

export interface Route {
  path: number[];
  /** Metres walked. */
  length: number;
  /** Metres walked through cells some known or possible enemy can see. */
  exposed: number;
  /** Threat summed along the route, per metre: how dangerous the walk is overall. */
  danger: number;
}

/** Cheapest route where each metre costs (1 + k × threat). k = 0 is the shortest route. */
export function route(t: TWorld, from: P, to: P, threat: Float32Array, k: number): Route {
  const n = t.w * t.h;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const s = from.y * t.w + from.x;
  const g = to.y * t.w + to.x;
  dist[s] = 0;
  // A binary heap of [cost, cell].
  const heap: Array<[number, number]> = [[0, s]];
  const push = (c: number, i: number) => {
    heap.push([c, i]);
    let j = heap.length - 1;
    while (j > 0) {
      const p = (j - 1) >> 1;
      if (heap[p][0] <= heap[j][0]) break;
      [heap[p], heap[j]] = [heap[j], heap[p]];
      j = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let j = 0;
      for (;;) {
        const a = 2 * j + 1;
        const b = a + 1;
        let m = j;
        if (a < heap.length && heap[a][0] < heap[m][0]) m = a;
        if (b < heap.length && heap[b][0] < heap[m][0]) m = b;
        if (m === j) break;
        [heap[m], heap[j]] = [heap[j], heap[m]];
        j = m;
      }
    }
    return top;
  };
  const N8: Array<[number, number, number]> = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];
  while (heap.length) {
    const [c, i] = pop();
    if (c > dist[i]) continue;
    if (i === g) break;
    const x = i % t.w;
    const y = (i - x) / t.w;
    for (const [dx, dy, len] of N8) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(t, nx, ny)) continue;
      const j = ny * t.w + nx;
      if (!walk(t, j)) continue;
      if (dx && dy && (!walk(t, y * t.w + nx) || !walk(t, ny * t.w + x))) continue;
      const nc = c + len * (1 + k * threat[j]);
      if (nc < dist[j]) {
        dist[j] = nc;
        prev[j] = i;
        push(nc, j);
      }
    }
  }
  const path: number[] = [];
  for (let i = g; i >= 0; i = prev[i]) {
    path.push(i);
    if (i === s) break;
  }
  path.reverse();
  let length = 0;
  let exposed = 0;
  let danger = 0;
  for (let q = 1; q < path.length; q++) {
    const a = path[q - 1];
    const b = path[q];
    const len = Math.hypot((a % t.w) - (b % t.w), Math.floor(a / t.w) - Math.floor(b / t.w));
    length += len;
    if (threat[b] > 0.02) exposed += len;
    danger += len * threat[b];
  }
  return { path, length, exposed, danger };
}
