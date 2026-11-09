/**
 * "Forward, deferred and clustered": the courtyard with up to 256 point lights, drawn with WebGPU
 * and with WebGL2, both walking the plan in scenes/forward-deferred-clustered.ts.
 *
 *   forward:  one pass; each pixel's fragment shader loops over its cell's lights.
 *   deferred: a G-buffer pass (albedo, normal, depth), then a lighting pass, a full-screen
 *             triangle that rebuilds each pixel's position from depth and loops over the same lists.
 *
 * Light culling is the same code in both: the CPU builds a grid of cells (one cell, screen tiles,
 * or clusters) with an offset and count into a list of light indices, and uploads both as integer
 * textures; the shader finds its pixel's cell and loops over that cell's lights only. With "no
 * culling" the grid is a single cell holding every light.
 */
import { type Gl2Context, type GpuContext, type WebGpuContext } from './context';
import { type FramePlan } from './plan';
import { type CallLog, record } from './record';
import { type PointLight } from './scene';
import { Gl2Timer, type GpuTimer, WebGpuTimer } from './timing';
import { type GPUBuffer, type GPUCanvasContext, type GPUDevice, type GPUObject, type GPUTexture, ShaderStage, TextureUsage } from './webgpu';
import { GLSL_FULLSCREEN_VS, GLSL_SRGB, VERTEX_LAYOUT, WGSL_FULLSCREEN, WGSL_SRGB, bindBlocks, bindSamplers, compile, glFramebuffer, glMeshes, glTexture, gpuMeshBuffers, link, named, uniformBuffer } from './lighting';
import { type RGB, courtyardViewProj, invert4 } from '../scenes/courtyard';
import {
  type FdcSettings,
  FORWARD,
  GBUFFER_PASS,
  HEAT_STOPS,
  INDEX_H,
  INDEX_W,
  LIGHTING,
  type LightLists,
  SLICES,
  SLICE_SCALE,
  TILES_X,
  TILES_Y,
  ZC0,
  fdcDraws,
  fdcPlan,
} from '../scenes/forward-deferred-clustered';

export interface FdcInput {
  lights: PointLight[];
  /** Linear colour per light (resolved from its theme token). */
  colours: RGB[];
  lists: LightLists;
  /** Upload the lights and lists (they changed since the last frame). */
  changed: boolean;
}

export interface FdcRenderer {
  readonly backend: 'webgpu' | 'webgl2';
  readonly timer: GpuTimer;
  frame(s: FdcSettings, input: FdcInput): FramePlan;
  dispose(): void;
}

export async function createFdc(ctx: GpuContext, log: CallLog): Promise<FdcRenderer> {
  return ctx.kind === 'webgpu' ? FdcWebGpu.create(ctx, log) : new FdcGl2(ctx, log);
}

/** Frame constants: viewProj, its inverse, eye + light count, grid, params, ambient: 192 bytes, same layout in WGSL and std140. */
export const FDC_FRAME_BYTES = 192;
export const FDC_LIGHT_BYTES = 32;
export const MAX_GPU_LIGHTS = 256;
const DRAW_BYTES = 16;
const VIEW_INDEX = { lit: 0, heat: 1, albedo: 2, normal: 3, depth: 4 } as const;
/** The sky, linear. */
export const SKY: RGB = [0.012, 0.014, 0.026];
const AMBIENT: RGB = [0.02, 0.022, 0.03];
/** Exposure before the simple c / (1 + c) curve the lesson uses (the post-processing lesson has better ones). */
const EXPOSURE = 1.6;

function frameData(s: FdcSettings, lists: LightLists, w: number, h: number): Float32Array {
  const d = new Float32Array(FDC_FRAME_BYTES / 4);
  const vp = courtyardViewProj();
  d.set(vp, 0);
  d.set(invert4(vp), 16);
  d.set([0, 0, 0, s.lights], 32);
  const g = lists.grid;
  d.set([g.tx, g.ty, g.slices, SLICE_SCALE], 36);
  d.set([ZC0, VIEW_INDEX[s.view], w, h], 40);
  d.set([AMBIENT[0], AMBIENT[1], AMBIENT[2], EXPOSURE], 44);
  return d;
}
function lightData(lights: PointLight[], colours: RGB[]): Float32Array {
  const d = new Float32Array((MAX_GPU_LIGHTS * FDC_LIGHT_BYTES) / 4);
  lights.forEach((l, i) => d.set([l.pos.x, l.pos.y, l.pos.z, l.radius, colours[i][0], colours[i][1], colours[i][2], l.intensity * 3], i * 8));
  return d;
}
/** The grid as (offset, count) pairs, tx·ty wide and `slices` tall. */
function cellData(lists: LightLists): Uint32Array {
  const d = new Uint32Array(lists.count.length * 2);
  for (let i = 0; i < lists.count.length; i++) {
    d[i * 2] = lists.offset[i];
    d[i * 2 + 1] = lists.count[i];
  }
  return d;
}
/** The index list, padded to whole rows of the index texture. */
function indexData(lists: LightLists): { data: Uint32Array; rows: number } {
  const rows = Math.max(1, Math.ceil(lists.indices.length / INDEX_W));
  const data = new Uint32Array(rows * INDEX_W);
  data.set(lists.indices);
  return { data, rows };
}
const srgb = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const skyClear = () => ({ r: srgb(SKY[0]), g: srgb(SKY[1]), b: srgb(SKY[2]), a: 1 });

/** The heat ramp (scenes HEAT_STOPS), interpolated in log2(n + 1). */
function heatCode(lang: 'wgsl' | 'glsl'): string {
  const v = (c: number[]) => (lang === 'wgsl' ? `vec3f(${c.map((x) => x.toFixed(3)).join(', ')})` : `vec3(${c.map((x) => x.toFixed(3)).join(', ')})`);
  const lines = HEAT_STOPS.slice(1).map(([n, c], i) => {
    const a = Math.log2(HEAT_STOPS[i][0] + 1);
    const b = Math.log2(n + 1);
    return `  c = mix(c, ${v(c)}, clamp((x - ${a.toFixed(4)}) / ${(b - a).toFixed(4)}, 0.0, 1.0));`;
  });
  return lang === 'wgsl'
    ? `fn heat(n: f32) -> vec3f {\n  let x = log2(n + 1.0);\n  var c = ${v(HEAT_STOPS[0][1])};\n${lines.join('\n')}\n  return c;\n}`
    : `vec3 heat(float n) {\n  float x = log2(n + 1.0);\n  vec3 c = ${v(HEAT_STOPS[0][1])};\n${lines.join('\n')}\n  return c;\n}`;
}

// ---------------------------------------------------------------------------------------------
// WebGPU

const WGSL_COMMON = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  eye: vec4f,     // w: light count
  grid: vec4f,    // tiles x, tiles y, slices, slice scale
  params: vec4f,  // first slice depth, view mode, target width, height
  ambient: vec4f, // w: exposure
}
struct Light {
  pos: vec4f,   // w: radius
  color: vec4f, // w: intensity
}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> lights: array<Light, ${MAX_GPU_LIGHTS}>;
@group(0) @binding(2) var cells: texture_2d<u32>;   // (offset, count) per cell
@group(0) @binding(3) var indices: texture_2d<u32>; // light indices, ${INDEX_W} per row
${WGSL_SRGB}
${heatCode('wgsl')}

// Which cell a pixel is in: its screen tile, and (for clusters) its depth slice.
fn cell_of(xy: vec2f, z: f32) -> vec2i {
  let i = min(i32(xy.x / frame.params.z * frame.grid.x), i32(frame.grid.x) - 1);
  let j = min(i32(xy.y / frame.params.w * frame.grid.y), i32(frame.grid.y) - 1);
  var k = 0;
  if (frame.grid.z > 1.0) {
    k = clamp(i32(floor(log2(z / frame.params.x) * frame.grid.w)), 0, i32(frame.grid.z) - 1);
  }
  return vec2i(i + j * i32(frame.grid.x), k);
}

// Diffuse light from every light in the pixel's cell. Returns the colour and how many lights it looked at.
fn shade(p: vec3f, n: vec3f, albedo: vec3f, xy: vec2f, z: f32) -> vec4f {
  let cell = textureLoad(cells, cell_of(xy, z), 0).xy;
  var c = frame.ambient.rgb * albedo;
  for (var i = 0u; i < cell.y; i++) {
    let idx = cell.x + i;
    let L = lights[textureLoad(indices, vec2i(i32(idx % ${INDEX_W}u), i32(idx / ${INDEX_W}u)), 0).x];
    let d = L.pos.xyz - p;
    let dist = length(d);
    let x = dist / L.pos.w;
    let win = clamp(1.0 - x * x * x * x, 0.0, 1.0);
    c += albedo * L.color.rgb * (L.color.w * win * win / (dist * dist + 1.0) * max(dot(n, d / dist), 0.0));
  }
  return vec4f(c, f32(cell.y));
}

fn show(lit: vec4f, albedo: vec3f, n: vec3f, z: f32) -> vec4f {
  let mode = i32(frame.params.y);
  if (mode == 1) { return vec4f(heat(lit.w), 1.0); }
  if (mode == 2) { return vec4f(to_srgb(albedo), 1.0); }
  if (mode == 3) { return vec4f(n * 0.5 + 0.5, 1.0); }
  if (mode == 4) { return vec4f(vec3f(clamp(1.0 - z / 45.0, 0.0, 1.0)), 1.0); }
  let c = lit.rgb * frame.ambient.w;
  return vec4f(to_srgb(c / (1.0 + c)), 1.0);
}
`;

const WGSL_SCENE = /* wgsl */ `
${WGSL_COMMON}
struct Draw {
  albedo: vec4f, // w: 1 for the checkerboard floor
}
@group(1) @binding(0) var<uniform> draw: Draw;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) z: f32,
}
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f) -> VOut {
  var o: VOut;
  o.pos = frame.viewProj * vec4f(p, 1.0);
  o.world = p;
  o.normal = n;
  o.uv = uv;
  o.z = o.pos.w;
  return o;
}
fn albedo_of(v: VOut) -> vec3f {
  let odd = (i32(floor(v.uv.x)) + i32(floor(v.uv.y))) & 1;
  return draw.albedo.rgb * select(1.0, 0.55, draw.albedo.w > 0.5 && odd == 1);
}

@fragment fn fs_forward(v: VOut) -> @location(0) vec4f {
  let a = albedo_of(v);
  let n = normalize(v.normal);
  return show(shade(v.world, n, a, v.pos.xy, v.z), a, n, v.z);
}

struct GOut {
  @location(0) albedo: vec4f,
  @location(1) normal: vec4f,
}
@fragment fn fs_gbuffer(v: VOut) -> GOut {
  var o: GOut;
  o.albedo = vec4f(albedo_of(v), 1.0);
  o.normal = vec4f(normalize(v.normal) * 0.5 + 0.5, 1.0);
  return o;
}
`;

const WGSL_LIGHTING = /* wgsl */ `
${WGSL_COMMON}
${WGSL_FULLSCREEN}
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormal: texture_2d<f32>;
@group(1) @binding(2) var gDepth: texture_depth_2d;

@fragment fn fs_lighting(v: FsOut) -> @location(0) vec4f {
  let ixy = vec2i(v.pos.xy);
  let d = textureLoad(gDepth, ixy, 0);
  if (d >= 1.0) {
    if (i32(frame.params.y) == 1) { return vec4f(heat(0.0), 1.0); }
    return vec4f(to_srgb(vec3f(${SKY.join(', ')})), 1.0);
  }
  let albedo = textureLoad(gAlbedo, ixy, 0).rgb;
  let n = normalize(textureLoad(gNormal, ixy, 0).xyz * 2.0 - 1.0);
  // Rebuild the position: the pixel's clip-space x, y and its depth, through the inverse view-projection.
  let ndc = vec2f(v.pos.x / frame.params.z * 2.0 - 1.0, 1.0 - v.pos.y / frame.params.w * 2.0);
  let w = frame.invViewProj * vec4f(ndc, d, 1.0);
  let p = w.xyz / w.w;
  let z = (frame.viewProj * vec4f(p, 1.0)).w;
  return show(shade(p, n, albedo, v.pos.xy, z), albedo, n, z);
}
`;

const DEPTH_FORMAT = 'depth24plus';
const ALBEDO_FORMAT = 'rgba8unorm';
const NORMAL_FORMAT = 'rgb10a2unorm';

interface GpuTargets {
  w: number;
  h: number;
  depth: GPUTexture;
  albedo: GPUTexture;
  normal: GPUTexture;
  depthView: GPUObject;
  albedoView: GPUObject;
  normalView: GPUObject;
  group: GPUObject;
}

class FdcWebGpu implements FdcRenderer {
  readonly backend = 'webgpu';
  readonly timer: WebGpuTimer;
  private dev: GPUDevice;
  private canvasCtx: GPUCanvasContext;
  private draws = fdcDraws();
  private meshes: Array<{ vb: GPUBuffer; ib: GPUBuffer; count: number }> = [];
  private frameUbo!: GPUBuffer;
  private lightUbo!: GPUBuffer;
  private drawUbo!: GPUBuffer;
  private cellsTex!: GPUTexture;
  private indexTex!: GPUTexture;
  private align: number;
  private frameGroup!: GPUObject;
  private drawGroups: GPUObject[] = [];
  private gbufLayout!: GPUObject;
  private pipelines = new Map<string, GPUObject>();
  private target: GpuTargets | null = null;

  private constructor(
    private gc: WebGpuContext,
    private log: CallLog,
  ) {
    this.dev = record(gc.device, log, 'device');
    this.canvasCtx = record(gc.context, log, 'context');
    this.align = Math.max(256, gc.device.limits.minUniformBufferOffsetAlignment ?? 256);
    this.timer = new WebGpuTimer(gc, log, 2);
  }

  static async create(gc: WebGpuContext, log: CallLog): Promise<FdcWebGpu> {
    const r = new FdcWebGpu(gc, log);
    await r.init();
    return r;
  }

  private async init(): Promise<void> {
    const dev = this.dev;
    this.log.phase = 'init';
    this.gc.device.pushErrorScope('validation');
    this.meshes = gpuMeshBuffers(dev, this.draws.map((d) => d.mesh));
    this.frameUbo = uniformBuffer(dev, 'frame constants', FDC_FRAME_BYTES);
    this.lightUbo = uniformBuffer(dev, 'lights', MAX_GPU_LIGHTS * FDC_LIGHT_BYTES);
    this.drawUbo = uniformBuffer(dev, 'draw constants', (this.draws.length - 1) * this.align + DRAW_BYTES);
    const albedo = new Float32Array(((this.draws.length - 1) * this.align + DRAW_BYTES) / 4);
    this.draws.forEach((d, i) => albedo.set([...d.albedo, d.checker ? 1 : 0], (i * this.align) / 4));
    dev.queue.writeBuffer(this.drawUbo, 0, albedo);
    // The light lists: a grid of (offset, count) and the index list, as integer textures the shaders read with textureLoad.
    this.cellsTex = dev.createTexture({ label: 'light grid', size: [TILES_X * TILES_Y, SLICES], format: 'rg32uint', usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });
    this.indexTex = dev.createTexture({ label: 'light indices', size: [INDEX_W, INDEX_H], format: 'r32uint', usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });

    const scene = dev.createShaderModule({ label: 'scene shaders', code: WGSL_SCENE });
    const lighting = dev.createShaderModule({ label: 'lighting shaders', code: WGSL_LIGHTING });
    const both = ShaderStage.VERTEX | ShaderStage.FRAGMENT;
    const frameLayout = dev.createBindGroupLayout({
      label: 'per frame',
      entries: [
        { binding: 0, visibility: both, buffer: { type: 'uniform' } },
        { binding: 1, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
        { binding: 3, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
      ],
    });
    const drawLayout = dev.createBindGroupLayout({ label: 'per draw', entries: [{ binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    this.gbufLayout = dev.createBindGroupLayout({
      label: 'G-buffer',
      entries: [
        { binding: 0, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      ],
    });
    const sceneLayout = dev.createPipelineLayout({ label: 'scene', bindGroupLayouts: [frameLayout, drawLayout] });
    const lightingLayout = dev.createPipelineLayout({ label: 'lighting', bindGroupLayouts: [frameLayout, this.gbufLayout] });
    const depthStencil = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' };
    const primitive = { topology: 'triangle-list', cullMode: 'back' as const, frontFace: 'ccw' as const };
    const jobs = [
      dev.createRenderPipelineAsync({
        label: FORWARD,
        layout: sceneLayout,
        vertex: { module: scene, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] },
        fragment: { module: scene, entryPoint: 'fs_forward', targets: [{ format: this.gc.format }] },
        primitive,
        depthStencil,
      }),
      dev.createRenderPipelineAsync({
        label: GBUFFER_PASS,
        layout: sceneLayout,
        vertex: { module: scene, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] },
        // Two colour targets: the G-buffer's albedo and normal.
        fragment: { module: scene, entryPoint: 'fs_gbuffer', targets: [{ format: ALBEDO_FORMAT }, { format: NORMAL_FORMAT }] },
        primitive,
        depthStencil,
      }),
      dev.createRenderPipelineAsync({
        label: LIGHTING,
        layout: lightingLayout,
        vertex: { module: lighting, entryPoint: 'vs_full' },
        fragment: { module: lighting, entryPoint: 'fs_lighting', targets: [{ format: this.gc.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      }),
    ];
    const [fwd, gbuf, light] = await Promise.all(jobs);
    this.pipelines.set(FORWARD, fwd);
    this.pipelines.set(GBUFFER_PASS, gbuf);
    this.pipelines.set(LIGHTING, light);
    this.frameGroup = dev.createBindGroup({
      label: 'frame',
      layout: frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameUbo } },
        { binding: 1, resource: { buffer: this.lightUbo } },
        { binding: 2, resource: this.cellsTex.createView() },
        { binding: 3, resource: this.indexTex.createView() },
      ],
    });
    this.drawGroups = this.draws.map((d, i) => dev.createBindGroup({ label: d.name, layout: drawLayout, entries: [{ binding: 0, resource: { buffer: this.drawUbo, offset: i * this.align, size: DRAW_BYTES } }] }));
    const err = await this.gc.device.popErrorScope();
    if (err) console.error('WebGPU init:', err.message);
  }

  private targets(w: number, h: number): GpuTargets {
    if (this.target && this.target.w === w && this.target.h === h) return this.target;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    for (const t of [this.target?.depth, this.target?.albedo, this.target?.normal]) t?.destroy();
    const dev = this.dev;
    const tex = (label: string, format: string) => dev.createTexture({ label, size: [w, h], format, usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    const depth = tex('depth', DEPTH_FORMAT);
    const albedo = tex('G-buffer albedo', ALBEDO_FORMAT);
    const normal = tex('G-buffer normal', NORMAL_FORMAT);
    const depthView = depth.createView();
    const albedoView = albedo.createView();
    const normalView = normal.createView();
    const group = dev.createBindGroup({
      label: 'G-buffer',
      layout: this.gbufLayout,
      entries: [
        { binding: 0, resource: albedoView },
        { binding: 1, resource: normalView },
        { binding: 2, resource: depthView },
      ],
    });
    this.target = { w, h, depth, albedo, normal, depthView, albedoView, normalView, group };
    this.log.phase = prev;
    return this.target;
  }

  frame(s: FdcSettings, input: FdcInput): FramePlan {
    const w = this.gc.canvas.width;
    const h = this.gc.canvas.height;
    const plan = fdcPlan(s, w, h);
    const dev = this.dev;
    const t = this.targets(w, h);
    this.log.phase = 'frame';
    if (input.changed) {
      dev.queue.writeBuffer(this.lightUbo, 0, lightData(input.lights, input.colours));
      const g = input.lists.grid;
      dev.queue.writeTexture({ texture: this.cellsTex }, cellData(input.lists), { bytesPerRow: g.tx * g.ty * 8 }, [g.tx * g.ty, g.slices]);
      const ix = indexData(input.lists);
      dev.queue.writeTexture({ texture: this.indexTex }, ix.data, { bytesPerRow: INDEX_W * 4 }, [INDEX_W, ix.rows]);
    }
    dev.queue.writeBuffer(this.frameUbo, 0, frameData(s, input.lists, w, h));

    const enc = dev.createCommandEncoder({ label: 'frame' });
    const canvasView = this.canvasCtx.getCurrentTexture().createView();
    const depthAttachment = { view: t.depthView, depthClearValue: 1, depthLoadOp: 'clear' as const, depthStoreOp: 'store' as const };
    const first = plan.passes[0];
    const p1 = enc.beginRenderPass({
      label: first.name,
      colorAttachments:
        s.shading === 'forward'
          ? [{ view: canvasView, clearValue: skyClear(), loadOp: 'clear', storeOp: 'store' }]
          : [
              { view: t.albedoView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
              { view: t.normalView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
            ],
      depthStencilAttachment: depthAttachment,
      timestampWrites: this.timer.writes(0),
    });
    p1.setBindGroup(0, this.frameGroup);
    let bound = '';
    first.draws.forEach((d, i) => {
      if (d.pipeline !== bound) p1.setPipeline(this.pipelines.get((bound = d.pipeline))!);
      p1.setBindGroup(1, this.drawGroups[i]);
      p1.setVertexBuffer(0, this.meshes[i].vb);
      p1.setIndexBuffer(this.meshes[i].ib, 'uint16');
      p1.drawIndexed(d.count, d.instances, 0, 0, 0);
    });
    p1.end();
    if (s.shading === 'deferred') {
      const p2 = enc.beginRenderPass({
        label: plan.passes[1].name,
        colorAttachments: [{ view: canvasView, clearValue: skyClear(), loadOp: 'clear', storeOp: 'store' }],
        timestampWrites: this.timer.writes(1),
      });
      p2.setPipeline(this.pipelines.get(LIGHTING)!);
      p2.setBindGroup(0, this.frameGroup);
      p2.setBindGroup(1, t.group);
      p2.draw(3, 1, 0, 0);
      p2.end();
    }
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
    for (const b of [this.frameUbo, this.lightUbo, this.drawUbo]) b?.destroy();
    for (const t of [this.cellsTex, this.indexTex, this.target?.depth, this.target?.albedo, this.target?.normal]) t?.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// WebGL2

const GLSL_COMMON = `
layout(std140) uniform Frame { mat4 viewProj; mat4 invViewProj; vec4 eye; vec4 grid; vec4 params; vec4 ambient; };
struct Light { vec4 pos; vec4 color; };
layout(std140) uniform Lights { Light lights[${MAX_GPU_LIGHTS}]; };
uniform highp usampler2D cells;
uniform highp usampler2D indices;
${GLSL_SRGB}
${heatCode('glsl')}

// GL counts pixel rows from the bottom; the tiles count from the top.
ivec2 cell_of(vec2 frag, float z) {
  vec2 xy = vec2(frag.x, params.w - frag.y);
  int i = min(int(xy.x / params.z * grid.x), int(grid.x) - 1);
  int j = min(int(xy.y / params.w * grid.y), int(grid.y) - 1);
  int k = 0;
  if (grid.z > 1.0) k = clamp(int(floor(log2(z / params.x) * grid.w)), 0, int(grid.z) - 1);
  return ivec2(i + j * int(grid.x), k);
}

vec4 shade(vec3 p, vec3 n, vec3 albedo, vec2 frag, float z) {
  uvec2 cell = texelFetch(cells, cell_of(frag, z), 0).xy;
  vec3 c = ambient.rgb * albedo;
  for (uint i = 0u; i < cell.y; i++) {
    uint idx = cell.x + i;
    Light L = lights[texelFetch(indices, ivec2(int(idx % ${INDEX_W}u), int(idx / ${INDEX_W}u)), 0).x];
    vec3 d = L.pos.xyz - p;
    float dist = length(d);
    float x = dist / L.pos.w;
    float win = clamp(1.0 - x * x * x * x, 0.0, 1.0);
    c += albedo * L.color.rgb * (L.color.w * win * win / (dist * dist + 1.0) * max(dot(n, d / dist), 0.0));
  }
  return vec4(c, float(cell.y));
}

vec4 show(vec4 lit, vec3 albedo, vec3 n, float z) {
  int mode = int(params.y);
  if (mode == 1) return vec4(heat(lit.w), 1.0);
  if (mode == 2) return vec4(to_srgb(albedo), 1.0);
  if (mode == 3) return vec4(n * 0.5 + 0.5, 1.0);
  if (mode == 4) return vec4(vec3(clamp(1.0 - z / 45.0, 0.0, 1.0)), 1.0);
  vec3 c = lit.rgb * ambient.w;
  return vec4(to_srgb(c / (1.0 + c)), 1.0);
}
`;

const GLSL_SCENE_VS = `#version 300 es
layout(std140) uniform Frame { mat4 viewProj; mat4 invViewProj; vec4 eye; vec4 grid; vec4 params; vec4 ambient; };
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
out float vZ;
void main() {
  vec4 c = viewProj * vec4(position, 1.0);
  gl_Position = vec4(c.xy, 2.0 * c.z - c.w, c.w); // depth 0..w to GL's -w..w
  vWorld = position;
  vNormal = normal;
  vUv = uv;
  vZ = c.w;
}`;

const glslSceneFs = (gbuffer: boolean) => `#version 300 es
precision highp float;
precision highp int;
${GLSL_COMMON}
layout(std140) uniform Draw { vec4 albedo; };
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
in float vZ;
${gbuffer ? 'layout(location = 0) out vec4 outAlbedo;\nlayout(location = 1) out vec4 outNormal;' : 'out vec4 outColor;'}
void main() {
  int odd = (int(floor(vUv.x)) + int(floor(vUv.y))) & 1;
  vec3 a = albedo.rgb * ((albedo.w > 0.5 && odd == 1) ? 0.55 : 1.0);
  vec3 n = normalize(vNormal);
${gbuffer ? '  outAlbedo = vec4(a, 1.0);\n  outNormal = vec4(n * 0.5 + 0.5, 1.0);' : '  outColor = show(shade(vWorld, n, a, gl_FragCoord.xy, vZ), a, n, vZ);'}
}`;

const GLSL_LIGHTING_FS = `#version 300 es
precision highp float;
precision highp int;
${GLSL_COMMON}
uniform sampler2D gAlbedo;
uniform sampler2D gNormal;
uniform highp sampler2D gDepth;
in vec2 vUv;
out vec4 outColor;
void main() {
  ivec2 ixy = ivec2(gl_FragCoord.xy);
  float d = texelFetch(gDepth, ixy, 0).r;
  if (d >= 1.0) {
    outColor = int(params.y) == 1 ? vec4(heat(0.0), 1.0) : vec4(to_srgb(vec3(${SKY.join(', ')})), 1.0);
    return;
  }
  vec3 albedo = texelFetch(gAlbedo, ixy, 0).rgb;
  vec3 n = normalize(texelFetch(gNormal, ixy, 0).xyz * 2.0 - 1.0);
  vec2 ndc = gl_FragCoord.xy / params.zw * 2.0 - 1.0; // GL rows run bottom to top, like clip-space y
  vec4 w = invViewProj * vec4(ndc, d, 1.0);
  vec3 p = w.xyz / w.w;
  float z = (viewProj * vec4(p, 1.0)).w;
  outColor = show(shade(p, n, albedo, gl_FragCoord.xy, z), albedo, n, z);
}`;

interface GlTargets {
  w: number;
  h: number;
  depth: WebGLTexture | null;
  albedo: WebGLTexture | null;
  normal: WebGLTexture | null;
  colour: WebGLTexture | null;
  gbuffer: WebGLFramebuffer | null;
  forward: WebGLFramebuffer | null;
}

class FdcGl2 implements FdcRenderer {
  readonly backend = 'webgl2';
  readonly timer: Gl2Timer;
  private gl: WebGL2RenderingContext;
  private draws = fdcDraws();
  private meshes: Array<{ vao: WebGLVertexArrayObject | null; count: number }>;
  private frameUbo: WebGLBuffer | null;
  private lightUbo: WebGLBuffer | null;
  private drawUbo: WebGLBuffer | null;
  private align: number;
  private cellsTex: WebGLTexture | null;
  private indexTex: WebGLTexture | null;
  private programs = new Map<string, WebGLProgram>();
  private target: GlTargets | null = null;

  constructor(
    private gc: Gl2Context,
    private log: CallLog,
  ) {
    const gl = (this.gl = record(gc.gl, log, 'gl'));
    this.timer = new Gl2Timer(gc, log);
    log.phase = 'init';
    this.meshes = glMeshes(gl, this.draws.map((d) => d.mesh));
    this.align = Math.max(16, Number(gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT)) || 256);
    const ubo = (label: string, size: number, point: number) => {
      const b = named(gl.createBuffer(), label);
      gl.bindBuffer(gl.UNIFORM_BUFFER, b);
      gl.bufferData(gl.UNIFORM_BUFFER, size, gl.DYNAMIC_DRAW);
      if (point >= 0) gl.bindBufferBase(gl.UNIFORM_BUFFER, point, b);
      return b;
    };
    this.frameUbo = ubo('frame constants', FDC_FRAME_BYTES, 0);
    this.lightUbo = ubo('lights', MAX_GPU_LIGHTS * FDC_LIGHT_BYTES, 2);
    this.drawUbo = ubo('draw constants', (this.draws.length - 1) * this.align + DRAW_BYTES, -1);
    const albedo = new Float32Array(((this.draws.length - 1) * this.align + DRAW_BYTES) / 4);
    this.draws.forEach((d, i) => albedo.set([...d.albedo, d.checker ? 1 : 0], (i * this.align) / 4));
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, albedo);
    // The light lists as integer textures, read with texelFetch.
    this.cellsTex = glTexture(gl, 'light grid', gl.RG32UI, TILES_X * TILES_Y, SLICES);
    this.indexTex = glTexture(gl, 'light indices', gl.R32UI, INDEX_W, INDEX_H);
    const vs = compile(gl, gl.VERTEX_SHADER, GLSL_SCENE_VS);
    const forward = link(gl, FORWARD, vs, compile(gl, gl.FRAGMENT_SHADER, glslSceneFs(false)));
    const gbuffer = link(gl, GBUFFER_PASS, vs, compile(gl, gl.FRAGMENT_SHADER, glslSceneFs(true)));
    const lighting = link(gl, LIGHTING, compile(gl, gl.VERTEX_SHADER, GLSL_FULLSCREEN_VS), compile(gl, gl.FRAGMENT_SHADER, GLSL_LIGHTING_FS));
    const all = [forward, gbuffer, lighting];
    bindBlocks(gl, all, { Frame: 0, Draw: 1, Lights: 2 });
    bindSamplers(gl, all, { cells: 0, indices: 1, gAlbedo: 2, gNormal: 3, gDepth: 4 });
    this.programs.set(FORWARD, forward);
    this.programs.set(GBUFFER_PASS, gbuffer);
    this.programs.set(LIGHTING, lighting);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cellsTex);
    gl.activeTexture(gl.TEXTURE0 + 1);
    gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.depthFunc(gl.LESS);
  }

  private targets(w: number, h: number): GlTargets {
    if (this.target && this.target.w === w && this.target.h === h) return this.target;
    const gl = this.gl;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    if (this.target) {
      for (const t of [this.target.depth, this.target.albedo, this.target.normal, this.target.colour]) gl.deleteTexture(t);
      gl.deleteFramebuffer(this.target.gbuffer);
      gl.deleteFramebuffer(this.target.forward);
    }
    const depth = glTexture(gl, 'depth', gl.DEPTH_COMPONENT24, w, h);
    const albedo = glTexture(gl, 'G-buffer albedo', gl.RGBA8, w, h);
    const normal = glTexture(gl, 'G-buffer normal', gl.RGB10_A2, w, h);
    // The canvas has no depth buffer (and WebGL2's default framebuffer can't share one), so forward draws offscreen and blits.
    const colour = glTexture(gl, 'forward colour', gl.RGBA8, w, h);
    const gbuffer = glFramebuffer(gl, 'G-buffer', [albedo, normal], depth);
    const forward = glFramebuffer(gl, 'forward', [colour], depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.target = { w, h, depth, albedo, normal, colour, gbuffer, forward };
    this.log.phase = prev;
    return this.target;
  }

  frame(s: FdcSettings, input: FdcInput): FramePlan {
    const gl = this.gl;
    const w = this.gc.canvas.width;
    const h = this.gc.canvas.height;
    const plan = fdcPlan(s, w, h);
    const t = this.targets(w, h);
    this.log.phase = 'frame';
    if (input.changed) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.lightUbo);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, lightData(input.lights, input.colours));
      const g = input.lists.grid;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.cellsTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, g.tx * g.ty, g.slices, gl.RG_INTEGER, gl.UNSIGNED_INT, cellData(input.lists));
      const ix = indexData(input.lists);
      gl.activeTexture(gl.TEXTURE0 + 1);
      gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, INDEX_W, ix.rows, gl.RED_INTEGER, gl.UNSIGNED_INT, ix.data);
    }
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, frameData(s, input.lists, w, h));

    const first = plan.passes[0];
    this.timer.begin(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.shading === 'forward' ? t.forward : t.gbuffer);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    const sky = skyClear();
    if (s.shading === 'forward') {
      gl.clearColor(sky.r, sky.g, sky.b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    } else {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    let bound = '';
    first.draws.forEach((d, i) => {
      if (d.pipeline !== bound) gl.useProgram(this.programs.get((bound = d.pipeline))!);
      gl.bindBufferRange(gl.UNIFORM_BUFFER, 1, this.drawUbo, i * this.align, DRAW_BYTES);
      gl.bindVertexArray(this.meshes[i].vao);
      gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, 0);
    });
    this.timer.end(gl);
    if (s.shading === 'forward') {
      // Copy the offscreen colour to the canvas.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.forward);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    } else {
      this.timer.begin(gl);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.useProgram(this.programs.get(LIGHTING)!);
      gl.bindVertexArray(null);
      gl.activeTexture(gl.TEXTURE0 + 2);
      gl.bindTexture(gl.TEXTURE_2D, t.albedo);
      gl.activeTexture(gl.TEXTURE0 + 3);
      gl.bindTexture(gl.TEXTURE_2D, t.normal);
      gl.activeTexture(gl.TEXTURE0 + 4);
      gl.bindTexture(gl.TEXTURE_2D, t.depth);
      gl.drawArrays(gl.TRIANGLES, 0, plan.passes[1].draws[0].count);
      this.timer.end(gl);
    }
    this.timer.submitted(gl);
    return plan;
  }

  dispose(): void {
    // The context is lost or released by disposeGpu; its objects go with it.
  }
}
