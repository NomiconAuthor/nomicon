// Checks that the numbers the lessons and the three labs quote are what the simulations behind their widgets produce.
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
import { PRESETS as TACTICS_PRESETS, SIZES as TACTICS_SIZES, KINDS as TACTICS_KINDS, LOW as T_LOW, BUILDING as T_BUILDING, RAVINE as T_RAVINE, EYE as T_EYE, STANDING as T_STANDING, CROUCHED as T_CROUCHED, los as tacticsLos, makeWorld as makeTacticsWorld } from '../src/tactics/world';
import { samplePoints, coverTruth, WalkTrace } from '../src/tactics/coverTraces';
import { ChokeTrace } from '../src/tactics/chokeTrace';
import { exposureKnown, probeOpenness } from '../src/tactics/analysis';
import { CONCEPTS as TACTICS_CONCEPTS } from '../src/tactics/concepts';
import { CONCEPTS as PATH_CONCEPTS } from '../src/lab/learn/concepts';
import { GridSpace } from '../src/lab/graph/gridSpace';
import { computeClearance, computeComponents } from '../src/lab/world/clearance';
import { makeLayer as makeLabLayer } from '../src/lab/world/world';
import { presetById as labPreset } from '../src/lab/world/presets';
import { makeRng as makeLabRng } from '../src/lab/core/rng';
import { Recorder, type SearchOptions } from '../src/lab/search/types';
import type { HeuristicId } from '../src/lab/search/heuristics';
import { bestFirst } from '../src/lab/search/bestFirst';
import { jumpPointSearch } from '../src/lab/search/jps';
import { thetaStar } from '../src/lab/search/theta';
import { measurePath, shortcut } from '../src/lab/post/smooth';
import { HpaGraph } from '../src/lab/rep/hpaGraph';
import { hpaQuery } from '../src/lab/rep/hpaPlanner';
import { RoadmapPlanner } from '../src/lab/rep/roadmapPlanner';
import { dubinsAll, reedsSheppAll, cusps } from '../src/lab/vehicle/curves';
import { FootprintChecker, VEHICLES, distanceField as vehicleDistance, holonomicField, innerDisc, vehicleById } from '../src/lab/vehicle/geometry';
import { LATTICE_ANGLES, hybridAStar, latticeAStar, latticeTable, measurePoses } from '../src/lab/vehicle/search';
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
import { Player as FeelPlayer, Camera as FeelCamera, makeLevel as feelLevel, jumpPhysics as feelJumpPhysics, landingTrauma, DT as FEEL_DT, PRESETS as FEEL_PRESETS, TIGHT as FEEL_TIGHT, type Settings as FeelSettings } from '../src/feel/controller';
import { CONCEPTS as feelConcepts } from '../src/feel/concepts';
import { SLIDERS as FEEL_SLIDERS, VIEW_W as FEEL_VIEW_W, VIEW_H as FEEL_VIEW_H } from '../src/feel/app';
import { FlecsWorld } from '../src/flecs/runtime';
import { FRAME_SCENARIOS } from '../src/flecs/frame/scenarios';
import { defaultConfig, record as recordFrame, type Recording as FrameRecording } from '../src/flecs/frame/record';
import { timeline as frameTimeline, type Timeline as FrameTimeline } from '../src/flecs/frame/model';
import initJolt from 'jolt-physics/wasm';
import { affineError as rdAffineError, coverage as rdCoverage, lengthText as rdLength, overdraw as rdOverdraw, pipelineRun as rdPipelineRun, pipelineScene as rdPipelineScene, rasterPoints as rdRasterPoints, resolution as rdResolution, zFight as rdZFight, DEPTH_FAR as RD_DEPTH_FAR } from '../src/render/scenes';

const here = dirname(fileURLToPath(import.meta.url));
const pages = join(here, '..', 'src', 'pages');
const src = join(here, '..', 'src');

// ------------------------------------------------------------------------------------------
// Claims

interface Failure {
  lesson: string;
  message: string;
}
const failures: Failure[] = [];
let checked = 0;
const lessonText = new Map<string, string>();
const norm = (s: string) => s.replace(/\*\*/g, '').replace(/\\(['"])/g, '$1').replace(/\s+/g, ' ');
/** A lesson's MDX under src/pages, or (for the labs) a .ts source file under src, whose strings are the text the lab shows. */
function text(lesson: string): string {
  let t = lessonText.get(lesson);
  if (t === undefined) {
    t = norm(readFileSync(lesson.endsWith('.ts') ? join(src, lesson) : join(pages, lesson), 'utf8'));
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
  // --- The concept cards' other statements.
  const FC = 'feel/concepts.ts';
  // A jump's height from a start on flat ground, holding jump for `hold` ticks.
  const jumpFrom = (s: FeelSettings, hold: number, pressAt = 0, x = 57.5) => {
    const q = new FeelPlayer(L, s);
    q.teleport(x, 15);
    for (let i = 0; i < 5; i++) q.step(K());
    const y0 = q.y;
    let top = y0, apexTick = -1, jumped = '';
    for (let i = 0; i < 120; i++) {
      const before = q.y;
      const e = q.step(K(false, false, i >= pressAt && i < pressAt + hold));
      if (e.jumped) jumped = e.jumped;
      if (q.y < top) top = q.y;
      if (apexTick < 0 && jumped && q.y >= before && i > pressAt) apexTick = i - pressAt;
    }
    return { height: y0 - top, apexTick, jumped };
  };
  // Run: a tenth of a second to top speed, stopping faster than starting.
  {
    const q = new FeelPlayer(L, FEEL_TIGHT);
    q.teleport(57.5, 15);
    for (let i = 0; i < 5; i++) q.step(K());
    let ticks = 0;
    while (q.vx < FEEL_TIGHT.maxSpeed && ticks < 100) (q.step(K(false, true)), ticks++);
    fact(FC, Math.abs(ticks * FEEL_DT - 0.1) < 1e-9 && FEEL_TIGHT.decelTime < FEEL_TIGHT.accelTime, `Tight reaches top speed in a tenth of a second (${ticks} ticks) and stops faster than it starts`);
    claim(FC, 'a tenth of a second to top speed reads as "responsive"');
  }
  // Jumps from height and time: the time to the top doesn't depend on the height.
  {
    const sym = { ...FEEL_TIGHT, apexHang: 1, jumpCut: 1, fallGravity: 1 };
    const t2 = jumpFrom({ ...sym, jumpHeight: 2 }, 90).apexTick, t5 = jumpFrom({ ...sym, jumpHeight: 5 }, 90).apexTick;
    fact(FC, Math.abs(t2 - t5) <= 1 && Math.abs(t2 * FEEL_DT - sym.timeToApex) <= 2 * FEEL_DT, `change the height and the jump takes the same time to the top (${t2} and ${t5} ticks for 2 and 5 tiles)`);
    const { gravity, takeOff } = feelJumpPhysics(sym);
    let y = 0, v = takeOff, top = 0;
    for (let i = 0; i < 120; i++) ((v -= gravity * FEEL_DT), (y += v * FEEL_DT), (top = Math.max(top, y)));
    fact(FC, top < sym.jumpHeight - 0.01, `the simplest update (velocity, then position) undershoots the height (${top.toFixed(3)} of ${sym.jumpHeight})`);
    const hang = jumpFrom(FEEL_TIGHT, 90).height;
    fact(FC, hang > FEEL_TIGHT.jumpHeight && hang < 1.1 * FEEL_TIGHT.jumpHeight, `apex hang takes a held jump a little higher (${hang.toFixed(3)} of ${FEEL_TIGHT.jumpHeight})`);
    const falls = Object.values(FEEL_PRESETS).map((p) => p.s.fallGravity).filter((g) => g !== 1);
    const heavy = feelConcepts.find((c) => c.id === 'jump')!.tries.find((t) => t.label === 'Heavy fall')!.scenario.set!.fallGravity!;
    fact(FC, [...falls, heavy].every((g) => g >= 1.5 && g <= 3), 'every preset with heavier fall gravity, and the "Heavy fall" try, is within 1.5 to 3 times');
    claim(FC, 'Heavier gravity on the way down (1.5 to 3 times)');
  }
  // Variable jump height: a tap is a small hop, held is a full jump, and a buffered tap is a short hop too.
  {
    const tap = jumpFrom(FEEL_TIGHT, 1).height, held = jumpFrom(FEEL_TIGHT, 90).height;
    fact(FC, tap < 1 && held > 3, `a tap makes a small hop (${tap.toFixed(3)} tiles), a held button a full jump (${held.toFixed(3)})`);
    const probe = new FeelPlayer(L, FEEL_TIGHT);
    probe.teleport(33.5, 10);
    let land = -1;
    for (let i = 0; i < 200 && land < 0; i++) if (probe.step(K()).landed !== undefined) land = i;
    const q = new FeelPlayer(L, FEEL_TIGHT);
    q.teleport(33.5, 10);
    let ground = 0, top = Infinity, kind = '';
    for (let i = 0; i < 200; i++) {
      const e = q.step(K(false, false, i === land - 4));
      if (e.jumped) ((kind = e.jumped), (ground = q.y + 0)); // y just after take-off is within a tick of the floor
      if (kind) top = Math.min(top, q.y);
    }
    fact(FC, kind === 'buffered' && ground - top < 1, `a buffered tap is a short hop, not a full jump (${(ground - top).toFixed(3)} tiles)`);
  }
  // Forgiveness: the typical windows the cards quote hold for Tight, and a press 50 ms before landing is eaten without a buffer.
  {
    fact(FC, FEEL_TIGHT.coyoteTime >= 0.08 && FEEL_TIGHT.coyoteTime <= 0.15 && FEEL_TIGHT.jumpBuffer >= 0.1 && FEEL_TIGHT.jumpBuffer <= 0.15, 'Tight’s coyote time is within 80–150 ms and its buffer within 100–150 ms');
    claim(FC, '80 to 150 ms is typical');
    claim(FC, 'a short window (100 to 150 ms)');
    const early = (s: FeelSettings, ticks: number) => {
      const probe = new FeelPlayer(L, s);
      probe.teleport(33.5, 10);
      let land = -1;
      for (let i = 0; i < 200 && land < 0; i++) if (probe.step(K()).landed !== undefined) land = i;
      const q = new FeelPlayer(L, s);
      q.teleport(33.5, 10);
      const out: string[] = [];
      for (let i = 0; i < 200; i++) {
        const e = q.step(K(false, false, i === land - ticks));
        if (e.jumped) out.push(e.jumped);
        if (e.eaten) out.push('eaten');
      }
      return out.join(',');
    };
    const ms = Math.round(3 * FEEL_DT * 1000);
    fact(FC, early({ ...FEEL_TIGHT, jumpBuffer: 0 }, 3) === 'eaten' && early(FEEL_TIGHT, 3) === 'buffered', `without a buffer a press ${ms} ms before landing is eaten; with one it jumps`);
    claim(FC, `a press made ${ms} ms before landing does nothing`);
    // Try labels quote the setting they apply.
    let labels = true;
    for (const c of feelConcepts)
      for (const t of c.tries) {
        const set = t.scenario.set ?? {};
        const m = /(\d+) ms/.exec(t.label), f = /(\d+) frames/.exec(t.label), p = /(\d+)%/.exec(t.label);
        if (m && ![set.coyoteTime, set.jumpBuffer].some((v) => v !== undefined && Math.round(v * 1000) === Number(m[1]))) labels = false;
        if (f && set.inputDelay !== Number(f[1])) labels = false;
        if (p && Math.round((set.jumpCut ?? NaN) * 100) !== Number(p[1])) labels = false;
      }
    fact(FC, labels, 'the "Try it" labels quote the values they set');
  }
  // Camera: the spring never overshoots and stays stable across the whole Smoothing slider; dead zone, look-ahead, snapping.
  {
    const slider = Object.values(FEEL_SLIDERS).flatMap((g) => g.sliders).find((x) => x.key === 'cameraRate')!;
    let noOvershoot = true, bounded = true;
    for (let rate = slider.min; rate <= slider.max + 1e-9; rate += slider.step)
      for (const camera of ['spring', 'lerp'] as const) {
        const s = { ...FEEL_TIGHT, camera, cameraRate: rate, deadZone: 0, lookAhead: 0, platformSnap: false };
        const q = new FeelPlayer(L, s);
        q.teleport(57.5, 15);
        for (let i = 0; i < 5; i++) q.step(K());
        const cam = new FeelCamera(q, FEEL_VIEW_W, FEEL_VIEW_H);
        cam.x = q.x - 6;
        cam.y = cam.target(q, s).y - 4;
        for (let i = 0; i < 300; i++) {
          cam.step(q, s, L);
          if (cam.x > q.x + 1e-9 || cam.y > cam.target(q, s).y + 1e-9) noOvershoot = false;
        }
        // Run right and back left across the level, jumping now and then.
        const r = new FeelPlayer(L, { ...FEEL_TIGHT, camera, cameraRate: rate });
        const c2 = new FeelCamera(r, FEEL_VIEW_W, FEEL_VIEW_H);
        for (let i = 0; i < 1200; i++) {
          r.step(K(i >= 600, i < 600, i % 50 < 15));
          c2.step(r, r.s, L);
          if (!(Math.abs(c2.vx) < 100 && Math.abs(c2.vy) < 100)) bounded = false;
        }
      }
    fact(FC, noOvershoot, `the spring and lerp cameras never overshoot, at every Smoothing setting from ${slider.min} to ${slider.max}`);
    fact(FC, bounded, 'the camera stays stable at every Smoothing setting');
    const s = { ...FEEL_TIGHT };
    const q = new FeelPlayer(L, s);
    q.teleport(57.5, 15);
    for (let i = 0; i < 5; i++) q.step(K());
    const cam = new FeelCamera(q, FEEL_VIEW_W, FEEL_VIEW_H);
    for (let i = 0; i < 120; i++) cam.step(q, s, L);
    const cx = cam.x;
    q.x += 0.5 * s.deadZone;
    for (let i = 0; i < 30; i++) cam.step(q, s, L);
    fact(FC, Math.abs(cam.x - cx) < 1e-9, 'inside the dead zone the camera does not move');
    // A held jump with platform snapping: the view doesn't move up and down.
    let ys = 0;
    const y0 = cam.y;
    for (let i = 0; i < 60; i++) {
      q.step(K(false, false, i < 30));
      cam.step(q, s, L);
      ys = Math.max(ys, Math.abs(cam.y - y0));
    }
    fact(FC, ys < 1e-9, 'with platform snapping a jump doesn’t move the view up and down');
    for (let i = 0; i < 90; i++) (q.step(K(false, true)), cam.step(q, s, L));
    fact(FC, cam.target(q, s).x > q.x + 1, 'look-ahead leads the view in the direction of travel');
  }
  // Shake: none for a hop or an ordinary jump, some for the drop down the shaft; offset goes as trauma squared.
  {
    const landings = (s: FeelSettings, x: number, y: number, keys: (i: number) => ReturnType<typeof K>) => {
      const q = new FeelPlayer(L, s);
      q.teleport(x, y - 0.01);
      const out: number[] = [];
      for (let i = 0; i < 400; i++) {
        const e = q.step(keys(i));
        if (e.landed !== undefined) out.push(landingTrauma(e.drop, s));
      }
      return out;
    };
    const hop = landings(FEEL_TIGHT, 57.5, 15, (i) => K(false, false, i === 10));
    const jump = landings(FEEL_TIGHT, 57.5, 15, (i) => K(false, false, i % 90 < 30));
    const shaft = landings(FEEL_TIGHT, 85.5, 6, (i) => K(false, i < 60));
    fact(FC, hop.length > 0 && jump.length > 1 && [...hop, ...jump].every((x) => x === 0) && shaft.some((x) => x > 0), 'a short hop and an ordinary jump don’t shake the screen; the drop down the shaft does');
    claim(FC, 'a short hop shouldn’t shake the screen; a fall down the shaft should');
    const c = new FeelCamera(new FeelPlayer(L, FEEL_TIGHT), FEEL_VIEW_W, FEEL_VIEW_H);
    c.trauma = 1;
    const full = c.shake(0.3).x;
    c.trauma = 0.5;
    fact(FC, Math.abs(c.shake(0.3).x - full / 4) < 1e-12, 'the shake offset is proportional to trauma squared');
  }
}

// The pathing lab: its concept cards, chips and notes against the planners they describe.
function pathing(): void {
  const C = 'lab/learn/concepts.ts';
  const APP = 'lab/ui/app.ts';
  const REG = 'lab/search/registry.ts';
  const VEH = 'lab/rep/vehiclePlanner.ts';
  const SIZE: Record<string, [number, number]> = { small: [32, 20], medium: [48, 30], large: [80, 50], huge: [128, 80], xl: [256, 160], xxl: [512, 320] };
  // A map as a concept card's scenario sets it up: preset, size, seed 7, no terrain, no-corner-cutting diagonals.
  const setup = (preset: string, size: string, o: { seed?: number; need?: number; ends?: { start: [number, number]; goal: [number, number] } } = {}) => {
    const [w, h] = SIZE[size];
    const world = labPreset(preset).build(w, h, o.seed ?? 7);
    const l = world.layers[0];
    if (o.ends) {
      const at = ([fx, fy]: [number, number]) => ({ x: Math.max(0, Math.min(w - 1, Math.floor(fx * w))), y: Math.max(0, Math.min(h - 1, Math.floor(fy * h))) });
      Object.assign(world.start, at(o.ends.start));
      Object.assign(world.goal, at(o.ends.goal));
    }
    const cl = computeClearance(l);
    const sp = new GridSpace(l, cl, { diagonal: 'noCorner', need: o.need ?? 1, useTerrain: false });
    return { world, l, cl, sp, s: world.start.y * w + world.start.x, g: world.goal.y * w + world.goal.x };
  };
  const opts = (heuristic: HeuristicId, weight = 2) => ({ heuristic, weight }) as SearchOptions;
  const astar = (sp: GridSpace, s: number, g: number) => bestFirst('astar', sp, s, g, opts('octile'), new Recorder(false));
  const cost = (sp: GridSpace, path: number[]) => measurePath(sp, path).cost;
  const len = (sp: GridSpace, path: number[]) => measurePath(sp, path).length;
  const hpa = (sp: GridSpace, s: number, g: number, weight: number, lazy = false, graph = new HpaGraph(sp, 16, lazy)) => hpaQuery(graph, sp, s, g, 'octile', new Recorder(false), weight);

  // Weighted A* on the card's big town (w = 2): far fewer expansions, cost within w of optimal.
  {
    const { sp, s, g } = setup('city', 'xl');
    const a = astar(sp, s, g);
    const w = bestFirst('weighted', sp, s, g, opts('octile', 2), new Recorder(false));
    claim(C, `often expands far fewer nodes (${int(a.expanded / w.expanded)} times fewer on the big town below)`);
    fact(C, cost(sp, w.path) <= 2 * cost(sp, a.path), 'Weighted A* (w = 2) costs at most w times the optimum on the big town');
    // Greedy in the U-trap: fewer expansions, a longer path.
    const u = setup('ushape', 'medium');
    const ua = astar(u.sp, u.s, u.g);
    const ug = bestFirst('greedy', u.sp, u.s, u.g, opts('octile'), new Recorder(false));
    fact(C, cost(u.sp, ug.path) > cost(u.sp, ua.path), 'greedy best-first walks into the U-trap: its path is longer than A*’s');
  }
  // Random small maps: JPS matches A*'s path length, Theta* is never longer, Weighted A* stays within w.
  {
    let jpsSame = true, thetaOk = true, weightedOk = true, n = 0;
    for (let t = 0; t < 400; t++) {
      const W = 30, H = 30, l = makeLabLayer(W, H);
      const r = makeLabRng(t + 7);
      const d = 0.1 + 0.3 * r();
      for (let i = 0; i < W * H; i++) if (r() < d) l.blocked[i] = 1;
      const sp = new GridSpace(l, computeClearance(l), { diagonal: 'noCorner', need: 1, useTerrain: false });
      const s = Math.floor(r() * W * H), g = Math.floor(r() * W * H);
      if (!sp.passable(s) || !sp.passable(g) || s === g) continue;
      const a = astar(sp, s, g);
      const j = jumpPointSearch(sp, s, g, opts('octile'), new Recorder(false));
      if (a.status !== j.status) jpsSame = false;
      if (a.status !== 'found') continue;
      n++;
      const la = len(sp, a.path);
      if (Math.abs(la - len(sp, j.path)) > 1e-6) jpsSame = false;
      if (len(sp, thetaStar(false, sp, s, g, opts('euclidean'), new Recorder(false)).path) > la + 1e-6) thetaOk = false;
      if (cost(sp, bestFirst('weighted', sp, s, g, opts('octile', 2), new Recorder(false)).path) > 2 * cost(sp, a.path) + 1e-6) weightedOk = false;
    }
    fact(REG, n > 200 && jpsSame, `JPS finds the same path length as A* (${n} random maps)`);
    fact(C, thetaOk, 'Theta*’s path is never longer than A*’s grid path');
    fact(REG, weightedOk, 'Weighted A* stays within a factor w of optimal');
  }
  // JPS on the card's scattered map: same cost; on a town it expands an order of magnitude fewer nodes.
  {
    const { sp, s, g } = setup('scatter', 'large');
    fact(C, Math.abs(cost(sp, astar(sp, s, g).path) - cost(sp, jumpPointSearch(sp, s, g, opts('octile'), new Recorder(false)).path)) < 1e-6, 'JPS is optimal on the JPS card’s map');
    const c = setup('city', 'large');
    fact(C, astar(c.sp, c.s, c.g).expanded >= 10 * jumpPointSearch(c.sp, c.s, c.g, opts('octile'), new Recorder(false)).expanded, 'JPS expands an order of magnitude fewer nodes than A* on a town');
  }
  // Lazy Theta* on the any-angle card's rooms: several times fewer line-of-sight checks.
  {
    const { sp, s, g } = setup('rooms', 'medium');
    const checks = (lazy: boolean) => Number(/([\d,]+) line-of-sight checks/.exec(thetaStar(lazy, sp, s, g, opts('euclidean'), new Recorder(false)).note ?? '')![1].replace(/,/g, ''));
    fact(REG, checks(false) >= 2 * checks(true), `Lazy Theta* does several times fewer line-of-sight checks (${checks(true)} against ${checks(false)})`);
  }
  // Clearance: a cell with clearance k has a clear (2k−1)×(2k−1) square centred on it, and no bigger one.
  {
    const { l, cl } = setup('rooms', 'large');
    const clearSquare = (x: number, y: number, r: number) => {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const cx = x + dx, cy = y + dy;
          if (cx < 0 || cy < 0 || cx >= l.w || cy >= l.h || l.blocked[cy * l.w + cx]) return false;
        }
      return true;
    };
    let ok = true;
    for (let i = 0; i < l.w * l.h; i++) {
      const k = cl[i];
      if (!k) continue;
      const x = i % l.w, y = (i - x) / l.w;
      if (!clearSquare(x, y, k - 1) || clearSquare(x, y, k)) ok = false;
    }
    fact(C, ok, 'clearance k means a clear (2k−1)×(2k−1) square centred on the cell, and no larger one');
    claim(C, 'so a 1×1 unit needs 1, a 3×3 unit needs 2');
    // A 3×3 unit in rooms: the one-cell doors close and the rooms split into islands.
    fact(C, computeComponents(l, cl, 1, 'noCorner').count === 1 && computeComponents(l, cl, 2, 'noCorner').count > 1, 'with a 3×3 unit the rooms split into islands');
    // Reachability off: A* expands every cell it can reach before saying no.
    const big = setup('rooms', 'large', { need: 2 });
    const comp = computeComponents(l, cl, 2, 'noCorner');
    let s = -1;
    for (let i = 0; i < l.w * l.h && s < 0; i++) if (cl[i] >= 2) s = i;
    let g = -1;
    for (let i = l.w * l.h - 1; i >= 0 && g < 0; i--) if (cl[i] >= 2 && comp.labels[i] !== comp.labels[s]) g = i;
    let area = 0;
    for (let i = 0; i < l.w * l.h; i++) if (comp.labels[i] === comp.labels[s]) area++;
    const r = astar(big.sp, s, g);
    fact(C, r.status !== 'found' && r.expanded === area, `an unreachable goal makes A* expand every reachable cell (${r.expanded} of ${area})`);
  }
  // HPA*: doors, not cells. The card's big town, and the 512 × 320 map the chip suggests.
  {
    const { sp, s, g } = setup('city', 'xl');
    const a = astar(sp, s, g);
    const h = hpa(sp, s, g, 1.05, true);
    const ratio = a.expanded / h.expanded;
    fact(C, ratio >= 10 && ratio <= 30, `HPA* touches ten to thirty times fewer nodes than A* on the big town (${ratio.toFixed(1)}×)`);
    claim(C, 'often ten to thirty times fewer nodes on a big map');
    // Door weight 1.05 against 1.00: the path it breaks ties into.
    const h1 = hpa(sp, s, g, 1);
    const h105 = hpa(sp, s, g, 1.05);
    claim(APP, `A weight of 1.05 breaks the tie for paths about ${d1((cost(sp, h105.cells) / cost(sp, h1.cells) - 1) * 100)}% longer.`);
  }
  {
    const { sp, s, g } = setup('empty', 'xl', { ends: { start: [0.05, 0.08], goal: [0.95, 0.92] } });
    const h1 = hpa(sp, s, g, 1), h105 = hpa(sp, s, g, 1.05);
    fact(C, h1.expanded >= 3 * h105.expanded && cost(sp, h1.cells) < 1.01 * cost(sp, h105.cells), `with door weight 1.00 HPA* expands several times more doors for almost the same path (${h1.expanded} against ${h105.expanded})`);
  }
  // HPA* path length before smoothing, over random queries on five big maps: the chip quotes the range of the averages.
  {
    const avg: number[] = [];
    let recovered = true;
    for (const preset of ['city', 'rooms', 'caves', 'scatter', 'empty']) {
      let n = 0, sum = 0, smooth = 0;
      for (const seed of [1, 2, 3, 4]) {
        const { sp } = setup(preset, 'xl', { seed });
        const graph = new HpaGraph(sp, 16, true);
        const r = makeLabRng(seed * 101);
        for (let q = 0; q < 6; ) {
          const s = Math.floor(r() * sp.count), g = Math.floor(r() * sp.count);
          if (!sp.passable(s) || !sp.passable(g)) continue;
          q++;
          const a = astar(sp, s, g);
          const h = hpa(sp, s, g, 1.05, true, graph);
          if (a.status !== 'found' || !h.found) continue;
          const opt = cost(sp, a.path);
          n++;
          sum += cost(sp, h.cells) / opt;
          smooth += cost(sp, shortcut(sp, h.cells)) / opt;
        }
      }
      avg.push((sum / n - 1) * 100);
      if (smooth / n > 1) recovered = false;
    }
    claim(APP, `['Optimal', 'Near: ${Math.round(Math.min(...avg))}–${Math.round(Math.max(...avg))}% longer on average before smoothing']`);
    fact(C, recovered, 'smoothing recovers HPA*’s extra length');
  }
  // PRM at 1,000 samples misses the one-cell doors of the rooms map; the feature roadmap finds the path.
  {
    const { sp, s, g } = setup('rooms', 'large');
    const pal = { get: () => '#000', packed: () => 0 } as unknown as Parameters<RoadmapPlanner['plan']>[2];
    const plan = (method: 'prm' | 'feature') => new RoadmapPlanner().plan({ space: sp, start: s, goal: g, changed: 'all', structureKey: 'k' } as Parameters<RoadmapPlanner['plan']>[0], { method, samples: 1000, iterations: 5000, step: 3, spacing: 8, seed: 1, smoothing: 'none' }, pal).status;
    fact(C, plan('prm') !== 'found' && plan('feature') === 'found', 'PRM misses the one-cell doors at 1,000 samples; the feature roadmap finds the path');
    claim(C, 'PRM misses one-cell doors at 1,000 samples; the feature roadmap never does.');
  }
  // Curves: Dubins has six words; Reeds–Shepp paths have up to five pieces and two gear changes.
  {
    const dub = new Set<string>();
    let pieces = 0, gears = 0;
    const r = makeLabRng(5);
    for (let i = 0; i < 2000; i++) {
      const a = { x: 0, y: 0, theta: r() * 2 * Math.PI };
      const b = { x: (r() - 0.5) * 20, y: (r() - 0.5) * 20, theta: r() * 2 * Math.PI };
      for (const p of dubinsAll(a, b, 2)) dub.add(p.pieces.map((q) => 'RSL'[q.steer + 1]).join(''));
      for (const p of reedsSheppAll(a, b, 2)) ((pieces = Math.max(pieces, p.pieces.length)), (gears = Math.max(gears, cusps(p))));
    }
    claim(C, `forward-only, it is one of ${['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][dub.size]} words (${[...dub].sort((x, y) => 'LSL,RSR,LSR,RSL,RLR,LRL'.indexOf(x) - 'LSL,RSR,LSR,RSL,RLR,LRL'.indexOf(y)).join(', ')})`);
    claim(C, `one of 48 words of up to ${['', '', '', 'three', 'four', 'five'][pieces]} pieces, with at most ${['', 'one', 'two', 'three'][gears]} gear changes`);
  }
  // Vehicles: the lattice's headings, the vehicle names, the analytic shot, and lattice optimality.
  {
    claim(C, `cell centres with ${LATTICE_ANGLES.length} headings`);
    claim(VEH, `['Path', 'Drivable, but only ${LATTICE_ANGLES.length} headings']`);
    fact(VEH, VEHICLES.every((v) => v.name.endsWith(`${v.length} × ${v.width}`)), 'vehicle names give their real length × width');
    // The curves card's scenario: the goal faces back toward the start. With reverse the car backs in; forward-only drives further.
    const sc = PATH_CONCEPTS.find((c) => c.id === 'curves')!.tries[0].scenario;
    const { world, sp, s, g } = setup(sc.preset, sc.size!, { ends: sc.ends });
    const W = sp.w;
    const sh = Math.round((Math.atan2(world.goal.y - world.start.y, world.goal.x - world.start.x) * 180) / Math.PI / 5) * 5;
    const start = { x: (s % W) + 0.5, y: Math.floor(s / W) + 0.5, theta: (sh * Math.PI) / 180 };
    const goal = { x: (g % W) + 0.5, y: Math.floor(g / W) + 0.5, theta: (((sh + 180) % 360) * Math.PI) / 180 };
    const spec = vehicleById('car');
    const dist = vehicleDistance(sp.w, sp.h, sp.layer.blocked);
    const check = new FootprintChecker(sp.w, sp.h, sp.layer.blocked, dist, spec);
    const field = holonomicField(sp, dist, innerDisc(spec), g);
    const drive = (reverse: boolean, shots: boolean) => hybridAStar({ space: sp, check, spec, radius: spec.radius, reverse, start, goal, anyHeading: false, field, rec: new Recorder(false) }, { bins: 72, shots, limit: 20000 });
    const rev = drive(true, true), fwd = drive(false, true), noShot = drive(true, false);
    const m = (r: ReturnType<typeof drive>) => measurePoses(sp, r.poses);
    fact(C, rev.found && fwd.found && m(rev).reverse > 0 && m(fwd).reverse === 0 && m(fwd).length > m(rev).length, 'with the goal facing back, the car with reverse backs in; forward-only drives further');
    const end = (r: ReturnType<typeof drive>) => {
      const k = r.poses.length - 4;
      return { d: Math.hypot(r.poses[k] - goal.x, r.poses[k + 1] - goal.y), a: Math.abs(Math.atan2(Math.sin(r.poses[k + 2] - goal.theta), Math.cos(r.poses[k + 2] - goal.theta))) };
    };
    fact(VEH, rev.shot !== null && end(rev).d < 1e-6 && end(rev).a < 1e-6, 'Hybrid A* ends exactly on the goal pose when the analytic shot finishes it');
    fact(VEH, noShot.found && end(noShot).d <= Math.SQRT2 && (end(noShot).d > 1e-6 || end(noShot).a > 1e-6), 'without the shot, Hybrid A* stops near the goal pose, not on it');
    // The lattice is optimal over its primitives (terrain off): compare with the same search using a plain
    // straight-line heuristic, which is admissible and consistent, on open, scattered and town maps.
    class CostRec extends Recorder {
      g = new Map<number, number>();
      last = -1;
      constructor() {
        super(false);
      }
      override open(node: number, _parent: number, g = NaN): void {
        this.g.set(node, g);
      }
      override close(node: number): void {
        this.last = node;
      }
    }
    let n = 0, worse = 0;
    const query = (layer: ReturnType<typeof makeLabLayer>, vehicle: string, reverse: boolean, r: () => number) => {
      const W = layer.w, H = layer.h;
      const space = new GridSpace(layer, computeClearance(layer), { diagonal: 'noCorner', need: 1, useTerrain: false });
      const spec = vehicleById(vehicle);
      const dist = vehicleDistance(W, H, layer.blocked);
      const check = new FootprintChecker(W, H, layer.blocked, dist, spec);
      const table = latticeTable(spec, spec.radius, reverse);
      for (let tries = 0; tries < 50; tries++) {
        const sx = 3 + Math.floor(r() * (W - 6)), sy = 3 + Math.floor(r() * (H - 6)), gx = 3 + Math.floor(r() * (W - 6)), gy = 3 + Math.floor(r() * (H - 6));
        const start = { x: sx + 0.5, y: sy + 0.5, theta: LATTICE_ANGLES[Math.floor(r() * 16)] };
        const goal = { x: gx + 0.5, y: gy + 0.5, theta: LATTICE_ANGLES[Math.floor(r() * 16)] };
        if (!check.free(start.x, start.y, start.theta) || !check.free(goal.x, goal.y, goal.theta)) continue;
        const field = holonomicField(space, dist, innerDisc(spec), gy * W + gx);
        if (!Number.isFinite(field[sy * W + sx])) continue;
        const run = (f: Float64Array) => {
          const rec = new CostRec();
          const res = latticeAStar({ space, check, spec, radius: spec.radius, reverse, start, goal, anyHeading: false, field: f, rec }, table, 2_000_000);
          return res.found ? rec.g.get(rec.last)! : NaN;
        };
        const opt = run(field.map((v) => (Number.isFinite(v) ? 0 : Infinity)));
        if (!Number.isFinite(opt)) continue;
        n++;
        if (run(field) > opt + 1e-6) worse++;
        return;
      }
    };
    let seed = 1;
    for (const vehicle of ['car', 'tracked'])
      for (const reverse of [false, true]) {
        for (let t = 0; t < 3; t++) query(makeLabLayer(60, 60), vehicle, reverse, makeLabRng(seed++));
        for (let t = 0; t < 3; t++) {
          const r = makeLabRng(seed++);
          const layer = makeLabLayer(60, 60);
          for (let i = 0; i < 3600; i++) if (r() < 0.04) layer.blocked[i] = 1;
          query(layer, vehicle, reverse, r);
        }
        query(labPreset('city').build(80, 50, 7).layers[0], vehicle, reverse, makeLabRng(seed++));
      }
    fact(VEH, n >= 20 && worse === 0, `the state lattice returns the optimal path over its primitives (${n - worse} of ${n} queries)`);
    claim(VEH, "['Optimal', 'Yes, for paths made of these primitives (with terrain costs, nearly)']");
  }
}

// The tactics lab: its concept cards, hints and captions against the analyses they describe.
function tactics(): void {
  const C = 'tactics/concepts.ts';
  const APP = 'tactics/app.ts';
  const CHOKE = 'tactics/chokeTrace.ts';
  const map = (preset: string, size = 'small') => TACTICS_PRESETS.find((p) => p.id === preset)!.build(...TACTICS_SIZES[size], 3);
  // The lab's own constants, read from its source where they are arguments in the app.
  const source = (file: string) => readFileSync(join(here, '..', 'src', file), 'utf8');
  const constant = (file: string, re: RegExp) => {
    const m = re.exec(source(file));
    if (!m) throw new Error(`${file}: ${re} not found`);
    return m.slice(1).map(Number);
  };
  const colours = { get: () => '#000', rgba: () => '#000' } as unknown as ConstructorParameters<typeof ChokeTrace>[1];
  // Kinds of terrain: what blocks walking and what blocks sight from a standing eye.
  const low = TACTICS_KINDS[T_LOW], building = TACTICS_KINDS[T_BUILDING], ravine = TACTICS_KINDS[T_RAVINE];
  claim(C, `A low wall (${low.height} m) blocks movement and hides a crouching unit, but a standing one can see and strike over it.`);
  fact(C, !low.walk && T_CROUCHED < low.height && T_STANDING > low.height, 'a low wall blocks walking, is taller than a crouching unit and shorter than a standing one');
  fact(C, !ravine.walk && ravine.height < T_EYE && !building.walk && building.height > T_EYE, 'a ravine blocks movement but not sight; a building blocks both');
  // Line of sight behind a 1 m wall on open ground: a crouched target is hidden from 3 m out, a standing one never is.
  {
    const w = makeTacticsWorld(30, 5);
    const y = 2, x = 20;
    w.kind[y * w.w + x - 1] = T_LOW;
    let crouchedHidden = true, standingSeen = true;
    for (let d = 3; d <= 15; d++) {
      if (tacticsLos(w, x - d, y, x, y, T_EYE, T_CROUCHED).clear) crouchedHidden = false;
      if (!tacticsLos(w, x - d, y, x, y, T_EYE, T_STANDING).clear) standingSeen = false;
    }
    fact(C, crouchedHidden && standingSeen, 'a crouched unit right behind a 1 m wall is hidden from 3 m and further; a standing one is seen');
    // "Exact for this model": the cell walk agrees with a dense sample along the line on random sight lines.
    let agree = 0, total = 0;
    for (const preset of ['town', 'country']) {
      const t = map(preset);
      const r = makeLabRng(3);
      const walk: number[] = [];
      for (let i = 0; i < t.w * t.h; i++) if (TACTICS_KINDS[t.kind[i]].walk) walk.push(i);
      // A line through a grid corner touches the cells beside it at a point; the cell walk counts that as
      // crossing one of them (so it won't see diagonally between two buildings), so such lines are left out.
      const throughCorner = (ax: number, ay: number, bx: number, by: number) => {
        const dx = bx - ax, dy = by - ay;
        for (let X = Math.min(ax, bx) + 1; X <= Math.max(ax, bx); X++) {
          const y = ay + 0.5 + (dy * (X - ax - 0.5)) / dx;
          if (Math.abs(y - Math.round(y)) < 1e-9) return true;
        }
        return false;
      };
      for (let k = 0; k < 3000; k++) {
        const a = walk[Math.floor(r() * walk.length)], b = walk[Math.floor(r() * walk.length)];
        const ax = a % t.w, ay = (a - ax) / t.w, bx = b % t.w, by = (b - bx) / t.w;
        if (a === b || throughCorner(ax, ay, bx, by)) continue;
        const tz = r() < 0.5 ? T_CROUCHED : T_STANDING;
        let clear = true;
        const steps = 20000;
        for (let s = 1; s < steps && clear; s++) {
          const f = s / steps;
          const cx = Math.floor(ax + 0.5 + (bx - ax) * f), cy = Math.floor(ay + 0.5 + (by - ay) * f);
          if ((cx === ax && cy === ay) || (cx === bx && cy === by)) continue;
          const ci = cy * t.w + cx;
          if (Math.max(TACTICS_KINDS[t.kind[ci]].height, t.dyn[ci]) > T_EYE + (tz - T_EYE) * f) clear = false;
        }
        total++;
        if (clear === tacticsLos(t, ax, ay, bx, by, T_EYE, tz).clear) agree++;
      }
    }
    fact(C, agree === total, `grid line of sight is exact for this model (${agree} of ${total} random sight lines match a dense sample)`);
    claim(C, "It's exact for this model and costs one step per cell crossed");
  }
  // Movement chokes vs sight chokes on the ravine map: the bridge is a choke only for movement, the doorways for both.
  {
    const t = map('ravine');
    const chokes = (mode: 'move' | 'sight') => {
      const tr = new ChokeTrace(t, colours, mode, 0.6);
      tr.seek(tr.length - 1);
      return tr.chokes;
    };
    const tx = Math.floor(t.w * 0.5), wx = Math.floor(t.w * 0.22);
    const onBridge = (c: { x: number }) => Math.abs(c.x - tx) <= 1;
    const atWall = (c: { x: number }) => Math.abs(c.x - wx) <= 1;
    const move = chokes('move'), sight = chokes('sight');
    fact(C, move.some(onBridge) && !sight.some(onBridge), 'the bridge is a choke for movement and disappears for line of sight');
    fact(C, move.filter(atWall).length === 2 && sight.filter(atWall).length === 2, 'both doorways in the wall are chokes for movement and for sight');
  }
  // Traffic: the number of Dijkstra searches and routes the card and the hint quote.
  {
    const [sources, each] = constant(APP, /traffic\(this\.t, (\d+), (\d+),/);
    const [cs, ce] = constant(CHOKE, /for \(let s = 0; s < (\d+) && walk\.length > 1; s\+\+\)[\s\S]*?for \(let k = 0; k < (\d+); k\+\+\)/);
    fact(CHOKE, cs === sources && ce === each, 'the traffic stage of the choke trace samples as many routes as the traffic layer');
    claim(C, `Here: ${sources} Dijkstra searches, ${each} routes from each.`);
    claim(APP, `stats.push(['${sources * each}', 'sampled routes'], ['${sources}', 'Dijkstra searches']`);
    claim(APP, `Shortest routes between ${sources * each} random pairs of walkable points`);
    claim(CHOKE, `(${sources} Dijkstra searches, up to ${each} random destinations each;`);
  }
  // Openness: rays per cell.
  {
    const t = map('town');
    const n = probeOpenness(t, t.unit.x, t.unit.y).rays.length;
    claim(C, `Cast rays outwards at eye height in a ring (${n} here)`);
    claim(APP, `The unit casts ${n} rays at eye height`);
  }
  // The boundary walk: probes every metre; at the default tolerance no probe misses, raise it and red probes appear.
  {
    const [spacing] = constant(APP, /private sampleSpacing = ([\d.]+);/);
    const [tol] = constant(APP, /private simplifyTol = ([\d.]+);/);
    claim(C, `Walk each edge at a fixed spacing (here ${spacing} m)`);
    const missed = (preset: string, tolerance: number) => {
      const tr = new WalkTrace(map(preset), colours, spacing, tolerance);
      tr.seek(tr.length - 1);
      return (tr as unknown as { samples: Array<{ kind: string }> }).samples.filter((s) => s.kind === 'none').length;
    };
    fact(C, missed('town', tol) === 0 && missed('country', tol) === 0, 'at the default Simplify tolerance the boundary walk has no red (missed) probes');
    fact(C, missed('town', 1) > 0 && missed('country', 1) > 0, 'raising the Simplify tolerance makes red probes appear');
  }
  // Thin gaps (the cards run the medium map, which is where these shares hold).
  {
    const t = TACTICS_PRESETS.find((p) => p.id === 'thin')!.build(...TACTICS_SIZES.medium, 3);
    const truth = coverTruth(t);
    let gaps = 0;
    for (const i of truth.keys()) if (t.thin[i]) gaps++;
    const share = (algo: 'random' | 'poisson' | 'biased') => {
      const found = new Set<number>();
      for (const [x, y] of samplePoints(t, algo, 300, 11))
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const i = (y + dy) * t.w + x + dx;
            if (x + dx >= 0 && y + dy >= 0 && x + dx < t.w && y + dy < t.h && truth.has(i) && t.thin[i]) found.add(i);
          }
      return found.size / gaps;
    };
    const third = (x: number) => x >= 0.25 && x <= 0.42;
    fact(C, third(share('random')) && third(share('poisson')) && share('biased') >= 0.83 && share('biased') <= 0.95, 'on the medium Thin gaps map with 300 samples, random and Poisson find about a third of the gap positions, edge-biased nearly nine in ten');
    claim(C, 'On the medium Thin gaps map with 300 samples');
    const card = TACTICS_CONCEPTS.find((c) => c.id === 'coverSampling')!;
    fact(C, card.tries.every((x) => x.scenario.size === 'medium' && x.scenario.budget === 300), 'the thin-gaps cards run the medium map with 300 samples');
  }
  // Changing terrain: per-cell cover is rebuilt with a 1 m margin.
  {
    const [margin] = constant(APP, /dirtyTiles\(t, clamped, (\d+)\)/);
    claim(C, `so a ${margin} m margin is enough`);
  }
  // Exposure: crouching barely changes the town (few low walls); behind the countryside's hedgerows it cuts exposure.
  {
    const card = TACTICS_CONCEPTS.find((c) => c.id === 'exposure')!;
    const threatsAt = card.tries[0].scenario.threats!;
    const exposure = (preset: string) => {
      const t = map(preset);
      const free = ([fx, fy]: [number, number]) => {
        const x0 = Math.round(fx * (t.w - 1)), y0 = Math.round(fy * (t.h - 1));
        for (let r = 0; r < Math.max(t.w, t.h); r++)
          for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) if (x >= 0 && y >= 0 && x < t.w && y < t.h && TACTICS_KINDS[t.kind[y * t.w + x]].walk) return { x, y };
        return { x: x0, y: y0 };
      };
      const e = exposureKnown(t, threatsAt.map(free));
      let standing = 0, crouched = 0;
      for (let i = 0; i < t.w * t.h; i++) ((standing += e.standing[i]), (crouched += e.crouched[i]));
      return { standing, crouched };
    };
    const town = exposure('town'), country = exposure('country');
    fact(C, town.crouched >= 0.9 * town.standing, 'in the town, crouching barely changes the exposure map');
    claim(C, `in the countryside, crouching behind the hedgerows cuts exposure by ${pct((1 - country.crouched / country.standing) * 100)}.`);
  }
  // Picking cover: candidates within 25 m of walking.
  {
    const [range] = constant(APP, /const \{ dist, prev \} = dijkstra\(t, from, (\d+)\);/);
    claim(C, `Every cover position within ${range} m of walking is a candidate`);
    claim(APP, `'Every cover position within ${range} m of walking is a candidate`);
    claim(APP, `'no reachable cover within ${range} m'`);
  }
}

// A frame in detail: what each frame scenario really does, recorded from the traced flecs build.
async function frame(): Promise<void> {
  const L = 'flecs/a-frame-in-detail.mdx';
  const wasm = readFileSync(join(here, '..', 'public', 'flecs.wasm'));
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () => new Response(wasm, { headers: { 'content-type': 'application/wasm' } });
  const w = await FlecsWorld.create();
  (globalThis as { fetch: unknown }).fetch = prevFetch;
  const run = (id: string, variant = 0, stages?: number): FrameRecording => {
    const sc = FRAME_SCENARIOS[id];
    const cfg = defaultConfig(sc, variant);
    return recordFrame(w, sc, stages ? { ...cfg, stages } : cfg);
  };
  const tl = (rec: FrameRecording, step = 0): FrameTimeline => {
    const st = rec.steps[step];
    return frameTimeline(rec, step, (e) => rec.names.get(e) ?? w.name(e), (t) => st.types.get(t) ?? st.after.tables.get(t)?.type.map((c) => c.str));
  };
  const nm = (rec: FrameRecording, e: number) => rec.names.get(e) ?? rec.systems.get(e)?.name ?? w.name(e);
  const runNames = (rec: FrameRecording, t: FrameTimeline) => t.runs.map((r) => r.systems.map((s) => nm(rec, s)));
  const slices = (t: FrameTimeline, run: number, system: string, rec: FrameRecording, table?: number) =>
    t.runs[run].lanes.map((lane) => lane.filter((b) => nm(rec, b.system) === system).flatMap((b) => b.slices.filter((s) => table === undefined || s.table === table)).reduce((n, s) => n + s.count, 0));
  const dot = (xs: number[]) => xs.join(' · ');

  // The whole frame, 3 threads.
  const tour = run('frameTour');
  const t1 = tl(tour);
  const runs = runNames(tour, t1);
  fact(L, runs.length === 6 && runs[0][0] === 'flecs.script.ProgressTasks' && t1.runs[0].kind === 'immediate', 'the first of six runs is flecs.script.ProgressTasks, immediate');
  fact(L, JSON.stringify(runs.slice(1)) === JSON.stringify([['Input'], ['Move', 'Ignite'], ['Burn'], ['Reap'], ['Render']]), 'runs: Input | Move, Ignite | Burn | Reap | Render');
  claim(L, 'Six runs: the built-in one, `Input`, `Move` and `Ignite` together, `Burn`, `Reap`, `Render`.');
  fact(L, t1.runs.filter((r) => !r.threaded).every((r) => r.lanes.slice(1).every((l) => !l.length)), 'workers do nothing in single-threaded and immediate runs');
  const goblins = t1.runs[2].lanes[0].find((b) => nm(tour, b.system) === 'Move')!.slices.find((s) => s.count === 4)!.table;
  const moveG = t1.runs[2].lanes.map((l) => l.find((b) => nm(tour, b.system) === 'Move')!.slices.find((s) => s.table === goblins)!);
  claim(L, `\`Move\` gets rows ${moveG[0].offset}–${moveG[0].offset + moveG[0].count - 1} of the goblins' table on \`main\`, ${moveG[1].offset}–${moveG[1].offset + moveG[1].count - 1} on \`worker 1\` and ${moveG[2].offset}–${moveG[2].offset + moveG[2].count - 1} on \`worker 2\``);
  const hero = tour.user.has(w.lookup('Hero')) ? tour.steps[0].before.where.get(w.lookup('Hero'))!.table : 0;
  fact(L, dot(slices(t1, 2, 'Move', tour, hero)) === '1 · 0 · 0', "the hero's one-row table goes to main only");
  const ignite = t1.runs[2].merge!;
  claim(L, `\`Ignite\` queues \`set<Burning>\` for the four imps: ${dot(ignite.stages.map((s) => s.count))} commands on the three stages`);
  const impMoves = ['Imp0', 'Imp1', 'Imp2', 'Imp3'].map((n) => tour.steps[0].events.filter((e) => e.k === 'moveBegin' && e.entity === w.lookup(n)).length);
  fact(L, impMoves.every((m) => m === 2), 'each imp moves twice in frame 1');
  const burn = slices(t1, 3, 'Burn', tour);
  claim(L, `so \`Burn\` now finds ${burn.reduce((a, b) => a + b, 0)} rows and splits them ${dot(burn)}`);
  const reapEvents = tour.steps[0].events.slice(t1.runs[4].ev, t1.runs[4].merge!.ev);
  fact(L, reapEvents.some((e) => e.k === 'observer' && e.name === 'ShowLoot'), 'ShowLoot fires inside Reap');
  fact(L, t1.runs[4].merge!.commands === 2, "Reap's two destructs are flushed when it returns");
  fact(L, t1.runs[1].reasons.some((r) => r.bits & 4) && t1.runs[2].reasons.some((r) => r.bits & 2) && t1.runs[3].reasons.some((r) => r.bits & 1 && r.terms.some((x) => x.id === 'Burning' && x.writers.includes('Ignite'))) && t1.runs[4].reasons.some((r) => r.bits & 8) && t1.runs[5].reasons.some((r) => r.bits & 4), 'the reasons in the table: kind changes, Burning declared by Ignite, immediate');
  // Variants.
  const noAnn = run('frameTour', 1);
  const tn = tl(noAnn);
  fact(L, JSON.stringify(runNames(noAnn, tn)[2]) === JSON.stringify(['Move', 'Ignite', 'Burn']), 'without the annotation Burn joins Move and Ignite');
  claim(L, `and it finds only the orc: ${slices(tn, 2, 'Burn', noAnn).reduce((a, b) => a + b, 0)} row.`);
  fact(L, tl(noAnn, 1).runs.flatMap((r) => r.lanes.flat()).filter((b) => nm(noAnn, b.system) === 'Burn').reduce((n, b) => n + b.rows, 0) === 4, 'the four imps burn in frame 2 (the orc was reaped in frame 1)');
  const single = run('frameTour', 2);
  const ts = tl(single);
  fact(L, JSON.stringify(runNames(single, ts)[1]) === JSON.stringify(['Input', 'Move', 'Ignite']) && ts.runs.length === t1.runs.length - 1, 'all single-threaded: Input, Move, Ignite share a run, one sync fewer');
  const one = run('frameTour', 0, 1);
  fact(L, JSON.stringify(runNames(one, tl(one))) === JSON.stringify(runs), 'one thread: the same six runs');
  const idle = run('frameTour', 3);
  const ti = tl(idle);
  fact(L, ti.rebuilds.length === 1 && ti.rebuilds[0].activated.includes('Reap') && runNames(idle, ti).some((r) => r.includes('Reap')), 'Reap idle: one rebuild mid-frame, and Reap runs');

  // Rows to workers.
  const chunk = (n: number) => {
    const rec = run('frameChunking', 0, n);
    const t = tl(rec);
    const a = rec.steps[0].before.where.get(w.lookup('a0'))!.table;
    const b = rec.steps[0].before.where.get(w.lookup('b0'))!.table;
    const boss = rec.steps[0].before.where.get(w.lookup('boss'))!.table;
    const after = rec.steps[0].after;
    const health = after.sortedTables().find((x) => x.type.map((c) => c.str).join() === 'Health,(Identifier,Name)' || x.type.map((c) => c.str).join() === 'Health')!;
    const calmed = rec.steps[0].events.filter((e) => e.k === 'observer' && e.name === 'Calmed').map((e) => nm(rec, (e as { entity: number }).entity));
    return { rec, t, a: slices(t, 1, 'Tick', rec, a), b: slices(t, 1, 'Tick', rec, b), boss: slices(t, 1, 'Tick', rec, boss), cool: slices(t, 1, 'Cool', rec, a), queues: t.runs[1].merge!.stages.map((s) => s.count), order: health.rows.map((e) => nm(rec, e)), calmed };
  };
  const c3 = chunk(3), c4 = chunk(4), c1 = chunk(1);
  claim(L, `With 3 threads, the 10 \`a\` rows split ${dot(c3.a)}, the 4 \`b\` rows ${dot(c3.b)}, and the boss's single row goes to \`main\` only. With 4 threads it's ${dot(c4.a)} and ${dot(c4.b)}.`);
  fact(L, dot(c3.boss) === '1 · 0 · 0' && dot(c3.cool) === dot(c3.a), 'boss on main only; Cool gets the same slices as Tick');
  claim(L, `(${dot(c3.queues)} commands with 3 threads)`);
  const range = (xs: string[]) => xs.join(',');
  fact(L, range(c1.order) === 'a0,a1,a2,a3,a4,a5,a6,a7,a8,a9,b0,b1,b2,b3', 'one thread: a0…a9, b0…b3');
  fact(L, range(c3.order) === 'a0,a1,a2,a3,b0,b1,a4,a5,a6,b2,a7,a8,a9,b3' && range(c3.calmed.filter((x) => x !== 'boss')) === range(c3.order), 'three threads: a0–a3, b0, b1, a4–a6, b2, a7–a9, b3, and Calmed in that order');
  fact(L, c3.rec.steps[0].events.filter((e) => e.k === 'moveBegin' && e.entity === w.lookup('b0')).length === 1, "b0's two removes are one move");

  // Inside a merge.
  const ch = run('frameChains');
  const ce = ch.steps[0].events;
  const A = w.lookup('A'), B = w.lookup('B');
  fact(L, ce.filter((e) => e.k === 'moveBegin' && e.entity === A).length === 2, 'A moves twice: the batch, then Smoke');
  // Nesting as the widget draws it: flushes inside flushes in the merge's call tree.
  type FNode = { kind: string; depth?: number; children: FNode[] };
  const nest = (ns: FNode[]): number => Math.max(0, ...ns.map((n) => (n.kind === 'flush' && n.depth ? 1 : 0) + nest(n.children)));
  const chT = tl(ch);
  fact(L, nest(chT.runs.find((r) => r.systems.some((s) => nm(ch, s) === 'Hit'))!.merge!.tree as FNode[]) === 2, 'two levels of nested flushes');
  const idx = (pred: (e: (typeof ce)[number]) => boolean) => ce.findIndex(pred);
  const alarm = idx((e) => e.k === 'cmdRun' && e.id === 'Alert');
  const watchB = idx((e) => e.k === 'observer' && e.name === 'WatchHealth' && e.entity === B);
  const watchA = idx((e) => e.k === 'observer' && e.name === 'WatchHealth' && e.entity === A);
  fact(L, alarm > 0 && alarm < watchB && watchB < watchA, "the chain runs before B's command, and WatchHealth sees B before A");
  const smolder = ce.find((e) => e.k === 'locals' && e.name === 'Smolder') as { fields: Array<{ values: unknown[] | null }> } | undefined;
  fact(L, JSON.stringify(smolder?.fields[0]?.values) === JSON.stringify([{ dps: 5 }]), 'A has two queued commands, so the merge batches them and the OnAdd observer already sees the queued value');
  const val = run('frameChains', 1);
  const ve = val.steps[0].events;
  fact(L, ve.some((e) => e.k === 'validate' && e.entity === A && !e.ok) && !ve.some((e) => e.k === 'observer' && e.name === 'WatchHealth' && e.entity === A), "on_validate rejects A's 1: no WatchHealth for A");
  const aAfter = val.steps[0].after.tables.get(val.steps[0].after.where.get(A)!.table)!;
  fact(L, JSON.stringify(aAfter.values.get('Health')?.[val.steps[0].after.where.get(A)!.row]) === JSON.stringify({ hp: 1 }), "A's Health is still 1 after the rejected on_validate");
  const rep = run('frameChains', 2);
  const tr = tl(rep);
  const hitRun = tr.runs.find((r) => r.systems.some((s) => nm(rep, s) === 'Hit'))!;
  const inHit = rep.steps[0].events.slice(hitRun.ev, hitRun.merge!.ev).filter((e) => e.k === 'replaceHook').length;
  fact(L, inHit === 2, 'on_replace runs for B and A while Hit runs (when the set is queued)');
  const locked = run('frameChains', 3).steps[0].events.filter((e) => e.k === 'locked') as Array<{ table: number; op: string }>;
  fact(L, locked.length === 2 && locked[0].op === 'move' && locked[1].op === 'table delete' && locked[0].table === locked[1].table, 'world write in Smolder: the first locked op is the move, then its row delete in the same table');
  claim(L, "the move out of A's locked table (the second marker is the same move's row delete)");

  // Two pipelines.
  const pp = run('framePipelines');
  const [p1, p2, p3] = [0, 1, 2].map((i) => tl(pp, i));
  fact(L, JSON.stringify(runNames(pp, p1)) === JSON.stringify([['Integrate'], ['Collide']]), 'the physics pipeline: Integrate | Collide');
  fact(L, !runNames(pp, p3).flat().includes('Integrate') && runNames(pp, p3).flat().includes('PlaySound'), 'progress() runs PlaySound, not Integrate');
  const ball1 = w.lookup('Ball1');
  fact(L, p1.runs[1].merge!.commands === 1 && pp.steps[0].after.where.get(ball1) !== undefined && pp.steps[1].before.tables.get(pp.steps[1].before.where.get(ball1)!.table)!.rows.length === 1, 'Ball1 bounced in pass 1 and is alone in its table in pass 2');
  fact(L, p2.runs[0].lanes[1].every((b) => b.slices.every((s) => s.table !== pp.steps[1].before.where.get(ball1)!.table)), "only main moves Ball1's one-row table");
}

// Rendering: every number the three pipeline lessons quote, from the scenes their widgets draw.
function rendering(): void {
  // The pipeline.
  const P = 'rendering/the-pipeline.mdx';
  const on = rdPipelineRun(0.1, true).stats;
  const off = rdPipelineRun(0.1, false).stats;
  const deep = rdPipelineRun(4.6, true).stats;
  const sc = rdPipelineScene();
  claim(P, `This frame has ${on.vertices} vertex shader runs: the floor's ${sc[0].mesh.positions.length} and the box's ${sc[1].mesh.positions.length}`);
  claim(P, `${on.triangles} triangles go in`);
  fact(P, on.clipped === 2, 'both floor triangles cross the near plane');
  claim(P, `both floor triangles cross the near plane and come out as ${on.clippedOut} triangles`);
  claim(P, `${on.backfacing} of the box's ${sc[1].mesh.indices.length / 3} face away from the camera`);
  claim(P, `${off.fragments} fragments, ${off.depthFailed} of which fail the depth test, against ${on.fragments} fragments with culling on`);
  claim(P, `${on.rasterised} triangles reach the rasteriser, and between them they produce ${on.fragments} fragments`);
  fact(P, on.depthFailed === 0, 'with culling on, nothing fails the depth test');
  fact(P, rdPipelineRun(1, true).stats.clipped === on.clipped, 'at 1 m the near plane still clips only the floor');
  claim(P, `${deep.clipped} of the ${deep.triangles} triangles are clipped, into ${deep.clippedOut}`);

  // Rasterisation.
  const R = 'rendering/rasterisation.mdx';
  const shared = rdRasterPoints('shared');
  const tl = rdCoverage(shared, 'top-left', 1);
  const inc = rdCoverage(shared, 'inclusive', 1);
  const exc = rdCoverage(shared, 'exclusive', 1);
  claim(R, `${inc.twice} pixels are drawn twice, all on the diagonal`);
  claim(R, `${exc.missed} pixels are drawn by neither`);
  claim(R, `A covers ${tl.a} pixels and B covers ${tl.b}, none twice, none missed`);
  fact(R, tl.twice === 0 && tl.missed === 0, 'the top-left rule draws every pixel once');
  const ms = rdCoverage(shared, 'top-left', 4);
  claim(R, `${ms.partial} pixels are partly covered, and the fragment shader runs ${ms.shaded} times, against ${tl.shaded} without MSAA`);
  const sl1 = rdCoverage(rdRasterPoints('sliver'), 'top-left', 1);
  const sl4 = rdCoverage(rdRasterPoints('sliver'), 'top-left', 4);
  claim(R, `the long sliver covers only ${sl1.a} pixels`);
  fact(R, sl1.b === 0, 'the speck covers no pixel centre');
  claim(R, `The sliver now covers ${sl4.a} samples and the speck ${sl4.b}`);
  const aff = rdAffineError();
  claim(R, `${int(aff.wrong)} of the floor's ${int(aff.pixels)} pixels pick the wrong colour, and texture coordinates are out by up to ${d1(aff.max)} squares`);

  // Depth.
  const D = 'rendering/depth.mdx';
  const zf = (format: 'unorm16' | 'unorm24' | 'float32', near: number, reverseZ = false) => rdZFight({ format, near, reverseZ, depthTest: true });
  const z16 = zf('unorm16', 0.1);
  claim(D, `the ground shows through on ${z16.fighting} of the road's ${z16.road} pixels`);
  claim(D, `moving the near plane from 0.1 m to 10 m takes the fighting from ${z16.fighting} pixels down to ${zf('unorm16', 10).fighting}`);
  fact(D, zf('unorm24', 0.1).fighting === 0, 'with 24 bits the road is clean at 0.1 m');
  const z24 = zf('unorm24', 0.01);
  claim(D, `the ground shows through on ${z24.fighting} pixels`);
  claim(D, `fights on the same ${zf('float32', 0.01).fighting} pixels`);
  fact(D, zf('float32', 0.01).fighting === z24.fighting, 'plain float32 fights exactly like 24-bit');
  fact(D, zf('float32', 0.01, true).fighting === 0, 'reverse-Z float32 is clean at 0.01 m');
  fact(D, zf('unorm16', 0.1, true).fighting === z16.fighting && zf('unorm24', 0.01, true).fighting === z24.fighting, 'reverse-Z changes nothing for integer formats');
  claim(D, `at 100 m, two surfaces ${rdLength(rdResolution(100, 0.1, RD_DEPTH_FAR, 'unorm16', false))} apart can still get the same 16-bit value`);
  const row = (label: string, fmt: 'unorm16' | 'unorm24' | 'float32', rz: boolean) => claim(D, `| ${label} | ${[10, 100, 1000].map((z) => rdLength(rdResolution(z, 0.1, RD_DEPTH_FAR, fmt, rz))).join(' | ')} |`);
  row('16-bit', 'unorm16', false);
  row('24-bit', 'unorm24', false);
  row('32-bit float', 'float32', false);
  row('32-bit float, reverse-Z', 'float32', true);
  const lateBack = rdOverdraw('back', 'late');
  const earlyBack = rdOverdraw('back', 'early');
  const earlyFront = rdOverdraw('front', 'early');
  const pre = rdOverdraw('back', 'prepass');
  claim(D, `the fragment shader runs ${int(lateBack.stats.shaded)} times for ${int(lateBack.visible)} pixels on screen, ${d2(lateBack.stats.shaded / lateBack.visible)}× per pixel`);
  claim(D, `they all pass, still ${int(earlyBack.stats.shaded)}`);
  claim(D, `front to back with early Z and it drops to ${int(earlyFront.stats.shaded)}`);
  fact(D, earlyFront.stats.shaded === earlyFront.visible, 'front to back with early Z shades each pixel once');
  claim(D, `${int(pre.stats.shaded)} runs whatever the order, after ${int(pre.stats.prepassFragments)} depth-only fragments in the prepass`);
  fact(D, rdOverdraw('front', 'prepass').stats.shaded === pre.stats.shaded, 'the prepass shades the same either way');
}

const GROUPS: Record<string, () => void | Promise<void>> = { ai, goap, htn, hotreload: hotReload, physics, engines, chaos, ecs, trouble, network, feel, steering, formations, cover: coverSampling, avoidance, jobs, spatial, waiting, profiling, influence: influenceMaps, knowledge, party, recast, pathing, tactics, render: rendering, frame };
const FAST = ['ai', 'goap', 'htn', 'hotreload', 'physics', 'engines', 'chaos', 'ecs', 'trouble', 'network', 'feel', 'steering', 'formations', 'cover', 'avoidance', 'jobs', 'spatial', 'waiting', 'profiling', 'influence', 'knowledge', 'party', 'recast', 'pathing', 'tactics', 'render', 'frame'];
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
