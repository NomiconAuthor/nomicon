import { FlecsWorld, WASM_URL, type IterCallback, type TraceEvent } from '../runtime';
import { StorageModel, isLessonType } from './model';

/** Something the lesson (or the reader) does to the world, shown as a line of code. */
export interface Op {
  /** The line in the code pane, written as flecs C++ (e.g. `ship.set<Velocity>({1, 0});`). */
  code: string;
  /** Plain-English version for the log. */
  label?: string;
  run(ctx: OpContext): void;
}

export interface SystemDef {
  name: string;
  query: string;
  phase?: string;
  cached?: boolean;
  /** Shown in the code pane. */
  code?: string;
  fn: IterCallback;
}

export interface ObserverDef {
  name: string;
  query: string;
  events: string[];
  code?: string;
  fn?: IterCallback;
}

export interface Scenario {
  id: string;
  title: string;
  /** Flecs Script run before the timeline starts (components, traits, starting entities). */
  setup: string;
  /** Script run after the variant's setup (e.g. entities, once traits are in place). */
  setupAfter?: string;
  /** The same setup as the reader would write it, shown above the timeline. */
  setupCode?: string;
  systems?: SystemDef[];
  observers?: ObserverDef[];
  /** Entities the setup makes that belong to the lesson even if they have no components yet. */
  entities?: string[];
  /** Components that get (no-op) hooks, so hook calls show up next to observers. */
  hooks?: string[];
  /** Named queries created during setup (drawn with the tables they match). */
  queries?: Array<{ name: string; expr: string; cached?: boolean }>;
  ops: Op[];
  /** Alternative setups the reader can switch between (e.g. with and without a trait). */
  variants?: Array<{ label: string; setup?: string; sparse?: string[]; note?: string; ops?: Op[]; setupCode?: string; opsOnWorld?: boolean; /** Another flecs build, e.g. '/flecs-pr2315.wasm'. */ wasm?: string }>;
  /** Which interactive tools to offer under the timeline. */
  tools?: { components?: string[]; frame?: boolean; spawn?: boolean };
  /** Components to show sparse storage for (Sparse / DontFragment ones). */
  sparse?: string[];
  /** The scenario takes raw references (shows the References panel and stop option). */
  refs?: boolean;
  /** Show entity ids (index and generation) next to names. */
  showIds?: boolean;
  /** Where to stop by default (event categories). */
  breakOn?: Category[];
}

export type Category = 'storage' | 'commands' | 'callbacks' | 'frames' | 'refs';

export function categoryOf(ev: TraceEvent): Category | null {
  switch (ev.k) {
    case 'tableNew':
    case 'tableFree':
    case 'moveBegin':
    case 'moveEnd':
    case 'append':
    case 'delete':
    case 'sparseAdd':
    case 'sparseRemove':
      return 'storage';
    case 'call':
    case 'flushBegin':
    case 'cmd':
    case 'cmdRun':
    case 'flushEnd':
      return 'commands';
    case 'observer':
    case 'hook':
    case 'systemBegin':
    case 'systemEnd':
    case 'iter':
    case 'locals':
    case 'write':
      return 'callbacks';
    case 'grow':
    case 'merge':
    case 'clear':
      return 'storage';
    case 'refTake':
    case 'refRead':
    case 'refWrite':
      return 'refs';
    case 'frameBegin':
    case 'frameEnd':
      return 'frames';
    default:
      return null;
  }
}

/** Helpers ops use; every operation goes through the REST API, like the Explorer. */
export class OpContext {
  constructor(
    public w: FlecsWorld,
    /** Raw references taken so far (label → where they point), shared across ops. */
    public refs: Map<string, { entity: number; comp: string; addr: number }> = new Map(),
    /** Entity ids kept in variables (see remember), shared across ops. */
    private ids: Map<string, number> = new Map(),
  ) {}

  /** `T& label = entity.ensure<T>()`: remember the address flecs hands out. */
  takeRef(label: string, entity: string, comp: string): void {
    const e = this.w.lookup(entity.replace(/\//g, '.'));
    const addr = this.w.refAddress(e, comp);
    if (!addr) throw new Error(`${entity} has no ${comp}`);
    const owner = this.w.whose(addr, comp);
    this.refs.set(label, { entity: e, comp, addr });
    this.w.pushTrace({ k: 'refTake', label, entity: e, comp, addr, table: owner?.table ?? -1, row: owner?.row ?? -1 });
  }

  /** Dereference: read whatever is at the address now. */
  readRef(label: string): void {
    const r = this.refs.get(label);
    if (!r) throw new Error(`no reference ${label}`);
    this.w.pushTrace({ k: 'refRead', label, comp: r.comp, value: this.w.readFloats(r.addr, r.comp), owner: this.w.whose(r.addr, r.comp) });
  }

  /** `label.x = …`: write straight to the address, bypassing flecs. */
  writeRef(label: string, value: Record<string, number>): void {
    const r = this.refs.get(label);
    if (!r) throw new Error(`no reference ${label}`);
    const owner = this.w.whose(r.addr, r.comp);
    this.w.writeFloats(r.addr, r.comp, value);
    this.w.pushTrace({ k: 'refWrite', label, comp: r.comp, value: this.w.readFloats(r.addr, r.comp), owner });
  }

  /** Keep an entity id in a variable (like `flecs::entity_t a = …`). */
  remember(label: string, entity: string): void {
    const e = this.w.lookup(entity.replace(/\//g, '.'));
    this.ids.set(label, e);
    this.w.pushTrace({ k: 'note', text: `${label} = ${entity}: id ${fmtId(e)}` });
  }

  /** Check a remembered id, as `world.is_alive(a)` would. */
  checkAlive(label: string): void {
    const e = this.ids.get(label);
    if (e === undefined) throw new Error(`no id ${label}`);
    const alive = this.w.isAlive(e);
    const index = e % 2 ** 32;
    const current = this.w.tables(100000).flatMap((t) => t.entities).find((x) => x % 2 ** 32 === index && x !== e);
    this.w.pushTrace({
      k: 'note',
      text: `is_alive(${label}) → ${alive}${!alive && current ? ` (index ${index} now belongs to ${this.w.name(current)}, id ${fmtId(current)})` : ''}`,
    });
  }

  /** A flecs::ref: looks the entity up again on access, so it always lands on the live row. */
  readFlecsRef(label: string, entity: string, comp: string): void {
    const e = this.w.lookup(entity.replace(/\//g, '.'));
    const addr = this.w.refAddress(e, comp);
    this.w.pushTrace({ k: 'refRead', label, comp, value: addr ? this.w.readFloats(addr, comp) : {}, owner: addr ? this.w.whose(addr, comp) : null, flecsRef: true });
  }

  /** REST paths use "/" between parent and child; flecs prints "." */
  private path(e: string): string {
    return e.replace(/\./g, '/');
  }

  private comp(e: string, id: string, value?: unknown): void {
    const params: Record<string, string> = { component: id };
    if (value !== undefined) params.value = JSON.stringify(value);
    const r = this.w.rest('PUT', `/component/${this.path(e)}`, params);
    if (r.status !== 200) throw new Error(`${r.call} → ${JSON.stringify(r.body)}`);
  }

  add(e: string, id: string): void {
    this.comp(e, id);
  }

  set(e: string, id: string, value: unknown): void {
    this.comp(e, id, value);
  }

  remove(e: string, id: string): void {
    const r = this.w.rest('DELETE', `/component/${this.path(e)}`, { component: id });
    if (r.status !== 200) throw new Error(`${r.call} → ${JSON.stringify(r.body)}`);
  }

  /** A new named entity, then each component in order (one move per component, as in code). */
  create(name: string, components: Record<string, unknown> = {}): void {
    const r = this.w.rest('PUT', `/entity/${this.path(name)}`);
    if (r.status !== 200) throw new Error(`${r.call} → ${JSON.stringify(r.body)}`);
    for (const [id, v] of Object.entries(components)) {
      if (v === true) this.add(name, id);
      else this.set(name, id, v);
    }
  }

  /** Enable or disable a CanToggle component (no data change, a bit in the table). */
  toggle(e: string, id: string, enable: boolean): void {
    const r = this.w.rest('PUT', `/toggle/${this.path(e)}`, { component: id, enable });
    if (r.status !== 200) throw new Error(`${r.call} → ${JSON.stringify(r.body)}`);
  }

  delete(e: string): void {
    const r = this.w.rest('DELETE', `/entity/${this.path(e)}`);
    if (r.status !== 200) throw new Error(`${r.call} → ${JSON.stringify(r.body)}`);
  }

  progress(): void {
    this.w.progress(1 / 60);
  }

  /** Run one system once (ecs_run), outside the pipeline. Its commands are applied when it returns. */
  runSystem(name: string): void {
    const id = this.w.lookup(name);
    if (!id) throw new Error(`no system ${name}`);
    this.w.run(id);
  }

  /**
   * Iterate a named query (as `q.each(...)` would) and record each result:
   * one callback per table, or per entity when the query can't match whole tables.
   */
  iterate(queryName: string): void {
    const q = this.w.lookup(queryName);
    const r = this.w.rest('GET', '/query', { name: queryName, results: false });
    void r;
    const batches = this.w.queryTables(q) ?? [];
    this.w.pushTrace({ k: 'systemBegin', system: q, name: queryName });
    for (const [table, count, offset] of batches) this.w.pushTrace({ k: 'iter', system: q, table, count, offset: offset ?? 0, entity: 0 });
    this.w.pushTrace({ k: 'systemEnd', system: q, name: queryName });
  }

  emit(event: string, e: string, id: string): void {
    this.w.emit(event, this.w.lookup(e), id);
  }

  /** Run Flecs Script mid-timeline (e.g. to add a trait). */
  script(code: string): void {
    const r = this.w.script(code, 'op');
    if (!r.ok) throw new Error(r.error);
  }
}

export interface QueryState {
  name: string;
  expr: string;
  cached: boolean;
  /** Tables in the query's cache (cached queries only). */
  cache: number[];
  /** What iterating it returns now: [table, count] per result. */
  results: Array<[number, number, number]>;
}

export interface RecordedOp {
  op: Op;
  queries: QueryState[];
  before: StorageModel;
  after: StorageModel;
  events: TraceEvent[];
  /** Table types seen so far (from tableNew events), for tables created mid-op. */
  types: Map<number, string[]>;
  error?: string;
}

/** A position in the timeline: an op, and how many of its events have happened. */
export interface Cursor {
  op: number;
  ev: number;
}

/**
 * Runs a scenario against a real flecs world and keeps everything needed to
 * show the storage at any point: a snapshot before and after each op, and the
 * trace of what flecs did in between.
 */
export class Session {
  world!: FlecsWorld;
  user = new Set<number>();
  known = new Set<number>();
  names = new Map<number, string>();
  base!: StorageModel;
  done: RecordedOp[] = [];
  queue: Op[] = [];
  systems = new Map<number, SystemDef>();
  observers = new Map<number, ObserverDef>();
  queryIds = new Map<string, number>();
  /** Raw references taken by ops (see OpContext.takeRef). */
  refs = new Map<string, { entity: number; comp: string; addr: number }>();
  ids = new Map<string, number>();
  /** Query entity → scenario definition. */
  queryById = new Map<number, { name: string; expr: string; cached?: boolean }>();
  baseQueries: QueryState[] = [];
  variant = 0;
  /** Sparse ids seen in traces (e.g. DontFragment pairs), so snapshots include their storage. */
  private dynSparse = new Set<string>();
  setupError = '';
  private types = new Map<number, string[]>();

  constructor(public scenario: Scenario) {}

  private worldUrl = '';

  /** (Re)start on the current variant, loading its flecs build if it uses a different one. */
  async start(): Promise<void> {
    const url = this.scenario.variants?.[this.variant]?.wasm ?? WASM_URL;
    if (!this.world || url !== this.worldUrl) {
      this.world = await FlecsWorld.create(url);
      this.worldUrl = url;
    }
    this.reset();
  }

  /** Back to the start: a fresh world with the setup applied, no ops run. */
  reset(): void {
    const w = this.world;
    w.reset();
    this.user = new Set();
    this.known = new Set();
    this.dynSparse = new Set();
    this.names = new Map();
    this.done = [];
    this.queue = [...(this.scenario.variants?.[this.variant]?.ops ?? this.scenario.ops)];
    this.systems.clear();
    this.observers.clear();
    this.queryIds.clear();
    this.refs = new Map();
    this.ids = new Map();
    this.queryById.clear();
    this.types = new Map();
    this.setupError = '';
    const before = new Set(w.tables(100000).flatMap((t) => t.entities));
    const v = this.scenario.variants?.[this.variant];
    w.iterOpsOnWorld = !!v?.opsOnWorld;
    const s = w.script(this.scenario.setup + (v?.setup ? `\n${v.setup}` : '') + (this.scenario.setupAfter ? `\n${this.scenario.setupAfter}` : ''), 'setup');
    if (!s.ok) this.setupError = s.error ?? 'setup failed';
    for (const c of this.scenario.hooks ?? []) if (!w.hooks(c)) this.setupError ||= `Couldn't add hooks to ${c}`;
    for (const def of this.scenario.systems ?? []) {
      const id = w.system(def.name, def.query, def.fn, { phase: def.phase, cached: def.cached });
      if (id) this.systems.set(id, def);
      else this.setupError ||= `System ${def.name}: ${w.log.at(-1)?.text ?? 'bad query'}`;
    }
    for (const def of this.scenario.observers ?? []) {
      const id = w.observer(def.name, def.query, def.events, def.fn ?? (() => {}));
      if (id) this.observers.set(id, def);
      else this.setupError ||= `Observer ${def.name}: ${w.log.at(-1)?.text ?? 'bad query'}`;
    }
    for (const q of this.scenario.queries ?? []) {
      const id = w.query(q.name, q.expr, q.cached !== false);
      if (id) {
        this.queryIds.set(q.name, id);
        this.queryById.set(id, q);
      } else this.setupError ||= `Query ${q.name}: ${w.log.at(-1)?.text ?? 'bad query'}`;
    }
    // The lesson's entities: whatever the setup made that lives in a lesson table.
    const tables = w.tables(100000);
    // Entities used as a component, tag or relationship are part of the vocabulary, not the data.
    const usedAsId = new Set<string>();
    for (const t of tables)
      for (const c of t.type) {
        const m = /^\(([^,]+),/.exec(c.str);
        usedAsId.add(m ? m[1] : c.str);
      }
    for (const t of tables) {
      if (!isUserType(t.type.map((c) => c.str))) continue;
      // An entity with nothing but a name is a tag declaration (`Moved {}`), not data.
      if (t.type.length === 1 && t.type[0].str === '(Identifier,Name)') continue;
      for (const e of t.entities) if (!before.has(e) && !usedAsId.has(w.name(e))) this.user.add(e);
    }
    for (const name of this.scenario.entities ?? []) {
      const e = w.lookup(name);
      if (e) this.user.add(e);
    }
    this.base = StorageModel.snapshot(w, this.user, this.names, this.known, this.sparseIds());
    this.nameAll(this.base);
    this.baseQueries = this.queryStates();
  }

  private sparseIds(): string[] {
    return [...new Set([...(this.scenario.sparse ?? []), ...(this.scenario.variants?.[this.variant]?.sparse ?? []), ...this.dynSparse])];
  }

  /** Every scenario query (and system) with its cache and current results. */
  queryStates(): QueryState[] {
    const out: QueryState[] = [];
    for (const [id, q] of this.queryById) {
      const cache = this.world.queryCache(id);
      out.push({ name: q.name, expr: q.expr, cached: !!cache?.cached, cache: cache?.tables ?? [], results: this.world.queryTables(id) ?? [] });
    }
    for (const [id, def] of this.systems) {
      const cache = this.world.queryCache(id);
      out.push({ name: def.name, expr: def.query, cached: !!cache?.cached, cache: cache?.tables ?? [], results: [] });
    }
    return out;
  }

  /** Run the next queued op (or `op`), recording what flecs does. */
  runNext(op?: Op): RecordedOp | null {
    const next = op ?? this.queue.shift();
    if (!next) return null;
    const w = this.world;
    const before = this.done.length ? this.done[this.done.length - 1].after : this.base;
    const ctx = new OpContext(w, this.refs, this.ids);
    let error: string | undefined;
    const events = w.trace(() => {
      try {
        next.run(ctx);
      } catch (e) {
        error = (e as Error).message;
      }
    });
    for (const ev of events) if (ev.k === 'tableNew') this.types.set(ev.table, ev.type);
    // An observer is invoked for every event on its ids, but only calls back when its whole query matches.
    events.forEach((ev, i) => {
      if (ev.k !== 'observer' || !this.observers.has(ev.observer)) return;
      ev.matched = false;
      for (let j = i + 1; j < events.length; j++) {
        const e = events[j];
        if (e.k === 'locals' && e.callback === ev.observer) {
          ev.matched = true;
          break;
        }
        if (e.k === 'observer' || e.k === 'hook' || e.k === 'append' || e.k === 'delete' || e.k === 'moveBegin') break;
      }
    });
    // Entities that arrived in lesson tables during the op are the lesson's.
    for (const ev of events) {
      if (ev.k === 'append') {
        const type = this.types.get(ev.table) ?? before.tables.get(ev.table)?.type.map((t) => t.str) ?? w.tableType(ev.table) ?? undefined;
        if (type && isUserType(type)) this.user.add(ev.entity);
        else if (!type && before.tables.has(ev.table)) this.user.add(ev.entity);
        if (this.user.has(ev.entity)) this.known.add(ev.table);
      }
      if (ev.k === 'sparseAdd') this.dynSparse.add(ev.id);
    }
    const after = StorageModel.snapshot(w, this.user, this.names, this.known, this.sparseIds());
    this.nameAll(after);
    for (const ev of events) {
      if ('entity' in ev && ev.entity && !this.names.has(ev.entity)) this.names.set(ev.entity, w.name(ev.entity));
      if (ev.k === 'append' && !this.names.has(ev.entity)) this.names.set(ev.entity, w.name(ev.entity));
      if (ev.k === 'delete' && ev.moved && !this.names.has(ev.moved)) this.names.set(ev.moved, w.name(ev.moved));
    }
    const rec: RecordedOp = { op: next, before, after, events, types: new Map(this.types), error, queries: this.queryStates() };
    this.done.push(rec);
    return rec;
  }

  /** Does a flush (begin or end event) apply any command to a lesson entity? */
  flushHasUserWork(ev: TraceEvent): boolean {
    for (const rec of this.done) {
      const i = rec.events.indexOf(ev);
      if (i < 0) continue;
      const dir = ev.k === 'flushBegin' ? 1 : -1;
      for (let j = i + dir; j >= 0 && j < rec.events.length; j += dir) {
        const e = rec.events[j];
        if (e.k === 'flushBegin' || e.k === 'flushEnd') break;
        if ((e.k === 'cmd' || e.k === 'cmdRun') && e.entity && this.user.has(e.entity)) return true;
      }
      return false;
    }
    return true;
  }

  /** The storage at a cursor: the op's starting snapshot plus its first `ev` events. */
  stateAt(c: Cursor): StorageModel {
    if (c.op < 0) return this.base;
    const rec = this.done[c.op];
    if (c.ev >= rec.events.length) return rec.after;
    const m = rec.before.clone();
    for (let i = 0; i < c.ev; i++) m.apply(rec.events[i], rec.after, rec.types);
    return m;
  }

  name(e: number): string {
    if (!e) return '0';
    let n = this.names.get(e);
    if (!n) {
      n = this.world.name(e);
      this.names.set(e, n);
    }
    return n;
  }

  private nameAll(m: StorageModel): void {
    for (const t of m.tables.values()) for (const e of t.rows) this.name(e);
    for (const s of m.sparse.values()) for (const e of s.entities) this.name(e);
  }
}

const isUserType = isLessonType;

/** An entity id as "index" or "index v<generation>". */
export function fmtId(e: number): string {
  const index = e % 2 ** 32;
  const gen = Math.floor(e / 2 ** 32) & 0xffff;
  return gen ? `${index} v${gen}` : String(index);
}
