/**
 * Small pieces shared by the engine-side GPU lessons (batching, culling, GPU-driven rendering):
 * the WebGPU/WebGL2 switch, a render loop that only runs while the widget is on screen, and a
 * rolling median for CPU times measured live.
 */
import { h, seg } from '../../engine/dom';
import { type Backend } from '../gpu/context';
import { type GpuCanvas } from '../gpu/widget';
import { type RGB, type Palette } from '../view';

/** The API switch (only shown when this browser can do WebGPU). Call `refresh()` once the canvas has started. */
export function apiSwitch(g: GpuCanvas, onSwitch: () => void): HTMLElement & { refresh: () => void } {
  const box = h('span', { class: 'rd-gpu-switch' }) as HTMLElement & { refresh: () => void };
  box.refresh = () => {
    if (!g.webGpuOk) {
      box.replaceChildren();
      return;
    }
    const s = seg<Backend>(
      'API',
      [
        ['webgpu', 'WebGPU'],
        ['webgl2', 'WebGL2'],
      ],
      g.ctx?.kind ?? 'webgpu',
      (b) => void g.use(b).then(onSwitch),
    );
    box.replaceChildren(s.el);
  };
  return box;
}

/**
 * Calls `tick(seconds)` every animation frame while `el` is on screen and the page is visible, so
 * widgets that measure live (or animate) cost nothing when scrolled away.
 */
export class Loop {
  private raf = 0;
  private seen = false;
  private t0 = 0;
  constructor(
    el: HTMLElement,
    private tick: (t: number) => void,
  ) {
    if (typeof IntersectionObserver !== 'undefined')
      new IntersectionObserver((es) => {
        this.seen = es[es.length - 1].isIntersecting;
        this.update();
      }).observe(el);
    else this.seen = true;
    document.addEventListener('visibilitychange', () => this.update());
  }
  private update(): void {
    const run = this.seen && document.visibilityState === 'visible';
    if (run && !this.raf) {
      this.t0 = performance.now();
      const f = (now: number) => {
        this.raf = requestAnimationFrame(f);
        this.tick((now - this.t0) / 1000);
      };
      this.raf = requestAnimationFrame(f);
    } else if (!run && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }
}

/** The median of the last `n` samples. */
export class Rolling {
  private v: number[] = [];
  constructor(private n = 60) {}
  add(x: number): void {
    this.v.push(x);
    if (this.v.length > this.n) this.v.shift();
  }
  clear(): void {
    this.v = [];
  }
  get count(): number {
    return this.v.length;
  }
  median(): number | null {
    if (!this.v.length) return null;
    const s = [...this.v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
}

/** A CPU time for the readouts. Measured live; never quoted in a lesson. */
export const cpuText = (ms: number | null) => (ms === null ? '…' : ms < 1 ? `${Math.round(ms * 1000)} µs` : `${ms.toFixed(ms < 10 ? 2 : 1)} ms`);

/** A theme token as 0–255 integers. */
export const rgb255 = (pal: Palette, token: string) => pal.rgb(token).map((x) => Math.round(x)) as [number, number, number];
export type { RGB };
