/**
 * Steering behaviours (Reynolds), local avoidance, and formations.
 * Everything is a point-mass "vehicle" with a maximum speed and a maximum
 * steering force; behaviours return a desired change in velocity.
 */
import { seg, fmt } from '../engine/dom';
import { h, onTheme } from './ui';
import { type V, v, add, sub, mul, len, norm, trunc, dot, rng } from './vec';
import { LEADER_LOOK, PARTY_LOOKS, drawGround, drawMember, drawStone } from '../sprites/scene';
import { AV_LIMIT, AV_SIZE, AvoidSim, type AvAgent, type AvoidMethod, type AvoidScene } from './avoid';

// ---------------------------------------------------------------------------
// Vectors and vehicles


export interface Vehicle {
  p: V;
  vel: V;
  r: number;
  maxSpeed: number;
  maxForce: number;
  wanderAngle: number;
}
const vehicle = (x: number, y: number, maxSpeed = 140, maxForce = 260): Vehicle => ({ p: v(x, y), vel: v(), r: 8, maxSpeed, maxForce, wanderAngle: 0 });

function integrate(a: Vehicle, steer: V, dt: number): void {
  a.vel = trunc(add(a.vel, mul(trunc(steer, a.maxForce), dt)), a.maxSpeed);
  a.p = add(a.p, mul(a.vel, dt));
}

function seek(a: Vehicle, t: V): V {
  return sub(mul(norm(sub(t, a.p)), a.maxSpeed), a.vel);
}
function flee(a: Vehicle, t: V, panic = 160): V {
  const d = sub(a.p, t);
  if (len(d) > panic) return v();
  return sub(mul(norm(d), a.maxSpeed), a.vel);
}
function arrive(a: Vehicle, t: V, slow = 120): V {
  const d = sub(t, a.p);
  const dist = len(d);
  if (dist < 0.5) return mul(a.vel, -1);
  const speed = a.maxSpeed * Math.min(1, dist / slow);
  return sub(mul(d, speed / dist), a.vel);
}
function predict(a: Vehicle, q: Vehicle): V {
  const T = Math.min(1.5, len(sub(q.p, a.p)) / Math.max(1, a.maxSpeed));
  return add(q.p, mul(q.vel, T));
}
function wander(a: Vehicle, rnd: () => number, dist = 60, radius = 30, jitter = 0.35): { force: V; target: V; circle: V } {
  a.wanderAngle += (rnd() * 2 - 1) * jitter;
  const fwd = len(a.vel) > 1 ? norm(a.vel) : v(1, 0);
  const circle = add(a.p, mul(fwd, dist));
  const heading = Math.atan2(fwd.y, fwd.x) + a.wanderAngle;
  const target = add(circle, v(Math.cos(heading) * radius, Math.sin(heading) * radius));
  return { force: seek(a, target), target, circle };
}
function separation(a: Vehicle, others: Vehicle[], radius: number): V {
  let f = v();
  for (const o of others) {
    if (o === a) continue;
    const d = sub(a.p, o.p);
    const l = len(d);
    if (l > 0 && l < radius) f = add(f, mul(d, 1 / (l * l)));
  }
  return len(f) > 0 ? sub(mul(norm(f), a.maxSpeed), a.vel) : v();
}

export interface Circle {
  p: V;
  r: number;
}
/** Look ahead along the velocity; steer sideways away from the first obstacle the feeler would hit. */
function avoidObstacles(a: Vehicle, obs: Circle[], lookahead = 0.8): { force: V; feeler: number; threat: Circle | null } {
  const speed = len(a.vel);
  const feeler = 30 + speed * lookahead;
  const fwd = speed > 1 ? norm(a.vel) : v(1, 0);
  const side = v(-fwd.y, fwd.x);
  let best: Circle | null = null;
  let bestAhead = Infinity;
  for (const o of obs) {
    const rel = sub(o.p, a.p);
    const ahead = dot(rel, fwd);
    const lateral = dot(rel, side);
    if (ahead < 0 || ahead > feeler + o.r) continue;
    if (Math.abs(lateral) > o.r + a.r + 4) continue;
    if (ahead < bestAhead) ((bestAhead = ahead), (best = o));
  }
  if (!best) return { force: v(), feeler, threat: null };
  const lateral = dot(sub(best.p, a.p), side);
  // Stronger the closer it is; push to whichever side the obstacle isn't.
  const strength = a.maxForce * (1 + (feeler - bestAhead) / feeler);
  return { force: mul(side, lateral > 0 ? -strength : strength), feeler, threat: best };
}

export function cols(el: Element) {
  const cs = getComputedStyle(el);
  const g = (n: string) => cs.getPropertyValue(n).trim() || '#888';
  return { bg: g('--bg'), line: g('--line'), soft: g('--line-soft'), raised: g('--raised'), accent: g('--accent'), warn: g('--warn'), good: g('--good'), alert: g('--alert'), muted: g('--muted'), ink: g('--ink'), c2: g('--c2'), c5: g('--c5'), mono: g('--f-mono') };
}

export function arrow(ctx: CanvasRenderingContext2D, from: V, d: V, colour: string, scale = 0.35, dash = false): void {
  const to = add(from, mul(d, scale));
  if (len(sub(to, from)) < 2) return;
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 2;
  ctx.setLineDash(dash ? [5, 4] : []);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
  const n = norm(sub(to, from));
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - n.x * 8 - n.y * 4, to.y - n.y * 8 + n.x * 4);
  ctx.lineTo(to.x - n.x * 8 + n.y * 4, to.y - n.y * 8 - n.x * 4);
  ctx.fill();
  ctx.lineWidth = 1;
}

export function drawVehicle(ctx: CanvasRenderingContext2D, a: Vehicle, colour: string): void {
  const f = len(a.vel) > 1 ? norm(a.vel) : v(1, 0);
  const s = v(-f.y, f.x);
  const r = a.r;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(a.p.x + f.x * r * 1.5, a.p.y + f.y * r * 1.5);
  ctx.lineTo(a.p.x - f.x * r + s.x * r, a.p.y - f.y * r + s.y * r);
  ctx.lineTo(a.p.x - f.x * r * 0.5, a.p.y - f.y * r * 0.5);
  ctx.lineTo(a.p.x - f.x * r + s.x * -r, a.p.y - f.y * r + s.y * -r);
  ctx.closePath();
  ctx.fill();
}

/** Shared animation shell: runs `step(dt)` and `draw()` while visible. */
export class Loop {
  private raf = 0;
  private visible = true;
  private last = 0;
  running = true;
  constructor(
    el: HTMLElement,
    private step: (dt: number) => void,
    private draw: () => void,
  ) {
    new IntersectionObserver((es) => {
      this.visible = es.some((e) => e.isIntersecting);
      this.start();
    }).observe(el);
    onTheme(() => this.draw());
  }
  start(): void {
    cancelAnimationFrame(this.raf);
    if (!this.visible || !this.running) return;
    this.last = performance.now();
    const f = (t: number) => {
      // Fixed 60 Hz sub-steps keep the simulation the same at any frame rate.
      const n = Math.min(6, Math.max(1, Math.round((t - this.last) / (1000 / 60))));
      this.last = t;
      for (let i = 0; i < n; i++) this.step(1 / 60);
      this.draw();
      if (this.visible && this.running) this.raf = requestAnimationFrame(f);
    };
    this.raf = requestAnimationFrame(f);
  }
}

const W = 900;
const H = 540;
/** The behaviours playground is shorter: one vehicle doesn't need the formation field's room. */
const SH = 400;
function canvas(label: string, w = W, hgt = H): HTMLCanvasElement {
  return h('canvas', { class: 'ai-steer', width: String(w), height: String(hgt), 'aria-label': label });
}
export function pointer(cnv: HTMLCanvasElement, e: PointerEvent): V {
  const r = cnv.getBoundingClientRect();
  return v(((e.clientX - r.left) / r.width) * cnv.width, ((e.clientY - r.top) / r.height) * cnv.height);
}
function wrap(a: Vehicle, w: number, hgt: number): void {
  if (a.p.x < 0) a.p.x += w;
  if (a.p.x > w) a.p.x -= w;
  if (a.p.y < 0) a.p.y += hgt;
  if (a.p.y > hgt) a.p.y -= hgt;
}
export function slider(label: string, min: number, max: number, step: number, value: number, on: (v: number) => void): HTMLElement {
  const out = h('output', {}, String(value));
  const i = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
  i.addEventListener('input', () => ((out.textContent = i.value), on(Number(i.value))));
  return h('label', { class: 'ai-slider' }, h('span', {}, label), i, out);
}

// ===========================================================================
// 1. Steering playground

type Mode = 'seek' | 'arrive' | 'flee' | 'pursue' | 'wander' | 'obstacles' | 'flock';

export class SteerLab {
  private root: HTMLElement;
  private cnv = canvas('Steering playground: move the pointer to move the target', W, SH);
  private trail: V[] = [];
  private mode: Mode = 'seek';
  private target = v(W * 0.7, SH * 0.5);
  private agents: Vehicle[] = [];
  private prey!: Vehicle;
  private obs: Circle[] = [];
  private r = rng(5);
  private predictOn = true;
  private avoidOn = true;
  private w = { sep: 1.5, ali: 1, coh: 1 };
  private maxSpeed = 140;
  private maxForce = 260;
  private extra = h('div', { class: 'll-row' });
  private info = h('p', { class: 'll-muted sp-note' });
  private last: { desired?: V; steer?: V; aux?: V; auxR?: number; circle?: V; feeler?: number; threat?: Circle | null } = {};
  private loop: Loop;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ai st' });
    host.replaceChildren(this.root);
    const m = seg<Mode>(
      'Behaviour',
      [
        ['seek', 'Seek'],
        ['arrive', 'Arrive'],
        ['flee', 'Flee'],
        ['pursue', 'Pursue & evade'],
        ['wander', 'Wander'],
        ['obstacles', 'Avoid obstacles'],
        ['flock', 'Flock'],
      ],
      this.mode,
      (x) => ((this.mode = x), this.reset()),
    );
    this.root.append(
      h('div', { class: 'll-row' }, m.el),
      h(
        'div',
        { class: 'll-row st-sliders' },
        slider('Max speed', 40, 300, 10, this.maxSpeed, (x) => ((this.maxSpeed = x), this.agents.forEach((a) => (a.maxSpeed = x)))),
        slider('Max force', 40, 800, 20, this.maxForce, (x) => ((this.maxForce = x), this.agents.forEach((a) => (a.maxForce = x)))),
      ),
      this.extra,
      this.cnv,
      this.info,
    );
    const move = (e: PointerEvent) => (this.target = pointer(this.cnv, e));
    this.cnv.addEventListener('pointermove', move);
    this.cnv.addEventListener('pointerdown', move);
    this.loop = new Loop(this.root, (dt) => this.step(dt), () => this.draw());
    this.reset();
  }

  private reset(): void {
    this.r = rng(5);
    this.trail = [];
    const mk = (x: number, y: number) => vehicle(x, y, this.maxSpeed, this.maxForce);
    this.obs = [];
    this.extra.replaceChildren();
    if (this.mode === 'flock') {
      this.agents = Array.from({ length: 70 }, () => {
        const a = mk(this.r() * W, this.r() * SH);
        a.vel = mul(norm(v(this.r() - 0.5, this.r() - 0.5)), this.maxSpeed * 0.6);
        a.r = 6;
        return a;
      });
      for (const [k, label] of [
        ['sep', 'Separation'],
        ['ali', 'Alignment'],
        ['coh', 'Cohesion'],
      ] as const)
        this.extra.append(slider(label, 0, 3, 0.1, this.w[k], (x) => (this.w[k] = x)));
    } else if (this.mode === 'obstacles') {
      this.agents = Array.from({ length: 6 }, (_, i) => mk(40, 50 + i * 60));
      for (let i = 0; i < 14; i++) this.obs.push({ p: v(220 + this.r() * 520, 40 + this.r() * (SH - 80)), r: 18 + this.r() * 26 });
      const c = h('input', { type: 'checkbox', checked: this.avoidOn });
      c.addEventListener('change', () => (this.avoidOn = c.checked));
      this.extra.append(h('label', { class: 'ai-check' }, c, 'Obstacle avoidance on'));
    } else if (this.mode === 'pursue') {
      this.agents = [mk(80, SH / 2)];
      this.prey = vehicle(W / 2, SH / 2, this.maxSpeed * 0.9, this.maxForce);
      this.prey.vel = v(60, 0);
      const c = h('input', { type: 'checkbox', checked: this.predictOn });
      c.addEventListener('change', () => (this.predictOn = c.checked));
      this.extra.append(h('label', { class: 'ai-check' }, c, 'Predict where the target will be'));
    } else this.agents = [mk(W * 0.2, SH * 0.5)];
    this.info.textContent = {
      seek: 'Move the pointer. Seek steers at full speed straight for the target, so it overshoots and circles it.',
      arrive: 'Arrive slows down inside the slowing radius (dashed ring) and stops on the target.',
      flee: 'The vehicle runs from the pointer when it comes within the panic radius, and drifts otherwise.',
      pursue: 'The red vehicle wanders and evades; the pursuer aims at where it will be (the cross), not where it is.',
      wander: 'A point on a circle ahead of the vehicle jitters a little each step; seeking it gives smooth, natural meandering.',
      obstacles: 'Vehicles seek the pointer through a field of obstacles. A feeler ahead of each one looks for the first obstacle in its path.',
      flock: 'Boids: separation, alignment and cohesion with neighbours within 50 px. Each rule alone is simple; together they flock.',
    }[this.mode];
    this.loop.start();
  }

  private step(dt: number): void {
    const t = this.target;
    if (this.agents[0] && this.mode !== 'flock') {
      this.trail.push({ ...this.agents[0].p });
      if (this.trail.length > 150) this.trail.shift();
    }
    if (this.mode === 'flock') {
      for (const a of this.agents) {
        const near = this.agents.filter((o) => o !== a && len(sub(o.p, a.p)) < 50);
        let f = v();
        if (near.length) {
          f = add(f, mul(separation(a, near, 25), this.w.sep));
          const avgV = mul(near.reduce((s, o) => add(s, o.vel), v()), 1 / near.length);
          f = add(f, mul(sub(mul(norm(avgV), a.maxSpeed), a.vel), this.w.ali));
          const avgP = mul(near.reduce((s, o) => add(s, o.p), v()), 1 / near.length);
          f = add(f, mul(seek(a, avgP), this.w.coh * 0.6));
        }
        // A small forward urge keeps them moving.
        f = add(f, mul(sub(mul(norm(len(a.vel) > 1 ? a.vel : v(1, 0)), a.maxSpeed * 0.7), a.vel), 0.3));
        integrate(a, f, dt);
        wrap(a, W, SH);
      }
      return;
    }
    const a = this.agents[0];
    if (this.mode === 'seek' || this.mode === 'arrive' || this.mode === 'flee') {
      const f = this.mode === 'seek' ? seek(a, t) : this.mode === 'arrive' ? arrive(a, t) : flee(a, t);
      this.last = { steer: trunc(f, a.maxForce), desired: add(f, a.vel) };
      if (this.mode === 'flee' && len(f) === 0) integrate(a, mul(a.vel, -0.5), dt);
      else integrate(a, f, dt);
      if (this.mode === 'flee') wrap(a, W, SH);
    } else if (this.mode === 'wander') {
      const w = wander(a, this.r);
      this.last = { steer: trunc(w.force, a.maxForce), circle: w.circle, aux: w.target };
      integrate(a, w.force, dt);
      wrap(a, W, SH);
    } else if (this.mode === 'pursue') {
      const p = this.prey;
      // Prey: wander, and evade the pursuer when it gets close.
      const ww = wander(p, this.r, 60, 30, 0.25);
      const ev = flee(p, predict(p, a), 150);
      integrate(p, add(mul(ww.force, 0.6), mul(ev, 1.2)), dt);
      wrap(p, W, SH);
      const aim = this.predictOn ? predict(a, p) : p.p;
      const f = seek(a, aim);
      this.last = { steer: trunc(f, a.maxForce), aux: aim };
      integrate(a, f, dt);
      wrap(a, W, SH);
    } else if (this.mode === 'obstacles') {
      this.agents.forEach((ag, i) => {
        let f = arrive(ag, t, 80);
        const av = this.avoidOn ? avoidObstacles(ag, this.obs) : { force: v(), feeler: 0, threat: null };
        f = add(f, av.force);
        f = add(f, mul(separation(ag, this.agents, 22), 0.8));
        if (i === 0) this.last = { steer: trunc(f, ag.maxForce), feeler: av.feeler, threat: av.threat };
        integrate(ag, f, dt);
        // Solid obstacles: push out if it got inside anyway.
        for (const o of this.obs) {
          const d = sub(ag.p, o.p);
          const l = len(d);
          if (l < o.r + ag.r) ag.p = add(o.p, mul(norm(d), o.r + ag.r));
        }
      });
    }
  }

  private draw(): void {
    const ctx = this.cnv.getContext('2d')!;
    const c = cols(this.root);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, SH);
    // A faint grid gives a sense of speed and scale.
    ctx.strokeStyle = c.soft;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (let x = 50; x < W; x += 50) (ctx.moveTo(x + 0.5, 0), ctx.lineTo(x + 0.5, SH));
    for (let y = 50; y < SH; y += 50) (ctx.moveTo(0, y + 0.5), ctx.lineTo(W, y + 0.5));
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Where the first vehicle has been.
    if (this.mode !== 'flock' && this.trail.length > 1) {
      ctx.strokeStyle = c.accent;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      this.trail.forEach((p, i) => (i && len(sub(p, this.trail[i - 1])) < 100 ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const o of this.obs) {
      ctx.fillStyle = c.raised;
      ctx.strokeStyle = c.line;
      ctx.beginPath();
      ctx.arc(o.p.x, o.p.y, o.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const t = this.target;
    if (this.mode !== 'wander' && this.mode !== 'flock' && this.mode !== 'pursue') {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(t.x - 8, t.y);
      ctx.lineTo(t.x + 8, t.y);
      ctx.moveTo(t.x, t.y - 8);
      ctx.lineTo(t.x, t.y + 8);
      ctx.stroke();
      ctx.lineWidth = 1;
      const ring = this.mode === 'arrive' ? 120 : this.mode === 'flee' ? 160 : 0;
      if (ring) {
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = c.muted;
        ctx.beginPath();
        ctx.arc(t.x, t.y, ring, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    const a = this.agents[0];
    const L = this.last;
    if (this.mode === 'wander' && L.circle && L.aux) {
      ctx.strokeStyle = c.muted;
      ctx.beginPath();
      ctx.arc(L.circle.x, L.circle.y, 30, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = c.warn;
      ctx.beginPath();
      ctx.arc(L.aux.x, L.aux.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.mode === 'pursue') {
      drawVehicle(ctx, this.prey, c.alert);
      if (L.aux) {
        ctx.strokeStyle = c.warn;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(L.aux.x - 6, L.aux.y - 6);
        ctx.lineTo(L.aux.x + 6, L.aux.y + 6);
        ctx.moveTo(L.aux.x + 6, L.aux.y - 6);
        ctx.lineTo(L.aux.x - 6, L.aux.y + 6);
        ctx.stroke();
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.prey.p.x, this.prey.p.y);
        ctx.lineTo(L.aux.x, L.aux.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (this.mode === 'obstacles' && L.feeler) {
      const f = len(a.vel) > 1 ? norm(a.vel) : v(1, 0);
      ctx.strokeStyle = L.threat ? c.alert : c.muted;
      ctx.beginPath();
      ctx.moveTo(a.p.x, a.p.y);
      ctx.lineTo(a.p.x + f.x * L.feeler, a.p.y + f.y * L.feeler);
      ctx.stroke();
      if (L.threat) {
        ctx.strokeStyle = c.alert;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(L.threat.p.x, L.threat.p.y, L.threat.r + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    for (const ag of this.agents) drawVehicle(ctx, ag, c.accent);
    if (this.mode !== 'flock') {
      arrow(ctx, a.p, a.vel, c.accent, 0.5);
      if (L.desired) arrow(ctx, a.p, L.desired, c.good, 0.5, true);
      if (L.steer) arrow(ctx, add(a.p, mul(a.vel, 0.5)), L.steer, c.warn, 0.25);
      ctx.font = `12px ${c.mono}`;
      ctx.fillStyle = c.muted;
      ctx.fillText(`speed ${fmt(len(a.vel))}   ${this.mode === 'seek' || this.mode === 'arrive' || this.mode === 'flee' ? 'green dashed: desired velocity · ' : ''}blue: velocity · yellow: steering force`, 10, SH - 10);
    }
  }
}

// ===========================================================================
// 2. Local avoidance between agents

const AV_SCALE = 0.6; // velocity-space inset: px of canvas per px/s

export class CrowdLab {
  private root: HTMLElement;
  private cnv = canvas('Agents crossing to the other side while avoiding each other', AV_SIZE, AV_SIZE);
  private method: AvoidMethod = 'orca';
  private scene: AvoidScene = 'circle';
  private count = 24;
  private sim!: AvoidSim;
  private endedAt = -1;
  private stats = h('div', { class: 'll-stats' });
  private loop: Loop;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ai st' });
    host.replaceChildren(this.root);
    const m = seg<AvoidMethod>(
      'Avoidance',
      [
        ['none', 'None'],
        ['separation', 'Separation'],
        ['social', 'Social forces'],
        ['vo', 'Velocity obstacles'],
        ['rvo', 'RVO'],
        ['orca', 'ORCA'],
      ],
      this.method,
      (x) => ((this.method = x), this.reset()),
    );
    const sc = seg<AvoidScene>(
      'Scene',
      [
        ['circle', 'Circle swap'],
        ['groups', 'Two groups head-on'],
        ['cross', 'Crossing streams'],
      ],
      this.scene,
      (x) => ((this.scene = x), this.reset()),
    );
    const n = seg<string>('Agents', ['12', '24', '48'].map((x) => [x, x] as [string, string]), String(this.count), (x) => ((this.count = Number(x)), this.reset()));
    this.root.append(
      h('div', { class: 'll-row' }, m.el),
      h('div', { class: 'll-row' }, sc.el, n.el, h('button', { type: 'button', class: 'll-btn', onclick: () => this.reset() }, 'Restart')),
      h('div', { class: 'st-crowd' }, this.cnv),
      this.stats,
      h(
        'p',
        { class: 'll-muted sp-note' },
        'The highlighted agent shows its velocity space: the circle is its top speed, the hollow dot the velocity it would like, the arrow the one it chose. For the sampling methods, the dots are the candidate velocities it tried, green for cheap and red for costly; for ORCA, each line is the edge of the half-plane of velocities one neighbour leaves it.',
      ),
    );
    this.loop = new Loop(this.root, () => this.step(), () => this.draw());
    this.reset();
  }

  private reset(): void {
    this.sim = new AvoidSim(this.method, this.scene, this.count);
    this.endedAt = -1;
    this.loop.running = true;
    this.loop.start();
  }

  private step(): void {
    if (this.sim.stats.ended) {
      if (this.endedAt < 0) this.endedAt = performance.now();
      else if (performance.now() - this.endedAt > 3000) this.reset();
      return;
    }
    this.sim.step();
  }

  private draw(): void {
    const ctx = this.cnv.getContext('2d')!;
    const c = cols(this.root);
    const S = AV_SIZE;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, S, S);
    if (this.scene === 'circle') {
      ctx.strokeStyle = c.soft;
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, 280, 0, Math.PI * 2);
      ctx.stroke();
    }
    const hues = [c.accent, c.warn, c.good, c.c2, c.c5, c.alert];
    const colour = (a: AvAgent) => (this.scene === 'circle' ? hues[a.hue % 6] : a.hue ? c.warn : c.accent);
    for (const a of this.sim.agents) {
      ctx.strokeStyle = colour(a);
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(a.goal.x, a.goal.y, 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const live = this.sim.agents.filter((a) => !a.done);
    for (const a of live) {
      let touching = false;
      for (const o of live) if (o !== a && len(sub(o.p, a.p)) < a.r + o.r - 0.5) touching = true;
      ctx.fillStyle = colour(a);
      ctx.beginPath();
      ctx.arc(a.p.x, a.p.y, a.r, 0, Math.PI * 2);
      ctx.fill();
      if (touching) {
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    const a0 = this.sim.agents[0];
    if (!a0.done) this.drawVelocitySpace(ctx, c, a0);
    const s = this.sim.stats;
    const st = (val: string, l: string) => h('div', { class: 'll-stat' }, h('b', {}, val), h('span', {}, l));
    const notThere = this.sim.agents.filter((a) => !a.done).length;
    this.stats.replaceChildren(
      st(s.allDoneAt >= 0 ? `${fmt(s.allDoneAt, 1)} s` : s.ended ? `${notThere} stuck` : `${fmt(s.time, 1)} s`, s.allDoneAt >= 0 ? 'everyone across' : s.ended ? `after ${AV_LIMIT} s` : 'running'),
      st(fmt(s.overlap, 0), 'overlap (px × s), lower is better'),
      st(this.sim.agents.some((a) => a.done) ? `×${fmt(this.sim.detour(), 2)}` : '–', 'distance walked vs straight line, for those across'),
      st(`${fmt(((s.turn / Math.max(1e-6, s.agentTime)) * 180) / Math.PI, 0)}°/s`, 'average turning (wobble)'),
    );
  }

  private drawVelocitySpace(ctx: CanvasRenderingContext2D, c: ReturnType<typeof cols>, a: AvAgent): void {
    const o = a.p;
    const at = (vel: V) => add(o, mul(vel, AV_SCALE));
    const R = 90 * AV_SCALE;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(o.x, o.y, a.r + 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = c.raised;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(o.x, o.y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.line;
    ctx.stroke();
    const dbg = this.sim.debug;
    ctx.save();
    ctx.beginPath();
    ctx.arc(o.x, o.y, R, 0, Math.PI * 2);
    ctx.clip();
    if (this.method === 'orca') {
      for (const L of dbg.lines) {
        const p = at(L.point);
        const d = L.dir;
        // Forbidden side is to the right of the direction; shade it lightly.
        const nrm = v(d.y, -d.x);
        ctx.fillStyle = c.alert;
        ctx.globalAlpha = 0.07;
        ctx.beginPath();
        ctx.moveTo(p.x - d.x * 200, p.y - d.y * 200);
        ctx.lineTo(p.x + d.x * 200, p.y + d.y * 200);
        ctx.lineTo(p.x + d.x * 200 + nrm.x * 200, p.y + d.y * 200 + nrm.y * 200);
        ctx.lineTo(p.x - d.x * 200 + nrm.x * 200, p.y - d.y * 200 + nrm.y * 200);
        ctx.fill();
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = c.alert;
        ctx.beginPath();
        ctx.moveTo(p.x - d.x * 200, p.y - d.y * 200);
        ctx.lineTo(p.x + d.x * 200, p.y + d.y * 200);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    } else if (this.method === 'vo' || this.method === 'rvo') {
      const costs = dbg.cands.map((k) => k.cost);
      const lo = Math.min(...costs);
      const hi = Math.min(lo + 150, Math.max(...costs));
      for (const k of dbg.cands) {
        const t = Math.max(0, Math.min(1, (k.cost - lo) / Math.max(1e-6, hi - lo)));
        ctx.fillStyle = t < 0.5 ? c.good : c.alert;
        ctx.globalAlpha = t < 0.5 ? 1 - t : t;
        const p = at(k.v);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    const goalDir = sub(a.goal, a.p);
    const pref = mul(norm(goalDir), Math.min(90, len(goalDir) * 2));
    const pp = at(pref);
    ctx.strokeStyle = c.ink;
    ctx.beginPath();
    ctx.arc(pp.x, pp.y, 4, 0, Math.PI * 2);
    ctx.stroke();
    arrow(ctx, o, a.vel, c.ink, AV_SCALE);
  }
}

// ===========================================================================
// 3. Formations

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const WALLS: Rect[] = [
  // A wall across the middle with a narrow corridor through it, and a doorway lower down.
  { x0: 420, y0: 0, x1: 470, y1: 230 },
  { x0: 420, y0: 270, x1: 470, y1: 420 },
  { x0: 420, y0: 470, x1: 470, y1: 540 },
  // Corridor walls extending the gap at y 230..270.
  { x0: 330, y0: 190, x1: 420, y1: 230 },
  { x0: 330, y0: 270, x1: 420, y1: 310 },
  { x0: 470, y0: 190, x1: 560, y1: 230 },
  { x0: 470, y0: 270, x1: 560, y1: 310 },
  // Pillars.
  { x0: 680, y0: 120, x1: 720, y1: 160 },
  { x0: 700, y0: 380, x1: 740, y1: 420 },
  { x0: 150, y0: 380, x1: 190, y1: 420 },
];
/** The leader's patrol: through the corridor, round the right, back through the doorway. */
const ROUTE: V[] = [v(120, 250), v(300, 250), v(600, 250), v(800, 200), v(820, 360), v(770, 455), v(620, 448), v(445, 445), v(260, 470), v(125, 452), v(80, 380)];

type FMode = 'rigid' | 'clamp' | 'collapse';
/** Speeds in px/s (20 px = 1 m): a walking leader at 2 m/s, followers a little faster to catch up. */
const LEAD_SPEED = 40;
const FOLLOW_SPEED = 64;
const TURN_RATE = 1.6;
type Shape = 'line' | 'wedge' | 'box' | 'column';

const inRect = (p: V, r: Rect, pad = 0) => p.x > r.x0 - pad && p.x < r.x1 + pad && p.y > r.y0 - pad && p.y < r.y1 + pad;
const free = (p: V, pad = 10) => p.x > pad && p.x < W - pad && p.y > pad && p.y < H - pad && !WALLS.some((r) => inRect(p, r, pad));
/** Is the straight line a-b clear of walls (sampled)? */
function clear(a: V, b: V, pad = 6): boolean {
  const d = len(sub(b, a));
  const n = Math.ceil(d / 6);
  for (let i = 1; i <= n; i++) if (!free(add(a, mul(sub(b, a), i / n)), pad)) return false;
  return true;
}

interface Follower extends Vehicle {
  slot: V; // local offset: x forward, y right
  collapsed: boolean;
  since: number; // seconds in the current collapsed/expanded state
  target: V;
  via: V | null; // breadcrumb being followed to get back into sight of the target
  viaAt: number; // its index on the trail, counted from the start of the patrol
  viaAge: number;
}

/** Pixels per metre in the formation field: 20 px is 1 m (a follower is 0.4 m across). */
export const FORMATION_PX_PER_M = 20;

export interface FormationOptions {
  mode: FMode;
  shape: Shape;
  n: number;
  wait: boolean;
}

/** The formation simulation, without any drawing, so the lesson's numbers can be checked headless. */
export class FormationSim {
  mode: FMode;
  shape: Shape;
  n: number;
  wait: boolean;
  lead!: Vehicle;
  wp = 1;
  trail: V[] = [];
  fol: Follower[] = [];
  t = 0;
  acc = { err: 0, wall: 0, samples: 0, maxLag: 0, collapsedT: 0 };
  /** How many trail points have been dropped off the front of `trail`. */
  trailBase = 0;
  /** The formation's facing: follows the leader's velocity, but turns at a limited rate. */
  facing: V = v(1, 0);

  constructor(o: FormationOptions) {
    this.mode = o.mode;
    this.shape = o.shape;
    this.n = o.n;
    this.wait = o.wait;
    this.reset();
  }

  slots(): V[] {
    const s = 34;
    const out: V[] = [];
    for (let i = 0; i < this.n; i++) {
      const k = i + 1;
      if (this.shape === 'line') out.push(v(-s * 0.8, (k % 2 ? 1 : -1) * Math.ceil(k / 2) * s));
      else if (this.shape === 'column') out.push(v(-k * s, 0));
      else if (this.shape === 'wedge') out.push(v(-Math.ceil(k / 2) * s, (k % 2 ? 1 : -1) * Math.ceil(k / 2) * s * 0.8));
      else {
        const cols = 3;
        const row = Math.floor(i / cols) + 1;
        const col = (i % cols) - 1;
        out.push(v(-row * s, col * s));
      }
    }
    return out;
  }

  reset(): void {
    this.lead = vehicle(ROUTE[0].x, ROUTE[0].y, LEAD_SPEED, 160);
    this.lead.r = 10;
    this.wp = 1;
    this.trail = [];
    this.trailBase = 0;
    this.facing = norm(sub(ROUTE[1], ROUTE[0]));
    // Start each follower on its slot, or, if that's off the map or in a wall, in a small
    // spread just behind the leader (stacked on one point, separation can't pull them apart).
    this.fol = this.slots().map((s, i) => {
      const at = free(v(ROUTE[0].x + s.x, ROUTE[0].y + s.y), 12) ? v(ROUTE[0].x + s.x, ROUTE[0].y + s.y) : v(ROUTE[0].x - 24 - (i % 4) * 18, ROUTE[0].y + (Math.floor(i / 4) - 1.5) * 18);
      return { ...vehicle(at.x, at.y, FOLLOW_SPEED, 260), slot: s, collapsed: false, since: 0, target: v(), via: null, viaAt: -1, viaAge: 0 };
    });
    this.resetStats();
  }
  resetStats(): void {
    this.t = 0;
    this.acc = { err: 0, wall: 0, samples: 0, maxLag: 0, collapsedT: 0 };
  }

  world(slot: V): V {
    const f = this.facing;
    const r = v(-f.y, f.x);
    return add(this.lead.p, add(mul(f, slot.x), mul(r, slot.y)));
  }
  private heading(): V {
    return norm(sub(ROUTE[this.wp], this.lead.p));
  }

  /** A point on the leader's trail, `back` pixels behind it. */
  private onTrail(back: number): V {
    let d = 0;
    let prev = this.lead.p;
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const seg = len(sub(prev, this.trail[i]));
      if (d + seg >= back) return add(prev, mul(sub(this.trail[i], prev), (back - d) / seg));
      d += seg;
      prev = this.trail[i];
    }
    return prev;
  }

  /** The newest point on the leader's trail that p can see. */
  private breadcrumb(p: V): number {
    for (let i = this.trail.length - 1; i >= 0; i -= 3) if (clear(p, this.trail[i], 11)) return this.trailBase + i;
    return -1;
  }

  step(dt: number): void {
    this.t += dt;
    const L = this.lead;
    // Leader: follow the route; optionally slow down when followers lag.
    const goal = ROUTE[this.wp];
    if (len(sub(goal, L.p)) < 20) this.wp = (this.wp + 1) % ROUTE.length;
    // Wait for stragglers, gently: only a follower well behind its target slows the leader,
    // and never below 40% of its speed, so one follower caught on a corner can't stall the party.
    let lag = 0;
    for (const f of this.fol) lag = Math.max(lag, len(sub(f.target, f.p)));
    L.maxSpeed = this.wait ? LEAD_SPEED * Math.max(0.4, Math.min(1, 1.5 - lag / 100)) : LEAD_SPEED;
    integrate(L, seek(L, ROUTE[this.wp]), dt);
    // The formation turns towards the leader's heading at most TURN_RATE rad/s, so slots
    // sweep round a corner instead of jumping when the leader turns or slows.
    const want = len(L.vel) > 5 ? norm(L.vel) : this.heading();
    const da = Math.atan2(this.facing.x * want.y - this.facing.y * want.x, dot(this.facing, want));
    const turn = Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, da));
    const c = Math.cos(turn), sn = Math.sin(turn);
    this.facing = v(this.facing.x * c - this.facing.y * sn, this.facing.x * sn + this.facing.y * c);
    if (!this.trail.length || len(sub(L.p, this.trail[this.trail.length - 1])) > 6) {
      this.trail.push({ ...L.p });
      if (this.trail.length > 400) (this.trail.shift(), this.trailBase++);
    }
    // Followers: pick a target per the mode, then arrive at it.
    let rank = 0;
    const order = [...this.fol].sort((a, b) => b.slot.x - a.slot.x || Math.abs(a.slot.y) - Math.abs(b.slot.y));
    for (const f of order) {
      const s = this.world(f.slot);
      const ok = free(s, 12) && clear(L.p, s);
      let target = s;
      if (this.mode === 'clamp' && !ok) {
        // Walk from the leader towards the slot and stop at the last free, visible point.
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 10; k++) {
          const m = (lo + hi) / 2;
          const p = add(L.p, mul(sub(s, L.p), m));
          if (free(p, 12) && clear(L.p, p)) lo = m;
          else hi = m;
        }
        target = add(L.p, mul(sub(s, L.p), lo));
      } else if (this.mode === 'collapse') {
        // Hysteresis: change state only after the slot has been blocked (or clear) for a moment.
        const want = !ok;
        if (want !== f.collapsed) {
          f.since += dt;
          if (f.since > (want ? 0.15 : 0.6)) ((f.collapsed = want), (f.since = 0));
        } else f.since = 0;
        if (f.collapsed) target = this.onTrail(++rank * 30);
      }
      f.target = target;
      // Out of sight of the target (behind a wall)? Rigid slots just push into the wall; the
      // other modes follow the leader's breadcrumbs until the target is visible again.
      let goTo = target;
      if (this.mode !== 'rigid' && !clear(f.p, target, f.r + 3)) {
        // Look for the newest breadcrumb in sight now and then, and walk the trail point by
        // point in between: the leader walked it, so it's always passable, even where it
        // hugs a corner too closely for a line-of-sight check to see along it.
        if (f.viaAt < this.trailBase || ++f.viaAge > 8) {
          f.viaAt = Math.max(f.viaAt, this.breadcrumb(f.p));
          f.viaAge = 0;
        }
        const k = f.viaAt - this.trailBase;
        if (k >= 0 && k < this.trail.length && len(sub(this.trail[k], f.p)) < 10 && k + 1 < this.trail.length) f.viaAt++;
        const j = f.viaAt - this.trailBase;
        f.via = j >= 0 && j < this.trail.length ? this.trail[j] : null;
        if (f.via) goTo = f.via;
      } else ((f.via = null), (f.viaAt = -1));
      let force = goTo === target ? arrive(f, target, 50) : seek(f, goTo);
      force = add(force, mul(separation(f, this.fol, 22), 0.9));
      integrate(f, force, dt);
      // Walls are solid: resolve penetration.
      for (const r of WALLS) {
        const pad = f.r;
        if (!inRect(f.p, r, pad)) continue;
        const dx0 = f.p.x - (r.x0 - pad);
        const dx1 = r.x1 + pad - f.p.x;
        const dy0 = f.p.y - (r.y0 - pad);
        const dy1 = r.y1 + pad - f.p.y;
        const m = Math.min(dx0, dx1, dy0, dy1);
        if (m === dx0) f.p.x = r.x0 - pad;
        else if (m === dx1) f.p.x = r.x1 + pad;
        else if (m === dy0) f.p.y = r.y0 - pad;
        else f.p.y = r.y1 + pad;
        this.acc.wall += dt;
      }
      f.p.x = Math.min(W - f.r, Math.max(f.r, f.p.x));
      f.p.y = Math.min(H - f.r, Math.max(f.r, f.p.y));
      this.acc.err += len(sub(s, f.p));
      this.acc.samples++;
      if (f.collapsed) this.acc.collapsedT += dt / this.fol.length;
      this.acc.maxLag = Math.max(this.acc.maxLag, len(sub(f.p, L.p)));
    }
  }


  /** Measured so far, in metres and per cent. */
  summary(): { slotDist: number; maxLag: number; wallPct: number; filePct: number } {
    const n = Math.max(1, this.acc.samples);
    const t = Math.max(this.t, 1e-3);
    return {
      slotDist: this.acc.err / n / FORMATION_PX_PER_M,
      maxLag: this.acc.maxLag / FORMATION_PX_PER_M,
      wallPct: ((this.acc.wall / t) * 100) / this.fol.length,
      filePct: (this.acc.collapsedT / t) * 100,
    };
  }

  /** Run headless for `seconds` at the widget's fixed 60 Hz step. */
  run(seconds: number): this {
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i++) this.step(1 / 60);
    return this;
  }
}

export class FormationLab {
  private root: HTMLElement;
  private cnv = canvas('Formation following a leader through a corridor');
  private sim = new FormationSim({ mode: 'collapse', shape: 'wedge', n: 8, wait: true });
  private stats = h('div', { class: 'll-stats' });
  private loop: Loop;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ai st' });
    host.replaceChildren(this.root);
    const mode = seg<FMode>(
      'When a slot is blocked',
      [
        ['rigid', 'Ignore it (rigid slots)'],
        ['clamp', 'Clamp the slot to free space'],
        ['collapse', "Fall in on the leader's path"],
      ],
      this.sim.mode,
      (x) => ((this.sim.mode = x), this.reset()),
    );
    const shape = seg<Shape>(
      'Shape',
      [
        ['wedge', 'Wedge'],
        ['line', 'Line abreast'],
        ['box', 'Box'],
        ['column', 'Column'],
      ],
      this.sim.shape,
      (x) => ((this.sim.shape = x), this.reset()),
    );
    const n = seg<string>('Followers', ['4', '8', '14'].map((x) => [x, x] as [string, string]), String(this.sim.n), (x) => ((this.sim.n = Number(x)), this.reset()));
    const wait = h('input', { type: 'checkbox', checked: this.sim.wait });
    wait.addEventListener('change', () => ((this.sim.wait = wait.checked), this.sim.resetStats()));
    this.root.append(
      h('div', { class: 'll-row' }, mode.el),
      h('div', { class: 'll-row' }, shape.el, n.el, h('label', { class: 'ai-check' }, wait, 'Leader waits for stragglers')),
      this.cnv,
      this.stats,
      h('p', { class: 'll-muted sp-note' }, 'The shield knight in front leads. Rings are slots (red when blocked by a wall or out of sight of the leader). Followers in single file get a gold ring. Dotted line: the leader\'s recent path; dashed: its patrol route, with the next waypoint circled. Lines join each follower to where it is heading.'),
    );
    this.loop = new Loop(this.root, (dt) => this.sim.step(dt), () => this.draw());
    this.reset();
  }

  private reset(): void {
    this.sim.reset();
    this.loop.start();
  }

  private draw(): void {
    const ctx = this.cnv.getContext('2d')!;
    const c = cols(this.root);
    drawGround(ctx, W, H, c);
    for (const r of WALLS) drawStone(ctx, r.x0, r.y0, r.x1, r.y1, c);
    // The leader's patrol route, faintly, with the next waypoint marked.
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = c.soft;
    ctx.beginPath();
    ROUTE.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    const nx = ROUTE[this.sim.wp];
    ctx.strokeStyle = c.warn;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(nx.x, nx.y, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = c.muted;
    ctx.beginPath();
    this.sim.trail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.setLineDash([]);
    for (const f of this.sim.fol) {
      const s = this.sim.world(f.slot);
      const ok = free(s, 12) && clear(this.sim.lead.p, s);
      ctx.strokeStyle = ok ? c.muted : c.alert;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = f.collapsed ? c.warn : c.soft;
      ctx.beginPath();
      ctx.moveTo(f.p.x, f.p.y);
      ctx.lineTo(f.target.x, f.target.y);
      ctx.stroke();
    }
    // Draw back to front so nearer sprites overlap farther ones.
    const heading = (q: Vehicle, fallback: V) => (len(q.vel) > 3 ? Math.atan2(q.vel.y, q.vel.x) : Math.atan2(fallback.y, fallback.x));
    const all = [...this.sim.fol.map((f, i) => ({ y: f.p.y, draw: () => drawMember(ctx, PARTY_LOOKS[i % PARTY_LOOKS.length], f.p.x, f.p.y, heading(f, this.sim.facing), c, { size: 24, selected: f.collapsed }) })),
      { y: this.sim.lead.p.y, draw: () => drawMember(ctx, LEADER_LOOK, this.sim.lead.p.x, this.sim.lead.p.y, heading(this.sim.lead, this.sim.facing), c, { size: 32 }) }];
    all.sort((p, q) => p.y - q.y).forEach((x) => x.draw());
    const st = (val: string, l: string) => h('div', { class: 'll-stat' }, h('b', {}, val), h('span', {}, l));
    const m = this.sim.summary();
    this.stats.replaceChildren(
      st(`${fmt(m.slotDist, 1)} m`, 'average distance from slot'),
      st(`${fmt(m.maxLag, 1)} m`, 'furthest anyone fell behind'),
      st(`${fmt(m.wallPct, 1)}%`, 'of time pressed against a wall'),
      st(`${fmt(m.filePct, 0)}%`, 'of time in single file'),
      st(`${fmt(this.sim.t, 0)} s`, 'measured over'),
    );
  }
}
