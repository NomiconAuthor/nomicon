/**
 * The planned outline of the rendering section. Written lessons are listed by slug (their title
 * and summary come from the MDX frontmatter); the rest are shown on the index as "coming".
 * The index page fails the build if a lesson in pages/rendering/ is missing from this list.
 *
 * Code layout: the concept lessons run the teaching rasteriser in this folder (raster.ts); the
 * later lessons will run on the real GPU through WebGPU, with a WebGL2 fallback, in src/render/gpu/.
 */
export interface Planned {
  /** The lesson's file name in pages/rendering/, once it's written. */
  slug?: string;
  title: string;
  summary: string;
}
export interface Part {
  name: string;
  /** What the lessons in this part run on. */
  runs: string;
  lessons: Planned[];
}

export const OUTLINE: Part[] = [
  {
    name: 'Pipeline fundamentals',
    runs: 'A software rasteriser written for the site, which you can pause after any vertex, triangle or pixel.',
    lessons: [
      { slug: 'the-pipeline', title: 'The pipeline and the draw call', summary: '' },
      { slug: 'rasterisation', title: 'Rasterisation', summary: '' },
      { slug: 'depth', title: 'Depth', summary: '' },
      { slug: 'textures-and-sampling', title: 'Textures and sampling', summary: 'Texels to pixels: filtering, mipmaps and how the GPU picks a level from 2 × 2 quads and their derivatives, anisotropic filtering, and texture compression (BC, ASTC).' },
      { slug: 'blending-and-transparency', title: 'Blending and transparency', summary: 'The blend equation, premultiplied alpha, why transparent things need sorting, alpha test against alpha to coverage, and order-independent transparency in brief.' },
      { slug: 'how-shaders-run', title: 'How shaders run', summary: 'Waves and warps: one instruction stream for 32 or 64 lanes, divergent branches, registers and occupancy, and why tiny triangles waste work in 2 × 2 quads.' },
    ],
  },
  {
    name: 'Engine-side rendering',
    runs: 'The real GPU, through WebGPU (WebGL2 where WebGPU is missing); the render-graph, texture-atlas and Nanite lessons run their models on the CPU.',
    lessons: [
      { slug: 'same-frame-real-gpu', title: 'The same frame on a real GPU', summary: 'The concept lessons\' scene through WebGPU: devices, pipelines, bind groups, command encoders and queues, and what the driver does with a draw call.' },
      { slug: 'batching-and-instancing', title: 'Batching and instancing', summary: 'Why draw calls cost CPU time, sorting by state with sort keys, merging static geometry, instanced draws, and what each saves.' },
      { slug: 'culling', title: 'Culling', summary: 'Frustum culling with bounding volumes, occlusion culling with a hierarchical Z-buffer and with occlusion queries, LOD selection, and the frame of latency each one can add.' },
      { slug: 'render-graphs', title: 'Render graphs', summary: 'Describing a frame as passes that read and write resources, so the engine can order them, insert barriers, cull unused passes and alias transient memory.' },
      { slug: 'gpu-driven-rendering', title: 'GPU-driven rendering', summary: 'Moving culling and draw submission onto the GPU: indirect draws, compute culling, bindless resources, and where mesh shaders fit.' },
      { slug: 'texture-atlases', title: 'Quirky solutions: texture atlases for 2D sprites', summary: 'Packing many sprites into one texture: shelf, skyline, guillotine and MaxRects packers, bleeding at the edges and why padding and extrusion fix it, and what mipmaps do to an atlas.' },
      { slug: 'nanite-in-brief', title: 'Quirky solutions: Nanite in brief', summary: 'Unreal\'s virtualised geometry: clusters of 128 triangles in a DAG of levels of detail, software rasterisation of small triangles in compute, a visibility buffer written with 64-bit atomics. Why people get excited, and what it costs: big source assets (the format is compact, but it invites film-density meshes), overdraw on aggregates such as foliage (what the newer Nanite Foliage works around), and occlusion that leans on last frame\'s depth.' },
    ],
  },
  {
    name: 'Lighting and shading',
    runs: 'The real GPU, through WebGPU (WebGL2 where WebGPU is missing).',
    lessons: [
      { slug: 'forward-deferred-clustered', title: 'Forward, deferred and clustered', summary: 'Where lighting happens: forward shading, G-buffers and deferred lighting, tiled and clustered light lists, and what each costs in bandwidth, MSAA and transparency.' },
      { slug: 'physically-based-shading', title: 'Physically based shading', summary: 'Microfacet BRDFs in practice: albedo, metalness and roughness, Fresnel, energy conservation, and image-based lighting.' },
      { slug: 'shadow-maps', title: 'Shadow maps', summary: 'Rendering depth from the light, shadow acne and peter-panning, depth bias and slope-scaled bias, filtering with PCF, and cascades for big scenes.' },
      { slug: 'post-processing', title: 'Post-processing', summary: 'HDR targets, exposure and tone mapping, bloom, temporal anti-aliasing and upscaling, and the order the passes run in.' },
    ],
  },
  {
    name: 'Performance and profiling',
    runs: 'The real GPU, through WebGPU (WebGL2 where WebGPU is missing), with timings from your machine; the frame-pipeline lesson is a model, the same everywhere.',
    lessons: [
      { slug: 'overdraw-and-fill-rate', title: 'Overdraw and fill rate', summary: 'Measuring how many times each pixel is shaded, and the usual fixes: sorting, prepasses, smaller particles and cheaper shaders.' },
      { slug: 'bandwidth', title: 'Bandwidth', summary: 'Render-target formats and their bytes per pixel, framebuffer compression, and tile-based GPUs, where keeping data on chip is the whole game.' },
      { slug: 'timing-the-gpu', title: 'Timing the GPU', summary: 'Why CPU timers can\'t see GPU work, timestamp queries, and what PIX, RenderDoc, Nsight and Radeon GPU Profiler show.' },
      { slug: 'cpu-gpu-frame-pipeline', title: 'The CPU–GPU frame pipeline', summary: 'Frames in flight, present modes and vsync, where input latency comes from, and how engines cut it.' },
    ],
  },
];
