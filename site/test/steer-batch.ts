// Headless runs of the steering course, summed over its three maps. Run with `npm run steer-batch`.
// The steering lesson's tables quote these numbers.
import { CourseSim, DEFAULT_SETTINGS, TIME_LIMIT, type CourseSettings } from '../src/ai/course';
const agg = (label: string, o: Partial<CourseSettings>) => {
  let t = 0, c = 0, at = 0, stuck = 0, turn = 0, rays = 0;
  for (const course of ['bends', 'pillars', 'deadend']) {
    const s = new CourseSim({ ...DEFAULT_SETTINGS, ...o, course }).run();
    t += s.allThroughAt >= 0 ? s.allThroughAt : TIME_LIMIT;
    stuck += 6 - s.through;
    c += s.contact; at += s.agentTime; turn += s.turn; rays += s.rays;
  }
  console.log(label.padEnd(34), `${t.toFixed(1)} s`.padStart(8), `stuck ${stuck}`.padStart(9), `contact ${((100 * c) / at).toFixed(1)}%`.padStart(14), `turn ${((turn / at) * 180 / Math.PI).toFixed(0)}°/s`.padStart(13), `rays/agent/s ${(rays / at).toFixed(0)}`.padStart(18));
};
console.log('== sensing (static | moving crates)');
for (const sense of ['none', 'feeler', 'whiskers', 'query', 'context'] as const) { agg(sense, { sense }); agg(`${sense} + crates`, { sense, crates: true }); }
console.log('\n== context ring size');
for (const slots of [8, 12, 16, 24, 32]) for (const hysteresis of [true, false]) agg(`${slots} slots${hysteresis ? '' : ', no hysteresis'}`, { slots, hysteresis });
console.log('\n== casting every N ticks');
for (const every of [1, 2, 4, 8, 16]) { agg(`every ${every}`, { every }); agg(`every ${every} + crates`, { every, crates: true }); }
console.log('\n== path following');
for (const follow of ['waypoint', 'carrot', 'goal'] as const) { agg(`${follow} (context)`, { follow }); agg(`${follow} (none)`, { follow, sense: 'none' }); }
console.log('\n== motion model');
for (const motion of ['point', 'spot', 'car'] as const) for (const sense of ['context', 'whiskers'] as const) agg(`${motion} (${sense})`, { motion, sense });
