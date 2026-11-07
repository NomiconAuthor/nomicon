/**
 * "Culling": the camera view of the city, with WebGPU and with WebGL2. The CPU model
 * (scenes/culling.ts) decides what's drawn and at which level of detail; this renderer gets one
 * instance record per drawn building, grouped by level, writes them into one buffer and draws
 * the ground and one instanced draw per level. Buildings the culling wrongly dropped are simply
 * not there: you see the holes.
 *
 * Instance record (32 bytes): min corner xyz, colour slot; size xyz, unused. The meshes are unit
 * cubes cut into n × n squares per face (LOD_MESHES), placed by min + position × size.
 */
import { type Gl2Context, type GpuContext, type WebGpuContext } from './context';
import { type FramePlan } from './plan';
import { CallLog, record } from './record';
import { KEY_LIGHT, VERTEX_STRIDE, viewProj } from './scene';
import { BufferUsage, type GPUBuffer, type GPUCanvasContext, type GPUDevice, type GPUObject, type GPUTexture, ShaderStage, TextureUsage } from './webgpu';
import { type Camera } from '../raster';
import { GROUND, LOD_MESHES, RECORD_BYTES, cullPlan, records } from '../scenes/culling';

/** Theme colours, 0–255: background, then the colour slots (six for buildings, one for the ground). */
export interface CityColours {
  bg: [number, number, number];
  tones: Array<[number, number, number]>;
}
export const TONES = 7;

export interface CityGroup {
  records: Float32Array;
  count: number;
}

export interface CityRenderer {
  readonly backend: 'webgpu' | 'webgl2';
  /** Draw the ground and each level's instances. */
  frame(cam: Camera, groups: CityGroup[], c: CityColours): FramePlan;
  dispose(): void;
}

export async function createCity(ctx: GpuContext, log: CallLog | null): Promise<CityRenderer> {
  return ctx.kind === 'webgpu' ? CityWebGpu.create(ctx, log) : new CityGl2(ctx, log);
}

/** Per frame: view-projection, light, shade, background, and the colour slots. Same layout in WGSL and std140. */
export const CITY_FRAME_BYTES = 112 + 16 * TONES;
export function cityFrameData(cam: Camera, c: CityColours): Float32Array {
  const d = new Float32Array(CITY_FRAME_BYTES / 4);
  d.set(viewProj(cam), 0);
  d.set([KEY_LIGHT.dir.x, KEY_LIGHT.dir.y, KEY_LIGHT.dir.z, 0], 16);
  d.set([KEY_LIGHT.ambient, KEY_LIGHT.diffuse, 0, 0], 20);
  d.set([c.bg[0] / 255, c.bg[1] / 255, c.bg[2] / 255, 1], 24);
  c.tones.forEach((t, i) => d.set([t[0] / 255, t[1] / 255, t[2] / 255, 1], 28 + i * 4));
  return d;
}
const GROUND_RECORD = records([GROUND]);

/** WGSL shared with the GPU-driven lesson: the frame block, placing a cube, and shading. */
export const WGSL_CITY_COMMON = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  light: vec4f,
  shade: vec4f,
  bg: vec4f,
  tones: array<vec4f, ${TONES}>,
}
@group(0) @binding(0) var<uniform> frame: Frame;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) normal: vec3f,
  @location(1) @interpolate(flat) tone: u32,
}

// A unit-cube vertex placed by an instance record: min corner + position × size.
fn place(p: vec3f, n: vec3f, minTone: vec4f, size: vec4f) -> VOut {
  var o: VOut;
  o.pos = frame.viewProj * vec4f(minTone.xyz + p * size.xyz, 1.0);
  o.normal = n;
  o.tone = u32(minTone.w);
  return o;
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let lum = frame.shade.x + frame.shade.y * max(0.0, dot(normalize(v.normal), frame.light.xyz));
  return vec4f(mix(frame.bg.rgb, frame.tones[v.tone].rgb, 0.25 + 0.75 * lum), 1.0);
}
`;

const WGSL = /* wgsl */ `${WGSL_CITY_COMMON}
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(3) minTone: vec4f, @location(4) size: vec4f) -> VOut {
  return place(p, n, minTone, size);
}
`;

const DEPTH_FORMAT = 'depth24plus';
export const meshLayout = {
  arrayStride: VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
  ],
};

class CityWebGpu implements CityRenderer {
  readonly backend = 'webgpu';
  private dev: GPUDevice;
  private canvasCtx: GPUCanvasContext;
  private vbufs: GPUBuffer[] = [];
  private ibufs: GPUBuffer[] = [];
  private frameUbo!: GPUBuffer;
  private frameGroup!: GPUObject;
  private pipeline!: GPUObject;
  private inst: GPUBuffer | null = null;
  private depth: { w: number; h: number; tex: GPUTexture; view: GPUObject } | null = null;
  private log: CallLog;

  private constructor(private gc: WebGpuContext, log: CallLog | null) {
    this.log = log ?? new CallLog();
    this.dev = log ? record(gc.device, log, 'device') : gc.device;
    this.canvasCtx = log ? record(gc.context, log, 'context') : gc.context;
  }
  static async create(gc: WebGpuContext, log: CallLog | null): Promise<CityWebGpu> {
    const r = new CityWebGpu(gc, log);
    await r.init();
    return r;
  }
  private async init(): Promise<void> {
    const dev = this.dev;
    this.log.phase = 'init';
    this.gc.device.pushErrorScope('validation');
    for (const m of LOD_MESHES) {
      const vb = dev.createBuffer({ label: `${m.name} vertices`, size: m.vertices.byteLength, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
      dev.queue.writeBuffer(vb, 0, m.vertices);
      const ib = dev.createBuffer({ label: `${m.name} indices`, size: m.indices.byteLength, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
      dev.queue.writeBuffer(ib, 0, m.indices);
      this.vbufs.push(vb);
      this.ibufs.push(ib);
    }
    this.frameUbo = dev.createBuffer({ label: 'frame constants', size: CITY_FRAME_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    const module = dev.createShaderModule({ label: 'city shaders', code: WGSL });
    const frameLayout = dev.createBindGroupLayout({ label: 'per frame', entries: [{ binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    const layout = dev.createPipelineLayout({ label: 'city', bindGroupLayouts: [frameLayout] });
    const instLayout = {
      arrayStride: RECORD_BYTES,
      stepMode: 'instance' as const,
      attributes: [
        { shaderLocation: 3, offset: 0, format: 'float32x4' },
        { shaderLocation: 4, offset: 16, format: 'float32x4' },
      ],
    };
    this.pipeline = await dev.createRenderPipelineAsync({
      label: 'city',
      layout,
      vertex: { module, entryPoint: 'vs', buffers: [meshLayout, instLayout] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.gc.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.frameGroup = dev.createBindGroup({ label: 'frame', layout: frameLayout, entries: [{ binding: 0, resource: { buffer: this.frameUbo } }] });
    const err = await this.gc.device.popErrorScope();
    if (err) console.error('WebGPU init:', err.message);
  }
  private instances(bytes: number): GPUBuffer {
    if (this.inst && this.inst.size >= bytes) return this.inst;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    this.inst?.destroy();
    this.inst = this.dev.createBuffer({ label: 'instance records', size: Math.max(4096, bytes * 2), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this.log.phase = prev;
    return this.inst;
  }
  private depthView(w: number, h: number): GPUObject {
    if (this.depth && this.depth.w === w && this.depth.h === h) return this.depth.view;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    this.depth?.tex.destroy();
    const tex = this.dev.createTexture({ label: 'depth', size: [w, h], format: DEPTH_FORMAT, usage: TextureUsage.RENDER_ATTACHMENT });
    this.depth = { w, h, tex, view: tex.createView() };
    this.log.phase = prev;
    return this.depth.view;
  }

  frame(cam: Camera, groups: CityGroup[], c: CityColours): FramePlan {
    const plan = cullPlan(groups.map((g) => g.count));
    // All records in one buffer: the ground's, then each level's.
    const all = [GROUND_RECORD, ...groups.map((g) => g.records.subarray(0, g.count * 8))];
    const total = all.reduce((s, a) => s + a.byteLength, 0);
    const data = new Float32Array(total / 4);
    let o = 0;
    const firsts: number[] = [];
    for (const a of all) {
      firsts.push(o / 8);
      data.set(a, o);
      o += a.length;
    }
    const inst = this.instances(total);
    const depth = this.depthView(this.gc.canvas.width, this.gc.canvas.height);
    const dev = this.dev;
    this.log.phase = 'frame';
    dev.queue.writeBuffer(this.frameUbo, 0, cityFrameData(cam, c));
    dev.queue.writeBuffer(inst, 0, data);
    const enc = dev.createCommandEncoder({ label: 'frame' });
    const pass = enc.beginRenderPass({
      label: 'scene',
      colorAttachments: [{ view: this.canvasCtx.getCurrentTexture().createView(), clearValue: { r: c.bg[0] / 255, g: c.bg[1] / 255, b: c.bg[2] / 255, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.frameGroup);
    pass.setVertexBuffer(1, inst);
    // The ground (one instance of the coarsest cube), then each level that has buildings.
    const draw = (lod: number, count: number, first: number) => {
      pass.setVertexBuffer(0, this.vbufs[lod]);
      pass.setIndexBuffer(this.ibufs[lod], 'uint16');
      pass.drawIndexed(LOD_MESHES[lod].indexCount, count, 0, 0, first);
    };
    draw(2, 1, 0);
    groups.forEach((g, l) => g.count && draw(l, g.count, firsts[l + 1]));
    pass.end();
    dev.queue.submit([enc.finish({ label: 'frame' })]);
    return plan;
  }

  dispose(): void {
    for (const b of [...this.vbufs, ...this.ibufs, this.frameUbo]) b?.destroy();
    this.inst?.destroy();
    this.depth?.tex.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// WebGL2

export const GLSL_CITY_FS = `#version 300 es
precision highp float;
layout(std140) uniform Frame { mat4 viewProj; vec4 light; vec4 shade; vec4 bg; vec4 tones[${TONES}]; };
in vec3 vNormal;
flat in int vTone;
out vec4 outColor;
void main() {
  float lum = shade.x + shade.y * max(0.0, dot(normalize(vNormal), light.xyz));
  outColor = vec4(mix(bg.rgb, tones[vTone].rgb, 0.25 + 0.75 * lum), 1.0);
}`;
export const GLSL_CITY_VS = `#version 300 es
layout(std140) uniform Frame { mat4 viewProj; vec4 light; vec4 shade; vec4 bg; vec4 tones[${TONES}]; };
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 3) in vec4 minTone;
layout(location = 4) in vec4 size;
out vec3 vNormal;
flat out int vTone;
void main() {
  vec4 c = viewProj * vec4(minTone.xyz + position * size.xyz, 1.0);
  gl_Position = vec4(c.xy, 2.0 * c.z - c.w, c.w); // depth 0..w to OpenGL's -w..w
  vNormal = normal;
  vTone = int(minTone.w);
}`;

export function named<T>(o: T, label: string): T {
  if (o && typeof o === 'object') (o as { label?: string }).label = label;
  return o;
}
export function glProgram(gl: WebGL2RenderingContext, label: string, vsSrc: string, fsSrc: string): WebGLProgram {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = named(gl.createProgram()!, label);
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  return p;
}

class CityGl2 implements CityRenderer {
  readonly backend = 'webgl2';
  private gl: WebGL2RenderingContext;
  private vaos: Array<WebGLVertexArrayObject | null> = [];
  private frameUbo: WebGLBuffer | null;
  private inst: WebGLBuffer | null;
  private program: WebGLProgram;
  private log: CallLog;

  constructor(private gc: Gl2Context, log: CallLog | null) {
    this.log = log ?? new CallLog();
    const gl = (this.gl = log ? record(gc.gl, log, 'gl') : gc.gl);
    this.log.phase = 'init';
    this.inst = named(gl.createBuffer(), 'instance records');
    for (const m of LOD_MESHES) {
      const vao = named(gl.createVertexArray(), m.name);
      gl.bindVertexArray(vao);
      const vb = named(gl.createBuffer(), `${m.name} vertices`);
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, m.vertices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_STRIDE, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, VERTEX_STRIDE, 12);
      const ib = named(gl.createBuffer(), `${m.name} indices`);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
      for (const [loc, off] of [[3, 0], [4, 16]]) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, RECORD_BYTES, off);
        gl.vertexAttribDivisor(loc, 1);
      }
      gl.bindVertexArray(null);
      this.vaos.push(vao);
    }
    this.frameUbo = named(gl.createBuffer(), 'frame constants');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, CITY_FRAME_BYTES, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.frameUbo);
    this.program = glProgram(gl, 'city', GLSL_CITY_VS, GLSL_CITY_FS);
    gl.uniformBlockBinding(this.program, gl.getUniformBlockIndex(this.program, 'Frame'), 0);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
  }

  frame(cam: Camera, groups: CityGroup[], c: CityColours): FramePlan {
    const gl = this.gl;
    const plan = cullPlan(groups.map((g) => g.count));
    this.log.phase = 'frame';
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, cityFrameData(cam, c));
    gl.viewport(0, 0, this.gc.canvas.width, this.gc.canvas.height);
    gl.clearColor(c.bg[0] / 255, c.bg[1] / 255, c.bg[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    // No firstInstance in WebGL2: each draw uploads its own records, then draws from the start.
    const draw = (lod: number, rec: Float32Array, count: number) => {
      gl.bindVertexArray(this.vaos[lod]);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
      gl.bufferData(gl.ARRAY_BUFFER, rec.subarray(0, count * 8), gl.STREAM_DRAW);
      gl.drawElementsInstanced(gl.TRIANGLES, LOD_MESHES[lod].indexCount, gl.UNSIGNED_SHORT, 0, count);
    };
    draw(2, GROUND_RECORD, 1);
    groups.forEach((g, l) => g.count && draw(l, g.records, g.count));
    gl.bindVertexArray(null);
    return plan;
  }

  dispose(): void {}
}
