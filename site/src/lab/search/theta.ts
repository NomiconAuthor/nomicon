import { MinHeap } from '../core/heap';
import type { SearchSpace } from '../graph/space';
import { makeHeuristic } from './heuristics';
import { emptyResult, tracePath, type Recorder, type SearchOptions, type SearchResult } from './types';

/**
 * Theta* (Nash, Daniel, Koenig & Felner): A* whose parent pointers may jump to any
 * earlier node in line of sight, so the path is a few straight segments at any angle
 * instead of 45-degree zig-zags.
 *
 * Lazy Theta* assumes line of sight when it generates a node and only checks it when
 * the node is expanded, which cuts the number of line-of-sight checks a lot.
 */
export function thetaStar(
  lazy: boolean,
  space: SearchSpace,
  start: number,
  goal: number,
  opts: SearchOptions,
  rec: Recorder,
): SearchResult {
  const n = space.count;
  const g = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const h = makeHeuristic(space, goal, opts.heuristic);
  const open = new MinHeap(1024);
  let expanded = 0;
  let pushes = 1;
  let maxOpen = 1;
  let losChecks = 0;
  const los = (a: number, b: number) => {
    losChecks++;
    return space.lineOfSight(a, b);
  };

  g[start] = 0;
  parent[start] = start;
  open.push(start, h(start), 0);
  rec.open(start, -1, 0, h(start));

  while (open.size) {
    const cur = open.pop();
    if (closed[cur]) continue;

    if (lazy && cur !== start) {
      // Verify the assumed line of sight to the parent; if it fails, fall back to the
      // best already-expanded neighbour as the parent.
      const p = parent[cur];
      if (!los(p, cur)) {
        let best = Infinity;
        let bestP = -1;
        space.neighbors(cur, (nb, cost) => {
          if (closed[nb] && g[nb] + cost < best) {
            best = g[nb] + cost;
            bestP = nb;
          }
        });
        g[cur] = best;
        parent[cur] = bestP;
        rec.open(cur, bestP, best, best + h(cur)); // redraw its tree edge
      }
    }

    closed[cur] = 1;
    expanded++;
    rec.close(cur);
    if (cur === goal) {
      const parents = parent.slice();
      parents[start] = -1;
      return {
        status: 'found',
        path: tracePath(parents, start, goal),
        expanded,
        pushes,
        maxOpen,
        note: `${losChecks.toLocaleString()} line-of-sight checks`,
      };
    }

    const pc = parent[cur];
    space.neighbors(cur, (nb, cost) => {
      if (closed[nb]) return;
      let ng: number;
      let np: number;
      if (lazy) {
        // Assume the grandparent can see nb; checked later on expansion.
        ng = g[pc] + space.segmentCost(pc, nb);
        np = pc;
        if (pc === cur) {
          ng = g[cur] + cost;
        }
      } else if (pc !== cur && los(pc, nb)) {
        ng = g[pc] + space.segmentCost(pc, nb);
        np = pc;
      } else {
        ng = g[cur] + cost;
        np = cur;
      }
      if (ng + 1e-12 < g[nb]) {
        g[nb] = ng;
        parent[nb] = np;
        open.push(nb, ng + h(nb), -ng);
        rec.open(nb, np, ng, ng + h(nb));
        pushes++;
      }
    });
    if (open.size > maxOpen) maxOpen = open.size;
  }
  return { ...emptyResult('noPath'), expanded, pushes, maxOpen, note: `${losChecks.toLocaleString()} line-of-sight checks` };
}
