import type { SearchSpace } from '../graph/space';
import type { HeuristicId } from './heuristics';

/** Event kinds recorded during a search, replayed by the player. */
export const EV_OPEN = 1; // node added to / improved in the open list (with its parent)
export const EV_CLOSE = 2; // node expanded
export const EV_SCAN = 3; // node looked at without queueing it (JPS jump scans)

/**
 * Records what a search did, step by step, as a flat Int32Array of
 * (kind, node, parent) triples. The player rebuilds any moment of the search
 * from this, which is what makes scrubbing backwards possible.
 */
export class Recorder {
  data: Int32Array;
  /** Per event: the node's cost so far (g) and its priority on the open list (f), when the search gives them. */
  gf: Float32Array;
  length = 0; // number of events
  readonly enabled: boolean;
  readonly limit: number;
  truncated = false;

  constructor(enabled = true, limit = 4_000_000) {
    this.enabled = enabled;
    this.limit = limit;
    this.data = new Int32Array(enabled ? 3 * 4096 : 0);
    this.gf = new Float32Array(enabled ? 2 * 4096 : 0);
  }

  private add(kind: number, node: number, parent: number, g = NaN, f = NaN): void {
    if (!this.enabled) return;
    if (this.length >= this.limit) {
      this.truncated = true;
      return;
    }
    const i = this.length * 3;
    if (i + 3 > this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
      const gf = new Float32Array(this.gf.length * 2);
      gf.set(this.gf);
      this.gf = gf;
    }
    this.data[i] = kind;
    this.data[i + 1] = node;
    this.data[i + 2] = parent;
    this.gf[2 * this.length] = g;
    this.gf[2 * this.length + 1] = f;
    this.length++;
  }

  /** A node joins (or improves on) the open list; g and f are shown by the hover inspector. */
  open(node: number, parent: number, g = NaN, f = NaN): void {
    this.add(EV_OPEN, node, parent, g, f);
  }
  close(node: number): void {
    this.add(EV_CLOSE, node, -1);
  }
  scan(node: number): void {
    this.add(EV_SCAN, node, -1);
  }
}

export type SearchStatus = 'found' | 'noPath' | 'unreachable' | 'unusable';

export interface SearchResult {
  status: SearchStatus;
  /** Node ids from start to goal. Waypoint algorithms (JPS, Theta*) return only the turning points. */
  path: number[];
  /** Nodes expanded (closed). */
  expanded: number;
  /** Times a node was pushed or improved in the open list. */
  pushes: number;
  /** Largest open list seen. */
  maxOpen: number;
  /** Extra line for the stats panel (e.g. why a run stopped). */
  note?: string;
}

export interface SearchOptions {
  heuristic: HeuristicId;
  weight: number;
}

export interface Guarantees {
  optimal: string;
  complete: string;
  pathShape: string;
}

export interface AlgorithmDef {
  id: string;
  name: string;
  family: string;
  /** One or two sentences: how it works. */
  summary: string;
  guarantees: Guarantees;
  /** What to look for when you run it. */
  watch: string;
  usesHeuristic: boolean;
  usesWeight: boolean;
  /** null if it can run on this space; otherwise the reason it can't. */
  check(space: SearchSpace): string | null;
  run(space: SearchSpace, start: number, goal: number, opts: SearchOptions, rec: Recorder): SearchResult;
}

export function emptyResult(status: SearchStatus, note?: string): SearchResult {
  return { status, path: [], expanded: 0, pushes: 0, maxOpen: 0, note };
}

/** Walk parent pointers back from the goal. */
export function tracePath(parent: Int32Array, start: number, goal: number): number[] {
  const path: number[] = [];
  let c = goal;
  let guard = parent.length + 1;
  while (c !== -1 && guard-- > 0) {
    path.push(c);
    if (c === start) break;
    c = parent[c];
  }
  return path.reverse();
}
