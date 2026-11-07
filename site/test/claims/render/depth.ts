// Claims for rendering/depth.mdx: z-fighting per format and near plane, the depth-resolution
// table, and early/late Z and prepass shading counts.
import { claim, d2, fact, int } from '../core';
import { lengthText } from '../../../src/render/scenes/common';
import { DEPTH_FAR, overdraw, resolution, zFight } from '../../../src/render/scenes/depth';

export default function depth(): void {
  const D = 'rendering/depth.mdx';
  const zf = (format: 'unorm16' | 'unorm24' | 'float32', near: number, reverseZ = false) => zFight({ format, near, reverseZ, depthTest: true });
  const z16 = zf('unorm16', 0.1);
  claim(D, `the ground shows through on ${z16.fighting} of the road's ${z16.road} pixels`);
  claim(D, `moving the near plane from 0.1 m to 10 m takes the fighting from ${z16.fighting} pixels down to ${zf('unorm16', 10).fighting}`);
  fact(D, zf('unorm24', 0.1).fighting === 0, 'with 24 bits the road is clean at 0.1 m');
  const z24 = zf('unorm24', 0.01);
  claim(D, `the ground shows through on ${z24.fighting} pixels`);
  claim(D, `fights on the same ${zf('float32', 0.01).fighting} pixels`);
  fact(D, zf('float32', 0.01).fighting === z24.fighting, 'plain float32 fights exactly like 24-bit');
  fact(D, zf('float32', 0.01, true).fighting === 0, 'reverse-Z float32 is clean at 0.01 m');
  fact(D, zf('unorm16', 0.1, true).fighting === z16.fighting && zf('unorm24', 0.01, true).fighting === z24.fighting, 'reverse-Z changes nothing for integer formats');
  claim(D, `at 100 m, two surfaces ${lengthText(resolution(100, 0.1, DEPTH_FAR, 'unorm16', false))} apart can still get the same 16-bit value`);
  const row = (label: string, fmt: 'unorm16' | 'unorm24' | 'float32', rz: boolean) => claim(D, `| ${label} | ${[10, 100, 1000].map((z) => lengthText(resolution(z, 0.1, DEPTH_FAR, fmt, rz))).join(' | ')} |`);
  row('16-bit', 'unorm16', false);
  row('24-bit', 'unorm24', false);
  row('32-bit float', 'float32', false);
  row('32-bit float, reverse-Z', 'float32', true);
  const lateBack = overdraw('back', 'late');
  const earlyBack = overdraw('back', 'early');
  const earlyFront = overdraw('front', 'early');
  const pre = overdraw('back', 'prepass');
  claim(D, `the fragment shader runs ${int(lateBack.stats.shaded)} times for ${int(lateBack.visible)} pixels on screen, ${d2(lateBack.stats.shaded / lateBack.visible)}× per pixel`);
  claim(D, `they all pass, still ${int(earlyBack.stats.shaded)}`);
  claim(D, `front to back with early Z and it drops to ${int(earlyFront.stats.shaded)}`);
  fact(D, earlyFront.stats.shaded === earlyFront.visible, 'front to back with early Z shades each pixel once');
  claim(D, `${int(pre.stats.shaded)} runs whatever the order, after ${int(pre.stats.prepassFragments)} depth-only fragments in the prepass`);
  fact(D, overdraw('front', 'prepass').stats.shaded === pre.stats.shaded, 'the prepass shades the same either way');
}
