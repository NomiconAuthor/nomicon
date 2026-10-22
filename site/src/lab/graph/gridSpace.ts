import { TERRAINS, type GridLayer } from '../world/world';
import type { DiagonalRule } from '../world/clearance';
import type { SearchSpace } from './space';

const SQRT2 = Math.SQRT2;

export interface GridSpaceOptions {
  diagonal: DiagonalRule;
  /** Clearance a cell needs for this unit to stand on it (1 = smallest unit). */
  need: number;
  /** Use terrain cost multipliers; off = every open cell costs 1. */
  useTerrain: boolean;
}

/**
 * A uniform grid as a search space. Node id = y * w + x.
 * Passability comes from the clearance map, so the same grid serves every unit size.
 * Moving between two cells costs distance x the average of their terrain multipliers.
 */
export class GridSpace implements SearchSpace {
  readonly kind = 'Grid';
  readonly count: number;
  readonly uniformCost: boolean;
  readonly minCostPerUnit: number;
  readonly w: number;
  readonly h: number;
  private readonly mult: Float32Array;

  constructor(
    readonly layer: GridLayer,
    readonly clearance: Uint16Array,
    readonly opts: GridSpaceOptions,
  ) {
    this.w = layer.w;
    this.h = layer.h;
    this.count = layer.w * layer.h;
    this.mult = new Float32Array(this.count);
    let min = Infinity;
    let uniform = true;
    for (let i = 0; i < this.count; i++) {
      const m = opts.useTerrain ? TERRAINS[layer.terrain[i]].cost : 1;
      this.mult[i] = m;
      if (this.passable(i)) {
        min = Math.min(min, m);
        if (m !== 1) uniform = false;
      }
    }
    this.minCostPerUnit = min === Infinity ? 1 : min;
    this.uniformCost = uniform;
  }

  passable(id: number): boolean {
    return this.clearance[id] >= this.opts.need;
  }

  ok(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.clearance[y * this.w + x] >= this.opts.need;
  }

  x(id: number): number {
    return (id % this.w) + 0.5;
  }

  y(id: number): number {
    return Math.floor(id / this.w) + 0.5;
  }

  id(x: number, y: number): number {
    return y * this.w + x;
  }

  /** Terrain cost multiplier of a cell (1 when terrain costs are off). */
  multiplier(id: number): number {
    return this.mult[id];
  }

  stepCost(a: number, b: number, dist: number): number {
    return dist * 0.5 * (this.mult[a] + this.mult[b]);
  }

  /** Is the diagonal step from (x, y) by (dx, dy) allowed under the diagonal rule? */
  diagonalAllowed(x: number, y: number, dx: number, dy: number): boolean {
    switch (this.opts.diagonal) {
      case 'never':
        return false;
      case 'noCorner':
        return this.ok(x + dx, y) && this.ok(x, y + dy);
      case 'always':
        return true;
    }
  }

  neighbors(id: number, visit: (n: number, cost: number) => void): void {
    const w = this.w;
    const x = id % w;
    const y = (id - x) / w;
    // Orthogonal first, in a fixed order, so runs are deterministic.
    if (this.ok(x + 1, y)) visit(id + 1, this.stepCost(id, id + 1, 1));
    if (this.ok(x, y + 1)) visit(id + w, this.stepCost(id, id + w, 1));
    if (this.ok(x - 1, y)) visit(id - 1, this.stepCost(id, id - 1, 1));
    if (this.ok(x, y - 1)) visit(id - w, this.stepCost(id, id - w, 1));
    if (this.opts.diagonal === 'never') return;
    for (let k = 0; k < 4; k++) {
      const dx = k === 0 || k === 3 ? 1 : -1;
      const dy = k < 2 ? 1 : -1;
      if (!this.ok(x + dx, y + dy) || !this.diagonalAllowed(x, y, dx, dy)) continue;
      const n = id + dy * w + dx;
      visit(n, this.stepCost(id, n, SQRT2));
    }
  }

  /**
   * Line of sight between cell centres, walking every cell the segment passes through
   * (a DDA traversal). Passing exactly through a corner needs both side cells open,
   * matching the "no corner cutting" rule.
   */
  lineOfSight(a: number, b: number): boolean {
    return this.walkLine(a, b, null);
  }

  /** Straight-line cost: length x the average terrain multiplier of the cells crossed. */
  segmentCost(a: number, b: number): number {
    const len = Math.hypot(this.x(b) - this.x(a), this.y(b) - this.y(a));
    if (this.uniformCost) return len;
    let sum = 0;
    let n = 0;
    this.walkLine(a, b, (c) => {
      sum += this.mult[c];
      n++;
    });
    return n ? (len * sum) / n : len;
  }

  private walkLine(a: number, b: number, each: ((cell: number) => void) | null): boolean {
    const w = this.w;
    let x = a % w;
    let y = (a - x) / w;
    const x1 = b % w;
    const y1 = (b - x1) / w;
    const dx = x1 - x;
    const dy = y1 - y;
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (!this.ok(x, y)) return false;
    each?.(y * w + x);
    let tMaxX = adx ? 0.5 / adx : Infinity;
    let tMaxY = ady ? 0.5 / ady : Infinity;
    const tDX = adx ? 1 / adx : Infinity;
    const tDY = ady ? 1 / ady : Infinity;
    let guard = adx + ady + 2;
    while ((x !== x1 || y !== y1) && guard-- > 0) {
      const diff = tMaxX - tMaxY;
      if (Math.abs(diff) < 1e-9) {
        // Exactly through a corner: follow the diagonal rule (cutting allowed only under "always").
        if (this.opts.diagonal !== 'always' && (!this.ok(x + sx, y) || !this.ok(x, y + sy))) return false;
        x += sx;
        y += sy;
        tMaxX += tDX;
        tMaxY += tDY;
      } else if (diff < 0) {
        x += sx;
        tMaxX += tDX;
      } else {
        y += sy;
        tMaxY += tDY;
      }
      if (!this.ok(x, y)) return false;
      each?.(y * w + x);
    }
    return true;
  }
}
