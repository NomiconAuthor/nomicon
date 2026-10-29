/** The tactics lab's concept cards: short explanations with "Show me" scenarios. */
import type { CoverAlgo } from './coverTraces';
import type { Layer } from './app';
import type { Term } from '../lab/learn/concepts';

export interface TScenario {
  preset: string;
  seed?: number;
  /** Map size; omitted means the lab's default (small). */
  size?: string;
  layer: Layer;
  chokeMode?: 'move' | 'sight';
  ratio?: number;
  coverMethod?: CoverAlgo;
  budget?: number;
  stance?: 'standing' | 'crouched';
  /** Positions as fractions of the map; snapped to the nearest walkable cell. */
  unit?: [number, number];
  threats?: Array<[number, number]>;
}
export interface TConcept {
  id: string;
  group: string;
  title: string;
  layer?: Layer;
  body: string[];
  look?: string;
  tries: Array<{ label: string; scenario: TScenario }>;
}

const SPACE = 'Reading the space';
const COVER = 'Cover';
const DANGER = 'Danger and exposure';
const PRACTICE = 'In practice';

export const CONCEPTS: TConcept[] = [
  {
    id: 'grid25d',
    group: SPACE,
    title: 'A 2.5D grid',
    layer: 'map',
    body: [
      'Every analysis here runs on a grid of one-metre cells, each with a height and two properties: can you walk on it, and can you see through it. That is enough to separate the cases that matter tactically. A low wall (1 m) blocks movement and hides a crouching unit, but a standing one can see and strike over it. A ravine blocks movement but not sight. A building blocks both.',
      "Line of sight walks the cells the line between two eyes crosses and compares each cell's height with the height of the line at that point. It's exact for this model and costs one step per cell crossed: no physics engine involved. For static terrain and buildings, a raster like this (rasterised from level geometry, a heightmap or map data) answers most visibility questions far more cheaply than physics raycasts, leaving physics for dynamic objects.",
      "It's called 2.5D because each cell has one height: no overhangs, bridges over walkable tunnels or multi-storey interiors. Those need layers (one grid per floor, with links), which is a straightforward extension.",
    ],
    tries: [{ label: 'Show the town', scenario: { preset: 'town', layer: 'map' } }],
  },
  {
    id: 'clearance',
    group: SPACE,
    title: 'Clearance: how wide is it here?',
    layer: 'clearance',
    body: [
      'The clearance of a cell is its distance to the nearest thing you cannot walk through. It is computed for the whole map at once with a Euclidean distance transform (two passes of a one-dimensional algorithm, linear in the number of cells), so it is cheap even for big maps.',
      'Clearance turns "shape" into numbers. Corridors and streets become ridges of high clearance along their middles (the medial axis); open fields become broad peaks; the narrowest point of a route is where its ridge dips lowest. It also answers "will a 3 m wagon fit here?" with one lookup, which is how the pathing lab handles big units.',
      "Crucially, clearance measures width directly. Navmesh polygon area does not: a long narrow bridge can be one big polygon, so its area says nothing about how narrow it is. If you have a navmesh, compute clearance from its boundary edges instead of using polygon sizes.",
    ],
    look: 'the bright ridges running down the middle of streets, and how they dim at gaps between buildings.',
    tries: [{ label: 'Clearance in the town', scenario: { preset: 'town', layer: 'clearance' } }],
  },
  {
    id: 'chokes',
    group: SPACE,
    title: 'Chokes: narrow places between open ones',
    layer: 'chokes',
    body: [
      'A choke is a narrow opening between two wider areas. That definition has two halves, and both matter: narrow alone describes every alley; it is narrow relative to what it joins that makes a doorway between two halls a choke.',
      'The lab finds them with a watershed over the clearance field. Sort every free cell from widest to narrowest and flood: each local maximum starts a region, and regions grow as narrower cells join them. When two regions meet, look at the meeting cell. If it is nearly as wide as the regions, they are really one space and merge. If it is much narrower (the slider sets how much), the meeting cell is a choke and the regions stay apart. The first meeting cell of a pair is the saddle point, the widest point of the narrowest crossing, so its clearance is the choke\'s half-width. Recast\'s watershed partitioning floods its distance field in the same order, but merges regions by size rather than by how narrow the opening is, so its region borders aren\'t chokes.',
      "Width isn't the whole story. A narrow gap that no route uses doesn't matter. The circle on each choke is sized by traffic: the share of sampled shortest routes that pass through it.",
    ],
    look: 'doorways and gaps between buildings get chokes; long open streets do not, because the street is no narrower than the regions on either side.',
    tries: [
      { label: 'Chokes in the town', scenario: { preset: 'town', layer: 'chokes', chokeMode: 'move' } },
      { label: 'Doorways in a castle keep', scenario: { preset: 'keep', layer: 'chokes', chokeMode: 'move' } },
    ],
  },
  {
    id: 'moveVsSight',
    group: SPACE,
    title: 'Movement chokes vs sight chokes',
    layer: 'chokes',
    body: [
      "A bridge over a ravine is the narrowest place on the map for anyone walking, but not for anyone with a bow: you can see and loose arrows across the ravine along its whole length. A doorway in a wall is narrow for both. So there are two analyses, on two different maps of free space: one where everything you can't walk through is solid, and one where only what you can't see through is.",
      'This is exactly where a navmesh-only approach goes wrong. A navmesh describes walkable space, so it can only ever find movement chokes, and its polygons may not even show the bridge as narrow. Tactical questions ("where will they have to cross, and can we cover it from here?") need both: the movement choke tells you where enemies must pass; the sight analysis tells you whether that crossing can be watched and from where.',
    ],
    look: 'the bridge is a choke for movement and disappears for line of sight; the doorway in the wall is a choke in both.',
    tries: [
      { label: 'Bridge, for movement', scenario: { preset: 'ravine', layer: 'chokes', chokeMode: 'move' } },
      { label: 'Bridge, for line of sight', scenario: { preset: 'ravine', layer: 'chokes', chokeMode: 'sight' } },
    ],
  },
  {
    id: 'traffic',
    group: SPACE,
    title: 'Traffic: which places matter',
    layer: 'traffic',
    body: [
      'Run shortest paths between many random pairs of points and count how often each cell is used. The result is a sampled estimate of betweenness centrality, a graph-theory measure of how much a node lies "between" everything else. Here: 40 Dijkstra searches, 12 routes from each.',
      'High traffic plus low clearance is the real choke: a place that is both narrow and on the way to everywhere. High traffic and wide is a main street. Low traffic and narrow is a dead-end alley, which might be good cover precisely because nobody passes through.',
      'It depends only on the static map, so it is a natural bake: it parallelises (each source is independent), and coarse results are useful long before it finishes. The same region-and-choke map is what StarCraft bots use to decide where to wall off and where to expand.',
    ],
    tries: [{ label: 'Traffic in the town', scenario: { preset: 'town', layer: 'traffic' } }],
  },
  {
    id: 'openness',
    group: SPACE,
    title: 'Openness: field, street, junction or room?',
    layer: 'openness',
    body: [
      'Cast rays outwards at eye height in a ring (16 here) and pair opposite rays into axes: each axis is the open distance from wall to wall through the cell. Three numbers then classify the space: the longest axis, the shortest, and the axis at right angles to the longest.',
      "If even the shortest axis is long, it's open ground. If even the longest is short, it's enclosed: a room. Otherwise look across the longest axis: narrow that way means a street or corridor, however narrow (an alley is a corridor, not a room); wide that way too means two long directions cross, which is a junction, plaza or courtyard.",
      "An earlier version of this lab classified by the mean ray length first, and called narrow alleys \"enclosed\" because most of their rays are short. Averages hide shape; axes don't.",
      'In a game you rarely cast these specially: bake it from the map data (footprint density and distance to the nearest building say most of it), or read it from the size of the octree cell a unit is in. It is a useful factor for decisions: cover-to-cover movement in the open, slow and check corners when enclosed, avoid the middle of long streets, watch every exit at a junction.',
    ],
    look: 'hover a street, an alley, a crossroads and a field: the green and yellow axes show why each gets its label.',
    tries: [
      { label: 'Town', scenario: { preset: 'town', layer: 'openness' } },
      { label: 'Countryside', scenario: { preset: 'country', layer: 'openness' } },
    ],
  },
  {
    id: 'coverEdges',
    group: COVER,
    title: 'The grid edge scan',
    layer: 'cover',
    body: [
      'Cover is a walkable spot with something solid beside it, between you and the threat. On a grid: any walkable cell next to a low wall (crouch cover) or building (full cover), with the direction it protects from. Runs of connected cover cells form cover rails a unit can slide along, peeking from the ends.',
      "With a navmesh, the equivalent is to walk the navmesh's boundary edges: every edge where walkable space meets an obstacle is a candidate, and sampling heights along it (a few short rays at crouch and standing height) tells you which kind. From building footprints in the level data, footprint edges extruded to their heights are cover rails directly, and only small props need sampling.",
      'Scanning every edge is exhaustive and exact. It costs one pass over the map (or over the edges), which is fine as a bake, and it never misses a thin gap.',
    ],
    tries: [{ label: 'All cover in the town', scenario: { preset: 'town', layer: 'cover', coverMethod: 'scan' } }],
  },
  {
    id: 'coverWalk',
    group: COVER,
    title: 'The boundary walk (Recast-style)',
    layer: 'cover',
    body: [
      'This is how cover is usually generated from a navmesh, and it works the same way from building footprints. Five steps, each visible in playback:',
      '1. Trace the outline where walkable space meets obstacles, as chains of edges with the walkable side always on the same side. Recast already does this, and step 2 too, when it builds a navmesh: its contours are these outlines, already simplified, so with Recast you start from step 3 (keep only contour edges that face a wall, and remember they sit one agent radius out from it).',
      '2. Simplify the outlines with Douglas-Peucker, so a staircase of grid edges becomes one straight wall. The tolerance trades accuracy for fewer, longer edges: too loose and the simplified line cuts corners, which shows up later as probes that miss.',
      '3. Walk each edge at a fixed spacing (here 1 m), half a metre out on the walkable side, and cast short probes back towards the wall at crouch height and at standing height. Which ones hit decides full cover, low cover, or none (where the simplification cut a corner; from a navmesh, also edges that border a drop or water rather than a wall).',
      '4. Merge consecutive samples of the same kind into rails. A rail is what the AI reasons about: "slide along this wall to stay hidden".',
      '5. Find peek points: just past the end of each rail, if the cover stops and the ground is walkable, a unit can lean or step out to attack. Attack positions are at the ends of rails, not in their middles, which matters a lot when choosing cover.',
    ],
    look: 'pause at each stage and read the caption above the map. Then raise the Simplify tolerance and replay stage 3: red probes appear where the simplified outline has drifted off the real wall.',
    tries: [
      { label: 'Walk the town', scenario: { preset: 'town', layer: 'cover', coverMethod: 'walk' } },
      { label: 'Walk the countryside', scenario: { preset: 'country', layer: 'cover', coverMethod: 'walk' } },
    ],
  },
  {
    id: 'coverSampling',
    group: COVER,
    title: 'Sampling for cover: random, Poisson, edge-biased',
    layer: 'cover',
    body: [
      "When you can't afford an exhaustive pass (huge streamed worlds, dynamic geometry, a query around one unit right now), sample. Drop points, and at each one feel around for something solid. Unreal's Environment Query System works like this: generate candidate points, then filter and score them.",
      'Uniform random points are the simplest and the worst: they clump by chance, leave holes, and find a narrow feature with probability equal to its share of the area. Poisson-disk sampling keeps points a minimum distance apart, so coverage is even and there are no big holes. Edge-biased sampling puts the points where cover can actually be, on the boundary between obstacles and walkable ground, so almost every sample is useful.',
      'Thin gaps (a one-metre gap between two buildings: good cover, easy to miss) show the difference starkly. On the medium Thin gaps map with 300 samples, random and Poisson sampling each find about a third of the positions inside the gaps; edge-biased sampling finds nearly nine in ten, because a gap\'s walls are edges like any other.',
    ],
    look: 'the faint red edges are cover the method missed. Compare the "thin-gap positions found" stat across methods at the same sample count.',
    tries: [
      { label: 'Random, 300 samples', scenario: { preset: 'thin', size: 'medium', layer: 'cover', coverMethod: 'random', budget: 300 } },
      { label: 'Poisson, 300', scenario: { preset: 'thin', size: 'medium', layer: 'cover', coverMethod: 'poisson', budget: 300 } },
      { label: 'Edge-biased, 300', scenario: { preset: 'thin', size: 'medium', layer: 'cover', coverMethod: 'biased', budget: 300 } },
    ],
  },
  {
    id: 'dynamic',
    group: COVER,
    title: 'Changing terrain: bake, then keep it valid',
    layer: 'dynamic',
    body: [
      'Bake everything that depends only on the static world before play, in tiles. When the world changes (a door opens, a wall is destroyed, a crater appears), mark the tiles the change touches as dirty, grown by a margin of how far the analysis looks, and rebuild only those, as a background job spread over frames. Keep using the old tile data until the new data is ready, then swap it in. Units that had claimed cover in a dirty tile re-query.',
      "The margin is the subtle part. Per-cell cover depends only on direct neighbours, so a 1 m margin is enough (rails and peek points from a boundary walk need a couple of metres). Clearance and chokes depend on the widest open space, so a change can affect them tens of metres away. Exposure depends on sight lines, so a demolished wall changes it across the whole sight range: that is usually recomputed lazily, only near units that ask, rather than re-baked.",
      'Recast already works this way for navmeshes: a tiled navmesh with Detour\'s TileCache rebuilds just the tiles that temporary obstacles touch. A cover bake keyed to the same tiles can be rebuilt by the same job.',
      'Things that move (wagons, platforms, large creatures) should not be baked at all. Give them a cover template: points around the wagon in the object\'s own frame, transformed each frame and put in the spatial index next to the baked cover. They cost nothing to keep valid, and a cover query treats them like any other candidate.',
    ],
    look: 'blast a crater with a fireball beside a building and step through the rebuild: only the tiles around it are rebuilt, and the crater lip appears as new low cover.',
    tries: [{ label: 'Change the town', scenario: { preset: 'town', layer: 'dynamic' } }],
  },
  {
    id: 'exposure',
    group: DANGER,
    title: 'Exposure to known threats',
    layer: 'exposure',
    body: [
      "For each cell, test line of sight from every known threat's eyes to a unit standing or crouching there. The count is the cell's exposure. Low walls only protect a crouching unit, so switching stance changes the map a lot.",
      'This is exact, and it is the right tool for a handful of known threats. It costs one line-of-sight test per cell per threat, so it grows with both. A game usually computes it only for the cells it is considering (candidate cover near a unit), not for the whole map.',
    ],
    tries: [{ label: 'Two threats in the town', scenario: { preset: 'town', layer: 'exposure', stance: 'crouched', threats: [[0.85, 0.2], [0.8, 0.85]] } }],
  },
  {
    id: 'montecarlo',
    group: DANGER,
    title: 'Monte Carlo exposure (and playouts)',
    layer: 'montecarlo',
    body: [
      "When you don't know where the threats will be, sample them. Pick a random cell and a random archer position within range, test line of sight, and keep a running hit rate per cell (and per direction). After enough samples, each cell's rate approximates the chance that someone, somewhere nearby, can see you there. It's noisy at first and converges steadily, so it can be baked in a pre-run step or refined in the background forever.",
      'Concentrate samples where they matter (near roads, choke points, likely approach directions) and you have importance sampling. Weight archer positions by traffic and the map becomes "exposed to where enemies are likely to be".',
      "Playouts take the idea further: run many fast, low-resolution simulations of whole engagements and record where units die. That captures dynamics this can't (approach routes, flanking), but it learns whatever tactics the simulated enemies use, so it's best as a later refinement or a validation pass on top of exposure sampling.",
    ],
    look: 'the map starts speckled and smooths out as samples accumulate; the rose around the unit shows which directions it is exposed from.',
    tries: [{ label: 'Bake exposure for the town', scenario: { preset: 'town', layer: 'montecarlo' } }],
  },
  {
    id: 'query',
    group: PRACTICE,
    title: 'Picking cover: a utility query',
    layer: 'query',
    body: [
      'Finding cover is a scoring problem, and the AI lessons already have the tool: considerations with response curves, multiplied. Every cover position within 25 m of walking is a candidate (plus the wagon\'s template points), scored on six considerations: hidden from the threats at the chosen stance; can attack from here, by standing up behind low cover or leaning out to a neighbouring cell; the cover lies between it and the nearest threat; not too close to a threat; a short walk; and a route that isn\'t exposed.',
      '"Can attack from here" is what makes the difference. A spot behind a building is perfectly hidden and useless in a fight; the ends of rails (the peek points from the boundary walk) are where hidden and able-to-attack meet. An earlier version only tested sight lines from the cover cell itself, which made almost every spot "blind", so the nearest one always won.',
      "Things a real game adds: reservations (a spot claimed by one unit isn't offered to the next), material (a hedge hides but doesn't stop arrows), staleness (re-score when threats move, with hysteresis so units don't run between two spots), and invalidation when cover changes (see Changing terrain).",
    ],
    look: 'hover candidates to compare their breakdowns; the best one is usually a corner you can lean out from, not the nearest wall.',
    tries: [
      { label: 'Town, one threat', scenario: { preset: 'town', layer: 'query', stance: 'crouched', unit: [0.4, 0.55], threats: [[0.62, 0.3]] } },
      { label: 'Countryside, hedgerows', scenario: { preset: 'country', layer: 'query', stance: 'crouched', unit: [0.3, 0.5], threats: [[0.75, 0.5]] } },
    ],
  },
  {
    id: 'budget',
    group: PRACTICE,
    title: 'Baking vs querying',
    body: [
      'Almost everything here depends only on the static map, so it can be computed once, before play, and looked up: clearance, regions and chokes, traffic, openness, cover rails, and a baked exposure map. What must be computed live is whatever depends on where the threats are right now, and that can be narrowed to the few cells being considered.',
      'For worlds that only exist at run time (procedural levels, user-made maps, levels assembled from tiles), that suggests a loading step: rasterise the geometry into a grid like this one, run the bakes (all of them parallelise well), and stream the results by tile. Run-time ray casts are then left for what really changes, like doors and moving objects.',
    ],
    tries: [],
  },
];

/** Terms that explain themselves on hover anywhere in the lab. */
export const GLOSSARY: Record<string, Term> = {
  grid25d: {
    term: '2.5D grid',
    aliases: ['2.5d grid', '2.5d'],
    def: 'A grid where each cell has one height and two properties: can you walk through it, and can you see through it. Enough for walls, ravines and buildings; not for overhangs or several floors.',
    concept: 'grid25d',
  },
  los: {
    term: 'Line of sight',
    aliases: ['line of sight', 'sight line', 'sight lines'],
    def: "Walk the cells the line between two eyes crosses and compare each cell's height with the line's height there. One step per cell crossed; no physics engine.",
    concept: 'grid25d',
  },
  clearance: {
    term: 'Clearance',
    aliases: ['clearance', 'clearance field'],
    def: "A cell's distance to the nearest thing you can't walk through: how wide the space is here.",
    concept: 'clearance',
  },
  edt: {
    term: 'Distance transform',
    aliases: ['distance transform', 'euclidean distance transform'],
    def: 'Gives every cell its distance to the nearest obstacle. The exact version runs as two linear passes, one down every column and one along every row.',
    concept: 'clearance',
  },
  medial: {
    term: 'Medial axis',
    aliases: ['medial axis', 'ridge', 'ridges'],
    def: 'The line down the middle of a space, as far from the walls on either side as possible. In a clearance map it shows up as a bright ridge.',
    concept: 'clearance',
  },
  watershed: {
    term: 'Watershed flood',
    aliases: ['watershed', 'watershed flood'],
    def: 'Add cells from widest to narrowest. Each local maximum starts a region; regions grow outwards and, where two meet, either merge or are separated by a choke.',
    concept: 'chokes',
  },
  choke: {
    term: 'Choke',
    aliases: ['choke', 'chokes', 'choke point', 'choke points'],
    def: 'A narrow opening between two wider areas. Narrow relative to what it joins, not just narrow.',
    concept: 'chokes',
  },
  saddle: {
    term: 'Saddle',
    aliases: ['saddle', 'saddle point'],
    def: 'Where two regions first meet in the flood: the widest point of the narrowest crossing between them. Its clearance is the opening\'s half-width.',
    concept: 'chokes',
  },
  betweenness: {
    term: 'Betweenness centrality',
    aliases: ['betweenness centrality', 'betweenness'],
    def: 'How much a place lies on shortest routes between other places. Sampled here by running many shortest-path searches and counting how often each cell is used.',
    concept: 'traffic',
  },
  dijkstra: {
    term: 'Dijkstra search',
    aliases: ['dijkstra', 'dijkstra searches'],
    def: 'Shortest paths from one source to every reachable cell, expanding the nearest unvisited cell first. One search gives routes to every destination at once.',
  },
  dp: {
    term: 'Douglas-Peucker',
    aliases: ['douglas-peucker'],
    def: 'Simplifies a polyline by keeping only the points that stray more than a tolerance from a straight line between the ends, recursively.',
    concept: 'coverWalk',
  },
  rail: {
    term: 'Cover rail',
    aliases: ['rail', 'rails', 'cover rail', 'cover rails'],
    def: 'A run of cover of the same kind along one wall. A unit can slide along it while staying hidden.',
    concept: 'coverWalk',
  },
  peek: {
    term: 'Peek point',
    aliases: ['peek point', 'peek points'],
    def: 'A walkable spot just past the end of a rail, where a unit can lean or step out to attack and then step back into cover.',
    concept: 'coverWalk',
  },
  poisson: {
    term: 'Poisson-disk sampling',
    aliases: ['poisson-disk', 'poisson'],
    def: "Random points that are never closer than a minimum distance to each other, so they cover an area evenly without a grid's regularity.",
    concept: 'coverSampling',
  },
  dirty: {
    term: 'Dirty tile',
    aliases: ['dirty', 'dirty tiles', 'dirties'],
    def: 'A tile whose baked data a change may have invalidated. Only dirty tiles are rebuilt; the rest stay as they are.',
    concept: 'dynamic',
  },
  template: {
    term: 'Cover template',
    aliases: ['template', 'cover template'],
    def: "Cover points stored in a moving object's own frame and moved with it, instead of being baked into the map.",
    concept: 'dynamic',
  },
  exposure: {
    term: 'Exposure',
    aliases: ['exposure', 'exposed'],
    def: 'How many threats can see a unit standing or crouching at a cell, or, sampled, how likely it is that someone nearby can.',
    concept: 'exposure',
  },
  montecarlo: {
    term: 'Monte Carlo',
    aliases: ['monte carlo'],
    def: 'Estimating something by random sampling and averaging. Noisy at first, converging steadily as samples accumulate.',
    concept: 'montecarlo',
  },
  consideration: {
    term: 'Consideration',
    aliases: ['consideration', 'considerations'],
    def: 'One factor turned into a 0 to 1 score through a response curve. A candidate\'s score is the product of its considerations, so any one of them can veto it.',
    concept: 'query',
  },
  hysteresis: {
    term: 'Hysteresis',
    aliases: ['hysteresis'],
    def: "A bonus for the current choice, so a rival has to be clearly better before the unit switches. Stops units flip-flopping between two near-equal options.",
  },
};
