/**
 * Feel lab: a small platformer with every "feel" setting exposed. Run and jump round a test
 * course, change one setting at a time, and watch the strip underneath to see what each one did.
 * Layout and the Concepts drawer follow the other labs.
 */
import { h } from '../lab/ui/dom';
import { Learn } from '../lab/ui/learn';
import { Camera, DT, HALF_W, HEIGHT, type Keys, type Level, PRESETS, Player, type Settings, TIGHT, type TickEvents, jumpPhysics, makeLevel } from './controller';
import { CONCEPTS, GLOSSARY, type FConcept, type FScenario } from './concepts';

const VIEW_W = 24;
const VIEW_H = 13.5;
const STRIP_TICKS = 300; // five seconds

interface Sample {
  jump: boolean;
  move: number;
  grounded: boolean;
  coyote: boolean;
  buffer: boolean;
  speed: number;
  ev: TickEvents;
}

type Num = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];

interface Slider {
  key: Num;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
}

const secs = (v: number) => (v === 0 ? 'off' : `${Math.round(v * 1000)} ms`);
const SLIDERS: Record<string, { title: string; concept: string; sliders: Slider[] }> = {
  run: {
    title: 'Run',
    concept: 'run',
    sliders: [
      { key: 'maxSpeed', label: 'Top speed', min: 3, max: 16, step: 0.5, fmt: (v) => `${v} tiles/s` },
      { key: 'accelTime', label: 'Time to top speed', min: 0, max: 1, step: 0.02, fmt: (v) => (v === 0 ? 'instant' : `${Math.round(v * 1000)} ms`) },
      { key: 'decelTime', label: 'Time to stop', min: 0, max: 1, step: 0.02, fmt: (v) => (v === 0 ? 'instant' : `${Math.round(v * 1000)} ms`) },
      { key: 'turnBoost', label: 'Turnaround boost', min: 1, max: 4, step: 0.25, fmt: (v) => (v === 1 ? 'off' : `×${v}`) },
      { key: 'airControl', label: 'Air control', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
    ],
  },
  jump: {
    title: 'Jump',
    concept: 'jump',
    sliders: [
      { key: 'jumpHeight', label: 'Jump height', min: 1, max: 6, step: 0.1, fmt: (v) => `${v.toFixed(1)} tiles` },
      { key: 'timeToApex', label: 'Time to the top', min: 0.2, max: 0.8, step: 0.02, fmt: (v) => `${Math.round(v * 1000)} ms` },
      { key: 'jumpCut', label: 'Release cuts upward speed to', min: 0, max: 1, step: 0.05, fmt: (v) => (v === 1 ? 'off (fixed height)' : `${Math.round(v * 100)}%`) },
      { key: 'fallGravity', label: 'Gravity when falling', min: 1, max: 4, step: 0.1, fmt: (v) => (v === 1 ? 'same as rising' : `×${v.toFixed(1)}`) },
      { key: 'apexHang', label: 'Gravity at the top (holding jump)', min: 0.2, max: 1, step: 0.05, fmt: (v) => (v === 1 ? 'off' : `×${v.toFixed(2)}`) },
      { key: 'maxFall', label: 'Fastest fall', min: 6, max: 60, step: 1, fmt: (v) => `${v} tiles/s` },
    ],
  },
  forgive: {
    title: 'Forgiveness',
    concept: 'coyote',
    sliders: [
      { key: 'coyoteTime', label: 'Coyote time', min: 0, max: 0.3, step: 0.01, fmt: secs },
      { key: 'jumpBuffer', label: 'Jump buffer', min: 0, max: 0.3, step: 0.01, fmt: secs },
      { key: 'cornerCorrection', label: 'Corner correction', min: 0, max: 0.6, step: 0.05, fmt: (v) => (v === 0 ? 'off' : `${v.toFixed(2)} tiles`) },
      { key: 'inputDelay', label: 'Input delay', min: 0, max: 10, step: 1, fmt: (v) => (v === 0 ? 'none' : `${v} frame${v === 1 ? '' : 's'} (${Math.round(v * 16.7)} ms)`) },
    ],
  },
  camera: {
    title: 'Camera',
    concept: 'camera',
    sliders: [
      { key: 'cameraRate', label: 'Smoothing', min: 0.5, max: 10, step: 0.5, fmt: (v) => `${v}` },
      { key: 'deadZone', label: 'Dead zone', min: 0, max: 4, step: 0.25, fmt: (v) => (v === 0 ? 'none' : `±${v} tiles`) },
      { key: 'lookAhead', label: 'Look-ahead', min: 0, max: 6, step: 0.5, fmt: (v) => (v === 0 ? 'none' : `${v} tiles`) },
    ],
  },
};

export class FeelApp {
  private level: Level = makeLevel();
  private s: Settings = { ...TIGHT };
  private p: Player;
  private cam: Camera;
  private prev = { x: 0, y: 0, cx: 0, cy: 0 };
  private keys: Keys = { left: false, right: false, jump: false };
  private touch: Keys = { left: false, right: false, jump: false };
  /** Keys pressed since the last tick, so a tap shorter than a tick still counts. */
  private latched: Keys = { left: false, right: false, jump: false };
  private samples: Sample[] = [];
  private trail: Array<{ x: number; y: number }> = [];
  private counts = { jumps: 0, coyote: 0, buffered: 0, eaten: 0, corner: 0, cut: 0 };
  private paused = false;
  private time = 0;
  private acc = 0;
  private last = 0;
  private showTrail = true;
  private showCamera = false;
  private cnv: HTMLCanvasElement;
  private strip: HTMLCanvasElement;
  private statsEl: HTMLElement;
  private side: HTMLElement;
  private learn: Learn<FConcept>;
  private controls = new Map<string, (v: Settings) => void>();
  private presetSeg!: HTMLElement;
  private pauseBtn!: HTMLButtonElement;
  private cols: Record<string, string> = {};

  constructor(root: HTMLElement) {
    this.p = new Player(this.level, this.s);
    this.cam = new Camera(this.p, VIEW_W, VIEW_H);
    this.cnv = h('canvas', { class: 'feel-view', width: '960', height: '540', tabindex: '0', 'aria-label': 'The platformer: arrow keys or A and D to run, Space, Z or W to jump' }) as HTMLCanvasElement;
    this.strip = h('canvas', { class: 'feel-strip', width: '960', height: '190', 'aria-label': 'The last five seconds of input and state' }) as HTMLCanvasElement;
    this.statsEl = h('div', { class: 'stats feel-stats' });
    this.side = h('aside', { class: 'side' });
    const pad = (label: string, k: keyof Keys) =>
      h(
        'button',
        {
          type: 'button',
          class: 'feel-pad',
          onpointerdown: ((e: PointerEvent) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            this.touch[k] = true;
            this.latched[k] = true;
          }) as EventListener,
          onpointerup: () => (this.touch[k] = false),
          onpointercancel: () => (this.touch[k] = false),
        },
        label,
      );
    this.pauseBtn = h('button', { type: 'button', onclick: () => this.togglePause() }, 'Pause') as HTMLButtonElement;
    const spots = h(
      'div',
      { class: 'row feel-spots' },
      h('span', { class: 'feel-l' }, 'Go to'),
      ...Object.entries(this.level.spots).map(([id, sp]) => h('button', { type: 'button', onclick: () => this.goTo(id) }, sp.label.replace(/^the /, ''))),
      this.pauseBtn,
    );
    const lane = h(
      'section',
      { class: 'lane' },
      spots,
      h('div', { class: 'map-wrap' }, this.cnv),
      h('div', { class: 'feel-pads' }, pad('◀', 'left'), pad('▶', 'right'), pad('Jump', 'jump')),
      this.strip,
      this.statsEl,
      h('p', { class: 'feel-hint' }, 'Arrow keys or A and D to run; Space, Z, W or Up to jump; P to pause and look at the strip. Change one setting at a time, and use “Go to” to jump to the part of the course that tests it.'),
    );
    root.replaceChildren(h('div', { class: 'app' }, this.side, h('main', { class: 'stage' }, lane)));
    this.learn = new Learn<FConcept>((_c, t) => this.apply(t.scenario), {
      concepts: CONCEPTS,
      glossary: GLOSSARY,
      intro: 'What each group of settings does, why players feel it when it’s missing, and what you need to build to get it in any engine. “Try it” sets the lab up to show the idea.',
    });
    this.buildSide();
    // Draw the strip at the size it's shown, so its labels stay readable on a phone.
    new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      this.strip.width = Math.round(this.strip.clientWidth * dpr);
      this.strip.height = Math.round(190 * dpr);
    }).observe(this.strip);
    for (const f of this.controls.values()) f(this.s);
    this.stats();
    this.bindKeys();
    new MutationObserver(() => (this.cols = {})).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  // ----------------------------------------------------------------- settings panel

  private buildSide(): void {
    const presetBtns = Object.entries(PRESETS).map(([id, pr]) =>
      h('button', { type: 'button', 'aria-pressed': String(id === 'tight'), onclick: () => this.setPreset(id) }, pr.label),
    );
    this.presetSeg = h('div', { class: 'seg' }, ...presetBtns);
    this.side.append(
      h('div', { class: 'sec' }, h('h2', {}, 'Presets'), this.presetSeg, h('p', { class: 'feel-note' }, 'Start from one, then change one setting at a time. “Everything off” is a box with gravity: instant speed, a fixed jump, no forgiveness, a locked camera.')),
    );
    for (const [id, grp] of Object.entries(SLIDERS)) {
      const sec = h('div', { class: 'sec' }, h('div', { class: 'feel-h' }, h('h2', {}, grp.title), h('button', { type: 'button', class: 'cx-link', onclick: () => this.learn.open(grp.concept) }, 'Concept →')));
      if (id === 'jump') sec.append(this.derived());
      if (id === 'camera') {
        const seg = h(
          'div',
          { class: 'seg' },
          ...(['locked', 'lerp', 'spring'] as const).map((m) =>
            h('button', { type: 'button', 'data-cam': m, 'aria-pressed': String(this.s.camera === m), onclick: () => this.set({ camera: m }) }, m === 'locked' ? 'Locked on' : m === 'lerp' ? 'Lerp' : 'Spring'),
          ),
        );
        sec.append(seg);
        this.controls.set('camera', (s) => seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cam === s.camera))));
      }
      for (const sl of grp.sliders) sec.append(this.slider(sl));
      if (id === 'camera') {
        sec.append(this.check('Follow height only on landing', 'platformSnap'));
        sec.append(h('label', { class: 'feel-chk' }, this.box(this.showCamera, (v) => (this.showCamera = v)), ' Show the camera’s target and dead zone'));
      }
      this.side.append(sec);
    }
    const juice = h(
      'div',
      { class: 'sec' },
      h('div', { class: 'feel-h' }, h('h2', {}, 'Juice'), h('button', { type: 'button', class: 'cx-link', onclick: () => this.learn.open('juice') }, 'Concept →')),
      this.check('Squash and stretch', 'squash'),
      this.check('Screen shake on hard landings', 'shake'),
      h('label', { class: 'feel-chk' }, this.box(this.showTrail, (v) => (this.showTrail = v)), ' Show the path of the last jump'),
    );
    this.side.append(juice);
  }

  private derivedEl = h('p', { class: 'feel-note' });
  private derived(): HTMLElement {
    this.controls.set('derived', (s) => {
      const { gravity, takeOff } = jumpPhysics(s);
      this.derivedEl.textContent = `From these: gravity ${gravity.toFixed(1)} tiles/s², take-off speed ${takeOff.toFixed(1)} tiles/s.`;
    });
    return this.derivedEl;
  }

  private box(on: boolean, change: (v: boolean) => void): HTMLInputElement {
    const i = h('input', { type: 'checkbox', onchange: (e: Event) => change((e.target as HTMLInputElement).checked) }) as HTMLInputElement;
    i.checked = on;
    return i;
  }

  private check(label: string, key: 'platformSnap' | 'squash' | 'shake'): HTMLElement {
    const i = this.box(this.s[key], (v) => this.set({ [key]: v } as Partial<Settings>));
    this.controls.set(key, (s) => (i.checked = s[key]));
    return h('label', { class: 'feel-chk' }, i, ` ${label}`);
  }

  private slider(sl: Slider): HTMLElement {
    const val = h('span', { class: 'feel-v' });
    const input = h('input', {
      type: 'range',
      min: String(sl.min),
      max: String(sl.max),
      step: String(sl.step),
      oninput: (e: Event) => this.set({ [sl.key]: Number((e.target as HTMLInputElement).value) } as Partial<Settings>),
    }) as HTMLInputElement;
    this.controls.set(sl.key, (s) => {
      input.value = String(s[sl.key]);
      val.textContent = sl.fmt(s[sl.key]);
    });
    return h('label', { class: 'feel-slider' }, h('span', { class: 'feel-row' }, h('span', {}, sl.label), val), input);
  }

  private set(part: Partial<Settings>, preset?: string): void {
    Object.assign(this.s, part);
    for (const f of this.controls.values()) f(this.s);
    // Which preset (if any) do the settings now match?
    const match = preset ?? Object.entries(PRESETS).find(([, pr]) => (Object.keys(pr.s) as Array<keyof Settings>).every((k) => pr.s[k] === this.s[k]))?.[0];
    this.presetSeg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(Object.keys(PRESETS)[i] === match)));
  }

  private setPreset(id: string): void {
    this.set({ ...PRESETS[id].s }, id);
  }

  // ----------------------------------------------------------------- scenarios

  private apply(sc: FScenario): void {
    if (sc.preset) this.setPreset(sc.preset);
    if (sc.set) this.set(sc.set);
    if (sc.spot) this.goTo(sc.spot);
    if (this.paused) this.togglePause();
    this.cnv.focus();
  }

  private goTo(id: string): void {
    const sp = this.level.spots[id];
    this.p.teleport(sp.x, sp.y - 0.01);
    this.cam = new Camera(this.p, VIEW_W, VIEW_H);
    this.trail = [];
    this.cnv.focus();
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.pauseBtn.textContent = this.paused ? 'Resume' : 'Pause';
  }

  // ----------------------------------------------------------------- input

  private bindKeys(): void {
    const map: Record<string, keyof Keys> = { ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right', ' ': 'jump', z: 'jump', Z: 'jump', w: 'jump', W: 'jump', ArrowUp: 'jump', k: 'jump', K: 'jump' };
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      return t && (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox') || t?.tagName === 'SELECT' || t?.tagName === 'TEXTAREA';
    };
    window.addEventListener('keydown', (e) => {
      if (typing(e)) return;
      if (e.key === 'p' || e.key === 'P') {
        this.togglePause();
        return;
      }
      const k = map[e.key];
      if (!k) return;
      // Range sliders also take arrow keys; let the game have them unless a slider is focused.
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && (e.key.startsWith('Arrow'))) return;
      e.preventDefault();
      if (!e.repeat) this.latched[k] = true;
      this.keys[k] = true;
    });
    window.addEventListener('keyup', (e) => {
      const k = map[e.key];
      if (k) this.keys[k] = false;
    });
    window.addEventListener('blur', () => (this.keys = { left: false, right: false, jump: false }));
  }

  // ----------------------------------------------------------------- loop

  private frame = (t: number) => {
    const dt = Math.min(t - this.last, 100) / 1000;
    this.last = t;
    if (!this.paused) {
      this.acc += dt;
      while (this.acc >= DT) {
        this.tick();
        this.acc -= DT;
      }
    }
    this.draw(this.paused ? 1 : this.acc / DT);
    requestAnimationFrame(this.frame);
  };

  private tick(): void {
    const p = this.p;
    this.prev = { x: p.x, y: p.y, cx: this.cam.x, cy: this.cam.y };
    const held = (key: keyof Keys) => this.keys[key] || this.touch[key] || this.latched[key];
    const k: Keys = { left: held('left'), right: held('right'), jump: held('jump') };
    this.latched = { left: false, right: false, jump: false };
    const ev = p.step(k);
    this.cam.step(p, this.s, this.level);
    this.time += DT;
    if (ev.jumped) {
      this.counts.jumps++;
      if (ev.jumped === 'coyote') this.counts.coyote++;
      if (ev.jumped === 'buffered') this.counts.buffered++;
      this.trail = [];
    }
    if (ev.eaten) this.counts.eaten++;
    if (ev.cornered) this.counts.corner++;
    if (ev.cut) this.counts.cut++;
    if (ev.landed && this.s.shake && ev.landed > 14) this.cam.trauma = Math.min(1, this.cam.trauma + (ev.landed - 14) / 14);
    if (!p.grounded || ev.landed) {
      this.trail.push({ x: p.x, y: p.y });
      if (this.trail.length > 240) this.trail.shift();
    }
    this.samples.push({
      jump: k.jump,
      move: (k.right ? 1 : 0) - (k.left ? 1 : 0),
      grounded: p.grounded,
      coyote: !p.grounded && !p.jumpedThisAir && p.airTime <= this.s.coyoteTime && this.s.coyoteTime > 0,
      buffer: p.sincePress !== Infinity && p.sincePress > 0,
      speed: Math.abs(p.vx) / this.s.maxSpeed,
      ev,
    });
    if (this.samples.length > STRIP_TICKS) this.samples.shift();
    if (Math.round(this.time * HZ_STATS) % 6 === 0) this.stats();
  }

  private stats(): void {
    const c = this.counts;
    const item = (v: number, l: string) => h('span', { class: 'stat' }, h('span', { class: 'v' }, String(v)), h('span', { class: 'k' }, l));
    this.statsEl.replaceChildren(item(c.jumps, 'jumps'), item(c.coyote, 'saved by coyote time'), item(c.buffered, 'from the buffer'), item(c.corner, 'corner corrections'), item(c.cut, 'cut short'), item(c.eaten, 'presses eaten'));
  }

  // ----------------------------------------------------------------- drawing

  private col(token: string): string {
    return (this.cols[token] ??= getComputedStyle(this.cnv).getPropertyValue(token).trim() || '#888');
  }

  private draw(alpha: number): void {
    const ctx = this.cnv.getContext('2d')!;
    const W = this.cnv.width;
    const H = this.cnv.height;
    const k = W / VIEW_W;
    const p = this.p;
    const lerp = (a: number, b: number) => a + (b - a) * alpha;
    const shake = this.s.shake ? this.cam.shake(this.time) : { x: 0, y: 0 };
    const cx = lerp(this.prev.cx, this.cam.x) + shake.x;
    const cy = lerp(this.prev.cy, this.cam.y) + shake.y;
    const sx = (x: number) => (x - cx + VIEW_W / 2) * k;
    const sy = (y: number) => (y - cy + VIEW_H / 2) * k;
    ctx.fillStyle = this.col('--bg');
    ctx.fillRect(0, 0, W, H);
    // Tiles in view.
    const L = this.level;
    ctx.fillStyle = this.col('--line');
    for (let ty = Math.max(0, Math.floor(cy - VIEW_H / 2)); ty <= Math.min(L.h - 1, Math.ceil(cy + VIEW_H / 2)); ty++)
      for (let tx = Math.max(0, Math.floor(cx - VIEW_W / 2)); tx <= Math.min(L.w - 1, Math.ceil(cx + VIEW_W / 2)); tx++)
        if (L.solid[ty * L.w + tx]) ctx.fillRect(Math.floor(sx(tx)), Math.floor(sy(ty)), Math.ceil(k) + 1, Math.ceil(k) + 1);
    // Path of the last jump.
    if (this.showTrail && this.trail.length > 1) {
      ctx.strokeStyle = this.col('--c2');
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      this.trail.forEach((q, i) => (i ? ctx.lineTo(sx(q.x), sy(q.y - HEIGHT / 2)) : ctx.moveTo(sx(q.x), sy(q.y - HEIGHT / 2))));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    // Camera target and dead zone.
    if (this.showCamera) {
      ctx.strokeStyle = this.col('--c5');
      ctx.lineWidth = 1.5;
      const dz = this.s.deadZone;
      ctx.strokeRect(sx(this.cam.x - dz), sy(this.cam.y - VIEW_H / 2 + 0.5), dz * 2 * k || 1, (VIEW_H - 1) * k);
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    // The player, squashed or stretched about its feet.
    const px = lerp(this.prev.x, p.x);
    const py = lerp(this.prev.y, p.y);
    const st = this.s.squash ? p.stretch : 1;
    const bw = HALF_W * 2 * k / Math.sqrt(st);
    const bh = HEIGHT * k * st;
    ctx.fillStyle = this.col('--c1');
    ctx.fillRect(sx(px) - bw / 2, sy(py) - bh, bw, bh);
    // Eyes, looking where it's facing.
    ctx.fillStyle = this.col('--bg');
    const ex = sx(px) + p.facing * bw * 0.18;
    const ey = sy(py) - bh * 0.72;
    for (const o of [-0.12, 0.12]) ctx.fillRect(ex + o * bw - 2, ey - 3, 4, 6);
    if (this.paused) {
      ctx.fillStyle = this.col('--muted');
      ctx.font = '16px sans-serif';
      ctx.fillText('Paused: press P to resume', 12, 24);
    }
    this.drawStrip();
  }

  private drawStrip(): void {
    const ctx = this.strip.getContext('2d')!;
    const dpr = this.strip.width / (this.strip.clientWidth || this.strip.width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.strip.width / dpr;
    const H = this.strip.height / dpr;
    ctx.fillStyle = this.col('--bg');
    ctx.fillRect(0, 0, W, H);
    const left = W < 500 ? 96 : 120;
    const bw = (W - left - 8) / STRIP_TICKS;
    const rows: Array<[string, (s: Sample) => boolean, string]> = [
      ['jump key', (s) => s.jump, '--c1'],
      ['on the ground', (s) => s.grounded, '--c3'],
      ['coyote window', (s) => s.coyote, '--c4'],
      ['press buffered', (s) => s.buffer, '--c5'],
    ];
    ctx.font = '12px sans-serif';
    ctx.textBaseline = 'middle';
    const n = this.samples.length;
    const x0 = left + (STRIP_TICKS - n) * bw;
    rows.forEach(([label, f, colour], r) => {
      const y = 12 + r * 24;
      ctx.fillStyle = this.col('--muted');
      ctx.fillText(label, 8, y + 8);
      ctx.fillStyle = this.col('--line-soft') || this.col('--line');
      ctx.fillRect(left, y + 7, W - left - 8, 2);
      ctx.fillStyle = this.col(colour);
      for (let i = 0; i < n; i++) if (f(this.samples[i])) ctx.fillRect(x0 + i * bw, y, bw + 0.5, 16);
    });
    // Events: jumps (with how they happened), eaten presses, corner corrections.
    const ey = 12 + rows.length * 24 + 8;
    ctx.fillStyle = this.col('--muted');
    ctx.fillText('events', 8, ey);
    for (let i = 0; i < n; i++) {
      const e = this.samples[i].ev;
      const x = x0 + i * bw;
      const mark = (txt: string, colour: string) => {
        ctx.fillStyle = this.col(colour);
        ctx.fillText(txt, x - 3, ey);
      };
      if (e.jumped === 'coyote') mark('coyote', '--c4');
      else if (e.jumped === 'buffered') mark('buffer', '--c5');
      else if (e.jumped) mark('jump', '--ink');
      if (e.eaten) mark('✕ eaten', '--alert');
      if (e.cornered) mark('◆ corner', '--c2');
    }
    // Speed as a line.
    const sy0 = H - 10;
    const sh = 40;
    ctx.fillStyle = this.col('--muted');
    ctx.fillText('run speed', 8, sy0 - sh / 2);
    ctx.strokeStyle = this.col('--line');
    ctx.beginPath();
    ctx.moveTo(left, sy0);
    ctx.lineTo(W - 8, sy0);
    ctx.moveTo(left, sy0 - sh);
    ctx.lineTo(W - 8, sy0 - sh);
    ctx.stroke();
    ctx.strokeStyle = this.col('--c2');
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const y = sy0 - Math.min(1, this.samples[i].speed) * sh;
      if (i) ctx.lineTo(x0 + i * bw, y);
      else ctx.moveTo(x0, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.textBaseline = 'alphabetic';
  }
}

const HZ_STATS = 60;
