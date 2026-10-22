/** Shared drawing and playback helpers for the AI widgets. */
import { h } from '../engine/dom';
import { type ActionId, type World, ACTIONS, ACTION_COL, ACTION_NAMES, CRYSTALS, CRATES, CRATE_R, H, CHARGES, POTION, RANGE, TICK_HZ, W } from './world';
import type { Brain } from './brains';
import { drawMissile, drawSprite, launch, onSprites } from '../sprites/sprites';

/** How far between ticks the arena is being drawn (0..1); set by Runner each frame. */
let arenaFrac = 1;
const arenaWaiting = new Set<() => void>();
/** Redraw once the sprite sheet has loaded. */
export function whenSprites(fn: () => void): void {
  arenaWaiting.add(fn);
  // Deferred, so a widget can call this from its constructor before it has finished setting up.
  onSprites(() =>
    requestAnimationFrame(() => {
      for (const f of arenaWaiting) f();
      arenaWaiting.clear();
    }),
  );
}

export { h };

/** Read a theme token from an element (falls back to grey). */
export function tok(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || '#888';
}

/** Re-run `fn` whenever the site theme changes. */
export function onTheme(fn: () => void): void {
  new MutationObserver(fn).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

export function actionChip(a: ActionId): HTMLElement {
  return h('span', { class: 'ai-chip', style: `--ac: var(${ACTION_COL[a]})` }, ACTION_NAMES[a]);
}

export function legend(actions: ActionId[] = ACTIONS): HTMLElement {
  return h('div', { class: 'ai-legend' }, ...actions.map((a) => h('span', { class: 'ai-key', style: `--ac: var(${ACTION_COL[a]})` }, ACTION_NAMES[a])));
}

// ---------------------------------------------------------------------------
// Arena

export const ARENA_SCALE = 20;

export function arenaCanvas(label = 'Arena'): HTMLCanvasElement {
  return h('canvas', { class: 'ai-arena', width: String(W * ARENA_SCALE), height: String(H * ARENA_SCALE), 'aria-label': label });
}

export function drawArena(cnv: HTMLCanvasElement, w: World, opt: { caption?: string; frac?: number } = {}): void {
  const ctx = cnv.getContext('2d')!;
  const s = cnv.width / W;
  const cs = getComputedStyle(cnv);
  const c = (n: string) => cs.getPropertyValue(n).trim() || '#888';
  const P = (v: number) => v * s;
  ctx.fillStyle = c('--bg');
  ctx.fillRect(0, 0, cnv.width, cnv.height);
  ctx.strokeStyle = c('--line-soft');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 2; x < W; x += 2) {
    ctx.moveTo(P(x) + 0.5, 0);
    ctx.lineTo(P(x) + 0.5, cnv.height);
  }
  for (let y = 2; y < H; y += 2) {
    ctx.moveTo(0, P(y) + 0.5);
    ctx.lineTo(cnv.width, P(y) + 0.5);
  }
  ctx.stroke();

  const a0 = w.agent;
  const frac = opt.frac ?? arenaFrac;
  const lerp = (id: number, p: { x: number; y: number }) => {
    const q = w.prev.get(id);
    return q ? { x: q.x + (p.x - q.x) * frac, y: q.y + (p.y - q.y) * frac } : { x: p.x, y: p.y };
  };
  const a = { ...a0, ...lerp(-1, a0) };
  const accent = c('--accent');
  const alert = c('--alert');
  const ink = c('--ink');
  const muted = c('--muted');
  const actCol = c(ACTION_COL[a.action]);

  // Where the agent is heading.
  let dest: { x: number; y: number } | null = null;
  if (a.action === 'cover') dest = w.coverSpot();
  else if (a.action === 'crystals') dest = CRYSTALS;
  else if (a.action === 'potion' && w.potionReady) dest = POTION;
  if (dest) {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = actCol;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(P(a.x), P(a.y));
    ctx.lineTo(P(dest.x), P(dest.y));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(P(dest.x), P(dest.y), 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Range ring.
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.15;
  ctx.beginPath();
  ctx.arc(P(a.x), P(a.y), P(RANGE), 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Crates.
  for (const k of CRATES) {
    ctx.fillStyle = c('--raised');
    ctx.strokeStyle = c('--line');
    ctx.lineWidth = 1.5;
    const r = P(CRATE_R);
    ctx.beginPath();
    ctx.roundRect(P(k.x) - r, P(k.y) - r, 2 * r, 2 * r, 3);
    ctx.fill();
    ctx.stroke();
  }
  // Pickups.
  const box = (x: number, y: number, col: string, glyph: string, on: boolean) => {
    ctx.globalAlpha = on ? 1 : 0.3;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.roundRect(P(x) - 10, P(y) - 10, 20, 20, 4);
    ctx.fill();
    ctx.fillStyle = c('--bg');
    ctx.font = `bold 13px ${c('--f-body')}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, P(x), P(y) + 1);
    ctx.globalAlpha = 1;
  };
  box(CRYSTALS.x, CRYSTALS.y, c('--c6'), '◆', true);
  box(POTION.x, POTION.y, c('--c4'), '+', w.potionReady);

  // Missiles: the battle-mage's arcane bolts and the goblins' arrows, in flight between ticks.
  const missiles = () => {
    for (const sh of w.shots) {
      const kind = sh.enemy ? 'arrow' : 'spell';
      const f = launch(kind, sh.from.x, sh.from.y, sh.to.x, sh.to.y, 0, sh.hit);
      const t = ((sh.age - 1 + frac) / TICK_HZ) / f.dur;
      drawMissile(ctx, kind, P(f.x0), P(f.y0), P(f.x1), P(f.y1), t, 1.4, sh.hit);
    }
  };

  const bar = (x: number, y: number, frac: number, col: string) => {
    ctx.fillStyle = c('--line');
    ctx.fillRect(P(x) - 12, P(y) - 18, 24, 3);
    ctx.fillStyle = col;
    ctx.fillRect(P(x) - 12, P(y) - 18, 24 * Math.max(0, frac), 3);
  };
  for (const e0 of w.enemies) {
    const e = lerp(e0.id, e0);
    drawSprite(ctx, 'goblinArcher', P(e.x), P(e.y), 32, { base: alert, flip: true });
    bar(e.x, e.y - 0.25, e0.hp / 60, alert);
  }

  // Agent: the battle-mage.
  if (w.inCover()) {
    ctx.strokeStyle = c('--good');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(P(a.x), P(a.y), P(0.95), 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
  drawSprite(ctx, 'mage', P(a.x), P(a.y), 32, { base: w.dead ? muted : accent, alpha: w.dead ? 0.5 : 1 });
  bar(a.x, a.y - 0.35, a.hp / 100, c('--good'));
  missiles();
  // Staff charge pips.
  for (let i = 0; i < CHARGES; i++) {
    ctx.fillStyle = i < a.charges ? ink : c('--line');
    ctx.fillRect(P(a.x) - 12 + i * 4.2, P(a.y) + 19, 3, 3);
  }
  // Progress ring for recharge / heal.
  const prog = a.rechargeT > 0 ? a.rechargeT / 15 : a.healT > 0 ? a.healT / 20 : 0;
  if (prog > 0) {
    ctx.strokeStyle = actCol;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(P(a.x), P(a.y), 20, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
  ctx.font = `600 12px ${c('--f-body')}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const label = ACTION_NAMES[a.action];
  const ty = a.y < 2 ? P(a.y) + 40 : P(a.y) - 30;
  ctx.fillStyle = c('--bg');
  const tw = ctx.measureText(label).width + 8;
  ctx.globalAlpha = 0.8;
  ctx.fillRect(P(a.x) - tw / 2, ty - 12, tw, 16);
  ctx.globalAlpha = 1;
  ctx.fillStyle = actCol;
  ctx.fillText(label, P(a.x), ty);

  ctx.textAlign = 'left';
  ctx.font = `12px ${c('--f-mono')}`;
  ctx.fillStyle = muted;
  ctx.fillText(`${w.seconds.toFixed(1)} s · wave ${w.wave}${opt.caption ? ' · ' + opt.caption : ''}`, 8, cnv.height - 8);
  if (w.dead) {
    ctx.fillStyle = c('--bg');
    ctx.globalAlpha = 0.6;
    ctx.fillRect(0, 0, cnv.width, cnv.height);
    ctx.globalAlpha = 1;
    ctx.fillStyle = alert;
    ctx.font = `600 22px ${c('--f-body')}`;
    ctx.textAlign = 'center';
    ctx.fillText(`Down after ${w.seconds.toFixed(0)} s, ${w.stats.kills} kills`, cnv.width / 2, cnv.height / 2);
  }
}

// ---------------------------------------------------------------------------
// History: actions (and optionally scores) per tick, drawn as a strip and chart.

export class History {
  actions: ActionId[] = [];
  scores: Array<Partial<Record<ActionId, number>>> = [];
  constructor(public span = 20 * TICK_HZ) {}
  push(a: ActionId, s?: Partial<Record<ActionId, number>>): void {
    this.actions.push(a);
    if (s) this.scores.push(s);
    if (this.actions.length > this.span) this.actions.shift();
    if (this.scores.length > this.span) this.scores.shift();
  }
  clear(): void {
    this.actions = [];
    this.scores = [];
  }
}

export function stripCanvas(): HTMLCanvasElement {
  return h('canvas', { class: 'ai-strip', width: '720', height: '22', 'aria-label': 'Actions over the last 20 seconds' });
}

export function drawStrip(cnv: HTMLCanvasElement, hist: History): void {
  const ctx = cnv.getContext('2d')!;
  ctx.fillStyle = tok(cnv, '--bg');
  ctx.fillRect(0, 0, cnv.width, cnv.height);
  const n = hist.span;
  const dx = cnv.width / n;
  const off = n - hist.actions.length;
  const cols: Partial<Record<ActionId, string>> = {};
  hist.actions.forEach((a, i) => {
    ctx.fillStyle = cols[a] ??= tok(cnv, ACTION_COL[a]);
    ctx.fillRect((off + i) * dx, 2, Math.ceil(dx), cnv.height - 4);
  });
}

export function chartCanvas(): HTMLCanvasElement {
  return h('canvas', { class: 'ai-chart', width: '720', height: '150', 'aria-label': 'Scores over the last 20 seconds' });
}

export function drawScores(cnv: HTMLCanvasElement, hist: History, actions: ActionId[] = ACTIONS): void {
  const ctx = cnv.getContext('2d')!;
  const cw = cnv.width;
  const ch = cnv.height;
  ctx.fillStyle = tok(cnv, '--bg');
  ctx.fillRect(0, 0, cw, ch);
  let max = 1;
  for (const s of hist.scores) for (const a of actions) max = Math.max(max, s[a] ?? 0);
  const Y = (v: number) => ch - 4 - (v / max) * (ch - 10);
  ctx.strokeStyle = tok(cnv, '--line-soft');
  ctx.beginPath();
  for (const v of [0.25, 0.5, 0.75, 1]) {
    ctx.moveTo(0, Y(v) + 0.5);
    ctx.lineTo(cw, Y(v) + 0.5);
  }
  ctx.stroke();
  ctx.fillStyle = tok(cnv, '--muted');
  ctx.font = `10px ${tok(cnv, '--f-mono')}`;
  ctx.fillText('1.0', 3, Y(1) + 11);
  const n = hist.span;
  const dx = cw / n;
  const off = n - hist.scores.length;
  for (const a of actions) {
    ctx.strokeStyle = tok(cnv, ACTION_COL[a]);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let pen = false;
    hist.scores.forEach((s, i) => {
      const v = s[a];
      if (v === undefined) {
        pen = false;
        return;
      }
      const x = (off + i) * dx;
      if (pen) ctx.lineTo(x, Y(v));
      else ctx.moveTo(x, Y(v));
      pen = true;
    });
    ctx.stroke();
  }
  // Mark the chosen action along the top.
  const cols: Partial<Record<ActionId, string>> = {};
  hist.actions.forEach((a, i) => {
    ctx.fillStyle = cols[a] ??= tok(cnv, ACTION_COL[a]);
    ctx.fillRect((n - hist.actions.length + i) * dx, 0, Math.ceil(dx), 3);
  });
  ctx.lineWidth = 1;
}

// ---------------------------------------------------------------------------
// Playback

export type Speed = 1 | 4 | 16;

/** Drives a world + brain at TICK_HZ × speed, only while visible on screen. */
export class Runner {
  playing = false;
  speed: Speed = 1;
  private acc = 0;
  private last = 0;
  private visible = true;
  private raf = 0;
  constructor(
    host: HTMLElement,
    public tick: () => void,
    public draw: () => void,
    public isDone: () => boolean,
    /** Optional cheap redraw for frames between ticks (just the arena), so missiles and units move smoothly. */
    public frame?: () => void,
  ) {
    new IntersectionObserver((es) => {
      this.visible = es.some((e) => e.isIntersecting);
      if (this.visible && this.playing) this.loop();
    }).observe(host);
  }
  play(on = !this.playing): void {
    this.playing = on;
    if (on) this.loop();
  }
  step(): void {
    this.playing = false;
    if (!this.isDone()) this.tick();
    arenaFrac = 1;
    this.draw();
  }
  private loop(): void {
    cancelAnimationFrame(this.raf);
    this.last = performance.now();
    const f = (t: number) => {
      if (!this.playing || !this.visible) return;
      this.acc += Math.min(250, t - this.last) * this.speed;
      this.last = t;
      let n = 0;
      while (this.acc >= 1000 / TICK_HZ && n < 64) {
        this.acc -= 1000 / TICK_HZ;
        if (this.isDone()) {
          this.playing = false;
          break;
        }
        this.tick();
        n++;
      }
      arenaFrac = Math.min(1, this.acc / (1000 / TICK_HZ));
      if (n) this.draw();
      else if (this.frame) this.frame();
      if (this.playing) this.raf = requestAnimationFrame(f);
      else {
        arenaFrac = 1;
        this.draw();
      }
    };
    this.raf = requestAnimationFrame(f);
  }
}

export function stat(v: string, l: string): HTMLElement {
  return h('div', { class: 'll-stat' }, h('b', {}, v), h('span', {}, l));
}

/** One-line summary of a run. */
export function statsRow(w: World, brain?: Brain): HTMLElement[] {
  const min = Math.max(1 / 60, w.seconds / 60);
  return [
    stat(`${w.seconds.toFixed(0)} s`, w.dead ? 'survived' : 'alive'),
    stat(String(w.stats.kills), 'kills'),
    stat((w.stats.switches / min).toFixed(0), 'switches / min'),
    stat(String(w.stats.wasted), 'recharges & heals interrupted'),
    ...(brain ? [stat(String(brain.cost), `${brain.costUnit}, last tick`)] : []),
  ];
}
