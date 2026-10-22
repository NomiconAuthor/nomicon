import { h, fmt } from './dom';

/**
 * A generational slot map: slots hold objects, a free list threads through the
 * empty ones, and a handle is (index, generation). Destroying an object bumps its
 * slot's generation, so any handle still holding the old generation is detected
 * as stale instead of silently pointing at whatever reuses the slot.
 */

const CAP = 8;
const NAMES = ['Goblin', 'Archer', 'Crate', 'Torch', 'Wolf', 'Knight', 'Barrel', 'Bat', 'Golem', 'Slime'];

interface Slot {
  gen: number;
  alive: boolean;
  value: string;
  next: number; // free-list link (-1 = end), meaningful when !alive
}
interface Handle {
  index: number;
  gen: number;
  label: string;
}

export class SlotMapViz {
  private root: HTMLElement;
  private slots: Slot[] = [];
  private freeHead = 0;
  private held: Handle[] = [];
  private spawned = 0;
  private log: Array<{ code: string; text: string; cls?: string }> = [];
  private slotsEl!: HTMLElement;
  private heldEl!: HTMLElement;
  private logEl!: HTMLElement;
  private flash = -1;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ll-slot' });
    host.replaceChildren(this.root);
    this.slotsEl = h('div', { class: 'sm-slots' });
    this.heldEl = h('div', { class: 'sm-held' });
    this.logEl = h('div', { class: 'sm-log' });
    this.root.append(
      h(
        'div',
        { class: 'll-row' },
        h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.spawn() }, 'Spawn'),
        h('button', { type: 'button', class: 'll-btn', onclick: () => this.destroyOldest() }, 'Destroy the oldest'),
        h('button', { type: 'button', class: 'll-btn', onclick: () => this.reset() }, 'Reset'),
      ),
      h('div', { class: 'll-h' }, 'Slots (the storage)'),
      this.slotsEl,
      h('div', { class: 'll-h' }, 'Handles your game code is holding'),
      this.heldEl,
      this.logEl,
    );
    this.reset();
  }

  private reset(): void {
    this.slots = Array.from({ length: CAP }, (_, i) => ({ gen: 0, alive: false, value: '', next: i + 1 < CAP ? i + 1 : -1 }));
    this.freeHead = 0;
    this.held = [];
    this.spawned = 0;
    this.log = [{ code: 'SlotMap<Unit> units;', text: `${CAP} empty slots, all on the free list.` }];
    this.render();
  }

  private push(code: string, text: string, cls?: string): void {
    this.log.unshift({ code, text, cls });
    this.log = this.log.slice(0, 5);
  }

  private spawn(): void {
    if (this.freeHead < 0) {
      this.push('units.insert(...)', 'No free slot: a real slot map would grow its arrays here (handles stay valid, raw pointers would not).', 'bad');
      return this.render();
    }
    const i = this.freeHead;
    const s = this.slots[i];
    this.freeHead = s.next;
    s.alive = true;
    s.value = `${NAMES[this.spawned % NAMES.length]}`;
    this.spawned++;
    const hd = { index: i, gen: s.gen, label: s.value };
    this.held.push(hd);
    this.flash = i;
    this.push(`Handle h = units.insert(${s.value})`, `Took slot ${i} from the head of the free list. Handle = (index ${i}, generation ${s.gen}).`);
    this.render();
  }

  private destroy(hd: Handle): void {
    const s = this.slots[hd.index];
    if (!s.alive || s.gen !== hd.gen) {
      this.push(`units.erase(${this.fmtH(hd)})`, 'Stale handle: the generation doesn\'t match, so nothing is destroyed. Without generations this would have destroyed whatever lives in the slot now.', 'bad');
      return this.render();
    }
    s.alive = false;
    s.gen++;
    s.next = this.freeHead;
    this.freeHead = hd.index;
    this.flash = hd.index;
    this.push(`units.erase(${this.fmtH(hd)})`, `Slot ${hd.index} freed: generation bumped to ${s.gen}, slot pushed on the free list. Every copy of this handle is now stale.`);
    this.render();
  }

  private destroyOldest(): void {
    const hd = this.held.find((x) => this.status(x) === 'valid');
    if (hd) this.destroy(hd);
  }

  private get(hd: Handle): void {
    const st = this.status(hd);
    const s = this.slots[hd.index];
    this.push(
      `units.get(${this.fmtH(hd)})`,
      st === 'valid'
        ? `→ ${s.value}. Index ${hd.index}, generation ${hd.gen} matches.`
        : s.alive
          ? `→ nullptr. Slot ${hd.index} now holds a ${s.value} (generation ${s.gen}); the handle's generation ${hd.gen} is stale.`
          : `→ nullptr. Slot ${hd.index} is empty (generation ${s.gen}), the handle has ${hd.gen}.`,
      st === 'valid' ? undefined : 'warn',
    );
    this.flash = hd.index;
    this.render();
  }

  private status(hd: Handle): 'valid' | 'stale' {
    const s = this.slots[hd.index];
    return s.alive && s.gen === hd.gen ? 'valid' : 'stale';
  }

  private fmtH(hd: Handle): string {
    return `{${hd.index}, v${hd.gen}}`;
  }

  private render(): void {
    // Which slots are on the free list, in order.
    const freeOrder = new Map<number, number>();
    for (let i = this.freeHead, k = 0; i >= 0 && k < CAP; i = this.slots[i].next, k++) freeOrder.set(i, k);
    this.slotsEl.replaceChildren(
      ...this.slots.map((s, i) =>
        h(
          'div',
          { class: `sm-slot${s.alive ? ' alive' : ''}${this.flash === i ? ' flash' : ''}` },
          h('span', { class: 'sm-i' }, `#${i}`),
          h('span', { class: 'sm-v' }, s.alive ? s.value : 'empty'),
          h('span', { class: 'sm-g' }, `gen ${s.gen}`),
          !s.alive ? h('span', { class: 'sm-next' }, i === this.freeHead ? 'free head' : '', s.next >= 0 ? ` next → #${s.next}` : ' end') : null,
        ),
      ),
    );
    this.heldEl.replaceChildren(
      ...(this.held.length
        ? this.held.map((hd) => {
            const st = this.status(hd);
            const packed = ((hd.gen << 16) | hd.index) >>> 0;
            return h(
              'div',
              { class: `sm-h ${st}` },
              h('span', { class: 'sm-hl' }, hd.label),
              h('code', { title: 'Packed as a 32-bit handle: generation in the high 16 bits, index in the low 16' }, `{${hd.index}, v${hd.gen}} = 0x${packed.toString(16).padStart(8, '0')}`),
              h('span', { class: 'sm-st' }, st),
              h('button', { type: 'button', class: 'll-btn', onclick: () => this.get(hd) }, 'get'),
              h('button', { type: 'button', class: 'll-btn', onclick: () => this.destroy(hd) }, 'erase'),
            );
          })
        : [h('p', { class: 'll-muted' }, 'Spawn something.')]),
    );
    this.logEl.replaceChildren(...this.log.map((l, k) => h('div', { class: `sm-l ${l.cls ?? ''}${k ? ' old' : ''}` }, h('code', {}, l.code), h('span', {}, l.text))));
    void fmt;
  }
}
