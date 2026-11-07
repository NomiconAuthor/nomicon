/**
 * The size budget for the AI section's maps (influence, knowledge, party, recast) and the layout
 * that puts readouts beside them. ai.css has the CSS half (.ai-fit, .ai-stage, .ai-side).
 *
 * A map is drawn in cells, at S px a cell (CSS pixels; the backing store is S × devicePixelRatio).
 * S is chosen so the whole map fits FIT_W wide (or the column, if narrower) and FIT_VH of the
 * window tall. Once the widget is FIT_WIDE px wide, the map sits beside a side panel of at least
 * FIT_SIDE px, so the readouts are on screen with it; below that, the side panel goes under it.
 */
export const FIT_W = 640;
export const FIT_VH = 0.6;
/** Keep in step with ai.css (@container aifit (min-width: 880px)). */
export const FIT_WIDE = 880;
export const FIT_SIDE = 256;
export const FIT_GAP = 14;

/** Is a widget this wide laid out with the side panel beside the map? */
export const isWide = (rootWidth: number) => rootWidth >= FIT_WIDE;

/** The width a map may take in this widget root: the column, less the side panel when wide, capped at maxW. */
export function figWidth(root: HTMLElement, maxW = FIT_W): number {
  const cs = getComputedStyle(root);
  // The content box, which is what the container query measures.
  const w = root.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
  return Math.max(0, Math.min(maxW, isWide(w) ? w - FIT_SIDE - FIT_GAP : w));
}

export interface ScaleOpts {
  /** Smallest cell, px (the map scrolls sideways rather than shrinking past it). */
  min?: number;
  /** Largest cell, px. */
  max?: number;
  /** Whole pixels per cell. */
  int?: boolean;
  /** Height budget in px (default FIT_VH of the window), less any fixed rows drawn under the map. */
  maxH?: number;
}

/** Pixels per cell for a cols × rows map that has availW px of width. */
export function cellScale(availW: number, cols: number, rows: number, o: ScaleOpts = {}): number {
  const maxH = o.maxH ?? FIT_VH * (window.innerHeight || 800);
  let S = Math.min(availW / cols, maxH / rows);
  if (o.int) S = Math.floor(S);
  if (o.max !== undefined) S = Math.min(S, o.max);
  if (o.min !== undefined) S = Math.max(S, o.min);
  return S;
}

/**
 * Font size, in backing pixels, for text on a canvas with a fixed backing store (the arenas, the
 * steering canvases), so it shows at least minCss px however small the canvas is displayed.
 */
export function textPx(cnv: HTMLCanvasElement, base: number, minCss = 10.5): number {
  const w = cnv.clientWidth;
  return w ? Math.max(base, (minCss * cnv.width) / w) : base;
}
