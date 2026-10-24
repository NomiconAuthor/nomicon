// Bullet for the browser: a tiny C API over Bullet's rigid bodies for the physics lessons,
// compiled with Bullet's unity sources into one wasm32-wasi reactor (see build.sh). Same shape
// as box3d_web.c: create a world, add boxes and spheres, step, read back transforms.
#include "btBulletDynamicsCommon.h"
#include <new>

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))
#define MAX_BODIES 4096

static btDefaultCollisionConfiguration* g_config = nullptr;
static btCollisionDispatcher* g_dispatcher = nullptr;
static btDbvtBroadphase* g_broadphase = nullptr;
static btSequentialImpulseConstraintSolver* g_solver = nullptr;
static btDiscreteDynamicsWorld* g_world = nullptr;
static btRigidBody* g_bodies[MAX_BODIES];
static int g_count = 0;
static int g_substeps = 1;
static float g_scratch[MAX_BODIES * 8];

static void destroy_world() {
    if (!g_world) return;
    for (int i = g_world->getNumCollisionObjects() - 1; i >= 0; i--) {
        btCollisionObject* obj = g_world->getCollisionObjectArray()[i];
        btRigidBody* body = btRigidBody::upcast(obj);
        if (body && body->getMotionState()) delete body->getMotionState();
        g_world->removeCollisionObject(obj);
        delete obj->getCollisionShape();
        delete obj;
    }
    delete g_world;
    delete g_solver;
    delete g_broadphase;
    delete g_dispatcher;
    delete g_config;
    g_world = nullptr;
    g_count = 0;
}

EXPORT(bt_create) int bt_create(float gx, float gy, float gz, int iterations, int sleep, int splitImpulse) {
    destroy_world();
    g_config = new btDefaultCollisionConfiguration();
    g_dispatcher = new btCollisionDispatcher(g_config);
    g_broadphase = new btDbvtBroadphase();
    g_solver = new btSequentialImpulseConstraintSolver();
    g_world = new btDiscreteDynamicsWorld(g_dispatcher, g_broadphase, g_solver, g_config);
    g_world->setGravity(btVector3(gx, gy, gz));
    btContactSolverInfo& info = g_world->getSolverInfo();
    if (iterations > 0) info.m_numIterations = iterations;
    info.m_splitImpulse = splitImpulse != 0;
    g_count = 0;
    (void)sleep;
    return 1;
}

static int add(btCollisionShape* shape, int dynamic, float x, float y, float z, float qx, float qy, float qz, float qw,
               float vx, float vy, float vz, float density, float volume, float friction, float restitution, int sleep, float ccd) {
    if (g_count >= MAX_BODIES) return -1;
    btTransform t;
    t.setIdentity();
    t.setOrigin(btVector3(x, y, z));
    t.setRotation(btQuaternion(qx, qy, qz, qw));
    btScalar mass = dynamic ? density * volume : 0;
    btVector3 inertia(0, 0, 0);
    if (dynamic) shape->calculateLocalInertia(mass, inertia);
    btRigidBody::btRigidBodyConstructionInfo ci(mass, new btDefaultMotionState(t), shape, inertia);
    ci.m_friction = friction;
    ci.m_restitution = restitution;
    btRigidBody* body = new btRigidBody(ci);
    if (dynamic) {
        body->setLinearVelocity(btVector3(vx, vy, vz));
        if (!sleep) body->setActivationState(DISABLE_DEACTIVATION);
        if (ccd > 0) {
            // Bullet's continuous collision: sweep a sphere of this radius when moving more than the threshold per step.
            body->setCcdMotionThreshold(ccd);
            body->setCcdSweptSphereRadius(ccd * 0.8f);
        }
    }
    g_world->addRigidBody(body);
    g_bodies[g_count] = body;
    return g_count++;
}

EXPORT(bt_add_box) int bt_add_box(int dynamic, float x, float y, float z, float hx, float hy, float hz, float qx, float qy, float qz, float qw,
                                  float vx, float vy, float vz, float density, float friction, float restitution, int sleep) {
    btBoxShape* s = new btBoxShape(btVector3(hx, hy, hz));
    return add(s, dynamic, x, y, z, qx, qy, qz, qw, vx, vy, vz, density, 8 * hx * hy * hz, friction, restitution, sleep, 0);
}

EXPORT(bt_add_sphere) int bt_add_sphere(int dynamic, float x, float y, float z, float r, float vx, float vy, float vz,
                                        float density, float friction, float restitution, int sleep, int ccd) {
    btSphereShape* s = new btSphereShape(r);
    return add(s, dynamic, x, y, z, 0, 0, 0, 1, vx, vy, vz, density, 4.18879f * r * r * r, friction, restitution, sleep, ccd ? r : 0);
}

EXPORT(bt_step) void bt_step(float dt, int substeps) {
    // A fixed step of dt, split into substeps internal steps of dt / substeps.
    if (g_world) g_world->stepSimulation(dt, substeps, dt / (substeps > 0 ? substeps : 1));
}

EXPORT(bt_transforms) int bt_transforms(float* out) {
    for (int i = 0; i < g_count; i++) {
        const btTransform& t = g_bodies[i]->getWorldTransform();
        btQuaternion q = t.getRotation();
        float* o = out + i * 8;
        o[0] = t.getOrigin().x(); o[1] = t.getOrigin().y(); o[2] = t.getOrigin().z();
        o[3] = q.x(); o[4] = q.y(); o[5] = q.z(); o[6] = q.w();
        o[7] = g_bodies[i]->isActive() ? 1.0f : 0.0f;
    }
    return g_count;
}

EXPORT(bt_counters) void bt_counters(int* out) {
    int awake = 0, dynamic = 0;
    for (int i = 0; i < g_count; i++) {
        if (g_bodies[i]->getInvMass() == 0) continue;
        dynamic++;
        if (g_bodies[i]->isActive()) awake++;
    }
    out[0] = g_count;
    out[1] = g_dispatcher ? g_dispatcher->getNumManifolds() : 0;
    out[2] = dynamic;
    out[3] = awake;
}

EXPORT(bt_scratch) float* bt_scratch() { return g_scratch; }
