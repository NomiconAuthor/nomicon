import { h, seg } from './dom';

/**
 * Hot reloading, modelled at the level of bytes and addresses.
 *
 * A host (game.exe) runs a game module (game.dll) that bounces a few orbs. The orbs' state is
 * real bytes in a DataView, laid out by whichever version of the module wrote them, and the
 * module's functions and string literals live at addresses inside its loaded image. Reloading
 * swaps, patches or rebuilds the module by one of five strategies, and the next frames run the
 * new code against whatever bytes and addresses that strategy left behind: a layout change
 * reads old bytes with new offsets, and a pointer into an unloaded image crashes on use.
 */

// ---------------------------------------------------------------------------------------------
// Layouts and module versions

type FieldKind = 'f32' | 'ptr';
interface Field {
  name: string;
  off: number;
  kind: FieldKind;
}
interface Layout {
  name: string;
  stride: number;
  fields: Field[];
}
const f = (name: string, off: number, kind: FieldKind = 'f32'): Field => ({ name, off, kind });
const L_BASE: Layout = { name: 'Orb', stride: 16, fields: [f('x', 0), f('y', 4), f('vx', 8), f('vy', 12)] };
const L_RADIUS: Layout = { name: 'Orb', stride: 20, fields: [f('x', 0), f('y', 4), f('radius', 8), f('vx', 12), f('vy', 16)] };
const L_PTRS: Layout = { name: 'Orb', stride: 24, fields: [f('x', 0), f('y', 4), f('vx', 8), f('vy', 12), f('name', 16, 'ptr'), f('on_bounce', 20, 'ptr')] };

interface Version {
  build: number;
  layout: Layout;
  gravity: number;
  /** Theme token for the orbs this code draws, and for its bounce rings. */
  colour: string;
  /** The string literal `name` points at, if the layout has one. */
  label: string;
  code: string;
}

export type Scenario = 'code' | 'field' | 'pointers';
export type Strategy = 'restart' | 'module-state' | 'swap' | 'patch' | 'reinstance';

const STRUCT_BASE = `struct Orb { float x, y, vx, vy; };`;
const STRUCT_RADIUS = `struct Orb { float x, y, radius, vx, vy; };   // new field`;
const STRUCT_PTRS = `struct Orb {
    float x, y, vx, vy;
    const char* name;                 // points at a string literal in game.dll
    void (*on_bounce)(Orb*);          // points at a function in game.dll
};`;

export const SCENARIOS: Record<Scenario, { label: string; before: Version; after: Version; what: string }> = {
  code: {
    label: 'Change code only',
    what: 'Add gravity and change the colour. The struct stays the same.',
    before: { build: 1, layout: L_BASE, gravity: 0, colour: '--c2', label: '', code: `${STRUCT_BASE}\n\nvoid update(Orb* o, float dt) {\n    o->x += o->vx * dt;\n    o->y += o->vy * dt;\n    bounce(o);\n}` },
    after: { build: 2, layout: L_BASE, gravity: 300, colour: '--c3', label: '', code: `${STRUCT_BASE}\n\nvoid update(Orb* o, float dt) {\n    o->vy += GRAVITY * dt;            // new\n    o->x += o->vx * dt;\n    o->y += o->vy * dt;\n    bounce(o);\n}` },
  },
  field: {
    label: 'Add a field',
    what: 'Give each orb a radius. The struct grows, and the fields after it move.',
    before: { build: 1, layout: L_BASE, gravity: 0, colour: '--c2', label: '', code: `${STRUCT_BASE}\n\nvoid update(Orb* o, float dt) {\n    o->x += o->vx * dt;\n    o->y += o->vy * dt;\n    bounce(o, 6.0f);\n}` },
    after: { build: 2, layout: L_RADIUS, gravity: 0, colour: '--c3', label: '', code: `${STRUCT_RADIUS}\n\nvoid update(Orb* o, float dt) {\n    o->x += o->vx * dt;\n    o->y += o->vy * dt;\n    bounce(o, o->radius);\n}` },
  },
  pointers: {
    label: 'Change code, state holds pointers',
    what: 'Add gravity and rename the orbs. The struct is unchanged, but each orb holds a callback and a name that point into the module.',
    before: { build: 1, layout: L_PTRS, gravity: 0, colour: '--c2', label: '"orbs"', code: `${STRUCT_PTRS}\n\nvoid init(Orb* o) { o->name = "orbs"; o->on_bounce = &ring; }` },
    after: { build: 2, layout: L_PTRS, gravity: 300, colour: '--c3', label: '"bubbles"', code: `${STRUCT_PTRS}\n\nvoid init(Orb* o) { o->name = "bubbles"; o->on_bounce = &ring; }\n// update() now adds gravity` },
  },
};

export const STRATEGIES: Record<Strategy, { label: string; short: string; how: string }> = {
  restart: { label: 'Restart the game', short: 'Restart', how: 'Close the game, rebuild, start again. The baseline: always correct, and you lose your place.' },
  'module-state': { label: 'Swap the DLL, state inside it', short: 'Swap, state in DLL', how: 'Unload game.dll and load the new build, but the game kept its state in the DLL\'s own globals, so the state goes with it.' },
  swap: { label: 'Swap the DLL, state in the host', short: 'Swap, state in host', how: 'The host owns all game memory and passes it to the DLL through a C API. Unload, load the new build, keep the bytes.' },
  patch: { label: 'Patch functions in place', short: 'Patch in place', how: 'Live++ / Unreal Live Coding: load the new code beside the old and overwrite the start of each changed function with a jump to its new version. Nothing is unloaded.' },
  reinstance: { label: 'Serialise and rebuild', short: 'Serialise, rebuild', how: 'Save every object by field name, unload, load the new build, recreate the objects and restore the fields by name (Unity\'s domain reload, Unreal\'s reinstancing).' },
};

// ---------------------------------------------------------------------------------------------
// Memory

export interface Region {
  name: string;
  base: number;
  size: number;
  loaded: boolean;
  note: string;
}
const HEX = (n: number) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
export const hex = HEX;

const MOD_BASES = [0x10000000, 0x10020000, 0x10040000];
const OFF_UPDATE = 0x1000;
const OFF_RING = 0x1400;
const OFF_NAME = 0x8000;
const OFF_STATICS = 0xa000;
const HEAP = 0x02a10000;

export const N_ORBS = 6;
const BYTES = 256; // the allocation plus whatever follows it
export const BOX_W = 360;
export const BOX_H = 200;

interface Module {
  version: Version;
  base: number;
  region: Region;
  /** Functions patched to jump elsewhere (Live++ style), by offset. */
  jumps: Map<number, number>;
}

export interface Ring {
  x: number;
  y: number;
  colour: string;
  age: number;
}

export interface LogLine {
  text: string;
  cls?: 'good' | 'bad' | 'warn' | 'muted';
}

/** One run: start on the scenario's old build, then reload once into its new build. */
export class ReloadSim {
  regions: Region[] = [];
  modules: Module[] = [];
  /** The module whose function table the host calls. */
  active!: Module;
  bytes = new DataView(new ArrayBuffer(BYTES));
  /** Which field (and build) last wrote each 4-byte word, for the byte view. */
  writer: Array<{ field: string; build: number } | null> = [];
  stateAddr = HEAP;
  /** The layout the bytes were written with, and the layout the running code reads. */
  layoutWritten!: Layout;
  crashed = '';
  reloaded = false;
  lost = false;
  hitch = false;
  bounces = 0;
  rings: Ring[] = [];
  time = 0;
  log: LogLine[] = [];
  private nextBase = 0;

  constructor(
    public scenario: Scenario,
    public strategy: Strategy,
    public fixPointers = false,
  ) {
    this.start(SCENARIOS[scenario].before);
  }

  get code(): Version {
    return this.active.version;
  }

  private load(v: Version, patch = false): Module {
    const base = MOD_BASES[this.nextBase++];
    const region: Region = { name: patch ? `patch (build ${v.build})` : `game_${v.build}.dll`, base, size: 0x10000, loaded: true, note: patch ? 'changed functions only' : `build ${v.build}` };
    const m: Module = { version: v, base, region, jumps: new Map() };
    this.regions.push(region);
    this.modules.push(m);
    return m;
  }

  private start(v: Version): void {
    this.regions = [{ name: 'game.exe', base: 0x00400000, size: 0x40000, loaded: true, note: 'host' }];
    this.modules = [];
    this.nextBase = 0;
    this.active = this.load(v);
    this.stateAddr = this.strategy === 'module-state' ? this.active.base + OFF_STATICS : HEAP;
    if (this.strategy !== 'module-state') this.regions.splice(1, 0, { name: 'heap: game memory', base: HEAP, size: 0x1000, loaded: true, note: 'owned by the host' });
    this.init(v);
  }

  /** The module's init(): fresh orbs, written with its layout. */
  private init(v: Version): void {
    this.bytes = new DataView(new ArrayBuffer(BYTES));
    this.writer = new Array(BYTES / 4).fill(null);
    this.layoutWritten = v.layout;
    const seeds = [
      [40, 50, 120, 70],
      [110, 140, 95, -110],
      [200, 60, -140, 90],
      [270, 150, 70, 120],
      [320, 80, -100, -80],
      [160, 100, 150, 40],
    ];
    for (let i = 0; i < N_ORBS; i++) {
      const [x, y, vx, vy] = seeds[i];
      this.write(i, 'x', x);
      this.write(i, 'y', y);
      this.write(i, 'vx', vx);
      this.write(i, 'vy', vy);
      this.write(i, 'radius', 5 + (i % 3) * 2);
      this.write(i, 'name', this.addr(this.active, OFF_NAME));
      this.write(i, 'on_bounce', this.addr(this.active, OFF_RING));
    }
  }

  private addr(m: Module, off: number): number {
    return m.base + off;
  }

  private field(name: string, layout = this.code.layout): Field | undefined {
    return layout.fields.find((x) => x.name === name);
  }

  private write(i: number, name: string, value: number, layout = this.code.layout): void {
    const fl = this.field(name, layout);
    if (!fl) return;
    const at = i * layout.stride + fl.off;
    if (at + 4 > BYTES) return;
    if (fl.kind === 'ptr') this.bytes.setUint32(at, value >>> 0, true);
    else this.bytes.setFloat32(at, value, true);
    this.writer[at / 4] = { field: name, build: this.code.build };
  }

  read(i: number, name: string, layout = this.code.layout): number {
    const fl = this.field(name, layout);
    if (!fl) return NaN;
    const at = i * layout.stride + fl.off;
    if (at + 4 > BYTES) return 0;
    return fl.kind === 'ptr' ? this.bytes.getUint32(at, true) : this.bytes.getFloat32(at, true);
  }

  /** What's at an address, following patched jumps. Throws (crashes) on unmapped memory. */
  private deref(a: number, what: 'executing' | 'reading'): { m: Module; off: number; via: string } {
    let m = this.modules.find((x) => a >= x.base && a < x.base + x.region.size);
    if (!m || !m.region.loaded) {
      const was = this.modules.find((x) => a >= x.base && a < x.base + x.region.size);
      throw new Error(`Access violation ${what} ${HEX(a)}${was ? ` (${was.region.name} was unloaded)` : ' (not mapped)'}`);
    }
    let off = a - m.base;
    let via = '';
    const j = m.jumps.get(off);
    if (j !== undefined && what === 'executing') {
      via = `${m.region.name} → jump → `;
      m = this.modules.find((x) => j >= x.base && j < x.base + x.region.size)!;
      off = j - m.base;
    }
    return { m, off, via };
  }

  /** The name an orb shows: the string its pointer points at, or a placeholder. */
  orbName(i: number): string {
    if (!this.field('name')) return '';
    const a = this.read(i, 'name');
    const m = this.modules.find((x) => a >= x.base && a < x.base + x.region.size);
    if (!m) return `?? (${HEX(a)})`;
    if (!m.region.loaded) return `dangling (${HEX(a)})`;
    return a - m.base === OFF_NAME ? m.version.label : `?? (${HEX(a)})`;
  }

  step(dt: number): void {
    if (this.crashed || this.lost) return;
    this.time += dt;
    this.rings.forEach((r) => (r.age += dt));
    this.rings = this.rings.filter((r) => r.age < 0.5);
    const v = this.code;
    try {
      for (let i = 0; i < N_ORBS; i++) {
        let x = this.read(i, 'x');
        let y = this.read(i, 'y');
        let vx = this.read(i, 'vx');
        let vy = this.read(i, 'vy');
        const r = this.field('radius') ? this.read(i, 'radius') : 6;
        const rr = Number.isFinite(r) ? Math.min(40, Math.max(0, Math.abs(r))) : 0;
        if (!Number.isFinite(x + y + vx + vy)) continue; // garbage bits: the orb just sits there
        vy += v.gravity * dt;
        x += vx * dt;
        y += vy * dt;
        let hit = false;
        if (x < rr) [x, vx, hit] = [rr, Math.abs(vx), true];
        if (x > BOX_W - rr) [x, vx, hit] = [BOX_W - rr, -Math.abs(vx), true];
        if (y < rr) [y, vy, hit] = [rr, Math.abs(vy), true];
        if (y > BOX_H - rr) [y, vy, hit] = [BOX_H - rr, -Math.abs(vy) * (v.gravity ? 0.98 : 1), true];
        this.write(i, 'x', x);
        this.write(i, 'y', y);
        this.write(i, 'vx', vx);
        this.write(i, 'vy', vy);
        if (hit) {
          this.bounces++;
          if (this.field('on_bounce')) {
            const t = this.deref(this.read(i, 'on_bounce'), 'executing');
            this.rings.push({ x, y, colour: t.m.version.colour, age: 0 });
          } else this.rings.push({ x, y, colour: v.colour, age: 0 });
        }
      }
    } catch (e) {
      this.crashed = (e as Error).message;
      this.log.push({ text: `Crash: ${this.crashed}.`, cls: 'bad' });
    }
  }

  /** Build the scenario's new version and reload it by this run's strategy. */
  reload(): void {
    if (this.reloaded || this.crashed) return;
    this.reloaded = true;
    const next = SCENARIOS[this.scenario].after;
    const old = this.active;
    const L = (text: string, cls?: LogLine['cls']) => this.log.push({ text, cls });
    switch (this.strategy) {
      case 'restart': {
        L('Close the game. Every byte of state is gone.', 'muted');
        L(`Rebuild, start game.exe, load game_${next.build}.dll, call init().`);
        this.start(next);
        this.lost = false;
        L('Correct, but the orbs are back where they started, and in a real game you\'d now play back to where you were.', 'warn');
        break;
      }
      case 'module-state': {
        L(`FreeLibrary(game_${old.version.build}.dll). Its globals, which held the orbs, are unmapped.`, 'muted');
        old.region.loaded = false;
        this.active = this.load(next);
        L(`LoadLibrary(game_${next.build}.dll) at ${HEX(this.active.base)}. Its globals start zeroed, so the host calls init() again.`);
        this.stateAddr = this.active.base + OFF_STATICS;
        this.init(next);
        L('No crash and the new code runs, but the state reset: the same as a restart, minus the process launch.', 'warn');
        break;
      }
      case 'swap': {
        L(`api->unload(&memory), then FreeLibrary(game_${old.version.build}.dll): ${HEX(old.base)}..${HEX(old.base + 0xffff)} is unmapped.`, 'muted');
        old.region.loaded = false;
        this.active = this.load(next);
        L(`LoadLibrary(game_${next.build}.dll) at ${HEX(this.active.base)}; get_game_api() returns the new function table.`);
        L(`The orbs' bytes at ${HEX(this.stateAddr)} are untouched: the host owns them.`, 'good');
        if (this.layoutWritten !== next.layout) L(`But they were written as a ${this.layoutWritten.stride}-byte Orb and build ${next.build} reads a ${next.layout.stride}-byte one: every field after x and y is read from the wrong offset.`, 'bad');
        if (next.layout.fields.some((x) => x.kind === 'ptr')) {
          if (this.fixPointers) {
            for (let i = 0; i < N_ORBS; i++) {
              this.write(i, 'name', this.addr(this.active, OFF_NAME));
              this.write(i, 'on_bounce', this.addr(this.active, OFF_RING));
            }
            L('api->reload(&memory) walks the orbs and re-points name and on_bounce into the new module.', 'good');
          } else L(`Each orb still holds name = ${HEX(old.base + OFF_NAME)} and on_bounce = ${HEX(old.base + OFF_RING)}, inside the unloaded image.`, 'bad');
        }
        break;
      }
      case 'patch': {
        this.active = old;
        const patch = this.load(next, true);
        L(`Compile the changed files and load them as a patch at ${HEX(patch.base)}. game_${old.version.build}.dll stays loaded.`);
        old.jumps.set(OFF_UPDATE, patch.base + OFF_UPDATE);
        old.jumps.set(OFF_RING, patch.base + OFF_RING);
        L(`Overwrite the first bytes of the old update() and ring() with jumps to the new ones. The host keeps calling the old addresses.`, 'muted');
        // The host still calls the old module's table, which now jumps into the new code.
        this.active = { ...old, version: next };
        L('No pause, nothing unloaded, the bytes untouched: pointers into the old image stay valid.', 'good');
        if (this.layoutWritten !== next.layout) L(`But the struct changed: the new code reads ${this.layoutWritten.stride}-byte orbs as ${next.layout.stride}-byte ones. Patching swaps code, not data.`, 'bad');
        if (next.layout.fields.some((x) => x.kind === 'ptr')) L(`The names still point at build ${old.version.build}'s literal ${old.version.label}: only code was patched, and init() doesn't run again.`, 'warn');
        break;
      }
      case 'reinstance': {
        const saved: Array<Record<string, number>> = [];
        for (let i = 0; i < N_ORBS; i++) {
          const o: Record<string, number> = {};
          for (const fl of this.layoutWritten.fields) if (fl.kind === 'f32') o[fl.name] = this.read(i, fl.name, this.layoutWritten);
          saved.push(o);
        }
        L(`Serialise ${N_ORBS} orbs by field name (${this.layoutWritten.fields.filter((x) => x.kind === 'f32').map((x) => x.name).join(', ')}). Pointers aren't saved: they mean nothing in another build.`, 'muted');
        old.region.loaded = false;
        this.active = this.load(next);
        L(`Unload game_${old.version.build}.dll, load game_${next.build}.dll at ${HEX(this.active.base)}, create fresh orbs with its init().`);
        this.init(next);
        for (let i = 0; i < N_ORBS; i++) for (const [k, val] of Object.entries(saved[i])) this.write(i, k, val);
        const fresh = next.layout.fields.filter((x) => x.kind === 'f32' && !(x.name in saved[0])).map((x) => x.name);
        const ptrs = next.layout.fields.some((x) => x.kind === 'ptr');
        L(`Restore every saved field that still exists${fresh.length ? `; ${fresh.join(', ')} keep${fresh.length === 1 ? 's' : ''} the default from init()` : ''}${ptrs ? '; name and on_bounce were set by the new init(), so they point into the new module' : ''}.`, 'good');
        this.hitch = true;
        L('Correct with any change, at the cost of a hitch that grows with the amount of state, and only for what the serialiser knows how to save.', 'warn');
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The widget

export class HotReloadViz {
  private root: HTMLElement;
  private sim!: ReloadSim;
  private scenario: Scenario = 'code';
  private strategy: Strategy = 'swap';
  private fix = false;
  private cnv = h('canvas', { class: 'hr-canvas', width: String(BOX_W * 2), height: String(BOX_H * 2), 'aria-label': 'The running game' });
  private status = h('div', { class: 'hr-status' });
  private mem = h('div', { class: 'hr-mem' });
  private bytesEl = h('div', { class: 'hr-bytes' });
  private logEl = h('ol', { class: 'hr-log' });
  private codeEl = h('pre', { class: 'hr-code' });
  private howEl = h('p', { class: 'll-muted hr-how' });
  private fixLabel!: HTMLElement;
  private reloadBtn!: HTMLButtonElement;
  private raf = 0;
  private last = 0;
  private visible = true;
  private hitchUntil = 0;
  private lastPanels = 0;
  private shownCrash = false;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ll-hr' });
    host.replaceChildren(this.root);
    const sc = seg<Scenario>('The edit', (Object.keys(SCENARIOS) as Scenario[]).map((k) => [k, SCENARIOS[k].label]), this.scenario, (v) => {
      this.scenario = v;
      this.restart();
    });
    const st = seg<Strategy>('Reload by', (Object.keys(STRATEGIES) as Strategy[]).map((k) => [k, STRATEGIES[k].short]), this.strategy, (v) => {
      this.strategy = v;
      this.restart();
    });
    const fixBox = h('input', {
      type: 'checkbox',
      onchange: (e: Event) => {
        this.fix = (e.target as HTMLInputElement).checked;
        this.restart();
      },
    });
    this.fixLabel = h('label', { class: 'll-chk' }, fixBox, ' reload() re-points pointers into the new module');
    this.reloadBtn = h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.reload() }, 'Build and reload') as HTMLButtonElement;
    this.root.append(
      sc.el,
      st.el,
      this.howEl,
      h('div', { class: 'll-row' }, this.reloadBtn, h('button', { type: 'button', class: 'll-btn', onclick: () => this.restart() }, 'Start over'), this.fixLabel),
      h('div', { class: 'hr-top' }, h('div', { class: 'hr-game' }, this.cnv, this.status), h('div', {}, h('div', { class: 'll-h' }, 'What happened'), this.logEl)),
      h('div', { class: 'hr-cols' }, h('div', {}, h('div', { class: 'll-h' }, 'Address space'), this.mem), h('div', {}, h('div', { class: 'll-h' }, 'The first two orbs, byte by byte'), this.bytesEl)),
      h('details', { class: 'hr-details' }, h('summary', {}, 'The code before and after the edit'), this.codeEl),
    );
    this.restart();
    new MutationObserver(() => this.draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    new IntersectionObserver((es) => {
      this.visible = es.some((e) => e.isIntersecting);
      if (this.visible && !this.raf) {
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.tick);
      }
    }).observe(this.root);
  }

  private restart(): void {
    this.sim = new ReloadSim(this.scenario, this.strategy, this.fix);
    this.sim.log.push({ text: `Running build 1. ${SCENARIOS[this.scenario].what} Press Build and reload.`, cls: 'muted' });
    this.hitchUntil = 0;
    this.shownCrash = false;
    const s = SCENARIOS[this.scenario];
    this.codeEl.textContent = `// build 1\n${s.before.code}\n\n// build 2\n${s.after.code}`;
    this.howEl.textContent = STRATEGIES[this.strategy].how;
    this.fixLabel.hidden = !(this.strategy === 'swap' && this.scenario === 'pointers');
    this.render();
  }

  private reload(): void {
    this.sim.reload();
    if (this.sim.hitch) this.hitchUntil = performance.now() + 700;
    if (this.strategy === 'restart') this.hitchUntil = performance.now() + 1200;
    this.render();
  }

  private tick = (t: number): void => {
    this.raf = 0;
    if (!this.visible) return;
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    if (t >= this.hitchUntil) {
      // Fixed 120 Hz steps so bounces don't depend on the frame rate.
      for (let k = 0; k < Math.round(dt * 120); k++) this.sim.step(1 / 120);
    }
    this.draw(t < this.hitchUntil);
    if (this.sim.crashed && !this.shownCrash) {
      this.shownCrash = true;
      this.render();
    } else if (t - this.lastPanels > 250) {
      // The bytes change every step; the panels only need a few updates a second.
      this.lastPanels = t;
      this.renderMem();
      this.renderBytes();
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private render(): void {
    const s = this.sim;
    this.reloadBtn.disabled = s.reloaded;
    this.logEl.replaceChildren(...s.log.map((l) => h('li', { class: l.cls ?? '' }, l.text)));
    this.renderMem();
    this.renderBytes();
    this.draw();
  }

  private renderMem(): void {
    const s = this.sim;
    const ptrs = s.code.layout.fields.filter((x) => x.kind === 'ptr');
    this.mem.replaceChildren(
      ...s.regions.map((r) =>
        h(
          'div',
          { class: `hr-region ${r.loaded ? '' : 'gone'} ${s.stateAddr >= r.base && s.stateAddr < r.base + r.size ? 'holds' : ''}` },
          h('span', { class: 'mono' }, `${hex(r.base)}`),
          h('b', {}, r.name),
          h('span', { class: 'll-muted' }, r.loaded ? (s.stateAddr >= r.base && s.stateAddr < r.base + r.size ? `${r.note}; holds the orbs` : r.note) : 'unloaded'),
        ),
      ),
      ...ptrs.map((p) => {
        const a = s.read(0, p.name);
        const m = s.regions.find((r) => a >= r.base && a < r.base + r.size);
        const ok = !!m && m.loaded;
        return h('div', { class: `hr-ptr ${ok ? 'ok' : 'bad'}` }, h('span', { class: 'mono' }, `orbs[0].${p.name} = ${hex(a)}`), ` → ${m ? m.name : 'nothing'}${ok ? '' : ' ✗'}`);
      }),
    );
  }

  private renderBytes(): void {
    const s = this.sim;
    const L = s.code.layout;
    const cells: HTMLElement[] = [];
    const words = Math.ceil((2 * Math.max(L.stride, s.layoutWritten.stride)) / 4);
    for (let w = 0; w < words; w++) {
      const at = w * 4;
      const wr = s.writer[w];
      const orb = Math.floor(at / L.stride);
      const fl = L.fields.find((x) => x.off === at - orb * L.stride);
      const val = fl ? (fl.kind === 'ptr' ? hex(s.bytes.getUint32(at, true)) : fmtF(s.bytes.getFloat32(at, true))) : '';
      const match = wr && fl && wr.field === fl.name;
      cells.push(
        h(
          'div',
          { class: `hr-cell ${wr ? `f-${wr.field}` : 'f-none'} ${fl && wr && !match ? 'mismatch' : ''}`, title: wr ? `Written as ${wr.field} by build ${wr.build}` : 'Never written' },
          h('span', { class: 'hr-off mono' }, `+${at}`),
          h('span', { class: 'hr-read' }, fl ? `[${orb}].${fl.name}` : ''),
          h('span', { class: 'hr-val mono' }, val),
          h('span', { class: 'hr-wrote' }, wr ? wr.field : '—'),
        ),
      );
    }
    this.bytesEl.replaceChildren(
      h('div', { class: 'hr-grid' }, ...cells),
      h('p', { class: 'll-muted hr-key' }, 'Top: how the running code reads each 4 bytes. Bottom and colour: which field last wrote them. Red border: the two disagree.'),
    );
  }

  private draw(hitch = false): void {
    const s = this.sim;
    const ctx = this.cnv.getContext('2d')!;
    const cs = getComputedStyle(this.cnv);
    const c = (n: string) => cs.getPropertyValue(n).trim() || '#888';
    const k = this.cnv.width / BOX_W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = c('--bg');
    ctx.fillRect(0, 0, this.cnv.width, this.cnv.height);
    ctx.scale(k, k);
    ctx.strokeStyle = c('--line');
    ctx.lineWidth = 1 / k;
    ctx.strokeRect(0.5, 0.5, BOX_W - 1, BOX_H - 1);
    if (!s.lost) {
      for (const r of s.rings) {
        ctx.strokeStyle = c(r.colour);
        ctx.globalAlpha = 1 - r.age / 0.5;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 8 + r.age * 40, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const hasR = s.code.layout.fields.some((x) => x.name === 'radius');
      for (let i = 0; i < N_ORBS; i++) {
        const x = s.read(i, 'x');
        const y = s.read(i, 'y');
        if (!Number.isFinite(x + y)) continue;
        const r = hasR ? Math.min(40, Math.abs(s.read(i, 'radius')) || 0) : 6;
        ctx.fillStyle = c(s.code.colour);
        ctx.beginPath();
        ctx.arc(Math.max(-20, Math.min(BOX_W + 20, x)), Math.max(-20, Math.min(BOX_H + 20, y)), Math.max(1.5, r), 0, Math.PI * 2);
        ctx.fill();
        const name = s.orbName(i);
        if (name && i < 2) {
          ctx.fillStyle = c('--muted');
          ctx.font = `11px ${c('--f-mono') || 'monospace'}`;
          ctx.fillText(name, Math.min(BOX_W - 90, Math.max(2, x + 9)), Math.max(12, y - 8));
        }
      }
    }
    if (hitch || s.crashed) {
      ctx.fillStyle = c('--bg');
      ctx.globalAlpha = 0.75;
      ctx.fillRect(0, 0, BOX_W, BOX_H);
      ctx.globalAlpha = 1;
      ctx.fillStyle = c(s.crashed ? '--alert' : '--warn');
      ctx.font = `600 13px ${c('--f-body') || 'sans-serif'}`;
      ctx.textAlign = 'center';
      const msg = s.crashed ? 'game.exe has stopped working' : this.strategy === 'restart' ? 'Restarting…' : 'Saving and rebuilding every object…';
      ctx.fillText(msg, BOX_W / 2, BOX_H / 2 - (s.crashed ? 8 : 0));
      if (s.crashed) {
        ctx.font = `11px ${c('--f-mono') || 'monospace'}`;
        ctx.fillStyle = c('--ink');
        ctx.fillText(s.crashed.replace(/ \(.*/, ''), BOX_W / 2, BOX_H / 2 + 12);
      }
      ctx.textAlign = 'start';
    }
    this.status.replaceChildren(
      s.crashed ? h('span', {}, h('b', {}, 'crashed')) : h('span', {}, h('b', {}, `build ${s.code.build}`), ' running'),
      h('span', {}, h('b', {}, String(s.bounces)), ' bounces'),
      h('span', {}, 'state at ', h('span', { class: 'mono' }, hex(s.stateAddr))),
    );
  }
}

function fmtF(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e6)) return v.toExponential(1);
  return v.toFixed(1);
}
