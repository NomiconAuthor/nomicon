import type { GridSpace } from '../graph/gridSpace';
import { measurePath, shortcut, type SmoothingId } from '../post/smooth';
import { heuristicWarning, type HeuristicId } from '../search/heuristics';
import { algorithmById } from '../search/registry';
import { Recorder, emptyResult } from '../search/types';
import { CellImage, drawTree, type Palette } from '../ui/renderer';
import { cellCenter, type Message, type Plan, type PlanContext, type Pt, type RepView, type ViewRect } from './types';

export interface GridLaneConfig {
  alg: string;
  heuristic: HeuristicId;
  weight: number;
  smoothing: SmoothingId;
}

/** Draws per-cell search state through a one-pixel-per-cell image. */
export class GridStateView implements RepView {
  nodeCount: number;
  private img: CellImage;
  constructor(
    readonly space: GridSpace,
    private pal: Palette,
  ) {
    this.nodeCount = space.count;
    this.img = new CellImage(space.w, space.h);
  }
  drawStructure(): void {}
  nodeAt(x: number, y: number): number {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    return cx >= 0 && cy >= 0 && cx < this.space.w && cy < this.space.h ? cy * this.space.w + cx : -1;
  }
  nodeLabel(id: number): string {
    return `Cell ${id % this.space.w}, ${Math.floor(id / this.space.w)}`;
  }
  drawState(ctx: CanvasRenderingContext2D, v: ViewRect, status: Uint8Array, parent: Int32Array, current: number, tree: boolean): void {
    const px = this.img.px;
    // Light tints so terrain stays readable underneath; when zoomed in enough, open
    // cells are drawn as outlines instead of fills so they don't hide anything.
    const rings = v.cs >= 5;
    const open = this.pal.packed('--open', rings ? 0.1 : undefined);
    // A theme can ask for expanded cells as inset tiles rather than full fills
    // (--closed-style: inset), which keeps the floor, terrain and grid visible on light maps.
    const insetClosed = rings && this.pal.get('--closed-style') === 'inset';
    const closed = insetClosed ? 0 : this.pal.packed('--closed');
    const scan = this.pal.packed('--scan');
    for (let i = 0; i < status.length; i++) {
      const s = status[i];
      px[i] = s === 0 ? 0 : s === 2 ? closed : s === 1 ? open : scan;
    }
    this.img.commit();
    this.img.draw(ctx, v.cs);
    const w = this.space.w;
    if (insetClosed) {
      const cs = v.cs;
      const m = Math.max(1, cs * 0.12);
      ctx.fillStyle = this.pal.get('--closed');
      for (let y = Math.max(0, v.y0); y <= Math.min(this.space.h - 1, v.y1); y++)
        for (let x = Math.max(0, v.x0); x <= Math.min(w - 1, v.x1); x++)
          if (status[y * w + x] === 2) ctx.fillRect(x * cs + m, y * cs + m, cs - 2 * m, cs - 2 * m);
    }
    if (rings) {
      const cs = v.cs;
      const lw = Math.max(1, Math.min(2.5, cs * 0.09));
      const inset = lw / 2 + Math.max(0.5, cs * 0.06);
      ctx.strokeStyle = this.pal.get('--open-ring');
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let y = Math.max(0, v.y0); y <= Math.min(this.space.h - 1, v.y1); y++)
        for (let x = Math.max(0, v.x0); x <= Math.min(w - 1, v.x1); x++)
          if (status[y * w + x] === 1) ctx.rect(x * cs + inset, y * cs + inset, cs - 2 * inset, cs - 2 * inset);
      ctx.stroke();
    }
    if (tree) {
      drawTree(
        ctx,
        v.cs,
        status,
        parent,
        (i) => cellCenter(this.space, i),
        (i) => {
          const x = i % w;
          const y = (i - x) / w;
          return x >= v.x0 && x <= v.x1 && y >= v.y0 && y <= v.y1;
        },
        this.pal.get('--tree'),
      );
    }
    if (current >= 0) markCell(ctx, v.cs, current % w, Math.floor(current / w), this.pal);
  }
}

export function markCell(ctx: CanvasRenderingContext2D, cs: number, x: number, y: number, pal: Palette): void {
  ctx.strokeStyle = pal.get('--walker');
  const pad = Math.max(1, cs * 0.06);
  ctx.lineWidth = Math.max(1.5, cs * 0.12);
  const s = Math.max(cs, 6);
  ctx.strokeRect(x * cs + cs / 2 - s / 2 + pad, y * cs + cs / 2 - s / 2 + pad, s - 2 * pad, s - 2 * pad);
}

/** Runs one of the stage 1 grid algorithms. */
export function planOnGrid(ctx: PlanContext, cfg: GridLaneConfig, pal: Palette): Plan {
  const { space, start, goal } = ctx;
  const def = algorithmById(cfg.alg);
  const opts = { heuristic: cfg.heuristic, weight: cfg.weight };
  const messages: Message[] = [];
  const rec = new Recorder(true);
  const view = new GridStateView(space, pal);
  const base = {
    rec,
    view,
    rawPath: [] as Pt[],
    finalPath: [] as Pt[],
    length: NaN,
    cost: NaN,
    queryMs: NaN,
    extra: [] as Array<[string, string]>,
    messages,
  };
  const reason = def.check(space);
  if (reason) {
    messages.push({ text: reason, bad: true });
    return { ...emptyResult('unusable'), ...base };
  }
  let reps = 0;
  const t0 = performance.now();
  let elapsed = 0;
  do {
    def.run(space, start, goal, opts, new Recorder(false));
    reps++;
    elapsed = performance.now() - t0;
  } while (elapsed < 12 && reps < 200);
  const r = def.run(space, start, goal, opts, rec);
  const warn = def.usesHeuristic ? heuristicWarning(cfg.heuristic, space.opts.diagonal !== 'never', def.family === 'Any-angle') : null;
  if (warn) messages.push({ text: warn, bad: false });
  if (rec.truncated) messages.push({ text: 'Recording hit its size limit; playback shows the first part only.', bad: false });
  const priority: Plan['priority'] =
    cfg.alg === 'dijkstra' ? 'g' : cfg.alg === 'weighted' ? 'g+wh' : cfg.alg === 'greedy' ? 'h' : cfg.alg === 'bfs' ? 'depth' : 'g+h';
  const plan: Plan = { ...base, ...r, queryMs: elapsed / reps, unitNote: 'searched from scratch', idSpace: 'shared', priority, weight: cfg.weight };
  if (r.status === 'found') {
    const smooth = cfg.smoothing === 'shortcut' ? shortcut(space, r.path) : r.path;
    const m = measurePath(space, smooth);
    plan.rawPath = r.path.map((n) => cellCenter(space, n));
    plan.finalPath = cfg.smoothing === 'shortcut' ? smooth.map((n) => cellCenter(space, n)) : plan.rawPath;
    plan.length = m.length;
    plan.cost = m.cost;
  }
  return plan;
}
