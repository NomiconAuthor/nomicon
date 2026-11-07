// Claims for rendering/cpu-gpu-frame-pipeline.mdx: every latency and frame rate the lesson quotes,
// from the same deterministic model the widget draws.
import { claim, fact, pct } from '../core';
import { LATE_MARGIN, PIPE_DEFAULTS as D, type PipeSettings, simulate } from '../../../src/render/scenes/cpu-gpu-frame-pipeline';

const ms = (x: number) => `${x.toFixed(1)} ms`;

export default function framePipeline(): void {
  const P = 'rendering/cpu-gpu-frame-pipeline.mdx';
  const at = (o: Partial<PipeSettings>) => simulate({ ...D, ...o });
  const steady = (r: ReturnType<typeof simulate>) => r.latency.max - r.latency.min < 0.05;

  claim(P, `It starts at ${D.hz} Hz with FIFO, ${D.inFlight} frames in flight, ${D.sim} ms of simulation, ${D.render} ms of rendering on the CPU and ${D.gpu} ms on the GPU`);
  fact(P, D.present === 'fifo' && !D.late, 'the widget starts on FIFO without the just-in-time start');
  const d = at({});
  fact(P, steady(d) && d.latency.mean / d.T > 2.5 && d.latency.mean / d.T < 3, 'the starting latency is steady and nearly three refreshes');
  fact(P, D.sim + D.render + D.gpu < d.T, 'the work fits in a refresh');
  claim(P, `input to photon is ${ms(d.latency.mean)}, nearly three refreshes`);
  fact(P, d.images === D.inFlight + 1, 'one swapchain image per frame in flight plus the one on screen');
  const f1 = at({ inFlight: 1 });
  const f3 = at({ inFlight: 3 });
  fact(P, steady(f1) && steady(f3), 'steady with 1 and 3 frames in flight');
  claim(P, `With 1 the same work shows in ${ms(f1.latency.mean)}; with 3, ${ms(f3.latency.mean)}`);
  const mb = at({ present: 'mailbox' });
  claim(P, `${ms(mb.latency.mean)} on average (${ms(mb.latency.min)} to ${ms(mb.latency.max)}, depending on where a frame finishes relative to the refresh). The cost is work: ${pct(100 * mb.dropped)} of the frames are drawn and never shown`);
  fact(P, mb.images === D.inFlight + 2, 'mailbox gets one more image');
  const im = at({ present: 'immediate' });
  fact(P, steady(im) && Math.abs(im.latency.mean - (D.sim + D.render + D.gpu)) < 0.5, 'immediate latency is the work alone (the CPU being slower than the GPU here, one frame overlaps)');
  claim(P, `**Immediate** shows each frame as soon as the GPU finishes it: ${ms(im.latency.mean)}, just the work itself, with the CPU and GPU running at ${Math.round(im.fps)} frames a second`);

  const g = at({ gpu: 20 });
  claim(P, `Now make the GPU the bottleneck: ${20} ms of GPU work`);
  claim(P, `it shows ${Math.round(g.fps)} frames a second, unevenly (some frames for one refresh, some for two), and latency averages ${ms(g.latency.mean)} (${ms(g.latency.min)} to ${ms(g.latency.max)})`);
  const g1 = at({ gpu: 20, inFlight: 1 });
  claim(P, `One frame in flight cuts latency to ${ms(g1.latency.mean)} but halves the frame rate to ${Math.round(g1.fps)}`);
  fact(P, Math.round(g1.fps) * 2 === Math.round(D.hz), 'halves 60 to 30');
  // How long each shown frame stays on screen with the 20 ms GPU: four for one refresh, then one for two.
  const shown = g.frames.slice(60, 120).filter((f) => f.shown !== null && f.replaced !== null);
  const holds = shown.map((f) => Math.round(((f.replaced as number) - (f.shown as number)) / g.T));
  const ones = holds.filter((x) => x === 1).length;
  const twos = holds.filter((x) => x === 2).length;
  fact(P, ones + twos === holds.length && Math.abs(ones / twos - 4) < 0.3 && !holds.join('').includes('22'), `with a 20 ms GPU, four frames shown for one refresh, then one for two (${holds.join('')})`);

  const late = at({ late: true });
  claim(P, `keeping a ${LATE_MARGIN} ms margin`);
  fact(P, steady(late) && Math.abs(late.latency.mean - (D.sim + D.render + D.gpu + LATE_MARGIN)) < 1e-6, 'just in time, latency is the work plus the margin');
  claim(P, `With the starting settings latency drops from ${ms(d.latency.mean)} to ${ms(late.latency.mean)}, the work plus the margin, at the same ${Math.round(late.fps)} frames a second`);
  const gl = at({ gpu: 20, late: true });
  claim(P, `With the 20 ms GPU it drops from ${ms(g.latency.mean)} to ${ms(gl.latency.mean)} on average, still at ${Math.round(gl.fps)} frames a second`);
  fact(P, gl.gpuBusy > 0.99, 'just in time, the GPU stays busy');
  const cpu = { sim: 14, render: 8 };
  fact(P, JSON.stringify(at({ ...cpu, late: true }).latency) === JSON.stringify(at(cpu).latency), 'when the CPU is the bottleneck, just in time changes nothing');
  fact(P, at({ present: 'mailbox', late: true }).dropped === 0, 'just in time with mailbox, no frame is wasted');
}
