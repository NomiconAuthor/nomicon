// Claims for rendering/same-frame-real-gpu.mdx: the frame plan, buffer sizes, pipelines, and the
// calls each renderer records for one frame, counted by running the real renderers against the
// Node stubs (src/render/gpu/stub.ts) with the call log on.
import { claim, fact } from '../core';
import { CallLog } from '../../../src/render/gpu/record';
import { planStats } from '../../../src/render/gpu/plan';
import { meshBytes, transform } from '../../../src/render/gpu/scene';
import { createSameFrame, type Colours } from '../../../src/render/gpu/same-frame';
import { stubWebGl2, stubWebGpu } from '../../../src/render/gpu/stub';
import { DRAW_METHODS } from '../../../src/render/gpu/plan';
import { toClip } from '../../../src/render/raster';
import { FRAME_UNIFORM_BYTES, PIPELINE_KEYS, PIPE_NEARS, SAME_FRAME_DEFAULTS, UNIFORM_ALIGN, sameFrameDraws, sameFramePlan, sameFrameViewProj, softwareFrame } from '../../../src/render/scenes/same-frame-real-gpu';
import { pipelineCamera, pipelineScene } from '../../../src/render/scenes/the-pipeline';

const COLOURS: Colours = { bg: [0, 0, 0], draws: [[255, 255, 255], [255, 255, 255]] };

/** One frame's calls (after a first frame, so nothing is created on the way), and the objects created. */
async function record(kind: 'webgpu' | 'webgl2') {
  const log = new CallLog();
  log.start('init');
  const r = await createSameFrame(kind === 'webgpu' ? stubWebGpu(640, 400) : stubWebGl2(640, 400), log);
  r.frame(SAME_FRAME_DEFAULTS, COLOURS, false);
  log.calls = log.calls.filter((c) => c.phase !== 'frame');
  r.frame(SAME_FRAME_DEFAULTS, COLOURS, false);
  log.stop();
  return { frame: log.of('frame'), init: log.of('init') };
}

export default async function sameFrame(): Promise<void> {
  const P = 'rendering/same-frame-real-gpu.mdx';
  const plan = sameFramePlan(SAME_FRAME_DEFAULTS, 640, 400);
  const st = planStats(plan);
  claim(P, `The GPU's frame has ${st.passes} passes`);
  const draws = sameFrameDraws();
  const tris = plan.passes.flatMap((p) => p.draws).map((d) => d.count / 3);
  claim(P, `That's ${st.draws} draw calls and ${st.triangles} triangles submitted: the floor's ${tris[0]}, the box's ${tris[1]} and the full-screen triangle`);
  fact(P, softwareFrame(SAME_FRAME_DEFAULTS).stats.triangles === tris[0] + tris[1], 'the scene pass submits the triangles the software frame takes in');

  // The matrix reproduces the rasteriser's clip space.
  let worst = 0;
  for (const near of PIPE_NEARS) {
    const m = sameFrameViewProj(near);
    for (const d of pipelineScene()) for (const p of d.mesh.positions) {
      const a = transform(m, p);
      const b = toClip(p, pipelineCamera(near));
      for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    }
  }
  fact(P, worst < 1e-5, `the view-projection matrix gives the rasteriser's clip-space positions (worst difference ${worst})`);

  const [floor, box] = draws.map((d) => meshBytes(d.mesh));
  claim(P, `the floor's vertices take ${floor.vertex} bytes and its indices ${floor.index}; the box's take ${box.vertex} and ${box.index}`);
  claim(P, `Each vertex is ${floor.vertex / draws[0].mesh.vertexCount} bytes`);
  claim(P, `so it creates ${PIPELINE_KEYS.length} pipelines: those four and one for the present pass`);
  fact(P, new Set(draws.map((d) => d.material)).size === 2 && PIPELINE_KEYS.length === 2 * 2 + 1, 'two fragment shaders × two cull modes, plus present');
  claim(P, `the light and the background colour, ${FRAME_UNIFORM_BYTES} bytes`);
  claim(P, `Both draws' blocks live in one buffer, ${UNIFORM_ALIGN} bytes apart, because WebGPU's default \`minUniformBufferOffsetAlignment\` is ${UNIFORM_ALIGN}`);

  const gpu = await record('webgpu');
  const gl = await record('webgl2');
  claim(P, `A WebGPU frame here is ${gpu.frame.length} calls, not counting the \`createView\` on the canvas texture`);
  fact(P, !gpu.frame.some((c) => c.method === 'createView'), 'createView on the canvas texture is not recorded');
  claim(P, `The WebGL2 frame is ${gl.frame.length} calls`);
  for (const [name, r] of [['WebGPU', gpu], ['WebGL2', gl]] as const)
    fact(P, r.frame.filter((c) => DRAW_METHODS.has(c.method)).length === st.draws, `the ${name} renderer's recorded draw calls match the plan`);
  fact(P, gpu.init.filter((c) => c.method === 'createRenderPipelineAsync').length === PIPELINE_KEYS.length, 'the WebGPU renderer creates every pipeline at load');
  {
    const g0 = gpu.frame.filter((c) => c.method === 'setBindGroup' && c.short.startsWith('pass.setBindGroup(0'));
    const passes = gpu.frame.map((c, i) => (c.method === 'beginRenderPass' ? i : -1)).filter((i) => i >= 0);
    const frameBinds = gpu.frame.map((c, i) => (c.method === 'setBindGroup' && c.short.startsWith("pass.setBindGroup(0, 'frame'") ? i : -1)).filter((i) => i >= 0);
    fact(P, g0.length === 2 && passes.length === 2 && frameBinds.length === 1 && frameBinds[0] === passes[0] + 1 && frameBinds[0] < passes[1], 'the per-frame group is bound once, in the scene pass; the present pass binds its own group 0');
  }
  claim(P, 'written once per frame and bound once, at the start of the scene pass');
  fact(P, gpu.frame.some((c) => c.method === 'draw' && c.short.includes('(3, 1')), 'the present pass draws three vertices');
  fact(P, !gpu.frame.some((c) => c.method === 'setVertexBuffer' && c.short.includes('present')), 'the present pass has no vertex buffer');
  fact(P, gl.frame.some((c) => c.short === 'gl.disable(CULL_FACE)') && gl.frame.some((c) => c.short === 'gl.enable(DEPTH_TEST)') && gl.frame.some((c) => c.short === 'gl.disable(DEPTH_TEST)'), 'the WebGL2 frame switches depth testing on for the scene and off (with culling) for the present pass');
  const noCull = await (async () => {
    const log = new CallLog();
    const r = await createSameFrame(stubWebGl2(640, 400), log);
    log.start('frame');
    r.frame({ ...SAME_FRAME_DEFAULTS, cull: false }, COLOURS, false);
    return log.calls.filter((c) => c.phase === 'frame').map((c) => c.short);
  })();
  fact(P, !noCull.slice(0, noCull.indexOf('gl.bindFramebuffer(FRAMEBUFFER, null)')).includes('gl.enable(CULL_FACE)'), 'with culling off, the WebGL2 scene pass disables CULL_FACE before its draws');
}
