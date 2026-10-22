import { MinHeap } from '../core/heap';
import type { SearchSpace } from '../graph/space';
import { makeHeuristic } from './heuristics';
import { emptyResult, tracePath, type Recorder, type SearchOptions, type SearchResult } from './types';

export type BestFirstMode = 'dijkstra' | 'astar' | 'weighted' | 'greedy';

/**
 * One loop, four algorithms. They differ only in how the priority f is built:
 *   Dijkstra:    f = g
 *   A*:          f = g + h
 *   Weighted A*: f = g + w·h
 *   Greedy:      f = h
 * Ties on f prefer the larger g (deeper node), which stops A* from flooding
 * plateaus of equal-cost cells on open maps.
 *
 * Nodes can be reopened if a cheaper route to an already-expanded node turns up,
 * which only happens with an inconsistent heuristic (weighted, or Manhattan with
 * diagonals). That keeps the result correct for every option the UI offers.
 * Greedy is the exception: like the textbook version, it never reopens.
 */
export function bestFirst(
  mode: BestFirstMode,
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
  const h = mode === 'dijkstra' ? () => 0 : makeHeuristic(space, goal, opts.heuristic);
  const w = mode === 'weighted' ? Math.max(1, opts.weight) : 1;
  const fOf = (gv: number, node: number) =>
    mode === 'greedy' ? h(node) : mode === 'dijkstra' ? gv : gv + w * h(node);

  const open = new MinHeap(1024);
  g[start] = 0;
  open.push(start, fOf(0, start), -0);
  rec.open(start, -1, 0, fOf(0, start));
  let expanded = 0;
  let pushes = 1;
  let maxOpen = 1;

  while (open.size) {
    const cur = open.pop();
    if (closed[cur]) continue; // stale heap entry
    closed[cur] = 1;
    expanded++;
    rec.close(cur);
    if (cur === goal) {
      return { status: 'found', path: tracePath(parent, start, goal), expanded, pushes, maxOpen };
    }
    const gc = g[cur];
    space.neighbors(cur, (nb, cost) => {
      // Greedy best-first never revisits an expanded node: its priority ignores g,
      // so "reopening on a cheaper g" would only re-expand nodes for nothing.
      if (mode === 'greedy' && closed[nb]) return;
      const ng = gc + cost;
      if (ng + 1e-12 < g[nb]) {
        g[nb] = ng;
        parent[nb] = cur;
        closed[nb] = 0; // reopen if needed
        const f = fOf(ng, nb);
        open.push(nb, f, -ng);
        rec.open(nb, cur, ng, f);
        pushes++;
      }
    });
    if (open.size > maxOpen) maxOpen = open.size;
  }
  return { ...emptyResult('noPath'), expanded, pushes, maxOpen };
}

/**
 * Breadth-first search: expands in rings by number of steps, ignoring edge costs.
 * Shortest in steps, not in distance, once diagonals or terrain costs exist.
 */
export function breadthFirst(space: SearchSpace, start: number, goal: number, rec: Recorder): SearchResult {
  const n = space.count;
  const parent = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const depth = new Int32Array(n);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  rec.open(start, -1, 0, 0);
  let expanded = 0;
  let pushes = 1;
  let maxOpen = 1;
  while (head < tail) {
    const cur = queue[head++];
    expanded++;
    rec.close(cur);
    if (cur === goal) return { status: 'found', path: tracePath(parent, start, goal), expanded, pushes, maxOpen };
    space.neighbors(cur, (nb) => {
      if (seen[nb]) return;
      seen[nb] = 1;
      parent[nb] = cur;
      depth[nb] = depth[cur] + 1;
      queue[tail++] = nb;
      rec.open(nb, cur, depth[nb], depth[nb]);
      pushes++;
    });
    if (tail - head > maxOpen) maxOpen = tail - head;
  }
  return { ...emptyResult('noPath'), expanded, pushes, maxOpen };
}
