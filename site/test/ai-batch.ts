// Headless comparison of every AI brain variant over 40 fixed seeds (the same seeds as the
// "Run 40 fights" button). Run with `npm run ai-batch`. The lesson tables quote these numbers.
import { World, TICK_HZ } from '../src/ai/world';
import { UtilityBrain, TreeBrain, PlannerBrain, defaultBehaviours, type Brain } from '../src/ai/brains';
import { curve } from '../src/ai/curves';
const exposedBs = () => { const bs = defaultBehaviours(); const b = bs.find((x) => x.id === 'potion')!; const i = b.considerations.findIndex((c) => c.name === 'Not under attack'); b.considerations[i] = { name: 'Not exposed', factor: 'exposed', min: 0, max: 1, curve: curve('linear', { inv: true, lo: 0.1 }) }; return bs; };
const brains: Record<string, () => Brain> = {
  'util plain': () => new UtilityBrain(defaultBehaviours(), { selection: 'best', inertia: 0, commit: 0, compensate: true }),
  'util plain exposed': () => new UtilityBrain(exposedBs(), { selection: 'best', inertia: 0, commit: 0, compensate: true }),
  'util .05/.2': () => new UtilityBrain(defaultBehaviours(), { selection: 'best', inertia: 0.05, commit: 0.2, compensate: true }),
  'util .05/.2 exposed': () => new UtilityBrain(exposedBs(), { selection: 'best', inertia: 0.05, commit: 0.2, compensate: true }),
  'util .15/.5': () => new UtilityBrain(defaultBehaviours(), { selection: 'best', inertia: 0.15, commit: 0.5, compensate: true }),
  'util nocomp': () => new UtilityBrain(defaultBehaviours(), { selection: 'best', inertia: 0.05, commit: 0.2, compensate: false }),
  'util weighted': () => new UtilityBrain(defaultBehaviours(), { selection: 'weighted', inertia: 0.05, commit: 0.2, compensate: true }),
  'util dual': () => new UtilityBrain(defaultBehaviours(), { selection: 'dual', inertia: 0.05, commit: 0.2, compensate: true }),
  bt: () => new TreeBrain(),
  'bt memory': () => new TreeBrain(undefined, true),
  goap: () => new PlannerBrain(),
};
const N = 40;
for (const [name, make] of Object.entries(brains)) {
  let alive = 0, kills = 0, sw = 0, wasted = 0, cost = 0, dec = 0, surv = 0, maxCost = 0, replans = 0;
  for (let s = 1; s <= N; s++) {
    const w = new World(1000 + s); const b = make();
    while (!w.dead && w.tick < 180 * TICK_HZ) { w.step(b.decide(w)); cost += b.cost; dec++; maxCost = Math.max(maxCost, b.cost); }
    alive += w.seconds; kills += w.stats.kills; sw += w.stats.switches / (w.seconds / 60); wasted += w.stats.wasted; if (!w.dead) surv++;
    if (b instanceof PlannerBrain) replans += b.replans;
  }
  console.log(name.padEnd(22), `alive ${(alive / N).toFixed(0)}s  3min ${surv}/${N}  kills ${(kills / N).toFixed(1)}  sw/min ${(sw / N).toFixed(1)}  interrupted ${(wasted / N).toFixed(1)}  cost/tick ${(cost / dec).toFixed(2)} max ${maxCost}` + (replans ? ` replans/fight ${(replans / N).toFixed(0)} expanded/replan ${(cost / replans).toFixed(1)}` : ''));
}
