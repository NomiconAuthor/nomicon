import { h, seg, fmt } from './dom';

/**
 * Three allocators over the same 64-unit heap (each unit 16 bytes): a bump arena,
 * a fixed-size pool, and a general first-fit free list with optional coalescing.
 * Shows what each one can and can't do, and how fragmentation appears.
 */

type Mode = 'arena' | 'pool' | 'freelist';
const UNITS = 64;
const BLOCK = 4; // pool block size in units

interface Block {
  start: number;
  size: number;
  id: number; // 0 = free
}

export class AllocViz {
  private root: HTMLElement;
  private mode: Mode = 'freelist';
  private coalesce = true;
  private blocks: Block[] = [];
  private top = 0; // arena bump pointer
  private nextId = 1;
  private fails = 0;
  private msg = '';
  private heapEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private allocsEl!: HTMLElement;
  private msgEl!: HTMLElement;
  private coalesceEl!: HTMLElement;
  private sizes!: HTMLElement;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ll-alloc' });
    host.replaceChildren(this.root);
    const modeSeg = seg<Mode>(
      'Allocator',
      [
        ['arena', 'Arena (bump)'],
        ['pool', 'Pool (fixed blocks)'],
        ['freelist', 'Free list (any size)'],
      ],
      this.mode,
      (v) => {
        this.mode = v;
        this.reset();
      },
    );
    const co = h('input', { type: 'checkbox', checked: true });
    co.addEventListener('change', () => {
      this.coalesce = co.checked;
      this.msg = this.coalesce ? 'Coalescing on: freed blocks merge with free neighbours.' : 'Coalescing off: freed blocks stay separate, so free space splinters.';
      this.render();
    });
    this.coalesceEl = h('label', { class: 'll-chk' }, co, ' merge neighbouring free blocks');
    this.sizes = h('div', { class: 'll-row' });
    this.heapEl = h('div', { class: 'al-heap' });
    this.statsEl = h('div', { class: 'll-stats' });
    this.allocsEl = h('div', { class: 'al-list' });
    this.msgEl = h('div', { class: 'al-msg' });
    this.root.append(
      h('div', { class: 'll-row' }, modeSeg.el),
      this.sizes,
      this.heapEl,
      this.statsEl,
      this.msgEl,
      h('div', { class: 'll-h' }, 'Live allocations (click one to free it)'),
      this.allocsEl,
    );
    this.reset();
  }

  private reset(): void {
    this.blocks = [{ start: 0, size: UNITS, id: 0 }];
    this.top = 0;
    this.nextId = 1;
    this.fails = 0;
    this.msg =
      this.mode === 'arena'
        ? 'An arena hands out memory by bumping a pointer. Freeing one allocation does nothing; resetting frees everything at once.'
        : this.mode === 'pool'
          ? `A pool hands out fixed ${BLOCK}-unit blocks from a free list. Any free block fits any request, so it can't fragment, but nothing bigger than a block fits at all.`
          : 'A general allocator finds a free gap big enough (first fit here). Mixed sizes and lifetimes leave gaps between live blocks.';
    const sizeBtn = (n: number, label: string) => h('button', { type: 'button', class: 'll-btn', onclick: () => this.alloc(n) }, label);
    this.sizes.replaceChildren(
      sizeBtn(2, 'Alloc 32 B'),
      sizeBtn(4, 'Alloc 64 B'),
      sizeBtn(7, 'Alloc 112 B'),
      sizeBtn(12, 'Alloc 192 B'),
      h('button', { type: 'button', class: 'll-btn', onclick: () => this.churn() }, 'Churn ×20'),
      h('button', { type: 'button', class: 'll-btn', onclick: () => this.reset() }, this.mode === 'arena' ? 'Reset the arena' : 'Free everything'),
    );
    if (this.mode === 'freelist') this.sizes.append(this.coalesceEl);
    this.render();
  }

  private alloc(units: number): boolean {
    const id = this.nextId;
    if (this.mode === 'arena') {
      if (this.top + units > UNITS) return this.fail(`Arena full: ${UNITS - this.top} units left, ${units} wanted. Reset it (end of frame, end of level) to reuse the memory.`);
      this.blocks = this.split(this.top, units, id);
      this.top += units;
    } else if (this.mode === 'pool') {
      if (units > BLOCK) return this.fail(`${units * 16} B doesn't fit a ${BLOCK * 16}-byte pool block. Pools serve one size; bigger objects need another pool or allocator.`);
      const b = this.blocks.find((x) => x.id === 0 && x.size >= BLOCK);
      if (!b) return this.fail('Pool exhausted: every block is in use.');
      this.blocks = this.split(b.start, BLOCK, id);
    } else {
      const b = this.blocks.find((x) => x.id === 0 && x.size >= units);
      if (!b) {
        const free = this.freeUnits();
        return this.fail(
          free >= units
            ? `No gap of ${units} units, although ${free} are free in total: that's fragmentation.`
            : `Out of memory: ${free} units free, ${units} wanted.`,
        );
      }
      this.blocks = this.split(b.start, units, id);
    }
    this.nextId++;
    this.msg = `Allocated #${id}: ${units * 16} bytes${this.mode === 'pool' && units < BLOCK ? ` (in a ${BLOCK * 16}-byte block: ${(BLOCK - units) * 16} B wasted inside it)` : ''}.`;
    this.render();
    return true;
  }

  private fail(why: string): false {
    this.fails++;
    this.msg = why;
    this.render();
    return false;
  }

  /** Mark [start, start+size) of the free block that contains it as allocation `id`. */
  private split(start: number, size: number, id: number): Block[] {
    const out: Block[] = [];
    for (const b of this.blocks) {
      if (b.id !== 0 || start < b.start || start >= b.start + b.size) {
        out.push(b);
        continue;
      }
      if (start > b.start) out.push({ start: b.start, size: start - b.start, id: 0 });
      out.push({ start, size, id });
      const rest = b.start + b.size - (start + size);
      if (rest > 0) out.push({ start: start + size, size: rest, id: 0 });
    }
    return out;
  }

  private free(id: number): void {
    if (this.mode === 'arena') {
      this.msg = `free(#${id}) does nothing in an arena: memory only comes back when the whole arena resets. That's the deal that makes it so fast.`;
      return this.render();
    }
    this.blocks = this.blocks.map((b) => (b.id === id ? { ...b, id: 0 } : b));
    if (this.mode === 'freelist' && this.coalesce) {
      const merged: Block[] = [];
      for (const b of this.blocks) {
        const last = merged[merged.length - 1];
        if (last && last.id === 0 && b.id === 0) last.size += b.size;
        else merged.push({ ...b });
      }
      this.blocks = merged;
    }
    this.msg = `Freed #${id}.`;
    this.render();
  }

  private churn(): void {
    // Random mixed-size, mixed-lifetime traffic.
    for (let k = 0; k < 20; k++) {
      const live = this.blocks.filter((b) => b.id !== 0);
      if (live.length && Math.random() < 0.45) this.free(live[Math.floor(Math.random() * live.length)].id);
      else this.alloc([2, 2, 3, 4, 5, 7][Math.floor(Math.random() * 6)]);
    }
    this.msg = `Churned: ${this.msg}`;
    this.render();
  }

  private freeUnits(): number {
    return this.blocks.filter((b) => b.id === 0).reduce((a, b) => a + b.size, 0);
  }

  private render(): void {
    const cells: HTMLElement[] = [];
    for (const b of this.blocks) {
      for (let u = 0; u < b.size; u++) {
        const pos = b.start + u;
        const poolEdge = this.mode === 'pool' && pos % BLOCK === 0;
        cells.push(
          h(
            'span',
            {
              class: `al-u${b.id ? ' used' : ''}${u === 0 ? ' first' : ''}${poolEdge ? ' edge' : ''}${this.mode === 'arena' && pos === this.top ? ' top' : ''}`,
              style: b.id ? `--a:var(--c${(b.id % 8) + 1})` : undefined,
              title: b.id ? `#${b.id}` : 'free',
            },
            u === 0 && b.id ? `#${b.id}` : '',
          ),
        );
      }
    }
    this.heapEl.replaceChildren(...cells);
    const free = this.mode === 'arena' ? UNITS - this.top : this.freeUnits();
    const freeBlocks = this.blocks.filter((b) => b.id === 0);
    const largest = this.mode === 'arena' ? UNITS - this.top : Math.max(0, ...freeBlocks.map((b) => b.size));
    const used = this.blocks.filter((b) => b.id !== 0).reduce((a, b) => a + b.size, 0);
    const frag = free ? 1 - largest / free : 0;
    const stat = (v: string, l: string, title?: string) => h('div', { class: 'll-stat', title }, h('b', {}, v), h('span', {}, l));
    this.statsEl.replaceChildren(
      stat(`${fmt(used * 16)} B`, 'in use'),
      stat(`${fmt(free * 16)} B`, 'free'),
      stat(`${fmt(largest * 16)} B`, 'largest free gap'),
      this.mode === 'freelist' ? stat(`${fmt(frag * 100)}%`, 'fragmentation', '1 − largest free gap / total free') : stat(this.mode === 'pool' ? `${fmt(this.blocks.filter((b) => b.id).length)} / ${UNITS / BLOCK}` : `${fmt(this.top * 16)} B`, this.mode === 'pool' ? 'blocks used' : 'bump offset'),
      stat(fmt(this.fails), 'failed requests'),
    );
    this.msgEl.textContent = this.msg;
    const live = this.blocks.filter((b) => b.id !== 0);
    this.allocsEl.replaceChildren(
      ...(live.length
        ? live.map((b) => h('button', { type: 'button', class: 'al-chip', style: `--a:var(--c${(b.id % 8) + 1})`, onclick: () => this.free(b.id) }, `#${b.id} · ${b.size * 16} B`))
        : [h('span', { class: 'll-muted' }, 'Nothing allocated.')]),
    );
  }
}
