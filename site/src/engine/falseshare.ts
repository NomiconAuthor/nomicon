import { h, seg, fmt } from './dom';

/**
 * False sharing, as a toy cache-coherence model (MESI, reduced to the states that
 * matter here). Two cores each increment their own counter. If both counters sit
 * in one cache line, every write by one core invalidates the other's copy, and the
 * line ping-pongs between them. Padding puts each counter on its own line.
 */

type State = 'M' | 'S' | 'I';
const HIT = 1; // cycles for a write that hits a line the core owns
const TRANSFER = 70; // rough cycles to pull a line from the other core

export class FalseShare {
  private root: HTMLElement;
  private padded = false;
  private states: State[][] = []; // [core][line]
  private writes = [0, 0];
  private transfers = 0;
  private cycles = 0;
  private turn = 0;
  private log: string[] = [];
  private timer = 0;
  private view!: HTMLElement;
  private stats!: HTMLElement;
  private logEl!: HTMLElement;
  private playBtn!: HTMLButtonElement;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ll-fs' });
    host.replaceChildren(this.root);
    const s = seg<'shared' | 'padded'>(
      'Counters',
      [
        ['shared', 'Side by side (one line)'],
        ['padded', 'Padded to 64 bytes each'],
      ],
      'shared',
      (v) => {
        this.padded = v === 'padded';
        this.reset();
      },
    );
    this.playBtn = h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.toggle() }, 'Run both threads');
    this.view = h('div', { class: 'fs-view' });
    this.stats = h('div', { class: 'll-stats' });
    this.logEl = h('div', { class: 'fs-log' });
    this.root.append(
      h('div', { class: 'll-row' }, s.el),
      h('code', { class: 'll-code' }, this.padded ? '' : 'struct Counters { int a; int b; };  // thread 0 does a++, thread 1 does b++'),
      h('div', { class: 'll-row' }, h('button', { type: 'button', class: 'll-btn', onclick: () => this.reset() }, 'Reset'), h('button', { type: 'button', class: 'll-btn', onclick: () => this.step() }, 'One write'), this.playBtn),
      this.stats,
      this.view,
      this.logEl,
    );
    this.reset();
  }

  private lineOf(core: number): number {
    return this.padded ? core : 0;
  }

  private reset(): void {
    this.stop();
    const lines = this.padded ? 2 : 1;
    this.states = [new Array(lines).fill('I'), new Array(lines).fill('I')];
    this.writes = [0, 0];
    this.transfers = 0;
    this.cycles = 0;
    this.turn = 0;
    this.log = [];
    const code = this.root.querySelector('.ll-code');
    if (code)
      code.textContent = this.padded
        ? 'struct Counters { alignas(64) int a; alignas(64) int b; };  // each on its own cache line'
        : 'struct Counters { int a; int b; };  // thread 0 does a++, thread 1 does b++';
    this.render();
  }

  private step(): void {
    const core = this.turn;
    const other = 1 - core;
    const line = this.lineOf(core);
    const st = this.states[core][line];
    let msg: string;
    if (st === 'M') {
      this.cycles += HIT;
      msg = `core ${core}: ${core ? 'b' : 'a'}++ hits its own line (M): ~${HIT} cycle`;
    } else {
      const otherHad = this.states[other][line] !== 'I';
      this.states[other][line] = 'I';
      this.states[core][line] = 'M';
      this.transfers++;
      this.cycles += TRANSFER;
      msg = otherHad
        ? `core ${core}: ${core ? 'b' : 'a'}++ misses. The line is in core ${other}'s cache: invalidate it there, move it here (~${TRANSFER} cycles)`
        : `core ${core}: ${core ? 'b' : 'a'}++ misses. First touch: fetch the line (~${TRANSFER} cycles)`;
    }
    this.writes[core]++;
    this.log.unshift(msg);
    this.log = this.log.slice(0, 6);
    // Threads run truly in parallel; alternate to show the interleaving.
    this.turn = other;
    this.render();
  }

  private toggle(): void {
    if (this.timer) return this.stop();
    this.playBtn.textContent = 'Pause';
    this.timer = window.setInterval(() => {
      this.step();
      if (this.writes[0] + this.writes[1] >= 40) this.stop();
    }, 160);
  }
  private stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    if (this.playBtn) this.playBtn.textContent = 'Run both threads';
  }

  private render(): void {
    const lines = this.padded ? 2 : 1;
    const lineBox = (core: number, l: number) => {
      const st = this.states[core][l];
      const cells = [];
      for (let w = 0; w < 16; w++) {
        const isA = this.padded ? l === 0 && w === 0 : w === 0;
        const isB = this.padded ? l === 1 && w === 0 : w === 1;
        cells.push(h('span', { class: `fs-w${isA ? ' a' : ''}${isB ? ' b' : ''}` }, isA ? 'a' : isB ? 'b' : ''));
      }
      return h('div', { class: `fs-line st-${st}` }, h('span', { class: 'fs-st', title: st === 'M' ? 'Modified: this core owns the line' : st === 'S' ? 'Shared' : 'Invalid: not here (or stale)' }, st), ...cells);
    };
    const core = (c: number) =>
      h(
        'div',
        { class: `fs-core${this.turn === c ? ' next' : ''}` },
        h('div', { class: 'fs-core-h' }, `Core ${c} · L1 cache`, h('small', {}, ` writes ${c ? 'b' : 'a'}`)),
        ...Array.from({ length: lines }, (_, l) => lineBox(c, l)),
      );
    this.view.replaceChildren(core(0), core(1));
    const total = this.writes[0] + this.writes[1];
    const stat = (v: string, l: string) => h('div', { class: 'll-stat' }, h('b', {}, v), h('span', {}, l));
    this.stats.replaceChildren(
      stat(fmt(total), 'writes'),
      stat(fmt(this.transfers), 'line transfers'),
      stat(fmt(this.cycles), 'cycles (rough)'),
      stat(total ? fmt(this.cycles / total, 1) : '–', 'cycles per write'),
    );
    this.logEl.replaceChildren(...this.log.map((m, i) => h('div', { class: i ? 'old' : '' }, m)));
  }
}
