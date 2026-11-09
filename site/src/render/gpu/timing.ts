/**
 * GPU timings per pass, from timestamp queries.
 *
 * CPU timers can't see GPU work: a draw call returns long before the GPU runs it. The GPU has to
 * write the time itself, into a query, and we read the result back a frame or more later.
 *
 *   WebGPU: the optional 'timestamp-query' feature. A render pass descriptor's `timestampWrites`
 *   writes a timestamp at the start and end of the pass into a GPUQuerySet; resolveQuerySet copies
 *   them into a buffer, which we copy into a mappable buffer and read with mapAsync. Values are
 *   nanoseconds. Chrome quantises them to 100 µs unless the "WebGPU Developer Features" flag is on,
 *   so passes as small as the lessons' often read 0.
 *
 *   WebGL2: EXT_disjoint_timer_query_webgl2. beginQuery/endQuery(TIME_ELAPSED_EXT) around each
 *   pass; poll QUERY_RESULT_AVAILABLE on later frames; throw the frame away if GPU_DISJOINT_EXT
 *   says something (a power-state change, say) made the timer unreliable. Firefox and Safari
 *   don't expose it, and Chrome only on some systems.
 *
 * Both report through `onTimes(ms per pass)`. When neither is available, `why` says so and the
 * renderer skips timing entirely. Timings vary by machine and by run: show them live, never quote
 * them as fixed numbers in a lesson.
 */
import { type Gl2Context, type WebGpuContext } from './context';
import { type CallLog, record } from './record';
import { BufferUsage, type GPUBuffer, type GPUCommandEncoder, type GPUDevice, type GPUObject, type GPUTimestampWrites, MapMode } from './webgpu';

export interface GpuTimer {
  readonly available: boolean;
  /** Why timings are unavailable, or a caveat about them when they are. */
  readonly why: string;
  onTimes: ((ms: Array<number | null>) => void) | null;
}

export class WebGpuTimer implements GpuTimer {
  readonly available: boolean;
  readonly why: string;
  onTimes: ((ms: Array<number | null>) => void) | null = null;
  private querySet: GPUObject | null = null;
  private resolveBuf: GPUBuffer | null = null;
  /** A few mappable buffers, so a frame can be timed while an earlier one is still being read. */
  private readBufs: GPUBuffer[] = [];
  private used: GPUBuffer | null = null;

  constructor(
    gc: WebGpuContext,
    private log: CallLog,
    private passes: number,
  ) {
    this.available = gc.timestamps;
    this.why = gc.timestamps
      ? 'from timestamp queries; Chrome rounds them to 100 µs, so very short passes can read 0'
      : "this adapter doesn't offer the 'timestamp-query' feature";
    if (!this.available) return;
    const dev = record(gc.device, log, 'device') as GPUDevice;
    log.tagged('timing', () => {
      this.querySet = dev.createQuerySet({ label: 'pass timestamps', type: 'timestamp', count: passes * 2 });
      this.resolveBuf = dev.createBuffer({ label: 'timestamps (resolved)', size: passes * 16, usage: BufferUsage.QUERY_RESOLVE | BufferUsage.COPY_SRC });
      for (let i = 0; i < 3; i++) this.readBufs.push(dev.createBuffer({ label: `timestamps (read ${i})`, size: passes * 16, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST }));
    });
  }
  /** The timestampWrites for pass i's descriptor. */
  writes(i: number): GPUTimestampWrites | undefined {
    if (!this.querySet) return undefined;
    return { querySet: this.querySet, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
  }
  /** Before finish(): resolve this frame's queries and copy them into a free mappable buffer. Returns whether this frame will report times. */
  resolve(enc: GPUCommandEncoder): boolean {
    this.used = null;
    if (!this.querySet || !this.resolveBuf || !this.onTimes) return false;
    const free = this.readBufs.find((b) => b.mapState === 'unmapped');
    if (!free) return false;
    this.log.tagged('timing', () => {
      enc.resolveQuerySet(this.querySet!, 0, this.passes * 2, this.resolveBuf!, 0);
      enc.copyBufferToBuffer(this.resolveBuf!, 0, free, 0, this.passes * 16);
    });
    this.used = free;
    return true;
  }
  /** After submit(): read the times back when the GPU is done. */
  submitted(): void {
    const b = this.used;
    if (!b) return;
    this.used = null;
    b.mapAsync(MapMode.READ).then(
      () => {
        const t = new BigInt64Array(b.getMappedRange().slice(0));
        b.unmap();
        const ms: Array<number | null> = [];
        for (let i = 0; i < this.passes; i++) {
          const d = Number(t[i * 2 + 1] - t[i * 2]);
          ms.push(d >= 0 ? d / 1e6 : null);
        }
        this.onTimes?.(ms);
      },
      () => {
        // The device was lost or destroyed mid-read: nothing to report.
      },
    );
  }
}

export class Gl2Timer implements GpuTimer {
  readonly available: boolean;
  readonly why: string;
  onTimes: ((ms: Array<number | null>) => void) | null = null;
  /** Queries in flight, one array per frame, oldest first. */
  private frames: WebGLQuery[][] = [];
  private current: WebGLQuery[] = [];

  constructor(
    private gc: Gl2Context,
    private log: CallLog,
  ) {
    this.available = !!gc.timerExt;
    this.why = gc.timerExt ? 'from EXT_disjoint_timer_query_webgl2' : "this browser doesn't expose EXT_disjoint_timer_query_webgl2 (Firefox and Safari don't, and Chrome only on some systems)";
  }
  /** Around each pass. Only one TIME_ELAPSED query can be active at a time, so passes can't nest. */
  begin(gl: WebGL2RenderingContext): void {
    const ext = this.gc.timerExt;
    if (!ext || !this.onTimes) return;
    this.log.tagged('timing', () => {
      const q = gl.createQuery();
      if (!q) return;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      this.current.push(q);
    });
  }
  end(gl: WebGL2RenderingContext): void {
    const ext = this.gc.timerExt;
    if (!ext || !this.onTimes || !this.current.length) return;
    this.log.tagged('timing', () => gl.endQuery(ext.TIME_ELAPSED_EXT));
  }
  /** At the end of a frame: queue its queries and report any earlier frame whose results are in. */
  submitted(gl: WebGL2RenderingContext): void {
    const ext = this.gc.timerExt;
    if (!ext) return;
    if (this.current.length) this.frames.push(this.current);
    this.current = [];
    this.log.tagged('timing', () => {
      while (this.frames.length) {
        const qs = this.frames[0];
        if (!gl.getQueryParameter(qs[qs.length - 1], gl.QUERY_RESULT_AVAILABLE)) break;
        this.frames.shift();
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        const ms = qs.map((q) => (disjoint ? null : Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6));
        for (const q of qs) gl.deleteQuery(q);
        this.onTimes?.(ms);
      }
    });
  }
}
