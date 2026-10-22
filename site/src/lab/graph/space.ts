/**
 * What a search algorithm sees. Every representation (grid now; quadtree, roadmap,
 * navmesh, lattice later) implements this, so the algorithms never know which one
 * they're running on.
 */
export interface SearchSpace {
  /** Total number of node ids (ids are 0 .. count-1). */
  readonly count: number;
  /** Representation name for the UI ("Grid", "Navmesh", ...). */
  readonly kind: string;
  /** All edge costs equal their length (no terrain multipliers). Some algorithms need this. */
  readonly uniformCost: boolean;
  /** Smallest cost per unit of distance anywhere; multiply heuristics by this to stay admissible. */
  readonly minCostPerUnit: number;

  passable(id: number): boolean;
  /** Calls visit(neighbour, edgeCost) for each neighbour of id. */
  neighbors(id: number, visit: (n: number, cost: number) => void): void;
  /** World position of a node's centre, in cell units. */
  x(id: number): number;
  y(id: number): number;
  /** Straight-line visibility between two nodes for this unit (any-angle searches, smoothing). */
  lineOfSight(a: number, b: number): boolean;
  /** Cost of moving in a straight line from a to b (assumes lineOfSight). */
  segmentCost(a: number, b: number): number;
}
