/**
 * "The same frame on a real GPU": the pipeline lesson's scene drawn with WebGPU and with WebGL2.
 * Two renderers, written against the real APIs, that walk the same FramePlan
 * (scenes/same-frame-real-gpu.ts): a scene pass into an offscreen colour + depth target, then a
 * present pass that copies it to the canvas with a full-screen triangle.
 *
 * Every call goes through a recorded device / context (record.ts), so the inspector shows what
 * was really called, and the claims count the same calls in Node against the stubs (stub.ts).
 */
import { type Gl2Context, type GpuContext, type WebGpuContext } from './context';
import { type FramePlan } from './plan';
import { type CallLog, record } from './record';
import { KEY_LIGHT, VERTEX_ATTRS, VERTEX_STRIDE } from './scene';
import { Gl2Timer, type GpuTimer, WebGpuTimer } from './timing';
import { BufferUsage, type GPUBuffer, type GPUCanvasContext, type GPUDevice, type GPUObject, type GPUTexture, MapMode, ShaderStage, TextureUsage } from './webgpu';
import {
  DRAW_UNIFORM_BYTES,
  FRAME_UNIFORM_BYTES,
  PIPE_H,
  PIPELINE_KEYS,
  PRESENT,
  type SameFrameSettings,
  sameFrameDraws,
  sameFramePlan,
  sameFrameViewProj,
} from '../scenes/same-frame-real-gpu';

/** Theme colours, 0–255: the background and one per draw. */
export interface Colours {
  bg: [number, number, number];
  draws: Array<[number, number, number]>;
}

export interface SameFrameRenderer {
  readonly backend: 'webgpu' | 'webgl2';
  readonly timer: GpuTimer;
  /** Draw a frame; with `readback` (64 × 40 only) also copy the scene pass's pixels back. */
  frame(s: SameFrameSettings, c: Colours, readback: boolean): FramePlan;
  /** The last read-back frame: RGBA bytes, top row first, PIPE_W × PIPE_H. */
  pixels(): Promise<Uint8Array | null>;
  dispose(): void;
}

export async function createSameFrame(ctx: GpuContext, log: CallLog): Promise<SameFrameRenderer> {
  return ctx.kind === 'webgpu' ? SameFrameWebGpu.create(ctx, log) : new SameFrameGl2(ctx, log);
}

/** Per-frame uniforms: viewProj, light, ambient/diffuse, background. Same layout in WGSL and std140. */
function frameData(near: number, c: Colours): Float32Array {
  const d = new Float32Array(FRAME_UNIFORM_BYTES / 4);
  d.set(sameFrameViewProj(near), 0);
  d.set([KEY_LIGHT.dir.x, KEY_LIGHT.dir.y, KEY_LIGHT.dir.z, 0], 16);
  d.set([KEY_LIGHT.ambient, KEY_LIGHT.diffuse, 0, 0], 20);
  d.set([c.bg[0] / 255, c.bg[1] / 255, c.bg[2] / 255, 1], 24);
  return d;
}
/** Per-draw uniforms: each draw's colour, `align` bytes apart. */
function drawData(c: Colours, align: number): Float32Array {
  const d = new Float32Array(((c.draws.length - 1) * align + DRAW_UNIFORM_BYTES) / 4);
  c.draws.forEach((col, i) => d.set([col[0] / 255, col[1] / 255, col[2] / 255, 1], (i * align) / 4));
  return d;
}
const sameColours = (a: Colours | null, b: Colours) => !!a && JSON.stringify(a) === JSON.stringify(b);
/** WebGL objects have no labels; give them one so the call log can name them. */
function named<T>(o: T, label: string): T {
  if (o && typeof o === 'object') (o as { label?: string }).label = label;
  return o;
}

// ---------------------------------------------------------------------------------------------
// WebGPU

const WGSL_SCENE = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  light: vec4f,  // xyz: unit vector towards the light
  shade: vec4f,  // x: ambient, y: diffuse
  bg: vec4f,
}
struct Draw {
  color: vec4f,
}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> draw: Draw;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) normal: vec3f,
  @location(1) uv: vec2f,
}

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f) -> VOut {
  var o: VOut;
  o.pos = frame.viewProj * vec4f(p, 1.0);
  o.normal = n;
  o.uv = uv;
  return o;
}

fn tint(lum: f32) -> vec4f {
  return vec4f(mix(frame.bg.rgb, draw.color.rgb, 0.25 + 0.75 * lum), 1.0);
}

@fragment fn fs_checker(v: VOut) -> @location(0) vec4f {
  let odd = (i32(floor(v.uv.x)) + i32(floor(v.uv.y))) & 1;
  return tint(select(1.0, 0.55, odd == 1));
}

@fragment fn fs_lit(v: VOut) -> @location(0) vec4f {
  return tint(frame.shade.x + frame.shade.y * max(0.0, dot(normalize(v.normal), frame.light.xyz)));
}
`;

const WGSL_PRESENT = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

// One triangle that covers the screen: (-1, 1), (3, 1), (-1, -3). No vertex buffer.
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let t = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4f(t.x * 2.0 - 1.0, 1.0 - t.y * 2.0, 0.0, 1.0);
  o.uv = t;
  return o;
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  return textureSample(src, samp, v.uv);
}
`;

const SCENE_FORMAT = 'rgba8unorm';
const DEPTH_FORMAT = 'depth24plus';

class SameFrameWebGpu implements SameFrameRenderer {
  readonly backend = 'webgpu';
  readonly timer: WebGpuTimer;
  private dev: GPUDevice;
  private canvasCtx: GPUCanvasContext;
  private draws = sameFrameDraws();
  private vbufs: GPUBuffer[] = [];
  private ibufs: GPUBuffer[] = [];
  private frameUbo!: GPUBuffer;
  private drawUbo!: GPUBuffer;
  private align: number;
  private frameGroup!: GPUObject;
  private drawGroups: GPUObject[] = [];
  private pipelines = new Map<string, GPUObject>();
  private presentLayout!: GPUObject;
  private sampler!: GPUObject;
  private target: { w: number; h: number; color: GPUTexture; depth: GPUTexture; colorView: GPUObject; depthView: GPUObject; group: GPUObject } | null = null;
  private readBuf!: GPUBuffer;
  private reading: Promise<Uint8Array | null> = Promise.resolve(null);
  private colours: Colours | null = null;

  private constructor(
    private gc: WebGpuContext,
    private log: CallLog,
  ) {
    this.dev = record(gc.device, log, 'device');
    this.canvasCtx = record(gc.context, log, 'context');
    this.align = Math.max(256, gc.device.limits.minUniformBufferOffsetAlignment ?? 256);
    this.timer = new WebGpuTimer(gc, log, 2);
  }

  static async create(gc: WebGpuContext, log: CallLog): Promise<SameFrameWebGpu> {
    const r = new SameFrameWebGpu(gc, log);
    await r.init();
    return r;
  }

  private async init(): Promise<void> {
    const dev = this.dev;
    const log = this.log;
    log.phase = 'init';
    // Not recorded: an error scope is for us, not part of drawing the frame.
    this.gc.device.pushErrorScope('validation');
    // Geometry: one vertex and one index buffer per mesh, filled through the queue.
    for (const d of this.draws) {
      const vb = dev.createBuffer({ label: `${d.name} vertices`, size: d.mesh.vertices.byteLength, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
      dev.queue.writeBuffer(vb, 0, d.mesh.vertices);
      const ib = dev.createBuffer({ label: `${d.name} indices`, size: d.mesh.indices.byteLength, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
      dev.queue.writeBuffer(ib, 0, d.mesh.indices);
      this.vbufs.push(vb);
      this.ibufs.push(ib);
    }
    // Constants: one buffer per frame, one with a block per draw.
    this.frameUbo = dev.createBuffer({ label: 'frame constants', size: FRAME_UNIFORM_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.drawUbo = dev.createBuffer({ label: 'draw constants', size: (this.draws.length - 1) * this.align + DRAW_UNIFORM_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });

    const sceneModule = dev.createShaderModule({ label: 'scene shaders', code: WGSL_SCENE });
    const presentModule = dev.createShaderModule({ label: 'present shaders', code: WGSL_PRESENT });

    // Layouts: what each bind group holds, and which groups a pipeline uses, grouped by how often they change.
    const frameLayout = dev.createBindGroupLayout({ label: 'per frame', entries: [{ binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    const drawLayout = dev.createBindGroupLayout({ label: 'per draw', entries: [{ binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    this.presentLayout = dev.createBindGroupLayout({
      label: 'present',
      entries: [
        { binding: 0, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const sceneLayout = dev.createPipelineLayout({ label: 'scene', bindGroupLayouts: [frameLayout, drawLayout] });
    const presentPipeLayout = dev.createPipelineLayout({ label: 'present', bindGroupLayouts: [this.presentLayout] });

    // Pipelines: shaders plus every piece of fixed-function state, compiled up front. Cull mode is
    // part of the state, so each material needs one pipeline per cull mode.
    const vertexLayout = {
      arrayStride: VERTEX_STRIDE,
      attributes: VERTEX_ATTRS.map((a) => ({ shaderLocation: a.location, offset: a.offset, format: `float32x${a.components}` })),
    };
    const jobs: Array<Promise<void>> = [];
    for (const key of PIPELINE_KEYS) {
      if (key === PRESENT) {
        jobs.push(
          dev
            .createRenderPipelineAsync({
              label: key,
              layout: presentPipeLayout,
              vertex: { module: presentModule, entryPoint: 'vs' },
              fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format: this.gc.format }] },
              primitive: { topology: 'triangle-list', cullMode: 'none' },
            })
            .then((p) => void this.pipelines.set(key, p)),
        );
        continue;
      }
      const checker = key.startsWith('checker');
      jobs.push(
        dev
          .createRenderPipelineAsync({
            label: key,
            layout: sceneLayout,
            vertex: { module: sceneModule, entryPoint: 'vs', buffers: [vertexLayout] },
            fragment: { module: sceneModule, entryPoint: checker ? 'fs_checker' : 'fs_lit', targets: [{ format: SCENE_FORMAT }] },
            primitive: { topology: 'triangle-list', cullMode: key.endsWith('cull back') ? 'back' : 'none', frontFace: 'ccw' },
            depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
          })
          .then((p) => void this.pipelines.set(key, p)),
      );
    }
    this.sampler = dev.createSampler({ label: 'nearest', magFilter: 'nearest', minFilter: 'nearest' });
    // Bind groups: the actual buffers behind each layout. The draw groups point at 256-byte-aligned blocks of one buffer.
    this.frameGroup = dev.createBindGroup({ label: 'frame', layout: frameLayout, entries: [{ binding: 0, resource: { buffer: this.frameUbo } }] });
    this.drawGroups = this.draws.map((d, i) =>
      dev.createBindGroup({ label: d.name, layout: drawLayout, entries: [{ binding: 0, resource: { buffer: this.drawUbo, offset: i * this.align, size: DRAW_UNIFORM_BYTES } }] }),
    );
    log.tagged('readback', () => {
      this.readBuf = dev.createBuffer({ label: 'readback', size: 256 * PIPE_H, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
    });
    await Promise.all(jobs);
    const err = await this.gc.device.popErrorScope();
    if (err) console.error('WebGPU init:', err.message);
  }

  /** The offscreen colour and depth targets, rebuilt when their size changes. */
  private targets(w: number, h: number) {
    if (this.target && this.target.w === w && this.target.h === h) return this.target;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    this.target?.color.destroy();
    this.target?.depth.destroy();
    const dev = this.dev;
    const color = dev.createTexture({ label: 'scene colour', size: [w, h], format: SCENE_FORMAT, usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_SRC });
    const depth = dev.createTexture({ label: 'scene depth', size: [w, h], format: DEPTH_FORMAT, usage: TextureUsage.RENDER_ATTACHMENT });
    const colorView = color.createView();
    const depthView = depth.createView();
    const group = dev.createBindGroup({
      label: 'present',
      layout: this.presentLayout,
      entries: [
        { binding: 0, resource: colorView },
        { binding: 1, resource: this.sampler },
      ],
    });
    this.target = { w, h, color, depth, colorView, depthView, group };
    this.log.phase = prev;
    return this.target;
  }

  frame(s: SameFrameSettings, c: Colours, readback: boolean): FramePlan {
    const cw = this.gc.canvas.width;
    const ch = this.gc.canvas.height;
    const plan = sameFramePlan(s, cw, ch);
    const [scene, present] = plan.passes;
    const dev = this.dev;
    if (!sameColours(this.colours, c)) {
      this.log.phase = 'rebuild';
      dev.queue.writeBuffer(this.drawUbo, 0, drawData(c, this.align));
      this.colours = c;
    }
    const t = this.targets(scene.w, scene.h);
    this.log.phase = 'frame';
    dev.queue.writeBuffer(this.frameUbo, 0, frameData(s.near, c));
    const bg = { r: c.bg[0] / 255, g: c.bg[1] / 255, b: c.bg[2] / 255, a: 1 };

    const enc = dev.createCommandEncoder({ label: 'frame' });
    const p1 = enc.beginRenderPass({
      label: scene.name,
      colorAttachments: [{ view: t.colorView, clearValue: bg, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: t.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      timestampWrites: this.timer.writes(0),
    });
    p1.setBindGroup(0, this.frameGroup);
    scene.draws.forEach((d, i) => {
      p1.setPipeline(this.pipelines.get(d.pipeline)!);
      p1.setBindGroup(1, this.drawGroups[i]);
      p1.setVertexBuffer(0, this.vbufs[i]);
      p1.setIndexBuffer(this.ibufs[i], 'uint16');
      p1.drawIndexed(d.count, d.instances, 0, 0, 0);
    });
    p1.end();

    const read = readback && s.res === 'low' && this.readBuf.mapState === 'unmapped';
    if (read) this.log.tagged('readback', () => enc.copyTextureToBuffer({ texture: t.color }, { buffer: this.readBuf, bytesPerRow: 256 }, [scene.w, scene.h]));

    const p2 = enc.beginRenderPass({
      label: present.name,
      colorAttachments: [{ view: this.canvasCtx.getCurrentTexture().createView(), clearValue: bg, loadOp: 'clear', storeOp: 'store' }],
      timestampWrites: this.timer.writes(1),
    });
    p2.setPipeline(this.pipelines.get(PRESENT)!);
    p2.setBindGroup(0, t.group);
    p2.draw(3, 1, 0, 0);
    p2.end();

    this.timer.resolve(enc);
    dev.queue.submit([enc.finish({ label: 'frame' })]);
    this.timer.submitted();
    if (read) {
      const b = this.readBuf;
      const w = scene.w;
      const h = scene.h;
      this.reading = this.log.tagged('readback', () => b.mapAsync(MapMode.READ)).then(
        () => {
          const src = new Uint8Array(b.getMappedRange());
          const out = new Uint8Array(w * h * 4);
          for (let y = 0; y < h; y++) out.set(src.subarray(y * 256, y * 256 + w * 4), y * w * 4);
          b.unmap();
          // The canvas format may be BGRA, but the scene target is RGBA, so no swizzle is needed.
          return out;
        },
        () => null,
      );
    }
    return plan;
  }

  pixels(): Promise<Uint8Array | null> {
    return this.reading;
  }

  dispose(): void {
    for (const b of [...this.vbufs, ...this.ibufs, this.frameUbo, this.drawUbo]) b?.destroy();
    this.target?.color.destroy();
    this.target?.depth.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// WebGL2

const GLSL_SCENE_VS = `#version 300 es
layout(std140) uniform Frame { mat4 viewProj; vec4 light; vec4 shade; vec4 bg; };
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vec4 c = viewProj * vec4(position, 1.0);
  // viewProj gives depth 0..w (D3D, Vulkan, WebGPU); OpenGL ES clips at -w..w.
  gl_Position = vec4(c.xy, 2.0 * c.z - c.w, c.w);
  vNormal = normal;
  vUv = uv;
}`;

const glslSceneFs = (checker: boolean) => `#version 300 es
precision highp float;
${checker ? '#define CHECKER' : ''}
layout(std140) uniform Frame { mat4 viewProj; vec4 light; vec4 shade; vec4 bg; };
layout(std140) uniform Draw { vec4 color; };
in vec3 vNormal;
in vec2 vUv;
out vec4 outColor;
vec4 tint(float lum) { return vec4(mix(bg.rgb, color.rgb, 0.25 + 0.75 * lum), 1.0); }
void main() {
#ifdef CHECKER
  int odd = (int(floor(vUv.x)) + int(floor(vUv.y))) & 1;
  outColor = tint(odd == 1 ? 0.55 : 1.0);
#else
  outColor = tint(shade.x + shade.y * max(0.0, dot(normalize(vNormal), light.xyz)));
#endif
}`;

const GLSL_PRESENT_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 t = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(t.x * 2.0 - 1.0, 1.0 - t.y * 2.0, 0.0, 1.0);
  vUv = vec2(t.x, 1.0 - t.y); // GL textures start at the bottom row
}`;
const GLSL_PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D src;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texture(src, vUv); }`;

class SameFrameGl2 implements SameFrameRenderer {
  readonly backend = 'webgl2';
  readonly timer: Gl2Timer;
  private gl: WebGL2RenderingContext;
  private draws = sameFrameDraws();
  private vaos: Array<WebGLVertexArrayObject | null> = [];
  private buffers: Array<WebGLBuffer | null> = [];
  private frameUbo: WebGLBuffer | null;
  private drawUbo: WebGLBuffer | null;
  private align: number;
  /** A WebGL "pipeline" is a program plus the state set around each draw. */
  private pipelines = new Map<string, { program: WebGLProgram; cull: boolean }>();
  private target: { w: number; h: number; tex: WebGLTexture | null; depth: WebGLRenderbuffer | null; fbo: WebGLFramebuffer | null } | null = null;
  private last: Uint8Array | null = null;
  private colours: Colours | null = null;

  constructor(
    private gc: Gl2Context,
    private log: CallLog,
  ) {
    const gl = (this.gl = record(gc.gl, log, 'gl'));
    this.timer = new Gl2Timer(gc, log);
    log.phase = 'init';
    // Geometry: a vertex array object per mesh remembers its buffers and attribute layout.
    for (const d of this.draws) {
      const vao = named(gl.createVertexArray(), d.name);
      gl.bindVertexArray(vao);
      const vb = named(gl.createBuffer(), `${d.name} vertices`);
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, d.mesh.vertices, gl.STATIC_DRAW);
      for (const a of VERTEX_ATTRS) {
        gl.enableVertexAttribArray(a.location);
        gl.vertexAttribPointer(a.location, a.components, gl.FLOAT, false, VERTEX_STRIDE, a.offset);
      }
      const ib = named(gl.createBuffer(), `${d.name} indices`);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.mesh.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.vaos.push(vao);
      this.buffers.push(vb, ib);
    }
    // Constants: uniform buffers bound to binding points 0 (per frame) and 1 (per draw).
    this.align = Math.max(16, Number(gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT)) || 256);
    this.frameUbo = named(gl.createBuffer(), 'frame constants');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, FRAME_UNIFORM_BYTES, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.frameUbo);
    this.drawUbo = named(gl.createBuffer(), 'draw constants');
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.drawUbo);
    gl.bufferData(gl.UNIFORM_BUFFER, (this.draws.length - 1) * this.align + DRAW_UNIFORM_BYTES, gl.DYNAMIC_DRAW);
    // Programs: shaders are compiled and linked here; cull mode is not part of a program.
    const vs = this.shader(gl.VERTEX_SHADER, GLSL_SCENE_VS);
    const checker = this.program('checker', vs, this.shader(gl.FRAGMENT_SHADER, glslSceneFs(true)));
    const lit = this.program('lit', vs, this.shader(gl.FRAGMENT_SHADER, glslSceneFs(false)));
    const present = this.program('present', this.shader(gl.VERTEX_SHADER, GLSL_PRESENT_VS), this.shader(gl.FRAGMENT_SHADER, GLSL_PRESENT_FS));
    for (const p of [checker, lit]) {
      gl.uniformBlockBinding(p, gl.getUniformBlockIndex(p, 'Frame'), 0);
      gl.uniformBlockBinding(p, gl.getUniformBlockIndex(p, 'Draw'), 1);
    }
    for (const key of PIPELINE_KEYS) {
      const program = key === PRESENT ? present : key.startsWith('checker') ? checker : lit;
      this.pipelines.set(key, { program, cull: key.endsWith('cull back') });
    }
    // State that never changes in this renderer is set once.
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.depthFunc(gl.LESS);
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

  private targets(w: number, h: number) {
    if (this.target && this.target.w === w && this.target.h === h) return this.target;
    const gl = this.gl;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    if (this.target) {
      gl.deleteFramebuffer(this.target.fbo);
      gl.deleteTexture(this.target.tex);
      gl.deleteRenderbuffer(this.target.depth);
    }
    const tex = named(gl.createTexture(), 'scene colour');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const depth = named(gl.createRenderbuffer(), 'scene depth');
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    const fbo = named(gl.createFramebuffer(), 'scene');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) console.error('WebGL2: scene framebuffer incomplete');
    this.target = { w, h, tex, depth, fbo };
    this.log.phase = prev;
    return this.target;
  }

  frame(s: SameFrameSettings, c: Colours, readback: boolean): FramePlan {
    const gl = this.gl;
    const cw = this.gc.canvas.width;
    const ch = this.gc.canvas.height;
    const plan = sameFramePlan(s, cw, ch);
    const [scene, present] = plan.passes;
    if (!sameColours(this.colours, c)) {
      this.log.phase = 'rebuild';
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.drawUbo);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, drawData(c, this.align));
      this.colours = c;
    }
    const t = this.targets(scene.w, scene.h);
    this.log.phase = 'frame';
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUbo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, frameData(s.near, c));

    // Scene pass. Nothing groups these calls into a pass except that they share a framebuffer.
    this.timer.begin(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, scene.w, scene.h);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(c.bg[0] / 255, c.bg[1] / 255, c.bg[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    scene.draws.forEach((d, i) => {
      const p = this.pipelines.get(d.pipeline)!;
      gl.useProgram(p.program);
      if (p.cull) gl.enable(gl.CULL_FACE);
      else gl.disable(gl.CULL_FACE);
      gl.bindBufferRange(gl.UNIFORM_BUFFER, 1, this.drawUbo, i * this.align, DRAW_UNIFORM_BYTES);
      gl.bindVertexArray(this.vaos[i]);
      gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, 0);
    });
    this.timer.end(gl);
    if (readback && s.res === 'low') {
      const buf = new Uint8Array(scene.w * scene.h * 4);
      // Synchronous: the CPU waits here until the GPU has finished the pass.
      this.log.tagged('readback', () => gl.readPixels(0, 0, scene.w, scene.h, gl.RGBA, gl.UNSIGNED_BYTE, buf));
      // GL's rows start at the bottom; flip to top row first.
      const out = new Uint8Array(buf.length);
      const row = scene.w * 4;
      for (let y = 0; y < scene.h; y++) out.set(buf.subarray((scene.h - 1 - y) * row, (scene.h - y) * row), y * row);
      this.last = out;
    }

    // Present pass: undo the scene pass's state, then copy to the canvas.
    this.timer.begin(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.pipelines.get(present.draws[0].pipeline)!.program);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.drawArrays(gl.TRIANGLES, 0, present.draws[0].count);
    this.timer.end(gl);
    // No submit: the browser flushes the commands when it composites the page.
    this.timer.submitted(gl);
    return plan;
  }

  pixels(): Promise<Uint8Array | null> {
    return Promise.resolve(this.last);
  }

  dispose(): void {
    // The context is lost or released by disposeGpu; its objects go with it.
  }
}
