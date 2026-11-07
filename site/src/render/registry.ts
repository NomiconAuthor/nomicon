/**
 * Every rendering widget, by the `kind` a lesson passes to <RenderWidget kind="..." />. Each entry
 * loads its lesson's module (lessons/<slug>.ts) only when a page uses it. To add a widget, export a
 * class from your lesson's module whose constructor takes the host element, and add one line here.
 */
export type Widget = new (host: HTMLElement) => unknown;

export const WIDGETS = {
  pipeline: () => import('./lessons/the-pipeline').then((m) => m.PipelineViz),
  raster: () => import('./lessons/rasterisation').then((m) => m.RasterViz),
  perspective: () => import('./lessons/rasterisation').then((m) => m.PerspectiveViz),
  depth: () => import('./lessons/depth').then((m) => m.DepthViz),
  overdraw: () => import('./lessons/depth').then((m) => m.OverdrawViz),
} satisfies Record<string, () => Promise<Widget>>;

export type WidgetKind = keyof typeof WIDGETS;
