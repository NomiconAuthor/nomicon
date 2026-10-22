import type { SearchSpace } from '../graph/space';

export type SmoothingId = 'none' | 'shortcut';

/**
 * Line-of-sight shortcutting ("string pulling" on a grid): from each kept point,
 * jump to the furthest later point it can see in a straight line.
 * Cheap, and removes the 45-degree zig-zags of grid paths.
 */
export function shortcut(space: SearchSpace, path: number[]): number[] {
  if (path.length < 3) return path.slice();
  const out = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let j = path.length - 1;
    while (j > i + 1 && !space.lineOfSight(path[i], path[j])) j--;
    out.push(path[j]);
    i = j;
  }
  return out;
}

export interface PathMetrics {
  length: number;
  cost: number;
  segments: number;
}

export function measurePath(space: SearchSpace, path: number[]): PathMetrics {
  let length = 0;
  let cost = 0;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1];
    const b = path[k];
    length += Math.hypot(space.x(b) - space.x(a), space.y(b) - space.y(a));
    cost += space.segmentCost(a, b);
  }
  return { length, cost, segments: Math.max(0, path.length - 1) };
}
