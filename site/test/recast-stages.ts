import { runStages, DEFAULT_OPTIONS } from '../src/recast/stages';
for (const regions of ['watershed', 'monotone', 'layers'] as const) {
  const s = await runStages({ ...DEFAULT_OPTIONS, regions });
  console.log(regions, s.w, s.h, JSON.stringify(s.counts), Object.entries(s.ms).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' '));
}
const s = await runStages(DEFAULT_OPTIONS);
const colStr = (l: number[][]) => l.map((x) => x.join('/')).join(' ');
// A column under the table, one on the platform, one on the kerb.
const at = (x: number, z: number) => Math.floor((z - s.bmin[2]) / 0.25) * s.w + Math.floor((x - s.bmin[0]) / 0.25);
for (const [name, x, z] of [['under table', 17, 11], ['platform', 13, 4], ['kerb', 10, 12.7], ['floor', 22, 2], ['ramp', 21.5, 11]] as const) {
  const i = at(x, z);
  console.log(name, 'spans', colStr(s.spans[i]), '| after filters', colStr(s.afterLowHeight[i]), '| compact', colStr(s.cells[i]), 'areas', s.cells[i].map((c) => s.areas[c[2]]).join(','));
}
