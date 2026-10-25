import type { Op, Scenario } from './debugger/session';

type V2 = { x: number; y: number };

const COMPONENTS = `struct Position(x: f32, y: f32)
struct Velocity(x: f32, y: f32)`;
const COMPONENTS_CPP = `struct Position { float x, y; };
struct Velocity { float x, y; };`;

const moveSystem = {
  name: 'Move',
  query: 'Position, [in] Velocity',
  code: `world.system<Position, const Velocity>("Move")
  .each([](Position& p, const Velocity& v) {
    p.x += v.x; p.y += v.y;
  });`,
  fn: (it: Parameters<NonNullable<Scenario['systems']>[number]['fn']>[0]) => {
    const p = it.field<V2>(0);
    const v = it.field<V2>(1);
    for (let i = 0; i < it.count; i++) it.set(0, i, { x: p[i].x + v[i].x, y: p[i].y + v[i].y });
  },
};

/** A system that touches every entity with Position, to count callbacks (one per table). */
const touchSystem = (name: string, query: string, code: string) => ({
  name,
  query,
  code,
  fn: () => {},
});

const frame: Op = { code: 'world.progress();', run: (c) => c.progress() };

// ---------------------------------------------------------------- sync points
const ORC_BURNING = `Orc {
  Health: {hp: 80}
  Burning: {dps: 2}
}`;
const ORC_BURNING_CPP = 'world.entity("Orc").set(Health{80}).set(Burning{2});';
/** Ignite queues Burning through the stage; Burn reads it. `annotated` adds `[out] Burning()`. */
function syncSystems(annotated: boolean): NonNullable<Scenario['systems']> {
  return [
    {
      name: 'Ignite',
      query: annotated ? 'InLava, !Burning, [out] Burning()' : 'InLava, !Burning',
      code: `world.system("Ignite")
  .with<InLava>()
  .without<Burning>()${annotated ? '\n  .write<Burning>()' : ''}
  .each([](flecs::entity e) {
    e.set<Burning>({5});  // queued
  });`,
      fn: (it) => {
        for (const e of it.entities) it.setComponent(e, 'Burning', { dps: 5 });
      },
    },
    {
      name: 'Burn',
      query: 'Health, [in] Burning',
      code: `world.system<Health, const Burning>("Burn")
  .each([](Health& h, const Burning& b) {
    h.hp -= b.dps;
  });`,
      fn: (it) => {
        const h = it.field<{ hp: number }>(0);
        const b = it.field<{ dps: number }>(1);
        for (let i = 0; i < it.count; i++) it.set(0, i, { hp: h[i].hp - b[i].dps });
      },
    },
  ];
}

// ---------------------------------------------------------------- hierarchy ops
const parties = ['PartyA', 'PartyA', 'PartyB', 'PartyB', 'PartyC', 'PartyD'];
const childOfOps: Op[] = parties.map((pt, i) => ({
  code: `world.entity("U${i}").set(Position{}).child_of(${pt[0].toLowerCase()}${pt.slice(1)});`,
  run: (c) => {
    c.create(`U${i}`, { Position: { x: i, y: 0 } });
    c.add(`U${i}`, `(ChildOf, ${pt})`);
  },
}));
const parentOps: Op[] = parties.map((pt, i) => ({
  code: `world.entity("U${i}").set(Position{}).set(flecs::Parent{${pt[0].toLowerCase()}${pt.slice(1)}});`,
  run: (c) => {
    c.create(`U${i}`, { Position: { x: i, y: 0 } });
    c.set(`U${i}`, 'flecs.core.Parent', { value: pt });
  },
}));

// ---------------------------------------------------------------- faction ops
const factions = ['Red', 'Red', 'Blue', 'Green', 'Gold', 'Gold'];
const factionOps: Op[] = [
  ...factions.map((f, i) => ({
    code: `world.entity("T${i}").set(Position{}).add<Faction>(${f.toLowerCase()});`,
    run: (c: Parameters<Op['run']>[0]) => {
      c.create(`T${i}`, { Position: { x: i, y: i } });
      c.add(`T${i}`, `(Faction, ${f})`);
    },
  })),
  frame,
  { code: 't2.add<Faction>(red);  // Faction is Exclusive', run: (c) => c.add('T2', '(Faction, Red)') },
  frame,
];

// ---------------------------------------------------------------- storage trait ops
const healthOps: Op[] = [
  { code: 'a.set<Health>({100});', run: (c) => c.set('A', 'Health', { hp: 100 }) },
  { code: 'b.set<Health>({50});', run: (c) => c.set('B', 'Health', { hp: 50 }) },
  frame,
  { code: 'a.remove<Health>();', run: (c) => c.remove('A', 'Health') },
  frame,
];

/** The debugger scenarios used by the lessons, by id. */
export const SCENARIOS: Record<string, Scenario> = {
  archetypes: {
    id: 'archetypes',
    title: 'Entities moving between archetypes',
    setup: `${COMPONENTS}
Frozen {}
Ship { Position: {x: 1, y: 2} }
Rock { Position: {x: 5, y: 5} }
Tree { Position: {x: 9, y: 3} }`,
    setupCode: `${COMPONENTS_CPP}
struct Frozen { };  // a tag: no data

world.entity("Ship").set(Position{1, 2});
world.entity("Rock").set(Position{5, 5});
world.entity("Tree").set(Position{9, 3});`,
    ops: [
      { code: 'ship.set<Velocity>({1, 0});', run: (c) => c.set('Ship', 'Velocity', { x: 1, y: 0 }) },
      { code: 'tree.set<Velocity>({0, -1});', run: (c) => c.set('Tree', 'Velocity', { x: 0, y: -1 }) },
      { code: 'ship.add<Frozen>();', run: (c) => c.add('Ship', 'Frozen') },
      { code: 'ship.remove<Frozen>();', run: (c) => c.remove('Ship', 'Frozen') },
      { code: 'rock.destruct();', run: (c) => c.delete('Rock') },
      {
        code: 'world.entity("Probe").set(Position{0, 0}).set(Velocity{1, 1});',
        run: (c) => c.create('Probe', { Position: { x: 0, y: 0 }, Velocity: { x: 1, y: 1 } }),
      },
    ],
    tools: { components: ['Position', 'Velocity', 'Frozen'], frame: false, spawn: true },
    breakOn: ['storage'],
  },

  systems: {
    id: 'systems',
    title: 'Systems and the pipeline',
    setup: `${COMPONENTS}
Player {}
Teleporting {}
Ship {
  Position: {x: 0, y: 0}
  Velocity: {x: 1, y: 0}
  Player
}
Probe {
  Position: {x: 5, y: 5}
  Velocity: {x: 0, y: 1}
}
Comet {
  Position: {x: 9, y: 0}
  Velocity: {x: -1, y: 0}
}
Rock { Position: {x: 2, y: 8} }`,
    setupCode: `${COMPONENTS_CPP}
struct Player { };
struct Teleporting { };

world.entity("Ship").set(Position{0, 0}).set(Velocity{1, 0}).add<Player>();
world.entity("Probe").set(Position{5, 5}).set(Velocity{0, 1});
world.entity("Comet").set(Position{9, 0}).set(Velocity{-1, 0});
world.entity("Rock").set(Position{2, 8});`,
    systems: [
      {
        name: 'Render',
        query: '[in] Position',
        phase: 'OnStore',
        code: `// Declared first, but OnStore runs late in the frame.
world.system<const Position>("Render")
  .kind(flecs::OnStore)
  .each([](const Position& p) { /* draw a sprite at p */ });`,
        fn: () => {},
      },
      moveSystem,
      {
        name: 'Teleport',
        query: 'Position, Teleporting',
        code: `world.system<Position>("Teleport")
  .with<Teleporting>()
  .each([](Position& p) { p = {100, 100}; });`,
        fn: (it) => {
          for (let i = 0; i < it.count; i++) it.set(0, i, { x: 100, y: 100 });
        },
      },
      {
        name: 'Input',
        query: 'Velocity, Player',
        phase: 'PreUpdate',
        code: `// Declared last, but PreUpdate runs before OnUpdate.
world.system<Velocity>("Input")
  .with<Player>()
  .kind(flecs::PreUpdate)
  .each([](Velocity& v) { v = read_stick(); });`,
        fn: (it) => {
          for (let i = 0; i < it.count; i++) it.set(0, i, { x: 0, y: 2 });
        },
      },
    ],
    ops: [frame, { code: 'rock.add<Teleporting>();', run: (c) => c.add('Rock', 'Teleporting') }, frame],
    tools: { components: ['Velocity', 'Player', 'Teleporting'], frame: true },
    breakOn: ['storage', 'callbacks'],
  },

  commands: {
    id: 'commands',
    title: 'Commands and sync points',
    setup: `${COMPONENTS}
Moving {}
Ship {
  Position: {x: 0, y: 0}
  Velocity: {x: 1, y: 0}
}
Probe {
  Position: {x: 5, y: 5}
  Velocity: {x: 0, y: 1}
}
Rock { Position: {x: 2, y: 8} }`,
    setupCode: `${COMPONENTS_CPP}
struct Moving { };

world.entity("Ship").set(Position{0, 0}).set(Velocity{1, 0});
world.entity("Probe").set(Position{5, 5}).set(Velocity{0, 1});
world.entity("Rock").set(Position{2, 8});`,
    systems: [
      moveSystem,
      {
        name: 'MarkMoving',
        query: '[in] Velocity, !Moving',
        code: `world.system<const Velocity>("MarkMoving")
  .without<Moving>()
  .each([](flecs::entity e, const Velocity&) {
    e.add<Moving>();   // enqueued: we're iterating!
    e.set<Velocity>({2, 0});
  });`,
        fn: (it) => {
          for (const e of it.entities) {
            it.add(e, 'Moving');
            it.setComponent(e, 'Velocity', { x: 2, y: 0 });
          }
        },
      },
    ],
    ops: [frame, frame, { code: 'rock.set<Velocity>({1, 1});', run: (c) => c.set('Rock', 'Velocity', { x: 1, y: 1 }) }, frame],
    variants: [
      { label: 'Enqueued (it->stage)' },
      { label: 'Immediate (it->world)', opsOnWorld: true, note: 'The systems are now immediate (.immediate()) and write through it->world: applied mid-iteration.' },
    ],
    tools: { components: ['Velocity', 'Moving'], frame: true },
    breakOn: ['storage', 'commands', 'callbacks'],
  },

  syncPoints: {
    id: 'syncPoints',
    title: 'Where the pipeline merges',
    setup: `struct Health(hp: f32)
struct Burning(dps: f32)
InLava {}
Knight {
  Health: {hp: 100}
  InLava
}
Goblin {
  Health: {hp: 40}
  InLava
}`,
    setupCode: `struct Health { float hp; };
struct Burning { float dps; };
struct InLava { };

world.entity("Knight").set(Health{100}).add<InLava>();
world.entity("Goblin").set(Health{40}).add<InLava>();`,
    systems: syncSystems(false),
    variants: [
      { label: 'No annotation', setup: ORC_BURNING, setupCode: ORC_BURNING_CPP },
      {
        label: 'With .write<Burning>',
        setup: ORC_BURNING,
        setupCode: ORC_BURNING_CPP,
        systems: syncSystems(true),
        note: 'Ignite now declares that it may queue Burning, so the pipeline merges before Burn.',
      },
      {
        label: 'Burn idle',
        setup: 'Orc { Health: {hp: 80} }',
        setupCode: 'world.entity("Orc").set(Health{80});   // not burning: Burn matches nothing',
        note: 'Nothing is burning yet, so Burn is inactive when the frame starts and the schedule has only Ignite in it.',
      },
    ],
    ops: [frame, frame],
    breakOn: ['storage', 'commands', 'callbacks'],
  },

  observers: {
    id: 'observers',
    title: 'Hooks and observers, in order',
    setup: `${COMPONENTS}
Collided {}
Ship {}`,
    setupCode: `${COMPONENTS_CPP}
struct Collided { };  // a custom event

world.component<Position>()
  .on_add(...).on_set(...).on_remove(...);  // hooks

auto ship = world.entity("Ship");`,
    hooks: ['Position'],
    entities: ['Ship'],
    observers: [
      { name: 'OnAddPosition', query: 'Position', events: ['OnAdd'], code: 'world.observer<Position>("OnAddPosition")\n  .event(flecs::OnAdd).each(...);' },
      { name: 'OnSetPosition', query: 'Position', events: ['OnSet'], code: 'world.observer<Position>("OnSetPosition")\n  .event(flecs::OnSet).each(...);' },
      { name: 'OnRemovePosition', query: 'Position', events: ['OnRemove'], code: 'world.observer<Position>("OnRemovePosition")\n  .event(flecs::OnRemove).each(...);' },
      {
        name: 'StartsMoving',
        query: 'Position, Velocity',
        events: ['OnAdd'],
        code: '// Fires when an entity starts matching\n// both terms (either one added last)\nworld.observer<Position, Velocity>("StartsMoving")\n  .event(flecs::OnAdd).each(...);',
      },
      { name: 'OnCollided', query: 'Position', events: ['Collided'], code: 'world.observer<Position>("OnCollided")\n  .event<Collided>().each(...);' },
    ],
    ops: [
      { code: 'ship.set<Position>({1, 2});', run: (c) => c.set('Ship', 'Position', { x: 1, y: 2 }) },
      { code: 'ship.set<Position>({3, 4});  // already has it', run: (c) => c.set('Ship', 'Position', { x: 3, y: 4 }) },
      { code: 'ship.set<Velocity>({1, 0});', run: (c) => c.set('Ship', 'Velocity', { x: 1, y: 0 }) },
      { code: 'world.event<Collided>().id<Position>().entity(ship).emit();', run: (c) => c.emit('Collided', 'Ship', 'Position') },
      { code: 'ship.remove<Position>();', run: (c) => c.remove('Ship', 'Position') },
      { code: 'ship.add<Position>();  // add, no set', run: (c) => c.add('Ship', 'Position') },
      { code: 'ship.destruct();', run: (c) => c.delete('Ship') },
    ],
    tools: { components: ['Position', 'Velocity'], frame: false },
    breakOn: ['storage', 'callbacks'],
  },

  queries: {
    id: 'queries',
    title: 'Cached and uncached queries',
    setup: `${COMPONENTS}
struct Mass(kg: f32)
Ship {
  Position: {x: 0, y: 0}
  Velocity: {x: 1, y: 0}
}
Rock { Position: {x: 3, y: 3} }`,
    setupCode: `${COMPONENTS_CPP}
struct Mass { float kg; };

auto movers = world.query_builder<Position, Velocity>("Movers")
  .cached().build();
auto adhoc = world.query<Position, Velocity>();  // uncached
auto heavy = world.query_builder<Position, Mass>("Heavy")
  .cached().build();`,
    queries: [
      { name: 'Movers', expr: 'Position, Velocity', cached: true },
      { name: 'AdHoc', expr: 'Position, Velocity', cached: false },
      { name: 'Heavy', expr: 'Position, Mass', cached: true },
    ],
    ops: [
      { code: 'movers.each(...);', run: (c) => c.iterate('Movers') },
      { code: 'adhoc.each(...);', run: (c) => c.iterate('AdHoc') },
      { code: 'ship.set<Mass>({500});  // new table', run: (c) => c.set('Ship', 'Mass', { kg: 500 }) },
      { code: 'rock.set<Velocity>({0, 1});', run: (c) => c.set('Rock', 'Velocity', { x: 0, y: 1 }) },
      { code: 'movers.each(...);', run: (c) => c.iterate('Movers') },
      { code: 'rock.set<Mass>({90});  // existing table', run: (c) => c.set('Rock', 'Mass', { kg: 90 }) },
      { code: 'heavy.each(...);', run: (c) => c.iterate('Heavy') },
    ],
    tools: { components: ['Position', 'Velocity', 'Mass'], frame: false, spawn: true },
    breakOn: ['storage', 'callbacks'],
  },

  hierarchy: {
    id: 'hierarchy',
    title: 'Hierarchies: ChildOf vs Parent',
    setup: `${COMPONENTS}
PartyA { Position: {x: 0, y: 0} }
PartyB { Position: {x: 10, y: 0} }
PartyC { Position: {x: 20, y: 0} }
PartyD { Position: {x: 30, y: 0} }`,
    systems: [touchSystem('Render', '[in] Position', 'world.system<const Position>("Render")\n  .each(...);  // every entity with Position')],
    variants: [
      { label: 'ChildOf', ops: [...childOfOps, frame], note: 'ChildOf: each parent is part of the child\'s type.' },
      { label: 'Parent', ops: [...parentOps, frame], note: 'Parent: the parent is a component value, not part of the type.' },
    ],
    ops: [],
    breakOn: ['storage', 'callbacks'],
  },

  factions: {
    id: 'factions',
    title: 'Relationship fragmentation and DontFragment',
    setup: `${COMPONENTS}
Faction { Exclusive }
Red {}
Blue {}
Green {}
Gold {}`,
    systems: [
      touchSystem('Render', '[in] Position', 'world.system<const Position>("Render")\n  .each(...);'),
      touchSystem('RedTeam', '[in] Position, (Faction, Red)', 'world.system<const Position>("RedTeam")\n  .with<Faction>(red)\n  .each(...);'),
    ],
    variants: [
      { label: 'Fragmenting (default)', setupCode: 'world.component<Faction>().add(flecs::Exclusive);' },
      {
        label: 'DontFragment',
        setup: 'Faction { DontFragment }',
        setupCode: 'world.component<Faction>()\n  .add(flecs::Exclusive)\n  .add(flecs::DontFragment);',
      },
    ],
    ops: factionOps,
    breakOn: ['storage', 'callbacks'],
  },

  traits: {
    id: 'traits',
    title: 'Storage traits: table column, Sparse, DontFragment',
    setup: `struct Position(x: f32, y: f32)
struct Health(hp: f32)
A { Position: {x: 1, y: 1} }
B { Position: {x: 2, y: 2} }
C { Position: {x: 3, y: 3} }`,
    setupCode: `struct Position { float x, y; };
struct Health { float hp; };`,
    systems: [
      {
        name: 'Regen',
        query: 'Health',
        code: 'world.system<Health>("Regen")\n  .each([](Health& h) { h.hp += 1; });',
        fn: (it) => {
          const h = it.field<{ hp: number }>(0);
          for (let i = 0; i < it.count; i++) it.set(0, i, { hp: h[i].hp + 1 });
        },
      },
      touchSystem('Render', '[in] Position', 'world.system<const Position>("Render")\n  .each(...);'),
    ],
    variants: [
      { label: 'Column (default)', ops: healthOps },
      { label: 'Sparse', setup: 'Health { Sparse }', setupCode: 'world.component<Health>().add(flecs::Sparse);', sparse: ['Health'], ops: healthOps },
      { label: 'DontFragment', setup: 'Health { DontFragment }', setupCode: 'world.component<Health>().add(flecs::DontFragment);', sparse: ['Health'], ops: healthOps },
    ],
    ops: healthOps,
    breakOn: ['storage', 'callbacks'],
  },

  batching: {
    id: 'batching',
    title: 'What the command queue merges away',
    setup: `struct Foo(x: f32)
CaseA {}
CaseB {}
CaseC {}
CaseD {}
A { Foo: {x: 40}
  CaseA }
B { Foo: {x: 40}
  CaseB }
C { Foo: {x: 40}
  CaseC }
D { Foo: {x: 40}
  CaseD }`,
    setupCode: `struct Foo { float x; };
// A, B, C and D each start with Foo{40}`,
    entities: ['A', 'B', 'C', 'D'],
    observers: [
      { name: 'OnAddFoo', query: 'Foo', events: ['OnAdd'], code: 'world.observer<Foo>().event(flecs::OnAdd)\n  .each([](Foo& f) { print(f.x); });' },
      { name: 'OnSetFoo', query: 'Foo', events: ['OnSet'], code: 'world.observer<Foo>().event(flecs::OnSet)\n  .each([](Foo& f) { print(f.x); });' },
      { name: 'OnRemoveFoo', query: 'Foo', events: ['OnRemove'], code: 'world.observer<Foo>().event(flecs::OnRemove)\n  .each([](Foo& f) { print(f.x); });' },
    ],
    systems: [
      {
        name: 'RemoveAdd',
        query: 'Foo, CaseA',
        phase: 'none',
        code: '// A: remove, then add again\ne.remove<Foo>();\ne.add<Foo>();',
        fn: (it) => {
          for (const e of it.entities) {
            it.remove(e, 'Foo');
            it.add(e, 'Foo');
          }
        },
      },
      {
        name: 'RemoveSetRemove',
        query: 'Foo, CaseB',
        phase: 'none',
        code: '// B: remove, set 50, remove\ne.remove<Foo>();\ne.set<Foo>({50});\ne.remove<Foo>();',
        fn: (it) => {
          for (const e of it.entities) {
            it.remove(e, 'Foo');
            it.setComponent(e, 'Foo', { x: 50 });
            it.remove(e, 'Foo');
          }
        },
      },
      {
        name: 'RemoveSet',
        query: 'Foo, CaseC',
        phase: 'none',
        code: '// C: remove, then set 50\ne.remove<Foo>();\ne.set<Foo>({50});',
        fn: (it) => {
          for (const e of it.entities) {
            it.remove(e, 'Foo');
            it.setComponent(e, 'Foo', { x: 50 });
          }
        },
      },
      {
        name: 'SetRemove',
        query: 'Foo, CaseD',
        phase: 'none',
        code: '// D: set 50, then remove\ne.set<Foo>({50});\ne.remove<Foo>();',
        fn: (it) => {
          for (const e of it.entities) {
            it.setComponent(e, 'Foo', { x: 50 });
            it.remove(e, 'Foo');
          }
        },
      },
    ],
    ops: [
      { code: 'removeAdd.run();        // A', run: (c) => c.runSystem('RemoveAdd') },
      { code: 'removeSetRemove.run();  // B', run: (c) => c.runSystem('RemoveSetRemove') },
      { code: 'removeSet.run();        // C', run: (c) => c.runSystem('RemoveSet') },
      { code: 'setRemove.run();        // D', run: (c) => c.runSystem('SetRemove') },
    ],
    breakOn: ['storage', 'commands', 'callbacks'],
  },

  references: {
    id: 'references',
    title: 'Holding on to component references',
    setup: COMPONENTS,
    setupAfter: `Ship { Position: {x: 1, y: 1} }
Tree { Position: {x: 9, y: 9} }`,
    setupCode: `${COMPONENTS_CPP}
auto ship = world.entity("Ship").set(Position{1, 1});
auto tree = world.entity("Tree").set(Position{9, 9});`,
    refs: true,
    ops: [
      { code: 'Position& p = ship.ensure<Position>();', run: (c) => c.takeRef('p', 'Ship', 'Position') },
      { code: 'p.x = 2;            // fine', run: (c) => c.writeRef('p', { x: 2 }) },
      { code: 'ship.set<Velocity>({1, 0});  // Ship moves', run: (c) => c.set('Ship', 'Velocity', { x: 1, y: 0 }) },
      { code: 'print(p.x);         // what does p see now?', run: (c) => c.readRef('p') },
      { code: 'p.x = 50;           // ...and who does this change?', run: (c) => c.writeRef('p', { x: 50 }) },
      { code: 'Position& q = ship.ensure<Position>();  // re-fetch', run: (c) => c.takeRef('q', 'Ship', 'Position') },
      {
        code: 'for (int i = 0; i < 4; i++)\n  world.entity().set(Position{}).set(Velocity{});',
        run: (c) => {
          for (let i = 0; i < 4; i++) c.create(`Probe${i}`, { Position: { x: i, y: 0 }, Velocity: { x: 0, y: 1 } });
        },
      },
      { code: 'print(q.x);         // and q?', run: (c) => c.readRef('q') },
      { code: 'flecs::ref<Position> r = ship.get_ref<Position>();\nprint(r->x);', run: (c) => c.readFlecsRef('r', 'Ship', 'Position') },
    ],
    variants: [
      { label: 'Table column (default)' },
      {
        label: 'Position is Sparse',
        setup: 'Position { Sparse }',
        setupCode: 'world.component<Position>().add(flecs::Sparse);',
        sparse: ['Position'],
        note: 'Position is Sparse now: its values live outside the tables and keep their address.',
      },
    ],
    tools: { components: ['Position', 'Velocity'], frame: false, spawn: true },
    breakOn: ['storage', 'refs'],
  },

  entities: {
    id: 'entities',
    title: 'Entity ids, names and recycling',
    setup: `${COMPONENTS}
Enemy {}`,
    setupCode: `${COMPONENTS_CPP}
struct Enemy { };`,
    showIds: true,
    ops: [
      { code: 'auto a = world.entity("A");', run: (c) => { c.create('A'); c.remember('a', 'A'); } },
      { code: 'a.set<Position>({1, 2});', run: (c) => c.set('A', 'Position', { x: 1, y: 2 }) },
      { code: 'auto b = world.entity("B").set<Position>({3, 4});', run: (c) => c.create('B', { Position: { x: 3, y: 4 } }) },
      { code: 'b.add<Enemy>();', run: (c) => c.add('B', 'Enemy') },
      { code: 'a.destruct();', run: (c) => c.delete('A') },
      { code: 'auto d = world.entity("D");  // reuses a\'s index', run: (c) => c.create('D') },
      { code: 'world.is_alive(a);', run: (c) => c.checkAlive('a') },
      { code: 'd.set<Position>({5, 6});', run: (c) => c.set('D', 'Position', { x: 5, y: 6 }) },
    ],
    tools: { components: ['Position', 'Velocity', 'Enemy'], frame: false, spawn: true },
    breakOn: ['storage'],
  },

  relationships: {
    id: 'relationships',
    title: 'Relationships: pairs, wildcards and Exclusive',
    setup: `struct Position(x: f32, y: f32)
Eats {}
Faction { Exclusive }
Apples {}
Pears {}
Red {}
Blue {}
Bob { Position: {x: 0, y: 0} }
Alice { Position: {x: 1, y: 0} }`,
    setupCode: `struct Position { float x, y; };
struct Eats { };                       // a relationship (just a tag)
world.component<Faction>().add(flecs::Exclusive);
auto apples = world.entity("Apples"), pears = world.entity("Pears");
auto red = world.entity("Red"), blue = world.entity("Blue");`,
    queries: [
      { name: 'EatsAnything', expr: 'Position, (Eats, *)', cached: true },
      { name: 'EatsApples', expr: 'Position, (Eats, Apples)', cached: true },
    ],
    ops: [
      { code: 'bob.add<Eats>(apples);', run: (c) => c.add('Bob', '(Eats, Apples)') },
      { code: 'alice.add<Eats>(pears);   // another target, another table', run: (c) => c.add('Alice', '(Eats, Pears)') },
      { code: 'bob.add<Eats>(pears);     // not exclusive: both pairs', run: (c) => c.add('Bob', '(Eats, Pears)') },
      { code: 'eatsAnything.each(...);   // (Eats, *)', run: (c) => c.iterate('EatsAnything') },
      { code: 'eatsApples.each(...);     // (Eats, Apples)', run: (c) => c.iterate('EatsApples') },
      { code: 'bob.add<Faction>(red);', run: (c) => c.add('Bob', '(Faction, Red)') },
      { code: 'bob.add<Faction>(blue);   // Exclusive: replaces red', run: (c) => c.add('Bob', '(Faction, Blue)') },
    ],
    tools: { components: ['Position'], frame: false },
    breakOn: ['storage', 'callbacks'],
  },

  idsInComponents: {
    id: 'idsInComponents',
    title: 'The same data as an entity id in a component',
    setup: `struct Position(x: f32, y: f32)
struct Eats(food: entity)
Apples {}
Pears {}
Bob { Position: {x: 0, y: 0} }
Alice { Position: {x: 1, y: 0} }
Carol { Position: {x: 2, y: 0} }`,
    setupCode: `struct Position { float x, y; };
struct Eats { flecs::entity_t food; };   // the target is just data`,
    queries: [{ name: 'Eaters', expr: 'Position, Eats', cached: true }],
    ops: [
      { code: 'bob.set<Eats>({apples});', run: (c) => c.set('Bob', 'Eats', { food: 'Apples' }) },
      { code: 'alice.set<Eats>({pears});', run: (c) => c.set('Alice', 'Eats', { food: 'Pears' }) },
      { code: 'carol.set<Eats>({apples});', run: (c) => c.set('Carol', 'Eats', { food: 'Apples' }) },
      { code: 'eaters.each(...);  // then check e.food yourself', run: (c) => c.iterate('Eaters') },
    ],
    breakOn: ['storage', 'callbacks'],
  },

  prefabs: {
    id: 'prefabs',
    title: 'Prefabs: copied and inherited components',
    setup: `struct MaxSpeed(value: f32)
struct Defence(value: f32)
struct Position(x: f32, y: f32)
Defence { (OnInstantiate, Inherit) }
prefab SpaceShip {
  MaxSpeed: {value: 100}
  Defence: {value: 50}
  Position: {x: 0, y: 0}
}`,
    setupCode: `struct MaxSpeed { float value; };
struct Defence { float value; };
struct Position { float x, y; };
world.component<Defence>()
  .add(flecs::OnInstantiate, flecs::Inherit);

auto ship = world.prefab("SpaceShip")
  .set(MaxSpeed{100}).set(Defence{50}).set(Position{0, 0});`,
    entities: ['SpaceShip'],
    queries: [{ name: 'Defended', expr: 'Defence', cached: true }],
    ops: [
      { code: 'auto s1 = world.entity("S1").is_a(ship);', run: (c) => { c.create('S1'); c.add('S1', '(IsA, SpaceShip)'); } },
      { code: 'auto s2 = world.entity("S2").is_a(ship);', run: (c) => { c.create('S2'); c.add('S2', '(IsA, SpaceShip)'); } },
      { code: 'defended.each(...);   // matches inherited Defence', run: (c) => c.iterate('Defended') },
      { code: 'ship.set<Defence>({75});   // every instance sees it', run: (c) => c.set('SpaceShip', 'Defence', { value: 75 }) },
      { code: 'ship.set<MaxSpeed>({200}); // copies don\'t', run: (c) => c.set('SpaceShip', 'MaxSpeed', { value: 200 }) },
      { code: 's1.set<Defence>({10});     // override: s1 gets its own', run: (c) => c.set('S1', 'Defence', { value: 10 }) },
      { code: 'defended.each(...);', run: (c) => c.iterate('Defended') },
    ],
    breakOn: ['storage', 'callbacks'],
  },

  observerWrites: {
    id: 'observerWrites',
    title: 'Observers that write the component they observe',
    setup: `struct Health(value: f32)
struct Shield(value: f32)
A {}
B {}`,
    setupCode: `struct Health { float value; };
struct Shield { float value; };
auto a = world.entity("A"), b = world.entity("B");`,
    entities: ['A', 'B'],
    observers: [
      {
        name: 'DefaultHealth',
        query: 'Health',
        events: ['OnAdd'],
        code: '// "give new Health a default"\nworld.observer<Health>("DefaultHealth")\n  .event(flecs::OnAdd)\n  .each([](flecs::entity e, Health&) {\n    e.set<Health>({100});\n  });',
        fn: (it) => {
          for (const e of it.entities) it.setComponent(e, 'Health', { value: 100 });
        },
      },
      {
        name: 'ResetShield',
        query: 'Shield',
        events: ['OnSet'],
        code: '// "shields always reset to 100"\nworld.observer<Shield>("ResetShield")\n  .event(flecs::OnSet)\n  .each([](flecs::entity e, Shield& s) {\n    if (s.value != 100) e.set<Shield>({100});\n  });',
        fn: (it) => {
          const v = it.field<{ value: number }>(0);
          it.entities.forEach((e, i) => {
            if (v[i]?.value !== 100) it.setComponent(e, 'Shield', { value: 100 });
          });
        },
      },
      { name: 'WatchHealth', query: 'Health', events: ['OnSet'], code: 'world.observer<Health>("WatchHealth")\n  .event(flecs::OnSet).each(...print...);' },
      { name: 'WatchShield', query: 'Shield', events: ['OnSet'], code: 'world.observer<Shield>("WatchShield")\n  .event(flecs::OnSet).each(...print...);' },
    ],
    ops: [
      { code: 'a.set<Health>({50});', run: (c) => c.set('A', 'Health', { value: 50 }) },
      { code: 'b.set<Shield>({50});', run: (c) => c.set('B', 'Shield', { value: 50 }) },
    ],
    breakOn: ['storage', 'commands', 'callbacks'],
  },

  toggle: {
    id: 'toggle',
    title: 'CanToggle: switching a component off without a move',
    setup: `${COMPONENTS}
Velocity { CanToggle }
A {
  Position: {x: 0, y: 0}
  Velocity: {x: 1, y: 0}
}
B {
  Position: {x: 0, y: 0}
  Velocity: {x: 1, y: 0}
}
C {
  Position: {x: 0, y: 0}
  Velocity: {x: 1, y: 0}
}`,
    setupCode: `${COMPONENTS_CPP}
world.component<Velocity>().add(flecs::CanToggle);`,
    systems: [moveSystem],
    ops: [
      { code: 'b.disable<Velocity>();   // first time: one move', run: (c) => c.toggle('B', 'Velocity', false) },
      frame,
      { code: 'b.enable<Velocity>();    // just a bit', run: (c) => c.toggle('B', 'Velocity', true) },
      { code: 'b.disable<Velocity>();', run: (c) => c.toggle('B', 'Velocity', false) },
      frame,
    ],
    breakOn: ['storage', 'callbacks'],
  },

  cleanup: {
    id: 'cleanup',
    title: 'Deleting things: cleanup policies',
    setup: `${COMPONENTS}
Likes {}
OwnedBy { (OnDeleteTarget, Delete) }
Ship { Position: {x: 0, y: 0} }
Ship {
  Turret { Position: {x: 1, y: 0} }
  Cockpit { Position: {x: 0, y: 1} }
}
Bob { Position: {x: 5, y: 5} }
Alice { Position: {x: 6, y: 5} }
Cargo { Position: {x: 7, y: 5} }`,
    setupCode: `${COMPONENTS_CPP}
struct Likes { };                           // default cleanup
world.component<OwnedBy>()
  .add(flecs::OnDeleteTarget, flecs::Delete);  // die with the owner
auto ship = world.entity("Ship").set(Position{0, 0});
world.entity("Turret").child_of(ship).set(Position{1, 0});
world.entity("Cockpit").child_of(ship).set(Position{0, 1});`,
    observers: [{ name: 'OnRemovePosition', query: 'Position', events: ['OnRemove'], code: 'world.observer<Position>().event(flecs::OnRemove).each(...);' }],
    ops: [
      { code: 'bob.add<Likes>(alice);', run: (c) => c.add('Bob', '(Likes, Alice)') },
      { code: 'cargo.add<OwnedBy>(alice);', run: (c) => c.add('Cargo', '(OwnedBy, Alice)') },
      { code: 'alice.destruct();   // Bob loses (Likes, Alice); Cargo is deleted', run: (c) => c.delete('Alice') },
      { code: 'ship.destruct();    // ChildOf: children are deleted too', run: (c) => c.delete('Ship') },
    ],
    breakOn: ['storage', 'callbacks'],
  },
};
