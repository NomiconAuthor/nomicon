import type { TraceEvent } from '../runtime';
import type { Session } from './session';

/** How an event reads in the log and the "Now" panel. */
export interface Description {
  /** One line for the event log. */
  title: string;
  /** The flecs function that did it (shown as a tag). */
  fn?: string;
  /** A sentence or two of explanation for the Now panel. */
  why?: string;
  /** Visual weight in the log. */
  tone?: 'storage' | 'command' | 'callback' | 'frame' | 'muted' | 'warn' | 'refs';
  /** Indent level in the log (inside a system, a flush, a move). */
  indent?: number;
}

/** flecs' own observers and hooks: drawn only when "flecs internals" is on. */
export function isInternal(ev: TraceEvent, s: Session): boolean {
  if (ev.k === 'hook') return !(s.scenario.hooks ?? []).includes(ev.id);
  if (ev.k === 'observer') {
    // Query caches are told about new tables by observers named after the system/query.
    if (ev.event === 'OnTableCreate' || ev.event === 'OnTableDelete') return /^flecs\.|^#/.test(ev.name || '#');
    return !s.observers.has(ev.observer);
  }
  if (ev.k === 'systemBegin' || ev.k === 'systemEnd' || ev.k === 'iter') return !s.systems.has(ev.system) && !s.queryById.has(ev.system);
  if (ev.k === 'locals') return !s.systems.has(ev.callback) && !s.observers.has(ev.callback);
  if (ev.k === 'call') return false;
  // Storage work on flecs' own entities (queries, systems being set up) isn't part of the lesson.
  if (ev.k === 'moveBegin' || ev.k === 'moveEnd') return !s.user.has(ev.entity);
  if (ev.k === 'append' || ev.k === 'delete') return !s.user.has(ev.entity) && !(ev.k === 'delete' && ev.moved && s.user.has(ev.moved));
  if (ev.k === 'grow' || ev.k === 'tableNew' || ev.k === 'clear') return !s.known.has(ev.table) || (ev.k === 'clear' && !ev.count);
  if (ev.k === 'merge') return !s.known.has(ev.from) && !s.known.has(ev.to);
  if (ev.k === 'cmdRun' || ev.k === 'cmd') return !!ev.entity && !s.user.has(ev.entity);
  if (ev.k === 'flushBegin' || ev.k === 'flushEnd') return !s.flushHasUserWork(ev);
  return false;
}

/** Events never shown as steps (their content appears in the Now / locals panels). */
export function isHidden(ev: TraceEvent): boolean {
  return ev.k === 'locals' || ev.k === 'cmd' || ev.k === 'moveEnd';
}

export function tableLabel(type: string[] | undefined, id: number): string {
  if (!type) return `table ${id}`;
  const shown = type.filter((t) => t !== '(Identifier,Name)');
  if (!shown.length) return type.length ? '[name only]' : '[ ] (the root table: no components)';
  return `[${shown.join(', ')}]`;
}

export function describe(ev: TraceEvent, s: Session, types: (table: number) => string[] | undefined): Description {
  const n = (e: number) => s.name(e);
  const t = (id: number) => tableLabel(types(id), id);
  switch (ev.k) {
    case 'call':
      return ev.deferred
        ? {
            title: `Enqueue: ${ev.call}`,
            tone: 'command',
            fn: 'flecs_defer_*',
            why: 'Inside a system, operations go through the stage (it->stage in C; the entity handles C++ gives you already point at it). Structural changes are not applied now: they are appended to the command queue and applied at the next sync point, so the table the system is iterating stays still. A set of a component the entity already has is the exception: the value is written into the column now, and only its OnSet is queued.',
          }
        : ev.call.includes('it->world')
          ? {
              title: `Immediately: ${ev.call}`,
              tone: 'warn',
              why: 'it->world is the real world, not the stage, so this is applied right now, while the system is still iterating the table. Watch the rows: the entity leaves the table being iterated and the last row is swapped into its place, under the system\'s feet. Use it->stage (C) or the entity handle the system gives you (C++) so it is enqueued instead.',
            }
          : { title: ev.call, tone: 'muted', why: 'The page asks the world to do this, through the same REST API the Flecs Explorer uses.' };
    case 'tableNew':
      return {
        title: `New table ${t(ev.table)}`,
        fn: 'flecs_table_init',
        tone: 'storage',
        why: 'No table had exactly this set of components, so flecs creates one. Each table (archetype) stores one column per component with data; tags and sparse components have no column. Tables are created once per unique type and reused after that.',
      };
    case 'tableFree':
      return { title: `Table ${t(ev.table)} deleted`, fn: 'flecs_table_fini', tone: 'storage' };
    case 'moveBegin':
      return {
        title: `Move ${n(ev.entity)}: ${t(ev.from)} row ${ev.fromRow} → ${t(ev.to)}`,
        fn: 'flecs_move_entity',
        tone: 'storage',
        why: 'Changing an entity\'s set of components changes its archetype, so its row has to move to another table. On current flecs, remove actions (OnRemove hooks and observers) run first, then the row is appended to the destination, its component values are copied over, and the old row is deleted.',
      };
    case 'moveEnd':
      return { title: `${n(ev.entity)} now lives in ${t(ev.to)}`, tone: 'storage' };
    case 'append':
      return {
        title: `Append ${n(ev.entity)} to ${t(ev.table)} at row ${ev.row}`,
        fn: 'flecs_table_append',
        tone: 'storage',
        why: 'Rows are always added at the end of a table, so appending is cheap. The new row\'s values are filled in by the move (copied) or by construct/set afterwards.',
      };
    case 'delete':
      return ev.moved
        ? {
            title: `Delete row ${ev.row} of ${t(ev.table)}: ${n(ev.moved)} moves from row ${ev.last} into the hole`,
            fn: 'flecs_table_delete',
            tone: 'storage',
            why: 'Tables stay packed (no gaps), so deleting a row in the middle swaps the last row into its place. That is O(1), but it means an entity\'s row index changes when someone else leaves its table: never keep row indices around.',
          }
        : {
            title: `Delete row ${ev.row} of ${t(ev.table)} (the last row, nothing to swap)`,
            fn: 'flecs_table_delete',
            tone: 'storage',
            why: 'Removing the last row just shrinks the table.',
          };
    case 'observer': {
      if (ev.event === 'OnTableCreate')
        return {
          title: `Query cache of ${ev.name || n(ev.observer)} checks the new table ${t(ev.table)}`,
          fn: 'flecs_observer_invoke',
          tone: 'callback',
          why: 'Cached queries (every system has one) keep a list of the tables they match. Instead of searching on each iteration, they are told when a table is created and test it once. That is why table creation is the expensive part, and iteration is cheap.',
        };
      if (ev.event === 'OnTableDelete') return { title: `Query cache of ${ev.name} drops table ${t(ev.table)}`, fn: 'flecs_observer_invoke', tone: 'callback' };
      if (ev.matched === false)
        return {
          title: `Observer ${ev.name}: ${ev.event} ${ev.id} on ${n(ev.entity)}, but its query doesn't match: not called`,
          fn: 'flecs_observer_invoke',
          tone: 'muted',
          why: 'The event is delivered to every observer listening for this id, which then evaluates the rest of its query against the entity. Here the other terms don\'t match, so the callback is not called. (Observers with one term skip this check.)',
        };
      return {
        title: `Observer ${ev.name || n(ev.observer)}: ${ev.event} ${ev.id}${ev.entity ? ` on ${n(ev.entity)}` : ''}`,
        fn: 'flecs_observer_invoke',
        tone: 'callback',
        why:
          ev.event === 'OnAdd'
            ? 'OnAdd fires when the component is added, after the entity has moved to its new table. Its value is not set yet: for a component added with set(), OnSet follows.'
            : ev.event === 'OnSet'
              ? 'OnSet fires once the value has been written, so the observer can read it.'
              : ev.event === 'OnRemove'
                ? 'OnRemove fires before the component is removed, while the value can still be read.'
                : 'A custom event, delivered to observers that listen for it on this entity\'s components.',
      };
    }
    case 'hook':
      return {
        title: `Hook ${ev.event.replace('On', 'on_').toLowerCase()} for ${ev.id}${ev.entity ? ` on ${n(ev.entity)}` : ''}`,
        fn: 'flecs_invoke_hook',
        tone: 'callback',
        why: 'Component hooks are per-component callbacks (one per hook kind) that run before observers. flecs uses them itself, for example to keep the name index in sync with (Identifier, Name).',
      };
    case 'flushBegin':
      return {
        title: `Sync point: apply ${ev.count} queued command${ev.count === 1 ? '' : 's'}`,
        fn: 'flecs_commands_flush',
        tone: 'command',
        why: 'The queued commands are applied in the order they were enqueued, but commands for the same entity are batched: the first command for an entity applies all of them at once, so the entity moves once, to its final table.',
      };
    case 'cmd':
      return { title: `queue[${ev.index}] ${ev.kind} ${ev.id} → ${n(ev.entity)}`, tone: 'command' };
    case 'cmdRun':
      return ev.kind === 'Skip'
        ? { title: `Command ${ev.index}: already applied with an earlier command for ${n(ev.entity)} (batched)`, tone: 'muted', fn: 'flecs_commands_flush' }
        : { title: `Command ${ev.index}: ${ev.kind} ${ev.id} → ${n(ev.entity)}`, tone: 'command', fn: 'flecs_commands_flush' };
    case 'flushEnd':
      return { title: 'Queue empty', tone: 'command' };
    case 'sparseAdd':
      return {
        title: `${n(ev.entity)} added to the sparse storage of ${ev.id}`,
        fn: 'flecs_component_sparse_insert',
        tone: 'storage',
        why: 'Sparse components live in a sparse set per component, not in table columns. Values never move when the entity changes tables, so pointers to them stay valid. A Sparse component is still in the table type (it still fragments); a DontFragment one is not.',
      };
    case 'sparseRemove':
      return { title: `${n(ev.entity)} removed from the sparse storage of ${ev.id}`, fn: 'flecs_component_sparse_remove', tone: 'storage' };
    case 'systemBegin':
      if (s.queryById.has(ev.system))
        return { title: `Iterate query ${ev.name}`, fn: 'ecs_query_next', tone: 'callback', why: 'Iterating a query returns one result per matching table (all its matching entities at once), or one per entity for terms that cannot be matched a whole table at a time.' };
      return { title: `System ${ev.name} runs`, fn: 'flecs_run_system', tone: 'callback', why: 'A system is a cached query plus a callback. The pipeline runs systems in phase order; inside them the world is readonly and operations are enqueued.' };
    case 'systemEnd':
      return { title: s.queryById.has(ev.system) ? `Query ${ev.name} done` : `System ${ev.name} done`, tone: 'callback' };
    case 'iter': {
      const last = ev.offset + ev.count - 1;
      return {
        title: `${s.queryById.get(ev.system)?.name ?? s.name(ev.system)} ${s.queryById.has(ev.system) ? 'returns' : 'iterates'} ${t(ev.table)}: ${ev.count === 1 ? `row ${ev.offset}` : `rows ${ev.offset}–${last}`} (${ev.count} entit${ev.count === 1 ? 'y' : 'ies'})`,
        tone: 'callback',
        why: 'The callback runs once per matching table, with the table\'s columns as plain arrays: this is where archetype storage pays off. Many small tables mean many short callbacks.',
      };
    }
    case 'write':
      return ev.inPlaceSet
        ? { title: `Writes ${ev.id} of ${n(ev.entity)} = ${fmtValue(ev.value)} (in place)`, tone: 'callback', why: `${n(ev.entity)} already has ${ev.id}, so the deferred set writes the value into the column now. Only the OnSet is queued, for the sync point.` }
        : { title: `Writes ${ev.id} of ${n(ev.entity)} = ${fmtValue(ev.value)}`, tone: 'callback', why: 'Writing a field through the iterator changes the column directly. No command, no move.' };
    case 'frameBegin':
      return { title: `Frame ${ev.frame + 1} begins (ecs_progress)`, fn: 'ecs_progress', tone: 'frame' };
    case 'frameEnd':
      return { title: 'Frame ends', tone: 'frame' };
    case 'locals':
      return { title: `${ev.name} callback`, tone: 'callback' };
    case 'note':
      return { title: ev.text, tone: 'muted' };
    case 'merge':
      return {
        title: `All ${ev.count} row${ev.count === 1 ? '' : 's'} of ${t(ev.from)} move to ${t(ev.to)} in one go`,
        fn: 'flecs_table_merge',
        tone: 'storage',
        why: 'When an id disappears from every entity in a table at once (here because its target was deleted), flecs doesn\'t move the entities one by one. It appends the whole table onto the destination table and empties the old one.',
      };
    case 'clear':
      return {
        title: `${t(ev.table)}: all ${ev.count} row${ev.count === 1 ? '' : 's'} deleted at once`,
        fn: 'flecs_table_fini_data',
        tone: 'storage',
        why: 'Deleting a whole table\'s worth of entities (here, the children of a deleted parent, all in one (ChildOf, parent) table) is done table-wide: OnRemove for the whole table, then the columns are cleared.',
      };
    case 'grow':
      if (ev.from === 0)
        return { title: `${t(ev.table)} allocates its columns (room for ${ev.to} rows)`, fn: 'flecs_table_grow_data', tone: 'muted', why: 'A new table allocates its column arrays when its first row arrives. Each column holds one component\'s values for every row, side by side.' };
      return {
        title: `${t(ev.table)} grows from ${ev.from} to ${ev.to} rows: its columns are reallocated`,
        fn: 'flecs_table_grow_data',
        tone: 'warn',
        why: 'A table allocates room for a number of rows. Appending past that reallocates every column, so the component arrays move to new memory, even for entities that didn\'t change. Any pointer or reference into this table now points at freed memory. This is why a reference can go stale when a completely different entity is created.',
      };
    case 'refTake':
      return {
        title: `${ev.label} = ${n(ev.entity)}.ensure<${ev.comp}>()  → ${ev.table >= 0 ? `${t(ev.table)} row ${ev.row}` : 'sparse storage'}, address 0x${ev.addr.toString(16)}`,
        fn: 'ecs_ensure_id',
        tone: 'refs',
        why:
          ev.table >= 0
            ? 'A reference to a component is a raw pointer into the table\'s column: row ' + ev.row + ' of the ' + ev.comp + ' array. It stays valid only while nothing moves that row or reallocates the column.'
            : 'This component is Sparse, so its value lives in a sparse set, not a table column. Sparse values keep their address when the entity changes tables, so this pointer stays valid until the component or the entity is removed.',
      };
    case 'refRead':
      return ev.flecsRef
        ? {
            title: `${ev.label}->${Object.keys(ev.value)[0] ?? 'x'} (flecs::ref) reads ${fmtValue(ev.value)}${ev.owner ? `: ${n(ev.owner.entity)}'s ${ev.comp}` : ''}`,
            tone: 'refs',
            why: 'A flecs::ref remembers the entity and component, and checks on each access whether the entity\'s table changed, finding the new location if it did. It costs a little per access, but it can\'t dangle across moves.',
          }
        : {
            title: `Read ${ev.label}: ${fmtValue(ev.value)}${ev.owner ? ` — that's ${n(ev.owner.entity)}'s ${ev.comp} (${ev.owner.table >= 0 ? `row ${ev.owner.row}` : 'sparse storage'})` : ' — no live row owns this memory'}`,
            tone: 'refs',
            why: ev.owner
              ? 'Reading through the pointer gives whatever entity now occupies that row.'
              : 'This address is no longer inside any live row: the memory was freed or is unused. Often the old value is still sitting there, so the read looks fine. That is exactly why this bug is so easy to miss.',
          };
    case 'refWrite':
      return {
        title: `Write through ${ev.label}: ${fmtValue(ev.value)}${ev.owner ? ` → changes ${n(ev.owner.entity)}'s ${ev.comp}` : ' → into freed memory'}`,
        tone: 'refs',
        why: ev.owner
          ? 'The write goes to whoever occupies that row now. No flecs operation happens, no OnSet fires, and nothing reports the problem.'
          : 'The write lands in freed or unused memory. Nothing visible changes now, but whatever reuses that memory later gets corrupted.',
      };
  }
}

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '·';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(fmtValue).join(', ')}]`;
  if (typeof v === 'object') {
    const vals = Object.values(v as Record<string, unknown>);
    if (vals.every((x) => typeof x === 'number')) return vals.map((x) => fmtNum(x as number)).join(', ');
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${fmtValue(x)}`)
      .join(', ');
  }
  return String(v);
}

function fmtNum(x: number): string {
  if (Math.abs(x) >= 1e6 || (x !== 0 && Math.abs(x) < 1e-3)) return x.toExponential(1);
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
