import type { FlecsWorld, TableInfo, TraceEvent } from '../runtime';

/** One archetype table as the debugger draws it. */
export interface TableState {
  id: number;
  type: TypeEntry[];
  /** Entities by row. */
  rows: number[];
  /** Column values by component string, then row (null = not known yet / not set). */
  values: Map<string, unknown[]>;
  dontFragment: boolean;
  /** Allocated rows (appending past this reallocates the columns). */
  capacity: number;
  /** Rows from internal entities (flecs' own) not drawn. */
  hiddenRows: number;
}

export interface TypeEntry {
  str: string;
  /** Has a column in this table (components with data that aren't sparse). */
  column: boolean;
  /** Tag (no data), sparse, pair, or name. */
  kind: 'component' | 'tag' | 'sparse' | 'pair' | 'name';
}

export interface SparseState {
  id: string;
  dontFragment: boolean;
  entities: number[];
  values: unknown[];
}

/**
 * The storage as the debugger shows it at one point in time. Built from a real
 * snapshot of the world, then advanced event by event from the trace.
 */
export class StorageModel {
  tables = new Map<number, TableState>();
  sparse = new Map<string, SparseState>();
  /** Where each entity lives: table and row. */
  where = new Map<number, { table: number; row: number }>();

  constructor(
    /** Entities that belong to the lesson (everything else is flecs' own). */
    public user: Set<number>,
    /** Names for entities and tables. */
    public names: Map<number, string>,
    /** Tables that have held the lesson's entities (shared across snapshots of one session). */
    public known: Set<number>,
  ) {}

  clone(): StorageModel {
    const m = new StorageModel(this.user, this.names, this.known);
    for (const [id, t] of this.tables)
      m.tables.set(id, { ...t, type: t.type, rows: [...t.rows], values: new Map([...t.values].map(([k, v]) => [k, [...v]])) });
    for (const [id, s] of this.sparse) m.sparse.set(id, { ...s, entities: [...s.entities], values: [...s.values] });
    for (const [e, w] of this.where) m.where.set(e, { ...w });
    return m;
  }

  /** Load the real storage: every table the lesson's entities are in, and sparse storage for `sparseIds`. */
  static snapshot(world: FlecsWorld, user: Set<number>, names: Map<number, string>, known: Set<number>, sparseIds: string[]): StorageModel {
    const m = new StorageModel(user, names, known);
    const tables = world.tables(4096);
    for (const t of tables) m.loadTable(t);
    for (const id of sparseIds) {
      const s = world.sparse(id);
      if (s?.sparse) m.sparse.set(id, { id, dontFragment: s.dontFragment, entities: s.entities, values: s.values ?? s.entities.map(() => null) });
    }
    return m;
  }

  private loadTable(t: TableInfo): void {
    const userRows = t.entities.filter((e) => this.user.has(e));
    // Only tables the lesson's entities are in, or have been in (now empty), are drawn.
    if (userRows.length) this.known.add(t.id);
    if (!this.known.has(t.id)) return;
    const type = t.type.map((c) => typeEntry(c.str, c.column >= 0, c.data, c.sparse));
    const values = new Map<string, unknown[]>();
    const keep: number[] = [];
    t.entities.forEach((e, r) => {
      if (this.user.has(e)) keep.push(r);
    });
    for (const c of t.type) if (c.values) values.set(c.str, keep.map((r) => c.values![r] ?? null));
    const table: TableState = { id: t.id, type, rows: keep.map((r) => t.entities[r]), values, dontFragment: t.dontFragment, capacity: t.capacity, hiddenRows: t.count - keep.length };
    this.tables.set(t.id, table);
    table.rows.forEach((e, row) => this.where.set(e, { table: t.id, row }));
  }

  /**
   * Advance by one trace event. `after` is the real storage once the whole
   * operation finished; values for components that just arrived are taken
   * from it when flecs sets them (OnSet), since the trace doesn't carry values.
   */
  apply(ev: TraceEvent, after: StorageModel | null, types: Map<number, string[]>): void {
    switch (ev.k) {
      case 'tableNew': {
        types.set(ev.table, ev.type);
        // Drawn from creation if the lesson's entities end up in it (flecs makes tables for its own entities too).
        if (!isLessonType(ev.type) || !(after?.known.has(ev.table) ?? false)) return;
        this.tables.set(ev.table, {
          id: ev.table,
          type: ev.type.map((s) => {
            const fromAfter = after?.tables.get(ev.table)?.type.find((t) => t.str === s);
            return fromAfter ?? guessEntry(s);
          }),
          rows: [],
          values: new Map(),
          dontFragment: false,
          capacity: 0,
          hiddenRows: 0,
        });
        return;
      }
      case 'tableFree':
        this.tables.delete(ev.table);
        return;
      case 'append': {
        // Anything that lands in a lesson table is the lesson's (flecs' own entities live in tables with internal ids).
        const lessonTable = this.tables.has(ev.table) || isLessonType(types.get(ev.table) ?? after?.tables.get(ev.table)?.type.map((c) => c.str) ?? ['flecs.?']);
        if (!lessonTable) return;
        this.user.add(ev.entity);
        this.known.add(ev.table);
        const t = this.ensureTable(ev.table, after, types);
        if (!t) return;
        const prev = this.where.get(ev.entity);
        const src = prev ? this.tables.get(prev.table) : undefined;
        t.rows.push(ev.entity);
        for (const c of t.type) {
          if (!c.column) continue;
          let col = t.values.get(c.str);
          if (!col) t.values.set(c.str, (col = t.rows.slice(0, -1).map(() => null)));
          // Moving carries values for components both tables have.
          const carried = src && prev ? src.values.get(c.str)?.[prev.row] : undefined;
          col.push(carried ?? null);
        }
        this.where.set(ev.entity, { table: ev.table, row: t.rows.length - 1 });
        return;
      }
      case 'delete': {
        const t = this.tables.get(ev.table);
        if (!t) return;
        if (!this.user.has(ev.entity)) {
          t.hiddenRows = Math.max(0, t.hiddenRows - 1);
          return;
        }
        const row = t.rows.indexOf(ev.entity);
        if (row < 0) return;
        const last = t.rows.length - 1;
        // Swap-remove: the last row fills the hole.
        t.rows[row] = t.rows[last];
        t.rows.pop();
        for (const col of t.values.values()) {
          col[row] = col[last];
          col.pop();
        }
        if (row !== last) this.where.set(t.rows[row], { table: t.id, row });
        if (this.where.get(ev.entity)?.table === t.id) this.where.delete(ev.entity);
        return;
      }
      case 'observer':
      case 'hook': {
        if (ev.event !== 'OnSet' || !after) return;
        this.fillFrom(after, ev.entity, ev.id);
        return;
      }
      case 'write': {
        const w = this.where.get(ev.entity);
        const col = w && this.tables.get(w.table)?.values.get(ev.id);
        if (col && w) col[w.row] = ev.value;
        const s = this.sparse.get(ev.id);
        if (s) {
          const i = s.entities.indexOf(ev.entity);
          if (i >= 0) s.values[i] = ev.value;
        }
        return;
      }
      case 'merge': {
        const src = this.tables.get(ev.from);
        if (!src) return;
        const dst = this.ensureTable(ev.to, after, types);
        if (!dst) return;
        src.rows.forEach((e, r) => {
          dst.rows.push(e);
          for (const c of dst.type) {
            if (!c.column) continue;
            let col = dst.values.get(c.str);
            if (!col) dst.values.set(c.str, (col = dst.rows.slice(0, -1).map(() => null)));
            col.push(src.values.get(c.str)?.[r] ?? null);
          }
          this.where.set(e, { table: dst.id, row: dst.rows.length - 1 });
        });
        this.known.add(ev.to);
        src.rows = [];
        for (const k of src.values.keys()) src.values.set(k, []);
        return;
      }
      case 'clear': {
        const t = this.tables.get(ev.table);
        if (!t) return;
        for (const e of t.rows) if (this.where.get(e)?.table === t.id) this.where.delete(e);
        t.rows = [];
        for (const k of t.values.keys()) t.values.set(k, []);
        return;
      }
      case 'grow': {
        const t = this.tables.get(ev.table);
        if (t) t.capacity = ev.to;
        return;
      }
      case 'refWrite': {
        // Writing through a raw reference changes whoever owns that memory now.
        if (!ev.owner) return;
        if (ev.owner.table >= 0) {
          const col = this.tables.get(ev.owner.table)?.values.get(ev.comp);
          if (col && ev.owner.row < col.length) col[ev.owner.row] = { ...(col[ev.owner.row] as object), ...ev.value };
        } else {
          const sp = this.sparse.get(ev.comp);
          const i = sp?.entities.indexOf(ev.owner.entity) ?? -1;
          if (sp && i >= 0) sp.values[i] = { ...(sp.values[i] as object), ...ev.value };
        }
        return;
      }
      case 'sparseAdd': {
        let s = this.sparse.get(ev.id);
        if (!s) {
          const a = after?.sparse.get(ev.id);
          s = { id: ev.id, dontFragment: a?.dontFragment ?? false, entities: [], values: [] };
          this.sparse.set(ev.id, s);
        }
        if (!s.entities.includes(ev.entity)) {
          s.entities.push(ev.entity);
          s.values.push(null);
        }
        return;
      }
      case 'sparseRemove': {
        const s = this.sparse.get(ev.id);
        if (!s) return;
        const i = s.entities.indexOf(ev.entity);
        if (i < 0) return;
        // Sparse sets swap-remove too.
        const last = s.entities.length - 1;
        s.entities[i] = s.entities[last];
        s.values[i] = s.values[last];
        s.entities.pop();
        s.values.pop();
        return;
      }
      default:
        return;
    }
  }

  private ensureTable(id: number, after: StorageModel | null, types: Map<number, string[]>): TableState | undefined {
    let t = this.tables.get(id);
    if (t) return t;
    const a = after?.tables.get(id);
    const type = a?.type ?? (types.get(id) ?? []).map(guessEntry);
    t = { id, type, rows: [], values: new Map(), dontFragment: a?.dontFragment ?? false, capacity: 0, hiddenRows: 0 };
    this.tables.set(id, t);
    return t;
  }

  /** Copy one entity's value of `id` from the finished state. */
  private fillFrom(after: StorageModel, entity: number, id: string): void {
    const here = this.where.get(entity);
    const there = after.where.get(entity);
    if (here && there) {
      const v = after.tables.get(there.table)?.values.get(id)?.[there.row];
      const col = this.tables.get(here.table)?.values.get(id);
      if (col && v !== undefined) col[here.row] = v;
    }
    const s = this.sparse.get(id);
    const as = after.sparse.get(id);
    if (s && as) {
      const i = s.entities.indexOf(entity);
      const j = as.entities.indexOf(entity);
      if (i >= 0 && j >= 0) s.values[i] = as.values[j];
    }
  }

  /** Lesson tables in a stable order (by id). */
  sortedTables(): TableState[] {
    return [...this.tables.values()].sort((a, b) => a.id - b.id);
  }

  /** Counters for the fragmentation bar. */
  stats(): { tables: number; empty: number; entities: number; perTable: number; sparse: number } {
    const ts = [...this.tables.values()];
    const entities = ts.reduce((n, t) => n + t.rows.length, 0);
    const nonEmpty = ts.filter((t) => t.rows.length).length;
    return {
      tables: ts.length,
      empty: ts.length - nonEmpty,
      entities,
      perTable: nonEmpty ? entities / nonEmpty : 0,
      sparse: [...this.sparse.values()].reduce((n, s) => n + s.entities.filter((e) => this.user.has(e)).length, 0),
    };
  }
}

/** Ids that mark flecs' own entities (components, systems, queries, modules, meta data…). */
const INTERNAL = [/^Component$/, /^flecs\./, /^\(flecs\./, /^Query$/, /^Observer$/, /^\(Poly,/, /^Module$/, /^\(ChildOf, ?flecs/, /^\(DependsOn,/, /^System$/, /^Sparse$/, /^DontFragment$/, /^Trait$/, /^Phase$/, /^\(OnInstantiate,/, /^Exclusive$/, /^Relationship$/, /^Target$/, /^Final$/, /^Inheritable$/, /^Symmetric$/, /^Transitive$/, /^Reflexive$/, /^Acyclic$/, /^Traversable$/, /^PairIsTag$/, /^CanToggle$/, /^OneOf$/, /^Singleton$/, /^With$/, /^Private$/];

/** Could this table belong to the lesson (no internal ids in its type)? */
export function isLessonType(type: string[]): boolean {
  return !type.some((s) => INTERNAL.some((re) => re.test(s)));
}

/** Before the finished state is known: pairs and names are guesses, refined from the snapshot when available. */
function guessEntry(s: string): TypeEntry {
  if (s === '(Identifier,Name)') return { str: s, column: true, kind: 'name' };
  return { str: s, column: !s.startsWith('('), kind: s.startsWith('(') ? 'pair' : 'component' };
}

function typeEntry(str: string, column: boolean, data: boolean, sparse: boolean): TypeEntry {
  if (str === '(Identifier,Name)') return { str, column, kind: 'name' };
  if (sparse) return { str, column: false, kind: 'sparse' };
  if (str.startsWith('(') && !column) return { str, column, kind: 'pair' };
  if (column) return { str, column, kind: 'component' };
  return { str, column, kind: data ? 'sparse' : 'tag' };
}
