/**
 * The blending lesson's widgets: SortViz (three glass panes drawn in different orders, with depth
 * writes on or off, and alpha, additive or order-independent blending), EdgeViz (a sprite's edges
 * with straight against premultiplied alpha) and FenceViz (a chain-link fence cut out by alpha
 * blending, alpha test or alpha to coverage). They draw the target's colour buffer, whose inks are
 * theme tokens.
 */
import { h, seg } from '../../engine/dom';
import { type Draw, type PixelStep, type Step, DEFAULTS, Target, emptyStats, render, resolveOit } from '../raster';
import {
  type AlphaKind,
  type CutoutMode,
  EDGE_H,
  EDGE_INKS,
  EDGE_W,
  FENCE_FAR,
  FENCE_H,
  FENCE_INKS,
  FENCE_NEAR,
  FENCE_W,
  type PaneBlend,
  type PaneOrder,
  SORT_H,
  SORT_INKS,
  SORT_W,
  compare,
  edgeCamera,
  edgeRun,
  edgeScene,
  fenceCamera,
  fenceCoverage,
  fenceRun,
  fenceScene,
  resolved,
  sortCamera,
  sortRun,
  sortScene,
} from '../scenes/blending-and-transparency';
import { type RGB, Palette, Stepper, btn, canvas, chk, ctx2d, fit, frame, markPixel, onTheme, outlineTri, rgbCss, size, stage, stat } from '../view';

/** Paint a target's colour buffer: each pixel is its samples' inks, averaged, as theme colours. */
export function paintInks(ctx: CanvasRenderingContext2D, t: Target, tokens: string[], pal: Palette, k: number, tint?: (p: number) => RGB | null): void {
  const cols = tokens.map((c) => pal.rgb(c));
  const K = t.inks;
  const S = t.samples;
  const m = ctx.getTransform();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const ex = (x: number) => Math.round(x * k * m.a + m.e);
  const ey = (y: number) => Math.round(y * k * m.d + m.f);
  for (let y = 0; y < t.h; y++)
    for (let x = 0; x < t.w; x++) {
      const p = y * t.w + x;
      let c: RGB = tint?.(p) ?? [0, 0, 0];
      if (!tint?.(p)) {
        c = [0, 0, 0];
        for (let s = 0; s < S; s++)
          for (let i = 0; i < K; i++) {
            const w = t.color[(p * S + s) * K + i] / S;
            c = [c[0] + cols[i][0] * w, c[1] + cols[i][1] * w, c[2] + cols[i][2] * w];
          }
      }
      ctx.fillStyle = rgbCss(c);
      ctx.fillRect(ex(x), ey(y), ex(x + 1) - ex(x), ey(y + 1) - ey(y));
    }
  ctx.setTransform(m);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

// =============================================================================================
// Sorting

export class SortViz {
  private order: PaneOrder = 'front';
  private depthWrite = false;
  private mode: PaneBlend = 'over';
  private view: 'color' | 'wrong' = 'color';
  private draws: Draw[] = sortScene('front', false, 'over');
  private target = new Target(SORT_W, SORT_H, 1, SORT_INKS.length);
  private stepper: Stepper;
  private cv = canvas(672, 420, 'Three glass panes in front of a wall');
  private list = h('ol', { class: 'rd-draws' });
  private say = h('p', { class: 'rd-say' });
  private counts = h('div', { class: 'll-stats' });
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-sort');
    this.pal = new Palette(root);
    this.stepper = new Stepper(
      () => {
        this.draws = sortScene(this.order, this.depthWrite, this.mode);
        this.target = new Target(SORT_W, SORT_H, 1, SORT_INKS.length);
        const gen = render(this.draws, this.target, sortCamera, { ...DEFAULTS }, emptyStats());
        const t = this.target;
        const oit = this.mode === 'oit';
        // Weighted blended OIT composites once, after every transparent draw.
        return (function* (): Generator<Step, void, void> {
          for (const st of gen) {
            if (st.kind === 'done' && oit) resolveOit(t);
            yield st;
          }
        })();
      },
      () => this.show(),
    );
    this.stepper.speed = 50;
    const s = this.stepper;
    const re = () => s.reset(true);
    root.append(
      seg<PaneOrder>('Pane order', [['back', 'Back to front (sorted)'], ['front', 'Front to back'], ['listed', 'Unsorted']], this.order, (o) => ((this.order = o), re())).el,
      seg<PaneBlend>('Blend', [['over', 'Alpha (over)'], ['additive', 'Additive'], ['oit', 'Weighted blended OIT']], this.mode, (m) => ((this.mode = m), re())).el,
      h(
        'div',
        { class: 'll-row' },
        chk('Panes write depth', this.depthWrite, (on) => ((this.depthWrite = on), re())),
        seg<'color' | 'wrong'>('Show', [['color', 'Colour'], ['wrong', 'Wrong pixels']], this.view, (v) => ((this.view = v), this.show())).el,
      ),
      h('div', { class: 'll-row' }, btn('Next draw', () => s.next(['draw'])), btn('Next triangle', () => s.next(['triangle'])), s.playBtn, btn('Whole frame', () => s.finish()), btn('Clear', () => s.reset())),
      stage(this.cv, [this.list, this.say, this.counts]),
    );
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    fit(this.cv, () => this.show());
    re();
  }

  private show(): void {
    const s = this.stepper;
    const ctx = ctx2d(this.cv);
    const k = size(this.cv).w / SORT_W;
    const K = SORT_INKS.length;
    let wrongAt: Uint8Array | null = null;
    let err = { wrong: 0, max: 0 };
    let panes = 0;
    if (s.done) {
      const ref = resolved(sortRun('back', false, this.mode === 'additive' ? 'additive' : 'over'));
      const got = resolved(this.target);
      err = compare(got, ref, K);
      wrongAt = new Uint8Array(SORT_W * SORT_H);
      for (let p = 0; p < SORT_W * SORT_H; p++) {
        let d = 0;
        for (let i = 0; i < K; i++) d += Math.abs(got[p * K + i] - ref[p * K + i]);
        if (d > 0.02) wrongAt[p] = 1;
        if (ref[p * K + 3] + ref[p * K + 4] + ref[p * K + 5] > 0) panes++;
      }
    }
    const hot = this.pal.rgb('--alert');
    const dim = this.pal.rgb('--bg');
    paintInks(ctx, this.target, SORT_INKS, this.pal, k, this.view === 'wrong' && wrongAt ? (p) => (wrongAt![p] ? hot : dim) : undefined);
    if (s.lastTri && !s.done) for (const p of s.lastTri.pieces) outlineTri(ctx, p, k, this.pal.css('--accent'));
    const cur = s.last && s.last.kind !== 'done' && !s.done ? s.last.draw : -1;
    this.list.replaceChildren(
      ...this.draws.map((d, i) =>
        h('li', { class: i === cur ? 'on' : '' }, h('b', {}, d.name), d.blend ? ` · ${this.mode === 'oit' ? 'accumulate' : this.mode === 'additive' ? 'add' : 'blend over'}${d.depthWrite ? ', writes depth' : ''}` : ' · opaque, writes depth'),
      ),
    );
    if (!s.done) {
      this.say.textContent = cur >= 0 ? `Drawing the ${this.draws[cur].name}.` : 'Cleared. Step through the draws.';
      this.counts.replaceChildren();
      return;
    }
    this.say.replaceChildren(
      err.wrong
        ? h('span', { class: 'det-bad' }, `${err.wrong} of the panes' ${panes.toLocaleString('en-US')} pixels differ from the right answer (sorted, ${this.mode === 'additive' ? 'additive' : 'over'}), by up to ${pct(err.max / 2)} of their colour.`)
        : h('span', { class: 'det-ok' }, this.mode === 'additive' && this.order !== 'back' ? 'Same as sorted: adding doesn\'t depend on order.' : 'Every pixel matches the right answer.'),
    );
    this.counts.replaceChildren(stat(err.wrong, 'pixels wrong'), stat(panes.toLocaleString('en-US'), 'pixels with glass'));
  }
}

// =============================================================================================
// Straight and premultiplied alpha

export class EdgeViz {
  private kind: AlphaKind = 'straight';
  private view: 'color' | 'white' = 'color';
  private target = edgeRun('straight').target;
  private cv = canvas(640, 400, 'A round sprite drawn large and small, with soft edges');
  private read = h('div', { class: 'rd-read' });
  private counts = h('div', { class: 'll-stats' });
  private sel = -1;
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-edge');
    this.pal = new Palette(root);
    root.append(
      seg<AlphaKind>('Texture and blend', [['straight', 'Straight alpha'], ['premultiplied', 'Premultiplied alpha']], this.kind, (v) => ((this.kind = v), this.redo())).el,
      seg<'color' | 'white'>('Show', [['color', 'Colour'], ['white', 'Where the white got in']], this.view, (v) => ((this.view = v), this.show())).el,
      h('div', { class: 'll-h' }, 'Click or tap a pixel on an edge'),
      stage(this.cv, [this.read, this.counts]),
    );
    this.cv.addEventListener('click', (e) => {
      const r = this.cv.getBoundingClientRect();
      this.sel = Math.floor(((e.clientY - r.top) / r.height) * EDGE_H) * EDGE_W + Math.floor(((e.clientX - r.left) / r.width) * EDGE_W);
      this.show();
    });
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    fit(this.cv, () => this.show());
    this.redo();
  }

  private steps = new Map<number, PixelStep>();
  private redo(): void {
    this.target = new Target(EDGE_W, EDGE_H, 1, EDGE_INKS.length);
    this.steps.clear();
    for (const st of render(edgeScene(this.kind), this.target, edgeCamera, { ...DEFAULTS, depthTest: false, quads: true }, emptyStats())) if (st.kind === 'pixel' && st.rgba) this.steps.set(st.y * EDGE_W + st.x, st);
    this.show();
  }

  private show(): void {
    const ctx = ctx2d(this.cv);
    const k = size(this.cv).w / EDGE_W;
    const r = resolved(this.target);
    const bg = this.pal.rgb('--bg');
    const hot = this.pal.rgb('--alert');
    paintInks(ctx, this.target, EDGE_INKS, this.pal, k, this.view === 'white' ? (p) => [bg[0] + (hot[0] - bg[0]) * Math.min(1, r[p * 3 + 2] * 3), bg[1] + (hot[1] - bg[1]) * Math.min(1, r[p * 3 + 2] * 3), bg[2] + (hot[2] - bg[2]) * Math.min(1, r[p * 3 + 2] * 3)] : undefined);
    const st = this.sel >= 0 ? this.steps.get(this.sel) : undefined;
    if (this.sel >= 0) markPixel(ctx, { x: this.sel % EDGE_W, y: Math.floor(this.sel / EDGE_W) } as PixelStep, k, this.pal.css('--accent'));
    if (!st?.rgba) this.read.replaceChildren(h('p', { class: 'll-muted' }, this.sel >= 0 ? 'No sprite there.' : 'Pick a pixel on a sprite\'s edge to see what its sample returned and what was blended.'));
    else {
      const c = st.rgba.c;
      const a = st.rgba.a;
      const row = (label: string, ...cells: string[]) => h('tr', {}, h('th', {}, label), ...cells.map((x) => h('td', {}, x)));
      const p = this.sel;
      this.read.replaceChildren(
        h('p', {}, h('b', {}, `Pixel (${p % EDGE_W}, ${Math.floor(p / EDGE_W)})`)),
        h(
          'table',
          { class: 'rd-tab' },
          h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'green'), h('th', {}, 'white'), h('th', {}, 'blue wall'), h('th', {}, 'alpha'))),
          h(
            'tbody',
            {},
            row(this.kind === 'straight' ? 'filtered texel (straight)' : 'filtered texel (premultiplied)', c[1].toFixed(2), c[2].toFixed(2), '', a.toFixed(2)),
            row('the pixel after blending', r[p * 3 + 1].toFixed(2), r[p * 3 + 2].toFixed(2), r[p * 3].toFixed(2), ''),
          ),
        ),
        h('p', { class: 'll-muted' }, this.kind === 'straight' ? 'Straight: the colour is multiplied by alpha after filtering, so the white from the transparent texels comes along.' : 'Premultiplied: the transparent texels are 0 in every channel, so filtering only ever mixes in nothing.'),
      );
    }
    const e = edgeRun(this.kind);
    this.counts.replaceChildren(stat(e.whitePixels, 'pixels with more than 2% white'), stat(pct(e.maxWhite), 'most white in one pixel'));
  }
}

// =============================================================================================
// Cut-outs: alpha blend, alpha test, alpha to coverage

export class FenceViz {
  private mode: CutoutMode = 'test';
  private target = new Target(FENCE_W, FENCE_H, 4, FENCE_INKS.length);
  private stepper: Stepper;
  private cv = canvas(672, 420, 'A road between two chain-link fences');
  private say = h('p', { class: 'rd-say' });
  private counts = h('div', { class: 'll-stats' });
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-fence');
    this.pal = new Palette(root);
    this.stepper = new Stepper(
      () => {
        this.target = new Target(FENCE_W, FENCE_H, 4, FENCE_INKS.length);
        return render(fenceScene(this.mode), this.target, fenceCamera, { ...DEFAULTS, quads: true }, emptyStats());
      },
      () => this.show(),
    );
    this.stepper.speed = 80;
    const s = this.stepper;
    root.append(
      seg<CutoutMode>('Cut out with', [['blend', 'Alpha blending'], ['test', 'Alpha test (≥ 0.5)'], ['a2c', 'Alpha to coverage']], this.mode, (m) => ((this.mode = m), s.reset(true))).el,
      h('div', { class: 'll-row' }, btn('Next triangle', () => s.next(['triangle'])), s.playBtn, btn('Whole frame', () => s.finish()), btn('Clear', () => s.reset())),
      stage(this.cv, [this.say, this.counts]),
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
    const k = size(this.cv).w / FENCE_W;
    paintInks(ctx, this.target, FENCE_INKS, this.pal, k);
    if (s.lastTri && !s.done) for (const p of s.lastTri.pieces) outlineTri(ctx, p, k, this.pal.css('--accent'));
    const wire = fenceCoverage();
    this.say.textContent = {
      blend: 'Alpha blending: each pixel gets the filtered alpha\'s share of wire. Right at every distance, but it has to be sorted with every other transparent thing.',
      test: 'Alpha test: a pixel is all wire or all hole. Far away the mip levels average the wire with the holes, alpha drops under 0.5, and the fence disappears.',
      a2c: 'Alpha to coverage: alpha picks how many of the pixel\'s 4 MSAA samples are wire, so a pixel can be a quarter, half or three quarters wire. No sorting, and the depth buffer stays right.',
    }[this.mode];
    if (!s.done) {
      this.counts.replaceChildren();
      return;
    }
    const r = fenceRun(this.mode);
    this.counts.replaceChildren(stat(pct(wire), 'of the fence\'s area is wire'), stat(pct(r.near), `wire shown within ${FENCE_NEAR} m`), stat(pct(r.far), `wire shown beyond ${FENCE_FAR} m`));
  }
}
