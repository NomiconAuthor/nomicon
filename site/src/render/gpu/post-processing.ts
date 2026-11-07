/**
 * "Post-processing": the courtyard at night through an HDR post chain, with WebGPU and WebGL2.
 * Both walk the same list of passes (scenes/post-processing.ts postPasses):
 *
 *   scene (HDR)   the courtyard into a half-float target, jittered when TAA is on, at the render scale
 *   TAA resolve   reproject last frame's history, clamp it to this frame's 3 × 3 neighbourhood, blend
 *   bloom down    five 13-tap downsamples (Jimenez 2014), the first from the HDR (or tone-mapped) frame
 *   bloom up      four 3 × 3 tent upsamples, each added to the level below
 *   tone map      bloom mixed in, exposure, the tone curve, sRGB, to the canvas
 *
 * Every post pass is a full-screen triangle reading named textures and writing one; the renderers
 * keep the textures by name and rebuild them when the canvas, the render scale or the chain changes.
 */
import { type Gl2Context, type GpuContext, type WebGpuContext } from './context';
import { type FramePlan } from './plan';
import { type CallLog, record } from './record';
import { type GpuTimer, Gl2Timer, WebGpuTimer } from './timing';
import { type GPUBuffer, type GPUCanvasContext, type GPUDevice, type GPUObject, type GPUTexture, ShaderStage, TextureUsage } from './webgpu';
import { GLSL_FULLSCREEN_VS, GLSL_SRGB, VERTEX_LAYOUT, WGSL_FULLSCREEN, WGSL_SRGB, bindBlocks, bindSamplers, compile, glFramebuffer, glMeshes, glTexture, gpuMeshBuffers, link, named, uniformBuffer } from './lighting';
import { type RGB, invert4 } from '../scenes/courtyard';
import {
  LAMP_COUNT,
  LAMP_GLOW,
  LAMP_INTENSITY,
  type PostPass,
  type PostSettings,
  TAA_ALPHA,
  WHITE,
  jitter,
  jitteredViewProj,
  moverOffset,
  postDraws,
  postLights,
  postPasses,
  postPlan,
  postViewProj,
} from '../scenes/post-processing';

export interface PostInput {
  /** Seconds, for the moving crate (frozen when paused). */
  t: number;
  /** Linear colours of the lamps. */
  colours: RGB[];
}
export interface PostRenderer {
  readonly backend: 'webgpu' | 'webgl2';
  readonly timer: GpuTimer;
  /** Why HDR targets are 8-bit here, if they are. */
  readonly ldrOnly: string | null;
  frame(s: PostSettings, input: PostInput): FramePlan;
  /** Forget the history (after a settings change that invalidates it). */
  reset(): void;
  dispose(): void;
}
export async function createPost(ctx: GpuContext, log: CallLog): Promise<PostRenderer> {
  return ctx.kind === 'webgpu' ? PostWebGpu.create(ctx, log) : new PostGl2(ctx, log);
}

/** Scene constants: jittered viewProj, params, 16 lights × 2 vec4: 592 bytes. Post constants: 208 bytes. */
export const SCENE_BYTES = 592;
export const POST_BYTES = 208;
const DRAW_BYTES = 48;
const TONE_INDEX = { clamp: 0, reinhard: 1, 'reinhard-ext': 2, aces: 3 } as const;

function sceneData(viewProj: Float32Array, colours: RGB[]): Float32Array {
  const d = new Float32Array(SCENE_BYTES / 4);
  d.set(viewProj, 0);
  d.set([LAMP_COUNT, LAMP_GLOW, 0.015, 0], 16);
  postLights().forEach((l, i) => d.set([l.pos.x, l.pos.y, l.pos.z, l.radius, colours[i][0], colours[i][1], colours[i][2], LAMP_INTENSITY], 20 + i * 8));
  return d;
}
function postData(s: PostSettings, rw: number, rh: number, w: number, h: number, reset: boolean): Float32Array {
  const d = new Float32Array(POST_BYTES / 4);
  const vp = postViewProj();
  d.set(invert4(vp), 0);
  d.set(vp, 16); // the camera doesn't move, so last frame's view-projection is this one's
  d.set([0, 0, TAA_ALPHA, s.taaSpace === 'tonemapped' ? 1 : 0], 32);
  d.set([rw, rh, w, h], 36);
  d.set([TONE_INDEX[s.tone], 2 ** s.ev, WHITE, s.strength], 40);
  d.set([s.taa ? 1 : 0, s.bloom ? 1 : 0, s.bloomOrder === 'ldr' ? 1 : 0, 0], 44);
  d.set([s.split ? 1 : 0, s.clamp ? 1 : 0, reset ? 1 : 0, 0], 48);
  return d;
}
function drawData(align: number): Float32Array {
  const draws = postDraws();
  const d = new Float32Array(((draws.length - 1) * align + DRAW_BYTES) / 4);
  draws.forEach((x, i) => d.set([...x.albedo, x.checker ? 1 : 0, x.emissive ? 1 : 0, x.moves ? 1 : 0, 0, 0], (i * align) / 4));
  return d;
}
const offsetData = (t: number) => {
  const o = moverOffset(t);
  return new Float32Array([o.x, o.y, o.z, 0]);
};

// ---------------------------------------------------------------------------------------------
// Shaders, written for both languages from one source where they agree

function toneCode(lang: 'wgsl' | 'glsl'): string {
  const w = lang === 'wgsl';
  const v3 = w ? 'vec3f' : 'vec3';
  const head = w ? 'fn tone(x: vec3f) -> vec3f' : 'vec3 tone(vec3 x)';
  const op = w ? 'i32(P.tone.x)' : 'int(tone_.x)';
  const white = w ? 'P.tone.z' : 'tone_.z';
  return `${head} {
  ${w ? 'let op =' : 'int op ='} ${op};
  if (op == 1) { return x / (1.0 + x); }
  if (op == 2) { return min(x * (1.0 + x / (${white} * ${white})) / (1.0 + x), ${v3}(1.0)); }
  if (op == 3) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), ${v3}(0.0), ${v3}(1.0)); }
  return clamp(x, ${v3}(0.0), ${v3}(1.0));
}`;
}

const WGSL_SCENE = /* wgsl */ `
struct Light { pos: vec4f, color: vec4f }
struct Scene {
  viewProj: mat4x4f,
  params: vec4f, // lights, lamp glow, ambient
  lights: array<Light, ${LAMP_COUNT}>,
}
struct Draw { albedo: vec4f, flags: vec4f, offset: vec4f }
@group(0) @binding(0) var<uniform> S: Scene;
@group(1) @binding(0) var<uniform> D: Draw;
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
}
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f) -> VOut {
  var o: VOut;
  o.world = p + select(vec3f(0.0), D.offset.xyz, D.flags.y > 0.5);
  o.pos = S.viewProj * vec4f(o.world, 1.0);
  o.normal = n;
  o.uv = uv;
  return o;
}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let odd = (i32(floor(v.uv.x)) + i32(floor(v.uv.y))) & 1;
  let a = D.albedo.rgb * select(1.0, 0.55, D.albedo.w > 0.5 && odd == 1);
  if (D.flags.x > 0.5) { return vec4f(a * S.params.y, 1.0); }
  let n = normalize(v.normal);
  var c = a * S.params.z;
  for (var i = 0; i < ${LAMP_COUNT}; i++) {
    let L = S.lights[i];
    let d = L.pos.xyz - v.world;
    let dist = length(d);
    let x = dist / L.pos.w;
    let win = clamp(1.0 - x * x * x * x, 0.0, 1.0);
    c += a * L.color.rgb * (L.color.w * win * win / (dist * dist + 1.0) * max(dot(n, d / dist), 0.0));
  }
  return vec4f(c, 1.0);
}
`;

const WGSL_POST_HEAD = /* wgsl */ `
struct Post {
  invViewProj: mat4x4f,
  prevViewProj: mat4x4f,
  taa: vec4f,    // -, -, alpha, resolve in tone-mapped space
  sizes: vec4f,  // render w, h, output w, h
  tone: vec4f,   // operator, exposure, white point, bloom strength
  flags: vec4f,  // taa, bloom, bloom after tone mapping
  misc: vec4f,   // split view, clamp history, reset history
}
@group(0) @binding(0) var<uniform> P: Post;
@group(0) @binding(1) var lin: sampler;
${WGSL_FULLSCREEN}
${WGSL_SRGB}
${toneCode('wgsl')}
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
`;

const WGSL_TAA = /* wgsl */ `
${WGSL_POST_HEAD}
@group(1) @binding(0) var cur: texture_2d<f32>;
@group(1) @binding(1) var hist: texture_2d<f32>;
@group(1) @binding(2) var depth: texture_depth_2d;
fn into(c: vec3f) -> vec3f { return select(c, c / (1.0 + luma(c)), P.taa.w > 0.5); }
fn outof(c: vec3f) -> vec3f { return select(c, c / max(1.0 - luma(c), 1e-4), P.taa.w > 0.5); }
@fragment fn fs(v: FsOut) -> @location(0) vec4f {
  let rt = 1.0 / P.sizes.xy;
  let c = into(textureSampleLevel(cur, lin, v.uv, 0.0).rgb);
  // Where was this surface last frame? Rebuild its position from depth, project with last frame's matrix.
  let d = textureLoad(depth, vec2i(min(v.uv * P.sizes.xy, P.sizes.xy - 1.0)), 0);
  let wp = P.invViewProj * vec4f(v.uv.x * 2.0 - 1.0, 1.0 - v.uv.y * 2.0, d, 1.0);
  let pc = P.prevViewProj * vec4f(wp.xyz / wp.w, 1.0);
  let puv = vec2f(pc.x / pc.w * 0.5 + 0.5, 0.5 - pc.y / pc.w * 0.5);
  var h = into(textureSampleLevel(hist, lin, puv, 0.0).rgb);
  if (P.misc.y > 0.5) {
    // Clamp the history to the range of colours around this pixel now: stale colours can't survive.
    var lo = c;
    var hi = c;
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let s = into(textureSampleLevel(cur, lin, v.uv + vec2f(f32(i), f32(j)) * rt, 0.0).rgb);
        lo = min(lo, s);
        hi = max(hi, s);
      }
    }
    h = clamp(h, lo, hi);
  }
  let fresh = P.misc.z > 0.5 || any(puv < vec2f(0.0)) || any(puv > vec2f(1.0));
  return vec4f(outof(select(mix(h, c, P.taa.z), c, fresh)), 1.0);
}
`;

const WGSL_DOWN = /* wgsl */ `
${WGSL_POST_HEAD}
@group(1) @binding(0) var src: texture_2d<f32>;
fn tap(uv: vec2f, first: bool) -> vec3f {
  let c = textureSampleLevel(src, lin, uv, 0.0).rgb;
  // Bloom after tone mapping: blur the tone-mapped image instead of the HDR one.
  return select(c, tone(c * P.tone.y), first && P.flags.z > 0.5);
}
// Jimenez's 13 taps: a 4 × 4-texel box made of five overlapping 2 × 2 boxes, weighted.
fn down13(uv: vec2f, first: bool) -> vec3f {
  let t = 1.0 / vec2f(textureDimensions(src));
  let a = tap(uv + t * vec2f(-2.0, -2.0), first); let b = tap(uv + t * vec2f(0.0, -2.0), first); let c = tap(uv + t * vec2f(2.0, -2.0), first);
  let d = tap(uv + t * vec2f(-2.0, 0.0), first); let e = tap(uv, first); let f = tap(uv + t * vec2f(2.0, 0.0), first);
  let g = tap(uv + t * vec2f(-2.0, 2.0), first); let h = tap(uv + t * vec2f(0.0, 2.0), first); let i = tap(uv + t * vec2f(2.0, 2.0), first);
  let j = tap(uv + t * vec2f(-1.0, -1.0), first); let k = tap(uv + t * vec2f(1.0, -1.0), first);
  let l = tap(uv + t * vec2f(-1.0, 1.0), first); let m = tap(uv + t * vec2f(1.0, 1.0), first);
  return e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
}
@fragment fn fs_first(v: FsOut) -> @location(0) vec4f { return vec4f(down13(v.uv, true), 1.0); }
@fragment fn fs(v: FsOut) -> @location(0) vec4f { return vec4f(down13(v.uv, false), 1.0); }
`;

const WGSL_UP = /* wgsl */ `
${WGSL_POST_HEAD}
@group(1) @binding(0) var small: texture_2d<f32>;
@group(1) @binding(1) var level: texture_2d<f32>;
// A 3 × 3 tent (1 2 1 / 2 4 2 / 1 2 1, over 16) on the smaller level, added to this level's downsample.
@fragment fn fs(v: FsOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(small));
  var s = textureSampleLevel(small, lin, v.uv, 0.0).rgb * 4.0;
  s += (textureSampleLevel(small, lin, v.uv + vec2f(t.x, 0.0), 0.0).rgb + textureSampleLevel(small, lin, v.uv - vec2f(t.x, 0.0), 0.0).rgb + textureSampleLevel(small, lin, v.uv + vec2f(0.0, t.y), 0.0).rgb + textureSampleLevel(small, lin, v.uv - vec2f(0.0, t.y), 0.0).rgb) * 2.0;
  s += textureSampleLevel(small, lin, v.uv + t, 0.0).rgb + textureSampleLevel(small, lin, v.uv - t, 0.0).rgb + textureSampleLevel(small, lin, v.uv + vec2f(t.x, -t.y), 0.0).rgb + textureSampleLevel(small, lin, v.uv + vec2f(-t.x, t.y), 0.0).rgb;
  return vec4f(textureSampleLevel(level, lin, v.uv, 0.0).rgb + s / 16.0, 1.0);
}
`;

const WGSL_COMPOSITE = /* wgsl */ `
${WGSL_POST_HEAD}
@group(1) @binding(0) var src: texture_2d<f32>;
@group(1) @binding(1) var bloom: texture_2d<f32>;
@group(1) @binding(2) var raw: texture_2d<f32>;
@fragment fn fs(v: FsOut) -> @location(0) vec4f {
  var c = textureSampleLevel(src, lin, v.uv, 0.0).rgb;
  let b = textureSampleLevel(bloom, lin, v.uv, 0.0).rgb;
  let on = P.flags.y > 0.5;
  if (on && P.flags.z < 0.5) { c = mix(c, b, P.tone.w); }
  var t = tone(c * P.tone.y);
  if (on && P.flags.z > 0.5) { t = mix(t, b, P.tone.w); }
  if (P.misc.x > 0.5) {
    // Split view: the left half is the scene as drawn, exposed and clamped, with no post-processing.
    if (v.uv.x < 0.5) { t = clamp(textureSampleLevel(raw, lin, v.uv, 0.0).rgb * P.tone.y, vec3f(0.0), vec3f(1.0)); }
    if (abs(v.uv.x - 0.5) * P.sizes.z < 1.0) { return vec4f(1.0); }
  }
  return vec4f(to_srgb(t), 1.0);
}
`;

const HDR = 'rgba16float';

interface Tex {
  tex: GPUTexture;
  view: GPUObject;
  w: number;
  h: number;
}

class PostWebGpu implements PostRenderer {
  readonly backend = 'webgpu';
  readonly timer: WebGpuTimer;
  readonly ldrOnly = null;
  private dev: GPUDevice;
  private canvasCtx: GPUCanvasContext;
  private draws = postDraws();
  private meshes: Array<{ vb: GPUBuffer; ib: GPUBuffer; count: number }> = [];
  private sceneUbo!: GPUBuffer;
  private postUbo!: GPUBuffer;
  private drawUbo!: GPUBuffer;
  private align: number;
  private sceneGroup!: GPUObject;
  private postGroup!: GPUObject;
  private drawGroups: GPUObject[] = [];
  private layouts: Record<string, GPUObject> = {};
  private pipelines = new Map<string, GPUObject>();
  private texKey = '';
  private texs = new Map<string, Tex>();
  private groups = new Map<string, GPUObject>();
  private n = 0;
  private fresh = true;

  private constructor(
    private gc: WebGpuContext,
    private log: CallLog,
  ) {
    this.dev = record(gc.device, log, 'device');
    this.canvasCtx = record(gc.context, log, 'context');
    this.align = Math.max(256, gc.device.limits.minUniformBufferOffsetAlignment ?? 256);
    this.timer = new WebGpuTimer(gc, log, 3);
  }
  static async create(gc: WebGpuContext, log: CallLog): Promise<PostWebGpu> {
    const r = new PostWebGpu(gc, log);
    await r.init();
    return r;
  }

  private async init(): Promise<void> {
    const dev = this.dev;
    this.log.phase = 'init';
    this.gc.device.pushErrorScope('validation');
    this.meshes = gpuMeshBuffers(dev, this.draws.map((d) => d.mesh));
    this.sceneUbo = uniformBuffer(dev, 'scene constants', SCENE_BYTES);
    this.postUbo = uniformBuffer(dev, 'post constants', POST_BYTES);
    this.drawUbo = uniformBuffer(dev, 'draw constants', (this.draws.length - 1) * this.align + DRAW_BYTES);
    dev.queue.writeBuffer(this.drawUbo, 0, drawData(this.align));
    const F = ShaderStage.FRAGMENT;
    const tex = (binding: number, sampleType = 'float') => ({ binding, visibility: F, texture: { sampleType } });
    this.layouts = {
      scene: dev.createBindGroupLayout({ label: 'scene', entries: [{ binding: 0, visibility: ShaderStage.VERTEX | F, buffer: { type: 'uniform' } }] }),
      draw: dev.createBindGroupLayout({ label: 'per draw', entries: [{ binding: 0, visibility: ShaderStage.VERTEX | F, buffer: { type: 'uniform' } }] }),
      post: dev.createBindGroupLayout({ label: 'post', entries: [{ binding: 0, visibility: F, buffer: { type: 'uniform' } }, { binding: 1, visibility: F, sampler: { type: 'filtering' } }] }),
      one: dev.createBindGroupLayout({ label: 'one texture', entries: [tex(0)] }),
      two: dev.createBindGroupLayout({ label: 'two textures', entries: [tex(0), tex(1)] }),
      three: dev.createBindGroupLayout({ label: 'three textures', entries: [tex(0), tex(1), tex(2)] }),
      taa: dev.createBindGroupLayout({ label: 'TAA inputs', entries: [tex(0), tex(1), tex(2, 'depth')] }),
    };
    const pl = (label: string, second: string) => dev.createPipelineLayout({ label, bindGroupLayouts: [this.layouts.post, this.layouts[second]] });
    const mod = (label: string, code: string) => dev.createShaderModule({ label, code });
    const sceneMod = mod('scene shaders', WGSL_SCENE);
    const full = (label: string, module: GPUObject, entryPoint: string, layout: GPUObject, format = HDR) =>
      dev.createRenderPipelineAsync({
        label,
        layout,
        vertex: { module: module as never, entryPoint: 'vs_full' },
        fragment: { module: module as never, entryPoint, targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      });
    const down = mod('bloom downsample', WGSL_DOWN);
    const jobs: Array<[string, Promise<GPUObject>]> = [
      [
        'scene',
        dev.createRenderPipelineAsync({
          label: 'scene',
          layout: dev.createPipelineLayout({ label: 'scene', bindGroupLayouts: [this.layouts.scene, this.layouts.draw] }),
          vertex: { module: sceneMod, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] },
          fragment: { module: sceneMod, entryPoint: 'fs', targets: [{ format: HDR }] },
          primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
          depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        }),
      ],
      ['taa', full('taa', mod('TAA resolve', WGSL_TAA), 'fs', pl('taa', 'taa'))],
      ['down-first', full('down-first', down, 'fs_first', pl('down', 'one'))],
      ['down', full('down', down, 'fs', pl('down', 'one'))],
      ['up', full('up', mod('bloom upsample', WGSL_UP), 'fs', pl('up', 'two'))],
      ['composite', full('composite', mod('tone map', WGSL_COMPOSITE), 'fs', pl('composite', 'three'), this.gc.format)],
    ];
    const done = await Promise.all(jobs.map((j) => j[1]));
    jobs.forEach(([k], i) => this.pipelines.set(k, done[i]));
    this.sceneGroup = dev.createBindGroup({ label: 'scene', layout: this.layouts.scene, entries: [{ binding: 0, resource: { buffer: this.sceneUbo } }] });
    const sampler = dev.createSampler({ label: 'bilinear, clamped', magFilter: 'linear', minFilter: 'linear' });
    this.postGroup = dev.createBindGroup({ label: 'post', layout: this.layouts.post, entries: [{ binding: 0, resource: { buffer: this.postUbo } }, { binding: 1, resource: sampler }] });
    this.drawGroups = this.draws.map((d, i) => dev.createBindGroup({ label: d.name, layout: this.layouts.draw, entries: [{ binding: 0, resource: { buffer: this.drawUbo, offset: i * this.align, size: DRAW_BYTES } }] }));
    const err = await this.gc.device.popErrorScope();
    if (err) console.error('WebGPU init:', err.message);
  }

  /** Every target the passes name, at their sizes; rebuilt when they change. */
  private targets(passes: PostPass[]): void {
    const key = passes.map((p) => `${p.output}:${p.w}x${p.h}`).join(',');
    if (key === this.texKey) return;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    for (const t of this.texs.values()) t.tex.destroy();
    this.texs.clear();
    this.groups.clear();
    const make = (name: string, w: number, h: number, format: string) => {
      const tex = this.dev.createTexture({ label: name, size: [w, h], format, usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
      this.texs.set(name, { tex, view: tex.createView(), w, h });
    };
    for (const p of passes) {
      if (p.output === 'canvas') continue;
      if (p.output === 'history-next') {
        make('history 0', p.w, p.h, HDR);
        make('history 1', p.w, p.h, HDR);
      } else make(p.output, p.w, p.h, HDR);
      if (p.pipeline === 'scene') make('depth', p.w, p.h, 'depth24plus');
    }
    this.texKey = key;
    this.fresh = true;
    this.log.phase = prev;
  }

  /** A name as this frame sees it: the two history textures swap roles every frame. */
  private tex(name: string): Tex {
    const real = name === 'history' ? `history ${this.n % 2}` : name === 'history-next' ? `history ${(this.n + 1) % 2}` : name;
    return this.texs.get(real)!;
  }

  private group(p: PostPass): GPUObject {
    const names = p.inputs.map((i) => (i === 'history' ? `history ${this.n % 2}` : i === 'history-next' ? `history ${(this.n + 1) % 2}` : i));
    const key = `${p.pipeline}|${names.join(',')}`;
    let g = this.groups.get(key);
    if (!g) {
      const layout = p.pipeline === 'taa' ? this.layouts.taa : p.pipeline === 'up' ? this.layouts.two : p.pipeline === 'composite' ? this.layouts.three : this.layouts.one;
      g = this.dev.createBindGroup({ label: p.name, layout, entries: p.inputs.map((i, b) => ({ binding: b, resource: this.tex(i).view })) });
      this.groups.set(key, g);
    }
    return g;
  }

  reset(): void {
    this.fresh = true;
  }

  frame(s: PostSettings, input: PostInput): FramePlan {
    const w = this.gc.canvas.width;
    const h = this.gc.canvas.height;
    const passes = postPasses(s, w, h);
    const plan = postPlan(s, w, h);
    this.targets(passes);
    const dev = this.dev;
    this.log.phase = 'frame';
    const scene = passes[0];
    const [jx, jy] = s.taa ? jitter(this.n) : [0, 0];
    dev.queue.writeBuffer(this.sceneUbo, 0, sceneData(jitteredViewProj(jx, jy, scene.w, scene.h), input.colours));
    dev.queue.writeBuffer(this.drawUbo, (this.draws.length - 1) * this.align + 32, offsetData(input.t));
    dev.queue.writeBuffer(this.postUbo, 0, postData(s, scene.w, scene.h, w, h, this.fresh));
    const enc = dev.createCommandEncoder({ label: 'frame' });
    passes.forEach((p, pi) => {
      const out = p.output === 'canvas' ? this.canvasCtx.getCurrentTexture().createView() : this.tex(p.output).view;
      // Time three passes: the scene, the TAA resolve (or the first bloom pass) and the tone map.
      const ti = pi === 0 ? 0 : pi === passes.length - 1 ? 2 : pi === 1 ? 1 : -1;
      const pass = enc.beginRenderPass({
        label: p.name,
        colorAttachments: [{ view: out, clearValue: { r: 0.006, g: 0.007, b: 0.012, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: p.pipeline === 'scene' ? { view: this.tex('depth').view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } : undefined,
        timestampWrites: ti >= 0 ? this.timer.writes(ti) : undefined,
      });
      pass.setPipeline(this.pipelines.get(p.pipeline)!);
      if (p.pipeline === 'scene') {
        pass.setBindGroup(0, this.sceneGroup);
        plan.passes[pi].draws.forEach((d, i) => {
          pass.setBindGroup(1, this.drawGroups[i]);
          pass.setVertexBuffer(0, this.meshes[i].vb);
          pass.setIndexBuffer(this.meshes[i].ib, 'uint16');
          pass.drawIndexed(d.count, d.instances, 0, 0, 0);
        });
      } else {
        pass.setBindGroup(0, this.postGroup);
        pass.setBindGroup(1, this.group(p));
        pass.draw(3, 1, 0, 0);
      }
      pass.end();
    });
    this.timer.resolve(enc);
    dev.queue.submit([enc.finish({ label: 'frame' })]);
    this.timer.submitted();
    if (s.taa) this.n++;
    this.fresh = false;
    return plan;
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.vb.destroy();
      m.ib.destroy();
    }
    for (const b of [this.sceneUbo, this.postUbo, this.drawUbo]) b?.destroy();
    for (const t of this.texs.values()) t.tex.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// WebGL2

const GLSL_SCENE_VS = `#version 300 es
struct Light { vec4 pos; vec4 color; };
layout(std140) uniform Scene { mat4 viewProj; vec4 params; Light lights[${LAMP_COUNT}]; };
layout(std140) uniform Draw { vec4 albedo; vec4 flags; vec4 offset; };
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vWorld = position + (flags.y > 0.5 ? offset.xyz : vec3(0.0));
  vec4 c = viewProj * vec4(vWorld, 1.0);
  gl_Position = vec4(c.xy, 2.0 * c.z - c.w, c.w);
  vNormal = normal;
  vUv = uv;
}`;
const GLSL_SCENE_FS = `#version 300 es
precision highp float;
struct Light { vec4 pos; vec4 color; };
layout(std140) uniform Scene { mat4 viewProj; vec4 params; Light lights[${LAMP_COUNT}]; };
layout(std140) uniform Draw { vec4 albedo; vec4 flags; vec4 offset; };
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
out vec4 outColor;
void main() {
  int odd = (int(floor(vUv.x)) + int(floor(vUv.y))) & 1;
  vec3 a = albedo.rgb * ((albedo.w > 0.5 && odd == 1) ? 0.55 : 1.0);
  if (flags.x > 0.5) { outColor = vec4(a * params.y, 1.0); return; }
  vec3 n = normalize(vNormal);
  vec3 c = a * params.z;
  for (int i = 0; i < ${LAMP_COUNT}; i++) {
    Light L = lights[i];
    vec3 d = L.pos.xyz - vWorld;
    float dist = length(d);
    float x = dist / L.pos.w;
    float win = clamp(1.0 - x * x * x * x, 0.0, 1.0);
    c += a * L.color.rgb * (L.color.w * win * win / (dist * dist + 1.0) * max(dot(n, d / dist), 0.0));
  }
  outColor = vec4(c, 1.0);
}`;

// The post uniform block's members are named so they don't clash with the tone() function.
const GLSL_POST_HEAD = `#version 300 es
precision highp float;
layout(std140) uniform Post { mat4 invViewProj; mat4 prevViewProj; vec4 taa; vec4 sizes; vec4 tone_; vec4 flags; vec4 misc; };
${GLSL_SRGB}
${toneCode('glsl')}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
in vec2 vUv;
out vec4 outColor;
`;

const GLSL_TAA = `${GLSL_POST_HEAD}
uniform sampler2D tex0;
uniform sampler2D tex1;
uniform highp sampler2D depthTex;
vec3 into(vec3 c) { return taa.w > 0.5 ? c / (1.0 + luma(c)) : c; }
vec3 outof(vec3 c) { return taa.w > 0.5 ? c / max(1.0 - luma(c), 1e-4) : c; }
void main() {
  vec2 rt = 1.0 / sizes.xy;
  vec3 c = into(textureLod(tex0, vUv, 0.0).rgb);
  float d = texelFetch(depthTex, ivec2(min(vUv * sizes.xy, sizes.xy - 1.0)), 0).r;
  vec4 wp = invViewProj * vec4(vUv * 2.0 - 1.0, d, 1.0); // GL's uv runs bottom to top, like clip y
  vec4 pc = prevViewProj * vec4(wp.xyz / wp.w, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  vec3 h = into(textureLod(tex1, puv, 0.0).rgb);
  if (misc.y > 0.5) {
    vec3 lo = c;
    vec3 hi = c;
    for (int j = -1; j <= 1; j++)
      for (int i = -1; i <= 1; i++) {
        vec3 s = into(textureLod(tex0, vUv + vec2(float(i), float(j)) * rt, 0.0).rgb);
        lo = min(lo, s);
        hi = max(hi, s);
      }
    h = clamp(h, lo, hi);
  }
  bool fresh = misc.z > 0.5 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)));
  outColor = vec4(outof(fresh ? c : mix(h, c, taa.z)), 1.0);
}`;

const glslDown = (first: boolean) => `${GLSL_POST_HEAD}
uniform sampler2D tex0;
vec3 tap(vec2 uv) {
  vec3 c = textureLod(tex0, uv, 0.0).rgb;
  ${first ? 'if (flags.z > 0.5) c = tone(c * tone_.y);' : ''}
  return c;
}
void main() {
  vec2 t = 1.0 / vec2(textureSize(tex0, 0));
  vec2 uv = vUv;
  vec3 a = tap(uv + t * vec2(-2.0, -2.0)), b = tap(uv + t * vec2(0.0, -2.0)), c = tap(uv + t * vec2(2.0, -2.0));
  vec3 d = tap(uv + t * vec2(-2.0, 0.0)), e = tap(uv), f = tap(uv + t * vec2(2.0, 0.0));
  vec3 g = tap(uv + t * vec2(-2.0, 2.0)), h = tap(uv + t * vec2(0.0, 2.0)), i = tap(uv + t * vec2(2.0, 2.0));
  vec3 j = tap(uv + t * vec2(-1.0, -1.0)), k = tap(uv + t * vec2(1.0, -1.0)), l = tap(uv + t * vec2(-1.0, 1.0)), m = tap(uv + t * vec2(1.0, 1.0));
  outColor = vec4(e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125, 1.0);
}`;

const GLSL_UP = `${GLSL_POST_HEAD}
uniform sampler2D tex0;
uniform sampler2D tex1;
void main() {
  vec2 t = 1.0 / vec2(textureSize(tex0, 0));
  vec3 s = textureLod(tex0, vUv, 0.0).rgb * 4.0;
  s += (textureLod(tex0, vUv + vec2(t.x, 0.0), 0.0).rgb + textureLod(tex0, vUv - vec2(t.x, 0.0), 0.0).rgb + textureLod(tex0, vUv + vec2(0.0, t.y), 0.0).rgb + textureLod(tex0, vUv - vec2(0.0, t.y), 0.0).rgb) * 2.0;
  s += textureLod(tex0, vUv + t, 0.0).rgb + textureLod(tex0, vUv - t, 0.0).rgb + textureLod(tex0, vUv + vec2(t.x, -t.y), 0.0).rgb + textureLod(tex0, vUv + vec2(-t.x, t.y), 0.0).rgb;
  outColor = vec4(textureLod(tex1, vUv, 0.0).rgb + s / 16.0, 1.0);
}`;

const GLSL_COMPOSITE = `${GLSL_POST_HEAD}
uniform sampler2D tex0;
uniform sampler2D tex1;
uniform sampler2D tex2;
void main() {
  vec3 c = textureLod(tex0, vUv, 0.0).rgb;
  vec3 b = textureLod(tex1, vUv, 0.0).rgb;
  bool on = flags.y > 0.5;
  if (on && flags.z < 0.5) c = mix(c, b, tone_.w);
  vec3 t = tone(c * tone_.y);
  if (on && flags.z > 0.5) t = mix(t, b, tone_.w);
  if (misc.x > 0.5) {
    if (vUv.x < 0.5) t = clamp(textureLod(tex2, vUv, 0.0).rgb * tone_.y, 0.0, 1.0);
    if (abs(vUv.x - 0.5) * sizes.z < 1.0) { outColor = vec4(1.0); return; }
  }
  outColor = vec4(to_srgb(t), 1.0);
}`;

class PostGl2 implements PostRenderer {
  readonly backend = 'webgl2';
  readonly timer: Gl2Timer;
  readonly ldrOnly: string | null;
  private gl: WebGL2RenderingContext;
  private draws = postDraws();
  private meshes: Array<{ vao: WebGLVertexArrayObject | null; count: number }>;
  private sceneUbo: WebGLBuffer | null;
  private postUbo: WebGLBuffer | null;
  private drawUbo: WebGLBuffer | null;
  private align: number;
  private hdr: number;
  private programs = new Map<string, WebGLProgram>();
  private texKey = '';
  private texs = new Map<string, { tex: WebGLTexture | null; fbo: WebGLFramebuffer | null; w: number; h: number }>();
  private n = 0;
  private fresh = true;

  constructor(
    private gc: Gl2Context,
    private log: CallLog,
  ) {
    const gl = (this.gl = record(gc.gl, log, 'gl'));
    this.timer = new Gl2Timer(gc, log);
    log.phase = 'init';
    // Rendering to half floats needs EXT_color_buffer_float, or EXT_color_buffer_half_float, in
    // WebGL2 (sampling them doesn't).
    const float = gl.getExtension('EXT_color_buffer_float') ?? gl.getExtension('EXT_color_buffer_half_float');
    this.hdr = float ? gl.RGBA16F : gl.RGBA8;
    this.ldrOnly = float ? null : "this browser's WebGL2 can't render to half-float targets (neither EXT_color_buffer_float nor EXT_color_buffer_half_float), so the HDR targets are 8-bit and clip at 1";
    this.meshes = glMeshes(gl, this.draws.map((d) => d.mesh));
    this.align = Math.max(16, Number(gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT)) || 256);
    const ubo = (label: string, size: number, point: number) => {
      const b = named(gl.createBuffer(), label);
      gl.bindBuffer(gl.UNIFORM_BUFFER, b);
      gl.bufferData(gl.UNIFORM_BUFFER, size, gl.DYNAMIC_DRAW);
      if (point >= 0) gl.bindBufferBase(gl.UNIFORM_BUFFER, point, b);
      return b;
    };
    this.sceneUbo = ubo('scene constants', SCENE_BYTES, 0);
    this.postUbo = ubo('post constants', POST_BYTES, 2);
    this.drawUbo = ubo('draw constants', (this.draws.length - 1) * this.align + DRAW_BYTES, -1);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, drawData(this.align));
    const fsVs = compile(gl, gl.VERTEX_SHADER, GLSL_FULLSCREEN_VS);
    const prog = (key: string, vs: WebGLShader, fs: string) => this.programs.set(key, link(gl, key, vs, compile(gl, gl.FRAGMENT_SHADER, fs)));
    prog('scene', compile(gl, gl.VERTEX_SHADER, GLSL_SCENE_VS), GLSL_SCENE_FS);
    prog('taa', fsVs, GLSL_TAA);
    prog('down-first', fsVs, glslDown(true));
    prog('down', fsVs, glslDown(false));
    prog('up', fsVs, GLSL_UP);
    prog('composite', fsVs, GLSL_COMPOSITE);
    const all = [...this.programs.values()];
    bindBlocks(gl, all, { Scene: 0, Draw: 1, Post: 2 });
    bindSamplers(gl, all, { tex0: 0, tex1: 1, tex2: 2, depthTex: 3 });
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.depthFunc(gl.LESS);
  }

  private targets(passes: PostPass[]): void {
    const key = passes.map((p) => `${p.output}:${p.w}x${p.h}`).join(',');
    if (key === this.texKey) return;
    const gl = this.gl;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    for (const t of this.texs.values()) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.texs.clear();
    gl.activeTexture(gl.TEXTURE0 + 4);
    const make = (name: string, w: number, h: number, depth: WebGLTexture | null = null) => {
      const tex = glTexture(gl, name, this.hdr, w, h, 'linear');
      this.texs.set(name, { tex, fbo: glFramebuffer(gl, name, [tex], depth), w, h });
    };
    for (const p of passes) {
      if (p.output === 'canvas') continue;
      if (p.pipeline === 'scene') {
        const depth = glTexture(gl, 'depth', gl.DEPTH_COMPONENT24, p.w, p.h);
        this.texs.set('depth', { tex: depth, fbo: null, w: p.w, h: p.h });
        make(p.output, p.w, p.h, depth);
      } else if (p.output === 'history-next') {
        make('history 0', p.w, p.h);
        make('history 1', p.w, p.h);
      } else make(p.output, p.w, p.h);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.texKey = key;
    this.fresh = true;
    this.log.phase = prev;
  }

  private tex(name: string) {
    const real = name === 'history' ? `history ${this.n % 2}` : name === 'history-next' ? `history ${(this.n + 1) % 2}` : name;
    return this.texs.get(real)!;
  }

  reset(): void {
    this.fresh = true;
  }

  frame(s: PostSettings, input: PostInput): FramePlan {
    const gl = this.gl;
    const w = this.gc.canvas.width;
    const h = this.gc.canvas.height;
    const passes = postPasses(s, w, h);
    const plan = postPlan(s, w, h);
    this.targets(passes);
    this.log.phase = 'frame';
    const scene = passes[0];
    const [jx, jy] = s.taa ? jitter(this.n) : [0, 0];
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.sceneUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, sceneData(jitteredViewProj(jx, jy, scene.w, scene.h), input.colours));
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.drawUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, (this.draws.length - 1) * this.align + 32, offsetData(input.t));
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.postUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, postData(s, scene.w, scene.h, w, h, this.fresh));
    passes.forEach((p, pi) => {
      const timed = pi === 0 || pi === 1 || pi === passes.length - 1;
      if (timed) this.timer.begin(gl);
      gl.bindFramebuffer(gl.FRAMEBUFFER, p.output === 'canvas' ? null : this.tex(p.output).fbo);
      gl.viewport(0, 0, p.output === 'canvas' ? w : p.w, p.output === 'canvas' ? h : p.h);
      gl.useProgram(this.programs.get(p.pipeline)!);
      if (p.pipeline === 'scene') {
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);
        gl.clearColor(0.006, 0.007, 0.012, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        plan.passes[pi].draws.forEach((d, i) => {
          gl.bindBufferRange(gl.UNIFORM_BUFFER, 1, this.drawUbo, i * this.align, DRAW_BYTES);
          gl.bindVertexArray(this.meshes[i].vao);
          gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, 0);
        });
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
      } else {
        // Inputs on units 0, 1, 2; the depth texture (TAA only) on unit 3.
        p.inputs.forEach((name, u) => {
          gl.activeTexture(gl.TEXTURE0 + (name === 'depth' ? 3 : u));
          gl.bindTexture(gl.TEXTURE_2D, this.tex(name).tex);
        });
        gl.bindVertexArray(null);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      if (timed) this.timer.end(gl);
    });
    this.timer.submitted(gl);
    if (s.taa) this.n++;
    this.fresh = false;
    return plan;
  }

  dispose(): void {}
}
