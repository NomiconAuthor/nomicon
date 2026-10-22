import { MinHeap } from '../core/heap';
import { GridSpace } from '../graph/gridSpace';
import type { SearchSpace } from '../graph/space';
import { makeHeuristic } from './heuristics';
import { emptyResult, tracePath, type Recorder, type SearchOptions, type SearchResult } from './types';

/**
 * Jump Point Search (Harabor & Grastien), the variant that never cuts corners:
 * a diagonal move needs both side cells open.
 *
 * Instead of adding every neighbour to the open list, it "jumps" in a straight line
 * until something interesting happens (a forced neighbour, or the goal), and only
 * queues that jump point. On open uniform-cost grids that removes most of the open
 * list traffic. The cells it passes over while jumping are recorded as "scanned".
 *
 * Needs: a grid, uniform costs, and the no-corner-cutting diagonal rule.
 */
export function jumpPointSearch(
  spaceIn: SearchSpace,
  start: number,
  goal: number,
  opts: SearchOptions,
  rec: Recorder,
): SearchResult {
  const space = spaceIn as GridSpace;
  const w = space.w;
  const ok = (x: number, y: number) => space.ok(x, y);
  const gx = goal % w;
  const gy = (goal - gx) / w;
  const h = makeHeuristic(space, goal, opts.heuristic);
  const n = space.count;
  const g = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = new MinHeap(256);
  let expanded = 0;
  let pushes = 1;
  let maxOpen = 1;

  /** Straight jump (dx or dy is 0). Returns the jump point id or -1. */
  const jumpStraight = (x: number, y: number, dx: number, dy: number): number => {
    for (;;) {
      x += dx;
      y += dy;
      if (!ok(x, y)) return -1;
      const id = y * w + x;
      rec.scan(id);
      if (x === gx && y === gy) return id;
      if (dx !== 0) {
        if ((ok(x, y - 1) && !ok(x - dx, y - 1)) || (ok(x, y + 1) && !ok(x - dx, y + 1))) return id;
      } else {
        if ((ok(x - 1, y) && !ok(x - 1, y - dy)) || (ok(x + 1, y) && !ok(x + 1, y - dy))) return id;
      }
    }
  };

  /** Jump in any direction from (px, py) by (dx, dy). */
  const jump = (px: number, py: number, dx: number, dy: number): number => {
    if (dx === 0 || dy === 0) return jumpStraight(px, py, dx, dy);
    let x = px;
    let y = py;
    for (;;) {
      // Diagonal step needs both side cells open (no corner cutting).
      if (!ok(x + dx, y) || !ok(x, y + dy)) return -1;
      x += dx;
      y += dy;
      if (!ok(x, y)) return -1;
      const id = y * w + x;
      rec.scan(id);
      if (x === gx && y === gy) return id;
      // A diagonal cell is a jump point if a straight jump from it finds something.
      if (jumpStraight(x, y, dx, 0) !== -1 || jumpStraight(x, y, 0, dy) !== -1) return id;
    }
  };

  const neighbourDirs = (id: number): Array<[number, number]> => {
    const x = id % w;
    const y = (id - x) / w;
    const p = parent[id];
    const dirs: Array<[number, number]> = [];
    if (p === -1) {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (!ok(x + dx, y + dy)) continue;
          if (dx && dy && (!ok(x + dx, y) || !ok(x, y + dy))) continue;
          dirs.push([dx, dy]);
        }
      return dirs;
    }
    const pxx = p % w;
    const pyy = (p - pxx) / w;
    const dx = Math.sign(x - pxx);
    const dy = Math.sign(y - pyy);
    if (dx && dy) {
      if (ok(x, y + dy)) dirs.push([0, dy]);
      if (ok(x + dx, y)) dirs.push([dx, 0]);
      if (ok(x, y + dy) && ok(x + dx, y)) dirs.push([dx, dy]);
    } else if (dx) {
      const next = ok(x + dx, y);
      const up = ok(x, y + 1);
      const down = ok(x, y - 1);
      if (next) {
        dirs.push([dx, 0]);
        if (up) dirs.push([dx, 1]);
        if (down) dirs.push([dx, -1]);
      }
      if (up) dirs.push([0, 1]);
      if (down) dirs.push([0, -1]);
    } else {
      const next = ok(x, y + dy);
      const right = ok(x + 1, y);
      const left = ok(x - 1, y);
      if (next) {
        dirs.push([0, dy]);
        if (right) dirs.push([1, dy]);
        if (left) dirs.push([-1, dy]);
      }
      if (right) dirs.push([1, 0]);
      if (left) dirs.push([-1, 0]);
    }
    return dirs;
  };

  g[start] = 0;
  open.push(start, h(start), 0);
  rec.open(start, -1, 0, h(start));
  while (open.size) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    rec.close(cur);
    if (cur === goal) return { status: 'found', path: tracePath(parent, start, goal), expanded, pushes, maxOpen };
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [dx, dy] of neighbourDirs(cur)) {
      const jp = jump(cx, cy, dx, dy);
      if (jp === -1 || closed[jp]) continue;
      const jx = jp % w;
      const jy = (jp - jx) / w;
      const ax = Math.abs(jx - cx);
      const ay = Math.abs(jy - cy);
      const d = Math.max(ax, ay) + (Math.SQRT2 - 1) * Math.min(ax, ay);
      const ng = g[cur] + d;
      if (ng + 1e-12 < g[jp]) {
        g[jp] = ng;
        parent[jp] = cur;
        open.push(jp, ng + h(jp), -ng);
        rec.open(jp, cur, ng, ng + h(jp));
        pushes++;
      }
    }
    if (open.size > maxOpen) maxOpen = open.size;
  }
  return { ...emptyResult('noPath'), expanded, pushes, maxOpen };
}

/** Why JPS can't run on this space, or null. */
export function jpsCheck(space: SearchSpace): string | null {
  if (!(space instanceof GridSpace)) return 'Jump Point Search only works on uniform grids.';
  if (space.opts.diagonal !== 'noCorner') return 'This JPS variant needs the "no corner cutting" diagonal rule.';
  if (!space.uniformCost) return 'JPS assumes every cell costs the same. Turn off terrain costs or clear the terrain.';
  return null;
}
