/**
 * "Batching and instancing": one grid of objects drawn four ways (scenes/batching-and-instancing.ts),
 * with WebGPU and with WebGL2. Both renderers walk the plan and bind only what changed between
 * draws, so the binds they make are exactly stateChanges(plan).
 *
 * Bindings, the same on both APIs:
 *   group / UBO binding 0  per frame: view-projection, light, background (112 bytes)
 *   group / UBO binding 1  per material: its colour (16 bytes, one block per material)
 *   group / UBO binding 2  per object: position and scale (16 bytes, one block per object,
 *                          256 bytes apart, bound at the object's offset for each draw)
 * Instanced draws read the position and scale from a second vertex buffer instead, one 16-byte
 * record per instance (stepMode 'instance' in WebGPU, vertexAttribDivisor(3, 1) in WebGL2).
 *
 * When a CallLog is given the API objects are recorded (for the claims and for counting calls);
 * the widget times frames without one, so the proxy isn't part of what it measures.
 */
import { type Gl2Context, type GpuContext, type WebGpuContext } from './context';
import { CallLog, record } from './record';
import { KEY_LIGHT, VERTEX_STRIDE, viewProj } from './scene';
import { BufferUsage, type GPUBuffer, type GPUCanvasContext, type GPUDevice, type GPUObject, type GPUTexture, ShaderStage, TextureUsage } from './webgpu';
import { type Camera } from '../raster';
import {
  type BatchPlan,
  INSTANCE_BYTES,
  MATERIALS,
  MESHES,
  type Method,
  OBJECT_BYTES,
  PIPELINE_KEYS,
  instanceGroups,
  objects,
  planFor,
  staticBatch,
} from '../scenes/batching-and-instancing';

/** Theme colours, 0–255: the background and one per material. */
export interface BatchColours {
  bg: [number, number, number];
  materials: Array<[number, number, number]>;
}

export interface BatchRenderer {
  readonly backend: 'webgpu' | 'webgl2';
  /** Record and submit one frame. The plan is built first (sorting included) and returned. */
  frame(method: Method, side: number, cam: Camera, c: BatchColours): BatchPlan;
  /** Build the plan for a frame without drawing it (so the widget can time only the API calls). */
  draw(plan: BatchPlan, side: number, cam: Camera, c: BatchColours): void;
  dispose(): void;
}

export async function createBatching(ctx: GpuContext, log: CallLog | null): Promise<BatchRenderer> {
  return ctx.kind === 'webgpu' ? BatchWebGpu.create(ctx, log) : new BatchGl2(ctx, log);
}

const FRAME_BYTES = 112;
function frameData(cam: Camera, c: BatchColours): Float32Array {
  const d = new Float32Array(FRAME_BYTES / 4);
  d.set(viewProj(cam), 0);
  d.set([KEY_LIGHT.dir.x, KEY_LIGHT.dir.y, KEY_LIGHT.dir.z, 0], 16);
  d.set([KEY_LIGHT.ambient, KEY_LIGHT.diffuse, 0, 0], 20);
  d.set([c.bg[0] / 255, c.bg[1] / 255, c.bg[2] / 255, 1], 24);
  return d;
}
function materialData(c: BatchColours, align: number): Float32Array {
  const d = new Float32Array(((MATERIALS.length - 1) * align + 16) / 4);
  c.materials.forEach((m, i) => d.set([m[0] / 255, m[1] / 255, m[2] / 255, 1], (i * align) / 4));
  return d;
}
/** Every object's constants at `align` bytes apart, then the identity block static batches use. */
function objectData(side: number, align: number): Float32Array {
  const objs = objects(side);
  const d = new Float32Array(((objs.length + 1) * align) / 4);
  objs.forEach((o, i) => d.set([o.x, o.y, o.z, o.s], (i * align) / 4));
  d.set([0, 0, 0, 1], (objs.length * align) / 4);
  return d;
}
/** Instance records in instance order (grouped by material and mesh). */
function instanceData(side: number): Float32Array {
  const objs = objects(side);
  const d = new Float32Array(objs.length * (INSTANCE_BYTES / 4));
  let k = 0;
  for (const g of instanceGroups(side))
    for (const i of g.objects) {
      const o = objs[i];
      d.set([o.x, o.y, o.z, o.s], k);
      k += 4;
    }
  return d;
}
const sameColours = (a: BatchColours | null, b: BatchColours) => !!a && a.bg.join() === b.bg.join() && a.materials.join() === b.materials.join();
function named<T>(o: T, label: string): T {
  if (o && typeof o === 'object') (o as { label?: string }).label = label;
  return o;
}

// ---------------------------------------------------------------------------------------------
// WebGPU

const WGSL = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  light: vec4f,
  shade: vec4f,
  bg: vec4f,
}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> material: vec4f;
@group(2) @binding(0) var<uniform> object: vec4f; // xyz: position, w: scale

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
}

fn place(p: vec3f, n: vec3f, ps: vec4f) -> VOut {
  var o: VOut;
  o.world = p * ps.w + ps.xyz;
  o.pos = frame.viewProj * vec4f(o.world, 1.0);
  o.normal = n;
  return o;
}

// One draw per object (and static batches): the object's constants come from group 2.
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f) -> VOut {
  return place(p, n, object);
}

// Instanced: the same 16 bytes, from a per-instance vertex buffer.
@vertex fn vs_inst(@location(0) p: vec3f, @location(1) n: vec3f, @location(3) inst: vec4f) -> VOut {
  return place(p, n, inst);
}

fn tint(lum: f32) -> vec4f {
  return vec4f(mix(frame.bg.rgb, material.rgb, 0.25 + 0.75 * lum), 1.0);
}
fn lambert(n: vec3f) -> f32 {
  return frame.shade.x + frame.shade.y * max(0.0, dot(normalize(n), frame.light.xyz));
}

@fragment fn fs_lit(v: VOut) -> @location(0) vec4f {
  return tint(lambert(v.normal));
}

@fragment fn fs_banded(v: VOut) -> @location(0) vec4f {
  let band = select(1.0, 0.7, fract(v.world.y * 4.0) < 0.5);
  return tint(lambert(v.normal) * band);
}
`;

const DEPTH_FORMAT = 'depth24plus';

interface Gpu2Data {
  side: number;
  objUbo: GPUBuffer;
  objGroup: GPUObject;
  instances: GPUBuffer;
  batches: Map<number, { vb: GPUBuffer; ib: GPUBuffer }>;
}

class BatchWebGpu implements BatchRenderer {
  readonly backend = 'webgpu';
  private dev: GPUDevice;
  private canvasCtx: GPUCanvasContext;
  private align: number;
  private vbufs: GPUBuffer[] = [];
  private ibufs: GPUBuffer[] = [];
  private frameUbo!: GPUBuffer;
  private matUbo!: GPUBuffer;
  private frameGroup!: GPUObject;
  private matGroups: GPUObject[] = [];
  private objLayout!: GPUObject;
  private pipelines = new Map<string, GPUObject>();
  private depth: { w: number; h: number; tex: GPUTexture; view: GPUObject } | null = null;
  private data: Gpu2Data | null = null;
  private colours: BatchColours | null = null;
  private log: CallLog;

  private constructor(private gc: WebGpuContext, log: CallLog | null) {
    this.log = log ?? new CallLog();
    this.dev = log ? record(gc.device, log, 'device') : gc.device;
    this.canvasCtx = log ? record(gc.context, log, 'context') : gc.context;
    this.align = Math.max(256, gc.device.limits.minUniformBufferOffsetAlignment ?? 256);
  }

  static async create(gc: WebGpuContext, log: CallLog | null): Promise<BatchWebGpu> {
    const r = new BatchWebGpu(gc, log);
    await r.init();
    return r;
  }

  private async init(): Promise<void> {
    const dev = this.dev;
    this.log.phase = 'init';
    this.gc.device.pushErrorScope('validation');
    for (const m of MESHES) {
      const vb = dev.createBuffer({ label: `${m.name} vertices`, size: m.vertices.byteLength, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
      dev.queue.writeBuffer(vb, 0, m.vertices);
      const ib = dev.createBuffer({ label: `${m.name} indices`, size: m.indices.byteLength, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
      dev.queue.writeBuffer(ib, 0, m.indices);
      this.vbufs.push(vb);
      this.ibufs.push(ib);
    }
    this.frameUbo = dev.createBuffer({ label: 'frame constants', size: FRAME_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.matUbo = dev.createBuffer({ label: 'material constants', size: (MATERIALS.length - 1) * this.align + 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    const module = dev.createShaderModule({ label: 'batching shaders', code: WGSL });
    const frameLayout = dev.createBindGroupLayout({ label: 'per frame', entries: [{ binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    const matLayout = dev.createBindGroupLayout({ label: 'per material', entries: [{ binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    // The object's block is chosen by a dynamic offset at setBindGroup, so one bind group serves every object.
    this.objLayout = dev.createBindGroupLayout({ label: 'per object', entries: [{ binding: 0, visibility: ShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true } }] });
    const perObject = dev.createPipelineLayout({ label: 'per object', bindGroupLayouts: [frameLayout, matLayout, this.objLayout] });
    const instanced = dev.createPipelineLayout({ label: 'instanced', bindGroupLayouts: [frameLayout, matLayout] });
    const meshLayout = {
      arrayStride: VERTEX_STRIDE,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
      ],
    };
    const instLayout = { arrayStride: INSTANCE_BYTES, stepMode: 'instance' as const, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] };
    const jobs = PIPELINE_KEYS.map((key) => {
      const inst = key.endsWith('instanced');
      return dev
        .createRenderPipelineAsync({
          label: key,
          layout: inst ? instanced : perObject,
          vertex: { module, entryPoint: inst ? 'vs_inst' : 'vs', buffers: inst ? [meshLayout, instLayout] : [meshLayout] },
          fragment: { module, entryPoint: key.startsWith('banded') ? 'fs_banded' : 'fs_lit', targets: [{ format: this.gc.format }] },
          primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
          depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
        })
        .then((p) => void this.pipelines.set(key, p));
    });
    this.frameGroup = dev.createBindGroup({ label: 'frame', layout: frameLayout, entries: [{ binding: 0, resource: { buffer: this.frameUbo } }] });
    this.matGroups = MATERIALS.map((m, i) => dev.createBindGroup({ label: m.name, layout: matLayout, entries: [{ binding: 0, resource: { buffer: this.matUbo, offset: i * this.align, size: 16 } }] }));
    await Promise.all(jobs);
    const err = await this.gc.device.popErrorScope();
    if (err) console.error('WebGPU init:', err.message);
  }

  /** Per-side buffers: object constants, instance records, and (made on first use) the static batches. */
  private sideData(side: number): Gpu2Data {
    if (this.data?.side === side) return this.data;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    this.freeData();
    const dev = this.dev;
    const od = objectData(side, this.align);
    const objUbo = dev.createBuffer({ label: 'object constants', size: od.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    dev.queue.writeBuffer(objUbo, 0, od);
    const objGroup = dev.createBindGroup({ label: 'object', layout: this.objLayout, entries: [{ binding: 0, resource: { buffer: objUbo, offset: 0, size: OBJECT_BYTES } }] });
    const id = instanceData(side);
    const instances = dev.createBuffer({ label: 'instance records', size: id.byteLength, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    dev.queue.writeBuffer(instances, 0, id);
    this.data = { side, objUbo, objGroup, instances, batches: new Map() };
    this.log.phase = prev;
    return this.data;
  }
  private batch(d: Gpu2Data, material: number) {
    let b = d.batches.get(material);
    if (b) return b;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    const { vertices, indices } = staticBatch(objects(d.side), material);
    const vb = this.dev.createBuffer({ label: `${MATERIALS[material].name} batch vertices`, size: vertices.byteLength, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this.dev.queue.writeBuffer(vb, 0, vertices);
    const ib = this.dev.createBuffer({ label: `${MATERIALS[material].name} batch indices`, size: indices.byteLength, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
    this.dev.queue.writeBuffer(ib, 0, indices);
    b = { vb, ib };
    d.batches.set(material, b);
    this.log.phase = prev;
    return b;
  }
  private freeData(): void {
    if (!this.data) return;
    this.data.objUbo.destroy();
    this.data.instances.destroy();
    for (const b of this.data.batches.values()) (b.vb.destroy(), b.ib.destroy());
    this.data = null;
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

  frame(method: Method, side: number, cam: Camera, c: BatchColours): BatchPlan {
    const plan = planFor(method, side, cam);
    this.draw(plan, side, cam, c);
    return plan;
  }

  draw(plan: BatchPlan, side: number, cam: Camera, c: BatchColours): void {
    const dev = this.dev;
    const d = this.sideData(side);
    const draws = plan.passes[0].draws;
    for (const x of draws) if (x.mesh < 0) this.batch(d, x.material);
    if (!sameColours(this.colours, c)) {
      this.log.phase = 'rebuild';
      dev.queue.writeBuffer(this.matUbo, 0, materialData(c, this.align));
      this.colours = c;
    }
    const depth = this.depthView(this.gc.canvas.width, this.gc.canvas.height);
    this.log.phase = 'frame';
    dev.queue.writeBuffer(this.frameUbo, 0, frameData(cam, c));
    const enc = dev.createCommandEncoder({ label: 'frame' });
    const pass = enc.beginRenderPass({
      label: 'scene',
      colorAttachments: [{ view: this.canvasCtx.getCurrentTexture().createView(), clearValue: { r: c.bg[0] / 255, g: c.bg[1] / 255, b: c.bg[2] / 255, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    pass.setBindGroup(0, this.frameGroup);
    // Instanced draws read their records from slot 1; each draw's firstInstance picks its group's.
    if (draws.some((x) => x.object < 0)) pass.setVertexBuffer(1, d.instances);
    // Bind only what changed since the last draw: that is what sorting saves.
    let pipe = '';
    let mat = -1;
    let mesh = NaN;
    let obj = -1;
    for (const x of draws) {
      if (x.pipeline !== pipe) pass.setPipeline(this.pipelines.get((pipe = x.pipeline))!);
      if (x.material !== mat) pass.setBindGroup(1, this.matGroups[(mat = x.material)]);
      const m = x.mesh < 0 ? -1 - x.material - 100 : x.mesh;
      if (m !== mesh) {
        mesh = m;
        if (x.mesh < 0) {
          const b = this.batch(d, x.material);
          pass.setVertexBuffer(0, b.vb);
          pass.setIndexBuffer(b.ib, 'uint32');
        } else {
          pass.setVertexBuffer(0, this.vbufs[x.mesh]);
          pass.setIndexBuffer(this.ibufs[x.mesh], 'uint16');
        }
      }
      if (x.object >= 0 && x.object !== obj) pass.setBindGroup(2, d.objGroup, [(obj = x.object) * this.align]);
      pass.drawIndexed(x.count, x.instances, 0, 0, x.firstInstance);
    }
    pass.end();
    dev.queue.submit([enc.finish({ label: 'frame' })]);
  }

  dispose(): void {
    for (const b of [...this.vbufs, ...this.ibufs, this.frameUbo, this.matUbo]) b?.destroy();
    this.freeData();
    this.depth?.tex.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// WebGL2

const GLSL_VS = (instanced: boolean) => `#version 300 es
layout(std140) uniform Frame { mat4 viewProj; vec4 light; vec4 shade; vec4 bg; };
${instanced ? 'layout(location = 3) in vec4 inst;' : 'layout(std140) uniform Object { vec4 object; };'}
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
out vec3 vNormal;
out vec3 vWorld;
void main() {
  vec4 ps = ${instanced ? 'inst' : 'object'};
  vWorld = position * ps.w + ps.xyz;
  vec4 c = viewProj * vec4(vWorld, 1.0);
  gl_Position = vec4(c.xy, 2.0 * c.z - c.w, c.w); // depth 0..w to OpenGL's -w..w
  vNormal = normal;
}`;
const GLSL_FS = (banded: boolean) => `#version 300 es
precision highp float;
layout(std140) uniform Frame { mat4 viewProj; vec4 light; vec4 shade; vec4 bg; };
layout(std140) uniform Material { vec4 material; };
in vec3 vNormal;
in vec3 vWorld;
out vec4 outColor;
void main() {
  float lum = shade.x + shade.y * max(0.0, dot(normalize(vNormal), light.xyz));
  ${banded ? 'lum *= fract(vWorld.y * 4.0) < 0.5 ? 0.7 : 1.0;' : ''}
  outColor = vec4(mix(bg.rgb, material.rgb, 0.25 + 0.75 * lum), 1.0);
}`;

interface Gl2Data {
  side: number;
  objUbo: WebGLBuffer | null;
  instances: WebGLBuffer | null;
  /** One VAO per mesh with the instance buffer attached at location 3. */
  instVaos: Array<WebGLVertexArrayObject | null>;
  batches: Map<number, { vao: WebGLVertexArrayObject | null; vb: WebGLBuffer | null; ib: WebGLBuffer | null }>;
}

class BatchGl2 implements BatchRenderer {
  readonly backend = 'webgl2';
  private gl: WebGL2RenderingContext;
  private align: number;
  private vaos: Array<WebGLVertexArrayObject | null> = [];
  private meshBufs: Array<[WebGLBuffer | null, WebGLBuffer | null]> = [];
  private frameUbo: WebGLBuffer | null;
  private matUbo: WebGLBuffer | null;
  private programs = new Map<string, WebGLProgram>();
  private data: Gl2Data | null = null;
  private colours: BatchColours | null = null;
  private log: CallLog;

  constructor(private gc: Gl2Context, log: CallLog | null) {
    this.log = log ?? new CallLog();
    const gl = (this.gl = log ? record(gc.gl, log, 'gl') : gc.gl);
    this.log.phase = 'init';
    for (const m of MESHES) {
      const vao = named(gl.createVertexArray(), m.name);
      gl.bindVertexArray(vao);
      const vb = named(gl.createBuffer(), `${m.name} vertices`);
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, m.vertices, gl.STATIC_DRAW);
      this.meshAttribs();
      const ib = named(gl.createBuffer(), `${m.name} indices`);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.vaos.push(vao);
      this.meshBufs.push([vb, ib]);
    }
    this.align = Math.max(16, Number(gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT)) || 256);
    this.frameUbo = named(gl.createBuffer(), 'frame constants');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, FRAME_BYTES, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.frameUbo);
    this.matUbo = named(gl.createBuffer(), 'material constants');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.matUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, (MATERIALS.length - 1) * this.align + 16, gl.DYNAMIC_DRAW);
    const vs = this.shader(gl.VERTEX_SHADER, GLSL_VS(false));
    const vsInst = this.shader(gl.VERTEX_SHADER, GLSL_VS(true));
    const fs = { lit: this.shader(gl.FRAGMENT_SHADER, GLSL_FS(false)), banded: this.shader(gl.FRAGMENT_SHADER, GLSL_FS(true)) };
    for (const key of PIPELINE_KEYS) {
      const inst = key.endsWith('instanced');
      const p = this.program(key, inst ? vsInst : vs, key.startsWith('banded') ? fs.banded : fs.lit);
      // Uniform blocks to binding points 0 (frame), 1 (material), 2 (object): binding state is global, not per program.
      gl.uniformBlockBinding(p, gl.getUniformBlockIndex(p, 'Frame'), 0);
      gl.uniformBlockBinding(p, gl.getUniformBlockIndex(p, 'Material'), 1);
      if (!inst) gl.uniformBlockBinding(p, gl.getUniformBlockIndex(p, 'Object'), 2);
      this.programs.set(key, p);
    }
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
  }

  private meshAttribs(): void {
    const gl = this.gl;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, VERTEX_STRIDE, 12);
  }
  private shader(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  }
  private program(label: string, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
    const gl = this.gl;
    const p = named(gl.createProgram()!, label);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
    return p;
  }

  private sideData(side: number): Gl2Data {
    if (this.data?.side === side) return this.data;
    const gl = this.gl;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    this.freeData();
    const objUbo = named(gl.createBuffer(), 'object constants');
    gl.bindBuffer(gl.UNIFORM_BUFFER, objUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, objectData(side, this.align), gl.STATIC_DRAW);
    const instances = named(gl.createBuffer(), 'instance records');
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    gl.bufferData(gl.ARRAY_BUFFER, instanceData(side), gl.STATIC_DRAW);
    // A VAO per mesh for instanced draws: the mesh's buffers plus the instance records at location 3,
    // advancing once per instance. WebGL2 has no firstInstance, so each draw re-points location 3.
    const instVaos = MESHES.map((m, i) => {
      const vao = named(gl.createVertexArray(), `${m.name}, instanced`);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBufs[i][0]);
      this.meshAttribs();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshBufs[i][1]);
      gl.bindBuffer(gl.ARRAY_BUFFER, instances);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, INSTANCE_BYTES, 0);
      gl.vertexAttribDivisor(3, 1);
      gl.bindVertexArray(null);
      return vao;
    });
    this.data = { side, objUbo, instances, instVaos, batches: new Map() };
    this.log.phase = prev;
    return this.data;
  }
  private batch(d: Gl2Data, material: number) {
    let b = d.batches.get(material);
    if (b) return b;
    const gl = this.gl;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    const { vertices, indices } = staticBatch(objects(d.side), material);
    const vao = named(gl.createVertexArray(), `${MATERIALS[material].name} batch`);
    gl.bindVertexArray(vao);
    const vb = named(gl.createBuffer(), `${MATERIALS[material].name} batch vertices`);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    this.meshAttribs();
    const ib = named(gl.createBuffer(), `${MATERIALS[material].name} batch indices`);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    b = { vao, vb, ib };
    d.batches.set(material, b);
    this.log.phase = prev;
    return b;
  }
  private freeData(): void {
    const d = this.data;
    if (!d) return;
    const gl = this.gl;
    gl.deleteBuffer(d.objUbo);
    gl.deleteBuffer(d.instances);
    for (const v of d.instVaos) gl.deleteVertexArray(v);
    for (const b of d.batches.values()) (gl.deleteVertexArray(b.vao), gl.deleteBuffer(b.vb), gl.deleteBuffer(b.ib));
    this.data = null;
  }

  frame(method: Method, side: number, cam: Camera, c: BatchColours): BatchPlan {
    const plan = planFor(method, side, cam);
    this.draw(plan, side, cam, c);
    return plan;
  }

  draw(plan: BatchPlan, side: number, cam: Camera, c: BatchColours): void {
    const gl = this.gl;
    const d = this.sideData(side);
    const draws = plan.passes[0].draws;
    for (const x of draws) if (x.mesh < 0) this.batch(d, x.material);
    if (!sameColours(this.colours, c)) {
      this.log.phase = 'rebuild';
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.matUbo);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, materialData(c, this.align));
      this.colours = c;
    }
    this.log.phase = 'frame';
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, frameData(cam, c));
    gl.viewport(0, 0, this.gc.canvas.width, this.gc.canvas.height);
    gl.clearColor(c.bg[0] / 255, c.bg[1] / 255, c.bg[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    let pipe = '';
    let mat = -1;
    let mesh = NaN;
    let obj = -1;
    for (const x of draws) {
      if (x.pipeline !== pipe) gl.useProgram(this.programs.get((pipe = x.pipeline))!);
      if (x.material !== mat) gl.bindBufferRange(gl.UNIFORM_BUFFER, 1, this.matUbo, (mat = x.material) * this.align, 16);
      const m = x.mesh < 0 ? -1 - x.material - 100 : x.mesh;
      const inst = x.object < 0;
      if (m !== mesh) {
        mesh = m;
        gl.bindVertexArray(x.mesh < 0 ? this.batch(d, x.material).vao : inst ? d.instVaos[x.mesh] : this.vaos[x.mesh]);
      }
      if (x.object >= 0 && x.object !== obj) gl.bindBufferRange(gl.UNIFORM_BUFFER, 2, d.objUbo, (obj = x.object) * this.align, OBJECT_BYTES);
      if (inst) {
        // No firstInstance in WebGL2: point location 3 at this group's records (the VAO is bound, so this changes it).
        gl.bindBuffer(gl.ARRAY_BUFFER, d.instances);
        gl.vertexAttribPointer(3, 4, gl.FLOAT, false, INSTANCE_BYTES, x.firstInstance * INSTANCE_BYTES);
        gl.drawElementsInstanced(gl.TRIANGLES, x.count, gl.UNSIGNED_SHORT, 0, x.instances);
      } else gl.drawElements(gl.TRIANGLES, x.count, x.mesh < 0 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    // The context is lost or released by disposeGpu; its objects go with it.
  }
}

