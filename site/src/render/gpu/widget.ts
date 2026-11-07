/**
 * The DOM half of the GPU layer: a canvas that holds a WebGPU or WebGL2 context and keeps it
 * alive, plus small readouts every GPU widget shows (which backend, frame stats, timings).
 *
 * GpuCanvas follows the rendering section's sizing rule: the canvas comes from view.ts's
 * canvas() (logical size, max width/height from render.css) and fit() keeps its backing store at
 * the shown size × devicePixelRatio, calling `draw` whenever that changes. A renderer reads
 * canvas.width/height (device pixels) when it records a frame; WebGPU's getCurrentTexture()
 * follows the canvas size by itself, WebGL2 needs gl.viewport.
 *
 * It also owns recovery: if the device or context is lost, it tells the widget (`onLost`), and
 * calls `build` again with a new context: at once for WebGPU (a new adapter and device), when the
 * browser restores the context for WebGL2. Switching backend replaces the canvas element,
 * because a canvas can only ever hand out one kind of context.
 */
import { h } from '../../engine/dom';
import { type CanvasSize, canvas, fit, stat } from '../view';
import { type Backend, type GpuContext, disposeGpu, initGpu, simulateLoss, webGpuAvailable } from './context';
import { type FramePlan, planStats } from './plan';
import { type CallLog } from './record';
import { type GpuTimer } from './timing';

export interface GpuCanvasOptions {
  /** Logical size and label, as for view.ts canvas(). */
  w: number;
  h: number;
  label: string;
  size?: CanvasSize;
  /** Records init calls when given (and on). */
  log?: CallLog;
  /** Called before each new context is requested (an inspector clears and starts its log here). */
  beforeInit?: () => void;
  /** Make the renderer for a new context. Called again after a loss or a backend switch. */
  build: (ctx: GpuContext) => Promise<void>;
  /** Drop the renderer (its context is gone or about to be). */
  teardown: () => void;
  /** Draw a frame (also called when the canvas is resized). */
  draw: () => void;
  /** Status changes: ready, lost, recovering, unavailable. */
  onStatus?: (s: string) => void;
  /** More optional WebGPU features to request when the adapter has them (initGpu's `features`). */
  features?: string[];
}

export class GpuCanvas {
  /** Holds the canvas; put this in the widget. */
  readonly el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: GpuContext | null = null;
  /** Why WebGPU isn't in use, or null when it is. */
  noWebGpu: string | null = null;
  /** Whether this browser can do WebGPU at all (so a backend switch makes sense). */
  webGpuOk = false;
  private generation = 0;
  /** Recent device losses, to stop retrying WebGPU if the device keeps getting lost. */
  private losses: number[] = [];

  constructor(private o: GpuCanvasOptions) {
    this.canvas = this.makeCanvas();
    this.el = h('div', { class: 'rd-gpu-host' }, this.canvas);
  }

  private makeCanvas(): HTMLCanvasElement {
    const c = canvas(this.o.w, this.o.h, this.o.label, 'rd-canvas', this.o.size);
    fit(c, () => {
      if (this.ctx) this.o.draw();
    });
    return c;
  }

  /** Detect, then start on `prefer` (default: WebGPU if it works, else WebGL2). */
  async start(prefer: Backend | 'auto' = 'auto'): Promise<void> {
    const why = await webGpuAvailable();
    this.webGpuOk = why === null;
    // Don't ask for an adapter twice when the first request already said there's none.
    await this.init(why && prefer !== 'webgl2' ? 'webgl2' : prefer, why);
  }

  /** Switch API: a fresh canvas, a fresh context, a fresh renderer. */
  async use(b: Backend): Promise<void> {
    if (this.ctx?.kind === b) return;
    this.release();
    const c = this.makeCanvas();
    this.canvas.replaceWith(c);
    this.canvas = c;
    await this.init(b);
  }

  private async init(prefer: Backend | 'auto', noWebGpu: string | null = null): Promise<void> {
    const gen = ++this.generation;
    this.o.beforeInit?.();
    const r = await initGpu(this.canvas, {
      prefer,
      log: this.o.log,
      features: this.o.features,
      onLost: (why) => {
        if (gen !== this.generation) return;
        this.o.teardown();
        const kind = this.ctx?.kind;
        this.ctx = null;
        if (kind === 'webgpu') {
          const now = performance.now();
          this.losses = [...this.losses.filter((t) => now - t < 10000), now];
          if (this.losses.length > 2) {
            // Lost three times in ten seconds: give up on WebGPU, on a fresh canvas.
            this.o.onStatus?.(`The WebGPU device keeps being lost (${why}); using WebGL2 instead.`);
            void this.use('webgl2');
            return;
          }
          this.o.onStatus?.(`The device was lost (${why}). Asking for a new one…`);
          // A lost WebGPU canvas can be configured again with the new device.
          void this.init('webgpu').then(() => this.o.onStatus?.(`The device was lost (${why}); a new device was created and every resource rebuilt.`));
        } else {
          this.o.onStatus?.(`${why}; waiting for the browser to restore it…`);
        }
      },
      onRestored: () => {
        if (gen !== this.generation) return;
        void this.rebuildGl();
      },
    });
    if (gen !== this.generation) return;
    this.noWebGpu = noWebGpu ?? r.noWebGpu;
    this.ctx = r.ctx;
    if (!r.ctx) {
      this.o.onStatus?.(`No GPU API is available here: ${r.noWebGpu}; ${r.noWebGl2}.`);
      return;
    }
    await this.o.build(r.ctx);
    this.o.onStatus?.('');
    this.o.draw();
  }

  /** WebGL2 after a restore: same context object, every resource gone. */
  private async rebuildGl(): Promise<void> {
    const r = await initGpu(this.canvas, { prefer: 'webgl2' });
    if (!r.ctx) return;
    this.ctx = r.ctx;
    await this.o.build(r.ctx);
    this.o.onStatus?.('The WebGL context was lost and restored; every resource was rebuilt.');
    this.o.draw();
  }

  /** Lose the device on purpose (to show recovery). */
  loseDevice(): boolean {
    return this.ctx ? simulateLoss(this.ctx) : false;
  }

  private release(): void {
    this.generation++;
    this.o.teardown();
    if (this.ctx) disposeGpu(this.ctx);
    this.ctx = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Readouts

/** One line on what the GPU side runs on, and why if it's not WebGPU. */
export function backendLine(g: GpuCanvas): HTMLElement[] {
  const c = g.ctx;
  if (!c) return [h('span', { class: 'rd-gpu-api off' }, 'No GPU')];
  const name = c.kind === 'webgpu' ? 'WebGPU' : 'WebGL2';
  const why = c.kind === 'webgl2' && g.noWebGpu && g.noWebGpu !== 'WebGL2 was chosen' ? ` (WebGL2 because ${g.noWebGpu})` : '';
  return [h('span', { class: `rd-gpu-api ${c.kind}` }, name), h('span', { class: 'll-muted' }, `${c.about ? ` ${c.about}` : ''}${why}`)];
}

/** Passes, draw calls and triangles submitted, from the frame's plan. */
export function planReadout(p: FramePlan): HTMLElement[] {
  const s = planStats(p);
  return [stat(s.passes, s.passes === 1 ? 'pass' : 'passes'), stat(s.draws, s.draws === 1 ? 'draw call' : 'draw calls'), stat(s.triangles, 'triangles submitted')];
}

/** Median of the non-null values, per pass. */
export function medians(samples: Array<Array<number | null>>, passes: number): Array<number | null> {
  return Array.from({ length: passes }, (_, i) => {
    const v = samples.map((s) => s[i]).filter((x): x is number => x !== null && x !== undefined).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  });
}

/**
 * Time `frames` frames: draws one per animation frame and collects the timer's results.
 * Resolves with the median per pass (null where nothing came back), or null if timing isn't available.
 */
export function timeFrames(timer: GpuTimer, frames: number, drawFrame: () => void, passes: number): Promise<Array<number | null> | null> {
  if (!timer.available) return Promise.resolve(null);
  const got: Array<Array<number | null>> = [];
  timer.onTimes = (ms) => got.push(ms);
  return new Promise((done) => {
    let n = 0;
    const tick = () => {
      drawFrame();
      if (++n < frames) requestAnimationFrame(tick);
      else {
        // Results arrive a frame or more later; give them a moment, and keep polling WebGL2's queries.
        let waits = 0;
        const wait = () => {
          drawFrame();
          if (got.length < frames && ++waits < 20) requestAnimationFrame(wait);
          else {
            timer.onTimes = null;
            done(medians(got, passes));
          }
        };
        requestAnimationFrame(wait);
      }
    };
    requestAnimationFrame(tick);
  });
}

/** A duration for the timing readouts. */
export const msText = (ms: number | null) => (ms === null ? 'n/a' : ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`);
