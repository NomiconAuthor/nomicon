/**
 * A discrete-event model of what a job system does when a job has to wait for other jobs.
 * W cores run a frame of tasks; some tasks spawn children and wait for them before they can
 * finish. Five ways to handle that wait:
 *
 * - block:     a thread pool whose worker sleeps until the children are done (it keeps its core).
 * - help:      a thread pool whose worker runs other jobs from inside the wait (nested, on its stack).
 * - fiber:     a thread pool where the waiting job is parked on its own fiber and the worker moves on.
 * - coroutine: the same as fibers, but the job is a stackless coroutine (a small heap frame).
 * - threads:   no pool: every task is its own OS thread, and the OS parks and resumes it.
 *
 * Times are microseconds of simulated work, so results are the same on every machine. Pure, no DOM,
 * so the lesson's numbers can be checked headlessly (test/wait-batch.ts).
 */

export type Mode = 'block' | 'help' | 'fiber' | 'coroutine' | 'threads';

export interface Task {
  id: number;
  name: string;
  /** Which top-level job it belongs to (for colour). */
  group: number;
  /** Work before spawning children. */
  pre: number;
  /** Work after the children are done (0 for a leaf). */
  post: number;
  children: number[];
  parent: number;
}

export interface Costs {
  /** Taking a fresh task and starting it (µs). */
  start: number;
  /** Resuming a task whose wait is over (µs). */
  resume: number;
  /** Per child spawned, paid by the parent (µs). */
  spawn: number;
  /** Stack memory per live context (KiB). */
  stackKiB: number;
}

/** Rough, typical costs. Threads include refilling caches after a switch. */
export const COSTS: Record<Mode, Costs> = {
  block: { start: 0.1, resume: 0, spawn: 0.05, stackKiB: 1024 },
  help: { start: 0.1, resume: 0, spawn: 0.05, stackKiB: 1024 },
  fiber: { start: 0.3, resume: 0.3, spawn: 0.05, stackKiB: 64 },
  coroutine: { start: 0.15, resume: 0.1, spawn: 0.05, stackKiB: 1 },
  threads: { start: 4, resume: 4, spawn: 20, stackKiB: 1024 },
};

export type SpanKind = 'work' | 'overhead' | 'blocked' | 'spin';

export interface Span {
  core: number;
  start: number;
  end: number;
  kind: SpanKind;
  task: number;
  /** Nesting depth on the worker's stack (help mode), 0 otherwise. */
  depth: number;
}

export interface WaitResult {
  spans: Span[];
  makespan: number;
  work: number;
  overhead: number;
  blocked: number;
  spin: number;
  idle: number;
  deadlock: boolean;
  /** Tasks finished (all of them unless deadlocked). */
  finished: number;
  /** Deepest nesting of jobs on one worker's stack (help mode). */
  maxDepth: number;
  /** Time between a wait being over and the waiting task carrying on. */
  lateTotal: number;
  lateMax: number;
  /** Most contexts (threads, fibers or coroutine frames) alive at once. */
  peakContexts: number;
  /** Stack memory at that peak (KiB): pool threads plus fibers, or one stack per thread. */
  memoryKiB: number;
  /** Context switches (fiber switches, coroutine resumes, OS thread switches). */
  switches: number;
  done: number[];
}

interface Frame {
  task: number;
  phase: 'pre' | 'wait' | 'post' | 'spawn';
}

interface Core {
  stack: Frame[];
  freeAt: number;
  running: boolean;
}

export function simulateWait(tasks: Task[], roots: number[], mode: Mode, cores: number, costs: Costs = COSTS[mode]): WaitResult {
  const W = Math.max(1, cores);
  const park = mode === 'fiber' || mode === 'coroutine' || mode === 'threads';
  const n = tasks.length;
  const counter = tasks.map((t) => t.children.length);
  const done = new Array<number>(n).fill(-1);
  const readyAt = new Array<number>(n).fill(-1);
  const parked = new Set<number>();
  const queue: number[] = [];
  const resumeQ: number[] = [];
  const spans: Span[] = [];
  const C: Core[] = Array.from({ length: W }, () => ({ stack: [], freeAt: 0, running: false }));
  let work = 0;
  let overhead = 0;
  let blocked = 0;
  let spin = 0;
  let finished = 0;
  let maxDepth = 0;
  let lateTotal = 0;
  let lateMax = 0;
  let switches = 0;
  let deadlock = false;
  // Contexts alive: fibers/coroutines from start to finish; threads from creation to finish.
  let live = 0;
  let peak = 0;
  const bump = (d: number) => {
    live += d;
    if (live > peak) peak = live;
  };

  const add = (core: number, start: number, end: number, kind: SpanKind, task: number, depth: number) => {
    if (end - start <= 1e-9) return;
    spans.push({ core, start, end, kind, task, depth });
    const d = end - start;
    if (kind === 'work') work += d;
    else if (kind === 'overhead') overhead += d;
    else if (kind === 'blocked') blocked += d;
    else spin += d;
  };

  // Spawned tasks join the queue one at a time, as their spawner creates them.
  const releases: Array<{ at: number; id: number }> = [];
  const release = (id: number, at: number) => {
    let i = releases.length;
    while (i > 0 && releases[i - 1].at > at) i--;
    releases.splice(i, 0, { at, id });
  };
  const flushReleases = (t: number) => {
    while (releases.length && releases[0].at <= t + 1e-9) {
      queue.push(releases.shift()!.id);
      if (mode === 'threads') bump(1); // a thread exists from the moment it's created
    }
  };

  // The frame starts with core 0 creating the roots.
  roots.forEach((id, i) => release(id, (i + 1) * costs.spawn));
  C[0].stack.push({ task: -1, phase: 'spawn' });
  add(0, 0, roots.length * costs.spawn, 'overhead', -1, 0);
  C[0].freeAt = roots.length * costs.spawn;
  C[0].running = true;
  flushReleases(0);

  /** Start a segment on the core's top frame: `ov` of overhead, then `dur` of work. */
  const startSegment = (k: number, t: number, ov: number, dur: number) => {
    const c = C[k];
    const f = c.stack[c.stack.length - 1];
    const depth = mode === 'help' ? c.stack.length - 1 : 0;
    add(k, t, t + ov, 'overhead', f.task, depth);
    add(k, t + ov, t + ov + dur, 'work', f.task, depth);
    c.freeAt = t + ov + dur;
    c.running = true;
    if (f.phase === 'pre') {
      // Children are created at the end of the job's own work, one after another.
      const kids = tasks[f.task].children;
      const at = t + ov + tasks[f.task].pre;
      kids.forEach((ch, i) => release(ch, at + (i + 1) * costs.spawn));
    }
  };
  const preDuration = (id: number) => tasks[id].pre + tasks[id].children.length * costs.spawn;

  const complete = (id: number, t: number) => {
    done[id] = t;
    finished++;
    if (mode !== 'block' && mode !== 'help') bump(-1);
    const p = tasks[id].parent;
    if (p >= 0 && --counter[p] === 0) {
      readyAt[p] = t;
      if (parked.has(p)) resumeQ.push(p);
    }
  };

  /** The next time a running core finishes something, or a spawned task appears. */
  const nextEvent = () => {
    let m = releases.length ? releases[0].at : Infinity;
    for (const c of C) if (c.running && c.freeAt < m) m = c.freeAt;
    return m;
  };

  const late = (id: number, t: number) => {
    const d = Math.max(0, t - readyAt[id]);
    lateTotal += d;
    if (d > lateMax) lateMax = d;
  };

  /** Decide what core k does at time t (its previous segment, if any, is already finished). */
  const act = (k: number, t: number) => {
    const c = C[k];
    for (;;) {
      const top = c.stack[c.stack.length - 1];
      if (top && top.phase === 'wait') {
        if (counter[top.task] === 0) {
          late(top.task, t);
          top.phase = 'post';
          startSegment(k, t, costs.resume, tasks[top.task].post);
          return;
        }
        if (mode === 'block' || (mode === 'help' && !queue.length)) {
          const next = nextEvent();
          if (next === Infinity) {
            // Nothing is running anywhere and this worker can't help: everyone is waiting.
            c.freeAt = Infinity;
            c.running = false;
            return;
          }
          add(k, t, next, mode === 'block' ? 'blocked' : 'spin', top.task, mode === 'help' ? c.stack.length - 1 : 0);
          c.freeAt = Math.max(next, t);
          c.running = false;
          return;
        }
        if (mode === 'help') {
          const id = queue.shift()!;
          c.stack.push({ task: id, phase: 'pre' });
          if (c.stack.length - 1 > maxDepth) maxDepth = c.stack.length - 1;
          startSegment(k, t, costs.start, preDuration(id));
          return;
        }
        // Park: the task keeps its own stack (fiber, thread) or frame (coroutine); the worker moves on.
        parked.add(top.task);
        c.stack.pop();
        switches++;
        continue;
      }
      if (!c.stack.length) {
        if (resumeQ.length) {
          const id = resumeQ.shift()!;
          parked.delete(id);
          switches++;
          late(id, t);
          c.stack.push({ task: id, phase: 'post' });
          startSegment(k, t, costs.resume, tasks[id].post);
          return;
        }
        if (queue.length) {
          const id = queue.shift()!;
          if (mode === 'fiber' || mode === 'coroutine') bump(1);
          if (park) switches++;
          c.stack.push({ task: id, phase: 'pre' });
          startSegment(k, t, costs.start, preDuration(id));
          return;
        }
        const next = nextEvent();
        c.freeAt = next === Infinity ? Infinity : Math.max(next, t);
        c.running = false;
        return;
      }
      return;
    }
  };

  let guard = 0;
  while (finished < n && guard++ < 5_000_000) {
    // The core that becomes free first acts next; at equal times, cores finishing work go first.
    let k = -1;
    for (let i = 0; i < W; i++) {
      const a = C[i];
      if (a.freeAt === Infinity) continue;
      if (k < 0 || a.freeAt < C[k].freeAt || (a.freeAt === C[k].freeAt && a.running && !C[k].running)) k = i;
    }
    if (k < 0) {
      deadlock = true;
      break;
    }
    const c = C[k];
    const t = c.freeAt;
    flushReleases(t);
    if (c.running) {
      c.running = false;
      const f = c.stack[c.stack.length - 1];
      if (f.phase === 'spawn') c.stack.pop();
      else if (f.phase === 'pre') {
        const kids = tasks[f.task].children;
        if (kids.length) {
          f.phase = 'wait';
        } else {
          c.stack.pop();
          complete(f.task, t);
        }
      } else if (f.phase === 'post') {
        c.stack.pop();
        complete(f.task, t);
      }
    }
    act(k, t);
    // Anyone parked at Infinity (idle with nothing running) gets another look now that things changed.
    for (let i = 0; i < W; i++) {
      const a = C[i];
      if (a.freeAt !== Infinity) continue;
      const top = a.stack[a.stack.length - 1];
      const wake = !top
        ? queue.length > 0 || resumeQ.length > 0
        : top.phase === 'wait' && (counter[top.task] === 0 || (mode === 'help' && queue.length > 0));
      if (wake) a.freeAt = t;
    }
  }
  let makespan = 0;
  for (const s of spans) if (s.end > makespan) makespan = s.end;
  if (deadlock) for (const d of done) if (d > makespan) makespan = d;
  const contexts = mode === 'block' || mode === 'help' ? W : peak;
  const memoryKiB = mode === 'threads' ? peak * costs.stackKiB : mode === 'block' || mode === 'help' ? W * costs.stackKiB : W * COSTS.block.stackKiB + peak * costs.stackKiB;
  return {
    spans,
    makespan,
    work,
    overhead,
    blocked,
    spin,
    idle: Math.max(0, makespan * W - work - overhead - blocked - spin),
    deadlock,
    finished,
    maxDepth,
    lateTotal,
    lateMax,
    peakContexts: contexts,
    memoryKiB,
    switches,
    done,
  };
}

// ------------------------------------------------------------------------------------------
// The workload: one frame of game jobs, some of which fan out and wait.

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

export interface Workload {
  tasks: Task[];
  roots: number[];
  /** Names of the top-level groups, for the key. */
  groups: string[];
}

/**
 * Six party updates, each fanning out into per-unit jobs, queued first; then two dozen independent
 * jobs (animation, audio, particles...). With `nested`, two units per party run a small path search
 * that fans out and waits again.
 */
export function frameWorkload(nested = true, seed = 7, parties = 6, misc = 24): Workload {
  const r = rng(seed);
  const tasks: Task[] = [];
  const mk = (name: string, group: number, pre: number, post: number, parent: number): Task => {
    const t: Task = { id: tasks.length, name, group, pre, post, children: [], parent };
    tasks.push(t);
    if (parent >= 0) tasks[parent].children.push(t.id);
    return t;
  };
  const roots: number[] = [];
  const groups: string[] = [];
  for (let s = 0; s < parties; s++) {
    groups.push(`Party ${s + 1}`);
    const pt = mk(`Party ${s + 1}`, s, 12 + r() * 6, 8 + r() * 4, -1);
    roots.push(pt.id);
    for (let u = 0; u < 6; u++) {
      if (nested && (u === 1 || u === 4)) {
        const path = mk(`Party ${s + 1}: path`, s, 4, 4, pt.id);
        for (let g = 0; g < 4; g++) mk(`Party ${s + 1}: path part`, s, 8 + r() * 8, 0, path.id);
      } else mk(`Party ${s + 1}: unit`, s, 10 + r() * 20, 0, pt.id);
    }
  }
  groups.push('Other jobs');
  for (let m = 0; m < misc; m++) roots.push(mk('Other job', parties, 15 + r() * 45, 0, -1).id);
  return { tasks, roots, groups };
}
