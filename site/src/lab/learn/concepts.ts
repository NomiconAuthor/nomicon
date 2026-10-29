/**
 * The lab's teaching content: a glossary (shown when you hover a term in the
 * explanations) and longer concept cards (the Concepts panel), each with
 * scenarios that set the lab up to show the idea. Adapted from the Pathfinding
 * Storyboard and the Pathfinding Field Guide.
 */

/** Settings a scenario applies; anything left out keeps the lab's defaults. */
export interface Scenario {
  preset: string;
  size?: string;
  seed?: number;
  need?: number;
  diagonal?: 'never' | 'noCorner' | 'always';
  useTerrain?: boolean;
  reachCheck?: boolean;
  overlays?: Partial<{
    clearance: boolean;
    components: boolean;
    tree: boolean;
    rawPath: boolean;
    structure: boolean;
  }>;
  /** Lane settings (lane B turns compare mode on). Keys are the lab's lane settings. */
  lanes: [Record<string, string | number | boolean>, Record<string, string | number | boolean>?];
  /** Extra random units to add. */
  units?: number;
  /** Put unit 1's goal somewhere this unit size can't reach. */
  unreachableGoal?: boolean;
  /** Move unit 1's start and goal (fractions of the map), e.g. to make the route diagonal. */
  ends?: { start: [number, number]; goal: [number, number] };
  /** Turn unit 1's goal to face back toward the start (vehicles). */
  goalFacesBack?: boolean;
  /** Paint walls after the first plan, then replan (to show local rebuilds). Fractions of the map. */
  edit?: { x0: number; y0: number; x1: number; y1: number };
  /** Start playback from the beginning. */
  play?: boolean;
}

export interface Try {
  label: string;
  scenario: Scenario;
}

export interface Concept {
  id: string;
  group: string;
  title: string;
  body: string[];
  /** What to look at once a scenario is loaded. */
  look?: string;
  tries: Try[];
}

export interface Term {
  term: string;
  /** Phrases that link to this entry in running text (lower case). */
  aliases: string[];
  def: string;
  /** A concept card that goes further. */
  concept?: string;
}

export const GLOSSARY: Record<string, Term> = {
  heuristic: {
    term: 'Heuristic (h)',
    aliases: ['heuristic', 'heuristics', 'a guess of the distance', 'guess of the distance'],
    def: 'An estimate of the cost still to go from a node to the goal. It steers A* toward the goal: a good one makes it look at far fewer nodes, one that is too low makes it flood like Dijkstra, one that is too high makes it stop being optimal.',
    concept: 'heuristics',
  },
  gcost: {
    term: 'g, h and f',
    aliases: ['f = g + h', 'f = g + w·h', 'g + h', 'distance walked so far', 'cost so far'],
    def: 'g is the cost of the best route found so far from the start to a node; h is the guess of the cost left; f = g + h is the estimated cost of a whole route through the node. A* always expands the lowest f next. Hover a node on the map to see its numbers.',
    concept: 'astar',
  },
  admissible: {
    term: 'Admissible',
    aliases: ['admissible', 'never overestimates', 'overestimates'],
    def: 'A heuristic that never overestimates the true remaining cost. With an admissible heuristic A* returns an optimal path. Octile is admissible on 8-way grids; Manhattan is not, because it charges 2 for a diagonal that costs 1.41.',
    concept: 'heuristics',
  },
  consistent: {
    term: 'Consistent (monotone)',
    aliases: ['consistent', 'inconsistent'],
    def: 'h(a) ≤ cost(a, b) + h(b) for every edge. A consistent heuristic means each node is expanded at most once and is always admissible. Weighted heuristics are inconsistent, which is why a node can be re-opened.',
    concept: 'heuristics',
  },
  octile: {
    term: 'Octile distance',
    aliases: ['octile'],
    def: 'max(dx, dy) + (√2 − 1)·min(dx, dy): the exact distance on an empty 8-way grid. The right heuristic for grids that allow diagonal moves.',
    concept: 'heuristics',
  },
  openlist: {
    term: 'Open and closed lists',
    aliases: ['open list', 'closed list', 'frontier', 'the open list', 'queued'],
    def: 'The open list is the frontier: nodes found but not yet expanded, kept in a priority queue ordered by f. The closed list is the set of nodes already expanded. Teal is open, the darker tint is closed.',
    concept: 'astar',
  },
  expanded: {
    term: 'Expanded',
    aliases: ['expands', 'expanded', 'expansion', 'expansions'],
    def: 'Taking a node off the open list and looking at its neighbours. "Expanded" in the stats is the main measure of how much work a search did.',
    concept: 'astar',
  },
  optimal: {
    term: 'Optimal',
    aliases: ['optimal', 'optimality'],
    def: 'Guaranteed to return the cheapest path (for the graph it searches). A* with an admissible heuristic is; Weighted A*, greedy search, HPA* and RRT are not.',
  },
  complete: {
    term: 'Complete',
    aliases: ['resolution-complete', 'probabilistically complete', 'complete'],
    def: "Always finds a path if one exists. Grid searches are resolution-complete: complete at the grid's resolution, blind to gaps narrower than a cell. Sampling planners are only probabilistically complete: the chance of finding a path tends to 1 as they sample forever, and they can never prove there is none.",
    concept: 'sampling',
  },
  tiebreak: {
    term: 'Tie-breaking',
    aliases: ['tie-breaking', 'ties', 'plateau', 'plateaus', 'tie'],
    def: 'On open ground many nodes share the same f. Unless ties are broken (toward the larger g, nearer the goal), A* expands whole fields of equal-cost nodes. The grid searches here break ties toward larger g.',
    concept: 'ties',
  },
  weighted: {
    term: 'Weighted A*',
    aliases: ['weighted a*'],
    def: 'A* with f = g + w·h, w > 1. It trusts the heuristic more, so it heads for the goal harder and expands far fewer nodes; the path is at most w times the optimal cost.',
    concept: 'weighted',
  },
  dijkstra: {
    term: "Dijkstra's algorithm",
    aliases: ['dijkstra'],
    def: 'A* with h = 0: expands strictly by cost so far, evenly in every direction. Wasteful for one start and one goal, ideal when you want distances to everywhere (flow fields, nearest cover).',
    concept: 'astar',
  },
  jps: {
    term: 'Jump Point Search',
    aliases: ['jump point search', 'jps', 'jump points', 'symmetric paths'],
    def: 'An A* that skips the many equivalent orderings of the same moves on a uniform-cost grid, queuing only cells where a path might have to turn. Optimal and much faster, but only when every open cell costs the same.',
    concept: 'jps',
  },
  anyangle: {
    term: 'Any-angle path',
    aliases: ['any-angle', 'any angle', 'line of sight', 'line-of-sight'],
    def: "A path whose segments aren't limited to the grid's 8 directions. Theta* gets one by letting a node skip to its predecessor's parent whenever it can see it; smoothing gets one afterwards by shortcutting.",
    concept: 'anyangle',
  },
  clearance: {
    term: 'Clearance',
    aliases: ['clearance', 'clearance map', 'distance field'],
    def: 'Per cell, the chessboard distance to the nearest wall or map edge. A (2k−1)×(2k−1) unit can stand where clearance is at least k, so one clearance map serves every unit size; turn on "Clearance numbers" to see it.',
    concept: 'clearance',
  },
  cspace: {
    term: 'Configuration space',
    aliases: ['configuration space', 'c-space', 'inflate', 'inflated', 'minkowski'],
    def: "The space of every pose a unit can be in: (x, y) for someone on foot, (x, y, heading) for a car. Planning happens here: grow obstacles by the unit's size (inflation) and the unit can be planned as a point.",
    concept: 'clearance',
  },
  reachability: {
    term: 'Reachability check',
    aliases: ['reachability', 'reachable areas', 'connected components', 'unreachable'],
    def: 'Label the connected areas once per unit size; "can I get there?" becomes a single lookup. Without it, an unreachable goal is A*\'s worst case: it explores everything it can reach before giving up.',
    concept: 'reachability',
  },
  hpa: {
    term: 'HPA*',
    aliases: ['hpa*', 'hierarchical', 'hierarchy', 'abstract'],
    def: 'Hierarchical Pathfinding A*: cut the map into tiles, put doors where a unit can cross a tile border, cache the routes between doors inside each tile, and search the small door graph instead of cells.',
    concept: 'hierarchy',
  },
  door: {
    term: 'Door (entrance, portal)',
    aliases: ['door', 'doors', 'entrance', 'entrances'],
    def: 'A crossing point between two tiles in HPA*. The door graph, and the cached routes between doors in each tile, are what HPA* reuses across queries.',
    concept: 'hierarchy',
  },
  portal: {
    term: 'Portal',
    aliases: ['portal', 'portals'],
    def: 'The shared edge between two navmesh polygons. A path crosses polygons through their portals; the funnel algorithm pulls it tight through them.',
    concept: 'navmesh',
  },
  navmesh: {
    term: 'Navmesh',
    aliases: ['navmesh', 'navigation mesh', 'polygons', 'polygon'],
    def: 'The walkable floor as convex polygons. Inside one polygon any straight move is valid, so a few polygons cover a whole room. Built per unit radius.',
    concept: 'navmesh',
  },
  funnel: {
    term: 'Funnel algorithm',
    aliases: ['funnel', 'string pulling', 'string-pulling', 'pulls the route tight', 'pull the path tight'],
    def: 'Pulls a path tight through the portals it crosses, like a string, leaving only the corners where it must turn. Turns a polygon corridor into the shortest path through it.',
    concept: 'navmesh',
  },
  area: {
    term: 'Area cost',
    aliases: ['area types', 'area type', 'area costs', 'cost filter'],
    def: 'Each navmesh polygon carries an area type (road, mud…), and each query prices areas with its own filter. One mesh, many cost profiles.',
    concept: 'navmesh',
  },
  dirty: {
    term: 'Dirtying and tile versions',
    aliases: ['dirty', 'dirtying', 'rebuild', 'rebuilds', 'rebuilt', 'invalidated'],
    def: "When the world changes, only the tiles it touched are rebuilt and their version bumped. Caches built on older versions are checked lazily, so one explosion doesn't throw away everything.",
    concept: 'dirty',
  },
  lazy: {
    term: 'Lazy caching',
    aliases: ['lazy caching', 'lazily', 'build on first use', 'cached', 'cache', 'caches'],
    def: "Build a cached piece (a tile's routes, a roadmap edge check) the first time something needs it, then keep it. The first query pays; later ones reuse.",
    concept: 'caching',
  },
  roadmap: {
    term: 'Roadmap (PRM)',
    aliases: ['roadmap', 'prm', 'probabilistic roadmap', 'multi-query'],
    def: 'A sparse graph of sampled free points joined to their visible neighbours. Built once and reused for every query: the sampling cousin of a navmesh.',
    concept: 'sampling',
  },
  rrt: {
    term: 'RRT',
    aliases: ['rrt', 'rapidly-exploring random tree', 'single-query'],
    def: 'Rapidly-exploring Random Tree: grows a tree from one start toward random points until it reaches the goal. Fast for one query in a big space, and useless for any other start or goal.',
    concept: 'single-multi',
  },
  narrow: {
    term: 'Narrow-passage problem',
    aliases: ['narrow passage', 'narrow passages', 'narrow-passage'],
    def: 'A door or tunnel mouth is a tiny fraction of the space, so random samples rarely land in it. Sampling planners fail or slow down exactly where maps get interesting.',
    concept: 'sampling',
  },
  holonomic: {
    term: 'Holonomic',
    aliases: ['holonomic'],
    def: 'Can move in any direction at any moment (people, hover drones). Its state is just (x, y).',
    concept: 'holonomic',
  },
  nonholonomic: {
    term: 'Non-holonomic',
    aliases: ['non-holonomic', 'turning radius', 'turning circle', 'full lock'],
    def: "Can't move sideways: a car or truck must turn along a circle no tighter than its turning radius. Its state is (x, y, heading), and a path someone on foot can walk may be undrivable.",
    concept: 'holonomic',
  },
  dubins: {
    term: 'Dubins and Reeds–Shepp curves',
    aliases: ['reeds–shepp', 'reeds-shepp', 'dubins'],
    def: 'The shortest path between two car poses ignoring obstacles: arcs at full lock and straights. Dubins drives forward only; Reeds–Shepp may reverse, with at most two gear changes.',
    concept: 'curves',
  },
  primitive: {
    term: 'Motion primitive',
    aliases: ['motion primitive', 'motion primitives', 'primitives', 'primitive'],
    def: 'A short, drivable manoeuvre (an arc, a straight, a reverse arc) used as an edge in a vehicle search. Hybrid A* drives them on the fly; a state lattice precomputes them.',
    concept: 'lattice',
  },
  analytic: {
    term: 'Analytic expansion',
    aliases: ['analytic expansion', 'analytic shot', 'shot'],
    def: "Hybrid A*'s shortcut: every so often, try one Reeds–Shepp (or Dubins) curve straight to the goal; if the footprint stays clear along it, the search is done.",
    concept: 'hybrid',
  },
  lattice: {
    term: 'State lattice',
    aliases: ['state lattice', 'lattice'],
    def: 'A regular graph of discrete poses joined by precomputed motion primitives. Edges and the cells each one sweeps are cached per vehicle, so search is plain A* with table-lookup collision checks.',
    concept: 'lattice',
  },
  hybridastar: {
    term: 'Hybrid A*',
    aliases: ['hybrid a*'],
    def: 'A* over (cell, heading) bins in which each node keeps the exact continuous pose it was reached with, and children come from driving short arcs. Every path it returns is drivable.',
    concept: 'hybrid',
  },
  cusp: {
    term: 'Gear change (cusp)',
    aliases: ['gear change', 'gear changes', 'cusp', 'cusps', 'reversing', 'reverse'],
    def: 'A point where a vehicle switches between forward and reverse. Planners add a penalty for each one so paths look like a person drove them.',
    concept: 'curves',
  },
  footprint: {
    term: 'Footprint',
    aliases: ['footprint'],
    def: "The vehicle's real outline, checked against walls at every pose along a motion, rather than treating the vehicle as a circle.",
    concept: 'holonomic',
  },
  budget: {
    term: 'Search budget',
    aliases: ['expansion limit', 'budget', 'time slicing', 'time-slicing'],
    def: 'A cap on how much work a search may do (expansions, or time spread over several frames). Cap by expansions, not milliseconds, so every machine produces the same paths.',
    concept: 'determinism',
  },
  smoothing: {
    term: 'Smoothing (shortcutting)',
    aliases: ['smoothing', 'shortcut', 'shortcutting', 'raw path'],
    def: 'Removing unnecessary turns after the search, by skipping any waypoints the unit can see past. Always re-check collisions when you do it.',
    concept: 'anyangle',
  },
};

const NAV = 'Representations';
const SEARCH = 'Search';
const SPEED = 'Speed-ups and caching';
const CHANGE = 'Changing worlds';
const SAMPLING = 'Sampling planners';
const VEHICLES = 'Vehicles';
const PRACTICE = 'In practice';

export const CONCEPTS: Concept[] = [
  {
    id: 'astar',
    group: SEARCH,
    title: 'A*: g, h and f',
    body: [
      'Every search here keeps an open list (the frontier) and repeatedly expands the most promising node. A* ranks nodes by f = g + h: the cost walked so far plus a guess of the distance left. Dijkstra is A* with h = 0, so it spreads evenly in every direction; A* bends that circle toward the goal.',
      'The guess is the whole difference. With a perfect heuristic A* would only expand nodes on the optimal path; with h = 0 it is Dijkstra. Everything in between trades how much of the map you touch against how much you know about it in advance.',
      'Hover any node on the map to see its g, h and f at the current step, and step through playback with ← and →: the node being expanded always has the lowest f on the open list.',
    ],
    look: "Dijkstra fills a circle; A* fills a wedge toward the goal. Hover cells along the edge of each: Dijkstra's all share one g, A*'s all share one f.",
    tries: [
      {
        label: 'A* vs Dijkstra',
        scenario: {
          preset: 'storyboard',
          useTerrain: false,
          lanes: [
            { rep: 'grid', alg: 'astar', heuristic: 'octile' },
            { rep: 'grid', alg: 'dijkstra' },
          ],
          play: true,
        },
      },
    ],
  },
  {
    id: 'heuristics',
    group: SEARCH,
    title: 'Heuristics: admissible, consistent, and weak',
    body: [
      'A heuristic is admissible if it never overestimates the remaining cost; A* is then guaranteed optimal. It is consistent if it never drops by more than an edge costs, which also means no node is expanded twice. Octile distance is both on an 8-way grid. Manhattan is neither once diagonals are allowed, because it charges 2 for a step that costs √2: the search gets faster and greedier, and the path can come out longer.',
      'Terrain makes this subtle. If a road costs 0.5 per cell, an admissible heuristic must assume road everywhere, so on grass it underestimates by half and A* floods. Landmarks (ALT) or a hierarchical heuristic fix this on large maps; Weighted A* hides it at the cost of optimality.',
    ],
    look: "Compare the cost and the expansions in the two lanes. Hover the same cell in both: Manhattan's h is larger.",
    tries: [
      {
        label: 'Octile vs Manhattan',
        scenario: {
          preset: 'scatter',
          size: 'large',
          diagonal: 'noCorner',
          useTerrain: false,
          lanes: [
            { rep: 'grid', alg: 'astar', heuristic: 'octile' },
            { rep: 'grid', alg: 'astar', heuristic: 'manhattan' },
          ],
        },
      },
      {
        label: 'Cheap roads weaken it',
        scenario: {
          preset: 'country',
          size: 'huge',
          useTerrain: true,
          lanes: [
            { rep: 'grid', alg: 'astar', heuristic: 'octile' },
            { rep: 'grid', alg: 'weighted', heuristic: 'octile', weight: 2 },
          ],
        },
      },
    ],
  },
  {
    id: 'ties',
    group: SEARCH,
    title: 'Ties and plateaus',
    body: [
      'On open ground, many routes cost exactly the same, so many nodes share one f. A* is free to expand them in any order, and if it picks badly it explores the whole plateau before finishing. Breaking ties toward the larger g (the node further along) removes most of this; the grid searches here do that.',
      'Hierarchical searches hit a version of the same problem: a straight line rarely crosses a tile border exactly at a door, so many door routes tie. A door-level heuristic weight just above 1 breaks those ties for a fraction of a percent of path length.',
    ],
    look: 'With door weight 1.00, HPA* expands several times more doors for almost the same path.',
    tries: [
      {
        label: 'HPA* door weight 1.00 vs 1.05',
        scenario: {
          preset: 'empty',
          size: 'xl',
          useTerrain: false,
          // A diagonal route: on a straight row the door routes don't tie and both lanes match.
          ends: { start: [0.05, 0.08], goal: [0.95, 0.92] },
          lanes: [
            { rep: 'hpa', cluster: 16, lazy: false, hpaWeight: 1 },
            { rep: 'hpa', cluster: 16, lazy: false, hpaWeight: 1.05 },
          ],
        },
      },
    ],
  },
  {
    id: 'weighted',
    group: SEARCH,
    title: 'Trading quality for speed',
    body: [
      'Weighted A* uses f = g + w·h with w > 1. It trusts the heuristic more, so it heads for the goal harder and often expands 2 to 10 times fewer nodes; in return its path may cost up to w times the optimum. On big maps where near-optimal is fine, this is the cheapest speed-up there is.',
      'Greedy best-first goes all the way: f = h, ignoring the cost walked. It is very fast on open maps and falls into every U-shaped trap, because walking into the trap always looks like progress.',
    ],
    look: 'On the U-wall, greedy walks into the cup and has to back out; A* sees the cost of doing that.',
    tries: [
      {
        label: 'Greedy in a U-trap',
        scenario: {
          preset: 'ushape',
          size: 'medium',
          useTerrain: false,
          lanes: [
            { rep: 'grid', alg: 'astar', heuristic: 'octile' },
            { rep: 'grid', alg: 'greedy', heuristic: 'octile' },
          ],
          play: true,
        },
      },
      {
        label: 'Weighted A* on a big town',
        scenario: {
          preset: 'city',
          size: 'xl',
          useTerrain: false,
          lanes: [
            { rep: 'grid', alg: 'astar', heuristic: 'octile' },
            { rep: 'grid', alg: 'weighted', heuristic: 'octile', weight: 2 },
          ],
        },
      },
    ],
  },
  {
    id: 'jps',
    group: SPEED,
    title: 'Pruning: Jump Point Search',
    body: [
      'On a uniform-cost grid, there are many equally short orderings of the same moves (right-right-down, right-down-right…). A* wastes most of its time on them. Jump Point Search prunes the symmetric ones: it scans in straight lines and only queues a cell where a wall forces the path to turn.',
      'The result is optimal and often an order of magnitude faster, with a tiny open list. The catch is the assumption it rests on: every open cell must cost the same. Paint a single cell of terrain and the pruning is no longer valid.',
    ],
    look: 'The yellow scanned cells were looked at but never queued; compare the open list sizes. Then turn on terrain costs in the sidebar.',
    tries: [
      {
        label: 'JPS vs A*',
        scenario: {
          preset: 'scatter',
          size: 'large',
          diagonal: 'noCorner',
          useTerrain: false,
          lanes: [
            { rep: 'grid', alg: 'astar', heuristic: 'octile' },
            { rep: 'grid', alg: 'jps', heuristic: 'octile' },
          ],
        },
      },
    ],
  },
  {
    id: 'anyangle',
    group: SEARCH,
    title: 'Any-angle paths and smoothing',
    body: [
      'Grid paths zig-zag because the grid allows only 8 directions. Two fixes: smooth afterwards (skip any waypoint the unit can see past, then re-check), or search with any-angle moves directly. Theta* lets a node take its predecessor’s parent as its own whenever it can see it, so parent links stretch across open space and paths come out as a few long segments; Lazy Theta* defers the line-of-sight checks until a node is expanded and does far fewer of them.',
      'Neither is truly shortest (that needs a visibility graph; a navmesh plus funnel is taut, but its corridor is picked with approximate costs, so it is only close too), but both are very close.',
    ],
    look: 'Turn on "Search tree" in the sidebar: Theta*\'s parent links stretch across open space.',
    tries: [
      {
        label: 'Theta* vs A* + smoothing',
        scenario: {
          preset: 'rooms',
          size: 'medium',
          useTerrain: false,
          overlays: { tree: true },
          lanes: [
            {
              rep: 'grid',
              alg: 'astar',
              heuristic: 'octile',
              smoothing: 'shortcut',
            },
            { rep: 'grid', alg: 'theta', heuristic: 'euclidean' },
          ],
        },
      },
    ],
  },
  {
    id: 'clearance',
    group: NAV,
    title: 'Clearance: one map for every unit size',
    body: [
      'A unit is not a point. Rather than a separate graph per size, measure once how much room each cell has (its clearance: how many chessboard steps it is to the nearest wall or map edge). A cell with clearance k has a clear (2k−1)×(2k−1) square centred on it, so a 1×1 unit needs 1, a 3×3 unit needs 2, and so on: same map, different threshold.',
      'This is planning in configuration space: grow the obstacles by the unit (inflation) and the unit becomes a point again. Navmeshes do the same thing at build time, which is why they need one mesh per unit radius.',
    ],
    look: 'With a 3×3 unit the one-cell doors close, so the "reachable areas" overlay splits the rooms into islands and the reachability check answers "no" without searching. Set the footprint back to 1×1 and the rooms join up again.',
    tries: [
      {
        label: 'A 3×3 unit in rooms',
        scenario: {
          preset: 'rooms',
          size: 'large',
          need: 2,
          overlays: { clearance: true, components: true },
          lanes: [{ rep: 'grid', alg: 'astar', heuristic: 'octile' }],
        },
      },
    ],
  },
  {
    id: 'reachability',
    group: SPEED,
    title: 'Reachability before search',
    body: [
      'An unreachable goal is A*\'s worst case: it must expand everything it can reach before it can say no. Label the connected areas once per unit size (a flood fill, updated when the map changes) and "can I get there?" becomes one lookup. If the answer is no, send the unit to the nearest reachable point instead.',
      'This also answers the question of what to do when A* fails on a complete map: the goal really is unreachable, and a second search (RRT, say) only spends time proving it again.',
    ],
    look: 'With the check off, A* floods every reachable cell. Tick "Check reachability first" in the sidebar and it answers instantly.',
    tries: [
      {
        label: 'Unreachable goal, check off',
        scenario: {
          preset: 'rooms',
          size: 'large',
          need: 2,
          reachCheck: false,
          unreachableGoal: true,
          overlays: { components: true },
          lanes: [{ rep: 'grid', alg: 'astar', heuristic: 'octile' }],
          play: true,
        },
      },
    ],
  },
  {
    id: 'hierarchy',
    group: SPEED,
    title: 'Hierarchy: plan on the highways',
    body: [
      "On big maps the win comes from searching less of the world, not from a faster inner loop. HPA* cuts the map into tiles and places doors wherever a unit can cross a tile border. Inside each tile it caches the cost of walking between every pair of doors. A query connects start and goal to their tiles' doors, runs A* on the small door graph, and fills in each hop from the cache.",
      'Paths come out a few percent longer than optimal (smoothing recovers most of it), and the search touches doors, not cells: often ten to thirty times fewer nodes on a big map.',
    ],
    look: 'Compare "Expanded": cells for A*, doors for HPA*. Then try terrain costs on.',
    tries: [
      {
        label: 'A* vs HPA* on a big town',
        scenario: {
          preset: 'city',
          size: 'xl',
          useTerrain: false,
          lanes: [
            { rep: 'grid', alg: 'astar', heuristic: 'octile' },
            { rep: 'hpa', cluster: 16, lazy: true, hpaWeight: 1.05 },
          ],
        },
      },
    ],
  },
  {
    id: 'caching',
    group: SPEED,
    title: 'What is worth caching',
    body: [
      "Cache the parts that don't depend on the goal. Tile-crossing routes, door graphs, navmeshes and roadmaps are useful to every unit; a whole path is only useful to someone going exactly the same way. Per-goal structures (flow fields, heuristic fields) only pay off when many units share a goal.",
      'Several units planning in turn show the difference: a grid search shares nothing, lazy HPA* builds fewer tiles for each later unit, and a navmesh or roadmap is built once before the first.',
    ],
    look: 'The per-unit table under each lane says what each unit reused or built. Tiles are tinted by the unit that built them.',
    tries: [
      {
        label: 'Five units: grid vs lazy HPA*',
        scenario: {
          preset: 'city',
          size: 'huge',
          useTerrain: false,
          units: 4,
          lanes: [
            { rep: 'grid', alg: 'astar', heuristic: 'octile' },
            { rep: 'hpa', cluster: 16, lazy: true, hpaWeight: 1.05 },
          ],
        },
      },
    ],
  },
  {
    id: 'navmesh',
    group: NAV,
    title: 'Navmeshes, portals and the funnel',
    body: [
      'A navmesh describes the walkable floor as convex polygons; inside one polygon any straight move is valid, so a few polygons cover a room that would be hundreds of cells. Search runs over polygons, crossing their shared edges (portals), and the funnel algorithm then pulls the route tight through those portals, leaving only the corners it must turn.',
      'Terrain becomes area types: each polygon carries one, and each query prices areas with its own cost filter, so one mesh serves several cost profiles. The price is build cost and one mesh per unit radius.',
    ],
    look: 'How few polygons the search touches, and how the final path hugs corners.',
    tries: [
      {
        label: 'Navmesh vs grid',
        scenario: {
          preset: 'rooms',
          size: 'large',
          useTerrain: true,
          lanes: [
            { rep: 'grid', alg: 'astar', heuristic: 'octile' },
            { rep: 'navmesh', showDetour: true },
          ],
        },
      },
    ],
  },
  {
    id: 'dirty',
    group: CHANGE,
    title: 'Changing worlds: dirtying and local rebuilds',
    body: [
      'Split change in two. Things that alter the map (destruction, construction, doors) go into the representation; things that move (units) go into local avoidance. Putting moving units into the shared graph invalidates it constantly and nothing ever stays cached.',
      'For map changes, tile everything. A change rebuilds only the tiles it touched and bumps their version; cached routes remember the versions they were built on and are re-checked lazily. This scenario paints a wall across the map after the first plan.',
    ],
    look: 'Red tiles were rebuilt by the edit; everything else kept its cache. The Build row says how long it took.',
    tries: [
      {
        label: 'Paint a wall: HPA* and navmesh',
        scenario: {
          preset: 'city',
          size: 'xl',
          useTerrain: false,
          edit: { x0: 0.45, y0: 0.2, x1: 0.47, y1: 0.8 },
          lanes: [
            { rep: 'hpa', cluster: 16, lazy: false, hpaWeight: 1.05 },
            { rep: 'navmesh', showDetour: false },
          ],
        },
      },
    ],
  },
  {
    id: 'sampling',
    group: SAMPLING,
    title: 'Sampling planners and narrow passages',
    body: [
      'Sampling planners avoid building a grid: they try random poses and keep the free ones. PRM scatters samples and joins neighbours into a reusable roadmap; RRT grows a tree from one start. They win in huge or many-dimensional spaces (robot arms, aircraft) where any grid would be astronomically large.',
      'In 2D ground navigation they mostly lose. A doorway is a tiny fraction of the space, so samples rarely land in it, and a sampler can\'t tell "impossible" from "not lucky yet". Placing nodes on purpose, where paths actually turn (wall corners), avoids the problem entirely.',
    ],
    look: 'PRM misses one-cell doors at 1,000 samples; the feature roadmap never does.',
    tries: [
      {
        label: 'PRM vs feature roadmap',
        scenario: {
          preset: 'rooms',
          size: 'large',
          useTerrain: false,
          lanes: [
            { rep: 'roadmap', rmMethod: 'prm', rmSamples: 1000 },
            { rep: 'roadmap', rmMethod: 'feature', rmSpacing: 8 },
          ],
        },
      },
    ],
  },
  {
    id: 'single-multi',
    group: SAMPLING,
    title: 'Single-query vs multi-query',
    body: [
      "An RRT is built for one start and one goal: rooted at the start, biased toward the goal, thrown away afterwards. Keeping trees and merging them into one shared graph (the original idea behind this lab) does reuse work, but the graph's density follows past queries rather than the map, paths detour along old branches, and nothing guarantees their cost.",
      'If you want sampling and reuse, PRM is the multi-query version: one roadmap for every query. For ground units, a tiled grid or navmesh is usually the better fit.',
    ],
    look: 'With five units, RRT grows five trees from scratch; the shared graph grows for the first unit or two and then gets cache hits.',
    tries: [
      {
        label: 'RRT vs shared RRT graph',
        scenario: {
          preset: 'caves',
          size: 'large',
          useTerrain: false,
          units: 4,
          lanes: [
            { rep: 'roadmap', rmMethod: 'rrt', rmIterations: 5000, rmStep: 3 },
            {
              rep: 'roadmap',
              rmMethod: 'shared',
              rmIterations: 5000,
              rmStep: 3,
            },
          ],
        },
      },
    ],
  },
  {
    id: 'holonomic',
    group: VEHICLES,
    title: 'Holonomic and non-holonomic units',
    body: [
      'Someone on foot can step in any direction at any moment: holonomic, state (x, y). A car can only move along its heading and turn no tighter than its turning radius: non-holonomic, state (x, y, heading). A path someone on foot can walk may be impossible to drive, and a vehicle given one stalls at the first sharp corner.',
      "Plan coarsely with everyone else, then refine per vehicle class inside a corridor, against the vehicle's real footprint rather than a circle. A gap can be wide enough to pass but not to turn in.",
    ],
    look: 'The car swings wide at corners, and backs up (dashed) when the goal faces the wrong way.',
    tries: [
      {
        label: 'On foot vs car',
        scenario: {
          preset: 'city',
          size: 'large',
          useTerrain: false,
          lanes: [
            {
              rep: 'grid',
              alg: 'astar',
              heuristic: 'octile',
              smoothing: 'shortcut',
            },
            { rep: 'vehicle', vAlg: 'hybrid', vVehicle: 'car', vReverse: true },
          ],
        },
      },
    ],
  },
  {
    id: 'curves',
    group: VEHICLES,
    title: 'Dubins and Reeds–Shepp curves',
    body: [
      'Ignoring obstacles, the shortest drive between two car poses is made of arcs at full lock and straight lines. Dubins (1957) proved that forward-only, it is one of six words (LSL, RSR, LSR, RSL, RLR, LRL). Reeds and Shepp (1990) allowed reverse: one of 48 words of up to five pieces, with at most two gear changes.',
      "They matter twice over: as a heuristic (a lower bound on how far the car must drive, which knows about turning) and as Hybrid A*'s analytic expansion (try to drive straight to the goal).",
    ],
    look: 'With the goal facing back toward the start, forward-only has to drive a loop; with reverse it can back in.',
    tries: [
      {
        label: 'Reverse vs forward only',
        scenario: {
          preset: 'empty',
          size: 'medium',
          useTerrain: false,
          goalFacesBack: true,
          lanes: [
            { rep: 'vehicle', vAlg: 'hybrid', vVehicle: 'car', vReverse: true },
            {
              rep: 'vehicle',
              vAlg: 'hybrid',
              vVehicle: 'car',
              vReverse: false,
            },
          ],
        },
      },
    ],
  },
  {
    id: 'hybrid',
    group: VEHICLES,
    title: 'Hybrid A* and analytic expansion',
    body: [
      'Hybrid A* searches (cell, heading) bins, but each node keeps the exact continuous pose it was reached with, and children come from driving short arcs at a few steering angles, forwards and in reverse. The bins only stop the search exploding; the path is made of the arcs, so it is drivable.',
      'Its heuristic is the larger of two lower bounds: the cost ignoring turning (a Dijkstra field that knows about walls and dead ends, the faint purple bands) and the Reeds–Shepp length ignoring walls (which knows about turning). Every few expansions it tries a Reeds–Shepp curve straight to the goal; on open ground that analytic shot often finishes the search almost at once.',
    ],
    look: 'With the analytic shot off, the search has to land on the goal cell and heading by itself, and the expansions climb.',
    tries: [
      {
        label: 'Analytic shot on vs off',
        scenario: {
          preset: 'country',
          size: 'huge',
          useTerrain: true,
          lanes: [
            { rep: 'vehicle', vAlg: 'hybrid', vVehicle: 'car', vShots: true },
            { rep: 'vehicle', vAlg: 'hybrid', vVehicle: 'car', vShots: false },
          ],
        },
      },
    ],
  },
  {
    id: 'lattice',
    group: VEHICLES,
    title: 'State lattices: motion computed in advance',
    body: [
      'A state lattice fixes the poses in advance (cell centres with 16 headings) and connects them with precomputed motion primitives: a straight step and the tightest clean turns to nearby headings, all ending exactly on the lattice. Each primitive also stores every cell the vehicle sweeps along it.',
      'Search is then plain A*, with collision checks as table lookups, and the table is built once per vehicle and shared by every unit: deterministic, cache-friendly and fast. The price is resolution: 16 headings, so start and goal headings snap.',
    ],
    look: 'The purple fan at each start is the whole menu of moves. The per-unit table shows the primitives built once and reused.',
    tries: [
      {
        label: 'Lattice vs Hybrid A*, four cars',
        scenario: {
          preset: 'city',
          size: 'large',
          useTerrain: false,
          units: 3,
          lanes: [
            { rep: 'vehicle', vAlg: 'lattice', vVehicle: 'car' },
            { rep: 'vehicle', vAlg: 'hybrid', vVehicle: 'car' },
          ],
        },
      },
    ],
  },
  {
    id: 'determinism',
    group: PRACTICE,
    title: 'Budgets, time slicing and determinism',
    body: [
      'Searches need a budget. Cap them by expansions rather than milliseconds, so the same inputs give the same path on every machine: wall-clock time should only decide when an answer arrives, never which answer it is. Spread a long search over several frames (time slicing), and apply results at a fixed tick in unit-id order.',
      'For vehicles, plan in legs: a coarse route first, then a short drivable leg the unit can start on while the next leg is planned behind it. Units that hit their budget should head for the explored node closest to the goal and replan, rather than stand still.',
    ],
    look: 'Lower the expansion limit on a vehicle lane and watch where it gives up.',
    tries: [
      {
        label: 'A tight expansion budget',
        scenario: {
          preset: 'city',
          size: 'huge',
          useTerrain: false,
          lanes: [
            { rep: 'vehicle', vAlg: 'hybrid', vVehicle: 'truck', vLimit: 5000 },
            {
              rep: 'vehicle',
              vAlg: 'hybrid',
              vVehicle: 'truck',
              vLimit: 50000,
            },
          ],
        },
      },
    ],
  },
];

export function conceptById(id: string): Concept | undefined {
  return CONCEPTS.find((c) => c.id === id);
}

/** Concept cards relevant to a lane's current setup, for the links under its explanation. */
export function conceptsFor(rep: string, alg: string, method: string, vAlg: string): string[] {
  if (rep === 'grid') {
    const byAlg: Record<string, string[]> = {
      astar: ['astar', 'heuristics', 'ties'],
      dijkstra: ['astar'],
      weighted: ['weighted', 'heuristics'],
      greedy: ['weighted'],
      bfs: ['astar'],
      jps: ['jps'],
      theta: ['anyangle'],
      lazytheta: ['anyangle'],
    };
    return [...(byAlg[alg] ?? ['astar']), 'clearance', 'reachability'];
  }
  if (rep === 'hpa') return ['hierarchy', 'caching', 'ties', 'dirty'];
  if (rep === 'navmesh') return ['navmesh', 'dirty', 'caching'];
  if (rep === 'roadmap')
    return method === 'rrt' || method === 'rrtconnect' || method === 'rrtstar' || method === 'shared' ? ['sampling', 'single-multi'] : ['sampling', 'caching'];
  if (rep === 'vehicle')
    return vAlg === 'lattice'
      ? ['lattice', 'holonomic', 'curves']
      : vAlg === 'rrt'
        ? ['curves', 'sampling', 'holonomic']
        : ['hybrid', 'curves', 'holonomic', 'determinism'];
  return [];
}
