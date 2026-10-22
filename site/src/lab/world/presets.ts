import { makeRng, randInt } from '../core/rng';
import { makeWorld, type World } from './world';

export interface Preset {
  id: string;
  name: string;
  /** Fixed size, or null to use the size picked in the UI. */
  size: [number, number] | null;
  build(w: number, h: number, seed: number): World;
}

const T_ROAD = 1;
const T_ROUGH = 2;
const T_MUD = 3;
const T_WATER = 4;

function setBlock(world: World, x: number, y: number, v = 1): void {
  const l = world.layers[0];
  if (x < 0 || y < 0 || x >= l.w || y >= l.h) return;
  l.blocked[y * l.w + x] = v;
}

function setTerrain(world: World, x: number, y: number, t: number): void {
  const l = world.layers[0];
  if (x < 0 || y < 0 || x >= l.w || y >= l.h) return;
  l.terrain[y * l.w + x] = t;
}

function rect(world: World, x0: number, y0: number, x1: number, y1: number, v = 1): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setBlock(world, x, y, v);
}

/**
 * Make sure start and goal sit on open cells, and that a 1×1 unit can get from
 * one to the other (moving in 4 directions, so every diagonal setting agrees).
 * Random maps sometimes wall one of them off; rather than show "unreachable" on
 * a fresh map, open the fewest walls that connect them (a 0-1 BFS where walls
 * cost 1 and open cells 0), which reads as a gap or a doorway.
 */
function clearEnds(world: World): World {
  for (const c of [world.start, world.goal]) setBlock(world, c.x, c.y, 0);
  const l = world.layers[0];
  const W = l.w;
  const H = l.h;
  const s = world.start.y * W + world.start.x;
  const g = world.goal.y * W + world.goal.x;
  // Flood the open cells reachable with k walls opened, then step to k + 1.
  const prev = new Int32Array(W * H).fill(-1);
  const seen = new Uint8Array(W * H);
  seen[s] = 1;
  let layer = [s];
  let walls = 0;
  while (layer.length && !seen[g]) {
    const next: number[] = [];
    const stack = layer;
    while (stack.length) {
      const c = stack.pop()!;
      const x = c % W;
      const y = (c - x) / W;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (seen[n]) continue;
        seen[n] = 1;
        prev[n] = c;
        (l.blocked[n] ? next : stack).push(n);
      }
    }
    layer = next;
    walls++;
  }
  if (seen[g] && walls > 0) for (let c = g; c !== s && c >= 0; c = prev[c]) l.blocked[c] = 0;
  return world;
}

export const PRESETS: Preset[] = [
  {
    id: 'storyboard',
    name: 'Storyboard map',
    size: [24, 16],
    build() {
      const w = makeWorld(24, 16);
      for (let y = 0; y < 16; y++) if (y !== 3 && !(y >= 10 && y <= 12)) setBlock(w, 11, y);
      for (let x = 17; x < 23; x++) {
        setBlock(w, x, 1);
        setBlock(w, x, 6);
      }
      for (let y = 1; y < 7; y++) {
        setBlock(w, 17, y);
        setBlock(w, 22, y);
      }
      setBlock(w, 17, 4, 0);
      rect(w, 4, 5, 5, 7);
      rect(w, 7, 11, 7, 13);
      rect(w, 15, 11, 16, 12);
      w.start = { layer: 0, x: 2, y: 2 };
      w.goal = { layer: 0, x: 20, y: 13 };
      return clearEnds(w);
    },
  },
  {
    id: 'empty',
    name: 'Empty',
    size: null,
    build(W, H) {
      const w = makeWorld(W, H);
      w.start = { layer: 0, x: Math.floor(W * 0.15), y: Math.floor(H / 2) };
      w.goal = { layer: 0, x: Math.floor(W * 0.85), y: Math.floor(H / 2) };
      return w;
    },
  },
  {
    id: 'ushape',
    name: 'U-shaped wall',
    size: null,
    build(W, H) {
      const w = makeWorld(W, H);
      const cx = Math.floor(W / 2);
      const top = Math.floor(H * 0.2);
      const bot = Math.floor(H * 0.8);
      const depth = Math.max(3, Math.floor(W * 0.18));
      for (let y = top; y <= bot; y++) setBlock(w, cx, y);
      for (let x = cx - depth; x <= cx; x++) {
        setBlock(w, x, top);
        setBlock(w, x, bot);
      }
      w.start = { layer: 0, x: Math.floor(W * 0.12), y: Math.floor(H / 2) };
      w.goal = { layer: 0, x: Math.floor(W * 0.88), y: Math.floor(H / 2) };
      return clearEnds(w);
    },
  },
  {
    id: 'scatter',
    name: 'Random scatter',
    size: null,
    build(W, H, seed) {
      const rng = makeRng(seed);
      const w = makeWorld(W, H);
      for (let i = 0; i < W * H; i++) if (rng() < 0.28) w.layers[0].blocked[i] = 1;
      w.start = { layer: 0, x: 1, y: 1 };
      w.goal = { layer: 0, x: W - 2, y: H - 2 };
      return clearEnds(w);
    },
  },
  {
    id: 'maze',
    name: 'Maze',
    size: null,
    build(W, H, seed) {
      const rng = makeRng(seed);
      const w = makeWorld(W, H);
      w.layers[0].blocked.fill(1);
      const cw = Math.floor((W - 1) / 2);
      const ch = Math.floor((H - 1) / 2);
      const seen = new Uint8Array(cw * ch);
      const stack: Array<[number, number]> = [[0, 0]];
      seen[0] = 1;
      setBlock(w, 1, 1, 0);
      while (stack.length) {
        const [cx, cy] = stack[stack.length - 1];
        const opts: Array<[number, number]> = [];
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as Array<[number, number]>) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && !seen[ny * cw + nx]) opts.push([nx, ny]);
        }
        if (!opts.length) {
          stack.pop();
          continue;
        }
        const [nx, ny] = opts[Math.floor(rng() * opts.length)];
        seen[ny * cw + nx] = 1;
        setBlock(w, 2 * nx + 1, 2 * ny + 1, 0);
        setBlock(w, cx + nx + 1, cy + ny + 1, 0);
        stack.push([nx, ny]);
      }
      // A few extra openings so there's more than one route.
      for (let k = 0; k < Math.floor(cw * ch * 0.06); k++) {
        const x = randInt(rng, 1, W - 2);
        const y = randInt(rng, 1, H - 2);
        if ((x + y) % 2 === 1) setBlock(w, x, y, 0);
      }
      w.start = { layer: 0, x: 1, y: 1 };
      w.goal = { layer: 0, x: 2 * (cw - 1) + 1, y: 2 * (ch - 1) + 1 };
      return clearEnds(w);
    },
  },
  {
    id: 'rooms',
    name: 'Rooms and doors',
    size: null,
    build(W, H, seed) {
      const rng = makeRng(seed);
      const w = makeWorld(W, H);
      // Split into a grid of rooms with walls; punch doors of width 1 to 3.
      const cols = Math.max(2, Math.round(W / 14));
      const rows = Math.max(2, Math.round(H / 11));
      const xs = Array.from({ length: cols + 1 }, (_, i) => Math.round((i * (W - 1)) / cols));
      const ys = Array.from({ length: rows + 1 }, (_, i) => Math.round((i * (H - 1)) / rows));
      for (const x of xs.slice(1, -1)) for (let y = 0; y < H; y++) setBlock(w, x, y);
      for (const y of ys.slice(1, -1)) for (let x = 0; x < W; x++) setBlock(w, x, y);
      const door = (horizontalWall: boolean, fixed: number, a: number, b: number) => {
        if (b - a < 4) return;
        const width = randInt(rng, 1, 3);
        const at = randInt(rng, a + 1, b - 1 - width);
        for (let k = 0; k < width; k++) {
          if (horizontalWall) setBlock(w, at + k, fixed, 0);
          else setBlock(w, fixed, at + k, 0);
        }
      };
      for (let i = 1; i < xs.length - 1; i++)
        for (let j = 0; j < ys.length - 1; j++) if (rng() < 0.8) door(false, xs[i], ys[j], ys[j + 1]);
      for (let j = 1; j < ys.length - 1; j++)
        for (let i = 0; i < xs.length - 1; i++) if (rng() < 0.8) door(true, ys[j], xs[i], xs[i + 1]);
      // Furniture.
      for (let k = 0; k < cols * rows; k++) {
        const x = randInt(rng, 2, W - 4);
        const y = randInt(rng, 2, H - 4);
        if (rng() < 0.6) rect(w, x, y, x + randInt(rng, 0, 2), y + randInt(rng, 0, 1));
      }
      w.start = { layer: 0, x: 2, y: 2 };
      w.goal = { layer: 0, x: W - 3, y: H - 3 };
      return clearEnds(w);
    },
  },
  {
    id: 'caves',
    name: 'Caves',
    size: null,
    build(W, H, seed) {
      const rng = makeRng(seed);
      const w = makeWorld(W, H);
      let a = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) a[i] = rng() < 0.45 ? 1 : 0;
      for (let step = 0; step < 4; step++) {
        const b = new Uint8Array(W * H);
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            let walls = 0;
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H || a[ny * W + nx]) walls++;
              }
            b[y * W + x] = walls >= 5 ? 1 : 0;
          }
        a = b;
      }
      w.layers[0].blocked = a;
      w.start = { layer: 0, x: Math.floor(W * 0.1), y: Math.floor(H / 2) };
      w.goal = { layer: 0, x: Math.floor(W * 0.9), y: Math.floor(H / 2) };
      // Carve small clearings at both ends.
      for (const c of [w.start, w.goal]) rect(w, c.x - 1, c.y - 1, c.x + 1, c.y + 1, 0);
      return clearEnds(w);
    },
  },
  {
    id: 'city',
    name: 'Town and countryside',
    size: null,
    build(W, H, seed) {
      const rng = makeRng(seed);
      const w = makeWorld(W, H);
      // Countryside texture first: rough ground, mud, woods.
      for (let k = 0; k < Math.round((W * H) / 400); k++) {
        const cx = randInt(rng, 0, W - 1);
        const cy = randInt(rng, 0, H - 1);
        const r = randInt(rng, 3, 10);
        const t = rng() < 0.6 ? T_ROUGH : T_MUD;
        for (let y = cy - r; y <= cy + r; y++)
          for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) setTerrain(w, x, y, t);
      }
      for (let k = 0; k < Math.round((W * H) / 900); k++) {
        const x = randInt(rng, 0, W - 6);
        const y = randInt(rng, 0, H - 6);
        rect(w, x, y, x + randInt(rng, 1, 5), y + randInt(rng, 1, 4));
      }
      // Towns: street grids of blocks, each block a building with a door or two.
      const towns = Math.max(1, Math.round((W * H) / 40000));
      for (let t = 0; t < towns; t++) {
        const tw = Math.min(W - 4, randInt(rng, 60, 140));
        const th = Math.min(H - 4, randInt(rng, 40, 90));
        const tx = randInt(rng, 2, Math.max(2, W - tw - 2));
        const ty = randInt(rng, 2, Math.max(2, H - th - 2));
        for (let y = ty; y < ty + th; y++) for (let x = tx; x < tx + tw; x++) setTerrain(w, x, y, 0);
        let y = ty;
        while (y < ty + th - 6) {
          const bh = randInt(rng, 6, 12);
          let x = tx;
          while (x < tx + tw - 6) {
            const bw = randInt(rng, 6, 14);
            const x1 = Math.min(tx + tw - 1, x + bw - 1);
            const y1 = Math.min(ty + th - 1, y + bh - 1);
            if (rng() < 0.85) {
              // Building shell with interior walls and doors.
              for (let xx = x; xx <= x1; xx++) {
                setBlock(w, xx, y);
                setBlock(w, xx, y1);
              }
              for (let yy = y; yy <= y1; yy++) {
                setBlock(w, x, yy);
                setBlock(w, x1, yy);
              }
              if (x1 - x > 6) for (let yy = y; yy <= y1; yy++) setBlock(w, x + ((x1 - x) >> 1), yy);
              const doors = [
                [randInt(rng, x + 1, x1 - 1), y],
                [randInt(rng, x + 1, x1 - 1), y1],
                [x, randInt(rng, y + 1, y1 - 1)],
                [x1, randInt(rng, y + 1, y1 - 1)],
              ];
              for (let d = 0; d < 4; d++) if (d === 0 || rng() < 0.4) setBlock(w, doors[d][0], doors[d][1], 0);
              if (x1 - x > 6) setBlock(w, x + ((x1 - x) >> 1), randInt(rng, y + 1, y1 - 1), 0);
            }
            x = x1 + 1 + randInt(rng, 2, 4);
          }
          // Street along the row.
          for (let xx = tx; xx < tx + tw; xx++) for (let s2 = 1; s2 <= 2; s2++) setTerrain(w, xx, Math.min(H - 1, y + bh + s2 - 1), T_ROAD);
          y += bh + randInt(rng, 2, 4);
        }
      }
      // A road network between towns and the map edges.
      for (let k = 0; k < Math.max(2, towns + 1); k++) {
        let x = randInt(rng, 0, W - 1);
        let y = 0;
        const vertical = rng() < 0.5;
        if (!vertical) {
          x = 0;
          y = randInt(rng, 0, H - 1);
        }
        for (let s2 = 0; s2 < (vertical ? H : W); s2++) {
          if (vertical) {
            x = Math.max(1, Math.min(W - 2, x + (rng() < 0.15 ? randInt(rng, -1, 1) : 0)));
            y = s2;
          } else {
            y = Math.max(1, Math.min(H - 2, y + (rng() < 0.15 ? randInt(rng, -1, 1) : 0)));
            x = s2;
          }
          for (let d = -1; d <= 1; d++) {
            const xx = vertical ? x + d : x;
            const yy = vertical ? y : y + d;
            setTerrain(w, xx, yy, T_ROAD);
          }
        }
      }
      w.start = { layer: 0, x: 3, y: 3 };
      w.goal = { layer: 0, x: W - 4, y: H - 4 };
      return clearEnds(w);
    },
  },
  {
    id: 'country',
    name: 'Countryside (terrain costs)',
    size: null,
    build(W, H, seed) {
      const rng = makeRng(seed);
      const w = makeWorld(W, H);
      // Rough patches and mud fields.
      for (let k = 0; k < Math.round((W * H) / 180); k++) {
        const cx = randInt(rng, 0, W - 1);
        const cy = randInt(rng, 0, H - 1);
        const r = randInt(rng, 2, 6);
        const t = rng() < 0.55 ? T_ROUGH : T_MUD;
        for (let y = cy - r; y <= cy + r; y++)
          for (let x = cx - r; x <= cx + r; x++)
            if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r * (0.6 + 0.4 * rng())) setTerrain(w, x, y, t);
      }
      // A river running top to bottom with one bridge (road).
      let rx = Math.floor(W * 0.55);
      const bridgeY = randInt(rng, Math.floor(H * 0.3), Math.floor(H * 0.7));
      for (let y = 0; y < H; y++) {
        rx += randInt(rng, -1, 1);
        rx = Math.max(3, Math.min(W - 4, rx));
        for (let x = rx - 1; x <= rx + 1; x++) setTerrain(w, x, y, y === bridgeY ? T_ROAD : T_WATER);
      }
      // A road: horizontal through the bridge, with a bend.
      for (let x = 0; x < W; x++) setTerrain(w, x, bridgeY, T_ROAD);
      const by = Math.floor(H * 0.85);
      const bx = Math.floor(W * 0.2);
      for (let y = bridgeY; y <= by; y++) setTerrain(w, bx, y, T_ROAD);
      for (let x = bx; x < W; x++) setTerrain(w, x, by, T_ROAD);
      // Woods as obstacles.
      for (let k = 0; k < Math.round((W * H) / 260); k++) {
        const x = randInt(rng, 1, W - 3);
        const y = randInt(rng, 1, H - 3);
        if (w.layers[0].terrain[y * W + x] === T_ROAD || w.layers[0].terrain[y * W + x] === T_WATER) continue;
        rect(w, x, y, x + randInt(rng, 0, 2), y + randInt(rng, 0, 2));
      }
      for (let x = 0; x < W; x++) {
        setBlock(w, x, bridgeY, 0);
        setBlock(w, x, by, 0);
      }
      w.start = { layer: 0, x: 1, y: Math.floor(H * 0.15) };
      w.goal = { layer: 0, x: W - 2, y: Math.floor(H * 0.2) };
      return clearEnds(w);
    },
  },
];

export function presetById(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
