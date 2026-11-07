// Claims for rendering/textures-and-sampling.mdx: each filter's error against the supersampled
// reference and texels read, the level of detail and footprint at the horizon, and the texture
// memory table.
import { claim, d1, d2, fact, int } from '../core';
import { FILTER_LABEL, TEX_FORMATS, bitsPerTexel, checkerTexture, mb, texRun, textureBytes } from '../../../src/render/scenes/textures-and-sampling';

export default function textures(): void {
  const T = 'rendering/textures-and-sampling.mdx';
  const err = (x: number) => x.toFixed(3);
  const runs = { point: texRun('point'), bilinear: texRun('bilinear'), 'mip-nearest': texRun('mip-nearest'), trilinear: texRun('trilinear') };
  const an = texRun('aniso', 16);
  for (const [m, r] of Object.entries(runs)) claim(T, `| ${FILTER_LABEL[m as keyof typeof runs]} | ${d2(r.reads)} | ${err(r.error)} |`);
  claim(T, `| Anisotropic, 16× | ${d2(an.reads)} | ${err(an.error)} |`);
  const tri = runs.trilinear;
  claim(T, `Over the floor's ${int(tri.log.size)} pixels`);
  fact(T, Object.values(runs).every((r) => r.log.size === tri.log.size) && an.log.size === tri.log.size, 'every filter draws the same floor pixels');
  fact(T, err(tri.error) === err(runs['mip-nearest'].error), 'trilinear and nearest-mip have the same average error to 3 places');
  claim(T, `Trilinear hardly changes the average error (${err(tri.error)} either way)`);
  let mag = 0;
  let top = 0;
  for (const s of tri.log.values()) {
    if (s.trace.lambda <= 0) mag++;
    else if (s.trace.levels.length === 1) top++;
  }
  claim(T, `It reads ${d2(tri.reads)} texels a pixel, not 8, because ${int(mag)} of the floor's ${int(tri.log.size)} pixels are magnified and ${int(top)} are beyond the last level, and those read only one level`);
  fact(T, Math.abs(tri.reads - (mag * 4 + top * 4 + (tri.log.size - mag - top) * 8) / tri.log.size) < 1e-9, 'trilinear reads: 4 for magnified and past-the-top pixels, 8 for the rest');
  claim(T, `the floor asks for level ${d1(tri.maxLambda)}, but a 64-texel texture stops at level ${checkerTexture().levels.length - 1}`);
  claim(T, `it gets up to ${Math.round(tri.maxRatio)} times as long as it is wide`);
  claim(T, `At 16× the error halves again, to ${err(an.error)}`);
  fact(T, an.error < tri.error / 1.8, 'anisotropic 16× roughly halves trilinear\'s error');
  fact(T, runs['mip-nearest'].error < runs.bilinear.error / 1.6, 'nearest-mip roughly halves bilinear\'s error');
  claim(T, `It costs ${d2(an.reads)} texel reads a pixel against trilinear's ${d2(tri.reads)}`);
  for (const f of TEX_FORMATS) claim(T, `| ${f.name} | ${bitsPerTexel(f)} | ${mb(textureBytes(2048, 2048, f, true))} |`);
}
