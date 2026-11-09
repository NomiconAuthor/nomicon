// Claims for rendering/blending-and-transparency.mdx: wrong pixels per pane order, depth writes
// and blend mode; white in a straight-alpha sprite's edges; fence coverage per cut-out method.
import { claim, fact, int, pct } from '../core';
import { FENCE_FAR, FENCE_NEAR, compare, edgeRun, fenceCoverage, fenceRun, resolved, sortError, sortRun, SORT_INKS } from '../../../src/render/scenes/blending-and-transparency';

export default function blending(): void {
  const B = 'rendering/blending-and-transparency.mdx';
  const front = sortError('front', false, 'over');
  const listed = sortError('listed', false, 'over');
  claim(B, `Front to back: ${front.wrong} of the ${int(front.panes)} pixels with glass are wrong`);
  claim(B, `Unsorted, in the order a list might hold them: ${listed.wrong} wrong`);
  fact(B, sortError('back', false, 'over').wrong === 0 && sortError('back', true, 'over').wrong === 0, 'sorted back to front is right with or without depth writes');
  // Depth writes on, front to back: the same pixels are wrong.
  const K = SORT_INKS.length;
  const ref = resolved(sortRun('back', false, 'over'));
  const a = resolved(sortRun('front', false, 'over'));
  const b = resolved(sortRun('front', true, 'over'));
  let same = true;
  for (let p = 0; p < a.length / K; p++) {
    const wa = compare(a.subarray(p * K, p * K + K), ref.subarray(p * K, p * K + K), K).wrong;
    const wb = compare(b.subarray(p * K, p * K + K), ref.subarray(p * K, p * K + K), K).wrong;
    if (wa !== wb) same = false;
  }
  fact(B, same, 'with depth writes on, front to back gets the same pixels wrong');
  fact(B, (['back', 'front', 'listed'] as const).every((o) => sortError(o, false, 'additive').wrong === 0), 'additive is right in every order with depth writes off');
  const oit = (['back', 'front', 'listed'] as const).map((o) => sortError(o, false, 'oit'));
  fact(B, oit.every((e) => e.wrong === oit[0].wrong && e.max === oit[0].max), 'weighted blended OIT gives the same picture in every order');
  const os = (['back', 'front', 'listed'] as const).map((o) => resolved(sortRun(o, false, 'oit')));
  fact(B, os.every((r) => compare(r, os[0], K, 1e-12).wrong === 0), 'weighted blended OIT gives identical pixels in every order');
  claim(B, `${oit[0].wrong} pixels differ from the sorted answer, by up to ${pct((oit[0].max / 2) * 100)}`);
  const st = edgeRun('straight');
  const pm = edgeRun('premultiplied');
  claim(B, `With straight alpha, ${st.whitePixels} pixels pick up some white, up to ${pct(st.maxWhite * 100)} of a pixel's colour`);
  fact(B, pm.maxWhite === 0, 'premultiplied: no white anywhere');
  claim(B, `The fence's wire covers ${pct(fenceCoverage() * 100)} of its area`);
  claim(B, `| Cut out with | Wire shown within ${FENCE_NEAR} m | Wire shown beyond ${FENCE_FAR} m |`);
  const row = (label: string, m: 'blend' | 'test' | 'a2c') => {
    const r = fenceRun(m);
    claim(B, `| ${label} | ${pct(r.near * 100)} | ${pct(r.far * 100)} |`);
    return r;
  };
  row('Alpha blending', 'blend');
  const t = row('Alpha test (≥ 0.5)', 'test');
  row('Alpha to coverage', 'a2c');
  fact(B, t.far === 0, 'alpha test shows no wire far away');
  claim(B, `alpha of about ${fenceCoverage().toFixed(2)} everywhere`);
  claim(B, `at 4×, alpha ${fenceCoverage().toFixed(2)} covers one sample of four`);
  fact(B, Math.round(fenceCoverage() * 4) === 1, 'alpha 0.23 rounds to one sample of four');
}
