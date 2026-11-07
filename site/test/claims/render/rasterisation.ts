// Claims for rendering/rasterisation.mdx: fill-rule and MSAA coverage, and the affine error.
import { claim, d1, fact, int } from '../core';
import { affineError, coverage, rasterPoints } from '../../../src/render/scenes/rasterisation';

export default function rasterisation(): void {
  const R = 'rendering/rasterisation.mdx';
  const shared = rasterPoints('shared');
  const tl = coverage(shared, 'top-left', 1);
  const inc = coverage(shared, 'inclusive', 1);
  const exc = coverage(shared, 'exclusive', 1);
  claim(R, `${inc.twice} pixels are drawn twice, all on the diagonal`);
  claim(R, `${exc.missed} pixels are drawn by neither`);
  claim(R, `A covers ${tl.a} pixels and B covers ${tl.b}, none twice, none missed`);
  fact(R, tl.twice === 0 && tl.missed === 0, 'the top-left rule draws every pixel once');
  const ms = coverage(shared, 'top-left', 4);
  claim(R, `${ms.partial} pixels are partly covered, and the fragment shader runs ${ms.shaded} times, against ${tl.shaded} without MSAA`);
  const sl1 = coverage(rasterPoints('sliver'), 'top-left', 1);
  const sl4 = coverage(rasterPoints('sliver'), 'top-left', 4);
  claim(R, `the long sliver covers only ${sl1.a} pixels`);
  fact(R, sl1.b === 0, 'the speck covers no pixel centre');
  claim(R, `The sliver now covers ${sl4.a} samples and the speck ${sl4.b}`);
  const aff = affineError();
  claim(R, `${int(aff.wrong)} of the floor's ${int(aff.pixels)} pixels pick the wrong colour, and texture coordinates are out by up to ${d1(aff.max)} squares`);
}
