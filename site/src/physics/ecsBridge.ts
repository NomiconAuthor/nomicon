/**
 * A physics engine wired into a real flecs world through handles: the integration the
 * "Physics in flecs" lesson describes, running on the site's flecs.wasm (flecs master) with the
 * teaching engine standing in for Jolt or Box3D.
 *
 * - Gameplay owns RigidBody (what the body should be) and Position/Rotation (where it is).
 * - The bridge owns BodyHandle: the engine's id for the body, never a pointer.
 * - Observers keep the two in step: OnSet RigidBody creates (or re-creates) the body,
 *   OnRemove BodyHandle destroys it. Deleting the entity removes both.
 * - Systems around the step: PreUpdate pushes gameplay's impulses in, OnUpdate steps the engine,
 *   PostUpdate copies awake bodies' transforms back into Position and Rotation, and turns the
 *   engine's contact events into flecs events.
 */
import { FlecsWorld } from '../flecs/runtime';
import { box, circle } from './collide';
import { angleOf, v } from './math';
import { type BodyHandle, World } from './world';

export interface BridgeLog {
  /** Which flecs callback ran. */
  who: string;
  text: string;
  cls?: 'obs' | 'sys' | 'evt' | 'muted';
}

export const SCRIPT = `
struct Position(x: f32, y: f32)
struct Rotation(angle: f32)
struct RigidBody(hw: f32, hh: f32, radius: f32, dynamic: f32)
struct BodyHandle(id: u32)
struct Impulse(x: f32, y: f32)
PhysicsWorld {}
ContactBegin {}
ContactEnd {}
Physics { PhysicsWorld }
`;

export class PhysicsBridge {
  engine = new World({ sleeping: true });
  ground: BodyHandle = 0;
  log: BridgeLog[] = [];
  /** Engine handle -> flecs entity, for contact events (the engine only knows handles). */
  owner = new Map<BodyHandle, number>();
  /** Transforms written back to flecs on the last frame (only awake bodies are copied). */
  written = 0;
  frames = 0;
  private counter = 0;
  /** Entities the lesson made, by name. */
  names = new Set<string>();

  constructor(public w: FlecsWorld) {}

  private push(who: string, text: string, cls: BridgeLog['cls'] = 'obs'): void {
    this.log.unshift({ who, text, cls });
    if (this.log.length > 60) this.log.pop();
  }

  init(): void {
    const w = this.w;
    const r = w.script(SCRIPT, 'physics_components');
    if (!r.ok) throw new Error(r.error);
    this.engine = new World({ sleeping: true });
    this.ground = this.engine.createBody({ type: 'static', shape: box(8, 0.5), position: v(0, -0.5) });
    this.owner.clear();
    this.names.clear();
    this.counter = 0;
    this.log = [];

    // Gameplay set (or changed) what the body should be: create it, or replace it.
    w.observer('CreateBody', 'RigidBody', ['OnSet'], (it) => {
      const rb = it.field<{ hw: number; hh: number; radius: number; dynamic: number }>(0);
      for (let i = 0; i < it.count; i++) {
        const e = it.entities[i];
        const json = w.entityJson(BigInt(e));
        const pos = (json?.components?.Position as { x: number; y: number } | undefined) ?? { x: 0, y: 3 };
        const rot = (json?.components?.Rotation as { angle: number } | undefined)?.angle ?? 0;
        const old = (json?.components?.BodyHandle as { id: number } | undefined)?.id;
        if (old) {
          this.engine.destroyBody(old);
          this.owner.delete(old);
        }
        const b = rb[i];
        const h = this.engine.createBody({
          type: b.dynamic ? 'dynamic' : 'static',
          shape: b.radius > 0 ? circle(b.radius) : box(b.hw, b.hh),
          position: v(pos.x, pos.y),
          angle: rot,
          tag: e % 6,
        });
        this.owner.set(h, e);
        it.setComponent(e, 'BodyHandle', { id: h });
        this.push('CreateBody', `OnSet RigidBody on ${it.name(e)}: ${old ? `destroyed body 0x${old.toString(16)}, ` : ''}created body 0x${h.toString(16)}, set BodyHandle`);
      }
    });

    // The handle went away (the entity was deleted, or RigidBody removed): destroy the body.
    w.observer('DestroyBody', 'BodyHandle', ['OnRemove'], (it) => {
      const hs = it.field<{ id: number }>(0);
      for (let i = 0; i < it.count; i++) {
        const h = hs[i].id;
        const ok = this.engine.destroyBody(h);
        this.owner.delete(h);
        this.push('DestroyBody', `OnRemove BodyHandle on ${it.name(it.entities[i])}: destroyed body 0x${h.toString(16)}${ok ? '' : ' (already gone)'}`);
      }
    });

    // No RigidBody, no body: remove the handle too (which runs DestroyBody).
    w.observer('DropHandle', 'RigidBody, BodyHandle', ['OnRemove'], (it) => {
      for (let i = 0; i < it.count; i++) {
        if (it.eventId !== 'RigidBody') continue;
        it.remove(it.entities[i], 'BodyHandle');
        this.push('DropHandle', `OnRemove RigidBody on ${it.name(it.entities[i])}: removing BodyHandle`);
      }
    });

    // Contact events, as flecs events on the entities involved.
    w.observer('OnContact', 'BodyHandle', ['ContactBegin', 'ContactEnd'], (it) => {
      for (let i = 0; i < it.count; i++) this.push('OnContact', `${it.event} on ${it.name(it.entities[i])}`, 'evt');
    });

    // Before the step: gameplay's impulses go into the engine, then the Impulse component is removed.
    w.system(
      'ApplyImpulses',
      'Impulse, BodyHandle',
      (it) => {
        const imp = it.field<{ x: number; y: number }>(0);
        const hs = it.field<{ id: number }>(1);
        for (let i = 0; i < it.count; i++) {
          this.engine.applyImpulse(hs[i].id, v(imp[i].x, imp[i].y));
          it.remove(it.entities[i], 'Impulse');
          this.push('ApplyImpulses', `${it.name(it.entities[i])}: impulse into body 0x${hs[i].id.toString(16)}, Impulse removed`, 'sys');
        }
      },
      { phase: 'PreUpdate' },
    );

    // The step itself: one entity matches, so this runs once a frame.
    w.system(
      'PhysicsStep',
      'PhysicsWorld',
      (it) => {
        this.engine.step(it.deltaTime);
      },
      { phase: 'OnUpdate' },
    );

    // After the step: copy awake bodies' transforms back. Sleeping bodies haven't moved, so skip them.
    w.system(
      'ReadTransforms',
      'Position, Rotation, BodyHandle',
      (it) => {
        const hs = it.field<{ id: number }>(2);
        for (let i = 0; i < it.count; i++) {
          const b = this.engine.get(hs[i].id);
          if (!b || !b.awake || b.type === 'static') continue;
          it.set(0, i, { x: b.xf.p.x, y: b.xf.p.y });
          it.set(1, i, { angle: angleOf(b.xf.q) });
          this.written++;
        }
      },
      { phase: 'PostUpdate' },
    );
  }

  /** One frame: run the flecs pipeline (which steps physics), then turn contact events into flecs events. */
  progress(dt: number): void {
    this.written = 0;
    this.w.progress(dt);
    this.frames++;
    for (const [list, name] of [
      [this.engine.began, 'ContactBegin'],
      [this.engine.ended, 'ContactEnd'],
    ] as const) {
      for (const ev of list) {
        for (const h of [ev.a, ev.b]) {
          const e = this.owner.get(h);
          if (e && this.w.isAlive(e)) this.w.emit(name, e, 'BodyHandle');
        }
      }
    }
  }

  spawn(kind: 'box' | 'ball', x: number, y: number, angle = 0): string {
    const name = `${kind === 'box' ? 'Crate' : 'Ball'}${++this.counter}`;
    this.names.add(name);
    this.w.rest('PUT', `/entity/${name}`);
    this.w.rest('PUT', `/component/${name}`, { component: 'Position', value: JSON.stringify({ x, y }) });
    this.w.rest('PUT', `/component/${name}`, { component: 'Rotation', value: JSON.stringify({ angle }) });
    const rb = kind === 'box' ? { hw: 0.4, hh: 0.4, radius: 0, dynamic: 1 } : { hw: 0, hh: 0, radius: 0.35, dynamic: 1 };
    this.w.rest('PUT', `/component/${name}`, { component: 'RigidBody', value: JSON.stringify(rb) });
    return name;
  }

  setRigidBody(name: string, rb: { hw: number; hh: number; radius: number; dynamic: number }): void {
    this.w.rest('PUT', `/component/${name}`, { component: 'RigidBody', value: JSON.stringify(rb) });
  }

  impulse(name: string, x: number, y: number): void {
    this.w.rest('PUT', `/component/${name}`, { component: 'Impulse', value: JSON.stringify({ x, y }) });
  }

  removeRigidBody(name: string): void {
    this.w.rest('DELETE', `/component/${name}`, { component: 'RigidBody' });
  }

  destroy(name: string): void {
    this.w.rest('DELETE', `/entity/${name}`);
  }

  /** Lesson entities with their components, for the view. */
  entities(): Array<{ name: string; id: number; pos?: { x: number; y: number }; rot?: number; handle?: number; rb?: { hw: number; hh: number; radius: number; dynamic: number } }> {
    const out = [];
    for (const name of this.names) {
      const id = this.w.lookup(name);
      if (!id) {
        this.names.delete(name);
        continue;
      }
      const j = this.w.entityJson(BigInt(id));
      const c = (j?.components ?? {}) as Record<string, unknown>;
      out.push({
        name,
        id,
        pos: c.Position as { x: number; y: number } | undefined,
        rot: (c.Rotation as { angle: number } | undefined)?.angle,
        handle: (c.BodyHandle as { id: number } | undefined)?.id,
        rb: c.RigidBody as { hw: number; hh: number; radius: number; dynamic: number } | undefined,
      });
    }
    return out;
  }
}

