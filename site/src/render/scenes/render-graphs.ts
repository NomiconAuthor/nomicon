/**
 * "Render graphs": a small render graph compiler, the model behind the lesson's widget. No DOM, no
 * GPU, so the claims run it in Node.
 *
 * A frame is declared as passes that say which resources they read and write and how (as a render
 * target, sampled in a shader, as a storage image, as depth). compile() then does what Frostbite's
 * FrameGraph, Unreal's RDG and others do, in the simplest form that shows each step:
 *
 *   1. versions   every write makes a new version of a resource; a read sees the latest one
 *   2. cull       keep only passes whose results reach the backbuffer, walking back from it
 *                 (and a write to the TAA history, if what it copies is kept)
 *   3. order      the passes that are left, in declaration order (a valid order, since reads see
 *                 earlier writes), with each pass's dependency level: passes on the same level
 *                 don't depend on each other
 *   4. barriers   per resource, its state after each use; a use in a different state needs a
 *                 transition before the pass, and all of a pass's transitions go in one call
 *   5. lifetimes  each transient resource lives from its first use to its last
 *   6. aliasing   place transients in one heap, first fit by first use, sharing memory with
 *                 resources whose lifetimes have ended (each reuse needs an aliasing barrier)
 */

export type Use = 'colour' | 'depth-write' | 'depth-read' | 'sampled' | 'storage' | 'copy-src' | 'copy-dst' | 'present';
export const USE_LABEL: Record<Use, string> = {
  colour: 'render target',
  'depth-write': 'depth write',
  'depth-read': 'depth test',
  sampled: 'shader read',
  storage: 'storage',
  'copy-src': 'copy source',
  'copy-dst': 'copy dest.',
  present: 'present',
};

export interface Resource {
  name: string;
  format: string;
  /** Bytes per pixel. */
  bpp: number;
  /** Size: the screen scaled by this, or a fixed square. */
  scale?: number;
  fixed?: number;
  /** Lives outside the graph (the backbuffer, history): never culled away, never aliased. */
  imported?: boolean;
}
export interface Access {
  res: string;
  use: Use;
  /** A render target that keeps what's there (loadOp 'load'): it reads the previous version too. */
  load?: boolean;
}
export interface Pass {
  name: string;
  queue: 'graphics' | 'compute' | 'copy';
  reads: Access[];
  writes: Access[];
}

export interface FrameOptions {
  ssao: boolean;
  bloom: boolean;
  taa: boolean;
  transparent: boolean;
  /** What reaches the screen: the final image, or the G-buffer's normals (a debug view). */
  output: 'final' | 'normals';
}
export const FRAME_DEFAULTS: FrameOptions = { ssao: true, bloom: true, taa: true, transparent: true, output: 'final' };

export const RESOURCES: Resource[] = [
  { name: 'shadow map', format: 'depth32float', bpp: 4, fixed: 2048 },
  { name: 'depth', format: 'depth32float', bpp: 4, scale: 1 },
  { name: 'albedo', format: 'rgba8unorm', bpp: 4, scale: 1 },
  { name: 'normals', format: 'rgb10a2unorm', bpp: 4, scale: 1 },
  { name: 'material', format: 'rgba8unorm', bpp: 4, scale: 1 },
  { name: 'motion', format: 'rg16float', bpp: 4, scale: 1 },
  { name: 'AO, raw', format: 'r8unorm', bpp: 1, scale: 1 },
  { name: 'AO', format: 'r8unorm', bpp: 1, scale: 1 },
  { name: 'HDR', format: 'rgba16float', bpp: 8, scale: 1 },
  { name: 'bloom A', format: 'rgba16float', bpp: 8, scale: 0.5 },
  { name: 'bloom B', format: 'rgba16float', bpp: 8, scale: 0.5 },
  { name: 'TAA out', format: 'rgba16float', bpp: 8, scale: 1 },
  { name: 'debug', format: 'rgba8unorm', bpp: 4, scale: 1 },
  { name: 'history', format: 'rgba16float', bpp: 8, scale: 1, imported: true },
  { name: 'backbuffer', format: 'rgba8unorm', bpp: 4, scale: 1, imported: true },
];
export const resource = (name: string) => RESOURCES.find((r) => r.name === name)!;
/** The resource that reaches the screen. */
export const OUTPUT = 'backbuffer';

const r = (res: string, use: Use, load = false): Access => ({ res, use, load });

/**
 * The frame, as setup code would declare it: passes of effects that are off aren't declared at
 * all; passes whose output nobody uses (motion vectors without TAA, the debug view) are declared
 * anyway and left to the compiler to cull.
 */
export function declare(o: FrameOptions): Pass[] {
  const p: Pass[] = [];
  p.push({ name: 'Shadow map', queue: 'graphics', reads: [], writes: [r('shadow map', 'depth-write')] });
  p.push({ name: 'Depth prepass', queue: 'graphics', reads: [], writes: [r('depth', 'depth-write')] });
  p.push({ name: 'G-buffer', queue: 'graphics', reads: [r('depth', 'depth-read')], writes: [r('albedo', 'colour'), r('normals', 'colour'), r('material', 'colour')] });
  p.push({ name: 'Motion vectors', queue: 'graphics', reads: [r('depth', 'sampled')], writes: [r('motion', 'colour')] });
  if (o.ssao) {
    p.push({ name: 'SSAO', queue: 'compute', reads: [r('depth', 'sampled'), r('normals', 'sampled')], writes: [r('AO, raw', 'storage')] });
    p.push({ name: 'SSAO blur', queue: 'compute', reads: [r('AO, raw', 'sampled'), r('depth', 'sampled')], writes: [r('AO', 'storage')] });
  }
  p.push({
    name: 'Lighting',
    queue: 'compute',
    reads: [r('albedo', 'sampled'), r('normals', 'sampled'), r('material', 'sampled'), r('depth', 'sampled'), r('shadow map', 'sampled'), ...(o.ssao ? [r('AO', 'sampled')] : [])],
    writes: [r('HDR', 'storage')],
  });
  p.push({ name: 'Sky', queue: 'graphics', reads: [r('depth', 'depth-read')], writes: [r('HDR', 'colour', true)] });
  if (o.transparent) p.push({ name: 'Transparent', queue: 'graphics', reads: [r('depth', 'depth-read'), r('shadow map', 'sampled')], writes: [r('HDR', 'colour', true)] });
  if (o.bloom) {
    p.push({ name: 'Bloom down', queue: 'graphics', reads: [r('HDR', 'sampled')], writes: [r('bloom A', 'colour')] });
    p.push({ name: 'Bloom blur', queue: 'graphics', reads: [r('bloom A', 'sampled')], writes: [r('bloom B', 'colour')] });
  }
  let final = 'HDR';
  if (o.taa) {
    p.push({ name: 'TAA', queue: 'graphics', reads: [r('HDR', 'sampled'), r('motion', 'sampled'), r('history', 'sampled')], writes: [r('TAA out', 'colour')] });
    p.push({ name: 'Copy to history', queue: 'copy', reads: [r('TAA out', 'copy-src')], writes: [r('history', 'copy-dst')] });
    final = 'TAA out';
  }
  p.push({ name: 'Debug view', queue: 'graphics', reads: [r('normals', 'sampled')], writes: [r('debug', 'colour')] });
  p.push({
    name: 'Tone map and UI',
    queue: 'graphics',
    reads: [r(o.output === 'final' ? final : 'debug', 'sampled'), ...(o.bloom && o.output === 'final' ? [r('bloom B', 'sampled')] : [])],
    writes: [r('backbuffer', 'colour')],
  });
  return p;
}

// ---------------------------------------------------------------------------------------------

export interface Barrier {
  res: string;
  from: Use | 'undefined';
  to: Use;
}
export interface CompiledPass {
  pass: Pass;
  /** Index in declaration order. */
  index: number;
  culled: boolean;
  /** Longest chain of dependencies before it (0: depends on nothing). Executed passes only. */
  level: number;
  /** Passes it depends on (declaration indices). */
  deps: number[];
  /** Transitions recorded before it, in one call. */
  barriers: Barrier[];
  /** Transient resources whose memory it reuses: one aliasing barrier each. */
  aliasing: string[];
}
export interface Placement {
  res: string;
  bytes: number;
  offset: number;
  /** First and last use, as positions in the executed order. */
  first: number;
  last: number;
}
export interface Compiled {
  passes: CompiledPass[];
  /** Executed passes, in order (declaration indices). */
  order: number[];
  placements: Placement[];
  /** Sum of every transient's size: what you'd allocate without aliasing. */
  totalBytes: number;
  /** The heap's high-water mark with aliasing. */
  peakBytes: number;
  transitions: number;
  /** Barrier calls: one per pass that needs any. */
  barrierCalls: number;
  aliasingBarriers: number;
  /** Transients the culled passes would have used and nobody else does. */
  culledResources: string[];
}

export const SCREENS: Record<string, [number, number]> = { '1080p': [1920, 1080], '4K': [3840, 2160] };
/** Heap placements are aligned like D3D12's default placement alignment (64 KB). */
export const ALIGN = 65536;
const align = (x: number) => Math.ceil(x / ALIGN) * ALIGN;

export function bytesOf(res: Resource, w: number, h: number): number {
  if (res.fixed) return res.fixed * res.fixed * res.bpp;
  return Math.round(w * (res.scale ?? 1)) * Math.round(h * (res.scale ?? 1)) * res.bpp;
}

export function compile(passes: Pass[], w = 1920, h = 1080, aliasing = true): Compiled {
  // 1. Versions: who wrote the version each read sees.
  const writer = new Map<string, number>();
  const deps: number[][] = passes.map(() => []);
  passes.forEach((p, i) => {
    for (const a of [...p.reads, ...p.writes.filter((x) => x.load)]) {
      const wr = writer.get(a.res);
      if (wr !== undefined && !deps[i].includes(wr)) deps[i].push(wr);
    }
    for (const a of p.writes) writer.set(a.res, i);
  });
  // 2. Cull: start from the passes that write the output (the backbuffer), walk back through dependencies.
  const live = passes.map(() => false);
  const stack = passes.map((p, i) => (p.writes.some((a) => a.res === OUTPUT) ? i : -1)).filter((i) => i >= 0);
  while (stack.length) {
    const i = stack.pop()!;
    if (live[i]) continue;
    live[i] = true;
    stack.push(...deps[i]);
  }
  // Writes to other imported resources (the TAA history) are kept if everything they need runs anyway.
  passes.forEach((p, i) => {
    if (!live[i] && p.writes.some((a) => resource(a.res).imported) && deps[i].every((d) => live[d])) live[i] = true;
  });
  // 3. Order and dependency levels.
  const order = passes.map((_, i) => i).filter((i) => live[i]);
  const level = passes.map(() => 0);
  for (const i of order) level[i] = deps[i].length ? Math.max(...deps[i].map((d) => level[d] + 1)) : 0;
  // 4. Barriers: each resource's state as the executed passes use it.
  const state = new Map<string, Use | 'undefined'>();
  const out: CompiledPass[] = passes.map((pass, index) => ({ pass, index, culled: !live[index], level: live[index] ? level[index] : 0, deps: deps[index], barriers: [], aliasing: [] }));
  for (const i of order) {
    const p = passes[i];
    for (const a of [...p.reads, ...p.writes]) {
      // Imported resources start the frame as the last frame left them.
      const prev = state.get(a.res) ?? (resource(a.res).imported ? (a.res === 'backbuffer' ? 'present' : 'copy-dst') : 'undefined');
      // A change of state needs a transition; storage used again after storage needs one too (a UAV barrier).
      if (prev !== a.use || a.use === 'storage') out[i].barriers.push({ res: a.res, from: prev, to: a.use });
      state.set(a.res, a.use);
    }
  }
  // The backbuffer goes back to "present" after the last pass.
  const tail: Barrier[] = state.get('backbuffer') && state.get('backbuffer') !== 'present' ? [{ res: 'backbuffer', from: state.get('backbuffer')!, to: 'present' }] : [];
  // 5. Lifetimes of transients, as positions in the executed order.
  const life = new Map<string, { first: number; last: number }>();
  order.forEach((i, pos) => {
    const p = passes[i];
    for (const a of [...p.reads, ...p.writes]) {
      if (resource(a.res).imported) continue;
      const l = life.get(a.res);
      if (l) l.last = pos;
      else life.set(a.res, { first: pos, last: pos });
    }
  });
  // 6. Placement: first fit, by first use.
  const placements: Placement[] = [];
  const byFirst = [...life.entries()].sort((a, b) => a[1].first - b[1].first || RESOURCES.findIndex((x) => x.name === a[0]) - RESOURCES.findIndex((x) => x.name === b[0]));
  let total = 0;
  for (const [name, l] of byFirst) {
    const bytes = align(bytesOf(resource(name), w, h));
    total += bytes;
    let offset = 0;
    if (aliasing) {
      // Lowest offset that doesn't overlap any placed resource whose lifetime overlaps this one's.
      const busy = placements.filter((p) => !(p.last < l.first || p.first > l.last)).sort((a, b) => a.offset - b.offset);
      for (const b of busy) {
        if (offset + bytes <= b.offset) break;
        offset = Math.max(offset, b.offset + b.bytes);
      }
      // Memory last used by a resource that has finished: an aliasing barrier at first use.
      const reused = placements.filter((p) => p.last < l.first && p.offset < offset + bytes && offset < p.offset + p.bytes);
      if (reused.length) out[order[l.first]].aliasing.push(name);
    } else offset = placements.reduce((m, p) => Math.max(m, p.offset + p.bytes), 0);
    placements.push({ res: name, bytes, offset, first: l.first, last: l.last });
  }
  const peak = placements.reduce((m, p) => Math.max(m, p.offset + p.bytes), 0);
  const used = new Set(order.flatMap((i) => [...passes[i].reads, ...passes[i].writes].map((a) => a.res)));
  const culledResources = [...new Set(passes.filter((_, i) => !live[i]).flatMap((p) => [...p.reads, ...p.writes].map((a) => a.res)))].filter((n) => !used.has(n) && !resource(n).imported);
  const transitions = out.reduce((s, p) => s + p.barriers.length, 0) + tail.length;
  const barrierCalls = out.filter((p) => !p.culled && p.barriers.length).length + (tail.length ? 1 : 0);
  return {
    passes: out,
    order,
    placements,
    totalBytes: total,
    peakBytes: peak,
    transitions,
    barrierCalls,
    aliasingBarriers: out.reduce((s, p) => s + p.aliasing.length, 0),
    culledResources,
  };
}

/** Megabytes for the text: 1 MB = 1,048,576 bytes. */
export const mbText = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
