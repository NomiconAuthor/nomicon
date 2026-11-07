/**
 * The rendering lessons' widgets. Each one runs the teaching rasteriser (raster.ts) on a small
 * target, drawn as big squares, and lets the reader step it a vertex, triangle or pixel at a time.
 */
import { h, seg } from '../engine/dom';
import { touchScroll } from '../engine/touch';
import { type DepthFormat, type DepthMode, type Draw, type FillRule, type PixelStep, type Step, type V3, DEFAULTS, FORMAT_LABEL, SAMPLES_4X, SUB, Target, basis, emptyStats, render } from './raster';
import {
  DEPTH_DEFAULT, DEPTH_FAR, DEPTH_H, DEPTH_NEARS, DEPTH_W, type DepthSettings, type DrawOrder, OVER_H, OVER_W, PERSP_H, PERSP_W, PIPE_H, PIPE_NEARS, PIPE_W, RAST_H, RAST_W, type RasterPreset,
  coverage, coverageMaps, depthCamera, depthOptions, depthScene, lengthText, overdrawCamera, overdrawScene, perspectiveCamera, perspectiveScene, pipelineCamera, pipelineScene, rasterPoints, rasterScene, resolution, zFight,
} from './scenes';
import { Palette, Stepper, btn, canvas, chk, markPixel, n2, n3, onTheme, outlineTri, paintTarget } from './view';

function frame(host: HTMLElement, cls: string): HTMLElement {
  const root = h('div', { class: `ll rd ${cls}` });
  host.replaceChildren(root);
  return root;
}
const stat = (v: string | number, label: string) => h('span', { class: 'll-stat' }, h('b', {}, String(v)), h('span', {}, label));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// =============================================================================================
// 1. The pipeline

const STAGES = ['Vertex shader', 'Primitive assembly and clipping', 'Rasteriser', 'Fragment shader', 'Output merger'];

export class PipelineViz {
  private near: number = PIPE_NEARS[0];
  private cull = true;
  private draws = pipelineScene();
  private target = new Target(PIPE_W, PIPE_H);
  private stats = emptyStats();
  private stepper: Stepper;
  private screen = canvas(640, 400, 'The frame being drawn, one square per pixel');
  private top = canvas(360, 400, 'The scene from above: camera, view frustum and near plane', 'rd-canvas rd-top');
  private stages = h('ol', { class: 'rd-stages' });
  private say = h('p', { class: 'rd-say' });
  private drawList = h('ol', { class: 'rd-draws' });
  private counts = h('div', { class: 'll-stats' });
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-pipe');
    this.pal = new Palette(root);
    this.stepper = new Stepper(
      () => {
        this.stats = emptyStats();
        return render(this.draws, this.target, pipelineCamera(this.near), { ...DEFAULTS, cull: this.cull }, this.stats);
      },
      () => this.show(),
    );
    const s = this.stepper;
    root.append(
      h(
        'div',
        { class: 'll-row' },
        seg<string>('Near plane', PIPE_NEARS.map((n) => [String(n), `${n} m`] as [string, string]), String(this.near), (v) => {
          this.near = Number(v);
          s.reset(true);
        }).el,
        chk('Cull back faces', true, (on) => {
          this.cull = on;
          s.reset(true);
        }),
      ),
      h(
        'div',
        { class: 'll-row' },
        btn('Next vertex', () => s.next(['vertex'])),
        btn('Next triangle', () => s.next(['triangle'])),
        btn('Next pixel', () => s.next(['pixel'], (p) => (p as PixelStep).mask !== 0)),
        s.playBtn,
        btn('Whole frame', () => s.finish()),
        btn('Clear', () => s.reset()),
      ),
      this.stages,
      this.say,
      h('div', { class: 'rd-two' }, h('div', {}, h('div', { class: 'll-h' }, 'The frame, 64 × 40 pixels'), this.screen), h('div', {}, h('div', { class: 'll-h' }, 'From above'), this.top)),
      h('div', { class: 'll-h' }, 'Draw calls'),
      this.drawList,
      this.counts,
    );
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    s.reset(true);
  }

  private show(): void {
    const s = this.stepper;
    const last = s.last;
    const ctx = this.screen.getContext('2d')!;
    const k = this.screen.width / PIPE_W;
    paintTarget(ctx, this.target, this.draws, this.pal, 'color', k);
    const accent = this.pal.css('--accent');
    if (s.lastTri && !s.done) for (const p of s.lastTri.pieces) outlineTri(ctx, p, k, accent);
    if (last?.kind === 'pixel') markPixel(ctx, last, k, this.pal.css('--ink'));
    if (last?.kind === 'vertex' && last.clip[3] > 0) {
      const x = (last.clip[0] / last.clip[3] + 1) * 0.5 * this.screen.width;
      const y = (1 - last.clip[1] / last.clip[3]) * 0.5 * this.screen.height;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    this.drawTop(last);

    // Which stage is the step in?
    let on: number[] = [];
    if (last?.kind === 'vertex') on = [0];
    else if (last?.kind === 'triangle') on = [1];
    else if (last?.kind === 'pixel') on = last.mask ? (last.shaded ? [2, 3, 4] : [2, 4]) : [2];
    this.stages.replaceChildren(...STAGES.map((n, i) => h('li', { class: on.includes(i) ? 'on' : '' }, n)));
    this.say.textContent = this.describe(last, s.done);

    const cur = last && last.kind !== 'done' ? last.draw : -1;
    this.drawList.replaceChildren(
      ...this.draws.map((d, i) =>
        h('li', { class: i === cur && !s.done ? 'on' : '' }, h('b', {}, `Draw ${i + 1}: ${d.name}. `), `${d.mesh.positions.length} vertices, ${d.mesh.indices.length} indices: ${d.mesh.indices.length / 3} triangles.`),
      ),
    );
    const st = this.stats;
    this.counts.replaceChildren(
      stat(st.vertices, 'vertices shaded'),
      stat(st.triangles, 'triangles in'),
      stat(st.backfacing, 'culled (back-facing)'),
      stat(`${st.clipped} → ${st.clippedOut}`, 'clipped → triangles out'),
      stat(st.rasterised, 'triangles rasterised'),
      stat(st.fragments, 'fragments'),
      stat(st.depthFailed, 'failed the depth test'),
      stat(st.written, 'pixels written'),
    );
  }

  private describe(s: Step | null, done: boolean): string {
    if (done) return 'Frame finished. Step through it again with the buttons above, or change the near plane.';
    if (!s) return 'Cleared: the depth buffer holds 1 (the far plane) everywhere. Press Next vertex to start the first draw call.';
    if (s.kind === 'draw') return `Draw call ${s.draw + 1}: ${this.draws[s.draw].name}.`;
    if (s.kind === 'done') return '';
    const name = this.draws[s.draw].name;
    if (s.kind === 'vertex') {
      const [x, y, z, w] = s.clip;
      const p = s.world;
      return `Vertex ${s.index} of the ${name}: world (${n2(p.x)}, ${n2(p.y)}, ${n2(p.z)}) → clip (${n2(x)}, ${n2(y)}, ${n2(z)}, ${n2(w)}). w is the distance in front of the camera: ${w < this.near ? `${n2(w)} m, nearer than the near plane, so any triangle using it gets clipped.` : `${n2(w)} m.`}`;
    }
    if (s.kind === 'triangle') {
      const t = `Triangle ${s.tri + 1} of the ${name}: `;
      if (s.fate === 'outside') return t + 'all three vertices are outside the same side of the view, so it is thrown away whole.';
      if (s.fate === 'back') return t + 'it faces away from the camera (its vertices run clockwise on screen), so it is culled.';
      if (s.fate === 'degenerate') return t + 'it has zero area on screen, so it is thrown away.';
      if (s.clipped) return t + `it crosses the near plane, so it is clipped there. The piece in front is a polygon, split into ${plural(s.pieces.length, 'triangle')} for the rasteriser.`;
      return t + 'inside the near and far planes, facing the camera: divided by w, mapped to pixels and sent to the rasteriser.';
    }
    if (s.kind === 'pixel') {
      if (!s.mask) return `Pixel (${s.x}, ${s.y}): outside the triangle.`;
      const pass = s.passMask !== 0;
      return `Pixel (${s.x}, ${s.y}) of the ${name}: covered, depth ${n3(s.depth)} against ${n3(s.stored)} stored. ${pass ? `Nearer, so it passes; the fragment shader returns brightness ${n2(s.lum)} and the pixel and its depth are written.` : 'Not nearer: it fails the depth test and is discarded before shading (early Z).'}`;
    }
    return '';
  }

  /** The scene from above: x across, z up the canvas, camera at the bottom looking up. */
  private drawTop(last: Step | null): void {
    const c = this.top;
    const ctx = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    const x0 = -7;
    const x1 = 7;
    const z0 = 9; // bottom
    const z1 = -21; // top
    const sx = W / (x1 - x0);
    const px = (p: { x: number; z: number }) => [(p.x - x0) * sx, ((p.z - z1) / (z0 - z1)) * H] as const;
    ctx.fillStyle = this.pal.css('--bg');
    ctx.fillRect(0, 0, W, H);
    const cam = pipelineCamera(this.near);
    const b = basis(cam);
    // Geometry outlines.
    const poly = (pts: V3[], col: string, fill = false) => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const [x, y] = px(p);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
      if (fill) {
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = col;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.stroke();
    };
    poly(this.draws[0].mesh.positions, this.pal.css('--c4'), true);
    poly(this.draws[1].mesh.positions.slice(16, 20), this.pal.css('--c2'), true);
    // Frustum (horizontal extent) and near plane.
    const e = cam.eye;
    const f = { x: b.fwd.x, z: b.fwd.z };
    const fl = Math.sqrt(f.x * f.x + f.z * f.z);
    const fx = f.x / fl;
    const fz = f.z / fl;
    const spread = cam.aspect / cam.focal;
    const far = 40;
    ctx.strokeStyle = this.pal.css('--muted');
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    for (const sgn of [-1, 1]) {
      const [a, bb] = px(e);
      const [c2, d] = px({ x: e.x + far * (fx + sgn * spread * b.right.x), z: e.z + far * (fz + sgn * spread * b.right.z) });
      ctx.beginPath();
      ctx.moveTo(a, bb);
      ctx.lineTo(c2, d);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const nd = this.near * fl;
    const nl = { x: e.x + nd * fx - this.near * spread * b.right.x, z: e.z + nd * fz - this.near * spread * b.right.z };
    const nr = { x: e.x + nd * fx + this.near * spread * b.right.x, z: e.z + nd * fz + this.near * spread * b.right.z };
    ctx.strokeStyle = this.pal.css('--alert');
    ctx.lineWidth = 3;
    ctx.beginPath();
    const [ax, ay] = px(nl);
    const [bx, by] = px(nr);
    ctx.moveTo(ax - 30, ay);
    ctx.lineTo(bx + 30, by);
    ctx.stroke();
    ctx.fillStyle = this.pal.css('--alert');
    ctx.font = '18px sans-serif';
    ctx.fillText('near plane', Math.max(4, Math.min(ax, bx) - 30), Math.min(ay, by) - 10);
    const [ex, ey] = px(e);
    ctx.fillStyle = this.pal.css('--ink');
    ctx.beginPath();
    ctx.arc(ex, ey, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText('camera', ex + 10, ey + 20);
    // The current vertex or triangle.
    const accent = this.pal.css('--accent');
    if (last && last.kind === 'vertex') {
      const [x, y] = px(last.world);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
    } else if (last && (last.kind === 'triangle' || last.kind === 'pixel') && !this.stepper.done) {
      const m = this.draws[last.draw].mesh;
      poly([0, 1, 2].map((i) => m.positions[m.indices[last.tri * 3 + i]]), accent);
    }
  }
}

// =============================================================================================
// 2. Rasterisation: edge functions, the fill rule, barycentrics, MSAA

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
      this.presetSeg.el,
      seg<FillRule>('Fill rule', [['top-left', 'Top-left'], ['inclusive', 'Include edges'], ['exclusive', 'Exclude edges']], this.fill, (f) => {
        this.fill = f;
        s.reset(true);
      }).el,
      seg<string>('Samples', [['1', '1 per pixel'], ['4', '4× MSAA']], '1', (v) => {
        this.samples = Number(v) as 1 | 4;
        s.reset(true);
      }).el,
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
      this.cv,
      this.read,
      this.sum,
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
    const ctx = this.cv.getContext('2d')!;
    const k = this.cv.width / RAST_W;
    paintTarget(ctx, this.target, this.draws, this.pal, 'color', k);
    // Grid, then pixel centres or sample positions.
    ctx.strokeStyle = this.pal.css('--line');
    ctx.lineWidth = 1;
    for (let x = 0; x <= RAST_W; x++) {
      ctx.beginPath();
      ctx.moveTo(x * k + 0.5, 0);
      ctx.lineTo(x * k + 0.5, this.cv.height);
      ctx.stroke();
    }
    for (let y = 0; y <= RAST_H; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * k + 0.5);
      ctx.lineTo(this.cv.width, y * k + 0.5);
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
      ctx.font = 'bold 22px sans-serif';
      ctx.fillStyle = this.pal.css('--ink');
      ctx.fillText(t ? 'B' : 'A', cx - 7, cy + 8);
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
    const row = (label: string, ...cells: string[]) => h('tr', {}, h('th', {}, label), ...cells.map((c) => h('td', {}, c)));
    this.read.replaceChildren(
      h('p', {}, h('b', {}, `Pixel (${last.x}, ${last.y}), triangle ${names[0]}: `), last.mask ? (this.samples === 4 ? `${popcount(last.mask)} of 4 samples covered.` : 'covered.') : 'not covered.', tie ? ` ${tie}` : ''),
      h(
        'table',
        { class: 'rd-tab' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'edge 0→1'), h('th', {}, 'edge 1→2'), h('th', {}, 'edge 2→0'))),
        h(
          'tbody',
          {},
          row('Edge function at the centre (px²)', ...e.map(n2)),
          row('Sign', ...e.map((v) => (v > 0 ? 'inside' : v < 0 ? 'outside' : 'on the edge'))),
          h('tr', {}, h('th', {}, 'Barycentrics (λ0, λ1, λ2)'), h('td', { colspan: '3' }, `${last.bary.map(n3).join(', ')} (they sum to 1)`)),
        ),
      ),
    );
  }
}
function popcount(m: number): number {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
}

// =============================================================================================
// 2b. Perspective-correct interpolation

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
      this.cv,
      this.read,
    );
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    s.reset(true);
  }

  private show(): void {
    const s = this.stepper;
    const ctx = this.cv.getContext('2d')!;
    const k = this.cv.width / PERSP_W;
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
      h(
        'table',
        { class: 'rd-tab' },
        h('thead', {}, h('tr', {}, h('th', {}, `Pixel (${last.x}, ${last.y})`), h('th', {}, 'weights (λ0, λ1, λ2)'), h('th', {}, 'texture u, v (squares)'))),
        h(
          'tbody',
          {},
          row('Affine: screen-space weights', last.bary.map(n3).join(', '), ua.map(n2).join(', ')),
          row('Perspective-correct: weighted by 1/w', last.pbary.map(n3).join(', '), up.map(n2).join(', ')),
          row('1/w at the corners', t.iw.map(n3).join(', '), ''),
        ),
      ),
      h('p', { class: 'll-muted' }, `Off by ${n2(Math.max(Math.abs(ua[0] - up[0]), Math.abs(ua[1] - up[1])))} squares here. The widget is drawing with the ${this.perspective ? 'perspective-correct' : 'affine'} values.`),
    );
  }
}

// =============================================================================================
// 3. Depth: z-fighting, near plane, formats, reverse-Z

export class DepthViz {
  private set: DepthSettings = { ...DEPTH_DEFAULT, near: 0.01 };
  private view: 'color' | 'depth' = 'color';
  private draws = depthScene();
  private target = new Target(DEPTH_W, DEPTH_H);
  private stepper: Stepper;
  private cv = canvas(672, 420, 'A tower, a field and a road decal seen from 50 m up');
  private chart = canvas(672, 260, 'Depth buffer resolution against distance', 'rd-canvas rd-chart');
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
      this.cv,
      this.read,
      this.sum,
      h('div', { class: 'll-h' }, 'How far apart two surfaces must be to get different depths, by distance'),
      this.chart,
      this.chartNote,
    );
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    s.reset(true);
  }

  private show(): void {
    const s = this.stepper;
    const ctx = this.cv.getContext('2d')!;
    const k = this.cv.width / DEPTH_W;
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
    const ctx = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
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
// 3b. Early Z, late Z, depth prepass

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
      this.cv,
      h('div', { class: 'll-legend' }, this.legend()),
      this.say,
      this.counts,
    );
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    s.reset(true);
  }

  private legend(): HTMLElement {
    const item = (label: string, cls: string) => h('span', {}, h('i', { class: cls }), label);
    return h('span', { class: 'rd-heat-legend' }, item('shaded once', 'h1'), item('twice', 'h2'), item('three or more times', 'h3'));
  }

  private show(): void {
    const s = this.stepper;
    const ctx = this.cv.getContext('2d')!;
    const k = this.cv.width / OVER_W;
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
