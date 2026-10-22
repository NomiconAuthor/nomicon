import { FlecsWorld } from '../runtime';

/**
 * Two real flecs worlds on one page: a server and a client. The server
 * replicates entities to the client by id, the way a game would over the
 * network, so readers can see what entity ranges, versions, a Replicated tag
 * and change tracking each do.
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

/** Both sides register the same components, in the same order, before any range is active. */
const SHARED = `struct Position(x: f32, y: f32)
struct Velocity(x: f32, y: f32)
struct Label(text: string)
Replicated {}
Spark {}
Position { Replicated }
Label { Replicated }`;

export const NET_CPP = `// Shared by server and client, registered before any range is active.
struct Replicated {};
world.component<Position>().add<Replicated>();
world.component<Label>().add<Replicated>();
world.component<Velocity>();                 // server-only simulation data

// Server: networked ids come from [5000, 99999].
world.range_set(world.range_new(5000, 99999));

// Client: its own entities come from [100000, ...), so they never
// collide with ids the server sends.
world.range_set(world.range_new(100000, 0));`;

const idx = (e: bigint) => Number(e & 0xffffffffn);
const ver = (e: bigint) => Number(e >> 32n);
const fmt = (e: bigint) => `#${idx(e)}${ver(e) ? ` v${ver(e)}` : ''}`;
const r1 = (v: number) => Math.round(v * 10) / 10;

interface Packet {
  delete: string[];
  spawn: Array<Record<string, unknown>>;
  changed: Array<Record<string, unknown>>;
  positions: Array<[string, number, number]>;
}

export class NetSim {
  private S!: FlecsWorld;
  private C!: FlecsWorld;
  private root: El;
  private ranges = true;
  /** Components whose component entity has the Replicated tag (asked from the server world). */
  private repl = new Set<string>();
  private serverIds: bigint[] = [];
  private clientIds: bigint[] = [];
  private created = new Set<bigint>();
  private dirty = new Set<bigint>();
  private deleted: bigint[] = [];
  private shipNo = 0;
  private sparkNo = 0;
  private renameNo = 0;
  private log: Array<{ cls: string; text: string }> = [];
  private sEl!: El;
  private cEl!: El;
  private pendingEl!: El;
  private logEl!: El;
  private rangeBtn!: HTMLButtonElement;
  private loseBox!: HTMLInputElement;

  constructor(host: El) {
    this.root = h('div', { class: 'net' }, h('p', { class: 'net-muted' }, 'Starting two flecs worlds…'));
    host.replaceChildren(this.root);
  }

  async init(): Promise<void> {
    try {
      // Each create() is a separate WebAssembly instance: two independent worlds.
      [this.S, this.C] = await Promise.all([FlecsWorld.create(), FlecsWorld.create()]);
    } catch (e) {
      this.root.replaceChildren(h('p', { class: 'net-err' }, `Couldn't start flecs: ${(e as Error).message}`));
      return;
    }
    this.build();
    this.reset();
  }

  private reset(): void {
    for (const w of [this.S, this.C]) {
      w.reset();
      w.script(SHARED, 'shared');
    }
    const q = this.S.rest<{ results?: Array<{ name: string }> }>('GET', '/query', { expr: 'Replicated' });
    this.repl = new Set((q.body?.results ?? []).map((r) => r.name));
    // Server-side change tracking, as observers would do it in a game.
    this.S.observer('TrackChanged', 'Label', ['OnSet'], (it) => {
      for (const e of it.entities) this.dirty.add(BigInt(e));
    });
    this.S.observer('TrackDeleted', 'Position', ['OnRemove'], (it) => {
      for (const e of it.entities) this.deleted.push(BigInt(e));
    });
    // The client reacts to replicated data too (nameplates, despawn effects). Both
    // sides create the same number of entities during setup, as real games often do.
    this.C.observer('Nameplates', 'Label', ['OnSet'], () => {});
    this.C.observer('DespawnEffects', 'Position', ['OnRemove'], () => {});
    // Ranges are activated last, after everything startup registers.
    if (this.ranges) {
      this.S.rangeSet(this.S.rangeNew(5000, 99999));
      this.C.rangeSet(this.C.rangeNew(100000, 0));
    }
    this.serverIds = [];
    this.clientIds = [];
    this.created.clear();
    this.dirty.clear();
    this.deleted = [];
    this.shipNo = this.sparkNo = this.renameNo = 0;
    this.log = [{ cls: 'sys', text: this.ranges ? 'Worlds reset with entity ranges: server ids from 5000, client-local ids from 100000.' : 'Worlds reset WITHOUT ranges: both worlds hand out ids from the same counter.' }];
    this.rangeBtn.textContent = this.ranges ? 'Entity ranges: on' : 'Entity ranges: off';
    this.rangeBtn.classList.toggle('off', !this.ranges);
    this.render();
  }

  private push(cls: string, text: string): void {
    this.log.push({ cls, text });
    if (this.log.length > 120) this.log.splice(0, this.log.length - 120);
  }

  // ---------------- Server actions ----------------

  private spawnShip(): void {
    const e = this.S.newEntity();
    this.shipNo++;
    this.S.setJson(e, 'Position', { x: this.shipNo * 10, y: 0 });
    this.S.setJson(e, 'Velocity', { x: 1, y: 0.5 * this.shipNo });
    this.S.setJson(e, 'Label', { text: `Ship ${this.shipNo}` });
    this.serverIds.push(e);
    this.created.add(e);
    this.dirty.delete(e); // the spawn message carries everything
    this.push('srv', `server: spawn ${fmt(e)} "Ship ${this.shipNo}"`);
    this.render();
  }

  private tick(): void {
    for (const e of this.serverIds) {
      const j = this.S.entityJson(e);
      const p = j?.components?.Position as { x: number; y: number } | undefined;
      const v = j?.components?.Velocity as { x: number; y: number } | undefined;
      if (p && v) this.S.setJson(e, 'Position', { x: r1(p.x + v.x), y: r1(p.y + v.y) });
    }
    this.push('srv', `server: tick (${this.serverIds.length} ship${this.serverIds.length === 1 ? '' : 's'} moved)`);
    this.render();
  }

  private rename(): void {
    const e = this.serverIds[this.renameNo++ % Math.max(1, this.serverIds.length)];
    if (e === undefined) return;
    const text = `Renamed ${this.renameNo}`;
    this.S.setJson(e, 'Label', { text });
    this.push('srv', `server: ${fmt(e)} Label = "${text}" (OnSet marks it changed)`);
    this.render();
  }

  private deleteShip(): void {
    const e = this.serverIds.shift();
    if (e === undefined) return;
    this.S.deleteEntity(e);
    this.created.delete(e);
    this.dirty.delete(e);
    this.push('srv', `server: delete ${fmt(e)} (its index will be recycled with a new version)`);
    this.render();
  }

  // ---------------- Client actions ----------------

  private spawnSpark(): void {
    const e = this.C.newEntity();
    this.sparkNo++;
    this.C.addByName(e, 'Spark');
    this.C.setJson(e, 'Position', { x: -this.sparkNo, y: -this.sparkNo });
    this.clientIds.push(e);
    this.push('cli', `client: spawn local spark ${fmt(e)}`);
    this.render();
  }

  // ---------------- The network ----------------

  /** Which components of an entity to send: only those whose component entity has Replicated. */
  private replicated(e: bigint): Record<string, unknown> {
    const j = this.S.entityJson(e);
    const out: Record<string, unknown> = { id: e.toString() };
    for (const [k, v] of Object.entries(j?.components ?? {})) if (this.isReplicated(k)) out[k] = v;
    return out;
  }

  private isReplicated(comp: string): boolean {
    return this.repl.has(comp);
  }

  private buildPacket(): Packet {
    return {
      delete: this.deleted.map((e) => e.toString()),
      spawn: [...this.created].map((e) => this.replicated(e)),
      changed: [...this.dirty].filter((e) => !this.created.has(e) && this.serverIds.includes(e)).map((e) => ({ id: e.toString(), Label: this.S.entityJson(e)?.components?.Label })),
      positions: this.serverIds
        .filter((e) => !this.created.has(e))
        .map((e) => {
          const p = this.S.entityJson(e)?.components?.Position as { x: number; y: number };
          return [e.toString(), p.x, p.y];
        }),
    };
  }

  private send(): void {
    const pkt = this.buildPacket();
    if (this.loseBox.checked && pkt.delete.length) {
      this.push('warn', `network: ${pkt.delete.length} delete message${pkt.delete.length === 1 ? '' : 's'} lost in transit`);
      pkt.delete = [];
    }
    this.loseBox.checked = false;
    const bytes = JSON.stringify(pkt).length;
    this.push('wire', `send: ${pkt.delete.length} delete, ${pkt.spawn.length} spawn, ${pkt.changed.length} changed, ${pkt.positions.length} positions (${bytes} bytes as JSON)`);
    this.created.clear();
    this.dirty.clear();
    this.deleted = [];
    this.apply(pkt);
    this.render();
  }

  private apply(pkt: Packet): void {
    const C = this.C;
    for (const s of pkt.delete) {
      const e = BigInt(s);
      if (C.getAlive(idx(e)) === e) {
        C.deleteEntity(e);
        this.clientIds = this.clientIds.filter((x) => x !== e);
        this.push('cli', `client: deleted ${fmt(e)}`);
      }
    }
    for (const msg of pkt.spawn) {
      const e = BigInt(msg.id as string);
      const r = C.makeAlive(e);
      if (r === 2) {
        const stale = C.getAlive(idx(e));
        this.push('warn', `client: ${fmt(e)} refused, ${fmt(stale)} is still alive. Deleting the stale version first.`);
        C.deleteEntity(stale);
        this.clientIds = this.clientIds.filter((x) => x !== stale);
        C.makeAlive(e);
      } else if (r === 1) {
        const tags = C.entityJson(e)?.tags ?? [];
        this.push('warn', `client: ${fmt(e)} was already alive${tags.includes('Spark') ? ' as a LOCAL spark' : ''}. make_alive does nothing, so the ship's components land on that entity.`);
      } else {
        this.push('cli', `client: make_alive(${fmt(e)})`);
      }
      for (const [k, v] of Object.entries(msg)) if (k !== 'id') C.setJson(e, k, v);
      if (!this.clientIds.includes(e)) this.clientIds.push(e);
    }
    for (const msg of pkt.changed) {
      const e = BigInt(msg.id as string);
      if (C.getAlive(idx(e)) === e) C.setJson(e, 'Label', msg.Label);
      this.push('cli', `client: ${fmt(e)} Label updated`);
    }
    for (const [s, x, y] of pkt.positions) {
      const e = BigInt(s);
      if (C.getAlive(idx(e)) === e) C.setJson(e, 'Position', { x, y });
    }
  }

  // ---------------- View ----------------

  private build(): void {
    this.rangeBtn = h('button', {
      type: 'button',
      class: 'net-toggle',
      onclick: () => {
        this.ranges = !this.ranges;
        this.reset();
      },
    });
    this.loseBox = h('input', { type: 'checkbox' });
    this.sEl = h('div', { class: 'net-list' });
    this.cEl = h('div', { class: 'net-list' });
    this.pendingEl = h('div', { class: 'net-pending' });
    this.logEl = h('div', { class: 'net-log' });
    const btn = (label: string, fn: () => void, cls = 'net-btn') => h('button', { type: 'button', class: cls, onclick: fn }, label);
    this.root.replaceChildren(
      h('details', { class: 'net-code' }, h('summary', {}, 'The setup both sides run (C++)'), h('pre', {}, NET_CPP)),
      h('div', { class: 'net-top' }, this.rangeBtn, btn('Reset both worlds', () => this.reset())),
      h(
        'div',
        { class: 'net-cols' },
        h(
          'div',
          { class: 'net-side' },
          h('div', { class: 'net-h' }, 'Server world'),
          h('div', { class: 'net-btns' }, btn('Spawn ship', () => this.spawnShip()), btn('Tick (move)', () => this.tick()), btn('Rename a ship', () => this.rename()), btn('Delete oldest ship', () => this.deleteShip())),
          this.sEl,
        ),
        h('div', { class: 'net-wire' }, this.pendingEl, h('label', { class: 'net-lose' }, this.loseBox, ' lose the deletes'), btn('Send update →', () => this.send(), 'net-send')),
        h('div', { class: 'net-side' }, h('div', { class: 'net-h' }, 'Client world'), h('div', { class: 'net-btns' }, btn('Spawn local spark', () => this.spawnSpark())), this.cEl),
      ),
      h('div', { class: 'net-h' }, 'What happened'),
      this.logEl,
    );
  }

  private entityCard(w: FlecsWorld, e: bigint, side: 'server' | 'client'): El | null {
    const j = w.entityJson(e);
    if (!j) return null;
    const tags = j.tags ?? [];
    const comps = j.components ?? {};
    const spark = tags.includes('Spark');
    const ship = 'Label' in comps;
    const collided = side === 'client' && spark && ship;
    const lines = Object.entries(comps).map(([k, v]) => {
      const rep = this.repl.has(k);
      return h('div', { class: `net-c ${side === 'server' && !rep ? 'local' : ''}` }, `${k}: ${JSON.stringify(v)}`, side === 'server' && !rep ? h('span', { class: 'net-note' }, ' not replicated') : null);
    });
    const kind = side === 'server' ? 'networked' : spark && !ship ? 'local' : collided ? 'collision' : 'replicated';
    return h(
      'div',
      { class: `net-ent ${kind}` },
      h('div', { class: 'net-ent-h' }, h('span', { class: 'net-id' }, fmt(e)), h('span', { class: 'net-kind' }, collided ? 'local spark + server ship!' : kind), ...tags.map((t) => h('span', { class: 'net-tag' }, t))),
      ...lines,
    );
  }

  private render(): void {
    const s = this.serverIds.map((e) => this.entityCard(this.S, e, 'server')).filter(Boolean) as El[];
    const c = this.clientIds.map((e) => this.entityCard(this.C, e, 'client')).filter(Boolean) as El[];
    this.sEl.replaceChildren(...(s.length ? s : [h('p', { class: 'net-muted' }, 'No ships.')]));
    this.cEl.replaceChildren(...(c.length ? c : [h('p', { class: 'net-muted' }, 'Nothing yet.')]));
    const live = this.serverIds.filter((e) => !this.created.has(e)).length;
    const changed = [...this.dirty].filter((e) => !this.created.has(e) && this.serverIds.includes(e)).length;
    this.pendingEl.replaceChildren(
      h('div', { class: 'net-h' }, 'Next packet'),
      h('div', {}, `${this.deleted.length} delete${this.deleted.length === 1 ? '' : 's'}`),
      h('div', {}, `${this.created.size} spawn${this.created.size === 1 ? '' : 's'} (all replicated components)`),
      h('div', {}, `${changed} changed Label${changed === 1 ? '' : 's'} (rare: only when set)`),
      h('div', {}, `${live} position${live === 1 ? '' : 's'} (frequent: every packet)`),
    );
    this.logEl.replaceChildren(...this.log.slice(-30).map((l) => h('div', { class: `net-l ${l.cls}` }, l.text)));
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
