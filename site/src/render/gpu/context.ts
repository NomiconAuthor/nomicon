/**
 * Getting a GPU: WebGPU when the browser has it and gives us an adapter, WebGL2 otherwise.
 *
 * This is deliberately thin. It hands back the real API objects (the adapter and device, or the
 * WebGL2 context) and says why WebGPU wasn't used; each lesson's renderer then talks to that API
 * directly, so readers see real calls. What lives here is the boilerplate every renderer needs:
 * feature detection, asking for the optional features we use, configuring the canvas, and
 * noticing when the device or context is lost.
 *
 * Feature detection, in order:
 *   - `navigator.gpu` missing: no WebGPU in this browser (or not a secure context).
 *   - `requestAdapter()` resolves to null: WebGPU exists but there's no usable GPU (blocklisted
 *     driver, headless browser without a software adapter, ...).
 *   - `requestDevice()` can still fail; an adapter is used up by one requestDevice, so a retry
 *     after device loss asks for a new adapter.
 *   - Optional features are requested only if the adapter lists them: we ask for
 *     'timestamp-query' (GPU timings), plus any a widget names in `features` (the bandwidth
 *     lesson asks for 'rg11b10ufloat-renderable').
 *   - WebGL2: `getContext('webgl2')` may return null (old browser, GPU blocklisted, too many
 *     contexts); EXT_disjoint_timer_query_webgl2 gives GPU timings where the browser exposes it.
 */
import { type CallLog } from './record';
import { type GPUAdapter, type GPUCanvasContext, type GPUDevice, navigatorGpu } from './webgpu';

export type Backend = 'webgpu' | 'webgl2';

export interface WebGpuContext {
  kind: 'webgpu';
  canvas: HTMLCanvasElement;
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  /** The canvas format the browser prefers (usually bgra8unorm). */
  format: string;
  /** 'timestamp-query' was available and enabled. */
  timestamps: boolean;
  /** One line for the widget: which adapter. */
  about: string;
}
export interface Gl2Context {
  kind: 'webgl2';
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  /** EXT_disjoint_timer_query_webgl2, if the browser exposes it. */
  timerExt: TimerExt | null;
  about: string;
}
export type GpuContext = WebGpuContext | Gl2Context;

/** The constants of EXT_disjoint_timer_query_webgl2 we use (the queries themselves are WebGL2 core calls). */
export interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export interface GpuResult {
  ctx: GpuContext | null;
  /** Why WebGPU isn't in use (null when it is). */
  noWebGpu: string | null;
  /** Why WebGL2 isn't in use, when neither works. */
  noWebGl2?: string;
}

export interface InitOptions {
  /** Try this backend first; 'auto' means WebGPU, then WebGL2. */
  prefer?: Backend | 'auto';
  /** Records the init calls for an inspector. */
  log?: CallLog;
  /** Called once if the device or context is lost later (not when we dispose it ourselves). */
  onLost?: (why: string) => void;
  /** WebGL2 only: called when a lost context is restored, so the renderer can rebuild. */
  onRestored?: () => void;
  /** More optional WebGPU features to ask for, each only if the adapter offers it (check device.features). */
  features?: string[];
}

const disposed = new WeakSet<object>();
/** The adapter webGpuAvailable() got, kept so the next initGpu doesn't have to request another. */
let spare: GPUAdapter | null = null;

/** Has WebGPU, with an adapter? The adapter is kept for the next initGpu. */
export async function webGpuAvailable(): Promise<string | null> {
  const gpu = navigatorGpu();
  if (!gpu) return 'this browser has no WebGPU (navigator.gpu is missing)';
  try {
    spare = await gpu.requestAdapter();
    return spare ? null : 'this browser has WebGPU, but it offered no GPU adapter';
  } catch (e) {
    return `requestAdapter failed: ${String(e)}`;
  }
}

async function initWebGpu(canvas: HTMLCanvasElement, o: InitOptions): Promise<WebGpuContext | string> {
  const gpu = navigatorGpu();
  if (!gpu) return 'this browser has no WebGPU (navigator.gpu is missing)';
  const log = o.log;
  log?.add('gpu', 'requestAdapter', []);
  let adapter: GPUAdapter | null = spare;
  // An adapter gives out one device; after that (or after a loss) ask for a new one.
  spare = null;
  try {
    adapter ??= await gpu.requestAdapter();
  } catch (e) {
    return `requestAdapter failed: ${String(e)}`;
  }
  if (!adapter) return 'this browser has WebGPU, but it offered no GPU adapter';
  const timestamps = adapter.features.has('timestamp-query');
  const extra = (o.features ?? []).filter((f) => f !== 'timestamp-query' && adapter.features.has(f));
  const desc = { label: 'lesson device', requiredFeatures: [...(timestamps ? ['timestamp-query'] : []), ...extra] };
  log?.add('adapter', 'requestDevice', [desc]);
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice(desc);
  } catch (e) {
    return `requestDevice failed: ${String(e)}`;
  }
  const context = canvas.getContext('webgpu') as unknown as GPUCanvasContext | null;
  if (!context) {
    device.destroy();
    return 'the canvas gave no webgpu context';
  }
  const format = gpu.getPreferredCanvasFormat();
  const conf = { device, format, alphaMode: 'opaque' as const };
  log?.add('context', 'configure', [conf]);
  context.configure(conf);
  device.lost.then((info) => {
    if (!disposed.has(device)) o.onLost?.(`${info.reason}${info.message ? `: ${info.message}` : ''}`);
  });
  const i = adapter.info;
  const about = i ? [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ') + (i.isFallbackAdapter ? ' (a software fallback adapter)' : '') : '';
  return { kind: 'webgpu', canvas, adapter, device, context, format, timestamps, about };
}

function initWebGl2(canvas: HTMLCanvasElement, o: InitOptions): Gl2Context | string {
  const attrs = { antialias: false, alpha: false, depth: false, powerPreference: 'high-performance' as const };
  o.log?.add('canvas', 'getContext', ['webgl2', attrs]);
  const gl = canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null;
  if (!gl) return 'this browser gave no WebGL2 context';
  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  canvas.addEventListener('webglcontextlost', (e) => {
    // Without preventDefault the context is never restored.
    e.preventDefault();
    if (!disposed.has(gl)) o.onLost?.('the WebGL context was lost');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    if (!disposed.has(gl)) o.onRestored?.();
  });
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const about = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  return { kind: 'webgl2', canvas, gl, timerExt, about };
}

/**
 * Get a GPU context on this canvas. A canvas can hold only one kind of context, so switching
 * backends needs a fresh canvas (GpuCanvas in widget.ts does that).
 */
export async function initGpu(canvas: HTMLCanvasElement, o: InitOptions = {}): Promise<GpuResult> {
  const prefer = o.prefer ?? 'auto';
  let noWebGpu: string | null = 'WebGL2 was chosen';
  if (prefer !== 'webgl2') {
    const r = await initWebGpu(canvas, o);
    if (typeof r !== 'string') return { ctx: r, noWebGpu: null };
    // Every failure above happens before the canvas hands out a webgpu context, so it is still
    // free to give a webgl2 one.
    noWebGpu = r;
  }
  const g = initWebGl2(canvas, o);
  if (typeof g === 'string') return { ctx: null, noWebGpu, noWebGl2: g };
  return { ctx: g, noWebGpu };
}

/** Let the context go: our own dispose isn't reported as a loss. */
export function disposeGpu(ctx: GpuContext): void {
  if (ctx.kind === 'webgpu') {
    disposed.add(ctx.device);
    ctx.context.unconfigure();
    ctx.device.destroy();
  } else {
    disposed.add(ctx.gl);
    ctx.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/**
 * Lose the device on purpose, to test the recovery path: WebGPU destroys the device (reported
 * through device.lost like a real loss); WebGL2 uses WEBGL_lose_context and restores it a moment
 * later. Returns false if this browser can't simulate it.
 */
export function simulateLoss(ctx: GpuContext): boolean {
  if (ctx.kind === 'webgpu') {
    ctx.device.destroy();
    return true;
  }
  const ext = ctx.gl.getExtension('WEBGL_lose_context');
  if (!ext) return false;
  ext.loseContext();
  setTimeout(() => ext.restoreContext(), 300);
  return true;
}
