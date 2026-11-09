/**
 * Scene data for the GPU lessons, shared so that every lesson draws "the same frame" as the
 * concept lessons and as each other. No DOM and no GPU: everything here runs in Node too.
 *
 *   gpuDraws(draws)   the software rasteriser's draws (scenes/*.ts) as GPU-ready meshes:
 *                     interleaved vertices (position, normal, uv: 32 bytes each), 16-bit indices,
 *                     and the material the fragment shader should run.
 *   viewProj(camera)  the raster camera as one 4 × 4 matrix (column-major, as WGSL and GLSL
 *                     expect), giving exactly the clip space raster.ts's toClip gives: x and y
 *                     −1..1, depth 0..1 (the WebGL2 shaders remap depth to −1..1 themselves).
 *   KEY_LIGHT         the concept lessons' one light (scenes/common.ts's LIGHT, ambient 0.35,
 *                     diffuse 0.65), so lit faces get the same brightness on the GPU.
 *   POINT_LIGHTS      a few more lights for the lighting lessons; the first GPU lesson doesn't use them.
 *
 * Colours are theme tokens (draw.color), resolved by the widget, so the GPU frame follows the
 * site theme exactly as the software frames do.
 */
import { type Camera, type Draw, type Mesh, type V3, basis, cross3, norm3, sub3, v3 } from '../raster';
import { LIGHT, checker, flat } from '../scenes/common';

/** Bytes per vertex: position (3 floats), normal (3 floats), uv (2 floats). */
export const VERTEX_STRIDE = 32;
export const VERTEX_ATTRS = [
  { name: 'position', location: 0, offset: 0, components: 3 },
  { name: 'normal', location: 1, offset: 12, components: 3 },
  { name: 'uv', location: 2, offset: 24, components: 2 },
] as const;

/** Which fragment shader a draw needs: the floor's checkerboard, or Lambert lighting from the normal. */
export type Material = 'checker' | 'lit';

export interface GpuMesh {
  name: string;
  /** VERTEX_STRIDE / 4 floats per vertex. */
  vertices: Float32Array;
  indices: Uint16Array;
  vertexCount: number;
  indexCount: number;
}
export interface GpuDraw {
  name: string;
  mesh: GpuMesh;
  /** Theme token, such as '--c2'. */
  color: string;
  material: Material;
}

/** Per-vertex normals from the triangles that use each vertex (meshes with a shade per face have their own vertices per face). */
function normals(m: Mesh): V3[] {
  const n = m.positions.map(() => v3(0, 0, 0));
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
    const f = cross3(sub3(m.positions[b], m.positions[a]), sub3(m.positions[c], m.positions[a]));
    for (const i of [a, b, c]) n[i] = v3(n[i].x + f.x, n[i].y + f.y, n[i].z + f.z);
  }
  return n.map((x) => (x.x || x.y || x.z ? norm3(x) : v3(0, 1, 0)));
}

/** One raster mesh as interleaved GPU vertices. Texture coordinates come from attrs when it has two. */
export function gpuMesh(name: string, m: Mesh): GpuMesh {
  const ns = normals(m);
  const f = new Float32Array(m.positions.length * (VERTEX_STRIDE / 4));
  m.positions.forEach((p, i) => {
    const uv = m.attrs[i].length >= 2 ? m.attrs[i] : [0, 0];
    f.set([p.x, p.y, p.z, ns[i].x, ns[i].y, ns[i].z, uv[0], uv[1]], i * 8);
  });
  // writeBuffer sizes must be multiples of 4 bytes: pad an odd index count with one unused index.
  const idx = new Uint16Array(m.indices.length + (m.indices.length & 1));
  idx.set(m.indices);
  return { name, vertices: f, indices: idx, vertexCount: m.positions.length, indexCount: m.indices.length };
}

/** The software scene's draws, for the GPU. Only the shading functions the GPU shaders implement are allowed. */
export function gpuDraws(draws: Draw[]): GpuDraw[] {
  return draws.map((d) => {
    const material: Material | null = d.shade === checker ? 'checker' : d.shade === flat ? 'lit' : null;
    if (!material) throw new Error(`gpuDraws: no GPU shader for the shading of "${d.name}"`);
    return { name: d.name, mesh: gpuMesh(d.name, d.mesh), color: d.color, material };
  });
}

/**
 * The camera as a view-projection matrix, column-major: clip = M · (x, y, z, 1) is exactly
 * raster.ts's toClip (D3D/Vulkan/WebGPU depth range 0..1, w = distance in front of the camera).
 */
export function viewProj(cam: Camera): Float32Array {
  const { right: r, up: u, fwd: f } = basis(cam);
  const e = cam.eye;
  const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
  const sx = cam.focal / cam.aspect;
  const sy = cam.focal;
  const { near: n, far: fa } = cam;
  if (cam.reverseZ || cam.screen) throw new Error('viewProj: only the plain perspective camera is supported so far');
  // Row 2 (depth) is A·z_view + B with z_view = dot(f, p − e): A = f/(f−n), B = −A·n (A = 1, B = −n for an infinite far plane).
  const A = fa === Infinity ? 1 : fa / (fa - n);
  const rows = [
    [r.x * sx, r.y * sx, r.z * sx, -dot(r, e) * sx],
    [u.x * sy, u.y * sy, u.z * sy, -dot(u, e) * sy],
    [f.x * A, f.y * A, f.z * A, (-dot(f, e) - n) * A],
    [f.x, f.y, f.z, -dot(f, e)],
  ];
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) m[c * 4 + rr] = rows[rr][c];
  return m;
}

/** Apply a column-major matrix to a point (for tests and CPU-side checks). */
export function transform(m: Float32Array, p: V3): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) out[r] = m[r] * p.x + m[4 + r] * p.y + m[8 + r] * p.z + m[12 + r];
  return out;
}

export interface DirectionalLight {
  /** Unit vector towards the light. */
  dir: V3;
  ambient: number;
  diffuse: number;
}
/** The concept lessons' light: brightness = 0.35 + 0.65 · max(0, n · LIGHT). */
export const KEY_LIGHT: DirectionalLight = { dir: LIGHT, ambient: 0.35, diffuse: 0.65 };

export interface PointLight {
  name: string;
  pos: V3;
  /** Theme token for its colour. */
  color: string;
  /** Distance at which it fades to nothing. */
  radius: number;
  intensity: number;
}
/** Extra lights placed around the pipeline scene's box, for the lighting lessons. */
export const POINT_LIGHTS: PointLight[] = [
  { name: 'warm', pos: v3(-2.5, 1.2, 1.5), color: '--warn', radius: 5, intensity: 1 },
  { name: 'cool', pos: v3(2.5, 1.0, -1.0), color: '--c7', radius: 5, intensity: 1 },
  { name: 'rim', pos: v3(0, 2.5, -3.5), color: '--accent', radius: 6, intensity: 0.8 },
];

/** Byte sizes of a draw's buffers, as the lessons quote them. */
export const meshBytes = (m: GpuMesh) => ({ vertex: m.vertices.byteLength, index: m.indices.byteLength });
