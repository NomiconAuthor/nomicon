// Node smoke test for the flecs wasm runtime: npx tsx test/runtime-check.ts (or via esbuild).
import { readFileSync } from 'node:fs';
import { FlecsWorld } from '../src/flecs/runtime';

const wasm = readFileSync(new URL('../public/flecs.wasm', import.meta.url));
(globalThis as any).fetch = async () => new Response(wasm, { headers: { 'content-type': 'application/wasm' } });

let fails = 0;
const check = (label: string, ok: boolean, extra: unknown = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`, ok ? '' : extra);
};

const w = await FlecsWorld.create();
const s = w.script(`
struct Position(x: f32, y: f32)
struct Velocity(x: f32, y: f32)
Ship {
  Position: {1, 2}
  Velocity: {1, 0}
}
Rock {
  Position: {5, 5}
}
`);
check('script runs', s.ok, s);
const q = w.rest<any>('GET', '/query', { expr: 'Position, Velocity', values: true });
check('REST query finds the ship', q.status === 200 && q.body.results?.length === 1, q);
console.log('   ', q.call, JSON.stringify(q.body).slice(0, 160));
const tables = w.tables();
const user = tables.filter((t) => t.type.some((c) => c.str === 'Position'));
check('two archetypes with Position', user.length === 2, user.map((t) => t.type.map((c) => c.str)));
console.log('    ', user.map((t) => `${t.id}: [${t.type.map((c) => c.str).join(', ')}] ${JSON.stringify(t.type.find((c) => c.str === 'Position')?.values)}`));

const seen: string[] = [];
const sys = w.system('Move', 'Position, [in] Velocity', (it) => {
  const p = it.field<{ x: number; y: number }>(0);
  const v = it.field<{ x: number; y: number }>(1);
  for (let i = 0; i < it.count; i++) it.set(0, i, { x: p[i].x + v[i].x, y: p[i].y + v[i].y });
  seen.push(`table ${it.table} × ${it.count}`);
});
// Operations inside a system are commands: they run at the end of the frame.
let tagged = 0;
w.script('Moved {}', 'tags');
w.system('Tagger', 'Position, Velocity, !Moved', (it) => {
  for (const e of it.entities) it.add(e, 'Moved');
  tagged += it.count;
});
check('system created', sys > 0);
w.progress();
w.progress();
const ship = w.lookup('Ship');
const pos = w.rest<any>('GET', '/component/Ship', { component: 'Position' });
check('system moved the ship twice', pos.body?.x === 3, pos);
check('system saw one table per frame', seen.length === 2, seen);
check('deferred add ran once, then the entity stopped matching', tagged === 1, tagged);
const shipTable = w.tables().find((t) => t.entities.includes(ship));
check('ship moved to the table with Moved', !!shipTable?.type.some((c) => c.str === 'Moved'), shipTable?.type.map((c) => c.str));

const events: string[] = [];
w.observer('Watch', 'Velocity', ['OnAdd', 'OnSet', 'OnRemove'], (it) => events.push(`${it.event} ${it.eventId} on ${it.entities.map((e) => it.name(e)).join(',')}`));
w.rest('PUT', '/component/Rock', { component: 'Velocity', value: JSON.stringify({ x: 0, y: 1 }) });
w.rest('DELETE', '/component/Rock', { component: 'Velocity' });
check('observer saw add, set, remove', events.length === 3, events);
console.log('    ', events);
w.observer('Hit', 'Position', ['Collided'], (it) => events.push(`${it.event} on ${it.name(it.entities[0])}`));
w.emit('Collided', ship, 'Position');
check('custom event', events.at(-1) === 'Collided on Ship', events.at(-1));

const qt = w.queryTables('Position');
check('queryTables lists both tables', qt?.length === 2, qt);
const bad = w.system('Bad', 'Position,, Foo(', () => {});
check('bad query returns 0', bad === 0);
console.log('    log:', w.log.slice(-2).map((l) => l.text));
const tbls = w.rest<any>('GET', '/tables');
check('REST /tables works', Array.isArray(tbls.body), tbls.status);
w.reset();
check('reset empties the world', w.lookup('Ship') === 0);
const w2 = await FlecsWorld.create();
check('second world is independent', w2.lookup('Ship') === 0);
process.exitCode = fails ? 1 : 0;
