/** The physics lessons' simulation widgets, built on PhysicsView. */
import { h, seg } from '../engine/dom';
import { box } from './collide';
import { v } from './math';
import { type Scene, bin, bridge, crowd, joints as jointScene, pyramid, tower, tunnel } from './scenes';
import { type Continuous, type Settings, type SolverKind } from './world';
import { PhysicsView, statLine } from './view';

function chk(label: string, on: boolean, change: (v: boolean) => void): HTMLElement {
  const i = h('input', { type: 'checkbox', onchange: (e: Event) => change((e.target as HTMLInputElement).checked) }) as HTMLInputElement;
  i.checked = on;
  return h('label', { class: 'll-chk' }, i, ` ${label}`);
}
function btn(label: string, fn: () => void, primary = false): HTMLButtonElement {
  return h('button', { type: 'button', class: `ll-btn${primary ? ' primary' : ''}`, onclick: fn }, label) as HTMLButtonElement;
}

/** Play/Pause, Step, Reset: the row every widget has. */
function transport(view: PhysicsView, reset: () => void, extra: HTMLElement[] = []): HTMLElement {
  const play = btn('Pause', () => {
    view.playing = !view.playing;
    play.textContent = view.playing ? 'Pause' : 'Play';
  }, true);
  return h(
    'div',
    { class: 'll-row' },
    play,
    btn('Step', () => {
      view.playing = false;
      play.textContent = 'Play';
      view.stepOnce();
    }),
    btn('Reset', reset),
    ...extra,
  );
}

function frame(host: HTMLElement, cls: string): HTMLElement {
  const root = h('div', { class: `ll ph ${cls}` });
  host.replaceChildren(root);
  return root;
}

// =============================================================================================
// 1. The step

export class StepViz {
  private view: PhysicsView;
  private scene: 'pyramid' | 'bin' = 'bin';
  private phases = h('ol', { class: 'ph-phases' });
  private frameInfo = h('div', { class: 'll-muted' });

  constructor(host: HTMLElement) {
    const root = frame(host, 'ph-step');
    const sc = this.make();
    this.view = new PhysicsView(sc.world, { view: sc.view, label: 'Shapes falling into a bin' });
    this.view.ground = sc.ground;
    this.view.onStep = () => this.stats();
    root.append(
      seg<'pyramid' | 'bin'>('Scene', [['bin', 'Bin of shapes'], ['pyramid', 'Pyramid']], this.scene, (s) => {
        this.scene = s;
        this.reset();
      }).el,
      seg<string>('Physics rate', [['15', '15 Hz'], ['30', '30 Hz'], ['60', '60 Hz'], ['120', '120 Hz']], '60', (s) => (this.view.hz = Number(s))).el,
      h(
        'div',
        { class: 'll-row' },
        chk('Interpolate rendering', true, (on) => (this.view.interpolate = on)),
        chk('Contacts', false, (on) => ((this.view.overlays.contacts = on), this.view.draw())),
        chk('Bounding boxes', false, (on) => ((this.view.overlays.aabbs = on), this.view.draw())),
        seg<string>('Speed', [['1', '×1'], ['0.25', '×¼']], '1', (s) => (this.view.speed = Number(s))).el,
      ),
      transport(this.view, () => this.reset(), [btn('Hitch: one 0.2 s frame', () => this.view.hitch(0.2))]),
      this.view.canvas,
      this.frameInfo,
      h('div', { class: 'll-h' }, 'The last physics step'),
      this.phases,
    );
    this.stats();
    setInterval(() => this.frameNote(), 250);
  }

  private make(): Scene {
    return this.scene === 'bin' ? bin({}, 60) : pyramid({}, 10);
  }
  private reset(): void {
    const sc = this.make();
    this.view.ground = sc.ground;
    this.view.setWorld(sc.world, sc.view);
    this.stats();
  }
  private frameNote(): void {
    const v = this.view;
    this.frameInfo.textContent = v.playing ? `This frame ran ${v.stepsLastFrame} physics step${v.stepsLastFrame === 1 ? '' : 's'}; the picture is drawn ${Math.round(v.alpha * 100)}% of the way from the previous step to the latest.` : 'Paused.';
  }
  private stats(): void {
    const w = this.view.world;
    const s = w.stats;
    const set = w.settings;
    const li = (n: string, t: string) => h('li', {}, h('b', {}, n), ' ', t);
    this.phases.replaceChildren(
      li('Broadphase.', `${s.aabbTests} bounding-box tests found ${s.pairs} overlapping pairs (of ${s.bodies} bodies).`),
      li('Narrowphase.', `${s.contacts} pairs actually touch, with ${s.points} contact points; ${s.warmPoints} start from last step's impulses.`),
      li('Integrate velocities.', `Gravity and damping added to the ${s.awake} awake bodies (then steps 3 to 5 repeat for each of the ${set.substeps} substeps).`),
      li('Solve.', `Push on the ${s.points} contact points and ${s.joints} joints until they stop overlapping and stop approaching.`),
      li('Integrate positions.', 'Velocities move and rotate the bodies.'),
      li('Islands and sleep.', `${s.islands} islands of touching awake bodies; ${s.sleeping} bodies asleep.`),
    );
  }
}

// =============================================================================================
// 2. Broadphase and filtering

export class BroadphaseViz {
  private view: PhysicsView;
  private count = 150;
  private method: 'brute' | 'sap' = 'sap';
  private blueOrange = true;
  private orangeOrange = true;
  private out = h('div', { class: 'll-stats' });

  constructor(host: HTMLElement) {
    const root = frame(host, 'ph-broad');
    const sc = this.make();
    this.view = new PhysicsView(sc.world, { view: sc.view, label: 'Bodies bouncing in a box' });
    this.view.ground = sc.ground;
    this.view.overlays.aabbs = true;
    this.view.onStep = () => this.stats();
    root.append(
      seg<'brute' | 'sap'>('Broadphase', [['brute', 'Every pair'], ['sap', 'Sort and sweep']], this.method, (m) => {
        this.method = m;
        this.view.world.settings.broadphase = m;
      }).el,
      seg<string>('Bodies', [['50', '50'], ['150', '150'], ['400', '400']], '150', (n) => {
        this.count = Number(n);
        this.reset();
      }).el,
      h(
        'div',
        { class: 'll-row' },
        h('span', { class: 'll-muted' }, 'Collide:'),
        chk('blue with orange', true, (on) => ((this.blueOrange = on), this.applyMasks())),
        chk('orange with orange', true, (on) => ((this.orangeOrange = on), this.applyMasks())),
      ),
      h('div', { class: 'll-row' }, chk('Bounding boxes', true, (on) => (this.view.overlays.aabbs = on)), chk('Candidate pairs', false, (on) => (this.view.overlays.pairs = on))),
      transport(this.view, () => this.reset()),
      this.view.canvas,
      this.out,
    );
    this.stats();
  }
  private make(): Scene {
    const sc = crowd({ broadphase: this.method, sleeping: false }, this.count);
    return sc;
  }
  private reset(): void {
    const sc = this.make();
    this.view.ground = sc.ground;
    this.view.setWorld(sc.world, sc.view);
    this.applyMasks();
  }
  /** Layer 1 (blue) and layer 2 (orange); walls are layer 1 too but collide with everything. */
  private applyMasks(): void {
    for (const b of this.view.world.live()) {
      if (b.type === 'static') {
        b.mask = 0xffff;
        continue;
      }
      if (b.category === 1) b.mask = 1 | (this.blueOrange ? 2 : 0) | 0x8000;
      else b.mask = (this.blueOrange ? 1 : 0) | (this.orangeOrange ? 2 : 0) | 0x8000;
    }
    // Walls collide with everyone: give them their own category every mask includes.
    for (const b of this.view.world.live()) if (b.type === 'static') b.category = 0x8000;
  }
  private stats(): void {
    const s = this.view.world.stats;
    const n = s.bodies - 4;
    this.out.replaceChildren(...statLine([
      [s.aabbTests.toLocaleString('en-GB'), 'box tests'],
      [((n * (n - 1)) / 2).toLocaleString('en-GB'), 'pairs of moving bodies'],
      [s.pairs, 'overlapping boxes'],
      [s.contacts, 'touching'],
    ]));
  }
}

// =============================================================================================
// 4. Solving contacts

export class SolverViz {
  private view: PhysicsView;
  private scene: 'pyramid' | 'tower' = 'pyramid';
  private s: Partial<Settings> = { solver: 'soft', substeps: 4, iterations: 1, warmStarting: true, sleeping: true };
  private out = h('div', { class: 'll-stats' });
  private chart = h('canvas', { class: 'ph-chart', width: '960', height: '120', 'aria-label': 'Kinetic energy over time' });
  private energy: number[] = [];
  private start: Array<{ x: number; y: number }> = [];
  private iterSeg!: { el: HTMLElement; set: (v: string) => void };
  private subRow!: HTMLElement;

  constructor(host: HTMLElement) {
    const root = frame(host, 'ph-solver');
    const sc = this.make();
    this.view = new PhysicsView(sc.world, { view: sc.view, label: 'A stack of boxes' });
    this.view.ground = sc.ground;
    this.view.onStep = () => this.stats();
    this.iterSeg = seg<string>('Iterations', [['1', '1'], ['4', '4'], ['10', '10'], ['20', '20']], '1', (n) => this.set({ iterations: Number(n) }));
    this.subRow = seg<string>('Substeps', [['1', '1'], ['2', '2'], ['4', '4'], ['8', '8']], '4', (n) => this.set({ substeps: Number(n) })).el;
    root.append(
      seg<'pyramid' | 'tower'>('Scene', [['pyramid', 'Pyramid (55 boxes)'], ['tower', 'Tower (12 boxes)']], this.scene, (s) => {
        this.scene = s;
        this.reset();
      }).el,
      seg<SolverKind>('Solver', [['soft', 'Soft step'], ['baumgarte', 'Baumgarte']], 'soft', (k) => {
        this.set({ solver: k, iterations: k === 'soft' ? 1 : 10 });
        this.iterSeg.set(k === 'soft' ? '1' : '10');
        this.subRow.hidden = k !== 'soft';
      }).el,
      this.subRow,
      this.iterSeg.el,
      h('div', { class: 'll-row' }, chk('Warm starting', true, (on) => this.set({ warmStarting: on })), chk('Sleeping', true, (on) => this.set({ sleeping: on })), chk('Contacts', false, (on) => (this.view.overlays.contacts = on))),
      transport(this.view, () => this.reset()),
      this.view.canvas,
      this.out,
      h('div', { class: 'll-h' }, 'Kinetic energy, last 10 seconds'),
      this.chart,
    );
    this.reset();
  }
  private make(): Scene {
    return this.scene === 'pyramid' ? pyramid(this.s, 10) : tower(this.s, 12);
  }
  /** Settings changes restart the stack, so every run starts from the same arrangement. */
  private set(p: Partial<Settings>): void {
    Object.assign(this.s, p);
    this.reset();
  }
  private reset(): void {
    const sc = this.make();
    this.view.ground = sc.ground;
    this.view.setWorld(sc.world, sc.view);
    this.energy = [];
    this.start = sc.world.live().filter((b) => b.type === 'dynamic').map((b) => ({ ...b.xf.p }));
    this.stats();
  }
  private stats(): void {
    const w = this.view.world;
    const dyn = w.live().filter((b) => b.type === 'dynamic');
    let drift = 0;
    dyn.forEach((b, i) => {
      const s0 = this.start[i];
      if (s0) drift = Math.max(drift, Math.sqrt((b.xf.p.x - s0.x) ** 2 + (b.xf.p.y - s0.y) ** 2));
    });
    this.energy.push(w.energy());
    if (this.energy.length > 600) this.energy.shift();
    this.out.replaceChildren(...statLine([
      [`${w.time.toFixed(1)} s`, 'simulated'],
      [`${(drift * 100).toFixed(1)} cm`, 'furthest any box has moved'],
      [w.stats.sleeping ? `${w.stats.sleeping} / ${dyn.length}` : '0', 'asleep'],
      [w.stats.warmPoints, 'warm-started points'],
    ]));
    this.drawChart();
  }
  private drawChart(): void {
    const c = this.chart;
    const ctx = c.getContext('2d')!;
    const cs = getComputedStyle(c);
    const col = (n: string) => cs.getPropertyValue(n).trim() || '#888';
    ctx.fillStyle = col('--bg');
    ctx.fillRect(0, 0, c.width, c.height);
    const e = this.energy;
    if (e.length < 2) return;
    const max = Math.max(0.5, ...e);
    ctx.strokeStyle = col('--accent');
    ctx.lineWidth = 2;
    ctx.beginPath();
    e.forEach((x, i) => {
      const px = (i / 600) * c.width;
      const py = c.height - 6 - (Math.log10(1 + x * 10) / Math.log10(1 + max * 10)) * (c.height - 12);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.stroke();
    ctx.fillStyle = col('--muted');
    ctx.font = '20px sans-serif';
    ctx.fillText(`${e[e.length - 1].toFixed(3)} J now (log scale, max ${max.toFixed(2)} J)`, 10, 24);
  }
}

// =============================================================================================
// 5. Sleeping and islands; tunnelling

export class SleepViz {
  private view: PhysicsView;
  private out = h('div', { class: 'll-stats' });
  private sleeping = true;
  private dropped = 0;

  constructor(host: HTMLElement) {
    const root = frame(host, 'ph-sleep');
    const sc = bin({}, 60);
    this.view = new PhysicsView(sc.world, { view: sc.view, label: 'Shapes in a bin, coloured by island' });
    this.view.ground = sc.ground;
    this.view.overlays.islands = true;
    this.view.onStep = () => this.stats();
    root.append(
      h(
        'div',
        { class: 'll-row' },
        chk('Colour by island', true, (on) => ((this.view.overlays.islands = on), this.view.draw())),
        chk('Sleeping', true, (on) => {
          this.sleeping = on;
          this.view.world.settings.sleeping = on;
          if (!on) for (const b of this.view.world.live()) this.view.world.wake(b);
        }),
        btn('Drop a box', () => this.drop()),
      ),
      transport(this.view, () => this.reset()),
      this.view.canvas,
      this.out,
      h('p', { class: 'll-muted ph-note' }, 'Drag a shape to wake its island. Faded shapes are asleep.'),
    );
    this.stats();
  }
  private drop(): void {
    const w = this.view.world;
    w.createBody({ shape: box(0.35, 0.35), position: v(-3 + (this.dropped++ % 7), 8.5), tag: this.dropped % 6, density: 3 });
  }
  private reset(): void {
    const sc = bin({ sleeping: this.sleeping }, 60);
    this.view.ground = sc.ground;
    this.view.setWorld(sc.world, sc.view);
  }
  private stats(): void {
    const s = this.view.world.stats;
    this.out.replaceChildren(...statLine([
      [s.islands, 'awake islands'],
      [s.awake, 'awake bodies'],
      [s.sleeping, 'asleep'],
      [s.points, 'contact points'],
    ]));
  }
}

export class TunnelViz {
  private view: PhysicsView;
  private mode: Continuous = 'none';
  private speed = 120;
  private hz = 60;
  private out = h('div', { class: 'll-muted ph-result' });

  constructor(host: HTMLElement) {
    const root = frame(host, 'ph-tunnel');
    const sc = this.make();
    this.view = new PhysicsView(sc.world, { view: sc.view, label: 'A fast ball and a thin wall' });
    this.view.ground = sc.ground;
    this.view.overlays.trail = true;
    this.view.draggable = false;
    this.view.onStep = () => this.result();
    this.view.onDraw = (ctx, px, k) => this.drawSteps(ctx, px, k);
    root.append(
      seg<Continuous>('Fast bodies', [['none', 'Nothing special'], ['speculative', 'Speculative contacts'], ['sweep', 'Sweep (time of impact)']], this.mode, (m) => {
        this.mode = m;
        this.reset();
      }).el,
      seg<string>('Ball speed', [['20', '20 m/s'], ['30', '30 m/s'], ['120', '120 m/s'], ['400', '400 m/s']], '120', (s) => {
        this.speed = Number(s);
        this.reset();
      }).el,
      h('div', { class: 'll-row' }, btn('Fire again', () => this.reset(), true), seg<string>('Speed', [['1', '×1'], ['0.1', '×⅒']], '0.1', (s) => (this.view.speed = Number(s))).el),
      this.view.canvas,
      this.out,
    );
    this.view.speed = 0.1;
    this.result();
  }
  private make(): Scene {
    return tunnel({ continuous: this.mode }, this.speed);
  }
  private reset(): void {
    const sc = this.make();
    this.view.ground = sc.ground;
    this.view.setWorld(sc.world, sc.view);
    this.result();
  }
  /** Mark where the ball was at the end of each step: the gaps between marks are what tunnels. */
  private marks: Array<{ x: number; y: number }> = [];
  private drawSteps(ctx: CanvasRenderingContext2D, px: (p: { x: number; y: number }) => { x: number; y: number }, k: number): void {
    const w = this.view.world;
    const ball = w.live().find((b) => b.bullet);
    if (!ball) return;
    if (w.steps === 0) this.marks = [];
    const last = this.marks[this.marks.length - 1];
    if (!last || last.x !== ball.xf.p.x || last.y !== ball.xf.p.y) this.marks.push({ ...ball.xf.p });
    if (this.marks.length > 80) this.marks.shift();
    ctx.strokeStyle = getComputedStyle(this.view.canvas).getPropertyValue('--c2');
    ctx.lineWidth = 1.5;
    for (const m of this.marks) {
      const p = px(m);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 0.15 * k, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  private result(): void {
    const w = this.view.world;
    const ball = w.live().find((b) => b.bullet);
    if (!ball) return;
    const per = this.speed / this.hz;
    const x = ball.xf.p.x;
    const verdict = w.steps === 0 ? 'Ready.' : x > 4.2 ? 'It went straight through the wall.' : ball.v.x < 0 ? 'It hit the wall and bounced back.' : 'On its way…';
    this.out.textContent = `${verdict} At ${this.speed} m/s and 60 steps a second the ball moves ${per.toFixed(1)} m per step; the wall is 0.1 m thick and the ball 0.3 m across.`;
  }
}

// =============================================================================================
// 6. Joints

export class JointViz {
  private view: PhysicsView;
  private scene: 'joints' | 'bridge' = 'joints';
  private solver: SolverKind = 'soft';
  private out = h('div', { class: 'll-stats' });

  constructor(host: HTMLElement) {
    const root = frame(host, 'ph-joints');
    const sc = this.make();
    this.view = new PhysicsView(sc.world, { view: sc.view, label: 'Jointed bodies' });
    this.view.ground = sc.ground;
    this.view.onStep = () => this.stats();
    root.append(
      seg<'joints' | 'bridge'>('Scene', [['joints', 'One of each'], ['bridge', 'Rope bridge']], this.scene, (s) => {
        this.scene = s;
        this.reset();
      }).el,
      seg<SolverKind>('Solver', [['soft', 'Soft step, 4 substeps'], ['baumgarte', 'Baumgarte, 10 iterations']], this.solver, (s) => {
        this.solver = s;
        this.reset();
      }).el,
      h('div', { class: 'll-row' }, btn('Drop a heavy box', () => this.heavy())),
      transport(this.view, () => this.reset()),
      this.view.canvas,
      this.out,
      h('p', { class: 'll-muted ph-note' }, 'Drag anything. The heavy box is 30 to 60 times denser than everything else.'),
    );
    this.stats();
  }
  private make(): Scene {
    const s: Partial<Settings> = this.solver === 'soft' ? { solver: 'soft', substeps: 4, iterations: 1 } : { solver: 'baumgarte', iterations: 10 };
    return this.scene === 'joints' ? jointScene({ ...s, sleeping: false }) : bridge(s);
  }
  private reset(): void {
    const sc = this.make();
    this.view.ground = sc.ground;
    this.view.setWorld(sc.world, sc.view);
  }
  private heavy(): void {
    this.view.world.createBody({ shape: box(0.5, 0.5), position: v(0, 3.5), density: 60, tag: 6 });
  }
  private stats(): void {
    const w = this.view.world;
    this.out.replaceChildren(...statLine([
      [w.joints.filter((j) => j.kind !== 'mouse').length, 'joints'],
      [`${w.energy().toFixed(2)} J`, 'kinetic energy'],
      [w.stats.sleeping, 'asleep'],
    ]));
  }
}

