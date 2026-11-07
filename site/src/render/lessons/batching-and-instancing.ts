/**
 * "Batching and instancing": BatchViz draws one grid of objects on the GPU four ways (one draw per
 * object in scene order, sorted by a state key, static batches, instanced draws). It shows the
 * draws and binds each way makes (from the plan, the numbers the lesson quotes) and the CPU time
 * the page spends recording and submitting them, measured live on the reader's machine.
 */
import '../gpu/gpu.css';
import './engine-side.css';
import { h, seg } from '../../engine/dom';
import { type BatchColours, type BatchRenderer, createBatching } from '../gpu/batching-and-instancing';
import { GpuCanvas, backendLine } from '../gpu/widget';
import {
  type BatchPlan,
  DEFAULT_SIDE,
  MATERIALS,
  MESHES,
  METHODS,
  type Method,
  SIDES,
  type Side,
  bytesText,
  callsPerFrame,
  gridCamera,
  keyText,
  memory,
  planFor,
  stateChanges,
} from '../scenes/batching-and-instancing';
import { Palette, chk, frame, onTheme, plural, stage, stat } from '../view';
import { Loop, Rolling, apiSwitch, cpuText, rgb255 } from './engine-side';

const SAY: Record<Method, string> = {
  unsorted: 'One draw per object, in the order the scene lists them. Neighbouring draws rarely share a pipeline, material or mesh, so almost every draw rebinds something.',
  sorted: 'The same draws, sorted by their keys: pipeline, then material, then mesh, then depth. Each bind now happens once per run of draws that share it; the per-object constants still change every draw.',
  static: "Each material's objects were merged at load into one mesh, already moved into place: one draw per material. Fast to submit, but every object is a copy, and none of them can move or be culled on its own.",
  instanced: 'One draw per mesh and material, with a 16-byte record per instance read from a second vertex buffer. The GPU repeats the mesh for each record.',
};

export class BatchViz {
  private method: Method = 'unsorted';
  private side: Side = DEFAULT_SIDE;
  private turning = true;
  private angle = 0.6;
  private pal: Palette;
  private gpu: GpuCanvas;
  private renderer: BatchRenderer | null = null;
  private plan: BatchPlan | null = null;
  private submit = new Rolling(60);
  private build = new Rolling(60);
  private api: HTMLElement & { refresh: () => void };
  private backend = h('div', { class: 'll-row' });
  private counts = h('div', { class: 'll-stats' });
  private live = h('div', { class: 'll-stats' });
  private liveNote = h('p', { class: 'll-muted', style: 'margin: 0' });
  private mem = h('p', { class: 'll-muted', style: 'margin: 0' });
  private keys = h('ol', { class: 'rd-keys' });
  private say = h('p', { class: 'rd-say' });
  private status = h('p', { class: 'rd-gpu-status' });
  private lastT = 0;
  private shown = 0;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-gpu rd-batch');
    this.pal = new Palette(root);
    this.gpu = new GpuCanvas({
      w: 640,
      h: 360,
      label: 'A grid of crates, wedges and pyramids in four materials, drawn by the GPU',
      build: async (ctx) => {
        this.renderer = await createBatching(ctx, null);
        this.submit.clear();
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
    this.api = apiSwitch(this.gpu, () => (this.submit.clear(), this.showBackend()));
    root.append(
      this.backend,
      h(
        'div',
        { class: 'll-row' },
        seg<Method>('Draw', METHODS, this.method, (m) => {
          this.method = m;
          this.reset();
        }).el,
      ),
      h(
        'div',
        { class: 'll-row' },
        seg<string>('Objects', SIDES.map((s) => [String(s), (s * s).toLocaleString('en-US')] as [string, string]), String(this.side), (v) => {
          this.side = Number(v) as Side;
          this.reset();
        }).el,
        chk('Turn the camera', this.turning, (on) => (this.turning = on)),
      ),
      stage(this.gpuFig(), [this.counts, this.live, this.liveNote, this.mem, h('div', { class: 'll-h' }, 'First draws, in submission order (key: pipeline, material, mesh, depth)'), this.keys]),
      this.say,
      this.status,
    );
    onTheme(() => {
      this.pal.reset();
      this.draw();
    });
    void this.gpu.start().then(() => {
      this.api.refresh();
      this.showBackend();
      this.reset();
    });
    new Loop(root, (t) => {
      if (this.turning) this.angle += (t - this.lastT) * 0.15;
      this.lastT = t;
      this.draw();
    });
  }

  private gpuFig(): HTMLElement {
    this.gpu.el.classList.add('rd-fig');
    this.gpu.el.style.setProperty('--rd-ar', String(640 / 360));
    return this.gpu.el;
  }

  private colours(): BatchColours {
    return { bg: rgb255(this.pal, '--bg'), materials: MATERIALS.map((m) => rgb255(this.pal, m.color)) };
  }

  private reset(): void {
    this.submit.clear();
    this.build.clear();
    this.plan = planFor(this.method, this.side);
    this.say.textContent = SAY[this.method];
    this.showCounts();
    this.draw();
  }

  private showBackend(): void {
    this.backend.replaceChildren(this.api, h('span', {}, h('span', { class: 'll-muted' }, 'GPU: '), ...backendLine(this.gpu)));
    this.showCounts();
  }

  /** The numbers from the plan: the same on every machine. */
  private showCounts(): void {
    const p = this.plan;
    if (!p) return;
    const s = stateChanges(p);
    const be = this.gpu.ctx?.kind ?? 'webgpu';
    this.counts.replaceChildren(
      stat(s.draws.toLocaleString('en-US'), s.draws === 1 ? 'draw call' : 'draw calls'),
      stat(s.pipelines.toLocaleString('en-US'), 'pipeline binds'),
      stat(s.materials.toLocaleString('en-US'), 'material binds'),
      stat(s.meshes.toLocaleString('en-US'), 'mesh binds'),
      stat(s.objects.toLocaleString('en-US'), 'object constant binds'),
      stat(callsPerFrame(p, be).toLocaleString('en-US'), `${be === 'webgpu' ? 'WebGPU' : 'WebGL2'} calls per frame`),
    );
    const m = memory(this.side);
    this.mem.textContent =
      this.method === 'static'
        ? `Merged meshes: ${bytesText(m.batches)}, every object its own copy (the three shared meshes take ${bytesText(m.meshes)}).`
        : this.method === 'instanced'
          ? `Instance records: ${bytesText(m.instances)} (${plural(this.side * this.side, 'object')} × 16 bytes).`
          : `Object constants: ${bytesText(m.constants)}, 16 bytes per object at 256-byte offsets.`;
    const draws = p.passes[0].draws.slice(0, 8);
    let prev: (typeof draws)[number] | null = null;
    this.keys.replaceChildren(
      ...draws.map((d) => {
        const ch = (a: boolean, t: string) => h('span', { class: a ? 'ch' : '' }, t);
        const li = h(
          'li',
          {},
          d.mesh >= 0 && d.object >= 0 ? h('code', {}, keyText(d.key)) : '',
          ' ',
          ch(!prev || prev.pipeline !== d.pipeline, d.pipeline),
          ' · ',
          ch(!prev || prev.material !== d.material, MATERIALS[d.material].name),
          ' · ',
          ch(!prev || prev.mesh !== d.mesh || d.mesh < 0, d.mesh < 0 ? 'merged mesh' : MESHES[d.mesh].name),
          d.instances > 1 ? ` × ${d.instances}` : '',
        );
        prev = d;
        return li;
      }),
    );
  }

  private draw(): void {
    const r = this.renderer;
    if (!r || !this.plan) return;
    const cam = gridCamera(this.side, this.gpu.canvas.width / this.gpu.canvas.height, this.angle);
    // Building the draw list (and sorting it) and recording + submitting it are timed separately.
    const t0 = performance.now();
    const plan = planFor(this.method, this.side, cam);
    const t1 = performance.now();
    r.draw(plan, this.side, cam, this.colours());
    const t2 = performance.now();
    this.build.add(t1 - t0);
    this.submit.add(t2 - t1);
    this.plan = plan;
    if (performance.now() - this.shown > 250) this.showLive();
  }

  private showLive(): void {
    this.shown = performance.now();
    const sub = this.submit.median();
    const s = this.plan ? stateChanges(this.plan) : null;
    this.live.replaceChildren(
      stat(cpuText(sub), 'to record and submit'),
      stat(cpuText(this.build.median()), this.method === 'sorted' ? 'to build and sort the list' : 'to build the list'),
      stat(sub !== null && s ? perDraw(sub / s.draws) : '…', 'per draw'),
    );
    this.liveNote.textContent = `Measured on this page with performance.now(), median of the last ${this.submit.count} frames. Only the page's side: the browser's GPU process and the driver do more work later. Browsers round performance.now(), so small times are coarse.`;
    if (this.method === 'sorted' || this.method === 'unsorted') this.showCounts();
  }
}

/** A per-draw time: microseconds with two significant digits. */
function perDraw(ms: number): string {
  const us = ms * 1000;
  return us >= 10 ? `${Math.round(us)} µs` : us >= 1 ? `${us.toFixed(1)} µs` : `${us.toFixed(2)} µs`;
}
