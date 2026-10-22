// Headless runs of the boss fight over 20 seeds. Run with `npm run party-batch`. The party roles lesson quotes these.
import { SETUPS, summarise, type BossSettings } from '../src/party/sim';
const N = Number(process.env.N ?? 20); // the widget's batch button and the lesson use 20

const t0 = performance.now();
const extra: Array<[string, Partial<BossSettings>]> = [
  ['Full speed + no margin', { dps: 'nuke', targeting: 'top' }],
  ['Full speed + nearest', { dps: 'nuke', targeting: 'nearest' }],
];
for (const [name, over] of [...SETUPS, ...extra]) {
  const s = summarise(over, N);
  console.log(
    name.padEnd(24),
    `wins ${s.wins}/${N}`,
    `time ${s.time.toFixed(0)} s`,
    `deaths tank ${s.deaths.tank} cleric ${s.deaths.healer} damage ${s.deaths.damage}`,
    `switches ${s.switches.toFixed(1)}`,
    `offTank ${s.offTank.toFixed(1)} s`,
    `nonTank ${s.nonTank.toFixed(0)}`,
    `overheal ${((100 * s.overheal) / s.healed).toFixed(0)}%`,
    `caught ${s.caught.toFixed(1)}`,
    `mana ${s.manaLeft.toFixed(0)}`,
  );
}
console.log(`${((performance.now() - t0) / 1000).toFixed(1)} s`);
