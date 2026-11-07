/**
 * The texture-atlas lesson's models: a fixed set of sprites, four rectangle packers (shelf, skyline,
 * guillotine, MaxRects) that place them one at a time, and a small atlas of four sprites sampled
 * the way a GPU samples (bilinear, from a box-filtered mip chain) to measure bleeding. No DOM, so
 * the claims run the same code in Node. Integer and plain arithmetic only.
 */

// ---------------------------------------------------------------------------------------------
// Sprites

export interface Sprite {
  id: number;
  w: number;
  h: number;
}

/** A small seeded generator (LCG), so the sprite set is the same everywhere. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * The sprite set: 68 sprites of the sizes a 2D game's atlas holds, from 8 px icons up to 64 px
 * characters and a few long UI pieces. Sizes are multiples of 4.
 */
export function spriteSet(count = 68, seed = 2): Sprite[] {
  const r = lcg(seed);
  const out: Sprite[] = [];
  const pick = (lo: number, hi: number) => lo + 4 * Math.floor(r() * ((hi - lo) / 4 + 1));
  for (let i = 0; i < count; i++) {
    const kind = r();
    let w: number;
    let h: number;
    if (kind < 0.45) {
      w = pick(8, 24); // icons, pickups, particles
      h = pick(8, 24);
    } else if (kind < 0.85) {
      w = pick(16, 40); // characters and props
      h = pick(24, 48);
    } else if (kind < 0.95) {
      w = pick(48, 64); // big props
      h = pick(32, 64);
    } else {
      w = pick(64, 96); // bars and banners
      h = pick(8, 16);
    }
    out.push({ id: i, w, h });
  }
  return out;
}

export const ATLAS_W = 256;

// ---------------------------------------------------------------------------------------------
// Packers. Each places one rectangle at a time in a bin W × H (y grows downwards), and exposes
// what it keeps (shelves, a skyline, free rectangles) so the widget can draw it.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Placed extends Rect {
  id: number;
  rotated: boolean;
}
export type PackerKind = 'shelf' | 'skyline' | 'guillotine' | 'maxrects';
export type Heuristic = 'bssf' | 'baf' | 'bl';
export const PACKER_LABEL: Record<PackerKind, string> = { shelf: 'Shelf', skyline: 'Skyline', guillotine: 'Guillotine', maxrects: 'MaxRects' };
export const HEURISTIC_LABEL: Record<Heuristic, string> = { bssf: 'best short side fit', baf: 'best area fit', bl: 'bottom-left' };

export interface PackSettings {
  packer: PackerKind;
  /** Used by MaxRects (and the free-rectangle choice in guillotine, which takes BSSF or BAF). */
  heuristic: Heuristic;
  rotate: boolean;
  /** Texels of padding around every sprite (so 2 × padding between neighbours). */
  padding: number;
}
export const PACK_DEFAULT: PackSettings = { packer: 'maxrects', heuristic: 'bssf', rotate: false, padding: 0 };

/** What a packer keeps between placements, for drawing. */
export interface Aux {
  shelves?: Rect[];
  skyline?: Array<{ x: number; y: number; w: number }>;
  free?: Rect[];
}

interface Packer {
  /** Place a w × h rectangle (already padded); null if it doesn't fit. */
  insert(w: number, h: number): { x: number; y: number; rotated: boolean; why: string } | null;
  aux(): Aux;
}

const contains = (a: Rect, b: Rect) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

/** Shelf, first fit: rows as tall as the first sprite placed in them; a sprite goes on the first row it fits. */
class Shelf implements Packer {
  private shelves: Array<Rect & { used: number }> = [];
  private top = 0;
  constructor(
    private W: number,
    private H: number,
    private rotate: boolean,
  ) {}
  insert(w0: number, h0: number) {
    // With rotation, lay each sprite on its long side: shorter shelves.
    const rot = this.rotate && h0 > w0;
    const w = rot ? h0 : w0;
    const h = rot ? w0 : h0;
    for (const s of this.shelves)
      if (h <= s.h && s.used + w <= this.W) {
        const x = s.used;
        s.used += w;
        return { x, y: s.y, rotated: rot, why: `fits on the shelf at y = ${s.y} (${s.h} tall); ${s.h - h} px above it are wasted` };
      }
    if (this.top + h > this.H || w > this.W) return null;
    const s = { x: 0, y: this.top, w: this.W, h, used: w };
    this.shelves.push(s);
    this.top += h;
    return { x: 0, y: s.y, rotated: rot, why: `no shelf has room: opens a new shelf ${h} px tall at y = ${s.y}` };
  }
  aux(): Aux {
    return { shelves: this.shelves.map((s) => ({ x: 0, y: s.y, w: this.W, h: s.h })) };
  }
}

/** Skyline, bottom-left: the top edge of what's placed, as horizontal segments; space under it is lost. */
class Skyline implements Packer {
  private sky: Array<{ x: number; y: number; w: number }>;
  constructor(
    private W: number,
    private H: number,
    private rotate: boolean,
  ) {
    this.sky = [{ x: 0, y: 0, w: W }];
  }
  /** Where a w × h rectangle would sit if its left edge were at segment i, or −1. */
  private fit(i: number, w: number, h: number): number {
    const x = this.sky[i].x;
    if (x + w > this.W) return -1;
    let y = 0;
    let left = w;
    for (let j = i; left > 0; j++) {
      if (j >= this.sky.length) return -1;
      y = Math.max(y, this.sky[j].y);
      if (y + h > this.H) return -1;
      left -= this.sky[j].w;
    }
    return y;
  }
  insert(w0: number, h0: number) {
    let best: { i: number; y: number; w: number; h: number; rot: boolean } | null = null;
    for (const rot of this.rotate && w0 !== h0 ? [false, true] : [false]) {
      const w = rot ? h0 : w0;
      const h = rot ? w0 : h0;
      for (let i = 0; i < this.sky.length; i++) {
        const y = this.fit(i, w, h);
        if (y < 0) continue;
        // Lowest top edge first, then the leftmost.
        if (!best || y + h < best.y + best.h || (y + h === best.y + best.h && this.sky[i].x < this.sky[best.i].x)) best = { i, y, w, h, rot };
      }
    }
    if (!best) return null;
    const x = this.sky[best.i].x;
    const { y, w, h } = best;
    // Raise the skyline under the new rectangle.
    const next: Array<{ x: number; y: number; w: number }> = [];
    for (const s of this.sky) {
      const a = s.x;
      const b = s.x + s.w;
      if (b <= x || a >= x + w) next.push(s);
      else {
        if (a < x) next.push({ x: a, y: s.y, w: x - a });
        if (b > x + w) next.push({ x: x + w, y: s.y, w: b - x - w });
      }
    }
    next.push({ x, y: y + h, w });
    next.sort((p, q) => p.x - q.x);
    this.sky = [];
    for (const s of next) {
      const last = this.sky[this.sky.length - 1];
      if (last && last.y === s.y) last.w += s.w;
      else this.sky.push({ ...s });
    }
    return { x, y, rotated: best.rot, why: `lowest top edge on the skyline: rests at y = ${y}` };
  }
  aux(): Aux {
    return { skyline: this.sky.map((s) => ({ ...s })) };
  }
}

/** Score of placing w × h in free rectangle f: lower is better (two numbers, the second breaks ties). */
function score(f: Rect, w: number, h: number, heur: Heuristic): [number, number] {
  const lw = f.w - w;
  const lh = f.h - h;
  if (heur === 'bssf') return [Math.min(lw, lh), Math.max(lw, lh)];
  if (heur === 'baf') return [f.w * f.h - w * h, Math.min(lw, lh)];
  return [f.y + h, f.x]; // bottom-left (the top-left here, since y grows downwards)
}
const scoreText = (f: Rect, w: number, h: number, heur: Heuristic) =>
  heur === 'bssf'
    ? `best short side fit: free rectangle ${f.w} × ${f.h} leaves ${f.w - w} and ${f.h - h} px, and the shorter, ${Math.min(f.w - w, f.h - h)}, is the smallest of any`
    : heur === 'baf'
      ? `best area fit: the smallest free rectangle it fits, ${f.w} × ${f.h}`
      : `bottom-left: the placement whose far edge is nearest the top, at y = ${f.y}`;

/** Guillotine: free rectangles that never overlap; each placement cuts its free rectangle in two. */
class Guillotine implements Packer {
  private free: Rect[];
  constructor(
    W: number,
    H: number,
    private rotate: boolean,
    private heur: Heuristic,
  ) {
    this.free = [{ x: 0, y: 0, w: W, h: H }];
  }
  insert(w0: number, h0: number) {
    const heur = this.heur === 'bl' ? 'baf' : this.heur;
    let best: { f: number; w: number; h: number; rot: boolean; s: [number, number] } | null = null;
    this.free.forEach((f, i) => {
      for (const rot of this.rotate && w0 !== h0 ? [false, true] : [false]) {
        const w = rot ? h0 : w0;
        const h = rot ? w0 : h0;
        if (w > f.w || h > f.h) continue;
        const s = score(f, w, h, heur);
        if (!best || s[0] < best.s[0] || (s[0] === best.s[0] && s[1] < best.s[1])) best = { f: i, w, h, rot, s };
      }
    });
    if (!best) return null;
    const b = best as { f: number; w: number; h: number; rot: boolean };
    const f = this.free[b.f];
    this.free.splice(b.f, 1);
    // Split along the shorter leftover axis: the longer leftover keeps the full side.
    const lw = f.w - b.w;
    const lh = f.h - b.h;
    const horizontal = lw <= lh;
    const right: Rect = { x: f.x + b.w, y: f.y, w: lw, h: horizontal ? b.h : f.h };
    const below: Rect = { x: f.x, y: f.y + b.h, w: horizontal ? f.w : b.w, h: lh };
    for (const r of [right, below]) if (r.w > 0 && r.h > 0) this.free.push(r);
    return { x: f.x, y: f.y, rotated: b.rot, why: `${scoreText(f, b.w, b.h, heur)}; the rest is cut ${horizontal ? 'across' : 'down'} into two` };
  }
  aux(): Aux {
    return { free: this.free.map((r) => ({ ...r })) };
  }
}

/** MaxRects: every maximal free rectangle (they overlap); placements split each one they touch. */
class MaxRects implements Packer {
  private free: Rect[];
  constructor(
    W: number,
    H: number,
    private rotate: boolean,
    private heur: Heuristic,
  ) {
    this.free = [{ x: 0, y: 0, w: W, h: H }];
  }
  insert(w0: number, h0: number) {
    let best: { f: Rect; w: number; h: number; rot: boolean; s: [number, number] } | null = null;
    for (const f of this.free)
      for (const rot of this.rotate && w0 !== h0 ? [false, true] : [false]) {
        const w = rot ? h0 : w0;
        const h = rot ? w0 : h0;
        if (w > f.w || h > f.h) continue;
        const s = score(f, w, h, this.heur);
        if (!best || s[0] < best.s[0] || (s[0] === best.s[0] && s[1] < best.s[1])) best = { f, w, h, rot, s };
      }
    if (!best) return null;
    const b = best as { f: Rect; w: number; h: number; rot: boolean };
    const used: Rect = { x: b.f.x, y: b.f.y, w: b.w, h: b.h };
    const next: Rect[] = [];
    for (const f of this.free) {
      if (used.x >= f.x + f.w || used.x + used.w <= f.x || used.y >= f.y + f.h || used.y + used.h <= f.y) {
        next.push(f);
        continue;
      }
      // Up to four maximal pieces of f around the used rectangle.
      if (used.x > f.x) next.push({ x: f.x, y: f.y, w: used.x - f.x, h: f.h });
      if (used.x + used.w < f.x + f.w) next.push({ x: used.x + used.w, y: f.y, w: f.x + f.w - used.x - used.w, h: f.h });
      if (used.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: used.y - f.y });
      if (used.y + used.h < f.y + f.h) next.push({ x: f.x, y: used.y + used.h, w: f.w, h: f.y + f.h - used.y - used.h });
    }
    // Prune: drop any free rectangle inside another (keep the first of equal ones).
    this.free = next.filter((a, i) => !next.some((c, j) => j !== i && contains(c, a) && (!contains(a, c) || j < i)));
    return { x: used.x, y: used.y, rotated: b.rot, why: scoreText(b.f, b.w, b.h, this.heur) };
  }
  aux(): Aux {
    return { free: this.free.map((r) => ({ ...r })) };
  }
}

function makePacker(s: PackSettings, W: number, H: number): Packer {
  if (s.packer === 'shelf') return new Shelf(W, H, s.rotate);
  if (s.packer === 'skyline') return new Skyline(W, H, s.rotate);
  if (s.packer === 'guillotine') return new Guillotine(W, H, s.rotate, s.heuristic);
  return new MaxRects(W, H, s.rotate, s.heuristic);
}

/** The order sprites are fed in: tallest first for shelves, biggest area first for the rest (offline packing). */
export function packOrder(sprites: Sprite[], s: PackSettings): Sprite[] {
  const key = (p: Sprite) => (s.packer === 'shelf' ? (s.rotate ? Math.min(p.w, p.h) : p.h) : p.w * p.h);
  return [...sprites].sort((a, b) => key(b) - key(a) || Math.max(b.w, b.h) - Math.max(a.w, a.h) || a.id - b.id);
}

export interface PackStep {
  placed: Placed;
  why: string;
  aux: Aux;
}
export interface PackResult {
  W: number;
  H: number;
  steps: PackStep[];
  /** Sprite pixels (without padding). */
  spriteArea: number;
}

/** Pack every sprite into W × H, or null if one doesn't fit. */
export function packInto(sprites: Sprite[], s: PackSettings, W: number, H: number): PackResult | null {
  const p = makePacker(s, W, H);
  const steps: PackStep[] = [];
  const pad = s.padding;
  let area = 0;
  for (const sp of packOrder(sprites, s)) {
    const r = p.insert(sp.w + 2 * pad, sp.h + 2 * pad);
    if (!r) return null;
    const w = r.rotated ? sp.h : sp.w;
    const h = r.rotated ? sp.w : sp.h;
    steps.push({ placed: { id: sp.id, x: r.x + pad, y: r.y + pad, w, h, rotated: r.rotated }, why: r.why, aux: p.aux() });
    area += sp.w * sp.h;
  }
  return { W, H, steps, spriteArea: area };
}

/**
 * The shortest atlas of width W that holds every sprite: tries each height from the area bound up.
 * Packers aren't monotonic in the height (a taller bin can change their choices), so it's a scan.
 */
export function packSmallest(sprites: Sprite[], s: PackSettings, W = ATLAS_W): PackResult {
  let area = 0;
  for (const sp of sprites) area += (sp.w + 2 * s.padding) * (sp.h + 2 * s.padding);
  for (let H = Math.ceil(area / W); ; H++) {
    const r = packInto(sprites, s, W, H);
    if (r) return r;
  }
}

export const nextPow2 = (n: number) => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};
/** Share of the atlas covered by sprite pixels, in percent. */
export const efficiency = (r: PackResult, H = r.H) => (100 * r.spriteArea) / (r.W * H);

/** Every packer's result at these settings, for the comparison table. */
export const PACKER_ROWS: Array<[PackerKind, Heuristic]> = [
  ['shelf', 'bssf'],
  ['skyline', 'bssf'],
  ['guillotine', 'baf'],
  ['maxrects', 'bssf'],
  ['maxrects', 'bl'],
];
export const rowLabel = (k: PackerKind, h: Heuristic) => (k === 'maxrects' ? `MaxRects, ${HEURISTIC_LABEL[h]}` : k === 'guillotine' ? `Guillotine, ${HEURISTIC_LABEL[h]}` : PACKER_LABEL[k]);

// ---------------------------------------------------------------------------------------------
// Bleeding. Four 16 × 16 sprites in a 2 × 2 grid of cells, each sprite with `padding` texels around
// it, in a power-of-two atlas. Every texel records how much of it belongs to each sprite (or to
// nothing), so sampling can say exactly how much of a sample is someone else's colour.

export const SPR = 16;
/** Owners: 0..3 are the sprites (A, B to its right, C below, D diagonal), 4 is empty (transparent). */
export const OWNERS = 5;
export const EMPTY = 4;
export type Fill = 'empty' | 'extrude';

export interface Level {
  n: number;
  /** n × n × OWNERS weights. */
  own: Float64Array;
  /** n × n brightness of the sprite pattern (0..1), weighted average of the texels below. */
  lum: Float64Array;
}
export interface BleedAtlas {
  padding: number;
  fill: Fill;
  /** Cell size (sprite plus padding on both sides). */
  cell: number;
  levels: Level[];
}

/** The brightness pattern of sprite k at texel (x, y): a frame and a diamond, so it reads as a sprite. */
function pattern(k: number, x: number, y: number): number {
  const edge = x === 0 || y === 0 || x === SPR - 1 || y === SPR - 1;
  const cx = Math.abs(2 * x + 1 - SPR);
  const cy = Math.abs(2 * y + 1 - SPR);
  if (edge) return 0.55;
  if (cx + cy <= 10 + 2 * k) return 1;
  return 0.78;
}

export function bleedAtlas(padding: number, fill: Fill): BleedAtlas {
  const cell = SPR + 2 * padding;
  const n = nextPow2(2 * cell);
  const own = new Float64Array(n * n * OWNERS);
  const lum = new Float64Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const cxi = Math.floor(x / cell);
      const cyi = Math.floor(y / cell);
      let o = EMPTY;
      let l = 0;
      if (cxi < 2 && cyi < 2) {
        const k = cyi * 2 + cxi;
        // Position inside the sprite, and whether we're in its padding.
        const sx = x - cxi * cell - padding;
        const sy = y - cyi * cell - padding;
        const inside = sx >= 0 && sy >= 0 && sx < SPR && sy < SPR;
        if (inside || fill === 'extrude') {
          o = k;
          // Extrusion copies the nearest edge texel outwards.
          l = pattern(k, Math.min(SPR - 1, Math.max(0, sx)), Math.min(SPR - 1, Math.max(0, sy)));
        }
      }
      own[i * OWNERS + o] = 1;
      lum[i] = l;
    }
  const levels: Level[] = [{ n, own, lum }];
  // A box-filtered mip chain, down to 1 × 1.
  while (levels[levels.length - 1].n > 1) {
    const src = levels[levels.length - 1];
    const m = src.n / 2;
    const o2 = new Float64Array(m * m * OWNERS);
    const l2 = new Float64Array(m * m);
    for (let y = 0; y < m; y++)
      for (let x = 0; x < m; x++) {
        const d = y * m + x;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const s = (2 * y + dy) * src.n + 2 * x + dx;
          for (let k = 0; k < OWNERS; k++) o2[d * OWNERS + k] += src.own[s * OWNERS + k] / 4;
          l2[d] += src.lum[s] / 4;
        }
      }
    levels.push({ n: m, own: o2, lum: l2 });
  }
  return { padding, fill, cell, levels };
}

export type Filter = 'bilinear' | 'nearest';

/** Sample a level at (u, v) in that level's texels (texel centres at +0.5), clamping at the atlas edge. */
export function sampleLevel(L: Level, u: number, v: number, filter: Filter): { own: number[]; lum: number } {
  const out = new Array(OWNERS).fill(0);
  let lum = 0;
  const clamp = (i: number) => Math.min(L.n - 1, Math.max(0, i));
  const add = (x: number, y: number, wgt: number) => {
    if (wgt === 0) return;
    const i = clamp(y) * L.n + clamp(x);
    for (let k = 0; k < OWNERS; k++) out[k] += wgt * L.own[i * OWNERS + k];
    lum += wgt * L.lum[i];
  };
  if (filter === 'nearest') add(Math.floor(u), Math.floor(v), 1);
  else {
    const tx = u - 0.5;
    const ty = v - 0.5;
    const x0 = Math.floor(tx);
    const y0 = Math.floor(ty);
    const fx = tx - x0;
    const fy = ty - y0;
    add(x0, y0, (1 - fx) * (1 - fy));
    add(x0 + 1, y0, fx * (1 - fy));
    add(x0, y0 + 1, (1 - fx) * fy);
    add(x0 + 1, y0 + 1, fx * fy);
  }
  return { own: out, lum };
}

/** The zoom levels the widget offers: how many screen pixels one sprite texel covers. */
export const ZOOMS = [2, 1, 0.5, 0.25, 0.125] as const;
export const zoomLabel = (z: number) => (z >= 1 ? `${z}×` : `1/${1 / z}`);
/** The mip level a GPU picks for this zoom (one texel per pixel at level k when zoom is 2^-k). */
export const levelFor = (zoom: number) => Math.max(0, Math.round(-Math.log2(zoom)));

export interface ScreenPixel {
  x: number;
  y: number;
  /** Atlas coordinates (level 0 texels) the pixel centre maps to. */
  u: number;
  v: number;
  own: number[];
  lum: number;
}

/**
 * Sprite A drawn as a quad at a zoom, its corner offset by (ox, oy) of a pixel. Pixels whose centre
 * is inside the quad sample the atlas at the mip level for that zoom.
 */
export function drawSprite(a: BleedAtlas, zoom: number, ox: number, oy: number, filter: Filter): { pixels: ScreenPixel[]; size: number; level: number } {
  const level = Math.min(levelFor(zoom), a.levels.length - 1);
  const L = a.levels[level];
  const scale = 2 ** level;
  const side = SPR * zoom;
  const size = Math.ceil(side + 1);
  const pixels: ScreenPixel[] = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5 - ox;
      const cy = y + 0.5 - oy;
      if (cx < 0 || cy < 0 || cx >= side || cy >= side) continue;
      const u = a.padding + cx / zoom;
      const v = a.padding + cy / zoom;
      const s = sampleLevel(L, u / scale, v / scale, filter);
      pixels.push({ x, y, u, v, own: s.own, lum: s.lum });
    }
  return { pixels, size, level };
}

/**
 * The largest share of a pixel's colour that comes from a neighbouring sprite, and from anything
 * that isn't sprite A (neighbours or empty texels), over a sweep of sub-pixel offsets.
 */
export function worstBleed(a: BleedAtlas, zoom: number, filter: Filter = 'bilinear', steps = 16): { neighbour: number; any: number } {
  let neighbour = 0;
  let any = 0;
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < steps; j++)
      for (const p of drawSprite(a, zoom, i / steps, j / steps, filter).pixels) {
        neighbour = Math.max(neighbour, p.own[1] + p.own[2] + p.own[3]);
        any = Math.max(any, 1 - p.own[0]);
      }
  return { neighbour, any };
}

/** Percent, as the lesson writes it: whole numbers, and "0%" only when it is exactly zero. */
export const bleedText = (x: number) => (x < 1e-12 ? '0%' : x * 100 < 1 ? '<1%' : `${Math.round(x * 100)}%`);
