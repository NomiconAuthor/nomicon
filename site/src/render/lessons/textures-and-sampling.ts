/**
 * The textures lesson's widget: TextureViz, a checkerboard floor sampled through the filter the
 * reader picks, stepped a 2 × 2 quad at a time. For the selected pixel it shows the coordinates'
 * derivatives across its quad, the footprint those make in the texture, the level of detail and
 * the levels and texels read; a second view colours each pixel by the mip level it read.
 */
import { h, seg } from '../../engine/dom';
import { DEFAULTS, Target, emptyStats, render } from '../raster';
import { ANISO_STEPS, FILTER_LABEL, type FilterMode, type PixelSample, TEX_H, TEX_SIZE, TEX_W, checkerTexture, measure, reference, samplerFor, texCamera, texScene } from '../scenes/textures-and-sampling';
import { type RGB, Palette, Stepper, btn, canvas, ctx2d, fit, fontPx, frame, mix, n2, onTheme, paintTarget, rgbCss, size, stage, stat } from '../view';

/** Colours for mip levels 0, 1, 2, ...; magnification uses the first. */
export const LEVEL_TOKENS = ['--c4', '--c2', '--c7', '--c5', '--c3', '--c6', '--c1'];

export class TextureViz {
  private mode: FilterMode = 'point';
  private aniso = 16;
  private view: 'color' | 'level' | 'ref' = 'color';
  private tex = checkerTexture();
  private target = new Target(TEX_W, TEX_H);
  private log = new Map<number, PixelSample>();
  private draws = texScene(this.tex, samplerFor('point'));
  private stepper: Stepper;
  private sel = -1;
  private cv = canvas(672, 420, 'A checkerboard floor stretching to the horizon');
  private inset = canvas(300, 300, 'The selected pixel\'s footprint on the texture', 'rd-canvas rd-inset', { maxWidth: 220 });
  private read = h('div', { class: 'rd-read' });
  private sum = h('div', { class: 'll-stats' });
  private anisoSeg: { el: HTMLElement; set: (v: string) => void };
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-tex');
    this.pal = new Palette(root);
    this.stepper = new Stepper(
      () => {
        this.log = new Map();
        this.target = new Target(TEX_W, TEX_H);
        this.draws = texScene(this.tex, samplerFor(this.mode, this.aniso), this.log);
        return render(this.draws, this.target, texCamera, { ...DEFAULTS, quads: true }, emptyStats());
      },
      () => this.show(),
    );
    this.stepper.speed = 60;
    const s = this.stepper;
    this.anisoSeg = seg<string>('Max anisotropy', ANISO_STEPS.map((n) => [String(n), `${n}×`] as [string, string]), String(this.aniso), (v) => {
      this.aniso = Number(v);
      if (this.mode !== 'aniso') this.modeSeg.set('aniso');
      this.mode = 'aniso';
      s.reset(true);
    });
    root.append(
      this.modeSeg.el,
      h('div', { class: 'll-row', style: 'gap: 6px 22px' }, this.anisoSeg.el, seg<'color' | 'level' | 'ref'>('Show', [['color', 'Colour'], ['level', 'Mip level read'], ['ref', 'Reference (256 rays a pixel)']], this.view, (v) => ((this.view = v), this.show())).el),
      h('div', { class: 'll-row' }, btn('Next quad', () => s.next(['quad'])), s.playBtn, btn('Whole frame', () => s.finish()), btn('Clear', () => s.reset())),
      h('div', { class: 'll-h' }, 'Click or tap a pixel to see its footprint'),
      stage(this.cv, [this.inset, this.read, this.sum]),
    );
    this.cv.addEventListener('click', (e) => {
      const r = this.cv.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * TEX_W);
      const y = Math.floor(((e.clientY - r.top) / r.height) * TEX_H);
      this.sel = y * TEX_W + x;
      this.show();
    });
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    fit(this.cv, () => this.show());
    fit(this.inset, () => this.drawInset());
    s.reset(true);
  }

  private modeSeg = seg<FilterMode>('Filter', (Object.keys(FILTER_LABEL) as FilterMode[]).map((m) => [m, FILTER_LABEL[m]]), this.mode, (m) => {
    this.mode = m;
    this.stepper.reset(true);
  });

  private levelColor(lambda: number, levels: Array<[number, number]>): RGB {
    let c: RGB = [0, 0, 0];
    for (const [l, w] of levels) {
      const t = this.pal.rgb(LEVEL_TOKENS[Math.min(l, LEVEL_TOKENS.length - 1)]);
      c = [c[0] + t[0] * w, c[1] + t[1] * w, c[2] + t[2] * w];
    }
    // Magnification is drawn darker, so it reads apart from level 0 used for minification.
    return lambda > 0 ? c : mix(this.pal.rgb('--bg'), c, 0.45);
  }

  private show(): void {
    const s = this.stepper;
    const ctx = ctx2d(this.cv);
    const k = size(this.cv).w / TEX_W;
    if (this.view === 'color') paintTarget(ctx, this.target, this.draws, this.pal, 'color', k);
    else {
      const bg = this.pal.rgb('--bg');
      const c1 = this.pal.rgb('--c1');
      const ref = this.view === 'ref' ? reference() : null;
      const m = ctx.getTransform();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const ex = (x: number) => Math.round(x * k * m.a + m.e);
      const ey = (y: number) => Math.round(y * k * m.d + m.f);
      for (let y = 0; y < TEX_H; y++)
        for (let x = 0; x < TEX_W; x++) {
          const p = y * TEX_W + x;
          const ps = this.log.get(p);
          let c: RGB = bg;
          if (ref) c = ps || this.target.owner[p] >= 0 || ref[p] > 0 ? mix(bg, c1, 0.25 + 0.75 * ref[p]) : bg;
          else if (ps) c = this.levelColor(ps.trace.lambda, ps.trace.levels);
          ctx.fillStyle = rgbCss(c);
          ctx.fillRect(ex(x), ey(y), ex(x + 1) - ex(x), ey(y + 1) - ey(y));
        }
      ctx.setTransform(m);
    }
    // The latest quad (while stepping) and the selected pixel's quad.
    const last = s.last;
    if (last?.kind === 'quad' && s.count !== this.quadSeen) {
      // A new quad was stepped: follow it (a click picks another pixel until the next step).
      this.quadSeen = s.count;
      const lane = [0, 1, 2, 3].find((l) => last.active & (1 << l)) ?? 0;
      this.sel = (last.y + (lane >> 1)) * TEX_W + last.x + (lane & 1);
    }
    if (this.sel >= 0) {
      const x = this.sel % TEX_W;
      const y = Math.floor(this.sel / TEX_W);
      ctx.strokeStyle = this.pal.css('--accent');
      ctx.lineWidth = 2;
      ctx.strokeRect((x & ~1) * k + 1, (y & ~1) * k + 1, 2 * k - 2, 2 * k - 2);
      ctx.strokeStyle = this.pal.css('--ink');
      ctx.strokeRect(x * k + 2.5, y * k + 2.5, k - 5, k - 5);
    }
    this.readout();
    this.drawInset();
    this.summary();
  }
  private quadSeen = -1;

  private summary(): void {
    if (!this.stepper.done) {
      this.sum.replaceChildren(stat(this.log.size.toLocaleString('en-US'), 'pixels sampled so far'));
      return;
    }
    const r = measure(this.log);
    this.sum.replaceChildren(
      stat(r.error.toFixed(3), 'average error'),
      stat(n2(r.reads), 'texels read a pixel'),
      stat(r.maxLambda.toFixed(1), `highest λ asked for (levels go 0 to ${this.tex.levels.length - 1})`),
    );
  }

  private readout(): void {
    const ps = this.sel >= 0 ? this.log.get(this.sel) : undefined;
    if (!ps) {
      this.read.replaceChildren(h('p', { class: 'll-muted' }, this.sel >= 0 ? 'That pixel isn\'t on the floor (or hasn\'t been drawn yet).' : 'Step a quad, or click a pixel on the floor.'));
      return;
    }
    const x = this.sel % TEX_W;
    const y = Math.floor(this.sel / TEX_W);
    const t = ps.trace;
    const T = TEX_SIZE;
    const row = (label: string, ...cells: string[]) => h('tr', {}, h('th', {}, label), ...cells.map((c) => h('td', {}, c)));
    const lv = t.lambda > 0 && this.mode !== 'point' && this.mode !== 'bilinear' ? t.levels.map(([l, w]) => (w === 1 ? `level ${l}` : `level ${l} × ${w.toFixed(2)}`)).join(' + ') : 'level 0';
    const why = t.lambda <= 0 ? 'magnified' : this.mode === 'point' || this.mode === 'bilinear' ? 'no mipmaps: level 0' : '';
    this.read.replaceChildren(
      h('p', {}, h('b', {}, `Pixel (${x}, ${y}), quad (${x & ~1}, ${y & ~1})`), `, u, v = ${n2(ps.u * T)}, ${n2(ps.v * T)} texels`),
      h(
        'table',
        { class: 'rd-tab rd-tab-wrap' },
        h(
          'tbody',
          {},
          row('u, v per pixel right / down', `(${n2(ps.d[0] * T)}, ${n2(ps.d[1] * T)}) / (${n2(ps.d[2] * T)}, ${n2(ps.d[3] * T)})`),
          row('footprint x, y (texels)', `${n2(t.px)}, ${n2(t.py)}${this.mode === 'aniso' ? `; ${t.n} samples (ratio ${n2(Math.max(t.px, t.py) / Math.min(t.px, t.py))}, max ${this.aniso})` : ''}`),
          row('level of detail λ', `${n2(t.lambda)}${why ? ` (${why})` : ''}`),
          row('read', `${lv}: ${t.reads} texel${t.reads === 1 ? '' : 's'}`),
        ),
      ),
    );
  }

  /** The texture around the selected pixel, with its footprint and the sample positions. */
  private drawInset(): void {
    const c = this.inset;
    const ctx = ctx2d(c);
    const { w: W } = size(c);
    ctx.fillStyle = this.pal.css('--bg');
    ctx.fillRect(0, 0, W, W);
    const ps = this.sel >= 0 ? this.log.get(this.sel) : undefined;
    const ink = this.pal.css('--ink');
    if (!ps) {
      ctx.fillStyle = this.pal.css('--muted');
      const f = fontPx(c, 15);
      ctx.font = `${f}px sans-serif`;
      ctx.fillText('The texture under the', 16, W / 2 - f * 0.6);
      ctx.fillText('selected pixel shows here', 16, W / 2 + f * 0.9);
      return;
    }
    const T = TEX_SIZE;
    const t = ps.trace;
    const cu = ps.u * T;
    const cv = ps.v * T;
    // The window spans a few footprints, at least 8 texels.
    const span = Math.min(2048, Math.max(8, 3.2 * Math.max(t.px, t.py)));
    const sc = W / span;
    const u0 = cu - span / 2;
    const v0 = cv - span / 2;
    const bg = this.pal.rgb('--bg');
    const col = this.pal.rgb('--c1');
    // Texels at level 0, or blocks of canvas when texels are smaller than 3 px.
    const cell = Math.max(sc, 3);
    for (let py = 0; py < W; py += cell)
      for (let px = 0; px < W; px += cell) {
        const tu = sc >= 3 ? Math.floor(u0 + px / sc) : u0 + (px + cell / 2) / sc;
        const tv = sc >= 3 ? Math.floor(v0 + py / sc) : v0 + (py + cell / 2) / sc;
        const val = this.tex.texel(0, Math.floor(tu), Math.floor(tv))[0];
        ctx.fillStyle = rgbCss(mix(bg, col, 0.15 + 0.5 * val));
        if (sc >= 3) {
          const x0 = (Math.floor(tu) - u0) * sc;
          const y0 = (Math.floor(tv) - v0) * sc;
          ctx.fillRect(x0, y0, sc + 0.5, sc + 0.5);
        } else ctx.fillRect(px, py, cell, cell);
      }
    if (sc >= 3) {
      // Texel grid when texels are big enough to see.
      ctx.strokeStyle = this.pal.css('--line-soft');
      ctx.lineWidth = 0.5;
      for (let i = Math.ceil(u0); i <= u0 + span; i++) {
        ctx.beginPath();
        ctx.moveTo((i - u0) * sc, 0);
        ctx.lineTo((i - u0) * sc, W);
        ctx.stroke();
      }
      for (let i = Math.ceil(v0); i <= v0 + span; i++) {
        ctx.beginPath();
        ctx.moveTo(0, (i - v0) * sc);
        ctx.lineTo(W, (i - v0) * sc);
        ctx.stroke();
      }
    }
    const X = (u: number) => (u - u0) * sc;
    const Y = (v: number) => (v - v0) * sc;
    // The pixel's footprint: its square mapped into the texture by the derivatives.
    const ax = ps.d[0] * T;
    const ay = ps.d[1] * T;
    const bx = ps.d[2] * T;
    const by = ps.d[3] * T;
    ctx.strokeStyle = this.pal.css('--accent');
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (const [i, [sx, sy]] of ([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as Array<[number, number]>).entries()) {
      const u = cu + ax * sx + bx * sy;
      const v = cv + ay * sx + by * sy;
      if (i) ctx.lineTo(X(u), Y(v));
      else ctx.moveTo(X(u), Y(v));
    }
    ctx.closePath();
    ctx.stroke();
    // Each sample: a circle as wide as one texel of the level it reads (2^level texels of level 0);
    // for trilinear, the two levels' weighted mean.
    const lvl = this.mode === 'point' || this.mode === 'bilinear' || t.lambda <= 0 ? 0 : t.levels.reduce((a, [l, w]) => a + l * w, 0);
    const r = (Math.pow(2, lvl) / 2) * sc;
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = 1.5;
    for (const [u, v] of t.taps) {
      ctx.beginPath();
      ctx.arc(X(u), Y(v), Math.max(2, r), 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(X(u), Y(v), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = `${fontPx(c, 14)}px sans-serif`;
    ctx.fillStyle = this.pal.css('--body');
    ctx.fillText(`${span < 20 ? span.toFixed(1) : Math.round(span)} texels across`, 8, W - 10);
  }
}
