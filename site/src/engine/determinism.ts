import { h, seg, fmt } from './dom';

/** Small deterministic helpers shared by the determinism widgets. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A stateless hash of several integers to [0, 1): a counter-based random number. */
function hashRand(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h = Math.imul(h ^ (x >>> 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}
function checksum(xs: number[]): string {
  let h = 2166136261;
  for (const x of xs) {
    h ^= x >>> 0;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const f32 = Math.fround;
function f32hex(x: number): string {
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, x);
  return b.getUint32(0).toString(16).padStart(8, '0');
}
const stat = (v: string, l: string, title?: string) => h('div', { class: 'll-stat', title }, h('b', {}, v), h('span', {}, l));

// ---------------------------------------------------------------------------
// 1. Float addition order

export class FloatOrder {
  private root: HTMLElement;
  private values: number[] = [];
  private out!: HTMLElement;
  private shuffles: string[] = [];

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ll-det' });
    host.replaceChildren(this.root);
    const rnd = mulberry32(7);
    // 10,000 float32 values spanning many magnitudes, like positions, forces and tiny corrections.
    for (let i = 0; i < 10000; i++) this.values.push(f32((rnd() - 0.4) * Math.pow(10, Math.floor(rnd() * 8) - 3)));
    this.out = h('div', { class: 'det-sums' });
    this.root.append(
      h('div', { class: 'll-h' }, 'The same 10,000 floats, added up in different orders (32-bit float arithmetic)'),
      h('div', { class: 'll-row' }, h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.shuffle() }, 'Threads finish in a random order'), h('span', { class: 'll-muted' }, 'Each click sums in a new random order, like work handed out dynamically to threads that finish in whatever order the OS schedules them.')),
      this.out,
    );
    this.render();
  }

  private sum(order: number[]): number {
    let a = 0;
    for (const i of order) a = f32(a + this.values[i]);
    return a;
  }
  private chunked(k: number): number {
    const n = this.values.length;
    const parts: number[] = [];
    for (let c = 0; c < k; c++) {
      let a = 0;
      for (let i = Math.floor((c * n) / k); i < Math.floor(((c + 1) * n) / k); i++) a = f32(a + this.values[i]);
      parts.push(a);
    }
    return parts.reduce((x, y) => f32(x + y), 0);
  }
  private kahan(): number {
    let s = 0;
    let c = 0;
    for (const v of this.values) {
      const y = f32(v - c);
      const t = f32(s + y);
      c = f32(f32(t - s) - y);
      s = t;
    }
    return s;
  }

  private shuffle(): void {
    const idx = this.values.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const s = this.sum(idx);
    this.shuffles.unshift(`${s.toPrecision(9)}  (0x${f32hex(s)})`);
    this.shuffles = this.shuffles.slice(0, 5);
    this.render();
  }

  private render(): void {
    const n = this.values.length;
    const exact = this.values.reduce((a, b) => a + b, 0); // double precision reference
    const asc = this.values.map((_, i) => i).sort((a, b) => Math.abs(this.values[a]) - Math.abs(this.values[b]));
    const rows: Array<[string, number]> = [
      ['In array order', this.sum(this.values.map((_, i) => i))],
      ['Reversed', this.sum(this.values.map((_, i) => n - 1 - i))],
      ['Smallest magnitude first', this.sum(asc)],
      ['Largest magnitude first', this.sum([...asc].reverse())],
      ['4 threads, then combine', this.chunked(4)],
      ['8 threads, then combine', this.chunked(8)],
      ['Kahan (compensated) sum', this.kahan()],
    ];
    const first = rows[0][1];
    this.out.replaceChildren(
      h(
        'table',
        { class: 'det-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Order'), h('th', {}, 'Result'), h('th', {}, 'Bits'), h('th', {}, 'vs array order'))),
        h(
          'tbody',
          {},
          ...rows.map(([label, v]) =>
            h(
              'tr',
              { class: v === first ? '' : 'diff' },
              h('td', {}, label),
              h('td', { class: 'mono' }, v.toPrecision(9)),
              h('td', { class: 'mono' }, `0x${f32hex(v)}`),
              h('td', {}, v === first ? 'same bits' : `differs by ${(v - first).toPrecision(3)}`),
            ),
          ),
          h('tr', { class: 'ref' }, h('td', {}, 'Exact (64-bit reference)'), h('td', { class: 'mono' }, exact.toPrecision(9)), h('td', {}, ''), h('td', {}, '')),
        ),
      ),
      this.shuffles.length ? h('div', { class: 'det-shuf' }, h('div', { class: 'll-h' }, 'Random orders so far'), ...this.shuffles.map((s) => h('div', { class: 'mono' }, s))) : '',
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Random number streams

type RngMode = 'shared' | 'perThread' | 'counter';

export class RngStreams {
  private root: HTMLElement;
  private mode: RngMode = 'shared';
  private runs: Array<{ sum: string; order: string }> = [];
  private grid!: HTMLElement;
  private hist!: HTMLElement;
  private code!: HTMLElement;
  private last: number[] = [];
  private lastThread: number[] = [];

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ll-det' });
    host.replaceChildren(this.root);
    const s = seg<RngMode>(
      'Random numbers from',
      [
        ['shared', 'One shared generator'],
        ['perThread', 'A generator per thread'],
        ['counter', 'hash(seed, entity, tick)'],
      ],
      this.mode,
      (v) => {
        this.mode = v;
        this.runs = [];
        this.run();
      },
    );
    this.code = h('code', { class: 'll-code' });
    this.grid = h('div', { class: 'det-ents' });
    this.hist = h('div', { class: 'det-hist' });
    this.root.append(
      h('div', { class: 'll-row' }, s.el),
      this.code,
      h('div', { class: 'll-row' }, h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.run() }, 'Run the tick again'), h('span', { class: 'll-muted' }, '4 worker threads take 12 units each tick, in whatever order they get scheduled.')),
      this.grid,
      this.hist,
    );
    this.run();
  }

  private run(): void {
    const N = 12;
    const tick = 42;
    const seed = 1234;
    // Scheduling: work-stealing threads pick units in an order that changes every run.
    const order = Array.from({ length: N }, (_, i) => i);
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const thread = order.map((_, k) => k % 4); // which thread ran the k-th unit processed
    const shared = mulberry32(seed);
    const per = [0, 1, 2, 3].map((t) => mulberry32(seed + t * 977));
    const result = new Array<number>(N).fill(0);
    const ranOn = new Array<number>(N).fill(0);
    order.forEach((e, k) => {
      const t = thread[k];
      ranOn[e] = t;
      const r = this.mode === 'shared' ? shared() : this.mode === 'perThread' ? per[t]() : hashRand(seed, e, tick, 1);
      result[e] = Math.floor(r * 100);
    });
    this.last = result;
    this.lastThread = ranOn;
    this.code.textContent =
      this.mode === 'shared'
        ? 'int loot = rng.next() % 100;          // one generator, called in processing order'
        : this.mode === 'perThread'
          ? 'int loot = thread_rng[thread_id].next() % 100;   // per-thread generators'
          : 'int loot = hash(world_seed, entity_id, tick, LOOT) % 100;   // no state at all';
    this.runs.unshift({ sum: checksum(result), order: order.join(',') });
    this.runs = this.runs.slice(0, 6);
    this.render();
  }

  private render(): void {
    this.grid.replaceChildren(
      ...this.last.map((v, e) => h('div', { class: 'det-ent' }, h('span', { class: 'll-muted' }, `unit ${e}`), h('b', {}, String(v)), h('small', { class: 'll-muted' }, `thread ${this.lastThread[e]}`))),
    );
    const same = this.runs.every((r) => r.sum === this.runs[0].sum);
    this.hist.replaceChildren(
      h('div', { class: 'll-h' }, 'State checksum after each run'),
      ...this.runs.map((r, i) => h('div', { class: `mono${i ? ' old' : ''}` }, r.sum)),
      this.runs.length > 1 ? h('div', { class: same ? 'det-ok' : 'det-bad' }, same ? 'Identical every run: deterministic.' : 'Different runs, different results: the outcome depends on thread scheduling.') : '',
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Async work and deadlines

type Strategy = 'whenReady' | 'wallBudget' | 'fixedLatency' | 'workBudget';
interface Job {
  id: number;
  tick: number; // requested at
  units: number; // work it needs (deterministic)
}
interface Outcome {
  applied: number;
  stall: number;
  finishMs: number;
}

const TICK_MS = 1000 / 30;
const JOBS: Job[] = [
  { id: 1, tick: 1, units: 900 },
  { id: 2, tick: 2, units: 2600 },
  { id: 3, tick: 4, units: 400 },
  { id: 4, tick: 5, units: 3900 },
  { id: 5, tick: 7, units: 1500 },
  { id: 6, tick: 9, units: 700 },
];

export class Deadlines {
  private root: HTMLElement;
  private strategy: Strategy = 'whenReady';
  private latency = 2;
  private seeds = [1, 2];
  private out!: HTMLElement;
  private code!: HTMLElement;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ll-det' });
    host.replaceChildren(this.root);
    const s = seg<Strategy>(
      'Strategy',
      [
        ['whenReady', 'Apply when ready'],
        ['wallBudget', '4 ms budget per tick'],
        ['fixedLatency', 'Fixed latency, wait if late'],
        ['workBudget', 'Budget in work units'],
      ],
      this.strategy,
      (v) => {
        this.strategy = v;
        this.render();
      },
    );
    this.code = h('pre', { class: 'll-code' });
    this.out = h('div', { class: 'det-dl' });
    const k = seg<string>(
      'Latency K (fixed-latency mode)',
      ['1', '2', '3', '4', '6'].map((v) => [v, `${v} ticks`] as [string, string]),
      String(this.latency),
      (v) => {
        this.latency = Number(v);
        this.render();
      },
    );
    this.root.append(
      h('div', { class: 'll-row' }, s.el),
      h('div', { class: 'll-row' }, k.el),
      h(
        'div',
        { class: 'll-row' },
        h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.rerun() }, 'Run on two different machines'),
        h('span', { class: 'll-muted' }, 'Same requests, same work; only how fast each worker happens to go differs.'),
      ),
      this.code,
      this.out,
    );
    this.render();
  }

  private rerun(): void {
    this.seeds = [1 + Math.floor(Math.random() * 1e6), 1 + Math.floor(Math.random() * 1e6)];
    this.render();
  }

  /** Units per ms a worker manages for one job on one "machine" (varies with load, clocks, OS). */
  private speed(seed: number, job: number): number {
    return 60 * (0.45 + hashRand(seed, job) * 1.3);
  }

  private simulate(seed: number): Outcome[] {
    let stallTotal = 0;
    return JOBS.map((j) => {
      const sp = this.speed(seed, j.id);
      const queue = hashRand(seed, j.id, 7) * 6; // ms before a worker picks it up
      const start = j.tick * TICK_MS + stallTotal;
      const finishMs = start + queue + j.units / sp;
      let applied = 0;
      let stall = 0;
      if (this.strategy === 'whenReady') {
        applied = Math.ceil((finishMs - stallTotal) / TICK_MS);
      } else if (this.strategy === 'fixedLatency') {
        applied = j.tick + this.latency;
        const due = applied * TICK_MS + stallTotal;
        if (finishMs > due) {
          stall = finishMs - due;
          stallTotal += stall;
        }
      } else if (this.strategy === 'wallBudget') {
        // Work on the job for up to 4 ms of each tick: how many ticks depends on speed.
        applied = j.tick + Math.ceil(j.units / (sp * 4));
      } else {
        // Work 500 units per tick, whatever that costs in time: always the same ticks.
        applied = j.tick + Math.ceil(j.units / 500);
      }
      return { applied, stall, finishMs };
    });
  }

  private render(): void {
    this.code.textContent = {
      whenReady: `// Results land in the sim on the first tick after the worker finishes.
if (job.done()) apply(job.result);`,
      wallBudget: `// Each tick, spend up to 4 ms on the job (time-sliced by the clock).
auto until = clock() + 4ms;
while (clock() < until && !job.done()) job.step();`,
      fixedLatency: `// Requested at tick T, always applied at tick T + ${this.latency}.
// If the worker is late, the sim waits for it.
if (tick == job.due_tick) { job.wait(); apply(job.result); }`,
      workBudget: `// Each tick, do exactly 500 units of work (nodes expanded, cells flooded...),
// however long that takes on this machine.
job.step(500);
if (job.done()) apply(job.result);`,
    }[this.strategy];
    const a = this.simulate(this.seeds[0]);
    const b = this.simulate(this.seeds[1]);
    const same = a.every((x, i) => x.applied === b[i].applied);
    const stallA = a.reduce((s, x) => s + x.stall, 0);
    const stallB = b.reduce((s, x) => s + x.stall, 0);
    const maxTick = Math.max(...a.map((x) => x.applied), ...b.map((x) => x.applied), 12) + 1;
    const lane = (o: Outcome[], label: string) =>
      h(
        'div',
        { class: 'dl-lane' },
        h('div', { class: 'dl-label' }, label),
        h(
          'div',
          { class: 'dl-rows' },
          ...JOBS.map((j, i) =>
            h(
              'div',
              { class: 'dl-row' },
              h('span', { class: 'dl-j' }, `path ${j.id}`),
              h(
                'div',
                { class: 'dl-track', style: `--n:${maxTick}` },
                h('span', { class: 'dl-req', style: `--t:${j.tick}`, title: `requested at tick ${j.tick}` }),
                h('span', { class: 'dl-span', style: `--a:${j.tick};--b:${o[i].applied}` }),
                h('span', { class: `dl-app${o[i].applied !== (o === a ? b : a)[i].applied ? ' moved' : ''}`, style: `--t:${o[i].applied}`, title: `applied at tick ${o[i].applied}` }, String(o[i].applied)),
                o[i].stall > 0 ? h('span', { class: 'dl-stall', title: `the sim waited ${fmt(o[i].stall, 1)} ms` }, `waited ${fmt(o[i].stall, 0)} ms`) : null,
              ),
            ),
          ),
        ),
      );
    this.out.replaceChildren(
      lane(a, 'Machine A'),
      lane(b, 'Machine B'),
      h(
        'div',
        { class: 'll-stats' },
        stat(same ? 'yes' : 'no', 'same ticks on both machines'),
        stat(`${fmt(stallA, 0)} / ${fmt(stallB, 0)} ms`, 'sim stalled (A / B)'),
        stat(`${checksum(a.map((x) => x.applied))} / ${checksum(b.map((x) => x.applied))}`, 'state checksum (A / B)'),
      ),
      h('div', { class: same ? 'det-ok' : 'det-bad' }, same ? 'Deterministic: every result enters the simulation on the same tick on both machines.' : 'Not deterministic: the same request lands on different ticks depending on the machine, so the two simulations diverge.'),
    );
  }
}
