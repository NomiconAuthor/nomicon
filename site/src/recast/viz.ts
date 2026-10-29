/** Recast's pipeline as a stepper: a top view and a cross-section, stage by stage. */
import { fmt, h, seg } from '../engine/dom';
import { AGENT_HEIGHT, BOXES, CH, CS, DEFAULT_OPTIONS, RAMPS, SCENE_D, SCENE_W, runStages, type RegionMode, type StageOptions, type Stages } from './stages';

interface StageInfo {
  id: string;
  name: string;
  what: string;
  stop: string;
}
export const STAGES: StageInfo[] = [
  {
    id: 'tris',
    name: '1. Triangles',
    what: 'The input is a triangle soup: the level geometry (or a simplified collision version). Each triangle is marked walkable if its slope is under the limit (45° here). The steep ramp by the crate fails; the gentle one up to the table passes.',
    stop: "You only need this if you have your own spatial representation and just want Recast's slope classification. Usually you'll keep going.",
  },
  {
    id: 'hf',
    name: '2. Heightfield',
    what: 'Every triangle is rasterised into a grid of columns (here 0.25 m wide), and each column becomes a list of solid spans (here in 0.1 m steps). A span keeps the walkable flag of the triangle that made its top. This is a voxel model of the level: the cross-section below shows a column through the table has three spans, floor, table and (hollow) slab underside.',
    stop: 'Stop here if you want a solid voxel model for something other than walking: line of sight against a raster, sound propagation, volume queries, or destruction. It\'s the most general thing Recast produces.',
  },
  {
    id: 'filter',
    name: '3. Filtering',
    what: "Three filters fix the walkable flags. Low obstacles you can step onto (the kerb) become walkable. Ledges, where the drop to a neighbour is more than the climb height, become unwalkable at the edge (the platform's sides). Spans without enough headroom above them become unwalkable (the floor under the table, and inside the hollow platform: see the cross-section). Orange: a top surface a filter changed. The edge of the world counts as a drop, so the border is a ledge too.",
    stop: 'Stop here for a walkability classification per column and level: a 2.5D walkable grid with heights. That\'s exactly the input the tactics lab\'s clearance, chokes and cover analysis need.',
  },
  {
    id: 'compact',
    name: '4. Compact heightfield',
    what: "Recast flips the representation: instead of solid spans it keeps the open space above every walkable span (the floor of each 'room' a unit could stand in), and links each one to its neighbours if the step between them is climbable. Multi-level places become separate spans in one column (here only the hollow boxes, whose tops sit above the floor sealed inside; the floor under the table was already filtered out). Shading: how many levels a column has.",
    stop: 'Stop here for a navigation graph you can search yourself: every span is a node, every link an edge, on any number of levels. Flow fields, voxel A*, reachability from a point and clearance all run directly on it.',
  },
  {
    id: 'erode',
    name: '5. Erode by radius',
    what: "Walkable spans closer than the agent's radius (0.6 m here) to an edge are marked unwalkable, so the rest of the pipeline can treat the agent as a point. The 0.8 m gap between the two boxes closes: a 1.2 m wide agent can't fit. Red: removed by erosion.",
    stop: 'A navmesh is built for one agent size. For several sizes, run from here on once per size, or stop here and keep the distance field below instead, which answers "does an agent of radius r fit here?" for every r at once.',
  },
  {
    id: 'dist',
    name: '6. Distance field',
    what: 'For every walkable span, the distance to the nearest edge of the walkable area, computed with a two-pass chamfer transform. Ridges of high distance run along the middle of open spaces. Recast uses it to grow regions from the middle out.',
    stop: 'Stop here for clearance: unit-size checks, chokes, the medial axis, cover and openness (the terrain analysis lessons all start from this kind of field).',
  },
  {
    id: 'regions',
    name: '7. Regions',
    what: 'Walkable spans are grouped into regions with no holes and no overlaps, each of which can become a set of polygons. Watershed grows regions from the distance field\'s peaks (the best polygons, the slowest); monotone sweeps rows (fast, but long thin regions); layers partition so that no region overlaps itself in height (used for tile caches). Small regions are merged into neighbours.',
    stop: 'Stop here for an area graph: which parts of the level connect to which, through which openings. It\'s a ready-made level of a hierarchical pathfinder. Region borders follow Recast\'s size rules, not narrow openings, so don\'t read them as chokes.',
  },
  {
    id: 'contours',
    name: '8. Contours',
    what: 'Each region\'s outline is traced along its cell edges (thin lines: the raw contour), then simplified, keeping vertices where the outline changes neighbour and dropping the rest until the simplified line stays within the error limit (thick lines). Long edges are split so polygons stay reasonably shaped.',
    stop: 'Stop here for clean outlines of walkable space: cover rails (the cover generation lesson\'s boundary walk starts from exactly these), visibility-graph planners, or your own triangulation.',
  },
  {
    id: 'polys',
    name: '9. Polygon mesh',
    what: 'Each simplified contour is triangulated, and the triangles are merged into convex polygons of up to six vertices. Convex polygons are what make the mesh easy to search: any two points in the same polygon can see each other.',
    stop: "This is the navmesh. Stop here and write your own search over it if Detour's assumptions don't fit, as in the next lesson.",
  },
  {
    id: 'detail',
    name: '10. Detail mesh',
    what: 'The polygons are flat approximations; the detail mesh adds triangles inside each one that follow the real height of the surface (sampled from the heightfield), so agents stand on the ground rather than near it. On a flat floor it adds little; on the ramp it matters.',
    stop: 'Detour needs this to place agents at the right height. If your movement code snaps to the physics surface anyway, it only has to be good enough for queries.',
  },
];

function css(el: Element) {
  const cs = getComputedStyle(el);
  const g = (n: string, f = '#888') => cs.getPropertyValue(n).trim() || f;
  return { bg: g('--bg'), paper: g('--paper'), line: g('--line'), soft: g('--line-soft'), ink: g('--ink'), muted: g('--muted'), accent: g('--accent'), warn: g('--warn'), alert: g('--alert'), good: g('--good'), mono: g('--f-mono'), series: ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'].map((n) => g(n)) };
}

export class RecastStagesViz {
  private root: HTMLElement;
  private top = h('canvas', { class: 'rc-top', 'aria-label': 'Top view of the current stage; click to move the cross-section' }) as HTMLCanvasElement;
  private side = h('canvas', { class: 'rc-side', 'aria-label': 'Cross-section through the scene' }) as HTMLCanvasElement;
  private caption = h('div', { class: 'rc-cap' });
  private stats = h('div', { class: 'll-stats' });
  private tabs: HTMLButtonElement[] = [];
  private stage = 0;
  private o: StageOptions = { ...DEFAULT_OPTIONS };
  private data: Stages | null = null;
  private sliceZ = 11; // metres
  private busy = 0;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll rc' });
    host.replaceChildren(this.root);
    const tabs = h('div', { class: 'rc-tabs', role: 'tablist' });
    STAGES.forEach((s, i) => {
      const b = h('button', { type: 'button', class: 'll-seg-b', role: 'tab', 'aria-pressed': String(i === 0), onclick: () => this.show(i) }, s.name) as HTMLButtonElement;
      this.tabs.push(b);
      tabs.append(b);
    });
    const opts = h(
      'div',
      { class: 'll-row' },
      seg<string>('Agent radius', ['0.3', '0.6', '0.9'].map((x) => [x, `${x} m`] as [string, string]), String(this.o.radius), (v) => ((this.o.radius = Number(v)), this.build())).el,
      seg<RegionMode>(
        'Regions',
        [
          ['watershed', 'Watershed'],
          ['monotone', 'Monotone'],
          ['layers', 'Layers'],
        ],
        this.o.regions,
        (v) => ((this.o.regions = v), this.build()),
      ).el,
      seg<string>('Simplify within', ['0.5', '1.3', '3'].map((x) => [x, `${x} cells`] as [string, string]), String(this.o.maxError), (v) => ((this.o.maxError = Number(v)), this.build())).el,
      seg<string>('Vertices per polygon', ['3', '6'].map((x) => [x, x] as [string, string]), String(this.o.maxVerts), (v) => ((this.o.maxVerts = Number(v)), this.build())).el,
    );
    const nav = h(
      'div',
      { class: 'll-row' },
      h('button', { type: 'button', class: 'll-btn', onclick: () => this.show(Math.max(0, this.stage - 1)) }, '◀ Previous stage'),
      h('button', { type: 'button', class: 'll-btn primary', onclick: () => this.show(Math.min(STAGES.length - 1, this.stage + 1)) }, 'Next stage ▶'),
    );
    this.root.append(tabs, nav, this.caption, h('div', { class: 'rc-views' }, this.top, h('div', { class: 'rc-side-wrap' }, h('div', { class: 'll-h' }, 'Cross-section (click the top view to move it)'), this.side)), opts, this.stats);
    this.top.addEventListener('pointerdown', (e) => {
      const r = this.top.getBoundingClientRect();
      const d = this.data;
      if (!d) return;
      this.sliceZ = d.bmin[2] + ((e.clientY - r.top) / r.height) * d.h * CS;
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(this.root);
    new MutationObserver(() => this.draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.build();
  }

  private async build(): Promise<void> {
    const token = ++this.busy;
    const d = await runStages(this.o);
    if (token !== this.busy) return;
    this.data = d;
    this.draw();
  }

  private show(i: number): void {
    this.stage = i;
    this.tabs.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
    this.draw();
  }

  /** The topmost compact span of a column, or -1. */
  private topSpan(d: Stages, col: number): number {
    const l = d.cells[col];
    return l.length ? l[l.length - 1][2] : -1;
  }

  private draw(): void {
    const d = this.data;
    if (!d) return;
    const c = css(this.root);
    const st = STAGES[this.stage];
    this.caption.replaceChildren(h('p', {}, h('b', {}, st.name.replace(/^\d+\. /, '')), ' ', st.what), h('p', { class: 'rc-stop' }, h('b', {}, 'Stop here if… '), st.stop));
    const dpr = window.devicePixelRatio || 1;
    const avail = Math.max(260, this.root.clientWidth);
    const S = Math.max(2.5, Math.min(9, Math.floor(avail / d.w)));
    const W = d.w * S;
    const H = d.h * S;
    this.top.width = W * dpr;
    this.top.height = H * dpr;
    this.top.style.width = `${W}px`;
    this.top.style.height = `${H}px`;
    const ctx = this.top.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    // World metres to canvas pixels.
    const X = (x: number) => ((x - d.bmin[0]) / CS) * S;
    const Z = (z: number) => ((z - d.bmin[2]) / CS) * S;
    const cell = (i: number, colour: string, alpha = 1) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = colour;
      ctx.fillRect((i % d.w) * S, Math.floor(i / d.w) * S, S, S);
      ctx.globalAlpha = 1;
    };
    const id = st.id;
    if (id === 'tris') {
      for (const t of d.tris) {
        ctx.fillStyle = t.walkable ? c.good : c.alert;
        ctx.globalAlpha = 0.25;
        ctx.beginPath();
        ctx.moveTo(X(t.p[0]), Z(t.p[2]));
        ctx.lineTo(X(t.p[3]), Z(t.p[5]));
        ctx.lineTo(X(t.p[6]), Z(t.p[8]));
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = t.walkable ? c.good : c.alert;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (id === 'hf' || id === 'filter') {
      const list = id === 'hf' ? d.spans : d.afterLowHeight;
      const maxY = 40;
      for (let i = 0; i < list.length; i++) {
        const l = list[i];
        if (!l.length) continue;
        const topS = l[l.length - 1];
        // Height as brightness, walkable top in green, unwalkable in red.
        cell(i, topS[2] ? c.good : c.alert, 0.15 + 0.6 * Math.min(1, topS[1] / maxY));
        // Orange where a filter changed the walkable flag of the top surface.
        if (id === 'filter' && d.spans[i].length === l.length && d.spans[i][l.length - 1][2] !== topS[2]) cell(i, c.warn, 0.85);
      }
    } else {
      for (let i = 0; i < d.cells.length; i++) {
        const k = this.topSpan(d, i);
        if (k < 0) continue;
        if (id === 'compact') {
          const lv = d.cells[i].length;
          cell(i, d.areasBeforeErode[k] ? c.accent : c.muted, d.areasBeforeErode[k] ? 0.25 + 0.3 * (lv - 1) : 0.15);
        } else if (id === 'erode') {
          if (d.areas[k]) cell(i, c.accent, 0.35);
          else if (d.areasBeforeErode[k]) cell(i, c.alert, 0.7);
        } else if (id === 'dist') {
          if (d.areas[k]) cell(i, c.warn, 0.1 + 0.85 * (d.dist[k] / Math.max(1, d.maxDist)));
        } else if (d.areas[k]) {
          const reg = d.regs[k];
          cell(i, reg ? c.series[reg % c.series.length] : c.muted, id === 'regions' ? 0.65 : 0.22);
        }
      }
      if (id === 'contours') {
        for (const ct of d.contours) {
          const col = c.series[ct.reg % c.series.length];
          const path = (vs: number[][], width: number, alpha: number) => {
            ctx.strokeStyle = col;
            ctx.globalAlpha = alpha;
            ctx.lineWidth = width;
            ctx.beginPath();
            vs.forEach((v, k) => (k ? ctx.lineTo(v[0] * S, v[2] * S) : ctx.moveTo(v[0] * S, v[2] * S)));
            ctx.closePath();
            ctx.stroke();
          };
          path(ct.raw, 1, 0.6);
          path(ct.simple, 2.5, 1);
          ctx.fillStyle = c.ink;
          for (const v of ct.simple) ctx.fillRect(v[0] * S - 2, v[2] * S - 2, 4, 4);
        }
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
      }
      if (id === 'polys' || id === 'detail') {
        d.polys.forEach((p, k) => {
          ctx.beginPath();
          p.forEach((v, j) => (j ? ctx.lineTo(v[0] * S, v[2] * S) : ctx.moveTo(v[0] * S, v[2] * S)));
          ctx.closePath();
          ctx.fillStyle = c.series[d.polyRegs[k] % c.series.length];
          ctx.globalAlpha = id === 'polys' ? 0.35 : 0.12;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = c.ink;
          ctx.lineWidth = id === 'polys' ? 1.5 : 1;
          ctx.stroke();
        });
        if (id === 'detail') {
          ctx.strokeStyle = c.warn;
          ctx.globalAlpha = 0.8;
          for (const t of d.detailTris) {
            ctx.beginPath();
            ctx.moveTo(X(t[0][0]), Z(t[0][2]));
            ctx.lineTo(X(t[1][0]), Z(t[1][2]));
            ctx.lineTo(X(t[2][0]), Z(t[2][2]));
            ctx.closePath();
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        }
      }
    }
    // Scene outlines and labels, for orientation.
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1;
    ctx.font = `11px ${c.mono}`;
    ctx.fillStyle = c.muted;
    for (const b of BOXES) {
      ctx.strokeRect(X(b.x0), Z(b.z0), X(b.x1) - X(b.x0), Z(b.z1) - Z(b.z0));
      if (b.label) ctx.fillText(b.label, X(b.x0) + 2, Z(b.z0) - 3);
    }
    for (const r of RAMPS) {
      ctx.strokeRect(X(r.x0), Z(r.z0), X(r.x1) - X(r.x0), Z(r.z1) - Z(r.z0));
      ctx.fillText(r.label, X(r.x0) + 2, Z(r.z1) + 11);
    }
    // The cross-section line.
    ctx.strokeStyle = c.ink;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, Z(this.sliceZ));
    ctx.lineTo(W, Z(this.sliceZ));
    ctx.stroke();
    ctx.setLineDash([]);
    this.drawSide(d, c, S);
    const n = d.counts;
    const s = (v: string, l: string) => h('div', { class: 'll-stat' }, h('b', {}, v), h('span', {}, l));
    const totalMs = Object.values(d.ms).reduce((a, b) => a + b, 0);
    this.stats.replaceChildren(
      s(fmt(n.triangles), 'triangles in'),
      s(fmt(n.spans), 'solid spans'),
      s(fmt(n.compactSpans), 'open spans'),
      s(fmt(n.regions), 'regions'),
      s(`${fmt(n.rawVerts)} → ${fmt(n.simpleVerts)}`, 'contour vertices, raw → simplified'),
      s(fmt(n.polys), 'polygons'),
      s(`${fmt(totalMs, 1)} ms`, 'whole build, this browser'),
    );
  }

  /** A vertical slice through the scene at sliceZ: solid spans, open spans, and what's walkable. */
  private drawSide(d: Stages, c: ReturnType<typeof css>, S: number): void {
    const dpr = window.devicePixelRatio || 1;
    const W = d.w * S;
    const vh = 3.2; // metres shown
    const H = 150;
    this.side.width = W * dpr;
    this.side.height = H * dpr;
    this.side.style.width = `${W}px`;
    this.side.style.height = `${H}px`;
    const ctx = this.side.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    const row = Math.max(0, Math.min(d.h - 1, Math.floor((this.sliceZ - d.bmin[2]) / CS)));
    const yPx = (v: number) => H - 8 - ((v * CH + d.bmin[1] + 0.5) / vh) * (H - 16);
    const id = STAGES[this.stage].id;
    const solid = id === 'hf' ? d.spans : d.afterLowHeight;
    for (let x = 0; x < d.w; x++) {
      const i = row * d.w + x;
      // Solid spans.
      for (const [smin, smax, area] of solid[i]) {
        ctx.fillStyle = c.line;
        ctx.fillRect(x * S, yPx(smax), S, yPx(smin) - yPx(smax) + 1);
        if (id !== 'tris') {
          ctx.fillStyle = area ? c.good : c.alert;
          ctx.fillRect(x * S, yPx(smax) - 1, S, 2);
        }
      }
      // Open spans (compact heightfield onwards): the space a unit could stand in.
      if (['compact', 'erode', 'dist', 'regions', 'contours', 'polys', 'detail'].includes(id))
        for (const [y, hh, k] of d.cells[i]) {
          const top = Math.min(y + hh, y + Math.ceil(AGENT_HEIGHT / CH) + 4);
          const walk = id === 'compact' ? d.areasBeforeErode[k] : d.areas[k];
          const reg = d.regs[k];
          ctx.globalAlpha = walk ? 0.22 : 0.08;
          ctx.fillStyle = walk && (id === 'regions' || id === 'contours' || id === 'polys' || id === 'detail') && reg ? c.series[reg % c.series.length] : walk ? c.accent : c.muted;
          ctx.fillRect(x * S, yPx(top), S, yPx(y) - yPx(top));
          ctx.globalAlpha = 1;
        }
    }
    ctx.fillStyle = c.muted;
    ctx.font = `11px ${c.mono}`;
    ctx.fillText(`z = ${this.sliceZ.toFixed(1)} m`, 6, 14);
    void SCENE_W;
    void SCENE_D;
  }
}
