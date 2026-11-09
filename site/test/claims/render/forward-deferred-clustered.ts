// Claims for rendering/forward-deferred-clustered.mdx: the light lists and per-pixel counts from
// the CPU model (scenes/forward-deferred-clustered.ts), the G-buffer layout and bytes, and the
// renderers' draws against the plan, run on the Node stubs.
import { claim, d1, fact, int } from '../core';
import { CallLog } from '../../../src/render/gpu/record';
import { DRAW_METHODS, planStats } from '../../../src/render/gpu/plan';
import { POINT_LIGHTS } from '../../../src/render/gpu/scene';
import { stubWebGl2, stubWebGpu } from '../../../src/render/gpu/stub';
import { createFdc } from '../../../src/render/gpu/forward-deferred-clustered';
import { courtyardLights } from '../../../src/render/scenes/courtyard';
import {
  FDC_DEFAULTS,
  type FdcSettings,
  GBUFFER,
  GBUFFER_BYTES,
  MODEL_H,
  MODEL_W,
  SLICES,
  SLICE_SCALE,
  TILES_X,
  TILES_Y,
  ZC0,
  ZC1,
  buildLists,
  bytesPerPixel,
  emptyCellsWithLights,
  fdcPlan,
  lightsAt,
  listStats,
  kbText,
  mb,
  missedLights,
} from '../../../src/render/scenes/forward-deferred-clustered';

const P = 'rendering/forward-deferred-clustered.mdx';
const kb = kbText;

async function drawsRecorded(kind: 'webgpu' | 'webgl2', s: FdcSettings): Promise<number> {
  const log = new CallLog();
  const r = await createFdc(kind === 'webgpu' ? stubWebGpu(640, 400) : stubWebGl2(640, 400), log);
  const lights = lightsAt(s.lights, 0);
  const input = { lights, colours: lights.map(() => [1, 1, 1] as [number, number, number]), lists: buildLists(lights, s.culling), changed: true };
  r.frame(s, input);
  log.start('frame');
  r.frame(s, { ...input, changed: false });
  log.stop();
  return log.of('frame').filter((c) => DRAW_METHODS.has(c.method)).length;
}

export default async function fdc(): Promise<void> {
  const n = FDC_DEFAULTS.lights;
  const lights = lightsAt(n, 0);
  fact(P, n === 64 && FDC_DEFAULTS.culling === 'clusters' && FDC_DEFAULTS.shading === 'deferred', 'the widget starts deferred, with clusters and 64 lights');
  const all = courtyardLights(256);
  fact(P, POINT_LIGHTS.every((l, i) => all[i].name === l.name) && all.slice(3).every((l) => l.radius >= 1.5 && l.radius <= 3.5), 'the first three lights are POINT_LIGHTS; the rest have radii between 1.5 and 3.5 m');
  claim(P, `a ray through each pixel of a ${MODEL_W} × ${MODEL_H} image of the same scene`);

  const none = listStats(lights, 'none');
  const tiles = listStats(lights, 'tiles');
  const clusters = listStats(lights, 'clusters');
  claim(P, `with the default 64 lights, ${none.perPixel} per pixel, when the model finds only ${d1(none.reaching)} lights actually reach the average pixel`);

  // The G-buffer.
  for (const t of GBUFFER) claim(P, `| ${t.name} | \`${t.format}\` | ${t.bytes} | ${t.holds} |`);
  claim(P, `That's ${GBUFFER_BYTES} bytes per pixel`);
  claim(P, `this layout moves ${bytesPerPixel('deferred')} bytes per pixel against forward's ${bytesPerPixel('forward')} (colour and depth)`);
  const px = 1920 * 1080;
  claim(P, `At 1920 × 1080 that's ${d1(mb(bytesPerPixel('deferred') * px))} MB a frame against ${d1(mb(bytesPerPixel('forward') * px))} MB`);
  claim(P, `(here ${GBUFFER_BYTES} bytes per pixel written and read back)`);

  // Tiles.
  claim(P, `The widget's grid is ${TILES_X} × ${TILES_Y} tiles of the canvas, ${TILES_X * TILES_Y} in all`);
  claim(P, `With 64 lights the average pixel now looks at ${d1(tiles.perPixel)} lights instead of ${n}, but the worst pixel still looks at ${tiles.worstPixel}.`);

  // Clusters.
  fact(P, ZC0 === 1 && ZC1 === 64 && SLICES === 16 && Math.abs(2 ** (1 / SLICE_SCALE) - 2 ** (3 / 8)) < 1e-12, 'slices from 1 m to 64 m, each 2^(3/8) times deeper than the last');
  claim(P, `The widget uses ${SLICES} slices from ${ZC0} m to ${ZC1} m, each 2<sup>3/8</sup> (about ${(2 ** (3 / 8)).toFixed(1)}) times deeper than the last`);
  claim(P, `${TILES_X} × ${TILES_Y} × ${SLICES} = ${int(TILES_X * TILES_Y * SLICES)} clusters`);
  const row = (name: string, s: ReturnType<typeof listStats>) => `| ${name} | ${Number.isInteger(s.perPixel) ? s.perPixel : d1(s.perPixel)} | ${s.worstPixel} | ${int(s.entries)} | ${kb(s.bytes)} |`;
  claim(P, row('None', none));
  claim(P, row('Tiles', tiles));
  claim(P, row('Clusters', clusters));
  fact(P, clusters.worstPixel * 2 <= tiles.worstPixel + 2 && clusters.perPixel < tiles.perPixel, 'clusters beat tiles a little on average and halve the worst pixel');
  fact(P, missedLights(lights, 'tiles') === 0 && missedLights(lights, 'clusters') === 0 && missedLights(lightsAt(256, 0), 'clusters') === 0, 'no pixel loses a light that reaches it, with tiles or clusters');
  const used = Array.from(buildLists(lights, 'clusters').count).filter((c) => c > 0).length;
  const e = emptyCellsWithLights(lights, 'clusters');
  claim(P, `of the ${int(used)} clusters that get a light, only ${e.occupied} hold a surface that a pixel of the model's image sees`);
  fact(P, used - e.wasted === e.occupied, 'every cluster holding a surface has a light');

  // The frame, and the renderers against it.
  const fwd = planStats(fdcPlan({ ...FDC_DEFAULTS, shading: 'forward' }, 640, 400));
  const def = planStats(fdcPlan(FDC_DEFAULTS, 640, 400));
  fact(P, fwd.passes === 1 && fwd.draws === 3 && def.passes === 2 && def.draws === 4, 'forward is one pass of three draws; deferred adds a lighting pass with one draw');
  for (const kind of ['webgpu', 'webgl2'] as const)
    for (const shading of ['forward', 'deferred'] as const) {
      const s = { ...FDC_DEFAULTS, shading };
      fact(P, (await drawsRecorded(kind, s)) === planStats(fdcPlan(s, 640, 400)).draws, `the ${kind} renderer's ${shading} draws match the plan`);
    }
}
