/**
 * Shared knowledge widget: adventuring parties and the guild board. The map shows where each party is heading
 * and why, and where the board now says its quarry is; the cards show the guild, party and adventurer boards;
 * the flow diagram shows what moves between them, a second at a time. Parties only post and read at waystones.
 */
import { fmt, h, seg } from '../engine/dom';
import { type SpriteId, drawSprite, onSprites, spriteSize } from '../sprites/sprites';
import { DURATION, PLACES, REACH, VH, VW, mmssOf as mmss, runGuild, staleSeconds, type BoardRow, type Preset, type Role, type VRun } from './village';
import './knowledge.css';

function css(el: Element) {
  const cs = getComputedStyle(el);
  const g = (n: string, f = '#888') => cs.getPropertyValue(n).trim() || f;
  return {
    bg: g('--bg'),
    floor: g('--floor', '#1d222b'),
    wall: g('--wall', '#6b7686'),
    road: g('--t-road', '#5a523c'),
    field: g('--t-rough', '#33493c'),
    water: g('--t-water', '#27406a'),
    soft: g('--line-soft'),
    ink: g('--ink'),
    muted: g('--muted'),
    warn: g('--warn'),
    alert: g('--alert'),
    mono: g('--f-mono', 'monospace'),
    /** Party colours. */
    party: [g('--c2', '#5fd4e8'), g('--c4', '#8be28b'), g('--c5', '#b69cff'), g('--c7', '#7aa2ff')],
  };
}
type Cols = ReturnType<typeof css>;

const KIND_LABEL: Record<string, string> = { quest: 'Quest', claim: 'Claim', sighting: 'Sighting', report: 'Report' };
const RANK: Record<string, number> = { quest: 0, claim: 1, report: 2, sighting: 3 };
const SPRITE: Record<Role, SpriteId> = { front: 'knight', map: 'mage', loot: 'crossbow' };
const ROLE_TEXT: Record<Role, string> = { front: 'walks in front', map: 'keeps the map', loot: 'carries the packs' };
const stat = (v: string, l: string) => h('div', { class: 'll-stat' }, h('b', {}, v), h('span', {}, l));

export class KnowledgeViz {
  private root: HTMLElement;
  private map = h('canvas', { class: 'kn-map', 'aria-label': 'The countryside around the guild town, with parties, waystones and what the chosen party knows' }) as HTMLCanvasElement;
  private flow = h('canvas', { class: 'kn-flow', 'aria-label': 'Entries posted up to the guild board and read back down at waystones' }) as HTMLCanvasElement;
  private note = h('p', { class: 'kn-note' });
  private cards = h('div', { class: 'kn-boards' });
  private slider: HTMLInputElement;
  private timeLbl = h('b', { class: 'kn-clock' });
  /** What's happening this second: its own line, so the slider never resizes. */
  private stageLbl = h('span', { class: 'll-muted kn-stage' });
  private playBtn: HTMLButtonElement;
  private stats = h('div', { class: 'll-stats' });
  private preset: Preset;
  private anywhere = false;
  private cap = Infinity;
  private run: VRun;
  private stale = 0;
  /** Selected party (index into run.parties) and adventurer (index into a step's adventurers). */
  private party = 0;
  private member = 0;
  private playing = false;
  private phase = 1;
  private last = 0;
  private raf = 0;
  private tickMs = 900;
  private S = 6;

  constructor(host: HTMLElement, opts: { preset?: Preset } = {}) {
    this.preset = opts.preset ?? 'simple';
    this.run = this.simulate();
    this.selectDefault();
    this.root = h('div', { class: 'll kn' });
    host.replaceChildren(this.root);
    this.slider = h('input', { type: 'range', min: 0, max: DURATION, value: 0, 'aria-label': 'Time' }) as HTMLInputElement;
    this.slider.addEventListener('input', () => ((this.phase = 1), this.draw()));
    this.playBtn = h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.toggle() }, 'Play') as HTMLButtonElement;
    const readSeg = seg<string>(
      'Party B reads the board',
      [
        ['stones', 'Only at waystones'],
        ['anywhere', 'Anywhere (for comparison)'],
      ],
      'stones',
      (v) => ((this.anywhere = v === 'anywhere'), this.rerun()),
    );
    const rows: HTMLElement[] = [h('div', { class: 'll-row' }, readSeg.el)];
    if (this.preset === 'full')
      rows[0].append(
        seg<string>(
          'The guild log keeps history',
          [
            ['inf', 'As long as a party needs it'],
            ['20', 'For 20 s, then snapshots'],
          ],
          'inf',
          (v) => ((this.cap = v === 'inf' ? Infinity : 20), this.rerun()),
        ).el,
      );
    const speed = seg<string>(
      'Speed',
      [
        ['900', 'Slow'],
        ['250', 'Fast'],
      ],
      '900',
      (v) => (this.tickMs = Number(v)),
    );
    const key = h(
      'div',
      { class: 'im-keys' },
      h('span', { class: 'im-key ring', style: `--k: var(--ink)` }, 'ring: where a party is heading, from its own board'),
      h('span', { class: 'im-key dash', style: `--k: var(--warn)` }, 'dashes: where the guild board now says'),
      h('span', { class: 'im-key ring', style: `--k: var(--alert)` }, 'red rings: last known place of a monster, with age'),
      h('span', { class: 'im-key dot', style: `--k: var(--muted)` }, 'grey stones: waystones'),
    );
    this.root.append(
      ...rows,
      h('div', { class: 'll-row kn-time' }, this.playBtn, h('button', { type: 'button', class: 'll-btn', onclick: () => this.step() }, 'Step'), this.slider, this.timeLbl),
      h('div', { class: 'll-row' }, speed.el, h('span', { class: 'll-muted' }, 'Click an adventurer on the map to read its boards.'), this.stageLbl),
      this.note,
      h('div', { class: 'kn-mapwrap' }, this.map),
      key,
      this.cards,
      this.flow,
      this.stats,
    );
    this.map.addEventListener('pointerdown', (e) => this.pick(e));
    new ResizeObserver(() => this.draw()).observe(this.root);
    new MutationObserver(() => this.draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    onSprites(() => this.draw());
    this.draw();
  }

  private simulate(): VRun {
    const run = runGuild(this.preset, this.anywhere, this.cap);
    this.stale = staleSeconds(run, 'B', 'troll');
    return run;
  }
  /** Party B, the one heading for the troll. */
  private selectDefault(): void {
    this.party = this.run.parties.findIndex((p) => p.name === 'B');
    this.member = this.run.steps[0].adventurers.findIndex((a) => a.party === this.party && a.role === 'front');
  }
  private rerun(): void {
    this.run = this.simulate();
    this.phase = 1;
    this.draw();
  }

  // -------------------------------------------------------------------- playback

  private toggle(): void {
    this.playing = !this.playing;
    this.playBtn.textContent = this.playing ? 'Pause' : 'Play';
    if (!this.playing) return;
    if (Number(this.slider.value) >= DURATION) this.slider.value = '0';
    this.last = performance.now();
    this.loop(false);
  }
  private step(): void {
    if (Number(this.slider.value) >= DURATION) return;
    this.slider.value = String(Number(this.slider.value) + 1);
    this.phase = 0;
    this.draw();
    if (!this.playing) {
      this.last = performance.now();
      this.loop(true);
    }
  }
  private loop(once: boolean): void {
    cancelAnimationFrame(this.raf);
    const frame = (now: number) => {
      this.phase += (now - this.last) / this.tickMs;
      this.last = now;
      if (this.phase >= 1) {
        if (once || !this.playing) {
          this.phase = 1;
          this.drawFlow(css(this.root));
          return;
        }
        const t = Number(this.slider.value) + 1;
        if (t > DURATION) {
          this.toggle();
          this.phase = 1;
          this.drawFlow(css(this.root));
          return;
        }
        this.slider.value = String(t);
        this.phase = 0;
        this.draw();
      } else this.drawFlow(css(this.root));
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private pick(e: PointerEvent): void {
    const b = this.map.getBoundingClientRect();
    const x = (e.clientX - b.left) / this.S;
    const y = (e.clientY - b.top) / this.S;
    const st = this.run.steps[this.t()];
    let best = -1;
    let bd = 5;
    st.adventurers.forEach((a, i) => {
      const d = Math.hypot(a.x + 0.5 - x, a.y + 0.5 - y);
      if (d < bd) ((bd = d), (best = i));
    });
    if (best < 0) return;
    this.member = best;
    this.party = st.adventurers[best].party;
    this.draw();
  }

  // -------------------------------------------------------------------- drawing

  private col(c: Cols, p: number): string {
    return c.party[p % c.party.length];
  }
  private t(): number {
    return Number(this.slider.value);
  }

  private draw(): void {
    const c = css(this.root);
    const st = this.run.steps[this.t()];
    this.drawMap(c);
    this.drawNote();
    this.drawCards();
    this.drawFlow(c);
    const B = this.run.parties.findIndex((p) => p.name === 'B');
    const behind = st.head - st.parties[B].watermark;
    this.stats.replaceChildren(
      stat(`v${fmt(st.head)}`, 'guild log head'),
      stat(`${fmt(st.kept)}${st.snapshots ? ` + ${fmt(st.snapshots)}` : ''}`, st.snapshots ? 'records the log keeps, plus snapshots' : 'records the log keeps'),
      stat(behind ? `${fmt(behind)} behind` : 'up to date', 'party B’s watermark'),
      stat(`${this.stale} s`, 'B spent heading for a notice the guild had already moved'),
    );
  }

  /** One line saying what matters right now. */
  private drawNote(): void {
    const t = this.t();
    const st = this.run.steps[t];
    const notes: (string | HTMLElement)[] = [];
    // A party heading for a notice the board has since changed.
    st.parties.forEach((pv) => {
      if (!pv.quest || pv.done) return;
      const now = st.guild.find((r) => r.key === `quest:${pv.quest}`);
      if (!now || now.version <= pv.questVersion || now.time === 0) return;
      notes.push(
        h(
          'span',
          { class: 'kn-warn' },
          `At ${mmss(now.time)} the guild changed the notice party ${pv.name} is following: “${now.text}”. ${pv.name} last read the board at ${mmss(pv.readAt)}, so it’s still heading for ${PLACES.find((p) => pv.goal.x >= p.x0 && pv.goal.x <= p.x1 && pv.goal.y >= p.y0 && pv.goal.y <= p.y1)?.name ?? 'the old place'} (“${pv.questText}”).`,
        ),
      );
    });
    if (!notes.length) {
      const tr = st.traffic;
      const changed = st.parties.map((pv, p) => ({ pv, p })).filter(({ p }) => tr.questChanged[p] && t > 0);
      const older = st.parties.map((pv, p) => ({ pv, p })).filter(({ p }) => tr.older[p]);
      const clerk = st.guild.filter((r) => r.by === 'guild' && r.time === t && t > 0 && r.fresh);
      if (changed.length)
        notes.push(
          changed
            .map(({ pv, p }) => `Party ${pv.name} reads the board at ${pv.at === 'anywhere' ? 'wherever it is' : pv.at}: ${fmt(tr.caughtUp[p])} version${tr.caughtUp[p] === 1 ? '' : 's'} in one go, and its quest’s notice has changed. ${pv.quest ? `It re-plans: “${pv.questText}”.` : 'The quest is withdrawn, so it heads back to the guild hall.'}`)
            .join(' '),
        );
      else if (older.length)
        notes.push(
          older
            .map(({ pv, p }) => `Party ${pv.name} reaches ${pv.at} with ${tr.older[p]} entr${tr.older[p] === 1 ? 'y' : 'ies'} older than what the board already has for the same thing. They aren’t posted: the board merges by when something was true, not when it arrived.`)
            .join(' '),
        );
      else if (clerk.length) notes.push(`The guild clerk edits the board: ${clerk.map((r) => `“${r.text}”`).join(' and ')}.`);
      else if (t === 0) notes.push('Both parties are at the guild hall: each reads the board, picks the best quest it can take that nobody has claimed, and posts its claim.');
    }
    // Always shown, with a placeholder, so the map below doesn't jump as notes come and go.
    if (!notes.length) notes.push(h('span', { class: 'll-muted' }, 'Turning points are explained here as they happen.'));
    this.note.replaceChildren(...notes);
  }

  private drawMap(c: Cols): void {
    const t = this.t();
    const st = this.run.steps[t];
    const wpx = Math.max(280, this.root.clientWidth - 4);
    const S = Math.min(7, wpx / VW);
    this.S = S;
    const dpr = window.devicePixelRatio || 1;
    const cnv = this.map;
    cnv.width = VW * S * dpr;
    cnv.height = VH * S * dpr;
    cnv.style.width = `${VW * S}px`;
    cnv.style.height = `${VH * S}px`;
    const ctx = cnv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { world, look } = this.run.ground;
    ctx.fillStyle = c.floor;
    ctx.fillRect(0, 0, VW * S, VH * S);
    for (let y = 0; y < VH; y++)
      for (let x = 0; x < VW; x++) {
        const i = y * VW + x;
        const k = world.kind[i];
        const l = look[i];
        if (k === 4) ctx.fillStyle = c.water;
        else if (l === 2 || l === 3) ctx.fillStyle = c.road;
        else if (l === 4) ctx.fillStyle = c.field;
        else if (k === 2 && l !== 1) ctx.fillStyle = c.wall;
        else continue;
        if (l === 4) ctx.globalAlpha = y % 2 ? 0.35 : 0.5;
        ctx.fillRect(x * S, y * S, S + 0.5, S + 0.5);
        ctx.globalAlpha = 1;
        if (l === 3) {
          // The ford: water over the road.
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = c.water;
          ctx.fillRect(x * S, y * S + S / 2, S + 0.5, S / 2);
          ctx.globalAlpha = 1;
        }
      }
    // Trees: soft crowns.
    ctx.fillStyle = c.field;
    for (let y = 0; y < VH; y++)
      for (let x = 0; x < VW; x++) {
        if (look[y * VW + x] !== 1) continue;
        ctx.beginPath();
        ctx.arc((x + 0.5) * S, (y + 0.5) * S, S * 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
    const fs = Math.max(9, Math.round(S * 1.55));
    const P = (v: number) => (v + 0.5) * S;
    // Place names.
    ctx.font = `${fs}px ${c.mono}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = c.muted;
    for (const a of PLACES) {
      if (a.label === 'east bank' || a.label === 'crossroads' || a.label === 'mill') continue;
      ctx.fillText(a.label, a.x0 * S + 3, a.y0 * S + 3);
    }
    // Waystones: a standing stone, and the ring a party must step into.
    for (const s of this.run.waystones) {
      const here = st.parties.map((pv, p) => ({ pv, p })).filter(({ pv }) => pv.at === s.name);
      ctx.lineWidth = here.length ? 2 : 1;
      ctx.strokeStyle = here.length ? this.col(c, here[0].p) : c.muted;
      ctx.setLineDash(here.length ? [] : [2, 3]);
      ctx.beginPath();
      ctx.arc(P(s.x), P(s.y), REACH * S, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (s.name !== 'the guild hall') {
        const w = Math.max(4, S * 0.9);
        const hgt = Math.max(7, S * 1.7);
        ctx.fillStyle = c.muted;
        ctx.beginPath();
        ctx.roundRect(P(s.x) - w / 2, P(s.y) - hgt / 2, w, hgt, [w / 2, w / 2, 1, 1]);
        ctx.fill();
      }
    }
    // Monsters, as they really are: faint, because nobody knows this.
    for (const m of st.monsters) {
      if (!m.alive) continue;
      const size = spriteSize(Math.max(16, S * (m.kind === 'troll' ? 3.6 : 2.2)));
      drawSprite(ctx, m.kind === 'troll' ? 'orc' : 'goblinArcher', P(m.x), P(m.y), size, { alpha: 0.4, flip: true });
    }
    // What the selected party believes about the monsters: last known places, with their age.
    const sel = st.parties[this.party];
    ctx.font = `${Math.max(8, Math.round(S * 1.3))}px ${c.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const r of sel.rows) {
      if (r.kind !== 'sighting' || !r.pos || r.text.includes('gone')) continue;
      const age = t - r.time;
      ctx.globalAlpha = Math.max(0.4, 1 - age / 60);
      ctx.strokeStyle = c.alert;
      ctx.lineWidth = 2;
      ctx.setLineDash(age > 1 ? [3, 3] : []);
      ctx.beginPath();
      ctx.arc(P(r.pos.x), P(r.pos.y), 1.4 * S, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (age > 1) {
        ctx.fillStyle = c.ink;
        ctx.fillText(`${age}s`, P(r.pos.x), P(r.pos.y) - 1.6 * S);
      }
      ctx.globalAlpha = 1;
    }
    // Where each party is heading, and where the board now says, if it hasn't read that yet.
    st.parties.forEach((pv, p) => {
      const lead = st.adventurers.find((a) => a.party === p && a.role === 'front')!;
      const tx = P(pv.goal.x);
      const ty = P(pv.goal.y);
      const atGoal = Math.hypot(pv.goal.x - lead.x, pv.goal.y - lead.y) < 2;
      ctx.font = `600 ${fs}px ${c.mono}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      if (!atGoal) {
        ctx.strokeStyle = this.col(c, p);
        ctx.lineWidth = p === this.party ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.arc(tx, ty, 2.4 * S, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = this.col(c, p);
        ctx.fillText(pv.name, tx + 2.9 * S, ty);
      }
      if (!pv.quest || pv.done) return;
      const now = st.guild.find((r) => r.key === `quest:${pv.quest}`);
      if (!now?.pos || now.version <= pv.questVersion) return;
      ctx.strokeStyle = c.warn;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(P(now.pos.x), P(now.pos.y), 2.4 * S, 0, Math.PI * 2);
      ctx.moveTo(P(lead.x), P(lead.y));
      ctx.lineTo(P(now.pos.x), P(now.pos.y));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = c.warn;
      ctx.textAlign = 'right';
      ctx.fillText(S < 5 ? `board: ${pv.name} here` : `board now says ${pv.name}’s quarry is here`, P(now.pos.x) - 2.9 * S, P(now.pos.y));
    });
    // Adventurers.
    st.adventurers.forEach((a, i) => {
      const x = P(a.x);
      const y = P(a.y);
      drawSprite(ctx, SPRITE[a.role], x, y, spriteSize(Math.max(16, S * 2.4)), { base: this.col(c, a.party) });
      if (i === this.member) {
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.9 * S, 12), 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  }

  private drawCards(): void {
    const t = this.t();
    const st = this.run.steps[t];
    const pd = this.run.parties[this.party];
    const pv = st.parties[this.party];
    const a = st.adventurers[this.member];
    const sortRows = <T extends BoardRow>(rows: T[]) => [...rows].sort((x, y) => RANK[x.kind] - RANK[y.kind] || y.time - x.time);
    const src: Record<string, string> = { party: ' · own party', own: ' · own eyes', task: '', guild: '' };
    // A sighting seen again is routine; highlight it only when it's new to this board.
    const before = t ? this.run.steps[t - 1] : null;
    const prevKeys = new Set([...(before?.guild ?? []), ...(before?.parties[this.party].rows ?? []), ...(before?.boards[this.member] ?? [])].map((r) => r.key));
    const isFresh = (r: BoardRow) => r.fresh && t > 0 && (r.kind !== 'sighting' || !prevKeys.has(r.key) || r.text.includes('gone'));
    const row = (r: BoardRow, extra: HTMLElement[] = []) =>
      h(
        'li',
        { class: `kn-row kn-${r.kind}${r.quest && !r.quest.open ? ' kn-closed' : ''}${isFresh(r) ? ' kn-fresh' : ''}` },
        h('span', { class: 'kn-kind' }, r.from === 'task' ? 'Task' : KIND_LABEL[r.kind]),
        h('span', { class: 'kn-text' }, r.text),
        h('span', { class: 'kn-meta' }, `${r.kind === 'sighting' ? (t === r.time ? 'now' : `${t - r.time}s ago`) : `at ${mmss(r.time)}`}${r.version ? ` · v${r.version}` : ''}${src[r.from]}`),
        ...extra,
      );
    const behind = st.head - pv.watermark;
    const card = (title: string, sub: HTMLElement | string, rows: HTMLElement[], cls = '') =>
      h('section', { class: `kn-card ${cls}` }, h('h4', {}, title), h('p', { class: 'kn-sub' }, sub), h('ul', {}, ...rows));
    const guildRows = sortRows(st.guild).map((r) => row(r, r.notReadBy.includes(pd.name) ? [h('span', { class: 'kn-miss' }, `${pd.name} hasn’t read this`)] : []));
    const where = pv.at === 'anywhere' ? 'reading from anywhere' : pv.at ? `at ${pv.at}` : 'on the road';
    this.cards.replaceChildren(
      card('Guild board', `the guild hall · log at v${fmt(st.head)}`, guildRows),
      card(
        `Party ${pd.name}`,
        !behind
          ? `party board · ${where} · read up to v${fmt(pv.watermark)} (the head)${pv.waiting ? `; ${pv.waiting} entr${pv.waiting > 1 ? 'ies' : 'y'} waiting for a waystone` : ''}`
          : h(
              'span',
              { class: 'kn-warn' },
              `party board · ${where}: reads the log as of v${fmt(pv.watermark)} (read at ${mmss(pv.readAt)}), ${fmt(behind)} version${behind > 1 ? 's' : ''} behind${pv.waiting ? `; ${pv.waiting} entr${pv.waiting > 1 ? 'ies' : 'y'} waiting for a waystone` : ''}`,
            ),
        sortRows(pv.rows).map((r) => row(r)),
        behind ? 'kn-behind' : '',
      ),
      card(a.name, `adventurer board · ${ROLE_TEXT[a.role]} for party ${pd.name}`, st.boards[this.member].map((r) => row(r))),
    );
  }

  /** The guild board, the parties and their adventurers, and this second's traffic between them. */
  private drawFlow(c: Cols): void {
    const t = this.t();
    const st = this.run.steps[t];
    const prev = t ? this.run.steps[t - 1] : st;
    const tr = st.traffic;
    const cnv = this.flow;
    const dpr = window.devicePixelRatio || 1;
    const Wd = cnv.clientWidth || 700;
    const Hh = 236;
    cnv.width = Wd * dpr;
    cnv.height = Hh * dpr;
    cnv.style.height = `${Hh}px`;
    const ctx = cnv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, Wd, Hh);
    const parties = this.run.parties.map((q, p) => ({ q, p }));
    const pad = 8;
    const colW = (Wd - pad * 2) / parties.length;
    const sx = (k: number) => pad + colW * k + colW / 2;
    const hy0 = 8;
    const hy1 = 50;
    const sy0 = 100;
    const sy1 = 144;
    const uy = 190;
    const small = colW < 170;
    const tiny = colW < 110;
    const font = (px: number, w = 400) => (ctx.font = `${w} ${px}px ${c.mono}`);
    ctx.textBaseline = 'middle';
    const clamp = (x: number) => Math.max(0, Math.min(1, x));
    const ease = (x: number) => x * x * (3 - 2 * x);
    const animating = this.phase < 1;
    const beat = (k: number) => ease(clamp((this.phase - k * 0.25) / 0.25));
    const members = (p: number) => st.adventurers.map((a, i) => ({ a, i })).filter((x) => x.a.party === p);
    const ux = (k: number, j: number, n: number) => sx(k) + (j - (n - 1) / 2) * Math.min(30, colW / (n + 0.5));
    const foot = (k: number, j: number, n: number) => sx(k) + (ux(k, j, n) - sx(k)) * 0.35;
    const line = (x0: number, y0: number, x1: number, y1: number, open: boolean) => {
      ctx.strokeStyle = open ? c.ink : c.soft;
      ctx.globalAlpha = open ? 0.7 : 1;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(open ? [] : [3, 5]);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    };
    /** An entry (dot) or a changed notice (diamond) travelling a link. */
    const packet = (x0: number, y0: number, x1: number, y1: number, p: number, colour: string, diamond: boolean, label = '', stopAt = 1, left = false) => {
      if (p <= 0) return;
      const q = Math.min(p, stopAt);
      const x = x0 + (x1 - x0) * q;
      const y = y0 + (y1 - y0) * q;
      ctx.fillStyle = colour;
      ctx.beginPath();
      if (diamond) {
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x + 6, y);
        ctx.lineTo(x, y + 6);
        ctx.lineTo(x - 6, y);
        ctx.closePath();
      } else ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      if (label) {
        font(11, 600);
        ctx.fillStyle = c.ink;
        ctx.textAlign = left ? 'right' : 'left';
        ctx.fillText(label, left ? x - 9 : x + 9, y);
      }
    };

    parties.forEach(({ p }, k) => {
      const open = !!st.parties[p].at;
      line(sx(k) - 7, sy0, sx(k) - 7, hy1, open);
      line(sx(k) + 7, sy0, sx(k) + 7, hy1, open);
      const ms = members(p);
      ms.forEach((_, j) => line(ux(k, j, ms.length), uy - 8, foot(k, j, ms.length), sy1, true));
    });
    // The guild board.
    ctx.fillStyle = c.floor;
    ctx.fillRect(pad, hy0, Wd - pad * 2, hy1 - hy0);
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 2;
    ctx.strokeRect(pad + 1, hy0 + 1, Wd - pad * 2 - 2, hy1 - hy0 - 2);
    font(12, 600);
    ctx.fillStyle = c.ink;
    ctx.textAlign = 'left';
    ctx.fillText('Guild board', pad + 10, hy0 + 14);
    font(11);
    ctx.fillStyle = c.muted;
    const shownHead = animating ? Math.round(prev.head + (st.head - prev.head) * beat(1)) : st.head;
    ctx.fillText(`log v${fmt(shownHead)}`, pad + 10, hy0 + 30);
    if (tr.clerk) {
      font(11, 600);
      ctx.fillStyle = c.warn;
      ctx.textAlign = 'right';
      ctx.fillText(small ? `clerk: ${tr.clerk} notice${tr.clerk > 1 ? 's' : ''}` : `The clerk edits ${tr.clerk} notice${tr.clerk > 1 ? 's' : ''}`, Wd - pad - 10, hy0 + 21);
    }
    // Parties.
    parties.forEach(({ q, p }, k) => {
      const x0 = pad + colW * k + 4;
      const w = colW - 8;
      const pv = st.parties[p];
      const wm = animating ? Math.round(prev.parties[p].watermark + (pv.watermark - prev.parties[p].watermark) * beat(2)) : pv.watermark;
      ctx.fillStyle = c.floor;
      ctx.fillRect(x0, sy0, w, sy1 - sy0);
      ctx.strokeStyle = this.col(c, p);
      ctx.lineWidth = p === this.party ? 3 : 1.5;
      ctx.strokeRect(x0 + 1, sy0 + 1, w - 2, sy1 - sy0 - 2);
      ctx.textAlign = 'left';
      font(12, 600);
      ctx.fillStyle = c.ink;
      ctx.fillText(`Party ${q.name}`, x0 + 8, sy0 + 14, w - 14);
      font(small ? 10 : 11);
      const behind = shownHead - wm;
      ctx.fillStyle = behind > 0 ? c.warn : c.muted;
      ctx.fillText(small ? `v${fmt(wm)}${behind > 0 ? ` (−${fmt(behind)})` : ''}` : `watermark v${fmt(wm)}${behind > 0 ? ` · ${fmt(behind)} behind` : ''}`, x0 + 8, sy0 + 30, w - 14);
    });
    // Adventurers.
    parties.forEach(({ p }, k) => {
      const ms = members(p);
      ms.forEach(({ a, i }, j) => {
        const x = ux(k, j, ms.length);
        ctx.fillStyle = tr.told.includes(i) ? this.col(c, p) : c.bg;
        ctx.strokeStyle = this.col(c, p);
        ctx.lineWidth = i === this.member ? 3 : 1.5;
        ctx.beginPath();
        ctx.arc(x, uy, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        font(10);
        ctx.fillStyle = c.muted;
        ctx.textAlign = 'center';
        ctx.fillText(a.name, x, uy + 18);
      });
    });
    font(10.5);
    ctx.fillStyle = c.muted;
    ctx.textAlign = 'left';
    ctx.fillText(small ? '● posted up   ◆ changed notice' : '● entries go up at a waystone: adventurer → party → guild      ◆ a changed notice comes back when the party reads', pad, Hh - 9);

    if (animating) {
      const ph = [0, 1, 2, 3].map(beat);
      // 1. Adventurers tell their party what they saw.
      parties.forEach(({ p }, k) => {
        const ms = members(p);
        ms.forEach(({ i }, j) => tr.told.includes(i) && packet(ux(k, j, ms.length), uy - 8, foot(k, j, ms.length), sy1, ph[0], this.col(c, p), false));
      });
      // 2. Parties at a waystone post; the others hold entries until they reach one.
      parties.forEach(({ p }, k) => {
        if (tr.posted[p]) packet(sx(k) - 7, sy0, sx(k) - 7, hy1 + 6, ph[1], this.col(c, p), false, `+${tr.posted[p]}`, 1, true);
        else if (tr.waiting[p]) packet(sx(k) - 7, sy0, sx(k) - 7, hy1 + 6, ph[1], this.col(c, p), false, tiny ? `${tr.waiting[p]}` : `${tr.waiting[p]} waiting`, 0.35, true);
      });
      // 3. Parties at a waystone catch up to the head; a changed notice comes down as a diamond.
      parties.forEach(({ p }, k) => tr.caughtUp[p] && packet(sx(k) + 7, hy1 + 6, sx(k) + 7, sy0, ph[2], tr.questChanged[p] ? c.warn : c.ink, tr.questChanged[p], tr.questChanged[p] ? (tiny ? 'new' : 'notice changed') : `+${fmt(tr.caughtUp[p])}`));
      // 4. Parties re-plan; adventurers get new tasks.
      parties.forEach(({ p }, k) => {
        const ms = members(p);
        ms.forEach(({ i }, j) => tr.retasked.includes(i) && packet(foot(k, j, ms.length), sy1, ux(k, j, ms.length), uy - 8, ph[3], c.warn, true));
      });
    } else {
      font(10.5, 600);
      const my = (sy0 + hy1) / 2;
      parties.forEach(({ p }, k) => {
        const pv = st.parties[p];
        if (!pv.at) {
          ctx.fillStyle = c.muted;
          ctx.textAlign = 'left';
          ctx.fillText(tr.waiting[p] ? `${tr.waiting[p]}${tiny ? '' : ' waiting'}` : tiny ? '' : 'on the road', sx(k) + 14, my);
          return;
        }
        ctx.fillStyle = c.ink;
        ctx.textAlign = 'right';
        if (tr.posted[p]) ctx.fillText(`↑${tr.posted[p]}`, sx(k) - 13, my);
        ctx.textAlign = 'left';
        if (tr.caughtUp[p]) ctx.fillText(`↓${fmt(tr.caughtUp[p])}${tr.questChanged[p] ? ' notice' : ''}`, sx(k) + 13, my);
        else if (!tr.posted[p] && !tiny) ctx.fillText('at a waystone', sx(k) + 13, my);
      });
    }
    const stage = !animating ? '' : ['adventurers tell their party', 'parties at waystones post', 'parties at waystones read', 'parties re-plan'][Math.min(3, Math.floor(this.phase * 4))];
    const B = this.run.parties.findIndex((p) => p.name === 'B');
    const bBehind = st.head - st.parties[B].watermark;
    this.timeLbl.textContent = mmss(t);
    this.stageLbl.textContent = [bBehind ? `B ${bBehind} behind` : '', stage].filter(Boolean).join(' · ');
  }
}
