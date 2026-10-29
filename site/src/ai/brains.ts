/**
 * Three ways to choose what the arena agent does: utility scoring, a behaviour
 * tree, and goal-oriented action planning. Each brain returns one ActionId per
 * tick and reports how much work the decision took.
 */
import { type Curve, curve, evalCurve } from './curves';
import { type ActionId, type Factors, type World, CHARGES, RANGE, RESERVE_MAX, rng } from './world';

export interface Brain {
  readonly name: string;
  decide(w: World): ActionId;
  /** Work done by the last decision: considerations scored, nodes ticked, or states expanded. */
  cost: number;
  costUnit: string;
}

// ===========================================================================
// Utility

export interface Consideration {
  name: string;
  factor: keyof Factors;
  min: number;
  max: number;
  curve: Curve;
}
export interface Behaviour {
  id: ActionId;
  weight: number;
  /** For dual utility: higher ranks are considered first. */
  rank: number;
  considerations: Consideration[];
}

export const FACTOR_INFO: Record<keyof Factors, { label: string; min: number; max: number; step: number; unit?: string }> = {
  health: { label: 'Health', min: 0, max: 100, step: 1 },
  charges: { label: 'Charges in staff', min: 0, max: CHARGES, step: 1 },
  reserve: { label: 'Spare crystals', min: 0, max: RESERVE_MAX, step: 1 },
  potions: { label: 'Potions carried', min: 0, max: 1, step: 1 },
  potionAvailable: { label: 'Potion at the shrine', min: 0, max: 1, step: 1 },
  enemies: { label: 'Enemies alive', min: 0, max: 4, step: 1 },
  enemyDist: { label: 'Nearest enemy', min: 0, max: 40, step: 0.5, unit: 'm' },
  damageTaken: { label: 'Damage taken, last 2 s', min: 0, max: 40, step: 1 },
  inCover: { label: 'In cover', min: 0, max: 1, step: 1 },
  exposed: { label: 'Exposed (enemies, no cover)', min: 0, max: 1, step: 1 },
  coverDist: { label: 'Distance to cover', min: 0, max: 40, step: 0.5, unit: 'm' },
  crystalDist: { label: 'Distance to crystals', min: 0, max: 40, step: 0.5, unit: 'm' },
  potionDist: { label: 'Distance to potion shrine', min: 0, max: 40, step: 0.5, unit: 'm' },
  recharging: { label: 'Recharge progress', min: 0, max: 1, step: 0.05 },
  healing: { label: 'Drinking progress', min: 0, max: 1, step: 0.05 },
};

const con = (name: string, factor: keyof Factors, min: number, max: number, cv: Curve): Consideration => ({ name, factor, min, max, curve: cv });

/** The default behaviour set, deliberately small: seven actions, one to five considerations each. */
export function defaultBehaviours(): Behaviour[] {
  return [
    {
      id: 'attack',
      weight: 1,
      rank: 2,
      considerations: [
        con('Enemy present', 'enemies', 0, 1, curve('step', { c: 0.5 })),
        con('Charges left', 'charges', 0, CHARGES, curve('poly', { k: 0.4 })),
        con('Enemy close', 'enemyDist', 0, 30, curve('logistic', { k: 10, c: 0.55, inv: true, lo: 0.25 })),
        con('Healthy enough', 'health', 0, 100, curve('logistic', { k: 12, c: 0.3, lo: 0.1 })),
        con('Not exposed', 'exposed', 0, 1, curve('linear', { inv: true, lo: 0.7 })),
      ],
    },
    {
      id: 'cover',
      weight: 1,
      rank: 2,
      considerations: [
        con('Enemy present', 'enemies', 0, 1, curve('step', { c: 0.5 })),
        con('Taking hits', 'damageTaken', 0, 25, curve('poly', { k: 0.5, lo: 0.15 })),
        con('Hurt', 'health', 0, 100, curve('poly', { k: 1.5, inv: true, lo: 0.75 })),
        con('Exposed', 'exposed', 0, 1, curve('step', { c: 0.5, lo: 0.05 })),
      ],
    },
    {
      id: 'recharge',
      weight: 1,
      rank: 2,
      considerations: [
        con('Staff empty', 'charges', 0, CHARGES, curve('poly', { k: 3, inv: true })),
        con('Have spare crystals', 'reserve', 0, RESERVE_MAX, curve('step', { c: 0.01 })),
        con('Not exposed', 'exposed', 0, 1, curve('linear', { inv: true, lo: 0.5 })),
      ],
    },
    {
      id: 'heal',
      weight: 1.1,
      rank: 3,
      considerations: [
        con('Badly hurt', 'health', 0, 100, curve('logistic', { k: 12, c: 0.5, inv: true })),
        con('Have a potion', 'potions', 0, 1, curve('step', { c: 0.5 })),
        con('Not exposed', 'exposed', 0, 1, curve('linear', { inv: true, lo: 0.7 })),
      ],
    },
    {
      id: 'potion',
      weight: 1,
      rank: 2,
      considerations: [
        con('No potion carried', 'potions', 0, 1, curve('step', { c: 0.5, inv: true })),
        con('One at the shrine', 'potionAvailable', 0, 1, curve('step', { c: 0.5 })),
        con('Hurt', 'health', 0, 100, curve('poly', { k: 2, inv: true, lo: 0.25 })),
        con('Not under attack', 'damageTaken', 0, 25, curve('poly', { k: 2, inv: true, lo: 0.1 })),
        con('Shrine close', 'potionDist', 0, 40, curve('linear', { inv: true, lo: 0.4 })),
      ],
    },
    {
      id: 'crystals',
      weight: 1,
      rank: 2,
      considerations: [
        con('Low on crystals', 'reserve', 0, RESERVE_MAX, curve('poly', { k: 3, inv: true })),
        con('Staff low', 'charges', 0, CHARGES, curve('linear', { inv: true, lo: 0.3 })),
        con('Crystals close', 'crystalDist', 0, 40, curve('linear', { inv: true, lo: 0.35 })),
      ],
    },
    {
      id: 'patrol',
      weight: 1,
      rank: 0,
      considerations: [con('No enemies', 'enemies', 0, 1, curve('step', { c: 0.5, inv: true, lo: 0.02, hi: 0.15 }))],
    },
  ];
}

export interface ScoredConsideration {
  c: Consideration;
  raw: number;
  x: number;
  y: number;
}
export interface Scored {
  b: Behaviour;
  parts: ScoredConsideration[];
  product: number;
  compensated: number;
  final: number;
}

/** Score one behaviour: multiply its considerations, optionally compensate for their count, apply weight. */
export function scoreBehaviour(b: Behaviour, f: Factors, compensate: boolean): Scored {
  const parts: ScoredConsideration[] = [];
  let product = 1;
  for (const c of b.considerations) {
    const raw = f[c.factor];
    const x = (raw - c.min) / (c.max - c.min || 1);
    const y = evalCurve(c.curve, x);
    parts.push({ c, raw, x, y });
    product *= y;
  }
  let compensated = product;
  if (compensate && b.considerations.length > 1) {
    // Many considerations multiply down; give back part of the lost score.
    const mod = 1 - 1 / b.considerations.length;
    compensated = product + (1 - product) * mod * product;
  }
  return { b, parts, product, compensated, final: compensated * b.weight };
}

export type Selection = 'best' | 'weighted' | 'dual';

export interface UtilityOptions {
  selection: Selection;
  /** Added to the current action's score, so a rival must beat it by this much. */
  inertia: number;
  /** Bonus while an action is committed: a recharge or heal in progress, or the first second of any action. */
  commit: number;
  compensate: boolean;
}

export class UtilityBrain implements Brain {
  readonly name = 'Utility';
  cost = 0;
  costUnit = 'considerations';
  last: Scored[] = [];
  /** Score after inertia and commitment, per action, for charts. */
  effective: Partial<Record<ActionId, number>> = {};
  private r: () => number;
  constructor(
    public behaviours: Behaviour[] = defaultBehaviours(),
    public opt: UtilityOptions = { selection: 'best', inertia: 0, commit: 0, compensate: true },
    seed = 99,
  ) {
    this.r = rng(seed);
  }

  decide(w: World): ActionId {
    const f = w.factors();
    const cur = w.agent.action;
    const busy = (cur === 'recharge' && f.recharging > 0) || (cur === 'heal' && f.healing > 0) || w.agent.actionTicks < 10;
    this.last = this.behaviours.map((b) => scoreBehaviour(b, f, this.opt.compensate));
    this.cost = this.behaviours.reduce((s, b) => s + b.considerations.length, 0);
    const eff = this.last.map((s) => {
      let v = s.final;
      if (s.b.id === cur && v > 0) v += this.opt.inertia + (busy ? this.opt.commit : 0);
      return { id: s.b.id, rank: s.b.rank, v };
    });
    this.effective = Object.fromEntries(eff.map((e) => [e.id, e.v]));
    let pool = eff.filter((e) => e.v > 0);
    if (!pool.length) return 'patrol';
    if (this.opt.selection === 'dual') {
      // Highest rank that has a meaningful option wins; weighted random within it.
      const viable = pool.filter((e) => e.v >= 0.2);
      if (viable.length) {
        const top = Math.max(...viable.map((e) => e.rank));
        pool = viable.filter((e) => e.rank === top);
      }
    }
    pool.sort((a, b) => b.v - a.v);
    if (this.opt.selection === 'best') return pool[0].id;
    // Weighted random among the options close to the best one.
    return this.weighted(pool.filter((e) => e.v >= pool[0].v * 0.8).slice(0, 3), cur);
  }

  private weighted(pool: Array<{ id: ActionId; v: number }>, cur: ActionId): ActionId {
    // Keep the current choice if it's in the pool, otherwise roll. (Re-rolling every tick would flicker.)
    if (pool.some((e) => e.id === cur) && this.r() < 0.9) return cur;
    const total = pool.reduce((s, e) => s + e.v, 0);
    let t = this.r() * total;
    for (const e of pool) if ((t -= e.v) <= 0) return e.id;
    return pool[pool.length - 1].id;
  }
}

// ===========================================================================
// Behaviour tree

export type Status = 'success' | 'failure' | 'running';
export interface BtNode {
  id: number;
  kind: 'selector' | 'sequence' | 'condition' | 'action';
  name: string;
  children?: BtNode[];
  test?: (f: Factors, w: World) => boolean;
  action?: ActionId;
}

let nid = 0;
const sel = (name: string, ...children: BtNode[]): BtNode => ({ id: nid++, kind: 'selector', name, children });
const seq = (name: string, ...children: BtNode[]): BtNode => ({ id: nid++, kind: 'sequence', name, children });
const cond = (name: string, test: (f: Factors, w: World) => boolean): BtNode => ({ id: nid++, kind: 'condition', name, test });
const act = (action: ActionId, name?: string): BtNode => ({ id: nid++, kind: 'action', name: name ?? action, action });

export function defaultTree(): BtNode {
  nid = 0;
  return sel(
    'Root',
    seq(
      'Patch up',
      cond('health < 40', (f) => f.health < 40),
      sel('Have a potion', cond('carrying one', (f) => f.potions > 0), act('potion', 'Get potion')),
      act('heal', 'Heal'),
    ),
    seq(
      'Recharge',
      cond('staff empty', (f) => f.charges === 0),
      cond('spare crystals', (f) => f.reserve > 0),
      sel('Somewhere safe', cond('no enemies', (f) => f.enemies === 0), act('cover', 'Take cover')),
      act('recharge', 'Recharge'),
    ),
    seq('Restock crystals', cond('spare crystals < 6', (f) => f.reserve < 6), cond('charges < 3', (f) => f.charges < 3), act('crystals', 'Get crystals')),
    seq(
      'Fight',
      cond('enemy present', (f) => f.enemies > 0),
      sel('Engage', seq('Under attack', cond('taking hits', (f) => f.damageTaken >= 14), cond('not in cover', (f) => f.inCover === 0), act('cover', 'Take cover')), act('attack', 'Attack')),
    ),
    seq('Restock potion', cond('no enemies', (f) => f.enemies === 0), cond('no potion', (f) => f.potions === 0), cond('one at the shrine', (f) => f.potionAvailable > 0), act('potion', 'Get potion')),
    act('patrol', 'Patrol'),
  );
}

export class TreeBrain implements Brain {
  readonly name = 'Behaviour tree';
  cost = 0;
  costUnit = 'nodes ticked';
  /** Status of each node on the last tick (absent = not visited). */
  status = new Map<number, Status>();
  /** The nodes visited on the last tick, in visiting order, with their depth and result. */
  trace: Array<{ n: BtNode; depth: number; s: Status; resumed: number }> = [];
  /** Memory composites remember their running child between ticks. */
  private running = new Map<number, number>();
  private chosen: ActionId = 'patrol';
  constructor(
    public root: BtNode = defaultTree(),
    public memory = false,
  ) {}

  decide(w: World): ActionId {
    this.status.clear();
    this.trace = [];
    this.cost = 0;
    this.chosen = 'patrol';
    const f = w.factors();
    const s = this.tick(this.root, f, w, 0);
    if (s !== 'running') this.running.clear();
    return this.chosen;
  }

  private tick(n: BtNode, f: Factors, w: World, depth: number): Status {
    this.cost++;
    const at = this.trace.length;
    this.trace.push({ n, depth, s: 'failure', resumed: 0 });
    let s: Status;
    switch (n.kind) {
      case 'condition':
        s = n.test!(f, w) ? 'success' : 'failure';
        break;
      case 'action':
        s = this.leaf(n.action!, f, w);
        if (s === 'running') this.chosen = n.action!;
        break;
      default: {
        const kids = n.children!;
        const start = this.memory ? (this.running.get(n.id) ?? 0) : 0;
        this.trace[at].resumed = start;
        const goal: Status = n.kind === 'selector' ? 'success' : 'failure';
        s = n.kind === 'selector' ? 'failure' : 'success';
        for (let i = start; i < kids.length; i++) {
          const r = this.tick(kids[i], f, w, depth + 1);
          if (r === 'running') {
            this.running.set(n.id, i);
            s = 'running';
            break;
          }
          if (r === goal) {
            s = goal;
            break;
          }
        }
        if (s !== 'running') this.running.delete(n.id);
      }
    }
    this.status.set(n.id, s);
    this.trace[at].s = s;
    return s;
  }

  private leaf(a: ActionId, f: Factors, w: World): Status {
    const ag = w.agent;
    switch (a) {
      case 'attack':
        return f.enemies === 0 || f.charges === 0 ? 'failure' : 'running';
      case 'cover':
        if (f.enemies === 0) return 'failure';
        return f.inCover ? 'success' : 'running';
      case 'recharge':
        if (ag.completed === 'recharge' || f.charges === CHARGES) return 'success';
        return f.reserve === 0 ? 'failure' : 'running';
      case 'heal':
        if (ag.completed === 'heal') return 'success';
        return f.potions === 0 ? 'failure' : 'running';
      case 'potion':
        if (f.potions > 0) return 'success';
        return f.potionAvailable === 0 ? 'failure' : 'running';
      case 'crystals':
        return f.reserve >= RESERVE_MAX ? 'success' : 'running';
      case 'patrol':
        return ag.completed === 'patrol' ? 'success' : 'running';
    }
  }
}

// ===========================================================================
// GOAP

export const FACTS = ['enemyDead', 'inRange', 'inCover', 'staffCharged', 'hasCrystals', 'hasPotion', 'potionAvailable', 'healthy'] as const;
export type Fact = (typeof FACTS)[number];
export type FactState = Record<Fact, boolean>;
export const FACT_LABEL: Record<Fact, string> = {
  enemyDead: 'enemy dead',
  inRange: 'in range',
  inCover: 'in cover',
  staffCharged: 'staff charged',
  hasCrystals: 'spare crystals',
  hasPotion: 'carrying potion',
  potionAvailable: 'potion at shrine',
  healthy: 'healthy',
};

export interface GoapAction {
  name: string;
  pre: Partial<FactState>;
  eff: Partial<FactState>;
  cost: (s: FactState) => number;
  costText: string;
  arena: ActionId;
}

export const GOAP_ACTIONS: GoapAction[] = [
  { name: 'Approach', pre: { enemyDead: false }, eff: { inRange: true, inCover: false }, cost: () => 2, costText: '2', arena: 'attack' },
  { name: 'CastBolt', pre: { inRange: true, staffCharged: true, enemyDead: false }, eff: { enemyDead: true }, cost: (s) => (s.inCover ? 2 : 4), costText: '2 in cover, else 4', arena: 'attack' },
  { name: 'TakeCover', pre: { enemyDead: false }, eff: { inCover: true }, cost: () => 2, costText: '2', arena: 'cover' },
  { name: 'Recharge', pre: { hasCrystals: true }, eff: { staffCharged: true }, cost: (s) => (s.inCover || s.enemyDead ? 1 : 4), costText: '1 in cover or no enemy, else 4', arena: 'recharge' },
  { name: 'GetCrystals', pre: {}, eff: { hasCrystals: true, inCover: false, inRange: false }, cost: () => 6, costText: '6', arena: 'crystals' },
  { name: 'FetchPotion', pre: { potionAvailable: true, hasPotion: false }, eff: { hasPotion: true, potionAvailable: false, inCover: false, inRange: false }, cost: () => 5, costText: '5', arena: 'potion' },
  { name: 'DrinkPotion', pre: { hasPotion: true }, eff: { healthy: true, hasPotion: false }, cost: (s) => (s.inCover || s.enemyDead ? 1 : 4), costText: '1 in cover or no enemy, else 4', arena: 'heal' },
];

export interface Goal {
  name: string;
  want: Partial<FactState>;
}
export const GOALS: Goal[] = [
  { name: 'Kill the enemy', want: { enemyDead: true } },
  { name: 'Get healthy', want: { healthy: true } },
  { name: 'Be ready (charged, in cover)', want: { staffCharged: true, inCover: true } },
  { name: 'Carry a potion', want: { hasPotion: true } },
  { name: 'Recharge', want: { staffCharged: true } },
];

export interface PlanNode {
  state: FactState;
  g: number;
  h: number;
  action: GoapAction | null;
  parent: PlanNode | null;
  order: number;
}
export interface PlanResult {
  plan: GoapAction[] | null;
  expanded: PlanNode[];
  generated: number;
  goalNode: PlanNode | null;
}

const satisfies = (s: FactState, p: Partial<FactState>) => (Object.keys(p) as Fact[]).every((k) => s[k] === p[k]);
const unmet = (s: FactState, p: Partial<FactState>) => (Object.keys(p) as Fact[]).filter((k) => s[k] !== p[k]).length;
const key = (s: FactState) => FACTS.map((f) => (s[f] ? '1' : '0')).join('');

/** Forward A* over world states. Heuristic: number of goal facts not yet true. */
export function plan(start: FactState, goal: Partial<FactState>, actions: GoapAction[] = GOAP_ACTIONS, maxExpand = 400): PlanResult {
  const open: PlanNode[] = [{ state: start, g: 0, h: unmet(start, goal), action: null, parent: null, order: 0 }];
  const best = new Map<string, number>([[key(start), 0]]);
  const closed = new Set<string>();
  const expanded: PlanNode[] = [];
  let generated = 1;
  while (open.length && expanded.length < maxExpand) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      const a = open[i];
      const b = open[bi];
      if (a.g + a.h < b.g + b.h || (a.g + a.h === b.g + b.h && a.h < b.h)) bi = i;
    }
    const n = open.splice(bi, 1)[0];
    const k = key(n.state);
    if (closed.has(k)) continue;
    closed.add(k);
    n.order = expanded.length;
    expanded.push(n);
    if (satisfies(n.state, goal)) {
      const p: GoapAction[] = [];
      for (let c: PlanNode | null = n; c && c.action; c = c.parent) p.unshift(c.action);
      return { plan: p, expanded, generated, goalNode: n };
    }
    for (const a of actions) {
      if (!satisfies(n.state, a.pre)) continue;
      const s = { ...n.state, ...a.eff } as FactState;
      const sk = key(s);
      if (sk === k || closed.has(sk)) continue;
      const g = n.g + a.cost(n.state);
      if (g >= (best.get(sk) ?? Infinity)) continue;
      best.set(sk, g);
      generated++;
      open.push({ state: s, g, h: unmet(s, goal), action: a, parent: n, order: -1 });
    }
  }
  return { plan: null, expanded, generated, goalNode: null };
}

export function factsOf(f: Factors): FactState {
  return {
    enemyDead: f.enemies === 0,
    inRange: f.enemyDist <= RANGE,
    inCover: f.inCover > 0,
    staffCharged: f.charges > 0,
    hasCrystals: f.reserve > 0,
    hasPotion: f.potions > 0,
    potionAvailable: f.potionAvailable > 0,
    healthy: f.health >= 60,
  };
}

export class PlannerBrain implements Brain {
  readonly name = 'GOAP';
  cost = 0;
  costUnit = 'states expanded';
  goal: Goal | null = null;
  current: GoapAction[] = [];
  stepIndex = 0;
  replans = 0;
  lastReason = '';
  private stepTicks = 0;

  decide(w: World): ActionId {
    const f = w.factors();
    const s = factsOf(f);
    this.cost = 0;
    const goal = this.pickGoal(f);
    if (!goal || satisfies(s, goal.want)) {
      this.goal = null;
      this.current = [];
      return 'patrol';
    }
    let reason = '';
    if (goal !== this.goal) reason = 'new goal';
    else if (this.stepIndex >= this.current.length) reason = 'plan finished';
    else {
      const step = this.current[this.stepIndex];
      if (satisfies(s, step.eff) && step.arena !== 'heal') {
        this.stepIndex++;
        this.stepTicks = 0;
      } else if (step.name === 'DrinkPotion' && w.agent.completed === 'heal') {
        this.stepIndex++;
        this.stepTicks = 0;
      }
      if (this.stepIndex >= this.current.length) reason = satisfies(s, goal.want) ? '' : 'plan finished, goal not met';
      else if (!satisfies(s, this.current[this.stepIndex].pre)) reason = `${this.current[this.stepIndex].name}: precondition failed`;
      else if (++this.stepTicks > 80) reason = `${this.current[this.stepIndex].name}: taking too long`;
    }
    if (reason) {
      this.goal = goal;
      const r = plan(s, goal.want);
      this.cost = r.expanded.length;
      this.current = r.plan ?? [];
      this.stepIndex = 0;
      this.stepTicks = 0;
      this.replans++;
      this.lastReason = reason;
    }
    const step = this.current[this.stepIndex];
    return step ? step.arena : 'patrol';
  }

  private pickGoal(f: Factors): Goal | null {
    if (f.health < 40 && (f.potions > 0 || f.potionAvailable > 0)) return GOALS[1];
    if (f.enemies > 0) return GOALS[0];
    if (f.potions === 0 && f.potionAvailable > 0) return GOALS[3];
    if (f.charges < CHARGES / 2 && f.reserve > 0) return GOALS[4];
    return null;
  }
}
