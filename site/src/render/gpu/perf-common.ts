/**
 * Small pieces the performance lessons' renderers share (overdraw-and-fill-rate, bandwidth,
 * timing-the-gpu): WebGL program building, the full-screen triangle, blend states, and a
 * rolling collector for live GPU timings. No DOM beyond what the GPU APIs need.
 */
import { type GpuTimer } from './timing';

/** WebGL objects have no labels; give them one so the call log can name them. */
export function named<T>(o: T, label: string): T {
  if (o && typeof o === 'object') (o as { label?: string }).label = label;
  return o;
}

export function glProgram(gl: WebGL2RenderingContext, label: string, vs: string, fs: string): WebGLProgram {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${label}: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = named(gl.createProgram()!, label);
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${label}: ${gl.getProgramInfoLog(p)}`);
  return p;
}

/** One triangle that covers the screen, from the vertex index alone: (-1, 1), (3, 1), (-1, -3). */
export const WGSL_FULLSCREEN = /* wgsl */ `
@vertex fn vs_full(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let t = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(t.x * 2.0 - 1.0, 1.0 - t.y * 2.0, 0.0, 1.0);
}`;
export const GLSL_FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 t = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(t.x * 2.0 - 1.0, 1.0 - t.y * 2.0, 0.0, 1.0);
}`;

/** WebGPU blend states the lessons use (GPUBlendState). */
export const BLEND = {
  /** Straight alpha: src·a + dst·(1 − a). */
  over: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } },
  /** Counting: dst + src. */
  add: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } },
} as const;

/** A colour target for a pipeline descriptor (webgpu.ts types only the format; this adds blend). */
export const target = (format: string, blend?: object) => ({ format, blend }) as { format: string };

// ---------------------------------------------------------------------------------------------
// Live timings

/**
 * Keeps the last `keep` frames of a GpuTimer's results, by pass name, so a widget can show a
 * rolling median while it draws continuously. Results that arrive for a frame drawn with other
 * passes (the settings changed) are told apart by the pass names recorded when it was drawn.
 */
export class LiveTimes {
  private samples: Array<{ names: string[]; ms: Array<number | null> }> = [];
  /** Pass names of frames whose results haven't come back yet, oldest first. */
  private pending: string[][] = [];

  constructor(
    private timer: GpuTimer,
    private keep = 40,
  ) {
    timer.onTimes = (ms) => {
      const names = this.pending.shift();
      if (!names) return;
      this.samples.push({ names, ms });
      if (this.samples.length > this.keep) this.samples.shift();
    };
  }
  /** Call once per timed frame, with the names of its timed passes in order. */
  drew(names: string[]): void {
    this.pending.push(names);
    // Results that never come back (a dropped WebGL2 frame) mustn't misalign the rest.
    if (this.pending.length > 8) this.pending.shift();
  }
  clear(): void {
    this.samples = [];
  }
  /** Median ms per pass name, over the frames that had the same passes as `names`. */
  medians(names: string[]): { ms: Map<string, number>; frames: number } {
    const key = names.join('|');
    const same = this.samples.filter((s) => s.names.join('|') === key);
    const ms = new Map<string, number>();
    names.forEach((n, i) => {
      const v = same.map((s) => s.ms[i]).filter((x): x is number => x !== null && x !== undefined).sort((a, b) => a - b);
      if (v.length) ms.set(n, v[Math.floor(v.length / 2)]);
    });
    return { ms, frames: same.length };
  }
  stop(): void {
    this.timer.onTimes = null;
  }
}
