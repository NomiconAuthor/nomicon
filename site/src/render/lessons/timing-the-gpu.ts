/**
 * "Timing the GPU": TimingViz. A frame whose GPU cost the reader dials up (layers × loop
 * iterations, gpu/timing-the-gpu.ts), timed live three ways: a CPU timer around the calls, a CPU
 * timer until the GPU is done, and GPU timestamp queries; plus the time between animation frames.
 * The pipeline statistics beside them come from the model (scenes/timing-the-gpu.ts).
 */
import '../gpu/gpu.css';
import { h, seg } from '../../engine/dom';
import { LiveTimes } from '../gpu/perf-common';
import { CallLog } from '../gpu/record';
import { type TimingRenderer, createTiming } from '../gpu/timing-the-gpu';
import { GpuCanvas, backendLine, msText } from '../gpu/widget';
import { ITERATIONS, LAYERS, TIMING_DEFAULTS, type TimingSettings, pipelineStatistics } from '../scenes/timing-the-gpu';
import { type RGB, Palette, frame, onTheme, stage } from '../view';
import { LiveLoop, apiSwitch, slider } from './perf-common';

const int = (n: number) => Math.round(n).toLocaleString('en-US');
const KEEP = 40;
const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export class TimingViz {
  private s: TimingSettings = { ...TIMING_DEFAULTS };
  private pal: Palette;
  private gpu: GpuCanvas;
  private renderer: TimingRenderer | null = null;
  private live: LiveTimes | null = null;
  private log = new CallLog();
  private api: HTMLElement & { refresh: () => void };
  private backend = h('div', { class: 'll-row' });
  private bars = h('div', {});
  private stats = h('div', {});
  private status = h('p', { class: 'rd-gpu-status' });
  private cpu: number[] = [];
  private done: number[] = [];
  private interval: number[] = [];
  private lastTick = 0;
  private lastShow = 0;
  private loop: LiveLoop;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-timing');
    this.pal = new Palette(root);
    this.gpu = new GpuCanvas({
      w: 640,
      h: 360,
      label: 'The frame being timed: layers of a shader with a loop',
      build: async (ctx) => {
        this.renderer = await createTiming(ctx, this.log);
        this.live = new LiveTimes(this.renderer.timer, KEEP);
      },
      teardown: () => {
        this.live?.stop();
        this.live = null;
        this.renderer?.dispose();
        this.renderer = null;
      },
      draw: () => this.draw(false),
      onStatus: (s) => {
        this.status.textContent = s;
        this.showBackend();
      },
    });
    this.api = apiSwitch(this.gpu, () => this.changed());
    root.append(
      this.backend,
      h(
        'div',
        { class: 'rp-controls' },
        slider('Layers', LAYERS, this.s.layers, (v) => String(v), (v) => {
          this.s.layers = v;
          this.changed();
        }),
        seg<string>('Loop iterations a fragment', ITERATIONS.map((v) => [String(v), String(v)] as [string, string]), String(this.s.iterations), (v) => {
          this.s.iterations = Number(v);
          this.changed();
        }).el,
      ),
      stage(this.gpu.el, [h('div', {}, h('p', { class: 'rp-h' }, 'Measured live, median of recent frames'), this.bars), h('div', {}, h('p', { class: 'rp-h' }, 'Pipeline statistics for the work pass (model)'), this.stats)]),
      this.status,
    );
    onTheme(() => this.pal.reset());
    this.showStats();
    this.showBars();
    this.loop = new LiveLoop(root, () => this.draw(true), () => !!this.renderer);
    void this.gpu.start().then(() => {
      this.api.refresh();
      this.showBackend();
      this.loop.kick();
    });
  }

  private changed(): void {
    this.cpu = [];
    this.done = [];
    this.interval = [];
    this.live?.clear();
    this.showStats();
    this.showBackend();
    this.loop.kick();
  }

  private showBackend(): void {
    this.backend.replaceChildren(this.api, h('span', {}, h('span', { class: 'll-muted' }, 'Drawn with '), ...backendLine(this.gpu)));
  }

  private showStats(): void {
    const p = pipelineStatistics(this.s);
    const row = (k: string, v: number) => h('tr', {}, h('th', {}, k), h('td', {}, int(v)));
    this.stats.replaceChildren(
      h('table', { class: 'rd-tab' }, h('tbody', {}, row('IAPrimitives', p.IAPrimitives), row('VSInvocations', p.VSInvocations), row('PSInvocations', p.PSInvocations), row('loop iterations', p.loopIterations))),
      h('p', { class: 'rp-fine' }, "D3D12's names; Vulkan's pipeline-statistics query counts the same. WebGPU has no such query, so these come from the frame's plan."),
    );
  }

  private showBars(): void {
    const r = this.renderer;
    const keep = (a: number[]) => median(a);
    const cpu = keep(this.cpu);
    const done = keep(this.done);
    const frameMs = keep(this.interval);
    const passes = ['work', 'present'];
    const m = this.live?.medians(passes);
    const gpu = r?.timer.available && m && m.frames >= 3 ? (m.ms.get('work') ?? 0) + (m.ms.get('present') ?? 0) : null;
    const items: Array<[string, number | null, string]> = [
      ['CPU timer around the calls', cpu, 'cpu'],
      [r?.backend === 'webgl2' ? 'CPU timer until a pixel reads back' : 'CPU timer until the GPU reports done', done, 'wait'],
      ['GPU timestamps, both passes', gpu, ''],
      ['Time between animation frames', frameMs, 'cpu'],
    ];
    const top = Math.max(1e-3, ...items.map(([, v]) => v ?? 0));
    const rows = items.flatMap(([label, v, cls]) => [
      h('span', { class: 'lab' }, label),
      h('span', {}, h('span', { class: `bar ${cls}`, style: `display:block;width:${v === null ? 0 : Math.max(0.5, (100 * v) / top)}%` })),
      h('span', { class: 'val' }, v === null ? '–' : msText(v)),
    ]);
    let say = '';
    if (!r) say = 'Starting the GPU…';
    else if (!r.timer.available) say = `No GPU timestamps here: ${r.timer.why}. The other three still run; the CPU timer around the calls is the one that's wrong.`;
    else if (gpu === null || cpu === null) say = 'Measuring…';
    else if (gpu > cpu) {
      const miss = 100 * (1 - cpu / gpu);
      say = `The CPU timer around the calls reads ${msText(cpu)}; the GPU spent ${msText(gpu)} on the frame. Timing the calls misses ${miss > 99.5 ? 'over 99%' : `${Math.round(miss)}%`} of it. (${r.timer.why}.)`;
    } else if (gpu === 0) say = `The GPU's time reads 0: this frame is below the timer's resolution. Turn the cost up. (${r.timer.why}.)`;
    else say = `At this cost the GPU's work (${msText(gpu)}) is no bigger than the CPU's time in the calls (${msText(cpu)}): turn the cost up. (${r.timer.why}.)`;
    this.bars.replaceChildren(h('div', { class: 'rp-bars' }, ...rows), h('p', { class: 'rp-fine' }, say));
  }

  private draw(tick: boolean): void {
    const r = this.renderer;
    if (!r) return;
    const now = performance.now();
    if (tick && this.lastTick) {
      this.interval.push(now - this.lastTick);
      if (this.interval.length > KEEP) this.interval.shift();
    }
    this.lastTick = tick ? now : 0;
    const res = r.frame(this.s, this.pal.rgb('--accent').map((x) => Math.round(x)) as RGB as [number, number, number]);
    if (res.timed) this.live?.drew(res.plan.passes.map((p) => p.name));
    this.cpu.push(res.cpu);
    if (this.cpu.length > KEEP) this.cpu.shift();
    void res.done.then((ms) => {
      if (ms === null) return;
      this.done.push(ms);
      if (this.done.length > KEEP) this.done.shift();
    });
    if (now - this.lastShow > 400) {
      this.lastShow = now;
      this.showBars();
    }
  }
}
