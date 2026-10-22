/**
 * Pixel-art unit sprites and missiles for the AI widgets: knights, crossbow knights and
 * battle-mages against orcs and goblin archers. Sprites are Kenney's Tiny Dungeon (CC0),
 * drawn with smoothing off so they stay crisp. Purely visual: nothing here feeds back
 * into a simulation.
 */
import { ATLAS } from './atlas';

export type SpriteId = 'knight' | 'crossbow' | 'mage' | 'orc' | 'goblinArcher' | 'potion' | 'barrel' | 'crate';
const ORDER: SpriteId[] = ['knight', 'crossbow', 'mage', 'orc', 'goblinArcher', 'potion', 'barrel', 'crate'];

let img: HTMLImageElement | null = null;
let ready = false;
const waiting: Array<() => void> = [];

/** Calls `fn` once the sprite sheet has loaded (straight away if it already has). */
export function onSprites(fn: () => void): void {
  if (ready) return fn();
  waiting.push(fn);
  if (!img) {
    img = new Image();
    img.onload = () => {
      ready = true;
      for (const f of waiting.splice(0)) f();
    };
    img.src = ATLAS;
  }
}

/** A size near `want` that is a whole multiple of 8 px, so the pixel art stays even. */
export function spriteSize(want: number): number {
  return Math.max(12, Math.round(want / 8) * 8);
}

export interface SpriteOpts {
  /** Ellipse under the feet, in this colour (a team or pair marker). */
  base?: string;
  alpha?: number;
  flip?: boolean;
}

/** Draw a sprite centred on (cx, cy), `size` px square. */
export function drawSprite(ctx: CanvasRenderingContext2D, id: SpriteId, cx: number, cy: number, size: number, o: SpriteOpts = {}): void {
  ctx.save();
  if (o.alpha !== undefined) ctx.globalAlpha = o.alpha;
  if (o.base) {
    ctx.fillStyle = o.base;
    ctx.globalAlpha = (o.alpha ?? 1) * 0.55;
    ctx.beginPath();
    ctx.ellipse(cx, cy + size * 0.4, size * 0.46, size * 0.17, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = o.alpha ?? 1;
    ctx.strokeStyle = o.base;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (!ready) onSprites(() => {});
  if (img && ready) {
    const k = ORDER.indexOf(id);
    ctx.imageSmoothingEnabled = false;
    const x = Math.round(cx - size / 2);
    const y = Math.round(cy - size / 2);
    if (o.flip) {
      ctx.translate(x + size, y);
      ctx.scale(-1, 1);
      ctx.drawImage(img, k * 16, 0, 16, 16, 0, 0, size, size);
    } else ctx.drawImage(img, k * 16, 0, 16, 16, x, y, size, size);
  } else {
    // Until the sheet loads: a plain dot.
    ctx.fillStyle = o.base ?? '#888';
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Missiles

export type Missile = 'bolt' | 'arrow' | 'spell';

/** Speed in metres per second, for working out how long a missile is in the air. */
export const MISSILE_SPEED: Record<Missile, number> = { bolt: 75, arrow: 50, spell: 42 };

/** Where a missile is at `t` (0..1) along its flight, and which way it points. Arrows arc a little. */
function flight(kind: Missile, x0: number, y0: number, x1: number, y1: number, t: number): { x: number; y: number; dx: number; dy: number } {
  const lift = kind === 'arrow' ? Math.min(40, Math.hypot(x1 - x0, y1 - y0) * 0.16) : 0;
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2 - lift;
  const u = 1 - t;
  const x = u * u * x0 + 2 * u * t * mx + t * t * x1;
  const y = u * u * y0 + 2 * u * t * my + t * t * y1;
  const dx = 2 * u * (mx - x0) + 2 * t * (x1 - mx);
  const dy = 2 * u * (my - y0) + 2 * t * (y1 - my);
  return { x, y, dx, dy };
}

/**
 * Draw a missile `t` (0..1) of the way from (x0, y0) to (x1, y1). `k` scales it (1 is about
 * right at 16 px sprites). After arrival (t > 1, up to 1.6) it draws a short impact.
 */
export function drawMissile(ctx: CanvasRenderingContext2D, kind: Missile, x0: number, y0: number, x1: number, y1: number, t: number, k = 1, hit = true): void {
  if (t < 0) return;
  ctx.save();
  if (t > 1) {
    const a = (t - 1) / 0.6;
    if (a >= 1 || !hit) return ctx.restore();
    ctx.globalAlpha = 1 - a;
    if (kind === 'spell') {
      ctx.strokeStyle = '#d9c2ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x1, y1, (3 + a * 9) * k, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#ffe4a8';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        const th = (i / 4) * Math.PI * 2 + 0.6;
        ctx.beginPath();
        ctx.moveTo(x1 + Math.cos(th) * 2 * k, y1 + Math.sin(th) * 2 * k);
        ctx.lineTo(x1 + Math.cos(th) * (3 + a * 5) * k, y1 + Math.sin(th) * (3 + a * 5) * k);
        ctx.stroke();
      }
    }
    return ctx.restore();
  }
  const p = flight(kind, x0, y0, x1, y1, t);
  const len = Math.hypot(p.dx, p.dy) || 1;
  const ux = p.dx / len;
  const uy = p.dy / len;
  if (kind === 'spell') {
    // A glowing orb with a fading trail.
    for (let i = 5; i >= 1; i--) {
      const q = flight(kind, x0, y0, x1, y1, Math.max(0, t - i * 0.035));
      ctx.globalAlpha = 0.5 * (1 - i / 6);
      ctx.fillStyle = '#9b6bff';
      ctx.beginPath();
      ctx.arc(q.x, q.y, (2.8 - i * 0.35) * k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 7 * k);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(214,190,255,0.95)');
    g.addColorStop(0.6, 'rgba(155,107,255,0.45)');
    g.addColorStop(1, 'rgba(155,107,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7 * k, 0, Math.PI * 2);
    ctx.fill();
    return ctx.restore();
  }
  const L = (kind === 'bolt' ? 8 : 11) * k;
  const tailX = p.x - ux * L;
  const tailY = p.y - uy * L;
  // Shaft.
  ctx.lineCap = 'round';
  ctx.strokeStyle = kind === 'bolt' ? '#cfd6e2' : '#c8995f';
  ctx.lineWidth = (kind === 'bolt' ? 1.8 : 1.4) * Math.max(1, k * 0.8);
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
  // Head.
  const hw = 2.2 * k;
  const hl = 3.2 * k;
  ctx.fillStyle = kind === 'bolt' ? '#ffffff' : '#e3e6ea';
  ctx.beginPath();
  ctx.moveTo(p.x + ux * hl, p.y + uy * hl);
  ctx.lineTo(p.x - uy * hw, p.y + ux * hw);
  ctx.lineTo(p.x + uy * hw, p.y - ux * hw);
  ctx.closePath();
  ctx.fill();
  // Fletching.
  ctx.strokeStyle = kind === 'bolt' ? '#b994ff' : '#f2ead8';
  ctx.lineWidth = 1.2;
  const f = 2.4 * k;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(tailX - ux * f - uy * f, tailY - uy * f + ux * f);
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(tailX - ux * f + uy * f, tailY - uy * f - ux * f);
  ctx.stroke();
  ctx.restore();
}

/** A missile in flight, timed in seconds of simulation time. */
export interface Flight {
  kind: Missile;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t0: number;
  dur: number;
  hit: boolean;
}

/** Make a flight between two points in metres, launched at time t0 (seconds). */
export function launch(kind: Missile, x0: number, y0: number, x1: number, y1: number, t0: number, hit = true): Flight {
  const d = Math.hypot(x1 - x0, y1 - y0);
  if (!hit && d > 0) {
    // A miss flies on past, a little to one side.
    const side = Math.sin(x0 * 12.9898 + y0 * 78.233 + t0 * 37.719) > 0 ? 1 : -1;
    const ux = (x1 - x0) / d;
    const uy = (y1 - y0) / d;
    x1 += ux * 1.6 - uy * 0.9 * side;
    y1 += uy * 1.6 + ux * 0.9 * side;
  }
  return { kind, x0, y0, x1, y1, t0, dur: Math.max(0.12, d / MISSILE_SPEED[kind]), hit };
}

/** Draw every flight at time `now` (seconds) with a metres-to-pixels mapping; drops finished ones. */
export function drawFlights(ctx: CanvasRenderingContext2D, flights: Flight[], now: number, px: (v: number) => number, k = 1): Flight[] {
  const keep: Flight[] = [];
  for (const f of flights) {
    const t = (now - f.t0) / f.dur;
    if (t > 1.6) continue;
    keep.push(f);
    drawMissile(ctx, f.kind, px(f.x0), px(f.y0), px(f.x1), px(f.y1), t, k, f.hit);
  }
  return keep;
}
