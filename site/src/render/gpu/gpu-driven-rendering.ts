/**
 * "GPU-driven rendering": the city, culled and drawn without the CPU looking at a single building.
 *
 * WebGPU: every building's record lives in a storage buffer, uploaded once. Each frame the CPU
 * writes the camera (planes, eye, LOD constants) and resets three sets of indirect draw arguments
 * (instanceCount = 0); a compute shader tests each building's sphere against the frustum, picks a
 * level of detail, and appends the building's index to that level's visible list with an
 * atomicAdd on the level's instanceCount; then the render pass issues the ground and one
 * drawIndexedIndirect per level. The vertex shader looks its record up through the visible list.
 * The CPU's calls per frame don't depend on how many buildings there are.
 *
 * WebGL2 has no compute shaders and no indirect draws, so the fallback does the same cull on the
 * CPU (scenes/gpu-driven-rendering.ts cpuCull), copies the visible records into an instance
 * buffer and draws with three instanced draws (the culling lesson's renderer).
 */
import { type CityColours, type CityRenderer, WGSL_CITY_COMMON, cityFrameData, CITY_FRAME_BYTES, createCity, meshLayout } from './culling';
import { type Gl2Context, type GpuContext, type WebGpuContext } from './context';
import { type FramePlan } from './plan';
import { CallLog, record } from './record';
import { BufferUsage, type GPUBuffer, type GPUCanvasContext, type GPUDevice, type GPUObject, type GPUTexture, MapMode, ShaderStage, TextureUsage } from './webgpu';
import { type Camera } from '../raster';
import { LOD_MESHES } from '../scenes/culling';
import { CULL_UNIFORM_BYTES, cpuCull, cullData, cullUniforms, gatherRecords, gpuDrivenPlan } from '../scenes/gpu-driven-rendering';

export interface DrivenRenderer {
  readonly backend: 'webgpu' | 'webgl2';
  /** Where the culling runs on this backend. */
  readonly where: 'gpu' | 'cpu';
  frame(side: number, cam: Camera, c: CityColours): FramePlan;
  /** WebGPU: the latest instance counts per level read back from the GPU (a frame or more old), or null. */
  gpuCounts(): number[] | null;
  dispose(): void;
}

export async function createDriven(ctx: GpuContext, log: CallLog | null): Promise<DrivenRenderer> {
  return ctx.kind === 'webgpu' ? DrivenWebGpu.create(ctx, log) : DrivenGl2.create(ctx, log);
}

const CULL_WGSL = /* wgsl */ `
struct Inst {
  minTone: vec4f,
  size: vec4f,
}
struct Cull {
  planes: array<vec4f, 6>,  // inward normals and offsets
  eye: vec4f,
  lod: vec4f,               // focal length, LOD 0 and LOD 1 size thresholds, near plane
  count: vec4u,             // buildings, stride between the levels' visible lists
}
// The same five values drawIndexed takes. instanceCount is counted up by the cull.
struct Args {
  indexCount: u32,
  instanceCount: atomic<u32>,
  firstIndex: u32,
  baseVertex: i32,
  firstInstance: u32,
}
@group(0) @binding(0) var<uniform> cull: Cull;
@group(0) @binding(1) var<storage, read> insts: array<Inst>;
@group(0) @binding(2) var<storage, read_write> args: array<Args, 3>;
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= cull.count.x) { return; }
  let b = insts[i];
  let half = b.size.xyz * 0.5;
  let c = b.minTone.xyz + half;
  let r = length(half);
  for (var p = 0u; p < 6u; p++) {
    let pl = cull.planes[p];
    if (dot(pl.xyz, c) + pl.w < -r) { return; }
  }
  let size = r * cull.lod.x / max(cull.lod.w, distance(c, cull.eye.xyz));
  var lod = 2u;
  if (size > cull.lod.y) { lod = 0u; } else if (size > cull.lod.z) { lod = 1u; }
  // Append to this level's list: the slot is the old instance count.
  let slot = atomicAdd(&args[lod].instanceCount, 1u);
  visible[lod * cull.count.y + slot] = i;
}
`;

const DRAW_WGSL = /* wgsl */ `${WGSL_CITY_COMMON}
struct Inst {
  minTone: vec4f,
  size: vec4f,
}
@group(0) @binding(1) var<storage, read> insts: array<Inst>;
@group(1) @binding(0) var<storage, read> visible: array<u32>;  // this level's list

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @builtin(instance_index) k: u32) -> VOut {
  let b = insts[visible[k]];
  return place(p, n, b.minTone, b.size);
}
`;

const DEPTH_FORMAT = 'depth24plus';

interface SideData {
  side: number;
  n: number;
  records: GPUBuffer;
  visible: GPUBuffer;
  cullGroup: GPUObject;
  drawGroup0: GPUObject;
  /** One per level, then the ground's one-entry list. */
  lists: GPUObject[];
}

class DrivenWebGpu implements DrivenRenderer {
  readonly backend = 'webgpu';
  readonly where = 'gpu';
  private dev: GPUDevice;
  private canvasCtx: GPUCanvasContext;
  private vbufs: GPUBuffer[] = [];
  private ibufs: GPUBuffer[] = [];
  private frameUbo!: GPUBuffer;
  private cullUbo!: GPUBuffer;
  private args!: GPUBuffer;
  private read!: GPUBuffer;
  private cullPipe!: GPUObject;
  private drawPipe!: GPUObject;
  private cullLayout!: GPUObject;
  private draw0Layout!: GPUObject;
  private listLayout!: GPUObject;
  private data: SideData | null = null;
  private depth: { w: number; h: number; tex: GPUTexture; view: GPUObject } | null = null;
  private counts: number[] | null = null;
  private frames = 0;
  private log: CallLog;

  private constructor(private gc: WebGpuContext, log: CallLog | null) {
    this.log = log ?? new CallLog();
    this.dev = log ? record(gc.device, log, 'device') : gc.device;
    this.canvasCtx = log ? record(gc.context, log, 'context') : gc.context;
  }
  static async create(gc: WebGpuContext, log: CallLog | null): Promise<DrivenWebGpu> {
    const r = new DrivenWebGpu(gc, log);
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
    this.cullUbo = dev.createBuffer({ label: 'cull constants', size: CULL_UNIFORM_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    // Three sets of drawIndexedIndirect arguments: written by the cull, read by the draws, copied out to show the counts.
    this.args = dev.createBuffer({ label: 'indirect arguments', size: 64, usage: BufferUsage.STORAGE | BufferUsage.INDIRECT | BufferUsage.COPY_DST | BufferUsage.COPY_SRC });
    this.log.tagged('readback', () => {
      this.read = dev.createBuffer({ label: 'arguments, read back', size: 64, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
    });
    const cullModule = dev.createShaderModule({ label: 'cull shader', code: CULL_WGSL });
    const drawModule = dev.createShaderModule({ label: 'draw shaders', code: DRAW_WGSL });
    this.cullLayout = dev.createBindGroupLayout({
      label: 'cull',
      entries: [
        { binding: 0, visibility: ShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: ShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: ShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: ShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this.draw0Layout = dev.createBindGroupLayout({
      label: 'frame and records',
      entries: [
        { binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.listLayout = dev.createBindGroupLayout({ label: 'visible list', entries: [{ binding: 0, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }] });
    const [cullPipe, drawPipe] = await Promise.all([
      dev.createComputePipelineAsync({ label: 'cull', layout: dev.createPipelineLayout({ label: 'cull', bindGroupLayouts: [this.cullLayout] }), compute: { module: cullModule, entryPoint: 'main' } }),
      dev.createRenderPipelineAsync({
        label: 'city, indirect',
        layout: dev.createPipelineLayout({ label: 'city, indirect', bindGroupLayouts: [this.draw0Layout, this.listLayout] }),
        vertex: { module: drawModule, entryPoint: 'vs', buffers: [meshLayout] },
        fragment: { module: drawModule, entryPoint: 'fs', targets: [{ format: this.gc.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
      }),
    ]);
    this.cullPipe = cullPipe;
    this.drawPipe = drawPipe;
    const err = await this.gc.device.popErrorScope();
    if (err) console.error('WebGPU init:', err.message);
  }

  /** Per city size: every building's record (uploaded once) and the visible lists. */
  private sideData(side: number): SideData {
    if (this.data?.side === side) return this.data;
    const prev = this.log.phase;
    this.log.phase = 'rebuild';
    this.data?.records.destroy();
    this.data?.visible.destroy();
    const d = cullData(side);
    const n = d.buildings.length;
    const dev = this.dev;
    const records = dev.createBuffer({ label: 'building records', size: d.records.byteLength, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
    dev.queue.writeBuffer(records, 0, d.records);
    // Three lists of n indices (n × 4 bytes is a multiple of 256, the storage offset alignment), then the ground's.
    const visible = dev.createBuffer({ label: 'visible lists', size: 3 * n * 4 + 256, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
    dev.queue.writeBuffer(visible, 3 * n * 4, new Uint32Array([n]));
    const cullGroup = dev.createBindGroup({
      label: 'cull',
      layout: this.cullLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cullUbo } },
        { binding: 1, resource: { buffer: records } },
        { binding: 2, resource: { buffer: this.args } },
        { binding: 3, resource: { buffer: visible, offset: 0, size: 3 * n * 4 } },
      ],
    });
    const drawGroup0 = dev.createBindGroup({
      label: 'frame and records',
      layout: this.draw0Layout,
      entries: [
        { binding: 0, resource: { buffer: this.frameUbo } },
        { binding: 1, resource: { buffer: records } },
      ],
    });
    const lists = [0, 1, 2, 3].map((l) => dev.createBindGroup({ label: l < 3 ? `LOD ${l} list` : 'ground list', layout: this.listLayout, entries: [{ binding: 0, resource: { buffer: visible, offset: l * n * 4, size: l < 3 ? n * 4 : 4 } }] }));
    this.data = { side, n, records, visible, cullGroup, drawGroup0, lists };
    this.log.phase = prev;
    return this.data;
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

  frame(side: number, cam: Camera, c: CityColours): FramePlan {
    const d = this.sideData(side);
    const depth = this.depthView(this.gc.canvas.width, this.gc.canvas.height);
    const dev = this.dev;
    this.log.phase = 'frame';
    dev.queue.writeBuffer(this.frameUbo, 0, cityFrameData(cam, c));
    dev.queue.writeBuffer(this.cullUbo, 0, cullUniforms(cam, d.n, d.n));
    // Reset the arguments: each level's index count, no instances yet.
    const reset = new Uint32Array(16);
    LOD_MESHES.forEach((m, l) => (reset[l * 5] = m.indexCount));
    dev.queue.writeBuffer(this.args, 0, reset);
    const enc = dev.createCommandEncoder({ label: 'frame' });
    const cp = enc.beginComputePass({ label: 'cull' });
    cp.setPipeline(this.cullPipe);
    cp.setBindGroup(0, d.cullGroup);
    cp.dispatchWorkgroups(Math.ceil(d.n / 64));
    cp.end();
    // Now and then, copy the arguments out to show what the GPU counted.
    const readNow = this.read.mapState === 'unmapped' && this.frames++ % 10 === 0;
    if (readNow) this.log.tagged('readback', () => enc.copyBufferToBuffer(this.args, 0, this.read, 0, 64));
    const pass = enc.beginRenderPass({
      label: 'scene',
      colorAttachments: [{ view: this.canvasCtx.getCurrentTexture().createView(), clearValue: { r: c.bg[0] / 255, g: c.bg[1] / 255, b: c.bg[2] / 255, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    pass.setPipeline(this.drawPipe);
    pass.setBindGroup(0, d.drawGroup0);
    // The ground: one ordinary draw through its one-entry list.
    pass.setBindGroup(1, d.lists[3]);
    pass.setVertexBuffer(0, this.vbufs[2]);
    pass.setIndexBuffer(this.ibufs[2], 'uint16');
    pass.drawIndexed(LOD_MESHES[2].indexCount, 1, 0, 0, 0);
    // Each level: its list, its mesh, and arguments the GPU wrote. The CPU never learns the counts.
    for (let l = 0; l < 3; l++) {
      pass.setBindGroup(1, d.lists[l]);
      pass.setVertexBuffer(0, this.vbufs[l]);
      pass.setIndexBuffer(this.ibufs[l], 'uint16');
      pass.drawIndexedIndirect(this.args, l * 20);
    }
    pass.end();
    dev.queue.submit([enc.finish({ label: 'frame' })]);
    if (readNow) {
      const b = this.read;
      void this.log.tagged('readback', () => b.mapAsync(MapMode.READ)).then(
        () => {
          const u = new Uint32Array(b.getMappedRange().slice(0));
          b.unmap();
          this.counts = [u[1], u[6], u[11]];
        },
        () => {},
      );
    }
    return gpuDrivenPlan('webgpu', this.counts ?? [0, 0, 0]);
  }

  gpuCounts(): number[] | null {
    return this.counts;
  }

  dispose(): void {
    for (const b of [...this.vbufs, ...this.ibufs, this.frameUbo, this.cullUbo, this.args]) b?.destroy();
    this.data?.records.destroy();
    this.data?.visible.destroy();
    this.depth?.tex.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// WebGL2: the same cull on the CPU, then instanced draws

class DrivenGl2 implements DrivenRenderer {
  readonly backend = 'webgl2';
  readonly where = 'cpu';
  private constructor(private city: CityRenderer) {}
  static async create(gc: Gl2Context, log: CallLog | null): Promise<DrivenGl2> {
    return new DrivenGl2(await createCity(gc, log));
  }
  frame(side: number, cam: Camera, c: CityColours): FramePlan {
    const d = cullData(side);
    const { lists, counts } = cpuCull(d, cam);
    this.city.frame(cam, gatherRecords(d, lists, counts), c);
    return gpuDrivenPlan('webgl2', counts);
  }
  gpuCounts(): number[] | null {
    return null;
  }
  dispose(): void {
    this.city.dispose();
  }
}
