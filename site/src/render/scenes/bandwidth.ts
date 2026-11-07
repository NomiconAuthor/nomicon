/**
 * "Bandwidth": a three-pass frame (G-buffer, lighting, post) and a CPU model of the bytes its
 * render targets move to and from memory, from their formats and their load and store ops. No
 * DOM, no GPU: the claims check the lesson's numbers here, and the widget draws the same frame on
 * the GPU with the same formats and ops.
 *
 * The model counts what a render pass has to move between memory and the GPU at its boundaries,
 * which is exactly the traffic on a tile-based GPU: a load op of "load" reads the whole attachment
 * in, "clear" reads nothing; "store" writes it all out, "discard" writes nothing; and a later pass
 * that samples a texture reads it once. On an immediate-mode GPU this is a lower bound: overdraw,
 * blending and depth testing add traffic that caches absorb only partly, and framebuffer
 * compression (DCC, AFBC) takes some away. MB are 10^6 bytes.
 */
import { type FramePlan } from '../gpu/plan';

export interface Format {
  /** WebGPU's name. */
  id: string;
  /** Bytes per pixel the model counts. */
  bytes: number;
  /** D3D / Vulkan names, for the table. */
  native: string;
  note?: string;
}

export const FORMATS: Record<string, Format> = {
  rgba8unorm: { id: 'rgba8unorm', bytes: 4, native: 'R8G8B8A8_UNORM' },
  rgb10a2unorm: { id: 'rgb10a2unorm', bytes: 4, native: 'R10G10B10A2_UNORM' },
  rgba16float: { id: 'rgba16float', bytes: 8, native: 'R16G16B16A16_FLOAT' },
  rg11b10ufloat: { id: 'rg11b10ufloat', bytes: 4, native: 'R11G11B10_FLOAT', note: 'no alpha, no sign; 6- and 5-bit mantissas' },
  rgba32float: { id: 'rgba32float', bytes: 16, native: 'R32G32B32A32_FLOAT' },
  depth16unorm: { id: 'depth16unorm', bytes: 2, native: 'D16_UNORM' },
  depth24plus: { id: 'depth24plus', bytes: 4, native: 'D24_UNORM_X8 (or D32_FLOAT: WebGPU leaves it to the implementation)' },
  'depth24plus-stencil8': { id: 'depth24plus-stencil8', bytes: 4, native: 'D24_UNORM_S8_UINT (packed on most GPUs)' },
  depth32float: { id: 'depth32float', bytes: 4, native: 'D32_FLOAT' },
};

export const NORMAL_FORMATS = ['rgba8unorm', 'rgb10a2unorm', 'rgba16float'];
export const DEPTH_FORMATS = ['depth16unorm', 'depth24plus', 'depth24plus-stencil8', 'depth32float'];
export const HDR_FORMATS = ['rg11b10ufloat', 'rgba16float', 'rgba32float'];
/** The canvas's format: four bytes a pixel whichever of rgba8unorm or bgra8unorm the browser prefers. */
export const SWAP_BYTES = 4;

export const RESOLUTIONS: Array<[number, number]> = [
  [1280, 720],
  [1920, 1080],
  [2560, 1440],
  [3840, 2160],
];

export type LoadOp = 'clear' | 'load';
export type StoreOp = 'store' | 'discard';
export interface Ops {
  load: LoadOp;
  store: StoreOp;
}

export interface BandwidthSettings {
  w: number;
  h: number;
  normal: string;
  depth: string;
  hdr: string;
  /** The lighting pass reads depth (for fog). Off: nothing reads depth after the G-buffer pass. */
  fog: boolean;
  albedoOps: Ops;
  normalOps: Ops;
  depthOps: Ops;
  hdrOps: Ops;
  /** Model only: G-buffer and lighting in one render pass (subpasses / tile memory), so the G-buffer never leaves the chip. */
  merged: boolean;
}
export const BANDWIDTH_DEFAULTS: BandwidthSettings = {
  w: 1920,
  h: 1080,
  normal: 'rgba16float',
  depth: 'depth32float',
  hdr: 'rgba16float',
  fog: true,
  albedoOps: { load: 'clear', store: 'store' },
  normalOps: { load: 'clear', store: 'store' },
  depthOps: { load: 'clear', store: 'store' },
  hdrOps: { load: 'clear', store: 'store' },
  merged: false,
};

export type AttachmentName = 'albedo' | 'normal' | 'depth' | 'hdr' | 'swapchain';
export interface Traffic {
  name: AttachmentName;
  pass: string;
  format: string;
  bytesPerPixel: number;
  /** Bytes the pass's load op reads. */
  load: number;
  /** Bytes the pass's store op writes. */
  store: number;
  /** Bytes later passes read by sampling it. */
  read: number;
  /** A later pass reads it, but it wasn't stored: it reads undefined contents (zeros in WebGPU). */
  readsDiscarded: boolean;
  /** Its contents never need to exist in memory: cleared, discarded, never sampled. */
  transientOk: boolean;
}
export interface BandwidthResult {
  rows: Traffic[];
  /** Bytes moved per frame. */
  total: number;
  /** Memory the targets occupy, and how much of it could be memoryless on a tile-based GPU. */
  footprint: number;
  transient: number;
  /** Sizes the frame reads but were discarded. */
  broken: AttachmentName[];
}

export function bandwidth(s: BandwidthSettings): BandwidthResult {
  const px = s.w * s.h;
  const rows: Traffic[] = [];
  const add = (name: AttachmentName, pass: string, format: string, bpp: number, ops: Ops, readers: number, onChip: boolean) => {
    // On chip (merged passes) a G-buffer attachment is neither loaded, stored nor read from memory.
    const load = onChip || ops.load === 'clear' ? 0 : px * bpp;
    const store = onChip || ops.store === 'discard' ? 0 : px * bpp;
    const read = onChip ? 0 : readers * px * bpp;
    const readsDiscarded = !onChip && readers > 0 && ops.store === 'discard';
    const transientOk = onChip || (ops.load === 'clear' && ops.store === 'discard' && readers === 0);
    rows.push({ name, pass, format, bytesPerPixel: bpp, load, store, read, readsDiscarded, transientOk });
  };
  const m = s.merged;
  add('albedo', 'G-buffer', 'rgba8unorm', 4, s.albedoOps, 1, m);
  add('normal', 'G-buffer', s.normal, FORMATS[s.normal].bytes, s.normalOps, 1, m);
  add('depth', 'G-buffer', s.depth, FORMATS[s.depth].bytes, s.depthOps, s.fog ? 1 : 0, m);
  add('hdr', 'lighting', s.hdr, FORMATS[s.hdr].bytes, s.hdrOps, 1, false);
  add('swapchain', 'post', 'the canvas', SWAP_BYTES, { load: 'clear', store: 'store' }, 0, false);
  const total = rows.reduce((a, r) => a + r.load + r.store + r.read, 0);
  const footprint = rows.reduce((a, r) => a + px * r.bytesPerPixel, 0);
  const transient = rows.filter((r) => r.transientOk && r.name !== 'swapchain').reduce((a, r) => a + px * r.bytesPerPixel, 0);
  return { rows, total, footprint, transient, broken: rows.filter((r) => r.readsDiscarded).map((r) => r.name) };
}

export const MB = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
export const GBs = (bytesPerFrame: number, fps = 60) => `${((bytesPerFrame * fps) / 1e9).toFixed(2)} GB/s`;

// ---------------------------------------------------------------------------------------------
// The GPU frame

export const PASS = { gbuffer: 'G-buffer', lighting: 'lighting', post: 'post' } as const;
/** The pipeline lesson's floor and box, two indexed draws, then two full-screen triangles. */
export function bandwidthPlan(s: BandwidthSettings, draws: Array<{ name: string; count: number }>): FramePlan {
  return {
    passes: [
      {
        name: PASS.gbuffer,
        target: `albedo + normal + depth, ${s.w} × ${s.h}`,
        w: s.w,
        h: s.h,
        draws: draws.map((d) => ({ name: d.name, pipeline: `G-buffer: ${s.normal}, ${s.depth}`, indexed: true, count: d.count, instances: 1 })),
      },
      { name: PASS.lighting, target: `HDR colour, ${s.w} × ${s.h}`, w: s.w, h: s.h, draws: [{ name: 'full-screen triangle', pipeline: `lighting: ${s.hdr}`, indexed: false, count: 3, instances: 1 }] },
      { name: PASS.post, target: 'the canvas', w: 0, h: 0, draws: [{ name: 'full-screen triangle', pipeline: 'post', indexed: false, count: 3, instances: 1 }] },
    ],
  };
}
