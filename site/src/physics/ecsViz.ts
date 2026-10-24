/** The flecs lesson's widget: real flecs plus the teaching engine, joined by handles. */
import { h } from '../engine/dom';
import { FlecsWorld } from '../flecs/runtime';
import { PhysicsBridge } from './ecsBridge';
import { PhysicsView } from './view';

export class EcsViz {
  private root: HTMLElement;
  private bridge!: PhysicsBridge;
  private view!: PhysicsView;
  private selected = '';
  private ents = h('div', { class: 'ph-ents' });
  private logEl = h('ol', { class: 'ph-log' });
  private stats = h('div', { class: 'll-stats' });
  private raf = 0;
  private last = 0;
  private acc = 0;
  private visible = false;
  private playing = true;
  private shown = '';

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ph ph-ecs' }, h('p', { class: 'll-muted' }, 'Starting flecs…'));
    host.replaceChildren(this.root);
    void this.start();
  }

  private async start(): Promise<void> {
    let w: FlecsWorld;
    try {
      w = await FlecsWorld.create();
    } catch (e) {
      this.root.replaceChildren(h('p', { class: 'det-bad' }, `Couldn't start flecs: ${(e as Error).message}`));
      return;
    }
    this.bridge = new PhysicsBridge(w);
    this.bridge.init();
    this.view = new PhysicsView(this.bridge.engine, { view: [-8, -0.8, 8, 7], label: 'The physics world' });
    this.view.playing = false;
    this.view.interpolate = false;
    this.view.ground = this.bridge.ground;
    this.view.canvas.addEventListener('click', (e) => {
      const b = this.view.bodyAt(this.view.toWorld(e));
      const ent = b ? this.bridge.owner.get(b.handle) : undefined;
      if (ent) this.select(this.bridge.w.name(ent));
    });
    const btn = (label: string, fn: () => void, primary = false) => h('button', { type: 'button', class: `ll-btn${primary ? ' primary' : ''}`, onclick: fn }, label);
    const playBtn = btn('Pause', () => {
      this.playing = !this.playing;
      playBtn.textContent = this.playing ? 'Pause' : 'Play';
    }, true);
    const sel = (fn: (name: string) => void) => () => {
      if (this.selected && this.bridge.names.has(this.selected)) fn(this.selected);
      this.refresh();
    };
    this.root.replaceChildren(
      h(
        'div',
        { class: 'll-row' },
        playBtn,
        btn('Spawn a crate', () => (this.select(this.bridge.spawn('box', -3 + Math.random() * 6, 6, Math.random())), this.refresh())),
        btn('Spawn a ball', () => (this.select(this.bridge.spawn('ball', -3 + Math.random() * 6, 6)), this.refresh())),
        btn('Reset', () => this.reset()),
      ),
      h(
        'div',
        { class: 'll-row' },
        h('span', { class: 'll-muted' }, 'Selected entity:'),
        btn('Add Impulse', sel((n) => this.bridge.impulse(n, (Math.random() - 0.5) * 6, 6))),
        btn('Change RigidBody', sel((n) => {
          const e = this.bridge.entities().find((x) => x.name === n);
          const ball = (e?.rb?.radius ?? 0) > 0;
          this.bridge.setRigidBody(n, ball ? { hw: 0.4, hh: 0.4, radius: 0, dynamic: 1 } : { hw: 0, hh: 0, radius: 0.35, dynamic: 1 });
        })),
        btn('Remove RigidBody', sel((n) => this.bridge.removeRigidBody(n))),
        btn('Delete entity', sel((n) => this.bridge.destroy(n))),
      ),
      h('div', { class: 'ph-two' }, h('div', {}, this.view.canvas, this.stats), h('div', {}, h('div', { class: 'll-h' }, 'Entities in flecs'), this.ents)),
      h('div', { class: 'll-h' }, 'What ran (newest first)'),
      this.logEl,
    );
    this.reset();
    new IntersectionObserver((es) => {
      this.visible = es.some((x) => x.isIntersecting);
      if (this.visible && !this.raf) {
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.tick);
      }
    }).observe(this.root);
  }

  private reset(): void {
    this.bridge.w.reset();
    this.bridge.init();
    this.view.setWorld(this.bridge.engine);
    this.view.ground = this.bridge.ground;
    const b = this.bridge;
    b.spawn('box', -1, 0.4);
    b.spawn('box', 0.2, 0.4);
    b.spawn('box', -0.4, 1.2);
    this.select(b.spawn('ball', 2.5, 3));
    this.refresh();
  }

  private select(name: string): void {
    this.selected = name;
    this.refresh();
  }

  private tick = (t: number): void => {
    this.raf = 0;
    if (!this.visible) return;
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    if (this.playing) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= 1 / 60 && n < 4) {
        this.bridge.progress(1 / 60);
        this.acc -= 1 / 60;
        n++;
      }
      if (n === 4) this.acc = 0;
      if (n) this.refresh();
    }
    this.view.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  private refresh(): void {
    const b = this.bridge;
    const list = b.entities();
    const rows = list.map((e) => {
      const body = e.handle ? b.engine.get(e.handle) : null;
      const idx = e.handle ? (e.handle % 65536) - 1 : -1;
      const gen = e.handle ? Math.floor(e.handle / 65536) : 0;
      return h(
        'tr',
        { class: e.name === this.selected ? 'sel' : '', onclick: () => this.select(e.name) },
        h('td', {}, e.name),
        h('td', { class: 'mono' }, e.pos ? `${e.pos.x.toFixed(2)}, ${e.pos.y.toFixed(2)}` : '—'),
        h('td', { class: 'mono' }, e.rb ? (e.rb.radius > 0 ? `ball r ${e.rb.radius.toFixed(2)}` : `box ${(e.rb.hw * 2).toFixed(1)}×${(e.rb.hh * 2).toFixed(1)}`) : '—'),
        h('td', { class: 'mono' }, e.handle ? `0x${e.handle.toString(16)}` : '—', e.handle ? h('small', { class: 'll-muted' }, ` slot ${idx}, gen ${gen}`) : ''),
        h('td', {}, body ? (body.awake ? 'awake' : 'asleep') : e.handle ? 'stale!' : 'no body'),
      );
    });
    const key = JSON.stringify(list.map((e) => [e.name, e.handle, e.pos && [e.pos.x.toFixed(2), e.pos.y.toFixed(2)], e.rb?.radius, this.selected === e.name]));
    if (key !== this.shown) {
      this.shown = key;
      this.ents.replaceChildren(
        h(
          'div',
          { class: 'det-sums' },
          h('table', { class: 'det-table' }, h('thead', {}, h('tr', {}, ...['Entity', 'Position', 'RigidBody', 'BodyHandle', 'Body'].map((x) => h('th', {}, x)))), h('tbody', {}, ...rows)),
        ),
        h('p', { class: 'll-muted ph-note' }, 'Click a row, or a body in the picture, to select it.'),
      );
    }
    this.logEl.replaceChildren(...b.log.slice(0, 14).map((l) => h('li', { class: l.cls ?? '' }, h('b', {}, l.who), ' ', l.text)));
    const s = b.engine.stats;
    this.stats.replaceChildren(
      h('span', { class: 'll-stat' }, h('b', {}, String(b.engine.live().length - 1)), h('span', {}, 'bodies')),
      h('span', { class: 'll-stat' }, h('b', {}, String(s.sleeping)), h('span', {}, 'asleep')),
      h('span', { class: 'll-stat' }, h('b', {}, String(b.written)), h('span', {}, 'transforms copied to flecs last frame')),
    );
  }
}
