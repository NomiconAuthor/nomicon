/**
 * Keeping baked cover valid when the terrain changes: tile the bake, mark the tiles a
 * change touches as dirty, rebuild only those, and swap the results in. Moving cover
 * (a wagon) isn't baked at all: it carries a template of cover points around its sides.
 */
import { coverAt, type CoverCell } from './analysis';
import { EventTrace, type Caption, type Stat } from './playback';
import { BUILDING, GROUND, LOW, RAVINE, type P, type TWorld, inside } from './world';

export const TILE = 16;

interface Colours {
  get(name: string): string;
  rgba(name: string, a: number): string;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Bake cover for the whole map (or one tile). Returns the cells scanned. */
export function bakeCover(t: TWorld, into: Map<number, CoverCell>, box: Box = { x0: 0, y0: 0, x1: t.w - 1, y1: t.h - 1 }): number {
  let n = 0;
  for (let y = box.y0; y <= box.y1; y++)
    for (let x = box.x0; x <= box.x1; x++) {
      const i = y * t.w + x;
      n++;
      const c = coverAt(t, i);
      if (c) into.set(i, c);
      else into.delete(i);
    }
  return n;
}

export function tileBox(t: TWorld, tile: number): Box {
  const tw = Math.ceil(t.w / TILE);
  const tx = tile % tw;
  const ty = Math.floor(tile / tw);
  return { x0: tx * TILE, y0: ty * TILE, x1: Math.min(t.w - 1, tx * TILE + TILE - 1), y1: Math.min(t.h - 1, ty * TILE + TILE - 1) };
}

/** Tiles overlapping a box grown by `margin` cells. */
export function dirtyTiles(t: TWorld, b: Box, margin: number): number[] {
  const tw = Math.ceil(t.w / TILE);
  const out: number[] = [];
  const x0 = Math.max(0, Math.floor((b.x0 - margin) / TILE));
  const x1 = Math.min(tw - 1, Math.floor((b.x1 + margin) / TILE));
  const y0 = Math.max(0, Math.floor((b.y0 - margin) / TILE));
  const y1 = Math.min(Math.ceil(t.h / TILE) - 1, Math.floor((b.y1 + margin) / TILE));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(y * tw + x);
  return out;
}

/** Blast a crater with a fireball: a hole you can't cross, ringed by a lip of loose earth (low cover). */
export function crater(t: TWorld, c: P, r = 2.2): Box {
  for (let y = Math.floor(c.y - r - 1); y <= c.y + r + 1; y++)
    for (let x = Math.floor(c.x - r - 1); x <= c.x + r + 1; x++) {
      if (!inside(t, x, y)) continue;
      const d = Math.hypot(x - c.x, y - c.y);
      const i = y * t.w + x;
      if (d <= r - 0.9) t.kind[i] = RAVINE;
      else if (d <= r + 0.6 && t.kind[i] === GROUND) t.kind[i] = LOW;
      else if (d <= r + 0.6 && t.kind[i] === BUILDING) t.kind[i] = LOW;
    }
  const k = Math.ceil(r + 1);
  return { x0: c.x - k, y0: c.y - k, x1: c.x + k, y1: c.y + k };
}

/** Knock down walls: buildings and low walls in a radius become rubble-strewn ground. */
export function demolish(t: TWorld, c: P, r = 2.5): Box {
  for (let y = Math.floor(c.y - r); y <= c.y + r; y++)
    for (let x = Math.floor(c.x - r); x <= c.x + r; x++) {
      if (!inside(t, x, y) || Math.hypot(x - c.x, y - c.y) > r) continue;
      const i = y * t.w + x;
      if (t.kind[i] === BUILDING || t.kind[i] === LOW) t.kind[i] = GROUND;
    }
  const k = Math.ceil(r);
  return { x0: c.x - k, y0: c.y - k, x1: c.x + k, y1: c.y + k };
}

// ---------------------------------------------------------------------------
// Wagons: cover that moves, from a template in the wagon's own frame.

export interface Wagon {
  x: number;
  y: number;
  /** Long axis horizontal (0) or vertical (1). */
  rot: 0 | 1;
}
const WAGON_W = 5;
const WAGON_H = 2;
export const WAGON_HEIGHT = 2.5;

export function wagonCells(v: Wagon): P[] {
  const w = v.rot ? WAGON_H : WAGON_W;
  const h = v.rot ? WAGON_W : WAGON_H;
  const out: P[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push({ x: v.x + x, y: v.y + y });
  return out;
}

/** The template: one cover point beside each side cell of the wagon, with the side it's on. */
export function wagonCover(t: TWorld, v: Wagon): Array<{ p: P; dir: number }> {
  const body = wagonCells(v);
  const inWagon = new Set(body.map((c) => `${c.x},${c.y}`));
  const out: Array<{ p: P; dir: number }> = [];
  const D: Array<[number, number, number]> = [
    [1, 0, 4],
    [0, 1, 8],
    [-1, 0, 1],
    [0, -1, 2],
  ];
  for (const c of body)
    for (const [dx, dy, dir] of D) {
      const p = { x: c.x + dx, y: c.y + dy };
      if (inWagon.has(`${p.x},${p.y}`) || !inside(t, p.x, p.y)) continue;
      out.push({ p, dir });
    }
  return out;
}

/** Stamp the wagon into the world's dynamic height layer (used by line of sight). */
export function stampWagon(t: TWorld, v: Wagon | null): void {
  t.dyn.fill(0);
  t.dynVersion++;
  if (!v) return;
  for (const c of wagonCells(v)) if (inside(t, c.x, c.y)) t.dyn[c.y * t.w + c.x] = WAGON_HEIGHT;
}

// ---------------------------------------------------------------------------
// The rebuild, step by step.

type Ev = { k: 'mark' } | { k: 'drop' } | { k: 'tile'; tile: number } | { k: 'swap' };

export class RebuildTrace extends EventTrace<Ev> {
  private before: Map<number, CoverCell>;
  private after: Map<number, CoverCell>;
  private phase: Ev['k'] = 'mark';
  private rebuilt = new Set<number>();
  private removed: number[] = [];
  private added: number[] = [];
  private tileCells = 0;
  private ms = { tiles: 0, full: 0 };

  constructor(
    private t: TWorld,
    private col: Colours,
    before: Map<number, CoverCell>,
    private dirty: number[],
    private change: Box,
    private changed: number,
    private what: string,
  ) {
    super();
    this.before = new Map(before);
    this.after = new Map(before);
    const t0 = performance.now();
    for (const tile of dirty) this.tileCells += bakeCover(t, this.after, tileBox(t, tile));
    this.ms.tiles = performance.now() - t0;
    const t1 = performance.now();
    bakeCover(t, new Map());
    this.ms.full = performance.now() - t1;
    for (const i of this.before.keys()) if (!this.after.has(i)) this.removed.push(i);
    for (const i of this.after.keys()) if (!this.before.has(i)) this.added.push(i);
    this.events.push({ k: 'mark' });
    this.marks.push(0);
    this.events.push({ k: 'drop' });
    this.marks.push(1);
    for (const tile of dirty) this.events.push({ k: 'tile', tile });
    this.marks.push(this.events.length - 1);
    this.events.push({ k: 'swap' });
    this.marks.push(this.events.length - 1);
  }

  /** The cover map after the rebuild, to keep as the new bake. */
  result(): Map<number, CoverCell> {
    return this.after;
  }

  protected reset(): void {
    this.phase = 'mark';
    this.rebuilt.clear();
  }
  protected apply(e: Ev): void {
    this.phase = e.k;
    if (e.k === 'tile') this.rebuilt.add(e.tile);
  }

  private tileOf(i: number): number {
    const tw = Math.ceil(this.t.w / TILE);
    return Math.floor(Math.floor(i / this.t.w) / TILE) * tw + Math.floor((i % this.t.w) / TILE);
  }

  draw(ctx: CanvasRenderingContext2D, cs: number): void {
    const t = this.t;
    const col = this.col;
    const dirty = new Set(this.dirty);
    // Which cover to show per cell: old cover outside dirty tiles, and the surviving old
    // cover inside them until each is rebuilt; new cover once a tile is rebuilt.
    const gone = new Set(this.removed);
    const show = new Map<number, { c: CoverCell; fresh: boolean }>();
    for (const [i, c] of this.before) {
      const tl = this.tileOf(i);
      if (!dirty.has(tl) || this.phase === 'mark' || (!gone.has(i) && !this.rebuilt.has(tl) && this.phase !== 'swap'))
        show.set(i, { c, fresh: false });
    }
    for (const [i, c] of this.after) {
      const tl = this.tileOf(i);
      if (dirty.has(tl) && (this.rebuilt.has(tl) || this.phase === 'swap')) show.set(i, { c, fresh: this.added.includes(i) });
    }
    for (const [, { c, fresh }] of show) drawEdges(ctx, t, cs, c, col.get(fresh ? '--good' : c.full ? '--accent' : '--walker'));
    // Removed cover, while it's being invalidated.
    if (this.phase === 'mark' || this.phase === 'drop')
      for (const i of this.removed) {
        const c = this.before.get(i)!;
        drawEdges(ctx, t, cs, c, col.rgba('--alert', this.phase === 'drop' ? 0.9 : 0.6));
      }
    // Tiles.
    for (const tile of this.dirty) {
      const b = tileBox(t, tile);
      const done = this.rebuilt.has(tile) || this.phase === 'swap';
      ctx.fillStyle = col.rgba(done ? '--good' : '--alert', done ? 0.06 : 0.1);
      ctx.fillRect(b.x0 * cs, b.y0 * cs, (b.x1 - b.x0 + 1) * cs, (b.y1 - b.y0 + 1) * cs);
      ctx.strokeStyle = col.rgba(done ? '--good' : '--alert', 0.9);
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x0 * cs + 1, b.y0 * cs + 1, (b.x1 - b.x0 + 1) * cs - 2, (b.y1 - b.y0 + 1) * cs - 2);
      ctx.lineWidth = 1;
    }
    // The change itself.
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = col.get('--ink');
    const ch = this.change;
    ctx.strokeRect(ch.x0 * cs, ch.y0 * cs, (ch.x1 - ch.x0 + 1) * cs, (ch.y1 - ch.y0 + 1) * cs);
    ctx.setLineDash([]);
  }

  caption(): Caption {
    const tilesTotal = Math.ceil(this.t.w / TILE) * Math.ceil(this.t.h / TILE);
    switch (this.phase) {
      case 'mark':
        return {
          title: '1. Mark dirty tiles.',
          text: `${this.what} changed ${this.changed} cells (dashed box). The bake is stored in ${TILE} × ${TILE} m tiles; mark every tile the change overlaps, grown by a margin of how far the analysis can see. Cover only depends on direct neighbours, so the margin is 1 m: ${this.dirty.length} of ${tilesTotal} tiles. Clearance or chokes need a margin as large as the widest open space, and exposure as large as the sight range, which is why exposure is usually recomputed lazily, near units, instead.`,
        };
      case 'drop':
        return {
          title: '2. Invalidate what the change destroyed.',
          text: `Drop the cover positions the change destroyed (red) at once; any unit that had claimed a position in these tiles must re-query. The rest of the old cover stays in use, and everything outside the dirty tiles stays valid throughout.`,
        };
      case 'tile':
        return {
          title: `3. Rebuild tile ${this.rebuilt.size} of ${this.dirty.length}.`,
          text: `Re-run the bake on just this tile (${TILE * TILE} cells, not ${this.t.w * this.t.h}). In a game this is a background job spread over a few frames, and the old tile data stays in use until the new data is ready. Detour's TileCache does exactly this for navmesh tiles when obstacles are added or removed.`,
        };
      case 'swap':
        return {
          title: '4. Swap in the new tiles.',
          text: `${this.removed.length} cover positions removed, ${this.added.length} added (green: for a crater, the lip is new low cover). The rebuild scanned ${this.tileCells.toLocaleString()} cells against ${(this.t.w * this.t.h).toLocaleString()} for a full re-bake. On a large streamed world with thousands of tiles, that difference is the whole point.`,
        };
    }
  }

  stats(): Stat[] {
    const tilesTotal = Math.ceil(this.t.w / TILE) * Math.ceil(this.t.h / TILE);
    return [
      [`${this.dirty.length} / ${tilesTotal}`, 'tiles dirtied'],
      [`${this.tileCells.toLocaleString()} / ${(this.t.w * this.t.h).toLocaleString()}`, 'cells rebuilt / full re-bake'],
      [`${this.removed.length} / ${this.added.length}`, 'cover removed / added'],
      [`${this.ms.tiles.toFixed(2)} / ${this.ms.full.toFixed(2)} ms`, 'tiles vs full re-bake, this browser'],
    ];
  }
}

export function drawEdges(ctx: CanvasRenderingContext2D, t: TWorld, cs: number, c: { i: number; dirs: number }, colour: string): void {
  const x = (c.i % t.w) * cs;
  const y = Math.floor(c.i / t.w) * cs;
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1.5, cs * 0.28);
  const o = ctx.lineWidth / 2;
  ctx.beginPath();
  if (c.dirs & 1) ((ctx.moveTo(x + cs - o, y), ctx.lineTo(x + cs - o, y + cs)));
  if (c.dirs & 2) ((ctx.moveTo(x, y + cs - o), ctx.lineTo(x + cs, y + cs - o)));
  if (c.dirs & 4) ((ctx.moveTo(x + o, y), ctx.lineTo(x + o, y + cs)));
  if (c.dirs & 8) ((ctx.moveTo(x, y + o), ctx.lineTo(x + cs, y + o)));
  ctx.stroke();
  ctx.lineWidth = 1;
}
