/// <reference lib="webworker" />
import { FlecsWorld } from '../runtime';

/**
 * Runs the native benchmarks off the main thread, so the page stays responsive
 * and a run can be cancelled (by terminating the worker).
 */

type Req = { kind: 'ladder'; n: number } | { kind: 'spatial'; n: number; grid: number; moving: number; lookups: number };

let world: Promise<FlecsWorld> | null = null;

self.onmessage = async (e: MessageEvent<Req>) => {
  try {
    world ??= FlecsWorld.create();
    const w = await world;
    const r = e.data;
    if (r.kind === 'ladder') {
      postMessage({ type: 'done', result: w.benchLadder(r.n) });
    } else {
      const out = [];
      for (let mode = 0; mode < 5; mode++) {
        postMessage({ type: 'progress', step: mode + 1, of: 5 });
        out.push(w.benchSpatial(r.n, r.grid, mode, r.moving, r.lookups, 5));
      }
      postMessage({ type: 'done', result: out });
    }
  } catch (err) {
    postMessage({ type: 'error', message: (err as Error).message });
  }
};
