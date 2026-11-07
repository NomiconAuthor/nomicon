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
  texture: () => import('./lessons/textures-and-sampling').then((m) => m.TextureViz),
  'blend-sort': () => import('./lessons/blending-and-transparency').then((m) => m.SortViz),
  'blend-edges': () => import('./lessons/blending-and-transparency').then((m) => m.EdgeViz),
  'blend-fence': () => import('./lessons/blending-and-transparency').then((m) => m.FenceViz),
  waves: () => import('./lessons/how-shaders-run').then((m) => m.WaveViz),
  quads: () => import('./lessons/how-shaders-run').then((m) => m.QuadViz),
  occupancy: () => import('./lessons/how-shaders-run').then((m) => m.OccupancyViz),
  'gpu-frame': () => import('./lessons/same-frame-real-gpu').then((m) => m.SameFrameViz),
  'gpu-inspector': () => import('./lessons/same-frame-real-gpu').then((m) => m.GpuInspectorViz),
  'atlas-pack': () => import('./lessons/texture-atlases').then((m) => m.PackViz),
  'atlas-bleed': () => import('./lessons/texture-atlases').then((m) => m.BleedViz),
  'nanite-lod': () => import('./lessons/nanite-in-brief').then((m) => m.ClusterLodViz),
  'nanite-quads': () => import('./lessons/nanite-in-brief').then((m) => m.QuadViz),
  batching: () => import('./lessons/batching-and-instancing').then((m) => m.BatchViz),
  culling: () => import('./lessons/culling').then((m) => m.CullViz),
  'render-graph': () => import('./lessons/render-graphs').then((m) => m.GraphViz),
  'gpu-driven': () => import('./lessons/gpu-driven-rendering').then((m) => m.DrivenViz),
  lights: () => import('./lessons/forward-deferred-clustered').then((m) => m.LightsViz),
  pbr: () => import('./lessons/physically-based-shading').then((m) => m.PbrViz),
  shadows: () => import('./lessons/shadow-maps').then((m) => m.ShadowViz),
  post: () => import('./lessons/post-processing').then((m) => m.PostViz),
  'fill-rate': () => import('./lessons/overdraw-and-fill-rate').then((m) => m.FillViz),
  bandwidth: () => import('./lessons/bandwidth').then((m) => m.BandwidthViz),
  'gpu-timing': () => import('./lessons/timing-the-gpu').then((m) => m.TimingViz),
  'frame-pipeline': () => import('./lessons/cpu-gpu-frame-pipeline').then((m) => m.PipelineTimelineViz),
} satisfies Record<string, () => Promise<Widget>>;

export type WidgetKind = keyof typeof WIDGETS;
