/** The queries and characters lesson's widgets. */
import { h, seg } from '../engine/dom';
import { touchScroll } from '../engine/touch';
import { box, polygon } from './collide';
import { type V, add, scale, sub, v } from './math';
import { type Scene, bin } from './scenes';
import { World } from './world';
import { PhysicsView, statLine } from './view';
import { DynamicCharacter, KinematicMover, type MoveInput } from './character';

function chk(label: string, on: boolean, change: (v: boolean) => void): HTMLElement {
  const i = h('input', { type: 'checkbox', onchange: (e: Event) => change((e.target as HTMLInputElement).checked) }) as HTMLInputElement;
  i.checked = on;
  return h('label', { class: 'll-chk' }, i, ` ${label}`);
}

// =============================================================================================
// Ray and shape casts

export class QueryViz {
  private view: PhysicsView;
  private a: V = v(-6, 7);
  private b: V = v(5.5, 0.6);
  private kind: 'ray' | 'circle' = 'ray';
  private radius = 0.35;
  private drag: 'a' | 'b' | null = null;
  private out = h('div', { class: 'll-muted' });

  constructor(host: HTMLElement) {
    const root = h('div', { class: 'll ph ph-query' });
    host.replaceChildren(root);
    const sc = this.settled();
    this.view = new PhysicsView(sc.world, { view: sc.view, label: 'A ray cast into a pile of shapes' });
    this.view.playing = false;
    this.view.draggable = false;
    this.view.onDraw = (ctx, px, k) => this.drawCast(ctx, px, k);
    const c = this.view.canvas;
    touchScroll(c, { grab: (e) => this.handleAt(this.view.toWorld(e)) !== null });
    c.addEventListener('pointerdown', (e) => {
      this.drag = this.handleAt(this.view.toWorld(e));
      if (this.drag) c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      this[this.drag] = this.view.toWorld(e);
      this.view.draw();
    });
    for (const ev of ['pointerup', 'pointercancel']) c.addEventListener(ev, () => (this.drag = null));
    root.append(
      seg<'ray' | 'circle'>('Cast', [['ray', 'Ray'], ['circle', 'Circle (a shape cast)']], this.kind, (k) => {
        this.kind = k;
        this.view.draw();
      }).el,
      h('p', { class: 'll-muted ph-note' }, 'Drag either end of the cast.'),
      c,
      this.out,
    );
    this.view.draw();
  }
  /** The bin, run headless until everything sleeps, so the pile holds still. */
  private settled(): Scene {
    const sc = bin({}, 40);
    for (let i = 0; i < 1200; i++) {
      sc.world.step(1 / 60);
      if (i > 30 && sc.world.stats.awake === 0) break;
    }
    return sc;
  }
  private handleAt(p: V): 'a' | 'b' | null {
    const d = (q: V) => Math.sqrt((p.x - q.x) ** 2 + (p.y - q.y) ** 2);
    if (d(this.a) < 0.5) return 'a';
    if (d(this.b) < 0.5) return 'b';
    return null;
  }
  private drawCast(ctx: CanvasRenderingContext2D, px: (p: V) => V, k: number): void {
    const w = this.view.world;
    const d = sub(this.b, this.a);
    const L = Math.sqrt(d.x * d.x + d.y * d.y);
    if (L < 1e-6) return;
    const dir = scale(d, 1 / L);
    const hit = this.kind === 'ray' ? w.raycast(this.a, dir, L) : w.circleCast(this.radius, this.a, dir, L);
    const col = (n: string) => this.view.col(n);
    const end = hit ? add(this.a, scale(dir, hit.t)) : this.b;
    const pa = px(this.a);
    const pe = px(end);
    const pb = px(this.b);
    ctx.lineWidth = 2;
    ctx.strokeStyle = col('--muted');
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(pe.x, pe.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = col('--accent');
    ctx.lineWidth = this.kind === 'circle' ? this.radius * 2 * k : 3;
    ctx.globalAlpha = this.kind === 'circle' ? 0.25 : 1;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pe.x, pe.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
    if (this.kind === 'circle') {
      ctx.strokeStyle = col('--accent');
      ctx.lineWidth = 2;
      for (const p of [pa, pe]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, this.radius * k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    for (const p of [pa, pb]) {
      ctx.fillStyle = col('--ink');
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    if (hit) {
      const hp = px(hit.point);
      const hn = px(add(hit.point, scale(hit.normal, 0.8)));
      ctx.strokeStyle = col('--alert');
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(hp.x, hp.y);
      ctx.lineTo(hn.x, hn.y);
      ctx.stroke();
      ctx.fillStyle = col('--alert');
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    this.out.textContent = hit
      ? `Hit a ${hit.body.shape.kind === 'circle' ? 'circle' : 'polygon'} at ${hit.t.toFixed(2)} m of ${L.toFixed(2)} m; surface normal (${hit.normal.x.toFixed(2)}, ${hit.normal.y.toFixed(2)}).`
      : `No hit along ${L.toFixed(2)} m.`;
  }
}

// =============================================================================================
// Characters

/** A level with a gentle ramp, stairs, a slope too steep to walk up, and boxes to push. */
export function level(): Scene & { start: V } {
  const w = new World({ sleeping: true });
  const g = w.createBody({ type: 'static', shape: box(11, 0.5), position: v(0, -0.5) });
  // A 25° ramp up to a ledge on the left.
  const ramp = polygon([v(-8, 0), v(-4.5, 0), v(-8, 1.63)]);
  w.createBody({ type: 'static', shape: ramp.shape, position: ramp.centroid });
  w.createBody({ type: 'static', shape: box(1.2, 0.815), position: v(-9.2, 0.815) });
  // Stairs: four steps of 0.25 m.
  for (let i = 0; i < 4; i++) w.createBody({ type: 'static', shape: box(0.3, 0.125 * (i + 1)), position: v(-1.5 + i * 0.6, 0.125 * (i + 1)) });
  w.createBody({ type: 'static', shape: box(0.8, 0.5), position: v(1.5, 0.5) });
  // A 55° wedge: too steep.
  const steep = polygon([v(6.2, 0), v(8.2, 0), v(8.2, 2.86)]);
  w.createBody({ type: 'static', shape: steep.shape, position: steep.centroid });
  w.createBody({ type: 'static', shape: box(0.3, 3), position: v(-10.7, 3) });
  w.createBody({ type: 'static', shape: box(0.3, 3), position: v(10.7, 3) });
  // Boxes to push.
  for (let i = 0; i < 3; i++) w.createBody({ shape: box(0.3, 0.3), position: v(3.8 + i * 0.05, 0.3 + i * 0.6), density: 1, tag: i + 3 });
  w.createBody({ shape: box(0.4, 0.4), position: v(-9.4, 2.5), density: 1, tag: 6 });
  return { world: w, view: [-11, -0.8, 11, 5.6], ground: g, named: {}, start: v(-2.6, 0.36) };
}

export class CharacterViz {
  private view: PhysicsView;
  private mover!: KinematicMover;
  private dyn!: DynamicCharacter;
  private who: 'mover' | 'dynamic' = 'mover';
  private input: MoveInput = { x: 0, jump: false };
  private keys = new Set<string>();
  private showCasts = true;
  private out = h('div', { class: 'll-stats' });

  constructor(host: HTMLElement) {
    const root = h('div', { class: 'll ph ph-char', tabindex: '0' });
    host.replaceChildren(root);
    const sc = level();
    this.view = new PhysicsView(sc.world, { view: sc.view, label: 'A level with two characters' });
    this.view.ground = sc.ground;
    this.place(sc.world, sc.start);
    this.view.beforeStep = (dt) => this.control(dt);
    this.view.onStep = () => this.stats();
    this.view.onDraw = (ctx, px, k) => this.drawChars(ctx, px, k);
    const hold = (label: string, on: () => void, off: () => void) => {
      const b = h('button', { type: 'button', class: 'll-btn ph-hold' }, label);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        on();
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, off);
      return b;
    };
    root.addEventListener('keydown', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', ' ', 'a', 'd', 'w'].includes(e.key)) {
        this.keys.add(e.key);
        e.preventDefault();
      }
    });
    root.addEventListener('keyup', (e) => this.keys.delete(e.key));
    root.addEventListener('blur', () => this.keys.clear());
    root.append(
      seg<'mover' | 'dynamic'>('Control', [['mover', 'Kinematic mover (orange)'], ['dynamic', 'Dynamic body (pink)']], this.who, (w) => {
        this.who = w;
        root.focus();
      }).el,
      h(
        'div',
        { class: 'll-row' },
        hold('◀', () => (this.input.x = -1), () => (this.input.x = 0)),
        hold('▶', () => (this.input.x = 1), () => (this.input.x = 0)),
        hold('Jump', () => (this.input.jump = true), () => (this.input.jump = false)),
        h('span', { class: 'll-muted' }, 'or click here and use the arrow keys and space'),
        chk('Show the mover\'s casts', true, (on) => (this.showCasts = on)),
        h('button', { type: 'button', class: 'll-btn', onclick: () => this.reset() }, 'Reset'),
      ),
      this.view.canvas,
      this.out,
    );
    this.stats();
  }
  private place(w: World, at: V): void {
    this.mover = new KinematicMover(w, at);
    this.dyn = new DynamicCharacter(w, add(at, v(-1, 0)));
  }
  private reset(): void {
    const sc = level();
    this.view.ground = sc.ground;
    this.view.setWorld(sc.world, sc.view);
    this.place(sc.world, sc.start);
  }
  private control(dt: number): void {
    const k = this.keys;
    const x = (k.has('ArrowRight') || k.has('d') ? 1 : 0) - (k.has('ArrowLeft') || k.has('a') ? 1 : 0) || this.input.x;
    const jump = k.has('ArrowUp') || k.has(' ') || k.has('w') || this.input.jump;
    const idle: MoveInput = { x: 0, jump: false };
    const mine: MoveInput = { x, jump };
    this.mover.step(this.who === 'mover' ? mine : idle, dt, this.view.world.settings.gravity);
    this.dyn.step(this.who === 'dynamic' ? mine : idle);
  }
  private drawChars(ctx: CanvasRenderingContext2D, px: (p: V) => V, k: number): void {
    const m = this.mover;
    const col = (n: string) => this.view.col(n);
    if (this.showCasts) {
      for (const c of m.casts) {
        const a = px(c.from);
        const b = px(c.hit ?? c.to);
        ctx.strokeStyle = col(c.kind === 'step' ? '--c4' : c.kind === 'snap' ? '--c7' : '--muted');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        if (c.hit && c.normal) {
          const n = px(add(c.hit, scale(c.normal, 0.5)));
          ctx.strokeStyle = col('--alert');
          ctx.beginPath();
          ctx.moveTo(b.x, b.y);
          ctx.lineTo(n.x, n.y);
          ctx.stroke();
        }
      }
    }
    const p = px(m.pos);
    ctx.fillStyle = col('--c6');
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(p.x, p.y, m.s.radius * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = col(m.grounded ? '--good' : '--bg');
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  private stats(): void {
    const m = this.mover;
    this.out.replaceChildren(...statLine([
      [m.grounded ? 'grounded' : 'in the air', 'mover'],
      [m.stepped ? 'yes' : 'no', 'stepped up this step'],
      [this.dyn.grounded ? 'grounded' : 'in the air', 'dynamic body'],
    ]));
  }
}
