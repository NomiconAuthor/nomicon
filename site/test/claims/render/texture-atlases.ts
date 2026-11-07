// Claims for rendering/texture-atlases.mdx: the packers' atlas sizes and efficiency, rotation and
// padding, and the bleeding table (padding, extrusion, mip levels).
import { claim, d1, fact, int } from '../core';
import { ATLAS_W, PACKER_ROWS, type PackSettings, ZOOMS, bleedAtlas, bleedText, drawSprite, efficiency, nextPow2, packSmallest, rowLabel, spriteSet, worstBleed } from '../../../src/render/scenes/texture-atlases';

export default function textureAtlases(): void {
  const D = 'rendering/texture-atlases.mdx';
  const sprites = spriteSet();
  let area = 0;
  for (const s of sprites) area += s.w * s.h;
  claim(D, `${sprites.length} sprites, ${int(area)} pixels of them`);
  const pack = (k: PackSettings['packer'], heuristic: PackSettings['heuristic'], rotate = false, padding = 0) => packSmallest(sprites, { packer: k, heuristic, rotate, padding });

  // The table at padding 0, no rotation.
  for (const [k, hh] of PACKER_ROWS) {
    const r = pack(k, hh);
    const pot = nextPow2(r.H);
    claim(D, `| ${rowLabel(k, hh)} | ${r.W} × ${r.H} | ${d1(efficiency(r))}% | ${r.W} × ${pot} | ${d1(efficiency(r, pot))}% |`);
  }
  const shelf = pack('shelf', 'bssf');
  const bl = pack('maxrects', 'bl');
  const bssf = pack('maxrects', 'bssf');
  fact(D, nextPow2(shelf.H) === 512 && nextPow2(pack('skyline', 'bssf').H) === 512, 'shelf and skyline spill past 256 rows into a 512 atlas');
  fact(D, nextPow2(bl.H) === 256 && nextPow2(bssf.H) === 256 && nextPow2(pack('guillotine', 'baf').H) === 256, 'guillotine and both MaxRects fit 256 × 256');
  claim(D, `the same atlas at 256 × 512 is only ${d1(efficiency(shelf, 512))}% sprite`);
  claim(D, `the shelf packer's ${shelf.W} × ${shelf.H} atlas takes ${Math.round((100 * shelf.H) / 512)}% of the memory of the ${shelf.W} × 512 one`);
  // Rotation.
  const bssfR = pack('maxrects', 'bssf', true);
  const skyR = pack('skyline', 'bssf', true);
  claim(D, `MaxRects with best short side fit goes from ${bssf.H} rows to ${bssfR.H}`);
  claim(D, `skyline from ${pack('skyline', 'bssf').H} to ${skyR.H}`);
  // Padding.
  const pad1 = PACKER_ROWS.map(([k, hh]) => pack(k, hh, false, 1));
  fact(D, pad1.every((r) => nextPow2(r.H) === 512), 'with 1 texel of padding no packer fits 256 × 256');
  const best1 = pad1.reduce((a, b) => (b.H < a.H ? b : a));
  claim(D, `the best packer needs ${best1.W} × ${best1.H}`);
  // Every setting the widget offers fits in its 256 × 384 view.
  let tallest = 0;
  for (const [k, hh] of PACKER_ROWS) for (const padding of [0, 1, 2]) for (const rotate of [false, true]) tallest = Math.max(tallest, pack(k, hh, rotate, padding).H);
  fact(D, tallest <= 384 && ATLAS_W === 256, `every packer setting fits the widget's 256 × 384 view (tallest ${tallest})`);

  // Bleeding.
  const zooms = ZOOMS.map((z) => z);
  const row = (p: number) => claim(D, `| ${p} | ${zooms.map((z) => bleedText(worstBleed(bleedAtlas(p, 'extrude'), z).any)).join(' | ')} |`);
  for (const p of [0, 1, 2, 4]) row(p);
  const e1 = worstBleed(bleedAtlas(1, 'empty'), 1);
  claim(D, `none of it from another sprite, but up to ${bleedText(e1.any)} of a pixel can be empty texels`);
  fact(D, e1.neighbour === 0, 'empty padding of 1 stops neighbours at 1×');
  const p0 = worstBleed(bleedAtlas(0, 'extrude'), 2);
  claim(D, `no padding at all, up to ${bleedText(p0.any)} of a pixel`);
  const aligned = drawSprite(bleedAtlas(0, 'empty'), 1, 0, 0, 'bilinear').pixels.every((p) => p.own[0] === 1);
  fact(D, aligned, 'at 1× on whole pixels bilinear reads only sprite A, even without padding');
  // Nearest filtering: the aligned layout (no padding) stays clean at every level; padding 1 breaks the alignment.
  fact(D, zooms.every((z) => worstBleed(bleedAtlas(0, 'empty'), z, 'nearest').any === 0), 'nearest, no padding: clean at every level');
  claim(D, `nearest filtering now bleeds up to ${bleedText(worstBleed(bleedAtlas(1, 'extrude'), 0.25, 'nearest').any)} at 1/4`);
}
