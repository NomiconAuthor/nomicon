/**
 * "Timing the GPU": a frame whose GPU cost is a dial. The work pass draws `layers` full-screen
 * triangles (one instanced draw) into a TIME_W × TIME_H target, each fragment running a loop of
 * `iterations`; the present pass copies the result to the canvas. No DOM, no GPU: the plan and the
 * counts a pipeline-statistics query would report come from here, so the claims can check them.
 * Timings are the reader's and are only ever shown live.
 */
import { type FramePlan } from '../gpu/plan';

export const TIME_W = 640;
export const TIME_H = 360;
export const LAYERS = [1, 2, 4, 8, 16, 32, 64];
export const ITERATIONS = [1, 4, 16, 64, 256];

export interface TimingSettings {
  layers: number;
  iterations: number;
}
export const TIMING_DEFAULTS: TimingSettings = { layers: 8, iterations: 16 };

export const TPASS = { work: 'work', present: 'present' } as const;

export function timingPlan(s: TimingSettings): FramePlan {
  return {
    passes: [
      { name: TPASS.work, target: `colour, ${TIME_W} × ${TIME_H}`, w: TIME_W, h: TIME_H, draws: [{ name: 'full-screen triangles', pipeline: 'work', indexed: false, count: 3, instances: s.layers }] },
      { name: TPASS.present, target: 'the canvas', w: 0, h: 0, draws: [{ name: 'full-screen triangle', pipeline: 'present', indexed: false, count: 3, instances: 1 }] },
    ],
  };
}

/**
 * What a pipeline-statistics query around the work pass would count, by D3D12's names
 * (D3D12_QUERY_DATA_PIPELINE_STATISTICS; Vulkan's VK_QUERY_PIPELINE_STATISTIC_* bits count the
 * same things). Each full-screen triangle covers every pixel centre of the target once.
 */
export function pipelineStatistics(s: TimingSettings) {
  return {
    IAVertices: 3 * s.layers,
    IAPrimitives: s.layers,
    VSInvocations: 3 * s.layers,
    CInvocations: s.layers,
    PSInvocations: s.layers * TIME_W * TIME_H,
    /** Not a statistic any API reports: the loop iterations those invocations run. */
    loopIterations: s.layers * TIME_W * TIME_H * s.iterations,
  };
}
