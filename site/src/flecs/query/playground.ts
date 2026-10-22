import { FlecsWorld } from '../runtime';

/**
 * Query playground: a small fixed world, a query box, and what the query
 * returns: results with their fields (and where each field came from), the
 * tables it matched, and flecs' query plan.
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

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).map(fmt).join(', ');
  return String(v);
}

export const QUERY_WORLD = `struct Position(x: f32, y: f32)
struct Velocity(x: f32, y: f32)
struct Health(value: f32)
struct Time(seconds: f32)
Enemy {}
Player {}
Leader {}
Faction { Exclusive }
Red {}
Blue {}
Game { Time: {seconds: 12} }
PartyA {
  Position: {x: 10, y: 0}
  Leader
}
PartyB { Position: {x: 20, y: 0} }
PartyA {
  Aldric {
    Position: {x: 1, y: 0}
    Velocity: {x: 1, y: 0}
    Health: {value: 100}
    Player
    (Faction, Blue)
  }
  Brynn {
    Position: {x: 2, y: 0}
    Health: {value: 80}
    Player
    (Faction, Blue)
  }
}
PartyB {
  Goblin1 {
    Position: {x: 3, y: 0}
    Velocity: {x: 0, y: 1}
    Enemy
    (Faction, Red)
  }
  Goblin2 {
    Position: {x: 4, y: 0}
    Enemy
    (Faction, Red)
  }
}`;

const WORLD_NAMES = ['Game', 'PartyA', 'PartyB', 'PartyA.Aldric', 'PartyA.Brynn', 'PartyB.Goblin1', 'PartyB.Goblin2'];

export interface Preset {
  expr: string;
  note: string;
}

export const PRESETS: Preset[] = [
  { expr: 'Position, Velocity', note: 'And: every term must match. Matches whole tables that have both.' },
  { expr: 'Position, !Enemy', note: 'Not: excludes tables with Enemy. Still a whole-table test.' },
  { expr: 'Position, ?Velocity', note: 'Optional: Velocity is returned when present (is_set tells you), and doesn\'t filter anything.' },
  { expr: 'Position, Enemy || Player', note: 'Or: either id matches. The field tells you which one it was.' },
  { expr: '(Faction, *)', note: 'Wildcard pair: any Faction target. One result per matching pair.' },
  { expr: 'Position, (Faction, $f)', note: 'Variable: like a wildcard, but the target is captured in $f so other terms can use it.' },
  { expr: 'Position, Position(up ChildOf)', note: 'Traversal: the second Position comes from the parent (up the ChildOf hierarchy), not the entity.' },
  { expr: 'Position, (ChildOf, $party), Leader($party)', note: 'Variables as sources: entities whose parent ($party) has Leader. The plan shows the extra steps.' },
  { expr: 'Position, Time(Game)', note: 'Fixed source: Time always comes from the Game entity (a singleton-style lookup), shared by every result.' },
];

export class QueryPlayground {
  private w!: FlecsWorld;
  private root: El;
  private input!: HTMLInputElement;
  private noteEl!: El;
  private resultsEl!: El;
  private tablesEl!: El;
  private planEl!: El;
  private timer = 0;
  private userEntities = new Set<number>();

  constructor(
    host: El,
    private initial = PRESETS[0].expr,
  ) {
    this.root = h('div', { class: 'qpg' }, h('p', { class: 'qpg-muted' }, 'Starting flecs…'));
    host.replaceChildren(this.root);
  }

  async init(): Promise<void> {
    try {
      this.w = await FlecsWorld.create();
    } catch (e) {
      this.root.replaceChildren(h('p', { class: 'qpg-err' }, `Couldn't start flecs: ${(e as Error).message}`));
      return;
    }
    const s = this.w.script(QUERY_WORLD, 'world');
    if (!s.ok) {
      this.root.replaceChildren(h('p', { class: 'qpg-err' }, `Setup failed: ${s.error}`));
      return;
    }
    for (const n of WORLD_NAMES) this.userEntities.add(this.w.lookup(n));
    this.build();
    this.run();
  }

  private build(): void {
    this.input = h('input', { type: 'text', class: 'qpg-in', value: this.initial, spellcheck: 'false', 'aria-label': 'Query' });
    this.input.addEventListener('input', () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.run(), 200);
    });
    this.noteEl = h('p', { class: 'qpg-note' });
    this.resultsEl = h('div', { class: 'qpg-results' });
    this.tablesEl = h('div', { class: 'qpg-tables' });
    this.planEl = h('pre', { class: 'qpg-plan' });
    const presets = h(
      'div',
      { class: 'qpg-presets' },
      ...PRESETS.map((p) =>
        h(
          'button',
          {
            type: 'button',
            class: 'qpg-preset',
            onclick: () => {
              this.input.value = p.expr;
              this.run();
            },
          },
          p.expr,
        ),
      ),
    );
    this.root.replaceChildren(
      h('div', { class: 'qpg-q' }, h('span', { class: 'qpg-label' }, 'query'), this.input),
      presets,
      this.noteEl,
      h('div', { class: 'qpg-main' }, h('div', {}, h('div', { class: 'qpg-h' }, 'Results'), this.resultsEl), h('div', {}, h('div', { class: 'qpg-h' }, 'Tables (lit = matched)'), this.tablesEl)),
      h('details', { class: 'qpg-plan-d' }, h('summary', {}, 'Query plan (how flecs will evaluate it)'), this.planEl),
    );
  }

  private run(): void {
    const expr = this.input.value.trim();
    const preset = PRESETS.find((p) => p.expr === expr);
    this.noteEl.textContent = preset?.note ?? '';
    if (!expr) {
      this.resultsEl.replaceChildren(h('p', { class: 'qpg-muted' }, 'Type a query, or pick an example above.'));
      this.tablesEl.replaceChildren();
      this.planEl.textContent = '';
      return;
    }
    const r = this.w.rest<{ results?: Array<Record<string, unknown>>; error?: string }>('GET', '/query', { expr, values: true, fields: true, try: true });
    if (r.status !== 200 || !r.body || r.body.error) {
      const err = r.body?.error ?? this.w.log.at(-1)?.text ?? 'invalid query';
      this.resultsEl.replaceChildren(h('pre', { class: 'qpg-err' }, err));
      this.tablesEl.replaceChildren();
      this.planEl.textContent = '';
      return;
    }
    const results = (r.body.results ?? []).filter((x) => this.isLesson(x));
    const terms = expr.split(/,(?![^(]*\))/).map((t) => t.trim());
    const varNames = [...new Set(results.flatMap((x) => Object.keys((x.vars as Record<string, string>) ?? {})))];
    const head = h('tr', {}, h('th', {}, 'entity'), ...varNames.map((v) => h('th', {}, `$${v}`)), ...terms.map((t, i) => h('th', { title: t }, `field ${i}: ${t}`)));
    const rows = results.map((x) => {
      const f = (x.fields ?? {}) as { values?: unknown[]; is_set?: boolean[]; sources?: Array<string | number>; ids?: unknown[] };
      const name = x.parent ? `${x.parent}.${x.name}` : String(x.name);
      return h(
        'tr',
        {},
        h('td', { class: 'ent' }, name),
        ...varNames.map((v) => h('td', { class: 'var' }, String(((x.vars as Record<string, string>) ?? {})[v] ?? ''))),
        ...terms.map((_, i) => {
          const set = f.is_set ? f.is_set[i] : true;
          const src = f.sources?.[i];
          const id = f.ids?.[i];
          const value = f.values?.[i];
          return h(
            'td',
            { class: set ? '' : 'unset' },
            !set ? '∅ not set' : typeof value === 'object' && value ? fmt(value) : Array.isArray(id) ? `(${id.join(', ')})` : '✓',
            src && src !== 0 ? h('span', { class: 'src' }, ` from ${src}`) : null,
          );
        }),
      );
    });
    this.resultsEl.replaceChildren(
      h('p', { class: 'qpg-muted' }, `${results.length} result${results.length === 1 ? '' : 's'}`),
      results.length ? h('table', {}, h('thead', {}, head), h('tbody', {}, ...rows)) : h('p', { class: 'qpg-muted' }, 'Nothing matches.'),
    );
    // Tables
    const matched = new Map<number, number>();
    for (const [t, n] of this.w.queryTables(expr) ?? []) matched.set(t, (matched.get(t) ?? 0) + n);
    const tables = this.w.tables(64).filter((t) => t.entities.some((e) => this.userEntities.has(e)));
    this.tablesEl.replaceChildren(
      ...tables.map((t) => {
        const n = matched.get(t.id);
        const type = t.type.map((c) => c.str).filter((s) => s !== '(Identifier,Name)');
        return h(
          'div',
          { class: `qpg-table ${n ? 'on' : ''}` },
          h('span', { class: 'qpg-type' }, `[${type.join(', ')}]`),
          h('span', { class: 'qpg-ents' }, t.entities.filter((e) => this.userEntities.has(e)).map((e) => this.w.name(e).split('.').pop()).join(', ')),
          n ? h('span', { class: 'qpg-n' }, `${n} result${n === 1 ? '' : 's'}`) : null,
        );
      }),
    );
    const plan = this.w.rest<{ query_plan?: string }>('GET', '/query', { expr, query_plan: true, results: false, try: true });
    // eslint-disable-next-line no-control-regex
    this.planEl.textContent = (plan.body?.query_plan ?? '').replace(/\u001b?\[[0-9;]*m/g, '');
  }

  private isLesson(x: Record<string, unknown>): boolean {
    const name = x.parent ? `${x.parent}.${x.name}` : String(x.name);
    return WORLD_NAMES.includes(name);
  }
}
