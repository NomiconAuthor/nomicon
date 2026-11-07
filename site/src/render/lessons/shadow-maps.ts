/**
 * "Shadow maps": one widget.
 *
 * ShadowViz: the courtyard lit by a sun you can move, with a shadow map drawn on the GPU every
 * frame. Controls for the constant and slope-scaled bias, the map's resolution, the filter (one
 * tap, a bilinear comparison, 3 × 3 or 5 × 5 PCF), and cascades (split scheme, stabilisation, a
 * moving camera to show shimmering). Views of the lit frame, the cascades, the map's texels on the
 * surfaces, and the shadow map itself. Beside it, the CPU model's count of acne and light leaks.
 */
import { h, seg } from '../../engine/dom';
import '../gpu/gpu.css';
import { CallLog } from '../gpu/record';
import { type ShadowRenderer, createShadows } from '../gpu/shadow-maps';
import { GpuCanvas, planReadout } from '../gpu/widget';
import {
  type Filter,
  GOOD_BIAS,
  RESOLUTIONS,
  SHADOW_DEFAULTS,
  SUN_AZIMUTH,
  SUN_ELEVATION,
  type ShadowSettings,
  type ShadowView,
  VIEW_H,
  VIEW_W,
  shadowBoxes,
  shadowStats,
  splits,
  sunFrom,
} from '../scenes/shadow-maps';
import { lengthText } from '../scenes/common';
import { Palette, chk, frame, onTheme, stage, stat } from '../view';
import { animate, apiSwitch, gpuFigure, gpuRow, showBackendRow, slider, timePasses } from './lighting-ui';

export class ShadowViz {
  private s: ShadowSettings = { ...SHADOW_DEFAULTS };
  private elev = SUN_ELEVATION;
  private azim = SUN_AZIMUTH;
  private moving = false;
  private t = 0;
  private gpu: GpuCanvas;
  private renderer: ShadowRenderer | null = null;
  private log = new CallLog();
  private api: HTMLElement & { refresh?: () => void };
  private backend = h('div', { class: 'll-row' });
  private status = h('p', { class: 'rd-gpu-status' });
  private planStats = h('div', { class: 'll-stats' });
  private stats = h('div', { class: 'll-stats' });
  private maps = h('div', { class: 'rd-read' });
  private timing = h('span', { class: 'll-muted' });
  private sliders: Record<string, HTMLElement & { set?: (v: number) => void }> = {};
  private statTimer = 0;
  private kick: () => void;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-gpu rd-lit');
    new Palette(root);
    this.gpu = new GpuCanvas({
      w: VIEW_W,
      h: VIEW_H,
      label: 'The courtyard in sunlight with a shadow map, drawn by the GPU',
      build: async (ctx) => {
        this.renderer = await createShadows(ctx, this.log);
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
    const sun = () => this.set({ sun: sunFrom(this.elev, this.azim) });
    this.sliders.elev = slider('Sun height', 10, 80, 1, this.elev, (v) => `${v}°`, (v) => ((this.elev = v), sun()));
    this.sliders.azim = slider('Sun direction', 0, 359, 1, this.azim, (v) => `${v}°`, (v) => ((this.azim = v), sun()));
    this.sliders.bias = slider('Constant bias', 0, 30, 0.5, 0, (v) => `${v} cm`, (v) => this.set({ bias: v / 100 }));
    this.sliders.slope = slider('Slope bias', 0, 4, 0.1, 0, (v) => `${v.toFixed(1)} texels`, (v) => this.set({ slope: v }));
    const res = seg<string>('Map size', RESOLUTIONS.map((r) => [String(r), String(r)] as [string, string]), String(this.s.res), (v) => this.set({ res: Number(v) }));
    const filter = seg<Filter>(
      'Filter',
      [
        ['none', '1 tap'],
        ['bilinear', '2 × 2'],
        ['pcf3', '3 × 3'],
        ['pcf5', '5 × 5'],
      ],
      this.s.filter,
      (v) => this.set({ filter: v }),
    );
    const view = seg<ShadowView>(
      'View',
      [
        ['lit', 'Lit'],
        ['cascades', 'Cascades'],
        ['texels', 'Map texels'],
        ['map', 'Shadow map'],
      ],
      this.s.view,
      (v) => this.set({ view: v }),
    );
    const lambda = slider('Split λ', 0, 1, 0.05, this.s.lambda, (v) => v.toFixed(2), (v) => this.set({ lambda: v }));
    root.append(
      this.backend,
      h('div', { class: 'll-row' }, this.sliders.elev, this.sliders.azim),
      h(
        'div',
        { class: 'll-row' },
        this.sliders.bias,
        this.sliders.slope,
        h('button', { type: 'button', class: 'll-btn', onclick: () => this.goodBias() }, `Try ${GOOD_BIAS.bias * 100} cm + ${GOOD_BIAS.slope}`),
      ),
      h('div', { class: 'll-row' }, res.el, filter.el),
      stage(gpuFigure(this.gpu, VIEW_W, VIEW_H), [
        view.el,
        h(
          'div',
          { class: 'll-row' },
          chk('Cascades', false, (on) => this.set({ cascades: on })),
          lambda,
          chk('Stabilise', true, (on) => this.set({ stable: on })),
          chk('Move the camera', false, (on) => {
            this.moving = on;
            if (!on) {
              this.t = 0;
              this.set({ dolly: 0 });
            }
            this.kick();
          }),
        ),
        this.stats,
        this.maps,
        gpuRow(this.planStats, () => void this.time(), this.timing),
      ]),
      this.status,
    );
    onTheme(() => this.redraw());
    this.kick = animate(root, () => this.moving, (dt) => {
      this.t += dt;
      this.s.dolly = 3 - 3 * Math.cos(this.t * 0.5);
      this.drawGpu();
      this.showMaps();
    });
    this.redraw();
    void this.gpu.start().then(() => {
      this.api.refresh?.();
      this.showBackend();
    });
  }

  private goodBias(): void {
    this.sliders.bias.set?.(GOOD_BIAS.bias * 100);
    this.sliders.slope.set?.(GOOD_BIAS.slope);
    this.set(GOOD_BIAS);
  }

  private set(p: Partial<ShadowSettings>): void {
    this.s = { ...this.s, ...p };
    this.redraw();
  }

  private showBackend(): void {
    showBackendRow(this.backend, this.api, this.gpu);
  }

  private redraw(): void {
    this.drawGpu();
    this.showMaps();
    // The CPU model takes a moment: run it once the sliders settle.
    clearTimeout(this.statTimer);
    this.stats.style.opacity = '0.5';
    this.statTimer = window.setTimeout(() => this.showStats(), 180);
  }

  private drawGpu(): void {
    const r = this.renderer;
    if (!r) return;
    this.planStats.replaceChildren(...planReadout(r.frame(this.s)));
  }

  private showStats(): void {
    const st = shadowStats({ ...this.s, dolly: 0 });
    const pc = (n: number, of: number) => `${((100 * n) / Math.max(1, of)).toFixed(1)}%`;
    this.stats.style.opacity = '1';
    this.stats.replaceChildren(
      stat(pc(st.acne, st.lit), 'of sunlit pixels with acne'),
      stat(st.leaks.toLocaleString('en-US'), 'shadowed pixels lit by mistake'),
      h('span', { class: 'll-muted' }, `From the CPU model: one tap per pixel of a 320 × 200 image of the starting view, against a ray to the sun.`),
    );
  }

  private showMaps(): void {
    const boxes = shadowBoxes(this.s);
    const sp = splits(this.s.lambda);
    const rows = boxes.map((b, i) =>
      h('tr', {}, h('td', {}, this.s.cascades ? `${i + 1}: ${sp[i].toFixed(1)}–${sp[i + 1].toFixed(1)} m` : 'whole courtyard'), h('td', {}, `${b.texels} × ${b.texels}`), h('td', {}, lengthText(b.texel))),
    );
    this.maps.replaceChildren(h('table', { class: 'rd-gtab' }, h('tr', {}, h('th', {}, 'Map'), h('th', {}, 'Texels'), h('th', {}, 'Texel size')), ...rows));
  }

  private async time(): Promise<void> {
    const r = this.renderer;
    if (!r) return;
    await timePasses(r.timer, 60, () => this.drawGpu(), ['shadow map', 'camera'], this.timing);
  }
}
