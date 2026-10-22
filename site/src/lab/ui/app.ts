import { GridSpace } from '../graph/gridSpace';
import { planOnGrid } from '../rep/gridPlanner';
import type { Rect } from '../rep/hpaGraph';
import { HpaPlanner } from '../rep/hpaPlanner';
import { NavmeshPlanner } from '../rep/navmeshPlanner';
import { ROADMAP_METHODS, RoadmapPlanner, methodInfo, type RoadmapMethod } from '../rep/roadmapPlanner';
import { VEHICLE_ALGS, VehiclePlanner, vehicleAlgInfo, vehicleShape, type VehicleAlg, type VehicleLaneConfig } from '../rep/vehiclePlanner';
import { FootprintChecker, VEHICLES, distanceField } from '../vehicle/geometry';
import type { Plan, PlanContext, RepView, ViewRect } from '../rep/types';
import type { SmoothingId } from '../post/smooth';
import { HEURISTICS, type HeuristicId } from '../search/heuristics';
import { ALGORITHMS, REPRESENTATIONS, algorithmById } from '../search/registry';
import { EV_CLOSE, EV_OPEN, EV_SCAN, Recorder } from '../search/types';
import { computeClearance, computeComponents, type DiagonalRule } from '../world/clearance';
import { PRESETS, presetById } from '../world/presets';
import { TERRAINS, allUnits, deserializeWorld, nextVersion, serializeWorld, type Cell, type World } from '../world/world';
import { fmt, fmtTime, h, option } from './dom';
import { MAX_UNITS, MapImages, Palette, UNIT_COLORS, drawFrame, headingHandle, type Overlays, type UnitFrame } from './renderer';
import { mergePlans, randomUnit, type LanePlan } from './units';
import { Learn, linkTerms } from './learn';
import { clearUrlState, mountShareButton, stateInUrl, unpack } from './share';
import { conceptById, conceptsFor, type Concept, type Scenario, type Try } from '../learn/concepts';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

type Tool = 'wall' | 'erase' | `t${number}`;
type RepId = 'grid' | 'hpa' | 'navmesh' | 'roadmap' | 'vehicle';

/** Representations that keep a cache across queries (Grid keeps none). */
type CachedRep = 'hpa' | 'navmesh' | 'roadmap' | 'vehicle';
const CACHED_REPS: CachedRep[] = ['hpa', 'navmesh', 'roadmap', 'vehicle'];
const allPending = (): Record<CachedRep, Rect | 'none' | 'all'> => ({ hpa: 'all', navmesh: 'all', roadmap: 'all', vehicle: 'all' });

interface LaneConfig {
  rep: RepId;
  // Grid
  alg: string;
  heuristic: HeuristicId;
  weight: number;
  smoothing: SmoothingId;
  // HPA*
  cluster: number;
  lazy: boolean;
  hpaWeight: number;
  // Navmesh
  showDetour: boolean;
  // Roadmaps
  rmMethod: RoadmapMethod;
  rmSamples: number;
  rmIterations: number;
  rmStep: number;
  rmSpacing: number;
  rmSeed: number;
  // Vehicles
  vAlg: VehicleAlg;
  vVehicle: string;
  vRadius: number;
  vReverse: boolean;
  vAny: boolean;
  vBins: number;
  vShots: boolean;
  vLimit: number;
  vIterations: number;
  vSeed: number;
}

interface Settings {
  preset: string;
  size: string;
  seed: number;
  tool: Tool;
  brush: number;
  need: number;
  diagonal: DiagonalRule;
  useTerrain: boolean;
  reachCheck: boolean;
  overlays: Overlays;
  compare: boolean;
  lanes: [LaneConfig, LaneConfig];
  speed: number;
}

const SIZES: Record<string, [number, number]> = {
  small: [32, 20],
  medium: [48, 30],
  large: [80, 50],
  huge: [128, 80],
  xl: [256, 160],
  xxl: [512, 320],
  giant: [1024, 640],
};

const LANE_DEFAULT: LaneConfig = {
  rep: 'grid',
  alg: 'astar',
  heuristic: 'octile',
  weight: 2,
  smoothing: 'none',
  cluster: 16,
  lazy: true,
  hpaWeight: 1.05,
  showDetour: true,
  rmMethod: 'prm',
  rmSamples: 1000,
  rmIterations: 5000,
  rmStep: 3,
  rmSpacing: 8,
  rmSeed: 1,
  vAlg: 'hybrid',
  vVehicle: 'car',
  vRadius: 0,
  vReverse: true,
  vAny: false,
  vBins: 72,
  vShots: true,
  vLimit: 20000,
  vIterations: 3000,
  vSeed: 1,
};

const DEFAULTS: Settings = {
  preset: 'storyboard',
  size: 'medium',
  seed: 7,
  tool: 'wall',
  brush: 1,
  need: 1,
  diagonal: 'noCorner',
  useTerrain: true,
  reachCheck: true,
  overlays: {
    clearance: false,
    components: false,
    tree: false,
    rawPath: true,
    structure: true,
    inspect: true,
  },
  compare: false,
  lanes: [{ ...LANE_DEFAULT }, { ...LANE_DEFAULT, rep: 'hpa' }],
  speed: 45,
};

const STORE_KEY = 'pathfinding-lab/v1';
/** Above this many cells, painting updates the picture live but re-plans when the stroke ends. */
const LIVE_REPLAN_LIMIT = 60_000;

const REP_INFO: Record<
  Exclude<RepId, 'roadmap' | 'vehicle'>,
  {
    name: string;
    family: string;
    summary: string;
    chips: Array<[string, string]>;
    watch: string;
  }
> = {
  grid: { name: '', family: '', summary: '', chips: [], watch: '' },
  hpa: {
    name: 'HPA*',
    family: 'Hierarchical',
    summary:
      "The map is cut into tiles. Doors sit wherever a unit can cross a tile border, and each tile caches the route between every pair of its doors. A query connects start and goal to their tiles' doors, runs A* over the small door graph, then stitches the cached routes together.",
    chips: [
      ['Optimal', 'Near: ~6% longer on average before smoothing'],
      ['Complete', 'Yes'],
      ['Path', 'Grid steps via doors'],
    ],
    watch:
      'Expanded counts doors, not cells: compare with A* on a 512 × 320 map. In lazy mode, move the goal and watch the cached (teal) tiles grow; paint a wall and only the red tiles rebuild. Set the door weight to 1.00 on an open map to see the plateau: many door routes tie on cost and all get explored. A weight of 1.05 breaks the tie for paths about 0.3% longer.',
  },
  navmesh: {
    name: 'Navmesh (Recast)',
    family: 'Polygons',
    summary:
      "Recast turns the walkable floor into convex polygons, shrunk by the unit's radius, built tile by tile. Terrain is stamped on as area types, so polygons split along terrain borders and each carries a cost. A* runs over polygons (crossing shared edges called portals), then the funnel algorithm pulls the route tight through those portals.",
    chips: [
      ['Optimal', 'Close; the funnel path is taut'],
      ['Complete', 'Yes, at voxel resolution'],
      ['Path', 'Any-angle'],
    ],
    watch:
      "How few polygons cover open ground, how one search step crosses a whole room, and that painting rebuilds only the touched Recast tiles. Paint a road: it becomes its own polygons and the corridor bends toward it. Detour's own heuristic ignores cheap areas, so with roads its dotted path can differ. Each unit size needs its own navmesh.",
  },
};

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

interface Lane {
  index: number;
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  banner: HTMLElement;
  stats: HTMLElement;
  info: HTMLElement;
  head: HTMLElement;
  plan: LanePlan | null;
  closeAt: Int32Array;
  status: Uint8Array;
  parent: Int32Array;
  /** g and f of each node at the current playback step (NaN when the search records none). */
  g: Float32Array;
  f: Float32Array;
  /** The hover inspector's box, and the map point it describes. */
  tip: HTMLElement;
  hover: { x: number; y: number; px: number; py: number } | null;
  applied: number;
  current: number;
  /**
   * World edits not yet seen by each of this lane's cached planners. Tracked per
   * planner: edits made while another representation is shown must still reach
   * the HPA*, navmesh, roadmap or vehicle cache when it comes back.
   */
  pending: Record<CachedRep, Rect | 'none' | 'all'>;
  hpa: HpaPlanner | null;
  nav: NavmeshPlanner | null;
  roadmap: RoadmapPlanner | null;
  vehicle: VehiclePlanner | null;
}

interface Camera {
  cs: number;
  ox: number;
  oy: number;
  fitted: boolean;
  W: number;
  H: number;
}

const emptyView: RepView = { nodeCount: 0, drawStructure() {}, drawState() {} };

/** Number of switches between forward and reverse along a vehicle path. */
function gearChanges(poses: Float32Array): number {
  let n = 0;
  for (let k = 8; k < poses.length; k += 4) if (poses[k + 3] !== poses[k - 1]) n++;
  return n;
}

export class App {
  private s: Settings;
  private world!: World;
  private pal = new Palette();
  private images = new MapImages();
  private lanes: Lane[] = [];
  private clearance: Uint16Array = new Uint16Array(0);
  private clearanceVersion = -1;
  private components: Int32Array = new Int32Array(0);
  private componentsKey = '';
  private cam: Camera = { cs: 10, ox: 0, oy: 0, fitted: true, W: 600, H: 400 };
  private step = 0;
  private maxStep = 0;
  private playing = false;
  private lastTick = 0;
  private stepBudget = 0;
  private drawQueued = false;
  private computeQueued = false;
  private stroking = false;
  /** A start, goal or heading handle is being dragged. */
  private dragging = false;
  /** A replan was skipped during a stroke or drag; the shown plans are out of date until release. */
  private deferred = false;
  /** How long the last full replan took, to decide whether drags can replan live. */
  private lastComputeMs = 0;
  private side!: HTMLElement;
  private lanesEl!: HTMLElement;
  private scrub!: HTMLInputElement;
  private scrubLbl!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private speedLbl!: HTMLElement;
  /** Click-to-place a new unit: waiting for its start, then its goal. */
  private placing: { start: Cell | null } | null = null;
  private learn: Learn<Concept>;
  /** The concept whose "Try it" set up the current maps, shown above them. */
  private lesson: { concept: Concept; t: Try } | null = null;
  private lessonEl!: HTMLElement;

  constructor(private host: HTMLElement) {
    const saved = this.load();
    this.s = saved?.settings ?? structuredClone(DEFAULTS);
    this.world = saved?.world ?? this.buildPreset();
    this.learn = new Learn<Concept>((c, t) => this.applyScenario(c, t));
    this.render();
    window.addEventListener('resize', () => this.layoutCanvases());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.themeChanged());
    new MutationObserver(() => this.themeChanged()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.recompute();
    mountShareButton(() => ({ settings: this.s, world: serializeWorld(this.world) }));
    const shared = stateInUrl();
    if (shared) void this.openShared(shared);
    // Handle for automated checks and console poking (window.pathfindingLab).
    (window as unknown as { pathfindingLab: App }).pathfindingLab = this;
  }

  /** For tests: every lane's final path and whether any point of it lies inside a wall. */
  debugPaths(): Array<{
    status: string;
    points: number;
    inWall: number;
    units: Array<{
      status: string;
      points: number;
      inWall: number;
      note: string;
    }>;
  }> {
    const l = this.world.layers[0];
    const wallHits = (path: Array<{ x: number; y: number }>) => {
      let n = 0;
      for (const q of path) {
        const x = Math.floor(q.x);
        const y = Math.floor(q.y);
        if (x >= 0 && y >= 0 && x < l.w && y < l.h && l.blocked[y * l.w + x]) n++;
      }
      return n;
    };
    return this.lanes.map((lane) => {
      const units = (lane.plan?.units ?? []).map((u) => ({
        status: u.status,
        points: u.finalPath.length,
        inWall: wallHits(u.finalPath),
        note: u.note,
      }));
      return {
        status: units[0]?.status ?? 'none',
        points: units.reduce((n, u) => n + u.points, 0),
        inWall: units.reduce((n, u) => n + u.inWall, 0),
        units,
      };
    });
  }

  /** For tests and the console: add `n` random units (up to the limit). */
  addRandomUnits(n: number): void {
    this.ensureCaches();
    for (let i = 0; i < n && this.world.units.length < MAX_UNITS - 1; i++) if (!this.addRandomUnit()) break;
    this.fitVehicles();
    this.unitsChanged();
  }

  /**
   * When a lane plans for a vehicle, move any start or goal the vehicle doesn't fit at
   * to the nearest spot where it does (turning it if that helps). Presets put markers
   * in corners that suit someone on foot, not a truck.
   */
  private fitVehicles(): void {
    const specs = this.lanes
      .map((l) => this.s.lanes[l.index])
      .filter((c) => c.rep === 'vehicle')
      .map((c) => vehicleShape(this.vehicleCfg(c)));
    if (!specs.length) return;
    // Every vehicle in use has to fit.
    const layer = this.world.layers[0];
    const dist = distanceField(layer.w, layer.h, layer.blocked);
    const checks = specs.map((spec) => new FootprintChecker(layer.w, layer.h, layer.blocked, dist, spec));
    const check = {
      free: (x: number, y: number, t: number) => checks.every((c) => c.free(x, y, t)),
    };
    const fitsAt = (x: number, y: number, prefer: number[], roomy = false): number | null => {
      if (layer.blocked[y * layer.w + x]) return null;
      // Roomy: it could turn all the way round here, so it isn't boxed into a corner.
      if (roomy) for (let k = 0; k < 8; k++) if (!check.free(x + 0.5, y + 0.5, (k * Math.PI) / 4)) return null;
      for (const d of prefer) if (check.free(x + 0.5, y + 0.5, (d * Math.PI) / 180)) return d;
      return null;
    };
    for (const u of allUnits(this.world)) {
      for (const end of ['start', 'goal'] as const) {
        const c = u[end];
        const [sh, gh] = this.headings(u);
        const own = end === 'start' ? sh : gh;
        const prefer = [own, ...Array.from({ length: 24 }, (_, k) => (own + k * 15) % 360)];
        if (fitsAt(c.x, c.y, [own], true) !== null) continue;
        let done = false;
        for (const roomy of [true, false])
          for (let r = 0; r <= 24 && !done; r++)
            for (let dy = -r; dy <= r && !done; dy++)
              for (let dx = -r; dx <= r && !done; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const x = c.x + dx;
                const y = c.y + dy;
                if (x < 0 || y < 0 || x >= layer.w || y >= layer.h) continue;
                const other = end === 'start' ? u.goal : u.start;
                if (other.x === x && other.y === y) continue;
                const d = fitsAt(x, y, prefer, roomy);
                if (d === null) continue;
                u.start.heading = sh;
                u.goal.heading = gh;
                c.x = x;
                c.y = y;
                c.heading = d % 360;
                done = true;
              }
      }
    }
    this.save();
  }

  /** For tests and the console: drop every unit but the first. */
  removeExtraUnits(): void {
    this.world.units = [];
    this.unitsChanged();
  }

  private themeChanged(): void {
    this.pal.refresh();
    this.queueDraw();
  }

  // ---------------- Persistence ----------------

  private load(): { settings: Settings; world: World } | null {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      return this.fromSaved(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** Settings and map from a saved or shared object, filling anything missing with defaults. */
  private fromSaved(data: { settings: Partial<Settings>; world: string }): { settings: Settings; world: World } | null {
    try {
      const world = deserializeWorld(data.world);
      if (!world) return null;
      const lanes = (Array.isArray(data.settings.lanes) ? data.settings.lanes : []) as Partial<LaneConfig>[];
      const settings: Settings = {
        ...structuredClone(DEFAULTS),
        ...data.settings,
        overlays: { ...DEFAULTS.overlays, ...(data.settings.overlays ?? {}) },
        lanes: [
          { ...DEFAULTS.lanes[0], ...(lanes[0] ?? {}) },
          { ...DEFAULTS.lanes[1], ...(lanes[1] ?? {}) },
        ],
      };
      if (!SIZES[settings.size]) settings.size = DEFAULTS.size;
      return { settings, world };
    } catch {
      return null;
    }
  }

  private saveTimer = 0;
  private save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(
          STORE_KEY,
          JSON.stringify({
            settings: this.s,
            world: serializeWorld(this.world),
          }),
        );
      } catch {
        try {
          // A huge map may not fit; keep the settings at least.
          localStorage.setItem(STORE_KEY, JSON.stringify({ settings: this.s, world: '' }));
        } catch {
          /* storage unavailable */
        }
      }
    }, 400);
  }

  private buildPreset(): World {
    const p = presetById(this.s.preset);
    const [w, h] = p.size ?? SIZES[this.s.size] ?? SIZES.medium;
    return p.build(w, h, this.s.seed);
  }

  // ---------------- Layout ----------------

  private render(): void {
    this.host.innerHTML = '';
    this.side = h('aside', { class: 'side', 'aria-label': 'Controls' });
    this.lanesEl = h('div', { class: 'lanes' });
    this.lessonEl = h('div', { class: 'lesson', hidden: true });
    const stage = h('section', { class: 'stage', 'aria-label': 'Maps' }, this.lessonEl, this.transport(), this.lanesEl, this.legend());
    this.host.append(this.side, stage);
    this.renderSide();
    this.renderLanes();
    this.renderLesson();
  }

  private renderLesson(): void {
    const el = this.lessonEl;
    el.innerHTML = '';
    el.hidden = !this.lesson;
    if (!this.lesson) return;
    const { concept, t } = this.lesson;
    el.append(
      h(
        'div',
        { class: 'ls-text' },
        h('div', { class: 'ls-title' }, `${concept.title} · ${t.label}`),
        concept.look ? h('p', {}, linkTerms(concept.look)) : null,
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'ls-back',
          onclick: () => this.learn.open(concept.id),
        },
        'Read the concept',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'ls-close',
          'aria-label': 'Dismiss',
          onclick: () => {
            this.lesson = null;
            this.renderLesson();
          },
        },
        '×',
      ),
    );
  }

  /** Open a setup from a shared link. */
  private async openShared(packed: string): Promise<void> {
    const data = await unpack<{ settings: Partial<Settings>; world: string }>(packed);
    const got = data && this.fromSaved(data);
    clearUrlState();
    if (!got) return;
    this.pause();
    this.placing = null;
    this.s = got.settings;
    this.world = got.world;
    this.world.version = nextVersion();
    this.ensureCaches();
    for (const lane of this.lanes) {
      lane.plan = null;
      lane.closeAt = new Int32Array(0);
    }
    this.markAll();
    this.cam.fitted = true;
    this.lesson = null;
    this.render();
    this.fitVehicles();
    this.recompute();
    this.save();
  }

  /** Set the lab up as a concept card's "Try it" describes. */
  applyScenario(concept: Concept, t: Try): void {
    const sc: Scenario = t.scenario;
    this.pause();
    this.placing = null;
    const s = this.s;
    s.preset = sc.preset;
    if (sc.size) s.size = sc.size;
    s.seed = sc.seed ?? DEFAULTS.seed;
    s.need = sc.need ?? 1;
    s.diagonal = sc.diagonal ?? DEFAULTS.diagonal;
    s.useTerrain = sc.useTerrain ?? DEFAULTS.useTerrain;
    s.reachCheck = sc.reachCheck ?? true;
    s.overlays = {
      ...DEFAULTS.overlays,
      inspect: s.overlays.inspect,
      ...sc.overlays,
    };
    s.compare = sc.lanes.length > 1;
    s.lanes = [{ ...LANE_DEFAULT, ...sc.lanes[0] } as LaneConfig, { ...LANE_DEFAULT, rep: 'hpa', ...(sc.lanes[1] ?? {}) } as LaneConfig];
    this.world = this.buildPreset();
    this.world.version = nextVersion();
    this.ensureCaches();
    if (s.need > 1) this.fitUnitSize();
    for (let i = 0; i < (sc.units ?? 0); i++) if (!this.addRandomUnit()) break;
    if (sc.ends) {
      const l = this.world.layers[0];
      const at = ([fx, fy]: [number, number]) => ({ x: Math.max(0, Math.min(l.w - 1, Math.floor(fx * l.w))), y: Math.max(0, Math.min(l.h - 1, Math.floor(fy * l.h))) });
      Object.assign(this.world.start, at(sc.ends.start));
      Object.assign(this.world.goal, at(sc.ends.goal));
    }
    if (sc.unreachableGoal) this.goalOutOfReach();
    if (sc.goalFacesBack) {
      const [sh] = this.headings(this.world);
      this.world.start.heading = sh;
      this.world.goal.heading = (sh + 180) % 360;
    }
    for (const lane of this.lanes) {
      lane.plan = null;
      lane.closeAt = new Int32Array(0);
    }
    this.markAll();
    this.cam.fitted = true;
    this.lesson = { concept, t };
    this.render();
    this.fitVehicles();
    this.recompute();
    if (sc.edit) {
      const l = this.world.layers[0];
      const r = {
        x0: Math.floor(sc.edit.x0 * l.w),
        y0: Math.floor(sc.edit.y0 * l.h),
        x1: Math.min(l.w - 1, Math.floor(sc.edit.x1 * l.w)),
        y1: Math.min(l.h - 1, Math.floor(sc.edit.y1 * l.h)),
      };
      const ends = new Set(allUnits(this.world).flatMap((u) => [u.start.y * l.w + u.start.x, u.goal.y * l.w + u.goal.x]));
      for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (!ends.has(y * l.w + x)) l.blocked[y * l.w + x] = 1;
      this.world.version = nextVersion();
      this.markChanged(r);
      this.recompute();
    }
    this.save();
    if (sc.play) {
      this.seek(0);
      this.play();
    }
  }

  /** Move unit 1's start and goal to the nearest spots a unit of the current size fits. */
  private fitUnitSize(): void {
    const l = this.world.layers[0];
    for (const c of [this.world.start, this.world.goal]) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < l.w * l.h; i++) {
        if (this.clearance[i] < this.s.need) continue;
        const d = Math.hypot((i % l.w) - c.x, Math.floor(i / l.w) - c.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0) {
        c.x = best % l.w;
        c.y = Math.floor(best / l.w);
      }
    }
  }

  /** Move unit 1's goal into an area this unit size can't reach from its start. */
  private goalOutOfReach(): void {
    this.ensureCaches();
    const l = this.world.layers[0];
    const { start, goal } = this.world;
    const home = this.components[start.y * l.w + start.x];
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < l.w * l.h; i++) {
      const c = this.components[i];
      if (!c || c === home) continue;
      const d = Math.hypot((i % l.w) - goal.x, Math.floor(i / l.w) - goal.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      goal.x = best % l.w;
      goal.y = Math.floor(best / l.w);
    }
  }

  private check(label: string, on: boolean, fn: (v: boolean) => void): HTMLElement {
    return h(
      'label',
      { class: 'check' },
      Object.assign(
        h('input', {
          type: 'checkbox',
          onchange: (e: Event) => fn((e.target as HTMLInputElement).checked),
        }),
        { checked: on },
      ),
      label,
    );
  }

  private renderSide(): void {
    const s = this.s;
    this.side.innerHTML = '';

    // Map
    const presetSel = h('select', {
      id: 'preset',
      onchange: (e: Event) => this.setPreset((e.target as HTMLSelectElement).value),
    });
    PRESETS.forEach((p) => presetSel.append(option(p.id, p.name, p.id === s.preset)));
    const fixed = presetById(s.preset).size;
    const sizeSel = h('select', {
      id: 'size',
      onchange: (e: Event) => {
        s.size = (e.target as HTMLSelectElement).value;
        this.rebuild();
      },
    });
    // A preset with its own size shows that size (disabled) rather than the size random maps use.
    if (fixed) sizeSel.append(option('fixed', `${fixed[0]} × ${fixed[1]}`, true));
    else for (const [k, [w, hh]] of Object.entries(SIZES)) sizeSel.append(option(k, `${w} × ${hh}`, k === s.size));
    sizeSel.disabled = !!fixed;
    const seed = h('input', {
      id: 'seed',
      type: 'number',
      value: s.seed,
      min: 1,
      step: 1,
      onchange: (e: Event) => {
        s.seed = Math.max(1, Math.round(Number((e.target as HTMLInputElement).value) || 1));
        this.rebuild();
      },
    });
    const l = this.world.layers[0];
    this.side.append(
      h(
        'div',
        { class: 'sec' },
        h('h2', {}, 'Map'),
        h('label', { class: 'field' }, 'Preset', presetSel),
        h(
          'div',
          { class: 'row' },
          h('label', { class: 'field grow', title: fixed ? 'This preset is drawn at a fixed size' : undefined }, fixed ? 'Size (fixed)' : 'Size', sizeSel),
          h('label', { class: 'field', style: 'width:84px' }, 'Seed', seed),
        ),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'primary', onclick: () => this.newSeed() }, 'New random map'),
          h('button', { onclick: () => this.clearMap() }, 'Clear'),
        ),
        h('p', { class: 'hint', style: 'margin:0' }, `${fmt(l.w * l.h)} cells. Scroll to zoom, Shift-drag or middle-drag to pan.`),
      ),
    );

    // Paint
    const tools = h('div', {
      class: 'tools',
      role: 'group',
      'aria-label': 'Paint tool',
    });
    // Each tool: a colour strip, its name, and its cost (or what it does) underneath.
    const toolBtn = (id: Tool, label: string, color: string, sub: string) =>
      h(
        'button',
        {
          'aria-pressed': s.tool === id ? 'true' : 'false',
          onclick: () => this.setTool(id),
        },
        h('span', {
          class: `swatch${id === 'erase' ? ' erase' : ''}`,
          style: `background:var(${color})`,
          'aria-hidden': 'true',
        }),
        h('span', { class: 'tl' }, h('span', {}, label), h('span', { class: 'cost' }, sub)),
      );
    tools.append(toolBtn('wall', 'Wall', '--wall', 'Blocks'), toolBtn('erase', 'Erase', '--floor', 'Clears'));
    for (const t of TERRAINS) tools.append(toolBtn(`t${t.id}`, t.name, t.color, `×${t.cost}`));
    const brush = h('div', {
      class: 'seg',
      role: 'group',
      'aria-label': 'Brush size',
    });
    for (const b of [1, 2, 3, 6])
      brush.append(
        h(
          'button',
          {
            'aria-pressed': s.brush === b ? 'true' : 'false',
            onclick: () => {
              s.brush = b;
              this.save();
              this.renderSide();
            },
          },
          `${2 * b - 1}`,
        ),
      );
    this.side.append(
      h(
        'div',
        { class: 'sec' },
        h('h2', {}, 'Paint'),
        tools,
        h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Brush'), h('div', { class: 'grow' }, brush)),
        h('p', { class: 'hint', style: 'margin:0' }, 'Drag a start or a flag to move it. Right-drag erases.'),
      ),
    );

    // Unit and movement
    const unit = h('div', {
      class: 'seg',
      role: 'group',
      'aria-label': 'Unit size',
    });
    for (const k of [1, 2, 3, 4])
      unit.append(
        h(
          'button',
          {
            'aria-pressed': s.need === k ? 'true' : 'false',
            onclick: () => this.set({ need: k }),
          },
          `${2 * k - 1}×${2 * k - 1}`,
        ),
      );
    const diag = h('select', {
      id: 'diag',
      onchange: (e: Event) =>
        this.set({
          diagonal: (e.target as HTMLSelectElement).value as DiagonalRule,
        }),
    });
    diag.append(
      option('never', 'Never (4 directions)', s.diagonal === 'never'),
      option('noCorner', 'Diagonal, no corner cutting', s.diagonal === 'noCorner'),
      option('always', 'Diagonal, cut corners', s.diagonal === 'always'),
    );
    this.side.append(
      h(
        'div',
        { class: 'sec' },
        h('h2', {}, 'Unit and movement'),
        h('div', { class: 'field' }, 'Unit footprint (cells)', unit),
        h('label', { class: 'field' }, 'Diagonal moves', diag),
        this.check('Terrain costs', s.useTerrain, (v) => this.set({ useTerrain: v })),
        this.check('Check reachability first', s.reachCheck, (v) => this.set({ reachCheck: v })),
      ),
    );

    // Units: several start/goal pairs planned on the same lane, one after another.
    this.side.append(this.unitsSection());

    // Overlays
    const ov = (key: keyof Overlays, label: string) =>
      this.check(label, s.overlays[key], (v) => {
        s.overlays[key] = v;
        this.save();
        this.queueDraw();
      });
    this.side.append(
      h(
        'div',
        { class: 'sec' },
        h('h2', {}, 'Show'),
        ov('structure', 'Tiles, doors, polygons'),
        ov('clearance', 'Clearance numbers'),
        ov('components', 'Reachable areas for this unit'),
        ov('tree', 'Search tree (parent links)'),
        ov('rawPath', 'Raw path under smoothed path'),
        ov('inspect', 'Hover inspector (g, h, f)'),
      ),
    );
  }

  private unitsSection(): HTMLElement {
    const units = allUnits(this.world);
    const list = h('div', { class: 'units' });
    units.forEach((u, i) =>
      list.append(
        h(
          'div',
          { class: 'unit-row' },
          h(
            'span',
            {
              class: 'unit-dot',
              style: `background:var(${UNIT_COLORS[i]})`,
              'aria-hidden': 'true',
            },
            String(i + 1),
          ),
          h(
            'span',
            {
              class: 'where',
              title: `Unit ${i + 1}: start (${u.start.x}, ${u.start.y}), goal (${u.goal.x}, ${u.goal.y})`,
            },
            `Unit ${i + 1} · ${u.start.x},${u.start.y} → ${u.goal.x},${u.goal.y}`,
          ),
          i === 0
            ? h('span')
            : h(
                'button',
                {
                  title: `Remove unit ${i + 1}`,
                  'aria-label': `Remove unit ${i + 1}`,
                  onclick: () => this.removeUnit(i),
                },
                '×',
              ),
        ),
      ),
    );
    const full = units.length >= MAX_UNITS;
    const room = MAX_UNITS - units.length;
    const place = h(
      'button',
      {
        class: 'place',
        'aria-pressed': this.placing ? 'true' : 'false',
        disabled: full && !this.placing,
        onclick: () => this.togglePlacing(),
      },
      this.placing ? 'Cancel' : 'Place a unit',
    );
    const random = h(
      'button',
      { disabled: full, onclick: () => this.addRandomUnits(Math.min(3, room)) },
      full ? 'Add random' : room >= 3 ? 'Add 3 random' : `Add ${room} random`,
    );
    const clear = h('button', { disabled: units.length < 2, onclick: () => this.removeExtraUnits() }, 'Remove extras');
    const cold = h(
      'button',
      {
        title: 'Throw away every cache (tiles, navmesh, roadmap) and plan the units again in order, so you can see what each one builds and what it reuses',
        onclick: () => {
          this.markAll();
          this.queueCompute();
        },
      },
      'Replan from cold',
    );
    const n = units.length + 1;
    const hint = this.placing
      ? h(
          'p',
          { class: 'hint place-hint', style: 'margin:0;color:var(--ink)' },
          this.placing.start ? `Now click where unit ${n} is going.` : `Click the map where unit ${n} starts. Esc cancels.`,
        )
      : h(
          'p',
          { class: 'hint', style: 'margin:0' },
          units.length > 1
            ? 'Units plan in order, each on whatever the earlier ones left behind. Caches survive between replans, so use Replan from cold to watch them fill up again. Drag any marker to move it; right-click one to remove the unit.'
            : 'Add units to see what each representation shares between queries: a cache, a mesh, a roadmap, or nothing at all.',
        );
    return h(
      'div',
      { class: 'sec' },
      h('h2', {}, `Units (${units.length} of ${MAX_UNITS})`),
      list,
      h('div', { class: 'row' }, place, random, clear, cold),
      hint,
    );
  }

  private unitsChanged(): void {
    this.save();
    this.renderSide();
    this.queueCompute();
  }

  /** Adds one randomly placed unit; false when no room or no spot was found. */
  private addRandomUnit(): boolean {
    if (this.world.units.length >= MAX_UNITS - 1) return false;
    const layer = this.world.layers[0];
    const space = new GridSpace(layer, this.clearance, {
      diagonal: this.s.diagonal,
      need: this.s.need,
      useTerrain: this.s.useTerrain,
    });
    const taken = allUnits(this.world);
    const u = randomUnit(space, this.components, taken, this.s.seed * 7919 + taken.length * 104729 + this.world.units.length * 31 + 17);
    if (!u) return false;
    this.world.units.push(u);
    return true;
  }

  private removeUnit(i: number): void {
    if (i < 1) return;
    this.world.units.splice(i - 1, 1);
    this.unitsChanged();
  }

  private togglePlacing(): void {
    this.placing = this.placing ? null : { start: null };
    for (const lane of this.lanes) lane.canvas.classList.toggle('placing', !!this.placing);
    this.renderSide();
  }

  private renderLanes(): void {
    this.lanesEl.innerHTML = '';
    this.lanesEl.classList.toggle('two', this.s.compare);
    const old = this.lanes;
    this.lanes = [];
    const count = this.s.compare ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const lane = this.makeLane(i, old[i]);
      this.lanes.push(lane);
      this.lanesEl.append(lane.root);
    }
    requestAnimationFrame(() => this.layoutCanvases());
  }

  private makeLane(index: number, prev?: Lane): Lane {
    const canvas = h('canvas', {
      class: 'map',
      'aria-label': `Map ${index ? 'B' : 'A'}`,
      role: 'img',
    });
    const zoom = h(
      'div',
      { class: 'zoom' },
      h(
        'button',
        {
          title: 'Zoom in',
          'aria-label': 'Zoom in',
          onclick: () => this.zoomBy(1.6),
        },
        '+',
      ),
      h(
        'button',
        {
          title: 'Zoom out',
          'aria-label': 'Zoom out',
          onclick: () => this.zoomBy(1 / 1.6),
        },
        '−',
      ),
      h(
        'button',
        {
          title: 'Fit map',
          'aria-label': 'Fit map',
          onclick: () => this.fit(),
        },
        'Fit',
      ),
    );
    const lane: Lane = {
      index,
      root: h('article', { class: 'lane' }),
      canvas,
      ctx: canvas.getContext('2d')!,
      banner: h('div'),
      stats: h('div', { class: 'stat-block' }),
      info: h('div', { class: 'info' }),
      head: h('div', { class: 'lane-head' }),
      plan: prev?.plan ?? null,
      closeAt: prev?.closeAt ?? new Int32Array(0),
      status: prev?.status ?? new Uint8Array(0),
      parent: prev?.parent ?? new Int32Array(0),
      g: prev?.g ?? new Float32Array(0),
      f: prev?.f ?? new Float32Array(0),
      tip: h('div', { class: 'inspect', hidden: true, 'aria-live': 'polite' }),
      hover: null,
      applied: -1,
      current: -1,
      pending: prev?.pending ?? allPending(),
      hpa: prev?.hpa ?? null,
      nav: prev?.nav ?? null,
      roadmap: prev?.roadmap ?? null,
      vehicle: prev?.vehicle ?? null,
    };
    canvas.classList.toggle('placing', !!this.placing);
    this.fillLaneHead(lane);
    lane.root.append(lane.head, h('div', { class: 'map-wrap' }, canvas, zoom, lane.tip), lane.banner, lane.stats, lane.info);
    this.attachEditing(lane);
    this.fillInfo(lane);
    if (lane.plan) this.fillStats(lane);
    return lane;
  }

  private fillLaneHead(lane: Lane): void {
    const cfg = this.s.lanes[lane.index];
    lane.head.innerHTML = '';
    lane.head.className = `lane-head rep-${cfg.rep}`;
    const relaunch = () => {
      this.fillLaneHead(lane);
      this.fillInfo(lane);
      this.save();
      this.queueCompute();
    };
    const repSel = h('select', {
      onchange: (e: Event) => {
        cfg.rep = (e.target as HTMLSelectElement).value as RepId;
        if (cfg.rep !== 'grid' && cfg.heuristic === 'manhattan') cfg.heuristic = 'octile';
        if (cfg.rep === 'vehicle') this.fitVehicles();
        this.renderSide();
        relaunch();
      },
    });
    for (const r of REPRESENTATIONS) repSel.append(option(r.id, r.short, r.id === cfg.rep, !r.ready));
    const fields: HTMLElement[] = [h('label', { class: 'field' }, 'Representation', repSel)];

    const heurSel = () => {
      const sel = h('select', {
        onchange: (e: Event) => {
          cfg.heuristic = (e.target as HTMLSelectElement).value as HeuristicId;
          relaunch();
        },
      });
      for (const hd of HEURISTICS) sel.append(option(hd.id, hd.name, hd.id === cfg.heuristic));
      return sel;
    };
    const smoothSel = () => {
      const sel = h('select', {
        onchange: (e: Event) => {
          cfg.smoothing = (e.target as HTMLSelectElement).value as SmoothingId;
          relaunch();
        },
      });
      sel.append(option('none', 'None', cfg.smoothing === 'none'), option('shortcut', 'Line-of-sight shortcut', cfg.smoothing === 'shortcut'));
      return sel;
    };

    if (cfg.rep === 'grid') {
      const algSel = h('select', {
        onchange: (e: Event) => {
          cfg.alg = (e.target as HTMLSelectElement).value;
          const def = algorithmById(cfg.alg);
          if (def.family === 'Any-angle' && cfg.heuristic === 'octile') cfg.heuristic = 'euclidean';
          if (def.family !== 'Any-angle' && cfg.heuristic === 'euclidean') cfg.heuristic = 'octile';
          relaunch();
        },
      });
      for (const fam of [...new Set(ALGORITHMS.map((a) => a.family))]) {
        const g = h('optgroup', { label: fam });
        for (const a of ALGORITHMS.filter((x) => x.family === fam)) g.append(option(a.id, a.name, a.id === cfg.alg));
        algSel.append(g);
      }
      const def = algorithmById(cfg.alg);
      const hs = heurSel();
      hs.disabled = !def.usesHeuristic;
      fields.push(
        h('label', { class: 'field' }, 'Algorithm', algSel),
        h('label', { class: 'field' }, 'Heuristic', hs),
        h('label', { class: 'field' }, 'Smoothing', smoothSel()),
      );
      if (def.usesWeight) {
        const out = h('output', {}, cfg.weight.toFixed(1));
        const range = h('input', {
          type: 'range',
          min: 1,
          max: 5,
          step: 0.1,
          value: cfg.weight,
          'aria-label': 'Heuristic weight',
          oninput: (e: Event) => {
            cfg.weight = Number((e.target as HTMLInputElement).value);
            out.textContent = cfg.weight.toFixed(1);
            this.save();
            this.queueCompute();
          },
        });
        fields.push(h('div', { class: 'weight wide' }, 'Weight w', range, out));
      }
    } else if (cfg.rep === 'hpa') {
      const tile = h('select', {
        onchange: (e: Event) => {
          cfg.cluster = Number((e.target as HTMLSelectElement).value);
          relaunch();
        },
      });
      for (const c of [8, 16, 32, 64]) tile.append(option(String(c), `${c} × ${c}`, c === cfg.cluster));
      const mode = h('select', {
        onchange: (e: Event) => {
          cfg.lazy = (e.target as HTMLSelectElement).value === 'lazy';
          relaunch();
        },
      });
      mode.append(option('lazy', 'Lazy (build on first use)', cfg.lazy), option('eager', 'Eager (build all up front)', !cfg.lazy));
      fields.push(
        h('label', { class: 'field' }, 'Tile size', tile),
        h('label', { class: 'field' }, 'Cache', mode),
        h('label', { class: 'field' }, 'Smoothing', smoothSel()),
      );
      const out = h('output', {}, cfg.hpaWeight.toFixed(2));
      const range = h('input', {
        type: 'range',
        min: 1,
        max: 2,
        step: 0.05,
        value: cfg.hpaWeight,
        'aria-label': 'Door-level heuristic weight',
        oninput: (e: Event) => {
          cfg.hpaWeight = Number((e.target as HTMLInputElement).value);
          out.textContent = cfg.hpaWeight.toFixed(2);
          this.save();
          this.queueCompute();
        },
      });
      fields.push(h('div', { class: 'weight wide' }, 'Door weight', range, out));
    } else if (cfg.rep === 'roadmap') {
      const mSel = h('select', {
        onchange: (e: Event) => {
          cfg.rmMethod = (e.target as HTMLSelectElement).value as RoadmapMethod;
          relaunch();
        },
      });
      for (const fam of [...new Set(ROADMAP_METHODS.map((m) => m.family))]) {
        const g = h('optgroup', { label: fam });
        for (const m of ROADMAP_METHODS.filter((x) => x.family === fam)) g.append(option(m.id, m.name, m.id === cfg.rmMethod));
        mSel.append(g);
      }
      const numSel = (label: string, values: number[], cur: number, fmtV: (v: number) => string, set: (v: number) => void) => {
        const sel = h('select', {
          onchange: (e: Event) => {
            set(Number((e.target as HTMLSelectElement).value));
            relaunch();
          },
        });
        for (const v of values) sel.append(option(String(v), fmtV(v), v === cur));
        return h('label', { class: 'field' }, label, sel);
      };
      const m = cfg.rmMethod;
      fields.push(h('label', { class: 'field' }, 'Method', mSel));
      if (m === 'prm' || m === 'lazyprm')
        fields.push(
          numSel(
            'Samples',
            [100, 250, 500, 1000, 2000, 4000, 8000, 16000],
            cfg.rmSamples,
            (v) => fmt(v),
            (v) => (cfg.rmSamples = v),
          ),
        );
      else if (m === 'feature')
        fields.push(
          numSel(
            'Filler spacing',
            [4, 8, 16, 32],
            cfg.rmSpacing,
            (v) => `${v} cells`,
            (v) => (cfg.rmSpacing = v),
          ),
        );
      else
        fields.push(
          numSel(
            'Iterations',
            [500, 1000, 2000, 5000, 10000, 20000, 50000],
            cfg.rmIterations,
            (v) => fmt(v),
            (v) => (cfg.rmIterations = v),
          ),
        );
      fields.push(h('label', { class: 'field' }, 'Smoothing', smoothSel()));
      const row: HTMLElement[] = [];
      if (m === 'rrt' || m === 'rrtconnect' || m === 'rrtstar' || m === 'shared')
        row.push(
          numSel(
            'Step',
            [1, 2, 3, 5, 8, 12],
            cfg.rmStep,
            (v) => `${v} cells`,
            (v) => (cfg.rmStep = v),
          ),
        );
      if (m !== 'feature')
        row.push(
          h(
            'div',
            { class: 'field' },
            ' ',
            h(
              'button',
              {
                onclick: () => {
                  cfg.rmSeed++;
                  lane.pending.roadmap = 'all';
                  relaunch();
                },
                title: m === 'shared' ? 'Throw the shared graph away and start again with new random numbers' : 'New random numbers',
              },
              m === 'shared' ? `Reset graph (seed ${cfg.rmSeed})` : `Reseed (seed ${cfg.rmSeed})`,
            ),
          ),
        );
      if (row.length) fields.push(h('div', { class: 'wide row' }, ...row));
    } else if (cfg.rep === 'vehicle') {
      const sel = (label: string, opts: Array<[string, string]>, cur: string, set: (v: string) => void) => {
        const el = h('select', {
          onchange: (e: Event) => {
            set((e.target as HTMLSelectElement).value);
            relaunch();
          },
        });
        for (const [v, t] of opts) el.append(option(v, t, v === cur));
        return h('label', { class: 'field' }, label, el);
      };
      const spec = vehicleShape(this.vehicleCfg(cfg));
      fields.push(
        sel(
          'Planner',
          VEHICLE_ALGS.map((a) => [a.id, a.name]),
          cfg.vAlg,
          (v) => (cfg.vAlg = v as VehicleAlg),
        ),
        sel(
          'Vehicle',
          VEHICLES.map((v) => [v.id, v.name]),
          cfg.vVehicle,
          (v) => {
            cfg.vVehicle = v;
            this.fitVehicles();
            this.renderSide();
          },
        ),
        sel(
          'Turning radius',
          [['0', `Its own (${spec.radius} cells)`], ...[2, 3, 4, 6, 8, 12].map((r): [string, string] => [String(r), `${r} cells`])],
          String(cfg.vRadius),
          (v) => (cfg.vRadius = Number(v)),
        ),
        sel(
          'Reverse',
          [
            ['yes', 'Can reverse'],
            ['no', 'Forward only'],
          ],
          cfg.vReverse ? 'yes' : 'no',
          (v) => (cfg.vReverse = v === 'yes'),
        ),
        sel(
          'Arrive facing',
          [
            ['set', "The goal's heading"],
            ['any', 'Any direction'],
          ],
          cfg.vAny ? 'any' : 'set',
          (v) => (cfg.vAny = v === 'any'),
        ),
      );
      if (cfg.vAlg === 'hybrid') {
        fields.push(
          sel(
            'Heading bins',
            [36, 72, 144].map((b): [string, string] => [String(b), `${b} (${360 / b}°)`]),
            String(cfg.vBins),
            (v) => (cfg.vBins = Number(v)),
          ),
          sel(
            'Analytic shot',
            [
              ['on', 'On (Reeds–Shepp / Dubins)'],
              ['off', 'Off'],
            ],
            cfg.vShots ? 'on' : 'off',
            (v) => (cfg.vShots = v === 'on'),
          ),
        );
      }
      if (cfg.vAlg !== 'rrt')
        fields.push(
          sel(
            'Expansion limit',
            [5000, 20000, 50000, 200000].map((n): [string, string] => [String(n), fmt(n)]),
            String(cfg.vLimit),
            (v) => (cfg.vLimit = Number(v)),
          ),
        );
      else {
        fields.push(
          sel(
            'Iterations',
            [500, 1000, 3000, 10000, 30000].map((n): [string, string] => [String(n), fmt(n)]),
            String(cfg.vIterations),
            (v) => (cfg.vIterations = Number(v)),
          ),
        );
        fields.push(
          h(
            'div',
            { class: 'field' },
            ' ',
            h(
              'button',
              {
                onclick: () => {
                  cfg.vSeed++;
                  relaunch();
                },
              },
              `Reseed (seed ${cfg.vSeed})`,
            ),
          ),
        );
      }
    } else {
      fields.push(
        h(
          'div',
          { class: 'field wide' },
          ' ',
          this.check("Show Detour's own path (dotted)", cfg.showDetour, (v) => {
            cfg.showDetour = v;
            relaunch();
          }),
        ),
      );
    }
    lane.head.append(h('span', { class: 'tag', 'aria-hidden': 'true' }, lane.index ? 'B' : 'A'), ...fields);
  }

  private fillInfo(lane: Lane): void {
    this.fillInfoInner(lane);
    const cfg = this.s.lanes[lane.index];
    // Link glossary terms in the prose, once each per lane.
    const seen = new Set<string>();
    for (const p of lane.info.querySelectorAll('p')) {
      const text = p.textContent ?? '';
      const label = p.classList.contains('watch') && text.startsWith('Watch for: ') ? 'Watch for: ' : '';
      p.textContent = '';
      if (label) p.append(label);
      p.append(linkTerms(text.slice(label.length), seen));
    }
    const ids = conceptsFor(cfg.rep, cfg.alg, cfg.rmMethod, cfg.vAlg);
    lane.info.append(
      h(
        'div',
        { class: 'cx-links' },
        h('span', {}, 'Concepts: '),
        ...ids
          .map((id) => conceptById(id))
          .filter((c): c is Concept => !!c)
          .map((c) =>
            h(
              'button',
              {
                type: 'button',
                class: 'cx-link',
                onclick: () => this.learn.open(c.id),
              },
              c.title,
            ),
          ),
      ),
    );
  }

  private fillInfoInner(lane: Lane): void {
    const cfg = this.s.lanes[lane.index];
    lane.info.innerHTML = '';
    if (cfg.rep === 'grid') {
      const def = algorithmById(cfg.alg);
      lane.info.append(
        h('h3', {}, def.name, h('span', { class: 'fam' }, def.family)),
        h('p', {}, def.summary),
        h(
          'div',
          { class: 'chips' },
          h('span', { class: 'chip' }, 'Optimal: ', h('b', {}, def.guarantees.optimal)),
          h('span', { class: 'chip' }, 'Complete: ', h('b', {}, def.guarantees.complete)),
          h('span', { class: 'chip' }, 'Path: ', h('b', {}, def.guarantees.pathShape)),
        ),
        h('p', { class: 'watch' }, 'Watch for: ', def.watch),
      );
      return;
    }
    if (cfg.rep === 'vehicle') {
      const a = vehicleAlgInfo(cfg.vAlg);
      lane.info.append(
        h('h3', {}, a.name, h('span', { class: 'fam' }, a.family)),
        h('p', {}, a.summary),
        h('div', { class: 'chips' }, ...a.chips.map(([k, v]) => h('span', { class: 'chip' }, `${k}: `, h('b', {}, v)))),
        h('p', { class: 'watch' }, 'Watch for: ', a.watch),
        h(
          'p',
          { class: 'watch' },
          "Drag the round handle by a start or goal to turn it, or scroll over the marker. Dashed path = reversing, dots = gear changes. Vehicles use their own footprint; the sidebar's unit footprint applies to the other lanes.",
        ),
      );
      return;
    }
    if (cfg.rep === 'roadmap') {
      const m = methodInfo(cfg.rmMethod);
      lane.info.append(
        h('h3', {}, m.name, h('span', { class: 'fam' }, m.family)),
        h('p', {}, m.summary),
        h('div', { class: 'chips' }, ...m.chips.map(([k, v]) => h('span', { class: 'chip' }, `${k}: `, h('b', {}, v)))),
        h('p', { class: 'watch' }, 'Watch for: ', m.watch),
      );
      return;
    }
    const info = REP_INFO[cfg.rep];
    lane.info.append(
      h('h3', {}, info.name, h('span', { class: 'fam' }, info.family)),
      h('p', {}, info.summary),
      h('div', { class: 'chips' }, ...info.chips.map(([k, v]) => h('span', { class: 'chip' }, `${k}: `, h('b', {}, v)))),
      h('p', { class: 'watch' }, 'Watch for: ', info.watch),
    );
  }

  private legend(): HTMLElement {
    const sw = (v: string, label: string) => h('span', {}, h('i', { style: `background:var(${v})` }), label);
    return h(
      'div',
      { class: 'legend' },
      // Open cells are drawn as rings once the map is zoomed in enough to see cells, so the key shows a ring.
      h('span', {}, h('i', { style: 'box-sizing:border-box;border:2px solid var(--open-ring);background:transparent' }), 'open (queued)'),
      sw('--closed', 'closed (expanded)'),
      sw('--scan', 'scanned (JPS)'),
      h('span', {}, h('i', { class: 'ln' }), 'path'),
      h('span', {}, h('i', { class: 'dot' }), 'door (HPA*)'),
      sw('--vehicle', 'navmesh polygon / reversing'),
      sw('--alert', 'rebuilt by last edit'),
      sw('--wall', 'wall'),
      ...TERRAINS.slice(1).map((t) => sw(t.color, `${t.name.toLowerCase()} ×${t.cost}`)),
    );
  }

  private transport(): HTMLElement {
    const btn = (label: string, title: string, fn: () => void) => h('button', { title, 'aria-label': title, onclick: fn }, label);
    this.playBtn = btn('▶', 'Play (space)', () => this.togglePlay()) as HTMLButtonElement;
    this.playBtn.classList.add('primary');
    this.scrub = h('input', {
      type: 'range',
      min: 0,
      max: 0,
      value: 0,
      'aria-label': 'Search progress',
      oninput: (e: Event) => {
        this.pause();
        this.seek(Number((e.target as HTMLInputElement).value));
      },
    });
    this.scrubLbl = h('div', { class: 'lbl' });
    this.speedLbl = h('span');
    const speed = h('input', {
      type: 'range',
      min: 0,
      max: 100,
      value: this.s.speed,
      'aria-label': 'Playback speed',
      oninput: (e: Event) => {
        this.s.speed = Number((e.target as HTMLInputElement).value);
        this.updateSpeedLabel();
        this.save();
      },
    });
    this.updateSpeedLabel();
    const compare = this.check('Compare two setups', this.s.compare, (v) => {
      this.s.compare = v;
      for (const l of this.lanes) l.pending = allPending();
      this.save();
      this.renderLanes();
      this.renderSide();
      this.queueCompute();
    });
    return h(
      'div',
      { class: 'transport' },
      h(
        'div',
        { class: 'btns' },
        btn('⏮', 'Back to start (Home)', () => {
          this.pause();
          this.seek(0);
        }),
        btn('◀', 'Step back (←)', () => {
          this.pause();
          this.seek(this.step - 1);
        }),
        this.playBtn,
        btn('▶|', 'Step (→)', () => {
          this.pause();
          this.seek(this.step + 1);
        }),
        btn('⏭', 'Jump to end (End)', () => {
          this.pause();
          this.seek(this.maxStep);
        }),
      ),
      h('div', { class: 'scrub' }, this.scrub, this.scrubLbl),
      h('div', { class: 'speed' }, speed, h('div', { class: 'lbl' }, this.speedLbl)),
      compare,
    );
  }

  private stepsPerSecond(): number {
    return Math.max(1, Math.round(Math.pow(10, (this.s.speed / 100) * 4.6)));
  }

  private updateSpeedLabel(): void {
    this.speedLbl.textContent = `${fmt(this.stepsPerSecond())} steps/s`;
  }

  // ---------------- Settings changes ----------------

  private set(patch: Partial<Settings>): void {
    Object.assign(this.s, patch);
    this.save();
    this.renderSide();
    this.queueCompute();
  }

  private setTool(t: Tool): void {
    this.s.tool = t;
    this.save();
    this.renderSide();
  }

  private setPreset(id: string): void {
    this.s.preset = id;
    if (id === 'country') this.s.useTerrain = true;
    this.rebuild();
  }

  private rebuild(): void {
    if (this.lesson) {
      this.lesson = null;
      this.renderLesson();
    }
    const extra = this.world.units.length;
    this.world = this.buildPreset();
    this.world.version = nextVersion();
    // Keep the same number of units, placed afresh on the new map.
    this.ensureCaches();
    for (let i = 0; i < extra; i++) if (!this.addRandomUnit()) break;
    this.fitVehicles();
    // Old plans describe the previous map; drop them so nothing draws against the new one.
    for (const lane of this.lanes) {
      lane.plan = null;
      lane.closeAt = new Int32Array(0);
    }
    this.markAll();
    this.cam.fitted = true;
    this.save();
    this.renderSide();
    this.layoutCanvases();
    this.queueCompute();
  }

  private newSeed(): void {
    this.s.seed = 1 + Math.floor(Math.random() * 99999);
    this.rebuild();
  }

  private clearMap(): void {
    const l = this.world.layers[0];
    l.blocked.fill(0);
    l.terrain.fill(0);
    this.world.version = nextVersion();
    this.markAll();
    this.save();
    this.queueCompute();
  }

  private markAll(): void {
    for (const l of this.lanes) l.pending = allPending();
  }

  /** Record an edited box for every lane's planner. */
  private markChanged(r: Rect): void {
    for (const l of this.lanes)
      for (const k of CACHED_REPS) {
        const p = l.pending[k];
        if (p === 'all') continue;
        l.pending[k] =
          p === 'none'
            ? { ...r }
            : { x0: Math.min(p.x0, r.x0), y0: Math.min(p.y0, r.y0), x1: Math.max(p.x1, r.x1), y1: Math.max(p.y1, r.y1) };
      }
  }

  // ---------------- Camera ----------------

  private fit(): void {
    this.cam.fitted = true;
    this.applyFit();
    this.queueDraw();
  }

  private applyFit(): void {
    const l = this.world.layers[0];
    const cs = Math.min(this.cam.W / l.w, this.cam.H / l.h);
    this.cam.cs = cs;
    this.cam.ox = (this.cam.W - l.w * cs) / 2;
    this.cam.oy = (this.cam.H - l.h * cs) / 2;
  }

  private zoomBy(f: number, px = this.cam.W / 2, py = this.cam.H / 2): void {
    const l = this.world.layers[0];
    const fitCs = Math.min(this.cam.W / l.w, this.cam.H / l.h);
    const next = Math.max(fitCs * 0.5, Math.min(48, this.cam.cs * f));
    const k = next / this.cam.cs;
    this.cam.ox = px - (px - this.cam.ox) * k;
    this.cam.oy = py - (py - this.cam.oy) * k;
    this.cam.cs = next;
    this.cam.fitted = false;
    this.queueDraw();
  }

  private viewRect(): ViewRect {
    const l = this.world.layers[0];
    const { cs, ox, oy, W, H } = this.cam;
    return {
      cs,
      x0: Math.max(0, Math.floor(-ox / cs)),
      y0: Math.max(0, Math.floor(-oy / cs)),
      x1: Math.min(l.w - 1, Math.floor((W - ox) / cs)),
      y1: Math.min(l.h - 1, Math.floor((H - oy) / cs)),
    };
  }

  // ---------------- Editing ----------------

  private attachEditing(lane: Lane): void {
    const c = lane.canvas;
    let mode: 'none' | 'paint' | 'marker' | 'pan' | 'heading' = 'none';
    // The marker being dragged: which unit, and its start or its goal.
    let drag: { unit: number; end: 'start' | 'goal'; back?: boolean } | null = null;
    let erase = false;
    let last: [number, number] | null = null;
    let panFrom: [number, number, number, number] = [0, 0, 0, 0];
    const local = (e: PointerEvent | WheelEvent): [number, number] => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const cellAt = (e: PointerEvent): [number, number] => {
      const [px, py] = local(e);
      const l = this.world.layers[0];
      const x = Math.floor((px - this.cam.ox) / this.cam.cs);
      const y = Math.floor((py - this.cam.oy) / this.cam.cs);
      return [Math.max(0, Math.min(l.w - 1, x)), Math.max(0, Math.min(l.h - 1, y))];
    };
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const [px, py] = local(e);
        // Over a vehicle's start or goal, the wheel turns it instead of zooming.
        if (this.s.lanes[lane.index].rep === 'vehicle') {
          const l = this.world.layers[0];
          const x = Math.floor((px - this.cam.ox) / this.cam.cs);
          const y = Math.floor((py - this.cam.oy) / this.cam.cs);
          const hit = x >= 0 && y >= 0 && x < l.w && y < l.h ? this.markerAt(x, y, Math.max(0, Math.ceil(6 / this.cam.cs))) : null;
          if (hit) {
            const u = allUnits(this.world)[hit.unit];
            const [sh, gh] = this.headings(u);
            u.start.heading = sh;
            u.goal.heading = gh;
            const c = u[hit.end];
            c.heading = ((((c.heading ?? 0) + (e.deltaY > 0 ? 15 : -15)) % 360) + 360) % 360;
            this.queueCompute();
            this.save();
            return;
          }
        }
        this.zoomBy(Math.pow(1.0015, -e.deltaY), px, py);
      },
      { passive: false },
    );
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pause();
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        e.preventDefault();
        mode = 'pan';
        const [px, py] = local(e);
        panFrom = [px, py, this.cam.ox, this.cam.oy];
        return;
      }
      const [x, y] = cellAt(e);
      if (this.placing && e.button === 0) {
        this.placeAt(x, y);
        return;
      }
      // Vehicle lanes: the round handles in front of each start and goal turn it.
      const hh = this.handleAt(lane, e);
      if (hh && e.button === 0) {
        mode = 'heading';
        drag = hh;
        this.dragging = true;
        return;
      }
      // Grab tolerance so markers stay easy to pick up when zoomed out.
      const tol = Math.max(0, Math.ceil(6 / this.cam.cs));
      const hit = this.markerAt(x, y, tol);
      if (hit && e.button === 2) {
        // Right-click on an extra unit's marker removes that unit.
        if (hit.unit > 0) this.removeUnit(hit.unit);
        return;
      }
      if (hit) {
        mode = 'marker';
        drag = hit;
        this.dragging = true;
      } else {
        mode = 'paint';
        erase = e.button === 2;
        this.stroking = true;
        this.paintCell(x, y, erase);
      }
      last = [x, y];
    });
    c.addEventListener('pointermove', (e) => {
      if (mode === 'none') {
        // Not dragging anything: the hover inspector describes what's under the pointer.
        const [px, py] = local(e);
        lane.hover = {
          x: (px - this.cam.ox) / this.cam.cs,
          y: (py - this.cam.oy) / this.cam.cs,
          px,
          py,
        };
        this.showInspector(lane);
        return;
      }
      lane.hover = null;
      lane.tip.hidden = true;
      if (mode === 'pan') {
        const [px, py] = local(e);
        this.cam.ox = panFrom[2] + px - panFrom[0];
        this.cam.oy = panFrom[3] + py - panFrom[1];
        this.cam.fitted = false;
        this.queueDraw();
        return;
      }
      if (mode === 'heading' && drag) {
        const [px, py] = local(e);
        const mx = (px - this.cam.ox) / this.cam.cs;
        const my = (py - this.cam.oy) / this.cam.cs;
        const u = allUnits(this.world)[drag.unit];
        const cell = drag.end === 'start' ? u.start : u.goal;
        // A handle behind the vehicle points it away from the pointer.
        const sgn = drag.back ? -1 : 1;
        const deg = Math.round((Math.atan2(sgn * (my - (cell.y + 0.5)), sgn * (mx - (cell.x + 0.5))) * 180) / Math.PI / 5) * 5;
        const norm = ((deg % 360) + 360) % 360;
        if (norm !== cell.heading) {
          // Fix the other end too, so it stops following the start-to-goal line.
          const [sh, gh] = this.headings(u);
          u.start.heading = sh;
          u.goal.heading = gh;
          cell.heading = norm;
          this.queueCompute();
        }
        return;
      }
      const [x, y] = cellAt(e);
      if (last && last[0] === x && last[1] === y) return;
      if (mode === 'paint') {
        const [x0, y0] = last ?? [x, y];
        const n = Math.max(Math.abs(x - x0), Math.abs(y - y0));
        for (let k = 1; k <= n; k++) this.paintCell(Math.round(x0 + ((x - x0) * k) / n), Math.round(y0 + ((y - y0) * k) / n), erase);
      } else if (drag) {
        const l = this.world.layers[0];
        const u = allUnits(this.world)[drag.unit];
        const other = drag.end === 'start' ? u.goal : u.start;
        // Markers only land on open cells; dragging across walls skips over them.
        if (!(other.x === x && other.y === y) && !l.blocked[y * l.w + x]) {
          const target = drag.end === 'start' ? u.start : u.goal;
          target.x = x;
          target.y = y;
          this.queueCompute();
        }
      }
      last = [x, y];
    });
    const end = () => {
      if (mode === 'paint') {
        this.stroking = false;
        this.queueCompute();
      }
      if (mode === 'marker' || mode === 'heading') {
        this.dragging = false;
        if (this.deferred) this.queueCompute();
      }
      if (mode === 'marker') this.renderSide();
      if (mode !== 'none' && mode !== 'pan') this.save();
      mode = 'none';
      drag = null;
      last = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      lane.hover = null;
      lane.tip.hidden = true;
    });
  }

  /** Fills and places the hover inspector for a lane, from the search state at the current step. */
  private showInspector(lane: Lane): void {
    const hv = lane.hover;
    const tip = lane.tip;
    const l = this.world.layers[0];
    if (!hv || !this.s.overlays.inspect || this.stroking) {
      tip.hidden = true;
      return;
    }
    const cx = Math.floor(hv.x);
    const cy = Math.floor(hv.y);
    if (cx < 0 || cy < 0 || cx >= l.w || cy >= l.h) {
      tip.hidden = true;
      return;
    }
    const i = cy * l.w + cx;
    const lines: Array<[string, string]> = [];
    const t = TERRAINS[l.terrain[i]];
    lines.push([
      'cell',
      l.blocked[i]
        ? `${cx}, ${cy} · wall`
        : `${cx}, ${cy} · ${t.name.toLowerCase()} ×${this.s.useTerrain ? t.cost : 1} · clearance ${this.clearance[i] ?? '?'}`,
    ]);
    const p = lane.plan;
    const view = p?.view;
    const stale = this.stroking || this.deferred;
    if (p && view?.nodeAt && !stale) {
      const id = view.nodeAt(hv.x, hv.y, Math.max(0.6, 9 / this.cam.cs));
      const st = id >= 0 && id < lane.status.length ? lane.status[id] : 0;
      if (id >= 0 && st) {
        lines.push(['node', view.nodeLabel?.(id) ?? `Node ${id}`]);
        lines.push(['state', ['', 'Open: queued, not expanded yet', 'Closed: expanded', 'Scanned by a jump, never queued'][st]]);
        const g = lane.g[id];
        const f = lane.f[id];
        if (Number.isFinite(g) && Number.isFinite(f) && p.priority) {
          const w = p.weight ?? 1;
          const n2 = (v: number) => fmt(v, 2);
          const formula =
            p.priority === 'g+h'
              ? `g ${n2(g)} + h ${n2(f - g)} = f ${n2(f)}`
              : p.priority === 'g+wh'
                ? `g ${n2(g)} + ${fmt(w, 2)} × h ${n2((f - g) / w)} = f ${n2(f)}`
                : p.priority === 'h'
                  ? `f = h = ${n2(f)} (greedy ignores g, which is ${n2(g)})`
                  : p.priority === 'g'
                    ? `f = g = ${n2(g)} (no heuristic)`
                    : `${fmt(g)} steps from the start`;
          lines.push(['cost', formula]);
        }
        const par = lane.parent[id];
        if (par >= 0 && par !== id) lines.push(['from', `came from ${view.nodeLabel?.(par) ?? `node ${par}`}`]);
        if (id === lane.current) lines.push(['now', 'Being expanded at this step']);
      }
    }
    tip.innerHTML = '';
    for (const [k, text] of lines) tip.append(h('div', { class: `ln ${k}` }, text));
    tip.hidden = false;
    // Next to the pointer, flipped to stay inside the map.
    const wrap = tip.parentElement!;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = `${Math.max(4, hv.px + 16 + tw > W ? hv.px - 12 - tw : hv.px + 16)}px`;
    tip.style.top = `${Math.max(4, hv.py + 16 + th > H ? hv.py - 12 - th : hv.py + 16)}px`;
  }

  /** A vehicle lane's heading handle under the pointer, if any. */
  private handleAt(lane: Lane, e: PointerEvent | WheelEvent): { unit: number; end: 'start' | 'goal'; back: boolean } | null {
    const cfg = this.s.lanes[lane.index];
    if (cfg.rep !== 'vehicle') return null;
    const r = lane.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const shape = vehicleShape(this.vehicleCfg(cfg));
    const units = allUnits(this.world);
    for (let i = units.length - 1; i >= 0; i--) {
      const [sh, gh] = this.headings(units[i]);
      const ends: Array<['start' | 'goal', Cell, number]> = [['start', units[i].start, sh]];
      if (!cfg.vAny) ends.unshift(['goal', units[i].goal, gh]);
      for (const [end, c, deg] of ends) {
        const layer = this.world.layers[0];
        const hp = headingHandle(shape, c.x + 0.5, c.y + 0.5, (deg * Math.PI) / 180, this.cam.cs, layer.w, layer.h);
        const hx = this.cam.ox + hp.x * this.cam.cs;
        const hy = this.cam.oy + hp.y * this.cam.cs;
        if (Math.hypot(hx - px, hy - py) <= 10) return { unit: i, end, back: hp.back };
      }
    }
    return null;
  }

  /** The topmost marker within `tol` cells of (x, y): later units draw on top, goals over starts. */
  private markerAt(x: number, y: number, tol: number): { unit: number; end: 'start' | 'goal' } | null {
    const units = allUnits(this.world);
    // Exact hits first, so close markers can still be told apart.
    for (const t of tol > 0 ? [0, tol] : [0]) {
      const near = (p: Cell) => Math.abs(p.x - x) <= t && Math.abs(p.y - y) <= t;
      for (let i = units.length - 1; i >= 0; i--) {
        if (near(units[i].goal)) return { unit: i, end: 'goal' };
        if (near(units[i].start)) return { unit: i, end: 'start' };
      }
    }
    return null;
  }

  /** Click-to-place: first click is the new unit's start, second its goal. */
  private placeAt(x: number, y: number): void {
    const l = this.world.layers[0];
    if (!this.placing || l.blocked[y * l.w + x]) return;
    if (!this.placing.start) {
      this.placing.start = { layer: 0, x, y };
      this.renderSide();
      this.queueDraw();
      return;
    }
    const s = this.placing.start;
    if (s.x === x && s.y === y) return;
    this.world.units.push({ start: s, goal: { layer: 0, x, y } });
    this.placing = null;
    for (const lane of this.lanes) lane.canvas.classList.remove('placing');
    this.unitsChanged();
  }

  private paintCell(cx: number, cy: number, erase: boolean): void {
    const l = this.world.layers[0];
    const r = this.s.brush - 1;
    const tool: Tool = erase ? 'erase' : this.s.tool;
    let changed = false;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= l.w || y >= l.h) continue;
        const i = y * l.w + x;
        const isEnd = allUnits(this.world).some((u) => (x === u.start.x && y === u.start.y) || (x === u.goal.x && y === u.goal.y));
        if (tool === 'wall') {
          if (isEnd || l.blocked[i]) continue;
          l.blocked[i] = 1;
        } else if (tool === 'erase') {
          if (!l.blocked[i] && !l.terrain[i]) continue;
          l.blocked[i] = 0;
          l.terrain[i] = 0;
        } else {
          const t = Number(tool.slice(1));
          if (!l.blocked[i] && l.terrain[i] === t) continue;
          l.blocked[i] = 0;
          l.terrain[i] = t;
        }
        changed = true;
      }
    }
    if (changed) {
      this.world.version = nextVersion();
      this.markChanged({
        x0: Math.max(0, cx - r),
        y0: Math.max(0, cy - r),
        x1: Math.min(l.w - 1, cx + r),
        y1: Math.min(l.h - 1, cy + r),
      });
      this.queueCompute();
    }
  }

  // ---------------- Planning ----------------

  private queueCompute(): void {
    if (this.computeQueued) return;
    this.computeQueued = true;
    requestAnimationFrame(() => {
      this.computeQueued = false;
      if (this.shouldDefer()) {
        // Too slow to replan on every move: update the picture now, replan on release.
        this.deferred = true;
        this.queueDraw();
        return;
      }
      this.recompute();
    });
  }

  /** While painting or dragging, skip replans that would make the pointer lag. */
  private shouldDefer(): boolean {
    const l = this.world.layers[0];
    if (this.stroking && l.w * l.h > LIVE_REPLAN_LIMIT) return true;
    return (this.stroking || this.dragging) && this.lastComputeMs > 120;
  }

  private ensureCaches(): void {
    const layer = this.world.layers[0];
    if (this.clearanceVersion !== this.world.version || this.clearance.length !== layer.w * layer.h) {
      this.clearance = computeClearance(layer);
      this.clearanceVersion = this.world.version;
      this.componentsKey = '';
    }
    const key = `${this.world.version}|${this.s.need}|${this.s.diagonal}`;
    if (key !== this.componentsKey) {
      this.components = computeComponents(layer, this.clearance, this.s.need, this.s.diagonal).labels;
      this.componentsKey = key;
    }
  }

  private recompute(): void {
    const t0 = performance.now();
    this.deferred = false;
    this.recomputeInner();
    this.lastComputeMs = performance.now() - t0;
  }

  private recomputeInner(): void {
    this.ensureCaches();
    const layer = this.world.layers[0];
    const space = new GridSpace(layer, this.clearance, {
      diagonal: this.s.diagonal,
      need: this.s.need,
      useTerrain: this.s.useTerrain,
    });
    const units = allUnits(this.world);
    const structureKey = `${layer.w}x${layer.h}|${this.s.need}|${this.s.diagonal}|${this.s.useTerrain}`;
    for (const lane of this.lanes) {
      const rep = this.s.lanes[lane.index].rep;
      const kind: CachedRep | null = rep === 'grid' ? null : (rep as CachedRep);
      // Units plan one after another on the same planner. Only the first query that
      // reaches the planner sees the pending edits; the rest find the structure up to date.
      const parts: Plan[] = [];
      let consumed = false;
      units.forEach((u, i) => {
        const start = space.id(u.start.x, u.start.y);
        const goal = space.id(u.goal.x, u.goal.y);
        const skip = this.precheck(lane, space, start, goal);
        if (skip) {
          parts.push(skip);
          return;
        }
        const [sh, gh] = this.headings(u);
        const ctx: PlanContext = {
          space,
          start,
          goal,
          changed: consumed || !kind ? 'none' : lane.pending[kind],
          structureKey,
          unitIndex: i,
          startHeading: (sh * Math.PI) / 180,
          goalHeading: (gh * Math.PI) / 180,
        };
        parts.push(this.planLane(lane, ctx));
        consumed = true;
      });
      // Planners that keep caches have now seen the edits; reachability skips don't count.
      if (consumed && kind) lane.pending[kind] = 'none';
      lane.plan = mergePlans(parts, emptyView);
      // (Vehicles price terrain inside their heuristic field, so the note doesn't apply to them.)
      if (space.minCostPerUnit < 1 && lane.plan.status === 'found' && this.s.lanes[lane.index].rep !== 'vehicle')
        lane.plan.messages.push({
          text: `Roads cost ×${space.minCostPerUnit}, so the heuristic is scaled down by that much to stay admissible, and the search explores far more. Turn terrain costs off to compare.`,
          bad: false,
        });
      this.afterPlan(lane);
    }
    this.maxStep = Math.max(0, ...this.lanes.map((l) => l.closeAt.length));
    this.scrub.max = String(this.maxStep);
    this.pause();
    this.seek(this.maxStep);
  }

  private vehicleCfg(cfg: LaneConfig): VehicleLaneConfig {
    return {
      alg: cfg.vAlg,
      vehicle: cfg.vVehicle,
      radius: cfg.vRadius,
      reverse: cfg.vReverse,
      anyHeading: cfg.vAny,
      bins: cfg.vBins,
      shots: cfg.vShots,
      limit: cfg.vLimit,
      iterations: cfg.vIterations,
      seed: cfg.vSeed,
    };
  }

  /** A unit's start and goal headings in degrees; unset ones face along the line from start to goal. */
  private headings(u: { start: Cell; goal: Cell }): [number, number] {
    const line = Math.round((Math.atan2(u.goal.y - u.start.y, u.goal.x - u.start.x) * 180) / Math.PI / 5) * 5;
    const norm = (d: number) => ((d % 360) + 360) % 360;
    return [norm(u.start.heading ?? line), norm(u.goal.heading ?? line)];
  }

  /** A plan explaining why this unit wasn't searched at all, or null to search. */
  private precheck(lane: Lane, space: GridSpace, start: number, goal: number): Plan | null {
    const cfg = this.s.lanes[lane.index];
    // Vehicles check their own footprint at the start and goal.
    if (cfg.rep === 'vehicle') return null;
    const blocked = (text: string, bad: boolean, note: string): Plan => ({
      status: 'unreachable',
      expanded: 0,
      pushes: 0,
      maxOpen: 0,
      rec: new Recorder(true),
      rawPath: [],
      finalPath: [],
      length: NaN,
      cost: NaN,
      queryMs: NaN,
      extra: [],
      messages: [{ text, bad }],
      view: emptyView,
      unitNote: note,
    });
    if (!space.passable(start) || !space.passable(goal)) {
      const which = !space.passable(start) ? 'The start' : 'The goal';
      return blocked(
        `${which} is in a wall or too tight for a ${2 * this.s.need - 1}×${2 * this.s.need - 1} unit (needs clearance ${this.s.need}).`,
        true,
        `${which.slice(4)} is blocked`,
      );
    }
    if (this.s.reachCheck && cfg.rep !== 'navmesh' && this.components[start] !== this.components[goal]) {
      return blocked(
        'Reachability check: start and goal are in different areas for this unit, so no search was run. Turn the check off to watch the search prove it the slow way.',
        false,
        'not searched: different areas',
      );
    }
    return null;
  }

  private planLane(lane: Lane, ctx: PlanContext): Plan {
    const cfg = this.s.lanes[lane.index];
    if (cfg.rep === 'hpa') {
      if (!lane.hpa) lane.hpa = new HpaPlanner();
      return lane.hpa.plan(
        ctx,
        {
          cluster: cfg.cluster,
          lazy: cfg.lazy,
          weight: cfg.hpaWeight,
          heuristic: cfg.heuristic === 'manhattan' ? 'octile' : cfg.heuristic,
          smoothing: cfg.smoothing,
        },
        this.pal,
      );
    }
    if (cfg.rep === 'vehicle') {
      if (!lane.vehicle) lane.vehicle = new VehiclePlanner();
      return lane.vehicle.plan(ctx, this.vehicleCfg(cfg), this.pal, emptyView);
    }
    if (cfg.rep === 'roadmap') {
      if (!lane.roadmap) lane.roadmap = new RoadmapPlanner();
      return lane.roadmap.plan(
        ctx,
        {
          method: cfg.rmMethod,
          samples: cfg.rmSamples,
          iterations: cfg.rmIterations,
          step: cfg.rmStep,
          spacing: cfg.rmSpacing,
          seed: cfg.rmSeed,
          smoothing: cfg.smoothing,
        },
        this.pal,
      );
    }
    if (cfg.rep === 'navmesh') {
      if (!lane.nav) {
        lane.nav = new NavmeshPlanner(() => {
          lane.pending.navmesh = 'all';
          this.queueCompute();
        });
      }
      return lane.nav.plan(ctx, this.world.layers[0], { showDetour: cfg.showDetour, useTerrain: this.s.useTerrain }, this.pal, emptyView);
    }
    return planOnGrid(
      ctx,
      {
        alg: cfg.alg,
        heuristic: cfg.heuristic,
        weight: cfg.weight,
        smoothing: cfg.smoothing,
      },
      this.pal,
    );
  }

  private afterPlan(lane: Lane): void {
    const plan = lane.plan!;
    const n = plan.view.nodeCount;
    if (lane.status.length !== n) {
      lane.status = new Uint8Array(n);
      lane.parent = new Int32Array(n);
      lane.g = new Float32Array(n);
      lane.f = new Float32Array(n);
    }
    lane.applied = -1;
    const d = plan.rec.data;
    let closes = 0;
    for (let k = 0; k < plan.rec.length; k++) if (d[3 * k] === EV_CLOSE) closes++;
    lane.closeAt = new Int32Array(closes);
    for (let k = 0, c = 0; k < plan.rec.length; k++) if (d[3 * k] === EV_CLOSE) lane.closeAt[c++] = k;
    this.fillStats(lane);
    lane.banner.innerHTML = '';
    for (const m of plan.messages) lane.banner.append(h('div', { class: `banner${m.bad ? ' bad' : ''}` }, m.text));
  }

  private fillStats(lane: Lane): void {
    const p = lane.plan!;
    const statusText: Record<string, string> = {
      found: 'Path found',
      noPath: 'No path',
      unreachable: 'Unreachable',
      unusable: 'Not available',
    };
    const stat = (k: string, v: string, cls = '') => h('div', { class: 'stat' }, h('span', { class: 'k' }, k), h('span', { class: `v ${cls}` }, v));
    const multi = p.units.length > 1;
    const found = p.units.filter((u) => u.status === 'found').length;
    const main = multi
      ? h(
          'div',
          { class: 'stats' },
          stat('Result', `${found} of ${p.units.length} found`, found === p.units.length ? 'found' : 'bad'),
          stat('Expanded (all)', fmt(p.expanded)),
          stat('Queued (all)', fmt(p.pushes)),
          stat('Max open', fmt(p.maxOpen)),
          stat('Length (all)', fmt(p.length, 2)),
          stat('Cost (all)', fmt(p.cost, 2)),
          stat('Units', fmt(p.units.length)),
          stat('Query time (all)', fmtTime(p.queryMs)),
        )
      : h(
          'div',
          { class: 'stats' },
          stat('Result', statusText[p.status], p.status === 'found' ? 'found' : 'bad'),
          stat('Expanded', fmt(p.expanded)),
          stat('Queued', fmt(p.pushes)),
          stat('Max open', fmt(p.maxOpen)),
          stat('Length', fmt(p.length, 2)),
          stat('Cost', fmt(p.cost, 2)),
          p.units[0]?.vehicle
            ? stat('Gear changes', fmt(gearChanges(p.units[0].vehicle.poses)))
            : stat('Waypoints', p.units[0]?.finalPath.length ? fmt(p.units[0].finalPath.length) : '—'),
          stat('Query time', fmtTime(p.queryMs)),
        );
    lane.stats.innerHTML = '';
    lane.stats.append(main);
    if (multi) {
      lane.stats.append(h('p', { class: 'sharing' }, this.sharingText(lane)));
      const short: Record<string, string> = {
        found: 'Found',
        noPath: 'No path',
        unreachable: 'Skipped',
        unusable: 'n/a',
      };
      const body = h('tbody');
      p.units.forEach((u, i) =>
        body.append(
          h(
            'tr',
            { 'data-unit': i },
            h(
              'td',
              {},
              h(
                'span',
                {
                  class: 'unit-dot',
                  style: `background:var(${UNIT_COLORS[i]})`,
                },
                String(i + 1),
              ),
            ),
            h('td', { class: u.status === 'found' ? 'found' : 'bad' }, short[u.status]),
            h('td', { class: 'num' }, fmt(u.expanded)),
            h('td', { class: 'num' }, fmt(u.cost, 1)),
            h('td', { class: 'num' }, fmtTime(u.queryMs)),
            h('td', { class: 'note' }, u.note || '—'),
          ),
        ),
      );
      const head = h(
        'tr',
        {},
        ...['Unit', 'Result', 'Expanded', 'Cost', 'Time', 'Reused or built'].map((t, k) => h('th', k >= 2 && k <= 4 ? { style: 'text-align:right' } : {}, t)),
      );
      lane.stats.append(h('div', { class: 'unit-table-wrap' }, h('table', { class: 'unit-table' }, h('thead', {}, head), body)));
    }
    if (p.extra.length) {
      const cells = p.extra.map(([k, v]) => stat(k, v));
      // Fill the last row so the grid has no gaps.
      while (cells.length % 3) cells.push(h('div', { class: 'stat' }));
      lane.stats.append(h('div', { class: 'stats extra' }, ...cells));
    }
    if (p.note) lane.stats.append(h('p', { class: 'extra-note' }, p.note));
  }

  /** One line on what this lane's representation shares between units. */
  private sharingText(lane: Lane): string {
    const cfg = this.s.lanes[lane.index];
    if (cfg.rep === 'grid') return 'Nothing is shared: every unit runs its own search over the cells from scratch, so the total grows with each unit.';
    if (cfg.rep === 'hpa')
      return cfg.lazy
        ? 'Tiles are shared: a unit only builds the tiles no earlier unit has built. Tiles are tinted in the colour of the unit that built them; teal ones were cached before.'
        : 'All tiles were built once up front; every unit just searches the same small door graph.';
    if (cfg.rep === 'navmesh') return 'One navmesh serves every unit of this size: it is built once, then each unit only runs a polygon search.';
    if (cfg.rep === 'vehicle')
      return cfg.vAlg === 'lattice'
        ? 'The motion primitives, and the cells each one sweeps, are built once per vehicle and turning radius and shared by every unit. Each unit still runs its own search, drawn in its colour.'
        : cfg.vAlg === 'rrt'
          ? 'Nothing is shared: every unit grows its own tree of drivable curves and throws it away.'
          : 'Each unit runs its own search (drawn in its colour). Only the distance field is shared, plus the heuristic field when units share a goal: a convoy to one place builds it once.';
    switch (cfg.rmMethod) {
      case 'rrt':
      case 'rrtconnect':
      case 'rrtstar':
        return 'Nothing is shared: every unit grows its own tree from scratch and throws it away. Each tree is drawn separately.';
      case 'shared':
        return 'One graph, grown by every unit: nodes are coloured by the unit that grew them. Later units often join what earlier ones grew and grow little or nothing.';
      case 'lazyprm':
        return 'One roadmap serves every unit. Edges are only checked when a search uses them, and once checked they stay checked for the next unit.';
      default:
        return 'One roadmap serves every unit: each query only connects its start and goal to it and searches.';
    }
  }

  // ---------------- Playback ----------------

  private seek(step: number): void {
    this.step = Math.max(0, Math.min(this.maxStep, step));
    for (const lane of this.lanes) this.applyLane(lane);
    this.scrub.value = String(this.step);
    // Keep any open inspector in step with playback.
    for (const lane of this.lanes) if (lane.hover) this.showInspector(lane);
    this.scrubLbl.innerHTML = '';
    // With several units, say whose search is playing (and mark its row in the table).
    const who: string[] = [];
    for (const lane of this.lanes) {
      const a = this.activeUnit(lane);
      for (const tr of lane.stats.querySelectorAll('tr[data-unit]')) tr.classList.toggle('active', Number((tr as HTMLElement).dataset.unit) === a);
      if (a >= 0) who.push(`${this.lanes.length > 1 ? (lane.index ? 'B: ' : 'A: ') : ''}unit ${a + 1}`);
    }
    this.scrubLbl.append(
      h('span', {}, `Expansion ${fmt(this.step)} of ${fmt(this.maxStep)}${who.length ? ` · ${who.join(' · ')}` : ''}`),
      h('span', { class: 'keys' }, 'space play · ← → step'),
    );
    this.queueDraw();
  }

  /** The unit whose search is playing at the current step, or -1 (single unit, or playback finished). */
  private activeUnit(lane: Lane): number {
    const p = lane.plan;
    if (!p || p.units.length < 2 || lane.applied >= p.rec.length) return -1;
    return p.units.findIndex((u) => u.evEnd > u.evStart && u.evEnd > lane.applied);
  }

  private applyLane(lane: Lane): void {
    const rec = lane.plan?.rec;
    if (!rec) return;
    const target = this.step >= lane.closeAt.length ? rec.length : this.step === 0 ? 0 : lane.closeAt[this.step - 1] + 1;
    if (lane.applied < 0 || target < lane.applied) {
      lane.status.fill(0);
      lane.parent.fill(-1);
      lane.g.fill(NaN);
      lane.f.fill(NaN);
      lane.applied = 0;
    }
    const d = rec.data;
    const gf = rec.gf;
    for (let k = lane.applied; k < target; k++) {
      const kind = d[3 * k];
      const node = d[3 * k + 1];
      if (node < 0 || node >= lane.status.length) continue;
      if (kind === EV_OPEN) {
        lane.status[node] = 1;
        lane.parent[node] = d[3 * k + 2];
        lane.g[node] = gf[2 * k];
        lane.f[node] = gf[2 * k + 1];
      } else if (kind === EV_CLOSE) lane.status[node] = 2;
      else if (kind === EV_SCAN && !lane.status[node]) lane.status[node] = 3;
    }
    lane.applied = target;
    lane.current = this.step > 0 && this.step <= lane.closeAt.length && target < rec.length ? d[3 * lane.closeAt[this.step - 1] + 1] : -1;
  }

  private togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  private play(): void {
    if (this.maxStep === 0) return;
    if (this.step >= this.maxStep) this.seek(0);
    this.playing = true;
    this.playBtn.textContent = '⏸';
    this.playBtn.title = 'Pause (space)';
    this.lastTick = performance.now();
    this.stepBudget = 0;
    requestAnimationFrame((t) => this.tick(t));
  }

  private pause(): void {
    this.playing = false;
    if (this.playBtn) {
      this.playBtn.textContent = '▶';
      this.playBtn.title = 'Play (space)';
    }
  }

  private tick(t: number): void {
    if (!this.playing) return;
    const dt = Math.min(0.1, (t - this.lastTick) / 1000);
    this.lastTick = t;
    this.stepBudget += dt * this.stepsPerSecond();
    const whole = Math.floor(this.stepBudget);
    if (whole > 0) {
      this.stepBudget -= whole;
      this.seek(this.step + whole);
    }
    if (this.step >= this.maxStep) {
      this.pause();
      return;
    }
    requestAnimationFrame((tt) => this.tick(tt));
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    const typing = t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox');
    if (typing || e.ctrlKey || e.metaKey || e.altKey || this.learn.owns(t)) return;
    if (e.key === ' ') {
      e.preventDefault();
      this.togglePlay();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.pause();
      this.seek(this.step + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.pause();
      this.seek(this.step - 1);
    } else if (e.key === 'Home') {
      this.pause();
      this.seek(0);
    } else if (e.key === 'End') {
      this.pause();
      this.seek(this.maxStep);
    } else if (e.key === 'Escape' && this.placing) {
      this.togglePlacing();
      this.queueDraw();
    } else if (e.key === '+' || e.key === '=') this.zoomBy(1.6);
    else if (e.key === '-') this.zoomBy(1 / 1.6);
    else if (e.key === '0') this.fit();
  }

  // ---------------- Drawing ----------------

  private layoutCanvases(): void {
    const l = this.world.layers[0];
    const dpr = window.devicePixelRatio || 1;
    const wrap = this.lanes[0]?.canvas.parentElement;
    const W = Math.max(200, Math.floor(wrap?.clientWidth || 600));
    const maxH = window.innerHeight * (this.s.compare ? 0.52 : 0.64);
    const H = Math.max(160, Math.floor(Math.min(maxH, (W * l.h) / l.w)));
    const prevW = this.cam.W;
    const prevH = this.cam.H;
    this.cam.W = W;
    this.cam.H = H;
    for (const lane of this.lanes) {
      lane.canvas.style.width = `${W}px`;
      lane.canvas.style.height = `${H}px`;
      lane.canvas.width = Math.round(W * dpr);
      lane.canvas.height = Math.round(H * dpr);
    }
    if (this.cam.fitted) this.applyFit();
    else {
      this.cam.ox += (W - prevW) / 2;
      this.cam.oy += (H - prevH) / 2;
    }
    this.queueDraw();
  }

  private queueDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  private draw(): void {
    const l = this.world.layers[0];
    if (this.clearance.length !== l.w * l.h) this.ensureCaches();
    this.images.update(l, this.world.version, this.pal, this.clearance, this.components, this.s.need, this.s.overlays);
    const dpr = window.devicePixelRatio || 1;
    const v = this.viewRect();
    for (const lane of this.lanes) {
      const ctx = lane.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = this.pal.get('--bg');
      ctx.fillRect(0, 0, lane.canvas.width, lane.canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, dpr * this.cam.ox, dpr * this.cam.oy);
      const p = lane.plan;
      const stale = this.stroking || this.deferred;
      const active = this.activeUnit(lane);
      const all = allUnits(this.world);
      const multi = all.length > 1;
      const lcfg = this.s.lanes[lane.index];
      const vcfg = lcfg.rep === 'vehicle' ? lcfg : null;
      const vshape = vcfg ? vehicleShape(this.vehicleCfg(vcfg)) : null;
      const frames: UnitFrame[] = all.map((u, i) => {
        const part = p?.units[i];
        // A unit's path appears once playback has passed the end of its search.
        const show = !stale && !!part && lane.applied >= part.evEnd;
        return {
          start: u.start,
          goal: u.goal,
          color: UNIT_COLORS[i],
          flag: multi ? UNIT_COLORS[i] : '--alert',
          label: multi ? String(i + 1) : 'S',
          numbered: multi,
          rawPath: show ? part.rawPath : null,
          finalPath: show ? part.finalPath : null,
          active: i === active,
          vehicle: vcfg
            ? {
                shape: vshape!,
                startHeading: (this.headings(u)[0] * Math.PI) / 180,
                goalHeading: vcfg.vAny ? null : (this.headings(u)[1] * Math.PI) / 180,
                path: show ? (part.vehicle?.poses ?? null) : null,
                handles: !stale,
              }
            : undefined,
        };
      });
      // A unit being placed: its start so far.
      if (this.placing?.start)
        frames.push({
          start: this.placing.start,
          goal: null,
          color: UNIT_COLORS[all.length],
          flag: UNIT_COLORS[all.length],
          label: String(all.length + 1),
          numbered: true,
          rawPath: null,
          finalPath: null,
          active: true,
        });
      drawFrame(
        ctx,
        v,
        {
          layer: l,
          clearance: this.clearance,
          need: this.s.need,
          overlays: this.s.overlays,
          view: stale ? null : (p?.view ?? null),
          status: stale || !p ? null : lane.status,
          parent: stale || !p ? null : lane.parent,
          current: lane.current,
          units: frames,
        },
        this.images,
        this.pal,
      );
    }
  }
}
