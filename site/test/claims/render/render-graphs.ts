// Claims for rendering/render-graphs.mdx: what the graph compiler (src/render/scenes/render-graphs.ts)
// keeps, culls, transitions and allocates for the frames the lesson describes.
import { claim, fact } from '../core';
import { FRAME_DEFAULTS, SCREENS, compile, declare, mbText } from '../../../src/render/scenes/render-graphs';

export default function renderGraphs(): void {
  const P = 'rendering/render-graphs.mdx';
  const all = compile(declare(FRAME_DEFAULTS));
  const run = (c: ReturnType<typeof compile>) => c.order.length;
  claim(P, `The frame is a deferred renderer's: ${all.passes.length} passes declared when everything is on.`);
  claim(P, `With everything on, ${run(all)} of the ${all.passes.length} passes run.`);
  const culled = all.passes.filter((p) => p.culled).map((p) => p.pass.name);
  fact(P, culled.length === 1 && culled[0] === 'Debug view', 'with everything on, only the debug view is culled');
  const noTaa = compile(declare({ ...FRAME_DEFAULTS, taa: false }));
  claim(P, `so ${run(noTaa)} of ${noTaa.passes.length} passes run.`);
  fact(P, noTaa.passes.some((p) => p.culled && p.pass.name === 'Motion vectors'), 'without TAA the motion-vector pass is culled');
  const dbg = compile(declare({ ...FRAME_DEFAULTS, output: 'normals' }));
  claim(P, `the graph keeps ${run(dbg)} passes: the depth prepass, the G-buffer, the debug view and the final pass.`);
  fact(P, dbg.order.map((i) => dbg.passes[i].pass.name).join() === 'Depth prepass,G-buffer,Debug view,Tone map and UI', 'the debug output keeps exactly those four passes');
  claim(P, `${dbg.passes.filter((p) => p.culled).length} passes in all, are culled`);
  const lv = Object.fromEntries(all.passes.map((p) => [p.pass.name, p.level]));
  fact(P, lv['Shadow map'] === 0 && lv['Depth prepass'] === 0 && lv['G-buffer'] === 1, 'dependency levels: shadow map and depth prepass 0, G-buffer 1');
  claim(P, `With everything on, the frame needs ${all.transitions} transitions in ${all.barrierCalls} barrier calls.`);
  const light = all.passes.find((p) => p.pass.name === 'Lighting')!;
  fact(P, light.barriers.map((b) => b.res).sort().join() === ['AO', 'HDR', 'albedo', 'material', 'shadow map'].sort().join(), `lighting's transitions are albedo, material, shadow map, AO and HDR (got ${light.barriers.map((b) => b.res).join(', ')})`);
  claim(P, `With everything on at 1080p, the transients add up to ${mbText(all.totalBytes)}; aliased, the heap's peak is ${mbText(all.peakBytes)}, with ${all.aliasingBarriers} aliasing barriers`);
  const aliased = all.passes.flatMap((p) => p.aliasing).sort().join();
  fact(P, aliased === ['TAA out', 'bloom A', 'bloom B'].sort().join(), `bloom A, bloom B and the TAA output reuse memory (got ${aliased})`);
  const [w4, h4] = SCREENS['4K'];
  const k4 = compile(declare(FRAME_DEFAULTS), w4, h4);
  claim(P, `At 4K it's ${mbText(k4.totalBytes)} against ${mbText(k4.peakBytes)}.`);
  const life = (n: string) => all.placements.find((p) => p.res === n)!;
  fact(P, ['shadow map', 'depth', 'motion'].every((n) => life(n).last >= all.order.length / 2), 'the shadow map, depth and motion vectors live into the second half of the frame');
  const none = compile(declare(FRAME_DEFAULTS), 1920, 1080, false);
  fact(P, none.peakBytes === all.totalBytes, 'without aliasing the heap is the sum of the transients');
}
