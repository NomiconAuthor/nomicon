// Claims for rendering/shadow-maps.mdx: acne and leak counts from the CPU model
// (scenes/shadow-maps.ts), texel sizes, split distances, and the renderers' draws on the Node stubs.
import { claim, d1, fact } from '../core';
import { CallLog } from '../../../src/render/gpu/record';
import { DRAW_METHODS, planStats } from '../../../src/render/gpu/plan';
import { stubWebGl2, stubWebGpu } from '../../../src/render/gpu/stub';
import { createShadows } from '../../../src/render/gpu/shadow-maps';
import { lengthText } from '../../../src/render/scenes/common';
import { KEY_LIGHT } from '../../../src/render/gpu/scene';
import {
  CASCADES,
  GOOD_BIAS,
  MAX_TAN,
  MODEL_H,
  MODEL_W,
  SHADOW_DEFAULTS,
  SHADOW_DISTANCE,
  type ShadowSettings,
  VIEW_H,
  VIEW_W,
  cascadeBoxes,
  pixelFootprint,
  sceneBox,
  shadowPlan,
  shadowStats,
  splits,
} from '../../../src/render/scenes/shadow-maps';

const P = 'rendering/shadow-maps.mdx';
const pc = (n: number, of: number) => `${d1((100 * n) / of)}%`;

async function draws(kind: 'webgpu' | 'webgl2', s: ShadowSettings): Promise<number> {
  const log = new CallLog();
  const r = await createShadows(kind === 'webgpu' ? stubWebGpu(640, 400) : stubWebGl2(640, 400), log);
  r.frame(s);
  log.start('frame');
  r.frame(s);
  log.stop();
  return log.of('frame').filter((c) => DRAW_METHODS.has(c.method)).length;
}

export default async function shadows(): Promise<void> {
  const D = SHADOW_DEFAULTS;
  fact(P, D.bias === 0 && D.slope === 0 && D.res === 1024 && !D.cascades, 'the widget starts with no bias, one 1024 map');
  fact(P, D.sun.y < KEY_LIGHT.dir.y && D.sun.x > 0, "the starting sun is lower than KEY_LIGHT and on the right");
  claim(P, `a ray through each pixel of a ${MODEL_W} × ${MODEL_H} image`);

  const none = shadowStats(D);
  claim(P, `With no bias, ${pc(none.acne, none.lit)} of the sunlit pixels the model sees get shadowed by mistake.`);
  for (const res of [256, 2048]) {
    const s = shadowStats({ ...D, res });
    fact(P, s.acne / s.lit > 0.45 && s.acne / s.lit < 0.55, `about half the floor is acne at ${res} texels too`);
  }
  const c2 = shadowStats({ ...D, bias: 0.02 });
  const c5 = shadowStats({ ...D, bias: 0.05 });
  claim(P, `At 2 cm, ${pc(c2.acne, c2.lit)} of the sunlit pixels still have acne; at 5 cm, ${pc(c5.acne, c5.lit)}.`);
  claim(P, `(capped at tan θ = ${MAX_TAN}, θ about ${Math.round((Math.atan(MAX_TAN) * 180) / Math.PI)}°`);
  const sl = shadowStats({ ...D, slope: GOOD_BIAS.slope });
  claim(P, `With ${GOOD_BIAS.slope} texels and no constant bias at all, the acne falls to ${pc(sl.acne, sl.lit)} (${sl.acne} pixels).`);
  const good = shadowStats({ ...D, ...GOOD_BIAS });
  const far = shadowStats({ ...D, bias: 0.3, slope: GOOD_BIAS.slope });
  claim(P, `the model counts ${far.leaks} shadowed pixels wrongly lit, against ${good.leaks} with the suggested ${GOOD_BIAS.bias * 100} cm and ${GOOD_BIAS.slope} texels`);
  fact(P, far.leaks > good.leaks && good.leaks >= none.leaks, 'more bias, more light leaking');

  // Texels.
  claim(P, `at 1024 texels across the whole courtyard each texel is ${lengthText(sceneBox(D.sun, 1024).texel)} wide`);
  claim(P, `The ${lengthText(sceneBox(D.sun, 1024).texel)} texels are too coarse`);
  claim(P, `At 5 m from the camera a pixel of the widget's ${VIEW_W} × ${VIEW_H} canvas is about ${lengthText(pixelFootprint(5))} across (more along the floor, which it sees at a slant); at 30 m, about ${lengthText(pixelFootprint(30))}.`);
  claim(P, `doubling the resolution to 2048 only brings the texels to ${lengthText(sceneBox(D.sun, 2048).texel)}`);
  const sp = splits(D.lambda);
  claim(P, `the widget splits the view out to ${SHADOW_DISTANCE} m into ${CASCADES} cascades, each a ${D.res / 2} × ${D.res / 2} quarter of the same texture`);
  claim(P, `At λ = ${D.lambda} they fall at ${d1(sp[1])} m, ${d1(sp[2])} m and ${d1(sp[3])} m, and the texels are ${cascadeBoxes(D).map((b) => lengthText(b.texel)).join(', ').replace(/, ([^,]*)$/, ' and $1')}.`);

  // The frame.
  const one = planStats(shadowPlan(D, 640, 400));
  const cas = planStats(shadowPlan({ ...D, cascades: true }, 640, 400));
  fact(P, one.draws === 6 && cas.draws === 3 * CASCADES + 3, 'each cascade redraws the three meshes');
  claim(P, 'this widget draws each mesh four times into the map, once per cascade');
  for (const kind of ['webgpu', 'webgl2'] as const)
    for (const s of [D, { ...D, cascades: true }, { ...D, view: 'map' as const }]) fact(P, (await draws(kind, s)) === planStats(shadowPlan(s, 640, 400)).draws, `the ${kind} renderer's draws match the plan`);
}
