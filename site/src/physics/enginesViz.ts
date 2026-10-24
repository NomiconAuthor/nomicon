/** Jolt and Box3D, side by side on the same scene, both running for real in the page. */
import { h, seg } from '../engine/dom';
import { Box3DEngine, BulletEngine, type Engine3D, JoltEngine, SCENES, type Scene3D } from './engines';
import { Renderer3D } from './render3d';

interface Lane {
  e: Engine3D;
  canvas: HTMLCanvasElement;
  r: Renderer3D;
  stats: HTMLElement;
  xf: Float32Array;
  n: number;
  ms: number[];
}

export class EnginesViz {
  private root: HTMLElement;
  private lanes: Lane[] = [];
  private scene: Scene3D = SCENES.pyramid();
  private sceneId = 'pyramid';
  private playing = true;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private visible = false;
  private time = 0;
  private status = h('p', { class: 'll-muted' }, 'Loading Jolt (about 3 MB), Box3D and Bullet (about 0.4 MB each)…');
  private playBtn!: HTMLButtonElement;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll ph ph-engines' });
    host.replaceChildren(this.root);
    this.root.append(this.status);
    void this.start();
  }

  private async start(): Promise<void> {
    const jolt = new JoltEngine(async () => {
      const [{ default: init }, { default: url }] = await Promise.all([import('jolt-physics/wasm'), import('jolt-physics/jolt-physics.wasm.wasm?url')]);
      return init({ locateFile: () => url });
    });
    const box3d = new Box3DEngine('/box3d.wasm');
    const bullet = new BulletEngine('/bullet.wasm');
    try {
      await Promise.all([jolt.load(), box3d.load(), bullet.load()]);
    } catch (e) {
      this.status.textContent = `Couldn't load the engines: ${(e as Error).message}`;
      return;
    }
    const mk = (e: Engine3D): Lane => {
      const canvas = h('canvas', { class: 'ph-canvas', width: '720', height: '540', 'aria-label': `${e.name} simulation` });
      return { e, canvas, r: new Renderer3D(canvas), stats: h('div', { class: 'll-stats' }), xf: new Float32Array(4096 * 8), n: 0, ms: [] };
    };
    this.lanes = [mk(jolt), mk(box3d), mk(bullet)];
    this.playBtn = h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.toggle() }, 'Pause') as HTMLButtonElement;
    const sceneSeg = seg<string>(
      'Scene',
      [
        ['pyramid', 'Pyramid'],
        ['tower', 'Tower of 20'],
        ['wall', 'Wall and ball'],
        ['pile', 'Pile of 200'],
        ['fastball', 'Fast ball'],
      ],
      this.sceneId,
      (id) => {
        this.sceneId = id;
        this.reset();
      },
    );
    const opt = (label: string, lane: number, key: 'substeps' | 'velocitySteps', values: number[], cur: number) =>
      seg<string>(label, values.map((v) => [String(v), String(v)] as [string, string]), String(cur), (v) => {
        this.lanes[lane].e.options[key] = Number(v);
        this.reset();
      }).el;
    const flag = (label: string, lane: number, key: 'linearCast' | 'continuous', on: boolean) => {
      const i = h('input', {
        type: 'checkbox',
        onchange: (ev: Event) => {
          this.lanes[lane].e.options[key] = (ev.target as HTMLInputElement).checked;
          this.reset();
        },
      }) as HTMLInputElement;
      i.checked = on;
      return h('label', { class: 'll-chk' }, i, ` ${label}`);
    };
    this.status.textContent = '';
    this.root.replaceChildren(
      sceneSeg.el,
      h(
        'div',
        { class: 'll-row' },
        this.playBtn,
        h('button', { type: 'button', class: 'll-btn', onclick: () => ((this.playing = false), (this.playBtn.textContent = 'Play'), this.stepAll()) }, 'Step'),
        h('button', { type: 'button', class: 'll-btn', onclick: () => this.reset() }, 'Reset'),
      ),
      h(
        'div',
        { class: 'ph-three' },
        h(
          'div',
          { class: 'ph-lane' },
          h('div', { class: 'll-h' }, 'Jolt'),
          this.lanes[0].canvas,
          this.lanes[0].stats,
          opt('Velocity steps', 0, 'velocitySteps', [4, 10, 30], 10),
          opt('Collision steps', 0, 'substeps', [1, 2], 1),
          flag('LinearCast for fast bodies', 0, 'linearCast', false),
        ),
        h(
          'div',
          { class: 'ph-lane' },
          h('div', { class: 'll-h' }, 'Box3D'),
          this.lanes[1].canvas,
          this.lanes[1].stats,
          opt('Substeps', 1, 'substeps', [1, 2, 4, 8], 4),
          flag('Continuous collision', 1, 'continuous', true),
        ),
        h(
          'div',
          { class: 'ph-lane' },
          h('div', { class: 'll-h' }, 'Bullet'),
          this.lanes[2].canvas,
          this.lanes[2].stats,
          opt('Solver iterations', 2, 'velocitySteps', [4, 10, 30], 10),
          opt('Internal steps', 2, 'substeps', [1, 4], 1),
          flag('CCD for fast bodies', 2, 'linearCast', false),
        ),
      ),
      this.status,
    );
    this.status.textContent = 'All three run single-threaded and without SIMD on the page. The step times are measured in your browser and vary by machine: a rough guide, not a benchmark.';
    new MutationObserver(() => {
      this.lanes.forEach((l) => l.r.resetColours());
      this.draw();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    new IntersectionObserver((es) => {
      this.visible = es.some((x) => x.isIntersecting);
      if (this.visible && !this.raf) {
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.tick);
      }
    }).observe(this.root);
    this.reset();
  }

  private toggle(): void {
    this.playing = !this.playing;
    this.playBtn.textContent = this.playing ? 'Pause' : 'Play';
  }

  private reset(): void {
    this.scene = SCENES[this.sceneId]();
    this.time = 0;
    for (const l of this.lanes) {
      l.e.reset(this.scene);
      l.n = l.e.read(l.xf);
      l.ms = [];
    }
    this.draw();
  }

  private stepAll(): void {
    for (const l of this.lanes) {
      l.e.step(1 / 60);
      l.ms.push(l.e.stats().stepMs);
      if (l.ms.length > 60) l.ms.shift();
      l.n = l.e.read(l.xf);
    }
    this.time += 1 / 60;
    this.draw();
  }

  private tick = (t: number): void => {
    this.raf = 0;
    if (!this.visible) return;
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    if (this.playing) {
      this.acc += dt;
      let k = 0;
      while (this.acc >= 1 / 60 && k < 3) {
        this.stepAll();
        this.acc -= 1 / 60;
        k++;
      }
      if (k === 3) this.acc = 0;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw(): void {
    for (const l of this.lanes) {
      l.r.draw(this.scene, l.xf, l.n, `${this.time.toFixed(1)} s`);
      const s = l.e.stats();
      const avg = l.ms.length ? l.ms.reduce((a, b) => a + b, 0) / l.ms.length : 0;
      const dyn = this.scene.bodies.filter((b) => b.dynamic).length;
      l.stats.replaceChildren(
        h('span', { class: 'll-stat' }, h('b', {}, `${s.awake} / ${dyn}`), h('span', {}, 'awake')),
        h('span', { class: 'll-stat' }, h('b', {}, `${avg.toFixed(2)} ms`), h('span', {}, 'per step, here')),
      );
    }
  }
}
