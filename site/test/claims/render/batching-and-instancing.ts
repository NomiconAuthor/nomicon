// Claims for rendering/batching-and-instancing.mdx: draws and binds per method from the frame plan,
// memory per method, and the calls each renderer records for one frame, counted by running the real
// renderers against the Node stubs (src/render/gpu/stub.ts) with the call log on.
import { claim, fact, int } from '../core';
import { CallLog } from '../../../src/render/gpu/record';
import { DRAW_METHODS } from '../../../src/render/gpu/plan';
import { stubWebGl2, stubWebGpu } from '../../../src/render/gpu/stub';
import { type BatchColours, createBatching } from '../../../src/render/gpu/batching-and-instancing';
import { DEFAULT_SIDE, MATERIALS, METHODS, type Method, SIDES, bytesText, callsPerFrame, gridCamera, memory, planFor, stateChanges } from '../../../src/render/scenes/batching-and-instancing';

const C: BatchColours = { bg: [0, 0, 0], materials: MATERIALS.map(() => [255, 255, 255] as [number, number, number]) };

/** One frame's calls (after a first frame, so nothing is created on the way). */
async function frameCalls(kind: 'webgpu' | 'webgl2', method: Method, side: number) {
  const log = new CallLog();
  log.start('init');
  const r = await createBatching(kind === 'webgpu' ? stubWebGpu(640, 360) : stubWebGl2(640, 360), log);
  const cam = gridCamera(side, 16 / 9);
  r.frame(method, side, cam, C);
  log.calls = log.calls.filter((c) => c.phase !== 'frame');
  const plan = r.frame(method, side, cam, C);
  log.stop();
  return { plan, calls: log.of('frame') };
}

export default async function batching(): Promise<void> {
  const P = 'rendering/batching-and-instancing.mdx';
  const n = DEFAULT_SIDE * DEFAULT_SIDE;
  const s = Object.fromEntries(METHODS.map(([m]) => [m, stateChanges(planFor(m, DEFAULT_SIDE))])) as Record<Method, ReturnType<typeof stateChanges>>;
  const calls: Record<string, Record<Method, number>> = { webgpu: {} as Record<Method, number>, webgl2: {} as Record<Method, number> };
  for (const kind of ['webgpu', 'webgl2'] as const)
    for (const [m] of METHODS) {
      const r = await frameCalls(kind, m, DEFAULT_SIDE);
      calls[kind][m] = r.calls.length;
      fact(P, r.calls.length === callsPerFrame(r.plan, kind), `${kind} ${m}: the recorded calls (${r.calls.length}) match callsPerFrame (${callsPerFrame(r.plan, kind)}), which the widget shows`);
      fact(P, r.calls.filter((c) => DRAW_METHODS.has(c.method)).length === stateChanges(r.plan).draws, `${kind} ${m}: recorded draws match the plan`);
      const binds = kind === 'webgpu' ? r.calls.filter((c) => c.method === 'setPipeline').length : r.calls.filter((c) => c.method === 'useProgram').length;
      fact(P, binds === stateChanges(r.plan).pipelines, `${kind} ${m}: pipeline binds recorded match the plan`);
    }

  const u = s.unsorted;
  claim(P, `With ${int(n)} objects, one draw per object in the order the scene lists them makes ${int(u.draws)} draw calls`);
  claim(P, `${int(u.pipelines)} pipeline binds, ${int(u.materials)} material binds and ${int(u.meshes)} mesh binds`);
  fact(P, u.objects === n, 'each object binds its own constants');
  claim(P, `On WebGPU that's ${int(calls.webgpu.unsorted)} calls a frame; on WebGL2, ${int(calls.webgl2.unsorted)}.`);
  const so = s.sorted;
  claim(P, `Sort the ${int(n)} draws and the binds fall to ${so.pipelines} pipeline binds, ${so.materials} material binds and ${so.meshes} mesh binds. The draws are still ${int(so.draws)}`);
  fact(P, so.objects === n, 'sorted: the per-object constants are still one per draw');
  claim(P, `a frame is ${int(calls.webgpu.sorted)} calls on WebGPU and ${int(calls.webgl2.sorted)} on WebGL2`);
  claim(P, `**Static batches** in the widget draw the grid in ${s.static.draws} draws: one per material.`);
  fact(P, s.static.draws === MATERIALS.length, 'one static batch per material');
  const mem = memory(DEFAULT_SIDE);
  const big = memory(SIDES[SIDES.length - 1]);
  claim(P, `The three shared meshes take ${bytesText(mem.meshes)}; the merged ones for ${int(n)} objects take ${bytesText(mem.batches)}, and ${bytesText(big.batches)} for ${int(SIDES[SIDES.length - 1] ** 2)}.`);
  claim(P, `**Instanced** draws the grid in ${s.instanced.draws} draws, one per mesh and material, from ${bytesText(mem.instances)} of instance records for ${int(n)} objects.`);
  claim(P, `so all twelve groups read from one buffer and each draw starts at its own records: ${calls.webgpu.instanced} calls a frame.`);
  fact(P, s.instanced.draws === 12, 'twelve instance groups (three meshes × four materials)');
  claim(P, `the WebGL2 frame is ${calls.webgl2.instanced} calls.`);
  claim(P, `At ${int(n)} objects:`);
  const label: Record<Method, string> = { unsorted: 'One draw per object', sorted: 'Sorted by state', static: 'Static batches', instanced: 'Instanced' };
  for (const [m] of METHODS) {
    const x = s[m];
    claim(P, `| ${label[m]} | ${int(x.draws)} | ${int(x.pipelines)} | ${int(x.materials)} | ${int(x.meshes)} | ${int(calls.webgpu[m])} | ${int(calls.webgl2[m])} |`);
  }
  // Static batches and instancing don't grow with the object count.
  for (const side of SIDES) {
    fact(P, stateChanges(planFor('static', side)).draws === 4 && stateChanges(planFor('instanced', side)).draws === 12, `at ${side * side} objects: still 4 static batches and 12 instanced draws`);
  }
  claim(P, `the last two stay at ${s.static.draws} and ${s.instanced.draws} draws`);
  claim(P, `At ${int(n)} objects the WebGPU buffer is ${bytesText(mem.constants)}, mostly padding.`);
}
