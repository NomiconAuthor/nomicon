/**
 * "Culling": the CPU model behind the lesson's widget, and the city the GPU-driven lesson reuses.
 * No DOM, no GPU, so the claims run it in Node.
 *
 * A city of box-shaped buildings on a grid of blocks, a camera walking along a street and turning
 * a corner, and the culling techniques the lesson describes, each run exactly as the text says:
 *
 *   frustum     bounding spheres or boxes against the camera's six planes
 *   occlusion   a hierarchical Z-buffer (HZB) built from this frame's big occluders, the same
 *               from last frame's depth (tested with last frame's camera), two-phase culling
 *               (draw last frame's visible set, build the HZB, test the rest), or occlusion
 *               queries whose answers arrive a frame late
 *   LOD         a level of detail per building from its projected size
 *
 * Depth is rasterised on the CPU at MODEL_W × MODEL_H, with the same projection as raster.ts
 * (depth 0..1, D3D style), sampled at pixel centres. "Visible" means it covers at least one pixel
 * centre of that depth buffer when everything is drawn; every count compares with that.
 * Only + − × ÷ and sqrt: the same numbers in every browser and in Node.
 */
import { type Camera, type Mesh, type V3, basis, v3 } from '../raster';
import { type DrawPlan, type FramePlan } from '../gpu/plan';
import { type GpuMesh, gpuMesh } from '../gpu/scene';

// ---------------------------------------------------------------------------------------------
// The city

export const BLOCK = 12;
export interface Building {
  id: number;
  min: V3;
  max: V3;
  /** Big enough to be drawn into the occluder depth pass. */
  occluder: boolean;
  /** A colour slot, 0–5. */
  tone: number;
}

function hash(i: number, salt: number): number {
  let x = (i * 0x9e3779b1 + salt * 0x85ebca77) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}
const unit = (i: number, salt: number) => (hash(i, salt) % 10000) / 10000;

/** Heights at or above this make a building an occluder. */
export const OCCLUDER_HEIGHT = 30;

/** side × side blocks, one building each, centred on the origin. Taller towards the middle. */
export function city(side: number): Building[] {
  const out: Building[] = [];
  const o = ((side - 1) * BLOCK) / 2;
  for (let bz = 0; bz < side; bz++)
    for (let bx = 0; bx < side; bx++) {
      const id = bz * side + bx;
      const cx = bx * BLOCK - o + (unit(id, 1) - 0.5) * 1.5;
      const cz = bz * BLOCK - o + (unit(id, 2) - 0.5) * 1.5;
      const hw = 2.5 + unit(id, 3) * 2; // half-widths 2.5–4.5 m: streets at least 3 m wide
      const hd = 2.5 + unit(id, 4) * 2;
      const dx = (bx - (side - 1) / 2) / side;
      const dz = (bz - (side - 1) / 2) / side;
      const centre = 1 - 2.2 * (dx * dx + dz * dz);
      const h = Math.round(4 + unit(id, 5) * 14 + Math.max(0, centre) * unit(id, 6) * 34);
      out.push({ id, min: v3(cx - hw, 0, cz - hd), max: v3(cx + hw, h, cz + hd), occluder: h >= OCCLUDER_HEIGHT, tone: hash(id, 7) % 6 });
    }
  return out;
}

export const CITY_SIDE = 24;
/** The x of the street between block columns c and c + 1 (or z, for rows). */
export const streetAt = (side: number, c: number) => (c + 0.5) * BLOCK - ((side - 1) * BLOCK) / 2;

// ---------------------------------------------------------------------------------------------
// The camera and its walk

export const MODEL_W = 160;
export const MODEL_H = 90;
export const EYE_HEIGHT = 2;
export const FOCAL = 1.5;
export const NEAR = 0.5;
export const FAR = 400;

export const camAt = (eye: V3, dir: V3, aspect = MODEL_W / MODEL_H): Camera => ({ eye, target: v3(eye.x + dir.x * 10, eye.y + dir.y * 10, eye.z + dir.z * 10), focal: FOCAL, aspect, near: NEAR, far: FAR, reverseZ: false });

/**
 * The walk: north up a street from the south edge, 3 m a frame, then a turn to the east over
 * TURN_FRAMES frames at a crossing, then on east. Frame k is one rendered frame.
 */
export const WALK_FRAMES = 48;
export const TURN_START = 26;
export const TURN_FRAMES = 4;
const STEP = 3;
export function walk(k: number, side = CITY_SIDE): { eye: V3; dir: V3 } {
  const x0 = streetAt(side, 13);
  const z0 = ((side - 1) * BLOCK) / 2 + 8;
  const zTurn = z0 - TURN_START * STEP;
  if (k <= TURN_START) return { eye: v3(x0, EYE_HEIGHT, z0 - k * STEP), dir: v3(0, 0, -1) };
  // Snap to the crossing street's centre line, then turn (straight-line blend of the two directions: no trig).
  const zc = streetAt(side, Math.round((zTurn + ((side - 1) * BLOCK) / 2) / BLOCK - 0.5));
  if (k <= TURN_START + TURN_FRAMES) {
    const t = (k - TURN_START) / TURN_FRAMES;
    return { eye: v3(x0, EYE_HEIGHT, zTurn + (zc - zTurn) * t), dir: v3(t, 0, -(1 - t)) };
  }
  return { eye: v3(x0 + (k - TURN_START - TURN_FRAMES) * STEP, EYE_HEIGHT, zc), dir: v3(1, 0, 0) };
}
export const walkCam = (k: number, aspect?: number) => {
  const w = walk(k);
  return camAt(w.eye, w.dir, aspect);
};

// ---------------------------------------------------------------------------------------------
// Frustum culling

export interface Plane {
  n: V3;
  d: number;
}
/** The six planes, normals pointing inwards: a point p is inside when n·p + d ≥ 0 for all of them. */
export function frustumPlanes(cam: Camera): Plane[] {
  const { right: r, up: u, fwd: f } = basis(cam);
  const sx = cam.focal / cam.aspect;
  const sy = cam.focal;
  // Inside the left plane: x_view·sx ≥ −z_view, i.e. (f + sx·r)·(p − e) ≥ 0. Likewise the others.
  const mk = (a: V3, b: V3, s: number): V3 => v3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
  const planes: Array<[V3, number]> = [
    [mk(f, r, sx), 0],
    [mk(f, r, -sx), 0],
    [mk(f, u, sy), 0],
    [mk(f, u, -sy), 0],
    [f, -cam.near],
    [v3(-f.x, -f.y, -f.z), cam.far],
  ];
  return planes.map(([n, off]) => {
    const l = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
    const nn = v3(n.x / l, n.y / l, n.z / l);
    return { n: nn, d: -(nn.x * cam.eye.x + nn.y * cam.eye.y + nn.z * cam.eye.z) + off / l };
  });
}

export const centre = (b: Building): V3 => v3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
export function radius(b: Building): number {
  const x = (b.max.x - b.min.x) / 2;
  const y = (b.max.y - b.min.y) / 2;
  const z = (b.max.z - b.min.z) / 2;
  return Math.sqrt(x * x + y * y + z * z);
}
/** Sphere test: outside when the centre is more than the radius behind any plane. */
export function sphereVisible(planes: Plane[], c: V3, r: number): boolean {
  for (const p of planes) if (p.n.x * c.x + p.n.y * c.y + p.n.z * c.z + p.d < -r) return false;
  return true;
}
/** Box test: outside when the corner furthest along the plane's normal is behind it. */
export function boxVisible(planes: Plane[], min: V3, max: V3): boolean {
  for (const p of planes) {
    const x = p.n.x >= 0 ? max.x : min.x;
    const y = p.n.y >= 0 ? max.y : min.y;
    const z = p.n.z >= 0 ? max.z : min.z;
    if (p.n.x * x + p.n.y * y + p.n.z * z + p.d < 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Depth on the CPU

const FACES: Array<[number, number, number, number]> = [
  // Corner i has bits x (1), y (2), z (4) set for max. Counter-clockwise seen from outside.
  [4, 5, 7, 6], // +z
  [1, 0, 2, 3], // -z
  [5, 1, 3, 7], // +x
  [0, 4, 6, 2], // -x
  [6, 7, 3, 2], // +y
  [0, 1, 5, 4], // -y
];
const corner = (b: { min: V3; max: V3 }, i: number) => v3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);

export class DepthBuffer {
  readonly depth: Float32Array;
  readonly owner: Int32Array;
  constructor(
    readonly w = MODEL_W,
    readonly h = MODEL_H,
  ) {
    this.depth = new Float32Array(w * h).fill(1);
    this.owner = new Int32Array(w * h).fill(-1);
  }
}

interface ViewPt {
  x: number;
  y: number;
  z: number;
}
/** World to view space (x right, y up, z forward). */
function toView(p: V3, cam: Camera, b: ReturnType<typeof basis>): ViewPt {
  const dx = p.x - cam.eye.x;
  const dy = p.y - cam.eye.y;
  const dz = p.z - cam.eye.z;
  return { x: dx * b.right.x + dy * b.right.y + dz * b.right.z, y: dx * b.up.x + dy * b.up.y + dz * b.up.z, z: dx * b.fwd.x + dy * b.fwd.y + dz * b.fwd.z };
}
/** Depth after the divide, as raster.ts's toClip gives it: f/(f−n)·(1 − n/z). */
const ndcDepth = (z: number, cam: Camera) => (cam.far / (cam.far - cam.near)) * (1 - cam.near / z);

/** Draw boxes into a depth buffer (depth test "less", or "less or equal"; pixel centres; back faces culled; clipped at the near plane). */
export function rasterBoxes(buf: DepthBuffer, boxes: Building[], cam: Camera, lequal = false): void {
  const b = basis(cam);
  const sx = cam.focal / cam.aspect;
  const sy = cam.focal;
  const { w, h } = buf;
  for (const box of boxes) {
    const vs = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => toView(corner(box, i), cam, b));
    for (const f of FACES) {
      // Clip the face against the near plane (Sutherland–Hodgman in view space).
      let poly = f.map((i) => vs[i]);
      const out: ViewPt[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const c = poly[(i + 1) % poly.length];
        const ain = a.z >= cam.near;
        const cin = c.z >= cam.near;
        if (ain) out.push(a);
        if (ain !== cin) {
          const t = (cam.near - a.z) / (c.z - a.z);
          out.push({ x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t, z: cam.near });
        }
      }
      if (out.length < 3) continue;
      poly = out;
      // Project to pixels (y down) and depth.
      const sp = poly.map((p) => ({ x: ((p.x * sx) / p.z + 1) * 0.5 * w, y: (1 - (p.y * sy) / p.z) * 0.5 * h, d: ndcDepth(p.z, cam) }));
      for (let t = 1; t + 1 < sp.length; t++) tri(buf, sp[0], sp[t], sp[t + 1], box.id, lequal);
    }
  }
}

function tri(buf: DepthBuffer, a: { x: number; y: number; d: number }, b: { x: number; y: number; d: number }, c: { x: number; y: number; d: number }, id: number, lequal: boolean): void {
  // Signed area with y down: counter-clockwise in the world shows as clockwise on screen, so front faces have area < 0.
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (area >= 0) return;
  const { w, h, depth, owner } = buf;
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = (c.x - b.x) * (py - b.y) - (c.y - b.y) * (px - b.x);
      const w1 = (a.x - c.x) * (py - c.y) - (a.y - c.y) * (px - c.x);
      const w2 = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
      if (w0 > 0 || w1 > 0 || w2 > 0) continue;
      // Depth after the divide is affine in screen space, so plain barycentrics are right for it.
      const d = (w0 * a.d + w1 * b.d + w2 * c.d) / area;
      const i = y * w + x;
      if (d < depth[i] || (lequal && d === depth[i])) {
        depth[i] = d;
        owner[i] = id;
      }
    }
}

// ---------------------------------------------------------------------------------------------
// The hierarchical Z-buffer

/** Mip levels of the farthest depth in each texel: level 0 is the depth buffer itself. */
export interface Hzb {
  levels: Array<{ w: number; h: number; d: Float32Array }>;
}
export function buildHzb(buf: DepthBuffer): Hzb {
  const levels = [{ w: buf.w, h: buf.h, d: buf.depth }];
  for (;;) {
    const p = levels[levels.length - 1];
    if (p.w === 1 && p.h === 1) break;
    const w = Math.max(1, Math.ceil(p.w / 2));
    const h = Math.max(1, Math.ceil(p.h / 2));
    const d = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        // The farthest of the 2 × 2 texels below (one row or column at an odd edge), so texel (x, y)
        // of level L covers pixels (x << L, y << L) to ((x + 1) << L) − 1 of level 0.
        let m = 0;
        for (let yy = 2 * y; yy <= Math.min(p.h - 1, 2 * y + 1); yy++) for (let xx = 2 * x; xx <= Math.min(p.w - 1, 2 * x + 1); xx++) m = Math.max(m, p.d[yy * p.w + xx]);
        d[y * w + x] = m;
      }
    levels.push({ w, h, d });
  }
  return { levels };
}

/** A box's footprint on screen: pixel rectangle and nearest depth, or null if it crosses the near plane. */
export function screenRect(box: { min: V3; max: V3 }, cam: Camera, w = MODEL_W, h = MODEL_H): { x0: number; y0: number; x1: number; y1: number; near: number } | null {
  const b = basis(cam);
  const sx = cam.focal / cam.aspect;
  const sy = cam.focal;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, near = Infinity;
  for (let i = 0; i < 8; i++) {
    const p = toView(corner(box, i), cam, b);
    if (p.z < cam.near) return null;
    const x = ((p.x * sx) / p.z + 1) * 0.5 * w;
    const y = (1 - (p.y * sy) / p.z) * 0.5 * h;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    near = Math.min(near, ndcDepth(p.z, cam));
  }
  return { x0, y0, x1, y1, near };
}

/**
 * The HZB test: find the level where the box's rectangle spans at most 2 × 2 texels, and compare
 * its nearest depth with the farthest depth stored there. Hidden only if it's behind all of them.
 */
export function hzbHidden(hzb: Hzb, box: { min: V3; max: V3 }, cam: Camera): boolean {
  const r = screenRect(box, cam, hzb.levels[0].w, hzb.levels[0].h);
  if (!r) return false;
  const W = hzb.levels[0].w;
  const H = hzb.levels[0].h;
  const px0 = Math.max(0, Math.floor(r.x0));
  const py0 = Math.max(0, Math.floor(r.y0));
  const px1 = Math.min(W - 1, Math.floor(r.x1));
  const py1 = Math.min(H - 1, Math.floor(r.y1));
  if (px0 > px1 || py0 > py1) return false;
  let L = 0;
  while (L < hzb.levels.length - 1 && ((px1 >> L) - (px0 >> L) > 1 || (py1 >> L) - (py0 >> L) > 1)) L++;
  const lv = hzb.levels[L];
  let far = 0;
  for (let y = py0 >> L; y <= Math.min(lv.h - 1, py1 >> L); y++) for (let x = px0 >> L; x <= Math.min(lv.w - 1, px1 >> L); x++) far = Math.max(far, lv.d[y * lv.w + x]);
  return r.near > far;
}

/** Whether any pixel centre of the box passes the depth test (what an occlusion query on its box reports). */
export function queryPasses(buf: DepthBuffer, box: Building, cam: Camera): boolean {
  const probe = new DepthBuffer(buf.w, buf.h);
  probe.depth.set(buf.depth);
  // "Less or equal", so a building that was drawn passes against its own depth.
  rasterBoxes(probe, [{ ...box, id: -2 }], cam, true);
  for (let i = 0; i < probe.owner.length; i++) if (probe.owner[i] === -2) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Levels of detail

/** Triangles per building at each level: a box with each face cut into n × n squares, n = 6, 3, 1. */
export const LOD_DIVS = [6, 3, 1];
export const lodTriangles = (l: number) => 6 * LOD_DIVS[l] * LOD_DIVS[l] * 2;
/** Projected size thresholds: the bounding sphere's radius over its distance, times the focal length (a fraction of half the screen height). */
export const LOD_SIZE = [0.3, 0.08];
export function lodOf(b: Building, cam: Camera): number {
  const c = centre(b);
  const dx = c.x - cam.eye.x;
  const dy = c.y - cam.eye.y;
  const dz = c.z - cam.eye.z;
  const s = (radius(b) * cam.focal) / Math.max(cam.near, Math.sqrt(dx * dx + dy * dy + dz * dz));
  return s > LOD_SIZE[0] ? 0 : s > LOD_SIZE[1] ? 1 : 2;
}

// ---------------------------------------------------------------------------------------------
// A frame of culling

export type FrustumMode = 'off' | 'sphere' | 'box';
export type OcclusionMode = 'off' | 'occluders' | 'last' | 'two-phase' | 'queries';
export interface CullSettings {
  frustum: FrustumMode;
  occlusion: OcclusionMode;
  lod: boolean;
}
export const CULL_DEFAULTS: CullSettings = { frustum: 'box', occlusion: 'off', lod: false };
export const FRUSTUM_LABEL: Record<FrustumMode, string> = { off: 'Off', sphere: 'Spheres', box: 'Boxes' };
export const OCCLUSION_LABEL: Record<OcclusionMode, string> = { off: 'Off', occluders: 'HZB, occluders', last: "HZB, last frame's", 'two-phase': 'Two-phase', queries: 'Queries' };

export type Status = 'frustum' | 'occluded' | 'drawn';
export interface CullFrame {
  /** Per building: culled by the frustum test, culled by occlusion, or drawn. */
  status: Status[];
  /** Per building: really visible this frame (covers a pixel centre when everything is drawn). */
  visible: boolean[];
  lod: number[];
  /** What was drawn, as depth (for the next frame's last-frame methods). */
  depth: DepthBuffer;
  /** Two-phase: how many were drawn in the first phase. */
  phase1: number;
  /** Occlusion tests made (HZB tests or queries issued). */
  occlusionTests: number;
}
export interface CullCounts {
  total: number;
  frustumCulled: number;
  occlusionTests: number;
  occluded: number;
  drawn: number;
  /** Visible but culled: holes on screen. */
  missed: number;
  /** Drawn but hidden behind others. */
  wasted: number;
  triangles: number;
  /** Two-phase: drawn in the first phase. */
  phase1: number;
}

export class CullModel {
  readonly buildings: Building[];
  private frames = new Map<string, CullFrame>();
  private truths = new Map<number, { visible: boolean[]; inFrustum: boolean[] }>();

  constructor(side = CITY_SIDE) {
    this.buildings = city(side);
  }

  /** Visibility with everything drawn (only boxes in the frustum need rasterising). */
  truth(k: number): { visible: boolean[]; inFrustum: boolean[] } {
    let t = this.truths.get(k);
    if (t) return t;
    const cam = walkCam(k);
    const planes = frustumPlanes(cam);
    const inFrustum = this.buildings.map((b) => boxVisible(planes, b.min, b.max));
    const buf = new DepthBuffer();
    rasterBoxes(buf, this.buildings.filter((_, i) => inFrustum[i]), cam);
    const visible = this.buildings.map(() => false);
    for (const o of buf.owner) if (o >= 0) visible[o] = true;
    t = { visible, inFrustum };
    this.truths.set(k, t);
    return t;
  }

  /** Frame k of the walk with these settings (earlier frames are computed first when a method needs them). */
  frame(k: number, s: CullSettings): CullFrame {
    const key = `${k} ${s.frustum} ${s.occlusion} ${s.lod}`;
    const hit = this.frames.get(key);
    if (hit) return hit;
    const cam = walkCam(k);
    const planes = frustumPlanes(cam);
    const bs = this.buildings;
    const status: Status[] = bs.map((b) => {
      if (s.frustum === 'off') return 'drawn';
      const ok = s.frustum === 'sphere' ? sphereVisible(planes, centre(b), radius(b)) : boxVisible(planes, b.min, b.max);
      return ok ? 'drawn' : 'frustum';
    });
    const cand = bs.filter((_, i) => status[i] === 'drawn');
    let phase1 = 0;
    let tests = 0;
    const prev = k > 0 && s.occlusion !== 'off' && s.occlusion !== 'occluders' ? this.frame(k - 1, s) : null;
    if (s.occlusion === 'occluders') {
      const buf = new DepthBuffer();
      rasterBoxes(buf, cand.filter((b) => b.occluder), cam);
      const hzb = buildHzb(buf);
      for (const b of cand) {
        tests++;
        if (hzbHidden(hzb, b, cam)) status[b.id] = 'occluded';
      }
    } else if (s.occlusion === 'last' && prev) {
      // Last frame's depth, tested with last frame's camera: "was it hidden last frame?"
      const hzb = buildHzb(prev.depth);
      const pcam = walkCam(k - 1);
      for (const b of cand) {
        tests++;
        if (hzbHidden(hzb, b, pcam)) status[b.id] = 'occluded';
      }
    } else if (s.occlusion === 'two-phase') {
      // Phase 1: test against last frame's HZB (with last frame's camera) and draw what passes.
      // Phase 2: build an HZB from what phase 1 drew, with this frame's camera, and test again
      // only what phase 1 culled. Anything newly revealed is caught here, in the same frame.
      const prevHzb = prev ? buildHzb(prev.depth) : null;
      const pcam = walkCam(Math.max(0, k - 1));
      const second: Building[] = [];
      for (const b of cand) {
        tests++;
        if (prevHzb && hzbHidden(prevHzb, b, pcam)) second.push(b);
      }
      phase1 = cand.length - second.length;
      const buf = new DepthBuffer();
      rasterBoxes(buf, cand.filter((b) => !second.includes(b)), cam);
      const hzb = buildHzb(buf);
      for (const b of second) {
        tests++;
        if (hzbHidden(hzb, b, cam)) status[b.id] = 'occluded';
      }
    } else if (s.occlusion === 'queries' && prev) {
      // Each frame, a query per tested building (its own draw, or its box if it was culled);
      // the answer is read a frame later, so this frame decides with last frame's answers.
      const pcam = walkCam(k - 1);
      for (const b of cand) {
        tests++;
        if (!queryPasses(prev.depth, b, pcam)) status[b.id] = 'occluded';
      }
    }
    const drawnList = bs.filter((_, i) => status[i] === 'drawn');
    const depth = new DepthBuffer();
    rasterBoxes(depth, drawnList, cam);
    const lod = bs.map((b) => (s.lod ? lodOf(b, cam) : 0));
    const f: CullFrame = { status, visible: this.truth(k).visible, lod, depth, phase1, occlusionTests: tests };
    this.frames.set(key, f);
    return f;
  }

  counts(k: number, s: CullSettings): CullCounts {
    const f = this.frame(k, s);
    let frustumCulled = 0, occluded = 0, drawn = 0, missed = 0, wasted = 0, triangles = 0;
    f.status.forEach((st, i) => {
      if (st === 'frustum') frustumCulled++;
      else if (st === 'occluded') occluded++;
      else {
        drawn++;
        triangles += lodTriangles(f.lod[i]);
        if (!f.visible[i]) wasted++;
      }
      if (st !== 'drawn' && f.visible[i]) missed++;
    });
    return { total: f.status.length, frustumCulled, occlusionTests: f.occlusionTests, occluded, drawn, missed, wasted, triangles, phase1: f.phase1 };
  }
}

// ---------------------------------------------------------------------------------------------
// What the GPU draws: the ground, then one instanced draw per level of detail


/** A unit cube (0..1 on each axis) with each face cut into n × n squares, vertices per face. */
export function cubeMesh(n: number): Mesh {
  const m: Mesh = { positions: [], attrs: [], indices: [] };
  // Each face: an origin corner and two edge vectors whose cross product points outwards.
  const faces: Array<[V3, V3, V3]> = [
    [v3(0, 0, 1), v3(1, 0, 0), v3(0, 1, 0)],
    [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 1, 0)],
    [v3(1, 0, 1), v3(0, 0, -1), v3(0, 1, 0)],
    [v3(0, 0, 0), v3(0, 0, 1), v3(0, 1, 0)],
    [v3(0, 1, 1), v3(1, 0, 0), v3(0, 0, -1)],
    [v3(0, 0, 0), v3(1, 0, 0), v3(0, 0, 1)],
  ];
  for (const [o, a, b] of faces) {
    const base = m.positions.length;
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        m.positions.push(v3(o.x + (a.x * i + b.x * j) / n, o.y + (a.y * i + b.y * j) / n, o.z + (a.z * i + b.z * j) / n));
        m.attrs.push([0, 0]);
      }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const p = base + j * (n + 1) + i;
        m.indices.push(p, p + 1, p + n + 2, p, p + n + 2, p + n + 1);
      }
  }
  return m;
}
export const LOD_MESHES: GpuMesh[] = LOD_DIVS.map((n, l) => gpuMesh(`building, LOD ${l}`, cubeMesh(n)));

/** Bytes per instance record: min corner and colour slot (16), size (16). */
export const RECORD_BYTES = 32;
/** The ground, as one more box. */
export const GROUND: Building = { id: -1, min: v3(-200, -0.2, -200), max: v3(200, 0, 200), occluder: false, tone: 6 };

/** Instance records for the drawn buildings, grouped by level of detail. */
export function cullRecords(bs: Building[], f: CullFrame, byLod = false): Array<{ records: Float32Array; count: number }> {
  const out = LOD_DIVS.map(() => ({ list: [] as Building[] }));
  bs.forEach((b, i) => {
    if (f.status[i] === 'drawn') out[f.lod[i]].list.push(b);
  });
  return out.map(({ list }, l) => ({ records: records(list, byLod ? l : undefined), count: list.length }));
}
/** Records for a list of buildings; `tone` overrides each one's colour slot. */
export function records(list: Building[], tone?: number): Float32Array {
  const r = new Float32Array(Math.max(1, list.length) * (RECORD_BYTES / 4));
  list.forEach((b, i) => r.set([b.min.x, b.min.y, b.min.z, tone ?? b.tone, b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, 0], i * 8));
  return r;
}

/** The camera view's plan: the ground, then an instanced draw per level of detail that has any buildings. */
export function cullPlan(counts: number[]): FramePlan {
  const draws: DrawPlan[] = [{ name: 'ground', pipeline: 'city', indexed: true, count: LOD_MESHES[2].indexCount, instances: 1 }];
  counts.forEach((n, l) => {
    if (n) draws.push({ name: `LOD ${l}`, pipeline: 'city', indexed: true, count: LOD_MESHES[l].indexCount, instances: n });
  });
  return { passes: [{ name: 'scene', target: 'the canvas, with a depth buffer', w: 0, h: 0, draws }] };
}
