/**
 * A small, deterministic arena shared by every AI lesson.
 *
 * One agent (the AI being studied) fights waves of simple scripted enemies.
 * The agent (a battle-mage) has health, a staff with charges and spare crystals, can carry one potion, and
 * can stand behind crates for cover. The *brain* only picks which action to
 * run each tick; the actions themselves (moving, shooting, recharging, healing)
 * are shared, so different brains can be compared fairly.
 *
 * Everything runs at a fixed 10 ticks per second from a seeded generator, so
 * the same seed and the same brain always replay identically.
 */

export const TICK_HZ = 10;
export const W = 36;
export const H = 22;

export type ActionId = 'attack' | 'cover' | 'recharge' | 'heal' | 'potion' | 'crystals' | 'patrol';
export const ACTIONS: ActionId[] = ['attack', 'cover', 'recharge', 'heal', 'potion', 'crystals', 'patrol'];
export const ACTION_NAMES: Record<ActionId, string> = {
  attack: 'Attack',
  cover: 'Take cover',
  recharge: 'Recharge',
  heal: 'Heal',
  potion: 'Get potion',
  crystals: 'Get crystals',
  patrol: 'Patrol',
};
/** Theme colour token per action (charts, timelines). */
export const ACTION_COL: Record<ActionId, string> = {
  attack: '--c3',
  cover: '--c2',
  recharge: '--c1',
  heal: '--c4',
  potion: '--c5',
  crystals: '--c6',
  patrol: '--c8',
};

export const CHARGES = 6;
export const RESERVE_MAX = 24;
export const RANGE = 12;
const ENEMY_RANGE = 10;
const RECHARGE_TICKS = 15;
const HEAL_TICKS = 20;
const HEAL_AMOUNT = 60;
const POTION_RESPAWN = 200;
const AGENT_SPEED = 3.2 / TICK_HZ;
const ENEMY_SPEED = 1.6 / TICK_HZ;

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Vec {
  x: number;
  y: number;
}
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

export interface Enemy extends Vec {
  id: number;
  hp: number;
  cd: number;
}
export interface Shot {
  from: Vec;
  to: Vec;
  hit: boolean;
  enemy: boolean;
  age: number;
}

export interface Agent extends Vec {
  hp: number;
  charges: number;
  reserve: number;
  potions: number;
  action: ActionId;
  /** Ticks the current action has been running. */
  actionTicks: number;
  rechargeT: number;
  healT: number;
  cd: number;
  /** The action that finished on the last tick (recharge done, potion used), for trees and planners. */
  completed: ActionId | null;
  waypoint: number;
}

/** What a brain sees: plain numbers, computed once per tick. */
export interface Factors {
  health: number; // 0..100
  charges: number; // 0..CHARGES
  reserve: number; // 0..RESERVE_MAX
  potions: number; // 0..1
  potionAvailable: number; // 1 if the station has one
  enemies: number; // alive enemies
  enemyDist: number; // to the nearest enemy (99 if none)
  damageTaken: number; // in the last 2 s
  inCover: number; // 0 or 1
  exposed: number; // 1 if enemies are around and we're not in cover
  coverDist: number; // to the nearest cover spot facing the enemy
  crystalDist: number;
  potionDist: number;
  recharging: number; // progress 0..1 (0 when not recharging)
  healing: number; // progress 0..1
}

export const CRATES: Vec[] = [
  { x: 9, y: 6 },
  { x: 10, y: 16 },
  { x: 18, y: 11 },
  { x: 26, y: 5.5 },
  { x: 27, y: 16.5 },
  { x: 15, y: 3 },
  { x: 21, y: 19 },
];
export const CRATE_R = 0.9;
export const CRYSTALS: Vec = { x: 3, y: 19 };
export const POTION: Vec = { x: 3, y: 3 };
const PATROL: Vec[] = [
  { x: 6, y: 11 },
  { x: 13, y: 8 },
  { x: 13, y: 14 },
  { x: 6, y: 15 },
];

export interface Stats {
  kills: number;
  damageTaken: number;
  switches: number;
  wasted: number; // recharge / heal progress thrown away by switching
  shots: number;
  ticks: number;
  timeIn: Record<ActionId, number>;
}

export class World {
  tick = 0;
  agent: Agent;
  enemies: Enemy[] = [];
  shots: Shot[] = [];
  /** For drawing: positions before the last tick, by enemy id (-1 is the agent). */
  prev = new Map<number, Vec>();
  potionReady = true;
  potionTimer = 0;
  wave = 0;
  waveTimer = 20;
  dead = false;
  stats: Stats;
  private nextId = 1;
  private r: () => number;
  private hits: Array<{ t: number; dmg: number }> = [];

  constructor(public seed = 1) {
    this.r = rng(seed);
    this.agent = {
      x: 6,
      y: 11,
      hp: 100,
      charges: CHARGES,
      reserve: 12,
      potions: 1,
      action: 'patrol',
      actionTicks: 0,
      rechargeT: 0,
      healT: 0,
      cd: 0,
      completed: null,
      waypoint: 0,
    };
    this.stats = { kills: 0, damageTaken: 0, switches: 0, wasted: 0, shots: 0, ticks: 0, timeIn: { attack: 0, cover: 0, recharge: 0, heal: 0, potion: 0, crystals: 0, patrol: 0 } };
  }

  get seconds(): number {
    return this.tick / TICK_HZ;
  }

  nearestEnemy(p: Vec = this.agent): Enemy | null {
    let best: Enemy | null = null;
    let bd = Infinity;
    for (const e of this.enemies) {
      const d = dist(p, e);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  /** Where to stand behind each crate, relative to the enemies' centre. */
  coverSpot(): Vec | null {
    if (!this.enemies.length) return null;
    const cx = this.enemies.reduce((s, e) => s + e.x, 0) / this.enemies.length;
    const cy = this.enemies.reduce((s, e) => s + e.y, 0) / this.enemies.length;
    let best: Vec | null = null;
    let bd = Infinity;
    for (const c of CRATES) {
      const dx = c.x - cx;
      const dy = c.y - cy;
      const l = Math.hypot(dx, dy) || 1;
      if (l < 3) continue; // the enemies are on top of it
      const p = { x: c.x + (dx / l) * 1.5, y: c.y + (dy / l) * 1.5 };
      // Prefer close spots that keep the enemy in range.
      const d = dist(this.agent, p) + Math.max(0, l - RANGE) * 0.8;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  /** Is p shielded from the shooter at s by a crate close to p? */
  covered(p: Vec, s: Vec): boolean {
    for (const c of CRATES) {
      const dc = dist(p, c);
      if (dc > 2.1) continue;
      // The crate must lie roughly between p and the shooter.
      const ax = s.x - p.x;
      const ay = s.y - p.y;
      const bx = c.x - p.x;
      const by = c.y - p.y;
      const cos = (ax * bx + ay * by) / ((Math.hypot(ax, ay) || 1) * (dc || 1));
      if (cos > 0.55) return true;
    }
    return false;
  }

  inCover(): boolean {
    const e = this.nearestEnemy();
    return !!e && this.covered(this.agent, e);
  }

  factors(): Factors {
    const a = this.agent;
    const e = this.nearestEnemy();
    const cs = this.coverSpot();
    return {
      health: a.hp,
      charges: a.charges,
      reserve: a.reserve,
      potions: a.potions,
      potionAvailable: this.potionReady ? 1 : 0,
      enemies: this.enemies.length,
      enemyDist: e ? dist(a, e) : 99,
      damageTaken: this.hits.reduce((s, x) => s + x.dmg, 0),
      inCover: this.inCover() ? 1 : 0,
      exposed: e && !this.inCover() ? 1 : 0,
      coverDist: cs ? dist(a, cs) : 99,
      crystalDist: dist(a, CRYSTALS),
      potionDist: dist(a, POTION),
      recharging: a.rechargeT / RECHARGE_TICKS,
      healing: a.healT / HEAL_TICKS,
    };
  }

  // -------------------------------------------------------------------------

  private moveToward(p: Vec, t: Vec, speed: number): boolean {
    const d = dist(p, t);
    if (d <= speed) {
      p.x = t.x;
      p.y = t.y;
      return true;
    }
    p.x += ((t.x - p.x) / d) * speed;
    p.y += ((t.y - p.y) / d) * speed;
    this.pushOut(p);
    return false;
  }
  private pushOut(p: Vec): void {
    for (const c of CRATES) {
      const d = dist(p, c);
      const min = CRATE_R + 0.35;
      if (d < min && d > 1e-6) {
        p.x = c.x + ((p.x - c.x) / d) * min;
        p.y = c.y + ((p.y - c.y) / d) * min;
      }
    }
    p.x = Math.min(W - 0.5, Math.max(0.5, p.x));
    p.y = Math.min(H - 0.5, Math.max(0.5, p.y));
  }

  private agentShoot(): void {
    const a = this.agent;
    const e = this.nearestEnemy();
    if (!e || a.charges <= 0 || a.cd > 0) return;
    const d = dist(a, e);
    if (d > RANGE) return;
    a.charges--;
    a.cd = 5;
    this.stats.shots++;
    const hit = this.r() < 0.9 - d * 0.03;
    this.shots.push({ from: { x: a.x, y: a.y }, to: { x: e.x, y: e.y }, hit, enemy: false, age: 0 });
    if (hit) {
      e.hp -= 20;
      if (e.hp <= 0) {
        this.enemies = this.enemies.filter((x) => x !== e);
        this.stats.kills++;
      }
    }
  }

  /** Run one tick with the action the brain chose. */
  step(choice: ActionId): void {
    if (this.dead) return;
    const a = this.agent;
    // For drawing only: where everyone was before this tick, so the canvas can move them smoothly.
    this.prev = new Map([[-1, { x: a.x, y: a.y }], ...this.enemies.map((e) => [e.id, { x: e.x, y: e.y }] as [number, Vec])]);
    a.completed = null;
    if (choice !== a.action) {
      if (a.rechargeT > 0 || a.healT > 0) this.stats.wasted++;
      a.rechargeT = 0;
      a.healT = 0;
      a.action = choice;
      a.actionTicks = 0;
      this.stats.switches++;
    }
    a.actionTicks++;
    this.stats.timeIn[choice]++;
    if (a.cd > 0) a.cd--;

    switch (choice) {
      case 'attack': {
        const e = this.nearestEnemy();
        if (e) {
          if (dist(a, e) > RANGE * 0.85) this.moveToward(a, e, AGENT_SPEED);
          else this.agentShoot();
        }
        break;
      }
      case 'cover': {
        const p = this.coverSpot();
        if (p) this.moveToward(a, p, AGENT_SPEED);
        break;
      }
      case 'recharge':
        if (a.charges < CHARGES && a.reserve > 0) {
          a.rechargeT++;
          if (a.rechargeT >= RECHARGE_TICKS) {
            const n = Math.min(CHARGES - a.charges, a.reserve);
            a.charges += n;
            a.reserve -= n;
            a.rechargeT = 0;
            a.completed = 'recharge';
          }
        }
        break;
      case 'heal':
        if (a.potions > 0) {
          a.healT++;
          if (a.healT >= HEAL_TICKS) {
            a.hp = Math.min(100, a.hp + HEAL_AMOUNT);
            a.potions--;
            a.healT = 0;
            a.completed = 'heal';
          }
        }
        break;
      case 'potion':
        if (this.potionReady) this.moveToward(a, POTION, AGENT_SPEED);
        break;
      case 'crystals':
        this.moveToward(a, CRYSTALS, AGENT_SPEED);
        break;
      case 'patrol':
        if (this.moveToward(a, PATROL[a.waypoint], AGENT_SPEED * 0.6)) {
          a.waypoint = (a.waypoint + 1) % PATROL.length;
          a.completed = 'patrol';
        }
        break;
    }
    // Pickups happen by walking over them, whatever the action.
    if (dist(a, CRYSTALS) < 1 && a.reserve < RESERVE_MAX) {
      a.reserve = RESERVE_MAX;
      if (choice === 'crystals') a.completed = 'crystals';
    }
    if (this.potionReady && a.potions < 1 && dist(a, POTION) < 1) {
      a.potions = 1;
      if (choice === 'potion') a.completed = 'potion';
      this.potionReady = false;
      this.potionTimer = POTION_RESPAWN;
    }
    if (!this.potionReady && --this.potionTimer <= 0) this.potionReady = true;

    this.stepEnemies();
    this.shots.forEach((s) => s.age++);
    this.shots = this.shots.filter((s) => s.age < 6); // drawing only: long enough for a missile to land
    this.hits = this.hits.filter((x) => x.t > this.tick - 2 * TICK_HZ);
    this.tick++;
    this.stats.ticks++;
    if (a.hp <= 0) {
      a.hp = 0;
      this.dead = true;
    }
  }

  private stepEnemies(): void {
    const a = this.agent;
    if (!this.enemies.length && --this.waveTimer <= 0) {
      this.wave++;
      const n = Math.min(4, 1 + Math.floor(this.wave / 2));
      for (let i = 0; i < n; i++) {
        const side = this.r();
        this.enemies.push({ id: this.nextId++, x: W - 1 - this.r() * 2, y: 2 + side * (H - 4), hp: 60, cd: 10 + Math.floor(this.r() * 10) });
      }
      this.waveTimer = 50;
    }
    for (const e of this.enemies) {
      const d = dist(e, a);
      if (e.cd > 0) e.cd--;
      if (d > ENEMY_RANGE * 0.8) this.moveToward(e, a, ENEMY_SPEED);
      else if (e.cd === 0) {
        e.cd = 10;
        const cover = this.covered(a, e);
        const hit = this.r() < (0.7 - d * 0.025) * (cover ? 0.25 : 1);
        this.shots.push({ from: { x: e.x, y: e.y }, to: { x: a.x, y: a.y }, hit, enemy: true, age: 0 });
        if (hit) {
          a.hp -= 9;
          this.stats.damageTaken += 9;
          this.hits.push({ t: this.tick, dmg: 9 });
        }
      }
    }
  }
}
