// Headless runs of the local avoidance widget. Run with `npm run avoid-batch`. The local avoidance lesson quotes these.
import { AvoidSim, type AvoidMethod, type AvoidScene } from '../src/ai/avoid';
for (const scene of ['circle', 'groups', 'cross'] as AvoidScene[]) {
  for (const count of [24, 48]) {
    console.log(`\n== ${scene}, ${count} agents`);
    for (const m of ['none', 'separation', 'social', 'vo', 'rvo', 'orca'] as AvoidMethod[]) {
      const sim = new AvoidSim(m, scene, count);
      const t0 = performance.now();
      const s = sim.run();
      const ms = performance.now() - t0;
      const steps = Math.round(s.time * 60);
      console.log(
        m.padEnd(11),
        (s.allDoneAt >= 0 ? `${s.allDoneAt.toFixed(1)} s` : `${sim.agents.filter((a) => !a.done).length} not there`).padStart(14),
        `overlap ${s.overlap.toFixed(0)}`.padStart(13),
        `detour ×${sim.detour().toFixed(2)}`.padStart(13),
        `turn ${((s.turn / Math.max(1e-6, s.agentTime)) * 180 / Math.PI).toFixed(0)}°/s`.padStart(12),
        `${((ms * 1000) / steps / count).toFixed(1)} µs/agent/step`.padStart(20),
      );
    }
  }
}
