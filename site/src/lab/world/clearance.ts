import type { GridLayer } from './world';

/**
 * Clearance map: for every open cell, the Chebyshev (chessboard) distance to the
 * nearest solid cell or map edge. A cell next to a wall has clearance 1.
 *
 * A unit whose footprint is a (2k-1) x (2k-1) square of cells can stand on any cell
 * with clearance >= k. So one map serves every unit size: the size buckets just read
 * the same numbers with a different threshold.
 *
 * Computed with the classic two-pass distance transform, which is exact for the
 * chessboard metric. Cost: two sweeps over the grid.
 */
export function computeClearance(layer: GridLayer): Uint16Array {
  const { w, h, blocked } = layer;
  const d = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      d[i] = blocked[i] ? 0 : Math.min(x + 1, y + 1, w - x, h - y);
    }
  }
  // Forward pass: look at the already-visited neighbours above and to the left.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + 1);
      if (y > 0) {
        m = Math.min(m, d[i - w] + 1);
        if (x > 0) m = Math.min(m, d[i - w - 1] + 1);
        if (x < w - 1) m = Math.min(m, d[i - w + 1] + 1);
      }
      d[i] = m;
    }
  }
  // Backward pass: neighbours below and to the right.
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x < w - 1) m = Math.min(m, d[i + 1] + 1);
      if (y < h - 1) {
        m = Math.min(m, d[i + w] + 1);
        if (x < w - 1) m = Math.min(m, d[i + w + 1] + 1);
        if (x > 0) m = Math.min(m, d[i + w - 1] + 1);
      }
      d[i] = m;
    }
  }
  return d;
}

export type DiagonalRule = 'never' | 'noCorner' | 'always';

/**
 * Connected-component labels for one unit size. Label 0 = not standable;
 * two cells with the same non-zero label can reach each other.
 * This turns "is the goal reachable?" into a single comparison.
 */
export function computeComponents(
  layer: GridLayer,
  clearance: Uint16Array,
  need: number,
  diagonal: DiagonalRule,
): { labels: Int32Array; count: number } {
  const { w, h } = layer;
  const labels = new Int32Array(w * h);
  const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && clearance[y * w + x] >= need;
  const stack: number[] = [];
  let count = 0;
  for (let s = 0; s < w * h; s++) {
    if (labels[s] || clearance[s] < need) continue;
    count++;
    labels[s] = count;
    stack.push(s);
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % w;
      const cy = (c - cx) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!ok(nx, ny)) continue;
          if (dx && dy) {
            if (diagonal === 'never') continue;
            if (diagonal === 'noCorner' && (!ok(cx + dx, cy) || !ok(cx, cy + dy))) continue;
          }
          const n = ny * w + nx;
          if (!labels[n]) {
            labels[n] = count;
            stack.push(n);
          }
        }
      }
    }
  }
  return { labels, count };
}
