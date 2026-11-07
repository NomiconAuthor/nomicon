// The rendering section's claims: one module per lesson (claims/render/<slug>.ts, default export),
// listed here once. `npm run check-lessons -- render` runs them all (it's in the fast set run by
// `npm test`); `npm run check-lessons -- render/<slug>` runs one lesson's.
import pipeline from './the-pipeline';
import rasterisation from './rasterisation';
import depth from './depth';
import textures from './textures-and-sampling';
import blending from './blending-and-transparency';
import shaders from './how-shaders-run';
import sameFrame from './same-frame-real-gpu';
import batching from './batching-and-instancing';
import culling from './culling';
import renderGraphs from './render-graphs';
import gpuDriven from './gpu-driven-rendering';
import textureAtlases from './texture-atlases';
import nanite from './nanite-in-brief';
import fdc from './forward-deferred-clustered';
import pbr from './physically-based-shading';
import shadowMaps from './shadow-maps';
import postProcessing from './post-processing';
import overdraw from './overdraw-and-fill-rate';
import bandwidth from './bandwidth';
import timingTheGpu from './timing-the-gpu';
import framePipeline from './cpu-gpu-frame-pipeline';

const LESSONS: Record<string, () => void | Promise<void>> = {
  'the-pipeline': pipeline,
  rasterisation,
  depth,
  'textures-and-sampling': textures,
  'blending-and-transparency': blending,
  'how-shaders-run': shaders,
  'same-frame-real-gpu': sameFrame,
  'batching-and-instancing': batching,
  culling,
  'render-graphs': renderGraphs,
  'gpu-driven-rendering': gpuDriven,
  'texture-atlases': textureAtlases,
  'nanite-in-brief': nanite,
  'forward-deferred-clustered': fdc,
  'physically-based-shading': pbr,
  'shadow-maps': shadowMaps,
  'post-processing': postProcessing,
  'overdraw-and-fill-rate': overdraw,
  bandwidth,
  'timing-the-gpu': timingTheGpu,
  'cpu-gpu-frame-pipeline': framePipeline,
};

/** One claims group per lesson, named render/<slug>. */
export const RENDER_LESSONS: Record<string, () => void | Promise<void>> = Object.fromEntries(Object.entries(LESSONS).map(([slug, f]) => [`render/${slug}`, f]));

/** Every rendering lesson's claims (the `render` group). */
export async function rendering(): Promise<void> {
  for (const f of Object.values(LESSONS)) await f();
}
