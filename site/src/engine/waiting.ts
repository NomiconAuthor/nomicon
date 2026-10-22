/** Widgets for the "threads, pools and fibers" lesson: what happens when a job waits, and named threads. */
import { fmt, h, seg } from './dom';
import { COSTS, frameWorkload, simulateWait, type Mode, type Span, type WaitResult, type Workload } from './waitsim';

function cols(el: Element) {
  const cs = getComputedStyle(el);
  const g = (n: string) => cs.getPropertyValue(n).trim() || '#888';
  return {
    bg: g('--bg'),
    paper: g('--paper'),
    soft: g('--line-soft'),
    ink: g('--ink'),
    muted: g('--muted'),
    accent: g('--accent'),
    warn: g('--warn'),
    alert: g('--alert'),
    mono: g('--f-mono'),
    series: ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'].map(g),
  };
}
type Cols = ReturnType<typeof cols>;

const onTheme = (fn: () => void) => new MutationObserver(fn).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
const stat = (v: string, l: string, title?: string) => h('div', { class: 'll-stat', title }, h('b', {}, v), h('span', {}, l));
const key = (colour: string, label: string, extra = '') => h('span', { class: `jb-key ${extra}`, style: `--k: ${colour}` }, label);

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

function hatch(ctx: CanvasRenderingContext2D, x0: number, y: number, w: number, hgt: number, colour: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y, w, hgt);
  ctx.clip();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  for (let x = x0 - hgt; x < x0 + w; x += 6) {
    ctx.beginPath();
    ctx.moveTo(x, y + hgt);
    ctx.lineTo(x + hgt, y);
    ctx.stroke();
  }
  ctx.restore();
}

// ==========================================================================================
// 1. What happens when a job waits

const MODES: Array<[Mode, string]> = [
  ['block', 'Block'],
  ['help', 'Help while waiting'],
  ['fiber', 'Fibers'],
  ['coroutine', 'Coroutines'],
  ['threads', 'A thread per job'],
];

const NOTES: Record<Mode, string> = {
  block: 'The worker sleeps until the children are done, and its core sits idle. If every worker is waiting on children that are still in the queue, nobody can run them: a deadlock.',
  help: 'The worker runs other jobs from inside the wait, on top of the waiting job on its own stack. Numbers on a block show how deep the stack is. The waiting job can only carry on once the job on top of it finishes, however long that is.',
  fiber: 'The waiting job is parked on its own fiber (its own small stack) and the worker picks up something else. When the children are done, the next free worker switches to that fiber and carries on.',
  coroutine: 'Scheduled like fibers, but the job is a stackless coroutine: suspending it saves only the frame the compiler set aside for its locals, not a whole stack. Cheaper to switch and far smaller, but only coroutines can suspend.',
  threads: 'No pool: every job is its own OS thread, created by whoever spawns it. The OS parks threads that wait and runs the others. Creating threads and switching between them costs far more than the jobs here do.',
};

export class WaitViz {
  private root: HTMLElement;
  private cnv = h('canvas', { class: 'jb-gantt', 'aria-label': 'Core timeline' }) as HTMLCanvasElement;
  private stats = h('div', { class: 'll-stats' });
  private keys = h('div', { class: 'jb-keys' });
  private note = h('p', { class: 'll-muted' });
  private tip = h('div', { class: 'wt-tip', hidden: true });
  private mode: Mode = 'block';
  private cores = 8;
  private nested = false;
  private wl: Workload = frameWorkload(false);
  private r: WaitResult | null = null;
  private geom = { left: 0, top: 0, laneH: 0, span: 1, width: 1 };

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll jb wt' });
    host.replaceChildren(this.root);
    const m = seg<Mode>('When a job waits', MODES, this.mode, (x) => ((this.mode = x), this.run()));
    const c = seg<string>('Cores', ['4', '8', '16'].map((x) => [x, x] as [string, string]), String(this.cores), (x) => ((this.cores = Number(x)), this.run()));
    const w = seg<'flat' | 'nested'>(
      'Waiting',
      [
        ['flat', 'One level'],
        ['nested', 'Waits inside waits'],
      ],
      'flat',
      (x) => ((this.nested = x === 'nested'), (this.wl = frameWorkload(this.nested)), this.run()),
    );
    this.root.append(h('div', { class: 'll-row' }, m.el), h('div', { class: 'll-row' }, c.el, w.el), this.keys, h('div', { class: 'wt-wrap' }, this.cnv, this.tip), this.stats, this.note);
    this.cnv.addEventListener('pointermove', (e) => this.hover(e));
    this.cnv.addEventListener('pointerleave', () => (this.tip.hidden = true));
    new ResizeObserver(() => this.draw()).observe(this.root);
    onTheme(() => this.draw());
    this.run();
  }

  private run(): void {
    this.r = simulateWait(this.wl.tasks, this.wl.roots, this.mode, this.cores);
    this.note.textContent = NOTES[this.mode];
    this.draw();
    this.statsFor(this.r);
  }

  private colourOf(c: Cols, task: number): string {
    if (task < 0) return c.muted;
    const g = this.wl.tasks[task].group;
    return g >= this.wl.groups.length - 1 ? c.muted : c.series[g % c.series.length];
  }

  private draw(): void {
    const r = this.r;
    if (!r) return;
    const c = cols(this.root);
    this.keys.replaceChildren(
      ...this.wl.groups.slice(0, -1).map((g, i) => key(c.series[i % c.series.length], g)),
      key(c.muted, 'Other jobs'),
      key(c.alert, 'Scheduling, switching, creating'),
      ...(this.mode === 'block' ? [key(c.warn, 'Blocked', 'wt-hatch')] : []),
      ...(this.mode === 'help' ? [key(c.soft, 'Waiting, nothing to help with')] : []),
    );
    const cnv = this.cnv;
    const dpr = window.devicePixelRatio || 1;
    const Wd = cnv.clientWidth || 800;
    const W = this.cores;
    const laneH = W > 8 ? 16 : 24;
    const top = 6;
    const Hh = top + W * laneH + 26;
    cnv.width = Math.round(Wd * dpr);
    cnv.height = Math.round(Hh * dpr);
    cnv.style.height = `${Hh}px`;
    const ctx = cnv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, Wd, Hh);
    const left = 34;
    const span = Math.max(1, r.makespan);
    const width = Wd - left - 8;
    this.geom = { left, top, laneH, span, width };
    const x = (t: number) => left + (t / span) * width;
    ctx.font = `11px ${c.mono}`;
    ctx.textBaseline = 'middle';
    for (let k = 0; k < W; k++) {
      const y = top + k * laneH;
      ctx.fillStyle = c.paper;
      ctx.fillRect(left, y + 1, width, laneH - 2);
      ctx.fillStyle = c.muted;
      ctx.fillText(`C${k}`, 4, y + laneH / 2);
    }
    for (const s of r.spans) {
      const y = top + s.core * laneH;
      const x0 = x(s.start);
      const w = Math.max(0.6, x(s.end) - x0 - 0.4);
      if (s.kind === 'overhead') {
        ctx.fillStyle = c.alert;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x0, y + 2, w, laneH - 4);
        ctx.globalAlpha = 1;
      } else if (s.kind === 'blocked') {
        hatch(ctx, x0, y + 3, w, laneH - 6, c.warn);
      } else if (s.kind === 'spin') {
        ctx.fillStyle = c.soft;
        ctx.fillRect(x0, y + laneH / 2 - 1, w, 2);
      } else {
        // Nested work (help mode) is drawn a little shorter per level, so the stack shows.
        const inset = Math.min(s.depth * 2, laneH / 2 - 4);
        ctx.fillStyle = this.colourOf(c, s.task);
        ctx.fillRect(x0, y + 2 + inset, w, laneH - 4 - inset);
        if (s.depth > 0 && w > 12 && laneH >= 20) {
          ctx.fillStyle = c.bg;
          ctx.fillText(String(s.depth), x0 + 3, y + laneH / 2 + inset / 2);
        }
      }
    }
    const axisY = top + W * laneH + 4;
    ctx.strokeStyle = c.soft;
    ctx.beginPath();
    ctx.moveTo(left, axisY);
    ctx.lineTo(Wd - 8, axisY);
    ctx.stroke();
    const step = niceStep(span / 6);
    ctx.fillStyle = c.muted;
    for (let t = 0; t <= span + 1e-6; t += step) {
      const xx = x(t);
      ctx.beginPath();
      ctx.moveTo(xx, axisY);
      ctx.lineTo(xx, axisY + 4);
      ctx.stroke();
      ctx.fillText(`${fmt(t)} µs`, Math.min(xx - 10, Wd - 60), axisY + 13);
    }
    if (r.deadlock) {
      ctx.font = `600 13px ${c.mono}`;
      const msg = 'Deadlock: every worker is waiting for jobs nobody can run';
      const tw = Math.min(ctx.measureText(msg).width + 16, Wd - 16);
      const bx = Math.max(8, (Wd - tw) / 2);
      const by = top + (W * laneH) / 2 - 12;
      ctx.fillStyle = c.bg;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(bx, by, tw, 24);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.alert;
      ctx.strokeRect(bx, by, tw, 24);
      ctx.fillStyle = c.alert;
      ctx.fillText(msg, bx + 8, by + 12, tw - 16);
    }
  }

  private hover(e: PointerEvent): void {
    const r = this.r;
    if (!r) return;
    const b = this.cnv.getBoundingClientRect();
    const px = e.clientX - b.left;
    const py = e.clientY - b.top;
    const g = this.geom;
    const core = Math.floor((py - g.top) / g.laneH);
    const t = ((px - g.left) / g.width) * g.span;
    let hit: Span | undefined;
    if (core >= 0 && core < this.cores) for (const s of r.spans) if (s.core === core && s.start <= t && t <= s.end) hit = s;
    if (!hit) {
      this.tip.hidden = true;
      return;
    }
    const name = hit.task < 0 ? 'Creating the frame’s jobs' : this.wl.tasks[hit.task].name;
    const what = { work: 'running', overhead: this.mode === 'threads' ? 'creating or switching threads' : 'taking, starting or resuming a job', blocked: 'blocked, waiting for its children', spin: 'waiting, with nothing to help with' }[hit.kind];
    this.tip.replaceChildren(h('b', {}, name), h('span', {}, `${what}, ${fmt(hit.start, 1)}–${fmt(hit.end, 1)} µs`), ...(hit.depth ? [h('span', {}, `${hit.depth} job${hit.depth > 1 ? 's' : ''} deep on this worker’s stack`)] : []));
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${Math.min(Math.max(0, px + 12), b.width - tw)}px`;
    this.tip.style.top = `${py + 14}px`;
  }

  private statsFor(r: WaitResult): void {
    const total = this.wl.tasks.reduce((a, t) => a + t.pre + t.post, 0);
    const ideal = total / this.cores;
    const n = this.wl.tasks.length;
    const mem = r.memoryKiB >= 1024 ? `${fmt(r.memoryKiB / 1024, 1)} MiB` : `${fmt(r.memoryKiB)} KiB`;
    const out = [
      r.deadlock ? stat('never', `the frame doesn't finish (${r.finished} of ${n} jobs ran)`) : stat(`${fmt(r.makespan)} µs`, 'until the frame’s last job ends'),
      stat(`${fmt(ideal)} µs`, 'perfect split of the work'),
    ];
    if (!r.deadlock) out.push(stat(`${fmt((ideal / r.makespan) * 100)}%`, 'efficiency'));
    if (this.mode === 'block') out.push(stat(`${fmt(r.blocked)} µs`, 'core time spent blocked'));
    out.push(stat(`${fmt(r.overhead)} µs`, this.mode === 'threads' ? 'creating and switching threads' : 'scheduling and switching'));
    if (this.mode === 'help') out.push(stat(String(r.maxDepth), 'deepest stack of nested jobs'), stat(`${fmt(r.lateMax)} µs`, 'longest a finished wait was kept waiting', 'From the moment a job’s children are all done, to the moment it can carry on: the job on top of it on the stack has to finish first.'));
    if (this.mode === 'fiber' || this.mode === 'coroutine' || this.mode === 'threads') out.push(stat(fmt(r.peakContexts), this.mode === 'threads' ? 'threads alive at once' : this.mode === 'fiber' ? 'fibers in use at once' : 'coroutine frames alive at once'));
    out.push(stat(mem, 'of stacks', `Pool threads at ${fmt(COSTS.block.stackKiB)} KiB each, plus ${this.mode === 'fiber' ? `${COSTS.fiber.stackKiB} KiB per fiber` : this.mode === 'coroutine' ? `about ${COSTS.coroutine.stackKiB} KiB per coroutine frame` : this.mode === 'threads' ? 'a 1 MiB stack per thread instead' : 'nothing else'}.`));
    this.stats.replaceChildren(...out);
  }
}

// ==========================================================================================
// 2. Named threads: a game thread and a render thread, pipelined

type Layout = 'one' | 'two' | 'three';

interface Block {
  lane: number;
  frame: number;
  /** What this block is, when one lane does more than one stage. */
  stage?: string;
  start: number;
  end: number;
}

/** Frames through game, render, (RHI) and GPU stages. Times in milliseconds. */
export function pipeline(layout: Layout, game: number, render: number, gpu: number, frames = 6): { blocks: Block[]; lanes: string[]; frameTime: number; latency: number; inFlight: number } {
  const rhi = layout === 'three' ? render * 0.35 : 0;
  const rnd = layout === 'three' ? render - rhi : render;
  const lanes = layout === 'one' ? ['Main thread', 'GPU'] : layout === 'two' ? ['Game thread', 'Render thread', 'GPU'] : ['Game thread', 'Render thread', 'RHI thread', 'GPU'];
  const blocks: Block[] = [];
  const gEnd: number[] = [];
  const rEnd: number[] = [];
  const xEnd: number[] = [];
  const pEnd: number[] = [];
  const gStart: number[] = [];
  for (let f = 0; f < frames; f++) {
    if (layout === 'one') {
      // Game then render on one thread; the GPU runs on its own, at most one frame behind.
      const s = Math.max(f ? rEnd[f - 1] : 0, f > 1 ? pEnd[f - 2] : 0);
      gStart[f] = s;
      gEnd[f] = s + game;
      rEnd[f] = gEnd[f] + render;
      blocks.push({ lane: 0, frame: f, start: s, end: gEnd[f], stage: 'game' }, { lane: 0, frame: f, start: gEnd[f], end: rEnd[f], stage: 'render' });
      const ps = Math.max(rEnd[f], f ? pEnd[f - 1] : 0);
      pEnd[f] = ps + gpu;
      blocks.push({ lane: 1, frame: f, start: ps, end: pEnd[f] });
      continue;
    }
    // The game thread may run at most one frame ahead of the render thread (as Unreal's does).
    const s = Math.max(f ? gEnd[f - 1] : 0, f > 1 ? rEnd[f - 2] : 0);
    gStart[f] = s;
    gEnd[f] = s + game;
    blocks.push({ lane: 0, frame: f, start: s, end: gEnd[f] });
    // ...and the render thread waits for the GPU to finish frame f - 2 (a fence), so frames can't pile up.
    const rs = Math.max(gEnd[f], f ? rEnd[f - 1] : 0, f > 1 ? pEnd[f - 2] : 0);
    rEnd[f] = rs + rnd;
    blocks.push({ lane: 1, frame: f, start: rs, end: rEnd[f] });
    let last = rEnd[f];
    if (layout === 'three') {
      const xs = Math.max(rEnd[f], f ? xEnd[f - 1] : 0);
      xEnd[f] = xs + rhi;
      blocks.push({ lane: 2, frame: f, start: xs, end: xEnd[f] });
      last = xEnd[f];
    }
    const ps = Math.max(last, f ? pEnd[f - 1] : 0);
    pEnd[f] = ps + gpu;
    blocks.push({ lane: lanes.length - 1, frame: f, start: ps, end: pEnd[f] });
  }
  const k = frames - 1;
  const frameTime = pEnd[k] - pEnd[k - 1];
  const latency = pEnd[k] - gStart[k];
  return { blocks, lanes, frameTime, latency, inFlight: latency / frameTime };
}

export class PipelineViz {
  private root: HTMLElement;
  private cnv = h('canvas', { class: 'jb-gantt', 'aria-label': 'Frame pipeline' }) as HTMLCanvasElement;
  private stats = h('div', { class: 'll-stats' });
  private layout: Layout = 'one';
  private game = 10;
  private render = 8;
  private gpu = 9;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll jb' });
    host.replaceChildren(this.root);
    const l = seg<Layout>(
      'Threads',
      [
        ['one', 'One thread does it all'],
        ['two', 'Game + render thread'],
        ['three', 'Game + render + RHI'],
      ],
      this.layout,
      (x) => ((this.layout = x), this.draw()),
    );
    const g = seg<string>('Game', ['6', '10', '14'].map((x) => [x, `${x} ms`] as [string, string]), String(this.game), (x) => ((this.game = Number(x)), this.draw()));
    const r = seg<string>('Render', ['4', '8', '12'].map((x) => [x, `${x} ms`] as [string, string]), String(this.render), (x) => ((this.render = Number(x)), this.draw()));
    const p = seg<string>('GPU', ['6', '9', '12'].map((x) => [x, `${x} ms`] as [string, string]), String(this.gpu), (x) => ((this.gpu = Number(x)), this.draw()));
    this.root.append(
      h('div', { class: 'll-row' }, l.el),
      h('div', { class: 'll-row' }, g.el, r.el, p.el),
      this.cnv,
      this.stats,
      h('p', { class: 'll-muted' }, 'Each block is one frame’s work on one thread, numbered by frame (on a single thread, G and R are its game and render halves). The same colour follows a frame down the pipeline. Worker threads are left out: both named threads hand their parallel work to the same pool.'),
    );
    new ResizeObserver(() => this.draw()).observe(this.root);
    onTheme(() => this.draw());
    this.draw();
  }

  private draw(): void {
    const res = pipeline(this.layout, this.game, this.render, this.gpu);
    const c = cols(this.root);
    const cnv = this.cnv;
    const dpr = window.devicePixelRatio || 1;
    const Wd = cnv.clientWidth || 800;
    const laneH = 24;
    const top = 6;
    const left = Math.min(108, Wd * 0.28);
    const Hh = top + res.lanes.length * laneH + 26;
    cnv.width = Math.round(Wd * dpr);
    cnv.height = Math.round(Hh * dpr);
    cnv.style.height = `${Hh}px`;
    const ctx = cnv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, Wd, Hh);
    // A fixed scale, so switching layouts shows the frames getting closer together.
    const span = 6 * (this.game + this.render + this.gpu);
    const width = Wd - left - 8;
    const x = (t: number) => left + (t / span) * width;
    ctx.font = `11px ${c.mono}`;
    ctx.textBaseline = 'middle';
    res.lanes.forEach((name, i) => {
      const y = top + i * laneH;
      ctx.fillStyle = c.paper;
      ctx.fillRect(left, y + 1, width, laneH - 2);
      ctx.fillStyle = c.muted;
      ctx.fillText(name, 4, y + laneH / 2, left - 8);
    });
    for (const b of res.blocks) {
      if (b.start > span) continue;
      const y = top + b.lane * laneH;
      const x0 = x(b.start);
      const w = Math.max(0.6, x(Math.min(b.end, span)) - x0 - 1);
      ctx.fillStyle = c.series[b.frame % c.series.length];
      ctx.globalAlpha = b.stage === 'render' ? 0.7 : 1;
      ctx.fillRect(x0, y + 2, w, laneH - 4);
      ctx.globalAlpha = 1;
      if (w > 14) {
        ctx.fillStyle = c.bg;
        const label = b.stage && w > 60 ? `${b.frame + 1} ${b.stage}` : b.stage && w > 24 ? `${b.frame + 1}${b.stage[0].toUpperCase()}` : String(b.frame + 1);
        ctx.fillText(label, x0 + 4, y + laneH / 2, w - 6);
      }
    }
    const axisY = top + res.lanes.length * laneH + 4;
    ctx.strokeStyle = c.soft;
    ctx.beginPath();
    ctx.moveTo(left, axisY);
    ctx.lineTo(Wd - 8, axisY);
    ctx.stroke();
    const step = niceStep(span / 6);
    ctx.fillStyle = c.muted;
    for (let t = 0; t <= span + 1e-6; t += step) {
      const xx = x(t);
      ctx.beginPath();
      ctx.moveTo(xx, axisY);
      ctx.lineTo(xx, axisY + 4);
      ctx.stroke();
      ctx.fillText(`${fmt(t)} ms`, Math.min(xx - 10, Wd - 50), axisY + 13);
    }
    this.stats.replaceChildren(
      stat(`${fmt(res.frameTime, 1)} ms`, 'between finished frames'),
      stat(`${fmt(1000 / res.frameTime)} fps`, 'frame rate'),
      stat(`${fmt(res.latency, 1)} ms`, 'from a frame’s game update to its pixels'),
      stat(fmt(res.inFlight, 1), 'frames in flight'),
    );
  }
}
