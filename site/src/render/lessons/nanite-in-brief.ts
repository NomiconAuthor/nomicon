/**
 * The Nanite lesson's widgets: ClusterLodViz (a cluster hierarchy built Nanite's way, one dimension
 * down, with the cut chosen per frame from where the viewer stands and an error threshold) and
 * QuadViz (a square of screen split into ever smaller triangles, with the 2 × 2 quads a hardware
 * rasteriser would shade for them).
 */
import { h, seg } from '../../engine/dom';
import {
  BUILD_LABEL,
  type Build,
  type Hierarchy,
  QUAD_DIVS,
  QUAD_PX,
  SEGMENTS,
  THRESHOLD_START,
  VIEW_START,
  type Viewer,
  WORLD_H,
  WORLD_W,
  buildHierarchy,
  cut,
  laneUse,
  quadModel,
} from '../scenes/nanite-in-brief';
import { Palette, canvas, ctx2d, fit, frame, mix, onTheme, plural, rgbCss, size, stage, stat } from '../view';
import './quirky.css';

const LEVEL_COLS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];
export const THRESHOLDS = [0.25, 0.5, 1, 2, 4, 8];

/** A font size in logical px that shows at least `min` CSS px however small the canvas is shown. */
function labelPx(cv: HTMLCanvasElement, px: number, min = 10.5): number {
  const shown = cv.clientWidth;
  return shown > 0 ? Math.max(px, (min * size(cv).w) / shown) : px;
}


export class ClusterLodViz {
  private build: Build = 'dag';
  private threshold = THRESHOLD_START;
  private viewer: Viewer = { ...VIEW_START };
  private hy = new Map<Build, Hierarchy>();
  private cv = canvas(WORLD_W, WORLD_H, 'An outline of 1,024 segments drawn from clusters at the level of detail chosen for the viewer');
  private chart = canvas(480, 240, 'Segments drawn against the viewer\'s distance, for both builds', 'rd-canvas rd-chart');
  private counts = h('div', { class: 'll-stats' });
  private key = h('div', { class: 'rq-key' });
  private say = h('p', { class: 'rd-say' });
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-lod');
    this.pal = new Palette(root);
    const out = h('output', {}, `${this.threshold} px`);
    const inp = h('input', { type: 'range', min: '0', max: String(THRESHOLDS.length - 1), step: '1', value: String(THRESHOLDS.indexOf(this.threshold)), 'aria-label': 'Error threshold in pixels' }) as HTMLInputElement;
    inp.addEventListener('input', () => {
      this.threshold = THRESHOLDS[Number(inp.value)];
      out.textContent = `${this.threshold} px`;
      this.draw();
    });
    root.append(
      seg<Build>('Build', [['dag', BUILD_LABEL.dag], ['alone', BUILD_LABEL.alone]], this.build, (b) => ((this.build = b), this.draw())).el,
      h('label', { class: 'rq-slider' }, h('span', {}, 'Error threshold'), inp, out),
      stage(this.cv, [this.say, this.counts, this.key, h('div', { class: 'll-h' }, 'Segments drawn as the viewer backs away (same direction)'), this.chart]),
    );
    this.cv.style.touchAction = 'none';
    let drag = false;
    const move = (e: PointerEvent) => {
      const b = this.cv.getBoundingClientRect();
      this.viewer = { x: Math.max(0, Math.min(WORLD_W, ((e.clientX - b.left) / b.width) * WORLD_W)), y: Math.max(0, Math.min(WORLD_H, ((e.clientY - b.top) / b.height) * WORLD_H)) };
      this.draw();
    };
    this.cv.addEventListener('pointerdown', (e) => {
      drag = true;
      this.cv.setPointerCapture(e.pointerId);
      move(e);
    });
    this.cv.addEventListener('pointermove', (e) => drag && move(e));
    this.cv.addEventListener('pointerup', () => (drag = false));
    onTheme(() => {
      this.pal.reset();
      this.draw();
    });
    fit(this.cv, () => this.draw());
    fit(this.chart, () => this.drawChart());
    this.draw();
  }

  private hier(b: Build): Hierarchy {
    let x = this.hy.get(b);
    if (!x) this.hy.set(b, (x = buildHierarchy(b)));
    return x;
  }

  private draw(): void {
    const hy = this.hier(this.build);
    const c = cut(hy, this.viewer, this.threshold);
    const ctx = ctx2d(this.cv);
    const { w: W, h: H } = size(this.cv);
    ctx.fillStyle = this.pal.css('--bg');
    ctx.fillRect(0, 0, W, H);
    // The full-detail outline, faint.
    const pts = hy.pts;
    ctx.strokeStyle = this.pal.css('--line-soft');
    ctx.lineWidth = 1;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    // The cut: each cluster's segments in its level's colour, with its ends marked.
    ctx.lineJoin = 'round';
    for (const cl of c.clusters) {
      ctx.strokeStyle = this.pal.css(LEVEL_COLS[cl.level % LEVEL_COLS.length]);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      cl.chain.forEach((i, j) => {
        const p = pts[i % SEGMENTS];
        if (j) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      });
      ctx.stroke();
    }
    ctx.fillStyle = this.pal.css('--ink');
    for (const cl of c.clusters) {
      const p = pts[cl.chain[0] % SEGMENTS];
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    // The viewer.
    const v = this.viewer;
    ctx.fillStyle = this.pal.css('--accent');
    ctx.beginPath();
    ctx.arc(v.x, v.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = this.pal.css('--accent');
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.arc(v.x, v.y, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    const fp = labelPx(this.cv, 14);
    ctx.font = `${fp}px sans-serif`;
    ctx.fillStyle = this.pal.css('--muted');
    const hint = 'drag the viewer';
    ctx.fillText(hint, Math.min(v.x + 16, W - ctx.measureText(hint).width - 6), v.y < 2 * fp ? v.y + 16 + fp : v.y - 18);

    this.say.replaceChildren(
      h('b', {}, `${c.segments.toLocaleString('en-US')} of ${SEGMENTS.toLocaleString('en-US')} segments`),
      ` from ${plural(c.clusters.length, 'cluster')}. `,
      c.watertight ? h('span', { class: 'det-ok' }, 'The clusters meet end to end: no cracks.') : h('span', { class: 'det-bad' }, 'There is a crack in the cut.'),
    );
    this.counts.replaceChildren(stat(`${this.threshold} px`, 'error allowed'), stat(c.clusters.length, 'clusters drawn'));
    this.key.replaceChildren(
      ...c.perLevel.flatMap((n, l) => (n ? [h('span', {}, h('i', { style: `background: var(${LEVEL_COLS[l % LEVEL_COLS.length]})` }), `level ${l}: ${n}`)] : [])),
    );
    this.drawChart();
  }

  private drawChart(): void {
    const cv = this.chart;
    const ctx = ctx2d(cv);
    const { w: W, h: H } = size(cv);
    ctx.fillStyle = this.pal.css('--bg');
    ctx.fillRect(0, 0, W, H);
    const fp = labelPx(cv, 14);
    const pad = { l: Math.max(56, 16 + 3 * fp * 0.6), r: 12, t: 12 + fp, b: 20 + fp };
    const d0 = 50;
    const d1 = 50000;
    const s0 = 4;
    const s1 = SEGMENTS;
    const X = (d: number) => pad.l + ((Math.log10(d) - Math.log10(d0)) / (Math.log10(d1) - Math.log10(d0))) * (W - pad.l - pad.r);
    const Y = (s: number) => pad.t + ((Math.log10(s1) - Math.log10(Math.max(s0, s))) / (Math.log10(s1) - Math.log10(s0))) * (H - pad.t - pad.b);
    ctx.font = `${fp}px sans-serif`;
    ctx.strokeStyle = this.pal.css('--line-soft');
    ctx.fillStyle = this.pal.css('--muted');
    ctx.lineWidth = 1;
    for (const s of [8, 32, 128, 512]) {
      ctx.beginPath();
      ctx.moveTo(pad.l, Y(s));
      ctx.lineTo(W - pad.r, Y(s));
      ctx.stroke();
      ctx.fillText(String(s), 8, Y(s) + fp * 0.35);
    }
    for (const d of [100, 1000, 10000]) {
      ctx.beginPath();
      ctx.moveTo(X(d), pad.t);
      ctx.lineTo(X(d), H - pad.b);
      ctx.stroke();
      const t = d.toLocaleString('en-US');
      ctx.fillText(t, X(d) - ctx.measureText(t).width / 2, H - 12);
    }
    // Distances are measured from the middle of the outline.
    const pts = this.hier('dag').pts;
    const CENTRE = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
    let dx = this.viewer.x - CENTRE.x;
    let dy = this.viewer.y - CENTRE.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len;
    dy /= len;
    const builds: Array<[Build, string]> = [
      ['dag', '--c1'],
      ['alone', '--c3'],
    ];
    for (const [b, col] of builds) {
      ctx.strokeStyle = this.pal.css(col);
      ctx.lineWidth = b === this.build ? 3 : 1.6;
      ctx.beginPath();
      for (let i = 0; i <= 60; i++) {
        const d = d0 * Math.pow(d1 / d0, i / 60);
        const s = cut(this.hier(b), { x: CENTRE.x + dx * d, y: CENTRE.y + dy * d }, this.threshold).segments;
        if (i) ctx.lineTo(X(d), Y(s));
        else ctx.moveTo(X(d), Y(s));
      }
      ctx.stroke();
    }
    if (len >= d0) {
      ctx.strokeStyle = this.pal.css('--accent');
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(X(len), pad.t);
      ctx.lineTo(X(len), H - pad.b);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    let lx = pad.l + 6;
    for (const [b, col] of builds) {
      ctx.fillStyle = this.pal.css(col);
      ctx.fillRect(lx, 4 + fp * 0.5, 14, 4);
      ctx.fillStyle = this.pal.css('--body');
      const label = b === 'dag' ? 'groups (DAG)' : 'each cluster alone';
      ctx.fillText(label, lx + 18, 6 + fp * 0.85);
      lx += 18 + ctx.measureText(label).width + 20;
    }
    ctx.fillStyle = this.pal.css('--muted');
    ctx.fillText('distance', W - pad.r - ctx.measureText('distance').width, H - 12);
  }
}

// =============================================================================================
// Small triangles and quads

export class QuadViz {
  private div = 8;
  private cv = canvas(384, 384, 'A 32 × 32 pixel square covered by triangles, shaded by how many triangles each 2 × 2 quad was shaded for', 'rd-canvas', { maxWidth: 420 });
  private counts = h('div', { class: 'll-stats' });
  private table = h('table', { class: 'rd-tab rq-tab' });
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-quads');
    this.pal = new Palette(root);
    root.append(
      seg<string>('Triangles', QUAD_DIVS.map((d) => [String(d), (2 * d * d).toLocaleString('en-US')] as [string, string]), String(this.div), (v) => ((this.div = Number(v)), this.draw())).el,
      stage(this.cv, [
        h(
          'div',
          { class: 'rq-key' },
          h('span', {}, h('i', { class: 'q1' }), 'quad shaded for 1 triangle'),
          h('span', {}, h('i', { class: 'q2' }), '2'),
          h('span', {}, h('i', { class: 'q3' }), '3 or more'),
        ),
        this.counts,
        h('div', { class: 'rd-read' }, this.table),
      ]),
    );
    onTheme(() => {
      this.pal.reset();
      this.draw();
    });
    fit(this.cv, () => this.draw());
    this.draw();
  }

  private draw(): void {
    const q = quadModel(this.div);
    const ctx = ctx2d(this.cv);
    const { w: W, h: H } = size(this.cv);
    const k = W / QUAD_PX;
    const bg = this.pal.rgb('--bg');
    const heat = [this.pal.rgb('--ink'), this.pal.rgb('--warn'), this.pal.rgb('--alert')];
    ctx.fillStyle = this.pal.css('--bg');
    ctx.fillRect(0, 0, W, H);
    for (let y = 0; y < QUAD_PX; y++)
      for (let x = 0; x < QUAD_PX; x++) {
        const t = q.lanesAt[y * QUAD_PX + x] / 4;
        if (!t) continue;
        ctx.fillStyle = rgbCss(t === 1 ? mix(bg, heat[0], 0.22) : t === 2 ? mix(bg, heat[1], 0.6) : mix(bg, heat[2], Math.min(1, 0.45 + 0.08 * t)));
        ctx.fillRect(x * k, y * k, k, k);
      }
    // Quad borders, then the triangles' edges.
    ctx.strokeStyle = this.pal.css('--line');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= QUAD_PX; i += 2) {
      ctx.moveTo(i * k, 0);
      ctx.lineTo(i * k, H);
      ctx.moveTo(0, i * k);
      ctx.lineTo(W, i * k);
    }
    ctx.stroke();
    ctx.strokeStyle = this.pal.css('--ink');
    ctx.globalAlpha = 0.7;
    const off = { x: 77 / 256, y: 51 / 256 };
    const step = QUAD_PX / this.div;
    ctx.beginPath();
    for (let i = 0; i <= this.div; i++) {
      ctx.moveTo((off.x + i * step) * k, off.y * k);
      ctx.lineTo((off.x + i * step) * k, (off.y + QUAD_PX) * k);
      ctx.moveTo(off.x * k, (off.y + i * step) * k);
      ctx.lineTo((off.x + QUAD_PX) * k, (off.y + i * step) * k);
    }
    for (let j = 0; j < this.div; j++)
      for (let i = 0; i < this.div; i++) {
        ctx.moveTo((off.x + i * step) * k, (off.y + j * step) * k);
        ctx.lineTo((off.x + (i + 1) * step) * k, (off.y + (j + 1) * step) * k);
      }
    ctx.stroke();
    ctx.globalAlpha = 1;
    this.counts.replaceChildren(
      stat(q.triangles.toLocaleString('en-US'), 'triangles'),
      stat(q.pixels.toLocaleString('en-US'), 'pixels covered'),
      stat((4 * q.quads).toLocaleString('en-US'), 'lanes shaded'),
      stat(`${laneUse(q).toFixed(1)}%`, 'of lanes on a covered pixel'),
      stat(q.empty.toLocaleString('en-US'), 'triangles covering no pixel'),
    );
    const head = h('tr', {}, h('th', {}, 'Triangles'), h('th', {}, 'Pixels each'), h('th', {}, 'Lanes shaded'), h('th', {}, 'Useful'));
    const rows = QUAD_DIVS.map((d) => {
      const s = quadModel(d);
      return h('tr', { class: d === this.div ? 'on' : '' }, h('th', {}, s.triangles.toLocaleString('en-US')), h('td', {}, String((QUAD_PX * QUAD_PX) / s.triangles)), h('td', {}, (4 * s.quads).toLocaleString('en-US')), h('td', {}, `${laneUse(s).toFixed(1)}%`));
    });
    this.table.replaceChildren(head, ...rows);
  }
}
