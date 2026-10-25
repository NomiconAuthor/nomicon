# Nomicon

https://nomicon.app/

**Interactive explainers for game programmers.** Every lesson has something running in the page that you can poke: a real ECS compiled to WebAssembly, engine mechanisms modelled step by step, game-AI techniques running on small deterministic worlds, a physics engine you can pause and step (plus real Jolt, Box3D and Bullet side by side), a small game over a simulated network, and three labs: pathfinding, terrain analysis and game feel.

Every number a lesson quotes from a simulation is checked by the test suite against the code the widget runs, so the text can't quietly drift from the behaviour it describes.

```
cd site
npm install
npm run dev        # http://localhost:4321
```

---

## What's on the site

| Section | URL | What it is |
|---|---|---|
| **engine** | `/engine/` | 11 lessons on what the hardware and the engine underneath do: cache lines and data layout, handles and allocators, game loops, determinism, deadlines and async work, spatial partitioning, octrees, jobs and task graphs, threads/pools/fibers, profiling, hot reloading code. |
| **flecs** | `/flecs/` | 18 lessons on the flecs ECS (plus further reading on the index page), each running **real flecs master** in the browser with its internals instrumented, plus a free-form **sandbox** at `/flecs/sandbox/` whose worlds can be shared as links. |
| **game ai** | `/ai/` | 17 lessons: utility AI, behaviour trees, GOAP, HTN planning, steering, local avoidance, formations, Recast and Detour, terrain analysis, cover, influence and threat maps, shared knowledge (blackboards), party roles (tank, healer, damage). Set in one fantasy world. |
| **physics** | `/physics/` | 12 lessons in three parts. **Concepts**: seven lessons on a small deterministic 2D engine written for the site (the step, broadphase and filtering, narrowphase with SAT/GJK/EPA and manifolds, solving contacts with Baumgarte vs soft step, sleeping and fast bodies, joints, queries and characters), kept free of engine-by-engine detail. **Choosing an engine**: a short decision lesson, then deep dives with **real Jolt, Box3D and Bullet** side by side in 3D, and Chaos and PhysX (with a six-engine comparison including Havok). **In practice**: when physics goes wrong (four mistakes live with their fixes, and a symptom table), and physics wired into **real flecs** through handles. |
| **network** | `/network/` | 7 lessons. Six on one small game over a simulated network (latency, jitter, loss): what a dumb terminal suffers, snapshots with interpolation and extrapolation (and bandwidth: quantising, deltas), client-side prediction and reconciliation, lag compensation with a rewind cap, lockstep and rollback between two peers (with checksums catching a desync), and choosing a model; then networking in flecs (matching entity ids, entity ranges, what to replicate), moved here from the flecs section (`/flecs/networking` redirects). |
| **labs** | `/labs/` | **Pathing lab** (`/pathing-lab/`): grid A*/JPS/Theta*, HPA*, Recast navmesh, PRM/RRT roadmaps, multi-unit, vehicles with Hybrid A* / state lattice / car RRT. **Tactics lab** (`/tactics-lab/`): clearance, chokes, traffic, openness, cover generation, exposure and best-cover queries on a 2.5D grid. **Feel lab** (`/feel-lab/`): a platformer with every game-feel setting exposed (acceleration, jump height and time, jump cut, fall gravity, apex hang, coyote time, jump buffer, corner correction, input delay, camera lerp/spring, dead zone, look-ahead, platform snapping, squash and shake), presets, a five-second input/state strip, and concept cards. |

There are also site-wide search (Ctrl/⌘ K or `/`), shareable lab and sandbox links, and three themes: **Nomicon** (the default: violet and gold, Cinzel headings), Dusk and Visual Studio. The whole site is static: no server code, no accounts, no tracking, and no third-party requests (fonts are served from the site). `sitemap.xml` and `robots.txt` are generated from the pages, so search engines find new lessons with no upkeep.

## Repository layout

```
README.md            this file: what Nomicon is and how it's built
LICENSE              MIT
site/                the website: Astro 7 + MDX, TypeScript widgets
  src/pages/         lessons (.mdx) and pages (.astro); one folder per section
  src/components/    custom elements that mount widgets into lessons
  src/engine/ src/flecs/ src/ai/ src/physics/ src/net/ src/feel/ src/recast/ src/tactics/ src/influence/ src/knowledge/ src/party/ src/sprites/ src/lab/
                     widget and simulation code, by topic (see "Code map")
  src/styles/        site chrome, lesson layout, themes
  public/            flecs.wasm builds, box3d.wasm, bullet.wasm, themes.js (runtime theme switch), favicon.svg/.ico, apple-touch and 192/512 icons
  test/              Node checks and batch runs (see "Tests")
flecs-wasm/          how flecs.wasm is built: instrumentation script, C glue, build.sh
box3d-wasm/          how box3d.wasm is built: a small C API over Box3D, build.sh
bullet-wasm/         how bullet.wasm is built: a small C API over Bullet, build.sh
tools/               ad-hoc Playwright browser checks (Python) used during development
```

Build output (`site/dist/`, and `distr/` if you keep a deploy copy), `node_modules/`, `site/.astro/` and logs are git-ignored. Line endings are LF (`.gitattributes`); `.wasm` and images are binary.

## Building, running, testing

Requires Node 22 or later. Pinned: astro 7.4.0, @astrojs/mdx 8.1.0, @astrojs/check 0.9.10, recast-navigation 0.43.1, jolt-physics 1.1.0, typescript 5.6.3, @fontsource/roboto, roboto-mono and cinzel 5.3.0.

```
cd site
npm install
npm run dev                       # http://localhost:4321
npm run build                     # astro check + astro build → site/dist/
npm test                          # flecs runtime + debugger replay + lesson claims
npm run check-lessons             # only the lesson claims (about 10 s)
npm run check-lessons -- party    # one or more groups by name
npm run check-lessons -- --all    # every group
```

Batch runs that produce the numbers lessons quote: `npm run ai-batch`, `steer-batch`, `avoid-batch`, `jobs-batch`, `wait-batch`, `party-batch`.

### Tests

`npm test` bundles each check with esbuild and runs it in Node (wasm read from `public/`):

- **`test/runtime-check.ts`**: the flecs runtime (scripts, REST, JS systems and observers, deferred ops through `it->stage`, reset, multiple worlds).
- **`test/debugger-check.ts`**: for every debugger scenario and variant, replaying the recorded trace onto the "before" snapshot must reproduce the real "after" storage. This keeps the step-through debugger truthful.
- **`test/lesson-claims.ts`**: **every number a lesson quotes from a simulation.** Each claim recomputes the value with the same code the widget runs, formats it as the lesson writes it, and checks that exact text is in the MDX. Changing a simulation therefore fails the build and prints the sentence or table row the lesson should now contain. Groups: `ai goap htn hotreload physics engines chaos ecs trouble network feel steering formations cover avoidance jobs waiting profiling influence knowledge party recast`. **When you add a measured number to a lesson, add a claim for it.** Numbers measured live in the browser (memory benchmarks, the flecs spatial benchmark, µs timings) aren't checked, because they vary by machine.

Browser checks in `tools/` are optional and need Python with Playwright and Chromium, plus a static server on the built site. `tools/browser-step-all-lessons.py [port]` (default 4330: `cd site/dist && python3 -m http.server 4330`) steps every debugger and variant to the end, clicks query presets, runs benchmarks, script presets and the networking demo, and reports page errors.

## Deploying

The site is static files only; the server has no Node.

1. The domain is set in `site/astro.config.mjs` (`site:`, `https://nomicon.app`). It's used for every page's canonical link and for the link-preview (`og:`) URLs.
2. `cd site && npm run build && npm test`.
3. Copy the **contents** of `site/dist/` into the web root (you should see `index.html`, `flecs.wasm`, `_astro/`, `flecs/`, `pathing-lab/`, ...). Any static host works.
4. `.wasm` must be served as `application/wasm` (nginx's default mime.types does this).
5. Serve `404.html` for missing pages instead of falling back to the home page. In nginx: `try_files $uri $uri/ =404;` in `location /`, and `error_page 404 /404.html;` in the `server` block.
6. Optional: real 301s for the old engine URLs: `rewrite ^/low-level/?(.*)$ /engine/$1 permanent;`. The site already forwards them with small pages that keep the `#anchor`.

**Link previews:** every page has `og:`/Twitter tags, and its own 1200 × 630 card in `site/public/og/` (listed in `src/og-cards.json`; pages without one use the home card). When lessons are added or renamed, regenerate them: `npm run build`, then `python3 tools/make-og-images.py [--fonts DIR]` from the repo root, then build again. The script needs Playwright with Chromium and takes the fonts from `site/node_modules/@fontsource` (or `--fonts DIR`). It rewrites every card, so if only some pages changed, keep the others from git to avoid churn.

**Themes without rebuilding:** edit `themes.js` in the web root (source `site/public/themes.js`). `enabled` lists the offered themes and `default` is the first-visit theme; with one theme enabled the menu disappears. Pages load it as `/themes.js?v=<build id>` (`BUILD_ID` in `themes.ts`), so each deploy gets a fresh URL past browser and CDN caches; an edit made on the server between builds still needs a hard refresh (or a short-TTL cache rule for `/themes.js`).

## How the site fits together

| Path (under `site/src/`) | What |
|---|---|
| `layouts/Base.astro` | Shell, navbar (`engine`, `flecs`, `ai`, `physics`, `network`, `labs`), search, theme menu. `[data-nav-slot]` is where pages put buttons (the labs' Concepts button). Always renders `.frame`, `.statusbar` and `.clock`; themes decide whether they show. |
| `layouts/Lesson.astro`, `styles/lesson.css` | Lesson layout: sidebar built from MDX frontmatter (`order`, `part`, `title`, `summary`), grouped into parts, prev/next, collapsible list on phones. Lesson numbers come from position, not from `order`. |
| `styles/site.css`, `styles/themes/*.css`, `themes.ts` | Dusk is the unscoped `site.css`; each other theme (`nomicon.css`, the default, and `vs.css`) is scoped to `html[data-theme='<id>']` and mostly re-points colour tokens. The Nomicon theme's heading face is one token, `--f-display` (Cinzel). Fonts come from the `@fontsource` packages, imported in `Base.astro` and bundled into `_astro/`. Code blocks are highlighted for all themes at once (Shiki dark/light/vs). |
| `components/EngineWidget.astro`, `AiWidget.astro`, `TacticsWidget.astro` | Custom elements that lazy-load a widget by `kind` (`data-kind`, plus `data-preset` JSON for options such as `scenario="simple"`). AI pages also load `engine.css` and `ai.css`. |
| `components/Flecs*.astro` | `FlecsDebugger` (step-through storage debugger), `FlecsQuery` (query playground), `FlecsBench` (benchmarks in a Web Worker), `FlecsScript` (script playground), `FlecsNet` (two worlds as server and client). |
| `components/lesson/Tip.astro`, `TryIt.astro` | Callouts; "Try it in the sandbox" links (`/flecs/sandbox/?preset=...`). |
| `pages/search-index.json.ts`, `components/Search.astro` | Search index: every lesson split at `##` headings plus both labs' concept cards (anchors via github-slugger, like Astro's heading ids). |
| `pages/sitemap.xml.ts`, `pages/robots.txt.ts` | Built from the lesson files and `site:` in the config; redirect pages are left out. |
| `lab/ui/share.ts` | Shareable lab links: state → JSON → deflate-raw → base64url in `#s=`. |
| `engine/dom.ts` | `h()` and `seg()` helpers and the shared `.ll*` widget styles used across sections. |

Old URLs: `/low-level/*` → `/engine/*` (`pages/low-level/[...slug].astro`, which keeps the `#anchor`) and `/flecs/systems-and-commands/` → `/flecs/commands/` (`astro.config.mjs` `redirects`).

## Code map

### Engine (`src/engine/`, lessons in `pages/engine/`)
Widget kinds and what they model:
- `cache`, `bench-layout|order|stride` (real typed-array benchmarks in `membench.worker.ts`), `falseshare` (toy MESI) → *Memory, cache lines and data layout*. Measured: AoS move ≈3.3× SoA, random access ≈3× in-order; stride cost keeps rising past 64 B.
- `slotmap`, `alloc` (arena, pool, first-fit free list with coalescing) → *Handles and allocators*.
- `loop` (virtual-clock game loop: variable vs fixed vs interpolated, jitter, hitches, spiral of death) → *Game loops*.
- `floatorder`, `rngstreams` (`determinism.ts`) → *Determinism*. `deadline` (`determinism.ts`) → *Deadlines and async work*, with a C++ `DeadlineScheduler` sketch.
- `spatial` (brute force, uniform grid, quadtree, BVH, sweep and prune; all checked against brute force) → *Spatial partitioning*.
- `octree` (box city with an airship, octree A* with string pulling vs a voxel grid; hand-rolled 3D canvas) → *Octrees and flying*.
- `parfor`, `taskgraph` (`jobsim.ts`: discrete-event job system, simulated µs so results match on every machine) → *Jobs and task graphs*.
- `waiting` (`waitsim.ts`: a job waiting on its children, handled by blocking, helping, fibers, stackless coroutines or one OS thread per task) and `pipeline` (named game and render threads, pipelined) → *Threads, pools and fibers*.
- `profiler` (`profsim.ts`: a made-up game with known true costs, profiled by sampling, full instrumentation and hand-placed zones) → *Profiling*. Ends with a table of which profiling tool does what (Visual Studio, WPA, Superluminal, Tracy, VTune, PIX, RenderDoc and others).
- `hotreload` (`hotreload.ts`: `ReloadSim`, a host, a game module and six orbs whose state is real bytes in a `DataView` and whose pointers are addresses in a modelled address space; three edits (code only, add a field, state holding pointers) × five strategies (restart, swap with state in the DLL, swap with host-owned state, patch in place, serialise and rebuild)) → *Hot reloading code*. The `hotreload` claims group checks the outcome of each combination the lesson describes.

### flecs (`src/flecs/`, lessons in `pages/flecs/`)
- `runtime.ts`: `FlecsWorld` loads a wasm build; REST in-process, scripts, systems and observers with JS callbacks, iterator ops, table / sparse / query-cache dumps, and the **trace**.
- `debugger/`: `session.ts` runs ops and snapshots, `model.ts` is the storage model plus event replay, `describe.ts` explains events, `view.ts` is the UI. `scenarios.ts` holds every lesson scenario (with optional *variants*: alternate setup, ops on the world instead of the stage, or a different wasm build).
- A scenario is Flecs Script `setup` (plus the C++ shown to readers), optional systems/observers/queries/hooks, and a list of `ops` (a C++ line plus `run(ctx)` via REST). Ops run lazily as the reader steps; any cursor position is `before + replay(events[0..n])`. "Lesson entities" exclude ids and name-only entities. Internal flecs systems are hidden unless "flecs internals" is ticked.
- Variants may replace `systems` (the `syncPoints` scenario adds `[out] Burning()`); `debugger-check.ts` asserts where its merge lands in each variant.
- `sandbox/sandbox.ts`: define components (column, Sparse, DontFragment), create entities, add observers and systems, run frames; shows tables with FLIP-animated row moves, sparse sets, observer counters and a per-action log. Presets via `?preset=basics|fragmentation|traits|empty`. **Share** records the preset plus every action since (an `Op` list), packs it into `#s=` with `lab/ui/share.ts`, and replays it quietly on load, so the tables, rows and observer counts come back exactly.

Lessons in order: entities, archetypes, references, relationships, prefabs, query-language, query-caching, systems, commands, sync-points-and-threads, command-merging, observers, deleting, fragmentation, storage-traits, spatial-data, reflection-and-scripts, networking, thinking-in-flecs. "Where to learn more" is a section of the flecs index (`components/lesson/FlecsLearnMore.mdx`); `/flecs/learn-more/` redirects there.

#### Building flecs.wasm (`flecs-wasm/`)
- Source: flecs **master**, amalgamated `distr/flecs.c/.h` (currently commit 75fa09f, 23 Oct 2026, built without `FLECS_DEBUG`, so asserts are compiled out). The commit is also set in `src/flecs/version.ts`, which every flecs lesson shows at the bottom; update both together. When upgrading, rebuild, run `npm test`, and diff every debugger scenario's trace between the old and new builds: that's what shows whether a lesson's description of what happens has changed.
- Build: `pip install ziglang`, then `cd flecs-wasm && ./build.sh /path/to/flecs/distr && cp flecs.wasm ../site/public/flecs.wasm`. Uses `zig cc -target wasm32-wasi`.
- `instrument.py` adds WASI detection and socket stubs (REST is called in-process via `ecs_http_server_request`), and injects about 15 `FW_TRACE(...)` calls inside named functions after short anchors (`flecs_table_init/fini`, `flecs_move_entity`, `flecs_observer_invoke`, `flecs_commands_flush`, sparse insert/remove, ...). If a flecs update moves an anchor, it prints which one; fix the anchor string.
- `flecs_web.c` (one translation unit with the instrumented flecs.c) exports the `fw_*` API: init/reset, REST, scripts, JS systems and observers, iterator ops through `it->stage` (or `it->world` with `fw_it_use_world(1)`), dumps, benchmarks (`fw_bench_ladder/spatial`), raw components, and networking helpers (`fw_range_new/set`, `fw_make_alive`, ...; ids cross as BigInt).
- Sparse/DontFragment fields in callbacks must be read per row with `ecs_field_at`.

#### flecs master gotchas
- Deferral is per target: ops on a stage (`it->stage`, C++ `.each()` handles) are queued; ops on the world apply **immediately**. Writing through the world is only legal in an `immediate` system: in an ordinary system the world is readonly and debug builds assert (this build has asserts off, so check on a native debug build). `fw_system` flag 2 makes a system immediate; the commands lesson's *Immediate* variant uses it. C++ `it.world()` is the real world.
- `ecs_entity_desc_t` has no `.add`; systems take `.phase` directly. Script struct syntax: `struct Position(x: f32, y: f32)`.
- Moves: remove actions run before the row is appended to the destination table. The row-delete trace is recorded after `on_remove` hooks.
- Command batching: the first command for an entity applies the whole batch (one move); since 9062901 a queued remove really removes.
- DontFragment components aren't in the type and aren't serialised by REST/JSON. Tables carry no DontFragment flag (`EcsTableHasDontFragment` is gone), so `fw_tables` reports `dontFragment: false` for every table; the sparse-set dump says whether a component is DontFragment.
- Instantiating a prefab runs `OnSet` observers for copied components with `it->event` reported as `OnAdd`.
- `make_alive` on an alive id with the same version is a silent no-op; with a different version it fails.
- Hierarchical names print with `.`; REST paths use `/`.

### Game AI (`src/ai/` and friends, lessons in `pages/ai/`)
- **Decision arena** (`ai/world.ts`, `brains.ts`, `curves.ts`, `ui.ts`, `widgets.ts`): one deterministic 10 Hz arena shared by every brain. A battle-mage with health, a staff of 6 charges, spare mana crystals and one potion; crates give cover; waves of 1–4 goblins; a potion shrine and a crystal cache. Seven actions (attack, cover, recharge, heal, potion, crystals, patrol). `UtilityBrain` (considerations, compensation, best/weighted/dual selection, inertia, commitment), `TreeBrain` (reactive or memory composites), `PlannerBrain` (forward A* over 8 boolean facts). `htn.ts`: `htnPlan` (total-order forward decomposition with backtracking over the same facts, GOAP's actions as primitive tasks, a 6-task domain whose root methods are the priorities) and `HtnBrain` (replans on fact changes and switches only to a plan with a smaller method traversal record; `interrupt: false` turns that off); `htnViz.ts` steps through a decomposition beside the domain. The side-by-side widget takes `lanes="goap,htn,htn-plain"` (default: utility, bt, goap, htn). Lesson numbers come from `npm run ai-batch` (seeds 1001–1040).
- **Movement** (`ai/vec.ts`, `course.ts`, `courseLab.ts`, `avoid.ts`, `steer.ts`): steering course (follow modes, wall sensing from feelers to context steering), local avoidance (separation, social forces, VO, RVO, ORCA), Reynolds playground, crowds, formations (`FormationSim` runs headless for the claims; 20 px = 1 m; the formation's facing turns at a limited rate and the leader never waits below 40% speed). The course plays at half speed by default (*Walk*), in simulated seconds, so its numbers are unchanged.
- **Navmeshes** (`recast/`): the real Recast (recast-navigation WASM) run stage by stage on a hand-built scene and read back at every stage; `test/recast-stages.ts` prints counts.
- **Terrain analysis** (`tactics/`): see the tactics lab below; AI lessons 12–14 embed it with `<TacticsWidget preset=... layer=... />`.
- **Influence and threat maps** (`influence/`): knights against goblins; influence by straight line or walking distance, control and tension, threat (cells an enemy can hit within bow range and line of sight, spread for stale sightings), routes that weigh threat.
- **Shared knowledge** (`knowledge/village.ts`, `viz.ts`, `knowledge.css`): adventuring parties and a guild board. Guild, party and adventurer blackboards; a versioned append-only guild log with a watermark per party; parties post and catch up only at the guild hall or a waystone. A troll wanders off, the clerk moves its notice, and party B keeps walking to the old bridge until its next waystone. Merge by when it was true; optional history cap with snapshots. `simple` (two parties) and `full` (four parties, two more waystones) presets; a toggle lets B read anywhere for comparison.
- **Party roles** (`party/`): five heroes (tank, cleric, knight, crossbow knight, battle-mage) against an orc warchief with goblin-archer adds: a threat table with 110/130% switching and taunts, triage healing scored by need × danger × role × efficiency, damage dealers who hold under the pull threshold and kill adds first, and cleave/slam telegraphs dodged with context steering over a danger map. Each part has a naive switch; 20-fight batch (`npm run party-batch`). The widget runs the 10 Hz sim on a smooth clock.
- **Sprites and missiles** (`sprites/`): Kenney's *Tiny Dungeon* (CC0) unit sprites as an inline atlas (`units.png` → `atlas.ts`; the orc and goblin archer are recoloured), and drawn crossbow bolts, arrows and arcane bolts. Used by the arena, party roles, shared knowledge and influence widgets; `scene.ts` adds party members in marching order (a shield knight leads), a speckled ground and stone walls for the steering course and formations, and `drawAgent` puts a sprite on an agent's real footprint for the Reynolds playground and local avoidance. The tactics lab draws its knight and goblin archers with them too. Purely visual: nothing feeds back into a simulation, so no lesson number depends on it.

### Physics (`src/physics/`, lessons in `pages/physics/`)
- **Teaching engine** (`math.ts`, `collide.ts`, `world.ts`): 2D rigid bodies behind generational handles (`BodyHandle`, index + generation like Jolt's `BodyID`), circles and convex polygons, brute or sort-and-sweep broadphase with category/mask filtering, SAT manifolds with reference-face clipping and feature ids, sequential impulses with warm starting in two flavours (**Baumgarte**, and Box2D v3's **soft step**: substeps, soft contacts, relax, restitution at the end), revolute/distance/mouse joints, union-find islands and sleep, continuous modes none/speculative/sweep (circle bullets against static), ray/circle casts and overlaps. **No `Math.sin`/`cos`/`atan2`/`hypot` in the simulation**: rotations are integrated and renormalised with `sqrt`, and `makeRot` uses its own polynomial, so scenes replay bit for bit in every browser. Display code may use trig.
- `scenes.ts` (pyramid, tower, bin, tunnel, bridge, joints, crowd), `view.ts` (`PhysicsView`: fixed-step loop, interpolation, mouse-joint dragging, overlays), `widgets.ts`, `narrowViz.ts` (SAT, GJK/EPA on the Minkowski difference, manifolds), `character.ts` (`KinematicMover`: collide and slide, step-up with a reach, slope limit, ground snap, capped pushing; `DynamicCharacter`), `charViz.ts` (queries and the character level).
- **Real engines** (`engines.ts`, `render3d.ts`, `enginesViz.ts`): `JoltEngine` over JoltPhysics.js (`jolt-physics/wasm`, single-threaded; the wasm comes in through Vite's `?url`; body ids must be copied because the binding returns them in a shared temporary) `Box3DEngine` over `public/box3d.wasm` and `BulletEngine` over `public/bullet.wasm`. The fast-ball scene starts the ball at z = 10.37 so that no discrete step lands it inside the plate (otherwise tunnelling results depend on float rounding). Scenes are plain data (`SCENES`). A painter-sorted canvas renderer draws them.
- `trouble.ts` / `troubleViz.ts`: four common mistakes (heavy on light, heavy on a chain, spawning inside, moving a platform by position) with a fix toggle each; each scene records its worst symptom.
- `asyncTick.ts`: game-thread vs async fixed-tick input latency model (Chaos lesson). `ecsBridge.ts` / `ecsViz.ts`: real flecs (`FlecsWorld`) with observers creating/destroying engine bodies from `RigidBody`/`BodyHandle`, PreUpdate/OnUpdate/PostUpdate systems, contact events emitted as flecs events after `progress`.
- Claims: `physics` (solver table, broadphase counts, tunnelling, bridge, characters), `engines` (loads all three real engines in Node and checks the pyramid, tower and fast-ball statements), `chaos` (latency table), `ecs` (the bridge's lifecycle facts), `trouble` (each mistake and its fix in `trouble.ts`).

#### Building box3d.wasm (`box3d-wasm/`)
- `./build.sh /path/to/box3d` with `pip install ziglang`: Box3D's `src/*.c` plus `box3d_web.c` compiled with `zig cc -target wasm32-wasi -O2 -DBOX3D_DISABLE_SIMD` as a reactor. Currently built from Box3D commit f36d061 (20 Oct 2026); the lesson's tip says SIMD is off. Copy `box3d.wasm` to `site/public/`.
- `box3d_web.c` exports `bw_create` (gravity, sleep, contact hertz, continuous), `bw_add_box`/`bw_add_sphere`, `bw_step(dt, substeps)`, `bw_transforms` (8 floats per body), `bw_counters`, impulses and a scratch buffer. Only four WASI imports, all stubbed in `engines.ts`.

#### Building bullet.wasm (`bullet-wasm/`)
- `./build.sh /path/to/bullet3`: Bullet's unity sources (`btLinearMathAll.cpp`, `btBulletCollisionAll.cpp`, `btBulletDynamicsAll.cpp`) plus `bullet_web.cpp`, with `zig c++ -target wasm32-wasi -O2 -fno-exceptions -fno-rtti`. Currently built from bullet3 master d3afe76 (9 Oct 2026; VERSION 3.27, last tagged release 3.25). Copy `bullet.wasm` to `site/public/`.
- `bullet_web.cpp` mirrors `box3d_web.c`: `bt_create` (gravity, solver iterations, split impulse), `bt_add_box`/`bt_add_sphere` (spheres can get CCD: motion threshold and swept-sphere radius), `bt_step(dt, internal steps)`, `bt_transforms`, `bt_counters`.

### Networking (`src/net/`, lessons in `pages/network/`)
- `core.ts`: the arena game (players as circles, 8-way input, walls, players push apart), stateless scripted players (`scriptedInput`), `keepInside`, and `Link`: one direction of a connection with latency, jitter (reorders) and loss, all seeded. 60 ticks a second; only +, -, *, / and sqrt in the simulation.
- `models.ts`: one model per lesson, each stepped a tick at a time on a shared clock: `DumbTerminal` (inputs up, full state down), `SnapshotClient` (snapshot rate, newest/interpolate/extrapolate, server-clock estimate from the smallest recent delay, bytes counted for full/quantised/delta encodings), `PredictedClient` (wait/predict/reconcile/smooth, redundant input sends, a "pusher" that causes mispredictions), `LagCompensation` (shooter, target past cover, rewind with a cap), `PeerToPeer` (lockstep or rollback with input delay, redundant inputs, checksums every 30 frames, an optional different-order maths peer to show a desync; `truthAt` replays the game with no network to check both peers).
- `widgets.ts` (canvas views, keyboard driving on the problem and prediction widgets), `components/NetWidget.astro`.
- Claims: `network` (every table and figure in the six lessons, plus both rollback peers matching a network-free run).

### Feel lab (`src/feel/`, page `pages/feel-lab.astro`)
- `controller.ts`: `Settings` (every feel knob, in tiles and seconds), presets (`TIGHT`, floaty, heavy, everything off), `jumpPhysics` (gravity and take-off speed from height and time to apex), `makeLevel` (the test course, built in code: gap, low ledge, steps, pit, long run, tower, shaft, with named spots), `Player` (fixed 60 Hz; input delay queue, acceleration by time, turnaround boost, air control, jump buffer, coyote time, jump cut, fall gravity, apex hang, corner correction; position integrated with the average velocity so jumps reach the set height) and `Camera` (locked, frame-rate-independent lerp, or critically damped spring; dead zone, look-ahead, platform snapping, trauma shake).
- `app.ts`: the lab UI on the shared lab layout and Concepts drawer; keyboard (presses latched so taps shorter than a tick count) and touch pads; the strip shows jump key, grounded, coyote window, buffered press, events and run speed for the last five seconds. `concepts.ts`: the cards and glossary (also in site search).
- Claims: `feel` (jump height exact, coyote time and buffer save presses that are otherwise eaten, corner correction gets you onto the low ledge).

### Labs
- **Pathing lab** (`lab/`, page `pages/pathing-lab.astro`): mounted from `lab/ui/app.ts`; keeps settings in `localStorage` (`pathfinding-lab/v1`).
- **Tactics lab** (`tactics/`, page `pages/tactics-lab.astro`): reuses the pathing lab's look, renderer, map generators and `Learn` concepts panel.
  - `world.ts`: 2.5D grid of 1 m cells: ground, low wall (hides a crouching body), building, ravine and water (block movement, not sight). Presets: town block, ravine and bridge, thin gaps, castle keep, countryside, caves, empty.
  - `analysis.ts`: EDT clearance, watershed regions and chokes, sampled traffic, openness, cover (edge scan, random, Poisson, edge-biased), exposure, progressive Monte Carlo exposure.
  - `playback.ts` plus traces (`coverTraces.ts`, `chokeTrace.ts`, `dynamicTrace.ts`) step through algorithms with captions.
  - `app.ts`: UI and the best-cover query (scored with `ai/curves.ts`); `concepts.ts`: concept cards and glossary. Compare mode runs two lanes on one world.

**Touch:** `engine/touch.ts` (`touchScroll()`): on touch screens a vertical swipe over a lab or AI canvas scrolls the page; touches that start on something draggable (or with a paint tool active) don't, and taps or sideways strokes still reach the widget. Engine widgets (profiler, octree, spatial) still use `touch-action: none`.

Gotcha found twice: a Dijkstra that skips stale heap entries (`if (c > cost[i]) continue`) must store costs in a `Float64Array`; Float32 rounding makes it skip real entries.

## Known gaps and ideas
- Labs: big maps and heavy planners block the main thread (move planning to a worker or show progress); no pinch-zoom on touch; in the pathing lab a vertical paint stroke on a phone has to start sideways; tooltips explaining "Cost" vs "Length".
- A cover lab: discovering cover from navmesh boundary edges, storing it in a spatial index, scoring it and keeping it valid.
- Physics: a ragdoll or vehicle lesson on Jolt; Box3D with WebAssembly SIMD (needs Emscripten's SSE headers or a port to `wasm_simd128.h`); move-event based transform sync in the Box3D adapter.
- flecs: more short lessons on non-obvious behaviour (verify on master first; add a variant when a PR changes behaviour); sandbox systems that modify values; relationships that aren't always Exclusive.
- Networking: rollback and client prediction.

## Contributing

- Every lesson has something to poke; prefer a visualisation to a paragraph.
- Simulations are deterministic (seeded, fixed tick). **If a lesson quotes a number from one, add a claim** in `test/lesson-claims.ts`; the checker prints the exact sentence the lesson should contain. Numbers measured live in the browser can't be checked, so say they vary by machine.
- Verify flecs behaviour against flecs master (the traced wasm build) before writing it down.
- Prose is British English, in short sentences, for working game programmers: explain mechanisms, not basics.
- Before a pull request: `npm run build` (zero `astro check` errors) and `npm test`.

## Credits and licences

Nomicon's own code and lesson text are released under the [MIT licence](LICENSE). It builds on:

- [flecs](https://github.com/SanderMertens/flecs) by Sander Mertens (MIT), compiled to WebAssembly and instrumented by `flecs-wasm/`.
- [Recast & Detour](https://github.com/recastnavigation/recastnavigation) (zlib), via [recast-navigation-js](https://github.com/isaac-mason/recast-navigation-js) (MIT).
- [Jolt Physics](https://github.com/jrouwe/JoltPhysics) by Jorrit Rouwe (MIT), via [JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js) (MIT).
- [Box3D](https://github.com/erincatto/box3d) by Erin Catto (MIT), compiled to WebAssembly by `box3d-wasm/`.
- [Bullet](https://github.com/bulletphysics/bullet3) by Erwin Coumans and contributors (zlib), compiled to WebAssembly by `bullet-wasm/`.
- [Tiny Dungeon](https://kenney.nl/assets/tiny-dungeon) sprites by Kenney (CC0); see `site/src/sprites/LICENSE-kenney-tiny-dungeon.txt`.
- [Astro](https://astro.build) and `@astrojs/mdx` (MIT), TypeScript (Apache 2.0), and the Roboto, Roboto Mono and Cinzel fonts (Apache 2.0 and SIL Open Font Licence), served from the site via the [Fontsource](https://fontsource.org) packages.
