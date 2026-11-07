/**
 * The shader-execution lesson's widgets: WaveViz (a wave of 32 or 64 lanes stepping through a
 * pixel shader with a branch, with its execution mask, on a floor under a spotlight), QuadViz
 * (one square cut into ever smaller triangles, counting quads and helper lanes) and
 * OccupancyViz (registers per lane against waves per SIMD, and a toy model of hiding memory
 * latency with them).
 */
import { h, seg } from '../../engine/dom';
import { type Target, SUB } from '../raster';
import {
  CUTS,
  MEM_LATENCY,
  ALU_RUN,
  PATCH,
  PROGRAM,
  QUAD_H,
  QUAD_W,
  VGPR_GRANULE,
  VGPRS_PER_SIMD,
  WAVE_H,
  WAVE_SLOTS,
  WAVE_W,
  type Wave,
  buildWaves,
  frameWaves,
  latencyModel,
  patchMesh,
  quadCount,
  runWave,
  waveCost,
  waveScene,
  wavesPerSimd,
} from '../scenes/how-shaders-run';
import { type RGB, Palette, btn, canvas, ctx2d, fit, frame, mix, onTheme, paintTarget, rgbCss, size, stage, stat } from '../view';

const pct = (x: number) => `${Math.round(x * 100)}%`;

// =============================================================================================
// Waves and divergence

export class WaveViz {
  private size: 32 | 64 = 32;
  private waves: Wave[] = [];
  private target!: Target;
  private draws = waveScene();
  private wi = 0;
  /** How many of the wave's issued instructions have run (0: none yet). */
  private step = 0;
  private cv = canvas(672, 420, 'A floor under a spotlight, divided into waves of quads');
  private lanesCv = canvas(400, 104, 'The lanes of the selected wave', 'rd-canvas rd-lanes', { maxWidth: 400 });
  private prog = h('ol', { class: 'rd-draws', style: 'font: 12px/1.35 var(--f-mono); gap: 0' });
  private say = h('p', { class: 'rd-say' });
  private counts = h('div', { class: 'll-stats' });
  private showDiv = false;
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-wave');
    this.pal = new Palette(root);
    root.append(
      h(
        'div',
        { class: 'll-row' },
        seg<string>('Wave size', [['32', '32 lanes'], ['64', '64 lanes']], '32', (v) => ((this.size = Number(v) as 32 | 64), this.rebuild())).el,
        seg<string>('Show', [['wave', 'Selected wave'], ['div', 'Divergent waves']], 'wave', (v) => ((this.showDiv = v === 'div'), this.show())).el,
      ),
      h(
        'div',
        { class: 'll-row' },
        btn('Next instruction', () => this.next(), true),
        btn('Run the wave', () => ((this.step = runWave(this.waves[this.wi]).length), this.show())),
        btn('Previous wave', () => this.pick(this.wi - 1)),
        btn('Next wave', () => this.pick(this.wi + 1)),
        btn('Next divergent wave', () => this.pick(this.nextDivergent())),
      ),
      h('div', { class: 'll-h' }, 'Click or tap the floor to pick the wave there'),
      stage(this.cv, [this.lanesCv, h('div', { class: 'll-muted', style: 'font-size: 12px' }, 'Lanes: yellow lit, blue unlit, dashed helper, faded masked off.'), this.prog, this.say, this.counts]),
    );
    this.cv.addEventListener('click', (e) => {
      const r = this.cv.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * WAVE_W);
      const y = Math.floor(((e.clientY - r.top) / r.height) * WAVE_H);
      const i = this.waves.findIndex((w) => w.lanes.some((l) => l.x === x && l.y === y));
      if (i >= 0) this.pick(i);
    });
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    fit(this.cv, () => this.show());
    fit(this.lanesCv, () => this.drawLanes());
    this.rebuild();
  }

  private rebuild(): void {
    const b = buildWaves(this.size);
    this.waves = b.waves;
    this.target = b.target;
    // Start on a divergent wave: the interesting case.
    this.wi = Math.max(0, this.waves.findIndex((w) => waveCost(w).divergent));
    this.step = 0;
    this.show();
  }
  private nextDivergent(): number {
    for (let k = 1; k <= this.waves.length; k++) {
      const i = (this.wi + k) % this.waves.length;
      if (waveCost(this.waves[i]).divergent) return i;
    }
    return this.wi;
  }
  private pick(i: number): void {
    this.wi = (i + this.waves.length) % this.waves.length;
    this.step = 0;
    this.show();
  }
  private next(): void {
    const run = runWave(this.waves[this.wi]);
    if (this.step >= run.length) this.pick(this.wi + 1);
    else {
      this.step++;
      this.show();
    }
  }

  private show(): void {
    if (!this.target) return;
    const ctx = ctx2d(this.cv);
    const k = size(this.cv).w / WAVE_W;
    paintTarget(ctx, this.target, this.draws, this.pal, 'color', k);
    // Outline quads: the selected wave's (or every divergent wave's).
    const outline = (w: Wave, color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      for (const q of w.quads) ctx.strokeRect(q.x * k + 1, q.y * k + 1, 2 * k - 2, 2 * k - 2);
    };
    if (this.showDiv) for (const w of this.waves) if (waveCost(w).divergent) outline(w, this.pal.css('--alert'), 1.5);
    outline(this.waves[this.wi], this.pal.css('--accent'), 2.5);
    this.drawLanes();
    const w = this.waves[this.wi];
    const run = runWave(w);
    const cur = this.step > 0 ? run[this.step - 1].pc : -1;
    const issuedPcs = new Set(run.map((r) => r.pc));
    this.prog.replaceChildren(
      ...PROGRAM.map((ins, pc) => h('li', { class: pc === cur ? 'on' : '', style: `white-space: pre-wrap; padding: 1px 8px${ins.side !== 'branch' && !issuedPcs.has(pc) ? '; opacity: 0.4; text-decoration: line-through' : ''}` }, ins.text)),
    );
    const c = waveCost(w);
    const lit = w.lanes.filter((l) => l.kind !== 'empty' && l.lit).length;
    const unlit = w.lanes.filter((l) => l.kind !== 'empty' && !l.lit).length;
    const pixels = w.lanes.filter((l) => l.kind === 'pixel').length;
    this.say.textContent =
      this.step === 0
        ? `Wave ${this.wi + 1} of ${this.waves.length}: ${pixels} pixels and ${w.lanes.filter((l) => l.kind === 'helper').length} helper lanes in ${w.quads.length} quads. ${lit && unlit ? `${lit} lanes take the lit side and ${unlit} the other, so it runs both.` : lit ? 'Every lane is lit: the else side is skipped.' : 'No lane is lit: the lighting is skipped.'}`
        : this.step <= run.length
          ? `Instruction ${this.step} of ${run.length}: ${run[this.step - 1].mask.filter(Boolean).length} of ${this.size} lanes on.`
          : '';
    const f = frameWaves(this.size);
    this.counts.replaceChildren(
      stat(c.issued, 'instructions issued'),
      stat(pct(c.useful / c.slots), 'of lane slots did a pixel\'s work'),
      stat(`${f.divergent} of ${f.waves}`, 'waves in the frame diverge'),
      stat(pct(f.useful / f.slots), 'useful lane slots, whole frame'),
    );
  }

  private drawLanes(): void {
    const c = this.lanesCv;
    const ctx = ctx2d(c);
    const { w: W, h: H } = size(c);
    ctx.fillStyle = this.pal.css('--bg');
    ctx.fillRect(0, 0, W, H);
    const w = this.waves[this.wi];
    if (!w) return;
    const run = runWave(w);
    const mask = this.step > 0 ? run[this.step - 1].mask : null;
    const cols = 16;
    const rows = this.size / cols;
    const cell = W / cols;
    const top = (H - rows * cell) / 2;
    const bg = this.pal.rgb('--bg');
    const litC = this.pal.rgb('--c1');
    const darkC = this.pal.rgb('--c7');
    ctx.font = '10px sans-serif';
    w.lanes.forEach((l, i) => {
      const x = (i % cols) * cell;
      const y = top + Math.floor(i / cols) * cell;
      const on = mask ? mask[i] : l.kind !== 'empty';
      let fill: RGB = l.kind === 'empty' ? bg : l.lit ? litC : darkC;
      if (l.kind === 'helper') fill = mix(bg, fill, 0.4);
      if (!on) fill = mix(bg, fill, 0.15);
      ctx.fillStyle = rgbCss(fill);
      ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
      ctx.strokeStyle = this.pal.css(on && l.kind !== 'empty' ? '--ink' : '--line-soft');
      ctx.lineWidth = 1;
      ctx.setLineDash(l.kind === 'helper' ? [3, 2] : []);
      ctx.strokeRect(x + 2.5, y + 2.5, cell - 5, cell - 5);
      ctx.setLineDash([]);
      if (l.kind === 'empty') return;
      ctx.fillStyle = this.pal.css(on && l.kind === 'pixel' ? '--bg' : '--muted');
      ctx.fillText(l.kind === 'helper' ? 'h' : String(i), x + 5, y + cell / 2 + 4);
    });
  }
}

// =============================================================================================
// Tiny triangles and 2 × 2 quads

export class QuadViz {
  private n = 4;
  private view: 'tris' | 'heat' = 'heat';
  private cv = canvas(480, 480, 'A square cut into triangles, over a 40 × 40 pixel grid', 'rd-canvas', { maxWidth: 480 });
  private counts = h('div', { class: 'll-stats' });
  private say = h('p', { class: 'rd-say' });
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-quads');
    this.pal = new Palette(root);
    root.append(
      seg<string>('Triangles', CUTS.map((n) => [String(n), (2 * n * n).toLocaleString('en-US')] as [string, string]), String(this.n), (v) => ((this.n = Number(v)), this.show())).el,
      seg<'tris' | 'heat'>('Show', [['heat', 'Lanes run per pixel'], ['tris', 'Triangles']], this.view, (v) => ((this.view = v), this.show())).el,
      stage(this.cv, [h('div', { class: 'll-legend' }, this.legend()), this.say, this.counts]),
    );
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    fit(this.cv, () => this.show());
    this.show();
  }

  private legend(): HTMLElement {
    const item = (label: string, cls: string) => h('span', {}, h('i', { class: cls }), label);
    return h('span', { class: 'rd-heat-legend' }, item('1 lane a pixel', 'h1'), item('2', 'h2'), item('3 or more', 'h3'));
  }

  private show(): void {
    const q = quadCount(this.n);
    const ctx = ctx2d(this.cv);
    const k = size(this.cv).w / QUAD_W;
    const bg = this.pal.rgb('--bg');
    const ink = this.pal.rgb('--ink');
    const tri = [this.pal.rgb('--c2'), this.pal.rgb('--c7'), this.pal.rgb('--c5'), this.pal.rgb('--c4')];
    const warm = this.pal.rgb('--warn');
    const hot = this.pal.rgb('--alert');
    ctx.fillStyle = rgbCss(bg);
    ctx.fillRect(0, 0, QUAD_W * k, QUAD_H * k);
    for (let y = 0; y < QUAD_H; y++)
      for (let x = 0; x < QUAD_W; x++) {
        let c: RGB = bg;
        if (this.view === 'tris') {
          const t = q.triOf[y * QUAD_W + x];
          if (t >= 0) c = mix(bg, tri[(t * 7 + (t >> 3)) % 4], 0.75);
        } else {
          // Lanes run in this pixel's 2 × 2 block, per pixel of the block: quads launched there.
          const n = q.perBlock[(y >> 1) * (QUAD_W / 2) + (x >> 1)];
          c = n === 0 ? bg : n === 1 ? mix(bg, ink, 0.25) : n === 2 ? mix(bg, warm, 0.7) : mix(bg, hot, Math.min(1, 0.55 + 0.15 * (n - 3)));
        }
        ctx.fillStyle = rgbCss(c);
        ctx.fillRect(x * k, y * k, k + 0.5, k + 0.5);
      }
    // Quad grid, and the triangle edges.
    ctx.strokeStyle = this.pal.css('--line-soft');
    ctx.lineWidth = 1;
    for (let i = 0; i <= QUAD_W; i += 2) {
      ctx.beginPath();
      ctx.moveTo(i * k, 0);
      ctx.lineTo(i * k, QUAD_H * k);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * k);
      ctx.lineTo(QUAD_W * k, i * k);
      ctx.stroke();
    }
    const m = patchMesh(this.n);
    ctx.strokeStyle = this.pal.css('--ink');
    ctx.globalAlpha = this.n >= 16 ? 0.35 : 0.7;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = 0; t < m.indices.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = m.positions[m.indices[t + e]];
        const b = m.positions[m.indices[t + ((e + 1) % 3)]];
        ctx.moveTo((Math.round(a.x * SUB) / SUB) * k, (Math.round(a.y * SUB) / SUB) * k);
        ctx.lineTo((Math.round(b.x * SUB) / SUB) * k, (Math.round(b.y * SUB) / SUB) * k);
      }
    ctx.stroke();
    ctx.globalAlpha = 1;
    const per = q.pixels / q.triangles;
    this.say.textContent = `${q.triangles.toLocaleString('en-US')} triangles over the same ${PATCH.s} × ${PATCH.s} pixels, about ${per >= 10 ? Math.round(per) : per.toFixed(1)} pixels each.${q.empty ? ` ${q.empty.toLocaleString('en-US')} of them cover no pixel centre at all.` : ''}`;
    this.counts.replaceChildren(
      stat(q.pixels.toLocaleString('en-US'), 'pixels shaded'),
      stat(q.quads.toLocaleString('en-US'), 'quads launched'),
      stat(q.lanes.toLocaleString('en-US'), 'lanes run'),
      stat(q.helpers.toLocaleString('en-US'), 'helper lanes'),
      stat(pct(q.pixels / q.lanes), 'of lanes shade a pixel'),
      stat(q.waves, 'waves of 32'),
    );
  }
}

// =============================================================================================
// Registers and occupancy

export class OccupancyViz {
  private vgprs = 128;
  private cv = canvas(640, 330, 'Waves resident on one SIMD, and when each issues instructions');
  private counts = h('div', { class: 'll-stats' });
  private say = h('p', { class: 'rd-say' });
  private val = h('b', {});
  private pal: Palette;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-occ');
    this.pal = new Palette(root);
    const range = h('input', { type: 'range', min: '24', max: '256', step: '1', value: String(this.vgprs), 'aria-label': 'Registers per lane', style: 'flex: 1; max-width: 320px' }) as HTMLInputElement;
    range.addEventListener('input', () => {
      this.vgprs = Number(range.value);
      this.show();
    });
    root.append(
      h('label', { class: 'll-row', style: 'align-items: center; gap: 10px' }, h('span', { class: 'll-seg-l' }, 'Vector registers per lane'), range, this.val),
      h('div', { class: 'll-row' }, ...[64, 96, 120, 128, 168, 256].map((v) => btn(String(v), () => ((range.value = String(v)), (this.vgprs = v), this.show())))),
      stage(this.cv, [this.say, this.counts]),
    );
    onTheme(() => {
      this.pal.reset();
      this.show();
    });
    fit(this.cv, () => this.show());
    this.show();
  }

  private show(): void {
    const v = this.vgprs;
    this.val.textContent = String(v);
    const waves = wavesPerSimd(v);
    const alloc = Math.ceil(v / VGPR_GRANULE) * VGPR_GRANULE;
    const model = latencyModel(waves);
    const ctx = ctx2d(this.cv);
    const { w: W, h: H } = size(this.cv);
    ctx.fillStyle = this.pal.css('--bg');
    ctx.fillRect(0, 0, W, H);
    ctx.font = '13px sans-serif';
    // Wave slots.
    const slotW = (W - 120) / WAVE_SLOTS;
    ctx.fillStyle = this.pal.css('--muted');
    ctx.fillText('Wave slots', 4, 26);
    const cols = ['--c2', '--c7', '--c5', '--c4', '--c1', '--c6', '--c3', '--c8'];
    for (let i = 0; i < WAVE_SLOTS; i++) {
      const x = 110 + i * slotW;
      ctx.fillStyle = i < waves ? this.pal.css(cols[i % cols.length]) : this.pal.css('--bg');
      ctx.fillRect(x + 2, 10, slotW - 4, 24);
      ctx.strokeStyle = this.pal.css('--line');
      ctx.strokeRect(x + 2.5, 10.5, slotW - 5, 23);
    }
    // The register file: each wave's allocation.
    ctx.fillStyle = this.pal.css('--muted');
    ctx.fillText('Registers', 4, 66);
    const fx = 110;
    const fw = W - 120;
    for (let i = 0; i < waves; i++) {
      ctx.fillStyle = this.pal.css(cols[i % cols.length]);
      ctx.fillRect(fx + (i * alloc * fw) / VGPRS_PER_SIMD, 50, (alloc * fw) / VGPRS_PER_SIMD - 1, 24);
    }
    ctx.strokeStyle = this.pal.css('--line');
    ctx.strokeRect(fx + 0.5, 50.5, fw - 1, 23);
    // Timeline: one row per wave, first 1,200 cycles; a mark where it issued.
    const T = 1200;
    const top = 100;
    const rowH = Math.min(12, (H - top - 26) / WAVE_SLOTS);
    ctx.fillStyle = this.pal.css('--muted');
    ctx.fillText('Issuing', 4, top + 10);
    for (let t = 0; t < T; t++) {
      const wv = model.timeline[t];
      if (wv < 0) continue;
      ctx.fillStyle = this.pal.css(cols[wv % cols.length]);
      ctx.fillRect(fx + (t * fw) / T, top + wv * rowH, Math.max(1, fw / T), rowH - 2);
    }
    // Idle cycles along the bottom.
    const by = top + WAVE_SLOTS * rowH + 6;
    ctx.fillStyle = this.pal.css('--alert');
    for (let t = 0; t < T; t++) if (model.timeline[t] < 0) ctx.fillRect(fx + (t * fw) / T, by, Math.max(1, fw / T), 6);
    ctx.fillStyle = this.pal.css('--muted');
    ctx.fillText('idle', 4, by + 7);
    ctx.fillText(`0 … ${T.toLocaleString('en-US')} cycles`, fx, H - 4);
    this.say.textContent = `${v} registers are allocated as ${alloc} (blocks of ${VGPR_GRANULE}), so ${Math.floor(VGPRS_PER_SIMD / alloc)} waves' worth fit in ${VGPRS_PER_SIMD.toLocaleString('en-US')}${Math.floor(VGPRS_PER_SIMD / alloc) > WAVE_SLOTS ? `, more than the ${WAVE_SLOTS} slots` : ''}. Each wave runs ${ALU_RUN} instructions, then waits ${MEM_LATENCY} cycles for memory.`;
    this.counts.replaceChildren(stat(`${waves} of ${WAVE_SLOTS}`, 'waves resident (occupancy)'), stat(pct(model.busy), 'of cycles issuing (toy model)'));
  }
}
