/**
 * Opt-in sizing helpers for `.ll` widgets (engine.css has the CSS half: `.ll-canvas`, `.ll-fig`,
 * `.ll-stage`, `.ll-side`). Same rule as the rendering section: a canvas is drawn in fixed
 * *logical* units, shown at its aspect ratio no wider than --ll-max-w (640 px) and no taller than
 * --ll-max-h (60vh), never wider than the column; its backing store follows the displayed size
 * times devicePixelRatio. A stage puts readouts beside the figure when there is room (about
 * 910 px), under it otherwise. Pointer code should map through getBoundingClientRect().
 */
import { type Child, h } from './dom';

export interface LlSize {
  /** Largest width shown, in CSS px (sets --ll-max-w). */
  maxWidth?: number;
  /** Largest height shown, as a CSS length such as '45vh' (sets --ll-max-h). */
  maxHeight?: string;
}

const logical = new WeakMap<HTMLCanvasElement, { w: number; h: number }>();

function sizeVars(el: HTMLElement, ar: number, s: LlSize): void {
  el.style.setProperty('--ll-ar', String(ar));
  if (s.maxWidth) el.style.setProperty('--ll-max-w', `${s.maxWidth}px`);
  if (s.maxHeight) el.style.setProperty('--ll-max-h', s.maxHeight);
}

/** A canvas drawn in logical units w × h (class `ll-canvas` plus `cls`). */
export function llCanvas(w: number, h0: number, label: string, cls = '', size: LlSize = {}): HTMLCanvasElement {
  const c = h('canvas', { class: `ll-canvas ${cls}`.trim(), width: String(w), height: String(h0), 'aria-label': label }) as HTMLCanvasElement;
  logical.set(c, { w, h: h0 });
  c.style.aspectRatio = `${w} / ${h0}`;
  sizeVars(c, w / h0, size);
  return c;
}

/** Several elements (canvases, strips) shown together under one width budget of aspect `ar`. */
export function llFig(ar: number, kids: Child[], size: LlSize = {}): HTMLElement {
  const el = h('div', { class: 'll-fig' }, ...kids);
  sizeVars(el, ar, size);
  return el;
}

/** The canvas's logical size. */
export function llSize(c: HTMLCanvasElement): { w: number; h: number } {
  return logical.get(c) ?? { w: c.width, h: c.height };
}

/** The 2D context, scaled so that drawing in logical units fills the backing store. */
export function llCtx(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d')!;
  const { w, h: h0 } = llSize(c);
  ctx.setTransform(c.width / w, 0, 0, c.height / h0, 0, 0);
  return ctx;
}

/** A font size in logical units: at least `base`, and at least `minCss` CSS px as displayed. */
export function llFont(c: HTMLCanvasElement, base: number, minCss = 11): number {
  const shown = c.getBoundingClientRect().width;
  return shown > 0 ? Math.max(base, (minCss * llSize(c).w) / shown) : base;
}

/** Keep the backing store at the displayed size × devicePixelRatio; redraw when it changes. */
export function llFit(c: HTMLCanvasElement, redraw: () => void): void {
  if (typeof ResizeObserver === 'undefined') return;
  new ResizeObserver((es) => {
    const e = es[es.length - 1];
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(e.contentRect.width * dpr);
    const bh = Math.round(e.contentRect.height * dpr);
    if (bw < 2 || bh < 2 || (bw === c.width && bh === c.height)) return;
    c.width = bw;
    c.height = bh;
    redraw();
  }).observe(c);
}

/** The figure with a side panel of readouts: beside it when there is room, under it otherwise. */
export function llStage(fig: HTMLElement, side: Child[] = [], sideMin?: string): HTMLElement {
  const el = h('div', { class: 'll-stage' }, fig, side.length ? h('div', { class: 'll-side' }, ...side) : false);
  if (sideMin) el.style.setProperty('--ll-side-min', sideMin);
  return el;
}
