/**
 * "Render graphs": GraphViz shows a frame's passes and resources as the compiler sees them
 * (scenes/render-graphs.ts). Toggle effects or switch the output to a debug view and the graph
 * recompiles: culled passes greyed out, each resource's lifetime and states, the transitions
 * inserted before each pass, and the transient heap with and without aliasing. Runs on the CPU:
 * it's the compiler, not the frame.
 */
import './engine-side.css';
import { h, seg } from '../../engine/dom';
import { type Compiled, FRAME_DEFAULTS, type FrameOptions, RESOURCES, SCREENS, USE_LABEL, type Use, compile, declare, mbText } from '../scenes/render-graphs';
import { Palette, canvas, chk, ctx2d, fit, frame, mix, onTheme, rgbCss, size, stage, stat } from '../view';

/** Logical canvas size. Phones get a narrower one, so the 11 px labels stay readable when shown. */
interface Layout {
  w: number;
  h: number;
  label: number;
}
const WIDE: Layout = { w: 640, h: 470, label: 96 };
const NARROW: Layout = { w: 360, h: 430, label: 76 };
const HEAD = 22;
const ROW = 16;
const MEM_TOP = HEAD + RESOURCES.length * ROW + 22;
const RES_TOKENS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];

export class GraphViz {
  private o: FrameOptions = { ...FRAME_DEFAULTS };
  private screen = '1080p';
  private alias = true;
  private c!: Compiled;
  private sel = -1;
  private pal: Palette;
  private L = WIDE;
  private cv = this.makeCanvas(WIDE);
  private stats = h('div', { class: 'll-stats' });
  private list = h('ol', { class: 'rd-passes' });
  private detail = h('div', { class: 'rd-pass-detail' });

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-graph');
    this.pal = new Palette(root);
    const toggle = (label: string, key: 'ssao' | 'bloom' | 'taa' | 'transparent') => chk(label, this.o[key], (on) => ((this.o = { ...this.o, [key]: on }), this.update()));
    root.append(
      h('div', { class: 'll-row' }, toggle('SSAO', 'ssao'), toggle('Bloom', 'bloom'), toggle('TAA', 'taa'), toggle('Transparent', 'transparent')),
      h(
        'div',
        { class: 'll-row' },
        seg<FrameOptions['output']>('Screen shows', [['final', 'Final image'], ['normals', 'Normals (debug)']], this.o.output, (v) => ((this.o = { ...this.o, output: v }), this.update())).el,
        seg<string>('Resolution', Object.keys(SCREENS).map((k) => [k, k] as [string, string]), this.screen, (v) => ((this.screen = v), this.update())).el,
        chk('Alias memory', this.alias, (on) => ((this.alias = on), this.update())),
      ),
      stage(this.cv, [this.stats, this.list, this.detail]),
      this.legend(),
    );
    if (typeof ResizeObserver !== 'undefined')
      new ResizeObserver(() => {
        const L = root.clientWidth < 560 ? NARROW : WIDE;
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
  }

  private makeCanvas(L: Layout): HTMLCanvasElement {
    const c = canvas(L.w, L.h, 'Passes in columns, resources in rows: who reads and writes what, the transitions before each pass, and below, the transient memory heap');
    c.addEventListener('click', (e) => {
      const b = c.getBoundingClientRect();
      const x = ((e.clientX - b.left) / b.width) * this.L.w;
      const i = Math.floor((x - this.L.label) / this.colW());
      if (i >= 0 && i < this.c.passes.length) this.select(i === this.sel ? -1 : i);
    });
    fit(c, () => this.draw());
    return c;
  }

  private legend(): HTMLElement {
    const sw = (style: string, label: string) => h('span', { class: 'rd-swatch' }, h('i', { style }), label);
    return h(
      'div',
      { class: 'rd-legend' },
      sw('background: var(--ink)', 'written'),
      sw('border: 2px solid var(--ink)', 'read'),
      sw('background: color-mix(in srgb, var(--accent) 25%, transparent)', 'lifetime'),
      sw('background: var(--warn)', 'transition before the pass'),
      sw('background: var(--alert)', 'aliasing barrier'),
      h('span', {}, 'grey names: imported, not transient'),
    );
  }

  private colW(): number {
    return (this.L.w - this.L.label) / this.c.passes.length;
  }

  private update(): void {
    const [w, hh] = SCREENS[this.screen];
    this.c = compile(declare(this.o), w, hh, this.alias);
    if (this.sel >= this.c.passes.length) this.sel = -1;
    const c = this.c;
    const culled = c.passes.filter((p) => p.culled).length;
    this.stats.replaceChildren(
      stat(c.passes.length, 'passes declared'),
      stat(culled, 'culled'),
      stat(c.transitions, 'transitions'),
      stat(c.barrierCalls, 'barrier calls'),
      stat(c.aliasingBarriers, 'aliasing barriers'),
      stat(mbText(c.totalBytes), 'transients, unaliased'),
      stat(mbText(c.peakBytes), this.alias ? 'peak, aliased' : 'peak'),
    );
    this.list.replaceChildren(
      ...c.passes.map((p, i) =>
        h(
          'li',
          { class: `${p.culled ? 'culled' : ''}${i === this.sel ? ' sel' : ''}`, onclick: () => this.select(i === this.sel ? -1 : i) },
          h('span', { class: 'n' }, String(i + 1)),
          ` ${p.pass.name}`,
          p.culled ? h('span', { class: 'll-muted' }, ' culled') : h('span', { class: 'll-muted' }, ` · ${p.pass.queue}${p.barriers.length ? ` · ${p.barriers.length} transition${p.barriers.length > 1 ? 's' : ''}` : ''}`),
        ),
      ),
    );
    this.showDetail();
    this.draw();
  }

  private select(i: number): void {
    this.sel = i;
    this.update();
  }

  private showDetail(): void {
    const p = this.c.passes[this.sel];
    if (!p) {
      this.detail.replaceChildren(h('p', { class: 'll-muted' }, 'Click a pass (or its column) to see what it reads, writes and waits for.'));
      return;
    }
    const acc = (a: { res: string; use: Use }) => `${a.res} (${USE_LABEL[a.use]})`;
    this.detail.replaceChildren(
      h('div', { class: 'll-h' }, `${this.sel + 1}. ${p.pass.name}${p.culled ? ', culled' : `, dependency level ${p.level}`}`),
      h('p', {}, h('b', {}, 'Reads: '), p.pass.reads.map(acc).join(', ') || 'nothing'),
      h('p', {}, h('b', {}, 'Writes: '), p.pass.writes.map(acc).join(', ')),
      p.culled
        ? h('p', { class: 'll-muted' }, 'Nothing that reaches the screen reads what it writes, so it is never run, and its resources are never allocated.')
        : h(
            'p',
            {},
            h('b', {}, 'Before it: '),
            [...p.aliasing.map((r) => `aliasing barrier for ${r}`), ...p.barriers.map((b) => `${b.res}: ${b.from === 'undefined' ? 'first use (contents undefined)' : USE_LABEL[b.from]} → ${USE_LABEL[b.to]}`)].join('; ') || 'no barriers',
          ),
    );
  }

  private draw(): void {
    const ctx = ctx2d(this.cv);
    const { w, h: H } = size(this.cv);
    const LABEL_W = this.L.label;
    const narrow = this.L === NARROW;
    const MEM_H = H - MEM_TOP - 16;
    const c = this.c;
    const pal = this.pal;
    const bg = pal.rgb('--bg');
    const ink = pal.css('--ink');
    const muted = pal.css('--muted');
    ctx.fillStyle = rgbCss(bg);
    ctx.fillRect(0, 0, w, H);
    const cw = this.colW();
    const X = (i: number) => LABEL_W + i * cw;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    // Columns: one per declared pass, culled ones hatched out.
    c.passes.forEach((p, i) => {
      if (i === this.sel) {
        ctx.fillStyle = rgbCss(pal.rgb('--accent'), 0.12);
        ctx.fillRect(X(i), 0, cw, MEM_TOP - 10);
      }
      if (p.culled) {
        ctx.fillStyle = rgbCss(mix(bg, pal.rgb('--line'), 0.35));
        ctx.fillRect(X(i), HEAD, cw, RESOURCES.length * ROW);
      }
      ctx.fillStyle = p.culled ? muted : ink;
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), X(i) + cw / 2, HEAD / 2);
      if (p.culled) {
        ctx.strokeStyle = muted;
        ctx.beginPath();
        ctx.moveTo(X(i) + cw / 2 - 7, HEAD / 2);
        ctx.lineTo(X(i) + cw / 2 + 7, HEAD / 2);
        ctx.stroke();
      }
    });
    // Rows: resources, their lifetimes (executed passes), reads and writes, transitions.
    const posToCol = c.order;
    RESOURCES.forEach((r, ri) => {
      const y = HEAD + ri * ROW;
      ctx.textAlign = 'left';
      ctx.fillStyle = r.imported ? muted : ink;
      ctx.fillText(r.imported && !narrow ? `${r.name} (imported)` : r.name, 4, y + ROW / 2);
      const pl = c.placements.find((p) => p.res === r.name);
      if (pl) {
        ctx.fillStyle = rgbCss(pal.rgb('--accent'), 0.22);
        ctx.fillRect(X(posToCol[pl.first]) + 2, y + 3, X(posToCol[pl.last]) + cw - X(posToCol[pl.first]) - 4, ROW - 6);
      }
      ctx.strokeStyle = rgbCss(mix(bg, pal.rgb('--line'), 0.6));
      ctx.beginPath();
      ctx.moveTo(LABEL_W, y + ROW);
      ctx.lineTo(w, y + ROW);
      ctx.stroke();
      c.passes.forEach((p, i) => {
        const cx = X(i) + cw / 2;
        const cy = y + ROW / 2;
        const wr = p.pass.writes.some((a) => a.res === r.name);
        const rd = p.pass.reads.some((a) => a.res === r.name);
        if (!wr && !rd) return;
        ctx.globalAlpha = p.culled ? 0.35 : 1;
        if (wr) {
          ctx.fillStyle = ink;
          ctx.fillRect(cx - 4, cy - 4, 8, 8);
        } else {
          ctx.strokeStyle = ink;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(cx - 3.5, cy - 3.5, 7, 7);
        }
        ctx.globalAlpha = 1;
        if (!p.culled && p.barriers.some((b) => b.res === r.name)) {
          ctx.fillStyle = pal.css('--warn');
          ctx.beginPath();
          ctx.moveTo(X(i) + 1, cy - 5);
          ctx.lineTo(X(i) + 6, cy);
          ctx.lineTo(X(i) + 1, cy + 5);
          ctx.fill();
        }
        if (!p.culled && p.aliasing.includes(r.name)) {
          ctx.fillStyle = pal.css('--alert');
          ctx.fillRect(X(i) + 1, cy + 3, cw - 2, 2.5);
        }
      });
    });
    // The heap: each transient placed at its offset for its lifetime.
    const peak = Math.max(c.totalBytes, 1);
    const scale = MEM_H / peak;
    const base = MEM_TOP + MEM_H;
    ctx.textAlign = 'left';
    ctx.fillStyle = muted;
    ctx.fillText('Transient heap', 4, MEM_TOP - 8);
    ctx.fillText(`0 MB`, 4, base - 4);
    ctx.strokeStyle = rgbCss(mix(bg, pal.rgb('--line'), 0.8));
    ctx.strokeRect(LABEL_W, MEM_TOP, w - LABEL_W, MEM_H);
    c.placements.forEach((p) => {
      const ri = RESOURCES.findIndex((r) => r.name === p.res);
      const x0 = X(posToCol[p.first]) + 1;
      const x1 = X(posToCol[p.last]) + cw - 1;
      const y1 = base - p.offset * scale;
      const y0 = base - (p.offset + p.bytes) * scale;
      const col = pal.rgb(RES_TOKENS[ri % RES_TOKENS.length]);
      ctx.fillStyle = rgbCss(mix(bg, col, 0.55));
      ctx.fillRect(x0, y0 + 0.5, x1 - x0, y1 - y0 - 1);
      if (y1 - y0 > 11 && x1 - x0 > 30) {
        ctx.fillStyle = ink;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, x1 - x0, y1 - y0);
        ctx.clip();
        ctx.fillText(p.res, x0 + 3, (y0 + y1) / 2);
        ctx.restore();
      }
    });
    const py = base - c.peakBytes * scale;
    ctx.strokeStyle = pal.css('--accent');
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(LABEL_W, py);
    ctx.lineTo(w, py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = pal.css('--accent');
    ctx.fillText(`peak ${mbText(c.peakBytes)}`, 4, py);
    if (this.alias) {
      ctx.fillStyle = muted;
      ctx.fillText(`${mbText(c.totalBytes)}`, 4, MEM_TOP + 6);
    }
  }
}
