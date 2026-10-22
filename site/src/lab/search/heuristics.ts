import type { SearchSpace } from '../graph/space';

export type HeuristicId = 'octile' | 'euclidean' | 'manhattan' | 'chebyshev' | 'zero';

export interface HeuristicDef {
  id: HeuristicId;
  name: string;
  formula: string;
  fn: (dx: number, dy: number) => number;
}

const SQRT2m1 = Math.SQRT2 - 1;

export const HEURISTICS: HeuristicDef[] = [
  {
    id: 'octile',
    name: 'Octile',
    formula: 'max(dx,dy) + (√2−1)·min(dx,dy)',
    fn: (dx, dy) => (dx > dy ? dx + SQRT2m1 * dy : dy + SQRT2m1 * dx),
  },
  { id: 'euclidean', name: 'Euclidean', formula: '√(dx² + dy²)', fn: (dx, dy) => Math.sqrt(dx * dx + dy * dy) },
  { id: 'manhattan', name: 'Manhattan', formula: 'dx + dy', fn: (dx, dy) => dx + dy },
  { id: 'chebyshev', name: 'Chebyshev', formula: 'max(dx, dy)', fn: (dx, dy) => Math.max(dx, dy) },
  { id: 'zero', name: 'Zero (none)', formula: '0', fn: () => 0 },
];

export function heuristicById(id: HeuristicId): HeuristicDef {
  return HEURISTICS.find((h) => h.id === id) ?? HEURISTICS[0];
}

/**
 * Builds h(node) toward a fixed goal, scaled by the cheapest terrain cost so it
 * never overestimates (stays admissible) when cheap terrain like roads exists.
 */
export function makeHeuristic(space: SearchSpace, goal: number, id: HeuristicId): (n: number) => number {
  const fn = heuristicById(id).fn;
  const gx = space.x(goal);
  const gy = space.y(goal);
  const scale = space.minCostPerUnit;
  return (n) => scale * fn(Math.abs(space.x(n) - gx), Math.abs(space.y(n) - gy));
}

/** A warning when the chosen heuristic can overestimate for this movement model, or null. */
export function heuristicWarning(id: HeuristicId, diagonalAllowed: boolean, anyAngle: boolean): string | null {
  if (id === 'manhattan' && (diagonalAllowed || anyAngle))
    return 'Manhattan overestimates when diagonal or any-angle moves are allowed, so paths may not be shortest.';
  if (id === 'octile' && anyAngle)
    return 'Octile can overestimate straight any-angle moves; Euclidean is the safe choice here.';
  if (id === 'chebyshev' && diagonalAllowed)
    return 'Chebyshev treats a diagonal step as cost 1, so it underestimates: still optimal, but explores more.';
  return null;
}
