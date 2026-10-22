import type { Pt, RepView, VehicleShape, ViewRect } from '../rep/types';
import { TERRAINS, type Cell, type GridLayer } from '../world/world';

/**
 * Canvas drawing. Large maps (up to ~650k cells) are drawn through small offscreen
 * images at one pixel per cell, scaled up with smoothing off, so a frame costs a few
 * image copies rather than hundreds of thousands of fillRect calls. Vector details
 * (grid lines, numbers, tree links) are only drawn for the visible part of the map.
 */

/** Reads the theme's colour tokens from CSS so the canvas follows light/dark mode. */
/** Colour token per unit (unit 1 first). Shared by the markers, the paths and the views that tint by unit. */
export const UNIT_COLORS = ['--walker', '--u2', '--u3', '--u4', '--u5', '--u6', '--u7', '--u8'];
export const MAX_UNITS = UNIT_COLORS.length;

export class Palette {
  private cache = new Map<string, string>();
  private rgbaCache = new Map<string, number>();
  version = 0;
  refresh(): void {
    this.cache.clear();
    this.rgbaCache.clear();
    this.version++;
  }
  get(name: string): string {
    let v = this.cache.get(name);
    if (v === undefined) {
      v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888';
      this.cache.set(name, v);
    }
    return v;
  }
  /** Colour as a little-endian packed RGBA uint32 (for ImageData writes), optional alpha override. */
  packed(name: string, alpha?: number): number {
    const key = `${name}|${alpha ?? ''}`;
    let v = this.rgbaCache.get(key);
    if (v === undefined) {
      const [r, g, b, a] = parseColor(this.get(name));
      const A = Math.round(255 * (alpha ?? a));
      v = ((A << 24) | (b << 16) | (g << 8) | r) >>> 0;
      this.rgbaCache.set(key, v);
    }
    return v;
  }
}

export function parseColor(s: string): [number, number, number, number] {
  s = s.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    // #rgb, #rgba, #rrggbb and #rrggbbaa. CSS minifiers turn rgba(...) into
    // #rrggbbaa, so the alpha digits must be honoured.
    const full = hex.length <= 4 ? hex.split('').map((c) => c + c).join('') : hex;
    const n = parseInt(full.slice(0, 6), 16);
    const a = full.length >= 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1];
  }
  return [136, 136, 136, 1];
}

/** A w x h offscreen image whose pixels are cells. */
export class CellImage {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  readonly px: Uint32Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(w, h);
    this.px = new Uint32Array(this.img.data.buffer);
  }
  commit(): void {
    this.ctx.putImageData(this.img, 0, 0);
  }
  draw(ctx: CanvasRenderingContext2D, cs: number): void {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.canvas, 0, 0, this.w * cs, this.h * cs);
  }
}

export interface Overlays {
  clearance: boolean;
  components: boolean;
  tree: boolean;
  rawPath: boolean;
  structure: boolean;
  /** Hover inspector: show g, h, f and the parent of the node under the pointer. */
  inspect: boolean;
}

const COMPONENT_COLORS = ['--cache', '--vehicle', '--walker', '--soft', '--alert', '--other'];

/** Base map (terrain + walls) and the unit overlays, cached by world version and theme. */
export class MapImages {
  base: CellImage | null = null;
  over: CellImage | null = null;
  private baseKey = '';
  private overKey = '';

  update(layer: GridLayer, version: number, pal: Palette, clearance: Uint16Array, components: Int32Array, need: number, ov: Overlays): void {
    const { w, h, blocked, terrain } = layer;
    const bk = `${w}x${h}|${version}|${pal.version}`;
    if (bk !== this.baseKey || !this.base || this.base.w !== w || this.base.h !== h) {
      if (!this.base || this.base.w !== w || this.base.h !== h) this.base = new CellImage(w, h);
      const wall = pal.packed('--wall');
      const tcol = TERRAINS.map((t) => pal.packed(t.color));
      const px = this.base.px;
      for (let i = 0; i < w * h; i++) px[i] = blocked[i] ? wall : tcol[terrain[i]];
      this.base.commit();
      this.baseKey = bk;
    }
    const ok = `${bk}|${need}|${ov.clearance}|${ov.components}|${clearance.length}|${components.length}`;
    if (ok !== this.overKey) {
      this.overKey = ok;
      if (!ov.clearance && !ov.components) {
        this.over = null;
        return;
      }
      if (!this.over || this.over.w !== w || this.over.h !== h) this.over = new CellImage(w, h);
      const px = this.over.px;
      px.fill(0);
      if (ov.components) {
        const cols = COMPONENT_COLORS.map((c) => pal.packed(c, 0.18));
        const tight = pal.packed('--muted', 0.2);
        for (let i = 0; i < w * h; i++) {
          if (blocked[i]) continue;
          const lab = components[i];
          px[i] = lab === 0 ? tight : cols[(lab - 1) % cols.length];
        }
      } else if (ov.clearance) {
        const levels = [0, 1, 2, 3, 4, 5].map((v) => pal.packed('--cache', 0.05 + 0.07 * v));
        for (let i = 0; i < w * h; i++) if (!blocked[i]) px[i] = levels[Math.min(5, clearance[i])];
      }
      this.over.commit();
    }
  }
}

export interface FrameInput {
  layer: GridLayer;
  clearance: Uint16Array;
  need: number;
  overlays: Overlays;
  view: RepView | null;
  status: Uint8Array | null;
  parent: Int32Array | null;
  current: number;
  /** Every unit's markers and, once its search has played out, its path. */
  units: UnitFrame[];
}

export interface UnitFrame {
  start: Cell;
  /** Null while a new unit is being placed and only has its start. */
  goal: Cell | null;
  /** Colour token for the start marker and path. */
  color: string;
  /** Colour token for the goal flag. */
  flag: string;
  /** Text in the start marker ('S' for a lone unit, else its number); also drawn by the flag when set. */
  label: string;
  numbered: boolean;
  rawPath: Pt[] | null;
  finalPath: Pt[] | null;
  /** This unit's search is the one playing right now. */
  active: boolean;
  /** Set on vehicle lanes: draw footprints and headings instead of plain markers. */
  vehicle?: VehicleFrame;
}

export interface VehicleFrame {
  shape: VehicleShape;
  /** Radians. */
  startHeading: number;
  /** Radians, or null for "arrive facing any direction". */
  goalHeading: number | null;
  /** Poses along the planned path (x, y, theta, dir), once its search has played out. */
  path: Float32Array | null;
  /** Show the drag handles that turn the start and goal. */
  handles: boolean;
}

/**
 * Where the heading handle sits for a vehicle at (x, y) facing theta (map units): in
 * front of it, or behind it when the front would be off the map (`back` is then true,
 * and dragging it points the vehicle away from the pointer).
 */
export function headingHandle(shape: VehicleShape, x: number, y: number, theta: number, cs: number, w: number, h: number): { x: number; y: number; back: boolean } {
  const gap = Math.max(0.9, 14 / cs);
  const d = shape.length - shape.rear + gap;
  const fx = x + d * Math.cos(theta);
  const fy = y + d * Math.sin(theta);
  if (fx >= 0 && fy >= 0 && fx <= w && fy <= h) return { x: fx, y: fy, back: false };
  const b = shape.rear + gap;
  return { x: x - b * Math.cos(theta), y: y - b * Math.sin(theta), back: true };
}

function footprintPath(ctx: CanvasRenderingContext2D, shape: VehicleShape, x: number, y: number, theta: number, cs: number): void {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const b = -shape.rear;
  const f = shape.length - shape.rear;
  const hw = shape.width / 2;
  const pt = (along: number, side: number): [number, number] => [(x + c * along - s * side) * cs, (y + s * along + c * side) * cs];
  const pts = [pt(b, -hw), pt(f, -hw), pt(f, hw), pt(b, hw)];
  ctx.beginPath();
  pts.forEach(([px, py], k) => (k ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  ctx.closePath();
}

/** A vehicle's path: the line (dashed where it reverses), ghost footprints along it, and gear changes. */
function drawVehiclePath(ctx: CanvasRenderingContext2D, u: UnitFrame, cs: number, pal: Palette): void {
  const vf = u.vehicle!;
  const p = vf.path!;
  const n = p.length / 4;
  if (n < 2) return;
  const color = pal.get(u.color);
  // Ghost footprints every ~0.9 vehicle lengths, plus the last pose.
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1;
  const every = Math.max(1, vf.shape.length * 0.9);
  let acc = every;
  for (let k = 0; k < n; k++) {
    if (k > 0) acc += Math.hypot(p[4 * k] - p[4 * k - 4], p[4 * k + 1] - p[4 * k - 3]);
    if (acc >= every || k === n - 1) {
      acc = 0;
      footprintPath(ctx, vf.shape, p[4 * k], p[4 * k + 1], p[4 * k + 2], cs);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  const line = (w: number, style: string) => {
    ctx.strokeStyle = style;
    ctx.lineWidth = w;
    ctx.beginPath();
    for (let k = 0; k < n; k++) (k ? ctx.lineTo : ctx.moveTo).call(ctx, p[4 * k] * cs, p[4 * k + 1] * cs);
    ctx.stroke();
  };
  line(Math.max(4, cs * 0.18 + 2.5), pal.get('--paper'));
  line(Math.max(2.25, cs * 0.18), color);
  // Reversing: dash the line with the paper colour.
  ctx.strokeStyle = pal.get('--paper');
  ctx.lineWidth = Math.max(1.2, cs * 0.08);
  ctx.setLineDash([Math.max(3, cs * 0.3), Math.max(3, cs * 0.3)]);
  ctx.beginPath();
  for (let k = 1; k < n; k++) {
    if (p[4 * k + 3] >= 0) continue;
    ctx.moveTo(p[4 * k - 4] * cs, p[4 * k - 3] * cs);
    ctx.lineTo(p[4 * k] * cs, p[4 * k + 1] * cs);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  // Gear changes.
  const r = Math.max(3, cs * 0.18);
  for (let k = 2; k < n; k++) {
    if (p[4 * k + 3] === p[4 * k - 1]) continue;
    ctx.fillStyle = pal.get('--ink');
    ctx.strokeStyle = pal.get('--paper');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p[4 * k - 4] * cs, p[4 * k - 3] * cs, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

/** Start and goal footprints, headings and handles for a vehicle unit. */
function drawVehicleMarkers(ctx: CanvasRenderingContext2D, u: UnitFrame, cs: number, pal: Palette, w: number, h: number): void {
  const vf = u.vehicle!;
  const color = pal.get(u.color);
  const sx = u.start.x + 0.5;
  const sy = u.start.y + 0.5;
  footprintPath(ctx, vf.shape, sx, sy, vf.startHeading, cs);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.22;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  if (u.goal) {
    const gx = u.goal.x + 0.5;
    const gy = u.goal.y + 0.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = pal.get(u.flag);
    ctx.lineWidth = 2;
    if (vf.goalHeading === null) {
      ctx.beginPath();
      ctx.arc(gx * cs, gy * cs, (vf.shape.length / 2) * cs, 0, Math.PI * 2);
    } else footprintPath(ctx, vf.shape, gx, gy, vf.goalHeading, cs);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (!vf.handles) return;
  const handle = (x: number, y: number, theta: number, token: string) => {
    const hp = headingHandle(vf.shape, x, y, theta, cs, w, h);
    ctx.strokeStyle = pal.get(token);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x * cs, y * cs);
    ctx.lineTo(hp.x * cs, hp.y * cs);
    ctx.stroke();
    ctx.fillStyle = pal.get('--paper');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(hp.x * cs, hp.y * cs, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  };
  handle(sx, sy, vf.startHeading, u.color);
  if (u.goal && vf.goalHeading !== null) handle(u.goal.x + 0.5, u.goal.y + 0.5, vf.goalHeading, u.flag);
}

export function drawFrame(ctx: CanvasRenderingContext2D, v: ViewRect, d: FrameInput, images: MapImages, pal: Palette): void {
  const { layer } = d;
  const cs = v.cs;
  images.base?.draw(ctx, cs);
  images.over?.draw(ctx, cs);

  if (d.view && d.overlays.structure) d.view.drawStructure(ctx, v);
  if (d.view && d.status && d.parent) d.view.drawState(ctx, v, d.status, d.parent, d.current, d.overlays.tree);

  // Grid lines, visible part only.
  if (cs >= 7) {
    ctx.strokeStyle = pal.get('--grid');
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (let x = v.x0; x <= v.x1 + 1; x++) {
      ctx.moveTo(x * cs, v.y0 * cs);
      ctx.lineTo(x * cs, (v.y1 + 1) * cs);
    }
    for (let y = v.y0; y <= v.y1 + 1; y++) {
      ctx.moveTo(v.x0 * cs, y * cs);
      ctx.lineTo((v.x1 + 1) * cs, y * cs);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Repaint walls over the lines so they stay solid.
    ctx.fillStyle = pal.get('--wall');
    for (let y = v.y0; y <= v.y1; y++)
      for (let x = v.x0; x <= v.x1; x++) if (layer.blocked[y * layer.w + x]) ctx.fillRect(x * cs, y * cs, cs + 0.5, cs + 0.5);
  }

  // Clearance numbers.
  if (d.overlays.clearance && cs >= 13) {
    ctx.font = `${Math.max(8, Math.floor(cs * 0.42))}px ${pal.get('--f-mono')}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ink = pal.get('--ink');
    const muted = pal.get('--muted');
    for (let y = v.y0; y <= v.y1; y++)
      for (let x = v.x0; x <= v.x1; x++) {
        const i = y * layer.w + x;
        if (layer.blocked[i]) continue;
        const c = d.clearance[i];
        ctx.fillStyle = c >= d.need ? ink : muted;
        ctx.globalAlpha = c >= d.need ? 0.85 : 0.5;
        ctx.fillText(c > 99 ? '99' : String(c), x * cs + cs / 2, y * cs + cs / 2 + 0.5);
      }
    ctx.globalAlpha = 1;
  }

  // Paths.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const line = (p: Pt[]) => {
    ctx.beginPath();
    p.forEach((q, k) => (k ? ctx.lineTo(q.x * cs, q.y * cs) : ctx.moveTo(q.x * cs, q.y * cs)));
    ctx.stroke();
  };
  for (const u of d.units) {
    if (!u.rawPath || u.rawPath.length < 2 || !d.overlays.rawPath || u.finalPath === u.rawPath) continue;
    ctx.strokeStyle = pal.get('--muted');
    ctx.lineWidth = Math.max(1.25, cs * 0.08);
    ctx.setLineDash([Math.max(3, cs * 0.25), Math.max(3, cs * 0.25)]);
    line(u.rawPath);
    ctx.setLineDash([]);
  }
  for (const u of d.units) {
    if (u.vehicle?.path) {
      drawVehiclePath(ctx, u, cs, pal);
      continue;
    }
    const fp = u.finalPath;
    if (!fp || fp.length < 2) continue;
    ctx.strokeStyle = pal.get('--paper');
    ctx.lineWidth = Math.max(4, cs * 0.18 + 2.5);
    line(fp);
    ctx.strokeStyle = pal.get(u.color);
    ctx.lineWidth = Math.max(2.25, cs * 0.18);
    line(fp);
    if (cs >= 6) {
      ctx.fillStyle = pal.get('--paper');
      ctx.lineWidth = Math.max(1.25, cs * 0.08);
      const r = Math.max(2, cs * 0.14);
      for (let k = 1; k < fp.length - 1; k++) {
        const ax = fp[k].x - fp[k - 1].x;
        const ay = fp[k].y - fp[k - 1].y;
        const bx = fp[k + 1].x - fp[k].x;
        const by = fp[k + 1].y - fp[k].y;
        if (Math.abs(ax * by - ay * bx) < 1e-9 && ax * bx + ay * by > 0) continue; // not a turn
        ctx.beginPath();
        ctx.arc(fp[k].x * cs, fp[k].y * cs, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // Unit footprints, starts and goals. Markers keep a readable size when zoomed out.
  for (const u of d.units) if (u.vehicle) drawVehicleMarkers(ctx, u, cs, pal, layer.w, layer.h);
  const foot = 2 * d.need - 1;
  if (foot > 1)
    for (const u of d.units) {
      if (u.vehicle) continue;
      const sx = (u.start.x + 0.5) * cs;
      const sy = (u.start.y + 0.5) * cs;
      const half = (foot * cs) / 2;
      ctx.fillStyle = pal.get(u.color);
      ctx.globalAlpha = 0.18;
      ctx.fillRect(sx - half, sy - half, foot * cs, foot * cs);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal.get(u.color);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx - half, sy - half, foot * cs, foot * cs);
    }
  const r = Math.max(7, cs * 0.42);
  const fh = Math.max(15, cs * 0.85);
  for (const u of d.units) {
    const sx = (u.start.x + 0.5) * cs;
    const sy = (u.start.y + 0.5) * cs;
    if (u.active) {
      // The unit whose search is playing: a ring round both ends.
      ctx.strokeStyle = pal.get('--ink');
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(sx, sy, r + 5, 0, Math.PI * 2);
      if (u.goal) {
        const gx = (u.goal.x + 0.5) * cs;
        const gy = (u.goal.y + 0.5) * cs;
        ctx.moveTo(gx + fh * 0.75, gy);
        ctx.arc(gx, gy, fh * 0.75, 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (u.goal) {
      const gx = (u.goal.x + 0.5) * cs;
      const gy = (u.goal.y + 0.5) * cs;
      ctx.strokeStyle = pal.get('--ink');
      ctx.lineWidth = Math.max(1.5, cs * 0.08);
      ctx.beginPath();
      ctx.moveTo(gx - fh * 0.3, gy + fh * 0.5);
      ctx.lineTo(gx - fh * 0.3, gy - fh * 0.5);
      ctx.stroke();
      ctx.fillStyle = pal.get(u.flag);
      ctx.beginPath();
      ctx.moveTo(gx - fh * 0.3, gy - fh * 0.5);
      ctx.lineTo(gx + fh * 0.45, gy - fh * 0.22);
      ctx.lineTo(gx - fh * 0.3, gy + fh * 0.05);
      ctx.closePath();
      ctx.fill();
      if (u.numbered) {
        ctx.font = `600 ${Math.floor(fh * 0.5)}px ${pal.get('--f-mono')}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = pal.get('--paper');
        ctx.strokeText(u.label, gx - fh * 0.18, gy + fh * 0.3);
        ctx.fillStyle = pal.get(u.flag);
        ctx.fillText(u.label, gx - fh * 0.18, gy + fh * 0.3);
      }
    }
    ctx.fillStyle = pal.get(u.color);
    ctx.strokeStyle = pal.get('--paper');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = pal.get('--on-unit');
    ctx.font = `600 ${Math.floor(r * 1.05)}px ${pal.get('--f-mono')}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(u.label, sx, sy + 0.5);
  }
}

/** Draws parent links (search tree) between node positions, limited to a budget. */
export function drawTree(
  ctx: CanvasRenderingContext2D,
  cs: number,
  status: Uint8Array,
  parent: Int32Array,
  pos: (i: number) => Pt,
  visible: (i: number) => boolean,
  color: string,
  budget = 60000,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.75, Math.min(2, cs * 0.05));
  ctx.beginPath();
  let n = 0;
  for (let i = 0; i < status.length && n < budget; i++) {
    const p = parent[i];
    if (p < 0 || p === i || (status[i] !== 1 && status[i] !== 2)) continue;
    if (!visible(i) && !visible(p)) continue;
    const a = pos(i);
    const b = pos(p);
    ctx.moveTo(a.x * cs, a.y * cs);
    ctx.lineTo(b.x * cs, b.y * cs);
    n++;
  }
  ctx.stroke();
}
