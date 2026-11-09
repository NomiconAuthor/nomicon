/**
 * "GPU-driven rendering": the CPU model of the culling the lesson's compute shader does, and the
 * frame plan both renderers walk. No DOM, no GPU, so the claims run it in Node.
 *
 * A bigger version of the culling lesson's city (64 × 64 to 256 × 256 blocks) seen from above. Each
 * building is tested as a bounding sphere against the six frustum planes and given a level of
 * detail from its projected size: exactly the test the WebGPU compute shader runs per building
 * (gpu/gpu-driven-rendering.ts), and the one the WebGL2 fallback runs on the CPU every frame. The
 * GPU computes in 32-bit floats and this model in 64-bit, so a building exactly on a plane can
 * come out differently; the widget shows both counts.
 */
import { type Camera, v3 } from '../raster';
import { type FramePlan } from '../gpu/plan';
import { BLOCK, type Building, LOD_MESHES, LOD_SIZE, RECORD_BYTES, city, frustumPlanes } from './culling';

export const SIDES = [64, 128, 256] as const;
export type Side = (typeof SIDES)[number];
export const DEFAULT_SIDE: Side = 128;
export const FLY_HEIGHT = 70;
export const FLY_FAR = 700;

/** The camera flies a circle around the city's centre, looking ahead and down. t in seconds; t = 0 is the pinned view. */
export function flyCam(side: number, t: number, aspect = 16 / 9): Camera {
  const R = side * BLOCK * 0.3;
  const a = t * 0.05;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // At t = 0: eye at (R, h, 0) looking along −z (the circle's tangent), tilted down.
  const eye = t === 0 ? v3(R, FLY_HEIGHT, 0) : v3(R * c, FLY_HEIGHT, -R * s);
  const dir = t === 0 ? v3(-0.25, -0.35, -1) : v3(-s - 0.25 * c, -0.35, -c + 0.25 * s);
  return { eye, target: v3(eye.x + dir.x * 10, eye.y + dir.y * 10, eye.z + dir.z * 10), focal: 1.5, aspect, near: 0.5, far: FLY_FAR, reverseZ: false };
}

/** Per building, the data the cull reads: bounding sphere (centre, radius). Built once per city. */
export interface CullData {
  side: number;
  buildings: Building[];
  /** x, y, z, r per building. */
  spheres: Float64Array;
  /** The GPU's instance records (RECORD_BYTES each), all buildings, plus the ground at the end. */
  records: Float32Array;
}
const dataCache = new Map<number, CullData>();
export function cullData(side: number): CullData {
  let d = dataCache.get(side);
  if (d) return d;
  const buildings = city(side);
  const spheres = new Float64Array(buildings.length * 4);
  const records = new Float32Array((buildings.length + 1) * (RECORD_BYTES / 4));
  buildings.forEach((b, i) => {
    const hx = (b.max.x - b.min.x) / 2;
    const hy = (b.max.y - b.min.y) / 2;
    const hz = (b.max.z - b.min.z) / 2;
    spheres.set([b.min.x + hx, b.min.y + hy, b.min.z + hz, Math.sqrt(hx * hx + hy * hy + hz * hz)], i * 4);
    records.set([b.min.x, b.min.y, b.min.z, b.tone, 2 * hx, 2 * hy, 2 * hz, 0], i * 8);
  });
  const g = (side * BLOCK) / 2 + 20;
  records.set([-g, -0.2, -g, 6, 2 * g, 0.2, 2 * g, 0], buildings.length * 8);
  d = { side, buildings, spheres, records };
  dataCache.set(side, d);
  return d;
}

/** The cull's uniforms, as the compute shader reads them: six planes, the eye, LOD constants, counts. */
export const CULL_UNIFORM_BYTES = 6 * 16 + 16 + 16 + 16;
export function cullUniforms(cam: Camera, n: number, stride: number): ArrayBuffer {
  const buf = new ArrayBuffer(CULL_UNIFORM_BYTES);
  const f = new Float32Array(buf);
  frustumPlanes(cam).forEach((p, i) => f.set([p.n.x, p.n.y, p.n.z, p.d], i * 4));
  f.set([cam.eye.x, cam.eye.y, cam.eye.z, 0], 24);
  f.set([cam.focal, LOD_SIZE[0], LOD_SIZE[1], cam.near], 28);
  new Uint32Array(buf, 32 * 4, 4).set([n, stride, 0, 0]);
  return buf;
}

/**
 * The cull, on the CPU: the WebGL2 fallback runs this every frame, and the claims use it. For each
 * building: outside if its sphere is entirely behind a plane; otherwise LOD 0, 1 or 2 by
 * radius × focal / distance against LOD_SIZE. Returns each level's buildings, in index order.
 */
export function cpuCull(d: CullData, cam: Camera): { lists: Int32Array[]; counts: number[] } {
  const planes = frustumPlanes(cam);
  const n = d.buildings.length;
  const s = d.spheres;
  const lists = [new Int32Array(n), new Int32Array(n), new Int32Array(n)];
  const counts = [0, 0, 0];
  const e = cam.eye;
  outer: for (let i = 0; i < n; i++) {
    const x = s[i * 4];
    const y = s[i * 4 + 1];
    const z = s[i * 4 + 2];
    const r = s[i * 4 + 3];
    for (const p of planes) if (p.n.x * x + p.n.y * y + p.n.z * z + p.d < -r) continue outer;
    const dx = x - e.x;
    const dy = y - e.y;
    const dz = z - e.z;
    const size = (r * cam.focal) / Math.max(cam.near, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const l = size > LOD_SIZE[0] ? 0 : size > LOD_SIZE[1] ? 1 : 2;
    lists[l][counts[l]++] = i;
  }
  return { lists, counts };
}

/** Records for the WebGL2 path: each level's visible buildings, copied out of the big record array. */
export function gatherRecords(d: CullData, lists: Int32Array[], counts: number[]): Array<{ records: Float32Array; count: number }> {
  const F = RECORD_BYTES / 4;
  return lists.map((list, l) => {
    const out = new Float32Array(Math.max(1, counts[l]) * F);
    for (let k = 0; k < counts[l]; k++) out.set(d.records.subarray(list[k] * F, list[k] * F + F), k * F);
    return { records: out, count: counts[l] };
  });
}

/**
 * The frame. WebGPU: a compute pass (the cull) and a render pass with the ground and one
 * drawIndexedIndirect per level, whose instance counts the GPU writes; here they're the CPU
 * model's. WebGL2: the cull happens on the CPU, then the ground and three instanced draws.
 */
export function gpuDrivenPlan(backend: 'webgpu' | 'webgl2', counts: number[]): FramePlan {
  const draws = [
    { name: 'ground', pipeline: 'city', indexed: true, count: LOD_MESHES[2].indexCount, instances: 1 },
    ...counts.map((c, l) => ({ name: `LOD ${l}${backend === 'webgpu' ? ', indirect' : ''}`, pipeline: 'city', indexed: true, count: LOD_MESHES[l].indexCount, instances: c })),
  ];
  const render = { name: 'scene', target: 'the canvas, with a depth buffer', w: 0, h: 0, draws };
  return { passes: backend === 'webgpu' ? [{ name: 'cull (compute)', target: 'the indirect arguments and visible lists', w: 0, h: 0, draws: [] }, render] : [render] };
}

/** Bytes of the GPU path's buffers for a city of n buildings. */
export function gpuBuffers(n: number): { records: number; visible: number; args: number } {
  return { records: (n + 1) * RECORD_BYTES, visible: 3 * n * 4 + 256, args: 3 * 20 };
}
