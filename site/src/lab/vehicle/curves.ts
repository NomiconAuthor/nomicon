/**
 * Shortest paths for a car with a minimum turning radius, ignoring obstacles.
 *
 * Dubins (1957): forward only. The shortest path is one of six words made of
 * arcs at full lock (L, R) and straights (S): LSL, RSR, LSR, RSL, RLR, LRL.
 *
 * Reeds and Shepp (1990): forward and reverse. The shortest path is one of 48
 * words of up to five pieces, with at most two gear changes. The formulas below
 * follow the well-known OMPL implementation.
 *
 * Both are used three ways: as a heuristic (a lower bound on how far the car must
 * drive), as Hybrid A*'s "analytic expansion" (try to drive straight to the goal),
 * and as the steering function of the vehicle RRT.
 *
 * Frame: x right, y down, heading theta measured from +x toward +y. "L" is a turn
 * with increasing theta. Every candidate path is integrated and kept only if it
 * really ends at the goal pose, so a mistake in one formula costs optimality,
 * never correctness.
 */

export interface Pose {
  x: number;
  y: number;
  theta: number;
}

/** One piece: steer +1 (L), 0 (S) or -1 (R); signed length (negative = reverse), in units of the turning radius. */
export interface Piece {
  steer: number;
  len: number;
}

export interface CurvePath {
  pieces: Piece[];
  /** Total length in map units (radius already applied). */
  length: number;
  radius: number;
}

const PI = Math.PI;
const TWO_PI = 2 * Math.PI;
const ZERO = 1e-9;

export function mod2pi(a: number): number {
  let v = a % TWO_PI;
  if (v < 0) v += TWO_PI;
  return v;
}

/** Wraps to (-pi, pi]. */
export function wrapPi(a: number): number {
  let v = mod2pi(a);
  if (v > PI) v -= TWO_PI;
  return v;
}

/** Moves a pose along one piece of signed length `t` (unit radius). */
function stepUnit(x: number, y: number, th: number, steer: number, t: number): [number, number, number] {
  if (steer === 0) return [x + t * Math.cos(th), y + t * Math.sin(th), th];
  const th2 = th + steer * t;
  return [x + steer * (Math.sin(th2) - Math.sin(th)), y + steer * (Math.cos(th) - Math.cos(th2)), th2];
}

/** End pose of a path from `a`. */
export function endPose(a: Pose, path: CurvePath): Pose {
  const R = path.radius;
  let x = 0;
  let y = 0;
  let th = a.theta;
  for (const p of path.pieces) [x, y, th] = stepUnit(x, y, th, p.steer, p.len);
  return { x: a.x + x * R, y: a.y + y * R, theta: th };
}

/**
 * Samples a path every `ds` map units (plus each piece's end). Returns x, y, theta,
 * direction (+1 forward, -1 reverse) quadruples, starting with the start pose.
 */
export function samplePath(a: Pose, path: CurvePath, ds: number, out: number[] = []): number[] {
  const R = path.radius;
  let x = 0;
  let y = 0;
  let th = a.theta;
  const firstDir = path.pieces.find((p) => Math.abs(p.len) > ZERO);
  out.push(a.x, a.y, a.theta, firstDir && firstDir.len < 0 ? -1 : 1);
  for (const p of path.pieces) {
    const L = Math.abs(p.len) * R;
    if (L < 1e-9) continue;
    const dir = p.len < 0 ? -1 : 1;
    const n = Math.max(1, Math.ceil(L / ds));
    for (let k = 1; k <= n; k++) {
      const t = (dir * (L * k)) / n / R;
      const [xx, yy, tt] = stepUnit(x, y, th, p.steer, t);
      out.push(a.x + xx * R, a.y + yy * R, tt, dir);
    }
    [x, y, th] = stepUnit(x, y, th, p.steer, p.len);
  }
  return out;
}

/**
 * Walks a path every `ds` map units, calling `visit` with each pose after the start;
 * stops early (returning false) as soon as `visit` does. Cheap way to reject a long
 * curve that hits a wall near its start.
 */
export function walkPath(a: Pose, path: CurvePath, ds: number, visit: (x: number, y: number, theta: number, dir: number) => boolean): boolean {
  const R = path.radius;
  let x = 0;
  let y = 0;
  let th = a.theta;
  for (const p of path.pieces) {
    const L = Math.abs(p.len) * R;
    if (L < 1e-9) continue;
    const dir = p.len < 0 ? -1 : 1;
    const n = Math.max(1, Math.ceil(L / ds));
    for (let k = 1; k <= n; k++) {
      const t = (dir * (L * k)) / n / R;
      const [xx, yy, tt] = stepUnit(x, y, th, p.steer, t);
      if (!visit(a.x + xx * R, a.y + yy * R, tt, dir)) return false;
    }
    [x, y, th] = stepUnit(x, y, th, p.steer, p.len);
  }
  return true;
}

/** The first `maxLen` map units of a path (for RRT steering). */
export function truncatePath(path: CurvePath, maxLen: number): CurvePath {
  if (path.length <= maxLen) return path;
  const pieces: Piece[] = [];
  let left = maxLen / path.radius;
  for (const p of path.pieces) {
    const a = Math.abs(p.len);
    if (a <= left) {
      pieces.push(p);
      left -= a;
    } else {
      pieces.push({ steer: p.steer, len: Math.sign(p.len) * left });
      break;
    }
  }
  return { pieces, length: maxLen, radius: path.radius };
}

/** Number of gear changes (forward <-> reverse) along a path. */
export function cusps(path: CurvePath): number {
  let n = 0;
  let last = 0;
  for (const p of path.pieces) {
    if (Math.abs(p.len) < ZERO) continue;
    const d = Math.sign(p.len);
    if (last && d !== last) n++;
    last = d;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Dubins
// ---------------------------------------------------------------------------

type Word = [number, number, number]; // steer of each of the three pieces

const DUBINS_WORDS: Array<{ word: Word; solve: (d: number, a: number, b: number) => Word | null }> = [
  {
    word: [1, 0, 1], // LSL
    solve: (d, a, b) => {
      const p2 = 2 + d * d - 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) - Math.sin(b));
      if (p2 < 0) return null;
      const tmp = Math.atan2(Math.cos(b) - Math.cos(a), d + Math.sin(a) - Math.sin(b));
      return [mod2pi(-a + tmp), Math.sqrt(p2), mod2pi(b - tmp)];
    },
  },
  {
    word: [-1, 0, -1], // RSR
    solve: (d, a, b) => {
      const p2 = 2 + d * d - 2 * Math.cos(a - b) + 2 * d * (Math.sin(b) - Math.sin(a));
      if (p2 < 0) return null;
      const tmp = Math.atan2(Math.cos(a) - Math.cos(b), d - Math.sin(a) + Math.sin(b));
      return [mod2pi(a - tmp), Math.sqrt(p2), mod2pi(-b + tmp)];
    },
  },
  {
    word: [1, 0, -1], // LSR
    solve: (d, a, b) => {
      const p2 = -2 + d * d + 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) + Math.sin(b));
      if (p2 < 0) return null;
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(-Math.cos(a) - Math.cos(b), d + Math.sin(a) + Math.sin(b)) - Math.atan2(-2, p);
      return [mod2pi(-a + tmp), p, mod2pi(-mod2pi(b) + tmp)];
    },
  },
  {
    word: [-1, 0, 1], // RSL
    solve: (d, a, b) => {
      const p2 = d * d - 2 + 2 * Math.cos(a - b) - 2 * d * (Math.sin(a) + Math.sin(b));
      if (p2 < 0) return null;
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(Math.cos(a) + Math.cos(b), d - Math.sin(a) - Math.sin(b)) - Math.atan2(2, p);
      return [mod2pi(a - tmp), p, mod2pi(b - tmp)];
    },
  },
  {
    word: [-1, 1, -1], // RLR
    solve: (d, a, b) => {
      const tmp = (6 - d * d + 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) - Math.sin(b))) / 8;
      if (Math.abs(tmp) > 1) return null;
      const p = mod2pi(TWO_PI - Math.acos(tmp));
      const t = mod2pi(a - Math.atan2(Math.cos(a) - Math.cos(b), d - Math.sin(a) + Math.sin(b)) + p / 2);
      return [t, p, mod2pi(a - b - t + p)];
    },
  },
  {
    word: [1, -1, 1], // LRL
    solve: (d, a, b) => {
      const tmp = (6 - d * d + 2 * Math.cos(a - b) + 2 * d * (Math.sin(b) - Math.sin(a))) / 8;
      if (Math.abs(tmp) > 1) return null;
      const p = mod2pi(TWO_PI - Math.acos(tmp));
      const t = mod2pi(-a - Math.atan2(Math.cos(a) - Math.cos(b), d + Math.sin(a) - Math.sin(b)) + p / 2);
      return [t, p, mod2pi(mod2pi(b) - a - t + p)];
    },
  },
];

/** All valid Dubins paths from `a` to `b`, shortest first. */
export function dubinsAll(a: Pose, b: Pose, radius: number): CurvePath[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) / radius;
  const phi = Math.atan2(dy, dx);
  const al = mod2pi(a.theta - phi);
  const be = mod2pi(b.theta - phi);
  const out: CurvePath[] = [];
  for (const w of DUBINS_WORDS) {
    const r = w.solve(d, al, be);
    if (!r) continue;
    const path: CurvePath = {
      pieces: [0, 1, 2].map((k) => ({ steer: w.word[k], len: r[k] })),
      length: (r[0] + r[1] + r[2]) * radius,
      radius,
    };
    if (reaches(a, b, path)) out.push(path);
  }
  out.sort((p, q) => p.length - q.length);
  return out;
}

export function dubins(a: Pose, b: Pose, radius: number): CurvePath | null {
  return dubinsAll(a, b, radius)[0] ?? null;
}

function reaches(a: Pose, b: Pose, path: CurvePath): boolean {
  const e = endPose(a, path);
  const tol = 1e-6 * Math.max(1, path.radius);
  return Math.abs(e.x - b.x) < tol + 1e-6 && Math.abs(e.y - b.y) < tol + 1e-6 && Math.abs(wrapPi(e.theta - b.theta)) < 1e-6;
}

// ---------------------------------------------------------------------------
// Reeds-Shepp
// ---------------------------------------------------------------------------

const L = 1;
const S = 0;
const R = -1;
const N = 2; // unused slot
const RS_TYPES: number[][] = [
  [L, R, L, N, N],
  [R, L, R, N, N],
  [L, R, L, R, N],
  [R, L, R, L, N],
  [L, R, S, L, N],
  [R, L, S, R, N],
  [L, S, R, L, N],
  [R, S, L, R, N],
  [L, R, S, R, N],
  [R, L, S, L, N],
  [R, S, R, L, N],
  [L, S, L, R, N],
  [L, S, R, N, N],
  [R, S, L, N, N],
  [L, S, L, N, N],
  [R, S, R, N, N],
  [L, R, S, L, R],
  [R, L, S, R, L],
];

type Out = { t: number; u: number; v: number };

function polar(x: number, y: number): [number, number] {
  return [Math.sqrt(x * x + y * y), Math.atan2(y, x)];
}

function tauOmega(u: number, v: number, xi: number, eta: number, phi: number): [number, number] {
  const delta = mod2pi(u - v);
  const A = Math.sin(u) - Math.sin(delta);
  const B = Math.cos(u) - Math.cos(delta) - 1;
  const t1 = Math.atan2(eta * A - xi * B, xi * A + eta * B);
  const t2 = 2 * (Math.cos(delta) - Math.cos(v) - Math.cos(u)) + 3;
  const tau = t2 < 0 ? mod2pi(t1 + PI) : mod2pi(t1);
  return [tau, mod2pi(tau - u + v - phi)];
}

// Formula numbers from Reeds & Shepp's paper.
function LpSpLp(x: number, y: number, phi: number, o: Out): boolean {
  const [u, t] = polar(x - Math.sin(phi), y - 1 + Math.cos(phi));
  if (t >= -ZERO) {
    const v = mod2pi(phi - t);
    if (v >= -ZERO) {
      o.t = t;
      o.u = u;
      o.v = v;
      return true;
    }
  }
  return false;
}

function LpSpRp(x: number, y: number, phi: number, o: Out): boolean {
  const [u1r, t1] = polar(x + Math.sin(phi), y - 1 - Math.cos(phi));
  const u1 = u1r * u1r;
  if (u1 >= 4) {
    const u = Math.sqrt(u1 - 4);
    const theta = Math.atan2(2, u);
    const t = mod2pi(t1 + theta);
    const v = mod2pi(t - phi);
    o.t = t;
    o.u = u;
    o.v = v;
    return t >= -ZERO && v >= -ZERO;
  }
  return false;
}

function LpRmL(x: number, y: number, phi: number, o: Out): boolean {
  const xi = x - Math.sin(phi);
  const eta = y - 1 + Math.cos(phi);
  const [u1, theta] = polar(xi, eta);
  if (u1 <= 4) {
    const u = -2 * Math.asin(0.25 * u1);
    const t = mod2pi(theta + 0.5 * u + PI);
    const v = mod2pi(phi - t + u);
    o.t = t;
    o.u = u;
    o.v = v;
    return t >= -ZERO && u <= ZERO;
  }
  return false;
}

function LpRupLumRm(x: number, y: number, phi: number, o: Out): boolean {
  const xi = x + Math.sin(phi);
  const eta = y - 1 - Math.cos(phi);
  const rho = 0.25 * (2 + Math.sqrt(xi * xi + eta * eta));
  if (rho <= 1) {
    const u = Math.acos(rho);
    const [t, v] = tauOmega(u, -u, xi, eta, phi);
    o.t = t;
    o.u = u;
    o.v = v;
    return t >= -ZERO && v <= ZERO;
  }
  return false;
}

function LpRumLumRp(x: number, y: number, phi: number, o: Out): boolean {
  const xi = x + Math.sin(phi);
  const eta = y - 1 - Math.cos(phi);
  const rho = (20 - xi * xi - eta * eta) / 16;
  if (rho >= 0 && rho <= 1) {
    const u = -Math.acos(rho);
    if (u >= -0.5 * PI) {
      const [t, v] = tauOmega(u, u, xi, eta, phi);
      o.t = t;
      o.u = u;
      o.v = v;
      return t >= -ZERO && v >= -ZERO;
    }
  }
  return false;
}

function LpRmSmLm(x: number, y: number, phi: number, o: Out): boolean {
  const xi = x - Math.sin(phi);
  const eta = y - 1 + Math.cos(phi);
  const [rho, theta] = polar(xi, eta);
  if (rho >= 2) {
    const r = Math.sqrt(rho * rho - 4);
    const u = 2 - r;
    const t = mod2pi(theta + Math.atan2(r, -2));
    const v = mod2pi(phi - 0.5 * PI - t);
    o.t = t;
    o.u = u;
    o.v = v;
    return t >= -ZERO && u <= ZERO && v <= ZERO;
  }
  return false;
}

function LpRmSmRm(x: number, y: number, phi: number, o: Out): boolean {
  const xi = x + Math.sin(phi);
  const eta = y - 1 - Math.cos(phi);
  const [rho, theta] = polar(-eta, xi);
  if (rho >= 2) {
    const t = theta;
    const u = 2 - rho;
    const v = mod2pi(t + 0.5 * PI - phi);
    o.t = t;
    o.u = u;
    o.v = v;
    return t >= -ZERO && u <= ZERO && v <= ZERO;
  }
  return false;
}

function LpRmSLmRp(x: number, y: number, phi: number, o: Out): boolean {
  const xi = x + Math.sin(phi);
  const eta = y - 1 - Math.cos(phi);
  const [rho] = polar(xi, eta);
  if (rho >= 2) {
    const u = 4 - Math.sqrt(rho * rho - 4);
    if (u <= ZERO) {
      const t = mod2pi(Math.atan2((4 - u) * xi - 2 * eta, -2 * xi + (u - 4) * eta));
      const v = mod2pi(t - phi);
      o.t = t;
      o.u = u;
      o.v = v;
      return t >= -ZERO && v >= -ZERO;
    }
  }
  return false;
}

/** Every Reeds-Shepp candidate (normalised: unit radius, start at origin facing +x). */
function rsCandidates(x: number, y: number, phi: number): Array<{ type: number; lens: number[] }> {
  const out: Array<{ type: number; lens: number[] }> = [];
  const o: Out = { t: 0, u: 0, v: 0 };
  const h = 0.5 * PI;
  // CSC
  if (LpSpLp(x, y, phi, o)) out.push({ type: 14, lens: [o.t, o.u, o.v] });
  if (LpSpLp(-x, y, -phi, o)) out.push({ type: 14, lens: [-o.t, -o.u, -o.v] });
  if (LpSpLp(x, -y, -phi, o)) out.push({ type: 15, lens: [o.t, o.u, o.v] });
  if (LpSpLp(-x, -y, phi, o)) out.push({ type: 15, lens: [-o.t, -o.u, -o.v] });
  if (LpSpRp(x, y, phi, o)) out.push({ type: 12, lens: [o.t, o.u, o.v] });
  if (LpSpRp(-x, y, -phi, o)) out.push({ type: 12, lens: [-o.t, -o.u, -o.v] });
  if (LpSpRp(x, -y, -phi, o)) out.push({ type: 13, lens: [o.t, o.u, o.v] });
  if (LpSpRp(-x, -y, phi, o)) out.push({ type: 13, lens: [-o.t, -o.u, -o.v] });
  // CCC
  if (LpRmL(x, y, phi, o)) out.push({ type: 0, lens: [o.t, o.u, o.v] });
  if (LpRmL(-x, y, -phi, o)) out.push({ type: 0, lens: [-o.t, -o.u, -o.v] });
  if (LpRmL(x, -y, -phi, o)) out.push({ type: 1, lens: [o.t, o.u, o.v] });
  if (LpRmL(-x, -y, phi, o)) out.push({ type: 1, lens: [-o.t, -o.u, -o.v] });
  const xb = x * Math.cos(phi) + y * Math.sin(phi);
  const yb = x * Math.sin(phi) - y * Math.cos(phi);
  if (LpRmL(xb, yb, phi, o)) out.push({ type: 0, lens: [o.v, o.u, o.t] });
  if (LpRmL(-xb, yb, -phi, o)) out.push({ type: 0, lens: [-o.v, -o.u, -o.t] });
  if (LpRmL(xb, -yb, -phi, o)) out.push({ type: 1, lens: [o.v, o.u, o.t] });
  if (LpRmL(-xb, -yb, phi, o)) out.push({ type: 1, lens: [-o.v, -o.u, -o.t] });
  // CCCC
  if (LpRupLumRm(x, y, phi, o)) out.push({ type: 2, lens: [o.t, o.u, -o.u, o.v] });
  if (LpRupLumRm(-x, y, -phi, o)) out.push({ type: 2, lens: [-o.t, -o.u, o.u, -o.v] });
  if (LpRupLumRm(x, -y, -phi, o)) out.push({ type: 3, lens: [o.t, o.u, -o.u, o.v] });
  if (LpRupLumRm(-x, -y, phi, o)) out.push({ type: 3, lens: [-o.t, -o.u, o.u, -o.v] });
  if (LpRumLumRp(x, y, phi, o)) out.push({ type: 2, lens: [o.t, o.u, o.u, o.v] });
  if (LpRumLumRp(-x, y, -phi, o)) out.push({ type: 2, lens: [-o.t, -o.u, -o.u, -o.v] });
  if (LpRumLumRp(x, -y, -phi, o)) out.push({ type: 3, lens: [o.t, o.u, o.u, o.v] });
  if (LpRumLumRp(-x, -y, phi, o)) out.push({ type: 3, lens: [-o.t, -o.u, -o.u, -o.v] });
  // CCSC
  if (LpRmSmLm(x, y, phi, o)) out.push({ type: 4, lens: [o.t, -h, o.u, o.v] });
  if (LpRmSmLm(-x, y, -phi, o)) out.push({ type: 4, lens: [-o.t, h, -o.u, -o.v] });
  if (LpRmSmLm(x, -y, -phi, o)) out.push({ type: 5, lens: [o.t, -h, o.u, o.v] });
  if (LpRmSmLm(-x, -y, phi, o)) out.push({ type: 5, lens: [-o.t, h, -o.u, -o.v] });
  if (LpRmSmRm(x, y, phi, o)) out.push({ type: 8, lens: [o.t, -h, o.u, o.v] });
  if (LpRmSmRm(-x, y, -phi, o)) out.push({ type: 8, lens: [-o.t, h, -o.u, -o.v] });
  if (LpRmSmRm(x, -y, -phi, o)) out.push({ type: 9, lens: [o.t, -h, o.u, o.v] });
  if (LpRmSmRm(-x, -y, phi, o)) out.push({ type: 9, lens: [-o.t, h, -o.u, -o.v] });
  if (LpRmSmLm(xb, yb, phi, o)) out.push({ type: 6, lens: [o.v, o.u, -h, o.t] });
  if (LpRmSmLm(-xb, yb, -phi, o)) out.push({ type: 6, lens: [-o.v, -o.u, h, -o.t] });
  if (LpRmSmLm(xb, -yb, -phi, o)) out.push({ type: 7, lens: [o.v, o.u, -h, o.t] });
  if (LpRmSmLm(-xb, -yb, phi, o)) out.push({ type: 7, lens: [-o.v, -o.u, h, -o.t] });
  if (LpRmSmRm(xb, yb, phi, o)) out.push({ type: 10, lens: [o.v, o.u, -h, o.t] });
  if (LpRmSmRm(-xb, yb, -phi, o)) out.push({ type: 10, lens: [-o.v, -o.u, h, -o.t] });
  if (LpRmSmRm(xb, -yb, -phi, o)) out.push({ type: 11, lens: [o.v, o.u, -h, o.t] });
  if (LpRmSmRm(-xb, -yb, phi, o)) out.push({ type: 11, lens: [-o.v, -o.u, h, -o.t] });
  // CCSCC
  if (LpRmSLmRp(x, y, phi, o)) out.push({ type: 16, lens: [o.t, -h, o.u, -h, o.v] });
  if (LpRmSLmRp(-x, y, -phi, o)) out.push({ type: 16, lens: [-o.t, h, -o.u, h, -o.v] });
  if (LpRmSLmRp(x, -y, -phi, o)) out.push({ type: 17, lens: [o.t, -h, o.u, -h, o.v] });
  if (LpRmSLmRp(-x, -y, phi, o)) out.push({ type: 17, lens: [-o.t, h, -o.u, h, -o.v] });
  return out;
}

/** All valid Reeds-Shepp paths from `a` to `b`, shortest first. */
export function reedsSheppAll(a: Pose, b: Pose, radius: number): CurvePath[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const c = Math.cos(a.theta);
  const s = Math.sin(a.theta);
  const x = (c * dx + s * dy) / radius;
  const y = (-s * dx + c * dy) / radius;
  const phi = b.theta - a.theta;
  const out: CurvePath[] = [];
  for (const cand of rsCandidates(x, y, phi)) {
    const steers = RS_TYPES[cand.type];
    const pieces: Piece[] = [];
    let len = 0;
    cand.lens.forEach((l, k) => {
      if (steers[k] === N) return;
      pieces.push({ steer: steers[k], len: l });
      len += Math.abs(l);
    });
    const path: CurvePath = { pieces, length: len * radius, radius };
    if (reaches(a, b, path)) out.push(path);
  }
  out.sort((p, q) => p.length - q.length);
  return out;
}

export function reedsShepp(a: Pose, b: Pose, radius: number): CurvePath | null {
  return reedsSheppAll(a, b, radius)[0] ?? null;
}

/** Shortest drivable path ignoring obstacles: Reeds-Shepp if reversing is allowed, else Dubins. */
export function shortestCurve(a: Pose, b: Pose, radius: number, reverse: boolean): CurvePath | null {
  return reverse ? reedsShepp(a, b, radius) : dubins(a, b, radius);
}

/** Candidates for an analytic shot, shortest first (the shortest may be blocked while the next is free). */
export function curveCandidates(a: Pose, b: Pose, radius: number, reverse: boolean): CurvePath[] {
  return reverse ? reedsSheppAll(a, b, radius) : dubinsAll(a, b, radius);
}
