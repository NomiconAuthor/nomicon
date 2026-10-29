/**
 * The narrowphase lesson's widget: two shapes you can drag and turn, with three views of the
 * same question. SAT: every face normal as a separating-axis candidate. GJK and EPA: the search
 * on the Minkowski difference, step by step. Manifold: reference face, incident edge, clipping,
 * and the contact points the solver will get.
 */
import { h, seg } from '../engine/dom';
import { touchScroll } from '../engine/touch';
import { type Shape, type ManifoldInfo, box, circle, collide, gjk, minkowskiOutline, polygon, satAxes } from './collide';
import { type Transform, type V, add, dot, makeRot, rotate, scale, sub, v } from './math';

type Kind = 'box' | 'tri' | 'pent' | 'circle';
type Mode = 'sat' | 'gjk' | 'manifold';

function shapeOf(k: Kind): Shape {
  if (k === 'box') return box(1.1, 0.7);
  if (k === 'circle') return circle(0.9);
  const n = k === 'tri' ? 3 : 5;
  const pts: V[] = [];
  for (let i = 0; i < n; i++) {
    const q = makeRot((i / n) * 6.283185307179586 + 0.3);
    pts.push(v(q.c, q.s));
  }
  return polygon(pts).shape;
}

export class NarrowViz {
  private root: HTMLElement;
  private left = h('canvas', { class: 'ph-canvas', width: '640', height: '480', 'aria-label': 'Two shapes' });
  private right = h('canvas', { class: 'ph-canvas', width: '640', height: '480', 'aria-label': 'Their Minkowski difference' });
  private out = h('div', { class: 'ph-narrow-out' });
  private kinds: [Kind, Kind] = ['box', 'pent'];
  private shapes: [Shape, Shape] = [shapeOf('box'), shapeOf('pent')];
  private pos: [V, V] = [v(-1.2, -0.3), v(0.6, 0.35)];
  private ang: [number, number] = [0.15, 0.6];
  private mode: Mode = 'sat';
  private gjkStep = 1e9;
  private drag: { i: number; off: V; turn: boolean } | null = null;
  private view = { x0: -4, y0: -3, x1: 4, y1: 3 };
  private rightBtn!: HTMLElement;
  private stepRow = h('div', { class: 'll-row' });

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ph ph-narrow' });
    host.replaceChildren(this.root);
    const pick = (i: 0 | 1, label: string) =>
      seg<Kind>(label, [['box', 'Box'], ['tri', 'Triangle'], ['pent', 'Pentagon'], ['circle', 'Circle']], this.kinds[i], (k) => {
        this.kinds[i] = k;
        this.shapes[i] = shapeOf(k);
        this.redraw();
      }).el;
    this.rightBtn = h('div', { class: 'ph-right' }, h('div', { class: 'll-h' }, 'Minkowski difference B − A (the origin is where they touch)'), this.right);
    this.root.append(
      seg<Mode>('Show', [['sat', 'Separating axes'], ['gjk', 'GJK and EPA'], ['manifold', 'Contact manifold']], this.mode, (m) => {
        this.mode = m;
        this.gjkStep = 1e9;
        this.redraw();
      }).el,
      pick(0, 'Shape A'),
      pick(1, 'Shape B'),
      this.stepRow,
      h('div', { class: 'ph-two' }, h('div', {}, h('div', { class: 'll-h' }, 'Drag a shape to move it; drag near its edge to turn it'), this.left), this.rightBtn),
      this.out,
    );
    touchScroll(this.left, { grab: (e) => this.hit(this.toWorld(e)) >= 0 });
    this.left.addEventListener('pointerdown', (e) => {
      const p = this.toWorld(e);
      const i = this.hit(p);
      if (i < 0) return;
      const d = sub(p, this.pos[i]);
      const r = Math.sqrt(dot(d, d));
      const rad = this.shapes[i].kind === 'circle' ? (this.shapes[i] as { r: number }).r : (this.shapes[i] as { radius: number }).radius;
      this.drag = { i, off: d, turn: r > rad * 0.6 && this.shapes[i].kind !== 'circle' };
      this.left.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.left.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const p = this.toWorld(e);
      const i = this.drag.i;
      if (this.drag.turn) {
        const a0 = Math.atan2(this.drag.off.y, this.drag.off.x);
        const d = sub(p, this.pos[i]);
        this.ang[i] += Math.atan2(d.y, d.x) - a0;
        this.drag.off = d;
      } else this.pos[i] = sub(p, this.drag.off);
      this.redraw();
    });
    for (const ev of ['pointerup', 'pointercancel']) this.left.addEventListener(ev, () => (this.drag = null));
    new MutationObserver(() => this.redraw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.redraw();
  }

  private xf(i: number): Transform {
    return { p: this.pos[i], q: makeRot(this.ang[i]) };
  }
  private toWorld(e: PointerEvent): V {
    const r = this.left.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    return v(this.view.x0 + x * (this.view.x1 - this.view.x0), this.view.y1 - y * (this.view.y1 - this.view.y0));
  }
  private hit(p: V): number {
    for (const i of [1, 0]) {
      const s = this.shapes[i];
      const d = sub(p, this.pos[i]);
      const r = s.kind === 'circle' ? s.r : s.radius;
      if (dot(d, d) <= (r * 1.15) ** 2) return i;
    }
    return -1;
  }

  private redraw(): void {
    const [A, B] = this.shapes;
    const ta = this.xf(0);
    const tb = this.xf(1);
    const cs = getComputedStyle(this.left);
    const col = (n: string) => cs.getPropertyValue(n).trim() || '#888';
    const L = this.left.getContext('2d')!;
    const W = this.left.width;
    const H = this.left.height;
    const k = W / (this.view.x1 - this.view.x0);
    const px = (p: V) => v((p.x - this.view.x0) * k, (this.view.y1 - p.y) * k);
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.fillStyle = col('--bg');
    L.fillRect(0, 0, W, H);
    const shape = (ctx: CanvasRenderingContext2D, s: Shape, t: Transform, c: string, map = px, fill = true) => {
      ctx.beginPath();
      if (s.kind === 'circle') {
        const p = map(t.p);
        ctx.arc(p.x, p.y, s.r * k, 0, Math.PI * 2);
      } else
        s.verts.forEach((q, i) => {
          const p = map(add(rotate(t.q, q), t.p));
          if (i) ctx.lineTo(p.x, p.y);
          else ctx.moveTo(p.x, p.y);
        });
      ctx.closePath();
      if (fill) {
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = col(c);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = col(c);
      ctx.lineWidth = 2;
      ctx.stroke();
    };
    shape(L, A, ta, '--c2');
    shape(L, B, tb, '--c3');
    L.fillStyle = col('--muted');
    L.font = '18px sans-serif';
    for (const [i, t] of [ta, tb].entries()) {
      const p = px(t.p);
      L.fillText(i ? 'B' : 'A', p.x - 5, p.y + 6);
    }

    this.rightBtn.hidden = this.mode !== 'gjk';
    this.stepRow.replaceChildren();
    const outBits: Array<Node | string> = [];
    if (this.mode === 'sat') outBits.push(...this.drawSat(L, px, ta, tb, col));
    else if (this.mode === 'manifold') outBits.push(...this.drawManifold(L, px, ta, tb, col));
    else outBits.push(...this.drawGjk(ta, tb, col, k));
    this.out.replaceChildren(...outBits);
  }

  private drawSat(L: CanvasRenderingContext2D, px: (p: V) => V, ta: Transform, tb: Transform, col: (n: string) => string): Array<Node | string> {
    const [A, B] = this.shapes;
    if (A.kind !== 'poly' || B.kind !== 'poly') return [h('p', { class: 'll-muted' }, 'SAT here is for two polygons: pick polygons for both shapes. (With a circle, the extra axis is the line from its centre to the polygon\'s nearest vertex.)')];
    const axes = satAxes(A, ta, B, tb);
    const best = axes.reduce((m, a) => (a.gap > m.gap ? a : m), axes[0]);
    // Draw each axis as a line through the middle, with both shadows on it.
    const mid = scale(add(ta.p, tb.p), 0.5);
    axes.forEach((a, i) => {
      const isBest = a === best;
      const off = (i - (axes.length - 1) / 2) * 0.0;
      void off;
      const n = a.n;
      const t = v(-n.y, n.x);
      const base = add(mid, scale(t, -2.6 + (i % 2) * 0));
      void base;
      if (!isBest) return;
      const o = sub(mid, scale(n, dot(mid, n)));
      const seg2 = (lo: number, hi: number, c: string, w: number, sh: number) => {
        const p = px(add(add(o, scale(n, lo)), scale(t, sh)));
        const q = px(add(add(o, scale(n, hi)), scale(t, sh)));
        L.strokeStyle = col(c);
        L.lineWidth = w;
        L.beginPath();
        L.moveTo(p.x, p.y);
        L.lineTo(q.x, q.y);
        L.stroke();
      };
      seg2(-6, 6, '--line', 1, 2.2);
      seg2(a.a[0], a.a[1], '--c2', 6, 2.2);
      seg2(a.b[0], a.b[1], '--c3', 6, 2.35);
    });
    const sep = best.gap > 0;
    return [
      h('p', {}, sep ? h('b', { class: 'det-ok' }, 'Separated. ') : h('b', { class: 'det-bad' }, 'Overlapping. '), sep ? `Face ${best.edge + 1} of ${best.body} is a separating axis: the shadows on its normal don't overlap (gap ${best.gap.toFixed(2)} m). One axis is enough to prove they don't touch.` : `No face normal separates them. The least-overlapping axis is face ${best.edge + 1} of ${best.body}, by ${(-best.gap).toFixed(2)} m: that's the penetration depth and the contact normal.`),
      h(
        'div',
        { class: 'det-sums' },
        h('table', { class: 'det-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Axis'), h('th', {}, 'A on it'), h('th', {}, 'B on it'), h('th', {}, 'Separation'))), h('tbody', {}, ...axes.map((a) => h('tr', { class: a === best ? 'ref' : '' }, h('td', {}, `${a.body} face ${a.edge + 1}`), h('td', { class: 'mono' }, `${a.a[0].toFixed(2)} … ${a.a[1].toFixed(2)}`), h('td', { class: 'mono' }, `${a.b[0].toFixed(2)} … ${a.b[1].toFixed(2)}`), h('td', { class: `mono ${a.gap > 0 ? 'det-ok' : ''}` }, a.gap.toFixed(2)))))),
      ),
      h('p', { class: 'll-muted' }, 'The line beside the shapes is the best axis, with each shape\'s shadow (projection) on it.'),
    ];
  }

  private drawManifold(L: CanvasRenderingContext2D, px: (p: V) => V, ta: Transform, tb: Transform, col: (n: string) => string): Array<Node | string> {
    const [A, B] = this.shapes;
    const info = {} as ManifoldInfo;
    const m = collide(A, ta, B, tb, 0.3, info);
    if (!m) return [h('p', { class: 'll-muted' }, 'Not touching (and more than 0.3 m apart, the speculative margin used here). Drag them together.')];
    if (A.kind === 'poly' && B.kind === 'poly' && info.refBody) {
      const [ref, tr, inc, ti] = info.refBody === 'A' ? [A, ta, B, tb] : [B, tb, A, ta];
      const edge = (p: typeof ref, t: Transform, e: number, c: string, w: number) => {
        const a = px(add(rotate(t.q, p.verts[e]), t.p));
        const b = px(add(rotate(t.q, p.verts[(e + 1) % p.verts.length]), t.p));
        L.strokeStyle = col(c);
        L.lineWidth = w;
        L.beginPath();
        L.moveTo(a.x, a.y);
        L.lineTo(b.x, b.y);
        L.stroke();
      };
      edge(ref, tr, info.refEdge, '--good', 6);
      edge(inc, ti, info.incEdge, '--warn', 6);
    }
    for (const p of m.points) {
      const pa = px(add(rotate(ta.q, p.localA), ta.p));
      const pb = px(add(rotate(tb.q, p.localB), tb.p));
      const wa = add(rotate(ta.q, p.localA), ta.p);
      const e = px(add(wa, scale(m.normal, 0.6)));
      L.strokeStyle = col('--ink');
      L.lineWidth = 2;
      L.beginPath();
      L.moveTo(pa.x, pa.y);
      L.lineTo(e.x, e.y);
      L.stroke();
      for (const q of [pa, pb]) {
        L.fillStyle = col(p.separation > 0 ? '--muted' : '--alert');
        L.beginPath();
        L.arc(q.x, q.y, 6, 0, Math.PI * 2);
        L.fill();
      }
    }
    const polys = A.kind === 'poly' && B.kind === 'poly';
    return [
      h('p', {}, `${m.points.length} contact point${m.points.length === 1 ? '' : 's'}, normal (${m.normal.x.toFixed(2)}, ${m.normal.y.toFixed(2)}) from A to B.`, polys ? ` Reference face: ${info.refBody} face ${info.refEdge + 1} (green), the face most aligned with the separating axis. Incident edge: the most opposed edge of the other shape (orange), clipped to the reference face's sides.` : ''),
      h(
        'div',
        { class: 'det-sums' },
        h('table', { class: 'det-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Point'), h('th', {}, 'Separation'), h('th', {}, 'Feature id'))), h('tbody', {}, ...m.points.map((p, i) => h('tr', {}, h('td', {}, String(i + 1)), h('td', { class: 'mono' }, `${p.separation.toFixed(3)} m${p.separation > 0 ? ' (speculative)' : ''}`), h('td', { class: 'mono' }, `0x${p.id.toString(16)}`))))),
      ),
      h('p', { class: 'll-muted' }, 'Turn a shape a little: the points move but their feature ids stay the same, which is how the solver knows they are the same contacts as last step.'),
    ];
  }

  private drawGjk(ta: Transform, tb: Transform, col: (n: string) => string, k: number): Array<Node | string> {
    const [A, B] = this.shapes;
    const r = gjk(A, ta, B, tb);
    const total = r.steps.length + r.epa.length;
    const at = Math.min(this.gjkStep, total - 1);
    this.stepRow.append(
      h('button', { type: 'button', class: 'll-btn', onclick: () => ((this.gjkStep = Math.max(0, at - 1)), this.redraw()) }, '◀'),
      h('span', { class: 'll-muted' }, `Step ${at + 1} of ${total}`),
      h('button', { type: 'button', class: 'll-btn', onclick: () => ((this.gjkStep = Math.min(total - 1, at + 1)), this.redraw()) }, '▶'),
    );
    const R = this.right.getContext('2d')!;
    const W = this.right.width;
    const H = this.right.height;
    R.setTransform(1, 0, 0, 1, 0, 0);
    R.fillStyle = col('--bg');
    R.fillRect(0, 0, W, H);
    const outline = minkowskiOutline(A, ta, B, tb);
    // Fit the difference and the origin into view.
    let lo = v(0, 0);
    let hi = v(0, 0);
    for (const p of outline) {
      lo = v(Math.min(lo.x, p.x), Math.min(lo.y, p.y));
      hi = v(Math.max(hi.x, p.x), Math.max(hi.y, p.y));
    }
    const c = scale(add(lo, hi), 0.5);
    const span = Math.max(hi.x - lo.x, (hi.y - lo.y) * (W / H)) * 1.25 + 0.5;
    const kk = W / span;
    const px = (p: V) => v(W / 2 + (p.x - c.x) * kk, H / 2 - (p.y - c.y) * kk);
    void k;
    R.beginPath();
    outline.forEach((p, i) => {
      const q = px(p);
      if (i) R.lineTo(q.x, q.y);
      else R.moveTo(q.x, q.y);
    });
    R.closePath();
    R.globalAlpha = 0.2;
    R.fillStyle = col('--c5');
    R.fill();
    R.globalAlpha = 1;
    R.strokeStyle = col('--c5');
    R.lineWidth = 2;
    R.stroke();
    const o = px(v(0, 0));
    R.strokeStyle = col('--ink');
    R.beginPath();
    R.moveTo(o.x - 8, o.y);
    R.lineTo(o.x + 8, o.y);
    R.moveTo(o.x, o.y - 8);
    R.lineTo(o.x, o.y + 8);
    R.stroke();
    let note = '';
    const poly = (pts: V[], cstr: string, closed: boolean) => {
      R.strokeStyle = col(cstr);
      R.lineWidth = 3;
      R.beginPath();
      pts.forEach((p, i) => {
        const q = px(p);
        if (i) R.lineTo(q.x, q.y);
        else R.moveTo(q.x, q.y);
      });
      if (closed) R.closePath();
      R.stroke();
      R.fillStyle = col(cstr);
      for (const p of pts) {
        const q = px(p);
        R.beginPath();
        R.arc(q.x, q.y, 5, 0, Math.PI * 2);
        R.fill();
      }
    };
    if (at < r.steps.length) {
      const s = r.steps[at];
      poly(s.simplex, '--c1', s.simplex.length > 2);
      note = s.note;
      if (at === r.steps.length - 1 && !r.hit && r.closest) {
        const q = px(r.closest);
        R.strokeStyle = col('--good');
        R.setLineDash([6, 4]);
        R.beginPath();
        R.moveTo(o.x, o.y);
        R.lineTo(q.x, q.y);
        R.stroke();
        R.setLineDash([]);
      }
    } else {
      const e = r.epa[at - r.steps.length];
      poly(e.poly, '--c6', true);
      const a = e.poly[e.edge];
      const b = e.poly[(e.edge + 1) % e.poly.length];
      const pa = px(a);
      const pb = px(b);
      R.strokeStyle = col('--alert');
      R.lineWidth = 5;
      R.beginPath();
      R.moveTo(pa.x, pa.y);
      R.lineTo(pb.x, pb.y);
      R.stroke();
      note = e.note;
      if (at === total - 1 && r.penetration) {
        const q = px(r.penetration);
        R.strokeStyle = col('--alert');
        R.setLineDash([6, 4]);
        R.lineWidth = 2;
        R.beginPath();
        R.moveTo(o.x, o.y);
        R.lineTo(q.x, q.y);
        R.stroke();
        R.setLineDash([]);
      }
    }
    return [
      h('p', {}, h('b', {}, at < r.steps.length ? 'GJK: ' : 'EPA: '), note),
      h('p', { class: 'll-muted' }, r.hit ? `They overlap: GJK found a triangle around the origin in ${r.steps.length} steps, then EPA grew it towards the boundary to find the shortest way out.` : `They're apart: GJK needed ${r.steps.length} steps to find the closest point of the difference to the origin, and its distance is the gap between the shapes.`),
    ];
  }
}
