/**
 * "Physically based shading": one widget.
 *
 * PbrViz: spheres on the GPU (a grid of roughness × metalness, or one sphere with the material's
 * own settings), lit by a sun and an environment through the split sum; material presets,
 * metalness, roughness and dielectric F0 sliders; diffuse and specular views. Beside it, from the
 * CPU model: the specular lobe in the plane of incidence, and a white furnace chart of how much
 * light the specular lobe and a whole white material reflect at each roughness.
 */
import { h, seg } from '../../engine/dom';
import '../gpu/gpu.css';
import { CallLog } from '../gpu/record';
import { type PbrRenderer, type PbrTables, createPbr } from '../gpu/physically-based-shading';
import { GpuCanvas, backendLine, planReadout } from '../gpu/widget';
import {
  type BallLayout,
  MATERIALS,
  PBR_DEFAULTS,
  PBR_H,
  PBR_W,
  type PbrSettings,
  type PbrView,
  brdfTable,
  envBrdf,
  linearBase,
  prefilteredEnvironment,
  specular,
} from '../scenes/physically-based-shading';
import { Palette, canvas, chk, ctx2d, fit, frame, onTheme, rgbCss, stage, stat } from '../view';
import { apiSwitch, gpuFigure, slider, timePasses } from './lighting-ui';

const DEG = Math.PI / 180;

export class PbrViz {
  private s: PbrSettings = { ...PBR_DEFAULTS };
  private thetaV = 45;
  private pal: Palette;
  private gpu: GpuCanvas;
  private renderer: PbrRenderer | null = null;
  private tables: PbrTables | null = null;
  private log = new CallLog();
  private api: HTMLElement & { refresh?: () => void };
  private backend = h('div', { class: 'll-row' });
  private status = h('p', { class: 'rd-gpu-status' });
  private planStats = h('div', { class: 'll-stats' });
  private stats = h('div', { class: 'll-stats' });
  private timing = h('span', { class: 'll-muted' });
  private lobe = canvas(360, 200, 'The specular lobe in the plane of incidence');
  private furnace = canvas(360, 220, 'White furnace: light reflected against roughness');
  private sliders: Record<string, HTMLElement & { set?: (v: number) => void }> = {};
  private note = h('p', { class: 'rd-note' });

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-gpu rd-lit');
    this.pal = new Palette(root);
    this.gpu = new GpuCanvas({
      w: PBR_W,
      h: PBR_H,
      label: 'Spheres shaded with a physically based BRDF, drawn by the GPU',
      build: async (ctx) => {
        this.tables ??= { lut: brdfTable(), env: prefilteredEnvironment() };
        this.renderer = await createPbr(ctx, this.log, this.tables);
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
    this.api = apiSwitch(this.gpu, () => this.redraw());
    const layout = seg<BallLayout>(
      'Show',
      [
        ['grid', 'Roughness × metalness'],
        ['one', 'One sphere'],
      ],
      this.s.layout,
      (v) => {
        this.s.layout = v;
        this.redraw();
      },
    );
    const mats = seg<string>('Material', MATERIALS.map((m, i) => [String(i), m.name] as [string, string]), '0', (v) => this.pick(Number(v)));
    this.sliders.metal = slider('Metalness', 0, 1, 0.01, this.s.metal, (v) => v.toFixed(2), (v) => this.set({ metal: v }));
    this.sliders.roughness = slider('Roughness', 0, 1, 0.01, this.s.roughness, (v) => v.toFixed(2), (v) => this.set({ roughness: v }));
    this.sliders.reflectance = slider('Dielectric F0', 0.02, 0.17, 0.01, this.s.reflectance, (v) => v.toFixed(2), (v) => this.set({ reflectance: v }));
    const view = seg<PbrView>(
      'View',
      [
        ['full', 'Diffuse + specular'],
        ['diffuse', 'Diffuse'],
        ['specular', 'Specular'],
      ],
      this.s.view,
      (v) => this.set({ view: v }),
    );
    const angle = slider('View angle', 0, 85, 1, this.thetaV, (v) => `${v}°`, (v) => {
      this.thetaV = v;
      this.drawPlots();
    });
    root.append(
      this.backend,
      h('div', { class: 'll-row' }, layout.el),
      h('div', { class: 'll-row' }, mats.el),
      h('div', { class: 'll-row' }, this.sliders.metal, this.sliders.roughness, this.sliders.reflectance),
      h('div', { class: 'll-row' }, chk('Sun', true, (on) => this.set({ direct: on })), chk('Environment', true, (on) => this.set({ ibl: on })), view.el),
      this.note,
      stage(gpuFigure(this.gpu, PBR_W, PBR_H), [
        angle,
        this.lobe,
        h('p', { class: 'rd-note' }, 'Specular lobe, f · cos θ, for this material and a viewer on the left at the view angle: how much light from each direction reaches the viewer. The dashed line is the mirror direction.'),
        this.furnace,
        h('p', { class: 'rd-note' }, 'White furnace: the fraction of light reflected, at this view angle, by the specular lobe alone with F = 1 (blue) and by a white dielectric with F0 = 0.04 (gold). Above 1 means more out than in.'),
        this.stats,
      ]),
      h('div', { class: 'll-row' }, h('span', { class: 'll-muted' }, 'GPU: '), this.planStats),
      h('div', { class: 'll-row' }, h('button', { type: 'button', class: 'll-btn', onclick: () => void this.time() }, 'Time 60 frames'), this.timing),
      this.status,
    );
    fit(this.lobe, () => this.drawPlots());
    fit(this.furnace, () => this.drawPlots());
    onTheme(() => {
      this.pal.reset();
      this.redraw();
    });
    this.redraw();
    // The tables take a moment on the CPU: let the page paint first.
    setTimeout(() => {
      void this.gpu.start().then(() => {
        this.api.refresh?.();
        this.showBackend();
      });
    }, 30);
  }

  private pick(i: number): void {
    const m = MATERIALS[i];
    this.s = { ...this.s, material: i, metal: m.metal, roughness: m.roughness, reflectance: m.reflectance };
    this.sliders.metal.set?.(m.metal);
    this.sliders.roughness.set?.(m.roughness);
    this.sliders.reflectance.set?.(m.reflectance);
    this.redraw();
  }
  private set(p: Partial<PbrSettings>): void {
    this.s = { ...this.s, ...p };
    this.redraw();
  }

  private showBackend(): void {
    this.backend.replaceChildren(this.api, h('span', {}, h('span', { class: 'll-muted' }, 'GPU side: '), ...backendLine(this.gpu)));
  }

  private redraw(): void {
    this.note.textContent =
      this.s.layout === 'grid'
        ? 'The grid sets its own roughness (0 to 1, left to right) and metalness (0 on top, 1 below); the material gives the base colour and dielectric F0.'
        : 'One sphere with the material\'s own metalness and roughness.';
    this.drawGpu();
    this.drawPlots();
  }

  private drawGpu(): void {
    const r = this.renderer;
    if (!r) return;
    const plan = r.frame(this.s, linearBase(MATERIALS[this.s.material]));
    this.planStats.replaceChildren(...planReadout(plan));
  }

  private drawPlots(): void {
    this.drawLobe();
    this.drawFurnace();
  }

  /** The specular lobe as a polar plot over the upper half-plane. */
  private drawLobe(): void {
    const ctx = ctx2d(this.lobe);
    const W = 360;
    const H = 200;
    ctx.fillStyle = this.pal.css('--bg');
    ctx.fillRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H - 14;
    const R = 165;
    const rough = this.s.roughness;
    const lin = linearBase(MATERIALS[this.s.material]);
    const f0 = this.s.reflectance + ((lin[0] + lin[1] + lin[2]) / 3 - this.s.reflectance) * this.s.metal;
    const tv = this.thetaV * DEG;
    const vals: Array<[number, number]> = [];
    let peak = 0;
    for (let i = 0; i <= 180; i++) {
      const tl = (i - 90) * DEG;
      const v = specular(tv, tl, rough, f0) * Math.cos(tl);
      vals.push([tl, v]);
      peak = Math.max(peak, v);
    }
    ctx.strokeStyle = this.pal.css('--line');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - R);
    ctx.stroke();
    // Incoming view direction and its mirror.
    ctx.strokeStyle = this.pal.css('--muted');
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - Math.sin(tv) * R, cy - Math.cos(tv) * R);
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(tv) * R, cy - Math.cos(tv) * R);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = this.pal.css('--accent');
    ctx.fillStyle = rgbCss(this.pal.rgb('--accent'), 0.18);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (const [tl, v] of vals) {
      const r = peak > 0 ? (v / peak) * R : 0;
      ctx.lineTo(cx + Math.sin(tl) * r, cy - Math.cos(tl) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = this.pal.css('--muted');
    ctx.font = '12px sans-serif';
    ctx.fillText('view', cx - Math.sin(tv) * R * 0.75 - 30, cy - Math.cos(tv) * R * 0.75);
    ctx.fillText(`peak f·cos θ = ${peak < 10 ? peak.toFixed(2) : peak.toFixed(0)} (scaled to fit)`, 6, 14);
  }

  private drawFurnace(): void {
    const ctx = ctx2d(this.furnace);
    const W = 360;
    const H = 220;
    const L = 34;
    const B = H - 26;
    const T = 10;
    const Rr = W - 10;
    const yMax = 1.6;
    const X = (r: number) => L + r * (Rr - L);
    const Y = (v: number) => B - (v / yMax) * (B - T);
    ctx.fillStyle = this.pal.css('--bg');
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = this.pal.css('--line');
    ctx.fillStyle = this.pal.css('--muted');
    ctx.font = '11px sans-serif';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const v of [0, 0.5, 1, 1.5]) {
      ctx.moveTo(L, Y(v));
      ctx.lineTo(Rr, Y(v));
      ctx.fillText(v.toFixed(1), 4, Y(v) + 4);
    }
    ctx.stroke();
    ctx.fillText('roughness 0', L, H - 8);
    ctx.fillText('1', Rr - 6, H - 8);
    const nv = Math.cos(this.thetaV * DEG);
    const pts = Array.from({ length: 21 }, (_, i) => i / 20);
    const ab = pts.map((r) => envBrdf(r, Math.max(1e-3, nv), 512));
    const line = (col: string, f: (a: [number, number]) => number) => {
      ctx.strokeStyle = this.pal.css(col);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ab.forEach((a, i) => (i ? ctx.lineTo(X(pts[i]), Y(f(a))) : ctx.moveTo(X(pts[i]), Y(f(a)))));
      ctx.stroke();
    };
    ctx.strokeStyle = this.pal.css('--ink');
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(L, Y(1));
    ctx.lineTo(Rr, Y(1));
    ctx.stroke();
    ctx.setLineDash([]);
    line('--c7', (a) => a[0] + a[1]);
    line('--warn', (a) => 1 + 0.04 * a[0] + a[1]);
    ctx.strokeStyle = this.pal.css('--muted');
    ctx.beginPath();
    ctx.moveTo(X(this.s.roughness), T);
    ctx.lineTo(X(this.s.roughness), B);
    ctx.stroke();
    const [A, Bb] = envBrdf(this.s.roughness, Math.max(1e-3, nv), 512);
    this.stats.replaceChildren(stat((A + Bb).toFixed(2), 'specular lobe, F = 1'), stat((1 + 0.04 * A + Bb).toFixed(2), 'white dielectric'), stat(`${this.thetaV}°`, 'view angle'));
  }

  private async time(): Promise<void> {
    const r = this.renderer;
    if (!r) return;
    await timePasses(r.timer, 60, () => this.drawGpu(), ['shade'], this.timing);
  }
}
