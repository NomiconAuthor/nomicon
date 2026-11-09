/**
 * "Culling": CullViz walks a camera through a city. Left, the city from above with every
 * building coloured by what culling decided; right, the camera's view drawn by the GPU with only
 * the buildings that survived (at their level of detail). Toggles for frustum culling (spheres or
 * boxes), occlusion culling (HZB from occluders, HZB from last frame, two-phase, occlusion
 * queries) and LOD. The counts come from the CPU model (scenes/culling.ts), which the claims pin.
 */
import '../gpu/gpu.css';
import './engine-side.css';
import { h, seg } from '../../engine/dom';
import { type CityColours, type CityRenderer, TONES, createCity } from '../gpu/culling';
import { GpuCanvas, backendLine, planReadout } from '../gpu/widget';
import { type V3, basis } from '../raster';
import {
  CULL_DEFAULTS,
  type CullSettings,
  CullModel,
  FRUSTUM_LABEL,
  type FrustumMode,
  OCCLUSION_LABEL,
  type OcclusionMode,
  TURN_FRAMES,
  TURN_START,
  WALK_FRAMES,
  cullRecords,
  walk,
  walkCam,
} from '../scenes/culling';
import { Palette, btn, canvas, chk, ctx2d, fit, frame, onTheme, rgbCss, mix, size, stat } from '../view';
import { apiSwitch, rgb255 } from './engine-side';

const TONE_TOKENS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'];
const LOD_TOKENS = ['--c2', '--c4', '--c7'];
/** Map half-width in metres. */
const HALF = 150;

const SAY: Record<OcclusionMode, string> = {
  off: 'No occlusion culling: everything in the frustum is drawn, including all the buildings hidden behind the first row.',
  occluders: "This frame's big buildings (30 m and taller) are drawn into a small depth buffer first; its HZB rejects whatever is behind them. Conservative: it never removes a visible building.",
  last: "Last frame's depth, tested with last frame's camera: \"was it hidden last frame?\" Free, because the depth already exists, but a building that has just come into view is culled for one frame.",
  'two-phase': "Phase 1 draws what last frame's HZB passes; phase 2 builds an HZB from that and retests only what phase 1 culled. Newly revealed buildings are drawn in phase 2, in the same frame.",
  queries: "An occlusion query per building, answered a frame late: draw it if last frame's query saw any of its pixels. Per-pixel exact, so it culls more than the HZB, but a building coming into view is missing for a frame.",
};

export class CullViz {
  private s: CullSettings = { ...CULL_DEFAULTS };
  private k = 10;
  private byLod = false;
  private model = new CullModel();
  private pal: Palette;
  private top = canvas(360, 360, 'The city from above: buildings coloured by what culling decided, and the camera\'s frustum');
  private gpu: GpuCanvas;
  private renderer: CityRenderer | null = null;
  private api: HTMLElement & { refresh: () => void };
  private backend = h('div', { class: 'll-row' });
  private counts = h('div', { class: 'll-stats' });
  private gpuStats = h('div', { class: 'll-stats' });
  private frameLabel = h('output', {});
  private slider: HTMLInputElement;
  private say = h('p', { class: 'rd-say' });
  private status = h('p', { class: 'rd-gpu-status' });
  private playing = 0;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-gpu rd-cull');
    this.pal = new Palette(root);
    this.gpu = new GpuCanvas({
      w: 640,
      h: 360,
      label: "The camera's view, drawn by the GPU: only the buildings that survived culling",
      build: async (ctx) => {
        this.renderer = await createCity(ctx, null);
      },
      teardown: () => {
        this.renderer?.dispose();
        this.renderer = null;
      },
      draw: () => this.drawGpu(),
      onStatus: (s) => {
        this.status.textContent = s;
        this.showBackend();
      },
    });
    this.api = apiSwitch(this.gpu, () => this.showBackend());
    this.slider = h('input', { type: 'range', min: '0', max: String(WALK_FRAMES - 1), step: '1', value: String(this.k), 'aria-label': 'Frame of the walk' }) as HTMLInputElement;
    this.slider.addEventListener('input', () => this.go(Number(this.slider.value)));
    const play = btn('Play', () => {
      if (this.playing) return this.stop(play);
      if (this.k >= WALK_FRAMES - 1) this.go(0);
      play.textContent = 'Pause';
      this.playing = window.setInterval(() => (this.k >= WALK_FRAMES - 1 ? this.stop(play) : this.go(this.k + 1)), 220);
    });
    root.append(
      this.backend,
      h(
        'div',
        { class: 'll-row' },
        seg<FrustumMode>('Frustum', (['off', 'sphere', 'box'] as FrustumMode[]).map((m) => [m, FRUSTUM_LABEL[m]]), this.s.frustum, (m) => this.set({ frustum: m })).el,
        seg<OcclusionMode>('Occlusion', (Object.keys(OCCLUSION_LABEL) as OcclusionMode[]).map((m) => [m, OCCLUSION_LABEL[m]]), this.s.occlusion, (m) => this.set({ occlusion: m })).el,
      ),
      h(
        'div',
        { class: 'll-row' },
        btn('◀', () => this.go(Math.max(0, this.k - 1))),
        play,
        btn('▶', () => this.go(Math.min(WALK_FRAMES - 1, this.k + 1))),
        h('label', { class: 'rd-slider' }, this.slider, this.frameLabel),
        chk('Levels of detail', this.s.lod, (on) => this.set({ lod: on })),
        chk('Colour by level', false, (on) => ((this.byLod = on), this.draw())),
      ),
      h(
        'div',
        { class: 'rd-fig rd-cullpair' },
        h('div', {}, h('div', { class: 'll-h' }, 'From above'), this.top),
        h('div', {}, h('div', { class: 'rd-cull-h' }, h('span', { class: 'll-h' }, 'The camera, on the GPU'), this.gpuStats), this.gpu.el),
      ),
      this.counts,
      this.say,
      this.status,
    );
    fit(this.top, () => this.drawTop());
    onTheme(() => {
      this.pal.reset();
      this.draw();
    });
    void this.gpu.start().then(() => {
      this.api.refresh();
      this.showBackend();
      this.draw();
    });
    this.draw();
  }

  /** A count that is also the map's colour key: its swatch before the number. */
  private keyed(n: number | string, label: string, token: string, outline = false, bad = false): HTMLElement {
    const sw = h('i', { class: 'rd-key', style: outline ? `border: 2px solid var(${token}); background: none` : `background: var(${token})` });
    return h('span', { class: `ll-stat${bad ? ' rd-bad' : ''}` }, sw, h('b', {}, String(n)), h('span', {}, label));
  }

  private stop(b: HTMLButtonElement): void {
    clearInterval(this.playing);
    this.playing = 0;
    b.textContent = 'Play';
  }
  private set(p: Partial<CullSettings>): void {
    this.s = { ...this.s, ...p };
    this.draw();
  }
  private go(k: number): void {
    this.k = k;
    this.slider.value = String(k);
    this.draw();
  }

  private showBackend(): void {
    this.backend.replaceChildren(this.api, h('span', {}, h('span', { class: 'll-muted' }, 'Camera view: '), ...backendLine(this.gpu)));
  }

  private draw(): void {
    const k = this.k;
    this.frameLabel.textContent = `frame ${k}: ${k <= TURN_START ? 'walking north' : k <= TURN_START + TURN_FRAMES ? 'turning the corner' : 'walking east'}`;
    const c = this.model.counts(k, this.s);
    const visible = this.model.truth(k).visible.filter(Boolean).length;
    this.counts.replaceChildren(
      stat(c.total, 'buildings'),
      stat(this.s.frustum === 'off' ? 0 : c.total, 'frustum tests'),
      this.keyed(c.frustumCulled, 'outside the frustum', '--line'),
      stat(c.occlusionTests, this.s.occlusion === 'queries' ? 'queries' : 'occlusion tests'),
      this.keyed(c.occluded, 'occlusion-culled', '--muted'),
      this.keyed(c.drawn, 'drawn', '--c2'),
      stat(c.triangles.toLocaleString('en-US'), 'triangles'),
      this.keyed(visible, 'really visible', '--ink', true),
      stat(c.wasted, 'drawn but hidden'),
      this.keyed(c.missed, 'visible but culled', '--alert', false, c.missed > 0),
    );
    this.say.textContent = SAY[this.s.occlusion] + (this.s.occlusion === 'two-phase' && c.phase1 ? ` This frame: ${c.phase1} in phase 1, ${c.drawn - c.phase1} more in phase 2.` : '');
    this.drawTop();
    this.drawGpu();
  }

  private drawTop(): void {
    const ctx = ctx2d(this.top);
    const { w, h: hh } = size(this.top);
    const f = this.model.frame(this.k, this.s);
    const bg = this.pal.rgb('--bg');
    ctx.fillStyle = rgbCss(bg);
    ctx.fillRect(0, 0, w, hh);
    const X = (x: number) => ((x + HALF) / (2 * HALF)) * w;
    const Z = (z: number) => ((z + HALF) / (2 * HALF)) * hh;
    const col: Record<string, string> = {
      drawn: this.pal.css('--c2'),
      occluded: rgbCss(mix(bg, this.pal.rgb('--muted'), 0.75)),
      frustum: rgbCss(mix(bg, this.pal.rgb('--line'), 0.9)),
    };
    const alert = this.pal.css('--alert');
    for (const b of this.model.buildings) {
      const st = f.status[b.id];
      ctx.fillStyle = st !== 'drawn' && f.visible[b.id] ? alert : col[st];
      ctx.fillRect(X(b.min.x), Z(b.min.z), X(b.max.x) - X(b.min.x), Z(b.max.z) - Z(b.min.z));
      if (f.visible[b.id]) {
        ctx.strokeStyle = this.pal.css('--ink');
        ctx.lineWidth = 1.2;
        ctx.strokeRect(X(b.min.x), Z(b.min.z), X(b.max.x) - X(b.min.x), Z(b.max.z) - Z(b.min.z));
      }
      if (this.s.occlusion === 'occluders' && b.occluder && st !== 'frustum') {
        ctx.fillStyle = rgbCss(bg, 0.55);
        const cx = (X(b.min.x) + X(b.max.x)) / 2;
        const cz = (Z(b.min.z) + Z(b.max.z)) / 2;
        ctx.beginPath();
        ctx.arc(cx, cz, 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // The walk, the eye and the frustum's sides.
    ctx.strokeStyle = this.pal.css('--muted');
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (let i = 0; i < WALK_FRAMES; i++) {
      const p = walk(i).eye;
      if (i) ctx.lineTo(X(p.x), Z(p.z));
      else ctx.moveTo(X(p.x), Z(p.z));
    }
    ctx.stroke();
    ctx.setLineDash([]);
    const cam = walkCam(this.k);
    const b = basis(cam);
    const t = cam.aspect / cam.focal;
    const ray = (s: number): V3 => ({ x: b.fwd.x + b.right.x * s * t, y: 0, z: b.fwd.z + b.right.z * s * t });
    ctx.strokeStyle = this.pal.css('--accent');
    ctx.lineWidth = 1.5;
    {
      ctx.fillStyle = rgbCss(this.pal.rgb('--accent'), 0.08);
      ctx.beginPath();
      const e = cam.eye;
      const L = ray(-1);
      const R = ray(1);
      ctx.moveTo(X(e.x), Z(e.z));
      ctx.lineTo(X(e.x + L.x * 400), Z(e.z + L.z * 400));
      ctx.lineTo(X(e.x + R.x * 400), Z(e.z + R.z * 400));
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(X(e.x + L.x * 400), Z(e.z + L.z * 400));
      ctx.lineTo(X(e.x), Z(e.z));
      ctx.lineTo(X(e.x + R.x * 400), Z(e.z + R.z * 400));
      ctx.stroke();
    }
    ctx.fillStyle = this.pal.css('--accent');
    ctx.beginPath();
    ctx.arc(X(cam.eye.x), Z(cam.eye.z), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  private colours(): CityColours {
    const tones = (this.byLod ? LOD_TOKENS : TONE_TOKENS).map((t) => rgb255(this.pal, t));
    while (tones.length < TONES - 1) tones.push(tones[0]);
    const bg = this.pal.rgb('--bg');
    const ground = mix(bg, this.pal.rgb('--muted'), 0.35).map((x) => Math.round(x)) as [number, number, number];
    return { bg: rgb255(this.pal, '--bg'), tones: [...tones, ground] };
  }

  private drawGpu(): void {
    const r = this.renderer;
    if (!r) return;
    const f = this.model.frame(this.k, this.s);
    const cam = walkCam(this.k, this.gpu.canvas.width / this.gpu.canvas.height);
    const plan = r.frame(cam, cullRecords(this.model.buildings, f, this.byLod), this.colours());
    this.gpuStats.replaceChildren(...planReadout(plan));
  }
}
