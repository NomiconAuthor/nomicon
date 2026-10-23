/*
 * flecs_web.c: the browser build of flecs used by the lessons.
 *
 * One world at a time. JavaScript talks to it three ways:
 *  - fw_request(): the flecs REST API, handled in-process (no sockets), so the
 *    page makes exactly the calls the Flecs Explorer makes;
 *  - systems and observers whose callbacks run JavaScript (fw_on_system,
 *    fw_on_observer imports) with accessors to read and write the iterated
 *    columns;
 *  - fw_tables(): every archetype table with its entities and column values,
 *    for drawing.
 *
 * Entity ids cross the boundary as doubles (exact up to 2^53, which covers an
 * entity index plus generation).
 */
#include "flecs.c" /* one translation unit, so the glue can see table internals */
#include <stdio.h>
#include <string.h>
#include <time.h>

#define FW_EXPORT(name) __attribute__((export_name(#name)))
#define FW_IMPORT(name) __attribute__((import_module("env"), import_name(#name)))

FW_IMPORT(fw_log) void js_log(int32_t level, const char *file, int32_t line, const char *msg);
FW_IMPORT(fw_abort) void js_abort(void);
FW_IMPORT(fw_on_system) void js_on_system(double system, ecs_iter_t *it);
FW_IMPORT(fw_on_observer) void js_on_observer(double observer, ecs_iter_t *it);
FW_IMPORT(fw_on_trace) void js_on_trace(int32_t kind, uint64_t a, uint64_t b, uint64_t c, uint64_t d, uint64_t e);

/* ---------------- Storage debugger trace (calls added by instrument.py) ---------------- */
#define FW_ITER 18
#define FW_FRAME_BEGIN 19
#define FW_FRAME_END 20
int fw_tracing = 0;
void fw_trace(int32_t kind, uint64_t a, uint64_t b, uint64_t c, uint64_t d, uint64_t e) {
    js_on_trace(kind, a, b, c, d, e);
}

/* ---------------- Socket stubs (see shim/wasi_net_shim.h) ---------------- */
int setsockopt(int fd, int level, int name, const void *value, socklen_t len) { (void)fd; (void)level; (void)name; (void)value; (void)len; return -1; }
int bind(int fd, const struct sockaddr *addr, socklen_t len) { (void)fd; (void)addr; (void)len; return -1; }
int socket(int domain, int type, int protocol) { (void)domain; (void)type; (void)protocol; return -1; }
int listen(int fd, int backlog) { (void)fd; (void)backlog; return -1; }
void (*signal(int sig, void (*handler)(int)))(int) { (void)sig; (void)handler; return 0; }

/* ---------------- OS API: single-threaded browser ---------------- */
static int32_t fw_ainc(int32_t *v) { return ++(*v); }
static int32_t fw_adec(int32_t *v) { return --(*v); }
static int64_t fw_lainc(int64_t *v) { return ++(*v); }
static int64_t fw_ladec(int64_t *v) { return --(*v); }
static ecs_os_mutex_t fw_mutex_new(void) { return 1; }
static void fw_mutex_noop(ecs_os_mutex_t m) { (void)m; }
static void fw_sleep(int32_t s, int32_t ns) { (void)s; (void)ns; }
static uint64_t fw_now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}
static void fw_log_cb(int32_t level, const char *file, int32_t line, const char *msg) {
    js_log(level, file ? file : "", line, msg ? msg : "");
}
static void fw_abort_cb(void) { js_abort(); }

static void fw_os_api(void) {
    ecs_os_set_api_defaults();
    ecs_os_api_t api = ecs_os_get_api();
    api.ainc_ = fw_ainc;
    api.adec_ = fw_adec;
    api.lainc_ = fw_lainc;
    api.ladec_ = fw_ladec;
    api.mutex_new_ = fw_mutex_new;
    api.mutex_free_ = fw_mutex_noop;
    api.mutex_lock_ = fw_mutex_noop;
    api.mutex_unlock_ = fw_mutex_noop;
    api.sleep_ = fw_sleep;
    api.now_ = fw_now;
    api.log_ = fw_log_cb;
    api.abort_ = fw_abort_cb;
    ecs_os_set_api(&api);
}

/* ---------------- World ---------------- */
static ecs_world_t *world;
static ecs_http_server_t *rest;

FW_EXPORT(fw_alloc) void *fw_alloc(int32_t size) { return ecs_os_malloc(size); }
FW_EXPORT(fw_free) void fw_free(void *ptr) { ecs_os_free(ptr); }

FW_EXPORT(fw_init) int32_t fw_init(void) {
    static bool os_ready = false;
    if (!os_ready) {
        fw_os_api();
        os_ready = true;
    }
    if (world) {
        ecs_http_server_fini(rest);
        ecs_fini(world);
    }
    ecs_log_enable_colors(false);
    world = ecs_init();
    rest = ecs_rest_server_init(world, NULL);
    return world && rest ? 0 : 1;
}

/** A REST call. Returns "<status>\n<body>"; free with fw_free. */
FW_EXPORT(fw_request) char *fw_request(const char *method, const char *url, const char *body) {
    ecs_http_reply_t reply = ECS_HTTP_REPLY_INIT;
    ecs_http_server_request(rest, method, url, body, &reply);
    char *text = ecs_strbuf_get(&reply.body);
    ecs_strbuf_t out = ECS_STRBUF_INIT;
    ecs_strbuf_appendint(&out, reply.code);
    ecs_strbuf_appendch(&out, '\n');
    if (text) {
        ecs_strbuf_appendstr(&out, text);
        ecs_os_free(text);
    }
    return ecs_strbuf_get(&out);
}

/**
 * Run Flecs Script once (components, entities, prefabs…). The entities it
 * makes are ordinary entities, not owned by a script, so their archetypes are
 * exactly what the code says. Returns "" or "line:column: error"; free with fw_free.
 */
FW_EXPORT(fw_script) char *fw_script(const char *name, const char *code) {
    ecs_script_eval_result_t res = {0};
    if (!ecs_script_run(world, name, code, &res)) return ecs_os_strdup("");
    if (res.error) return res.error;
    return ecs_os_strdup("script error");
}

FW_EXPORT(fw_progress) void fw_progress(float dt) {
    if (fw_tracing) fw_trace(FW_FRAME_BEGIN, (uint64_t)ecs_get_world_info(world)->frame_count_total, 0, 0, 0, 0);
    ecs_progress(world, dt);
    if (fw_tracing) fw_trace(FW_FRAME_END, (uint64_t)ecs_get_world_info(world)->frame_count_total, 0, 0, 0, 0);
}

/** Turn the storage trace on or off (it is off while lessons set up). */
FW_EXPORT(fw_set_tracing) void fw_set_tracing(int32_t on) { fw_tracing = on; }

FW_EXPORT(fw_lookup) double fw_lookup(const char *path) { return (double)ecs_lookup(world, path); }

/** Entity or id as a string ("Position", "(ChildOf, Ship)", "#523"). Free with fw_free. */
FW_EXPORT(fw_id_str) char *fw_id_str(uint64_t id) { return ecs_id_str(world, (ecs_id_t)id); }

/** A table's type as JSON strings, or null if there's no such table. Free with fw_free. */
FW_EXPORT(fw_table_type) char *fw_table_type(double table_id) {
    ecs_table_t *table = flecs_sparse_get_t(&world->store.tables, ecs_table_t, (uint64_t)table_id);
    if (!table) return ecs_os_strdup("null");
    ecs_strbuf_t out = ECS_STRBUF_INIT;
    ecs_strbuf_list_push(&out, "[", ",");
    for (int32_t i = 0; i < table->type.count; i++) {
        ecs_strbuf_list_next(&out);
        char *str = ecs_id_str(world, table->type.array[i]);
        flecs_json_string_escape(&out, str);
        ecs_os_free(str);
    }
    ecs_strbuf_list_pop(&out, "]");
    return ecs_strbuf_get(&out);
}

/**
 * Sparse storage for a component: {"sparse":bool,"dontFragment":bool,
 * "entities":[...],"values":[...]} (values only for components with reflection).
 */
FW_EXPORT(fw_sparse) char *fw_sparse(const char *id_str) {
    ecs_id_t id = ecs_id_from_str(world, id_str);
    ecs_component_record_t *cr = id ? flecs_components_get(world, id) : NULL;
    ecs_strbuf_t out = ECS_STRBUF_INIT;
    ecs_strbuf_appendlit(&out, "{\"sparse\":");
    bool sparse = cr && (cr->flags & EcsIdSparse) && cr->sparse;
    ecs_strbuf_appendstr(&out, sparse ? "true" : "false");
    ecs_strbuf_appendlit(&out, ",\"dontFragment\":");
    ecs_strbuf_appendstr(&out, cr && (cr->flags & EcsIdDontFragment) ? "true" : "false");
    ecs_strbuf_appendlit(&out, ",\"entities\":[");
    if (sparse) {
        const uint64_t *ids = flecs_sparse_ids(cr->sparse);
        int32_t n = flecs_sparse_count(cr->sparse);
        for (int32_t i = 0; i < n; i++) {
            if (i) ecs_strbuf_appendch(&out, ',');
            ecs_strbuf_appendint(&out, (int64_t)ids[i]);
        }
        ecs_strbuf_appendch(&out, ']');
        const ecs_type_info_t *ti = cr->type_info;
        ecs_entity_t type = ti ? ti->component : 0;
        if (ti && type && ecs_has(world, type, EcsTypeSerializer)) {
            ecs_strbuf_appendlit(&out, ",\"values\":[");
            for (int32_t i = 0; i < n; i++) {
                if (i) ecs_strbuf_appendch(&out, ',');
                void *ptr = flecs_sparse_get(cr->sparse, ti->size, ids[i]);
                if (!ptr || ecs_ptr_to_json_buf(world, type, ptr, &out)) ecs_strbuf_appendlit(&out, "null");
            }
            ecs_strbuf_appendch(&out, ']');
        }
    } else {
        ecs_strbuf_appendch(&out, ']');
    }
    ecs_strbuf_appendch(&out, '}');
    return ecs_strbuf_get(&out);
}

FW_EXPORT(fw_is_alive) int32_t fw_is_alive(double e) { return ecs_is_alive(world, (ecs_entity_t)e); }

/* ---------------- Systems and observers with JavaScript callbacks ---------------- */
static void fw_system_cb(ecs_iter_t *it) {
    if (fw_tracing) fw_trace(FW_ITER, it->system, it->table ? it->table->id : 0, (uint64_t)it->count, (uint64_t)it->offset, it->count ? it->entities[0] : 0);
    js_on_system((double)it->system, it);
}
static void fw_observer_cb(ecs_iter_t *it) { js_on_observer((double)it->system, it); }

static ecs_entity_t fw_phase(const char *phase) {
    if (!phase || !phase[0]) return EcsOnUpdate;
    if (!strcmp(phase, "none")) return 0; /* not in the pipeline: only runs with ecs_run */
    ecs_entity_t e = ecs_lookup(world, phase);
    if (!e) {
        char buf[128];
        snprintf(buf, sizeof(buf), "flecs.pipeline.%s", phase);
        e = ecs_lookup(world, buf);
    }
    return e ? e : EcsOnUpdate;
}

/** A system matching `expr` that calls back into JavaScript. `flags`: 1 = cached query,
 * 2 = immediate system (runs on a writable world). Returns 0 on a bad query. */
FW_EXPORT(fw_system) double fw_system(const char *name, const char *expr, const char *phase, int32_t flags) {
    ecs_entity_t e = ecs_entity(world, { .name = name });
    ecs_entity_t s = ecs_system(world, {
        .entity = e,
        .phase = fw_phase(phase),
        .query.expr = expr,
        .query.cache_kind = (flags & 1) ? EcsQueryCacheAuto : EcsQueryCacheNone,
        .immediate = (flags & 2) != 0,
        .callback = fw_system_cb,
    });
    if (!s) ecs_delete(world, e);
    return (double)s;
}

/** Run one system once, outside the pipeline. */
FW_EXPORT(fw_run_system) void fw_run_system(double system, float dt) { ecs_run(world, (ecs_entity_t)system, dt, NULL); }

/** An observer for `events` (comma-separated: OnAdd, OnRemove, OnSet, or custom event entities). */
FW_EXPORT(fw_observer) double fw_observer(const char *name, const char *expr, const char *events, int32_t yield_existing) {
    ecs_observer_desc_t desc = {0};
    desc.entity = ecs_entity(world, { .name = name });
    desc.query.expr = expr;
    desc.callback = fw_observer_cb;
    desc.yield_existing = yield_existing != 0;
    int32_t n = 0;
    char buf[256];
    ecs_os_strncpy(buf, events, (int32_t)sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = 0;
    for (char *tok = strtok(buf, ", "); tok && n < FLECS_EVENT_DESC_MAX; tok = strtok(NULL, ", ")) {
        ecs_entity_t ev = 0;
        if (!strcmp(tok, "OnAdd")) ev = EcsOnAdd;
        else if (!strcmp(tok, "OnRemove")) ev = EcsOnRemove;
        else if (!strcmp(tok, "OnSet")) ev = EcsOnSet;
        else if (!strcmp(tok, "Wildcard")) ev = EcsWildcard;
        else {
            ev = ecs_lookup(world, tok);
            if (!ev) ev = ecs_entity(world, { .name = tok });
        }
        desc.events[n++] = ev;
    }
    ecs_entity_t o = ecs_observer_init(world, &desc);
    if (!o) ecs_delete(world, desc.entity);
    return (double)o;
}

/** Emit a custom event for `id` on an entity (observers listening for it fire). */
FW_EXPORT(fw_emit) void fw_emit(const char *event, double entity, double id) {
    ecs_entity_t ev = ecs_lookup(world, event);
    if (!ev) ev = ecs_entity(world, { .name = event });
    ecs_emit(world, &(ecs_event_desc_t){
        .event = ev,
        .entity = (ecs_entity_t)entity,
        .ids = &(ecs_type_t){ .array = (ecs_id_t[]){ (ecs_id_t)id }, .count = 1 },
    });
}

/* Iterator accessors, valid during fw_on_system / fw_on_observer. */
FW_EXPORT(fw_it_count) int32_t fw_it_count(ecs_iter_t *it) { return it->count; }
FW_EXPORT(fw_it_entity) double fw_it_entity(ecs_iter_t *it, int32_t i) { return (double)it->entities[i]; }
FW_EXPORT(fw_it_table) double fw_it_table(ecs_iter_t *it) { return it->table ? (double)flecs_table_id(it->table) : -1; }
FW_EXPORT(fw_it_other_table) double fw_it_other_table(ecs_iter_t *it) { return it->other_table ? (double)flecs_table_id(it->other_table) : -1; }
FW_EXPORT(fw_it_field_count) int32_t fw_it_field_count(ecs_iter_t *it) { return it->field_count; }
FW_EXPORT(fw_it_event) double fw_it_event(ecs_iter_t *it) { return (double)it->event; }
FW_EXPORT(fw_it_event_id) double fw_it_event_id(ecs_iter_t *it) { return (double)it->event_id; }
FW_EXPORT(fw_it_delta_time) float fw_it_delta_time(ecs_iter_t *it) { return it->delta_time; }
FW_EXPORT(fw_it_field_id) double fw_it_field_id(ecs_iter_t *it, int8_t f) { return (double)ecs_field_id(it, f); }
FW_EXPORT(fw_it_field_is_self) int32_t fw_it_field_is_self(ecs_iter_t *it, int8_t f) { return ecs_field_is_self(it, f); }
FW_EXPORT(fw_it_field_is_set) int32_t fw_it_field_is_set(ecs_iter_t *it, int8_t f) { return ecs_field_is_set(it, f); }
FW_EXPORT(fw_it_field_src) double fw_it_field_src(ecs_iter_t *it, int8_t f) { return (double)ecs_field_src(it, f); }

static ecs_entity_t fw_field_type(ecs_iter_t *it, int8_t f) {
    ecs_id_t id = ecs_field_id(it, f);
    return ecs_get_typeid(it->world, id);
}

/** A field's values as a JSON array (one per entity, or one if shared). Free with fw_free. */
FW_EXPORT(fw_it_field_get) char *fw_it_field_get(ecs_iter_t *it, int8_t f) {
    ecs_entity_t type = fw_field_type(it, f);
    ecs_size_t size = ecs_field_size(it, f);
    if (!type || !size || !ecs_field_is_set(it, f)) return ecs_os_strdup("null");
    /* Sparse fields aren't a contiguous array: each row has to be fetched with ecs_field_at. */
    bool per_row = (it->row_fields & (1llu << f)) != 0;
    void *ptr = per_row ? NULL : ecs_field_w_size(it, (size_t)size, f);
    int32_t n = ecs_field_is_self(it, f) ? it->count : 1;
    ecs_strbuf_t out = ECS_STRBUF_INIT;
    ecs_strbuf_list_push(&out, "[", ",");
    for (int32_t i = 0; i < n; i++) {
        ecs_strbuf_list_next(&out);
        void *elem = per_row ? ecs_field_at_w_size(it, (size_t)size, f, i) : ECS_OFFSET(ptr, size * i);
        if (!elem || ecs_ptr_to_json_buf(it->world, type, elem, &out)) ecs_strbuf_appendlit(&out, "null");
    }
    ecs_strbuf_list_pop(&out, "]");
    return ecs_strbuf_get(&out);
}

/** Write one entity's value of a field from JSON, directly into the column (as a C system would). */
FW_EXPORT(fw_it_field_set) int32_t fw_it_field_set(ecs_iter_t *it, int8_t f, int32_t row, const char *json) {
    ecs_entity_t type = fw_field_type(it, f);
    ecs_size_t size = ecs_field_size(it, f);
    if (!type || !size || !ecs_field_is_set(it, f)) return 1;
    if (!ecs_field_is_self(it, f)) row = 0;
    void *elem = (it->row_fields & (1llu << f))
        ? ecs_field_at_w_size(it, (size_t)size, f, row)
        : ECS_OFFSET(ecs_field_w_size(it, (size_t)size, f), size * row);
    if (!elem) return 1;
    const char *r = ecs_ptr_from_json(it->world, type, elem, json, NULL);
    return r ? 0 : 1;
}

/* ---------------- Tables, for drawing archetypes ---------------- */

/**
 * Every table: id, type (as strings and raw ids), entity ids and names, and each
 * column's values as JSON (columns with reflection data only). At most
 * `max_rows` entities per table. Free with fw_free.
 */
FW_EXPORT(fw_tables) char *fw_tables(int32_t max_rows) {
    ecs_strbuf_t out = ECS_STRBUF_INIT;
    ecs_strbuf_list_push(&out, "[", ",");
    const ecs_world_t *w = world;
    ecs_sparse_t *tables = &((ecs_world_t *)w)->store.tables;
    int32_t count = flecs_sparse_count(tables);
    for (int32_t t = 0; t < count; t++) {
        ecs_table_t *table = flecs_sparse_get_dense_t(tables, ecs_table_t, t);
        const ecs_type_t *type = ecs_table_get_type(table);
        int32_t rows = ecs_table_count(table);
        ecs_strbuf_list_next(&out);
        ecs_strbuf_list_push(&out, "{", ",");
        ecs_strbuf_list_appendlit(&out, "\"id\":");
        ecs_strbuf_appendint(&out, (int64_t)flecs_table_id(table));
        ecs_strbuf_list_appendlit(&out, "\"count\":");
        ecs_strbuf_appendint(&out, rows);
        ecs_strbuf_list_appendlit(&out, "\"capacity\":");
        ecs_strbuf_appendint(&out, ecs_table_size(table));
        ecs_strbuf_list_appendlit(&out, "\"dontFragment\":");
        /* Tables are no longer flagged for DontFragment components (flecs 1d5850a8). */
        ecs_strbuf_appendstr(&out, "false");
        ecs_strbuf_list_appendlit(&out, "\"sparse\":");
        ecs_strbuf_appendstr(&out, table->flags & EcsTableHasSparse ? "true" : "false");
        ecs_strbuf_list_appendlit(&out, "\"type\":");
        ecs_strbuf_list_push(&out, "[", ",");
        for (int32_t i = 0; i < type->count; i++) {
            ecs_strbuf_list_next(&out);
            ecs_strbuf_list_push(&out, "{", ",");
            ecs_strbuf_list_appendlit(&out, "\"id\":");
            ecs_strbuf_appendint(&out, (int64_t)type->array[i]);
            ecs_strbuf_list_appendlit(&out, "\"str\":");
            char *s = ecs_id_str(w, type->array[i]);
            ecs_strbuf_appendch(&out, '"');
            for (char *p = s; *p; p++) {
                if (*p == '"' || *p == '\\') ecs_strbuf_appendch(&out, '\\');
                ecs_strbuf_appendch(&out, *p);
            }
            ecs_strbuf_appendch(&out, '"');
            ecs_os_free(s);
            int32_t col = ecs_table_type_to_column_index(table, i);
            ecs_strbuf_list_appendlit(&out, "\"column\":");
            ecs_strbuf_appendint(&out, col);
            ecs_component_record_t *tcr = flecs_components_get(w, type->array[i]);
            ecs_strbuf_list_appendlit(&out, "\"sparse\":");
            ecs_strbuf_appendstr(&out, tcr && (tcr->flags & EcsIdSparse) ? "true" : "false");
            ecs_strbuf_list_appendlit(&out, "\"data\":");
            ecs_strbuf_appendstr(&out, ecs_get_type_info(w, type->array[i]) ? "true" : "false");
            if (col >= 0 && rows) {
                ecs_entity_t typeid = ecs_get_typeid(w, type->array[i]);
                const ecs_type_info_t *ti = ecs_get_type_info(w, type->array[i]);
                if (typeid && ti && ecs_has(w, typeid, EcsTypeSerializer)) {
                    ecs_strbuf_list_appendlit(&out, "\"values\":");
                    ecs_strbuf_list_push(&out, "[", ",");
                    void *base = ecs_table_get_column(table, col, 0);
                    int32_t n = rows < max_rows ? rows : max_rows;
                    for (int32_t r = 0; r < n; r++) {
                        ecs_strbuf_list_next(&out);
                        if (ecs_ptr_to_json_buf(w, typeid, ECS_OFFSET(base, ti->size * r), &out)) ecs_strbuf_appendlit(&out, "null");
                    }
                    ecs_strbuf_list_pop(&out, "]");
                }
            }
            ecs_strbuf_list_pop(&out, "}");
        }
        ecs_strbuf_list_pop(&out, "]");
        ecs_strbuf_list_appendlit(&out, "\"entities\":");
        ecs_strbuf_list_push(&out, "[", ",");
        const ecs_entity_t *ents = ecs_table_entities(table);
        int32_t n = rows < max_rows ? rows : max_rows;
        for (int32_t r = 0; r < n; r++) {
            ecs_strbuf_list_next(&out);
            ecs_strbuf_appendint(&out, (int64_t)ents[r]);
        }
        ecs_strbuf_list_pop(&out, "]");
        ecs_strbuf_list_pop(&out, "}");
    }
    ecs_strbuf_list_pop(&out, "]");
    return ecs_strbuf_get(&out);
}

/** Table ids a query matches right now, in iteration order, with entity counts: "[[id,count],...]". */
FW_EXPORT(fw_query_tables) char *fw_query_tables(double query_entity, const char *expr) {
    ecs_query_t *q = NULL;
    bool own = false;
    if (query_entity) {
        const EcsPoly *poly = ecs_get_pair(world, (ecs_entity_t)query_entity, EcsPoly, EcsQuery);
        if (poly) q = poly->poly;
    }
    if (!q && expr) {
        q = ecs_query(world, { .expr = expr });
        own = true;
    }
    if (!q) return ecs_os_strdup("null");
    ecs_strbuf_t out = ECS_STRBUF_INIT;
    ecs_strbuf_list_push(&out, "[", ",");
    ecs_iter_t it = ecs_query_iter(world, q);
    while (ecs_query_next(&it)) {
        ecs_strbuf_list_next(&out);
        ecs_strbuf_appendch(&out, '[');
        ecs_strbuf_appendint(&out, it.table ? (int64_t)flecs_table_id(it.table) : -1);
        ecs_strbuf_appendch(&out, ',');
        ecs_strbuf_appendint(&out, it.count);
        ecs_strbuf_appendch(&out, ',');
        ecs_strbuf_appendint(&out, it.offset);
        ecs_strbuf_appendch(&out, ']');
    }
    ecs_strbuf_list_pop(&out, "]");
    if (own) ecs_query_fini(q);
    return ecs_strbuf_get(&out);
}

int getnameinfo(const struct sockaddr *sa, socklen_t salen, char *host, socklen_t hostlen, char *serv, socklen_t servlen, int flags) {
    (void)sa; (void)salen; (void)host; (void)hostlen; (void)serv; (void)servlen; (void)flags;
    return -1;
}

/* ---------------- Named queries and their caches ---------------- */

/** A named query (cached or not). Returns its entity, or 0 if the expression is bad. */
FW_EXPORT(fw_query_new) double fw_query_new(const char *name, const char *expr, int32_t cached) {
    ecs_entity_t e = ecs_entity(world, { .name = name });
    ecs_query_t *q = ecs_query(world, {
        .entity = e,
        .expr = expr,
        .cache_kind = cached ? EcsQueryCacheAuto : EcsQueryCacheNone,
    });
    if (!q) {
        ecs_delete(world, e);
        return 0;
    }
    return (double)e;
}

static ecs_query_t *fw_query_of(ecs_entity_t e) {
    const EcsPoly *poly = ecs_get_pair(world, e, EcsPoly, EcsQuery);
    return poly ? poly->poly : NULL;
}

/**
 * What a query has cached: {"cached":bool,"tables":[table ids],"matchCount":n},
 * or null if the entity isn't a query. Systems and observers have queries too.
 */
FW_EXPORT(fw_query_cache) char *fw_query_cache(double query_entity) {
    ecs_entity_t e = (ecs_entity_t)query_entity;
    ecs_query_t *q = fw_query_of(e);
    if (!q) {
        const ecs_system_t *sys = ecs_system_get(world, e);
        if (sys) q = sys->query;
    }
    if (!q) return ecs_os_strdup("null");
    ecs_query_cache_t *cache = flecs_query_impl(q)->cache;
    ecs_strbuf_t out = ECS_STRBUF_INIT;
    ecs_strbuf_appendlit(&out, "{\"cached\":");
    ecs_strbuf_appendstr(&out, cache ? "true" : "false");
    ecs_strbuf_appendlit(&out, ",\"tables\":[");
    if (cache && ecs_map_is_init(&cache->tables)) {
        ecs_map_iter_t mit = ecs_map_iter(&cache->tables);
        bool first = true;
        while (ecs_map_next(&mit)) {
            if (!first) ecs_strbuf_appendch(&out, ',');
            first = false;
            ecs_strbuf_appendint(&out, (int64_t)ecs_map_key(&mit));
        }
    }
    ecs_strbuf_appendlit(&out, "],\"matchCount\":");
    ecs_strbuf_appendint(&out, cache ? cache->match_count : 0);
    ecs_strbuf_appendch(&out, '}');
    return ecs_strbuf_get(&out);
}

/* ---------------- Operations from inside a callback ----------------
 * By default these go through it->stage: flecs enqueues them as commands and
 * runs them at the next sync point, like `ecs_add(it->stage, ...)` in C or
 * `e.add<T>()` on the entity handle C++ gives a system. fw_it_use_world(1)
 * sends them to it->world instead, which applies them immediately, in the
 * middle of iterating (the lessons show why that is a bad idea). Ids are given
 * as strings ("Tag", "(Likes, Bob)"). Return 0 on success. */
static int fw_it_on_world = 0;
FW_EXPORT(fw_it_use_world) void fw_it_use_world(int32_t on) { fw_it_on_world = on; }
#define FW_IT_DST(it) (fw_it_on_world ? (it)->world : (it)->stage)
static ecs_id_t fw_parse_id(const char *str) { return ecs_id_from_str(world, str); }

FW_EXPORT(fw_it_add) int32_t fw_it_add(ecs_iter_t *it, double e, const char *id) {
    ecs_id_t i = fw_parse_id(id);
    if (!i) return 1;
    ecs_add_id(FW_IT_DST(it), (ecs_entity_t)e, i);
    return 0;
}
FW_EXPORT(fw_it_remove) int32_t fw_it_remove(ecs_iter_t *it, double e, const char *id) {
    ecs_id_t i = fw_parse_id(id);
    if (!i) return 1;
    ecs_remove_id(FW_IT_DST(it), (ecs_entity_t)e, i);
    return 0;
}
FW_EXPORT(fw_it_set) int32_t fw_it_set(ecs_iter_t *it, double e, const char *id, const char *json) {
    ecs_id_t i = fw_parse_id(id);
    if (!i) return 1;
    ecs_entity_t type = ecs_get_typeid(world, i);
    const ecs_type_info_t *ti = ecs_get_type_info(world, i);
    if (!type || !ti) return 1;
    void *tmp = ecs_os_calloc(ti->size);
    if (ti->hooks.ctor) ti->hooks.ctor(tmp, 1, ti);
    int32_t err = ecs_ptr_from_json(world, type, tmp, json, NULL) ? 0 : 1;
    if (!err) ecs_set_id(FW_IT_DST(it), (ecs_entity_t)e, i, (size_t)ti->size, tmp);
    if (ti->hooks.dtor) ti->hooks.dtor(tmp, 1, ti);
    ecs_os_free(tmp);
    return err;
}
FW_EXPORT(fw_it_delete) void fw_it_delete(ecs_iter_t *it, double e) { ecs_delete(FW_IT_DST(it), (ecs_entity_t)e); }
FW_EXPORT(fw_it_new) double fw_it_new(ecs_iter_t *it, const char *name) {
    ecs_entity_t e = ecs_new(FW_IT_DST(it));
    if (name && name[0]) ecs_set_name(FW_IT_DST(it), e, name);
    return (double)e;
}

/* ---------------- Component hooks ----------------
 * Installs on_add / on_set / on_remove hooks that do nothing: the trace records
 * when flecs calls them, which is what the lessons show (hooks run before
 * observers, and after them on remove). Must happen before the component is used. */
static void fw_noop_hook(ecs_iter_t *it) { (void)it; }

FW_EXPORT(fw_hooks) int32_t fw_hooks(const char *component) {
    ecs_entity_t c = ecs_lookup(world, component);
    if (!c || !ecs_has(world, c, EcsComponent)) return 1;
    ecs_type_hooks_t hooks = *ecs_get_hooks_id(world, c);
    hooks.on_add = fw_noop_hook;
    hooks.on_set = fw_noop_hook;
    hooks.on_remove = fw_noop_hook;
    ecs_set_hooks_id(world, c, &hooks);
    return 0;
}


/* ---------------- References (lesson: holding on to data) ---------------- */

/** Address of an entity's component value (what get_mut/ensure hand C++ code), or 0. */
FW_EXPORT(fw_ref) uint32_t fw_ref(double entity, const char *comp) {
    ecs_id_t id = ecs_id_from_str(world, comp);
    if (!id || !ecs_has_id(world, (ecs_entity_t)entity, id)) return 0;
    return (uint32_t)(uintptr_t)ecs_get_mut_id(world, (ecs_entity_t)entity, id);
}

/** Size in bytes of a component's value. */
/**
 * Register a component with a size but no reflection, as plain C/C++ code does
 * before anyone describes its members. Returns the component id.
 */
FW_EXPORT(fw_component_raw) double fw_component_raw(const char *name, int32_t size, int32_t align) {
    ecs_entity_t e = ecs_entity(world, { .name = name, .sep = "::", .root_sep = "" });
    return (double)ecs_component_init(world, &(ecs_component_desc_t){ .entity = e, .type = { .size = size, .alignment = align } });
}

FW_EXPORT(fw_comp_size) int32_t fw_comp_size(const char *comp) {
    const ecs_type_info_t *ti = ecs_get_type_info(world, ecs_id_from_str(world, comp));
    return ti ? ti->size : 0;
}

/**
 * Who owns the bytes at `addr` for component `comp` right now:
 * "{"entity":e,"table":t,"row":r}" if it's inside a live row of a table column
 * or a sparse set value, otherwise "null" (freed or unused memory).
 */
FW_EXPORT(fw_whose) char *fw_whose(uint32_t addr, const char *comp) {
    ecs_id_t id = ecs_id_from_str(world, comp);
    const ecs_type_info_t *ti = ecs_get_type_info(world, id);
    if (!ti) return ecs_os_strdup("null");
    ecs_size_t size = ti->size;
    ecs_component_record_t *cr = flecs_components_get(world, id);
    if (cr && (cr->flags & EcsIdSparse) && cr->sparse) {
        const uint64_t *ids = flecs_sparse_ids(cr->sparse);
        int32_t n = flecs_sparse_count(cr->sparse);
        for (int32_t i = 0; i < n; i++) {
            void *p = flecs_sparse_get(cr->sparse, size, ids[i]);
            if ((uintptr_t)p == addr) return flecs_asprintf("{\"entity\":%u,\"table\":-1,\"row\":-1}", (uint32_t)ids[i]);
        }
        return ecs_os_strdup("null");
    }
    ecs_sparse_t *tables = &world->store.tables;
    int32_t count = flecs_sparse_count(tables);
    for (int32_t t = 0; t < count; t++) {
        ecs_table_t *table = flecs_sparse_get_dense_t(tables, ecs_table_t, t);
        int32_t col = ecs_table_get_column_index(world, table, id);
        if (col < 0) continue;
        uintptr_t base = (uintptr_t)ecs_table_get_column(table, col, 0);
        int32_t rows = ecs_table_count(table);
        if (!base || addr < base || addr >= base + (uintptr_t)(size * rows)) continue;
        int32_t row = (int32_t)((addr - base) / (uintptr_t)size);
        return flecs_asprintf("{\"entity\":%u,\"table\":%u,\"row\":%d}", (uint32_t)ecs_table_entities(table)[row], (uint32_t)flecs_table_id(table), row);
    }
    return ecs_os_strdup("null");
}

/* ---------------- Benchmarks (run natively in the wasm module) ----------------
 * Each benchmark builds its own throwaway world so it doesn't disturb the
 * lesson's world, and reports milliseconds measured with the monotonic clock. */

static uint32_t fw_rng = 1;
static uint32_t fw_rand(void) { fw_rng = fw_rng * 1664525u + 1013904223u; return fw_rng >> 8; }
static double fw_ms(uint64_t t0) { return (double)(fw_now() - t0) / 1e6; }

typedef struct { int32_t value; } BHunger;
typedef struct { int32_t value; } BHungerRate;
typedef struct { float x, y; } BPos;

static int32_t fw_iter_all(ecs_world_t *w, ecs_query_t *q, int32_t *batches) {
    int32_t total = 0, b = 0;
    ecs_iter_t it = ecs_query_iter(w, q);
    while (ecs_query_next(&it)) { total += it.count; b++; }
    if (batches) *batches = b;
    return total;
}

/**
 * The "cost ladder": the same hunger data reached three ways (see the query
 * language lesson). Returns JSON with build and iteration times per query.
 */
FW_EXPORT(fw_bench_ladder) char *fw_bench_ladder(int32_t n) {
    ecs_world_t *w = ecs_init();
    ecs_entity_t Hunger = ecs_component(w, { .entity = ecs_entity(w, { .name = "Hunger" }), .type = { .size = sizeof(BHunger), .alignment = ECS_ALIGNOF(BHunger) } });
    ecs_entity_t HungerRate = ecs_component(w, { .entity = ecs_entity(w, { .name = "HungerRate" }), .type = { .size = sizeof(BHungerRate), .alignment = ECS_ALIGNOF(BHungerRate) } });
    ecs_entity_t Link = ecs_entity(w, { .name = "HungerLink" });
    ecs_add_id(w, Link, EcsTraversable);
    (void)Hunger; (void)HungerRate;
    uint64_t t0 = fw_now();
    for (int32_t i = 0; i < n; i++) {
        ecs_entity_t stats = ecs_new(w);
        ecs_add_id(w, stats, Hunger);
        ecs_add_id(w, stats, HungerRate);
        ecs_entity_t ch = ecs_new(w);
        ecs_add_pair(w, ch, Link, stats);
    }
    double create = fw_ms(t0);
    const char *exprs[3] = {
        "Hunger, HungerRate",
        "Hunger(up HungerLink), HungerRate(up HungerLink)",
        "Hunger, HungerRate, HungerLink($character, $this)",
    };
    ecs_strbuf_t out = ECS_STRBUF_INIT;
    ecs_strbuf_append(&out, "{\"n\":%d,\"create_ms\":%.3f,\"queries\":[", n, create);
    for (int k = 0; k < 3; k++) {
        t0 = fw_now();
        ecs_query_t *q = ecs_query(w, { .expr = exprs[k], .cache_kind = EcsQueryCacheAuto });
        double build = fw_ms(t0);
        int32_t matched = 0, batches = 0;
        double each = 0;
        if (q) {
            fw_iter_all(w, q, NULL); /* warm up */
            /* Repeat until enough time has passed to measure: browsers coarsen their clocks. */
            int32_t reps = 0;
            t0 = fw_now();
            do { batches = 0; matched = fw_iter_all(w, q, &batches); reps++; } while (fw_ms(t0) < 10.0 && reps < 100000);
            each = fw_ms(t0) / reps;
            ecs_query_fini(q);
        }
        ecs_strbuf_append(&out, "%s{\"expr\":\"%s\",\"build_ms\":%.4f,\"each_ms\":%.4f,\"matched\":%d,\"batches\":%d}",
            k ? "," : "", exprs[k], build, each, matched, batches);
    }
    ecs_strbuf_appendlit(&out, "]}");
    ecs_fini(w);
    return ecs_strbuf_get(&out);
}

/**
 * Spatial lookups, four ways (see the spatial lesson):
 *   0 scan:          no spatial structure, test every Position
 *   1 cell pair:     (InCell, cell) relationship, one table per occupied cell
 *   2 cell pair DF:  the same pair with DontFragment
 *   3 grid:          a plain grid of entity ids kept next to the ECS
 *   4 cell pair, looked up with a query variable instead of ecs_each_id
 * Each frame moves `moving` entities by a small random step (updating the cell
 * when it changes), then asks for the entities in `lookups` random cells.
 */
FW_EXPORT(fw_bench_spatial) char *fw_bench_spatial(int32_t n, int32_t grid, int32_t mode, int32_t moving, int32_t lookups, int32_t frames) {
    fw_rng = 12345;
    ecs_world_t *w = ecs_init();
    ecs_entity_t Pos = ecs_component(w, { .entity = ecs_entity(w, { .name = "Position" }), .type = { .size = sizeof(BPos), .alignment = ECS_ALIGNOF(BPos) } });
    ecs_entity_t InCell = ecs_entity(w, { .name = "InCell" });
    ecs_add_id(w, InCell, EcsExclusive);
    if (mode == 2) ecs_add_id(w, InCell, EcsDontFragment);
    bool pairs = mode == 1 || mode == 2 || mode == 4;
    const float cell = 10.0f, size = cell * (float)grid;
    int32_t cells = grid * grid;
    ecs_entity_t *cell_e = ecs_os_calloc_n(ecs_entity_t, cells);
    for (int32_t c = 0; c < cells; c++) cell_e[c] = ecs_new(w);
    /* mode 3: per-cell arrays of entity ids */
    ecs_vec_t *buckets = ecs_os_calloc_n(ecs_vec_t, cells);
    ecs_entity_t *ents = ecs_os_malloc_n(ecs_entity_t, n);
    int32_t *cur = ecs_os_malloc_n(int32_t, n);
    #define FW_CELL_OF(p) ((int32_t)((p).y / cell) * grid + (int32_t)((p).x / cell))
    for (int32_t i = 0; i < n; i++) {
        BPos p = { (float)(fw_rand() % 10000) / 10000.0f * size, (float)(fw_rand() % 10000) / 10000.0f * size };
        ecs_entity_t e = ecs_new(w);
        ecs_set_id(w, e, Pos, sizeof(BPos), &p);
        int32_t c = FW_CELL_OF(p);
        cur[i] = c;
        if (pairs) ecs_add_pair(w, e, InCell, cell_e[c]);
        if (mode == 3) ecs_vec_append_t(NULL, &buckets[c], ecs_entity_t)[0] = e;
        ents[i] = e;
    }
    ecs_query_t *q_all = ecs_query(w, { .terms = {{ .id = Pos }}, .cache_kind = EcsQueryCacheAuto });
    ecs_query_t *q_cell = NULL;
    int32_t var = -1;
    if (mode == 4) {
        q_cell = ecs_query(w, { .expr = "Position, (InCell, $cell)", .cache_kind = EcsQueryCacheAuto });
        var = ecs_query_find_var(q_cell, "cell");
    }
    double update_ms = 0, query_ms = 0, all_ms = 0;
    int64_t found = 0;
    int32_t changed_cells = 0;
    for (int32_t f = 0; f < frames; f++) {
        uint64_t t0 = fw_now();
        for (int32_t k = 0; k < moving; k++) {
            int32_t i = (int32_t)(fw_rand() % (uint32_t)n);
            ecs_entity_t e = ents[i];
            BPos *p = ecs_get_mut_id(w, e, Pos);
            p->x += ((float)(fw_rand() % 200) / 100.0f - 1.0f) * 3.0f;
            p->y += ((float)(fw_rand() % 200) / 100.0f - 1.0f) * 3.0f;
            if (p->x < 0) p->x = 0; if (p->y < 0) p->y = 0;
            if (p->x >= size) p->x = size - 0.01f; if (p->y >= size) p->y = size - 0.01f;
            int32_t c = FW_CELL_OF(*p);
            if (c != cur[i]) {
                changed_cells++;
                if (pairs) ecs_add_pair(w, e, InCell, cell_e[c]);
                if (mode == 3) {
                    ecs_entity_t *arr = ecs_vec_first_t(&buckets[cur[i]], ecs_entity_t);
                    int32_t cnt = ecs_vec_count(&buckets[cur[i]]);
                    for (int32_t j = 0; j < cnt; j++) if (arr[j] == e) { arr[j] = arr[cnt - 1]; ecs_vec_remove_last(&buckets[cur[i]]); break; }
                    ecs_vec_append_t(NULL, &buckets[c], ecs_entity_t)[0] = e;
                }
                cur[i] = c;
            }
        }
        update_ms += fw_ms(t0);
        t0 = fw_now();
        int32_t lreps = 0;
        do {
        for (int32_t l = 0; l < lookups; l++) {
            int32_t c = (int32_t)(fw_rand() % (uint32_t)cells);
            if (mode == 0) {
                float x0 = (float)(c % grid) * cell, y0 = (float)(c / grid) * cell;
                ecs_iter_t it = ecs_query_iter(w, q_all);
                while (ecs_query_next(&it)) {
                    BPos *p = ecs_field_w_size(&it, sizeof(BPos), 0);
                    for (int32_t r = 0; r < it.count; r++)
                        if (p[r].x >= x0 && p[r].x < x0 + cell && p[r].y >= y0 && p[r].y < y0 + cell) found++;
                }
            } else if (mode == 1 || mode == 2) {
                /* Iterate the tables (or sparse entries) that have this exact pair. */
                ecs_iter_t it = ecs_each_id(w, ecs_pair(InCell, cell_e[c]));
                while (ecs_each_next(&it))
                    for (int32_t r = 0; r < it.count; r++) { const BPos *p = ecs_get_id(w, it.entities[r], Pos); if (p) found++; }
            } else if (mode == 4) {
                ecs_iter_t it = ecs_query_iter(w, q_cell);
                ecs_iter_set_var(&it, var, cell_e[c]);
                while (ecs_query_next(&it)) {
                    const BPos *p = ecs_field_w_size(&it, sizeof(BPos), 0);
                    for (int32_t r = 0; r < it.count; r++) if (p[r].x >= 0) found++;
                }
            } else {
                ecs_entity_t *arr = ecs_vec_first_t(&buckets[c], ecs_entity_t);
                int32_t cnt = ecs_vec_count(&buckets[c]);
                for (int32_t j = 0; j < cnt; j++) { const BPos *p = ecs_get_id(w, arr[j], Pos); if (p) found++; }
            }
        }
        lreps++; } while (fw_ms(t0) < 5.0 && lreps < 10000);
        query_ms += fw_ms(t0) / lreps;
        /* A system that touches every Position (rendering, say): one callback per table. */
        t0 = fw_now();
        int32_t reps = 0;
        do {
            ecs_iter_t it = ecs_query_iter(w, q_all);
            float sum = 0;
            while (ecs_query_next(&it)) {
                BPos *p = ecs_field_w_size(&it, sizeof(BPos), 0);
                for (int32_t r = 0; r < it.count; r++) sum += p[r].x;
            }
            if (sum < -1) found++;
            reps++;
        } while (fw_ms(t0) < 5.0 && reps < 100000);
        all_ms += fw_ms(t0) / reps;
    }
    int32_t tables = 0;
    { ecs_iter_t it = ecs_query_iter(w, q_all); while (ecs_query_next(&it)) tables++; }
    char *res = flecs_asprintf("{\"mode\":%d,\"n\":%d,\"cells\":%d,\"update_ms\":%.3f,\"query_ms\":%.3f,\"all_ms\":%.3f,\"found\":%lld,\"cell_changes\":%d,\"tables\":%d}",
        mode, n, cells, update_ms / frames, query_ms / frames, all_ms / frames, (long long)(found / (frames ? frames : 1)), changed_cells, tables);
    for (int32_t c = 0; c < cells; c++) ecs_vec_fini_t(NULL, &buckets[c], ecs_entity_t);
    ecs_os_free(buckets); ecs_os_free(ents); ecs_os_free(cur); ecs_os_free(cell_e);
    ecs_query_fini(q_all);
    if (q_cell) ecs_query_fini(q_cell);
    ecs_fini(w);
    return res;
}

/* ------------------------------------------------------------------------- */
/* Networking lesson: entity ids, versions and ranges.                       */
/* Ids are passed as uint64 (BigInt in JS) so versions survive.              */

/** Create an entity id range [min, max] (max 0 = unbounded). Returns a handle for fw_range_set. */
FW_EXPORT(fw_range_new) int32_t fw_range_new(uint32_t min, uint32_t max) {
    return (int32_t)(uintptr_t)ecs_entity_range_new(world, min, max);
}

/** Activate a range from fw_range_new. */
FW_EXPORT(fw_range_set) void fw_range_set(int32_t range) {
    ecs_entity_range_set(world, (const ecs_entity_range_t*)(uintptr_t)range);
}

FW_EXPORT(fw_new) uint64_t fw_new(void) { return ecs_new(world); }

FW_EXPORT(fw_delete) void fw_delete(uint64_t e) { if (ecs_is_alive(world, e)) ecs_delete(world, e); }

/** The alive id (with version) for an index, or 0 if no version of it is alive. */
FW_EXPORT(fw_get_alive) uint64_t fw_get_alive(uint32_t index) { return ecs_get_alive(world, index); }

/**
 * ecs_make_alive, without its failure mode: returns 0 if the id was made alive,
 * 1 if exactly this id (same version) was already alive, 2 if the index is
 * alive with a different version (make_alive would fail).
 */
FW_EXPORT(fw_make_alive) int32_t fw_make_alive(uint64_t e) {
    ecs_entity_t cur = ecs_get_alive(world, (uint32_t)e);
    if (cur == e) return 1;
    if (cur) return 2;
    ecs_make_alive(world, e);
    return 0;
}

FW_EXPORT(fw_set_version) void fw_set_version(uint64_t e) { ecs_set_version(world, e); }

/** Add a tag/component by name. */
FW_EXPORT(fw_add_name) int32_t fw_add_name(uint64_t e, const char *comp) {
    ecs_entity_t c = ecs_lookup(world, comp);
    if (!c || !ecs_is_alive(world, e)) return 1;
    ecs_add_id(world, e, c);
    return 0;
}

/** Set a component on e from JSON (needs reflection). Returns 0 on success. */
FW_EXPORT(fw_set_json) int32_t fw_set_json(uint64_t e, const char *comp, const char *json) {
    ecs_entity_t c = ecs_lookup(world, comp);
    if (!c || !ecs_is_alive(world, e)) return 1;
    const ecs_type_info_t *ti = ecs_get_type_info(world, c);
    if (!ti) return 1;
    void *ptr = ecs_ensure_id(world, e, c, (size_t)ti->size);
    const char *r = ecs_ptr_from_json(world, c, ptr, json, NULL);
    ecs_modified_id(world, e, c);
    return r ? 0 : 1;
}

/** An entity as JSON (components with values, tags), or "null" if not alive. */
FW_EXPORT(fw_entity_json) char *fw_entity_json(uint64_t e) {
    if (!ecs_is_alive(world, e)) return ecs_os_strdup("null");
    ecs_entity_to_json_desc_t desc = ECS_ENTITY_TO_JSON_INIT;
    char *r = ecs_entity_to_json(world, e, &desc);
    return r ? r : ecs_os_strdup("null");
}
