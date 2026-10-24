/**
 * A tiny 3D renderer for the engine comparison: boxes and spheres, flat shaded, painter-sorted,
 * on a 2D canvas. Enough for a few hundred bodies; no library.
 */
import type { BodySpec, Scene3D } from './engines';

type V3 = [number, number, number];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: V3): V3 => {
  const l = Math.sqrt(dot3(a, a)) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
function rotq(q: ArrayLike<number>, o: number, v: V3): V3 {
  // v' = v + 2w(u×v) + 2u×(u×v)
  const u: V3 = [q[o], q[o + 1], q[o + 2]];
  const w = q[o + 3];
  const t = cross3(u, v);
  const t2: V3 = [2 * t[0], 2 * t[1], 2 * t[2]];
  const c = cross3(u, t2);
  return [v[0] + w * t2[0] + c[0], v[1] + w * t2[1] + c[1], v[2] + w * t2[2] + c[2]];
}

const FACES = [
  [0, 1, 3, 2, -1, 0, 0],
  [4, 6, 7, 5, 1, 0, 0],
  [0, 4, 5, 1, 0, -1, 0],
  [2, 3, 7, 6, 0, 1, 0],
  [0, 2, 6, 4, 0, 0, -1],
  [1, 5, 7, 3, 0, 0, 1],
];
const LIGHT = norm3([0.4, 0.9, 0.5]);

function rgb(c: string): [number, number, number] {
  const m = c.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const r = c.match(/rgba?\(([^)]+)\)/);
  if (r) {
    const p = r[1].split(/[ ,]+/).map(Number);
    return [p[0], p[1], p[2]];
  }
  return [136, 136, 136];
}

export class Renderer3D {
  private cols = new Map<string, [number, number, number]>();
  constructor(private canvas: HTMLCanvasElement) {}
  resetColours(): void {
    this.cols.clear();
  }
  private col(token: string): [number, number, number] {
    let c = this.cols.get(token);
    if (!c) {
      c = rgb(getComputedStyle(this.canvas).getPropertyValue(token).trim());
      this.cols.set(token, c);
    }
    return c;
  }

  draw(scene: Scene3D, xf: Float32Array, n: number, caption = ''): void {
    const cv = this.canvas;
    const ctx = cv.getContext('2d')!;
    const W = cv.width;
    const H = cv.height;
    const bg = this.col('--bg');
    ctx.fillStyle = `rgb(${bg})`;
    ctx.fillRect(0, 0, W, H);
    const cam = scene.camera;
    const f = norm3(sub3(cam.target, cam.eye));
    const r = norm3(cross3(f, [0, 1, 0]));
    const u = cross3(r, f);
    const focal = H / 2 / Math.tan(((cam.fov / 2) * Math.PI) / 180);
    const NEAR = 0.1;
    const toCam = (p: V3): V3 => {
      const d = sub3(p, cam.eye);
      return [dot3(d, r), dot3(d, u), dot3(d, f)];
    };
    const screen = (c: V3): [number, number, number] => [W / 2 + (c[0] * focal) / c[2], H / 2 - (c[1] * focal) / c[2], c[2]];
    const proj = (p: V3) => screen(toCam(p));
    /** Clip a polygon (camera space) to z >= NEAR, so faces that reach behind the camera still draw. */
    const clipNear = (poly: V3[]): V3[] => {
      const out: V3[] = [];
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k];
        const b = poly[(k + 1) % poly.length];
        const ina = a[2] >= NEAR;
        const inb = b[2] >= NEAR;
        if (ina) out.push(a);
        if (ina !== inb) {
          const t = (NEAR - a[2]) / (b[2] - a[2]);
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
        }
      }
      return out;
    };
    const items: Array<{ z: number; draw: () => void }> = [];
    for (let i = 0; i < n; i++) {
      const b: BodySpec = scene.bodies[i];
      const o = i * 8;
      const pos: V3 = [xf[o], xf[o + 1], xf[o + 2]];
      const awake = xf[o + 7] > 0.5;
      const base = b.dynamic ? this.col(`--c${((b.colour ?? 0) % 8) + 1}`) : this.col('--line');
      const tone = (k: number) => {
        const a = b.dynamic && !awake ? 0.55 : 1;
        return `rgb(${Math.round(base[0] * k * a + bg[0] * (1 - a))},${Math.round(base[1] * k * a + bg[1] * (1 - a))},${Math.round(base[2] * k * a + bg[2] * (1 - a))})`;
      };
      if (b.kind === 'sphere') {
        const c = proj(pos);
        if (c[2] <= 0.1) continue;
        const rad = (b.size[0] * focal) / c[2];
        items.push({
          z: c[2],
          draw: () => {
            const g = ctx.createRadialGradient(c[0] - rad * 0.35, c[1] - rad * 0.35, rad * 0.1, c[0], c[1], rad);
            g.addColorStop(0, tone(1.15));
            g.addColorStop(1, tone(0.55));
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(c[0], c[1], Math.max(1, rad), 0, Math.PI * 2);
            ctx.fill();
          },
        });
        continue;
      }
      const [hx, hy, hz] = b.size;
      const corners: V3[] = [];
      for (let k = 0; k < 8; k++) {
        const l: V3 = [k & 4 ? hx : -hx, k & 2 ? hy : -hy, k & 1 ? hz : -hz];
        const w = rotq(xf, o + 3, l);
        corners.push([w[0] + pos[0], w[1] + pos[1], w[2] + pos[2]]);
      }
      const cc = corners.map(toCam);
      if (cc.every((p) => p[2] < NEAR)) continue;
      // The floor is one huge face whose centre sits under the scene, so sorting by face centre
      // would paint it over everything further away than that centre. Floors always go first.
      const floor = !b.dynamic && pos[1] + hy <= 1e-3;
      for (const fc of FACES) {
        const nw = rotq(xf, o + 3, [fc[4], fc[5], fc[6]]);
        const centre: V3 = [0, 0, 0];
        for (let k = 0; k < 4; k++) for (let a = 0; a < 3; a++) centre[a] += corners[fc[k]][a] / 4;
        if (dot3(nw, sub3(cam.eye, centre)) <= 0) continue; // facing away
        const shade = 0.45 + 0.55 * Math.max(0, dot3(nw, LIGHT));
        const clipped = clipNear(fc.slice(0, 4).map((k) => cc[k]));
        if (clipped.length < 3) continue;
        const pts = clipped.map(screen);
        // Depth for sorting: the face centre's distance along the view direction.
        const z = floor ? Infinity : dot3(sub3(centre, cam.eye), f);
        items.push({
          z,
          draw: () => {
            ctx.fillStyle = tone(shade);
            ctx.beginPath();
            pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = `rgba(${bg},0.35)`;
            ctx.lineWidth = 1;
            ctx.stroke();
          },
        });
      }
    }
    items.sort((a, b) => b.z - a.z);
    for (const it of items) it.draw();
    if (caption) {
      const m = this.col('--muted');
      ctx.fillStyle = `rgb(${m})`;
      ctx.font = `${Math.round(W / 40)}px sans-serif`;
      ctx.fillText(caption, 12, H - 12);
    }
  }
}
