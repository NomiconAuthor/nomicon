/**
 * "Shadow maps": the CPU-side model of the lesson's frame. No DOM, no GPU.
 *
 * The sun is a directional light, so its shadow map is an orthographic depth image: one for the
 * whole courtyard, or four cascades sharing the same texture (a 2 × 2 atlas, each a quarter of the
 * texels) fitted to slices of the camera's view. Everything the renderers need to place the maps
 * (the light's basis, each map's box, split distances, texel sizes) is computed here, and so are the
 * lesson's numbers: the model casts a ray through each pixel of a 320 × 200 image, looks the hit up
 * in a shadow map built the same way (the nearest surface along a ray through each texel's
 * centre, which is what the rasteriser stores), applies the same bias, and compares the answer with
 * the truth: a ray from the surface towards the sun.
 */
import { type Camera, type V3, cross3, dot3, norm3, v3 } from '../raster';
import { type FramePlan } from '../gpu/plan';
import { viewProj } from '../gpu/scene';
import { COURTYARD_CAMERA, FLOOR, VIEW_H, VIEW_W, blocked, cast, courtyardDraws, pixelRay } from './courtyard';

export type Filter = 'none' | 'bilinear' | 'pcf3' | 'pcf5';
export type ShadowView = 'lit' | 'cascades' | 'texels' | 'map';
export interface ShadowSettings {
  /** Unit vector towards the sun. */
  sun: V3;
  /** Shadow-map size: the whole map's width and height in texels (cascades share it, a quarter each). */
  res: number;
  /** Constant bias, metres. */
  bias: number;
  /** Slope-scaled bias: this many texels' width × tan θ. */
  slope: number;
  filter: Filter;
  cascades: boolean;
  /** Split scheme: 0 uniform, 1 logarithmic (Zhang et al.'s practical scheme blends them). */
  lambda: number;
  stable: boolean;
  /** How far the camera has moved forward (metres), for the moving-camera demo. */
  dolly: number;
  view: ShadowView;
}
/** The sun this lesson starts with: lower than the concept lessons' KEY_LIGHT and from the right, so shadows fall towards the camera. */
export const SUN_ELEVATION = 35;
export const SUN_AZIMUTH = 115;
export const SHADOW_DEFAULTS: ShadowSettings = { sun: sunFrom(SUN_ELEVATION, SUN_AZIMUTH), res: 1024, bias: 0, slope: 0, filter: 'none', cascades: false, lambda: 0.5, stable: true, dolly: 0, view: 'lit' };
export const RESOLUTIONS = [256, 512, 1024, 2048];
/** A sensible pair of biases for this scene, which the lesson quotes. */
export const GOOD_BIAS = { bias: 0.02, slope: 1.5 };
/** The slope term's tan θ is capped here (θ ≈ 84°), so grazing surfaces don't get unbounded bias. */
export const MAX_TAN = 10;

/** The sun from elevation and azimuth (degrees; azimuth 0 is towards +z, behind the camera). */
export function sunFrom(elevation: number, azimuth: number): V3 {
  const e = (elevation * Math.PI) / 180;
  const a = (azimuth * Math.PI) / 180;
  return v3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
}
export const sunAngles = (d: V3) => ({ elevation: (Math.asin(d.y) * 180) / Math.PI, azimuth: (Math.atan2(d.x, d.z) * 180) / Math.PI });

// ---------------------------------------------------------------------------------------------
// The light's frame and its maps

export interface LightBasis {
  right: V3;
  up: V3;
  /** The direction the light looks: away from the sun. */
  fwd: V3;
}
export function lightBasis(sun: V3): LightBasis {
  const fwd = v3(-sun.x, -sun.y, -sun.z);
  const ref = Math.abs(fwd.y) > 0.99 ? v3(0, 0, 1) : v3(0, 1, 0);
  const right = norm3(cross3(ref, fwd));
  const up = cross3(fwd, right);
  return { right, up, fwd };
}

/** One shadow map: a box in the light's frame, x and y half-sizes around a centre, depth zNear..zNear+range. */
export interface ShadowBox {
  cx: number;
  cy: number;
  half: number;
  zNear: number;
  range: number;
  /** Texels across this map (the whole texture, or a cascade's quarter). */
  texels: number;
  /** World size of one texel. */
  texel: number;
  /** Where the map sits in the texture, as a fraction (0 or 0.5), and its size (1 or 0.5). */
  ox: number;
  oy: number;
  scale: number;
}

/** The scene's bounding box: everything that can cast or receive. */
const SCENE_MIN = v3(FLOOR.x0, 0, -35);
const SCENE_MAX = v3(FLOOR.x1, 4, FLOOR.z0);
const corners = (a: V3, b: V3): V3[] => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => v3(i & 1 ? b.x : a.x, i & 2 ? b.y : a.y, i & 4 ? b.z : a.z));

/** Depth range along the light: the whole scene, so every caster lands in the map (no pancaking needed). */
function depthRange(L: LightBasis): { zNear: number; range: number } {
  const ds = corners(SCENE_MIN, SCENE_MAX).map((p) => dot3(p, L.fwd));
  const zNear = Math.min(...ds) - 0.5;
  return { zNear, range: Math.max(...ds) + 0.5 - zNear };
}

/** One map for the whole courtyard: the scene's box, seen from the light. */
export function sceneBox(sun: V3, res: number): ShadowBox {
  const L = lightBasis(sun);
  const pts = corners(SCENE_MIN, SCENE_MAX);
  const xs = pts.map((p) => dot3(p, L.right));
  const ys = pts.map((p) => dot3(p, L.up));
  const half = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
  return { cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2, half, ...depthRange(L), texels: res, texel: (2 * half) / res, ox: 0, oy: 0, scale: 1 };
}

export const CASCADES = 4;
/** Cascades cover the view out to this distance; beyond it, nothing is shadowed. */
export const SHADOW_DISTANCE = 40;

/** Split distances: Zhang et al.'s practical split scheme, λ between uniform (0) and logarithmic (1). */
export function splits(lambda: number, near = COURTYARD_CAMERA.near, far = SHADOW_DISTANCE, n = CASCADES): number[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    if (i === 0) return near;
    const log = near * (far / near) ** (i / n);
    const uni = near + ((far - near) * i) / n;
    return lambda * log + (1 - lambda) * uni;
  });
}

export function camera(dolly: number): Camera {
  const c = COURTYARD_CAMERA;
  return { ...c, eye: v3(c.eye.x, c.eye.y, c.eye.z - dolly), target: v3(c.target.x, c.target.y, c.target.z - dolly) };
}

/** The eight corners of the camera frustum's slice between view depths z0 and z1. */
function sliceCorners(cam: Camera, z0: number, z1: number): V3[] {
  const f = norm3(v3(cam.target.x - cam.eye.x, cam.target.y - cam.eye.y, cam.target.z - cam.eye.z));
  const r = norm3(cross3(f, v3(0, 1, 0)));
  const u = cross3(r, f);
  const out: V3[] = [];
  for (const z of [z0, z1])
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const x = (sx * z * cam.aspect) / cam.focal;
        const y = (sy * z) / cam.focal;
        out.push(v3(cam.eye.x + f.x * z + r.x * x + u.x * y, cam.eye.y + f.y * z + r.y * x + u.y * y, cam.eye.z + f.z * z + r.z * x + u.z * y));
      }
  return out;
}

/**
 * The cascades' boxes. Stable: each fitted to its slice's bounding sphere (a size that doesn't change as the
 * camera turns), centre snapped to whole texels, so the map's texels stay put as the camera moves (the
 * stabilisation in Microsoft's "Common Techniques to Improve Shadow Depth Maps"). Unstable: fitted to the
 * slice's corners in the light's frame, which is tighter but slides and resizes every frame.
 */
export function cascadeBoxes(s: Pick<ShadowSettings, 'sun' | 'res' | 'lambda' | 'stable' | 'dolly'>): ShadowBox[] {
  const L = lightBasis(s.sun);
  const cam = camera(s.dolly);
  const z = splits(s.lambda);
  const texels = s.res / 2;
  const depth = depthRange(L);
  return Array.from({ length: CASCADES }, (_, i) => {
    const pts = sliceCorners(cam, z[i], z[i + 1]);
    let cx: number;
    let cy: number;
    let half: number;
    if (s.stable) {
      const c = pts.reduce((a, p) => v3(a.x + p.x / 8, a.y + p.y / 8, a.z + p.z / 8), v3(0, 0, 0));
      half = Math.max(...pts.map((p) => Math.sqrt(dot3(v3(p.x - c.x, p.y - c.y, p.z - c.z), v3(p.x - c.x, p.y - c.y, p.z - c.z)))));
      const texel = (2 * half) / texels;
      cx = Math.floor(dot3(c, L.right) / texel) * texel;
      cy = Math.floor(dot3(c, L.up) / texel) * texel;
    } else {
      const xs = pts.map((p) => dot3(p, L.right));
      const ys = pts.map((p) => dot3(p, L.up));
      half = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
      cx = (Math.max(...xs) + Math.min(...xs)) / 2;
      cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    }
    return { cx, cy, half, ...depth, texels, texel: (2 * half) / texels, ox: (i % 2) * 0.5, oy: Math.floor(i / 2) * 0.5, scale: 0.5 };
  });
}

export function shadowBoxes(s: ShadowSettings): ShadowBox[] {
  return s.cascades ? cascadeBoxes(s) : [sceneBox(s.sun, s.res)];
}

/** The light's view-projection for one box, column-major: x, y to −1..1 across the box, depth 0..1 along it. */
export function lightMatrix(L: LightBasis, b: ShadowBox): Float32Array {
  const rows = [
    [L.right.x / b.half, L.right.y / b.half, L.right.z / b.half, -b.cx / b.half],
    [L.up.x / b.half, L.up.y / b.half, L.up.z / b.half, -b.cy / b.half],
    [L.fwd.x / b.range, L.fwd.y / b.range, L.fwd.z / b.range, -b.zNear / b.range],
    [0, 0, 0, 1],
  ];
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) m[c * 4 + r] = rows[r][c];
  return m;
}

/** Which cascade a view depth falls in (−1: beyond the shadow distance). */
export function cascadeOf(z: number, lambda: number): number {
  const sp = splits(lambda);
  for (let i = 0; i < CASCADES; i++) if (z < sp[i + 1]) return i;
  return -1;
}

// ---------------------------------------------------------------------------------------------
// The test

export const MODEL_W = 320;
export const MODEL_H = 200;

export interface ShadowStats {
  /** Pixels that face the sun (n · l > 0), in the model's image. */
  facing: number;
  /** Of those, lit in truth / shadowed in truth. */
  lit: number;
  shadowed: number;
  /** Lit in truth, but the map says shadowed: acne. */
  acne: number;
  /** Shadowed in truth, but the map says lit: light leaking, as peter-panning does at contacts. */
  leaks: number;
}

/** The bias, in metres along the light, for a surface whose normal makes cos θ with the sun. */
export function biasAt(s: Pick<ShadowSettings, 'bias' | 'slope'>, texel: number, cosT: number): number {
  const c = Math.max(1e-4, Math.min(1, cosT));
  const tan = Math.min(MAX_TAN, Math.sqrt(1 - c * c) / c);
  return s.bias + s.slope * texel * tan;
}

/** Run the model: every pixel of a MODEL_W × MODEL_H image, single map or cascades, one tap. */
export function shadowStats(s: ShadowSettings): ShadowStats {
  const L = lightBasis(s.sun);
  const boxes = shadowBoxes(s);
  const cam = camera(s.dolly);
  const stored = new Map<number, number>();
  const st: ShadowStats = { facing: 0, lit: 0, shadowed: 0, acne: 0, leaks: 0 };
  for (let y = 0; y < MODEL_H; y++)
    for (let x = 0; x < MODEL_W; x++) {
      const h = cast(cam.eye, pixelRay(cam, x, y, MODEL_W, MODEL_H));
      if (!h) continue;
      const cosT = dot3(h.n, s.sun);
      if (cosT <= 0) continue;
      const ci = s.cascades ? cascadeOf(h.t, s.lambda) : 0;
      if (ci < 0) continue;
      st.facing++;
      const truth = !blocked(v3(h.p.x + h.n.x * 1e-4, h.p.y + h.n.y * 1e-4, h.p.z + h.n.z * 1e-4), s.sun);
      if (truth) st.lit++;
      else st.shadowed++;
      const b = boxes[ci];
      const lx = (dot3(h.p, L.right) - b.cx) / b.half;
      const ly = (dot3(h.p, L.up) - b.cy) / b.half;
      if (Math.abs(lx) >= 1 || Math.abs(ly) >= 1) {
        if (!truth) st.leaks++;
        continue;
      }
      const ix = Math.floor(((lx + 1) / 2) * b.texels);
      const iy = Math.floor(((ly + 1) / 2) * b.texels);
      const key = (ci * 4096 + iy) * 4096 + ix;
      let d = stored.get(key);
      if (d === undefined) {
        // The texel's centre, on the light's near plane, looking along the light.
        const tx = b.cx + (((ix + 0.5) / b.texels) * 2 - 1) * b.half;
        const ty = b.cy + (((iy + 0.5) / b.texels) * 2 - 1) * b.half;
        const o = v3(L.right.x * tx + L.up.x * ty + L.fwd.x * b.zNear, L.right.y * tx + L.up.y * ty + L.fwd.y * b.zNear, L.right.z * tx + L.up.z * ty + L.fwd.z * b.zNear);
        const hit = cast(o, L.fwd);
        d = hit ? hit.t : Infinity;
        stored.set(key, d);
      }
      const receiver = dot3(h.p, L.fwd) - b.zNear;
      const shadowed = receiver - biasAt(s, b.texel, cosT) > d;
      if (truth && shadowed) st.acne++;
      if (!truth && !shadowed) st.leaks++;
    }
  return st;
}

/** The size of one screen pixel on the floor at view depth z, for comparing with a texel. */
export const pixelFootprint = (z: number) => (2 * z) / COURTYARD_CAMERA.focal / VIEW_H;

// ---------------------------------------------------------------------------------------------
// The frame

export const SHADOW_PASS = 'shadow';
export const LIT_PASS = 'lit';
export const MAP_VIEW = 'show map';
export const shadowDraws = () => courtyardDraws();

export function shadowPlan(s: ShadowSettings, w: number, h: number): FramePlan {
  const draws = shadowDraws();
  const maps = s.cascades ? CASCADES : 1;
  const casters = Array.from({ length: maps }, (_, c) => draws.map((d) => ({ name: maps > 1 ? `${d.name}, cascade ${c + 1}` : d.name, pipeline: SHADOW_PASS, indexed: true, count: d.mesh.indexCount, instances: 1 }))).flat();
  return {
    passes: [
      { name: 'shadow map', target: `depth, ${s.res} × ${s.res}`, w: s.res, h: s.res, draws: casters },
      {
        name: 'camera',
        target: `the canvas + depth, ${w} × ${h}`,
        w,
        h,
        draws: s.view === 'map' ? [{ name: 'the shadow map', pipeline: MAP_VIEW, indexed: false, count: 3, instances: 1 }] : draws.map((d) => ({ name: d.name, pipeline: LIT_PASS, indexed: true, count: d.mesh.indexCount, instances: 1 })),
      },
    ],
  };
}

export const shadowViewProj = (dolly: number) => viewProj(camera(dolly));
export { VIEW_W, VIEW_H };
