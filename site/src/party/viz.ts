/** The boss fight widget: a party of five against an orc warchief, with its threat table, the cleric's triage and telegraphs, live. */
import { fmt, h, seg } from '../engine/dom';
import { type Flight, drawFlights, drawSprite, launch, onSprites, spriteSize } from '../sprites/sprites';
import {
  AH, AW, BOSS_DEFAULTS, BossFight, MELEE_MARGIN, RANGED_MARGIN, SETUPS, SPELLS, TICK_HZ, summarise,
  type BossSettings, type DpsPolicy, type HealPolicy, type Member, type Targeting, type Telegraph,
} from './sim';

function css(el: Element) {
  const cs = getComputedStyle(el);
  const g = (n: string, f = '#888') => cs.getPropertyValue(n).trim() || f;
  return {
    floor: g('--floor', '#1d222b'),
    grid: g('--grid', '#232933'),
    line: g('--line', '#444'),
    tank: g('--accent'),
    healer: g('--good'),
    damage: g('--c2', '#5fd4e8'),
    enemy: g('--alert'),
    gold: g('--warn'),
    ink: g('--ink'),
    muted: g('--muted'),
    bg: g('--bg'),
    mono: g('--f-mono', 'monospace'),
  };
}
type Colours = ReturnType<typeof css>;
const roleColour = (c: Colours, m: Member) => (m.role === 'tank' ? c.tank : m.role === 'healer' ? c.healer : c.damage);

/** Short-lived drawings: telegraph bursts, war cries, sword swings, floating numbers. */
type Fx =
  | { k: 'boom'; t0: number; tg: Telegraph }
  | { k: 'cry'; t0: number; x: number; y: number }
  | { k: 'swing'; t0: number; x: number; y: number; dir: number; big: boolean }
  | { k: 'text'; t0: number; x: number; y: number; text: string; colour: 'heal' | 'hurt' | 'say' };

export class PartyViz {
  private root: HTMLElement;
  private cnv = h('canvas', { class: 'bf-map', 'aria-label': 'A party of five fighting an orc warchief: tank, cleric and three damage dealers' }) as HTMLCanvasElement;
  private stats = h('div', { class: 'll-stats' });
  private frames = h('div', { class: 'bf-frames' });
  private cleric = h('div', { class: 'bf-cleric' });
  private batch = h('div', { class: 'bf-batch' });
  private s: BossSettings = { ...BOSS_DEFAULTS };
  private sim!: BossFight;
  private playing = true;
  private visible = false;
  private speed = 1;
  private playBtn: HTMLButtonElement;
  /** Simulation time shown on screen, in seconds; runs smoothly between 10 Hz ticks. */
  private vt = 0;
  private last = 0;
  private raf = 0;
  private prev = new Map<string, [number, number]>();
  private flights: Flight[] = [];
  private fx: Fx[] = [];

  constructor(host: HTMLElement, preset: Partial<BossSettings> = {}) {
    Object.assign(this.s, preset);
    this.root = h('div', { class: 'll bf' });
    host.replaceChildren(this.root);
    this.playBtn = h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.toggle() }, 'Pause') as HTMLButtonElement;
    const restart = () => this.reset();
    const set = <K extends keyof BossSettings>(k: K) => (v: BossSettings[K]) => ((this.s[k] = v), restart());
    this.root.append(
      h('div', { class: 'll-row' }, seg<Targeting>('Boss hits', [['nearest', 'Nearest'], ['top', 'Top threat'], ['margin', 'Threat + 110/130%']], this.s.targeting, set('targeting')).el),
      h('div', { class: 'll-row' }, seg<HealPolicy>('Cleric', [['lowest', 'Lowest %'], ['triage', 'Triage']], this.s.heal, set('heal')).el),
      h('div', { class: 'll-row' }, seg<DpsPolicy>('Damage', [['nuke', 'Full speed'], ['careful', 'Careful']], this.s.dps, set('dps')).el),
      h('div', { class: 'll-row' }, seg<'0' | '1'>('Telegraphs', [['0', 'Ignore'], ['1', 'Dodge']], this.s.dodge ? '1' : '0', (v) => ((this.s.dodge = v === '1'), restart())).el),
      h(
        'div',
        { class: 'll-row' },
        this.playBtn,
        h('button', { type: 'button', class: 'll-btn', onclick: () => this.stepOnce() }, 'Step'),
        h('button', { type: 'button', class: 'll-btn', onclick: restart }, 'Restart'),
        h('button', { type: 'button', class: 'll-btn', onclick: () => ((this.s.seed = 1 + Math.floor(Math.random() * 999)), restart()) }, 'New fight'),
        seg<string>('Speed', ['1', '3'].map((x) => [x, `×${x}`] as [string, string]), '1', (v) => (this.speed = Number(v))).el,
      ),
      h('div', { class: 'bf-wrap' }, this.cnv),
      this.stats,
      h('div', { class: 'bf-panels' }, this.frames, this.cleric),
      h(
        'p',
        { class: 'll-muted bf-key' },
        'Purple ring: the tank. Green: the cleric. Cyan: damage dealers (a knight, a crossbow knight, a battle-mage). The red line runs from the warchief to whoever it is hitting. Red areas are telegraphed attacks: the inner fill grows until it lands. In the table, each threat bar has a tick where that member would pull the boss (110% of the target’s threat in melee range, 130% at range).',
      ),
      h('div', { class: 'll-row' }, h('button', { type: 'button', class: 'll-btn', onclick: () => this.runBatch() }, 'Run every setup on 20 fights'), h('span', { class: 'll-muted' }, 'Headless; one switched to naive at a time.')),
      this.batch,
    );
    new ResizeObserver(() => this.draw()).observe(this.root);
    new IntersectionObserver((es) => {
      this.visible = es.some((e) => e.isIntersecting);
      if (this.visible && this.playing) this.loop();
    }).observe(this.cnv);
    new MutationObserver(() => this.draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    onSprites(() => this.draw());
    this.reset();
  }

  private reset(): void {
    this.sim = new BossFight({ ...this.s });
    this.vt = 0;
    this.flights = [];
    this.fx = [];
    this.snap();
    this.draw();
    if (this.playing) this.loop();
  }
  private toggle(): void {
    this.playing = !this.playing;
    this.playBtn.textContent = this.playing ? 'Pause' : 'Play';
    if (this.playing) {
      if (this.sim.stats.done) this.reset();
      else this.loop();
    } else cancelAnimationFrame(this.raf);
  }
  private stepOnce(): void {
    if (this.playing) this.toggle();
    if (this.sim.stats.done) return;
    this.stepSim();
    this.vt = this.sim.tick / TICK_HZ;
    this.draw();
  }

  private snap(): void {
    this.prev.clear();
    this.sim.members.forEach((m, i) => this.prev.set(`m${i}`, [m.x, m.y]));
    this.sim.enemies.forEach((e, i) => this.prev.set(`e${i}`, [e.x, e.y]));
  }

  /** One simulation tick; turns its events into missiles and effects. */
  private stepSim(): void {
    const sim = this.sim;
    this.snap();
    sim.step();
    const t0 = sim.tick / TICK_HZ;
    for (const e of sim.events) {
      if (e.t === 'shot') this.flights.push(launch(e.kind, e.x0, e.y0, e.x1, e.y1, t0));
      else if (e.t === 'boom') this.fx.push({ k: 'boom', t0, tg: e.tg });
      else if (e.t === 'cry') this.fx.push({ k: 'cry', t0, x: e.x, y: e.y });
      else if (e.t === 'swing') this.fx.push({ k: 'swing', t0, x: e.x, y: e.y, dir: e.dir, big: e.big });
      else if (e.t === 'say') this.fx.push({ k: 'text', t0, x: e.x, y: e.y, text: e.text, colour: 'say' });
      else if (e.t === 'heal' && e.amount > 0) {
        const m = sim.members[e.who];
        this.fx.push({ k: 'text', t0, x: m.x, y: m.y - 1.4, text: `+${e.amount}`, colour: 'heal' });
      } else if (e.t === 'hurt' && e.amount >= 250) {
        const m = sim.members[e.who];
        this.fx.push({ k: 'text', t0, x: m.x + 0.8, y: m.y - 0.6, text: `−${e.amount}`, colour: 'hurt' });
      }
    }
  }

  private loop(): void {
    cancelAnimationFrame(this.raf);
    this.last = performance.now();
    const f = (now: number) => {
      if (!this.playing || !this.visible) return;
      this.vt += (Math.min(250, now - this.last) / 1000) * this.speed;
      this.last = now;
      let n = 0;
      while (!this.sim.stats.done && this.sim.tick < Math.floor(this.vt * TICK_HZ) && n++ < 32) this.stepSim();
      if (this.sim.stats.done) this.vt = Math.min(this.vt, this.sim.tick / TICK_HZ + 2);
      this.draw();
      if (!this.sim.stats.done || this.flights.length || this.fx.length) this.raf = requestAnimationFrame(f);
    };
    this.raf = requestAnimationFrame(f);
  }

  private draw(): void {
    const sim = this.sim;
    if (!sim) return;
    const c = css(this.root);
    const wpx = Math.max(280, this.cnv.parentElement!.clientWidth);
    const S = Math.max(7, Math.min(20, Math.floor(wpx / AW)));
    const dpr = window.devicePixelRatio || 1;
    if (this.cnv.width !== AW * S * dpr) {
      this.cnv.width = AW * S * dpr;
      this.cnv.height = AH * S * dpr;
      this.cnv.style.width = `${AW * S}px`;
      this.cnv.style.height = `${AH * S}px`;
    }
    const ctx = this.cnv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const P = (v: number) => v * S;
    const now = this.vt;
    const frac = sim.stats.done ? 1 : Math.max(0, Math.min(1, now * TICK_HZ - sim.tick));
    const at = (key: string, x: number, y: number): [number, number] => {
      const p = this.prev.get(key) ?? [x, y];
      return [P(p[0] + (x - p[0]) * frac), P(p[1] + (y - p[1]) * frac)];
    };

    // Floor: flagstones.
    ctx.fillStyle = c.floor;
    ctx.fillRect(0, 0, AW * S, AH * S);
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 4; x < AW; x += 4) (ctx.moveTo(P(x) + 0.5, 0), ctx.lineTo(P(x) + 0.5, AH * S));
    for (let y = 4; y < AH; y += 4) (ctx.moveTo(0, P(y) + 0.5), ctx.lineTo(AW * S, P(y) + 0.5));
    ctx.stroke();

    // Telegraphs: the whole area faint, an inner fill growing until it lands.
    const tickNow = now * TICK_HZ;
    for (const g of sim.telegraphs) {
      const p = Math.max(0, Math.min(1, (tickNow - g.start) / (g.end - g.start)));
      this.shape(ctx, g, P, 1);
      ctx.fillStyle = c.enemy;
      ctx.globalAlpha = 0.14;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = c.enemy;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      this.shape(ctx, g, P, p);
      ctx.globalAlpha = 0.32;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // Bursts and war cries.
    this.fx = this.fx.filter((f) => now - f.t0 < (f.k === 'text' ? 1.2 : 0.6));
    for (const f of this.fx) {
      const a = (now - f.t0) / 0.6;
      if (f.k === 'boom') {
        this.shape(ctx, f.tg, P, 1);
        ctx.fillStyle = c.gold;
        ctx.globalAlpha = Math.max(0, 0.55 * (1 - a));
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (f.k === 'cry') {
        ctx.strokeStyle = c.enemy;
        ctx.globalAlpha = Math.max(0, 1 - a);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(P(f.x), P(f.y), P(2 + a * 18), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    const size = spriteSize(Math.max(16, S * 1.5));
    const b = sim.boss;
    const [bx, by] = at('e0', b.x, b.y);
    // Who the warchief is hitting.
    if (b.alive && b.target >= 0) {
      const t = sim.members[b.target];
      const [tx, ty] = at(`m${b.target}`, t.x, t.y);
      ctx.strokeStyle = c.enemy;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    // The cleric's cast: a line to the target and a ring that fills.
    const cl = sim.members[1];
    if (sim.cast && cl.alive) {
      const t = sim.members[sim.cast.target];
      const [cx, cy] = at('m1', cl.x, cl.y);
      const [tx, ty] = at(`m${t.id}`, t.x, t.y);
      ctx.strokeStyle = c.healer;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const p = Math.max(0, Math.min(1, (tickNow - sim.cast.start) / (sim.cast.end - sim.cast.start)));
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.7, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      ctx.stroke();
    }

    // Goblin archers.
    sim.enemies.forEach((e, i) => {
      if (e.boss || !e.alive) return;
      const [x, y] = at(`e${i}`, e.x, e.y);
      drawSprite(ctx, 'goblinArcher', x, y, size, { base: c.enemy, flip: e.x > AW / 2 });
      this.bar(ctx, x - size * 0.45, y - size * 0.75, size * 0.9, e.hp / e.maxHp, c.enemy, c);
    });
    // The warchief: a big orc, facing shown by a wedge.
    if (b.alive) {
      const bs = spriteSize(size * 2.4);
      ctx.fillStyle = c.enemy;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      const r0 = bs * 0.55;
      ctx.moveTo(bx + Math.cos(b.facing) * (r0 + 9), by + Math.sin(b.facing) * (r0 + 9));
      ctx.lineTo(bx + Math.cos(b.facing + 0.35) * r0, by + Math.sin(b.facing + 0.35) * r0);
      ctx.lineTo(bx + Math.cos(b.facing - 0.35) * r0, by + Math.sin(b.facing - 0.35) * r0);
      ctx.fill();
      ctx.globalAlpha = 1;
      drawSprite(ctx, 'orc', bx, by, bs, { base: c.enemy, flip: Math.cos(b.facing) < 0 });
      this.bar(ctx, bx - bs * 0.6, by - bs * 0.68, bs * 1.2, b.hp / b.maxHp, c.enemy, c, 5);
    }
    // The party.
    sim.members.forEach((m, i) => {
      const [x, y] = at(`m${i}`, m.x, m.y);
      drawSprite(ctx, m.look, x, y, size, { base: roleColour(c, m), alpha: m.alive ? 1 : 0.28, flip: m.alive && b.x < m.x });
      if (!m.alive) return;
      this.bar(ctx, x - size * 0.45, y - size * 0.78, size * 0.9, m.hp / m.maxHp, roleColour(c, m), c);
      if (m.holding) this.label(ctx, '‖', x + size * 0.55, y - size * 0.2, c.gold, c, Math.max(10, S * 0.8));
    });
    // Sword swings.
    for (const f of this.fx) {
      if (f.k !== 'swing') continue;
      const a = (now - f.t0) / 0.25;
      if (a > 1) continue;
      ctx.strokeStyle = f.big ? c.enemy : c.ink;
      ctx.globalAlpha = 1 - a;
      ctx.lineWidth = f.big ? 3 : 2;
      ctx.beginPath();
      const r = f.big ? size * 1.3 : size * 0.7;
      ctx.arc(P(f.x), P(f.y), r, f.dir - 0.7 + a * 0.4, f.dir + 0.3 + a * 0.4);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Missiles in flight.
    this.flights = drawFlights(ctx, this.flights, now, P, Math.max(0.8, S / 11));
    // Floating text.
    for (const f of this.fx) {
      if (f.k !== 'text') continue;
      const a = (now - f.t0) / 1.2;
      ctx.globalAlpha = Math.min(1, 2.5 * (1 - a));
      const col = f.colour === 'heal' ? c.healer : f.colour === 'hurt' ? c.enemy : c.gold;
      this.label(ctx, f.text, P(f.x), P(f.y) - a * 14, col, c, Math.max(10, Math.min(14, S * 0.75)), f.colour === 'say');
      ctx.globalAlpha = 1;
    }
    if (sim.stats.done) {
      ctx.fillStyle = c.bg;
      ctx.globalAlpha = 0.6;
      ctx.fillRect(0, AH * S * 0.42, AW * S, AH * S * 0.16);
      ctx.globalAlpha = 1;
      this.label(ctx, sim.stats.won ? 'The warchief falls' : 'Wiped', (AW * S) / 2, AH * S * 0.5 + 6, sim.stats.won ? c.healer : c.enemy, c, Math.max(14, S * 1.2), true, 'center');
    }
    this.panels(c);
  }

  /** Path for a telegraph, scaled by `k` (0..1) for the growing fill. */
  private shape(ctx: CanvasRenderingContext2D, g: Telegraph, P: (v: number) => number, k: number): void {
    ctx.beginPath();
    if (g.kind === 'slam') ctx.arc(P(g.x), P(g.y), P(g.r * k), 0, Math.PI * 2);
    else {
      ctx.moveTo(P(g.x), P(g.y));
      ctx.arc(P(g.x), P(g.y), P(g.r * k), g.dir - g.half, g.dir + g.half);
      ctx.closePath();
    }
  }

  private bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, f: number, col: string, c: Colours, hgt = 4): void {
    ctx.fillStyle = c.bg;
    ctx.fillRect(x - 1, y - 1, w + 2, hgt + 2);
    ctx.fillStyle = f < 0.3 ? c.enemy : col;
    ctx.fillRect(x, y, w * Math.max(0, f), hgt);
  }

  private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, col: string, c: Colours, px: number, bold = false, align: CanvasTextAlign = 'left'): void {
    ctx.font = `${bold ? 700 : 600} ${px}px ${c.mono}`;
    ctx.textAlign = align;
    ctx.lineWidth = 3;
    ctx.strokeStyle = c.bg;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = col;
    ctx.fillText(text, x, y);
    ctx.textAlign = 'left';
  }

  /** The party frames (health, threat on the warchief, the cleric's scores) and the cleric's cast. */
  private panels(c: Colours): void {
    const sim = this.sim;
    const b = sim.boss;
    const st = sim.stats;
    const s = (v: string, l: string) => h('div', { class: 'll-stat' }, h('b', {}, v), h('span', {}, l));
    const dead = st.deaths.tank + st.deaths.healer + st.deaths.damage;
    this.stats.replaceChildren(
      s(`${fmt(st.time, 1)} s`, st.done ? (st.won ? 'won' : 'wiped') : 'fighting'),
      s(`${fmt((100 * b.hp) / b.maxHp)}%`, 'warchief health'),
      s(String(dead), dead === 1 ? 'death' : 'deaths'),
      s(String(st.switches), 'target switches'),
      s(`${st.healed ? fmt((100 * st.overheal) / st.healed) : 0}%`, 'overheal'),
    );
    const top = Math.max(1, ...b.threat);
    const cur = b.target >= 0 ? b.threat[b.target] : 0;
    const scores = new Map(sim.options.map((o) => [o.who, o]));
    const best = Math.max(0.01, ...sim.options.map((o) => o.score));
    const rows = sim.members.map((m) => {
      const near = Math.hypot(m.x - b.x, m.y - b.y) <= 4;
      const pull = sim.s.targeting === 'margin' ? cur * (near ? MELEE_MARGIN : RANGED_MARGIN) : cur;
      const scale = Math.max(top, pull) * 1.05;
      const o = scores.get(m.id);
      const isTarget = b.target === m.id;
      return h(
        'div',
        { class: `bf-row${m.alive ? '' : ' dead'}${isTarget ? ' target' : ''}` },
        h('span', { class: 'bf-name', style: `--k:${roleColour(c, m)}` }, m.name),
        h('span', { class: 'bf-bar hp', title: `${m.hp} / ${m.maxHp}` }, h('i', { style: `width:${(100 * m.hp) / m.maxHp}%` })),
        h(
          'span',
          { class: 'bf-bar threat', title: `${fmt(b.threat[m.id])} threat` },
          h('i', { style: `width:${(100 * b.threat[m.id]) / scale}%` }),
          !isTarget && b.target >= 0 && sim.s.targeting !== 'nearest' && m.alive ? h('b', { style: `left:${(100 * pull) / scale}%` }) : null,
        ),
        h('span', { class: 'bf-score' }, o && o.score > 0 ? h('i', { style: `width:${(100 * o.score) / best}%` }) : null, o && o.score > 0 ? fmt(o.score, 2) : '–'),
      );
    });
    this.frames.replaceChildren(
      h('div', { class: 'bf-row head' }, h('span', {}, ''), h('span', {}, 'Health'), h('span', {}, 'Threat on the warchief'), h('span', {}, 'Heal score')),
      ...rows,
    );
    const cast = sim.cast;
    const manaPct = (100 * sim.mana) / sim.maxMana;
    this.cleric.replaceChildren(
      h('div', { class: 'll-h' }, 'Cleric'),
      h('div', { class: 'bf-mana' }, h('span', { class: 'bf-bar mana' }, h('i', { style: `width:${manaPct}%` })), h('span', { class: 'll-muted' }, `mana ${fmt(sim.mana)}`)),
      h(
        'div',
        {},
        cast
          ? `${SPELLS[cast.spell].name} (${SPELLS[cast.spell].cast} s) on the ${sim.members[cast.target].name.toLowerCase()}, score ${fmt(cast.score, 2)}`
          : sim.members[1].alive
            ? sim.members[1].dodging
              ? 'Getting out of a telegraph.'
              : 'Waiting: nothing worth a heal.'
            : 'Dead.',
      ),
    );
  }

  private runBatch(): void {
    const head = ['Setup', 'Wins', 'Fight', 'Deaths: tank, cleric, damage', 'Boss off the tank', 'Switches', 'Overheal'];
    const table = h('table', { class: 'det-table' }, h('thead', {}, h('tr', {}, ...head.map((t) => h('th', {}, t)))), h('tbody', {}));
    this.batch.replaceChildren(h('div', { class: 'det-sums' }, table));
    const tbody = table.querySelector('tbody')!;
    let k = 0;
    const next = () => {
      if (k >= SETUPS.length) return;
      const [name, over] = SETUPS[k++];
      setTimeout(() => {
        const r = summarise(over, 20);
        tbody.append(
          h(
            'tr',
            {},
            h('td', {}, name),
            h('td', {}, `${r.wins}/20`),
            h('td', {}, `${fmt(r.time)} s`),
            h('td', {}, `${r.deaths.tank}, ${r.deaths.healer}, ${r.deaths.damage}`),
            h('td', {}, `${fmt(r.offTank, 1)} s`),
            h('td', {}, fmt(r.switches, 1)),
            h('td', {}, `${fmt((100 * r.overheal) / r.healed)}%`),
          ),
        );
        next();
      }, 0);
    };
    next();
  }
}
