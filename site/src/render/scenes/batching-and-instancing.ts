/**
 * "Batching and instancing": the CPU-side model of the frame the lesson's GPU widget draws. No DOM,
 * no GPU, so the claims run it in Node.
 *
 * A square grid of objects, each one of three meshes (a crate, a wedge, a pyramid) in one of four
 * materials. Two of the materials use one fragment shader, two the other, so a material is a
 * pipeline plus a colour. The same objects are drawn four ways:
 *
 *   'unsorted'  one draw per object, in scene order, skipping only state that didn't change
 *   'sorted'    the same draws sorted by a key (pipeline, material, mesh, depth)
 *   'static'    static batching: each material's objects merged, pre-transformed, into one mesh
 *   'instanced' one instanced draw per mesh and material, with a 16-byte record per instance
 *
 * planFor() returns the FramePlan the renderers (gpu/batching-and-instancing.ts) walk, and
 * stateChanges() counts the binds a renderer issues for it. The renderers skip a bind when the
 * same thing is already bound, so the counts are exactly the calls they make.
 */
import { type Camera, type Mesh, type V3, v3 } from '../raster';
import { type DrawPlan, type FramePlan } from '../gpu/plan';
import { type GpuMesh, VERTEX_STRIDE, gpuMesh } from '../gpu/scene';
import { box } from './common';

// ---------------------------------------------------------------------------------------------
// Meshes and materials

/** A solid from flat faces (each a convex polygon, counter-clockwise seen from outside); every face gets its own vertices. */
function solid(faces: V3[][]): Mesh {
  const m: Mesh = { positions: [], attrs: [], indices: [] };
  for (const f of faces) {
    const b = m.positions.length;
    for (const p of f) {
      m.positions.push(p);
      m.attrs.push([0, 0]);
    }
    for (let i = 1; i + 1 < f.length; i++) m.indices.push(b, b + i, b + i + 1);
  }
  return m;
}

/** A wedge (a roof): a triangular prism lying along x, base 1 × 1 at y = 0, ridge at y = 0.8. */
function wedge(): Mesh {
  const a = v3(-0.5, 0, 0.5), b = v3(0.5, 0, 0.5), c = v3(0.5, 0, -0.5), d = v3(-0.5, 0, -0.5);
  const r0 = v3(-0.5, 0.8, 0), r1 = v3(0.5, 0.8, 0);
  return solid([
    [a, b, r1, r0],
    [c, d, r0, r1],
    [b, c, r1],
    [d, a, r0],
    [d, c, b, a],
  ]);
}

/** A square pyramid, base 1 × 1 at y = 0, apex at y = 1.1. */
function pyramid(): Mesh {
  const a = v3(-0.5, 0, 0.5), b = v3(0.5, 0, 0.5), c = v3(0.5, 0, -0.5), d = v3(-0.5, 0, -0.5);
  const t = v3(0, 1.1, 0);
  return solid([
    [a, b, t],
    [b, c, t],
    [c, d, t],
    [d, a, t],
    [d, c, b, a],
  ]);
}

export const MESHES: GpuMesh[] = [gpuMesh('crate', box(v3(0, 0.5, 0), v3(1, 1, 1))), gpuMesh('wedge', wedge()), gpuMesh('pyramid', pyramid())];

export interface Material {
  name: string;
  /** Which fragment shader: plain Lambert, or Lambert with horizontal bands. */
  shader: 'lit' | 'banded';
  /** Theme token. */
  color: string;
}
export const MATERIALS: Material[] = [
  { name: 'stone', shader: 'lit', color: '--c2' },
  { name: 'tile', shader: 'banded', color: '--c1' },
  { name: 'brass', shader: 'lit', color: '--c4' },
  { name: 'moss', shader: 'banded', color: '--c5' },
];
/** Pipelines: a shader with the per-object vertex layout, or with an extra per-instance vertex buffer. */
export const pipelineKey = (shader: Material['shader'], instanced: boolean) => (instanced ? `${shader}, instanced` : shader);
export const PIPELINE_KEYS = [pipelineKey('lit', false), pipelineKey('banded', false), pipelineKey('lit', true), pipelineKey('banded', true)];

// ---------------------------------------------------------------------------------------------
// Objects

export const SIDES = [16, 32, 64, 128] as const;
export type Side = (typeof SIDES)[number];
export const DEFAULT_SIDE: Side = 32;
/** Distance between grid cells. */
export const SPACING = 2;

export interface Obj {
  /** Position of the base's centre, and a uniform scale: the 16 bytes each object's constants hold. */
  x: number;
  y: number;
  z: number;
  s: number;
  mesh: number;
  material: number;
}

/** A small integer hash (xorshift-multiply), so every object's mesh, material and scale are fixed. */
function hash(i: number): number {
  let x = (i + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

const objCache = new Map<number, Obj[]>();
/** The objects of a side × side grid, in scene order (row by row, as a level would list them). Don't modify the array. */
export function objects(side: number): Obj[] {
  const hit = objCache.get(side);
  if (hit) return hit;
  const out: Obj[] = [];
  objCache.set(side, out);
  const o = ((side - 1) * SPACING) / 2;
  for (let gz = 0; gz < side; gz++)
    for (let gx = 0; gx < side; gx++) {
      const i = gz * side + gx;
      const r = hash(i);
      out.push({ x: gx * SPACING - o, y: 0, z: gz * SPACING - o, s: 0.7 + ((r >>> 8) % 7) * 0.1, mesh: r % 3, material: (r >>> 4) % 4 });
    }
  return out;
}

/** A camera that sees the whole grid from above at an angle (the widget turns it around; the counts don't depend on it). */
export function gridCamera(side: number, aspect: number, turn = 0): Camera {
  const r = side * SPACING * 0.88;
  return { eye: v3(r * Math.sin(turn), r * 0.9, r * Math.cos(turn)), target: v3(0, 0, 0), focal: 1.6, aspect, near: 0.5, far: r * 4, reverseZ: false };
}

// ---------------------------------------------------------------------------------------------
// Sort keys

/**
 * A 32-bit sort key, most significant field first: pipeline (4 bits), material (4), mesh (4) and
 * depth (16, front to back). Sorting by it puts draws that share a pipeline together, then those
 * that share a material, then a mesh; depth only orders draws whose state is the same.
 */
export function sortKey(o: Obj, cam: Camera): number {
  const pipe = PIPELINE_KEYS.indexOf(pipelineKey(MATERIALS[o.material].shader, false));
  const dx = o.x - cam.eye.x;
  const dy = o.y - cam.eye.y;
  const dz = o.z - cam.eye.z;
  const depth = Math.min(65535, Math.floor((Math.sqrt(dx * dx + dy * dy + dz * dz) / cam.far) * 65536));
  return ((pipe << 24) | (o.material << 20) | (o.mesh << 16) | depth) >>> 0;
}
/** The key as hex, fields apart: pipeline, material, mesh, depth. */
export const keyText = (k: number) => `${(k >>> 24).toString(16)} ${((k >>> 20) & 15).toString(16)} ${((k >>> 16) & 15).toString(16)} ${(k & 0xffff).toString(16).padStart(4, '0')}`;

// ---------------------------------------------------------------------------------------------
// The frame plan

export type Method = 'unsorted' | 'sorted' | 'static' | 'instanced';
export const METHODS: Array<[Method, string]> = [
  ['unsorted', 'One draw per object'],
  ['sorted', 'Sorted by state'],
  ['static', 'Static batches'],
  ['instanced', 'Instanced'],
];

/** One draw: which mesh (a static batch's mesh is its material's merged mesh), material and objects. */
export interface BatchDraw extends DrawPlan {
  /** Index into MESHES, or −1 for a static batch (its own merged mesh, one per material). */
  mesh: number;
  material: number;
  /** Whose constants it binds: an object (one draw per object), `objects.length` for the identity block static batches use, or −1 for none (instanced). */
  object: number;
  /** Instanced draws: where its instances start in the instance buffer. */
  firstInstance: number;
  key: number;
}
export interface BatchPlan extends FramePlan {
  passes: [{ name: string; target: string; w: number; h: number; draws: BatchDraw[] }];
}

/** Objects in the order of their draws: scene order, or sorted by key; instanced and batched draws use the (material, mesh) order. */
function order(objs: Obj[], method: Method, cam: Camera): number[] {
  const idx = objs.map((_, i) => i);
  if (method === 'unsorted') return idx;
  const keys = objs.map((o) => sortKey(o, cam));
  return idx.sort((a, b) => keys[a] - keys[b] || a - b);
}

export function planFor(method: Method, side: number, cam: Camera = gridCamera(side, 16 / 9)): BatchPlan {
  const objs = objects(side);
  const draws: BatchDraw[] = [];
  const pipe = (m: number, inst: boolean) => pipelineKey(MATERIALS[m].shader, inst);
  if (method === 'unsorted' || method === 'sorted') {
    for (const i of order(objs, method, cam)) {
      const o = objs[i];
      draws.push({ name: MESHES[o.mesh].name, pipeline: pipe(o.material, false), indexed: true, count: MESHES[o.mesh].indexCount, instances: 1, mesh: o.mesh, material: o.material, object: i, firstInstance: 0, key: sortKey(o, cam) });
    }
  } else if (method === 'static') {
    // One merged mesh per material, drawn in pipeline order.
    const mats = MATERIALS.map((_, m) => m).sort((a, b) => PIPELINE_KEYS.indexOf(pipe(a, false)) - PIPELINE_KEYS.indexOf(pipe(b, false)) || a - b);
    for (const m of mats) {
      const count = batchIndexCount(side, m);
      if (count) draws.push({ name: `${MATERIALS[m].name} batch`, pipeline: pipe(m, false), indexed: true, count, instances: 1, mesh: -1, material: m, object: objs.length, firstInstance: 0, key: 0 });
    }
  } else {
    for (const g of instanceGroups(side)) draws.push({ name: `${MATERIALS[g.material].name} ${MESHES[g.mesh].name} ×${g.count}`, pipeline: pipe(g.material, true), indexed: true, count: MESHES[g.mesh].indexCount, instances: g.count, mesh: g.mesh, material: g.material, object: -1, firstInstance: g.first, key: 0 });
  }
  return { passes: [{ name: 'scene', target: 'the canvas, with a depth buffer', w: 0, h: 0, draws }] };
}

const batchCache = new Map<string, number>();
/** Indices in a material's static batch. */
function batchIndexCount(side: number, material: number): number {
  const k = `${side} ${material}`;
  let n = batchCache.get(k);
  if (n === undefined) batchCache.set(k, (n = objects(side).filter((o) => o.material === material).reduce((s, o) => s + MESHES[o.mesh].indexCount, 0)));
  return n;
}

export interface InstanceGroup {
  material: number;
  mesh: number;
  first: number;
  count: number;
  /** The objects, in instance order. */
  objects: number[];
}
const groupCache = new Map<number, InstanceGroup[]>();
/** Instances grouped by (pipeline, material, mesh): one instanced draw each, their records contiguous in one buffer. */
export function instanceGroups(side: number): InstanceGroup[] {
  const hit = groupCache.get(side);
  if (hit) return hit;
  const objs = objects(side);
  const groups: InstanceGroup[] = [];
  groupCache.set(side, groups);
  const mats = MATERIALS.map((_, m) => m).sort((a, b) => (MATERIALS[a].shader === MATERIALS[b].shader ? a - b : MATERIALS[a].shader === 'lit' ? -1 : 1));
  let first = 0;
  for (const material of mats)
    for (let mesh = 0; mesh < MESHES.length; mesh++) {
      const objects = objs.map((o, i) => (o.material === material && o.mesh === mesh ? i : -1)).filter((i) => i >= 0);
      if (!objects.length) continue;
      groups.push({ material, mesh, first, count: objects.length, objects });
      first += objects.length;
    }
  return groups;
}

/** The binds a renderer makes for a plan, skipping any that repeat what's already bound. */
export interface StateChanges {
  draws: number;
  pipelines: number;
  materials: number;
  meshes: number;
  /** Per-object constants bound (one per draw when each object is its own draw; static batches bind one identity block). */
  objects: number;
}
export function stateChanges(p: BatchPlan): StateChanges {
  let pipe = '';
  let mat = -1;
  let mesh = NaN;
  let obj = -1;
  const s: StateChanges = { draws: 0, pipelines: 0, materials: 0, meshes: 0, objects: 0 };
  for (const d of p.passes[0].draws) {
    if (d.pipeline !== pipe) (s.pipelines++, (pipe = d.pipeline));
    if (d.material !== mat) (s.materials++, (mat = d.material));
    // A static batch is its own mesh: always a new bind.
    const m = d.mesh < 0 ? -1 - d.material - 100 : d.mesh;
    if (m !== mesh) (s.meshes++, (mesh = m));
    if (d.object >= 0 && d.object !== obj) (s.objects++, (obj = d.object));
    s.draws++;
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Memory

/** Bytes per object's constants: position and scale (16 bytes), 256 bytes apart (WebGPU's default minUniformBufferOffsetAlignment); one more block holds the identity for static batches. */
export const OBJECT_BYTES = 16;
export const UNIFORM_ALIGN = 256;
/** Bytes per instance record: the same 16 bytes, tightly packed in a vertex buffer. */
export const INSTANCE_BYTES = 16;

/** One material's objects merged and pre-transformed: interleaved vertices and 32-bit indices. */
export function staticBatch(objs: Obj[], material: number): { vertices: Float32Array; indices: Uint32Array } {
  const mine = objs.filter((o) => o.material === material);
  const nv = mine.reduce((s, o) => s + MESHES[o.mesh].vertexCount, 0);
  const ni = mine.reduce((s, o) => s + MESHES[o.mesh].indexCount, 0);
  const F = VERTEX_STRIDE / 4;
  const vertices = new Float32Array(nv * F);
  const indices = new Uint32Array(ni);
  let v = 0;
  let k = 0;
  for (const o of mine) {
    const m = MESHES[o.mesh];
    for (let j = 0; j < m.vertexCount; j++) {
      const s = m.vertices.subarray(j * F, j * F + F);
      vertices.set([s[0] * o.s + o.x, s[1] * o.s + o.y, s[2] * o.s + o.z, s[3], s[4], s[5], s[6], s[7]], (v + j) * F);
    }
    for (let j = 0; j < m.indexCount; j++) indices[k++] = m.indices[j] + v;
    v += m.vertexCount;
  }
  return { vertices, indices };
}

export interface Memory {
  /** The three shared meshes. */
  meshes: number;
  /** Per-object constants, 256 bytes apart (what the per-object draws bind). */
  constants: number;
  /** Static batches: every object's copy of its mesh. */
  batches: number;
  /** Instance records. */
  instances: number;
}
export function memory(side: number): Memory {
  const objs = objects(side);
  const meshes = MESHES.reduce((s, m) => s + m.vertices.byteLength + m.indices.byteLength, 0);
  const batches = objs.reduce((s, o) => s + MESHES[o.mesh].vertexCount * VERTEX_STRIDE + MESHES[o.mesh].indexCount * 4, 0);
  return { meshes, constants: objs.length * UNIFORM_ALIGN, batches, instances: objs.length * INSTANCE_BYTES };
}

/** Bytes for the text: "1.5 KB", "4.0 MB" (1 KB = 1,024 bytes). */
export function bytesText(b: number): string {
  if (b < 1024) return `${b} bytes`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** Triangles per object of each mesh. */
export const meshTriangles = () => MESHES.map((m) => m.indexCount / 3);

/**
 * API calls the renderers make for one frame of a plan (checked against the recorded calls in the
 * claims). WebGPU: write the frame constants, encoder, canvas texture, pass, group 0, the instance
 * buffer once if any draw is instanced, then per change a pipeline, a material group, a vertex and
 * an index buffer, an object group, and the draws; end, finish, submit. WebGL2: update the frame
 * constants, viewport, clear colour, clear, then per change a program, a material range, a vertex
 * array, an object range, and the draws (instanced draws also re-point the instance attribute,
 * because WebGL2 has no firstInstance); unbind the vertex array at the end.
 */
export function callsPerFrame(p: BatchPlan, backend: 'webgpu' | 'webgl2'): number {
  const s = stateChanges(p);
  const inst = p.passes[0].draws.filter((d) => d.object < 0).length;
  const per = s.pipelines + s.materials + s.objects + s.draws;
  if (backend === 'webgpu') return 5 + (inst ? 1 : 0) + per + 2 * s.meshes + 3;
  return 5 + per + s.meshes + 2 * inst + 1;
}
