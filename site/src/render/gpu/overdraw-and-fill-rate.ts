/**
 * "Overdraw and fill rate": the lesson's scene drawn with WebGPU and with WebGL2, walking the
 * FramePlan from scenes/overdraw-and-fill-rate.ts. Opaque cards and smoke particles are instanced
 * draws of one shape (a quad, or the trimmed octagon) placed by per-instance data; everything is
 * drawn into fixed-size offscreen targets (FILL_W × FILL_H, half that for the particle buffer), so
 * the frame has exactly the fragments the CPU model counts, then copied to the canvas.
 *
 * The heat map is the same frame with every fragment shader swapped for one that adds 1/255 to an
 * RGBA8 target (additive blending): the same draws, the same depth tests, so the target ends up
 * holding how many fragments were shaded at each pixel. The present pass turns counts into colours.
 *
 * Passes (each optional one only when its setting is on): depth prepass, opaque, depth downsample
 * (the farthest of each 2 × 2 block into a half-size depth buffer), particles, composite (the
 * half-size particle buffer blended over the scene), present.
 */
import { type Gl2Context, type GpuContext, type WebGpuContext } from './context';
import { BLEND, GLSL_FULLSCREEN_VS, WGSL_FULLSCREEN, glProgram, named, target } from './perf-common';
import { type FramePlan } from './plan';
import { type CallLog, record } from './record';
import { Gl2Timer, type GpuTimer, WebGpuTimer } from './timing';
import { BufferUsage, type GPUBuffer, type GPUCanvasContext, type GPUDevice, type GPUObject, type GPUTexture, ShaderStage, TextureUsage } from './webgpu';
import {
  FILL_H,
  FILL_W,
  type FillSettings,
  type FillView,
  MAX_PARTICLES,
  OCTAGON_INDICES,
  PASS,
  QUAD_INDICES,
  type Card,
  fillPlan,
  orderedOpaque,
  particleCards,
} from '../scenes/overdraw-and-fill-rate';

/** Theme colours, 0–255. */
export interface FillColours {
  bg: [number, number, number];
  /** Background card, then five card colours. */
  cards: Array<[number, number, number]>;
  smoke: [number, number, number];
  /** Heat ramp for 1, 2, 4, 8, 16, 32 and 64 or more fragments a pixel. */
  heat: Array<[number, number, number]>;
}

export interface FillRenderer {
  readonly backend: 'webgpu' | 'webgl2';
  readonly timer: GpuTimer;
  /** Draw a frame. `timed` says whether its pass times will be reported (in plan order). */
  frame(s: FillSettings, view: FillView, c: FillColours): { plan: FramePlan; timed: boolean };
  dispose(): void;
}

export async function createFill(ctx: GpuContext, log: CallLog): Promise<FillRenderer> {
  return ctx.kind === 'webgpu' ? FillWebGpu.create(ctx, log) : new FillGl2(ctx, log);
}

/** Bytes per instance: centre and half-extents (vec4), then cut, depth, tone and a spare float. */
const INSTANCE_BYTES = 32;
/** Frame uniforms: bg, 6 card colours, smoke, 7 heat colours, flags: 16 vec4 (same in WGSL and std140). */
const FRAME_BYTES = 16 * 16;
/** View uniforms: target width and height, scale, shader cost. */
const VIEW_BYTES = 16;
const MAX_PASSES = 6;

/** The shape buffer: per vertex (px, py, qx, qy), placed at centre + (px·hx + qx·k, py·hy + qy·k). */
const SHAPES = new Float32Array([
  // quad
  -1, -1, 0, 0, 1, -1, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0,
  // octagon: (hx, k), (k, hy), (−k, hy), (−hx, k), (−hx, −k), (−k, −hy), (k, −hy), (hx, −k)
  1, 0, 0, 1, 0, 1, 1, 0, 0, 1, -1, 0, -1, 0, 0, 1, -1, 0, 0, -1, 0, -1, -1, 0, 0, -1, 1, 0, 1, 0, 0, -1,
]);
/** Quad: 2 triangles; octagon: a fan of 6. Indices are absolute (WebGL2 has no base vertex). */
const SHAPE_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3, ...[1, 2, 3, 4, 5, 6].flatMap((i) => [4, 4 + i, 5 + i])]);
const OCTAGON_FIRST = QUAD_INDICES;

function instances(cards: Card[]): Float32Array {
  const f = new Float32Array(Math.max(1, cards.length) * (INSTANCE_BYTES / 4));
  cards.forEach((c, i) => f.set([c.cx, c.cy, c.hx, c.hy, c.k, c.z, c.tone, 0], i * 8));
  return f;
}
function frameData(c: FillColours, half: boolean, canvasW: number, canvasH: number): Float32Array {
  const d = new Float32Array(FRAME_BYTES / 4);
  const put = (i: number, rgb: [number, number, number], a = 1) => d.set([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, a], i * 4);
  put(0, c.bg);
  c.cards.forEach((x, i) => put(1 + i, x));
  put(7, c.smoke);
  c.heat.forEach((x, i) => put(8 + i, x));
  d.set([half ? 1 : 0, 0, canvasW, canvasH], 15 * 4);
  return d;
}
const viewData = (half: boolean, cost: number) => new Float32Array(half ? [FILL_W / 2, FILL_H / 2, 0.5, cost] : [FILL_W, FILL_H, 1, cost]);

/** What the instance buffers hold, so they're only rewritten when it changes. */
const opaqueKey = (s: FillSettings) => s.order;
const particleKey = (s: FillSettings) => `${s.particles} ${s.size} ${s.shape}`;

// ---------------------------------------------------------------------------------------------
// Shaders. The WGSL and GLSL versions do the same arithmetic.

const WGSL_COMMON = /* wgsl */ `
struct Frame {
  bg: vec4f,
  cards: array<vec4f, 6>,
  smoke: vec4f,
  heat: array<vec4f, 7>,
  flags: vec4f, // x: particles at half resolution; zw: canvas size
}
struct View {
  size: vec2f,  // the target's size in pixels
  scale: f32,   // 1, or 0.5 for the half-size particle buffer
  cost: f32,    // loop iterations in the particle shader
}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> view: View;
`;

const WGSL_CARDS = /* wgsl */ `${WGSL_COMMON}
struct VOut {
  @builtin(position) @invariant pos: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) tone: f32,
}

// shape: (px, py, qx, qy). a: centre, half-extents. b: cut, depth, tone.
@vertex fn vs(@location(0) shape: vec4f, @location(1) a: vec4f, @location(2) b: vec4f) -> VOut {
  let off = shape.xy * a.zw + shape.zw * b.x;
  let p = (a.xy + off) * view.scale;
  var o: VOut;
  o.pos = vec4f(p.x / view.size.x * 2.0 - 1.0, 1.0 - p.y / view.size.y * 2.0, b.y, 1.0);
  o.local = off / a.zw;
  o.tone = b.z;
  return o;
}

@fragment fn fs_opaque(v: VOut) -> @location(0) vec4f {
  let c = frame.cards[u32(v.tone)].rgb;
  // Lighter towards the top of each card.
  return vec4f(c * (0.8 - 0.2 * v.local.y), 1.0);
}

@fragment fn fs_smoke(v: VOut) -> @location(0) vec4f {
  var a = 0.3 * (1.0 - smoothstep(0.45, 1.0, length(v.local)));
  // The cost: a loop that changes the result a little, so the compiler can't drop it.
  var p = v.local * 3.0 + vec2f(v.tone * 17.0, 0.0);
  var n = 0.0;
  for (var i = 0; i < i32(view.cost); i++) {
    p = vec2f(p.x * 0.8 - p.y * 0.6, p.x * 0.6 + p.y * 0.8) + vec2f(0.37, 0.71);
    n += sin(p.x * 1.7 + cos(p.y * 2.3));
  }
  a *= 0.85 + 0.15 * sin(n);
  return vec4f(frame.smoke.rgb * (0.8 + 0.4 * v.tone), a);
}

@fragment fn fs_count() -> @location(0) vec4f {
  return vec4f(1.0 / 255.0, 0.0, 0.0, 0.0);
}
`;

const WGSL_DOWNSAMPLE = /* wgsl */ `${WGSL_FULLSCREEN}
@group(0) @binding(0) var depth: texture_depth_2d;
// The farthest of each 2 × 2 block: a particle is hidden only where all four pixels hide it.
@fragment fn fs(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
  let c = vec2i(p.xy) * 2;
  let a = max(textureLoad(depth, c, 0), textureLoad(depth, c + vec2i(1, 0), 0));
  let b = max(textureLoad(depth, c + vec2i(0, 1), 0), textureLoad(depth, c + vec2i(1, 1), 0));
  return max(a, b);
}
`;

const WGSL_COMPOSITE = /* wgsl */ `${WGSL_FULLSCREEN}
@group(0) @binding(0) var part: texture_2d<f32>;
// Blended with (one, src-alpha): scene × (what the particles let through) + particle colour.
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return textureLoad(part, vec2i(p.xy) / 2, 0);
}
@fragment fn fs_count() -> @location(0) vec4f {
  return vec4f(1.0 / 255.0, 0.0, 0.0, 0.0);
}
`;

const WGSL_PRESENT = /* wgsl */ `${WGSL_COMMON}${WGSL_FULLSCREEN}
@group(1) @binding(0) var scene: texture_2d<f32>;
@group(1) @binding(1) var half: texture_2d<f32>;
@group(1) @binding(2) var samp: sampler;

@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return textureSample(scene, samp, p.xy / frame.flags.zw);
}

fn ramp(n: f32) -> vec3f {
  // 1, 2, 4, ... 64+ fragments: interpolate between the seven colours in log2(n).
  let t = clamp(log2(max(n, 1.0)), 0.0, 6.0);
  let i = min(u32(t), 5u);
  return mix(frame.heat[i].rgb, frame.heat[i + 1u].rgb, t - f32(i));
}
@fragment fn fs_heat(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let t = vec2i(p.xy / frame.flags.zw * vec2f(${FILL_W}.0, ${FILL_H}.0));
  var n = round(textureLoad(scene, t, 0).r * 255.0);
  if (frame.flags.x > 0.5) {
    n += round(textureLoad(half, t / 2, 0).r * 255.0) / 4.0;
  }
  if (n < 0.5) {
    return vec4f(frame.bg.rgb, 1.0);
  }
  return vec4f(ramp(n), 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// WebGPU

const COLOR_FORMAT = 'rgba8unorm';
const DEPTH_FORMAT = 'depth24plus';

class FillWebGpu implements FillRenderer {
  readonly backend = 'webgpu';
  readonly timer: WebGpuTimer;
  private dev: GPUDevice;
  private canvasCtx: GPUCanvasContext;
  private shapes!: GPUBuffer;
  private indices!: GPUBuffer;
  private opaqueBuf!: GPUBuffer;
  private particleBuf!: GPUBuffer;
  private frameUbo!: GPUBuffer;
  private viewFull!: GPUBuffer;
  private viewHalf!: GPUBuffer;
  private groupFull!: GPUObject;
  private groupHalf!: GPUObject;
  private pipes = new Map<string, GPUObject>();
  private t!: { color: GPUTexture; depth: GPUTexture; part: GPUTexture; halfDepth: GPUTexture; colorView: GPUObject; depthView: GPUObject; partView: GPUObject; halfDepthView: GPUObject };
  private downGroup!: GPUObject;
  private compGroup!: GPUObject;
  private presentGroup!: GPUObject;
  private keys = { opaque: '', particles: '' };

  private constructor(
    private gc: WebGpuContext,
    private log: CallLog,
  ) {
    this.dev = record(gc.device, log, 'device');
    this.canvasCtx = record(gc.context, log, 'context');
    this.timer = new WebGpuTimer(gc, log, MAX_PASSES);
  }

  static async create(gc: WebGpuContext, log: CallLog): Promise<FillWebGpu> {
    const r = new FillWebGpu(gc, log);
    await r.init();
    return r;
  }

  private async init(): Promise<void> {
    const dev = this.dev;
    this.log.phase = 'init';
    this.gc.device.pushErrorScope('validation');
    this.shapes = dev.createBuffer({ label: 'shapes', size: SHAPES.byteLength, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.shapes, 0, SHAPES);
    this.indices = dev.createBuffer({ label: 'shape indices', size: SHAPE_INDICES.byteLength, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.indices, 0, SHAPE_INDICES);
    this.opaqueBuf = dev.createBuffer({ label: 'opaque instances', size: 32 * INSTANCE_BYTES, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this.particleBuf = dev.createBuffer({ label: 'particle instances', size: MAX_PARTICLES * INSTANCE_BYTES, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this.frameUbo = dev.createBuffer({ label: 'frame constants', size: FRAME_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.viewFull = dev.createBuffer({ label: 'view, full resolution', size: VIEW_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.viewHalf = dev.createBuffer({ label: 'view, half resolution', size: VIEW_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });

    // Every target has a fixed size, so it's made once here.
    const tex = (label: string, w: number, h: number, format: string) =>
      dev.createTexture({ label, size: [w, h], format, usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    const color = tex('scene colour', FILL_W, FILL_H, COLOR_FORMAT);
    const depth = tex('scene depth', FILL_W, FILL_H, DEPTH_FORMAT);
    const part = tex('particle buffer', FILL_W / 2, FILL_H / 2, COLOR_FORMAT);
    const halfDepth = tex('half-size depth', FILL_W / 2, FILL_H / 2, DEPTH_FORMAT);
    this.t = { color, depth, part, halfDepth, colorView: color.createView(), depthView: depth.createView(), partView: part.createView(), halfDepthView: halfDepth.createView() };

    const cards = dev.createShaderModule({ label: 'cards', code: WGSL_CARDS });
    const down = dev.createShaderModule({ label: 'depth downsample', code: WGSL_DOWNSAMPLE });
    const comp = dev.createShaderModule({ label: 'composite', code: WGSL_COMPOSITE });
    const present = dev.createShaderModule({ label: 'present', code: WGSL_PRESENT });
    const V = ShaderStage.VERTEX;
    const F = ShaderStage.FRAGMENT;
    const frameLayout = dev.createBindGroupLayout({
      label: 'frame and view',
      entries: [
        { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: V | F, buffer: { type: 'uniform' } },
      ],
    });
    const depthLayout = dev.createBindGroupLayout({ label: 'depth to downsample', entries: [{ binding: 0, visibility: F, texture: { sampleType: 'depth' } }] });
    const partLayout = dev.createBindGroupLayout({ label: 'particle buffer', entries: [{ binding: 0, visibility: F, texture: { sampleType: 'float' } }] });
    const presentLayout = dev.createBindGroupLayout({
      label: 'present',
      entries: [
        { binding: 0, visibility: F, texture: { sampleType: 'float' } },
        { binding: 1, visibility: F, texture: { sampleType: 'float' } },
        { binding: 2, visibility: F, sampler: { type: 'filtering' } },
      ],
    });
    const cardsLayout = dev.createPipelineLayout({ label: 'cards', bindGroupLayouts: [frameLayout] });

    const vertex = {
      module: cards,
      entryPoint: 'vs',
      buffers: [
        { arrayStride: 16, stepMode: 'vertex' as const, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] },
        {
          arrayStride: INSTANCE_BYTES,
          stepMode: 'instance' as const,
          attributes: [
            { shaderLocation: 1, offset: 0, format: 'float32x4' },
            { shaderLocation: 2, offset: 16, format: 'float32x4' },
          ],
        },
      ],
    };
    const depthState = (compare: string, write: boolean) => ({ format: DEPTH_FORMAT, depthWriteEnabled: write, depthCompare: compare });
    const jobs: Array<Promise<void>> = [];
    const pipe = (key: string, d: Parameters<GPUDevice['createRenderPipelineAsync']>[0]) => jobs.push(dev.createRenderPipelineAsync({ ...d, label: key }).then((p) => void this.pipes.set(key, p)));
    const card = (key: string, entry: string | null, compare: string, write: boolean, blend?: object) =>
      pipe(key, {
        label: key,
        layout: cardsLayout,
        vertex,
        fragment: entry ? { module: cards, entryPoint: entry, targets: [target(COLOR_FORMAT, blend)] } : undefined,
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depthState(compare, write),
      });
    card('depth only', null, 'less', true);
    card('opaque', 'fs_opaque', 'less', true);
    card('opaque, depth equal', 'fs_opaque', 'equal', false);
    card('count', 'fs_count', 'less', true, BLEND.add);
    card('count, depth equal', 'fs_count', 'equal', false, BLEND.add);
    card('particles', 'fs_smoke', 'less', false, BLEND.over);
    // Cantlay's split: colour blended as usual onto black, alpha keeps the product of (1 − a).
    card('particles, half resolution', 'fs_smoke', 'less', false, { color: BLEND.over.color, alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' } });
    card('particle count', 'fs_count', 'less', false, BLEND.add);
    pipe('downsample depth', {
      layout: dev.createPipelineLayout({ label: 'downsample', bindGroupLayouts: [depthLayout] }),
      vertex: { module: down, entryPoint: 'vs_full' },
      // A fragment shader with no colour targets: it only writes depth.
      fragment: { module: down, entryPoint: 'fs', targets: [] },
      primitive: { topology: 'triangle-list' },
      depthStencil: depthState('always', true),
    });
    const compLayout = dev.createPipelineLayout({ label: 'composite', bindGroupLayouts: [partLayout] });
    pipe('composite', {
      layout: compLayout,
      vertex: { module: comp, entryPoint: 'vs_full' },
      fragment: { module: comp, entryPoint: 'fs', targets: [target(COLOR_FORMAT, { color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' }, alpha: BLEND.add.alpha })] },
      primitive: { topology: 'triangle-list' },
    });
    pipe('count composite', {
      layout: compLayout,
      vertex: { module: comp, entryPoint: 'vs_full' },
      fragment: { module: comp, entryPoint: 'fs_count', targets: [target(COLOR_FORMAT, BLEND.add)] },
      primitive: { topology: 'triangle-list' },
    });
    const presentPipeLayout = dev.createPipelineLayout({ label: 'present', bindGroupLayouts: [frameLayout, presentLayout] });
    for (const [key, entry] of [
      ['present', 'fs'],
      ['present heat', 'fs_heat'],
    ])
      pipe(key, {
        layout: presentPipeLayout,
        vertex: { module: present, entryPoint: 'vs_full' },
        fragment: { module: present, entryPoint: entry, targets: [{ format: this.gc.format }] },
        primitive: { topology: 'triangle-list' },
      });

    const sampler = dev.createSampler({ label: 'linear', magFilter: 'linear', minFilter: 'linear' });
    this.groupFull = dev.createBindGroup({ label: 'full resolution', layout: frameLayout, entries: [{ binding: 0, resource: { buffer: this.frameUbo } }, { binding: 1, resource: { buffer: this.viewFull } }] });
    this.groupHalf = dev.createBindGroup({ label: 'half resolution', layout: frameLayout, entries: [{ binding: 0, resource: { buffer: this.frameUbo } }, { binding: 1, resource: { buffer: this.viewHalf } }] });
    this.downGroup = dev.createBindGroup({ label: 'scene depth', layout: depthLayout, entries: [{ binding: 0, resource: this.t.depthView }] });
    this.compGroup = dev.createBindGroup({ label: 'particle buffer', layout: partLayout, entries: [{ binding: 0, resource: this.t.partView }] });
    this.presentGroup = dev.createBindGroup({
      label: 'present',
      layout: presentLayout,
      entries: [
        { binding: 0, resource: this.t.colorView },
        { binding: 1, resource: this.t.partView },
        { binding: 2, resource: sampler },
      ],
    });
    await Promise.all(jobs);
    const err = await this.gc.device.popErrorScope();
    if (err) console.error('WebGPU init:', err.message);
  }

  frame(s: FillSettings, view: FillView, c: FillColours): { plan: FramePlan; timed: boolean } {
    const dev = this.dev;
    const plan = fillPlan(s, view);
    const heat = view === 'heat';
    if (this.keys.opaque !== opaqueKey(s)) {
      this.log.phase = 'rebuild';
      dev.queue.writeBuffer(this.opaqueBuf, 0, instances(orderedOpaque(s.order)));
      this.keys.opaque = opaqueKey(s);
    }
    if (this.keys.particles !== particleKey(s)) {
      this.log.phase = 'rebuild';
      dev.queue.writeBuffer(this.particleBuf, 0, instances(particleCards(s.size, s.shape, s.particles)));
      this.keys.particles = particleKey(s);
    }
    this.log.phase = 'frame';
    dev.queue.writeBuffer(this.frameUbo, 0, frameData(c, s.halfRes, this.gc.canvas.width, this.gc.canvas.height));
    dev.queue.writeBuffer(this.viewFull, 0, viewData(false, s.cost));
    dev.queue.writeBuffer(this.viewHalf, 0, viewData(true, s.cost));
    const black = { r: 0, g: 0, b: 0, a: heat ? 0 : 1 };
    const clear = heat ? { r: 0, g: 0, b: 0, a: 0 } : { r: c.bg[0] / 255, g: c.bg[1] / 255, b: c.bg[2] / 255, a: 1 };
    const enc = dev.createCommandEncoder({ label: 'frame' });
    plan.passes.forEach((p, i) => {
      const ts = this.timer.writes(i);
      const d = p.draws[0];
      const cards = (pass: ReturnType<typeof enc.beginRenderPass>, instanceBuf: GPUBuffer, group: GPUObject) => {
        if (!d) return;
        pass.setPipeline(this.pipes.get(d.pipeline === 'count' && p.name === PASS.particles ? 'particle count' : d.pipeline)!);
        pass.setBindGroup(0, group);
        pass.setVertexBuffer(0, this.shapes);
        pass.setVertexBuffer(1, instanceBuf);
        pass.setIndexBuffer(this.indices, 'uint16');
        pass.drawIndexed(d.count, d.instances, d.count === OCTAGON_INDICES ? OCTAGON_FIRST : 0, 0, 0);
      };
      if (p.name === PASS.prepass) {
        const pass = enc.beginRenderPass({ label: p.name, colorAttachments: [], depthStencilAttachment: { view: this.t.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' }, timestampWrites: ts });
        cards(pass, this.opaqueBuf, this.groupFull);
        pass.end();
      } else if (p.name === PASS.opaque) {
        const pass = enc.beginRenderPass({
          label: p.name,
          colorAttachments: [{ view: this.t.colorView, clearValue: clear, loadOp: 'clear', storeOp: 'store' }],
          depthStencilAttachment: { view: this.t.depthView, depthClearValue: 1, depthLoadOp: s.prepass ? 'load' : 'clear', depthStoreOp: 'store' },
          timestampWrites: ts,
        });
        cards(pass, this.opaqueBuf, this.groupFull);
        pass.end();
      } else if (p.name === PASS.downsample) {
        const pass = enc.beginRenderPass({ label: p.name, colorAttachments: [], depthStencilAttachment: { view: this.t.halfDepthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' }, timestampWrites: ts });
        pass.setPipeline(this.pipes.get(p.draws[0].pipeline)!);
        pass.setBindGroup(0, this.downGroup);
        pass.draw(3, 1, 0, 0);
        pass.end();
      } else if (p.name === PASS.particles) {
        const pass = enc.beginRenderPass({
          label: p.name,
          colorAttachments: [s.halfRes ? { view: this.t.partView, clearValue: black, loadOp: 'clear', storeOp: 'store' } : { view: this.t.colorView, loadOp: 'load', storeOp: 'store' }],
          // The particles test against depth but don't write it, and nothing reads it afterwards.
          depthStencilAttachment: { view: s.halfRes ? this.t.halfDepthView : this.t.depthView, depthLoadOp: 'load', depthStoreOp: 'discard' },
          timestampWrites: ts,
        });
        cards(pass, this.particleBuf, s.halfRes ? this.groupHalf : this.groupFull);
        pass.end();
      } else if (p.name === PASS.composite) {
        const pass = enc.beginRenderPass({ label: p.name, colorAttachments: [{ view: this.t.colorView, loadOp: 'load', storeOp: 'store' }], timestampWrites: ts });
        pass.setPipeline(this.pipes.get(p.draws[0].pipeline)!);
        pass.setBindGroup(0, this.compGroup);
        pass.draw(3, 1, 0, 0);
        pass.end();
      } else {
        const pass = enc.beginRenderPass({
          label: p.name,
          colorAttachments: [{ view: this.canvasCtx.getCurrentTexture().createView(), clearValue: clear, loadOp: 'clear', storeOp: 'store' }],
          timestampWrites: ts,
        });
        pass.setPipeline(this.pipes.get(p.draws[0].pipeline)!);
        pass.setBindGroup(0, this.groupFull);
        pass.setBindGroup(1, this.presentGroup);
        pass.draw(3, 1, 0, 0);
        pass.end();
      }
    });
    const timed = this.timer.resolve(enc);
    dev.queue.submit([enc.finish({ label: 'frame' })]);
    this.timer.submitted();
    return { plan, timed };
  }

  dispose(): void {
    for (const b of [this.shapes, this.indices, this.opaqueBuf, this.particleBuf, this.frameUbo, this.viewFull, this.viewHalf]) b?.destroy();
    if (this.t) for (const x of [this.t.color, this.t.depth, this.t.part, this.t.halfDepth]) x.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// WebGL2

const GLSL_UBOS = `
layout(std140) uniform Frame { vec4 bg; vec4 cards[6]; vec4 smoke; vec4 heat[7]; vec4 flags; };
layout(std140) uniform View { vec4 view; }; // target width, height, scale, cost
`;
const GLSL_CARDS_VS = `#version 300 es
${GLSL_UBOS}
layout(location = 0) in vec4 shape;
layout(location = 1) in vec4 a;
layout(location = 2) in vec4 b;
out vec2 vLocal;
flat out float vTone;
invariant gl_Position;
void main() {
  vec2 off = shape.xy * a.zw + shape.zw * b.x;
  vec2 p = (a.xy + off) * view.z;
  // Depth b.y in 0..1, as WebGPU; OpenGL ES's clip space wants -1..1.
  gl_Position = vec4(p.x / view.x * 2.0 - 1.0, 1.0 - p.y / view.y * 2.0, 2.0 * b.y - 1.0, 1.0);
  vLocal = off / a.zw;
  vTone = b.z;
}`;
const glslCardsFs = (body: string) => `#version 300 es
precision highp float;
${GLSL_UBOS}
in vec2 vLocal;
flat in float vTone;
out vec4 outColor;
void main() {
${body}
}`;
const GLSL_OPAQUE = glslCardsFs(`  outColor = vec4(cards[int(vTone)].rgb * (0.8 - 0.2 * vLocal.y), 1.0);`);
const GLSL_SMOKE = glslCardsFs(`  float a = 0.3 * (1.0 - smoothstep(0.45, 1.0, length(vLocal)));
  vec2 p = vLocal * 3.0 + vec2(vTone * 17.0, 0.0);
  float n = 0.0;
  for (int i = 0; i < int(view.w); i++) {
    p = vec2(p.x * 0.8 - p.y * 0.6, p.x * 0.6 + p.y * 0.8) + vec2(0.37, 0.71);
    n += sin(p.x * 1.7 + cos(p.y * 2.3));
  }
  a *= 0.85 + 0.15 * sin(n);
  outColor = vec4(smoke.rgb * (0.8 + 0.4 * vTone), a);`);
const GLSL_COUNT = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(1.0 / 255.0, 0.0, 0.0, 0.0); }`;
const GLSL_DOWNSAMPLE = `#version 300 es
precision highp float;
uniform highp sampler2D depthTex;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy) * 2;
  float a = max(texelFetch(depthTex, c, 0).r, texelFetch(depthTex, c + ivec2(1, 0), 0).r);
  float b = max(texelFetch(depthTex, c + ivec2(0, 1), 0).r, texelFetch(depthTex, c + ivec2(1, 1), 0).r);
  gl_FragDepth = max(a, b);
}`;
const GLSL_COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D part;
out vec4 outColor;
void main() { outColor = texelFetch(part, ivec2(gl_FragCoord.xy) / 2, 0); }`;
const glslPresent = (heat: boolean) => `#version 300 es
precision highp float;
${GLSL_UBOS}
uniform sampler2D scene;
uniform sampler2D halfBuf;
out vec4 outColor;
vec3 ramp(float n) {
  float t = clamp(log2(max(n, 1.0)), 0.0, 6.0);
  int i = min(int(t), 5);
  return mix(heat[i].rgb, heat[i + 1].rgb, t - float(i));
}
void main() {
  vec2 uv = gl_FragCoord.xy / flags.zw;
${
  heat
    ? `  ivec2 t = ivec2(uv * vec2(${FILL_W}.0, ${FILL_H}.0));
  float n = floor(texelFetch(scene, t, 0).r * 255.0 + 0.5);
  if (flags.x > 0.5) n += floor(texelFetch(halfBuf, t / 2, 0).r * 255.0 + 0.5) / 4.0;
  outColor = n < 0.5 ? vec4(bg.rgb, 1.0) : vec4(ramp(n), 1.0);`
    : `  outColor = texture(scene, uv);`
}
}`;

class FillGl2 implements FillRenderer {
  readonly backend = 'webgl2';
  readonly timer: Gl2Timer;
  private gl: WebGL2RenderingContext;
  private vaoOpaque: WebGLVertexArrayObject | null;
  private vaoParticles: WebGLVertexArrayObject | null;
  private opaqueBuf: WebGLBuffer | null;
  private particleBuf: WebGLBuffer | null;
  private frameUbo: WebGLBuffer | null;
  private viewFull: WebGLBuffer | null;
  private viewHalf: WebGLBuffer | null;
  private progs: Record<string, WebGLProgram> = {};
  private fboScene: WebGLFramebuffer | null;
  private fboHalf: WebGLFramebuffer | null;
  private texColor: WebGLTexture | null;
  private texDepth: WebGLTexture | null;
  private texPart: WebGLTexture | null;
  private keys = { opaque: '', particles: '' };

  constructor(
    private gc: Gl2Context,
    private log: CallLog,
  ) {
    const gl = (this.gl = record(gc.gl, log, 'gl'));
    this.timer = new Gl2Timer(gc, log);
    log.phase = 'init';
    const shapes = named(gl.createBuffer(), 'shapes');
    gl.bindBuffer(gl.ARRAY_BUFFER, shapes);
    gl.bufferData(gl.ARRAY_BUFFER, SHAPES, gl.STATIC_DRAW);
    const idx = named(gl.createBuffer(), 'shape indices');
    this.opaqueBuf = named(gl.createBuffer(), 'opaque instances');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.opaqueBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 32 * INSTANCE_BYTES, gl.DYNAMIC_DRAW);
    this.particleBuf = named(gl.createBuffer(), 'particle instances');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuf);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_PARTICLES * INSTANCE_BYTES, gl.DYNAMIC_DRAW);
    // One vertex array per instance buffer: the shape per vertex, the card per instance (divisor 1).
    const vao = (label: string, inst: WebGLBuffer | null) => {
      const v = named(gl.createVertexArray(), label);
      gl.bindVertexArray(v);
      gl.bindBuffer(gl.ARRAY_BUFFER, shapes);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      for (const [loc, off] of [
        [1, 0],
        [2, 16],
      ]) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, INSTANCE_BYTES, off);
        gl.vertexAttribDivisor(loc, 1);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
      return v;
    };
    this.vaoOpaque = vao('opaque cards', this.opaqueBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, SHAPE_INDICES, gl.STATIC_DRAW);
    this.vaoParticles = vao('particles', this.particleBuf);
    gl.bindVertexArray(null);

    const ubo = (label: string, bytes: number) => {
      const b = named(gl.createBuffer(), label);
      gl.bindBuffer(gl.UNIFORM_BUFFER, b);
      gl.bufferData(gl.UNIFORM_BUFFER, bytes, gl.DYNAMIC_DRAW);
      return b;
    };
    this.frameUbo = ubo('frame constants', FRAME_BYTES);
    this.viewFull = ubo('view, full resolution', VIEW_BYTES);
    this.viewHalf = ubo('view, half resolution', VIEW_BYTES);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.frameUbo);

    const p = (label: string, vs: string, fs: string) => {
      const prog = glProgram(gl, label, vs, fs);
      for (const [block, binding] of [
        ['Frame', 0],
        ['View', 1],
      ] as const) {
        const i = gl.getUniformBlockIndex(prog, block);
        if (i !== gl.INVALID_INDEX) gl.uniformBlockBinding(prog, i, binding);
      }
      this.progs[label] = prog;
      return prog;
    };
    p('opaque', GLSL_CARDS_VS, GLSL_OPAQUE);
    p('count', GLSL_CARDS_VS, GLSL_COUNT);
    p('particles', GLSL_CARDS_VS, GLSL_SMOKE);
    gl.useProgram(p('downsample depth', GLSL_FULLSCREEN_VS, GLSL_DOWNSAMPLE));
    gl.uniform1i(gl.getUniformLocation(this.progs['downsample depth'], 'depthTex'), 0);
    gl.useProgram(p('composite', GLSL_FULLSCREEN_VS, GLSL_COMPOSITE));
    gl.uniform1i(gl.getUniformLocation(this.progs.composite, 'part'), 0);
    p('count composite', GLSL_FULLSCREEN_VS, GLSL_COUNT);
    for (const [label, heat] of [
      ['present', false],
      ['present heat', true],
    ] as const) {
      gl.useProgram(p(label, GLSL_FULLSCREEN_VS, glslPresent(heat)));
      gl.uniform1i(gl.getUniformLocation(this.progs[label], 'scene'), 0);
      gl.uniform1i(gl.getUniformLocation(this.progs[label], 'halfBuf'), 1);
    }

    // Targets: fixed sizes, made once. The scene's depth is a texture so the downsample can read it.
    const tex = (label: string, w: number, h: number, format: number, filter: number) => {
      const t = named(gl.createTexture(), label);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.texColor = tex('scene colour', FILL_W, FILL_H, gl.RGBA8, gl.LINEAR);
    this.texDepth = tex('scene depth', FILL_W, FILL_H, gl.DEPTH_COMPONENT24, gl.NEAREST);
    this.texPart = tex('particle buffer', FILL_W / 2, FILL_H / 2, gl.RGBA8, gl.NEAREST);
    this.fboScene = named(gl.createFramebuffer(), 'scene');
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboScene);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texColor, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.texDepth, 0);
    const halfDepth = named(gl.createRenderbuffer(), 'half-size depth');
    gl.bindRenderbuffer(gl.RENDERBUFFER, halfDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, FILL_W / 2, FILL_H / 2);
    this.fboHalf = named(gl.createFramebuffer(), 'particle buffer');
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboHalf);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texPart, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, halfDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  frame(s: FillSettings, view: FillView, c: FillColours): { plan: FramePlan; timed: boolean } {
    const gl = this.gl;
    const plan = fillPlan(s, view);
    const heat = view === 'heat';
    if (this.keys.opaque !== opaqueKey(s)) {
      this.log.phase = 'rebuild';
      gl.bindBuffer(gl.ARRAY_BUFFER, this.opaqueBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances(orderedOpaque(s.order)));
      this.keys.opaque = opaqueKey(s);
    }
    if (this.keys.particles !== particleKey(s)) {
      this.log.phase = 'rebuild';
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances(particleCards(s.size, s.shape, s.particles)));
      this.keys.particles = particleKey(s);
    }
    this.log.phase = 'frame';
    const cw = gl.drawingBufferWidth;
    const ch = gl.drawingBufferHeight;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, frameData(c, s.halfRes, cw, ch));
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.viewFull);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, viewData(false, s.cost));
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.viewHalf);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, viewData(true, s.cost));
    const timed = !!this.gc.timerExt && !!this.timer.onTimes;
    const cards = (vao: WebGLVertexArrayObject | null, d: FramePlan['passes'][number]['draws'][number] | undefined, program: string) => {
      if (!d) return;
      gl.useProgram(this.progs[program]);
      gl.bindVertexArray(vao);
      gl.drawElementsInstanced(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, d.count === OCTAGON_INDICES ? OCTAGON_FIRST * 2 : 0, d.instances);
    };
    for (const p of plan.passes) {
      this.timer.begin(gl);
      const d = p.draws[0];
      if (p.name === PASS.prepass) {
        // A depth-only pass: the same framebuffer with colour writes off.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboScene);
        gl.viewport(0, 0, FILL_W, FILL_H);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, this.viewFull);
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.depthMask(true);
        gl.colorMask(false, false, false, false);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        cards(this.vaoOpaque, d, 'count');
        gl.colorMask(true, true, true, true);
      } else if (p.name === PASS.opaque) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboScene);
        gl.viewport(0, 0, FILL_W, FILL_H);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, this.viewFull);
        gl.enable(gl.DEPTH_TEST);
        if (heat) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          gl.clearColor(0, 0, 0, 0);
        } else {
          gl.disable(gl.BLEND);
          gl.clearColor(c.bg[0] / 255, c.bg[1] / 255, c.bg[2] / 255, 1);
        }
        gl.depthFunc(s.prepass ? gl.EQUAL : gl.LESS);
        gl.depthMask(!s.prepass);
        gl.clear(s.prepass ? gl.COLOR_BUFFER_BIT : gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        cards(this.vaoOpaque, d, heat ? 'count' : 'opaque');
      } else if (p.name === PASS.downsample) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboHalf);
        gl.viewport(0, 0, FILL_W / 2, FILL_H / 2);
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.ALWAYS);
        gl.depthMask(true);
        gl.colorMask(false, false, false, false);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texDepth);
        gl.useProgram(this.progs['downsample depth']);
        gl.bindVertexArray(null);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.colorMask(true, true, true, true);
      } else if (p.name === PASS.particles) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, s.halfRes ? this.fboHalf : this.fboScene);
        gl.viewport(0, 0, s.halfRes ? FILL_W / 2 : FILL_W, s.halfRes ? FILL_H / 2 : FILL_H);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, s.halfRes ? this.viewHalf : this.viewFull);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        if (s.halfRes) {
          gl.clearColor(0, 0, 0, heat ? 0 : 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
        if (heat) gl.blendFunc(gl.ONE, gl.ONE);
        else if (s.halfRes) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
        else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        cards(this.vaoParticles, d, heat ? 'count' : 'particles');
        // Nothing reads this depth again: tell the driver it needn't keep it.
        gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
      } else if (p.name === PASS.composite) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboScene);
        gl.viewport(0, 0, FILL_W, FILL_H);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        if (heat) gl.blendFunc(gl.ONE, gl.ONE);
        else gl.blendFuncSeparate(gl.ONE, gl.SRC_ALPHA, gl.ONE, gl.ONE);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texPart);
        gl.useProgram(this.progs[heat ? 'count composite' : 'composite']);
        gl.bindVertexArray(null);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, cw, ch);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, this.viewFull);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texColor);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.texPart);
        gl.activeTexture(gl.TEXTURE0);
        gl.useProgram(this.progs[heat ? 'present heat' : 'present']);
        gl.bindVertexArray(null);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      this.timer.end(gl);
    }
    this.timer.submitted(gl);
    return { plan, timed };
  }

  dispose(): void {
    // The context is lost or released by disposeGpu; its objects go with it.
  }
}
