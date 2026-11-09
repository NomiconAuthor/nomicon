/**
 * "Bandwidth": BandwidthViz. A three-pass frame (G-buffer, lighting, post) on the real GPU with
 * the render-target formats and load/store ops the reader picks, the model's bytes per frame for
 * those choices (scenes/bandwidth.ts, the numbers the lesson quotes), the pass setup the renderer
 * actually recorded, and live GPU time per pass.
 */
import '../gpu/gpu.css';
import { h, seg } from '../../engine/dom';
import { type BandwidthColours, type BandwidthRenderer, bandwidthDraws, createBandwidth, transientUsage } from '../gpu/bandwidth';
import { LiveTimes } from '../gpu/perf-common';
import { CallLog, GL_NAMES } from '../gpu/record';
import { GpuCanvas, backendLine } from '../gpu/widget';
import { BANDWIDTH_DEFAULTS, type BandwidthSettings, DEPTH_FORMATS, FORMATS, GBs, HDR_FORMATS, MB, NORMAL_FORMATS, type Ops, RESOLUTIONS, type Traffic, bandwidth } from '../scenes/bandwidth';
import { type RGB, Palette, chk, frame, onTheme, stage } from '../view';
import { LiveLoop, apiSwitch, timesTable } from './perf-common';

const r255 = (c: RGB) => c.map((x) => Math.round(x)) as [number, number, number];
const colours = (pal: Palette): BandwidthColours => ({ bg: r255(pal.rgb('--bg')), draws: bandwidthDraws().map((d) => r255(pal.rgb(d.color))) });

function select<T extends string>(label: string, options: Array<[T, string]>, value: T, change: (v: T) => void): HTMLSelectElement {
  const s = h('select', { 'aria-label': label, onchange: (e: Event) => change((e.target as HTMLSelectElement).value as T) }, ...options.map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
  s.value = value;
  return s;
}

type OpsKey = 'albedoOps' | 'normalOps' | 'depthOps' | 'hdrOps';
type FormatKey = 'normal' | 'depth' | 'hdr';

export class BandwidthViz {
  private s: BandwidthSettings = structuredClone(BANDWIDTH_DEFAULTS);
  private pal: Palette;
  private gpu: GpuCanvas;
  private renderer: BandwidthRenderer | null = null;
  private live: LiveTimes | null = null;
  private passes: string[] = [];
  private log = new CallLog();
  private api: HTMLElement & { refresh: () => void };
  private backend = h('div', { class: 'll-row' });
  private table = h('div', { class: 'rp-wrap' });
  private totals = h('div', {});
  private warn = h('p', { class: 'rp-warn' });
  private times = h('div', {});
  private calls = h('pre', { class: 'rp-code' });
  private status = h('p', { class: 'rd-gpu-status' });
  private ready = false;
  /** Record the next frame's calls (after a change), for the pass-setup listing. */
  private recordNext = true;
  private lastTimes = 0;
  private loop: LiveLoop;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-bandwidth');
    this.pal = new Palette(root);
    this.gpu = new GpuCanvas({
      w: 640,
      h: 360,
      label: "The pipeline lesson's floor and box, lit from a G-buffer and tone-mapped",
      build: async (ctx) => {
        this.renderer = await createBandwidth(ctx, this.log);
        this.live = new LiveTimes(this.renderer.timer);
        await this.prepare();
      },
      teardown: () => {
        this.live?.stop();
        this.live = null;
        this.renderer?.dispose();
        this.renderer = null;
        this.ready = false;
      },
      draw: () => this.draw(),
      onStatus: (s) => {
        this.status.textContent = s;
        this.showBackend();
      },
      // R11G11B10 targets need this optional feature in WebGPU.
      features: ['rg11b10ufloat-renderable'],
    });
    this.api = apiSwitch(this.gpu, () => void this.changed());
    // The attachment table (the main controls) sits beside a smaller canvas, with the model's totals
    // under the canvas, so the selects and the bytes they change are on screen together.
    const figure = h('div', { class: 'rp-bw-fig' }, this.gpu.el, h('div', {}, h('p', { class: 'rp-h' }, 'Model: bytes moved per frame'), this.totals), h('div', {}, h('p', { class: 'rp-h' }, 'GPU time, live'), this.times));
    root.append(
      this.backend,
      stage(
        figure,
        [
          seg<string>('Resolution', RESOLUTIONS.map(([w, hh]) => [`${w}x${hh}`, `${w} × ${hh}`] as [string, string]), `${this.s.w}x${this.s.h}`, (v) => {
            const [w, hh] = v.split('x').map(Number);
            this.s.w = w;
            this.s.h = hh;
            void this.changed();
          }).el,
          this.table,
          this.warn,
          h(
            'div',
            { class: 'rp-controls' },
            chk('Fog: the lighting pass reads depth', this.s.fog, (v) => {
              this.s.fog = v;
              void this.changed();
            }),
            chk('G-buffer and lighting in one pass, on chip (model only)', this.s.merged, (v) => {
              this.s.merged = v;
              void this.changed();
            }),
          ),
        ],
        16 / 9,
      ),
      h('details', {}, h('summary', {}, 'The pass setup the renderer recorded for this frame'), this.calls),
      this.status,
    );
    onTheme(() => {
      this.pal.reset();
      this.draw();
    });
    this.showModel();
    this.loop = new LiveLoop(root, () => this.draw(), () => this.ready);
    void this.gpu.start().then(() => {
      this.api.refresh();
      this.showBackend();
      this.loop.kick();
    });
  }

  private prepareGen = 0;
  private async prepare(): Promise<void> {
    const r = this.renderer;
    if (!r) return;
    const gen = ++this.prepareGen;
    this.ready = false;
    const why = r.unsupported(this.s);
    if (why) {
      this.status.textContent = `Can't draw this on the GPU here: ${why}. The model still counts it.`;
      return;
    }
    await r.prepare(this.s);
    // A later change started its own prepare: let that one decide.
    if (gen !== this.prepareGen || r !== this.renderer) return;
    this.ready = true;
    const t = transientUsage();
    this.status.textContent =
      r.backend !== 'webgpu'
        ? ''
        : r.transientDepth
          ? 'Depth is a transient attachment here (TRANSIENT_ATTACHMENT): cleared, discarded and never sampled, so the browser may keep it in tile memory without allocating it.'
          : t === null
            ? ''
            : 'Turn fog off and set depth to clear and discard, and it can be a transient attachment.';
  }

  private async changed(): Promise<void> {
    this.showModel();
    this.showBackend();
    this.live?.clear();
    await this.prepare();
    this.recordNext = true;
    this.draw();
    this.loop.kick();
  }

  private showBackend(): void {
    this.backend.replaceChildren(this.api, h('span', {}, h('span', { class: 'll-muted' }, 'Drawn with '), ...backendLine(this.gpu)));
  }

  private opsCells(key: OpsKey, fixed = false): HTMLElement[] {
    const o = this.s[key] as Ops;
    if (fixed) return [h('td', {}, 'clear'), h('td', {}, 'store')];
    return [
      h(
        'td',
        {},
        select<Ops['load']>('Load op', [
          ['clear', 'clear'],
          ['load', 'load'],
        ], o.load, (v) => {
          o.load = v;
          void this.changed();
        }),
      ),
      h(
        'td',
        {},
        select<Ops['store']>('Store op', [
          ['store', 'store'],
          ['discard', 'discard'],
        ], o.store, (v) => {
          o.store = v;
          void this.changed();
        }),
      ),
    ];
  }

  private formatCell(key: FormatKey | null, fixed: string, options: string[]): HTMLElement {
    if (!key) return h('td', {}, fixed);
    return h(
      'td',
      {},
      select<string>('Format', options.map((f) => [f, f] as [string, string]), this.s[key], (v) => {
        this.s[key] = v;
        void this.changed();
      }),
    );
  }

  private showModel(): void {
    const b = bandwidth(this.s);
    const row = (r: Traffic, label: string, fmt: HTMLElement, ops: HTMLElement[]) =>
      h('tr', {}, h('td', {}, label), fmt, h('td', { class: 'num' }, String(r.bytesPerPixel)), ...ops, h('td', { class: 'num' }, MB(r.load + r.store)));
    const readRow = (what: string, bytes: number) => h('tr', {}, h('td', { colspan: '5', class: 'll-muted' }, what), h('td', { class: 'num' }, MB(bytes)));
    const [albedo, normal, depth, hdr, swap] = b.rows;
    const merged = this.s.merged;
    this.table.replaceChildren(
      h(
        'table',
        { class: 'rp-att' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Attachment'), h('th', {}, 'Format'), h('th', { title: 'Bytes a pixel' }, 'B/px'), h('th', {}, 'Load'), h('th', {}, 'Store'), h('th', {}, 'Moved'))),
        h(
          'tbody',
          {},
          h('tr', { class: 'pass' }, h('td', { colspan: '6' }, merged ? 'G-buffer + lighting, one pass (subpasses: the G-buffer stays in tile memory)' : 'G-buffer pass')),
          row(albedo, 'albedo', this.formatCell(null, 'rgba8unorm', []), this.opsCells('albedoOps')),
          row(normal, 'normal', this.formatCell('normal', '', NORMAL_FORMATS), this.opsCells('normalOps')),
          row(depth, 'depth', this.formatCell('depth', '', DEPTH_FORMATS), this.opsCells('depthOps')),
          h('tr', { class: 'pass' }, h('td', { colspan: '6' }, merged ? 'Lighting, in the same pass' : 'Lighting pass')),
          readRow(`reads albedo, normal${this.s.fog ? ' and depth' : ''}${merged ? ' from tile memory' : ''}`, albedo.read + normal.read + depth.read),
          row(hdr, 'HDR colour', this.formatCell('hdr', '', HDR_FORMATS), this.opsCells('hdrOps')),
          h('tr', { class: 'pass' }, h('td', { colspan: '6' }, 'Post pass')),
          readRow('reads HDR colour', hdr.read),
          row(swap, 'swapchain image', h('td', {}, '8-bit RGBA or BGRA'), this.opsCells('hdrOps', true)),
        ),
      ),
    );
    const fmtNote = [this.s.normal, this.s.hdr, this.s.depth].filter((f) => FORMATS[f].note).map((f) => `${f}: ${FORMATS[f].note}`);
    this.totals.replaceChildren(
      h(
        'table',
        { class: 'rd-tab' },
        h(
          'tbody',
          {},
          h('tr', { class: 'rp-total' }, h('th', {}, 'Per frame'), h('td', {}, MB(b.total))),
          h('tr', {}, h('th', {}, 'At 60 frames a second'), h('td', {}, GBs(b.total))),
          h('tr', {}, h('th', {}, 'Target memory'), h('td', {}, MB(b.footprint))),
          h('tr', {}, h('th', {}, 'of which could be memoryless'), h('td', {}, MB(b.transient))),
        ),
      ),
      h('p', { class: 'rp-fine' }, `Render-target traffic, no compression: what a tile-based GPU moves, a lower bound on others. MB = 10⁶ bytes.${fmtNote.length ? ` ${fmtNote.join('; ')}.` : ''}`),
    );
    const names: Record<string, string> = { albedo: 'Albedo', normal: 'The normal', depth: 'Depth', hdr: 'The HDR colour' };
    this.warn.textContent = b.broken.length ? `${b.broken.map((n, i) => (i ? names[n].toLowerCase() : names[n])).join(' and ')} ${b.broken.length > 1 ? 'are' : 'is'} discarded but read by a later pass, which reads garbage (zeros, in WebGPU).` : '';
  }

  private showCalls(): void {
    const keep = new Set(['beginRenderPass', 'clearBufferfv', 'clearBufferfi', 'invalidateFramebuffer', 'bindFramebuffer']);
    const lines = this.log.of('frame').filter((c) => keep.has(c.method) && !c.tag);
    const compact = (full: string) =>
      full
        .replace(/clearValue: \{\s*r: ([^,]+),\s*g: ([^,]+),\s*b: ([^,]+),\s*a: ([^\s]+)\s*\}/g, 'clearValue: { r: $1, g: $2, b: $3, a: $4 }')
        .replace(/,\n\s*timestampWrites: (undefined|\{[\s\S]*?\n\s*\})/, '');
    // WebGL2's attachment lists print as numbers; name them.
    const glNames = (short: string) => short.replace(/\[([\d, ]+)\]/, (_, xs: string) => `[${xs.split(',').map((x) => GL_NAMES.get(Number(x)) ?? x.trim()).join(', ')}]`);
    this.calls.textContent = lines.map((c) => (c.method === 'beginRenderPass' ? `encoder.beginRenderPass(${compact(c.full)})` : glNames(c.short))).join(lines.some((c) => c.method === 'beginRenderPass') ? '\n\n' : '\n') || 'Nothing recorded yet.';
  }

  private draw(): void {
    const r = this.renderer;
    if (!r || !this.ready) return;
    const rec = this.recordNext;
    if (rec) {
      this.log.clear();
      this.log.start('frame');
    }
    const { plan, timed } = r.frame(this.s, colours(this.pal));
    if (rec) {
      this.log.stop();
      this.recordNext = false;
      this.showCalls();
    }
    this.passes = plan.passes.map((p) => p.name);
    if (timed) this.live?.drew(this.passes);
    const now = performance.now();
    if (now - this.lastTimes > 500) {
      this.lastTimes = now;
      this.times.replaceChildren(timesTable(r.timer, this.live, this.passes));
    }
  }
}
