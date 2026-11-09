/**
 * The rasterisation lesson's widgets: RasterViz (edge functions, the fill rule, barycentrics and
 * MSAA on two draggable triangles) and PerspectiveViz (affine against perspective-correct
 * interpolation on a checkerboard floor).
 */
import { h, seg } from '../../engine/dom';
import { touchScroll } from '../../engine/touch';
import { type Draw, type FillRule, type PixelStep, type Step, DEFAULTS, SAMPLES_4X, SUB, Target, emptyStats, render } from '../raster';
import { PERSP_H, PERSP_W, RAST_H, RAST_W, type RasterPreset, coverage, coverageMaps, perspectiveCamera, perspectiveScene, rasterPoints, rasterScene } from '../scenes/rasterisation';
import { Palette, Stepper, btn, canvas, ctx2d, fit, fontPx, frame, markPixel, n2, n3, onTheme, outlineTri, paintTarget, size, stage } from '../view';

export class RasterViz {
  private preset: RasterPreset = 'shared';
  private pts = rasterPoints('shared');
  private fill: FillRule = 'top-left';
  private samples: 1 | 4 = 1;
  private target = new Target(RAST_W, RAST_H);
  private stepper: Stepper;
  private cv = canvas(672, 480, 'Two triangles over a 14 × 10 pixel grid');
  private read = h('div', { class: 'rd-read' });
  private sum = h('p', { class: 'rd-say' });
  private pal: Palette;
  private drag = -1;
  private draws: Draw[] = [];
  private presetSeg: { el: HTMLElement; set: (v: RasterPreset) => void };

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-raster');
    this.pal = new Palette(root);
    this.stepper = new Stepper(
      () => {
        const sc = rasterScene(this.pts);
        this.draws = sc.draws;
        this.target = new Target(RAST_W, RAST_H, this.samples);
        return render(sc.draws, this.target, sc.camera, { ...DEFAULTS, fill: this.fill, depthTest: false }, emptyStats());
      },
      () => this.show(),
    );
    this.stepper.speed = 2;
    const s = this.stepper;
    this.presetSeg = seg<RasterPreset>('Triangles', [['shared', 'Shared edge'], ['sliver', 'Sliver and speck']], this.preset, (p) => {
      this.preset = p;
      this.pts = rasterPoints(p);
      s.reset(true);
    });
    root.append(
      h(
        'div',
        { class: 'll-row', style: 'gap: 6px 22px' },
        this.presetSeg.el,
        seg<FillRule>('Fill rule', [['top-left', 'Top-left'], ['inclusive', 'Include edges'], ['exclusive', 'Exclude edges']], this.fill, (f) => {
        this.fill = f;
        s.reset(true);
      }).el,
        seg<string>('Samples', [['1', '1 per pixel'], ['4', '4× MSAA']], '1', (v) => {
          this.samples = Number(v) as 1 | 4;
          s.reset(true);
        }).el,
      ),
      h(
        'div',
        { class: 'll-row' },
        btn('Next pixel', () => s.next(['pixel'])),
        btn('Next covered pixel', () => s.next(['pixel'], (p) => (p as PixelStep).mask !== 0)),
        btn('Next triangle', () => s.next(['triangle'])),
        s.playBtn,
        btn('Whole frame', () => s.finish()),
        btn('Clear', () => s.reset()),
      ),
      h('div', { class: 'll-h' }, 'Drag a corner to move it (in 1/16-pixel steps, so it can land exactly on a pixel centre)'),
      stage(this.cv, [this.read, this.sum]),
    );
    touchScroll(this.cv, { grab: (e) => this.hit(e) >= 0 });
    this.cv.addEventListener('pointerdown', (e) => {
      this.drag = this.hit(e);
      if (this.drag >= 0) {
        this.cv.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    this.cv.addEventListener('pointermove', (e) => {
      if (this.drag < 0) return;
      const [x, y] = this.toPx(e);
      const snap = (v: number, max: number) => Math.min(max, Math.max(0, Math.round(v * 16) / 16));
      const p: [number, number] = [snap(x, RAST_W), snap(y, RAST_H)];
      // Corners shared by both triangles move together, so the edge stays shared.
      const old = this.pts[this.drag];
      this.pts = this.pts.map((q) => (q[0] === old[0] && q[1] === old[1] ? p : q));
      s.reset(true);
    });
    for (const ev of ['pointerup', 'pointercancel']) this.cv.addEventListener(ev, () => (this.drag = -1));
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    fit(this.cv, () => this.show());
    s.reset(true);
  }

  private toPx(e: PointerEvent): [number, number] {
    const r = this.cv.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * RAST_W, ((e.clientY - r.top) / r.height) * RAST_H];
  }
  private hit(e: PointerEvent): number {
    const [x, y] = this.toPx(e);
    let best = -1;
    let bd = 0.45 * 0.45;
    this.pts.forEach((p, i) => {
      const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  private show(): void {
    const s = this.stepper;
    const ctx = ctx2d(this.cv);
    const { w: W, h: H } = size(this.cv);
    const k = W / RAST_W;
    paintTarget(ctx, this.target, this.draws, this.pal, 'color', k);
    // Grid, then pixel centres or sample positions.
    ctx.strokeStyle = this.pal.css('--line');
    ctx.lineWidth = 1;
    for (let x = 0; x <= RAST_W; x++) {
      ctx.beginPath();
      ctx.moveTo(x * k + 0.5, 0);
      ctx.lineTo(x * k + 0.5, H);
      ctx.stroke();
    }
    for (let y = 0; y <= RAST_H; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * k + 0.5);
      ctx.lineTo(W, y * k + 0.5);
      ctx.stroke();
    }
    const pos = this.samples === 4 ? SAMPLES_4X : [[128, 128]];
    ctx.fillStyle = this.pal.css('--muted');
    for (let y = 0; y < RAST_H; y++)
      for (let x = 0; x < RAST_W; x++)
        for (const [ox, oy] of pos) {
          ctx.beginPath();
          ctx.arc((x + ox / SUB) * k, (y + oy / SUB) * k, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
    // When the frame is done, mark pixels drawn twice and pixels drawn by neither.
    if (s.done) {
      const { per, ref } = coverageMaps(this.pts, this.fill, this.samples);
      const S = this.samples;
      for (let i = 0; i < RAST_W * RAST_H * S; i++) {
        const a = per[0].owner[i] >= 0;
        const b = per[1].owner[i] >= 0;
        const p = Math.floor(i / S);
        const x = p % RAST_W;
        const y = Math.floor(p / RAST_W);
        const [ox, oy] = pos[i % S];
        const cx = (x + ox / SUB) * k;
        const cy = (y + oy / SUB) * k;
        if (a && b) {
          ctx.strokeStyle = this.pal.css('--alert');
          ctx.lineWidth = 3;
          if (S === 1) ctx.strokeRect(x * k + 3, y * k + 3, k - 6, k - 6);
          else {
            ctx.beginPath();
            ctx.arc(cx, cy, 6, 0, Math.PI * 2);
            ctx.stroke();
          }
        } else if (!a && !b && (ref[0].owner[i] >= 0 || ref[1].owner[i] >= 0)) {
          ctx.strokeStyle = this.pal.css('--warn');
          ctx.lineWidth = 3;
          ctx.setLineDash([6, 4]);
          if (S === 1) ctx.strokeRect(x * k + 3, y * k + 3, k - 6, k - 6);
          else {
            ctx.beginPath();
            ctx.arc(cx, cy, 6, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }
      }
    }
    // Covered samples of the current pixel, as filled dots.
    const last = s.last;
    if (last?.kind === 'pixel') {
      markPixel(ctx, last, k, this.pal.css('--ink'));
      ctx.fillStyle = this.pal.css('--ink');
      pos.forEach(([ox, oy], i) => {
        if (!(last.mask & (1 << i))) return;
        ctx.beginPath();
        ctx.arc((last.x + ox / SUB) * k, (last.y + oy / SUB) * k, 5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    // Triangle outlines and draggable corners.
    for (let t = 0; t < 2; t++) {
      const col = this.pal.css(t ? '--c3' : '--c2');
      ctx.strokeStyle = col;
      ctx.lineWidth = s.lastTri?.tri === 0 && s.lastTri.draw === t && !s.done ? 3.5 : 2;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const [x, y] = this.pts[t * 3 + i];
        if (i) ctx.lineTo(x * k, y * k);
        else ctx.moveTo(x * k, y * k);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = col;
      for (let i = 0; i < 3; i++) {
        const [x, y] = this.pts[t * 3 + i];
        ctx.beginPath();
        ctx.arc(x * k, y * k, 7, 0, Math.PI * 2);
        ctx.fill();
      }
      const cx = ((this.pts[t * 3][0] + this.pts[t * 3 + 1][0] + this.pts[t * 3 + 2][0]) / 3) * k;
      const cy = ((this.pts[t * 3][1] + this.pts[t * 3 + 1][1] + this.pts[t * 3 + 2][1]) / 3) * k;
      const f = fontPx(this.cv, 22, 13);
      ctx.font = `bold ${f}px sans-serif`;
      ctx.fillStyle = this.pal.css('--ink');
      ctx.fillText(t ? 'B' : 'A', cx - f * 0.33, cy + f * 0.36);
    }
    this.readout(last);
    const c = coverage(this.pts, this.fill, this.samples);
    const twice = this.samples === 1 ? 'pixels' : 'samples';
    this.sum.replaceChildren(
      h('b', {}, `${this.samples === 1 ? 'Pixels' : 'Samples'}: `),
      `A covers ${c.a}, B covers ${c.b}. `,
      c.twice ? h('span', { class: 'det-bad' }, `${c.twice} ${twice} drawn twice. `) : `None drawn twice. `,
      c.missed ? h('span', { class: 'det-bad' }, `${c.missed} ${twice} drawn by neither. `) : 'None missed. ',
      this.samples === 4 ? `${c.partial} pixels are partly covered; the fragment shader ran ${c.shaded} times (once per triangle per pixel), for ${c.samples} covered samples.` : '',
    );
  }

  private readout(last: Step | null): void {
    if (!last || last.kind !== 'pixel') {
      this.read.replaceChildren(h('p', { class: 'll-muted' }, last?.kind === 'triangle' ? `Triangle ${last.draw ? 'B' : 'A'} set up: its edge functions are ready. Step a pixel to evaluate them.` : 'Step a pixel to see its edge functions and barycentrics.'));
      return;
    }
    const names = last.draw ? ['B'] : ['A'];
    const e = last.edges;
    const tie = { none: '', 'top-left': 'The centre is exactly on an edge, and that edge is a top or left edge: the top-left rule says this triangle owns it.', 'not-top-left': 'The centre is exactly on an edge, but it\'s a right or bottom edge, so this triangle doesn\'t take it. A triangle on the other side would take it; if there\'s none, or the centre is on its right or bottom edge too, nothing draws it.', inclusive: 'The centre is exactly on an edge, and "include edges" counts it.', exclusive: 'The centre is exactly on an edge, and "exclude edges" drops it.' }[this.samples === 1 ? last.tie : 'none'];
    // One row per edge, so the table stays narrow enough for the side panel.
    const edge = ['0→1', '1→2', '2→0'];
    this.read.replaceChildren(
      h('p', {}, h('b', {}, `Pixel (${last.x}, ${last.y}), triangle ${names[0]}: `), last.mask ? (this.samples === 4 ? `${popcount(last.mask)} of 4 samples covered.` : 'covered.') : 'not covered.', tie ? ` ${tie}` : ''),
      h(
        'table',
        { class: 'rd-tab' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Edge'), h('th', {}, 'E at the centre (px²)'), h('th', {}, 'Sign'))),
        h('tbody', {}, ...e.map((v, i) => h('tr', {}, h('th', {}, edge[i]), h('td', {}, n2(v)), h('td', {}, v > 0 ? 'inside' : v < 0 ? 'outside' : 'on the edge')))),
      ),
      h('p', {}, `Barycentrics (λ0, λ1, λ2): `, h('b', {}, last.bary.map(n3).join(', ')), ' (they sum to 1)'),
    );
  }
}
function popcount(m: number): number {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
}

// =============================================================================================
// Perspective-correct interpolation

export class PerspectiveViz {
  private perspective = true;
  private draws = perspectiveScene();
  private target = new Target(PERSP_W, PERSP_H);
  private stepper: Stepper;
  private cv = canvas(640, 400, 'A checkerboard floor drawn as two triangles');
  private read = h('div', { class: 'rd-read' });
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-persp');
    this.pal = new Palette(root);
    this.stepper = new Stepper(
      () => render(this.draws, this.target, perspectiveCamera, { ...DEFAULTS, perspective: this.perspective }, emptyStats()),
      () => this.show(),
    );
    const s = this.stepper;
    root.append(
      seg<string>('Interpolation', [['p', 'Perspective-correct'], ['a', 'Affine (screen-space)']], 'p', (v) => {
        this.perspective = v === 'p';
        s.reset(true);
      }).el,
      h('div', { class: 'll-row' }, btn('Next pixel', () => s.next(['pixel'], (p) => (p as PixelStep).mask !== 0)), btn('Next triangle', () => s.next(['triangle'])), s.playBtn, btn('Whole frame', () => s.finish()), btn('Clear', () => s.reset())),
      stage(this.cv, [this.read]),
    );
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    fit(this.cv, () => this.show());
    s.reset(true);
  }

  private show(): void {
    const s = this.stepper;
    const ctx = ctx2d(this.cv);
    const k = size(this.cv).w / PERSP_W;
    paintTarget(ctx, this.target, this.draws, this.pal, 'color', k);
    if (s.lastTri && !s.done) for (const p of s.lastTri.pieces) outlineTri(ctx, p, k, this.pal.css('--accent'));
    const last = s.last;
    if (last?.kind !== 'pixel') {
      this.read.replaceChildren(h('p', { class: 'll-muted' }, 'Step a pixel to compare the two ways of interpolating its texture coordinates.'));
      return;
    }
    markPixel(ctx, last, k, this.pal.css('--ink'));
    const t = last.piece;
    const uvOf = (w: number[]) => [0, 1].map((i) => w[0] * t.attrs[0][i] + w[1] * t.attrs[1][i] + w[2] * t.attrs[2][i]);
    const ua = uvOf(last.bary);
    const up = uvOf(last.pbary);
    const row = (label: string, ...cells: string[]) => h('tr', {}, h('th', {}, label), ...cells.map((c) => h('td', {}, c)));
    this.read.replaceChildren(
      h('p', {}, h('b', {}, `Pixel (${last.x}, ${last.y})`), `. 1/w at the corners: ${t.iw.map(n3).join(', ')}`),
      h(
        'table',
        { class: 'rd-tab rd-tab-wrap' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'weights λ0, λ1, λ2'), h('th', {}, 'u, v (squares)'))),
        h(
          'tbody',
          {},
          row('Affine (screen space)', last.bary.map(n3).join(', '), ua.map(n2).join(', ')),
          row('Perspective-correct (by 1/w)', last.pbary.map(n3).join(', '), up.map(n2).join(', ')),
        ),
      ),
      h('p', { class: 'll-muted' }, `Off by ${n2(Math.max(Math.abs(ua[0] - up[0]), Math.abs(ua[1] - up[1])))} squares here. The widget is drawing with the ${this.perspective ? 'perspective-correct' : 'affine'} values.`),
    );
  }
}

