/**
 * A party of five against a boss: a tank, a cleric who heals, and three damage dealers
 * (a knight, a crossbow knight and a battle-mage) against an orc warchief. The boss keeps a
 * threat table, telegraphs its big attacks and calls goblin archers at half health. Each part
 * of the party AI can be switched to a naive version to see what it is for. Deterministic,
 * 10 Hz, no DOM; the widget is in viz.ts and test/party-batch.ts measures it.
 */

export const AW = 40; // arena, metres
export const AH = 24;
export const TICK_HZ = 10;
const DT = 1 / TICK_HZ;
const T = (s: number) => Math.round(s * TICK_HZ);

/** How the boss (and its adds) picks who to hit. */
export type Targeting = 'nearest' | 'top' | 'margin';
/** How the cleric picks who to heal. */
export type HealPolicy = 'lowest' | 'triage';
/** How the damage dealers pick what to hit, and whether they mind their threat. */
export type DpsPolicy = 'nuke' | 'careful';

export interface BossSettings {
  targeting: Targeting;
  heal: HealPolicy;
  dps: DpsPolicy;
  /** Units read the telegraphs and leave the marked area. */
  dodge: boolean;
  seed: number;
}
export const BOSS_DEFAULTS: BossSettings = { targeting: 'margin', heal: 'triage', dps: 'careful', dodge: true, seed: 1 };

export type Role = 'tank' | 'healer' | 'damage';
export type Look = 'knight' | 'crossbow' | 'mage';

// The pull rule: a new member takes the boss only past 110% of the current target's threat in
// melee range, 130% at range.
export const MELEE_MARGIN = 1.1;
export const RANGED_MARGIN = 1.3;
const MELEE_RANGE = 4;
/** The tank's threat multiplier, and healing's: half a point per point healed, split over the enemies. */
export const TANK_THREAT = 2.5;
export const HEAL_THREAT = 0.5;
export const TAUNT_COOLDOWN = 8;
const TAUNT_REACTION = 0.8;
/** Damage per second the cleric assumes even for someone nothing is hitting. */
export const RATE_FLOOR = 80;
/** The cleric's priorities by role, and the share of mana below which it gets frugal. */
export const ROLE_WEIGHT: Record<Role, number> = { tank: 1.3, healer: 1.15, damage: 1 };
export const LOW_MANA = 0.3;
/** How far from the boss the cleric and the ranged damage dealers stand, and the angle between them. */
export const CLERIC_DISTANCE = 10;
export const RANGED_DISTANCE = 12;
export const RANGED_SPREAD = 0.75;
export const STEER_DIRECTIONS = 16;
const TAUNT_FORCE = 3;
/** Careful damage dealers stop at this share of what would pull the boss. */
export const HOLD_AT = 0.9;
export const ENRAGE = 150;
/** The warchief's numbers: raw damage (before armour) and seconds between uses. */
export const BOSS = { hp: 30000, swing: 1000, cleave: 700, slam: 750, cry: 320, cryEvery: 15, cleaveEvery: 9, slamEvery: 11, shoveEvery: 20, addHp: 900, arrow: 260, mana: 3500, regen: 12, cleaveWarn: 1.5, cleaveRadius: 7, slamWarn: 2, slamRadius: 4.5 };
const LIMIT = 200;
const SPEED = 0.45; // metres per tick
const BOSS_SPEED = 0.3;

export interface Member {
  id: number;
  name: string;
  role: Role;
  look: Look;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  /** Share of raw damage taken (armour). */
  armour: number;
  alive: boolean;
  /** Damage per attack, seconds between attacks, reach in metres, missile. */
  dmg: number;
  period: number;
  reach: number;
  missile: 'bolt' | 'spell' | null;
  threatMul: number;
  timer: number;
  /** Enemy index being attacked, or -1. */
  target: number;
  /** Incoming damage per second, smoothed over about three seconds. */
  rate: number;
  /** Holding back to stay under the boss's pull threshold. */
  holding: boolean;
  moved: boolean;
  dodging: boolean;
  /** Damage taken this fight. */
  taken: number;
}

export interface Enemy {
  boss: boolean;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** Threat per party member. */
  threat: number[];
  target: number;
  /** Ticks left of a taunt that forces the target. */
  forced: number;
  facing: number;
  timer: number;
  /** Ticks the boss stands still (winding up, or after a shove). */
  busy: number;
}

export interface Telegraph {
  kind: 'slam' | 'cleave';
  x: number;
  y: number;
  r: number;
  dir: number;
  half: number;
  start: number;
  end: number;
}

export type Spell = 'flash' | 'greater';
export const SPELLS: Record<Spell, { name: string; cast: number; heal: number; mana: number }> = {
  flash: { name: 'Quick heal', cast: 1, heal: 520, mana: 90 },
  greater: { name: 'Great heal', cast: 2.5, heal: 1100, mana: 100 },
};
export interface Cast {
  target: number;
  spell: Spell;
  start: number;
  end: number;
  score: number;
}

export type FightEvent =
  | { t: 'shot'; kind: 'bolt' | 'spell' | 'arrow'; x0: number; y0: number; x1: number; y1: number }
  | { t: 'swing'; x: number; y: number; dir: number; big: boolean }
  | { t: 'heal'; who: number; amount: number }
  | { t: 'hurt'; who: number; amount: number }
  | { t: 'boom'; tg: Telegraph }
  | { t: 'cry'; x: number; y: number }
  | { t: 'say'; x: number; y: number; text: string };

export interface FightStats {
  time: number;
  done: boolean;
  won: boolean;
  deaths: Record<Role, number>;
  /** Damage taken by everyone but the tank. */
  nonTank: number;
  /** Times the boss changed target. */
  switches: number;
  /** Seconds the boss spent hitting someone other than the tank. */
  offTank: number;
  healed: number;
  overheal: number;
  /** Times a telegraphed attack hit someone it didn't need to (not the tank in a cleave). */
  caught: number;
  taunts: number;
  manaLeft: number;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const angDiff = (a: number, b: number) => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function inside(g: Telegraph, x: number, y: number): boolean {
  return depth(g, x, y) > 0;
}

/** How far inside a telegraph a point is: 0 outside, up to 1 at its heart. */
export function depth(g: Telegraph, x: number, y: number): number {
  const d = Math.hypot(x - g.x, y - g.y);
  if (d > g.r) return 0;
  const radial = 1 - d / g.r;
  if (g.kind === 'slam' || d < 1.2) return Math.max(radial, 1e-3);
  const a = Math.abs(angDiff(Math.atan2(y - g.y, x - g.x), g.dir));
  if (a > g.half) return 0;
  return Math.max(Math.min(radial, ((g.half - a) * d) / g.r), 1e-3);
}

/** One candidate the cleric weighed: who, with which spell, how much would land, and the score. */
export interface HealOption {
  who: number;
  spell: Spell;
  score: number;
  effective: number;
}

export class BossFight {
  members: Member[];
  enemies: Enemy[];
  telegraphs: Telegraph[] = [];
  events: FightEvent[] = [];
  tick = 0;
  mana = BOSS.mana;
  readonly maxMana = BOSS.mana;
  cast: Cast | null = null;
  /** The cleric's best option for each member at its last decision (score 0 if nothing worth casting). */
  options: HealOption[] = [];
  tauntReady = 0;
  stats: FightStats = { time: 0, done: false, won: false, deaths: { tank: 0, healer: 0, damage: 0 }, nonTank: 0, switches: 0, offTank: 0, healed: 0, overheal: 0, caught: 0, taunts: 0, manaLeft: 0 };
  /** The direction from the boss to the party's side: west. The tank keeps the boss facing east. */
  readonly side = Math.PI;
  /** Tick each enemy started hitting someone other than the tank (the tank reacts after a moment). */
  private lostAt: number[] = [];
  private r: () => number;
  private nextCleave = T(8);
  private nextSlam = T(12);
  private nextShove = T(18);
  private nextCry = T(6);
  private addsCalled = false;

  constructor(public s: BossSettings) {
    this.r = rng(s.seed * 7919 + 17);
    const j = () => (this.r() - 0.5) * 2;
    const mk = (id: number, name: string, role: Role, look: Look, x: number, y: number, maxHp: number, armour: number, dmg: number, period: number, reach: number, missile: Member['missile'], threatMul = 1): Member => ({
      id, name, role, look, x: x + j(), y: y + j() * 2, hp: maxHp, maxHp, armour, alive: true, dmg, period, reach, missile, threatMul,
      timer: T(period * this.r()), target: 0, rate: 0, holding: false, moved: false, dodging: false, taken: 0,
    });
    this.members = [
      mk(0, 'Tank', 'tank', 'knight', 9, 12, 2400, 0.4, 105, 1.5, 3.6, null, TANK_THREAT),
      mk(1, 'Cleric', 'healer', 'mage', 4, 12, 1150, 1, 0, 1, 0, null),
      mk(2, 'Knight', 'damage', 'knight', 6, 8, 1300, 0.8, 150, 1, 3.6, null),
      mk(3, 'Crossbow', 'damage', 'crossbow', 5, 16, 1200, 1, 240, 1.6, 15, 'bolt'),
      mk(4, 'Mage', 'damage', 'mage', 3, 18, 1100, 1, 380, 2.2, 15, 'spell'),
    ];
    this.enemies = [this.enemy(true, 25, 12, BOSS.hp)];
  }

  private enemy(boss: boolean, x: number, y: number, hp: number): Enemy {
    return { boss, x, y, hp, maxHp: hp, alive: true, threat: this.members.map(() => 0), target: -1, forced: 0, facing: Math.PI, timer: 0, busy: 0 };
  }

  get boss(): Enemy {
    return this.enemies[0];
  }

  // ---------------------------------------------------------------------------------------
  // Damage, healing and threat

  private hurt(m: Member, raw: number): void {
    if (!m.alive) return;
    const enraged = this.tick >= T(ENRAGE) ? 4 : 1;
    const dmg = Math.round(raw * m.armour * enraged * (0.9 + 0.2 * this.r()));
    m.hp -= dmg;
    m.taken += dmg;
    m.rate += dmg / 3; // decays with a 3 s time constant, so this reads as damage per second
    if (m.role !== 'tank') this.stats.nonTank += dmg;
    this.events.push({ t: 'hurt', who: m.id, amount: dmg });
    if (m.hp <= 0) {
      m.hp = 0;
      m.alive = false;
      this.stats.deaths[m.role]++;
      if (this.cast && (this.cast.target === m.id || m.role === 'healer')) this.cast = null;
      for (const e of this.enemies) e.threat[m.id] = 0;
    }
  }

  private damage(e: Enemy, m: Member, amount: number): void {
    e.hp -= amount;
    e.threat[m.id] += amount * m.threatMul;
    if (e.hp <= 0) {
      e.hp = 0;
      e.alive = false;
      this.telegraphs = this.telegraphs.filter(() => !e.boss);
    }
  }

  private heal(m: Member, amount: number): void {
    const effective = Math.min(amount, m.maxHp - m.hp);
    m.hp += effective;
    this.stats.healed += amount;
    this.stats.overheal += amount - effective;
    this.events.push({ t: 'heal', who: m.id, amount: effective });
    // Healing threat: half a point per point of effective healing, shared by every enemy in the fight.
    const live = this.enemies.filter((e) => e.alive);
    for (const e of live) e.threat[1] += (effective * HEAL_THREAT) / live.length;
  }

  // ---------------------------------------------------------------------------------------
  // The boss and its adds

  /** Who this enemy should be hitting under the current rule. */
  private pick(e: Enemy): number {
    const live = this.members.filter((m) => m.alive);
    if (!live.length) return -1;
    const cur = e.target >= 0 && this.members[e.target].alive ? e.target : -1;
    if (cur >= 0 && e.forced > 0) return cur;
    if (this.s.targeting === 'nearest') {
      // Only once someone has started the fight.
      if (cur < 0 && !e.threat.some((v) => v > 0)) return -1;
      return live.reduce((a, b) => (Math.hypot(b.x - e.x, b.y - e.y) < Math.hypot(a.x - e.x, a.y - e.y) ? b : a)).id;
    }
    const top = live.reduce((a, b) => (e.threat[b.id] > e.threat[a.id] ? b : a));
    if (e.threat[top.id] <= 0) return cur;
    if (cur < 0) return top.id;
    if (this.s.targeting === 'top') return e.threat[top.id] > e.threat[cur] ? top.id : cur;
    // 110% in melee range, 130% at range.
    const margin = Math.hypot(top.x - e.x, top.y - e.y) <= MELEE_RANGE ? MELEE_MARGIN : RANGED_MARGIN;
    return e.threat[top.id] > e.threat[cur] * margin ? top.id : cur;
  }

  private stepEnemy(e: Enemy, ei: number): void {
    if (e.forced > 0) e.forced--;
    const next = this.pick(e);
    if (next !== e.target) {
      if (e.boss && e.target >= 0 && next >= 0) this.stats.switches++;
      e.target = next;
    }
    if (e.target < 0) return;
    const m = this.members[e.target];
    if (e.boss && m.role !== 'tank' && this.members[0].alive) this.stats.offTank += DT;
    const d = Math.hypot(m.x - e.x, m.y - e.y);
    if (e.busy > 0) {
      e.busy--;
      return;
    }
    // Turn to face the target.
    const want = Math.atan2(m.y - e.y, m.x - e.x);
    e.facing += clamp(angDiff(want, e.facing), -0.5, 0.5);
    if (e.boss) {
      if (this.bossAbility(e, m, d)) return;
      if (d > 3.2) {
        const k = Math.min(BOSS_SPEED, d - 3) / d;
        e.x += (m.x - e.x) * k;
        e.y += (m.y - e.y) * k;
      } else if (--e.timer <= 0) {
        e.timer = T(1.5);
        this.events.push({ t: 'swing', x: e.x, y: e.y, dir: e.facing, big: true });
        this.hurt(m, BOSS.swing);
      }
      return;
    }
    // Goblin archers: get in bow range and shoot.
    if (d > 16) {
      const k = SPEED * 0.8 / d;
      e.x += (m.x - e.x) * k;
      e.y += (m.y - e.y) * k;
    } else if (--e.timer <= 0) {
      e.timer = T(2) + (ei % 2) * 3;
      this.events.push({ t: 'shot', kind: 'arrow', x0: e.x, y0: e.y, x1: m.x, y1: m.y });
      this.hurt(m, BOSS.arrow);
    }
  }

  /** Cleave, ground slam and shove; true if the boss is busy with one this tick. */
  private bossAbility(e: Enemy, m: Member, d: number): boolean {
    const t = this.tick;
    if (t >= this.nextCry) {
      this.nextCry = t + T(BOSS.cryEvery);
      // War cry: everyone takes a little. Nothing to dodge; it's there to keep the cleric busy.
      for (const q of this.members) this.hurt(q, BOSS.cry);
      this.events.push({ t: 'cry', x: e.x, y: e.y });
      this.events.push({ t: 'say', x: e.x, y: e.y - 2.5, text: 'War cry!' });
    }
    if (t >= this.nextShove && d <= 3.6) {
      this.nextShove = t + T(BOSS.shoveEvery);
      // A shove: knocks its target back and halves that member's threat.
      const ux = (m.x - e.x) / (d || 1);
      const uy = (m.y - e.y) / (d || 1);
      m.x = clamp(m.x + ux * 5, 1, AW - 1);
      m.y = clamp(m.y + uy * 5, 1, AH - 1);
      e.threat[m.id] *= 0.5;
      this.hurt(m, 300);
      e.busy = T(1);
      this.events.push({ t: 'say', x: e.x, y: e.y - 2.5, text: 'Shove!' });
      return true;
    }
    if (t >= this.nextCleave && d <= 4) {
      this.nextCleave = t + T(BOSS.cleaveEvery);
      this.windUp(e, { kind: 'cleave', x: e.x, y: e.y, r: BOSS.cleaveRadius, dir: e.facing, half: (50 * Math.PI) / 180, start: t, end: t + T(BOSS.cleaveWarn) });
      return true;
    }
    if (t >= this.nextSlam) {
      this.nextSlam = t + T(BOSS.slamEvery);
      const victims = this.members.filter((q) => q.alive && q.role !== 'tank');
      if (victims.length) {
        const v = victims[Math.floor(this.r() * victims.length)];
        this.windUp(e, { kind: 'slam', x: v.x, y: v.y, r: BOSS.slamRadius, dir: 0, half: Math.PI, start: t, end: t + T(BOSS.slamWarn) });
        return true;
      }
    }
    return false;
  }

  private windUp(e: Enemy, g: Telegraph): void {
    this.telegraphs.push(g);
    e.busy = g.end - g.start;
  }

  private resolve(g: Telegraph): void {
    this.events.push({ t: 'boom', tg: g });
    for (const m of this.members) {
      if (!m.alive || !inside(g, m.x, m.y)) continue;
      const tanking = g.kind === 'cleave' && m.id === this.boss.target;
      if (!tanking) this.stats.caught++;
      this.hurt(m, g.kind === 'cleave' ? BOSS.cleave : BOSS.slam);
    }
  }

  // ---------------------------------------------------------------------------------------
  // The party

  /** Where each member wants to stand. */
  private spot(m: Member): [number, number] {
    const b = this.boss;
    const tg = this.enemies[m.target];
    if (m.role === 'tank') {
      if (!b.alive) return [m.x, m.y];
      // On the far side of the boss from the party, so it faces away from them.
      return [b.x - Math.cos(this.side) * 2.6, b.y - Math.sin(this.side) * 2.6];
    }
    if (m.role === 'damage' && m.missile === null && tg) {
      if (!tg.boss) return [tg.x - Math.sign(tg.x - b.x || 1) * 1.4, tg.y];
      // Behind the boss: opposite the way it faces.
      return [b.x - Math.cos(b.facing) * 2.8, b.y - Math.sin(b.facing) * 2.8];
    }
    // Ranged: spread out on the party's side, at least a slam's width apart.
    const off = m.role === 'healer' ? 0 : m.id === 3 ? -RANGED_SPREAD : RANGED_SPREAD;
    const R = m.role === 'healer' ? CLERIC_DISTANCE : RANGED_DISTANCE;
    let x = b.x + Math.cos(this.side + off) * R;
    let y = b.y + Math.sin(this.side + off) * R;
    if (m.role === 'damage' && tg && !tg.boss && Math.hypot(tg.x - x, tg.y - y) > m.reach - 1) {
      const d = Math.hypot(tg.x - m.x, tg.y - m.y);
      if (d > m.reach - 1) [x, y] = [tg.x + ((m.x - tg.x) / d) * (m.reach - 2), tg.y + ((m.y - tg.y) / d) * (m.reach - 2)];
      else [x, y] = [m.x, m.y];
    }
    return [x, y];
  }

  /** How dangerous a point will be: inside a telegraph (if dodging), or on top of the boss. */
  private danger(m: Member, x: number, y: number): number {
    let v = 0;
    if (x < 0.8 || y < 0.8 || x > AW - 0.8 || y > AH - 0.8) v += 2;
    const b = this.boss;
    if (b.alive && Math.hypot(x - b.x, y - b.y) < 1.8) v += 1;
    if (this.s.dodge)
      for (const g of this.telegraphs) {
        // The tank takes the cleave aimed at it; everyone else gets out.
        if (g.kind === 'cleave' && m.role === 'tank') continue;
        const k = depth(g, x, y);
        if (k > 0) v += 4 + 4 * k;
      }
    return v;
  }

  /** Context steering: 16 directions, interest towards the spot, danger from the map above. */
  private steer(m: Member, sx: number, sy: number): void {
    const dist = Math.hypot(sx - m.x, sy - m.y);
    const here = this.danger(m, m.x, m.y);
    m.dodging = here >= 4;
    if (dist < 0.3 && here === 0) return;
    const want = Math.atan2(sy - m.y, sx - m.x);
    let best = -1;
    let bestDanger = Infinity;
    let bestInterest = -Infinity;
    for (let i = 0; i < STEER_DIRECTIONS; i++) {
      const a = (i / STEER_DIRECTIONS) * Math.PI * 2;
      const at = (look: number) => this.danger(m, m.x + Math.cos(a) * look, m.y + Math.sin(a) * look);
      // Out of danger: don't walk into any. In it: the way out that clears it soonest.
      const dg = here === 0 ? Math.max(at(SPEED), at(1.5), at(3)) : at(1);
      const interest = dist < 0.3 ? 0 : Math.cos(angDiff(a, want));
      if (dg < bestDanger - 1e-9 || (Math.abs(dg - bestDanger) < 1e-9 && interest > bestInterest)) {
        best = i;
        bestDanger = dg;
        bestInterest = interest;
      }
    }
    if (here === 0 ? bestDanger > 0 || bestInterest < 0.3 : bestDanger >= here) return; // nothing better than standing still
    const a = (best / STEER_DIRECTIONS) * Math.PI * 2;
    const step = Math.min(SPEED, here > 0 ? SPEED : dist);
    m.x = clamp(m.x + Math.cos(a) * step, 0.8, AW - 0.8);
    m.y = clamp(m.y + Math.sin(a) * step, 0.8, AH - 0.8);
    m.moved = true;
  }

  private chooseTarget(m: Member): number {
    if (m.role !== 'damage' || this.s.dps === 'nuke') return 0;
    // Careful: adds first, nearest one.
    let best = 0;
    let bd = Infinity;
    this.enemies.forEach((e, i) => {
      if (i === 0 || !e.alive) return;
      const d = Math.hypot(e.x - m.x, e.y - m.y);
      if (d < bd) ((bd = d), (best = i));
    });
    return this.enemies[best].alive ? best : 0;
  }

  /** Careful damage dealers stay under HOLD_AT of what would pull the boss off the tank. */
  private holds(m: Member, e: Enemy): boolean {
    // Nothing to mind if the boss doesn't keep a threat table.
    if (this.s.dps === 'nuke' || this.s.targeting === 'nearest' || !e.boss || m.role !== 'damage') return false;
    if (e.target < 0) return true; // wait for the tank to start the fight
    if (e.target === m.id) return true;
    const near = Math.hypot(m.x - e.x, m.y - e.y) <= MELEE_RANGE;
    const margin = this.s.targeting === 'margin' ? (near ? MELEE_MARGIN : RANGED_MARGIN) : 1;
    return e.threat[m.id] + m.dmg >= HOLD_AT * margin * e.threat[e.target];
  }

  private stepMember(m: Member): void {
    m.moved = false;
    m.target = this.chooseTarget(m);
    if (m.role === 'tank') this.tankThinks(m);
    const [sx, sy] = this.spot(m);
    if (m.role === 'healer') {
      // Stand still to cast unless the ground is about to explode.
      if (this.cast && this.danger(m, m.x, m.y) < 4) {
        m.dodging = false;
        if (this.tick >= this.cast.end) this.finishCast();
        return;
      }
      this.cast = null;
      this.steer(m, sx, sy);
      if (!m.moved) this.healerThinks();
      return;
    }
    this.steer(m, sx, sy);
    const e = this.enemies[m.target];
    if (!e?.alive) return;
    m.holding = this.holds(m, e);
    if (m.timer > 0) m.timer--;
    const d = Math.hypot(e.x - m.x, e.y - m.y);
    if (m.timer > 0 || m.holding || d > m.reach || (m.missile && m.moved)) return;
    m.timer = T(m.period);
    const crit = this.r() < 0.2 ? 1.5 : 1;
    const amount = Math.round(m.dmg * crit * (0.9 + 0.2 * this.r()));
    if (m.missile) this.events.push({ t: 'shot', kind: m.missile, x0: m.x, y0: m.y, x1: e.x, y1: e.y });
    else this.events.push({ t: 'swing', x: m.x, y: m.y, dir: Math.atan2(e.y - m.y, e.x - m.x), big: false });
    this.damage(e, m, amount);
  }

  private tankThinks(m: Member): void {
    // Taunt whichever enemy is hitting someone else (after a moment to notice): the boss first, then adds.
    this.enemies.forEach((e, i) => {
      if (!e.alive || e.target < 0 || e.target === m.id) this.lostAt[i] = -1;
      else if ((this.lostAt[i] ?? -1) < 0) this.lostAt[i] = this.tick;
    });
    if (this.tick < this.tauntReady) return;
    for (const [i, e] of this.enemies.entries()) {
      if (!e.alive || e.target < 0 || e.target === m.id || this.tick - this.lostAt[i] < T(TAUNT_REACTION)) continue;
      e.threat[m.id] = Math.max(...e.threat);
      e.target = m.id;
      e.forced = T(TAUNT_FORCE);
      this.tauntReady = this.tick + T(TAUNT_COOLDOWN);
      this.stats.taunts++;
      this.events.push({ t: 'say', x: m.x, y: m.y - 1.6, text: 'Taunt!' });
      if (e.boss) this.stats.switches++;
      return;
    }
  }

  /** Every option the cleric could cast now, best first. */
  healOptions(): HealOption[] {
    const out: HealOption[] = [];
    const lowMana = this.mana < LOW_MANA * this.maxMana;
    for (const m of this.members) {
      if (!m.alive) continue;
      let best: HealOption = { who: m.id, spell: 'greater', score: 0, effective: 0 };
      for (const sp of ['flash', 'greater'] as Spell[]) {
        const s = SPELLS[sp];
        if (this.mana < s.mana) continue;
        if (this.s.heal === 'lowest') {
          // Naive: whoever is lowest by percentage, with the efficient big heal.
          const frac = m.hp / m.maxHp;
          if (frac >= 1 || sp !== 'greater') continue;
          const score = 1 - frac;
          if (score > best.score) best = { who: m.id, spell: sp, score, effective: Math.min(s.heal, m.maxHp - m.hp) };
          continue;
        }
        // Triage: predict health when the heal lands from the incoming damage rate.
        const predicted = m.hp - m.rate * s.cast;
        if (predicted <= 0) continue; // this spell lands too late
        const effective = Math.min(s.heal, m.maxHp - predicted);
        if (effective <= 0) continue;
        // Need: the share of health missing when the heal lands.
        const need = 1 - predicted / m.maxHp;
        // Danger: time to death at the incoming rate, with a floor because war cries and arrows come in bursts.
        const timeToDeath = predicted / Math.max(m.rate, RATE_FLOOR);
        const danger = 1 / (1 + timeToDeath / 8);
        const role = ROLE_WEIGHT[m.role];
        const efficiency = (effective / s.heal) ** 2; // 1 means no overheal
        // Cast time against time to death: if the big heal might land too late, the quick one.
        // Otherwise the quick heal costs more mana per point: rarely, and hardly at all on a low budget.
        const urgent = m.hp / Math.max(m.rate, RATE_FLOOR) < SPELLS.greater.cast + 1.5;
        const cost = sp === 'flash' ? (urgent ? 1.2 : lowMana ? 0.3 : 0.6) : urgent ? 0.5 : 1;
        const score = need * danger * role * efficiency * cost;
        if (score > best.score) best = { who: m.id, spell: sp, score, effective };
      }
      out.push(best);
    }
    return out;
  }

  private healerThinks(): void {
    this.options = this.healOptions();
    const best = this.options.reduce((a, b) => (b.score > a.score ? b : a), { who: -1, spell: 'greater' as Spell, score: 0, effective: 0 });
    // Triage skips heals that would mostly be wasted, more strictly when mana runs low.
    const floor = this.s.heal === 'triage' ? (this.mana < LOW_MANA * this.maxMana ? 0.12 : 0.05) : 0;
    if (best.who < 0 || best.score <= floor) return;
    const s = SPELLS[best.spell];
    this.mana -= s.mana;
    this.cast = { target: best.who, spell: best.spell, start: this.tick, end: this.tick + T(s.cast), score: best.score };
  }

  private finishCast(): void {
    const c = this.cast!;
    this.cast = null;
    const m = this.members[c.target];
    if (m.alive) this.heal(m, SPELLS[c.spell].heal);
  }

  // ---------------------------------------------------------------------------------------

  step(): void {
    const st = this.stats;
    if (st.done) return;
    this.tick++;
    st.time = this.tick / TICK_HZ;
    this.events = [];
    const b = this.boss;
    // At half health the warchief calls two goblin archers.
    if (!this.addsCalled && b.hp <= b.maxHp / 2) {
      this.addsCalled = true;
      this.enemies.push(this.enemy(false, AW / 2, 1, BOSS.addHp), this.enemy(false, AW / 2, AH - 1, BOSS.addHp));
      // They nock their first arrows after a moment, one after the other.
      this.enemies[1].timer = T(2);
      this.enemies[2].timer = T(3);
      this.events.push({ t: 'say', x: AW / 2, y: 3, text: 'Goblins!' });
    }
    this.enemies.forEach((e, i) => e.alive && this.stepEnemy(e, i));
    for (const g of this.telegraphs) if (g.end === this.tick) this.resolve(g);
    this.telegraphs = this.telegraphs.filter((g) => g.end > this.tick);
    for (const m of this.members) {
      m.rate *= Math.exp(-DT / 3);
      if (m.alive) this.stepMember(m);
    }
    this.mana = Math.min(this.maxMana, this.mana + BOSS.regen * DT);
    st.manaLeft = this.mana;
    if (!b.alive) st.won = st.done = true;
    if (!this.members.some((m) => m.alive) || this.tick >= T(LIMIT)) st.done = true;
  }

  run(): FightStats {
    while (!this.stats.done) this.step();
    return this.stats;
  }
}

/** The setups the lesson compares: everything on, then one thing switched to its naive version. */
export const SETUPS: Array<[string, Partial<BossSettings>]> = [
  ['Everything on', {}],
  ['Boss hits the nearest', { targeting: 'nearest' }],
  ['Top threat, no margin', { targeting: 'top' }],
  ['Heal the lowest %', { heal: 'lowest' }],
  ['Damage at full speed', { dps: 'nuke' }],
  ['Nobody dodges', { dodge: false }],
];

/** Totals over seeds 1..n for one setup. */
export interface Summary {
  n: number;
  wins: number;
  time: number;
  deaths: Record<Role, number>;
  switches: number;
  offTank: number;
  nonTank: number;
  healed: number;
  overheal: number;
  caught: number;
  manaLeft: number;
}
export function summarise(over: Partial<BossSettings>, n = 20): Summary {
  const out: Summary = { n, wins: 0, time: 0, deaths: { tank: 0, healer: 0, damage: 0 }, switches: 0, offTank: 0, nonTank: 0, healed: 0, overheal: 0, caught: 0, manaLeft: 0 };
  for (let seed = 1; seed <= n; seed++) {
    const s = new BossFight({ ...BOSS_DEFAULTS, ...over, seed }).run();
    out.wins += s.won ? 1 : 0;
    out.time += s.time / n;
    for (const k of ['tank', 'healer', 'damage'] as Role[]) out.deaths[k] += s.deaths[k];
    out.switches += s.switches / n;
    out.offTank += s.offTank / n;
    out.nonTank += s.nonTank / n;
    out.healed += s.healed;
    out.overheal += s.overheal;
    out.caught += s.caught / n;
    out.manaLeft += s.manaLeft / n;
  }
  return out;
}
