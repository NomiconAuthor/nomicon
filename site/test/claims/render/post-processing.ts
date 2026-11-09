// Claims for rendering/post-processing.mdx: tone curve values, the jitter sequence, history
// numbers, the bloom chain's sizes and bytes, and the renderers' draws against the plan on the stubs.
import { claim, d1, d2, fact, pct } from '../core';
import { CallLog } from '../../../src/render/gpu/record';
import { DRAW_METHODS, planStats } from '../../../src/render/gpu/plan';
import { stubWebGl2, stubWebGpu } from '../../../src/render/gpu/stub';
import { createPost } from '../../../src/render/gpu/post-processing';
import {
  BLOOM_LEVELS,
  BLOOM_STRENGTH,
  HDR_BYTES,
  JITTER_COUNT,
  LAMP_COUNT,
  LAMP_GLOW,
  POST_DEFAULTS,
  type PostSettings,
  TAA_ALPHA,
  WHITE,
  bloomBytes,
  bloomSizes,
  effectiveSamples,
  framesBelow,
  halton,
  inputFor,
  postPasses,
  postPlan,
  staleAfter,
  tone,
} from '../../../src/render/scenes/post-processing';

const P = 'rendering/post-processing.mdx';
// Decimal megabytes (10^6 bytes), as the rest of the section.
const mb = (b: number) => d1(b / 1e6);

async function draws(kind: 'webgpu' | 'webgl2', s: PostSettings): Promise<number> {
  const log = new CallLog();
  const r = await createPost(kind === 'webgpu' ? stubWebGpu(640, 400) : stubWebGl2(640, 400), log);
  const input = { t: 0, colours: Array.from({ length: LAMP_COUNT }, () => [1, 1, 1] as [number, number, number]) };
  r.frame(s, input);
  log.start('frame');
  r.frame(s, input);
  log.stop();
  return log.of('frame').filter((c) => DRAW_METHODS.has(c.method)).length;
}

export default async function post(): Promise<void> {
  claim(P, `sixteen point lights, each with a small cube that glows at ${LAMP_GLOW} times the brightness of white`);
  fact(P, LAMP_COUNT === 16, 'sixteen lamps');
  claim(P, `through a chain of ${BLOOM_LEVELS} downsamples and ${BLOOM_LEVELS - 1} upsamples`);
  claim(P, `That's ${postPasses(POST_DEFAULTS, 1920, 1080).length} passes with everything on`);
  claim(P, `at ${HDR_BYTES} bytes per pixel instead of 4: ${mb(1920 * 1080 * HDR_BYTES)} MB at 1920 × 1080`);

  // Tone curves.
  claim(P, `1 becomes ${tone('reinhard', 1)}, and it takes an input of ${Math.round(inputFor('reinhard', 0.99))} to reach 0.99`);
  claim(P, `With *W* = ${WHITE}, 1 becomes ${d2(tone('reinhard-ext', 1))}.`);
  fact(P, tone('reinhard-ext', WHITE) === 1, 'the extended operator reaches 1 at the white point');
  claim(P, `1 becomes ${d2(tone('aces', 1))} (Narkowicz`);
  claim(P, `and 0.99 is reached at an input of ${d2(inputFor('aces', 0.99))}`);
  claim(P, `(the ACES fit maps 1 to ${d2(tone('aces', 1))})`);

  // Bloom.
  claim(P, `At 1920 × 1080 the levels are ${bloomSizes(1920, 1080).map(([x, y]) => `${x} × ${y}`).join(', ').replace(/, ([^,]*)$/, ' and $1')}.`);
  claim(P, `${BLOOM_STRENGTH} here as in Jimenez's talk`);
  claim(P, `At 1920 × 1080 the chain holds ${mb(bloomBytes(1920, 1080))} MB of half-float textures.`);

  // TAA.
  claim(P, `The widget uses the first ${JITTER_COUNT} points of the Halton (2, 3) sequence`);
  fact(P, halton(1, 2) === 0.5 && halton(2, 3) === 2 / 3 && halton(3, 2) === 0.75, 'Halton values');
  claim(P, `With α = ${TAA_ALPHA} (Salvi`);
  claim(P, `the result has about the noise of an average of ${Math.round(effectiveSamples(TAA_ALPHA))} frames`);
  claim(P, `(α = ${TAA_ALPHA} is about ${Math.round(effectiveSamples(TAA_ALPHA))} frames)`);
  claim(P, `${pct(100 * staleAfter(TAA_ALPHA, 10))} after 10 frames, and it takes ${framesBelow(TAA_ALPHA, 0.1)} frames to fall below 10%`);
  claim(P, '(half floats: 8 bytes per pixel)');

  // The frame.
  for (const kind of ['webgpu', 'webgl2'] as const)
    for (const s of [POST_DEFAULTS, { ...POST_DEFAULTS, taa: false, bloom: false }, { ...POST_DEFAULTS, scale: 0.5 }])
      fact(P, (await draws(kind, s)) === planStats(postPlan(s, 640, 400)).draws, `the ${kind} renderer's draws match the plan`);
}
