import type { IterCallback } from '../runtime';

/** How a system runs: on the main thread, split over every stage, or alone on a writable world. */
export type Kind = 'single' | 'multi' | 'immediate';

/** A declaration the reader can switch on and off (a write or read annotation). */
export interface Declaration {
  /** Query-language term added to the system's query when on, e.g. `[out] Burning()`. */
  term: string;
  /** The C++ builder call, e.g. `.write<Burning>()`. */
  cpp: string;
}

export interface FrameSystem {
  name: string;
  /** Query expression, without the declarations. */
  query: string;
  /** Phase (default OnUpdate). Ignored when `pipeline` is set. */
  phase?: string;
  /** Belongs to a custom pipeline (tagged with it) instead of a phase. */
  pipeline?: string;
  kind: Kind;
  declares?: Declaration[];
  /** Declarations switched on by default (by index). Default: all on. */
  declared?: boolean[];
  /** C++: the `world.system<...>("Name")` head and builder lines that never change. */
  cppHead: string;
  cppWith?: string[];
  /** C++ body after `.each(` / `.run(`. */
  cppBody: string;
  fn: IterCallback;
  /** flecs' own system: never toggled. */
  builtin?: boolean;
}

export interface FrameObserver {
  name: string;
  query: string;
  events: string[];
  code: string;
  fn: IterCallback;
}

/** What one recorded step does: a world.progress(), or running a custom pipeline once. */
export interface FrameStep {
  label: string;
  /** Run this custom pipeline (world.run_pipeline) instead of progress(). */
  pipeline?: string;
}

export interface FrameVariant {
  label: string;
  note?: string;
  stages?: number;
  /** Flecs Script added after the scenario setup (replaces `setupExtra`). */
  setupExtra?: string;
  kinds?: Record<string, Kind>;
  declared?: Record<string, boolean[]>;
  /** Observers whose operations go through the world (applied now) instead of the stage. */
  observersOnWorld?: string[];
  /** Hooks for this variant instead of the scenario's. */
  hooks?: FrameScenario['hooks'];
  setupCodeExtra?: string;
  /** Replace this text in the setup C++ (hooks must be set before a component is in use). */
  setupCodeEdit?: [string, string];
}

export interface FrameScenario {
  id: string;
  title: string;
  /** Flecs Script: components, phases, entities. */
  setup: string;
  /** More script, which variants may replace. */
  setupExtra?: string;
  /** The same setup in C++, shown to the reader. */
  setupCode: string;
  setupCodeExtra?: string;
  stages: number;
  /** Offer the thread-count control. */
  threads?: boolean;
  /** Offer per-system toggles (kind and declarations). */
  toggles?: boolean;
  systems: FrameSystem[];
  observers?: FrameObserver[];
  /** Traced hooks: mask 1 on_add, 2 on_set, 4 on_remove, 8 on_replace, 16 on_validate (rejects first field < min). */
  hooks?: Array<{ comp: string; mask: number; min?: number; code: string }>;
  pipelines?: Array<{ name: string; expr: string; code: string }>;
  steps: FrameStep[];
  variants?: FrameVariant[];
}

/** Entity ids by name, filled in by the recorder after setup (callbacks use them to find other entities). */
export const IDS: Record<string, number> = {};

type V2 = { x: number; y: number };
const progress: FrameStep = { label: 'world.progress()' };

// ---------------------------------------------------------------- frameTour
const TOUR_SETUP = `struct Position(x: f32, y: f32)
struct Velocity(x: f32, y: f32)
struct Health(hp: f32)
struct Burning(dps: f32)
struct Loot(gold: f32)
Player {}
InLava {}
Smoke {}
Dead {}
Cleanup {
  flecs.pipeline.Phase
  (DependsOn, flecs.pipeline.PostUpdate)
}
Hero {
  Position: {x: 0, y: 0}
  Velocity: {x: 0, y: 0}
  Health: {hp: 100}
  Player
}
${Array.from({ length: 10 }, (_, i) => `Goblin${i} {\n  Position: {x: ${i}, y: 0}\n  Velocity: {x: 1, y: 0}\n  Health: {hp: 40}\n}`).join('\n')}
${Array.from({ length: 4 }, (_, i) => `Imp${i} {\n  Position: {x: ${i}, y: 5}\n  Velocity: {x: 0, y: 1}\n  Health: {hp: 30}\n  InLava\n}`).join('\n')}
Orc {
  Position: {x: 9, y: 9}
  Velocity: {x: 0, y: 0}
  Health: {hp: 3}
  Burning: {dps: 5}
  InLava
  Smoke
}`;

const TOUR_CPP = `struct Position { float x, y; };  struct Velocity { float x, y; };
struct Health { float hp; };       struct Burning { float dps; };
struct Loot { float gold; };
struct Player {}; struct InLava {}; struct Smoke {}; struct Dead {};

world.set_threads(3);
auto cleanup = world.entity("Cleanup")
  .add(flecs::Phase).depends_on(flecs::PostUpdate);
world.component<Burning>().on_add(...).on_set(...);   // traced hooks

world.entity("Hero").set(Position{}).set(Velocity{}).set(Health{100}).add<Player>();
// 10 goblins: [Position, Velocity, Health]
// 4 imps:     [Position, Velocity, Health, InLava]
world.entity("Orc").set(Position{9, 9}).set(Velocity{}).set(Health{3})
  .set(Burning{5}).add<InLava>().add<Smoke>();

world.observer<Burning>("Smolder").event(flecs::OnAdd)
  .each([](flecs::entity e, Burning&) { e.add<Smoke>(); });
world.observer<Smoke>("SmokeFx").event(flecs::OnAdd).each(...);
world.observer<Loot>("ShowLoot").event(flecs::OnSet).each(...);`;

const tour: FrameScenario = {
  id: 'frameTour',
  title: 'One frame, end to end',
  setup: TOUR_SETUP,
  setupExtra: 'Corpse { Dead }',
  setupCode: TOUR_CPP,
  setupCodeExtra: 'world.entity("Corpse").add<Dead>();',
  stages: 3,
  threads: true,
  toggles: true,
  hooks: [{ comp: 'Burning', mask: 3, code: 'world.component<Burning>().on_add(...).on_set(...);' }],
  observers: [
    {
      name: 'Smolder',
      query: 'Burning',
      events: ['OnAdd'],
      code: 'world.observer<Burning>("Smolder").event(flecs::OnAdd)\n  .each([](flecs::entity e, Burning&) { e.add<Smoke>(); });',
      fn: (it) => {
        for (const e of it.entities) it.add(e, 'Smoke');
      },
    },
    { name: 'SmokeFx', query: 'Smoke', events: ['OnAdd'], code: 'world.observer<Smoke>("SmokeFx").event(flecs::OnAdd).each(...);', fn: () => {} },
    { name: 'ShowLoot', query: 'Loot', events: ['OnSet'], code: 'world.observer<Loot>("ShowLoot").event(flecs::OnSet).each(...);', fn: () => {} },
  ],
  systems: [
    {
      name: 'Input',
      query: 'Velocity, Player',
      phase: 'PreUpdate',
      kind: 'single',
      cppHead: 'world.system<Velocity>("Input")',
      cppWith: ['.with<Player>()', '.kind(flecs::PreUpdate)'],
      cppBody: '.each([](Velocity& v) { v = read_stick(); });',
      fn: (it) => {
        for (let i = 0; i < it.count; i++) it.set(0, i, { x: 1, y: 0 });
      },
    },
    {
      name: 'Move',
      query: 'Position, [in] Velocity',
      kind: 'multi',
      cppHead: 'world.system<Position, const Velocity>("Move")',
      cppBody: '.each([](Position& p, const Velocity& v) {\n    p.x += v.x; p.y += v.y;\n  });',
      fn: (it) => {
        const p = it.field<V2>(0);
        const v = it.field<V2>(1);
        for (let i = 0; i < it.count; i++) it.set(0, i, { x: p[i].x + v[i].x, y: p[i].y + v[i].y });
      },
    },
    {
      name: 'Ignite',
      query: 'InLava, !Burning',
      kind: 'multi',
      declares: [{ term: '[out] Burning()', cpp: '.write<Burning>()' }],
      cppHead: 'world.system("Ignite")',
      cppWith: ['.with<InLava>()', '.without<Burning>()'],
      cppBody: '.each([](flecs::entity e) {\n    e.set<Burning>({5});   // queued\n  });',
      fn: (it) => {
        for (const e of it.entities) it.setComponent(e, 'Burning', { dps: 5 });
      },
    },
    {
      name: 'Burn',
      query: 'Health, [in] Burning',
      kind: 'multi',
      cppHead: 'world.system<Health, const Burning>("Burn")',
      cppBody: '.each([](flecs::entity e, Health& h, const Burning& b) {\n    h.hp -= b.dps;\n    if (h.hp <= 0) e.add<Dead>();   // queued\n  });',
      fn: (it) => {
        const h = it.field<{ hp: number }>(0);
        const b = it.field<{ dps: number }>(1);
        for (let i = 0; i < it.count; i++) {
          const hp = h[i].hp - b[i].dps;
          it.set(0, i, { hp });
          if (hp <= 0) it.add(it.entities[i], 'Dead');
        }
      },
    },
    {
      name: 'Reap',
      query: 'Dead',
      phase: 'Cleanup',
      kind: 'immediate',
      cppHead: 'world.system("Reap")',
      cppWith: ['.with<Dead>()', '.kind(cleanup)'],
      cppBody:
        '.each([](flecs::iter& it, size_t i) {\n    it.world().entity().set<Loot>({10});   // applied now\n    it.entity(i).destruct();                // queued\n  });',
      fn: (it) => {
        for (const e of it.entities) {
          it.onWorld(() => {
            const loot = it.spawn('');
            it.setComponent(loot, 'Loot', { gold: 10 });
          });
          it.delete(e);
        }
      },
    },
    {
      name: 'Render',
      query: '[in] Position',
      phase: 'OnStore',
      kind: 'single',
      cppHead: 'world.system<const Position>("Render")',
      cppWith: ['.kind(flecs::OnStore)'],
      cppBody: '.each([](const Position& p) { draw(p); });',
      fn: () => {},
    },
  ],
  steps: [
    { label: 'Frame 1: world.progress()' },
    { label: 'Frame 2: world.progress()' },
  ],
  variants: [
    { label: 'As written' },
    {
      label: 'No .write<Burning>()',
      declared: { Ignite: [false] },
      note: 'Ignite no longer declares that it queues Burning, so nothing asks for a merge before Burn.',
    },
    {
      label: 'All single-threaded',
      kinds: { Move: 'single', Ignite: 'single', Burn: 'single' },
      note: 'Same systems without .multi_threaded(): Input, Move and Ignite now share a run.',
    },
    {
      label: 'Reap idle',
      setupExtra: '',
      setupCodeExtra: '// no Corpse: nothing is Dead when the frame starts',
      note: 'Nothing is Dead at the start, so Reap is inactive and not in the schedule until a merge gives it something to match.',
    },
  ],
};

// ---------------------------------------------------------------- chunking
const chunking: FrameScenario = {
  id: 'frameChunking',
  title: 'Rows to workers',
  setup: `struct Health(hp: f32)
Hot {}
Warm {}
Boss {}
${Array.from({ length: 10 }, (_, i) => `a${i} {\n  Health: {hp: ${10 + i}}\n  Hot\n}`).join('\n')}
${Array.from({ length: 4 }, (_, i) => `b${i} {\n  Health: {hp: ${20 + i}}\n  Hot\n  Warm\n}`).join('\n')}
boss {
  Health: {hp: 99}
  Hot
  Boss
}`,
  setupCode: `struct Health { float hp; };
struct Hot {}; struct Warm {}; struct Boss {};

world.set_threads(3);
// a0…a9:  [Health, Hot]          (10 rows)
// b0…b3:  [Health, Hot, Warm]    (4 rows)
// boss:   [Health, Hot, Boss]    (1 row)
world.observer("Calmed").with<Hot>().event(flecs::OnRemove).each(...);`,
  stages: 3,
  threads: true,
  observers: [{ name: 'Calmed', query: 'Hot', events: ['OnRemove'], code: 'world.observer("Calmed").with<Hot>().event(flecs::OnRemove).each(...);', fn: () => {} }],
  systems: [
    {
      name: 'Tick',
      query: 'Health',
      kind: 'multi',
      cppHead: 'world.system<Health>("Tick")',
      cppBody: '.each([](Health& h) { h.hp -= 1; });',
      fn: (it) => {
        const h = it.field<{ hp: number }>(0);
        for (let i = 0; i < it.count; i++) it.set(0, i, { hp: h[i].hp - 1 });
      },
    },
    {
      name: 'Cool',
      query: 'Hot',
      kind: 'multi',
      cppHead: 'world.system("Cool")',
      cppWith: ['.with<Hot>()'],
      cppBody: '.each([](flecs::entity e) { e.remove<Hot>(); });   // queued',
      fn: (it) => {
        for (const e of it.entities) it.remove(e, 'Hot');
      },
    },
    {
      name: 'Settle',
      query: 'Warm',
      kind: 'multi',
      cppHead: 'world.system("Settle")',
      cppWith: ['.with<Warm>()'],
      cppBody: '.each([](flecs::entity e) { e.remove<Warm>(); });   // queued',
      fn: (it) => {
        for (const e of it.entities) it.remove(e, 'Warm');
      },
    },
  ],
  steps: [progress],
};

// ---------------------------------------------------------------- chains
const chains: FrameScenario = {
  id: 'frameChains',
  title: 'Inside a merge',
  setup: `struct Health(hp: f32)
struct Burning(dps: f32)
struct Alert(level: f32)
Struck {}
Smoke {}
A {
  Health: {hp: 30}
  Struck
}
B {
  Health: {hp: 30}
  Struck
}
C {
  Health: {hp: 30}
  Struck
}
Camp {
  Alert: {level: 0}
}`,
  setupCode: `struct Health { float hp; };  struct Burning { float dps; };
struct Alert { float level; };  struct Struck {}; struct Smoke {};

world.component<Burning>().on_add(...).on_set(...);
world.component<Health>().on_add(...).on_set(...).on_remove(...);
// a, b, c: entities A, B, C with [Health, Struck]. camp: Camp, with [Alert].

world.observer<Burning>("Smolder").event(flecs::OnAdd)
  .each([](flecs::entity e, Burning&) { e.add<Smoke>(); });
world.observer("Alarm").with<Smoke>().event(flecs::OnAdd)
  .each([&](flecs::iter& it, size_t) { camp.stage(it).set<Alert>({1}); });
world.observer<Health>("WatchHealth").event(flecs::OnSet).each(...);
world.observer<Health>("Mourn").event(flecs::OnRemove).each(...);`,
  stages: 1,
  hooks: [
    { comp: 'Burning', mask: 3, code: '' },
    { comp: 'Health', mask: 7, code: '' },
  ],
  observers: [
    {
      name: 'Smolder',
      query: 'Burning',
      events: ['OnAdd'],
      code: '',
      fn: (it) => {
        for (const e of it.entities) it.add(e, 'Smoke');
      },
    },
    {
      name: 'Alarm',
      query: 'Smoke',
      events: ['OnAdd'],
      code: '',
      fn: (it) => {
        it.setComponent(IDS.Camp, 'Alert', { level: 1 });
      },
    },
    { name: 'WatchHealth', query: 'Health', events: ['OnSet'], code: '', fn: () => {} },
    { name: 'Mourn', query: 'Health', events: ['OnRemove'], code: '', fn: () => {} },
  ],
  systems: [
    {
      name: 'Hit',
      query: 'Struck',
      kind: 'single',
      cppHead: 'world.system("Hit")',
      cppWith: ['.with<Struck>()'],
      cppBody:
        '.run([&](flecs::iter& it) {\n    a.stage(it).set<Burning>({5});    // A has no Burning: queued with its value\n    b.stage(it).set<Health>({20});    // B has Health: written now, OnSet queued\n    a.stage(it).set<Health>({1});     // same for A\n    c.stage(it).destruct();           // queued\n  });',
      fn: (it) => {
        if (!it.entities.includes(IDS.A)) return;
        it.setComponent(IDS.A, 'Burning', { dps: 5 });
        it.setComponent(IDS.B, 'Health', { hp: 20 });
        it.setComponent(IDS.A, 'Health', { hp: 1 });
        it.delete(IDS.C);
      },
    },
  ],
  steps: [progress],
  variants: [
    { label: 'As written' },
    {
      label: 'With on_validate',
      hooks: [
        { comp: 'Burning', mask: 3, code: '' },
        { comp: 'Health', mask: 7 | 16, min: 5, code: '' },
      ],
      setupCodeEdit: ['.on_remove(...);', '.on_remove(...)\n  .on_validate([](flecs::entity, const Health& h) {\n    return h.hp >= 5;   // reject\n  });'],
      note: 'Health now has an on_validate hook that rejects hp below 5.',
    },
    {
      label: 'With on_replace',
      hooks: [
        { comp: 'Burning', mask: 3, code: '' },
        { comp: 'Health', mask: 7 | 8, code: '' },
      ],
      setupCodeEdit: ['.on_remove(...);', '.on_remove(...).on_replace(...);'],
      note: 'Health now has an on_replace hook, which runs when a value is about to be replaced.',
    },
    {
      label: 'Observer writes through the world',
      observersOnWorld: ['Smolder'],
      setupCodeExtra: '// Smolder now calls it.world().entity(e).add<Smoke>(): applied on the spot',
      note: 'Smolder adds Smoke through the world instead of the entity handle it was given.',
    },
  ],
};

// ---------------------------------------------------------------- two pipelines
const twoPipelines: FrameScenario = {
  id: 'framePipelines',
  title: 'Two pipelines',
  setup: `struct Position(x: f32, y: f32)
struct Velocity(x: f32, y: f32)
PhysicsSystem {}
Bounced {}
${[3, 1, 6, 2].map((y, i) => `Ball${i} {\n  Position: {x: ${i}, y: ${y}}\n  Velocity: {x: 0, y: -1.5}\n}`).join('\n')}`,
  setupCode: `struct Position { float x, y; };  struct Velocity { float x, y; };
struct PhysicsSystem {}; struct Bounced {};

world.set_threads(2);
// Ball0…Ball3: [Position, Velocity], falling.

// A pipeline of its own: every system with .kind<PhysicsSystem>(), in creation order.
auto physics = world.pipeline()
  .with(flecs::System)
  .with<PhysicsSystem>()
  .build();

// The game loop: physics at a fixed step (twice this frame), then the frame.
world.run_pipeline(physics, 1.0f / 120);
world.run_pipeline(physics, 1.0f / 120);
world.progress();`,
  stages: 2,
  threads: true,
  toggles: true,
  pipelines: [{ name: 'Physics', expr: 'flecs.system.System, PhysicsSystem', code: '' }],
  systems: [
    {
      name: 'Integrate',
      query: 'Position, [in] Velocity',
      pipeline: 'Physics',
      kind: 'multi',
      cppHead: 'world.system<Position, const Velocity>("Integrate")',
      cppWith: ['.kind<PhysicsSystem>()'],
      cppBody: '.each([](Position& p, const Velocity& v) { p.y += v.y; });',
      fn: (it) => {
        const p = it.field<V2>(0);
        const v = it.field<V2>(1);
        for (let i = 0; i < it.count; i++) it.set(0, i, { x: p[i].x, y: p[i].y + v[i].y });
      },
    },
    {
      name: 'Collide',
      query: '[in] Position, !Bounced',
      pipeline: 'Physics',
      kind: 'single',
      declares: [{ term: '[out] Bounced()', cpp: '.write<Bounced>()' }],
      declared: [false],
      cppHead: 'world.system<const Position>("Collide")',
      cppWith: ['.kind<PhysicsSystem>()', '.without<Bounced>()'],
      cppBody: '.each([](flecs::entity e, const Position& p) {\n    if (p.y <= 0) e.add<Bounced>();   // queued\n  });',
      fn: (it) => {
        const p = it.field<V2>(0);
        for (let i = 0; i < it.count; i++) if (p[i].y <= 0) it.add(it.entities[i], 'Bounced');
      },
    },
    {
      name: 'PlaySound',
      query: 'Bounced',
      kind: 'single',
      cppHead: 'world.system("PlaySound")',
      cppWith: ['.with<Bounced>()'],
      cppBody: '.each([](flecs::entity e) {\n    play("thud"); e.remove<Bounced>();   // queued\n  });',
      fn: (it) => {
        for (const e of it.entities) it.remove(e, 'Bounced');
      },
    },
    {
      name: 'Render',
      query: '[in] Position',
      phase: 'OnStore',
      kind: 'multi',
      cppHead: 'world.system<const Position>("Render")',
      cppWith: ['.kind(flecs::OnStore)'],
      cppBody: '.each([](const Position& p) { draw(p); });',
      fn: () => {},
    },
  ],
  steps: [
    { label: 'world.run_pipeline(physics)', pipeline: 'Physics' },
    { label: 'world.run_pipeline(physics)', pipeline: 'Physics' },
    { label: 'world.progress()' },
  ],
};

export const FRAME_SCENARIOS: Record<string, FrameScenario> = {
  frameTour: tour,
  frameChunking: chunking,
  frameChains: chains,
  framePipelines: twoPipelines,
};

/** The C++ a reader would write for a system with this kind and these declarations. */
export function systemCpp(s: FrameSystem, kind: Kind, declared: boolean[]): string {
  const lines = [s.cppHead, ...(s.cppWith ?? [])];
  (s.declares ?? []).forEach((d, i) => {
    if (declared[i]) lines.push(d.cpp);
  });
  if (kind === 'multi') lines.push('.multi_threaded()');
  if (kind === 'immediate') lines.push('.immediate()');
  lines.push(s.cppBody);
  return lines.map((l, i) => (i ? `  ${l}` : l)).join('\n') + (s.cppBody.endsWith(';') ? '' : ';');
}

/** The query flecs gets for a system with these declarations. */
export function systemQuery(s: FrameSystem, declared: boolean[]): string {
  const extra = (s.declares ?? []).filter((_, i) => declared[i]).map((d) => d.term);
  return [s.query, ...extra].join(', ');
}
