import { breadthFirst, bestFirst } from './bestFirst';
import { jpsCheck, jumpPointSearch } from './jps';
import { thetaStar } from './theta';
import type { AlgorithmDef } from './types';

/**
 * Every algorithm the lab knows, with the explanation shown beside the map.
 * To add one: write a function with the AlgorithmDef.run signature, add an entry here.
 */
export const ALGORITHMS: AlgorithmDef[] = [
  {
    id: 'astar',
    name: 'A*',
    family: 'Best-first',
    summary:
      'Always expands the node with the lowest f = g + h: distance walked so far plus a guess of the distance left. The guess (heuristic) steers it toward the goal.',
    guarantees: { optimal: 'Yes, if the heuristic never overestimates', complete: 'Yes', pathShape: 'Grid steps' },
    watch:
      'How narrow the explored region stays on open ground, and how it floods when a wall blocks the straight line. Try an unreachable goal with the reachability check off.',
    usesHeuristic: true,
    usesWeight: false,
    check: () => null,
    run: (s, a, b, o, r) => bestFirst('astar', s, a, b, o, r),
  },
  {
    id: 'dijkstra',
    name: 'Dijkstra',
    family: 'Best-first',
    summary:
      'Expands by lowest cost so far, with no guess about the goal. Spreads evenly in every direction, weighted by terrain cost.',
    guarantees: { optimal: 'Yes', complete: 'Yes', pathShape: 'Grid steps' },
    watch:
      'The circle of explored cells compared with A*. Dijkstra is the right tool when you want distances to many places at once (flow fields, nearest cover), not for one start and one goal.',
    usesHeuristic: false,
    usesWeight: false,
    check: () => null,
    run: (s, a, b, o, r) => bestFirst('dijkstra', s, a, b, o, r),
  },
  {
    id: 'weighted',
    name: 'Weighted A*',
    family: 'Best-first',
    summary:
      'A* with the guess multiplied by a weight w > 1: f = g + w·h. Trusts the heuristic more, so it rushes toward the goal.',
    guarantees: { optimal: 'Within a factor w of optimal', complete: 'Yes', pathShape: 'Grid steps' },
    watch: 'Expansions drop sharply as w rises, while path cost creeps up a little. Use compare mode against plain A*.',
    usesHeuristic: true,
    usesWeight: true,
    check: () => null,
    run: (s, a, b, o, r) => bestFirst('weighted', s, a, b, o, r),
  },
  {
    id: 'greedy',
    name: 'Greedy best-first',
    family: 'Best-first',
    summary: 'Expands by heuristic only (f = h), ignoring the distance already walked.',
    guarantees: { optimal: 'No', complete: 'Yes on a finite grid', pathShape: 'Grid steps' },
    watch: 'Very few expansions on open maps, then long detours behind U-shaped walls. A good example of why A* adds g.',
    usesHeuristic: true,
    usesWeight: false,
    check: () => null,
    run: (s, a, b, o, r) => bestFirst('greedy', s, a, b, o, r),
  },
  {
    id: 'bfs',
    name: 'Breadth-first',
    family: 'Uninformed',
    summary: 'Expands in rings by number of steps, ignoring distance and terrain cost.',
    guarantees: { optimal: 'Fewest steps only', complete: 'Yes', pathShape: 'Grid steps' },
    watch: 'With diagonals on or terrain painted, its path has the fewest steps but not the lowest cost.',
    usesHeuristic: false,
    usesWeight: false,
    check: () => null,
    run: (s, a, b, _o, r) => breadthFirst(s, a, b, r),
  },
  {
    id: 'jps',
    name: 'Jump Point Search',
    family: 'Pruning',
    summary:
      'A* that skips runs of symmetric paths: it jumps in straight lines and only queues cells where the path might have to turn.',
    guarantees: { optimal: 'Yes (uniform-cost grids)', complete: 'Yes', pathShape: 'Waypoints at turns' },
    watch:
      'The yellow scanned cells (looked at, never queued) against the tiny open list. Paint one terrain cell and it becomes unusable: JPS needs uniform costs.',
    usesHeuristic: true,
    usesWeight: false,
    check: jpsCheck,
    run: jumpPointSearch,
  },
  {
    id: 'theta',
    name: 'Theta*',
    family: 'Any-angle',
    summary:
      'A* where each node may take its grandparent as parent whenever there is a clear line of sight, so paths come out as a few straight segments at any angle.',
    guarantees: { optimal: 'No, but usually very close', complete: 'Yes', pathShape: 'Any-angle segments' },
    watch: 'Turn on the search tree: parent lines stretch across open space instead of hopping cell to cell.',
    usesHeuristic: true,
    usesWeight: false,
    check: () => null,
    run: (s, a, b, o, r) => thetaStar(false, s, a, b, o, r),
  },
  {
    id: 'lazytheta',
    name: 'Lazy Theta*',
    family: 'Any-angle',
    summary:
      'Theta* that assumes line of sight when it reaches a node and only checks it when the node is expanded, saving most of the checks.',
    guarantees: { optimal: 'No, but usually very close', complete: 'Yes', pathShape: 'Any-angle segments' },
    watch: 'Compare the line-of-sight count in the stats with plain Theta*: usually several times fewer.',
    usesHeuristic: true,
    usesWeight: false,
    check: () => null,
    run: (s, a, b, o, r) => thetaStar(true, s, a, b, o, r),
  },
];

export function algorithmById(id: string): AlgorithmDef {
  return ALGORITHMS.find((a) => a.id === id) ?? ALGORITHMS[0];
}

/** Map representations a lane can use; the ones not ready yet show where the lab is heading. */
export const REPRESENTATIONS = [
  { id: 'grid', name: 'Uniform grid', short: 'Grid', ready: true, note: '' },
  { id: 'hpa', name: 'Tiles and doors (HPA*)', short: 'HPA* tiles', ready: true, note: '' },
  { id: 'navmesh', name: 'Navmesh (Recast)', short: 'Navmesh', ready: true, note: '' },
  { id: 'roadmap', name: 'Roadmap (PRM / RRT)', short: 'Roadmap', ready: true, note: '' },
  { id: 'vehicle', name: 'Vehicle (Hybrid A*, lattice)', short: 'Vehicle', ready: true, note: '' },
];
