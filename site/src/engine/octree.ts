import { h, seg, fmt } from './dom';

/**
 * 3D octree over a small city of box buildings, used to pathfind an airship.
 * Free space is subdivided only where it touches geometry, so big empty air is
 * a few large leaves. A* runs over free leaves (neighbours share a face) and is
 * compared with A* over a uniform voxel grid at the octree's smallest cell size.
 * Drawn with a hand-rolled perspective projection; drag to orbit, scroll to zoom.
 */

const SIZE = 64; // world cube edge
interface B3 {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}
interface Leaf extends B3 {
  free: boolean;
  id: number;
}
interface ONode extends B3 {
  kids: ONode[] | null;
  leaf: Leaf | null;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function city(seed: number): B3[] {
  const r = rng(seed);
  const out: B3[] = [];
  // Blocks on a street grid, a few tall towers, and a bridge.
  for (let bx = 0; bx < 4; bx++)
    for (let bz = 0; bz < 4; bz++) {
      if (r() < 0.15) continue;
      const x = 3 + bx * 15 + r() * 3;
      const z = 3 + bz * 15 + r() * 3;
      const w = 6 + r() * 5;
      const d = 6 + r() * 5;
      const tall = r() < 0.2;
      out.push({ x0: x, y0: 0, z0: z, x1: x + w, y1: tall ? 40 + r() * 20 : 6 + r() * 20, z1: z + d });
    }
  out.push({ x0: 2, y0: 22, z0: 30, x1: 62, y1: 24, z1: 33 });
  return out;
}

const hit = (a: B3, b: B3) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1 && a.z0 < b.z1 && b.z0 < a.z1;
const inside = (a: B3, b: B3) => a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1 && a.z0 >= b.z0 && a.z1 <= b.z1;
const centre = (b: B3): [number, number, number] => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2];
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

class Octree {
  root: ONode;
  leaves: Leaf[] = [];
  edges: number[][] = [];
  nodes = 0;
  constructor(
    public obs: B3[],
    public min: number,
  ) {
    this.root = this.build({ x0: 0, y0: 0, z0: 0, x1: SIZE, y1: SIZE, z1: SIZE });
    this.link();
  }
  private build(b: B3): ONode {
    this.nodes++;
    const touching = this.obs.filter((o) => hit(o, b));
    const n: ONode = { ...b, kids: null, leaf: null };
    const s = b.x1 - b.x0;
    if (!touching.length || touching.some((o) => inside(b, o)) || s <= this.min) {
      n.leaf = { ...b, free: !touching.length, id: this.leaves.length };
      this.leaves.push(n.leaf);
      return n;
    }
    const m = s / 2;
    n.kids = [];
    for (let i = 0; i < 8; i++) {
      const x = b.x0 + (i & 1 ? m : 0);
      const y = b.y0 + (i & 2 ? m : 0);
      const z = b.z0 + (i & 4 ? m : 0);
      n.kids.push(this.build({ x0: x, y0: y, z0: z, x1: x + m, y1: y + m, z1: z + m }));
    }
    return n;
  }
  /** Leaves overlapping a box. */
  find(b: B3, out: Leaf[], n: ONode = this.root): void {
    if (!hit(n, b)) return;
    if (n.leaf) out.push(n.leaf);
    else for (const k of n.kids!) this.find(b, out, k);
  }
  leafAt(p: number[]): Leaf | null {
    let n = this.root;
    if (!(p[0] >= 0 && p[0] < SIZE && p[1] >= 0 && p[1] < SIZE && p[2] >= 0 && p[2] < SIZE)) return null;
    while (!n.leaf) {
      const m = (n.x0 + n.x1) / 2;
      const my = (n.y0 + n.y1) / 2;
      const mz = (n.z0 + n.z1) / 2;
      n = n.kids![(p[0] >= m ? 1 : 0) + (p[1] >= my ? 2 : 0) + (p[2] >= mz ? 4 : 0)];
    }
    return n.leaf;
  }
  /** Free leaves sharing a face: look just outside each face. */
  private link(): void {
    const e = 0.01;
    this.edges = this.leaves.map(() => []);
    for (const l of this.leaves) {
      if (!l.free) continue;
      const faces: B3[] = [
        { ...l, x0: l.x1, x1: l.x1 + e, y0: l.y0 + e, y1: l.y1 - e, z0: l.z0 + e, z1: l.z1 - e },
        { ...l, x0: l.x0 - e, x1: l.x0, y0: l.y0 + e, y1: l.y1 - e, z0: l.z0 + e, z1: l.z1 - e },
        { ...l, y0: l.y1, y1: l.y1 + e, x0: l.x0 + e, x1: l.x1 - e, z0: l.z0 + e, z1: l.z1 - e },
        { ...l, y0: l.y0 - e, y1: l.y0, x0: l.x0 + e, x1: l.x1 - e, z0: l.z0 + e, z1: l.z1 - e },
        { ...l, z0: l.z1, z1: l.z1 + e, x0: l.x0 + e, x1: l.x1 - e, y0: l.y0 + e, y1: l.y1 - e },
        { ...l, z0: l.z0 - e, z1: l.z0, x0: l.x0 + e, x1: l.x1 - e, y0: l.y0 + e, y1: l.y1 - e },
      ];
      for (const f of faces) {
        const found: Leaf[] = [];
        this.find(f, found);
        for (const m of found) if (m.free) this.edges[l.id].push(m.id);
      }
    }
  }
}

/** Binary-heap A*. Returns the path (node ids) and how many nodes were expanded. */
function astar(n: number, start: number, goal: number, nbrs: (i: number, out: number[]) => void, cost: (a: number, b: number) => number, hfn: (i: number) => number) {
  const g = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap: Array<[number, number]> = [];
  const push = (f: number, i: number) => {
    heap.push([f, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  g[start] = 0;
  push(hfn(start), start);
  const order: number[] = [];
  const buf: number[] = [];
  while (heap.length) {
    const [, i] = pop();
    if (closed[i]) continue;
    closed[i] = 1;
    order.push(i);
    if (i === goal) break;
    buf.length = 0;
    nbrs(i, buf);
    for (const j of buf) {
      if (closed[j]) continue;
      const ng = g[i] + cost(i, j);
      if (ng < g[j]) {
        g[j] = ng;
        from[j] = i;
        push(ng + hfn(j), j);
      }
    }
  }
  const path: number[] = [];
  if (closed[goal]) for (let k = goal; k !== -1; k = from[k]) path.unshift(k);
  return { path, expanded: order };
}

/** Does the segment a-b pass through any obstacle (slab test, slightly inflated)? */
function blocked(a: number[], b: number[], obs: B3[], pad = 0.3): boolean {
  for (const o of obs) {
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    for (let k = 0; k < 3 && ok; k++) {
      const lo = [o.x0, o.y0, o.z0][k] - pad;
      const hi = [o.x1, o.y1, o.z1][k] + pad;
      const d = b[k] - a[k];
      if (Math.abs(d) < 1e-9) {
        if (a[k] < lo || a[k] > hi) ok = false;
      } else {
        let u = (lo - a[k]) / d;
        let v = (hi - a[k]) / d;
        if (u > v) [u, v] = [v, u];
        t0 = Math.max(t0, u);
        t1 = Math.min(t1, v);
        if (t0 > t1) ok = false;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Greedy string pulling: from each point, jump to the furthest point still in line of sight. */
function smooth(pts: number[][], obs: B3[]): number[][] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && blocked(pts[i], pts[j], obs)) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

const plen = (p: number[][]) => p.reduce((s, q, i) => (i ? s + dist(p[i - 1], q) : 0), 0);

// ---------------------------------------------------------------------------

type Show = 'search' | 'free' | 'solid' | 'none';

export class OctreeLab {
  private root: HTMLElement;
  private cnv: HTMLCanvasElement;
  private seed = 4;
  private min = 2;
  private show: Show = 'search';
  private obs: B3[] = [];
  private tree!: Octree;
  private yaw = 0.7;
  private pitch = 0.5;
  private zoom = 1;
  private start = [2, 2, 2];
  private goal = [61, 3, 61];
  private raw: number[][] = [];
  private path: number[][] = [];
  private expanded: Leaf[] = [];
  private stats = h('div', { class: 'll-stats' });
  private gridStats = h('div', { class: 'll-stats' });
  private t = 0;
  private raf = 0;
  private visible = true;
  private lastT = 0;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll oc' });
    host.replaceChildren(this.root);
    this.cnv = h('canvas', { class: 'sp-canvas oc-canvas', width: '900', height: '600', 'aria-label': '3D view of the city and the octree; drag to orbit' });
    const min = seg<string>('Smallest cell', ['1', '2', '4'].map((v) => [v, v] as [string, string]), String(this.min), (v) => ((this.min = Number(v)), this.rebuild()));
    const show = seg<Show>(
      'Show',
      [
        ['search', 'Cells A* expanded'],
        ['free', 'Free space leaves'],
        ['solid', 'Solid leaves'],
        ['none', 'City only'],
      ],
      this.show,
      (v) => ((this.show = v), this.draw()),
    );
    this.root.append(
      h('div', { class: 'll-row' }, show.el),
      h(
        'div',
        { class: 'll-row' },
        min.el,
        h('button', { type: 'button', class: 'll-btn', onclick: () => ((this.seed++), this.rebuild()) }, 'New city'),
        h('button', { type: 'button', class: 'll-btn', onclick: () => this.newTrip() }, 'New trip'),
      ),
      this.cnv,
      h('div', { class: 'll-h' }, 'Octree'),
      this.stats,
      h('div', { class: 'll-h' }, `Uniform voxel grid at the same smallest cell size`),
      this.gridStats,
      h('p', { class: 'll-muted sp-note' }, 'Drag to orbit, scroll to zoom. Thin line: A* through cell centres. Thick line: after string pulling.'),
    );
    let drag: [number, number] | null = null;
    this.cnv.addEventListener('pointerdown', (e) => ((drag = [e.clientX, e.clientY]), this.cnv.setPointerCapture(e.pointerId)));
    this.cnv.addEventListener('pointerup', () => (drag = null));
    this.cnv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.yaw += (e.clientX - drag[0]) * 0.01;
      this.pitch = Math.max(-0.2, Math.min(1.45, this.pitch + (e.clientY - drag[1]) * 0.01));
      drag = [e.clientX, e.clientY];
      this.draw();
    });
    this.cnv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.max(0.5, Math.min(3, this.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      this.draw();
    }, { passive: false });
    new IntersectionObserver((es) => {
      this.visible = es.some((x) => x.isIntersecting);
      this.animate();
    }).observe(this.root);
    new MutationObserver(() => this.draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.rebuild();
  }

  private newTrip(): void {
    const r = rng(this.seed * 31 + Math.floor(Math.random() * 1e6));
    const pick = () => {
      for (;;) {
        const p = [1 + r() * 62, 1 + r() * 8, 1 + r() * 62];
        const l = this.tree.leafAt(p);
        if (l && l.free) return p;
      }
    };
    this.start = pick();
    do this.goal = pick();
    while (dist(this.start, this.goal) < 40);
    this.solve();
  }

  private rebuild(): void {
    this.obs = city(this.seed);
    const t0 = performance.now();
    this.tree = new Octree(this.obs, this.min);
    this.buildMs = performance.now() - t0;
    for (const p of [this.start, this.goal]) if (!this.tree.leafAt(p)?.free) return this.newTrip();
    this.solve();
  }
  private buildMs = 0;

  private solve(): void {
    const T = this.tree;
    const L = T.leaves;
    const s = T.leafAt(this.start)!;
    const g = T.leafAt(this.goal)!;
    const C = L.map(centre);
    const t0 = performance.now();
    const res = astar(
      L.length,
      s.id,
      g.id,
      (i, out) => out.push(...T.edges[i]),
      (a, b) => dist(C[a], C[b]),
      (i) => dist(C[i], this.goal),
    );
    const ms = performance.now() - t0;
    this.expanded = res.expanded.map((i) => L[i]);
    this.raw = res.path.length ? [this.start, ...res.path.slice(1, -1).map((i) => C[i]), this.goal] : [];
    this.path = smooth(this.raw, this.obs);
    const free = L.filter((l) => l.free).length;
    const edges = T.edges.reduce((a, e) => a + e.length, 0) / 2;
    const st = (v: string, l: string) => h('div', { class: 'll-stat' }, h('b', {}, v), h('span', {}, l));
    this.stats.replaceChildren(
      st(fmt(L.length), `leaves (${fmt(free)} free)`),
      st(fmt(edges), 'neighbour links'),
      st(`${fmt(this.buildMs, 1)} ms`, 'build + link'),
      st(fmt(res.expanded.length), 'cells expanded'),
      st(`${fmt(ms, 2)} ms`, 'A*'),
      st(this.raw.length ? `${fmt(plen(this.raw), 1)} → ${fmt(plen(this.path), 1)}` : 'no path', 'path length, raw → smoothed'),
    );
    this.solveGrid(st);
    this.draw();
    this.animate();
  }

  /** The same search on a uniform voxel grid of the smallest cell size, 6-connected. */
  private solveGrid(st: (v: string, l: string) => HTMLElement): void {
    const c = this.min;
    const n = SIZE / c;
    const N = n * n * n;
    const t0 = performance.now();
    const solid = new Uint8Array(N);
    for (const o of this.obs)
      for (let z = Math.floor(o.z0 / c); z < Math.ceil(o.z1 / c); z++)
        for (let y = Math.floor(o.y0 / c); y < Math.ceil(o.y1 / c); y++)
          for (let x = Math.floor(o.x0 / c); x < Math.ceil(o.x1 / c); x++) solid[(z * n + y) * n + x] = 1;
    const idx = (p: number[]) => (Math.floor(p[2] / c) * n + Math.floor(p[1] / c)) * n + Math.floor(p[0] / c);
    const xyz = (i: number) => [(i % n) + 0.5, (Math.floor(i / n) % n) + 0.5, Math.floor(i / (n * n)) + 0.5].map((v) => v * c);
    const build = performance.now() - t0;
    const t1 = performance.now();
    const gi = idx(this.goal);
    const gp = xyz(gi);
    const res = astar(
      N,
      idx(this.start),
      gi,
      (i, out) => {
        const x = i % n;
        const y = Math.floor(i / n) % n;
        const z = Math.floor(i / (n * n));
        if (x > 0 && !solid[i - 1]) out.push(i - 1);
        if (x < n - 1 && !solid[i + 1]) out.push(i + 1);
        if (y > 0 && !solid[i - n]) out.push(i - n);
        if (y < n - 1 && !solid[i + n]) out.push(i + n);
        if (z > 0 && !solid[i - n * n]) out.push(i - n * n);
        if (z < n - 1 && !solid[i + n * n]) out.push(i + n * n);
      },
      () => c,
      (i) => dist(xyz(i), gp),
    );
    const ms = performance.now() - t1;
    const free = N - solid.reduce((a, b) => a + b, 0);
    this.gridStats.replaceChildren(
      st(fmt(N), `cells (${fmt(free)} free)`),
      st(`${fmt(N / 1024, 0)} KB`, 'at one byte per cell'),
      st(`${fmt(build, 1)} ms`, 'build'),
      st(fmt(res.expanded.length), 'cells expanded'),
      st(`${fmt(ms, 2)} ms`, 'A*'),
      st(res.path.length ? fmt((res.path.length - 1) * c, 1) : 'no path', 'path length (6-connected)'),
    );
  }

  private animate(): void {
    cancelAnimationFrame(this.raf);
    if (!this.visible || this.path.length < 2) return;
    this.lastT = performance.now();
    const f = (now: number) => {
      this.t += (now - this.lastT) / 1000;
      this.lastT = now;
      this.draw();
      if (this.visible) this.raf = requestAnimationFrame(f);
    };
    this.raf = requestAnimationFrame(f);
  }

  private draw(): void {
    const ctx = this.cnv.getContext('2d')!;
    const W = this.cnv.width;
    const H = this.cnv.height;
    const cs = getComputedStyle(this.root);
    const col = (n: string) => cs.getPropertyValue(n).trim() || '#888';
    ctx.fillStyle = col('--bg');
    ctx.fillRect(0, 0, W, H);
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const camD = 130;
    const f = 760 * this.zoom;
    // World → camera: centre the cube, rotate by yaw (around y) then pitch (around x).
    const P = (x: number, y: number, z: number): [number, number, number] => {
      const X = x - SIZE / 2;
      const Y = y - SIZE / 3;
      const Z = z - SIZE / 2;
      const x1 = X * cy - Z * sy;
      const z1 = X * sy + Z * cy;
      const y2 = Y * cp + z1 * sp;
      const z2 = -Y * sp + z1 * cp + camD;
      return [W / 2 + (x1 * f) / z2, H / 2 - (y2 * f) / z2, z2];
    };
    const edgesOf = (b: B3) => {
      const v = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => P(i & 1 ? b.x1 : b.x0, i & 2 ? b.y1 : b.y0, i & 4 ? b.z1 : b.z0));
      ctx.moveTo(v[0][0], v[0][1]);
      for (const [a, c] of [
        [0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7],
      ]) {
        ctx.moveTo(v[a][0], v[a][1]);
        ctx.lineTo(v[c][0], v[c][1]);
      }
    };
    // Ground grid.
    ctx.strokeStyle = col('--line-soft');
    ctx.beginPath();
    for (let k = 0; k <= SIZE; k += 8) {
      let a = P(k, 0, 0);
      let b = P(k, 0, SIZE);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      a = P(0, 0, k);
      b = P(SIZE, 0, k);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    // Octree cells.
    const cells = this.show === 'search' ? this.expanded : this.show === 'free' ? this.tree.leaves.filter((l) => l.free) : this.show === 'solid' ? this.tree.leaves.filter((l) => !l.free) : [];
    if (cells.length) {
      ctx.strokeStyle = this.show === 'solid' ? col('--warn') : col('--accent');
      ctx.globalAlpha = this.show === 'search' ? 0.55 : 0.25;
      ctx.beginPath();
      for (const l of cells) edgesOf(l);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Buildings: painter's algorithm, far to near, three visible faces each.
    const raised = col('--raised');
    const line = col('--line');
    // Camera position in world space (the inverse of P at the eye), for face culling and sorting.
    const z1e = -camD * cp;
    const eye = [z1e * sy + SIZE / 2, camD * sp + SIZE / 3, z1e * cy + SIZE / 2];
    const order = [...this.obs].sort((a, b) => dist(centre(b), eye) - dist(centre(a), eye));
    for (const o of order) {
      const faces: Array<[number[][], number]> = [];
      const q = (pts: number[][]) => pts.map((p) => P(p[0], p[1], p[2]));
      if (eye[1] > o.y1) faces.push([q([[o.x0, o.y1, o.z0], [o.x1, o.y1, o.z0], [o.x1, o.y1, o.z1], [o.x0, o.y1, o.z1]]), 1]);
      if (eye[0] < o.x0) faces.push([q([[o.x0, o.y0, o.z0], [o.x0, o.y1, o.z0], [o.x0, o.y1, o.z1], [o.x0, o.y0, o.z1]]), 0.75]);
      if (eye[0] > o.x1) faces.push([q([[o.x1, o.y0, o.z0], [o.x1, o.y1, o.z0], [o.x1, o.y1, o.z1], [o.x1, o.y0, o.z1]]), 0.75]);
      if (eye[2] < o.z0) faces.push([q([[o.x0, o.y0, o.z0], [o.x1, o.y0, o.z0], [o.x1, o.y1, o.z0], [o.x0, o.y1, o.z0]]), 0.6]);
      if (eye[2] > o.z1) faces.push([q([[o.x0, o.y0, o.z1], [o.x1, o.y0, o.z1], [o.x1, o.y1, o.z1], [o.x0, o.y1, o.z1]]), 0.6]);
      for (const [pts, shade] of faces) {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.closePath();
        ctx.fillStyle = raised;
        ctx.globalAlpha = 0.55 + 0.35 * shade;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = line;
        ctx.stroke();
      }
    }
    // Paths.
    const poly = (pts: number[][], stroke: string, w: number, a: number) => {
      if (pts.length < 2) return;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = w;
      ctx.globalAlpha = a;
      ctx.beginPath();
      pts.forEach((p, i) => {
        const s = P(p[0], p[1], p[2]);
        if (i) ctx.lineTo(s[0], s[1]);
        else ctx.moveTo(s[0], s[1]);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    };
    poly(this.raw, col('--muted'), 1.5, 0.9);
    poly(this.path, col('--good'), 3, 1);
    const dot = (p: number[], c: string, r: number) => {
      const s = P(p[0], p[1], p[2]);
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      ctx.fill();
    };
    dot(this.start, col('--accent'), 6);
    dot(this.goal, col('--alert'), 6);
    // The airship, flying the smoothed path at a steady speed.
    const total = plen(this.path);
    if (total > 0) {
      let d = (this.t * 12) % total;
      for (let i = 1; i < this.path.length; i++) {
        const seg = dist(this.path[i - 1], this.path[i]);
        if (d <= seg) {
          const a = this.path[i - 1];
          const b = this.path[i];
          const u = d / seg;
          dot([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u], col('--ink'), 5);
          break;
        }
        d -= seg;
      }
    }
    ctx.fillStyle = col('--muted');
    ctx.font = `12px ${col('--f-mono')}`;
    ctx.fillText('start', P(...(this.start as [number, number, number]))[0] + 8, P(...(this.start as [number, number, number]))[1]);
    ctx.fillText('goal', P(...(this.goal as [number, number, number]))[0] + 8, P(...(this.goal as [number, number, number]))[1]);
  }
}
