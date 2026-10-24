// Box3D for the browser: a tiny C API over Box3D for the physics lessons, compiled with
// box3d.c sources into one wasm32-wasi reactor (see build.sh). The page drives one world:
// create it, add boxes and spheres, step, and read back transforms and counters.
#include "box3d/box3d.h"
#include <stdint.h>

#define EXPORT(name) __attribute__((export_name(#name)))
#define MAX_BODIES 4096

static b3WorldId g_world;
static int g_live = 0;
static b3BodyId g_bodies[MAX_BODIES];
static int g_count = 0;

EXPORT(bw_create) int bw_create(float gx, float gy, float gz, int sleep, float contactHertz, int continuous) {
    if (g_live) b3DestroyWorld(g_world);
    b3WorldDef def = b3DefaultWorldDef();
    def.gravity = (b3Vec3){gx, gy, gz};
    def.enableSleep = sleep != 0;
    def.enableContinuous = continuous != 0;
    if (contactHertz > 0) def.contactHertz = contactHertz;
    g_world = b3CreateWorld(&def);
    g_live = 1;
    g_count = 0;
    return 1;
}

EXPORT(bw_destroy) void bw_destroy(void) {
    if (g_live) b3DestroyWorld(g_world);
    g_live = 0;
    g_count = 0;
}

static int add_body(int type, float x, float y, float z, float qx, float qy, float qz, float qs, float vx, float vy, float vz, int bullet) {
    if (g_count >= MAX_BODIES) return -1;
    b3BodyDef bd = b3DefaultBodyDef();
    bd.type = type == 0 ? b3_staticBody : type == 1 ? b3_kinematicBody : b3_dynamicBody;
    bd.position = (b3Pos){x, y, z};
    bd.rotation = (b3Quat){{qx, qy, qz}, qs};
    bd.linearVelocity = (b3Vec3){vx, vy, vz};
    bd.isBullet = bullet != 0;
    g_bodies[g_count] = b3CreateBody(g_world, &bd);
    return g_count++;
}

static b3ShapeDef shape_def(float density, float friction, float restitution) {
    b3ShapeDef sd = b3DefaultShapeDef();
    sd.density = density;
    sd.baseMaterial.friction = friction;
    sd.baseMaterial.restitution = restitution;
    return sd;
}

EXPORT(bw_add_box) int bw_add_box(int type, float x, float y, float z, float hx, float hy, float hz, float qx, float qy, float qz, float qs, float vx, float vy, float vz, float density, float friction, float restitution) {
    int i = add_body(type, x, y, z, qx, qy, qz, qs, vx, vy, vz, 0);
    if (i < 0) return i;
    b3BoxHull hull = b3MakeBoxHull(hx, hy, hz);
    b3ShapeDef sd = shape_def(density, friction, restitution);
    b3CreateHullShape(g_bodies[i], &sd, &hull.base);
    return i;
}

EXPORT(bw_add_sphere) int bw_add_sphere(int type, float x, float y, float z, float r, float vx, float vy, float vz, float density, float friction, float restitution, int bullet) {
    int i = add_body(type, x, y, z, 0, 0, 0, 1, vx, vy, vz, bullet);
    if (i < 0) return i;
    b3Sphere s = {{0, 0, 0}, r};
    b3ShapeDef sd = shape_def(density, friction, restitution);
    b3CreateSphereShape(g_bodies[i], &sd, &s);
    return i;
}

EXPORT(bw_step) void bw_step(float dt, int substeps) {
    if (g_live) b3World_Step(g_world, dt, substeps);
}

// 8 floats per body: position xyz, rotation xyz s (quaternion), awake (0 or 1).
EXPORT(bw_transforms) int bw_transforms(float* out) {
    for (int i = 0; i < g_count; i++) {
        b3WorldTransform t = b3Body_GetTransform(g_bodies[i]);
        float* o = out + i * 8;
        o[0] = (float)t.p.x; o[1] = (float)t.p.y; o[2] = (float)t.p.z;
        o[3] = t.q.v.x; o[4] = t.q.v.y; o[5] = t.q.v.z; o[6] = t.q.s;
        o[7] = b3Body_IsAwake(g_bodies[i]) ? 1.0f : 0.0f;
    }
    return g_count;
}

// bodies, contacts, islands, awake bodies.
EXPORT(bw_counters) void bw_counters(int* out) {
    b3Counters c = b3World_GetCounters(g_world);
    out[0] = c.bodyCount;
    out[1] = c.contactCount;
    out[2] = c.islandCount;
    out[3] = b3World_GetAwakeBodyCount(g_world);
}

EXPORT(bw_impulse) void bw_impulse(int i, float x, float y, float z) {
    if (i < 0 || i >= g_count) return;
    b3Body_ApplyLinearImpulseToCenter(g_bodies[i], (b3Vec3){x, y, z}, true);
}

EXPORT(bw_set_velocity) void bw_set_velocity(int i, float x, float y, float z) {
    if (i < 0 || i >= g_count) return;
    b3Body_SetLinearVelocity(g_bodies[i], (b3Vec3){x, y, z});
}

// Scratch memory for the page to pass arrays through.
static float g_scratch[MAX_BODIES * 8];
EXPORT(bw_scratch) float* bw_scratch(void) { return g_scratch; }
