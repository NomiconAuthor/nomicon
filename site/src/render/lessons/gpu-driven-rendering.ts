/**
 * "GPU-driven rendering": DrivenViz flies over a city of 4,096 to 65,536 buildings. On WebGPU a
 * compute shader culls every building and writes the indirect draw arguments; on WebGL2 the CPU
 * does the same cull and fills an instance buffer. It says which path is running, shows the CPU
 * model's counts (the numbers the lesson quotes, at the start of the flight), the counts read back
 * from the GPU, and the CPU time per frame measured live.
 */
import '../gpu/gpu.css';
import './engine-side.css';
import { h, seg } from '../../engine/dom';
import { type CityColours, TONES } from '../gpu/culling';
import { type DrivenRenderer, createDriven } from '../gpu/gpu-driven-rendering';
import { GpuCanvas, backendLine } from '../gpu/widget';
import { DEFAULT_SIDE, SIDES, type Side, cpuCull, cullData, flyCam } from '../scenes/gpu-driven-rendering';
import { Palette, chk, frame, mix, onTheme, stage, stat } from '../view';
import { Loop, Rolling, apiSwitch, cpuText, rgb255 } from './engine-side';

const TONE_TOKENS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'];

export class DrivenViz {
  private side: Side = DEFAULT_SIDE;
  private flying = false;
  private t = 0;
  private lastT = 0;
  private pal: Palette;
  private gpu: GpuCanvas;
  private renderer: DrivenRenderer | null = null;
  private api: HTMLElement & { refresh: () => void };
  private backend = h('div', { class: 'll-row' });
  private where = h('p', { class: 'rd-say' });
  private model = h('div', { class: 'll-stats' });
  private gpuLine = h('div', { class: 'll-stats' });
  private live = h('div', { class: 'll-stats' });
  private note = h('p', { class: 'll-muted', style: 'margin: 0' });
  private status = h('p', { class: 'rd-gpu-status' });
  private cpu = new Rolling(60);
  private shown = 0;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-gpu rd-driven');
    this.pal = new Palette(root);
    this.gpu = new GpuCanvas({
      w: 640,
      h: 360,
      label: 'A city seen from above, culled and drawn by the GPU (or by the CPU on WebGL2)',
      build: async (ctx) => {
        this.renderer = await createDriven(ctx, null);
        this.cpu.clear();
      },
      teardown: () => {
        this.renderer?.dispose();
        this.renderer = null;
      },
      draw: () => this.draw(),
      onStatus: (s) => {
        this.status.textContent = s;
        this.showBackend();
      },
    });
    this.api = apiSwitch(this.gpu, () => (this.cpu.clear(), this.showBackend()));
    root.append(
      this.backend,
      this.where,
      h(
        'div',
        { class: 'll-row' },
        seg<string>('Buildings', SIDES.map((s) => [String(s), (s * s).toLocaleString('en-US')] as [string, string]), String(this.side), (v) => {
          this.side = Number(v) as Side;
          this.cpu.clear();
          this.showModel();
          this.draw();
        }).el,
        chk('Fly', this.flying, (on) => {
          this.flying = on;
          if (!on) this.t = 0;
          this.showModel();
        }),
      ),
      stage(this.gpuFig(), [h('div', { class: 'll-h' }, 'CPU model, this view'), this.model, h('div', { class: 'll-h' }, 'Counted by the GPU'), this.gpuLine, h('div', { class: 'll-h' }, 'Measured here, live'), this.live, this.note]),
      this.status,
    );
    onTheme(() => {
      this.pal.reset();
      this.draw();
    });
    void this.gpu.start().then(() => {
      this.api.refresh();
      this.showBackend();
      this.showModel();
    });
    new Loop(root, (t) => {
      if (this.flying) this.t += t - this.lastT;
      this.lastT = t;
      this.draw();
    });
  }

  private gpuFig(): HTMLElement {
    this.gpu.el.classList.add('rd-fig');
    this.gpu.el.style.setProperty('--rd-ar', String(640 / 360));
    return this.gpu.el;
  }

  private showBackend(): void {
    this.backend.replaceChildren(this.api, h('span', {}, h('span', { class: 'll-muted' }, 'GPU: '), ...backendLine(this.gpu)));
    const r = this.renderer;
    this.where.textContent = !r
      ? ''
      : r.where === 'gpu'
        ? 'Running the GPU-driven path: a compute shader culls every building and writes the draw arguments; the CPU records the same few calls whatever the city size.'
        : 'Running the fallback: WebGL2 has no compute shaders or indirect draws, so the CPU culls every building each frame and uploads the survivors for three instanced draws.';
    this.cpu.clear();
  }

  private showModel(): void {
    const d = cullData(this.side);
    const { counts } = cpuCull(d, this.cam());
    const n = counts[0] + counts[1] + counts[2];
    this.model.replaceChildren(stat(d.buildings.length.toLocaleString('en-US'), 'buildings'), stat(n.toLocaleString('en-US'), 'in the frustum'), ...counts.map((c, l) => stat(c.toLocaleString('en-US'), `at LOD ${l}`)));
  }

  private cam() {
    // A fixed 16:9, the canvas's shape, so the counts match the lesson's whatever the canvas's pixel size rounds to.
    return flyCam(this.side, this.t);
  }

  private colours(): CityColours {
    const tones = TONE_TOKENS.map((t) => rgb255(this.pal, t));
    while (tones.length < TONES - 1) tones.push(tones[0]);
    const ground = mix(this.pal.rgb('--bg'), this.pal.rgb('--muted'), 0.35).map((x) => Math.round(x)) as [number, number, number];
    return { bg: rgb255(this.pal, '--bg'), tones: [...tones, ground] };
  }

  private draw(): void {
    const r = this.renderer;
    if (!r) return;
    const t0 = performance.now();
    r.frame(this.side, this.cam(), this.colours());
    this.cpu.add(performance.now() - t0);
    if (performance.now() - this.shown > 300) this.showLive();
  }

  private showLive(): void {
    this.shown = performance.now();
    const r = this.renderer;
    if (!r) return;
    if (this.flying) this.showModel();
    const g = r.gpuCounts();
    if (r.where === 'cpu') this.gpuLine.replaceChildren(h('span', { class: 'll-muted' }, 'Nothing: on WebGL2 the CPU culls.'));
    else if (!g) this.gpuLine.replaceChildren(h('span', { class: 'll-muted' }, 'Waiting for the first read-back…'));
    else {
      const m = cpuCull(cullData(this.side), this.cam()).counts;
      const same = g.every((x, i) => x === m[i]);
      this.gpuLine.replaceChildren(
        ...g.map((c, l) => stat(c.toLocaleString('en-US'), `at LOD ${l}`)),
        h('span', { class: 'll-muted' }, same ? 'the same as the model' : this.flying ? 'read back a frame or more ago, so the view has moved on' : "differs from the model by a few buildings on a plane's edge (32-bit floats on the GPU)"),
      );
    }
    this.live.replaceChildren(stat(cpuText(this.cpu.median()), r.where === 'gpu' ? 'CPU time per frame (record and submit)' : 'CPU time per frame (cull, upload, draw)'));
    this.note.textContent = `Median of the last ${this.cpu.count} frames, on this machine. Try the three city sizes on each path.`;
  }
}
