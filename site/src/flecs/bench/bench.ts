import type { FlecsWorld } from '../runtime';

type Ladder = ReturnType<FlecsWorld['benchLadder']>;
type Spatial = ReturnType<FlecsWorld['benchSpatial']>;

/**
 * Benchmarks that run natively inside the flecs WebAssembly module, so readers
 * can check performance claims themselves. Absolute numbers are WASM numbers in
 * this browser; the ratios are what matter. They run in a Web Worker
 * (bench.worker.ts) so the page stays responsive and a run can be cancelled.
 */

type El = HTMLElement;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

// 0 means the browser's clock (coarsened to ~0.1 ms) saw no time pass.
const ms = (v: number) => (v <= 0 ? '< 0.1 ms' : v < 0.01 ? (v * 1000).toFixed(2) + ' µs' : (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3)) + ' ms');

interface Row {
  label: string;
  sub?: string;
  values: Record<string, number>;
  extra?: string;
}

export class Bench {
  private worker: Worker | null = null;
  private root: El;
  private out!: El;
  private status!: El;

  constructor(
    host: El,
    private kind: 'ladder' | 'spatial',
  ) {
    this.root = h('div', { class: 'bench' }, h('p', { class: 'bench-muted' }, 'Starting flecs…'));
    host.replaceChildren(this.root);
  }

  async init(): Promise<void> {
    this.kind === 'ladder' ? this.buildLadder() : this.buildSpatial();
  }

  /** Run one request in the worker. `onProgress` gets (step, of) for multi-part runs. */
  private request<T>(msg: unknown, onProgress: (step: number, of: number) => void): Promise<T> {
    this.worker ??= new Worker(new URL('./bench.worker.ts', import.meta.url), { type: 'module' });
    const w = this.worker;
    return new Promise<T>((resolve, reject) => {
      w.onmessage = (e: MessageEvent<{ type: string; result?: T; message?: string; step?: number; of?: number }>) => {
        if (e.data.type === 'progress') onProgress(e.data.step!, e.data.of!);
        else if (e.data.type === 'done') resolve(e.data.result as T);
        else reject(new Error(e.data.message ?? 'benchmark failed'));
      };
      w.onerror = (e) => reject(new Error(e.message || 'benchmark worker failed'));
      w.postMessage(msg);
    });
  }

  private cancel(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private num(label: string, value: number, min: number, max: number, step: number): HTMLInputElement {
    return h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step), 'aria-label': label, class: 'bench-num' });
  }

  private shell(title: string, controls: El[], run: (progress: (text: string) => void) => Promise<Row[]>, columns: Array<[string, string]>): void {
    this.out = h('div', { class: 'bench-out' });
    this.status = h('span', { class: 'bench-muted', 'aria-live': 'polite' });
    let running = false;
    const btn = h('button', { type: 'button', class: 'bench-run' }, 'Run benchmark');
    const done = (text: string) => {
      running = false;
      btn.textContent = 'Run benchmark';
      this.status.textContent = text;
    };
    btn.addEventListener('click', async () => {
      if (running) {
        this.cancel();
        done('Cancelled.');
        return;
      }
      running = true;
      btn.textContent = 'Cancel';
      this.status.textContent = 'Starting flecs…';
      try {
        const rows = await run((text) => (this.status.textContent = text));
        if (!running) return;
        this.render(rows, columns);
        done('Done. Numbers are from WebAssembly in this browser: compare ratios, not absolutes.');
      } catch (e) {
        if (running) done(`Failed: ${(e as Error).message}`);
      }
    });
    this.root.replaceChildren(h('div', { class: 'bench-h' }, title), h('div', { class: 'bench-ctrls' }, ...controls, btn, this.status), this.out);
  }

  private render(rows: Row[], columns: Array<[string, string]>): void {
    const max: Record<string, number> = {};
    for (const [k] of columns) max[k] = Math.max(1e-9, ...rows.map((r) => r.values[k] ?? 0));
    this.out.replaceChildren(
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, ''), ...columns.map(([, l]) => h('th', {}, l)))),
        h(
          'tbody',
          {},
          ...rows.map((r) =>
            h(
              'tr',
              {},
              h('td', { class: 'bench-label' }, r.label, r.sub ? h('div', { class: 'bench-sub' }, r.sub) : null, r.extra ? h('div', { class: 'bench-sub' }, r.extra) : null),
              ...columns.map(([k]) => {
                const v = r.values[k] ?? 0;
                // Linear within each column, so bar lengths are honest ratios.
                const frac = Math.max(0.015, v / max[k]);
                return h('td', {}, h('div', { class: 'bench-bar', style: `--w:${(frac * 100).toFixed(1)}%` }), h('span', { class: 'bench-v' }, ms(v)));
              }),
            ),
          ),
        ),
      ),
    );
  }

  private buildLadder(): void {
    const n = this.num('Entities', 20000, 1000, 200000, 1000);
    this.shell(
      'The query cost ladder',
      [h('label', { class: 'bench-field' }, 'characters ', n)],
      async (progress) => {
        progress('Running…');
        const r = await this.request<Ladder>({ kind: 'ladder', n: Math.max(1000, Math.min(200000, Number(n.value) || 20000)) }, () => {});
        const labels = ['Plain terms (stats in one table)', 'Traversal: up HungerLink', 'Variable source: HungerLink($character, $this)'];
        return r.queries.map((q, i) => ({ label: labels[i], sub: q.expr, values: { build: q.build_ms, each: q.each_ms }, extra: `${q.matched} matched in ${q.batches} batch${q.batches === 1 ? '' : 'es'}` }));
      },
      [
        ['build', 'Build query'],
        ['each', 'Iterate once'],
      ],
    );
  }

  private buildSpatial(): void {
    const n = this.num('Entities', 20000, 1000, 100000, 1000);
    const grid = this.num('Grid size', 32, 4, 128, 1);
    const moving = this.num('Moving per frame', 2000, 0, 100000, 100);
    const lookups = this.num('Cell lookups per frame', 200, 1, 5000, 10);
    const labels = [
      ['Scan everything', 'no spatial structure: test each Position'],
      ['(InCell, cell) pair', 'one table per occupied cell; ecs_each_id'],
      ['(InCell, cell) DontFragment', 'pair in sparse storage; ecs_each_id'],
      ['Grid next to the ECS', 'plain arrays of entity ids per cell'],
      ['(InCell, $cell) query variable', 'same pair, looked up through a variable'],
    ];
    this.shell(
      'Spatial lookups',
      [
        h('label', { class: 'bench-field' }, 'entities ', n),
        h('label', { class: 'bench-field' }, 'grid ', grid),
        h('label', { class: 'bench-field' }, 'moving/frame ', moving),
        h('label', { class: 'bench-field' }, 'lookups/frame ', lookups),
      ],
      async (progress) => {
        const N = Math.max(1000, Math.min(100000, Number(n.value) || 20000));
        const G = Math.max(4, Math.min(128, Number(grid.value) || 32));
        const M = Math.max(0, Math.min(N, Number(moving.value) || 0));
        const L = Math.max(1, Math.min(5000, Number(lookups.value) || 200));
        const rs = await this.request<Spatial[]>({ kind: 'spatial', n: N, grid: G, moving: M, lookups: L }, (step, of) => progress(`Running layout ${step} of ${of}: ${labels[step - 1][0]}…`));
        return rs.map((r, mode) => ({
          label: labels[mode][0],
          sub: labels[mode][1],
          values: { update: r.update_ms, lookup: r.query_ms, all: r.all_ms },
          extra: `${r.tables} table${r.tables === 1 ? '' : 's'} with Position`,
        }));
      },
      [
        ['update', 'Move entities'],
        ['lookup', 'Cell lookups'],
        ['all', 'Iterate all Positions'],
      ],
    );
  }
}
