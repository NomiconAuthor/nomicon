/**
 * The pipeline lesson's widget: the frame stepped a vertex, triangle or pixel at a time, with the
 * stage each step is in, a top-down view of the frustum and near plane, and the counts.
 */
import { h, seg } from '../../engine/dom';
import { type PixelStep, type Step, type V3, DEFAULTS, Target, basis, emptyStats, render } from '../raster';
import { PIPE_H, PIPE_NEARS, PIPE_W, pipelineCamera, pipelineScene } from '../scenes/the-pipeline';
import { Palette, Stepper, btn, canvas, chk, ctx2d, fit, fontPx, frame, markPixel, n2, n3, onTheme, outlineTri, paintTarget, plural, size, stage, stat } from '../view';

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
    const root = frame(host, 'rd-pipeline');
    this.pal = new Palette(root);
    this.stepper = new Stepper(
      () => {
        this.stats = emptyStats();
        return render(this.draws, this.target, pipelineCamera(this.near), { ...DEFAULTS, cull: this.cull }, this.stats);
      },
      () => this.show(),
    );
    const s = this.stepper;
    // The frame and the top view side by side, as one figure: 16 : 9 columns of equal height. The
    // draw calls and counts sit beside it on wide screens, so the widget stays under one screen.
    const fig = stage(
      h('div', { class: 'rd-fig rd-two', style: '--rd-max-w: 860px; --rd-ar: 2.5' }, h('div', {}, h('div', { class: 'll-h' }, 'The frame, 64 × 40 pixels'), this.screen), h('div', {}, h('div', { class: 'll-h' }, 'From above'), this.top)),
      [h('div', { class: 'll-h' }, 'Draw calls'), this.drawList, this.counts],
      2.5,
    );
    fig.style.setProperty('--rd-side-min', '22rem');
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
        btn('Next vertex', () => s.next(['vertex'])),
        btn('Next triangle', () => s.next(['triangle'])),
        btn('Next pixel', () => s.next(['pixel'], (p) => (p as PixelStep).mask !== 0)),
        s.playBtn,
        btn('Whole frame', () => s.finish()),
        btn('Clear', () => s.reset()),
      ),
      this.stages,
      this.say,
      fig,
    );
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    fit(this.screen, () => this.show());
    fit(this.top, () => this.show());
    s.reset(true);
  }

  private show(): void {
    const s = this.stepper;
    const last = s.last;
    const ctx = ctx2d(this.screen);
    const scr = size(this.screen);
    const k = scr.w / PIPE_W;
    paintTarget(ctx, this.target, this.draws, this.pal, 'color', k);
    const accent = this.pal.css('--accent');
    if (s.lastTri && !s.done) for (const p of s.lastTri.pieces) outlineTri(ctx, p, k, accent);
    if (last?.kind === 'pixel') markPixel(ctx, last, k, this.pal.css('--ink'));
    if (last?.kind === 'vertex' && last.clip[3] > 0) {
      const x = (last.clip[0] / last.clip[3] + 1) * 0.5 * scr.w;
      const y = (1 - last.clip[1] / last.clip[3]) * 0.5 * scr.h;
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
    const ctx = ctx2d(c);
    const { w: W, h: H } = size(c);
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
    ctx.font = `${fontPx(this.top, 18, 12)}px sans-serif`;
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

