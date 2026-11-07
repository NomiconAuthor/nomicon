// Claims for rendering/overdraw-and-fill-rate.mdx: the CPU model's fragment counts (the numbers
// the lesson quotes and the widget's table shows), and the renderers run against the Node stubs
// to check they issue the plan's draws.
import { claim, fact, int, pct } from '../core';
import { CallLog } from '../../../src/render/gpu/record';
import { DRAW_METHODS, planStats } from '../../../src/render/gpu/plan';
import { type FillColours, createFill } from '../../../src/render/gpu/overdraw-and-fill-rate';
import { stubWebGl2, stubWebGpu } from '../../../src/render/gpu/stub';
import { FILL_DEFAULTS, FILL_PIXELS, MAX_PARTICLES, type FillSettings, fillCounts, fillPlan, opaqueCards, particleCards } from '../../../src/render/scenes/overdraw-and-fill-rate';

const C: FillColours = { bg: [0, 0, 0], cards: Array(6).fill([1, 2, 3]), smoke: [9, 9, 9], heat: Array(7).fill([4, 5, 6]) };

export default async function overdraw(): Promise<void> {
  const P = 'rendering/overdraw-and-fill-rate.mdx';
  const at = (o: Partial<FillSettings>) => fillCounts({ ...FILL_DEFAULTS, ...o });
  const d = at({});
  claim(P, `a background, ${opaqueCards().length - 1} opaque trunks and bushes at different depths, and up to ${int(MAX_PARTICLES)} smoke particles`);
  claim(P, `the frame has ${int(FILL_PIXELS)} pixels and shades ${int(d.shaded)} fragments: ${d.perPixel.toFixed(2)} per pixel`);
  claim(P, `The particles are ${int(d.particles)} of them, ${pct((100 * d.particles) / d.shaded)}`);

  // Opaque order and the prepass.
  claim(P, `they shade ${int(d.opaque)} fragments, ${(d.opaque / FILL_PIXELS).toFixed(2)} per pixel`);
  const b2f = at({ order: 'back-to-front' });
  claim(P, `every card passes the depth test against everything drawn so far: ${int(b2f.opaque)}, ${(b2f.opaque / FILL_PIXELS).toFixed(2)} per pixel`);
  const f2b = at({ order: 'front-to-back' });
  claim(P, `every card behind it fails the early depth test: ${int(f2b.opaque)}, one per pixel`);
  fact(P, f2b.opaque === FILL_PIXELS, 'front to back, each pixel is shaded once');
  for (const order of ['back-to-front', 'unsorted', 'front-to-back'] as const) {
    const p = at({ prepass: true, order });
    fact(P, p.opaque === FILL_PIXELS && p.prepass === b2f.opaque, `with a prepass, ${order} shades each pixel once after every opaque fragment as depth only`);
  }
  claim(P, `A **depth prepass** gets the same ${int(FILL_PIXELS)} in any order, after ${int(b2f.opaque)} depth-only fragments`);
  fact(P, b2f.particles === d.particles && f2b.particles === d.particles, 'the particle count does not depend on the opaque order');

  // Particles.
  claim(P, `here, ${int(d.particlesCovered - d.particles)} particle fragments fail the depth test against the trees`);
  const big = at({ size: 96 });
  claim(P, `At **96 px** the same plume shades ${int(big.shaded)} fragments, ${big.perPixel.toFixed(2)} per pixel`);
  const octagon = 2 * (Math.SQRT2 - 1);
  claim(P, `a regular octagon around the circle covers ${pct(100 * octagon)} of the square`);
  const trim = at({ shape: 'trimmed' });
  claim(P, `cuts the particle fragments from ${int(d.particles)} to ${int(trim.particles)}, ${pct((100 * trim.particles) / d.particles)}`);
  fact(P, particleCards(48, 'trimmed').every((c) => c.k >= c.hx * Math.tan(Math.PI / 8) && Number.isInteger(c.k - 0.5)), 'every octagon encloses its puff and has its cut on a half pixel');
  const half = at({ halfRes: true });
  claim(P, `the particles shade ${int(half.particles)} fragments instead of ${int(d.particles)}, the composite adds one per pixel (${int(half.composite)}) and the depth downsample ${int(half.downsample)} depth-only ones, for ${int(half.shaded)} in all, ${half.perPixel.toFixed(2)} per pixel`);
  for (const cost of [1, 128]) fact(P, at({ cost }).shaded === d.shaded, `the shader cost (${cost}) doesn't change the counts`);
  let heatSum = 0;
  for (const v of half.heat) heatSum += v;
  // Each half-resolution fragment covers four pixels at a quarter each, so the heat map still sums to the count.
  fact(P, Math.abs(heatSum - half.shaded) < 1e-3, 'the half-resolution heat map counts a particle fragment as a quarter at each of its four pixels');

  // The renderers walk the plan: one instanced draw per card layer, one per full-screen pass.
  for (const [api, make] of [
    ['WebGPU', () => stubWebGpu(640, 360)],
    ['WebGL2', () => stubWebGl2(640, 360)],
  ] as const) {
    const log = new CallLog();
    const r = await createFill(make(), log);
    for (const s of [FILL_DEFAULTS, { ...FILL_DEFAULTS, prepass: true, halfRes: true, shape: 'trimmed' as const }])
      for (const view of ['colour', 'heat'] as const) {
        log.clear();
        log.start('frame');
        const { plan } = r.frame(s, view, C);
        log.stop();
        const draws = log.of('frame').filter((c) => DRAW_METHODS.has(c.method));
        fact(P, draws.length === planStats(plan).draws, `${api} issues the plan's ${planStats(plan).draws} draws (${view}, ${plan.passes.length} passes)`);
      }
  }
  fact(P, fillPlan({ ...FILL_DEFAULTS, prepass: true, halfRes: true }, 'colour').passes.length === 6, 'with a prepass and half-resolution particles the frame has six passes');
}
