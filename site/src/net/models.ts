/**
 * The networking lessons' models, one per lesson. Each advances one tick per step() on a shared
 * clock (ms), runs headless for the lesson claims, and exposes what the widgets draw.
 */
import {
  confine,
  type GameState,
  type Input,
  type LinkSettings,
  type Player,
  type Wall,
  ARENA,
  DT,
  Link,
  NO_INPUT,
  RADIUS,
  SPEED,
  TICK_MS,
  checksum,
  clonePlayer,
  cloneState,
  keepInside,
  movePlayer,
  sameInput,
  scriptedInput,
  separate,
  stepGame,
} from './core';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

/** Input for the local player: a keyboard override if set, otherwise the script. */
export type InputSource = (tick: number, me: Player) => Input;
export const scripted = (id: number, seed: number): InputSource => (t, me) => keepInside(scriptedInput(id, t, seed), me);

function spawn(n: number, seed: number): Player[] {
  const out: Player[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i * 0.61803398875 + seed * 0.1) % 1;
    out.push({ x: 2 + ((i * 7.3 + seed) % (ARENA.w - 4)), y: 2 + a * (ARENA.h - 4), vx: 0, vy: 0 });
  }
  return out;
}

// =============================================================================================
// 1. The problem: a client that only draws what the server sends.

interface InputMsg {
  seq: number;
  input: Input;
}
interface StateMsg {
  tick: number;
  players: Player[];
  /** The last of this client's inputs the server has applied. */
  ack: number;
}

export interface Lesson1Settings {
  link: LinkSettings;
  bots: number;
  seed: number;
}

export class DumbTerminal {
  now = 0;
  tick = 0;
  server: GameState;
  up: Link<InputMsg>;
  down: Link<StateMsg>;
  /** The newest state the client has, and when it arrived. */
  shown: StateMsg | null = null;
  input: InputSource;
  private serverInput: Input = NO_INPUT;
  private serverAck = -1;
  // Metrics
  delaySum = 0;
  delayN = 0;
  framesNoNew = 0;
  framesSkipped = 0;
  frames = 0;
  longestGap = 0;
  private lastNew = 0;
  /** When each new state reached the client, for the gap histogram. */
  arrivals: number[] = [];
  /** The newest key press that has made the full round trip: to the server, and back on screen. */
  lastPress: { up: number; down: number } | null = null;
  private press: { seq: number; sent: number; applied: number; stateSent: number } | null = null;
  private lastIn: Input = NO_INPUT;

  constructor(public s: Lesson1Settings) {
    this.server = { tick: 0, players: spawn(1 + s.bots, s.seed) };
    this.up = new Link(s.link, s.seed * 7 + 1);
    this.down = new Link(s.link, s.seed * 7 + 2);
    this.input = scripted(0, s.seed);
  }

  step(): void {
    const t = this.tick;
    // Client: sample input and send it.
    const me = this.shown?.players[0] ?? this.server.players[0];
    const inp = this.input(t, me);
    if ((inp.mx !== this.lastIn.mx || inp.my !== this.lastIn.my) && !this.press) this.press = { seq: t, sent: this.now, applied: -1, stateSent: -1 };
    this.lastIn = inp;
    this.up.send(this.now, { seq: t, input: inp }, 8);
    // Server: apply the newest input that has arrived (or keep the last one), then simulate.
    for (const m of this.up.receive(this.now))
      if (m.seq > this.serverAck) {
        this.serverAck = m.seq;
        this.serverInput = m.input;
      }
    const inputs = [this.serverInput];
    for (let b = 1; b < this.server.players.length; b++) inputs.push(keepInside(scriptedInput(b, this.server.tick, this.s.seed + 100), this.server.players[b]));
    stepGame(this.server, inputs, []);
    if (this.press && this.press.applied < 0 && this.serverAck >= this.press.seq) this.press.applied = this.press.stateSent = this.now;
    this.down.send(this.now, { tick: this.server.tick, players: this.server.players.map(clonePlayer), ack: this.serverAck }, 36 + this.server.players.length * 17);
    // Client: keep the newest state that has arrived.
    let fresh = false;
    let jump = 0;
    for (const m of this.down.receive(this.now))
      if (!this.shown || m.tick > this.shown.tick) {
        jump = this.shown ? m.tick - this.shown.tick : 1;
        this.shown = m;
        fresh = true;
      }
    this.frames++;
    if (this.shown) {
      if (!fresh) this.framesNoNew++;
      else if (jump > 1) this.framesSkipped++;
      if (fresh) {
        this.longestGap = Math.max(this.longestGap, this.now - this.lastNew);
        this.lastNew = this.now;
        this.arrivals.push(this.now);
        if (this.arrivals.length > 400) this.arrivals.splice(0, this.arrivals.length - 400);
      }
      const pr = this.press;
      if (pr && pr.applied >= 0 && this.shown.ack >= pr.seq) {
        this.lastPress = { up: pr.applied - pr.sent, down: this.now - pr.stateSent };
        this.press = null;
      }
      if (this.shown.ack >= 0) {
        this.delaySum += this.now - this.shown.ack * TICK_MS;
        this.delayN++;
      }
    }
    this.now += TICK_MS;
    this.tick++;
  }
  get averageDelay(): number {
    return this.delayN ? this.delaySum / this.delayN : 0;
  }
}

// =============================================================================================
// 2. Snapshots and interpolation: drawing other players from snapshots.

export type RemoteMode = 'latest' | 'interpolate' | 'extrapolate';

export interface Lesson2Settings {
  link: LinkSettings;
  /** Snapshots per second. */
  rate: number;
  mode: RemoteMode;
  /** Interpolation delay, ms. */
  delay: number;
  bots: number;
  seed: number;
}

interface Snapshot {
  tick: number;
  time: number;
  players: Player[];
}

/** Bytes for one snapshot in three encodings (see the lesson). */
export interface SnapshotBytes {
  full: number;
  quantised: number;
  delta: number;
}
export const PACKET_OVERHEAD = 28 + 8;

export class SnapshotClient {
  now = 0;
  tick = 0;
  server: GameState;
  down: Link<Snapshot>;
  up: Link<number>;
  buffer: Snapshot[] = [];
  /** Estimated one-way delay: how far the server's clock is ahead of the newest snapshot's arrival. */
  clockOffset = -1;
  /** What the client draws for each player this frame. */
  drawn: Player[] = [];
  private prevDrawn: Player[] = [];
  // Bandwidth
  bytes: SnapshotBytes = { full: 0, quantised: 0, delta: 0 };
  snapshots = 0;
  private acked = -1;
  private sentQ = new Map<number, number[][]>();
  // Metrics
  errorSum = 0;
  errorN = 0;
  jumps = 0;
  frames = 0;
  late = 0;

  constructor(public s: Lesson2Settings) {
    this.server = { tick: 0, players: spawn(s.bots, s.seed) };
    this.down = new Link(s.link, s.seed * 11 + 1);
    this.up = new Link(s.link, s.seed * 11 + 2);
  }

  private botInput(b: number, t: number, p: Player): Input {
    // Half the players stand about most of the time, as in any real match.
    const idle = b % 2 === 1 ? 0.7 : 0.1;
    return keepInside(scriptedInput(b, t, this.s.seed + 200, 18, 60, idle), p);
  }

  private quantise(p: Player): number[] {
    return [Math.round(p.x * 100), Math.round(p.y * 100), Math.round(p.vx * 10), Math.round(p.vy * 10)];
  }

  step(): void {
    const s = this.server;
    stepGame(
      s,
      s.players.map((p, b) => this.botInput(b, s.tick, p)),
      [],
    );
    const interval = Math.round(60 / this.s.rate);
    if (s.tick % interval === 0) {
      const snap: Snapshot = { tick: s.tick, time: this.now, players: s.players.map(clonePlayer) };
      // Bandwidth: what this snapshot would cost in each encoding.
      const n = s.players.length;
      const q = s.players.map((p) => this.quantise(p));
      const base = this.sentQ.get(this.acked);
      let changed = n;
      if (base) changed = q.filter((v, i) => v.some((x, k) => x !== base[i][k])).length;
      this.bytes.full += PACKET_OVERHEAD + n * 17;
      this.bytes.quantised += PACKET_OVERHEAD + n * 6;
      this.bytes.delta += PACKET_OVERHEAD + Math.ceil(n / 8) + changed * 5;
      this.sentQ.set(s.tick, q);
      for (const k of [...this.sentQ.keys()]) if (k < s.tick - 120) this.sentQ.delete(k);
      this.snapshots++;
      this.down.send(this.now, snap, PACKET_OVERHEAD + n * 6);
    }
    for (const a of this.up.receive(this.now)) this.acked = Math.max(this.acked, a);

    // Client
    for (const m of this.down.receive(this.now)) {
      if (this.buffer.length && m.tick <= this.buffer[this.buffer.length - 1].tick) continue; // late duplicate or reordered
      this.buffer.push(m);
      // Estimate the server's clock: the smallest delay seen recently is the best guess at the latency
      // (jitter only ever adds), smoothed so one early packet doesn't yank it.
      const d = this.now - m.time;
      this.clockOffset = this.clockOffset < 0 ? d : Math.min(d, this.clockOffset + 0.05 * (d - this.clockOffset));
      this.up.send(this.now, m.tick, PACKET_OVERHEAD + 4);
    }
    if (this.buffer.length > 64) this.buffer.splice(0, this.buffer.length - 64);
    this.drawn = this.render();
    // Metrics: distance from where each player really is now, and visible jumps.
    if (this.drawn.length) {
      for (let i = 0; i < this.drawn.length; i++) {
        this.errorSum += dist(this.drawn[i], s.players[i]);
        this.errorN++;
        if (this.prevDrawn.length && dist(this.drawn[i], this.prevDrawn[i]) > SPEED * DT * 2.5) this.jumps++;
      }
      this.frames++;
    }
    this.prevDrawn = this.drawn.map(clonePlayer);
    this.now += TICK_MS;
    this.tick++;
  }

  private render(): Player[] {
    const b = this.buffer;
    if (!b.length) return [];
    const last = b[b.length - 1];
    if (this.s.mode === 'latest') return last.players;
    if (this.s.mode === 'extrapolate') {
      const age = (this.now - last.time) / 1000;
      return last.players.map((p) => ({ x: p.x + p.vx * age, y: p.y + p.vy * age, vx: p.vx, vy: p.vy }));
    }
    // Interpolate: draw the world as it was `delay` ms before the server's present, between the two
    // snapshots around then.
    const t = this.now - this.clockOffset - this.s.delay;
    for (let i = b.length - 1; i > 0; i--) {
      if (b[i - 1].time <= t && t <= b[i].time) {
        const a = (t - b[i - 1].time) / (b[i].time - b[i - 1].time);
        return b[i].players.map((p, k) => {
          const q = b[i - 1].players[k];
          return { x: lerp(q.x, p.x, a), y: lerp(q.y, p.y, a), vx: p.vx, vy: p.vy };
        });
      }
    }
    // Ran out of snapshots (one was late or lost): hold the newest one.
    if (t > last.time) this.late++;
    return t > last.time ? last.players : b[0].players;
  }

  get averageError(): number {
    return this.errorN ? this.errorN && this.errorSum / this.errorN : 0;
  }
  get bytesPerSecond(): SnapshotBytes {
    const secs = this.now / 1000 || 1;
    return { full: this.bytes.full / secs, quantised: this.bytes.quantised / secs, delta: this.bytes.delta / secs };
  }
}

// =============================================================================================
// 3. Prediction and reconciliation: your own player.

export type OwnMode = 'wait' | 'predict' | 'reconcile' | 'smooth';

export interface Lesson3Settings {
  link: LinkSettings;
  mode: OwnMode;
  seed: number;
  /** Leave the other two players out (to show that loss alone causes no corrections). */
  alone?: boolean;
  /** The client also predicts bumping into other players, at the positions it has for them. */
  predictPlayers?: boolean;
  /** Leave the pusher out, so only the guard is there. */
  noPusher?: boolean;
}

/** Push `p` fully out of every other player: they're solid, and `p` gives way. */
function blockBy(p: Player, others: Player[], walls: Wall[]): void {
  for (const o of others) {
    const dx = p.x - o.x;
    const dy = p.y - o.y;
    const d2 = dx * dx + dy * dy;
    const min = 2 * RADIUS;
    if (d2 >= min * min || d2 < 1e-12) continue;
    const d = Math.sqrt(d2);
    p.x = o.x + (dx / d) * min;
    p.y = o.y + (dy / d) * min;
  }
  confine(p, walls);
}

/** Where the guard stands, in the middle of the arena. */
export const GUARD = { x: 10, y: 6 };

interface PredState {
  tick: number;
  players: Player[];
  ack: number;
}

/** The arena for the prediction lesson: a few pillars to walk round. */
export const PILLARS: Wall[] = [
  [6, 3, 7, 4],
  [13, 3, 14, 4],
  [6, 8, 7, 9],
  [13, 8, 14, 9],
];

export class PredictedClient {
  now = 0;
  tick = 0;
  server: GameState;
  up: Link<InputMsg[]>;
  down: Link<PredState>;
  input: InputSource;
  /** Inputs sent but not yet acknowledged by the server. */
  pending: InputMsg[] = [];
  /** The client's own player, as drawn. */
  me: Player;
  /** The newest server state the client has. */
  latest: PredState | null = null;
  /** Visual offset being smoothed away after a correction. */
  offset = { x: 0, y: 0 };
  private applied = -1;
  private queue: InputMsg[] = [];
  // Metrics
  corrections = 0;
  correctionSum = 0;
  biggest = 0;
  delaySum = 0;
  delayN = 0;
  driftSum = 0;
  frames = 0;
  /** Largest single-frame jump of the drawn player beyond normal movement, m. */
  biggestJump = 0;
  private prevDrawn: Player | null = null;
  /** The input the client last changed to, and when, to time how long until it shows. */
  private changeTick = -1;
  private lastInput: Input = NO_INPUT;
  private waitingSince = -1;

  constructor(public s: Lesson3Settings) {
    // You, a guard who stands still, and a pusher who walks into you now and then.
    this.server = { tick: 0, players: [{ x: 4, y: 6, vx: 0, vy: 0 }, ...(s.alone ? [] : [{ x: GUARD.x, y: GUARD.y, vx: 0, vy: 0 }]), ...(s.alone || s.noPusher ? [] : [spawn(1, s.seed + 3)[0]])] };
    this.me = clonePlayer(this.server.players[0]);
    this.up = new Link(s.link, s.seed * 13 + 1);
    this.down = new Link(s.link, s.seed * 13 + 2);
    this.input = scripted(0, s.seed);
  }

  /** The player that walks into you: heads for where you are. */
  private chaser(p: Player, target: Player): Input {
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    return { mx: Math.abs(dx) > 0.3 ? Math.sign(dx) : 0, my: Math.abs(dy) > 0.3 ? Math.sign(dy) : 0, fire: false };
  }

  step(): void {
    const t = this.tick;
    const inp = this.input(t, this.me);
    if (!sameInput(inp, this.lastInput) && (inp.mx || inp.my)) {
      this.changeTick = t;
      this.waitingSince = t;
    }
    this.lastInput = inp;
    const msg = { seq: t, input: inp };
    this.pending.push(msg);
    // Send every unacknowledged input, so a lost packet costs nothing.
    this.up.send(this.now, this.pending.slice(-8), 36 + Math.min(8, this.pending.length) * 3);
    if (this.s.mode !== 'wait') this.predictMove(this.me, inp);

    // Server: apply each input exactly once, in order.
    for (const batch of this.up.receive(this.now)) for (const m of batch) if (m.seq > this.applied && !this.queue.some((q) => q.seq === m.seq)) this.queue.push(m);
    this.queue.sort((a, b) => a.seq - b.seq);
    const sv = this.server;
    let moved = false;
    while (this.queue.length && this.queue[0].seq === this.applied + 1) {
      const m = this.queue.shift()!;
      movePlayer(sv.players[0], m.input, PILLARS);
      blockBy(sv.players[0], sv.players.slice(1), PILLARS);   // other players are solid: you can't walk through them
      this.applied = m.seq;
      moved = true;
    }
    if (!moved) sv.players[0].vx = sv.players[0].vy = 0;
    // The guard stands still; the pusher walks into you for two seconds in every five.
    const chasing = sv.tick % 300 < 120;
    if (sv.players.length > 2) {
      movePlayer(sv.players[2], chasing ? this.chaser(sv.players[2], sv.players[0]) : keepInside(scriptedInput(2, sv.tick, this.s.seed + 301), sv.players[2]), PILLARS, chasing ? 0.6 : 1);
      blockBy(sv.players[2], [sv.players[1]], PILLARS);
      // The pusher shoves you: you give way to it.
      blockBy(sv.players[0], sv.players.slice(1), PILLARS);
    }
    sv.tick++;
    this.down.send(this.now, { tick: sv.tick, players: sv.players.map(clonePlayer), ack: this.applied }, 36 + sv.players.length * 6 + 2);

    // Client: take the newest state.
    for (const m of this.down.receive(this.now)) if (!this.latest || m.tick > this.latest.tick) this.latest = m;
    if (this.latest) {
      const L = this.latest;
      this.pending = this.pending.filter((p) => p.seq > L.ack);
      if (this.s.mode === 'wait') this.me = clonePlayer(L.players[0]);
      else if (this.s.mode === 'reconcile' || this.s.mode === 'smooth') {
        // Rewind to the server's state for the last input it applied, and replay the rest.
        const re = clonePlayer(L.players[0]);
        for (const p of this.pending) this.predictMove(re, p.input);
        const err = dist(re, this.me);
        if (err > 0.01) {
          this.corrections++;
          this.correctionSum += err;
          this.biggest = Math.max(this.biggest, err);
          if (this.s.mode === 'smooth') {
            this.offset.x += this.me.x - re.x;
            this.offset.y += this.me.y - re.y;
          }
        }
        this.me = re;
      }
      // How long until the change of direction shows on screen.
      if (this.waitingSince >= 0) {
        const shows = this.s.mode === 'wait' ? L.ack >= this.changeTick : true;
        if (shows) {
          this.delaySum += (t - this.changeTick) * TICK_MS;
          this.delayN++;
          this.waitingSince = -1;
        }
      }
      this.driftSum += dist(this.me, sv.players[0]);
      this.frames++;
    }
    // Smoothing: decay the visual offset by about 10% a tick (gone in a quarter of a second).
    this.offset.x *= 0.9;
    this.offset.y *= 0.9;
    const dm = this.drawnMe;
    if (this.prevDrawn) this.biggestJump = Math.max(this.biggestJump, dist(dm, this.prevDrawn) - SPEED * DT);
    this.prevDrawn = dm;
    this.now += TICK_MS;
    this.tick++;
  }

  /** The client's own movement code: walls always, other players too if it predicts them. */
  private predictMove(p: Player, inp: Input): void {
    movePlayer(p, inp, PILLARS);
    if (this.s.predictPlayers && this.latest) blockBy(p, this.latest.players.slice(1), PILLARS);
  }

  /** Where the client draws its own player. */
  get drawnMe(): Player {
    return { x: this.me.x + this.offset.x, y: this.me.y + this.offset.y, vx: this.me.vx, vy: this.me.vy };
  }
  get averageDelay(): number {
    return this.delayN ? this.delaySum / this.delayN : 0;
  }
  get averageDrift(): number {
    return this.frames ? this.driftSum / this.frames : 0;
  }
}

// =============================================================================================
// 4. Lag compensation: shooting what you see.

export const COVER: Wall[] = [[8, 6.5, 12, 7.2]];
export const SHOOTER = { x: 10, y: 1.5 };

export interface Lesson4Settings {
  link: LinkSettings;
  /** Interpolation delay for other players, ms. */
  delay: number;
  rewind: boolean;
  /** Longest the server will rewind, ms. */
  maxRewind: number;
  seed: number;
}

interface ShotMsg {
  seq: number;
  /** The time the client was drawing the target at when it fired. */
  viewTime: number;
  aim: { x: number; y: number };
}
interface ShotResult {
  seq: number;
  hit: boolean;
  /** Server time it was decided. */
  at: number;
  /** Where the server tested the target. */
  tested: { x: number; y: number };
  /** Whether the target was already behind cover, as the server saw it at that moment. */
  inCover: boolean;
}

/** Does a ray from a through b come within RADIUS of c, before hitting cover? */
function rayHits(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, walls: Wall[]): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / L;
  const uy = dy / L;
  const t = (c.x - a.x) * ux + (c.y - a.y) * uy;
  if (t < 0) return false;
  const px = a.x + ux * t - c.x;
  const py = a.y + uy * t - c.y;
  if (px * px + py * py > RADIUS * RADIUS) return false;
  return !blocked(a, c, walls);
}

/** Is the straight line from a to b blocked by a wall? (Sampled: walls here are thick enough.) */
export function blocked(a: { x: number; y: number }, b: { x: number; y: number }, walls: Wall[]): boolean {
  const n = 40;
  for (let i = 1; i < n; i++) {
    const x = a.x + ((b.x - a.x) * i) / n;
    const y = a.y + ((b.y - a.y) * i) / n;
    for (const [x0, y0, x1, y1] of walls) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
  }
  return false;
}

/** The target runs back and forth along y = 8.5, past the cover. */
export function targetAt(tick: number): Player {
  const period = 4 * 60;
  const ph = (tick % period) / period;
  const x0 = 4;
  const x1 = 16;
  const u = ph < 0.5 ? ph * 2 : 2 - ph * 2;
  const v = (ph < 0.5 ? 1 : -1) * ((x1 - x0) / (period / 2)) * 60;
  return { x: x0 + (x1 - x0) * u, y: 8.5, vx: v, vy: 0 };
}

export class LagCompensation {
  now = 0;
  tick = 0;
  /** Target positions by server tick, for drawing the past and for rewinding. */
  history: Player[] = [];
  up: Link<ShotMsg>;
  down: Link<{ tick: number; target: Player } | ShotResult>;
  snaps: Array<{ time: number; target: Player }> = [];
  private clockOffset = -1;
  /** The target as the client draws it. */
  seen: Player | null = null;
  results: ShotResult[] = [];
  shots = 0;
  hits = 0;
  coverHits = 0;
  private seq = 0;
  /** Shot traces for drawing: from the shooter to the aim point, coloured by the server's verdict. */
  traces: Array<{ aim: { x: number; y: number }; seq: number; at: number; hit?: boolean; tested?: { x: number; y: number } }> = [];

  constructor(public s: Lesson4Settings) {
    this.up = new Link(s.link, s.seed * 17 + 1);
    this.down = new Link(s.link, s.seed * 17 + 2);
  }

  step(): void {
    const target = targetAt(this.tick);
    this.history.push(target);
    // Server: snapshots of the target, 20 a second.
    if (this.tick % 3 === 0) this.down.send(this.now, { tick: this.tick, target });
    // Server: judge shots.
    for (const shot of this.up.receive(this.now)) {
      let tested = target;
      if (this.s.rewind) {
        const back = Math.min(this.now - shot.viewTime, this.s.maxRewind);
        const ft = (this.now - back) / TICK_MS;
        const i = Math.max(0, Math.floor(ft));
        const a = ft - i;
        const p = this.history[i];
        const q = this.history[Math.min(i + 1, this.history.length - 1)];
        tested = { x: lerp(p.x, q.x, a), y: lerp(p.y, q.y, a), vx: 0, vy: 0 };
      }
      const hit = rayHits(SHOOTER, shot.aim, tested, COVER);
      const inCover = blocked(SHOOTER, target, COVER);
      const r: ShotResult = { seq: shot.seq, hit, at: this.now, tested, inCover };
      if (hit) this.hits++;
      if (hit && inCover) this.coverHits++;
      this.down.send(this.now, r);
    }
    // Client: interpolate the target `delay` ms in the past; fire at it every half second when visible.
    for (const m of this.down.receive(this.now)) {
      if ('target' in m) {
        this.snaps.push({ time: m.tick * TICK_MS, target: m.target });
        const d = this.now - m.tick * TICK_MS;
        this.clockOffset = this.clockOffset < 0 ? d : Math.min(d, this.clockOffset + 0.05 * (d - this.clockOffset));
      }
      else {
        this.results.push(m);
        const tr = this.traces.find((x) => x.seq === m.seq);
        if (tr) ((tr.hit = m.hit), (tr.tested = m.tested));
      }
    }
    if (this.snaps.length > 60) this.snaps.splice(0, this.snaps.length - 60);
    // The client draws the target `delay` ms before its estimate of the server's present.
    const vt = this.now - this.clockOffset - this.s.delay;
    this.seen = null;
    for (let i = this.snaps.length - 1; i > 0; i--) {
      const A = this.snaps[i - 1];
      const B = this.snaps[i];
      if (A.time <= vt && vt <= B.time) {
        const a = (vt - A.time) / (B.time - A.time);
        this.seen = { x: lerp(A.target.x, B.target.x, a), y: lerp(A.target.y, B.target.y, a), vx: 0, vy: 0 };
        break;
      }
    }
    if (this.seen && this.tick % 30 === 15 && !blocked(SHOOTER, this.seen, COVER)) {
      const aim = { x: this.seen.x, y: this.seen.y };
      // The client knows what time it was drawing: its interpolation time, on the server's clock.
      this.up.send(this.now, { seq: this.seq, viewTime: vt, aim });
      this.traces.push({ aim, seq: this.seq, at: this.now });
      if (this.traces.length > 12) this.traces.shift();
      this.seq++;
      this.shots++;
    }
    this.now += TICK_MS;
    this.tick++;
  }
  get hitRate(): number {
    return this.results.length ? this.results.filter((r) => r.hit).length / this.results.length : 0;
  }
}

// =============================================================================================
// 5. Lockstep and rollback: two peers sending inputs.

export type SyncMode = 'lockstep' | 'rollback';

export interface Lesson5Settings {
  link: LinkSettings;
  mode: SyncMode;
  /** Frames of input delay. */
  inputDelay: number;
  /** Rollback: furthest a peer may predict ahead of the other's confirmed input. */
  maxRollback: number;
  /** Peer B computes movement in a different order of operations. */
  desync: boolean;
  seed: number;
}

interface InputPacket {
  /** Inputs for frames first..first+inputs.length-1. */
  first: number;
  inputs: Input[];
  /** The newest frame of the other peer's input received. */
  ack: number;
  /** Checksum of a confirmed frame, for desync detection. */
  check?: { frame: number; sum: number };
}

class Peer {
  frame = 0;
  state: GameState;
  local: Input[] = [];
  remote: Array<Input | undefined> = [];
  /** The remote input each simulated frame used (confirmed or predicted). */
  usedRemote: Input[] = [];
  states: GameState[] = [];
  confirmedRemote = -1;
  remoteAck = -1;
  rollbackFrom = Infinity;
  out: Link<InputPacket>;
  inbox: Link<InputPacket> | null = null;
  // Metrics
  stalls = 0;
  rollbacks = 0;
  rolledFrames = 0;
  deepest = 0;
  corrections = 0;
  checks = new Map<number, number>();
  theirChecks = new Map<number, number>();
  desyncAt = -1;
  /** Remote player's drawn position last frame, to spot visible corrections. */
  private lastRemote: Player | null = null;

  constructor(
    public id: number,
    public s: Lesson5Settings,
    start: GameState,
    seed: number,
  ) {
    this.state = cloneState(start);
    this.states[0] = cloneState(start);
    this.out = new Link(s.link, seed);
    for (let f = 0; f < s.inputDelay; f++) this.local[f] = NO_INPUT;
  }

  private alt(): boolean {
    return this.s.desync && this.id === 1;
  }

  /** The guess for the other player's input at frame f: the newest input received for any earlier frame. */
  private predicted(f: number): Input {
    for (let k = Math.min(f, this.remote.length - 1); k >= 0; k--) if (this.remote[k]) return this.remote[k]!;
    return NO_INPUT;
  }

  private sim(f: number): void {
    const r = this.remote[f] ?? this.predicted(f);
    this.usedRemote[f] = r;
    const inputs = this.id === 0 ? [this.local[f], r] : [r, this.local[f]];
    stepGameOrder(this.state, inputs, this.alt());
    this.states[f + 1] = cloneState(this.state);
  }

  receive(now: number): void {
    if (!this.inbox) return;
    for (const p of this.inbox.receive(now)) {
      this.remoteAck = Math.max(this.remoteAck, p.ack);
      p.inputs.forEach((inp, k) => {
        const f = p.first + k;
        if (this.remote[f]) return;
        this.remote[f] = inp;
        if (f < this.frame && this.usedRemote[f] && !sameInput(this.usedRemote[f], inp)) this.rollbackFrom = Math.min(this.rollbackFrom, f);
      });
      while (this.remote[this.confirmedRemote + 1]) this.confirmedRemote++;
      if (p.check) {
        this.theirChecks.set(p.check.frame, p.check.sum);
        const mine = this.checks.get(p.check.frame);
        if (mine !== undefined && mine !== p.check.sum && this.desyncAt < 0) this.desyncAt = p.check.frame;
      }
    }
  }

  /** One real tick: try to advance one frame. `press` is what this peer's player presses now. */
  advance(now: number, press: (frame: number, me: Player) => Input): void {
    const s = this.s;
    // Roll back if a confirmed input differed from what we predicted.
    if (this.rollbackFrom < this.frame) {
      const from = this.rollbackFrom;
      this.state = cloneState(this.states[from]);
      for (let f = from; f < this.frame; f++) this.sim(f);
      const depth = this.frame - from;
      this.rollbacks++;
      this.rolledFrames += depth;
      this.deepest = Math.max(this.deepest, depth);
    }
    this.rollbackFrom = Infinity;
    const f = this.frame;
    // Sample this frame's press once, for the frame inputDelay frames from now, and send it straight away.
    if (this.local[f + s.inputDelay] === undefined) this.local[f + s.inputDelay] = press(f, this.state.players[this.id]);
    const canGo = s.mode === 'lockstep' ? this.remote[f] !== undefined : f - this.confirmedRemote <= s.maxRollback;
    if (canGo) {
      this.sim(f);
      this.frame++;
    } else this.stalls++;
    // Desync check: checksum the newest frame both inputs are confirmed for, every 30 frames.
    let check: InputPacket['check'];
    const cf = Math.min(this.confirmedRemote + 1, this.frame);
    const ck = cf - (cf % 30);
    if (ck > 0 && this.states[ck] && ck <= this.confirmedRemote + 1) {
      const sum = checksum(this.states[ck]);
      this.checks.set(ck, sum);
      check = { frame: ck, sum };
      const theirs = this.theirChecks.get(ck);
      if (theirs !== undefined && theirs !== sum && this.desyncAt < 0) this.desyncAt = ck;
    }
    // Send every input the other peer hasn't acknowledged.
    const first = Math.max(0, this.remoteAck + 1);
    const inputs: Input[] = [];
    for (let k = first; this.local[k] !== undefined && inputs.length < 32; k++) inputs.push(this.local[k]);
    this.out.send(now, { first, inputs, ack: this.confirmedRemote, check }, 28 + 6 + inputs.length);
    // Visible corrections: the other player jumping on screen.
    const rp = this.state.players[1 - this.id];
    if (this.lastRemote && dist(rp, this.lastRemote) > SPEED * DT * 2.5) this.corrections++;
    this.lastRemote = clonePlayer(rp);
    // Trim old history.
    const keep = Math.min(this.frame, this.confirmedRemote) - 64;
    if (keep > 0 && this.states[keep - 1]) for (let k = keep - 64; k < keep; k++) if (k >= 0) delete this.states[k];
  }
}

/** stepGame, with an option to do the movement arithmetic in a different order. */
function stepGameOrder(s: GameState, inputs: Input[], alt: boolean): void {
  if (!alt) return stepGame(s, inputs, []);
  // The same maths, written differently: (position × 60 + velocity) / 60 instead of position + velocity × (1/60). Mathematically
  // identical; in floating point, occasionally one bit apart.
  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i];
    const inp = inputs[i];
    const k = inp.mx !== 0 && inp.my !== 0 ? 0.7071067811865476 : 1;
    p.vx = inp.mx * k * SPEED;
    p.vy = inp.my * k * SPEED;
    p.x = (p.x * 60 + p.vx) / 60;
    p.y = (p.y * 60 + p.vy) / 60;
    p.x = Math.min(Math.max(p.x, RADIUS), ARENA.w - RADIUS);
    p.y = Math.min(Math.max(p.y, RADIUS), ARENA.h - RADIUS);
  }
  separate(s.players, []);
  s.tick++;
}

export class PeerToPeer {
  now = 0;
  tick = 0;
  a: Peer;
  b: Peer;
  /** The true game, run with no network, to check both peers against. */
  truth: GameState;

  constructor(public s: Lesson5Settings) {
    const start: GameState = {
      tick: 0,
      players: [
        { x: 7, y: 6, vx: 0, vy: 0 },
        { x: 13, y: 6, vx: 0, vy: 0 },
      ],
    };
    this.truth = cloneState(start);
    this.a = new Peer(0, s, start, s.seed * 19 + 1);
    this.b = new Peer(1, s, start, s.seed * 19 + 2);
    this.a.inbox = this.b.out;
    this.b.inbox = this.a.out;
  }

  /** What each player presses at frame f: the scripts, steered towards each other now and then so they bump. */
  press(id: number) {
    return (f: number, me: Player): Input => {
      const inp = scriptedInput(id, f, this.s.seed + 500, 8, 40, 0.1);
      return keepInside(inp, me, 3);
    };
  }

  step(): void {
    this.a.receive(this.now);
    this.b.receive(this.now);
    this.a.advance(this.now, this.press(0));
    this.b.advance(this.now, this.press(1));
    this.now += TICK_MS;
    this.tick++;
  }

  /** Re-run the game with each frame's real inputs and no network, up to frame n. */
  truthAt(n: number): GameState {
    const g: GameState = cloneState(this.a.states[0] ?? this.truth);
    const la = this.a.local;
    const lb = this.b.local;
    for (let f = 0; f < n; f++) stepGame(g, [la[f] ?? NO_INPUT, lb[f] ?? NO_INPUT], []);
    return g;
  }
}
