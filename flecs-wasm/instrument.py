"""
Copies flecs.c/flecs.h from the flecs distribution and adds:
  - WASI target detection and socket stubs (the browser build never opens sockets);
  - trace calls at the points the storage debugger draws: table create/delete,
    row append/delete (swap-remove), entity moves, deferred command flushes,
    hooks, observers, systems, and sparse storage.

Every patch is an exact-text replacement that must match once, so a flecs
upgrade that changes one of these spots fails loudly here instead of silently
losing a trace.

  python3 instrument.py <flecs repo>/distr
"""
import re, sys, pathlib

src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '../vendor/flecs/distr')
h = (src / 'flecs.h').read_text()
c = (src / 'flecs.c').read_text()


failed = []


def patch(text, old, new, what):
    n = text.count(old)
    if n != 1:
        failed.append(f"{what}: expected 1 match, found {n}")
        return text
    return text.replace(old, new)


# ---------------------------------------------------------------- platform
UPSTREAM_WASM = "#elif defined(__wasm__)\n"
if UPSTREAM_WASM in h:
    # flecs 4.2+ detects WebAssembly without Emscripten itself (ECS_TARGET_WASM,
    # no execinfo); we only add the WASI flag the HTTP include patch below uses.
    h = patch(h, "#define ECS_TARGET_WASM\n#define ECS_TARGET_POSIX\n",
              "#define ECS_TARGET_WASM\n#define ECS_TARGET_POSIX\n"
              "#ifdef __wasi__ /* nomicon: WebAssembly via WASI */\n#define ECS_TARGET_WASI\n#endif\n",
              'target detection')
else:
    h = patch(h, "#elif defined(__EMSCRIPTEN__)\n#define ECS_TARGET_EM\n#define ECS_TARGET_POSIX\n#endif",
              "#elif defined(__EMSCRIPTEN__)\n#define ECS_TARGET_EM\n#define ECS_TARGET_POSIX\n"
              "#elif defined(__wasi__) /* nomicon: WebAssembly via WASI */\n#define ECS_TARGET_WASI\n#define ECS_TARGET_POSIX\n#endif",
              'target detection')
    c = patch(c, "#elif !defined(ECS_TARGET_WINDOWS) && !defined(ECS_TARGET_EM) && !defined(ECS_TARGET_ANDROID)",
              "#elif !defined(ECS_TARGET_WINDOWS) && !defined(ECS_TARGET_EM) && !defined(ECS_TARGET_ANDROID) && !defined(ECS_TARGET_WASI)",
              'execinfo')
c = patch(c, "#include <strings.h>\n#include <signal.h>\n#include <fcntl.h>\n#ifdef __FreeBSD__",
          "#include <strings.h>\n#ifdef ECS_TARGET_WASI\n#include \"wasi_net_shim.h\"\n#else\n#include <signal.h>\n#endif\n#include <fcntl.h>\n#ifdef __FreeBSD__",
          'http includes')

# ---------------------------------------------------------------- trace hook
TRACE_DECL = '''
/* nomicon: storage debugger trace points (see flecs_web.c). */
#define FW_TABLE_NEW 1
#define FW_TABLE_FREE 2
#define FW_APPEND 3
#define FW_DELETE 4
#define FW_MOVE_BEGIN 5
#define FW_MOVE_END 6
#define FW_OBSERVER 7
#define FW_HOOK 8
#define FW_FLUSH_BEGIN 9
#define FW_CMD 10
#define FW_FLUSH_END 11
#define FW_SPARSE_ADD 12
#define FW_SPARSE_REMOVE 13
#define FW_SYSTEM_BEGIN 14
#define FW_SYSTEM_END 15
#define FW_CMD_RUN 21
#define FW_GROW 22
#define FW_MERGE 23
#define FW_CLEAR 24
extern int fw_tracing;
void fw_trace(int32_t kind, uint64_t a, uint64_t b, uint64_t c, uint64_t d, uint64_t e);
#define FW_TRACE(kind, a, b, c, d, e) do { if (fw_tracing) fw_trace(kind, (uint64_t)(a), (uint64_t)(b), (uint64_t)(c), (uint64_t)(d), (uint64_t)(e)); } while (0)
/* nomicon: frame trace points ("A frame in detail"): the pipeline schedule, its runs and
 * merges, worker stages, slices, nested flushes, on_replace / on_validate, locked storage. */
#define FW_PIPE_BUILD_BEGIN 25
#define FW_PIPE_SYSTEM 26
#define FW_PIPE_TERM 27
#define FW_PIPE_WRITE 28
#define FW_PIPE_RESET 29
#define FW_PIPE_BUILD_END 30
#define FW_OP_BEGIN 31
#define FW_OP_JOIN 32
#define FW_MERGE_BEGIN 33
#define FW_STAGE_FLUSH 34
#define FW_MERGE_END 35
#define FW_WORKER_BEGIN 36
#define FW_WORKER_END 37
#define FW_ITER_AT 38
#define FW_REPLACE_HOOK 39
#define FW_VALIDATE 40
#define FW_LOCKED 41
#define FW_FLUSH_AT 42
#define FW_SYSTEM_AT 43
static ecs_entity_t fw_pipe_sys;          /* system the pipeline builder is looking at */
static const ecs_term_t *fw_pipe_terms;   /* its query's terms (for term indices) */
static int32_t fw_pipe_reason;            /* why it needs a merge: 1 terms, 2 threading kind, 4 immediate kind, 8 is immediate */
/* Worker stages without threads: run each worker stage's slice in turn (flecs_web.c). */
extern int fw_sim_workers;
void fw_sim_run_workers(ecs_world_t *world);
static int32_t fw_cmd_depth(const ecs_commands_t *c) { int32_t d = 0; while (c && c->prev) { d ++; c = c->prev; } return d; }
'''
c = patch(c, '#include "flecs.h"\n', '#include "flecs.h"\n' + TRACE_DECL, 'trace declarations')


def body_span(text, name):
    """Start and end of a function's body ({ ... }), found by its definition."""
    m = re.search(r'\n(?:static\s+)?(?:FLECS_ALWAYS_INLINE\s+)?[\w\s\*]*?\b' + re.escape(name) + r'\(\n(?:[^;{}]*\n)*?\{\n', text)
    if not m:
        return None
    start = m.end()
    end = text.find('\n}\n', start)
    return start, end


def inject(text, func, code, after=None, before=None, at_start=False):
    """Insert `code` inside `func`, after/before an anchor that occurs once in its body."""
    what = f'{func}: {after or before or "start"}'
    span = body_span(text, func)
    if not span:
        failed.append(f'{what}: function not found')
        return text
    start, end = span
    if at_start:
        return text[:start] + code + '\n' + text[start:]
    anchor = after or before
    body = text[start:end]
    n = body.count(anchor)
    if n != 1:
        failed.append(f'{what}: anchor found {n} times')
        return text
    i = start + body.index(anchor)
    if after:
        i += len(anchor)
        return text[:i] + '\n' + code + text[i:]
    return text[:i] + code + '\n    ' + text[i:]


# Tables
c = inject(c, 'flecs_table_init', '    FW_TRACE(FW_TABLE_NEW, table->id, from ? from->id : 0, 0, 0, 0);',
           after='flecs_table_init_flags(world, table);')
c = inject(c, 'flecs_table_fini', '    FW_TRACE(FW_TABLE_FREE, table->id, 0, 0, 0, 0);',
           after='flecs_increment_table_version(world, table);')

# Rows: appends (single and bulk) and swap-remove deletes
c = inject(c, 'flecs_table_grow_data',
           '    if (fw_tracing) { int32_t fw_k; for (fw_k = 0; fw_k < to_add; fw_k ++) FW_TRACE(FW_APPEND, table->id, count + fw_k, ids[fw_k], 0, 0); }\n'
           '    if (fw_tracing && prev_size != entities.size) FW_TRACE(FW_GROW, table->id, prev_size, entities.size, count, 0); /* columns are reallocated */',
           after='table->data.entities = entities.array;')
# The delete event is recorded once the row's data is really gone: straight away
# on the fast path (no hooks), and after on_remove hooks / destructors have run on
# the complex path, since flecs runs those while the deleted row is still intact.
c = inject(c, 'flecs_table_delete',
           'if (!(table->flags & EcsTableIsComplex)) FW_TRACE(FW_DELETE, table->id, row, entity_to_delete, row != count ? entity_to_move : 0, count);',
           before='if (!(table->flags & EcsTableIsComplex)) {')
c = inject(c, 'flecs_table_delete',
           '    FW_TRACE(FW_DELETE, table->id, row, entity_to_delete, row != count ? entity_to_move : 0, count);',
           after='ECS_TABLE_UNLOCK(world, table);')

# Moves between tables
c = inject(c, 'flecs_move_entity', 'FW_TRACE(FW_MOVE_BEGIN, entity, src_table->id, src_row, dst_table->id, ecs_table_count(dst_table));',
           before='/* Invoke remove actions for removed components */')
c = inject(c, 'flecs_move_entity', 'FW_TRACE(FW_MOVE_END, entity, src_table->id, 0, dst_table->id, 0);',
           before='ecs_assert(record->table == dst_table, ECS_INTERNAL_ERROR, NULL);')

# Bulk storage changes: whole tables merged into another (cleanup moving all
# entities with a deleted pair target at once), and all rows of a table cleared.
c = inject(c, 'flecs_table_merge', '    FW_TRACE(FW_MERGE, dst_table->id, src_table->id, src_count, dst_count, 0);',
           after='''if (!src_count) {
        return;
    }''')
c = inject(c, 'flecs_table_fini_data', '    FW_TRACE(FW_CLEAR, table->id, table->data.count, deallocate, 0, 0);',
           before='if (do_on_remove) {')

# Observers and component hooks
c = inject(c, 'flecs_observer_invoke',
           '    FW_TRACE(FW_OBSERVER, o->entity, it->event, it->event_id, it->table ? it->table->id : 0,\n'
           '        it->count ? (it->entities ? it->entities[0] : 0) : 0);', at_start=True)
c = inject(c, 'flecs_invoke_hook',
           '    FW_TRACE(FW_HOOK, event, id, table ? table->id : 0, row, entities ? entities[0] : 0);',
           after='it.entities = entities;')

# Command queue flushes (merges of deferred operations)
c = inject(c, 'flecs_commands_flush',
           '    FW_TRACE(FW_FLUSH_BEGIN, count, 1, 0, 0, 0);\n'
           '    if (fw_tracing) { int32_t fw_i; for (fw_i = 0; fw_i < count; fw_i ++) FW_TRACE(FW_CMD, cmds[fw_i].kind, cmds[fw_i].entity, cmds[fw_i].id, fw_i, cmds[fw_i].next_for_entity < 0); }',
           after='count = ecs_vec_count(queue);\n    i = 0;')
c = inject(c, 'flecs_commands_flush', '        FW_TRACE(FW_CMD_RUN, i, cmd->kind, cmd->entity, cmd->id, 0);',
           after='ecs_entity_t e = cmd->entity;')
c = inject(c, 'flecs_commands_flush', 'FW_TRACE(FW_FLUSH_END, count, 0, 0, 0, 0);',
           before='stage->cmd = commands;')

# Systems
c = inject(c, 'flecs_run_system', '    FW_TRACE(FW_SYSTEM_BEGIN, system, 0, 0, 0, 0);', after='it->callback = action;')
c = inject(c, 'flecs_run_system', 'FW_TRACE(FW_SYSTEM_END, system, 0, 0, 0, 0);', before='flecs_stage_set_system(stage, old_system);')

# Sparse storage
c = inject(c, 'flecs_sparse_on_add_cr',
           'FW_TRACE(FW_SPARSE_ADD, cr->id, ecs_table_entities(table)[row], table->id, row, sparse_count != flecs_sparse_count(cr->sparse));\n',
           before='if (ptr_out)  {')
c = inject(c, 'flecs_component_sparse_remove_intern', '            FW_TRACE(FW_SPARSE_REMOVE, cr->id, entity, table->id, row, 0);',
           after='if (flecs_sparse_remove(cr->sparse, 0, entity)) {')
c = inject(c, 'flecs_component_sparse_remove_intern', '    FW_TRACE(FW_SPARSE_REMOVE, cr->id, entity, table->id, row, 0);',
           after='    flecs_sparse_remove(cr->sparse, 0, entity);\n')


def replace_in(text, func, old, new):
    """Replace `old` (which must occur once in `func`'s body) with `new`."""
    what = f'{func}: replace {old.strip()[:40]!r}'
    span = body_span(text, func)
    if not span:
        failed.append(f'{what}: function not found')
        return text
    start, end = span
    body = text[start:end]
    if body.count(old) != 1:
        failed.append(f'{what}: found {body.count(old)} times')
        return text
    i = start + body.index(old)
    return text[:i] + new + text[i + len(old):]


# ---------------------------------------------------------------- frame trace
# Everything below only adds trace calls, except the three lines of
# flecs_run_pipeline marked "sim workers": with fw_set_stages(n > 1) they run the
# worker stages one after another on the main thread (wasm32-wasi has no
# threads). With one stage fw_sim_workers is 0 and flecs runs unchanged.

# Pipeline build: the schedule, and why each merge is where it is.
c = inject(c, 'flecs_pipeline_build',
           '    FW_TRACE(FW_PIPE_BUILD_BEGIN, pq->rebuild_count, new_match_count, world->info.frame_count_total, 0, 0);',
           after='pq->rebuild_count ++;')
c = inject(c, 'flecs_pipeline_build',
           'fw_pipe_sys = sys->query->entity; fw_pipe_terms = q->terms; fw_pipe_reason = 0;',
           before='bool needs_merge = false;')
c = replace_in(c, 'flecs_pipeline_build',
               'world, q, is_active, &ws);\n',
               'world, q, is_active, &ws);\n            if (needs_merge) fw_pipe_reason |= 1;\n')
c = replace_in(c, 'flecs_pipeline_build',
               'needs_merge = true;\n                    multi_threaded = sys->multi_threaded;',
               'needs_merge = true; fw_pipe_reason |= 2;\n                    multi_threaded = sys->multi_threaded;')
c = replace_in(c, 'flecs_pipeline_build',
               'needs_merge = true;\n                    immediate = sys->immediate;',
               'needs_merge = true; fw_pipe_reason |= 4;\n                    immediate = sys->immediate;')
c = replace_in(c, 'flecs_pipeline_build',
               'if (immediate) {\n                needs_merge = true;\n            }',
               'if (immediate) {\n                needs_merge = true; fw_pipe_reason |= 8;\n            }')
c = inject(c, 'flecs_pipeline_build',
           'FW_TRACE(FW_PIPE_SYSTEM, fw_pipe_sys, is_active, sys->multi_threaded | (sys->immediate << 1), needs_merge, fw_pipe_reason);',
           before='if (needs_merge) {\n                /* After merge')
c = inject(c, 'flecs_pipeline_build',
           'FW_TRACE(FW_PIPE_BUILD_END, ecs_vec_count(&pq->ops), ecs_vec_count(&pq->systems), 0, 0, 0);',
           before='pq->match_count = new_match_count;')
c = replace_in(c, 'flecs_pipeline_check_term',
               '         * overwritten. */\n        return true;',
               '         * overwritten. */\n        FW_TRACE(FW_PIPE_TERM, fw_pipe_sys, term - fw_pipe_terms, id, 1, 0);\n        return true;')
c = replace_in(c, 'flecs_pipeline_check_term',
               '                 * the main store so it must be merged first */\n                return true;',
               '                 * the main store so it must be merged first */\n                FW_TRACE(FW_PIPE_TERM, fw_pipe_sys, term - fw_pipe_terms, id, 2, 0);\n                return true;')
c = inject(c, 'flecs_pipeline_set_write_state',
           '    FW_TRACE(FW_PIPE_WRITE, fw_pipe_sys, id, id == EcsWildcard ? 2 : (ecs_id_is_wildcard(id) ? 1 : 0), 0, 0);',
           at_start=True)
c = inject(c, 'flecs_pipeline_reset_write_state', '    FW_TRACE(FW_PIPE_RESET, fw_pipe_sys, 0, 0, 0, 0);', at_start=True)

# Running the schedule: one op ("run") at a time, then its merge.
FW_OP_INDEX = '(pq->cur_op - ecs_vec_first_t(&pq->ops, ecs_pipeline_op_t))'
c = replace_in(c, 'flecs_run_pipeline',
               'bool multi_threaded = world->worker_cond != 0;',
               'bool multi_threaded = world->worker_cond != 0 || fw_sim_workers; /* nomicon: sim workers */')
c = inject(c, 'flecs_run_pipeline',
           f'        FW_TRACE(FW_OP_BEGIN, {FW_OP_INDEX}, pq->cur_i, pq->cur_op->offset + pq->cur_op->count, '
           '(pq->cur_op->multi_threaded ? 1 : 0) | (immediate ? 2 : 0) | (op_multi_threaded ? 4 : 0), stage_count);',
           after='pq->immediate = immediate;')
c = replace_in(c, 'flecs_wait_for_workers',
               'if (stage_count <= 1) {',
               'if (stage_count <= 1 || fw_sim_workers) { /* nomicon: sim workers (none to wait for) */')
c = replace_in(c, 'flecs_run_pipeline',
               '            flecs_signal_workers(world);',
               '            if (!fw_sim_workers) flecs_signal_workers(world); /* nomicon: sim workers */')
c = replace_in(c, 'flecs_run_pipeline',
               '            flecs_wait_for_sync(world);',
               '            if (fw_sim_workers) fw_sim_run_workers(world); else flecs_wait_for_sync(world); /* nomicon: sim workers */\n'
               f'            FW_TRACE(FW_OP_JOIN, {FW_OP_INDEX}, 0, 0, 0, 0);')
c = inject(c, 'flecs_run_pipeline', f'FW_TRACE(FW_MERGE_BEGIN, {FW_OP_INDEX}, 0, 0, 0, 0);', before='ecs_readonly_end(world);')
c = inject(c, 'flecs_run_pipeline', f'FW_TRACE(FW_MERGE_BEGIN, {FW_OP_INDEX}, 1, 0, 0, 0);', before='flecs_commands_end(world, stage);')
c = inject(c, 'flecs_run_pipeline', f'FW_TRACE(FW_MERGE_END, {FW_OP_INDEX}, 0, 0, 0, 0);', before='pq->cur_i = i;')
c = inject(c, 'flecs_stage_merge', 'FW_TRACE(FW_STAGE_FLUSH, s->id, ecs_vec_count(&s->cmd->queue), 0, 0, 0);',
           before='flecs_commands_flush(world, s);')

# Which stage ran a system, and how deep in nested command queues a flush is.
c = inject(c, 'flecs_run_system',
           '    FW_TRACE(FW_SYSTEM_AT, system, stage_index, stage_count, system_data->multi_threaded, system_data->immediate);',
           after='FW_TRACE(FW_SYSTEM_BEGIN, system, 0, 0, 0, 0);')
c = inject(c, 'flecs_commands_flush',
           '    FW_TRACE(FW_FLUSH_AT, stage->id, fw_cmd_depth(commands), count, 0, 0);',
           after='FW_TRACE(FW_FLUSH_BEGIN, count, 1, 0, 0, 0);')

# on_replace and on_validate hooks.
c = inject(c, 'flecs_invoke_replace_hook', 'FW_TRACE(FW_REPLACE_HOOK, entity, id, table ? table->id : 0, 0, 0);',
           before='ti->hooks.on_replace(&it);')
c = replace_in(c, 'flecs_notify_on_set_ids',
               'if (!on_validate(world, e, ptr)) {',
               'bool fw_ok = on_validate(world, e, ptr);\n                FW_TRACE(FW_VALIDATE, e, id, table->id, fw_ok, 0);\n                if (!fw_ok) {')
c = replace_in(c, 'flecs_notify_on_set_w_cr',
               'if (!on_validate(world, entities[0], ptr)) {',
               'bool fw_ok = on_validate(world, entities[0], ptr);\n        FW_TRACE(FW_VALIDATE, entities[0], id, table->id, fw_ok, 0);\n        if (!fw_ok) {')

# Locked storage. Release builds compile table locks out; count them anyway
# (ecs_table_lock is always compiled, and only the asserts read the counter)
# and record where a debug build would assert ECS_LOCKED_STORAGE.
h = patch(h, '#else\n#define ECS_TABLE_LOCK(world, table)\n#define ECS_TABLE_UNLOCK(world, table)\n#endif',
          '#else /* nomicon: count locks in release too, so the trace can show where a debug build asserts */\n'
          '#define ECS_TABLE_LOCK(world, table) ecs_table_lock(world, table)\n'
          '#define ECS_TABLE_UNLOCK(world, table) ecs_table_unlock(world, table)\n#endif',
          'table lock macros')
LOCK_OPS = ['table data cleanup', 'table deletion', 'table reset', 'table append', 'table delete', 'move',
            'table bulk append', 'table shrink', 'table swap', 'table merge']
lock_re = re.compile(r'ecs_assert\(!(\w+)->_->lock, ECS_LOCKED_STORAGE,\s*FLECS_LOCKED_STORAGE_MSG\("([^"]+)"\)\);')


def lock_sub(m):
    op = LOCK_OPS.index(m.group(2)) if m.group(2) in LOCK_OPS else len(LOCK_OPS)
    return f'if ({m.group(1)}->_->lock) FW_TRACE(FW_LOCKED, {m.group(1)}->id, {op}, 0, 0, 0);\n    ' + m.group(0)


c, n_locks = lock_re.subn(lock_sub, c)
if n_locks < 10:
    failed.append(f'locked storage asserts: found {n_locks}, expected at least 10')

if failed:
    sys.exit('instrument.py: these patch points moved in this flecs version:\n  ' + '\n  '.join(failed))

pathlib.Path('flecs.h').write_text(h)
pathlib.Path('flecs.c').write_text(c)
print('instrumented flecs.c and flecs.h')
