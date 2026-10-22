/**
 * Shared knowledge for adventuring parties: a guild board, and parties that can only read it at waystones.
 *
 * Three levels of blackboard:
 *
 * - guild:      the guild board in the town. Quests (posted, updated, withdrawn), claims, every sighting
 *               and progress report that reached it. Stored as an append-only, versioned log.
 * - party:      the quest the party is on (as far as it knows), what its own adventurers have seen, its
 *               progress. A party at a waystone (or the guild hall) reads the guild log at its head and
 *               posts what it has; between waystones it reads the log as of its watermark.
 * - adventurer: its task within the party and what it has seen itself.
 *
 * Nobody hands out work. The guild clerk edits notices when reports change the picture; each party picks
 * its own quest from the board and heads for the newest place it knows the quarry to be. A party that
 * hasn't passed a waystone since the board changed keeps walking towards the old place.
 *
 * Pure and deterministic (test/lesson-claims.ts checks the lesson's numbers).
 */
import { BUILDING, EYE, STANDING, WATER, los, makeWorld, type P, type TWorld } from '../tactics/world';
import { dijkstra } from '../tactics/analysis';

export const VW = 120;
export const VH = 72;
export const DURATION = 150; // s
export const SIGHT = 40; // m
/** How close a party must come to a waystone to read and post. */
export const REACH = 3; // m
export type Preset = 'simple' | 'full';

export interface Waystone {
  id: string;
  name: string;
  x: number;
  y: number;
}
/** The guild hall counts as a waystone: a party standing at its door reads the board. */
const STONES: Array<Waystone & { full?: boolean }> = [
  { id: 'hall', name: 'the guild hall', x: 22, y: 54 },
  { id: 'crossroads', name: 'the crossroads', x: 40, y: 54 },
  { id: 'bridge', name: 'the old bridge', x: 85, y: 6 },
  { id: 'ford', name: 'the south ford', x: 85, y: 54 },
  { id: 'northroad', name: 'the north road', x: 62, y: 6, full: true },
  { id: 'mill', name: 'the mill', x: 66, y: 54, full: true },
];
export const waystonesFor = (preset: Preset): Waystone[] => STONES.filter((s) => !s.full || preset === 'full');

export interface Place {
  name: string;
  label: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/** Named places, most specific first. */
export const PLACES: Place[] = [
  { name: 'the guild hall', label: 'guild hall', x0: 9, y0: 48, x1: 23, y1: 60 },
  { name: 'the crossroads', label: 'crossroads', x0: 35, y0: 49, x1: 45, y1: 59 },
  { name: 'the old bridge', label: 'old bridge', x0: 82, y0: 1, x1: 95, y1: 11 },
  { name: 'the south ford', label: 'south ford', x0: 82, y0: 49, x1: 95, y1: 59 },
  { name: 'the mill', label: 'mill', x0: 58, y0: 55, x1: 68, y1: 63 },
  { name: 'the south farms', label: 'south farms', x0: 96, y0: 52, x1: 119, y1: 71 },
  { name: 'the north woods', label: 'north woods', x0: 96, y0: 0, x1: 119, y1: 24 },
  { name: 'the east bank', label: 'east bank', x0: 91, y0: 12, x1: 119, y1: 51 },
  { name: 'the north road', label: 'north road', x0: 36, y0: 0, x1: 81, y1: 12 },
  { name: 'the south road', label: 'south road', x0: 46, y0: 50, x1: 81, y1: 64 },
  { name: 'the old forest', label: 'old forest', x0: 43, y0: 10, x1: 87, y1: 49 },
  { name: 'the town', label: 'town', x0: 0, y0: 36, x1: 34, y1: 71 },
];
export function whereIs(x: number, y: number): string {
  return PLACES.find((a) => x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1)?.name ?? 'the countryside';
}

export interface Ground {
  world: TWorld;
  /** Per cell: 1 tree, 2 road, 3 ford, 4 field. Drawing only; the world says what blocks. */
  look: Uint8Array;
}

/** The town in the south-west, a long north road and a short south road round the old forest, a river with an old bridge and a ford, farms beyond. */
export function villageMap(): Ground {
  const t = makeWorld(VW, VH);
  const look = new Uint8Array(VW * VH);
  const box = (x0: number, y0: number, x1: number, y1: number, k: number, l = 0) => {
    for (let y = Math.max(0, y0); y <= Math.min(VH - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(VW - 1, x1); x++) {
        t.kind[y * VW + x] = k;
        look[y * VW + x] = l;
      }
  };
  const tree = (x: number, y: number) => box(x, y, x, y, BUILDING, 1);
  // Fields first, so roads and buildings overwrite them.
  box(98, 57, 119, 71, 0, 4);
  box(4, 4, 30, 26, 0, 4);
  // Roads: the town street, the north and south roads, the east bank track, the farm lane.
  const road = (x0: number, y0: number, x1: number, y1: number) => box(x0, y0, x1, y1, 0, 2);
  road(20, 53, 88, 55);
  road(39, 5, 41, 55);
  road(39, 5, 88, 7);
  road(91, 5, 93, 55);
  road(91, 53, 112, 55);
  road(107, 55, 109, 60);
  // The old forest between the roads, ragged at the edges.
  for (let y = 10; y <= 48; y++)
    for (let x = 43; x <= 87; x++) {
      const edge = Math.min(x - 43, 87 - x, y - 10, 48 - y);
      if (edge < 2 && (x * 7 + y * 13) % 5 < 2) continue;
      if (y > 46 && x > 82) continue;
      tree(x, y);
    }
  // The north woods, east of the river, with a clearing where goblins camp.
  for (let y = 0; y <= 24; y++)
    for (let x = 96; x <= 119; x++) {
      if (y < 9 && x < 100) continue;
      if (Math.hypot(x - 106, y - 11) < 5) continue;
      if ((x * 5 + y * 11) % 7 > 1) tree(x, y);
    }
  // A path from the east bank track into the clearing.
  road(93, 10, 103, 12);
  // The river, crossed by the old bridge in the north and a ford in the south.
  box(88, 0, 90, VH - 1, WATER, 0);
  box(88, 5, 90, 7, 0, 2);
  box(88, 53, 90, 55, 0, 3);
  // The town: the guild hall and houses round the street.
  box(10, 50, 19, 58, BUILDING);
  for (const [x0, y0, x1, y1] of [
    [4, 40, 8, 44],
    [12, 40, 17, 44],
    [23, 40, 28, 45],
    [30, 40, 33, 44],
    [4, 47, 7, 51],
    [4, 57, 8, 62],
    [12, 62, 18, 66],
    [23, 59, 28, 64],
    [30, 59, 33, 63],
  ])
    box(x0, y0, x1, y1, BUILDING);
  // Farmhouse and barn.
  box(102, 64, 107, 68, BUILDING);
  box(113, 63, 117, 69, BUILDING);
  // The mill on the south road.
  box(60, 57, 64, 61, BUILDING);
  return { world: t, look };
}

// ------------------------------------------------------------------------------------------
// Parties, monsters and quests

interface PartyDef {
  name: string;
  /** Quests a party may take: those of this level or lower. */
  level: number;
  start: P[];
}
/** Each adventurer's place in the party: the first walks in front, the others follow. */
export const ROLES = ['front', 'map', 'loot'] as const;
export type Role = (typeof ROLES)[number];

interface MonsterDef {
  id: string;
  kind: 'troll' | 'goblin';
  name: string;
  at: P;
  /** Where it wanders, and when it sets off (s). */
  wander?: { to: P; from: number; speed: number };
  full?: boolean;
}
const MONSTERS: MonsterDef[] = [
  { id: 'troll', kind: 'troll', name: 'the troll', at: { x: 94, y: 6 }, wander: { to: { x: 95, y: 42 }, from: 4, speed: 0.75 } },
  { id: 'gob1', kind: 'goblin', name: 'goblin 1', at: { x: 106, y: 60 } },
  { id: 'gob2', kind: 'goblin', name: 'goblin 2', at: { x: 109, y: 58 } },
  { id: 'gob3', kind: 'goblin', name: 'goblin 3', at: { x: 111, y: 61 } },
  { id: 'gob4', kind: 'goblin', name: 'goblin 4', at: { x: 104, y: 10 }, full: true },
  { id: 'gob5', kind: 'goblin', name: 'goblin 5', at: { x: 108, y: 12 }, full: true },
];

interface QuestDef {
  id: string;
  title: string;
  /** The monsters to deal with; empty for an errand (done on arrival). */
  quarry: string[];
  at: P;
  bounty: number;
  level: number;
  /** Posted at the start, or by the guild when the troll is seen heading for the farms. */
  posted: 'start' | 'trollMoves';
  full?: boolean;
}
const QUESTS: QuestDef[] = [
  { id: 'troll', title: 'Slay the troll', quarry: ['troll'], at: { x: 93, y: 6 }, bounty: 60, level: 3, posted: 'start' },
  { id: 'farms', title: 'Drive the goblins off the south farms', quarry: ['gob1', 'gob2', 'gob3'], at: { x: 108, y: 60 }, bounty: 30, level: 1, posted: 'start' },
  { id: 'woods', title: 'Clear the goblins from the north woods', quarry: ['gob4', 'gob5'], at: { x: 106, y: 11 }, bounty: 25, level: 2, posted: 'start', full: true },
  { id: 'warn', title: 'Warn the mill that the troll is heading south', quarry: [], at: { x: 66, y: 55 }, bounty: 10, level: 1, posted: 'trollMoves', full: true },
];
/** The troll's bounty goes up when it heads for the farms. */
const RAISE = 20;
/** The clerk moves a quest when the quarry is seen this far from where the notice says. */
const MOVED = 12;

function partiesFor(preset: Preset): PartyDef[] {
  const out: PartyDef[] = [
    { name: 'A', level: 2, start: [{ x: 23, y: 53 }, { x: 21, y: 52 }, { x: 24, y: 51 }] },
    { name: 'B', level: 3, start: [{ x: 23, y: 55 }, { x: 21, y: 56 }, { x: 24, y: 57 }] },
  ];
  if (preset === 'full')
    out.push(
      { name: 'C', level: 1, start: [{ x: 20, y: 54 }, { x: 20, y: 52 }, { x: 20, y: 56 }] },
      { name: 'D', level: 2, start: [{ x: 10, y: 69 }, { x: 8, y: 69 }, { x: 6, y: 69 }] },
    );
  return out;
}

// ------------------------------------------------------------------------------------------
// Blackboards

export type Kind = 'quest' | 'claim' | 'sighting' | 'report';

export interface Entry {
  key: string;
  kind: Kind;
  text: string;
  /** When it was true: posted, seen, done. */
  time: number;
  /** Who wrote it: a party's name, or 'guild'. */
  by: string;
  /** Guild log version (0 for entries that haven't reached the log). */
  version: number;
  pos?: P;
  /** Quests: which, the bounty, and whether it's still open. */
  quest?: { id: string; bounty: number; level: number; open: boolean };
  /** Reports: the quest it finishes. */
  done?: string;
}

/** An entry as one blackboard shows it. */
export interface BoardRow extends Entry {
  /** Where this board got it: the guild log, the party's own adventurers, or this adventurer's own eyes or task. */
  from: 'guild' | 'party' | 'own' | 'task';
  /** Changed during this second. */
  fresh: boolean;
}

export interface Task {
  text: string;
  role: Role;
}

export interface AdventurerState {
  name: string;
  party: number;
  role: Role;
  x: number;
  y: number;
  task: Task;
}

export interface MonsterState {
  id: string;
  kind: 'troll' | 'goblin';
  name: string;
  x: number;
  y: number;
  alive: boolean;
}

export interface PartyView {
  name: string;
  watermark: number;
  /** The waystone it's at this second, or null on the road. */
  at: string | null;
  /** When it last read the board. */
  readAt: number;
  /** The quest it's on, the notice's version as it has it, and where it's heading. */
  quest: string | null;
  questText: string;
  questVersion: number;
  goal: P;
  goalWhy: string;
  rows: BoardRow[];
  /** Party entries the guild log doesn't have yet. */
  waiting: number;
  done: boolean;
}

export interface Traffic {
  /** Adventurers who told their party something new this second. */
  told: number[];
  /** Per party: entries posted to the guild log. */
  posted: number[];
  /** Per party: entries it holds back because the board already has something newer (merge by time). */
  older: number[];
  /** Per party: entries waiting for a waystone. */
  waiting: number[];
  /** Entries the guild clerk wrote this second. */
  clerk: number;
  /** Per party: versions it caught up on. */
  caughtUp: number[];
  /** Per party: whether its quest's notice changed in this catch-up. */
  questChanged: boolean[];
  /** Adventurers whose task changed. */
  retasked: number[];
}

export interface VStep {
  t: number;
  adventurers: AdventurerState[];
  monsters: MonsterState[];
  parties: PartyView[];
  /** The guild board at the head, with which parties have read each entry. */
  guild: Array<BoardRow & { readBy: string[]; notReadBy: string[] }>;
  /** Per adventurer: its own board. */
  boards: BoardRow[][];
  head: number;
  /** Records the log keeps, and records in snapshots for parties past the history cap. */
  kept: number;
  snapshots: number;
  traffic: Traffic;
}

export interface VRun {
  preset: Preset;
  ground: Ground;
  waystones: Waystone[];
  parties: Array<{ name: string; level: number }>;
  steps: VStep[];
  /** Every guild entry, in version order. */
  log: Entry[];
}

const SPEED = 1.5; // m/s
const MEET = 3; // m: a party deals with a monster this close

function pathTo(t: TWorld, from: P, to: P): number[] {
  const { prev } = dijkstra(t, from.y * t.w + from.x);
  const out: number[] = [];
  for (let i = to.y * t.w + to.x; i >= 0; i = prev[i]) {
    out.push(i);
    if (i === from.y * t.w + from.x) break;
  }
  return out.reverse();
}

/** Walks a cell path at a speed, carrying the remainder. */
class Walker {
  path: number[] = [];
  pi = 0;
  acc = 0;
  constructor(
    public x: number,
    public y: number,
  ) {}
  go(path: number[]): void {
    this.path = path;
    this.pi = 0;
  }
  step(speed: number, onCell?: (c: number) => void): void {
    if (!this.path.length) return;
    this.acc += speed;
    while (this.pi < this.path.length - 1) {
      const a = this.path[this.pi];
      const b = this.path[this.pi + 1];
      const d = a % VW !== b % VW && Math.floor(a / VW) !== Math.floor(b / VW) ? Math.SQRT2 : 1;
      if (this.acc < d) break;
      this.acc -= d;
      this.pi++;
      this.x = b % VW;
      this.y = Math.floor(b / VW);
      onCell?.(b);
    }
    if (this.pi >= this.path.length - 1) this.acc = 0;
  }
}

const near = (a: P, b: P, r: number) => Math.hypot(a.x - b.x, a.y - b.y) <= r;
/**
 * Whether a party entry is news to the board. Merge by when it was true: something older than the board's
 * newest entry for the key isn't. Nor is a sighting that hasn't moved and is less than 10 s newer.
 */
function worthPosting(e: Entry, have: Entry | undefined): boolean {
  if (!have) return true;
  if (have.time >= e.time) return false;
  if (e.kind === 'sighting' && have.kind === 'sighting' && have.text === e.text && have.pos && e.pos && near(have.pos, e.pos, 3) && e.time - have.time < 10) return false;
  return true;
}
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * Runs the scenario. `bAnywhere` lets party B read and post every second, wherever it is (the comparison
 * case); `cap` limits how many seconds of history the guild log keeps for parties that are behind.
 */
export function runGuild(preset: Preset, bAnywhere = false, cap = Infinity): VRun {
  const ground = villageMap();
  const map = ground.world;
  const stones = waystonesFor(preset);
  const defs = partiesFor(preset);
  const quests = QUESTS.filter((q) => !q.full || preset === 'full');
  const B = defs.findIndex((d) => d.name === 'B');

  // Monsters.
  const monsters = MONSTERS.filter((m) => !m.full || preset === 'full').map((m) => {
    const w = new Walker(m.at.x, m.at.y);
    return { def: m, w, alive: true, started: false };
  });
  const monster = (id: string) => monsters.find((m) => m.def.id === id)!;

  // Adventurers.
  interface Adv {
    name: string;
    party: number;
    role: Role;
    x: number;
    y: number;
    task: Task;
    taskTime: number;
    own: Map<string, Entry>;
  }
  const advs: Adv[] = [];
  defs.forEach((d, p) =>
    d.start.forEach((s, k) => advs.push({ name: `${d.name}${k + 1}`, party: p, role: ROLES[k], x: s.x, y: s.y, task: { text: '', role: ROLES[k] }, taskTime: 0, own: new Map() })),
  );
  const membersOf = (p: number) => advs.filter((a) => a.party === p);

  // Parties.
  interface Party {
    front: Walker;
    trail: number[];
    local: Map<string, Entry>;
    watermark: number;
    readAt: number;
    quest: string | null;
    questVersion: number;
    goal: P;
    goalWhy: string;
    done: boolean;
    home: boolean;
    snapped: boolean;
    /** Entries it found older than the board's, so never posted (counted once). */
    heldBack: Set<string>;
  }
  const hall = stones[0];
  const door: P = { x: hall.x, y: hall.y };
  const parties: Party[] = defs.map((d) => ({
    front: new Walker(d.start[0].x, d.start[0].y),
    trail: [],
    local: new Map(),
    watermark: 0,
    readAt: 0,
    quest: null,
    questVersion: 0,
    goal: { ...d.start[0] },
    goalWhy: '',
    done: false,
    home: true,
    snapped: false,
    heldBack: new Set(),
  }));

  // The guild log.
  const log: Entry[] = [];
  let head = 0;
  const publish = (e: Omit<Entry, 'version'>) => {
    const v = { ...e, version: ++head } as Entry;
    log.push(v);
    return v;
  };
  /** The newest entry per key at or below a version. */
  const view = (v: number) => {
    const m = new Map<string, Entry>();
    for (const e of log) {
      if (e.version > v) break;
      m.set(e.key, e);
    }
    return m;
  };
  const headAt: number[] = [];
  const questText = (q: QuestDef, where: P, raised: boolean) => {
    const place = whereIs(where.x, where.y);
    const verb = q.id === 'troll' ? `${q.title} ${raised ? 'last seen near' : 'at'} ${place}` : q.title;
    return `${verb} · ${q.bounty + (raised ? RAISE : 0)} gold`;
  };
  const postQuest = (q: QuestDef, t: number, where: P, raised = false) =>
    publish({ key: `quest:${q.id}`, kind: 'quest', text: questText(q, where, raised), time: t, by: 'guild', pos: { ...where }, quest: { id: q.id, bounty: q.bounty + (raised ? RAISE : 0), level: q.level, open: true } });
  for (const q of quests) if (q.posted === 'start') postQuest(q, 0, q.at);
  // The quest notices say where the quarry was seen; the troll's notice doubles as a sighting.
  const sightKey = (id: string) => `sighting:${id}`;

  /** A party's board: the guild log as of its watermark (or its snapshot), with its own entries on top, newest wins. */
  const boardOf = (p: number) => {
    const g = view(parties[p].watermark);
    const m = new Map(g);
    for (const [k, e] of parties[p].local) {
      const f = m.get(k);
      if (!f || e.time > f.time || (e.time === f.time && !e.version && e.kind === 'report')) m.set(k, e);
    }
    return { g, m };
  };

  /** Where the party should head for its quest: the newest place it knows the quarry to be. */
  const aim = (p: number, board: Map<string, Entry>): { goal: P; why: string } => {
    const pt = parties[p];
    if (pt.done || !pt.quest) return { goal: door, why: pt.done ? 'back to the guild hall for the bounty' : 'back to the guild hall to read the board' };
    const q = board.get(`quest:${pt.quest}`)!;
    let best: { goal: P; why: string; time: number } = { goal: q.pos!, why: `the notice (${mmssOf(q.time)})`, time: q.time };
    const qd = quests.find((x) => x.id === pt.quest)!;
    for (const id of qd.quarry) {
      const s = board.get(sightKey(id));
      if (s && s.pos && s.time > best.time && !s.text.includes('gone')) best = { goal: s.pos, why: `the sighting of ${monster(id).def.name} at ${mmssOf(s.time)}`, time: s.time };
    }
    return { goal: best.goal, why: best.why };
  };

  /** Each adventurer's task, from the party's quest. */
  const taskFor = (p: number, a: Adv): Task => {
    const pt = parties[p];
    const where = whereIs(pt.goal.x, pt.goal.y);
    if (pt.done || !pt.quest) {
      if (a.role === 'front') return { role: a.role, text: `Lead the way back to the guild hall` };
      if (a.role === 'map') return { role: a.role, text: pt.done ? 'Keep the map; post our report at each waystone' : 'Keep the map; read the board at the hall' };
      return { role: a.role, text: pt.done ? 'Carry the loot home' : 'Carry the packs' };
    }
    const q = quests.find((x) => x.id === pt.quest)!;
    if (a.role === 'front') return { role: a.role, text: `Scout ahead to ${where}` };
    if (a.role === 'map') return { role: a.role, text: `Keep the map; read the board at each waystone` };
    return { role: a.role, text: q.quarry.length ? 'Carry the packs and the loot' : 'Carry the packs' };
  };
  const retask = (p: number, t: number, out: number[]) => {
    for (const a of membersOf(p)) {
      const task = taskFor(p, a);
      if (task.text === a.task.text) continue;
      a.task = task;
      a.taskTime = t;
      out.push(advs.indexOf(a));
    }
  };
  const setGoal = (p: number, g: { goal: P; why: string }, t: number, out: number[]) => {
    const pt = parties[p];
    pt.goalWhy = g.why;
    if (g.goal.x !== pt.goal.x || g.goal.y !== pt.goal.y || !pt.front.path.length) {
      pt.goal = { ...g.goal };
      pt.front.go(pathTo(map, { x: pt.front.x, y: pt.front.y }, pt.goal));
    }
    retask(p, t, out);
  };

  /** A party at a waystone with no quest picks the best open one it can take that nobody has claimed. */
  const choose = (p: number, t: number): boolean => {
    const pt = parties[p];
    const board = boardOf(p).m;
    const open = quests
      .map((q) => ({ q, e: board.get(`quest:${q.id}`) }))
      .filter(({ q, e }) => e?.quest?.open && q.level <= defs[p].level && !board.has(`claim:${q.id}`))
      .sort((a, b) => b.e!.quest!.bounty - a.e!.quest!.bounty);
    if (!open.length) return false;
    const { q } = open[0];
    pt.quest = q.id;
    pt.questVersion = board.get(`quest:${q.id}`)!.version;
    pt.local.set(`claim:${q.id}`, { key: `claim:${q.id}`, kind: 'claim', text: `Party ${defs[p].name} has taken this quest: ${q.title.toLowerCase()}`, time: t, by: defs[p].name, version: 0 });
    pt.home = false;
    return true;
  };

  const steps: VStep[] = [];
  let trollMoves = false;

  for (let t = 0; t <= DURATION; t++) {
    const traffic: Traffic = {
      told: [],
      posted: defs.map(() => 0),
      older: defs.map(() => 0),
      waiting: defs.map(() => 0),
      clerk: 0,
      caughtUp: defs.map(() => 0),
      questChanged: defs.map(() => false),
      retasked: [],
    };
    const changed = new Set<string>(); // "p:key" for party boards, "a:i:key" for adventurers'

    // 1. Move: monsters wander, parties walk (the front on its path, the others along its trail).
    for (const m of monsters) {
      const wd = m.def.wander;
      if (!m.alive || !wd || t < wd.from) continue;
      if (!m.started) ((m.started = true), m.w.go(pathTo(map, m.def.at, wd.to)));
      if (t > 0) m.w.step(wd.speed);
    }
    if (t > 0)
      parties.forEach((pt, p) => {
        pt.front.step(SPEED, (c) => pt.trail.push(c));
        const ms = membersOf(p);
        ms[0].x = pt.front.x;
        ms[0].y = pt.front.y;
        ms.slice(1).forEach((a, j) => {
          const want = pt.trail.length - 1 - 2 * (j + 1);
          if (want < 0) return;
          const at = pt.trail.lastIndexOf(a.y * VW + a.x);
          const next = Math.min(want, at + 2);
          if (next > at && next >= 0) {
            a.x = pt.trail[next] % VW;
            a.y = Math.floor(pt.trail[next] / VW);
          }
        });
      });

    // 2. Deal with monsters: a party on a quest meets its quarry.
    parties.forEach((pt, p) => {
      if (!pt.quest || pt.done) return;
      const q = quests.find((x) => x.id === pt.quest)!;
      for (const id of q.quarry) {
        const m = monster(id);
        if (m.alive && membersOf(p).some((a) => near(a, m.w, MEET))) {
          m.alive = false;
          const key = sightKey(id);
          const e: Entry = { key, kind: 'sighting', text: `${capital(m.def.name)}: gone (${q.id === 'troll' ? 'slain' : 'driven off'})`, time: t, by: defs[p].name, version: 0, pos: { x: m.w.x, y: m.w.y } };
          pt.local.set(key, e);
          changed.add(`${p}:${key}`);
          // The whole party saw it happen.
          for (const a of membersOf(p)) if (a.own.has(key)) (a.own.set(key, e), changed.add(`a:${advs.indexOf(a)}:${key}`));
        }
      }
      const finished = q.quarry.length ? q.quarry.every((id) => !monster(id).alive) : near(pt.front, q.at, 1.5);
      if (finished) {
        pt.done = true;
        const key = `report:${defs[p].name}:${q.id}`;
        const what = q.id === 'troll' ? `the troll is slain, near ${whereIs(pt.front.x, pt.front.y)}` : q.quarry.length ? `${q.title.toLowerCase().replace('drive', 'drove').replace('clear', 'cleared')}` : `${q.title.toLowerCase().replace('warn', 'warned')}`;
        pt.local.set(key, { key, kind: 'report', text: `Party ${defs[p].name}: ${what}`, time: t, by: defs[p].name, version: 0, done: q.id });
        changed.add(`${p}:${key}`);
        setGoal(p, aim(p, boardOf(p).m), t, traffic.retasked);
      }
    });

    // 3. Eyes: every adventurer sees live monsters in range and in line of sight, and tells the party.
    for (const [ai, a] of advs.entries()) {
      let told = false;
      for (const m of monsters) {
        if (!m.alive || !near(a, m.w, SIGHT)) continue;
        if (!los(map, a.x, a.y, m.w.x, m.w.y, EYE, STANDING).clear) continue;
        const key = sightKey(m.def.id);
        const e: Entry = { key, kind: 'sighting', text: `${capital(m.def.name)} near ${whereIs(m.w.x, m.w.y)}`, time: t, by: defs[a.party].name, version: 0, pos: { x: m.w.x, y: m.w.y } };
        a.own.set(key, e);
        changed.add(`a:${ai}:${key}`);
        const pt = parties[a.party];
        const prev = pt.local.get(key);
        if (!prev || prev.time < t) {
          pt.local.set(key, e);
          changed.add(`${a.party}:${key}`);
          told = true;
        }
      }
      if (told) traffic.told.push(ai);
    }

    // 4. Waystones: a party at one posts what the board doesn't have yet. Merge by when it was true:
    // an entry older than the board's newest for its key stays on the party board only.
    const atStone = parties.map((pt, p) => (bAnywhere && p === B ? 'anywhere' : stones.find((s) => near(pt.front, s, REACH))?.name ?? null));
    const post = (p: number) => {
      const latest = view(head);
      for (const e of parties[p].local.values()) {
        const have = latest.get(e.key);
        if (!worthPosting(e, have)) {
          const id = `${e.key}@${e.time}`;
          if (atStone[p] && have && have.time > e.time && !parties[p].heldBack.has(id)) (parties[p].heldBack.add(id), traffic.older[p]++);
          continue;
        }
        if (!atStone[p]) {
          traffic.waiting[p]++;
          continue;
        }
        publish({ ...e, by: defs[p].name });
        traffic.posted[p]++;
      }
    };
    parties.forEach((_, p) => post(p));

    // 5. The guild clerk: moves a notice when its quarry is seen far from where it says, closes it when a
    // report says it's done, and posts new work the reports call for. It edits the board; it sends nobody anywhere.
    {
      const board = view(head);
      for (const q of quests) {
        const n = board.get(`quest:${q.id}`);
        if (!n?.quest?.open) continue;
        const done = [...board.values()].find((e) => e.kind === 'report' && e.done === q.id);
        if (done) {
          publish({ ...n, text: `Withdrawn: ${q.title.toLowerCase()} (done by party ${done.by})`, time: t, by: 'guild', quest: { ...n.quest, open: false } });
          traffic.clerk++;
          continue;
        }
        if (q.id !== 'troll') continue;
        const s = board.get(sightKey('troll'));
        if (s?.pos && s.time > n.time && !near(s.pos, n.pos!, MOVED) && !s.text.includes('gone')) {
          postQuest(q, t, s.pos, true);
          traffic.clerk++;
          if (!trollMoves) {
            trollMoves = true;
            for (const w of quests) if (w.posted === 'trollMoves') (postQuest(w, t, w.at), traffic.clerk++);
          }
        }
      }
    }

    // 6. Catch up: a party at a waystone reads to the head; if its quest's notice changed, it re-plans.
    // Parties go in a fixed order, so a claim one posts is on the board for the next.
    parties.forEach((pt, p) => {
      if (!atStone[p]) return;
      traffic.caughtUp[p] = head - pt.watermark;
      pt.watermark = head;
      pt.readAt = t;
      pt.snapped = false;
      if (pt.quest) {
        const n = view(head).get(`quest:${pt.quest}`)!;
        if (n.version !== pt.questVersion) {
          traffic.questChanged[p] = true;
          pt.questVersion = n.version;
          if (!n.quest!.open && !pt.done) pt.quest = null;
        }
      }
      if (pt.done && near(pt.front, door, REACH)) {
        // Home with the bounty: free for new work.
        pt.done = false;
        pt.quest = null;
      }
      if (!pt.quest && !pt.done && choose(p, t)) {
        post(p);
        traffic.caughtUp[p] += head - pt.watermark;
        pt.watermark = head;
      }
    });

    // 7. Every party heads for the newest place its own board puts its quarry.
    parties.forEach((pt, p) => {
      const was = `${pt.goal.x},${pt.goal.y}`;
      setGoal(p, aim(p, boardOf(p).m), t, traffic.retasked);
      if (was !== `${pt.goal.x},${pt.goal.y}`) changed.add(`${p}:goal`);
    });
    headAt[t] = head;

    // History: the log keeps every entry above the oldest watermark still reading it, plus the newest one
    // per key below it. Past the cap, a party that far behind gets a snapshot and stops holding history.
    let kept = 0;
    let snapshots = 0;
    const capVersion = Number.isFinite(cap) && t - cap >= 0 ? headAt[t - cap] : 0;
    parties.forEach((pt) => {
      if (pt.watermark < capVersion) pt.snapped = true;
    });
    for (const pt of parties) if (pt.snapped) snapshots += view(pt.watermark).size;
    const minWm = Math.min(head, ...parties.filter((pt) => !pt.snapped).map((pt) => pt.watermark));
    const newestBelow = new Set<string>();
    for (let k = log.length - 1; k >= 0; k--) {
      const e = log[k];
      if (e.version > minWm) kept++;
      else if (!newestBelow.has(e.key)) (newestBelow.add(e.key), kept++);
    }

    // Record the boards for the widget.
    const prevStep = t ? steps[t - 1] : null;
    const guild = [...view(head).values()].map((e) => ({
      ...e,
      from: 'guild' as const,
      fresh: e.version > (prevStep?.head ?? 0),
      readBy: defs.filter((_, p) => parties[p].watermark >= e.version).map((d) => d.name),
      notReadBy: defs.filter((_, p) => parties[p].watermark < e.version).map((d) => d.name),
    }));
    const views: PartyView[] = parties.map((pt, p) => {
      const { g, m } = boardOf(p);
      const rows: BoardRow[] = [...m.values()].map((e) => {
        const fromGuild = g.get(e.key) === e;
        return { ...e, from: fromGuild ? 'guild' : 'party', fresh: changed.has(`${p}:${e.key}`) || (fromGuild && e.version > (prevStep?.parties[p].watermark ?? 0)) };
      });
      const latest = view(head);
      let waiting = 0;
      for (const e of pt.local.values()) {
        const have = latest.get(e.key);
        if (worthPosting(e, have)) waiting++;
      }
      const qn = pt.quest ? m.get(`quest:${pt.quest}`) : undefined;
      return {
        name: defs[p].name,
        watermark: pt.watermark,
        at: atStone[p],
        readAt: pt.readAt,
        quest: pt.quest,
        questText: pt.done ? 'Done: heading home for the bounty' : qn ? qn.text : atStone[p] === hall.name ? 'No quest: waiting at the guild hall for work' : 'No quest: heading for the guild hall',
        questVersion: pt.questVersion,
        goal: { ...pt.goal },
        goalWhy: pt.goalWhy,
        rows,
        waiting,
        done: pt.done,
      };
    });
    const boards = advs.map((a, ai) => [
      { key: 'task', kind: 'claim' as Kind, text: a.task.text, time: a.taskTime, by: defs[a.party].name, version: 0, from: 'task' as const, fresh: traffic.retasked.includes(ai) },
      ...[...a.own.values()].sort((x, y) => y.time - x.time).map((e) => ({ ...e, from: 'own' as const, fresh: changed.has(`a:${ai}:${e.key}`) })),
    ]);
    steps.push({
      t,
      adventurers: advs.map((a) => ({ name: a.name, party: a.party, role: a.role, x: a.x, y: a.y, task: { ...a.task } })),
      monsters: monsters.map((m) => ({ id: m.def.id, kind: m.def.kind, name: m.def.name, x: m.w.x, y: m.w.y, alive: m.alive })),
      parties: views,
      guild,
      boards,
      head,
      kept,
      snapshots,
      traffic,
    });
  }
  return { preset, ground, waystones: stones, parties: defs.map((d) => ({ name: d.name, level: d.level })), steps, log };
}

export const mmssOf = (t: number) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;

// ------------------------------------------------------------------------------------------
// Measurements the lesson quotes

/** The first second a party's watermark covers a version (-1 if never). */
export function readAt(run: VRun, party: string, version: number): number {
  const p = run.parties.findIndex((q) => q.name === party);
  return run.steps.findIndex((s) => s.parties[p].watermark >= version);
}

/** The guild entries for a key, in version order. */
export const versionsOf = (run: VRun, key: string) => run.log.filter((e) => e.key === key);

/**
 * Seconds a party spent heading for a notice the guild had already replaced: from the first change to its
 * quest's notice until the party read it.
 */
export function staleSeconds(run: VRun, party: string, quest: string): number {
  const changes = versionsOf(run, `quest:${quest}`).slice(1);
  if (!changes.length) return 0;
  return readAt(run, party, changes[0].version) - changes[0].time;
}
