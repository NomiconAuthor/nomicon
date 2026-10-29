/** The networking lessons' widgets. Each wraps one model from models.ts and draws it. */
import { h, seg } from '../engine/dom';
import { ARENA, type Input, type LinkSettings, type Player, RADIUS, TICK_MS, type Wall } from './core';
import {
  COVER,
  DumbTerminal,
  LagCompensation,
  type OwnMode,
  PILLARS,
  PeerToPeer,
  PredictedClient,
  type RemoteMode,
  SHOOTER,
  SnapshotClient,
  type SyncMode,
  targetAt,
} from './models';

// ---------------------------------------------------------------------------------------------
// Shared pieces

function frame(host: HTMLElement, cls: string): HTMLElement {
  const root = h('div', { class: `ll net ${cls}` });
  host.replaceChildren(root);
  return root;
}
function chk(label: string, on: boolean, change: (v: boolean) => void): HTMLElement {
  const i = h('input', { type: 'checkbox', onchange: (e: Event) => change((e.target as HTMLInputElement).checked) }) as HTMLInputElement;
  i.checked = on;
  return h('label', { class: 'll-chk' }, i, ` ${label}`);
}
function stats(items: Array<[string | number, string]>): HTMLElement[] {
  return items.map(([val, label]) => h('span', { class: 'll-stat' }, h('b', {}, String(val)), h('span', {}, label)));
}

const LATENCY: Array<[string, string]> = [
  ['20', '20 ms'],
  ['50', '50 ms'],
  ['100', '100 ms'],
  ['200', '200 ms'],
];

/** Theme colours, read once per theme change. */
class Palette {
  private cache: Record<string, string> = {};
  constructor(private el: HTMLElement) {
    new MutationObserver(() => (this.cache = {})).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  get(token: string): string {
    return (this.cache[token] ??= getComputedStyle(this.el).getPropertyValue(token).trim() || '#888');
  }
}

/** Runs a model at 60 ticks a second of real time while the widget is on screen. */
class Runner {
  playing = true;
  private acc = 0;
  private last = 0;
  private visible = false;
  private raf = 0;
  constructor(
    el: HTMLElement,
    private step: () => void,
    private draw: () => void,
  ) {
    new IntersectionObserver((es) => {
      this.visible = es.some((e) => e.isIntersecting);
      if (this.visible && !this.raf) {
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.tick);
      }
    }).observe(el);
  }
  private tick = (t: number) => {
    this.raf = 0;
    if (!this.visible) return;
    const dt = Math.min(t - this.last, 100);
    this.last = t;
    if (this.playing) {
      this.acc += dt;
      while (this.acc >= TICK_MS) {
        this.step();
        this.acc -= TICK_MS;
      }
    }
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };
}

/** Arrow keys or WASD on a focused canvas; null when nobody has pressed anything for a while. */
class Keys {
  private down = new Set<string>();
  private lastUse = -1e9;
  constructor(el: HTMLElement) {
    el.tabIndex = 0;
    const map: Record<string, string> = { ArrowUp: 'u', ArrowDown: 'd', ArrowLeft: 'l', ArrowRight: 'r', w: 'u', s: 'd', a: 'l', d: 'r', W: 'u', S: 'd', A: 'l', D: 'r' };
    el.addEventListener('keydown', (e) => {
      const k = map[e.key];
      if (!k) return;
      e.preventDefault();
      this.down.add(k);
      this.lastUse = performance.now();
    });
    el.addEventListener('keyup', (e) => {
      const k = map[e.key];
      if (k) this.down.delete(k);
      this.lastUse = performance.now();
    });
    el.addEventListener('blur', () => this.down.clear());
  }
  input(): Input | null {
    if (this.down.size) this.lastUse = performance.now();
    if (performance.now() - this.lastUse > 2000) return null;
    return { mx: (this.down.has('r') ? 1 : 0) - (this.down.has('l') ? 1 : 0), my: (this.down.has('d') ? 1 : 0) - (this.down.has('u') ? 1 : 0), fire: false };
  }
}

/** Draws arenas into rectangles of a canvas. Arena y grows downwards on screen. */
class Painter {
  constructor(
    public ctx: CanvasRenderingContext2D,
    public pal: Palette,
  ) {}
  arena(x: number, y: number, w: number, walls: Wall[], title: string): (p: { x: number; y: number }) => [number, number] {
    const ctx = this.ctx;
    const k = w / ARENA.w;
    const hgt = ARENA.h * k;
    ctx.fillStyle = this.pal.get('--bg');
    ctx.fillRect(x, y, w, hgt);
    ctx.strokeStyle = this.pal.get('--line');
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, hgt - 1);
    ctx.fillStyle = this.pal.get('--line');
    for (const [x0, y0, x1, y1] of walls) ctx.fillRect(x + x0 * k, y + y0 * k, (x1 - x0) * k, (y1 - y0) * k);
    if (title) {
      ctx.fillStyle = this.pal.get('--muted');
      ctx.font = `${Math.round(w / 34)}px sans-serif`;
      ctx.fillText(title, x + 8, y + Math.round(w / 34) + 6);
    }
    return (p) => [x + p.x * k, y + p.y * k];
  }
  player(at: (p: { x: number; y: number }) => [number, number], p: Player, colour: string, style: 'solid' | 'ghost' | 'outline', scale: number, label = ''): void {
    const ctx = this.ctx;
    const [cx, cy] = at(p);
    const r = RADIUS * scale;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (style === 'solid') {
      ctx.fillStyle = colour;
      ctx.fill();
    } else {
      ctx.globalAlpha = style === 'ghost' ? 0.35 : 1;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2;
      ctx.setLineDash(style === 'outline' ? [4, 3] : []);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    if (label) {
      ctx.fillStyle = this.pal.get('--ink');
      ctx.font = `${Math.round(r * 1.1)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(label, cx, cy - r - 4);
      ctx.textAlign = 'left';
    }
  }
}

function canvas(w: number, hgt: number, label: string): HTMLCanvasElement {
  return h('canvas', { class: 'net-canvas', width: String(w), height: String(hgt), 'aria-label': label }) as HTMLCanvasElement;
}

function linkFrom(lat: number, jitter: number, loss: number): LinkSettings {
  return { latency: lat, jitter, loss };
}

// =============================================================================================
// 1. The problem

export class ProblemViz {
  private m!: DumbTerminal;
  private lat = 50;
  private jitter = 5;
  private loss = 0;
  private cv = canvas(960, 440, 'The server, your screen, and the packets between them');
  private p: Painter;
  private keys: Keys;
  private out = h('div', { class: 'll-stats' });

  constructor(host: HTMLElement) {
    const root = frame(host, 'net-problem');
    this.p = new Painter(this.cv.getContext('2d')!, new Palette(this.cv));
    this.keys = new Keys(this.cv);
    this.reset();
    root.append(
      seg<string>('Latency', LATENCY, String(this.lat), (v) => ((this.lat = Number(v)), this.reset())).el,
      seg<string>('Jitter', [['0', 'none'], ['5', '0–5 ms'], ['30', '0–30 ms']], String(this.jitter), (v) => ((this.jitter = Number(v)), this.reset())).el,
      seg<string>('Loss', [['0', 'none'], ['0.05', '5%'], ['0.2', '20%']], String(this.loss), (v) => ((this.loss = Number(v)), this.reset())).el,
      this.cv,
      this.out,
      h(
        'p',
        { class: 'll-muted net-note' },
        'Click the picture and use the arrow keys (or WASD) to drive the player marked “you”. On your screen, the dashed ring is where you really are, on the server. Underneath: how long your last key press took to reach the server and come back, and how evenly new states have been arriving.',
      ),
    );
    new Runner(this.cv, () => this.m.step(), () => this.draw());
  }
  private reset(): void {
    this.m = new DumbTerminal({ link: linkFrom(this.lat, this.jitter, this.loss), bots: 2, seed: 1 });
    const script = this.m.input;
    this.m.input = (t, me) => this.keys.input() ?? script(t, me);
  }
  private draw(): void {
    const p = this.p;
    const m = this.m;
    p.ctx.clearRect(0, 0, 960, 440);
    const left = p.arena(0, 0, 470, [], 'The server: the real game');
    const right = p.arena(490, 0, 470, [], 'Your screen: the newest state that has arrived');
    const k = 470 / ARENA.w;
    const cols = [p.pal.get('--c1'), p.pal.get('--c3'), p.pal.get('--c4')];
    m.server.players.forEach((pl, i) => p.player(left, pl, cols[i % 3], 'solid', k, i === 0 ? 'you' : ''));
    if (m.shown) m.shown.players.forEach((pl, i) => p.player(right, pl, cols[i % 3], 'solid', k, i === 0 ? 'you' : ''));
    m.server.players.slice(0, 1).forEach((pl) => p.player(right, pl, cols[0], 'outline', k));
    this.drawDelays(305);
    if (m.frames % 10 === 0)
      this.out.replaceChildren(
        ...stats([
          [`${Math.round(m.averageDelay)} ms`, 'from pressing a key to seeing it'],
          [`${((100 * m.framesNoNew) / Math.max(1, m.frames)).toFixed(0)}%`, 'of frames with nothing new to draw'],
          [`${Math.round(m.longestGap)} ms`, 'longest freeze'],
        ]),
      );
  }

  /** The round trip of the last key press, and a histogram of the gaps between new states. */
  private drawDelays(y: number): void {
    const p = this.p;
    const m = this.m;
    const ctx = p.ctx;
    ctx.fillStyle = p.pal.get('--bg');
    ctx.fillRect(0, y, 960, 135);
    ctx.textBaseline = 'middle';
    // Row 1: the last key press, to the server and back, on a 0–500 ms scale.
    const x0 = 200;
    const scale = (960 - x0 - 20) / 500;
    ctx.font = '13px sans-serif';
    ctx.fillStyle = p.pal.get('--muted');
    ctx.fillText('Your last key press', 10, y + 22);
    ctx.strokeStyle = p.pal.get('--line');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y + 38);
    ctx.lineTo(x0 + 500 * scale, y + 38);
    for (let ms = 0; ms <= 500; ms += 100) {
      ctx.moveTo(x0 + ms * scale, y + 38);
      ctx.lineTo(x0 + ms * scale, y + 42);
    }
    ctx.stroke();
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = p.pal.get('--muted');
    for (let ms = 0; ms <= 500; ms += 100) ctx.fillText(`${ms} ms`, x0 + ms * scale, y + 50);
    ctx.textAlign = 'left';
    ctx.font = '13px sans-serif';
    const lp = m.lastPress;
    if (lp) {
      const a = Math.min(lp.up, 500) * scale;
      const b = Math.min(lp.down, 500 - Math.min(lp.up, 500)) * scale;
      ctx.fillStyle = p.pal.get('--c1');
      ctx.fillRect(x0, y + 12, a, 20);
      ctx.fillStyle = p.pal.get('--c5');
      ctx.fillRect(x0 + a, y + 12, b, 20);
      ctx.fillStyle = p.pal.get('--bg');
      if (a > 130) ctx.fillText(`to the server ${Math.round(lp.up)} ms`, x0 + 8, y + 22);
      if (b > 130) ctx.fillText(`back to you ${Math.round(lp.down)} ms`, x0 + a + 8, y + 22);
      ctx.fillStyle = p.pal.get('--ink');
      const tx = x0 + a + b + 8;
      if (tx < 900) ctx.fillText(`${Math.round(lp.up + lp.down)} ms`, tx, y + 22);
    } else {
      ctx.fillStyle = p.pal.get('--muted');
      ctx.fillText('waiting for a key press to come back…', x0, y + 22);
    }
    // Row 2: gaps between new states over the last 3 seconds, as a histogram.
    ctx.fillStyle = p.pal.get('--muted');
    ctx.fillText('Gaps between new', 10, y + 82);
    ctx.fillText('states, last 3 s', 10, y + 100);
    const bins: Array<[string, (g: number) => boolean]> = [
      ['17 ms (every tick)', (g) => g < 25],
      ['33 ms', (g) => g >= 25 && g < 42],
      ['50 ms', (g) => g >= 42 && g < 58],
      ['67 ms or more', (g) => g >= 58],
    ];
    const recent = m.arrivals.filter((t) => t > m.now - 3000);
    const gaps: number[] = [];
    for (let i = 1; i < recent.length; i++) gaps.push(recent[i] - recent[i - 1]);
    const counts = bins.map(([, f]) => gaps.filter(f).length);
    const total = Math.max(1, gaps.length);
    const bw = (960 - x0 - 20) / bins.length;
    bins.forEach(([label], i) => {
      const bx = x0 + i * bw;
      const frac = counts[i] / total;
      const bh = frac * 40;
      ctx.fillStyle = i === 0 ? p.pal.get('--good') : p.pal.get('--alert');
      ctx.fillRect(bx + 8, y + 110 - bh, bw - 16, Math.max(bh, 1));
      ctx.textAlign = 'center';
      ctx.fillStyle = p.pal.get('--ink');
      ctx.font = '12px sans-serif';
      if (counts[i]) ctx.fillText(`${Math.round(frac * 100)}%`, bx + bw / 2, y + 101 - bh);
      ctx.fillStyle = p.pal.get('--muted');
      ctx.font = '11px sans-serif';
      ctx.fillText(label, bx + bw / 2, y + 124);
      ctx.textAlign = 'left';
      ctx.font = '13px sans-serif';
    });
    ctx.textBaseline = 'alphabetic';
  }
}

// =============================================================================================
// 2. Snapshots and interpolation

export class SnapshotViz {
  private m!: SnapshotClient;
  private rate = 20;
  private mode: RemoteMode = 'interpolate';
  private poor = false;
  private cv = canvas(960, 576, 'Other players as the client draws them, with where they really are');
  private p: Painter;
  private out = h('div', { class: 'll-stats' });
  private bw = h('div', { class: 'll-stats' });

  constructor(host: HTMLElement) {
    const root = frame(host, 'net-snap');
    this.p = new Painter(this.cv.getContext('2d')!, new Palette(this.cv));
    this.reset();
    root.append(
      seg<string>('Snapshots', [['10', '10 a second'], ['20', '20 a second'], ['60', '60 a second']], String(this.rate), (v) => ((this.rate = Number(v)), this.reset())).el,
      seg<RemoteMode>('Draw', [['latest', 'Newest snapshot'], ['interpolate', 'Interpolate (2 snapshots behind)'], ['extrapolate', 'Extrapolate']], this.mode, (v) => ((this.mode = v), this.reset())).el,
      h('div', { class: 'll-row' }, chk('Poor connection (100 ms, 0–40 ms jitter, 5% loss)', false, (v) => ((this.poor = v), this.reset()))),
      this.cv,
      this.out,
      h('div', { class: 'll-h' }, 'Bandwidth, server to this client'),
      this.bw,
      h('p', { class: 'll-muted net-note' }, 'Solid: where the client draws each player. Faint rings: where they really are right now, on the server.'),
    );
    new Runner(this.cv, () => this.m.step(), () => this.draw());
  }
  private reset(): void {
    this.m = new SnapshotClient({ link: this.poor ? linkFrom(100, 40, 0.05) : linkFrom(50, 10, 0.02), rate: this.rate, mode: this.mode, delay: 2000 / this.rate, bots: 12, seed: 1 });
  }
  private draw(): void {
    const p = this.p;
    const m = this.m;
    const at = p.arena(0, 0, 960, [], '');
    const k = 960 / ARENA.w;
    const cols = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c7'].map((c) => p.pal.get(c));
    m.server.players.forEach((pl, i) => p.player(at, pl, cols[i % 6], 'ghost', k));
    m.drawn.forEach((pl, i) => p.player(at, pl, cols[i % 6], 'solid', k));
    if (m.tick % 10 === 0) {
      const mins = m.now / 60000 || 1;
      this.out.replaceChildren(
        ...stats([
          [`${m.averageError.toFixed(2)} m`, 'average distance from where they really are'],
          [`${(m.jumps / mins / 12).toFixed(0)}`, 'visible jumps a minute, per player'],
        ]),
      );
      const b = m.bytesPerSecond;
      const kb = (x: number) => `${(x / 1000).toFixed(1)} kB/s`;
      this.bw.replaceChildren(...stats([[kb(b.full), 'full floats'], [kb(b.quantised), 'quantised'], [kb(b.delta), 'quantised, changes only']]));
    }
  }
}

// =============================================================================================
// 3. Prediction and reconciliation

export class PredictionViz {
  private m!: PredictedClient;
  private mode: OwnMode = 'reconcile';
  private lat = 100;
  private predictPlayers = false;
  private cv = canvas(960, 576, 'Your screen, with the server’s idea of where you are');
  private p: Painter;
  private keys: Keys;
  private out = h('div', { class: 'll-stats' });

  constructor(host: HTMLElement) {
    const root = frame(host, 'net-predict');
    this.p = new Painter(this.cv.getContext('2d')!, new Palette(this.cv));
    this.keys = new Keys(this.cv);
    this.reset();
    root.append(
      seg<OwnMode>('Your player', [['wait', 'Wait for the server'], ['predict', 'Predict'], ['reconcile', 'Predict and reconcile'], ['smooth', 'Reconcile, smoothed']], this.mode, (v) => ((this.mode = v), this.reset())).el,
      seg<string>('Latency', LATENCY, String(this.lat), (v) => ((this.lat = Number(v)), this.reset())).el,
      h('div', { class: 'll-row' }, chk('Client also predicts bumping into other players (where it sees them)', false, (v) => ((this.predictPlayers = v), this.reset()))),
      this.cv,
      this.out,
      h(
        'p',
        { class: 'll-muted net-note' },
        'Click the picture and drive with the arrow keys or WASD. The dashed ring is where the server last said you were. Other players are solid on the server: try walking into the guard, who never moves. The pusher walks into you for two seconds in every five.',
      ),
    );
    new Runner(this.cv, () => this.m.step(), () => this.draw());
  }
  private reset(): void {
    this.m = new PredictedClient({ link: linkFrom(this.lat, 10, 0.02), mode: this.mode, seed: 1, predictPlayers: this.predictPlayers });
    const script = this.m.input;
    this.m.input = (t, me) => this.keys.input() ?? script(t, me);
  }
  private draw(): void {
    const p = this.p;
    const m = this.m;
    const at = p.arena(0, 0, 960, PILLARS, '');
    const k = 960 / ARENA.w;
    const cols = [p.pal.get('--c1'), p.pal.get('--c3'), p.pal.get('--c4')];
    if (m.latest) {
      m.latest.players.slice(1).forEach((pl, i) => p.player(at, pl, cols[i + 1], 'solid', k, i === 0 ? 'guard' : 'pusher'));
      p.player(at, m.latest.players[0], cols[0], 'outline', k);
    }
    p.player(at, m.drawnMe, cols[0], 'solid', k, 'you');
    if (m.tick % 10 === 0) {
      const mins = m.now / 60000 || 1;
      this.out.replaceChildren(
        ...stats([
          [`${Math.round(m.averageDelay)} ms`, 'before a turn shows'],
          [`${Math.round(m.corrections / mins)}`, 'corrections a minute'],
          [`${(m.biggestJump * 100).toFixed(0)} cm`, 'biggest jump on screen'],
          [`${m.averageDrift.toFixed(2)} m`, 'average distance from the server’s you'],
        ]),
      );
    }
  }
}

// =============================================================================================
// 4. Lag compensation

export class LagCompViz {
  private m!: LagCompensation;
  private rewind = true;
  private lat = 75;
  private maxRewind = 1000;
  private cv = canvas(960, 576, 'Shooting at a moving player, with and without the server rewinding');
  private p: Painter;
  private out = h('div', { class: 'll-stats' });

  constructor(host: HTMLElement) {
    const root = frame(host, 'net-lagcomp');
    this.p = new Painter(this.cv.getContext('2d')!, new Palette(this.cv));
    this.reset();
    root.append(
      h('div', { class: 'll-row' }, chk('Server rewinds to what you saw', this.rewind, (v) => ((this.rewind = v), this.reset()))),
      seg<string>('Latency', [['25', '25 ms'], ['75', '75 ms'], ['150', '150 ms']], String(this.lat), (v) => ((this.lat = Number(v)), this.reset())).el,
      seg<string>('Rewind at most', [['100', '100 ms'], ['250', '250 ms'], ['1000', '1 s']], String(this.maxRewind), (v) => ((this.maxRewind = Number(v)), this.reset())).el,
      this.cv,
      this.out,
      h('p', { class: 'll-muted net-note' }, 'You (top) fire at the target exactly where your screen shows it, twice a second. The faint ring is where it really is. Lines turn green for a hit and red for a miss once the server has decided; the small dot is where the server tested.'),
    );
    new Runner(this.cv, () => this.m.step(), () => this.draw());
  }
  private reset(): void {
    this.m = new LagCompensation({ link: linkFrom(this.lat, 5, 0), delay: 100, rewind: this.rewind, maxRewind: this.maxRewind, seed: 1 });
  }
  private draw(): void {
    const p = this.p;
    const m = this.m;
    const at = p.arena(0, 0, 960, COVER, '');
    const k = 960 / ARENA.w;
    const ctx = p.ctx;
    const [sx, sy] = at(SHOOTER);
    for (const tr of m.traces) {
      if (m.now - tr.at > 1500) continue;
      const [ax, ay] = at(tr.aim);
      ctx.strokeStyle = tr.hit === undefined ? p.pal.get('--muted') : tr.hit ? p.pal.get('--good') : p.pal.get('--alert');
      ctx.globalAlpha = 1 - (m.now - tr.at) / 1500;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (ax - sx) * 1.15, sy + (ay - sy) * 1.15);
      ctx.stroke();
      if (tr.tested) {
        const [tx, ty] = at(tr.tested);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.arc(tx, ty, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    const truth = targetAt(m.tick);
    p.player(at, truth, p.pal.get('--c3'), 'ghost', k);
    if (m.seen) p.player(at, m.seen, p.pal.get('--c3'), 'solid', k, 'target');
    p.player(at, { x: SHOOTER.x, y: SHOOTER.y, vx: 0, vy: 0 }, p.pal.get('--c1'), 'solid', k, 'you');
    if (m.tick % 10 === 0) {
      const n = m.results.length;
      const hits = m.results.filter((r) => r.hit).length;
      const cover = m.results.filter((r) => r.hit && r.inCover).length;
      this.out.replaceChildren(
        ...stats([
          [`${n ? Math.round((100 * hits) / n) : 0}%`, 'of perfectly aimed shots hit'],
          [`${cover}`, `of ${hits} hits landed after the target reached cover`],
        ]),
      );
    }
  }
}

// =============================================================================================
// 5. Lockstep and rollback

export class SyncViz {
  private m!: PeerToPeer;
  private mode: SyncMode = 'rollback';
  private delay = 0;
  private lat = 50;
  private desync = false;
  private cv = canvas(960, 400, 'Each peer’s screen, and how many frames each tick rolled back');
  private p: Painter;
  private out = h('div', { class: 'll-stats' });
  private log: number[] = [];
  private prev = { rolled: 0, stalls: 0 };

  constructor(host: HTMLElement) {
    const root = frame(host, 'net-sync');
    this.p = new Painter(this.cv.getContext('2d')!, new Palette(this.cv));
    this.reset();
    root.append(
      seg<SyncMode>('Model', [['lockstep', 'Lockstep: wait for inputs'], ['rollback', 'Rollback: predict, then correct']], this.mode, (v) => ((this.mode = v), this.reset())).el,
      seg<string>('Input delay', [['0', '0 frames'], ['1', '1'], ['2', '2'], ['4', '4']], String(this.delay), (v) => ((this.delay = Number(v)), this.reset())).el,
      seg<string>('Latency', [['20', '20 ms'], ['50', '50 ms'], ['100', '100 ms']], String(this.lat), (v) => ((this.lat = Number(v)), this.reset())).el,
      h('div', { class: 'll-row' }, chk('Peer B does the movement maths in a different order', false, (v) => ((this.desync = v), this.reset()))),
      this.cv,
      this.out,
    );
    new Runner(this.cv, () => this.stepOnce(), () => this.draw());
  }
  private reset(): void {
    this.m = new PeerToPeer({ link: linkFrom(this.lat, 5, 0.01), mode: this.mode, inputDelay: this.delay, maxRollback: 8, desync: this.desync, seed: 1 });
    this.log = [];
    this.prev = { rolled: 0, stalls: 0 };
  }
  private stepOnce(): void {
    this.m.step();
    const a = this.m.a;
    const rolled = a.rolledFrames - this.prev.rolled;
    const stalled = a.stalls - this.prev.stalls;
    this.prev = { rolled: a.rolledFrames, stalls: a.stalls };
    this.log.push(stalled ? -1 : rolled);
    if (this.log.length > 240) this.log.shift();
  }
  private draw(): void {
    const p = this.p;
    const m = this.m;
    const k = 470 / ARENA.w;
    const cols = [p.pal.get('--c1'), p.pal.get('--c2')];
    const A = p.arena(0, 0, 470, [], `Peer A, frame ${m.a.frame}`);
    const B = p.arena(490, 0, 470, [], `Peer B, frame ${m.b.frame}`);
    m.a.state.players.forEach((pl, i) => p.player(A, pl, cols[i], 'solid', k, i === 0 ? 'A' : 'B'));
    m.b.state.players.forEach((pl, i) => p.player(B, pl, cols[i], 'solid', k, i === 0 ? 'A' : 'B'));
    // Rollback strip: one bar per tick, height = frames rolled back; red = stalled.
    const ctx = p.ctx;
    const y0 = 290;
    const hgt = 100;
    ctx.fillStyle = p.pal.get('--bg');
    ctx.fillRect(0, y0, 960, hgt + 10);
    ctx.fillStyle = p.pal.get('--muted');
    ctx.font = '12px sans-serif';
    ctx.fillText('Peer A, each tick: frames re-simulated (bars), or waiting for input (red)', 6, y0 + 12);
    const bw = 960 / 240;
    this.log.forEach((v, i) => {
      if (v < 0) {
        ctx.fillStyle = p.pal.get('--alert');
        ctx.fillRect(i * bw, y0 + hgt - 8, bw - 0.5, 8);
      } else if (v > 0) {
        ctx.fillStyle = p.pal.get('--c2');
        const bh = Math.min(v, 8) * ((hgt - 22) / 8);
        ctx.fillRect(i * bw, y0 + hgt - bh, bw - 0.5, bh);
      }
    });
    if (m.tick % 10 === 0) {
      const a = m.a;
      const secs = m.now / 1000 || 1;
      const items: Array<[string | number, string]> =
        this.mode === 'lockstep'
          ? [
              [`${((100 * a.stalls) / Math.max(1, m.tick)).toFixed(0)}%`, 'of ticks spent waiting'],
              [`${Math.round((a.frame / secs) * 1)}`, 'frames a second'],
            ]
          : [
              [`${(a.rollbacks / secs).toFixed(1)}`, 'rollbacks a second'],
              [`${(a.rolledFrames / Math.max(1, a.rollbacks)).toFixed(1)}`, 'frames re-simulated each time'],
              [`${a.deepest}`, 'deepest'],
            ];
      items.push([a.desyncAt >= 0 || m.b.desyncAt >= 0 ? `desync at frame ${Math.max(a.desyncAt, m.b.desyncAt)}` : 'in sync', 'checksums']);
      this.out.replaceChildren(...stats(items));
    }
  }
}

