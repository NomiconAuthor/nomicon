import { h, fmt } from './dom';

/** Runs one of the memory benchmarks in a worker and draws the results as bars. */
type Kind = 'layout' | 'order' | 'stride';
interface Row {
  label: string;
  group: string;
  ms: number;
  touched?: number;
  lines?: number;
}

const SETUP: Record<Kind, { title: string; n: number; note: string }> = {
  layout: { title: 'Data layout: 1,000,000 units of 48 bytes', n: 1_000_000, note: 'Each loop touches the same data; only where it lives differs.' },
  order: { title: 'Access order: summing 8,000,000 ints (32 MB)', n: 8_000_000, note: 'The same reads, in three orders. Only the order changes.' },
  stride: { title: 'Stride: 4 million reads, spaced further and further apart', n: 1 << 24, note: 'Same number of reads every time; only the distance between them changes.' },
};

export class MemBench {
  private root: HTMLElement;
  private out: HTMLElement;
  private status: HTMLElement;
  private worker: Worker | null = null;

  constructor(host: HTMLElement, private kind: Kind) {
    const s = SETUP[kind];
    this.out = h('div', { class: 'll-bars' });
    this.status = h('span', { class: 'll-muted', 'aria-live': 'polite' }, s.note);
    const btn = h('button', { type: 'button', class: 'll-btn primary' }, 'Run in your browser');
    btn.addEventListener('click', () => this.run(btn));
    this.root = h('div', { class: 'll ll-bench' }, h('div', { class: 'll-h' }, s.title), h('div', { class: 'll-row' }, btn, this.status), this.out);
    host.replaceChildren(this.root);
  }

  private run(btn: HTMLButtonElement): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      btn.textContent = 'Run in your browser';
      this.status.textContent = 'Cancelled.';
      return;
    }
    btn.textContent = 'Cancel';
    this.status.textContent = 'Running… (a few seconds)';
    const w = new Worker(new URL('./membench.worker.ts', import.meta.url), { type: 'module' });
    this.worker = w;
    w.onmessage = (e: MessageEvent<{ ok: boolean; rows?: Row[]; message?: string }>) => {
      w.terminate();
      this.worker = null;
      btn.textContent = 'Run again';
      if (!e.data.ok) {
        this.status.textContent = `Failed: ${e.data.message}`;
        return;
      }
      this.status.textContent = 'Done. Times are per full pass over the data.';
      this.draw(e.data.rows!);
    };
    w.postMessage({ kind: this.kind, n: SETUP[this.kind].n });
  }

  private draw(rows: Row[]): void {
    const groups = [...new Set(rows.map((r) => r.group))];
    this.out.replaceChildren(
      ...groups.map((g) => {
        const rs = rows.filter((r) => r.group === g);
        const max = Math.max(...rs.map((r) => r.ms));
        const min = Math.min(...rs.map((r) => r.ms));
        return h(
          'div',
          { class: 'll-bar-group' },
          ...rs.map((r) =>
            h(
              'div',
              { class: 'll-bar-row' },
              h('span', { class: 'll-bar-l' }, r.label),
              h('span', { class: 'll-bar-t' }, h('i', { style: `width:${Math.max(1.5, (r.ms / max) * 100).toFixed(1)}%` })),
              h(
                'span',
                { class: 'll-bar-v' },
                `${fmt(r.ms, r.ms < 10 ? 2 : 1)} ms`,
                h('small', {}, r.ms === min ? ' fastest' : ` ${fmt(r.ms / min, 1)}×`),
                r.touched ? h('small', {}, ` · ${fmt((r.ms * 1e6) / r.touched, 2)} ns per read`) : null,
              ),
            ),
          ),
        );
      }),
    );
  }
}
