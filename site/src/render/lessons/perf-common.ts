/**
 * DOM pieces the performance lessons' widgets share: the API switch, a labelled slider, a
 * rendering loop that runs only while the widget is on screen, and the live GPU-time readout.
 */
import './perf.css';
import { h, seg } from '../../engine/dom';
import { type Backend } from '../gpu/context';
import { type LiveTimes } from '../gpu/perf-common';
import { type GpuTimer } from '../gpu/timing';
import { type GpuCanvas, msText } from '../gpu/widget';

/** WebGPU / WebGL2 buttons, shown only when this browser has WebGPU. */
export function apiSwitch(g: GpuCanvas, onSwitch: () => void): HTMLElement & { refresh: () => void } {
  const box = h('span', { class: 'rd-gpu-switch' });
  const refresh = () => {
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
  return Object.assign(box, { refresh });
}

/** A range input with its label and value. `values` are the steps (the input is an index into them). */
export function slider(label: string, values: number[], value: number, show: (v: number) => string, onInput: (v: number) => void): HTMLElement {
  const out = h('output', {}, show(value));
  const inp = h('input', { type: 'range', min: '0', max: String(values.length - 1), step: '1', value: String(Math.max(0, values.indexOf(value))), 'aria-label': label }) as HTMLInputElement;
  inp.addEventListener('input', () => {
    const v = values[Number(inp.value)];
    out.textContent = show(v);
    onInput(v);
  });
  return h('label', { class: 'rp-slider' }, h('span', {}, label), inp, out);
}
export const range = (lo: number, hi: number, step: number) => Array.from({ length: Math.floor((hi - lo) / step) + 1 }, (_, i) => lo + i * step);

/**
 * Calls `tick` once per animation frame while `el` is on screen and `on()` is true. The GPU
 * widgets draw continuously so their timings are live; off screen they stop, so a page of them
 * doesn't keep the GPU busy.
 */
export class LiveLoop {
  private visible = false;
  private raf = 0;

  constructor(
    el: HTMLElement,
    private tick: () => void,
    private on: () => boolean = () => true,
  ) {
    if (typeof IntersectionObserver === 'undefined') return;
    new IntersectionObserver((es) => {
      this.visible = es[es.length - 1].isIntersecting;
      this.kick();
    }).observe(el);
  }
  /** Start the loop if it should run and isn't running. */
  kick(): void {
    if (this.raf || !this.visible || !this.on()) return;
    const step = () => {
      this.raf = 0;
      if (!this.visible || !this.on()) return;
      this.tick();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
}

/** Rows of "pass: time" from the rolling medians, or why there are none. */
export function timesTable(timer: GpuTimer | null, live: LiveTimes | null, passes: string[]): HTMLElement {
  if (!timer) return h('p', { class: 'll-muted' }, 'Starting the GPU…');
  if (!timer.available) return h('p', { class: 'rp-note' }, `No GPU timings here: ${timer.why}. Everything else on this widget still works; the counts don't depend on them.`);
  const m = live?.medians(passes);
  if (!m || m.frames < 3) return h('p', { class: 'll-muted' }, 'Measuring…');
  let total = 0;
  const rows = passes.map((p) => {
    const v = m.ms.get(p) ?? null;
    if (v !== null) total += v;
    return h('tr', {}, h('th', {}, p), h('td', {}, msText(v)));
  });
  return h(
    'div',
    {},
    h('table', { class: 'rd-tab' }, h('tbody', {}, ...rows, h('tr', { class: 'rp-total' }, h('th', {}, 'all passes'), h('td', {}, msText(total))))),
    h('p', { class: 'rp-fine' }, `Median of the last ${m.frames} frames, ${timer.why}. Your GPU, your numbers: they change with the machine, the browser and what else is running.`),
  );
}
