/**
 * "The same frame on a real GPU": two widgets.
 *
 * SameFrameViz: the pipeline lesson's frame from the software rasteriser beside the same frame
 * drawn by the GPU (WebGPU, or WebGL2 where WebGPU is missing), with the same near plane and
 * culling controls, an optional pixel-by-pixel comparison, GPU timings and a "lose the device"
 * button that exercises the recovery path.
 *
 * GpuInspectorViz: every API call the GPU renderer made while loading and for one frame, as
 * recorded (gpu/record.ts), with the arguments and the D3D12, Vulkan and Metal equivalents.
 */
import '../gpu/gpu.css';
import { h, seg } from '../../engine/dom';
import { type Backend } from '../gpu/context';
import { DRAW_METHODS, type FramePlan, planStats } from '../gpu/plan';
import { type Call, CallLog, type Phase } from '../gpu/record';
import { type Colours, type SameFrameRenderer, createSameFrame } from '../gpu/same-frame';
import { GpuCanvas, backendLine, msText, planReadout, timeFrames } from '../gpu/widget';
import { PIPE_H, PIPE_NEARS, PIPE_W, SAME_FRAME_DEFAULTS, type SameFrameSettings, differingPixels, sameFrameDraws, softwareFrame } from '../scenes/same-frame-real-gpu';
import { pipelineScene } from '../scenes/the-pipeline';
import { type RGB, Palette, btn, canvas, chk, ctx2d, fit, frame, onTheme, paintTarget, plural, size, stage, stat } from '../view';

function colours(pal: Palette): Colours {
  const r = (c: RGB) => c.map((x) => Math.round(x)) as [number, number, number];
  return { bg: r(pal.rgb('--bg')), draws: sameFrameDraws().map((d) => r(pal.rgb(d.color))) };
}

function apiSwitch(g: GpuCanvas, onSwitch: () => void): HTMLElement {
  const box = h('span', { class: 'rd-gpu-switch' });
  const render = () => {
    if (!g.webGpuOk) {
      box.replaceChildren();
      return;
    }
    const s = seg<Backend>(
      'API',
      [
        ['webgpu', 'WebGPU'],
        ['webgl2', 'WebGL2'],
      ],
      g.ctx?.kind ?? 'webgpu',
      (b) => void g.use(b).then(onSwitch),
    );
    box.replaceChildren(s.el);
  };
  return Object.assign(box, { refresh: render });
}

// ---------------------------------------------------------------------------------------------

export class SameFrameViz {
  private s: SameFrameSettings = { ...SAME_FRAME_DEFAULTS };
  private compare = false;
  private pal: Palette;
  private sw = canvas(640, 400, 'The frame from the software rasteriser, one square per pixel');
  private gpu: GpuCanvas;
  private renderer: SameFrameRenderer | null = null;
  private plan: FramePlan | null = null;
  private diff: number[] | null = null;
  private api: HTMLElement & { refresh?: () => void };
  private backend = h('div', { class: 'll-row' });
  private gpuHead = h('div', { class: 'll-h' }, 'GPU');
  private swStats = h('div', { class: 'll-stats' });
  private gpuStats = h('div', { class: 'll-stats' });
  private diffLine = h('p', { class: 'rd-say' });
  private timing = h('span', { class: 'll-muted' });
  private status = h('p', { class: 'rd-gpu-status' });
  private compareBox: HTMLElement;
  private log = new CallLog();

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-gpu');
    this.pal = new Palette(root);
    this.gpu = new GpuCanvas({
      w: 640,
      h: 400,
      label: 'The same frame drawn by the GPU',
      build: async (ctx) => {
        this.renderer = await createSameFrame(ctx, this.log);
      },
      teardown: () => {
        this.renderer?.dispose();
        this.renderer = null;
      },
      draw: () => this.drawGpu(),
      onStatus: (s) => {
        this.status.textContent = s;
        this.showBackend();
      },
    });
    this.api = apiSwitch(this.gpu, () => this.redraw());
    this.compareBox = chk('Mark pixels that differ', false, (on) => {
      this.compare = on;
      this.redraw();
    });
    const res = seg<SameFrameSettings['res']>(
      'GPU resolution',
      [
        ['low', `${PIPE_W} × ${PIPE_H}`],
        ['full', 'Full'],
      ],
      this.s.res,
      (v) => {
        this.s.res = v;
        this.redraw();
      },
    );
    root.append(
      this.backend,
      h(
        'div',
        { class: 'll-row' },
        seg<string>('Near plane', PIPE_NEARS.map((n) => [String(n), `${n} m`] as [string, string]), String(this.s.near), (v) => {
          this.s.near = Number(v);
          this.redraw();
        }).el,
        chk('Cull back faces', true, (on) => {
          this.s.cull = on;
          this.redraw();
        }),
      ),
      h('div', { class: 'll-row' }, res.el, this.compareBox),
      stage(
        h(
          'div',
          { class: 'rd-fig rd-pair', style: '--rd-max-w: 900px; --rd-ar: 3.3' },
          h('div', {}, h('div', { class: 'll-h' }, `Software rasteriser, ${PIPE_W} × ${PIPE_H}`), this.sw),
          h('div', {}, this.gpuHead, this.gpu.el),
        ),
      ),
      h('div', { class: 'rd-read' }, h('div', { class: 'll-h' }, 'Software'), this.swStats, h('div', { class: 'll-h' }, 'GPU'), this.gpuStats),
      this.diffLine,
      h(
        'div',
        { class: 'll-row' },
        btn('Time 60 frames', () => void this.time()),
        this.timing,
        btn('Lose the device', () => {
          if (!this.gpu.loseDevice()) this.status.textContent = "This browser can't simulate a lost context.";
        }),
      ),
      this.status,
    );
    fit(this.sw, () => this.drawSoftware());
    onTheme(() => {
      this.pal.reset();
      this.redraw();
    });
    this.drawSoftware();
    void this.gpu.start().then(() => {
      this.api.refresh?.();
      this.showBackend();
    });
  }

  private showBackend(): void {
    this.backend.replaceChildren(this.api, h('span', {}, h('span', { class: 'll-muted' }, 'GPU side: '), ...backendLine(this.gpu)));
    const k = this.gpu.ctx?.kind;
    this.gpuHead.textContent = k ? `${k === 'webgpu' ? 'WebGPU' : 'WebGL2'}, ${this.s.res === 'low' ? `${PIPE_W} × ${PIPE_H}` : 'canvas resolution'}` : 'GPU';
    this.timing.textContent = this.renderer ? (this.renderer.timer.available ? '' : `GPU timings unavailable: ${this.renderer.timer.why}.`) : '';
  }

  private redraw(): void {
    this.diff = null;
    this.drawSoftware();
    this.drawGpu();
    this.showBackend();
  }

  private drawSoftware(): void {
    const { target, stats } = softwareFrame(this.s);
    const ctx = ctx2d(this.sw);
    const k = size(this.sw).w / PIPE_W;
    paintTarget(ctx, target, pipelineScene(), this.pal, 'color', k);
    if (this.diff && this.compare && this.s.res === 'low') {
      ctx.strokeStyle = this.pal.css('--alert');
      ctx.lineWidth = Math.max(1.5, k / 6);
      for (const p of this.diff) ctx.strokeRect((p % PIPE_W) * k + 1, Math.floor(p / PIPE_W) * k + 1, k - 2, k - 2);
    }
    this.swStats.replaceChildren(stat(stats.draws, 'draw calls'), stat(stats.triangles, 'triangles in'), stat(stats.rasterised, 'rasterised'), stat(stats.fragments, 'fragments'));
  }

  private drawGpu(): void {
    const r = this.renderer;
    if (!r) return;
    const read = this.compare && this.s.res === 'low';
    this.plan = r.frame(this.s, colours(this.pal), read);
    this.gpuStats.replaceChildren(...planReadout(this.plan));
    if (!read) {
      this.diffLine.textContent = this.s.res === 'low' ? 'Tick "Mark pixels that differ" to read the GPU\'s frame back and compare it with the software one, pixel by pixel.' : 'At full resolution the GPU draws every pixel of the canvas; switch back to 64 × 40 to compare.';
      return;
    }
    const s = { ...this.s };
    void r.pixels().then((px) => {
      if (!px || s.near !== this.s.near || s.cull !== this.s.cull) return;
      const c = colours(this.pal);
      this.diff = differingPixels(softwareFrame(s).target, px, c.bg, c.draws);
      const n = this.diff.length;
      this.diffLine.textContent =
        n === 0
          ? `All ${(PIPE_W * PIPE_H).toLocaleString('en-US')} pixels match the software frame (to within 3/255 per channel).`
          : `${plural(n, 'pixel')} of ${(PIPE_W * PIPE_H).toLocaleString('en-US')} differ from the software frame by more than 3/255 in a channel; they're outlined on the left. This count depends on your GPU and driver.`;
      this.drawSoftware();
    });
  }

  private async time(): Promise<void> {
    const r = this.renderer;
    if (!r) return;
    if (!r.timer.available) {
      this.timing.textContent = `GPU timings unavailable: ${r.timer.why}.`;
      return;
    }
    this.timing.textContent = 'Timing…';
    const m = await timeFrames(r.timer, 60, () => this.drawGpu(), 2);
    if (!m) return;
    this.timing.textContent = `Median GPU time per pass: scene ${msText(m[0])}, present ${msText(m[1])} (${r.timer.why}).`;
  }
}

// ---------------------------------------------------------------------------------------------
// The inspector

/** The same WebGPU call in D3D12, Vulkan and Metal. Approximate by nature: the APIs don't map one to one. */
export const EQUIVALENTS: Record<string, [string, string, string]> = {
  requestAdapter: ['IDXGIFactory6::EnumAdapterByGpuPreference', 'vkEnumeratePhysicalDevices', 'MTLCreateSystemDefaultDevice (Metal has no separate adapter)'],
  requestDevice: ['D3D12CreateDevice', 'vkCreateDevice', 'the MTLDevice itself'],
  configure: ['IDXGIFactory2::CreateSwapChainForHwnd', 'vkCreateSwapchainKHR', 'a CAMetalLayer with its device and pixelFormat'],
  createBuffer: ['ID3D12Device::CreateCommittedResource', 'vkCreateBuffer, vkAllocateMemory, vkBindBufferMemory', 'newBufferWithLength:options:'],
  writeBuffer: ['memcpy into an upload heap, then CopyBufferRegion', 'a staging buffer and vkCmdCopyBuffer (or memcpy into host-visible memory)', 'memcpy into MTLBuffer.contents, or a blit'],
  createTexture: ['ID3D12Device::CreateCommittedResource', 'vkCreateImage, vkAllocateMemory, vkBindImageMemory', 'newTextureWithDescriptor:'],
  createShaderModule: ['no object: DXIL bytecode (from DXC) goes into the pipeline description', 'vkCreateShaderModule (SPIR-V)', 'newLibraryWithSource:options:error:, then newFunctionWithName:'],
  createBindGroupLayout: ['a descriptor table in the root signature', 'vkCreateDescriptorSetLayout', 'no object (an argument buffer layout, or implied by the shader)'],
  createPipelineLayout: ['ID3D12Device::CreateRootSignature', 'vkCreatePipelineLayout', 'no object'],
  createRenderPipeline: ['ID3D12Device::CreateGraphicsPipelineState', 'vkCreateGraphicsPipelines', 'newRenderPipelineStateWithDescriptor:error: (depth-stencil state and cull mode are set separately)'],
  createRenderPipelineAsync: ['ID3D12Device::CreateGraphicsPipelineState, on a worker thread', 'vkCreateGraphicsPipelines, on a worker thread', 'newRenderPipelineStateWithDescriptor:completionHandler:'],
  createSampler: ['CreateSampler into a sampler heap, or a static sampler', 'vkCreateSampler', 'newSamplerStateWithDescriptor:'],
  createBindGroup: ['descriptors copied into a shader-visible descriptor heap', 'vkAllocateDescriptorSets, vkUpdateDescriptorSets', 'an argument buffer, or one set…Buffer: call per binding'],
  createQuerySet: ['CreateQueryHeap (TIMESTAMP)', 'vkCreateQueryPool (VK_QUERY_TYPE_TIMESTAMP)', 'newCounterSampleBufferWithDescriptor:error:'],
  createCommandEncoder: ['a command allocator and ID3D12GraphicsCommandList::Reset', 'vkAllocateCommandBuffers, vkBeginCommandBuffer', '[queue commandBuffer]'],
  beginRenderPass: ['OMSetRenderTargets and Clear…View (or BeginRenderPass)', 'vkCmdBeginRendering (or vkCmdBeginRenderPass)', 'renderCommandEncoderWithDescriptor:'],
  setPipeline: ['SetPipelineState (and SetGraphicsRootSignature)', 'vkCmdBindPipeline', 'setRenderPipelineState:'],
  setBindGroup: ['SetGraphicsRootDescriptorTable', 'vkCmdBindDescriptorSets', 'setVertexBuffer: / setFragmentBuffer: (or an argument buffer)'],
  setVertexBuffer: ['IASetVertexBuffers', 'vkCmdBindVertexBuffers', 'setVertexBuffer:offset:atIndex:'],
  setIndexBuffer: ['IASetIndexBuffer', 'vkCmdBindIndexBuffer', 'nothing: the index buffer is an argument of the draw'],
  drawIndexed: ['DrawIndexedInstanced', 'vkCmdDrawIndexed', 'drawIndexedPrimitives:indexCount:indexType:indexBuffer:indexBufferOffset:instanceCount:baseVertex:baseInstance:'],
  draw: ['DrawInstanced', 'vkCmdDraw', 'drawPrimitives:vertexStart:vertexCount:instanceCount:baseInstance:'],
  end: ['EndRenderPass (or nothing)', 'vkCmdEndRendering (or vkCmdEndRenderPass)', 'endEncoding'],
  copyTextureToBuffer: ['CopyTextureRegion', 'vkCmdCopyImageToBuffer', 'a blit encoder\'s copyFromTexture:…toBuffer:…'],
  copyBufferToBuffer: ['CopyBufferRegion', 'vkCmdCopyBuffer', 'a blit encoder\'s copyFromBuffer:…toBuffer:…'],
  resolveQuerySet: ['ResolveQueryData', 'vkCmdCopyQueryPoolResults', 'resolveCounters:inRange:destinationBuffer:destinationOffset:'],
  finish: ['ID3D12GraphicsCommandList::Close', 'vkEndCommandBuffer', 'nothing (commit ends the command buffer)'],
  submit: ['ID3D12CommandQueue::ExecuteCommandLists', 'vkQueueSubmit', '[commandBuffer commit]'],
  // The view WebGPU then makes with createView isn't recorded (it's a call on the texture).
  getCurrentTexture: ['IDXGISwapChain3::GetCurrentBackBufferIndex and GetBuffer (plus a render target view of each back buffer, usually made once)', 'vkAcquireNextImageKHR (plus a VkImageView of each swapchain image, usually made once)', '[layer nextDrawable], then its texture'],
  mapAsync: ['Map on a readback heap once a fence has passed', 'vkMapMemory once a fence has passed', 'contents, in the command buffer\'s completion handler'],
};

const PHASE_LABEL: Record<Phase, string> = { init: 'at load', rebuild: 'when the size or colours change', frame: 'each frame' };

export class GpuInspectorViz {
  private log = new CallLog();
  private s: SameFrameSettings = { ...SAME_FRAME_DEFAULTS };
  private gpu: GpuCanvas;
  private renderer: SameFrameRenderer | null = null;
  private pal: Palette;
  private view: 'load' | 'frame' = 'frame';
  private extras = false;
  private list = h('ol', { class: 'rd-calls' });
  private summary = h('div', { class: 'll-stats' });
  private backend = h('div', { class: 'll-row' });
  private status = h('p', { class: 'rd-gpu-status' });
  private tabs: { el: HTMLElement; set: (v: 'load' | 'frame') => void };
  private api: HTMLElement & { refresh?: () => void };
  private plan: FramePlan | null = null;

  constructor(host: HTMLElement) {
    const root = frame(host, 'rd-gpu rd-insp');
    this.pal = new Palette(root);
    this.gpu = new GpuCanvas({
      w: 640,
      h: 400,
      label: 'The frame whose calls are listed',
      size: { maxWidth: 360 },
      log: this.log,
      // Record everything from the context's creation to the end of the first frame.
      beforeInit: () => {
        this.log.clear();
        this.log.start('init');
      },
      build: async (ctx) => {
        this.renderer = await createSameFrame(ctx, this.log);
      },
      teardown: () => {
        this.renderer?.dispose();
        this.renderer = null;
      },
      draw: () => this.draw(),
      onStatus: (s) => {
        this.status.textContent = s;
        this.showBackend();
      },
    });
    this.api = apiSwitch(this.gpu, () => this.show());
    this.tabs = seg<'load' | 'frame'>(
      'Calls',
      [
        ['frame', 'One frame'],
        ['load', 'Creating things'],
      ],
      this.view,
      (v) => {
        this.view = v;
        this.show();
      },
    );
    root.append(
      this.backend,
      h(
        'div',
        { class: 'll-row' },
        this.tabs.el,
        chk('Show timing and readback calls', false, (on) => ((this.extras = on), this.show())),
        chk('Cull back faces', true, (on) => {
          this.s.cull = on;
          this.draw();
        }),
      ),
      stage(this.gpuFig(), [this.list, this.summary]),
      this.status,
    );
    onTheme(() => {
      this.pal.reset();
      this.draw();
    });
    void this.gpu.start().then(() => {
      this.api.refresh?.();
      this.show();
    });
  }

  /** The GPU canvas's holder as a figure, so stage() sizes it like a canvas. */
  private gpuFig(): HTMLElement {
    const c = this.gpu.canvas;
    this.gpu.el.style.setProperty('--rd-ar', String(640 / 400));
    for (const p of ['--rd-max-w', '--rd-max-h']) {
      const v = c.style.getPropertyValue(p);
      if (v) this.gpu.el.style.setProperty(p, v);
    }
    this.gpu.el.classList.add('rd-fig');
    return this.gpu.el;
  }

  private draw(): void {
    const r = this.renderer;
    if (!r) return;
    // Record this frame only: drop the previous frame's calls.
    this.log.calls = this.log.calls.filter((c) => c.phase !== 'frame');
    if (!this.log.on) this.log.start('frame');
    this.plan = r.frame(this.s, colours(this.pal), false);
    this.log.stop();
    this.show();
  }

  private showBackend(): void {
    this.backend.replaceChildren(this.api, h('span', {}, ...backendLine(this.gpu)));
  }

  private show(): void {
    this.showBackend();
    const calls = this.log.calls.filter((c) => (this.view === 'frame' ? c.phase === 'frame' : c.phase !== 'frame') && (this.extras || !c.tag));
    const webgpu = this.gpu.ctx?.kind === 'webgpu';
    this.list.replaceChildren(...calls.map((c) => this.item(c, webgpu)));
    const frameCalls = this.log.of('frame', true);
    const hidden = this.log.calls.filter((c) => c.tag && (this.view === 'frame' ? c.phase === 'frame' : c.phase !== 'frame')).length;
    const draws = frameCalls.filter((c) => DRAW_METHODS.has(c.method)).length;
    const st = this.plan ? planStats(this.plan) : null;
    if (st && draws !== st.draws) console.warn(`inspector: ${draws} draw calls recorded, the plan has ${st.draws}`);
    this.summary.replaceChildren(
      stat(frameCalls.length, 'calls per frame'),
      ...(this.plan ? planReadout(this.plan) : []),
      stat(this.log.calls.filter((c) => c.phase !== 'frame' && !c.tag).length, 'calls creating things'),
    );
    if (hidden && !this.extras) this.summary.append(h('span', { class: 'll-muted' }, `${plural(hidden, 'timing or readback call')} hidden`));
  }

  private item(c: Call, webgpu: boolean): HTMLElement {
    const eq = webgpu ? EQUIVALENTS[c.method] : undefined;
    const body: HTMLElement[] = [];
    if (c.full) body.push(h('pre', {}, c.full));
    if (eq) body.push(h('dl', { class: 'rd-eq' }, h('dt', {}, 'D3D12'), h('dd', {}, eq[0]), h('dt', {}, 'Vulkan'), h('dd', {}, eq[1]), h('dt', {}, 'Metal'), h('dd', {}, eq[2])));
    if (this.view === 'load') body.push(h('p', { class: 'll-muted', style: 'margin: 0 8px 6px 2.6em' }, `Made ${PHASE_LABEL[c.phase]}.`));
    return h(
      'li',
      { class: DRAW_METHODS.has(c.method) ? 'draw' : '' },
      h('details', {}, h('summary', {}, c.short, c.tag ? h('span', { class: 'tag' }, c.tag) : false), ...body),
    );
  }
}
