/**
 * "Post-processing": one widget.
 *
 * PostViz: the courtyard at night with glowing lamps and a sliding crate, drawn into an HDR target
 * on the GPU and run through TAA, bloom and tone mapping, every frame. Each pass can be turned off;
 * where order matters it can be changed (bloom before or after tone mapping, TAA in linear or
 * tone-mapped space); the tone curve is plotted beside the frame, and a split view shows the frame
 * without post-processing on the left.
 */
import { h, seg } from '../../engine/dom';
import '../gpu/gpu.css';
import { CallLog } from '../gpu/record';
import { type PostRenderer, createPost } from '../gpu/post-processing';
import { GpuCanvas, backendLine, planReadout } from '../gpu/widget';
import { VIEW_H, VIEW_W } from '../scenes/courtyard';
import {
  type BloomOrder,
  POST_DEFAULTS,
  type PostSettings,
  SCALES,
  TAA_ALPHA,
  TONE_OPS,
  type TaaSpace,
  type ToneOp,
  bloomBytes,
  effectiveSamples,
  postLights,
  postPasses,
  tone,
} from '../scenes/post-processing';
import { Palette, canvas, chk, ctx2d, fit, frame, onTheme, stage, stat } from '../view';
import { animate, apiSwitch, gpuFigure, linearOf, slider, timePasses } from './lighting-ui';

export class PostViz {
  private s: PostSettings = { ...POST_DEFAULTS };
  private paused = false;
  private t = 0;
  private pal: Palette;
  private gpu: GpuCanvas;
  private renderer: PostRenderer | null = null;
  private log = new CallLog();
  private api: HTMLElement & { refresh?: () => void };
  private backend = h('div', { class: 'll-row' });
  private status = h('p', { class: 'rd-gpu-status' });
  private planStats = h('div', { class: 'll-stats' });
  private passList = h('ol', { class: 'rd-draws' });
  private stats = h('div', { class: 'll-stats' });
  private curve = canvas(360, 220, 'The tone curve: scene value in, display value out');
  private timing = h('span', { class: 'll-muted' });

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-gpu rd-lit');
    this.pal = new Palette(root);
    this.gpu = new GpuCanvas({
      w: VIEW_W,
      h: VIEW_H,
      label: 'The courtyard at night through a post-processing chain, drawn by the GPU',
      build: async (ctx) => {
        this.renderer = await createPost(ctx, this.log);
      },
      teardown: () => {
        this.renderer?.dispose();
        this.renderer = null;
      },
      draw: () => this.drawGpu(),
      onStatus: (s) => {
        this.status.textContent = s;
        this.showBackend();
      },
    });
    this.api = apiSwitch(this.gpu, () => this.redraw());
    const space = seg<TaaSpace>(
      'Blend in',
      [
        ['linear', 'Linear'],
        ['tonemapped', 'Tone-mapped'],
      ],
      this.s.taaSpace,
      (v) => this.set({ taaSpace: v }),
    );
    const scale = seg<string>('Render scale', SCALES.map((x) => [String(x), `${Math.round(x * 100)}%`] as [string, string]), String(this.s.scale), (v) => this.set({ scale: Number(v) }));
    const order = seg<BloomOrder>(
      'Bloom',
      [
        ['hdr', 'Before tone mapping'],
        ['ldr', 'After'],
      ],
      this.s.bloomOrder,
      (v) => this.set({ bloomOrder: v }),
    );
    const op = seg<ToneOp>('Tone curve', TONE_OPS, this.s.tone, (v) => this.set({ tone: v }));
    root.append(
      this.backend,
      h('div', { class: 'll-row' }, chk('TAA', true, (on) => this.set({ taa: on })), chk('Clamp history', true, (on) => this.set({ clamp: on })), space.el, scale.el),
      h('div', { class: 'll-row' }, chk('Bloom', true, (on) => this.set({ bloom: on })), order.el, slider('Strength', 0, 0.2, 0.01, this.s.strength, (v) => v.toFixed(2), (v) => this.set({ strength: v }))),
      h('div', { class: 'll-row' }, op.el, slider('Exposure', -3, 3, 0.25, this.s.ev, (v) => `${v > 0 ? '+' : ''}${v} EV`, (v) => this.set({ ev: v }))),
      h('div', { class: 'll-row' }, chk('Split: no post-processing on the left', false, (on) => this.set({ split: on })), chk('Pause the crate', false, (on) => (this.paused = on))),
      stage(gpuFigure(this.gpu, VIEW_W, VIEW_H), [h('div', { class: 'll-h' }, 'Passes, in order'), this.passList, this.curve, h('p', { class: 'rd-note' }, 'The tone curve: exposed scene value across (0 to 8), display value up. The dashed line marks 1; the faint curves are the other operators.'), this.stats]),
      h('div', { class: 'll-row' }, h('span', { class: 'll-muted' }, 'GPU: '), this.planStats),
      h('div', { class: 'll-row' }, h('button', { type: 'button', class: 'll-btn', onclick: () => void this.time() }, 'Time 60 frames'), this.timing),
      this.status,
    );
    fit(this.curve, () => this.drawCurve());
    onTheme(() => {
      this.pal.reset();
      this.redraw();
    });
    // TAA needs a stream of frames: draw continuously while the widget is on screen.
    const kick = animate(root, () => true, (dt) => {
      if (!this.paused) this.t += dt;
      this.drawGpu();
    });
    this.redraw();
    void this.gpu.start().then(() => {
      this.api.refresh?.();
      this.showBackend();
      kick();
    });
  }

  private set(p: Partial<PostSettings>): void {
    this.s = { ...this.s, ...p };
    this.redraw();
  }

  private showBackend(): void {
    const ldr = this.renderer?.ldrOnly;
    this.backend.replaceChildren(this.api, h('span', {}, h('span', { class: 'll-muted' }, 'GPU side: '), ...backendLine(this.gpu)));
    if (ldr) this.status.textContent = `Note: ${ldr}.`;
  }

  private redraw(): void {
    this.drawGpu();
    this.drawCurve();
    const w = this.gpu.canvas.width;
    const hh = this.gpu.canvas.height;
    const passes = postPasses(this.s, w, hh);
    this.passList.replaceChildren(...passes.map((p) => h('li', {}, h('b', {}, p.name), ` ${p.output === 'canvas' ? '→ canvas' : `${p.w} × ${p.h}`}`)));
    const mb = (b: number) => `${(b / (1024 * 1024)).toFixed(1)} MB`;
    this.stats.replaceChildren(
      ...(this.s.taa ? [stat(`≈ ${Math.round(effectiveSamples(TAA_ALPHA))}`, 'frames averaged by the history')] : []),
      ...(this.s.bloom ? [stat(mb(bloomBytes(w, hh)), 'bloom chain at this size')] : []),
      stat(`${tone(this.s.tone, 2 ** this.s.ev).toFixed(2)}`, 'what 1.0 in the scene becomes'),
    );
  }

  private drawGpu(): void {
    const r = this.renderer;
    if (!r) return;
    const colours = postLights().map((l) => linearOf(this.pal, l.color));
    this.planStats.replaceChildren(...planReadout(r.frame(this.s, { t: this.t, colours })));
  }

  private drawCurve(): void {
    const ctx = ctx2d(this.curve);
    const W = 360;
    const H = 220;
    const L = 30;
    const B = H - 22;
    const T = 10;
    const R = W - 10;
    const xMax = 8;
    const X = (x: number) => L + (x / xMax) * (R - L);
    const Y = (y: number) => B - y * (B - T);
    ctx.fillStyle = this.pal.css('--bg');
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = this.pal.css('--line');
    ctx.fillStyle = this.pal.css('--muted');
    ctx.font = '11px sans-serif';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const y of [0, 0.5, 1]) {
      ctx.moveTo(L, Y(y));
      ctx.lineTo(R, Y(y));
      ctx.fillText(y.toFixed(1), 4, Y(y) + 4);
    }
    for (const x of [0, 2, 4, 6, 8]) ctx.fillText(String(x), X(x) - 3, H - 6);
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(X(1), T);
    ctx.lineTo(X(1), B);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [op] of TONE_OPS) {
      const on = op === this.s.tone;
      ctx.strokeStyle = this.pal.css(on ? '--accent' : '--muted');
      ctx.globalAlpha = on ? 1 : 0.45;
      ctx.lineWidth = on ? 2.5 : 1.2;
      ctx.beginPath();
      for (let i = 0; i <= 160; i++) {
        const x = (i / 160) * xMax;
        const y = tone(op, x);
        if (i) ctx.lineTo(X(x), Y(y));
        else ctx.moveTo(X(x), Y(y));
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private async time(): Promise<void> {
    const r = this.renderer;
    if (!r) return;
    const names = ['scene', this.s.taa ? 'TAA' : this.s.bloom ? 'first bloom pass' : 'tone map', 'tone map'];
    await timePasses(r.timer, 60, () => this.drawGpu(), names, this.timing);
  }
}
