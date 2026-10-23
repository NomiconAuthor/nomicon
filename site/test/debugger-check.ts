// Replaying a trace on the "before" snapshot must give the real "after" storage:
// that is what makes stepping through the debugger truthful.
import { readFileSync } from 'node:fs';
import { Session, type Scenario } from '../src/flecs/debugger/session';
import type { StorageModel } from '../src/flecs/debugger/model';
import { SCENARIOS } from '../src/flecs/scenarios';

const wasm = readFileSync(new URL('../public/flecs.wasm', import.meta.url));
(globalThis as any).fetch = async (u: string) => new Response(u === '/flecs.wasm' ? wasm : readFileSync(new URL('../public' + u, import.meta.url)), { headers: { 'content-type': 'application/wasm' } });

let fails = 0;
const check = (label: string, ok: boolean, extra: unknown = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`, ok ? '' : extra);
};

function layout(m: StorageModel, names: (e: number) => string) {
  const tables = m.sortedTables().map((t) => `${t.id}:[${t.type.map((c) => c.str).join(',')}] ${t.rows.map(names).join(',')}`);
  const sparse = [...m.sparse.values()].map((s) => `${s.id}: ${s.entities.map(names).join(',')}`);
  return [...tables, ...sparse].join('\n');
}

const scenarios: Scenario[] = [
  {
    id: 'moves',
    title: 'moves',
    setup: `struct Position(x: f32, y: f32)\nstruct Velocity(x: f32, y: f32)\nA { Position: {1, 2} }\nB { Position: {3, 4} }\nC { Position: {5, 6} }`,
    ops: [
      { code: 'A.set<Velocity>', run: (c) => c.set('A', 'Velocity', { x: 1, y: 0 }) },
      { code: 'C.set<Velocity>', run: (c) => c.set('C', 'Velocity', { x: 1, y: 0 }) },
      { code: 'B.remove<Position>', run: (c) => c.remove('B', 'Position') },
      { code: 'new D', run: (c) => c.create('D', { Position: { x: 0, y: 0 }, Velocity: { x: 2, y: 2 } }) },
      { code: 'delete A', run: (c) => c.delete('A') },
    ],
  },
  {
    id: 'deferred',
    title: 'deferred',
    setup: `struct Position(x: f32, y: f32)\nstruct Velocity(x: f32, y: f32)\nMoved {}\nA { Position: {1, 2}\n Velocity: {1, 1} }\nB { Position: {3, 4}\n Velocity: {1, 1} }`,
    systems: [
      { name: 'Move', query: 'Position, [in] Velocity', fn: (it) => { const p = it.field<any>(0), v = it.field<any>(1); for (let i = 0; i < it.count; i++) it.set(0, i, { x: p[i].x + v[i].x, y: p[i].y + v[i].y }); } },
      { name: 'Mark', query: 'Position, !Moved', fn: (it) => { for (const e of it.entities) it.add(e, 'Moved'); } },
    ],
    ops: [
      { code: 'progress', run: (c) => c.progress() },
      { code: 'progress', run: (c) => c.progress() },
    ],
  },
  {
    id: 'sparse',
    title: 'sparse',
    setup: `struct Position(x: f32, y: f32)\nstruct Health(v: f32)\nHealth { Sparse }\nstruct Owner(v: f32)\nOwner { DontFragment }\nA { Position: {1, 2} }\nB { Position: {3, 4} }`,
    sparse: ['Health', 'Owner'],
    ops: [
      { code: 'A.set<Health>', run: (c) => c.set('A', 'Health', { v: 10 }) },
      { code: 'B.set<Owner>', run: (c) => c.set('B', 'Owner', { v: 1 }) },
      { code: 'A.set<Owner>', run: (c) => c.set('A', 'Owner', { v: 2 }) },
      { code: 'B.remove<Owner>', run: (c) => c.remove('B', 'Owner') },
      { code: 'A.remove<Health>', run: (c) => c.remove('A', 'Health') },
    ],
  },
];

const runs: Array<[Scenario, number]> = [];
for (const sc of scenarios) runs.push([sc, 0]);
for (const sc of Object.values(SCENARIOS)) for (let v = 0; v < Math.max(1, sc.variants?.length ?? 0); v++) runs.push([sc, v]);
const verbose = process.argv.includes('-v');
for (const [sc0, variant] of runs) {
  const sc = { ...sc0, id: sc0.variants ? `${sc0.id}/${sc0.variants[variant].label}` : sc0.id };
  const s = new Session(sc);
  s.variant = variant;
  await s.start();
  check(`${sc.id}: setup ok`, !s.setupError, s.setupError);
  if (verbose) console.log(layout(s.base, (e) => s.name(e)).replace(/^/gm, '      '));
  let i = 0;
  while (s.queue.length) {
    const rec = s.runNext()!;
    check(`${sc.id}: op ${i} ran`, !rec.error, rec.error);
    const replay = s.stateAt({ op: i, ev: rec.events.length - 1 });
    const last = rec.before.clone();
    for (const ev of rec.events) last.apply(ev, rec.after, rec.types);
    const want = layout(rec.after, (e) => s.name(e));
    const got = layout(last, (e) => s.name(e));
    check(`${sc.id}: op ${i} (${rec.op.code}) replay matches real storage`, want === got, { want, got });
    void replay;
    if (verbose) console.log(`      ${rec.events.length} events: ${[...new Set(rec.events.map((e) => e.k))].join(' ')}`);
    i++;
  }
  if (s.done.length) console.log(layout(s.done.at(-1)!.after, (e) => s.name(e)).replace(/^/gm, '      '));
  const iters = s.done.map((r) => r.events.filter((e) => e.k === 'iter' && (s.systems.has(e.system) || s.queryById.has(e.system))).length).filter(Boolean);
  if (iters.length) console.log(`      callbacks per frame/iteration: ${iters.join(', ')}`);
  // The sync points lesson: where frame 1's merge lands relative to Burn.
  if (sc0.id === 'syncPoints') {
    const evs = s.done[0].events;
    const burn = evs.findIndex((e) => e.k === 'systemBegin' && e.name === 'Burn');
    const flush = evs.findIndex((e) => e.k === 'flushBegin' && s.flushHasUserWork(e));
    const want = variant === 0 ? 'after Burn' : 'before Burn';
    check(`${sc.id}: frame 1 merges ${want}`, burn >= 0 && flush >= 0 && (variant === 0 ? flush > burn : flush < burn), { burn, flush });
  }
}
process.exitCode = fails ? 1 : 0;
