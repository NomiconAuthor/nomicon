/**
 * Turns one recorded step (a progress() or run_pipeline()) into what the frame
 * widget draws: the schedule's runs, what each stage ran, every merge as a call
 * tree, why each merge is where it is, and the beats the cursor steps through.
 * Pure: the widget and the tests both use it, so the lesson can't drift from it.
 */
import type { TraceEvent } from '../runtime';
import type { Kind } from './scenarios';
import type { Recording, StepRecord, SystemInfo } from './record';

export interface Slice {
  table: number;
  offset: number;
  count: number;
  ev: number;
}

/** One system on one stage within a run. */
export interface Block {
  system: number;
  name: string;
  stage: number;
  slices: Slice[];
  rows: number;
  ev: number;
  evEnd: number;
  internal: boolean;
}

export type NodeKind = 'stage' | 'flush' | 'cmd' | 'move' | 'hook' | 'observer' | 'validate' | 'replace' | 'locked' | 'call' | 'system' | 'iter' | 'caches' | 'create';

export interface TreeNode {
  kind: NodeKind;
  text: string;
  ev: number;
  children: TreeNode[];
  /** Stage the work came from (stage nodes and their contents). */
  stage?: number;
  /** For flush nodes: nesting level (0 = a stage's own queue). */
  depth?: number;
  warn?: boolean;
  /** flecs' own bookkeeping (a system entity's Empty tag). */
  internal?: boolean;
}

/** Hooks flecs has on its own components (names, …) aren't the lesson's. */
const isInternalId = (id: string) => id.startsWith('(Identifier') || id.startsWith('flecs.') || id.startsWith('(flecs.');

/** Why a merge goes before a system (from flecs_pipeline_build). */
export interface Reason {
  system: string;
  active: boolean;
  internal: boolean;
  /** Bits: 1 a term needs it, 2 threading kind changed, 4 immediate kind changed, 8 the system is immediate. */
  bits: number;
  terms: Array<{ id: string; how: number; writers: string[] }>;
  /** The kind of the active system before it (for kind changes). */
  prevKind?: Kind;
  prevName?: string;
}

export interface Merge {
  ev: number;
  evEnd: number;
  immediate: boolean;
  /** Commands queued per stage when the merge started (stage order). */
  stages: Array<{ stage: number; count: number; ev: number }>;
  commands: number;
  tree: TreeNode[];
}

export interface Run {
  index: number;
  kind: Kind;
  /** Split over the worker stages (a multi-threaded run with more than one stage). */
  threaded: boolean;
  systems: number[];
  lanes: Block[][];
  ev: number;
  evJoin: number;
  merge: Merge | null;
  /** Why a merge comes before this run (empty for the first run). */
  reasons: Reason[];
  phases: string[];
  internal: boolean;
  /** The run continued after a mid-step rebuild (only part of its systems ran here). */
  resumed: boolean;
  /** Deferred operations queued during this run's systems, by stage. */
  queued: Array<Array<{ text: string; ev: number }>>;
}

export interface Rebuild {
  ev: number;
  /** Systems that are in the new schedule but weren't in the old one. */
  activated: string[];
}

export interface Beat {
  ev: number;
  run: number;
  stage: number;
  /** In a merge (or an immediate run's flush). */
  merging: boolean;
  text: string;
}

export interface Timeline {
  stages: number;
  runs: Run[];
  beats: Beat[];
  rebuilds: Rebuild[];
  /** Systems that ran, in schedule order, by id. */
  systems: Map<number, SystemInfo>;
}

/** One pipeline build: per system, in pipeline order, what the builder concluded. */
export interface Build {
  ev: number;
  entries: Array<{ system: number; name: string; active: boolean; kind: Kind; merge: boolean; bits: number; terms: Reason['terms']; queued: Map<string, string[]> }>;
}

const kindOf = (mt: boolean, imm: boolean): Kind => (imm ? 'immediate' : mt ? 'multi' : 'single');

/** Every schedule build in the recording, in order, as [step, Build]. */
export function builds(rec: Recording): Array<[number, Build]> {
  const out: Array<[number, Build]> = [];
  rec.steps.forEach((st, si) => {
    let cur: Build | null = null;
    let writers = new Map<string, string[]>();
    let terms: Reason['terms'] = [];
    for (let i = 0; i < st.events.length; i++) {
      const ev = st.events[i];
      if (ev.k === 'pipeBuild') {
        cur = { ev: i, entries: [] };
        writers = new Map();
        terms = [];
      } else if (!cur) continue;
      else if (ev.k === 'pipeWrite') {
        const who = rec.systems.get(ev.system)?.name ?? `#${ev.system}`;
        const list = writers.get(ev.id) ?? [];
        if (!list.includes(who)) list.push(who);
        writers.set(ev.id, list);
      } else if (ev.k === 'pipeTerm') {
        const ws = [...(writers.get(ev.id) ?? []), ...(ev.id !== '*' ? writers.get('*') ?? [] : [])];
        terms.push({ id: ev.id, how: ev.reason, writers: ws });
      } else if (ev.k === 'pipeSystem') {
        const info = rec.systems.get(ev.system);
        cur.entries.push({
          system: ev.system,
          name: info?.name ?? ev.name,
          active: ev.active,
          kind: kindOf(ev.multiThreaded, ev.immediate),
          merge: ev.merge,
          bits: ev.reason,
          terms,
          queued: new Map([...writers].map(([k, v]) => [k, [...v]])),
        });
        terms = [];
      } else if (ev.k === 'pipeReset') {
        writers = new Map();
      } else if (ev.k === 'pipeBuildEnd') {
        out.push([si, cur]);
        cur = null;
      }
    }
  });
  return out;
}

/** The schedule a build produced: active systems split into runs, with the reasons for each boundary. */
export function schedule(build: Build, systems: Map<number, SystemInfo>): Array<{ systems: number[]; kind: Kind; reasons: Reason[] }> {
  const runs: Array<{ systems: number[]; kind: Kind; reasons: Reason[] }> = [];
  let pending: Reason[] = [];
  let prev: { kind: Kind; name: string } | null = null;
  for (const e of build.entries) {
    const internal = systems.get(e.system)?.internal ?? e.name.startsWith('flecs.');
    const reason: Reason = { system: e.name, active: e.active, internal, bits: e.bits, terms: e.terms, prevKind: prev?.kind, prevName: prev?.name };
    if (!e.active) {
      if (e.merge && prev) pending.push(reason);
      continue;
    }
    if (!runs.length || e.merge || pending.length) {
      runs.push({ systems: [e.system], kind: e.kind, reasons: runs.length ? [...pending, ...(e.merge ? [reason] : [])] : [] });
      pending = [];
    } else runs[runs.length - 1].systems.push(e.system);
    prev = { kind: e.kind, name: e.name };
  }
  return runs;
}

/** What the builder knew when it reached `system` and decided there was no merge before it. */
export function noMergeWhy(build: Build, system: number): { queued: Map<string, string[]>; kind: Kind; prev?: string } | null {
  const i = build.entries.findIndex((e) => e.system === system);
  if (i < 0) return null;
  const prev = build.entries.slice(0, i).reverse().find((e) => e.active);
  return { queued: build.entries[i].queued, kind: build.entries[i].kind, prev: prev?.name };
}

/** Is this observer call one of flecs' own query-cache notifications? */
const isCacheEvent = (ev: TraceEvent) => ev.k === 'observer' && (ev.event === 'OnTableCreate' || ev.event === 'OnTableDelete');

export function timeline(rec: Recording, stepIndex: number, name: (e: number) => string, types: (t: number) => string[] | undefined): Timeline {
  const st: StepRecord = rec.steps[stepIndex];
  const evs = st.events;
  // Builds of the pipeline this step ran (each pipeline has its own schedule).
  const all = builds(rec).filter(([s]) => rec.steps[s].pipeline === st.pipeline);
  // The schedule in force at the start of this step: the last build before it (or the first one in it).
  let build = [...all].reverse().find(([s]) => s < stepIndex)?.[1] ?? null;
  const stageCount = Math.max(1, ...evs.filter((e): e is Extract<TraceEvent, { k: 'opBegin' }> => e.k === 'opBegin').map((e) => e.stages));
  const runs: Run[] = [];
  const beats: Beat[] = [];
  const rebuilds: Rebuild[] = [];
  const tl = (t: number) => tableName(types(t), t);
  let run: Run | null = null;
  let stage = 0;
  let merging = false;
  let block: Block | null = null;
  let sched: ReturnType<typeof schedule> = [];
  const sysInfo = (id: number) => rec.systems.get(id);

  const beat = (i: number, text: string) => beats.push({ ev: i, run: run ? run.index : -1, stage, merging, text });

  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    switch (ev.k) {
      case 'pipeBuild': {
        const b = all.find(([s, x]) => s === stepIndex && x.ev === i)?.[1];
        if (b) {
          const old = build ? new Set(build.entries.filter((e) => e.active).map((e) => e.name)) : null;
          build = b;
          if (old) {
            const activated = b.entries.filter((e) => e.active && !old.has(e.name)).map((e) => e.name);
            rebuilds.push({ ev: i, activated });
            beat(i, `Schedule rebuilt${activated.length ? `: ${activated.join(', ')} now ${activated.length > 1 ? 'match' : 'matches'} something` : ''}`);
          }
        }
        break;
      }
      case 'opBegin': {
        sched = build ? schedule(build, rec.systems) : [];
        const shape = sched[ev.op];
        const ids = shape?.systems ?? [];
        const resumed = !!runs.length && runs[runs.length - 1].index === ev.op;
        const kind = ev.immediate ? 'immediate' : ev.multiThreaded ? 'multi' : 'single';
        run = {
          index: runs.length,
          kind,
          threaded: ev.threaded,
          systems: [],
          lanes: Array.from({ length: stageCount }, () => []),
          ev: i,
          evJoin: -1,
          merge: null,
          reasons: shape?.reasons ?? [],
          phases: [],
          internal: ids.length > 0 && ids.every((s) => sysInfo(s)?.internal),
          resumed: false,
          queued: Array.from({ length: stageCount }, () => []),
        };
        void resumed;
        // After a rebuild mid-run the op is entered part way (from > the op's first system).
        const first = ids.length ? ids[0] : 0;
        const firstIdx = build ? build.entries.filter((e) => e.active).findIndex((e) => e.system === first) : -1;
        run.resumed = firstIdx >= 0 && ev.from > firstIdx;
        runs.push(run);
        stage = 0;
        merging = false;
        beat(i, `Run ${run.index + 1} starts: ${kindLabel(kind, ev.threaded)}`);
        break;
      }
      case 'systemAt': {
        if (!run) break;
        stage = ev.stage;
        const info = sysInfo(ev.system);
        block = { system: ev.system, name: info?.name ?? name(ev.system), stage: ev.stage, slices: [], rows: 0, ev: i, evEnd: i, internal: !!info?.internal };
        if (merging) break; // a system run from inside a merge can't happen, but don't misfile it
        run.lanes[ev.stage]?.push(block);
        if (!run.systems.includes(ev.system)) run.systems.push(ev.system);
        if (info && !info.internal && info.phase && !run.phases.includes(info.phase)) run.phases.push(info.phase);
        beat(i, `${block.name} runs on ${stageName(ev.stage)}${ev.multiThreaded && ev.stages > 1 ? ' (its share of every table)' : ''}`);
        break;
      }
      case 'iterAt': {
        if (!block || block.system !== ev.system) break;
        block.slices.push({ table: ev.table, offset: ev.offset, count: ev.count, ev: i });
        block.rows += ev.count;
        beat(i, `${block.name} on ${stageName(ev.stage)}: ${tl(ev.table)} rows ${rowRange(ev.offset, ev.count)}`);
        break;
      }
      case 'systemEnd':
        if (block) block.evEnd = i;
        block = null;
        break;
      case 'call':
        if (run && block && !merging) {
          if (ev.deferred) {
            run.queued[stage]?.push({ text: ev.text ?? ev.call, ev: i });
            beat(i, `${block.name} queues: ${ev.text ?? ev.call} (${stageName(stage)}'s queue)`);
          } else beat(i, `${block.name} applies now: ${ev.text ?? ev.call}`);
        }
        break;
      case 'workerBegin':
        stage = ev.stage;
        break;
      case 'opJoin':
        if (run) run.evJoin = i;
        stage = 0;
        beat(i, 'Join: every stage has finished this run');
        break;
      case 'mergeBegin': {
        if (!run) break;
        merging = true;
        stage = 0;
        const end = evs.findIndex((e, j) => j > i && e.k === 'mergeEnd');
        run.merge = buildMerge(evs, i, end < 0 ? evs.length : end, ev.immediate, name, tl);
        beat(i, ev.immediate ? `${run.systems.map((s) => sysInfo(s)?.name ?? name(s)).join(', ')} returned: flush its queue` : `Sync point: merge ${run.merge.commands} queued command${run.merge.commands === 1 ? '' : 's'}`);
        break;
      }
      case 'stageFlush':
        stage = ev.stage;
        beat(i, `Flush ${stageName(ev.stage)}'s queue: ${ev.count} command${ev.count === 1 ? '' : 's'}`);
        break;
      case 'flushAt':
        if (ev.depth > (run?.merge?.immediate ? 1 : 0)) beat(i, `Commands queued by callbacks: flushed now (${ev.count})`);
        break;
      case 'cmdRun':
        beat(i, ev.id === 'Empty' ? `${name(ev.entity)} matched its first table: it becomes active` : cmdText(ev.kind, name(ev.entity), ev.id));
        break;
      case 'moveBegin':
        if (!rec.user.has(ev.entity)) break;
        beat(i, `${name(ev.entity)} moves ${tl(ev.from)} → ${tl(ev.to)}`);
        break;
      case 'hook':
        if (isInternalId(ev.id)) break;
        beat(i, `Hook ${hookName(ev.event)} for ${ev.id} on ${name(ev.entity)}`);
        break;
      case 'observer':
        if (!isCacheEvent(ev)) beat(i, `Observer ${ev.name} (${ev.event} ${ev.id}) for ${name(ev.entity)}`);
        break;
      case 'validate':
        beat(i, `on_validate for ${ev.id} on ${name(ev.entity)}: ${ev.ok ? 'accepted' : 'rejected, so no on_set and no OnSet'}`);
        break;
      case 'replaceHook':
        beat(i, `Hook on_replace for ${ev.id} on ${name(ev.entity)}`);
        break;
      case 'locked':
        beat(i, `${tl(ev.table)} is locked: a debug build asserts here (${ev.op})`);
        break;
      case 'mergeEnd':
        if (run?.merge) run.merge.evEnd = i;
        merging = false;
        break;
      case 'frameEnd':
        beat(i, 'Done');
        break;
    }
  }
  const systems = new Map<number, SystemInfo>();
  for (const r of runs) for (const s of r.systems) if (rec.systems.has(s)) systems.set(s, rec.systems.get(s)!);
  return { stages: stageCount, runs, beats, rebuilds, systems };
}

function buildMerge(evs: TraceEvent[], from: number, to: number, immediate: boolean, name: (e: number) => string, tl: (t: number) => string): Merge {
  const merge: Merge = { ev: from, evEnd: to, immediate, stages: [], commands: 0, tree: [] };
  const roots = merge.tree;
  // Open containers, innermost last.
  const stack: TreeNode[] = [];
  const top = () => stack[stack.length - 1];
  const add = (n: TreeNode) => {
    const t = top();
    (t ? t.children : roots).push(n);
  };
  const cmds = new Map<number, Array<{ kind: string; entity: number; id: string; index: number }>>();
  let lastCaches: TreeNode | null = null;
  for (let i = from + 1; i < to; i++) {
    const ev = evs[i];
    if (!isCacheEvent(ev)) lastCaches = null;
    switch (ev.k) {
      case 'stageFlush': {
        merge.stages.push({ stage: ev.stage, count: ev.count, ev: i });
        merge.commands += ev.count;
        stack.length = 0;
        const n: TreeNode = { kind: 'stage', text: `${stageName(ev.stage)}: ${ev.count} command${ev.count === 1 ? '' : 's'}`, ev: i, children: [], stage: ev.stage };
        roots.push(n);
        stack.push(n);
        break;
      }
      case 'flushAt': {
        // The cmd this flush hangs off is the innermost open cmd.
        const n: TreeNode = { kind: 'flush', text: '', ev: i, children: [], stage: ev.stage, depth: ev.depth };
        if (immediate && !stack.length) {
          merge.commands += ev.count;
          n.text = `the system's queue: ${ev.count} command${ev.count === 1 ? '' : 's'}`;
        } else n.text = `queued by the callbacks above, flushed now: ${ev.count} command${ev.count === 1 ? '' : 's'}`;
        add(n);
        stack.push(n);
        break;
      }
      case 'cmd': {
        const t = [...stack].reverse().find((s) => s.kind === 'flush');
        if (t) {
          const list = cmds.get(t.ev) ?? [];
          list.push(ev);
          cmds.set(t.ev, list);
        }
        break;
      }
      case 'cmdRun': {
        // Close the previous cmd of this flush.
        while (stack.length && top().kind === 'cmd') stack.pop();
        while (stack.length && top().kind !== 'flush' && top().kind !== 'stage') stack.pop();
        const flush = top();
        const list = flush ? cmds.get(flush.ev) ?? [] : [];
        const same = list.filter((c) => c.entity === ev.entity && c.index !== ev.index);
        const batch = same.length && !list.some((c) => c.entity === ev.entity && c.index < ev.index) ? ` (batch: ${1 + same.length} commands for ${name(ev.entity)})` : '';
        const text =
          ev.id === 'Empty' && ev.kind === 'Remove'
            ? `${name(ev.entity)} matched its first table: flecs removes its Empty tag (the system becomes active)`
            : `${cmdText(ev.kind, name(ev.entity), ev.id)}${batch}`;
        const n: TreeNode = { kind: 'cmd', text, ev: i, children: [], internal: ev.id === 'Empty' };
        add(n);
        stack.push(n);
        break;
      }
      case 'flushEnd':
        while (stack.length && top().kind !== 'flush') stack.pop();
        if (stack.length) stack.pop();
        break;
      case 'moveBegin':
        if (top()?.internal) break;
        add({ kind: 'move', text: `move ${name(ev.entity)}: ${tl(ev.from)} → ${tl(ev.to)}`, ev: i, children: [] });
        break;
      case 'hook':
        if (isInternalId(ev.id)) break;
        add({ kind: 'hook', text: `hook ${hookName(ev.event)} ${ev.id} (${name(ev.entity)})`, ev: i, children: [] });
        break;
      case 'replaceHook':
        add({ kind: 'hook', text: `hook on_replace ${ev.id} (${name(ev.entity)})`, ev: i, children: [] });
        break;
      case 'validate':
        add({ kind: 'validate', text: `hook on_validate ${ev.id} (${name(ev.entity)}): ${ev.ok ? 'accepted' : 'rejected'}`, ev: i, children: [], warn: !ev.ok });
        break;
      case 'observer':
        if (isCacheEvent(ev)) {
          if (!lastCaches) {
            lastCaches = { kind: 'caches', text: `new table ${tl(ev.table)}: query caches told`, ev: i, children: [] };
            add(lastCaches);
          }
        } else add({ kind: 'observer', text: `observer ${ev.name} (${ev.event} ${ev.id}, ${name(ev.entity)})`, ev: i, children: [] });
        break;
      case 'call':
        add({ kind: 'call', text: ev.deferred ? `queues: ${ev.text ?? ev.call}` : `applies now: ${ev.text ?? ev.call}`, ev: i, children: [] });
        break;
      case 'locked':
        add({ kind: 'locked', text: `${tl(ev.table)} is locked: a debug build asserts (${ev.op})`, ev: i, children: [], warn: true });
        break;
    }
  }
  return merge;
}

/** Tree for an immediate run's systems: what they applied on the spot, with its chains. */
export function immediateTree(evs: TraceEvent[], block: Block, name: (e: number) => string, tl: (t: number) => string): TreeNode[] {
  const m = buildMerge(evs, block.ev, block.evEnd, false, name, tl);
  return m.tree;
}

export function stageName(s: number): string {
  return s ? `worker ${s}` : 'main';
}

export function kindLabel(kind: Kind, threaded: boolean): string {
  if (kind === 'immediate') return 'immediate';
  if (kind === 'multi') return threaded ? 'multi-threaded' : 'multi-threaded (1 stage)';
  return 'single-threaded';
}

export function rowRange(offset: number, count: number): string {
  return count === 1 ? `${offset}` : `${offset}–${offset + count - 1}`;
}

export function tableName(type: string[] | undefined, id: number): string {
  if (!type) return `table ${id}`;
  const shown = type.filter((t) => t !== '(Identifier,Name)');
  return shown.length ? `[${shown.join(', ')}]` : '[ ]';
}

function hookName(event: string): string {
  return { OnAdd: 'on_add', OnSet: 'on_set', OnRemove: 'on_remove' }[event] ?? event;
}

function cmdText(kind: string, entity: string, id: string): string {
  switch (kind) {
    case 'Add':
      return `${entity}: add ${id}`;
    case 'Remove':
      return `${entity}: remove ${id}`;
    case 'Set':
    case 'Ensure':
      return `${entity}: set ${id}`;
    case 'Modified':
    case 'AddModified':
      return `${entity}: ${id} modified (its OnSet)`;
    case 'Delete':
      return `${entity}: delete`;
    default:
      return `${entity}: ${kind} ${id}`;
  }
}

/** How flecs' worker iterator splits `count` rows over `stages` (iter.c: ecs_worker_next), for the ruler. */
export function splitRows(count: number, stages: number): number[] {
  const per = Math.floor(count / stages);
  const rem = count - per * stages;
  return Array.from({ length: stages }, (_, i) => per + (i < rem ? 1 : 0));
}
