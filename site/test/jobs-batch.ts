// Headless runs of the job-system widgets. Run with `npm run jobs-batch`. The jobs lesson quotes these.
import { FRAME, criticalPath, frameJobs, itemCosts, parallelFor, simulate, systemDeps, type GraphMode, type Policy } from '../src/engine/jobsim';
const costs = itemCosts();
const total = costs.reduce((a, b) => a + b, 0);
console.log(`parallel-for: ${costs.length} items, ${total.toFixed(0)} µs of work`);
for (const W of [4, 8, 16])
  for (const policy of ['static', 'queue', 'steal'] as Policy[]) {
    const row: string[] = [];
    for (const chunk of [1, 8, 64, 256]) {
      const r = simulate(parallelFor(costs, chunk), { workers: W, policy });
      row.push(`chunk ${String(chunk).padStart(3)}: ${r.makespan.toFixed(0).padStart(5)} µs (${((total / W / r.makespan) * 100).toFixed(0)}%, ovh ${r.overhead.toFixed(0)})`);
    }
    console.log(`W=${W} ${policy.padEnd(6)}`, row.join(' | '));
  }
const sum = FRAME.reduce((a, s) => a + s.cost, 0);
console.log(`\nframe: ${sum} µs of work`);
for (const W of [1, 4, 8, 16])
  for (const mode of ['serial', 'barriers', 'graph', 'deferred'] as GraphMode[]) {
    if (mode === 'serial' && W > 1) continue;
    const { jobs, deps } = frameJobs(FRAME, mode, W);
    const r = simulate(jobs, { workers: mode === 'serial' ? 1 : W, policy: 'steal' });
    const cp = criticalPath(FRAME, deps);
    console.log(`W=${W} ${mode.padEnd(9)} ${r.makespan.toFixed(0).padStart(6)} µs  util ${((r.work / (r.makespan * W)) * 100).toFixed(0)}%  crit ${cp.path.map((i) => FRAME[i].name).join(' > ')}`);
  }
console.log(systemDeps(FRAME).map((d, i) => `${FRAME[i].name} <- ${d.map((x) => FRAME[x].name).join(', ')}`).join('\n'));
