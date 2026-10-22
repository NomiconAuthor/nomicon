/** The profiling lesson's widget: profile a made-up game's frames four ways and read the result. */
import { fmt, h, seg } from './dom';
import { MODE_INFO, VSYNC, makeProfile, profile, truth, worstFrame, type ProfData, type ProfMode, type ProfResult } from './profsim';

function cols(el: Element) {
  const cs = getComputedStyle(el);
  const g = (n: string) => cs.getPropertyValue(n).trim() || '#888';
  return {
    bg: g('--bg'),
    paper: g('--paper'),
    soft: g('--line-soft'),
    line: g('--line'),
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

type View = 'tree' | 'flame' | 'functions';

const NOTES: Record<ProfMode, string> = {
  sample1:
    'A timer interrupts the thread about a thousand times a second and records which function it was in, and who called it. A function’s time is its number of samples times a millisecond: cheap to collect, nothing to add to your code, statistically right over many frames, and blind to anything shorter than a sample or to time the thread spent waiting.',
  sample8: 'The same at eight thousand samples a second: eight times the detail in the same time, eight times the data. Over one frame, it starts to see the small functions.',
  instrument:
    'Every function gets a probe at entry and exit that reads the clock, so times and call counts are exact. But each probe costs something on every call, and a function called 800 times a frame pays it 800 times: the cheapest functions look the most expensive.',
  zones:
    'A handful of named zones placed by hand around whole systems, the way Tracy, PIX markers or Unreal Insights work. Exact, almost free, and they see waits too. But they only know what you marked: below a zone, it’s one number.',
};

export class ProfilerViz {
  private root: HTMLElement;
  private chart = h('canvas', { class: 'pf-chart', 'aria-label': 'Frame times' }) as HTMLCanvasElement;
  private flame = h('canvas', { class: 'pf-flame', 'aria-label': 'Flame graph' }) as HTMLCanvasElement;
  private tableWrap = h('div', { class: 'pf-tablewrap' });
  private stats = h('div', { class: 'll-stats' });
  private note = h('p', { class: 'll-muted' });
  private tip = h('div', { class: 'wt-tip', hidden: true });
  private data: ProfData = makeProfile();
  private mode: ProfMode = 'sample1';
  private view: View = 'tree';
  private from = 0;
  private to = this.data.frames.length;
  private showTruth = false;
  private open = new Set<number>();
  private res!: ProfResult;
  private tru!: ReturnType<typeof truth>;
  private drag: number | null = null;
  private flameRects: Array<{ x: number; y: number; w: number; h: number; id: number }> = [];
  private frameSeg: ReturnType<typeof seg<'all' | 'worst' | 'pick'>>;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll jb pf' });
    host.replaceChildren(this.root);
    const m = seg<ProfMode>('Profile by', (Object.keys(MODE_INFO) as ProfMode[]).map((k) => [k, MODE_INFO[k].label]), this.mode, (x) => ((this.mode = x), this.run(true)));
    this.frameSeg = seg<'all' | 'worst' | 'pick'>(
      'Frames',
      [
        ['all', 'All 120'],
        ['worst', 'The worst frame'],
        ['pick', 'Drag on the chart'],
      ],
      'all',
      (x) => {
        if (x === 'all') ((this.from = 0), (this.to = this.data.frames.length));
        else if (x === 'worst') {
          const w = worstFrame(this.data);
          ((this.from = w), (this.to = w + 1));
        }
        this.run(true);
      },
    );
    const v = seg<View>(
      'View',
      [
        ['tree', 'Call tree'],
        ['flame', 'Flame graph'],
        ['functions', 'Functions by self time'],
      ],
      this.view,
      (x) => ((this.view = x), this.draw()),
    );
    const truthBox = h('input', { type: 'checkbox' }) as HTMLInputElement;
    truthBox.addEventListener('change', () => ((this.showTruth = truthBox.checked), this.draw()));
    const hot = h('button', { type: 'button', class: 'll-btn', onclick: () => (this.expandHot(), this.draw()) }, 'Expand hot path');
    this.root.append(
      h('div', { class: 'll-row' }, m.el),
      h('div', { class: 'll-row' }, this.frameSeg.el),
      h('div', { class: 'wt-wrap' }, this.chart),
      this.stats,
      h('div', { class: 'll-row' }, v.el, hot, h('label', { class: 'pf-check' }, truthBox, 'Show the true times')),
      h('div', { class: 'wt-wrap' }, this.tableWrap, this.flame, this.tip),
      this.note,
    );
    this.chart.addEventListener('pointerdown', (e) => {
      const f = this.frameAt(e);
      if (f < 0) return;
      this.drag = f;
      this.chart.setPointerCapture(e.pointerId);
      this.select(f, f);
    });
    this.chart.addEventListener('pointermove', (e) => {
      if (this.drag === null) return;
      const f = this.frameAt(e);
      if (f >= 0) this.select(this.drag, f);
    });
    this.chart.addEventListener('pointerup', () => (this.drag = null));
    this.flame.addEventListener('pointermove', (e) => this.flameHover(e));
    this.flame.addEventListener('pointerleave', () => (this.tip.hidden = true));
    new ResizeObserver(() => this.draw()).observe(this.root);
    onTheme(() => this.draw());
    this.run(true);
  }

  private select(a: number, b: number): void {
    this.from = Math.min(a, b);
    this.to = Math.max(a, b) + 1;
    this.frameSeg.set('pick');
    this.run(false);
  }

  private frameAt(e: PointerEvent): number {
    const b = this.chart.getBoundingClientRect();
    const left = 34;
    const x = e.clientX - b.left - left;
    const w = (b.width - left - 8) / this.data.frames.length;
    const f = Math.floor(x / w);
    return f >= 0 && f < this.data.frames.length ? f : -1;
  }

  private run(resetOpen: boolean): void {
    this.res = profile(this.data, this.from, this.to, this.mode);
    this.tru = truth(this.data, this.from, this.to);
    if (resetOpen) {
      this.open.clear();
      this.expandHot();
    }
    this.note.textContent = NOTES[this.mode];
    this.draw();
  }

  /** Open the path that follows the most expensive child at each level. */
  private expandHot(): void {
    const d = this.data;
    const roots = d.nodes.filter((n) => n.parent < 0 && this.res.visible[n.id]);
    let cur = roots.sort((a, b) => this.res.total[b.id] - this.res.total[a.id])[0];
    while (cur) {
      this.open.add(cur.id);
      const kids = cur.children.map((k) => d.nodes[k]).filter((k) => this.res.visible[k.id] && this.res.total[k.id] > 0);
      if (!kids.length) break;
      kids.sort((a, b) => this.res.total[b.id] - this.res.total[a.id]);
      // Only keep following while one child clearly dominates its siblings' share of the parent.
      cur = kids[0];
    }
  }

  private draw(): void {
    const c = cols(this.root);
    this.drawChart(c);
    this.statsFor();
    this.tableWrap.hidden = this.view === 'flame';
    this.flame.hidden = this.view !== 'flame';
    if (this.view === 'flame') this.drawFlame(c);
    else if (this.view === 'tree') this.drawTree();
    else this.drawFunctions();
  }

  // -------------------------------------------------------------------- the frame chart

  private drawChart(c: Cols): void {
    const cnv = this.chart;
    const dpr = window.devicePixelRatio || 1;
    const W = cnv.clientWidth || 800;
    const H = 130;
    cnv.width = Math.round(W * dpr);
    cnv.height = Math.round(H * dpr);
    cnv.style.height = `${H}px`;
    const ctx = cnv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    const left = 34;
    const top = 8;
    const bottom = H - 18;
    const maxMs = 2 * VSYNC + 4;
    const y = (ms: number) => bottom - (ms / maxMs) * (bottom - top);
    const n = this.data.frames.length;
    const bw = (W - left - 8) / n;
    ctx.font = `11px ${c.mono}`;
    ctx.textBaseline = 'middle';
    for (const ms of [VSYNC, 2 * VSYNC]) {
      ctx.strokeStyle = c.soft;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(left, y(ms));
      ctx.lineTo(W - 8, y(ms));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = c.muted;
      ctx.fillText(`${fmt(ms, 1)}`, 2, y(ms));
      ctx.fillText('ms', 2, y(ms) + 12);
    }
    this.data.frames.forEach((f, i) => {
      const x = left + i * bw;
      const sel = i >= this.from && i < this.to;
      ctx.globalAlpha = sel ? 1 : 0.35;
      ctx.fillStyle = f.cpu > VSYNC ? c.alert : c.accent;
      ctx.fillRect(x + 0.5, y(f.cpu), Math.max(1, bw - 1), bottom - y(f.cpu));
      ctx.fillStyle = c.soft;
      ctx.fillRect(x + 0.5, y(f.time), Math.max(1, bw - 1), y(f.cpu) - y(f.time));
      ctx.globalAlpha = 1;
    });
    ctx.fillStyle = c.muted;
    ctx.fillText(`frame 1`, left, H - 7);
    ctx.textAlign = 'right';
    ctx.fillText(`frame ${n}`, W - 8, H - 7);
    ctx.textAlign = 'left';
  }

  private statsFor(): void {
    const fr = this.data.frames.slice(this.from, this.to);
    const n = fr.length;
    const cpu = fr.reduce((a, f) => a + f.cpu, 0) / n;
    const worst = Math.max(...fr.map((f) => f.cpu));
    const late = fr.filter((f) => f.time > VSYNC + 1e-6).length;
    const r = this.res;
    const out = [
      stat(n === 1 ? `frame ${this.from + 1}` : `${n} frames`, 'selected'),
      stat(`${fmt(cpu, 2)} ms`, n === 1 ? 'of CPU work' : 'average CPU work per frame'),
    ];
    if (n > 1) out.push(stat(`${fmt(worst, 1)} ms`, 'worst frame'), stat(String(late), late === 1 ? 'frame missed vsync' : 'frames missed vsync'));
    if (r.calls) {
      let calls = 0;
      r.calls.forEach((x, i) => (calls += r.visible[i] ? x : 0));
      out.push(stat(fmt(calls / n), 'calls timed per frame'), stat(`+${fmt(r.overhead / n, 2)} ms`, 'per frame added by the probes'));
    } else out.push(stat(fmt(r.samples), 'samples'), stat(`${fmt(MODE_INFO[this.mode].interval!, 3)} ms`, 'per sample'));
    this.stats.replaceChildren(...out);
  }

  // -------------------------------------------------------------------- tables

  private grand(): number {
    let g = 0;
    for (const nd of this.data.nodes) if (nd.parent < 0 && this.res.visible[nd.id]) g += this.res.total[nd.id];
    return g || 1;
  }

  private headRow(cells: string[]): HTMLElement {
    return h('tr', {}, ...cells.map((t, i) => h('th', { class: i ? 'num' : '' }, t)));
  }

  private drawTree(): void {
    const d = this.data;
    const r = this.res;
    const n = this.to - this.from;
    const g = this.grand();
    const head = ['Function', 'Total ms', 'Total %', 'Self ms', 'Self %'];
    if (r.calls) head.push('Calls');
    if (this.showTruth) head.push('True total ms');
    const rows: HTMLElement[] = [this.headRow(head)];
    const add = (id: number, depth: number) => {
      const nd = d.nodes[id];
      if (!r.visible[id]) return;
      if (r.total[id] <= 0 && !(nd.wait && r.seesWaits)) return;
      const kids = nd.children.filter((k) => r.visible[k] && r.total[k] > 0).sort((a, b) => r.total[b] - r.total[a]);
      const isOpen = this.open.has(id);
      const toggle = kids.length
        ? h('button', { type: 'button', class: 'pf-tog', 'aria-expanded': String(isOpen), 'aria-label': isOpen ? 'Collapse' : 'Expand', onclick: () => (isOpen ? this.open.delete(id) : this.open.add(id), this.draw()) }, isOpen ? '▾' : '▸')
        : h('span', { class: 'pf-tog pf-leaf' });
      const cells = [
        h('td', { class: 'pf-name', style: `padding-left: ${4 + depth * 14}px` }, toggle, nd.name),
        h('td', { class: 'num' }, fmt(r.total[id] / n, 2)),
        h('td', { class: 'num' }, `${fmt((100 * r.total[id]) / g, 1)}%`),
        h('td', { class: 'num' }, fmt(r.self[id] / n, 2)),
        h('td', { class: 'num' }, `${fmt((100 * r.self[id]) / g, 1)}%`),
      ];
      if (r.calls) cells.push(h('td', { class: 'num' }, fmt(r.calls[id] / n, r.calls[id] / n < 10 && r.calls[id] % n ? 1 : 0)));
      if (this.showTruth) cells.push(h('td', { class: 'num pf-truth' }, fmt(this.tru.total[id] / n, 2)));
      rows.push(h('tr', { class: nd.wait ? 'pf-wait' : '' }, ...cells));
      if (isOpen) for (const k of kids) add(k, depth + 1);
    };
    const roots = d.nodes.filter((x) => x.parent < 0).sort((a, b) => r.total[b.id] - r.total[a.id]);
    for (const rt of roots) add(rt.id, 0);
    this.tableWrap.replaceChildren(h('table', { class: 'pf-table' }, h('tbody', {}, ...rows)), h('p', { class: 'pf-unit' }, 'Times are milliseconds per frame, averaged over the selected frames.'));
  }

  private drawFunctions(): void {
    const d = this.data;
    const r = this.res;
    const n = this.to - this.from;
    const g = this.grand();
    const head = ['Function', 'Self ms', 'Self %', 'Total ms'];
    if (r.calls) head.push('Calls');
    if (this.showTruth) head.push('True self ms');
    const ids = d.nodes.map((x) => x.id).filter((id) => r.visible[id] && r.self[id] > 0);
    ids.sort((a, b) => r.self[b] - r.self[a]);
    const rows = [this.headRow(head)];
    for (const id of ids) {
      const cells = [h('td', { class: 'pf-name' }, d.nodes[id].name), h('td', { class: 'num' }, fmt(r.self[id] / n, 2)), h('td', { class: 'num' }, `${fmt((100 * r.self[id]) / g, 1)}%`), h('td', { class: 'num' }, fmt(r.total[id] / n, 2))];
      if (r.calls) cells.push(h('td', { class: 'num' }, fmt(r.calls[id] / n, r.calls[id] / n < 10 && r.calls[id] % n ? 1 : 0)));
      if (this.showTruth) cells.push(h('td', { class: 'num pf-truth' }, fmt(this.tru.self[id] / n, 2)));
      rows.push(h('tr', { class: d.nodes[id].wait ? 'pf-wait' : '' }, ...cells));
    }
    this.tableWrap.replaceChildren(h('table', { class: 'pf-table' }, h('tbody', {}, ...rows)), h('p', { class: 'pf-unit' }, 'Times are milliseconds per frame, averaged over the selected frames.'));
  }

  // -------------------------------------------------------------------- flame graph

  private drawFlame(c: Cols): void {
    const d = this.data;
    const r = this.res;
    const cnv = this.flame;
    const dpr = window.devicePixelRatio || 1;
    const W = cnv.clientWidth || 800;
    const rowH = 22;
    const maxDepth = Math.max(...d.nodes.filter((x) => r.visible[x.id] && r.total[x.id] > 0).map((x) => x.depth));
    const H = (maxDepth + 1) * rowH + 8;
    cnv.width = Math.round(W * dpr);
    cnv.height = Math.round(H * dpr);
    cnv.style.height = `${H}px`;
    const ctx = cnv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.font = `11px ${c.mono}`;
    ctx.textBaseline = 'middle';
    this.flameRects = [];
    const g = this.grand();
    const scale = (W - 8) / g;
    // Colour by top-level system, so a system's callees share its colour.
    const sysOf = (id: number) => {
      let k = id;
      while (d.nodes[k].depth > 2 && d.nodes[k].parent >= 0) k = d.nodes[k].parent;
      return k;
    };
    const lay = (id: number, x: number) => {
      const nd = d.nodes[id];
      const w = r.total[id] * scale;
      if (w <= 0) return;
      const yy = 4 + nd.depth * rowH;
      ctx.fillStyle = nd.wait ? c.soft : nd.depth < 2 ? c.muted : c.series[sysOf(id) % c.series.length];
      ctx.fillRect(x, yy, Math.max(0.5, w - 1), rowH - 2);
      this.flameRects.push({ x, y: yy, w, h: rowH - 2, id });
      if (w > 40) {
        ctx.fillStyle = nd.wait ? c.ink : c.bg;
        ctx.fillText(nd.name, x + 4, yy + rowH / 2 - 1, w - 8);
      }
      let cx = x;
      const kids = nd.children.filter((k) => r.visible[k]).sort((a, b) => r.total[b] - r.total[a]);
      for (const k of kids) {
        lay(k, cx);
        cx += r.total[k] * scale;
      }
    };
    let x = 4;
    for (const rt of d.nodes.filter((n) => n.parent < 0 && r.visible[n.id]).sort((a, b) => r.total[b.id] - r.total[a.id])) {
      lay(rt.id, x);
      x += r.total[rt.id] * scale;
    }
  }

  private flameHover(e: PointerEvent): void {
    const b = this.flame.getBoundingClientRect();
    const px = e.clientX - b.left;
    const py = e.clientY - b.top;
    const hit = this.flameRects.find((q) => px >= q.x && px <= q.x + q.w && py >= q.y && py <= q.y + q.h);
    if (!hit) {
      this.tip.hidden = true;
      return;
    }
    const n = this.to - this.from;
    const r = this.res;
    const g = this.grand();
    this.tip.replaceChildren(
      h('b', {}, this.data.nodes[hit.id].name),
      h('span', {}, `total ${fmt(r.total[hit.id] / n, 2)} ms (${fmt((100 * r.total[hit.id]) / g, 1)}%), self ${fmt(r.self[hit.id] / n, 2)} ms`),
      ...(r.calls ? [h('span', {}, `${fmt(r.calls[hit.id] / n, 1)} calls per frame`)] : []),
    );
    this.tip.hidden = false;
    const wrap = this.flame.parentElement!.getBoundingClientRect();
    this.tip.style.left = `${Math.min(Math.max(0, e.clientX - wrap.left + 12), wrap.width - this.tip.offsetWidth)}px`;
    this.tip.style.top = `${e.clientY - wrap.top + 14}px`;
  }
}
