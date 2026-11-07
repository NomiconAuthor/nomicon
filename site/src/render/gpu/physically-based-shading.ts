/**
 * "Physically based shading": spheres lit by a sun and by an environment, with WebGPU and WebGL2.
 * Both walk the plan in scenes/physically-based-shading.ts: one pass, the environment behind (a
 * full-screen triangle) and the spheres (one instanced draw for the grid, or one sphere).
 *
 * The fragment shader is UE4's model as Karis's notes give it: Lambert diffuse; GGX D with
 * α = roughness²; Smith-Schlick G with k = (roughness + 1)² / 8 for the sun; Schlick's Fresnel.
 * Image-based lighting is the split sum: the environment prefiltered per roughness (one band of an
 * equirectangular texture per level, plus a band of irradiance for diffuse) times the BRDF table's
 * scale and bias on F0. Both tables are computed on the CPU (scenes/) and uploaded once.
 */
import { type Gl2Context, type GpuContext, type WebGpuContext } from './context';
import { type FramePlan } from './plan';
import { type CallLog, record } from './record';
import { type GpuTimer, Gl2Timer, WebGpuTimer } from './timing';
import { type GPUBuffer, type GPUCanvasContext, type GPUDevice, type GPUObject, type GPUTexture, ShaderStage, TextureUsage } from './webgpu';
import { GLSL_FULLSCREEN_VS, GLSL_SRGB, VERTEX_LAYOUT, WGSL_FULLSCREEN, WGSL_SRGB, bindBlocks, bindSamplers, compile, glFramebuffer, glMeshes, glTexture, gpuMeshBuffers, link, named, uniformBuffer } from './lighting';
import { type RGB, invert4 } from '../scenes/courtyard';
import { BALL_PIPE, ENV_BANDS, ENV_H, ENV_LEVELS, ENV_W, GRID_COLS, LUT_SIZE, PBR_CAMERA, type PbrSettings, SKY_PIPE, SUN, halves, pbrPlan, pbrViewProj, sphereMesh } from '../scenes/physically-based-shading';

export interface PbrRenderer {
  readonly backend: 'webgpu' | 'webgl2';
  readonly timer: GpuTimer;
  frame(s: PbrSettings, base: RGB): FramePlan;
  dispose(): void;
}
/** The two tables, computed by the caller (they take a moment): RGBA floats. */
export interface PbrTables {
  env: Float32Array;
  lut: Float32Array;
}

export async function createPbr(ctx: GpuContext, log: CallLog, t: PbrTables): Promise<PbrRenderer> {
  return ctx.kind === 'webgpu' ? PbrWebGpu.create(ctx, log, t) : new PbrGl2(ctx, log, t);
}

/** Frame constants: viewProj, inverse, eye + layout, sun, material (2 × vec4), flags: 224 bytes. */
export const PBR_FRAME_BYTES = 224;
const VIEW_INDEX = { full: 0, diffuse: 1, specular: 2 } as const;

function frameData(s: PbrSettings, base: RGB): Float32Array {
  const d = new Float32Array(PBR_FRAME_BYTES / 4);
  const vp = pbrViewProj();
  d.set(vp, 0);
  d.set(invert4(vp), 16);
  const e = PBR_CAMERA.eye;
  d.set([e.x, e.y, e.z, s.layout === 'grid' ? 0 : 1], 32);
  d.set([SUN.dir.x, SUN.dir.y, SUN.dir.z, SUN.intensity], 36);
  d.set([base[0], base[1], base[2], s.metal], 40);
  d.set([s.roughness, s.reflectance, (s.direct ? 1 : 0) + (s.ibl ? 2 : 0), VIEW_INDEX[s.view]], 44);
  d.set([1, 0, 0, 0], 48);
  return d;
}

const PI = '3.14159265';

// ---------------------------------------------------------------------------------------------
// Shading, shared by both languages through a few substitutions would be clever; it's written twice instead.

const WGSL = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  eye: vec4f,   // w: 0 grid, 1 one sphere
  sun: vec4f,   // xyz towards the sun, w: illuminance
  material: vec4f,   // base colour (linear), metalness
  material2: vec4f,  // roughness, dielectric F0, flags (1 sun, 2 environment), view
  misc: vec4f,  // exposure
  pad: vec4f,
}
@group(0) @binding(0) var<uniform> f: Frame;
@group(0) @binding(1) var envTex: texture_2d<f32>;
@group(0) @binding(2) var lutTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
${WGSL_SRGB}
${WGSL_FULLSCREEN}
const PI = ${PI};

// Narkowicz's fit of the ACES filmic curve (the post-processing lesson compares tone curves).
fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn env_uv(d: vec3f) -> vec2f {
  return vec2f(atan2(d.x, -d.z) / (2.0 * PI) + 0.5, acos(clamp(d.y, -1.0, 1.0)) / PI);
}
fn band(uv: vec2f, b: f32) -> vec3f {
  let v = clamp(uv.y, 0.5 / ${ENV_H}.0, 1.0 - 0.5 / ${ENV_H}.0);
  return textureSampleLevel(envTex, samp, vec2f(uv.x, (b + v) / ${ENV_BANDS}.0), 0.0).rgb;
}
fn prefiltered(r: vec3f, rough: f32) -> vec3f {
  let lv = rough * ${ENV_LEVELS - 1}.0;
  let b0 = floor(lv);
  let uv = env_uv(r);
  return mix(band(uv, b0), band(uv, min(b0 + 1.0, ${ENV_LEVELS - 1}.0)), lv - b0);
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) rm: vec2f,
}
@vertex fn vs(@builtin(instance_index) ii: u32, @location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f) -> VOut {
  var centre = vec3f(0.0);
  var size = 1.5;
  var rm = vec2f(f.material2.x, f.material.w);
  if (f.eye.w < 0.5) {
    // The grid: roughness 0 to 1 across, dielectrics above metals.
    let c = f32(ii % ${GRID_COLS}u);
    let row = f32(ii / ${GRID_COLS}u);
    centre = vec3f((c - 2.0) * 1.1, 0.6 - 1.2 * row, 0.0);
    size = 0.48;
    rm = vec2f(c / ${GRID_COLS - 1}.0, row);
  }
  var o: VOut;
  o.world = centre + p * size;
  o.pos = f.viewProj * vec4f(o.world, 1.0);
  o.normal = n;
  o.rm = rm;
  return o;
}

fn d_ggx(nh: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
fn g1(nx: f32, k: f32) -> f32 { return nx / (nx * (1.0 - k) + k); }
fn fresnel(f0: vec3f, vh: f32) -> vec3f { return f0 + (1.0 - f0) * pow(1.0 - vh, 5.0); }

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let n = normalize(v.normal);
  let vdir = normalize(f.eye.xyz - v.world);
  let rough = max(v.rm.x, 0.05);
  let metal = v.rm.y;
  let a = rough * rough;
  let base = f.material.rgb;
  let f0 = mix(vec3f(f.material2.y), base, metal);
  let albedo = base * (1.0 - metal);
  let nv = max(dot(n, vdir), 1e-4);
  let flags = u32(f.material2.z);
  var diff = vec3f(0.0);
  var spec = vec3f(0.0);
  if ((flags & 1u) != 0u) {
    let l = f.sun.xyz;
    let nl = dot(n, l);
    if (nl > 0.0) {
      let h = normalize(vdir + l);
      let k = (rough + 1.0) * (rough + 1.0) / 8.0;
      let s = d_ggx(max(dot(n, h), 0.0), a) * g1(nv, k) * g1(nl, k) / (4.0 * nl * nv);
      diff += albedo / PI * f.sun.w * nl;
      spec += fresnel(f0, max(dot(vdir, h), 0.0)) * s * f.sun.w * nl;
    }
  }
  if ((flags & 2u) != 0u) {
    // Split sum: prefiltered radiance along the reflection, times F0·A + B from the table.
    let ab = textureSampleLevel(lutTex, samp, vec2f(clamp(nv, 0.5 / ${LUT_SIZE}.0, 1.0 - 0.5 / ${LUT_SIZE}.0), rough), 0.0).rg;
    spec += prefiltered(reflect(-vdir, n), rough) * (f0 * ab.x + ab.y);
    diff += albedo * band(env_uv(n), ${ENV_LEVELS}.0);
  }
  let mode = i32(f.material2.w);
  var c = diff + spec;
  if (mode == 1) { c = diff; }
  if (mode == 2) { c = spec; }
  return vec4f(to_srgb(aces(c * f.misc.x)), 1.0);
}

@fragment fn fs_sky(v: FsOut) -> @location(0) vec4f {
  let ndc = vec2f(v.uv.x * 2.0 - 1.0, 1.0 - v.uv.y * 2.0);
  let w = f.invViewProj * vec4f(ndc, 1.0, 1.0);
  let d = normalize(w.xyz / w.w - f.eye.xyz);
  return vec4f(to_srgb(aces(band(env_uv(d), 0.0) * f.misc.x)), 1.0);
}
`;

class PbrWebGpu implements PbrRenderer {
  readonly backend = 'webgpu';
  readonly timer: WebGpuTimer;
  private dev: GPUDevice;
  private canvasCtx: GPUCanvasContext;
  private sphere = sphereMesh();
  private mesh!: { vb: GPUBuffer; ib: GPUBuffer; count: number };
  private ubo!: GPUBuffer;
  private envTex!: GPUTexture;
  private lutTex!: GPUTexture;
  private group!: GPUObject;
  private pipelines = new Map<string, GPUObject>();
  private depth: { w: number; h: number; tex: GPUTexture; view: GPUObject } | null = null;

  private constructor(
    private gc: WebGpuContext,
    private log: CallLog,
  ) {
    this.dev = record(gc.device, log, 'device');
    this.canvasCtx = record(gc.context, log, 'context');
    this.timer = new WebGpuTimer(gc, log, 1);
  }

  static async create(gc: WebGpuContext, log: CallLog, t: PbrTables): Promise<PbrWebGpu> {
    const r = new PbrWebGpu(gc, log);
    await r.init(t);
    return r;
  }

  private async init(t: PbrTables): Promise<void> {
    const dev = this.dev;
    this.log.phase = 'init';
    this.gc.device.pushErrorScope('validation');
    [this.mesh] = gpuMeshBuffers(dev, [this.sphere]);
    this.ubo = uniformBuffer(dev, 'frame constants', PBR_FRAME_BYTES);
    // The two tables, as half floats: the environment's bands and the split-sum BRDF table.
    this.envTex = dev.createTexture({ label: 'prefiltered environment', size: [ENV_W, ENV_H * ENV_BANDS], format: 'rgba16float', usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: this.envTex }, halves(t.env), { bytesPerRow: ENV_W * 8 }, [ENV_W, ENV_H * ENV_BANDS]);
    this.lutTex = dev.createTexture({ label: 'BRDF table', size: [LUT_SIZE, LUT_SIZE], format: 'rgba16float', usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: this.lutTex }, halves(t.lut), { bytesPerRow: LUT_SIZE * 8 }, [LUT_SIZE, LUT_SIZE]);
    const sampler = dev.createSampler({ label: 'linear, wrap around', magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' });
    const module = dev.createShaderModule({ label: 'PBR shaders', code: WGSL });
    const both = ShaderStage.VERTEX | ShaderStage.FRAGMENT;
    const layout = dev.createBindGroupLayout({
      label: 'frame',
      entries: [
        { binding: 0, visibility: both, buffer: { type: 'uniform' } },
        { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const pl = dev.createPipelineLayout({ label: 'frame', bindGroupLayouts: [layout] });
    const target = [{ format: this.gc.format }];
    const [sky, balls] = await Promise.all([
      dev.createRenderPipelineAsync({
        label: SKY_PIPE,
        layout: pl,
        vertex: { module, entryPoint: 'vs_full' },
        fragment: { module, entryPoint: 'fs_sky', targets: target },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
      }),
      dev.createRenderPipelineAsync({
        label: BALL_PIPE,
        layout: pl,
        vertex: { module, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] },
        fragment: { module, entryPoint: 'fs', targets: target },
        primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      }),
    ]);
    this.pipelines.set(SKY_PIPE, sky);
    this.pipelines.set(BALL_PIPE, balls);
    this.group = dev.createBindGroup({
      label: 'frame',
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.ubo } },
        { binding: 1, resource: this.envTex.createView() },
        { binding: 2, resource: this.lutTex.createView() },
        { binding: 3, resource: sampler },
      ],
    });
    const err = await this.gc.device.popErrorScope();
    if (err) console.error('WebGPU init:', err.message);
  }

  frame(s: PbrSettings, base: RGB): FramePlan {
    const w = this.gc.canvas.width;
    const h = this.gc.canvas.height;
    const plan = pbrPlan(s, w, h);
    const dev = this.dev;
    if (!this.depth || this.depth.w !== w || this.depth.h !== h) {
      this.log.phase = 'rebuild';
      this.depth?.tex.destroy();
      const tex = dev.createTexture({ label: 'depth', size: [w, h], format: 'depth24plus', usage: TextureUsage.RENDER_ATTACHMENT });
      this.depth = { w, h, tex, view: tex.createView() };
    }
    this.log.phase = 'frame';
    dev.queue.writeBuffer(this.ubo, 0, frameData(s, base));
    const enc = dev.createCommandEncoder({ label: 'frame' });
    const pass = enc.beginRenderPass({
      label: plan.passes[0].name,
      colorAttachments: [{ view: this.canvasCtx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: this.depth.view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      timestampWrites: this.timer.writes(0),
    });
    pass.setBindGroup(0, this.group);
    for (const d of plan.passes[0].draws) {
      pass.setPipeline(this.pipelines.get(d.pipeline)!);
      if (d.indexed) {
        pass.setVertexBuffer(0, this.mesh.vb);
        pass.setIndexBuffer(this.mesh.ib, 'uint16');
        pass.drawIndexed(d.count, d.instances, 0, 0, 0);
      } else pass.draw(d.count, d.instances, 0, 0);
    }
    pass.end();
    this.timer.resolve(enc);
    dev.queue.submit([enc.finish({ label: 'frame' })]);
    this.timer.submitted();
    return plan;
  }

  dispose(): void {
    this.mesh?.vb.destroy();
    this.mesh?.ib.destroy();
    this.ubo?.destroy();
    this.envTex?.destroy();
    this.lutTex?.destroy();
    this.depth?.tex.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// WebGL2

const GLSL_FRAME = `layout(std140) uniform Frame { mat4 viewProj; mat4 invViewProj; vec4 eye; vec4 sun; vec4 material; vec4 material2; vec4 misc; vec4 pad; };`;
const GLSL_COMMON = `
${GLSL_FRAME}
uniform sampler2D envTex;
uniform sampler2D lutTex;
${GLSL_SRGB}
const float PI = ${PI};
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec2 env_uv(vec3 d) { return vec2(atan(d.x, -d.z) / (2.0 * PI) + 0.5, acos(clamp(d.y, -1.0, 1.0)) / PI); }
// The first row uploaded is at t = 0 in GL and v = 0 in WebGPU, so the same coordinates work in both.
vec3 band(vec2 uv, float b) {
  float v = clamp(uv.y, 0.5 / ${ENV_H}.0, 1.0 - 0.5 / ${ENV_H}.0);
  return textureLod(envTex, vec2(uv.x, (b + v) / ${ENV_BANDS}.0), 0.0).rgb;
}
vec3 prefiltered(vec3 r, float rough) {
  float lv = rough * ${ENV_LEVELS - 1}.0;
  float b0 = floor(lv);
  vec2 uv = env_uv(r);
  return mix(band(uv, b0), band(uv, min(b0 + 1.0, ${ENV_LEVELS - 1}.0)), lv - b0);
}
`;

const GLSL_VS = `#version 300 es
${GLSL_FRAME}
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vRm;
void main() {
  vec3 centre = vec3(0.0);
  float size = 1.5;
  vec2 rm = vec2(material2.x, material.w);
  if (eye.w < 0.5) {
    float c = float(gl_InstanceID % ${GRID_COLS});
    float row = float(gl_InstanceID / ${GRID_COLS});
    centre = vec3((c - 2.0) * 1.1, 0.6 - 1.2 * row, 0.0);
    size = 0.48;
    rm = vec2(c / ${GRID_COLS - 1}.0, row);
  }
  vWorld = centre + position * size;
  vec4 p = viewProj * vec4(vWorld, 1.0);
  gl_Position = vec4(p.xy, 2.0 * p.z - p.w, p.w);
  vNormal = normal;
  vRm = rm;
}`;

const GLSL_FS = `#version 300 es
precision highp float;
${GLSL_COMMON}
in vec3 vWorld;
in vec3 vNormal;
in vec2 vRm;
out vec4 outColor;
float d_ggx(float nh, float a) { float a2 = a * a; float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float g1(float nx, float k) { return nx / (nx * (1.0 - k) + k); }
vec3 fresnel(vec3 f0, float vh) { return f0 + (1.0 - f0) * pow(1.0 - vh, 5.0); }
void main() {
  vec3 n = normalize(vNormal);
  vec3 view = normalize(eye.xyz - vWorld);
  float rough = max(vRm.x, 0.05);
  float metal = vRm.y;
  float a = rough * rough;
  vec3 base = material.rgb;
  vec3 f0 = mix(vec3(material2.y), base, metal);
  vec3 albedo = base * (1.0 - metal);
  float nv = max(dot(n, view), 1e-4);
  int flags = int(material2.z);
  vec3 diff = vec3(0.0);
  vec3 spec = vec3(0.0);
  if ((flags & 1) != 0) {
    vec3 l = sun.xyz;
    float nl = dot(n, l);
    if (nl > 0.0) {
      vec3 h = normalize(view + l);
      float k = (rough + 1.0) * (rough + 1.0) / 8.0;
      float s = d_ggx(max(dot(n, h), 0.0), a) * g1(nv, k) * g1(nl, k) / (4.0 * nl * nv);
      diff += albedo / PI * sun.w * nl;
      spec += fresnel(f0, max(dot(view, h), 0.0)) * s * sun.w * nl;
    }
  }
  if ((flags & 2) != 0) {
    vec2 ab = textureLod(lutTex, vec2(clamp(nv, 0.5 / ${LUT_SIZE}.0, 1.0 - 0.5 / ${LUT_SIZE}.0), rough), 0.0).rg;
    spec += prefiltered(reflect(-view, n), rough) * (f0 * ab.x + ab.y);
    diff += albedo * band(env_uv(n), ${ENV_LEVELS}.0);
  }
  int mode = int(material2.w);
  vec3 c = mode == 1 ? diff : mode == 2 ? spec : diff + spec;
  outColor = vec4(to_srgb(aces(c * misc.x)), 1.0);
}`;

const GLSL_SKY_FS = `#version 300 es
precision highp float;
${GLSL_COMMON}
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 ndc = vUv * 2.0 - 1.0; // vUv is bottom-up in GL
  vec4 w = invViewProj * vec4(ndc, 1.0, 1.0);
  vec3 d = normalize(w.xyz / w.w - eye.xyz);
  outColor = vec4(to_srgb(aces(band(env_uv(d), 0.0) * misc.x)), 1.0);
}`;

class PbrGl2 implements PbrRenderer {
  readonly backend = 'webgl2';
  readonly timer: Gl2Timer;
  private gl: WebGL2RenderingContext;
  private sphere = sphereMesh();
  private mesh: { vao: WebGLVertexArrayObject | null; count: number };
  private ubo: WebGLBuffer | null;
  private programs = new Map<string, WebGLProgram>();
  private target: { w: number; h: number; colour: WebGLTexture | null; depth: WebGLTexture | null; fbo: WebGLFramebuffer | null } | null = null;

  constructor(
    private gc: Gl2Context,
    private log: CallLog,
    t: PbrTables,
  ) {
    const gl = (this.gl = record(gc.gl, log, 'gl'));
    this.timer = new Gl2Timer(gc, log);
    log.phase = 'init';
    [this.mesh] = glMeshes(gl, [this.sphere]);
    this.ubo = named(gl.createBuffer(), 'frame constants');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, PBR_FRAME_BYTES, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo);
    // Half-float textures, filterable in WebGL2 without extensions; uploaded from 32-bit floats.
    gl.activeTexture(gl.TEXTURE0);
    const env = glTexture(gl, 'prefiltered environment', gl.RGBA16F, ENV_W, ENV_H * ENV_BANDS, 'linear');
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ENV_W, ENV_H * ENV_BANDS, gl.RGBA, gl.FLOAT, t.env);
    gl.activeTexture(gl.TEXTURE0 + 1);
    glTexture(gl, 'BRDF table', gl.RGBA16F, LUT_SIZE, LUT_SIZE, 'linear');
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_SIZE, LUT_SIZE, gl.RGBA, gl.FLOAT, t.lut);
    void env;
    const scene = link(gl, BALL_PIPE, compile(gl, gl.VERTEX_SHADER, GLSL_VS), compile(gl, gl.FRAGMENT_SHADER, GLSL_FS));
    const sky = link(gl, SKY_PIPE, compile(gl, gl.VERTEX_SHADER, GLSL_FULLSCREEN_VS), compile(gl, gl.FRAGMENT_SHADER, GLSL_SKY_FS));
    bindBlocks(gl, [scene, sky], { Frame: 0 });
    bindSamplers(gl, [scene, sky], { envTex: 0, lutTex: 1 });
    this.programs.set(BALL_PIPE, scene);
    this.programs.set(SKY_PIPE, sky);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.depthFunc(gl.LESS);
  }

  frame(s: PbrSettings, base: RGB): FramePlan {
    const gl = this.gl;
    const w = this.gc.canvas.width;
    const h = this.gc.canvas.height;
    const plan = pbrPlan(s, w, h);
    if (!this.target || this.target.w !== w || this.target.h !== h) {
      this.log.phase = 'rebuild';
      if (this.target) {
        gl.deleteTexture(this.target.colour);
        gl.deleteTexture(this.target.depth);
        gl.deleteFramebuffer(this.target.fbo);
      }
      gl.activeTexture(gl.TEXTURE0 + 2);
      const colour = glTexture(gl, 'colour', gl.RGBA8, w, h);
      const depth = glTexture(gl, 'depth', gl.DEPTH_COMPONENT24, w, h);
      this.target = { w, h, colour, depth, fbo: glFramebuffer(gl, 'scene', [colour], depth) };
    }
    this.log.phase = 'frame';
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, frameData(s, base));
    this.timer.begin(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.fbo);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    for (const d of plan.passes[0].draws) {
      gl.useProgram(this.programs.get(d.pipeline)!);
      if (d.indexed) {
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);
        gl.bindVertexArray(this.mesh.vao);
        gl.drawElementsInstanced(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, 0, d.instances);
      } else {
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.bindVertexArray(null);
        gl.drawArrays(gl.TRIANGLES, 0, d.count);
      }
    }
    this.timer.end(gl);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.target.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.timer.submitted(gl);
    return plan;
  }

  dispose(): void {}
}
