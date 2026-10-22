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
  };
  const N = 40;
  const r: Record<string, { alive: number; full: number; kills: number; sw: number; wasted: number; cost: number; max: number; replans: number; expanded: number }> = {};
  for (const [name, make] of Object.entries(brains)) {
    let alive = 0, kills = 0, sw = 0, wasted = 0, cost = 0, dec = 0, full = 0, max = 0, replans = 0;
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
      if (b instanceof PlannerBrain) replans += b.replans;
    }
    r[name] = { alive: alive / N, full, kills: kills / N, sw: sw / N, wasted: wasted / N, cost: cost / dec, max, replans: replans / N, expanded: replans ? cost / replans : 0 };
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
  claim(ca, `| Average survival | ${a('tuned')} s | ${a('bt')} s | ${a('goap')} s |`);
  claim(ca, `| Lasted the full 3 minutes | ${r.tuned.full} / 40 | ${r.bt.full} / 40 | ${r.goap.full} / 40 |`);
  claim(ca, `| Kills per fight | ${d1(r.tuned.kills)} | ${d1(r.bt.kills)} | ${d1(r.goap.kills)} |`);
  claim(ca, `| Action switches / min | ${int(r.tuned.sw)} | ${int(r.bt.sw)} | ${int(r.goap.sw)} |`);
  claim(ca, `| Work per tick | ${int(r.tuned.cost)} considerations | ${int(r.bt.cost)} nodes | ${d2(r.goap.cost)} states expanded |`);
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
  claim(L, `(${int(pf(8, 'queue', 64))} µs with the queue and ${int(pf(8, 'steal', 64))} µs with stealing`);
  claim(L, `${pct(((total / 8) / pf(8, 'static', 64)) * 100)} efficiency, whatever the job size`);
  claim(L, `at 64 items per job there are only ${costs.length / 64} jobs`);
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
  claim(L, `a circle under a random party member, telegraphed for ${BOSS.slamWarn} s`);
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

const GROUPS: Record<string, () => void | Promise<void>> = { ai, goap, steering, formations, cover: coverSampling, avoidance, jobs, waiting, profiling, influence: influenceMaps, knowledge, party, recast };
const FAST = ['ai', 'goap', 'steering', 'formations', 'cover', 'avoidance', 'jobs', 'waiting', 'profiling', 'influence', 'knowledge', 'party', 'recast'];
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
