import type { GridSpace } from '../graph/gridSpace';
import type { Recorder, SearchStatus } from '../search/types';
import type { Rect } from './hpaGraph';

/** A point in map coordinates: 1 unit = 1 cell, (0,0) = top-left corner of the map. */
export interface Pt {
  x: number;
  y: number;
}

/** The visible part of the map, in cells, plus the current zoom (pixels per cell). */
export interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cs: number;
}

export interface Message {
  text: string;
  bad: boolean;
}

/** Everything a representation needs to plan one query. */
export interface PlanContext {
  space: GridSpace;
  start: number; // cell id
  goal: number; // cell id
  /** What changed in the world since this lane's previous plan: nothing, a box of edited cells, or everything. */
  changed: Rect | 'none' | 'all';
  /** Key of everything that invalidates cached structures wholesale (map size, unit size, rules). */
  structureKey: string;
  /** Which unit this query is for when several plan in turn (0 = first; a new round starts there). */
  unitIndex?: number;
  /** Facing at the start and goal, in radians (vehicles only). */
  startHeading?: number;
  goalHeading?: number;
}

/** Draws a representation's structure and its search state on the map canvas. */
export interface RepView {
  /** Number of node ids the recorded events refer to. */
  nodeCount: number;
  /** Drawn under the search state (graph structure, tiles, polygons). */
  drawStructure(ctx: CanvasRenderingContext2D, v: ViewRect): void;
  /** Search state at the current playback step. */
  drawState(ctx: CanvasRenderingContext2D, v: ViewRect, status: Uint8Array, parent: Int32Array, current: number, tree: boolean): void;
  /** Optional: draw this view's search in a unit's colour (used when each unit has its own tree);
   *  `index` of `count` views drawn together. */
  setTint?(colorToken: string, index?: number, count?: number): void;
  /** Optional, for the hover inspector: the node under map point (x, y), or -1. `r` = pick radius in cells. */
  nodeAt?(x: number, y: number, r: number): number;
  /** Optional, for the hover inspector: a short name for a node ("Door at 12, 5", "Polygon 34 · road"). */
  nodeLabel?(id: number): string;
}

/** How a search turns g and h into its open-list priority f (so the inspector can show the sum). */
export type Priority = 'g+h' | 'g+wh' | 'h' | 'g' | 'depth';

/** A vehicle's footprint, as far as drawing goes. */
export interface VehicleShape {
  length: number;
  width: number;
  /** Reference point (rear axle, or middle for tracked) to the rear bumper. */
  rear: number;
}

/** A vehicle's planned motion: x, y, theta, dir (+1 forward, -1 reverse) quadruples. */
export interface VehiclePath {
  poses: Float32Array;
  shape: VehicleShape;
}

export interface Plan {
  status: SearchStatus;
  expanded: number;
  pushes: number;
  maxOpen: number;
  rec: Recorder;
  rawPath: Pt[];
  finalPath: Pt[];
  length: number;
  cost: number;
  /** Average time of one query, excluding one-off preprocessing. */
  queryMs: number;
  /** Extra rows for the stats grid. */
  extra: Array<[string, string]>;
  messages: Message[];
  note?: string;
  view: RepView;
  /** One line on what this query reused or built (shown per unit when several units plan). */
  unitNote?: string;
  /** 'own' when node ids are private to this query (each RRT tree), so several can't share a view. */
  idSpace?: 'shared' | 'own';
  /** Vehicles: the poses along the path, for drawing the footprint and reversing. */
  vehicle?: VehiclePath;
  /** How f was built from g and h, and the weight w for 'g+wh'. Absent: the search has no costs to show (RRT). */
  priority?: Priority;
  weight?: number;
}

export function cellCenter(space: GridSpace, id: number): Pt {
  return { x: space.x(id), y: space.y(id) };
}

export function polyLength(p: Pt[]): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return L;
}
