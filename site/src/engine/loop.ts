import { h, seg, fmt } from './dom';

/**
 * Game loop laboratory. A virtual clock produces "frames" (with a chosen frame
 * rate, jitter, hitches, and a simulated cost per sim step), and a loop strategy
 * decides how the simulation advances in each frame:
 *   variable dt:          one step of the frame's length
 *   fixed dt:             an accumulator runs whole steps of a fixed length
 *   fixed + interpolate:  the same, rendering between the last two states
 * The scene is a few balls bouncing under gravity, integrated with semi-implicit
 * Euler, so results depend on the step size the way real game physics does.
 */

type Mode = 'variable' | 'fixed' | 'interp';
type Speed = '1' | '4' | '16' | 'max';

interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}
const W = 10; // world width (m)
const G = -9.81;
const R = 0.25;
const REST = 0.85;

function initBalls(): Ball[] {
  return [
    { x: 1, y: 5, vx: 2.4, vy: 0 },
    { x: 3, y: 2, vx: -1.7, vy: 4 },
    { x: 6.5, y: 4.5, vx: 3.1, vy: 1.5 },
  ];
}
function stepBalls(bs: Ball[], dt: number): void {
  for (const b of bs) {
    b.vy += G * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.y < R) {
      b.y = R;
      b.vy = -b.vy * REST;
    }
    if (b.x < R) {
      b.x = R;
      b.vx = -b.vx;
    } else if (b.x > W - R) {
      b.x = W - R;
      b.vx = -b.vx;
    }
  }
}
const clone = (bs: Ball[]) => bs.map((b) => ({ ...b }));

interface FrameRec {
  t: number; // virtual wall time at frame start (ms)
  dur: number; // frame duration (ms)
  steps: number;
  acc: number; // accumulator after stepping (ms)
  dropped: number;
}

export class LoopViz {
  private root: HTMLElement;
  private mode: Mode = 'interp';
  private simHz = 30;
  private fps = 60;
  private jitter = false;
  private stepCost = 0.5; // ms of CPU per sim step (virtual)
  private clamp = true;
  private speed: Speed = '1';
  private hitchNext = false;

  private balls: Ball[] = initBalls();
  private prev: Ball[] = initBalls();
  private simTime = 0; // s
  private wall = 0; // virtual ms
  private acc = 0; // ms
  private frames: FrameRec[] = [];
  private totalSteps = 0;
  private dropped = 0;
  private real = 0; // real ms accumulated toward the next virtual frame
  private lastReal = 0;
  private nextFrameDur = 1000 / 60;
  private raf = 0;
  private running = true;
  private trail: Array<{ x: number; y: number }> = [];

  private canvas!: HTMLCanvasElement;
  private timeline!: HTMLCanvasElement;
  private stats!: HTMLElement;
  private codeEl!: HTMLElement;
  private headlessEl!: HTMLElement;
  private pauseBtn!: HTMLButtonElement;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ll-loop' });
    host.replaceChildren(this.root);
    this.build();
    this.reset();
    this.lastReal = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    // Stop animating when the widget is off screen.
    new IntersectionObserver((es) => {
      const vis = es.some((e) => e.isIntersecting);
      if (vis && this.running && !this.raf) {
        this.lastReal = performance.now();
        this.raf = requestAnimationFrame(this.tick);
      } else if (!vis && this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
    }).observe(this.root);
  }

  private build(): void {
    const modeSeg = seg<Mode>(
      'Loop',
      [
        ['variable', 'Variable dt'],
        ['fixed', 'Fixed dt'],
        ['interp', 'Fixed dt + interpolation'],
      ],
      this.mode,
      (v) => {
        this.mode = v;
        this.reset();
      },
    );
    const hzSeg = seg<string>(
      'Sim rate',
      [
        ['10', '10 Hz'],
        ['30', '30 Hz'],
        ['60', '60 Hz'],
      ],
      String(this.simHz),
      (v) => {
        this.simHz = Number(v);
        this.reset();
      },
    );
    const fpsSeg = seg<string>(
      'Frame rate',
      [
        ['20', '20'],
        ['60', '60'],
        ['144', '144'],
      ],
      String(this.fps),
      (v) => {
        this.fps = Number(v);
      },
    );
    const speedSeg = seg<Speed>(
      'Sim speed',
      [
        ['1', '×1'],
        ['4', '×4'],
        ['16', '×16'],
        ['max', 'As fast as possible'],
      ],
      this.speed,
      (v) => {
        this.speed = v;
      },
    );
    const jit = h('input', { type: 'checkbox' });
    jit.addEventListener('change', () => (this.jitter = jit.checked));
    const cl = h('input', { type: 'checkbox', checked: true });
    cl.addEventListener('change', () => (this.clamp = cl.checked));
    const cost = h('input', { type: 'range', min: '0', max: '60', step: '0.5', value: String(this.stepCost), 'aria-label': 'Cost of one sim step' });
    const costOut = h('output', {}, `${this.stepCost} ms`);
    cost.addEventListener('input', () => {
      this.stepCost = Number(cost.value);
      costOut.textContent = `${this.stepCost} ms`;
    });
    this.pauseBtn = h('button', { type: 'button', class: 'll-btn', onclick: () => this.togglePause() }, 'Pause');
    this.canvas = h('canvas', { class: 'lp-scene', width: '800', height: '480', 'aria-label': 'Simulation' });
    this.timeline = h('canvas', { class: 'lp-time', width: '800', height: '120', 'aria-label': 'Frames and simulation steps over time' });
    this.stats = h('div', { class: 'll-stats' });
    this.codeEl = h('pre', { class: 'll-code lp-code' });
    this.headlessEl = h('div', { class: 'lp-headless' });
    this.root.append(
      h('div', { class: 'll-row' }, modeSeg.el),
      h('div', { class: 'll-row' }, hzSeg.el, fpsSeg.el),
      h(
        'div',
        { class: 'll-row' },
        h('label', { class: 'll-chk' }, jit, ' jittery frames'),
        h('button', { type: 'button', class: 'll-btn', onclick: () => (this.hitchNext = true) }, 'Hitch (one 250 ms frame)'),
        h('label', { class: 'll-chk lp-cost' }, 'cost per sim step ', cost, costOut),
        h('label', { class: 'll-chk' }, cl, ' max 5 steps per frame'),
      ),
      h('div', { class: 'll-row' }, speedSeg.el, this.pauseBtn, h('button', { type: 'button', class: 'll-btn', onclick: () => this.reset() }, 'Restart')),
      this.canvas,
      this.stats,
      h('div', { class: 'll-h' }, 'Last second: frames (top) and sim steps (bottom)'),
      this.timeline,
      this.codeEl,
      this.headlessEl,
    );
  }

  private reset(): void {
    this.balls = initBalls();
    this.prev = initBalls();
    this.simTime = 0;
    this.wall = 0;
    this.acc = 0;
    this.frames = [];
    this.totalSteps = 0;
    this.dropped = 0;
    this.real = 0;
    this.trail = [];
    this.ref = { dt: 0, n: 0, balls: initBalls() };
    this.nextFrameDur = this.frameDur(0);
    this.codeEl.textContent = this.code();
    this.headlessEl.replaceChildren();
  }

  private code(): string {
    if (this.mode === 'variable')
      return `while (running) {
    double now = clock();
    double dt = now - last; last = now;
    simulate(state, dt);        // a different step every frame
    render(state);
}`;
    return `const double dt = 1.0 / ${this.simHz};      // fixed step
while (running) {
    double now = clock();
    acc += now - last; last = now;
    int steps = 0;
    while (acc >= dt && steps < ${this.clamp ? '5' : 'INT_MAX'}) {   // ${this.clamp ? 'clamp: never fall into a spiral' : 'no clamp'}
        previous = current;
        simulate(current, dt);
        acc -= dt; ++steps;
    }${this.clamp ? '\n    if (steps == 5 && acc >= dt) acc = 0;   // drop the backlog instead' : ''}
    render(${this.mode === 'interp' ? 'lerp(previous, current, acc / dt)' : 'current'});
}`;
  }

  private frameDur(stepsLast: number): number {
    let d = 1000 / this.fps;
    if (this.jitter) d *= 0.4 + Math.random() * 1.6;
    if (this.hitchNext) {
      d = 250;
      this.hitchNext = false;
    }
    // A frame can't be shorter than the work it did: the sim steps plus a little render time.
    return Math.max(d, stepsLast * this.stepCost + 1);
  }

  private togglePause(): void {
    this.running = !this.running;
    this.pauseBtn.textContent = this.running ? 'Pause' : 'Resume';
    if (this.running && !this.raf) {
      this.lastReal = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  private tick = (now: number): void => {
    this.raf = 0;
    if (!this.running) return;
    const realDt = Math.min(100, now - this.lastReal);
    this.lastReal = now;
    if (this.speed === 'max') {
      this.headless();
    } else {
      this.real += realDt * Number(this.speed);
      let guard = 0;
      while (this.real >= this.nextFrameDur && guard++ < 50) {
        this.real -= this.nextFrameDur;
        this.frame(this.nextFrameDur);
      }
    }
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  /** One virtual frame of length `dur` ms. */
  private frame(dur: number): void {
    this.wall += dur;
    let steps = 0;
    let dropped = 0;
    const dtMs = 1000 / this.simHz;
    if (this.mode === 'variable') {
      this.prev = clone(this.balls);
      stepBalls(this.balls, dur / 1000);
      this.simTime += dur / 1000;
      steps = 1;
    } else {
      this.acc += dur;
      while (this.acc >= dtMs && (!this.clamp || steps < 5)) {
        this.prev = clone(this.balls);
        stepBalls(this.balls, dtMs / 1000);
        this.simTime += dtMs / 1000;
        this.acc -= dtMs;
        steps++;
      }
      if (this.clamp && steps >= 5 && this.acc >= dtMs) {
        dropped = this.acc;
        this.dropped += this.acc;
        this.acc = 0;
      }
    }
    this.totalSteps += steps;
    this.frames.push({ t: this.wall - dur, dur, steps, acc: this.acc, dropped });
    while (this.frames.length && this.frames[0].t < this.wall - 1000) this.frames.shift();
    const p = this.renderPos()[0];
    this.trail.push(p);
    if (this.trail.length > 40) this.trail.shift();
    this.nextFrameDur = this.frameDur(steps);
  }

  /** Run the sim decoupled from rendering: as many steps as fit in ~12 ms of real time. */
  private headless(): void {
    const dt = 1 / this.simHz;
    const t0 = performance.now();
    let n = 0;
    do {
      for (let k = 0; k < 1000; k++) {
        this.prev = clone(this.balls);
        stepBalls(this.balls, dt);
      }
      n += 1000;
    } while (performance.now() - t0 < 12);
    this.simTime += n * dt;
    this.totalSteps += n;
    const ms = performance.now() - t0;
    this.headlessEl.replaceChildren(
      h('b', {}, `${fmt(n)} steps in ${fmt(ms, 1)} ms of real time`),
      ` = ${fmt((n * dt) / (ms / 1000))}× real time. Rendering only shows the latest state: the simulation doesn't wait for frames at all.`,
    );
    this.frames = [];
  }

  private renderPos(): Array<{ x: number; y: number }> {
    if (this.mode !== 'interp') return this.balls.map((b) => ({ x: b.x, y: b.y }));
    const a = Math.min(1, this.acc / (1000 / this.simHz));
    return this.balls.map((b, i) => ({ x: this.prev[i].x + (b.x - this.prev[i].x) * a, y: this.prev[i].y + (b.y - this.prev[i].y) * a }));
  }

  private col(name: string): string {
    return getComputedStyle(this.root).getPropertyValue(name).trim() || '#888';
  }

  private draw(): void {
    const c = this.canvas;
    const ctx = c.getContext('2d')!;
    const cw = c.width;
    const ch = c.height;
    const s = cw / W;
    const X = (x: number) => x * s;
    const Y = (y: number) => ch - y * s;
    ctx.fillStyle = this.col('--bg');
    ctx.fillRect(0, 0, cw, ch);
    ctx.strokeStyle = this.col('--line-soft');
    ctx.lineWidth = 1;
    for (let gx = 1; gx < W; gx++) {
      ctx.beginPath();
      ctx.moveTo(X(gx), 0);
      ctx.lineTo(X(gx), ch);
      ctx.stroke();
    }
    // Trail of rendered positions for ball 0: even spacing = smooth, uneven = judder.
    ctx.fillStyle = this.col('--muted');
    this.trail.forEach((p, i) => {
      ctx.globalAlpha = (i / this.trail.length) * 0.6;
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), 3, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    const pos = this.speed === 'max' ? this.balls : this.renderPos();
    const cols = ['--c1', '--c2', '--c3'];
    pos.forEach((p, i) => {
      ctx.fillStyle = this.col(cols[i]);
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), R * s, 0, Math.PI * 2);
      ctx.fill();
    });
    this.drawTimeline();
    this.drawStats();
  }

  private drawTimeline(): void {
    const c = this.timeline;
    const ctx = c.getContext('2d')!;
    const cw = c.width;
    const ch = c.height;
    ctx.fillStyle = this.col('--bg');
    ctx.fillRect(0, 0, cw, ch);
    if (!this.frames.length) return;
    const t1 = this.wall;
    const t0 = t1 - 1000;
    const X = (t: number) => ((t - t0) / 1000) * cw;
    const ink = this.col('--ink');
    const acc = this.col('--accent');
    const alert = this.col('--alert');
    const muted = this.col('--muted');
    ctx.font = `11px ${this.col('--f-mono')}`;
    ctx.fillStyle = muted;
    ctx.fillText('frames', 4, 12);
    ctx.fillText('sim steps', 4, ch - 6);
    for (const f of this.frames) {
      const x0 = X(f.t);
      const x1 = X(f.t + f.dur);
      ctx.fillStyle = f.dur > 1000 / this.fps * 1.5 ? alert : ink;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(x0 + 1, 18, Math.max(1, x1 - x0 - 2), 30);
      ctx.globalAlpha = 1;
      ctx.fillRect(x0, 18, 1.5, 30);
      // The steps run inside this frame, drawn spread across it.
      for (let k = 0; k < f.steps; k++) {
        const sx = x0 + ((k + 0.5) / Math.max(1, f.steps)) * (x1 - x0);
        ctx.strokeStyle = acc;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(x0 + 0.75, 48);
        ctx.lineTo(sx, ch - 26);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = acc;
        ctx.fillRect(sx - 2, ch - 30, 4, 12);
      }
      if (f.dropped > 0) {
        ctx.fillStyle = alert;
        ctx.fillText(`dropped ${fmt(f.dropped)} ms`, x0 + 3, 62);
      }
    }
  }

  private drawStats(): void {
    const fr = this.frames;
    const span = fr.length ? (fr[fr.length - 1].t + fr[fr.length - 1].dur - fr[0].t) / 1000 : 1;
    const steps = fr.reduce((a, f) => a + f.steps, 0);
    const last = fr[fr.length - 1];
    const stat = (v: string, l: string, title?: string) => h('div', { class: 'll-stat', title }, h('b', {}, v), h('span', {}, l));
    const ref = this.reference();
    const drift = Math.hypot(this.balls[0].x - ref.x, this.balls[0].y - ref.y);
    this.stats.replaceChildren(
      ...(this.speed === 'max'
        ? [stat(`${fmt(this.simTime, 1)} s`, 'simulated')]
        : [
            stat(fmt(fr.length / span), 'frames / s'),
            stat(fmt(steps / span), 'sim steps / s'),
            stat(last ? fmt(last.steps) : '–', 'steps last frame'),
            stat(this.mode === 'variable' ? '–' : `${fmt(this.acc, 1)} ms`, 'in the accumulator'),
            stat(`${fmt(this.simTime, 1)} s / ${fmt(this.wall / 1000, 1)} s`, 'sim time / wall time'),
            this.dropped ? stat(`${fmt(this.dropped)} ms`, 'time dropped by the clamp') : stat('0', 'time dropped'),
          ]),
    );
    if (this.speed !== 'max')
      this.stats.append(
        stat(
          drift < 1e-6 ? 'identical' : `${fmt(drift, 2)} m off`,
          `ball 1 vs a steady ${this.mode === 'variable' ? 60 : this.simHz} Hz run`,
          'A fixed step gives the same result at any frame rate; a variable step does not.',
        ),
      );
  }

  /**
   * Ball 0 after the same simulated time, simulated with a steady fixed step (the
   * current sim rate; 60 Hz for the variable loop). Advanced incrementally.
   */
  private ref = { dt: 0, n: 0, balls: initBalls() };
  private reference(): { x: number; y: number } {
    const dt = this.mode === 'variable' ? 1 / 60 : 1 / this.simHz;
    if (this.ref.dt !== dt || this.ref.n * dt > this.simTime + 1e-9) this.ref = { dt, n: 0, balls: initBalls() };
    while ((this.ref.n + 1) * dt <= this.simTime + 1e-9) {
      stepBalls(this.ref.balls, dt);
      this.ref.n++;
    }
    const rest = this.simTime - this.ref.n * dt;
    if (rest < 1e-9) return this.ref.balls[0];
    const tmp = clone(this.ref.balls);
    stepBalls(tmp, rest);
    return tmp[0];
  }
}
