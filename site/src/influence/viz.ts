/** The influence and threat maps widget: a town, two sides, and a route that can weigh danger. */
import { drawSprite, onSprites, spriteSize } from '../sprites/sprites';
import { fmt, h, seg } from '../engine/dom';
import { MOVE_SPEED, influence, makeScene, possiblePositions, route, threatMap, type Route, type Scene, type Spread, type Unit } from './sim';

type Layer = 'control' | 'tension' | 'threat';

function css(el: Element) {
  const cs = getComputedStyle(el);
  const g = (n: string, f = '#888') => cs.getPropertyValue(n).trim() || f;
  return { bg: g('--bg'), floor: g('--floor', '#1d222b'), low: g('--t-road', '#5a523c'), wall: g('--wall', '#6b7686'), kn: g('--c2', '#5fd4e8'), gob: g('--alert', '#ff6b6b'), warn: g('--warn', '#f0b45a'), ink: g('--ink'), muted: g('--muted'), good: g('--good', '#5fd48a'), mono: g('--f-mono', 'monospace') };
}
function rgb(colour: string): [number, number, number] {
  const c = document.createElement('canvas').getContext('2d')!;
  c.fillStyle = colour;
  const s = c.fillStyle as string;
  if (s.startsWith('#')) return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const m = s.match(/\d+(\.\d+)?/g)!.map(Number);
  return [m[0], m[1], m[2]];
}

const NOTES: Record<Layer, string> = {
  control: 'The knights’ influence minus the goblins’. Strong colour is ground one side holds; the faint band between them is the front line, where neither side dominates.',
  tension: 'The knights’ influence plus the goblins’. It’s high where both sides are strong at once: contested ground, where fights are likely.',
  threat: 'Every walkable cell a goblin archer could hit a standing body in: within bow range and in its line of sight. Enemies seen a while ago spread their threat over everywhere they could have walked since (the dotted ring), faded by how old the sighting is.',
};

export class InfluenceViz {
  private root: HTMLElement;
  private cnv = h('canvas', { class: 'im-map', 'aria-label': 'Influence and threat map of a town' }) as HTMLCanvasElement;
  private stats = h('div', { class: 'll-stats' });
  private keys = h('div', { class: 'im-keys' });
  private note = h('p', { class: 'll-muted' });
  private tip = h('div', { class: 'wt-tip', hidden: true });
  private layer: Layer = 'threat';
  private spread: Spread = 'flood';
  private age = 10;
  private k = 10;
  private scene: Scene = makeScene(6, this.age);
  private kn!: Float32Array;
  private gob!: Float32Array;
  private threat!: Float32Array;
  private rays = 0;
  private ms = 0;
  private short!: Route;
  private safe!: Route;
  private S = 8;
  private drag: { kind: 'unit' | 'start' | 'goal'; i: number } | null = null;
  private lastCompute = 0;
  private pending = 0;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll im' });
    host.replaceChildren(this.root);
    this.root.append(
      h(
        'div',
        { class: 'll-row' },
        seg<Layer>(
          'Show',
          [
            ['control', 'Control'],
            ['tension', 'Tension'],
            ['threat', 'Threat to the knights'],
          ],
          this.layer,
          (v) => ((this.layer = v), this.draw()),
        ).el,
        seg<Spread>(
          'Influence spreads',
          [
            ['radius', 'In a straight line'],
            ['flood', 'Along the streets'],
          ],
          this.spread,
          (v) => ((this.spread = v), this.compute()),
        ).el,
      ),
      h(
        'div',
        { class: 'll-row' },
        seg<string>('Unseen enemies last seen', ['0', '10', '30', '60'].map((x) => [x, x === '0' ? 'just now' : `${x} s ago`] as [string, string]), String(this.age), (v) => {
          this.age = Number(v);
          // The last four goblins are the ones not in sight now.
          for (const [i, u] of this.scene.units.entries()) if (u.side === 'goblins' && i >= this.scene.units.length - 4) u.age = this.age;
          this.compute();
        }).el,
        seg<string>('Route weighs threat ×', ['2', '10', '30'].map((x) => [x, x] as [string, string]), String(this.k), (v) => ((this.k = Number(v)), this.compute())).el,
      ),
      this.keys,
      h('div', { class: 'wt-wrap im-wrap' }, this.cnv, this.tip),
      this.stats,
      this.note,
      h('p', { class: 'll-muted' }, 'Drag the units, the start (S) or the objective (flag). The dashed line is the shortest route; the solid one weighs threat.'),
    );
    this.cnv.addEventListener('pointerdown', (e) => this.down(e));
    this.cnv.addEventListener('pointermove', (e) => this.move(e));
    this.cnv.addEventListener('pointerup', () => this.up());
    this.cnv.addEventListener('pointerleave', () => (this.tip.hidden = true));
    new ResizeObserver(() => this.draw()).observe(this.root);
    new MutationObserver(() => this.draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    onSprites(() => this.draw());
    this.compute();
  }

  private compute(): void {
    const s = this.scene;
    const t0 = performance.now();
    this.kn = influence(s.t, s.units, 'knights', this.spread);
    this.gob = influence(s.t, s.units, 'goblins', this.spread);
    const th = threatMap(s.t, s.units);
    this.threat = th.threat;
    this.rays = th.rays;
    this.short = route(s.t, s.start, s.goal, this.threat, 0);
    this.safe = route(s.t, s.start, s.goal, this.threat, this.k);
    this.ms = performance.now() - t0;
    this.lastCompute = performance.now();
    this.draw();
  }

  private cellAt(e: PointerEvent): { x: number; y: number } {
    const b = this.cnv.getBoundingClientRect();
    return { x: Math.floor((e.clientX - b.left) / this.S), y: Math.floor((e.clientY - b.top) / this.S) };
  }

  private down(e: PointerEvent): void {
    const p = this.cellAt(e);
    const s = this.scene;
    const near = (q: { x: number; y: number }) => Math.hypot(q.x - p.x, q.y - p.y) <= 2;
    if (near(s.start)) this.drag = { kind: 'start', i: 0 };
    else if (near(s.goal)) this.drag = { kind: 'goal', i: 0 };
    else {
      const i = s.units.findIndex(near);
      if (i >= 0) this.drag = { kind: 'unit', i };
    }
    if (this.drag) this.cnv.setPointerCapture(e.pointerId);
  }

  private move(e: PointerEvent): void {
    const p = this.cellAt(e);
    const s = this.scene;
    if (!this.drag) {
      this.hover(e, p);
      return;
    }
    if (p.x < 0 || p.y < 0 || p.x >= s.t.w || p.y >= s.t.h || s.t.kind[p.y * s.t.w + p.x] !== 0) return;
    const target: { x: number; y: number } = this.drag.kind === 'start' ? s.start : this.drag.kind === 'goal' ? s.goal : s.units[this.drag.i];
    if (target.x === p.x && target.y === p.y) return;
    target.x = p.x;
    target.y = p.y;
    // Recompute at most every 80 ms while dragging; draw the marker moving in between.
    if (performance.now() - this.lastCompute > 80) this.compute();
    else {
      this.draw();
      clearTimeout(this.pending);
      this.pending = window.setTimeout(() => this.compute(), 90);
    }
  }

  private up(): void {
    if (this.drag) this.compute();
    this.drag = null;
  }

  private hover(e: PointerEvent, p: { x: number; y: number }): void {
    const t = this.scene.t;
    if (p.x < 0 || p.y < 0 || p.x >= t.w || p.y >= t.h || t.kind[p.y * t.w + p.x] !== 0) {
      this.tip.hidden = true;
      return;
    }
    const i = p.y * t.w + p.x;
    this.tip.replaceChildren(
      h('b', {}, `Cell ${p.x}, ${p.y}`),
      h('span', {}, `knights ${fmt(this.kn[i], 2)}, goblins ${fmt(this.gob[i], 2)}`),
      h('span', {}, `control ${fmt(this.kn[i] - this.gob[i], 2)}, tension ${fmt(this.kn[i] + this.gob[i], 2)}`),
      h('span', {}, `threat to the knights ${fmt(this.threat[i], 2)}`),
    );
    this.tip.hidden = false;
    const b = this.cnv.getBoundingClientRect();
    const px = e.clientX - b.left;
    this.tip.style.left = `${Math.min(Math.max(0, px + 12), b.width - this.tip.offsetWidth)}px`;
    this.tip.style.top = `${e.clientY - b.top + 14}px`;
  }

  private draw(): void {
    if (!this.threat) return;
    const c = css(this.root);
    const t = this.scene.t;
    const wpx = Math.max(280, this.cnv.parentElement!.clientWidth);
    const S = Math.max(3, Math.min(10, Math.floor(wpx / t.w)));
    this.S = S;
    const dpr = window.devicePixelRatio || 1;
    this.cnv.width = t.w * S * dpr;
    this.cnv.height = t.h * S * dpr;
    this.cnv.style.width = `${t.w * S}px`;
    this.cnv.style.height = `${t.h * S}px`;
    const ctx = this.cnv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const base = [c.floor, c.low, c.wall, c.wall, c.wall];
    for (let y = 0; y < t.h; y++)
      for (let x = 0; x < t.w; x++) {
        ctx.fillStyle = base[t.kind[y * t.w + x]];
        ctx.fillRect(x * S, y * S, S, S);
      }
    // The layer, as a translucent overlay.
    const [br, bg, bb] = rgb(c.kn);
    const [rr, rg, rb] = rgb(c.gob);
    const [wr, wg, wb] = rgb(c.warn);
    let maxT = 0;
    let maxTen = 0;
    for (let i = 0; i < this.threat.length; i++) {
      maxT = Math.max(maxT, this.threat[i]);
      maxTen = Math.max(maxTen, this.kn[i] + this.gob[i]);
    }
    for (let y = 0; y < t.h; y++)
      for (let x = 0; x < t.w; x++) {
        const i = y * t.w + x;
        if (t.kind[i] !== 0) continue;
        let a = 0;
        let col = '';
        if (this.layer === 'control') {
          const v = this.kn[i] - this.gob[i];
          a = Math.min(0.75, Math.abs(v) * 0.7);
          col = v >= 0 ? `rgba(${br},${bg},${bb},${a})` : `rgba(${rr},${rg},${rb},${a})`;
        } else if (this.layer === 'tension') {
          a = maxTen > 0 ? Math.min(0.8, ((this.kn[i] + this.gob[i]) / maxTen) * 0.8) : 0;
          col = `rgba(${wr},${wg},${wb},${a})`;
        } else {
          a = maxT > 0 ? Math.min(0.8, Math.sqrt(this.threat[i] / maxT) * 0.8) : 0;
          col = `rgba(${rr},${rg},${rb},${a})`;
        }
        if (a < 0.02) continue;
        ctx.fillStyle = col;
        ctx.fillRect(x * S, y * S, S, S);
      }
    // Front line: cells where both sides have influence and neither dominates.
    if (this.layer === 'control') {
      ctx.fillStyle = c.ink;
      for (let i = 0; i < this.kn.length; i++)
        if (t.kind[i] === 0 && this.kn[i] > 0.05 && this.gob[i] > 0.05 && Math.abs(this.kn[i] - this.gob[i]) < 0.06) {
          const x = i % t.w;
          const y = (i - x) / t.w;
          ctx.globalAlpha = 0.55;
          ctx.fillRect(x * S + S * 0.3, y * S + S * 0.3, S * 0.4, S * 0.4);
          ctx.globalAlpha = 1;
        }
    }
    // Routes.
    const line = (r: Route, colour: string, dash: number[], width: number) => {
      if (r.path.length < 2) return;
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      r.path.forEach((k, q) => {
        const x = ((k % t.w) + 0.5) * S;
        const y = (Math.floor(k / t.w) + 0.5) * S;
        if (q) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    };
    line(this.short, c.ink, [4, 4], 1.5);
    line(this.safe, c.good, [], 2.5);
    // Units.
    const size = spriteSize(Math.max(16, S * 2));
    let k = 0;
    const dot = (u: Unit) => {
      const x = (u.x + 0.5) * S;
      const y = (u.y + 0.5) * S;
      const r = Math.max(4, S * 0.8);
      const col = u.side === 'knights' ? c.kn : c.gob;
      if (u.age > 0) {
        // Where it could be now.
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.6;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.arc(x, y, u.age * MOVE_SPEED * S, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        for (const p of possiblePositions(this.scene.t, u)) ctx.fillRect((p.x + 0.5) * S - 1, (p.y + 0.5) * S - 1, 2, 2);
        ctx.globalAlpha = 1;
        // Last seen here: a faded figure on a hollow ring.
        ctx.lineWidth = 2;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(r, size * 0.55), 0, Math.PI * 2);
        ctx.stroke();
        drawSprite(ctx, 'goblinArcher', x, y, size, { alpha: 0.45, flip: true });
      } else drawSprite(ctx, u.side === 'knights' ? (k++ % 2 ? 'crossbow' : 'knight') : 'goblinArcher', x, y, size, { base: col, flip: u.side !== 'knights' });
    };
    for (const u of this.scene.units) dot(u);
    // Start and objective.
    const s = this.scene;
    ctx.fillStyle = c.ink;
    ctx.strokeStyle = c.bg;
    ctx.lineWidth = 2;
    const sz = Math.max(8, S * 1.6);
    ctx.fillRect((s.start.x + 0.5) * S - sz / 2, (s.start.y + 0.5) * S - sz / 2, sz, sz);
    ctx.fillStyle = c.bg;
    ctx.font = `600 ${Math.max(8, S)}px ${c.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('S', (s.start.x + 0.5) * S, (s.start.y + 0.5) * S + 0.5);
    const gx = (s.goal.x + 0.5) * S;
    const gy = (s.goal.y + 0.5) * S;
    ctx.strokeStyle = c.ink;
    ctx.beginPath();
    ctx.moveTo(gx, gy + sz * 0.6);
    ctx.lineTo(gx, gy - sz * 0.8);
    ctx.stroke();
    ctx.fillStyle = c.good;
    ctx.beginPath();
    ctx.moveTo(gx, gy - sz * 0.8);
    ctx.lineTo(gx + sz * 0.8, gy - sz * 0.5);
    ctx.lineTo(gx, gy - sz * 0.2);
    ctx.fill();
    ctx.textAlign = 'left';
    this.note.textContent = NOTES[this.layer];
    const key = (cls: string, colour: string, label: string) => h('span', { class: `im-key ${cls}`, style: `--k: ${colour}` }, label);
    this.keys.replaceChildren(
      key('dot', c.kn, 'Knight'),
      key('dot', c.gob, 'Goblin in sight'),
      key('ring', c.gob, 'Goblin last seen; the dotted ring is where it could be now'),
      key('dash', c.ink, 'Shortest route'),
      key('line', c.good, 'Route that weighs threat'),
      ...(this.layer === 'control' ? [key('front', c.ink, 'Front line')] : []),
    );
    this.statsFor();
  }

  private statsFor(): void {
    const r = (x: Route) => `${fmt(x.length)} m, ${fmt(x.exposed)} m in sight`;
    const walk = this.scene.t.kind.filter((k) => k === 0).length;
    const threatened = this.threat.filter((v) => v > 0.02).length;
    this.stats.replaceChildren(
      stat(r(this.short), 'shortest route'),
      stat(r(this.safe), 'route that weighs threat'),
      stat(`${fmt(this.short.danger, 1)} → ${fmt(this.safe.danger, 1)}`, 'danger along the route', 'Threat summed along the route, per metre: what the weighted route minimises, along with distance.'),
      stat(`${fmt((100 * threatened) / walk)}%`, 'of the town under threat'),
      stat(fmt(this.rays), 'line-of-sight tests'),
      stat(`${fmt(this.ms)} ms`, 'to recompute it all, in your browser'),
    );
  }
}
const stat = (v: string, l: string, title?: string) => h('div', { class: 'll-stat', title }, h('b', {}, v), h('span', {}, l));
