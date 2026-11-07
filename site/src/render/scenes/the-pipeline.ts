/**
 * The pipeline lesson's scene (a floor that runs behind the camera, so the near plane has to clip
 * it, and a box turned by a 3-4-5 angle) and the counts its text quotes.
 */
import { type Camera, type Draw, type Stats, DEFAULTS, Target, renderAll, v3 } from '../raster';
import { box, checker, flat, floor } from './common';

export const PIPE_W = 64;
export const PIPE_H = 40;
export const PIPE_NEARS = [0.1, 1, 4.6] as const;

export function pipelineScene(): Draw[] {
  return [
    { name: 'floor', mesh: floor(-6, 6, 8, -20, 0, 2), color: '--c4', shade: checker },
    { name: 'box', mesh: box(v3(0, 0.7, 0), v3(1.4, 1.4, 1.4), 0.8, 0.6), color: '--c2', shade: flat },
  ];
}
export function pipelineCamera(near: number): Camera {
  return { eye: v3(0, 2.6, 5), target: v3(0, 0.4, 0), focal: 1.5, aspect: PIPE_W / PIPE_H, near, far: 100, reverseZ: false };
}
export function pipelineRun(near: number, cull: boolean): { stats: Stats; target: Target } {
  const target = new Target(PIPE_W, PIPE_H);
  const stats = renderAll(pipelineScene(), target, pipelineCamera(near), { ...DEFAULTS, cull });
  return { stats, target };
}

