/**
 * "Bandwidth": a small deferred frame drawn with WebGPU and with WebGL2, with the render-target
 * formats and load/store ops the widget chooses. It walks bandwidthPlan (scenes/bandwidth.ts):
 *
 *   G-buffer  the pipeline lesson's floor and box into albedo (rgba8unorm), normal and depth
 *   lighting  a full-screen triangle reads them and writes lit HDR colour (with fog from depth)
 *   post      a full-screen triangle tone-maps the HDR colour onto the canvas
 *
 * WebGPU says what to do with each attachment at the start and end of a pass (loadOp, storeOp).
 * WebGL2 has no such thing: "clear" is a clear call, "load" is doing nothing, and "discard" is
 * gl.invalidateFramebuffer, a hint the driver may ignore. Targets are the chosen size, not the
 * canvas's, so the bytes are the ones the model counts.
 */
import { type Gl2Context, type GpuContext, type WebGpuContext } from './context';
import { GLSL_FULLSCREEN_VS, WGSL_FULLSCREEN, glProgram, named, target } from './perf-common';
import { type FramePlan } from './plan';
import { type CallLog, record } from './record';
import { KEY_LIGHT, VERTEX_ATTRS, VERTEX_STRIDE, gpuDraws, viewProj } from './scene';
import { Gl2Timer, type GpuTimer, WebGpuTimer } from './timing';
import { BufferUsage, type GPUBuffer, type GPUCanvasContext, type GPUDevice, type GPUObject, type GPUShaderModule, type GPUTexture, ShaderStage, TextureUsage } from './webgpu';
import { type BandwidthSettings, type Ops, bandwidthPlan } from '../scenes/bandwidth';
import { pipelineCamera, pipelineScene } from '../scenes/the-pipeline';

export interface BandwidthColours {
  bg: [number, number, number];
  draws: Array<[number, number, number]>;
}

export interface BandwidthRenderer {
  readonly backend: 'webgpu' | 'webgl2';
  readonly timer: GpuTimer;
  /** Why a setting can't be drawn as chosen here (a format that isn't renderable), or null. */
  unsupported(s: BandwidthSettings): string | null;
  /** Whether depth was created as a transient (memoryless) attachment. */
  transientDepth: boolean;
  /** Make the targets and pipelines these settings need. */
  prepare(s: BandwidthSettings): Promise<void>;
  frame(s: BandwidthSettings, c: BandwidthColours): { plan: FramePlan; timed: boolean };
  dispose(): void;
}

export async function createBandwidth(ctx: GpuContext, log: CallLog): Promise<BandwidthRenderer> {
  return ctx.kind === 'webgpu' ? BandwidthWebGpu.create(ctx, log) : new BandwidthGl2(ctx, log);
}

export const bandwidthDraws = () => gpuDraws(pipelineScene());
/** The camera: the pipeline lesson's, at the target's aspect ratio, near plane 0.5 m. */
export const NEAR = 0.5;
export const FAR = 100;
const camera = (s: BandwidthSettings) => ({ ...pipelineCamera(NEAR), aspect: s.w / s.h });

/** Frame uniforms: viewProj, light dir, (ambient, diffuse, fog on, near), (far, 0, 0, 0), background in HDR. */
const FRAME_BYTES = 128;
/** Per-draw: colour and (checker?, 0, 0, 0), 256 bytes apart. */
const DRAW_BYTES = 32;

/** Reinhard's x / (1 + x) inverted, so the background comes out of the tone map as the theme's colour. */
const untonemap = (c: number) => Math.min(c / 255, 0.98) / (1 - Math.min(c / 255, 0.98));
function frameData(s: BandwidthSettings, c: BandwidthColours): Float32Array {
  const d = new Float32Array(FRAME_BYTES / 4);
  d.set(viewProj(camera(s)), 0);
  d.set([KEY_LIGHT.dir.x, KEY_LIGHT.dir.y, KEY_LIGHT.dir.z, 0], 16);
  d.set([KEY_LIGHT.ambient, KEY_LIGHT.diffuse, s.fog ? 1 : 0, NEAR], 20);
  d.set([FAR, 0, 0, 0], 24);
  d.set([untonemap(c.bg[0]), untonemap(c.bg[1]), untonemap(c.bg[2]), 1], 28 - 0);
  return d;
}
function drawData(c: BandwidthColours, align: number): Float32Array {
  const d = new Float32Array(((c.draws.length - 1) * align + DRAW_BYTES) / 4);
  c.draws.forEach((col, i) => d.set([col[0] / 255, col[1] / 255, col[2] / 255, 1, i === 0 ? 1 : 0, 0, 0, 0], (i * align) / 4));
  return d;
}

// ---------------------------------------------------------------------------------------------
// Shaders

const WGSL_FRAME = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  light: vec4f,
  shade: vec4f,  // ambient, diffuse, fog on, near
  far: vec4f,
  bg: vec4f,     // the background, before tone mapping
}
@group(0) @binding(0) var<uniform> frame: Frame;
`;
// FRAME_BYTES has room for viewProj (64), light, shade, far and bg (16 each): 128.

const WGSL_GBUFFER = /* wgsl */ `${WGSL_FRAME}
struct Draw { color: vec4f, kind: vec4f }
@group(1) @binding(0) var<uniform> draw: Draw;
struct VOut { @builtin(position) pos: vec4f, @location(0) normal: vec3f, @location(1) uv: vec2f }
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f) -> VOut {
  var o: VOut;
  o.pos = frame.viewProj * vec4f(p, 1.0);
  o.normal = n;
  o.uv = uv;
  return o;
}
struct GOut { @location(0) albedo: vec4f, @location(1) normal: vec4f }
@fragment fn fs(v: VOut) -> GOut {
  var g: GOut;
  var k = 1.0;
  if (draw.kind.x > 0.5) {
    let odd = (i32(floor(v.uv.x)) + i32(floor(v.uv.y))) & 1;
    k = select(1.0, 0.55, odd == 1);
  }
  g.albedo = vec4f(draw.color.rgb * k, 1.0);
  // Unit normal into 0..1; alpha 1 marks "something was drawn here".
  g.normal = vec4f(normalize(v.normal) * 0.5 + 0.5, 1.0);
  return g;
}
`;

const WGSL_LIGHTING = /* wgsl */ `${WGSL_FRAME}${WGSL_FULLSCREEN}
@group(1) @binding(0) var albedo: texture_2d<f32>;
@group(1) @binding(1) var normals: texture_2d<f32>;
@group(1) @binding(2) var depth: texture_depth_2d;
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let t = vec2i(p.xy);
  let nn = textureLoad(normals, t, 0);
  if (nn.a < 0.5) { return frame.bg; }
  let n = normalize(nn.xyz * 2.0 - 1.0);
  let lum = frame.shade.x + frame.shade.y * max(0.0, dot(n, frame.light.xyz));
  var c = textureLoad(albedo, t, 0).rgb * lum * 1.8;
  if (frame.shade.z > 0.5) {
    // Distance from the stored depth (0..1), then exponential fog towards the background.
    let d = textureLoad(depth, t, 0);
    let z = frame.shade.w * frame.far.x / (frame.far.x - d * (frame.far.x - frame.shade.w));
    c = mix(frame.bg.rgb, c, exp(-z * 0.06));
  }
  return vec4f(c, 1.0);
}
`;

const WGSL_POST = /* wgsl */ `${WGSL_FULLSCREEN}
@group(0) @binding(0) var hdr: texture_2d<f32>;
struct Post { size: vec4f }  // HDR size, canvas size
@group(0) @binding(1) var<uniform> post: Post;
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let t = vec2i(p.xy / post.size.zw * post.size.xy);
  let x = max(textureLoad(hdr, t, 0).rgb, vec3f(0.0));
  return vec4f(x / (1.0 + x), 1.0);  // Reinhard
}
`;

/** Can this adapter render to it? (WebGPU core renders all of them except rg11b10ufloat, which needs a feature.) */
const gpuRenderable = (f: string, dev: GPUDevice) => f !== 'rg11b10ufloat' || dev.features.has('rg11b10ufloat-renderable');
/** GPUTextureUsage.TRANSIENT_ATTACHMENT where the browser has it (Chrome 146 and later); null otherwise. */
export function transientUsage(): number | null {
  const u = (globalThis as { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage;
  return u && typeof u.TRANSIENT_ATTACHMENT === 'number' ? u.TRANSIENT_ATTACHMENT : null;
}
/** Depth can be transient when nothing reads it and it's cleared and discarded. */
const depthTransient = (s: BandwidthSettings) => !s.fog && s.depthOps.load === 'clear' && s.depthOps.store === 'discard';

// ---------------------------------------------------------------------------------------------
// WebGPU

class BandwidthWebGpu implements BandwidthRenderer {
  readonly backend = 'webgpu';
  readonly timer: WebGpuTimer;
  transientDepth = false;
  private dev: GPUDevice;
  private canvasCtx: GPUCanvasContext;
  private draws = bandwidthDraws();
  private vbufs: GPUBuffer[] = [];
  private ibufs: GPUBuffer[] = [];
  private frameUbo!: GPUBuffer;
  private drawUbo!: GPUBuffer;
  private postUbo!: GPUBuffer;
  private align: number;
  private frameGroup!: GPUObject;
  private drawGroups: GPUObject[] = [];
  private layouts!: { frame: GPUObject; draw: GPUObject; light: GPUObject; post: GPUObject; gbuffer: GPUObject; lighting: GPUObject; postPipe: GPUObject };
  private modules!: { gbuffer: GPUShaderModule; lighting: GPUShaderModule; post: GPUShaderModule };
  private pipes = new Map<string, GPUObject>();
  private dummyDepth!: GPUObject;
  private t: {
    key: string;
    textures: GPUTexture[];
    albedo: GPUObject;
    normal: GPUObject;
    depth: GPUObject;
    hdr: GPUObject;
    lightGroup: GPUObject;
    postGroup: GPUObject;
  } | null = null;

  private constructor(
    private gc: WebGpuContext,
    private log: CallLog,
  ) {
    this.dev = record(gc.device, log, 'device');
    this.canvasCtx = record(gc.context, log, 'context');
    this.align = Math.max(256, gc.device.limits.minUniformBufferOffsetAlignment ?? 256);
    this.timer = new WebGpuTimer(gc, log, 3);
  }

  static async create(gc: WebGpuContext, log: CallLog): Promise<BandwidthWebGpu> {
    const r = new BandwidthWebGpu(gc, log);
    r.init();
    return r;
  }

  private init(): void {
    const dev = this.dev;
    this.log.phase = 'init';
    for (const d of this.draws) {
      const vb = dev.createBuffer({ label: `${d.name} vertices`, size: d.mesh.vertices.byteLength, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
      dev.queue.writeBuffer(vb, 0, d.mesh.vertices);
      const ib = dev.createBuffer({ label: `${d.name} indices`, size: d.mesh.indices.byteLength, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
      dev.queue.writeBuffer(ib, 0, d.mesh.indices);
      this.vbufs.push(vb);
      this.ibufs.push(ib);
    }
    this.frameUbo = dev.createBuffer({ label: 'frame constants', size: FRAME_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.drawUbo = dev.createBuffer({ label: 'draw constants', size: (this.draws.length - 1) * this.align + DRAW_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.postUbo = dev.createBuffer({ label: 'post constants', size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    const F = ShaderStage.FRAGMENT;
    const frame = dev.createBindGroupLayout({ label: 'per frame', entries: [{ binding: 0, visibility: ShaderStage.VERTEX | F, buffer: { type: 'uniform' } }] });
    const draw = dev.createBindGroupLayout({ label: 'per draw', entries: [{ binding: 0, visibility: F, buffer: { type: 'uniform' } }] });
    // textureLoad only: every format here is fine as 'unfilterable-float', including rgba32float.
    const light = dev.createBindGroupLayout({
      label: 'G-buffer',
      entries: [
        { binding: 0, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: F, texture: { sampleType: 'depth' } },
      ],
    });
    const post = dev.createBindGroupLayout({
      label: 'post',
      entries: [
        { binding: 0, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: F, buffer: { type: 'uniform' } },
      ],
    });
    this.layouts = {
      frame,
      draw,
      light,
      post,
      gbuffer: dev.createPipelineLayout({ label: 'G-buffer', bindGroupLayouts: [frame, draw] }),
      lighting: dev.createPipelineLayout({ label: 'lighting', bindGroupLayouts: [frame, light] }),
      postPipe: dev.createPipelineLayout({ label: 'post', bindGroupLayouts: [post] }),
    };
    this.modules = {
      gbuffer: dev.createShaderModule({ label: 'G-buffer', code: WGSL_GBUFFER }),
      lighting: dev.createShaderModule({ label: 'lighting', code: WGSL_LIGHTING }),
      post: dev.createShaderModule({ label: 'post', code: WGSL_POST }),
    };
    this.frameGroup = dev.createBindGroup({ label: 'frame', layout: frame, entries: [{ binding: 0, resource: { buffer: this.frameUbo } }] });
    this.drawGroups = this.draws.map((d, i) => dev.createBindGroup({ label: d.name, layout: draw, entries: [{ binding: 0, resource: { buffer: this.drawUbo, offset: i * this.align, size: DRAW_BYTES } }] }));
    // Bound in place of depth when depth is transient (it can't be sampled, and fog is off so it isn't).
    this.dummyDepth = dev.createTexture({ label: 'unused depth', size: [1, 1], format: 'depth32float', usage: TextureUsage.TEXTURE_BINDING }).createView();
  }

  unsupported(s: BandwidthSettings): string | null {
    for (const f of [s.normal, s.hdr]) if (!gpuRenderable(f, this.gc.device)) return `${f} isn't renderable on this adapter (WebGPU needs the optional 'rg11b10ufloat-renderable' feature, which this adapter doesn't offer)`;
    return null;
  }

  private pipeline(key: string, make: () => Promise<GPUObject>): Promise<void> {
    if (this.pipes.has(key)) return Promise.resolve();
    return make().then((p) => void this.pipes.set(key, p));
  }

  async prepare(s: BandwidthSettings): Promise<void> {
    const dev = this.dev;
    const plan = bandwidthPlan(s, this.draws.map((d) => ({ name: d.name, count: d.mesh.indexCount })));
    const vertexLayout = { arrayStride: VERTEX_STRIDE, attributes: VERTEX_ATTRS.map((a) => ({ shaderLocation: a.location, offset: a.offset, format: `float32x${a.components}` })) };
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    const jobs = [
      this.pipeline(plan.passes[0].draws[0].pipeline, () =>
        dev.createRenderPipelineAsync({
          label: plan.passes[0].draws[0].pipeline,
          layout: this.layouts.gbuffer,
          vertex: { module: this.modules.gbuffer, entryPoint: 'vs', buffers: [vertexLayout] },
          fragment: { module: this.modules.gbuffer, entryPoint: 'fs', targets: [target('rgba8unorm'), target(s.normal)] },
          primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
          depthStencil: { format: s.depth, depthWriteEnabled: true, depthCompare: 'less' },
        }),
      ),
      this.pipeline(plan.passes[1].draws[0].pipeline, () =>
        dev.createRenderPipelineAsync({
          label: plan.passes[1].draws[0].pipeline,
          layout: this.layouts.lighting,
          vertex: { module: this.modules.lighting, entryPoint: 'vs_full' },
          fragment: { module: this.modules.lighting, entryPoint: 'fs', targets: [target(s.hdr)] },
          primitive: { topology: 'triangle-list' },
        }),
      ),
      this.pipeline('post', () =>
        dev.createRenderPipelineAsync({
          label: 'post',
          layout: this.layouts.postPipe,
          vertex: { module: this.modules.post, entryPoint: 'vs_full' },
          fragment: { module: this.modules.post, entryPoint: 'fs', targets: [target(this.gc.format)] },
          primitive: { topology: 'triangle-list' },
        }),
      ),
    ];
    this.targets(s);
    this.log.phase = prev;
    await Promise.all(jobs);
  }

  private targets(s: BandwidthSettings) {
    const transient = transientUsage();
    const makeTransient = transient !== null && depthTransient(s);
    const key = `${s.w}x${s.h} ${s.normal} ${s.depth} ${s.hdr} ${makeTransient}`;
    if (this.t?.key === key) return this.t;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    for (const x of this.t?.textures ?? []) x.destroy();
    const dev = this.dev;
    const RT = TextureUsage.RENDER_ATTACHMENT;
    const tex = (label: string, format: string, usage: number) => dev.createTexture({ label, size: [s.w, s.h], format, usage });
    const albedo = tex('albedo', 'rgba8unorm', RT | TextureUsage.TEXTURE_BINDING);
    const normal = tex('normal', s.normal, RT | TextureUsage.TEXTURE_BINDING);
    // A transient attachment may have no other usage: it can't be sampled or copied, only drawn to.
    const depth = tex('depth', s.depth, makeTransient ? RT | (transient as number) : RT | TextureUsage.TEXTURE_BINDING);
    const hdr = tex('HDR colour', s.hdr, RT | TextureUsage.TEXTURE_BINDING);
    this.transientDepth = makeTransient;
    const views = { albedo: albedo.createView({ label: 'albedo' }), normal: normal.createView({ label: 'normal' }), depth: depth.createView({ label: 'depth' }), hdr: hdr.createView({ label: 'HDR colour' }) };
    // Sampling a depth-stencil texture needs a view of its depth aspect only.
    const depthSample = makeTransient ? this.dummyDepth : depth.createView(s.depth.includes('stencil') ? ({ label: 'depth aspect', aspect: 'depth-only' } as { label: string }) : undefined);
    const lightGroup = dev.createBindGroup({
      label: 'G-buffer',
      layout: this.layouts.light,
      entries: [
        { binding: 0, resource: views.albedo },
        { binding: 1, resource: views.normal },
        { binding: 2, resource: depthSample },
      ],
    });
    const postGroup = dev.createBindGroup({
      label: 'HDR colour',
      layout: this.layouts.post,
      entries: [
        { binding: 0, resource: views.hdr },
        { binding: 1, resource: { buffer: this.postUbo } },
      ],
    });
    this.t = { key, textures: [albedo, normal, depth, hdr], ...views, lightGroup, postGroup };
    this.log.phase = prev;
    return this.t;
  }

  frame(s: BandwidthSettings, c: BandwidthColours): { plan: FramePlan; timed: boolean } {
    const dev = this.dev;
    const plan = bandwidthPlan(s, this.draws.map((d) => ({ name: d.name, count: d.mesh.indexCount })));
    // Settings can change while prepare() is still compiling their pipelines: skip until it's done.
    if (this.unsupported(s) || !plan.passes.every((p) => p.draws.every((d) => this.pipes.has(d.pipeline)))) return { plan, timed: false };
    const t = this.targets(s);
    this.log.phase = 'frame';
    dev.queue.writeBuffer(this.frameUbo, 0, frameData(s, c));
    dev.queue.writeBuffer(this.drawUbo, 0, drawData(c, this.align));
    dev.queue.writeBuffer(this.postUbo, 0, new Float32Array([s.w, s.h, this.gc.canvas.width, this.gc.canvas.height]));
    const zero = { r: 0, g: 0, b: 0, a: 0 };
    const col = (view: GPUObject, o: Ops) => ({ view, clearValue: zero, loadOp: o.load, storeOp: o.store });
    const enc = dev.createCommandEncoder({ label: 'frame' });
    const [g, l] = plan.passes;
    // No labels on these descriptors, so the recorded call shows them in full (a labelled object prints as its label).
    const gp = enc.beginRenderPass({
      colorAttachments: [col(t.albedo, s.albedoOps), col(t.normal, s.normalOps)],
      depthStencilAttachment: { view: t.depth, depthClearValue: 1, depthLoadOp: s.depthOps.load, depthStoreOp: s.depthOps.store, ...(s.depth.includes('stencil') ? { stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard' } : {}) },
      timestampWrites: this.timer.writes(0),
    });
    gp.setBindGroup(0, this.frameGroup);
    g.draws.forEach((d, i) => {
      gp.setPipeline(this.pipes.get(d.pipeline)!);
      gp.setBindGroup(1, this.drawGroups[i]);
      gp.setVertexBuffer(0, this.vbufs[i]);
      gp.setIndexBuffer(this.ibufs[i], 'uint16');
      gp.drawIndexed(d.count, 1, 0, 0, 0);
    });
    gp.end();
    const lp = enc.beginRenderPass({ colorAttachments: [col(t.hdr, s.hdrOps)], timestampWrites: this.timer.writes(1) });
    lp.setPipeline(this.pipes.get(l.draws[0].pipeline)!);
    lp.setBindGroup(0, this.frameGroup);
    lp.setBindGroup(1, t.lightGroup);
    lp.draw(3, 1, 0, 0);
    lp.end();
    const pp = enc.beginRenderPass({
      colorAttachments: [{ view: this.canvasCtx.getCurrentTexture().createView({ label: 'the canvas' }), clearValue: zero, loadOp: 'clear', storeOp: 'store' }],
      timestampWrites: this.timer.writes(2),
    });
    pp.setPipeline(this.pipes.get('post')!);
    pp.setBindGroup(0, t.postGroup);
    pp.draw(3, 1, 0, 0);
    pp.end();
    const timed = this.timer.resolve(enc);
    dev.queue.submit([enc.finish({ label: 'frame' })]);
    this.timer.submitted();
    return { plan, timed };
  }

  dispose(): void {
    for (const b of [...this.vbufs, ...this.ibufs, this.frameUbo, this.drawUbo, this.postUbo]) b?.destroy();
    for (const x of this.t?.textures ?? []) x.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// WebGL2

const GLSL_FRAME = `layout(std140) uniform Frame { mat4 viewProj; vec4 light; vec4 shade; vec4 far; vec4 bg; };`;
const GLSL_GBUFFER_VS = `#version 300 es
${GLSL_FRAME}
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vec4 c = viewProj * vec4(position, 1.0);
  gl_Position = vec4(c.xy, 2.0 * c.z - c.w, c.w);
  vNormal = normal;
  vUv = uv;
}`;
const GLSL_GBUFFER_FS = `#version 300 es
precision highp float;
layout(std140) uniform Draw { vec4 color; vec4 kind; };
in vec3 vNormal;
in vec2 vUv;
layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outNormal;
void main() {
  float k = 1.0;
  if (kind.x > 0.5) k = ((int(floor(vUv.x)) + int(floor(vUv.y))) & 1) == 1 ? 0.55 : 1.0;
  outAlbedo = vec4(color.rgb * k, 1.0);
  outNormal = vec4(normalize(vNormal) * 0.5 + 0.5, 1.0);
}`;
const GLSL_LIGHTING_FS = `#version 300 es
precision highp float;
${GLSL_FRAME}
uniform sampler2D albedo;
uniform sampler2D normals;
uniform highp sampler2D depthTex;
out vec4 outColor;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 nn = texelFetch(normals, t, 0);
  if (nn.a < 0.5) { outColor = bg; return; }
  vec3 n = normalize(nn.xyz * 2.0 - 1.0);
  float lum = shade.x + shade.y * max(0.0, dot(n, light.xyz));
  vec3 c = texelFetch(albedo, t, 0).rgb * lum * 1.8;
  if (shade.z > 0.5) {
    float d = texelFetch(depthTex, t, 0).r;
    float z = shade.w * far.x / (far.x - d * (far.x - shade.w));
    c = mix(bg.rgb, c, exp(-z * 0.06));
  }
  outColor = vec4(c, 1.0);
}`;
const GLSL_POST_FS = `#version 300 es
precision highp float;
uniform sampler2D hdr;
uniform vec4 size;
out vec4 outColor;
void main() {
  vec3 x = max(texelFetch(hdr, ivec2(gl_FragCoord.xy / size.zw * size.xy), 0).rgb, vec3(0.0));
  outColor = vec4(x / (1.0 + x), 1.0);
}`;

class BandwidthGl2 implements BandwidthRenderer {
  readonly backend = 'webgl2';
  readonly timer: Gl2Timer;
  transientDepth = false;
  private gl: WebGL2RenderingContext;
  private draws = bandwidthDraws();
  private vaos: Array<WebGLVertexArrayObject | null> = [];
  private frameUbo: WebGLBuffer | null;
  private drawUbo: WebGLBuffer | null;
  private align: number;
  private progs: { gbuffer: WebGLProgram; lighting: WebGLProgram; post: WebGLProgram };
  private sizeLoc: WebGLUniformLocation | null;
  private floatOk: boolean;
  private t: { key: string; gfbo: WebGLFramebuffer | null; lfbo: WebGLFramebuffer | null; tex: Array<WebGLTexture | null>; depthAttachment: number } | null = null;

  constructor(
    private gc: Gl2Context,
    private log: CallLog,
  ) {
    const gl = (this.gl = record(gc.gl, log, 'gl'));
    this.timer = new Gl2Timer(gc, log);
    log.phase = 'init';
    // Rendering to 16- and 32-bit float and R11F_G11F_B10F targets needs this extension in WebGL2.
    this.floatOk = !!gl.getExtension('EXT_color_buffer_float');
    for (const d of this.draws) {
      const vao = named(gl.createVertexArray(), d.name);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, named(gl.createBuffer(), `${d.name} vertices`));
      gl.bufferData(gl.ARRAY_BUFFER, d.mesh.vertices, gl.STATIC_DRAW);
      for (const a of VERTEX_ATTRS) {
        gl.enableVertexAttribArray(a.location);
        gl.vertexAttribPointer(a.location, a.components, gl.FLOAT, false, VERTEX_STRIDE, a.offset);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, named(gl.createBuffer(), `${d.name} indices`));
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.mesh.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.vaos.push(vao);
    }
    this.align = Math.max(16, Number(gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT)) || 256);
    this.frameUbo = named(gl.createBuffer(), 'frame constants');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, FRAME_BYTES, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.frameUbo);
    this.drawUbo = named(gl.createBuffer(), 'draw constants');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.drawUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, (this.draws.length - 1) * this.align + DRAW_BYTES, gl.DYNAMIC_DRAW);
    const gbuffer = glProgram(gl, 'G-buffer', GLSL_GBUFFER_VS, GLSL_GBUFFER_FS);
    const lighting = glProgram(gl, 'lighting', GLSL_FULLSCREEN_VS, GLSL_LIGHTING_FS);
    const post = glProgram(gl, 'post', GLSL_FULLSCREEN_VS, GLSL_POST_FS);
    gl.uniformBlockBinding(gbuffer, gl.getUniformBlockIndex(gbuffer, 'Frame'), 0);
    gl.uniformBlockBinding(gbuffer, gl.getUniformBlockIndex(gbuffer, 'Draw'), 1);
    gl.uniformBlockBinding(lighting, gl.getUniformBlockIndex(lighting, 'Frame'), 0);
    gl.useProgram(lighting);
    ['albedo', 'normals', 'depthTex'].forEach((n, i) => gl.uniform1i(gl.getUniformLocation(lighting, n), i));
    gl.useProgram(post);
    gl.uniform1i(gl.getUniformLocation(post, 'hdr'), 0);
    this.sizeLoc = gl.getUniformLocation(post, 'size');
    this.progs = { gbuffer, lighting, post };
    gl.depthFunc(gl.LESS);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
  }

  unsupported(s: BandwidthSettings): string | null {
    for (const f of [s.normal, s.hdr]) if ((f === 'rgba16float' || f === 'rg11b10ufloat' || f === 'rgba32float') && !this.floatOk) return `${f} isn't renderable here: WebGL2 needs EXT_color_buffer_float for float targets, and this browser doesn't expose it`;
    return null;
  }

  async prepare(s: BandwidthSettings): Promise<void> {
    this.targets(s);
  }

  private internal(f: string): number {
    const gl = this.gl;
    const m: Record<string, number> = {
      rgba8unorm: gl.RGBA8,
      rgb10a2unorm: gl.RGB10_A2,
      rgba16float: gl.RGBA16F,
      rg11b10ufloat: gl.R11F_G11F_B10F,
      rgba32float: gl.RGBA32F,
      depth16unorm: gl.DEPTH_COMPONENT16,
      depth24plus: gl.DEPTH_COMPONENT24,
      'depth24plus-stencil8': gl.DEPTH24_STENCIL8,
      depth32float: gl.DEPTH_COMPONENT32F,
    };
    return m[f];
  }

  private targets(s: BandwidthSettings) {
    const key = `${s.w}x${s.h} ${s.normal} ${s.depth} ${s.hdr}`;
    if (this.t?.key === key) return this.t;
    const gl = this.gl;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    if (this.t) {
      for (const x of this.t.tex) gl.deleteTexture(x);
      gl.deleteFramebuffer(this.t.gfbo);
      gl.deleteFramebuffer(this.t.lfbo);
    }
    const tex = (label: string, f: string) => {
      const t = named(gl.createTexture(), label);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, this.internal(f), s.w, s.h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    const albedo = tex('albedo', 'rgba8unorm');
    const normal = tex('normal', s.normal);
    const depth = tex('depth', s.depth);
    const hdr = tex('HDR colour', s.hdr);
    const depthAttachment = s.depth.includes('stencil') ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
    const gfbo = named(gl.createFramebuffer(), 'G-buffer');
    gl.bindFramebuffer(gl.FRAMEBUFFER, gfbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, albedo, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, normal, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, depthAttachment, gl.TEXTURE_2D, depth, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const lfbo = named(gl.createFramebuffer(), 'lighting');
    gl.bindFramebuffer(gl.FRAMEBUFFER, lfbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, hdr, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.t = { key, gfbo, lfbo, tex: [albedo, normal, depth, hdr], depthAttachment };
    this.log.phase = prev;
    return this.t;
  }

  frame(s: BandwidthSettings, c: BandwidthColours): { plan: FramePlan; timed: boolean } {
    const gl = this.gl;
    const plan = bandwidthPlan(s, this.draws.map((d) => ({ name: d.name, count: d.mesh.indexCount })));
    if (this.unsupported(s)) return { plan, timed: false };
    const t = this.targets(s);
    this.log.phase = 'frame';
    const timed = !!this.gc.timerExt && !!this.timer.onTimes;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, frameData(s, c));
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.drawUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, drawData(c, this.align));
    const zero = new Float32Array([0, 0, 0, 0]);
    // A store op of "discard" is a hint after the pass: these attachments' contents may be thrown away.
    const invalidate = (list: Array<[Ops, number]>) => {
      const a = list.filter(([o]) => o.store === 'discard').map(([, x]) => x);
      if (a.length) gl.invalidateFramebuffer(gl.FRAMEBUFFER, a);
    };

    // G-buffer. A load op of "clear" is a clear call per attachment; "load" is no call at all.
    this.timer.begin(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.gfbo);
    gl.viewport(0, 0, s.w, s.h);
    if (s.albedoOps.load === 'clear') gl.clearBufferfv(gl.COLOR, 0, zero);
    if (s.normalOps.load === 'clear') gl.clearBufferfv(gl.COLOR, 1, zero);
    if (s.depthOps.load === 'clear') {
      if (t.depthAttachment === gl.DEPTH_STENCIL_ATTACHMENT) gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
      else gl.clearBufferfv(gl.DEPTH, 0, new Float32Array([1]));
    }
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.useProgram(this.progs.gbuffer);
    plan.passes[0].draws.forEach((d, i) => {
      gl.bindBufferRange(gl.UNIFORM_BUFFER, 1, this.drawUbo, i * this.align, DRAW_BYTES);
      gl.bindVertexArray(this.vaos[i]);
      gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, 0);
    });
    invalidate([
      [s.albedoOps, gl.COLOR_ATTACHMENT0],
      [s.normalOps, gl.COLOR_ATTACHMENT1],
      [s.depthOps, t.depthAttachment],
    ]);
    this.timer.end(gl);

    // Lighting.
    this.timer.begin(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.lfbo);
    gl.viewport(0, 0, s.w, s.h);
    if (s.hdrOps.load === 'clear') gl.clearBufferfv(gl.COLOR, 0, zero);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.progs.lighting);
    gl.bindVertexArray(null);
    t.tex.slice(0, 3).forEach((x, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, x);
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    invalidate([[s.hdrOps, gl.COLOR_ATTACHMENT0]]);
    this.timer.end(gl);

    // Post, onto the canvas.
    this.timer.begin(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(this.progs.post);
    gl.uniform4f(this.sizeLoc, s.w, s.h, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.timer.end(gl);
    this.timer.submitted(gl);
    return { plan, timed };
  }

  dispose(): void {
    // The context is lost or released by disposeGpu; its objects go with it.
  }
}
