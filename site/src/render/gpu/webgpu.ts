/**
 * The slice of the WebGPU API the rendering lessons use, typed by hand. TypeScript's lib.dom (5.6)
 * has no WebGPU types and the site adds no dependency for them, so this module declares what we
 * call, with the spec's names. They are module types, not globals, so nothing clashes if
 * @webgpu/types is added later (then delete this file and import from there).
 *
 * The usage flags are the spec's numbers, so code here (and the Node stubs in stub.ts) never needs
 * the browser's GPUBufferUsage / GPUTextureUsage globals.
 */

export const BufferUsage = { MAP_READ: 0x1, MAP_WRITE: 0x2, COPY_SRC: 0x4, COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100, QUERY_RESOLVE: 0x200 } as const;
export const TextureUsage = { COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8, RENDER_ATTACHMENT: 0x10 } as const;
export const ShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 } as const;
export const MapMode = { READ: 0x1, WRITE: 0x2 } as const;

export interface GPUObject {
  label: string;
}
export interface GPUAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  isFallbackAdapter?: boolean;
}
export interface GPUAdapter {
  readonly features: ReadonlySet<string>;
  readonly limits: Record<string, number>;
  readonly info?: GPUAdapterInfo;
  requestDevice(desc?: { label?: string; requiredFeatures?: string[]; requiredLimits?: Record<string, number> }): Promise<GPUDevice>;
}
export interface GPU {
  requestAdapter(opts?: { powerPreference?: 'low-power' | 'high-performance' }): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): string;
}
export interface GPUDeviceLostInfo {
  reason: 'unknown' | 'destroyed';
  message: string;
}
export interface GPUDevice extends GPUObject {
  readonly features: ReadonlySet<string>;
  readonly limits: Record<string, number>;
  readonly queue: GPUQueue;
  readonly lost: Promise<GPUDeviceLostInfo>;
  destroy(): void;
  createBuffer(d: { label?: string; size: number; usage: number; mappedAtCreation?: boolean }): GPUBuffer;
  createTexture(d: { label?: string; size: [number, number] | { width: number; height: number }; format: string; usage: number; sampleCount?: number }): GPUTexture;
  createSampler(d?: { label?: string; magFilter?: string; minFilter?: string; mipmapFilter?: string; addressModeU?: string; addressModeV?: string; compare?: string }): GPUObject;
  createShaderModule(d: { label?: string; code: string }): GPUShaderModule;
  createBindGroupLayout(d: { label?: string; entries: GPUBindGroupLayoutEntry[] }): GPUObject;
  createPipelineLayout(d: { label?: string; bindGroupLayouts: GPUObject[] }): GPUObject;
  createRenderPipeline(d: GPURenderPipelineDescriptor): GPUObject;
  /** The same, compiled without blocking the calling thread. */
  createRenderPipelineAsync(d: GPURenderPipelineDescriptor): Promise<GPUObject>;
  createComputePipelineAsync(d: { label?: string; layout: GPUObject | 'auto'; compute: { module: GPUShaderModule; entryPoint?: string } }): Promise<GPUObject>;
  createBindGroup(d: { label?: string; layout: GPUObject; entries: Array<{ binding: number; resource: GPUObject | { buffer: GPUBuffer; offset?: number; size?: number } }> }): GPUObject;
  createCommandEncoder(d?: { label?: string }): GPUCommandEncoder;
  createQuerySet(d: { label?: string; type: 'occlusion' | 'timestamp'; count: number }): GPUObject;
  pushErrorScope(filter: 'validation' | 'out-of-memory' | 'internal'): void;
  popErrorScope(): Promise<{ message: string } | null>;
}
export interface GPUBindGroupLayoutEntry {
  binding: number;
  visibility: number;
  buffer?: { type?: 'uniform' | 'storage' | 'read-only-storage'; hasDynamicOffset?: boolean; minBindingSize?: number };
  texture?: { sampleType?: string; viewDimension?: string };
  sampler?: { type?: string };
}
export interface GPUVertexBufferLayout {
  arrayStride: number;
  stepMode?: 'vertex' | 'instance';
  attributes: Array<{ shaderLocation: number; offset: number; format: string }>;
}
export interface GPURenderPipelineDescriptor {
  label?: string;
  layout: GPUObject | 'auto';
  vertex: { module: GPUShaderModule; entryPoint?: string; buffers?: GPUVertexBufferLayout[] };
  fragment?: { module: GPUShaderModule; entryPoint?: string; targets: Array<{ format: string }> };
  primitive?: { topology?: string; cullMode?: 'none' | 'front' | 'back'; frontFace?: 'ccw' | 'cw' };
  depthStencil?: { format: string; depthWriteEnabled: boolean; depthCompare: string };
  multisample?: { count?: number };
}
export interface GPUShaderModule extends GPUObject {
  getCompilationInfo(): Promise<{ messages: ReadonlyArray<{ type: string; message: string; lineNum: number }> }>;
}
export interface GPUBuffer extends GPUObject {
  readonly size: number;
  readonly mapState: 'unmapped' | 'pending' | 'mapped';
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}
export interface GPUTexture extends GPUObject {
  readonly width: number;
  readonly height: number;
  createView(d?: { label?: string }): GPUObject;
  destroy(): void;
}
export interface GPUQueue extends GPUObject {
  writeBuffer(buffer: GPUBuffer, offset: number, data: ArrayBufferView | ArrayBuffer, dataOffset?: number, size?: number): void;
  submit(buffers: GPUObject[]): void;
  onSubmittedWorkDone(): Promise<void>;
  /** Copy data straight into a texture (the lighting lessons' light lists and lookup tables). */
  writeTexture(dst: { texture: GPUTexture; mipLevel?: number; origin?: [number, number] }, data: ArrayBufferView | ArrayBuffer, layout: { offset?: number; bytesPerRow: number; rowsPerImage?: number }, size: [number, number]): void;
}
export interface GPUTimestampWrites {
  querySet: GPUObject;
  beginningOfPassWriteIndex?: number;
  endOfPassWriteIndex?: number;
}
export interface GPURenderPassDescriptor {
  label?: string;
  colorAttachments: Array<{ view: GPUObject; clearValue?: { r: number; g: number; b: number; a: number }; loadOp: 'load' | 'clear'; storeOp: 'store' | 'discard' }>;
  depthStencilAttachment?: { view: GPUObject; depthClearValue?: number; depthLoadOp?: 'load' | 'clear'; depthStoreOp?: 'store' | 'discard' };
  timestampWrites?: GPUTimestampWrites;
}
export interface GPUCommandEncoder extends GPUObject {
  beginRenderPass(d: GPURenderPassDescriptor): GPURenderPassEncoder;
  copyTextureToBuffer(src: { texture: GPUTexture }, dst: { buffer: GPUBuffer; bytesPerRow: number; rowsPerImage?: number }, size: [number, number]): void;
  copyBufferToBuffer(src: GPUBuffer, srcOffset: number, dst: GPUBuffer, dstOffset: number, size: number): void;
  beginComputePass(d?: { label?: string; timestampWrites?: GPUTimestampWrites }): GPUComputePassEncoder;
  clearBuffer(buffer: GPUBuffer, offset?: number, size?: number): void;
  resolveQuerySet(q: GPUObject, first: number, count: number, dst: GPUBuffer, dstOffset: number): void;
  finish(d?: { label?: string }): GPUObject;
}
export interface GPURenderPassEncoder extends GPUObject {
  setPipeline(p: GPUObject): void;
  setBindGroup(index: number, group: GPUObject, dynamicOffsets?: number[]): void;
  setVertexBuffer(slot: number, buffer: GPUBuffer, offset?: number, size?: number): void;
  setIndexBuffer(buffer: GPUBuffer, format: 'uint16' | 'uint32', offset?: number, size?: number): void;
  setViewport(x: number, y: number, w: number, h: number, minDepth: number, maxDepth: number): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;
  /** Draw arguments read from a buffer: four u32 (vertexCount, instanceCount, firstVertex, firstInstance). */
  drawIndirect(indirectBuffer: GPUBuffer, indirectOffset: number): void;
  /** Five 32-bit values (indexCount, instanceCount, firstIndex, baseVertex, firstInstance). */
  drawIndexedIndirect(indirectBuffer: GPUBuffer, indirectOffset: number): void;
  end(): void;
}
export interface GPUComputePassEncoder extends GPUObject {
  setPipeline(p: GPUObject): void;
  setBindGroup(index: number, group: GPUObject, dynamicOffsets?: number[]): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}
export interface GPUCanvasContext {
  configure(d: { device: GPUDevice; format: string; alphaMode?: 'opaque' | 'premultiplied'; usage?: number }): void;
  unconfigure(): void;
  getCurrentTexture(): GPUTexture;
}

/** navigator.gpu, if this browser has WebGPU at all (it may still return no adapter). */
export function navigatorGpu(): GPU | null {
  return typeof navigator !== 'undefined' ? ((navigator as unknown as { gpu?: GPU }).gpu ?? null) : null;
}
