import { h, seg, fmt } from './dom';

/**
 * Spatial partitioning lab. N moving circles in a 2D world, indexed by one of
 * five structures, answering one of two questions every frame:
 *   pairs: which objects overlap each other (a physics broadphase)
 *   query: which objects are within a radius of the cursor
 * The structure is drawn live, along with the work it did: cells or nodes
 * visited, candidate pairs tested, and (for sweep and prune) sort swaps.
 */

type Kind = 'brute' | 'grid' | 'quad' | 'bvh' | 'sap';
type Task = 'pairs' | 'query';
type Layout = 'uniform' | 'clustered' | 'sizes' | 'line';

const WW = 1000;
const WH = 625;

class Objs {
  n = 0;
  x = new Float32Array(0);
  y = new Float32Array(0);
  r = new Float32Array(0);
  vx = new Float32Array(0);
  vy = new Float32Array(0);
  hit = new Uint8Array(0);
  cand = new Uint8Array(0);

  init(n: number, layout: Layout, seed: number): void {
    let s = seed >>> 0;
    const rnd = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.n = n;
    for (const k of ['x', 'y', 'r', 'vx', 'vy'] as const) this[k] = new Float32Array(n);
    this.hit = new Uint8Array(n);
    this.cand = new Uint8Array(n);
    // Object size shrinks as the count grows, so density stays watchable.
    const base = Math.max(2, 9 * Math.sqrt(300 / n));
    const centres = Array.from({ length: 5 }, () => [100 + rnd() * (WW - 200), 80 + rnd() * (WH - 160)]);
    for (let i = 0; i < n; i++) {
      let x: number;
      let y: number;
      let r = base * (0.6 + rnd() * 0.8);
      if (layout === 'clustered' && i % 10 !== 0) {
        const c = centres[i % centres.length];
        const a = rnd() * Math.PI * 2;
        const d = Math.pow(rnd(), 0.7) * 70;
        x = c[0] + Math.cos(a) * d;
        y = c[1] + Math.sin(a) * d;
      } else if (layout === 'line') {
        x = 40 + rnd() * 30;
        y = 10 + rnd() * (WH - 20);
      } else {
        x = rnd() * WW;
        y = rnd() * WH;
      }
      if (layout === 'sizes' && i % 25 === 0) r = base * (5 + rnd() * 8);
      const sp = 20 + rnd() * 40;
      const a = rnd() * Math.PI * 2;
      this.x[i] = x;
      this.y[i] = y;
      this.r[i] = r;
      this.vx[i] = layout === 'line' ? (rnd() - 0.5) * 6 : Math.cos(a) * sp;
      this.vy[i] = Math.sin(a) * sp;
    }
  }

  step(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      let x = this.x[i] + this.vx[i] * dt;
      let y = this.y[i] + this.vy[i] * dt;
      const r = this.r[i];
      if (x < r) ((x = r), (this.vx[i] = Math.abs(this.vx[i])));
      if (x > WW - r) ((x = WW - r), (this.vx[i] = -Math.abs(this.vx[i])));
      if (y < r) ((y = r), (this.vy[i] = Math.abs(this.vy[i])));
      if (y > WH - r) ((y = WH - r), (this.vy[i] = -Math.abs(this.vy[i])));
      this.x[i] = x;
      this.y[i] = y;
    }
  }
}

interface Work {
  /** Cells or nodes touched, by the update and by the query. */
  build: number;
  visited: number;
  /** Narrow-phase tests (circle against circle or circle against query). */
  tests: number;
  /** Results: overlapping pairs, or objects in range. */
  found: number;
  /** Sweep and prune only: insertion-sort swaps this frame. */
  swaps: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Index {
  update(o: Objs, w: Work): void;
  pairs(o: Objs, w: Work): void;
  query(o: Objs, qx: number, qy: number, qr: number, w: Work, visited: Box[]): void;
  draw(ctx: CanvasRenderingContext2D, S: number, col: Cols, o: Objs): void;
}

interface Cols {
  line: string;
  soft: string;
  accent: string;
  warn: string;
  alert: string;
  muted: string;
  ink: string;
  bg: string;
  good: string;
}

const overlap = (o: Objs, i: number, j: number) => {
  const dx = o.x[i] - o.x[j];
  const dy = o.y[i] - o.y[j];
  const rr = o.r[i] + o.r[j];
  return dx * dx + dy * dy < rr * rr;
};
const inRange = (o: Objs, i: number, qx: number, qy: number, qr: number) => {
  const dx = o.x[i] - qx;
  const dy = o.y[i] - qy;
  const rr = o.r[i] + qr;
  return dx * dx + dy * dy < rr * rr;
};
function testPair(o: Objs, i: number, j: number, w: Work): void {
  w.tests++;
  o.cand[i] = o.cand[j] = 1;
  if (overlap(o, i, j)) {
    o.hit[i] = o.hit[j] = 1;
    w.found++;
  }
}
function testQuery(o: Objs, i: number, qx: number, qy: number, qr: number, w: Work): void {
  w.tests++;
  o.cand[i] = 1;
  if (inRange(o, i, qx, qy, qr)) {
    o.hit[i] = 1;
    w.found++;
  }
}

// ---------------------------------------------------------------------------

class Brute implements Index {
  update(): void {}
  pairs(o: Objs, w: Work): void {
    for (let i = 0; i < o.n; i++) for (let j = i + 1; j < o.n; j++) testPair(o, i, j, w);
  }
  query(o: Objs, qx: number, qy: number, qr: number, w: Work): void {
    for (let i = 0; i < o.n; i++) testQuery(o, i, qx, qy, qr, w);
  }
  draw(): void {}
}

/** Uniform grid, rebuilt every frame with a counting sort: objects go into every cell their box overlaps. */
class Grid implements Index {
  cols = 0;
  rows = 0;
  start = new Int32Array(0);
  items = new Int32Array(0);
  constructor(public cell: number) {}

  private range(o: Objs, i: number): [number, number, number, number] {
    const c = this.cell;
    return [
      Math.max(0, Math.floor((o.x[i] - o.r[i]) / c)),
      Math.max(0, Math.floor((o.y[i] - o.r[i]) / c)),
      Math.min(this.cols - 1, Math.floor((o.x[i] + o.r[i]) / c)),
      Math.min(this.rows - 1, Math.floor((o.y[i] + o.r[i]) / c)),
    ];
  }

  update(o: Objs, w: Work): void {
    this.cols = Math.ceil(WW / this.cell);
    this.rows = Math.ceil(WH / this.cell);
    const nc = this.cols * this.rows;
    const count = new Int32Array(nc + 1);
    let total = 0;
    for (let i = 0; i < o.n; i++) {
      const [x0, y0, x1, y1] = this.range(o, i);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) (count[y * this.cols + x + 1]++, total++);
    }
    for (let c = 0; c < nc; c++) count[c + 1] += count[c];
    this.start = count;
    this.items = new Int32Array(total);
    const fill = count.slice(0, nc);
    for (let i = 0; i < o.n; i++) {
      const [x0, y0, x1, y1] = this.range(o, i);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.items[fill[y * this.cols + x]++] = i;
    }
    w.build += total;
  }

  pairs(o: Objs, w: Work): void {
    const c = this.cell;
    for (let cell = 0; cell < this.cols * this.rows; cell++) {
      const a = this.start[cell];
      const b = this.start[cell + 1];
      if (b - a < 2) continue;
      w.visited++;
      const cx = cell % this.cols;
      const cy = (cell / this.cols) | 0;
      for (let p = a; p < b; p++)
        for (let q = p + 1; q < b; q++) {
          const i = this.items[p];
          const j = this.items[q];
          // A pair that shares several cells is tested only in the first one they share.
          const fx = Math.floor(Math.max(o.x[i] - o.r[i], o.x[j] - o.r[j]) / c);
          const fy = Math.floor(Math.max(o.y[i] - o.r[i], o.y[j] - o.r[j]) / c);
          if (Math.max(0, fx) !== cx || Math.max(0, fy) !== cy) continue;
          testPair(o, i, j, w);
        }
    }
  }

  query(o: Objs, qx: number, qy: number, qr: number, w: Work, vis: Box[]): void {
    const c = this.cell;
    const x0 = Math.max(0, Math.floor((qx - qr) / c));
    const y0 = Math.max(0, Math.floor((qy - qr) / c));
    const x1 = Math.min(this.cols - 1, Math.floor((qx + qr) / c));
    const y1 = Math.min(this.rows - 1, Math.floor((qy + qr) / c));
    const seen = new Uint8Array(o.n);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        w.visited++;
        vis.push({ x0: x * c, y0: y * c, x1: (x + 1) * c, y1: (y + 1) * c });
        const cell = y * this.cols + x;
        for (let p = this.start[cell]; p < this.start[cell + 1]; p++) {
          const i = this.items[p];
          if (seen[i]) continue;
          seen[i] = 1;
          testQuery(o, i, qx, qy, qr, w);
        }
      }
  }

  draw(ctx: CanvasRenderingContext2D, S: number, col: Cols): void {
    const c = this.cell;
    let max = 1;
    for (let k = 0; k < this.cols * this.rows; k++) max = Math.max(max, this.start[k + 1] - this.start[k]);
    ctx.fillStyle = col.accent;
    for (let y = 0; y < this.rows; y++)
      for (let x = 0; x < this.cols; x++) {
        const k = y * this.cols + x;
        const n = this.start[k + 1] - this.start[k];
        if (!n) continue;
        ctx.globalAlpha = 0.04 + 0.22 * (n / max);
        ctx.fillRect(x * c * S, y * c * S, c * S, c * S);
      }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = col.soft;
    ctx.beginPath();
    for (let x = 0; x <= this.cols; x++) ((ctx.moveTo(x * c * S + 0.5, 0), ctx.lineTo(x * c * S + 0.5, WH * S)));
    for (let y = 0; y <= this.rows; y++) ((ctx.moveTo(0, y * c * S + 0.5), ctx.lineTo(WW * S, y * c * S + 0.5)));
    ctx.stroke();
  }
}

/** Quadtree, rebuilt every frame. Objects live in the deepest node that fully contains them. */
interface QNode extends Box {
  items: number[];
  kids: QNode[] | null;
  depth: number;
}
class Quad implements Index {
  root!: QNode;
  constructor(
    public cap: number,
    public maxDepth = 8,
  ) {}

  update(o: Objs, w: Work): void {
    this.root = { x0: 0, y0: 0, x1: WW, y1: WH, items: [], kids: null, depth: 0 };
    for (let i = 0; i < o.n; i++) this.insert(this.root, o, i, w);
  }
  private insert(n: QNode, o: Objs, i: number, w: Work): void {
    w.build++;
    if (n.kids) {
      const k = this.child(n, o, i);
      if (k) return this.insert(k, o, i, w);
      n.items.push(i);
      return;
    }
    n.items.push(i);
    if (n.items.length > this.cap && n.depth < this.maxDepth) {
      const mx = (n.x0 + n.x1) / 2;
      const my = (n.y0 + n.y1) / 2;
      const d = n.depth + 1;
      n.kids = [
        { x0: n.x0, y0: n.y0, x1: mx, y1: my, items: [], kids: null, depth: d },
        { x0: mx, y0: n.y0, x1: n.x1, y1: my, items: [], kids: null, depth: d },
        { x0: n.x0, y0: my, x1: mx, y1: n.y1, items: [], kids: null, depth: d },
        { x0: mx, y0: my, x1: n.x1, y1: n.y1, items: [], kids: null, depth: d },
      ];
      const old = n.items;
      n.items = [];
      for (const j of old) {
        const k = this.child(n, o, j);
        if (k) this.insert(k, o, j, w);
        else n.items.push(j);
      }
    }
  }
  /** The child that fully contains object i, if any. */
  private child(n: QNode, o: Objs, i: number): QNode | null {
    const mx = (n.x0 + n.x1) / 2;
    const my = (n.y0 + n.y1) / 2;
    const x = o.x[i];
    const y = o.y[i];
    const r = o.r[i];
    const left = x + r < mx;
    const right = x - r >= mx;
    const top = y + r < my;
    const bottom = y - r >= my;
    if (!(left || right) || !(top || bottom)) return null;
    return n.kids![(bottom ? 2 : 0) + (right ? 1 : 0)];
  }

  pairs(o: Objs, w: Work): void {
    const stack: number[] = [];
    const walk = (n: QNode) => {
      w.visited++;
      // Objects here against each other and against everything held by ancestors.
      for (let a = 0; a < n.items.length; a++) {
        const i = n.items[a];
        for (let b = a + 1; b < n.items.length; b++) testPair(o, i, n.items[b], w);
        for (const j of stack) testPair(o, i, j, w);
      }
      if (n.kids) {
        const len = stack.length;
        for (const i of n.items) stack.push(i);
        for (const k of n.kids) walk(k);
        stack.length = len;
      }
    };
    walk(this.root);
  }

  query(o: Objs, qx: number, qy: number, qr: number, w: Work, vis: Box[]): void {
    const walk = (n: QNode) => {
      if (qx + qr < n.x0 || qx - qr > n.x1 || qy + qr < n.y0 || qy - qr > n.y1) return;
      w.visited++;
      vis.push(n);
      for (const i of n.items) testQuery(o, i, qx, qy, qr, w);
      if (n.kids) for (const k of n.kids) walk(k);
    };
    walk(this.root);
  }

  draw(ctx: CanvasRenderingContext2D, S: number, col: Cols): void {
    ctx.strokeStyle = col.line;
    ctx.lineWidth = 1;
    const walk = (n: QNode) => {
      ctx.strokeRect(n.x0 * S + 0.5, n.y0 * S + 0.5, (n.x1 - n.x0) * S, (n.y1 - n.y0) * S);
      if (n.kids) for (const k of n.kids) walk(k);
    };
    walk(this.root);
  }
}

/** Bounding volume hierarchy: built top-down by median split, then either rebuilt or refitted each frame. */
interface BNode extends Box {
  l: BNode | null;
  r: BNode | null;
  items: number[] | null;
  depth: number;
}
class Bvh implements Index {
  root: BNode | null = null;
  age = 0;
  constructor(
    public refit: boolean,
    public leaf = 4,
  ) {}

  update(o: Objs, w: Work): void {
    if (!this.root || !this.refit || this.age >= 600) {
      const idx = Array.from({ length: o.n }, (_, i) => i);
      this.root = this.build(o, idx, 0, w);
      this.age = 0;
    } else {
      this.fit(this.root, o, w);
      this.age++;
    }
  }
  private build(o: Objs, idx: number[], depth: number, w: Work): BNode {
    w.build++;
    const n: BNode = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, l: null, r: null, items: null, depth };
    for (const i of idx) this.grow(n, o, i);
    if (idx.length <= this.leaf) {
      n.items = idx;
      return n;
    }
    const byX = n.x1 - n.x0 > n.y1 - n.y0;
    const key = byX ? o.x : o.y;
    idx.sort((a, b) => key[a] - key[b]);
    w.build += idx.length;
    const m = idx.length >> 1;
    n.l = this.build(o, idx.slice(0, m), depth + 1, w);
    n.r = this.build(o, idx.slice(m), depth + 1, w);
    return n;
  }
  private grow(n: Box, o: Objs, i: number): void {
    n.x0 = Math.min(n.x0, o.x[i] - o.r[i]);
    n.y0 = Math.min(n.y0, o.y[i] - o.r[i]);
    n.x1 = Math.max(n.x1, o.x[i] + o.r[i]);
    n.y1 = Math.max(n.y1, o.y[i] + o.r[i]);
  }
  private fit(n: BNode, o: Objs, w: Work): void {
    w.build++;
    n.x0 = n.y0 = Infinity;
    n.x1 = n.y1 = -Infinity;
    if (n.items) for (const i of n.items) this.grow(n, o, i);
    else {
      this.fit(n.l!, o, w);
      this.fit(n.r!, o, w);
      for (const k of [n.l!, n.r!]) ((n.x0 = Math.min(n.x0, k.x0)), (n.y0 = Math.min(n.y0, k.y0)), (n.x1 = Math.max(n.x1, k.x1)), (n.y1 = Math.max(n.y1, k.y1)));
    }
  }

  pairs(o: Objs, w: Work): void {
    const hit = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
    const cross = (a: BNode, b: BNode) => {
      w.visited++;
      if (!hit(a, b)) return;
      if (a.items && b.items) {
        for (const i of a.items) for (const j of b.items) testPair(o, i, j, w);
      } else if (a.items || (b.l && (b.x1 - b.x0) * (b.y1 - b.y0) > (a.x1 - a.x0) * (a.y1 - a.y0))) {
        cross(a, b.l!);
        cross(a, b.r!);
      } else {
        cross(a.l!, b);
        cross(a.r!, b);
      }
    };
    const self = (n: BNode) => {
      w.visited++;
      if (n.items) {
        for (let p = 0; p < n.items.length; p++) for (let q = p + 1; q < n.items.length; q++) testPair(o, n.items[p], n.items[q], w);
        return;
      }
      self(n.l!);
      self(n.r!);
      cross(n.l!, n.r!);
    };
    self(this.root!);
  }

  query(o: Objs, qx: number, qy: number, qr: number, w: Work, vis: Box[]): void {
    const walk = (n: BNode) => {
      w.visited++;
      if (qx + qr < n.x0 || qx - qr > n.x1 || qy + qr < n.y0 || qy - qr > n.y1) return;
      vis.push(n);
      if (n.items) for (const i of n.items) testQuery(o, i, qx, qy, qr, w);
      else (walk(n.l!), walk(n.r!));
    };
    walk(this.root!);
  }

  /** Total area of all node boxes relative to the world: grows as a refitted tree degrades. */
  area(): number {
    let a = 0;
    const walk = (n: BNode) => {
      a += (n.x1 - n.x0) * (n.y1 - n.y0);
      if (n.l) (walk(n.l), walk(n.r!));
    };
    if (this.root) walk(this.root);
    return a / (WW * WH);
  }

  draw(ctx: CanvasRenderingContext2D, S: number, col: Cols): void {
    const walk = (n: BNode) => {
      if (n.depth > 0) {
        ctx.strokeStyle = n.items ? col.soft : col.line;
        ctx.globalAlpha = n.items ? 0.9 : Math.max(0.25, 1 - n.depth * 0.08);
        ctx.strokeRect(n.x0 * S + 0.5, n.y0 * S + 0.5, (n.x1 - n.x0) * S, (n.y1 - n.y0) * S);
      }
      if (n.l) (walk(n.l), walk(n.r!));
    };
    if (this.root) walk(this.root);
    ctx.globalAlpha = 1;
  }
}

/** Sweep and prune on x: a list sorted by left edge, kept sorted by insertion sort (cheap when little moved). */
class Sap implements Index {
  order: number[] = [];
  update(o: Objs, w: Work): void {
    const lo = (i: number) => o.x[i] - o.r[i];
    if (this.order.length !== o.n) {
      // First frame: a full sort. After that, objects move a little and insertion sort is nearly free.
      this.order = Array.from({ length: o.n }, (_, i) => i).sort((a, b) => lo(a) - lo(b));
      w.build += Math.round(o.n * Math.log2(o.n));
    }
    const ord = this.order;
    for (let a = 1; a < ord.length; a++) {
      const v = ord[a];
      const k = lo(v);
      let b = a - 1;
      while (b >= 0 && lo(ord[b]) > k) {
        ord[b + 1] = ord[b];
        b--;
        w.swaps++;
      }
      ord[b + 1] = v;
    }
    w.build += o.n;
  }
  pairs(o: Objs, w: Work): void {
    const ord = this.order;
    for (let a = 0; a < ord.length; a++) {
      const i = ord[a];
      const right = o.x[i] + o.r[i];
      w.visited++;
      for (let b = a + 1; b < ord.length; b++) {
        const j = ord[b];
        if (o.x[j] - o.r[j] > right) break; // sorted: nothing further can overlap on x
        // Overlap on x; check y before the real test.
        if (Math.abs(o.y[i] - o.y[j]) > o.r[i] + o.r[j]) {
          w.tests++;
          o.cand[i] = o.cand[j] = 1;
          continue;
        }
        testPair(o, i, j, w);
      }
    }
  }
  query(o: Objs, qx: number, qy: number, qr: number, w: Work, vis: Box[]): void {
    const ord = this.order;
    // Binary search for the first object whose left edge could be in range. Objects are at most maxR wide.
    let maxR = 0;
    for (let i = 0; i < o.n; i++) maxR = Math.max(maxR, o.r[i]);
    let lo = 0;
    let hi = ord.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      w.visited++;
      if (o.x[ord[m]] - o.r[ord[m]] < qx - qr - 2 * maxR) lo = m + 1;
      else hi = m;
    }
    for (let a = lo; a < ord.length; a++) {
      const i = ord[a];
      if (o.x[i] - o.r[i] > qx + qr) break;
      testQuery(o, i, qx, qy, qr, w);
    }
    vis.push({ x0: qx - qr - 2 * maxR, y0: 0, x1: qx + qr, y1: WH });
  }
  draw(ctx: CanvasRenderingContext2D, S: number, col: Cols, o: Objs): void {
    // Each object's x interval, as ticks along the bottom edge.
    ctx.strokeStyle = col.line;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    for (let i = 0; i < o.n; i++) {
      const y = WH * S - 3 - (i % 6) * 3;
      ctx.moveTo((o.x[i] - o.r[i]) * S, y);
      ctx.lineTo((o.x[i] + o.r[i]) * S, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------

const NAMES: Record<Kind, string> = { brute: 'Brute force', grid: 'Uniform grid', quad: 'Quadtree', bvh: 'BVH', sap: 'Sweep and prune' };

export class SpatialLab {
  private root: HTMLElement;
  private cnv: HTMLCanvasElement;
  private o = new Objs();
  private kind: Kind = 'grid';
  private task: Task = 'query';
  private layout: Layout = 'uniform';
  private count = 1000;
  private cell = 40;
  private cap = 8;
  private refit = false;
  private moving = true;
  private idx!: Index;
  private q = { x: WW * 0.45, y: WH * 0.5, r: 70 };
  private vis: Box[] = [];
  private w: Work = { build: 0, visited: 0, tests: 0, found: 0, swaps: 0 };
  private ms = { update: 0, task: 0 };
  private samples = 0;
  private stats = h('div', { class: 'll-stats' });
  private params = h('div', { class: 'll-row' });
  private note = h('p', { class: 'll-muted sp-note' });
  private raf = 0;
  private visible = true;
  private last = 0;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'll sp' });
    host.replaceChildren(this.root);
    this.cnv = h('canvas', { class: 'sp-canvas', width: '1000', height: '625', 'aria-label': 'Objects and the spatial structure' });
    const kind = seg<Kind>('Structure', (Object.keys(NAMES) as Kind[]).map((k) => [k, NAMES[k]]), this.kind, (v) => ((this.kind = v), this.rebuild()));
    const task = seg<Task>(
      'Question',
      [
        ['query', 'What is near the cursor?'],
        ['pairs', 'Which objects overlap? (all pairs)'],
      ],
      this.task,
      (v) => ((this.task = v), (this.samples = 0), this.frame()),
    );
    const count = seg<string>('Objects', ['200', '1000', '5000'].map((v) => [v, v] as [string, string]), String(this.count), (v) => ((this.count = Number(v)), this.reset()));
    const layout = seg<Layout>(
      'Layout',
      [
        ['uniform', 'Even'],
        ['clustered', 'Clustered'],
        ['sizes', 'A few big ones'],
        ['line', 'All in a column'],
      ],
      this.layout,
      (v) => ((this.layout = v), this.reset()),
    );
    const move = h('input', { type: 'checkbox', checked: true });
    move.addEventListener('change', () => ((this.moving = move.checked), this.loop()));
    this.root.append(
      h('div', { class: 'll-row' }, kind.el),
      h('div', { class: 'll-row' }, task.el),
      h('div', { class: 'll-row' }, count.el, layout.el, h('label', { class: 'sp-check' }, move, 'Moving')),
      this.params,
      this.cnv,
      this.stats,
      this.note,
    );
    const pick = (e: PointerEvent) => {
      const r = this.cnv.getBoundingClientRect();
      this.q.x = ((e.clientX - r.left) / r.width) * WW;
      this.q.y = ((e.clientY - r.top) / r.height) * WH;
      if (!this.moving) this.frame();
    };
    this.cnv.addEventListener('pointermove', pick);
    this.cnv.addEventListener('pointerdown', pick);
    this.cnv.addEventListener('wheel', (e) => {
      if (this.task !== 'query') return;
      e.preventDefault();
      this.q.r = Math.max(10, Math.min(300, this.q.r * (e.deltaY > 0 ? 0.9 : 1.1)));
      if (!this.moving) this.frame();
    }, { passive: false });
    new IntersectionObserver((es) => {
      this.visible = es.some((x) => x.isIntersecting);
      this.loop();
    }).observe(this.root);
    new MutationObserver(() => this.frame()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.reset();
  }

  private reset(): void {
    this.o.init(this.count, this.layout, 7);
    this.rebuild();
  }

  private rebuild(): void {
    this.samples = 0;
    this.idx =
      this.kind === 'brute' ? new Brute() : this.kind === 'grid' ? new Grid(this.cell) : this.kind === 'quad' ? new Quad(this.cap) : this.kind === 'bvh' ? new Bvh(this.refit) : new Sap();
    const p: HTMLElement[] = [];
    if (this.kind === 'grid')
      p.push(seg<string>('Cell size', ['10', '20', '40', '80', '160'].map((v) => [v, v] as [string, string]), String(this.cell), (v) => ((this.cell = Number(v)), this.rebuild())).el);
    if (this.kind === 'quad')
      p.push(seg<string>('Max per leaf', ['2', '8', '32'].map((v) => [v, v] as [string, string]), String(this.cap), (v) => ((this.cap = Number(v)), this.rebuild())).el);
    if (this.kind === 'bvh')
      p.push(
        seg<'rebuild' | 'refit'>(
          'Each frame',
          [
            ['rebuild', 'Rebuild'],
            ['refit', 'Refit (rebuild every 10 s)'],
          ],
          this.refit ? 'refit' : 'rebuild',
          (v) => ((this.refit = v === 'refit'), this.rebuild()),
        ).el,
      );
    this.params.replaceChildren(...p);
    this.params.hidden = !p.length;
    this.frame();
    this.loop();
  }

  private loop(): void {
    cancelAnimationFrame(this.raf);
    if (!this.moving || !this.visible) return;
    this.last = performance.now();
    const f = (t: number) => {
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      this.o.step(dt);
      this.frame();
      if (this.moving && this.visible) this.raf = requestAnimationFrame(f);
    };
    this.raf = requestAnimationFrame(f);
  }

  private frame(): void {
    const o = this.o;
    o.hit.fill(0);
    o.cand.fill(0);
    const w: Work = { build: 0, visited: 0, tests: 0, found: 0, swaps: 0 };
    this.vis = [];
    const t0 = performance.now();
    this.idx.update(o, w);
    const t1 = performance.now();
    if (this.task === 'pairs') this.idx.pairs(o, w);
    else this.idx.query(o, this.q.x, this.q.y, this.q.r, w, this.vis);
    const t2 = performance.now();
    // Smooth the timings while moving so they're readable; take single frames as they are.
    const k = this.moving && this.samples++ > 0 ? 0.1 : 1;
    this.ms.update += (t1 - t0 - this.ms.update) * k;
    this.ms.task += (t2 - t1 - this.ms.task) * k;
    this.w = w;
    this.draw();
    this.report();
  }

  private col(): Cols {
    const cs = getComputedStyle(this.root);
    const g = (n: string) => cs.getPropertyValue(n).trim() || '#888';
    return { line: g('--line'), soft: g('--line-soft'), accent: g('--accent'), warn: g('--warn'), alert: g('--alert'), muted: g('--muted'), ink: g('--ink'), bg: g('--bg'), good: g('--good') };
  }

  private draw(): void {
    const ctx = this.cnv.getContext('2d')!;
    const S = this.cnv.width / WW;
    const col = this.col();
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, this.cnv.width, this.cnv.height);
    this.idx.draw(ctx, S, col, this.o);
    // Cells / nodes the query visited.
    ctx.strokeStyle = col.accent;
    ctx.fillStyle = col.accent;
    for (const b of this.vis) {
      // Fill only small boxes: big ones (the root, the upper levels) would shade everything.
      if ((b.x1 - b.x0) * (b.y1 - b.y0) < WW * WH * 0.1) {
        ctx.globalAlpha = 0.07;
        ctx.fillRect(b.x0 * S, b.y0 * S, (b.x1 - b.x0) * S, (b.y1 - b.y0) * S);
      }
      ctx.globalAlpha = 0.7;
      ctx.strokeRect(b.x0 * S + 0.5, b.y0 * S + 0.5, (b.x1 - b.x0) * S, (b.y1 - b.y0) * S);
    }
    ctx.globalAlpha = 1;
    // Objects: plain, tested (candidate), or hit.
    const o = this.o;
    const draw = (sel: (i: number) => boolean, fill: string, alpha: number) => {
      ctx.fillStyle = fill;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      for (let i = 0; i < o.n; i++) {
        if (!sel(i)) continue;
        ctx.moveTo((o.x[i] + o.r[i]) * S, o.y[i] * S);
        ctx.arc(o.x[i] * S, o.y[i] * S, Math.max(1, o.r[i] * S), 0, Math.PI * 2);
      }
      ctx.fill();
    };
    draw((i) => !o.cand[i] && !o.hit[i], col.muted, 0.55);
    draw((i) => !!o.cand[i] && !o.hit[i], col.warn, 0.85);
    draw((i) => !!o.hit[i], this.task === 'pairs' ? col.alert : col.good, 1);
    ctx.globalAlpha = 1;
    if (this.task === 'query') {
      // Tested objects nowhere near the query: they were only tested because the structure
      // keeps them in a big node the query overlaps (objects stuck on a quadtree split line).
      const q = this.q;
      ctx.strokeStyle = col.alert;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < o.n; i++) {
        if (!o.cand[i] || o.hit[i]) continue;
        const far = Math.hypot(o.x[i] - q.x, o.y[i] - q.y) > q.r * 1.6 + o.r[i];
        if (!far) continue;
        const rr = Math.max(3, o.r[i] * S + 3);
        ctx.moveTo(o.x[i] * S + rr, o.y[i] * S);
        ctx.arc(o.x[i] * S, o.y[i] * S, rr, 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.strokeStyle = col.ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.q.x * S, this.q.y * S, this.q.r * S, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  private report(): void {
    const w = this.w;
    const n = this.o.n;
    const brute = this.task === 'pairs' ? (n * (n - 1)) / 2 : n;
    const s = (v: string, l: string, title?: string) => h('div', { class: 'll-stat', title }, h('b', {}, v), h('span', {}, l));
    const kids = [
      s(fmt(w.tests), this.task === 'pairs' ? 'pair tests' : 'objects tested', 'Narrow-phase checks: circle against circle, or circle against the query'),
      s(`${fmt((w.tests / brute) * 100, w.tests / brute < 0.01 ? 2 : 1)}%`, 'of brute force'),
      s(fmt(w.found), this.task === 'pairs' ? 'overlapping pairs' : 'in range'),
      s(fmt(w.visited), this.kind === 'grid' ? 'cells visited' : this.kind === 'sap' ? 'list steps' : 'nodes visited'),
      s(fmt(w.build), this.kind === 'sap' ? 'objects re-sorted' : this.kind === 'brute' ? 'build work' : 'build / update steps'),
    ];
    if (this.kind === 'sap') kids.push(s(fmt(w.swaps), 'sort swaps'));
    if (this.idx instanceof Bvh) kids.push(s(`${fmt(this.idx.area(), 1)}×`, 'node area / world', 'Sum of every node box: higher means more overlap and more wasted visits'));
    kids.push(s(`${fmt(this.ms.update, 2)} + ${fmt(this.ms.task, 2)} ms`, 'update + question, this browser'));
    this.stats.replaceChildren(...kids);
    this.note.textContent =
      this.task === 'query'
        ? 'Move the pointer over the field, or drag on a touch screen (scroll to resize the circle). Shaded boxes: what the structure visited. Yellow: objects it had to test. Green: actually in range. Ringed in red: tested even though they\'re nowhere near, because the structure keeps them in a big node the query overlaps (in a quadtree, objects stuck on a split line, held by the root or another large node).'
        : 'Red: objects that overlap something. Yellow: objects that were tested but overlap nothing. The fewer yellow, the less wasted work.';
  }
}
