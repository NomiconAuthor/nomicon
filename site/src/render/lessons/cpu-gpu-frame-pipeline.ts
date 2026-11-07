/**
 * "The CPU–GPU frame pipeline": PipelineTimelineViz. The deterministic model in
 * scenes/cpu-gpu-frame-pipeline.ts drawn as a timeline (CPU, GPU, frames waiting to be shown, the
 * display), with the latency from input to photon for one frame marked and the averages beside it.
 * The only live number is the reader's own refresh rate, measured from requestAnimationFrame and
 * shown for reference; the model itself never reads it.
 */
import './perf.css';
import { h, seg } from '../../engine/dom';
import { FRAMES, PIPE_DEFAULTS, type PipeResult, type PipeSettings, type PresentMode, WARMUP, simulate } from '../scenes/cpu-gpu-frame-pipeline';
import { type RGB, Palette, canvas, chk, ctx2d, fit, frame, mix, onTheme, rgbCss, size, stage } from '../view';
import { range, slider } from './perf-common';

/** Logical canvas size and time window (ms), wide and narrow (phones: fewer refreshes, bigger text). */
const WIDE = { w: 900, h: 236, span: 100, font: 12, laneH: 38 };
const NARROW = { w: 520, h: 282, span: 70, font: 15, laneH: 44 };
type Layout = typeof WIDE;
const LANES = ['CPU', 'GPU', 'Waiting', 'Display'];
const COLS = ['--c1', '--c2', '--c3', '--c5', '--c6', '--c4'];
const ms1 = (x: number) => `${x.toFixed(1)} ms`;

export class PipelineTimelineViz {
  private s: PipeSettings = { ...PIPE_DEFAULTS };
  private pal: Palette;
  private L: Layout = WIDE;
  private cv = this.makeCanvas(WIDE);
  private side = h('div', {});
  private refresh = h('p', { class: 'rp-fine' });
  private r: PipeResult;
  private stageEl: HTMLElement;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-pipe');
    this.pal = new Palette(root);
    this.r = simulate(this.s);
    this.stageEl = stage(this.cv);
    const set = <K extends keyof PipeSettings>(k: K) => (v: PipeSettings[K]) => {
      this.s[k] = v;
      this.update();
    };
    root.append(
      this.stageEl,
      h(
        'div',
        { class: 'rp-controls' },
        slider('CPU: simulation', range(1, 20, 1), this.s.sim, (v) => `${v} ms`, set('sim')),
        slider('CPU: render', range(1, 20, 1), this.s.render, (v) => `${v} ms`, set('render')),
        slider('GPU', range(1, 30, 1), this.s.gpu, (v) => `${v} ms`, set('gpu')),
      ),
      h(
        'div',
        { class: 'rp-controls' },
        seg<string>('Frames in flight', ['1', '2', '3'].map((v) => [v, v] as [string, string]), String(this.s.inFlight), (v) => set('inFlight')(Number(v))).el,
        seg<PresentMode>(
          'Present mode',
          [
            ['fifo', 'FIFO (vsync)'],
            ['mailbox', 'Mailbox'],
            ['immediate', 'Immediate'],
          ],
          this.s.present,
          set('present'),
        ).el,
        seg<string>('Refresh', ['60', '120', '144'].map((v) => [v, `${v} Hz`] as [string, string]), String(this.s.hz), (v) => set('hz')(Number(v))).el,
        chk('Start each frame just in time', this.s.late, set('late')),
      ),
      this.side,
      this.refresh,
    );
    // Phones get a shorter time window with larger text rather than the wide one scaled down.
    if (typeof ResizeObserver !== 'undefined')
      new ResizeObserver(() => {
        const L = root.clientWidth < 600 ? NARROW : WIDE;
        if (L === this.L) return;
        this.L = L;
        const c = this.makeCanvas(L);
        this.cv.replaceWith(c);
        this.cv = c;
        this.draw();
      }).observe(root);
    onTheme(() => {
      this.pal.reset();
      this.draw();
    });
    this.update();
    this.measureRefresh();
  }

  private makeCanvas(L: Layout): HTMLCanvasElement {
    const c = canvas(L.w, L.h, 'A timeline of frames through the CPU, the GPU, the present queue and the display', 'rd-canvas', { maxWidth: L.w });
    fit(c, () => this.draw());
    return c;
  }

  private update(): void {
    this.r = simulate(this.s);
    this.draw();
    const r = this.r;
    const lat = r.latency;
    const row = (k: string, v: string) => h('tr', {}, h('th', {}, k), h('td', {}, v));
    this.side.replaceChildren(
      h(
        'table',
        { class: 'rd-tab' },
        h(
          'tbody',
          {},
          h('tr', { class: 'rp-total' }, h('th', {}, 'Input to photon'), h('td', {}, lat.max - lat.min < 0.05 ? ms1(lat.mean) : `${ms1(lat.mean)} on average (${ms1(lat.min)} to ${ms1(lat.max)})`)),
          row('Frames shown a second', `${Math.round(r.fps)}`),
          row('Frames drawn but never shown', `${Math.round(100 * r.dropped)}%`),
          row('GPU busy', `${Math.round(100 * r.gpuBusy)}%`),
          row('Swapchain images', String(r.images)),
        ),
      ),
      h('p', { class: 'rp-fine' }, `A model, the same on every machine: frames ${WARMUP} to ${FRAMES} of a steady run. Latency runs from the input read at the start of the frame's simulation to the refresh that starts showing it; the display's own processing and scan-out come on top.`),
    );
  }

  /** The reader's refresh interval, from requestAnimationFrame: for reference only. */
  private measureRefresh(): void {
    if (typeof requestAnimationFrame === 'undefined') return;
    const t: number[] = [];
    const step = (now: number) => {
      t.push(now);
      if (t.length < 61) requestAnimationFrame(step);
      else {
        const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
        const m = d[Math.floor(d.length / 2)];
        this.refresh.textContent = `For reference, this page's animation frames arrive about every ${m.toFixed(1)} ms here, roughly ${Math.round(1000 / m)} Hz (measured live; a browser may run them slower than the display, for instance on battery).`;
      }
    };
    requestAnimationFrame(step);
  }

  private draw(): void {
    const ctx = ctx2d(this.cv);
    const { w, h: hh } = size(this.cv);
    const pal = this.pal;
    const bg = pal.rgb('--bg');
    const ink = pal.css('--ink');
    const muted = pal.css('--muted');
    const line = pal.css('--line');
    ctx.clearRect(0, 0, w, hh);
    ctx.fillStyle = rgbCss(bg);
    ctx.fillRect(0, 0, w, hh);
    const r = this.r;
    const T = r.T;
    // The window: from the first refresh at or after frame WARMUP starts.
    const t0 = Math.ceil(r.frames[WARMUP].start / T) * T;
    const L = this.L;
    const SPAN = L.span;
    const left = L.font * 5.6;
    const right = w - 10;
    const x = (t: number) => left + ((t - t0) / SPAN) * (right - left);
    const top = L.font * 2.5;
    const laneH = L.laneH;
    const laneY = (i: number) => top + i * (laneH + 8);
    ctx.font = `${L.font}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    LANES.forEach((n, i) => {
      ctx.fillStyle = muted;
      ctx.textAlign = 'left';
      ctx.fillText(n, 6, laneY(i) + laneH / 2);
    });
    // Refreshes.
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    for (let k = 0; t0 + k * T <= t0 + SPAN + 1e-6; k++) {
      const xx = x(t0 + k * T);
      ctx.beginPath();
      ctx.moveTo(xx, top - 6);
      ctx.lineTo(xx, laneY(3) + laneH + 2);
      ctx.stroke();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, 0, right - left, hh);
    ctx.clip();
    const col = (i: number): RGB => pal.rgb(COLS[i % COLS.length]);
    const block = (a: number, b: number, lane: number, c: string, label = '', inset = 3) => {
      if (b < t0 - 1 || a > t0 + SPAN + 1) return;
      const y = laneY(lane) + inset;
      const ww = Math.max(1, x(b) - x(a));
      ctx.fillStyle = c;
      ctx.fillRect(x(a), y, ww, laneH - 2 * inset);
      if (label && ww > 14) {
        ctx.fillStyle = ink;
        ctx.textAlign = 'center';
        ctx.fillText(label, x(a) + ww / 2, laneY(lane) + laneH / 2);
      }
    };
    const waitFill = rgbCss(mix(bg, pal.rgb('--muted'), 0.18));
    const waitLine = rgbCss(mix(bg, pal.rgb('--muted'), 0.6));
    const hatch = (a: number, b: number, lane: number) => {
      if (b - a < 0.05 || b < t0 - 1 || a > t0 + SPAN + 1) return;
      const y = laneY(lane) + 9;
      const ww = Math.max(1, x(b) - x(a) - 1);
      ctx.fillStyle = waitFill;
      ctx.fillRect(x(a) + 0.5, y, ww, laneH - 18);
      ctx.strokeStyle = waitLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x(a) + 0.5, y + 0.5, ww, laneH - 18);
      ctx.setLineDash([]);
    };
    for (const f of r.frames) {
      const c = col(f.i);
      const n = String(f.i % 100);
      hatch(f.start - f.waitBefore, f.start, 0);
      block(f.start, f.simEnd, 0, rgbCss(c), n);
      hatch(f.simEnd, f.acquire, 0);
      block(f.acquire, f.submit, 0, rgbCss(mix(bg, c, 0.45)));
      block(f.gpuStart, f.gpuEnd, 1, rgbCss(c), n);
      if (f.shown !== null) {
        if (f.shown > f.gpuEnd + 0.01) block(f.gpuEnd, f.shown, 2, rgbCss(mix(bg, c, 0.3)), n, 10);
        block(f.shown, f.replaced ?? f.shown + T, 3, rgbCss(c), n);
      } else if (f.gpuEnd > t0 && f.gpuEnd < t0 + SPAN) {
        ctx.strokeStyle = pal.css('--alert');
        ctx.lineWidth = 2;
        const xx = x(f.gpuEnd);
        const y = laneY(2) + laneH / 2;
        ctx.beginPath();
        ctx.moveTo(xx - 5, y - 5);
        ctx.lineTo(xx + 5, y + 5);
        ctx.moveTo(xx + 5, y - 5);
        ctx.lineTo(xx - 5, y + 5);
        ctx.stroke();
      }
    }
    // Mark one frame's latency: the first shown frame whose input read is in the window.
    const m = r.frames.find((f) => f.shown !== null && f.start >= t0 + 2 && (f.shown as number) <= t0 + SPAN);
    if (m) {
      const y = top - L.font;
      ctx.strokeStyle = pal.css('--accent');
      ctx.fillStyle = pal.css('--accent');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x(m.start), laneY(0) + laneH - 3);
      ctx.lineTo(x(m.start), y);
      ctx.lineTo(x(m.shown as number), y);
      ctx.lineTo(x(m.shown as number), laneY(3) + 3);
      ctx.stroke();
      ctx.textAlign = 'center';
      const label = `frame ${m.i % 100}: input to photon ${ms1((m.shown as number) - m.start)}`;
      const tw = ctx.measureText(label).width + 8;
      // Centred over the span, but kept inside the plot.
      const mid = Math.min(right - tw / 2, Math.max(left + tw / 2, (x(m.start) + x(m.shown as number)) / 2));
      ctx.fillStyle = rgbCss(bg);
      ctx.fillRect(mid - tw / 2, y - L.font * 0.7, tw, L.font * 1.4);
      ctx.fillStyle = pal.css('--accent');
      ctx.fillText(label, mid, y);
    }
    ctx.restore();
    // Legend.
    ctx.fillStyle = muted;
    ctx.textAlign = 'right';
    const narrow = L === NARROW;
    ctx.fillText(narrow ? 'CPU: sim (solid), render (pale), waiting (dashed)' : 'CPU: simulation (solid), render (pale), waiting (dashed)', right, hh - L.font * 0.8);
    ctx.textAlign = 'left';
    ctx.fillText(narrow ? `Refreshes: ${T.toFixed(1)} ms` : `Grid lines: refreshes, every ${T.toFixed(1)} ms`, narrow ? 6 : left, hh - L.font * (narrow ? 2.1 : 0.8));
  }
}
