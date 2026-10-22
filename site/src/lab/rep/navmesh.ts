import {
  ChunkIdsArray,
  Detour,
  NavMesh,
  NavMeshCreateParams,
  NavMeshParams,
  NavMeshQuery,
  QueryFilter,
  Recast,
  RecastBuildContext,
  RecastChunkyTriMesh,
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
  buildPolyMesh,
  buildPolyMeshDetail,
  buildRegions,
  cloneRcConfig,
  createHeightfield,
  createNavMeshData,
  erodeWalkableArea,
  filterLedgeSpans,
  filterLowHangingWalkableObstacles,
  filterWalkableLowHeightSpans,
  freeCompactHeightfield,
  freeContourSet,
  freeHeightfield,
  freePolyMesh,
  freePolyMeshDetail,
  init as recastInit,
  markBoxArea,
  markWalkableTriangles,
  rasterizeTriangles,
  statusFailed,
  type FloatArray,
  type IntArray,
  type UnsignedCharArray,
} from 'recast-navigation';
import { buildTiledNavMeshRcConfig } from 'recast-navigation/generators';
import { TERRAINS, type GridLayer } from '../world/world';
import type { Rect } from './hpaGraph';
import type { Pt } from './types';

/**
 * Recast/Detour (compiled to WebAssembly) builds a tiled navmesh from the painted map:
 * every open cell becomes floor geometry, walls are holes in it. Recast voxelises the
 * floor, erodes it by the unit's radius and turns it into convex polygons per tile.
 *
 * Edits rebuild only the tiles they touch, like a game would. The polygons are then
 * read back out so this page can run its own A* over them (so the search can be
 * stepped) and a funnel pass to get the straight path. Detour's own query is run
 * too, as a cross-check.
 */

let ready: Promise<void> | null = null;
export function loadRecast(): Promise<void> {
  if (!ready) ready = recastInit();
  return ready;
}

export interface NavPoly {
  verts: Pt[];
  centroid: Pt;
  tile: number;
  /** Detour area id: 0 = plain ground, otherwise the terrain id (road, rough, mud, water). */
  area: number;
  /** Neighbour polygon index and the portal edge (left, right in Detour's winding). */
  links: Array<{ to: number; left: Pt; right: Pt }>;
}

export interface NavBuildInfo {
  ms: number;
  tilesBuilt: number;
  kind: string;
}

export class RecastNavmesh {
  navMesh: NavMesh;
  query: NavMeshQuery;
  polys: NavPoly[] = [];
  refToIndex = new Map<number, number>();
  indexToRef: number[] = [];
  readonly tileCells: number; // tile size in map cells
  readonly tw: number;
  readonly th: number;
  readonly cs: number;
  readonly radius: number;
  lastRebuiltTiles = new Set<number>();
  /** Map position of the navmesh origin (one cell outside the map, for the border wall). */
  get originX(): number {
    return this.bmin[0];
  }
  get originY(): number {
    return this.bmin[2];
  }
  private rc: ReturnType<typeof buildTiledNavMeshRcConfig>;
  private bmin: [number, number, number];
  private bmax: [number, number, number];
  private ctx = new RecastBuildContext();
  private filter = new QueryFilter();

  constructor(
    layer: GridLayer,
    readonly need: number,
  ) {
    const W = layer.w;
    const H = layer.h;
    // Voxel size: fine for small maps, coarser for big ones to keep build times sane.
    this.cs = Math.max(W, H) <= 160 ? 0.25 : Math.max(W, H) <= 520 ? 0.5 : 1;
    this.tileCells = Math.max(8, Math.round(16 / this.cs) * this.cs);
    // Radius one voxel under half the footprint, so gaps the grid lets this unit through stay open.
    this.radius = need - 0.5;
    const walkableRadius = Math.max(0, Math.round(this.radius / this.cs) - 1);
    this.bmin = [-1, -1, -1];
    this.bmax = [W + 1, WALL_HEIGHT + 1, H + 1];
    this.rc = buildTiledNavMeshRcConfig({
      recastConfig: {
        cs: this.cs,
        ch: 0.2,
        tileSize: Math.round(this.tileCells / this.cs),
        borderSize: walkableRadius + 3,
        walkableSlopeAngle: 45,
        walkableHeight: 10,
        walkableClimb: 2,
        walkableRadius,
        maxEdgeLen: 24,
        maxSimplificationError: 1.1,
        minRegionArea: 4,
        mergeRegionArea: 20,
        maxVertsPerPoly: 6,
        detailSampleDist: 6,
        detailSampleMaxError: 1,
      },
      navMeshBounds: [this.bmin, this.bmax],
    });
    this.tw = this.rc.tileWidth;
    this.th = this.rc.tileHeight;
    this.navMesh = new NavMesh();
    const params = NavMeshParams.create({
      orig: this.rc.orig,
      tileWidth: this.rc.tcs,
      tileHeight: this.rc.tcs,
      maxTiles: this.rc.maxTiles,
      maxPolys: this.rc.maxPolysPerTile,
    });
    if (!this.navMesh.initTiled(params)) throw new Error('Could not initialise the tiled navmesh.');
    this.query = new NavMeshQuery(this.navMesh, { maxNodes: 65535 });
  }

  /** Build every tile (first build) or just the tiles a changed box touches. */
  build(layer: GridLayer, changed: Rect | null): NavBuildInfo {
    const t0 = performance.now();
    const { positions, indices } = floorGeometry(layer);
    const verts = new VerticesArray();
    verts.copy(positions);
    const tris = new TrianglesArray();
    tris.copy(indices);
    const chunky = new RecastChunkyTriMesh();
    chunky.init(verts, tris, indices.length / 3, 256);
    const areas = terrainRects(layer);
    const tcs = this.rc.tcs;
    let tx0 = 0;
    let ty0 = 0;
    let tx1 = this.tw - 1;
    let ty1 = this.th - 1;
    if (changed) {
      // Recast tiles read a border around themselves, so grow the box by it.
      const pad = this.radius + 4 * this.cs + 1;
      const ox = this.bmin[0];
      const oz = this.bmin[2];
      tx0 = Math.max(0, Math.floor((changed.x0 - pad - ox) / tcs));
      ty0 = Math.max(0, Math.floor((changed.y0 - pad - oz) / tcs));
      tx1 = Math.min(this.tw - 1, Math.floor((changed.x1 + 1 + pad - ox) / tcs));
      ty1 = Math.min(this.th - 1, Math.floor((changed.y1 + 1 + pad - oz) / tcs));
    }
    this.lastRebuiltTiles = new Set();
    let built = 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const tile = {
          x: tx,
          y: ty,
          bmin: [this.bmin[0] + tx * tcs, this.bmin[1], this.bmin[2] + ty * tcs] as [number, number, number],
          bmax: [this.bmin[0] + (tx + 1) * tcs, this.bmax[1], this.bmin[2] + (ty + 1) * tcs] as [number, number, number],
        };
        const data = this.buildTileData(tile, verts, tris, chunky, areas);
        const old = this.navMesh.getTileRefAt(tx, ty, 0);
        if (old) this.navMesh.removeTile(old);
        if (data) {
          const add = this.navMesh.addTile(data, Detour.DT_TILE_FREE_DATA, 0);
          if (statusFailed(add.status)) data.destroy();
        }
        this.lastRebuiltTiles.add(ty * this.tw + tx);
        built++;
      }
    }
    verts.destroy();
    tris.destroy();
    this.readPolys();
    return { ms: performance.now() - t0, tilesBuilt: built, kind: changed ? `rebuilt ${built} tile${built === 1 ? '' : 's'}` : 'full build' };
  }

  /**
   * One tile through the Recast pipeline. This mirrors recast-navigation's
   * generateTileNavMeshData, with one addition: after eroding by the unit's radius,
   * terrain is stamped onto the voxels as area types, so regions and polygons split
   * along terrain borders and every polygon carries its terrain. The walkable tops of
   * wall boxes are cleared at the same time.
   */
  private buildTileData(
    tile: { x: number; y: number; bmin: [number, number, number]; bmax: [number, number, number] },
    verts: FloatArray,
    tris: IntArray,
    chunky: RecastChunkyTriMesh,
    areas: TerrainRect[],
  ): UnsignedCharArray | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = cloneRcConfig(this.rc.config) as any;
    const ctx = this.ctx;
    const border = cfg.borderSize * cfg.cs;
    const bmin: [number, number, number] = [tile.bmin[0] - border, tile.bmin[1], tile.bmin[2] - border];
    const bmax: [number, number, number] = [tile.bmax[0] + border, tile.bmax[1], tile.bmax[2] + border];
    for (let i = 0; i < 3; i++) {
      cfg.set_bmin(i, bmin[i]);
      cfg.set_bmax(i, bmax[i]);
    }
    const hf = allocHeightfield();
    let chf: ReturnType<typeof allocCompactHeightfield> | null = null;
    let cset: ReturnType<typeof allocContourSet> | null = null;
    let pmesh: ReturnType<typeof allocPolyMesh> | null = null;
    let dmesh: ReturnType<typeof allocPolyMeshDetail> | null = null;
    const done = (data: UnsignedCharArray | null) => {
      freeHeightfield(hf);
      if (chf) freeCompactHeightfield(chf);
      if (cset) freeContourSet(cset);
      if (pmesh) freePolyMesh(pmesh);
      if (dmesh) freePolyMeshDetail(dmesh);
      return data;
    };
    if (!createHeightfield(ctx, hf, cfg.width, cfg.height, bmin, bmax, cfg.cs, cfg.ch)) return done(null);
    const ids = new ChunkIdsArray();
    ids.resize(512);
    const n = chunky.getChunksOverlappingRect([bmin[0], bmin[2]], [bmax[0], bmax[2]], ids, 512);
    for (let i = 0; i < n; i++) {
      const node = chunky.nodes(ids.get(i));
      const nodeTris = chunky.getNodeTris(ids.get(i));
      const triAreas = new TriangleAreasArray();
      triAreas.resize(node.n);
      markWalkableTriangles(ctx, cfg.walkableSlopeAngle, verts, tris.size, nodeTris, node.n, triAreas);
      const ok = rasterizeTriangles(ctx, verts, tris.size, nodeTris, triAreas, node.n, hf, cfg.walkableClimb);
      triAreas.destroy();
      if (!ok) {
        ids.destroy();
        return done(null);
      }
    }
    ids.destroy();
    filterLowHangingWalkableObstacles(ctx, cfg.walkableClimb, hf);
    filterLedgeSpans(ctx, cfg.walkableHeight, cfg.walkableClimb, hf);
    filterWalkableLowHeightSpans(ctx, cfg.walkableHeight, hf);
    chf = allocCompactHeightfield();
    if (!buildCompactHeightfield(ctx, cfg.walkableHeight, cfg.walkableClimb, hf, chf)) return done(null);
    if (!erodeWalkableArea(ctx, cfg.walkableRadius, chf)) return done(null);
    // Wall tops are flat and would become walkable islands: clear them.
    markBoxArea(ctx, [bmin[0], 1, bmin[2]], [bmax[0], WALL_HEIGHT + 1, bmax[2]], 0, chf);
    // Terrain areas.
    for (const r of areas) {
      if (r.x1 < bmin[0] || r.x0 > bmax[0] || r.y1 < bmin[2] || r.y0 > bmax[2]) continue;
      markBoxArea(ctx, [r.x0, -0.5, r.y0], [r.x1, 0.5, r.y1], r.area, chf);
    }
    if (!buildDistanceField(ctx, chf)) return done(null);
    if (!buildRegions(ctx, chf, cfg.borderSize, cfg.minRegionArea, cfg.mergeRegionArea)) return done(null);
    cset = allocContourSet();
    if (!buildContours(ctx, chf, cfg.maxSimplificationError, cfg.maxEdgeLen, cset, Recast.RC_CONTOUR_TESS_WALL_EDGES)) return done(null);
    pmesh = allocPolyMesh();
    if (!buildPolyMesh(ctx, cset, cfg.maxVertsPerPoly, pmesh)) return done(null);
    dmesh = allocPolyMeshDetail();
    if (!buildPolyMeshDetail(ctx, pmesh, chf, cfg.detailSampleDist, cfg.detailSampleMaxError, dmesh)) return done(null);
    if (pmesh.npolys() === 0) return done(null);
    for (let i = 0; i < pmesh.npolys(); i++) {
      if (pmesh.areas(i) === Recast.RC_WALKABLE_AREA) pmesh.setAreas(i, 0);
      pmesh.setFlags(i, 1);
    }
    const params = new NavMeshCreateParams();
    params.setPolyMeshCreateParams(pmesh);
    params.setPolyMeshDetailCreateParams(dmesh);
    params.setWalkableHeight(cfg.walkableHeight * cfg.ch);
    params.setWalkableRadius(cfg.walkableRadius * cfg.cs);
    params.setWalkableClimb(cfg.walkableClimb * cfg.ch);
    params.setCellSize(cfg.cs);
    params.setCellHeight(cfg.ch);
    params.setBuildBvTree(true);
    params.setTileX(tile.x);
    params.setTileY(tile.y);
    const res = createNavMeshData(params);
    return done(res.success ? res.navMeshData : null);
  }

  /** Read every polygon and its links back out of Detour. */
  private readPolys(): void {
    const nm = this.navMesh;
    this.polys = [];
    this.refToIndex.clear();
    this.indexToRef = [];
    const pending: Array<Array<{ ref: number; left: Pt; right: Pt }>> = [];
    const max = nm.getMaxTiles();
    for (let t = 0; t < max; t++) {
      const tile = nm.getTile(t);
      const hd = tile.header();
      if (!hd) continue;
      const pc = hd.polyCount();
      if (!pc) continue;
      const salt = tile.salt();
      const tileIndex = hd.y() * this.tw + hd.x();
      for (let p = 0; p < pc; p++) {
        const poly = tile.polys(p);
        if (poly.getType() !== 0) continue; // skip off-mesh connections
        const nv = poly.vertCount();
        const verts: Pt[] = [];
        let top = 0;
        for (let k = 0; k < nv; k++) {
          const vi = poly.verts(k);
          verts.push({ x: tile.verts(vi * 3), y: tile.verts(vi * 3 + 2) });
          top = Math.max(top, tile.verts(vi * 3 + 1));
        }
        if (top > 1) continue; // safety net: anything left on top of a wall box
        let cx = 0;
        let cy = 0;
        for (const v of verts) {
          cx += v.x;
          cy += v.y;
        }
        const ref = nm.encodePolyId(salt, t, p);
        this.refToIndex.set(ref, this.polys.length);
        this.indexToRef.push(ref);
        const links: Array<{ ref: number; left: Pt; right: Pt }> = [];
        let l = poly.firstLink();
        let guard = 64;
        while ((l >>> 0) !== 0xffffffff && guard-- > 0) {
          const link = tile.links(l);
          const e = link.edge();
          const va = verts[e];
          const vb = verts[(e + 1) % nv];
          let left = va;
          let right = vb;
          const side = link.side();
          if (side !== 0xff) {
            const bmin = link.bmin();
            const bmax = link.bmax();
            if (bmin !== 0 || bmax !== 255) {
              const s = 1 / 255;
              const lerp = (t2: number): Pt => ({ x: va.x + (vb.x - va.x) * t2, y: va.y + (vb.y - va.y) * t2 });
              left = lerp(bmin * s);
              right = lerp(bmax * s);
            }
          }
          links.push({ ref: link.ref(), left, right });
          l = link.next();
        }
        pending.push(links);
        this.polys.push({ verts, centroid: { x: cx / nv, y: cy / nv }, tile: tileIndex, area: poly.areaAndType() & 0x3f, links: [] });
      }
    }
    for (let i = 0; i < this.polys.length; i++) {
      for (const k of pending[i]) {
        const to = this.refToIndex.get(k.ref);
        if (to !== undefined) this.polys[i].links.push({ to, left: k.left, right: k.right });
      }
    }
  }

  /** Nearest polygon to a map point, and the closest point on it. */
  nearest(p: Pt): { poly: number; point: Pt } | null {
    const r = this.query.findNearestPoly({ x: p.x, y: 0, z: p.y }, { halfExtents: { x: 2, y: 2, z: 2 } });
    if (!r.success || !r.nearestRef) return null;
    const idx = this.refToIndex.get(r.nearestRef);
    if (idx === undefined) return null;
    return { poly: idx, point: { x: r.nearestPoint.x, y: r.nearestPoint.z } };
  }

  /** Detour's own path, for comparison, using the same per-area costs. */
  detourPath(a: Pt, b: Pt, areaCost: number[]): Pt[] | null {
    const filter = this.filter;
    filter.includeFlags = 0xffff;
    for (let i = 0; i < areaCost.length; i++) filter.setAreaCost(i, areaCost[i]);
    const r = this.query.computePath({ x: a.x, y: 0, z: a.y }, { x: b.x, y: 0, z: b.y }, {
      filter,
      halfExtents: { x: 2, y: 2, z: 2 },
      maxPathPolys: 8192,
      maxStraightPathPoints: 2048,
    });
    if (!r.success) return null;
    return r.path.map((v) => ({ x: v.x, y: v.z }));
  }

  destroy(): void {
    this.query.destroy();
    this.navMesh.destroy();
  }
}

export interface TerrainRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Detour area id (the terrain id; plain ground keeps Recast's default walkable area). */
  area: number;
}

/** Non-plain terrain as rectangles (greedy merge of matching runs), one area id per terrain. */
export function terrainRects(layer: GridLayer): TerrainRect[] {
  const { w, h, terrain, blocked } = layer;
  const out: TerrainRect[] = [];
  const used = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const i = y * w + x;
      const t = terrain[i];
      if (!t || blocked[i] || used[i]) {
        x++;
        continue;
      }
      let x1 = x;
      while (x1 < w && terrain[y * w + x1] === t && !blocked[y * w + x1] && !used[y * w + x1]) x1++;
      let y1 = y + 1;
      outer: while (y1 < h) {
        for (let k = x; k < x1; k++) {
          const j = y1 * w + k;
          if (terrain[j] !== t || blocked[j] || used[j]) break outer;
        }
        y1++;
      }
      for (let yy = y; yy < y1; yy++) for (let k = x; k < x1; k++) used[yy * w + k] = 1;
      out.push({ x0: x, y0: y, x1, y1, area: t });
      x = x1;
    }
  }
  return out;
}

/** Detour area costs for a query: index = area id = terrain id. */
export function areaCosts(useTerrain: boolean): number[] {
  return TERRAINS.map((t) => (useTerrain ? t.cost : 1));
}

/** Height of wall boxes in map units; anything well above the step height works. */
const WALL_HEIGHT = 2.5;

/**
 * Input geometry for Recast (map x -> x, map y -> z, up = y):
 *  - one floor quad under the whole map (plus a one-cell margin);
 *  - every wall as a solid box, with runs of wall cells merged into rectangles;
 *  - a ring of wall boxes around the map edge, which the grid also treats as a wall.
 * Walls must be solid: if they were holes in the floor, Recast's ledge filter would
 * treat every wall edge as a drop and close one-cell doorways.
 * Boxes are inset by a hair so their faces never touch the neighbouring voxel column.
 */
export function floorGeometry(layer: GridLayer): { positions: number[]; indices: number[] } {
  const { w, h, blocked } = layer;
  const positions: number[] = [];
  const indices: number[] = [];
  const quadUp = (x0: number, z0: number, x1: number, z1: number, y: number) => {
    const b = positions.length / 3;
    positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
    indices.push(b, b + 2, b + 1, b, b + 3, b + 2); // normal +y
  };
  const box = (x0: number, z0: number, x1: number, z1: number) => {
    const e = 0.01;
    x0 += e;
    z0 += e;
    x1 -= e;
    z1 -= e;
    const H = WALL_HEIGHT;
    const b = positions.length / 3;
    // 8 corners: bottom 0-3, top 4-7.
    positions.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1, x0, H, z0, x1, H, z0, x1, H, z1, x0, H, z1);
    const f = (a: number, c: number, d: number) => indices.push(b + a, b + c, b + d);
    f(4, 6, 5); f(4, 7, 6); // top
    f(0, 1, 5); f(0, 5, 4); // z0 side
    f(2, 3, 7); f(2, 7, 6); // z1 side
    f(3, 0, 4); f(3, 4, 7); // x0 side
    f(1, 2, 6); f(1, 6, 5); // x1 side
  };
  quadUp(-1, -1, w + 1, h + 1, 0);
  box(-1, -1, w + 1, 0);
  box(-1, h, w + 1, h + 1);
  box(-1, 0, 0, h);
  box(w, 0, w + 1, h);
  // Greedy rectangles: extend each row's wall runs downward while the run below matches.
  const used = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const i = y * w + x;
      if (!blocked[i] || used[i]) {
        x++;
        continue;
      }
      let x1 = x;
      while (x1 < w && blocked[y * w + x1] && !used[y * w + x1]) x1++;
      let y1 = y + 1;
      outer: while (y1 < h) {
        for (let k = x; k < x1; k++) if (!blocked[y1 * w + k] || used[y1 * w + k]) break outer;
        y1++;
      }
      for (let yy = y; yy < y1; yy++) for (let k = x; k < x1; k++) used[yy * w + k] = 1;
      box(x, y, x1, y1);
      x = x1;
    }
  }
  return { positions, indices };
}

const triArea2 = (a: Pt, b: Pt, c: Pt) => (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y);
const near = (a: Pt, b: Pt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 < 1e-8;

/**
 * The funnel algorithm ("simple stupid funnel", as in Detour's findStraightPath):
 * walk the portals between consecutive polygons, keeping the tightest left and right
 * edges of a funnel from the current apex; when they cross, the apex becomes a corner.
 */
export function funnel(start: Pt, end: Pt, portals: Array<{ left: Pt; right: Pt }>): Pt[] {
  const pts: Pt[] = [start];
  const all = [...portals, { left: end, right: end }];
  let apex = start;
  let left = start;
  let right = start;
  let apexIndex = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  for (let i = 0; i < all.length; i++) {
    const pl = all[i].left;
    const pr = all[i].right;
    // Right side.
    if (triArea2(apex, right, pr) <= 0) {
      if (near(apex, right) || triArea2(apex, left, pr) > 0) {
        right = pr;
        rightIndex = i;
      } else {
        apex = left;
        apexIndex = leftIndex;
        if (!near(pts[pts.length - 1], apex)) pts.push(apex);
        left = apex;
        right = apex;
        leftIndex = apexIndex;
        rightIndex = apexIndex;
        i = apexIndex;
        continue;
      }
    }
    // Left side.
    if (triArea2(apex, left, pl) >= 0) {
      if (near(apex, left) || triArea2(apex, right, pl) < 0) {
        left = pl;
        leftIndex = i;
      } else {
        apex = right;
        apexIndex = rightIndex;
        if (!near(pts[pts.length - 1], apex)) pts.push(apex);
        left = apex;
        right = apex;
        leftIndex = apexIndex;
        rightIndex = apexIndex;
        i = apexIndex;
        continue;
      }
    }
  }
  if (!near(pts[pts.length - 1], end)) pts.push(end);
  return pts;
}
