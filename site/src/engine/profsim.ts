/**
 * A made-up game, 120 frames of it, with a known true cost for every call, and three ways to
 * profile it: sampling (as Visual Studio's CPU Usage, Superluminal or perf do), instrumenting every
 * function (as the Instrumentation tool or VSInstr does), and a few hand-placed zones (as Tracy,
 * PIX markers or Unreal Insights do). Comparing what each reports with the truth is the lesson.
 *
 * Pure, no DOM, deterministic: the profiling lesson's numbers are checked in test/lesson-claims.ts.
 */

export interface ProfNode {
  id: number;
  name: string;
  parent: number;
  depth: number;
  children: number[];
  /** Has a hand-placed zone (the "zones" mode only sees these). */
  zone: boolean;
  /** Time spent blocked here (waiting for vsync), not running. */
  wait: boolean;
}

/** One stretch of a frame spent in one function (the leaf of `path`). */
export interface Interval {
  leaf: number;
  dur: number; // ms
}

export interface ProfFrame {
  intervals: Interval[];
  /** Calls per node in this frame. */
  calls: Map<number, number>;
  /** CPU time actually spent working (ms). */
  cpu: number;
  /** Frame time including the wait for vsync (ms). */
  time: number;
}

export interface ProfData {
  nodes: ProfNode[];
  frames: ProfFrame[];
}

export const VSYNC = 1000 / 60;

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

/** Builds the call tree as the game "runs", recording intervals and call counts. */
class Recorder {
  nodes: ProfNode[] = [];
  private byKey = new Map<string, number>();
  private stack: number[] = [];
  frame: ProfFrame = { intervals: [], calls: new Map(), cpu: 0, time: 0 };

  node(name: string, zone = false, wait = false): number {
    const parent = this.stack.length ? this.stack[this.stack.length - 1] : -1;
    const key = `${parent}/${name}`;
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = this.nodes.length;
      this.nodes.push({ id, name, parent, depth: this.stack.length, children: [], zone, wait });
      if (parent >= 0) this.nodes[parent].children.push(id);
      this.byKey.set(key, id);
    }
    return id;
  }
  /** A call: `self` ms of its own work (half before its callees, half after), then `body`. */
  call(name: string, self: number, body?: () => void, zone = false): void {
    const id = this.node(name, zone);
    this.frame.calls.set(id, (this.frame.calls.get(id) ?? 0) + 1);
    this.stack.push(id);
    if (body) {
      this.run(id, self / 2);
      body();
      this.run(id, self / 2);
    } else this.run(id, self);
    this.stack.pop();
  }
  wait(name: string, dur: number): void {
    const id = this.node(name, true, true);
    this.frame.calls.set(id, (this.frame.calls.get(id) ?? 0) + 1);
    if (dur > 0) this.frame.intervals.push({ leaf: id, dur });
  }
  private run(id: number, dur: number): void {
    if (dur <= 0) return;
    const iv = this.frame.intervals;
    const last = iv[iv.length - 1];
    if (last && last.leaf === id) last.dur += dur;
    else iv.push({ leaf: id, dur });
    this.frame.cpu += dur;
  }
}

/**
 * The game: 200 agents thinking (each scores its behaviours and casts four rays), physics,
 * animation of 60 characters, a spatial rebuild, streaming, render prep, then waiting for vsync.
 * Two kinds of spike: every 17th frame a hash map inside one agent's think rehashes, and every
 * 40th frame streaming decompresses a chunk of the level on the main thread.
 */
export function makeProfile(frameCount = 120, seed = 11): ProfData {
  const r = rng(seed);
  const rec = new Recorder();
  const frames: ProfFrame[] = [];
  const us = (x: number) => x / 1000;
  for (let f = 1; f <= frameCount; f++) {
    rec.frame = { intervals: [], calls: new Map(), cpu: 0, time: 0 };
    const rehash = f % 17 === 0;
    const stream = f % 40 === 0;
    rec.call(
      'Frame',
      us(20),
      () => {
        rec.call('Input::Poll', 0.25 + r() * 0.05, undefined, true);
        rec.call(
          'Game::Update',
          us(15),
          () => {
            rec.call(
              'AI::Think',
              us(10),
              () => {
                for (let a = 0; a < 200; a++)
                  rec.call('AI::ThinkAgent', us(1.5), () => {
                    rec.call('AI::ScoreBehaviours', us(5 + r() * 2));
                    for (let k = 0; k < 4; k++) rec.call('Physics::Raycast', us(1 + r() * 0.4));
                    if (rehash && a === 117) rec.call('std::unordered_map::rehash', 6.5 + r());
                  });
              },
              true,
            );
            rec.call(
              'Physics::Step',
              us(20),
              () => {
                rec.call('Physics::Broadphase', 0.55 + r() * 0.1);
                rec.call('Physics::Narrowphase', 1.6 + r() * 0.6);
              },
              true,
            );
            rec.call(
              'Anim::Update',
              us(10),
              () => {
                for (let c = 0; c < 60; c++) rec.call('Anim::SamplePose', us(28 + r() * 4));
              },
              true,
            );
            rec.call('Spatial::Rebuild', 0.45 + r() * 0.1, undefined, true);
          },
          true,
        );
        rec.call(
          'Streaming::Update',
          us(80),
          () => {
            if (stream) rec.call('Streaming::Decompress', 13 + r() * 2);
          },
          true,
        );
        rec.call(
          'Render::Prep',
          us(15),
          () => {
            rec.call('Render::Cull', 0.85 + r() * 0.1);
            rec.call('Render::BuildDrawLists', 1.5 + r() * 0.2);
          },
          true,
        );
      },
      true,
    );
    // Present waits for the next vsync; a frame that misses one waits for the next.
    const fr = rec.frame;
    const time = Math.ceil(fr.cpu / VSYNC) * VSYNC;
    rec.wait('Render::Present (waiting for vsync)', time - fr.cpu);
    fr.time = time;
    frames.push(fr);
  }
  return { nodes: rec.nodes, frames };
}

// ------------------------------------------------------------------------------------------
// Profiling

export type ProfMode = 'sample1' | 'sample8' | 'instrument' | 'zones';

export const MODE_INFO: Record<ProfMode, { label: string; interval?: number; overhead?: number }> = {
  sample1: { label: 'Sampling, 1 kHz', interval: 1 },
  sample8: { label: 'Sampling, 8 kHz', interval: 0.125 },
  /** Probe pairs on every function: roughly what static instrumentation costs per call. */
  instrument: { label: 'Instrument every function', overhead: us(0.4) },
  /** A handful of hand-placed zones: a timestamp pair each, tens of nanoseconds. */
  zones: { label: 'Hand-placed zones', overhead: us(0.03) },
};
function us(x: number) {
  return x / 1000;
}

export interface ProfResult {
  /** Per node, summed over the selected frames (ms). */
  total: Float64Array;
  self: Float64Array;
  /** Calls per node (instrumentation modes only). */
  calls: Float64Array | null;
  /** Which nodes this mode can see at all. */
  visible: boolean[];
  samples: number;
  /** Time the measurement itself added to the selected frames (ms). */
  overhead: number;
  frames: number;
  /** Whether the numbers include time spent waiting. */
  seesWaits: boolean;
}

/** The truth: exact time per node over the frames, no overhead. */
export function truth(d: ProfData, from: number, to: number): { total: Float64Array; self: Float64Array; calls: Float64Array } {
  const n = d.nodes.length;
  const total = new Float64Array(n);
  const self = new Float64Array(n);
  const calls = new Float64Array(n);
  for (let f = from; f < to; f++) {
    const fr = d.frames[f];
    for (const iv of fr.intervals) {
      self[iv.leaf] += iv.dur;
      for (let k = iv.leaf; k >= 0; k = d.nodes[k].parent) total[k] += iv.dur;
    }
    for (const [id, c] of fr.calls) calls[id] += c;
  }
  return { total, self, calls };
}

export function profile(d: ProfData, from: number, to: number, mode: ProfMode, seed = 3): ProfResult {
  const n = d.nodes.length;
  const total = new Float64Array(n);
  const self = new Float64Array(n);
  const visible = d.nodes.map(() => true);
  let samples = 0;
  let overhead = 0;
  const info = MODE_INFO[mode];
  if (info.interval) {
    // A timer interrupt every `interval` ms of the main thread's life; each one records the stack
    // of whatever was running. A blocked thread isn't running, so waits get no samples.
    const r = rng(seed);
    const dt = info.interval;
    let next = r() * dt;
    let clock = 0;
    for (let f = from; f < to; f++)
      for (const iv of d.frames[f].intervals) {
        const end = clock + iv.dur;
        while (next < end) {
          if (!d.nodes[iv.leaf].wait) {
            samples++;
            self[iv.leaf] += dt;
            for (let k = iv.leaf; k >= 0; k = d.nodes[k].parent) total[k] += dt;
          }
          next += dt * (0.7 + 0.6 * r()); // timer interrupts don't land on an exact grid
        }
        clock = end;
      }
    for (const nd of d.nodes) if (nd.wait) visible[nd.id] = false;
    return { total, self, calls: null, visible, samples, overhead: 0, frames: to - from, seesWaits: false };
  }
  // Instrumentation: exact times, plus the probes' own cost on every call they wrap.
  const o = info.overhead!;
  const t = truth(d, from, to);
  const calls = new Float64Array(n);
  // In zones mode only zoned nodes exist; everything below a zone counts as that zone's self time.
  const seen = (id: number) => mode === 'instrument' || d.nodes[id].zone;
  const owner = (id: number) => {
    let k = id;
    while (k >= 0 && !seen(k)) k = d.nodes[k].parent;
    return k;
  };
  for (const nd of d.nodes) visible[nd.id] = seen(nd.id);
  for (let id = 0; id < n; id++) {
    if (!seen(id)) continue;
    calls[id] = t.calls[id];
    const cost = t.calls[id] * o;
    overhead += cost;
    // The probes' cost lands inside this call and every caller's.
    self[id] += cost;
    for (let k = id; k >= 0; k = d.nodes[k].parent) total[k] += cost;
  }
  for (let id = 0; id < n; id++) {
    const w = owner(id);
    if (w < 0) continue;
    self[w] += t.self[id];
    if (seen(id)) total[id] += t.total[id];
  }
  return { total, self, calls, visible, samples: 0, overhead, frames: to - from, seesWaits: true };
}

/** Helpers for picking frames. */
export function worstFrame(d: ProfData): number {
  let w = 0;
  for (let f = 1; f < d.frames.length; f++) if (d.frames[f].cpu > d.frames[w].cpu) w = f;
  return w;
}
export const nodeByName = (d: ProfData, name: string) => d.nodes.find((x) => x.name === name)!.id;
