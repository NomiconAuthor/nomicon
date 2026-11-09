/**
 * "The same frame on a real GPU": the CPU-side model of the frame the lesson's GPU widgets draw,
 * and the software frame they compare it with. No DOM, no GPU, so the claims run it in Node.
 *
 * The scene and camera are the pipeline lesson's (scenes/the-pipeline.ts). The GPU frame has two
 * passes: the scene into an offscreen colour + depth target (64 × 40 like the software frame, or
 * the canvas's own size), then a full-screen triangle that copies it to the canvas.
 */
import { type RGB } from '../view';
import { DEFAULTS, Target, renderAll } from '../raster';
import { type FramePlan } from '../gpu/plan';
import { type GpuDraw, gpuDraws, viewProj } from '../gpu/scene';
import { PIPE_H, PIPE_NEARS, PIPE_W, pipelineCamera, pipelineScene } from './the-pipeline';

export { PIPE_H, PIPE_NEARS, PIPE_W };

export interface SameFrameSettings {
  near: number;
  cull: boolean;
  /** 'low': the scene pass renders 64 × 40 like the software rasteriser; 'full': at the canvas's size. */
  res: 'low' | 'full';
}
export const SAME_FRAME_DEFAULTS: SameFrameSettings = { near: PIPE_NEARS[0], cull: true, res: 'low' };

export const sameFrameDraws = (): GpuDraw[] => gpuDraws(pipelineScene());
export const sameFrameViewProj = (near: number) => viewProj(pipelineCamera(near));

/** Pipeline keys: one per material and cull mode, because cull mode is baked into a WebGPU pipeline. */
export const pipelineKey = (material: string, cull: boolean) => `${material}, ${cull ? 'cull back' : 'no culling'}`;
export const PRESENT = 'present';
/** Every pipeline the renderers create up front. */
export const PIPELINE_KEYS = [pipelineKey('checker', true), pipelineKey('checker', false), pipelineKey('lit', true), pipelineKey('lit', false), PRESENT];

/** The frame, as the renderers draw it. `canvasW` × `canvasH` is the canvas's backing size. */
export function sameFramePlan(s: SameFrameSettings, canvasW: number, canvasH: number): FramePlan {
  const draws = sameFrameDraws();
  const w = s.res === 'low' ? PIPE_W : canvasW;
  const h = s.res === 'low' ? PIPE_H : canvasH;
  return {
    passes: [
      {
        name: 'scene',
        target: `colour + depth, ${w} × ${h}`,
        w,
        h,
        draws: draws.map((d) => ({ name: d.name, pipeline: pipelineKey(d.material, s.cull), indexed: true, count: d.mesh.indexCount, instances: 1 })),
      },
      { name: 'present', target: 'the canvas', w: 0, h: 0, draws: [{ name: 'full-screen triangle', pipeline: PRESENT, indexed: false, count: 3, instances: 1 }] },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Uniform buffers (the same layout in WGSL and in GLSL's std140)

/** Per-frame constants: viewProj (64 bytes), light direction, ambient and diffuse, background colour (16 each). */
export const FRAME_UNIFORM_BYTES = 112;
/** Per-draw constants: the draw's colour (16 bytes), one block per draw at this alignment. */
export const DRAW_UNIFORM_BYTES = 16;
/** WebGPU's default minUniformBufferOffsetAlignment: bind group offsets into a uniform buffer must be multiples of it. */
export const UNIFORM_ALIGN = 256;

// ---------------------------------------------------------------------------------------------
// The software frame, and comparing the GPU's pixels with it

export function softwareFrame(s: SameFrameSettings): { target: Target; stats: ReturnType<typeof renderAll> } {
  const target = new Target(PIPE_W, PIPE_H);
  const stats = renderAll(pipelineScene(), target, pipelineCamera(s.near), { ...DEFAULTS, cull: s.cull });
  return { target, stats };
}

/** The colour paintTarget (view.ts) gives a pixel: background, or the draw's colour by brightness. */
export function softwareColour(t: Target, x: number, y: number, bg: RGB, cols: RGB[]): RGB {
  const o = t.owner[y * t.w + x];
  if (o < 0) return bg;
  const k = 0.25 + 0.75 * t.lum[y * t.w + x];
  const c = cols[o];
  return [bg[0] + (c[0] - bg[0]) * k, bg[1] + (c[1] - bg[1]) * k, bg[2] + (c[2] - bg[2]) * k];
}

/**
 * Pixels where the GPU's 64 × 40 frame (RGBA bytes, top row first) differs from the software
 * frame by more than `tol` in any channel. How many there are depends on the GPU, so lessons
 * describe them, never count them.
 */
export function differingPixels(t: Target, gpu: Uint8Array, bg: RGB, cols: RGB[], tol = 3): number[] {
  const out: number[] = [];
  for (let y = 0; y < t.h; y++)
    for (let x = 0; x < t.w; x++) {
      const s = softwareColour(t, x, y, bg, cols);
      const i = (y * t.w + x) * 4;
      if (Math.abs(gpu[i] - s[0]) > tol || Math.abs(gpu[i + 1] - s[1]) > tol || Math.abs(gpu[i + 2] - s[2]) > tol) out.push(y * t.w + x);
    }
  return out;
}
