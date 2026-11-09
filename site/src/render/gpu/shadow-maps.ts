/**
 * "Shadow maps": the courtyard lit by the sun, with WebGPU and WebGL2, both walking the plan in
 * scenes/shadow-maps.ts.
 *
 *   shadow pass: depth only, from the light, into one 32-bit float depth texture: the whole map, or
 *                four cascades, each drawn into a quarter of it with its own viewport and matrix.
 *   camera pass: each pixel finds its map (its cascade, by view depth), projects into it, subtracts
 *                the bias from its own depth and compares: one tap, one bilinear comparison (2 × 2
 *                PCF in hardware), or a 3 × 3 or 5 × 5 grid of them.
 *
 * The bias is applied in the shader, where the comparison happens, so it's the same in both APIs
 * and in the CPU model. Rasteriser depth bias (D3D's DepthBias and SlopeScaledDepthBias, Vulkan's
 * depthBias*, WebGPU's depthBias and depthBiasSlopeScale, GL's polygonOffset) does the same job
 * when the map is drawn.
 */
import { type Gl2Context, type GpuContext, type WebGpuContext } from './context';
import { type FramePlan } from './plan';
import { type CallLog, record } from './record';
import { type GpuTimer, Gl2Timer, WebGpuTimer } from './timing';
import { type GPUBuffer, type GPUCanvasContext, type GPUDevice, type GPUObject, type GPUTexture, ShaderStage, TextureUsage } from './webgpu';
import { GLSL_FULLSCREEN_VS, GLSL_SRGB, VERTEX_LAYOUT, WGSL_FULLSCREEN, WGSL_SRGB, bindBlocks, bindSamplers, compile, glFramebuffer, glMeshes, glTexture, gpuMeshBuffers, link, named, uniformBuffer } from './lighting';
import {
  CASCADES,
  LIT_PASS,
  MAP_VIEW,
  MAX_TAN,
  SHADOW_PASS,
  type ShadowSettings,
  lightBasis,
  lightMatrix,
  shadowBoxes,
  shadowDraws,
  shadowPlan,
  shadowViewProj,
  splits,
} from '../scenes/shadow-maps';

export interface ShadowRenderer {
  readonly backend: 'webgpu' | 'webgl2';
  readonly timer: GpuTimer;
  frame(s: ShadowSettings): FramePlan;
  dispose(): void;
}
export async function createShadows(ctx: GpuContext, log: CallLog): Promise<ShadowRenderer> {
  return ctx.kind === 'webgpu' ? ShadowWebGpu.create(ctx, log) : new ShadowGl2(ctx, log);
}

/** Camera-pass constants: viewProj, four light matrices, splits, four map boxes, sun, two param blocks: 464 bytes. */
export const SHADOW_FRAME_BYTES = 464;
const CASTER_BYTES = 64;
const FILTER_INDEX = { none: 0, bilinear: 1, pcf3: 2, pcf5: 3 } as const;
const VIEW_INDEX = { lit: 0, cascades: 1, texels: 2, map: 3 } as const;
const SUN_INTENSITY = 2.2;

function frameData(s: ShadowSettings, aspect: number): Float32Array {
  const d = new Float32Array(SHADOW_FRAME_BYTES / 4);
  d.set(shadowViewProj(s.dolly), 0);
  const L = lightBasis(s.sun);
  const boxes = shadowBoxes(s);
  boxes.forEach((b, i) => d.set(lightMatrix(L, b), 16 + i * 16));
  const sp = splits(s.lambda);
  d.set(s.cascades ? sp.slice(1) : [1e9, 1e9, 1e9, 1e9], 80);
  boxes.forEach((b, i) => d.set([b.texel, b.range, b.ox, b.oy], 84 + i * 4));
  d.set([s.sun.x, s.sun.y, s.sun.z, SUN_INTENSITY], 100);
  d.set([s.bias, s.slope, FILTER_INDEX[s.filter], VIEW_INDEX[s.view]], 104);
  d.set([boxes.length, boxes[0].scale, s.res, MAX_TAN], 108);
  d.set([aspect, 0, 0, 0], 112);
  return d;
}

const CASCADE_TINTS = '(0.95, 0.35, 0.35), (0.35, 0.9, 0.4), (0.35, 0.55, 1.0), (0.95, 0.85, 0.3)';

/** The shadow lookup, written once for both languages with a few substitutions. */
function shadowCode(lang: 'wgsl' | 'glsl'): string {
  const w = lang === 'wgsl';
  const flipY = w ? '0.5 - lp.y * 0.5' : '0.5 + lp.y * 0.5';
  const tapN = (uv: string) => (w ? `textureSampleCompareLevel(shadowMap, cmpNearest, ${uv}, dref)` : `texture(shadowNearest, vec3(${uv}, dref))`);
  const tapL = (uv: string) => (w ? `textureSampleCompareLevel(shadowMap, cmpLinear, ${uv}, dref)` : `texture(shadowLinear, vec3(${uv}, dref))`);
  const v2 = w ? 'vec2f' : 'vec2';
  const v3 = w ? 'vec3f' : 'vec3';
  const v4 = w ? 'vec4f' : 'vec4';
  const f = w ? 'f.' : '';
  const decl = (t: string, n: string, e: string) => (w ? `let ${n} = ${e};` : `${t} ${n} = ${e};`);
  const vdecl = (t: string, n: string, e: string) => (w ? `var ${n} = ${e};` : `${t} ${n} = ${e};`);
  return `
${w ? 'fn shadow(p: vec3f, nl: f32, z: f32) -> vec4f' : 'vec4 shadow(vec3 p, float nl, float z)'} {
  // Which map: the first cascade whose far split is beyond this pixel.
  ${vdecl('int', 'c', '-1')}
  for (${w ? 'var i = 0' : 'int i = 0'}; i < ${CASCADES}; i++) {
    if (c < 0 && z < ${f}splits[i]) { c = i; }
  }
  if (c < 0 || c >= ${w ? 'i32' : 'int'}(${f}params2.x)) { return ${v4}(1.0, -1.0, 0.0, 0.0); }
  ${decl('vec4', 'lp', `${f}lightVP[c] * ${v4}(p, 1.0)`)}
  if (abs(lp.x) >= 1.0 || abs(lp.y) >= 1.0) { return ${v4}(1.0, ${w ? 'f32' : 'float'}(c), 0.0, 0.0); }
  ${decl('vec4', 'box', `${f}boxes[c]`)}
  // Bias: a constant, plus the slope term (texels × tan θ), in metres, then in the map's depth units.
  ${decl('float', 'tanT', `min(sqrt(max(1.0 - nl * nl, 0.0)) / max(nl, 1e-4), ${f}params2.w)`)}
  ${decl('float', 'dref', `lp.z - (${f}params.x + ${f}params.y * box.x * tanT) / box.y`)}
  ${decl('float', 'scale', `${f}params2.y`)}
  ${decl('float', 'texel', `1.0 / ${f}params2.z`)}
  ${decl('vec2', 'uv', `box.zw + ${v2}(lp.x * 0.5 + 0.5, ${flipY}) * scale`)}
  ${decl('vec2', 'lo', `box.zw + ${v2}(2.5 * texel)`)}
  ${decl('vec2', 'hi', `box.zw + ${v2}(scale - 2.5 * texel)`)}
  ${decl('int', 'mode', `${w ? 'i32' : 'int'}(${f}params.z)`)}
  ${vdecl('float', 'vis', '0.0')}
  if (mode == 0) {
    vis = ${tapN('uv')};
  } else if (mode == 1) {
    vis = ${tapL('uv')};
  } else {
    // A grid of bilinear comparisons, one texel apart: percentage-closer filtering.
    ${decl('int', 'r', 'mode - 1')}
    for (${w ? 'var j = -r' : 'int j = -r'}; j <= r; j++) {
      for (${w ? 'var i = -r' : 'int i = -r'}; i <= r; i++) {
        vis += ${tapL(`clamp(uv + ${v2}(${w ? 'f32' : 'float'}(i), ${w ? 'f32' : 'float'}(j)) * texel, lo, hi)`)};
      }
    }
    vis /= ${w ? 'f32' : 'float'}((2 * r + 1) * (2 * r + 1));
  }
  ${decl('vec2', 'cell', `floor(uv * ${f}params2.z)`)}
  return ${v4}(vis, ${w ? 'f32' : 'float'}(c), cell.x + cell.y, 0.0);
}

${w ? 'fn tint(c: f32) -> vec3f' : 'vec3 tint(float c)'} {
  ${decl('vec3', 't0', `${v3}${CASCADE_TINTS.split('), (')[0]})`)}
  if (c < 0.5) { return t0; }
  if (c < 1.5) { return ${v3}(${CASCADE_TINTS.split('), (')[1]}); }
  if (c < 2.5) { return ${v3}(${CASCADE_TINTS.split('), (')[2]}); }
  return ${v3}(${CASCADE_TINTS.split('), (')[3]};
}

${w ? 'fn lit(p: vec3f, n: vec3f, albedo: vec3f, z: f32) -> vec4f' : 'vec4 lit(vec3 p, vec3 n, vec3 albedo, float z)'} {
  ${decl('float', 'nl', `dot(n, ${f}sun.xyz)`)}
  ${vdecl('vec4', 'sh', `${v4}(0.0, -1.0, 0.0, 0.0)`)}
  if (nl > 0.0) { sh = shadow(p, nl, z); }
  ${decl('int', 'vmode', `${w ? 'i32' : 'int'}(${f}params.w)`)}
  ${vdecl('vec3', 'a', 'albedo')}
  if (vmode == 1 && sh.y >= 0.0) { a = mix(albedo, tint(sh.y), 0.55); }
  if (vmode == 2 && sh.y >= 0.0) { a = albedo * select${w ? '' : '_'}(0.55, 1.0, (${w ? 'i32' : 'int'}(sh.z) & 1) == 0); }
  ${decl('vec3', 'c', `a * (0.12 + ${f}sun.w * max(nl, 0.0) * sh.x)`)}
  return ${v4}(to_srgb(c / (1.0 + c)), 1.0);
}
`;
}

// ---------------------------------------------------------------------------------------------
// WebGPU

const WGSL_FRAME = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  lightVP: array<mat4x4f, ${CASCADES}>,
  splits: vec4f,               // far split of each cascade
  boxes: array<vec4f, ${CASCADES}>, // texel size (m), depth range (m), atlas offset x, y
  sun: vec4f,                  // towards the sun, w: intensity
  params: vec4f,               // constant bias (m), slope bias (texels), filter, view
  params2: vec4f,              // maps, map scale in the atlas, atlas texels, max tan
  misc: vec4f,                 // canvas aspect
}
@group(0) @binding(0) var<uniform> f: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var cmpNearest: sampler_comparison;
@group(0) @binding(3) var cmpLinear: sampler_comparison;
`;

const WGSL_MAIN = /* wgsl */ `
${WGSL_FRAME}
${WGSL_SRGB}
${WGSL_FULLSCREEN}
struct Draw { albedo: vec4f }
@group(1) @binding(0) var<uniform> draw: Draw;
${shadowCode('wgsl')}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) z: f32,
}
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f) -> VOut {
  var o: VOut;
  o.pos = f.viewProj * vec4f(p, 1.0);
  o.world = p;
  o.normal = n;
  o.uv = uv;
  o.z = o.pos.w;
  return o;
}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let odd = (i32(floor(v.uv.x)) + i32(floor(v.uv.y))) & 1;
  let albedo = draw.albedo.rgb * select(1.0, 0.55, draw.albedo.w > 0.5 && odd == 1);
  return lit(v.world, normalize(v.normal), albedo, v.z);
}
// The shadow map itself: nearer the light is lighter.
@fragment fn fs_map(v: FsOut) -> @location(0) vec4f {
  // Square, in the middle of the canvas.
  let uv = vec2f((v.uv.x - 0.5) * f.misc.x + 0.5, v.uv.y);
  if (uv.x < 0.0 || uv.x >= 1.0) { return vec4f(0.02, 0.025, 0.04, 1.0); }
  let d = textureLoad(shadowMap, vec2i(uv * f.params2.z), 0);
  return vec4f(vec3f(select(1.0 - d, 0.0, d >= 1.0)), 1.0);
}
`;

const WGSL_CASTER = /* wgsl */ `
@group(0) @binding(0) var<uniform> lightVP: mat4x4f;
@vertex fn vs(@location(0) p: vec3f) -> @builtin(position) vec4f {
  return lightVP * vec4f(p, 1.0);
}
`;

class ShadowWebGpu implements ShadowRenderer {
  readonly backend = 'webgpu';
  readonly timer: WebGpuTimer;
  private dev: GPUDevice;
  private canvasCtx: GPUCanvasContext;
  private draws = shadowDraws();
  private meshes: Array<{ vb: GPUBuffer; ib: GPUBuffer; count: number }> = [];
  private ubo!: GPUBuffer;
  private casterUbo!: GPUBuffer;
  private drawUbo!: GPUBuffer;
  private align: number;
  private frameLayout!: GPUObject;
  private casterGroups: GPUObject[] = [];
  private drawGroups: GPUObject[] = [];
  private samplers: GPUObject[] = [];
  private pipelines = new Map<string, GPUObject>();
  private map: { res: number; tex: GPUTexture; view: GPUObject; group: GPUObject } | null = null;
  private depth: { w: number; h: number; tex: GPUTexture; view: GPUObject } | null = null;

  private constructor(
    private gc: WebGpuContext,
    private log: CallLog,
  ) {
    this.dev = record(gc.device, log, 'device');
    this.canvasCtx = record(gc.context, log, 'context');
    this.align = Math.max(256, gc.device.limits.minUniformBufferOffsetAlignment ?? 256);
    this.timer = new WebGpuTimer(gc, log, 2);
  }

  static async create(gc: WebGpuContext, log: CallLog): Promise<ShadowWebGpu> {
    const r = new ShadowWebGpu(gc, log);
    await r.init();
    return r;
  }

  private async init(): Promise<void> {
    const dev = this.dev;
    this.log.phase = 'init';
    this.gc.device.pushErrorScope('validation');
    this.meshes = gpuMeshBuffers(dev, this.draws.map((d) => d.mesh));
    this.ubo = uniformBuffer(dev, 'frame constants', SHADOW_FRAME_BYTES);
    this.casterUbo = uniformBuffer(dev, 'light matrices', (CASCADES - 1) * this.align + CASTER_BYTES);
    this.drawUbo = uniformBuffer(dev, 'draw constants', (this.draws.length - 1) * this.align + 16);
    const albedo = new Float32Array(((this.draws.length - 1) * this.align + 16) / 4);
    this.draws.forEach((d, i) => albedo.set([...d.albedo, d.checker ? 1 : 0], (i * this.align) / 4));
    dev.queue.writeBuffer(this.drawUbo, 0, albedo);
    // Comparison samplers: the hardware compares a reference depth with the stored one; 'linear' blends four comparisons.
    this.samplers = [
      dev.createSampler({ label: 'compare, nearest', compare: 'less-equal', magFilter: 'nearest', minFilter: 'nearest' }),
      dev.createSampler({ label: 'compare, bilinear', compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' }),
    ];
    const main = dev.createShaderModule({ label: 'camera shaders', code: WGSL_MAIN });
    const caster = dev.createShaderModule({ label: 'shadow caster', code: WGSL_CASTER });
    this.frameLayout = dev.createBindGroupLayout({
      label: 'frame',
      entries: [
        { binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 3, visibility: ShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      ],
    });
    const drawLayout = dev.createBindGroupLayout({ label: 'per draw', entries: [{ binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    const casterLayout = dev.createBindGroupLayout({ label: 'light matrix', entries: [{ binding: 0, visibility: ShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
    const mainLayout = dev.createPipelineLayout({ label: 'camera', bindGroupLayouts: [this.frameLayout, drawLayout] });
    const mapLayout = dev.createPipelineLayout({ label: 'show map', bindGroupLayouts: [this.frameLayout] });
    const casterPl = dev.createPipelineLayout({ label: 'shadow caster', bindGroupLayouts: [casterLayout] });
    const [shadow, litPipe, mapPipe] = await Promise.all([
      // Depth only: no fragment shader, no colour target.
      dev.createRenderPipelineAsync({
        label: SHADOW_PASS,
        layout: casterPl,
        vertex: { module: caster, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
      }),
      dev.createRenderPipelineAsync({
        label: LIT_PASS,
        layout: mainLayout,
        vertex: { module: main, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] },
        fragment: { module: main, entryPoint: 'fs', targets: [{ format: this.gc.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      }),
      dev.createRenderPipelineAsync({
        label: MAP_VIEW,
        layout: mapLayout,
        vertex: { module: main, entryPoint: 'vs_full' },
        fragment: { module: main, entryPoint: 'fs_map', targets: [{ format: this.gc.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
      }),
    ]);
    this.pipelines.set(SHADOW_PASS, shadow);
    this.pipelines.set(LIT_PASS, litPipe);
    this.pipelines.set(MAP_VIEW, mapPipe);
    this.casterGroups = Array.from({ length: CASCADES }, (_, i) =>
      dev.createBindGroup({ label: `cascade ${i + 1}`, layout: casterLayout, entries: [{ binding: 0, resource: { buffer: this.casterUbo, offset: i * this.align, size: CASTER_BYTES } }] }),
    );
    this.drawGroups = this.draws.map((d, i) => dev.createBindGroup({ label: d.name, layout: drawLayout, entries: [{ binding: 0, resource: { buffer: this.drawUbo, offset: i * this.align, size: 16 } }] }));
    const err = await this.gc.device.popErrorScope();
    if (err) console.error('WebGPU init:', err.message);
  }

  private shadowMap(res: number) {
    if (this.map && this.map.res === res) return this.map;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    this.map?.tex.destroy();
    const tex = this.dev.createTexture({ label: 'shadow map', size: [res, res], format: 'depth32float', usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    const view = tex.createView();
    const group = this.dev.createBindGroup({
      label: 'frame',
      layout: this.frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.ubo } },
        { binding: 1, resource: view },
        { binding: 2, resource: this.samplers[0] },
        { binding: 3, resource: this.samplers[1] },
      ],
    });
    this.map = { res, tex, view, group };
    this.log.phase = prev;
    return this.map;
  }

  frame(s: ShadowSettings): FramePlan {
    const w = this.gc.canvas.width;
    const h = this.gc.canvas.height;
    const plan = shadowPlan(s, w, h);
    const dev = this.dev;
    const map = this.shadowMap(s.res);
    if (!this.depth || this.depth.w !== w || this.depth.h !== h) {
      this.log.phase = 'rebuild';
      this.depth?.tex.destroy();
      const tex = dev.createTexture({ label: 'depth', size: [w, h], format: 'depth24plus', usage: TextureUsage.RENDER_ATTACHMENT });
      this.depth = { w, h, tex, view: tex.createView() };
    }
    this.log.phase = 'frame';
    const boxes = shadowBoxes(s);
    const L = lightBasis(s.sun);
    const mats = new Float32Array(((CASCADES - 1) * this.align + CASTER_BYTES) / 4);
    boxes.forEach((b, i) => mats.set(lightMatrix(L, b), (i * this.align) / 4));
    dev.queue.writeBuffer(this.casterUbo, 0, mats);
    dev.queue.writeBuffer(this.ubo, 0, frameData(s, w / h));

    const enc = dev.createCommandEncoder({ label: 'frame' });
    const [shadowPass, camPass] = plan.passes;
    const p1 = enc.beginRenderPass({
      label: shadowPass.name,
      colorAttachments: [],
      depthStencilAttachment: { view: map.view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      timestampWrites: this.timer.writes(0),
    });
    p1.setPipeline(this.pipelines.get(SHADOW_PASS)!);
    const per = this.draws.length;
    boxes.forEach((b, c) => {
      // Each map draws into its own square of the texture.
      p1.setViewport(b.ox * s.res, b.oy * s.res, b.scale * s.res, b.scale * s.res, 0, 1);
      p1.setBindGroup(0, this.casterGroups[c]);
      for (let i = 0; i < per; i++) {
        const d = shadowPass.draws[c * per + i];
        p1.setVertexBuffer(0, this.meshes[i].vb);
        p1.setIndexBuffer(this.meshes[i].ib, 'uint16');
        p1.drawIndexed(d.count, d.instances, 0, 0, 0);
      }
    });
    p1.end();
    const p2 = enc.beginRenderPass({
      label: camPass.name,
      colorAttachments: [{ view: this.canvasCtx.getCurrentTexture().createView(), clearValue: { r: 0.02, g: 0.025, b: 0.04, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: this.depth.view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      timestampWrites: this.timer.writes(1),
    });
    p2.setBindGroup(0, map.group);
    if (s.view === 'map') {
      p2.setPipeline(this.pipelines.get(MAP_VIEW)!);
      p2.draw(3, 1, 0, 0);
    } else {
      p2.setPipeline(this.pipelines.get(LIT_PASS)!);
      camPass.draws.forEach((d, i) => {
        p2.setBindGroup(1, this.drawGroups[i]);
        p2.setVertexBuffer(0, this.meshes[i].vb);
        p2.setIndexBuffer(this.meshes[i].ib, 'uint16');
        p2.drawIndexed(d.count, d.instances, 0, 0, 0);
      });
    }
    p2.end();
    this.timer.resolve(enc);
    dev.queue.submit([enc.finish({ label: 'frame' })]);
    this.timer.submitted();
    return plan;
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.vb.destroy();
      m.ib.destroy();
    }
    for (const b of [this.ubo, this.casterUbo, this.drawUbo]) b?.destroy();
    this.map?.tex.destroy();
    this.depth?.tex.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// WebGL2

const GLSL_FRAME = `layout(std140) uniform Frame { mat4 viewProj; mat4 lightVP[${CASCADES}]; vec4 splits; vec4 boxes[${CASCADES}]; vec4 sun; vec4 params; vec4 params2; vec4 misc; };`;

const GLSL_MAIN_VS = `#version 300 es
${GLSL_FRAME}
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
out float vZ;
void main() {
  vec4 c = viewProj * vec4(position, 1.0);
  gl_Position = vec4(c.xy, 2.0 * c.z - c.w, c.w);
  vWorld = position;
  vNormal = normal;
  vUv = uv;
  vZ = c.w;
}`;

const GLSL_MAIN_FS = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
${GLSL_FRAME}
layout(std140) uniform Draw { vec4 albedo; };
uniform sampler2DShadow shadowNearest;
uniform sampler2DShadow shadowLinear;
${GLSL_SRGB}
float select_(float a, float b, bool c) { return c ? b : a; }
${shadowCode('glsl')}
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
in float vZ;
out vec4 outColor;
void main() {
  int odd = (int(floor(vUv.x)) + int(floor(vUv.y))) & 1;
  vec3 a = albedo.rgb * ((albedo.w > 0.5 && odd == 1) ? 0.55 : 1.0);
  outColor = lit(vWorld, normalize(vNormal), a, vZ);
}`;

const GLSL_MAP_FS = `#version 300 es
precision highp float;
${GLSL_FRAME}
uniform highp sampler2D shadowRaw;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 uv = vec2((vUv.x - 0.5) * misc.x + 0.5, vUv.y);
  if (uv.x < 0.0 || uv.x >= 1.0) { outColor = vec4(0.02, 0.025, 0.04, 1.0); return; }
  float d = texelFetch(shadowRaw, ivec2(uv * params2.z), 0).r;
  outColor = vec4(vec3(d >= 1.0 ? 0.0 : 1.0 - d), 1.0);
}`;

const GLSL_CASTER_VS = `#version 300 es
layout(std140) uniform Caster { mat4 lightVP; };
layout(location = 0) in vec3 position;
void main() {
  vec4 c = lightVP * vec4(position, 1.0);
  gl_Position = vec4(c.xy, 2.0 * c.z - c.w, c.w);
}`;
const GLSL_CASTER_FS = `#version 300 es
precision mediump float;
void main() {}`;

class ShadowGl2 implements ShadowRenderer {
  readonly backend = 'webgl2';
  readonly timer: Gl2Timer;
  private gl: WebGL2RenderingContext;
  private draws = shadowDraws();
  private meshes: Array<{ vao: WebGLVertexArrayObject | null; count: number }>;
  private ubo: WebGLBuffer | null;
  private casterUbo: WebGLBuffer | null;
  private drawUbo: WebGLBuffer | null;
  private align: number;
  private programs = new Map<string, WebGLProgram>();
  private map: { res: number; tex: WebGLTexture | null; fbo: WebGLFramebuffer | null } | null = null;
  private target: { w: number; h: number; colour: WebGLTexture | null; depth: WebGLTexture | null; fbo: WebGLFramebuffer | null } | null = null;

  constructor(
    private gc: Gl2Context,
    private log: CallLog,
  ) {
    const gl = (this.gl = record(gc.gl, log, 'gl'));
    this.timer = new Gl2Timer(gc, log);
    log.phase = 'init';
    this.meshes = glMeshes(gl, this.draws.map((d) => d.mesh));
    this.align = Math.max(16, Number(gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT)) || 256);
    const ubo = (label: string, size: number) => {
      const b = named(gl.createBuffer(), label);
      gl.bindBuffer(gl.UNIFORM_BUFFER, b);
      gl.bufferData(gl.UNIFORM_BUFFER, size, gl.DYNAMIC_DRAW);
      return b;
    };
    this.ubo = ubo('frame constants', SHADOW_FRAME_BYTES);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo);
    this.casterUbo = ubo('light matrices', (CASCADES - 1) * this.align + CASTER_BYTES);
    this.drawUbo = ubo('draw constants', (this.draws.length - 1) * this.align + 16);
    const albedo = new Float32Array(((this.draws.length - 1) * this.align + 16) / 4);
    this.draws.forEach((d, i) => albedo.set([...d.albedo, d.checker ? 1 : 0], (i * this.align) / 4));
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, albedo);
    const main = link(gl, LIT_PASS, compile(gl, gl.VERTEX_SHADER, GLSL_MAIN_VS), compile(gl, gl.FRAGMENT_SHADER, GLSL_MAIN_FS));
    const map = link(gl, MAP_VIEW, compile(gl, gl.VERTEX_SHADER, GLSL_FULLSCREEN_VS), compile(gl, gl.FRAGMENT_SHADER, GLSL_MAP_FS));
    const caster = link(gl, SHADOW_PASS, compile(gl, gl.VERTEX_SHADER, GLSL_CASTER_VS), compile(gl, gl.FRAGMENT_SHADER, GLSL_CASTER_FS));
    bindBlocks(gl, [main, map, caster], { Frame: 0, Draw: 1, Caster: 2 });
    bindSamplers(gl, [main, map], { shadowNearest: 0, shadowLinear: 1, shadowRaw: 2 });
    this.programs.set(LIT_PASS, main);
    this.programs.set(MAP_VIEW, map);
    this.programs.set(SHADOW_PASS, caster);
    // Sampler objects: the same depth texture is read three ways, so each texture unit gets its own sampler.
    const sampler = (label: string, filter: number, compare: boolean, unit: number) => {
      const smp = named(gl.createSampler(), label);
      gl.samplerParameteri(smp!, gl.TEXTURE_MIN_FILTER, filter);
      gl.samplerParameteri(smp!, gl.TEXTURE_MAG_FILTER, filter);
      gl.samplerParameteri(smp!, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(smp!, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (compare) {
        gl.samplerParameteri(smp!, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.samplerParameteri(smp!, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      }
      gl.bindSampler(unit, smp);
    };
    sampler('compare, nearest', gl.NEAREST, true, 0);
    sampler('compare, bilinear', gl.LINEAR, true, 1);
    sampler('raw depth', gl.NEAREST, false, 2);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.depthFunc(gl.LESS);
  }

  frame(s: ShadowSettings): FramePlan {
    const gl = this.gl;
    const w = this.gc.canvas.width;
    const h = this.gc.canvas.height;
    const plan = shadowPlan(s, w, h);
    if (!this.map || this.map.res !== s.res) {
      this.log.phase = 'rebuild';
      if (this.map) {
        gl.deleteTexture(this.map.tex);
        gl.deleteFramebuffer(this.map.fbo);
      }
      gl.activeTexture(gl.TEXTURE0 + 3);
      const tex = glTexture(gl, 'shadow map', gl.DEPTH_COMPONENT32F, s.res, s.res);
      this.map = { res: s.res, tex, fbo: glFramebuffer(gl, 'shadow map', [], tex) };
      for (let u = 0; u < 3; u++) {
        gl.activeTexture(gl.TEXTURE0 + u);
        gl.bindTexture(gl.TEXTURE_2D, tex);
      }
    }
    if (!this.target || this.target.w !== w || this.target.h !== h) {
      this.log.phase = 'rebuild';
      if (this.target) {
        gl.deleteTexture(this.target.colour);
        gl.deleteTexture(this.target.depth);
        gl.deleteFramebuffer(this.target.fbo);
      }
      gl.activeTexture(gl.TEXTURE0 + 3);
      const colour = glTexture(gl, 'colour', gl.RGBA8, w, h);
      const depth = glTexture(gl, 'depth', gl.DEPTH_COMPONENT24, w, h);
      this.target = { w, h, colour, depth, fbo: glFramebuffer(gl, 'camera', [colour], depth) };
    }
    this.log.phase = 'frame';
    const boxes = shadowBoxes(s);
    const L = lightBasis(s.sun);
    const mats = new Float32Array(((CASCADES - 1) * this.align + CASTER_BYTES) / 4);
    boxes.forEach((b, i) => mats.set(lightMatrix(L, b), (i * this.align) / 4));
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.casterUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, mats);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, frameData(s, w / h));

    const [shadowPass, camPass] = plan.passes;
    this.timer.begin(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.map.fbo);
    gl.viewport(0, 0, s.res, s.res);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.programs.get(SHADOW_PASS)!);
    const per = this.draws.length;
    boxes.forEach((b, c) => {
      gl.viewport(b.ox * s.res, b.oy * s.res, b.scale * s.res, b.scale * s.res);
      gl.bindBufferRange(gl.UNIFORM_BUFFER, 2, this.casterUbo, c * this.align, CASTER_BYTES);
      for (let i = 0; i < per; i++) {
        gl.bindVertexArray(this.meshes[i].vao);
        gl.drawElements(gl.TRIANGLES, shadowPass.draws[c * per + i].count, gl.UNSIGNED_SHORT, 0);
      }
    });
    this.timer.end(gl);

    this.timer.begin(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.02, 0.025, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (s.view === 'map') {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.programs.get(MAP_VIEW)!);
      gl.bindVertexArray(null);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.enable(gl.CULL_FACE);
      gl.useProgram(this.programs.get(LIT_PASS)!);
      camPass.draws.forEach((d, i) => {
        gl.bindBufferRange(gl.UNIFORM_BUFFER, 1, this.drawUbo, i * this.align, 16);
        gl.bindVertexArray(this.meshes[i].vao);
        gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, 0);
      });
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
