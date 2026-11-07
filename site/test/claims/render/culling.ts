// Claims for rendering/culling.mdx: every count the lesson quotes, recomputed with the CPU model the
// widget runs (src/render/scenes/culling.ts), plus the GPU view's calls run against the Node stubs.
import { claim, fact, int } from '../core';
import { CallLog } from '../../../src/render/gpu/record';
import { DRAW_METHODS, planStats } from '../../../src/render/gpu/plan';
import { stubWebGl2, stubWebGpu } from '../../../src/render/gpu/stub';
import { type CityColours, TONES, createCity } from '../../../src/render/gpu/culling';
import {
  CITY_SIDE,
  CullModel,
  LOD_DIVS,
  MODEL_H,
  MODEL_W,
  OCCLUDER_HEIGHT,
  type OcclusionMode,
  WALK_FRAMES,
  city,
  cullRecords,
  lodTriangles,
  walkCam,
} from '../../../src/render/scenes/culling';

const C: CityColours = { bg: [0, 0, 0], tones: Array.from({ length: TONES }, () => [255, 255, 255] as [number, number, number]) };

export default async function culling(): Promise<void> {
  const P = 'rendering/culling.mdx';
  const m = new CullModel();
  const n = m.buildings.length;
  claim(P, `a city of ${n} box-shaped buildings`);
  fact(P, n === CITY_SIDE * CITY_SIDE, 'one building per block');
  claim(P, `it rasterises depth at ${MODEL_W} × ${MODEL_H}`);

  // Frustum: frame 10.
  const K = 10;
  const box = { frustum: 'box', occlusion: 'off', lod: false } as const;
  const sph = m.counts(K, { ...box, frustum: 'sphere' });
  const bx = m.counts(K, box);
  claim(P, `In frame ${K}, testing spheres culls ${sph.frustumCulled} buildings and testing boxes culls ${bx.frustumCulled}: ${bx.frustumCulled - sph.frustumCulled} more buildings skipped`);
  const vis = m.truth(K).visible.filter(Boolean).length;
  claim(P, `In frame ${K} the camera looks up a long street with the whole city in front of it: ${bx.drawn} buildings pass the frustum test, and ${vis} of them are really visible.`);

  // Occlusion table at frame 10.
  const occluders = city(CITY_SIDE).filter((b) => b.occluder).length;
  claim(P, `**HZB, occluders** uses the ${occluders} buildings ${OCCLUDER_HEIGHT} m or taller.`);
  claim(P, `At frame ${K}, walking up the street, with boxes for the frustum:`);
  const rows: Array<[OcclusionMode, string]> = [
    ['off', 'Off'],
    ['occluders', 'HZB, occluders'],
    ['last', "HZB, last frame's"],
    ['two-phase', 'Two-phase'],
    ['queries', 'Queries'],
  ];
  const at10 = Object.fromEntries(rows.map(([o]) => [o, m.counts(K, { ...box, occlusion: o })])) as Record<OcclusionMode, ReturnType<CullModel['counts']>>;
  for (const [o, label] of rows) {
    const c = at10[o];
    claim(P, `| ${label} | ${c.occlusionTests} | ${c.occluded} | ${c.drawn} | ${c.wasted} | ${c.missed} |`);
  }
  claim(P, `The HZB methods still draw far more than the ${vis} visible buildings`);
  for (const o of ['occluders', 'last', 'two-phase'] as const) fact(P, at10[o].drawn > 4 * vis, `${o}: the HZB draws far more than the visible buildings at frame ${K}`);

  // The turn: frame 29.
  const T = 29;
  const last = m.counts(T, { ...box, occlusion: 'last' });
  const two = m.counts(T, { ...box, occlusion: 'two-phase' });
  const q = m.counts(T, { ...box, occlusion: 'queries' });
  claim(P, `Now step to frame ${T}, in the middle of the turn. Last frame's HZB culls ${last.missed} buildings that are really visible`);
  fact(P, two.missed === 0, 'two-phase misses nothing at the turn');
  claim(P, `Two-phase culls none of them: it draws ${two.phase1} in its first phase and ${two.drawn - two.phase1} more in its second.`);
  claim(P, `in frame ${T}, **Queries** culls ${q.missed} visible buildings`);
  claim(P, `so the model's queries cull more than the HZB and keep only ${at10.queries.drawn} buildings at frame ${K}, but ${at10.queries.missed} visible ones go missing there too`);
  fact(P, at10.queries.occluded > at10.last.occluded, 'queries cull more than last frame\'s HZB at frame 10');

  // Conservative methods never miss anything, on any frame of the walk; two-phase never misses.
  let worst = 0;
  for (let k = 0; k < WALK_FRAMES; k++) for (const o of ['off', 'occluders', 'two-phase'] as const) for (const fr of ['sphere', 'box'] as const) worst = Math.max(worst, m.counts(k, { frustum: fr, occlusion: o, lod: false }).missed);
  fact(P, worst === 0, 'frustum culling, this frame\'s occluders and two-phase never cull a visible building on any frame of the walk');

  // Levels of detail.
  claim(P, `a box with each face cut into ${LOD_DIVS.map((d) => `${d} × ${d}`).join(', ').replace(/, ([^,]*)$/, ' or $1')} squares, ${LOD_DIVS.map((_, l) => lodTriangles(l)).join(', ').replace(/, ([^,]*)$/, ' and $1')} triangles`);
  claim(P, `all ${lodTriangles(0)} of its triangles`);
  const lod = m.counts(K, { ...box, lod: true });
  claim(P, `the ${bx.drawn} buildings in the frustum drop from ${int(bx.triangles)} triangles to ${int(lod.triangles)}`);
  const lodLast = m.counts(K, { ...box, occlusion: 'last', lod: true });
  claim(P, `With last frame's HZB as well, ${lodLast.drawn} buildings are drawn with ${int(lodLast.triangles)} triangles.`);

  // The GPU view draws what the model kept: the ground plus one instanced draw per level.
  for (const kind of ['webgpu', 'webgl2'] as const) {
    const log = new CallLog();
    const r = await createCity(kind === 'webgpu' ? stubWebGpu(640, 360) : stubWebGl2(640, 360), log);
    const f = m.frame(K, { ...box, lod: true });
    log.start('frame');
    const plan = r.frame(walkCam(K, 16 / 9), cullRecords(m.buildings, f), C);
    log.stop();
    const draws = log.of('frame').filter((c) => DRAW_METHODS.has(c.method));
    fact(P, draws.length === planStats(plan).draws, `${kind}: the camera view's recorded draws match its plan`);
    const inst = plan.passes[0].draws.slice(1).reduce((s, d) => s + d.instances, 0);
    fact(P, inst === lod.drawn, `${kind}: the GPU draws the ${lod.drawn} buildings the model kept`);
  }
}
