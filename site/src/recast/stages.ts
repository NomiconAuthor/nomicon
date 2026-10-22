/**
 * Recast's build pipeline, one stage at a time, on a small 3D test scene, with the
 * intermediate data read back out of WebAssembly after each stage so it can be drawn.
 * This is the real Recast (recast-navigation), not an imitation.
 */
import {
  RecastBuildContext,
  TriangleAreasArray,
  TrianglesArray,
  VerticesArray,
  allocCompactHeightfield,
  allocContourSet,
  allocHeightfield,
  allocPolyMesh,
  allocPolyMeshDetail,
  buildCompactHeightfield,
  buildContours,
  buildDistanceField,
  buildLayerRegions,
  buildPolyMesh,
  buildPolyMeshDetail,
  buildRegions,
  buildRegionsMonotone,
  createHeightfield,
  erodeWalkableArea,
  filterLedgeSpans,
  filterLowHangingWalkableObstacles,
  filterWalkableLowHeightSpans,
  freeCompactHeightfield,
  freeContourSet,
  freeHeightfield,
  freePolyMesh,
  freePolyMeshDetail,
  markWalkableTriangles,
  rasterizeTriangles,
  Raw,
  Recast,
} from 'recast-navigation';
import { loadRecast } from '../lab/rep/navmesh';

export { loadRecast };

// ------------------------------------------------------------------------------------------
// The scene: a floor with things that exercise every stage

export interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y0: number;
  y1: number;
  label?: string;
}
export const SCENE_W = 24;
export const SCENE_D = 16;
export const BOXES: Box[] = [
  { x0: 6, z0: 0, x1: 6.4, z1: 10, y0: 0, y1: 2.5, label: 'wall' },
  { x0: 3, z0: 4.4, x1: 5, z1: 6.6, y0: 0, y1: 2.5, label: 'gap 0.8 m' },
  { x0: 3, z0: 7.4, x1: 5, z1: 10, y0: 0, y1: 2.5 },
  { x0: 9, z0: 2, x1: 10, z1: 6, y0: 0, y1: 0.2, label: 'steps' },
  { x0: 10, z0: 2, x1: 11, z1: 6, y0: 0, y1: 0.4 },
  { x0: 11, z0: 2, x1: 12, z1: 6, y0: 0, y1: 0.6 },
  { x0: 12, z0: 2, x1: 15, z1: 6, y0: 0, y1: 0.8, label: 'platform' },
  { x0: 15.6, z0: 9, x1: 20, z1: 13, y0: 1.2, y1: 1.4, label: 'table' },
  { x0: 8, z0: 12.6, x1: 13, z1: 12.9, y0: 0, y1: 0.3, label: 'kerb' },
  { x0: 1, z0: 12, x1: 2.6, z1: 15, y0: 0, y1: 1.0, label: 'crate' },
  { x0: 16, z0: 2, x1: 17, z1: 3, y0: 0, y1: 2.5, label: 'pillar' },
  { x0: 19, z0: 4, x1: 20, z1: 5, y0: 0, y1: 2.5 },
];
/** A ramp up to the table (walkable) and a steep one by the crate (not). */
export const RAMPS = [
  { x0: 20, x1: 23, z0: 9, z1: 13, yAt0: 1.4, yAt1: 0, label: 'ramp' },
  { x0: 2.6, x1: 3.4, z0: 12, z1: 15, yAt0: 1.0, yAt1: 0, label: 'too steep' },
];

function sceneGeometry(): { positions: number[]; indices: number[] } {
  const P: number[] = [];
  const I: number[] = [];
  const v = (x: number, y: number, z: number) => (P.push(x, y, z), P.length / 3 - 1);
  // A quad a-b-c-d with the triangles' winding giving an upward normal for a floor
  // (Recast only cares about winding for walkable surfaces; it rasterises both sides).
  const quad = (a: number, b: number, c: number, d: number) => I.push(a, b, c, a, c, d);
  // Floor, in strips so it has enough vertices to rasterise cleanly.
  for (let x = 0; x < SCENE_W; x += 4)
    for (let z = 0; z < SCENE_D; z += 4) quad(v(x, 0, z), v(x, 0, z + 4), v(x + 4, 0, z + 4), v(x + 4, 0, z));
  for (const b of BOXES) {
    const t = [v(b.x0, b.y1, b.z0), v(b.x0, b.y1, b.z1), v(b.x1, b.y1, b.z1), v(b.x1, b.y1, b.z0)];
    quad(t[0], t[1], t[2], t[3]);
    const g = [v(b.x0, b.y0, b.z0), v(b.x0, b.y0, b.z1), v(b.x1, b.y0, b.z1), v(b.x1, b.y0, b.z0)];
    for (let k = 0; k < 4; k++) quad(g[k], g[(k + 1) % 4], t[(k + 1) % 4], t[k]);
    if (b.y0 > 0) quad(g[3], g[2], g[1], g[0]); // underside of a floating slab
  }
  for (const r of RAMPS) {
    const a = v(r.x0, r.yAt0, r.z0);
    const b = v(r.x0, r.yAt0, r.z1);
    const c = v(r.x1, r.yAt1, r.z1);
    const d = v(r.x1, r.yAt1, r.z0);
    quad(a, b, c, d);
    // The tall end.
    const a0 = v(r.x0, 0, r.z0);
    const b0 = v(r.x0, 0, r.z1);
    quad(a0, b0, b, a);
  }
  return { positions: P, indices: I };
}

// ------------------------------------------------------------------------------------------
// Running the pipeline and reading every stage back

export type RegionMode = 'watershed' | 'monotone' | 'layers';
export interface StageOptions {
  radius: number; // metres
  regions: RegionMode;
  maxError: number; // contour simplification, in cells
  maxVerts: number; // per polygon
}
export const DEFAULT_OPTIONS: StageOptions = { radius: 0.6, regions: 'watershed', maxError: 1.3, maxVerts: 6 };

export const CS = 0.25;
export const CH = 0.1;
export const AGENT_HEIGHT = 2.0;
export const AGENT_CLIMB = 0.4;
export const SLOPE = 45;

/** One column's spans in the heightfield: [smin, smax, area] in voxel units. */
export type SpanList = Array<[number, number, number]>;

export interface Stages {
  w: number;
  h: number;
  bmin: [number, number, number];
  /** Triangles with their walkable flag (stage 1). */
  tris: Array<{ p: number[]; walkable: boolean }>;
  /** Heightfield spans per column after rasterising, and after each filter. */
  spans: SpanList[];
  afterLowHanging: SpanList[];
  afterLedge: SpanList[];
  afterLowHeight: SpanList[];
  /** Compact heightfield: open spans per column, [y, h, spanIndex]. */
  cells: Array<Array<[number, number, number]>>;
  areasBeforeErode: Uint8Array;
  areas: Uint8Array;
  dist: Uint16Array;
  maxDist: number;
  regs: Uint16Array;
  nregs: number;
  /** Contours: raw and simplified vertex lists in cell coordinates, per region. */
  contours: Array<{ reg: number; raw: number[][]; simple: number[][] }>;
  polys: number[][][]; // per polygon, its vertices as [x, y, z] in cell units
  polyRegs: number[];
  detailTris: number[][][]; // world-space triangles
  ms: Record<string, number>;
  counts: Record<string, number>;
}

function readSpans(hf: ReturnType<typeof allocHeightfield>): SpanList[] {
  const out: SpanList[] = [];
  const n = hf.width() * hf.height();
  for (let i = 0; i < n; i++) {
    const list: SpanList = [];
    let s: ReturnType<typeof hf.spans> | null = hf.spans(i);
    // An empty column holds a null pointer.
    while (s && !Raw.isNull(s.raw)) {
      list.push([s.smin(), s.smax(), s.area()]);
      s = s.next();
    }
    out.push(list);
  }
  return out;
}

export async function runStages(o: StageOptions): Promise<Stages> {
  await loadRecast();
  const ms: Record<string, number> = {};
  let t = performance.now();
  const lap = (k: string) => {
    const n = performance.now();
    ms[k] = n - t;
    t = n;
  };
  const { positions, indices } = sceneGeometry();
  const verts = new VerticesArray();
  verts.copy(positions);
  const tris = new TrianglesArray();
  tris.copy(indices);
  const nv = positions.length / 3;
  const nt = indices.length / 3;
  const ctx = new RecastBuildContext();
  const bmin: [number, number, number] = [-1, -0.5, -1];
  const bmax: [number, number, number] = [SCENE_W + 1, 4, SCENE_D + 1];
  const w = Math.ceil((bmax[0] - bmin[0]) / CS);
  const h = Math.ceil((bmax[2] - bmin[2]) / CS);
  const walkableHeight = Math.ceil(AGENT_HEIGHT / CH);
  const walkableClimb = Math.floor(AGENT_CLIMB / CH);
  const walkableRadius = Math.ceil(o.radius / CS);

  const hf = allocHeightfield();
  createHeightfield(ctx, hf, w, h, bmin, bmax, CS, CH);
  const areasArr = new TriangleAreasArray();
  areasArr.resize(nt);
  markWalkableTriangles(ctx, SLOPE, verts, nv, tris, nt, areasArr);
  const triOut: Stages['tris'] = [];
  for (let k = 0; k < nt; k++) {
    const p: number[] = [];
    for (let j = 0; j < 3; j++) {
      const vi = indices[k * 3 + j];
      p.push(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
    }
    triOut.push({ p, walkable: areasArr.get(k) !== 0 });
  }
  lap('mark');
  rasterizeTriangles(ctx, verts, nv, tris, areasArr, nt, hf, walkableClimb);
  lap('rasterise');
  const spans = readSpans(hf);
  filterLowHangingWalkableObstacles(ctx, walkableClimb, hf);
  const afterLowHanging = readSpans(hf);
  filterLedgeSpans(ctx, walkableHeight, walkableClimb, hf);
  const afterLedge = readSpans(hf);
  filterWalkableLowHeightSpans(ctx, walkableHeight, hf);
  const afterLowHeight = readSpans(hf);
  lap('filter');

  const chf = allocCompactHeightfield();
  buildCompactHeightfield(ctx, walkableHeight, walkableClimb, hf, chf);
  lap('compact');
  const nspans = chf.spanCount();
  const cells: Stages['cells'] = [];
  for (let i = 0; i < w * h; i++) {
    const c = chf.cells(i);
    const list: Array<[number, number, number]> = [];
    for (let k = c.index(), e = c.index() + c.count(); k < e; k++) {
      const sp = chf.spans(k);
      list.push([sp.y(), sp.h(), k]);
    }
    cells.push(list);
  }
  const areasBeforeErode = new Uint8Array(nspans);
  for (let k = 0; k < nspans; k++) areasBeforeErode[k] = chf.areas(k);
  erodeWalkableArea(ctx, walkableRadius, chf);
  const areas = new Uint8Array(nspans);
  for (let k = 0; k < nspans; k++) areas[k] = chf.areas(k);
  lap('erode');
  buildDistanceField(ctx, chf);
  const dist = new Uint16Array(nspans);
  for (let k = 0; k < nspans; k++) dist[k] = chf.dist(k);
  const maxDist = chf.maxDistance();
  lap('distance');
  const minRegionArea = 8 * 8;
  const mergeRegionArea = 10 * 10;
  if (o.regions === 'watershed') buildRegions(ctx, chf, 0, minRegionArea, mergeRegionArea);
  else if (o.regions === 'monotone') buildRegionsMonotone(ctx, chf, 0, minRegionArea, mergeRegionArea);
  else buildLayerRegions(ctx, chf, 0, minRegionArea);
  const regs = new Uint16Array(nspans);
  for (let k = 0; k < nspans; k++) regs[k] = chf.spans(k).reg();
  lap('regions');
  const cset = allocContourSet();
  buildContours(ctx, chf, o.maxError, Math.round(12 / CS), cset, Recast.RC_CONTOUR_TESS_WALL_EDGES);
  lap('contours');
  const contours: Stages['contours'] = [];
  for (let c = 0; c < cset.nconts(); c++) {
    const ct = cset.conts(c);
    const raw: number[][] = [];
    for (let k = 0; k < ct.nrverts(); k++) raw.push([ct.rverts(k * 4), ct.rverts(k * 4 + 1), ct.rverts(k * 4 + 2)]);
    const simple: number[][] = [];
    for (let k = 0; k < ct.nverts(); k++) simple.push([ct.verts(k * 4), ct.verts(k * 4 + 1), ct.verts(k * 4 + 2)]);
    contours.push({ reg: ct.reg(), raw, simple });
  }
  const pmesh = allocPolyMesh();
  buildPolyMesh(ctx, cset, o.maxVerts, pmesh);
  lap('polymesh');
  const polys: number[][][] = [];
  const polyRegs: number[] = [];
  const nvp = pmesh.nvp();
  for (let p = 0; p < pmesh.npolys(); p++) {
    const vs: number[][] = [];
    for (let j = 0; j < nvp; j++) {
      const vi = pmesh.polys(p * nvp * 2 + j);
      if (vi === 0xffff) break;
      vs.push([pmesh.verts(vi * 3), pmesh.verts(vi * 3 + 1), pmesh.verts(vi * 3 + 2)]);
    }
    polys.push(vs);
    polyRegs.push(pmesh.regs(p));
  }
  const dmesh = allocPolyMeshDetail();
  buildPolyMeshDetail(ctx, pmesh, chf, CS * 6, CH * 1, dmesh);
  lap('detail');
  const detailTris: number[][][] = [];
  for (let m = 0; m < dmesh.nmeshes(); m++) {
    const vb = dmesh.meshes(m * 4);
    const tb = dmesh.meshes(m * 4 + 2);
    const ntr = dmesh.meshes(m * 4 + 3);
    for (let k = 0; k < ntr; k++) {
      const tri: number[][] = [];
      for (let j = 0; j < 3; j++) {
        const vi = vb + dmesh.tris((tb + k) * 4 + j);
        tri.push([dmesh.verts(vi * 3), dmesh.verts(vi * 3 + 1), dmesh.verts(vi * 3 + 2)]);
      }
      detailTris.push(tri);
    }
  }
  let nregs = 0;
  for (let k = 0; k < nspans; k++) nregs = Math.max(nregs, regs[k]);
  const counts = {
    triangles: nt,
    spans: spans.reduce((a, l) => a + l.length, 0),
    compactSpans: nspans,
    regions: nregs,
    contours: cset.nconts(),
    rawVerts: contours.reduce((a, c) => a + c.raw.length, 0),
    simpleVerts: contours.reduce((a, c) => a + c.simple.length, 0),
    polys: pmesh.npolys(),
    detailTris: detailTris.length,
  };
  freePolyMeshDetail(dmesh);
  freePolyMesh(pmesh);
  freeContourSet(cset);
  freeCompactHeightfield(chf);
  freeHeightfield(hf);
  areasArr.destroy();
  verts.destroy();
  tris.destroy();
  return { w, h, bmin, tris: triOut, spans, afterLowHanging, afterLedge, afterLowHeight, cells, areasBeforeErode, areas, dist, maxDist, regs, nregs, contours, polys, polyRegs, detailTris, ms, counts };
}
