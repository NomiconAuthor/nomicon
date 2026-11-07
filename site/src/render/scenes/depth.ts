/**
 * The depth lesson's scenes: a field seen from 50 m up with a road decal 2 cm above the ground
 * (z-fighting, formats, near plane, reverse-Z), and two rows of buildings for early Z, late Z and
 * the depth prepass, with the measurements the lesson quotes.
 */
import { type Camera, type DepthFormat, type DepthMode, type Draw, type Options, type Stats, DEFAULTS, Target, depthAt, neighbour, quantise, renderAll, v3 } from '../raster';
import { box, checker, flat, floor, quad } from './common';

// ---------------------------------------------------------------------------------------------
// Z-fighting. Looking down at a field from 50 m up: a tower, the ground, and a road painted
// on as a separate quad 2 cm above the ground (a decal).

export const DEPTH_W = 96;
export const DEPTH_H = 60;
export const DEPTH_NEARS = [0.01, 0.1, 1, 10] as const;
export const DEPTH_FAR = 5000;
export const ROAD_LIFT = 0.02;

export function depthScene(): Draw[] {
  return [
    { name: 'tower', mesh: box(v3(-60, 30, -260), v3(30, 60, 30), 0.8, 0.6), color: '--c5', shade: flat },
    { name: 'ground', mesh: floor(-1500, 1500, 0, -3000, 0, 40), color: '--c4', shade: (a) => 0.4 + 0.35 * checker(a) },
    { name: 'road', mesh: floor(-12, 12, -40, -3000, ROAD_LIFT, 40), color: '--c1', shade: () => 1 },
  ];
}
export interface DepthSettings {
  format: DepthFormat;
  near: number;
  reverseZ: boolean;
  depthTest: boolean;
}
export const DEPTH_DEFAULT: DepthSettings = { format: 'unorm24', near: 0.1, reverseZ: false, depthTest: true };
export function depthCamera(s: DepthSettings): Camera {
  return { eye: v3(0, 50, 0), target: v3(0, 0, -100), focal: 1.5, aspect: DEPTH_W / DEPTH_H, near: s.near, far: DEPTH_FAR, reverseZ: s.reverseZ };
}
export function depthOptions(s: DepthSettings): Options {
  return { ...DEFAULTS, format: s.format, depthTest: s.depthTest };
}

/** How many of the road's pixels the ground shows through (z-fighting), and of how many. */
export function zFight(s: DepthSettings): { road: number; fighting: number; towerHidden: boolean } {
  const scene = depthScene();
  const cam = depthCamera(s);
  const roadOnly = new Target(DEPTH_W, DEPTH_H);
  renderAll([scene[2]], roadOnly, cam, depthOptions(s));
  const full = new Target(DEPTH_W, DEPTH_H);
  renderAll(scene, full, cam, depthOptions(s));
  let road = 0;
  let fighting = 0;
  let tower = 0;
  for (let i = 0; i < DEPTH_W * DEPTH_H; i++) {
    if (full.owner[i] === 0) tower++;
    if (roadOnly.owner[i] < 0) continue;
    road++;
    if (full.owner[i] === 1) fighting++;
  }
  return { road, fighting, towerHidden: tower === 0 };
}

/**
 * The depth buffer's resolution at distance z: how far apart two surfaces must be (along the view
 * direction) to be sure of different stored values: the width, in distance, of the range of
 * depths that round to the same value as z (halfway to the storable value on each side).
 */
export function resolution(z: number, near: number, far: number, fmt: DepthFormat, reverseZ: boolean): number {
  const q = quantise(depthAt(z, near, far, reverseZ), fmt);
  const lo = Math.max(0, (q + neighbour(q, fmt, -1)) / 2);
  const hi = Math.min(1, (q + neighbour(q, fmt, 1)) / 2);
  return Math.abs(distanceAt(hi, near, far, reverseZ) - distanceAt(lo, near, far, reverseZ));
}
/** The inverse of depthAt: the distance that maps to depth d. */
export function distanceAt(d: number, near: number, far: number, reverseZ: boolean): number {
  if (!reverseZ) return far === Infinity ? near / (1 - d) : near / (1 - (d * (far - near)) / far);
  return far === Infinity ? near / d : far / (1 + (d * (far - near)) / near);
}

// ---------------------------------------------------------------------------------------------
// Early Z, late Z and a depth prepass. Boxes in a row, overlapping on screen.

export const OVER_W = 80;
export const OVER_H = 50;
export type DrawOrder = 'front' | 'back';
export function overdrawScene(order: DrawOrder): Draw[] {
  const boxes: Draw[] = [];
  const cols = ['--c2', '--c3', '--c6', '--c5', '--c7', '--c1'];
  // Front to back as authored; reversed for back to front.
  // Two rows of buildings down a street, each taller than the one in front, so they hide each other.
  for (let i = 0; i < 6; i++)
    for (const side of [-1, 1]) {
      const hgt = 2 + i * 0.7;
      boxes.push({ name: `${side < 0 ? 'left' : 'right'} building ${i + 1}`, mesh: box(v3(side * 2.6, hgt / 2, -1.5 - i * 2), v3(2.2, hgt, 1.6)), color: cols[i], shade: flat });
    }
  const wall: Draw = { name: 'back wall', mesh: quad([v3(-12, 0, -14), v3(12, 0, -14), v3(12, 8, -14), v3(-12, 8, -14)], [[0.5], [0.5], [0.5], [0.5]]), color: '--c8', shade: flat };
  const ground: Draw = { name: 'ground', mesh: floor(-12, 12, 4, -14, 0, 1), color: '--c4', shade: checker };
  const list = [...boxes, ground, wall];
  return order === 'front' ? list : list.reverse();
}
export const overdrawCamera: Camera = { eye: v3(0, 1.6, 3), target: v3(0, 1.2, -6), focal: 1.4, aspect: OVER_W / OVER_H, near: 0.1, far: 100, reverseZ: false };

export function overdraw(order: DrawOrder, mode: DepthMode): { stats: Stats; visible: number; target: Target } {
  const t = new Target(OVER_W, OVER_H);
  const stats = renderAll(overdrawScene(order), t, overdrawCamera, { ...DEFAULTS, depthMode: mode });
  let visible = 0;
  for (let i = 0; i < OVER_W * OVER_H; i++) if (t.owner[i] >= 0) visible++;
  return { stats, visible, target: t };
}

