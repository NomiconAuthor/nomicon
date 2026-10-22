// Numbers for the "threads, pools and fibers" lesson: npm run wait-batch
import { COSTS, frameWorkload, simulateWait, type Mode } from '../src/engine/waitsim';
import { pipeline } from '../src/engine/waiting';

const modes: Mode[] = ['block', 'help', 'fiber', 'coroutine', 'threads'];
for (const nested of [false, true]) {
const wl = frameWorkload(nested);
const total = wl.tasks.reduce((a, t) => a + t.pre + t.post, 0);
console.log(`\n=== nested ${nested}: tasks ${wl.tasks.length}, waiting ${wl.tasks.filter((t) => t.children.length).length}, work ${total.toFixed(0)} µs`);
for (const W of [4, 8, 16]) {
  console.log(`\n${W} cores (perfect split ${(total / W).toFixed(0)} µs)`);
  for (const m of modes) {
    const r = simulateWait(wl.tasks, wl.roots, m, W);
    const f = (x: number) => x.toFixed(0);
    console.log(
      m.padEnd(10),
      r.deadlock ? `DEADLOCK after ${r.finished}/${wl.tasks.length} tasks, ${f(r.makespan)} µs` : `${f(r.makespan)} µs`,
      `eff ${f((total / W / r.makespan) * 100)}%`,
      `blocked ${f(r.blocked)}  spin ${f(r.spin)}  overhead ${f(r.overhead)}  idle ${f(r.idle)}`,
      `depth ${r.maxDepth}  late avg ${(r.lateTotal / 42).toFixed(1)} max ${f(r.lateMax)}`,
      `contexts ${r.peakContexts}  mem ${f(r.memoryKiB)} KiB  switches ${r.switches}`,
    );
  }
}
}
void COSTS;

console.log('\n=== pipeline (game 10, render 8, gpu 9 ms)');
for (const l of ['one', 'two', 'three'] as const) {
  const p = pipeline(l, 10, 8, 9, 12);
  console.log(l.padEnd(6), `frame ${p.frameTime.toFixed(1)} ms (${(1000 / p.frameTime).toFixed(0)} fps)  latency ${p.latency.toFixed(1)} ms  in flight ${p.inFlight.toFixed(1)}`);
}
for (const [g, r, q] of [[14, 8, 9], [6, 12, 9], [10, 8, 12]]) for (const l of ['one', 'two', 'three'] as const) {
  const p = pipeline(l, g, r, q, 12);
  console.log(`g${g} r${r} gpu${q}`, l.padEnd(6), `frame ${p.frameTime.toFixed(1)} ms latency ${p.latency.toFixed(1)}`);
}
