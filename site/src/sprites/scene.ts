/**
 * Shared look for the movement widgets (steering course, formations): party members drawn
 * as sprites, a speckled ground and stone walls. Purely visual.
 */
import { type SpriteId, drawSprite, spriteSize } from './sprites';

export type PartyRole = 'tank' | 'healer' | 'damage';
export interface MemberLook {
  sprite: SpriteId;
  role: PartyRole;
}

/** A party in marching order: a shield knight first, then the rest, cycling through the roles. */
export const PARTY_LOOKS: MemberLook[] = [
  { sprite: 'crossbow', role: 'damage' },
  { sprite: 'mage', role: 'healer' },
  { sprite: 'knight', role: 'damage' },
  { sprite: 'mage', role: 'damage' },
  { sprite: 'crossbow', role: 'damage' },
  { sprite: 'knight', role: 'damage' },
];
export const LEADER_LOOK: MemberLook = { sprite: 'knight', role: 'tank' };

export interface SceneColours {
  bg: string;
  raised: string;
  line: string;
  soft: string;
  accent: string;
  good: string;
  c2: string;
  warn: string;
}

export function roleColour(c: SceneColours, role: PartyRole): string {
  return role === 'tank' ? c.accent : role === 'healer' ? c.good : c.c2;
}

/**
 * A party member at (x, y), facing along `dx` (flipped when walking left). A short tick in
 * front of the feet shows the exact heading, which the sprite alone can't.
 */
export function drawMember(ctx: CanvasRenderingContext2D, look: MemberLook, x: number, y: number, heading: number, c: SceneColours, o: { size?: number; selected?: boolean; alpha?: number } = {}): void {
  const size = spriteSize(o.size ?? 24);
  const base = roleColour(c, look.role);
  ctx.save();
  if (o.alpha !== undefined) ctx.globalAlpha = o.alpha;
  // Heading tick on the ground.
  const hx = Math.cos(heading);
  const hy = Math.sin(heading);
  ctx.strokeStyle = o.selected ? c.warn : base;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + hx * size * 0.45, y + size * 0.4 + hy * size * 0.17);
  ctx.lineTo(x + hx * size * 0.75, y + size * 0.4 + hy * size * 0.28);
  ctx.stroke();
  ctx.restore();
  drawSprite(ctx, look.sprite, x, y, size, { base: o.selected ? c.warn : base, flip: hx < -0.15, alpha: o.alpha });
}

const grounds = new Map<string, HTMLCanvasElement>();
/** A dark ground with faint speckles (deterministic, cached per size and theme). */
export function drawGround(ctx: CanvasRenderingContext2D, w: number, h: number, c: SceneColours): void {
  const key = `${w}x${h}|${c.bg}|${c.soft}`;
  let g = grounds.get(key);
  if (!g) {
    g = document.createElement('canvas');
    g.width = w;
    g.height = h;
    const x = g.getContext('2d')!;
    x.fillStyle = c.bg;
    x.fillRect(0, 0, w, h);
    let s = 1234567;
    const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff);
    x.fillStyle = c.soft;
    for (let i = 0; i < (w * h) / 260; i++) {
      x.globalAlpha = 0.15 + r() * 0.3;
      const px = Math.floor(r() * w);
      const py = Math.floor(r() * h);
      x.fillRect(px, py, r() < 0.3 ? 2 : 1, 1);
      if (r() < 0.12) x.fillRect(px + 2, py - 2, 1, 3); // a tuft of grass
    }
    x.globalAlpha = 1;
    grounds.set(key, g);
  }
  ctx.drawImage(g, 0, 0);
}

/** A block of stone wall: fill, a lighter top edge and staggered courses of bricks. */
export function drawStone(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, c: SceneColours): void {
  const w = x1 - x0;
  const h = y1 - y0;
  ctx.save();
  ctx.fillStyle = c.raised;
  ctx.fillRect(x0, y0, w, h);
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  ctx.strokeStyle = c.line;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1;
  const row = 10;
  const brick = 20;
  ctx.beginPath();
  for (let y = y0 + row; y < y1; y += row) {
    ctx.moveTo(x0, Math.round(y) + 0.5);
    ctx.lineTo(x1, Math.round(y) + 0.5);
  }
  for (let y = y0, k = 0; y < y1; y += row, k++) {
    for (let x = x0 + (k % 2 ? brick / 2 : brick); x < x1; x += brick) {
      ctx.moveTo(Math.round(x) + 0.5, y);
      ctx.lineTo(Math.round(x) + 0.5, Math.min(y1, y + row));
    }
  }
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = c.line;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
}

/**
 * A top-down agent for the steering and avoidance widgets: its real footprint (a disc of
 * radius `r`, the body the simulation collides) in a group colour, a heading tick from the
 * edge of the disc, and the sprite standing on it. Overlays drawn afterwards stay on top.
 */
export function drawAgent(ctx: CanvasRenderingContext2D, sprite: SpriteId, x: number, y: number, r: number, heading: number, colour: string, o: { size?: number; outline?: string; alpha?: number } = {}): void {
  const size = spriteSize(o.size ?? r * 2.6);
  const hx = Math.cos(heading);
  const hy = Math.sin(heading);
  ctx.save();
  const a = o.alpha ?? 1;
  ctx.globalAlpha = a * 0.55;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = a;
  ctx.strokeStyle = o.outline ?? colour;
  ctx.lineWidth = o.outline ? 2.5 : 1.5;
  ctx.stroke();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + hx * r, y + hy * r);
  ctx.lineTo(x + hx * (r + Math.max(4, r * 0.6)), y + hy * (r + Math.max(4, r * 0.6)));
  ctx.stroke();
  ctx.restore();
  drawSprite(ctx, sprite, x, y - size * 0.3, size, { flip: hx < -0.15, alpha: o.alpha });
}
