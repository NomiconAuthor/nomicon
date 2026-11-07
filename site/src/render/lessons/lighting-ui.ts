/**
 * UI pieces the lighting lessons' widgets share: the WebGPU/WebGL2 switch and the one-line backend
 * row, a GPU canvas laid out as a figure beside a side panel, a labelled slider, and the
 * "time some frames" row and readout.
 */
import './lighting.css';
import { h, seg } from '../../engine/dom';
import { type Backend } from '../gpu/context';
import { type GpuTimer } from '../gpu/timing';
import { type GpuCanvas, backendLine, msText, timeFrames } from '../gpu/widget';
import { type RGB, Palette } from '../view';

/** The API switch: shown only where WebGPU works, so there's something to switch between. */
export function apiSwitch(g: GpuCanvas, onSwitch: () => void): HTMLElement & { refresh?: () => void } {
  const box = h('span', { class: 'rd-gpu-switch' });
  const render = () => {
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
  return Object.assign(box, { refresh: render });
}

/**
 * Fill `row` with the API switch and the backend line, kept to one line: the adapter's long name
 * is cut with an ellipsis and shown whole in the tooltip.
 */
export function showBackendRow(row: HTMLElement, api: HTMLElement, g: GpuCanvas): void {
  const line = h('span', { class: 'rd-lit-about' }, h('span', { class: 'll-muted' }, 'GPU side: '), ...backendLine(g));
  line.title = line.textContent ?? '';
  row.className = 'll-row rd-lit-backend';
  row.replaceChildren(api, line);
}

/** One row: the frame's passes, draws and triangles, the Time button, and the timing result. */
export function gpuRow(planStats: HTMLElement, onTime: () => void, timing: HTMLElement): HTMLElement {
  return h('div', { class: 'll-row' }, h('span', { class: 'll-muted' }, 'GPU: '), planStats, h('button', { type: 'button', class: 'll-btn', onclick: onTime }, 'Time 60 frames'), timing);
}

/** The GPU canvas's holder as a figure, so stage() sizes it like a canvas. */
export function gpuFigure(g: GpuCanvas, w: number, hh: number): HTMLElement {
  g.el.style.setProperty('--rd-ar', String(w / hh));
  for (const p of ['--rd-max-w', '--rd-max-h']) {
    const v = g.canvas.style.getPropertyValue(p);
    if (v) g.el.style.setProperty(p, v);
  }
  g.el.classList.add('rd-fig');
  return g.el;
}

/** A labelled range input with its value shown beside it. */
export function slider(label: string, min: number, max: number, step: number, value: number, show: (v: number) => string, onInput: (v: number) => void): HTMLElement & { set?: (v: number) => void } {
  const out = h('output', {}, show(value));
  const inp = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label }) as HTMLInputElement;
  inp.addEventListener('input', () => {
    out.textContent = show(Number(inp.value));
    onInput(Number(inp.value));
  });
  const el = h('label', { class: 'rd-slider' }, h('span', {}, label), inp, out);
  return Object.assign(el, {
    set: (v: number) => {
      inp.value = String(v);
      out.textContent = show(v);
    },
  });
}

/** Theme colour as linear RGB 0–1. */
export function linearOf(pal: Palette, token: string): RGB {
  const c = pal.rgb(token);
  const f = (x: number) => {
    const v = x / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [f(c[0]), f(c[1]), f(c[2])];
}

/** Time `frames` frames and describe the medians per named pass. */
export async function timePasses(timer: GpuTimer, frames: number, draw: () => void, names: string[], out: HTMLElement): Promise<void> {
  if (!timer.available) {
    out.textContent = `GPU timings unavailable: ${timer.why}.`;
    return;
  }
  out.textContent = 'Timing…';
  const m = await timeFrames(timer, frames, draw, Math.max(2, names.length));
  if (!m) return;
  out.textContent = `Median GPU time per pass: ${names.map((n, i) => `${n} ${msText(m[i])}`).join(', ')} (${timer.why}). These vary by machine and from run to run.`;
}

/** Run `tick` every animation frame while `on()` and the element is on screen. */
export function animate(el: HTMLElement, on: () => boolean, tick: (dt: number) => void): () => void {
  let raf = 0;
  let last = 0;
  let visible = true;
  const loop = (t: number) => {
    raf = 0;
    if (!on() || !visible) return;
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    tick(dt);
    raf = requestAnimationFrame(loop);
  };
  if (typeof IntersectionObserver !== 'undefined')
    new IntersectionObserver((es) => {
      visible = es[es.length - 1].isIntersecting;
      kick();
    }).observe(el);
  const kick = () => {
    if (!raf && on() && visible) {
      last = 0;
      raf = requestAnimationFrame(loop);
    }
  };
  return kick;
}
