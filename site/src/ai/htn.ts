/**
 * Hierarchical task network (HTN) planning for the arena agent.
 *
 * The same facts and the same primitive actions as GOAP (brains.ts), but instead of searching
 * for any sequence that reaches a goal, the planner decomposes one root task using methods a
 * designer wrote: ordered recipes, each with a condition and a list of subtasks. It's a
 * total-order forward decomposition (SHOP-style, as used in several shipped action games):
 * depth first, trying methods in order, simulating each primitive's effects on a copy of the
 * facts, and backtracking to the next method when a later step's preconditions fail.
 *
 * The method traversal record (MTR: which method was taken at each compound task, in order)
 * doubles as a priority: a plan whose MTR is lexicographically smaller came from earlier,
 * higher-priority methods. The brain replans when the facts change and switches only to a
 * plan with a smaller MTR, which is how an HTN agent drops what it's doing to heal.
 */
import { type ActionId, type World } from './world';
import { type Fact, type FactState, type GoapAction, type Brain, FACTS, FACT_LABEL, GOAP_ACTIONS, factsOf } from './brains';

export interface Method {
  name: string;
  /** Facts that must hold, in the planner's simulated state, to use this method. */
  pre: Partial<FactState>;
  /** Task names: compound tasks (keys of DOMAIN) or primitive actions (GOAP action names). */
  subtasks: string[];
}
export interface Compound {
  name: string;
  /** Tried in order; the first whose condition holds and whose subtasks decompose wins. */
  methods: Method[];
}

/** The primitive tasks: GOAP's actions, with the same preconditions and effects. */
export const PRIMITIVES: Record<string, GoapAction> = Object.fromEntries(GOAP_ACTIONS.map((a) => [a.name, a]));

/** The arena domain. The root's method order is the agent's priorities. */
export const DOMAIN: Record<string, Compound> = {
  BeABattleMage: {
    name: 'BeABattleMage',
    methods: [
      { name: 'Patch up', pre: { healthy: false }, subtasks: ['GetPotion', 'Shelter', 'DrinkPotion'] },
      { name: 'Fight', pre: { enemyDead: false }, subtasks: ['Fight'] },
      { name: 'Restock potion', pre: { hasPotion: false, potionAvailable: true }, subtasks: ['FetchPotion'] },
      { name: 'Get ready', pre: { staffCharged: false }, subtasks: ['ReadyStaff'] },
      { name: 'Idle', pre: {}, subtasks: [] },
    ],
  },
  GetPotion: {
    name: 'GetPotion',
    methods: [
      { name: 'Carrying one', pre: { hasPotion: true }, subtasks: [] },
      { name: 'Fetch one', pre: {}, subtasks: ['FetchPotion'] },
    ],
  },
  Shelter: {
    name: 'Shelter',
    methods: [
      { name: 'No enemy', pre: { enemyDead: true }, subtasks: [] },
      { name: 'Take cover', pre: {}, subtasks: ['TakeCover'] },
    ],
  },
  Fight: {
    name: 'Fight',
    methods: [
      { name: 'Bolt now', pre: { staffCharged: true }, subtasks: ['CloseIn', 'CastBolt'] },
      { name: 'Recharge in cover', pre: {}, subtasks: ['CloseIn', 'TakeCover', 'Recharge', 'CastBolt'] },
      { name: 'Restock first', pre: {}, subtasks: ['GetCrystals', 'CloseIn', 'TakeCover', 'Recharge', 'CastBolt'] },
    ],
  },
  CloseIn: {
    name: 'CloseIn',
    methods: [
      { name: 'In range', pre: { inRange: true }, subtasks: [] },
      { name: 'Walk up', pre: {}, subtasks: ['Approach'] },
    ],
  },
  ReadyStaff: {
    name: 'ReadyStaff',
    methods: [
      { name: 'Recharge', pre: {}, subtasks: ['Recharge'] },
      { name: 'Restock and recharge', pre: {}, subtasks: ['GetCrystals', 'Recharge'] },
    ],
  },
};
export const ROOT = 'BeABattleMage';
/** Display order for the domain view. */
export const DOMAIN_ORDER = ['BeABattleMage', 'GetPotion', 'Shelter', 'Fight', 'CloseIn', 'ReadyStaff'];

const holds = (s: FactState, p: Partial<FactState>) => (Object.keys(p) as Fact[]).every((k) => s[k] === p[k]);
const failing = (s: FactState, p: Partial<FactState>) => (Object.keys(p) as Fact[]).filter((k) => s[k] !== p[k]);
export const factText = (p: Partial<FactState>) => (Object.keys(p) as Fact[]).map((k) => (p[k] ? FACT_LABEL[k] : `not ${FACT_LABEL[k]}`)).join(', ');

/** One event in a decomposition, for the step-through view. */
export type HtnEvent =
  | { k: 'expand'; task: string; depth: number }
  | { k: 'method'; task: string; method: string; index: number; ok: boolean; why: string; depth: number }
  | { k: 'prim'; task: string; ok: boolean; why: string; depth: number; state: FactState; changed: Fact[] }
  | { k: 'backtrack'; task: string; method: string; depth: number }
  | { k: 'exhausted'; task: string; depth: number };

export interface HtnResult {
  plan: GoapAction[] | null;
  /** Method index chosen at each compound task, in decomposition order. */
  mtr: number[];
  /** Method names along the way, e.g. "BeABattleMage: Fight". */
  mtrNames: string[];
  /** Tasks processed plus methods tried: the work this plan took. */
  steps: number;
  events: HtnEvent[];
}

/**
 * Decompose `root` from `start`. Depth first: the task list is processed front to back, so a
 * failing primitive later in the list backtracks into the most recent compound with methods left.
 */
export function htnPlan(start: FactState, root = ROOT, domain = DOMAIN, record = false, maxSteps = 2000): HtnResult {
  const events: HtnEvent[] = [];
  let steps = 0;
  type Frame = { tasks: Array<{ name: string; depth: number }>; state: FactState; plan: GoapAction[]; mtr: number[]; names: string[] };
  const go = (f: Frame): Frame | null => {
    if (!f.tasks.length) return f;
    if (++steps > maxSteps) return null;
    const [t, ...rest] = f.tasks;
    const prim = PRIMITIVES[t.name];
    if (prim) {
      const why = failing(f.state, prim.pre);
      if (why.length) {
        if (record) events.push({ k: 'prim', task: t.name, ok: false, why: factText(Object.fromEntries(why.map((k) => [k, prim.pre[k]]))), depth: t.depth, state: f.state, changed: [] });
        return null;
      }
      const next = { ...f.state, ...prim.eff } as FactState;
      if (record) events.push({ k: 'prim', task: t.name, ok: true, why: '', depth: t.depth, state: next, changed: FACTS.filter((k) => next[k] !== f.state[k]) });
      return go({ tasks: rest, state: next, plan: [...f.plan, prim], mtr: f.mtr, names: f.names });
    }
    const c = domain[t.name];
    if (!c) throw new Error(`unknown task ${t.name}`);
    if (record) events.push({ k: 'expand', task: t.name, depth: t.depth });
    for (let i = 0; i < c.methods.length; i++) {
      const m = c.methods[i];
      steps++;
      const why = failing(f.state, m.pre);
      if (record) events.push({ k: 'method', task: t.name, method: m.name, index: i, ok: !why.length, why: why.length ? `needs ${factText(Object.fromEntries(why.map((k) => [k, m.pre[k]])))}` : '', depth: t.depth });
      if (why.length) continue;
      const r = go({
        tasks: [...m.subtasks.map((name) => ({ name, depth: t.depth + 1 })), ...rest],
        state: f.state,
        plan: f.plan,
        mtr: [...f.mtr, i],
        names: [...f.names, `${t.name}: ${m.name}`],
      });
      if (r) return r;
      if (record) events.push({ k: 'backtrack', task: t.name, method: m.name, depth: t.depth });
    }
    if (record) events.push({ k: 'exhausted', task: t.name, depth: t.depth });
    return null;
  };
  const r = go({ tasks: [{ name: root, depth: 0 }], state: start, plan: [], mtr: [], names: [] });
  return { plan: r ? r.plan : null, mtr: r ? r.mtr : [], mtrNames: r ? r.names : [], steps, events };
}

/** True if MTR a came from strictly higher-priority methods than b (lexicographic, smaller wins). */
export function mtrBetter(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

const keyOf = (s: FactState) => FACTS.map((f) => (s[f] ? '1' : '0')).join('');

export interface HtnOptions {
  /** Replan when the facts change and switch to a higher-priority plan (true), or only when the plan breaks (false). */
  interrupt: boolean;
}

/**
 * Runs HTN plans in the arena. Steps advance when their effects hold, like the GOAP agent's.
 * There's no goal picker: the root task's method order decides what the agent is for.
 */
export class HtnBrain implements Brain {
  readonly name = 'HTN';
  cost = 0;
  costUnit = 'decomposition steps';
  current: GoapAction[] = [];
  mtr: number[] = [];
  mtrNames: string[] = [];
  stepIndex = 0;
  replans = 0;
  interrupts = 0;
  /** Interruptions that changed the root method (dropped a fight to patch up, say). */
  rootInterrupts = 0;
  lastReason = '';
  private stepTicks = 0;
  private lastKey = '';

  constructor(public opt: HtnOptions = { interrupt: true }) {}

  decide(w: World): ActionId {
    const s = factsOf(w.factors());
    const k = keyOf(s);
    const changed = k !== this.lastKey;
    this.lastKey = k;
    this.cost = 0;
    let reason = '';
    if (this.stepIndex < this.current.length) {
      const step = this.current[this.stepIndex];
      if ((holds(s, step.eff) && step.arena !== 'heal') || (step.name === 'DrinkPotion' && w.agent.completed === 'heal')) {
        this.stepIndex++;
        this.stepTicks = 0;
      }
      if (this.stepIndex >= this.current.length) reason = 'plan finished';
      else if (!holds(s, this.current[this.stepIndex].pre)) reason = `${this.current[this.stepIndex].name}: precondition failed`;
      else if (++this.stepTicks > 80) reason = `${this.current[this.stepIndex].name}: taking too long`;
    } else if (changed) reason = 'facts changed';

    if (!reason && changed && this.opt.interrupt) {
      // Something changed mid-plan: would a higher-priority method apply now?
      const r = htnPlan(s);
      this.cost += r.steps;
      if (r.plan && mtrBetter(r.mtr, this.mtr)) {
        if (r.mtr[0] !== this.mtr[0]) this.rootInterrupts++;
        this.adopt(r, `interrupted by ${r.mtrNames.find((_, i) => r.mtr[i] !== this.mtr[i]) ?? 'a higher priority'}`);
        this.interrupts++;
        reason = '';
        return this.action();
      }
    }
    if (reason) {
      const r = htnPlan(s);
      this.cost += r.steps;
      this.adopt(r, reason);
    }
    return this.action();
  }

  private adopt(r: HtnResult, reason: string): void {
    this.current = r.plan ?? [];
    this.mtr = r.mtr;
    this.mtrNames = r.mtrNames;
    this.stepIndex = 0;
    this.stepTicks = 0;
    this.replans++;
    this.lastReason = reason;
  }

  private action(): ActionId {
    const step = this.current[this.stepIndex];
    return step ? step.arena : 'patrol';
  }

  /** The root method in use ("Fight", "Patch up"), for display. */
  get purpose(): string {
    return this.mtrNames[0]?.split(': ')[1] ?? '—';
  }
}
