/**
 * "Overdraw and fill rate": the scene the lesson's GPU widget draws, and a CPU model that counts
 * the fragments each pass shades. No DOM, no GPU, so the claims run it in Node.
 *
 * The scene is 2D with a depth per card, drawn into a FILL_W × FILL_H target: a background card,
 * opaque cards (trunks and bushes) at different depths, and a plume of smoke particles, alpha
 * blended, depth tested against the opaque cards and not writing depth. Every coordinate is chosen
 * so no pixel centre ever lies exactly on an edge (rectangles on even integers, particle centres on
 * even integers with even half-sizes, the trimmed octagon's diagonals on quarter or half pixels),
 * so the GPU's coverage is the same as the model's simple pixel-centre test and no fill rule is
 * needed. Depths are distinct multiples of 1/2048, so they compare the same in any depth format.
 *
 * The model is the GPU's early depth test done by hand: a depth buffer, the draws in the order
 * the renderer issues them, and a count of the fragments that pass (those are the ones shaded).
 */
import { type DrawPlan, type FramePlan } from '../gpu/plan';

export const FILL_W = 480;
export const FILL_H = 270;
export const FILL_PIXELS = FILL_W * FILL_H;
/** Most particles the widget offers (the instance buffer's size). */
export const MAX_PARTICLES = 1200;

export type OpaqueOrder = 'back-to-front' | 'unsorted' | 'front-to-back';
export type ParticleShape = 'quad' | 'trimmed';

export interface FillSettings {
  particles: number;
  /** Particle size in pixels at full resolution, a multiple of 4 (each particle is scaled from it). */
  size: number;
  shape: ParticleShape;
  order: OpaqueOrder;
  prepass: boolean;
  /** Particles into a half-width, half-height buffer, composited afterwards. */
  halfRes: boolean;
  /** Loop iterations in the particle shader: changes the cost of each fragment, not how many there are. */
  cost: number;
}
export const FILL_DEFAULTS: FillSettings = { particles: 400, size: 48, shape: 'quad', order: 'unsorted', prepass: false, halfRes: false, cost: 8 };
export const SIZES = [16, 32, 48, 64, 96];
export const COSTS = [1, 8, 32, 128];

/**
 * One card: a centre, half-extents, and for octagons the cut `k` (the octagon's vertices are at
 * (±hx, ±k) and (±k, ±hy)). Rectangles have k = 0 and are drawn as quads.
 */
export interface Card {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  k: number;
  z: number;
  /** Colour index (opaque) or brightness seed (particles). */
  tone: number;
  name: string;
}

// ---------------------------------------------------------------------------------------------
// The scene

/** mulberry32: a small seeded generator, so the scene is the same everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const even = (x: number) => 2 * Math.round(x / 2);
/** Depth slot i of 2048: distinct, and exact in any depth format. */
const slot = (i: number) => (2 * i + 1) / 4096;

/** The background (farthest) and the opaque cards, in the order they were made ("unsorted"). */
export function opaqueCards(): Card[] {
  const r = rng(7);
  const used = new Set<number>();
  const depth = (lo: number, hi: number) => {
    let i: number;
    do i = Math.floor(lo + r() * (hi - lo));
    while (used.has(i));
    used.add(i);
    return slot(i);
  };
  const cards: Card[] = [];
  for (let n = 0; n < 26; n++) {
    const trunk = n % 2 === 0;
    const w = even(trunk ? 14 + r() * 18 : 50 + r() * 80);
    const h = even(trunk ? 110 + r() * 130 : 34 + r() * 46);
    const x0 = even(-20 + r() * (FILL_W + 40 - w));
    const base = even(FILL_H - 10 + r() * 30);
    const x1 = x0 + w;
    const y1 = Math.min(base, FILL_H + 20);
    const y0 = y1 - h;
    cards.push({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hx: w / 2, hy: h / 2, k: 0, z: depth(300, 1900), tone: 1 + (n % 5), name: trunk ? 'trunk' : 'bush' });
  }
  // Drawn first when unsorted, as a sky usually isn't: a full-screen card behind everything.
  cards.unshift({ cx: FILL_W / 2, cy: FILL_H / 2, hx: FILL_W / 2, hy: FILL_H / 2, k: 0, z: slot(2040), tone: 0, name: 'background' });
  return cards;
}

/** tan(π/8): a regular octagon around a circle of radius r has its corners at (±r, ±r·tan(π/8)). */
const TAN8 = 0.41421356237309503;
/** The octagon's cut for half-size r: at least r·tan(π/8), on a half pixel (so diagonals never pass through a pixel centre). */
export const octagonCut = (r: number) => Math.ceil(r * TAN8 - 0.5) + 0.5;

/** Every particle the widget can show, back to front (the order alpha blending needs), for a base size. */
export function particleCards(size: number, shape: ParticleShape, count = MAX_PARTICLES): Card[] {
  const r = rng(11);
  const ps: Card[] = [];
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const age = r();
    const a = r();
    const b = r();
    const zr = r();
    const tone = r();
    // A plume: rising from the ground left of centre, spreading and drifting as it rises.
    const y = FILL_H - 16 - age * (FILL_H - 40);
    const spread = 14 + age * 110;
    const x = FILL_W * 0.42 + age * 70 + (a + b - 1) * spread;
    // Older puffs are bigger; half-sizes stay even so they also land on whole pixels at half resolution.
    const half = Math.max(2, 2 * Math.round(((size / 2) * (0.6 + 0.8 * age)) / 2));
    const k = shape === 'trimmed' ? octagonCut(half) : 0;
    ps.push({ cx: even(x), cy: even(y), hx: half, hy: half, k, z: slot(100 + Math.floor(zr * 1800) * 1 + 0), tone, name: 'particle' });
  }
  // Depth slots must not collide with the opaque cards': nudge particles onto odd slots of their own.
  const taken = new Set(opaqueCards().map((c) => c.z));
  for (const p of ps) while (taken.has(p.z)) p.z += 1 / 2048;
  return ps.slice(0, count).sort((p, q) => q.z - p.z);
}

/** The opaque cards in the chosen order (the background is one of them). */
export function orderedOpaque(order: OpaqueOrder): Card[] {
  const cs = opaqueCards();
  if (order === 'back-to-front') return [...cs].sort((a, b) => b.z - a.z);
  if (order === 'front-to-back') return [...cs].sort((a, b) => a.z - b.z);
  return cs;
}

// ---------------------------------------------------------------------------------------------
// The CPU model: how many fragments each pass shades

/** Does this card cover the pixel centre (px + ½, py + ½)? `s` scales the card (½ for half resolution). */
function covers(c: Card, px: number, py: number, s: number): boolean {
  const dx = Math.abs(px + 0.5 - c.cx * s);
  const dy = Math.abs(py + 0.5 - c.cy * s);
  if (dx > c.hx * s || dy > c.hy * s) return false;
  return c.k === 0 || dx + dy <= (c.hx + c.k) * s;
}
/** Pixels of a w × h target this card covers, with a callback per pixel index. */
function eachPixel(c: Card, s: number, w: number, h: number, f: (p: number) => void): void {
  const x0 = Math.max(0, Math.floor((c.cx - c.hx) * s));
  const x1 = Math.min(w - 1, Math.ceil((c.cx + c.hx) * s));
  const y0 = Math.max(0, Math.floor((c.cy - c.hy) * s));
  const y1 = Math.min(h - 1, Math.ceil((c.cy + c.hy) * s));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (covers(c, x, y, s)) f(y * w + x);
}

export interface FillCounts {
  /** Depth-only fragments in the prepass (every covered pixel of every opaque card). */
  prepass: number;
  /** Opaque fragments shaded (passing the early depth test). */
  opaque: number;
  /** Fragments of the half-resolution depth downsample. */
  downsample: number;
  /** Particle fragments shaded. */
  particles: number;
  /** Particle fragments before the depth test: what the particles cover, hidden or not. */
  particlesCovered: number;
  /** Fragments of the composite pass (half resolution only). */
  composite: number;
  /** Fragments shaded in the colour passes: opaque + particles + composite (the prepass and the depth downsample, which write only depth, are left out). */
  shaded: number;
  /** Shaded fragments per pixel of the frame. */
  perPixel: number;
  /** Per-pixel shading counts at full resolution (for the claims and checks). */
  heat: Float32Array;
}

export function fillCounts(s: FillSettings): FillCounts {
  const W = FILL_W;
  const H = FILL_H;
  const depth = new Float32Array(W * H).fill(1);
  const heat = new Float32Array(W * H);
  const opaque = orderedOpaque(s.order);
  let prepass = 0;
  let shadedOpaque = 0;
  if (s.prepass) {
    for (const c of opaque)
      eachPixel(c, 1, W, H, (p) => {
        prepass++;
        if (c.z < depth[p]) depth[p] = c.z;
      });
    // Main pass with depth test "equal" and no depth writes: only the nearest card at each pixel passes.
    for (const c of opaque)
      eachPixel(c, 1, W, H, (p) => {
        if (c.z === depth[p]) {
          shadedOpaque++;
          heat[p]++;
        }
      });
  } else {
    for (const c of opaque)
      eachPixel(c, 1, W, H, (p) => {
        if (c.z < depth[p]) {
          depth[p] = c.z;
          shadedOpaque++;
          heat[p]++;
        }
      });
  }
  const ps = particleCards(s.size, s.shape, s.particles);
  let particles = 0;
  let covered = 0;
  let downsample = 0;
  let composite = 0;
  if (!s.halfRes) {
    for (const c of ps)
      eachPixel(c, 1, W, H, (p) => {
        covered++;
        if (c.z < depth[p]) {
          particles++;
          heat[p]++;
        }
      });
  } else {
    const w = W / 2;
    const h = H / 2;
    // The farthest of each 2 × 2 block (Cantlay, GPU Gems 3 ch. 23): particles are hidden only where all four were.
    const hd = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = 2 * y * W + 2 * x;
        hd[y * w + x] = Math.max(depth[i], depth[i + 1], depth[i + W], depth[i + W + 1]);
        downsample++;
      }
    const halfHeat = new Float32Array(w * h);
    for (const c of ps)
      eachPixel(c, 0.5, w, h, (p) => {
        covered++;
        if (c.z < hd[p]) {
          particles++;
          halfHeat[p]++;
        }
      });
    composite = W * H;
    // Each half-resolution fragment stands for four pixels: a quarter of a shading each, plus the composite.
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) heat[y * W + x] += halfHeat[(y >> 1) * w + (x >> 1)] / 4 + 1;
  }
  const shaded = shadedOpaque + particles + composite;
  return { prepass, opaque: shadedOpaque, downsample, particles, particlesCovered: covered, composite, shaded, perPixel: shaded / (W * H), heat };
}

// ---------------------------------------------------------------------------------------------
// The frame plan the renderers walk

export const PASS = { prepass: 'depth prepass', opaque: 'opaque', downsample: 'depth downsample', particles: 'particles', composite: 'composite', present: 'present' } as const;
export type FillView = 'colour' | 'heat';

/** Index counts in the shared shape buffer: a quad is 2 triangles, the octagon 6 (a fan). */
export const QUAD_INDICES = 6;
export const OCTAGON_INDICES = 18;

export function fillPlan(s: FillSettings, view: FillView): FramePlan {
  const opaqueDraw = (pipeline: string): DrawPlan => ({ name: 'opaque cards', pipeline, indexed: true, count: QUAD_INDICES, instances: opaqueCards().length });
  const fullscreen = (name: string, pipeline: string): DrawPlan => ({ name, pipeline, indexed: false, count: 3, instances: 1 });
  const heat = view === 'heat';
  const passes: FramePlan['passes'] = [];
  if (s.prepass) passes.push({ name: PASS.prepass, target: `depth, ${FILL_W} × ${FILL_H}`, w: FILL_W, h: FILL_H, draws: [opaqueDraw('depth only')] });
  passes.push({
    name: PASS.opaque,
    target: `colour + depth, ${FILL_W} × ${FILL_H}`,
    w: FILL_W,
    h: FILL_H,
    draws: [opaqueDraw(`${heat ? 'count' : 'opaque'}${s.prepass ? ', depth equal' : ''}`)],
  });
  const pw = s.halfRes ? FILL_W / 2 : FILL_W;
  const ph = s.halfRes ? FILL_H / 2 : FILL_H;
  if (s.halfRes) passes.push({ name: PASS.downsample, target: `depth, ${pw} × ${ph}`, w: pw, h: ph, draws: [fullscreen('farthest of 2 × 2', 'downsample depth')] });
  passes.push({
    name: PASS.particles,
    target: `${s.halfRes ? 'particle buffer' : 'colour'} + depth (read only), ${pw} × ${ph}`,
    w: pw,
    h: ph,
    draws: s.particles ? [{ name: 'particles', pipeline: heat ? 'count' : s.halfRes ? 'particles, half resolution' : 'particles', indexed: true, count: s.shape === 'quad' ? QUAD_INDICES : OCTAGON_INDICES, instances: s.particles }] : [],
  });
  if (s.halfRes) passes.push({ name: PASS.composite, target: `colour, ${FILL_W} × ${FILL_H}`, w: FILL_W, h: FILL_H, draws: [fullscreen('full-screen triangle', heat ? 'count composite' : 'composite')] });
  passes.push({ name: PASS.present, target: 'the canvas', w: 0, h: 0, draws: [fullscreen('full-screen triangle', heat ? 'present heat' : 'present')] });
  return { passes };
}

/** Shading work in "loop iterations": particle fragments × iterations. Only a proxy for the cost. */
export const particleWork = (c: FillCounts, s: FillSettings) => c.particles * s.cost;
