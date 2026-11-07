/**
 * Stand-ins for a WebGPU device and a WebGL2 context, so a lesson's renderers can run in Node
 * (the claims tests) with no GPU. They accept every call the renderers make and return plausible
 * objects; nothing is drawn. Wrapped by record(), they let a test count the calls a frame makes,
 * which is the same count the inspector shows in the browser (minus anything the real browser
 * adds, like timer queries, which these stubs don't offer).
 *
 * If a renderer starts using a method or property that needs a real answer (a limit, a query
 * result), add it here.
 */
import { type Gl2Context, type WebGpuContext } from './context';
import { GL_CONST } from './record';
import { type GPUAdapter, type GPUCanvasContext, type GPUDevice } from './webgpu';

// Named like the browser's classes, so the call log prints the same names in Node.
class GPUBindGroup {}
class WebGLBuffer {}
class WebGLTexture {}
class WebGLFramebuffer {}
class WebGLRenderbuffer {}
class WebGLShader {}
class WebGLProgram {}
class WebGLVertexArrayObject {}
class WebGLQuery {}
class WebGLUniformLocation {}

/** An object whose every method is a no-op returning `ret(name, args)`; `fixed` overrides. */
function stub(fixed: Record<string, unknown>, ret: (name: string, args: unknown[]) => unknown = () => undefined): any {
  return new Proxy(fixed, {
    get(t, p) {
      if (p in t) return t[p as string];
      if (p === 'then' || typeof p === 'symbol') return undefined;
      return (...args: unknown[]) => ret(p, args);
    },
  });
}

function texture(label: string, w: number, h: number) {
  return { label, width: w, height: h, createView: (d?: { label?: string }) => ({ label: d?.label ?? `${label} view` }), destroy() {} };
}

export function stubWebGpu(w: number, h: number): WebGpuContext {
  const device: GPUDevice = stub(
    {
      label: 'lesson device',
      features: new Set<string>(),
      limits: { minUniformBufferOffsetAlignment: 256 },
      lost: new Promise(() => {}),
      queue: stub({ label: '', onSubmittedWorkDone: () => Promise.resolve() }),
      createBuffer: (d: { label?: string; size: number }) => ({ label: d.label ?? '', size: d.size, mapState: 'unmapped', mapAsync: async () => {}, getMappedRange: () => new ArrayBuffer(d.size), unmap() {}, destroy() {} }),
      createTexture: (d: { label?: string; size: [number, number] }) => texture(d.label ?? '', d.size[0], d.size[1]),
      createShaderModule: (d: { label?: string }) => ({ label: d.label ?? '', getCompilationInfo: async () => ({ messages: [] }) }),
      createRenderPipelineAsync: async (d: { label?: string }) => ({ label: d.label ?? '' }),
      createBindGroup: (d: { label?: string }) => Object.assign(new GPUBindGroup(), { label: d.label ?? '' }),
      createCommandEncoder: (d?: { label?: string }) =>
        stub({ label: d?.label ?? '', beginRenderPass: (p: { label?: string }) => stub({ label: p.label ?? '' }), beginComputePass: (p?: { label?: string }) => stub({ label: p?.label ?? '' }), finish: () => ({ label: 'command buffer' }) }),
      popErrorScope: async () => null,
    },
    (_n, args) => ({ label: (args[0] as { label?: string } | undefined)?.label ?? '' }),
  );
  const context: GPUCanvasContext = { configure() {}, unconfigure() {}, getCurrentTexture: () => texture('canvas', w, h) as never };
  const canvas = { width: w, height: h } as HTMLCanvasElement;
  return { kind: 'webgpu', canvas, adapter: {} as GPUAdapter, device, context, format: 'bgra8unorm', timestamps: false, about: 'Node stub' };
}

export function stubWebGl2(w: number, h: number): Gl2Context {
  const make: Record<string, () => object> = {
    createBuffer: () => new WebGLBuffer(),
    createTexture: () => new WebGLTexture(),
    createFramebuffer: () => new WebGLFramebuffer(),
    createRenderbuffer: () => new WebGLRenderbuffer(),
    createShader: () => new WebGLShader(),
    createProgram: () => new WebGLProgram(),
    createVertexArray: () => new WebGLVertexArrayObject(),
    createQuery: () => new WebGLQuery(),
    getUniformLocation: () => new WebGLUniformLocation(),
  };
  const canvas = { width: w, height: h } as HTMLCanvasElement;
  const gl = stub({ ...GL_CONST, canvas, drawingBufferWidth: w, drawingBufferHeight: h }, (name, args) => {
    if (make[name]) return make[name]();
    if (name === 'getShaderParameter' || name === 'getProgramParameter') return true;
    if (name === 'getUniformBlockIndex' || name === 'getAttribLocation') return 0;
    if (name === 'checkFramebufferStatus') return GL_CONST.FRAMEBUFFER_COMPLETE;
    if (name === 'getParameter') return args[0] === GL_CONST.UNIFORM_BUFFER_OFFSET_ALIGNMENT ? 256 : 'stub';
    if (name === 'getExtension') return null;
    if (name === 'isContextLost') return false;
    return undefined;
  }) as WebGL2RenderingContext;
  return { kind: 'webgl2', canvas, gl, timerExt: null, about: 'Node stub' };
}
