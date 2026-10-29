/**
 * Regions and chokes, recorded for playback in four stages:
 *   1. Euclidean distance transform (Felzenszwalb & Huttenlocher): a pass down every
 *      column, then a pass along every row, giving each free cell its distance to the
 *      nearest blocked cell.
 *   2. Sort the free cells widest first.
 *   3. Watershed flood (a priority flood): cells join in that order; each local maximum
 *      starts a region; where regions meet, they merge if the meeting point is about as
 *      wide as they are, and otherwise the meeting point is a choke.
 *   4. Traffic: sample shortest routes and count how many cross each choke.
 */
import { makeRng } from '../lab/core/rng';
import { dijkstra, distanceField } from './analysis';
import { EventTrace, type Caption, type Stat } from './playback';
import { BUILDING, KINDS, type TWorld } from './world';

interface Colours {
  get(name: string): string;
  rgba(name: string, a: number): string;
}

export interface TChoke {
  x: number;
  y: number;
  width: number;
  peakA: number;
  peakB: number;
  traffic: number;
}

type Ev =
  | { k: 'col'; x: number }
  | { k: 'row'; y: number }
  | { k: 'sort' }
  | { k: 'flood'; from: number; to: number }
  | { k: 'route'; source: number };

interface Decision {
  text: string;
  choke: boolean;
}

const N8: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const REGION_COLS = ['--u2', '--u3', '--u4', '--u5', '--u6', '--u7', '--cache', '--vehicle'];

export class ChokeTrace extends EventTrace<Ev> {
  private n: number;
  private free: Uint8Array;
  /** Vertical-only distance (after the column pass) and the final Euclidean distance. */
  private colDist: Float32Array;
  private clear: Float32Array;
  private order: number[] = [];
  private routes: number[][][] = [];
  // Replay state.
  private phase: Ev['k'] = 'col';
  private colsDone = -1;
  private rowsDone = -1;
  private floodTo = 0;
  private parent!: Int32Array;
  private owner!: Int32Array;
  private peak!: Float32Array;
  private births = 0;
  private merges = 0;
  chokes: TChoke[] = [];
  private seen = new Set<string>();
  private last: Decision | null = null;
  private traffic!: Float32Array;
  private routesShown = 0;
  private routeCount = 0;
  private curBatch: [number, number] = [0, 0];

  constructor(
    private t: TWorld,
    private col: Colours,
    readonly mode: 'move' | 'sight',
    readonly ratio: number,
    private minPeak = 2,
  ) {
    super();
    const n = (this.n = t.w * t.h);
    this.free = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.free[i] = mode === 'move' ? (KINDS[t.kind[i]].walk ? 1 : 0) : t.kind[i] === BUILDING ? 0 : 1;
    this.clear = distanceField(t.w, t.h, (i) => !this.free[i]);
    // Column pass: distance to the nearest blocked cell (or edge) in the same column.
    this.colDist = new Float32Array(n);
    for (let x = 0; x < t.w; x++) {
      let d = 0;
      for (let y = 0; y < t.h; y++) {
        d = this.free[y * t.w + x] ? d + 1 : 0;
        this.colDist[y * t.w + x] = d;
      }
      d = 0;
      for (let y = t.h - 1; y >= 0; y--) {
        d = this.free[y * t.w + x] ? d + 1 : 0;
        this.colDist[y * t.w + x] = Math.min(this.colDist[y * t.w + x], d);
      }
    }
    for (let i = 0; i < n; i++) if (this.free[i]) this.order.push(i);
    this.order.sort((a, b) => this.clear[b] - this.clear[a]);
    for (let x = 0; x < t.w; x++) this.events.push({ k: 'col', x });
    this.marks.push(this.events.length - 1);
    for (let y = 0; y < t.h; y++) this.events.push({ k: 'row', y });
    this.marks.push(this.events.length - 1);
    this.events.push({ k: 'sort' });
    this.marks.push(this.events.length - 1);
    const size = Math.max(1, Math.ceil(this.order.length / 220));
    for (let a = 0; a < this.order.length; a += size) this.events.push({ k: 'flood', from: a, to: Math.min(this.order.length, a + size) });
    this.marks.push(this.events.length - 1);
    if (mode === 'move') {
      // Routes for the traffic stage: 40 sources, 12 random destinations each.
      const walk: number[] = [];
      for (let i = 0; i < n; i++) if (KINDS[t.kind[i]].walk) walk.push(i);
      const rng = makeRng(5);
      for (let s = 0; s < 40 && walk.length > 1; s++) {
        const from = walk[Math.floor(rng() * walk.length)];
        const { dist, prev } = dijkstra(t, from);
        const rs: number[][] = [];
        for (let k = 0; k < 12; k++) {
          const to = walk[Math.floor(rng() * walk.length)];
          if (!Number.isFinite(dist[to])) continue;
          const p: number[] = [];
          for (let c = to; c >= 0; c = prev[c]) p.push(c);
          rs.push(p);
        }
        this.routes.push(rs);
        this.events.push({ k: 'route', source: s });
      }
      this.marks.push(this.events.length - 1);
    }
    this.reset();
  }

  protected reset(): void {
    this.phase = 'col';
    this.colsDone = -1;
    this.rowsDone = -1;
    this.floodTo = 0;
    this.parent = new Int32Array(this.n).fill(-1);
    this.owner = new Int32Array(this.n).fill(-1);
    this.peak = new Float32Array(this.n);
    this.births = 0;
    this.merges = 0;
    this.chokes = [];
    this.seen.clear();
    this.last = null;
    this.traffic = new Float32Array(this.n);
    this.routesShown = 0;
    this.routeCount = 0;
  }

  private find(i: number): number {
    const p = this.parent;
    while (p[i] !== i) {
      p[i] = p[p[i]];
      i = p[i];
    }
    return i;
  }

  private span(x: number, y: number): number {
    const t = this.t;
    const run = (dx: number, dy: number) => {
      let k = 0;
      for (;;) {
        const nx = x + dx * (k + 1);
        const ny = y + dy * (k + 1);
        if (nx < 0 || ny < 0 || nx >= t.w || ny >= t.h || !this.free[ny * t.w + nx]) return k;
        k++;
      }
    };
    return Math.min(1 + run(1, 0) + run(-1, 0), 1 + run(0, 1) + run(0, -1));
  }

  private floodCell(i: number): void {
    const t = this.t;
    const x = i % t.w;
    const y = (i - x) / t.w;
    const roots = new Set<number>();
    for (const [dx, dy] of N8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= t.w || ny >= t.h) continue;
      const j = ny * t.w + nx;
      if (this.owner[j] >= 0) roots.add(this.find(this.owner[j]));
    }
    const c = this.clear[i];
    if (!roots.size) {
      this.parent[i] = i;
      this.peak[i] = c;
      this.owner[i] = i;
      this.births++;
      if (c >= this.minPeak) this.last = { text: `A new region starts at a local maximum: a spot ${c.toFixed(1)} m from the nearest obstacle with no wider neighbour.`, choke: false };
      return;
    }
    const rs = [...roots].sort((a, b) => this.peak[b] - this.peak[a]);
    let main = rs[0];
    for (const r of rs.slice(1)) {
      const small = Math.min(this.peak[main], this.peak[r]);
      if (c < this.ratio * small && small >= this.minPeak) {
        const key = main < r ? `${main}|${r}` : `${r}|${main}`;
        const sp = this.span(x, y);
        if (sp / 2 < this.ratio * small + 0.5 && !this.chokes.some((k) => Math.abs(k.x - x) + Math.abs(k.y - y) < 8)) {
          this.chokes.push({ x, y, width: sp, peakA: this.peak[main], peakB: this.peak[r], traffic: 0 });
          this.last = {
            text: `Two regions met (their widest points ${this.peak[main].toFixed(1)} m and ${this.peak[r].toFixed(1)} m from obstacles) at a cell only ${c.toFixed(1)} m from one: below ${Math.round(this.ratio * 100)}% of ${small.toFixed(1)} m, so they stay separate and the opening, ${sp} m across, is a choke.`,
            choke: true,
          };
        }
        this.seen.add(key);
      } else {
        this.parent[r] = main;
        this.peak[main] = Math.max(this.peak[main], this.peak[r]);
        main = this.find(main);
        this.merges++;
        if (small >= this.minPeak)
          this.last = {
            text: `Two regions met at a cell ${c.toFixed(1)} m from obstacles, which is ${small < this.minPeak ? 'in a region too small to count' : `at least ${Math.round(this.ratio * 100)}% of the smaller region's ${small.toFixed(1)} m`}: they are really one space, so they merge.`,
            choke: false,
          };
      }
    }
    this.owner[i] = main;
  }

  protected apply(e: Ev): void {
    this.phase = e.k;
    if (e.k === 'col') this.colsDone = e.x;
    else if (e.k === 'row') this.rowsDone = e.y;
    else if (e.k === 'flood') {
      for (let a = e.from; a < e.to; a++) this.floodCell(this.order[a]);
      this.floodTo = e.to;
      this.curBatch = [e.from, e.to];
    } else if (e.k === 'route') {
      for (const r of this.routes[e.source]) for (const c of r) this.traffic[c]++;
      this.routeCount += this.routes[e.source].length;
      this.routesShown = e.source + 1;
      if (e.source === this.routes.length - 1) {
        let mx = 0;
        for (const ch of this.chokes) {
          let best = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const x = ch.x + dx;
              const y = ch.y + dy;
              if (x >= 0 && y >= 0 && x < this.t.w && y < this.t.h) best = Math.max(best, this.traffic[y * this.t.w + x]);
            }
          ch.traffic = best / Math.max(1, this.routeCount);
          mx = Math.max(mx, ch.traffic);
        }
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, cs: number): void {
    const t = this.t;
    const col = this.col;
    const W = t.w;
    if (this.phase === 'col' || this.phase === 'row') {
      let mx = 1;
      for (let i = 0; i < this.n; i++) if (this.free[i]) mx = Math.max(mx, this.clear[i]);
      for (let y = 0; y < t.h; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (!this.free[i]) continue;
          let v: number | null = null;
          if (this.phase === 'row' && y <= this.rowsDone) v = this.clear[i];
          else if (this.phase === 'row' || x <= this.colsDone) v = this.colDist[i];
          if (v === null) continue;
          ctx.fillStyle = col.rgba('--cache', Math.min(0.9, 0.08 + (v / mx) * 0.85));
          ctx.fillRect(x * cs, y * cs, cs, cs);
        }
      ctx.fillStyle = col.rgba('--walker', 0.35);
      if (this.phase === 'col' && this.colsDone < W - 1) ctx.fillRect(this.colsDone * cs, 0, cs, t.h * cs);
      if (this.phase === 'row' && this.rowsDone < t.h - 1) ctx.fillRect(0, this.rowsDone * cs, W * cs, cs);
      return;
    }
    // Flood state: processed cells tinted by region, the rest by clearance (dim).
    const colours = REGION_COLS.map((c) => c);
    const flooding = this.phase === 'flood' || this.phase === 'sort';
    let mx = 1;
    for (let i = 0; i < this.n; i++) if (this.free[i]) mx = Math.max(mx, this.clear[i]);
    const roots = new Map<number, number>();
    for (let i = 0; i < this.n; i++) {
      if (!this.free[i]) continue;
      const x = i % W;
      const y = (i - x) / W;
      if (this.owner[i] >= 0) {
        const r = this.find(this.owner[i]);
        if (!roots.has(r)) roots.set(r, roots.size);
        // Once traffic is shown, regions step back so the busy routes read first.
        ctx.fillStyle = col.rgba(colours[roots.get(r)! % colours.length], this.phase === 'route' && this.routesShown ? 0.16 : 0.4);
      } else ctx.fillStyle = col.rgba('--cache', 0.04 + (this.clear[i] / mx) * 0.25);
      ctx.fillRect(x * cs, y * cs, cs, cs);
    }
    if (flooding && this.phase === 'flood' && this.floodTo < this.order.length) {
      ctx.fillStyle = col.rgba('--ink', 0.85);
      for (let a = this.curBatch[0]; a < this.curBatch[1]; a++) {
        const i = this.order[a];
        ctx.fillRect((i % W) * cs + cs * 0.3, Math.floor(i / W) * cs + cs * 0.3, cs * 0.4, cs * 0.4);
      }
    }
    if (this.phase === 'route' && this.routesShown) {
      // Traffic heat, plus the latest source's routes.
      // Smoothed over 3×3 for display: individual sampled routes are noisy cell by cell,
      // and the point is the broad corridors. The faintest traffic isn't drawn at all.
      const sm = new Float32Array(this.n);
      let tm = 1e-6;
      for (let i = 0; i < this.n; i++) {
        if (!this.free[i]) continue;
        const x = i % W;
        const y = (i - x) / W;
        let s = 0;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= t.h) continue;
            const j = yy * W + xx;
            if (!this.free[j]) continue;
            s += this.traffic[j];
            k++;
          }
        sm[i] = s / k;
        tm = Math.max(tm, sm[i]);
      }
      for (let i = 0; i < this.n; i++) {
        const v = Math.sqrt(sm[i] / tm);
        if (v < 0.25) continue;
        ctx.fillStyle = col.rgba('--walker', Math.min(0.85, (v - 0.2) * 1.05));
        ctx.fillRect((i % W) * cs, Math.floor(i / W) * cs, cs, cs);
      }
      if (this.routesShown < this.routes.length) {
        ctx.strokeStyle = col.get('--ink');
        ctx.lineWidth = 1.5;
        for (const r of this.routes[this.routesShown - 1]) {
          ctx.beginPath();
          r.forEach((c, k) => {
            const x = ((c % W) + 0.5) * cs;
            const y = (Math.floor(c / W) + 0.5) * cs;
            if (k) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          });
          ctx.stroke();
        }
        ctx.lineWidth = 1;
      }
    }
    const done = this.at >= this.events.length - 1;
    const mxT = Math.max(0.01, ...this.chokes.map((c) => c.traffic));
    for (const c of this.chokes) {
      const busy = done && this.mode === 'move' ? c.traffic / mxT : 0.3;
      const a = done && this.mode === 'move' && busy < 0.15 ? 0.35 : 1;
      const x = (c.x + 0.5) * cs;
      const y = (c.y + 0.5) * cs;
      const r = Math.max(4, cs * (0.6 + busy * 1.6));
      ctx.globalAlpha = a;
      ctx.strokeStyle = col.get('--alert');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
      if (cs >= 6) {
        ctx.fillStyle = col.get('--ink');
        ctx.font = `600 ${Math.max(9, cs * 0.9)}px ${col.get('--f-mono')}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${c.width} m`, x + r + 3, y);
      }
      ctx.globalAlpha = 1;
    }
  }

  caption(): Caption {
    const what = this.mode === 'move' ? 'walk through' : 'see through';
    switch (this.phase) {
      case 'col':
        return {
          title: '1a. Distance transform, columns.',
          text: `Step one is a Euclidean distance transform (Felzenszwalb and Huttenlocher's algorithm): for every cell you can ${what}, the distance to the nearest cell you can't. It runs as two passes of a one-dimensional transform. This first pass goes down each column and finds the nearest blocked cell above or below.`,
        };
      case 'row':
        return {
          title: '1b. Distance transform, rows.',
          text: 'The second pass runs along each row, combining each cell with the column results of its neighbours to get the true straight-line distance. Two linear passes give the exact answer for the whole map. Bright cells are far from any obstacle; ridges of bright cells run down the middle of corridors.',
        };
      case 'sort':
        return { title: '2. Sort widest first.', text: `Put all ${this.order.length.toLocaleString()} free cells in order of distance, widest first. The flood will add them in this order, so regions grow outwards from the middles of open spaces and meet last at the narrowest places.` };
      case 'flood':
        return {
          title: `3. Watershed flood: ${Math.round((this.floodTo / this.order.length) * 100)}% of cells added.`,
          text: `Cells join in order (the latest batch is dotted). A cell with no flooded neighbour starts a region; otherwise it joins its neighbours' region. ${this.last ? this.last.text : ''} So far: ${this.births} regions started, ${this.merges} merged away, ${this.chokes.length} ${this.chokes.length === 1 ? 'choke' : 'chokes'}. Recast's watershed partitioning floods in the same order but merges regions by size, so its regions aren't chokes.`,
        };
      case 'route':
        return {
          title: `4. Traffic: ${this.routeCount} routes sampled.`,
          text: `A choke matters if routes have to use it. Sample shortest routes (40 Dijkstra searches, up to 12 random destinations each; the latest search's routes are drawn) and count how many pass each cell: a rough sampled betweenness centrality. At the end, each choke's circle is sized by the share of routes through it, and chokes almost nothing uses are drawn faintly.`,
        };
    }
  }

  stats(): Stat[] {
    const done = this.at >= this.events.length - 1;
    const top = [...this.chokes].sort((a, b) => b.traffic - a.traffic)[0];
    return [
      [String(this.births), 'regions started'],
      [String(this.births - this.merges), 'regions after merging'],
      [String(this.chokes.length), 'chokes found'],
      [done && top && this.mode === 'move' ? `${top.width} m, ${Math.round(top.traffic * 100)}%` : '–', 'busiest choke, share of routes'],
    ];
  }
}
