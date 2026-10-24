/**
 * Physics on the game thread against physics on its own thread at a fixed tick (Unreal's
 * "async physics"), as a timeline. Pure model: frame times come from a seeded generator, so the
 * latencies the lesson quotes are checked by the test suite.
 *
 * - "game": each frame runs the fixed physics steps that fit in the accumulated time, then draws.
 *   An input read at the start of a frame affects that frame's steps and is visible when the frame
 *   is presented.
 * - "async": the physics thread runs ticks back to back on a fixed schedule. Input is handed over
 *   at the start of the next tick, results are published at the end of the tick, and the game
 *   thread draws the latest published tick (optionally interpolating, which shows the result one
 *   tick later still).
 */
import { h, seg } from '../engine/dom';
import { rng } from './scenes';

export type Mode = 'game' | 'async';
export interface Frame {
  start: number;
  end: number;
  /** Physics steps run inside this frame (game mode). */
  steps: number;
}
export interface Tick {
  start: number;
  end: number;
}

export interface Timeline {
  frames: Frame[];
  ticks: Tick[];
}

/** Frame durations around 1/fps with jitter and an occasional long frame. */
export function frames(fps: number, seconds: number, seed = 5): Frame[] {
  const r = rng(seed);
  const out: Frame[] = [];
  let t = 0;
  while (t < seconds) {
    let d = (1 / fps) * (0.85 + r() * 0.3);
    if (r() < 0.04) d *= 2.5;
    out.push({ start: t, end: t + d, steps: 0 });
    t += d;
  }
  return out;
}

export function timeline(fps: number, tickHz: number, seconds: number, seed = 5): Timeline {
  const fr = frames(fps, seconds, seed);
  const dt = 1 / tickHz;
  // Game mode: accumulate frame time, run whole steps.
  let acc = 0;
  for (const f of fr) {
    acc += f.end - f.start;
    while (acc >= dt) {
      f.steps++;
      acc -= dt;
    }
  }
  // Async: ticks on a fixed schedule. Each takes a fraction of its slot to compute.
  const ticks: Tick[] = [];
  for (let k = 0; k * dt < seconds; k++) ticks.push({ start: k * dt, end: k * dt + dt * 0.6 });
  return { frames: fr, ticks };
}

/**
 * When an input pressed at time t first shows on screen.
 * game: read at the next frame start; applied by that frame's steps if it has any (else the next
 * frame with a step); visible at the end of that frame.
 * async: the game thread reads it at the next frame start and queues it; the physics thread takes
 * it at the next tick start after that; the result is published at that tick's end; the next frame
 * to start after publishing draws it (with interpolation, the frame after the following tick).
 */
export function latency(tl: Timeline, mode: Mode, t: number, interpolate: boolean): { shown: number; via: { frameRead: number; tick?: Tick; frameShown: number } } | null {
  const fr = tl.frames;
  const i = fr.findIndex((f) => f.start >= t);
  if (i < 0) return null;
  if (mode === 'game') {
    let j = i;
    while (j < fr.length && fr[j].steps === 0) j++;
    if (j >= fr.length) return null;
    // Interpolating on the game thread draws between the previous and latest step: the input shows
    // fully one step later, but starts to show this frame. Count when it starts to show.
    return { shown: fr[j].end, via: { frameRead: fr[i].start, frameShown: fr[j].end } };
  }
  const handed = fr[i].start;
  let k = tl.ticks.findIndex((tk) => tk.start >= handed);
  if (k < 0) return null;
  if (interpolate) k += 1; // drawn between the previous and latest tick: shows once it's the "previous" one's successor
  const tk = tl.ticks[k];
  if (!tk) return null;
  const f = fr.find((x) => x.start >= tk.end);
  if (!f) return null;
  return { shown: f.end, via: { frameRead: handed, tick: tk, frameShown: f.end } };
}

/** Average input-to-screen latency over inputs spread evenly through the timeline. */
export function averageLatency(fps: number, tickHz: number, mode: Mode, interpolate: boolean, samples = 400, seconds = 10): number {
  const tl = timeline(fps, tickHz, seconds + 1);
  let sum = 0;
  let n = 0;
  for (let s = 0; s < samples; s++) {
    const t = (s / samples) * seconds;
    const l = latency(tl, mode, t, interpolate);
    if (l) {
      sum += l.shown - t;
      n++;
    }
  }
  return sum / n;
}

// ---------------------------------------------------------------------------------------------

export class AsyncViz {
  private root: HTMLElement;
  private canvas = h('canvas', { class: 'ph-canvas', width: '960', height: '300', 'aria-label': 'Game and physics thread timeline' });
  private out = h('div', { class: 'll-stats' });
  private mode: Mode = 'async';
  private fps = 90;
  private hz = 30;
  private interp = true;
  private input = 0.05;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ph ph-async' });
    host.replaceChildren(this.root);
    const ic = h('input', {
      type: 'checkbox',
      onchange: (e: Event) => {
        this.interp = (e.target as HTMLInputElement).checked;
        this.draw();
      },
    }) as HTMLInputElement;
    ic.checked = true;
    this.root.append(
      seg<Mode>('Physics', [['game', 'On the game thread'], ['async', 'Own thread, fixed tick']], this.mode, (m) => ((this.mode = m), this.draw())).el,
      seg<string>('Frame rate', [['60', '60 fps'], ['90', '90 fps'], ['144', '144 fps']], '90', (v) => ((this.fps = Number(v)), this.draw())).el,
      seg<string>('Physics tick', [['30', '30 Hz'], ['60', '60 Hz']], '30', (v) => ((this.hz = Number(v)), this.draw())).el,
      h('label', { class: 'll-chk' }, ic, ' Interpolate between physics results'),
      h('p', { class: 'll-muted ph-note' }, 'Click the timeline to press a key at that moment.'),
      this.canvas,
      this.out,
    );
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.input = ((e.clientX - r.left) / r.width) * 0.2;
      this.draw();
    });
    new MutationObserver(() => this.draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.draw();
  }

  private draw(): void {
    const c = this.canvas;
    const ctx = c.getContext('2d')!;
    const cs = getComputedStyle(c);
    const col = (n: string) => cs.getPropertyValue(n).trim() || '#888';
    const W = c.width;
    const H = c.height;
    const span = 0.2;
    const x = (t: number) => (t / span) * W;
    ctx.fillStyle = col('--bg');
    ctx.fillRect(0, 0, W, H);
    const tl = timeline(this.fps, this.hz, span + 0.2);
    const laneG = 70;
    const laneP = 170;
    ctx.font = '20px sans-serif';
    ctx.fillStyle = col('--muted');
    ctx.fillText('Game thread (frames)', 8, laneG - 30);
    ctx.fillText(this.mode === 'async' ? 'Physics thread (ticks)' : 'Physics steps (inside frames)', 8, laneP - 30);
    for (const f of tl.frames) {
      if (f.start > span) break;
      ctx.fillStyle = col('--c2');
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x(f.start) + 1, laneG - 18, x(f.end) - x(f.start) - 2, 36);
      ctx.globalAlpha = 1;
      if (this.mode === 'game' && f.steps) {
        const w = (x(f.end) - x(f.start) - 4) / f.steps;
        for (let s = 0; s < f.steps; s++) {
          ctx.fillStyle = col('--c3');
          ctx.globalAlpha = 0.6;
          ctx.fillRect(x(f.start) + 2 + s * w, laneP - 18, w - 2, 36);
          ctx.globalAlpha = 1;
        }
      }
    }
    if (this.mode === 'async')
      for (const t of tl.ticks) {
        if (t.start > span) break;
        ctx.fillStyle = col('--c3');
        ctx.globalAlpha = 0.6;
        ctx.fillRect(x(t.start) + 1, laneP - 18, x(t.end) - x(t.start), 36);
        ctx.globalAlpha = 1;
      }
    const l = latency(tl, this.mode, this.input, this.interp);
    // The input and its path.
    ctx.strokeStyle = col('--warn');
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x(this.input), 10);
    ctx.lineTo(x(this.input), H - 40);
    ctx.stroke();
    ctx.fillStyle = col('--warn');
    ctx.fillText('key pressed', Math.min(W - 120, x(this.input) + 6), H - 46);
    if (l) {
      const pts: Array<[number, number]> = [[x(this.input), laneG], [x(l.via.frameRead), laneG]];
      if (l.via.tick) pts.push([x(l.via.tick.start), laneP], [x(l.via.tick.end), laneP]);
      else pts.push([x(l.via.frameRead), laneP], [x(l.via.frameShown) - 4, laneP]);
      pts.push([x(l.via.frameShown), laneG]);
      ctx.strokeStyle = col('--alert');
      ctx.lineWidth = 3;
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.stroke();
      ctx.fillStyle = col('--alert');
      ctx.beginPath();
      ctx.arc(x(l.shown), laneG, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(`on screen after ${((l.shown - this.input) * 1000).toFixed(0)} ms`, Math.min(W - 230, x(l.shown) + 10), laneG + 46);
    }
    // Time axis.
    ctx.fillStyle = col('--muted');
    for (let ms = 0; ms <= 200; ms += 50) ctx.fillText(`${ms} ms`, x(ms / 1000) + 2, H - 10);
    const avg = averageLatency(this.fps, this.hz, this.mode, this.interp);
    this.out.replaceChildren(h('span', { class: 'll-stat' }, h('b', {}, `${(avg * 1000).toFixed(0)} ms`), h('span', {}, 'average from key press to screen, over 400 presses')));
  }
}
