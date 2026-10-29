/**
 * The feel lab's platformer: a box on a tile map, stepped at a fixed 60 Hz, with every setting a
 * game editor would expose for "feel". Units are tiles and seconds. Deterministic, so a recorded
 * input sequence always plays back the same way.
 */

export const HZ = 60;
export const DT = 1 / HZ;

export interface Settings {
  // Run
  /** Top running speed, tiles/s. */
  maxSpeed: number;
  /** Seconds to reach top speed from standing, on the ground. 0 = instant. */
  accelTime: number;
  /** Seconds to stop from top speed, on the ground. 0 = instant. */
  decelTime: number;
  /** Control in the air, as a fraction of ground acceleration (0 = none, 1 = same). */
  airControl: number;
  /** Extra acceleration when pushing against your current direction (1 = none). */
  turnBoost: number;
  // Jump
  /** Jump height, tiles. */
  jumpHeight: number;
  /** Seconds from take-off to the top of the jump. */
  timeToApex: number;
  /** Releasing jump early cuts the upward speed to this fraction (1 = no variable jump). */
  jumpCut: number;
  /** Gravity multiplier while falling (1 = same as rising). */
  fallGravity: number;
  /** Gravity multiplier near the apex while jump is held (1 = none). */
  apexHang: number;
  /** Fastest fall, tiles/s. */
  maxFall: number;
  // Forgiveness
  /** Seconds after leaving a ledge during which a jump still works. */
  coyoteTime: number;
  /** Seconds a jump press is remembered before landing. */
  jumpBuffer: number;
  /** How far (tiles) the player is nudged sideways round a ceiling corner it would clip. 0 = off. */
  cornerCorrection: number;
  // Input
  /** Frames between pressing a key and the game seeing it. */
  inputDelay: number;
  // Camera
  camera: 'locked' | 'lerp' | 'spring';
  /** Lerp: fraction of the distance closed per second (as a rate). Spring: natural frequency, Hz. */
  cameraRate: number;
  /** Half-width of the box the player can move in without the camera following, tiles. */
  deadZone: number;
  /** Tiles the camera leads in the direction you're running. */
  lookAhead: number;
  /** Only follow vertically when the player lands or falls far (platform snapping). */
  platformSnap: boolean;
  // Juice
  squash: boolean;
  shake: boolean;
}

export const TIGHT: Settings = {
  maxSpeed: 9,
  accelTime: 0.1,
  decelTime: 0.06,
  airControl: 0.65,
  turnBoost: 2,
  jumpHeight: 3.2,
  timeToApex: 0.36,
  jumpCut: 0.45,
  fallGravity: 1.8,
  apexHang: 0.55,
  maxFall: 22,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  cornerCorrection: 0.35,
  inputDelay: 0,
  camera: 'spring',
  cameraRate: 3,
  deadZone: 1,
  lookAhead: 3,
  platformSnap: true,
  squash: true,
  shake: true,
};

export const PRESETS: Record<string, { label: string; s: Settings }> = {
  tight: { label: 'Tight', s: TIGHT },
  floaty: {
    label: 'Floaty',
    s: { ...TIGHT, accelTime: 0.5, decelTime: 0.6, airControl: 1, turnBoost: 1, jumpHeight: 3.6, timeToApex: 0.6, jumpCut: 1, fallGravity: 1, apexHang: 1, maxFall: 12, camera: 'lerp', cameraRate: 2 },
  },
  heavy: {
    label: 'Heavy',
    s: { ...TIGHT, maxSpeed: 7, accelTime: 0.35, decelTime: 0.3, airControl: 0.25, turnBoost: 1, jumpHeight: 2.6, timeToApex: 0.32, jumpCut: 0.7, fallGravity: 2.6, apexHang: 1, maxFall: 30, cornerCorrection: 0, camera: 'spring', cameraRate: 2 },
  },
  naive: {
    label: 'Everything off',
    s: {
      ...TIGHT,
      accelTime: 0,
      decelTime: 0,
      airControl: 1,
      turnBoost: 1,
      jumpCut: 1,
      fallGravity: 1,
      apexHang: 1,
      maxFall: 60,
      coyoteTime: 0,
      jumpBuffer: 0,
      cornerCorrection: 0,
      camera: 'locked',
      deadZone: 0,
      lookAhead: 0,
      platformSnap: false,
      squash: false,
      shake: false,
    },
  },
};

/** Gravity and take-off speed from the designer's numbers: height h reached in time t. */
export function jumpPhysics(s: Settings): { gravity: number; takeOff: number } {
  // h = v·t − ½·g·t² with v = g·t at the apex  ⇒  g = 2h / t², v = 2h / t.
  return { gravity: (2 * s.jumpHeight) / (s.timeToApex * s.timeToApex), takeOff: (2 * s.jumpHeight) / s.timeToApex };
}

// ---------------------------------------------------------------------------------------------
// Level

export interface Level {
  w: number;
  h: number;
  /** Row-major, y = 0 at the top; true = solid. */
  solid: boolean[];
  start: { x: number; y: number };
  /** Named places concept cards can drop the player at. */
  spots: Record<string, { x: number; y: number; label: string }>;
}

/**
 * The test course, built in code so each stretch sits where the concept cards expect it:
 * a gap (coyote time), a low ledge whose corner clips your head (corner correction), steps
 * (buffering and air control), a shallow pit, a long run (acceleration and look-ahead), a tower
 * (vertical camera) and a deep shaft (falling and camera catch-up).
 */
export function makeLevel(): Level {
  const w = 100;
  const h = 26;
  const G = 15; // ground surface: feet stand at y = G
  const solid: boolean[] = new Array(w * h).fill(false);
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < w && y < h) solid[y * w + x] = true;
  };
  // Outer walls and ceiling.
  fill(0, 0, w - 1, 0);
  fill(0, 0, 0, h - 1);
  fill(w - 1, 0, w - 1, h - 1);
  // Ground, with holes cut out below.
  fill(1, G, w - 2, h - 1);
  const cut = (x0: number, x1: number, depth: number) => {
    for (let y = G; y < G + depth; y++) for (let x = x0; x <= x1; x++) solid[y * w + x] = false;
  };
  cut(16, 19, 5); // the gap: a 4-tile hole, 5 deep
  fill(16, G + 3, 17, G + 3); // ledges to climb back out
  fill(19, G + 2, 19, G + 2);
  // The low ledge: a platform 2.5 tiles up whose left corner clips your head if you jump just short of it.
  fill(27, G - 3, 32, G - 3);
  fill(22, G - 3, 23, G - 3); // a ceiling chunk to bonk on
  // Steps up to the right.
  fill(36, G - 2, 37, G - 2);
  fill(40, G - 4, 41, G - 4);
  fill(44, G - 6, 46, G - 6);
  // A shallow pit.
  cut(50, 54, 2);
  // The long run, then a tower.
  fill(76, G - 3, 79, G - 1);
  fill(80, G - 6, 83, G - 1);
  fill(84, G - 9, 87, G - 1);
  // The shaft: a deep drop past the tower.
  cut(88, 93, 9);
  fill(92, G + 7, 93, G + 7); // ledges to climb back out, two tiles apart
  fill(88, G + 5, 89, G + 5);
  fill(92, G + 3, 93, G + 3);
  fill(88, G + 1, 89, G + 1);
  const start = { x: 4.5, y: G };
  return {
    w,
    h,
    solid,
    start,
    spots: {
      start: { x: start.x, y: G, label: 'the start' },
      gap: { x: 10.5, y: G, label: 'the gap' },
      ceiling: { x: 24.5, y: G, label: 'the low ledge' },
      steps: { x: 33.5, y: G, label: 'the steps' },
      run: { x: 57.5, y: G, label: 'the long run' },
      tower: { x: 85.5, y: G - 9, label: 'the top of the tower' },
    },
  };
}

export function solidAt(L: Level, x: number, y: number): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= L.w || ty >= L.h) return true;
  return L.solid[ty * L.w + tx];
}

// ---------------------------------------------------------------------------------------------
// The player

/** Half-extents of the player's box, tiles. Position is the centre of its feet. */
export const HALF_W = 0.35;
export const HEIGHT = 1.3;

export interface Keys {
  left: boolean;
  right: boolean;
  jump: boolean;
}
export const NO_KEYS: Keys = { left: false, right: false, jump: false };

/** Things that happened on one tick, for the strip and the stats. */
export interface TickEvents {
  jumped?: 'normal' | 'coyote' | 'buffered';
  landed?: number;
  /** On landing: how far the feet fell from the highest point of the air time, tiles. */
  drop?: number;
  cornered?: boolean;
  /** A jump press that never turned into a jump. */
  eaten?: boolean;
  cut?: boolean;
}

export class Player {
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  grounded = true;
  facing = 1;
  /** Seconds since last on the ground (0 while grounded). */
  airTime = 0;
  /** Seconds since jump was pressed, or Infinity if no press is waiting. */
  sincePress = Infinity;
  /** Whether the current airborne period started with a jump (so coyote can't double-jump). */
  jumpedThisAir = false;
  holdingJump = false;
  /** Highest point (smallest y) since last on the ground. */
  private peakY: number;
  private lastJumpKey = false;
  /** A press that hasn't been used yet: becomes "eaten" if it expires. */
  private pendingPress = false;
  /** Squash and stretch: >1 tall and thin, <1 short and wide. */
  stretch = 1;
  /** Input delay queue. */
  private queue: Keys[] = [];

  constructor(
    public level: Level,
    public s: Settings,
  ) {
    this.x = level.start.x;
    this.y = level.start.y;
    this.peakY = this.y;
  }

  teleport(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.vx = this.vy = 0;
    this.peakY = y;
    this.grounded = false;
    this.airTime = 1;
    this.jumpedThisAir = true;
    this.queue = [];
    this.sincePress = Infinity;
    this.pendingPress = false;
  }

  step(raw: Keys): TickEvents {
    const s = this.s;
    const ev: TickEvents = {};
    // Input delay: the game sees what was pressed inputDelay ticks ago.
    this.queue.push(raw);
    while (this.queue.length > s.inputDelay + 1) this.queue.shift();
    const k = this.queue.length > s.inputDelay ? this.queue[0] : NO_KEYS;

    const { gravity, takeOff } = jumpPhysics(s);
    // --- Horizontal: accelerate towards the wanted speed.
    const dir = (k.right ? 1 : 0) - (k.left ? 1 : 0);
    if (dir) this.facing = dir;
    const want = dir * s.maxSpeed;
    const control = this.grounded ? 1 : s.airControl;
    const accelerating = dir !== 0;
    const time = accelerating ? s.accelTime : s.decelTime;
    let rate = time <= 0 ? Infinity : s.maxSpeed / time;
    if (accelerating && Math.sign(this.vx) === -dir && this.vx !== 0) rate *= s.turnBoost;
    rate *= control;
    if (control === 0) rate = 0;
    const dv = want - this.vx;
    const maxStep = rate * DT;
    this.vx = Math.abs(dv) <= maxStep ? want : this.vx + Math.sign(dv) * maxStep;

    // --- Jump input: remember presses for the buffer window.
    const pressed = k.jump && !this.lastJumpKey;
    this.lastJumpKey = k.jump;
    if (pressed) {
      if (this.pendingPress) ev.eaten = true; // a second press replaces an unused one
      this.sincePress = 0;
      this.pendingPress = true;
    } else if (this.sincePress !== Infinity) this.sincePress += DT;

    const canCoyote = !this.grounded && !this.jumpedThisAir && this.airTime <= s.coyoteTime;
    const buffered = this.sincePress <= Math.max(s.jumpBuffer, 0);
    const wantsJump = this.sincePress === 0 || (buffered && this.sincePress > 0);
    if (wantsJump && (this.grounded || canCoyote)) {
      this.vy = -takeOff;
      ev.jumped = this.sincePress > 0 ? 'buffered' : this.grounded ? 'normal' : 'coyote';
      this.grounded = false;
      this.jumpedThisAir = true;
      this.holdingJump = true;
      this.sincePress = Infinity;
      this.pendingPress = false;
      this.stretch = s.squash ? 1.25 : 1;
    } else if (this.sincePress > Math.max(s.jumpBuffer, 0) && this.sincePress !== Infinity) {
      if (this.pendingPress) ev.eaten = true;
      this.sincePress = Infinity;
      this.pendingPress = false;
    }
    // Variable jump: once jump is no longer held while rising, cut the upward speed (once per
    // jump). Checking "not held" rather than "just released" also cuts a buffered tap.
    if (!k.jump && this.holdingJump) {
      this.holdingJump = false;
      if (this.vy < 0 && s.jumpCut < 1) {
        this.vy *= s.jumpCut;
        ev.cut = true;
      }
    }

    // --- Gravity, heavier when falling, lighter at the apex while holding jump.
    let g = gravity;
    if (this.vy > 0) g *= s.fallGravity;
    else if (this.holdingJump && Math.abs(this.vy) < takeOff * 0.25) g *= s.apexHang;
    // Average the speed over the tick, so constant gravity is integrated exactly and the jump
    // reaches the height you asked for.
    const v0 = this.vy;
    if (!this.grounded) this.vy = Math.min(this.vy + g * DT, s.maxFall);
    const dy = ((v0 + this.vy) / 2) * DT;

    // --- Move and collide, one axis at a time.
    this.moveX(this.vx * DT);
    const wasGrounded = this.grounded;
    const fallSpeed = this.vy;
    const hit = this.moveY(dy, ev);
    if (hit === 'floor') {
      if (!wasGrounded) {
        ev.landed = fallSpeed;
        ev.drop = this.y - this.peakY;
      }
      this.grounded = true;
      this.vy = 0;
    } else if (hit === 'ceiling') this.vy = 0;
    else if (this.grounded) {
      // Walked off a ledge?
      if (!this.supported()) this.grounded = false;
    }
    if (this.grounded) {
      this.airTime = 0;
      this.jumpedThisAir = false;
      this.peakY = this.y;
    } else {
      this.airTime += DT;
      this.peakY = Math.min(this.peakY, this.y);
    }

    // Squash on landing, ease back to normal.
    if (ev.landed && s.squash) this.stretch = Math.max(0.7, 1 - ev.landed / 60);
    this.stretch += (1 - this.stretch) * 0.2;
    return ev;
  }

  private supported(): boolean {
    const y = this.y + 0.02;
    return solidAt(this.level, this.x - HALF_W + 0.01, y) || solidAt(this.level, this.x + HALF_W - 0.01, y);
  }

  private boxHits(x: number, y: number): boolean {
    const L = this.level;
    const x0 = x - HALF_W;
    const x1 = x + HALF_W - 1e-6;
    const y0 = y - HEIGHT;
    const y1 = y - 1e-6;
    for (let ty = Math.floor(y0); ty <= Math.floor(y1); ty++) for (let tx = Math.floor(x0); tx <= Math.floor(x1); tx++) if (solidAt(L, tx, ty)) return true;
    return false;
  }

  private moveX(dx: number): void {
    if (dx === 0) return;
    const nx = this.x + dx;
    if (!this.boxHits(nx, this.y)) {
      this.x = nx;
      return;
    }
    // Slide up to the wall.
    if (dx > 0) this.x = Math.floor(nx + HALF_W) - HALF_W;
    else this.x = Math.floor(nx - HALF_W) + 1 + HALF_W;
    this.vx = 0;
  }

  private moveY(dy: number, ev: TickEvents): 'floor' | 'ceiling' | null {
    if (dy === 0) return null;
    const ny = this.y + dy;
    if (!this.boxHits(this.x, ny)) {
      this.y = ny;
      return null;
    }
    if (dy > 0) {
      this.y = Math.floor(ny);
      return 'floor';
    }
    // Rising into a ceiling: if a small sideways nudge would clear it, take the nudge.
    const c = this.s.cornerCorrection;
    if (c > 0) {
      // Smallest nudge first, trying the direction of movement before the other.
      const first = this.vx < 0 ? -1 : 1;
      for (let n = 0.05; n <= c + 1e-9; n += 0.05) {
        for (const sign of [first, -first]) {
          const tx = this.x + sign * n;
          if (!this.boxHits(tx, ny) && !this.boxHits(tx, this.y)) {
            this.x = tx;
            this.y = ny;
            ev.cornered = true;
            return null;
          }
        }
      }
    }
    this.y = Math.floor(ny - HEIGHT) + 1 + HEIGHT;
    return 'ceiling';
  }
}

// ---------------------------------------------------------------------------------------------
// Camera

export class Camera {
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  private lead = 0;
  /** The height the camera is following: the last ground the player stood on, with snapping. */
  private floorY: number;
  trauma = 0;

  constructor(
    p: Player,
    public viewW: number,
    public viewH: number,
  ) {
    this.x = p.x;
    this.y = p.y - 3;
    this.floorY = p.y;
  }

  /** The point the camera wants to centre on. */
  target(p: Player, s: Settings): { x: number; y: number } {
    this.lead += ((s.lookAhead * Math.sign(p.vx || 0) * Math.min(1, Math.abs(p.vx) / s.maxSpeed)) - this.lead) * 0.04;
    if (s.platformSnap) {
      // Follow height only on landing, or when the player falls well below the last floor.
      if (p.grounded || p.y > this.floorY + 3) this.floorY = p.y;
    } else this.floorY = p.y;
    let tx = p.x + this.lead;
    const ty = this.floorY - 3;
    // Dead zone: don't move horizontally until the player leaves the box.
    const dz = s.deadZone;
    if (tx > this.x + dz) tx -= dz;
    else if (tx < this.x - dz) tx += dz;
    else tx = this.x;
    return { x: tx, y: ty };
  }

  step(p: Player, s: Settings, level: Level): void {
    const t = this.target(p, s);
    if (s.camera === 'locked') {
      this.x = t.x;
      this.y = t.y;
      this.vx = this.vy = 0;
    } else if (s.camera === 'lerp') {
      // Exponential smoothing, frame-rate independent: close (1 − e^(−rate·dt)) of the gap.
      const a = 1 - Math.exp(-s.cameraRate * DT);
      this.x += (t.x - this.x) * a;
      this.y += (t.y - this.y) * a;
    } else {
      // A critically damped spring, stepped with its exact solution (target held for the tick):
      // smooth starts and stops, no overshoot, and stable at any stiffness.
      const w = 2 * Math.PI * s.cameraRate;
      const k = Math.exp(-w * DT);
      for (const ax of ['x', 'y'] as const) {
        const v = ax === 'x' ? 'vx' : 'vy';
        const e = this[ax] - t[ax];
        const j = this[v] + w * e;
        this[ax] = t[ax] + (e + j * DT) * k;
        this[v] = (this[v] - w * j * DT) * k;
      }
    }
    // Keep the view inside the level; drop stored speed when clamped so it doesn't press on the edge.
    const cx = Math.min(Math.max(this.x, this.viewW / 2), level.w - this.viewW / 2);
    if (cx !== this.x) { this.x = cx; this.vx = 0; }
    const cy = Math.min(Math.max(this.y, this.viewH / 2), level.h - this.viewH / 2);
    if (cy !== this.y) { this.y = cy; this.vy = 0; }
    this.trauma = Math.max(0, this.trauma - DT * 1.6);
  }

  /** Screen shake: offset proportional to trauma squared, so small bumps barely show. */
  shake(time: number): { x: number; y: number } {
    const k = this.trauma * this.trauma * 0.4;
    return { x: k * Math.sin(time * 47.3), y: k * Math.sin(time * 39.1 + 1.3) };
  }
}
