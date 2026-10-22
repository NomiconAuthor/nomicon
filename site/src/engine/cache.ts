import { h, seg, fmt } from './dom';

/**
 * Cache-line visualiser: the same 16 entities laid out as an array of structs,
 * a struct of arrays, or split into hot and cold parts, and a loop walking them.
 * Memory is drawn one 64-byte cache line per row; the first touch of a line is a
 * miss that brings in all 64 bytes, and the stats count how many of those bytes
 * the loop actually used.
 */

interface Field {
  id: string;
  label: string;
  bytes: number;
  color: string;
}
const FIELDS: Field[] = [
  { id: 'x', label: 'x', bytes: 4, color: 'var(--c7)' },
  { id: 'y', label: 'y', bytes: 4, color: 'var(--c7)' },
  { id: 'vx', label: 'vx', bytes: 4, color: 'var(--c2)' },
  { id: 'vy', label: 'vy', bytes: 4, color: 'var(--c2)' },
  { id: 'hp', label: 'hp', bytes: 4, color: 'var(--c3)' },
  { id: 'arm', label: 'arm', bytes: 4, color: 'var(--c6)' },
  { id: 'col', label: 'col', bytes: 4, color: 'var(--c5)' },
  { id: 'id', label: 'id', bytes: 4, color: 'var(--c8)' },
  { id: 'ai', label: 'ai', bytes: 16, color: 'var(--c4)' },
];
const STRUCT_BYTES = FIELDS.reduce((a, f) => a + f.bytes, 0); // 48
const N = 16;
const LINE = 64;
const WORD = 4;

type Layout = 'aos' | 'soa' | 'split';
type Loop = 'move' | 'damage' | 'render' | 'think';

const LOOPS: Record<Loop, { label: string; code: string; fields: string[] }> = {
  move: { label: 'Move', code: 'for (auto& e : units) { e.x += e.vx; e.y += e.vy; }', fields: ['x', 'y', 'vx', 'vy'] },
  damage: { label: 'Damage', code: 'for (auto& e : units) e.hp -= poison;', fields: ['hp'] },
  render: { label: 'Render', code: 'for (auto& e : units) draw(e.x, e.y, e.col);', fields: ['x', 'y', 'col'] },
  think: { label: 'AI tick', code: 'for (auto& e : units) think(e); // reads everything', fields: FIELDS.map((f) => f.id) },
};

const HOT = new Set(['x', 'y', 'vx', 'vy']);

/** Byte offset of entity e's field f in each layout. */
function offsetOf(layout: Layout, e: number, f: string): number {
  const idx = FIELDS.findIndex((x) => x.id === f);
  const field = FIELDS[idx];
  const within = FIELDS.slice(0, idx).reduce((a, x) => a + x.bytes, 0);
  if (layout === 'aos') return e * STRUCT_BYTES + within;
  if (layout === 'soa') {
    // One array per field, each starting on a cache-line boundary.
    let base = 0;
    for (const x of FIELDS.slice(0, idx)) base += Math.ceil((x.bytes * N) / LINE) * LINE;
    return base + e * field.bytes;
  }
  // split: hot array {x, y, vx, vy} then cold array {hp, arm, col, id, ai}
  const hot = FIELDS.filter((x) => HOT.has(x.id));
  const cold = FIELDS.filter((x) => !HOT.has(x.id));
  const hotBytes = hot.reduce((a, x) => a + x.bytes, 0);
  const coldBytes = cold.reduce((a, x) => a + x.bytes, 0);
  if (HOT.has(f)) return e * hotBytes + hot.slice(0, hot.indexOf(field)).reduce((a, x) => a + x.bytes, 0);
  const coldBase = Math.ceil((hotBytes * N) / LINE) * LINE;
  return coldBase + e * coldBytes + cold.slice(0, cold.indexOf(field)).reduce((a, x) => a + x.bytes, 0);
}

interface Cell {
  field: Field;
  entity: number;
  part: number; // which word of a multi-word field
}

export class CacheViz {
  private root: HTMLElement;
  private layout: Layout = 'aos';
  private loop: Loop = 'move';
  private cells: Array<Cell | null> = [];
  private lines = 0;
  /** Accesses in loop order: list of word indices per access step. */
  private steps: Array<{ entity: number; field: Field; words: number[] }> = [];
  private pos = 0;
  private timer = 0;
  private grid!: HTMLElement;
  private stats!: HTMLElement;
  private code!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private cellEls: HTMLElement[] = [];
  private rowEls: HTMLElement[] = [];

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ll-cache' });
    host.replaceChildren(this.root);
    this.build();
    this.relayout();
  }

  private build(): void {
    const layoutSeg = seg<Layout>(
      'Layout',
      [
        ['aos', 'Array of structs'],
        ['soa', 'Struct of arrays'],
        ['split', 'Hot / cold split'],
      ],
      this.layout,
      (v) => {
        this.layout = v;
        this.relayout();
      },
    );
    const loopSeg = seg<Loop>(
      'Loop',
      (Object.keys(LOOPS) as Loop[]).map((k) => [k, LOOPS[k].label]),
      this.loop,
      (v) => {
        this.loop = v;
        this.relayout();
      },
    );
    this.playBtn = h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.toggle() }, 'Play');
    this.code = h('code', { class: 'll-code' });
    this.grid = h('div', { class: 'll-mem' });
    this.stats = h('div', { class: 'll-stats' });
    const legend = h(
      'div',
      { class: 'll-legend' },
      ...FIELDS.map((f) => h('span', {}, h('i', { style: `background:${f.color}` }), `${f.label} (${f.bytes} B)`)),
    );
    this.root.append(
      h('div', { class: 'll-row' }, layoutSeg.el),
      h('div', { class: 'll-row' }, loopSeg.el),
      h('div', { class: 'll-row' }, this.code),
      h(
        'div',
        { class: 'll-row' },
        h('button', { type: 'button', class: 'll-btn', onclick: () => this.reset() }, 'Reset'),
        h('button', { type: 'button', class: 'll-btn', onclick: () => this.step() }, 'Step'),
        this.playBtn,
        h('button', { type: 'button', class: 'll-btn', onclick: () => this.finish() }, 'Run to end'),
      ),
      this.stats,
      legend,
      this.grid,
    );
  }

  private relayout(): void {
    this.stop();
    let maxByte = 0;
    for (let e = 0; e < N; e++) for (const f of FIELDS) maxByte = Math.max(maxByte, offsetOf(this.layout, e, f.id) + f.bytes);
    this.lines = Math.ceil(maxByte / LINE);
    this.cells = new Array((this.lines * LINE) / WORD).fill(null);
    for (let e = 0; e < N; e++)
      for (const f of FIELDS) {
        const o = offsetOf(this.layout, e, f.id);
        for (let k = 0; k < f.bytes / WORD; k++) this.cells[o / WORD + k] = { field: f, entity: e, part: k };
      }
    const loop = LOOPS[this.loop];
    this.steps = [];
    for (let e = 0; e < N; e++)
      for (const fid of loop.fields) {
        const f = FIELDS.find((x) => x.id === fid)!;
        const o = offsetOf(this.layout, e, fid) / WORD;
        this.steps.push({ entity: e, field: f, words: Array.from({ length: f.bytes / WORD }, (_, k) => o + k) });
      }
    // SoA loops walk one array at a time only if the compiler vectorises; we keep the
    // source order (per entity), which is what the hardware sees for a plain loop.
    this.code.textContent = loop.code;
    this.drawGrid();
    this.pos = 0;
    this.render();
  }

  private drawGrid(): void {
    this.cellEls = [];
    this.rowEls = [];
    const rows: HTMLElement[] = [];
    for (let r = 0; r < this.lines; r++) {
      const cells: HTMLElement[] = [];
      for (let c = 0; c < LINE / WORD; c++) {
        const cell = this.cells[r * (LINE / WORD) + c];
        const el = h(
          'span',
          { class: `ll-cell${cell ? '' : ' pad'}`, style: cell ? `--f:${cell.field.color}` : undefined, title: cell ? `entity ${cell.entity}.${cell.field.label}` : 'padding' },
          cell ? (cell.part === 0 ? cell.field.label : '') : '',
          cell && cell.part === 0 ? h('sub', {}, String(cell.entity)) : null,
        );
        this.cellEls.push(el);
        cells.push(el);
      }
      const row = h('div', { class: 'll-line' }, h('span', { class: 'll-addr' }, `+${(r * LINE).toString(16).padStart(3, '0')}`), h('div', { class: 'll-cells' }, ...cells));
      this.rowEls.push(row);
      rows.push(row);
    }
    this.grid.replaceChildren(...rows);
  }

  private render(): void {
    const loaded = new Set<number>();
    const used = new Set<number>();
    let misses = 0;
    for (let i = 0; i < this.pos; i++)
      for (const w of this.steps[i].words) {
        const line = Math.floor((w * WORD) / LINE);
        if (!loaded.has(line)) {
          loaded.add(line);
          misses++;
        }
        used.add(w);
      }
    const cur = this.pos > 0 && this.pos <= this.steps.length ? new Set(this.steps[this.pos - 1].words) : new Set<number>();
    this.cellEls.forEach((el, w) => {
      el.classList.toggle('used', used.has(w));
      el.classList.toggle('cur', cur.has(w));
      el.classList.toggle('inline', loaded.has(Math.floor((w * WORD) / LINE)));
    });
    this.rowEls.forEach((row, r) => row.classList.toggle('loaded', loaded.has(r)));
    const fetched = loaded.size * LINE;
    const usedBytes = used.size * WORD;
    const done = this.pos >= this.steps.length;
    const stat = (v: string, l: string, title?: string) => h('div', { class: 'll-stat', title }, h('b', {}, v), h('span', {}, l));
    const parts: HTMLElement[] = [
      stat(`${fmt(this.pos)} / ${fmt(this.steps.length)}`, 'field reads'),
      stat(fmt(misses), 'cache misses', 'Lines brought in from memory (cold cache, nothing evicted)'),
      stat(`${fmt(fetched)} B`, 'fetched'),
      stat(`${fmt(usedBytes)} B`, 'actually used'),
      stat(fetched ? `${fmt((usedBytes / fetched) * 100)}%` : '–', 'of fetched bytes used', 'Bandwidth efficiency: used bytes / fetched bytes'),
    ];
    if (done) parts.push(h('div', { class: 'll-verdict' }, this.verdict(misses, usedBytes, fetched)));
    this.stats.replaceChildren(...parts);
  }

  private verdict(misses: number, used: number, fetched: number): string {
    const eff = used / fetched;
    if (eff > 0.95) return `Every byte fetched was used: ${misses} line${misses === 1 ? '' : 's'} for exactly the data the loop needed.`;
    if (eff > 0.6) return `${fmt(eff * 100)}% useful. Some of each line carried fields this loop never reads.`;
    return `Only ${fmt(eff * 100)}% of what came from memory was used. The rest rode along because it shares cache lines with the fields this loop wants.`;
  }

  private step(): void {
    if (this.pos < this.steps.length) this.pos++;
    else this.stop();
    this.render();
  }
  private toggle(): void {
    if (this.timer) this.stop();
    else {
      if (this.pos >= this.steps.length) this.pos = 0;
      this.playBtn.textContent = 'Pause';
      this.timer = window.setInterval(() => {
        this.step();
        if (this.pos >= this.steps.length) this.stop();
      }, 70);
    }
  }
  private stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    if (this.playBtn) this.playBtn.textContent = 'Play';
  }
  private reset(): void {
    this.stop();
    this.pos = 0;
    this.render();
  }
  private finish(): void {
    this.stop();
    this.pos = this.steps.length;
    this.render();
  }
}
