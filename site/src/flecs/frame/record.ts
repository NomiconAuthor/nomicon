import type { FlecsWorld, TraceEvent } from '../runtime';
import { StorageModel, isLessonType } from '../debugger/model';
import { IDS, systemQuery, type FrameScenario, type FrameStep, type Kind } from './scenarios';

/** What the reader has chosen: a variant, a thread count, and per-system kinds and declarations. */
export interface FrameConfig {
  variant: number;
  stages: number;
  kinds: Record<string, Kind>;
  declared: Record<string, boolean[]>;
}

export interface SystemInfo {
  name: string;
  kind: Kind;
  phase: string;
  query: string;
  internal: boolean;
}

export interface StepRecord {
  step: FrameStep;
  /** The pipeline entity this step ran (the world's default pipeline for progress()). */
  pipeline: number;
  events: TraceEvent[];
  before: StorageModel;
  after: StorageModel;
  /** Table types seen so far (from tableNew events). */
  types: Map<number, string[]>;
}

export interface Recording {
  scenario: FrameScenario;
  config: FrameConfig;
  steps: StepRecord[];
  names: Map<number, string>;
  user: Set<number>;
  systems: Map<number, SystemInfo>;
  error: string;
}

export function defaultConfig(sc: FrameScenario, variant = 0): FrameConfig {
  const v = sc.variants?.[variant];
  const kinds: Record<string, Kind> = {};
  const declared: Record<string, boolean[]> = {};
  for (const s of sc.systems) {
    kinds[s.name] = v?.kinds?.[s.name] ?? s.kind;
    declared[s.name] = v?.declared?.[s.name] ?? s.declared ?? (s.declares ?? []).map(() => true);
  }
  return { variant, stages: v?.stages ?? sc.stages, kinds, declared };
}

/**
 * Build the scenario in a fresh world (setup, hooks, observers, systems, stages)
 * and record every step (a progress() or a run_pipeline) with the frame trace on.
 */
export function record(w: FlecsWorld, sc: FrameScenario, cfg: FrameConfig): Recording {
  w.reset();
  w.frameTrace = true;
  w.cppSet(true);
  w.iterOpsOnWorld = false;
  const v = sc.variants?.[cfg.variant];
  let error = '';
  const before = new Set(w.tables(100000).flatMap((t) => t.entities));
  const extra = v?.setupExtra ?? sc.setupExtra ?? '';
  const s = w.script(sc.setup + (extra ? `\n${extra}` : ''), 'setup');
  if (!s.ok) error = s.error ?? 'setup failed';

  for (const k of Object.keys(IDS)) delete IDS[k];
  for (const t of w.tables(100000)) for (const e of t.entities) if (!before.has(e)) IDS[w.name(e)] = e;

  for (const h of v?.hooks ?? sc.hooks ?? []) if (!w.hooksMask(h.comp, h.mask, h.min ?? 0)) error ||= `Couldn't add hooks to ${h.comp}`;
  const onWorld = new Set(v?.observersOnWorld ?? []);
  for (const o of sc.observers ?? []) {
    const fn = onWorld.has(o.name) ? (it: Parameters<typeof o.fn>[0]) => it.onWorld(() => o.fn(it)) : o.fn;
    if (!w.observer(o.name, o.query, o.events, fn)) error ||= `Observer ${o.name}: ${w.log.at(-1)?.text ?? 'bad query'}`;
  }
  const pipelines = new Map<string, number>();
  for (const p of sc.pipelines ?? []) {
    const id = w.pipeline(p.name, p.expr);
    if (!id) error ||= `Pipeline ${p.name}: ${w.log.at(-1)?.text ?? 'bad query'}`;
    pipelines.set(p.name, id);
  }
  const systems = new Map<number, SystemInfo>();
  for (const def of sc.systems) {
    const kind = cfg.kinds[def.name] ?? def.kind;
    const query = systemQuery(def, cfg.declared[def.name] ?? []);
    const id = w.system(def.name, query, def.fn, {
      phase: def.pipeline ? 'none' : def.phase,
      immediate: kind === 'immediate',
      multiThreaded: kind === 'multi',
    });
    if (!id) {
      error ||= `System ${def.name}: ${w.log.at(-1)?.text ?? 'bad query'}`;
      continue;
    }
    if (def.pipeline) {
      const r = w.script(`${def.name} { ${def.pipeline}System }`, `tag-${def.name}`);
      if (!r.ok) error ||= r.error ?? 'tagging failed';
    }
    systems.set(id, { name: def.name, kind, phase: def.pipeline ? `${def.pipeline} pipeline` : def.phase ?? 'OnUpdate', query, internal: false });
  }
  w.setStages(cfg.stages);

  // The lesson's entities: what the setup made that lives in a lesson table.
  const user = new Set<number>();
  const tables = w.tables(100000);
  const usedAsId = new Set<string>();
  for (const t of tables)
    for (const c of t.type) {
      const m = /^\(([^,]+),/.exec(c.str);
      usedAsId.add(m ? m[1] : c.str);
    }
  for (const t of tables) {
    if (!isLessonType(t.type.map((c) => c.str))) continue;
    if (t.type.length === 1 && t.type[0].str === '(Identifier,Name)') continue;
    for (const e of t.entities) if (!before.has(e) && !usedAsId.has(w.name(e))) user.add(e);
  }

  const names = new Map<number, string>();
  const known = new Set<number>();
  const types = new Map<number, string[]>();
  const steps: StepRecord[] = [];
  let state = StorageModel.snapshot(w, user, names, known, []);
  nameAll(w, state, names);
  for (const step of sc.steps) {
    const pipeline = step.pipeline ? pipelines.get(step.pipeline) ?? 0 : 0;
    const events = w.trace(() => {
      try {
        if (pipeline) w.runPipeline(pipeline);
        else w.progress();
      } catch (e) {
        error ||= (e as Error).message;
      }
    });
    for (const ev of events) {
      if (ev.k === 'tableNew') types.set(ev.table, ev.type);
      if (ev.k === 'append') {
        const type = types.get(ev.table) ?? state.tables.get(ev.table)?.type.map((t) => t.str) ?? w.tableType(ev.table) ?? undefined;
        if (type && isLessonType(type) && !(type.length === 1 && type[0] === '(Identifier,Name)')) user.add(ev.entity);
        if (user.has(ev.entity)) known.add(ev.table);
      }
      if ((ev.k === 'pipeSystem' || ev.k === 'systemAt') && !systems.has(ev.system)) {
        const name = w.name(ev.system);
        systems.set(ev.system, { name, kind: 'single', phase: '', query: '', internal: true });
      }
      if (ev.k === 'pipeSystem') {
        const info = systems.get(ev.system)!;
        if (info.internal) info.kind = ev.immediate ? 'immediate' : ev.multiThreaded ? 'multi' : 'single';
      }
    }
    const after = StorageModel.snapshot(w, user, names, known, []);
    nameAll(w, after, names);
    for (const ev of events) {
      for (const key of ['entity', 'moved'] as const) {
        const e = (ev as Record<string, unknown>)[key];
        if (typeof e === 'number' && e && !names.has(e)) names.set(e, w.name(e));
      }
    }
    steps.push({ step, pipeline, events, before: state, after, types: new Map(types) });
    state = after;
  }
  if (!error && w.lockedTables()) error = 'flecs left a table locked';
  w.frameTrace = false;
  w.cppSet(false);
  return { scenario: sc, config: cfg, steps, names, user, systems, error };
}

function nameAll(w: FlecsWorld, m: StorageModel, names: Map<number, string>): void {
  for (const t of m.tables.values())
    for (const e of t.rows) if (!names.has(e)) names.set(e, w.name(e));
}
