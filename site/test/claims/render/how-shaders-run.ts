// Claims for rendering/how-shaders-run.mdx: instructions issued per branch outcome, divergent
// waves and lane use over the frame for 32 and 64 lanes, the tiny-triangle quad table, and the
// occupancy table and toy latency model.
import { claim, fact, int, pct } from '../core';
import { ALU_RUN, CUTS, ISSUED_BOTH, ISSUED_LIT, ISSUED_UNLIT, MEM_LATENCY, VGPR_GRANULE, VGPRS_PER_SIMD, WAVE_SLOTS, buildWaves, frameWaves, latencyModel, quadCount, runWave, waveCost, wavesPerSimd } from '../../../src/render/scenes/how-shaders-run';

export default function shaders(): void {
  const S = 'rendering/how-shaders-run.mdx';
  claim(S, `a wave whose lanes are all lit issues ${ISSUED_LIT} instructions, and one with no lit lane issues ${ISSUED_UNLIT}`);
  claim(S, `A wave on the edge of the light issues ${ISSUED_BOTH}, both sides`);
  // The program's counts match what runWave issues for real waves of each kind.
  const { waves } = buildWaves(32);
  const kinds = new Set(waves.map((w) => {
    const live = w.lanes.filter((l) => l.kind !== 'empty');
    return `${live.every((l) => l.lit) ? 'lit' : live.every((l) => !l.lit) ? 'unlit' : 'both'}:${runWave(w).length}`;
  }));
  fact(S, [...kinds].every((k) => k === `lit:${ISSUED_LIT}` || k === `unlit:${ISSUED_UNLIT}` || k === `both:${ISSUED_BOTH}`) && kinds.size === 3, 'the frame has all-lit, unlit and divergent waves issuing 7, 4 and 8');
  const f32 = frameWaves(32);
  const f64 = frameWaves(64);
  claim(S, `with 32 lanes ${f32.divergent} of the ${f32.waves} waves are divergent; with 64 lanes, ${f64.divergent} of ${f64.waves}`);
  claim(S, `${pct((f32.useful / f32.slots) * 100)} do a real pixel's work with 32 lanes and ${pct((f64.useful / f64.slots) * 100)} with 64`);
  fact(S, f64.divergent / f64.waves > f32.divergent / f32.waves, 'a larger share of 64-lane waves diverge');
  fact(S, waves.every((w) => waveCost(w).useful <= waveCost(w).slots), 'useful lane slots never exceed issued');
  // Occupancy.
  claim(S, `a SIMD has ${int(VGPRS_PER_SIMD)} vector registers per lane for wave32 and ${WAVE_SLOTS} wave slots. Registers are handed out in blocks of ${VGPR_GRANULE}`);
  claim(S, `| up to 96 | ${wavesPerSimd(96)} |`);
  fact(S, wavesPerSimd(97) < WAVE_SLOTS && wavesPerSimd(1) === WAVE_SLOTS, '96 is the most registers that still gives 16 waves');
  for (const v of [120, 128, 168, 256]) claim(S, `| ${v} | ${wavesPerSimd(v)} |`);
  claim(S, `each wave runs ${ALU_RUN} instructions, then waits ${MEM_LATENCY} cycles for memory`);
  fact(S, latencyModel(16).busy === 1, 'with 16 waves the toy SIMD is always busy');
  claim(S, `At 128 registers, ${wavesPerSimd(128)} waves keep it busy ${pct(latencyModel(wavesPerSimd(128)).busy * 100)} of the time; at 256 registers, ${wavesPerSimd(256)} waves only ${pct(latencyModel(wavesPerSimd(256)).busy * 100)}`);
  // Tiny triangles.
  const q = CUTS.map((n) => quadCount(n));
  fact(S, q.every((c) => c.pixels === 1024), 'every cut shades the same 1,024 pixels');
  claim(S, `The pixels shaded stay the same, ${int(q[0].pixels)}`);
  for (const c of q) claim(S, `| ${int(c.triangles)} | ${int(c.quads)} | ${int(c.lanes)} | ${int(c.helpers)} | ${pct((c.pixels / c.lanes) * 100)} |`);
  const last = q[q.length - 1];
  claim(S, `At ${int(last.triangles)} triangles each covers half a pixel on average, and ${int(last.empty)} of them cover no pixel centre at all`);
  fact(S, last.pixels / last.triangles === 0.5, 'at the finest cut, half a pixel per triangle');
  fact(S, last.quads === last.triangles - last.empty, 'at the finest cut, each triangle that covers a pixel launches one quad');
}
