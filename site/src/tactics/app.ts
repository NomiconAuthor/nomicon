/**
 * Tactics lab: terrain analysis for AI on a 2.5D grid. Paint a map, pick an analysis
 * layer, and drag the unit and threats around. Layout, colours and the Concepts
 * drawer follow the pathing lab.
 */
import { h } from '../lab/ui/dom';
import { CellImage, Palette, parseColor } from '../lab/ui/renderer';
import { curve, evalCurve } from '../ai/curves';
import { type SpriteId, drawSprite, onSprites, spriteSize } from '../sprites/sprites';
import { touchScroll } from '../engine/touch';
import {
  MonteCarloExposure,
  OPEN_KINDS,
  OPEN_RULES,
  RAY_MAX,
  dijkstra,
  distanceField,
  exposureKnown,
  findCover,
  openness,
  probeOpenness,
  railsOf,
  traffic,
  type Openness,
} from './analysis';
import { CROUCHED, EYE, GROUND, KINDS, PRESETS, SIZES, STANDING, type P, type TWorld, bump, inside, los } from './world';
import { CONCEPTS, GLOSSARY, type TConcept, type TScenario } from './concepts';
import { Learn } from '../lab/ui/learn';
import { clearUrlState, mountShareButton, stateInUrl, unpack } from '../lab/ui/share';
import { Player, type Trace } from './playback';
import { ChokeTrace } from './chokeTrace';
import { type Box, RebuildTrace, TILE, type Wagon, bakeCover, crater, demolish, drawEdges, wagonCells, stampWagon, tileBox, dirtyTiles, wagonCover } from './dynamicTrace';
import type { CoverCell } from './analysis';
import { COVER_ALGOS, type CoverAlgo, SampleTrace, ScanTrace, WalkTrace } from './coverTraces';

export type Layer = 'map' | 'clearance' | 'chokes' | 'traffic' | 'openness' | 'cover' | 'dynamic' | 'exposure' | 'montecarlo' | 'query';
const LAYERS: Array<[Layer, string]> = [
  ['map', 'Map only'],
  ['clearance', 'Clearance'],
  ['chokes', 'Regions and chokes'],
  ['traffic', 'Traffic'],
  ['openness', 'Openness'],
  ['cover', 'Cover generation'],
  ['dynamic', 'Changing terrain'],
  ['exposure', 'Exposure to threats'],
  ['montecarlo', 'Monte Carlo exposure'],
  ['query', 'Best cover for the unit'],
];
type Tool = 'unit' | 'threat' | number;

interface QueryResult {
  i: number;
  score: number;
  parts: Array<[string, string, number]>; // consideration, raw value, score
  path: number[];
  /** Where the unit leans out to fire from (null if it can't see any threat from here). */
  peek: P | null;
  wagon: boolean;
}

/** Options for a lab embedded in a lesson: one layer on one map, with only that layer's controls. */
export interface EmbedOptions {
  preset: string;
  layer: Layer;
  size?: string;
  coverMethod?: CoverAlgo;
  chokeMode?: 'move' | 'sight';
  stance?: 'standing' | 'crouched';
  /** Start playing the algorithm straight away. */
  play?: boolean;
  /** Compare mode: a second lane that shares this lab's map, with its own layer and settings. */
  peer?: TacticsApp;
}

/** Everything a shared link carries. */
interface Shared {
  v: 1;
  preset: string;
  size: string;
  seed: number;
  layer: Layer;
  settings: LayerSettings;
  unit: P;
  threats: P[];
  /** Cell kinds as a digit string, only when the map was painted after generation. */
  kinds?: string;
  peer?: { layer: Layer; settings: LayerSettings };
}
interface LayerSettings {
  chokeMode: 'move' | 'sight';
  ratio: number;
  coverMethod: CoverAlgo;
  simplifyTol: number;
  sampleSpacing: number;
  budget: number;
  stance: 'standing' | 'crouched';
  mcRange: number;
}

export class TacticsApp {
  private t!: TWorld;
  private preset = 'ravine';
  private size = 'small';
  private seed = 3;
  private layer: Layer = 'map';
  private tool: Tool = 'unit';
  private brush = 1;
  private chokeMode: 'move' | 'sight' = 'move';
  private ratio = 0.6;
  private coverMethod: CoverAlgo = 'walk';
  private simplifyTol = 0.5;
  private baked: Map<number, CoverCell> | null = null;
  private bakedMs = 0;
  private dynTrace: RebuildTrace | null = null;
  private wagon: Wagon | null = null;
  private dynTool: 'crater' | 'demolish' | 'wagon' = 'crater';
  private sampleSpacing = 1;
  private player!: Player;
  private colours = { get: (n: string) => this.pal.get(n), rgba: (n: string, a: number) => this.col(n, a) };
  private budget = 300;
  private exposureStance: 'standing' | 'crouched' = 'crouched';
  private mcRange = 30;
  private mcPerFrame = 4000;
  private mcRunning = true;
  private mc: MonteCarloExposure | null = null;
  private cache = new Map<string, unknown>();
  private pal = new Palette();
  private base: CellImage | null = null;
  private over: CellImage | null = null;
  private baseKey = '';
  private cnv: HTMLCanvasElement;
  private cs = 8;
  private side: HTMLElement;
  private layerBox: HTMLElement;
  private stats: HTMLElement;
  private info: HTMLElement;
  private legend: HTMLElement;
  private learn: Learn<TConcept> | null = null;
  private lastInfo = '';
  private drag: 'unit' | number | null = null;
  private raf = 0;
  private hover: P | null = null;

  private embed: EmbedOptions | null;
  /** The other lane in compare mode; both share one map. */
  private link: TacticsApp | null = null;
  private stage: HTMLElement | null = null;
  private peerHost: HTMLElement | null = null;
  private seenVersion = -1;

  constructor(root: HTMLElement, embed: EmbedOptions | null = null) {
    this.embed = embed;
    if (embed) {
      this.preset = embed.preset;
      this.layer = embed.layer;
      this.size = embed.size ?? 'small';
      if (embed.coverMethod) this.coverMethod = embed.coverMethod;
      if (embed.chokeMode) this.chokeMode = embed.chokeMode;
      if (embed.stance) this.exposureStance = embed.stance;
    }
    this.cnv = h('canvas', { class: 'map', 'aria-label': 'Tactics map' }) as HTMLCanvasElement;
    this.side = h('aside', { class: 'side' });
    this.layerBox = h('div', { class: 'sec' });
    this.stats = h('div', { class: 'stats tl-stats' });
    this.info = h('div', { class: 'info tl-info' });
    this.legend = h('div', { class: 'legend tl-legend' });
    this.player = new Player(() => this.draw());
    // Full lab and compare lanes keep the transport bar in place (disabled when a layer has no run) so the map never jumps.
    this.player.keep = !embed || !!embed.peer;
    const lane = h('section', { class: 'lane' }, this.player.el, this.player.captionEl, h('div', { class: 'map-wrap' }, this.cnv), this.legend, this.stats, this.info);
    if (embed) {
      // Lesson mode: just this layer's controls, the transport and the map.
      this.layerBox.className = 'tl-embed-controls';
      root.replaceChildren(h('div', { class: embed.peer ? 'tl-embed tl-peer' : 'tl-embed' }, this.layerBox, lane));
      this.layerList = h('div');
      if (embed.peer) {
        this.link = embed.peer;
        this.attach(embed.peer.t);
      } else this.newMap();
      this.setLayer(this.layer, false, !!embed.play);
    } else {
      this.lane = lane;
      this.stage = h('main', { class: 'stage' }, lane);
      const app = h('div', { class: 'app' }, this.side, this.stage);
      root.replaceChildren(app);
      this.learn = new Learn<TConcept>((_c, t) => this.apply(t.scenario), {
        concepts: CONCEPTS,
        glossary: GLOSSARY,
        intro: 'Short explanations of what each analysis does and why. "Try it" sets the lab up to show the idea. Underlined words anywhere in the lab explain themselves on hover.',
      });
      this.player.link = this.learn.link;
      this.buildSide();
      this.newMap();
      mountShareButton(() => this.shareState());
      const shared = stateInUrl();
      if (shared) void this.openShared(shared);
    }
    // On touch screens a vertical swipe scrolls the page unless it starts on a unit or a threat,
    // or a paint tool or the wagon is in hand; taps still place and sideways strokes still drag.
    touchScroll(this.cnv, { grab: (e) => this.grabs(e), defer: true });
    this.cnv.addEventListener('pointerdown', (e) => (this.pointer(e, 'down'), this.notify()));
    this.cnv.addEventListener('pointermove', (e) => (this.pointer(e, 'move'), this.drag !== null && this.notify()));
    window.addEventListener('pointerup', () => (this.drag = null));
    this.cnv.addEventListener('pointerleave', () => ((this.hover = null), this.draw()));
    this.cnv.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.fit()).observe(lane);
    onSprites(() => this.draw());
    new MutationObserver(() => {
      this.pal.refresh();
      this.baseKey = '';
      this.draw();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // ----------------------------------------------------------------- side panel

  private seg<T extends string | number>(opts: Array<[T, string]>, cur: T, on: (v: T) => void): HTMLElement {
    const el = h('div', { class: 'seg' });
    for (const [v, label] of opts) {
      el.append(
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(v === cur),
            onclick: () => {
              for (const b of el.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
              (el.children[opts.findIndex((o) => o[0] === v)] as HTMLElement).setAttribute('aria-pressed', 'true');
              on(v);
            },
          },
          label,
        ),
      );
    }
    return el;
  }

  private buildSide(): void {
    const presetSel = h('select', { 'aria-label': 'Map' }, ...PRESETS.map((p) => h('option', { value: p.id, selected: p.id === this.preset }, p.name))) as HTMLSelectElement;
    presetSel.addEventListener('change', () => ((this.preset = presetSel.value), this.newMap()));
    const sizeSel = h('select', { 'aria-label': 'Size' }, ...Object.keys(SIZES).map((s) => h('option', { value: s, selected: s === this.size }, `${s[0].toUpperCase()}${s.slice(1)} (${SIZES[s][0]}×${SIZES[s][1]} m)`))) as HTMLSelectElement;
    sizeSel.addEventListener('change', () => ((this.size = sizeSel.value), this.newMap()));
    const mapSec = h(
      'section',
      { class: 'sec' },
      h('h2', {}, 'Map'),
      h('label', { class: 'field' }, 'Map', presetSel),
      h('label', { class: 'field' }, 'Size', sizeSel),
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => ((this.seed = 1 + Math.floor(Math.random() * 9999)), this.newMap()) }, 'New random map'), h('button', { type: 'button', onclick: () => this.newMap() }, 'Reset')),
    );
    const tools = h('div', { class: 'tools' });
    const toolBtn = (tool: Tool, colour: string, name: string, note: string) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(tool === this.tool),
          onclick: (e: Event) => {
            this.tool = tool;
            for (const b of tools.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
            (e.currentTarget as HTMLElement).setAttribute('aria-pressed', 'true');
          },
        },
        h('span', { class: 'swatch', style: `background: var(${colour})` }),
        h('span', { class: 'tl' }, name, h('span', { class: 'cost' }, note)),
      );
    tools.append(toolBtn('unit', '--walker', 'Unit', 'drag to move'), toolBtn('threat', '--alert', 'Threat', 'click to add, right-click to remove'));
    for (const k of KINDS) tools.append(toolBtn(k.id, k.colour, k.name, k.note));
    const paintSec = h(
      'section',
      { class: 'sec' },
      h('h2', {}, 'Paint and place'),
      tools,
      h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Brush'), this.seg<number>([[1, '1 m'], [2, '3 m'], [3, '5 m']], this.brush, (v) => (this.brush = v))),
      h('p', { class: 'hint' }, 'Right-drag erases to ground. Units and threats can be dragged with any tool.'),
    );
    this.layerBox.className = 'tl-settings';
    const layers = h('section', { class: 'sec tl-bar', 'aria-label': 'Analysis' });
    const list = h('div', { class: 'tl-layers' });
    for (const [id, name] of LAYERS)
      list.append(
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(id === this.layer),
            onclick: (e: Event) => {
              for (const b of list.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
              (e.currentTarget as HTMLElement).setAttribute('aria-pressed', 'true');
              this.setLayer(id, false, false);
            },
          },
          name,
        ),
      );
    const cmp = h('input', { type: 'checkbox', checked: !!this.peerHost }) as HTMLInputElement;
    cmp.addEventListener('change', () => this.setCompare(cmp.checked));
    layers.append(
      h('div', { class: 'tl-bar-head' }, h('h2', {}, 'Analysis'), h('label', { class: 'check tl-compare' }, cmp, 'Compare two setups')),
      list,
      this.layerBox,
    );
    this.side.replaceChildren(mapSec, paintSec);
    // Rebuilt by concept "Try it" buttons too: replace the old bar rather than adding another.
    if (this.layerBar) this.layerBar.replaceWith(layers);
    else this.lane?.prepend(layers);
    this.layerBar = layers;
    this.layerList = list;
  }
  private layerBar: HTMLElement | null = null;
  private layerList!: HTMLElement;
  private lane: HTMLElement | null = null;

  /** Switch layer, showing the finished result; the transport bar plays the algorithm on request. */
  private setLayer(l: Layer, rebuildButtons = false, play = false): void {
    this.layer = l;
    if (l === 'dynamic' && !this.baked) this.rebake(false);
    if (rebuildButtons) LAYERS.forEach(([id], k) => (this.layerList.children[k] as HTMLElement).setAttribute('aria-pressed', String(id === l)));
    this.buildLayerBox();
    this.syncTrace(play);
    this.loop();
  }

  /** Bake cover for the whole map, as a game would before play. */
  private rebake(redraw = true): void {
    this.baked = new Map();
    const t0 = performance.now();
    bakeCover(this.t, this.baked);
    this.bakedMs = performance.now() - t0;
    this.dynTrace = null;
    if (redraw) this.syncTrace(false);
  }

  /** A change to the map while the bake exists: dirty the tiles it touches and rebuild them, step by step. */
  private dynamicChange(box: Box, before: Uint8Array, what: string): void {
    const t = this.t;
    let changed = 0;
    for (let i = 0; i < t.kind.length; i++) if (before[i] !== t.kind[i]) changed++;
    if (!changed || !this.baked) return;
    const clamped = { x0: Math.max(0, box.x0), y0: Math.max(0, box.y0), x1: Math.min(t.w - 1, box.x1), y1: Math.min(t.h - 1, box.y1) };
    const tr = new RebuildTrace(t, this.colours, this.baked, dirtyTiles(t, clamped, 1), clamped, changed, what);
    this.baked = tr.result();
    this.dynTrace = tr;
    bump(t);
    this.cache.clear();
    this.mc = null;
    this.player.set(tr, false);
    this.player.play();
    this.notify();
  }

  private toggleWagon(): void {
    const t = this.t;
    this.wagon = this.wagon ? null : { x: Math.max(0, Math.min(t.w - 5, t.unit.x + 4)), y: Math.max(0, Math.min(t.h - 2, t.unit.y - 1)), rot: 0 };
    stampWagon(t, this.wagon);
    this.buildLayerBox();
    this.draw();
    this.notify();
  }
  private rotateWagon(): void {
    if (!this.wagon) return;
    this.wagon.rot = this.wagon.rot ? 0 : 1;
    this.placeWagon(this.wagon.x, this.wagon.y);
  }
  private placeWagon(x: number, y: number): void {
    const v = this.wagon;
    if (!v) return;
    const w = v.rot ? 2 : 5;
    const h2 = v.rot ? 5 : 2;
    const nx = Math.max(0, Math.min(this.t.w - w, x));
    const ny = Math.max(0, Math.min(this.t.h - h2, y));
    // Only on open ground.
    const test = { ...v, x: nx, y: ny };
    if (wagonCells(test).some((c) => !KINDS[this.t.kind[c.y * this.t.w + c.x]].walk)) return;
    v.x = nx;
    v.y = ny;
    stampWagon(this.t, v);
    this.draw();
    this.notify();
  }

  /** The recorded algorithm run for the current layer, if it has one. */
  private traceNow(): Trace | null {
    const t = this.t;
    if (this.layer === 'cover') {
      const a = this.coverMethod;
      return this.memo(`trace|cover|${a}|${a === 'scan' ? 0 : a === 'walk' ? `${this.simplifyTol}|${this.sampleSpacing}` : this.budget}`, () =>
        a === 'scan' ? new ScanTrace(t, this.colours) : a === 'walk' ? new WalkTrace(t, this.colours, this.sampleSpacing, this.simplifyTol) : new SampleTrace(t, this.colours, a, this.budget),
      );
    }
    if (this.layer === 'dynamic') return this.dynTrace;
    if (this.layer === 'chokes') return this.memo(`trace|chokes|${this.chokeMode}|${this.ratio}`, () => new ChokeTrace(t, this.colours, this.chokeMode, this.ratio));
    return null;
  }

  /** Show the current layer's algorithm in the transport bar; optionally play it from the start. */
  private syncTrace(play: boolean): void {
    const tr = this.traceNow();
    if (tr !== this.player.current) this.player.set(tr, !play);
    else if (!tr) this.draw();
    if (tr && play) this.player.play();
    if (!tr) this.draw();
  }

  private slider(label: string, min: number, max: number, step: number, val: number, on: (v: number) => void, show = (v: number) => String(v)): HTMLElement {
    const out = h('output', {}, show(val));
    const i = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(val) }) as HTMLInputElement;
    i.addEventListener('input', () => {
      out.textContent = show(Number(i.value));
      on(Number(i.value));
    });
    return h('label', { class: 'field tl-slider' }, h('span', {}, label, ' ', out), i);
  }

  private buildLayerBox(): void {
    const box = this.layerBox;
    const kids: HTMLElement[] = [h('h2', {}, LAYERS.find((x) => x[0] === this.layer)![1])];
    if (this.layer === 'chokes') {
      kids.push(
        h('div', { class: 'field' }, 'Analyse space for', this.seg<'move' | 'sight'>([['move', 'Movement'], ['sight', 'Line of sight']], this.chokeMode, (v) => ((this.chokeMode = v), this.syncTrace(false)))),
        this.slider('Choke if narrower than', 0.3, 0.9, 0.05, this.ratio, (v) => ((this.ratio = v), this.syncTrace(false)), (v) => `${Math.round(v * 100)}% of the regions it joins`),
      );
    } else if (this.layer === 'cover') {
      const algoBtns = h('div', { class: 'tl-algos' });
      for (const [id, name, kind] of COVER_ALGOS)
        algoBtns.append(
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': String(id === this.coverMethod),
              onclick: () => {
                this.coverMethod = id;
                this.buildLayerBox();
                this.syncTrace(false);
              },
            },
            name,
            h('span', { class: 'tl-algo-kind' }, kind),
          ),
        );
      kids.push(h('div', { class: 'field' }, 'Algorithm', algoBtns));
      if (this.coverMethod === 'walk')
        kids.push(
          this.slider('Simplify tolerance', 0.25, 2, 0.25, this.simplifyTol, (v) => ((this.simplifyTol = v), this.syncTrace(false)), (v) => `${v} m`),
          this.slider('Probe every', 0.5, 3, 0.5, this.sampleSpacing, (v) => ((this.sampleSpacing = v), this.syncTrace(false)), (v) => `${v} m`),
        );
      if (this.coverMethod !== 'scan' && this.coverMethod !== 'walk')
        kids.push(this.slider('Samples', 25, 2000, 25, this.budget, (v) => ((this.budget = v), this.syncTrace(false))));
    } else if (this.layer === 'dynamic') {
      kids.push(
        h(
          'div',
          { class: 'field' },
          'Click the map to',
          this.seg<'crater' | 'demolish' | 'wagon'>(
            [
              ['crater', 'Blast a crater with a fireball'],
              ['demolish', 'Demolish walls'],
              ['wagon', 'Move the wagon'],
            ],
            this.dynTool,
            (v) => (this.dynTool = v),
          ),
        ),
        h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', onclick: () => this.toggleWagon() }, this.wagon ? 'Remove wagon' : 'Add a wagon'),
          this.wagon ? h('button', { type: 'button', onclick: () => this.rotateWagon() }, 'Rotate wagon') : null,
          h('button', { type: 'button', onclick: () => this.rebake() }, 'Re-bake everything'),
        ),
        h('p', { class: 'hint' }, `The cover bake is stored in ${TILE} × ${TILE} m tiles (thin grid). Painting with the tools on the left counts as a change too.`),
      );
    } else if (this.layer === 'exposure' || this.layer === 'query') {
      kids.push(h('div', { class: 'field' }, 'Unit is', this.seg<'standing' | 'crouched'>([['crouched', 'Crouched (0.8 m)'], ['standing', 'Standing (1.5 m)']], this.exposureStance, (v) => ((this.exposureStance = v), this.draw()))));
      kids.push(h('p', { class: 'hint' }, 'Threats see from 1.7 m. Add threats with the Threat tool; drag them to move.'));
    } else if (this.layer === 'montecarlo') {
      kids.push(
        h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', class: 'primary', onclick: (e: Event) => ((this.mcRunning = !this.mcRunning), ((e.currentTarget as HTMLElement).textContent = this.mcRunning ? 'Pause' : 'Run'), this.loop()) }, this.mcRunning ? 'Pause' : 'Run'),
          h('button', { type: 'button', onclick: () => ((this.mc = null), this.loop(), this.draw()) }, 'Start over'),
        ),
        this.slider('Archers up to', 10, 60, 5, this.mcRange, (v) => ((this.mcRange = v), (this.mc = null), this.draw()), (v) => `${v} m away`),
        this.slider('Samples per frame', 500, 20000, 500, this.mcPerFrame, (v) => (this.mcPerFrame = v)),
        h('div', { class: 'field' }, 'Unit is', this.seg<'standing' | 'crouched'>([['crouched', 'Crouched'], ['standing', 'Standing']], this.exposureStance, (v) => ((this.exposureStance = v), (this.mc = null), this.draw()))),
      );
    } else if (this.layer === 'openness') {
      kids.push(h('p', { class: 'hint' }, 'The unit casts 16 rays at eye height; hover any cell to probe it instead.'));
    }
    if (this.embed?.peer) {
      const sel = h('select', { 'aria-label': 'Layer' }, ...LAYERS.filter(([id]) => id !== 'dynamic').map(([id, name]) => h('option', { value: id, selected: id === this.layer }, name))) as HTMLSelectElement;
      sel.addEventListener('change', () => this.setLayer(sel.value as Layer));
      kids[0] = h('label', { class: 'field tl-peer-layer' }, 'Second setup', sel);
    } else if (this.embed) {
      const sel = h('select', { 'aria-label': 'Map' }, ...PRESETS.map((p) => h('option', { value: p.id, selected: p.id === this.preset }, p.name))) as HTMLSelectElement;
      sel.addEventListener('change', () => ((this.preset = sel.value), this.newMap(), this.syncTrace(false)));
      kids.splice(1, 0, h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Map', sel), h('button', { type: 'button', onclick: () => ((this.seed = 1 + Math.floor(Math.random() * 9999)), this.newMap(), this.syncTrace(false)) }, 'New random map')));
      kids.push(h('a', { class: 'cx-link', href: '/tactics-lab/' }, 'Open the full tactics lab →'));
    } else {
      if (kids.length === 1) kids.push(h('p', { class: 'hint' }, 'No settings for this analysis.'));
      const concept = CONCEPTS.find((c) => c.layer === this.layer);
      if (concept) kids.push(h('button', { type: 'button', class: 'cx-link', onclick: () => this.learn?.open(concept.id) }, `Concept: ${concept.title} →`));
    }
    box.replaceChildren(...kids);
  }

  // ----------------------------------------------------------------- world

  private newMap(): void {
    const [w, hh] = SIZES[this.size];
    const p = PRESETS.find((x) => x.id === this.preset)!;
    this.attach(p.build(w, hh, this.seed));
    this.notify();
  }
  /** Use this map (a new one, or the other lane's in compare mode). */
  private attach(t: TWorld): void {
    this.t = t;
    this.baked = null;
    this.dynTrace = null;
    this.wagon = null;
    this.cache.clear();
    this.mc = null;
    this.seenVersion = t.version;
    if (this.player) this.syncTrace(false);
    if (this.layer === 'dynamic') this.rebake(false);
    this.buildLayerBox();
    this.fit();
  }
  private edited(): void {
    bump(this.t);
    this.cache.clear();
    this.mc = null;
    this.seenVersion = this.t.version;
    if (this.player) this.syncTrace(false);
    this.notify();
  }

  /** Tell the other lane the shared map changed. */
  private notify(): void {
    this.link?.externalChange();
  }
  /** The other lane changed the shared map: catch up without telling it back. */
  externalChange(): void {
    const other = this.link;
    if (!other) return;
    if (other.t !== this.t) {
      this.attach(other.t);
      this.syncTrace(false);
    } else if (this.t.version !== this.seenVersion) {
      this.seenVersion = this.t.version;
      this.mc = null;
      this.baked = null;
      this.syncTrace(false);
    }
    this.draw();
  }

  /** Compare mode: a second lane beside this one, on the same map. */
  private setCompare(on: boolean, peerLayer?: Layer, peerSettings?: LayerSettings): void {
    if (!this.stage) return;
    if (this.peerHost) {
      this.peerHost.remove();
      this.peerHost = null;
      this.link = null;
    }
    this.stage.classList.toggle('tl-two', on);
    if (!on) return;
    this.peerHost = h('section', { class: 'tl-peer-host', 'aria-label': 'Second setup' });
    this.stage.append(this.peerHost);
    const layer = peerLayer ?? (this.layer === 'cover' ? 'cover' : this.layer === 'dynamic' ? 'chokes' : this.layer);
    const peer = new TacticsApp(this.peerHost, { preset: this.preset, layer, size: this.size, peer: this });
    if (peerSettings) peer.useSettings(peerSettings);
    else if (layer === 'cover') {
      // The obvious comparison: the same map, another cover method.
      peer.useSettings({ ...this.settings(), coverMethod: this.coverMethod === 'walk' ? 'biased' : 'walk' });
    }
    this.link = peer;
    this.fit();
  }

  private settings(): LayerSettings {
    return {
      chokeMode: this.chokeMode,
      ratio: this.ratio,
      coverMethod: this.coverMethod,
      simplifyTol: this.simplifyTol,
      sampleSpacing: this.sampleSpacing,
      budget: this.budget,
      stance: this.exposureStance,
      mcRange: this.mcRange,
    };
  }
  useSettings(s: LayerSettings): void {
    this.chokeMode = s.chokeMode;
    this.ratio = s.ratio;
    this.coverMethod = s.coverMethod;
    this.simplifyTol = s.simplifyTol;
    this.sampleSpacing = s.sampleSpacing;
    this.budget = s.budget;
    this.exposureStance = s.stance;
    this.mcRange = s.mcRange;
    this.mc = null;
    this.buildLayerBox();
    this.syncTrace(false);
  }

  private shareState(): Shared {
    const fresh = PRESETS.find((x) => x.id === this.preset)!.build(...SIZES[this.size], this.seed);
    const painted = fresh.kind.some((k, i) => k !== this.t.kind[i]);
    const peer = this.link && this.peerHost ? this.link : null;
    return {
      v: 1,
      preset: this.preset,
      size: this.size,
      seed: this.seed,
      layer: this.layer,
      settings: this.settings(),
      unit: this.t.unit,
      threats: this.t.threats,
      ...(painted && { kinds: Array.from(this.t.kind).join('') }),
      ...(peer && { peer: { layer: peer.layer, settings: peer.settings() } }),
    };
  }

  private async openShared(packed: string): Promise<void> {
    const s = await unpack<Shared>(packed);
    clearUrlState();
    if (!s || s.v !== 1 || !PRESETS.some((p) => p.id === s.preset) || !SIZES[s.size]) return;
    this.preset = s.preset;
    this.size = s.size;
    this.seed = s.seed;
    this.setCompare(false);
    this.newMap();
    if (s.kinds && s.kinds.length === this.t.kind.length) {
      for (let i = 0; i < s.kinds.length; i++) this.t.kind[i] = Number(s.kinds[i]) || 0;
      this.edited();
    }
    if (s.unit) this.t.unit = s.unit;
    if (s.threats) this.t.threats = s.threats.slice(0, 8);
    this.useSettings(s.settings);
    this.buildSide();
    this.setLayer(s.layer, true, false);
    if (s.peer) this.setCompare(true, s.peer.layer, s.peer.settings);
  }

  private memo<T>(key: string, fn: () => T): T {
    const k = `${key}|${this.t.version}`;
    if (!this.cache.has(k)) this.cache.set(k, fn());
    return this.cache.get(k) as T;
  }

  private moveClear(): Float32Array {
    return this.memo('clearM', () => distanceField(this.t.w, this.t.h, (i) => !KINDS[this.t.kind[i]].walk));
  }
  private trafficNow(): Float32Array {
    return this.memo('traffic', () => traffic(this.t, 40, 12, 5));
  }
  private openNow(): Openness {
    return this.memo('open', () => openness(this.t));
  }
  private coverTruth(): ReturnType<typeof railsOf> {
    return this.memo('coverTruth', () => railsOf(this.t, findCover(this.t, 'edges', 0, 0).found));
  }
  private threatKey(): string {
    return this.t.threats.map((q) => `${q.x},${q.y}`).join(';') + `|v${this.t.dynVersion}`;
  }
  private exposureNow(): ReturnType<typeof exposureKnown> {
    return this.memo(`exp|${this.threatKey()}`, () => exposureKnown(this.t, this.t.threats));
  }

  // ----------------------------------------------------------------- input

  private cellAt(e: PointerEvent): P | null {
    const r = this.cnv.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * this.t.w);
    const y = Math.floor(((e.clientY - r.top) / r.height) * this.t.h);
    return inside(this.t, x, y) ? { x, y } : null;
  }

  /** How many cells from a unit a press may land and still pick it up: one, or about a fingertip on touch. */
  private reach(e: PointerEvent): number {
    return e.pointerType === 'touch' ? Math.max(1, Math.round(12 / this.cs)) : 1;
  }

  /** Would a press here start a drag (so a touch must not scroll the page)? Mirrors `pointer`. */
  private grabs(e: PointerEvent): boolean {
    const c = this.cellAt(e);
    if (!c) return false;
    const k = this.reach(e);
    const near = (p: P) => Math.abs(p.x - c.x) <= k && Math.abs(p.y - c.y) <= k;
    if (this.layer === 'dynamic' && this.dynTool === 'wagon' && this.wagon) return true;
    if (near(this.t.unit) || this.t.threats.some(near)) return true;
    return typeof this.tool === 'number';
  }

  private pointer(e: PointerEvent, phase: 'down' | 'move'): void {
    const c = this.cellAt(e);
    this.hover = c;
    if (!c) return;
    const t = this.t;
    if (phase === 'down') {
      this.cnv.setPointerCapture(e.pointerId);
      const k = this.reach(e);
      const near = (p: P) => Math.abs(p.x - c.x) <= k && Math.abs(p.y - c.y) <= k;
      const ti = t.threats.findIndex(near);
      if (e.button === 2 && ti >= 0) {
        t.threats.splice(ti, 1);
        this.draw();
        return;
      }
      if (this.layer === 'dynamic' && this.dynTool === 'wagon' && this.wagon) {
        this.drag = -200;
        this.placeWagon(c.x - (this.wagon.rot ? 0 : 2), c.y - (this.wagon.rot ? 2 : 0));
        return;
      }
      if (this.layer === 'dynamic' && this.dynTool !== 'wagon' && !near(t.unit) && ti < 0 && typeof this.tool === 'string') {
        const before = t.kind.slice();
        const box = this.dynTool === 'crater' ? crater(t, c) : demolish(t, c);
        this.dynamicChange(box, before, this.dynTool === 'crater' ? 'A crater' : 'Demolition');
        return;
      }
      if (near(t.unit)) this.drag = 'unit';
      else if (ti >= 0) this.drag = ti;
      else if (this.tool === 'unit') {
        this.drag = 'unit';
        this.placeUnit(c);
      } else if (this.tool === 'threat') {
        if (e.button !== 2 && t.threats.length < 8 && KINDS[t.kind[c.y * t.w + c.x]].walk) {
          t.threats.push(c);
          this.drag = t.threats.length - 1;
        }
      } else {
        this.paint(c, e.button === 2 ? GROUND : (this.tool as number));
        this.drag = e.button === 2 ? -100 : -1;
      }
      this.draw();
      return;
    }
    if (this.drag === null) {
      if (this.layer === 'openness') this.draw();
      return;
    }
    if (this.drag === -200 && this.wagon) {
      this.placeWagon(c.x - (this.wagon.rot ? 0 : 2), c.y - (this.wagon.rot ? 2 : 0));
      return;
    }
    if (this.drag === 'unit') this.placeUnit(c);
    else if (this.drag >= 0) {
      if (KINDS[t.kind[c.y * t.w + c.x]].walk) t.threats[this.drag] = c;
    } else this.paint(c, this.drag === -100 ? GROUND : (this.tool as number));
    this.draw();
  }

  private placeUnit(c: P): void {
    if (KINDS[this.t.kind[c.y * this.t.w + c.x]].walk) this.t.unit = c;
  }

  private paint(c: P, k: number): void {
    const t = this.t;
    const r = this.brush - 1;
    let changed = false;
    const before = this.layer === 'dynamic' && this.baked ? t.kind.slice() : null;
    for (let y = c.y - r; y <= c.y + r; y++)
      for (let x = c.x - r; x <= c.x + r; x++) {
        if (!inside(t, x, y)) continue;
        if ((t.unit.x === x && t.unit.y === y) || t.threats.some((q) => q.x === x && q.y === y)) continue;
        const i = y * t.w + x;
        if (t.kind[i] !== k) ((t.kind[i] = k), (changed = true));
      }
    if (changed && before) this.dynamicChange({ x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r }, before, 'Painting');
    else if (changed) this.edited();
  }

  // ----------------------------------------------------------------- loop & draw

  private loop(): void {
    cancelAnimationFrame(this.raf);
    if (this.layer !== 'montecarlo' || !this.mcRunning) return;
    const f = () => {
      if (!this.mc) this.mc = new MonteCarloExposure(this.t, this.mcRange, this.exposureStance === 'crouched', 9);
      this.mc.run(this.mcPerFrame);
      this.draw();
      if (this.layer === 'montecarlo' && this.mcRunning) this.raf = requestAnimationFrame(f);
    };
    this.raf = requestAnimationFrame(f);
  }

  private fit(): void {
    if (!this.t) return;
    const lane = this.cnv.parentElement!;
    const wpx = Math.max(200, lane.clientWidth);
    const maxH = Math.max(300, window.innerHeight * 0.72);
    this.cs = Math.max(3, Math.min(16, Math.floor(Math.min(wpx / this.t.w, maxH / this.t.h))));
    const dpr = window.devicePixelRatio || 1;
    this.cnv.width = Math.round(this.t.w * this.cs * dpr);
    this.cnv.height = Math.round(this.t.h * this.cs * dpr);
    this.cnv.style.width = `${this.t.w * this.cs}px`;
    this.cnv.style.height = `${this.t.h * this.cs}px`;
    this.draw();
  }

  private col(n: string, a?: number): string {
    if (a === undefined) return this.pal.get(n);
    const [r, g, b] = parseColor(this.pal.get(n));
    return `rgba(${r},${g},${b},${a})`;
  }

  /** Heat colour from transparent to the given token. */
  private heat(img: CellImage, values: (i: number) => number, token: string, maxA = 0.85): void {
    const [r, g, b] = parseColor(this.pal.get(token));
    for (let i = 0; i < img.px.length; i++) {
      const v = values(i);
      if (!(v > 0)) {
        img.px[i] = 0;
        continue;
      }
      const a = Math.round(255 * Math.min(1, v) * maxA);
      img.px[i] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    img.commit();
  }

  draw(): void {
    if (!this.t) return;
    const t = this.t;
    const ctx = this.cnv.getContext('2d')!;
    const dpr = this.cnv.width / (t.w * this.cs);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = this.cs;
    // Base map.
    const key = `${t.version}|${this.pal.version}`;
    if (!this.base || this.base.w !== t.w || this.base.h !== t.h) this.base = new CellImage(t.w, t.h);
    if (key !== this.baseKey) {
      const cols = KINDS.map((k) => this.pal.packed(k.colour));
      for (let i = 0; i < t.w * t.h; i++) this.base.px[i] = cols[t.kind[i]];
      this.base.commit();
      this.baseKey = key;
    }
    this.base.draw(ctx, cs);
    if (!this.over || this.over.w !== t.w || this.over.h !== t.h) this.over = new CellImage(t.w, t.h);
    const legend: HTMLElement[] = [];
    const stats: Array<[string, string, string?]> = [];
    let info = '';
    const C = (x: number) => (x + 0.5) * cs;

    switch (this.layer) {
      case 'map':
        info = 'Low walls hide a crouching unit but not a standing one; buildings block everything. Ravines and water block movement but not sight. Pick an analysis above the map.';
        break;
      case 'clearance': {
        const m = this.moveClear();
        let mx = 1;
        for (let i = 0; i < m.length; i++) if (KINDS[t.kind[i]].walk) mx = Math.max(mx, m[i]);
        this.heat(this.over, (i) => (KINDS[t.kind[i]].walk ? m[i] / mx : 0), '--cache');
        this.over.draw(ctx, cs);
        const here = m[t.unit.y * t.w + t.unit.x];
        stats.push([`${here.toFixed(1)} m`, 'clearance at the unit'], [`${mx.toFixed(1)} m`, 'deepest open space'], [`${Math.max(1, 2 * here - 1).toFixed(0)} m`, 'widest unit that fits here']);
        info = 'Each cell shows its distance to the nearest thing you can\'t walk through. Corridors appear as ridges of brighter cells along their middles, and the narrowest point of a ridge is where a route pinches. This is the raw material for choke detection, and it measures width directly, whatever shape the navmesh polygons happen to be.';
        legend.push(this.key('--cache', 'far from obstacles'));
        break;
      }
      case 'chokes': {
        const tr = this.player.current;
        if (tr) {
          tr.draw(ctx, cs);
          stats.push(...tr.stats());
        }
        info =
          this.chokeMode === 'move'
            ? 'Analysing space you can walk through. Try the Ravine and bridge map: the bridge is the busiest choke. Then switch to Line of sight: the bridge disappears, because you can see and loose arrows across the ravine even though you can\'t walk across it, while the doorways in the wall remain.'
            : 'Analysing space you can see through: only buildings block. Ravines, water and low walls are transparent at eye height, so chokes here are where sight lines funnel (doorways, gaps between buildings), not bridges. Traffic is only sampled for movement.';
        legend.push(this.key('--alert', 'choke (bigger = more routes; faint = few)'), this.key('--u2', 'regions'), this.key('--cache', 'distance from obstacles'));
        break;
      }
      case 'traffic': {
        const tr = this.trafficNow();
        let mx = 0.0001;
        for (let i = 0; i < tr.length; i++) mx = Math.max(mx, tr[i]);
        this.heat(this.over, (i) => Math.sqrt(tr[i] / mx), '--walker');
        this.over.draw(ctx, cs);
        stats.push(['480', 'sampled routes'], ['40', 'Dijkstra searches'], [`${Math.round(tr[t.unit.y * t.w + t.unit.x] * 100)}%`, 'of routes pass the unit']);
        info = 'Shortest routes between 480 random pairs of walkable points, overlaid. Bright cells are on many of them. A narrow place that lots of routes use is a real choke; a narrow alley that nothing passes through is just an alley. This is a sampled estimate of betweenness centrality from graph theory.';
        legend.push(this.key('--walker', 'on many shortest routes'));
        break;
      }
      case 'openness': {
        const o = this.openNow();
        const cols = ['--t-rough', '--u7', '--alert', '--soft'];
        const packs = cols.map((p) => this.pal.packed(p, 0.4));
        for (let i = 0; i < o.kind.length; i++) this.over.px[i] = KINDS[t.kind[i]].walk ? packs[o.kind[i]] : 0;
        this.over.commit();
        this.over.draw(ctx, cs);
        const at = this.hover && KINDS[t.kind[this.hover.y * t.w + this.hover.x]].walk ? this.hover : t.unit;
        const p = probeOpenness(t, at.x, at.y);
        const ox = C(at.x);
        const oy = C(at.y);
        ctx.strokeStyle = this.col('--ink', 0.45);
        ctx.lineWidth = 1;
        ctx.beginPath();
        p.rays.forEach((d, k) => {
          const a = (k / p.rays.length) * Math.PI * 2;
          ctx.moveTo(ox, oy);
          ctx.lineTo(ox + Math.cos(a) * d * cs, oy + Math.sin(a) * d * cs);
        });
        ctx.stroke();
        // The longest and shortest axes: these decide the label.
        const axis = (a: number, token: string, dash: boolean) => {
          const r1 = p.rays[Math.round((a / (Math.PI * 2)) * p.rays.length) % p.rays.length];
          const r2 = p.rays[(Math.round((a / (Math.PI * 2)) * p.rays.length) + p.rays.length / 2) % p.rays.length];
          ctx.strokeStyle = this.col(token);
          ctx.lineWidth = 3;
          ctx.setLineDash(dash ? [6, 4] : []);
          ctx.beginPath();
          ctx.moveTo(ox + Math.cos(a) * r1 * cs, oy + Math.sin(a) * r1 * cs);
          ctx.lineTo(ox - Math.cos(a) * r2 * cs, oy - Math.sin(a) * r2 * cs);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
        };
        axis(p.longA, '--good', false);
        axis(p.longA + Math.PI / 2, '--walker', true);
        stats.push([OPEN_KINDS[p.kind], at === t.unit ? 'at the unit' : 'at the pointer'], [`${p.long.toFixed(0)} m`, 'longest axis (green)'], [`${p.across.toFixed(0)} m`, 'across it (yellow)'], [`${p.short.toFixed(0)} m`, 'shortest axis'], [`${Math.round(o.rays / 1000)}k`, 'rays to bake the whole map']);
        info = `Sixteen rays at eye height, each up to ${RAY_MAX} m, paired into eight axes through the cell (wall to wall). If even the shortest axis is at least ${OPEN_RULES.open} m, it's open ground; if even the longest (green) is under ${OPEN_RULES.enclosed} m, it's enclosed. Otherwise look across the longest axis (yellow dashed): narrow that way (the long axis is ${OPEN_RULES.ratio}× or more) means a street or corridor, however narrow the alley; wide that way too means two long directions cross here, a junction, plaza or courtyard. Hover any cell to probe it. Baked here for every cell; in a game you'd bake it from the map data or reuse perception rays.`;
        legend.push(this.key('--t-rough', 'open'), this.key('--u7', 'street / corridor'), this.key('--alert', 'enclosed'), this.key('--soft', 'junction / plaza'));
        break;
      }
      case 'cover': {
        const tr = this.player.current;
        if (tr) {
          tr.draw(ctx, cs);
          stats.push(...tr.stats());
        }
        info = {
          scan: 'When to use it: as a bake on a grid or raster (a heightmap, a voxelised level). One pass over every cell, nothing missed, trivially parallel by tile. It finds cover cells but no structure: there are no rails or corners to reason about until you group them.',
          walk: 'When to use it: the usual bake for navmesh-based games and for building footprints. Its cost follows the length of the obstacle outlines, not the area of the map, it misses nothing that touches the outline, and it produces structure the AI can use directly: rails to move along and peek points to attack from. With Recast, steps 1 and 2 come for free: its contours are exactly these outlines.',
          random: 'When to use it: rarely on its own. Uniform random sampling is the baseline the others improve on: no preprocessing, but it clumps, leaves holes, and finds narrow features only by luck.',
          poisson: 'When to use it: run-time queries around a unit when nothing was baked ("find me somewhere to hide within 20 m"), especially in open terrain where cover could be anywhere. Even coverage, predictable cost, but it can still step over thin features.',
          biased: 'When to use it: run-time queries where obstacles are known (navmesh edges, collision geometry nearby) but cover wasn\'t baked, or on top of a bake for dynamic objects. Nearly every sample is useful, and thin gaps are found because their walls are edges.',
        }[this.coverMethod];
        legend.push(this.key('--accent', 'full cover'), this.key('--walker', 'low cover'), this.key('--good', 'peek point'), this.key('--alert', 'missed / no cover'));
        break;
      }
      case 'dynamic': {
        const tr = this.player.current;
        if (tr) {
          tr.draw(ctx, cs);
          stats.push(...tr.stats());
        } else if (this.baked) {
          for (const c of this.baked.values()) drawEdges(ctx, t, cs, c, this.col(c.full ? '--accent' : '--walker'));
          stats.push([String(this.baked.size), 'baked cover positions'], [`${Math.ceil(t.w / TILE) * Math.ceil(t.h / TILE)}`, 'tiles'], [`${this.bakedMs.toFixed(2)} ms`, 'full bake, this browser']);
        }
        // Tile grid.
        ctx.strokeStyle = this.col('--ink', 0.12);
        ctx.beginPath();
        for (let x = TILE; x < t.w; x += TILE) ((ctx.moveTo(x * cs + 0.5, 0), ctx.lineTo(x * cs + 0.5, t.h * cs)));
        for (let y = TILE; y < t.h; y += TILE) ((ctx.moveTo(0, y * cs + 0.5), ctx.lineTo(t.w * cs, y * cs + 0.5)));
        ctx.stroke();
        if (this.wagon) {
          const body = wagonCells(this.wagon);
          ctx.fillStyle = this.col('--vehicle');
          for (const c of body) ctx.fillRect(c.x * cs, c.y * cs, cs, cs);
          const pts = wagonCover(t, this.wagon);
          // Template cover points: dots beside the wagon, where a unit can crouch behind it.
          ctx.strokeStyle = this.col('--vehicle');
          ctx.fillStyle = this.col('--bg');
          ctx.lineWidth = 2;
          for (const { p } of pts)
            if (KINDS[t.kind[p.y * t.w + p.x]].walk) {
              ctx.beginPath();
              ctx.arc((p.x + 0.5) * cs, (p.y + 0.5) * cs, Math.max(2.5, cs * 0.28), 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            }
          ctx.lineWidth = 1;
          stats.push([String(pts.length), 'wagon cover points (template)']);
        }
        info =
          'Bake once, then keep it valid. The bake is split into tiles; a change dirties only the tiles it touches (plus a margin for how far the analysis looks), and only those are rebuilt, in the background, while the old data stays usable. Blast a crater with a fireball or demolish a wall and step through the rebuild. Moving cover, like the wagon (purple), is never baked: it carries a template of cover points in its own frame, moved with it every frame and found through the spatial index alongside the baked cover. It costs nothing to keep valid, and it blocks line of sight in the exposure and best-cover layers.';
        legend.push(this.key('--accent', 'full cover'), this.key('--walker', 'low cover'), this.key('--good', 'new after rebuild'), this.key('--alert', 'dirty / removed'), this.key('--vehicle', 'wagon and its cover'));
        void tileBox;
        break;
      }
      case 'exposure': {
        const e = this.exposureNow();
        const n = Math.max(1, t.threats.length);
        const arr = this.exposureStance === 'crouched' ? e.crouched : e.standing;
        this.heat(this.over, (i) => (KINDS[t.kind[i]].walk ? arr[i] / n : 0), '--alert', 0.6);
        this.over.draw(ctx, cs);
        const ui = t.unit.y * t.w + t.unit.x;
        stats.push([`${arr[ui]} / ${t.threats.length}`, 'threats that can see the unit'], [`${e.rays.toLocaleString()}`, 'line-of-sight tests'], [`${this.safeCells(arr)}%`, 'of the map hidden from all']);
        for (const q of t.threats) this.sightLine(ctx, q, t.unit);
        info = 'Each cell is tinted by how many threats can see a unit there. Switch between standing and crouched: low walls only protect a crouching unit, so the safe area grows behind them. This is exact and costs one line of sight per cell per threat, so it suits a few known threats; it doesn\'t scale to "anyone, anywhere".';
        legend.push(this.key('--alert', 'seen by more threats'));
        break;
      }
      case 'montecarlo': {
        const mc = this.mc;
        if (mc) {
          this.heat(this.over, (i) => {
            const v = mc.value(i);
            return Number.isNaN(v) ? 0 : 0.08 + 0.92 * v;
          }, '--alert', 0.7);
          this.over.draw(ctx, cs);
          let s = 0;
          let k = 0;
          for (let i = 0; i < mc.samples.length; i++)
            if (mc.samples[i]) {
              s += mc.samples[i];
              k++;
            }
          const ui = t.unit.y * t.w + t.unit.x;
          this.sectorRose(ctx, mc, ui);
          stats.push([(s / Math.max(1, k)).toFixed(1), 'samples per cell'], [`${Math.round(mc.rays / 1000)}k`, 'rays so far'], [Number.isNaN(mc.value(ui)) ? '–' : `${Math.round(mc.value(ui) * 100)}%`, 'chance a random archer sees the unit'], [`${(mc.steps / Math.max(1, mc.rays)).toFixed(0)}`, 'cells walked per ray']);
        }
        info = `No known threats: each sample picks a cell and a random archer up to ${this.mcRange} m away, and tests line of sight. Over many samples, each cell's hit rate converges to "how exposed is this spot to someone, somewhere", and the rose at the unit shows which directions it's exposed from. Noisy at first, it settles as samples accumulate, which is what makes it cheap to bake in the background or refine forever.`;
        legend.push(this.key('--alert', 'exposed to more archers'));
        break;
      }
      case 'query': {
        const res = this.queryNow();
        const max = res.length ? res[0].score : 1;
        // Every candidate, shaded by score relative to the best.
        for (const r of res) {
          ctx.fillStyle = this.col('--good', 0.12 + 0.7 * Math.pow(r.score / max, 2));
          ctx.fillRect((r.i % t.w) * cs, Math.floor(r.i / t.w) * cs, cs, cs);
        }
        const hov = this.hover ? res.find((r) => r.i === this.hover!.y * t.w + this.hover!.x) : undefined;
        const show = hov ?? res[0];
        if (show) {
          ctx.strokeStyle = this.col('--good');
          ctx.lineWidth = Math.max(2, cs * 0.22);
          ctx.beginPath();
          show.path.forEach((c, k) => {
            const x = C(c % t.w);
            const y = C(Math.floor(c / t.w));
            if (k) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          });
          ctx.stroke();
          ctx.lineWidth = 1;
          const sx = show.i % t.w;
          const sy = Math.floor(show.i / t.w);
          // Sight lines: from the crouched spot (hidden: dashed grey) and from the peek point (can attack: solid).
          const z = this.exposureStance === 'crouched' ? CROUCHED : STANDING;
          for (const q of t.threats) {
            const seen = los(t, q.x, q.y, sx, sy, EYE, z).clear;
            ctx.strokeStyle = this.col(seen ? '--alert' : '--muted', seen ? 0.9 : 0.6);
            ctx.setLineDash(seen ? [] : [4, 4]);
            ctx.beginPath();
            ctx.moveTo(C(q.x), C(q.y));
            ctx.lineTo(C(sx), C(sy));
            ctx.stroke();
            ctx.setLineDash([]);
            if (show.peek && los(t, show.peek.x, show.peek.y, q.x, q.y, EYE, STANDING).clear) {
              ctx.strokeStyle = this.col('--walker', 0.9);
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(C(show.peek.x), C(show.peek.y));
              ctx.lineTo(C(q.x), C(q.y));
              ctx.stroke();
              ctx.lineWidth = 1;
            }
          }
          if (show.peek) {
            ctx.fillStyle = this.col('--walker');
            ctx.beginPath();
            ctx.arc(C(show.peek.x), C(show.peek.y), Math.max(3, cs * 0.3), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        res.slice(0, 5).forEach((r, k) => {
          const x = C(r.i % t.w);
          const y = C(Math.floor(r.i / t.w));
          ctx.fillStyle = this.col(k === 0 ? '--good' : '--cache');
          ctx.beginPath();
          ctx.arc(x, y, Math.max(3, cs * (k === 0 ? 0.6 : 0.42)), 0, Math.PI * 2);
          ctx.fill();
          if (cs >= 7) {
            ctx.fillStyle = this.col('--bg');
            ctx.font = `700 ${Math.max(8, cs * 0.65)}px ${this.pal.get('--f-mono')}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(k + 1), x, y + 0.5);
          }
        });
        if (show) {
          for (const [n, raw, sc] of show.parts) stats.push([sc.toFixed(2), `${n}: ${raw}`, sc < 0.5 ? 'bad' : undefined]);
          stats.push([show.score.toFixed(2), hov ? `score of the hovered spot (rank ${res.indexOf(hov) + 1} of ${res.length})` : `score of the best of ${res.length} spots`, 'found']);
        } else stats.push(['–', 'no reachable cover within 25 m']);
        info =
          'Every cover position within 25 m of walking is a candidate (green, brighter = better), plus the wagon\'s template points if there is one. Each is scored like a utility AI behaviour, multiplying six considerations: hidden from the threats at the chosen stance; can attack from here (by standing up behind low cover, or leaning out to a neighbouring cell: the yellow dot and line); the cover is between it and the nearest threat; not too close to a threat; a short walk; and a route that isn\'t exposed. Hover any candidate to see its breakdown. When many spots are equally safe and can all attack, the walk decides, which is why the winner is often near the unit: that\'s the right answer, as long as the near spot really is as good. Drag a threat round to the other side and watch the ranking flip.';
        legend.push(this.key('--good', 'candidates (brighter = better), best route'), this.key('--walker', 'peek point and its line of attack'), this.key('--muted', 'blocked sight line'));
        break;
      }
    }
    // Units on top.
    // Units on top, back to front: goblin archers facing the knight, the knight facing the nearest of them.
    const near = t.threats.reduce<P | null>((b, q) => (!b || Math.hypot(q.x - t.unit.x, q.y - t.unit.y) < Math.hypot(b.x - t.unit.x, b.y - t.unit.y) ? q : b), null);
    const marks: Array<[P, string, SpriteId, boolean]> = t.threats.map((q) => [q, '--alert', 'goblinArcher', t.unit.x < q.x]);
    marks.push([t.unit, '--walker', 'knight', !!near && near.x < t.unit.x]);
    marks.sort((a, b) => a[0].y - b[0].y);
    for (const [p, token, sprite, flip] of marks) this.marker(ctx, p, token, sprite, flip);
    this.stats.replaceChildren(...stats.map(([v, k, cls]) => h('div', { class: 'stat' }, h('span', { class: 'k' }, k), h('span', { class: `v${cls ? ' ' + cls : ''}` }, v))));
    if (info !== this.lastInfo) {
      // Only rebuild when the text changes, so hovering a term during playback isn't interrupted.
      this.lastInfo = info;
      this.info.replaceChildren(h('p', {}, this.learn ? this.learn.link(info) : info));
    }
    this.legend.replaceChildren(this.key('--floor', 'ground'), this.key('--t-road', 'low wall'), this.key('--wall', 'building'), this.key('--t-mud', 'ravine'), this.key('--t-water', 'water'), ...legend);
  }

  private key(token: string, label: string): HTMLElement {
    return h('span', {}, h('i', { class: 'swatch', style: `background: var(${token})` }), label);
  }

  /** A unit on its cell: a ring in its colour round the cell, and its sprite standing on it, scaled with the cells. */
  private marker(ctx: CanvasRenderingContext2D, p: P, token: string, sprite: SpriteId, flip: boolean): void {
    const cs = this.cs;
    const r = Math.max(4, cs * 0.75);
    const x = (p.x + 0.5) * cs;
    const y = (p.y + 0.5) * cs;
    ctx.fillStyle = this.col(token, 0.55);
    ctx.strokeStyle = this.col('--bg');
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fill();
    ctx.strokeStyle = this.col(token);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineWidth = 1;
    const size = spriteSize(Math.max(12, cs * 2.2));
    drawSprite(ctx, sprite, x, y - size * 0.3, size, { flip });
  }

  private sightLine(ctx: CanvasRenderingContext2D, from: P, to: P): void {
    const z = this.exposureStance === 'crouched' ? CROUCHED : STANDING;
    const clear = los(this.t, from.x, from.y, to.x, to.y, EYE, z).clear;
    const cs = this.cs;
    ctx.strokeStyle = this.col(clear ? '--alert' : '--muted', clear ? 0.9 : 0.5);
    ctx.setLineDash(clear ? [] : [4, 4]);
    ctx.beginPath();
    ctx.moveTo((from.x + 0.5) * cs, (from.y + 0.5) * cs);
    ctx.lineTo((to.x + 0.5) * cs, (to.y + 0.5) * cs);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private sectorRose(ctx: CanvasRenderingContext2D, mc: MonteCarloExposure, i: number): void {
    const cs = this.cs;
    const t = this.t;
    const x = ((i % t.w) + 0.5) * cs;
    const y = (Math.floor(i / t.w) + 0.5) * cs;
    const R = Math.max(18, cs * 4);
    ctx.fillStyle = this.col('--alert', 0.55);
    ctx.strokeStyle = this.col('--ink', 0.6);
    for (let s = 0; s < 8; s++) {
      const n = mc.sectorSamples[i * 8 + s];
      const v = n ? mc.sectorHits[i * 8 + s] / n : 0;
      const a0 = ((s - 0.5) / 8) * Math.PI * 2;
      const a1 = ((s + 0.5) / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, R * Math.max(0.08, v), a0, a1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.stroke();
  }

  private safeCells(arr: Uint8Array): number {
    let walk = 0;
    let safe = 0;
    for (let i = 0; i < arr.length; i++)
      if (KINDS[this.t.kind[i]].walk) {
        walk++;
        if (!arr[i]) safe++;
      }
    return Math.round((safe / Math.max(1, walk)) * 100);
  }

  // ----------------------------------------------------------------- best cover

  private queryNow(): QueryResult[] {
    const t = this.t;
    const stance = this.exposureStance;
    const vkey = this.wagon ? `${this.wagon.x},${this.wagon.y},${this.wagon.rot}` : '-';
    return this.memo(`query|${this.threatKey()}|${t.unit.x},${t.unit.y}|${stance}|${vkey}`, () => {
      const from = t.unit.y * t.w + t.unit.x;
      const { dist, prev } = dijkstra(t, from, 25);
      const exp = this.exposureNow();
      const zHide = stance === 'crouched' ? CROUCHED : STANDING;
      // Considerations, as response curves (see the AI lessons).
      const cHidden = curve('poly', { k: 1.5 });
      const cFire = curve('step', { c: 0.5, lo: 0.35 });
      const cFaces = curve('step', { c: 0.5, lo: 0.5 });
      const cRange = curve('logistic', { k: 14, c: 0.25, lo: 0.3 });
      const cWalk = curve('linear', { inv: true, lo: 0.3 });
      const cRoute = curve('poly', { k: 0.7, inv: true, lo: 0.2 });
      // Candidates: baked cover positions, plus the wagon's template points.
      const cands = new Map<number, { dirs: number; wagon: boolean }>();
      for (const [i, c] of this.coverTruth().cells) cands.set(i, { dirs: c.dirs, wagon: false });
      if (this.wagon)
        for (const { p, dir } of wagonCover(t, this.wagon)) {
          const i = p.y * t.w + p.x;
          if (KINDS[t.kind[i]].walk) cands.set(i, { dirs: (cands.get(i)?.dirs ?? 0) | dir, wagon: true });
        }
      const D4: Array<[number, number]> = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ];
      const out: QueryResult[] = [];
      for (const [i, cand] of cands) {
        if (!(dist[i] <= 25)) continue;
        const x = i % t.w;
        const y = (i - x) / t.w;
        let hidden = 0;
        for (const q of t.threats) if (!los(t, q.x, q.y, x, y, EYE, zHide).clear) hidden++;
        const hiddenFrac = t.threats.length ? hidden / t.threats.length : 1;
        // Can it fight from here? Standing up behind low cover, or leaning out to a neighbouring cell.
        let peek: P | null = null;
        for (let dy = -1; dy <= 1 && !peek; dy++)
          for (let dx = -1; dx <= 1 && !peek; dx++) {
            const px = x + dx;
            const py = y + dy;
            if (!inside(t, px, py) || !KINDS[t.kind[py * t.w + px]].walk || t.dyn[py * t.w + px]) continue;
            if (t.threats.some((q) => los(t, px, py, q.x, q.y, EYE, STANDING).clear)) peek = { x: px, y: py };
          }
        // Does the cover face the nearest threat?
        let near: P | null = null;
        let nd = Infinity;
        for (const q of t.threats) {
          const d = Math.hypot(q.x - x, q.y - y);
          if (d < nd) ((nd = d), (near = q));
        }
        let faces = 0;
        if (near)
          D4.forEach(([dx, dy], k) => {
            if (cand.dirs & (1 << k) && (dx * (near!.x - x) + dy * (near!.y - y)) / Math.max(1, nd) > 0.4) faces = 1;
          });
        const path: number[] = [];
        for (let c = i; c >= 0; c = prev[c]) path.unshift(c);
        let seen = 0;
        for (const c of path) if (exp.standing[c]) seen++;
        const routeExp = path.length ? seen / path.length : 0;
        const parts: Array<[string, string, number]> = [
          ['hidden from threats', `${hidden}/${t.threats.length}`, evalCurve(cHidden, hiddenFrac)],
          ['can attack from here', peek ? 'yes' : 'no', evalCurve(cFire, peek ? 1 : 0)],
          ['cover faces the threat', faces ? 'yes' : 'no', evalCurve(cFaces, faces)],
          ['not too close', `${nd === Infinity ? '–' : nd.toFixed(0)} m`, evalCurve(cRange, nd === Infinity ? 1 : nd / 30)],
          ['short walk', `${dist[i].toFixed(0)} m`, evalCurve(cWalk, dist[i] / 25)],
          ['safe route', `${Math.round(routeExp * 100)}% exposed`, evalCurve(cRoute, routeExp)],
        ];
        let sc = parts.reduce((a2, p2) => a2 * p2[2], 1);
        sc = sc + (1 - sc) * (1 - 1 / parts.length) * sc;
        out.push({ i, score: sc, parts, path, peek, wagon: cand.wagon });
      }
      out.sort((a2, b2) => b2.score - a2.score);
      return out;
    });
  }

  // ----------------------------------------------------------------- concepts

  apply(s: TScenario): void {
    this.preset = s.preset;
    this.seed = s.seed ?? 3;
    this.size = s.size ?? 'small';
    if (s.chokeMode) this.chokeMode = s.chokeMode;
    if (s.ratio) this.ratio = s.ratio;
    if (s.coverMethod) this.coverMethod = s.coverMethod;
    if (s.budget) this.budget = s.budget;
    if (s.stance) this.exposureStance = s.stance;
    this.buildSide();
    this.newMap();
    if (s.threats) this.t.threats = s.threats.map(([fx, fy]) => this.free(fx, fy));
    if (s.unit) this.t.unit = this.free(s.unit[0], s.unit[1]);
    this.mc = null;
    this.setLayer(s.layer, true, false);
  }
  /** The walkable cell nearest a point given as fractions of the map. */
  private free(fx: number, fy: number): P {
    const t = this.t;
    const x0 = Math.round(fx * (t.w - 1));
    const y0 = Math.round(fy * (t.h - 1));
    for (let r = 0; r < Math.max(t.w, t.h); r++)
      for (let y = y0 - r; y <= y0 + r; y++)
        for (let x = x0 - r; x <= x0 + r; x++) if (inside(t, x, y) && KINDS[t.kind[y * t.w + x]].walk) return { x, y };
    return { x: x0, y: y0 };
  }
}


