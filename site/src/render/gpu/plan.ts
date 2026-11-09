/**
 * A frame as data: the CPU-side model each GPU lesson keeps for its deterministic numbers.
 *
 * A lesson's scenes/<slug>.ts builds a FramePlan (which passes, which draws in each, with which
 * pipeline and how many indices) with no DOM and no GPU. Its renderers (WebGPU and WebGL2) walk
 * the plan to issue their calls, so the plan can't drift from what's drawn; the widget shows
 * planStats(plan); and the claims check the lesson's text against the plan in Node. Timings are
 * the only numbers a plan can't give, and lessons show those live.
 */

export interface DrawPlan {
  /** What's drawn, for the readouts: 'floor', 'box', 'full-screen triangle'. */
  name: string;
  /** The renderer's key for the pipeline (WebGPU) or program and state (WebGL2) it needs. */
  pipeline: string;
  /** An indexed draw's index count, or a non-indexed draw's vertex count. */
  indexed: boolean;
  count: number;
  instances: number;
}
export interface PassPlan {
  name: string;
  /** What it renders into, for the readouts. */
  target: string;
  /** Size of the target in pixels (0 × 0 when it is the canvas, whose size the browser decides). */
  w: number;
  h: number;
  draws: DrawPlan[];
}
export interface FramePlan {
  passes: PassPlan[];
}

/** Triangles a draw submits (triangle lists only): before any culling or clipping. */
export const drawTriangles = (d: DrawPlan) => Math.floor(d.count / 3) * d.instances;

export interface PlanStats {
  passes: number;
  draws: number;
  triangles: number;
}
export function planStats(p: FramePlan): PlanStats {
  const draws = p.passes.flatMap((x) => x.draws);
  return { passes: p.passes.length, draws: draws.length, triangles: draws.reduce((s, d) => s + drawTriangles(d), 0) };
}

/** Draw-call methods in either API, for checking a recorded frame against its plan. */
export const DRAW_METHODS = new Set(['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']);
