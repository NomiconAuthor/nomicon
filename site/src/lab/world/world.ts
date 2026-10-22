/**
 * The editable world.
 *
 * Stage 1 uses a single 2D layer, but the model is already a list of layers so
 * a later "layered grid" stage (tunnels, building floors, underpasses) can add
 * more layers plus links between them without changing the search code: every
 * search works on integer node ids through a SearchSpace, never on (x, y).
 */

export interface Terrain {
  id: number;
  name: string;
  /** Cost multiplier per unit of distance travelled across this terrain. */
  cost: number;
  /** CSS custom property used to colour it on the map. */
  color: string;
}

/** Terrain id 0 is plain ground. Road is cheaper than plain on purpose: it shows how
 *  a sub-1 cost weakens the heuristic (see the field guide, "Graph search"). */
export const TERRAINS: Terrain[] = [
  { id: 0, name: 'Plain', cost: 1, color: '--floor' },
  { id: 1, name: 'Road', cost: 0.5, color: '--t-road' },
  { id: 2, name: 'Rough', cost: 2, color: '--t-rough' },
  { id: 3, name: 'Mud', cost: 4, color: '--t-mud' },
  { id: 4, name: 'Water', cost: 8, color: '--t-water' },
];

export interface GridLayer {
  w: number;
  h: number;
  /** 1 = solid (wall / building / cliff), 0 = open. */
  blocked: Uint8Array;
  /** Index into TERRAINS for each open cell. */
  terrain: Uint8Array;
}

export interface Cell {
  layer: number;
  x: number;
  y: number;
  /** Facing in degrees (0 = east, 90 = south, as y grows downward). Only vehicles use it;
   *  unset means "face along the straight line from start to goal". */
  heading?: number;
}

/** A link between two cells that isn't a plain step (stairs, ladder, tunnel mouth).
 *  Unused in stage 1; reserved for the layered stage. */
export interface Link {
  a: Cell;
  b: Cell;
  cost: number;
  oneWay: boolean;
}

/** One unit's query: where it is and where it wants to go. */
export interface Agent {
  start: Cell;
  goal: Cell;
}

export interface World {
  layers: GridLayer[];
  links: Link[];
  /** Unit 1's start and goal. */
  start: Cell;
  goal: Cell;
  /** Units 2, 3, ... (planned after unit 1, in order). */
  units: Agent[];
  /** Incremented on every edit, so caches (clearance, components) know when to rebuild. */
  version: number;
}

let versionCounter = 0;
/**
 * World versions are unique across every world this page creates, so caches keyed by
 * version (clearance, reachable areas, map image) can never mistake a new map for an
 * old one that happened to have the same version number.
 */
export function nextVersion(): number {
  return ++versionCounter;
}

export function makeLayer(w: number, h: number): GridLayer {
  return { w, h, blocked: new Uint8Array(w * h), terrain: new Uint8Array(w * h) };
}

export function makeWorld(w: number, h: number): World {
  return {
    layers: [makeLayer(w, h)],
    links: [],
    start: { layer: 0, x: 1, y: 1 },
    goal: { layer: 0, x: w - 2, y: h - 2 },
    units: [],
    version: nextVersion(),
  };
}

export function cloneWorld(src: World): World {
  return {
    layers: src.layers.map((l) => ({ w: l.w, h: l.h, blocked: l.blocked.slice(), terrain: l.terrain.slice() })),
    links: src.links.map((k) => ({ ...k, a: { ...k.a }, b: { ...k.b } })),
    start: { ...src.start },
    goal: { ...src.goal },
    units: src.units.map((u) => ({ start: { ...u.start }, goal: { ...u.goal } })),
    version: src.version,
  };
}

/** Every unit in planning order, as live references (editing them edits the world). */
export function allUnits(world: World): Agent[] {
  return [{ start: world.start, goal: world.goal }, ...world.units];
}

/** True when any open cell uses a terrain whose cost isn't 1 (algorithms like JPS need uniform costs). */
export function hasTerrainCosts(world: World): boolean {
  for (const layer of world.layers) {
    for (let i = 0; i < layer.terrain.length; i++) {
      if (!layer.blocked[i] && TERRAINS[layer.terrain[i]].cost !== 1) return true;
    }
  }
  return false;
}

/** Cheapest terrain cost present on open cells; scales the heuristic so it stays admissible. */
export function minTerrainCost(world: World): number {
  let m = Infinity;
  for (const layer of world.layers) {
    for (let i = 0; i < layer.terrain.length; i++) {
      if (!layer.blocked[i]) m = Math.min(m, TERRAINS[layer.terrain[i]].cost);
    }
  }
  return m === Infinity ? 1 : m;
}

// ---------- Save / load (compact JSON with run-length encoding) ----------

interface SavedWorld {
  v: 1;
  w: number;
  h: number;
  blocked: string;
  terrain: string;
  start: Cell;
  goal: Cell;
  units?: Agent[];
}

function rle(a: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  while (i < a.length) {
    let j = i;
    while (j < a.length && a[j] === a[i]) j++;
    out.push(`${a[i]}x${j - i}`);
    i = j;
  }
  return out.join(',');
}

function unrle(s: string, n: number): Uint8Array {
  const a = new Uint8Array(n);
  let i = 0;
  for (const part of s.split(',')) {
    if (!part) continue;
    const [v, c] = part.split('x').map(Number);
    a.fill(v, i, Math.min(n, i + c));
    i += c;
  }
  return a;
}

export function serializeWorld(world: World): string {
  const l = world.layers[0];
  const saved: SavedWorld = {
    v: 1,
    w: l.w,
    h: l.h,
    blocked: rle(l.blocked),
    terrain: rle(l.terrain),
    start: world.start,
    goal: world.goal,
    units: world.units,
  };
  return JSON.stringify(saved);
}

export function deserializeWorld(json: string): World | null {
  try {
    const s = JSON.parse(json) as SavedWorld;
    if (s.v !== 1 || !(s.w > 1) || !(s.h > 1) || s.w * s.h > 400 * 400) return null;
    const world = makeWorld(s.w, s.h);
    world.layers[0].blocked = unrle(s.blocked, s.w * s.h);
    world.layers[0].terrain = unrle(s.terrain, s.w * s.h);
    const cell = (c: Cell): Cell => {
      const out: Cell = { layer: 0, x: clampI(c?.x, 0, s.w - 1), y: clampI(c?.y, 0, s.h - 1) };
      if (Number.isFinite(c?.heading)) out.heading = ((Number(c.heading) % 360) + 360) % 360;
      return out;
    };
    world.start = cell(s.start);
    world.goal = cell(s.goal);
    world.units = (Array.isArray(s.units) ? s.units : []).slice(0, 7).map((u) => ({ start: cell(u.start), goal: cell(u.goal) }));
    return world;
  } catch {
    return null;
  }
}

function clampI(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
}
