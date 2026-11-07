/**
 * The texture-atlas lesson's widgets: PackViz (four rectangle packers placing the same sprites one
 * at a time, with what each keeps between placements and a comparison of all of them) and BleedViz
 * (one sprite of a small atlas drawn with bilinear filtering and mipmaps, showing how much of each
 * pixel comes from somewhere else, with padding and extrusion to fix it).
 */
import { h, seg } from '../../engine/dom';
import {
  ATLAS_W,
  EMPTY,
  type Fill,
  type Filter,
  type Heuristic,
  OWNERS,
  PACKER_ROWS,
  type PackResult,
  type PackSettings,
  type PackerKind,
  SPR,
  type ScreenPixel,
  ZOOMS,
  bleedAtlas,
  bleedText,
  drawSprite,
  efficiency,
  nextPow2,
  packSmallest,
  rowLabel,
  spriteSet,
  worstBleed,
  zoomLabel,
} from '../scenes/texture-atlases';
import { Palette, type RGB, btn, canvas, chk, ctx2d, fit, frame, mix, onTheme, rgbCss, size, stage, stat } from '../view';
import './quirky.css';

/** The atlas area the packer view shows: 256 × 384 texels (every setting fits; the claims check). */
export const VIEW_H = 384;

const SPRITE_COLS = ['--c2', '--c3', '--c5', '--c6'];
const COLS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];

function slider(label: string, min: number, max: number, value: number, show: (v: number) => string, onInput: (v: number) => void): HTMLElement {
  const out = h('output', {}, show(value));
  const inp = h('input', { type: 'range', min: String(min), max: String(max), step: '1', value: String(value), 'aria-label': label }) as HTMLInputElement;
  inp.addEventListener('input', () => {
    out.textContent = show(Number(inp.value));
    onInput(Number(inp.value));
  });
  return h('label', { class: 'rq-slider' }, h('span', {}, label), inp, out);
}

// =============================================================================================
// Packing

type PackChoice = 'shelf' | 'skyline' | 'guillotine' | 'maxrects-bssf' | 'maxrects-bl';
const CHOICES: Array<[PackChoice, string]> = [
  ['shelf', 'Shelf'],
  ['skyline', 'Skyline'],
  ['guillotine', 'Guillotine'],
  ['maxrects-bssf', 'MaxRects BSSF'],
  ['maxrects-bl', 'MaxRects BL'],
];
const choiceSettings = (c: PackChoice): [PackerKind, Heuristic] =>
  c === 'maxrects-bssf' ? ['maxrects', 'bssf'] : c === 'maxrects-bl' ? ['maxrects', 'bl'] : c === 'guillotine' ? ['guillotine', 'baf'] : [c, 'bssf'];

export class PackViz {
  private sprites = spriteSet();
  private choice: PackChoice = 'maxrects-bssf';
  private rotate = false;
  private padding = 0;
  private result!: PackResult;
  private shown = 0;
  private raf = 0;
  private cache = new Map<string, PackResult>();
  private cv = canvas(512, 2 * VIEW_H, 'The atlas being packed, 256 texels wide');
  private why = h('p', { class: 'rd-say' });
  private counts = h('div', { class: 'll-stats' });
  private table = h('table', { class: 'rd-tab rq-tab' });
  private playBtn: HTMLButtonElement;
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-pack');
    this.pal = new Palette(root);
    this.playBtn = btn('Run', () => (this.raf ? this.pause() : this.play()), true);
    const re = () => this.repack();
    root.append(
      seg<PackChoice>('Packer', CHOICES, this.choice, (c) => ((this.choice = c), re())).el,
      h(
        'div',
        { class: 'll-row' },
        seg<string>('Padding', [['0', '0'], ['1', '1 texel'], ['2', '2 texels']], '0', (v) => ((this.padding = Number(v)), re())).el,
        chk('Allow rotation', false, (on) => ((this.rotate = on), re())),
      ),
      h(
        'div',
        { class: 'll-row' },
        btn('Next sprite', () => this.step(1)),
        this.playBtn,
        btn('Whole atlas', () => this.step(Infinity)),
        btn('Clear', () => this.step(-Infinity)),
      ),
      stage(this.cv, [this.why, this.counts, h('div', { class: 'll-h' }, 'Every packer, same sprites and settings'), h('div', { class: 'rd-read' }, this.table)]),
    );
    onTheme(() => {
      this.pal.reset();
      this.draw();
    });
    fit(this.cv, () => this.draw());
    this.repack();
  }

  private settings(c: PackChoice = this.choice): PackSettings {
    const [packer, heuristic] = choiceSettings(c);
    return { packer, heuristic, rotate: this.rotate, padding: this.padding };
  }
  private packed(s: PackSettings): PackResult {
    const key = JSON.stringify(s);
    let r = this.cache.get(key);
    if (!r) {
      r = packSmallest(this.sprites, s);
      this.cache.set(key, r);
    }
    return r;
  }
  private repack(): void {
    this.pause();
    this.result = this.packed(this.settings());
    this.shown = this.result.steps.length;
    this.fillTable();
    this.draw();
  }
  private step(n: number): void {
    this.pause();
    this.shown = Math.max(0, Math.min(this.result.steps.length, this.shown >= this.result.steps.length && n === 1 ? 1 : this.shown + n));
    this.draw();
  }
  private play(): void {
    if (this.shown >= this.result.steps.length) this.shown = 0;
    this.playBtn.textContent = 'Pause';
    let t = 0;
    const tick = () => {
      if (++t % 4 === 0) this.shown++;
      this.draw();
      if (this.shown >= this.result.steps.length) this.pause();
      else this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  private pause(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.playBtn.textContent = 'Run';
  }

  private fillTable(): void {
    const head = h('tr', {}, h('th', {}, 'Packer'), h('th', {}, 'Smallest'), h('th', {}, 'Used'), h('th', {}, 'Power of 2'), h('th', {}, 'Used'));
    const [k0, h0] = choiceSettings(this.choice);
    const rows = PACKER_ROWS.map(([k, heur]) => {
      const r = this.packed({ packer: k, heuristic: heur, rotate: this.rotate, padding: this.padding });
      const pot = nextPow2(r.H);
      return h(
        'tr',
        { class: k === k0 && heur === h0 ? 'on' : '' },
        h('th', {}, CHOICES.find(([c]) => choiceSettings(c)[0] === k && choiceSettings(c)[1] === heur)?.[1] ?? rowLabel(k, heur)),
        h('td', {}, `${r.W} × ${r.H}`),
        h('td', {}, `${efficiency(r).toFixed(1)}%`),
        h('td', {}, `${r.W} × ${pot}`),
        h('td', {}, `${efficiency(r, pot).toFixed(1)}%`),
      );
    });
    this.table.replaceChildren(head, ...rows);
  }

  private draw(): void {
    const ctx = ctx2d(this.cv);
    const { w: W, h: H } = size(this.cv);
    const k = W / ATLAS_W;
    const r = this.result;
    ctx.fillStyle = this.pal.css('--bg');
    ctx.fillRect(0, 0, W, H);
    // A light grid every 32 texels.
    ctx.strokeStyle = this.pal.css('--line-soft');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 32; x < ATLAS_W; x += 32) {
      ctx.moveTo(x * k, 0);
      ctx.lineTo(x * k, H);
    }
    for (let y = 32; y < VIEW_H; y += 32) {
      ctx.moveTo(0, y * k);
      ctx.lineTo(W, y * k);
    }
    ctx.stroke();
    const bg = this.pal.rgb('--bg');
    const steps = r.steps.slice(0, this.shown);
    for (const st of steps) {
      const p = st.placed;
      const c = this.pal.rgb(COLS[p.id % COLS.length]);
      ctx.fillStyle = rgbCss(mix(bg, c, 0.7));
      ctx.fillRect(p.x * k, p.y * k, p.w * k, p.h * k);
      ctx.strokeStyle = rgbCss(c);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(p.x * k + 0.75, p.y * k + 0.75, p.w * k - 1.5, p.h * k - 1.5);
      if (p.rotated) {
        // A small mark in the corner: this sprite is stored turned 90°.
        ctx.fillStyle = this.pal.css('--ink');
        ctx.beginPath();
        ctx.moveTo(p.x * k + 3, p.y * k + 3);
        ctx.lineTo(p.x * k + 11, p.y * k + 3);
        ctx.lineTo(p.x * k + 3, p.y * k + 11);
        ctx.fill();
      }
    }
    // What the packer keeps.
    const last = steps[steps.length - 1];
    const accent = this.pal.css('--accent');
    if (last && this.shown < r.steps.length) {
      const a = last.aux;
      ctx.lineWidth = 1.5;
      if (a.free) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = accent;
        for (const f of a.free) ctx.strokeRect(f.x * k + 1, f.y * k + 1, Math.min(f.w, ATLAS_W) * k - 2, Math.min(f.h, VIEW_H - f.y) * k - 2);
        ctx.setLineDash([]);
      }
      if (a.shelves) {
        ctx.strokeStyle = accent;
        for (const s of a.shelves) {
          ctx.beginPath();
          ctx.moveTo(0, (s.y + s.h) * k);
          ctx.lineTo(W, (s.y + s.h) * k);
          ctx.stroke();
        }
      }
      if (a.skyline) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 3;
        ctx.beginPath();
        a.skyline.forEach((s, i) => {
          if (i) ctx.lineTo(s.x * k, s.y * k);
          else ctx.moveTo(s.x * k, s.y * k);
          ctx.lineTo((s.x + s.w) * k, s.y * k);
        });
        ctx.stroke();
      }
      const p = last.placed;
      ctx.strokeStyle = this.pal.css('--ink');
      ctx.lineWidth = 3;
      ctx.strokeRect(p.x * k, p.y * k, p.w * k, p.h * k);
    }
    // The atlas edge, and the power-of-two edge.
    const pot = nextPow2(r.H);
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.pal.css('--ink');
    ctx.beginPath();
    ctx.moveTo(0, r.H * k);
    ctx.lineTo(W, r.H * k);
    ctx.stroke();
    ctx.setLineDash([10, 6]);
    ctx.strokeStyle = this.pal.css('--warn');
    if (pot <= VIEW_H) {
      ctx.beginPath();
      ctx.moveTo(0, pot * k);
      ctx.lineTo(W, pot * k);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const n = r.steps.length;
    if (this.shown === 0) this.why.textContent = `${n} sprites to place, ${this.choice === 'shelf' ? 'tallest' : 'largest'} first. Step through them, or run.`;
    else if (this.shown < n) {
      const p = last.placed;
      this.why.replaceChildren(h('b', {}, `Sprite ${this.shown} of ${n}, ${p.w} × ${p.h}${p.rotated ? ' (rotated)' : ''}: `), `${last.why}.`);
    } else this.why.textContent = `All ${n} sprites placed. The solid line is the bottom of the smallest atlas, the dashed line the next power of two${pot > VIEW_H ? ` (${pot}, below the view)` : ''}.`;
    this.counts.replaceChildren(stat(`${r.W} × ${r.H}`, 'smallest atlas'), stat(`${efficiency(r).toFixed(1)}%`, 'sprite pixels'), stat(`${efficiency(r, pot).toFixed(1)}%`, `at ${r.W} × ${pot}`));
  }
}

// =============================================================================================
// Bleeding

export class BleedViz {
  private padding = 0;
  private fill: Fill = 'empty';
  private filter: Filter = 'bilinear';
  private zoom: number = 2;
  private offset = 5;
  private pick: { x: number; y: number } | null = null;
  private atlasCv = canvas(360, 380, 'The atlas at the mip level in use, one square per texel', 'rd-canvas', { maxWidth: 360 });
  private screenCv = canvas(360, 380, 'Sprite A on screen, one square per pixel', 'rd-canvas', { maxWidth: 360 });
  private say = h('p', { class: 'rd-say' });
  private worst = h('p', { class: 'rd-say' });
  private pal: Palette;
  private pixels: ScreenPixel[] = [];
  private screenSize = 0;
  private atlases = new Map<string, ReturnType<typeof bleedAtlas>>();
  private worsts = new Map<string, ReturnType<typeof worstBleed>>();

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-bleed');
    this.pal = new Palette(root);
    const re = () => ((this.pick = null), this.draw());
    const fig = h('div', { class: 'rd-fig rq-pair' }, this.atlasCv, this.screenCv);
    fig.style.setProperty('--rd-ar', String(730 / 380));
    fig.style.setProperty('--rd-max-w', '730px');
    root.append(
      h(
        'div',
        { class: 'll-row' },
        seg<string>('Padding', [['0', '0'], ['1', '1'], ['2', '2'], ['4', '4']], '0', (v) => ((this.padding = Number(v)), re())).el,
        seg<Fill>('Filled with', [['empty', 'Nothing'], ['extrude', 'Extruded edges']], this.fill, (v) => ((this.fill = v), re())).el,
      ),
      h(
        'div',
        { class: 'll-row' },
        seg<string>('Size', ZOOMS.map((z) => [String(z), zoomLabel(z)] as [string, string]), String(this.zoom), (v) => ((this.zoom = Number(v)), re())).el,
        seg<Filter>('Filter', [['bilinear', 'Bilinear'], ['nearest', 'Nearest']], this.filter, (v) => ((this.filter = v), re())).el,
      ),
      slider('Sub-pixel offset', 0, 15, this.offset, (v) => `${v}/16 px`, (v) => ((this.offset = v), re())),
      stage(
        fig,
        [
          h(
            'div',
            { class: 'rq-key' },
            ...(['A', 'B', 'C', 'D'] as const).map((n, i) => h('span', {}, h('i', { style: `background: var(${SPRITE_COLS[i]})` }), `sprite ${n}`)),
            h('span', {}, h('i', { style: 'border: 1px solid var(--line)' }), 'empty'),
          ),
          this.say,
          this.worst,
        ],
        730 / 380,
      ),
    );
    const hover = (e: PointerEvent) => {
      const b = this.screenCv.getBoundingClientRect();
      const k2 = this.screenScale();
      const x = Math.floor(((((e.clientX - b.left) / b.width) * 360 - 4) / k2));
      const y = Math.floor(((((e.clientY - b.top) / b.height) * 380 - 4) / k2));
      if (this.pixels.some((p) => p.x === x && p.y === y)) {
        this.pick = { x, y };
        this.draw();
      }
    };
    this.screenCv.addEventListener('pointermove', hover);
    this.screenCv.addEventListener('pointerdown', hover);
    onTheme(() => {
      this.pal.reset();
      this.draw();
    });
    fit(this.atlasCv, () => this.draw());
    fit(this.screenCv, () => this.draw());
    this.draw();
  }

  private screenScale(): number {
    return 352 / Math.max(this.screenSize, 18);
  }
  private colour(own: ArrayLike<number>, lum: number): RGB {
    const bg = this.pal.rgb('--bg');
    const cols = SPRITE_COLS.map((t) => this.pal.rgb(t));
    let c: RGB = [0, 0, 0];
    const shade = 0.3 + 0.7 * lum;
    for (let k = 0; k < OWNERS; k++) {
      const v = k === EMPTY ? bg : mix(bg, cols[k], shade);
      c = [c[0] + v[0] * own[k], c[1] + v[1] * own[k], c[2] + v[2] * own[k]];
    }
    return c;
  }

  private draw(): void {
    const key = `${this.padding} ${this.fill}`;
    let atlas = this.atlases.get(key);
    if (!atlas) this.atlases.set(key, (atlas = bleedAtlas(this.padding, this.fill)));
    const o = this.offset / 16;
    const d = drawSprite(atlas, this.zoom, o, o, this.filter);
    this.pixels = d.pixels;
    this.screenSize = d.size;
    const L = atlas.levels[d.level];
    // The worst pixel is picked unless the reader points at one.
    let pick = this.pick ? d.pixels.find((p) => p.x === this.pick!.x && p.y === this.pick!.y) : undefined;
    if (!pick) for (const p of d.pixels) if (!pick || 1 - p.own[0] > 1 - pick.own[0] + 1e-12) pick = p;
    const ink = this.pal.css('--ink');
    const alert = this.pal.css('--alert');

    // The atlas level, as big texels.
    {
      const ctx = ctx2d(this.atlasCv);
      const { w: W, h: H } = size(this.atlasCv);
      ctx.fillStyle = this.pal.css('--bg');
      ctx.fillRect(0, 0, W, H);
      const k = 352 / L.n;
      ctx.save();
      ctx.translate(4, 4);
      const m = ctx.getTransform();
      const px = (v: number) => Math.round(v * m.a + m.e);
      const py = (v: number) => Math.round(v * m.d + m.f);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (let y = 0; y < L.n; y++)
        for (let x = 0; x < L.n; x++) {
          const i = y * L.n + x;
          ctx.fillStyle = rgbCss(this.colour(L.own.subarray(i * OWNERS, i * OWNERS + OWNERS), L.lum[i]));
          ctx.fillRect(px(x * k), py(y * k), px((x + 1) * k) - px(x * k), py((y + 1) * k) - py(y * k));
        }
      ctx.setTransform(m);
      const s = 2 ** d.level;
      // Sprite A's rectangle at this level, and its cell (sprite plus padding).
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      ctx.strokeRect((atlas.padding / s) * k, (atlas.padding / s) * k, (SPR / s) * k, (SPR / s) * k);
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(0, 0, (atlas.cell / s) * k, (atlas.cell / s) * k);
      ctx.setLineDash([]);
      if (pick) {
        // The sample point and the texels it reads.
        const u = pick.u / s;
        const v = pick.v / s;
        ctx.strokeStyle = alert;
        ctx.lineWidth = 2.5;
        if (this.filter === 'bilinear') ctx.strokeRect(Math.floor(u - 0.5) * k, Math.floor(v - 0.5) * k, 2 * k, 2 * k);
        else ctx.strokeRect(Math.floor(u) * k, Math.floor(v) * k, k, k);
        ctx.fillStyle = alert;
        ctx.beginPath();
        ctx.arc(u * k, v * k, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      ctx.font = '15px sans-serif';
      ctx.fillStyle = this.pal.css('--muted');
      ctx.fillText(`atlas, mip level ${d.level} (${L.n} × ${L.n} texels)`, 6, H - 7);
    }

    // The sprite on screen.
    {
      const ctx = ctx2d(this.screenCv);
      const { w: W, h: H } = size(this.screenCv);
      ctx.fillStyle = this.pal.css('--bg');
      ctx.fillRect(0, 0, W, H);
      const k2 = this.screenScale();
      ctx.save();
      ctx.translate(4, 4);
      ctx.strokeStyle = this.pal.css('--line-soft');
      ctx.lineWidth = 1;
      const shownPx = Math.floor(352 / k2);
      ctx.beginPath();
      for (let i = 0; i <= shownPx; i++) {
        ctx.moveTo(i * k2, 0);
        ctx.lineTo(i * k2, shownPx * k2);
        ctx.moveTo(0, i * k2);
        ctx.lineTo(shownPx * k2, i * k2);
      }
      ctx.stroke();
      for (const p of d.pixels) {
        ctx.fillStyle = rgbCss(this.colour(p.own, p.lum));
        ctx.fillRect(p.x * k2, p.y * k2, k2, k2);
      }
      ctx.strokeStyle = alert;
      ctx.lineWidth = Math.max(1.5, Math.min(2.5, k2 / 6));
      const inset = Math.min(2, k2 / 6);
      for (const p of d.pixels) if (1 - p.own[0] > 0.005) ctx.strokeRect(p.x * k2 + inset, p.y * k2 + inset, k2 - 2 * inset, k2 - 2 * inset);
      // The quad's outline.
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.strokeRect(o * k2, o * k2, SPR * this.zoom * k2, SPR * this.zoom * k2);
      ctx.setLineDash([]);
      if (pick) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 3;
        ctx.strokeRect(pick.x * k2, pick.y * k2, k2, k2);
      }
      ctx.restore();
      ctx.font = '15px sans-serif';
      ctx.fillStyle = this.pal.css('--muted');
      ctx.fillText(`screen: sprite A at ${zoomLabel(this.zoom)}, one square per pixel`, 6, H - 7);
    }

    if (pick) {
      const nb = pick.own[1] + pick.own[2] + pick.own[3];
      const em = pick.own[EMPTY];
      this.say.replaceChildren(
        h('b', {}, `Pixel (${pick.x}, ${pick.y})`),
        ` samples the atlas at (${pick.u.toFixed(2)}, ${pick.v.toFixed(2)}) on level ${d.level}: `,
        nb + em < 1e-12 ? h('span', { class: 'det-ok' }, 'all of it is sprite A.') : h('span', { class: 'det-bad' }, `${bleedText(nb)} from other sprites, ${bleedText(em)} empty.`),
      );
    }
    const wk = `${key} ${this.zoom} ${this.filter}`;
    let w = this.worsts.get(wk);
    if (!w) this.worsts.set(wk, (w = worstBleed(atlas, this.zoom, this.filter)));
    this.worst.replaceChildren(h('b', {}, 'Worst pixel over every offset: '), `${bleedText(w.neighbour)} from other sprites, ${bleedText(w.any)} that isn't sprite A.`);
  }
}
