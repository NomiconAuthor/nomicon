/**
 * The blending lesson's scenes, all drawn into targets with a colour buffer of inks (theme tokens):
 * three glass panes in front of a wall, drawn in different orders (sorting, depth writes, additive
 * and order-independent blending); a round sprite with transparent edges, filtered with straight
 * or premultiplied alpha; and a chain-link fence running into the distance, cut out by alpha
 * blending, alpha test or alpha to coverage. The measurements are what the lesson quotes.
 */
import { type BlendMode, type Camera, type Draw, type Frag, type Mesh, type Rgba, type Sampler, DEFAULTS, Target, Texture, basis, renderAll, resolveOit, v3 } from '../raster';
import { floor, quad } from './common';

/** One ink vector: weight 1 on ink k. */
const inkOf = (k: number, n: number): number[] => Array.from({ length: n }, (_, i) => (i === k ? 1 : 0));
/** A colour that is `b` of ink k over the background (ink 0): how a darker shade is written. */
const shadeOf = (k: number, b: number, n: number): number[] => Array.from({ length: n }, (_, i) => (i === k ? b : i === 0 ? 1 - b : 0));

/** Per pixel, the inks averaged over its samples (what a resolve produces). */
export function resolved(t: Target): Float64Array {
  const K = t.inks;
  const S = t.samples;
  const out = new Float64Array(t.w * t.h * K);
  for (let p = 0; p < t.w * t.h; p++) for (let s = 0; s < S; s++) for (let k = 0; k < K; k++) out[p * K + k] += t.color[(p * S + s) * K + k] / S;
  return out;
}
/** How many pixels differ from a reference by more than `tol` (summed over inks), and the largest difference. */
export function compare(a: Float64Array, b: Float64Array, K: number, tol = 0.02): { wrong: number; max: number } {
  let wrong = 0;
  let max = 0;
  for (let p = 0; p < a.length / K; p++) {
    let d = 0;
    for (let k = 0; k < K; k++) d += Math.abs(a[p * K + k] - b[p * K + k]);
    if (d > tol) wrong++;
    max = Math.max(max, d);
  }
  return { wrong, max };
}

// ---------------------------------------------------------------------------------------------
// Sorting: three glass panes in front of a wall.

export const SORT_W = 96;
export const SORT_H = 60;
/** Ink 0 background, 1 wall, 2 floor, then the red, yellow and blue panes. */
export const SORT_INKS = ['--bg', '--c8', '--c4', '--c3', '--c1', '--c2'];
export type PaneOrder = 'back' | 'front' | 'listed';
export type PaneBlend = 'over' | 'additive' | 'oit';
export const PANE_ALPHA = 0.5;
export const sortCamera: Camera = { eye: v3(0, 1.5, 2.5), target: v3(0, 1.3, -4), focal: 1.4, aspect: SORT_W / SORT_H, near: 0.1, far: 100, reverseZ: false };

export function sortScene(order: PaneOrder, depthWrite: boolean, mode: PaneBlend): Draw[] {
  const K = SORT_INKS.length;
  const wall: Draw = {
    name: 'wall',
    mesh: quad([v3(-16, 0, -9), v3(16, 0, -9), v3(16, 8, -9), v3(-16, 8, -9)], [[0], [0], [0], [0]]),
    color: '--c8',
    shade: () => 0.6,
    paint: () => ({ c: shadeOf(1, 0.55, K), a: 1 }),
  };
  const ground: Draw = {
    name: 'floor',
    mesh: floor(-16, 16, 4, -9, 0, 1),
    color: '--c4',
    shade: () => 0.5,
    paint: (a) => ({ c: shadeOf(2, (Math.floor(a[0]) + Math.floor(a[1])) & 1 ? 0.3 : 0.45, K), a: 1 }),
  };
  // Panes facing the camera, stepped back and sideways so that each overlaps the next.
  const pane = (name: string, ink: number, x: number, z: number): Draw => ({
    name,
    mesh: quad([v3(x - 1.4, 0.2, z), v3(x + 1.4, 0.2, z), v3(x + 1.4, 2.7, z), v3(x - 1.4, 2.7, z)], [[0], [0], [0], [0]]),
    color: SORT_INKS[ink],
    shade: () => 1,
    paint: () => ({ c: inkOf(ink, K), a: PANE_ALPHA }),
    blend: mode as BlendMode,
    depthWrite,
    twoSided: true,
  });
  const panes = [pane('red pane', 3, -1.5, -0.5), pane('yellow pane', 4, 0.3, -2.5), pane('blue pane', 5, 2.1, -4.5)];
  // Back to front is blue, yellow, red. "As listed" is the order an unsorted list might give.
  const ordered = order === 'back' ? [panes[2], panes[1], panes[0]] : order === 'front' ? panes : [panes[1], panes[0], panes[2]];
  return [wall, ground, ...ordered];
}

export function sortRun(order: PaneOrder, depthWrite: boolean, mode: PaneBlend): Target {
  const t = new Target(SORT_W, SORT_H, 1, SORT_INKS.length);
  renderAll(sortScene(order, depthWrite, mode), t, sortCamera, { ...DEFAULTS });
  if (mode === 'oit') resolveOit(t);
  return t;
}
/**
 * Against the right answer: panes sorted back to front with "over" (or, for additive, additive in
 * any order, since it doesn't depend on order).
 */
export function sortError(order: PaneOrder, depthWrite: boolean, mode: PaneBlend): { wrong: number; max: number; panes: number } {
  const K = SORT_INKS.length;
  const ref = resolved(sortRun('back', false, mode === 'additive' ? 'additive' : 'over'));
  const got = resolved(sortRun(order, depthWrite, mode));
  // Pixels any pane covers.
  let panes = 0;
  for (let p = 0; p < SORT_W * SORT_H; p++) if (ref[p * K + 3] + ref[p * K + 4] + ref[p * K + 5] > 0) panes++;
  return { ...compare(got, ref, K), panes };
}

// ---------------------------------------------------------------------------------------------
// Straight and premultiplied alpha: a round sprite with soft edges, magnified and minified.

export const EDGE_W = 80;
export const EDGE_H = 50;
/** Ink 0 the backdrop (a blue wall), 1 the sprite, 2 the white that the transparent texels hold. */
export const EDGE_INKS = ['--c7', '--c4', '--ink'];
export const SPRITE = 16;
export type AlphaKind = 'straight' | 'premultiplied';

/**
 * A disc on a 16 × 16 texture: inside, the sprite's colour at alpha 1; outside, alpha 0 and white,
 * which is what many paint programs leave in fully transparent pixels. Premultiplied, the
 * outside becomes 0 in every channel. Channels: the three inks, then alpha.
 */
export function spriteTexture(kind: AlphaKind): Texture {
  const d: number[] = [];
  for (let y = 0; y < SPRITE; y++)
    for (let x = 0; x < SPRITE; x++) {
      const dx = x + 0.5 - SPRITE / 2;
      const dy = y + 0.5 - SPRITE / 2;
      const inside = dx * dx + dy * dy <= 6.2 * 6.2;
      const c = inside ? [0, 1, 0] : [0, 0, 1];
      const a = inside ? 1 : 0;
      d.push(...(kind === 'premultiplied' ? c.map((v) => v * a) : c), a);
    }
  return new Texture(SPRITE, SPRITE, 4, d);
}

/** The edges camera: positions are pixels. */
export const edgeCamera: Camera = { eye: v3(0, 0, 0), target: v3(0, 0, 1), focal: 1, aspect: 1, near: 0, far: 1, reverseZ: false, screen: { w: EDGE_W, h: EDGE_H } };
const BILINEAR_MIPS: Sampler = { filter: 'linear', mip: 'linear', aniso: 1 };

/** A sprite drawn as a screen-space square at (x, y), `s` pixels across. */
function spriteDraw(name: string, x: number, y: number, s: number, tex: Texture, kind: AlphaKind): Draw {
  const mesh: Mesh = quad(
    [v3(x, y + s, 0.5), v3(x + s, y + s, 0.5), v3(x + s, y, 0.5), v3(x, y, 0.5)],
    [
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  );
  return {
    name,
    mesh,
    color: '--c4',
    twoSided: true,
    shade: () => 1,
    paint: (a: number[], f: Frag): Rgba => {
      const t = tex.sample(a[0], a[1], [f.dx[0], f.dx[1], f.dy[0], f.dy[1]], BILINEAR_MIPS);
      return { c: t.slice(0, 3), a: t[3] };
    },
    blend: kind === 'premultiplied' ? 'premultiplied' : 'over',
    depthWrite: false,
  };
}
export function edgeScene(kind: AlphaKind): Draw[] {
  const tex = spriteTexture(kind);
  // Magnified 3 × (a texel is 3 pixels), and minified 2 × and 4 ×.
  return [spriteDraw('big sprite', 2, 1, 48, tex, kind), spriteDraw('half-size sprite', 56, 4, 8, tex, kind), spriteDraw('quarter-size sprite', 60, 22, 4, tex, kind)];
}
export function edgeRun(kind: AlphaKind): { target: Target; maxWhite: number; whitePixels: number } {
  const t = new Target(EDGE_W, EDGE_H, 1, EDGE_INKS.length);
  renderAll(edgeScene(kind), t, edgeCamera, { ...DEFAULTS, depthTest: false, quads: true });
  const r = resolved(t);
  let maxWhite = 0;
  let whitePixels = 0;
  for (let p = 0; p < EDGE_W * EDGE_H; p++) {
    const w = r[p * 3 + 2];
    maxWhite = Math.max(maxWhite, w);
    if (w > 0.02) whitePixels++;
  }
  return { target: t, maxWhite, whitePixels };
}

// ---------------------------------------------------------------------------------------------
// Cut-outs: a chain-link fence along a road, with 4× MSAA.

export const FENCE_W = 96;
export const FENCE_H = 60;
/** Ink 0 background, 1 the ground, 2 the fence. */
export const FENCE_INKS = ['--bg', '--c8', '--c6'];
export type CutoutMode = 'blend' | 'test' | 'a2c';
export const FENCE_TEX = 32;
/** Metres per repeat of the fence texture. */
export const FENCE_REPEAT = 0.5;
/** The two fences stand this far either side of the road's centre line. */
export const FENCE_X = 1.3;
export const FENCE_LEN = 60;
export const FENCE_HEIGHT = 1.6;
export const fenceCamera: Camera = { eye: v3(0, 1.0, 2), target: v3(0, 0.7, -12), focal: 1.8, aspect: FENCE_W / FENCE_H, near: 0.1, far: 200, reverseZ: false };

/** Wire 2 texels thick every 16: alpha 1 on the wire, 0 in the holes. */
export function fenceTexture(): Texture {
  const d: number[] = [];
  for (let y = 0; y < FENCE_TEX; y++) for (let x = 0; x < FENCE_TEX; x++) d.push(x % 16 < 2 || y % 16 < 2 ? 1 : 0);
  return new Texture(FENCE_TEX, FENCE_TEX, 1, d);
}
/** The fraction of the texture that is wire. */
export function fenceCoverage(): number {
  const t = fenceTexture().levels.at(-1)!;
  return t.data[0];
}

export function fenceScene(mode: CutoutMode): Draw[] {
  const K = FENCE_INKS.length;
  const tex = fenceTexture();
  const ground: Draw = { name: 'ground', mesh: floor(-20, 20, 4, -FENCE_LEN, 0, 1), color: '--c8', shade: () => 0.4, paint: () => ({ c: shadeOf(1, 0.35, K), a: 1 }) };
  // A fence on each side of the road, running away from the camera. u along it, v up it.
  const L = FENCE_LEN / FENCE_REPEAT;
  const Hh = FENCE_HEIGHT / FENCE_REPEAT;
  const side = (x: number): Draw => ({
    name: x < 0 ? 'left fence' : 'right fence',
    mesh: quad(
      [v3(x, 0, 2), v3(x, 0, -FENCE_LEN), v3(x, FENCE_HEIGHT, -FENCE_LEN), v3(x, FENCE_HEIGHT, 2)],
      [
        [-2 / FENCE_REPEAT, Hh],
        [L, Hh],
        [L, 0],
        [-2 / FENCE_REPEAT, 0],
      ],
    ),
    color: '--c6',
    twoSided: true,
    shade: () => 1,
    paint: (a: number[], f: Frag): Rgba => ({ c: inkOf(2, K), a: tex.sample(a[0], a[1], [f.dx[0], f.dx[1], f.dy[0], f.dy[1]], BILINEAR_MIPS)[0] }),
    blend: mode === 'blend' ? 'over' : 'opaque',
    alphaTest: mode === 'test' ? 0.5 : undefined,
    alphaToCoverage: mode === 'a2c',
    depthWrite: mode !== 'blend',
  });
  return [ground, side(-FENCE_X), side(FENCE_X)];
}

/** Where the fence is on screen, by pixel: its distance along the view, or 0 where it isn't. */
let fenceDepthCache: Float64Array | null = null;
function fenceDistance(): Float64Array {
  if (fenceDepthCache) return fenceDepthCache;
  const out = new Float64Array(FENCE_W * FENCE_H);
  const b = basis(fenceCamera);
  const c = fenceCamera;
  for (let y = 0; y < FENCE_H; y++)
    for (let x = 0; x < FENCE_W; x++) {
      const nx = ((x + 0.5) / FENCE_W) * 2 - 1;
      const ny = 1 - ((y + 0.5) / FENCE_H) * 2;
      const dir = v3(b.fwd.x + (b.right.x * nx * c.aspect) / c.focal + (b.up.x * ny) / c.focal, b.fwd.y + (b.right.y * nx * c.aspect) / c.focal + (b.up.y * ny) / c.focal, b.fwd.z + (b.right.z * nx * c.aspect) / c.focal + (b.up.z * ny) / c.focal);
      if (dir.x === 0) continue;
      const t = ((dir.x < 0 ? -FENCE_X : FENCE_X) - c.eye.x) / dir.x;
      const py = c.eye.y + dir.y * t;
      const pz = c.eye.z + dir.z * t;
      if (py < 0 || py > FENCE_HEIGHT || pz < -FENCE_LEN || pz > 2) continue;
      out[y * FENCE_W + x] = c.eye.z - pz;
    }
  fenceDepthCache = out;
  return out;
}

/** Fence within this distance (m) of the camera counts as near, beyond the second as far. */
export const FENCE_NEAR = 4;
export const FENCE_FAR = 8;
/** How much of its screen area the fence covers, near and far: the average fence ink over its pixels there. */
export function fenceRun(mode: CutoutMode): { target: Target; near: number; far: number; nearPx: number; farPx: number } {
  const t = new Target(FENCE_W, FENCE_H, 4, FENCE_INKS.length);
  renderAll(fenceScene(mode), t, fenceCamera, { ...DEFAULTS, quads: true });
  const r = resolved(t);
  const dist = fenceDistance();
  let near = 0;
  let far = 0;
  let nearPx = 0;
  let farPx = 0;
  for (let p = 0; p < FENCE_W * FENCE_H; p++) {
    const z = dist[p];
    if (!z) continue;
    const w = r[p * 3 + 2];
    if (z < FENCE_NEAR) {
      near += w;
      nearPx++;
    } else if (z > FENCE_FAR) {
      far += w;
      farPx++;
    }
  }
  return { target: t, near: near / nearPx, far: far / farPx, nearPx, farPx };
}
