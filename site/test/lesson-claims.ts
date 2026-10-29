// Checks that the numbers the lessons quote are what the simulations behind their widgets produce.
//
// Each claim computes a value from the same code the widget runs, formats it the way the lesson
// writes it, and asserts that exact text is in the lesson. Change a simulation and the lessons
// that quote it fail here, with the text they should now say.
//
//   npm run check-lessons                 fast groups (about a minute), also run by `npm test`
//   npm run check-lessons -- party        one or more groups by name
//   npm run check-lessons -- --all        everything
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { World, TICK_HZ } from '../src/ai/world';
import { UtilityBrain, TreeBrain, PlannerBrain, defaultBehaviours, plan, GOALS, GOAP_ACTIONS, type Brain, type FactState } from '../src/ai/brains';
import { curve } from '../src/ai/curves';
import { HtnBrain, htnPlan } from '../src/ai/htn';
import { CourseSim, DEFAULT_SETTINGS, TIME_LIMIT, type CourseSettings } from '../src/ai/course';
import { AvoidSim, type AvoidMethod, type AvoidScene } from '../src/ai/avoid';
import { FormationSim } from '../src/ai/steer';
import { PRESETS as TACTICS_PRESETS, SIZES as TACTICS_SIZES } from '../src/tactics/world';
import { samplePoints, coverTruth } from '../src/tactics/coverTraces';
import { FRAME, frameJobs, itemCosts, parallelFor, simulate, type GraphMode, type Policy } from '../src/engine/jobsim';
import { frameWorkload, simulateWait, type Mode as WaitMode } from '../src/engine/waitsim';
import { pipeline } from '../src/engine/waiting';
import { makeProfile, profile, truth, worstFrame, nodeByName, VSYNC } from '../src/engine/profsim';
import { runGuild, readAt, staleSeconds, versionsOf, mmssOf, type VRun } from '../src/knowledge/village';
import { makeScene, threatMap, route, influence as spreadInfluence, INFLUENCE_RADIUS, WEAPON_RANGE, MOVE_SPEED, MEMORY } from '../src/influence/sim';
import { BossFight, BOSS, BOSS_DEFAULTS, SETUPS, SPELLS, summarise, TANK_THREAT, HEAL_THREAT, TAUNT_COOLDOWN, HOLD_AT, RANGED_MARGIN, MELEE_MARGIN, RATE_FLOOR, ROLE_WEIGHT, LOW_MANA, CLERIC_DISTANCE, RANGED_DISTANCE, RANGED_SPREAD, STEER_DIRECTIONS, type Summary as BossSummary } from '../src/party/sim';
import { runStages, DEFAULT_OPTIONS as RECAST_DEFAULTS } from '../src/recast/stages';
import { ReloadSim, type Scenario, type Strategy } from '../src/engine/hotreload';
import { Objs, Bvh } from '../src/engine/spatial';
import { pyramid as phPyramid, tower as phTower, crowd as phCrowd, bin as phBin, bridge as phBridge, tunnel as phTunnel } from '../src/physics/scenes';
import { level as phLevel } from '../src/physics/charViz';
import { KinematicMover, DynamicCharacter } from '../src/physics/character';
import type { Settings as PhSettings } from '../src/physics/world';
import { Box3DEngine, BulletEngine, JoltEngine, SCENES as ENGINE_SCENES, type Engine3D } from '../src/physics/engines';
import { averageLatency } from '../src/physics/asyncTick';
import { PhysicsBridge } from '../src/physics/ecsBridge';
import { runTrouble } from '../src/physics/trouble';
import { DumbTerminal, SnapshotClient, PredictedClient, LagCompensation, PeerToPeer } from '../src/net/models';
import { Player as FeelPlayer, makeLevel as feelLevel, TIGHT as FEEL_TIGHT, type Settings as FeelSettings } from '../src/feel/controller';
import { FlecsWorld } from '../src/flecs/runtime';
import initJolt from 'jolt-physics/wasm';

const here = dirname(fileURLToPath(import.meta.url));
const pages = join(here, '..', 'src', 'pages');

// ------------------------------------------------------------------------------------------
// Claims

interface Failure {
  lesson: string;
  message: string;
}
const failures: Failure[] = [];
let checked = 0;
const lessonText = new Map<string, string>();
const norm = (s: string) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ');
function text(lesson: string): string {
  let t = lessonText.get(lesson);
  if (t === undefined) {
    t = norm(readFileSync(join(pages, lesson), 'utf8'));
    lessonText.set(lesson, t);
  }
  return t;
}
/** The lesson must contain exactly this text (bold markers and line breaks ignored). */
function claim(lesson: string, expected: string): void {
  checked++;
  if (!text(lesson).includes(norm(expected))) failures.push({ lesson, message: `should say: ${expected}` });
}
/** A fact the lesson states in words, checked as a condition. */
function fact(lesson: string, ok: boolean, what: string): void {
  checked++;
  if (!ok) failures.push({ lesson, message: `no longer true: ${what}` });
}

// Number formats the lessons use.
const int = (x: number) => Math.round(x).toLocaleString('en-US');
const d1 = (x: number) => x.toFixed(1);
const d2 = (x: number) => x.toFixed(2);
const pct = (x: number) => `${Math.round(x)}%`;

// ------------------------------------------------------------------------------------------
// Groups

function ai(): void {
  const exposedBs = () => {
    const bs = defaultBehaviours();
    const b = bs.find((x) => x.id === 'potion')!;
    const i = b.considerations.findIndex((c) => c.name === 'Not under attack');
    b.considerations[i] = { name: 'Not exposed', factor: 'exposed', min: 0, max: 1, curve: curve('linear', { inv: true, lo: 0.1 }) };
    return bs;
  };
  const util = (o: Partial<{ selection: 'best' | 'weighted' | 'dual'; inertia: number; commit: number; compensate: boolean }>, bs = defaultBehaviours) => () =>
    new UtilityBrain(bs(), { selection: 'best', inertia: 0.05, commit: 0.2, compensate: true, ...o });
  const brains: Record<string, () => Brain> = {
    plain: util({ inertia: 0, commit: 0 }),
    plainExposed: util({ inertia: 0, commit: 0 }, exposedBs),
    tuned: util({}),
    stiff: util({ inertia: 0.15, commit: 0.5 }),
    nocomp: util({ compensate: false }),
    weighted: util({ selection: 'weighted' }),
    dual: util({ selection: 'dual' }),
    bt: () => new TreeBrain(),
    btMemory: () => new TreeBrain(undefined, true),
    goap: () => new PlannerBrain(),
    htn: () => new HtnBrain(),
    htnPlain: () => new HtnBrain({ interrupt: false }),
  };
  const N = 40;
  const r: Record<string, { alive: number; full: number; kills: number; sw: number; wasted: number; cost: number; max: number; replans: number; expanded: number; interrupts: number; rootInterrupts: number }> = {};
  for (const [name, make] of Object.entries(brains)) {
    let alive = 0, kills = 0, sw = 0, wasted = 0, cost = 0, dec = 0, full = 0, max = 0, replans = 0, interrupts = 0, rootInterrupts = 0;
    for (let s = 1; s <= N; s++) {
      const w = new World(1000 + s);
      const b = make();
      while (!w.dead && w.tick < 180 * TICK_HZ) {
        w.step(b.decide(w));
        cost += b.cost;
        dec++;
        max = Math.max(max, b.cost);
      }
      alive += w.seconds;
      kills += w.stats.kills;
      sw += w.stats.switches / (w.seconds / 60);
      wasted += w.stats.wasted;
      if (!w.dead) full++;
      if (b instanceof PlannerBrain || b instanceof HtnBrain) replans += b.replans;
      if (b instanceof HtnBrain) {
        interrupts += b.interrupts;
        rootInterrupts += b.rootInterrupts;
      }
    }
    r[name] = { alive: alive / N, full, kills: kills / N, sw: sw / N, wasted: wasted / N, cost: cost / dec, max, replans: replans / N, expanded: replans ? cost / replans : 0, interrupts: interrupts / N, rootInterrupts: rootInterrupts / N };
  }
  const a = (k: string) => int(r[k].alive);

  claim('ai/utility-scoring.mdx', `(${a('nocomp')} s average survival without it, ${a('tuned')} s with, over 40 fights)`);

  const cc = 'ai/choosing-and-committing.mdx';
  claim(cc, `(${a('tuned')} s average survival for highest score, ${a('weighted')} s weighted random, ${a('dual')} s dual utility`);
  claim(cc, `survives ${a('plainExposed')} seconds on average, against ${a('plain')} with the version`);
  claim(cc, `| No inertia, no commitment | ${a('plain')} s | ${int(r.plain.sw)} | ${d1(r.plain.wasted)} per fight |`);
  claim(cc, `| Inertia +0.05, commitment +0.2 | ${a('tuned')} s | ${int(r.tuned.sw)} | ${d1(r.tuned.wasted)} |`);
  claim(cc, `| Inertia +0.15, commitment +0.5 | ${a('stiff')} s | ${int(r.stiff.sw)} | ${d1(r.stiff.wasted)} |`);

  const bt = 'ai/behaviour-trees.mdx';
  claim(bt, `this tree visits about ${int(r.bt.cost)} nodes a tick on average, up to ${r.bt.max}.`);
  claim(bt, `(about ${int(r.btMemory.cost)} nodes a tick)`);
  claim(bt, `the memory version survives ${a('btMemory')} seconds on average and kills ${int(r.btMemory.kills)} enemies; the reactive version survives ${a('bt')} and kills ${int(r.bt.kills)}.`);

  const goap = 'ai/goap.mdx';
  const g = r.goap;
  claim(goap, `replans about ${int(g.replans)} times in a three-minute fight and expands ${d1(g.expanded)} states per plan`);

  const ca = 'ai/choosing-an-architecture.mdx';
  claim(ca, `| Average survival | ${a('tuned')} s | ${a('bt')} s | ${a('goap')} s | ${a('htn')} s |`);
  claim(ca, `| Lasted the full 3 minutes | ${r.tuned.full} / 40 | ${r.bt.full} / 40 | ${r.goap.full} / 40 | ${r.htn.full} / 40 |`);
  claim(ca, `| Kills per fight | ${d1(r.tuned.kills)} | ${d1(r.bt.kills)} | ${d1(r.goap.kills)} | ${d1(r.htn.kills)} |`);
  claim(ca, `| Action switches / min | ${int(r.tuned.sw)} | ${int(r.bt.sw)} | ${int(r.goap.sw)} | ${int(r.htn.sw)} |`);
  claim(ca, `| Work per tick | ${int(r.tuned.cost)} considerations | ${int(r.bt.cost)} nodes | ${d2(r.goap.cost)} states expanded | ${d2(r.htn.cost)} decomposition steps |`);

  const hl = 'ai/htn.mdx';
  const row = (label: string, f: (k: string) => string) => claim(hl, `| ${label} | ${f('goap')} | ${f('htn')} | ${f('htnPlain')} |`);
  row('Average survival', (k) => `${a(k)} s`);
  row('Lasted the full 3 minutes', (k) => `${r[k].full} / 40`);
  row('Kills per fight', (k) => d1(r[k].kills));
  row('Plans made per fight', (k) => int(r[k].replans));
  row('Work per tick', (k) => d2(r[k].cost));
  claim(hl, `about ${int(r.htn.interrupts)} interruptions a fight, but only ${int(r.htn.rootInterrupts)} of them change what it's doing`);
  fact(hl, r.htn.alive > r.htnPlain.alive, 'interruptions help survival');
}

function goap(): void {
  const L = 'ai/goap.mdx';
  // The widget's starting state: an enemy out of range, an empty staff, spare crystals.
  const start: FactState = { enemyDead: false, inRange: false, inCover: false, staffCharged: false, hasCrystals: true, hasPotion: false, potionAvailable: true, healthy: true };
  const kill = GOALS.find((g) => g.name === 'Kill the enemy')!.want;
  const heal = GOALS.find((g) => g.name === 'Get healthy')!.want;
  const names = (p: ReturnType<typeof plan>) => (p.plan ?? []).map((a) => a.name);
  const cost = (s0: FactState, seq: string[]) => {
    let s = s0, c = 0;
    for (const n of seq) {
      const a = GOAP_ACTIONS.find((x) => x.name === n)!;
      c += a.cost(s);
      s = { ...s, ...a.eff } as FactState;
    }
    return c;
  };
  const p = plan(start, kill);
  claim(L, `the plan for *Kill the enemy* is ${names(p).join(' → ')}, cost ${cost(start, names(p))}.`);
  claim(L, `(Recharge, Approach, CastBolt would cost ${cost(start, ['Recharge', 'Approach', 'CastBolt'])})`);
  const noCrystals = plan({ ...start, hasCrystals: false }, kill);
  const ratio = noCrystals.expanded.length / p.expanded.length;
  fact(L, names(noCrystals)[0] === 'GetCrystals' && ratio > 1.5 && ratio < 2.5, `without spare crystals the plan starts with GetCrystals and expands about twice as many states (now ×${d1(ratio)})`);
  const loaded = { ...start, staffCharged: true };
  fact(L, names(plan(loaded, kill)).join(',') === 'Approach,CastBolt' && cost(loaded, ['Approach', 'CastBolt']) === cost(loaded, ['Approach', 'TakeCover', 'CastBolt']), 'with a charged staff the plan is Approach → CastBolt, which costs the same as taking cover first');
  const hurt = { ...start, healthy: false };
  fact(L, names(plan(hurt, heal)).join(' → ') === 'FetchPotion → TakeCover → DrinkPotion', 'when hurt, Get healthy plans FetchPotion → TakeCover → DrinkPotion');
  fact(L, plan({ ...hurt, potionAvailable: false }, heal).plan === null, 'with no potion at the shrine there is no plan');
}

function htn(): void {
  const L = 'ai/htn.mdx';
  const start: FactState = { enemyDead: false, inRange: false, inCover: false, staffCharged: false, hasCrystals: true, hasPotion: false, potionAvailable: true, healthy: true };
  const names = (p: { plan: { name: string }[] | null }) => (p.plan ?? []).map((a) => a.name).join(' → ');
  const backs = (r: ReturnType<typeof htnPlan>) => r.events.filter((e) => e.k === 'backtrack').length;
  const d = htnPlan(start, undefined, undefined, true);
  const kill = GOALS.find((g) => g.name === 'Kill the enemy')!.want;
  claim(L, `the plan is ${names(d)}, found in ${d.steps} decomposition steps with no backtracking`);
  fact(L, names(d) === names(plan(start, kill)), 'the default HTN plan matches GOAP\'s plan for Kill the enemy');
  const nc = htnPlan({ ...start, hasCrystals: false }, undefined, undefined, true);
  claim(L, `The plan becomes ${names(nc)}, after ${backs(nc)} backtracks and ${nc.steps} steps`);
  const hurt = htnPlan({ ...start, healthy: false });
  claim(L, `*Patch up* applies: ${names(hurt)}.`);
  const none = htnPlan({ ...start, healthy: false, potionAvailable: false }, undefined, undefined, true);
  fact(L, none.mtr[0] === 1 && backs(none) > 0 && plan({ ...start, healthy: false, potionAvailable: false }, GOALS.find((g) => g.name === 'Get healthy')!.want).plan === null, 'hurt with no potion anywhere: HTN backtracks out of Patch up and fights, while GOAP has no plan for Get healthy');
  const charged = htnPlan({ ...start, staffCharged: true });
  claim(L, `and the first method of *Fight*, *Bolt now*, applies: ${names(charged)}.`);
}

function hotReload(): void {
  const L = 'engine/hot-reloading.mdx';
  const run = (sc: Scenario, st: Strategy, fix = false) => {
    const s = new ReloadSim(sc, st, fix);
    for (let i = 0; i < 360; i++) s.step(1 / 120);
    const before = s.read(0, 'x');
    s.reload();
    const after = s.read(0, 'x');
    for (let i = 0; i < 600; i++) s.step(1 / 120);
    return { s, kept: Math.abs(before - after) < 1e-3 };
  };
  const all: Strategy[] = ['restart', 'module-state', 'swap', 'patch', 'reinstance'];
  fact(L, all.every((st) => { const { s } = run('code', st); return !s.crashed && s.code.gravity > 0; }), 'every strategy gets the code-only change in');
  fact(L, !run('code', 'restart').kept && !run('code', 'module-state').kept && ['swap', 'patch', 'reinstance'].every((st) => run('code', st as Strategy).kept), 'restart and state-in-DLL reset the orbs; the others keep them');
  const radii = (s: ReloadSim) => [0, 1, 2, 3, 4, 5].map((i) => s.read(i, 'radius'));
  for (const st of ['swap', 'patch'] as Strategy[]) {
    const { s } = run('field', st);
    fact(L, !s.crashed && radii(s).some((r) => r < 0 || r > 20), `adding a field with ${st}: no crash, garbage radii`);
  }
  const ri = run('field', 'reinstance');
  fact(L, ri.kept && radii(ri.s).every((r) => r >= 5 && r <= 9), 'serialise and rebuild keeps the orbs and gives radius its default');
  fact(L, run('pointers', 'swap').s.crashed.startsWith('Access violation'), 'state with pointers crashes after a swap');
  fact(L, !run('pointers', 'swap', true).s.crashed, 're-pointing in reload() fixes the crash');
  const p = run('pointers', 'patch').s;
  fact(L, !p.crashed && p.orbName(0) === '"orbs"', 'patching keeps the old name string and does not crash');
}

function physics(): void {
  // Solving contacts: each solver configuration on the pyramid and the tower, 10 s at 60 Hz.
  const stack = (mk: () => { world: ReturnType<typeof phPyramid>['world'] }) => {
    const w = mk().world;
    const start = w.live().filter((b) => b.type === 'dynamic').map((b) => ({ ...b.xf.p }));
    let asleep = -1;
    for (let i = 0; i < 600; i++) {
      w.step(1 / 60);
      if (asleep < 0 && w.stats.sleeping === start.length) asleep = w.time;
    }
    const dyn = w.live().filter((b) => b.type === 'dynamic');
    const drift = Math.max(...dyn.map((b, i) => Math.sqrt((b.xf.p.x - start[i].x) ** 2 + (b.xf.p.y - start[i].y) ** 2)));
    return drift > 1 ? 'fell over' : `${d1(drift * 100)} cm, ${asleep < 0 ? 'never sleeps' : `asleep at ${d2(asleep)} s`}`;
  };
  const L = 'physics/solving-contacts.mdx';
  const rows: Array<[string, Partial<PhSettings>]> = [
    ['Soft step, 4 substeps', {}],
    ['Soft step, 8 substeps', { substeps: 8 }],
    ['Soft step, 1 substep', { substeps: 1 }],
    ['Soft step, 4 substeps, no warm starting', { warmStarting: false }],
    ['Baumgarte, 4 iterations', { solver: 'baumgarte', iterations: 4 }],
    ['Baumgarte, 10 iterations', { solver: 'baumgarte', iterations: 10 }],
    ['Baumgarte, 20 iterations', { solver: 'baumgarte', iterations: 20 }],
    ['Baumgarte, 10 iterations, no warm starting', { solver: 'baumgarte', iterations: 10, warmStarting: false }],
  ];
  for (const [name, set] of rows) claim(L, `| ${name} | ${stack(() => phPyramid(set))} | ${stack(() => phTower(set))} |`);

  // Broadphase: every pair against sort and sweep, 150 bodies, averaged over 2 s.
  const bp = (m: 'brute' | 'sap') => {
    const w = phCrowd({ broadphase: m, sleeping: false }, 150).world;
    let t = 0;
    let p = 0;
    for (let i = 0; i < 120; i++) {
      w.step(1 / 60);
      t += w.stats.aabbTests;
      p += w.stats.pairs;
    }
    return { tests: t / 120, pairs: p / 120 };
  };
  const brute = bp('brute');
  const sap = bp('sap');
  const B = 'physics/broadphase.mdx';
  claim(B, `testing every pair makes about ${int(brute.tests)} box tests a step; sort and sweep makes about ${int(sap.tests)}`);
  claim(B, `Both find the same ${d1(sap.pairs)} overlapping pairs a step on average`);
  fact(B, Math.abs(brute.pairs - sap.pairs) < 1e-9, 'both broadphases find the same pairs');

  // The step: the bin falls asleep.
  const binW = phBin({}, 60).world;
  let binAsleep = -1;
  for (let i = 0; i < 1200 && binAsleep < 0; i++) {
    binW.step(1 / 60);
    if (binW.stats.awake === 0) binAsleep = binW.time;
  }
  claim('physics/sleeping-and-fast-bodies.mdx', `all 60 shapes in the bin are asleep ${d1(binAsleep)} seconds after they start falling`);

  // Tunnelling outcomes.
  const T = 'physics/sleeping-and-fast-bodies.mdx';
  const shot = (c: 'none' | 'speculative' | 'sweep', speed: number) => {
    const w = phTunnel({ continuous: c }, speed).world;
    for (let i = 0; i < 60; i++) w.step(1 / 60);
    return w.live().find((b) => b.bullet)!.xf.p.x;
  };
  fact(T, shot('none', 20) < 4 && shot('none', 30) > 4.2, 'with nothing special, 20 m/s is caught and 30 m/s tunnels');
  fact(T, shot('speculative', 400) < 4 && shot('sweep', 400) < 4, 'speculative contacts and sweeps both stop 400 m/s');

  // Joints: the bridge settles with soft step and keeps fidgeting with Baumgarte.
  const J = 'physics/joints.mdx';
  const bridgeE = (set: Partial<PhSettings>) => {
    const w = phBridge(set).world;
    for (let i = 0; i < 1800; i++) w.step(1 / 60);
    return { e: w.energy(), asleep: w.stats.sleeping };
  };
  const bs = bridgeE({});
  const bb = bridgeE({ solver: 'baumgarte', iterations: 10 });
  claim(J, `after 30 seconds the soft-step bridge is asleep, while the Baumgarte bridge still has ${d1(bb.e)} J of kinetic energy`);
  fact(J, bs.asleep > 0 && bb.asleep === 0, 'soft bridge sleeps, Baumgarte bridge does not');

  // Characters: walking right, the mover climbs the stairs and stops at the steep wedge; the dynamic body stops at the first step.
  const C = 'physics/queries-and-characters.mdx';
  const lv = phLevel();
  const m = new KinematicMover(lv.world, lv.start);
  const dc = new DynamicCharacter(lv.world, { x: lv.start.x - 1, y: lv.start.y });
  for (let i = 0; i < 300; i++) {
    m.step({ x: 1, jump: false }, 1 / 60, lv.world.settings.gravity);
    dc.step({ x: 1, jump: false });
    lv.world.step(1 / 60);
  }
  fact(C, m.pos.x > 5.5 && m.pos.x < 6.2 && Math.abs(m.pos.y - 0.35) < 0.02, `mover climbs the stairs and stops at the steep wedge (now at ${d2(m.pos.x)}, ${d2(m.pos.y)})`);
  fact(C, dc.pos.x < -1.9, `dynamic body stops at the first step (now at ${d2(dc.pos.x)})`);
  // On the 25° ramp: the mover stands still when idle, the dynamic body slides down.
  const lv2 = phLevel();
  const m2 = new KinematicMover(lv2.world, { x: -6, y: 1.2 });
  const d2c = new DynamicCharacter(lv2.world, { x: -5.5, y: 0.9 });
  for (let i = 0; i < 30; i++) {
    m2.step({ x: 0, jump: false }, 1 / 60, lv2.world.settings.gravity);
    lv2.world.step(1 / 60);
  }
  const mx = m2.pos.x;
  const dx = d2c.pos.x;
  for (let i = 0; i < 120; i++) {
    m2.step({ x: 0, jump: false }, 1 / 60, lv2.world.settings.gravity);
    d2c.step({ x: 0, jump: false });
    lv2.world.step(1 / 60);
  }
  fact(C, Math.abs(m2.pos.x - mx) < 1e-6 && m2.grounded, 'the mover stands still on the ramp');
  fact(C, d2c.pos.x - dx > 0.5, 'the dynamic body slides down the ramp when idle');
}

async function ecs(): Promise<void> {
  const L = 'physics/physics-in-flecs.mdx';
  const wasm = readFileSync(join(here, '..', 'public', 'flecs.wasm'));
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () => new Response(wasm, { headers: { 'content-type': 'application/wasm' } });
  const w = await FlecsWorld.create();
  (globalThis as { fetch: unknown }).fetch = prevFetch;
  const b = new PhysicsBridge(w);
  b.init();
  const crate = b.spawn('box', 0, 2);
  const ball = b.spawn('ball', 1.5, 3);
  const handleOf = (n: string) => b.entities().find((e) => e.name === n)?.handle ?? 0;
  const h0 = handleOf(ball);
  fact(L, handleOf(crate) > 0 && h0 > 0 && b.engine.live().length === 3, 'spawning sets RigidBody, and CreateBody gives each entity a body and a BodyHandle');
  b.setRigidBody(ball, { hw: 0.4, hh: 0.4, radius: 0, dynamic: 1 });
  const h1 = handleOf(ball);
  fact(L, h1 % 65536 === h0 % 65536 && Math.floor(h1 / 65536) > Math.floor(h0 / 65536) && b.engine.get(h0) === null, 'changing RigidBody re-creates the body in the same slot with a higher generation, and the old handle is stale');
  for (let i = 0; i < 300; i++) b.progress(1 / 60);
  fact(L, b.written === 0 && b.engine.stats.sleeping === 2, 'once everything sleeps, no transforms are copied');
  b.impulse(crate, 0, 5);
  b.progress(1 / 60);
  const comps = w.entityJson(BigInt(w.lookup(crate)))?.components ?? {};
  fact(L, !('Impulse' in comps) && b.written > 0, 'an Impulse is consumed by ApplyImpulses and wakes the body');
  b.removeRigidBody(ball);
  b.progress(1 / 60);
  const bc = w.entityJson(BigInt(w.lookup(ball)))?.components ?? {};
  fact(L, !('BodyHandle' in bc) && 'Position' in bc && b.engine.live().length === 2, 'removing RigidBody removes BodyHandle and destroys the body; the entity survives');
  b.destroy(crate);
  b.progress(1 / 60);
  fact(L, b.engine.live().length === 1, 'deleting the entity destroys its body');
}

function chaos(): void {
  const L = 'physics/chaos-and-physx.mdx';
  const ms = (fps: number, hz: number, m: 'game' | 'async', i: boolean) => `${int(averageLatency(fps, hz, m, i) * 1000)} ms`;
  claim(L, `| 30 Hz | ${ms(90, 30, 'game', true)} | ${ms(90, 30, 'async', false)} | ${ms(90, 30, 'async', true)} |`);
  claim(L, `| 60 Hz | ${ms(90, 60, 'game', true)} | ${ms(90, 60, 'async', false)} | ${ms(90, 60, 'async', true)} |`);
}

async function engines(): Promise<void> {
  const L = 'physics/jolt-box3d-and-bullet.mdx';
  const b3 = new Box3DEngine(async () => readFileSync(join(here, '..', 'public', 'box3d.wasm')));
  const bt = new BulletEngine(async () => readFileSync(join(here, '..', 'public', 'bullet.wasm')));
  const jo = new JoltEngine(() => initJolt({ locateFile: () => join(here, '..', 'node_modules', 'jolt-physics', 'dist', 'jolt-physics.wasm.wasm') }));
  await b3.load();
  await bt.load();
  await jo.load();
  const out = new Float32Array(4096 * 8);
  const run = (e: Engine3D, scene: string, opts: Partial<Engine3D['options']> = {}, steps = 600, speed?: number) => {
    const saved = { ...e.options };
    Object.assign(e.options, opts);
    const sc = ENGINE_SCENES[scene]();
    if (speed) sc.bodies[2].vel = [0, 0, -speed];
    e.reset(sc);
    const s0 = new Float32Array(out.length);
    e.read(s0);
    let asleep = -1;
    for (let i = 0; i < steps; i++) {
      e.step(1 / 60);
      if (asleep < 0 && e.stats().awake === 0) asleep = (i + 1) / 60;
    }
    const n = e.read(out);
    let drift = 0;
    for (let k = 0; k < n; k++) if (sc.bodies[k].dynamic) drift = Math.max(drift, Math.hypot(out[k * 8] - s0[k * 8], out[k * 8 + 1] - s0[k * 8 + 1], out[k * 8 + 2] - s0[k * 8 + 2]));
    Object.assign(e.options, saved);
    return { drift, asleep, lastZ: out[(n - 1) * 8 + 2] };
  };
  const pj = run(jo, 'pyramid');
  const pb = run(b3, 'pyramid');
  const pt = run(bt, 'pyramid');
  claim(L, `Jolt's is asleep after ${d2(pj.asleep)} s, Box3D's after ${d2(pb.asleep)} s and Bullet's after ${d2(pt.asleep)} s`);
  fact(L, pj.drift < 0.05 && pb.drift < 0.05 && pt.drift < 0.05, 'all three hold the pyramid');
  const tb = run(b3, 'tower');
  const tt = run(bt, 'tower');
  const tj = run(jo, 'tower');
  const tj30 = run(jo, 'tower', { velocitySteps: 30 });
  const tb1 = run(b3, 'tower', { substeps: 1 });
  fact(L, tb.drift < 0.1 && tb.asleep > 0, `Box3D holds the tower of 20 with its defaults (drift ${d2(tb.drift)} m)`);
  fact(L, tt.drift < 0.3 && tt.asleep > 0, `Bullet holds the tower of 20 with its defaults (drift ${d2(tt.drift)} m)`);
  fact(L, tj.drift > 1, 'Jolt with its default 10 velocity steps lets the tower of 20 topple');
  fact(L, tj30.drift < 0.1 && tj30.asleep > 0, 'Jolt with 30 velocity steps holds the tower');
  fact(L, tb1.drift > 1, 'Box3D with 1 substep lets the tower topple');
  claim(L, `with 30 velocity steps it stands and is asleep after ${d2(tj30.asleep)} s`);
  const z = (e: Engine3D, opts: Partial<Engine3D['options']>, speed = 600) => run(e, 'fastball', opts, 60, speed).lastZ;
  const caught = (v: number) => v > -0.1;
  fact(L, caught(z(b3, {})) && !caught(z(b3, { continuous: false })), 'Box3D stops the fast ball by default and loses it with continuous collision off');
  fact(L, !caught(z(jo, {})) && caught(z(jo, { linearCast: true })), 'Jolt loses the fast ball in Discrete mode and stops it with LinearCast');
  fact(L, !caught(z(bt, {})) && caught(z(bt, { linearCast: true })), 'Bullet loses the fast ball by default and stops it with CCD');
  fact(L, !caught(z(jo, {}, 30)) && !caught(z(b3, { continuous: false }, 30)) && !caught(z(bt, {}, 30)), 'every discrete mode loses the ball even at 30 m/s');
}

function steering(): void {
  const L = 'ai/steering.mdx';
  const agg = (o: Partial<CourseSettings>) => {
    let t = 0, c = 0, at = 0, stuck = 0, turn = 0, rays = 0;
    for (const course of ['bends', 'pillars', 'deadend']) {
      const s = new CourseSim({ ...DEFAULT_SETTINGS, ...o, course }).run();
      t += s.allThroughAt >= 0 ? s.allThroughAt : TIME_LIMIT;
      stuck += 6 - s.through;
      c += s.contact;
      at += s.agentTime;
      turn += s.turn;
      rays += s.rays;
    }
    return { time: `${d1(t)} s`, stuck, contact: `${d1((100 * c) / at)}%`, wobble: `${int(((turn / at) * 180) / Math.PI)}°/s`, rays: int(rays / at) };
  };
  for (const [name, motion] of [['Point mass', 'point'], ['Turns on the spot', 'spot'], ['Car', 'car']] as const) {
    const c = agg({ motion, sense: 'context' });
    const w = agg({ motion, sense: 'whiskers' });
    claim(L, `| ${name} | ${c.time}, ${c.contact} | ${w.time}, ${w.contact} |`);
  }
  for (const [name, follow] of [['Next waypoint', 'waypoint'], ['Carrot on the path', 'carrot'], ['Straight at the goal', 'goal']] as const) {
    const s = agg({ follow });
    claim(L, `| ${name} | ${s.time} | ${s.stuck} |`);
  }
  for (const [name, sense] of [['Nothing', 'none'], ['One feeler', 'feeler'], ['Three whiskers', 'whiskers'], ['Wall query', 'query'], ['Context steering, 16 rays', 'context']] as const) {
    const s = agg({ sense });
    claim(L, `| ${name} | ${s.time} | ${s.stuck} | ${s.contact} | ${s.wobble} | ${s.rays} |`);
  }
  const cc = agg({ sense: 'context', crates: true });
  const wc = agg({ sense: 'whiskers', crates: true });
  claim(L, `Context steering still never gets stuck (${cc.time}, ${cc.contact} contact), and whiskers hold up (${wc.time}, ${wc.contact})`);
  fact(L, cc.stuck === 0, 'context steering with moving crates never gets stuck');
  const cell = (s: ReturnType<typeof agg>) => `${s.time}, ${s.stuck ? `${s.stuck} stuck, ` : ''}wobble ${s.wobble}`;
  for (const slots of [8, 12, 16, 24, 32]) claim(L, `| ${slots} | ${cell(agg({ slots, hysteresis: true }))} | ${cell(agg({ slots, hysteresis: false }))} |`);
}

function formations(): void {
  const L = 'ai/formations.mdx';
  const run = (mode: 'rigid' | 'clamp' | 'collapse', shape: 'wedge' | 'line') => new FormationSim({ mode, shape, n: 8, wait: true }).run(60).summary();
  claim(L, 'Over a minute of the loop with eight followers in a wedge');
  const wallCell = (w: number) => (w < 0.05 ? '0%' : w < 1 ? 'under 1%' : pct(w));
  for (const [name, mode] of [['Ignore it', 'rigid'], ['Clamp to free space', 'clamp'], ["Fall in on the leader's path", 'collapse']] as const) {
    const m = run(mode, 'wedge');
    claim(L, `| ${name} | ${d1(m.slotDist)} m | ${wallCell(m.wallPct)} | ${pct(m.filePct)} |`);
  }
  const lr = run('rigid', 'line'), lc = run('clamp', 'line'), lq = run('collapse', 'line');
  claim(L, `rigid slots pin followers to walls ${pct(lr.wallPct)} of the time and clamped ones ${pct(lc.wallPct)}`);
  fact(L, lq.wallPct < 1, 'in a line abreast, the queue stays under 1% wall contact');
  fact(L, run('rigid', 'wedge').wallPct > 70, 'rigid slots spend three quarters of the time against walls');
}

function coverSampling(): void {
  const L = 'ai/cover-generation.mdx';
  // The lesson's widget: the thin-gaps map at medium size, the lab's default map seed (3) and sample seed (11).
  const t = TACTICS_PRESETS.find((p) => p.id === 'thin')!.build(...TACTICS_SIZES.medium, 3);
  const truth = coverTruth(t);
  const inGaps = (algo: 'random' | 'poisson' | 'biased') => {
    const found = new Set<number>();
    for (const [x, y] of samplePoints(t, algo, 300, 11))
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const i = (y + dy) * t.w + x + dx;
          if (x + dx >= 0 && y + dy >= 0 && x + dx < t.w && y + dy < t.h && truth.has(i)) found.add(i);
        }
    let n = 0;
    for (const i of found) if (t.thin[i]) n++;
    return n;
  };
  let gaps = 0;
  for (const i of truth.keys()) if (t.thin[i]) gaps++;
  claim(L, `random and Poisson sampling find ${inGaps('random')} and ${inGaps('poisson')} of the ${gaps} cover positions inside the gaps, about a third; edge-biased finds ${inGaps('biased')}, nearly nine in ten`);
}

function avoidance(): void {
  const L = 'ai/local-avoidance.mdx';
  const run = (m: AvoidMethod, scene: AvoidScene, count = 24) => {
    const sim = new AvoidSim(m, scene, count);
    const s = sim.run();
    const notThere = sim.agents.filter((a) => !a.done).length;
    return { time: `${d1(s.allDoneAt)} s`, overlap: int(s.overlap), wobble: `${int(((s.turn / Math.max(1e-6, s.agentTime)) * 180) / Math.PI)}°/s`, notThere };
  };
  for (const [name, m] of [['None', 'none'], ['Separation', 'separation'], ['Social forces', 'social'], ['Velocity obstacles', 'vo'], ['RVO', 'rvo'], ['ORCA', 'orca']] as const) {
    const c = run(m, 'circle');
    const g = run(m, 'groups');
    const x = run(m, 'cross');
    claim(L, `| ${name} | ${c.time}, overlap ${c.overlap} | ${g.time}, overlap ${g.overlap} | ${x.time}, overlap ${x.overlap} | ${c.wobble} |`);
  }
  const jam = run('social', 'circle', 48);
  fact(L, jam.notThere === 48, `with 48 agents in the circle, social forces get nobody across (${jam.notThere} of 48 stuck)`);
}

function jobs(): void {
  const L = 'engine/jobs-and-task-graphs.mdx';
  const costs = itemCosts();
  const total = costs.reduce((a, b) => a + b, 0);
  const pf = (W: number, policy: Policy, chunk: number) => simulate(parallelFor(costs, chunk), { workers: W, policy }).makespan;
  claim(L, `With 8 workers, a perfect split would take ${int(total / 8)} µs`);
  for (const chunk of [1, 8, 64, 256]) claim(L, `| ${chunk} | ${int(pf(8, 'static', chunk))} µs | ${int(pf(8, 'queue', chunk))} µs | ${int(pf(8, 'steal', chunk))} µs |`);
  claim(L, `(${int(pf(16, 'steal', 1))} µs against the queue's ${int(pf(16, 'queue', 1))})`);
  claim(L, `finishes at ${int(pf(8, 'queue', 64))} µs`);
  claim(L, `the frame takes ${int(pf(8, 'steal', 64))} µs`);
  claim(L, `${pct(((total / 8) / pf(8, 'static', 64)) * 100)} efficiency, whatever the job size`);
  claim(L, `At 64 items per job there are only ${costs.length / 64} jobs`);
  const serial = (() => {
    const { jobs } = frameJobs(FRAME, 'serial', 1);
    return simulate(jobs, { workers: 1, policy: 'steal' }).makespan;
  })();
  for (const W of [8, 16]) {
    const run = (mode: GraphMode) => {
      const { jobs } = frameJobs(FRAME, mode, W);
      const r = simulate(jobs, { workers: W, policy: 'steal' });
      return { t: int(r.makespan), busy: pct((r.work / (r.makespan * W)) * 100) };
    };
    const b = run('barriers');
    const g = run('graph');
    const d = run('deferred');
    claim(L, `| ${W} | ${int(serial)} µs | ${b.t} µs (${b.busy}${W === 8 ? ' busy' : ''}) | ${g.t} µs (${g.busy}) | ${d.t} µs (${d.busy}) |`);
  }
}

function spatial(): void {
  const L = 'engine/spatial-partitioning.mdx';
  // Refit decay: 1,000 even objects (seed 7, as the widget), refit chosen on load, 3 s at 60 Hz.
  // Three seconds stays inside the widget's 600-frame rebuild even on a 144 Hz display.
  const o = new Objs();
  o.init(1000, 'uniform', 7);
  const b = new Bvh(true);
  const frame = () => {
    const w = { build: 0, visited: 0, tests: 0, found: 0, swaps: 0 };
    b.update(o, w);
    b.pairs(o, w);
    return w.tests;
  };
  const t0 = frame();
  const a0 = b.area();
  let t = 0;
  for (let f = 0; f < 180; f++) {
    o.step(1 / 60);
    t = frame();
  }
  claim(L, `total box area went from ${Math.round(a0)}× the world to ${Math.round(b.area())}× in three seconds, and pair tests went up ${Math.round(t / t0)}×`);
}

function waiting(): void {
  const L = 'engine/threads-pools-and-fibers.mdx';
  const flat = frameWorkload(false);
  const nested = frameWorkload(true);
  const work = (wl: ReturnType<typeof frameWorkload>) => wl.tasks.reduce((a, t) => a + t.pre + t.post, 0);
  const waiting = (wl: ReturnType<typeof frameWorkload>) => wl.tasks.filter((t) => t.children.length).length;
  claim(L, `(${waiting(flat)} waiting parties, ${int(work(flat))} µs of work, a perfect split is ${int(work(flat) / 8)} µs)`);
  claim(L, `(${waiting(nested)} jobs waiting at some point)`);
  const run = (wl: ReturnType<typeof frameWorkload>, m: WaitMode, W: number) => simulateWait(wl.tasks, wl.roots, m, W);
  const eff = (wl: ReturnType<typeof frameWorkload>, r: ReturnType<typeof run>) => pct((work(wl) / 8 / r.makespan) * 100);
  const b = run(flat, 'block', 8);
  const hp = run(flat, 'help', 8);
  const fb = run(flat, 'fiber', 8);
  const co = run(flat, 'coroutine', 8);
  const th = run(flat, 'threads', 8);
  claim(L, `| Block | ${int(b.makespan)} µs | ${eff(flat, b)} | ${int(b.overhead)} µs | none (${int(b.blocked)} µs blocked) | none |`);
  claim(L, `| Help while waiting | ${int(hp.makespan)} µs | ${eff(flat, hp)} | ${int(hp.overhead)} µs | ${int(hp.lateMax)} µs | none |`);
  claim(L, `| Fibers | ${int(fb.makespan)} µs | ${eff(flat, fb)} | ${int(fb.overhead)} µs | none | ${fb.peakContexts} fibers, ${d1((fb.peakContexts * 64) / 1024)} MiB |`);
  claim(L, `| Coroutines | ${int(co.makespan)} µs | ${eff(flat, co)} | ${int(co.overhead)} µs | none | ${co.peakContexts} frames, ${co.peakContexts} KiB |`);
  claim(L, `| A thread per job | ${int(th.makespan)} µs | ${eff(flat, th)} | ${int(th.overhead)} µs | none | ${th.peakContexts} threads, ${th.peakContexts} MiB |`);
  fact(L, b.deadlock === false && run(flat, 'block', 4).deadlock && run(flat, 'block', 4).finished === 0, 'with 4 cores blocking deadlocks before a single job finishes; with 8 it completes');
  fact(L, run(nested, 'block', 16).deadlock, 'with waits inside waits, blocking deadlocks even with 16 cores');
  const h4 = run(nested, 'help', 4);
  const h8 = run(nested, 'help', 8);
  fact(L, Math.max(h4.maxDepth, h8.maxDepth) === 5, `helping reaches five jobs deep (now ${Math.max(h4.maxDepth, h8.maxDepth)})`);
  claim(L, `up to ${int(h8.lateMax)} µs on 8 cores and ${int(h4.lateMax)} µs on 4`);
  for (const [name, l] of [['One thread does it all', 'one'], ['Game + render thread', 'two'], ['Game + render + RHI', 'three']] as const) {
    const p = pipeline(l, 10, 8, 9, 12);
    claim(L, `| ${name} | ${int(p.frameTime)} ms | ${int(1000 / p.frameTime)} fps | ${int(p.latency)} ms |`);
  }
  claim(L, `stretches to about ${int(pipeline('two', 10, 8, 12, 12).latency)} ms`);
}

function profiling(): void {
  const L = 'engine/profiling.mdx';
  const d = makeProfile();
  const F = d.frames.length;
  const id = (n: string) => nodeByName(d, n);
  const t = truth(d, 0, F);
  const w = worstFrame(d);
  const tw = truth(d, w, w + 1);
  const missed = d.frames.filter((f) => f.time > VSYNC + 1e-6).length;
  claim(L, `Its average CPU work is ${d2(t.total[id('Frame')] / F)} ms`);
  claim(L, `Yet ${missed} of ${F} frames miss vsync, and the worst takes ${d1(d.frames[w].cpu)} ms.`);
  const s1 = profile(d, 0, F, 'sample1');
  claim(L, `About ${int(s1.samples)} samples at 1 kHz`);
  const worstErr = Math.max(...d.nodes.filter((n) => !n.wait).map((n) => Math.abs(s1.total[n.id] - t.total[n.id]) / F));
  fact(L, worstErr <= 0.1, `at 1 kHz over all frames every function is within about 0.1 ms of the truth (worst now ${d2(worstErr)} ms)`);
  claim(L, `The hot path is \`AI::Think\` (${pct((100 * s1.total[id('AI::Think')]) / s1.total[id('Frame')])} of CPU time)`);
  claim(L, `\`Streaming::Decompress\` looks harmless at ${d1((100 * s1.total[id('Streaming::Decompress')]) / s1.total[id('Frame')])}%.`);
  claim(L, `Now \`Streaming::Decompress\` is ${d1(tw.total[id('Streaming::Decompress')])} ms of a ${int(d.frames[w].cpu)} ms frame.`);
  claim(L, `The worst frame at 1 kHz has only ${profile(d, w, w + 1, 'sample1').samples} samples.`);
  claim(L, `(${profile(d, w, w + 1, 'sample8').samples} samples at 8 kHz)`);
  const ins = profile(d, 0, F, 'instrument');
  claim(L, `measures ${d2(ins.total[id('Physics::Raycast')] / F)} ms against a true ${d2(t.total[id('Physics::Raycast')] / F)}, and the probes add ${d2(ins.overhead / F)} ms to every frame`);
  fact(L, t.calls[id('Physics::Raycast')] / F === 800, 'Physics::Raycast is called 800 times a frame');
  claim(L, `show the frame's ${d2(t.total[id('Render::Present (waiting for vsync)')] / F)} ms of waiting for vsync`);
  fact(L, s1.total[id('Render::Present (waiting for vsync)')] === 0, 'sampling never sees the wait for vsync');
}

function influenceMaps(): void {
  const L = 'ai/influence-maps.mdx';
  claim(L, `at some range (here ${INFLUENCE_RADIUS} m)`);
  claim(L, `within bow range (here ${WEAPON_RANGE} m)`);
  claim(L, `measured by walking distance. The map spreads`);
  claim(L, `(here ${MOVE_SPEED} m/s)`);
  claim(L, `falling off as *e*<sup>−age/${MEMORY} s</sup>`);
  const at = (age: number) => {
    const sc = makeScene(6, age);
    const th = threatMap(sc.t, sc.units);
    const walk = sc.t.kind.filter((k) => k === 0).length;
    const threatened = th.threat.filter((v) => v > 0.02).length;
    return { sc, th, share: (100 * threatened) / walk, r: (k: number) => route(sc.t, sc.start, sc.goal, th.threat, k) };
  };
  for (const [label, age] of [['just now', 0], ['10 s ago', 10], ['30 s ago', 30], ['60 s ago', 60]] as const) {
    const a = at(age);
    claim(L, `| ${label} | ${pct(a.share)} | ${int(a.th.rays)} |`);
  }
  const ten = at(10);
  const s0 = ten.r(0);
  const s2 = ten.r(2);
  const s10 = ten.r(10);
  claim(L, `| Shortest | ${int(s0.length)} m | ${int(s0.exposed)} m | ${d2(s0.danger)} |`);
  claim(L, `| Weighs threat ×2 | ${int(s2.length)} m | ${int(s2.exposed)} m | ${d2(s2.danger)} |`);
  claim(L, `| Weighs threat ×10 | ${int(s10.length)} m | ${int(s10.exposed)} m | ${d2(s10.danger)} |`);
  const words = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen'];
  claim(L, `${words[Math.round((100 * (s10.length - s0.length)) / s0.length)]} per cent further, never seen.`);
  fact(L, s10.exposed === 0, 'the ×10 route is never in sight with enemies last seen 10 s ago');
  const thirty = at(30);
  const t0 = thirty.r(0);
  const t10 = thirty.r(10);
  claim(L, `at 30 s the ×10 route walks ${int(t10.exposed)} m in *possible* sight against the shortest route's ${int(t0.exposed)} m, yet its danger is ${d2(t10.danger)} against ${d2(t0.danger)}`);
  // Straight-line influence leaks through buildings; walking distance doesn't.
  const sc = makeScene();
  const leak = (spread: 'radius' | 'flood') => {
    const b = spreadInfluence(sc.t, sc.units, 'knights', spread);
    let n = 0;
    for (let i = 0; i < b.length; i++) if (b[i] > 0) n++;
    return n;
  };
  fact(L, leak('flood') < leak('radius'), 'influence spread along the streets reaches fewer cells than straight-line influence');
}

function knowledge(): void {
  const L = 'ai/shared-knowledge.mdx';
  const mmss = mmssOf;
  const simple = runGuild('simple');
  const anywhere = runGuild('simple', true);
  const party = (r: VRun, name: string) => r.parties.findIndex((q) => q.name === name);
  const A = party(simple, 'A');
  const B = party(simple, 'B');
  // The opening board and claims.
  const opening = simple.log.filter((e) => e.time === 0);
  const [troll0, farms0] = ['quest:troll', 'quest:farms'].map((k) => opening.find((e) => e.key === k)!);
  claim(L, `the board holds two quests: **${troll0.text}**, for parties of level ${troll0.quest!.level} and up, and **${farms0.text}**.`);
  fact(L, opening.some((e) => e.key === 'claim:farms' && e.by === 'A') && opening.some((e) => e.key === 'claim:troll' && e.by === 'B') && simple.parties[A].level < troll0.quest!.level, 'A claims the goblins (too weak for the troll), B claims the troll');
  // The troll moves; A reports it; the clerk moves the notice.
  const firstMove = simple.steps.findIndex((s) => { const m = s.monsters.find((x) => x.id === 'troll')!; return m.x !== 94 || m.y !== 6; }) - 1;
  claim(L, `From ${mmss(firstMove)} the troll wanders south along the east bank.`);
  const aPosts = simple.steps.map((s, t) => ({ s, t })).filter(({ s }) => s.traffic.posted[A] > 0 && s.parties[A].at === 'the south ford');
  const trollSeen = simple.log.find((e) => e.key === 'sighting:troll')!;
  const moved = versionsOf(simple, 'quest:troll')[1];
  claim(L, `At ${mmss(aPosts[0].t)} A reaches the south ford waystone and posts the goblins it has spotted. At ${mmss(trollSeen.time)} one of its adventurers sees the troll`);
  claim(L, `the clerk moves the notice: **${moved.text}**.`);
  fact(L, trollSeen.by === 'A' && moved.time === trollSeen.time, 'the clerk moves the notice the second A posts the troll');
  // B reads it late.
  const rd = readAt(simple, 'B', moved.version);
  const bLeft = simple.steps.findIndex((s) => !s.parties[B].at);
  fact(L, simple.steps.slice(bLeft, rd).every((s) => !s.parties[B].at), 'B passes no waystone between the guild hall and the old bridge');
  claim(L, `At ${mmss(rd)} B reaches the old bridge waystone, reads the board`);
  fact(L, simple.steps[rd].parties[B].at === 'the old bridge' && simple.steps[rd].traffic.questChanged[B], 'B reads the moved notice at the old bridge');
  claim(L, `Party B spends **${staleSeconds(simple, 'B', 'troll')} s** heading for a notice the guild had already moved.`);
  const anyMoved = versionsOf(anywhere, 'quest:troll')[1];
  claim(L, `the same story takes **${staleSeconds(anywhere, 'B', 'troll')} s**: B reads the new notice at ${mmss(readAt(anywhere, 'B', anyMoved.version))}`);
  // The end of the troll quest.
  const slain = simple.log.find((e) => e.kind === 'report' && e.done === 'troll')!;
  const withdrawn = versionsOf(simple, 'quest:troll')[2];
  claim(L, `B slays the troll at ${mmss(slain.time)}, but the board doesn't hear until B reaches the south ford at ${mmss(withdrawn.time)}`);
  fact(L, !withdrawn.quest!.open && simple.steps[withdrawn.time].parties[B].at === 'the south ford' && simple.log.some((e) => e.version < withdrawn.version && e.done === 'troll' && e.time < withdrawn.time), 'the clerk withdraws the troll quest when B posts at the ford');
  // Stale sightings.
  const before = rd - 1;
  const newest = (r: VRun) => Math.max(...r.steps[before].parties[B].rows.filter((x) => x.key === 'quest:troll' || x.key === 'sighting:troll').map((x) => x.time));
  claim(L, `At ${mmss(before)}, a second before B reads the board, the newest thing it knows about the troll is the notice from ${mmss(newest(simple))}: **${before - newest(simple)} s old**. Reading anywhere, the same knowledge is **${before - newest(anywhere)} s old**: A's sighting from ${mmss(newest(anywhere))}.`);
  // Watermarks and history.
  const st = simple.steps[before];
  const wm = st.parties[B].watermark;
  fact(L, simple.steps[bLeft].parties[B].watermark === wm, 'B’s watermark stops when it leaves the guild hall');
  claim(L, `B's watermark stays at **v${wm}** after it leaves the guild hall. At ${mmss(before)} the log is at **v${st.head}**, so B is **${st.head - wm} versions behind**, and one of those ${st.head - wm} is the moved notice. At ${mmss(rd)} it reads **${simple.steps[rd].traffic.caughtUp[B]} versions** in one go`);
  claim(L, `At ${mmss(before)} the log keeps **${st.kept} records**: all of them, because B still reads as of v${wm}. A second later it keeps **${simple.steps[rd].kept}**.`);
  fact(L, st.kept === st.head && simple.steps[rd].kept === st.head - 1 && simple.steps[rd].head === st.head, 'the log drops exactly one record (v1, the old notice) when B catches up');
  // Merge by when it was true.
  const heldAt = simple.steps.findIndex((s) => s.traffic.older[A] > 0);
  const aLate = simple.steps[heldAt - 1].parties[A];
  // When A's adventurers last saw the troll: the sighting A carries and can't post.
  const aSighting = Math.max(...simple.steps[heldAt].adventurers.map((a, i) => (a.party === A ? simple.steps[heldAt].boards[i].find((e) => e.key === 'sighting:troll')?.time ?? -1 : -1)));
  claim(L, `At ${mmss(heldAt)} A reaches the crossroads carrying a sighting of the troll from ${mmss(aSighting)}. The board already says B slew it at ${mmss(slain.time)}`);
  fact(L, simple.steps[heldAt].parties[A].at === 'the crossroads' && aSighting < slain.time && aLate.waiting === 0, 'A’s older troll sighting is held back at the crossroads');
  // The big version.
  const full = runGuild('full');
  const fl = (k: string, by?: string) => full.log.find((e) => e.key === k && (!by || e.by === by))!;
  const fMoved = versionsOf(full, 'quest:troll')[1];
  claim(L, `D reaches the hall at ${mmss(fl('claim:woods', 'D').time)} and claims the goblins in the north woods. When the clerk moves the troll notice at ${mmss(fMoved.time)}, it also posts **${fl('quest:warn').text}**, and C claims it the same second`);
  fact(L, fl('claim:warn', 'C').time === fMoved.time && full.steps[fMoved.time].parties[party(full, 'C')].at === 'the guild hall', 'C claims the new quest at the guild hall the second it is posted');
  const fRd = readAt(full, 'B', fMoved.version);
  claim(L, `B passes the north road waystone at ${mmss(fRd)}, so it spends **${staleSeconds(full, 'B', 'troll')} s** on the old notice instead of ${staleSeconds(simple, 'B', 'troll')}.`);
  fact(L, full.steps[fRd].parties[party(full, 'B')].at === 'the north road', 'B reads the moved notice at the north road waystone');
  // Cap the history.
  const capped = runGuild('full', false, 20);
  const snapAt = capped.steps.findIndex((x) => x.snapshots > 0);
  claim(L, `B's watermark falls more than 20 seconds behind at ${mmss(snapAt)}, and it gets a ${capped.steps[snapAt].snapshots}-record snapshot.`);
  const t95 = 95;
  claim(L, `At ${mmss(t95)} the log keeps **${capped.steps[t95].kept} records plus a ${capped.steps[t95].snapshots}-record snapshot**, against **${full.steps[t95].kept}** without the cap. That's more, not less.`);
  fact(L, capped.steps[t95].kept + capped.steps[t95].snapshots > full.steps[t95].kept, 'with this small log the snapshot costs more than the history it replaces');
  const FB = party(full, 'B');
  fact(L, capped.steps.every((s, t) => JSON.stringify(s.parties[FB].rows) === JSON.stringify(full.steps[t].parties[FB].rows)), 'the cap changes memory only, not party B’s board');
}
function party(): void {
  const L = 'ai/party-roles.mdx';
  const N = 20;
  claim(L, `Over the same ${N} fights`);
  // The warchief's rules and the party's constants, as the lesson states them.
  claim(L, `a cone in front of it, telegraphed for ${BOSS.cleaveWarn} s`);
  claim(L, `a circle under a random party member other than the tank, telegraphed for ${BOSS.slamWarn} s`);
  claim(L, `1 for most, ${TANK_THREAT} for the tank`);
  fact(L, HEAL_THREAT === 0.5, 'healing adds half a point of threat per point healed');
  fact(L, MELEE_MARGIN === 1.1 && RANGED_MARGIN === 1.3, 'the pull rule is 110% in melee range, 130% at range');
  claim(L, `Here it has an ${TAUNT_COOLDOWN} s cooldown`);
  claim(L, `Stop at ${Math.round(HOLD_AT * 100)}% of what would pull the boss`);
  claim(L, `they hold back at ${Math.round(HOLD_AT * 100)}% of what would pull the boss, and without a margin that's ${Math.round(HOLD_AT * 100)}% of the tank's threat rather than up to ${Math.round(HOLD_AT * RANGED_MARGIN * 100)}%`);
  claim(L, `It has a floor of ${RATE_FLOOR} damage per second`);
  claim(L, `puts the tank first (×${ROLE_WEIGHT.tank}) and the cleric itself next (×${ROLE_WEIGHT.healer})`);
  claim(L, `below ${Math.round(LOW_MANA * 100)}% mana the quick heal is hardly considered`);
  const per = (s: keyof typeof SPELLS) => SPELLS[s].heal / SPELLS[s].mana;
  fact(L, per('greater') / per('flash') > 1.7 && per('greater') / per('flash') < 2, `the quick heal costs nearly twice the mana per point (now ${d2(per('greater') / per('flash'))}×)`);
  claim(L, `a 2.5 s heal on someone`);
  fact(L, SPELLS.greater.cast === 2.5, 'the big heal takes 2.5 s');
  claim(L, `stand on the party's side, ${CLERIC_DISTANCE} to ${RANGED_DISTANCE} m out, spread so that one ${BOSS.slamRadius} m slam can't catch two of them`);
  {
    // The three spots on the party's side, pairwise further apart than a slam's radius.
    const spots = [[CLERIC_DISTANCE, 0], [RANGED_DISTANCE, -RANGED_SPREAD], [RANGED_DISTANCE, RANGED_SPREAD]].map(([r, a]) => [r * Math.cos(a), r * Math.sin(a)]);
    let min = Infinity;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) min = Math.min(min, Math.hypot(spots[i][0] - spots[j][0], spots[i][1] - spots[j][1]));
    fact(L, min > BOSS.slamRadius, `the ranged spots are more than a slam's radius apart (closest ${d1(min)} m)`);
  }
  claim(L, `context steering](/ai/steering/): ${STEER_DIRECTIONS} directions`);
  // The comparison table: everything on, then one thing naive at a time.
  const rows = new Map<string, BossSummary>();
  for (const [name, over] of SETUPS) {
    const r = summarise(over, N);
    rows.set(name, r);
    claim(L, `| ${name} | ${r.wins} | ${int(r.time)} s | ${r.deaths.tank}, ${r.deaths.healer}, ${r.deaths.damage} | ${d1(r.offTank)} s |`);
  }
  const base = rows.get('Everything on')!;
  const top = rows.get('Top threat, no margin')!;
  const low = rows.get('Heal the lowest %')!;
  const nuke = rows.get('Damage at full speed')!;
  const still = rows.get('Nobody dodges')!;
  fact(L, base.wins === N && base.deaths.tank + base.deaths.healer + base.deaths.damage === 0, 'with everything on, the party wins every fight without a death');
  // Nearest: the knight behind the boss.
  let knight = 0;
  for (let seed = 1; seed <= N; seed++) {
    const f = new BossFight({ ...BOSS_DEFAULTS, targeting: 'nearest', seed });
    f.run();
    if (!f.members.find((m) => m.name === 'Knight')!.alive) knight++;
  }
  claim(L, `the knight standing behind the boss is nearest, and it dies in ${knight} of the ${N} fights`);
  claim(L, `Target switches rise from ${d1(base.switches)} to ${d1(top.switches)} a fight, and the fight takes ${int(top.time)} s instead of ${int(base.time)}`);
  const pingpong = summarise({ dps: 'nuke', targeting: 'top' }, N);
  claim(L, `**${d1(pingpong.switches)}** target switches a fight and only ${pingpong.wins} wins`);
  // The cleric.
  const healRow = (name: string, r: BossSummary) => `| ${name} | ${r.wins} | ${r.deaths.tank}, ${r.deaths.healer}, ${r.deaths.damage} | ${pct((100 * r.overheal) / r.healed)} | ${int(r.manaLeft)} |`;
  claim(L, healRow('Lowest %', low));
  claim(L, healRow('Triage', base));
  // Damage dealers.
  claim(L, `It's slightly faster (${int(nuke.time)} s) and wins ${nuke.wins} of ${N}, but the cleric dies in ${nuke.deaths.healer} of ${N} fights and the tank in ${nuke.deaths.tank}`);
  fact(L, nuke.time < base.time, 'full speed is faster than careful');
  // Telegraphs.
  claim(L, `telegraphs catch someone ${d1(still.caught)} times a fight against ${d1(base.caught)}, and the party wins ${still.wins} fights out of ${N}`);
}

async function recast(): Promise<void> {
  const L = 'ai/navmesh-inside-recast.mdx';
  const s = await runStages(RECAST_DEFAULTS);
  claim(L, `(${int(s.counts.rawVerts)} vertices for this scene)`);
  claim(L, `(${int(s.counts.simpleVerts)} vertices at 1.3 cells)`);
  claim(L, `(${s.counts.polys} here)`);
}

// When physics goes wrong: each mistake and its fix, over six seconds.
function trouble(): void {
  const L = 'physics/when-physics-goes-wrong.mdx';
  const cm = (x: number) => (x * 100).toFixed(1);
  const crushBad = runTrouble('crush', false);
  const crushFix = runTrouble('crush', true);
  claim(L, `the box is pushed ${cm(crushBad)} cm into the ground or the block`);
  claim(L, `it sinks ${cm(crushFix)} cm`);
  const crush8 = runTrouble('crush', false, 6, { substeps: 8 });
  fact(L, crush8 > crushBad * 0.8, `more substeps barely help the crush (8 substeps: ${cm(crush8)} cm)`);
  claim(L, `The chain stretches by up to ${d2(runTrouble('chain', false))} m`);
  fact(L, runTrouble('chain', false) > 4.4 / 4, 'the chain stretches over a quarter of its length');
  fact(L, runTrouble('chain', true) < 0.002, 'with the rope the chain stays within 2 mm');
  claim(L, `fast enough to throw them up to ${d1(runTrouble('spawn', false))} m/s`);
  claim(L, `the fastest box only reaches ${d1(runTrouble('spawn', true))} m/s`);
  claim(L, `The crate on top slides up to ${d2(runTrouble('platform', false))} m from the centre`);
  fact(L, runTrouble('platform', false) > 1.8, 'the crate falls off the 3 m platform');
  claim(L, `it drifts only about ${d1(runTrouble('platform', true))} m`);
}

// Networking: every number the lessons quote, from the same models the widgets run.
function network(): void {
  const run = <T extends { step(): void }>(m: T, secs = 60): T => {
    for (let i = 0; i < secs * 60; i++) m.step();
    return m;
  };
  const pct = (a: number, b: number) => ((100 * a) / Math.max(1, b)).toFixed(1);
  // 1. The problem
  const P = 'network/the-problem.mdx';
  for (const lat of [20, 50, 100, 200]) {
    const m = run(new DumbTerminal({ link: { latency: lat, jitter: 5, loss: 0 }, bots: 2, seed: 1 }));
    claim(P, `| ${lat} ms | ${Math.round(m.averageDelay)} ms |`);
  }
  const jit = run(new DumbTerminal({ link: { latency: 50, jitter: 30, loss: 0 }, bots: 2, seed: 1 }));
  claim(P, `${pct(jit.framesNoNew, jit.frames)}% of frames have nothing new to draw, and ${pct(jit.framesSkipped, jit.frames)}% skip over a state`);
  const l5 = run(new DumbTerminal({ link: { latency: 50, jitter: 5, loss: 0.05 }, bots: 2, seed: 1 }));
  fact(P, Math.round((100 * l5.framesNoNew) / l5.frames) === 5, 'with 5% loss about 5% of frames have nothing new');
  const l20 = run(new DumbTerminal({ link: { latency: 50, jitter: 5, loss: 0.2 }, bots: 2, seed: 1 }));
  claim(P, `With 20%, it's ${pct(l20.framesNoNew, l20.frames)}%, and the longest freeze grows to ${Math.round(l20.longestGap)} ms`);

  // 2. Snapshots
  const S = 'network/snapshots-and-interpolation.mdx';
  const snap = (rate: number, mode: 'latest' | 'interpolate' | 'extrapolate', poor = false) =>
    run(new SnapshotClient({ link: poor ? { latency: 100, jitter: 40, loss: 0.05 } : { latency: 50, jitter: 10, loss: 0.02 }, rate, mode, delay: 2000 / rate, bots: 12, seed: 1 }));
  const cell = (m: SnapshotClient) => {
    const j = Math.round(m.jumps / 12);
    return `${m.averageError.toFixed(2)} m off, ${j ? `${j} jumps/min` : '0 jumps'}`;
  };
  for (const rate of [10, 20, 60]) {
    const a = snap(rate, 'latest');
    const b = snap(rate, 'interpolate');
    const c = snap(rate, 'extrapolate');
    claim(S, `| ${rate} | ${cell(a)} | ${cell(b)} | ${cell(c)} |`);
    const kb = (x: number) => `${(x / 1000).toFixed(1)} kB/s`;
    const bw = a.bytesPerSecond;
    claim(S, `| ${rate} | ${kb(bw.full)} | ${kb(bw.quantised)} | ${kb(bw.delta)} |`);
  }
  claim(S, `every player visibly jumps about ${Math.round(snap(20, 'latest').jumps / 12)} times a minute`);
  claim(S, `the client is out of snapshots on ${snap(20, 'interpolate', true).late} frames a minute; at 60 a second with a 33 ms delay, on ${snap(60, 'interpolate', true).late}`);

  // 3. Prediction
  const R = 'network/prediction-and-reconciliation.mdx';
  const pred = (mode: 'wait' | 'predict' | 'reconcile' | 'smooth', lat = 100, alone = false) => run(new PredictedClient({ link: { latency: lat, jitter: 10, loss: 0.02 }, mode, seed: 1, alone }));
  const w = pred('wait');
  const pr = pred('predict');
  const rc = pred('reconcile');
  const sm = pred('smooth');
  const cm = (x: number) => `${Math.round(x * 100)} cm`;
  claim(R, `| Wait for the server | ${Math.round(w.averageDelay)} ms | none | ${cm(w.biggestJump)} |`);
  claim(R, `| Predict | 0 ms | none, and ${pr.averageDrift.toFixed(2)} m adrift | none |`);
  claim(R, `| Predict and reconcile | 0 ms | ${rc.corrections} | ${cm(rc.biggestJump)} |`);
  claim(R, `| Reconcile, smoothed | 0 ms | ${sm.corrections} | ${cm(sm.biggestJump)} |`);
  fact(R, pr.averageDelay === 0 && pr.corrections === 0 && pr.biggestJump <= 0.001, 'prediction alone: no delay, no corrections, no jumps');
  claim(R, `At 100 ms latency a turn takes ${Math.round(w.averageDelay)} ms to show`);
  claim(R, `by ${pr.averageDrift.toFixed(2)} m on average over a minute`);
  // Walking straight into the guard for two seconds, with nobody else about.
  const guardWalk = (predictPlayers: boolean) => {
    const m = new PredictedClient({ link: { latency: 100, jitter: 10, loss: 0.02 }, mode: 'reconcile', seed: 1, predictPlayers, noPusher: true });
    m.input = (t) => (t < 120 ? { mx: 1, my: 0, fire: false } : { mx: 0, my: 0, fire: false });
    let deepest = 0;
    for (let i = 0; i < 300; i++) {
      m.step();
      deepest = Math.max(deepest, m.me.x - (10 - 0.8));
    }
    return { deepest, corrections: m.corrections, biggestJump: m.biggestJump };
  };
  const gw = guardWalk(false);
  claim(R, `you stay about a round trip's walk inside him: ${(gw.deepest).toFixed(2)} m at 100 ms`);
  fact(R, gw.biggestJump < 0.1, 'walking into the guard: no single big snap, it slides');
  fact(R, guardWalk(true).corrections === 0, 'predicting other players: walking into the guard causes no corrections');
  fact(R, pred('reconcile', 100, true).corrections === 0, '2% loss alone causes no corrections');

  // 4. Lag compensation
  const C = 'network/lag-compensation.mdx';
  const lag = (lat: number, rewind: boolean, maxRewind = 1000) => run(new LagCompensation({ link: { latency: lat, jitter: 5, loss: 0 }, delay: 100, rewind, maxRewind, seed: 1 }));
  const rate = (m: LagCompensation) => Math.round(100 * m.hitRate);
  fact(C, [25, 75, 150].every((l) => rate(lag(l, false)) === 0), 'without rewinding, 0% hit at 25, 75 and 150 ms');
  fact(C, [25, 75, 150].every((l) => rate(lag(l, true)) === 100), 'with rewinding, 100% hit at every latency');
  const far = lag(150, true);
  const hits = far.results.filter((r) => r.hit).length;
  claim(C, `${far.results.filter((r) => r.hit && r.inCover).length} of ${hits} hits are on a target`);
  fact(C, rate(lag(150, true, 250)) === 0, 'a 250 ms cap at 150 ms latency: every shot misses');
  fact(C, rate(lag(75, true, 250)) === 100 && rate(lag(75, true, 100)) === 0, 'at 75 ms, every shot lands with a 250 ms cap and none with 100 ms');

  // 5. Lockstep and rollback
  const L = 'network/lockstep-and-rollback.mdx';
  const p2p = (mode: 'lockstep' | 'rollback', lat: number, d: number, desync = false, secs = 60) => run(new PeerToPeer({ link: { latency: lat, jitter: 5, loss: 0.01 }, mode, inputDelay: d, maxRollback: 8, desync, seed: 1 }), secs);
  for (const d of [0, 1, 2, 4]) {
    const m = p2p('lockstep', 50, d);
    claim(L, `| ${d} frame${d === 1 ? '' : 's'} | ${Math.round((100 * m.a.stalls) / m.tick)}% | ${Math.round(m.a.frame / 60)} |`);
  }
  const rb = p2p('rollback', 50, 0);
  claim(L, `peer A rolls back ${(rb.a.rollbacks / 60).toFixed(1)} times a second (each time B changes what it's pressing), re-simulating ${(rb.a.rolledFrames / rb.a.rollbacks).toFixed(0)} frames on average, at most ${rb.a.deepest}`);
  const rb2 = p2p('rollback', 50, 2);
  claim(L, `With 2 frames of delay, rollbacks average ${(rb2.a.rolledFrames / rb2.a.rollbacks).toFixed(0)} frames`);
  fact(L, p2p('rollback', 50, 4).a.rollbacks < 30, 'with 4 frames of delay, rollbacks are almost gone');
  // Both peers agree with each other, and with the game run with no network at all.
  const n = Math.min(rb.a.confirmedRemote, rb.b.confirmedRemote);
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  fact(L, same(rb.a.states[n]?.players, rb.b.states[n]?.players) && same(rb.truthAt(n).players, rb.a.states[n]?.players), 'rollback peers end in the same state as a network-free run');
  const ds = p2p('rollback', 50, 0, true, 10);
  claim(L, `differ at the first check, frame ${Math.max(ds.a.desyncAt, ds.b.desyncAt)}`);
}

// The feel lab: the controller does what its concept cards say.
function feel(): void {
  const F = 'feel lab';
  const L = feelLevel();
  const K = (left = false, right = false, jump = false) => ({ left, right, jump });
  // A held jump reaches the height you set (no apex hang, no cut).
  const plain = { ...FEEL_TIGHT, apexHang: 1, jumpCut: 1 };
  const p = new FeelPlayer(L, plain);
  for (let i = 0; i < 5; i++) p.step(K());
  const y0 = p.y;
  let top = y0;
  for (let i = 0; i < 90; i++) {
    p.step(K(false, false, true));
    top = Math.min(top, p.y);
  }
  fact(F, Math.abs(y0 - top - plain.jumpHeight) < 0.02, `a held jump reaches the set height (${(y0 - top).toFixed(3)} of ${plain.jumpHeight})`);
  // Coyote time: a jump pressed 3 ticks after running off the gap's edge.
  const coyote = (s: FeelSettings) => {
    const q = new FeelPlayer(L, s);
    q.teleport(12, 15);
    let left = -1;
    const out: string[] = [];
    for (let i = 0; i < 200; i++) {
      const e = q.step(K(false, true, left >= 0 && i === left + 3));
      if (left < 0 && !q.grounded && i > 5) left = i;
      if (e.jumped) out.push(e.jumped);
      if (e.eaten) out.push('eaten');
    }
    return out.join(',');
  };
  fact(F, coyote(FEEL_TIGHT) === 'coyote' && coyote({ ...FEEL_TIGHT, coyoteTime: 0 }) === 'eaten', 'coyote time saves a late jump; without it the press is eaten');
  // Jump buffer: a press 4 ticks before landing.
  const buffer = (s: FeelSettings) => {
    const probe = new FeelPlayer(L, s);
    probe.teleport(33.5, 10);
    let land = -1;
    for (let i = 0; i < 200 && land < 0; i++) if (probe.step(K()).landed !== undefined) land = i;
    const q = new FeelPlayer(L, s);
    q.teleport(33.5, 10);
    const out: string[] = [];
    for (let i = 0; i < 200; i++) {
      const e = q.step(K(false, false, i === land - 4));
      if (e.jumped) out.push(e.jumped);
      if (e.eaten) out.push('eaten');
    }
    return out.join(',');
  };
  fact(F, buffer(FEEL_TIGHT) === 'buffered' && buffer({ ...FEEL_TIGHT, jumpBuffer: 0 }) === 'eaten', 'the buffer turns an early press into a jump; without it the press is eaten');
  // Corner correction: from just under the low ledge's left edge, holding right.
  const corner = (s: FeelSettings) => {
    const q = new FeelPlayer(L, s);
    q.teleport(26.8, 15);
    for (let i = 0; i < 5; i++) q.step(K());
    let on = false;
    for (let i = 0; i < 90; i++) {
      q.step(K(false, i > 2, i < 30));
      if (q.grounded && Math.abs(q.y - 12) < 0.01) on = true;
    }
    return on;
  };
  fact(F, corner(FEEL_TIGHT) && !corner({ ...FEEL_TIGHT, cornerCorrection: 0 }), 'corner correction gets you onto the low ledge; without it the jump dies');
}

const GROUPS: Record<string, () => void | Promise<void>> = { ai, goap, htn, hotreload: hotReload, physics, engines, chaos, ecs, trouble, network, feel, steering, formations, cover: coverSampling, avoidance, jobs, spatial, waiting, profiling, influence: influenceMaps, knowledge, party, recast };
const FAST = ['ai', 'goap', 'htn', 'hotreload', 'physics', 'engines', 'chaos', 'ecs', 'trouble', 'network', 'feel', 'steering', 'formations', 'cover', 'avoidance', 'jobs', 'spatial', 'waiting', 'profiling', 'influence', 'knowledge', 'party', 'recast'];
const args = process.argv.slice(2);
const chosen = args.includes('--all') ? Object.keys(GROUPS) : args.filter((a) => !a.startsWith('-')).length ? args.filter((a) => !a.startsWith('-')) : FAST;
for (const name of chosen) {
  if (!GROUPS[name]) {
    console.error(`unknown group "${name}"; groups: ${Object.keys(GROUPS).join(', ')}`);
    process.exit(2);
  }
  const before = failures.length;
  const t0 = performance.now();
  await GROUPS[name]();
  const bad = failures.length - before;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${name.padEnd(11)} ${((performance.now() - t0) / 1000).toFixed(1)} s${bad ? `, ${bad} claim${bad > 1 ? 's' : ''} out of date` : ''}`);
}
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`${f.lesson}: ${f.message}`);
  console.log(`\n${failures.length} of ${checked} lesson claims no longer match their simulations.`);
  process.exit(1);
}
console.log(`\nAll ${checked} lesson claims match their simulations.`);
