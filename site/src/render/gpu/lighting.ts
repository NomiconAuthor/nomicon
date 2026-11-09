/**
 * Small pieces the lighting lessons' renderers share (forward-deferred-clustered, physically-based-
 * shading, shadow-maps, post-processing). Each lesson still makes its own calls on the recorded
 * device or context; these only save writing the same buffer upload, shader compile and full-screen
 * triangle four times. Nothing here wraps an API: every call goes through whatever recorder it's given.
 */
import { VERTEX_ATTRS, VERTEX_STRIDE, type GpuMesh } from './scene';
import { BufferUsage, type GPUBuffer, type GPUDevice, type GPUVertexBufferLayout } from './webgpu';

/** WebGL objects have no labels; give them one so the call log can name them. */
export function named<T>(o: T, label: string): T {
  if (o && typeof o === 'object') (o as { label?: string }).label = label;
  return o;
}

// ---------------------------------------------------------------------------------------------
// WebGPU

export const VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX_STRIDE,
  attributes: VERTEX_ATTRS.map((a) => ({ shaderLocation: a.location, offset: a.offset, format: `float32x${a.components}` })),
};

/** One vertex and one index buffer per mesh, filled through the queue. */
export function gpuMeshBuffers(dev: GPUDevice, meshes: GpuMesh[]): Array<{ vb: GPUBuffer; ib: GPUBuffer; count: number }> {
  return meshes.map((m) => {
    const vb = dev.createBuffer({ label: `${m.name} vertices`, size: m.vertices.byteLength, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    dev.queue.writeBuffer(vb, 0, m.vertices);
    const ib = dev.createBuffer({ label: `${m.name} indices`, size: m.indices.byteLength, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
    dev.queue.writeBuffer(ib, 0, m.indices);
    return { vb, ib, count: m.indexCount };
  });
}

/** A uniform buffer of `size` bytes. */
export const uniformBuffer = (dev: GPUDevice, label: string, size: number) => dev.createBuffer({ label, size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });

/** One triangle that covers the screen, with uv 0..1 from the top-left. No vertex buffer. */
export const WGSL_FULLSCREEN = /* wgsl */ `
struct FsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn vs_full(@builtin(vertex_index) i: u32) -> FsOut {
  let t = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: FsOut;
  o.pos = vec4f(t.x * 2.0 - 1.0, 1.0 - t.y * 2.0, 0.0, 1.0);
  o.uv = t;
  return o;
}
`;

/** Linear to the display: the sRGB curve (the canvas formats here are not sRGB, so the shader encodes). */
export const WGSL_SRGB = /* wgsl */ `
fn to_srgb(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, 12.92 * x, x <= vec3f(0.0031308));
}
`;

// ---------------------------------------------------------------------------------------------
// WebGL2

export function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}
export function link(gl: WebGL2RenderingContext, label: string, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = named(gl.createProgram()!, label);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program ${label}: ${gl.getProgramInfoLog(p)}`);
  return p;
}

/** A vertex array object per mesh: its buffers and the attribute layout. */
export function glMeshes(gl: WebGL2RenderingContext, meshes: GpuMesh[]): Array<{ vao: WebGLVertexArrayObject | null; count: number }> {
  return meshes.map((m) => {
    const vao = named(gl.createVertexArray(), m.name);
    gl.bindVertexArray(vao);
    const vb = named(gl.createBuffer(), `${m.name} vertices`);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, m.vertices, gl.STATIC_DRAW);
    for (const a of VERTEX_ATTRS) {
      gl.enableVertexAttribArray(a.location);
      gl.vertexAttribPointer(a.location, a.components, gl.FLOAT, false, VERTEX_STRIDE, a.offset);
    }
    const ib = named(gl.createBuffer(), `${m.name} indices`);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: m.indexCount };
  });
}

/** An immutable-size 2D texture with nearest (or linear) filtering and clamped edges. */
export function glTexture(gl: WebGL2RenderingContext, label: string, internal: number, w: number, h: number, filter: 'nearest' | 'linear' = 'nearest', levels = 1): WebGLTexture | null {
  const t = named(gl.createTexture(), label);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, levels, internal, w, h);
  const f = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** A framebuffer over colour textures (attachments 0, 1, ...) and an optional depth texture. */
export function glFramebuffer(gl: WebGL2RenderingContext, label: string, colours: Array<WebGLTexture | null>, depth: WebGLTexture | null): WebGLFramebuffer | null {
  const fbo = named(gl.createFramebuffer(), label);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  colours.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
  if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  if (colours.length > 1) gl.drawBuffers(colours.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
  if (!colours.length) {
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
  }
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) console.error(`WebGL2: framebuffer '${label}' incomplete`);
  return fbo;
}

export const GLSL_FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 t = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(t.x * 2.0 - 1.0, 1.0 - t.y * 2.0, 0.0, 1.0);
  vUv = vec2(t.x, 1.0 - t.y); // GL textures start at the bottom row
}`;

export const GLSL_SRGB = `
vec3 to_srgb(vec3 c) {
  vec3 x = clamp(c, 0.0, 1.0);
  return mix(1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055, 12.92 * x, lessThanEqual(x, vec3(0.0031308)));
}`;

/** Bind a uniform block of every program to its binding point. */
export function bindBlocks(gl: WebGL2RenderingContext, programs: WebGLProgram[], blocks: Record<string, number>): void {
  for (const p of programs)
    for (const [name, point] of Object.entries(blocks)) {
      const i = gl.getUniformBlockIndex(p, name);
      if (i !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, i, point);
    }
}
/** Point each program's samplers at texture units. */
export function bindSamplers(gl: WebGL2RenderingContext, programs: WebGLProgram[], units: Record<string, number>): void {
  for (const p of programs) {
    gl.useProgram(p);
    for (const [name, unit] of Object.entries(units)) {
      const loc = gl.getUniformLocation(p, name);
      if (loc) gl.uniform1i(loc, unit);
    }
  }
}
