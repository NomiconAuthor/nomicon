/**
 * "Timing the GPU": a frame of adjustable cost, drawn with WebGPU or WebGL2 (the plan is in
 * scenes/timing-the-gpu.ts), timed three ways at once:
 *
 *   cpu    performance.now() around recording and submitting the frame: what a naive CPU timer
 *          sees. The calls return as soon as the commands are queued.
 *   done   performance.now() from the start of the frame until the CPU learns the GPU finished:
 *          WebGPU's queue.onSubmittedWorkDone(), or on WebGL2 a 1 × 1 readPixels, which makes the
 *          CPU wait right there (that stall is part of what this lesson shows).
 *   gpu    timestamp queries around each pass (timing.ts), read back a frame or more later.
 */
import { type Gl2Context, type GpuContext, type WebGpuContext } from './context';
import { BLEND, GLSL_FULLSCREEN_VS, glProgram, named, target } from './perf-common';
import { type FramePlan } from './plan';
import { type CallLog, record } from './record';
import { Gl2Timer, type GpuTimer, WebGpuTimer } from './timing';
import { BufferUsage, type GPUBuffer, type GPUCanvasContext, type GPUDevice, type GPUObject, ShaderStage, TextureUsage } from './webgpu';
import { TIME_H, TIME_W, type TimingSettings, timingPlan } from '../scenes/timing-the-gpu';

export interface TimingResult {
  plan: FramePlan;
  timed: boolean;
  /** ms spent in the calls that record and submit the frame. */
  cpu: number;
  /** Resolves with ms from the start of the frame until the CPU knew the GPU had finished it. */
  done: Promise<number | null>;
}
export interface TimingRenderer {
  readonly backend: 'webgpu' | 'webgl2';
  readonly timer: GpuTimer;
  frame(s: TimingSettings, tint: [number, number, number]): TimingResult;
  dispose(): void;
}

export async function createTiming(ctx: GpuContext, log: CallLog): Promise<TimingRenderer> {
  return ctx.kind === 'webgpu' ? TimingWebGpu.create(ctx, log) : new TimingGl2(ctx, log);
}

/** Uniforms: (iterations, layers, canvas width, canvas height), tint. */
const UBO_BYTES = 32;
const ubo = (s: TimingSettings, cw: number, ch: number, tint: [number, number, number]) => new Float32Array([s.iterations, s.layers, cw, ch, tint[0] / 255, tint[1] / 255, tint[2] / 255, 1]);

const WGSL = /* wgsl */ `
fn full(i: u32) -> vec4f {
  let t = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(t.x * 2.0 - 1.0, 1.0 - t.y * 2.0, 0.0, 1.0);
}
@vertex fn vs_full(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return full(i);
}
struct U { k: vec4f, tint: vec4f }  // iterations, layers, canvas size; tint
@group(0) @binding(0) var<uniform> u: U;
struct VOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) layer: f32 }
@vertex fn vs_layer(@builtin(vertex_index) i: u32, @builtin(instance_index) l: u32) -> VOut {
  var o: VOut;
  o.pos = full(i);
  o.layer = f32(l);
  return o;
}
// The work: a loop whose result changes the pixel slightly, so it can't be optimised away.
@fragment fn fs_work(v: VOut) -> @location(0) vec4f {
  var p = v.pos.xy * 0.01 + vec2f(v.layer * 1.3, 0.0);
  var n = 0.0;
  for (var i = 0; i < i32(u.k.x); i++) {
    p = vec2f(p.x * 0.8 - p.y * 0.6, p.x * 0.6 + p.y * 0.8) + vec2f(0.37, 0.71);
    n += sin(p.x * 1.7 + cos(p.y * 2.3));
  }
  let b = (0.6 + 0.4 * sin(n * 0.5)) / u.k.y;
  return vec4f(u.tint.rgb * b, 1.0 / u.k.y);
}
@group(1) @binding(0) var src: texture_2d<f32>;
@fragment fn fs_present(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return textureLoad(src, vec2i(p.xy / u.k.zw * vec2f(${TIME_W}.0, ${TIME_H}.0)), 0);
}
`;

class TimingWebGpu implements TimingRenderer {
  readonly backend = 'webgpu';
  readonly timer: WebGpuTimer;
  private dev: GPUDevice;
  private canvasCtx: GPUCanvasContext;
  private ubo!: GPUBuffer;
  private group!: GPUObject;
  private texGroup!: GPUObject;
  private view!: GPUObject;
  private work!: GPUObject;
  private present!: GPUObject;

  private constructor(
    private gc: WebGpuContext,
    private log: CallLog,
  ) {
    this.dev = record(gc.device, log, 'device');
    this.canvasCtx = record(gc.context, log, 'context');
    this.timer = new WebGpuTimer(gc, log, 2);
  }
  static async create(gc: WebGpuContext, log: CallLog): Promise<TimingWebGpu> {
    const r = new TimingWebGpu(gc, log);
    await r.init();
    return r;
  }
  private async init(): Promise<void> {
    const dev = this.dev;
    this.log.phase = 'init';
    this.ubo = dev.createBuffer({ label: 'constants', size: UBO_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    const tex = dev.createTexture({ label: 'work target', size: [TIME_W, TIME_H], format: 'rgba8unorm', usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
    this.view = tex.createView();
    const F = ShaderStage.FRAGMENT;
    const uLayout = dev.createBindGroupLayout({ label: 'constants', entries: [{ binding: 0, visibility: ShaderStage.VERTEX | F, buffer: { type: 'uniform' } }] });
    const tLayout = dev.createBindGroupLayout({ label: 'work target', entries: [{ binding: 0, visibility: F, texture: { sampleType: 'float' } }] });
    const module = dev.createShaderModule({ label: 'timing', code: WGSL });
    this.group = dev.createBindGroup({ label: 'constants', layout: uLayout, entries: [{ binding: 0, resource: { buffer: this.ubo } }] });
    this.texGroup = dev.createBindGroup({ label: 'work target', layout: tLayout, entries: [{ binding: 0, resource: this.view }] });
    [this.work, this.present] = await Promise.all([
      dev.createRenderPipelineAsync({
        label: 'work',
        layout: dev.createPipelineLayout({ label: 'work', bindGroupLayouts: [uLayout] }),
        vertex: { module, entryPoint: 'vs_layer' },
        fragment: { module, entryPoint: 'fs_work', targets: [target('rgba8unorm', BLEND.add)] },
        primitive: { topology: 'triangle-list' },
      }),
      dev.createRenderPipelineAsync({
        label: 'present',
        layout: dev.createPipelineLayout({ label: 'present', bindGroupLayouts: [uLayout, tLayout] }),
        vertex: { module, entryPoint: 'vs_full' },
        fragment: { module, entryPoint: 'fs_present', targets: [target(this.gc.format)] },
        primitive: { topology: 'triangle-list' },
      }),
    ]);
  }

  frame(s: TimingSettings, tint: [number, number, number]): TimingResult {
    const t0 = performance.now();
    const dev = this.dev;
    const plan = timingPlan(s);
    this.log.phase = 'frame';
    dev.queue.writeBuffer(this.ubo, 0, ubo(s, this.gc.canvas.width, this.gc.canvas.height, tint));
    const enc = dev.createCommandEncoder({ label: 'frame' });
    const w = enc.beginRenderPass({ label: 'work', colorAttachments: [{ view: this.view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }], timestampWrites: this.timer.writes(0) });
    w.setPipeline(this.work);
    w.setBindGroup(0, this.group);
    w.draw(3, s.layers, 0, 0);
    w.end();
    const p = enc.beginRenderPass({
      label: 'present',
      colorAttachments: [{ view: this.canvasCtx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      timestampWrites: this.timer.writes(1),
    });
    p.setPipeline(this.present);
    p.setBindGroup(0, this.group);
    p.setBindGroup(1, this.texGroup);
    p.draw(3, 1, 0, 0);
    p.end();
    const timed = this.timer.resolve(enc);
    dev.queue.submit([enc.finish({ label: 'frame' })]);
    const cpu = performance.now() - t0;
    this.timer.submitted();
    // Resolves once the GPU has finished everything submitted so far (and the browser has told the page).
    const done = dev.queue.onSubmittedWorkDone().then(
      () => performance.now() - t0,
      () => null,
    );
    return { plan, timed, cpu, done };
  }

  dispose(): void {
    this.ubo?.destroy();
  }
}

// ---------------------------------------------------------------------------------------------

const GLSL_VS = `#version 300 es
flat out float vLayer;
void main() {
  vec2 t = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(t.x * 2.0 - 1.0, 1.0 - t.y * 2.0, 0.0, 1.0);
  vLayer = float(gl_InstanceID);
}`;
const GLSL_U = `layout(std140) uniform U { vec4 k; vec4 tint; };`;
const GLSL_WORK = `#version 300 es
precision highp float;
${GLSL_U}
flat in float vLayer;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy * 0.01 + vec2(vLayer * 1.3, 0.0);
  float n = 0.0;
  for (int i = 0; i < int(k.x); i++) {
    p = vec2(p.x * 0.8 - p.y * 0.6, p.x * 0.6 + p.y * 0.8) + vec2(0.37, 0.71);
    n += sin(p.x * 1.7 + cos(p.y * 2.3));
  }
  float b = (0.6 + 0.4 * sin(n * 0.5)) / k.y;
  outColor = vec4(tint.rgb * b, 1.0 / k.y);
}`;
const GLSL_PRESENT = `#version 300 es
precision highp float;
${GLSL_U}
uniform sampler2D src;
out vec4 outColor;
void main() { outColor = texelFetch(src, ivec2(gl_FragCoord.xy / k.zw * vec2(${TIME_W}.0, ${TIME_H}.0)), 0); }`;

class TimingGl2 implements TimingRenderer {
  readonly backend = 'webgl2';
  readonly timer: Gl2Timer;
  private gl: WebGL2RenderingContext;
  private ubo: WebGLBuffer | null;
  private work: WebGLProgram;
  private present: WebGLProgram;
  private fbo: WebGLFramebuffer | null;
  private tex: WebGLTexture | null;
  private pixel = new Uint8Array(4);

  constructor(
    private gc: Gl2Context,
    private log: CallLog,
  ) {
    const gl = (this.gl = record(gc.gl, log, 'gl'));
    this.timer = new Gl2Timer(gc, log);
    log.phase = 'init';
    this.ubo = named(gl.createBuffer(), 'constants');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, UBO_BYTES, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo);
    this.work = glProgram(gl, 'work', GLSL_VS, GLSL_WORK);
    this.present = glProgram(gl, 'present', GLSL_FULLSCREEN_VS, GLSL_PRESENT);
    for (const p of [this.work, this.present]) gl.uniformBlockBinding(p, gl.getUniformBlockIndex(p, 'U'), 0);
    this.tex = named(gl.createTexture(), 'work target');
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, TIME_W, TIME_H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.fbo = named(gl.createFramebuffer(), 'work');
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  frame(s: TimingSettings, tint: [number, number, number]): TimingResult {
    const t0 = performance.now();
    const gl = this.gl;
    const plan = timingPlan(s);
    this.log.phase = 'frame';
    const timed = !!this.gc.timerExt && !!this.timer.onTimes;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, ubo(s, gl.drawingBufferWidth, gl.drawingBufferHeight, tint));
    this.timer.begin(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, TIME_W, TIME_H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.work);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, s.layers);
    this.timer.end(gl);
    this.timer.begin(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.BLEND);
    gl.useProgram(this.present);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.timer.end(gl);
    this.timer.submitted(gl);
    // The CPU's own time in the calls.
    const cpu = performance.now() - t0;
    // Make the CPU wait for both passes, as onSubmittedWorkDone does on WebGPU: reading a pixel of
    // the presented image can't return before the GPU has drawn it (and the work pass it samples).
    this.log.tagged('readback', () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel));
    const done = performance.now() - t0;
    return { plan, timed, cpu, done: Promise.resolve(done) };
  }

  dispose(): void {
    // Released with the context.
  }
}
