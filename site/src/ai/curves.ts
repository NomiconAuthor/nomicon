/** Response curves: map a normalised input in [0, 1] to a score in [0, 1]. */

export type CurveType = 'linear' | 'poly' | 'logistic' | 'step';
export interface Curve {
  type: CurveType;
  /** poly: exponent; logistic: steepness. */
  k: number;
  /** logistic: midpoint; step: threshold. */
  c: number;
  /** Mirror the input (x becomes 1 - x). */
  inv: boolean;
  /** Output range: the curve is scaled to [lo, hi]. */
  lo: number;
  hi: number;
}

export const curve = (type: CurveType, o: Partial<Omit<Curve, 'type'>> = {}): Curve => ({
  type,
  k: o.k ?? (type === 'poly' ? 2 : 10),
  c: o.c ?? 0.5,
  inv: o.inv ?? false,
  lo: o.lo ?? 0,
  hi: o.hi ?? 1,
});

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function evalCurve(cv: Curve, x0: number): number {
  let x = clamp01(x0);
  if (cv.inv) x = 1 - x;
  let y: number;
  switch (cv.type) {
    case 'linear':
      y = x;
      break;
    case 'poly':
      y = Math.pow(x, cv.k);
      break;
    case 'logistic': {
      // Rescaled so the curve still spans 0..1 over the input range.
      const f = (t: number) => 1 / (1 + Math.exp(-cv.k * (t - cv.c)));
      const a = f(0);
      const b = f(1);
      y = b - a > 1e-6 ? (f(x) - a) / (b - a) : x >= cv.c ? 1 : 0;
      break;
    }
    case 'step':
      y = x >= cv.c ? 1 : 0;
      break;
  }
  return clamp01(cv.lo + (cv.hi - cv.lo) * y);
}

/** One-line C-style description, as it would appear in data. */
export function describeCurve(cv: Curve): string {
  const x = cv.inv ? '(1 - x)' : 'x';
  let f: string;
  switch (cv.type) {
    case 'linear':
      f = x;
      break;
    case 'poly':
      f = `${x}^${+cv.k.toFixed(2)}`;
      break;
    case 'logistic':
      f = `logistic(${x}, steep ${+cv.k.toFixed(1)}, mid ${+cv.c.toFixed(2)})`;
      break;
    case 'step':
      f = `${x} >= ${+cv.c.toFixed(2)} ? 1 : 0`;
      break;
  }
  return cv.lo === 0 && cv.hi === 1 ? f : `${+cv.lo.toFixed(2)} + ${+(cv.hi - cv.lo).toFixed(2)} * ${f}`;
}

export interface PlotColours {
  bg: string;
  grid: string;
  line: string;
  dot: string;
  text?: string;
}

/** Draw a curve into a canvas (backing-store pixels), with an optional marker at input x. */
export function plotCurve(cnv: HTMLCanvasElement, cv: Curve, col: PlotColours, x?: number, pad = 4): void {
  const ctx = cnv.getContext('2d')!;
  const w = cnv.width;
  const hgt = cnv.height;
  ctx.fillStyle = col.bg;
  ctx.fillRect(0, 0, w, hgt);
  const X = (t: number) => pad + t * (w - 2 * pad);
  const Y = (t: number) => hgt - pad - t * (hgt - 2 * pad);
  ctx.strokeStyle = col.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const t of [0, 0.5, 1]) {
    ctx.moveTo(X(t), Y(0));
    ctx.lineTo(X(t), Y(1));
    ctx.moveTo(X(0), Y(t));
    ctx.lineTo(X(1), Y(t));
  }
  ctx.stroke();
  ctx.strokeStyle = col.line;
  ctx.lineWidth = Math.max(1.5, w / 120);
  ctx.beginPath();
  const n = 96;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const y = evalCurve(cv, t);
    if (i === 0) ctx.moveTo(X(t), Y(y));
    else ctx.lineTo(X(t), Y(y));
  }
  ctx.stroke();
  if (x !== undefined) {
    const y = evalCurve(cv, x);
    ctx.fillStyle = col.dot;
    ctx.beginPath();
    ctx.arc(X(Math.min(1, Math.max(0, x))), Y(y), Math.max(3, w / 50), 0, Math.PI * 2);
    ctx.fill();
  }
}
