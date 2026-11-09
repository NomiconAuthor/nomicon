// Claims for rendering/bandwidth.mdx: the bytes the model counts for each configuration the lesson
// quotes, and the renderers run against the Node stubs: one pass per plan pass, the load and store
// ops passed through as chosen (WebGPU), clears and invalidates matching them (WebGL2).
import { claim, fact } from '../core';
import { CallLog } from '../../../src/render/gpu/record';
import { DRAW_METHODS, planStats } from '../../../src/render/gpu/plan';
import { createBandwidth } from '../../../src/render/gpu/bandwidth';
import { stubWebGl2, stubWebGpu } from '../../../src/render/gpu/stub';
import { type Gl2Context } from '../../../src/render/gpu/context';
import { BANDWIDTH_DEFAULTS as D, type BandwidthSettings, FORMATS, GBs, MB, bandwidth } from '../../../src/render/scenes/bandwidth';

const C = { bg: [0, 0, 0] as [number, number, number], draws: [[1, 2, 3] as [number, number, number], [4, 5, 6] as [number, number, number]] };

/** The WebGL2 stub offers no extensions; float render targets need EXT_color_buffer_float, so pretend it's there. */
function withFloatTargets(gc: Gl2Context): Gl2Context {
  const gl = gc.gl;
  gc.gl = new Proxy(gl, { get: (t, p) => (p === 'getExtension' ? (n: string) => (n === 'EXT_color_buffer_float' ? {} : null) : (t as unknown as Record<string | symbol, unknown>)[p]) });
  return gc;
}

export default async function bandwidthClaims(): Promise<void> {
  const P = 'rendering/bandwidth.mdx';
  const at = (o: Partial<BandwidthSettings>) => bandwidth({ ...structuredClone(D), ...o });
  const discard = { load: 'clear' as const, store: 'discard' as const };

  // The format table's sizes.
  for (const [f, b] of [
    ['rgba8unorm', 4],
    ['rgb10a2unorm', 4],
    ['rg11b10ufloat', 4],
    ['rgba16float', 8],
    ['rgba32float', 16],
    ['depth16unorm', 2],
    ['depth24plus-stencil8', 4],
    ['depth32float', 4],
  ] as const) {
    fact(P, FORMATS[f].bytes === b, `${f} is ${b} bytes in the model`);
    claim(P, `| \`${f}\` |`);
  }

  const d = at({});
  const [albedo, normal, depth, hdr, swap] = d.rows;
  claim(P, `At 1920 × 1080 with the starting formats the frame moves ${MB(d.total)}, ${GBs(d.total)} at 60 frames a second`);
  claim(P, `The G-buffer pass stores ${MB(albedo.store + normal.store + depth.store)} (albedo ${(albedo.store / 1e6).toFixed(1)}, normal ${(normal.store / 1e6).toFixed(1)}, depth ${(depth.store / 1e6).toFixed(1)})`);
  fact(P, albedo.read + normal.read + depth.read === albedo.store + normal.store + depth.store, 'the lighting pass reads all of the G-buffer back');
  claim(P, `writes ${MB(hdr.store)} of HDR colour, and the post pass reads that and writes ${MB(swap.store)} to the swapchain image`);
  fact(P, hdr.read === hdr.store, 'the post pass reads the HDR colour once');

  const n10 = at({ normal: 'rgb10a2unorm' });
  const h11 = at({ hdr: 'rg11b10ufloat' });
  fact(P, n10.total === h11.total, 'the smaller normal and the smaller HDR format save the same');
  claim(P, `each saves ${MB(d.total - n10.total)}: ${MB(n10.total)} a frame`);
  claim(P, `\`rgba32float\` HDR costs ${MB(at({ hdr: 'rgba32float' }).total)}`);
  const k4 = at({ w: 3840, h: 2160 });
  claim(P, `the starting frame moves ${MB(k4.total)}, ${GBs(k4.total)}`);
  const load = at({ albedoOps: { load: 'load', store: 'store' } });
  claim(P, `albedo with \`load\` costs ${MB(load.total - d.total)} more, ${MB(load.total)}`);
  const noFog = at({ fog: false, depthOps: discard });
  claim(P, `Set its store op to \`discard\` and the frame drops to ${MB(noFog.total)}`);
  const small = at({ fog: false, depthOps: discard, normal: 'rgb10a2unorm', hdr: 'rg11b10ufloat' });
  claim(P, `With the smaller normal and HDR formats as well, ${MB(small.total)}, ${GBs(small.total)}: about half the starting frame`);
  fact(P, Math.abs(small.total / d.total - 0.5) < 0.06, 'about half');
  fact(P, at({ albedoOps: discard }).broken.includes('albedo'), 'discarding albedo leaves the lighting pass reading a discarded target');
  fact(P, noFog.rows[2].transientOk && !d.rows[2].transientOk, 'with fog off and depth cleared and discarded, depth could be transient');
  const merged = at({ merged: true });
  claim(P, `the model's frame drops from ${MB(d.total)} to ${MB(merged.total)}, and the G-buffer's ${MB(albedo.store + normal.store + depth.store)} could be memoryless`);
  fact(P, merged.transient === albedo.store + normal.store + depth.store, "merged, the G-buffer's targets are all memoryless");

  // The renderers.
  for (const [api, make] of [
    ['WebGPU', () => stubWebGpu(640, 360)],
    ['WebGL2', () => withFloatTargets(stubWebGl2(640, 360))],
  ] as const) {
    const log = new CallLog();
    const r = await createBandwidth(make(), log);
    const s: BandwidthSettings = { ...structuredClone(D), fog: false, depthOps: discard, hdrOps: { load: 'load', store: 'store' } };
    await r.prepare(s);
    log.start('frame');
    const { plan } = r.frame(s, C);
    log.stop();
    const calls = log.of('frame');
    fact(P, calls.filter((c) => DRAW_METHODS.has(c.method)).length === planStats(plan).draws, `${api}: the frame issues the plan's draws`);
    if (api === 'WebGPU') {
      const passes = calls.filter((c) => c.method === 'beginRenderPass');
      fact(P, passes.length === 3, 'WebGPU: three render passes');
      fact(P, passes[0].full.includes("depthStoreOp: 'discard'") && passes[1].full.includes("loadOp: 'load'"), 'WebGPU: the chosen ops reach the pass descriptors');
    } else {
      fact(P, calls.some((c) => c.method === 'invalidateFramebuffer') && calls.filter((c) => c.method === 'clearBufferfv').length === 3, 'WebGL2: discard is invalidateFramebuffer, clear is a clear call, load is no call');
    }
  }
}
