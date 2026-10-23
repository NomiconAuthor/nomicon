/**
 * A flecs world running in the page: flecs v4 compiled to WebAssembly (see
 * flecs-wasm/ in the repo). Each FlecsWorld is its own wasm instance, so every
 * lesson widget gets an independent world.
 *
 * The main way in is rest(): the same REST API the Flecs Explorer uses, handled
 * in-process. On top of that: systems and observers whose callbacks are
 * JavaScript, and tables() for drawing archetypes.
 */

export interface RestReply<T = unknown> {
  status: number;
  body: T;
  /** The request as it would be sent to a real app ("GET /query?expr=..."). */
  call: string;
}

export interface TableInfo {
  id: number;
  count: number;
  /** Allocated rows: appending past this reallocates every column. */
  capacity: number;
  type: Array<{ id: number; str: string; column: number; sparse: boolean; data: boolean; values?: unknown[] }>;
  dontFragment: boolean;
  sparse: boolean;
  entities: number[];
}

/** What a system or observer callback receives: one table's worth of entities. */
export interface Iter {
  /** Number of entities in this batch. */
  count: number;
  /** Entity ids, one per row. */
  entities: number[];
  /** The archetype table being iterated. */
  table: number;
  /** For observers on add/remove: the table the entity came from or goes to. */
  otherTable: number;
  deltaTime: number;
  /** Observer event name (OnAdd, OnSet, …), empty for systems. */
  event: string;
  /** The id the event was for (as a string, e.g. "Position"). */
  eventId: string;
  /** Number of query fields. */
  fieldCount: number;
  /** Field values: one per row (or one shared value if the field comes from elsewhere). */
  field<T = Record<string, number>>(index: number): T[];
  /** Is the field matched on the entity itself (vs. a parent, prefab or singleton)? */
  isSelf(index: number): boolean;
  /** Write a row's value of a field directly into its column. */
  set(index: number, row: number, value: unknown): void;
  /** Name (or "#id") of an entity. */
  name(entity: number): string;
  /**
   * ECS operations through the iterator's world. Inside a system that is the
   * stage, so these are enqueued as commands and run at the next sync point.
   * Ids are strings: "Tag", "(Likes, Bob)".
   */
  add(entity: number, id: string): void;
  remove(entity: number, id: string): void;
  setComponent(entity: number, id: string, value: unknown): void;
  delete(entity: number): void;
  spawn(name?: string): number;
}

export type IterCallback = (it: Iter) => void;

/** Command kinds, indexed like flecs' ecs_cmd_kind_t. */
export const CMD_KINDS = ['Clone', 'BulkNew', 'Add', 'Remove', 'Set', 'SetDontFragment', 'Emplace', 'Ensure', 'EnsureDontFragment', 'Modified', 'ModifiedNoHook', 'AddModified', 'Path', 'Delete', 'Clear', 'OnDeleteAction', 'Enable', 'Disable', 'Event', 'Skip'];

/** One thing flecs did, recorded by the instrumented build. Tables and entities are ids. */
export type TraceEvent =
  | { k: 'tableNew'; table: number; type: string[] }
  | { k: 'tableFree'; table: number }
  | { k: 'append'; table: number; row: number; entity: number }
  | { k: 'delete'; table: number; row: number; entity: number; moved: number; last: number }
  | { k: 'moveBegin'; entity: number; from: number; fromRow: number; to: number; toRow: number }
  | { k: 'moveEnd'; entity: number; from: number; to: number }
  | { k: 'observer'; observer: number; name: string; event: string; id: string; table: number; entity: number; matched?: boolean }
  | { k: 'hook'; event: string; id: string; table: number; row: number; entity: number }
  | { k: 'flushBegin'; count: number; toWorld: boolean }
  | { k: 'cmd'; kind: string; entity: number; id: string; index: number; first: boolean }
  | { k: 'cmdRun'; index: number; kind: string; entity: number; id: string }
  | { k: 'flushEnd'; count: number }
  | { k: 'sparseAdd'; id: string; entity: number; table: number; isNew: boolean }
  | { k: 'sparseRemove'; id: string; entity: number; table: number }
  | { k: 'systemBegin'; system: number; name: string }
  | { k: 'systemEnd'; system: number; name: string }
  | { k: 'iter'; system: number; table: number; count: number; offset: number; entity: number }
  | { k: 'frameBegin'; frame: number }
  | { k: 'frameEnd'; frame: number }
  | { k: 'note'; text: string }
  /** A REST call made by the page; deferred if made inside a system or observer. */
  | { k: 'call'; call: string; deferred: boolean; text?: string }
  /** A system or observer callback starting, with its fields (like a debugger's locals). */
  | { k: 'locals'; callback: number; name: string; table: number; entities: number[]; event: string; fields: Array<{ id: string; self: boolean; set: boolean; values: unknown[] | null }> }
  /** Every row of one table moved to another in one go (e.g. cleanup removing a deleted target's pair). */
  | { k: 'merge'; to: number; from: number; count: number; toCount: number }
  /** Every row of a table removed (deleting a parent's children, or a table being freed). */
  | { k: 'clear'; table: number; count: number; free: boolean }
  /** A table's columns being reallocated to hold more rows. */
  | { k: 'grow'; table: number; from: number; to: number; count: number }
  /** A raw reference being taken / read / written (lesson on holding on to data). */
  | { k: 'refTake'; label: string; entity: number; comp: string; addr: number; table: number; row: number; code?: string }
  | { k: 'refRead'; label: string; comp: string; value: Record<string, number>; owner: { entity: number; table: number; row: number } | null; flecsRef?: boolean }
  | { k: 'refWrite'; label: string; comp: string; value: Record<string, number>; owner: { entity: number; table: number; row: number } | null }
  /** A callback writing a value straight into a column. */
  | { k: 'write'; entity: number; id: string; value: unknown };

/** The default build (flecs master). Other builds (e.g. a PR branch) sit next to it. */
export const WASM_URL = '/flecs.wasm';
const modules = new Map<string, Promise<WebAssembly.Module>>();

function loadModule(url: string): Promise<WebAssembly.Module> {
  let modulePromise = modules.get(url);
  if (!modulePromise) {
    modulePromise = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't load ${url} (${res.status})`);
      if (WebAssembly.compileStreaming && res.headers.get('content-type')?.includes('application/wasm')) {
        return WebAssembly.compileStreaming(res);
      }
      return WebAssembly.compile(await res.arrayBuffer());
    })();
    modulePromise.catch(() => modules.delete(url));
    modules.set(url, modulePromise);
  }
  return modulePromise;
}

type Ptr = number;
interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  fw_alloc(n: number): Ptr;
  fw_free(p: Ptr): void;
  fw_init(): number;
  fw_request(method: Ptr, url: Ptr, body: Ptr): Ptr;
  fw_script(name: Ptr, code: Ptr): Ptr;
  fw_progress(dt: number): void;
  fw_lookup(path: Ptr): number;
  fw_id_str(id: bigint): Ptr;
  fw_set_tracing(on: number): void;
  fw_it_add(it: Ptr, e: number, id: Ptr): number;
  fw_it_remove(it: Ptr, e: number, id: Ptr): number;
  fw_it_set(it: Ptr, e: number, id: Ptr, json: Ptr): number;
  fw_it_delete(it: Ptr, e: number): void;
  fw_it_new(it: Ptr, name: Ptr): number;
  fw_table_type(table: number): Ptr;
  fw_sparse(id: Ptr): Ptr;
  fw_hooks(component: Ptr): number;
  fw_it_use_world(on: number): void;
  fw_ref(e: number, comp: Ptr): number;
  fw_bench_ladder(n: number): Ptr;
  fw_bench_spatial(n: number, grid: number, mode: number, moving: number, lookups: number, frames: number): Ptr;
  fw_comp_size(comp: Ptr): number;
  fw_component_raw(name: Ptr, size: number, align: number): number;
  fw_range_new(min: number, max: number): number;
  fw_range_set(range: number): void;
  fw_new(): bigint;
  fw_delete(e: bigint): void;
  fw_get_alive(index: number): bigint;
  fw_make_alive(e: bigint): number;
  fw_set_version(e: bigint): void;
  fw_add_name(e: bigint, comp: Ptr): number;
  fw_set_json(e: bigint, comp: Ptr, json: Ptr): number;
  fw_entity_json(e: bigint): Ptr;
  fw_whose(addr: number, comp: Ptr): Ptr;
  fw_is_alive(e: number): number;
  fw_system(name: Ptr, expr: Ptr, phase: Ptr, flags: number): number;
  fw_run_system(s: number, dt: number): void;
  fw_observer(name: Ptr, expr: Ptr, events: Ptr, yieldExisting: number): number;
  fw_emit(event: Ptr, entity: number, id: number): void;
  fw_it_count(it: Ptr): number;
  fw_it_entity(it: Ptr, i: number): number;
  fw_it_table(it: Ptr): number;
  fw_it_other_table(it: Ptr): number;
  fw_it_field_count(it: Ptr): number;
  fw_it_event(it: Ptr): number;
  fw_it_event_id(it: Ptr): number;
  fw_it_delta_time(it: Ptr): number;
  fw_it_field_id(it: Ptr, f: number): number;
  fw_it_field_is_self(it: Ptr, f: number): number;
  fw_it_field_is_set(it: Ptr, f: number): number;
  fw_it_field_src(it: Ptr, f: number): number;
  fw_it_field_get(it: Ptr, f: number): Ptr;
  fw_it_field_set(it: Ptr, f: number, row: number, json: Ptr): number;
  fw_tables(maxRows: number): Ptr;
  fw_query_tables(query: number, expr: Ptr): Ptr;
  fw_query_new(name: Ptr, expr: Ptr, cached: number): number;
  fw_query_cache(q: number): Ptr;
}

class FlecsError extends Error {}

export class FlecsWorld {
  private x!: Exports;
  private enc = new TextEncoder();
  private dec = new TextDecoder();
  private callbacks = new Map<number, IterCallback>();
  /** Messages flecs logged (errors from bad queries, script errors, …), newest last. */
  log: Array<{ level: number; text: string }> = [];
  onLog: ((level: number, text: string) => void) | null = null;

  private constructor() {}

  static async create(url = WASM_URL): Promise<FlecsWorld> {
    const w = new FlecsWorld();
    const mod = await loadModule(url);
    const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: w.wasi(), env: w.env() });
    w.x = inst.exports as unknown as Exports;
    w.x._initialize();
    if (w.x.fw_init()) throw new FlecsError('flecs failed to start');
    return w;
  }

  /** Throw the world away and start an empty one. */
  reset(): void {
    this.callbacks.clear();
    this.fieldCache.clear();
    this.log = [];
    this.x.fw_init();
  }

  // ---------------- REST ----------------

  /** A REST API call, e.g. rest('GET', '/query', { expr: 'Position' }). */
  rest<T = unknown>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, params: Record<string, string | number | boolean> = {}, body?: string): RestReply<T> {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = qs ? `${path}?${qs}` : path;
    this.traceSink?.push({ k: 'call', call: `${method} ${decodeURIComponent(url)}`, deferred: this.inCallback > 0 });
    const out = this.withStrings([method, url, body ?? ''], ([m, u, b]) => this.x.fw_request(m, u, b));
    const text = this.take(out);
    const nl = text.indexOf('\n');
    const status = Number(text.slice(0, nl));
    const raw = text.slice(nl + 1);
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON */
    }
    const call = `${method} ${decodeURIComponent(url)}`;
    return { status, body: parsed as T, call };
  }

  /** Run Flecs Script (components, entities, prefabs…). Re-running the same name replaces what it made. */
  script(code: string, name = 'lesson'): { ok: boolean; error?: string; call: string } {
    const err = this.withStrings([name, code], ([n, c]) => this.take(this.x.fw_script(n, c)));
    return { ok: !err, error: err || undefined, call: `PUT /script/${name}` };
  }

  // ---------------- Systems and observers ----------------

  /** A system for `query` that runs `fn` once per matching table each frame. Returns its entity (0 if the query is bad). */
  /** `immediate`: the system runs on a writable world (needed to write through it->world). */
  system(name: string, query: string, fn: IterCallback, opts: { phase?: string; cached?: boolean; immediate?: boolean } = {}): number {
    const flags = (opts.cached === false ? 0 : 1) | (opts.immediate ? 2 : 0);
    const id = this.withStrings([name, query, opts.phase ?? 'OnUpdate'], ([n, q, p]) => this.x.fw_system(n, q, p, flags));
    if (id) this.callbacks.set(id, fn);
    return id;
  }

  /** An observer for `events` ("OnAdd", "OnRemove", "OnSet" or custom names) on `query`. */
  observer(name: string, query: string, events: string[], fn: IterCallback, opts: { yieldExisting?: boolean } = {}): number {
    const id = this.withStrings([name, query, events.join(',')], ([n, q, e]) => this.x.fw_observer(n, q, e, opts.yieldExisting ? 1 : 0));
    if (id) this.callbacks.set(id, fn);
    return id;
  }

  /** Emit a custom event for component `id` on `entity`. */
  emit(event: string, entity: number, id: string): void {
    const cid = this.lookup(id);
    this.withStrings([event], ([e]) => this.x.fw_emit(e, entity, cid));
  }

  /** Advance one frame: runs every system in pipeline order. */
  progress(dt = 1 / 60): void {
    this.x.fw_progress(dt);
  }

  /** Run one system now, outside the pipeline. */
  run(system: number, dt = 1 / 60): void {
    this.x.fw_run_system(system, dt);
  }

  /** A named query (an entity, so tools can find it). Returns 0 if the expression is bad. */
  query(name: string, expr: string, cached = true): number {
    return this.withStrings([name, expr], ([n, e]) => this.x.fw_query_new(n, e, cached ? 1 : 0));
  }

  /** The tables a query (or system) has cached, or null if it isn't one. */
  queryCache(q: number): { cached: boolean; tables: number[]; matchCount: number } | null {
    return JSON.parse(this.take(this.x.fw_query_cache(q)));
  }

  // ---------------- Inspection ----------------

  /** Register a component with only a size: no members, so scripts and JSON can't read or write its values. */
  componentRaw(name: string, size: number, align = 4): number {
    return this.withStrings([name], ([n]) => this.x.fw_component_raw(n, size, align));
  }

  // ---------------- Ids, versions and ranges (64-bit ids as BigInt) ----------------

  /** Create an id range [min, max] (max 0 = no upper bound). Activate it with rangeSet. */
  rangeNew(min: number, max: number): number {
    return this.x.fw_range_new(min, max);
  }

  rangeSet(range: number): void {
    this.x.fw_range_set(range);
  }

  /** A new entity id, including its version in the upper 32 bits. */
  newEntity(): bigint {
    return BigInt.asUintN(64, this.x.fw_new());
  }

  deleteEntity(e: bigint): void {
    this.x.fw_delete(e);
  }

  /** The alive id for an index (with its current version), or 0n. */
  getAlive(index: number): bigint {
    return BigInt.asUintN(64, this.x.fw_get_alive(index));
  }

  /** make_alive: 0 = made alive, 1 = this exact id was already alive, 2 = alive with another version (refused). */
  makeAlive(e: bigint): 0 | 1 | 2 {
    return this.x.fw_make_alive(e) as 0 | 1 | 2;
  }

  setVersion(e: bigint): void {
    this.x.fw_set_version(e);
  }

  addByName(e: bigint, comp: string): boolean {
    return this.withStrings([comp], ([c]) => this.x.fw_add_name(e, c)) === 0;
  }

  /** Set a reflected component from a JS value (serialised to JSON). */
  setJson(e: bigint, comp: string, value: unknown): boolean {
    return this.withStrings([comp, JSON.stringify(value)], ([c, j]) => this.x.fw_set_json(e, c, j)) === 0;
  }

  /** The entity as flecs' JSON ({ name?, tags?, components? }), or null if it isn't alive. */
  entityJson(e: bigint): { name?: string; tags?: string[]; components?: Record<string, unknown>; pairs?: Record<string, unknown> } | null {
    return JSON.parse(this.take(this.x.fw_entity_json(e)));
  }

  lookup(path: string): number {
    return this.withStrings([path], ([p]) => this.x.fw_lookup(p));
  }

  name(id: number | bigint): string {
    return this.take(this.x.fw_id_str(BigInt(id)));
  }

  /** A table's type, as id strings. */
  tableType(table: number): string[] | null {
    return JSON.parse(this.take(this.x.fw_table_type(table)));
  }

  /** Sparse storage for a component (by name). */
  sparse(component: string): { sparse: boolean; dontFragment: boolean; entities: number[]; values?: unknown[] } | null {
    return JSON.parse(this.withStrings([component], ([c]) => this.take(this.x.fw_sparse(c))));
  }

  /**
   * Make Iter.add/remove/setComponent/delete use it->world (applied immediately,
   * mid-iteration) instead of it->stage (enqueued). For showing why not to.
   */
  set iterOpsOnWorld(on: boolean) {
    this.x.fw_it_use_world(on ? 1 : 0);
    this.opsOnWorld = on;
  }

  private opsOnWorld = false;

  // ---------------- Benchmarks (native, in a throwaway world) ----------------

  benchLadder(n: number): { n: number; create_ms: number; queries: Array<{ expr: string; build_ms: number; each_ms: number; matched: number; batches: number }> } {
    return JSON.parse(this.take(this.x.fw_bench_ladder(n)));
  }

  benchSpatial(n: number, grid: number, mode: number, moving: number, lookups: number, frames: number): { mode: number; update_ms: number; query_ms: number; found: number; cell_changes: number; tables: number; all_ms: number } {
    return JSON.parse(this.take(this.x.fw_bench_spatial(n, grid, mode, moving, lookups, frames)));
  }

  // ---------------- Raw references (what C++ get_mut/ensure hand out) ----------------

  /** Address of an entity's component value right now, or 0. */
  refAddress(entity: number, comp: string): number {
    return this.withStrings([comp], ([c]) => this.x.fw_ref(entity, c)) >>> 0;
  }

  /** Field names of a reflected component, in memory order (all f32 in the lessons). */
  fieldsOf(comp: string): string[] {
    const cached = this.fieldCache.get(comp);
    if (cached) return cached;
    const sink = this.traceSink;
    this.traceSink = null; // not part of what the lesson is showing
    try {
      const r = this.rest<Record<string, unknown>>('GET', `/type_info/${comp}`);
      const fields = r.status === 200 && r.body && typeof r.body === 'object' ? Object.keys(r.body) : [];
      this.fieldCache.set(comp, fields);
      return fields;
    } finally {
      this.traceSink = sink;
    }
  }

  private fieldCache = new Map<string, string[]>();

  /** Read f32 fields straight from memory, the way a dereferenced pointer would. */
  readFloats(addr: number, comp: string): Record<string, number> {
    const fields = this.fieldsOf(comp);
    const dv = new DataView(this.x.memory.buffer);
    const out: Record<string, number> = {};
    fields.forEach((f, i) => (out[f] = Math.round(dv.getFloat32(addr + i * 4, true) * 1000) / 1000));
    return out;
  }

  /** Write f32 fields straight into memory (no flecs operation, like `ref.x = 1`). */
  writeFloats(addr: number, comp: string, value: Record<string, number>): void {
    const fields = this.fieldsOf(comp);
    const dv = new DataView(this.x.memory.buffer);
    fields.forEach((f, i) => {
      if (f in value) dv.setFloat32(addr + i * 4, value[f], true);
    });
  }

  /** Which live row (or sparse value) owns this address now, or null for freed/unused memory. */
  whose(addr: number, comp: string): { entity: number; table: number; row: number } | null {
    return JSON.parse(this.withStrings([comp], ([c]) => this.take(this.x.fw_whose(addr, c))));
  }

  /** Give a component on_add / on_set / on_remove hooks (no-ops, so the trace shows when they run). */
  hooks(component: string): boolean {
    return this.withStrings([component], ([c]) => this.x.fw_hooks(c)) === 0;
  }

  // ---------------- Trace ----------------

  /**
   * Run `fn` with flecs' storage trace on and return everything flecs did, in order:
   * tables created, rows appended and swap-removed, entity moves, command queue
   * flushes, hooks, observers and systems.
   */
  trace(fn: () => void): TraceEvent[] {
    const out: TraceEvent[] = [];
    const prev = this.traceSink;
    this.traceSink = out;
    this.x.fw_set_tracing(1);
    try {
      fn();
    } finally {
      this.x.fw_set_tracing(prev ? 1 : 0);
      this.traceSink = prev;
    }
    return out;
  }

  private traceSink: TraceEvent[] | null = null;
  /** Depth of system/observer callbacks running now (operations inside them are deferred). */
  private inCallback = 0;

  private onTrace(kind: number, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint): void {
    const sink = this.traceSink;
    if (!sink) return;
    const n = (v: bigint) => Number(v);
    const nm = (v: bigint) => (v ? this.name(v) : '');
    switch (kind) {
      case 1:
        sink.push({ k: 'tableNew', table: n(a), type: this.tableType(n(a)) ?? [] });
        break;
      case 2:
        sink.push({ k: 'tableFree', table: n(a) });
        break;
      case 3:
        sink.push({ k: 'append', table: n(a), row: n(b), entity: n(c) });
        break;
      case 4:
        sink.push({ k: 'delete', table: n(a), row: n(b), entity: n(c), moved: n(d), last: n(e) });
        break;
      case 5:
        sink.push({ k: 'moveBegin', entity: n(a), from: n(b), fromRow: n(c), to: n(d), toRow: n(e) });
        break;
      case 6:
        sink.push({ k: 'moveEnd', entity: n(a), from: n(b), to: n(d) });
        break;
      case 7:
        sink.push({ k: 'observer', observer: n(a), name: nm(a), event: nm(b), id: nm(c), table: n(d), entity: n(e) });
        break;
      case 8:
        sink.push({ k: 'hook', event: nm(a), id: nm(b), table: n(c), row: n(d), entity: n(e) });
        break;
      case 9:
        sink.push({ k: 'flushBegin', count: n(a), toWorld: !!n(b) });
        break;
      case 10:
        sink.push({ k: 'cmd', kind: CMD_KINDS[n(a)] ?? `#${n(a)}`, entity: n(b), id: c ? nm(c) : '', index: n(d), first: !!n(e) });
        break;
      case 11:
        sink.push({ k: 'flushEnd', count: n(a) });
        break;
      case 12:
        sink.push({ k: 'sparseAdd', id: nm(a), entity: n(b), table: n(c), isNew: !!n(e) });
        break;
      case 13:
        sink.push({ k: 'sparseRemove', id: nm(a), entity: n(b), table: n(c) });
        break;
      case 14:
        sink.push({ k: 'systemBegin', system: n(a), name: nm(a) });
        break;
      case 15:
        sink.push({ k: 'systemEnd', system: n(a), name: nm(a) });
        break;
      case 18:
        sink.push({ k: 'iter', system: n(a), table: n(b), count: n(c), offset: n(d), entity: n(e) });
        break;
      case 19:
        sink.push({ k: 'frameBegin', frame: n(a) });
        break;
      case 20:
        sink.push({ k: 'frameEnd', frame: n(a) });
        break;
      case 23:
        sink.push({ k: 'merge', to: n(a), from: n(b), count: n(c), toCount: n(d) });
        break;
      case 24:
        sink.push({ k: 'clear', table: n(a), count: n(b), free: !!n(c) });
        break;
      case 22:
        sink.push({ k: 'grow', table: n(a), from: n(b), to: n(c), count: n(d) });
        break;
      case 21:
        sink.push({ k: 'cmdRun', index: n(a), kind: CMD_KINDS[n(b)] ?? `#${n(b)}`, entity: n(c), id: d ? nm(d) : '' });
        break;
    }
  }

  private dst(): string {
    return this.opsOnWorld ? 'it->world' : 'it->stage';
  }

  private opNote(text: string, code: string): void {
    this.traceSink?.push({ k: 'call', call: code, deferred: this.inCallback > 0 && !this.opsOnWorld, text });
  }

  /** Add an event to the trace being recorded (for things the page does itself, like iterating a query). */
  pushTrace(ev: TraceEvent): void {
    this.traceSink?.push(ev);
  }

  /** Mark the next trace events as coming from the page (a REST call, a script) with a label. */
  note(text: string): void {
    this.traceSink?.push({ k: 'note', text });
  }

  isAlive(e: number): boolean {
    return !!this.x.fw_is_alive(e);
  }

  /** Every archetype table, with up to `maxRows` entities and their values each. */
  tables(maxRows = 64): TableInfo[] {
    return JSON.parse(this.take(this.x.fw_tables(maxRows)));
  }

  /** The tables (and entity counts) a query returns, in iteration order. Pass a named query's entity or an expression. */
  queryTables(q: number | string): Array<[number, number, number]> | null {
    if (typeof q === 'number') return JSON.parse(this.take(this.x.fw_query_tables(q, 0)));
    return JSON.parse(this.withStrings([q], ([e]) => this.take(this.x.fw_query_tables(0, e))));
  }

  // ---------------- Plumbing ----------------

  private str(s: string): Ptr {
    const bytes = this.enc.encode(s);
    const p = this.x.fw_alloc(bytes.length + 1);
    const mem = new Uint8Array(this.x.memory.buffer, p, bytes.length + 1);
    mem.set(bytes);
    mem[bytes.length] = 0;
    return p;
  }

  private read(p: Ptr): string {
    if (!p) return '';
    const mem = new Uint8Array(this.x.memory.buffer);
    let end = p;
    while (mem[end]) end++;
    return this.dec.decode(mem.subarray(p, end));
  }

  /** Read a string flecs allocated, then free it. */
  private take(p: Ptr): string {
    const s = this.read(p);
    if (p) this.x.fw_free(p);
    return s;
  }

  private withStrings<T>(strings: string[], fn: (ptrs: Ptr[]) => T): T {
    const ptrs = strings.map((s) => this.str(s));
    try {
      return fn(ptrs);
    } finally {
      ptrs.forEach((p) => this.x.fw_free(p));
    }
  }

  private iter(it: Ptr): Iter {
    const x = this.x;
    const count = x.fw_it_count(it);
    const entities: number[] = [];
    for (let i = 0; i < count; i++) entities.push(x.fw_it_entity(it, i));
    const event = x.fw_it_event(it);
    const eventId = x.fw_it_event_id(it);
    return {
      count,
      entities,
      table: x.fw_it_table(it),
      otherTable: x.fw_it_other_table(it),
      deltaTime: x.fw_it_delta_time(it),
      event: event ? this.name(event) : '',
      eventId: eventId ? this.name(eventId) : '',
      fieldCount: x.fw_it_field_count(it),
      field: <T>(f: number) => JSON.parse(this.take(x.fw_it_field_get(it, f)) || 'null') as T[],
      isSelf: (f: number) => !!x.fw_it_field_is_self(it, f),
      set: (f: number, row: number, value: unknown) => {
        this.withStrings([JSON.stringify(value)], ([j]) => x.fw_it_field_set(it, f, row, j));
        this.traceSink?.push({ k: 'write', entity: entities[row] ?? 0, id: this.name(BigInt(x.fw_it_field_id(it, f))), value });
      },
      name: (e: number) => this.name(e),
      add: (e: number, id: string) => {
        this.opNote(`add ${id} to ${this.name(e)}`, `ecs_add(${this.dst()}, ${this.name(e)}, ${id})`);
        this.withStrings([id], ([i]) => x.fw_it_add(it, e, i));
      },
      remove: (e: number, id: string) => {
        this.opNote(`remove ${id} from ${this.name(e)}`, `ecs_remove(${this.dst()}, ${this.name(e)}, ${id})`);
        this.withStrings([id], ([i]) => x.fw_it_remove(it, e, i));
      },
      setComponent: (e: number, id: string, value: unknown) => {
        this.opNote(`set ${id} on ${this.name(e)}`, `ecs_set(${this.dst()}, ${this.name(e)}, ${id}, ${JSON.stringify(value)})`);
        this.withStrings([id, JSON.stringify(value)], ([i, j]) => x.fw_it_set(it, e, i, j));
      },
      delete: (e: number) => {
        this.opNote(`delete ${this.name(e)}`, `ecs_delete(${this.dst()}, ${this.name(e)})`);
        x.fw_it_delete(it, e);
      },
      spawn: (name = '') => {
        this.opNote(`new entity ${name}`, `ecs_new(${this.dst()})`);
        return this.withStrings([name], ([n]) => x.fw_it_new(it, n));
      },
    };
  }

  private env() {
    const dispatch = (id: number, it: Ptr) => {
      const fn = this.callbacks.get(id);
      if (!fn) return;
      try {
        const iter = this.iter(it);
        if (this.traceSink) {
          const fields = [];
          for (let f = 0; f < iter.fieldCount; f++) {
            fields.push({ id: this.name(BigInt(this.x.fw_it_field_id(it, f))), self: iter.isSelf(f), set: !!this.x.fw_it_field_is_set(it, f), values: iter.field(f) });
          }
          this.traceSink.push({ k: 'locals', callback: id, name: this.name(id), table: iter.table, entities: iter.entities, event: iter.event, fields });
        }
        this.inCallback++;
        try {
          fn(iter);
        } finally {
          this.inCallback--;
        }
      } catch (e) {
        this.pushLog(-4, `Callback threw: ${(e as Error).message}`);
      }
    };
    return {
      fw_on_trace: (kind: number, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint) => this.onTrace(kind, a, b, c, d, e),
      fw_on_system: dispatch,
      fw_on_observer: dispatch,
      fw_log: (level: number, _file: Ptr, _line: number, msg: Ptr) => this.pushLog(level, this.read(msg)),
      fw_abort: () => {
        throw new FlecsError('flecs aborted (the world is in a bad state; reset it)');
      },
    };
  }

  private pushLog(level: number, text: string): void {
    this.log.push({ level, text });
    if (this.log.length > 200) this.log.shift();
    this.onLog?.(level, text);
  }

  /** Just enough WASI for flecs: a clock and stdout/stderr. */
  private wasi() {
    const ENOSYS = 52;
    const EBADF = 8;
    const mem = () => new DataView(this.x.memory.buffer);
    let line = '';
    return {
      clock_time_get: (_id: number, _precision: bigint, out: Ptr) => {
        mem().setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true);
        return 0;
      },
      fd_write: (fd: number, iovs: Ptr, n: number, written: Ptr) => {
        const dv = mem();
        let total = 0;
        for (let i = 0; i < n; i++) {
          const p = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          line += this.dec.decode(new Uint8Array(this.x.memory.buffer, p, len));
          total += len;
        }
        let nl;
        while ((nl = line.indexOf('\n')) >= 0) {
          const text = line.slice(0, nl);
          line = line.slice(nl + 1);
          if (text.trim()) this.pushLog(fd === 2 ? -3 : 0, text);
        }
        dv.setUint32(written, total, true);
        return 0;
      },
      fd_close: () => 0,
      fd_fdstat_get: () => EBADF,
      fd_fdstat_set_flags: () => ENOSYS,
      fd_prestat_get: () => EBADF,
      fd_prestat_dir_name: () => EBADF,
      fd_read: () => EBADF,
      fd_seek: () => EBADF,
      path_open: () => ENOSYS,
      proc_exit: (code: number) => {
        throw new FlecsError(`flecs exited (${code})`);
      },
      sock_accept: () => ENOSYS,
      sock_recv: () => ENOSYS,
      sock_send: () => ENOSYS,
      sock_shutdown: () => ENOSYS,
    };
  }
}
