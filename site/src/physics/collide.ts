/**
 * Shapes, mass properties and collision for the teaching engine: contact manifolds by SAT and
 * edge clipping (as in Box2D), ray and circle casts, and step-by-step SAT and GJK/EPA traces for
 * the narrowphase lesson.
 */
import { type AABB, type Transform, type V, add, cross, dot, invRotate, invXf, len, lenSq, neg, norm, rotate, scale, sub, v, xf } from './math';

export interface Circle {
  kind: 'circle';
  r: number;
}
export interface Polygon {
  kind: 'poly';
  /** Counter-clockwise, centred on the centroid. */
  verts: V[];
  normals: V[];
  /** Largest vertex distance from the centre, for quick bounds. */
  radius: number;
}
export type Shape = Circle | Polygon;

export const circle = (r: number): Circle => ({ kind: 'circle', r });

/** A convex polygon from points (any order); recentred on its centroid. Returns the shift. */
export function polygon(points: V[]): { shape: Polygon; centroid: V } {
  // Convex hull (gift wrapping is plenty for a handful of points), counter-clockwise.
  const pts = [...points];
  let i0 = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].x > pts[i0].x || (pts[i].x === pts[i0].x && pts[i].y < pts[i0].y)) i0 = i;
  const hull: V[] = [];
  let ih = i0;
  for (;;) {
    hull.push(pts[ih]);
    let ie = 0;
    for (let j = 1; j < pts.length; j++) {
      if (ie === ih) {
        ie = j;
        continue;
      }
      const c = cross(sub(pts[ie], pts[ih]), sub(pts[j], pts[ih]));
      if (c < 0 || (c === 0 && lenSq(sub(pts[j], pts[ih])) > lenSq(sub(pts[ie], pts[ih])))) ie = j;
    }
    ih = ie;
    if (ie === i0 || hull.length > pts.length) break;
  }
  // Centroid by triangle fan.
  let area = 0;
  let cx = 0;
  let cy = 0;
  const o = hull[0];
  for (let i = 1; i < hull.length - 1; i++) {
    const e1 = sub(hull[i], o);
    const e2 = sub(hull[i + 1], o);
    const a = cross(e1, e2) / 2;
    area += a;
    cx += (a * (e1.x + e2.x)) / 3;
    cy += (a * (e1.y + e2.y)) / 3;
  }
  const centroid = v(o.x + cx / area, o.y + cy / area);
  const verts = hull.map((p) => sub(p, centroid));
  return { shape: makePoly(verts), centroid };
}

function makePoly(verts: V[]): Polygon {
  // Outward normal of each counter-clockwise edge p -> q is (e.y, -e.x), normalised.
  const normals = verts.map((p, i) => {
    const q = verts[(i + 1) % verts.length];
    return norm(v(q.y - p.y, -(q.x - p.x)));
  });
  return { kind: 'poly', verts, normals, radius: Math.max(...verts.map(len)) };
}

export const box = (hw: number, hh: number): Polygon => makePoly([v(-hw, -hh), v(hw, -hh), v(hw, hh), v(-hw, hh)]);

/** Mass, centroid-relative rotational inertia, for a density in kg/m². */
export function massOf(s: Shape, density: number): { mass: number; inertia: number } {
  if (s.kind === 'circle') {
    const m = density * 3.141592653589793 * s.r * s.r;
    return { mass: m, inertia: 0.5 * m * s.r * s.r };
  }
  let area = 0;
  let I = 0;
  const vs = s.verts;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i];
    const b = vs[(i + 1) % vs.length];
    const c = cross(a, b);
    area += c / 2;
    I += (c * (dot(a, a) + dot(a, b) + dot(b, b))) / 12;
  }
  return { mass: density * area, inertia: density * I };
}

export function aabbOf(s: Shape, t: Transform, margin = 0): AABB {
  if (s.kind === 'circle') {
    const r = s.r + margin;
    return { lo: v(t.p.x - r, t.p.y - r), hi: v(t.p.x + r, t.p.y + r) };
  }
  let lx = Infinity;
  let ly = Infinity;
  let hx = -Infinity;
  let hy = -Infinity;
  for (const p of s.verts) {
    const w = xf(t, p);
    if (w.x < lx) lx = w.x;
    if (w.y < ly) ly = w.y;
    if (w.x > hx) hx = w.x;
    if (w.y > hy) hy = w.y;
  }
  return { lo: v(lx - margin, ly - margin), hi: v(hx + margin, hy + margin) };
}

// ---------------------------------------------------------------------------------------------
// Manifolds

export interface ManifoldPoint {
  /** Contact anchors in each body's local frame. */
  localA: V;
  localB: V;
  separation: number;
  /** Feature id, stable from frame to frame while the same features touch: warm starting keys on it. */
  id: number;
}
export interface Manifold {
  /** World normal, pointing from A to B. */
  normal: V;
  points: ManifoldPoint[];
}

/** Which pair of features (and which axis) produced the manifold, for the lesson view. */
export interface ManifoldInfo {
  refBody: 'A' | 'B';
  refEdge: number;
  incEdge: number;
  sepA: number;
  sepB: number;
}

const LINEAR_SLOP = 0.005;

function maxSeparation(a: Polygon, ta: Transform, b: Polygon, tb: Transform): { edge: number; sep: number } {
  let best = -Infinity;
  let edge = 0;
  for (let i = 0; i < a.verts.length; i++) {
    const n = rotate(ta.q, a.normals[i]);
    const p = xf(ta, a.verts[i]);
    let min = Infinity;
    for (const q of b.verts) {
      const d = dot(n, sub(xf(tb, q), p));
      if (d < min) min = d;
    }
    if (min > best) {
      best = min;
      edge = i;
    }
  }
  return { edge, sep: best };
}

export function collidePolygons(a: Polygon, ta: Transform, b: Polygon, tb: Transform, speculative: number, info?: ManifoldInfo): Manifold | null {
  const sa = maxSeparation(a, ta, b, tb);
  if (sa.sep > speculative) return null;
  const sb = maxSeparation(b, tb, a, ta);
  if (sb.sep > speculative) return null;
  // Prefer A's face unless B's is clearly better, so the reference face doesn't flicker.
  const flip = sb.sep > sa.sep + 0.1 * LINEAR_SLOP;
  const [ref, tr, inc, ti, refEdge] = flip ? [b, tb, a, ta, sb.edge] : [a, ta, b, tb, sa.edge];
  const nRef = rotate(tr.q, ref.normals[refEdge]);
  // Incident edge: the one on the other polygon whose normal is most opposed to the reference normal.
  let incEdge = 0;
  let minDot = Infinity;
  for (let i = 0; i < inc.normals.length; i++) {
    const d = dot(nRef, rotate(ti.q, inc.normals[i]));
    if (d < minDot) {
      minDot = d;
      incEdge = i;
    }
  }
  const i1 = incEdge;
  const i2 = (incEdge + 1) % inc.verts.length;
  let c1 = { p: xf(ti, inc.verts[i1]), id: i1 };
  let c2 = { p: xf(ti, inc.verts[i2]), id: i2 };
  const r1 = xf(tr, ref.verts[refEdge]);
  const r2 = xf(tr, ref.verts[(refEdge + 1) % ref.verts.length]);
  const tangent = norm(sub(r2, r1));
  // Clip the incident segment to the reference edge's side planes.
  const clip = (p1: typeof c1, p2: typeof c1, n: V, off: number): [typeof c1, typeof c1] | null => {
    const d1 = dot(n, p1.p) - off;
    const d2 = dot(n, p2.p) - off;
    if (d1 > 0 && d2 > 0) return null;
    if (d1 <= 0 && d2 <= 0) return [p1, p2];
    const t = d1 / (d1 - d2);
    const cp = { p: add(p1.p, scale(sub(p2.p, p1.p), t)), id: (d1 > 0 ? p1.id : p2.id) | 0x80 };
    return d1 > 0 ? [cp, p2] : [p1, cp];
  };
  const k1 = clip(c1, c2, neg(tangent), -dot(tangent, r1));
  if (!k1) return null;
  const k2 = clip(k1[0], k1[1], tangent, dot(tangent, r2));
  if (!k2) return null;
  [c1, c2] = k2;
  const front = dot(nRef, r1);
  const normal = flip ? neg(nRef) : nRef;
  const points: ManifoldPoint[] = [];
  for (const c of [c1, c2]) {
    const sep = dot(nRef, c.p) - front;
    if (sep > speculative) continue;
    const onRef = sub(c.p, scale(nRef, sep));
    const pa = flip ? c.p : onRef;
    const pb = flip ? onRef : c.p;
    points.push({ localA: invXf(ta, pa), localB: invXf(tb, pb), separation: sep, id: (flip ? 0x10000 : 0) | (refEdge << 8) | c.id });
  }
  if (info) Object.assign(info, { refBody: flip ? 'B' : 'A', refEdge, incEdge, sepA: sa.sep, sepB: sb.sep });
  return points.length ? { normal, points } : null;
}

export function collideCirclePolygon(c: Circle, tc: Transform, p: Polygon, tp: Transform, speculative: number): Manifold | null {
  // Work in the polygon's frame; the manifold normal points from the polygon to the circle.
  const cl = invXf(tp, tc.p);
  let best = -Infinity;
  let edge = 0;
  for (let i = 0; i < p.verts.length; i++) {
    const s = dot(p.normals[i], sub(cl, p.verts[i]));
    if (s > best) {
      best = s;
      edge = i;
    }
  }
  if (best - c.r > speculative) return null;
  const v1 = p.verts[edge];
  const v2 = p.verts[(edge + 1) % p.verts.length];
  let n: V;
  let onPoly: V;
  const u1 = dot(sub(cl, v1), sub(v2, v1));
  const u2 = dot(sub(cl, v2), sub(v1, v2));
  if (best > 0 && u1 <= 0) {
    n = norm(sub(cl, v1));
    onPoly = v1;
    best = len(sub(cl, v1));
  } else if (best > 0 && u2 <= 0) {
    n = norm(sub(cl, v2));
    onPoly = v2;
    best = len(sub(cl, v2));
  } else {
    n = p.normals[edge];
    onPoly = sub(cl, scale(n, best));
  }
  const sep = best - c.r;
  if (sep > speculative) return null;
  const nw = rotate(tp.q, n);
  const pw = xf(tp, onPoly);
  const cw = sub(tc.p, scale(nw, c.r));
  return { normal: nw, points: [{ localA: invXf(tp, pw), localB: invXf(tc, cw), separation: sep, id: edge }] };
}

export function collideCircles(a: Circle, ta: Transform, b: Circle, tb: Transform, speculative: number): Manifold | null {
  const d = sub(tb.p, ta.p);
  const dist = len(d);
  const sep = dist - a.r - b.r;
  if (sep > speculative) return null;
  const n = dist > 1e-9 ? scale(d, 1 / dist) : v(0, 1);
  const pa = add(ta.p, scale(n, a.r));
  const pb = sub(tb.p, scale(n, b.r));
  return { normal: n, points: [{ localA: invXf(ta, pa), localB: invXf(tb, pb), separation: sep, id: 0 }] };
}

/** Any pair of shapes. The normal always points from A to B. */
export function collide(a: Shape, ta: Transform, b: Shape, tb: Transform, speculative: number, info?: ManifoldInfo): Manifold | null {
  if (a.kind === 'poly' && b.kind === 'poly') return collidePolygons(a, ta, b, tb, speculative, info);
  if (a.kind === 'circle' && b.kind === 'circle') return collideCircles(a, ta, b, tb, speculative);
  if (a.kind === 'poly' && b.kind === 'circle') return collideCirclePolygon(b, tb, a, ta, speculative);
  // Circle A against polygon B: collide the other way round, then swap.
  const m = collideCirclePolygon(a as Circle, ta, b as Polygon, tb, speculative);
  if (!m) return null;
  return { normal: neg(m.normal), points: m.points.map((p) => ({ localA: p.localB, localB: p.localA, separation: p.separation, id: p.id })) };
}

// ---------------------------------------------------------------------------------------------
// Casts

export interface RayHit {
  t: number;
  point: V;
  normal: V;
}

/** Ray p + t*d (t in [0, maxT]) against a shape. */
export function raycast(s: Shape, t: Transform, p: V, d: V, maxT: number): RayHit | null {
  if (s.kind === 'circle') return rayCircle(t.p, s.r, p, d, maxT);
  // Slab clipping in the polygon's frame.
  const lp = invXf(t, p);
  const ld = invRotate(t.q, d);
  let lo = 0;
  let hi = maxT;
  let idx = -1;
  for (let i = 0; i < s.verts.length; i++) {
    const n = s.normals[i];
    const num = dot(n, sub(s.verts[i], lp));
    const den = dot(n, ld);
    if (den === 0) {
      if (num < 0) return null;
    } else if (den < 0 && num < lo * den) {
      lo = num / den;
      idx = i;
    } else if (den > 0 && num < hi * den) hi = num / den;
    if (hi < lo) return null;
  }
  if (idx < 0) return null;
  return { t: lo, point: add(p, scale(d, lo)), normal: rotate(t.q, s.normals[idx]) };
}

function rayCircle(c: V, r: number, p: V, d: V, maxT: number): RayHit | null {
  const m = sub(p, c);
  const a = dot(d, d);
  const b = dot(m, d);
  const cc = dot(m, m) - r * r;
  const disc = b * b - a * cc;
  if (disc < 0 || a === 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  if (t < 0 || t > maxT) return null;
  const point = add(p, scale(d, t));
  return { t, point, normal: norm(sub(point, c)) };
}

/** A circle of radius r swept from p along d (t in [0, maxT]) against a shape. */
export function circleCast(s: Shape, t: Transform, r: number, p: V, d: V, maxT: number): RayHit | null {
  if (s.kind === 'circle') {
    const h = rayCircle(t.p, s.r + r, p, d, maxT);
    return h && { ...h, point: sub(h.point, scale(h.normal, r)) };
  }
  // Ray against the polygon grown by r: each edge pushed out by r, and a circle at each vertex.
  let best: RayHit | null = null;
  const n = s.verts.length;
  for (let i = 0; i < n; i++) {
    const nw = rotate(t.q, s.normals[i]);
    const a = add(xf(t, s.verts[i]), scale(nw, r));
    const b = add(xf(t, s.verts[(i + 1) % n]), scale(nw, r));
    const den = dot(nw, d);
    if (den < 0) {
      const tt = dot(nw, sub(a, p)) / den;
      if (tt >= 0 && tt <= maxT && (!best || tt < best.t)) {
        const q = add(p, scale(d, tt));
        const e = sub(b, a);
        const u = dot(sub(q, a), e) / dot(e, e);
        if (u >= 0 && u <= 1) best = { t: tt, point: sub(q, scale(nw, r)), normal: nw };
      }
    }
    const hc = rayCircle(xf(t, s.verts[i]), r, p, d, maxT);
    if (hc && (!best || hc.t < best.t)) best = { t: hc.t, point: xf(t, s.verts[i]), normal: hc.normal };
  }
  // Starting inside counts as a hit at t = 0.
  return best;
}

// ---------------------------------------------------------------------------------------------
// Lesson traces: SAT axes, and GJK / EPA on the Minkowski difference

export interface SatAxis {
  body: 'A' | 'B';
  edge: number;
  /** World axis (an edge normal). */
  n: V;
  /** Projection intervals of A and B on the axis. */
  a: [number, number];
  b: [number, number];
  /** Signed gap between the intervals along this axis (positive: separated). */
  gap: number;
}

export function satAxes(a: Polygon, ta: Transform, b: Polygon, tb: Transform): SatAxis[] {
  const proj = (p: Polygon, t: Transform, n: V): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const q of p.verts) {
      const d = dot(n, xf(t, q));
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    return [lo, hi];
  };
  const out: SatAxis[] = [];
  for (const [body, p, t, o, to] of [
    ['A', a, ta, b, tb],
    ['B', b, tb, a, ta],
  ] as const) {
    p.normals.forEach((nl, i) => {
      const n = rotate(t.q, nl);
      const pi = proj(p, t, n);
      const oi = proj(o, to, n);
      // Separation along this face normal: how far the other polygon's nearest vertex is in front of the face.
      const gap = oi[0] - pi[1];
      out.push({ body, edge: i, n, a: body === 'A' ? pi : oi, b: body === 'A' ? oi : pi, gap });
    });
  }
  return out;
}

export function support(s: Shape, t: Transform, d: V): V {
  if (s.kind === 'circle') return add(t.p, scale(norm(d), s.r));
  const ld = invRotate(t.q, d);
  let best = s.verts[0];
  let bd = dot(best, ld);
  for (const p of s.verts) {
    const dd = dot(p, ld);
    if (dd > bd) {
      bd = dd;
      best = p;
    }
  }
  return xf(t, best);
}

/** A point of the Minkowski difference B - A in direction d. */
const supportDiff = (a: Shape, ta: Transform, b: Shape, tb: Transform, d: V): V => sub(support(b, tb, d), support(a, ta, neg(d)));

/** The Minkowski difference B - A as a polygon outline (for drawing; circles sampled). */
export function minkowskiOutline(a: Shape, ta: Transform, b: Shape, tb: Transform, samples = 48): V[] {
  const out: V[] = [];
  for (let i = 0; i < samples; i++) {
    const ang = (i / samples) * 2 * Math.PI;
    out.push(supportDiff(a, ta, b, tb, v(Math.cos(ang), Math.sin(ang))));
  }
  // Drop consecutive duplicates (polygon vertices are hit by many directions).
  return out.filter((p, i) => i === 0 || lenSq(sub(p, out[i - 1])) > 1e-12);
}

export interface GjkStep {
  simplex: V[];
  dir: V;
  note: string;
}
export interface GjkResult {
  steps: GjkStep[];
  hit: boolean;
  /** Closest point of B - A to the origin when separated: the distance is its length. */
  closest: V | null;
  /** EPA polytopes when overlapping, ending with the penetration vector. */
  epa: Array<{ poly: V[]; edge: number; note: string }>;
  penetration: V | null;
}

function closestOnSegment(a: V, b: V): { p: V; t: number } {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, -dot(a, ab) / (dot(ab, ab) || 1)));
  return { p: add(a, scale(ab, t)), t };
}

/** GJK distance on the Minkowski difference, recording each simplex; then EPA if overlapping. */
export function gjk(a: Shape, ta: Transform, b: Shape, tb: Transform): GjkResult {
  const steps: GjkStep[] = [];
  let d = sub(tb.p, ta.p);
  if (lenSq(d) < 1e-12) d = v(1, 0);
  let simplex: V[] = [supportDiff(a, ta, b, tb, d)];
  d = neg(simplex[0]);
  steps.push({ simplex: [...simplex], dir: d, note: 'Start with any support point; search towards the origin from it.' });
  let closest: V | null = null;
  for (let iter = 0; iter < 20; iter++) {
    if (lenSq(d) < 1e-14) break;
    const p = supportDiff(a, ta, b, tb, d);
    // No progress towards the origin: the current closest point is the answer.
    const cur = simplex.length === 1 ? simplex[0] : closestOnSegment(simplex[0], simplex[1]).p;
    if (dot(p, d) - dot(cur, d) < 1e-9 * Math.max(1, lenSq(d))) {
      closest = cur;
      steps.push({ simplex: [...simplex], dir: d, note: `No support point gets closer: separated, distance ${len(cur).toFixed(3)} m.` });
      return { steps, hit: false, closest, epa: [], penetration: null };
    }
    simplex.push(p);
    if (simplex.length === 2) {
      const { p: q, t } = closestOnSegment(simplex[0], simplex[1]);
      if (t === 0) simplex = [simplex[0]];
      else if (t === 1) simplex = [simplex[1]];
      d = neg(q);
      steps.push({ simplex: [...simplex], dir: d, note: 'Add the support point; keep the part of the line closest to the origin.' });
    } else {
      // Triangle: does it contain the origin? If not, keep the edge facing it.
      const [s0, s1, s2] = simplex;
      const c0 = cross(sub(s1, s0), neg(s0));
      const c1 = cross(sub(s2, s1), neg(s1));
      const c2 = cross(sub(s0, s2), neg(s2));
      if ((c0 >= 0 && c1 >= 0 && c2 >= 0) || (c0 <= 0 && c1 <= 0 && c2 <= 0)) {
        steps.push({ simplex: [...simplex], dir: v(0, 0), note: 'The triangle contains the origin: the shapes overlap.' });
        return { steps, hit: true, closest: null, ...epa(a, ta, b, tb, simplex) };
      }
      let bestE: [V, V] = [s0, s1];
      let bestQ = closestOnSegment(s0, s1).p;
      for (const e of [
        [s1, s2],
        [s2, s0],
      ] as Array<[V, V]>) {
        const q = closestOnSegment(e[0], e[1]).p;
        if (lenSq(q) < lenSq(bestQ)) {
          bestQ = q;
          bestE = e;
        }
      }
      simplex = [...bestE];
      d = neg(bestQ);
      steps.push({ simplex: [s0, s1, s2], dir: d, note: 'The triangle misses the origin: keep its edge closest to it and search past that edge.' });
    }
  }
  closest = simplex.length === 1 ? simplex[0] : closestOnSegment(simplex[0], simplex[1]).p;
  return { steps, hit: false, closest, epa: [], penetration: null };
}

function epa(a: Shape, ta: Transform, b: Shape, tb: Transform, tri: V[]): { epa: GjkResult['epa']; penetration: V } {
  let poly = [...tri];
  if (cross(sub(poly[1], poly[0]), sub(poly[2], poly[0])) < 0) poly = [poly[0], poly[2], poly[1]];
  const out: GjkResult['epa'] = [];
  for (let iter = 0; iter < 32; iter++) {
    // The edge closest to the origin.
    let bi = 0;
    let bd = Infinity;
    let bn = v(0, 0);
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const n = norm(v(q.y - p.y, -(q.x - p.x)));
      const dist = dot(n, p);
      if (dist < bd) {
        bd = dist;
        bi = i;
        bn = n;
      }
    }
    const s = supportDiff(a, ta, b, tb, bn);
    if (dot(s, bn) - bd < 1e-6) {
      out.push({ poly: [...poly], edge: bi, note: `The closest edge can't be pushed further out: penetration ${bd.toFixed(3)} m along its normal.` });
      return { epa: out, penetration: scale(bn, bd) };
    }
    out.push({ poly: [...poly], edge: bi, note: 'Push the edge closest to the origin outwards with a new support point.' });
    poly.splice(bi + 1, 0, s);
  }
  return { epa: out, penetration: null as unknown as V };
}
