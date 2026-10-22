/// <reference lib="webworker" />
/**
 * Memory benchmarks in plain JavaScript typed arrays. The JIT turns these loops
 * into straightforward machine code, so the cache effects show through clearly.
 * Each test repeats until enough time has passed to measure (browsers coarsen clocks).
 */

const now = () => performance.now();
function time(fn: () => number, minMs = 60): { ms: number; sink: number } {
  let reps = 0;
  let sink = 0;
  fn(); // warm up the JIT
  const t0 = now();
  do {
    sink += fn();
    reps++;
  } while (now() - t0 < minMs);
  return { ms: (now() - t0) / reps, sink };
}

type Req = { kind: 'layout'; n: number } | { kind: 'order'; n: number } | { kind: 'stride'; n: number };

function layout(n: number) {
  // A 48-byte unit: x, y, vx, vy, hp, armour, colour, id, ai[4] (12 floats).
  const S = 12;
  const aos = new Float32Array(n * S);
  for (let i = 0; i < n * S; i++) aos[i] = (i % 7) * 0.5;
  const x = new Float32Array(n), y = new Float32Array(n), vx = new Float32Array(n), vy = new Float32Array(n), hp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = i;
    y[i] = i * 0.5;
    vx[i] = 1;
    vy[i] = 0.5;
    hp[i] = 100;
  }
  const hot = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) hot[i] = i % 5;
  const cold = new Float32Array(n * 8);
  for (let i = 0; i < n * 8; i++) cold[i] = 100;
  const rows = [
    { label: 'Move: array of structs', group: 'move', ...time(() => { for (let i = 0, o = 0; i < n; i++, o += S) { aos[o] += aos[o + 2]; aos[o + 1] += aos[o + 3]; } return aos[5]; }) },
    { label: 'Move: struct of arrays', group: 'move', ...time(() => { for (let i = 0; i < n; i++) { x[i] += vx[i]; y[i] += vy[i]; } return x[5]; }) },
    { label: 'Move: hot/cold split', group: 'move', ...time(() => { for (let i = 0, o = 0; i < n; i++, o += 4) { hot[o] += hot[o + 2]; hot[o + 1] += hot[o + 3]; } return hot[5]; }) },
    { label: 'Damage: array of structs', group: 'damage', ...time(() => { for (let i = 0, o = 4; i < n; i++, o += S) aos[o] -= 0.001; return aos[4]; }) },
    { label: 'Damage: struct of arrays', group: 'damage', ...time(() => { for (let i = 0; i < n; i++) hp[i] -= 0.001; return hp[4]; }) },
    { label: 'Damage: hot/cold split', group: 'damage', ...time(() => { for (let i = 0, o = 0; i < n; i++, o += 8) cold[o] -= 0.001; return cold[4]; }) },
  ];
  return rows.map((r) => ({ label: r.label, group: r.group, ms: r.ms }));
}

function order(n: number) {
  const data = new Int32Array(n);
  for (let i = 0; i < n; i++) data[i] = i & 1023;
  const seq = new Uint32Array(n);
  for (let i = 0; i < n; i++) seq[i] = i;
  // A random permutation (Fisher–Yates with a small LCG so runs are repeatable).
  const rnd = new Uint32Array(n);
  for (let i = 0; i < n; i++) rnd[i] = i;
  let s = 12345;
  for (let i = n - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const j = s % (i + 1);
    const t = rnd[i];
    rnd[i] = rnd[j];
    rnd[j] = t;
  }
  // Blocks: random order of 64-byte chunks, sequential inside each chunk.
  const blocks = new Uint32Array(n);
  const nb = n >> 4;
  const perm = new Uint32Array(nb);
  for (let i = 0; i < nb; i++) perm[i] = i;
  for (let i = nb - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const j = s % (i + 1);
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let b = 0; b < nb; b++) for (let k = 0; k < 16; k++) blocks[b * 16 + k] = perm[b] * 16 + k;
  const sum = (idx: Uint32Array) => () => {
    let a = 0;
    for (let i = 0; i < n; i++) a += data[idx[i]];
    return a;
  };
  return [
    { label: 'In order', group: 'order', ms: time(sum(seq)).ms },
    { label: 'Random 64-byte blocks, in order inside each', group: 'order', ms: time(sum(blocks)).ms },
    { label: 'Fully random', group: 'order', ms: time(sum(rnd)).ms },
  ];
}

function stride(n: number) {
  // A fixed number of reads at growing strides, wrapping around a 64 MB array, so
  // every run does the same amount of work and only the memory traffic changes.
  const data = new Int32Array(n);
  for (let i = 0; i < n; i++) data[i] = i & 7;
  const mask = n - 1; // n is a power of two
  const reads = 1 << 22;
  const rows = [];
  for (const st of [1, 2, 4, 8, 16, 32, 64, 128]) {
    const r = time(() => {
      let a = 0;
      for (let i = 0, j = 0; i < reads; i++, j = (j + st) & mask) a += data[j];
      return a;
    });
    rows.push({ label: `Stride ${st} (${st * 4} B)`, group: 'stride', ms: r.ms, touched: reads });
  }
  return rows;
}

self.onmessage = (e: MessageEvent<Req>) => {
  try {
    const r = e.data;
    const rows = r.kind === 'layout' ? layout(r.n) : r.kind === 'order' ? order(r.n) : stride(r.n);
    postMessage({ ok: true, rows });
  } catch (err) {
    postMessage({ ok: false, message: (err as Error).message });
  }
};
