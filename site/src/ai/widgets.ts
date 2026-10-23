/** The interactive pieces of the AI lessons. */
import { seg } from '../engine/dom';
import { type Curve, type CurveType, curve, describeCurve, evalCurve, plotCurve } from './curves';
import {
  type Behaviour,
  type BtNode,
  type Fact,
  type FactState,
  type PlanResult,
  type Selection,
  FACTOR_INFO,
  FACTS,
  FACT_LABEL,
  GOALS,
  GOAP_ACTIONS,
  PlannerBrain,
  TreeBrain,
  UtilityBrain,
  defaultBehaviours,
  plan,
  scoreBehaviour,
  type Brain,
} from './brains';
import { type ActionId, type Factors, ACTION_COL, ACTION_NAMES, CHARGES, RESERVE_MAX, TICK_HZ, World } from './world';
import { History, Runner, type Speed, whenSprites, actionChip, arenaCanvas, chartCanvas, drawArena, drawScores, drawStrip, h, legend, onTheme, stat, statsRow, stripCanvas } from './ui';
import { touchScroll } from '../engine/touch';

const fx = (n: number, d = 2) => (Math.round(n * 10 ** d) / 10 ** d).toFixed(d);

function slider(label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void, show: (v: number) => string = (v) => String(v)): { el: HTMLElement; set: (v: number) => void } {
  const out = h('output', {}, show(value));
  const inp = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
  inp.addEventListener('input', () => {
    const v = Number(inp.value);
    out.textContent = show(v);
    onInput(v);
  });
  return {
    el: h('label', { class: 'ai-slider' }, h('span', {}, label), inp, out),
    set: (v: number) => {
      inp.value = String(v);
      out.textContent = show(v);
    },
  };
}

function plotCols(el: Element) {
  const cs = getComputedStyle(el);
  const g = (n: string) => cs.getPropertyValue(n).trim() || '#888';
  return { bg: g('--bg'), grid: g('--line-soft'), line: g('--accent'), dot: g('--warn') };
}

// ===========================================================================
// Curve editor

const CURVE_PRESETS: Array<[string, Curve]> = [
  ['Linear', curve('linear')],
  ['Urgent when low (inverted square)', curve('poly', { k: 2, inv: true })],
  ['Matters only when low (inverted cube)', curve('poly', { k: 3, inv: true })],
  ['Quickly good enough (square root)', curve('poly', { k: 0.5 })],
  ['Threshold, soft (logistic)', curve('logistic', { k: 12, c: 0.5 })],
  ['Threshold, hard (step)', curve('step', { c: 0.5 })],
  ['Never fully zero (floor 0.3)', curve('linear', { inv: true, lo: 0.3 })],
];

export class CurveEditor {
  el: HTMLElement;
  private cnv: HTMLCanvasElement;
  private desc: HTMLElement;
  private out: HTMLElement;
  private x = 0.35;
  private controls!: HTMLElement;
  private title: HTMLElement;

  constructor(
    public cv: Curve,
    private onChange: () => void = () => {},
    private xLabel = 'input',
  ) {
    this.cnv = h('canvas', { class: 'ai-curve', width: '520', height: '280', 'aria-label': 'Response curve' });
    this.desc = h('code', { class: 'll-code' });
    this.out = h('div', { class: 'ai-curve-out' });
    this.title = h('div', { class: 'll-h' });
    this.controls = h('div', { class: 'ai-curve-ctl' });
    this.el = h('div', { class: 'ai-curve-ed' }, this.title, h('div', { class: 'ai-curve-grid' }, h('div', {}, this.cnv, this.out), this.controls), this.desc);
    touchScroll(this.cnv, { defer: true });
    this.cnv.addEventListener('pointerdown', (e) => this.pick(e));
    this.cnv.addEventListener('pointermove', (e) => e.buttons && this.pick(e));
    onTheme(() => this.draw());
    this.build();
  }

  edit(cv: Curve, title: string, xLabel: string): void {
    this.cv = cv;
    this.xLabel = xLabel;
    this.title.textContent = title;
    this.build();
  }

  private pick(e: PointerEvent): void {
    const r = this.cnv.getBoundingClientRect();
    const pad = 8 * (r.width / this.cnv.width);
    this.x = Math.min(1, Math.max(0, (e.clientX - r.left - pad) / (r.width - 2 * pad)));
    this.draw();
  }

  private build(): void {
    const cv = this.cv;
    const changed = () => {
      this.draw();
      this.onChange();
    };
    const type = seg<CurveType>(
      'Shape',
      [
        ['linear', 'Linear'],
        ['poly', 'Power'],
        ['logistic', 'Logistic'],
        ['step', 'Step'],
      ],
      cv.type,
      (v) => {
        cv.type = v;
        if (v === 'poly' && (cv.k > 6 || cv.k < 0.1)) cv.k = 2;
        if (v === 'logistic' && cv.k < 2) cv.k = 10;
        this.build();
        changed();
      },
    );
    const kids: HTMLElement[] = [type.el];
    if (cv.type === 'poly') kids.push(slider('Exponent', 0.2, 5, 0.1, cv.k, (v) => ((cv.k = v), changed()), (v) => v.toFixed(1)).el);
    if (cv.type === 'logistic') kids.push(slider('Steepness', 2, 30, 0.5, cv.k, (v) => ((cv.k = v), changed()), (v) => v.toFixed(1)).el);
    if (cv.type === 'logistic' || cv.type === 'step') kids.push(slider(cv.type === 'step' ? 'Threshold' : 'Midpoint', 0, 1, 0.01, cv.c, (v) => ((cv.c = v), changed()), (v) => v.toFixed(2)).el);
    kids.push(slider('Output min', 0, 1, 0.01, cv.lo, (v) => ((cv.lo = v), changed()), (v) => v.toFixed(2)).el);
    kids.push(slider('Output max', 0, 1, 0.01, cv.hi, (v) => ((cv.hi = v), changed()), (v) => v.toFixed(2)).el);
    const inv = h('input', { type: 'checkbox', checked: cv.inv });
    inv.addEventListener('change', () => {
      cv.inv = inv.checked;
      changed();
    });
    kids.push(h('label', { class: 'ai-check' }, inv, 'Invert (high input → low score)'));
    const preset = h('select', { class: 'll-btn', 'aria-label': 'Preset curves' }, h('option', { value: '' }, 'Presets…'), ...CURVE_PRESETS.map(([n], i) => h('option', { value: String(i) }, n)));
    preset.addEventListener('change', () => {
      const p = CURVE_PRESETS[Number(preset.value)];
      if (!p) return;
      Object.assign(cv, structuredClone(p[1]));
      this.build();
      changed();
    });
    kids.push(preset);
    this.controls.replaceChildren(...kids);
    this.draw();
  }

  draw(): void {
    // Theme colours can only be read once the canvas is in the document.
    if (!this.cnv.isConnected) {
      requestAnimationFrame(() => this.cnv.isConnected && this.draw());
      return;
    }
    plotCurve(this.cnv, this.cv, plotCols(this.cnv), this.x, 8);
    this.desc.textContent = `score = ${describeCurve(this.cv)}`;
    this.out.textContent = `${this.xLabel} ${fx(this.x)} → score ${fx(evalCurve(this.cv, this.x))}  (drag on the plot)`;
  }
}

export class CurveWidget {
  constructor(host: HTMLElement) {
    const root = h('div', { class: 'll ai' });
    host.replaceChildren(root);
    const ed = new CurveEditor(curve('poly', { k: 2, inv: true }), undefined, 'normalised input');
    ed.edit(ed.cv, 'Response curve: normalised input in, score out', 'input');
    root.append(ed.el);
  }
}

// ===========================================================================
// Decision inspector

type Scenario = [string, Partial<Factors>];
const SCENARIOS: Scenario[] = [
  ['Calm, fully stocked', { health: 100, charges: 6, reserve: 24, potions: 1, potionAvailable: 1, enemies: 0, enemyDist: 99, damageTaken: 0, inCover: 0, crystalDist: 15, potionDist: 15 }],
  ['Enemy closing in', { health: 100, charges: 6, reserve: 18, potions: 1, potionAvailable: 1, enemies: 2, enemyDist: 14, damageTaken: 0, inCover: 0, crystalDist: 15, potionDist: 15 }],
  ['Under attack in the open', { health: 70, charges: 4, reserve: 18, potions: 1, potionAvailable: 1, enemies: 2, enemyDist: 8, damageTaken: 18, inCover: 0, crystalDist: 15, potionDist: 15 }],
  ['Staff empty, in cover', { health: 70, charges: 0, reserve: 18, potions: 1, potionAvailable: 0, enemies: 2, enemyDist: 8, damageTaken: 9, inCover: 1, crystalDist: 15, potionDist: 15 }],
  ['Badly hurt, no potion', { health: 25, charges: 4, reserve: 12, potions: 0, potionAvailable: 1, enemies: 1, enemyDist: 9, damageTaken: 0, inCover: 1, crystalDist: 20, potionDist: 12 }],
  ['Last charges, no spare', { health: 80, charges: 1, reserve: 0, potions: 0, potionAvailable: 0, enemies: 1, enemyDist: 10, damageTaken: 0, inCover: 1, crystalDist: 10, potionDist: 20 }],
];
const SLIDERS: Array<keyof Factors> = ['health', 'charges', 'reserve', 'potions', 'potionAvailable', 'enemies', 'enemyDist', 'damageTaken', 'inCover', 'crystalDist', 'potionDist'];

export class Inspector {
  private root: HTMLElement;
  private f: Factors;
  private bs: Behaviour[] = defaultBehaviours();
  private compensate = true;
  private cards: HTMLElement;
  private sliders = new Map<keyof Factors, (v: number) => void>();
  private editor: CurveEditor;
  private sel: { b: number; c: number } | null = null;
  private hint: HTMLElement;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ai ai-insp' });
    host.replaceChildren(this.root);
    this.f = this.factors(SCENARIOS[2][1]);
    this.cards = h('div', { class: 'ai-cards' });
    this.editor = new CurveEditor(curve('linear'), () => this.render());
    this.editor.el.hidden = true;
    this.hint = h('p', { class: 'll-muted' }, 'Click any small curve to edit it. Every behaviour re-scores as you drag a factor or change a curve.');
    const sliders = h(
      'div',
      { class: 'ai-factors' },
      h('div', { class: 'll-h' }, 'Factors (what the agent knows)'),
      ...SLIDERS.map((k) => {
        const info = FACTOR_INFO[k];
        const s = slider(info.label, info.min, info.max, info.step, this.f[k], (v) => {
          this.f[k] = v;
          this.derive();
          this.render();
        }, (v) => (info.max === 1 && info.step === 1 ? (v ? 'yes' : 'no') : `${v}${info.unit ?? ''}`));
        this.sliders.set(k, s.set);
        return s.el;
      }),
    );
    const sc = seg<string>(
      'Situation',
      SCENARIOS.map(([n], i) => [String(i), n] as [string, string]),
      '2',
      (v) => {
        this.f = this.factors(SCENARIOS[Number(v)][1]);
        for (const [k, set] of this.sliders) set(this.f[k]);
        this.render();
      },
    );
    const comp = seg<'on' | 'off'>(
      'Compensation',
      [
        ['on', 'On'],
        ['off', 'Off'],
      ],
      'on',
      (v) => {
        this.compensate = v === 'on';
        this.render();
      },
    );
    const reset = h('button', { type: 'button', class: 'll-btn', onclick: () => ((this.bs = defaultBehaviours()), (this.sel = null), (this.editor.el.hidden = true), this.render()) }, 'Reset curves');
    this.root.append(h('div', { class: 'll-row' }, sc.el), h('div', { class: 'll-row' }, comp.el, reset), h('div', { class: 'ai-insp-grid' }, sliders, h('div', {}, this.hint, this.cards)), this.editor.el);
    onTheme(() => this.render());
    this.render();
  }

  private factors(p: Partial<Factors>): Factors {
    const f: Factors = { health: 100, charges: CHARGES, reserve: RESERVE_MAX, potions: 1, potionAvailable: 1, enemies: 0, enemyDist: 99, damageTaken: 0, inCover: 0, exposed: 0, coverDist: 5, crystalDist: 15, potionDist: 15, recharging: 0, healing: 0, ...p };
    this.f = f;
    this.derive();
    return f;
  }
  private derive(): void {
    this.f.exposed = this.f.enemies > 0 && !this.f.inCover ? 1 : 0;
    if (!this.f.enemies) this.f.enemyDist = Math.max(this.f.enemyDist, 40);
  }

  private render(): void {
    const scored = this.bs.map((b) => scoreBehaviour(b, this.f, this.compensate));
    const best = scored.reduce((a, b) => (b.final > a.final ? b : a));
    const max = Math.max(...scored.map((s) => s.final), 0.01);
    const cols = plotCols(this.root);
    this.cards.replaceChildren(
      ...scored.map((s, bi) => {
        const rows = s.parts.map((p, ci) => {
          const cnv = h('canvas', { width: '112', height: '60', class: 'ai-mini', title: 'Edit this curve' });
          plotCurve(cnv, p.c.curve, cols, p.x, 4);
          const active = this.sel?.b === bi && this.sel.c === ci;
          cnv.addEventListener('click', () => {
            this.sel = { b: bi, c: ci };
            const info = FACTOR_INFO[p.c.factor];
            this.editor.edit(p.c.curve, `Editing ${ACTION_NAMES[s.b.id]} › ${p.c.name}`, `${info.label} ${p.c.min}–${p.c.max}${info.unit ?? ''}, normalised`);
            this.editor.el.hidden = false;
            this.render();
            this.editor.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          });
          return h(
            'div',
            { class: `ai-con${active ? ' sel' : ''}${p.y === 0 ? ' zero' : ''}` },
            h('span', { class: 'ai-con-n' }, p.c.name, h('small', {}, `${FACTOR_INFO[p.c.factor].label}: ${+p.raw.toFixed(1)}`)),
            cnv,
            h('b', {}, fx(p.y)),
          );
        });
        const formula =
          `${s.parts.map((p) => fx(p.y)).join(' × ')} = ${fx(s.product)}` +
          (this.compensate && s.parts.length > 1 ? ` → ${fx(s.compensated)}` : '') +
          (s.b.weight !== 1 ? ` × ${s.b.weight}` : '');
        return h(
          'div',
          { class: `ai-card${s === best ? ' win' : ''}`, style: `--ac: var(${ACTION_COL[s.b.id]})` },
          h('div', { class: 'ai-card-h' }, h('span', {}, ACTION_NAMES[s.b.id]), h('b', {}, fx(s.final))),
          h('div', { class: 'ai-bar' }, h('i', { style: `width:${(s.final / max) * 100}%` })),
          ...rows,
          h('div', { class: 'ai-formula' }, formula),
        );
      }),
    );
  }
}

// ===========================================================================
// "Why did it do that?" panels

/** The top few behaviours this tick, each with the considerations that produced its score. */
function utilityWhy(b: UtilityBrain, chosen: ActionId | null, top = 3): HTMLElement {
  const ranked = [...b.last].sort((x, y) => (b.effective[y.b.id] ?? 0) - (b.effective[x.b.id] ?? 0)).slice(0, top);
  return h(
    'div',
    { class: 'ai-whyu' },
    ...ranked.map((s) => {
      const eff = b.effective[s.b.id] ?? 0;
      const bonus = eff - s.final;
      return h(
        'div',
        { class: `ai-whyu-row${s.b.id === chosen ? ' chosen' : ''}` },
        actionChip(s.b.id),
        h('b', { class: 'ai-num' }, fx(eff)),
        h(
          'span',
          { class: 'll-muted' },
          s.parts.map((p) => `${p.c.name} ${fx(p.y)}`).join(' × '),
          s.compensated !== s.product ? ` = ${fx(s.product)}, compensated ${fx(s.compensated)}` : '',
          s.b.weight !== 1 ? `, weight ×${s.b.weight}` : '',
          bonus > 0.001 ? `, +${fx(bonus)} for sticking with it` : '',
        ),
      );
    }),
  );
}

/** One line: which top-level branches the tree tried, in order, and where it ended up. */
function treeSummary(b: TreeBrain): string {
  const parts: string[] = [];
  let n: BtNode | undefined = b.root;
  while (n && n.children) {
    const tried: BtNode[] = n.children.filter((c) => b.status.has(c.id));
    const mark = (c: BtNode) => {
      const s = b.status.get(c.id)!;
      return c.kind === 'condition' ? `${c.name} ${s === 'success' ? '✓' : '✗'}` : `${c.name} ${s === 'failure' ? '✗' : s === 'running' ? '…' : '✓'}`;
    };
    parts.push(tried.map(mark).join(', '));
    n = tried.find((c: BtNode) => b.status.get(c.id) === 'running');
  }
  return parts.join(' → ');
}

// ===========================================================================
// Utility agent in the arena, with selection and commitment options

function newSeed(): number {
  return 1 + Math.floor(Math.random() * 99999);
}

abstract class ArenaWidget {
  protected root: HTMLElement;
  protected world!: World;
  protected cnv = arenaCanvas();
  protected strip = stripCanvas();
  protected hist = new History();
  protected stats = h('div', { class: 'll-stats' });
  protected runner: Runner;
  protected seed = 3;
  protected playBtn!: HTMLButtonElement;
  abstract brain: Brain;

  constructor(host: HTMLElement, cls: string) {
    this.root = h('div', { class: `ll ai ${cls}` });
    host.replaceChildren(this.root);
    this.runner = new Runner(
      this.root,
      () => this.tick(),
      () => this.draw(),
      () => this.world.dead,
      () => drawArena(this.cnv, this.world),
    );
    onTheme(() => this.draw());
    whenSprites(() => this.world && this.draw());
  }

  protected controls(): HTMLElement {
    this.playBtn = h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.toggle() }, 'Play');
    const spd = seg<string>(
      'Speed',
      [
        ['1', '×1'],
        ['4', '×4'],
        ['16', '×16'],
      ],
      '1',
      (v) => (this.runner.speed = Number(v) as Speed),
    );
    return h(
      'div',
      { class: 'll-row' },
      this.playBtn,
      h('button', { type: 'button', class: 'll-btn', onclick: () => (this.runner.step(), this.syncPlay()) }, 'Step'),
      h('button', { type: 'button', class: 'll-btn', onclick: () => this.restart(this.seed) }, 'Restart'),
      h('button', { type: 'button', class: 'll-btn', onclick: () => this.restart(newSeed()) }, 'New fight'),
      spd.el,
    );
  }

  private toggle(): void {
    if (this.world.dead) this.restart(this.seed);
    this.runner.play();
    this.syncPlay();
  }
  protected syncPlay(): void {
    this.playBtn.textContent = this.runner.playing ? 'Pause' : 'Play';
  }

  protected restart(seed: number): void {
    this.seed = seed;
    this.world = new World(seed);
    this.hist.clear();
    this.resetBrain();
    this.draw();
  }
  protected abstract resetBrain(): void;

  protected tick(): void {
    const a = this.brain.decide(this.world);
    this.record(a);
    this.world.step(a);
  }
  protected record(a: ActionId): void {
    this.hist.push(a);
  }

  protected draw(): void {
    drawArena(this.cnv, this.world);
    drawStrip(this.strip, this.hist);
    this.stats.replaceChildren(...statsRow(this.world, this.brain));
    this.syncPlay();
  }
}

export class UtilitySim extends ArenaWidget {
  brain!: UtilityBrain;
  private chart = chartCanvas();
  private opt = { selection: 'best' as Selection, inertia: 0, commit: 0, compensate: true };
  private potionCheck: 'damage' | 'exposed' = 'damage';
  private why = h('div', { class: 'ai-why' });

  constructor(host: HTMLElement) {
    super(host, 'ai-usim');
    const sel = seg<Selection>(
      'Pick',
      [
        ['best', 'Highest score'],
        ['weighted', 'Weighted random, near the top'],
        ['dual', 'Dual utility (rank, then weight)'],
      ],
      this.opt.selection,
      (v) => (this.opt.selection = v),
    );
    const inertia = seg<string>(
      'Inertia',
      [
        ['0', 'None'],
        ['0.05', '+0.05'],
        ['0.15', '+0.15'],
      ],
      '0',
      (v) => (this.opt.inertia = Number(v)),
    );
    const commit = seg<string>(
      'Commitment',
      [
        ['0', 'None'],
        ['0.2', '+0.2'],
        ['0.5', '+0.5'],
      ],
      '0',
      (v) => (this.opt.commit = Number(v)),
    );
    const med = seg<'damage' | 'exposed'>(
      '"Get potion" safety check',
      [
        ['damage', 'Damage taken recently'],
        ['exposed', 'Exposed (not in cover)'],
      ],
      this.potionCheck,
      (v) => {
        this.potionCheck = v;
        this.applyPotionCheck();
      },
    );
    this.root.append(
      this.controls(),
      h('div', { class: 'll-row' }, sel.el),
      h('div', { class: 'll-row' }, inertia.el, commit.el),
      h('div', { class: 'll-row' }, med.el),
      h(
        'div',
        { class: 'ai-bt-grid' },
        h('div', {}, this.cnv, this.strip, legend()),
        h('div', {}, h('div', { class: 'll-h' }, 'Scores (after inertia and commitment), last 20 seconds'), this.chart, this.why),
      ),
      this.stats,
    );
    this.restart(this.seed);
  }

  private applyPotionCheck(): void {
    const b = this.brain.behaviours.find((x) => x.id === 'potion')!;
    const i = b.considerations.findIndex((c) => c.name === 'Not under attack' || c.name === 'Not exposed');
    b.considerations[i] =
      this.potionCheck === 'damage'
        ? { name: 'Not under attack', factor: 'damageTaken', min: 0, max: 25, curve: curve('poly', { k: 2, inv: true, lo: 0.1 }) }
        : { name: 'Not exposed', factor: 'exposed', min: 0, max: 1, curve: curve('linear', { inv: true, lo: 0.1 }) };
  }

  protected resetBrain(): void {
    this.brain = new UtilityBrain(defaultBehaviours(), this.opt, this.seed);
    this.applyPotionCheck();
  }

  protected record(a: ActionId): void {
    this.hist.push(a, { ...this.brain.effective });
  }

  protected draw(): void {
    super.draw();
    drawScores(this.chart, this.hist);
    this.why.replaceChildren(h('div', { class: 'll-h' }, 'Why: the top three this tick, and what each score is made of'), utilityWhy(this.brain, this.world.agent.action));
  }
}

// ===========================================================================
// Behaviour tree in the arena

export class TreeSim extends ArenaWidget {
  brain!: TreeBrain;
  private memory = false;
  private tree = h('div', { class: 'ai-tree' });
  private why = h('div', { class: 'ai-why' });

  constructor(host: HTMLElement) {
    super(host, 'ai-bt');
    const mode = seg<'reactive' | 'memory'>(
      'Composites',
      [
        ['reactive', 'Reactive (restart from the root every tick)'],
        ['memory', 'Memory (resume the running child)'],
      ],
      'reactive',
      (v) => {
        this.memory = v === 'memory';
        this.brain.memory = this.memory;
      },
    );
    this.root.append(this.controls(), h('div', { class: 'll-row' }, mode.el), h('div', { class: 'ai-bt-grid' }, h('div', {}, this.cnv, this.strip, legend(), this.why), this.tree), this.stats);
    this.restart(this.seed);
  }

  protected resetBrain(): void {
    this.brain = new TreeBrain(undefined, this.memory);
  }

  protected draw(): void {
    super.draw();
    const st = this.brain.status;
    const node = (n: BtNode): HTMLElement => {
      const s = st.get(n.id);
      const icon = n.kind === 'selector' ? '?' : n.kind === 'sequence' ? '→' : n.kind === 'condition' ? '◇' : '▶';
      const label = h(
        'div',
        { class: `ai-node k-${n.kind} ${s ? 's-' + s : 's-none'}`, style: n.action ? `--ac: var(${ACTION_COL[n.action]})` : undefined },
        h('span', { class: 'ai-node-i', 'aria-hidden': 'true' }, icon),
        h('span', { class: 'ai-node-n' }, n.name),
        h('span', { class: 'ai-node-s' }, s ?? ''),
      );
      return h('li', {}, label, n.children ? h('ul', {}, ...n.children.map(node)) : null);
    };
    this.tree.replaceChildren(
      h('div', { class: 'll-h' }, `Last tick: ${this.brain.cost} nodes visited`),
      h('ul', { class: 'ai-tree-root' }, node(this.brain.root)),
      h('p', { class: 'll-muted ai-tree-key' }, '? selector (first child that succeeds) · → sequence (all children in order) · ◇ condition · ▶ action'),
    );
    const b = this.brain;
    const word = (k: BtNode['kind'], s: string) => (k === 'condition' ? (s === 'success' ? 'true' : 'false') : s);
    this.why.replaceChildren(
      h('div', { class: 'll-h' }, 'Why: the last tick, in the order the tree visited it'),
      h('p', { class: 'ai-why-sum' }, treeSummary(b) || '—'),
      h(
        'ol',
        { class: 'ai-trace' },
        ...b.trace.map((t) =>
          h(
            'li',
            { style: `--d: ${t.depth}` },
            h('span', {}, t.n.name),
            ' ',
            h('span', { class: `ai-trace-s s-${t.s}` }, word(t.n.kind, t.s)),
            t.resumed ? h('span', { class: 'll-muted' }, ` (resumed at child ${t.resumed + 1})`) : '',
          ),
        ),
      ),
    );
  }
}

// ===========================================================================
// GOAP planner

export class GoapViz {
  private root: HTMLElement;
  private start: FactState = { enemyDead: false, inRange: false, inCover: false, staffCharged: false, hasCrystals: true, hasPotion: false, potionAvailable: true, healthy: true };
  private goal = 0;
  private shown = 0;
  private res!: PlanResult;
  private out = h('div', { class: 'ai-goap-out' });
  private timer = 0;
  private playBtn = h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.togglePlay() }, 'Play') as HTMLButtonElement;
  private facts = h('div', { class: 'ai-facts' });

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ai ai-goap' });
    host.replaceChildren(this.root);
    const g = seg<string>(
      'Goal',
      GOALS.slice(0, 3).map((x, i) => [String(i), x.name] as [string, string]),
      '0',
      (v) => {
        this.goal = Number(v);
        this.replan();
      },
    );
    const table = h(
      'table',
      { class: 'det-table ai-acts' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Action'), h('th', {}, 'Needs'), h('th', {}, 'Makes true / false'), h('th', {}, 'Cost'))),
      h(
        'tbody',
        {},
        ...GOAP_ACTIONS.map((a) =>
          h(
            'tr',
            {},
            h('td', {}, a.name),
            h('td', {}, this.factText(a.pre) || '—'),
            h('td', {}, this.factText(a.eff)),
            h('td', {}, a.costText),
          ),
        ),
      ),
    );
    this.root.append(
      h('div', { class: 'll-h' }, 'Current world state (click to toggle)'),
      this.facts,
      h('div', { class: 'll-row' }, g.el),
      h(
        'div',
        { class: 'll-row' },
        h('button', { type: 'button', class: 'll-btn', title: 'Back to the start', onclick: () => (this.pause(), this.show(0)) }, '⏮'),
        h('button', { type: 'button', class: 'll-btn', title: 'Back one state', onclick: () => (this.pause(), this.show(this.shown - 1)) }, '◀'),
        this.playBtn,
        h('button', { type: 'button', class: 'll-btn', title: 'Expand one state', onclick: () => (this.pause(), this.show(this.shown + 1)) }, '▶|'),
        h('button', { type: 'button', class: 'll-btn', title: 'Jump to the result', onclick: () => (this.pause(), this.show(this.res.expanded.length)) }, '⏭'),
        h('span', { class: 'll-muted' }, 'Play expands one state at a time, about two a second.'),
      ),
      this.out,
      h('details', { class: 'ai-details' }, h('summary', {}, 'The actions the planner can use'), h('div', { class: 'det-sums' }, table)),
    );
    this.replan();
  }

  private togglePlay(): void {
    if (this.timer) return this.pause();
    if (this.shown >= this.res.expanded.length) this.show(0);
    this.playBtn.textContent = 'Pause';
    this.timer = window.setInterval(() => {
      this.show(this.shown + 1);
      if (this.shown >= this.res.expanded.length) this.pause();
    }, 480);
  }
  private pause(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.playBtn.textContent = 'Play';
  }

  private factText(p: Partial<FactState>): string {
    return (Object.keys(p) as Fact[]).map((k) => (p[k] ? FACT_LABEL[k] : `not ${FACT_LABEL[k]}`)).join(', ');
  }

  private replan(): void {
    this.facts.replaceChildren(
      ...FACTS.map((k) =>
        h(
          'button',
          {
            type: 'button',
            class: 'ai-fact',
            'aria-pressed': String(this.start[k]),
            onclick: () => {
              this.start[k] = !this.start[k];
              this.replan();
            },
          },
          FACT_LABEL[k],
        ),
      ),
    );
    this.res = plan(this.start, GOALS[this.goal].want);
    this.pause();
    this.show(this.res.expanded.length);
  }

  private show(n: number): void {
    const r = this.res;
    this.shown = Math.max(0, Math.min(n, r.expanded.length));
    const done = this.shown >= r.expanded.length;
    const diff = (a: FactState, b: FactState | null) =>
      FACTS.filter((k) => !b || a[k] !== b[k])
        .filter((k) => b || a[k])
        .map((k) => h('span', { class: `ai-f ${a[k] ? 'on' : 'off'}` }, a[k] ? FACT_LABEL[k] : `no ${FACT_LABEL[k]}`));
    const rows = r.expanded.slice(0, this.shown).map((n) =>
      h(
        'tr',
        { class: done && r.goalNode && this.onPath(n) ? 'path' : '' },
        h('td', { class: 'mono' }, String(n.order + 1)),
        h('td', {}, n.action ? n.action.name : 'start'),
        h('td', { class: 'mono' }, `${n.g} + ${n.h} = ${n.g + n.h}`),
        h('td', {}, ...diff(n.state, n.parent?.state ?? null)),
      ),
    );
    const want = GOALS[this.goal].want;
    this.out.replaceChildren(
      h('div', { class: 'll-muted' }, `Goal: ${this.factText(want)}. Each row is a state the search took off the open list (cheapest g + h first): g is the cost so far, h the number of goal facts still false.`),
      h('div', { class: 'det-sums' }, h('table', { class: 'det-table ai-exp' }, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Reached by'), h('th', {}, 'g + h'), h('th', {}, 'What changed'))), h('tbody', {}, ...rows))),
      done
        ? r.plan
          ? h(
              'div',
              { class: 'ai-plan' },
              h('span', { class: 'll-h' }, `Plan, cost ${r.goalNode!.g}, ${r.expanded.length} states expanded, ${r.generated} generated`),
              h('div', { class: 'ai-plan-steps' }, ...(r.plan.length ? r.plan.map((a, i) => h('span', { class: 'ai-step' }, `${i + 1}. ${a.name}`)) : [h('span', { class: 'll-muted' }, 'Nothing to do: the goal is already true.')])),
            )
          : h('div', { class: 'det-bad' }, `No plan: nothing reaches the goal from here (${r.expanded.length} states searched).`)
        : h('div', { class: 'll-muted' }, `${this.shown} of ${r.expanded.length} expansions shown.`),
    );
  }

  private onPath(n: PlanResult['expanded'][number]): boolean {
    for (let c = this.res.goalNode; c; c = c.parent) if (c === n) return true;
    return false;
  }
}

// ===========================================================================
// Side by side

interface Lane {
  name: string;
  make: () => Brain;
  world: World;
  brain: Brain;
  cnv: HTMLCanvasElement;
  strip: HTMLCanvasElement;
  hist: History;
  stats: HTMLElement;
  extra: HTMLElement;
}

export class Compare {
  private root: HTMLElement;
  private lanes: Lane[];
  private runner: Runner;
  private seed = 7;
  private playBtn: HTMLButtonElement;
  private batch = h('div', { class: 'ai-batch' });

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ai ai-cmp' });
    host.replaceChildren(this.root);
    const mk = (name: string, make: () => Brain): Lane => ({
      name,
      make,
      world: new World(this.seed),
      brain: make(),
      cnv: arenaCanvas(`${name} arena`),
      strip: stripCanvas(),
      hist: new History(),
      stats: h('div', { class: 'll-stats' }),
      extra: h('div', { class: 'll-muted ai-extra' }),
    });
    this.lanes = [
      mk('Utility', () => new UtilityBrain(defaultBehaviours(), { selection: 'best', inertia: 0.05, commit: 0.2, compensate: true })),
      mk('Behaviour tree', () => new TreeBrain()),
      mk('GOAP', () => new PlannerBrain()),
    ];
    this.runner = new Runner(
      this.root,
      () => {
        for (const l of this.lanes) {
          if (l.world.dead) continue;
          const a = l.brain.decide(l.world);
          l.hist.push(a);
          l.world.step(a);
        }
      },
      () => this.draw(),
      () => this.lanes.every((l) => l.world.dead),
      () => this.lanes.forEach((l) => drawArena(l.cnv, l.world)),
    );
    whenSprites(() => this.draw());
    this.playBtn = h('button', { type: 'button', class: 'll-btn primary', onclick: () => (this.runner.play(), this.draw()) }, 'Play');
    const spd = seg<string>(
      'Speed',
      [
        ['1', '×1'],
        ['4', '×4'],
        ['16', '×16'],
      ],
      '1',
      (v) => (this.runner.speed = Number(v) as Speed),
    );
    this.root.append(
      h(
        'div',
        { class: 'll-row' },
        this.playBtn,
        h('button', { type: 'button', class: 'll-btn', onclick: () => (this.runner.step(), this.draw()) }, 'Step'),
        h('button', { type: 'button', class: 'll-btn', onclick: () => this.restart(this.seed) }, 'Restart'),
        h('button', { type: 'button', class: 'll-btn', onclick: () => this.restart(newSeed()) }, 'New fight'),
        spd.el,
      ),
      h(
        'div',
        { class: 'ai-lanes' },
        ...this.lanes.map((l) => h('div', { class: 'ai-lane' }, h('div', { class: 'ai-lane-h' }, l.name), l.cnv, l.strip, l.stats, l.extra)),
      ),
      legend(),
      h('div', { class: 'll-row' }, h('button', { type: 'button', class: 'll-btn', onclick: () => this.runBatch() }, 'Run 40 fights each (3 minutes max)'), h('span', { class: 'll-muted' }, 'Runs headless in a few hundred milliseconds; same 40 seeds for every brain.')),
      this.batch,
    );
    onTheme(() => this.draw());
    this.draw();
  }

  private restart(seed: number): void {
    this.seed = seed;
    for (const l of this.lanes) {
      l.world = new World(seed);
      l.brain = l.make();
      l.hist.clear();
    }
    this.draw();
  }

  private draw(): void {
    this.playBtn.textContent = this.runner.playing ? 'Pause' : 'Play';
    for (const l of this.lanes) {
      drawArena(l.cnv, l.world);
      drawStrip(l.strip, l.hist);
      const min = Math.max(1 / 60, l.world.seconds / 60);
      l.stats.replaceChildren(stat(`${l.world.seconds.toFixed(0)} s`, l.world.dead ? 'survived' : 'alive'), stat(String(l.world.stats.kills), 'kills'), stat((l.world.stats.switches / min).toFixed(0), 'switches / min'));
      const b = l.brain;
      if (b instanceof PlannerBrain)
        l.extra.textContent = `Goal: ${b.goal?.name ?? 'none (patrol)'} · plan: ${b.current.map((a, i) => (i === b.stepIndex ? `[${a.name}]` : a.name)).join(' → ') || '—'} · replans ${b.replans}${b.lastReason ? ` (last: ${b.lastReason})` : ''}`;
      else if (b instanceof TreeBrain) l.extra.textContent = `${treeSummary(b) || '—'} · ${b.cost} nodes visited`;
      else if (b instanceof UtilityBrain) l.extra.replaceChildren(utilityWhy(b, l.world.agent.action, 2));
    }
  }

  private runBatch(): void {
    const N = 40;
    const rows = this.lanes.map((l) => {
      let alive = 0;
      let kills = 0;
      let sw = 0;
      let wasted = 0;
      let cost = 0;
      let decisions = 0;
      let survived = 0;
      const t0 = performance.now();
      for (let s = 1; s <= N; s++) {
        const w = new World(1000 + s);
        const b = l.make();
        while (!w.dead && w.tick < 180 * TICK_HZ) {
          w.step(b.decide(w));
          cost += b.cost;
          decisions++;
        }
        alive += w.seconds;
        kills += w.stats.kills;
        sw += w.stats.switches / (w.seconds / 60);
        wasted += w.stats.wasted;
        if (!w.dead) survived++;
      }
      const ms = performance.now() - t0;
      return h(
        'tr',
        {},
        h('td', {}, l.name),
        h('td', {}, `${(alive / N).toFixed(0)} s`),
        h('td', {}, `${survived} / ${N}`),
        h('td', {}, (kills / N).toFixed(1)),
        h('td', {}, (sw / N).toFixed(0)),
        h('td', {}, (wasted / N).toFixed(1)),
        h('td', {}, `${(cost / decisions).toFixed(cost < decisions ? 2 : 1)} ${l.brain.costUnit}`),
        h('td', { class: 'mono' }, `${((ms / decisions) * 1000).toFixed(1)} µs`),
      );
    });
    this.batch.replaceChildren(
      h(
        'div',
        { class: 'det-sums' },
        h(
          'table',
          { class: 'det-table' },
          h('thead', {}, h('tr', {}, ...['Brain', 'Average time alive', 'Lasted 3 min', 'Kills', 'Switches / min', 'Interrupted', 'Work per tick', 'Time per tick (sim + brain)'].map((t) => h('th', {}, t)))),
          h('tbody', {}, ...rows),
        ),
      ),
    );
  }
}
