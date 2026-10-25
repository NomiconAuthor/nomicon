/**
 * The networking lessons' shared machinery: a tiny top-down arena game, scripted players, and
 * a simulated network link with latency, jitter and loss. Everything advances in fixed ticks
 * and uses only +, -, *, / and sqrt, so every browser replays it identically.
 */

export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;
export const DT = 1 / TICK_HZ;

// ---------------------------------------------------------------------------------------------
// Random numbers

/** A seeded generator (mulberry32): the same seed gives the same sequence everywhere. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stateless hash to [0, 1): for "what does player p do at tick t" without carrying state. */
export function hash01(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x01000193);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------------------------
// The game

export const ARENA = { w: 20, h: 12 };
export const RADIUS = 0.4;
export const SPEED = 5;

/** An axis-aligned wall: x0, y0, x1, y1. */
export type Wall = [number, number, number, number];

export interface Input {
  /** Movement direction: each -1, 0 or 1. */
  mx: number;
  my: number;
  fire: boolean;
}
export const NO_INPUT: Input = { mx: 0, my: 0, fire: false };
export const sameInput = (a: Input, b: Input) => a.mx === b.mx && a.my === b.my && a.fire === b.fire;

export interface Player {
  x: number;
  y: number;
  vx: number;
  vy: number;
}
export interface GameState {
  tick: number;
  players: Player[];
}

export const clonePlayer = (p: Player): Player => ({ x: p.x, y: p.y, vx: p.vx, vy: p.vy });
export const cloneState = (s: GameState): GameState => ({ tick: s.tick, players: s.players.map(clonePlayer) });

/** Diagonal movement is normalised: 1/sqrt(2), written out so no engine computes it differently. */
const DIAG = 0.7071067811865476;

/** Move one player by one input for one tick, and keep it inside the arena and out of walls. */
export function movePlayer(p: Player, inp: Input, walls: Wall[], speedScale = 1): void {
  const k = inp.mx !== 0 && inp.my !== 0 ? DIAG : 1;
  p.vx = inp.mx * k * SPEED * speedScale;
  p.vy = inp.my * k * SPEED * speedScale;
  p.x += p.vx * DT;
  p.y += p.vy * DT;
  confine(p, walls);
}

/** Push a player out of the arena edges and walls. */
export function confine(p: Player, walls: Wall[]): void {
  p.x = Math.min(Math.max(p.x, RADIUS), ARENA.w - RADIUS);
  p.y = Math.min(Math.max(p.y, RADIUS), ARENA.h - RADIUS);
  for (const [x0, y0, x1, y1] of walls) {
    const cx = Math.min(Math.max(p.x, x0), x1);
    const cy = Math.min(Math.max(p.y, y0), y1);
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= RADIUS * RADIUS) continue;
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      p.x = cx + (dx / d) * RADIUS;
      p.y = cy + (dy / d) * RADIUS;
    } else {
      // Centre inside the wall: leave by the nearest face.
      const opts: Array<[number, number, number]> = [
        [p.x - x0 + RADIUS, x0 - RADIUS, p.y],
        [x1 - p.x + RADIUS, x1 + RADIUS, p.y],
      ];
      const optsY: Array<[number, number, number]> = [
        [p.y - y0 + RADIUS, p.x, y0 - RADIUS],
        [y1 - p.y + RADIUS, p.x, y1 + RADIUS],
      ];
      let best = opts[0];
      let isY = false;
      for (const o of opts) if (o[0] < best[0]) best = o;
      for (const o of optsY) if (o[0] < best[0]) ((best = o), (isY = true));
      if (isY) p.y = best[2];
      else p.x = best[1];
    }
  }
}

/** Players push each other apart: each moves half the overlap. */
export function separate(ps: Player[], walls: Wall[]): void {
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i];
      const b = ps[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      const min = 2 * RADIUS;
      if (d2 >= min * min || d2 < 1e-12) continue;
      const d = Math.sqrt(d2);
      const push = (min - d) / 2;
      const nx = dx / d;
      const ny = dy / d;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
      confine(a, walls);
      confine(b, walls);
    }
}

/** One authoritative tick: every player moves by its input, then players push each other apart. */
export function stepGame(s: GameState, inputs: Input[], walls: Wall[], speedScale = 1): void {
  for (let i = 0; i < s.players.length; i++) movePlayer(s.players[i], inputs[i] ?? NO_INPUT, walls, speedScale);
  separate(s.players, walls);
  s.tick++;
}

/** A checksum of the state's exact bits, as rollback games exchange to detect a desync. */
export function checksum(s: GameState): number {
  const f = new Float64Array(1);
  const u = new Uint32Array(f.buffer);
  let h = 0x811c9dc5 ^ s.tick;
  for (const p of s.players)
    for (const x of [p.x, p.y]) {
      f[0] = x;
      h = Math.imul(h ^ u[0], 0x01000193);
      h = Math.imul(h ^ u[1], 0x01000193);
    }
  return h >>> 0;
}

// ---------------------------------------------------------------------------------------------
// Scripted players

/**
 * What player `id` presses on tick `t`: walks in a direction for a while, then picks another,
 * like a player wandering about. Direction changes are spaced `minHold` to `maxHold` ticks apart.
 * Stateless, so any peer can ask what a scripted player pressed at any tick.
 */
export function scriptedInput(id: number, t: number, seed: number, minHold = 18, maxHold = 60, idle = 0.15): Input {
  // Find the segment containing t by walking segment boundaries from 0. Segments are short, so
  // cache per (id, seed).
  const segs = segments(id, seed, minHold, maxHold);
  while (segs.ends[segs.ends.length - 1] <= t) {
    const k = segs.ends.length;
    const len = minHold + Math.floor(hash01(seed, id, k, 1) * (maxHold - minHold + 1));
    segs.ends.push(segs.ends[k - 1] + len);
  }
  // Binary search for the segment.
  let lo = 0;
  let hi = segs.ends.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs.ends[mid] > t) hi = mid;
    else lo = mid + 1;
  }
  const r = hash01(seed, id, lo, 2);
  if (r < idle) return NO_INPUT;
  const dir = Math.floor(hash01(seed, id, lo, 3) * 8);
  const DIRS = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  return { mx: DIRS[dir][0], my: DIRS[dir][1], fire: false };
}
const segCache = new Map<string, { ends: number[] }>();
function segments(id: number, seed: number, minHold: number, maxHold: number): { ends: number[] } {
  const key = `${id}:${seed}:${minHold}:${maxHold}`;
  let s = segCache.get(key);
  if (!s) {
    s = { ends: [minHold + Math.floor(hash01(seed, id, 0, 1) * (maxHold - minHold + 1))] };
    segCache.set(key, s);
  }
  return s;
}

/**
 * Keep a scripted player off the edges: near an edge, stop moving towards it (rather than turn
 * round, which would flip back and forth every tick at the boundary).
 */
export function keepInside(inp: Input, p: Player, margin = 2): Input {
  let { mx, my } = inp;
  if ((p.x < margin && mx < 0) || (p.x > ARENA.w - margin && mx > 0)) mx = 0;
  if ((p.y < margin && my < 0) || (p.y > ARENA.h - margin && my > 0)) my = 0;
  return { mx, my, fire: inp.fire };
}

// ---------------------------------------------------------------------------------------------
// The network

export interface LinkSettings {
  /** One-way latency, ms. */
  latency: number;
  /** Extra random delay, 0 to this many ms, per packet. */
  jitter: number;
  /** Fraction of packets lost, 0 to 1. */
  loss: number;
}
export const GOOD_LINK: LinkSettings = { latency: 40, jitter: 5, loss: 0 };

export interface Packet<T> {
  sent: number;
  arrives: number;
  data: T;
  bytes: number;
  lost: boolean;
}

/**
 * One direction of a connection. Packets are sent at a time (ms) and become receivable once
 * their arrival time has passed. Jitter can reorder them, as real UDP does.
 */
export class Link<T> {
  private queue: Packet<T>[] = [];
  /** Every packet sent, for drawing timelines (trimmed to the last few seconds). */
  history: Packet<T>[] = [];
  sentBytes = 0;
  sentPackets = 0;
  lostPackets = 0;
  private r: () => number;
  constructor(public settings: LinkSettings, seed: number) {
    this.r = rng(seed);
  }
  send(now: number, data: T, bytes = 0): void {
    const j = this.r() * this.settings.jitter;
    const lost = this.r() < this.settings.loss;
    const p: Packet<T> = { sent: now, arrives: now + this.settings.latency + j, data, bytes, lost };
    this.sentBytes += bytes;
    this.sentPackets++;
    if (lost) this.lostPackets++;
    else this.queue.push(p);
    this.history.push(p);
    if (this.history.length > 400) this.history.splice(0, this.history.length - 400);
  }
  /** Everything that has arrived by `now`, in arrival order. */
  receive(now: number): T[] {
    const out: Packet<T>[] = [];
    const keep: Packet<T>[] = [];
    for (const p of this.queue) (p.arrives <= now ? out : keep).push(p);
    this.queue = keep;
    out.sort((a, b) => a.arrives - b.arrives || a.sent - b.sent);
    return out.map((p) => p.data);
  }
}
