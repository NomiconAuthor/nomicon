/** Widgets for the jobs and task graphs lesson: a parallel-for, and a frame as a task graph. */
import { fmt, h, seg } from './dom';
import { FRAME, criticalPath, frameJobs, itemCosts, parallelFor, simulate, type GraphMode, type Job, type Policy, type SimResult } from './jobsim';

function cols(el: Element) {
  const cs = getComputedStyle(el);
  const g = (n: string) => cs.getPropertyValue(n).trim() || '#888';
  return {
    bg: g('--bg'),
    paper: g('--paper'),
    line: g('--line'),
    soft: g('--line-soft'),
    ink: g('--ink'),
    muted: g('--muted'),
    accent: g('--accent'),
    warn: g('--warn'),
    alert: g('--alert'),
    good: g('--good'),
    mono: g('--f-mono'),
    series: ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8', '--accent', '--warn'].map(g),
  };
}
type Cols = ReturnType<typeof cols>;

const onTheme = (fn: () => void) => new MutationObserver(fn).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

/** Workers as lanes, time left to right; each job a block coloured by its group. */
function drawGantt(cnv: HTMLCanvasElement, c: Cols, jobs: Job[], r: SimResult, workers: number, opts: { scaleTo?: number; colourOf?: (j: Job) => string; label?: (j: Job) => string; highlight?: Set<number> } = {}): void {
  const dpr = window.devicePixelRatio || 1;
  const W = cnv.clientWidth || 800;
  const laneH = workers > 8 ? 14 : 22;
  const top = 6;
  const H = top + workers * laneH + 26;
  cnv.width = Math.round(W * dpr);
  cnv.height = Math.round(H * dpr);
  cnv.style.height = `${H}px`;
  const ctx = cnv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, W, H);
  const left = 34;
  const span = Math.max(1, opts.scaleTo ?? r.makespan);
  const x = (t: number) => left + (t / span) * (W - left - 8);
  ctx.font = `11px ${c.mono}`;
  ctx.textBaseline = 'middle';
  for (let w = 0; w < workers; w++) {
    const y = top + w * laneH;
    ctx.fillStyle = c.paper;
    ctx.fillRect(left, y + 1, W - left - 8, laneH - 2);
    ctx.fillStyle = c.muted;
    ctx.fillText(`T${w}`, 4, y + laneH / 2);
  }
  for (const s of r.spans) {
    const j = jobs[s.job];
    const y = top + s.worker * laneH;
    const x0 = x(s.start);
    const xo = x(s.start + s.overhead);
    const x1 = x(s.end);
    // Scheduling overhead first, in red, then the work.
    if (xo - x0 > 0.3) {
      ctx.fillStyle = c.alert;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(x0, y + 2, xo - x0, laneH - 4);
    }
    ctx.globalAlpha = opts.highlight && !opts.highlight.has(j.group) ? 0.45 : 1;
    ctx.fillStyle = opts.colourOf ? opts.colourOf(j) : c.series[j.group % c.series.length];
    ctx.fillRect(xo, y + 2, Math.max(0.6, x1 - xo - 0.5), laneH - 4);
    ctx.globalAlpha = 1;
    if (opts.label && x1 - xo > 60 && laneH >= 20) {
      ctx.fillStyle = c.bg;
      ctx.fillText(opts.label(j), xo + 4, y + laneH / 2, x1 - xo - 8);
    }
  }
  // Time axis.
  const axisY = top + workers * laneH + 4;
  ctx.strokeStyle = c.soft;
  ctx.beginPath();
  ctx.moveTo(left, axisY);
  ctx.lineTo(W - 8, axisY);
  ctx.stroke();
  const step = niceStep(span / 6);
  ctx.fillStyle = c.muted;
  for (let t = 0; t <= span + 1e-6; t += step) {
    const xx = x(t);
    ctx.beginPath();
    ctx.moveTo(xx, axisY);
    ctx.lineTo(xx, axisY + 4);
    ctx.stroke();
    ctx.fillText(`${fmt(t)} µs`, Math.min(xx - 10, W - 60), axisY + 13);
  }
  // Where this run ended, when the scale is shared with another run.
  if (opts.scaleTo && opts.scaleTo > r.makespan) {
    ctx.strokeStyle = c.ink;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x(r.makespan), top);
    ctx.lineTo(x(r.makespan), axisY);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}
const stat = (v: string, l: string, title?: string) => h('div', { class: 'll-stat', title }, h('b', {}, v), h('span', {}, l));

// ==========================================================================================
// 1. A parallel-for over uneven items

export class ParallelForViz {
  private root: HTMLElement;
  private cnv = h('canvas', { class: 'jb-gantt', 'aria-label': 'Worker timeline' }) as HTMLCanvasElement;
  private stats = h('div', { class: 'll-stats' });
  private merge = h('div', { class: 'jb-merge' });
  private workers = 8;
  private policy: Policy = 'steal';
  private chunk = 8;
  private costs = itemCosts();
  private values: Float32Array;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll jb' });
    host.replaceChildren(this.root);
    // Values to add up: wide magnitudes, so float addition order shows.
    const v = new Float32Array(this.costs.length);
    let s = 12345;
    for (let i = 0; i < v.length; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      v[i] = Math.fround(((s / 4294967296) * 2 - 1) * Math.pow(10, (s % 9) - 3));
    }
    this.values = v;
    const pol = seg<Policy>(
      'Scheduling',
      [
        ['static', 'Static split'],
        ['queue', 'One shared queue'],
        ['steal', 'Work stealing'],
      ],
      this.policy,
      (x) => ((this.policy = x), this.run()),
    );
    const wk = seg<string>('Workers', ['1', '2', '4', '8', '16'].map((x) => [x, x] as [string, string]), String(this.workers), (x) => ((this.workers = Number(x)), this.run()));
    const ch = seg<string>('Items per job', ['1', '8', '64', '256'].map((x) => [x, x] as [string, string]), String(this.chunk), (x) => ((this.chunk = Number(x)), this.run()));
    this.root.append(
      h('div', { class: 'll-row' }, pol.el),
      h('div', { class: 'll-row' }, wk.el, ch.el),
      this.cnv,
      this.stats,
      h('p', { class: 'll-muted' }, 'Each lane is a worker thread; each block is one job, coloured by which slice of the items it covers (the warm colours are the expensive cluster). Red slivers are scheduling overhead: taking a job from a queue, or stealing one.'),
      this.merge,
    );
    new ResizeObserver(() => this.run()).observe(this.root);
    onTheme(() => this.run());
  }

  private run(): void {
    const jobs = parallelFor(this.costs, this.chunk);
    const r = simulate(jobs, { workers: this.workers, policy: this.policy });
    const c = cols(this.root);
    const total = this.costs.reduce((a, b) => a + b, 0);
    const heavyLo = Math.floor(200 / this.chunk);
    const heavyHi = Math.floor(519 / this.chunk);
    drawGantt(this.cnv, c, jobs, r, this.workers, { colourOf: (j) => (j.chunk >= heavyLo && j.chunk <= heavyHi ? c.warn : c.accent) });
    const ideal = total / this.workers;
    this.stats.replaceChildren(
      stat(`${fmt(r.makespan)} µs`, 'until the last job ends'),
      stat(`${fmt(ideal)} µs`, 'perfect split of the work'),
      stat(`${fmt((ideal / r.makespan) * 100)}%`, 'efficiency'),
      stat(`${fmt(r.overhead)} µs`, 'spent scheduling'),
      ...(this.policy === 'steal' ? [stat(fmt(r.steals), 'steals')] : []),
      stat(fmt(jobs.length), 'jobs'),
    );
    this.mergeDemo(jobs);
  }

  /** Add up a value per item in parallel, merging the per-job partial sums two ways. */
  private mergeDemo(jobs: Job[]): void {
    const partial = jobs.map((j) => {
      let s = 0;
      for (let i = j.chunk * this.chunk; i < Math.min(this.values.length, (j.chunk + 1) * this.chunk); i++) s = Math.fround(s + this.values[i]);
      return s;
    });
    const sumIn = (order: number[]) => order.reduce((a, k) => Math.fround(a + partial[k]), 0);
    const hex = (f: number) => {
      const b = new DataView(new ArrayBuffer(4));
      b.setFloat32(0, f);
      return b.getUint32(0).toString(16).padStart(8, '0');
    };
    const runs = [1, 2, 3].map((seed) => {
      // The same work, but each run's timings wobble a little (other programs, turbo, cache misses).
      const jittered = jobs.map((j, i) => ({ ...j, cost: j.cost * (0.8 + 0.4 * frac(Math.sin((i + 1) * 12.9898 * seed) * 43758.5453)) }));
      const r = simulate(jittered, { workers: this.workers, policy: this.policy, seed });
      const byFinish = jobs.map((j) => j.id).sort((a, b) => r.done[a] - r.done[b]);
      return { finish: sumIn(byFinish), fixed: sumIn(jobs.map((j) => j.id)) };
    });
    const cell = (f: number, same: boolean) => h('td', { class: `mono ${same ? 'jb-same' : 'jb-diff'}` }, `${f.toPrecision(9)} (0x${hex(f)})`);
    const finishSame = runs.every((x) => x.finish === runs[0].finish);
    this.merge.replaceChildren(
      h('div', { class: 'll-h' }, 'Adding up one float per item, three runs with slightly different timings'),
      h(
        'div',
        { class: 'det-sums' },
        h(
          'table',
          { class: 'det-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Merge partial sums'), h('th', {}, 'Run 1'), h('th', {}, 'Run 2'), h('th', {}, 'Run 3'))),
          h(
            'tbody',
            {},
            h('tr', {}, h('td', {}, 'as jobs finish'), ...runs.map((x) => cell(x.finish, finishSame))),
            h('tr', {}, h('td', {}, 'in job order'), ...runs.map((x) => cell(x.fixed, true))),
          ),
        ),
      ),
      h('p', { class: 'll-muted' }, finishSame ? 'With these settings the finishing order happened to match every time. Try more workers or smaller jobs.' : 'Same items, same jobs, different totals: float addition depends on order, and the order jobs finish in depends on timing.'),
    );
  }
}
const frac = (x: number) => x - Math.floor(x);

// ==========================================================================================
// 2. A frame of systems: in order, with barriers, or as a task graph

export class TaskGraphViz {
  private root: HTMLElement;
  private graph = h('canvas', { class: 'jb-graph', 'aria-label': 'System dependency graph' }) as HTMLCanvasElement;
  private cnv = h('canvas', { class: 'jb-gantt', 'aria-label': 'Worker timeline for one frame' }) as HTMLCanvasElement;
  private stats = h('div', { class: 'll-stats' });
  private note = h('p', { class: 'll-muted' });
  private keys = h('div', { class: 'jb-keys' });
  private workers = 8;
  private mode: GraphMode = 'graph';

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll jb' });
    host.replaceChildren(this.root);
    const m = seg<GraphMode>(
      'Run the frame',
      [
        ['serial', 'One thread'],
        ['barriers', 'System by system'],
        ['graph', 'Task graph'],
        ['deferred', 'Task graph, paths read next frame'],
      ],
      this.mode,
      (x) => ((this.mode = x), this.run()),
    );
    const wk = seg<string>('Workers', ['2', '4', '8', '16'].map((x) => [x, x] as [string, string]), String(this.workers), (x) => ((this.workers = Number(x)), this.run()));
    this.root.append(h('div', { class: 'll-row' }, m.el), h('div', { class: 'll-row' }, wk.el), this.graph, this.keys, this.cnv, this.stats, this.note);
    new ResizeObserver(() => this.run()).observe(this.root);
    onTheme(() => this.run());
  }

  private run(): void {
    const c = cols(this.root);
    const W = this.mode === 'serial' ? 1 : this.workers;
    const { jobs, deps } = frameJobs(FRAME, this.mode, W);
    const r = simulate(jobs, { workers: W, policy: 'steal' });
    const serial = FRAME.reduce((a, s) => a + s.cost, 0);
    const cp = criticalPath(FRAME, deps);
    this.drawGraph(c, deps, new Set(cp.path));
    // Shared scale with the one-thread run would squash everything; use this run's own.
    drawGantt(this.cnv, c, jobs, r, W, { label: (j) => FRAME[j.group].name });
    this.keys.replaceChildren(...FRAME.map((s, i) => h('span', { class: 'jb-key', style: `--k: ${c.series[i % c.series.length]}` }, s.name)));
    this.stats.replaceChildren(
      stat(`${fmt(r.makespan)} µs`, 'frame'),
      stat(`×${fmt(serial / r.makespan, 1)}`, 'faster than one thread'),
      stat(`${fmt((r.work / (r.makespan * W)) * 100)}%`, 'of worker time busy'),
      stat(cp.path.map((i) => FRAME[i].name).join(' → '), 'longest chain (highlighted)'),
    );
    this.note.textContent = {
      serial: 'Every system in order on one thread: the baseline.',
      barriers: 'Each system is split across the workers, but the next system waits for all of them to finish. Serial systems (Input, Audio) leave every other worker idle, and so do the tails of uneven systems.',
      graph: 'Systems start as soon as the data they read is ready, so independent ones overlap: Scripts run at the very start, and Animation, Audio and Render prep fill the gaps around the spatial index and the path queries. The frame is now bounded by the longest chain of dependencies, not the sum of every system.',
      deferred: 'Decide reads last frame\'s path results instead of waiting for this frame\'s, so the path queries only have to finish by the end of the frame. One frame more latency for new paths, and a shorter critical path. It stays deterministic because the delay is fixed, not "whenever the queries happen to finish".',
    }[this.mode];
  }

  /** Systems as boxes in columns by dependency depth, edges from what each one waits for. */
  private drawGraph(c: Cols, deps: number[][], hot: Set<number>): void {
    const dpr = window.devicePixelRatio || 1;
    const Wpx = this.graph.clientWidth || 800;
    const depth: number[] = [];
    FRAME.forEach((_, i) => (depth[i] = deps[i].length ? Math.max(...deps[i].map((d) => depth[d] + 1)) : 0));
    const cols2 = Math.max(...depth) + 1;
    const rows: number[] = new Array(cols2).fill(0);
    const pos = FRAME.map((_, i) => ({ col: depth[i], row: rows[depth[i]]++ }));
    const maxRows = Math.max(...rows);
    const bw = Math.min(130, (Wpx - 20) / cols2 - 18);
    const bh = 26;
    const H = 16 + maxRows * (bh + 12);
    this.graph.width = Math.round(Wpx * dpr);
    this.graph.height = Math.round(H * dpr);
    this.graph.style.height = `${H}px`;
    const ctx = this.graph.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, Wpx, H);
    const gap = (Wpx - 20 - cols2 * bw) / Math.max(1, cols2 - 1);
    const at = (i: number) => ({ x: 10 + pos[i].col * (bw + gap), y: 8 + pos[i].row * (bh + 12) });
    ctx.lineWidth = 1.5;
    FRAME.forEach((_, i) => {
      for (const d of deps[i]) {
        const a = at(d);
        const b = at(i);
        const onPath = hot.has(d) && hot.has(i);
        ctx.strokeStyle = onPath ? c.warn : c.line;
        ctx.beginPath();
        ctx.moveTo(a.x + bw, a.y + bh / 2);
        ctx.bezierCurveTo(a.x + bw + gap / 2, a.y + bh / 2, b.x - gap / 2, b.y + bh / 2, b.x, b.y + bh / 2);
        ctx.stroke();
      }
    });
    ctx.font = `12px ${c.mono}`;
    ctx.textBaseline = 'middle';
    FRAME.forEach((s, i) => {
      const p = at(i);
      ctx.fillStyle = c.series[i % c.series.length];
      ctx.globalAlpha = 0.9;
      ctx.fillRect(p.x, p.y, bw, bh);
      ctx.globalAlpha = 1;
      if (hot.has(i)) {
        ctx.strokeStyle = c.warn;
        ctx.lineWidth = 2;
        ctx.strokeRect(p.x - 1, p.y - 1, bw + 2, bh + 2);
        ctx.lineWidth = 1.5;
      }
      ctx.fillStyle = c.bg;
      ctx.fillText(`${s.name}${s.parallel ? '' : ' ·1'}`, p.x + 6, p.y + bh / 2, bw - 10);
    });
  }
}
