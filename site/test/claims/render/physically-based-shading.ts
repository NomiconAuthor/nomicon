// Claims for rendering/physically-based-shading.mdx: the white furnace numbers and the split-sum
// table from the CPU model (scenes/physically-based-shading.ts), the normalisation checks, the
// materials' F0, and the renderers' draws against the plan on the Node stubs.
import { claim, fact, int, pct } from '../core';
import { CallLog } from '../../../src/render/gpu/record';
import { DRAW_METHODS, planStats } from '../../../src/render/gpu/plan';
import { stubWebGl2, stubWebGpu } from '../../../src/render/gpu/stub';
import { createPbr } from '../../../src/render/gpu/physically-based-shading';
import {
  ENV_H,
  ENV_LEVELS,
  ENV_W,
  GRID_COLS,
  GRID_ROWS,
  LUT_SAMPLES,
  LUT_SIZE,
  MATERIALS,
  METAL_F0,
  PBR_DEFAULTS,
  type PbrSettings,
  dNormalisation,
  envBrdf,
  lambertAlbedo,
  materialAlbedo,
  pbrPlan,
  specAlbedo,
} from '../../../src/render/scenes/physically-based-shading';

const P = 'rendering/physically-based-shading.mdx';
const f3 = (x: number) => x.toFixed(3);

async function draws(kind: 'webgpu' | 'webgl2', s: PbrSettings): Promise<number> {
  const log = new CallLog();
  const tables = { lut: new Float32Array(LUT_SIZE * LUT_SIZE * 4), env: new Float32Array(ENV_W * ENV_H * (ENV_LEVELS + 1) * 4) };
  const r = await createPbr(kind === 'webgpu' ? stubWebGpu(640, 400) : stubWebGl2(640, 400), log, tables);
  r.frame(s, [1, 1, 1]);
  log.start('frame');
  r.frame(s, [1, 1, 1]);
  log.stop();
  return log.of('frame').filter((c) => DRAW_METHODS.has(c.method)).length;
}

export default async function pbr(): Promise<void> {
  // Normalisation.
  fact(P, [0, 0.25, 0.5, 0.75, 1].every((r) => Math.abs(dNormalisation(r) - 1) < 1e-3), 'GGX D is normalised for every roughness');
  fact(P, Math.abs(lambertAlbedo() - 1) < 1e-6, "Lambert's 1/π reflects exactly what arrives");

  // Materials.
  claim(P, `linear *F*<sub>0</sub> is (${METAL_F0.gold.map((x) => x.toFixed(2)).join(', ')}) for gold, (${METAL_F0.copper.map((x) => x.toFixed(2)).join(', ')}) for copper and (${METAL_F0.iron.map((x) => x.toFixed(2)).join(', ')}) for iron`);
  fact(P, MATERIALS.filter((m) => m.metal === 0).every((m) => m.reflectance === 0.04), 'dielectric presets default to F0 = 0.04');

  // The white furnace.
  claim(P, `with the ${int(LUT_SAMPLES)} samples per entry Karis's code uses`);
  claim(P, `the specular lobe reflects ${pct(100 * specAlbedo(0, 1))} at roughness 0, ${pct(100 * specAlbedo(0.5, 1))} at roughness 0.5 and only ${pct(100 * specAlbedo(1, 1))} at roughness 1`);
  claim(P, `(${pct(100 * specAlbedo(1, 1))} left at roughness 1 here)`);
  claim(P, `It reflects ${materialAlbedo(1, 0, 0.04, 0, 1).toFixed(2)} times the light that arrives at normal incidence, and up to ${materialAlbedo(1, 0, 0.04, 0, 0.1).toFixed(2)} times at a grazing view (*n*·*v* = 0.1) when it's smooth`);
  fact(P, materialAlbedo(1, 0, 0.04, 0, 1).toFixed(2) === '1.04', 'a smooth white dielectric reflects 1.04 at normal incidence');
  fact(P, [0, 0.25, 0.5, 0.75, 1].every((r) => materialAlbedo(1, 0, 0.04, r, 0.1) <= materialAlbedo(1, 0, 0.04, 0, 0.1)), 'the grazing excess is largest when smooth');

  // The split sum.
  const [A, B] = envBrdf(0.5, 0.5);
  claim(P, `The widget's table is ${LUT_SIZE} × ${LUT_SIZE}; at roughness 0.5 and *n*·*v* = 0.5, *A* is ${f3(A)} and *B* is ${f3(B)}.`);
  claim(P, `${ENV_W} × ${ENV_H} texels per level, for roughness 0, 0.25, 0.5, 0.75 and 1`);
  fact(P, ENV_LEVELS === 5, 'five prefiltered levels');

  // The frame.
  fact(P, PBR_DEFAULTS.layout === 'grid' && GRID_COLS * GRID_ROWS === 10, 'the grid is 5 roughnesses × 2 metalnesses');
  for (const kind of ['webgpu', 'webgl2'] as const)
    for (const layout of ['grid', 'one'] as const) {
      const s = { ...PBR_DEFAULTS, layout };
      fact(P, (await draws(kind, s)) === planStats(pbrPlan(s, 640, 400)).draws, `the ${kind} renderer's draws match the plan (${layout})`);
    }
}
