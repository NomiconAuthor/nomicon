/** The steering course widget: six agents, one path, swappable motion, following and wall sensing. */
import { seg, fmt } from '../engine/dom';
import { h } from './ui';
import { Loop, cols } from './steer';
import { drawSprite } from '../sprites/sprites';
import { LEADER_LOOK, PARTY_LOOKS, drawGround, drawMember, drawStone } from '../sprites/scene';
import { COURSES, COURSE_H, COURSE_W, CourseSim, DEFAULT_SETTINGS, type CourseSettings, type Follow, type Motion, type Sense, TICK } from './course';
import { type V, add, fromAngle, len, mul, sub } from './vec';

export class CourseLab {
  private root: HTMLElement;
  private cnv: HTMLCanvasElement;
  private s: CourseSettings = { ...DEFAULT_SETTINGS };
  private sim!: CourseSim;
  private sel = 0;
  private endedAt = -1;
  private stats = h('div', { class: 'll-stats' });
  private ctxRow: HTMLElement;
  private loop: Loop;
  /** Playback speed: the simulation runs in its own seconds, shown at this fraction of real time. */
  private pace = 0.5;
  private due = 0;

  constructor(host: HTMLElement, preset: Partial<CourseSettings> = {}) {
    Object.assign(this.s, preset);
    this.root = h('div', { class: 'll ai st' });
    host.replaceChildren(this.root);
    this.cnv = h('canvas', { class: 'ai-steer', width: String(COURSE_W), height: String(COURSE_H), 'aria-label': 'A party of six following a path through walls, led by a shield knight; click a member to inspect it' });
    const restart = () => this.reset();
    const map = seg<string>('Map', COURSES.map((c) => [c.id, c.name] as [string, string]), this.s.course, (x) => ((this.s.course = x), restart()));
    const crates = h('input', { type: 'checkbox', checked: this.s.crates });
    crates.addEventListener('change', () => ((this.s.crates = crates.checked), restart()));
    const sense = seg<Sense>(
      'Walls found by',
      [
        ['none', 'Nothing'],
        ['feeler', 'One feeler'],
        ['whiskers', 'Three whiskers'],
        ['query', 'Wall query (no rays)'],
        ['context', 'Context steering'],
      ],
      this.s.sense,
      (x) => ((this.s.sense = x), (this.ctxRow.hidden = x !== 'context'), restart()),
    );
    const follow = seg<Follow>(
      'Following',
      [
        ['waypoint', 'Next waypoint'],
        ['carrot', 'Carrot on the path'],
        ['goal', 'Straight at the goal'],
      ],
      this.s.follow,
      (x) => ((this.s.follow = x), restart()),
    );
    const motion = seg<Motion>(
      'Moves like',
      [
        ['point', 'Point mass'],
        ['spot', 'Turns on the spot'],
        ['car', 'Car'],
      ],
      this.s.motion,
      (x) => ((this.s.motion = x), restart()),
    );
    const slots = seg<string>('Rays in the ring', ['8', '12', '16', '24', '32'].map((x) => [x, x] as [string, string]), String(this.s.slots), (x) => ((this.s.slots = Number(x)), restart()));
    const hyst = h('input', { type: 'checkbox', checked: this.s.hysteresis });
    hyst.addEventListener('change', () => ((this.s.hysteresis = hyst.checked), restart()));
    this.ctxRow = h('div', { class: 'll-row' }, slots.el, h('label', { class: 'ai-check' }, hyst, 'Prefer last direction'));
    this.ctxRow.hidden = this.s.sense !== 'context';
    this.root.append(
      h('div', { class: 'll-row' }, map.el, h('label', { class: 'ai-check' }, crates, 'Moving crates'), h('button', { type: 'button', class: 'll-btn', onclick: restart }, 'Restart')),
      h('div', { class: 'll-row' }, sense.el),
      this.ctxRow,
      h('div', { class: 'll-row' }, follow.el, motion.el, seg<string>('Speed', [['0.5', 'Walk'], ['1', 'Run']], String(this.pace), (x) => (this.pace = Number(x))).el),
      this.cnv,
      this.stats,
      h(
        'p',
        { class: 'll-muted sp-note' },
        'Click a party member to inspect it (the shield knight in front, purple, is selected first). Its rays show what it noticed; for context steering, the ring shows interest (green) and danger (red) per direction, and the yellow arrow is the direction it chose. The cross is where the path follower is aiming.',
      ),
    );
    this.cnv.addEventListener('pointerdown', (e) => {
      const r = this.cnv.getBoundingClientRect();
      const p = { x: ((e.clientX - r.left) / r.width) * COURSE_W, y: ((e.clientY - r.top) / r.height) * COURSE_H };
      let best = -1;
      let bd = 30;
      for (const a of this.sim.agents) {
        const d = len(sub(a.p, p));
        if (!a.done && d < bd) ((bd = d), (best = a.id));
      }
      if (best >= 0) this.sel = best;
    });
    this.loop = new Loop(this.root, (dt) => this.advance(dt), () => this.draw());
    this.reset();
  }

  private reset(): void {
    this.sim = new CourseSim({ ...this.s });
    this.endedAt = -1;
    this.sel = 1;
    this.due = 0;
    this.loop.start();
  }

  /** Real time passes at `pace` simulated seconds per second; the sim always steps at TICK. */
  private advance(dt: number): void {
    this.due += dt * this.pace;
    while (this.due >= TICK - 1e-9) {
      this.due -= TICK;
      this.step();
    }
  }

  private step(): void {
    if (this.sim.stats.ended) {
      // Hold the result on screen for a moment, then go again.
      if (this.endedAt < 0) this.endedAt = performance.now();
      else if (performance.now() - this.endedAt > 2500) this.reset();
      return;
    }
    this.sim.step(TICK);
    const cur = this.sim.agents[this.sel];
    if (cur?.done) {
      const next = this.sim.agents.find((a) => !a.done);
      if (next) this.sel = next.id;
    }
  }

  private draw(): void {
    const ctx = this.cnv.getContext('2d')!;
    const c = cols(this.root);
    const sim = this.sim;
    drawGround(ctx, COURSE_W, COURSE_H, c);
    for (const r of sim.course.rects) drawStone(ctx, r.x0, r.y0, r.x1, r.y1, c);
    // The planner's path.
    const P = sim.course.path;
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = c.muted;
    ctx.beginPath();
    P.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c.muted;
    for (const p of P.slice(1, -1)) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const g = sim.goal;
    ctx.strokeStyle = c.good;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(g.x, g.y, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    for (const k of sim.crates) drawSprite(ctx, 'crate', k.p.x, k.p.y, k.r * 2);
    // Trails.
    ctx.strokeStyle = c.soft;
    for (const a of sim.agents) {
      if (a.done || a.trail.length < 2) continue;
      ctx.beginPath();
      a.trail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.lineTo(a.p.x, a.p.y);
      ctx.stroke();
    }
    const sel = sim.agents[this.sel];
    if (sel && !sel.done) this.drawSensing(ctx, c, sel);
    for (const a of sim.agents) {
      if (a.done) continue;
      // Agent 1 starts front and centre: the shield knight leading the party.
      const look = a.id === 1 ? LEADER_LOOK : PARTY_LOOKS[a.id % PARTY_LOOKS.length];
      drawMember(ctx, look, a.p.x, a.p.y, a.heading, c, { size: 24, selected: a.id === this.sel });
    }
    this.drawStats();
  }

  private drawSensing(ctx: CanvasRenderingContext2D, c: ReturnType<typeof cols>, a: CourseSim['agents'][number]): void {
    // Rays.
    for (const hit of a.hits) {
      const end = add(a.p, mul(hit.dir, hit.d));
      ctx.strokeStyle = hit.point ? c.alert : c.muted;
      ctx.globalAlpha = hit.point ? 0.9 : 0.45;
      ctx.setLineDash(hit.fresh ? [] : [2, 4]);
      ctx.beginPath();
      ctx.moveTo(a.p.x, a.p.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      if (hit.point) {
        ctx.fillStyle = c.alert;
        ctx.beginPath();
        ctx.arc(end.x, end.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // Context ring: interest outwards in green, danger in red, per direction.
    if (this.s.sense === 'context' && a.interest.length) {
      const N = a.interest.length;
      for (let k = 0; k < N; k++) {
        const d = fromAngle(a.heading + (k / N) * Math.PI * 2);
        const i0 = add(a.p, mul(d, 16));
        ctx.lineWidth = 3;
        ctx.strokeStyle = c.good;
        const i1 = add(a.p, mul(d, 16 + Math.min(1.3, a.interest[k]) * 26));
        ctx.beginPath();
        ctx.moveTo(i0.x, i0.y);
        ctx.lineTo(i1.x, i1.y);
        ctx.stroke();
        if (a.danger[k] > 0.01) {
          ctx.strokeStyle = c.alert;
          const d1 = add(a.p, mul(d, 16 + a.danger[k] * 26));
          ctx.beginPath();
          ctx.moveTo(i0.x, i0.y);
          ctx.lineTo(d1.x, d1.y);
          ctx.stroke();
        }
      }
      ctx.lineWidth = 1;
      if (a.chosen) this.arrow(ctx, a.p, mul(a.chosen, 52), c.warn);
    }
    // Where the path follower is aiming.
    const t: V = a.target;
    ctx.strokeStyle = c.warn;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(t.x - 5, t.y - 5);
    ctx.lineTo(t.x + 5, t.y + 5);
    ctx.moveTo(t.x + 5, t.y - 5);
    ctx.lineTo(t.x - 5, t.y + 5);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  private arrow(ctx: CanvasRenderingContext2D, from: V, d: V, colour: string): void {
    const to = add(from, d);
    const n = mul(d, 1 / Math.max(1e-6, len(d)));
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - n.x * 8 - n.y * 4, to.y - n.y * 8 + n.x * 4);
    ctx.lineTo(to.x - n.x * 8 + n.y * 4, to.y - n.y * 8 - n.x * 4);
    ctx.fill();
    ctx.lineWidth = 1;
  }

  private drawStats(): void {
    const s = this.sim.stats;
    const at = Math.max(1e-6, s.agentTime);
    const st = (val: string, l: string, cls = '') => h('div', { class: `ll-stat ${cls}` }, h('b', {}, val), h('span', {}, l));
    const n = this.sim.agents.length;
    const time = s.allThroughAt >= 0 ? `${fmt(s.allThroughAt, 1)} s` : s.ended ? `${n - s.through} stuck` : `${fmt(s.time, 1)} s`;
    this.stats.replaceChildren(
      st(time, s.allThroughAt >= 0 ? 'all six through' : s.ended ? `after ${fmt(s.time, 0)} s` : `${s.through} of ${n} through`),
      st(`${fmt((100 * s.contact) / at, 1)}%`, 'of the time touching a wall or crate'),
      st(`${fmt(((s.turn / at) * 180) / Math.PI, 0)}°/s`, 'average turning (wobble)'),
      st(fmt(s.rays / at, 0), 'rays per agent per second'),
    );
  }
}
