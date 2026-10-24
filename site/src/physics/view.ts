/**
 * The shared canvas view for the physics lessons: draws a World, runs it on a fixed timestep
 * with optional render interpolation, lets you drag bodies with a mouse joint, and pauses when
 * off screen. Lesson widgets wrap it with their own controls.
 */
import { h } from '../engine/dom';
import { touchScroll } from '../engine/touch';
import { type V, add, lerpV, nlerpRot, rotate, scale, v } from './math';
import { type Body, type Joint, type World } from './world';

export interface Overlays {
  aabbs: boolean;
  contacts: boolean;
  pairs: boolean;
  islands: boolean;
  velocity: boolean;
  trail: boolean;
}

export interface ViewOptions {
  view: [number, number, number, number];
  hz?: number;
  interpolate?: boolean;
  /** Canvas pixel width (CSS scales it to fit). */
  width?: number;
  label?: string;
}

export const NO_OVERLAYS: Overlays = { aabbs: false, contacts: false, pairs: false, islands: false, velocity: false, trail: false };

export class PhysicsView {
  canvas: HTMLCanvasElement;
  world: World;
  view: [number, number, number, number];
  hz: number;
  interpolate: boolean;
  overlays: Overlays = { ...NO_OVERLAYS };
  playing = true;
  /** Simulated seconds per real second (slow motion < 1). */
  speed = 1;
  /** Called after every physics step (the widget updates its stats). */
  onStep: (() => void) | null = null;
  /** Called before every physics step (inputs, kinematic targets). */
  beforeStep: ((dt: number) => void) | null = null;
  /** Extra drawing in world space, after the bodies. */
  onDraw: ((ctx: CanvasRenderingContext2D, px: (p: V) => V, k: number) => void) | null = null;
  /** Whether dragging bodies is allowed. */
  draggable = true;
  ground = 0;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private visible = false;
  private drag: Joint | null = null;
  private trails = new Map<number, V[]>();
  private cols: Record<string, string> = {};
  /** How many physics steps ran during the last rendered frame (0, 1 or several). */
  stepsLastFrame = 0;
  alpha = 0;

  constructor(world: World, o: ViewOptions) {
    this.world = world;
    this.view = o.view;
    this.hz = o.hz ?? 60;
    this.interpolate = o.interpolate ?? true;
    const [x0, y0, x1, y1] = o.view;
    const W = o.width ?? 960;
    this.canvas = h('canvas', { class: 'ph-canvas', width: String(W), height: String(Math.round((W * (y1 - y0)) / (x1 - x0))), 'aria-label': o.label ?? 'Physics simulation' });
    touchScroll(this.canvas, { grab: (e) => this.draggable && !!this.bodyAt(this.toWorld(e)) });
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) this.canvas.addEventListener(ev, () => this.up());
    new MutationObserver(() => {
      this.cols = {};
      this.draw();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    new IntersectionObserver((es) => {
      this.visible = es.some((e) => e.isIntersecting);
      if (this.visible && !this.raf) {
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.tick);
      }
    }).observe(this.canvas);
  }

  setWorld(w: World, view?: [number, number, number, number]): void {
    this.world = w;
    this.drag = null;
    this.trails.clear();
    this.acc = 0;
    if (view && view.join() !== this.view.join()) {
      this.view = view;
      const [x0, y0, x1, y1] = view;
      this.canvas.height = Math.round((this.canvas.width * (y1 - y0)) / (x1 - x0));
    }
    this.draw();
  }

  /** One physics step now (the Step button). */
  stepOnce(): void {
    this.physicsStep();
    this.alpha = 1;
    this.draw();
  }

  private physicsStep(): void {
    const dt = 1 / this.hz;
    this.beforeStep?.(dt);
    this.world.step(dt);
    if (this.overlays.trail) {
      for (const b of this.world.live()) {
        if (b.type !== 'dynamic') continue;
        const t = this.trails.get(b.handle) ?? [];
        t.push({ ...b.xf.p });
        if (t.length > 120) t.shift();
        this.trails.set(b.handle, t);
      }
    }
    this.onStep?.();
  }

  private tick = (t: number): void => {
    this.raf = 0;
    if (!this.visible) return;
    const real = Math.min(0.25, (t - this.last) / 1000);
    this.last = t;
    this.stepsLastFrame = 0;
    if (this.playing) {
      this.acc += real * this.speed;
      const dt = 1 / this.hz;
      // At most a few steps per frame: past that, drop time rather than spiral (see the game loops lesson).
      let n = 0;
      while (this.acc >= dt && n < 8) {
        this.physicsStep();
        this.acc -= dt;
        n++;
      }
      if (n === 8) this.acc = 0;
      this.stepsLastFrame = n;
      this.alpha = this.acc / dt;
    }
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Simulate a long frame (a hitch): the next frame has this much extra time to catch up. */
  hitch(seconds: number): void {
    this.last -= seconds * 1000;
  }

  // ----------------------------------------------------------------------------------------
  // Coordinates and input

  get scaleK(): number {
    return this.canvas.width / (this.view[2] - this.view[0]);
  }
  px = (p: V): V => v((p.x - this.view[0]) * this.scaleK, (this.view[3] - p.y) * this.scaleK);
  toWorld(e: PointerEvent | MouseEvent): V {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * this.canvas.width;
    const y = ((e.clientY - r.top) / r.height) * this.canvas.height;
    return v(this.view[0] + x / this.scaleK, this.view[3] - y / this.scaleK);
  }
  bodyAt(p: V): Body | null {
    return this.world.pointQuery(p).find((b) => b.type === 'dynamic') ?? null;
  }
  private down(e: PointerEvent): void {
    if (!this.draggable) return;
    const p = this.toWorld(e);
    const b = this.bodyAt(p);
    if (!b || !this.world.get(this.ground)) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = this.world.mouse(b.handle, p, this.ground);
    e.preventDefault();
  }
  private move(e: PointerEvent): void {
    if (!this.drag) return;
    this.drag.target = this.toWorld(e);
    const b = this.world.bodies[this.drag.b];
    if (b) this.world.wake(b);
    if (!this.playing) this.draw();
  }
  private up(): void {
    if (this.drag) this.world.removeJoint(this.drag);
    this.drag = null;
  }

  // ----------------------------------------------------------------------------------------
  // Drawing

  col(name: string): string {
    if (!this.cols[name]) this.cols[name] = getComputedStyle(this.canvas).getPropertyValue(name).trim() || '#888';
    return this.cols[name];
  }

  /** Where to draw a body: between its last two physics states when interpolating. */
  drawXf(b: Body) {
    if (!this.interpolate || b.type === 'static') return b.xf;
    return { p: lerpV(b.prev.p, b.xf.p, this.alpha), q: nlerpRot(b.prev.q, b.xf.q, this.alpha) };
  }

  draw(): void {
    const ctx = this.canvas.getContext('2d')!;
    const k = this.scaleK;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.col('--bg');
    ctx.fillRect(0, 0, W, H);
    const w = this.world;
    const o = this.overlays;
    const lw = Math.max(1, W / 700);
    // Islands get colours by root index.
    const islandCol = (b: Body) => `--c${(Math.abs(b.island) % 8) + 1}`;

    if (o.trail) {
      ctx.lineWidth = lw;
      for (const [hnd, t] of this.trails) {
        const b = w.get(hnd);
        if (!b || t.length < 2) continue;
        ctx.strokeStyle = this.col(`--c${(b.tag % 8) + 1}`);
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        t.forEach((p, i) => {
          const q = this.px(p);
          if (i) ctx.lineTo(q.x, q.y);
          else ctx.moveTo(q.x, q.y);
        });
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    for (const b of w.live()) {
      const t = this.drawXf(b);
      const stat = b.type === 'static';
      const base = stat ? '--line' : o.islands && b.island >= 0 && b.type === 'dynamic' ? islandCol(b) : `--c${(b.tag % 8) + 1}`;
      const fill = this.col(base);
      ctx.globalAlpha = stat ? 1 : b.awake ? 0.85 : 0.35;
      ctx.fillStyle = stat ? this.col('--line-soft') : fill;
      ctx.strokeStyle = stat ? this.col('--line') : fill;
      ctx.lineWidth = lw;
      ctx.beginPath();
      if (b.shape.kind === 'circle') {
        const c = this.px(t.p);
        ctx.arc(c.x, c.y, b.shape.r * k, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = this.col('--bg');
        const e = this.px(add(t.p, rotate(t.q, v(b.shape.r, 0))));
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
      } else {
        b.shape.verts.forEach((p, i) => {
          const q = this.px(add(rotate(t.q, p), t.p));
          if (i) ctx.lineTo(q.x, q.y);
          else ctx.moveTo(q.x, q.y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        if (!stat) {
          ctx.strokeStyle = this.col('--bg');
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      if (b.swept) {
        ctx.strokeStyle = this.col('--warn');
        ctx.setLineDash([4, 4]);
        const a = this.px(b.prev.p);
        const c = this.px(b.xf.p);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Joints.
    ctx.strokeStyle = this.col('--ink');
    ctx.lineWidth = lw;
    for (const j of w.joints) {
      const a = w.bodies[j.a];
      const b = w.bodies[j.b];
      if (!a || !b) continue;
      const pa = this.px(add(this.drawXf(a).p, rotate(this.drawXf(a).q, j.localA)));
      const pb = this.px(add(this.drawXf(b).p, rotate(this.drawXf(b).q, j.localB)));
      if (j.kind === 'mouse') {
        const tg = this.px(j.target);
        ctx.strokeStyle = this.col('--accent');
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(pb.x, pb.y);
        ctx.lineTo(tg.x, tg.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = this.col('--ink');
        continue;
      }
      if (j.kind === 'distance') {
        ctx.globalAlpha = 0.7;
        if (j.hertz > 0) ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = this.col('--ink');
      ctx.beginPath();
      ctx.arc(pb.x, pb.y, 2.2 * lw, 0, Math.PI * 2);
      ctx.fill();
    }

    if (o.aabbs) {
      ctx.lineWidth = 1;
      for (const b of w.live()) {
        if (b.type === 'static') continue;
        const lo = this.px(b.aabb.lo);
        const hi = this.px(b.aabb.hi);
        ctx.strokeStyle = this.col(b.awake ? '--muted' : '--line');
        ctx.strokeRect(lo.x, hi.y, hi.x - lo.x, lo.y - hi.y);
      }
    }
    if (o.pairs) {
      ctx.strokeStyle = this.col('--warn');
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = lw;
      for (const [ia, ib] of w.lastPairs) {
        const a = w.bodies[ia];
        const b = w.bodies[ib];
        if (!a || !b) continue;
        const p = this.px(a.xf.p);
        const q = this.px(b.xf.p);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (o.contacts) {
      for (const c of w.contacts.values()) {
        const a = w.bodies[c.a];
        if (!a) continue;
        for (const p of c.points) {
          const wp = add(a.xf.p, rotate(a.xf.q, p.localA));
          const q = this.px(wp);
          const len = Math.min(1.2, 0.15 + p.normalImpulse * 0.4);
          const e = this.px(add(wp, scale(c.normal, len)));
          ctx.strokeStyle = this.col(p.separation > 0.011 ? '--muted' : p.warm ? '--good' : '--alert');
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(q.x, q.y);
          ctx.lineTo(e.x, e.y);
          ctx.stroke();
          ctx.fillStyle = ctx.strokeStyle;
          ctx.beginPath();
          ctx.arc(q.x, q.y, 2.4 * lw, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    if (o.velocity) {
      ctx.strokeStyle = this.col('--accent');
      ctx.lineWidth = lw;
      for (const b of w.live()) {
        if (b.type !== 'dynamic' || !b.awake) continue;
        const p = this.px(b.xf.p);
        const q = this.px(add(b.xf.p, scale(b.v, 0.1)));
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
    }
    this.onDraw?.(ctx, this.px, k);
  }
}

/** A row of small stats under a view. */
export function statLine(items: Array<[string | number, string]>): HTMLElement[] {
  return items.map(([val, label]) => h('span', { class: 'll-stat' }, h('b', {}, String(val)), h('span', {}, label)));
}
