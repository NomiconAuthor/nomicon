import type { TraceEvent } from '../runtime';
import { describe, fmtValue, isHidden, isInternal, tableLabel } from './describe';
import type { StorageModel, TableState } from './model';
import { Session, categoryOf, fmtId, type Category, type Cursor, type Op, type QueryState, type Scenario } from './session';

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

/** A stable colour per component name, from the site's palette. */
function hue(name: string): string {
  let x = 0;
  for (const ch of name) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--c${(x % 8) + 1})`;
}

const CATEGORY_LABEL: Record<Category, string> = {
  storage: 'Storage',
  commands: 'Commands',
  callbacks: 'Systems & observers',
  frames: 'Frames',
  refs: 'References',
};

/**
 * The storage debugger: a code pane of operations, an event log of what flecs
 * did for the current one, the archetype tables (and sparse storage) at that
 * moment, and a "Now" panel with the current event, iterator locals and the
 * command queue.
 */
export class DebuggerView {
  private s: Session;
  private cursor: Cursor = { op: -1, ev: 0 };
  private breakOn: Set<Category>;
  private internals = false;
  private root: El;
  private codeEl!: El;
  private logEl!: El;
  private storageEl!: El;
  private sparseEl!: El;
  private queriesEl!: El;
  private refsEl!: El;
  /** Raw references at the cursor (for pins on table rows). */
  private refState: RefState[] = [];
  private nowEl!: El;
  private statsEl!: El;
  private statusEl!: El;
  private svg!: SVGSVGElement;
  private toolsEl!: El;
  private busy = false;

  constructor(host: El, scenario: Scenario) {
    this.s = new Session(scenario);
    this.breakOn = new Set(scenario.breakOn ?? ['storage', 'callbacks']);
    this.root = h('div', { class: 'fdbg', 'data-loading': true });
    host.replaceChildren(this.root);
    this.root.append(h('p', { class: 'fdbg-loading' }, 'Starting flecs…'));
  }

  async init(): Promise<void> {
    try {
      await this.s.start();
    } catch (e) {
      this.root.replaceChildren(h('p', { class: 'fdbg-error' }, `Couldn't start flecs: ${(e as Error).message}`));
      return;
    }
    this.root.removeAttribute('data-loading');
    this.build();
    this.render();
    window.addEventListener('resize', () => this.drawArrows());
  }

  // ---------------- Layout ----------------

  private build(): void {
    const sc = this.s.scenario;
    const btn = (label: string, title: string, fn: () => void, cls = '') =>
      h('button', { type: 'button', class: `fdbg-btn ${cls}`, title, 'aria-label': title, onclick: fn }, label);
    const breaks = h(
      'div',
      { class: 'fdbg-breaks', role: 'group', 'aria-label': 'Continue stops at' },
      h('span', {}, 'Stop at:'),
      ...(Object.keys(CATEGORY_LABEL) as Category[]).filter((c) => c !== 'refs' || sc.refs).map((c) => {
        const input = h('input', { type: 'checkbox', onchange: (e: Event) => ((e.target as HTMLInputElement).checked ? this.breakOn.add(c) : this.breakOn.delete(c)) });
        input.checked = this.breakOn.has(c);
        return h('label', { class: `fdbg-chk cat-${c}` }, input, CATEGORY_LABEL[c]);
      }),
    );
    const internals = h('input', {
      type: 'checkbox',
      onchange: (e: Event) => {
        this.internals = (e.target as HTMLInputElement).checked;
        this.render();
      },
    });
    this.statusEl = h('span', { class: 'fdbg-status', 'aria-live': 'polite' });
    const variants = sc.variants?.length
      ? h(
          'div',
          { class: 'fdbg-variants', role: 'radiogroup', 'aria-label': 'Setup' },
          ...sc.variants.map((v, i) =>
            h(
              'button',
              {
                type: 'button',
                role: 'radio',
                'aria-checked': String(i === this.s.variant),
                class: 'fdbg-var',
                onclick: async (e: Event) => {
                  const btn = e.currentTarget;
                  this.s.variant = i;
                  this.root.querySelectorAll('.fdbg-var').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
                  if (v.wasm || sc.variants!.some((x) => x.wasm)) {
                    this.status('Loading that flecs build…');
                    await this.s.start();
                    this.cursor = { op: -1, ev: 0 };
                    this.render();
                  } else this.restart();
                  if (v.note) this.status(v.note);
                },
              },
              v.label,
            ),
          ),
        )
      : null;
    const bar = h(
      'div',
      { class: 'fdbg-bar' },
      h(
        'div',
        { class: 'fdbg-ctrls' },
        btn('⟲', 'Restart (fresh world)', () => this.restart()),
        btn('◀', 'Step back', () => this.back()),
        btn('Step ▶', 'Step: next thing flecs does', () => this.step(), 'primary'),
        btn('Line ⤼', 'Run the current line to the end', () => this.nextLine()),
        btn('Continue ▶▶', 'Run to the next stop (see "Stop at")', () => this.cont()),
      ),
      variants ?? '',
      breaks,
      h('label', { class: 'fdbg-chk' }, internals, 'flecs internals'),
      this.statusEl,
    );
    this.codeEl = h('div', { class: 'fdbg-code', role: 'list', 'aria-label': 'Code' });
    this.toolsEl = h('div', { class: 'fdbg-tools' });
    this.logEl = h('ol', { class: 'fdbg-log', 'aria-label': 'What flecs did' });
    this.statsEl = h('div', { class: 'fdbg-stats' });
    this.storageEl = h('div', { class: 'fdbg-tables' });
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('fdbg-arrows');
    this.sparseEl = h('div', { class: 'fdbg-sparse' });
    this.queriesEl = h('div', { class: 'fdbg-queries' });
    this.refsEl = h('div', { class: 'fdbg-refs' });
    this.nowEl = h('div', { class: 'fdbg-now', 'aria-live': 'polite' });
    const storageWrap = h('div', { class: 'fdbg-storage' }, this.storageEl, this.svg as unknown as El);
    this.root.replaceChildren(
      bar,
      this.s.setupError ? h('p', { class: 'fdbg-error' }, `Setup failed: ${this.s.setupError}`) : '',
      h(
        'div',
        { class: 'fdbg-main' },
        h('div', { class: 'fdbg-left' }, h('div', { class: 'fdbg-h' }, 'Code'), this.codeEl, this.toolsEl, h('div', { class: 'fdbg-h' }, 'What flecs did'), this.logEl),
        h(
          'div',
          { class: 'fdbg-right' },
          h('div', { class: 'fdbg-h' }, 'Storage', this.statsEl),
          storageWrap,
          this.sparseEl,
          this.queriesEl,
          this.refsEl,
          h('div', { class: 'fdbg-h' }, 'Now'),
          this.nowEl,
        ),
      ),
    );
    if (sc.tools) this.buildTools();
    this.root.tabIndex = -1;
    this.root.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowRight' || e.key === 'F10') {
        e.preventDefault();
        this.step();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.back();
      } else if (e.key === 'F5') {
        e.preventDefault();
        this.cont();
      }
    });
  }

  private buildTools(): void {
    const tools = this.s.scenario.tools!;
    const comps = tools.components ?? [];
    const entitySel = h('select', { 'aria-label': 'Entity' });
    const actionSel = h('select', { 'aria-label': 'Action' }, ...['add', 'set', 'remove', 'delete'].map((a) => h('option', { value: a }, a)));
    const compSel = h('select', { 'aria-label': 'Component' }, ...comps.map((c) => h('option', { value: c }, c)));
    const valueIn = h('input', { type: 'text', value: '{}', 'aria-label': 'Value (JSON)', class: 'fdbg-value', spellcheck: 'false' });
    // Your operations run after the scenario's own code, so offer the entities that
    // exist once that code has finished (running it ahead doesn't move the cursor).
    const refreshEntities = (finish = false) => {
      if (finish) while (this.s.queue.length) this.s.runNext();
      const m = this.s.done.at(-1)?.after ?? this.s.base;
      const names = [...new Set([...m.tables.values()].flatMap((t) => t.rows).map((e) => this.s.name(e)))].sort();
      const cur = entitySel.value;
      entitySel.replaceChildren(...names.map((n) => h('option', { value: n }, n)));
      if (names.includes(cur)) entitySel.value = cur;
    };
    const sync = () => {
      valueIn.hidden = actionSel.value !== 'set';
      compSel.hidden = actionSel.value === 'delete';
    };
    actionSel.addEventListener('change', sync);
    entitySel.addEventListener('focus', () => refreshEntities(true));
    entitySel.addEventListener('pointerdown', () => refreshEntities(true));
    sync();
    const doIt = () => {
      const e = entitySel.value;
      const c = compSel.value;
      const a = actionSel.value;
      if (!e) return;
      // Show it the way the scenario's code names entities (ship, rock) where possible.
      const v = /^[A-Za-z_]\w*$/.test(e) ? e[0].toLowerCase() + e.slice(1) : `world.lookup("${e}")`;
      let value: unknown = {};
      if (a === 'set') {
        try {
          value = JSON.parse(valueIn.value || '{}');
        } catch {
          this.status('The value must be JSON, e.g. {"x": 1, "y": 2}');
          return;
        }
      }
      const op: Op =
        a === 'add'
          ? { code: `${v}.add<${c}>();`, run: (ctx) => ctx.add(e, c) }
          : a === 'remove'
            ? { code: `${v}.remove<${c}>();`, run: (ctx) => ctx.remove(e, c) }
            : a === 'delete'
              ? { code: `${v}.destruct();`, run: (ctx) => ctx.delete(e) }
              : { code: `${v}.set<${c}>(${fmtValue(value) === '·' ? '{}' : `{${fmtValue(value)}}`});`, run: (ctx) => ctx.set(e, c, value) };
      this.runNow(op);
    };
    let spawned = 0;
    this.toolsEl.append(
      h('div', { class: 'fdbg-h' }, 'Try it ', h('span', { class: 'fdbg-h-note' }, '· runs after the code above')),
      h('div', { class: 'fdbg-toolrow' }, entitySel, actionSel, compSel, valueIn, h('button', { type: 'button', class: 'fdbg-btn primary', onclick: doIt }, 'Run')),
      h(
        'div',
        { class: 'fdbg-toolrow' },
        tools.frame !== false ? h('button', { type: 'button', class: 'fdbg-btn', onclick: () => this.runNow({ code: 'world.progress();', run: (ctx) => ctx.progress() }) }, 'Run a frame') : null,
        tools.spawn
          ? h(
              'button',
              {
                type: 'button',
                class: 'fdbg-btn',
                onclick: () => {
                  const name = `E${++spawned}`;
                  this.runNow({ code: `world.entity("${name}");`, run: (ctx) => ctx.create(name) });
                },
              },
              'New entity',
            )
          : null,
      ),
    );
    this.refreshTools = refreshEntities;
    refreshEntities();
  }

  private refreshTools: () => void = () => {};

  // ---------------- Navigation ----------------

  private events(op: number): TraceEvent[] {
    return op >= 0 ? this.s.done[op].events : [];
  }

  /** Can event i of op be a step (shown in the log)? */
  private visible(ev: TraceEvent): boolean {
    if (isHidden(ev)) return false;
    if (!this.internals && isInternal(ev, this.s)) return false;
    return true;
  }

  /** Ensure op i has been run (ops run lazily, when first stepped into). */
  private ensureOp(i: number): boolean {
    while (this.s.done.length <= i) {
      if (!this.s.queue.length) return false;
      this.s.runNext();
    }
    return true;
  }

  private next(c: Cursor): Cursor | null {
    const evs = this.events(c.op);
    for (let i = c.ev; i < evs.length; i++) if (this.visible(evs[i])) return { op: c.op, ev: i + 1 };
    if (c.op >= 0 && c.ev < evs.length) return { op: c.op, ev: evs.length };
    if (!this.ensureOp(c.op + 1)) return null;
    return { op: c.op + 1, ev: 0 };
  }

  private prev(c: Cursor): Cursor | null {
    const evs = this.events(c.op);
    for (let i = Math.min(c.ev, evs.length) - 2; i >= 0; i--) if (this.visible(evs[i])) return { op: c.op, ev: i + 1 };
    if (c.ev > 0) return { op: c.op, ev: 0 };
    if (c.op < 0) return null;
    if (c.op === 0) return { op: -1, ev: 0 };
    return { op: c.op - 1, ev: this.events(c.op - 1).length };
  }

  private step(): void {
    const n = this.next(this.cursor);
    if (!n) return this.status('End of the code. Use "Try it" to do more, or restart.');
    this.cursor = n;
    this.render();
  }

  private back(): void {
    const p = this.prev(this.cursor);
    if (!p) return;
    this.cursor = p;
    this.render();
  }

  private nextLine(): void {
    const evs = this.events(this.cursor.op);
    if (this.cursor.op >= 0 && this.cursor.ev < evs.length) this.cursor = { op: this.cursor.op, ev: evs.length };
    else {
      if (!this.ensureOp(this.cursor.op + 1)) return this.status('End of the code.');
      this.cursor = { op: this.cursor.op + 1, ev: this.events(this.cursor.op + 1).length };
    }
    this.render();
  }

  private cont(): void {
    let c: Cursor | null = this.cursor;
    for (let guard = 0; guard < 100000; guard++) {
      c = this.next(c);
      if (!c) {
        this.cursor = this.lastCursor();
        this.render();
        return this.status('Ran to the end.');
      }
      const ev = c.ev > 0 ? this.events(c.op)[c.ev - 1] : null;
      const cat = ev ? categoryOf(ev) : null;
      if (ev && cat && this.breakOn.has(cat) && this.visible(ev)) break;
    }
    this.cursor = c!;
    this.render();
  }

  private lastCursor(): Cursor {
    const op = this.s.done.length - 1;
    return { op, ev: op >= 0 ? this.events(op).length : 0 };
  }

  private restart(): void {
    this.s.reset();
    this.cursor = { op: -1, ev: 0 };
    this.render();
    this.status('Fresh world.');
  }

  /** Run everything queued, then `op`, and stop at the start of `op`. */
  private runNow(op: Op): void {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.s.queue.length) this.s.runNext();
      const rec = this.s.runNext(op);
      this.cursor = { op: this.s.done.length - 1, ev: 0 };
      if (rec?.error) this.status(`flecs refused: ${rec.error}`);
      this.render();
    } finally {
      this.busy = false;
    }
  }

  private status(text: string): void {
    this.statusEl.textContent = text;
    window.clearTimeout((this.statusEl as El & { t?: number }).t);
    (this.statusEl as El & { t?: number }).t = window.setTimeout(() => (this.statusEl.textContent = ''), 4000);
  }

  // ---------------- Rendering ----------------

  private types(op: number): (table: number) => string[] | undefined {
    const rec = op >= 0 ? this.s.done[op] : null;
    return (table: number) => {
      const fromRec = rec?.types.get(table);
      if (fromRec) return fromRec;
      const m = rec?.after ?? this.s.base;
      return m.tables.get(table)?.type.map((t) => t.str) ?? this.s.base.tables.get(table)?.type.map((t) => t.str) ?? this.s.world.tableType(table) ?? undefined;
    };
  }

  /** Query caches at the cursor: tables join a cache when its observer is told about them. */
  private queriesAt(): QueryState[] {
    const c = this.cursor;
    if (c.op < 0) return this.s.baseQueries;
    const rec = this.s.done[c.op];
    const evs = rec.events;
    if (c.ev >= evs.length) return rec.queries;
    const prev = c.op > 0 ? this.s.done[c.op - 1].queries : this.s.baseQueries;
    return rec.queries.map((q) => {
      const p = prev.find((x) => x.name === q.name);
      const cache = new Set(p?.cache ?? []);
      for (let i = 0; i < c.ev; i++) {
        const e = evs[i];
        if (e.k === 'observer' && e.event === 'OnTableCreate' && e.name === q.name && q.cache.includes(e.table)) cache.add(e.table);
      }
      return { ...q, cache: q.cache.filter((t) => cache.has(t)), results: p?.results ?? q.results };
    });
  }

  private render(): void {
    this.refreshTools();
    const c = this.cursor;
    const state = this.s.stateAt(c);
    const cur = c.op >= 0 && c.ev > 0 ? this.events(c.op)[c.ev - 1] : null;
    this.renderCode();
    this.renderLog();
    this.refState = this.refsAt();
    this.renderRefs();
    const queries = this.queriesAt();
    this.renderStorage(state, cur, queries);
    this.renderQueries(queries, state);
    this.renderNow(state, cur);
    requestAnimationFrame(() => this.drawArrows());
  }

  private renderCode(): void {
    const sc = this.s.scenario;
    const lines: El[] = [];
    const setupCode = [sc.setupCode, sc.variants?.[this.s.variant]?.setupCode].filter(Boolean).join('\n');
    if (setupCode) lines.push(h('details', { class: 'fdbg-setup' }, h('summary', {}, 'Setup'), h('pre', {}, setupCode)));
    const defs = [...(sc.variants?.[this.s.variant]?.systems ?? sc.systems ?? []), ...(sc.observers ?? [])].filter((d) => d.code);
    if (defs.length)
      lines.push(
        h(
          'details',
          { class: 'fdbg-setup', open: true },
          h('summary', {}, `Systems & observers (${defs.length})`),
          ...defs.map((d) => h('pre', { class: 'fdbg-def' }, d.code!)),
        ),
      );
    const all = [...this.s.done.map((r) => r.op), ...this.s.queue];
    all.forEach((op, i) => {
      const state = i < this.cursor.op ? 'done' : i === this.cursor.op ? (this.cursor.ev >= this.events(i).length ? 'done current' : 'current') : 'todo';
      const rec = this.s.done[i];
      lines.push(
        h(
          'div',
          {
            class: `fdbg-line ${state}`,
            role: 'listitem',
            'aria-current': i === this.cursor.op ? 'step' : undefined,
            title: 'Run to this line',
            onclick: () => {
              if (!this.ensureOp(i)) return;
              this.cursor = { op: i, ev: 0 };
              this.render();
            },
          },
          h('span', { class: 'gut', 'aria-hidden': 'true' }, i === this.cursor.op ? '▶' : ''),
          h('code', {}, op.code),
          rec?.error ? h('span', { class: 'err' }, ` ✕ ${rec.error}`) : null,
        ),
      );
    });
    if (!all.length) lines.push(h('p', { class: 'fdbg-empty' }, 'No code yet: use Try it.'));
    this.codeEl.replaceChildren(...lines);
  }

  private renderLog(): void {
    const c = this.cursor;
    if (c.op < 0) {
      this.logEl.replaceChildren(h('li', { class: 'fdbg-empty' }, 'Press Step to run the first line.'));
      return;
    }
    const evs = this.events(c.op);
    const types = this.types(c.op);
    const items: El[] = [];
    let depth = 0;
    evs.forEach((ev, i) => {
      if (ev.k === 'systemEnd' || ev.k === 'flushEnd' || ev.k === 'frameEnd') depth = Math.max(0, depth - 1);
      if (this.visible(ev)) {
        const d = describe(ev, this.s, types);
        const state = i + 1 === c.ev ? 'current' : i + 1 < c.ev ? 'past' : 'future';
        items.push(
          h(
            'li',
            {
              class: `ev ${state} tone-${d.tone ?? 'muted'}`,
              style: `--depth:${depth}`,
              onclick: () => {
                this.cursor = { op: c.op, ev: i + 1 };
                this.render();
              },
            },
            h('span', { class: 'ev-t' }, d.title),
            d.fn ? h('span', { class: 'ev-fn' }, d.fn) : null,
          ),
        );
      }
      if (ev.k === 'systemBegin' || ev.k === 'flushBegin' || ev.k === 'frameBegin') depth++;
    });
    if (!items.length) items.push(h('li', { class: 'fdbg-empty' }, 'Nothing visible happened (turn on flecs internals to see more).'));
    this.logEl.replaceChildren(...items);
    // Keep the current entry visible by scrolling the log box only. scrollIntoView
    // would also scroll the page, dragging it down as the log grows.
    const cur = this.logEl.querySelector<HTMLElement>('.current');
    if (cur) {
      const box = this.logEl.getBoundingClientRect();
      const r = cur.getBoundingClientRect();
      if (r.top < box.top) this.logEl.scrollTop -= box.top - r.top;
      else if (r.bottom > box.bottom) this.logEl.scrollTop += r.bottom - box.bottom;
    }
  }

  /** Highlights for the current event: table, row and cell classes, and an arrow. */
  private highlights(cur: TraceEvent | null, state: StorageModel) {
    const table = new Map<number, string>();
    const row = new Map<string, string>();
    const cell = new Map<string, string>();
    const arrows: Array<[string, string]> = [];
    const notes = new Map<string, string>();
    const rowKey = (t: number, e: number) => `${t}:${e}`;
    if (!cur) return { table, row, cell, arrows, notes };
    const c = this.cursor;
    const evs = this.events(c.op);
    // Inside a move, keep both ends visible.
    let move: Extract<TraceEvent, { k: 'moveBegin' }> | null = null;
    for (let i = c.ev - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.k === 'moveEnd') break;
      if (e.k === 'moveBegin') {
        move = e;
        break;
      }
    }
    if (move) {
      table.set(move.to, 'target');
      const srcRow = state.tables.get(move.from)?.rows.indexOf(move.entity) ?? -1;
      if (srcRow >= 0) row.set(rowKey(move.from, move.entity), 'leaving');
      const dstHas = state.tables.get(move.to)?.rows.includes(move.entity);
      if (srcRow >= 0) arrows.push([`r:${move.from}:${move.entity}`, dstHas ? `r:${move.to}:${move.entity}` : `t:${move.to}`]);
    }
    switch (cur.k) {
      case 'tableNew':
        table.set(cur.table, 'new');
        break;
      case 'grow':
        table.set(cur.table, 'shrink');
        break;
      case 'append':
        row.set(rowKey(cur.table, cur.entity), 'arrive');
        break;
      case 'delete':
        table.set(cur.table, 'shrink');
        if (cur.moved) {
          row.set(rowKey(cur.table, cur.moved), 'swapped');
          notes.set(rowKey(cur.table, cur.moved), `↑ from row ${cur.last}`);
        }
        break;
      case 'iter': {
        table.set(cur.table, 'iterating');
        const t = state.tables.get(cur.table);
        t?.rows.slice(cur.offset, cur.offset + cur.count).forEach((e) => row.set(rowKey(cur.table, e), 'iter'));
        break;
      }
      case 'observer':
      case 'hook': {
        if (cur.table) table.set(cur.table, cur.event === 'OnTableCreate' ? 'new' : table.get(cur.table) ?? '');
        if (cur.entity) {
          const w = state.where.get(cur.entity);
          if (w) row.set(rowKey(w.table, cur.entity), 'event');
        }
        break;
      }
      case 'write': {
        const w = state.where.get(cur.entity);
        if (w) cell.set(`${w.table}:${cur.entity}:${cur.id}`, 'written');
        break;
      }
      case 'cmdRun': {
        const w = state.where.get(cur.entity);
        if (w) row.set(rowKey(w.table, cur.entity), 'event');
        break;
      }
      case 'sparseAdd':
      case 'sparseRemove':
        cell.set(`sparse:${cur.id}:${cur.entity}`, cur.k === 'sparseAdd' ? 'arrive' : 'leaving');
        break;
    }
    return { table, row, cell, arrows, notes };
  }

  /** Where each raw reference points at the cursor, and whether it is still valid. */
  private refsAt(): RefState[] {
    if (!this.s.scenario.refs) return [];
    const refs = new Map<string, RefState>();
    const c = this.cursor;
    for (let op = 0; op <= c.op; op++) {
      const evs = this.events(op);
      const upto = op === c.op ? Math.min(c.ev, evs.length) : evs.length;
      for (let i = 0; i < upto; i++) {
        const ev = evs[i];
        if (ev.k === 'refTake') {
          refs.set(ev.label, { label: ev.label, entity: ev.entity, comp: ev.comp, table: ev.table, row: ev.row, addr: ev.addr, valid: true, reason: '' });
          continue;
        }
        for (const r of refs.values()) {
          if (!r.valid) continue;
          if (r.table < 0) {
            if (ev.k === 'sparseRemove' && ev.entity === r.entity && ev.id === r.comp) [r.valid, r.reason] = [false, `${r.comp} was removed from ${this.s.name(r.entity)}: the sparse value was freed`];
            if (ev.k === 'delete' && ev.entity === r.entity && !this.events(op).some((x) => x.k === 'moveBegin' && x.entity === r.entity)) [r.valid, r.reason] = [false, `${this.s.name(r.entity)} was deleted`];
            continue;
          }
          if (ev.k === 'moveBegin' && ev.entity === r.entity && ev.from === r.table) [r.valid, r.reason] = [false, `${this.s.name(r.entity)} moved to another table; ${r.label} still points at row ${r.row} of the old one`];
          else if (ev.k === 'delete' && ev.table === r.table && ev.entity === r.entity) [r.valid, r.reason] = [false, `${this.s.name(r.entity)}'s row was deleted`];
          else if (ev.k === 'delete' && ev.table === r.table && ev.moved === r.entity && ev.last === r.row)
            [r.valid, r.reason] = [false, `${this.s.name(r.entity)} was swapped from row ${r.row} to row ${ev.row} when ${this.s.name(ev.entity)} left; ${r.label} still points at row ${r.row}`];
          else if (ev.k === 'grow' && ev.table === r.table) [r.valid, r.reason] = [false, `the table grew from ${ev.from} to ${ev.to} rows and its columns were reallocated; ${r.label} points at the old, freed column`];
        }
      }
    }
    return [...refs.values()];
  }

  private renderRefs(): void {
    if (!this.refState.length) {
      this.refsEl.replaceChildren();
      return;
    }
    this.refsEl.replaceChildren(
      h('div', { class: 'fdbg-h' }, 'References held by the code'),
      ...this.refState.map((r) =>
        h(
          'div',
          { class: `fdbg-ref ${r.valid ? 'ok' : 'bad'}` },
          h('code', {}, `${r.comp}& ${r.label}`),
          h('span', { class: 'ref-st' }, r.valid ? 'valid' : 'dangling'),
          h('span', { class: 'ref-why' }, r.valid ? `${this.s.name(r.entity)}'s ${r.comp}${r.table >= 0 ? `, row ${r.row}` : ' (sparse storage)'}` : r.reason),
        ),
      ),
    );
  }

  private renderQueries(queries: QueryState[], state: StorageModel): void {
    const types = this.types(this.cursor.op);
    const named = queries.filter((q) => this.s.queryIds.has(q.name) || (this.s.scenario.queries?.length ?? 0) > 0);
    if (!named.length) {
      this.queriesEl.replaceChildren();
      return;
    }
    this.queriesEl.replaceChildren(
      h('div', { class: 'fdbg-h' }, 'Queries'),
      h(
        'div',
        { class: 'fdbg-qs' },
        ...named.map((q) => {
          const shown = q.cache.filter((t) => state.tables.has(t));
          return h(
            'div',
            { class: 'fdbg-q' },
            h('div', { class: 'q-h' }, h('span', { class: 'q-badge', style: `--chip:${hue(q.name)}` }, q.name), h('code', {}, q.expr), h('span', { class: 'q-kind' }, q.cached ? 'cached' : 'uncached')),
            q.cached
              ? h('p', {}, `Cache: ${q.cache.length} table${q.cache.length === 1 ? '' : 's'}`, shown.length ? ` (${shown.map((t) => tableLabel(types(t), t)).join(', ')})` : '', q.cache.length > shown.length ? ` + ${q.cache.length - shown.length} with no lesson entities` : '')
              : h('p', {}, 'No cache: each iteration searches the component index for matching tables.'),
          );
        }),
      ),
    );
  }

  private renderStorage(state: StorageModel, cur: TraceEvent | null, queries: QueryState[] = []): void {
    this.cacheBadges = new Map();
    for (const q of queries) for (const t of q.cached ? q.cache : q.results.map((r) => r[0])) this.cacheBadges.set(t, [...(this.cacheBadges.get(t) ?? []), q.name]);
    const hl = this.highlights(cur, state);
    this.pendingArrows = hl.arrows;
    const st = state.stats();
    const iters = this.cursor.op >= 0 ? this.events(this.cursor.op).filter((e) => e.k === 'iter').length : 0;
    this.statsEl.replaceChildren(
      stat('tables', st.tables),
      stat('entities', st.entities),
      stat('per table', st.perTable ? st.perTable.toFixed(1) : '0'),
      st.empty ? stat('empty', st.empty) : '',
      st.sparse ? stat('sparse', st.sparse) : '',
      iters ? stat('callbacks this line', iters) : '',
    );
    const cards = state.sortedTables().map((t) => this.tableCard(t, hl));
    if (!cards.length) cards.push(h('p', { class: 'fdbg-empty' }, 'No entities yet.'));
    this.storageEl.replaceChildren(...cards);

    const sparse = [...state.sparse.values()];
    this.sparseEl.replaceChildren(
      ...(sparse.length
        ? [
            h('div', { class: 'fdbg-h' }, 'Sparse storage'),
            h(
              'div',
              { class: 'fdbg-sparse-sets' },
              ...sparse.map((s) =>
                h(
                  'div',
                  { class: 'fdbg-sset' },
                  h('div', { class: 'sset-h' }, h('span', { class: 'chip', style: `--chip:${hue(s.id)}` }, s.id), h('span', { class: 'sset-kind' }, s.dontFragment ? 'DontFragment' : 'Sparse')),
                  s.entities.filter((e) => state.user.has(e)).length
                    ? h(
                        'table',
                        {},
                        h('tbody', {}, ...s.entities.map((e, i) => (state.user.has(e) ? h('tr', { class: hl.cell.get(`sparse:${s.id}:${e}`) ?? '' }, h('td', { class: 'ent' }, this.s.name(e)), h('td', {}, fmtValue(s.values[i]))) : null))),
                      )
                    : h('p', { class: 'fdbg-empty' }, 'empty'),
                ),
              ),
            ),
          ]
        : []),
    );
  }

  private cacheBadges = new Map<number, string[]>();

  private tableCard(t: TableState, hl: ReturnType<DebuggerView['highlights']>): El {
    const named = t.type.some((c) => c.kind === 'name');
    const badges = (this.cacheBadges.get(t.id) ?? []).filter((n) => this.s.queryIds.has(n) || [...this.s.systems.values()].some((d) => d.name === n));
    const cols = t.type.filter((c) => c.column && c.kind !== 'name');
    const chips = t.type.filter((c) => c.kind !== 'name');
    const head = h(
      'div',
      { class: 'tc-h' },
      h('span', { class: 'tc-id' }, `#${t.id}`),
      h(
        'span',
        { class: 'tc-type' },
        ...(chips.length
          ? chips.map((c) => h('span', { class: `chip k-${c.kind}`, style: `--chip:${hue(c.str)}`, title: chipTitle(c.kind) }, c.str))
          : named
            ? []
            : [h('span', { class: 'chip k-root' }, 'no components')]),
        named ? h('span', { class: 'chip k-name', title: 'Names are a component too: (Identifier, Name)' }, chips.length ? 'name' : 'name only') : null,
      ),
      h('span', { class: 'tc-n', title: 'rows used / rows allocated' }, `${t.rows.length}${t.capacity ? ` / ${t.capacity}` : ''} row${t.rows.length === 1 && !t.capacity ? '' : 's'}`),
      badges.length ? h('span', { class: 'tc-q' }, ...badges.map((b) => h('span', { class: 'q-badge', style: `--chip:${hue(b)}`, title: `In the cache of ${b}` }, b))) : '',
    );
    const header = h('tr', {}, h('th', { class: 'rn' }, '#'), h('th', {}, 'entity'), ...cols.map((c) => h('th', { style: `--chip:${hue(c.str)}` }, c.str)));
    const pins = this.refState.filter((p) => p.table === t.id);
    const pin = (r: number) =>
      pins
        .filter((p) => p.row === r && !p.reason.includes('reallocated'))
        .map((p) => h('span', { class: `ref-pin ${p.valid ? 'ok' : 'bad'}`, title: p.valid ? `${p.label} points here` : `${p.label} (dangling) still points here` }, `◆ ${p.label}`));
    const ghosts = pins.filter((p) => p.row >= t.rows.length && !p.reason.includes('reallocated'));
    const freed = pins.filter((p) => p.reason.includes('reallocated'));
    const rows = t.rows.map((e, r) => {
      const key = `${t.id}:${e}`;
      const note = hl.notes.get(key);
      return h(
        'tr',
        { class: `row ${hl.row.get(key) ?? ''}`, 'data-k': `r:${t.id}:${e}` },
        h('td', { class: 'rn' }, String(r)),
        h('td', { class: 'ent' }, this.s.name(e), this.s.scenario.showIds ? h('span', { class: 'eid' }, ` #${fmtId(e)}`) : null, note ? h('span', { class: 'note' }, note) : null, ...pin(r)),
        ...cols.map((c) => h('td', { class: hl.cell.get(`${t.id}:${e}:${c.str}`) ?? '' }, fmtValue(t.values.get(c.str)?.[r]))),
      );
    });
    return h(
      'div',
      { class: `tcard ${hl.table.get(t.id) ?? ''}`, 'data-k': `t:${t.id}` },
      head,
      t.rows.length || ghosts.length
        ? h(
            'table',
            {},
            h('thead', {}, header),
            h(
              'tbody',
              {},
              ...rows,
              ...ghosts.map((p) => h('tr', { class: 'row ghost' }, h('td', { class: 'rn' }, String(p.row)), h('td', { class: 'ent', colspan: String(cols.length + 1) }, 'past the end ', ...pin(p.row)))),
            ),
          )
        : h('p', { class: 'tc-empty' }, 'empty'),
      freed.length ? h('p', { class: 'tc-freed' }, ...freed.map((p) => h('span', { class: 'ref-pin bad' }, `◆ ${p.label}`)), ' → this table\'s old columns (freed by the regrow)') : null,
      t.hiddenRows > 0 && this.internals ? h('p', { class: 'tc-hidden' }, `+ ${t.hiddenRows} flecs entities`) : null,
    );
  }

  private pendingArrows: Array<[string, string]> = [];

  private drawArrows(): void {
    const svg = this.svg;
    while (svg.firstChild) svg.firstChild.remove();
    const wrap = svg.parentElement!;
    const box = wrap.getBoundingClientRect();
    svg.setAttribute('width', String(wrap.scrollWidth));
    svg.setAttribute('height', String(wrap.scrollHeight));
    const ns = 'http://www.w3.org/2000/svg';
    if (!svg.querySelector('marker')) {
      const defs = document.createElementNS(ns, 'defs');
      const m = document.createElementNS(ns, 'marker');
      m.setAttribute('id', 'fdbg-head');
      m.setAttribute('viewBox', '0 0 10 10');
      m.setAttribute('refX', '9');
      m.setAttribute('refY', '5');
      m.setAttribute('markerWidth', '7');
      m.setAttribute('markerHeight', '7');
      m.setAttribute('orient', 'auto-start-reverse');
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', 'M0,0 L10,5 L0,10 z');
      p.setAttribute('class', 'arrow-head');
      m.append(p);
      defs.append(m);
      svg.append(defs);
    }
    for (const [from, to] of this.pendingArrows) {
      const a = this.storageEl.querySelector(`[data-k="${from}"]`);
      const b = this.storageEl.querySelector(`[data-k="${to}"]`);
      if (!a || !b) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const x1 = ra.right - box.left - 6;
      const y1 = ra.top + ra.height / 2 - box.top;
      const toRow = to.startsWith('r:');
      const x2 = (toRow ? rb.left + 8 : rb.left + rb.width / 2) - box.left;
      const y2 = (toRow ? rb.top + rb.height / 2 : rb.top) - box.top;
      const path = document.createElementNS(ns, 'path');
      const dx = Math.max(40, Math.abs(x2 - x1) / 2);
      path.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${x2 - (toRow ? dx : 0)},${toRow ? y2 : y2 - 40} ${x2},${y2}`);
      path.setAttribute('class', 'arrow');
      path.setAttribute('marker-end', 'url(#fdbg-head)');
      svg.append(path);
    }
  }

  private renderNow(state: StorageModel, cur: TraceEvent | null): void {
    const c = this.cursor;
    const parts: El[] = [];
    if (c.op < 0) {
      parts.push(h('p', { class: 'now-t' }, 'Ready. The tables show the world after setup.'), h('p', { class: 'now-why' }, 'Step through the code to watch flecs move rows between tables. ← and → step too.'));
    } else if (!cur) {
      const op = this.s.done[c.op].op;
      parts.push(h('p', { class: 'now-t' }, 'About to run ', h('code', {}, op.code)));
    } else {
      const d = describe(cur, this.s, this.types(c.op));
      parts.push(h('p', { class: 'now-t' }, d.title, d.fn ? h('span', { class: 'ev-fn' }, d.fn) : null));
      if (d.why) parts.push(h('p', { class: 'now-why' }, d.why));
    }
    if (c.op >= 0 && c.ev >= this.events(c.op).length && this.events(c.op).length) {
      parts.length = 0;
      const op = this.s.done[c.op].op;
      parts.push(h('p', { class: 'now-t' }, 'Finished ', h('code', {}, op.code)), h('p', { class: 'now-why' }, summary(this.events(c.op))));
    }
    const locals = this.localsAt();
    if (locals) parts.push(locals);
    const queue = this.queueAt();
    if (queue) parts.push(queue);
    void state;
    this.nowEl.replaceChildren(...parts);
  }

  /** The iterator a system or observer callback was given, if we're inside one. */
  private localsAt(): El | null {
    const c = this.cursor;
    const evs = this.events(c.op);
    let loc: Extract<TraceEvent, { k: 'locals' }> | null = null;
    for (let i = Math.min(c.ev, evs.length) - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.k === 'systemEnd' || e.k === 'flushBegin') break;
      if (e.k === 'locals') {
        loc = e;
        break;
      }
    }
    if (!loc) return null;
    const types = this.types(c.op);
    const fields = loc.fields;
    return h(
      'div',
      { class: 'now-box' },
      h('div', { class: 'now-h' }, `Locals: ${loc.name}${loc.event ? ` (${loc.event})` : ''} · it.table = ${tableLabel(types(loc.table), loc.table)} · it.count = ${loc.entities.length}`),
      h(
        'table',
        { class: 'locals' },
        h('thead', {}, h('tr', {}, h('th', {}, 'i'), h('th', {}, 'it.entities[i]'), ...fields.map((f, k) => h('th', { title: f.self ? 'field on the entity' : 'shared: one value for every row (from elsewhere)' }, `field ${k}: ${f.id}${f.self ? '' : ' (shared)'}`)))),
        h(
          'tbody',
          {},
          ...loc.entities.map((e, i) =>
            h('tr', {}, h('td', {}, String(i)), h('td', { class: 'ent' }, this.s.name(e)), ...fields.map((f) => h('td', {}, f.values ? fmtValue(f.self ? f.values[i] : f.values[0]) : f.set ? '' : 'not set'))),
          ),
        ),
      ),
    );
  }

  /** The command queue: what's waiting, or what's being applied at a sync point. */
  private queueAt(): El | null {
    const c = this.cursor;
    const evs = this.events(c.op);
    const upto = Math.min(c.ev, evs.length);
    let flushAt = -1;
    for (let i = upto - 1; i >= 0; i--) {
      if (evs[i].k === 'flushEnd') break;
      if (evs[i].k === 'flushBegin') {
        flushAt = i;
        break;
      }
    }
    const n = (e: number) => this.s.name(e);
    if (flushAt >= 0) {
      const cmds = evs.filter((e, i): e is Extract<TraceEvent, { k: 'cmd' }> => e.k === 'cmd' && i > flushAt && i < flushAt + 1 + (evs[flushAt] as { count: number }).count + 1);
      let ran = -1;
      for (let i = flushAt; i < upto; i++) {
        const e = evs[i];
        if (e.k === 'cmdRun') ran = e.index;
      }
      return h(
        'div',
        { class: 'now-box' },
        h('div', { class: 'now-h' }, 'Command queue (being applied)'),
        h(
          'ol',
          { class: 'queue', start: '0' },
          ...cmds.map((q) => h('li', { class: q.index < ran ? 'done' : q.index === ran ? 'current' : '' }, `${q.kind} ${q.id} → ${n(q.entity)}`, q.first ? h('span', { class: 'batch' }, 'first for entity: applies the batch') : null)),
        ),
      );
    }
    const pending: string[] = [];
    for (let i = 0; i < upto; i++) {
      const e = evs[i];
      if (e.k === 'flushEnd') pending.length = 0;
      if (e.k === 'call' && e.deferred) pending.push(e.call);
    }
    if (!pending.length) return null;
    return h('div', { class: 'now-box' }, h('div', { class: 'now-h' }, `Command queue (${pending.length} waiting for the sync point)`), h('ol', { class: 'queue', start: '0' }, ...pending.map((p) => h('li', {}, p))));
  }
}

interface RefState {
  label: string;
  entity: number;
  comp: string;
  table: number;
  row: number;
  addr: number;
  valid: boolean;
  reason: string;
}

function stat(label: string, v: number | string): El {
  return h('span', { class: 'st' }, h('b', {}, String(v)), ` ${label}`);
}

function chipTitle(kind: string): string {
  switch (kind) {
    case 'tag':
      return 'Tag: no data, so no column';
    case 'sparse':
      return 'Sparse: in the type (it fragments), but stored outside the table';
    case 'pair':
      return 'Pair: a relationship with a target';
    default:
      return 'Component: one column in this table';
  }
}

/** One line about what an op did, for the "Finished" panel. */
function summary(evs: TraceEvent[]): string {
  const count = (k: TraceEvent['k']) => evs.filter((e) => e.k === k).length;
  const bits: string[] = [];
  const moves = count('moveBegin');
  const tables = count('tableNew');
  const iters = count('iter');
  const flush = count('flushBegin');
  const obs = evs.filter((e) => e.k === 'observer' && e.event !== 'OnTableCreate').length;
  if (moves) bits.push(`${moves} move${moves === 1 ? '' : 's'} between tables`);
  if (tables) bits.push(`${tables} new table${tables === 1 ? '' : 's'}`);
  if (iters) bits.push(`${iters} system callback${iters === 1 ? '' : 's'}`);
  if (flush) bits.push(`${flush} sync point${flush === 1 ? '' : 's'}`);
  if (obs) bits.push(`${obs} observer call${obs === 1 ? '' : 's'}`);
  return bits.length ? `${bits.join(', ')}.` : 'No storage changes.';
}
