/**
 * Shared pieces of the rendering lessons' scenes: mesh builders, shading functions and helpers for
 * measurements. Everything here is built from exact numbers and sqrt, never trig, so the same pixels
 * come out in every browser and in Node. Each lesson's own scenes and the measurements its text
 * quotes live in scenes/<slug>.ts, checked by test/claims/render/<slug>.ts.
 */
import { type Camera, type Draw, type Mesh, type Options, type Target, type V3, emptyStats, render as renderGen, v3 } from '../raster';

// ---------------------------------------------------------------------------------------------
// Mesh builders

/** A quad from four corners, counter-clockwise seen from the front, with per-corner attributes. */
export function quad(p: [V3, V3, V3, V3], attrs: number[][]): Mesh {
  return { positions: p, attrs, indices: [0, 1, 2, 0, 2, 3] };
}

/** A fixed light direction for flat shading, normalised with sqrt. */
export const LIGHT = (() => {
  const l = v3(0.4, 1, 0.6);
  const s = Math.sqrt(l.x * l.x + l.y * l.y + l.z * l.z);
  return v3(l.x / s, l.y / s, l.z / s);
})();
/** Brightness of a face with this normal: a little ambient plus Lambert. */
export const lambert = (n: V3) => 0.35 + 0.65 * Math.max(0, n.x * LIGHT.x + n.y * LIGHT.y + n.z * LIGHT.z);

/**
 * A box: 24 vertices (each face has its own four, because each face has its own shade), 36 indices,
 * 12 triangles. Turned about the vertical axis by (c, s) = (cos, sin), given exactly.
 */
export function box(centre: V3, size: V3, c = 1, s = 0): Mesh {
  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;
  const rot = (p: V3) => v3(centre.x + p.x * c + p.z * s, centre.y + p.y, centre.z - p.x * s + p.z * c);
  const rotN = (n: V3) => v3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c);
  // Each face: normal, then its four corners counter-clockwise seen from outside.
  const faces: Array<[V3, V3[]]> = [
    [v3(0, 0, 1), [v3(-hx, -hy, hz), v3(hx, -hy, hz), v3(hx, hy, hz), v3(-hx, hy, hz)]],
    [v3(0, 0, -1), [v3(hx, -hy, -hz), v3(-hx, -hy, -hz), v3(-hx, hy, -hz), v3(hx, hy, -hz)]],
    [v3(1, 0, 0), [v3(hx, -hy, hz), v3(hx, -hy, -hz), v3(hx, hy, -hz), v3(hx, hy, hz)]],
    [v3(-1, 0, 0), [v3(-hx, -hy, -hz), v3(-hx, -hy, hz), v3(-hx, hy, hz), v3(-hx, hy, -hz)]],
    [v3(0, 1, 0), [v3(-hx, hy, hz), v3(hx, hy, hz), v3(hx, hy, -hz), v3(-hx, hy, -hz)]],
    [v3(0, -1, 0), [v3(-hx, -hy, -hz), v3(hx, -hy, -hz), v3(hx, -hy, hz), v3(-hx, -hy, hz)]],
  ];
  const m: Mesh = { positions: [], attrs: [], indices: [] };
  for (const [n, corners] of faces) {
    const b = m.positions.length;
    const lum = lambert(rotN(n));
    for (const p of corners) {
      m.positions.push(rot(p));
      m.attrs.push([lum]);
    }
    m.indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return m;
}

/** A horizontal rectangle at height y, from (x0, z0) to (x1, z1), facing up, with u, v in metres / tile. */
export function floor(x0: number, x1: number, z0: number, z1: number, y: number, tile: number): Mesh {
  // Seen from above, counter-clockwise: near-left, near-right, far-right, far-left (z1 < z0 is "far").
  return quad(
    [v3(x0, y, z0), v3(x1, y, z0), v3(x1, y, z1), v3(x0, y, z1)],
    [
      [x0 / tile, z0 / tile],
      [x1 / tile, z0 / tile],
      [x1 / tile, z1 / tile],
      [x0 / tile, z1 / tile],
    ],
  );
}

/** Checkerboard brightness for texture coordinates u, v (one square per unit). */
export const checker = (a: number[]) => ((Math.floor(a[0]) + Math.floor(a[1])) & 1 ? 0.55 : 1);
/** Flat shading: the brightness stored per vertex. */
export const flat = (a: number[]) => a[0];

/** Every step of a frame (for measurements that need per-pixel detail). */
export function* renderSteps(draws: Draw[], target: Target, cam: Camera, opt: Options) {
  yield* renderGen(draws, target, cam, opt, emptyStats());
}

/** A length for the lesson text and the widgets: metres, centimetres, millimetres or micrometres. */
export function lengthText(m: number): string {
  const r = (x: number) => (x >= 10 || Number.isInteger(x) ? Math.round(x).toString() : x.toFixed(1));
  if (m >= 1) return `${r(m)} m`;
  if (m >= 0.01) return `${r(m * 100)} cm`;
  if (m >= 0.001) return `${r(m * 1000)} mm`;
  return `${r(m * 1e6)} µm`;
}
