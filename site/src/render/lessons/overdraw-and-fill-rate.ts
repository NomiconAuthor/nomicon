/**
 * "Overdraw and fill rate": FillViz, a forest scene with a smoke plume drawn on the real GPU
 * (gpu/overdraw-and-fill-rate.ts), in colour or as a heat map of fragments shaded per pixel,
 * with the CPU model's counts beside it (scenes/overdraw-and-fill-rate.ts; the same numbers the
 * lesson quotes) and the live GPU time per pass.
 */
import '../gpu/gpu.css';
import { h, seg } from '../../engine/dom';
import { type FillColours, type FillRenderer, createFill } from '../gpu/overdraw-and-fill-rate';
import { LiveTimes } from '../gpu/perf-common';
import { CallLog } from '../gpu/record';
import { GpuCanvas, backendLine } from '../gpu/widget';
import { COSTS, FILL_DEFAULTS, FILL_H, FILL_PIXELS, FILL_W, type FillSettings, type FillView, type OpaqueOrder, SIZES, fillCounts } from '../scenes/overdraw-and-fill-rate';
import { type RGB, Palette, chk, frame, mix, onTheme, rgbCss, stage } from '../view';
import { LiveLoop, apiSwitch, range, slider, timesTable } from './perf-common';

const int = (n: number) => Math.round(n).toLocaleString('en-US');
const r255 = (c: RGB) => c.map((x) => Math.round(x)) as [number, number, number];

/** The heat ramp: colours for 1, 2, 4, 8, 16, 32 and 64 or more fragments a pixel. */
export const HEAT_STOPS = [1, 2, 4, 8, 16, 32, 64];
export function heatRamp(pal: Palette): RGB[] {
  const bg = pal.rgb('--bg');
  const ink = pal.rgb('--ink');
  const warn = pal.rgb('--warn');
  const alert = pal.rgb('--alert');
  return [mix(bg, ink, 0.2), mix(bg, warn, 0.45), warn, mix(warn, alert, 0.55), alert, mix(alert, ink, 0.45), mix(alert, ink, 0.85)];
}

function colours(pal: Palette): FillColours {
  const bg = pal.rgb('--bg');
  return {
    bg: r255(bg),
    cards: [r255(mix(bg, pal.rgb('--c7'), 0.35)), ...['--c2', '--c3', '--c5', '--c6', '--c4'].map((t) => r255(mix(bg, pal.rgb(t), 0.8)))],
    smoke: r255(mix(pal.rgb('--ink'), bg, 0.15)),
    heat: heatRamp(pal).map(r255),
  };
}

export class FillViz {
  private s: FillSettings = { ...FILL_DEFAULTS };
  private view: FillView = 'colour';
  private pal: Palette;
  private gpu: GpuCanvas;
  private renderer: FillRenderer | null = null;
  private live: LiveTimes | null = null;
  private passes: string[] = [];
  private log = new CallLog();
  private api: HTMLElement & { refresh: () => void };
  private backend = h('div', { class: 'll-row' });
  private counts = h('div', { class: 'rd-read' });
  private times = h('div', {});
  private legend = h('div', { class: 'rp-legend' });
  private status = h('p', { class: 'rd-gpu-status' });
  private lastTimes = 0;
  private countTimer = 0;
  private loop: LiveLoop;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-fill');
    this.pal = new Palette(root);
    this.gpu = new GpuCanvas({
      w: 640,
      h: 360,
      label: 'A forest with a smoke plume, drawn by the GPU, in colour or as a heat map of fragments shaded per pixel',
      build: async (ctx) => {
        this.renderer = await createFill(ctx, this.log);
        this.live = new LiveTimes(this.renderer.timer);
      },
      teardown: () => {
        this.live?.stop();
        this.live = null;
        this.renderer?.dispose();
        this.renderer = null;
      },
      draw: () => this.draw(),
      onStatus: (s) => {
        this.status.textContent = s;
        this.showBackend();
      },
    });
    this.api = apiSwitch(this.gpu, () => this.changed());
    const set = <K extends keyof FillSettings>(k: K) => (v: FillSettings[K]) => {
      this.s[k] = v;
      this.changed();
    };
    const viewSeg = seg<FillView>(
      'Show',
      [
        ['colour', 'Colour'],
        ['heat', 'Fragments shaded per pixel'],
      ],
      this.view,
      (v) => {
        this.view = v;
        this.changed();
      },
    );
    root.append(
      this.backend,
      stage(this.gpu.el, [h('div', {}, h('p', { class: 'rp-h' }, 'Fragments, from the CPU model'), this.counts), h('div', {}, h('p', { class: 'rp-h' }, 'GPU time, live'), this.times)]),
      h('div', { class: 'rp-controls' }, viewSeg.el, this.legend),
      h(
        'div',
        { class: 'rp-controls' },
        slider('Particles', range(0, 1200, 50), this.s.particles, (v) => int(v), set('particles')),
        seg<string>('Size', SIZES.map((v) => [String(v), `${v} px`] as [string, string]), String(this.s.size), (v) => set('size')(Number(v))).el,
      ),
      h(
        'div',
        { class: 'rp-controls' },
        seg<FillSettings['shape']>(
          'Particle shape',
          [
            ['quad', 'Quads'],
            ['trimmed', 'Trimmed octagons'],
          ],
          this.s.shape,
          set('shape'),
        ).el,
        seg<string>('Particle shader cost', COSTS.map((v) => [String(v), v === 1 ? '1 iteration' : `${v}`] as [string, string]), String(this.s.cost), (v) => set('cost')(Number(v))).el,
      ),
      h(
        'div',
        { class: 'rp-controls' },
        seg<OpaqueOrder>(
          'Opaque order',
          [
            ['back-to-front', 'Back to front'],
            ['unsorted', 'Unsorted'],
            ['front-to-back', 'Front to back'],
          ],
          this.s.order,
          set('order'),
        ).el,
        chk('Depth prepass', this.s.prepass, set('prepass')),
        chk('Particles at half resolution', this.s.halfRes, set('halfRes')),
      ),
      this.status,
    );
    onTheme(() => {
      this.pal.reset();
      this.showLegend();
      this.draw();
    });
    this.showLegend();
    this.showCounts();
    this.showTimes();
    const loop = new LiveLoop(root, () => this.draw(), () => !!this.renderer);
    void this.gpu.start().then(() => {
      this.api.refresh();
      this.showBackend();
      loop.kick();
    });
    this.loop = loop;
  }

  private changed(): void {
    this.live?.clear();
    this.showBackend();
    this.showLegend();
    this.draw();
    this.loop.kick();
    // The model takes a few milliseconds; don't redo it on every slider event.
    clearTimeout(this.countTimer);
    this.countTimer = window.setTimeout(() => this.showCounts(), 60);
  }

  private showBackend(): void {
    this.backend.replaceChildren(this.api, h('span', {}, h('span', { class: 'll-muted' }, 'Drawn with '), ...backendLine(this.gpu)));
  }

  private showLegend(): void {
    if (this.view === 'colour') {
      this.legend.replaceChildren(h('span', {}, `Rendered at ${FILL_W} × ${FILL_H}, scaled to fit. The heat map shows where the fragments go.`));
      return;
    }
    const ramp = heatRamp(this.pal);
    const item = (c: RGB, t: string) => h('span', {}, h('i', { style: `background:${rgbCss(c)}` }), t);
    this.legend.replaceChildren(h('span', {}, 'Fragments shaded at a pixel:'), ...HEAT_STOPS.map((n, i) => item(ramp[i], i === HEAT_STOPS.length - 1 ? `${n} or more` : String(n))), this.s.halfRes ? h('span', {}, '(a half-resolution fragment counts as ¼)') : '');
  }

  private showCounts(): void {
    const c = fillCounts(this.s);
    const row = (name: string, v: number, note = '', on = true) => h('tr', { class: on ? '' : 'rp-off' }, h('th', {}, name), h('td', {}, on ? int(v) : '–'), h('td', { class: 'rp-cell-note' }, note));
    const hidden = c.particlesCovered - c.particles;
    this.counts.replaceChildren(
      h(
        'table',
        { class: 'rd-tab' },
        h(
          'tbody',
          {},
          row('Depth prepass', c.prepass, 'not counted', this.s.prepass),
          row('Opaque', c.opaque, `${(c.opaque / FILL_PIXELS).toFixed(2)} a pixel`),
          row('Depth downsample', c.downsample, 'not counted', this.s.halfRes),
          row('Particles', c.particles, hidden ? `${int(hidden)} hidden` : ''),
          row('Composite', c.composite, 'one a pixel', this.s.halfRes),
          h('tr', { class: 'rp-total' }, h('th', {}, 'Shaded'), h('td', {}, int(c.shaded)), h('td', { class: 'rp-cell-note' }, `${c.perPixel.toFixed(2)} a pixel`)),
        ),
      ),
      h('p', { class: 'rp-fine' }, `${int(FILL_PIXELS)} pixels. Shader cost changes what each fragment costs, not the counts.`),
    );
  }

  private showTimes(): void {
    this.times.replaceChildren(timesTable(this.renderer?.timer ?? null, this.live, this.passes));
  }

  private draw(): void {
    const r = this.renderer;
    if (!r) return;
    const { plan, timed } = r.frame(this.s, this.view, colours(this.pal));
    this.passes = plan.passes.map((p) => p.name);
    if (timed) this.live?.drew(this.passes);
    const now = performance.now();
    if (now - this.lastTimes > 500) {
      this.lastTimes = now;
      this.showTimes();
    }
  }
}
