/**
 * Recording the API calls a renderer really makes, for the inspectors. `record(obj, log, name)`
 * wraps a *recorder* object (a GPUDevice, GPUQueue, GPUCommandEncoder, GPURenderPassEncoder,
 * GPUCanvasContext, or a WebGL2RenderingContext) in a Proxy: while the log is on, each method
 * call is appended to it with its arguments summarised, and then made on the real object.
 * Encoders and passes returned by a recorded call are recorded too.
 *
 * Only recorders are wrapped. Resources (buffers, pipelines, bind groups...) are returned as the
 * real objects, so they can be passed back to the API, which checks their type.
 *
 * Renderers don't describe what they do; the log is what they did. The same code runs in Node
 * against the stubs in stub.ts, so the claims can count calls without a GPU.
 */

export type Phase = 'init' | 'frame' | 'rebuild';

export interface Call {
  phase: Phase;
  /** The recorder's name: device, queue, encoder, pass, context, gl. */
  on: string;
  method: string;
  /** One line. */
  short: string;
  /** The arguments in full, pretty-printed. */
  full: string;
  /** Why it's there, when it's not part of drawing the frame (timing, readback). */
  tag?: string;
}

export class CallLog {
  calls: Call[] = [];
  on = false;
  phase: Phase = 'init';
  private tagNow: string | undefined;

  start(phase: Phase): void {
    this.phase = phase;
    this.on = true;
  }
  stop(): void {
    this.on = false;
  }
  clear(): void {
    this.calls = [];
  }
  /** Run `fn` with its calls tagged (e.g. 'timing'). */
  tagged<T>(tag: string, fn: () => T): T {
    const prev = this.tagNow;
    this.tagNow = tag;
    try {
      return fn();
    } finally {
      this.tagNow = prev;
    }
  }
  add(on: string, method: string, args: unknown[]): void {
    if (!this.on) return;
    const enumArgs = on === 'gl' ? GL_ENUM_ARGS[method] : undefined;
    const fmt = (a: unknown, i: number) => (enumArgs?.includes(i) ? glEnum(a, method === 'clear') : summary(a, 0, method));
    const short = `${on}.${method}(${args.map(fmt).join(', ')})`;
    const full = args.map((a, i) => (enumArgs?.includes(i) ? glEnum(a, method === 'clear') : pretty(a, 0, method))).join(',\n');
    this.calls.push({ phase: this.phase, on, method, short: short.length > 160 ? `${short.slice(0, 157)}…` : short, full, tag: this.tagNow });
  }
  /** Calls of one phase, optionally only untagged ones. */
  of(phase: Phase, untaggedOnly = false): Call[] {
    return this.calls.filter((c) => c.phase === phase && (!untaggedOnly || !c.tag));
  }
}

/** Methods whose results are recorders too, and what to call them. */
const RECORDERS: Record<string, string> = { createCommandEncoder: 'encoder', beginRenderPass: 'pass', beginComputePass: 'compute' };
/** Properties that hold recorders. */
const RECORDER_PROPS: Record<string, string> = { queue: 'queue' };

const real = new WeakMap<object, object>();
/** The real object behind a recorded one (or the object itself). */
export const unwrap = <T>(x: T): T => ((x && typeof x === 'object' && real.get(x as object)) as T) || x;

/** Wrap a recorder so its calls go to `log`. */
export function record<T extends object>(target: T, log: CallLog, name: string): T {
  const p = new Proxy(target, {
    get(t, prop) {
      // Read with the real object as `this`: WebIDL getters reject a Proxy.
      const v = (t as Record<string | symbol, unknown>)[prop];
      if (typeof prop === 'string' && RECORDER_PROPS[prop] && v && typeof v === 'object') return record(v as object, log, RECORDER_PROPS[prop]);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        if (typeof prop === 'string') log.add(name, prop, args);
        const out = (v as (...a: unknown[]) => unknown).apply(t, args.map(unwrap));
        if (typeof prop === 'string' && RECORDERS[prop] && out && typeof out === 'object') return record(out as object, log, RECORDERS[prop]);
        return out;
      };
    },
  });
  real.set(p, target);
  return p;
}

// ---------------------------------------------------------------------------------------------
// Summarising arguments

const BUF_FLAGS: Array<[number, string]> = [
  [0x1, 'MAP_READ'],
  [0x2, 'MAP_WRITE'],
  [0x4, 'COPY_SRC'],
  [0x8, 'COPY_DST'],
  [0x10, 'INDEX'],
  [0x20, 'VERTEX'],
  [0x40, 'UNIFORM'],
  [0x80, 'STORAGE'],
  [0x100, 'INDIRECT'],
  [0x200, 'QUERY_RESOLVE'],
];
const TEX_FLAGS: Array<[number, string]> = [
  [0x1, 'COPY_SRC'],
  [0x2, 'COPY_DST'],
  [0x4, 'TEXTURE_BINDING'],
  [0x8, 'STORAGE_BINDING'],
  [0x10, 'RENDER_ATTACHMENT'],
];
const STAGE_FLAGS: Array<[number, string]> = [
  [0x1, 'VERTEX'],
  [0x2, 'FRAGMENT'],
  [0x4, 'COMPUTE'],
];
const flags = (v: number, table: Array<[number, string]>) => table.filter(([b]) => v & b).map(([, n]) => n).join(' | ') || '0';

function flagTable(method: string, key: string): Array<[number, string]> | null {
  if (key === 'visibility') return STAGE_FLAGS;
  if (key !== 'usage') return null;
  if (method === 'createBuffer') return BUF_FLAGS;
  if (method === 'createTexture' || method === 'configure') return TEX_FLAGS;
  return null;
}

function objName(o: object): string | null {
  const ctor = (o as { constructor?: { name?: string } }).constructor?.name;
  const label = (o as { label?: unknown }).label;
  if (ArrayBuffer.isView(o)) return `${ctor}(${(o as unknown as { length?: number }).length ?? (o as ArrayBufferView).byteLength})`;
  if (o instanceof ArrayBuffer) return `ArrayBuffer(${o.byteLength})`;
  if (typeof label === 'string' && label) return `'${label}'`;
  if (ctor && ctor !== 'Object' && ctor !== 'Array') return ctor.replace(/^WebGL/, '');
  return null;
}

/** A short one-line summary of an argument. */
function summary(a: unknown, depth: number, method: string, key = ''): string {
  if (typeof a === 'number') {
    const t = flagTable(method, key);
    return t ? flags(a, t) : String(Math.abs(a) < 1e5 && !Number.isInteger(a) ? +a.toFixed(4) : a);
  }
  if (typeof a === 'string') return `'${a}'`;
  if (a === null || a === undefined || typeof a === 'boolean') return String(a);
  if (typeof a === 'function') return 'fn';
  const o = a as object;
  const n = objName(o);
  if (n) return n;
  if (Array.isArray(o)) return depth > 0 ? `[…${o.length}]` : `[${o.map((x) => summary(x, depth + 1, method)).join(', ')}]`;
  if (depth > 0) return '{…}';
  const ks = Object.keys(o);
  const parts = ks.slice(0, 3).map((k) => `${k}: ${summary((o as Record<string, unknown>)[k], depth + 1, method, k)}`);
  return `{ ${parts.join(', ')}${ks.length > 3 ? ', …' : ''} }`;
}

/** The argument in full, indented. Shader source is cut to its first lines. */
function pretty(a: unknown, depth: number, method: string, key = ''): string {
  const pad = '  '.repeat(depth + 1);
  if (typeof a === 'string' && a.includes('\n')) {
    const lines = a.trim().split('\n');
    return `\`${lines.slice(0, 6).join('\n')}${lines.length > 6 ? `\n… ${lines.length - 6} more lines` : ''}\``;
  }
  if (a === null || typeof a !== 'object') return summary(a, depth, method, key);
  const n = objName(a);
  if (n) return n;
  if (depth > 5) return '…';
  if (Array.isArray(a)) return a.length ? `[\n${a.map((x) => pad + pretty(x, depth + 1, method)).join(',\n')}\n${'  '.repeat(depth)}]` : '[]';
  const ks = Object.keys(a);
  return `{\n${ks.map((k) => `${pad}${k}: ${pretty((a as Record<string, unknown>)[k], depth + 1, method, k)}`).join(',\n')}\n${'  '.repeat(depth)}}`;
}

// ---------------------------------------------------------------------------------------------
// WebGL enum names

/** Which arguments of a gl method are enums, so the log can print their names. */
const GL_ENUM_ARGS: Record<string, number[]> = {
  blendFunc: [0, 1],
  blendFuncSeparate: [0, 1, 2, 3],
  invalidateFramebuffer: [0],
  clearBufferfv: [0],
  clearBufferfi: [0],
  enable: [0],
  disable: [0],
  cullFace: [0],
  frontFace: [0],
  depthFunc: [0],
  clear: [0],
  bindBuffer: [0],
  bufferData: [0, 2],
  bufferSubData: [0],
  bindBufferRange: [0],
  bindBufferBase: [0],
  bindFramebuffer: [0],
  framebufferTexture2D: [0, 1, 2],
  framebufferRenderbuffer: [0, 1, 2],
  bindRenderbuffer: [0],
  renderbufferStorage: [0, 1],
  bindTexture: [0],
  texParameteri: [0, 1, 2],
  texStorage2D: [0, 2],
  activeTexture: [0],
  createShader: [0],
  vertexAttribPointer: [2],
  drawElements: [0, 2],
  drawElementsInstanced: [0, 2],
  drawArraysInstanced: [0],
  drawArrays: [0],
  readPixels: [4, 5],
  beginQuery: [0],
  endQuery: [0],
  getQueryParameter: [1],
  getParameter: [0],
  checkFramebufferStatus: [0],
  getShaderParameter: [1],
  getProgramParameter: [1],
};
// The lighting lessons' calls (assigned, so another lesson adding the same method can't clash).
Object.assign(GL_ENUM_ARGS, { texSubImage2D: [0, 6, 7], blitFramebuffer: [8, 9] });

/**
 * The GL constants the lessons use, with their standard OpenGL ES values. The log prints these
 * names; the Node stub hands out these values; the WebGL2 backend checks they match the context.
 */
export const GL_CONST = {
  DEPTH_TEST: 0x0b71, CULL_FACE: 0x0b44, BACK: 0x0405, CCW: 0x0901, LESS: 0x0201, COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100,
  ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, UNIFORM_BUFFER: 0x8a11, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
  FRAMEBUFFER: 0x8d40, COLOR_ATTACHMENT0: 0x8ce0, DEPTH_ATTACHMENT: 0x8d00, TEXTURE_2D: 0x0de1, RENDERBUFFER: 0x8d41, DEPTH_COMPONENT24: 0x81a6, RGBA8: 0x8058,
  TEXTURE0: 0x84c0, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, NEAREST: 0x2600, CLAMP_TO_EDGE: 0x812f,
  VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, FLOAT: 0x1406, TRIANGLES: 0x0004, UNSIGNED_SHORT: 0x1403, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, UNSIGNED_INT: 0x1405, STREAM_DRAW: 0x88e0,
  COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, FRAMEBUFFER_COMPLETE: 0x8cd5, QUERY_RESULT_AVAILABLE: 0x8867, QUERY_RESULT: 0x8866,
  TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb, UNIFORM_BUFFER_OFFSET_ALIGNMENT: 0x8a34, RENDERER: 0x1f01, VERSION: 0x1f02,
  // The lighting lessons: integer, 10-bit, float and depth textures, framebuffer blits, shadow comparison.
  R32UI: 0x8236, RG32UI: 0x8230, RED_INTEGER: 0x8d94, RG_INTEGER: 0x8228, RGB10_A2: 0x8059, RGBA16F: 0x881a, HALF_FLOAT: 0x140b, DEPTH_COMPONENT32F: 0x8cac,
  READ_FRAMEBUFFER: 0x8ca8, DRAW_FRAMEBUFFER: 0x8ca9, LINEAR: 0x2601, LINEAR_MIPMAP_LINEAR: 0x2703, TEXTURE_COMPARE_MODE: 0x884c, TEXTURE_COMPARE_FUNC: 0x884d,
  COMPARE_REF_TO_TEXTURE: 0x884e, LEQUAL: 0x0203, SCISSOR_TEST: 0x0c11, REPEAT: 0x2901, RGBA32F: 0x8814,
  // The performance lessons: blending, depth tests, more attachments and formats, per-attachment clears.
  ZERO: 0, ONE: 1, BLEND: 0x0be2, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303, EQUAL: 0x0202, ALWAYS: 0x0207, TEXTURE1: 0x84c1, INVALID_INDEX: 0xffffffff,
  COLOR_ATTACHMENT1: 0x8ce1, DEPTH_STENCIL_ATTACHMENT: 0x821a, R11F_G11F_B10F: 0x8c3a, DEPTH_COMPONENT16: 0x81a5, DEPTH24_STENCIL8: 0x88f0, COLOR: 0x1800, DEPTH: 0x1801, DEPTH_STENCIL: 0x84f9,
} as const;
export const GL_NAMES: ReadonlyMap<number, string> = new Map(Object.entries(GL_CONST).map(([n, v]) => [v as number, n]));

function glEnum(a: unknown, bits: boolean): string {
  if (typeof a !== 'number') return summary(a, 0, '');
  if (bits) {
    const parts = (['COLOR_BUFFER_BIT', 'DEPTH_BUFFER_BIT'] as const).filter((n) => a & GL_CONST[n]);
    if (parts.length) return parts.join(' | ');
  }
  return GL_NAMES.get(a) ?? String(a);
}
