/**
 * "The CPU–GPU frame pipeline": a deterministic model of frames moving through the CPU, the GPU,
 * the swapchain and the display, and the latency from input to photon. No DOM, so the claims run
 * it in Node; the widget draws its timeline.
 *
 * One CPU thread runs each frame's simulation (reading input at its start), then records and
 * submits its rendering. The GPU runs submitted frames in order. The rules, as the lesson states
 * them:
 *   - Frames in flight F: the CPU may not start frame i until the GPU has finished frame i − F
 *     (the fence wait every Vulkan / D3D12 renderer has).
 *   - Swapchain images: F + 1 (one on screen, one per frame in flight) for FIFO and immediate;
 *     F + 2 for mailbox, which needs a spare so it never blocks. The CPU acquires an image before
 *     it records rendering and waits there if none is free. In FIFO an image comes free when the
 *     frame after it reaches the screen; in immediate, as soon as the next frame replaces it.
 *   - Present modes: FIFO shows one new frame per refresh, in order, never tearing. Mailbox shows
 *     the newest finished frame at each refresh and drops older unshown ones. Immediate shows a
 *     frame the moment the GPU finishes (tearing).
 *   - Latency is from the input read to the refresh that starts showing the frame (immediate: the
 *     moment it replaces the old image). Scan-out and the display's own processing come on top.
 *
 * The "just in time" option is a Reflex-style scheduler: when the CPU would have waited
 * (frames in flight, or a swapchain image), it waits *before* reading input instead, and starts as
 * late as it can without the frame reaching the screen later or the GPU waiting for it. A margin
 * of LATE_MARGIN ms is kept, since real frame times vary.
 */

export type PresentMode = 'fifo' | 'mailbox' | 'immediate';

export interface PipeSettings {
  /** Display refresh rate, Hz. */
  hz: number;
  /** CPU work per frame, ms: simulation (input is read at its start), then render recording and submit. */
  sim: number;
  render: number;
  /** GPU work per frame, ms. */
  gpu: number;
  /** How many frames the CPU may get ahead of the GPU. */
  inFlight: number;
  present: PresentMode;
  /** Start each frame just in time instead of as soon as possible. */
  late: boolean;
}
export const PIPE_DEFAULTS: PipeSettings = { hz: 60, sim: 4, render: 3, gpu: 6, inFlight: 2, present: 'fifo', late: false };
export const LATE_MARGIN = 1;
export const FRAMES = 160;
/** Frames before this are warm-up; statistics use the rest. */
export const WARMUP = 40;

export interface FrameTimes {
  i: number;
  /** Start of the CPU frame: input is read here. */
  start: number;
  /** End of simulation. */
  simEnd: number;
  /** When the CPU got its swapchain image (start of render recording). */
  acquire: number;
  /** Submitted to the GPU. */
  submit: number;
  gpuStart: number;
  gpuEnd: number;
  /** When it reaches the screen; null if it was dropped (mailbox). */
  shown: number | null;
  /** When it leaves the screen (null if dropped or still showing at the end). */
  replaced: number | null;
  /** Time the CPU spent blocked before this frame's simulation (frames in flight, or just in time). */
  waitBefore: number;
  /** Time blocked between simulation and render (waiting for a swapchain image). */
  waitAcquire: number;
}

export interface PipeResult {
  frames: FrameTimes[];
  /** Refresh period, ms. */
  T: number;
  /** Over the measured frames (after WARMUP): latency input → photon of shown frames, ms. */
  latency: { mean: number; min: number; max: number };
  /** Frames shown per second. */
  fps: number;
  /** Share of measured frames that were drawn but never shown. */
  dropped: number;
  /** Share of the measured time the GPU was busy. */
  gpuBusy: number;
  /** Swapchain images the model uses. */
  images: number;
}

const EPS = 1e-9;
/** The first refresh at or after t. */
const vblank = (t: number, T: number) => Math.ceil(t / T - EPS) * T;

/** Run the model for FRAMES frames. */
export function simulate(s: PipeSettings): PipeResult {
  const T = 1000 / s.hz;
  const F = s.inFlight;
  const images = s.present === 'mailbox' ? F + 2 : F + 1;
  const fr: FrameTimes[] = [];
  let cpuFree = 0;
  let gpuFree = 0;
  let lastShown = -Infinity;

  /** Earliest time an image is free for frame i (FIFO and immediate). */
  const imageFree = (i: number): number => {
    if (s.present === 'mailbox' || i < images) return 0;
    // Frame i reuses the image of frame i − images, freed when frame i − images + 1 replaced it on screen.
    const prev = fr[i - images + 1];
    return prev.shown ?? prev.gpuEnd;
  };

  /** Schedule frame i with the CPU starting no earlier than `notBefore`. */
  const schedule = (i: number, notBefore: number) => {
    const fence = i >= F ? fr[i - F].gpuEnd : 0;
    const start = Math.max(cpuFree, fence, notBefore);
    const simEnd = start + s.sim;
    const acquire = Math.max(simEnd, imageFree(i));
    const submit = acquire + s.render;
    const gpuStart = Math.max(submit, gpuFree);
    const gpuEnd = gpuStart + s.gpu;
    let shown: number | null;
    if (s.present === 'immediate') shown = gpuEnd;
    else if (s.present === 'fifo') shown = Math.max(vblank(gpuEnd, T), lastShown + T);
    else shown = vblank(gpuEnd, T); // mailbox: provisional; a newer frame finishing first drops it
    return { i, start, simEnd, acquire, submit, gpuStart, gpuEnd, shown, replaced: null, waitBefore: start - cpuFree, waitAcquire: acquire - simEnd };
  };

  // Which stage limits the frame rate: the CPU, the GPU, or (FIFO and mailbox) the display.
  const refresh = s.present === 'immediate' ? 0 : T;
  const cpuBound = s.sim + s.render >= Math.max(s.gpu, refresh) - EPS;
  const gpuBound = !cpuBound && s.gpu >= refresh - EPS;
  for (let i = 0; i < FRAMES; i++) {
    let f = schedule(i, 0);
    // When the CPU is the bottleneck there's nothing to wait for: starting later would only cost frames.
    if (s.late && !cpuBound) {
      // The latest moment the GPU can start this frame without changing anything downstream: if
      // the GPU is the bottleneck, the moment it frees up (so it never idles); otherwise the latest
      // start that still makes the same refresh, less a margin.
      const latestGpu = gpuBound || s.present === 'immediate' ? f.gpuStart : Math.max(f.gpuStart, (f.shown as number) - s.gpu - LATE_MARGIN);
      // Start so the frame is submitted at that moment, with all the waiting before the input read
      // (none while acquiring an image), and never earlier than it could have started anyway.
      const late = Math.max(f.start, imageFree(i) - s.sim, latestGpu - s.render - s.sim);
      const g = schedule(i, late);
      // Keep the late start only if the frame still shows no later.
      if (g.shown !== null && f.shown !== null && g.shown <= f.shown + EPS) f = g;
    }
    if (s.present === 'fifo' && f.shown !== null) lastShown = f.shown;
    cpuFree = f.submit;
    gpuFree = f.gpuEnd;
    fr.push(f);
  }

  if (s.present === 'mailbox') {
    // At each refresh the newest finished frame is shown; any older one that never was is dropped.
    for (let i = 0; i < fr.length; i++) {
      const f = fr[i];
      const v = f.shown as number;
      if (i + 1 < fr.length && fr[i + 1].gpuEnd <= v + EPS) f.shown = null;
    }
  }
  // When each shown frame leaves the screen: when the next shown frame arrives.
  let prev: FrameTimes | null = null;
  for (const f of fr) {
    if (f.shown === null) continue;
    if (prev) prev.replaced = f.shown;
    prev = f;
  }

  const m = fr.slice(WARMUP);
  const shown = m.filter((f) => f.shown !== null);
  const lat = shown.map((f) => (f.shown as number) - f.start);
  const t0 = m[0].start;
  const t1 = m[m.length - 1].gpuEnd;
  const busy = m.reduce((a, f) => a + (f.gpuEnd - f.gpuStart), 0);
  const firstShown = shown[0].shown as number;
  const lastShownT = shown[shown.length - 1].shown as number;
  return {
    frames: fr,
    T,
    latency: { mean: lat.reduce((a, b) => a + b, 0) / lat.length, min: Math.min(...lat), max: Math.max(...lat) },
    fps: ((shown.length - 1) * 1000) / (lastShownT - firstShown),
    dropped: (m.length - shown.length) / m.length,
    gpuBusy: busy / (t1 - t0),
    images,
  };
}

export const ms1 = (x: number) => `${x.toFixed(1)} ms`;
export const fps0 = (x: number) => `${Math.round(x)}`;
