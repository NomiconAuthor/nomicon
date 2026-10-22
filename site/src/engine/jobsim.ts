/**
 * A small discrete-event model of a job system: W worker threads running a graph of
 * jobs under one of three scheduling policies. Times are in microseconds of simulated
 * work, not measured, so results are the same on every machine. Pure, no DOM, so the
 * lesson's numbers can be checked headlessly (test/jobs-batch.ts).
 */

export type Policy = 'static' | 'queue' | 'steal';

export interface Job {
  id: number;
  /** Which group (system, or parallel-for) it belongs to, for colour and stats. */
  group: number;
  /** Chunk index within its group (static assignment and merge order use it). */
  chunk: number;
  chunks: number;
  cost: number;
  /** Zero-cost synchronisation node: completes as soon as its dependencies do, on no worker. */
  sync?: boolean;
  deps: number[];
}

export interface Span {
  job: number;
  worker: number;
  start: number;
  end: number;
  /** Scheduling overhead paid before the work, included in start..end. */
  overhead: number;
}

export interface SimResult {
  spans: Span[];
  makespan: number;
  work: number;
  overhead: number;
  idle: number;
  steals: number;
  /** Completion time of every job, by id. */
  done: number[];
}

export interface SimOptions {
  workers: number;
  policy: Policy;
  /** Cost of taking a job from your own queue (µs). */
  popCost?: number;
  /** Cost of a successful steal (µs). */
  stealCost?: number;
  /** Shared queue: base cost plus contention per extra worker (µs). */
  queueCost?: number;
  queueContention?: number;
  /** Seed for victim choice. */
  seed?: number;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulate(jobs: Job[], o: SimOptions): SimResult {
  const W = Math.max(1, o.workers);
  const popCost = o.popCost ?? 0.1;
  const stealCost = o.stealCost ?? 1.2;
  const queueCost = (o.queueCost ?? 0.25) + (o.queueContention ?? 0.12) * (W - 1);
  const rand = rng(o.seed ?? 1);
  const n = jobs.length;
  const pending = jobs.map((j) => j.deps.length);
  const children: number[][] = jobs.map(() => []);
  for (const j of jobs) for (const d of j.deps) children[d].push(j.id);
  const done = new Array<number>(n).fill(-1);
  const spans: Span[] = [];
  // Ready jobs: per-worker deques (static, steal) or one shared FIFO (queue).
  const deques: number[][] = Array.from({ length: W }, () => []);
  const shared: number[] = [];
  const homeOf = (j: Job) => Math.min(W - 1, Math.floor((j.chunk * W) / Math.max(1, j.chunks)));
  let rr = 0;
  const makeReady = (id: number, t: number, by: number) => {
    const j = jobs[id];
    if (j.sync) {
      complete(id, t);
      return;
    }
    if (o.policy === 'queue') shared.push(id);
    else if (o.policy === 'static') deques[homeOf(j)].push(id);
    else {
      // Work stealing: a group's chunks start spread across the workers (like a static split);
      // a job made ready by a finishing job goes to the worker that finished it.
      const w = j.chunks > 1 ? homeOf(j) : by >= 0 ? by : rr++ % W;
      deques[w].push(id);
    }
  };
  // Completions in time order.
  const running: Array<{ id: number; end: number; worker: number }> = [];
  const complete = (id: number, t: number, worker = -1) => {
    done[id] = t;
    for (const c of children[id]) if (--pending[c] === 0) makeReady(c, t, worker);
  };
  for (const j of jobs) if (pending[j.id] === 0) makeReady(j.id, 0, -1);

  const freeAt = new Array<number>(W).fill(0);
  let steals = 0;
  let overhead = 0;
  let work = 0;
  let finished = 0;
  const total = jobs.filter((j) => !j.sync).length;
  const flush = (upTo: number) => {
    running.sort((a, b) => a.end - b.end);
    while (running.length && running[0].end <= upTo) {
      const r = running.shift()!;
      complete(r.id, r.end, r.worker);
    }
  };
  let guard = 0;
  while (finished < total && guard++ < 10_000_000) {
    // The worker that becomes free first acts next.
    let w = 0;
    for (let k = 1; k < W; k++) if (freeAt[k] < freeAt[w]) w = k;
    const t = freeAt[w];
    flush(t);
    let id: number | undefined;
    let ov = 0;
    if (o.policy === 'queue') {
      id = shared.shift();
      ov = queueCost;
    } else {
      id = deques[w].pop(); // own work, newest first
      ov = popCost;
      if (id === undefined && o.policy === 'steal') {
        // Try victims in a random order; steal the oldest job from the first with work.
        const start = Math.floor(rand() * W);
        for (let k = 0; k < W && id === undefined; k++) {
          const v = (start + k) % W;
          if (v !== w && deques[v].length) id = deques[v].shift();
        }
        if (id !== undefined) {
          steals++;
          ov = stealCost;
        }
      }
    }
    if (id === undefined) {
      // Nothing to do: sleep until the next job finishes somewhere (it may release work).
      const next = running.length ? Math.min(...running.map((r) => r.end)) : Infinity;
      if (next === Infinity) {
        // Every other worker is idle too, and nothing is queued for this one (static).
        const anyQueued = deques.some((d) => d.length) || shared.length;
        if (!anyQueued) break;
        freeAt[w] = Math.min(...freeAt.filter((_, k) => k !== w && deques[k].length).concat([t + 1]));
        if (freeAt[w] <= t) freeAt[w] = t + 1e-3;
        continue;
      }
      freeAt[w] = Math.max(next, t + 1e-6);
      continue;
    }
    const j = jobs[id];
    const end = t + ov + j.cost;
    spans.push({ job: id, worker: w, start: t, end, overhead: ov });
    running.push({ id, end, worker: w });
    overhead += ov;
    work += j.cost;
    freeAt[w] = end;
    finished++;
  }
  flush(Infinity);
  const makespan = Math.max(0, ...done);
  return { spans, makespan, work, overhead, idle: makespan * W - work - overhead, steals, done };
}

// ------------------------------------------------------------------------------------------
// Workloads

/** Items for a parallel-for: mostly cheap, with an expensive cluster (a crowded part of the map). */
export function itemCosts(n = 2048, seed = 3): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const heavy = i >= 200 && i < 520;
    return (heavy ? 9 : 1) * (0.6 + r() * 0.8);
  });
}

/** One parallel-for as jobs: items split into chunks of `chunk`. */
export function parallelFor(costs: number[], chunk: number, group = 0, deps: number[] = [], firstId = 0): Job[] {
  const chunks = Math.ceil(costs.length / chunk);
  const out: Job[] = [];
  for (let c = 0; c < chunks; c++) {
    let cost = 0;
    for (let i = c * chunk; i < Math.min(costs.length, (c + 1) * chunk); i++) cost += costs[i];
    out.push({ id: firstId + c, group, chunk: c, chunks, cost, deps: [...deps] });
  }
  return out;
}

export interface SystemSpec {
  name: string;
  cost: number;
  parallel: boolean;
  reads: string[];
  writes: string[];
}

/** A frame of game systems in program order, with the data each reads and writes. */
export const FRAME: SystemSpec[] = [
  { name: 'Input', cost: 60, parallel: false, reads: [], writes: ['Commands'] },
  { name: 'Movement', cost: 500, parallel: true, reads: ['Commands', 'Velocity'], writes: ['Position'] },
  { name: 'Spatial index', cost: 350, parallel: true, reads: ['Position'], writes: ['Grid'] },
  { name: 'Path queries', cost: 2600, parallel: true, reads: ['Position', 'Grid', 'Map'], writes: ['Paths'] },
  { name: 'Scripts', cost: 300, parallel: true, reads: ['Events', 'Map'], writes: ['Triggers'] },
  { name: 'Decide', cost: 1100, parallel: true, reads: ['Paths', 'Triggers'], writes: ['Intent'] },
  { name: 'Steering', cost: 700, parallel: true, reads: ['Intent', 'Grid', 'Position'], writes: ['Velocity'] },
  { name: 'Animation', cost: 800, parallel: true, reads: ['Position'], writes: ['Pose'] },
  { name: 'Audio', cost: 250, parallel: false, reads: ['Position'], writes: ['Mix'] },
  { name: 'Render prep', cost: 600, parallel: true, reads: ['Position', 'Pose'], writes: ['DrawList'] },
];

export type GraphMode = 'serial' | 'barriers' | 'graph' | 'deferred';

/** System-level dependencies from declared reads and writes, in program order. */
export function systemDeps(systems: SystemSpec[], deferredReads: Set<string> = new Set()): number[][] {
  return systems.map((s, b) => {
    const deps: number[] = [];
    for (let a = 0; a < b; a++) {
      const p = systems[a];
      const raw = p.writes.some((x) => s.reads.includes(x) && !deferredReads.has(x)); // read after write
      const waw = p.writes.some((x) => s.writes.includes(x)); // write after write
      const war = p.reads.some((x) => s.writes.includes(x)); // write after read
      if (raw || waw || war) deps.push(a);
    }
    // Keep only direct edges (drop a → c when a → b → c exists), for drawing.
    return deps.filter((a) => !deps.some((m) => m !== a && reach(systems, m, a, deferredReads)));
  });
}
function reach(systems: SystemSpec[], from: number, to: number, deferred: Set<string>): boolean {
  // Does `from` depend (transitively) on `to`?
  const all = systems.map((s, b) => {
    const d: number[] = [];
    for (let a = 0; a < b; a++) {
      const p = systems[a];
      if (p.writes.some((x) => s.reads.includes(x) && !deferred.has(x)) || p.writes.some((x) => s.writes.includes(x)) || p.reads.some((x) => s.writes.includes(x))) d.push(a);
    }
    return d;
  });
  const seen = new Set<number>();
  const stack = [from];
  while (stack.length) {
    const k = stack.pop()!;
    for (const d of all[k]) {
      if (d === to) return true;
      if (!seen.has(d)) (seen.add(d), stack.push(d));
    }
  }
  return false;
}

/** Jobs for one frame. `chunkCost` sets how finely parallel systems are split. */
export function frameJobs(systems: SystemSpec[], mode: GraphMode, workers: number, chunkCost = 40, seed = 5): { jobs: Job[]; deps: number[][] } {
  const r = rng(seed);
  const deferred = new Set<string>(mode === 'deferred' ? ['Paths'] : []);
  const deps = mode === 'serial' || mode === 'barriers' ? systems.map((_, i) => (i ? [i - 1] : [])) : systemDeps(systems, deferred);
  const jobs: Job[] = [];
  const endOf: number[] = []; // id of each system's completion sync node
  systems.forEach((s, i) => {
    const pre = deps[i].map((d) => endOf[d]);
    const parts = mode === 'serial' || !s.parallel ? 1 : Math.max(1, Math.round(s.cost / chunkCost));
    const first = jobs.length;
    // Uneven chunks (some entities cost more than others), scaled so the system's total is exact.
    const weights = Array.from({ length: parts }, () => (parts > 1 ? 0.6 + r() * 0.8 : 1));
    const wsum = weights.reduce((a, b) => a + b, 0);
    for (let c = 0; c < parts; c++) jobs.push({ id: jobs.length, group: i, chunk: c, chunks: parts, cost: (s.cost * weights[c]) / wsum, deps: pre });
    const end = jobs.length;
    jobs.push({ id: end, group: i, chunk: 0, chunks: 1, cost: 0, sync: true, deps: Array.from({ length: end - first }, (_, k) => first + k) });
    endOf[i] = end;
  });
  void workers;
  return { jobs, deps };
}

/** Longest chain of system costs through the dependency graph (the frame can't be shorter). */
export function criticalPath(systems: SystemSpec[], deps: number[][]): { length: number; path: number[] } {
  const best: number[] = [];
  const prev: number[] = [];
  systems.forEach((s, i) => {
    let b = 0;
    let p = -1;
    for (const d of deps[i]) if (best[d] > b) ((b = best[d]), (p = d));
    best[i] = b + s.cost;
    prev[i] = p;
  });
  let end = 0;
  for (let i = 1; i < systems.length; i++) if (best[i] > best[end]) end = i;
  const path: number[] = [];
  for (let k = end; k >= 0; k = prev[k]) path.unshift(k);
  return { length: best[end], path };
}
