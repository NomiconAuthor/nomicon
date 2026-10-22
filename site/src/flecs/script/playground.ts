import { FlecsWorld } from '../runtime';

/**
 * Script playground: a world where "the game" has registered a few components
 * (some with reflection, one without) and a pretend physics engine that owns a
 * body per RigidBody through OnSet / OnRemove observers. Readers run Flecs
 * Script against it and watch what gets created, what the glue does, and what
 * fails for lack of reflection.
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

/** What the game registers before any script runs (as script, since the page has no C++). */
const GAME_SETUP = `enum Shape(Box, Sphere, Capsule)
struct Position(x: f32, y: f32)
struct RigidBody(shape: Shape, mass: f32)`;

/** The same registration as it would look in a C++ game, shown to the reader. */
export const GAME_CPP = `enum class Shape { Box, Sphere, Capsule };
struct Position  { float x, y; };
struct RigidBody { Shape shape; float mass; };
struct Health    { float value; };

// Reflection: tells flecs what is inside each type.
world.component<Shape>();                      // enum constants are reflected for you
world.component<Position>()
    .member<float>("x").member<float>("y");
world.component<RigidBody>()
    .member<Shape>("shape").member<float>("mass");
world.component<Health>();                     // registered, but no members described

// Glue: the physics engine owns one body per RigidBody.
world.observer<const RigidBody>("PhysicsSync")
    .event(flecs::OnSet)
    .each([](flecs::entity e, const RigidBody& rb) {
        if (BodyID* id = bodies.find(e)) physics.update(*id, rb);
        else bodies.insert(e, physics.create(rb));
    });
world.observer<const RigidBody>("PhysicsDestroy")
    .event(flecs::OnRemove)
    .each([](flecs::entity e, const RigidBody&) {
        physics.destroy(bodies.take(e));
    });`;

export interface ScriptPreset {
  label: string;
  code: string;
  note: string;
}

export const SCRIPT_PRESETS: ScriptPreset[] = [
  {
    label: 'Spawn two bodies',
    code: `Crate {
  Position: {x: 0, y: 2}
  RigidBody: {shape: Box, mass: 10}
}

Ball {
  Position: {x: 3, y: 5}
  RigidBody: {shape: Sphere, mass: 1}
}`,
    note: 'Each RigidBody value the script assigns is an ordinary set: OnSet fires, and the glue creates a body.',
  },
  {
    label: 'Change a value',
    code: `Crate {
  RigidBody: {shape: Box, mass: 20}
}`,
    note: 'Running a script again for an existing entity sets the value again. OnSet fires again, so the glue must update the existing body rather than create a second one. Run it twice: it fires every time, even when nothing changed.',
  },
  {
    label: 'Prefab instances',
    code: `prefab Barrel {
  RigidBody: {shape: Capsule, mass: 5}
}

Barrel1 : Barrel { Position: {x: 1, y: 0} }
Barrel2 : Barrel { Position: {x: 2, y: 0} }`,
    note: 'The prefab itself gets no body (prefabs are skipped by queries and observers). Each instance gets its own copy of RigidBody, and the glue runs for each one.',
  },
  {
    label: 'Edit the prefab',
    code: `Barrel {
  RigidBody: {shape: Capsule, mass: 50}
}`,
    note: 'Run "Prefab instances" first. Changing the prefab does not touch the instances: they own copies. No OnSet fires for them and their bodies keep mass 5.',
  },
  {
    label: 'No reflection',
    code: `Knight {
  Health: {value: 100}
}`,
    note: 'Health is registered without members, so flecs has no idea what {value: 100} means. Scripts, JSON and the explorer all need reflection to touch values.',
  },
  {
    label: 'Component made in script',
    code: `struct Oil(litres: f32)

Lantern {
  Oil: {litres: 2}
  Position: {x: 8, y: 0}
}`,
    note: 'Scripts can define components too, and those come with reflection. Game code can look them up by name, but has no C++ type for them.',
  },
];

interface LogLine {
  cls: string;
  text: string;
}

export class ScriptPlayground {
  private w!: FlecsWorld;
  private root: El;
  private editor!: HTMLTextAreaElement;
  private noteEl!: El;
  private errEl!: El;
  private entsEl!: El;
  private bodiesEl!: El;
  private logEl!: El;
  private baseline = new Set<number>();
  private bodies = new Map<number, { id: number; shape: string; mass: number }>();
  private nextBody = 1;
  private log: LogLine[] = [];
  private pushed = 0;
  private run = 0;

  constructor(host: El) {
    this.root = h('div', { class: 'spg' }, h('p', { class: 'spg-muted' }, 'Starting flecs…'));
    host.replaceChildren(this.root);
  }

  async init(): Promise<void> {
    try {
      this.w = await FlecsWorld.create();
    } catch (e) {
      this.root.replaceChildren(h('p', { class: 'spg-err' }, `Couldn't start flecs: ${(e as Error).message}`));
      return;
    }
    this.build();
    this.resetWorld();
    this.editor.value = SCRIPT_PRESETS[0].code;
    this.noteEl.textContent = SCRIPT_PRESETS[0].note;
  }

  private resetWorld(): void {
    this.w.reset();
    this.bodies.clear();
    this.nextBody = 1;
    this.log = [];
    const s = this.w.script(GAME_SETUP, 'game');
    if (!s.ok) {
      this.errEl.textContent = `Setup failed: ${s.error}`;
      return;
    }
    this.w.componentRaw('Health', 4);
    this.w.observer('PhysicsSync', 'RigidBody', ['OnSet'], (it) => {
      const vals = it.field<{ shape: string; mass: number }>(0);
      it.entities.forEach((e, i) => {
        const v = vals[i] ?? vals[0];
        const name = it.name(e);
        const b = this.bodies.get(e);
        if (b) {
          b.shape = v.shape;
          b.mass = v.mass;
          this.push('obs', `PhysicsSync (OnSet) on ${name}: update body #${b.id} → ${v.shape}, mass ${v.mass}`);
        } else {
          const nb = { id: this.nextBody++, shape: v.shape, mass: v.mass };
          this.bodies.set(e, nb);
          this.push('obs', `PhysicsSync (OnSet) on ${name}: create body #${nb.id} (${v.shape}, mass ${v.mass})`);
        }
      });
    });
    this.w.observer('PhysicsDestroy', 'RigidBody', ['OnRemove'], (it) => {
      for (const e of it.entities) {
        const b = this.bodies.get(e);
        this.bodies.delete(e);
        this.push('obs', `PhysicsDestroy (OnRemove) on ${it.name(e)}: ${b ? `destroy body #${b.id}` : 'no body to destroy'}`);
      }
    });
    this.baseline = new Set(this.allEntities());
    this.push('sys', 'World reset: game components and physics glue registered.');
    this.errEl.textContent = '';
    this.refresh();
  }

  private allEntities(): number[] {
    return this.w.tables(4096).flatMap((t) => t.entities);
  }

  private push(cls: string, text: string): void {
    this.log.push({ cls, text });
    this.pushed++;
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  private build(): void {
    this.editor = h('textarea', { class: 'spg-ed', spellcheck: 'false', rows: '9', 'aria-label': 'Flecs Script' });
    this.editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.runScript();
      }
    });
    this.noteEl = h('p', { class: 'spg-note' });
    this.errEl = h('pre', { class: 'spg-err' });
    this.entsEl = h('div', { class: 'spg-ents' });
    this.bodiesEl = h('div', { class: 'spg-bodies' });
    this.logEl = h('div', { class: 'spg-log' });
    const presets = h(
      'div',
      { class: 'spg-presets' },
      ...SCRIPT_PRESETS.map((p) =>
        h(
          'button',
          {
            type: 'button',
            class: 'spg-preset',
            onclick: () => {
              this.editor.value = p.code;
              this.noteEl.textContent = p.note;
              this.errEl.textContent = '';
            },
          },
          p.label,
        ),
      ),
    );
    this.root.replaceChildren(
      h('details', { class: 'spg-game' }, h('summary', {}, 'What the game registered (C++)'), h('pre', {}, GAME_CPP)),
      presets,
      this.noteEl,
      this.editor,
      h(
        'div',
        { class: 'spg-ctrls' },
        h('button', { type: 'button', class: 'spg-run', onclick: () => this.runScript() }, 'Run script'),
        h('button', { type: 'button', class: 'spg-btn', onclick: () => this.resetWorld() }, 'Reset world'),
        h('span', { class: 'spg-muted' }, 'Ctrl+Enter runs. Scripts add to the current world.'),
      ),
      this.errEl,
      h(
        'div',
        { class: 'spg-main' },
        h('div', {}, h('div', { class: 'spg-h' }, 'Entities (as JSON, through reflection)'), this.entsEl),
        h('div', {}, h('div', { class: 'spg-h' }, 'Physics engine'), this.bodiesEl, h('div', { class: 'spg-h' }, 'What ran'), this.logEl),
      ),
    );
  }

  private runScript(): void {
    const code = this.editor.value;
    this.run++;
    this.push('sys', `Script run ${this.run}`);
    const before = this.pushed;
    const r = this.w.script(code, `run${this.run}`);
    this.errEl.textContent = r.ok ? '' : r.error ?? 'script error';
    if (!r.ok) this.push('err', `Script failed: ${r.error}`);
    else if (this.pushed === before) this.push('sys', '(no observers ran)');
    this.refresh();
  }

  private remove(e: number): void {
    const name = this.w.name(e);
    this.push('sys', `delete ${name}`);
    this.w.rest('DELETE', `/entity/${name.replace(/\./g, '/')}`);
    this.refresh();
  }

  private refresh(): void {
    const ents = this.allEntities().filter((e) => !this.baseline.has(e));
    const rows: El[] = [];
    for (const e of ents) {
      const name = this.w.name(e);
      const r = this.w.rest<{ components?: Record<string, unknown>; pairs?: Record<string, unknown>; tags?: string[] }>('GET', `/entity/${name.replace(/\./g, '/')}`);
      const j = r.body ?? {};
      const comps = Object.keys(j.components ?? {});
      // Skip what a script defines rather than spawns: components, members, enum constants.
      if (comps.some((c) => c === 'flecs.core.Component' || c.startsWith('flecs.meta.')) || (j.tags ?? []).some((t) => t.startsWith('flecs.meta.'))) continue;
      const prefab = (j.tags ?? []).includes('flecs.core.Prefab');
      const shown: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(j.components ?? {})) shown[k] = v;
      for (const [k, v] of Object.entries(j.pairs ?? {})) shown[`(${k.replace('flecs.core.', '')}, ${v})`] = true;
      rows.push(
        h(
          'div',
          { class: `spg-ent ${prefab ? 'prefab' : ''}` },
          h('div', { class: 'spg-ent-h' }, h('span', { class: 'spg-ent-n' }, name), prefab ? h('span', { class: 'spg-tag' }, 'prefab') : null, h('button', { type: 'button', class: 'spg-x', title: `Delete ${name}`, onclick: () => this.remove(e) }, 'delete')),
          h(
            'pre',
            {},
            Object.entries(shown)
              .map(([k, v]) => (v === true ? k : `${k}: ${v === null ? 'null   (no reflection: flecs cannot show it)' : JSON.stringify(v)}`))
              .join('\n') || '(no components)',
          ),
        ),
      );
    }
    this.entsEl.replaceChildren(...(rows.length ? rows : [h('p', { class: 'spg-muted' }, 'No entities yet. Run a script.')]));
    const bodies = [...this.bodies.entries()];
    this.bodiesEl.replaceChildren(
      bodies.length
        ? h('table', {}, h('tbody', {}, ...bodies.map(([e, b]) => h('tr', {}, h('td', {}, `body #${b.id}`), h('td', {}, this.w.name(e)), h('td', {}, b.shape), h('td', {}, `mass ${b.mass}`)))))
        : h('p', { class: 'spg-muted' }, 'No bodies.'),
    );
    this.logEl.replaceChildren(...this.log.slice(-40).map((l) => h('div', { class: `spg-l ${l.cls}` }, l.text)));
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
