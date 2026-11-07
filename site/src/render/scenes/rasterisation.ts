/**
 * The rasterisation lesson's scenes: two triangles given straight in pixels for edge functions,
 * the fill rule and MSAA, and a checkerboard floor for perspective-correct interpolation, with the
 * counts the lesson quotes.
 */
import { type Camera, type Draw, type FillRule, type Stats, DEFAULTS, Target, renderAll, v3 } from '../raster';
import { checker, floor, renderSteps } from './common';

// ---------------------------------------------------------------------------------------------
// Edge functions and the fill rule. Triangles given straight in pixels (x right, y down), in a tiny target.

export const RAST_W = 14;
export const RAST_H = 10;
export type RasterPreset = 'shared' | 'sliver';

/** Vertex positions in pixels for each preset: two triangles, A then B. */
export function rasterPoints(p: RasterPreset): Array<[number, number]> {
  if (p === 'shared')
    // A quad split along a 45° diagonal that runs exactly through nine pixel centres. A's top
    // edge and B's bottom edge are horizontal and also run through pixel centres.
    return [
      [1.5, 0.5],
      [10.5, 0.5],
      [2.5, 8.5],
      [10.5, 0.5],
      [12.5, 8.5],
      [2.5, 8.5],
    ];
  // A long sliver that slips between pixel centres, and a triangle smaller than a pixel that
  // covers no centre at all.
  return [
    [0.7, 1.2],
    [13.3, 7.6],
    [13.4, 8.6],
    [4.6, 7.1],
    [5.4, 7.25],
    [4.75, 7.45],
  ];
}

/** Screen-space draws: positions are pixels, mapped straight to clip space with w = 1. */
export function rasterScene(pts: Array<[number, number]>): { draws: Draw[]; camera: Camera } {
  // An orthographic camera that maps pixel (x, y) to clip space: built as clip coordinates directly.
  const toWorld = ([x, y]: [number, number]) => v3(x, y, 0.5);
  const mk = (i: number, color: string, name: string): Draw => ({
    name,
    color,
    twoSided: true,
    mesh: { positions: pts.slice(i, i + 3).map(toWorld), attrs: [[1], [0.8], [0.6]], indices: [0, 1, 2] },
    shade: () => 1,
  });
  return { draws: [mk(0, '--c2', 'A'), mk(3, '--c3', 'B')], camera: SCREEN_CAMERA };
}
/**
 * The "camera" for screen-space draws: render() spots `screen: true` and maps pixel positions
 * straight to clip space (w = 1), so no projection happens.
 */
export const SCREEN_CAMERA: Camera = { eye: v3(0, 0, 0), target: v3(0, 0, 1), focal: 1, aspect: 1, near: 0, far: 1, reverseZ: false, screen: { w: RAST_W, h: RAST_H } };

export interface CoverageCount {
  a: number;
  b: number;
  twice: number;
  missed: number;
  /** With 4× MSAA: pixels partly covered, fragment shader runs, covered samples. */
  partial: number;
  shaded: number;
  samples: number;
}

/** Each triangle drawn on its own (and both together), for counting and for marking pixels. */
export function coverageMaps(pts: Array<[number, number]>, fill: FillRule, samples: 1 | 4): { per: Target[]; ref: Target[]; both: Target; stats: Stats } {
  const { draws, camera } = rasterScene(pts);
  const one = (d: Draw, f: FillRule) => {
    const t = new Target(RAST_W, RAST_H, samples);
    renderAll([d], t, camera, { ...DEFAULTS, fill: f, depthTest: false });
    return t;
  };
  const both = new Target(RAST_W, RAST_H, samples);
  const stats = renderAll(draws, both, camera, { ...DEFAULTS, fill, depthTest: false });
  return { per: draws.map((d) => one(d, fill)), ref: draws.map((d) => one(d, 'top-left')), both, stats };
}

/** Count what a fill rule does to the two triangles. */
export function coverage(pts: Array<[number, number]>, fill: FillRule, samples: 1 | 4): CoverageCount {
  const { per, ref, both, stats } = coverageMaps(pts, fill, samples);
  const n = RAST_W * RAST_H * samples;
  let a = 0;
  let b = 0;
  let twice = 0;
  let missed = 0;
  let covered = 0;
  for (let i = 0; i < n; i++) {
    const ia = per[0].owner[i] >= 0;
    const ib = per[1].owner[i] >= 0;
    if (ia) a++;
    if (ib) b++;
    if (ia && ib) twice++;
    // "Missed": inside the pair by the top-left rule, but drawn by neither.
    if (!ia && !ib && (ref[0].owner[i] >= 0 || ref[1].owner[i] >= 0)) missed++;
    if (both.owner[i] >= 0) covered++;
  }
  let partial = 0;
  if (samples === 4)
    for (let p = 0; p < RAST_W * RAST_H; p++) {
      let k = 0;
      for (let s = 0; s < 4; s++) if (both.owner[p * 4 + s] >= 0) k++;
      if (k > 0 && k < 4) partial++;
    }
  return { a, b, twice, missed, partial, shaded: stats.shaded, samples: covered };
}

// ---------------------------------------------------------------------------------------------
// Perspective-correct interpolation. A checkerboard floor in two triangles.

export const PERSP_W = 64;
export const PERSP_H = 40;
export function perspectiveScene(): Draw[] {
  return [{ name: 'floor', mesh: floor(-4, 4, 1, -16, 0, 1), color: '--c1', shade: checker }];
}
export const perspectiveCamera: Camera = { eye: v3(0, 1.4, 1.4), target: v3(0, 0, -3), focal: 1.5, aspect: PERSP_W / PERSP_H, near: 0.1, far: 100, reverseZ: false };

/** The largest difference in texture coordinates between affine and perspective-correct, in squares. */
export function affineError(): { max: number; pixels: number; wrong: number } {
  const ta = new Target(PERSP_W, PERSP_H);
  const tb = new Target(PERSP_W, PERSP_H);
  renderAll(perspectiveScene(), ta, perspectiveCamera, { ...DEFAULTS, perspective: false });
  renderAll(perspectiveScene(), tb, perspectiveCamera, { ...DEFAULTS, perspective: true });
  let max = 0;
  let pixels = 0;
  let wrong = 0;
  // Re-run, collecting the uv each way per pixel.
  const uv = (perspective: boolean) => {
    const m = new Map<number, number[]>();
    const st = { ...DEFAULTS, perspective };
    const t = new Target(PERSP_W, PERSP_H);
    for (const s of renderSteps(perspectiveScene(), t, perspectiveCamera, st)) if (s.kind === 'pixel' && s.mask) m.set(s.y * PERSP_W + s.x, s.attrs);
    return m;
  };
  const A = uv(false);
  const B = uv(true);
  for (const [k, a] of A) {
    const b = B.get(k)!;
    pixels++;
    max = Math.max(max, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    if (ta.lum[k] !== tb.lum[k]) wrong++;
  }
  return { max, pixels, wrong };
}
