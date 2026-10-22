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

if failed:
    sys.exit('instrument.py: these patch points moved in this flecs version:\n  ' + '\n  '.join(failed))

pathlib.Path('flecs.h').write_text(h)
pathlib.Path('flecs.c').write_text(c)
print('instrumented flecs.c and flecs.h')
