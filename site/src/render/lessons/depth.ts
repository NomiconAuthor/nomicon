/**
 * The depth lesson's widgets: DepthViz (formats, near plane, reverse-Z and the depth test on a road
 * decal over a field, with a depth-resolution chart) and OverdrawViz (draw order against late Z,
 * early Z and a depth prepass, as fragment shader runs per pixel).
 */
import { h, seg } from '../../engine/dom';
import { type DepthFormat, type DepthMode, type PixelStep, DEFAULTS, FORMAT_LABEL, Target, emptyStats, render } from '../raster';
import { lengthText } from '../scenes/common';
import { DEPTH_DEFAULT, DEPTH_FAR, DEPTH_H, DEPTH_NEARS, DEPTH_W, type DepthSettings, type DrawOrder, OVER_H, OVER_W, depthCamera, depthOptions, depthScene, overdrawCamera, overdrawScene, resolution, zFight } from '../scenes/depth';
import { Palette, Stepper, btn, canvas, chk, ctx2d, fit, frame, markPixel, onTheme, outlineTri, paintTarget, size, stage, stat } from '../view';

export class DepthViz {
  private set: DepthSettings = { ...DEPTH_DEFAULT, near: 0.01 };
  private view: 'color' | 'depth' = 'color';
  private draws = depthScene();
  private target = new Target(DEPTH_W, DEPTH_H);
  private stepper: Stepper;
  private cv = canvas(672, 420, 'A tower, a field and a road decal seen from 50 m up');
  private chart = canvas(560, 230, 'Depth buffer resolution against distance', 'rd-canvas rd-chart');
  private read = h('p', { class: 'rd-say' });
  private sum = h('p', { class: 'rd-say' });
  private chartNote = h('p', { class: 'll-muted' });
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-depth');
    this.pal = new Palette(root);
    this.stepper = new Stepper(
      () => render(this.draws, this.target, depthCamera(this.set), depthOptions(this.set), emptyStats()),
      () => this.show(),
    );
    this.stepper.speed = 120;
    const s = this.stepper;
    const re = () => s.reset(true);
    root.append(
      seg<DepthFormat>('Depth format', [['unorm16', '16-bit'], ['unorm24', '24-bit'], ['float32', '32-bit float']], this.set.format, (f) => ((this.set.format = f), re())).el,
      seg<string>('Near plane', DEPTH_NEARS.map((n) => [String(n), `${n} m`] as [string, string]), String(this.set.near), (v) => ((this.set.near = Number(v)), re())).el,
      h(
        'div',
        { class: 'll-row' },
        chk('Reverse-Z', this.set.reverseZ, (on) => ((this.set.reverseZ = on), re())),
        chk('Depth test', this.set.depthTest, (on) => ((this.set.depthTest = on), re())),
        seg<'color' | 'depth'>('Show', [['color', 'Colour'], ['depth', 'Depth buffer']], 'color', (v) => ((this.view = v), this.show())).el,
      ),
      h('div', { class: 'll-row' }, btn('Next triangle', () => s.next(['triangle'])), btn('Next pixel', () => s.next(['pixel'], (p) => (p as PixelStep).mask !== 0)), s.playBtn, btn('Whole frame', () => s.finish()), btn('Clear', () => s.reset())),
      stage(this.cv, [this.read, this.sum, h('div', { class: 'll-h' }, 'How far apart two surfaces must be to get different depths, by distance'), this.chart, this.chartNote]),
    );
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    fit(this.cv, () => this.show());
    fit(this.chart, () => this.drawChart());
    s.reset(true);
  }

  private show(): void {
    const s = this.stepper;
    const ctx = ctx2d(this.cv);
    const k = size(this.cv).w / DEPTH_W;
    // In the depth view, stretch the grey over the values actually stored, and say what they are.
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < DEPTH_W * DEPTH_H; i++)
      if (this.target.owner[i] >= 0) {
        lo = Math.min(lo, this.target.depth[i]);
        hi = Math.max(hi, this.target.depth[i]);
      }
    paintTarget(ctx, this.target, this.draws, this.pal, this.view, k, this.set.reverseZ ? hi : lo, this.set.reverseZ ? lo : hi);
    if (s.lastTri && !s.done) for (const p of s.lastTri.pieces) outlineTri(ctx, p, k, this.pal.css('--accent'));
    const last = s.last;
    const cmp = this.set.reverseZ ? '>' : '<';
    if (last?.kind === 'pixel') {
      markPixel(ctx, last, k, this.pal.css('--ink'));
      const name = this.draws[last.draw].name;
      this.read.replaceChildren(
        h('b', {}, `Pixel (${last.x}, ${last.y}), ${name}: `),
        !this.set.depthTest ? 'no depth test: it is written whatever is there.' : `incoming ${last.depth.toFixed(9)} ${cmp} stored ${last.stored.toFixed(9)}? `,
        this.set.depthTest ? (last.passMask ? h('span', { class: 'det-ok' }, 'Yes: written.') : h('span', { class: 'det-bad' }, last.depth === last.stored ? 'Equal, so no: discarded. Both surfaces rounded to the same stored value.' : 'No: discarded.')) : '',
      );
    } else this.read.textContent = this.view === 'depth' && hi >= lo ? `Stored depths run from ${lo.toFixed(6)} to ${hi.toFixed(6)}; the grey is stretched over that range (nearer is lighter).` : 'Step a pixel to see its depth test.';
    const z = zFight(this.set);
    this.sum.replaceChildren(
      h('b', {}, 'Road: '),
      `${z.road} pixels. `,
      z.fighting ? h('span', { class: 'det-bad' }, `The ground shows through on ${z.fighting} of them.`) : h('span', { class: 'det-ok' }, 'The ground never shows through.'),
    );
    this.drawChart();
  }

  private drawChart(): void {
    const c = this.chart;
    const ctx = ctx2d(c);
    const { w: W, h: H } = size(c);
    const pad = { l: 74, r: 12, t: 30, b: 38 };
    ctx.fillStyle = this.pal.css('--bg');
    ctx.fillRect(0, 0, W, H);
    const { near, reverseZ } = this.set;
    const z0 = Math.max(near, 0.1);
    const z1 = DEPTH_FAR;
    const r0 = 1e-7;
    const r1 = 1e3;
    const X = (z: number) => pad.l + ((Math.log10(z) - Math.log10(z0)) / (Math.log10(z1) - Math.log10(z0))) * (W - pad.l - pad.r);
    const Y = (r: number) => pad.t + ((Math.log10(r1) - Math.log10(Math.max(r0, Math.min(r1, r)))) / (Math.log10(r1) - Math.log10(r0))) * (H - pad.t - pad.b);
    ctx.font = '17px sans-serif';
    ctx.fillStyle = this.pal.css('--muted');
    ctx.strokeStyle = this.pal.css('--line-soft');
    ctx.lineWidth = 1;
    for (const r of [1e-6, 1e-4, 1e-2, 1, 100]) {
      ctx.beginPath();
      ctx.moveTo(pad.l, Y(r));
      ctx.lineTo(W - pad.r, Y(r));
      ctx.stroke();
      ctx.fillText(lengthText(r), 4, Y(r) + 4);
    }
    for (const z of [0.1, 1, 10, 100, 1000]) {
      if (z < z0) continue;
      ctx.beginPath();
      ctx.moveTo(X(z), pad.t);
      ctx.lineTo(X(z), H - pad.b);
      ctx.stroke();
      ctx.fillText(z >= 1000 ? `${z / 1000} km` : `${z} m`, X(z) - 10, H - 12);
    }
    // The road's lift as seen along a ray: what the buffer has to resolve.
    const formats: Array<[DepthFormat, string]> = [
      ['unorm16', '--c3'],
      ['unorm24', '--c2'],
      ['float32', '--c1'],
    ];
    for (const [fmt, col] of formats) {
      ctx.strokeStyle = this.pal.css(col);
      ctx.lineWidth = fmt === this.set.format ? 3.5 : 1.8;
      // Dashed, so it shows where it lies on top of the 24-bit line (plain float is no better).
      ctx.setLineDash(fmt === 'float32' ? [8, 6] : []);
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const z = z0 * Math.pow(z1 / z0, i / 120);
        const r = resolution(z, near, DEPTH_FAR, fmt, reverseZ);
        if (i) ctx.lineTo(X(z), Y(r));
        else ctx.moveTo(X(z), Y(r));
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    let lx = pad.l + 8;
    for (const [fmt, col] of formats) {
      ctx.fillStyle = this.pal.css(col);
      ctx.fillRect(lx, 12, 14, 4);
      ctx.fillStyle = this.pal.css('--body');
      ctx.fillText(FORMAT_LABEL[fmt], lx + 18, 20);
      lx += 150;
    }
    const at = (z: number) => formats.map(([f]) => `${FORMAT_LABEL[f]} ${lengthText(resolution(z, near, DEPTH_FAR, f, reverseZ))}`).join(', ');
    this.chartNote.textContent = `Near plane ${near} m, far plane ${DEPTH_FAR / 1000} km${reverseZ ? ', reverse-Z' : ''}. At 100 m: ${at(100)}.`;
  }
}

// =============================================================================================
// Early Z, late Z, depth prepass

export class OverdrawViz {
  private order: DrawOrder = 'back';
  private mode: DepthMode = 'late';
  private view: 'color' | 'heat' = 'heat';
  private draws = overdrawScene('back');
  private target = new Target(OVER_W, OVER_H);
  private stats = emptyStats();
  private pass: 'depth' | 'main' = 'main';
  private stepper: Stepper;
  private cv = canvas(640, 400, 'Boxes in a row in front of a wall');
  private counts = h('div', { class: 'll-stats' });
  private say = h('p', { class: 'rd-say' });
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-over');
    this.pal = new Palette(root);
    this.stepper = new Stepper(
      () => {
        this.stats = emptyStats();
        this.draws = overdrawScene(this.order);
        const gen = render(this.draws, this.target, overdrawCamera, { ...DEFAULTS, depthMode: this.mode }, this.stats);
        const self = this;
        return (function* () {
          for (const st of gen) {
            if (st.kind === 'draw') self.pass = st.pass;
            yield st;
          }
        })();
      },
      () => this.show(),
    );
    this.stepper.speed = 80;
    const s = this.stepper;
    root.append(
      seg<DrawOrder>('Draw order', [['back', 'Back to front'], ['front', 'Front to back']], this.order, (o) => ((this.order = o), s.reset(true))).el,
      seg<DepthMode>('Depth test', [['late', 'Late Z'], ['early', 'Early Z'], ['prepass', 'Prepass, then early Z']], this.mode, (m) => ((this.mode = m), s.reset(true))).el,
      seg<'color' | 'heat'>('Show', [['heat', 'Fragment shader runs per pixel'], ['color', 'Colour']], this.view, (v) => ((this.view = v), this.show())).el,
      h('div', { class: 'll-row' }, btn('Next draw', () => s.next(['draw'])), btn('Next triangle', () => s.next(['triangle'])), s.playBtn, btn('Whole frame', () => s.finish()), btn('Clear', () => s.reset())),
      stage(this.cv, [h('div', { class: 'll-legend' }, this.legend()), this.say, this.counts]),
    );
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    fit(this.cv, () => this.show());
    s.reset(true);
  }

  private legend(): HTMLElement {
    const item = (label: string, cls: string) => h('span', {}, h('i', { class: cls }), label);
    return h('span', { class: 'rd-heat-legend' }, item('shaded once', 'h1'), item('twice', 'h2'), item('three or more times', 'h3'));
  }

  private show(): void {
    const s = this.stepper;
    const ctx = ctx2d(this.cv);
    const k = size(this.cv).w / OVER_W;
    paintTarget(ctx, this.target, this.draws, this.pal, this.view, k);
    if (s.lastTri && !s.done) for (const p of s.lastTri.pieces) outlineTri(ctx, p, k, this.pal.css('--accent'));
    const last = s.last;
    this.say.textContent =
      last && last.kind !== 'done' && !s.done
        ? `${this.pass === 'depth' ? 'Depth-only prepass' : this.mode === 'prepass' ? 'Main pass (depth test "equal", no depth writes)' : 'Main pass'}: drawing the ${this.draws[last.draw].name}.`
        : s.done
          ? 'Frame finished.'
          : 'Cleared.';
    let visible = 0;
    for (let i = 0; i < OVER_W * OVER_H; i++) if (this.target.owner[i] >= 0) visible++;
    const st = this.stats;
    this.counts.replaceChildren(
      stat(visible.toLocaleString('en-US'), 'pixels on screen'),
      stat(st.fragments.toLocaleString('en-US'), 'fragments'),
      stat(st.shaded.toLocaleString('en-US'), 'fragment shader runs'),
      stat(visible ? `${(st.shaded / visible).toFixed(2)}×` : '–', 'shading per visible pixel'),
      this.mode === 'prepass' ? stat(st.prepassFragments.toLocaleString('en-US'), 'depth-only fragments in the prepass') : '',
    );
  }
}
