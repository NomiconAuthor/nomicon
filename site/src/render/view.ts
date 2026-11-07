/**
 * Shared pieces of the rendering widgets: theme colours, drawing a render target as big pixels,
 * and the stepper (next vertex / triangle / pixel, run, reset) that drives the render generator.
 */
import { type Child, h } from '../engine/dom';
import { type Draw, type PixelStep, type ScreenTri, type Step, type Target, SUB } from './raster';

// ---------------------------------------------------------------------------------------------
// Colours from the theme tokens

export type RGB = [number, number, number];
function parse(c: string): RGB {
  const s = c.trim();
  if (s.startsWith('#')) {
    const x = s.length === 4 ? s.slice(1).split('').map((d) => d + d).join('') : s.slice(1, 7);
    return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
  }
  const m = s.match(/[\d.]+/g);
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [128, 128, 128];
}
export class Palette {
  private cache = new Map<string, string>();
  constructor(private el: Element) {}
  css(token: string): string {
    let v = this.cache.get(token);
    if (!v) {
      v = getComputedStyle(this.el).getPropertyValue(token).trim() || '#888';
      this.cache.set(token, v);
    }
    return v;
  }
  rgb(token: string): RGB {
    return parse(this.css(token));
  }
  reset(): void {
    this.cache.clear();
  }
}
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const rgbCss = (c: RGB, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

/** Redraw when the reader switches theme. */
export function onTheme(fn: () => void): void {
  new MutationObserver(fn).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

// ---------------------------------------------------------------------------------------------
// Drawing a target

export type TargetView = 'color' | 'depth' | 'heat';

/** Fill the canvas with the target's pixels, each drawn as a square `k` canvas pixels wide. */
export function paintTarget(ctx: CanvasRenderingContext2D, t: Target, draws: Draw[], pal: Palette, view: TargetView, k: number, depthLo = 0, depthHi = 1): void {
  const bg = pal.rgb('--bg');
  const cols = draws.map((d) => pal.rgb(d.color));
  const ink = pal.rgb('--ink');
  const hot = pal.rgb('--alert');
  const warm = pal.rgb('--warn');
  const S = t.samples;
  // Fill whole device pixels (edges rounded), so neighbouring squares meet without seams at any scale.
  const m = ctx.getTransform();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const ex = (x: number) => Math.round(x * k * m.a + m.e);
  const ey = (y: number) => Math.round(y * k * m.d + m.f);
  for (let y = 0; y < t.h; y++)
    for (let x = 0; x < t.w; x++) {
      const p = y * t.w + x;
      let c: RGB = [0, 0, 0];
      if (view === 'color') {
        // Resolve: average the samples (that's what an MSAA resolve does).
        for (let s = 0; s < S; s++) {
          const o = t.owner[p * S + s];
          const v = o < 0 ? bg : mix(bg, cols[o], 0.25 + 0.75 * t.lum[p * S + s]);
          c = [c[0] + v[0] / S, c[1] + v[1] / S, c[2] + v[2] / S];
        }
      } else if (view === 'depth') {
        // Stored depth as grey, stretched over [depthLo, depthHi] so the detail is visible.
        let d = 0;
        for (let s = 0; s < S; s++) d += t.depth[p * S + s] / S;
        const g = Math.min(1, Math.max(0, (d - depthLo) / (depthHi - depthLo || 1)));
        c = mix(bg, ink, 1 - g);
      } else {
        const n = t.shaded[p];
        c = n === 0 ? bg : n === 1 ? mix(bg, ink, 0.25) : n === 2 ? mix(bg, warm, 0.7) : mix(bg, hot, Math.min(1, 0.55 + 0.15 * (n - 3)));
      }
      ctx.fillStyle = rgbCss(c);
      ctx.fillRect(ex(x), ey(y), ex(x + 1) - ex(x), ey(y + 1) - ey(y));
    }
  ctx.setTransform(m);
}

/** Outline a screen triangle (positions in 1/SUB pixel). */
export function outlineTri(ctx: CanvasRenderingContext2D, t: ScreenTri, k: number, color: string, width = 2): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const x = (t.x[i] / SUB) * k;
    const y = (t.y[i] / SUB) * k;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
}

/** Mark the pixel a step is on. */
export function markPixel(ctx: CanvasRenderingContext2D, s: PixelStep, k: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, k / 8);
  ctx.strokeRect(s.x * k + 1, s.y * k + 1, k - 2, k - 2);
}

// ---------------------------------------------------------------------------------------------
// Controls

export function btn(label: string, fn: () => void, primary = false): HTMLButtonElement {
  return h('button', { type: 'button', class: `ll-btn${primary ? ' primary' : ''}`, onclick: fn }, label) as HTMLButtonElement;
}
export function chk(label: string, on: boolean, change: (v: boolean) => void): HTMLElement {
  const i = h('input', { type: 'checkbox', onchange: (e: Event) => change((e.target as HTMLInputElement).checked) }) as HTMLInputElement;
  i.checked = on;
  return h('label', { class: 'll-chk' }, i, ` ${label}`);
}
// ---------------------------------------------------------------------------------------------
// Widget frame and sizing
//
// The sizing rule (render.css has the CSS half): a canvas is drawn in fixed *logical* units (the
// w × h given to canvas()), shown at its aspect ratio no wider than --rd-max-w (640 px by default)
// and no taller than --rd-max-h (60vh), and never wider than the column. Its backing store follows
// the size it is shown at times devicePixelRatio, so it stays crisp at any zoom; draw through
// ctx2d(), which scales logical units to the backing store, and redraw from fit()'s callback.
// stage() puts a canvas beside a side panel (readouts) when the widget is wide enough, and above
// it otherwise. Pointer code should map clientX/Y through getBoundingClientRect() to logical
// units (or to target pixels), never through canvas.width.

/** The widget's root element (`.ll.rd.<cls>`), replacing whatever the host held. */
export function frame(host: HTMLElement, cls: string): HTMLElement {
  const root = h('div', { class: `ll rd ${cls}` });
  host.replaceChildren(root);
  return root;
}
export const stat = (v: string | number, label: string) => h('span', { class: 'll-stat' }, h('b', {}, String(v)), h('span', {}, label));
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const logical = new WeakMap<HTMLCanvasElement, { w: number; h: number }>();

export interface CanvasSize {
  /** Largest width shown, in CSS px (sets --rd-max-w on the canvas). */
  maxWidth?: number;
  /** Largest height shown, as a CSS length such as '40vh' (sets --rd-max-h on the canvas). */
  maxHeight?: string;
}

/**
 * A canvas drawn in logical units w × h. Its shown size follows the sizing rule above; call fit()
 * to keep the backing store matched to it.
 */
export function canvas(w: number, h0: number, label: string, cls = 'rd-canvas', size: CanvasSize = {}): HTMLCanvasElement {
  const c = h('canvas', { class: cls.includes('rd-canvas') ? cls : `rd-canvas ${cls}`, width: String(w), height: String(h0), 'aria-label': label, role: 'img' }) as HTMLCanvasElement;
  logical.set(c, { w, h: h0 });
  c.style.setProperty('--rd-ar', String(w / h0));
  c.style.aspectRatio = `${w} / ${h0}`;
  if (size.maxWidth) c.style.setProperty('--rd-max-w', `${size.maxWidth}px`);
  if (size.maxHeight) c.style.setProperty('--rd-max-h', size.maxHeight);
  return c;
}

/** The canvas's logical size (what drawing code works in). */
export function size(c: HTMLCanvasElement): { w: number; h: number } {
  return logical.get(c) ?? { w: c.width, h: c.height };
}

/**
 * A font size in logical units that is at least `base` and shows at least `minCss` CSS px at the
 * canvas's current displayed width (canvases drawn in 640-unit coordinates shrink on phones).
 */
export function fontPx(c: HTMLCanvasElement, base: number, minCss = 11): number {
  const shown = c.getBoundingClientRect().width;
  return shown > 0 ? Math.max(base, (minCss * size(c).w) / shown) : base;
}

/** The 2D context, scaled so that drawing in logical units fills the backing store. */
export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d')!;
  const { w, h: h0 } = size(c);
  ctx.setTransform(c.width / w, 0, 0, c.height / h0, 0, 0);
  return ctx;
}

/**
 * Keep the canvas's backing store at the size it is shown at, in device pixels, and redraw when
 * that changes (resizing a canvas clears it). Until it is laid out it keeps its logical size.
 */
export function fit(c: HTMLCanvasElement, redraw: () => void): void {
  if (typeof ResizeObserver === 'undefined') return;
  new ResizeObserver((entries) => {
    const e = entries[entries.length - 1];
    const dpr = window.devicePixelRatio || 1;
    // contentRect × devicePixelRatio rather than devicePixelContentBoxSize, which emulated
    // device scale factors (and some browsers) report in CSS pixels. The border sits inside the
    // aspect ratio, so the content box can be a hair off w : h; ctx2d scales x and y separately.
    const bw = Math.round(e.contentRect.width * dpr);
    const bh = Math.round(e.contentRect.height * dpr);
    if (bw < 2 || bh < 2) return;
    if (bw === c.width && bh === c.height) return;
    c.width = bw;
    c.height = bh;
    redraw();
  }).observe(c);
}

/**
 * A canvas (or a group of them) with an optional side panel: beside it when the widget is wide
 * enough, below it otherwise. `ar` is the figure's aspect ratio when it isn't a single canvas.
 */
export function stage(fig: HTMLElement, side: Child[] = [], ar?: number): HTMLElement {
  const el = h('div', { class: 'rd-stage' }, fig, side.length ? h('div', { class: 'rd-side' }, ...side) : false);
  const a = ar ?? (fig instanceof HTMLCanvasElement ? size(fig).w / size(fig).h : undefined);
  if (a) el.style.setProperty('--rd-ar', String(a));
  for (const p of ['--rd-max-w', '--rd-max-h']) {
    const v = fig.style.getPropertyValue(p);
    if (v) el.style.setProperty(p, v);
  }
  return el;
}

/**
 * Drives a render generator: step to the next step of a kind, or run (a number of steps per
 * animation frame). `make` starts a fresh frame; `show` redraws with the latest step.
 */
export class Stepper {
  private gen: Generator<Step, void, void> | null = null;
  last: Step | null = null;
  lastTri: Extract<Step, { kind: 'triangle' }> | null = null;
  done = false;
  count = 0;
  private raf = 0;
  readonly playBtn: HTMLButtonElement;
  /** Steps per animation frame while running. */
  speed = 40;

  constructor(
    private make: () => Generator<Step, void, void>,
    private show: () => void,
  ) {
    this.playBtn = btn('Run', () => (this.raf ? this.pause() : this.play()), true);
  }

  /** Start a fresh frame; with `finish`, run it to the end at once. */
  reset(finish = false): void {
    this.pause();
    this.gen = this.make();
    this.last = null;
    this.lastTri = null;
    this.done = false;
    this.count = 0;
    if (finish) this.finish();
    else this.show();
  }
  private advance(): boolean {
    if (!this.gen) this.gen = this.make();
    const r = this.gen.next();
    if (r.done) {
      this.done = true;
      return false;
    }
    this.last = r.value;
    this.count++;
    if (r.value.kind === 'triangle') this.lastTri = r.value;
    if (r.value.kind === 'done') this.done = true;
    return !this.done;
  }
  /** Advance to the next step of one of these kinds (and stop at the end). */
  next(kinds: Array<Step['kind']>, pred: (s: Step) => boolean = () => true): void {
    this.pause();
    if (this.done) this.reset();
    while (this.advance()) if (kinds.includes(this.last!.kind) && pred(this.last!)) break;
    this.show();
  }
  finish(): void {
    this.pause();
    if (this.done) this.reset();
    while (this.advance());
    this.show();
  }
  play(): void {
    if (this.done) this.reset();
    this.playBtn.textContent = 'Pause';
    const tick = () => {
      for (let i = 0; i < this.speed; i++) if (!this.advance()) break;
      this.show();
      if (this.done) this.pause();
      else this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  pause(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.playBtn.textContent = 'Run';
  }
}

export const n2 = (x: number) => (Math.abs(x) < 5e-5 ? '0' : x.toFixed(2));
export const n3 = (x: number) => x.toFixed(3);
