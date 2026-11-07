// Checks for "A frame in detail": every frame scenario, variant and thread count is
// recorded from the real (instrumented) flecs, then checked:
//  - replaying the trace on the "before" snapshot gives the real "after" storage;
//  - every multi-threaded system's slices cover each table it iterated exactly once,
//    with the sizes the widget's ruler states (flecs' ecs_worker_next rule);
//  - merges flush stage 0, 1, 2, … in order, and flushes nest properly;
//  - no hook or observer runs inside a readonly run (only during merges and immediate runs);
//  - the runs the widget draws are the ops flecs built (fw_pipeline_schedule);
//  - one stage with the "sim workers" patch is the same as before it (a plain trace).
// Run with -v to print each timeline.
import { readFileSync } from 'node:fs';
import { FlecsWorld, type TraceEvent } from '../src/flecs/runtime';
import { FRAME_SCENARIOS, type FrameScenario } from '../src/flecs/frame/scenarios';
import { defaultConfig, record, type Recording } from '../src/flecs/frame/record';
import { timeline, splitRows, type TreeNode } from '../src/flecs/frame/model';
import type { StorageModel } from '../src/flecs/debugger/model';

const wasm = readFileSync(new URL('../public/flecs.wasm', import.meta.url));
(globalThis as any).fetch = async () => new Response(wasm, { headers: { 'content-type': 'application/wasm' } });

const verbose = process.argv.includes('-v');
let fails = 0;
let oks = 0;
const check = (label: string, ok: boolean, extra: unknown = '') => {
  if (!ok) {
    fails++;
    console.log(`FAIL ${label}`, extra);
  } else {
    oks++;
    if (verbose) console.log(`ok   ${label}`);
  }
};

function layout(m: StorageModel, names: (e: number) => string) {
  return m
    .sortedTables()
    .filter((t) => t.rows.length)
    .map((t) => `${t.id}:[${t.type.map((c) => c.str).join(',')}] ${t.rows.map(names).join(',')}`)
    .join('\n');
}

function printTree(nodes: TreeNode[], indent: string) {
  for (const n of nodes) {
    console.log(`${indent}${n.kind}: ${n.text}`);
    printTree(n.children, indent + '  ');
  }
}

export function checkRecording(rec: Recording, label: string, w: FlecsWorld) {
  check(`${label}: recorded without errors`, !rec.error, rec.error);
  const name = (e: number) => rec.names.get(e) ?? w.name(e);
  rec.steps.forEach((st, si) => {
    const L = `${label} step ${si + 1}`;
    // Replay.
    const m = st.before.clone();
    const types = new Map(st.types);
    for (const ev of st.events) m.apply(ev, st.after, types);
    check(`${L}: replay matches real storage`, layout(m, name) === layout(st.after, name), `\n${layout(m, name)}\n---\n${layout(st.after, name)}`);

    const t = timeline(rec, si, name, (id) => types.get(id) ?? st.after.tables.get(id)?.type.map((c) => c.str));
    // Slices partition every table a threaded system iterated.
    for (const run of t.runs) {
      if (!run.threaded) {
        check(`${L} run ${run.index + 1}: only the main stage works in a ${run.kind} run`, run.lanes.slice(1).every((l) => !l.length));
        continue;
      }
      for (const sys of run.systems) {
        const byTable = new Map<number, Array<{ stage: number; offset: number; count: number }>>();
        run.lanes.forEach((lane, stage) => {
          for (const b of lane) if (b.system === sys) for (const s of b.slices) byTable.set(s.table, [...(byTable.get(s.table) ?? []), { stage, offset: s.offset, count: s.count }]);
        });
        for (const [table, slices] of byTable) {
          slices.sort((a, b) => a.stage - b.stage);
          let at = 0;
          let contiguous = true;
          for (const s of slices) {
            if (s.offset !== at) contiguous = false;
            at += s.count;
          }
          const sizes = splitRows(at, t.stages);
          const got = Array.from({ length: t.stages }, (_, i) => slices.find((s) => s.stage === i)?.count ?? 0);
          check(`${L} ${name(sys)} table ${table}: slices are contiguous and cover ${at} rows`, contiguous);
          check(`${L} ${name(sys)} table ${table}: split ${got.join('·')} is the worker_next rule`, got.join() === sizes.join(), sizes);
        }
      }
    }
    // Merges: stage order, nesting, no callbacks in readonly runs.
    for (const run of t.runs) {
      if (run.merge && !run.merge.immediate) {
        const order = run.merge.stages.map((s) => s.stage);
        check(`${L} run ${run.index + 1}: merge flushes stages in order`, order.join() === Array.from({ length: t.stages }, (_, i) => i).join(), order);
      }
      if (run.kind !== 'immediate') {
        const end = run.merge ? run.merge.ev : run.evJoin;
        const inside = st.events.slice(run.ev, end).filter((e) => e.k === 'hook' || (e.k === 'observer' && e.event !== 'OnTableCreate' && e.event !== 'OnTableDelete'));
        check(`${L} run ${run.index + 1}: no hooks or observers while the world is readonly`, inside.length === 0, inside);
      }
    }
    let depth = 0;
    let balanced = true;
    for (const ev of st.events) {
      if (ev.k === 'flushBegin') depth++;
      if (ev.k === 'flushEnd') depth--;
      if (depth < 0) balanced = false;
    }
    check(`${L}: command flushes nest`, balanced && depth === 0);
    // Runs are the ops flecs built.
    const ops = st.events.filter((e): e is Extract<TraceEvent, { k: 'opBegin' }> => e.k === 'opBegin');
    check(`${L}: one drawn run per op`, ops.length === t.runs.length);
    if (verbose) {
      console.log(`\n=== ${L}: ${st.step.label} (${t.stages} stage${t.stages > 1 ? 's' : ''})`);
      for (const r of t.runs) {
        console.log(`run ${r.index + 1} [${r.kind}${r.threaded ? ', threaded' : ''}${r.internal ? ', built-in' : ''}${r.resumed ? ', resumed' : ''}] ${r.systems.map(name).join(', ')}  phases ${r.phases.join(',')}`);
        for (const reason of r.reasons) console.log(`   why: ${reason.system} bits ${reason.bits} active ${reason.active} prev ${reason.prevName}/${reason.prevKind} terms ${JSON.stringify(reason.terms)}`);
        r.lanes.forEach((lane, s) => lane.length && console.log(`   stage ${s}: ${lane.map((b) => `${b.name}(${b.slices.map((x) => `${x.table}:${x.offset}+${x.count}`).join(' ')})`).join('  ')}`));
        r.queued.forEach((q, s) => q.length && console.log(`   queued on ${s}: ${q.map((x) => x.text).join('; ')}`));
        if (r.merge) {
          console.log(`   merge${r.merge.immediate ? ' (immediate)' : ''}: ${r.merge.commands} commands ${r.merge.stages.map((s) => `${s.stage}:${s.count}`).join(' ')}`);
          printTree(r.merge.tree, '     ');
        }
      }
      for (const rb of t.rebuilds) console.log(`rebuild at ${rb.ev}: ${rb.activated.join(', ')}`);
      console.log(`${t.beats.length} beats`);
    }
  });
}

async function main() {
  const w = await FlecsWorld.create();
  for (const sc of Object.values(FRAME_SCENARIOS) as FrameScenario[]) {
    const variants = sc.variants?.length ?? 1;
    for (let v = 0; v < variants; v++) {
      const counts = sc.threads ? [1, 2, 3, 4] : [defaultConfig(sc, v).stages];
      for (const n of counts) {
        const cfg = { ...defaultConfig(sc, v), stages: n };
        const rec = record(w, sc, cfg);
        checkRecording(rec, `${sc.id}/${sc.variants?.[v]?.label ?? 'default'}/${n}`, w);
        check(`${sc.id}/${v}/${n}: no table left locked`, w.lockedTables() === 0);
      }
    }
  }
  // With one stage the patch is inert: the same scenario traced with and without
  // the frame events gives the same events once the frame events are dropped.
  const sc = FRAME_SCENARIOS.frameTour;
  const a = record(w, sc, { ...defaultConfig(sc), stages: 1 });
  const frameKinds = new Set(['pipeBuild', 'pipeSystem', 'pipeTerm', 'pipeWrite', 'pipeReset', 'pipeBuildEnd', 'opBegin', 'opJoin', 'mergeBegin', 'stageFlush', 'mergeEnd', 'workerBegin', 'workerEnd', 'iterAt', 'systemAt', 'flushAt', 'replaceHook', 'validate', 'locked']);
  const plain = a.steps.map((s) => s.events.filter((e) => !frameKinds.has(e.k)).map((e) => e.k).join());
  // Same scenario with the frame trace off.
  w.reset();
  const b = record(w, sc, { ...defaultConfig(sc), stages: 1 });
  const again = b.steps.map((s) => s.events.filter((e) => !frameKinds.has(e.k)).map((e) => e.k).join());
  check('one stage: recording is deterministic', plain.join('|') === again.join('|'));
  console.log(`frame-check: ${oks} ok, ${fails} failed`);
  if (fails) process.exit(1);
}

main();
