import { FlecsWorld, type TableInfo, type TraceEvent } from '../runtime';
import { pack, unpack, stateInUrl, clearUrlState } from '../../lab/ui/share';

/**
 * flecs sandbox: a live world you change directly. Define components (with
 * storage traits), create entities, add/remove/set components, add observers
 * and systems, and watch the archetype tables, sparse storage and invoked
 * observers update as you go. Entity rows animate between tables (FLIP).
 */

type El = HTMLElement;
type Kind = 'tag' | 'value' | 'vec2' | 'rel';
type Trait = 'none' | 'Sparse' | 'DontFragment';

interface CompDef {
  name: string;
  kind: Kind;
  trait: Trait;
  exclusive?: boolean;
}
interface ObsDef {
  id: number;
  name: string;
  query: string;
  events: string[];
  calls: number;
}
interface SysDef {
  id: number;
  name: string;
  query: string;
  calls: number;
}
interface LogLine {
  text: string;
  cls: string;
}
interface LogEntry {
  code: string;
  lines: LogLine[];
}

/**
 * One thing the reader did, recorded so a world can be shared as a link: the starting preset
 * plus this list, replayed in order, rebuilds the same tables, rows, observer counts and all.
 */
type Op =
  | ['c', CompDef]
  | ['e', string]
  | ['a', string, string, string?]
  | ['s', string, string, unknown]
  | ['r', string, string]
  | ['d', string]
  | ['o', string, string, string[]]
  | ['y', string, string]
  | ['f'];
interface Shared {
  v: 1;
  preset: string;
  ops: Op[];
}

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

function hue(name: string): string {
  const base = name.replace(/^\(([^,]+),.*$/, '$1');
  let x = 0;
  for (const ch of base) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--c${(x % 8) + 1})`;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).map(fmt).join(', ');
  return String(v);
}

const START_COMPONENTS: CompDef[] = [
  { name: 'Position', kind: 'vec2', trait: 'none' },
  { name: 'Velocity', kind: 'vec2', trait: 'none' },
  { name: 'Health', kind: 'value', trait: 'none' },
  { name: 'Enemy', kind: 'tag', trait: 'none' },
  { name: 'Frozen', kind: 'tag', trait: 'none' },
  { name: 'Faction', kind: 'rel', trait: 'none', exclusive: true },
];

/** Starting worlds. Each is a list of components plus steps run silently. */
const PRESETS: Record<string, { label: string; components: CompDef[]; run: (s: Sandbox) => void }> = {
  basics: {
    label: 'Basics',
    components: START_COMPONENTS,
    run: (s) => {
      s.quiet(() => {
        for (const [n, x] of [['Ship', 1], ['Rock', 4], ['Tree', 7]] as const) {
          s.createEntity(n);
          s.setComp(n, 'Position', { x, y: 0 });
        }
        s.setComp('Ship', 'Velocity', { x: 1, y: 0 });
        s.addObserver('OnAddVelocity', 'Velocity', ['OnAdd']);
        s.addObserver('OnSetPosition', 'Position', ['OnSet']);
        s.addObserver('OnRemoveAny', 'Position', ['OnRemove']);
        s.addSystem('Move', 'Position, Velocity');
      });
    },
  },
  fragmentation: {
    label: 'Fragmentation',
    components: START_COMPONENTS,
    run: (s) => {
      s.quiet(() => {
        for (const f of ['Red', 'Blue', 'Green']) s.createEntity(f);
        const fs = ['Red', 'Red', 'Blue', 'Green', 'Blue', 'Green'];
        fs.forEach((f, i) => {
          s.createEntity(`Unit${i}`);
          s.setComp(`Unit${i}`, 'Position', { x: i, y: 0 });
          s.addComp(`Unit${i}`, 'Faction', f);
        });
        s.addSystem('Render', 'Position');
        s.addSystem('RedTeam', 'Position, (Faction, Red)');
      });
    },
  },
  traits: {
    label: 'Sparse & DontFragment',
    components: [
      { name: 'Position', kind: 'vec2', trait: 'none' },
      { name: 'Health', kind: 'value', trait: 'none' },
      { name: 'Shield', kind: 'value', trait: 'Sparse' },
      { name: 'Burning', kind: 'value', trait: 'DontFragment' },
      { name: 'Selected', kind: 'tag', trait: 'DontFragment' },
    ],
    run: (s) => {
      s.quiet(() => {
        for (const [n, x] of [['A', 1], ['B', 2], ['C', 3]] as const) {
          s.createEntity(n);
          s.setComp(n, 'Position', { x, y: 0 });
        }
        s.addObserver('OnAddBurning', 'Burning', ['OnAdd', 'OnRemove']);
        s.addSystem('Render', 'Position');
        s.addSystem('Burn', 'Burning');
      });
    },
  },
  empty: { label: 'Empty', components: START_COMPONENTS, run: () => {} },
};

export class Sandbox {
  private w!: FlecsWorld;
  private comps: CompDef[] = [];
  private entities: number[] = [];
  private observers: ObsDef[] = [];
  private systems: SysDef[] = [];
  /** Tables lesson entities have been in (kept on screen when empty). */
  private known = new Set<number>();
  private sparseIds = new Set<string>();
  private selected = '';
  private hideEmpty = false;
  private log: LogEntry[] = [];
  private flash = new Map<number, string>();
  private flashRows = new Map<number, string>();
  private silent = false;
  private counter = 1;
  /** What the reader has done since the preset loaded (see Op). */
  private history: Op[] = [];
  private presetId = 'basics';
  private shareNote!: El;
  private root: El;
  private presetSel!: HTMLSelectElement;
  private els!: Record<'comps' | 'ents' | 'insp' | 'obs' | 'sys' | 'tables' | 'sparse' | 'stats' | 'log', El>;

  constructor(host: El) {
    this.root = h('div', { class: 'sbx' }, h('p', { class: 'sbx-muted' }, 'Starting flecs…'));
    host.replaceChildren(this.root);
  }

  async init(): Promise<void> {
    try {
      this.w = await FlecsWorld.create();
    } catch (e) {
      this.root.replaceChildren(h('p', { class: 'sbx-err' }, `Couldn't start flecs: ${(e as Error).message}`));
      return;
    }
    this.build();
    // Lessons link here with ?preset=<id> to start from a matching world.
    let start = 'basics';
    try {
      const q = new URLSearchParams(window.location.search).get('preset');
      if (q && q in PRESETS) start = q;
    } catch {
      /* no URL (preview) */
    }
    this.presetSel.value = start;
    // A shared link (#s=...) carries a preset and everything done after it.
    const packed = stateInUrl();
    const shared = packed ? await unpack<Shared>(packed) : null;
    if (shared && shared.v === 1 && shared.preset in PRESETS && Array.isArray(shared.ops)) {
      this.presetSel.value = shared.preset;
      this.loadPreset(shared.preset, shared.ops);
      clearUrlState();
      this.addLog('// opened a shared world', [{ text: `Rebuilt from the ${PRESETS[shared.preset].label} preset plus ${shared.ops.length} step${shared.ops.length === 1 ? '' : 's'}.`, cls: 'muted' }]);
      return;
    }
    this.loadPreset(start);
  }

  /** Remember a reader action for share links. Consecutive edits of one value collapse into one. */
  private record(op: Op): void {
    if (this.silent) return;
    const last = this.history.at(-1);
    if (op[0] === 's' && last?.[0] === 's' && last[1] === op[1] && last[2] === op[2]) this.history[this.history.length - 1] = op;
    else this.history.push(op);
  }

  private replay(ops: Op[]): void {
    this.quiet(() => {
      for (const op of ops) {
        switch (op[0]) {
          case 'c':
            this.defineComp(op[1], true);
            break;
          case 'e':
            this.createEntity(op[1]);
            break;
          case 'a':
            this.addComp(op[1], op[2], op[3] ?? undefined);
            break;
          case 's':
            this.setComp(op[1], op[2], op[3]);
            break;
          case 'r':
            this.removeComp(op[1], op[2]);
            break;
          case 'd':
            this.deleteEntity(op[1]);
            break;
          case 'o':
            this.addObserver(op[1], op[2], op[3]);
            break;
          case 'y':
            this.addSystem(op[1], op[2]);
            break;
          case 'f':
            this.runFrame();
            break;
        }
      }
    });
    this.history = ops.slice();
    // New entities carry on from the highest E<n> the shared world used.
    for (const op of ops) {
      const m = op[0] === 'e' ? /^E(\d+)$/.exec(op[1]) : null;
      if (m) this.counter = Math.max(this.counter, Number(m[1]) + 1);
    }
  }

  private async share(): Promise<void> {
    const state: Shared = { v: 1, preset: this.presetId, ops: this.history };
    const url = `${location.origin}${location.pathname}#s=${await pack(state)}`;
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      /* clipboard blocked: put it in the address bar instead */
    }
    if (!copied) history.replaceState(null, '', url);
    this.shareNote.textContent = copied ? 'Link copied' : 'Link is in the address bar';
    window.clearTimeout(Number(this.shareNote.dataset.t));
    this.shareNote.dataset.t = String(window.setTimeout(() => (this.shareNote.textContent = ''), 2500));
  }

  // ---------------- World operations (all logged unless quiet) ----------------

  /** Run without logging (presets). */
  quiet(fn: () => void): void {
    this.silent = true;
    try {
      fn();
    } finally {
      this.silent = false;
    }
  }

  private loadPreset(id: string, ops: Op[] = []): void {
    const p = PRESETS[id];
    this.presetId = id;
    this.history = [];
    this.counter = 1;
    this.w.reset();
    this.comps = [];
    this.entities = [];
    this.observers = [];
    this.systems = [];
    this.known = new Set();
    this.sparseIds = new Set();
    this.log = [];
    this.selected = '';
    for (const c of p.components) this.defineComp(c, true);
    p.run(this);
    if (ops.length) this.replay(ops);
    this.selected = this.entities.length ? this.w.name(this.entities[0]) : '';
    this.render(true);
  }

  defineComp(c: CompDef, quiet = false): boolean {
    const why = !/^[A-Za-z_]\w*$/.test(c.name)
      ? 'Names must start with a letter or _ and contain only letters, digits and _.'
      : this.comps.some((x) => x.name === c.name)
        ? `${c.name} is already defined.`
        : this.w.lookup(c.name)
          ? `There's already an entity called ${c.name} (an entity of yours, or one of flecs' own), so it can't be redefined as a ${c.kind === 'tag' ? 'tag' : c.kind === 'rel' ? 'relationship' : 'component'}.`
          : '';
    if (why) {
      if (!quiet) {
        this.addLog(`component ${c.name || '(no name)'}`, [{ text: why, cls: 'err' }]);
        this.render();
      }
      return false;
    }
    const decl = c.kind === 'vec2' ? `struct ${c.name}(x: f32, y: f32)` : c.kind === 'value' ? `struct ${c.name}(value: f32)` : `${c.name} {}`;
    const traits = [c.trait !== 'none' ? c.trait : '', c.exclusive ? 'Exclusive' : '', c.kind === 'rel' ? 'Relationship' : ''].filter(Boolean);
    const code = `${decl}\n${traits.length ? `${c.name} {\n${traits.map((t) => `  ${t}`).join('\n')}\n}` : ''}`;
    const r = this.w.script(code, `def_${c.name}`);
    if (!r.ok) {
      this.addLog(`component ${c.name}`, [{ text: r.error ?? 'failed', cls: 'err' }]);
      return false;
    }
    this.comps.push(c);
    if (c.trait !== 'none') this.sparseIds.add(c.name);
    if (!quiet) this.record(['c', c]);
    if (!quiet) {
      const cpp = `world.component<${c.name}>()${c.trait !== 'none' ? `.add(flecs::${c.trait})` : ''}${c.exclusive ? '.add(flecs::Exclusive)' : ''};`;
      this.addLog(cpp, [{ text: `Defined ${c.kind === 'tag' ? 'tag' : c.kind === 'rel' ? 'relationship' : 'component'} ${c.name}${c.trait !== 'none' ? ` (${c.trait})` : ''}`, cls: 'muted' }]);
    }
    return true;
  }

  createEntity(name?: string): string {
    const n = name ?? `E${this.counter++}`;
    this.record(['e', n]);
    this.op(`world.entity("${n}");`, () => {
      const r = this.w.rest('PUT', `/entity/${n}`);
      if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    });
    const e = this.w.lookup(n);
    if (e && !this.entities.includes(e)) this.entities.push(e);
    return n;
  }

  private idOf(comp: string, target?: string): string {
    return target ? `(${comp}, ${target})` : comp;
  }

  addComp(e: string, comp: string, target?: string): void {
    const id = this.idOf(comp, target);
    this.record(target ? ['a', e, comp, target] : ['a', e, comp]);
    this.op(target ? `${lc(e)}.add<${comp}>(${lc(target)});` : `${lc(e)}.add<${comp}>();`, () => this.restOk('PUT', `/component/${path(e)}`, { component: id }));
  }

  setComp(e: string, comp: string, value: unknown): void {
    this.record(['s', e, comp, value]);
    this.op(`${lc(e)}.set<${comp}>({${fmt(value)}});`, () => this.restOk('PUT', `/component/${path(e)}`, { component: comp, value: JSON.stringify(value) }));
  }

  removeComp(e: string, id: string): void {
    this.record(['r', e, id]);
    const m = /^\((\w+),\s*(.+)\)$/.exec(id);
    this.op(m ? `${lc(e)}.remove<${m[1]}>(${lc(m[2])});` : `${lc(e)}.remove<${id}>();`, () => this.restOk('DELETE', `/component/${path(e)}`, { component: id }));
  }

  deleteEntity(e: string): void {
    const id = this.w.lookup(e);
    this.record(['d', e]);
    this.op(`${lc(e)}.destruct();`, () => this.restOk('DELETE', `/entity/${path(e)}`));
    this.entities = this.entities.filter((x) => x !== id);
    if (this.selected === e) this.selected = '';
  }

  addObserver(name: string, query: string, events: string[]): boolean {
    let def: ObsDef | null = null;
    const id = this.w.observer(name, query, events, () => {
      if (def) def.calls++;
    });
    if (!id) {
      this.addLog(`observer ${name}`, [{ text: this.w.log.at(-1)?.text ?? 'bad query', cls: 'err' }]);
      return false;
    }
    def = { id, name, query, events, calls: 0 };
    this.observers.push(def);
    this.record(['o', name, query, events]);
    if (!this.silent) this.addLog(`world.observer("${name}").with("${query}").event(${events.join(', ')})`, [{ text: `Observer ${name} listening`, cls: 'muted' }]);
    return true;
  }

  addSystem(name: string, query: string): boolean {
    let def: SysDef | null = null;
    const id = this.w.system(name, query, (it) => {
      if (def) def.calls++;
      void it;
    });
    if (!id) {
      this.addLog(`system ${name}`, [{ text: this.w.log.at(-1)?.text ?? 'bad query', cls: 'err' }]);
      return false;
    }
    def = { id, name, query, calls: 0 };
    this.systems.push(def);
    this.record(['y', name, query]);
    if (!this.silent) this.addLog(`world.system("${name}").with("${query}")`, [{ text: `System ${name} added (runs on "Run a frame")`, cls: 'muted' }]);
    return true;
  }

  runFrame(): void {
    this.record(['f']);
    for (const s of this.systems) s.calls = 0;
    this.op('world.progress();', () => this.w.progress());
  }

  private restOk(method: 'PUT' | 'DELETE', url: string, params: Record<string, string> = {}): void {
    const r = this.w.rest(method, url, params);
    if (r.status !== 200) {
      const b = r.body as { error?: string } | null;
      throw new Error(b?.error ?? `HTTP ${r.status}`);
    }
  }

  /** Run an operation with the trace on, then log what flecs did and redraw. */
  private op(code: string, fn: () => void): void {
    let error = '';
    const events = this.w.trace(() => {
      try {
        fn();
      } catch (e) {
        error = (e as Error).message;
      }
    });
    for (const ev of events) {
      if (ev.k === 'append' && this.entities.includes(ev.entity)) this.known.add(ev.table);
      if (ev.k === 'sparseAdd') this.sparseIds.add(ev.id);
    }
    if (this.silent) {
      // Presets: just remember the tables.
      for (const ev of events) if (ev.k === 'append') this.known.add(ev.table);
      return;
    }
    const lines = this.describe(events);
    if (error) lines.unshift({ text: `flecs refused: ${error}`, cls: 'err' });
    if (!lines.length) lines.push({ text: 'No storage change.', cls: 'muted' });
    this.addLog(code, lines);
    this.render();
  }

  private addLog(code: string, lines: LogLine[]): void {
    this.log.unshift({ code, lines });
    if (this.log.length > 40) this.log.pop();
    if (this.els) this.renderLog();
  }

  /** The trace as a short, ordered story; also sets which tables/rows flash. */
  private describe(events: TraceEvent[]): LogLine[] {
    this.flash = new Map();
    this.flashRows = new Map();
    const lines: LogLine[] = [];
    const n = (e: number) => this.w.name(e);
    const t = (id: number) => `[${(this.w.tableType(id) ?? []).filter((s) => s !== '(Identifier,Name)').join(', ') || 'empty type'}]`;
    const mine = (e: number) => this.entities.includes(e);
    const userObs = new Map(this.observers.map((o) => [o.id, o]));
    const userSys = new Map(this.systems.map((s) => [s.id, s]));
    for (const ev of events) {
      switch (ev.k) {
        case 'tableNew':
          if (!(this.known.has(ev.table) || events.some((x) => x.k === 'append' && x.table === ev.table && mine(x.entity)))) break;
          lines.push({ text: `New table ${t(ev.table)}`, cls: 'new' });
          this.flash.set(ev.table, 'new');
          break;
        case 'moveBegin':
          if (!mine(ev.entity)) break;
          lines.push({ text: `${n(ev.entity)} moves ${t(ev.from)} → ${t(ev.to)}`, cls: 'move' });
          this.flash.set(ev.to, this.flash.get(ev.to) ?? 'target');
          this.flashRows.set(ev.entity, 'moved');
          break;
        case 'append':
          if (!mine(ev.entity)) break;
          if (!events.some((x) => x.k === 'moveBegin' && x.entity === ev.entity)) {
            lines.push({ text: `${n(ev.entity)} appended to ${t(ev.table)} at row ${ev.row}`, cls: 'move' });
            this.flashRows.set(ev.entity, 'moved');
          }
          break;
        case 'delete':
          if (!mine(ev.entity)) break;
          if (ev.moved && mine(ev.moved)) {
            lines.push({ text: `  ${n(ev.moved)} swapped from row ${ev.last} into row ${ev.row} of ${t(ev.table)}`, cls: 'swap' });
            this.flashRows.set(ev.moved, 'swapped');
          }
          break;
        case 'sparseAdd':
          if (!mine(ev.entity)) break;
          lines.push({ text: `${n(ev.entity)} added to sparse storage of ${ev.id}${this.isDontFragment(ev.id) ? ' (no table change)' : ''}`, cls: 'sparse' });
          this.flashRows.set(ev.entity, 'moved');
          break;
        case 'sparseRemove':
          if (!mine(ev.entity)) break;
          lines.push({ text: `${n(ev.entity)} removed from sparse storage of ${ev.id}`, cls: 'sparse' });
          break;
        case 'locals': {
          const o = userObs.get(ev.callback);
          if (o) {
            lines.push({ text: `Observer ${o.name}: ${ev.event} on ${ev.entities.map(n).join(', ')}`, cls: 'obs' });
            this.flashObs.add(o.id);
          }
          break;
        }
        case 'iter': {
          const s = userSys.get(ev.system);
          if (s) {
            const typ = this.w.tableType(ev.table) ?? [];
            const perEntity = !ev.table || !typ.filter((x) => x !== '(Identifier,Name)').length;
            lines.push({ text: perEntity ? `${s.name} callback: ${n(ev.entity)} (per entity: DontFragment isn't in any table)` : `${s.name} callback: ${t(ev.table)} × ${ev.count}`, cls: 'sys' });
            this.flash.set(ev.table, 'iter');
          }
          break;
        }
        case 'flushBegin':
          if (ev.count) lines.push({ text: `Sync point: ${ev.count} queued command${ev.count === 1 ? '' : 's'}`, cls: 'muted' });
          break;
      }
    }
    return lines;
  }

  private flashObs = new Set<number>();

  private isDontFragment(id: string): boolean {
    const base = id.replace(/^\(([^,]+),.*$/, '$1');
    return this.comps.some((c) => c.name === base && c.trait === 'DontFragment');
  }

  // ---------------- Layout ----------------

  private build(): void {
    const el = (cls: string) => h('div', { class: cls });
    this.els = {
      comps: el('sbx-list'),
      ents: el('sbx-list'),
      insp: el('sbx-insp'),
      obs: el('sbx-list'),
      sys: el('sbx-list'),
      tables: el('sbx-tables'),
      sparse: el('sbx-sparse'),
      stats: el('sbx-stats'),
      log: el('sbx-log'),
    };
    const presetSel = h(
      'select',
      {
        'aria-label': 'Start from',
        onchange: (e: Event) => {
          const id = (e.target as HTMLSelectElement).value;
          this.loadPreset(id);
          try {
            const url = new URL(window.location.href);
            url.searchParams.set('preset', id);
            window.history.replaceState(null, '', url);
          } catch {
            /* ignore */
          }
        },
      },
      ...Object.entries(PRESETS).map(([id, p]) => h('option', { value: id }, p.label)),
    );
    this.presetSel = presetSel;
    const hideEmpty = h('input', {
      type: 'checkbox',
      onchange: (e: Event) => {
        this.hideEmpty = (e.target as HTMLInputElement).checked;
        this.render();
      },
    });
    this.root.replaceChildren(
      h(
        'div',
        { class: 'sbx-bar' },
        h('label', { class: 'sbx-field' }, 'Start from ', presetSel),
        h('button', { type: 'button', class: 'sbx-btn', onclick: () => this.loadPreset(presetSel.value) }, 'Reset'),
        h('button', { type: 'button', class: 'sbx-btn primary', onclick: () => this.runFrame() }, 'Run a frame'),
        h('label', { class: 'sbx-chk' }, hideEmpty, 'Hide empty tables'),
        h('button', { type: 'button', class: 'sbx-btn', title: 'Copy a link that rebuilds this exact world', onclick: () => void this.share() }, 'Share'),
        (this.shareNote = h('span', { class: 'sbx-muted sbx-note', role: 'status', 'aria-live': 'polite' })),
        this.els.stats,
      ),
      h(
        'div',
        { class: 'sbx-main' },
        h(
          'div',
          { class: 'sbx-side' },
          section('Entities', this.els.ents),
          section('Selected entity', this.els.insp),
          section('Components', this.els.comps, this.compForm()),
          section('Observers', this.els.obs, this.obsForm()),
          section('Systems', this.els.sys, this.sysForm()),
        ),
        h('div', { class: 'sbx-center' }, h('div', { class: 'sbx-h' }, 'Archetypes (tables)'), this.els.tables, this.els.sparse),
        h('div', { class: 'sbx-right' }, h('div', { class: 'sbx-h' }, 'What flecs did'), this.els.log),
      ),
    );
  }

  private compForm(): El {
    const name = h('input', { type: 'text', placeholder: 'Name', 'aria-label': 'Component name', class: 'sbx-in', size: 8 });
    const kind = h('select', { 'aria-label': 'Kind' }, h('option', { value: 'vec2' }, 'x, y'), h('option', { value: 'value' }, 'value'), h('option', { value: 'tag' }, 'tag'), h('option', { value: 'rel' }, 'relationship'));
    const trait = h('select', { 'aria-label': 'Storage' }, h('option', { value: 'none' }, 'table column'), h('option', { value: 'Sparse' }, 'Sparse'), h('option', { value: 'DontFragment' }, 'DontFragment'));
    return h(
      'form',
      {
        class: 'sbx-form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (this.defineComp({ name: name.value.trim(), kind: kind.value as Kind, trait: trait.value as Trait, exclusive: kind.value === 'rel' })) {
            name.value = '';
            this.render();
          }
        },
      },
      name,
      kind,
      trait,
      h('button', { type: 'submit', class: 'sbx-btn' }, 'Add'),
    );
  }

  private obsForm(): El {
    const name = h('input', { type: 'text', placeholder: 'Name', 'aria-label': 'Observer name', class: 'sbx-in', size: 8 });
    const query = h('input', { type: 'text', placeholder: 'Query, e.g. Position', 'aria-label': 'Observer query', class: 'sbx-in mono' });
    const evs = ['OnAdd', 'OnSet', 'OnRemove'].map((ev) => {
      const c = h('input', { type: 'checkbox', value: ev });
      c.checked = ev === 'OnAdd';
      return h('label', { class: 'sbx-chk' }, c, ev);
    });
    return h(
      'form',
      {
        class: 'sbx-form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const events = evs.map((l) => l.querySelector('input')!).filter((c) => c.checked).map((c) => c.value);
          if (!query.value.trim() || !events.length) return;
          if (this.addObserver(name.value.trim() || `Observer${this.observers.length + 1}`, query.value.trim(), events)) {
            name.value = '';
            query.value = '';
            this.render();
          }
        },
      },
      name,
      query,
      ...evs,
      h('button', { type: 'submit', class: 'sbx-btn' }, 'Add'),
    );
  }

  private sysForm(): El {
    const name = h('input', { type: 'text', placeholder: 'Name', 'aria-label': 'System name', class: 'sbx-in', size: 8 });
    const query = h('input', { type: 'text', placeholder: 'Query, e.g. Position, Velocity', 'aria-label': 'System query', class: 'sbx-in mono' });
    return h(
      'form',
      {
        class: 'sbx-form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (!query.value.trim()) return;
          if (this.addSystem(name.value.trim() || `System${this.systems.length + 1}`, query.value.trim())) {
            name.value = '';
            query.value = '';
            this.render();
          }
        },
      },
      name,
      query,
      h('button', { type: 'submit', class: 'sbx-btn' }, 'Add'),
    );
  }

  // ---------------- Rendering ----------------

  private snapshot(): { tables: TableInfo[]; sparse: Map<string, { entities: number[]; values: unknown[]; dontFragment: boolean }> } {
    const tables = this.w.tables(512).filter((t) => {
      if (t.entities.some((e) => this.entities.includes(e))) {
        this.known.add(t.id);
        return true;
      }
      return this.known.has(t.id);
    });
    const sparse = new Map<string, { entities: number[]; values: unknown[]; dontFragment: boolean }>();
    for (const id of this.sparseIds) {
      const s = this.w.sparse(id);
      if (s?.sparse) sparse.set(id, { entities: s.entities, values: s.values ?? [], dontFragment: s.dontFragment });
    }
    return { tables, sparse };
  }

  private render(instant = false): void {
    // FLIP: remember where each entity row was.
    const before = new Map<string, DOMRect>();
    if (!instant) this.els.tables.querySelectorAll<El>('[data-e]').forEach((r) => before.set(r.dataset.e!, r.getBoundingClientRect()));
    const snap = this.snapshot();
    this.renderTables(snap);
    this.renderSparse(snap.sparse);
    this.renderEntities(snap);
    this.renderComps();
    this.renderObservers();
    this.renderSystems();
    this.renderLog();
    const tableCount = snap.tables.filter((t) => t.entities.some((e) => this.entities.includes(e))).length;
    const ents = this.entities.length;
    this.els.stats.replaceChildren(
      stat(tableCount, 'tables in use'),
      stat(ents, 'entities'),
      stat(tableCount ? (ents / tableCount).toFixed(1) : '0', 'per table'),
      stat(snap.tables.length - tableCount, 'empty'),
    );
    if (instant) return;
    this.els.tables.querySelectorAll<El>('[data-e]').forEach((r) => {
      const prev = before.get(r.dataset.e!);
      if (!prev) {
        r.classList.add('enter');
        return;
      }
      const now = r.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      r.style.transform = `translate(${dx}px, ${dy}px)`;
      r.style.transition = 'none';
      requestAnimationFrame(() => {
        r.style.transition = 'transform 0.45s cubic-bezier(0.2, 0.8, 0.2, 1)';
        r.style.transform = '';
      });
    });
  }

  private renderTables(snap: ReturnType<Sandbox['snapshot']>): void {
    const cards = snap.tables
      .filter((t) => !this.hideEmpty || t.entities.some((e) => this.entities.includes(e)))
      .map((t) => {
        const rows = t.entities.filter((e) => this.entities.includes(e));
        const type = t.type.filter((c) => c.str !== '(Identifier,Name)');
        const cols = type.filter((c) => c.column >= 0);
        const rowIndex = (e: number) => t.entities.indexOf(e);
        return h(
          'div',
          { class: `sbx-table ${this.flash.get(t.id) ?? ''} ${rows.length ? '' : 'is-empty'}` },
          h(
            'div',
            { class: 'st-h' },
            h('span', { class: 'st-id' }, `#${t.id}`),
            h(
              'span',
              { class: 'st-type' },
              ...(type.length
                ? type.map((c) =>
                    h(
                      'span',
                      { class: `chip ${c.column >= 0 ? '' : c.sparse ? 'k-sparse' : 'k-tag'}`, style: `--chip:${hue(c.str)}`, title: c.column >= 0 ? 'Column in this table' : c.sparse ? 'Sparse: in the type, stored outside the table' : 'Tag or pair: in the type, no column' },
                      c.str,
                    ),
                  )
                : [h('span', { class: 'chip k-root', title: t.type.length ? 'Only a name: (Identifier, Name)' : 'The root table: entities with no components' }, t.type.length ? 'name only' : 'no components')]),
            ),
            h('span', { class: 'st-n' }, `${rows.length}`),
          ),
          rows.length
            ? h(
                'table',
                {},
                h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'entity'), ...cols.map((c) => h('th', { style: `color:${hue(c.str)}` }, c.str)))),
                h(
                  'tbody',
                  {},
                  ...rows.map((e) => {
                    const name = this.w.name(e);
                    const r = rowIndex(e);
                    return h(
                      'tr',
                      {
                        'data-e': String(e),
                        class: `${this.flashRows.get(e) ?? ''} ${name === this.selected ? 'sel' : ''}`,
                        onclick: () => {
                          this.selected = name;
                          this.render(true);
                        },
                      },
                      h('td', { class: 'rn' }, String(r)),
                      h('td', { class: 'ent' }, name),
                      ...cols.map((c) => h('td', {}, fmt(c.values?.[r]))),
                    );
                  }),
                ),
              )
            : h('p', { class: 'st-empty' }, 'empty (kept: flecs reuses it)'),
        );
      });
    this.els.tables.replaceChildren(...(cards.length ? cards : [h('p', { class: 'sbx-muted' }, 'Create an entity to see its table.')]));
  }

  private renderSparse(sparse: Map<string, { entities: number[]; values: unknown[]; dontFragment: boolean }>): void {
    const sets = [...sparse.entries()];
    if (!sets.length) {
      this.els.sparse.replaceChildren();
      return;
    }
    this.els.sparse.replaceChildren(
      h('div', { class: 'sbx-h' }, 'Sparse storage (outside the tables)'),
      h(
        'div',
        { class: 'sbx-sets' },
        ...sets.map(([id, s]) =>
          h(
            'div',
            { class: 'sbx-set' },
            h('div', { class: 'st-h' }, h('span', { class: 'chip k-sparse', style: `--chip:${hue(id)}` }, id), h('span', { class: 'sbx-muted' }, s.dontFragment ? 'DontFragment: not in the type' : 'Sparse: in the type')),
            s.entities.filter((e) => this.entities.includes(e)).length
              ? h('table', {}, h('tbody', {}, ...s.entities.map((e, i) => (this.entities.includes(e) ? h('tr', {}, h('td', { class: 'ent' }, this.w.name(e)), h('td', {}, fmt(s.values[i]))) : null))))
              : h('p', { class: 'st-empty' }, 'empty'),
          ),
        ),
      ),
    );
  }

  /** Components an entity has: its table type plus DontFragment components (not in the type). */
  private componentsOf(name: string, snap: ReturnType<Sandbox['snapshot']>): Array<{ id: string; value: unknown; where: string }> {
    const e = this.w.lookup(name);
    const out: Array<{ id: string; value: unknown; where: string }> = [];
    const t = snap.tables.find((x) => x.entities.includes(e));
    if (t) {
      const r = t.entities.indexOf(e);
      for (const c of t.type) {
        if (c.str === '(Identifier,Name)') continue;
        let value: unknown = c.values?.[r];
        let where = c.column >= 0 ? 'column' : c.sparse ? 'sparse' : 'type only';
        if (c.sparse) {
          const s = snap.sparse.get(c.str);
          const i = s?.entities.indexOf(e) ?? -1;
          if (s && i >= 0) value = s.values[i];
          where = 'sparse';
        }
        out.push({ id: c.str, value, where });
      }
    }
    for (const [id, s] of snap.sparse) {
      if (!s.dontFragment) continue;
      const i = s.entities.indexOf(e);
      if (i >= 0) out.push({ id, value: s.values[i], where: 'DontFragment' });
    }
    return out;
  }

  private renderEntities(snap: ReturnType<Sandbox['snapshot']>): void {
    const names = this.entities.map((e) => this.w.name(e));
    this.els.ents.replaceChildren(
      h(
        'div',
        { class: 'sbx-chips' },
        ...names.map((n) =>
          h(
            'button',
            {
              type: 'button',
              class: `sbx-ent ${n === this.selected ? 'on' : ''}`,
              onclick: () => {
                this.selected = n;
                this.render(true);
              },
            },
            n,
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'sbx-btn',
            onclick: () => {
              this.selected = this.createEntity();
              this.render();
            },
          },
          '+ New entity',
        ),
      ),
    );
    // Inspector
    const sel = this.selected;
    if (!sel || !this.w.lookup(sel)) {
      this.els.insp.replaceChildren(h('p', { class: 'sbx-muted' }, 'Select an entity (or a row in a table).'));
      return;
    }
    const comps = this.componentsOf(sel, snap);
    const rows = comps.map((c) => {
      const def = this.comps.find((d) => d.name === c.id.replace(/^\(([^,]+),.*$/, '$1'));
      const editor = def && (def.kind === 'vec2' || def.kind === 'value') ? this.valueEditor(sel, def, c.value) : h('span', { class: 'sbx-muted' }, def?.kind === 'rel' ? 'pair' : 'tag');
      return h(
        'div',
        { class: 'sbx-crow' },
        h('span', { class: 'chip', style: `--chip:${hue(c.id)}` }, c.id),
        editor,
        h('span', { class: 'sbx-where' }, c.where),
        h('button', { type: 'button', class: 'sbx-x', title: `Remove ${c.id}`, 'aria-label': `Remove ${c.id}`, onclick: () => this.removeComp(sel, c.id) }, '×'),
      );
    });
    const compSel = h('select', { 'aria-label': 'Component to add' }, ...this.comps.map((c) => h('option', { value: c.name }, c.name)));
    const targetSel = h('select', { 'aria-label': 'Relationship target' }, ...this.entities.map((e) => this.w.name(e)).filter((n) => n !== sel).map((n) => h('option', { value: n }, n)));
    const syncTarget = () => {
      targetSel.hidden = this.comps.find((c) => c.name === compSel.value)?.kind !== 'rel';
    };
    compSel.addEventListener('change', syncTarget);
    syncTarget();
    this.els.insp.replaceChildren(
      h('div', { class: 'sbx-insp-h' }, h('b', {}, sel), h('button', { type: 'button', class: 'sbx-btn danger', onclick: () => this.deleteEntity(sel) }, 'Delete')),
      ...(rows.length ? rows : [h('p', { class: 'sbx-muted' }, 'No components.')]),
      h(
        'form',
        {
          class: 'sbx-form',
          onsubmit: (e: Event) => {
            e.preventDefault();
            const def = this.comps.find((c) => c.name === compSel.value);
            if (!def) return;
            if (def.kind === 'rel') {
              if (targetSel.value) this.addComp(sel, def.name, targetSel.value);
            } else if (def.kind === 'tag') this.addComp(sel, def.name);
            else this.setComp(sel, def.name, def.kind === 'vec2' ? { x: 0, y: 0 } : { value: 0 });
          },
        },
        compSel,
        targetSel,
        h('button', { type: 'submit', class: 'sbx-btn' }, 'Add'),
      ),
    );
  }

  private valueEditor(entity: string, def: CompDef, value: unknown): El {
    const v = (value ?? {}) as Record<string, number>;
    const fields = def.kind === 'vec2' ? ['x', 'y'] : ['value'];
    const inputs = fields.map((f) => h('input', { type: 'number', step: 'any', value: String(v[f] ?? 0), 'aria-label': `${def.name}.${f}`, class: 'sbx-num' }));
    const commit = () => {
      const nv: Record<string, number> = {};
      fields.forEach((f, i) => (nv[f] = Number(inputs[i].value) || 0));
      this.setComp(entity, def.name, nv);
    };
    inputs.forEach((i) => i.addEventListener('change', commit));
    return h('span', { class: 'sbx-vals' }, ...inputs);
  }

  private renderComps(): void {
    this.els.comps.replaceChildren(
      h(
        'div',
        { class: 'sbx-chips' },
        ...this.comps.map((c) =>
          h(
            'span',
            { class: `chip ${c.trait !== 'none' ? 'k-sparse' : c.kind === 'tag' || c.kind === 'rel' ? 'k-tag' : ''}`, style: `--chip:${hue(c.name)}`, title: `${c.kind}${c.trait !== 'none' ? `, ${c.trait}` : ''}${c.exclusive ? ', Exclusive' : ''}` },
            c.name,
            c.trait !== 'none' ? h('small', {}, ` ${c.trait === 'DontFragment' ? 'DF' : 'S'}`) : null,
          ),
        ),
      ),
    );
  }

  private renderObservers(): void {
    const fired = this.flashObs;
    this.flashObs = new Set();
    this.els.obs.replaceChildren(
      ...(this.observers.length
        ? this.observers.map((o) =>
            h(
              'div',
              { class: `sbx-item ${fired.has(o.id) ? 'fired' : ''}` },
              h('b', {}, o.name),
              h('code', {}, o.query),
              h('span', { class: 'sbx-muted' }, o.events.join(' ')),
              h('span', { class: 'sbx-count', title: 'Times called' }, String(o.calls)),
            ),
          )
        : [h('p', { class: 'sbx-muted' }, 'None yet.')]),
    );
  }

  private renderSystems(): void {
    this.els.sys.replaceChildren(
      ...(this.systems.length
        ? this.systems.map((s) => h('div', { class: 'sbx-item' }, h('b', {}, s.name), h('code', {}, s.query), h('span', { class: 'sbx-count', title: 'Callbacks last frame (one per table)' }, String(s.calls))))
        : [h('p', { class: 'sbx-muted' }, 'None yet.')]),
    );
  }

  private renderLog(): void {
    this.els.log.replaceChildren(
      ...(this.log.length
        ? this.log.map((entry, i) => h('div', { class: `sbx-entry ${i === 0 ? 'latest' : ''}` }, h('code', {}, entry.code), ...entry.lines.map((l) => h('div', { class: `ll ${l.cls}` }, l.text))))
        : [h('p', { class: 'sbx-muted' }, 'Change something: add a component to an entity, create one, run a frame…')]),
    );
  }
}

function section(title: string, ...kids: El[]): El {
  return h('section', { class: 'sbx-sec' }, h('div', { class: 'sbx-h' }, title), ...kids);
}

function stat(v: number | string, label: string): El {
  return h('span', {}, h('b', {}, String(v)), ` ${label}`);
}

function lc(name: string): string {
  const s = name.split('.').pop() ?? name;
  return s[0].toLowerCase() + s.slice(1);
}

function path(name: string): string {
  return name.replace(/\./g, '/');
}
