// Claims for rendering/timing-the-gpu.mdx: the work pass's pipeline statistics from the plan, and
// the renderers (run against the Node stubs) issuing one instanced draw for all the layers.
import { claim, fact, int } from '../core';
import { CallLog } from '../../../src/render/gpu/record';
import { DRAW_METHODS, planStats } from '../../../src/render/gpu/plan';
import { createTiming } from '../../../src/render/gpu/timing-the-gpu';
import { stubWebGl2, stubWebGpu } from '../../../src/render/gpu/stub';
import { TIME_H, TIME_W, TIMING_DEFAULTS as D, pipelineStatistics, timingPlan } from '../../../src/render/scenes/timing-the-gpu';

export default async function timing(): Promise<void> {
  const P = 'rendering/timing-the-gpu.mdx';
  const st = pipelineStatistics(D);
  claim(P, `The widget's starting frame draws ${D.layers} layers, so ${st.CInvocations} primitives reach the rasteriser, and each covers all ${int(TIME_W * TIME_H)} pixels of its ${TIME_W} × ${TIME_H} target: ${int(st.PSInvocations)} pixel-shader invocations, running ${int(st.loopIterations)} iterations of the loop between them`);
  const two = pipelineStatistics({ ...D, layers: D.layers * 2 });
  fact(P, two.IAPrimitives === 2 * st.IAPrimitives && two.PSInvocations === 2 * st.PSInvocations && two.VSInvocations === 2 * st.VSInvocations, 'double the layers and every count doubles');
  const more = pipelineStatistics({ ...D, iterations: D.iterations * 4 });
  fact(P, more.PSInvocations === st.PSInvocations && more.IAPrimitives === st.IAPrimitives, 'more iterations change no statistic');
  fact(P, planStats(timingPlan(D)).draws === 2, 'one draw for all the layers, one to present');
  for (const [api, make] of [
    ['WebGPU', () => stubWebGpu(640, 360)],
    ['WebGL2', () => stubWebGl2(640, 360)],
  ] as const) {
    const log = new CallLog();
    const r = await createTiming(make(), log);
    log.start('frame');
    const res = r.frame({ layers: 32, iterations: 64 }, [1, 2, 3]);
    log.stop();
    const draws = log.of('frame').filter((c) => DRAW_METHODS.has(c.method));
    fact(P, draws.length === 2 && draws[0].short.includes('32'), `${api}: the layers are one instanced draw`);
    fact(P, res.cpu >= 0, `${api}: the CPU time is measured`);
  }
}
