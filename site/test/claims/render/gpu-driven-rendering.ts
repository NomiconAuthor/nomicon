// Claims for rendering/gpu-driven-rendering.mdx: the CPU model's counts at the start of the flight,
// and the calls each path records per frame (real renderers against the Node stubs), which on
// WebGPU don't depend on the city size.
import { claim, fact, int } from '../core';
import { CallLog } from '../../../src/render/gpu/record';
import { DRAW_METHODS } from '../../../src/render/gpu/plan';
import { stubWebGl2, stubWebGpu } from '../../../src/render/gpu/stub';
import { type CityColours, TONES } from '../../../src/render/gpu/culling';
import { createDriven } from '../../../src/render/gpu/gpu-driven-rendering';
import { FLY_FAR, SIDES, cpuCull, cullData, flyCam } from '../../../src/render/scenes/gpu-driven-rendering';

const C: CityColours = { bg: [0, 0, 0], tones: Array.from({ length: TONES }, () => [255, 255, 255] as [number, number, number]) };

async function frameCalls(kind: 'webgpu' | 'webgl2', side: number) {
  const log = new CallLog();
  log.start('init');
  const r = await createDriven(kind === 'webgpu' ? stubWebGpu(640, 360) : stubWebGl2(640, 360), log);
  r.frame(side, flyCam(side, 0), C);
  r.frame(side, flyCam(side, 0), C);
  log.calls = log.calls.filter((c) => c.phase !== 'frame');
  r.frame(side, flyCam(side, 0), C);
  log.stop();
  return log.of('frame', true);
}

export default async function gpuDriven(): Promise<void> {
  const P = 'rendering/gpu-driven-rendering.mdx';
  const gpu = await Promise.all(SIDES.map((s) => frameCalls('webgpu', s)));
  const gl = await Promise.all(SIDES.map((s) => frameCalls('webgl2', s)));
  fact(P, gpu.every((f) => f.length === gpu[0].length), 'WebGPU calls per frame are the same at every city size');
  fact(P, gl.every((f) => f.length === gl[0].length), 'WebGL2 calls per frame are the same at every city size');
  claim(P, `A WebGPU frame here is ${gpu[0].length} calls with ${int(SIDES[0] ** 2)} buildings, with ${int(SIDES[1] ** 2)} and with ${int(SIDES[2] ** 2)}`);
  const g = gpu[0];
  fact(P, g.filter((c) => c.method === 'writeBuffer').length === 3, 'three buffer writes per frame');
  fact(P, g.filter((c) => c.method === 'dispatchWorkgroups').length === 1, 'one compute dispatch');
  fact(P, g.filter((c) => c.method === 'drawIndexedIndirect').length === 3 && g.filter((c) => c.method === 'drawIndexed').length === 1, 'the ground and three indirect draws');
  claim(P, `${gl[0].length} calls a frame, but the CPU visits every building`);
  fact(P, gl[0].filter((c) => DRAW_METHODS.has(c.method)).length === 4, 'WebGL2: the ground and three instanced draws');
  fact(P, gpu[0].some((c) => c.method === 'drawIndexedIndirect' && /, 0\)$/.test(c.short)), 'the first indirect draw reads offset 0');

  const small = cullData(SIDES[0]);
  const c0 = cpuCull(small, flyCam(SIDES[0], 0)).counts;
  const n0 = c0[0] + c0[1] + c0[2];
  claim(P, `the camera sees ${int(n0)} of the ${int(small.buildings.length)} buildings: ${c0[0]} at the finest level, ${c0[1]} at the middle one and ${int(c0[2])} at the coarsest.`);
  const big = SIDES[SIDES.length - 1];
  const cb = cpuCull(cullData(big), flyCam(big, 0)).counts;
  claim(P, `With ${int(big * big)} buildings, the far plane at ${FLY_FAR} m keeps it to ${int(cb[0] + cb[1] + cb[2])} in the frustum.`);
  claim(P, 'Every 10 frames the widget copies the arguments back');
}
