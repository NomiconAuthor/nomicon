/**
 * "Forward, deferred and clustered": one widget.
 *
 * LightsViz: the courtyard with 1–256 point lights on the GPU, drawn forward or deferred, with no
 * light culling, screen tiles or clusters; views of the lit frame, the lights each pixel looks at
 * (a heatmap), and the G-buffer's albedo, normals and depth. Beside it, the numbers from the CPU
 * model (lights per pixel, list sizes, bytes) and a top-down view of the cells and the lights.
 */
import { h, seg } from '../../engine/dom';
import '../gpu/gpu.css';
import { CallLog } from '../gpu/record';
import { type FdcRenderer, createFdc } from '../gpu/forward-deferred-clustered';
import { GpuCanvas, backendLine, planReadout } from '../gpu/widget';
import { VIEW_H, VIEW_W } from '../scenes/courtyard';
import {
  type Culling,
  FDC_DEFAULTS,
  type FdcSettings,
  GBUFFER,
  GBUFFER_BYTES,
  HEAT_STOPS,
  type LightLists,
  type Shading,
  type ViewMode,
  buildLists,
  bytesPerPixel,
  gridOf,
  lightsAt,
  listStats,
  sliceStart,
  tileBounds,
  viewXZ,
} from '../scenes/forward-deferred-clustered';
import { COURTYARD_CAMERA } from '../scenes/courtyard';
import { Palette, canvas, chk, ctx2d, fit, frame, onTheme, rgbCss, stage, stat } from '../view';
import { animate, apiSwitch, gpuFigure, linearOf, slider, timePasses } from './lighting-ui';

/** The heat colour for a light count (the same ramp the shaders use), 0–255. */
export function heatRgb(n: number): [number, number, number] {
  const x = Math.log2(n + 1);
  let c = HEAT_STOPS[0][1];
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const a = Math.log2(HEAT_STOPS[i - 1][0] + 1);
    const b = Math.log2(HEAT_STOPS[i][0] + 1);
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    c = [c[0] + (HEAT_STOPS[i][1][0] - c[0]) * t, c[1] + (HEAT_STOPS[i][1][1] - c[1]) * t, c[2] + (HEAT_STOPS[i][1][2] - c[2]) * t];
  }
  return [c[0] * 255, c[1] * 255, c[2] * 255];
}

const VIEWS: Array<[ViewMode, string]> = [
  ['lit', 'Lit'],
  ['heat', 'Lights per pixel'],
  ['albedo', 'Albedo'],
  ['normal', 'Normals'],
  ['depth', 'Depth'],
];
const GBUFFER_VIEWS = new Set<ViewMode>(['albedo', 'normal', 'depth']);

export class LightsViz {
  private s: FdcSettings = { ...FDC_DEFAULTS };
  private moving = false;
  private t = 0;
  private pal: Palette;
  private gpu: GpuCanvas;
  private renderer: FdcRenderer | null = null;
  private log = new CallLog();
  private lists: LightLists;
  private changed = true;
  private api: HTMLElement & { refresh?: () => void };
  private backend = h('div', { class: 'll-row' });
  private status = h('p', { class: 'rd-gpu-status' });
  private stats = h('div', { class: 'll-stats' });
  private gstats = h('div', { class: 'll-stats' });
  private planStats = h('div', { class: 'll-stats' });
  private say = h('p', { class: 'rd-note' });
  private timing = h('span', { class: 'll-muted' });
  private top = canvas(400, 360, 'Top-down view of the camera, its cells and the lights');
  private viewSeg: ReturnType<typeof seg<ViewMode>>;
  private lastStats = 0;
  private kick: () => void;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-gpu rd-lit');
    this.pal = new Palette(root);
    this.lists = buildLists(lightsAt(this.s.lights, 0), this.s.culling);
    this.gpu = new GpuCanvas({
      w: VIEW_W,
      h: VIEW_H,
      label: 'The courtyard lit by point lights, drawn by the GPU',
      build: async (ctx) => {
        this.renderer = await createFdc(ctx, this.log);
        this.changed = true;
      },
      teardown: () => {
        this.renderer?.dispose();
        this.renderer = null;
      },
      draw: () => this.drawGpu(),
      onStatus: (s) => {
        this.status.textContent = s;
        this.showBackend();
      },
    });
    this.api = apiSwitch(this.gpu, () => {
      this.changed = true;
      this.redraw();
    });
    this.viewSeg = seg<ViewMode>('View', VIEWS, this.s.view, (v) => {
      this.s.view = v;
      this.redraw();
    });
    const shading = seg<Shading>(
      'Shading',
      [
        ['forward', 'Forward'],
        ['deferred', 'Deferred'],
      ],
      this.s.shading,
      (v) => {
        this.s.shading = v;
        this.redraw();
      },
    );
    const culling = seg<Culling>(
      'Light lists',
      [
        ['none', 'None'],
        ['tiles', 'Tiles'],
        ['clusters', 'Clusters'],
      ],
      this.s.culling,
      (v) => {
        this.s.culling = v;
        this.rebuild();
      },
    );
    const count = slider('Lights', 1, 256, 1, this.s.lights, (v) => String(v), (v) => {
      this.s.lights = v;
      this.rebuild();
    });
    root.append(
      this.backend,
      h('div', { class: 'll-row' }, shading.el, culling.el),
      h(
        'div',
        { class: 'll-row' },
        count,
        chk('Move the lights', false, (on) => {
          this.moving = on;
          if (!on) {
            this.t = 0;
            this.rebuild();
          }
          this.kick();
        }),
      ),
      h('div', { class: 'll-row' }, this.viewSeg.el),
      stage(gpuFigure(this.gpu, VIEW_W, VIEW_H), [
        this.stats,
        this.legend(),
        this.top,
        h('p', { class: 'rd-note' }, 'From above: the camera at the bottom, its tile columns, depth slices (with clusters), and each light as a circle of its radius. Cells are coloured by their most crowded cell in that column.'),
      ]),
      this.say,
      this.gstats,
      h('div', { class: 'll-row' }, h('span', { class: 'll-muted' }, 'GPU: '), this.planStats),
      h('div', { class: 'll-row' }, h('button', { type: 'button', class: 'll-btn', onclick: () => void this.time() }, 'Time 60 frames'), this.timing),
      this.status,
    );
    fit(this.top, () => this.drawTop());
    onTheme(() => {
      this.pal.reset();
      this.changed = true;
      this.redraw();
    });
    this.kick = animate(root, () => this.moving, (dt) => {
      this.t += dt;
      this.lists = buildLists(lightsAt(this.s.lights, this.t), this.s.culling);
      this.changed = true;
      const now = performance.now();
      this.redraw(now - this.lastStats > 400);
    });
    this.redraw();
    void this.gpu.start().then(() => {
      this.api.refresh?.();
      this.showBackend();
    });
  }

  private legend(): HTMLElement {
    const items = HEAT_STOPS.map(([n]) => h('span', {}, h('i', { style: `background: ${rgbCss(heatRgb(n))}` }), n === 64 ? '64+' : String(n)));
    return h('div', { class: 'rd-legend' }, h('span', {}, 'Lights per pixel or cell:'), ...items);
  }

  private rebuild(): void {
    this.lists = buildLists(lightsAt(this.s.lights, this.t), this.s.culling);
    this.changed = true;
    this.redraw();
  }

  private redraw(withStats = true): void {
    // The G-buffer views only exist when there is a G-buffer.
    if (this.s.shading === 'forward' && GBUFFER_VIEWS.has(this.s.view)) {
      this.s.view = 'lit';
      this.viewSeg.set('lit');
    }
    this.viewSeg.el.querySelectorAll('button').forEach((b, i) => {
      (b as HTMLButtonElement).disabled = this.s.shading === 'forward' && GBUFFER_VIEWS.has(VIEWS[i][0]);
      b.title = (b as HTMLButtonElement).disabled ? 'Forward shading keeps no G-buffer' : '';
    });
    this.drawGpu();
    if (withStats) {
      this.lastStats = performance.now();
      this.showStats();
      this.drawTop();
    }
  }

  private showBackend(): void {
    this.backend.replaceChildren(this.api, h('span', {}, h('span', { class: 'll-muted' }, 'GPU side: '), ...backendLine(this.gpu)));
  }

  private drawGpu(): void {
    const r = this.renderer;
    if (!r) return;
    const lights = lightsAt(this.s.lights, this.t);
    const colours = lights.map((l) => linearOf(this.pal, l.color));
    const plan = r.frame(this.s, { lights, colours, lists: this.lists, changed: this.changed });
    this.changed = false;
    this.planStats.replaceChildren(...planReadout(plan));
  }

  private showStats(): void {
    const lights = lightsAt(this.s.lights, this.t);
    const st = listStats(lights, this.s.culling, this.lists, !this.moving);
    const g = gridOf(this.s.culling);
    const kb = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);
    this.stats.replaceChildren(
      stat(st.perPixel.toFixed(1), 'lights per pixel (average)'),
      stat(st.worstPixel, 'at the worst pixel'),
      ...(this.moving ? [] : [stat(st.reaching.toFixed(1), 'actually reach it')]),
      stat(`${g.tx} × ${g.ty}${g.slices > 1 ? ` × ${g.slices}` : ''}`, 'cells'),
      stat(st.entries.toLocaleString('en-US'), 'list entries'),
      stat(kb(st.bytes), 'grid + lists'),
    );
    const w = this.gpu.canvas.width;
    const hh = this.gpu.canvas.height;
    const mbAt = (bpp: number) => ((bpp * w * hh) / (1024 * 1024)).toFixed(1);
    this.say.textContent =
      this.s.shading === 'forward'
        ? `Forward: one pass. Each pixel's fragment shader loops over the ${this.s.culling === 'none' ? 'whole light list' : `lights in its ${this.s.culling === 'tiles' ? 'tile' : 'cluster'}`}, while the material is known.`
        : `Deferred: the G-buffer pass stores ${GBUFFER.map((t) => t.name).join(', ')} (${GBUFFER_BYTES} bytes per pixel); the lighting pass reads them back and loops over the ${this.s.culling === 'none' ? 'whole light list' : `lights in each pixel's ${this.s.culling === 'tiles' ? 'tile' : 'cluster'}`}.`;
    this.gstats.replaceChildren(
      stat(`${bytesPerPixel(this.s.shading)} B`, 'written + read per pixel'),
      stat(`${mbAt(bytesPerPixel(this.s.shading))} MB`, `per frame at this canvas's ${w} × ${hh}`),
    );
  }

  /** Top-down, in the camera's view space: x across, depth up the canvas. */
  private drawTop(): void {
    const ctx = ctx2d(this.top);
    const W = 400;
    const H = 360;
    const k = 9; // pixels per metre
    const X = (x: number) => W / 2 + x * k;
    const Z = (z: number) => H - 6 - z * k;
    const bg = this.pal.rgb('--bg');
    ctx.fillStyle = rgbCss(bg);
    ctx.fillRect(0, 0, W, H);
    const cam = COURTYARD_CAMERA;
    const ax = cam.aspect / cam.focal;
    const g = gridOf(this.s.culling);
    const zMax = (H - 6) / k;
    const zs = g.slices > 1 ? Array.from({ length: g.slices + 1 }, (_, i) => (i === g.slices ? zMax : sliceStart(i))) : [cam.near, zMax];
    // Each cell column (tile column i, slice k): its most crowded cell over the tile rows.
    const tb = this.s.culling === 'tiles' ? tileBounds() : null;
    for (let i = 0; i < g.tx; i++) {
      const a0 = (-1 + (2 * i) / g.tx) * ax;
      const a1 = (-1 + (2 * (i + 1)) / g.tx) * ax;
      for (let s = 0; s < zs.length - 1; s++) {
        let z0 = zs[s];
        let z1 = Math.min(zs[s + 1], zMax);
        let n = 0;
        for (let j = 0; j < g.ty; j++) n = Math.max(n, this.lists.count[i + j * g.tx + s * g.tx * g.ty]);
        if (tb) {
          // Tiles: the column's depth bounds, over its rows.
          const bs = Array.from({ length: g.ty }, (_, j) => tb[i + j * g.tx]).filter((b): b is [number, number] => !!b);
          if (!bs.length) continue;
          z0 = Math.min(...bs.map((b) => b[0]));
          z1 = Math.min(zMax, Math.max(...bs.map((b) => b[1])));
        }
        if (n === 0 || z1 <= z0) continue;
        ctx.fillStyle = rgbCss(heatRgb(n), 0.85);
        ctx.beginPath();
        ctx.moveTo(X(a0 * z0), Z(z0));
        ctx.lineTo(X(a1 * z0), Z(z0));
        ctx.lineTo(X(a1 * z1), Z(z1));
        ctx.lineTo(X(a0 * z1), Z(z1));
        ctx.closePath();
        ctx.fill();
      }
    }
    // Cell outlines.
    ctx.strokeStyle = this.pal.css('--line');
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let i = 0; i <= g.tx; i++) {
      const a = (-1 + (2 * i) / g.tx) * ax;
      ctx.moveTo(X(0), Z(0));
      ctx.lineTo(X(a * zMax), Z(zMax));
    }
    for (const z of zs) {
      ctx.moveTo(X(-ax * z), Z(z));
      ctx.lineTo(X(ax * z), Z(z));
    }
    ctx.stroke();
    // The courtyard's outline and the lights.
    ctx.strokeStyle = this.pal.css('--muted');
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    const corners = [
      [-8, 6],
      [8, 6],
      [8, -34],
      [-8, -34],
    ].map(([x, z]) => viewXZ({ x, y: 0, z }));
    corners.forEach((c, i) => (i ? ctx.lineTo(X(c.x), Z(c.z)) : ctx.moveTo(X(c.x), Z(c.z))));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1.2;
    for (const l of lightsAt(this.s.lights, this.t)) {
      const p = viewXZ(l.pos);
      ctx.strokeStyle = this.pal.css(l.color);
      ctx.beginPath();
      ctx.arc(X(p.x), Z(p.z), l.radius * k, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.fillStyle = this.pal.css('--ink');
    ctx.beginPath();
    ctx.arc(X(0), Z(0), 3, 0, 2 * Math.PI);
    ctx.fill();
  }

  private async time(): Promise<void> {
    const r = this.renderer;
    if (!r) return;
    const names = this.s.shading === 'forward' ? ['forward'] : ['G-buffer', 'lighting'];
    await timePasses(r.timer, 60, () => this.drawGpu(), names, this.timing);
  }
}

